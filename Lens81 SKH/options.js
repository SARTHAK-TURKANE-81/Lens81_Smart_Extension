// options.js
// Renders up to 5 "API key + model" rows, backed by chrome.storage.local
// under a single `openrouterConfigs` array: [{ key, model, onlyIfNeeded }, ...].
// A row checked "only use if needed" is held back by the background worker
// and only called if none of the regular rows produced a usable result —
// useful for a backup/cheaper key you don't want spending a request on
// every single paper.
//
// Backward compatibility: installs from before multi-model support stored a
// single pair under `openrouterKey` / `openrouterModel`. On load, if no
// `openrouterConfigs` exists yet, that legacy pair is migrated into row 1
// so existing users keep working without re-entering anything.

const MAX_ROWS = 5;

// Per-provider display strings. Each row can independently pick a provider;
// the key input's placeholder/hint and the model input's placeholder swap
// to match whichever is selected. Model catalogs and slugs change over time
// for every one of these providers, so hints point at the provider's own
// docs/catalog page rather than hardcoding a list here.
const PROVIDER_META = {
  openrouter: {
    label: 'OpenRouter',
    keyPlaceholder: 'sk-or-v1-…',
    modelPlaceholder: '~anthropic/claude-haiku-latest',
    keyHint:
      'Routes to hundreds of models from one key. Create one at ' +
      '<a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>, ' +
      'sent only to openrouter.ai.',
  },
  gemini: {
    label: 'Google Gemini',
    keyPlaceholder: 'AIza…',
    modelPlaceholder: 'gemini-2.5-flash',
    keyHint:
      'Create a key at ' +
      '<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>, ' +
      'sent only to generativelanguage.googleapis.com. Check ' +
      '<a href="https://ai.google.dev/gemini-api/docs/models" target="_blank" rel="noopener">the model list</a> ' +
      'for the current slug.',
  },
  grok: {
    label: 'xAI Grok',
    keyPlaceholder: 'xai-…',
    modelPlaceholder: 'grok-4-fast',
    keyHint:
      'Create a key at ' +
      '<a href="https://console.x.ai" target="_blank" rel="noopener">console.x.ai</a>, sent only to api.x.ai. ' +
      'Check <a href="https://docs.x.ai/docs/models" target="_blank" rel="noopener">the model list</a> ' +
      'for the current slug.',
  },
  groq: {
    label: 'Groq',
    keyPlaceholder: 'gsk_…',
    modelPlaceholder: 'llama-3.3-70b-versatile',
    keyHint:
      'Create a key at ' +
      '<a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com/keys</a>, ' +
      'sent only to api.groq.com. Fast inference for open models (Llama, Gemma, etc.). Check ' +
      '<a href="https://console.groq.com/docs/models" target="_blank" rel="noopener">the model list</a> ' +
      'for the current slug.',
  },
};

const rowsContainer = document.getElementById('model-rows');
const saveBtn = document.getElementById('save');
const status = document.getElementById('status');
const banner = document.getElementById('banner');
const clearStatus = document.getElementById('clear-status');

let statusGeneration = 0;

function showStatus(kind, message) {
  // kind: 'ok' | 'err' | 'neutral'
  statusGeneration++;
  status.textContent = message;
  status.className = `pill-status ${kind}`;
  status.style.display = 'inline-flex';
}

function hideStatusLater(delay = 2200) {
  // Capture the generation so a stale timer (e.g. from Save) can't hide a
  // newer message shown afterward (e.g. from a row's Test button).
  const generation = statusGeneration;
  setTimeout(() => {
    if (generation === statusGeneration) {
      status.style.display = 'none';
    }
  }, delay);
}

// --- Row rendering -----------------------------------------------------

function buildRow(index) {
  const wrap = document.createElement('div');
  wrap.className = 'model-row';
  wrap.dataset.index = String(index);

  const isFirst = index === 0;
  wrap.innerHTML = `
    <div class="model-row-header">
      <span class="model-row-title">Model ${index + 1}</span>
      <span class="model-row-tag">${isFirst ? 'Required' : 'Optional'}</span>
    </div>
    <div class="field">
      <label>Provider</label>
      <select class="row-provider">
        <option value="openrouter">OpenRouter</option>
        <option value="gemini">Google Gemini</option>
        <option value="grok">xAI Grok</option>
        <option value="groq">Groq</option>
      </select>
    </div>
    <div class="field">
      <label class="row-key-label">API key</label>
      <div class="input-row">
        <input type="password" class="key-input row-key" placeholder="sk-or-v1-…" autocomplete="off" />
        <button type="button" class="toggle-visibility row-toggle-key">Show</button>
      </div>
      <p class="hint row-key-hint" style="margin: 6px 0 0;"></p>
    </div>
    <div class="field">
      <label>Model slug</label>
      <input type="text" class="row-model" placeholder="~anthropic/claude-haiku-latest" autocomplete="off" />
    </div>
    <label class="row-fallback">
      <input type="checkbox" class="row-only-if-needed" />
      <span>Only use this key if the others fail <em>(saves API cost, held back unless it's needed)</em></span>
    </label>
    <div class="row-actions">
      <button type="button" class="row-test">Test</button>
      <span class="row-status pill-status neutral" style="display:none;"></span>
    </div>
  `;
  return wrap;
}

function renderRows() {
  rowsContainer.innerHTML = '';
  for (let i = 0; i < MAX_ROWS; i++) {
    rowsContainer.appendChild(buildRow(i));
  }
  wireRowEvents();
}

function applyProviderUI(row, provider) {
  const meta = PROVIDER_META[provider] || PROVIDER_META.openrouter;
  const keyInput = row.querySelector('.row-key');
  const modelInput = row.querySelector('.row-model');
  const keyHint = row.querySelector('.row-key-hint');
  const keyLabel = row.querySelector('.row-key-label');

  keyLabel.textContent = `${meta.label} API key`;
  keyInput.placeholder = meta.keyPlaceholder;
  modelInput.placeholder = meta.modelPlaceholder;
  keyHint.innerHTML = meta.keyHint;
}

function wireRowEvents() {
  rowsContainer.querySelectorAll('.model-row').forEach((row) => {
    const keyInput = row.querySelector('.row-key');
    const toggleBtn = row.querySelector('.row-toggle-key');
    const testBtn = row.querySelector('.row-test');
    const rowStatus = row.querySelector('.row-status');
    const modelInput = row.querySelector('.row-model');
    const providerSelect = row.querySelector('.row-provider');

    applyProviderUI(row, providerSelect.value);
    providerSelect.addEventListener('change', () => {
      applyProviderUI(row, providerSelect.value);
      // A model slug from one provider is meaningless to another — clear it
      // so nobody accidentally tries to send an OpenRouter slug to Gemini.
      modelInput.value = '';
      setRowStatus(rowStatus, 'neutral', '');
      rowStatus.style.display = 'none';
    });

    toggleBtn.addEventListener('click', () => {
      const hidden = keyInput.type === 'password';
      keyInput.type = hidden ? 'text' : 'password';
      toggleBtn.textContent = hidden ? 'Hide' : 'Show';
    });

    testBtn.addEventListener('click', () => {
      const provider = providerSelect.value;
      const key = keyInput.value.trim();
      const model = modelInput.value.trim();

      if (!key || !model) {
        setRowStatus(rowStatus, 'err', 'Add a key and model first.');
        return;
      }

      setRowStatus(rowStatus, 'neutral', 'Testing…');
      testBtn.disabled = true;

      chrome.runtime.sendMessage({ type: 'TEST_KEY', provider, key, model }, (response) => {
        testBtn.disabled = false;
        if (chrome.runtime.lastError || !response) {
          setRowStatus(rowStatus, 'err', 'Could not reach the background worker.');
          return;
        }
        setRowStatus(rowStatus, response.ok ? 'ok' : 'err', response.message);
      });
    });
  });
}

function setRowStatus(el, kind, message) {
  el.textContent = message;
  el.className = `row-status pill-status ${kind}`;
  el.style.display = 'inline-flex';
}

function getRows() {
  return Array.from(rowsContainer.querySelectorAll('.model-row'));
}

function readRowValues() {
  return getRows().map((row) => ({
    provider: row.querySelector('.row-provider').value || 'openrouter',
    key: row.querySelector('.row-key').value.trim(),
    model: row.querySelector('.row-model').value.trim(),
    onlyIfNeeded: row.querySelector('.row-only-if-needed').checked,
  }));
}

function writeRowValues(configs) {
  getRows().forEach((row, i) => {
    // Entries saved before multi-provider support have no `provider` field
    // at all — they were always OpenRouter, so default to that rather than
    // leaving the row on whatever the <select> happens to default to.
    const entry = configs[i] || { provider: 'openrouter', key: '', model: '', onlyIfNeeded: false };
    const providerSelect = row.querySelector('.row-provider');
    providerSelect.value = PROVIDER_META[entry.provider] ? entry.provider : 'openrouter';
    applyProviderUI(row, providerSelect.value);
    row.querySelector('.row-key').value = entry.key || '';
    row.querySelector('.row-model').value = entry.model || '';
    row.querySelector('.row-only-if-needed').checked = Boolean(entry.onlyIfNeeded);
  });
}

// --- Load / migrate / save ------------------------------------------------

async function refreshBanner(configs) {
  const anyConfigured = configs.some((c) => c.key && c.model);
  banner.classList.toggle('show', !anyConfigured);
}

async function load() {
  renderRows();

  const stored = await chrome.storage.local.get([
    'openrouterConfigs',
    'openrouterKey',
    'openrouterModel',
  ]);

  let configs = Array.isArray(stored.openrouterConfigs) ? stored.openrouterConfigs : null;

  if (!configs) {
    // Legacy single key/model install — migrate into row 1 on the fly.
    configs = [];
    if (stored.openrouterKey && stored.openrouterModel) {
      configs.push({ provider: 'openrouter', key: stored.openrouterKey, model: stored.openrouterModel });
    }
  }

  writeRowValues(configs);
  await refreshBanner(configs);
}

saveBtn.addEventListener('click', async () => {
  const configs = readRowValues();
  await chrome.storage.local.set({ openrouterConfigs: configs });
  // Once this page has been saved once, openrouterConfigs is the source of
  // truth going forward, so the old single-pair fields can be cleared.
  // (The background worker still reads them as a fallback for any install
  // that hasn't opened this settings page since the update.)
  await chrome.storage.local.remove(['openrouterKey', 'openrouterModel']);

  showStatus('ok', 'Saved.');
  hideStatusLater();
  await refreshBanner(configs);
});

document.getElementById('clear-cache').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const cacheKeys = Object.keys(all).filter((k) => k.startsWith('classify:'));
  await chrome.storage.local.remove(cacheKeys);
  clearStatus.textContent = `Cleared ${cacheKeys.length} cached result(s).`;
  setTimeout(() => (clearStatus.textContent = ''), 2500);
});

document.getElementById('back').addEventListener('click', () => {
  // Options pages usually open in their own tab with nothing before them in
  // history, so fall back to closing the tab when there's nowhere to go back to.
  if (window.history.length > 1) {
    window.history.back();
  } else {
    window.close();
  }
});

// --- Citation Finder key (added in v6) --------------------------------------
// Entirely separate from the model rows above: its own storage key
// (`citeApiConfig`, a single object — not part of `openrouterConfigs`), its
// own render/load/save functions, and its own Save button. Nothing in this
// section reads or writes anything the classification rows use, and
// nothing above this comment was changed to add it.

const citeRowContainer = document.getElementById('cite-row');
const saveCiteBtn = document.getElementById('save-cite');
const citeStatus = document.getElementById('cite-status');

function buildCiteRow() {
  const wrap = document.createElement('div');
  wrap.className = 'model-row';
  wrap.innerHTML = `
    <div class="field">
      <label>Provider</label>
      <select class="cite-provider">
        <option value="openrouter">OpenRouter</option>
        <option value="gemini">Google Gemini</option>
        <option value="grok">xAI Grok</option>
        <option value="groq">Groq</option>
      </select>
    </div>
    <div class="field">
      <label class="cite-key-label">API key</label>
      <div class="input-row">
        <input type="password" class="key-input cite-key" placeholder="sk-or-v1-…" autocomplete="off" />
        <button type="button" class="toggle-visibility cite-toggle-key">Show</button>
      </div>
      <p class="hint cite-key-hint" style="margin: 6px 0 0;"></p>
    </div>
    <div class="field" style="margin-bottom: 4px;">
      <label>Model slug</label>
      <input type="text" class="cite-model" placeholder="~anthropic/claude-haiku-latest" autocomplete="off" />
    </div>
    <div class="row-actions">
      <button type="button" class="cite-test">Test</button>
      <span class="cite-row-status pill-status neutral" style="display:none;"></span>
    </div>
  `;
  return wrap;
}

function applyCiteProviderUI(row, provider) {
  const meta = PROVIDER_META[provider] || PROVIDER_META.openrouter;
  row.querySelector('.cite-key-label').textContent = `${meta.label} API key`;
  row.querySelector('.cite-key').placeholder = meta.keyPlaceholder;
  row.querySelector('.cite-model').placeholder = meta.modelPlaceholder;
  row.querySelector('.cite-key-hint').innerHTML = meta.keyHint;
}

function renderCiteRow() {
  citeRowContainer.innerHTML = '';
  const row = buildCiteRow();
  citeRowContainer.appendChild(row);

  const providerSelect = row.querySelector('.cite-provider');
  const keyInput = row.querySelector('.cite-key');
  const modelInput = row.querySelector('.cite-model');
  const toggleBtn = row.querySelector('.cite-toggle-key');
  const testBtn = row.querySelector('.cite-test');
  const rowStatus = row.querySelector('.cite-row-status');

  applyCiteProviderUI(row, providerSelect.value);
  providerSelect.addEventListener('change', () => {
    applyCiteProviderUI(row, providerSelect.value);
    modelInput.value = '';
    rowStatus.style.display = 'none';
  });

  toggleBtn.addEventListener('click', () => {
    const hidden = keyInput.type === 'password';
    keyInput.type = hidden ? 'text' : 'password';
    toggleBtn.textContent = hidden ? 'Hide' : 'Show';
  });

  testBtn.addEventListener('click', () => {
    const provider = providerSelect.value;
    const key = keyInput.value.trim();
    const model = modelInput.value.trim();

    if (!key || !model) {
      setRowStatus(rowStatus, 'err', 'Add a key and model first.');
      return;
    }

    setRowStatus(rowStatus, 'neutral', 'Testing…');
    testBtn.disabled = true;

    // Reuses the same generic TEST_KEY message the model rows above use —
    // it only ever takes a provider/key/model triple, so it works exactly
    // the same here with no changes needed on the background.js side.
    chrome.runtime.sendMessage({ type: 'TEST_KEY', provider, key, model }, (response) => {
      testBtn.disabled = false;
      if (chrome.runtime.lastError || !response) {
        setRowStatus(rowStatus, 'err', 'Could not reach the background worker.');
        return;
      }
      setRowStatus(rowStatus, response.ok ? 'ok' : 'err', response.message);
    });
  });
}

async function loadCiteRow() {
  renderCiteRow();
  const stored = await chrome.storage.local.get(['citeApiConfig', 'citeConfidenceThreshold']);
  const config = stored.citeApiConfig;

  if (config) {
    const row = citeRowContainer.querySelector('.model-row');
    const providerSelect = row.querySelector('.cite-provider');
    providerSelect.value = PROVIDER_META[config.provider] ? config.provider : 'openrouter';
    applyCiteProviderUI(row, providerSelect.value);
    row.querySelector('.cite-key').value = config.key || '';
    row.querySelector('.cite-model').value = config.model || '';
  }

  // Threshold is stored separately from citeApiConfig (and defaults on the
  // background.js side even if nothing is stored here at all), so a blank
  // field is a perfectly valid, meaningful state — not an error.
  const thresholdInput = document.getElementById('cite-threshold');
  if (thresholdInput && Number.isFinite(stored.citeConfidenceThreshold)) {
    thresholdInput.value = stored.citeConfidenceThreshold;
  }
}

// Reads and validates the threshold field, saving/clearing it independently
// of the AI key below — an invalid or blank value just falls back to
// background.js's own default (42) rather than blocking the key save.
async function saveCiteThreshold() {
  const input = document.getElementById('cite-threshold');
  if (!input) return;
  const raw = input.value.trim();
  if (!raw) {
    await chrome.storage.local.remove('citeConfidenceThreshold');
    return;
  }
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0 && value <= 100) {
    await chrome.storage.local.set({ citeConfidenceThreshold: value });
  } else {
    await chrome.storage.local.remove('citeConfidenceThreshold');
    input.value = '';
  }
}

saveCiteBtn.addEventListener('click', async () => {
  await saveCiteThreshold();

  const row = citeRowContainer.querySelector('.model-row');
  const provider = row.querySelector('.cite-provider').value || 'openrouter';
  const key = row.querySelector('.cite-key').value.trim();
  const model = row.querySelector('.cite-model').value.trim();

  if (!key || !model) {
    // Blank is a valid, meaningful state here — it means "stay on the free
    // local-match path" — so clear any previously saved config rather
    // than leaving a stale key behind.
    await chrome.storage.local.remove('citeApiConfig');
    citeStatus.textContent = 'Cleared. Citation search will use free text-similarity matching only.';
    citeStatus.className = 'pill-status neutral';
    citeStatus.style.display = 'inline-flex';
    setTimeout(() => (citeStatus.style.display = 'none'), 3000);
    return;
  }

  await chrome.storage.local.set({ citeApiConfig: { provider, key, model } });
  citeStatus.textContent = 'Saved. Citations will get an AI relevance check.';
  citeStatus.className = 'pill-status ok';
  citeStatus.style.display = 'inline-flex';
  setTimeout(() => (citeStatus.style.display = 'none'), 3000);
});

// --- Page-lock passcode protection --------------------------------------
// A UI-level gate only, not encryption: stops someone else using this same
// browser from opening Settings and reading API keys off the screen. The
// keys themselves stay in chrome.storage.local in plain form — the
// background worker needs to read them autonomously to classify papers
// while you browse, which true encryption-at-rest would break (it would
// need a passcode re-entered every time the service worker restarts, not
// just when this page is opened). Someone with direct DevTools access to
// this browser could still read the stored keys directly; this only
// raises the bar for casual/shared-device access through the normal
// Settings UI itself.

const LOCK_SALT_KEY = 'optionsLockSalt';
const LOCK_HASH_KEY = 'optionsLockHash';

function lockRandomSaltB64() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

async function lockHashPasscode(passcode, saltB64) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(saltB64 + ':' + passcode));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

async function lockGetConfig() {
  const stored = await chrome.storage.local.get([LOCK_SALT_KEY, LOCK_HASH_KEY]);
  if (!stored[LOCK_SALT_KEY] || !stored[LOCK_HASH_KEY]) return null;
  return { salt: stored[LOCK_SALT_KEY], hash: stored[LOCK_HASH_KEY] };
}

async function lockSetPasscode(passcode) {
  const salt = lockRandomSaltB64();
  const hash = await lockHashPasscode(passcode, salt);
  await chrome.storage.local.set({ [LOCK_SALT_KEY]: salt, [LOCK_HASH_KEY]: hash });
}

async function lockRemovePasscode() {
  await chrome.storage.local.remove([LOCK_SALT_KEY, LOCK_HASH_KEY]);
}

async function lockVerifyPasscode(passcode) {
  const config = await lockGetConfig();
  if (!config) return true; // no passcode set, nothing to check against
  return (await lockHashPasscode(passcode, config.salt)) === config.hash;
}

const lockScreen = document.getElementById('lock-screen');
const settingsContent = document.getElementById('settings-content');
const lockPasscodeInput = document.getElementById('lock-passcode');
const lockUnlockBtn = document.getElementById('lock-unlock');
const lockErrorEl = document.getElementById('lock-error');
const lockForgotLink = document.getElementById('lock-forgot');
const lockSetupRow = document.getElementById('lock-setup-row');
const lockManageRow = document.getElementById('lock-manage-row');
const lockSetBtn = document.getElementById('lock-set-btn');
const lockChangeBtn = document.getElementById('lock-change-btn');
const lockRemoveBtn = document.getElementById('lock-remove-btn');
const lockSetupStatus = document.getElementById('lock-setup-status');
const lockManageStatus = document.getElementById('lock-manage-status');

async function refreshLockManagementUI() {
  const config = await lockGetConfig();
  lockSetupRow.style.display = config ? 'none' : 'flex';
  lockManageRow.style.display = config ? 'flex' : 'none';
}

// Only ever called after a passcode check passes (or none is set) — this
// is what actually populates the key fields, so it must never run while
// the lock screen is showing.
async function revealSettings() {
  lockScreen.style.display = 'none';
  settingsContent.style.display = 'block';
  await refreshLockManagementUI();
  await load();
  await loadCiteRow();
}

async function initLock() {
  const config = await lockGetConfig();
  if (!config) {
    await revealSettings();
    return;
  }
  lockScreen.style.display = 'block';
  settingsContent.style.display = 'none';
  lockPasscodeInput.focus();
}

async function attemptUnlock() {
  const value = lockPasscodeInput.value;
  if (!value) return;
  const ok = await lockVerifyPasscode(value);
  lockPasscodeInput.value = '';
  if (ok) {
    lockErrorEl.style.display = 'none';
    await revealSettings();
  } else {
    lockErrorEl.textContent = 'Incorrect passcode.';
    lockErrorEl.style.display = 'block';
    lockPasscodeInput.focus();
  }
}

lockUnlockBtn.addEventListener('click', attemptUnlock);
lockPasscodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') attemptUnlock();
});

lockForgotLink.addEventListener('click', async (e) => {
  e.preventDefault();
  const proceed = confirm(
    'This removes passcode protection entirely — it does not touch your saved API keys. ' +
      'Anyone using this browser will then be able to open Settings without a passcode. Continue?'
  );
  if (!proceed) return;
  await lockRemovePasscode();
  await revealSettings();
});

// Small reusable inline form for the set/change/remove passcode flows —
// one at a time, built on demand rather than three near-identical blocks
// pre-declared in the HTML.
function lockBuildInlineForm({ fields, submitLabel, anchorEl, onSubmit }) {
  const existing = document.getElementById('lock-inline-form');
  if (existing) existing.remove();

  const form = document.createElement('div');
  form.id = 'lock-inline-form';
  form.style.cssText = 'margin-top: 10px; display: flex; flex-direction: column; gap: 8px; max-width: 280px;';

  const inputs = fields.map((placeholder) => {
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.style.cssText = 'font: inherit; font-size: 13px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px;';
    form.appendChild(input);
    return input;
  });

  const actionRow = document.createElement('div');
  actionRow.style.cssText = 'display: flex; gap: 8px; align-items: center;';

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.textContent = submitLabel;
  actionRow.appendChild(submitBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => form.remove());
  actionRow.appendChild(cancelBtn);
  form.appendChild(actionRow);

  const errEl = document.createElement('div');
  errEl.className = 'hint';
  errEl.style.cssText = 'color: var(--err, #b3261e); display: none;';
  form.appendChild(errEl);

  submitBtn.addEventListener('click', async () => {
    errEl.style.display = 'none';
    const result = await onSubmit(inputs.map((i) => i.value));
    if (result === true) {
      form.remove();
    } else {
      errEl.textContent = result || 'Something went wrong.';
      errEl.style.display = 'block';
    }
  });

  anchorEl.insertAdjacentElement('afterend', form);
  inputs[0].focus();
}

lockSetBtn.addEventListener('click', () => {
  lockBuildInlineForm({
    fields: ['New passcode', 'Confirm passcode'],
    submitLabel: 'Save passcode',
    anchorEl: lockSetupRow,
    onSubmit: async ([pass, confirmPass]) => {
      if (!pass) return 'Enter a passcode.';
      if (pass !== confirmPass) return "Passcodes don't match.";
      await lockSetPasscode(pass);
      await refreshLockManagementUI();
      return true;
    },
  });
});

lockChangeBtn.addEventListener('click', () => {
  lockBuildInlineForm({
    fields: ['Current passcode', 'New passcode', 'Confirm new passcode'],
    submitLabel: 'Change passcode',
    anchorEl: lockManageRow,
    onSubmit: async ([current, next, confirmNext]) => {
      if (!(await lockVerifyPasscode(current))) return 'Current passcode is incorrect.';
      if (!next) return 'Enter a new passcode.';
      if (next !== confirmNext) return "New passcodes don't match.";
      await lockSetPasscode(next);
      lockManageStatus.textContent = 'Passcode changed.';
      setTimeout(() => (lockManageStatus.textContent = ''), 3000);
      return true;
    },
  });
});

lockRemoveBtn.addEventListener('click', () => {
  lockBuildInlineForm({
    fields: ['Current passcode'],
    submitLabel: 'Remove passcode',
    anchorEl: lockManageRow,
    onSubmit: async ([current]) => {
      if (!(await lockVerifyPasscode(current))) return 'Current passcode is incorrect.';
      await lockRemovePasscode();
      await refreshLockManagementUI();
      lockManageStatus.textContent = 'Passcode removed.';
      setTimeout(() => (lockManageStatus.textContent = ''), 3000);
      return true;
    },
  });
});

initLock();
