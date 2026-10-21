'use strict';
const test = require('node:test');
const assert = require('node:assert');
const OX = require('../out/core/csv-parser.js');
require('../out/core/csv-provider.js');

const mk = (text, o, po) => {
    const parsed = OX.indexCsv(text, Object.assign({ separator: ',', quote: '"' }, po));
    return new OX.CsvProvider(parsed, Object.assign({ hasHeaders: !!(po && po.hasHeaders) }, o));
};

test('header row frozen and styled', () => {
    const p = mk('Name,age\nbob,5\n', { capitalizeHeaders: true }, { hasHeaders: true });
    assert.strictEqual(p.frozenRows, 1);
    assert.strictEqual(p.rowCount, 2);
    const h = p.getCell(0, 1);
    assert.strictEqual(h.text, 'Age');
    assert.strictEqual(h.style.b, true);
    assert.ok(h.style.bg);
    assert.strictEqual(p.getRaw(0, 1), 'age');
    assert.strictEqual(p.getRaw(1, 0), 'bob');
    const q = mk('a,b\n', {}, {});
    assert.strictEqual(q.frozenRows, 0);
    assert.strictEqual(q.rowCount, 1);
});

test('number detection and formats', () => {
    const p = mk('1,007,1.5,-2e3,.5,abc,12345678901234567890,1.,+3,0x10,-,"9"\n', { formatValues: 'always' });
    const kinds = [];
    for (let c = 0; c < 12; c++) kinds.push(p.getCell(0, c).kind);
    assert.deepStrictEqual(kinds, [
        'number',
        'text',
        'number',
        'number',
        'number',
        'text',
        'text',
        'number',
        'number',
        'text',
        'text',
        'number'
    ]);
    const u = mk('1,"2"\n', { formatValues: 'unquoted' });
    assert.deepStrictEqual([u.getCell(0, 0).kind, u.getCell(0, 1).kind], ['number', 'text']);
    const n = mk('1\n', { formatValues: 'never' });
    assert.strictEqual(n.getCell(0, 0).kind, 'text');
    const f = mk('1234.5678\n', { formatValues: 'always', numberFormat: 'n2' });
    assert.strictEqual(f.getCell(0, 0).text, '1,234.57');
    assert.strictEqual(OX.formatNumberNet(1234.5678, 'g2'), '1200');
    assert.strictEqual(OX.formatNumberNet(1.256, 'f1'), '1.3');
    assert.strictEqual(OX.formatNumberNet(0.256, 'p0'), '26%');
    assert.strictEqual(OX.formatNumberNet(-1234567.891, 'n1'), '-1,234,567.9');
    assert.strictEqual(OX.formatNumberNet(5, 'd3'), '005');
    assert.strictEqual(OX.formatNumberNet(1234.5, 'c'), '$1,234.50');
    assert.strictEqual(OX.formatNumberNet(255, 'X'), 'FF');
    assert.strictEqual(OX.formatNumberNet(7, 'zzz'), '7');
});

test('multiline display and row height', () => {
    const t = 'a,"l1\nl2\nl3"\n';
    const p = mk(t, {});
    assert.strictEqual(p.getCell(0, 1).text, 'l1');
    assert.strictEqual(p.rowHeight(0), 24);
    assert.strictEqual(p.getRaw(0, 1), 'l1\nl2\nl3');
    const w = mk(t, { wrapMultiline: true });
    assert.strictEqual(w.getCell(0, 1).text, 'l1\nl2\nl3');
    assert.strictEqual(w.getCell(0, 1).style.wrap, true);
    assert.strictEqual(w.rowHeight(0), 24 + 2 * 16);
    const big = mk('"' + 'x\n'.repeat(20) + '"\n', { wrapMultiline: true });
    assert.strictEqual(big.rowHeight(0), 24 + 5 * 16);
});

test('column widths', () => {
    const p = mk(
        'a,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' +
            'b'.repeat(300) +
            '\n',
        {}
    );
    assert.strictEqual(p.colWidth(0), 48);
    assert.strictEqual(p.colWidth(1), 400);
    p.setColWidth(0, 120);
    assert.strictEqual(p.colWidth(0), 120);
    const m = mk('abcdefghij\n', { measure: s => s.length * 10 });
    assert.strictEqual(m.colWidth(0), 120);
});

test('line numbers', () => {
    const t = 'sep=,\nh1,h2\n# c\nx,y\n"m\nn",z\n';
    const mkp = ln => mk(t, { lineNumbers: ln }, { hasHeaders: true, commentChar: '#', skipComments: true });
    const s = mkp('source');
    assert.deepStrictEqual(
        [0, 1, 2].map(r => s.rowName(r)),
        ['2', '4', '5']
    );
    const o = mkp('ordinal');
    assert.deepStrictEqual(
        [1, 2].map(r => o.rowName(r)),
        ['1', '2']
    );
    assert.strictEqual(mkp('none').rowName(1), '');
});

test('source ranges after edits, deletes, appends', () => {
    const t = 'h\n# c\na\n"b\nb"\nc\n\nd\n';
    const p = mk(t, {}, { hasHeaders: true, commentChar: '#', skipComments: true });
    // rows: a(2), b(3-4), c(5), d(7)
    assert.deepStrictEqual(p.getSourceRange(0), { start: 0, end: 1 });
    assert.deepStrictEqual(
        [1, 2, 3, 4].map(r => p.getSourceRange(r).start),
        [2, 3, 5, 7]
    );
    assert.deepStrictEqual(p.getSourceRange(2), { start: 3, end: 5 });
    p.setCell(1, 0, 'x\ny\nz');
    assert.deepStrictEqual(p.getSourceRange(1), { start: 2, end: 5 });
    assert.deepStrictEqual(
        [2, 3, 4].map(r => p.getSourceRange(r).start),
        [5, 7, 9]
    );
    p.setCell(2, 0, 'single');
    assert.deepStrictEqual(
        [2, 3, 4].map(r => p.getSourceRange(r).start),
        [5, 6, 8]
    );
    const ranges = p.deleteRows([1, 3]);
    assert.deepStrictEqual(ranges, [
        { start: 2, end: 5 },
        { start: 6, end: 7 }
    ]);
    assert.strictEqual(p.rowCount, 3);
    assert.strictEqual(p.getRaw(1, 0), 'single');
    assert.strictEqual(p.getRaw(2, 0), 'd');
    assert.strictEqual(p.getSourceRange(1).start, 2);
    assert.strictEqual(p.getSourceRange(2).start, 4);
    const idx = p.appendRow();
    assert.strictEqual(idx, 3);
    assert.strictEqual(p.getRaw(3, 0), '');
    assert.strictEqual(p.getSourceRange(3).end - p.getSourceRange(3).start, 1);
});

test('append placement and header edits', () => {
    const p = mk('h\na\nb\n', {}, { hasHeaders: true });
    assert.strictEqual(p.getSourceRange(p.appendRow()).start, 3);
    const q = mk('h\na\nb', {}, { hasHeaders: true });
    assert.strictEqual(q.getSourceRange(q.appendRow()).start, 3);
    q.setCell(0, 0, 'h1\nh2');
    assert.deepStrictEqual(q.getSourceRange(0), { start: 0, end: 2 });
    assert.strictEqual(q.getSourceRange(1).start, 2);
    assert.strictEqual(q.getSourceRange(3).start, 4);
    q.setCell(1, 4, 'far');
    assert.strictEqual(q.colCount, 5);
    assert.strictEqual(q.getRaw(1, 4), 'far');
    assert.strictEqual(q.getRaw(2, 4), '');
});

test('serializeRow keeps original quoting', () => {
    const p = mk('"a",b\n', {});
    p.setCell(0, 1, 'x,y');
    assert.strictEqual(p.serializeRow(0), '"a","x,y"');
});

test('random edit consistency vs reparse', () => {
    let s = 12345;
    const r = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    for (let it = 0; it < 200; it++) {
        const n = 1 + Math.floor(r() * 8);
        const cells = Array.from({ length: n }, () => ['a', 'b\nc', 'd\ne\nf'][Math.floor(r() * 3)]);
        const gaps = Array.from({ length: n }, () => (r() < 0.3 ? '# k\n' : ''));
        const build = cs => cs.map((c, i) => gaps[i] + OX.serializeCsvField(c, ',', '"') + '\n').join('');
        const opts = { separator: ',', quote: '"', commentChar: '#', skipComments: true };
        const p = new OX.CsvProvider(OX.indexCsv(build(cells), opts), {});
        const k = Math.floor(r() * n);
        const val = ['z', 'q\nr', 'u\nv\nw'][Math.floor(r() * 3)];
        p.setCell(k, 0, val);
        cells[k] = val;
        const ref = OX.parseCsv(build(cells), opts);
        for (let i = 0; i < n; i++) {
            const range = p.getSourceRange(i);
            assert.strictEqual(range.start, ref.rowLine[i]);
            assert.strictEqual(range.end - range.start, ref.rowSpan[i]);
        }
    }
});

test('single-column empty rows serialize quoted so they survive a reparse', () => {
    const p = mk('a\n1\n2\n', {}, { hasHeaders: true });
    p.setCell(1, 0, '');
    assert.strictEqual(p.serializeRow(1), '""');
    const r = p.appendRow();
    assert.strictEqual(p.serializeRow(r), '""');
    const re = OX.parseCsv('a\n""\n2\n', { separator: ',', hasHeaders: true });
    assert.deepStrictEqual(re.rows, [[''], ['2']]);
});

test('user row heights survive and follow row deletion', () => {
    const p = mk('a\n1\n2\n3\n', {}, { hasHeaders: true });
    p.setRowHeight(3, 60);
    assert.strictEqual(p.rowHeight(3), 60);
    p.deleteRows([1]);
    assert.strictEqual(p.rowHeight(2), 60);
    assert.strictEqual(p.rowHeight(3), p.defaultRowHeight);
    assert.strictEqual(p.rowName(99), '');
});
