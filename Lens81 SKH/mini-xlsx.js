// mini-xlsx.js
// A self-contained, dependency-free .xlsx writer.
//
// Why hand-rolled instead of a vendored library: this extension ships as
// unpacked source with no build/bundle step and no network access at
// runtime, so pulling in a third-party library means literally checking its
// full source into the repo. This file is a ~150-line replacement scoped to
// exactly what the Export feature needs — one sheet of strings — which
// keeps the "lightweight" requirement intact while still producing a real
// .xlsx file (not a renamed CSV) that opens correctly in Excel, Google
// Sheets, and LibreOffice Calc.
//
// An .xlsx file is a ZIP archive of a few small XML parts. This writer:
//   1. Builds those XML parts (workbook, one worksheet, minimal styles).
//   2. Packs them into a ZIP using the "store" method (no compression) —
//      fully valid per the ZIP spec, just not deduplicated, which is a
//      complete non-issue for spreadsheets this size.
//
// Exposed as window.buildLens81Xlsx(headers, rows) -> Blob.

(function () {
  // --- CRC-32 (needed by the ZIP format's local/central headers) ---------

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function strToBytes(str) {
    return new TextEncoder().encode(str);
  }

  // --- Minimal store-only ZIP writer --------------------------------------

  function buildZip(files) {
    // files: [{ name: 'xl/workbook.xml', data: Uint8Array }, ...]
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = strToBytes(file.name);
      const data = file.data;
      const crc = crc32(data);
      const size = data.length;

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); // local file header signature
      lv.setUint16(4, 20, true); // version needed
      lv.setUint16(6, 0, true); // flags
      lv.setUint16(8, 0, true); // method: 0 = store
      lv.setUint16(10, 0, true); // mod time
      lv.setUint16(12, 0, true); // mod date
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true); // compressed size
      lv.setUint32(22, size, true); // uncompressed size
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true); // extra field length
      local.set(nameBytes, 30);

      localParts.push(local, data);

      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true); // central directory signature
      cv.setUint16(4, 20, true); // version made by
      cv.setUint16(6, 20, true); // version needed
      cv.setUint16(8, 0, true); // flags
      cv.setUint16(10, 0, true); // method
      cv.setUint16(12, 0, true); // mod time
      cv.setUint16(14, 0, true); // mod date
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true); // extra length
      cv.setUint16(32, 0, true); // comment length
      cv.setUint16(34, 0, true); // disk number start
      cv.setUint16(36, 0, true); // internal attrs
      cv.setUint32(38, 0, true); // external attrs
      cv.setUint32(42, offset, true); // offset of local header
      central.set(nameBytes, 46);

      centralParts.push(central);
      offset += local.length + data.length;
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const part of centralParts) centralSize += part.length;

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); // end of central directory signature
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralStart, true);
    ev.setUint16(20, 0, true); // comment length

    return new Blob([...localParts, ...centralParts, end], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  // --- OOXML parts ----------------------------------------------------------

  function xmlEscape(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function colLetter(index) {
    // 0-based column index -> spreadsheet column letters (A, B, ..., Z, AA, ...)
    let n = index + 1;
    let s = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function rowXml(values, rowIndex, styleIndex) {
    const styleAttr = styleIndex ? ` s="${styleIndex}"` : '';
    const cells = values
      .map((v, colIndex) => {
        const ref = `${colLetter(colIndex)}${rowIndex}`;
        return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
      })
      .join('');
    return `<row r="${rowIndex}">${cells}</row>`;
  }

  const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const WORKBOOK_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Lens81 Export" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  // Canonical minimal styles.xml: two fonts (regular + bold for the header
  // row), the conventional two fills (some parsers, including Excel itself,
  // expect at least "none" and "gray125" to be present even if unused),
  // one border, and a cellStyles/"Normal" entry — the combination Excel
  // expects to open the file without offering to "repair" it.
  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>
    <font><sz val="11"/><color theme="1"/><name val="Calibri"/><b/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  function buildSheetXml(headers, rows) {
    const headerRow = rowXml(headers, 1, 1); // style index 1 = bold
    const bodyRows = rows.map((r, i) => rowXml(r, i + 2, 0)).join('');
    const lastCol = colLetter(Math.max(headers.length - 1, 0));
    const lastRow = rows.length + 1;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastCol}${lastRow}"/>
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <cols>
    <col min="1" max="${headers.length}" width="26" customWidth="1"/>
  </cols>
  <sheetData>${headerRow}${bodyRows}</sheetData>
</worksheet>`;
  }

  window.buildLens81Xlsx = function buildLens81Xlsx(headers, rows) {
    const files = [
      { name: '[Content_Types].xml', data: strToBytes(CONTENT_TYPES) },
      { name: '_rels/.rels', data: strToBytes(ROOT_RELS) },
      { name: 'xl/workbook.xml', data: strToBytes(WORKBOOK_XML) },
      { name: 'xl/_rels/workbook.xml.rels', data: strToBytes(WORKBOOK_RELS) },
      { name: 'xl/styles.xml', data: strToBytes(STYLES_XML) },
      { name: 'xl/worksheets/sheet1.xml', data: strToBytes(buildSheetXml(headers, rows)) },
    ];
    return buildZip(files);
  };
})();
