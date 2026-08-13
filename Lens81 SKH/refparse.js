// refparse.js
// Parses manually-provided reference sources — a pasted DOI, a pasted
// BibTeX entry, or an uploaded .bib/.ris file — into the same paper-record
// shape used everywhere else in this extension (title, authors: [names],
// year, venue, doi, url), so they can flow through the exact same
// citation pipeline as a search result: same numbering, same
// disambiguation, same running bibliography (see csl.js's
// lens81CiteInText). This is what makes "paste a DOI" or "upload my
// BibTeX library" behave like EndNote/Mendeley's manual reference entry
// rather than a separate, disconnected feature — a paper cited once via
// search and again via a pasted DOI for the *same* source gets the *same*
// citation number, because both end up as the same stable id (DOI, when
// available) in the same registry.
//
// Pure parsing only — no network calls here. DOI *resolution* (turning a
// bare DOI into full metadata) goes through background.js's RESOLVE_DOI
// message type, since that needs a network request; this file only
// recognizes that something looks like a DOI and extracts it.

// Accepts a bare DOI ("10.1038/nature12373") or a doi.org URL
// ("https://doi.org/10.1038/nature12373", with or without "dx."). Returns
// the bare DOI, or null if the text isn't a DOI at all.
function extractDoi(text) {
  const trimmed = (text || '').trim();
  const urlMatch = trimmed.match(/^https?:\/\/(dx\.)?doi\.org\/(10\.\d{4,9}\/\S+)$/i);
  if (urlMatch) return urlMatch[2];
  if (/^10\.\d{4,9}\/\S+$/.test(trimmed)) return trimmed;
  return null;
}

function looksLikeBibtex(text) {
  return /^\s*@\w+\s*\{/.test(text || '');
}

function looksLikeRis(text) {
  return /^\s*TY\s{0,2}-\s*\S/m.test(text || '');
}

// --- BibTeX ------------------------------------------------------------

// Splits a block of BibTeX source into individual @type{...} entries,
// tracking brace depth so a field value containing "}" (e.g. a title with
// a nested {Capitalized} group, common in real .bib files to protect
// acronyms from case-changing) doesn't prematurely end the entry.
function splitBibtexEntries(text) {
  const entries = [];
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('@', i);
    if (at === -1) break;
    const braceStart = text.indexOf('{', at);
    if (braceStart === -1) break;
    let depth = 1;
    let j = braceStart + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    entries.push(text.slice(at, j));
    i = j;
  }
  return entries;
}

// Parses the "key = {value}," / "key = "value"," / "key = 123," field
// lines inside one @type{...} entry body into a plain object. Deliberately
// simple (no full BibTeX-grammar parser, no @string/@preamble/cross-ref
// support) — good enough for the overwhelming majority of real-world .bib
// files, which are exports from other reference managers using exactly
// this flat field shape.
// BibTeX authors often wrap acronyms/proper nouns in braces to protect
// their capitalization from style-driven case-changing (e.g. "a
// dual-{RNA}-guided {DNA} endonuclease") — those braces are a formatting
// instruction, not literal text, so they're stripped here rather than
// left to show up inside a citation. Runs repeatedly since a value can
// have more than one such group, and rarely a nested one.
function stripBibtexProtectiveBraces(value) {
  let prev;
  let result = value;
  do {
    prev = result;
    result = result.replace(/\{([^{}]*)\}/g, '$1');
  } while (result !== prev);
  return result;
}

function parseBibtexFields(entryBody) {
  const fields = {};
  const fieldRe = /([a-zA-Z][\w-]*)\s*=\s*(\{((?:[^{}]|\{[^{}]*\})*)\}|"([^"]*)"|(\d+))\s*,?/g;
  let m;
  while ((m = fieldRe.exec(entryBody))) {
    const key = m[1].toLowerCase();
    const raw = (m[3] ?? m[4] ?? m[5] ?? '').replace(/\s+/g, ' ').trim();
    fields[key] = stripBibtexProtectiveBraces(raw);
  }
  return fields;
}

// BibTeX allows "Given Family" or "Family, Given" per author; normalize
// both to "Given Family" — the shape csl.js's lens81NameToCslPerson (and
// everything else in this extension) already expects.
function splitBibtexAuthors(authorField) {
  if (!authorField) return [];
  return authorField
    .split(/\s+and\s+/i)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      if (name.includes(',')) {
        const [family, given] = name.split(',').map((s) => s.trim());
        return given ? `${given} ${family}` : family;
      }
      return name;
    });
}

// Parses one @type{...} entry into a paper record. Returns null if the
// entry has no usable title — nothing worth citing.
function parseBibtexEntry(entryText) {
  const firstBrace = entryText.indexOf('{');
  if (firstBrace === -1) return null;
  const body = entryText.slice(firstBrace + 1, entryText.lastIndexOf('}'));
  const fields = parseBibtexFields(body);
  if (!fields.title) return null;

  const doi = (fields.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  return {
    title: fields.title,
    authors: splitBibtexAuthors(fields.author),
    year: fields.year ? Number((String(fields.year).match(/\d{4}/) || [])[0]) || null : null,
    venue: fields.journal || fields.booktitle || fields.journaltitle || '',
    doi,
    url: fields.url || (doi ? `https://doi.org/${doi}` : ''),
  };
}

// Parses every entry in a block of BibTeX text (e.g. a whole uploaded .bib
// file) into paper records, silently skipping any entry with no title.
function parseBibtexEntries(text) {
  return splitBibtexEntries(text).map(parseBibtexEntry).filter(Boolean);
}

// --- RIS -----------------------------------------------------------------
// RIS is a flat, line-based "TAG  - value" format, with each record ended
// by "ER  -". Every major reference manager (EndNote, Mendeley, Zotero)
// can both import and export it, which is why it's supported here
// alongside BibTeX.

const RIS_AUTHOR_TAGS = new Set(['AU', 'A1', 'A2', 'A3', 'A4']);
const RIS_TITLE_TAGS = ['TI', 'T1', 'BT'];
const RIS_VENUE_TAGS = ['JO', 'JF', 'T2', 'JA'];

function parseRisEntries(text) {
  const lines = (text || '').split(/\r\n|\r|\n/);
  const entries = [];
  let current = null;

  for (const rawLine of lines) {
    const m = rawLine.match(/^([A-Z][A-Z0-9])\s{0,2}-\s?(.*)$/);
    if (!m) continue; // RIS continuation/blank lines aren't handled — rare in exported files
    const tag = m[1];
    const value = m[2];

    if (tag === 'TY') {
      current = { authors: [], fieldsByTag: {} };
      continue;
    }
    if (!current) continue;

    if (tag === 'ER') {
      entries.push(current);
      current = null;
      continue;
    }

    if (RIS_AUTHOR_TAGS.has(tag)) {
      const v = value.trim();
      if (v.includes(',')) {
        const [family, given] = v.split(',').map((s) => s.trim());
        current.authors.push(given ? `${given} ${family}` : family);
      } else if (v) {
        current.authors.push(v);
      }
      continue;
    }

    if (!current.fieldsByTag[tag]) current.fieldsByTag[tag] = value.trim();
  }

  return entries
    .map((entry) => {
      const f = entry.fieldsByTag;
      const title = RIS_TITLE_TAGS.map((t) => f[t]).find(Boolean);
      if (!title) return null;
      const venue = RIS_VENUE_TAGS.map((t) => f[t]).find(Boolean) || '';
      const yearMatch = (f.PY || f.Y1 || '').match(/\d{4}/);
      const doi = (f.DO || f.DOI || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
      return {
        title,
        authors: entry.authors,
        year: yearMatch ? Number(yearMatch[0]) : null,
        venue,
        doi,
        url: f.UR || (doi ? `https://doi.org/${doi}` : ''),
      };
    })
    .filter(Boolean);
}

// --- Fallback citation formatting for manually-parsed papers ----------------
// Mirrors background.js's hand-rolled formatAPA/MLA/Chicago/IEEE/BibTeX
// (condensed) — used only as the guaranteed-available fallback for a
// paper parsed straight out of pasted BibTeX/RIS text (never round-tripped
// through background.js, so it has no citations object of its own yet).
// The real CSL engine (csl.js) is still tried first for apa/mla/chicago/
// ieee wherever this paper ends up being cited — see cite.js's
// citeGetInsertableText — this only covers what happens if that fails.

function refSplitName(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { last: '', initials: '' };
  const last = parts[parts.length - 1];
  const initials = parts
    .slice(0, -1)
    .map((p) => (p[0] ? p[0].toUpperCase() + '.' : ''))
    .join(' ');
  return { last, initials };
}

function refFormatAuthorsAPA(authors) {
  if (!authors.length) return '';
  const formatted = authors.map((a) => {
    const { last, initials } = refSplitName(a);
    return initials ? `${last}, ${initials}` : last;
  });
  if (formatted.length === 1) return formatted[0];
  if (formatted.length === 2) return `${formatted[0]}, & ${formatted[1]}`;
  return `${formatted.slice(0, -1).join(', ')}, & ${formatted[formatted.length - 1]}`;
}

function refFormatApa(p) {
  const authors = refFormatAuthorsAPA(p.authors);
  const year = p.year ? `(${p.year}).` : '(n.d.).';
  const venue = p.venue ? ` ${p.venue}.` : '';
  return `${authors ? authors + ' ' : ''}${year} ${p.title}.${venue}`.replace(/\s+/g, ' ').trim();
}

function refFormatMla(p) {
  const lead = p.authors.length ? `${refSplitName(p.authors[0]).last}${p.authors.length > 1 ? ', et al.' : ''} ` : '';
  const year = p.year ? `, ${p.year}` : '';
  const venue = p.venue ? ` ${p.venue}${year}.` : `${year}.`;
  return `${lead}"${p.title}."${venue}`.replace(/\s+/g, ' ').trim();
}

function refFormatChicago(p) {
  let authorPart = '';
  if (p.authors.length) {
    const { last, initials } = refSplitName(p.authors[0]);
    const given = initials ? initials.replace(/\./g, ' ').trim() : '';
    const first = given ? `${last}, ${given}` : last;
    authorPart = p.authors.length > 1 ? `${first}, et al. ` : `${first}. `;
  }
  const year = p.year ? `${p.year}. ` : '';
  const venue = p.venue ? ` ${p.venue}.` : '';
  return `${authorPart}${year}“${p.title}.”${venue}`.replace(/\s+/g, ' ').trim();
}

function refFormatIeee(p) {
  let authorPart = '';
  if (p.authors.length) {
    const { last, initials } = refSplitName(p.authors[0]);
    authorPart = p.authors.length > 1 ? `${initials} ${last} et al., ` : `${initials} ${last}, `;
  }
  const venue = p.venue ? ` ${p.venue},` : '';
  const year = p.year ? ` ${p.year}.` : '';
  return `[1] ${authorPart}"${p.title},"${venue}${year}`.replace(/\s+/g, ' ').trim();
}

function refBibtexKey(p) {
  const last = p.authors.length ? refSplitName(p.authors[0]).last.replace(/[^a-zA-Z]/g, '') : 'Unknown';
  const year = p.year || '';
  const firstWord = (p.title || '').split(/\s+/).find((w) => w.length > 3) || '';
  return `${last}${year}${firstWord.replace(/[^a-zA-Z]/g, '')}`.slice(0, 40) || 'ref';
}

function refFormatBibtex(p) {
  const authors = p.authors.length ? p.authors.join(' and ') : 'Unknown';
  const lines = [`@article{${refBibtexKey(p)},`, `  author = {${authors}},`, `  title = {${p.title}},`];
  if (p.venue) lines.push(`  journal = {${p.venue}},`);
  if (p.year) lines.push(`  year = {${p.year}},`);
  if (p.doi) lines.push(`  doi = {${p.doi}},`);
  if (p.url) lines.push(`  url = {${p.url}},`);
  lines.push('}');
  return lines.join('\n');
}

// Shapes a manually-parsed paper (from parseBibtexEntries/parseRisEntries)
// into exactly what cite.js's result-row rendering expects — same fields
// as background.js's toResultShape(), just built locally since these
// papers never go through a message round-trip to get there. `relevance`
// is deliberately absent (null): there's no "match confidence" for a
// source the person picked out themselves.
function refToResultShape(p) {
  return {
    title: p.title,
    authors: p.authors || [],
    year: p.year || null,
    venue: p.venue || '',
    doi: p.doi || '',
    url: p.url || '',
    relevance: null,
    why: '',
    citations: {
      apa: refFormatApa(p),
      mla: refFormatMla(p),
      chicago: refFormatChicago(p),
      ieee: refFormatIeee(p),
      bibtex: refFormatBibtex(p),
    },
  };
}


// Classifies + parses whatever text a person pasted, or an uploaded file
// contained, without making any network request. Returns:
//   { kind: 'doi', doi }             — a bare DOI or doi.org URL; the
//                                       caller must resolve it (RESOLVE_DOI)
//   { kind: 'bibtex'|'ris', papers } — one or more parsed paper records
//   { kind: 'empty'|'unknown', papers: [] }
function parseReferenceInput(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return { kind: 'empty', papers: [] };

  const doi = extractDoi(trimmed);
  if (doi) return { kind: 'doi', doi, papers: [] };

  if (looksLikeBibtex(trimmed)) {
    const papers = parseBibtexEntries(trimmed).map(refToResultShape);
    return { kind: 'bibtex', papers };
  }
  if (looksLikeRis(trimmed)) {
    const papers = parseRisEntries(trimmed).map(refToResultShape);
    return { kind: 'ris', papers };
  }
  return { kind: 'unknown', papers: [] };
}
