'use strict';
const test = require('node:test');
const assert = require('node:assert');
const OX = require('../out/core/csv-parser.js');
require('../out/core/csv-provider.js');

let seed = 20240607;
const rnd = n => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 4294967296) * n);
};
const ALPHA = [
    'a',
    'b',
    '1',
    '2',
    '.',
    ' ',
    ',',
    ',',
    '"',
    '"',
    '\n',
    '\r\n',
    '\r',
    '\t',
    ';',
    '#',
    'é',
    '中',
    '😀',
    'x',
    '-',
    'e',
    'sep=;',
    '﻿',
    '  '
];
const randText = () => {
    let t = '';
    for (let i = 0, L = rnd(40); i < L; i++) t += ALPHA[rnd(ALPHA.length)];
    if (rnd(6) === 0) t = 'sep=;\n' + t;
    if (rnd(8) === 0) t = '﻿' + t;
    return t;
};
const randOpts = () => ({
    separator: [',', ';', '\t', '::', '→'][rnd(5)],
    quote: rnd(7) ? '"' : "'",
    hasHeaders: !!rnd(2),
    skipComments: !!rnd(2),
    commentChar: rnd(2) ? '#' : '//'
});

function compare(t, opts, ix) {
    const old = OX.parseCsv(t, opts);
    const p = new OX.CsvProvider(ix, { hasHeaders: opts.hasHeaders });
    const ctx = JSON.stringify(t) + ' ' + JSON.stringify(opts);
    assert.strictEqual(ix.n, old.rows.length, 'rows ' + ctx);
    assert.strictEqual(ix.colCount, old.colCount, 'colCount ' + ctx);
    assert.strictEqual(ix.lineCount, old.lineCount, 'lineCount ' + ctx);
    assert.strictEqual(ix.endsWithNewline, old.endsWithNewline, 'ewn ' + ctx);
    assert.strictEqual(ix.sepDirective, old.sepDirective, 'sep ' + ctx);
    assert.deepStrictEqual(ix.header, old.header, 'header ' + ctx);
    assert.strictEqual(ix.headerLine, old.headerLine, 'hline ' + ctx);
    for (let d = 0; d < ix.n; d++) {
        assert.strictEqual(ix.lineAt[d], old.rowLine[d], 'line ' + d + ' ' + ctx);
        assert.strictEqual(ix.span[d], old.rowSpan[d], 'span ' + d + ' ' + ctx);
        for (let c = 0; c < old.colCount; c++) {
            const o = old.rows[d][c] === undefined ? '' : old.rows[d][c];
            assert.strictEqual(p.getRaw(d + p.off, c), o, 'raw ' + d + ',' + c + ' ' + ctx);
            const q =
                c < 32
                    ? ((old.quotedMask[d] >>> c) & 1) === 1
                    : !!old.quotedExtra && old.quotedExtra.has(d * 1048576 + c);
            assert.strictEqual(p.isQuoted(d, c), q, 'quoted ' + d + ',' + c + ' ' + ctx);
        }
    }
}

test('fuzz: byte index equals the legacy parser (rows, fields, quote flags, line bookkeeping)', () => {
    for (let i = 0; i < 6000; i++) {
        const t = randText(),
            o = randOpts();
        compare(t, o, OX.indexCsv(t, o));
    }
});

test('fuzz: chunked / incremental indexing gives the one-shot result', () => {
    for (let i = 0; i < 3000; i++) {
        const t = randText(),
            o = randOpts();
        const one = OX.indexCsv(t, o),
            by = new TextEncoder().encode(t),
            buf = new Uint8Array(by.length + 5);
        const ix = new OX.CsvIndex(o);
        let f = 0;
        do {
            f = Math.min(by.length, f + 1 + rnd(6));
            buf.set(by.subarray(0, f), 0);
            ix.setSource(buf, f, f === by.length);
            ix.run(rnd(2) ? 0 : 0.0001);
        } while (f < by.length);
        ix.run(0);
        const ctx = JSON.stringify(t) + JSON.stringify(o);
        assert.ok(ix.done, 'done ' + ctx);
        assert.strictEqual(ix.n, one.n, ctx);
        assert.strictEqual(ix.colCount, one.colCount, ctx);
        assert.strictEqual(ix.lineCount, one.lineCount, ctx);
        assert.deepStrictEqual(ix.header, one.header, ctx);
        for (let d = 0; d < one.n; d++)
            assert.ok(
                ix.start[d] === one.start[d] && ix.lineAt[d] === one.lineAt[d] && ix.span[d] === one.span[d],
                ctx
            );
    }
});

test('more than 16.7M quoted fields in wide columns are no longer a problem (flags come from the bytes)', () => {
    const cols = 40,
        t = Array.from({ length: 4 }, () =>
            Array.from({ length: cols }, (_, c) => (c % 2 ? '"q"' : 'u')).join(',')
        ).join('\n');
    const p = new OX.CsvProvider(OX.indexCsv(t, {}), {});
    assert.strictEqual(p.isQuoted(3, 39), true);
    assert.strictEqual(p.isQuoted(3, 38), false);
    assert.strictEqual(p.getRaw(2, 39), 'q');
});

test('numBytes agrees with Number for the numeric grammar', () => {
    const enc = new TextEncoder();
    const cases = [
        '0',
        '-0',
        '12',
        '-12.5',
        '+3',
        '.5',
        '5.',
        '1e3',
        '1E-3',
        '0.1',
        '123456789012345',
        '1234567890123456789',
        '0.000001234',
        '9007199254740993',
        '1e400',
        '3.14159265358979',
        '00012'
    ];
    for (const s of cases) {
        const b = enc.encode(s);
        const v = OX.csvNumBytes(b, 0, b.length, false);
        assert.ok(Object.is(v, Number(s)) || (v === 0 && Number(s) === 0), s + ' -> ' + v + ' vs ' + Number(s));
    }
    for (const s of ['', '-', '+', '.', 'e1', '1e', '1e+', 'abc', '1 2', '0x10', 'Infinity', 'NaN', '1,5', '--1']) {
        const b = enc.encode(s);
        assert.ok(Number.isNaN(OX.csvNumBytes(b, 0, b.length, false)), s);
    }
    for (let i = 0; i < 20000; i++) {
        const sg = ['', '-', '+'][rnd(3)],
            ip = String(rnd(1e9)) + (rnd(3) ? '' : String(rnd(1e9))),
            fp = rnd(2) ? '.' + String(rnd(1e9)) : '',
            ex = rnd(4) ? '' : 'e' + (rnd(60) - 30);
        const s = sg + ip + fp + ex,
            b = enc.encode(s);
        assert.ok(Object.is(OX.csvNumBytes(b, 0, b.length, false), Number(s)), s);
    }
});

function ref(p) {
    // brute-force rows via getRaw
    const rows = [];
    for (let r = p.off; r < p.rowCount; r++) {
        const a = [];
        for (let c = 0; c < p.colCount; c++) a.push(p.getRaw(r, c));
        rows.push(a);
    }
    return rows;
}
const drain = g => {
    let r = g.next();
    while (!r.done) r = g.next();
    return r.value;
};

function randCsv(rows, cols) {
    const vals = [
        '',
        '1',
        '2.5',
        '-3',
        'abc',
        'ABC',
        'Abd',
        '10',
        '007',
        'x y',
        '1e3',
        '0x1F',
        'é',
        '"q"',
        '"1"',
        '"a""b"',
        '"l1\nl2"',
        ' 5',
        '3,4'
    ];
    let t = Array.from({ length: cols }, (_, c) => 'h' + c).join(',') + '\n';
    for (let r = 0; r < rows; r++)
        t +=
            Array.from({ length: cols }, () => {
                const v = vals[rnd(vals.length)];
                return v === '3,4' ? '"3,4"' : v;
            }).join(',') + '\n';
    return t;
}

test('columnIds equals brute force distinct display values; counts and truncation', () => {
    for (const fv of ['never', 'always', 'unquoted']) {
        const t = randCsv(300, 4),
            p = new OX.CsvProvider(OX.indexCsv(t, { hasHeaders: true }), { hasHeaders: true, formatValues: fv });
        for (let c = 0; c < 4; c++) {
            const res = drain(p.columnIds(c, 1000, false));
            const want = new Map();
            for (let r = 1; r < p.rowCount; r++) {
                const cv = p.getCell(r, c),
                    k = cv ? cv.text : '';
                want.set(k, (want.get(k) || 0) + 1);
            }
            assert.deepStrictEqual(new Map(res.values.map((v, i) => [v, res.counts[i]])), want, fv + ' col ' + c);
            for (let r = 1; r < p.rowCount; r++) {
                const cv = p.getCell(r, c);
                assert.strictEqual(res.values[res.ids[r]], cv ? cv.text : '');
            }
            const raw = drain(p.columnIds(c, 1000, true));
            for (let r = 1; r < p.rowCount; r++) assert.strictEqual(raw.values[raw.ids[r]], p.getRaw(r, c));
        }
        assert.strictEqual(drain(p.columnIds(0, 3, false)).truncated, true);
    }
});

test('sortKeyColumn orders like the documented comparator (numbers, text, blanks last)', () => {
    const t = randCsv(400, 3),
        p = new OX.CsvProvider(OX.indexCsv(t, { hasHeaders: true }), { hasHeaders: true });
    p.setCell(5, 1, '42');
    p.setCell(6, 1, 'Edited'); // overlay cells take part
    for (let c = 0; c < 3; c++) {
        const k = drain(p.sortKeyColumn(c));
        for (let r = 1; r < p.rowCount; r++) {
            const raw = p.getRaw(r, c);
            const isNum = raw !== '' && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(raw);
            assert.strictEqual(k.cat[r], raw === '' ? 2 : isNum ? 0 : 1, JSON.stringify(raw));
            if (k.cat[r] === 1) assert.strictEqual(k.strs[k.lo[r]], raw.toLowerCase());
        }
    }
});

test('rangeStats equals a brute-force sum over getCell; whole-column cache is invalidated by edits', () => {
    for (const fv of ['never', 'always', 'unquoted']) {
        const t = randCsv(500, 5),
            p = new OX.CsvProvider(OX.indexCsv(t, { hasHeaders: true }), { hasHeaders: true, formatValues: fv });
        const brute = (r1, r2, c1, c2) => {
            const a = { cnt: 0, nums: 0, sum: 0, min: Infinity, max: -Infinity };
            for (let r = r1; r <= r2; r++)
                for (let c = c1; c <= c2; c++) {
                    const cv = p.getCell(r, c);
                    if (!cv || cv.text === '') continue;
                    a.cnt++;
                    if (cv.kind === 'number') {
                        const n = Number(p.getRaw(r, c));
                        a.nums++;
                        a.sum += n;
                        a.min = Math.min(a.min, n);
                        a.max = Math.max(a.max, n);
                    }
                }
            return a;
        };
        const check = (rows, r1, r2, c1, c2) => {
            const a = { cnt: 0, nums: 0, sum: 0, min: Infinity, max: -Infinity };
            drain(p.rangeStats(a, rows, r1, r2, c1, c2));
            const w = rows
                ? (() => {
                      const b = { cnt: 0, nums: 0, sum: 0, min: Infinity, max: -Infinity };
                      for (let i = r1; i <= r2; i++) {
                          const x = brute(rows[i], rows[i], c1, c2);
                          b.cnt += x.cnt;
                          b.nums += x.nums;
                          b.sum += x.sum;
                          b.min = Math.min(b.min, x.min);
                          b.max = Math.max(b.max, x.max);
                      }
                      return b;
                  })()
                : brute(r1, r2, c1, c2);
            assert.strictEqual(a.cnt, w.cnt, fv + ' cnt');
            assert.strictEqual(a.nums, w.nums, fv + ' nums');
            assert.ok(Math.abs(a.sum - w.sum) < 1e-6 * (1 + Math.abs(w.sum)), fv + ' sum');
            assert.strictEqual(a.min, w.min);
            assert.strictEqual(a.max, w.max);
        };
        check(null, 0, p.rowCount - 1, 0, 4);
        check(null, 0, p.rowCount - 1, 0, 4); // served from the column cache
        check(null, 1, p.rowCount - 1, 2, 3);
        check(null, 10, 99, 1, 3);
        check(Int32Array.from([0, 7, 3, 200, 9]), 0, 4, 0, 4);
        p.setCell(3, 2, '1000000');
        p.setCell(4, 2, '');
        check(null, 0, p.rowCount - 1, 0, 4);
        p.deleteRows([1, 2]);
        check(null, 0, p.rowCount - 1, 0, 4);
    }
});

test('provider edits keep working on an offset index: random op sequences vs a plain array model', () => {
    for (let it = 0; it < 150; it++) {
        const t = randCsv(2 + rnd(8), 1 + rnd(4)),
            p = new OX.CsvProvider(OX.indexCsv(t, { hasHeaders: true }), { hasHeaders: true });
        const model = ref(p);
        for (let k = 0; k < 12; k++) {
            const op = rnd(4);
            if (op === 0 && model.length) {
                const r = rnd(model.length),
                    c = rnd(p.colCount),
                    v = ['', 'z', 'a\nb', 'q"r'][rnd(4)];
                p.setCell(r + 1, c, v);
                model[r][c] = v;
            } else if (op === 1) {
                p.appendRow();
                model.push(new Array(p.colCount).fill(''));
            } else if (op === 2 && model.length) {
                const r = rnd(model.length);
                p.deleteRows([r + 1]);
                model.splice(r, 1);
            } else if (op === 3 && model.length) {
                const c = p.colCount + rnd(2);
                p.setCell(1, c, 'w');
                for (const m of model) while (m.length <= c) m.push('');
                model[0][c] = 'w';
            }
            assert.deepStrictEqual(
                ref(p),
                model.map(m => {
                    const a = m.slice();
                    while (a.length < p.colCount) a.push('');
                    return a;
                })
            );
        }
    }
});

test('big synthetic file: index is compact and fast, rows are exact', () => {
    const rows = 200000,
        parts = ['id,name,val,note\n'];
    for (let i = 0; i < rows; i++) parts.push(i + ',n' + (i % 977) + ',' + i * 0.5 + ',"x, y' + (i % 7) + '"\n');
    const text = parts.join(''),
        t0 = performance.now();
    const ix = OX.indexCsv(text, { hasHeaders: true });
    const ms = performance.now() - t0;
    const p = new OX.CsvProvider(ix, { hasHeaders: true });
    assert.strictEqual(p.dataRowCount, rows);
    assert.strictEqual(p.getRaw(12345 + 1, 3), 'x, y' + (12345 % 7));
    assert.strictEqual(p.getRaw(rows, 0), String(rows - 1));
    assert.ok(ms < 3000, 'index took ' + ms);
    // index arrays are 12 bytes per row, no per-field objects
    assert.ok(ix.start.byteLength + ix.lineAt.byteLength + ix.span.byteLength <= rows * 12 + 64);
});

test('progressive provider: rows appear as the index advances', () => {
    const rows = 5000,
        text = 'a,b\n' + Array.from({ length: rows }, (_, i) => i + ',' + i * 2).join('\n') + '\n';
    const by = new TextEncoder().encode(text),
        ix = new OX.CsvIndex({ hasHeaders: true });
    ix.setSource(by, 1000, false);
    ix.run(0);
    const p = new OX.CsvProvider(ix, { hasHeaders: true });
    const first = p.dataRowCount;
    assert.ok(first > 10 && first < rows);
    assert.strictEqual(p.getRaw(first, 1), String((first - 1) * 2));
    ix.setSource(by, by.length, true);
    ix.run(0);
    p.sync();
    assert.strictEqual(p.dataRowCount, rows);
    assert.strictEqual(p.getRaw(rows, 0), String(rows - 1));
    p.setCell(1, 0, 'E');
    assert.strictEqual(p.getRaw(1, 0), 'E');
});
