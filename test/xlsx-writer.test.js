'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.fflate = require('../out/vendor/fflate.js');
globalThis.SSF = require('../out/vendor/ssf.js');
const OX = require('../out/core/xlsx-writer.js');
const fflate = globalThis.fflate;
const XLSX = require('xlsx');

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELNS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const u8 = fflate.strToU8;
const str = fflate.strFromU8;
const XMLDECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// ---- helpers ----
function colName(c) { let s = ''; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = (c - 1 - m) / 26; } return s; }

function wellFormed(xml) {
  let i = 0;
  const n = xml.length, stack = [];
  let roots = 0;
  const ent = (s, what) => {
    const re = /&([^;\s]*);?/g; let m;
    while ((m = re.exec(s))) {
      if (!/^(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);$/.test(m[0].slice(1))) throw new Error('bad entity ' + m[0] + ' in ' + what);
    }
  };
  if (xml.startsWith('<?xml')) { const e = xml.indexOf('?>'); if (e < 0) throw new Error('bad decl'); i = e + 2; }
  while (i < n) {
    const lt = xml.indexOf('<', i);
    const text = xml.slice(i, lt < 0 ? n : lt);
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/.test(text)) throw new Error('illegal char in text');
    if (!stack.length && text.trim()) throw new Error('text outside root');
    ent(text, 'text');
    if (lt < 0) break;
    if (xml.startsWith('<!--', lt)) { const e = xml.indexOf('-->', lt); if (e < 0) throw new Error('bad comment'); i = e + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) { const e = xml.indexOf(']]>', lt); if (e < 0) throw new Error('bad cdata'); i = e + 3; continue; }
    if (xml.startsWith('<?', lt)) { const e = xml.indexOf('?>', lt); i = e + 2; continue; }
    if (xml[lt + 1] === '/') {
      const gt = xml.indexOf('>', lt);
      const name = xml.slice(lt + 2, gt).trim();
      if (stack.pop() !== name) throw new Error('tag mismatch at ' + lt + ' ' + name);
      i = gt + 1; continue;
    }
    // open tag: find '>' outside quotes
    let j = lt + 1, q = null;
    for (; j < n; j++) { const ch = xml[j]; if (q) { if (ch === q) q = null; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '>') break; else if (ch === '<') throw new Error('raw < in tag at ' + lt); }
    if (j >= n) throw new Error('unterminated tag');
    let body = xml.slice(lt + 1, j);
    const sc = body.endsWith('/');
    if (sc) body = body.slice(0, -1);
    const nm = /^[A-Za-z_][\w.\-]*(?::[A-Za-z_][\w.\-]*)?/.exec(body);
    if (!nm) throw new Error('bad tag name at ' + lt + ': ' + body.slice(0, 30));
    let rest = body.slice(nm[0].length);
    const seen = new Set();
    for (;;) {
      const am = /^\s+([A-Za-z_][\w.\-:]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(rest);
      if (!am) break;
      if (seen.has(am[1])) throw new Error('duplicate attr ' + am[1]);
      seen.add(am[1]);
      ent(am[2] !== undefined ? am[2] : am[3], 'attr');
      rest = rest.slice(am[0].length);
    }
    if (rest.trim()) throw new Error('bad attributes near: ' + rest.slice(0, 40) + ' in <' + nm[0]);
    if (!stack.length) { if (++roots > 1) throw new Error('multiple roots'); }
    if (!sc) stack.push(nm[0]);
    i = j + 1;
  }
  if (stack.length) throw new Error('unclosed ' + stack.join('/'));
  if (roots !== 1) throw new Error('no root');
  return true;
}

function colNum(ref) { let c = 0; for (const ch of ref) { const k = ch.charCodeAt(0); if (k >= 65 && k <= 90) c = c * 26 + k - 64; else break; } return c; }

// parse sheetData into [{r, cells:[{ref,col,s,t,v,f,fattrs,raw}]}] and validate ordering
function parseSheet(xml) {
  const rows = [];
  const sd = xml.indexOf('<sheetData');
  const body = sd < 0 ? '' : xml.slice(xml.indexOf('>', sd) + 1, xml.indexOf('</sheetData>') < 0 ? undefined : xml.indexOf('</sheetData>'));
  const rre = /<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g;
  let m, lastR = 0;
  while ((m = rre.exec(body))) {
    const r = +/\sr="(\d+)"/.exec(m[1])[1];
    assert.ok(r > lastR, 'rows sorted/unique: ' + r + ' after ' + lastR);
    lastR = r;
    const cells = [];
    if (m[3]) {
      const cre = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
      let cm, lastC = 0;
      while ((cm = cre.exec(m[3]))) {
        const ref = /\sr="([A-Z]+)(\d+)"/.exec(cm[1]);
        assert.equal(+ref[2], r, 'cell row matches row');
        const col = colNum(ref[1]);
        assert.ok(col > lastC, 'cells sorted/unique in row ' + r);
        lastC = col;
        const inner = cm[3] || '';
        const fm = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(inner);
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        const tm = /<is><t[^>]*>([\s\S]*?)<\/t><\/is>/.exec(inner);
        const sm = /\ss="([^"]*)"/.exec(cm[1]), tt = /\st="([^"]*)"/.exec(cm[1]);
        cells.push({ ref: ref[1] + ref[2], col, s: sm ? sm[1] : null, t: tt ? tt[1] : null, v: vm ? vm[1] : null, is: tm ? tm[1] : null, f: fm ? (fm[2] || '') : null, fattrs: fm ? fm[1] : null, raw: cm[0] });
      }
    }
    rows.push({ r, attrs: m[1], cells, raw: m[0] });
  }
  return rows;
}
const cellMap = (xml) => { const o = {}; for (const r of parseSheet(xml)) for (const c of r.cells) o[c.ref] = c; return o; };

function relsXml(rels) {
  return XMLDECL + '<Relationships xmlns="' + RELNS + '">' + rels.map((r) => '<Relationship Id="' + r[0] + '" Type="' + r[1] + '" Target="' + r[2] + '"/>').join('') + '</Relationships>';
}
const T = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';

const SHARED = ['Hello', 'World', 'Foo & Bar', 'Z'];
const STYLES = XMLDECL + '<styleSheet xmlns="' + NS + '"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

const SHEET1 = XMLDECL + '<worksheet xmlns="' + NS + '" xmlns:r="' + RNS + '"><sheetPr/><dimension ref="A1:C5"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>' +
  '<cols><col min="5" max="6" width="12" style="2" customWidth="1"/></cols><sheetData>' +
  '<row r="1" spans="1:3"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>2.5</v></c><c r="C1" t="str"><f>A1&amp;"x"</f><v>Hellox</v></c></row>' +
  '<row r="2" spans="1:3" ht="20" customHeight="1"><c r="A2" s="3"><v>10</v></c><c r="B2" s="1"><f t="shared" ref="B2:B4" si="0">A2*2+$A$1</f><v>20</v></c><c r="C2"/></row>' +
  '<row r="3"/>' +
  '<row r="4" spans="1:3"><c r="A4"><v>30</v></c><c r="B4" s="1"><f t="shared" si="0"/><v>60</v></c><c r="C4"><f t="array" ref="C4:C5">A4:A5*2</f><v>60</v></c></row>' +
  '<row r="5"><c r="A5"><v>40</v></c><c r="C5"><v>80</v></c></row>' +
  '</sheetData><mergeCells count="1"><mergeCell ref="A7:B8"/></mergeCells><conditionalFormatting sqref="A1:A5"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>5</formula></cfRule></conditionalFormatting><dataValidations count="1"><dataValidation type="list" sqref="D1"><formula1>"a,b"</formula1></dataValidation></dataValidations><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><drawing r:id="rId1"/></worksheet>';

const SHEET2_EMPTY = XMLDECL + '<worksheet xmlns="' + NS + '"><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
const SHEET3_NOSD = XMLDECL + '<worksheet xmlns="' + NS + '"><sheetViews><sheetView workbookViewId="0"/></sheetViews><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';

function wbXml(extra) {
  return XMLDECL + '<workbook xmlns="' + NS + '" xmlns:r="' + RNS + '"><workbookPr/><bookViews><workbookView/></bookViews><sheets><sheet name="One" sheetId="1" r:id="rId1"/><sheet name="Empty" sheetId="2" r:id="rId2"/><sheet name="NoData" sheetId="5" r:id="rId3"/></sheets><definedNames><definedName name="Foo">One!$A$1</definedName></definedNames>' + (extra === undefined ? '<calcPr calcId="191029"/>' : extra) + '</workbook>';
}

function buildFixture(o) {
  o = o || {};
  const png = new Uint8Array(300); for (let i = 0; i < png.length; i++) png[i] = (i * 37 + 11) & 255;
  const ct = XMLDECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' +
    '<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>' +
    '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>';
  const wbRels = relsXml([
    ['rId1', T + 'worksheet', o.absTarget ? '/xl/worksheets/sheet1.xml' : 'worksheets/sheet1.xml'],
    ['rId2', T + 'worksheet', 'worksheets/sheet2.xml'], ['rId3', T + 'worksheet', 'worksheets/sheet3.xml'],
    ['rId4', T + 'styles', 'styles.xml'], ['rId5', T + 'sharedStrings', 'sharedStrings.xml'], ['rId6', T + 'calcChain', 'calcChain.xml']]);
  const files = {
    'xl/workbook.xml': u8(o.wb || wbXml()),
    '[Content_Types].xml': u8(ct),
    '_rels/.rels': u8(relsXml([['rId1', T + 'officeDocument', 'xl/workbook.xml']])),
    'xl/_rels/workbook.xml.rels': u8(wbRels),
    'xl/worksheets/sheet1.xml': u8(o.sheet1 || SHEET1),
    'xl/worksheets/sheet2.xml': u8(SHEET2_EMPTY),
    'xl/worksheets/sheet3.xml': u8(SHEET3_NOSD),
    'xl/worksheets/_rels/sheet1.xml.rels': u8(relsXml([['rId1', T + 'drawing', '../drawings/drawing1.xml']])),
    'xl/drawings/drawing1.xml': u8(XMLDECL + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>'),
    'xl/drawings/_rels/drawing1.xml.rels': u8(relsXml([['rId1', T + 'chart', '../charts/chart1.xml']])),
    'xl/charts/chart1.xml': u8(XMLDECL + '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart/></c:chartSpace>'),
    'xl/media/image1.png': [png, { level: 0 }],
    'xl/styles.xml': u8(STYLES),
    'xl/sharedStrings.xml': u8(XMLDECL + '<sst xmlns="' + NS + '" count="4" uniqueCount="4">' + SHARED.map((s) => '<si><t>' + s.replace(/&/g, '&amp;') + '</t></si>').join('') + '</sst>'),
    'xl/calcChain.xml': u8(XMLDECL + '<calcChain xmlns="' + NS + '"><c r="C1" i="1"/><c r="B2" i="1"/></calcChain>'),
  };
  if (o.noCalcChain) { delete files['xl/calcChain.xml']; }
  return fflate.zipSync(files);
}

function patchAndRead(bytes, edits) {
  const out = OX.patchXlsx(bytes, edits);
  const z = fflate.unzipSync(out);
  return { out, z };
}
function allWellFormed(z) {
  for (const k of Object.keys(z)) if (/\.(xml|rels)$/.test(k)) wellFormed(str(z[k]));
}
const eq = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

// ---- tests ----
test('formula shifter', () => {
  const f = OX.writerShiftFormula;
  assert.equal(f('A1+$B$2', 1, 1), 'B2+$B$2');
  assert.equal(f('SUM(A1:B$3)', 2, 3), 'SUM(D3:E$3)');
  assert.equal(f("'My Sheet'!C5+LOG10(A1)", 1, 0), "'My Sheet'!C6+LOG10(A2)");
  assert.equal(f('"A1"&Sheet1!A:A', 0, 2), '"A1"&Sheet1!C:C');
  assert.equal(f('SUM($1:3)', 2, 0), 'SUM($1:5)');
  assert.equal(f("IF(A1>0,'it''s A1'!A1,#REF!)", 1, 0), "IF(A2>0,'it''s A1'!A2,#REF!)");
  assert.equal(f('Table1[[#This Row],[A1]]+B1', 1, 0), 'Table1[[#This Row],[A1]]+B2');
  assert.equal(f('$A1+A$1+1.5E3', 3, 3), '$A4+D$1+1.5E3');
  assert.equal(f('A1', -1, 0), 'A1048576');
  assert.equal(f('SUM(A1:A3)', 0, 0), 'SUM(A1:A3)');
  assert.equal(f('ATAN2(A1,B1)+STDEV.S(A1:A2)', 1, 0), 'ATAN2(A2,B2)+STDEV.S(A2:A3)');
});

test('escapeXml', () => {
  assert.equal(OX.escapeXml('a<b>&"c\u0001'), 'a&lt;b&gt;&amp;&quot;c');
});

test('basic edits: values, types, untouched entries identical, wellformed', () => {
  const orig = buildFixture();
  const zo = fflate.unzipSync(orig);
  const long = ' lead & trail <x> "q" \n line2\ttab ';
  const { out, z } = patchAndRead(orig, [
    { sheet: 0, r: 0, c: 0, cell: { t: 's', v: long } },
    { sheet: 0, r: 0, c: 1, cell: { t: 'n', v: 1e-7 } },
    { sheet: 0, r: 0, c: 3, cell: { t: 'b', v: true } },
    { sheet: 0, r: 0, c: 4, cell: { t: 'e', v: '#DIV/0!' } },
    { sheet: 0, r: 0, c: 5, cell: { t: 'n', v: 0, f: '=SUM(B1:B5)' } },
    { sheet: 0, r: 1, c: 0, cell: null }, // styled -> keep s
    { sheet: 0, r: 4, c: 0, cell: null }, // unstyled -> remove
    { sheet: 0, r: 2, c: 2, cell: { t: 'n', v: 7 } }, // row 3 self-closed
    { sheet: 0, r: 6, c: 4, cell: { t: 's', v: 'x\u0001y_x0041_' } }, // new row, col E has style 2
    { sheet: 0, r: 5, c: 1, cell: { t: 's', v: 'six' } },
    { sheet: 0, r: 9, c: 8, cell: { t: 'n', v: 123456789012345680000 } },
  ]);
  for (const k of Object.keys(zo)) {
    if (k === 'xl/worksheets/sheet1.xml' || k === 'xl/workbook.xml' || k === 'xl/calcChain.xml' || k === '[Content_Types].xml' || k === 'xl/_rels/workbook.xml.rels') continue;
    assert.ok(eq(z[k], zo[k]), 'identical ' + k);
  }
  assert.equal(Object.keys(z)[0], '[Content_Types].xml');
  allWellFormed(z);
  const xml = str(z['xl/worksheets/sheet1.xml']);
  const cm = cellMap(xml);
  assert.ok(cm.A1.is.includes(' lead &amp; trail &lt;x&gt; "q" \n line2\ttab '));
  assert.equal(cm.A1.t, 'inlineStr');
  assert.equal(cm.B1.v, '1e-7'); assert.equal(cm.B1.s, '1'); assert.equal(cm.B1.t, null);
  assert.equal(cm.D1.t, 'b'); assert.equal(cm.D1.v, '1');
  assert.equal(cm.E1.t, 'e'); assert.equal(cm.E1.v, '#DIV/0!');
  assert.equal(cm.F1.f, 'SUM(B1:B5)'); assert.equal(cm.F1.v, '0'); assert.equal(cm.F1.s, '2'); // col style
  assert.equal(cm.A2.raw, '<c r="A2" s="3"/>');
  assert.equal(cm.A5, undefined);
  assert.equal(cm.C3.v, '7');
  assert.equal(cm.E7.is, 'x_x0001_y_x005F_x0041_'); assert.equal(cm.E7.s, '2');
  assert.equal(cm.B6.is, 'six');
  assert.equal(cm.I10.v, '123456789012345680000');
  // untouched rows byte-identical
  assert.ok(xml.includes('<row r="4" spans="1:3"><c r="A4"><v>30</v></c>'));
  // everything outside sheetData unchanged except dimension
  assert.ok(xml.includes('<dimension ref="A1:I10"/>'));
  assert.ok(xml.includes('<mergeCells count="1"><mergeCell ref="A7:B8"/></mergeCells><conditionalFormatting'));
  assert.ok(xml.endsWith('<drawing r:id="rId1"/></worksheet>'));
  // touched row lost spans
  assert.ok(!/<row r="1"[^>]*spans/.test(xml));
  assert.ok(xml.includes('<row r="2" ht="20" customHeight="1">'));
  // sheetjs round trip
  const wb = XLSX.read(Buffer.from(out), { type: 'buffer' });
  const ws = wb.Sheets.One;
  assert.equal(ws.A1.v, long);
  assert.equal(ws.D1.v, true);
  assert.equal(ws.E1.t, 'e');
  assert.equal(ws.F1.f, 'SUM(B1:B5)');
  assert.equal(ws.E7.v, 'x\u0001y_x0041_');
  assert.equal(ws.A4.v, 30);
  assert.equal(ws.A5, undefined);
  assert.equal(ws.C4.v, 60);
});

test('cell values with formula keep cached value types', () => {
  const orig = buildFixture();
  const { z } = patchAndRead(orig, [
    { sheet: 0, r: 7, c: 0, cell: { t: 's', v: 'abc<', f: 'CONCAT("a","b<")' } },
    { sheet: 0, r: 7, c: 1, cell: { t: 'b', v: false, f: 'A1>2' } },
    { sheet: 0, r: 7, c: 2, cell: { t: 'n', f: 'A1&B1' } },
  ]);
  const xml = str(z['xl/worksheets/sheet1.xml']);
  wellFormed(xml);
  const cm = cellMap(xml);
  assert.equal(cm.A8.t, 'str'); assert.equal(cm.A8.f, '_xlfn.CONCAT("a","b&lt;")'); assert.equal(cm.A8.v, 'abc&lt;');
  assert.equal(cm.B8.t, 'b'); assert.equal(cm.B8.v, '0');
  assert.equal(cm.C8.v, null); assert.equal(cm.C8.f, 'A1&amp;B1');
});

test('insert order: cell before, between, after existing; duplicates last wins', () => {
  const orig = buildFixture();
  const { z } = patchAndRead(orig, [
    { sheet: 0, r: 3, c: 3, cell: { t: 'n', v: 1 } },
    { sheet: 0, r: 3, c: 3, cell: { t: 'n', v: 2 } },
    { sheet: 0, r: 4, c: 1, cell: { t: 'n', v: 3 } },
    { sheet: 0, r: 0, c: 2, cell: { t: 'n', v: 4 } },
  ]);
  const xml = str(z['xl/worksheets/sheet1.xml']);
  const rows = parseSheet(xml);
  assert.deepEqual(rows[3].cells.map((c) => c.ref), ['A4', 'B4', 'C4', 'D4']);
  assert.equal(cellMap(xml).D4.v, '2');
  assert.deepEqual(rows[4].cells.map((c) => c.ref), ['A5', 'B5', 'C5']);
  assert.equal(cellMap(xml).C1.v, '4');
  assert.equal(cellMap(xml).C1.f, null);
});

test('clearing nonexistent cells is a no-op returning identical bytes', () => {
  const orig = buildFixture();
  const out = OX.patchXlsx(orig, [{ sheet: 0, r: 100, c: 100, cell: null }, { sheet: 0, r: 0, c: 20, cell: null }]);
  assert.equal(out, orig);
  assert.equal(OX.patchXlsx(orig, []), orig);
});

test('shared formula master overwritten converts dependents', () => {
  const orig = buildFixture();
  const { z } = patchAndRead(orig, [{ sheet: 0, r: 1, c: 1, cell: { t: 'n', v: 99 } }]);
  const xml = str(z['xl/worksheets/sheet1.xml']);
  wellFormed(xml);
  const cm = cellMap(xml);
  assert.equal(cm.B2.f, null); assert.equal(cm.B2.v, '99');
  assert.equal(cm.B4.f, 'A4*2+$A$1');
  assert.equal(cm.B4.v, '60'); assert.equal(cm.B4.s, '1');
  assert.ok(!xml.includes('t="shared"'));
  const ws = XLSX.read(Buffer.from(OX.patchXlsx(orig, [{ sheet: 0, r: 1, c: 1, cell: { t: 'n', v: 99 } }])), { type: 'buffer' }).Sheets.One;
  assert.equal(ws.B4.f, 'A4*2+$A$1');
});

test('shared formula master replaced by another formula', () => {
  const orig = buildFixture();
  const { z } = patchAndRead(orig, [{ sheet: 0, r: 1, c: 1, cell: { t: 'n', v: 1, f: 'A1' } }]);
  const cm = cellMap(str(z['xl/worksheets/sheet1.xml']));
  assert.equal(cm.B2.f, 'A1'); assert.equal(cm.B4.f, 'A4*2+$A$1');
});

test('shared formula child overwritten keeps master', () => {
  const orig = buildFixture();
  const { z } = patchAndRead(orig, [{ sheet: 0, r: 3, c: 1, cell: { t: 'n', v: 5 } }]);
  const xml = str(z['xl/worksheets/sheet1.xml']);
  const cm = cellMap(xml);
  assert.equal(cm.B4.f, null); assert.equal(cm.B4.v, '5');
  assert.ok(cm.B2.fattrs.includes('shared'));
});

test('array formula: master overwrite ok, interior-only edit throws', () => {
  const orig = buildFixture();
  const { z } = patchAndRead(orig, [{ sheet: 0, r: 3, c: 2, cell: { t: 'n', v: 1 } }]);
  const cm = cellMap(str(z['xl/worksheets/sheet1.xml']));
  assert.equal(cm.C4.f, null); assert.equal(cm.C5.v, '80');
  assert.throws(() => OX.patchXlsx(orig, [{ sheet: 0, r: 4, c: 2, cell: { t: 'n', v: 1 } }]), /array formula/);
  // whole array cleared together is fine
  patchAndRead(orig, [{ sheet: 0, r: 3, c: 2, cell: null }, { sheet: 0, r: 4, c: 2, cell: null }]);
});

test('empty sheetData and missing sheetData', () => {
  const orig = buildFixture();
  const { out, z } = patchAndRead(orig, [
    { sheet: 1, r: 2, c: 1, cell: { t: 'n', v: 5 } }, { sheet: 1, r: 0, c: 0, cell: { t: 's', v: 'a' } },
    { sheet: 2, r: 0, c: 0, cell: { t: 'n', v: 1 } },
  ]);
  allWellFormed(z);
  const x2 = str(z['xl/worksheets/sheet2.xml']);
  assert.ok(x2.includes('<dimension ref="A1:B3"/>'));
  assert.ok(x2.includes('<sheetData><row r="1">'));
  assert.ok(x2.includes('</sheetData><pageMargins'));
  const x3 = str(z['xl/worksheets/sheet3.xml']);
  assert.ok(x3.includes('</sheetViews><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><mergeCells'));
  const wb = XLSX.read(Buffer.from(out), { type: 'buffer' });
  assert.equal(wb.Sheets.Empty.B3.v, 5);
  assert.equal(wb.Sheets.NoData.A1.v, 1);
});

test('calcChain removal bookkeeping and calcPr', () => {
  const orig = buildFixture();
  const { z } = patchAndRead(orig, [{ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: 1 } }]);
  assert.equal(z['xl/calcChain.xml'], undefined);
  assert.ok(!str(z['[Content_Types].xml']).includes('calcChain'));
  assert.ok(!str(z['xl/_rels/workbook.xml.rels']).includes('calcChain'));
  assert.ok(str(z['xl/_rels/workbook.xml.rels']).includes('sharedStrings'));
  assert.ok(str(z['xl/workbook.xml']).includes('<calcPr calcId="191029" fullCalcOnLoad="1"/>'));
  allWellFormed(z);
  // no calcPr: inserted after definedNames; existing fullCalcOnLoad="0" replaced; absent calcChain tolerated
  let r = patchAndRead(buildFixture({ wb: wbXml('') }), [{ sheet: 0, r: 0, c: 0, cell: null }]);
  assert.ok(str(r.z['xl/workbook.xml']).includes('</definedNames><calcPr fullCalcOnLoad="1"/></workbook>'));
  r = patchAndRead(buildFixture({ wb: wbXml('<calcPr calcId="1" fullCalcOnLoad="0"></calcPr><extLst/>') }), [{ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: 1 } }]);
  assert.ok(str(r.z['xl/workbook.xml']).includes('<calcPr calcId="1" fullCalcOnLoad="1"></calcPr><extLst/>'));
  r = patchAndRead(buildFixture({ wb: wbXml('<oleSize ref="A1"/>') }), [{ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: 1 } }]);
  assert.ok(str(r.z['xl/workbook.xml']).includes('<calcPr fullCalcOnLoad="1"/><oleSize'));
  r = patchAndRead(buildFixture({ noCalcChain: true }), [{ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: 1 } }]);
  assert.ok(!str(r.z['[Content_Types].xml']).includes('calcChain'));
  // option off leaves everything
  const o2 = fflate.unzipSync(OX.patchXlsx(orig, [{ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: 1 } }], { fullCalcOnLoad: false }));
  assert.ok(o2['xl/calcChain.xml']);
});

test('absolute rel target and prefixed workbook/rels names', () => {
  let r = patchAndRead(buildFixture({ absTarget: true }), [{ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: 1 } }]);
  assert.equal(cellMap(str(r.z['xl/worksheets/sheet1.xml'])).A1.v, '1');
  const wb = XMLDECL + '<x:workbook xmlns:x="' + NS + '" xmlns:r="' + RNS + '"><x:sheets><x:sheet name="One" sheetId="1" r:id="rId1"/><x:sheet name="Empty" sheetId="2" r:id="rId2"/><x:sheet name="NoData" sheetId="5" r:id="rId3"/></x:sheets><x:calcPr calcId="1"/></x:workbook>';
  r = patchAndRead(buildFixture({ wb }), [{ sheet: 1, r: 0, c: 0, cell: { t: 'n', v: 1 } }]);
  assert.ok(str(r.z['xl/workbook.xml']).includes('<x:calcPr calcId="1" fullCalcOnLoad="1"/>'));
  wellFormed(str(r.z['xl/workbook.xml']));
  const wb2 = wb.replace('<x:calcPr calcId="1"/>', '');
  r = patchAndRead(buildFixture({ wb: wb2 }), [{ sheet: 1, r: 0, c: 0, cell: { t: 'n', v: 1 } }]);
  assert.ok(str(r.z['xl/workbook.xml']).includes('</x:sheets><x:calcPr fullCalcOnLoad="1"/></x:workbook>'));
});

test('prefixed worksheet XML throws a clear error', () => {
  const s = XMLDECL + '<x:worksheet xmlns:x="' + NS + '"><x:sheetData><x:row r="1"><x:c r="A1"><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>';
  assert.throws(() => OX.patchXlsx(buildFixture({ sheet1: s }), [{ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: 2 } }]), /Prefixed worksheet/);
});

test('validation errors', () => {
  const orig = buildFixture();
  const e = (edit, re) => assert.throws(() => OX.patchXlsx(orig, [edit]), re);
  e({ sheet: 3, r: 0, c: 0, cell: null }, /out of range/);
  e({ sheet: -1, r: 0, c: 0, cell: null }, /Invalid sheet/);
  e({ sheet: 0, r: 1048576, c: 0, cell: null }, /out of range/);
  e({ sheet: 0, r: 0, c: 16384, cell: null }, /out of range/);
  e({ sheet: 0, r: -1, c: 0, cell: null }, /out of range/);
  e({ sheet: 0, r: 0.5, c: 0, cell: null }, /out of range/);
  e({ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: Infinity } }, /Invalid number/);
  e({ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: NaN } }, /Invalid number/);
  e({ sheet: 0, r: 0, c: 0, cell: { t: 'e', v: '#BOGUS' } }, /Invalid error/);
  e({ sheet: 0, r: 0, c: 0, cell: { t: 'x', v: 1 } }, /Invalid cell type/);
  e({ sheet: 0, r: 0, c: 0, cell: { t: 's', v: 'a'.repeat(32768) } }, /32767/);
  // max valid corner works
  const { z } = patchAndRead(orig, [{ sheet: 0, r: 1048575, c: 16383, cell: { t: 'n', v: 1 } }]);
  assert.ok(cellMap(str(z['xl/worksheets/sheet1.xml'])).XFD1048576);
  assert.ok(str(z['xl/worksheets/sheet1.xml']).includes('<dimension ref="A1:XFD1048576"/>'));
});

test('multiple sheets in one batch and patchXlsxSheets', () => {
  const orig = buildFixture();
  const a = OX.patchXlsx(orig, [{ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: 1 } }, { sheet: 1, r: 0, c: 0, cell: { t: 'n', v: 2 } }]);
  const b = OX.patchXlsxSheets(orig, { 0: [{ r: 0, c: 0, cell: { t: 'n', v: 1 } }], 1: [{ r: 0, c: 0, cell: { t: 'n', v: 2 } }] });
  const za = fflate.unzipSync(a), zb = fflate.unzipSync(b);
  for (const k of Object.keys(za)) assert.ok(eq(za[k], zb[k]), k);
  const wb = XLSX.read(Buffer.from(a), { type: 'buffer' });
  assert.equal(wb.Sheets.One.A1.v, 1); assert.equal(wb.Sheets.Empty.A1.v, 2);
});

test('double patch is stable and SheetJS-readable', () => {
  let b = buildFixture();
  for (let i = 0; i < 3; i++) b = OX.patchXlsx(b, [{ sheet: 0, r: i, c: 6, cell: { t: 's', v: 'n' + i } }]);
  const ws = XLSX.read(Buffer.from(b), { type: 'buffer' }).Sheets.One;
  assert.equal(ws.G3.v, 'n2'); assert.equal(ws.A1.v, 'Hello'); assert.equal(ws.B1.v, 2.5);
});

test('optional reader oracle', () => {
  let R; try { R = require('../out/core/xlsx-reader.js'); } catch (_) { return; }
  if (!R.readXlsx && !R.openXlsx && !R.parseXlsx) return;
});

// ---- fuzz ----
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function genModel(rand, NR, NC) {
  const m = new Map(); // "r,c" -> {kind, ...}
  for (let r = 0; r < NR; r++) for (let c = 0; c < NC; c++) {
    const x = rand();
    if (x < 0.45) continue;
    const s = rand() < 0.3 ? 1 + Math.floor(rand() * 3) : null;
    let cell;
    if (x < 0.6) cell = { k: 'n', v: Math.round(rand() * 1000) / 10 };
    else if (x < 0.7) cell = { k: 'sst', v: Math.floor(rand() * 4) };
    else if (x < 0.78) cell = { k: 'is', v: 'str' + r + '_' + c };
    else if (x < 0.84) cell = { k: 'f', f: colName(Math.max(0, c - 1)) + (r + 1) + '+1' };
    else if (x < 0.9) cell = { k: 'b', v: rand() < 0.5 };
    else cell = { k: 'z' };
    cell.s = s;
    m.set(r + ',' + c, cell);
  }
  return m;
}
function modelToXml(m, NR, NC, rand, shared) {
  const sst = (v) => v;
  let body = '';
  // optional shared formula groups: column NC-1 rows 2..6 (cells forced)
  for (let r = 0; r < NR; r++) {
    let cells = '', any = false;
    for (let c = 0; c < NC; c++) {
      const x = m.get(r + ',' + c);
      if (!x) continue;
      any = true;
      const ref = colName(c) + (r + 1), s = x.s ? ' s="' + x.s + '"' : '';
      if (x.k === 'n') cells += '<c r="' + ref + '"' + s + '><v>' + x.v + '</v></c>';
      else if (x.k === 'sst') cells += '<c r="' + ref + '"' + s + ' t="s"><v>' + x.v + '</v></c>';
      else if (x.k === 'is') cells += '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t>' + x.v + '</t></is></c>';
      else if (x.k === 'f') cells += '<c r="' + ref + '"' + s + '><f>' + x.f + '</f><v>1</v></c>';
      else if (x.k === 'b') cells += '<c r="' + ref + '"' + s + ' t="b"><v>' + (x.v ? 1 : 0) + '</v></c>';
      else if (x.k === 'z') cells += '<c r="' + ref + '"' + s + '/>';
      else if (x.k === 'shm') cells += '<c r="' + ref + '"' + s + '><f t="shared" ref="' + x.ref + '" si="' + x.si + '">' + x.f + '</f><v>1</v></c>';
      else if (x.k === 'shc') cells += '<c r="' + ref + '"' + s + '><f t="shared" si="' + x.si + '"/><v>1</v></c>';
    }
    if (!any) { if (rand() < 0.3) body += '<row r="' + (r + 1) + '"/>'; continue; }
    body += '<row r="' + (r + 1) + '"' + (rand() < 0.5 ? ' spans="1:' + NC + '"' : '') + (rand() < 0.2 ? ' ht="18" customHeight="1"' : '') + '>' + cells + '</row>';
  }
  return XMLDECL + '<worksheet xmlns="' + NS + '"><dimension ref="A1:' + colName(NC - 1) + NR + '"/><sheetData>' + body + '</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
}

test('fuzz: random edit batches against a model', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rand = rng(seed * 7919);
    const NR = 25, NC = 8;
    const model = genModel(rand, NR, NC);
    // shared formula groups: master at col c0 row r0, children below; formula "<left cell>*2"
    const groups = [];
    for (let g = 0; g < 2; g++) {
      const c0 = 1 + Math.floor(rand() * (NC - 1)), r0 = Math.floor(rand() * 10), len = 2 + Math.floor(rand() * 6);
      if ([...model.keys()].some((k) => { const [r, c] = k.split(',').map(Number); return c === c0 && r >= r0 && r < r0 + len; }) && g > 0) continue;
      const si = groups.length, ref = colName(c0) + (r0 + 1) + ':' + colName(c0) + (r0 + len);
      for (let i = 0; i < len; i++) model.set((r0 + i) + ',' + c0, i === 0 ? { k: 'shm', si, ref, f: colName(c0 - 1) + (r0 + 1) + '*2', s: null } : { k: 'shc', si, s: null });
      groups.push({ c0, r0, len });
    }
    const xml = modelToXml(model, NR, NC, rand);
    wellFormed(xml);
    const files = {
      '[Content_Types].xml': u8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="x"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="y"/></Types>'),
      'xl/workbook.xml': u8(XMLDECL + '<workbook xmlns="' + NS + '" xmlns:r="' + RNS + '"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': u8(relsXml([['rId1', T + 'worksheet', 'worksheets/sheet1.xml']])),
      'xl/worksheets/sheet1.xml': u8(xml),
    };
    const orig = fflate.zipSync(files);
    // edits
    const edits = [];
    const exp = new Map();
    const n = 1 + Math.floor(rand() * 25);
    for (let i = 0; i < n; i++) {
      const r = Math.floor(rand() * (NR + 6)), c = Math.floor(rand() * (NC + 3));
      const x = rand();
      let cell;
      if (x < 0.2) cell = null;
      else if (x < 0.45) cell = { t: 'n', v: Math.round(rand() * 1e6) / 100 };
      else if (x < 0.65) cell = { t: 's', v: 's<' + i + '&' + (rand() < 0.3 ? ' ' : '') };
      else if (x < 0.75) cell = { t: 'b', v: rand() < 0.5 };
      else if (x < 0.85) cell = { t: 'e', v: '#N/A' };
      else cell = { t: 'n', v: 0, f: 'A1+' + i };
      edits.push({ sheet: 0, r, c, cell });
      exp.set(r + ',' + c, cell);
    }
    const out = OX.patchXlsx(orig, edits);
    const z = fflate.unzipSync(out);
    const nx = str(z['xl/worksheets/sheet1.xml']);
    wellFormed(nx);
    const cm = cellMap(nx); // also asserts ordering
    // expected state per cell
    const killedShared = new Set();
    for (const g of groups) { if (exp.has(g.r0 + ',' + g.c0)) killedShared.add(g); }
    for (let r = 0; r < NR + 6; r++) for (let c = 0; c < NC + 3; c++) {
      const ref = colName(c) + (r + 1), got = cm[ref], key = r + ',' + c;
      if (exp.has(key)) {
        const e = exp.get(key), old = model.get(key);
        if (e === null) {
          if (old && old.s) { assert.ok(got && got.s === String(old.s) && got.v === null && got.f === null && got.t === null, 'cleared styled ' + ref); } else assert.equal(got, undefined, 'cleared ' + ref + ' seed ' + seed);
        } else {
          assert.ok(got, 'exists ' + ref);
          if (old && old.s) assert.equal(got.s, String(old.s)); else assert.ok(got.s === null || r >= 0);
          if (e.f) assert.equal(got.f, 'A1+' + e.f.slice(3));
          else if (e.t === 'n') assert.equal(+got.v, e.v);
          else if (e.t === 's') assert.equal(got.is, e.v.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
          else if (e.t === 'b') assert.equal(got.v, e.v ? '1' : '0');
          else assert.equal(got.v, '#N/A');
        }
      } else {
        const old = model.get(key);
        if (!old) { assert.equal(got, undefined, 'untouched empty ' + ref); continue; }
        assert.ok(got, 'untouched exists ' + ref);
        if (old.k === 'n') assert.equal(+got.v, old.v);
        else if (old.k === 'sst') assert.equal(got.t, 's');
        else if (old.k === 'is') assert.equal(got.is, old.v);
        else if (old.k === 'f') assert.equal(got.f, old.f);
        else if (old.k === 'z') assert.equal(got.raw.endsWith('/>'), true);
        else if (old.k === 'shm' || old.k === 'shc') {
          const g = groups[old.si];
          if (killedShared.has(g)) { assert.ok(!got.fattrs.includes('shared')); assert.equal(got.f, colName(c - 1) + (r + 1) + '*2', 'converted ' + ref + ' seed ' + seed); }
          else assert.ok(got.fattrs.includes('shared'));
        }
      }
    }
  }
});

// ---- perf ----
test('perf: 200k rows, 100 edits', () => {
  const NR = 200000;
  const rows = new Array(NR);
  for (let r = 1; r <= NR; r++) {
    rows[r - 1] = '<row r="' + r + '" spans="1:5"><c r="A' + r + '" t="s"><v>' + (r % 4) + '</v></c><c r="B' + r + '" s="1"><v>' + r * 1.5 + '</v></c><c r="C' + r + '"><f>B' + r + '*2</f><v>' + r * 3 + '</v></c><c r="D' + r + '" t="inlineStr"><is><t>row ' + r + '</t></is></c><c r="E' + r + '" s="2"/></row>';
  }
  const sheet = XMLDECL + '<worksheet xmlns="' + NS + '" xmlns:r="' + RNS + '"><dimension ref="A1:E' + NR + '"/><sheetData>' + rows.join('') + '</sheetData></worksheet>';
  const orig = buildFixture({ sheet1: sheet });
  const rand = rng(42);
  const edits = [];
  for (let i = 0; i < 100; i++) edits.push({ sheet: 0, r: Math.floor(rand() * (NR + 10)), c: Math.floor(rand() * 7), cell: i % 7 === 0 ? null : { t: 'n', v: i + 0.5 } });
  const t0 = process.hrtime.bigint();
  const out = OX.patchXlsx(orig, edits);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('perf: sheet ' + (sheet.length / 1e6).toFixed(1) + 'MB xml, zip ' + (orig.length / 1e6).toFixed(1) + 'MB -> ' + (out.length / 1e6).toFixed(1) + 'MB, 100 edits took ' + ms.toFixed(0) + ' ms');
  const x = str(fflate.unzipSync(out)['xl/worksheets/sheet1.xml']);
  const last = new Map(); for (const e of edits) last.set(e.r + ',' + e.c, e);
  const cm = {};
  const m = /<sheetData>/.exec(x);
  assert.ok(m);
  for (const [k, e] of last) {
    const [r, c] = k.split(',').map(Number);
    if (e.cell) assert.ok(x.includes('<c r="' + colName(c) + (r + 1) + '"'), 'edited cell present');
  }
  assert.ok(ms < 20000);
});
