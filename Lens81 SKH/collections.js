// collections.js
// Shared data layer for the Collections feature (playlists-for-papers).
// Loaded as a plain script (no modules, to match the rest of this MV3
// extension) by:
//   - content.js on scholar.google.com (via manifest content_scripts)
//   - popup.html (the toolbar popup)
//   - collection.html (the full collection-view page)
//
// Everything here talks directly to chrome.storage.local. Content scripts
// and extension pages both have that permission already (the manifest
// already declares "storage"), so there's no need to round-trip through
// background.js for any of this — it's a separate, self-contained feature
// that doesn't touch the existing classification pipeline at all.
//
// --- Storage shape ----------------------------------------------------
//
//   lens81_collections = {
//     "<collectionId>": { id, name, createdAt, paperIds: [paperId, ...] }
//   }
//
//   lens81_paper:<paperId> = {
//     id, title, authors, url, type, confidence, savedAt,
//     collectionIds: [collectionId, ...]
//   }
//
// Paper metadata is stored exactly once per paper (keyed by its own
// storage key), and collections only ever reference paperIds — the same
// "song can be on many playlists" shape the feature is modeled on. A
// paper is deleted outright the moment it belongs to zero collections, so
// storage never accumulates orphaned records.
//
// Each paper lives under its own `lens81_paper:<id>` key (rather than one
// big blob) so a single Scholar page only ever reads the specific keys it
// needs (chrome.storage.local.get accepts an array of keys), instead of
// loading every saved paper on every page visit.

// --- Paper identity -----------------------------------------------------

// Generates a stable id for a paper: DOI when we have one, otherwise a
// Google Scholar cluster/cites id pulled from the result URL (stable across
// visits and independent of title formatting), otherwise a normalized
// title. This mirrors the classifier cache's own normalize() approach so
// the same paper always maps to the same id.
function lens81NormalizeTitle(title) {
  return (title || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function lens81GetPaperId(meta) {
  // If we're handed a record that already came from storage (it already
  // has a stable `id`), reuse it exactly rather than recomputing — avoids
  // any chance of drift if title/url formatting were ever to change.
  if (meta.id) return meta.id;
  if (meta.doi) {
    return 'doi:' + meta.doi.trim().toLowerCase();
  }
  if (meta.url) {
    const m = meta.url.match(/[?&](?:cluster|cites)=(\d+)/);
    if (m) return 'gs:' + m[1];
  }
  return 'title:' + lens81NormalizeTitle(meta.title);
}

// --- Low-level storage helpers -------------------------------------------

const LENS81_COLLECTIONS_KEY = 'lens81_collections';

function lens81PaperKey(paperId) {
  return 'lens81_paper:' + paperId;
}

async function lens81GetAllCollections() {
  const stored = await chrome.storage.local.get(LENS81_COLLECTIONS_KEY);
  return stored[LENS81_COLLECTIONS_KEY] || {};
}

async function lens81SaveAllCollections(collections) {
  await chrome.storage.local.set({ [LENS81_COLLECTIONS_KEY]: collections });
}

async function lens81GetPaper(paperId) {
  const key = lens81PaperKey(paperId);
  const stored = await chrome.storage.local.get(key);
  return stored[key] || null;
}

// Batched read for content.js, which needs the saved-state of many results
// on a search page at once — one storage call instead of one per result.
async function lens81GetPapers(paperIds) {
  if (!paperIds.length) return {};
  const keys = paperIds.map(lens81PaperKey);
  const stored = await chrome.storage.local.get(keys);
  const out = {};
  for (const id of paperIds) out[id] = stored[lens81PaperKey(id)] || null;
  return out;
}

async function lens81SavePaper(paperId, data) {
  await chrome.storage.local.set({ [lens81PaperKey(paperId)]: data });
}

async function lens81DeletePaper(paperId) {
  await chrome.storage.local.remove(lens81PaperKey(paperId));
}

// --- Collections CRUD -----------------------------------------------------

// Every mutation below does a read-modify-write of the single
// `lens81_collections` object. Without serializing them, two mutations
// fired close together (e.g. rapidly checking two different collection
// checkboxes for the same paper) could each read the "before" state and
// the second write would silently clobber the first. lens81Enqueue() chains
// every mutation onto one promise so they always run one at a time, in the
// order they were called, regardless of how quickly the UI fires them.
let lens81WriteQueue = Promise.resolve();
function lens81Enqueue(task) {
  const run = lens81WriteQueue.then(task, task);
  lens81WriteQueue = run.then(
    () => {},
    () => {}
  );
  return run;
}

function lens81GenerateId() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function lens81CreateCollectionImpl(name) {
  name = (name || '').trim();
  if (!name) return { error: 'empty' };

  const collections = await lens81GetAllCollections();
  const dup = Object.values(collections).some((c) => c.name.toLowerCase() === name.toLowerCase());
  if (dup) return { error: 'duplicate' };

  const id = lens81GenerateId();
  collections[id] = { id, name, createdAt: Date.now(), paperIds: [] };
  await lens81SaveAllCollections(collections);
  return { id, name };
}

async function lens81RenameCollectionImpl(id, name) {
  name = (name || '').trim();
  if (!name) return { error: 'empty' };

  const collections = await lens81GetAllCollections();
  if (!collections[id]) return { error: 'notfound' };

  const dup = Object.values(collections).some(
    (c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase()
  );
  if (dup) return { error: 'duplicate' };

  collections[id].name = name;
  await lens81SaveAllCollections(collections);
  return { id, name };
}

// Deleting a collection never deletes a paper that's still saved somewhere
// else — it just pulls this collection's id out of each of its papers'
// collectionIds, and only removes a paper's storage record entirely once
// that leaves it belonging to zero collections.
async function lens81DeleteCollectionImpl(id) {
  const collections = await lens81GetAllCollections();
  const coll = collections[id];
  if (!coll) return;

  const paperIds = coll.paperIds.slice();
  delete collections[id];
  await lens81SaveAllCollections(collections);

  for (const paperId of paperIds) {
    const paper = await lens81GetPaper(paperId);
    if (!paper) continue;
    paper.collectionIds = paper.collectionIds.filter((cid) => cid !== id);
    if (paper.collectionIds.length === 0) {
      await lens81DeletePaper(paperId);
    } else {
      await lens81SavePaper(paperId, paper);
    }
  }
}

// Toggles membership of one paper in one collection. `meta` is the paper's
// current known metadata (title/authors/url/type/confidence) — only used
// to create the storage record the first time a paper is saved anywhere;
// on every later toggle the existing stored record is reused as-is so a
// re-save never overwrites already-collected metadata with staler values.
async function lens81TogglePaperInCollectionImpl(meta, collectionId) {
  const paperId = lens81GetPaperId(meta);
  const collections = await lens81GetAllCollections();
  const coll = collections[collectionId];
  if (!coll) return null;

  let paper = await lens81GetPaper(paperId);
  const wasIn = Boolean(paper && paper.collectionIds.includes(collectionId));

  if (wasIn) {
    paper.collectionIds = paper.collectionIds.filter((cid) => cid !== collectionId);
    coll.paperIds = coll.paperIds.filter((pid) => pid !== paperId);
    if (paper.collectionIds.length === 0) {
      await lens81DeletePaper(paperId);
    } else {
      await lens81SavePaper(paperId, paper);
    }
  } else {
    if (!paper) {
      paper = {
        id: paperId,
        title: meta.title || '',
        authors: meta.authors || '',
        url: meta.url || '',
        type: meta.type || '',
        confidence: Number.isFinite(meta.confidence) ? meta.confidence : null,
        savedAt: Date.now(),
        collectionIds: [],
      };
    }
    if (!paper.collectionIds.includes(collectionId)) paper.collectionIds.push(collectionId);
    if (!coll.paperIds.includes(paperId)) coll.paperIds.push(paperId);
    await lens81SavePaper(paperId, paper);
  }

  await lens81SaveAllCollections(collections);
  return { paperId, collectionIds: paper.collectionIds.slice(), nowIn: !wasIn };
}

// Removes a single paper from a single collection — same effect as toggling
// off, exposed separately so the collection-view page's "remove" button
// doesn't need to know the current membership state first.
async function lens81RemovePaperFromCollection(paperId, collectionId) {
  const paper = await lens81GetPaper(paperId);
  if (!paper) return;
  await lens81TogglePaperInCollection(paper, collectionId);
}

// Public entry points — each mutation is queued so concurrent calls never
// race on the shared collections object (see lens81Enqueue above).
function lens81CreateCollection(name) {
  return lens81Enqueue(() => lens81CreateCollectionImpl(name));
}
function lens81RenameCollection(id, name) {
  return lens81Enqueue(() => lens81RenameCollectionImpl(id, name));
}
function lens81DeleteCollection(id) {
  return lens81Enqueue(() => lens81DeleteCollectionImpl(id));
}
function lens81TogglePaperInCollection(meta, collectionId) {
  return lens81Enqueue(() => lens81TogglePaperInCollectionImpl(meta, collectionId));
}

// --- Export ---------------------------------------------------------------

// Builds flat export rows straight from storage — no separate "export
// index" needed since every paper already lists its own collections and
// every collection already lists its own paperIds.
async function lens81BuildExportRows(filterCollectionIds) {
  const collections = await lens81GetAllCollections();
  const all = await chrome.storage.local.get(null);
  const rows = [];

  for (const key in all) {
    if (!key.startsWith('lens81_paper:')) continue;
    const paper = all[key];
    if (!paper || !Array.isArray(paper.collectionIds)) continue;

    const names = paper.collectionIds
      .filter((cid) => !filterCollectionIds || filterCollectionIds.includes(cid))
      .map((cid) => collections[cid] && collections[cid].name)
      .filter(Boolean);

    if (names.length === 0) continue;

    rows.push({
      collections: names.join('; '),
      title: paper.title || '',
      authors: paper.authors || '',
      classification: paper.type || '',
      confidence: Number.isFinite(paper.confidence) ? `${paper.confidence}%` : '',
      url: paper.url || '',
      dateSaved: paper.savedAt ? new Date(paper.savedAt).toISOString().slice(0, 10) : '',
    });
  }

  rows.sort((a, b) => a.title.localeCompare(b.title));
  return rows;
}

const LENS81_EXPORT_HEADERS = [
  'Collection(s)',
  'Title',
  'Authors',
  'Classification',
  'Confidence',
  'Google Scholar URL',
  'Date Saved',
];

function lens81RowsToCsv(rows) {
  const escape = (v) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [LENS81_EXPORT_HEADERS.map(escape).join(',')];
  for (const r of rows) {
    lines.push(
      [r.collections, r.title, r.authors, r.classification, r.confidence, r.url, r.dateSaved]
        .map(escape)
        .join(',')
    );
  }
  // Leading BOM so Excel opens the UTF-8 CSV without mangling non-ASCII
  // characters in titles/author names.
  return '\uFEFF' + lines.join('\r\n');
}

// Structured JSON export — one object per paper, collections expanded back
// into an array rather than the CSV's semicolon-joined string, so the file
// round-trips cleanly through a script or another tool.
function lens81RowsToJson(rows) {
  return JSON.stringify(
    rows.map((r) => ({
      collections: r.collections ? r.collections.split('; ') : [],
      title: r.title,
      authors: r.authors,
      classification: r.classification,
      confidence: r.confidence,
      url: r.url,
      dateSaved: r.dateSaved,
    })),
    null,
    2
  );
}

// BibTeX export, for pulling saved papers straight into a reference
// manager. Deliberately uses @misc with no `year` field rather than
// guessing one: Lens⁸¹ never scrapes a publication year (only Semantic
// Scholar/OpenAlex abstracts, and the date the paper was *saved*), and
// putting a wrong year in a citation is worse than leaving it out. The
// save date and classification are recorded in `note` instead, and the
// Scholar link in `howpublished` so the actual paper is one click away.
function lens81BibtexEscapeField(value) {
  return String(value ?? '')
    .replace(/\\/g, '')
    .replace(/[{}]/g, '');
}

function lens81BibtexKey(row, usedKeys) {
  const firstAuthor = (row.authors || '').split(/,| and /i)[0].trim().split(/\s+/).pop() || '';
  const firstWord = (row.title || 'untitled')
    .trim()
    .split(/\s+/)[0]
    .replace(/[^a-zA-Z0-9]/g, '');
  const savedYear = row.dateSaved ? row.dateSaved.slice(0, 4) : '';
  let base = `${firstAuthor}${savedYear}${firstWord}`.replace(/[^a-zA-Z0-9]/g, '');
  if (!base) base = 'paper';

  let key = base;
  let n = 2;
  while (usedKeys.has(key)) {
    key = `${base}${n}`;
    n += 1;
  }
  usedKeys.add(key);
  return key;
}

function lens81RowsToBibtex(rows) {
  const usedKeys = new Set();
  const entries = rows.map((r) => {
    const key = lens81BibtexKey(r, usedKeys);
    const fields = [`  title = {${lens81BibtexEscapeField(r.title)}}`];
    if (r.authors) fields.push(`  author = {${lens81BibtexEscapeField(r.authors)}}`);
    if (r.url) fields.push(`  howpublished = {${lens81BibtexEscapeField(r.url)}}`);

    const noteParts = [];
    if (r.dateSaved) noteParts.push(`Saved ${r.dateSaved} via Lens81`);
    if (r.classification) {
      noteParts.push(`classified as ${r.classification}${r.confidence ? ` (${r.confidence} confidence)` : ''}`);
    }
    if (noteParts.length) fields.push(`  note = {${lens81BibtexEscapeField(noteParts.join('; '))}}`);
    if (r.collections) fields.push(`  keywords = {${lens81BibtexEscapeField(r.collections)}}`);

    return `@misc{${key},\n${fields.join(',\n')}\n}`;
  });
  return entries.join('\n\n') + '\n';
}

// Markdown export — a readable reading list (headings + links), suited to
// dropping straight into Notion/Obsidian/a plain note rather than a
// spreadsheet.
function lens81RowsToMarkdown(rows, heading) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `# ${heading || 'Lens⁸¹ export'}`,
    '',
    `_${rows.length} paper${rows.length === 1 ? '' : 's'} · exported ${today}_`,
    '',
  ];

  for (const r of rows) {
    const title = r.title || '(untitled)';
    lines.push(r.url ? `## [${title}](${r.url})` : `## ${title}`);

    const metaParts = [];
    if (r.authors) metaParts.push(r.authors);
    if (r.classification) metaParts.push(`${r.classification}${r.confidence ? ` · ${r.confidence}` : ''}`);
    if (r.collections) metaParts.push(`📁 ${r.collections}`);
    if (metaParts.length) lines.push(metaParts.join(' · '));

    if (r.dateSaved) lines.push(`*Saved ${r.dateSaved}*`);
    lines.push('');
  }

  return lines.join('\n');
}

function lens81DownloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function lens81DownloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Returns the number of rows written, so callers can surface "Exported N
// papers" / "Nothing to export yet" feedback in the UI.
async function lens81ExportCollection(collectionIdOrNull, format) {
  const filter = collectionIdOrNull ? [collectionIdOrNull] : null;
  const rows = await lens81BuildExportRows(filter);

  let name = 'lens81-all-collections';
  let displayName = 'All collections';
  if (collectionIdOrNull) {
    const collections = await lens81GetAllCollections();
    const coll = collections[collectionIdOrNull];
    if (coll) {
      const slug = coll.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      name = 'lens81-' + (slug || 'collection');
      displayName = coll.name;
    }
  }

  if (format === 'xlsx') {
    const blob = window.buildLens81Xlsx(LENS81_EXPORT_HEADERS, rows.map((r) => [
      r.collections,
      r.title,
      r.authors,
      r.classification,
      r.confidence,
      r.url,
      r.dateSaved,
    ]));
    lens81DownloadBlob(`${name}.xlsx`, blob);
  } else if (format === 'json') {
    lens81DownloadTextFile(`${name}.json`, lens81RowsToJson(rows), 'application/json;charset=utf-8');
  } else if (format === 'bibtex') {
    lens81DownloadTextFile(`${name}.bib`, lens81RowsToBibtex(rows), 'application/x-bibtex;charset=utf-8');
  } else if (format === 'md') {
    lens81DownloadTextFile(`${name}.md`, lens81RowsToMarkdown(rows, displayName), 'text/markdown;charset=utf-8');
  } else {
    lens81DownloadTextFile(`${name}.csv`, lens81RowsToCsv(rows), 'text/csv;charset=utf-8');
  }

  return rows.length;
}
