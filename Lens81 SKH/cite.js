// cite.js (added in v6)
// "Highlight -> Find Citation": highlight any passage on any page (or in a
// Google Doc), click the floating "Cite" button that appears, and get a
// short list of candidate papers with ready-to-use APA/MLA/IEEE/BibTeX
// citations. Clicking a result inserts it at the cursor.
//
// Fully additive and self-contained: this file doesn't touch, call, or
// depend on anything in content.js / collections.js / collections-content.js
// (those only run on scholar.google.com; this runs everywhere, including
// scholar.google.com, but shares no state with them). All heavy lifting
// (search, keyword extraction, re-ranking, formatting) happens in
// background.js via the 'FIND_CITATIONS' message; this file is UI only.
//
// Two selection-capture strategies, because Google Docs doesn't expose a
// normal DOM selection:
//   - Regular pages: window.getSelection() gives real text and a Range we
//     can restore later to insert at the same spot.
//   - Google Docs: the visible page is canvas-rendered, so getSelection()
//     doesn't reflect what's actually highlighted. Instead this triggers a
//     native copy (document.execCommand('copy')) and reads the clipboard
//     back — the same trick used to insert (see insertIntoDocs below). This
//     does mean using Cite in a Doc will overwrite your OS clipboard with
//     the highlighted text; the Cite button's tooltip says so.

const CITE_MIN_CHARS = 12;
// Long selections are no longer rejected outright — background.js splits
// anything past its own internal direct-query threshold into overlapping,
// sentence-bounded chunks and searches each one, so this only needs to be
// a sane UI ceiling (a few paragraphs), not a search-strategy limit.
const CITE_MAX_CHARS = 6000;
const CITE_IS_DOCS = location.hostname === 'docs.google.com';
const CITE_STYLE_STORAGE_KEY = 'citeDefaultStyle';

let citeBtn = null;
let citePopover = null;
let citeSavedRange = null; // regular pages: Range to restore before inserting
let citeSavedEditableRoot = null; // nearest contenteditable ancestor of citeSavedRange, if any
let citeSavedInputEl = null; // <textarea>/<input>: saved instead of a Range, since those don't use the page Selection API
let citeSavedText = '';
let citeLastMouse = { x: 0, y: 0 }; // fallback anchor for Docs, where Range math doesn't apply

document.addEventListener('mousemove', (e) => {
  citeLastMouse = { x: e.clientX, y: e.clientY };
});

// --- Selection detection -----------------------------------------------------

function citeRemoveButton() {
  if (citeBtn) {
    citeBtn.remove();
    citeBtn = null;
  }
}

function citeClosePopover() {
  if (citePopover) {
    citePopover.remove();
    citePopover = null;
  }
}

function citeCloseAll() {
  citeRemoveButton();
  citeClosePopover();
}

function citeHandleSelectionChange() {
  // Never clobber an open popover just because the mouse moved over it, or
  // because clicking inside it collapsed the underlying page selection.
  if (citePopover) return;

  if (CITE_IS_DOCS) {
    // No usable getSelection() text on Docs — just show the button near
    // the cursor whenever the mouse is released after a drag; the actual
    // text is only read once the button is clicked (see onCiteClick).
    return;
  }

  // <textarea>/<input> content isn't part of the page's addressable DOM
  // text, so a selection made inside one never shows up in
  // window.getSelection() below — check the focused field's own
  // selectionStart/End directly first, as a separate path.
  const active = document.activeElement;
  if (active && /^(TEXTAREA|INPUT)$/.test(active.tagName) && active.selectionStart !== active.selectionEnd) {
    const fieldText = active.value.slice(active.selectionStart, active.selectionEnd).trim();
    if (fieldText && fieldText.length >= CITE_MIN_CHARS && fieldText.length <= CITE_MAX_CHARS) {
      citeSavedRange = null;
      citeSavedEditableRoot = null;
      citeSavedInputEl = active;
      citeSavedText = fieldText;
      const rect = active.getBoundingClientRect();
      citeShowButton(rect.right, rect.top + 20);
      return;
    }
  }

  const sel = window.getSelection();
  const text = sel && !sel.isCollapsed ? sel.toString().trim() : '';

  if (!text || text.length < CITE_MIN_CHARS || text.length > CITE_MAX_CHARS) {
    citeRemoveButton();
    return;
  }

  citeSavedInputEl = null;
  citeSavedRange = sel.getRangeAt(0).cloneRange();
  citeSavedEditableRoot = citeFindEditableAncestor(citeSavedRange.commonAncestorContainer);
  citeSavedText = text;
  const rect = citeSavedRange.getBoundingClientRect();
  citeShowButton(rect.right, rect.bottom);
}

// Walks up from a selection's container to find the nearest contenteditable
// element, if the selection is inside one. Returns null for a selection
// on ordinary (non-editable) page content — e.g. reading an article rather
// than writing in a rich-text editor.
function citeFindEditableAncestor(node) {
  let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (el) {
    if (el.isContentEditable) return el;
    el = el.parentElement;
  }
  return null;
}

let citeMouseDownPos = null;
document.addEventListener('mousedown', (e) => {
  citeMouseDownPos = { x: e.clientX, y: e.clientY };
});

document.addEventListener('mouseup', (e) => {
  // Let the click finish (so getSelection() reflects the final drag) before
  // reacting, and skip entirely if the mouseup was on our own UI.
  if (citeBtn?.contains(e.target) || citePopover?.contains(e.target)) return;
  setTimeout(() => {
    if (CITE_IS_DOCS) {
      // Docs gives no selection API to check directly, so the button's
      // appearance has to be gated on something else — otherwise it would
      // show up on every single click (including just placing the cursor),
      // which is what was happening before this fix. A real drag (mouse
      // moved a meaningful distance since mousedown) or a double/triple
      // click (e.detail >= 2 — selects a word/paragraph without dragging)
      // are both reasonable proxies for "the person actually selected
      // something"; a plain single click at one point is not.
      const dragged =
        citeMouseDownPos &&
        (Math.abs(e.clientX - citeMouseDownPos.x) > 4 || Math.abs(e.clientY - citeMouseDownPos.y) > 4);
      if (dragged || e.detail >= 2) {
        citeShowButton(e.clientX, e.clientY + 16);
      } else {
        citeRemoveButton();
      }
    } else {
      citeHandleSelectionChange();
    }
  }, 0);
});

// Keyboard-based selection (Shift+Arrow, Ctrl+A, etc.) on regular pages.
document.addEventListener('keyup', (e) => {
  if (CITE_IS_DOCS) return;
  if (citeBtn?.contains(document.activeElement) || citePopover) return;
  if (!['Shift', 'Control', 'Meta', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  citeHandleSelectionChange();
});

document.addEventListener('click', (e) => {
  if (citeBtn?.contains(e.target) || citePopover?.contains(e.target)) return;
  citeCloseAll();
});

// --- Floating "Cite" button --------------------------------------------------

function citeShowButton(x, y) {
  citeRemoveButton();

  citeBtn = document.createElement('div');
  citeBtn.className = 'lens81-cite-btn-group';

  const citeAction = document.createElement('button');
  citeAction.type = 'button';
  citeAction.className = 'lens81-cite-btn lens81-cite-btn-cite';
  citeAction.textContent = 'Cite';
  citeAction.title = CITE_IS_DOCS
    ? 'Find a citation for your selection and insert it. This briefly copies your selection, so it will replace what\u2019s currently on your clipboard.'
    : 'Find a citation for your selection and insert it';

  const findAction = document.createElement('button');
  findAction.type = 'button';
  findAction.className = 'lens81-cite-btn lens81-cite-btn-find';
  findAction.textContent = 'Find';
  findAction.title = CITE_IS_DOCS
    ? 'Find the top 3 papers related to your selection. This briefly copies your selection, so it will replace what\u2019s currently on your clipboard.'
    : 'Find the top 3 papers related to your selection';

  // Keep the current text selection alive — a plain click on any element
  // (including our own buttons) can otherwise collapse it via the
  // browser's default mousedown behavior before our click handler runs.
  const keepSelection = (e) => e.preventDefault();
  citeAction.addEventListener('mousedown', keepSelection);
  findAction.addEventListener('mousedown', keepSelection);

  citeAction.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onCiteClick();
  });
  findAction.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onFindClick();
  });

  citeBtn.appendChild(citeAction);
  citeBtn.appendChild(findAction);

  const margin = 8;
  const left = Math.min(Math.max(x, margin), window.innerWidth - 140);
  const top = Math.min(Math.max(y, margin), window.innerHeight - 40);
  // `position: fixed` is already relative to the viewport, same as
  // getBoundingClientRect() — adding window.scrollX/scrollY here was a bug:
  // it double-corrected for scroll, so the button drifted further off the
  // real selection the more the page had been scrolled.
  citeBtn.style.left = `${left}px`;
  citeBtn.style.top = `${top}px`;

  document.body.appendChild(citeBtn);
}

// --- Getting the highlighted text --------------------------------------------

async function citeGetSelectedText() {
  if (!CITE_IS_DOCS) return citeSavedText;

  // Google Docs: read back the current selection via a native copy. This
  // only works because clipboardRead/clipboardWrite are declared in
  // manifest.json — content scripts without those permissions can't do
  // this on a normal web page.
  try {
    const ok = document.execCommand('copy');
    if (!ok) return '';
    // Give the copy a brief tick to land before reading it back.
    await new Promise((r) => setTimeout(r, 60));
    const text = await navigator.clipboard.readText();
    return text.trim();
  } catch {
    return '';
  }
}

// --- Popover ------------------------------------------------------------------

// Shared by both onCiteClick and onFindClick: reads the highlighted text,
// shows the loading popover, and validates the selection — the only
// difference between the two buttons is what happens after this succeeds
// (which message type gets sent, and which mode the results render in).
async function citeStartLookup(mode) {
  const rect = citeBtn.getBoundingClientRect();
  citeRemoveButton();
  citeShowPopoverLoading(rect, mode);

  const text = await citeGetSelectedText();
  if (!text || text.length < CITE_MIN_CHARS) {
    citeShowPopoverMessage(
      CITE_IS_DOCS
        ? "Couldn't read your selection. Select some text in the document and try again."
        : "Couldn't find a text selection. Highlight a sentence or two and try again."
    );
    return null;
  }
  // For Docs specifically, citeGetSelectedText() is the *only* place the
  // highlighted text is ever read (citeHandleSelectionChange bails out
  // early for Docs — see its own comment) — capture it into the same
  // module-level citeSavedText the other paths already use, so Insert can
  // preserve the highlighted claim later (see citeInsertIntoDocs). A no-op
  // for the non-Docs paths, which already set this at selection time.
  citeSavedText = text;
  return text;
}

// "Cite": strict — only ever offers a candidate confident enough to
// actually support the highlighted passage, with an "Add a source
// manually" escape hatch when nothing clears that bar (see
// citeShowNoResultsPanel).
async function onCiteClick() {
  const text = await citeStartLookup('cite');
  if (!text) return;

  chrome.runtime.sendMessage({ type: 'FIND_CITATIONS', text }, (response) => {
    if (chrome.runtime.lastError || !response) {
      citeShowPopoverMessage('Something went wrong reaching the extension. Try again.');
      return;
    }
    if (!response.ok) {
      citeShowNoResultsPanel(citeErrorMessage(response.error));
      return;
    }
    citeRenderResults(response, 'cite');
  });
}

// "Find": exploratory — the top 3 papers related to the highlighted
// passage, whatever their match strength, same as browsing Google Scholar
// yourself. No confidence gate, so there's no "nothing matched closely
// enough" dead end the way strict Cite mode can have; a paper found this
// way can still be cited (style dropdown + Insert/Copy work the same),
// the person just judges relevance themselves rather than the pipeline
// enforcing a bar first.
async function onFindClick() {
  const text = await citeStartLookup('find');
  if (!text) return;

  chrome.runtime.sendMessage({ type: 'FIND_PAPERS', text }, (response) => {
    if (chrome.runtime.lastError || !response) {
      citeShowPopoverMessage('Something went wrong reaching the extension. Try again.');
      return;
    }
    if (!response.ok) {
      citeShowPopoverMessage(citeErrorMessage(response.error));
      return;
    }
    citeRenderResults(response, 'find');
  });
}

// Search came back empty or with nothing confident enough — the exact
// moment an EndNote/Mendeley-style "add it yourself" option matters most,
// so this shows the same Add Source panel citeRenderResults does, just
// auto-expanded (there's nothing else on screen to point at it) instead of
// collapsed behind a toggle.
async function citeShowNoResultsPanel(message) {
  if (!citePopover) return;
  const pop = citePopover;
  pop.innerHTML = '';

  const note = document.createElement('div');
  note.className = 'lens81-cite-message';
  note.textContent = message;
  pop.appendChild(note);

  const defaultStyle = await citeGetDefaultStyle();
  if (!citePopover || citePopover !== pop) return; // popover was closed/replaced while awaiting
  const refsPanel = citeBuildReferencesPanel(defaultStyle);
  const addSource = citeBuildAddSourcePanel(defaultStyle, refsPanel.refresh);
  pop.appendChild(addSource);
  pop.appendChild(refsPanel.el);
  // Auto-expand: this panel is the whole point of showing up here.
  addSource.querySelector('.lens81-cite-addsrc-toggle')?.click();

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'lens81-cite-close';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', citeCloseAll);
  pop.appendChild(closeBtn);
}

function citeErrorMessage(error) {
  switch (error) {
    case 'no-results':
      return 'No candidate papers were found for this passage.';
    case 'no-strong-match':
      return "Found candidate papers, but none matched closely enough to suggest as a citation for this passage.";
    case 'timeout':
      return 'This took too long and timed out. Try again.';
    default:
      return "Couldn't find a citation for this passage right now.";
  }
}

function citePopoverShell() {
  citeClosePopover();
  const pop = document.createElement('div');
  pop.className = 'lens81-cite-pop';
  pop.addEventListener('click', (e) => e.stopPropagation());
  pop.addEventListener('mousedown', (e) => e.stopPropagation());
  document.body.appendChild(pop);
  citePopover = pop;
  return pop;
}

function citePositionPopover(pop, rect) {
  const margin = 8;
  const width = 340;
  // Same fix as citeShowButton: `position: fixed` + getBoundingClientRect()
  // are both already viewport-relative — no window.scrollX/scrollY needed
  // or wanted here.
  let left = rect.left;
  let top = rect.bottom + 6;
  if (left + width > window.innerWidth - margin) {
    left = window.innerWidth - width - margin;
  }
  left = Math.max(left, margin);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function citeShowPopoverLoading(rect, mode) {
  const pop = citePopoverShell();
  citePositionPopover(pop, rect);
  pop.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'lens81-cite-loading';
  loading.textContent = mode === 'find' ? 'Finding related papers…' : 'Searching for citations…';
  pop.appendChild(loading);
}

function citeShowPopoverMessage(message) {
  if (!citePopover) return;
  citePopover.innerHTML = '';
  const note = document.createElement('div');
  note.className = 'lens81-cite-message';
  note.textContent = message;
  citePopover.appendChild(note);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'lens81-cite-close';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', citeCloseAll);
  citePopover.appendChild(closeBtn);
}

async function citeGetDefaultStyle() {
  const stored = await chrome.storage.local.get(CITE_STYLE_STORAGE_KEY);
  return stored[CITE_STYLE_STORAGE_KEY] || 'apa';
}

function citeSetDefaultStyle(style) {
  chrome.storage.local.set({ [CITE_STYLE_STORAGE_KEY]: style });
}

function citeSourceNote(source) {
  switch (source) {
    case 'ai-rerank-failed':
      return "Your citation AI check didn't respond, so results are shown using free keyword matching instead.";
    case 'find-search':
      return 'Ranked by relevance, not filtered by confidence. Judge for yourself which (if any) fit.';
    default:
      return '';
  }
}

// --- Manual reference entry: "Add a source" ---------------------------
// Mirrors what EndNote/Mendeley's "Cite While You Write" plugins let you
// do when a search doesn't find the right paper, or you already know
// exactly what you want to cite: paste a DOI, paste a BibTeX/RIS entry, or
// upload a whole .bib/.ris file exported from another reference manager
// (see refparse.js for the parsing/DOI-detection and background.js's
// RESOLVE_DOI for the actual DOI lookup). Whatever's added here renders as
// an ordinary result row — citeBuildResultRow, the same one search results
// use — so Insert/Copy, the style dropdown, and the running References
// panel all work identically, and citing the same source once via search
// and once via a pasted DOI reuses the same citation number rather than
// creating a duplicate (both resolve to the same stable id in csl.js's
// registry — see lens81CitePaperId, which prefers DOI when available).
function citeBuildAddSourcePanel(defaultStyle, onCiteEvent) {
  const wrap = document.createElement('div');
  wrap.className = 'lens81-cite-addsrc';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'lens81-cite-addsrc-toggle';
  toggle.textContent = '+ Add a source manually';
  wrap.appendChild(toggle);

  const body = document.createElement('div');
  body.className = 'lens81-cite-addsrc-body';
  body.style.display = 'none';
  wrap.appendChild(body);

  const help = document.createElement('p');
  help.className = 'lens81-cite-addsrc-help';
  help.textContent =
    "Didn't find the right paper above? Paste a DOI, or a BibTeX/RIS entry, or upload a .bib/.ris file exported from EndNote, Mendeley, or Zotero.";
  body.appendChild(help);

  const textarea = document.createElement('textarea');
  textarea.className = 'lens81-cite-addsrc-input';
  textarea.rows = 3;
  textarea.placeholder = 'e.g. 10.1038/nature12373, or paste a BibTeX/RIS entry…';
  body.appendChild(textarea);

  const actionRow = document.createElement('div');
  actionRow.className = 'lens81-cite-addsrc-row';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = 'Add';
  actionRow.appendChild(addBtn);

  const fileLabel = document.createElement('label');
  fileLabel.className = 'lens81-cite-addsrc-file';
  fileLabel.textContent = 'Upload .bib/.ris';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.bib,.ris,.txt';
  fileInput.style.display = 'none';
  fileLabel.appendChild(fileInput);
  actionRow.appendChild(fileLabel);
  body.appendChild(actionRow);

  const status = document.createElement('div');
  status.className = 'lens81-cite-addsrc-status';
  body.appendChild(status);

  const addedList = document.createElement('div');
  addedList.className = 'lens81-cite-addsrc-results';
  body.appendChild(addedList);

  toggle.addEventListener('click', () => {
    const opening = body.style.display === 'none';
    body.style.display = opening ? 'block' : 'none';
    toggle.textContent = (opening ? '− ' : '+ ') + 'Add a source manually';
    if (opening) textarea.focus();
  });

  // Tracks identities (DOI, or normalized title when there's no DOI)
  // already rendered in *this* panel — pasting the same DOI twice, or
  // uploading a file that includes a paper already added, would otherwise
  // show confusing duplicate rows. This is purely a display dedupe; the
  // citation-numbering registry in csl.js already treats the same source
  // as one entry regardless of this (see lens81CitePaperId), so the only
  // thing at stake here is not cluttering this list, not correctness.
  const addedIdentities = new Set();
  function paperIdentity(paper) {
    if (paper.doi) return 'doi:' + paper.doi.trim().toLowerCase();
    return 'title:' + (paper.title || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  function renderPaper(paper) {
    // The panel can be removed from the page (popover closed) while a DOI
    // lookup is still in flight — appending to a detached node wouldn't
    // throw, but it's wasted work and, worse, would look like nothing
    // happened if the person reopened Cite and expected a clean panel.
    if (!wrap.isConnected) return;
    const identity = paperIdentity(paper);
    if (addedIdentities.has(identity)) {
      status.textContent = 'Already added.';
      return;
    }
    addedIdentities.add(identity);
    addedList.appendChild(citeBuildResultRow(paper, defaultStyle, onCiteEvent));
  }

  function handleParsedInput(text) {
    if (typeof parseReferenceInput !== 'function') {
      status.textContent = 'Manual entry is unavailable right now.';
      return;
    }
    const parsed = parseReferenceInput(text);

    if (parsed.kind === 'empty') {
      status.textContent = 'Paste a DOI or a BibTeX/RIS entry first.';
      return;
    }

    if (parsed.kind === 'doi') {
      status.textContent = `Looking up ${parsed.doi}…`;
      chrome.runtime.sendMessage({ type: 'RESOLVE_DOI', doi: parsed.doi }, (response) => {
        if (chrome.runtime.lastError || !response || !response.ok) {
          if (wrap.isConnected) {
            status.textContent = "Couldn't find a paper for that DOI. Double-check it, or paste a BibTeX/RIS entry instead.";
          }
          return;
        }
        if (!wrap.isConnected) return;
        const before = addedIdentities.size;
        renderPaper(response.paper);
        if (addedIdentities.size > before) {
          status.textContent = '';
          textarea.value = '';
        }
      });
      return;
    }

    if (parsed.kind === 'bibtex' || parsed.kind === 'ris') {
      if (parsed.papers.length === 0) {
        status.textContent = `That looked like ${parsed.kind.toUpperCase()}, but no title could be found in it.`;
        return;
      }
      const before = addedIdentities.size;
      parsed.papers.forEach(renderPaper);
      const added = addedIdentities.size - before;
      const skipped = parsed.papers.length - added;
      status.textContent =
        `Added ${added} source${added === 1 ? '' : 's'}.` + (skipped > 0 ? ` (${skipped} already added.)` : '');
      textarea.value = '';
      return;
    }

    status.textContent = "Didn't recognize that as a DOI or a BibTeX/RIS entry.";
  }

  addBtn.addEventListener('click', () => handleParsedInput(textarea.value));

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    status.textContent = `Reading ${file.name}…`;
    const reader = new FileReader();
    reader.onload = () => handleParsedInput(String(reader.result || ''));
    reader.onerror = () => {
      status.textContent = "Couldn't read that file.";
    };
    reader.readAsText(file);
    fileInput.value = '';
  });

  return wrap;
}

async function citeRenderResults(response, mode) {
  if (!citePopover) return;
  const pop = citePopover;
  pop.innerHTML = '';
  pop.classList.add('lens81-cite-pop-wide');

  const heading = document.createElement('div');
  heading.className = 'lens81-cite-pop-title';
  heading.textContent = mode === 'find' ? 'Related papers' : 'Citations found';
  pop.appendChild(heading);

  const note = citeSourceNote(response.source);
  if (note) {
    const noteEl = document.createElement('div');
    noteEl.className = 'lens81-cite-note';
    noteEl.textContent = note;
    pop.appendChild(noteEl);
  }

  const defaultStyle = await citeGetDefaultStyle();
  // The References panel and "Add a source manually" are citation-building
  // tools — tracking what's been cited so far and letting someone supply a
  // source search couldn't find. Find mode is exploratory discovery, not
  // building a reference list, so it skips both and keeps the popover
  // focused on the 3 results; each result's own Insert/Copy still works
  // exactly the same if the person decides to cite one of them.
  const refsPanel = mode === 'find' ? null : citeBuildReferencesPanel(defaultStyle);

  const list = document.createElement('div');
  list.className = 'lens81-cite-list';

  response.results.forEach((r) => {
    list.appendChild(citeBuildResultRow(r, defaultStyle, refsPanel ? refsPanel.refresh : null));
  });
  pop.appendChild(list);
  if (refsPanel) {
    pop.appendChild(refsPanel.el);
    pop.appendChild(citeBuildAddSourcePanel(defaultStyle, refsPanel.refresh));
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'lens81-cite-close';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', citeCloseAll);
  pop.appendChild(closeBtn);
}

function citeAuthorsLine(authors) {
  if (!authors.length) return 'Unknown authors';
  if (authors.length <= 2) return authors.join(', ');
  return `${authors[0]} et al.`;
}

// Opens the "All Citation Styles" page (cite-styles.html) with `paper`
// handed off via a one-shot chrome.storage.local key, since a paper's
// title/authors/venue can be long and awkward to encode reliably into a
// URL. Uses window.open() rather than chrome.tabs.create() because content
// scripts don't have access to the tabs API — this call happens inside a
// real user-initiated event handler (the dropdown's change event), so it
// isn't subject to popup-blocking.
//
// The handoff key includes a random nonce (passed to the new page via its
// own URL, not a fixed name) rather than one shared "citeAllStylesPaper"
// key: opening "More styles…" for one paper, then immediately opening it
// again for a *different* paper before the first tab finishes loading,
// would otherwise let the second write clobber the first before it's read
// — the first tab would silently show the second paper's citation instead
// of its own.
async function citeOpenAllStylesPage(paper) {
  const nonce = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const key = `citeAllStylesPaper:${nonce}`;
  try {
    await chrome.storage.local.set({ [key]: paper });
  } catch {
    // Fall through and open the page anyway — worst case it shows its own
    // "no paper" note rather than the citation, which is still recoverable.
  }
  const url = `${chrome.runtime.getURL('cite-styles.html')}?handoff=${encodeURIComponent(nonce)}`;
  window.open(url, '_blank');
}

// Resolves the citation text for one result in one style. BibTeX is a data
// format, not a CSL style — citeproc-js doesn't produce it — so it always
// uses background.js's hand-rolled formatter. For the four real styles,
// this tries the bundled CSL engine (csl.js, loaded alongside this file —
// see manifest.json) first, since it produces genuinely spec-compliant
// output rather than a hand-rolled approximation. If csl.js didn't load,
// the bundled style/locale files are missing, or citeproc-js throws for
// any reason, it falls back to background.js's pre-computed hand-rolled
// string for that style instead of failing the Insert/Copy action outright
// — the same "a new/enhanced path failing must never break the existing
// one" approach used throughout this extension.
async function citeGetCitationText(result, style) {
  if (style === 'bibtex') return result.citations.bibtex;

  if (typeof lens81FormatCitation === 'function') {
    try {
      const text = await lens81FormatCitation(result, style);
      if (text) return text;
    } catch {
      // fall through to the hand-rolled version below
    }
  }
  return result.citations[style] || '';
}

// What Insert/Copy actually use. BibTeX isn't an in-text citation format
// (it's a data format for reference managers), so it keeps inserting the
// full @article{} entry via citeGetCitationText above, unchanged. Every
// other style now inserts a short in-text marker — "(Jinek, 2012)",
// "[1]" — via csl.js's running per-page citation registry
// (lens81CiteInText), instead of the full reference: that's how citing a
// source while writing actually works, and it's what lets the numbering
// stay consistent with the running "References" list (see
// citeBuildReferencesPanel below) as more sources get cited.
//
// If csl.js isn't available or throws, this falls back to inserting the
// full hand-rolled reference via citeGetCitationText instead — not as
// good as a real in-text marker, but keeps Insert/Copy working rather
// than failing outright (same layered-fallback approach as
// citeGetCitationText's own CSL-then-hand-rolled fallback).
async function citeGetInsertableText(result, style) {
  if (style === 'bibtex') {
    return { text: await citeGetCitationText(result, style), retroactiveChanges: [] };
  }
  if (typeof lens81CiteInText === 'function') {
    try {
      const { text, retroactiveChanges } = await lens81CiteInText(result, style);
      if (text) return { text, retroactiveChanges };
    } catch {
      // fall through
    }
  }
  return { text: await citeGetCitationText(result, style), retroactiveChanges: [] };
}

// citeproc-js can retroactively change the rendered text of an *earlier*
// in-text citation as a side effect of a new one (see csl.js's file-level
// comment on lens81CiteInText for why — same-author-same-year
// disambiguation is the common case). This extension has no way to reach
// into whatever page/editor the citation was already inserted into and
// fix it, so instead of silently leaving the document inconsistent, this
// surfaces exactly what changed as a persistent, dismissible warning.
function citeShowRetroactiveWarning(pop, changes) {
  if (!pop || !changes.length) return;
  const existing = pop.querySelector('.lens81-cite-retro-warning');
  if (existing) existing.remove();

  const warn = document.createElement('div');
  warn.className = 'lens81-cite-retro-warning';

  const text = document.createElement('span');
  const shown = changes.slice(0, 3).map((c) => `"${c.oldText}" → "${c.newText}"`).join('; ');
  const more = changes.length > 3 ? `, and ${changes.length - 3} more` : '';
  text.textContent =
    `⚠️ This citation changed how ${changes.length} earlier citation${changes.length === 1 ? '' : 's'} ` +
    `on this page should read: ${shown}${more}. If already inserted, please update ${changes.length === 1 ? 'it' : 'them'} manually.`;
  warn.appendChild(text);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'lens81-cite-retro-dismiss';
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => warn.remove());
  warn.appendChild(dismiss);

  // Right after the heading/note, above the results list, so it's the
  // first thing visible rather than something that has to be scrolled to.
  const list = pop.querySelector('.lens81-cite-list');
  pop.insertBefore(warn, list || pop.firstChild);
}

// The running "References" list for whichever style is currently in
// focus — everything cited so far via citeGetInsertableText() above, on
// this page, in this style. Lets the person insert or copy the full,
// correctly-numbered/sorted reference list once, whenever they're ready
// for it (typically at the end of a document), rather than having to
// reassemble it by hand from individual Insert clicks. Reflects
// csl.js's registry directly, so it's always in sync with what's actually
// been cited — including retroactive disambiguation changes.
function citeBuildReferencesPanel(initialStyle) {
  const panel = document.createElement('div');
  panel.className = 'lens81-cite-refs-panel';

  const label = document.createElement('div');
  label.className = 'lens81-cite-refs-label';
  panel.appendChild(label);

  const actions = document.createElement('div');
  actions.className = 'lens81-cite-refs-actions';

  const insertBtn = document.createElement('button');
  insertBtn.type = 'button';
  insertBtn.textContent = 'Insert list';
  insertBtn.title = 'Insert the full reference list for everything cited so far in this style';
  actions.appendChild(insertBtn);

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = 'Copy';
  actions.appendChild(copyBtn);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'lens81-cite-refs-reset';
  resetBtn.title = 'Start a fresh reference list for this style on this page';
  resetBtn.textContent = '↺';
  actions.appendChild(resetBtn);

  panel.appendChild(actions);

  let currentStyle = initialStyle;
  const available = typeof lens81GetCitedCount === 'function' && typeof lens81GetRunningBibliography === 'function';

  function refresh(style) {
    currentStyle = style;
    if (style === 'bibtex') {
      label.textContent = 'Each BibTeX insert already includes the full entry, so no separate list is needed.';
      insertBtn.disabled = true;
      copyBtn.disabled = true;
      resetBtn.disabled = true;
      return;
    }
    if (!available) {
      label.textContent = 'Reference list unavailable (CSL engine failed to load).';
      insertBtn.disabled = true;
      copyBtn.disabled = true;
      resetBtn.disabled = true;
      return;
    }
    const count = lens81GetCitedCount(style);
    const styleLabel = style.toUpperCase();
    label.textContent =
      count > 0
        ? `${count} source${count === 1 ? '' : 's'} cited so far (${styleLabel})`
        : `No sources cited yet in ${styleLabel}`;
    insertBtn.disabled = count === 0;
    copyBtn.disabled = count === 0;
    resetBtn.disabled = count === 0;
  }

  async function getListText() {
    if (!available || currentStyle === 'bibtex') return '';
    try {
      const entries = await lens81GetRunningBibliography(currentStyle);
      return entries.join('\n\n');
    } catch {
      return '';
    }
  }

  insertBtn.addEventListener('click', async () => {
    const original = label.textContent;
    label.textContent = 'Formatting…';
    const text = await getListText();
    if (!text) {
      label.textContent = original;
      return;
    }
    const ok = await citeInsertText(text);
    label.textContent = ok ? 'References list inserted' : 'Copied, paste with Ctrl/Cmd+V';
    setTimeout(() => refresh(currentStyle), 1800);
  });

  copyBtn.addEventListener('click', async () => {
    const original = label.textContent;
    label.textContent = 'Formatting…';
    const text = await getListText();
    if (!text) {
      label.textContent = original;
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      label.textContent = 'Copied';
    } catch {
      label.textContent = 'Copy failed';
    }
    setTimeout(() => refresh(currentStyle), 1800);
  });

  resetBtn.addEventListener('click', () => {
    if (typeof lens81ResetInTextRegistry === 'function') lens81ResetInTextRegistry(currentStyle);
    refresh(currentStyle);
  });

  refresh(initialStyle);
  return { el: panel, refresh };
}

function citeBuildResultRow(result, defaultStyle, onCiteEvent) {
  const row = document.createElement('div');
  row.className = 'lens81-cite-row';

  const title = document.createElement('div');
  title.className = 'lens81-cite-row-title';
  title.textContent = result.title;
  row.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'lens81-cite-row-meta';
  const bits = [citeAuthorsLine(result.authors)];
  if (result.year) bits.push(String(result.year));
  if (result.venue) bits.push(result.venue);
  meta.textContent = bits.join(' · ');
  row.appendChild(meta);

  if (Number.isFinite(result.relevance)) {
    const rel = document.createElement('div');
    rel.className = 'lens81-cite-row-relevance';
    rel.textContent = `${result.relevance}% match${result.why ? ' · ' + result.why : ''}`;
    row.appendChild(rel);
  }

  const controls = document.createElement('div');
  controls.className = 'lens81-cite-row-controls';

  const select = document.createElement('select');
  select.className = 'lens81-cite-style-select';
  [
    ['apa', 'APA'],
    ['mla', 'MLA'],
    ['chicago', 'Chicago'],
    ['ieee', 'IEEE'],
    ['bibtex', 'BibTeX'],
  ].forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === defaultStyle) opt.selected = true;
    select.appendChild(opt);
  });
  const moreOpt = document.createElement('option');
  moreOpt.value = '__more__';
  moreOpt.textContent = 'More styles…';
  select.appendChild(moreOpt);
  controls.appendChild(select);

  const insertBtn = document.createElement('button');
  insertBtn.type = 'button';
  insertBtn.className = 'lens81-cite-insert-btn';
  insertBtn.title = 'Insert an in-text citation at your cursor (e.g. "(Jinek, 2012)" or "[1]")';
  insertBtn.textContent = 'Insert';
  controls.appendChild(insertBtn);

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'lens81-cite-copy-btn';
  copyBtn.title = 'Copy in-text citation';
  copyBtn.textContent = '📋';
  controls.appendChild(copyBtn);

  const status = document.createElement('span');
  status.className = 'lens81-cite-row-status';
  controls.appendChild(status);

  let citeLastRealStyleValue = select.value;
  select.addEventListener('change', () => {
    if (select.value === '__more__') {
      citeOpenAllStylesPage(result);
      select.value = citeLastRealStyleValue; // revert — this option is an action, not a real selection
      return;
    }
    citeLastRealStyleValue = select.value;
    citeSetDefaultStyle(select.value);
    if (onCiteEvent) onCiteEvent(select.value);
  });

  insertBtn.addEventListener('click', async () => {
    status.textContent = 'Formatting…';
    const { text, retroactiveChanges } = await citeGetInsertableText(result, select.value);
    const ok = await citeInsertText(text);
    status.textContent = ok ? 'Inserted' : 'Copied, paste with Ctrl/Cmd+V';
    if (retroactiveChanges.length) citeShowRetroactiveWarning(citePopover, retroactiveChanges);
    if (onCiteEvent) onCiteEvent(select.value);
    setTimeout(() => {
      status.textContent = '';
    }, 2500);
  });

  copyBtn.addEventListener('click', async () => {
    status.textContent = 'Formatting…';
    const { text, retroactiveChanges } = await citeGetInsertableText(result, select.value);
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = 'Copied';
    } catch {
      status.textContent = 'Copy failed';
    }
    if (retroactiveChanges.length) citeShowRetroactiveWarning(citePopover, retroactiveChanges);
    if (onCiteEvent) onCiteEvent(select.value);
    setTimeout(() => {
      status.textContent = '';
    }, 2000);
  });

  row.appendChild(controls);
  return row;
}

// --- Insertion ----------------------------------------------------------------
// Always writes the citation to the clipboard first, regardless of platform
// or whether the programmatic insert appears to succeed — since success
// can't be verified with full confidence on either path, this guarantees a
// manual Ctrl/Cmd+V always works as a fallback.

async function citeInsertText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard write failing isn't fatal — the programmatic insert below
    // may still work; only the "paste manually" fallback is lost.
  }

  if (CITE_IS_DOCS) return citeInsertIntoDocs(text);
  return citeInsertIntoPage(text);
}

function citeFocusDocsEditor() {
  const iframe = document.querySelector('.docs-texteventtarget-iframe');
  const target = iframe?.contentDocument?.activeElement || iframe?.contentDocument?.body;
  if (target && typeof target.focus === 'function') target.focus();
}

async function citeInsertIntoDocs(text) {
  try {
    citeFocusDocsEditor();
    // Docs' selection isn't a normal Range this extension can collapse
    // programmatically (see the file-level comment on CITE_IS_DOCS —
    // there's no real getSelection() to work with here at all), and
    // execCommand('paste') always replaces whatever's currently selected —
    // which, since the selection is still the highlighted claim the person
    // was citing, would otherwise delete that claim and leave only the
    // citation behind. Putting the claim's own text back on the clipboard
    // together with the citation means the paste *restores* the claim and
    // appends the citation, instead of replacing the claim with just the
    // citation.
    if (citeSavedText) {
      await navigator.clipboard.writeText(`${citeSavedText} ${text}`);
    }
    // execCommand('paste') is blocked for ordinary web pages, but content
    // scripts with the clipboardRead/clipboardWrite permissions declared in
    // manifest.json are allowed to use it — this is what actually lets the
    // citation land at the cursor instead of only sitting on the clipboard.
    return document.execCommand('paste');
  } catch {
    return false;
  }
}

function citeInsertIntoPage(text) {
  // Textarea/input: use the field saved at selection time, not
  // document.activeElement — by the time Insert is clicked, focus has
  // already moved to the popover's own button, so activeElement no longer
  // points at the field the person actually selected text in.
  if (citeSavedInputEl) {
    try {
      const el = citeSavedInputEl;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      // Insert right after whatever was highlighted, rather than replacing
      // it — the whole point of highlighting a claim was to find (and now
      // add) a citation *for* it, so the claim itself needs to survive the
      // insert, not be deleted and replaced by a citation marker. A leading
      // space keeps "claim(Smith, 2020)" from running together, but only
      // when there was an actual selection and the text doesn't already
      // end in whitespace.
      const hadSelection = end > start;
      const needsSpace = hadSelection && !/\s$/.test(el.value.slice(0, end));
      const insertion = (needsSpace ? ' ' : '') + text;
      el.focus();
      el.value = el.value.slice(0, end) + insertion + el.value.slice(end);
      el.selectionStart = el.selectionEnd = end + insertion.length;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  // contenteditable regions: refocus the actual editable element first —
  // clicking into the popover moved focus to one of its buttons, and
  // execCommand('insertText') can silently do nothing if the contenteditable
  // region isn't focused, even with a valid Range inside it — then restore
  // the selection we saved when the button first appeared, and insert.
  if (citeSavedRange) {
    try {
      if (citeSavedEditableRoot && typeof citeSavedEditableRoot.focus === 'function') {
        citeSavedEditableRoot.focus();
      }
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(citeSavedRange);
      // Same reasoning as the textarea path above: execCommand('insertText')
      // replaces whatever's currently selected, which is still the
      // highlighted claim — collapse to the end of it first so the citation
      // is added after the claim instead of replacing it.
      const hadSelection = !citeSavedRange.collapsed;
      sel.collapseToEnd();
      const insertion = (hadSelection ? ' ' : '') + text;
      if (document.execCommand('insertText', false, insertion)) return true;
    } catch {
      // fall through to "just copied" below
    }
  }

  // Not an editable spot at all (e.g. highlighting text on an article
  // you're reading, not writing) — clipboard write above is the real
  // result here; report that plainly instead of claiming an insert.
  return false;
}
