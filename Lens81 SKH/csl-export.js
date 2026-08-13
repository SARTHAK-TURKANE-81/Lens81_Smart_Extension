// csl-export.js
// "Formatted citations" export (APA/MLA/Chicago/IEEE reference lists) for
// Collections, via the real CSL engine in csl.js. Loaded only by
// collection.html and popup.html — both load vendor/citeproc.js and
// csl.js ahead of this file. Deliberately NOT part of the
// scholar.google.com content-script bundle (collections.js /
// collections-content.js / content.js): that bundle never loads
// citeproc-js at all (see manifest.json), and this file's only entry
// point is a button click inside collection.html/popup.html's own export
// menus, so there's no path by which it could run somewhere csl.js isn't
// loaded.

const LENS81_CSL_EXPORT_STYLE_LABELS = { apa: 'APA', mla: 'MLA', chicago: 'Chicago', ieee: 'IEEE' };

// Reuses exactly the fields lens81BuildExportRows() (collections.js)
// already gathers for the existing CSV/JSON/BibTeX/Markdown exports,
// reshaped into what csl.js's lens81ToCslItem() expects — no separate
// storage read.
function lens81ExportRowToPaper(row) {
  return { title: row.title, authors: row.authors, url: row.url };
}

// Returns the number of papers included, mirroring lens81ExportCollection's
// own return value, so the collection/popup page can show the same
// "Exported N papers" / "Nothing to export yet" feedback for both kinds of
// export.
async function lens81ExportCollectionAsCsl(collectionIdOrNull, styleKey) {
  const filter = collectionIdOrNull ? [collectionIdOrNull] : null;
  const rows = await lens81BuildExportRows(filter);
  if (rows.length === 0) return 0;

  let name = 'lens81-all-collections';
  let displayName = 'All collections';
  if (collectionIdOrNull) {
    const collections = await lens81GetAllCollections();
    const coll = collections[collectionIdOrNull];
    if (coll) {
      const slug = coll.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      name = 'lens81-' + (slug || 'collection');
      displayName = coll.name;
    }
  }

  const styleLabel = LENS81_CSL_EXPORT_STYLE_LABELS[styleKey] || styleKey.toUpperCase();
  let entries;
  try {
    entries = await lens81FormatBibliography(rows.map(lens81ExportRowToPaper), styleKey);
    if (!entries.length) throw new Error('CSL engine returned no entries');
  } catch (err) {
    // Defensive fallback: a missing bundled style/locale file, a
    // malformed record, or citeproc-js throwing internally must never
    // leave the export button silently doing nothing. Fall back to a
    // plain "Title — Authors (URL)" line per paper — not a real citation
    // style, but still a usable reading list, and clearly labeled as a
    // fallback rather than passed off as real APA/MLA/Chicago/IEEE.
    console.warn('Lens⁸¹: CSL bibliography export failed, using plain-text fallback.', err);
    styleLabel += ' (fallback: CSL formatting failed)';
    entries = rows.map((r) => `${r.title}${r.authors ? ', ' + r.authors : ''}${r.url ? ' (' + r.url + ')' : ''}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const lines = [`${displayName}: ${styleLabel} references`, `${entries.length} paper${entries.length === 1 ? '' : 's'} · exported ${today}`, '', ...entries];
  lens81DownloadTextFile(`${name}-${styleKey}.txt`, lines.join('\n\n'), 'text/plain;charset=utf-8');
  return entries.length;
}
