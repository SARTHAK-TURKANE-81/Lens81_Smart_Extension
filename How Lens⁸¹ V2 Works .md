# Lens⁸¹ : Technical Documentation V2

Lens⁸¹ is a Chrome extension (Manifest V3) that labels each result on a
Google Scholar search page as **Research** or **Review**, using an ensemble
of up to 5 LLMs accessed through the user's own OpenRouter API keys.

---


## 1. Overview

| | |
|---|---|
| **Platform** | Chrome, Manifest V3 |
| **Target site** | `https://scholar.google.com/*` |
| **Classification backend** | OpenRouter chat completions (bring-your-own key) |
| **Abstract sources** | Semantic Scholar API, OpenAlex API (parallel, first usable result wins) |
| **Storage** | `chrome.storage.local` (settings + 30‑day result cache), `chrome.storage.session` (per-tab counters) |
| **UI surfaces** | Content-script badges on Scholar, toolbar popup, options page |

---


## 2. File structure Lens81

```
lens81/
├── manifest.json        Extension manifest (MV3)
├── background.js         Service worker: abstract lookup, ensemble
│                          classification, caching, per-tab stats
├── content.js             Runs on Scholar pages: finds results, injects badges
├── popup.html / popup.js  Toolbar popup: setup CTA or live Research/Review counts
├── options.html/.js       Settings page: up to 5 API key + model rows
├── styles.css              Badge appearance on the Scholar page
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
   → cache hit: return immediately, skip everything below

2. Abstract lookup (parallel, first usable result wins)
   Promise.allSettled([
     fetchFromSemanticScholar(title),
     fetchFromOpenAlex(title),
   ])
   → each candidate is title-matched (similarity ≥ 0.6) before being trusted
   → OpenAlex abstracts are stored as an inverted index and reconstructed to text

3. Classification
   abstract found   → classifyWithLLM(title, abstract)   → source: "llm"
   no abstract       → classifyTitleOnly(title)            → source: "llm-title-only"
   no model configured / every model failed
                     → heuristicClassify(title)             → source: "title-heuristic"

4. Cache the result, return it to content.js
```

`content.js` shows an instant keyword-based "pending" badge (e.g. "Research?")
the moment a title is read, then swaps it for the confirmed badge once step 3
resolves — so the page is never left with a bare spinner.

---

## 4. Multi-model ensemble

This is the core classification logic, in `background.js`.

### 4.1 Configuration

Up to 5 independent **(API key, model)** pairs can be configured on the
options page. At least 1 is required for AI classification to run at all;
1–5 all work identically except for how many models get averaged.

```js
async function getConfiguredPairs() {
  // Reads chrome.storage.local.openrouterConfigs (array of {key, model}),
  // filters out blank/incomplete rows, caps at 5.
  // Falls back to the legacy single openrouterKey/openrouterModel fields
  // for installs that haven't opened the settings page since the update.
}
```

### 4.2 Parallel dispatch

The **exact same prompt** is sent to every configured pair simultaneously:

```js
const settled = await Promise.allSettled(
  pairs.map((pair) => callSingleModel(pair.key, pair.model, prompt))
);
```

Using `Promise.allSettled` (rather than `Promise.all`) means:
- A network error, timeout (12s), bad HTTP status, or unparseable response
  from any one model does **not** abort the others.
- The extension keeps working correctly with anywhere from 1 to 5 models
  configured, and degrades gracefully if some configured models fail on a
  given request.

### 4.3 Per-model response format

Each model is prompted to return compact JSON:

```json
{
  "prediction": "Research" | "Review",
  "research_probability": 0.91,
  "review_probability": 0.09
}
```

`parseModelOutput()` extracts and validates this, normalizing the two
probabilities to sum to 1 if a model's output doesn't add up exactly.

### 4.4 Averaging (the ensemble step)

```js
function ensemble(results) {
  const avgResearch = average(results, r => r.research_probability);
  const avgReview   = average(results, r => r.review_probability);

  const type       = avgResearch >= avgReview ? 'Research' : 'Review';
  const confidence = Math.round(Math.max(avgResearch, avgReview) * 100);

  return { type, confidence };
}
```

Only models that returned a **usable** response are included in the
average — failed/rejected calls are simply excluded, not counted as zero.
The output shape (`{ type, confidence }`) is identical to the original
single-model version, so caching, per-tab stats, and the badge UI needed no
changes downstream of this function.

### 4.5 Prompts

Two prompt templates exist, depending on whether an abstract was found.
Both are unchanged from the original single-model version except for the
requested JSON schema at the end (updated to carry probabilities instead of
a single confidence score):

**With abstract:**
```
You are an expert at identifying academic paper types.
Classify the paper as exactly one of: "Research Paper" or "Review Paper".

Title: {title}
Abstract: {abstract}

Respond with ONLY compact JSON, no other text:
{"prediction":"Research" or "Review","research_probability":0-1,"review_probability":0-1}
```

**Title only** (no abstract could be found) — same structure, with an added
note asking the model to reflect its reduced certainty in the probabilities.

---

## 5. Storage schema

All keys live in `chrome.storage.local` unless noted otherwise.

| Key | Shape | Purpose |
|---|---|---|
| `openrouterConfigs` | `Array<{ key: string, model: string }>` (≤ 5 entries) | Current multi-model configuration. Blank rows are stored as `{key:'', model:''}` and filtered out at read time. |
| `openrouterKey`, `openrouterModel` | `string` | **Legacy** single-pair fields from pre-ensemble versions. Read as a fallback if `openrouterConfigs` is absent; cleared automatically the first time the options page is saved. |
| `classify:<normalized title>` | `{ value: ClassificationResult, savedAt: number }` | 30-day result cache, keyed by lowercased/whitespace-normalized title. |
| `tabstats:<tabId>` | `{ research: number, review: number, total: number }` | **`chrome.storage.session`**, not `local`. Per-tab running counts, reset on navigation, and persisted across service-worker suspensions. |

**`ClassificationResult` shape** (unchanged by the ensemble update — this is
what `content.js` and `popup.js` consume):

```ts
{
  type: "Research" | "Review",
  confidence: number,          // 0–100
  source: "llm" | "llm-title-only" | "title-heuristic"
}
```

---

## 6. Message API (`chrome.runtime.sendMessage`)

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

## 7. UI components

### 7.1 Options page (`options.html` / `options.js`)

- Renders 5 identical rows (Model 1 required, 2–5 optional), each with:
  API key field (password, toggle to reveal), model slug field, and its own
  **Test** button + status pill.
- **Save** writes all 5 rows (including blanks) to `openrouterConfigs` in
  one call and clears the legacy fields.
- On load, migrates a legacy single key/model into row 1 automatically if
  `openrouterConfigs` doesn't exist yet.
- A banner reminds the user to configure at least one row if none are
  filled in.

### 7.2 Popup (`popup.html` / `popup.js`)

Three mutually exclusive states:
- **Not configured** — CTA button opens the options page.
- **On a Scholar tab** — live Research/Review counts for that tab.
- **Not on a Scholar tab** — idle note.

"Configured" means at least one row in `openrouterConfigs` has both a key
and a model, or the legacy fields are set.

### 7.3 Content script (`content.js`)

- Scans `.gs_ri` result blocks on Scholar pages.
- Shows an instant title-keyword "pending" badge, then replaces it with the
  real badge once `CLASSIFY_PAPER` resolves.
- Badge styling communicates confidence level and source (`low-confidence`
  class for title-only or heuristic-only results).
- Uses a debounced `MutationObserver` to catch Scholar's dynamic re-renders
  (pagination, lazy content) without re-scanning the whole page repeatedly.

---

## 8. Error handling & fallbacks

| Failure | Behavior |
|---|---|
| No models configured | Falls straight to `heuristicClassify()` (title-keyword regex). |
| Some configured models fail/time out | Ensemble uses only the successful responses; classification still succeeds if ≥ 1 model responds. |
| All configured models fail | Falls back to `heuristicClassify()`. |
| Abstract lookup fails entirely | Falls back to title-only LLM classification, then heuristic if that also fails. |
| Service worker suspended mid-request | Every network call has a hard timeout (6s abstracts, 12s LLM calls, 8s key test) so nothing hangs indefinitely; per-tab counters live in `chrome.storage.session` so they survive a restart. |

---

## 9. Known limitations

- **Selector fragility**: relies on Google Scholar's current markup
  (`.gs_ri`, `h3`); a Scholar redesign could break badge injection.
- **Coverage gaps**: not every paper is indexed in Semantic Scholar or
  OpenAlex; those fall back to a lower-confidence title-only or heuristic
  classification.
- **Approximate title matching**: a similarity threshold filters obviously
  wrong abstract matches, but very generic titles can occasionally pull the
  wrong paper's abstract.
- **Cost scales with configured models**: each classified paper makes one
  OpenRouter request per configured (key, model) pair, run in parallel — a
  5-model setup uses roughly 5× the API spend of a single-model setup.
- **Chrome-only**: Manifest V3 with a `service_worker` background page;
  Firefox's MV3 background model differs and isn't supported.

---

## 10. Extending this extension

- **Add a heuristic tie-breaker**: `ensemble()` currently favors "Research"
  on an exact 50/50 tie; adjust the `>=` in `ensemble()` if a different
  default is preferred.
- **Weighted ensemble**: to weight models unevenly (e.g. trust one model
  more), extend the `{key, model}` config shape with a `weight` field and
  use a weighted average in `ensemble()` instead of a plain mean.
- **More storage keys**: any new per-install setting should follow the
  existing pattern — a single object/array under one `chrome.storage.local`
  key rather than many top-level keys, to keep reads/writes batched.
