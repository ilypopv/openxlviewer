'use strict';
const test = require('node:test');
const assert = require('node:assert');
const OX = require('../out/core/csv-parser.js');
require('../out/core/csv-provider.js');
const drain = g => {
    let r = g.next();
    while (!r.done) r = g.next();
    return r.value;
};
const prov = (t, io, po) => new OX.CsvProvider(OX.indexCsv(t, io), Object.assign({}, po));

test('numeric grammar: strict numBytes agrees with csvIsNumeric; hex, Infinity, NaN, spaces are text', () => {
    const samples = [
        '0x1F',
        'Infinity',
        '-Infinity',
        'NaN',
        ' 12',
        '12 ',
        '1_000',
        '1,5',
        '+',
        '-',
        '.',
        'e5',
        '1e',
        '1e+',
        '.5',
        '5.',
        '+.5e-3',
        '007',
        '0',
        '-0',
        '00.5',
        '1e5',
        '1E5',
        '123456789012345',
        '1234567890123456',
        '٣'
    ];
    for (const s of samples) {
        const b = OX.csvToBytes(s),
            strict = OX.csvNumBytes(b, 0, b.length, true);
        assert.strictEqual(strict === strict, OX.csvIsNumeric(s), JSON.stringify(s));
    }
    for (const s of ['0x1F', 'Infinity', 'NaN', ' 12', '1_000', '.', 'e5', '1e']) {
        const b = OX.csvToBytes(s);
        assert.ok(Number.isNaN(OX.csvNumBytes(b, 0, b.length, false)), s);
    }
});

test('sortKeyColumn: numbers before text, hex/Infinity are text, -0 equals 0, huge exponents order', () => {
    const vals = ['b', '10', '0x1F', 'Infinity', '-2', '', '-0', '0', '1e400', '-1e400', '007', '.5'];
    const p = prov(
        'v\n' + vals.join('\n').replace(/^|\n(?=\n)/g, m => m) + '\n',
        { hasHeaders: true },
        { hasHeaders: true }
    );
    const k = drain(p.sortKeyColumn(0));
    const cat = s => {
        for (let r = 1; r < p.rowCount; r++) if (p.getRaw(r, 0) === s) return k.cat[r];
        return -1;
    };
    assert.strictEqual(cat('0x1F'), 1);
    assert.strictEqual(cat('Infinity'), 1);
    assert.strictEqual(cat('b'), 1);
    for (const s of ['10', '-2', '-0', '0', '1e400', '-1e400', '007', '.5']) assert.strictEqual(cat(s), 0, s);
    const key = s => {
        for (let r = 1; r < p.rowCount; r++) if (p.getRaw(r, 0) === s) return [k.hi[r], k.lo[r]];
    };
    assert.deepStrictEqual(key('-0'), key('0'));
    const lt = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
    assert.ok(
        lt(key('-1e400'), key('-2')) &&
            lt(key('-2'), key('0')) &&
            lt(key('0'), key('.5')) &&
            lt(key('.5'), key('10')) &&
            lt(key('10'), key('1e400'))
    );
});

test('TSV, CRLF and BOM documents keep fields, quoting and line bookkeeping', () => {
    const t = '﻿a\tb\r\n"x\ty"\t2\r\n3\t"l1\r\nl2"\r\n';
    const p = prov(t, { separator: '\t', hasHeaders: true }, { hasHeaders: true });
    assert.strictEqual(p.getRaw(0, 0), 'a');
    assert.strictEqual(p.getRaw(1, 0), 'x\ty');
    assert.strictEqual(p.getRaw(2, 1), 'l1\r\nl2');
    assert.deepStrictEqual(
        [0, 1, 2].map(r => p.getSourceRange(r)),
        [
            { start: 0, end: 1 },
            { start: 1, end: 2 },
            { start: 2, end: 4 }
        ]
    );
    assert.strictEqual(p.sep, '\t');
    assert.strictEqual(p.serializeRow(1), '"x\ty"\t2');
});

test('quoted flags follow rows through edits, deletes and appends', () => {
    const p = prov('h,g\n"a",b\nc,"d"\n"e",f\n', { hasHeaders: true }, { hasHeaders: true });
    p.setCell(1, 0, 'A');
    assert.strictEqual(p.serializeRow(1), '"A",b');
    p.deleteRows([1]);
    assert.strictEqual(p.serializeRow(1), 'c,"d"');
    assert.strictEqual(p.serializeRow(2), '"e",f');
    const r = p.appendRow();
    p.setCell(r, 0, 'q');
    assert.strictEqual(p.serializeRow(r), 'q,');
    drain(p.sortKeyColumn(0));
    drain(p.rangeStats({}, null, 0, p.rowCount - 1, 0, 1));
    assert.strictEqual(p.serializeRow(2), '"e",f');
});
