const setupCta = document.getElementById('setup-cta');
const statsEl = document.getElementById('stats');
const idleNote = document.getElementById('idle-note');
const researchCountEl = document.getElementById('research-count');
const reviewCountEl = document.getElementById('review-count');
const statsNote = document.getElementById('stats-note');

function setState({ showSetup, showStats, showIdle }) {
  setupCta.classList.toggle('show', showSetup);
  statsEl.classList.toggle('show', showStats);
  idleNote.style.display = showIdle ? 'block' : 'none';
}

async function init() {
  const { openrouterConfigs, openrouterKey, openrouterModel } = await chrome.storage.local.get([
    'openrouterConfigs',
    'openrouterKey',
    'openrouterModel',
  ]);
  const hasConfigRow = Array.isArray(openrouterConfigs) && openrouterConfigs.some((c) => c?.key && c?.model);
  const configured = hasConfigRow || Boolean(openrouterKey && openrouterModel);

  if (!configured) {
    setState({ showSetup: true, showStats: false, showIdle: false });
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onScholar = Boolean(tab?.url && tab.url.includes('scholar.google.com'));

  if (!onScholar || tab.id == null) {
    setState({ showSetup: false, showStats: false, showIdle: true });
    return;
  }

  chrome.runtime.sendMessage({ type: 'GET_TAB_STATUS', tabId: tab.id }, (stats) => {
    if (chrome.runtime.lastError || !stats) {
      setState({ showSetup: false, showStats: false, showIdle: true });
      return;
    }
    researchCountEl.textContent = String(stats.research || 0);
    reviewCountEl.textContent = String(stats.review || 0);
    statsNote.textContent =
      stats.total > 0 ? 'Classified so far on this tab.' : 'Waiting for results to load on this tab…';
    setState({ showSetup: false, showStats: true, showIdle: false });
  });
}

document.getElementById('open-settings-cta').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('gear').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// --- Collections section -----------------------------------------------
// Independent of the Scholar-tab logic above — collections are global, so
// this renders regardless of what tab is currently active.

const collectionsList = document.getElementById('collections-list');
const newCollectionBtn = document.getElementById('new-collection-btn');
const newCollectionForm = document.getElementById('new-collection-form');
const newCollectionInput = document.getElementById('new-collection-input');
const newCollectionErr = document.getElementById('new-collection-err');
const exportAllBtn = document.getElementById('export-all-btn');
const exportAllMenu = document.getElementById('export-all-menu');

async function renderCollectionsList() {
  const collections = await lens81GetAllCollections();
  const ids = Object.keys(collections).sort((a, b) =>
    collections[a].name.localeCompare(collections[b].name)
  );

  collectionsList.innerHTML = '';

  if (ids.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'collections-empty';
    empty.textContent = 'No collections yet. Save a paper on Google Scholar, or create one below.';
    collectionsList.appendChild(empty);
    return;
  }

  ids.forEach((id) => {
    const coll = collections[id];
    const row = document.createElement('div');
    row.className = 'collection-row';

    const name = document.createElement('span');
    name.className = 'cname';
    name.textContent = `📁 ${coll.name}`;

    const count = document.createElement('span');
    count.className = 'ccount';
    count.textContent = String(coll.paperIds.length);

    row.appendChild(name);
    row.appendChild(count);

    row.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL(`collection.html?id=${encodeURIComponent(id)}`) });
    });

    collectionsList.appendChild(row);
  });
}

function toggleNewCollectionForm(show) {
  newCollectionForm.style.display = show ? 'block' : 'none';
  newCollectionBtn.style.display = show ? 'none' : 'block';
  newCollectionErr.textContent = '';
  if (show) {
    newCollectionInput.value = '';
    newCollectionInput.focus();
  }
}

newCollectionBtn.addEventListener('click', () => toggleNewCollectionForm(true));
document.getElementById('new-collection-cancel').addEventListener('click', () => toggleNewCollectionForm(false));

async function submitNewCollection() {
  const name = newCollectionInput.value.trim();
  if (!name) {
    newCollectionErr.textContent = 'Enter a name.';
    return;
  }
  const res = await lens81CreateCollection(name);
  if (res.error === 'duplicate') {
    newCollectionErr.textContent = 'A collection with that name already exists.';
    return;
  }
  if (res.error) {
    newCollectionErr.textContent = 'Could not create the collection.';
    return;
  }
  toggleNewCollectionForm(false);
  await renderCollectionsList();
}

document.getElementById('new-collection-create').addEventListener('click', submitNewCollection);
newCollectionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitNewCollection();
});

exportAllBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  exportAllMenu.style.display = exportAllMenu.style.display === 'block' ? 'none' : 'block';
});
exportAllMenu.querySelectorAll('button[data-format]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    exportAllMenu.style.display = 'none';
    const count = await lens81ExportCollection(null, btn.dataset.format);
    flashExportFeedback(count);
  });
});
exportAllMenu.querySelectorAll('button[data-csl-style]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    exportAllMenu.style.display = 'none';
    const original = btn.textContent;
    btn.textContent = 'Formatting…';
    try {
      const count = await lens81ExportCollectionAsCsl(null, btn.dataset.cslStyle);
      flashExportFeedback(count);
    } finally {
      btn.textContent = original;
    }
  });
});
document.addEventListener('click', () => {
  exportAllMenu.style.display = 'none';
});

function flashExportFeedback(count) {
  const original = exportAllBtn.textContent;
  exportAllBtn.textContent = count > 0 ? `✓ Exported ${count}` : 'Nothing to export yet';
  exportAllBtn.disabled = true;
  setTimeout(() => {
    exportAllBtn.textContent = original;
    exportAllBtn.disabled = false;
  }, 1800);
}

renderCollectionsList();
init();
