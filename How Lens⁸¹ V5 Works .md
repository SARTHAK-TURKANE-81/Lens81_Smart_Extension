# Lens⁸¹ v5 : How It Works

This document describes the version of the extension currently in this
conversation (the flat file set you last uploaded — referred to here as
**v5**, as distinct from the `lens81_v6.zip` bundle from earlier). It's a
technical walkthrough of each file and how they fit together, not a user
guide (see `README.md` for that).

## At a glance

Lens⁸¹ is a Manifest V3 Chrome extension that scans Google Scholar search
results, fetches each paper's abstract, sends it to one or more LLMs you
configure with your own API keys, and labels each result **Research** or
**Review**. A separate "Collections" feature lets you save papers into
local, playlist-like buckets and export them.

```
manifest.json
├─ background.js          service worker — the only part allowed to make
│                          network calls (abstract lookups + LLM calls)
├─ content.js              runs on scholar.google.com — finds results,
│                          shows badges, talks to background.js
├─ collections.js          shared storage/CRUD/export logic (no DOM)
├─ collections-content.js  in-page "Save to Collection" UI
├─ popup.html / popup.js   toolbar popup
├─ options.html / options.js  settings page (API key/model rows)
├─ collection.html / collection.js  full-page single-collection view
├─ mini-xlsx.js            hand-rolled .xlsx writer for Export
└─ styles.css              all visual styling (badges, panels, popovers)
```

## Execution contexts

Chrome extensions run code in several isolated "worlds." Understanding
which file runs where explains why some functions can call each other
directly and others must pass messages:

| Context | Files | Notes |
|---|---|---|
| Service worker (background) | `background.js` | No DOM. Only place with `host_permissions` network access to the abstract/LLM APIs. Can be killed and restarted by Chrome at any time. |
| Content script (on scholar.google.com) | `collections.js`, `collections-content.js`, `content.js` | Loaded in this order (see `manifest.json`), and **share one execution context per tab** — so `content.js` can call a function defined in `collections-content.js` directly, no messaging needed. This is why every function in these three files is prefixed `lens81*` (except `content.js`'s own top-level names) — to avoid colliding with each other in that shared scope. |
| Extension pages | `popup.html`, `options.html`, `collection.html` | Each is its own isolated page context. `popup.html` and `collection.html` both load `collections.js` + `mini-xlsx.js` directly (as `<script>` tags) so they can call the storage/export functions without messaging the background worker. |

Content scripts and the background service worker never share memory —
they only talk over `chrome.runtime.sendMessage` /
`chrome.runtime.onMessage`.

## Classification pipeline (background.js)

```
content.js sends {type: 'CLASSIFY_PAPER', title}
        │
        ▼
classifyPaper(title)
        │  1. checks chrome.storage.local cache (30-day TTL, keyed by
        │     normalized title)
        │  2. if cached and cache has the current { reason, details }
        │     shape, returns it immediately
        ▼
classifyUncached(title)
        │  wrapped in withOverallTimeout(..., 20s) so this can never
        │  hang the content script indefinitely
        ▼
fetchAbstract(title)
        │  Semantic Scholar and OpenAlex queried in PARALLEL
        │  (Promise.allSettled) — first usable abstract wins
        │  each result's title is checked against the query title
        │  with a similarity score (>= 0.6) before being trusted
        ▼
   ┌────┴─────┐
abstract found   no abstract
   │               │
classifyWithLLM   classifyTitleOnly
   │               │
   └──────┬────────┘
          ▼
callEnsembleClassifier(prompt)
        │  reads up to 5 (provider, key, model, onlyIfNeeded) rows from
        │  chrome.storage.local's `openrouterConfigs`
        │  "always" rows are called in parallel first;
        │  "only if needed" rows are only called if every "always" row
        │  failed
        ▼
runPairs() → callSingleModel() → callProviderChat()
        │  routes to callOpenRouterChat / callGeminiChat / callGrokChat
        │  based on that row's `provider` field
        ▼
ensemble(successes, attempts)
        │  averages research_probability / review_probability across
        │  every model that answered; produces {type, confidence,
        │  reason, details}
        ▼
result cached, returned to content.js
```

If every model fails (or none are configured), `heuristicClassify()` takes
over: a regex looks for words like "survey," "review," "systematic
review," "meta-analysis" in the title and guesses accordingly, at a fixed
55% confidence. This is also what runs while the "real" pipeline is still
in flight — see below.

### Per-provider request shapes

All three provider callers (`callOpenRouterChat`, `callGrokChat`,
`callGeminiChat`) always **resolve**, never reject — they return either
`{ ok: true, text }` or `{ ok: false, message }` — so `callSingleModel()`
can treat every provider identically regardless of which one failed.

- **OpenRouter / Grok**: both are OpenAI-compatible — `POST` to
  `.../chat/completions` with `Authorization: Bearer <key>` and a
  `messages` array.
- **Gemini**: different shape — `POST` to
  `.../v1beta/models/{model}:generateContent?key=<key>` with a
  `contents`/`parts` body. Also explicitly checks for a non-`STOP`
  `finishReason` (e.g. a safety block) so that case is distinguishable
  from a normal parse failure.

Every model response is expected to come back as compact JSON:
```json
{"prediction": "Research", "research_probability": 0.8, "review_probability": 0.2, "reason": "..."}
```
`parseModelOutput()` extracts the first `{...}` block from the response
text (models sometimes wrap JSON in prose despite instructions), validates
both probabilities are finite numbers, and normalizes them to sum to 1.

## On-page behavior (content.js)

1. `scan()` runs on load and again whenever the page mutates (Scholar
   re-renders results on pagination without a full navigation), via a
   debounced `MutationObserver`.
2. Each unprocessed `.gs_ri` result gets an instant **pending badge** —
   a dashed "Research?/Review?" guess from a title-keyword regex,
   available at 0ms, before any network call resolves.
3. `chrome.runtime.sendMessage({type: 'CLASSIFY_PAPER', title})` is sent
   to the background worker.
4. A **25-second watchdog** (`CLASSIFY_WATCHDOG_MS`) runs in parallel to
   the message callback. This is a second line of defense on top of
   `background.js`'s own 20-second internal timeout: if the service
   worker is killed mid-request and never calls `sendResponse` at all,
   Chrome logs "the message port closed" and the callback never fires —
   the watchdog is what still resolves that badge instead of leaving it
   stuck pulsing forever.
5. When a real result arrives, the pending badge is replaced with a
   confirmed badge. Clicking it opens a "why" panel showing the
   ensemble's reasoning and, per model, either its individual prediction
   or its failure reason (rate limited, timed out, bad response) — so a
   silently-failing model is visible instead of just missing from the
   list.
6. Regardless of outcome, `attachCollectionsControl()` is called — a
   paper can be saved to a collection even if classification failed
   entirely.

## Collections (collections.js / collections-content.js / collection.js)

A local-only, account-free way to group papers, independent of the
classification pipeline.

- **Storage shape** (all in `chrome.storage.local`):
  - One record per collection: `{ id, name, paperIds: [...] }`
  - One record per paper (deduplicated across collections), keyed by a
    stable id — a Google Scholar cluster id when the result URL has one,
    otherwise a normalized title.
  - A paper's storage record is only deleted once it belongs to zero
    collections; deleting a collection never deletes a paper saved
    elsewhere too.
- **collections.js** is pure logic — CRUD on collections/papers, and the
  CSV/JSON/BibTeX/Markdown row-building functions. It has no DOM code, so
  it's loaded identically by the content script and both extension pages.
- **collections-content.js** is the in-page UI layer: the "➕ Save" /
  "✔ Saved" button next to each badge, the inline checklist popover, and
  the "+ New Collection" form swapped into that same popover.
- **collection.js** drives the standalone `collection.html` page (opened
  via `chrome.tabs.create` from the popup): lists papers in one
  collection, and handles rename/delete/export for it.
- **Export** (CSV, JSON, BibTeX, Markdown, and `.xlsx` via
  `mini-xlsx.js`) is entirely local — no network call.

## Settings (options.js)

Renders exactly 5 fixed rows (`MAX_ROWS`), each independently able to
pick a provider (OpenRouter / Gemini / Grok). Switching a row's provider
clears its model field, since a model slug from one provider is
meaningless to another. All 5 rows are saved together as one array under
`openrouterConfigs` — the key name is legacy (the extension used to
support only OpenRouter) but now holds mixed-provider rows; a
single-pair `openrouterKey`/`openrouterModel` from very old installs is
migrated into row 1 automatically if `openrouterConfigs` doesn't exist
yet.

Each row's **Test** button sends `{type: 'TEST_KEY', provider, key,
model}` straight to the background worker, which fires one real,
minimal request at that provider — surfacing a bad key or a
wrong/retired model slug immediately, rather than the person only
discovering it later on a live Scholar page.

## Reliability details worth knowing

- **Every network call has its own timeout** (6s abstract lookups, 12s
  LLM calls, 8s Test button, 20s overall pipeline, 25s content-script
  watchdog) — nothing can hang a badge forever.
- **Per-tab Research/Review counts live in `chrome.storage.session`**,
  not a plain variable, because Chrome can unload the service worker
  whenever its tab isn't focused; a plain variable would reset to zero.
- **Cache entries are shape-checked on read** (`'reason' in entry.value`)
  so a result cached by an older version of the pipeline (before the
  ensemble "why" details existed) is treated as a miss and
  re-classified once, instead of showing an empty why-panel until the
  30-day TTL clears it.
