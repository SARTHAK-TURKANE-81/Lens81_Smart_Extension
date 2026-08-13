// csl.js
// Real Citation Style Language (CSL) formatting, via the bundled
// citeproc-js engine (vendor/citeproc.js) plus four bundled styles
// (vendor/styles/{apa,mla,chicago,ieee}.csl) and the en-US locale
// (vendor/locales/locales-en-US.xml). Used by:
//   - cite.js (content script, <all_urls>) — the "Cite" popover
//   - collection.js / popup.js (extension pages) — Collections export
//
// Deliberately NOT loaded by background.js. citeproc-js needs a real
// `DOMParser` to parse style/locale XML (see vendor/citeproc.js — it falls
// back to ActiveXObject/XMLHttpRequest shims if DOMParser is missing, none
// of which exist in an MV3 service worker either), so all CSL formatting
// happens in a DOM context. background.js only ever hands back structured,
// unformatted metadata (title/authors/year/venue/doi/url) — see
// background.js's toResultShape() — and formatting happens here instead.
//
// Every public function in this file is safe to call speculatively: a
// missing bundled file, a malformed CSL-JSON item, or citeproc-js itself
// throwing internally all surface as a rejected promise, never an
// uncaught exception — so a citation-formatting failure can never cascade
// into breaking whatever page loaded this script (the same isolation
// lesson from the Collections recommendations fix).

// File paths point into vendor/styles/all/ (the full bundled library —
// see the "All citation styles" section below) rather than separate
// top-level copies: apa.csl/mla.csl/chicago.csl/ieee.csl used to be
// duplicated at vendor/styles/*.csl for this fast path, byte-identical to
// the copies already in vendor/styles/all/ — same for the en-US locale.
// Pointing at the one canonical copy instead removes ~350KB of pure
// duplication from the packaged extension with no functional change.
const LENS81_CSL_STYLES = {
  apa: { file: 'vendor/styles/all/apa.csl', label: 'APA' },
  mla: { file: 'vendor/styles/all/modern-language-association.csl', label: 'MLA' },
  chicago: { file: 'vendor/styles/all/chicago-author-date.csl', label: 'Chicago' },
  ieee: { file: 'vendor/styles/all/ieee.csl', label: 'IEEE' },
};
const LENS81_CSL_LOCALE_FILE = 'vendor/locales/all/locales-en-US.xml';
const LENS81_CSL_DEFAULT_LOCALE = 'en-US';

// --- All citation styles (2856 bundled, for the "All Citation Styles" page) -
// The 4 curated styles above cover the vast majority of real usage and load
// instantly with a fixed engine cache; this section instead supports *any*
// bundled style by id, backed by vendor/styles/all/*.csl (the CSL project's
// full independent-style set) plus every bundled locale in
// vendor/locales/all/ — unlike the curated path above, which only ever uses
// en-US, this looks up each style's own declared locale so a
// non-English-market style (e.g. a German or Japanese journal's) renders
// with its actual connector words ("and", "et al.", etc.) instead of
// silently falling back to English.
const LENS81_ALL_STYLES_INDEX_FILE = 'vendor/styles/all/index.json';
let lens81AllStylesIndexCache = null;
// Raw style XML is much lighter than a parsed engine, but the note-style
// fallback above populates this even when the engine itself isn't cached
// (it's built fresh each time) — bounded for the same reason as the engine
// cache, just with room for more entries since each one is cheaper.
const LENS81_MAX_CACHED_ANY_STYLE_XML = 60;
const lens81AllStyleXmlCache = new Map();

function lens81CacheAnyStyleXml(styleId, xml) {
  lens81AllStyleXmlCache.delete(styleId);
  lens81AllStyleXmlCache.set(styleId, xml);
  if (lens81AllStyleXmlCache.size > LENS81_MAX_CACHED_ANY_STYLE_XML) {
    const oldest = lens81AllStyleXmlCache.keys().next().value;
    lens81AllStyleXmlCache.delete(oldest);
  }
}
// A fully-parsed citeproc-js engine holds far more in memory than its raw
// style XML — caching one per style with no limit is fine for normal
// browsing (a handful of styles compared per session) but grows without
// bound if someone works through dozens/hundreds of styles in one sitting
// (found by sweeping the entire 2,856-style library in one test run, which
// exhausted the JS heap — an extreme case, but the underlying growth is
// real and unbounded regardless of how many styles it takes to notice).
// Capped at a small LRU so long browsing sessions stay bounded instead of
// leaking memory for as long as the tab stays open.
const LENS81_MAX_CACHED_ANY_STYLE_ENGINES = 24;
const lens81AllStyleEngineCache = new Map(); // styleId -> engine, in least-recently-used order

function lens81CacheAnyStyleEngine(styleId, engine) {
  lens81AllStyleEngineCache.delete(styleId); // re-inserting moves it to "most recent" below
  lens81AllStyleEngineCache.set(styleId, engine);
  if (lens81AllStyleEngineCache.size > LENS81_MAX_CACHED_ANY_STYLE_ENGINES) {
    const oldest = lens81AllStyleEngineCache.keys().next().value;
    lens81AllStyleEngineCache.delete(oldest);
  }
}
const lens81LocaleXmlCacheByLang = {};
let lens81AllStylesAvailableLocales = null; // Set of bundled locale tags, lazily built

// The full searchable index: [{ id, title }, ...] for every bundled style.
// Fetched once and cached; callers (the All Citation Styles page) filter it
// client-side rather than re-fetching per keystroke.
async function lens81GetAllStylesIndex() {
  if (lens81AllStylesIndexCache) return lens81AllStylesIndexCache;
  const text = await lens81CslFetchText(LENS81_ALL_STYLES_INDEX_FILE);
  lens81AllStylesIndexCache = JSON.parse(text);
  return lens81AllStylesIndexCache;
}

function lens81LocaleFilePath(tag) {
  return `vendor/locales/all/locales-${tag}.xml`;
}

// Bundled locale tags are read from a small generated index rather than
// hardcoded here — content scripts/extension pages can't list a directory,
// and hand-maintaining this list would silently drift out of sync with
// vendor/locales/all/ (an earlier draft of this file did exactly that and
// had 8 tags wrong). Fetched once and cached.
async function lens81GetAvailableLocaleTags() {
  if (lens81AllStylesAvailableLocales) return lens81AllStylesAvailableLocales;
  const text = await lens81CslFetchText('vendor/locales/all/index.json');
  lens81AllStylesAvailableLocales = new Set(JSON.parse(text));
  return lens81AllStylesAvailableLocales;
}

// Resolves whatever language tag citeproc-js asks for to a bundled locale
// file: exact match first, then the same primary language with a different
// region (e.g. asked for "de-CH", bundled has "de-DE"), then en-US as the
// final fallback so formatting never fails outright over a missing locale.
async function lens81ResolveLocaleTag(requestedTag) {
  const available = await lens81GetAvailableLocaleTags();
  if (available.has(requestedTag)) return requestedTag;
  const primary = requestedTag.split('-')[0];
  const sameLanguage = [...available].find((tag) => tag.split('-')[0] === primary);
  return sameLanguage || LENS81_CSL_DEFAULT_LOCALE;
}

async function lens81GetLocaleXml(tag) {
  if (lens81LocaleXmlCacheByLang[tag]) return lens81LocaleXmlCacheByLang[tag];
  const resolved = await lens81ResolveLocaleTag(tag);
  if (!lens81LocaleXmlCacheByLang[resolved]) {
    lens81LocaleXmlCacheByLang[resolved] = await lens81CslFetchText(lens81LocaleFilePath(resolved));
  }
  // Cache under the originally-requested tag too, so repeat lookups for an
  // unbundled regional variant (e.g. "de-CH") skip the resolution step.
  lens81LocaleXmlCacheByLang[tag] = lens81LocaleXmlCacheByLang[resolved];
  return lens81LocaleXmlCacheByLang[tag];
}

// Builds a brand new engine instance every call — never cached. Used
// directly by the note-style fallback in lens81FormatCitationAnyStyle
// below, which needs a guaranteed-fresh engine (see that function's
// comment for why); lens81GetAnyStyleEngine wraps this with caching for
// the common bibliography path, where reuse is safe.
async function lens81BuildAnyStyleEngineRaw(styleId) {
  if (!LENS81_CSL_AVAILABLE) throw new Error('Lens⁸¹ CSL: citeproc-js did not load.');
  if (!lens81AllStyleXmlCache.has(styleId)) {
    const xml = await lens81CslFetchText(`vendor/styles/all/${styleId}.csl`);
    lens81CacheAnyStyleXml(styleId, xml);
  } else {
    lens81CacheAnyStyleXml(styleId, lens81AllStyleXmlCache.get(styleId)); // touch: mark as most-recently-used
  }
  const styleXml = lens81AllStyleXmlCache.get(styleId);

  // Every bundled style declares (or CSL defaults it to) a specific locale
  // — read that off the style XML itself rather than assuming en-US, since
  // this path (unlike the 4 curated styles) covers plenty of non-English
  // styles.
  const localeMatch = styleXml.match(/default-locale="([^"]+)"/);
  const requestedLocale = localeMatch ? localeMatch[1] : LENS81_CSL_DEFAULT_LOCALE;

  const sys = {
    retrieveLocale: (lang) => lens81LocaleXmlCacheByLang[lang] || lens81LocaleXmlCacheByLang[requestedLocale] || '',
    retrieveItem: (id) => lens81CslItemStore[id],
  };
  // Pre-warm the locale cache for whatever this style needs before
  // constructing the engine — citeproc-js calls retrieveLocale
  // synchronously during construction, so the XML has to already be
  // sitting in cache by then.
  await lens81GetLocaleXml(requestedLocale);

  return new CSL.Engine(sys, styleXml, requestedLocale);
}

async function lens81GetAnyStyleEngine(styleId) {
  if (lens81AllStyleEngineCache.has(styleId)) {
    const engine = lens81AllStyleEngineCache.get(styleId);
    lens81CacheAnyStyleEngine(styleId, engine); // touch: mark as most-recently-used
    return engine;
  }
  const engine = await lens81BuildAnyStyleEngineRaw(styleId);
  lens81CacheAnyStyleEngine(styleId, engine);
  return engine;
}

// Formats one paper in any bundled style by id (e.g. "vancouver",
// "nature", "chicago-note-bibliography") — used by the All Citation Styles
// page. Same fresh-id-per-call approach as lens81FormatCitation above, for
// the same reason (avoids citeproc-js serving stale cached output for a
// reused id on a cached engine).
//
// Not every bundled style has a bibliography section: styles with
// class="note" (found via stress-testing a random sample of the bundled
// library, not assumed) can be citation/footnote-only — the full reference
// is rendered as the footnote text itself, with no separate reference-list
// entry at all. makeBibliography() legitimately returns nothing for those
// (~90 of the 2,856 bundled styles), so this falls back to rendering a
// one-off citation cluster instead — what the style actually produces —
// rather than showing a blank result for something that isn't broken.
//
// That fallback deliberately builds its own brand-new engine
// (lens81BuildAnyStyleEngineRaw) instead of reusing the cached one from
// lens81GetAnyStyleEngine: appendCitationCluster() is stateful and
// cumulative on whichever engine instance it's called on (the same
// property that makes the in-text citation registry elsewhere in this file
// work at all) — calling it repeatedly on a *cached, reused* engine with a
// fresh item id each time (as this function does for its ids) leaves the
// engine's internal registry holding references to older ids that
// lens81CslItemStore no longer has, since that store is fully replaced on
// every call. citeproc-js then throws trying to re-resolve one of those
// stale ids. A fresh, single-use engine has no prior citation history to
// go stale, so this never happens. (Caught via stress-testing ~150 random
// styles against several paper shapes, not by inspection — it only
// reproduced on styles that hit this fallback at all, i.e. note-only ones.)
let lens81AnyStyleSingleItemCounter = 0;
function lens81FormatCitationAnyStyle(paper, styleId) {
  return lens81CslEnqueue(async () => {
    const engine = await lens81GetAnyStyleEngine(styleId);
    const id = `__anystyle_${lens81AnyStyleSingleItemCounter++}__`;
    lens81CslItemStore = { [id]: lens81ToCslItem(paper, id) };
    engine.updateItems([id]);

    const bib = engine.makeBibliography();
    const bibHtml = bib && bib[1] && bib[1][0] ? bib[1][0] : '';
    if (bibHtml) return { text: lens81StripCslHtml(bibHtml), kind: 'bibliography' };

    // No bibliography output — fall back to a one-off citation cluster on
    // a fresh engine (see comment above for why it must be fresh).
    const noteEngine = await lens81BuildAnyStyleEngineRaw(styleId);
    const noteId = `__anystyle_note_${lens81AnyStyleSingleItemCounter++}__`;
    lens81CslItemStore = { [noteId]: lens81ToCslItem(paper, noteId) };
    noteEngine.updateItems([noteId]);
    const citation = { citationItems: [{ id: noteId }], properties: { noteIndex: 1 } };
    const results = noteEngine.appendCitationCluster(citation);
    const mine = results.find(([, , citationID]) => citationID === citation.citationID);
    const citeHtml = mine ? mine[1] : '';
    return { text: lens81StripCslHtml(citeHtml), kind: 'note' };
  });
}

// True only if vendor/citeproc.js loaded successfully before this file did
// (both are listed in that order everywhere this file is included). Lets
// callers check availability up front instead of waiting for a rejected
// promise on first use.
const LENS81_CSL_AVAILABLE = typeof CSL !== 'undefined';

const lens81CslStyleXmlCache = {};
let lens81CslLocaleXmlCache = null;
let lens81CslItemStore = {}; // id -> CSL-JSON, populated right before each ad-hoc engine call

// All engine calls are serialized through this queue. citeproc-js pulls
// items via a synchronous sys.retrieveItem(id) callback that reads from
// shared module state (lens81CslItemStore, or an in-text registry's own
// item map below) — without serializing, two formatting calls close
// together (e.g. two "Cite" popovers, or a popover open while a
// Collections export runs) could interleave between "await engine ready"
// and "set item store / call updateItems", corrupting each other's
// output. Formatting one citation is cheap, so queuing has no noticeable
// cost.
let lens81CslQueue = Promise.resolve();
function lens81CslEnqueue(task) {
  const run = lens81CslQueue.then(task, task);
  lens81CslQueue = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function lens81CslFetchText(relativePath) {
  const res = await fetch(chrome.runtime.getURL(relativePath));
  if (!res.ok) throw new Error(`Lens⁸¹ CSL: could not load ${relativePath} (HTTP ${res.status})`);
  return res.text();
}

// Fetches (and caches) the style + locale XML text for one style — shared
// by both engine caches below, so the two engine instances for a style
// (ad-hoc and in-text — see comment on lens81CslInTextEngineCache) never
// fetch the same file twice.
async function lens81LoadCslAssets(styleKey) {
  const meta = LENS81_CSL_STYLES[styleKey];
  if (!meta) throw new Error(`Lens⁸¹ CSL: unknown citation style "${styleKey}"`);
  if (!LENS81_CSL_AVAILABLE) throw new Error('Lens⁸¹ CSL: citeproc-js did not load.');

  if (!lens81CslStyleXmlCache[styleKey]) {
    lens81CslStyleXmlCache[styleKey] = await lens81CslFetchText(meta.file);
  }
  if (!lens81CslLocaleXmlCache) {
    lens81CslLocaleXmlCache = await lens81CslFetchText(LENS81_CSL_LOCALE_FILE);
  }
  return { styleXml: lens81CslStyleXmlCache[styleKey], localeXml: lens81CslLocaleXmlCache };
}

// Ad-hoc engine, one per style, cached and reused — used by
// lens81FormatCitation() and lens81FormatBibliography() below for
// independent, stateless formatting requests (the Cite popover's per-result
// preview, and Collections' one-shot export). Every call to these two
// functions uses a fresh, never-reused item id (see their own comments),
// so reusing the engine instance across calls is safe.
//
// This is intentionally a *separate* engine instance from the one used by
// the in-text citation registry below (lens81CslInTextEngineCache), even
// though they're built from the same style/locale XML — citeproc-js's
// citation-cluster tracking (used for in-text numbering/disambiguation) is
// stateful per engine instance, and mixing that state with unrelated
// one-off formatting calls on the same engine is a correctness risk not
// worth taking just to save one engine instance's memory.
const lens81CslEngineCache = {};
async function lens81GetCslEngine(styleKey) {
  if (lens81CslEngineCache[styleKey]) return lens81CslEngineCache[styleKey];
  const { styleXml, localeXml } = await lens81LoadCslAssets(styleKey);
  const sys = {
    retrieveLocale: () => localeXml,
    retrieveItem: (id) => lens81CslItemStore[id],
  };
  const engine = new CSL.Engine(sys, styleXml, LENS81_CSL_DEFAULT_LOCALE);
  lens81CslEngineCache[styleKey] = engine;
  return engine;
}

// --- CSL-JSON conversion ----------------------------------------------------

// Splits a plain "First Middle Last" name into CSL's {given, family} shape
// using a last-space heuristic — the same level of approximation the
// hand-rolled formatters this replaces already used (see background.js's
// splitName()), just in citeproc's expected field names. This won't handle
// multi-word surnames or particles ("van der Berg") correctly, but neither
// did the code it replaces — citeproc-js still produces correctly *styled*
// output (proper inversion, initials, ampersands/commas per style) around
// whatever split it's given.
function lens81NameToCslPerson(fullName) {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return { family: parts[0] };
  return { given: parts.slice(0, -1).join(' '), family: parts[parts.length - 1] };
}

// Best-effort parse of a raw Google Scholar byline (e.g. "M Jinek, K
// Chylinski… - Science, 2012 - science.org") into structured
// author/venue/year. Used only for papers saved from a Scholar result,
// which never had these fields separated out to begin with — collections.js
// stores exactly what Scholar's byline line says, unparsed (see
// collections-content.js). This is inherently approximate: Scholar
// truncates long author lists with "…", and venue/year are read from
// whatever sits between the first and second " - ", which is usually but
// not always just "Journal, Year". It never fabricates a year or venue
// that wasn't legible in the byline — a wrong-shaped byline just yields
// fewer parsed fields, not a wrong value.
function lens81ParseScholarByline(byline) {
  const segments = (byline || '').split(' - ').map((s) => s.trim());
  const authorsPart = segments[0] || '';
  const venueYearPart = segments.length > 1 ? segments[1] : '';

  const authors = authorsPart
    .replace(/…$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(lens81NameToCslPerson)
    .filter(Boolean);

  const yearMatch = venueYearPart.match(/\b(1[89]\d{2}|20\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[0]) : null;
  const venue = venueYearPart.replace(/,?\s*\b(1[89]\d{2}|20\d{2})\b\s*$/, '').trim();

  return { authors, venue, year: year || null };
}

// Builds one CSL-JSON item from a paper record. Accepts either shape
// already in use across the extension:
//   - "structured" (cite.js search candidates, sourced from Crossref/
//     Semantic Scholar/OpenAlex via background.js — see toResultShape()):
//     { title, authors: [fullName, ...], year, venue, doi, url }
//   - "Scholar-saved" (Collections paper records — see collections.js):
//     { title, authors: "<raw Scholar byline>", url }, with no separate
//     year/venue/doi, parsed via lens81ParseScholarByline() above.
// Every item is typed 'article-journal' regardless of source: nothing in
// this extension reliably distinguishes book/chapter/conference-paper
// from a journal article, and CSL has no generic "unknown" type that
// renders sensibly across all four bundled styles — 'article-journal' is
// the type that degrades most gracefully when the true type is unknown.
function lens81ToCslItem(paper, id) {
  let authors = [];
  let venue = paper.venue || '';
  let year = paper.year || null;

  if (Array.isArray(paper.authors)) {
    authors = paper.authors.map(lens81NameToCslPerson).filter(Boolean);
  } else if (typeof paper.authors === 'string' && paper.authors) {
    if (paper.year || paper.venue) {
      // Structured fields already present elsewhere on the record — this
      // is a plain "Name, Name" list, not a Scholar byline, so just split
      // on commas rather than running byline-specific parsing on text
      // that was never in "- Venue, Year -" form to begin with.
      authors = paper.authors
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(lens81NameToCslPerson)
        .filter(Boolean);
    } else {
      const parsed = lens81ParseScholarByline(paper.authors);
      authors = parsed.authors;
      venue = venue || parsed.venue;
      year = year || parsed.year;
    }
  }

  const item = { id: String(id), type: 'article-journal', title: paper.title || 'Untitled' };
  if (authors.length) item.author = authors;
  if (venue) item['container-title'] = venue;
  if (year) item.issued = { 'date-parts': [[year]] };
  if (paper.doi) item.DOI = paper.doi;
  if (paper.url) item.URL = paper.url;
  return item;
}

// citeproc-js emits HTML (<i>italics</i>, <div class="csl-entry">, HTML
// entities, etc.) meant to be rendered directly into a page. Both the Cite
// popover and Collections export want plain text (to copy into a document,
// or write to a .txt/.md file), so this renders the markup through an
// off-DOM element and reads .textContent back — correctly handles entities
// and nested tags in a way hand-rolled tag-stripping regex wouldn't.
function lens81StripCslHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent.trim().replace(/\s+/g, ' ');
}

// --- Public API --------------------------------------------------------

// Formats a single paper as one reference-list entry in the given style.
// Used by the Cite popover (one search candidate at a time).
//
// Each call uses a fresh, never-reused item id. citeproc-js's Engine keeps
// an internal per-id registry across calls (that's how it disambiguates
// names and sorts a real multi-item bibliography) — reusing a fixed id
// like "__single__" for every call caused the *second* call on an
// already-cached engine to silently return the *first* call's cached
// result instead of the new paper's, since citeproc-js saw the same id
// already registered and didn't know its underlying data had changed.
let lens81CslSingleItemCounter = 0;
function lens81FormatCitation(paper, styleKey) {
  return lens81CslEnqueue(async () => {
    const engine = await lens81GetCslEngine(styleKey);
    const id = `__single_${lens81CslSingleItemCounter++}__`;
    lens81CslItemStore = { [id]: lens81ToCslItem(paper, id) };
    engine.updateItems([id]);
    const bib = engine.makeBibliography();
    const html = bib && bib[1] && bib[1][0] ? bib[1][0] : '';
    return lens81StripCslHtml(html);
  });
}

// Formats many papers as one properly-sorted, properly-disambiguated
// bibliography in one pass — the actual advantage of a real CSL engine
// over formatting entries one at a time: citeproc-js handles cross-item
// name disambiguation ("Smith 2020a" / "2020b") and each style's own sort
// order (alphabetical for APA/MLA/Chicago, citation order for IEEE)
// itself, rather than the caller trying to reproduce that logic. Used by
// Collections export ("Formatted citations" format).
//
// Each call uses a fresh batch of ids, for the same reason
// lens81FormatCitation's ids are never reused (see its comment above) —
// positional ids like "item0"/"item1" would otherwise collide with an
// earlier, unrelated bibliography call on the same cached engine (e.g.
// formatting two different collections back to back) and could silently
// serve stale cached entries instead of the new collection's papers.
let lens81CslBatchCounter = 0;
function lens81FormatBibliography(papers, styleKey) {
  return lens81CslEnqueue(async () => {
    const engine = await lens81GetCslEngine(styleKey);
    const batch = lens81CslBatchCounter++;
    const items = {};
    const ids = papers.map((p, i) => {
      const id = `batch${batch}_item${i}`;
      items[id] = lens81ToCslItem(p, id);
      return id;
    });
    lens81CslItemStore = items;
    engine.updateItems(ids);
    const bib = engine.makeBibliography();
    if (!bib || !bib[1]) return [];
    return bib[1].map(lens81StripCslHtml);
  });
}

// --- In-text citations + running bibliography (per style, per page load) ---
//
// The two functions above insert a *full reference* every time — useful
// for grabbing one citation's formatted text, but not how anyone actually
// cites something while writing: real usage is a short in-text marker at
// the point of use ("(Jinek & Chylinski, 2012)" or "[1]"), consistently
// numbered/matched against a single reference list gathered at the end of
// the document. citeproc-js supports this directly via
// engine.appendCitationCluster(), which is *stateful*: it needs the same
// engine instance to see every citation in the order they were cited, so
// it can track which sources have already appeared (for numbering) and
// which ones need disambiguating (e.g. two different 2012 papers by
// "Jinek" — see below). That's why this uses stable per-paper ids and a
// dedicated, long-lived engine per style — unlike lens81FormatCitation/
// lens81FormatBibliography above, which intentionally use fresh ids and
// can reuse one shared ad-hoc engine because each call is independent.
//
// Scope: this registry lives only in memory for the life of the content
// script — i.e. it tracks everything cited so far *in this writing
// session on this page*, and resets on page reload/navigation. It is not
// persisted across reloads or synced across tabs.
//
// Important citeproc-js behavior this code has to account for:
// appendCitationCluster() can retroactively change the rendered text of a
// citation already returned by an *earlier* call — e.g. citing a third
// paper that happens to share the same author and year as an
// already-cited one turns the earlier "(Jinek, 2012)" into
// "(Jinek, 2012a)" as a side effect, to keep every citation
// distinguishable. There is no way for this extension to reach back into
// whatever page/editor the person is writing in and fix text already
// inserted, so rather than silently going out of sync, every retroactive
// change is surfaced back to the caller (cite.js shows it as a warning)
// instead of being swallowed.

const lens81CslInText = {}; // styleKey -> { items, itemOrder, clusterIds, lastText }
const lens81CslInTextEngineCache = {};

function lens81GetInTextState(styleKey) {
  if (!lens81CslInText[styleKey]) {
    lens81CslInText[styleKey] = {
      items: {}, // paperId -> CSL-JSON item
      itemOrder: [], // paperIds, in first-cited order (for engine.updateItems)
      clusterIds: [], // citeproc citationIDs, in the order clusters were appended
      lastText: {}, // citeproc citationID -> last rendered text this module returned for it
    };
  }
  return lens81CslInText[styleKey];
}

// Separate engine instance from lens81GetCslEngine's — see the file-level
// comment above this section for why the two are never shared.
async function lens81GetInTextEngine(styleKey) {
  if (lens81CslInTextEngineCache[styleKey]) return lens81CslInTextEngineCache[styleKey];
  const { styleXml, localeXml } = await lens81LoadCslAssets(styleKey);
  const state = lens81GetInTextState(styleKey);
  const sys = {
    retrieveLocale: () => localeXml,
    retrieveItem: (id) => state.items[id],
  };
  const engine = new CSL.Engine(sys, styleXml, LENS81_CSL_DEFAULT_LOCALE);
  lens81CslInTextEngineCache[styleKey] = engine;
  return engine;
}

// Stable id for a paper, used only by the in-text registry (unlike the
// throwaway ids lens81FormatCitation/lens81FormatBibliography use):
// appendCitationCluster needs the *same* id every time the *same* paper is
// cited again, both to reuse its existing reference-list number and to
// recognize a repeat citation rather than registering a duplicate source.
// DOI is preferred when available (unambiguous); title is the fallback for
// sources without one (e.g. most Collections/Scholar-saved papers).
function lens81CitePaperId(paper) {
  if (paper.doi) return 'doi:' + paper.doi.trim().toLowerCase();
  const slug = (paper.title || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return 'title:' + (slug || Math.random().toString(36).slice(2));
}

// Registers one citation "event" for `paper` in `styleKey`'s running
// in-text sequence (creating the source's reference-list entry the first
// time it's cited, reusing it on repeats) and returns:
//   - text: the properly-formatted in-text marker for *this* citation
//     event — e.g. "[1]" for IEEE, "(Jinek, 2012)" for APA — with
//     numbering/disambiguation computed by citeproc-js itself
//   - retroactiveChanges: [{ oldText, newText }, ...] for any *earlier*
//     citation(s) in this style whose rendered text changed as a side
//     effect of this one (see file-level comment above) — empty in the
//     overwhelmingly common case where nothing earlier was affected
function lens81CiteInText(paper, styleKey) {
  return lens81CslEnqueue(async () => {
    const engine = await lens81GetInTextEngine(styleKey);
    const state = lens81GetInTextState(styleKey);
    const paperId = lens81CitePaperId(paper);

    if (!state.items[paperId]) {
      state.items[paperId] = lens81ToCslItem(paper, paperId);
      state.itemOrder.push(paperId);
      engine.updateItems(state.itemOrder);
    }

    const citation = { citationItems: [{ id: paperId }], properties: { noteIndex: 0 } };
    const results = engine.appendCitationCluster(citation); // [[index, text, citationID], ...]

    // appendCitationCluster() always appends citationID onto the engine's
    // own internal registry, in call order — so the cluster this call just
    // added is always the last one, regardless of whether it's a brand new
    // source or a repeat citation of one already in the list.
    const newClusterId = citation.citationID;
    state.clusterIds.push(newClusterId);

    let myText = '';
    const retroactiveChanges = [];
    for (const [, text, citationID] of results) {
      const prevText = state.lastText[citationID];
      if (citationID === newClusterId) {
        myText = text;
      } else if (prevText !== undefined && prevText !== text) {
        retroactiveChanges.push({ oldText: prevText, newText: text });
      }
      state.lastText[citationID] = text;
    }

    return { text: lens81StripCslHtml(myText), retroactiveChanges };
  });
}

// Number of distinct sources cited so far in this style on this page —
// cheap and synchronous (no engine call), for UI display (e.g. "3 sources
// cited — Insert References").
function lens81GetCitedCount(styleKey) {
  const state = lens81CslInText[styleKey];
  return state ? state.itemOrder.length : 0;
}

// The current running bibliography for everything cited so far in this
// style on this page — the reference list the in-text markers from
// lens81CiteInText() refer to. Always in sync since it reads the same
// registry; call it whenever the person wants to (re-)insert or copy an
// up-to-date References section.
function lens81GetRunningBibliography(styleKey) {
  return lens81CslEnqueue(async () => {
    const state = lens81GetInTextState(styleKey);
    if (state.itemOrder.length === 0) return [];
    const engine = await lens81GetInTextEngine(styleKey);
    engine.updateItems(state.itemOrder);
    const bib = engine.makeBibliography();
    if (!bib || !bib[1]) return [];
    return bib[1].map(lens81StripCslHtml);
  });
}

// Clears the in-text citation history for one style (or every style, if
// none given) — lets someone start a fresh reference list on the same
// page without reloading it, e.g. after finishing one document and
// starting another in the same tab (a not-uncommon case in single-page
// editors that don't do a full page reload between documents).
function lens81ResetInTextRegistry(styleKey) {
  if (styleKey) {
    delete lens81CslInText[styleKey];
    delete lens81CslInTextEngineCache[styleKey];
  } else {
    for (const key of Object.keys(lens81CslInText)) delete lens81CslInText[key];
    for (const key of Object.keys(lens81CslInTextEngineCache)) delete lens81CslInTextEngineCache[key];
  }
}
