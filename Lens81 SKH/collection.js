// collection.js
// Behavior for the standalone collection-view page (collection.html),
// opened from the popup's collection list. Uses collections.js for all
// storage access — see that file for the storage shape.

const params = new URLSearchParams(location.search);
const collectionId = params.get('id');

const titleEl = document.getElementById('title');
const renameInput = document.getElementById('rename-input');
const renameBtn = document.getElementById('rename-btn');
const deleteBtn = document.getElementById('delete-btn');
const confirmBar = document.getElementById('confirm-bar');
const countNote = document.getElementById('count-note');
const paperListEl = document.getElementById('paper-list');
const exportBtn = document.getElementById('export-btn');
const exportMenu = document.getElementById('export-menu');

const renameErr = document.getElementById('rename-err');

let renaming = false;

function paperTypeClass(type) {
  if (type === 'Research') return 'research';
  if (type === 'Review') return 'review';
  return 'unknown';
}

function paperTypeLabel(type) {
  if (type === 'Research') return '📘 Research';
  if (type === 'Review') return '📙 Review';
  return 'Unclassified';
}

async function loadCollectionOrBail() {
  const collections = await lens81GetAllCollections();
  const coll = collections[collectionId];
  if (!coll) {
    titleEl.textContent = 'Collection not found';
    countNote.textContent = 'It may have been deleted already.';
    return null;
  }
  return coll;
}

async function render() {
  const coll = await loadCollectionOrBail();
  if (!coll) return;

  titleEl.textContent = `📁 ${coll.name}`;
  document.title = `Lens⁸¹: ${coll.name}`;
  countNote.textContent = `${coll.paperIds.length} paper${coll.paperIds.length === 1 ? '' : 's'}`;

  const papers = await lens81GetPapers(coll.paperIds);
  const ordered = coll.paperIds.map((id) => papers[id]).filter(Boolean);
  ordered.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));

  paperListEl.innerHTML = '';

  if (ordered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No papers saved here yet. Save one from a Google Scholar search page.';
    paperListEl.appendChild(empty);
    return;
  }

  ordered.forEach((paper) => {
    const row = document.createElement('div');
    row.className = 'paper-row';

    const badge = document.createElement('span');
    badge.className = `paper-badge ${paperTypeClass(paper.type)}`;
    badge.textContent =
      paper.type && Number.isFinite(paper.confidence)
        ? `${paperTypeLabel(paper.type)} · ${paper.confidence}%`
        : paperTypeLabel(paper.type);
    row.appendChild(badge);

    const main = document.createElement('div');
    main.className = 'paper-main';

    const link = document.createElement('a');
    link.className = 'paper-title';
    link.href = paper.url || '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = paper.title || '(untitled)';
    main.appendChild(link);

    if (paper.authors) {
      const meta = document.createElement('div');
      meta.className = 'paper-meta';
      meta.textContent = paper.authors;
      main.appendChild(meta);
    }

    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'paper-actions';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'btn-open';
    openBtn.textContent = 'Open';
    openBtn.addEventListener('click', () => window.open(paper.url || '#', '_blank', 'noopener'));

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      removeBtn.disabled = true;
      await lens81RemovePaperFromCollection(paper.id, collectionId);
      render();
    });

    actions.appendChild(openBtn);
    actions.appendChild(removeBtn);
    row.appendChild(actions);

    paperListEl.appendChild(row);
  });
}

// --- Smart recommendations: data layer ------------------------------------
// "More papers like this collection" — resolves each saved paper to a
// Semantic Scholar paper id (from its DOI when we have one, otherwise a
// verified title search) and feeds those ids to Semantic Scholar's own
// paper-recommendations API (free, no key required). That API is trained
// on citation/co-citation graphs, not keyword overlap, so a collection
// titled "heart attack prediction using ML" can surface "deep learning for
// cardiac risk stratification" even where the wording barely overlaps —
// a fundamentally different (and better) signal than a text search.
//
// Falls back to a plain title-based search across the same free,
// Crossref/Semantic Scholar/OpenAlex endpoints background.js already uses
// if every paper in the collection fails to resolve to an id, or the
// recommendations endpoint itself returns nothing (rate-limited, offline).
//
// Recommending a paper the person has *already* saved anywhere (not just
// in this collection) would be noise, not a recommendation — so results
// are filtered against every paper already saved across all collections.

const RECOMMEND_MAX_SOURCE_PAPERS = 10; // cap how many saved papers feed the recommender
const RECOMMEND_MAX_RESULTS = 6;
const RECOMMEND_FETCH_LIMIT = RECOMMEND_MAX_RESULTS * 3; // ask for extra, since some get filtered out as already-saved
const RECOMMEND_TIMEOUT_MS = 8000;
const RECOMMEND_FIELDS = 'title,abstract,authors,year,venue,externalIds,url';

async function recFetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function recNormalize(text) {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function recTitleSimilarity(a, b) {
  a = recNormalize(a);
  b = recNormalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (longer.includes(shorter)) return shorter.length / longer.length;
  const aTokens = new Set(a.split(' '));
  const bTokens = new Set(b.split(' '));
  const overlap = [...aTokens].filter((t) => bTokens.has(t)).length;
  return overlap / Math.max(aTokens.size, bTokens.size);
}

// Resolves one saved paper to a Semantic Scholar paperId: DOI lookup first
// (exact, unambiguous), title search as a fallback — verified against
// title similarity so an unrelated top hit is never trusted as "the" paper.
// Returns null (rather than throwing) for anything that can't be resolved,
// so one unresolvable paper never breaks recommendations for the rest of
// the collection.
async function resolveSemanticScholarId(paper) {
  const doi = paper.id && paper.id.startsWith('doi:') ? paper.id.slice(4) : '';
  if (doi) {
    try {
      const res = await recFetchWithTimeout(
        `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=paperId`,
        {},
        RECOMMEND_TIMEOUT_MS
      );
      if (res.ok) {
        const data = await res.json();
        if (data?.paperId) return data.paperId;
      }
    } catch {
      // fall through to title search below
    }
  }

  if (!paper.title) return null;
  try {
    const res = await recFetchWithTimeout(
      'https://api.semanticscholar.org/graph/v1/paper/search' +
        `?query=${encodeURIComponent(paper.title)}&fields=paperId,title&limit=1`,
      {},
      RECOMMEND_TIMEOUT_MS
    );
    if (!res.ok) return null;
    const data = await res.json();
    const hit = data?.data?.[0];
    if (hit && recTitleSimilarity(hit.title, paper.title) >= 0.6) return hit.paperId;
  } catch {
    // this paper just won't contribute to the recommendation seed set
  }
  return null;
}

function shapeSemanticScholarPaper(p) {
  return {
    title: p.title,
    abstract: p.abstract || '',
    authors: (p.authors || []).map((a) => a.name).filter(Boolean),
    year: p.year || null,
    venue: p.venue || '',
    doi: p.externalIds?.DOI || '',
    url: p.url || (p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : ''),
  };
}

// Semantic Scholar's recommendations API takes a *set* of positive papers
// (and, optionally, negatives — unused here) and returns papers related to
// that set as a whole, which is exactly "more like this collection" rather
// than "more like this one paper".
async function fetchRecommendationsForIds(positiveIds) {
  try {
    const res = await recFetchWithTimeout(
      `https://api.semanticscholar.org/recommendations/v1/papers/?fields=${RECOMMEND_FIELDS}&limit=${RECOMMEND_FETCH_LIMIT}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positivePaperIds: positiveIds, negativePaperIds: [] }),
      },
      RECOMMEND_TIMEOUT_MS
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.recommendedPapers || []).filter((p) => p.title).map(shapeSemanticScholarPaper);
  } catch {
    return [];
  }
}

// Fallback when no paper in the collection could be resolved to a Semantic
// Scholar id at all (or the recommendations call itself failed): a plain
// title-based search, same free/keyless OpenAlex endpoint background.js
// already relies on for citation search.
async function fetchRecommendationsByTitleSearch(titles) {
  const query = titles.filter(Boolean).slice(0, 5).join(' ');
  if (!query.trim()) return [];
  try {
    const res = await recFetchWithTimeout(
      `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${RECOMMEND_FETCH_LIMIT}`,
      {},
      RECOMMEND_TIMEOUT_MS
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.results || [])
      .filter((w) => w.display_name)
      .map((w) => ({
        title: w.display_name,
        abstract: '',
        authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
        year: w.publication_year || null,
        venue: w.host_venue?.display_name || w.primary_location?.source?.display_name || '',
        doi: (w.doi || '').replace('https://doi.org/', ''),
        url: w.doi || w.id || '',
      }));
  } catch {
    return [];
  }
}

// Every paper saved in *any* collection, keyed by DOI and by normalized
// title — recommending something the person already has saved elsewhere
// isn't a useful suggestion, so this is checked against every candidate.
async function getAllSavedPaperIdentities() {
  const all = await chrome.storage.local.get(null);
  const dois = new Set();
  const titles = new Set();
  for (const key in all) {
    if (!key.startsWith('lens81_paper:')) continue;
    const p = all[key];
    if (!p) continue;
    if (p.id && p.id.startsWith('doi:')) dois.add(p.id.slice(4).toLowerCase());
    if (p.title) titles.add(recNormalize(p.title));
  }
  return { dois, titles };
}

function isAlreadySaved(rec, saved) {
  if (rec.doi && saved.dois.has(rec.doi.toLowerCase())) return true;
  return saved.titles.has(recNormalize(rec.title));
}

// Orchestrates the whole recommendation lookup for one collection: resolve
// seed papers -> ask Semantic Scholar for similar papers -> fall back to a
// title search if that comes up empty -> filter out anything already saved
// anywhere -> de-dupe near-identical titles against each other.
async function buildRecommendations(forCollectionId) {
  const collections = await lens81GetAllCollections();
  const coll = collections[forCollectionId];
  if (!coll) return { source: 'none', results: [] };

  const papers = await lens81GetPapers(coll.paperIds);
  const ordered = coll.paperIds
    .map((id) => papers[id])
    .filter(Boolean)
    .slice(0, RECOMMEND_MAX_SOURCE_PAPERS);
  if (ordered.length === 0) return { source: 'none', results: [] };

  const idOutcomes = await Promise.allSettled(ordered.map(resolveSemanticScholarId));
  const positiveIds = idOutcomes.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);

  let results = [];
  let source = 'none';

  if (positiveIds.length > 0) {
    results = await fetchRecommendationsForIds(positiveIds);
    if (results.length > 0) source = 'semantic-scholar';
  }

  if (results.length === 0) {
    results = await fetchRecommendationsByTitleSearch(ordered.map((p) => p.title));
    if (results.length > 0) source = 'title-search-fallback';
  }

  const saved = await getAllSavedPaperIdentities();
  const notAlreadySaved = results.filter((r) => !isAlreadySaved(r, saved));

  const deduped = [];
  for (const r of notAlreadySaved) {
    if (!deduped.some((d) => recTitleSimilarity(d.title, r.title) > 0.85)) deduped.push(r);
  }

  return { source, results: deduped.slice(0, RECOMMEND_MAX_RESULTS) };
}

// --- Rename -----------------------------------------------------------

renameBtn.addEventListener('click', async () => {
  if (!renaming) {
    renaming = true;
    renameErr.style.display = 'none';
    renameInput.value = titleEl.textContent.replace(/^📁\s*/, '');
    titleEl.style.display = 'none';
    renameInput.style.display = 'block';
    renameInput.focus();
    renameInput.select();
    return;
  }
  await commitRename();
});

renameInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') await commitRename();
  if (e.key === 'Escape') {
    renaming = false;
    renameErr.style.display = 'none';
    titleEl.style.display = 'block';
    renameInput.style.display = 'none';
  }
});

async function commitRename() {
  const name = renameInput.value.trim();
  if (!name) {
    renameErr.textContent = 'Enter a name.';
    renameErr.style.display = 'block';
    return;
  }
  const res = await lens81RenameCollection(collectionId, name);
  if (res.error === 'duplicate') {
    renameErr.textContent = 'A collection with that name already exists.';
    renameErr.style.display = 'block';
    return; // stay in edit mode so the user can pick another name
  }
  if (res.error) {
    renameErr.textContent = 'Could not rename the collection.';
    renameErr.style.display = 'block';
    return;
  }
  renaming = false;
  renameErr.style.display = 'none';
  titleEl.style.display = 'block';
  renameInput.style.display = 'none';
  await render();
}

// --- Delete -------------------------------------------------------------

deleteBtn.addEventListener('click', () => confirmBar.classList.add('show'));
document.getElementById('cancel-delete').addEventListener('click', () => confirmBar.classList.remove('show'));
document.getElementById('confirm-delete').addEventListener('click', async () => {
  await lens81DeleteCollection(collectionId);
  closeThisTab();
});

// Reliably closes the tab this page is running in, regardless of whether it
// was opened via window.open() or chrome.tabs.create() (the latter is how
// the popup opens this page — window.close() alone isn't guaranteed to work
// for tabs a script didn't open itself, but an extension can always close
// its own tab by id).
function closeThisTab() {
  if (chrome.tabs && chrome.tabs.getCurrent) {
    chrome.tabs.getCurrent((tab) => {
      if (tab && tab.id != null) {
        chrome.tabs.remove(tab.id);
      } else {
        window.close();
      }
    });
  } else {
    window.close();
  }
}

// --- Export ---------------------------------------------------------------

exportBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  exportMenu.style.display = exportMenu.style.display === 'block' ? 'none' : 'block';
});
exportMenu.querySelectorAll('button[data-format]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    exportMenu.style.display = 'none';
    const count = await lens81ExportCollection(collectionId, btn.dataset.format);
    flashExportFeedback(count);
  });
});
exportMenu.querySelectorAll('button[data-csl-style]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    exportMenu.style.display = 'none';
    const original = btn.textContent;
    btn.textContent = 'Formatting…';
    try {
      const count = await lens81ExportCollectionAsCsl(collectionId, btn.dataset.cslStyle);
      flashExportFeedback(count);
    } finally {
      btn.textContent = original;
    }
  });
});
document.addEventListener('click', () => {
  exportMenu.style.display = 'none';
});

function flashExportFeedback(count) {
  const original = exportBtn.textContent;
  exportBtn.textContent = count > 0 ? `✓ Exported ${count}` : 'Nothing to export yet';
  exportBtn.disabled = true;
  setTimeout(() => {
    exportBtn.textContent = original;
    exportBtn.disabled = false;
  }, 1800);
}

document.getElementById('back').addEventListener('click', () => {
  if (window.history.length > 1) window.history.back();
  else window.close();
});

if (!collectionId) {
  titleEl.textContent = 'No collection specified';
  countNote.textContent = '';
  // Without a real collectionId, lens81ExportCollection(null, …) would
  // export *every* collection instead of doing nothing — surprising and
  // wrong on a page that just said there's no collection here. Disable the
  // button outright rather than let that happen.
  exportBtn.disabled = true;
  exportBtn.title = 'No collection to export.';
} else {
  render();
}

// --- Smart recommendations -------------------------------------------------
// Deliberately initialized last, and defensively: everything above this
// point (loading the collection, listing papers, rename/delete/export) is
// core functionality and must work even if this section can't find its DOM
// elements or a network call fails. initSmartRecommendations() below never
// throws past its own boundary, so a problem here can never take the rest
// of the page down with it — the whole reason this section runs after,
// not before, the code above.

function recPaperTypeSuffix(rec) {
  const bits = [];
  if (rec.authors.length) bits.push(rec.authors.length > 2 ? `${rec.authors[0]} et al.` : rec.authors.join(', '));
  if (rec.year) bits.push(String(rec.year));
  if (rec.venue) bits.push(rec.venue);
  return bits.join(' · ');
}

function recRowMeta(rec) {
  // Shape lens81TogglePaperInCollectionImpl expects for a paper it's never
  // seen before — same fields collections-content.js fills in when saving
  // straight from a Google Scholar result row.
  return {
    title: rec.title,
    authors: rec.authors.join(', '),
    url: rec.url || (rec.doi ? `https://doi.org/${rec.doi}` : ''),
    type: '',
    confidence: null,
  };
}

function buildRecRow(rec, els) {
  const row = document.createElement('div');
  row.className = 'rec-row';

  const main = document.createElement('div');
  main.className = 'rec-main';

  const link = document.createElement('a');
  link.className = 'rec-title';
  const meta = recRowMeta(rec);
  link.href = meta.url || '#';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = rec.title;
  main.appendChild(link);

  const metaLine = recPaperTypeSuffix(rec);
  if (metaLine) {
    const metaEl = document.createElement('div');
    metaEl.className = 'rec-meta';
    metaEl.textContent = metaLine;
    main.appendChild(metaEl);
  }

  row.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'rec-actions';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn-rec-add';
  addBtn.textContent = '+ Add';
  addBtn.addEventListener('click', async () => {
    addBtn.disabled = true;
    addBtn.textContent = '✓ Added';
    try {
      await lens81TogglePaperInCollection(meta, collectionId);
      await render(); // refresh the saved-papers list to show the new addition
    } catch {
      addBtn.disabled = false;
      addBtn.textContent = '+ Add';
    }
  });
  actions.appendChild(addBtn);

  row.appendChild(actions);
  return row;
}

function renderRecLoading(els) {
  els.list.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'rec-loading';
  loading.textContent = 'Looking for similar papers…';
  els.list.appendChild(loading);
  els.note.textContent = 'Based on the papers already in this collection.';
  els.refresh.classList.add('spinning');
  els.refresh.disabled = true;
}

function renderRecEmpty(els, message) {
  els.list.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'rec-empty';
  empty.textContent = message;
  els.list.appendChild(empty);
}

const REC_SOURCE_LABELS = {
  'semantic-scholar': 'Based on citation similarity to papers already in this collection (via Semantic Scholar).',
  'title-search-fallback': 'Based on a title search from papers in this collection (citation-based recommendations were unavailable).',
};

async function renderRecommendations(els) {
  renderRecLoading(els);
  try {
    const { source, results } = await buildRecommendations(collectionId);
    els.refresh.classList.remove('spinning');
    els.refresh.disabled = false;

    if (results.length === 0) {
      els.note.textContent = 'Based on the papers already in this collection.';
      renderRecEmpty(
        els,
        source === 'none'
          ? 'Save at least one paper here to get recommendations.'
          : "Couldn't find anything new to suggest right now. Try refreshing later."
      );
      return;
    }

    els.note.textContent = REC_SOURCE_LABELS[source] || 'Based on the papers already in this collection.';
    els.list.innerHTML = '';
    results.forEach((rec) => els.list.appendChild(buildRecRow(rec, els)));
  } catch {
    els.refresh.classList.remove('spinning');
    els.refresh.disabled = false;
    els.note.textContent = 'Based on the papers already in this collection.';
    renderRecEmpty(els, 'Something went wrong fetching recommendations. Try refreshing.');
  }
}

// Looks up its own elements and wires its own listener entirely inside this
// function, and the whole thing is wrapped in try/catch by its caller — so
// a missing element (e.g. an out-of-sync collection.html) or any other
// unexpected failure here logs to the console and simply leaves the
// section blank, instead of throwing past this point and breaking anything
// else on the page.
function initSmartRecommendations() {
  if (!collectionId) return;

  const list = document.getElementById('rec-list');
  const note = document.getElementById('rec-source-note');
  const refresh = document.getElementById('rec-refresh');
  if (!list || !note || !refresh) {
    console.warn('Lens⁸¹: recommendations UI elements not found, skipping.');
    return;
  }

  const els = { list, note, refresh };
  refresh.addEventListener('click', () => renderRecommendations(els));
  renderRecommendations(els);
}

try {
  initSmartRecommendations();
} catch (err) {
  console.warn('Lens⁸¹: smart recommendations failed to initialize.', err);
}
