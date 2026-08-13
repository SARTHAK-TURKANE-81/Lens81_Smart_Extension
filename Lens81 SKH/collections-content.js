// collections-content.js
// Adds the "Save to Collection" control next to each Lens81 badge on a
// Google Scholar results page. Depends on collections.js (loaded first,
// see manifest.json) for all storage access, and cooperates with
// content.js's own openPanel/closeOpenPanel for the "why" panel so only
// one of "why" panel / collections popover is ever open at a time — they
// share the same content-script execution context, so calling content.js's
// functions directly here needs no message passing.

let lens81ActiveCollectPopover = null; // { pop, wrap, h3, meta }

function lens81CloseCollectPopover() {
  if (lens81ActiveCollectPopover) {
    lens81ActiveCollectPopover.pop.remove();
    lens81ActiveCollectPopover.wrap.classList.remove('lens81-save-open');
    lens81ActiveCollectPopover = null;
  }
}

// Pulls whatever metadata is available straight from the Scholar result
// card: the title link's href (used for the Google Scholar URL, and to
// mine a stable cluster id when present) and the "authors - venue - year"
// byline Scholar renders under every title.
function lens81ExtractMeta(resultEl, h3, title, classification) {
  const link = h3.querySelector('a');
  const url = link ? link.href : location.href;
  const authorsEl = resultEl.querySelector('.gs_a');
  const authors = authorsEl ? authorsEl.innerText.trim() : '';
  return {
    title,
    url,
    authors,
    type: classification && classification.type ? classification.type : '',
    confidence:
      classification && Number.isFinite(classification.confidence) ? classification.confidence : null,
  };
}

function lens81FolderLabel(paper, collections) {
  const names = (paper.collectionIds || [])
    .map((id) => collections[id] && collections[id].name)
    .filter(Boolean);
  return names;
}

async function lens81RefreshSaveControl(wrap, meta) {
  const paperId = lens81GetPaperId(meta);
  const [paper, collections] = await Promise.all([lens81GetPaper(paperId), lens81GetAllCollections()]);

  wrap.querySelector('.lens81-folder-badge')?.remove();
  const saveBtn = wrap.querySelector('.lens81-save-btn');
  const saved = Boolean(paper && paper.collectionIds.length > 0);

  if (saved) {
    const names = lens81FolderLabel(paper, collections);
    const folder = document.createElement('span');
    folder.className = 'lens81-folder-badge';
    folder.textContent = `📁 ${names.join(' • ')}`;
    folder.title = `Saved in: ${names.join(', ')}`;
    wrap.insertBefore(folder, saveBtn);
  }

  saveBtn.classList.toggle('saved', saved);
  saveBtn.textContent = saved ? '✔ Saved' : '➕ Save';
}

// Renders the "Save to Collection" checklist — the default view of the
// popover, and also what "Cancel" from the new-collection form returns to.
async function lens81RenderCollectList(pop, wrap, meta) {
  const paperId = lens81GetPaperId(meta);
  const [paper, collections] = await Promise.all([lens81GetPaper(paperId), lens81GetAllCollections()]);
  const memberIds = new Set(paper ? paper.collectionIds : []);

  pop.innerHTML = '';

  const heading = document.createElement('div');
  heading.className = 'lens81-collect-pop-title';
  heading.textContent = 'Save to Collection';
  pop.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'lens81-collect-pop-list';

  const ids = Object.keys(collections).sort((a, b) =>
    collections[a].name.localeCompare(collections[b].name)
  );

  if (ids.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lens81-collect-pop-empty';
    empty.textContent = 'No collections yet. Create your first one below.';
    list.appendChild(empty);
  }

  ids.forEach((id) => {
    const row = document.createElement('label');
    row.className = 'lens81-collect-pop-row';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = memberIds.has(id);

    const span = document.createElement('span');
    span.textContent = collections[id].name;

    row.appendChild(cb);
    row.appendChild(span);

    cb.addEventListener('change', async () => {
      row.classList.add('lens81-row-busy');
      await lens81TogglePaperInCollection(meta, id);
      await lens81RefreshSaveControl(wrap, meta);
      row.classList.remove('lens81-row-busy');
    });

    list.appendChild(row);
  });

  pop.appendChild(list);

  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'lens81-collect-pop-new';
  newBtn.textContent = '+ New Collection';
  newBtn.addEventListener('click', () => lens81RenderNewCollectionForm(pop, wrap, meta));
  pop.appendChild(newBtn);
}

// The inline "New Collection" name form — a small form swapped into the
// same popover, not a separate dialog, per the "no large dialogs" brief.
function lens81RenderNewCollectionForm(pop, wrap, meta) {
  pop.innerHTML = '';

  const heading = document.createElement('div');
  heading.className = 'lens81-collect-pop-title';
  heading.textContent = 'New Collection';
  pop.appendChild(heading);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'lens81-collect-pop-input';
  input.placeholder = 'Name';
  input.maxLength = 60;
  pop.appendChild(input);

  const err = document.createElement('div');
  err.className = 'lens81-collect-pop-err';
  pop.appendChild(err);

  const actions = document.createElement('div');
  actions.className = 'lens81-collect-pop-actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'lens81-collect-pop-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => lens81RenderCollectList(pop, wrap, meta));

  const create = document.createElement('button');
  create.type = 'button';
  create.className = 'lens81-collect-pop-create';
  create.textContent = 'Create';
  create.addEventListener('click', () => submit());

  actions.appendChild(cancel);
  actions.appendChild(create);
  pop.appendChild(actions);

  async function submit() {
    const name = input.value.trim();
    if (!name) {
      err.textContent = 'Enter a name.';
      return;
    }
    create.disabled = true;
    const res = await lens81CreateCollection(name);
    create.disabled = false;

    if (res.error === 'duplicate') {
      err.textContent = 'A collection with that name already exists.';
      return;
    }
    if (res.error) {
      err.textContent = 'Could not create the collection.';
      return;
    }

    // New collections should immediately hold the paper the user was
    // looking at when they created it.
    await lens81TogglePaperInCollection(meta, res.id);
    await lens81RefreshSaveControl(wrap, meta);
    lens81CloseCollectPopover();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  input.focus();
}

async function lens81OpenCollectPopover(wrap, h3, meta) {
  if (typeof closeOpenPanel === 'function') closeOpenPanel(); // close any open "why" panel
  if (lens81ActiveCollectPopover && lens81ActiveCollectPopover.wrap === wrap) {
    lens81CloseCollectPopover();
    return;
  }
  lens81CloseCollectPopover();

  const pop = document.createElement('div');
  pop.className = 'lens81-collect-pop';
  pop.addEventListener('click', (e) => e.stopPropagation());

  // Inline in the result card's flow, same placement pattern as the
  // existing "why" panel — no fixed-position math, scrolls naturally.
  const resultEl = wrap.closest('.gs_ri') || h3.parentElement;
  resultEl.appendChild(pop);
  wrap.classList.add('lens81-save-open');

  lens81ActiveCollectPopover = { pop, wrap, h3, meta };
  await lens81RenderCollectList(pop, wrap, meta);
}

// Builds the Save control + (if applicable) the saved-folder badge, and
// appends both next to the confirmed classification badge. Called once per
// result, right when content.js swaps the pending badge for the real one.
async function lens81AttachCollectionsControl(h3, resultEl, meta) {
  const wrap = document.createElement('span');
  wrap.className = 'lens81-collect';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'lens81-save-btn';
  saveBtn.textContent = '➕ Save';
  saveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    lens81OpenCollectPopover(wrap, h3, meta);
  });

  wrap.appendChild(saveBtn);
  h3.appendChild(wrap);

  await lens81RefreshSaveControl(wrap, meta);
}

document.addEventListener('click', lens81CloseCollectPopover);
