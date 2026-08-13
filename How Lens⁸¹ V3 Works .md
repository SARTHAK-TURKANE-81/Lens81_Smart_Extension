# Lens⁸¹ V3 : Technical Documentation

Lens⁸¹ is a Chrome extension (Manifest V3) that labels each result on a
Google Scholar search page as **Research** or **Review**, using an ensemble
of up to 5 LLMs accessed through the user's own OpenRouter API keys — and
lets the person click any badge to see exactly why it was classified that
way, including every individual model's own response.

This document covers the V3 feature set specifically: the multi-model
ensemble, the always/only-if-needed key tiers, the "why" explanation panel,
and the reliability hardening added along the way (overall timeouts, a
client-side watchdog, and safe handling of tabs that close mid-request).

---

## 1. Overview

| | |
|---|---|
| **Platform** | Chrome, Manifest V3 |
| **Target site** | `https://scholar.google.com/*` |
| **Classification backend** | OpenRouter chat completions (bring-your-own key), 1–5 models |
| **Abstract sources** | Semantic Scholar API and OpenAlex API, queried in parallel |
| **Storage** | `chrome.storage.local` (settings + 30-day result cache), `chrome.storage.session` (per-tab counters) |
| **UI surfaces** | Content-script badges + "why" panel on Scholar, toolbar popup, options page |

---

## 2. File structure

```
lens81/
├── manifest.json        Extension manifest (MV3)
├── background.js         Service worker: abstract lookup, ensemble
│                          classification, caching, per-tab stats
├── content.js             Runs on Scholar pages: finds results, injects
│                          badges, renders the "why" panel on click
├── popup.html / popup.js  Toolbar popup: setup CTA or live Research/Review counts
├── options.html/.js       Settings page: up to 5 API key + model rows,
│                          each with an "only use if needed" checkbox
├── styles.css              Badge, caret, and "why" panel appearance
├── icons/                  Toolbar/extension icons
└── README.md               User-facing quick-start guide
```


---

## 3. Classification pipeline

For each Google Scholar result, `content.js` extracts the title and sends it
to the background worker, which runs the following pipeline
(`classifyPaper()` in `background.js`):

```
1. Cache check
   key = "classify:" + normalize(title)
   → chrome.storage.local, 30-day TTL
   → entries missing `reason`/`details` (saved by a pre-V3 version) are
     treated as a miss, so they get reclassified once and re-cached in
     the current shape instead of showing an empty "why" panel for weeks
   → cache hit: return immediately, skip everything below

2. Whole-pipeline timeout (new in V3)
   The rest of this pipeline races against a 20-second overall timeout
   (OVERALL_CLASSIFY_TIMEOUT_MS). If it doesn't finish in time, the
   keyword heuristic result is used instead — this guarantees the
   background worker always responds well before Chrome could tear down
   the message channel to content.js.

3. Abstract lookup (parallel, first usable result wins)
   Promise.allSettled([
     fetchFromSemanticScholar(title),
     fetchFromOpenAlex(title),
   ])
   → each candidate is title-matched (similarity ≥ 0.6) before being trusted
   → OpenAlex abstracts are stored as an inverted index and reconstructed to text

4. Classification
   abstract found    → classifyWithLLM(title, abstract)   → source: "llm"
   no abstract       → classifyTitleOnly(title)             → source: "llm-title-only"
   no model configured / every model failed / step 2 timed out
                      → heuristicClassify(title)             → source: "title-heuristic"

5. Cache the result, return it to content.js
```

`content.js` shows an instant keyword-based "pending" badge (e.g. "Research?")
the moment a title is read, then swaps it for the confirmed badge once step 4
resolves — so the page is never left with a bare spinner.

---

## 4. Multi-model ensemble

This is the core classification logic, in `background.js`.

### 4.1 Configuration

Up to 5 independent **(API key, model, only-if-needed)** tuples can be
configured on the options page. At least 1 is required for AI
classification to run at all.

```js
async function getConfiguredPairs() {
  // Reads chrome.storage.local.openrouterConfigs
  // (array of {key, model, onlyIfNeeded}), filters out blank/incomplete
  // rows, caps at 5.
  // Falls back to the legacy single openrouterKey/openrouterModel fields
  // for installs that haven't opened the settings page since the update
  // to multi-model support (treated as one "always" pair).
}
```

### 4.2 Two calling tiers: "always" vs. "only if needed" (V3)

Each configured row can be checked **"Only use this key if the others
fail"** on the options page. This splits every request into two tiers:

```js
const always = pairs.filter((p) => !p.onlyIfNeeded);
const fallback = pairs.filter((p) => p.onlyIfNeeded);

let successes = await runPairs(always, prompt);

if (successes.length === 0 && fallback.length > 0) {
  successes = await runPairs(fallback, prompt);   // only spent when needed
}
```

- **Always** rows (the default, unchecked) are called on every single
  classification, in parallel — this is the original ensemble behavior.
- **Only-if-needed** rows are held back entirely and only called if *every*
  "always" row failed, timed out, or returned something unparseable for
  that paper. This is meant for a backup or free-tier key that shouldn't be
  spending a request on every paper, only the ones the primary model(s)
  couldn't handle.
- If a config has **no** "always" rows at all (everything is checked "only
  if needed"), the fallback tier still runs — there's nothing to fall back
  *from*, so holding it back would mean never classifying anything.
- A single successful "always" response is enough to skip the fallback
  tier entirely, even if other "always" rows failed.

  

### 4.3 Parallel dispatch within a tier

Within each tier, the **exact same prompt** is sent to every pair
simultaneously:

```js
async function runPairs(pairs, prompt) {
  const settled = await Promise.allSettled(
    pairs.map((pair) => callSingleModel(pair.key, pair.model, prompt))
  );
  return settled.filter((s) => s.status === 'fulfilled' && s.value).map((s) => s.value);
}
```

Using `Promise.allSettled` (rather than `Promise.all`) means a network
error, timeout (12s per model), bad HTTP status, or unparseable response
from any one model in the tier does **not** abort the others.

### 4.4 Per-model response format

Each model is prompted to return compact JSON, including a short
justification:

```json
{
  "prediction": "Research" | "Review",
  "research_probability": 0.91,
  "review_probability": 0.09,
  "reason": "one short sentence explaining why"
}
```

`parseModelOutput()` extracts and validates this, normalizing the two
probabilities to sum to 1 if a model's output doesn't add up exactly, and
tags each surviving result with which model produced it (`callSingleModel`
attaches `model` to the parsed object) so the "why" panel can attribute
each response correctly.

### 4.5 Averaging (the ensemble step)

```js
function ensemble(results) {
  const avgResearch = average(results, r => r.research_probability);
  const avgReview   = average(results, r => r.review_probability);

  const type       = avgResearch >= avgReview ? 'Research' : 'Review';
  const confidence = Math.round(Math.max(avgResearch, avgReview) * 100);

  const reason = results.length === 1
    ? results[0].reason
    : `${agreeing} of ${results.length} models classified this as ${type}, averaging ${confidence}% confidence.`;

  const details = results.map(r => ({
    model: r.model, prediction: r.prediction,
    research_probability: r.research_probability,
    review_probability: r.review_probability,
    reason: r.reason,
  }));

  return { type, confidence, reason, details };
}
```

Only models that returned a **usable** response are included — failed or
rejected calls are excluded, not counted as zero. `reason` and `details`
are new in V3 and are what power the "why" panel (§6); `type`/`confidence`
are unchanged from earlier versions, so caching and the per-tab stats
counter needed no changes downstream of this function.

### 4.6 Prompts

Two prompt templates exist, depending on whether an abstract was found —
unchanged in substance from earlier versions except for the `reason` field
added to the requested JSON schema:

**With abstract:**
```
You are an expert at identifying academic paper types.
Classify the paper as exactly one of: "Research Paper" or "Review Paper".

Title: {title}
Abstract: {abstract}

Respond with ONLY compact JSON, no other text:
{"prediction":"Research" or "Review","research_probability":0-1,"review_probability":0-1,"reason":"one short sentence explaining why, based on the abstract"}
```

**Title only** (no abstract could be found) — same structure, asking the
model to reflect its reduced certainty in the probabilities and reason.

---

## 5. Reliability hardening (V3)

Three fixes address failure modes that only show up under real-world
conditions (slow networks, many results loading at once, tabs closing
mid-request) rather than in normal happy-path use.

### 5.1 Overall pipeline timeout

Individual network calls already had their own timeouts (6s for abstract
lookups, 12s per model), but nothing bounded the *combined* worst case. A
slow abstract lookup stacked with a slow model call could together run long
enough that Chrome tears down the message channel back to `content.js`
before `sendResponse()` fires — logged as `"Unchecked runtime.lastError:
the message port closed before a response was received"` — leaving that
paper's badge stuck pulsing forever.

`withOverallTimeout()` races the real pipeline against a 20-second timer;
whichever settles first wins, and the loser is simply ignored (its own
timeouts still clean it up independently):

```js
function withOverallTimeout(promise, ms, fallbackFn) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallbackFn());
    }, ms);
    promise.then(
      (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } },
      ()      => { if (!settled) { settled = true; clearTimeout(timer); resolve(fallbackFn()); } }
    );
  });
}
```

### 5.2 Client-side watchdog

As a second line of defense — for the rarer case where the service worker
is killed mid-request and `sendResponse()` never fires at all —
`content.js` starts a 25-second watchdog timer of its own (slightly above
the background worker's 20s ceiling) when it sends `CLASSIFY_PAPER`. If the
callback hasn't fired by then, the pending badge is replaced with the
"unavailable" badge instead of being left pulsing indefinitely. If the real
response arrives first (the normal case), it cancels the watchdog and
nothing else happens.

### 5.3 Safe badge updates for closed tabs

`chrome.action.setBadgeText`/`setBadgeBackgroundColor` throw `No tab with
id: <id>` if the tab has already closed by the time the extension tries to
update its toolbar badge — an increasingly likely race now that
classification can take up to ~20 seconds. Both calls are routed through a
`setBadge()` helper that catches and discards exactly this error:

```js
function setBadge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}
```

---

## 6. The "why" panel (V3)

Clicking any confirmed badge on a Scholar page expands a panel explaining
the classification — implemented entirely in `content.js`/`styles.css`,
using the `reason`/`details` fields now included in every classification
result.

### 6.1 Structure

```
[Research · 87% ▾]   ← badge, now clickable when a result has resolved
└── .lens81-why (appended as the last child of the .gs_ri result card —
     inline in the page flow, not a floating overlay)
    ├── .lens81-why-summary   overall reason (from ensemble(), §4.5)
    ├── .lens81-why-models    one row per model that answered:
    │    ├── model name (shortened + ellipsis-truncated) + prediction pill
    │    └── that model's own one-sentence reason
    └── Close button
```

If no model responded at all (heuristic fallback), the panel instead shows
a note that no AI is configured/responded, rather than an empty list.

### 6.2 Interaction rules

- Clicking a badge toggles its panel; clicking a *different* badge closes
  whatever panel was already open first (only one panel open at a time).
- Clicking anywhere outside the panel closes it (via a single
  `document`-level click listener).
- Clicking **inside** the panel does not close it (the panel stops click
  propagation).
- Scrolling does **not** close the panel — it's inline content that
  scrolls naturally with the page, not a floating dropdown, so auto-closing
  on scroll would only get in the way of reading a panel taller than the
  viewport.
- The badge itself gets a small rotating caret (▾/▴) reflecting open/closed
  state, plus a `title` tooltip appropriate to the result's `source`.

### 6.3 CSS notes

The panel is capped at `max-width: 480px` and appended in normal document
flow (`clear: both`) so it can't overlap surrounding Scholar content. The
per-model name/pill row uses `min-width: 0` + `flex: 1 1 auto` on the name
and `flex-shrink: 0` on the pill, so a long model slug properly
ellipsis-truncates instead of overflowing on a narrow window — flex items
don't shrink below their content size by default, which is a common,
easy-to-miss source of this exact kind of overflow.

---

## 7. Storage schema

All keys live in `chrome.storage.local` unless noted otherwise.

| Key | Shape | Purpose |
|---|---|---|
| `openrouterConfigs` | `Array<{ key: string, model: string, onlyIfNeeded: boolean }>` (≤ 5 entries) | Current multi-model configuration. Blank rows are stored as `{key:'', model:'', onlyIfNeeded:false}` and filtered out at read time. |
| `openrouterKey`, `openrouterModel` | `string` | **Legacy** single-pair fields from pre-ensemble versions. Read as a fallback if `openrouterConfigs` is absent; cleared automatically the first time the options page is saved. |
| `classify:<normalized title>` | `{ value: ClassificationResult, savedAt: number }` | 30-day result cache, keyed by lowercased/whitespace-normalized title. Entries missing `reason`/`details` are treated as stale (see §3, step 1). |
| `tabstats:<tabId>` | `{ research: number, review: number, total: number }` | **`chrome.storage.session`**, not `local`. Per-tab running counts, reset on navigation, and persisted across service-worker suspensions. |

**`ClassificationResult` shape** (extended in V3 with `reason`/`details`;
`type`/`confidence`/`source` are unchanged from earlier versions):

```ts
{
  type: "Research" | "Review",
  confidence: number,          // 0–100
  source: "llm" | "llm-title-only" | "title-heuristic",
  reason: string,               // overall one-line explanation
  details: Array<{              // one entry per model that answered
    model: string,
    prediction: "Research" | "Review",
    research_probability: number,   // 0-1
    review_probability: number,     // 0-1
    reason: string,
  }>,
}
```

---

## 8. Message API (`chrome.runtime.sendMessage`)

Handled in `background.js`'s `onMessage` listener.

| `type` | Sent by | Payload | Response |
|---|---|---|---|
| `CLASSIFY_PAPER` | `content.js` | `{ title: string }` | `ClassificationResult` or `{ error: 'unavailable' }` |
| `GET_TAB_STATUS` | `popup.js` | `{ tabId: number }` | `{ research, review, total }` |
| `TEST_KEY` | `options.js` (per row) | `{ key, model }` | `{ ok: boolean, message: string }` |

`TEST_KEY` sends one minimal real request ("Reply with the single word: ok")
through OpenRouter so a bad key or mistyped model slug surfaces immediately
on the settings page rather than failing silently later.

---

## 9. UI components

### 9.1 Options page (`options.html` / `options.js`)

- Renders 5 identical rows (Model 1 required, 2–5 optional), each with:
  API key field (password, toggle to reveal), model slug field, an **"only
  use this key if the others fail"** checkbox (V3), and its own **Test**
  button + status pill.
- **Save** writes all 5 rows (including blanks) to `openrouterConfigs` in
  one call and clears the legacy fields.
- On load, migrates a legacy single key/model into row 1 automatically if
  `openrouterConfigs` doesn't exist yet.
- A banner reminds the user to configure at least one row if none are
  filled in.

### 9.2 Popup (`popup.html` / `popup.js`)

Three mutually exclusive states:
- **Not configured** — CTA button opens the options page.
- **On a Scholar tab** — live Research/Review counts for that tab.
- **Not on a Scholar tab** — idle note.

"Configured" means at least one row in `openrouterConfigs` has both a key
and a model, or the legacy fields are set.

### 9.3 Content script (`content.js`)

- Scans `.gs_ri` result blocks on Scholar pages.
- Shows an instant title-keyword "pending" badge, then replaces it with the
  real (now clickable) badge once `CLASSIFY_PAPER` resolves — or with an
  "unavailable" badge if the request errors out or the watchdog fires first.
- Badge styling communicates confidence level and source (`low-confidence`
  class for title-only or heuristic-only results).
- Clicking a resolved badge opens the "why" panel (§6).
- Uses a debounced `MutationObserver` to catch Scholar's dynamic re-renders
  (pagination, lazy content) without re-scanning the whole page repeatedly.

---

## 10. Error handling & fallbacks

| Failure | Behavior |
|---|---|
| No models configured | Falls straight to `heuristicClassify()` (title-keyword regex). |
| Some "always" models fail/time out, at least one succeeds | Ensemble uses only the successful ones; the "only if needed" tier is never spent. |
| Every "always" model fails | The "only if needed" tier is called; ensemble uses whatever succeeds there. |
| Every configured model fails (across both tiers) | Falls back to `heuristicClassify()`. |
| Abstract lookup fails entirely | Falls back to title-only LLM classification, then heuristic if that also fails. |
| Whole pipeline exceeds 20s | Overall timeout resolves to `heuristicClassify()` immediately (§5.1). |
| Background never responds at all | Client-side 25s watchdog replaces the badge with "unavailable" (§5.2). |
| Tab closes while classification is in flight | Badge/stat updates for that tab are silently discarded rather than throwing (§5.3). |
| Cached result predates V3 | Treated as a cache miss and reclassified once, upgrading it to the current shape (§3, step 1). |

---

## 11. Known limitations

- **Selector fragility**: relies on Google Scholar's current markup
  (`.gs_ri`, `h3`); a Scholar redesign could break badge injection.
- **Coverage gaps**: not every paper is indexed in Semantic Scholar or
  OpenAlex; those fall back to a lower-confidence title-only or heuristic
  classification.
- **Approximate title matching**: a similarity threshold filters obviously
  wrong abstract matches, but very generic titles can occasionally pull the
  wrong paper's abstract.
- **Cost scales with configured "always" models**: each classified paper
  makes one OpenRouter request per "always" pair, run in parallel; the
  "only if needed" tier only adds cost on papers where every "always" pair
  failed.
- **Chrome-only**: Manifest V3 with a `service_worker` background page;
  Firefox's MV3 background model differs and isn't supported.

---

## 12. Extending this extension

- **Add a heuristic tie-breaker**: `ensemble()` currently favors "Research"
  on an exact 50/50 tie; adjust the `>=` in `ensemble()` if a different
  default is preferred.
- **Weighted ensemble**: to weight models unevenly (e.g. trust one model
  more), extend the config shape with a `weight` field and use a weighted
  average in `ensemble()` instead of a plain mean.
- **Multiple fallback tiers**: the current design has exactly two tiers
  (always / only-if-needed). A `priority` integer instead of a boolean
  would generalize this to N tiers, called in order until one succeeds.
- **More storage keys**: any new per-install setting should follow the
  existing pattern — a single object/array under one `chrome.storage.local`
  key rather than many top-level keys, to keep reads/writes batched.
