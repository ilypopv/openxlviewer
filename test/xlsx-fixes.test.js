'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.fflate = require('../out/vendor/fflate.js');
globalThis.SSF = require('../out/vendor/ssf.js');
const OX = require('../out/core/xlsx-reader.js');
require('../out/core/format.js');
require('../out/core/xlsx-writer.js');
require('../out/core/xlsx-provider.js');
const F = require('./helpers/xlsx-fixtures.js');

const unz = (b) => { const z = globalThis.fflate.unzipSync(b); const o = {}; for (const k in z) o[k] = globalThis.fflate.strFromU8(z[k]); return o; };
const MIN_STYLES = (extra) => F.HDR + `<styleSheet xmlns="${F.NS}">${extra.nf || ''}<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
function book(data, o) {
  o = o || {};
  return F.buildPackage({ sheets: [{ name: 'S', xml: F.sheetXml(Object.assign({ data }, o.sheet || {})), rels: o.rels }], styles: o.styles || MIN_STYLES({}), theme: F.THEME, extraFiles: o.extra });
}
function open(bytes) { const wb = OX.readXlsx(bytes); return { wb, p: new OX.XlsxProvider(wb, wb.loadSheet(0)) }; }
function save(bytes, p) { return OX.patchXlsx(bytes, p.pendingEdits(0)); }

test('typed date/percent/time keep their number format through view and save', () => {
  const bytes = book('<row r="1"><c r="A1"><v>1</v></c></row>');
  const { p } = open(bytes);
  const d = p.editFromText(0, 1, '2023-1-2');
  assert.equal(d.fmt, 'yyyy-mm-dd');
  p.setCell(0, 1, d);
  assert.equal(p.getCell(0, 1).text, '2023-01-02'); assert.equal(p.getCell(0, 1).kind, 'date');
  p.setCell(1, 0, p.editFromText(1, 0, '5%')); p.setCell(2, 0, p.editFromText(2, 0, '9%')); p.setCell(3, 0, p.editFromText(3, 0, '10:30'));
  assert.equal(p.getCell(1, 0).text, '5%'); assert.equal(p.getCell(3, 0).text, '10:30');
  const out = save(bytes, p);
  const z = unz(out);
  const st = z['xl/styles.xml'];
  assert.match(st, /<numFmts count="1">/); assert.match(st, /formatCode="yyyy-mm-dd"/); assert.ok(!/formatCode="h:mm"/.test(st)); // h:mm is builtin 20
  assert.match(st, /<cellXfs count="4">/); // default + date + 0% (builtin 9, shared by two cells) + time
  const wb2 = OX.readXlsx(out), sh = wb2.loadSheet(0);
  assert.equal(wb2.styles[sh.rows[0][1].s].fmt, 'yyyy-mm-dd');
  assert.equal(wb2.styles[sh.rows[1][0].s].fmt, '0%'); assert.equal(sh.rows[1][0].s, sh.rows[2][0].s);
  assert.equal(wb2.styles[sh.rows[3][0].s].fmt, 'h:mm');
  const p2 = new OX.XlsxProvider(wb2, sh);
  assert.equal(p2.getCell(0, 1).text, '2023-01-02');
});

test('derived xf clones the cell xf and reuses existing numFmt ids', () => {
  const styles = MIN_STYLES({ nf: '<numFmts count="1"><numFmt numFmtId="170" formatCode="yyyy-mm-dd"/></numFmts>' }).replace('</cellXfs>', '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf></cellXfs>').replace('cellXfs count="1"', 'cellXfs count="2"');
  const bytes = book('<row r="1"><c r="A1" s="1"><v>1</v></c></row>', { styles });
  const { p } = open(bytes);
  p.setCell(0, 0, p.editFromText(0, 0, '2024-01-05'));
  const st = unz(save(bytes, p))['xl/styles.xml'];
  assert.match(st, /<numFmts count="1">/); assert.match(st, /<cellXfs count="3">/);
  assert.match(st, /numFmtId="170"[^>]*applyNumberFormat="1"[^>]*>\s*<alignment horizontal="center"\/>/);
});

test('styles.xml without numFmts or with prefixed names', () => {
  const pref = F.HDR + `<x:styleSheet xmlns:x="${F.NS}"><x:fonts count="1"><x:font><x:sz val="11"/></x:font></x:fonts><x:fills count="1"><x:fill><x:patternFill patternType="none"/></x:fill></x:fills><x:borders count="1"><x:border/></x:borders><x:cellXfs count="1"><x:xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></x:cellXfs></x:styleSheet>`;
  const bytes = book('<row r="1"><c r="A1"><v>1</v></c></row>', { styles: pref });
  const out = OX.patchXlsx(bytes, [{ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: 45000, fmt: 'dd/mm/yyyy' } }]);
  const st = unz(out)['xl/styles.xml'];
  assert.match(st, /<x:styleSheet[^>]*><x:numFmts count="1"><x:numFmt numFmtId="164" formatCode="dd\/mm\/yyyy"\/><\/x:numFmts>/);
  assert.match(st, /<x:cellXfs count="2">/);
  const wb = OX.readXlsx(out);
  assert.equal(wb.styles[wb.loadSheet(0).rows[0][0].s].fmt, 'dd/mm/yyyy');
  // no cellXfs at all
  const none = F.HDR + `<styleSheet xmlns="${F.NS}"><fonts count="1"><font><sz val="11"/></font></fonts><dxfs count="0"/></styleSheet>`;
  const o2 = OX.patchXlsx(book('<row r="1"/>', { styles: none }), [{ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: 0.5, fmt: '0.0%' } }]);
  const s2 = unz(o2)['xl/styles.xml'];
  assert.ok(s2.indexOf('<cellXfs count="2">') < s2.indexOf('<dxfs'));
  const w2 = OX.readXlsx(o2); assert.equal(w2.styles[w2.loadSheet(0).rows[0][0].s].fmt, '0.0%');
});

test('invalid input is refused by the provider and by the writer', () => {
  const bytes = book('<row r="1"><c r="A1"><v>1</v></c></row>');
  const { p } = open(bytes);
  for (const t of ['=SUM(', '=A1+', '=("a"', '=SUM(1;2)', '="abc', '=IF(A1,{1,2)', '=1)', '==1']) assert.ok(p.editFromText(0, 1, t).error, t);
  assert.ok(p.editFromText(0, 1, 'x'.repeat(40000)).error);
  assert.equal(p.editFromText(0, 1, '=SUM(A1,"a)b",\'Sheet 1\'!A1)').error, undefined);
  assert.equal(p.editFromText(0, 1, '=A1&"x"').f, 'A1&"x"');
  const before = p.dirty; p.setCell(0, 1, { error: 'x' }); assert.equal(p.dirty, before);
  assert.throws(() => OX.patchXlsx(bytes, [{ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: null, f: 'SUM(' } }]), /Invalid formula/);
  assert.throws(() => OX.patchXlsx(bytes, [{ sheet: 0, r: 0, c: 0, cell: { t: 's', v: 'x'.repeat(32768) } }]), /32767/);
  assert.throws(() => OX.patchXlsx(bytes, [{ sheet: 0, r: 0, c: 0, cell: { t: 'e', v: '#BOGUS!' } }]), /error value/);
  assert.doesNotThrow(() => OX.patchXlsx(bytes, [{ sheet: 0, r: 0, c: 0, cell: { t: 'e', v: '#SPILL!' } }]));
});

test('_xlfn prefixes are added on write and hidden on read', () => {
  const bytes = book('<row r="1"><c r="A1"><v>1</v></c></row>');
  const { p } = open(bytes);
  p.setCell(0, 1, p.editFromText(0, 1, '=XLOOKUP(1,A1:A2,B1:B2)+IFERROR(1,2)+_xlfn.IFS(1,2)+"CONCAT(x)"'));
  p.setCell(0, 2, p.editFromText(0, 2, '=sort(filter(A1:A9,A1:A9>1))+STDEV.S(A1:A3)+Sheet1!A1'));
  assert.equal(p.getRaw(0, 1), '=XLOOKUP(1,A1:A2,B1:B2)+IFERROR(1,2)+_xlfn.IFS(1,2)+"CONCAT(x)"');
  const out = save(bytes, p);
  const x = unz(out)['xl/worksheets/sheet1.xml'];
  assert.ok(x.includes('<f>_xlfn.XLOOKUP(1,A1:A2,B1:B2)+IFERROR(1,2)+_xlfn.IFS(1,2)+"CONCAT(x)"</f>'), x);
  assert.ok(x.includes('<f>_xlfn._xlws.SORT(_xlfn._xlws.FILTER(A1:A9,A1:A9&gt;1))+_xlfn.STDEV.S(A1:A3)+Sheet1!A1</f>'), x);
  const sh = OX.readXlsx(out).loadSheet(0);
  assert.equal(sh.rows[0][1].f, 'XLOOKUP(1,A1:A2,B1:B2)+IFERROR(1,2)+IFS(1,2)+"CONCAT(x)"'); // read strips every prefix
  assert.equal(sh.rows[0][2].f, 'SORT(FILTER(A1:A9,A1:A9>1))+STDEV.S(A1:A3)+Sheet1!A1');
});

const TABLE_RELS = F.HDR + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${F.NS_R}/table" Target="../tables/table1.xml"/></Relationships>`;
const TABLE = F.HDR + `<table xmlns="${F.NS}" id="1" name="T1" displayName="T1" ref="A1:B3"><autoFilter ref="A1:B3"/><tableColumns count="2"><tableColumn id="1" name="Name"/><tableColumn id="2" name="Qty &amp; Co"><calculatedColumnFormula>T1[[#This Row],[Name]]</calculatedColumnFormula></tableColumn></tableColumns></table>`;
function tableBook() {
  return book('<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Qty &amp; Co</t></is></c></row><row r="2"><c r="A2"><v>1</v></c></row>',
    { sheet: { post: '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>' }, rels: TABLE_RELS, extra: { 'xl/tables/table1.xml': TABLE } });
}

test('table header edits rename tableColumn and are validated', () => {
  const bytes = tableBook();
  const { wb, p } = open(bytes);
  assert.equal(wb.loadSheet(0).tables.length, 1);
  assert.ok(p.editFromText(0, 0, '').error); assert.ok(p.editFromText(0, 0, '=1+1').error); assert.ok(p.editFromText(0, 0, 'Qty & Co').error);
  const ok = p.editFromText(0, 0, 'Renamed'); assert.equal(ok.t, 's');
  p.setCell(0, 0, ok);
  const n = p.editFromText(0, 1, '5'); assert.deepEqual([n.t, n.v], ['s', '5']);
  p.setCell(0, 1, n);
  const z = unz(save(bytes, p));
  assert.match(z['xl/tables/table1.xml'], /<tableColumn id="1" name="Renamed"\/>/); assert.match(z['xl/tables/table1.xml'], /<tableColumn id="2" name="5">/);
  assert.match(z['xl/tables/table1.xml'], /\[Renamed\]/);
  assert.match(z['xl/worksheets/sheet1.xml'], /<c r="B1" t="inlineStr"><is><t xml:space="preserve">5<\/t>/);
  assert.throws(() => OX.patchXlsx(bytes, [{ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: null, f: 'A2' } }]), /header/);
  assert.throws(() => OX.patchXlsx(bytes, [{ sheet: 0, r: 0, c: 0, cell: null }]), /empty/);
  assert.throws(() => OX.patchXlsx(bytes, [{ sheet: 0, r: 0, c: 0, cell: { t: 's', v: 'qty & co' } }]), /unique/);
});

test('array interior edits give a clear message', () => {
  const bytes = book('<row r="1"><c r="A1"><f t="array" ref="A1:A2">B1:B2</f><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>');
  const { p } = open(bytes);
  assert.match(p.editFromText(1, 0, '7').error, /array formula \(A2 is inside A1:A2\)/);
  assert.ok(p.editFromText(0, 0, '7').error === undefined);
  assert.throws(() => OX.patchXlsx(bytes, [{ sheet: 0, r: 1, c: 0, cell: { t: 'n', v: 1 } }]), /inside the array A1:A2/);
  // single-quoted attribute variants are recognised
  const sq = book('<row r="1"><c r="A1"><f t=\'array\' ref=\'A1:A2\'>B1:B2</f><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>');
  assert.throws(() => OX.patchXlsx(sq, [{ sheet: 0, r: 1, c: 0, cell: { t: 'n', v: 1 } }]), /array/);
  const sh = book('<row r="1"><c r="A1"><v>1</v><f t=\'shared\' ref="A1:A2" si="0">B1+1</f></c></row><row r="2"><c r="A2"><f t=\'shared\' si="0"/><v>2</v></c></row>');
  const z = unz(OX.patchXlsx(sh, [{ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: 5 } }]))['xl/worksheets/sheet1.xml'];
  assert.match(z, /<c r="A2"><f>B2\+1<\/f>/);
});

test('reader: tab colors up front, column/row styles, clearing keeps style, zeroHeight', () => {
  const styles = MIN_STYLES({}).replace('<fills count="2">', '<fills count="3">').replace('</fills>', '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills>').replace('</cellXfs>', '<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0"/></cellXfs>').replace('cellXfs count="1"', 'cellXfs count="2"');
  const x1 = F.sheetXml({ pr: '<sheetPr><tabColor rgb="FFFF0000"/></sheetPr>', cols: '<cols><col min="2" max="3" width="9" style="1"/></cols>', fmt: '<sheetFormatPr defaultRowHeight="15" zeroHeight="1"/>', data: '<row r="1"><c r="A1" s="1"><v>1</v></c></row><row r="3" s="1" customFormat="1"><c r="A3"><v>2</v></c></row><row r="4" hidden="1"/>' });
  const x2 = F.sheetXml({ pr: '<sheetPr><tabColor theme="5"/></sheetPr>', data: '' });
  const bytes = F.buildPackage({ sheets: [{ name: 'A', xml: x1 }, { name: 'B', xml: x2 }], styles, theme: F.THEME });
  const wb = OX.readXlsx(bytes);
  assert.deepEqual(wb.sheets.map((s) => s.tabColor), ['#ff0000', '#ed7d31']);
  const sh = wb.loadSheet(0), p = new OX.XlsxProvider(wb, sh);
  assert.equal(p.getCell(5, 1).style.bg, '#ffff00'); assert.equal(p.getCell(5, 2).style.bg, '#ffff00'); assert.equal(p.getCell(5, 3), undefined);
  assert.equal(p.getCell(2, 7).style.bg, '#ffff00'); assert.equal(p.getCell(1, 0), undefined);
  assert.equal(p.isRowHidden(0), false); assert.equal(p.isRowHidden(1), true); assert.equal(p.isRowHidden(3), true);
  // typing into a blank cell of a styled column keeps the column style in the view
  assert.equal(p.editFromText(5, 1, 'hi').s, 1);
  // clearing a styled cell keeps its style visible
  const cl = p.editFromText(0, 0, ''); assert.equal(cl.cleared, true);
  p.setCell(0, 0, null);
  assert.equal(p.getCell(0, 0).style.bg, '#ffff00'); assert.equal(p.getCell(0, 0).text, '');
  const e = p.pendingEdits(0); assert.deepEqual(e.map((x) => x.cell), [null]);
});

test('reader: part lookup is case-insensitive, hyperlinks sanitized, merges clamped, CDATA formulas', () => {
  const x = F.sheetXml({ data: '<row r="1"><c r="A1"><f><![CDATA[IF(A2<2,1,0)]]></f><v>1</v></c><c r="B1"><f>_xlfn.CONCAT("a","b")</f></c></row>', post: '<mergeCells count="2"><mergeCell ref="A1:XFE2"/><mergeCell ref="A3:B4"/></mergeCells><hyperlinks><hyperlink ref="A1" r:id="rId1"/></hyperlinks>' });
  const rels = F.HDR + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${F.NS_R}/hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>`;
  const z = globalThis.fflate.unzipSync(F.buildPackage({ sheets: [{ name: 'S', xml: x, rels }], styles: MIN_STYLES({}), theme: F.THEME }));
  const o = {};
  for (const k in z) o[k === 'xl/worksheets/sheet1.xml' ? 'XL/Worksheets/Sheet1.xml' : k] = z[k];
  const wb = OX.readXlsx(F.zip(o));
  const sh = wb.loadSheet(0);
  assert.equal(sh.warning, null);
  assert.equal(sh.rows[0][0].f, 'IF(A2<2,1,0)'); assert.equal(sh.rows[0][1].f, 'CONCAT("a","b")');
  assert.deepEqual(sh.merges, [{ r1: 2, c1: 0, r2: 3, c2: 1 }]);
  assert.equal(sh.hyperlinks.size, 0);
});

test('undo shrinks the provider extent; no-op edits are not written', () => {
  const bytes = book('<row r="1"><c r="A1"><v>1</v></c></row>');
  const { p } = open(bytes);
  const rc = p.rowCount;
  const slot = p.setCell(30, 30, { t: 'n', v: 1 });
  assert.equal(p.rowCount, 31);
  p.restoreSlot(30, 30, slot);
  assert.equal(p.rowCount, rc); assert.equal(p.colCount, 1);
  p.setCell(0, 0, p.editFromText(0, 0, '2')); p.setCell(0, 0, p.editFromText(0, 0, '1'));
  assert.equal(p.pendingEdits(0).length, 0);
});
