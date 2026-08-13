// content.js
// Runs on Google Scholar search-result pages. Finds each result, shows an
// instant title-based guess, asks the background worker to confirm it
// against the abstract, and swaps in the confirmed badge when it arrives.
// Clicking a confirmed badge expands a small panel explaining why — the
// ensemble's overall reasoning plus each individual model's own response.

const PROCESSED_ATTR = 'data-classifier-done';
const REVIEW_KEYWORDS = /\b(survey|review|systematic review|meta-analysis|overview of)\b/i;
// Slightly above background.js's own OVERALL_CLASSIFY_TIMEOUT_MS (20s), so
// the background worker's own fallback normally wins the race. This is a
// second line of defense for the rarer case where the service worker is
// killed mid-request and never calls sendResponse at all — Chrome then
// logs "the message port closed before a response was received" and the
// callback below simply never fires. Without this, that one paper's badge
// would be stuck pulsing "Research?/Review?" forever with no visible error
// to the person looking at the page.
const CLASSIFY_WATCHDOG_MS = 25000;

let openPanel = null;

function quickGuessType(title) {
  return REVIEW_KEYWORDS.test(title) ? 'Review' : 'Research';
}

function makeDot() {
  const dot = document.createElement('span');
  dot.className = 'dot';
  return dot;
}

// Shown the instant a title is read — before any network call resolves —
// so the page never sits there with nothing but a spinner.
function makePendingBadge(title) {
  const badge = document.createElement('span');
  const isReview = quickGuessType(title) === 'Review';
  badge.className = `paper-type pending low-confidence ${isReview ? 'review' : 'research'}`;
  badge.appendChild(makeDot());
  badge.appendChild(document.createTextNode(`${isReview ? 'Review' : 'Research'}?`));
  badge.title = 'Quick guess from the title, confirming against the abstract…';
  return badge;
}

function closeOpenPanel() {
  if (openPanel) {
    openPanel.panel.remove();
    openPanel.badge.classList.remove('open');
    openPanel = null;
  }
}

function makeResultBadge(result, resultEl) {
  const badge = document.createElement('span');
  const isReview = result.type === 'Review';
  badge.className = `paper-type clickable ${isReview ? 'review' : 'research'}`;
  const label = isReview ? 'Review' : 'Research';
  const confidence = Number.isFinite(result.confidence) ? ` · ${result.confidence}%` : '';
  badge.appendChild(makeDot());
  badge.appendChild(document.createTextNode(`${label}${confidence}`));

  const caret = document.createElement('span');
  caret.className = 'caret';
  badge.appendChild(caret);

  if (result.source === 'llm-title-only') {
    badge.title = 'No abstract was found for this paper. The AI classified it from the title alone. Click for details.';
    badge.classList.add('low-confidence');
  } else if (result.source === 'title-heuristic-all-failed') {
    badge.title = 'Every configured AI model failed to respond for this paper. Showing a keyword-only guess instead. Click for details.';
    badge.classList.add('low-confidence');
  } else if (result.source === 'title-heuristic') {
    badge.title = 'No abstract was found and no AI is configured. This is a keyword-only guess. Click for details.';
    badge.classList.add('low-confidence');
  } else {
    badge.title = 'Click to see why.';
  }

  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (openPanel && openPanel.badge === badge) {
      closeOpenPanel();
      return;
    }
    closeOpenPanel();
    if (typeof lens81CloseCollectPopover === 'function') lens81CloseCollectPopover();
    const panel = makeWhyPanel(result);
    resultEl.appendChild(panel);
    badge.classList.add('open');
    openPanel = { badge, panel };
  });

  return badge;
}

function pct(p) {
  return Number.isFinite(p) ? `${Math.round(p * 100)}%` : 'N/A';
}

// Shortens a long OpenRouter model slug (e.g. "anthropic/claude-3.5-sonnet")
// so it doesn't force the panel wider than the Scholar result card.
function shortModelName(model) {
  if (!model) return 'Model';
  const afterSlash = model.includes('/') ? model.split('/').slice(1).join('/') : model;
  return afterSlash.length > 34 ? `${afterSlash.slice(0, 31)}…` : afterSlash;
}

function makeWhyPanel(result) {
  const panel = document.createElement('div');
  panel.className = 'lens81-why';
  panel.addEventListener('click', (e) => e.stopPropagation());

  const summary = document.createElement('div');
  summary.className = 'lens81-why-summary';
  summary.textContent = result.reason || `Classified as ${result.type}.`;
  panel.appendChild(summary);

  const details = Array.isArray(result.details) ? result.details : [];

  if (details.length > 0) {
    const list = document.createElement('div');
    list.className = 'lens81-why-models';

    details.forEach((d) => {
      const row = document.createElement('div');
      row.className = 'lens81-why-model';

      const head = document.createElement('div');
      head.className = 'lens81-why-model-head';

      const name = document.createElement('span');
      name.className = 'lens81-why-model-name';
      name.textContent = shortModelName(d.model);
      name.title = d.model || '';
      head.appendChild(name);

      if (d.failed) {
        // A model that was attempted but never produced a usable result
        // (rate limited, timed out, bad response) — shown explicitly
        // rather than just quietly missing from the list, so a rate-limited
        // ":free" model or a typo'd model slug is visible instead of just
        // looking like "only one model exists."
        const pill = document.createElement('span');
        pill.className = 'paper-type mini error';
        pill.appendChild(makeDot());
        pill.appendChild(document.createTextNode('No response'));
        head.appendChild(pill);
        row.appendChild(head);

        const reasonEl = document.createElement('div');
        reasonEl.className = 'lens81-why-model-reason';
        reasonEl.textContent = d.message || 'This model failed to respond for this paper.';
        row.appendChild(reasonEl);

        list.appendChild(row);
        return;
      }

      const pill = document.createElement('span');
      const pillIsReview = d.prediction === 'Review';
      pill.className = `paper-type mini ${pillIsReview ? 'review' : 'research'}`;
      pill.appendChild(makeDot());
      const prob = pillIsReview ? d.review_probability : d.research_probability;
      pill.appendChild(document.createTextNode(`${d.prediction} · ${pct(prob)}`));
      head.appendChild(pill);

      row.appendChild(head);

      if (d.reason) {
        const reasonEl = document.createElement('div');
        reasonEl.className = 'lens81-why-model-reason';
        reasonEl.textContent = d.reason;
        row.appendChild(reasonEl);
      }

      list.appendChild(row);
    });

    panel.appendChild(list);
  } else if (result.source === 'title-heuristic') {
    const note = document.createElement('div');
    note.className = 'lens81-why-note';
    note.textContent = 'No AI model is configured, so this is a keyword-based guess rather than a model response.';
    panel.appendChild(note);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'lens81-why-close';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeOpenPanel();
  });
  panel.appendChild(closeBtn);

  return panel;
}

function makeUnavailableBadge() {
  const badge = document.createElement('span');
  badge.className = 'paper-type error';
  badge.appendChild(makeDot());
  badge.appendChild(document.createTextNode('unavailable'));
  return badge;
}

function extractTitle(h3) {
  // Google Scholar sometimes prefixes titles with tags like [PDF] or [BOOK].
  return h3.innerText.replace(/^\[[^\]]+\]\s*/, '').trim();
}

function processResult(resultEl) {
  if (resultEl.getAttribute(PROCESSED_ATTR)) return;

  const h3 = resultEl.querySelector('h3.gs_rt, h3');
  if (!h3) return;

  const title = extractTitle(h3);
  if (!title) return;

  // Mark as handled only once we know we have a usable title, so a
  // temporarily-empty node doesn't get skipped permanently.
  resultEl.setAttribute(PROCESSED_ATTR, '1');

  const pendingBadge = makePendingBadge(title);
  h3.appendChild(pendingBadge);

  let settled = false;

  // Collections is a separate, additive feature (see collections.js /
  // collections-content.js). It's attached after *every* outcome below —
  // not just a successful classification — so a paper can still be saved
  // into a collection even if the abstract lookup or every configured
  // model failed. `classification` is null in that case; downstream code
  // already treats a missing type/confidence as "unclassified".
  function attachCollections(classification) {
    if (typeof lens81AttachCollectionsControl === 'function') {
      lens81AttachCollectionsControl(h3, resultEl, lens81ExtractMeta(resultEl, h3, title, classification));
    }
  }

  const watchdog = setTimeout(() => {
    if (settled) return;
    settled = true;
    if (pendingBadge.isConnected) pendingBadge.replaceWith(makeUnavailableBadge());
    attachCollections(null);
  }, CLASSIFY_WATCHDOG_MS);

  chrome.runtime.sendMessage({ type: 'CLASSIFY_PAPER', title }, (response) => {
    if (settled) return; // the watchdog already gave up and replaced the badge
    settled = true;
    clearTimeout(watchdog);

    if (chrome.runtime.lastError || !response) {
      pendingBadge.replaceWith(makeUnavailableBadge());
      attachCollections(null);
      return;
    }
    if (response.error) {
      pendingBadge.replaceWith(makeUnavailableBadge());
      attachCollections(null);
      return;
    }
    pendingBadge.replaceWith(makeResultBadge(response, resultEl));
    attachCollections(response);
  });
}

function scan() {
  document.querySelectorAll('.gs_ri').forEach(processResult);
}

// Google Scholar's DOM can settle a little after the initial load, and
// pagination re-renders results without a full navigation in some cases,
// so watch for changes instead of scanning only once.
let scanTimer = null;
function scheduleScan() {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    scan();
  }, 150);
}

scheduleScan();
new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });

// Clicking anywhere outside an open panel closes it, same as any other
// dropdown/popover on the page. (Scrolling does NOT close it — the panel is
// inline in the page flow, not a floating overlay, so it scrolls naturally
// with the page; auto-closing on scroll would only get in the way of
// reading a panel taller than the viewport.)
document.addEventListener('click', closeOpenPanel);
