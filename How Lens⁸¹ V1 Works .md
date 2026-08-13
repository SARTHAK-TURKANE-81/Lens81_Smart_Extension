# How Lens⁸¹ V1 Works

A step-by-step walkthrough of the pipeline, the browser APIs each step relies on, and the external services involved — with links to the actual documentation for anything you might want to verify or extend.

## Overview

```
Google Scholar results page
        │  content.js reads each result's title, shows an instant
        │  title-keyword guess immediately
        ▼
chrome.runtime.sendMessage  ───────────────►  background.js (service worker)
                                                     │
                                                     │  1. check chrome.storage.local cache
                                                     ▼
                                    Semantic Scholar  +  OpenAlex   (queried in parallel)
                                                     │
                                                     │  2. abstract found (or not)
                                                     ▼
                                          OpenRouter chat completion
                                          (your own API key + model)
                                                     │
                                                     │  3. {"type": "...", "confidence": N}
                                                     ▼
                                          cached + sent back to content.js
        ◄────────────────────────────────────────────
        │
        ▼
Badge swapped in next to the title; toolbar icon count updated
```

## 1. Reading the page

`content.js` is a [content script](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts), declared in `manifest.json` to run only on `https://scholar.google.com/*` at `document_idle` — after the DOM is built but without waiting for every subresource. It has no special permissions of its own; it can read and modify the page's DOM, and talk to the rest of the extension only through message passing.

Google Scholar doesn't re-render the whole page on every interaction, so the script also sets up a [`MutationObserver`](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver) to catch results that get added to the DOM after the initial scan, debounced by 150ms so a burst of DOM changes doesn't trigger a scan storm.

For each result, it reads the title and immediately renders a dashed, low-confidence badge based on a simple keyword regex (`survey`, `review`, `meta-analysis`, etc.) — this is what makes the page feel instant even though the real answer takes a moment to arrive.


A step-by-step walkthrough of the pipeline, the browser APIs each step relies on and the external services involved — with links to the actual documentation for anything you might want to verify or extend.

## Overview

```
Google Scholar results page
        │  content.js reads each result's title, shows an instant
        │  title-keyword guess immediately
        ▼
chrome.runtime.sendMessage  ───────────────►  background.js (service worker)
                                                     │
                                                     │  1. check chrome.storage.local cache
                                                     ▼
                                    Semantic Scholar  +  OpenAlex   (queried in parallel)
                                                     │
                                                     │  2. abstract found (or not)
                                                     ▼
                                          OpenRouter chat completion
                                          (your own API key + model)
                                                     │
                                                     │  3. {"type": "...", "confidence": N}
                                                     ▼
                                          cached + sent back to content.js
        ◄────────────────────────────────────────────
        │
        ▼
Badge swapped in next to the title; toolbar icon count updated
```

## 1. Reading the page

`content.js` is a [content script](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts), declared in `manifest.json` to run only on `https://scholar.google.com/*` at `document_idle` — after the DOM is built but without waiting for every subresource. It has no special permissions of its own; it can read and modify the page's DOM, and talk to the rest of the extension only through message passing.

Google Scholar doesn't re-render the whole page on every interaction, so the script also sets up a [`MutationObserver`](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver) to catch results that get added to the DOM after the initial scan, debounced by 150ms so a burst of DOM changes doesn't trigger a scan storm.

For each result, it reads the title and immediately renders a dashed, low-confidence badge based on a simple keyword regex (`survey`, `review`, `meta-analysis`, etc.) — this is what makes the page feel instant even though the real answer takes a moment to arrive.

## 2. Talking to the background worker

The content script sends a `CLASSIFY_PAPER` message via [`chrome.runtime.sendMessage`](https://developer.chrome.com/docs/extensions/reference/api/runtime#method-sendMessage). `background.js` is the extension's [Manifest V3 service worker](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3) — unlike the old "background page" model, it isn't kept running continuously; Chrome starts it to handle an event and can shut it down when idle. That's why per-tab counters live in `chrome.storage.session` rather than a plain variable — a plain variable would be wiped the moment the worker is recycled.

## 3. Checking the cache

Before doing any network work, `background.js` checks [`chrome.storage.local`](https://developer.chrome.com/docs/extensions/reference/api/storage) for a cached result, keyed by the normalized title. Entries expire after 30 days. This is what makes revisiting a search free — no repeat abstract lookups or LLM calls for a title already seen.

## 4. Finding the abstract

Google Scholar doesn't expose abstracts in its search results HTML, so Lens⁸¹ looks the title up against two free scholarly metadata APIs, **in parallel** (via `Promise.allSettled`, so a slow or failing one doesn't hold up the other):

- **[Semantic Scholar Academic Graph API](https://api.semanticscholar.org/api-docs/)** — queried via `/graph/v1/paper/search`, which returns a plain-text `abstract` field directly. This is the primary source.
- **[OpenAlex](https://docs.openalex.org/api-entities/works/search-works)** — queried via `/works?search=`, used as a fallback. OpenAlex doesn't return plain-text abstracts; for legal reasons it returns an [`abstract_inverted_index`](https://docs.openalex.org/api-entities/works/work-object) — a map of each word to the positions it appears at — which `background.js` reconstructs into ordinary text.

Both lookups are unauthenticated and free, and both are subject to public rate limits, which is part of why results are cached aggressively.

Whichever source responds first with a usable abstract is checked against the original title with a simple similarity function before being trusted, to reduce the odds of classifying the wrong paper on an ambiguous or very common title.

Each request has a 6-second timeout via [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController), so a stalled request can't leave a badge stuck indefinitely — if both sources time out or come back empty, the extension falls back to the same title-keyword heuristic used for the instant guess, just marked as lower confidence.

## 5. Classifying with an LLM

If an abstract was found, `background.js` sends it — along with the title — to [OpenRouter](https://openrouter.ai/docs), a single API that can route a request to hundreds of underlying models. This is the one part of the pipeline where **you** supply the credentials: your API key and chosen model slug are stored locally and used only in requests to `openrouter.ai`.

The request is a standard OpenAI-compatible call to [`/api/v1/chat/completions`](https://openrouter.ai/docs/quickstart), with a prompt asking for strict JSON back:

```json
{"type": "Research Paper" | "Review Paper", "confidence": 0-100}
```

The response is parsed defensively — if the model wraps the JSON in extra text or the call fails or times out (12-second limit), the extension falls back to the heuristic rather than surfacing an error. You can see and change which model is used at any time from the Settings page; the full current catalog is at [openrouter.ai/models](https://openrouter.ai/models).

## 6. Caching and reporting back

The result — `{ type, confidence, source }` — is written back to `chrome.storage.local` and returned to the content script, which swaps the pending badge for the final one. `background.js` also increments a running per-tab tally in `chrome.storage.session` and updates the toolbar badge via [`chrome.action.setBadgeText`](https://developer.chrome.com/docs/extensions/reference/api/action).

## 7. The popup and settings page

The popup uses [`chrome.tabs.query`](https://developer.chrome.com/docs/extensions/reference/api/tabs) (with the `activeTab` permission, so it can see the current tab's URL) to check whether you're on a Scholar page, then asks the background worker for that tab's running Research/Review counts. The settings page reads and writes your OpenRouter key and model slug directly to `chrome.storage.local`, and its **Test connection** button sends one real, minimal request through OpenRouter so a bad key or mistyped model slug surfaces immediately rather than failing silently later.

## Permissions, and why each one is there

| Permission | Why |
|---|---|
| `storage` | Caching results, storing your API key/model, per-tab counters ([docs](https://developer.chrome.com/docs/extensions/reference/api/storage)) |
| `activeTab` | Lets the popup check if the current tab is a Scholar page ([docs](https://developer.chrome.com/docs/extensions/reference/permissions-list)) |
| `host_permissions` for `api.semanticscholar.org`, `api.openalex.org`, `openrouter.ai` | The only three external domains the extension ever talks to |

## Where your data goes

- Your **OpenRouter API key** is sent only to `openrouter.ai`, in the `Authorization` header of classification and test requests. It never leaves your browser otherwise.
- **Paper titles and abstracts** are sent to Semantic Scholar, OpenAlex (both to look up the abstract), and OpenRouter (to classify it).
- Nothing is sent to any server the extension's author controls...there isn't one.
