const test = require('node:test');
const assert = require('node:assert');
const OX = require('../out/core/grid-core.js');
const G = OX.GridCore;

test('colName', () => {
  assert.equal(G.colName(0), 'A'); assert.equal(G.colName(25), 'Z'); assert.equal(G.colName(26), 'AA');
  assert.equal(G.colName(701), 'ZZ'); assert.equal(G.colName(702), 'AAA');
});

test('Axis uniform and custom', () => {
  const a = new G.Axis().build(1000, () => 20, null, 20, 1);
  assert.ok(a.uniform); assert.equal(a.total, 20000); assert.equal(a.indexAt(41), 2); assert.equal(a.offset(3), 60);
  const hidden = new Set([2]);
  const b = new G.Axis().build(5, i => (i === 1 ? 50 : 20), i => hidden.has(i), 20, 1);
  assert.ok(!b.uniform); assert.equal(b.offset(3), 70); assert.equal(b.total, 110);
  assert.equal(b.indexAt(70), 3); assert.equal(b.indexAt(69), 1); assert.equal(b.nextVisible(1, 1), 3); assert.equal(b.nextVisible(3, -1), 1);
  const z = new G.Axis().build(10, () => 20, null, 20, 2);
  assert.equal(z.total, 400); assert.equal(z.indexAt(81), 2);
  assert.equal(b.indexAt(1e9), 4); assert.equal(b.indexAt(-5), 0);
});

test('Axis hidden at start skipped by indexAt', () => {
  const b = new G.Axis().build(4, i => 20, i => i === 0 || i === 1, 20, 1);
  assert.equal(b.indexAt(0), 2);
});

test('empty axis', () => {
  const a = new G.Axis().build(0, () => 20, null, 20, 1);
  assert.equal(a.indexAt(10), 0); assert.equal(a.total, 0);
});

test('scrollScale', () => {
  assert.equal(G.scrollScale(1000, 500).ratio, 1);
  const s = G.scrollScale(100e6, 1000);
  assert.equal(s.cssTotal, 30e6);
  assert.ok(Math.abs(s.ratio * (30e6 - 1000) - (100e6 - 1000)) < 1);
});

test('MergeIndex', () => {
  const m = new G.MergeIndex([{ r1: 1, c1: 1, r2: 2, c2: 3 }]);
  assert.ok(m.at(2, 3)); assert.equal(m.at(0, 0), null);
  assert.deepEqual(m.expand(0, 0, 1, 1), { r1: 0, c1: 0, r2: 2, c2: 3 });
});

test('dataEdge', () => {
  const data = new Set(['0,0', '1,0', '2,0', '5,0', '6,0']);
  const e = (r, c) => !data.has(r + ',' + c);
  assert.deepEqual(G.dataEdge(e, 0, 0, 1, 0, 100, 5), { r: 2, c: 0 });
  assert.deepEqual(G.dataEdge(e, 2, 0, 1, 0, 100, 5), { r: 5, c: 0 });
  assert.deepEqual(G.dataEdge(e, 6, 0, 1, 0, 100, 5), { r: 100, c: 0 });
  assert.deepEqual(G.dataEdge(e, 5, 0, -1, 0, 100, 5), { r: 2, c: 0 });
  assert.deepEqual(G.dataEdge(e, 0, 0, -1, 0, 100, 5), { r: 0, c: 0 });
  assert.deepEqual(G.dataEdge(e, 0, 0, 0, 1, 100, 5), { r: 0, c: 5 });
});

test('TSV roundtrip with quotes and newlines', () => {
  const rows = [['a', 'b\tc', 'd"e'], ['x\ny', '', 'z']];
  const t = G.encodeTSV(rows);
  assert.deepEqual(G.decodeClipboard(t), rows);
});

test('decode TSV trailing newline and CRLF', () => {
  assert.deepEqual(G.decodeClipboard('1\t2\r\n3\t4\r\n'), [['1', '2'], ['3', '4']]);
  assert.deepEqual(G.decodeClipboard('hello'), [['hello']]);
  assert.deepEqual(G.decodeClipboard('a,b\nc,d'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(G.decodeClipboard('a, b'), [['a, b']]);
  assert.deepEqual(G.decodeClipboard('"a\nb"\t2'), [['a\nb', '2']]);
  assert.deepEqual(G.decodeClipboard('a\t\tb'), [['a', '', 'b']]);
});

test('fillSeries', () => {
  assert.deepEqual(G.fillSeries(['1', '2', '3']), { start: 1, step: 1, single: false });
  assert.equal(G.fillSeries(['1', '2', '4']), null);
  assert.equal(G.fillSeries(['a']), null);
  assert.equal(G.fmtNum(0.1 + 0.2), '0.3');
});

test('viewMap', () => {
  const v = G.makeViewMap(new Int32Array([3, 1, 2]), 5);
  assert.equal(v.toSource(0), 3); assert.equal(v.toView(1), 1); assert.equal(v.toView(3), 0); assert.equal(v.toView(7), 5);
  assert.equal(v.toView(0), -1); assert.equal(v.toSource(5), 7);
  assert.equal(G.makeViewMap(null, 7).count, 7);
});

test('findAll and markdown and widthcache', () => {
  const t = [['Apple', 'pie'], ['apple', 'x']];
  assert.deepEqual(G.findAll(2, 2, (r, c) => t[r][c], 'apple'), [0, 0, 1, 0]);
  assert.deepEqual(G.findAll(2, 2, (r, c) => t[r][c], 'apple', { matchCase: true }), [1, 0]);
  assert.deepEqual(G.findAll(2, 2, (r, c) => t[r][c], 'pi', { wholeCell: true }), []);
  assert.equal(G.toMarkdown([['a', 'b|'], ['1', '2']]), '| a | b\\| |\n| --- | --- |\n| 1 | 2 |');
  const w = new G.WidthCache(4); let n = 0;
  for (let i = 0; i < 20; i++) w.get('f', 't' + (i % 6), s => (n++, s.length));
  assert.ok(w.n <= 4);
  assert.equal(G.shiftFormula('=SUM(A1:B2)+$C$3+"A1"+D$4', 1, 1), '=SUM(B2:C3)+$C$3+"A1"+E$4');
  assert.equal(G.shiftFormula('=LOG10(A1)', 1, 0), '=LOG10(A2)');
  assert.equal(G.shiftFormula('=A1', -1, 0), '=#REF!');
  assert.equal(G.shiftFormula('plain', 1, 1), 'plain');
});

test('encodeTSV quotes tabs, newlines and quotes', () => {
  const t = G.encodeTSV([['a\tb', 'l1\nl2', 'say "hi"', 'plain']]);
  assert.equal(t, '"a\tb"\t"l1\nl2"\t"say ""hi"""\tplain');
  assert.deepEqual(G.decodeClipboard(t), [['a\tb', 'l1\nl2', 'say "hi"', 'plain']]);
});

test('toMarkdown escapes and handles ragged/large input', () => {
  assert.equal(G.toMarkdown([['a|b', 'c\nd'], ['', 'x\\y']]), '| a\\|b | c<br>d |\n| --- | --- |\n|  | x\\\\y |');
  assert.equal(G.toMarkdown([]), '');
  assert.equal(G.toMarkdown([['a'], ['b', 'c']]), '| a |  |\n| --- | --- |\n| b | c |');
  const big = Array.from({ length: 300000 }, () => ['x']);
  assert.ok(G.toMarkdown(big).length > 0);
});
