# Lens⁸¹

**Know whether a Google Scholar result is a Research Paper or a Review Paper, and turn any selected text into a formatted citation, without ever leaving the page.**

[![Watch the demo](https://img.youtube.com/vi/I_N_ybBbkhQ/maxresdefault.jpg)](https://youtu.be/I_N_ybBbkhQ)

**Demo video:** https://youtu.be/I_N_ybBbkhQ

---

## The Problem

Google Scholar gives researchers no way to tell, at a glance, whether a result is a primary research paper or a review article. Both look identical in a results list, so the only way to tell them apart is to open each one and read into it. Across a real literature review, that cost adds up quickly: hours lost to repetitive triage, relevant papers skimmed past or missed, and reviews mistaken for primary studies (or the reverse) at exactly the moment the distinction matters most. On top of that, researchers have no fast, in-context way to save promising papers or pull a correctly formatted citation while they work. Every save or citation means breaking concentration to open a separate reference manager and re-type bibliographic details by hand.

## The Solution

Lens⁸¹ addresses both problems directly inside the browser, where the research already happens. It is a Chrome Manifest V3 extension that labels Google Scholar results with **Research** or **Review** badges, keeps a running library of saved papers in local **Collections**, surfaces **related-paper recommendations** built from what you have already saved, and turns **highlighted text on any page into a properly formatted citation**. Every one of these capabilities runs entirely client side. There is no application server and no hosted database anywhere in the project. Your data stays on your machine, and the only network calls are the ones you explicitly configure.

---

## Features

* **Research vs. Review badges**, shown directly on the Google Scholar results page, with no extra clicks or tabs.
* **Instant, then confirmed.** A quick title-based prediction appears immediately, then updates with an abstract-verified result a moment later.
* **Transparent explanations.** Click any badge to see the overall reasoning plus every model's individual prediction, confidence, and explanation. A model that failed to respond is shown as a failed attempt, not silently dropped.
* **Ensemble of up to 5 models, with a choice of provider per row.** Configure up to five model rows and pick **OpenRouter, Google Gemini, or xAI Grok** independently for each one. Every row classifies in parallel, and valid probabilities are averaged into a single, more reliable result.
* **Cost-friendly fallback keys.** Mark a row "Only use if needed" and it engages, and only bills, the moment a primary provider fails, even across providers.
* **Bring your own API key(s).** Classification data goes only to the provider selected for that row; abstract lookups go only to Semantic Scholar and OpenAlex. No middleman server, no telemetry.
* **30-day local caching**, keyed by normalized title, so revisiting the same search never re-triggers a network call.
* **Live per-tab counter** for Research and Review counts, which survives Chrome unloading the background worker.
* **Works with zero AI configuration.** With no API key configured, Lens⁸¹ falls back to a keyword-based prediction instead of leaving papers unlabeled.
* **Collections.** Save papers into local, playlist-style buckets right from the results page, with no account and no cloud, and export as **CSV, XLSX, JSON, BibTeX, Markdown, or CSL**.
* **Related-paper recommendations**, generated from your own saved Collections via the Semantic Scholar recommendations endpoint, with an OpenAlex title-search fallback for full coverage.
* **New in this release: Citation Finder.** Highlight any text (12 to 6,000 characters) on any page, and Lens⁸¹ searches **Crossref, Semantic Scholar, and OpenAlex in parallel**, de-duplicates the results, and ranks candidates using four complementary signals: token overlap, cosine similarity, Levenshtein similarity, and fuzzy token sorting. This works with no AI configured at all, and optional AI reranking layers on top when a model is available.
* **New in this release: Reference parsing from any format.** `refparse.js` normalizes DOI, BibTeX, or RIS input into one common structured reference, regardless of the format you start from.
* **New in this release: Instant, offline citation formatting.** `citeproc-js` and CSL (Citation Style Language) style definitions are bundled directly into the extension rather than fetched at runtime, so in-text citations and full bibliographies render instantly, even without connectivity.
* **New in this release: Settings passcode gate.** A salted SHA-256 comparison gates the Settings UI itself, an additional layer of local, purpose-built access control on top of Chrome's own storage sandboxing.

---

## How It Works

**Classification pipeline**

```text
Scholar result title
   |
   v
30-day cache (keyed by normalized title) --- HIT ---> Badge rendered instantly
   | MISS
   v
Parallel metadata lookup (Semantic Scholar / OpenAlex)
   |
   v
Configured LLM ensemble (1 to 5 rows, any mix of OpenRouter, Gemini, Grok, run in parallel)
   |  Valid probabilities from every responding provider are averaged
   v
Badge with confidence and rationale
   |  (if every provider path is exhausted, a title-keyword fallback still returns a badge)
```

Every stage is time-boxed: abstract calls time out at 6 seconds, model calls at 12 seconds, and the full pipeline is capped at 20 seconds end to end, so the page is never left waiting on a slow provider.

**Citation pipeline**

```text
Text selected on any page (12 to 6,000 characters)
   |
   v
Crossref, Semantic Scholar, and OpenAlex queried in parallel
   |
   v
Results de-duplicated across sources
   |
   v
Ranked by four signals: token overlap, cosine similarity, Levenshtein, fuzzy token sort
   |  (optional AI reranking layers on top if configured)
   v
citeproc-js and bundled CSL styles produce an in-text citation and full bibliography, rendered offline
```

If an abstract cannot be found, Lens⁸¹ asks the AI to judge from the title alone and marks the badge accordingly. If no AI model is configured at all, classification falls back to a labeled keyword heuristic, and citation search remains fully usable with zero LLM setup required.

---

## System Architecture

Lens⁸¹ is built around a clean, unidirectional flow of information. No component in the chain is a remote server under the project's control, so there is no backend to secure, scale, or keep online.

```text
Scholar / web page  ->  Content scripts  ->  Service worker  ->  APIs and storage
```

| Layer | Responsibility |
|---|---|
| **Content scripts** | Injected into Scholar and other web pages; render page-level UI such as badges, save controls, and citation panels right where you are already looking. |
| **Background service worker** | Owns all network-facing work: metadata provider calls, user-configured LLM calls, classification logic, and citation logic. A single centralized source of truth. |
| **Chrome storage APIs** | `chrome.storage.local` persists collections, saved papers, provider configuration, citation style, and the classification cache across sessions, with no account or login needed. `chrome.storage.session` holds lightweight per-tab counters for the life of the browsing session only. |

Content scripts never talk to external services directly. They message the background worker through a small, well-defined set of internal message types: `CLASSIFY_PAPER`, `GET_TAB_STATUS`, `TEST_KEY`, `RESOLVE_DOI`, `FIND_CITATIONS`, and `FIND_PAPERS`. Centralizing every provider-facing and network-facing call in one worker keeps the attack surface small and keeps content scripts focused purely on page interaction.

**Local data design.** Three record shapes live in `chrome.storage.local`: **Collections** (`id`, `name`), **Saved papers** (`title`, `DOI`, `metadata`), and the **Classification cache** (`title`, `value`, `savedAt`). Collection membership is tracked on each saved paper's own record rather than through a relational join, so there is no join logic and no foreign-key integrity to maintain. `lens81Enqueue` serializes collection writes to eliminate read-modify-write races when two updates to the same collection overlap.

---

## File Structure

```text
lens81/
├── icons/                     Extension icons
├── vendor/                    Bundled third-party assets (citeproc-js, CSL styles)
├── background.js              Classification, citation search, provider calls, cache, tab stats
├── cite-styles.html           Citation style picker UI
├── cite-styles.js             Citation style picker logic
├── cite.js                    Page-level citation UI: find, format, insert
├── collection.html            Single-collection view
├── collection.js              Related-paper recommendations (Semantic Scholar + OpenAlex fallback)
├── collections-content.js     Extracts Scholar metadata, renders save controls
├── collections.js             Collection CRUD and export (CSV, XLSX, JSON, BibTeX, Markdown, CSL)
├── content.js                 Observes Scholar result cards, applies badges in real time
├── csl-export.js              CSL export logic
├── csl.js                     Loads CSL styles, generates in-text citations and bibliographies
├── manifest.json              Manifest V3 configuration
├── mini-xlsx.js                Local XLSX export, no network call
├── options.html               Settings UI markup
├── options.js                 Settings, model tests, collections, passcode gate
├── popup.html                 Toolbar popup markup
├── popup.js                   Popup logic: live setup state, per-tab counts
├── README.md                  This file
├── refparse.js                Parses DOI, BibTeX, or RIS into one common structured reference
└── styles.css                 Shared styling
```

Each module owns a narrow, well-defined responsibility by design. Scholar-facing scripts only read and annotate result cards, citation scripts only parse and format references, and `background.js` is the single centralized home for classification and provider logic, with no duplicated logic between the popup, options, and content scripts.

---

## Installation

1. Clone this repository, or download and extract it.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project folder, the one that directly contains `manifest.json`, not a parent folder.
5. Click the Lens⁸¹ toolbar icon and open **Settings**.

The only runtime requirement is a Chromium browser. No separate install, no runtime environment beyond that.

---

## Configuration

The settings page contains five model slots. **Model 1 is required**, and Models 2 through 5 are optional. One model is enough to get started, but adding more, even across different providers, improves reliability by averaging their predictions.

Each row independently selects a **provider**:

| Provider | Get a key from | Sent to | Example model slug |
|---|---|---|---|
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | `openrouter.ai` | `anthropic/claude-haiku-4.5` |
| Google Gemini | [Google AI Studio](https://aistudio.google.com/apikey) | `generativelanguage.googleapis.com` | `gemini-2.5-flash` |
| xAI Grok | [console.x.ai](https://console.x.ai) | `api.x.ai` | `grok-4.3` |

Model catalogs and slugs change over time for every provider, so always double-check the provider's own current model list rather than relying on a hardcoded example. Switching a row's provider clears its model field for exactly this reason, so a slug is never accidentally sent to the wrong provider.

For each row you use:

1. Pick a **provider** from the dropdown.
2. Paste in that provider's **API key**. Keys are stored only in `chrome.storage.local` and are sent only to that provider's own API host, never bundled into the extension and never sent anywhere else.
3. Paste in a **model slug** from that provider's current model catalog.
4. Click that row's **Test** button. This sends one small real request so an invalid key or a retired model slug is caught immediately, rather than failing silently later on a live Scholar page.
5. Optionally enable **"Only use this key if the others fail"** to keep it as a backup that is billed only on failure.

Click **Save**, then open any search page on `scholar.google.com`. Badges appear automatically beside each result.

Without any API key configured, Lens⁸¹ still works, using a lower-confidence keyword-based prediction instead of AI classification, and the Citation Finder works with zero setup as well.

The **Settings passcode** (salted SHA-256) gates access to this page itself, so provider keys and configuration are not one accidental click away from being changed.

---

## Collections

A lightweight, local-only way to organize papers into project buckets, closer to a playlist than a reference manager. No accounts, no sync, no cloud.

* On any Scholar result, once the badge is confirmed you will see a small **Save** control. Click it to check or uncheck collections from an inline list; it saves instantly.
* **New Collection** creates one on the spot (duplicate names are rejected) and immediately saves the current paper into it.
* A paper can belong to any number of collections at once; removing it from one does not affect the others.
* Once saved, the control shows as **Saved** with a folder chip (for example, `Thesis, Read Later`), including on the next visit to the same search.
* The toolbar popup lists every collection with its paper count, a shortcut to create a new one, and **Export All**. Clicking a collection opens a full page with rename, delete, and **Export Collection**.
* Export formats: **CSV, XLSX, JSON, BibTeX, Markdown, and CSL**, all generated locally with no network call involved.
* Saved Collections also power **related-paper recommendations**, surfaced from the Semantic Scholar recommendations API with an OpenAlex fallback.

---

## Citation Finder

Highlight any text on any page, between 12 and 6,000 characters (short enough to identify a source, long enough to process efficiently), and Lens⁸¹ finds and formats the citation.

1. Select text and open the citation panel.
2. Lens⁸¹ queries **Crossref, Semantic Scholar, and OpenAlex** in parallel, de-duplicates overlapping matches, and ranks candidates using **token overlap, cosine similarity, Levenshtein similarity, and fuzzy token sorting**, four different notions of textual closeness combined for a considerably more robust result than any single metric alone.
3. Optional AI reranking layers on top when a model is configured, but the core search needs zero LLM setup.
4. Pick a match, choose a citation style, and copy or insert an in-text citation or full bibliography, rendered instantly and offline via the bundled `citeproc-js` engine and CSL style definitions.
5. Already have a DOI, a BibTeX entry, or an RIS record? `refparse.js` normalizes any of the three into one common structured reference.

---

## Reliability

* Every network request carries its own timeout, and the full classification pipeline is capped at 20 seconds; beyond that, Lens⁸¹ falls back to the keyword-based prediction.
* `Promise.allSettled` is used for parallel calls, so a single failed request never blocks the others.
* If the background worker never responds at all, the page stops waiting after 25 seconds instead of leaving a loading badge indefinitely.
* A model that fails partway through, whether from a rate limit, a bad slug, or a transient outage, is reported explicitly in the "why" panel rather than quietly vanishing.
* Per-tab Research and Review counts survive Chrome unloading the background worker.
* Closing a tab mid-classification is handled cleanly, with no console errors.
* Model-output parsing, threshold validation, and cache expiry after the 30-day window are built into the code rather than bolted on afterward.

---

## Testing and Validation

Every required manual test case has been executed end to end against the shipped build, and every one passed.

| Test | Expected validation | Result |
|---|---|---|
| Provider configuration | Valid provider, key, and model accepted; connection failure reported clearly | Passed |
| Scholar result | Result reaches classification or unavailable state, with no stuck pending badge | Passed |
| Cache | Same title returns stored result within the configured TTL | Passed |
| Collections | Create, save, rename, delete, and export preserve displayed metadata | Passed |
| Citation finder | DOI, BibTeX, RIS, search, copy, and insertion handle success and failure states | Passed |

No automated test framework or CI is included in this round. Validation for this round rests on complete, passing manual coverage of the workflows above, with an automated regression suite scoped as near-term future work.

---

## Current Scope, By Design

* **Provider-dependent classification.** Classification and citation search draw on third-party APIs and user-configured models by design, giving full control over cost, provider choice, and model quality, with no vendor lock-in.
* **Abstract-aware, title-safe fallback.** When no abstract is available, the pipeline still returns a title-only or keyword-based classification rather than leaving a blank result.
* **Content-script UI scope.** UI is injected precisely where the research already happens; current scope targets Google Scholar's present layout, with layout-resilience hardening planned next.
* **Local-first key storage.** API keys live in extension local storage today, consistent with a local-first, no-account architecture; encryption at rest is the next planned hardening step.
* **Manual-first validation.** This round's coverage is complete, passing manual testing; an automated suite is planned to complement it, not replace it.

---

## Known Limitations

* **Cached results do not know your configuration changed.** Classifications are cached for 30 days per title; use **Clear cache** in Settings after changing the model setup to force reclassification.
* **Selectors are fragile.** Google Scholar's markup can change over time; if badges stop appearing, that is the first thing to check.
* **Chrome only, for now.** Manifest V3's service-worker background model is not shared by Firefox.
* **Not every paper is indexed** in Semantic Scholar, OpenAlex, or Crossref, and some publishers withhold abstracts, so fallback paths will trigger for a portion of results.
* **Title and text matching is approximate.** Similarity checks filter out obviously wrong matches, but very generic titles or selections could occasionally pull the wrong result.

---

## Roadmap

* Automated unit and browser integration tests, layered on top of completed manual coverage.
* Bounded concurrency and provider backoff, so classification and citation calls degrade gracefully under heavy load or provider throttling.
* Structured, redacted diagnostics for faster issue tracing without exposing sensitive request content.
* Storage schema validation and migration, so `chrome.storage.local` records evolve safely as the product grows.
* Narrower, more resilient DOM injection to further reduce sensitivity to Scholar layout changes.
* A hardened secret-management architecture so configured API keys are encrypted at rest.
* Additional paper categories: Survey, Meta-analysis, Systematic Review.
* Confidence score tuning and calibration, paper summarization, Firefox support, and dark mode improvements.

---

## Disclaimer

Classification and citation matching are AI-assisted and heuristic-assisted, and may not always be correct. Lens⁸¹ is designed to help you quickly understand what you are looking at and save time on citation lookup, not to replace reading the paper itself or verifying a reference. Please verify results whenever accuracy matters.

---

## Version History

**V1.** Original release. Single OpenRouter API key with one model, abstract lookup via Semantic Scholar and OpenAlex, instant title-based predictions, per-tab counter, local caching.

**V2.** Introduced the multi-model ensemble: up to five API keys, each with its own model, classifying every paper in parallel and averaging Research and Review probabilities.

**V3.** Added explainability and reliability improvements. Clicking a badge shows complete reasoning, including every model's individual response. Introduced cost-saving fallback keys and improved handling of slow networks, stalled requests, and tabs closing mid-classification.

**V4.** Each of the five model rows can independently use **OpenRouter, Google Gemini, or xAI Grok**, mixed and matched, including across the "always" versus "only if needed" split. Introduced **Collections**, a local, account-free way to save papers into project buckets and export as CSV, Excel, JSON, BibTeX, or Markdown.

**V5.** Stability and UX refinements across the classification pipeline and Collections workflow ahead of the citation-focused rebuild.

**V6 (current).** Introduced the **Citation Finder**: highlight text anywhere and get a ranked, cross-referenced citation from Crossref, Semantic Scholar, and OpenAlex, with optional AI reranking and zero-setup usability. Added `refparse.js` for DOI, BibTeX, and RIS parsing; bundled `citeproc-js` and CSL styles for instant offline citation formatting; related-paper recommendations powered by saved Collections; CSL and XLSX export; a Settings passcode gate (salted SHA-256); and `lens81Enqueue` write serialization to eliminate collection race conditions. All Section 6 manual test cases pass against the shipped build.

---

## Contributing

Suggestions, feature requests, and pull requests are always welcome.

---

## Team

Built with the goal of making academic literature exploration a little easier for every student and early-career researcher.

* Sarthak Turkane
* Pratik Wakchaure
* Sanket Dale
* Ayush Landge
