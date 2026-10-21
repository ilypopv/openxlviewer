'use strict';
const test = require('node:test');
const assert = require('node:assert');
const OX = require('../out/core/csv-parser.js');
require('../out/core/csv-provider.js');

let seed = 987654321;
const rnd = n => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 4294967296) * n);
};
const drain = g => {
    let r = g.next();
    while (!r.done) r = g.next();
    return r.value;
};
const VALS = [
    '',
    '1',
    '2.5',
    '-3',
    'abc',
    'Abd',
    '10',
    '007',
    'x y',
    '1e3',
    'é',
    '"q"',
    '"1"',
    '"a""b"',
    '"l1\nl2"',
    '"3,4"',
    'zz'
];
const mkText = (rows, cols, hdr) => {
    let t = hdr ? Array.from({ length: cols }, (_, c) => 'h' + c).join(',') + '\n' : '';
    for (let r = 0; r < rows; r++) t += Array.from({ length: cols }, () => VALS[rnd(VALS.length)]).join(',') + '\n';
    return t;
};
const firstLine = s => s.split(/\r\n|\n|\r/, 1)[0];

test('randomized interleaving of scans, reads and edits matches a plain model', () => {
    for (let it = 0; it < 120; it++) {
        const hdr = rnd(2) === 0,
            cols = 1 + rnd(5),
            nrows = 1 + rnd(12);
        const text = mkText(nrows, cols, hdr);
        const parsed = OX.parseCsv(text, { separator: ',', quote: '"', hasHeaders: hdr });
        const fv = ['never', 'always', 'unquoted'][rnd(3)];
        const p = new OX.CsvProvider(OX.indexCsv(text, { hasHeaders: hdr }), { hasHeaders: hdr, formatValues: fv });
        const model = parsed.rows.map(r => r.slice());
        const head = hdr ? parsed.header.slice() : null;
        const off = hdr ? 1 : 0;
        const gens = [];
        const modelAt = (r, c) => {
            if (hdr && r === 0) return head[c] === undefined ? '' : head[c];
            const row = model[r - off];
            return row && row[c] !== undefined ? row[c] : '';
        };
        const verify = (r, c) => {
            assert.strictEqual(p.getRaw(r, c), modelAt(r, c), `raw ${r},${c}`);
            const cv = p.getCell(r, c),
                want = modelAt(r, c);
            if (c >= p.colCount) assert.strictEqual(cv, undefined, `padding ${r},${c}`);
            else if (want === '') assert.strictEqual(cv, undefined, `blank ${r},${c}`);
            else if (cv.kind === 'text') assert.strictEqual(cv.text, firstLine(want).slice(0, 2000), `cell ${r},${c}`);
        };
        for (let k = 0; k < 40; k++) {
            const op = rnd(11),
                R = p.rowCount,
                C = p.colCount;
            if (op === 0) gens.push(p.sortKeyColumn(rnd(C)));
            else if (op === 1) gens.push(p.columnIds(rnd(C), 100, rnd(2) === 0));
            else if (op === 2) {
                const a = { cnt: 0, nums: 0, sum: 0, min: 0, max: 0 };
                gens.push(p.rangeStats(a, null, 0, R - 1, 0, C - 1));
            } else if (op === 3 && gens.length) {
                const g = gens[rnd(gens.length)];
                for (let i = rnd(3); i >= 0; i--) g.next();
            } else if (op === 4 && gens.length) {
                drain(gens.splice(rnd(gens.length), 1)[0]);
            } else if (op === 5 && R > off) {
                const r = off + rnd(R - off),
                    c = rnd(C),
                    v = ['', 'z', 'a\nb', 'q"r', '12'][rnd(5)];
                p.setCell(r, c, v);
                model[r - off][c] = v;
            } else if (op === 6) {
                p.appendRow();
                model.push([]);
            } else if (op === 7 && R > off) {
                const r = off + rnd(R - off);
                p.deleteRows([r]);
                model.splice(r - off, 1);
                gens.length = 0;
            } else if (op === 8 && R > off) {
                const c = C + rnd(2),
                    r = off + rnd(R - off);
                p.setCell(r, c, 'w');
                while (model[r - off].length <= c) model[r - off].push('');
                model[r - off][c] = 'w';
            } else if (op === 9 && hdr) {
                const c = rnd(C);
                p.setCell(0, c, 'H' + rnd(5));
                head[c] = p.getRaw(0, c);
            }
            // random reads, including the row last touched by a scan and padding cells
            for (let i = 0; i < 6; i++) verify(rnd(p.rowCount + 1), rnd(p.colCount + 2));
            if (p.rowCount > off) {
                const r = off + rnd(p.rowCount - off);
                const row = OX.parseCsv(p.serializeRow(r), { separator: ',', quote: '"' }).rows[0];
                for (let c = 0; c < p.colCount; c++)
                    assert.strictEqual(
                        row ? (row[c] === undefined ? '' : row[c]) : '',
                        modelAt(r, c),
                        `serialize ${r},${c}`
                    );
            }
        }
        for (const g of gens) drain(g);
        for (let r = 0; r < p.rowCount; r++) for (let c = 0; c < p.colCount + 2; c++) verify(r, c);
    }
});

test('stats / sort / filter scans never change what getRaw and getCell return', () => {
    const p = new OX.CsvProvider(OX.indexCsv('c0,c1\nA,1\nB,2\nC,3\nD,4\n', { hasHeaders: true }), {
        hasHeaders: true
    });
    assert.strictEqual(p.getRaw(1, 0), 'A');
    drain(p.rangeStats({}, null, 1, 4, 0, 1));
    assert.deepStrictEqual(
        [1, 2, 3, 4].map(r => p.getRaw(r, 0)),
        ['A', 'B', 'C', 'D']
    );
    drain(p.sortKeyColumn(0));
    assert.deepStrictEqual(
        [1, 2, 3, 4].map(r => p.getCell(r, 1).text),
        ['1', '2', '3', '4']
    );
    drain(p.columnIds(0, 10, true));
    assert.strictEqual(p.getRaw(4, 1), '4');
    assert.strictEqual(p.isQuoted(0, 0), false);
});

test('getCell: padding columns are blank, no ghost data, and colCount growth is safe', () => {
    const p = new OX.CsvProvider(OX.indexCsv('a,b\n1,2\n3,4\n5,6\n', {}), {});
    assert.strictEqual(p.colCount, 2);
    for (let r = 0; r < 3; r++)
        for (let c = 2; c < 6; c++) {
            assert.strictEqual(p.getCell(r, c), undefined);
            assert.strictEqual(p.getRaw(r, c), '');
        }
    assert.strictEqual(p.getCell(1, 0).text, '1');
    p.setCell(0, 3, 'far');
    assert.strictEqual(p.colCount, 4);
    assert.deepStrictEqual(
        [0, 1, 2].map(r => (p.getCell(r, 2) || {}).text),
        [undefined, undefined, undefined]
    );
    assert.strictEqual(p.getCell(0, 3).text, 'far');
    assert.strictEqual(p.getCell(1, 0).text, '1');
    assert.strictEqual(p.getCell(2, 1).text, '4');
    assert.strictEqual(p.colWidth(10), 48);
});

test('progressive index: growing colCount and rows never serves stale cells or stats', () => {
    const ix = new OX.CsvIndex({}),
        enc = new TextEncoder();
    const bytes = enc.encode('a\nb\nc,d,e\nf\n');
    ix.setSource(bytes, 4, false);
    ix.run(0);
    const p = new OX.CsvProvider(ix, {});
    assert.strictEqual(p.colCount, 1);
    const a = { cnt: 0 };
    drain(p.rangeStats(a, null, 0, p.rowCount - 1, 0, 0));
    const before = a.cnt;
    assert.strictEqual(p.getCell(1, 0).text, 'b');
    ix.setSource(bytes, bytes.length, true);
    ix.run(0);
    p.sync();
    assert.strictEqual(p.colCount, 3);
    assert.strictEqual(p.getCell(2, 0).text, 'c');
    assert.strictEqual(p.getCell(2, 2).text, 'e');
    assert.strictEqual(p.getCell(3, 0).text, 'f');
    drain(p.rangeStats(a, null, 0, p.rowCount - 1, 0, 0));
    assert.ok(a.cnt > before);
});

test('empty and blank-line-only documents: source ranges stay non-negative', () => {
    for (const t of ['', '\n', '\n\n', '\r\n', '# c\n']) {
        const o = { hasHeaders: true, skipComments: true, commentChar: '#' };
        const p = new OX.CsvProvider(OX.indexCsv(t, o), { hasHeaders: true });
        assert.deepStrictEqual(p.getSourceRange(0), { start: 0, end: 0 }, JSON.stringify(t));
        assert.strictEqual(p.rowName(0), '');
        p.setCell(0, 0, 'h');
        const h = p.getSourceRange(0);
        assert.ok(h.start === 0 && h.end === 1, JSON.stringify(t));
        const r = p.appendRow(),
            rg = p.getSourceRange(r);
        assert.ok(rg.start >= 1 && rg.end === rg.start + 1);
        const q = new OX.CsvProvider(OX.indexCsv(t, { skipComments: true, commentChar: '#' }), {});
        const a = q.appendRow(),
            ag = q.getSourceRange(a);
        assert.ok(ag.start >= 0 && ag.end === ag.start + 1);
    }
    const p = new OX.CsvProvider(OX.indexCsv('', { hasHeaders: true }), { hasHeaders: true });
    assert.deepStrictEqual(p.getSourceRange(p.appendRow()), { start: 0, end: 1 });
    p.setCell(0, 0, 'h');
    assert.deepStrictEqual(p.getSourceRange(0), { start: 0, end: 1 });
    assert.deepStrictEqual(p.getSourceRange(1), { start: 1, end: 2 });
});

test('literalText is exposed and separator/quote follow the index, not stray options', () => {
    const p = new OX.CsvProvider(OX.indexCsv('sep=;\na;b\n1;2\n', { separator: ',', hasHeaders: true }), {
        hasHeaders: true,
        separator: ','
    });
    assert.strictEqual(p.literalText, true);
    assert.strictEqual(p.sep, ';');
    p.setCell(1, 0, 'x;y');
    assert.strictEqual(p.serializeRow(1), '"x;y";2');
});

test('caches stay bounded over a long editing session', () => {
    const p = new OX.CsvProvider(OX.indexCsv(mkText(3000, 4, false), {}), {});
    for (let r = 0; r < 3000; r++) for (let c = 0; c < 4; c++) p.getCell(r, c);
    assert.ok(p._cache.size <= 30001);
    for (let c = 0; c < 20; c++) {
        drain(p.columnIds(c % 4, 50, c & 1 ? true : false));
    }
    assert.ok(p._colCache.size <= 3);
    for (let c = 4; c < 5000; c += 7) p.colWidth(c);
    assert.ok(p._widths.length <= 8);
});
