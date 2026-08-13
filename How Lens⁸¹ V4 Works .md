# Lens⁸¹ : Technical Documentation (v4)

This document explains how Lens⁸¹ actually works internally: the
classification pipeline, the multi-model ensemble, the Collections feature,
storage layout, message flow, and every file's responsibility. It's aimed at
anyone maintaining or extending the extension, not at end users (see
`README.md` for the user-facing quick start).

> **What's new in v4:** the Collections feature (save papers into
> Spotify/YouTube-playlist-style buckets, with CSV/Excel export), a real
> extension icon, and a fix to the classifier's failure reporting so a
> rate-limited or misconfigured model is surfaced honestly instead of
> looking identical to "no AI configured."

---

## 1. What it does, end to end

1. You open a Google Scholar search-results page.
2. `content.js` scans the page for result blocks and, for each one,
   instantly shows a dashed "guess" badge based on a title keyword check
   (0ms — no network call yet).
3. It asks `background.js` (the service worker) to classify the paper
   properly. That takes one of two paths depending on whether an abstract
   can be found:
   - **Abstract found:** the title + abstract are sent to every configured
     OpenRouter model in parallel; their predictions are averaged into an
     ensemble result.
   - **No abstract found:** the title alone is sent to the same models
     (title-only prompt), or if no models are configured at all, a fixed
     keyword regex decides.
4. The dashed guess badge is swapped for the real badge (cyan = Research,
   amber = Review) with a confidence percentage. Clicking it opens a "why"
   panel showing the ensemble's reasoning and each individual model's own
   response (or, honestly, which ones failed).
5. You can click **➕ Save** next to any confirmed badge to file that paper
   into one or more Collections — lightweight, local-only playlists for
   papers, with no citation management, no PDFs, no sync.
6. The toolbar popup shows a running Research/Review count for the current
   tab, plus a Collections section with counts and export shortcuts.

---

## 2. File map

| File | Runs where | Responsibility |
|---|---|---|
| `manifest.json` | — | MV3 config: permissions, content script registration, popup/options pages, icons |
| `background.js` | Service worker | Message routing, abstract lookup, caching, the OpenRouter ensemble, per-tab badge counts |
| `content.js` | `scholar.google.com` | Scans the page, renders badges, the "why" panel |
| `collections.js` | Content script + `popup.html` + `collection.html` | Shared storage/CRUD/export layer for Collections — the only file that touches `chrome.storage.local` for collections/papers |
| `collections-content.js` | `scholar.google.com` (content script) | The in-page Save button, the "Save to Collection" popover, the New Collection form, the folder chip |
| `mini-xlsx.js` | `popup.html` + `collection.html` | Dependency-free `.xlsx` writer used by Export |
| `popup.html` / `popup.js` | Toolbar popup | Setup status, per-tab stats, Collections list, Export All |
| `options.html` / `options.js` | Settings page | Up to 5 OpenRouter (key, model) rows, per-row Test, cache clearing |
| `collection.html` / `collection.js` | Standalone tab | Single-collection view: paper list, rename, delete, per-collection export |
| `styles.css` | `scholar.google.com` (content script) | All badge, "why" panel, and Collections UI styling |
| `icons/icon{16,32,48,128}.png` | — | Toolbar/extension icon at every required size |

Three files are loaded together as the content script, in this exact order
(see `manifest.json`), because they share one JavaScript execution context
on the page — a function or variable declared in one is directly callable
from the next without any message passing:

```
collections.js  →  collections-content.js  →  content.js
```

---

## 3. The classification pipeline (`background.js`)

### 3.1 Entry point and caching

Every request from `content.js` goes through `classifyPaper(title)`:

```
classifyPaper(title)
  → cache lookup (chrome.storage.local, key = "classify:" + normalize(title))
  → cache hit?  return it immediately, no network calls at all
  → cache miss? run classifyUncached(title) with a 20s overall ceiling
                (OVERALL_CLASSIFY_TIMEOUT_MS), then cache whatever comes back
```

Cache entries last 30 days (`CACHE_TTL_MS`) and are keyed only by the
normalized title — not by which models are configured. **This means a
result cached before you added or changed a model stays stuck until it
expires or you hit "Clear cache" in Settings.** This is the most common
cause of "why does this paper still show a keyword guess" — the fix is
almost always to clear the cache, not to change any code.

A cache entry is also treated as a miss (and silently reclassified) if it's
missing the `reason`/`details` fields — this is how an older cache format
from before the "why" panel existed gets upgraded automatically instead of
showing an empty panel forever.

### 3.2 The 20-second ceiling

`withOverallTimeout()` races the real classification pipeline against a
20-second timer. Whichever finishes first wins; if the timer wins, the
keyword heuristic (`heuristicClassify`) is used instead — not because the
AI failed, but because the *combined* worst case of abstract lookup + LLM
call could otherwise run long enough that Chrome tears down the message
channel back to `content.js` entirely (`"the message port closed before a
response was received"`), which would leave the badge stuck on "checking…"
forever with no way to recover. This is a safety ceiling, not a retry — the
loser promise isn't cancelled, it just gets ignored (its own internal
timeouts still clean it up).

`content.js` has its own, slightly longer, independent 25-second watchdog
(`CLASSIFY_WATCHDOG_MS`) as a second line of defense for the rarer case
where the service worker itself gets killed mid-request and never calls
`sendResponse` at all.

### 3.3 Abstract lookup

`fetchAbstract(title)` queries **Semantic Scholar and OpenAlex in
parallel** (`Promise.allSettled`, 6s timeout each) — not sequentially,
which used to roughly double the wait on any paper Semantic Scholar didn't
have. Whichever answers first with a usable abstract wins.

Both sources are guarded by `titleSimilarity()` — a crude but effective
check (exact match, substring containment, or token overlap) that rejects
a result if the returned paper's title is too dissimilar from what was
searched for (threshold: 0.6). This exists because a generic title can
accidentally pull back the wrong paper's abstract; without this check the
extension would occasionally classify the wrong paper entirely.

OpenAlex stores abstracts as an inverted index (`{word: [positions...]}`)
rather than plain text, so `reconstructAbstract()` rebuilds the original
sentence from that structure.

### 3.4 The two classification prompts

- **`buildAbstractPrompt(title, abstract)`** — used when an abstract was
  found. Asks for exactly one of "Research Paper"/"Review Paper" plus
  probabilities and a one-sentence reason, as compact JSON.
- **`buildTitleOnlyPrompt(title)`** — used when no abstract could be
  found. Explicitly tells the model no abstract is available and asks it
  to reflect *reduced* certainty in the probabilities it returns. Results
  from this path are labeled `source: 'llm-title-only'` end to end so the
  UI can show a "no abstract was found" tooltip rather than presenting it
  with the same confidence as an abstract-verified result.

### 3.5 The multi-model ensemble

Up to 5 `(key, model, onlyIfNeeded)` tuples can be configured on the
Settings page. `getConfiguredPairs()` reads them from
`chrome.storage.local.openrouterConfigs`, and also transparently falls back
to the legacy single `openrouterKey`/`openrouterModel` fields for any
install that hasn't opened Settings since the multi-model update — no
migration step required.

```
callOpenRouterClassifier(prompt)
  ├─ pairs.length === 0 ?  → return null  ("nothing is configured")
  ├─ run every "always" pair in parallel (Promise.allSettled)
  ├─ any succeeded?  → done, use those
  └─ none succeeded AND a fallback ("only if needed") pair exists?
       → run the fallback pair(s) too, merge into the same attempt list
```

Each individual call goes through `callSingleModel(key, model, prompt)`,
which **never throws** — every possible outcome (success, HTTP error,
rate limit, malformed JSON, timeout, network error) resolves to a plain
attempt record instead of rejecting:

```js
// success
{ model, ok: true, prediction, research_probability, review_probability, reason }

// failure (any kind)
{ model, ok: false, message }   // e.g. "Rate limited (…)", "Timed out.",
                                 // "Response wasn't in the expected format."
```

`runPairs()` collects **every** attempt, not just the successful ones —
this is the key design point that makes partial failures visible instead
of silently invisible (see §3.6).

`ensemble(successes, attempts)` then:
- Averages `research_probability`/`review_probability` across only the
  *successful* attempts to pick the final type and confidence.
- Builds a one-line `reason` that explicitly says how many of the
  responding models agreed, and — if any failed — how many of how many
  configured models failed to respond.
- Builds `details`, one entry per **attempted** model (success or
  failure), via `attemptToDetail()` — this is what powers the "why" panel's
  per-model breakdown.

### 3.6 Why "no AI configured" and "all your models failed" are different now

Before this was fixed, `callOpenRouterClassifier()` returned `null` in two
completely different situations — zero models configured, or every
configured model failing for that specific paper — and both fell through
to the exact same keyword-heuristic fallback with the same message ("No AI
model is configured…"), even when models genuinely were configured. On top
of that, failed model attempts were silently dropped, so if 2 of 3
configured models failed, the "why" panel only ever showed the one that
worked — indistinguishable from having only ever configured one model.

`heuristicClassify(title, callResult)` now branches on whether
`callResult` carries any attempts:

| Situation | `source` | What the "why" panel shows |
|---|---|---|
| Zero models configured at all | `title-heuristic` | A note: "No AI model is configured…" and no per-model rows (there's nothing to show) |
| Models configured, all failed for this paper | `title-heuristic-all-failed` | Every failed attempt, each with its own reason (rate limited / timed out / bad response) |
| At least one model succeeded | `llm` or `llm-title-only` | Every attempted model — successes with their prediction, failures (if any) still shown as a grey "No response" row with a reason |

The most common real-world cause of "only one model is responding" despite
configuring several is a **`:free`-suffixed OpenRouter model** — these cap
out around 20 requests/minute, so on any results page with more papers
than that, they start failing partway through while other configured
models keep succeeding. The Settings page already warns against these;
the "why" panel is now where you'd actually see it happening.


### 3.7 Per-tab counters and the toolbar badge

`recordStat()` increments a `{research, review, total}` counter kept in
`chrome.storage.session` (not a plain JS variable) under
`tabstats:<tabId>`, specifically because Chrome can suspend and restart the
service worker at any time — including just from switching away from the
tab — and a plain in-memory variable would reset to zero when that
happens. The toolbar badge text (the small number on the extension icon)
is updated via `chrome.action.setBadgeText`/`setBadgeBackgroundColor` each
time; `chrome.tabs.onUpdated` clears both the stored stats and the badge
whenever a tab starts a fresh navigation (`changeInfo.status === 'loading'`).

### 3.8 `TEST_KEY` — the Settings page's per-row Test button

`testKey(key, model)` sends one minimal real request through OpenRouter
(`"Reply with the single word: ok"`, 8s timeout) so a bad key or mistyped
model slug is caught immediately on the Settings page, rather than only
surfacing later as a silent per-paper failure on a Scholar results page.

---

## 4. The content script (`content.js`)

### 4.1 Scanning the page

`scan()` runs `document.querySelectorAll('.gs_ri').forEach(processResult)`.
It's triggered once on load and again — debounced 150ms via
`scheduleScan()` — every time a `MutationObserver` on `document.body`
notices a DOM change, because Google Scholar's pagination re-renders
results without a full page navigation in some cases. Each result element
gets a `data-classifier-done` attribute the first time it's processed, so
re-scans are cheap no-ops for anything already handled.

### 4.2 Per-result flow

```
processResult(resultEl)
  → extract the title from h3.gs_rt (stripping "[PDF]"/"[BOOK]" prefixes)
  → render the instant dashed guess badge (title-keyword check, 0ms)
  → start a 25s watchdog timer
  → send {type: 'CLASSIFY_PAPER', title} to background.js
  → whichever settles first — the real response, or the watchdog — wins;
    the other is ignored
  → swap the pending badge for the real one (or an "unavailable" badge)
  → attach the Collections Save control regardless of outcome
```

The badge itself (`makeResultBadge`) reflects the result's `source`:
- `llm-title-only` → dashed border, tooltip explains no abstract was found
- `title-heuristic` → dashed border, tooltip says nothing is configured
- `title-heuristic-all-failed` → dashed border, tooltip says every
  configured model failed for this paper
- anything else (`llm`) → solid border, normal "click to see why" tooltip

### 4.3 The "why" panel

Clicking a confirmed badge opens an inline panel (appended directly into
the result's own DOM element, not a floating overlay — it scrolls
naturally with the page). It shows the ensemble's one-line `reason`, then
one row per attempted model: a compact prediction pill for anything that
succeeded, or a grey "No response" pill with the specific failure message
for anything that didn't. Opening this panel closes any open Collections
popover first (see §5), and vice versa — only one of the two is ever open
at a time.

---

## 5. Collections (`collections.js` + `collections-content.js` + `collection.html`/`.js`)

A lightweight, local-only way to file papers into project buckets —
modeled on Spotify/YouTube playlists, deliberately **not** a reference
manager: no citations, no PDFs, no accounts, no sync, no cloud.

### 5.1 Storage shape

Everything lives in `chrome.storage.local`, separate from the
classification cache:

```
lens81_collections = {
  "<collectionId>": {
    id, name, createdAt,
    paperIds: [ "<paperId>", ... ]
  }
}

lens81_paper:<paperId> = {
  id, title, authors, url, type, confidence, savedAt,
  collectionIds: [ "<collectionId>", ... ]
}
```

Two design choices worth calling out:

- **Each paper is its own storage key** (`lens81_paper:<id>`), not one big
  blob of all papers. `chrome.storage.local.get()` accepts an array of
  keys, so a Scholar page only ever reads the specific paper records it
  actually needs instead of loading every saved paper on every visit.
- **A paper's record only ever exists while it belongs to at least one
  collection.** The moment its `collectionIds` becomes empty (the last
  collection it was in gets it removed, or that collection is deleted), the
  whole `lens81_paper:<id>` key is deleted outright — storage never
  accumulates orphaned records.

### 5.2 Paper identity

`lens81GetPaperId(meta)` picks the most stable identifier available, in
order:
1. `meta.id`, if the caller already has a stored record (avoids ever
   recomputing an id for something already in storage).
2. A DOI, if one is ever supplied (Scholar's result markup doesn't expose
   one directly, so this is mostly a hook for future use).
3. A Google Scholar cluster/cites id pulled out of the result URL
   (`?cluster=` or `?cites=`), when present — stable across repeat visits
   regardless of title formatting quirks.
4. Otherwise, a normalized title (`title:<lowercased, whitespace-collapsed
   title>`) — the same normalization the classifier cache already uses.

### 5.3 Write serialization

Every mutation (`lens81CreateCollection`, `lens81RenameCollection`,
`lens81DeleteCollection`, `lens81TogglePaperInCollection`) is a
read-modify-write of the single `lens81_collections` object. Without
serializing them, two mutations fired close together — e.g. rapidly
checking two different collection checkboxes for the same paper in the
Save popover — could each read the "before" state and the second write
would silently clobber the first. `lens81Enqueue()` chains every mutation
onto one promise so they always run strictly one at a time, in call order,
regardless of how quickly the UI fires them.

### 5.4 In-page UI (`collections-content.js`)

Once a badge is confirmed (success, all-failed, or unavailable — see
§4.2), a **➕ Save** control is attached next to it. Clicking it opens a
small popover, appended inline into the result's own DOM (same pattern as
the "why" panel — no floating-overlay position math):

```
Save to Collection
☐ Thesis
☑ Literature Review
+ New Collection
```

- Checking/unchecking a box toggles membership **instantly** — no Save
  button, no confirmation step.
- **+ New Collection** swaps the popover's content for a small inline name
  form (not a native `prompt()`, not a separate dialog). Submitting it
  creates the collection (rejecting empty or duplicate names,
  case-insensitively) and immediately saves the current paper into it.
- Once a paper belongs to at least one collection, the button becomes
  **✔ Saved** and a folder chip appears beside it
  (`📁 Thesis • Read Later`) — including on a fresh page load, since this
  is read straight from storage rather than any in-page state.
- Clicking outside the popover, or opening a "why" panel, closes it.

### 5.5 Toolbar popup (`popup.js`) and the collection view (`collection.js`)

The popup's Collections section lists every collection with its paper
count, a **+ New Collection** shortcut, and **⬇ Export All**. Clicking a
collection opens `collection.html?id=<id>` in a new tab — a full page
(not a cramped popup) listing every paper in it (Research/Review badge,
title linking to the original Scholar result, Open/Remove buttons), plus
rename, delete, and a per-collection export.

Deleting a collection removes it and, for each paper that was in it,
drops that one collection id from the paper's `collectionIds` — the paper
itself is only actually deleted from storage if that was its *last*
remaining collection. Renaming rejects duplicate names the same way
creation does, and shows the error inline rather than silently reverting.

The collection page closes itself after a confirmed delete via
`chrome.tabs.getCurrent()` + `chrome.tabs.remove()`, rather than
`window.close()` alone — browsers can restrict `window.close()` for tabs a
script didn't open itself via `window.open()`, which is exactly the case
here since the tab was opened by the popup via `chrome.tabs.create()`.

### 5.6 Export (`mini-xlsx.js`)

Both the popup ("Export All") and the collection page ("Export
Collection") support CSV and Excel. `lens81BuildExportRows()` reads
straight from storage (`chrome.storage.local.get(null)`, filtered by the
`lens81_paper:` prefix) and needs no separate export index — every paper
already lists its own collections, and every collection already lists its
own papers. Each row: Collection(s), Title, Authors, Classification,
Confidence, Google Scholar URL, Date Saved.

- **CSV** — plain text, UTF-8 BOM prefix (so Excel doesn't mangle
  non-ASCII author names), proper quoting for embedded commas/quotes/
  newlines.
- **Excel (`.xlsx`)** — built by `mini-xlsx.js`, a small dependency-free
  writer rather than a vendored third-party library (the extension ships
  as unpacked source with no build step and no runtime network access, so
  "vendoring a library" would mean checking its entire source into the
  repo). It hand-rolls the handful of OOXML XML parts a single-sheet
  workbook needs (`workbook.xml`, one worksheet, a minimal `styles.xml`
  with a bold header row and a frozen top row) and packs them into a
  **store-method** (uncompressed) ZIP — fully valid per spec, just not
  space-optimized, which is a non-issue at this scale. Verified to open
  cleanly in Excel, Google Sheets, and LibreOffice Calc.

Both export buttons flash a transient "✓ Exported N" (or "Nothing to
export yet") on the button itself after completing, using the row count
`lens81ExportCollection()` returns.

---

## 6. Settings page (`options.html` / `options.js`)

Up to 5 rows, each an OpenRouter `(key, model, onlyIfNeeded)` tuple, backed
by `chrome.storage.local.openrouterConfigs` (an array). Row 1 is
"Required", rows 2–5 "Optional" — the extension works with just one row
configured; more rows means the ensemble averages more models' opinions.

- **Test** (per row) sends a real minimal request through
  `background.js`'s `testKey()` so a bad key or a mistyped model slug is
  caught immediately, not silently on a Scholar page later.
- **"Only use this key if the others fail"** marks a row as a fallback —
  held back and only called if every non-fallback row failed for that
  specific paper (see §3.5). This is a one-at-a-time backup chain, not
  "always include this model too" — worth double-checking if you expected
  a checked-fallback row to always contribute to the ensemble and it
  doesn't seem to.
- **Clear cache** removes every `classify:*` key from
  `chrome.storage.local` — the fix for stale results after changing your
  model configuration (see §3.1).
- Legacy installs with a single `openrouterKey`/`openrouterModel` pair
  (from before multi-model support existed) are migrated into row 1 on
  load; saving once switches the source of truth to `openrouterConfigs`
  going forward.

---

## 7. Message-passing summary

All `chrome.runtime.sendMessage` traffic goes from `content.js`/`popup.js`
to `background.js`:

| `type` | Sent by | Handled by | Returns |
|---|---|---|---|
| `CLASSIFY_PAPER` | `content.js`, once per result | `classifyPaper()` | The full classification result (`type`, `confidence`, `source`, `reason`, `details`) |
| `GET_TAB_STATUS` | `popup.js`, on open | `getTabStats()` | `{research, review, total}` for the active tab |
| `TEST_KEY` | `options.js`, per-row Test button | `testKey()` | `{ok, message}` |

Everything Collections-related (`collections.js`) deliberately **does not**
go through `background.js` at all — content scripts and extension pages
both already have direct `chrome.storage.local` access (the manifest
already declares the `storage` permission for classification caching), so
Collections is a fully separate, self-contained subsystem with its own
storage keys and no message-passing overhead.

---

## 8. Manifest & permissions

```jsonc
"permissions": ["storage", "activeTab"],
"host_permissions": [
  "https://api.semanticscholar.org/*",
  "https://api.openalex.org/*",
  "https://openrouter.ai/*"
],
"content_scripts": [{
  "matches": ["https://scholar.google.com/*"],
  "css": ["styles.css"],
  "js": ["collections.js", "collections-content.js", "content.js"],
  "run_at": "document_idle"
}]
```

No `tabs` permission is declared — `chrome.tabs.getCurrent()` and
`chrome.tabs.remove()` (used by `collection.html` to close its own tab)
don't require it, since they only ever act on the extension's own tab, not
on other tabs' sensitive properties (URL/title/favicon), which is what the
`tabs` permission actually gates.

---

## 9. Known limitations (see also `README.md`)

- **Selectors are fragile.** `.gs_ri`/`h3` are Google Scholar's current
  markup; if badges stop appearing, that's the first thing to check.
- **Cache staleness after a config change** — see §3.1.
- **Approximate title matching** for abstract lookups — a very generic
  title could still occasionally pull the wrong paper's abstract, despite
  the similarity guard in §3.3.
- **Chrome only.** MV3 `service_worker` background; a Firefox build would
  need a separate manifest since Firefox's MV3 background model differs.
- **No cross-tab live sync for Collections.** A paper's saved-state badge
  is read from storage once when it's rendered; saving it from a different
  open tab won't update an already-rendered badge elsewhere without a
  reload. (Storage writes themselves are correctly serialized — see
  §5.3 — this is purely about when the UI happens to re-read them.)
