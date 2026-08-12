# Lens⁸¹

**Know whether a Google Scholar result is a Research Paper or a Review Paper, directly in the search results.**

During my academic journey, I noticed that many of my batchmates and other early-career researchers struggled to tell research papers and review papers apart while browsing Google Scholar. Both often look similar at a glance, especially when you're scanning a page full of results.

Lens⁸¹ looks up each paper's abstract and adds a small badge next to the title, showing what the paper is most likely to be. This helps you spend more time reading the right papers instead of guessing.

---

## Features

* **Research vs. Review badges**, shown directly on the Google Scholar results page, with no extra clicks or tabs.
* **Instant + confirmed.** A quick title-based prediction appears immediately, then updates with an abstract-verified result a moment later.
* **Transparent explanations.** Click any badge to view the overall reasoning, along with each AI model's prediction, confidence score, and explanation. Nothing is hidden behind a black box — a model that failed to respond is shown as a failed attempt, not silently dropped.
* **Ensemble of up to 5 models — and your choice of provider.** Configure up to five model rows, and pick **OpenRouter, Google Gemini, or xAI Grok independently for each one**. Every row classifies the paper in parallel, and their probabilities are averaged into a single, more reliable result.
* **Cost-friendly fallback keys.** Mark a row as "Only use if needed" to keep it as a backup. It is only used, and only billed, if your primary model(s) fail — and this works across providers too (e.g. a Gemini row as primary, an OpenRouter row held back as backup).
* **Bring your own API key(s).** Data for classification goes only to whichever provider you selected for that row (OpenRouter, Gemini, or xAI), and abstract lookups go only to Semantic Scholar/OpenAlex. There is no middleman server and no telemetry — keys never leave your browser except to their own provider's API.
* **Local caching.** Results are cached for 30 days, so revisiting the same search does not trigger another API call.
* **Live per-tab counter.** View a running Research/Review count for the current tab from the toolbar icon — it survives Chrome unloading the extension's background worker.
* **Works without AI configuration.** If no API key is configured, Lens⁸¹ falls back to a lower-confidence keyword-based prediction instead of leaving papers unlabeled.
* **Collections.** Save papers into local, playlist-style buckets right from the results page — no account, no cloud, no reference-manager overhead — and export any collection as CSV, Excel, JSON, BibTeX, or Markdown.

---

## How It Works

```text
Google Scholar page
   │  Content script reads each result's title
   ▼
Semantic Scholar / OpenAlex (queried in parallel)
   │  Looks up the title to retrieve the paper's abstract
   ▼
Your configured model row(s) (1-5, run in parallel)
   │  Any mix of OpenRouter / Google Gemini / xAI Grok
   │  Each returns a prediction, probability, and one-line explanation
   ▼
Ensemble averages the probabilities from every responding model
   ▼
Badge displayed next to the title:
📘 Research · 91%   or   📙 Review · 84%
   │  Click the badge
   ▼
"Why" panel showing the overall reasoning and every model's individual
response — including which ones failed, and why
```

If an abstract cannot be found, Lens⁸¹ asks the AI to make its best judgment using only the title, and clearly indicates this in the badge.

If no AI model is configured, Lens⁸¹ falls back to a quick keyword-based prediction instead of leaving the result unlabeled.

---

## Why It Matters

Finding the right type of paper is one of the first steps in an effective literature review.

* **Research papers** present original experiments, methods, and findings.
* **Review papers** summarize and analyze existing research in a field.

Knowing the difference at a glance helps students learn more efficiently and helps researchers build stronger literature reviews.

---

## Installation

1. Clone this repository (or download and extract it).
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the project folder — the one that directly contains `manifest.json`, not a parent folder.
5. Click the Lens⁸¹ toolbar icon and open **Settings**.

---

## Configuration

The settings page contains five model slots. **Model 1 is required**, while Models 2-5 are optional. One model is enough to get started, but adding more models — even across different providers — improves reliability by averaging their predictions.

Each row independently picks a **provider**:

| Provider | Get a key from | Sent to | Example model slug |
|---|---|---|---|
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | `openrouter.ai` | `anthropic/claude-haiku-4.5` |
| Google Gemini | [Google AI Studio](https://aistudio.google.com/apikey) | `generativelanguage.googleapis.com` | `gemini-2.5-flash` |
| xAI Grok | [console.x.ai](https://console.x.ai) | `api.x.ai` | `grok-4.3` |

Model catalogs and slugs change over time for every one of these providers, so always double-check the provider's own current model list rather than relying on a hardcoded example — switching a row's provider clears its model field for exactly this reason, so you never accidentally send one provider's slug to another.

For each row you use:

1. Pick a **provider** from the dropdown.
2. Paste in that provider's **API key**. Keys are stored only in your browser (`chrome.storage.local`) and are sent only to that provider's own API host — never bundled into the extension, never sent anywhere else, and never sent to any provider other than the one selected for that row.
3. Paste in a **model slug** from that provider's current model catalog (see table above).
4. Click that row's **Test** button. This sends one small real request to that provider so an invalid key or a mistyped/retired model slug is caught immediately, instead of failing silently later on a Scholar page.
5. Optionally enable **"Only use this key if the others fail."** This keeps the key as a backup and only uses it — and only bills it — if every regular row fails or times out on a given paper.

Click **Save**, then open any search page on `scholar.google.com`. Badges will appear automatically beside each result.

> Without any API key configured, Lens⁸¹ still works by using a lower-confidence keyword-based prediction instead of AI classification.

---

## Collections

A lightweight, local-only way to organize papers into project buckets — think Spotify/YouTube playlists, not a reference manager. No accounts, no sync, no cloud, no citations, no PDFs.

* On any Scholar result, once the badge is confirmed you'll see a small **➕ Save** control next to it. Click it to check/uncheck collections from an inline list — it saves instantly, no separate Save button needed.
* **+ New Collection** creates one on the spot (duplicate names are rejected) and immediately saves the current paper into it.
* A paper can belong to any number of collections at once; removing it from one doesn't touch the others.
* Once saved anywhere, the control becomes **✔ Saved** and a folder chip (e.g. `📁 Thesis • Read Later`) appears beside it — including the next time you load the same search.
* The toolbar popup lists every collection with its paper count, a shortcut to create a new one, and **⬇ Export All**. Clicking a collection opens a full page listing its papers, with rename, delete, and **⬇ Export Collection**.
* Export formats: **CSV**, **Excel (.xlsx)**, **JSON**, **BibTeX (.bib)**, and **Markdown** — all generated locally, no network call involved.

---

## Reliability

Lens⁸¹ includes several safeguards so slow networks or interrupted requests never leave the page looking broken.

* Every network request has its own timeout, and the complete classification pipeline is limited to 20 seconds. If it runs long, Lens⁸¹ falls back to the keyword-based prediction.
* If the browser's background worker never responds at all, the page stops waiting after 25 seconds instead of leaving a loading badge indefinitely.
* A model that fails partway through — a rate limit, a bad model slug, a transient outage — is reported explicitly in the "why" panel rather than just quietly vanishing, so it's clear which specific model needs attention.
* Per-tab Research/Review counts survive Chrome unloading the extension's background worker, so switching away from a tab and back doesn't reset them to zero.
* Closing a tab while classification is in progress is handled cleanly without console errors.

---

## Known Limitations

* **Cached results don't know your configuration changed.** Classifications are cached for 30 days per title. If you add or change models after a paper was already classified, revisiting it will keep showing the older cached result until it expires — use **Clear cache** on the settings page after changing your setup to force reclassification.
* **Selectors are fragile.** Google Scholar's markup can change over time; if badges stop appearing, that's the first thing to check.
* **Chrome only, for now.** Manifest V3's service-worker background model isn't shared by Firefox, so a Firefox build would need its own manifest.
* **Not every paper is indexed** in Semantic Scholar or OpenAlex, and some publishers withhold abstracts, so the keyword-based fallback will trigger for a portion of results.
* **Title matching is approximate.** A similarity check filters out obviously wrong matches, but very generic titles could occasionally pull the wrong paper's abstract.

---

## Future Plans

* Support additional paper categories (Survey, Meta-analysis, Systematic Review)
* Confidence score tuning and calibration
* Paper summarization
* Citation insights
* Firefox support
* Dark mode improvements

---

## Contributing

Suggestions, feature requests, and pull requests are always welcome.

---

## Disclaimer

Classification is AI-assisted and may not always be correct. It is designed to help you quickly understand what you're looking at, not to replace reading the paper itself. Please verify classifications whenever accuracy is important.

---

## Version History

**V1**
Original release. Single OpenRouter API key with one model, abstract lookup using Semantic Scholar/OpenAlex, instant title-based predictions, per-tab counter, and local caching.

**V2**
Introduced the multi-model ensemble. Up to five API keys, each with its own model, classify every paper in parallel. Results are combined by averaging Research and Review probabilities.

**V3**
Added explainability and reliability improvements. Clicking a badge now shows the complete reasoning, including every model's individual response. Introduced cost-saving fallback keys and improved handling of slow networks, stalled requests, and tabs closing during classification.

**V4**
Each of the five model rows can now independently use **OpenRouter, Google Gemini, or xAI Grok**, mixed and matched however you like — including across the "always" vs. "only if needed" fallback split. Introduced **Collections**: a local, account-free way to save papers into project buckets and export them as CSV, Excel, JSON, BibTeX, or Markdown.

---

Built with the goal of making academic literature exploration a little easier for every student and early-career researcher.


*Sarthak Turkane* <3
