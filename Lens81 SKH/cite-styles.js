// cite-styles.js
// Standalone page (opened from the Cite popover's "More styles…" option)
// that searches the full 2856-style CSL library bundled in
// vendor/styles/all/ and formats the paper the person was citing in
// whichever one they pick — a copy-ready reference in literally any
// citation style the CSL project supports, not just the 4 quick ones the
// popover shows inline.
//
// The paper itself is handed off via a one-shot chrome.storage.local key
// (see cite.js's "More styles…" handler) rather than a URL parameter,
// since a paper's title/authors/venue can be long and awkward to encode
// reliably into a URL. Each open gets its own uniquely-nonced storage key
// (the nonce itself travels via a URL query param, which is short and
// URL-safe) rather than one shared key name — opening "More styles…" for
// one paper and then immediately for a different one, before the first
// tab finishes loading, would otherwise let the second write clobber the
// first before it's read, silently showing the wrong paper. This page
// reads and immediately clears its own key — reloading the page
// afterward correctly shows "no paper" rather than replaying stale data.

const CITE_ALL_STYLES_HANDOFF_PREFIX = 'citeAllStylesPaper:';
// If a "More styles…" tab is opened but then closed without ever loading
// (or fails to load), its handoff key has nothing left to clean it up —
// harmless on its own (it's a small JSON blob), but left unbounded it
// accumulates for as long as the extension is installed. Any handoff key
// still around after this long almost certainly belongs to an abandoned
// tab, not one that's just slow to load, so it's swept on the next page
// load rather than kept forever.
const CITE_ALL_STYLES_HANDOFF_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_RENDERED_STYLE_ROWS = 200; // keep the DOM light even for a broad search term

const styleCountEl = document.getElementById('style-count');
const noPaperNote = document.getElementById('no-paper-note');
const paperCard = document.getElementById('paper-card');
const paperTitleEl = document.getElementById('paper-title');
const paperMetaEl = document.getElementById('paper-meta');
const searchInput = document.getElementById('search-input');
const styleListEl = document.getElementById('style-list');
const resultPanel = document.getElementById('result-panel');
const resultTitleEl = document.getElementById('result-title');
const resultBodyEl = document.getElementById('result-body');

let styleIndex = [];
let currentPaper = null;
let selectedRow = null;

function paperAuthorsLine(paper) {
  const authors = Array.isArray(paper.authors) ? paper.authors : [];
  if (!authors.length) return '';
  if (authors.length <= 2) return authors.join(', ');
  return `${authors[0]} et al.`;
}

// Best-effort cleanup of any handoff keys nobody ever read — a tab that
// was opened and then closed before init() ran, or that errored out. Swept
// opportunistically on every load rather than run on a timer, since this
// page isn't kept open in the background.
async function sweepAbandonedHandoffs(skipKey) {
  try {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const toRemove = [];
    for (const key of Object.keys(all)) {
      if (!key.startsWith(CITE_ALL_STYLES_HANDOFF_PREFIX) || key === skipKey) continue;
      const nonce = key.slice(CITE_ALL_STYLES_HANDOFF_PREFIX.length);
      const ts = Number(nonce.split('_')[0]);
      if (!Number.isFinite(ts) || now - ts > CITE_ALL_STYLES_HANDOFF_MAX_AGE_MS) {
        toRemove.push(key);
      }
    }
    if (toRemove.length) await chrome.storage.local.remove(toRemove);
  } catch {
    // Non-critical housekeeping — never let this block loading the actual paper.
  }
}

async function loadPaper() {
  const nonce = new URLSearchParams(location.search).get('handoff');
  if (!nonce) {
    await sweepAbandonedHandoffs(null);
    return null;
  }
  const key = CITE_ALL_STYLES_HANDOFF_PREFIX + nonce;
  try {
    const stored = await chrome.storage.local.get(key);
    const paper = stored[key];
    await chrome.storage.local.remove(key); // one-shot handoff
    await sweepAbandonedHandoffs(key);
    return paper || null;
  } catch {
    return null;
  }
}

function renderPaperCard(paper) {
  if (!paper) {
    noPaperNote.style.display = 'block';
    paperCard.style.display = 'none';
    return;
  }
  noPaperNote.style.display = 'none';
  paperCard.style.display = 'block';
  paperTitleEl.textContent = paper.title || 'Untitled';
  const bits = [paperAuthorsLine(paper)];
  if (paper.year) bits.push(String(paper.year));
  if (paper.venue) bits.push(paper.venue);
  paperMetaEl.textContent = bits.filter(Boolean).join(' · ');
}

function highlightMatch(text, query) {
  if (!query) return document.createTextNode(text);
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return document.createTextNode(text);
  const frag = document.createDocumentFragment();
  frag.appendChild(document.createTextNode(text.slice(0, idx)));
  const mark = document.createElement('mark');
  mark.style.background = 'var(--cyan-tint)';
  mark.style.color = 'var(--cyan-ink)';
  mark.textContent = text.slice(idx, idx + query.length);
  frag.appendChild(mark);
  frag.appendChild(document.createTextNode(text.slice(idx + query.length)));
  return frag;
}

function renderStyleList(query) {
  styleListEl.innerHTML = '';
  const trimmed = query.trim().toLowerCase();

  const matches = trimmed
    ? styleIndex.filter((s) => s.title.toLowerCase().includes(trimmed) || s.id.includes(trimmed))
    : styleIndex;

  if (matches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'style-list-empty';
    empty.textContent = `No styles match "${query}". Try a different search term.`;
    styleListEl.appendChild(empty);
    return;
  }

  matches.slice(0, MAX_RENDERED_STYLE_ROWS).forEach((style) => {
    const row = document.createElement('div');
    row.className = 'style-row';
    row.dataset.styleId = style.id;

    const title = document.createElement('span');
    title.className = 'style-row-title';
    title.appendChild(highlightMatch(style.title, trimmed));
    row.appendChild(title);

    const idEl = document.createElement('span');
    idEl.className = 'style-row-id';
    idEl.textContent = style.id;
    row.appendChild(idEl);

    row.addEventListener('click', () => selectStyle(style, row));
    styleListEl.appendChild(row);
  });

  if (matches.length > MAX_RENDERED_STYLE_ROWS) {
    const more = document.createElement('div');
    more.className = 'style-list-empty';
    more.textContent = `${matches.length - MAX_RENDERED_STYLE_ROWS} more match. Keep typing to narrow it down.`;
    styleListEl.appendChild(more);
  }
}

async function selectStyle(style, rowEl) {
  if (selectedRow) selectedRow.classList.remove('selected');
  rowEl.classList.add('selected');
  selectedRow = rowEl;

  resultPanel.classList.add('show');
  resultTitleEl.textContent = style.title;
  resultBodyEl.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'result-loading';
  loading.textContent = 'Formatting…';
  resultBodyEl.appendChild(loading);

  if (!currentPaper) {
    resultBodyEl.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'result-error';
    err.textContent = 'No paper to format. See the note above.';
    resultBodyEl.appendChild(err);
    return;
  }

  if (typeof lens81FormatCitationAnyStyle !== 'function') {
    resultBodyEl.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'result-error';
    err.textContent = 'The citation engine failed to load. Try reloading this page.';
    resultBodyEl.appendChild(err);
    return;
  }

  try {
    const result = await lens81FormatCitationAnyStyle(currentPaper, style.id);
    if (selectedRow !== rowEl) return; // a different style was picked while this was in flight
    resultBodyEl.innerHTML = '';
    if (!result || !result.text) {
      const err = document.createElement('div');
      err.className = 'result-error';
      err.textContent = "This style didn't produce any output for this paper.";
      resultBodyEl.appendChild(err);
      return;
    }
    buildResultBody(result.text, result.kind);
  } catch (err) {
    if (selectedRow !== rowEl) return;
    resultBodyEl.innerHTML = '';
    const errEl = document.createElement('div');
    errEl.className = 'result-error';
    errEl.textContent = 'Something went wrong formatting this style. Try another one.';
    resultBodyEl.appendChild(errEl);
    console.warn('Lens⁸¹: failed to format style', style.id, err);
  }
}

function buildResultBody(text, kind) {
  if (kind === 'note') {
    const note = document.createElement('p');
    note.style.cssText = 'font-size:11.5px;color:#8a4c0e;background:#fdeee1;border:1px solid #f6dcc0;border-radius:6px;padding:6px 10px;margin:0 0 8px;';
    note.textContent = 'This style has no separate reference list. It cites in full as a footnote, shown below as it would appear there.';
    resultBodyEl.appendChild(note);
  }

  const textarea = document.createElement('textarea');
  textarea.className = 'result-textarea';
  textarea.readOnly = true;
  textarea.value = text;
  textarea.rows = Math.min(6, Math.max(2, Math.ceil(text.length / 70)));
  resultBodyEl.appendChild(textarea);

  const actions = document.createElement('div');
  actions.className = 'result-actions';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn-copy';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = '✓ Copied';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
        copyBtn.classList.remove('copied');
      }, 1800);
    } catch {
      textarea.select();
      copyBtn.textContent = 'Select failed, press Ctrl/Cmd+C';
    }
  });
  actions.appendChild(copyBtn);
  resultBodyEl.appendChild(actions);
}

async function init() {
  currentPaper = await loadPaper();
  renderPaperCard(currentPaper);

  styleIndex = typeof lens81GetAllStylesIndex === 'function' ? await lens81GetAllStylesIndex() : [];
  styleCountEl.textContent = styleIndex.length ? `${styleIndex.length.toLocaleString()} styles` : '';
  renderStyleList('');

  searchInput.addEventListener('input', () => renderStyleList(searchInput.value));
  searchInput.focus();
}

init();
