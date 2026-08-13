// background.js (MV3 service worker)
// Handles messages from content.js: looks up an abstract, classifies it,
// caches the result, and returns it.
//
// Two reliability rules this file follows, because a service worker can be
// suspended by Chrome at any time (e.g. when its tab isn't focused):
//   1. Every network call has a timeout, so one stalled request can't leave
//      a badge stuck on "checking…" forever.
//   2. Per-tab counters live in chrome.storage.session, not a plain JS
//      variable, so they survive the worker being unloaded and restarted.

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// --- Title-only heuristic keyword sets ---------------------------------
// Used only when no LLM is configured, or every configured model failed to
// respond for this specific paper — see heuristicClassify() below. Split
// into confidence tiers rather than one flat regex, since "systematic
// review" in a title is a far stronger signal than a bare "review", and a
// title with a strong *research* signal (e.g. "randomized controlled
// trial") shouldn't be left in the same low-confidence "no signal found"
// bucket as a title with genuinely no indicators either way.

// Near-unambiguous review-type phrasing — these essentially never appear
// in a primary-research paper's title.
const REVIEW_STRONG_KEYWORDS =
  /\b(systematic review|scoping review|umbrella review|narrative review|literature review|integrative review|meta-analysis|meta analysis|review article|comprehensive review|state-of-the-art review|critical review)\b/i;

// Weaker/broader review-type phrasing — usually a review, but with more
// exceptions than the strong list, so it's weighted lower.
const REVIEW_WEAK_KEYWORDS =
  /\b(review|overview of|current state of|recent advances in|recent progress in|state of the art|survey of the (literature|evidence)|trends? in|perspectives? on|what do we know about|where (are|do) we (now|stand))\b/i;

// "survey" is genuinely ambiguous on its own — it's just as often a
// *research-method* term (a questionnaire-based primary study, e.g. "A
// survey of 500 clinicians' attitudes toward X") as it is shorthand for a
// literature survey/review. Rather than guess from the bare word, only the
// unambiguous "survey of the literature/evidence" phrasing counts as a
// review signal (see REVIEW_WEAK_KEYWORDS above); the common
// research-method phrasings below are treated as a positive Research
// signal instead, folded into RESEARCH_STRONG_KEYWORDS.
const SURVEY_AS_RESEARCH_METHOD =
  /\bsurvey\s+(?:of|among)\s+(?:\d+\s+)?[a-z]+(?:\s+(?:patients|participants|respondents|clinicians|physicians|students|nurses|adults|children))?|\b(cross-sectional|online|national|prospective|retrospective|questionnaire)[- ]survey\b|\bsurvey\s+(study|design)\b/i;

// Strong indicators of primary/original research — a positive signal for
// "Research" rather than just "absence of a review keyword". Reduces both
// false "Review" classifications (a title can contain an incidental word
// like "review" in an unrelated sense — "peer review", "under review as
// of...") and low-confidence guessing on titles that actually do describe
// their own method clearly.
const RESEARCH_STRONG_KEYWORDS = new RegExp(
  '\\b(randomi[sz]ed controlled trial|\\bRCTs?\\b|cohort study|case-control study|cross-sectional study|' +
    'clinical trial|in vitro|in vivo|pilot study|observational study|retrospective (study|cohort|analysis)|' +
    'prospective (study|cohort)|randomi[sz]ed trial|double-blind|placebo-controlled|' +
    'we (investigated|examined|analy[sz]ed|report|conducted|present|propose|demonstrate|show|found))\\b|' +
    SURVEY_AS_RESEARCH_METHOD.source,
  'i'
);

// Common phrasings where "review" appears but has nothing to do with the
// paper's own type — "peer review", "under review", "peer-reviewed
// journal" etc. Checked before treating a bare "review" match as a review
// signal, so a research paper that happens to mention peer review in its
// title isn't misclassified.
const REVIEW_FALSE_POSITIVE_CONTEXT = /\b(peer[- ]review(ed)?|under review|review board|review process)\b/i;

const ABSTRACT_TIMEOUT_MS = 6000;
const LLM_TIMEOUT_MS = 12000;
const TEST_TIMEOUT_MS = 8000;
// Hard ceiling on the whole classifyPaper() pipeline (abstract lookup, then
// the model ensemble). Individual network calls already time out on their
// own, but nothing previously bounded the *combined* worst case — a slow
// abstract lookup stacked with a slow model call could together run long
// enough that Chrome tears down the message channel back to content.js
// before sendResponse() ever fires ("the message port closed before a
// response was received"), leaving that paper's badge stuck pending
// forever. This guarantees classifyPaper() always settles well before that,
// falling back to the keyword heuristic if the real pipeline is too slow.
const OVERALL_CLASSIFY_TIMEOUT_MS = 20000;

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    chrome.storage.session.remove(tabStatsKey(tabId)).catch(() => {});
    setBadge(tabId, '', null);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'CLASSIFY_PAPER') {
    classifyPaper(message.title)
      .then(async (result) => {
        if (sender.tab?.id != null) await recordStat(sender.tab.id, result);
        sendResponse(result);
      })
      .catch(() => sendResponse({ error: 'unavailable' }));
    return true; // keep the message channel open for the async sendResponse
  }

  if (message?.type === 'GET_TAB_STATUS') {
    getTabStats(message.tabId).then(sendResponse);
    return true;
  }

  if (message?.type === 'TEST_KEY') {
    testKey(message.provider, message.key, message.model)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, message: String(err) }));
    return true;
  }

  return false;
});

// --- Per-tab stats, persisted so a worker restart doesn't lose them -------

function tabStatsKey(tabId) {
  return `tabstats:${tabId}`;
}

async function getTabStats(tabId) {
  const stored = await chrome.storage.session.get(tabStatsKey(tabId));
  return stored[tabStatsKey(tabId)] || { research: 0, review: 0, total: 0 };
}

async function recordStat(tabId, result) {
  const stats = await getTabStats(tabId);
  if (result.type === 'Review') stats.review += 1;
  else if (result.type === 'Research') stats.research += 1;
  else return; // classification errored out — don't count it
  stats.total += 1;

  await chrome.storage.session.set({ [tabStatsKey(tabId)]: stats });
  setBadge(tabId, String(stats.total), '#06AED5');
}

// Classification can now take up to ~20s (see OVERALL_CLASSIFY_TIMEOUT_MS),
// which is plenty of time for the person to close the tab before a result
// comes back. chrome.action.setBadgeText/setBadgeBackgroundColor throw
// "No tab with id: <id>" in that case — an entirely expected race, not a
// real failure — so it's swallowed here instead of surfacing as an
// unhandled promise rejection in the service worker's console.
function setBadge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

// --- Networking helper -----------------------------------------------------

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- Classification pipeline ------------------------------------------------

async function classifyPaper(title) {
  const cacheKey = 'classify:' + normalize(title);
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const result = await withOverallTimeout(
    classifyUncached(title),
    OVERALL_CLASSIFY_TIMEOUT_MS,
    () => heuristicClassify(title)
  );

  await setCache(cacheKey, result);
  return result;
}

async function classifyUncached(title) {
  const abstract = await fetchAbstract(title);
  // If no abstract was found, still ask the AI — using just the title is
  // meaningfully better than a keyword regex — before falling back further.
  return abstract ? await classifyWithLLM(title, abstract) : await classifyTitleOnly(title);
}

// Races `promise` against a timer. Whichever settles first wins; the loser
// is simply ignored (its own timeouts/AbortControllers still clean it up
// independently). Used so classifyPaper() can never take meaningfully
// longer than `ms`, regardless of how slow the network calls inside it are.
function withOverallTimeout(promise, ms, fallbackFn) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallbackFn());
    }, ms);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallbackFn());
      }
    );
  });
}

async function testKey(provider, key, model) {
  if (!key || !model) return { ok: false, message: 'Add both a key and a model first.' };

  const result = await callProviderChat(
    provider,
    key,
    model,
    'Reply with the single word: ok',
    TEST_TIMEOUT_MS
  );

  if (result.ok) return { ok: true, message: 'Connected.' };
  return { ok: false, message: result.message };
}

function normalize(text) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function getCache(key) {
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key];
  if (!entry || Date.now() - entry.savedAt > CACHE_TTL_MS) return null;
  // Entries saved by a pre-ensemble-reasoning version of this extension
  // won't have `reason`/`details` — treat them as a miss so the paper gets
  // reclassified once (and re-cached in the new shape) instead of silently
  // showing an empty "why" panel until the 30-day TTL clears it out.
  if (!('reason' in entry.value) || !('details' in entry.value)) return null;
  return entry.value;
}

async function setCache(key, value) {
  await chrome.storage.local.set({ [key]: { value, savedAt: Date.now() } });
}

// --- Abstract lookup ------------------------------------------------------

function titleSimilarity(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (longer.includes(shorter)) return shorter.length / longer.length;
  const aTokens = new Set(a.split(' '));
  const bTokens = new Set(b.split(' '));
  const overlap = [...aTokens].filter((t) => bTokens.has(t)).length;
  return overlap / Math.max(aTokens.size, bTokens.size);
}

// Semantic Scholar and OpenAlex are queried in parallel — previously this
// waited for Semantic Scholar to finish (or time out) before ever trying
// OpenAlex, which roughly doubled the wait on any paper Semantic Scholar
// doesn't have. Whichever answers first with a usable abstract wins.
async function fetchAbstract(title) {
  const [ss, oa] = await Promise.allSettled([
    fetchFromSemanticScholar(title),
    fetchFromOpenAlex(title),
  ]);
  if (ss.status === 'fulfilled' && ss.value) return ss.value;
  if (oa.status === 'fulfilled' && oa.value) return oa.value;
  return null;
}

async function fetchFromSemanticScholar(title) {
  const url =
    'https://api.semanticscholar.org/graph/v1/paper/search' +
    `?query=${encodeURIComponent(title)}&fields=title,abstract&limit=1`;
  const res = await fetchWithTimeout(url, {}, ABSTRACT_TIMEOUT_MS);
  if (!res.ok) return null;
  const data = await res.json();
  const paper = data?.data?.[0];
  if (!paper?.abstract) return null;
  if (titleSimilarity(title, paper.title) < 0.6) return null;
  return paper.abstract;
}

async function fetchFromOpenAlex(title) {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=1`;
  const res = await fetchWithTimeout(url, {}, ABSTRACT_TIMEOUT_MS);
  if (!res.ok) return null;
  const data = await res.json();
  const work = data?.results?.[0];
  if (!work) return null;
  if (titleSimilarity(title, work.display_name) < 0.6) return null;
  // OpenAlex stores abstracts as a word -> positions map, not plain text.
  return reconstructAbstract(work.abstract_inverted_index);
}

function reconstructAbstract(invertedIndex) {
  if (!invertedIndex) return null;
  const positions = [];
  for (const [word, indices] of Object.entries(invertedIndex)) {
    for (const idx of indices) positions[idx] = word;
  }
  const text = positions.join(' ').trim();
  return text || null;
}

// --- Classification ---------------------------------------------------

// Scores a title against the keyword sets above into a
// { type, confidence, signal } guess — confidence is tiered by how strong
// and unambiguous the matched signal is, rather than a single flat number
// regardless of whether a title screamed "systematic review" or matched
// nothing at all. Kept separate from heuristicClassify() so it's easy to
// unit-test in isolation from the ensemble/attempts plumbing.
function scoreTitleHeuristic(title) {
  const strongReview = title.match(REVIEW_STRONG_KEYWORDS);
  if (strongReview) {
    return { type: 'Review', confidence: 88, signal: `the strong review-type phrase "${strongReview[0]}"` };
  }

  const strongResearch = title.match(RESEARCH_STRONG_KEYWORDS);
  if (strongResearch) {
    return { type: 'Research', confidence: 80, signal: `the study-design phrase "${strongResearch[0]}"` };
  }

  const weakReview = title.match(REVIEW_WEAK_KEYWORDS);
  if (weakReview) {
    const isBareReview = /^review$/i.test(weakReview[0]);
    if (!isBareReview || !REVIEW_FALSE_POSITIVE_CONTEXT.test(title)) {
      return { type: 'Review', confidence: 68, signal: `the review-type phrase "${weakReview[0]}"` };
    }
  }

  // No usable signal either way — this is a genuine guess, not a detected
  // pattern, and the confidence reflects that (an LLM classification, even
  // title-only, is meaningfully better here — see classifyTitleOnly).
  return { type: 'Research', confidence: 52, signal: null };
}

// `callResult` is what callEnsembleClassifier() returned: null if zero
// models are configured at all, or { attempts } if models are configured
// but every one of them failed/timed out for this specific paper. The
// message and source differ between those two cases — conflating them
// used to make "all your models are failing" look identical to "you never
// configured any," which made real problems (bad model slug, rate limits,
// an OpenRouter outage) invisible.
function heuristicClassify(title, callResult) {
  const { type, confidence, signal } = scoreTitleHeuristic(title);
  const titleReason = signal
    ? `Title contains ${signal}.`
    : 'Title has no clear review- or study-design indicators, so this defaults to Research with low confidence. An actual model would do much better here.';

  if (callResult && Array.isArray(callResult.attempts) && callResult.attempts.length > 0) {
    const n = callResult.attempts.length;
    return {
      type,
      confidence,
      source: 'title-heuristic-all-failed',
      reason: `All ${n} configured model${n > 1 ? 's' : ''} failed to respond for this paper (see attempts below), so this falls back to a keyword-only guess. ${titleReason}`,
      // Keep the failed attempts visible in the "why" panel instead of
      // silently dropping them — this is what makes a rate-limited or
      // misconfigured model visible instead of just quietly vanishing.
      details: callResult.attempts.map(attemptToDetail),
    };
  }

  return {
    type,
    confidence,
    source: 'title-heuristic',
    reason: titleReason,
    details: [],
  };
}

async function classifyWithLLM(title, abstract) {
  const result = await callEnsembleClassifier(buildAbstractPrompt(title, abstract));
  if (result && result.successes.length > 0) {
    return { ...ensemble(result.successes, result.attempts), source: 'llm' };
  }
  return heuristicClassify(title, result);
}

// Used when no abstract could be found. A title-only guess from an actual
// model is still meaningfully better than a fixed keyword regex, and is
// labeled distinctly in the UI so it isn't confused with an abstract-verified
// result.
async function classifyTitleOnly(title) {
  const result = await callEnsembleClassifier(buildTitleOnlyPrompt(title));
  if (result && result.successes.length > 0) {
    return { ...ensemble(result.successes, result.attempts), source: 'llm-title-only' };
  }
  return heuristicClassify(title, result);
}


function buildAbstractPrompt(title, abstract) {
  return `You are an expert at identifying academic paper types.
Classify the paper as exactly one of: "Research Paper" or "Review Paper".

Title: ${title}
Abstract: ${abstract}

Respond with ONLY compact JSON, no other text:
{"prediction":"Research" or "Review","research_probability":0-1,"review_probability":0-1,"reason":"one short sentence explaining why, based on the abstract"}`;
}

function buildTitleOnlyPrompt(title) {
  return `You are an expert at identifying academic paper types.
No abstract is available for this paper. Using only the title and your general knowledge of how research papers versus review papers are typically titled in this field, make your best judgment. Reflect your reduced certainty in the probabilities.

Title: ${title}

Classify as exactly one of: "Research Paper" or "Review Paper".
Respond with ONLY compact JSON, no other text:
{"prediction":"Research" or "Review","research_probability":0-1,"review_probability":0-1,"reason":"one short sentence explaining why, based on the title"}`;
}

// --- Multi-model ensemble ---------------------------------------------------
//
// Up to 5 OpenRouter (key, model) pairs can be configured. The exact same
// prompt is sent to every "always" pair in parallel via Promise.allSettled
// so that a failure or timeout on one model never blocks the others. Pairs
// marked "only use if needed" are held back and only called if none of the
// "always" pairs came back usable. Each model is expected to return
// {prediction, research_probability, review_probability}; the probabilities
// from every model that answered successfully are averaged to produce the
// final result.

// Reads the configured (key, model, onlyIfNeeded) tuples from storage.
// Supports the new `openrouterConfigs` array (up to 5 entries) and falls
// back to the legacy single `openrouterKey` / `openrouterModel` fields so
// existing installs keep working without any migration step.
async function getConfiguredPairs() {
  const stored = await chrome.storage.local.get([
    'openrouterConfigs',
    'openrouterKey',
    'openrouterModel',
  ]);

  let configs = Array.isArray(stored.openrouterConfigs) ? stored.openrouterConfigs : [];
  configs = configs
    .filter((c) => c && typeof c.key === 'string' && typeof c.model === 'string')
    .map((c) => ({
      // Rows saved before multi-provider support has no `provider` field at
      // all — those were always OpenRouter, so default to that rather than
      // silently dropping the row or misrouting the key.
      provider: PROVIDER_CALLERS[c.provider] ? c.provider : 'openrouter',
      key: c.key.trim(),
      model: c.model.trim(),
      onlyIfNeeded: Boolean(c.onlyIfNeeded),
    }))
    .filter((c) => c.key && c.model)
    .slice(0, 5);

  if (configs.length === 0 && stored.openrouterKey && stored.openrouterModel) {
    configs = [{ provider: 'openrouter', key: stored.openrouterKey, model: stored.openrouterModel, onlyIfNeeded: false }];
  }

  return configs;
}

// Shared OpenRouter call used by both classification paths above.
// Returns:
//   - null                          if zero models are configured at all
//   - { successes, attempts }       if models are configured — `successes`
//                                    is what actually produced a usable
//                                    prediction (may be empty), `attempts`
//                                    is every pair that was tried, success
//                                    or not, so a failure is never just
//                                    silently dropped on the floor.
//
// Each configured pair can be marked "only use if needed" on the settings
// page. Those are held back and only called if every regular ("always")
// pair failed/timed out/errored — so a cheap or rate-limited backup key
// isn't spending a request on every single paper, only on the ones the
// primary model(s) couldn't handle.
async function callEnsembleClassifier(prompt) {
  const pairs = await getConfiguredPairs();
  if (pairs.length === 0) return null;

  const always = pairs.filter((p) => !p.onlyIfNeeded);
  const fallback = pairs.filter((p) => p.onlyIfNeeded);

  let attempts = await runPairs(always, prompt);
  let successes = attempts.filter((a) => a.ok);

  if (successes.length === 0 && fallback.length > 0) {
    const fallbackAttempts = await runPairs(fallback, prompt);
    attempts = attempts.concat(fallbackAttempts);
    successes = fallbackAttempts.filter((a) => a.ok);
  }

  return { successes, attempts };
}

// Runs a group of (key, model) pairs in parallel via Promise.allSettled and
// returns an attempt record for every single one — never just the ones
// that worked. This is what makes a rate-limited or misconfigured model
// visible in the "why" panel instead of silently vanishing, which
// previously made "3 models configured, 1 responding" look identical to
// "only 1 model was ever configured."
async function runPairs(pairs, prompt) {
  if (pairs.length === 0) return [];

  const settled = await Promise.allSettled(
    pairs.map((pair) => callSingleModel(pair.provider, pair.key, pair.model, prompt))
  );

  return settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    // callSingleModel is written to never reject in practice, but if some
    // unexpected exception did slip through, still surface it as a
    // recognizable failed attempt rather than losing the model entirely.
    return { model: pairs[i].model, ok: false, message: String(s.reason?.message || s.reason || 'Unknown error') };
  });
}

// --- Per-provider chat callers ----------------------------------------
//
// Each configured row can independently be OpenRouter, Google Gemini, xAI
// Grok, or Groq — different request/response shapes hitting different
// hosts. Each function below always resolves (never rejects) with either
// { ok: true, text } or { ok: false, message }, so callSingleModel() can
// treat all of them identically afterward.

async function callOpenRouterChat(key, model, prompt, timeoutMs) {
  try {
    const res = await fetchWithTimeout(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
        }),
      },
      timeoutMs
    );

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const detail = body?.error?.message || `HTTP ${res.status}`;
      // OpenRouter/most providers return 429 for rate limiting — the classic
      // cause of ":free" models (capped ~20 req/min) failing partway through
      // a results page while other configured models keep succeeding.
      const message = res.status === 429 ? `Rate limited (${detail})` : detail;
      return { ok: false, message };
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return { ok: true, text };
  } catch (err) {
    return { ok: false, message: err?.name === 'AbortError' ? 'Timed out.' : 'Network error.' };
  }
}

// xAI's Grok API is OpenAI-compatible, so the request/response shape is
// identical to OpenRouter's — only the host and (implicitly) the model
// catalog differ.
async function callGrokChat(key, model, prompt, timeoutMs) {
  try {
    const res = await fetchWithTimeout(
      'https://api.x.ai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
        }),
      },
      timeoutMs
    );

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const detail = body?.error?.message || `HTTP ${res.status}`;
      const message = res.status === 429 ? `Rate limited (${detail})` : detail;
      return { ok: false, message };
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return { ok: true, text };
  } catch (err) {
    return { ok: false, message: err?.name === 'AbortError' ? 'Timed out.' : 'Network error.' };
  }
}

// Google's Generative Language API (Gemini). Auth is a `key` query param
// rather than a header, and the request/response envelope (`contents` /
// `candidates`) is shaped differently from the OpenAI-style chat APIs
// above, so this can't share their request builder.
async function callGeminiChat(key, model, prompt, timeoutMs) {
  try {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent` +
      `?key=${encodeURIComponent(key)}`;
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0 },
        }),
      },
      timeoutMs
    );

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const detail = body?.error?.message || `HTTP ${res.status}`;
      const message = res.status === 429 ? `Rate limited (${detail})` : detail;
      return { ok: false, message };
    }

    const data = await res.json();
    const candidate = data?.candidates?.[0];
    const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('');
    // Gemini can stop for safety filters or other reasons without ever
    // producing text, which would otherwise look like a generic "response
    // wasn't in the expected format" parse failure instead of the real cause.
    if (!text && candidate?.finishReason && candidate.finishReason !== 'STOP') {
      return { ok: false, message: `Gemini stopped early (${candidate.finishReason}).` };
    }
    return { ok: true, text };
  } catch (err) {
    return { ok: false, message: err?.name === 'AbortError' ? 'Timed out.' : 'Network error.' };
  }
}

// Groq's API is also OpenAI-compatible (hosts fast inference for open
// models like Llama/Mixtral/Gemma) — same request/response shape as
// OpenRouter and Grok, just a different host and model catalog.
async function callGroqChat(key, model, prompt, timeoutMs) {
  try {
    const res = await fetchWithTimeout(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
        }),
      },
      timeoutMs
    );

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const detail = body?.error?.message || `HTTP ${res.status}`;
      const message = res.status === 429 ? `Rate limited (${detail})` : detail;
      return { ok: false, message };
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    return { ok: true, text };
  } catch (err) {
    return { ok: false, message: err?.name === 'AbortError' ? 'Timed out.' : 'Network error.' };
  }
}

const PROVIDER_CALLERS = {
  openrouter: callOpenRouterChat,
  grok: callGrokChat,
  gemini: callGeminiChat,
  groq: callGroqChat,
};

function callProviderChat(provider, key, model, prompt, timeoutMs) {
  const caller = PROVIDER_CALLERS[provider] || PROVIDER_CALLERS.openrouter;
  return caller(key, model, prompt, timeoutMs);
}

// Calls a single (provider, key, model) trio with the given prompt and
// parses its response. Always resolves (never rejects) with an attempt
// record — { model, ok: true, ...prediction } on success, or
// { model, ok: false, message } describing exactly why it failed
// (timed out, bad HTTP status, unparseable output) — so the caller always
// has something concrete to show the user instead of just "it didn't work."
async function callSingleModel(provider, key, model, prompt) {
  const result = await callProviderChat(provider, key, model, prompt, LLM_TIMEOUT_MS);
  if (!result.ok) return { model, ok: false, message: result.message };

  const parsed = parseModelOutput(result.text);
  if (!parsed) return { model, ok: false, message: "Response wasn't in the expected format." };
  return { model, ok: true, ...parsed };
}

// Converts one attempt record (success or failure) into the shape the
// "why" panel renders. Kept separate from ensemble() so heuristicClassify()
// can reuse it too when every model failed.
function attemptToDetail(a) {
  if (a.ok) {
    return {
      model: a.model,
      prediction: a.prediction,
      research_probability: a.research_probability,
      review_probability: a.review_probability,
      reason: a.reason || '',
    };
  }
  return { model: a.model, failed: true, message: a.message || 'Failed to respond.' };
}

// Combines the individually self-consistent predictions from every model
// that answered successfully (see parseModelOutput — each one's prediction
// already matches its own probabilities) into a final result:
//   - type: whichever prediction the majority of responding models agreed
//     on. Ties (including a single model with no majority to speak of) are
//     broken by whichever has the higher averaged probability. Previously
//     this was decided purely by averaged probability, which let one
//     model with an extreme, overconfident probability pair (e.g. 0.99/
//     0.01) silently override an actual 2-1 majority the other direction —
//     the "why" panel would then say something like "1 of 3 models
//     classified this as Research" for a *Research* result, which reads
//     as self-contradictory. Majority vote first means the reported
//     agreement count always actually supports the type shown.
//   - confidence: the averaged probability *for the winning type* — still
//     probability-weighted, just no longer able to overturn the vote.
function ensemble(successes, attempts) {
  const avgResearch = successes.reduce((sum, r) => sum + r.research_probability, 0) / successes.length;
  const avgReview = successes.reduce((sum, r) => sum + r.review_probability, 0) / successes.length;

  const researchVotes = successes.filter((r) => r.prediction === 'Research').length;
  const reviewVotes = successes.length - researchVotes;
  let type;
  if (researchVotes > reviewVotes) type = 'Research';
  else if (reviewVotes > researchVotes) type = 'Review';
  else type = avgResearch >= avgReview ? 'Research' : 'Review'; // tie: break by averaged probability

  const confidence = Math.round((type === 'Research' ? avgResearch : avgReview) * 100);

  const agreeing = successes.filter((r) => r.prediction === type).length;
  const failedCount = attempts.length - successes.length;
  let reason;
  if (successes.length === 1 && failedCount === 0) {
    reason = successes[0].reason || `Classified as ${type}.`;
  } else if (failedCount > 0) {
    reason = `${agreeing} of ${successes.length} responding model${successes.length > 1 ? 's' : ''} classified this as ${type} (${failedCount} of ${attempts.length} configured model${attempts.length > 1 ? 's' : ''} failed to respond, see below), averaging ${confidence}% confidence.`;
  } else {
    reason = `${agreeing} of ${successes.length} models classified this as ${type}, averaging ${confidence}% confidence.`;
  }

  return { type, confidence, reason, details: attempts.map(attemptToDetail) };
}

function parseModelOutput(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);

    let researchProb = Number(parsed.research_probability);
    let reviewProb = Number(parsed.review_probability);
    if (!Number.isFinite(researchProb) || !Number.isFinite(reviewProb)) return null;

    // Normalize in case a model's pair doesn't sum to exactly 1.
    const sum = researchProb + reviewProb;
    if (sum <= 0) return null;
    researchProb /= sum;
    reviewProb /= sum;

    // The prediction is derived from these same probabilities rather than
    // trusted from the model's separate `prediction` field — a model can
    // (and sometimes does) return a `prediction` that contradicts its own
    // probabilities, e.g. prediction:"Review" alongside
    // research_probability:0.6. Deriving it this way guarantees every
    // individual model's own result is internally consistent, which
    // ensemble() below then relies on for its majority vote to mean what
    // it says.
    const prediction = researchProb >= reviewProb ? 'Research' : 'Review';
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 300) : '';
    return { prediction, research_probability: researchProb, review_probability: reviewProb, reason };
  } catch {
    return null;
  }
}

// =============================================================================
// Highlight -> Find Citation (added in v6, pipeline rewritten in v6.1)
//
// The old pipeline reduced every highlighted passage to a handful of
// "important-looking" keywords (longest, stopword-stripped words) *before*
// ever hitting a search provider. That throws away word order, phrasing,
// author names, equations, and multi-word technical terms — exactly the
// context that actually identifies a source. This version instead searches
// with the passage's own wording first, and only degrades toward keywords
// as a last resort if that fails.
//
// Pipeline for one highlighted passage:
//   1. Check cache (30 days; cache key is mode-tagged so toggling the
//      optional AI key on/off never serves a stale result from the other
//      mode).
//   2. Try a sequence of "stages", each one less faithful to the original
//      wording than the last, stopping at the first stage that clears the
//      confidence bar:
//        a. Full text — whitespace-normalized, wording/order/casing
//           untouched. If it's short enough it's sent as one query; if it's
//           long, it's split into overlapping, sentence-boundary-respecting
//           chunks (see buildSearchPlan()) so nothing gets truncated mid-
//           sentence and every part of a long selection gets searched.
//        b. Stopwords removed (the/a/of/etc. stripped, everything else —
//           including word order — left alone) — only tried if (a) found
//           nothing confident enough.
//        c. Key phrases — contiguous runs of non-stopwords (multi-word
//           technical terms, names, clause fragments), each searched on its
//           own — only tried if (b) also came up short.
//        d. Bare keywords (the *old* primary strategy) — now purely a last
//           resort if (a)-(c) all failed to find anything.
//   3. Search Crossref + Semantic Scholar + OpenAlex in parallel for every
//      query in the winning stage (all free, no API key required), merge,
//      and de-dupe by title similarity (reusing titleSimilarity()).
//   4. Score every candidate against the *original* passage (not whatever
//      reduced query found it) using five independent similarity metrics —
//      token coverage, cosine, Jaccard, fuzzy token-sort, and Levenshtein —
//      combined into a single 0-100 confidence score. See computeConfidence().
//   5a. No citation key configured: drop anything below the confidence
//       threshold, keep the top 5 by score. Done — zero LLM calls.
//   5b. Citation key configured: send the top-10 locally-scored candidates
//       to that dedicated model, asking it to verify true relevance (not
//       just textual similarity), then blend its judgment with the local
//       confidence score (weighted toward the AI, since it can read for
//       meaning). Falls back to 5a automatically if the call fails.
//   6. Format the surviving candidates into APA/MLA/IEEE/BibTeX strings
//      (plain templates, not citeproc-js — see README) and return
//      everything to the content script for display/insertion.
// =============================================================================

const CITE_CACHE_TTL_MS = CACHE_TTL_MS; // reuse the same 30-day window
const CITE_SEARCH_TIMEOUT_MS = 8000;
const CITE_RERANK_TIMEOUT_MS = 12000; // only used if a citation-specific AI key is configured
const CITE_OVERALL_TIMEOUT_MS = 28000; // slightly higher than before: multiple stages/chunks may run
const CITE_AI_SHORTLIST_SIZE = 10; // how many locally-scored candidates get sent to the AI check
const CITE_MAX_RESULTS = 5;
const CITE_MAX_TEXT_CHARS = 6000; // defensive upper bound; cite.js's own selection cap is the real limit

// 0-100. A candidate needs at least this much combined-metric confidence to
// be suggested as a citation. Configurable via chrome.storage.local
// ('citeConfidenceThreshold', set from the options page) so people can
// loosen it for recall or tighten it for precision without a code change;
// falls back to this default if nothing is stored.
const CITE_DEFAULT_CONFIDENCE_THRESHOLD = 42;

// Any single search query longer than this is split into chunks instead of
// sent as-is — long enough to cover a couple of sentences of normal prose
// as a single query when the whole passage is short, short enough that
// provider APIs (and the per-chunk fan-out below) stay fast and precise.
const CITE_DIRECT_QUERY_MAX_CHARS = 300;
const CITE_CHUNK_TARGET_CHARS = 280;
// Cap on how many chunks/queries one passage can expand into, so a person
// highlighting several paragraphs can't turn one Cite click into dozens of
// parallel API calls. Very long selections are evenly resampled down to
// this many chunks rather than simply cut off, so the whole passage still
// gets *some* coverage.
const CITE_MAX_CHUNKS = 6;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'FIND_CITATIONS') {
    findCitations(message.text)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: 'unavailable' }));
    return true; // keep the message channel open for the async sendResponse
  }
  if (message?.type === 'FIND_PAPERS') {
    findPapers(message.text)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: 'unavailable' }));
    return true;
  }
  if (message?.type === 'RESOLVE_DOI') {
    resolveDoi(message.doi)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: 'unavailable' }));
    return true;
  }
  return false;
});

// --- Manual reference entry: resolve a bare DOI to full metadata -----------
// Used when someone pastes a DOI directly (see cite.js's "Add a source"
// panel and refparse.js's extractDoi()) instead of highlighting a passage
// to search for. This is a *direct* lookup by exact identifier — Crossref's
// and OpenAlex's own /works/{doi} endpoints, not the fuzzy multi-candidate
// search findCitations() uses — so it's far more reliable than a text
// search whenever the person already knows exactly what they want to cite.
const RESOLVE_DOI_TIMEOUT_MS = 8000;

async function resolveDoi(rawDoi) {
  const doi = (rawDoi || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  if (!doi || !/^10\.\d{4,9}\/\S+$/.test(doi)) {
    return { ok: false, error: 'invalid-doi' };
  }

  const cached = await getCiteCache('doi:' + citeHash(doi.toLowerCase()));
  if (cached) return cached;

  let paper = await resolveDoiViaCrossref(doi);
  if (!paper) paper = await resolveDoiViaOpenAlex(doi);

  // Reuses the exact same shaping toResultShape() applies to search
  // candidates (including the hand-rolled fallback citation strings) —
  // this is what lets a DOI-resolved paper flow through cite.js's existing
  // result-row rendering, Insert/Copy, and BibTeX fallback with zero
  // special-casing. ieeeIndex is fixed at 1 since a manually-resolved
  // paper isn't part of a ranked list with its own position.
  const result = paper ? { ok: true, paper: toResultShape(paper, 1) } : { ok: false, error: 'not-found' };
  if (result.ok) await setCiteCache('doi:' + citeHash(doi.toLowerCase()), result);
  return result;
}

async function resolveDoiViaCrossref(doi) {
  try {
    const res = await fetchWithTimeout(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
      {},
      RESOLVE_DOI_TIMEOUT_MS
    );
    if (!res.ok) return null;
    const data = await res.json();
    const it = data?.message;
    if (!it || !Array.isArray(it.title) || !it.title[0]) return null;
    return {
      title: it.title[0],
      authors: (it.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean),
      year:
        it['published-print']?.['date-parts']?.[0]?.[0] ||
        it['published-online']?.['date-parts']?.[0]?.[0] ||
        it.issued?.['date-parts']?.[0]?.[0] ||
        null,
      venue: (it['container-title'] || [])[0] || '',
      doi: it.DOI || doi,
      url: it.URL || `https://doi.org/${doi}`,
    };
  } catch {
    return null;
  }
}

async function resolveDoiViaOpenAlex(doi) {
  try {
    const res = await fetchWithTimeout(
      `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`,
      {},
      RESOLVE_DOI_TIMEOUT_MS
    );
    if (!res.ok) return null;
    const w = await res.json();
    if (!w || !w.display_name) return null;
    return {
      title: w.display_name,
      authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
      year: w.publication_year || null,
      venue: w.host_venue?.display_name || w.primary_location?.source?.display_name || '',
      doi: (w.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') || doi,
      url: w.doi || `https://doi.org/${doi}`,
    };
  } catch {
    return null;
  }
}

// --- Cache -------------------------------------------------------------
// Deliberately separate from getCache()/setCache() above: those validate
// that a cached value has classification-specific fields (`reason`,
// `details`), which citation results don't have — reusing them as-is would
// make every citation lookup look like a permanent cache miss. Same TTL
// approach, own key prefix, no shared state with the classification cache.

async function getCiteCache(key) {
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key];
  if (!entry || Date.now() - entry.savedAt > CITE_CACHE_TTL_MS) return null;
  return entry.value;
}

async function setCiteCache(key, value) {
  await chrome.storage.local.set({ [key]: { value, savedAt: Date.now() } });
}

// Small non-cryptographic hash (djb2) so a long highlighted paragraph
// doesn't itself become the storage key — this is a local cache, not a
// security boundary, so collisions being astronomically unlikely is enough.
function citeHash(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 33) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

async function getCiteConfidenceThreshold() {
  const stored = await chrome.storage.local.get('citeConfidenceThreshold');
  const value = Number(stored.citeConfidenceThreshold);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : CITE_DEFAULT_CONFIDENCE_THRESHOLD;
}

// --- Entry point ---------------------------------------------------------

async function findCitations(rawText) {
  const text = (rawText || '').trim();
  if (!text) return { ok: false, error: 'empty' };

  // A person can highlight a whole paragraph or more; bound the search size
  // rather than rejecting long selections outright — chunking (below)
  // handles the rest, this is just a sanity ceiling.
  const claimText = text.length > CITE_MAX_TEXT_CHARS ? text.slice(0, CITE_MAX_TEXT_CHARS) : text;

  const citeConfig = await getCiteApiConfig();
  // Mode-tagged cache key: turning the optional AI key on/off later must
  // never silently serve a cached result computed under the other mode.
  const cacheKey = 'cite:' + (citeConfig ? 'ai:' : 'kw:') + citeHash(normalize(claimText));
  const cached = await getCiteCache(cacheKey);
  if (cached) return cached;

  const result = await withOverallTimeout(
    findCitationsUncached(claimText, citeConfig),
    CITE_OVERALL_TIMEOUT_MS,
    () => ({ ok: false, error: 'timeout' })
  );

  if (result.ok) await setCiteCache(cacheKey, result);
  return result;
}

// --- "Find" — top papers for a passage, no confidence gate -----------------
// FIND_CITATIONS (above) is deliberately strict: it only ever returns a
// candidate confident enough to actually cite as support for the exact
// passage, and returns an explicit "nothing matched closely enough" error
// otherwise — that's the right behavior for "insert a citation," where a
// weak/tangential match would be actively misleading in someone's document.
// But that same strictness is a dead end for "just show me papers related
// to this" — highlighting a passage and getting told "nothing matched
// closely enough" with no other option isn't useful when what the person
// actually wanted was a reading list, not a citation. FIND_PAPERS reuses
// the exact same search (Crossref + Semantic Scholar + OpenAlex, merged
// and scored the same way) but skips the threshold filter entirely and
// just returns the top 3 candidates by score, whatever that score is — the
// person judges relevance themselves, the same way they would on Google
// Scholar itself.
const CITE_FIND_MAX_RESULTS = 3;

async function findPapers(rawText) {
  const text = (rawText || '').trim();
  if (!text) return { ok: false, error: 'empty' };
  const claimText = text.length > CITE_MAX_TEXT_CHARS ? text.slice(0, CITE_MAX_TEXT_CHARS) : text;

  const cacheKey = 'find:' + citeHash(normalize(claimText));
  const cached = await getCiteCache(cacheKey);
  if (cached) return cached;

  const result = await withOverallTimeout(findPapersUncached(claimText), CITE_OVERALL_TIMEOUT_MS, () => ({
    ok: false,
    error: 'timeout',
  }));

  if (result.ok) await setCiteCache(cacheKey, result);
  return result;
}

async function findPapersUncached(claimText) {
  // Only the primary (full-text/chunked) search — "find papers matching
  // this exact selected line" means searching with the passage's own
  // wording, not cascading through the stopword/keyword-stripped fallback
  // stages FIND_CITATIONS uses to chase a threshold. Those fallback stages
  // exist specifically to keep trying *because* the strict mode needs
  // something to clear a bar; Find doesn't have a bar to clear.
  const plan = buildSearchPlan(claimText);
  const candidates = await searchCandidatesForQueries(plan.queries);
  if (candidates.length === 0) return { ok: false, error: 'no-results' };

  const scored = scoreCandidates(claimText, candidates);
  const ranked = scored.sort((a, b) => b.confidence - a.confidence).slice(0, CITE_FIND_MAX_RESULTS);

  return {
    ok: true,
    source: 'find-search',
    results: ranked.map((c, i) => toResultShape({ ...c, relevance: c.confidence }, i + 1)),
  };
}

// --- Optional, separately-keyed AI relevance check --------------------------
// Off by default. When the person adds a dedicated key in Settings ->
// Citation Finder, that key/provider/model (never the classification rows
// from getConfiguredPairs()) is used to double-check relevance on the
// locally-shortlisted candidates. This is fully separate storage, so it
// can be a different, cheaper key than the classification ones, or left
// blank to keep this feature free.

async function getCiteApiConfig() {
  const stored = await chrome.storage.local.get('citeApiConfig');
  const config = stored.citeApiConfig;
  if (!config || !config.key || !config.model) return null;
  return { provider: config.provider || 'openrouter', key: config.key, model: config.model };
}

// --- Stage pipeline: full text -> stopwords removed -> key phrases -> keywords
//
// Each stage is tried in order against the *original* passage's wording for
// its search query; every stage's candidates are always scored against the
// full original passage (never against the reduced query text), so a later,
// cruder stage can still surface a candidate that scores well once judged
// against the real wording. The loop stops at the first stage whose best
// candidate clears the confidence threshold — later stages are strictly
// less faithful to what the person actually highlighted, so they're only
// worth trying if an earlier, more faithful stage came up empty.

function buildFallbackStages(claimText) {
  const stages = [];

  const primaryPlan = buildSearchPlan(claimText);
  stages.push({
    name: primaryPlan.mode === 'chunked' ? 'full-text-chunked' : 'full-text',
    queries: primaryPlan.queries,
  });

  const stripped = removeStopwords(claimText);
  if (stripped.trim() && normalize(stripped) !== normalize(claimText)) {
    const strippedPlan = buildSearchPlan(stripped);
    stages.push({ name: 'stopwords-removed', queries: strippedPlan.queries });
  }

  const phrases = extractPhrases(claimText);
  if (phrases.length > 0) {
    stages.push({ name: 'key-phrases', queries: phrases });
  }

  const keywords = naiveKeywords(claimText);
  if (keywords.length > 0) {
    stages.push({ name: 'keywords', queries: [keywords.join(' ')] });
  }

  return stages;
}

async function findCitationsUncached(claimText, citeConfig) {
  const threshold = await getCiteConfidenceThreshold();
  const stages = buildFallbackStages(claimText);

  let bestScored = null;
  let bestStage = null;
  let bestPeak = -1;

  for (const stage of stages) {
    const candidates = await searchCandidatesForQueries(stage.queries);
    if (candidates.length === 0) continue;

    // Always score against the real, original passage — the stage only
    // controls what was *searched for*, never what a match is judged against.
    const scored = scoreCandidates(claimText, candidates);
    const peak = scored.reduce((m, c) => Math.max(m, c.confidence), 0);

    if (peak > bestPeak) {
      bestScored = scored;
      bestStage = stage.name;
      bestPeak = peak;
    }

    if (peak >= threshold) break;
  }

  if (!bestScored) return { ok: false, error: 'no-results' };

  if (citeConfig) {
    const aiResult = await tryAiRerank(claimText, bestScored, citeConfig, threshold);
    if (aiResult) return { ...aiResult, stage: bestStage };
    // AI call failed/unparseable/timed out — fall through to the same
    // free local-only path below rather than failing the whole request,
    // just flagged so the person knows the AI check didn't run this time.
    return { ...localOnlyResult(bestScored, threshold), stage: bestStage, source: 'ai-rerank-failed' };
  }

  return { ...localOnlyResult(bestScored, threshold), stage: bestStage };
}

function localOnlyResult(scored, threshold) {
  const ranked = scored
    .filter((c) => c.confidence >= threshold)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, CITE_MAX_RESULTS);

  if (ranked.length === 0) {
    // Candidates came back, but none were confident enough matches to be
    // worth suggesting as a citation for this passage.
    return { ok: false, error: 'no-strong-match' };
  }

  return {
    ok: true,
    source: 'local-match',
    results: ranked.map((c, i) => toResultShape({ ...c, relevance: c.confidence }, i + 1)),
  };
}

// Sends a shortlist (the top candidates by local confidence score, so the
// most promising ones survive if the list has to be truncated) to the
// person's dedicated citation-checking model, asking it to verify each one
// actually supports the passage rather than just sharing vocabulary/structure
// with it. The AI's relevance judgment is blended with (not simply
// substituted for) the local multi-metric confidence score — weighted
// toward the AI, since it can read for meaning, but the local score still
// anchors it against a single confidently-wrong model judgment. Returns
// null on any failure so the caller can fall back to the free path instead
// of erroring out entirely.
async function tryAiRerank(claimText, scoredCandidates, citeConfig, threshold) {
  const shortlist = [...scoredCandidates].sort((a, b) => b.confidence - a.confidence).slice(0, CITE_AI_SHORTLIST_SIZE);

  const rerankResult = await callProviderChat(
    citeConfig.provider,
    citeConfig.key,
    citeConfig.model,
    buildRerankPrompt(claimText, shortlist),
    CITE_RERANK_TIMEOUT_MS
  );
  if (!rerankResult.ok) return null;

  const parsed = parseRerankOutput(rerankResult.text, shortlist.length);
  if (!parsed || parsed.length === 0) return null;

  const blended = parsed.map((r) => {
    const base = shortlist[r.index];
    const finalConfidence = Math.round(0.4 * base.confidence + 0.6 * r.relevance);
    return { ...base, relevance: finalConfidence, why: r.why };
  });

  const ranked = blended
    .filter((r) => r.relevance >= threshold)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, CITE_MAX_RESULTS);

  if (ranked.length === 0) {
    // The AI checked every shortlisted candidate and found none actually
    // support the passage — a real negative result, not a failure.
    return { ok: false, error: 'no-strong-match' };
  }

  return { ok: true, source: 'ai-reranked', results: ranked.map((c, i) => toResultShape(c, i + 1)) };
}

function buildRerankPrompt(claimText, candidates) {
  const list = candidates
    .map(
      (c, i) =>
        `${i}. "${c.title}"${c.abstract ? ' — ' + c.abstract.slice(0, 300) : ' (no abstract available)'} ` +
        `[local text-similarity confidence: ${c.confidence}%]`
    )
    .join('\n');

  return `A person highlighted this passage while writing a document:
"${claimText}"

Here are candidate papers found by a text-similarity search, numbered, each with a plain local confidence score already computed from several textual-similarity measures (that number is NOT a judgment of true relevance, just a rough pre-filter — some may score high on wording overlap without actually being on-topic, and some genuinely relevant ones may score lower because they use different terminology or the passage paraphrases them):
${list}

For each candidate that ACTUALLY supports or is directly relevant to the passage above (not just textually similar to it), give its index, a true relevance score from 0-100 (100 = directly and specifically supports the passage, 0 = unrelated despite any textual similarity), and a one-sentence reason. Leave out candidates that are not genuinely relevant, even if their local confidence score looked high.

Respond with ONLY compact JSON, no other text:
{"matches":[{"index":0,"relevance":90,"why":"..."}]}`;
}

function parseRerankOutput(text, candidateCount) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed.matches)) return null;
    return parsed.matches
      .map((m) => ({
        index: Number(m.index),
        relevance: Number(m.relevance),
        why: typeof m.why === 'string' ? m.why.trim().slice(0, 240) : '',
      }))
      .filter(
        (m) =>
          Number.isInteger(m.index) &&
          m.index >= 0 &&
          m.index < candidateCount &&
          Number.isFinite(m.relevance)
      );
  } catch {
    return null;
  }
}

// --- Sentence splitting & chunking (no model calls) --------------------------
// Used both to build the primary full-text search plan for long selections
// and to build the stopword-stripped stage's search plan. Chunk boundaries
// always fall on sentence breaks, never mid-sentence/mid-clause, and
// consecutive chunks overlap by one sentence so a citation-bearing detail
// that sits right at a chunk boundary isn't split away from its context.

function splitSentences(text) {
  // Guard a few common abbreviation/decimal patterns so they don't get
  // mistaken for sentence ends — this is a heuristic, not a full sentence
  // tokenizer, but it's enough to keep author-name abbreviations ("J. Smith"),
  // "et al.", and decimal numbers ("p = 0.05") from fragmenting a passage.
  const guarded = text
    .replace(/\b(Dr|Mr|Mrs|Ms|Prof|Fig|Eq|eq|vs|approx|no|pp|Inc|Ltd|Jr|Sr|St|et al)\./gi, '$1<DOT>')
    .replace(/(\d)\.(\d)/g, '$1<DOT>$2');

  const sentences = guarded
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'\u201c(])/)
    .map((s) => s.replace(/<DOT>/g, '.').trim())
    .filter(Boolean);

  return sentences.length ? sentences : [text.trim()].filter(Boolean);
}

function buildChunks(text) {
  const sentences = splitSentences(text);
  if (sentences.length <= 1) return [text];

  const windows = [];
  let i = 0;
  while (i < sentences.length) {
    let chunk = '';
    let j = i;
    while (j < sentences.length && (!chunk || chunk.length + sentences[j].length + 1 <= CITE_CHUNK_TARGET_CHARS)) {
      chunk += (chunk ? ' ' : '') + sentences[j];
      j++;
    }
    // A single sentence longer than the target on its own still has to go
    // somewhere — take it alone rather than looping forever.
    if (!chunk) {
      chunk = sentences[j];
      j++;
    }
    windows.push(chunk);
    if (j >= sentences.length) break;
    // Overlap by one sentence so context isn't lost at the seam.
    i = Math.max(j - 1, i + 1);
  }

  if (windows.length <= CITE_MAX_CHUNKS) return windows;

  // Very long selections: resample down to an evenly-spaced subset (always
  // including the first and last window) so the whole passage still gets
  // some coverage within the API-call budget, rather than just truncating
  // to the first few chunks and silently ignoring the rest.
  const stride = (windows.length - 1) / (CITE_MAX_CHUNKS - 1);
  const sampled = [];
  for (let k = 0; k < CITE_MAX_CHUNKS; k++) {
    sampled.push(windows[Math.round(k * stride)]);
  }
  return [...new Set(sampled)];
}

function buildSearchPlan(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return { mode: 'direct', queries: [] };
  if (normalized.length <= CITE_DIRECT_QUERY_MAX_CHARS) {
    return { mode: 'direct', queries: [normalized] };
  }
  return { mode: 'chunked', queries: buildChunks(normalized) };
}

// --- Stopword removal & key-phrase extraction (fallback stages only) --------

const CITE_STOPWORDS = new Set(
  'a an the of in on at to for and or but with from by is are was were has have had this that these those it its as be been being which who whom whose we our you your they their he she his her not no can may might will would should could than then so such also into over under about'.split(
    ' '
  )
);

// Keeps every non-stopword token, in its original order and casing (so
// author names, technical terms, and abbreviations survive untouched);
// only strips stopwords, never ranks or truncates. This is a *fallback*
// stage, tried only if searching the full original text found nothing
// confident enough.
function removeStopwords(text) {
  const parts = text.split(/(\s+)/); // keep separators so spacing survives
  const kept = parts.filter((part) => {
    const bare = part.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!bare) return true; // whitespace/pure-punctuation token — keep it
    return !CITE_STOPWORDS.has(bare);
  });
  return kept.join('').replace(/\s+/g, ' ').trim();
}

// Contiguous runs of non-stopwords, sentence by sentence — a step between
// "the whole passage" and "a handful of keywords": multi-word technical
// terms, names, and clause fragments stay intact as phrases rather than
// being scattered into individual words. Only reached if the full-text and
// stopword-stripped stages both failed to find a confident match.
function extractPhrases(text) {
  const phrases = [];
  for (const sentence of splitSentences(text)) {
    let run = [];
    const flush = () => {
      if (run.length >= 2) phrases.push(run.join(' '));
      run = [];
    };
    for (const word of sentence.split(/\s+/)) {
      const bare = word.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (bare && !CITE_STOPWORDS.has(bare)) {
        run.push(word);
      } else {
        flush();
      }
    }
    flush();
  }
  return [...new Set(phrases)].sort((a, b) => b.length - a.length).slice(0, 5);
}

// Longest, most distinctive-looking words first — a crude proxy for
// "important" without a model to judge actual relevance. This is now the
// *last-resort* fallback stage, never the primary search strategy.
function naiveKeywords(text) {
  const words = normalize(text)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !CITE_STOPWORDS.has(w));
  const uniq = [...new Set(words)].sort((a, b) => b.length - a.length);
  return uniq.slice(0, 6);
}

// --- Similarity metrics (no model calls) -------------------------------------
// Five independent, cheap textual-similarity measures, combined into one
// confidence score. No single metric is trusted alone: coverage rewards a
// candidate containing the passage's distinctive vocabulary, cosine/Jaccard
// reward overall vocabulary overlap regardless of length mismatch, fuzzy
// token-sort catches paraphrases/reordering, and Levenshtein catches
// near-identical wording (e.g. an abstract that quotes the passage almost
// verbatim). Weights below reflect how reliable each signal tends to be on
// its own — coverage and cosine carry the most weight; Levenshtein (the
// most literal, least paraphrase-tolerant metric) the least.

const CITE_METRIC_WEIGHTS = { coverage: 0.35, cosine: 0.25, jaccard: 0.15, fuzzy: 0.15, levenshtein: 0.1 };
const CITE_LEV_CHAR_CAP = 300; // bounds Levenshtein's O(n*m) cost
const CITE_FUZZY_TOKEN_CAP = 40; // bounds token-sort-ratio cost on long passages

function tokenize(text) {
  return normalize(text)
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function jaccardSimilarity(aSet, bSet) {
  if (aSet.size === 0 && bSet.size === 0) return 0;
  let intersection = 0;
  for (const t of aSet) if (bSet.has(t)) intersection++;
  const union = aSet.size + bSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function cosineSimilarity(aTokens, bTokens) {
  const freq = (tokens) => {
    const m = new Map();
    for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
    return m;
  };
  const aFreq = freq(aTokens);
  const bFreq = freq(bTokens);
  let dot = 0;
  for (const [t, c] of aFreq) if (bFreq.has(t)) dot += c * bFreq.get(t);
  const mag = (m) => Math.sqrt([...m.values()].reduce((s, c) => s + c * c, 0));
  const denom = mag(aFreq) * mag(bFreq);
  return denom === 0 ? 0 : dot / denom;
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[b.length];
}

function levenshteinSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

// Approximates fuzzywuzzy's token_sort_ratio: sorting each side's tokens
// before comparing neutralizes word-order differences, so this catches
// paraphrase-level matches (same words, different order) that a raw
// Levenshtein comparison of the original strings would miss.
function fuzzyTokenSortRatio(aTokens, bTokens) {
  const a = [...aTokens].sort().join(' ');
  const b = [...bTokens].sort().join(' ');
  return levenshteinSimilarity(a, b);
}

// Combines all five metrics into one 0-100 confidence score for a single
// candidate, always measured against the real original passage (`claimText`)
// regardless of which reduced query actually found the candidate.
function computeConfidence(claimText, candidate) {
  const candidateText = `${candidate.title} ${candidate.abstract || ''}`;
  const claimTokensAll = tokenize(claimText);
  const candidateTokensAll = tokenize(candidateText);
  const candidateSet = new Set(candidateTokensAll);

  const claimMeaningful = new Set(claimTokensAll.filter((w) => w.length > 3 && !CITE_STOPWORDS.has(w)));
  const matched = [...claimMeaningful].filter((w) => candidateSet.has(w));
  const coverage = claimMeaningful.size ? matched.length / claimMeaningful.size : 0;

  const jaccard = jaccardSimilarity(new Set(claimTokensAll), candidateSet);
  const cosine = cosineSimilarity(claimTokensAll, candidateTokensAll);
  const fuzzy = fuzzyTokenSortRatio(
    claimTokensAll.slice(0, CITE_FUZZY_TOKEN_CAP),
    candidateTokensAll.slice(0, CITE_FUZZY_TOKEN_CAP)
  );
  const levenshtein = levenshteinSimilarity(
    normalize(claimText).slice(0, CITE_LEV_CHAR_CAP),
    normalize(candidateText).slice(0, CITE_LEV_CHAR_CAP)
  );

  const raw =
    CITE_METRIC_WEIGHTS.coverage * coverage +
    CITE_METRIC_WEIGHTS.cosine * cosine +
    CITE_METRIC_WEIGHTS.jaccard * jaccard +
    CITE_METRIC_WEIGHTS.fuzzy * fuzzy +
    CITE_METRIC_WEIGHTS.levenshtein * levenshtein;

  return {
    confidence: Math.max(0, Math.min(100, Math.round(raw * 100))),
    matched,
    metrics: {
      coverage: Math.round(coverage * 100),
      cosine: Math.round(cosine * 100),
      jaccard: Math.round(jaccard * 100),
      fuzzy: Math.round(fuzzy * 100),
      levenshtein: Math.round(levenshtein * 100),
    },
  };
}

// Scores every candidate against the original passage and attaches a
// human-readable "why" — the actual shared terms where there are any,
// otherwise a plain-language nod to the similarity score, so the popover
// never has to fabricate a reason.
function scoreCandidates(claimText, candidates) {
  return candidates.map((c) => {
    const { confidence, matched, metrics } = computeConfidence(claimText, c);
    const why = matched.length
      ? `Shares: ${matched.slice(0, 5).join(', ')}`
      : metrics.cosine >= 30
        ? 'Similar wording and topic'
        : '';
    return { ...c, confidence, matched, metrics, why };
  });
}

// --- Candidate search (Crossref + Semantic Scholar + OpenAlex, in parallel) --
// All three are free and require no API key. Crossref is included per its
// strong DOI/metadata coverage, especially outside CS/AI (Semantic
// Scholar's specialty) — the three together cover more ground than any one
// alone, at no cost. Each query is now the passage's own wording (or a
// sentence-bounded chunk of it) rather than a keyword list — see
// buildSearchPlan()/buildFallbackStages() for how queries are chosen.

async function searchCandidatesForQueries(queries) {
  const uniqueQueries = [...new Set(queries.map((q) => (q || '').trim()).filter(Boolean))].slice(
    0,
    CITE_MAX_CHUNKS
  );
  if (uniqueQueries.length === 0) return [];

  const perQuery = await Promise.allSettled(
    uniqueQueries.map((query) =>
      Promise.allSettled([searchCrossref(query), searchSemanticScholar(query), searchOpenAlex(query)])
    )
  );

  const list = [];
  for (const outer of perQuery) {
    if (outer.status !== 'fulfilled') continue;
    for (const inner of outer.value) {
      if (inner.status === 'fulfilled') list.push(...inner.value);
    }
  }
  return dedupeCandidates(list);
}

async function searchCrossref(query) {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=8`;
  const res = await fetchWithTimeout(url, {}, CITE_SEARCH_TIMEOUT_MS);
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.message?.items || [])
    .filter((it) => Array.isArray(it.title) && it.title[0])
    .map((it) => ({
      title: it.title[0],
      // Crossref abstracts (when present at all) come as JATS-tagged XML.
      abstract: (it.abstract || '').replace(/<[^>]+>/g, ''),
      authors: (it.author || [])
        .map((a) => [a.given, a.family].filter(Boolean).join(' '))
        .filter(Boolean),
      year:
        it['published-print']?.['date-parts']?.[0]?.[0] ||
        it['published-online']?.['date-parts']?.[0]?.[0] ||
        it.issued?.['date-parts']?.[0]?.[0] ||
        null,
      venue: (it['container-title'] || [])[0] || '',
      doi: it.DOI || '',
      url: it.URL || (it.DOI ? `https://doi.org/${it.DOI}` : ''),
    }));
}

async function searchSemanticScholar(query) {
  const url =
    'https://api.semanticscholar.org/graph/v1/paper/search' +
    `?query=${encodeURIComponent(query)}&fields=title,abstract,authors,year,venue,externalIds,url&limit=8`;
  const res = await fetchWithTimeout(url, {}, CITE_SEARCH_TIMEOUT_MS);
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.data || [])
    .filter((p) => p.title)
    .map((p) => ({
      title: p.title,
      abstract: p.abstract || '',
      authors: (p.authors || []).map((a) => a.name).filter(Boolean),
      year: p.year || null,
      venue: p.venue || '',
      doi: p.externalIds?.DOI || '',
      url: p.url || (p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : ''),
    }));
}

async function searchOpenAlex(query) {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=8`;
  const res = await fetchWithTimeout(url, {}, CITE_SEARCH_TIMEOUT_MS);
  if (!res.ok) return [];
  const data = await res.json();
  return (data?.results || [])
    .filter((w) => w.display_name)
    .map((w) => ({
      title: w.display_name,
      abstract: reconstructAbstract(w.abstract_inverted_index) || '',
      authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
      year: w.publication_year || null,
      venue: w.host_venue?.display_name || w.primary_location?.source?.display_name || '',
      doi: (w.doi || '').replace('https://doi.org/', ''),
      url: w.doi || w.id || '',
    }));
}

// Merges results from all queries/sources, folding near-duplicate titles
// together (reusing the same titleSimilarity() heuristic the abstract-
// lookup path already relies on) and keeping whichever copy has an
// abstract if only one of the duplicates does — an abstract is what makes
// computeConfidence() above meaningful instead of title-only.
function dedupeCandidates(list) {
  const out = [];
  for (const item of list) {
    const dup = out.find((o) => titleSimilarity(o.title, item.title) > 0.85);
    if (!dup) out.push(item);
    else if (!dup.abstract && item.abstract) Object.assign(dup, item);
  }
  return out;
}

// --- Citation formatting -----------------------------------------------------
// Deliberately simple templates, not a full CSL processor — same
// honesty-over-completeness approach the existing BibTeX export already
// takes (see collections.js): no fabricated fields, clearly-approximate
// name splitting rather than a real bibliographic parser.

function splitName(full) {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { last: parts[0], initials: '' };
  const last = parts[parts.length - 1];
  const initials = parts
    .slice(0, -1)
    .map((p) => (p[0] ? p[0].toUpperCase() + '.' : ''))
    .join(' ');
  return { last, initials };
}

function formatAuthorsAPA(authors) {
  if (!authors.length) return '';
  const formatted = authors.map((a) => {
    const { last, initials } = splitName(a);
    return initials ? `${last}, ${initials}` : last;
  });
  if (formatted.length === 1) return formatted[0];
  if (formatted.length === 2) return `${formatted[0]}, & ${formatted[1]}`;
  return `${formatted.slice(0, -1).join(', ')}, & ${formatted[formatted.length - 1]}`;
}

function formatAPA(c) {
  const authors = formatAuthorsAPA(c.authors);
  const year = c.year ? `(${c.year}).` : '(n.d.).';
  const venue = c.venue ? ` ${c.venue}.` : '';
  const lead = authors ? `${authors} ` : '';
  return `${lead}${year} ${c.title}.${venue}`.replace(/\s+/g, ' ').trim();
}

function formatMLA(c) {
  let authorPart = '';
  if (c.authors.length) {
    const { last, initials } = splitName(c.authors[0]);
    const firstName = initials ? initials.replace(/\./g, '') : '';
    authorPart = c.authors.length > 1 ? `${last}, ${firstName}, et al. ` : `${last}, ${firstName}. `;
  }
  const venue = c.venue ? ` ${c.venue},` : '';
  const year = c.year ? ` ${c.year}.` : '';
  return `${authorPart}"${c.title}."${venue}${year}`.replace(/\s+/g, ' ').trim();
}

function formatIEEE(c, index) {
  let authorPart = '';
  if (c.authors.length) {
    const { last, initials } = splitName(c.authors[0]);
    authorPart = c.authors.length > 1 ? `${initials} ${last} et al., ` : `${initials} ${last}, `;
  }
  const venue = c.venue ? ` ${c.venue},` : '';
  const year = c.year ? ` ${c.year}.` : '';
  return `[${index}] ${authorPart}"${c.title},"${venue}${year}`.replace(/\s+/g, ' ').trim();
}

// Chicago author-date, in the same spirit as the other hand-rolled
// formatters above: a plain fallback for if the real CSL engine (see
// csl.js, which runs in a DOM context this service worker doesn't have)
// isn't available for some reason — not a full implementation of Chicago's
// actual formatting rules.
function formatChicago(c) {
  let authorPart = '';
  if (c.authors.length) {
    const { last, initials } = splitName(c.authors[0]);
    const firstName = initials ? initials.replace(/\./g, ' ').trim() : '';
    const first = firstName ? `${last}, ${firstName}` : last;
    authorPart = c.authors.length > 1 ? `${first}, et al. ` : `${first}. `;
  }
  const year = c.year ? `${c.year}. ` : '';
  const venue = c.venue ? ` ${c.venue}.` : '';
  return `${authorPart}${year}“${c.title}.”${venue}`.replace(/\s+/g, ' ').trim();
}

function bibtexKey(c) {
  const lastName = c.authors[0] ? splitName(c.authors[0]).last.replace(/[^a-zA-Z]/g, '') : 'anon';
  const firstWord = (c.title || 'untitled').split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, '');
  return `${lastName}${c.year || ''}${firstWord}`;
}

function formatBibTeX(c) {
  const authors = c.authors.length ? c.authors.join(' and ') : 'Unknown';
  const lines = [`@article{${bibtexKey(c)},`, `  author = {${authors}},`, `  title = {${c.title}},`];
  if (c.venue) lines.push(`  journal = {${c.venue}},`);
  if (c.year) lines.push(`  year = {${c.year}},`);
  if (c.doi) lines.push(`  doi = {${c.doi}},`);
  if (c.url) lines.push(`  url = {${c.url}},`);
  lines.push('}');
  return lines.join('\n');
}

// Shapes one merged/ranked candidate into what the content script renders:
// display fields plus all four pre-formatted citation strings, so switching
// format in the popover never needs another message round-trip.
function toResultShape(c, ieeeIndex) {
  return {
    title: c.title,
    authors: c.authors || [],
    year: c.year || null,
    venue: c.venue || '',
    doi: c.doi || '',
    url: c.url || '',
    relevance: Number.isFinite(c.relevance) ? c.relevance : null,
    why: c.why || '',
    citations: {
      apa: formatAPA(c),
      mla: formatMLA(c),
      chicago: formatChicago(c),
      ieee: formatIEEE(c, ieeeIndex),
      bibtex: formatBibTeX(c),
    },
  };
}
