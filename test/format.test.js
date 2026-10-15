'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.SSF = require('../out/vendor/ssf.js');
const OX = require('../out/core/format.js');

const fc = (v, fmt, d1904, t) => OX.formatCell({ t: t || 'n', v }, { fmt }, d1904);
const txt = (v, fmt, d1904) => fc(v, fmt, d1904).text;

test('column names and indexes', () => {
  assert.equal(OX.colName(0), 'A'); assert.equal(OX.colName(25), 'Z'); assert.equal(OX.colName(26), 'AA');
  assert.equal(OX.colName(701), 'ZZ'); assert.equal(OX.colName(702), 'AAA'); assert.equal(OX.colName(16383), 'XFD');
  for (let c = 0; c < 16384; c++) assert.equal(OX.colIndex(OX.colName(c)), c);
  assert.equal(OX.colIndex('ab'), 27); assert.equal(OX.colIndex('XFE'), -1); assert.equal(OX.colIndex('AAAA'), -1);
  assert.equal(OX.colIndex(''), -1); assert.equal(OX.colIndex('A1'), -1);
  assert.equal(OX.cellRef(0, 0), 'A1'); assert.equal(OX.cellRef(1048575, 16383), 'XFD1048576');
});

test('parseRef', () => {
  assert.deepEqual(OX.parseRef('A1'), { r: 0, c: 0 });
  assert.deepEqual(OX.parseRef('$B$3'), { r: 2, c: 1 });
  assert.deepEqual(OX.parseRef('b3'), { r: 2, c: 1 });
  assert.deepEqual(OX.parseRef('$XFD$1048576'), { r: 1048575, c: 16383 });
  for (const bad of ['', 'A', '1', 'A0', 'XFE1', 'A1048577', '$', 'A$', '$$A1', 'A1:B2', 'A-1', 'A 1', 'A1B', 'AAAA1', null, 5])
    assert.equal(OX.parseRef(bad), null, String(bad));
});

test('parseRange', () => {
  assert.deepEqual(OX.parseRange('A1:C3'), { r1: 0, c1: 0, r2: 2, c2: 2 });
  assert.deepEqual(OX.parseRange('C3:A1'), { r1: 0, c1: 0, r2: 2, c2: 2 });
  assert.deepEqual(OX.parseRange('$A$1:$B$2'), { r1: 0, c1: 0, r2: 1, c2: 1 });
  assert.deepEqual(OX.parseRange('A:A'), { r1: 0, c1: 0, r2: 1048575, c2: 0 });
  assert.deepEqual(OX.parseRange('C:B'), { r1: 0, c1: 1, r2: 1048575, c2: 2 });
  assert.deepEqual(OX.parseRange('3:5'), { r1: 2, c1: 0, r2: 4, c2: 16383 });
  assert.deepEqual(OX.parseRange('5:3'), { r1: 2, c1: 0, r2: 4, c2: 16383 });
  assert.deepEqual(OX.parseRange('B2'), { r1: 1, c1: 1, r2: 1, c2: 1 });
  assert.deepEqual(OX.parseRange('XFD1048576:A1'), { r1: 0, c1: 0, r2: 1048575, c2: 16383 });
  for (const bad of ['', ':', 'A1:', ':A1', 'A:1', 'A1:B', 'A1:3', 'A:A:A', 'A1:B2:C3', 'XFE:A', '0:5', 'A0:B1'])
    assert.equal(OX.parseRange(bad), null, bad);
});

test('serial/date conversion and 1900 bug', () => {
  const iso = n => OX.serialToDate(n, false).toISOString().slice(0, 10);
  assert.equal(iso(1), '1900-01-01'); assert.equal(iso(59), '1900-02-28'); assert.equal(iso(61), '1900-03-01');
  assert.equal(iso(25569), '1970-01-01'); assert.equal(iso(45000), '2023-03-15'); assert.equal(iso(2958465), '9999-12-31');
  assert.equal(OX.serialToDate(45000.75, false).toISOString(), '2023-03-15T18:00:00.000Z');
  assert.equal(OX.dateToSerial(new Date(Date.UTC(1900, 0, 1)), false), 1);
  assert.equal(OX.dateToSerial(new Date(Date.UTC(1900, 1, 28)), false), 59);
  assert.equal(OX.dateToSerial(new Date(Date.UTC(1900, 2, 1)), false), 61);
  assert.equal(OX.dateToSerial(new Date(Date.UTC(1970, 0, 1)), false), 25569);
  assert.equal(OX.dateToSerial(new Date(Date.UTC(2023, 2, 15, 12)), false), 45000.5);
  for (const n of [1, 2, 59, 61, 100, 25569, 45000, 45000.25, 2958465]) assert.equal(OX.dateToSerial(OX.serialToDate(n, false), false), n);
  // 1904
  assert.equal(OX.serialToDate(0, true).toISOString().slice(0, 10), '1904-01-01');
  assert.equal(OX.serialToDate(1462, true).toISOString().slice(0, 10), '1908-01-02');
  assert.equal(OX.dateToSerial(new Date(Date.UTC(1904, 0, 1)), true), 0);
  assert.equal(OX.dateToSerial(new Date(Date.UTC(2023, 2, 15)), true), 45000 - 1462);
  for (const n of [0, 1, 59, 60, 61, 43538.5]) assert.equal(OX.dateToSerial(OX.serialToDate(n, true), true), n);
});

// [value, format, expected text]
const TABLE = [
  // General
  [0, 'General', '0'], [1, 'General', '1'], [-42, 'General', '-42'], [1234.5, 'General', '1234.5'],
  [0.1 + 0.2, 'General', '0.3'], [1 / 3, 'General', '0.333333333'], [-1 / 3, 'General', '-0.333333333'],
  [123456789.123456, 'General', '123456789.1'], [12345678901, 'General', '12345678901'],
  [123456789012, 'General', '1.23457E+11'], [1e21, 'General', '1E+21'], [1.5e-5, 'General', '1.5E-05'],
  [0.0001, 'General', '0.0001'], [0.00009999, 'General', '9.999E-05'], [1e-7, 'General', '1E-07'], [1.5e100, 'General', '1.5E+100'],
  [2 ** 31, 'General', '2147483648'], [-(2 ** 31) - 1, 'General', '-2147483649'], [100, 'General', '100'], [99999999999.9, 'General', '1E+11'],
  [3.14159265358979, 'General', '3.141592654'], [-0, 'General', '0'],
  // integers / decimals
  [1234.5, '0', '1235'], [2.5, '0', '3'], [-2.5, '0', '-3'], [0.5, '0', '1'], [1234.5678, '0.00', '1234.57'], [2.675, '0.00', '2.68'],
  [1.005, '0.00', '1.01'], [0.125, '0.00', '0.13'], [1e6, '0.00', '1000000.00'], [0, '0.00', '0.00'], [0.05, '0.0', '0.1'],
  [1234567.891, '#,##0', '1,234,568'], [-1234567.891, '#,##0.00', '-1,234,567.89'], [999.999, '#,##0.00', '1,000.00'], [0.5, '#,##0', '1'],
  [1000, '#,##0', '1,000'], [999, '#,##0', '999'], [12, '00000', '00012'], [123456789, '000-00-0000', '123-45-6789'],
  [5551234567, '(###) ###-####', '(555) 123-4567'], [1.5, '0.###', '1.5'], [0.5, '#.00', '.50'], [1234.5, '"$"#,##0.00', '$1,234.50'],
  [1234.5, '$#,##0.00', '$1,234.50'], [-5, '$#,##0.00', '-$5.00'], [123456, '#,##0,', '123'], [12345678, '0.0,,"M"', '12.3M'],
  [3, '0 "units"', '3 units'], [-3, '0.00 "kg"', '-3.00 kg'], [3, 'General" pcs"', '3 pcs'],
  // percent
  [0.256, '0%', '26%'], [0.125, '0%', '13%'], [0.00005, '0.00%', '0.01%'], [1, '0%', '100%'], [-0.256, '0.0%', '-25.6%'], [12.5, '0%', '1250%'],
  [0.0725, '0.00%', '7.25%'],
  // scientific
  [12345, '0.00E+00', '1.23E+04'], [0.000123, '0.0E+0', '1.2E-4'], [12345, '##0.0E+0', '12.3E+3'],
  // sections
  [-5, '0;(0)', '(5)'], [-1234.5, '#,##0.00;(#,##0.00)', '(1,234.50)'], [0, '#,##0;-#,##0;"zero"', 'zero'], [5, '0.00_);(0.00)', '5.00 '],
  [-3, '0.00_);(0.00)', '(3.00)'], [5, '[Red][>0]0;[Blue][<0]-0;0', '5'],
  [200, '[>100]0.0;0', '200.0'], [50, '[>100]0.0;0', '50'],
  // fractions
  [0.75, '# ?/?', ' 3/4'], [3.5, '# ?/?', '3 1/2'], [0.5, '?/?', '1/2'],
  // dates
  [45000, 'yyyy-mm-dd', '2023-03-15'], [45000, 'm/d/yyyy', '3/15/2023'], [45000, 'm/d/yy', '3/15/23'], [45000, 'mm/dd/yy', '03/15/23'],
  [45000, 'd-mmm-yy', '15-Mar-23'], [45000, 'd-mmm', '15-Mar'], [45000, 'mmm-yy', 'Mar-23'], [45000, 'mmmm d, yyyy', 'March 15, 2023'],
  [45000, 'dddd, mmmm d, yyyy', 'Wednesday, March 15, 2023'], [45000, 'ddd', 'Wed'], [45000, 'mmmmm', 'M'], [45000, 'dd.mm.yyyy', '15.03.2023'],
  [45000, '[$-409]mmm d, yyyy', 'Mar 15, 2023'], [45000, 'yyyy"年"m"月"d"日"', '2023年3月15日'],
  [45000.75, 'h:mm AM/PM', '6:00 PM'], [0.5, 'h:mm AM/PM', '12:00 PM'], [0, 'h:mm AM/PM', '12:00 AM'], [0.75, 'hh:mm:ss', '18:00:00'],
  [0.75, 'h:mm', '18:00'], [0.75, 'h:mm:ss', '18:00:00'], [45000.6, 'yyyy-mm-dd hh:mm:ss', '2023-03-15 14:24:00'], [45000.6, 'm/d/yy h:mm', '3/15/23 14:24'],
  [0.5 + 90.5 / 86400, 'mm:ss', '01:31'], [0.0001, 'h:mm:ss', '0:00:09'], [0.1 + 0.2, 'h:mm:ss', '7:12:00'],
  [1.5, '[h]:mm:ss', '36:00:00'], [0.01, '[mm]:ss', '14:24'], [2.25, '[h]:mm', '54:00'],
  [60, 'yyyy-mm-dd', '1900-02-29'], [61, 'yyyy-mm-dd', '1900-03-01'], [59, 'yyyy-mm-dd', '1900-02-28'], [1, 'yyyy-mm-dd', '1900-01-01'],
  [1, 'dddd', 'Sunday'], [60, 'dddd', 'Wednesday'], [61, 'dddd', 'Thursday'], [0, 'dddd', 'Saturday'],
  [2958465, 'yyyy-mm-dd', '9999-12-31'], [2958466, 'yyyy-mm-dd', '########'], [-1, 'yyyy-mm-dd', '########'],
  [0.5, 'm/d/yyyy', '1/0/1900'], [-0.5, 'h:mm', '########'],
  [45000.99999999, 'h:mm:ss', '0:00:00'],
  // elapsed / misc
  [0.999999, 'h:mm:ss', '0:00:00'],
];

test('format table', () => {
  for (const [v, f, exp] of TABLE) assert.equal(txt(v, f), exp, `${JSON.stringify(f)} of ${v}`);
});

test('builtin ids via SSF table resolve like Excel en-US', () => {
  const T = SSF._table;
  assert.equal(txt(1234.5, T[3]), '1,235'); assert.equal(txt(1234.5, T[4]), '1,234.50'); assert.equal(txt(0.5, T[9]), '50%');
  assert.equal(txt(45000, T[14]), '3/15/23'); assert.equal(txt(45000, T[15]), '15-Mar-23'); assert.equal(txt(0.5, T[18]), '12:00 PM');
  assert.equal(txt(0.5, T[19]), '12:00:00 PM'); assert.equal(txt(0.25, T[20]), '6:00'); assert.equal(txt(45000.5, T[22]), '3/15/23 12:00');
  assert.equal(txt(0.5, T[11]), '5.00E-01'); assert.equal(txt(-1234, T[37]), '(1,234)'); assert.equal(txt(1234, T[37]), '1,234 ');
});

test('accounting and padding', () => {
  const acc = '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)';
  assert.match(txt(1234.5, acc), /^\s*\$\s?1,234\.50\s*$/);
  assert.match(txt(-1234.5, acc), /^\s*\$\s?\(1,234\.50\)$/);
  assert.match(txt(0, acc), /^\s*\$\s*-\s*$/);
  assert.equal(txt('abc', acc).trim(), 'abc');
  assert.ok(!txt(1234.5, acc).includes('*'));
  assert.ok(!txt(1234.5, '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)').includes('*'));
});

test('negative zero rounding shows minus like Excel', () => {
  assert.equal(txt(-0.001, '0.00'), '-0.00'); assert.equal(txt(-0.4, '0'), '-0'); assert.equal(txt(-0.0001, '0.0%'), '-0.0%');
  assert.equal(txt(-0, '0.00'), '0.00');
});

test('colors and conditions', () => {
  assert.deepEqual(fc(-1, '0.00;[Red]-0.00'), { text: '-1.00', color: '#ff0000', kind: 'number' });
  assert.equal(fc(1, '0.00;[Red]-0.00').color, undefined);
  assert.equal(fc(-3, '[Blue]0;[Red]-0').color, '#ff0000'); assert.equal(fc(3, '[Blue]0;[Red]-0').color, '#0000ff');
  assert.equal(fc(0, '[Green]0;[Red]-0;[Magenta]0').color, '#ff00ff');
  assert.equal(fc(500, '[Red][>100]0.0;[Blue]0').color, '#ff0000'); assert.equal(fc(5, '[Red][>100]0.0;[Blue]0').color, '#0000ff');
  assert.equal(fc(-5, '[Color3]0.00').color, '#ff0000'); assert.equal(fc(5, '[Color10]0').color, '#008000');
  assert.equal(fc(1, '#,##0 ;[Red](#,##0)').color, undefined); assert.equal(fc(-1, '#,##0 ;[Red](#,##0)').color, '#ff0000');
  assert.equal(fc('x', '0;0;0;[Red]@', false, 's').color, '#ff0000');
});

test('non-number cells', () => {
  assert.deepEqual(OX.formatCell({ t: 's', v: 'hi' }, { fmt: '0.00' }), { text: 'hi', color: undefined, kind: 'text' });
  assert.equal(OX.formatCell({ t: 's', v: 'hi' }, { fmt: '"Name: "@' }).text, 'Name: hi');
  assert.equal(OX.formatCell({ t: 's', v: 'hi' }, { fmt: '@' }).text, 'hi');
  assert.equal(OX.formatCell({ t: 's', v: 'hi' }, null).text, 'hi');
  assert.deepEqual(OX.formatCell({ t: 'b', v: true }, null), { text: 'TRUE', color: undefined, kind: 'bool' });
  assert.equal(OX.formatCell({ t: 'b', v: false }, { fmt: '0.00' }).text, 'FALSE');
  assert.deepEqual(OX.formatCell({ t: 'e', v: '#DIV/0!' }, null), { text: '#DIV/0!', color: undefined, kind: 'error' });
  assert.equal(OX.formatCell({ t: 'z', v: null }, { fmt: '0.00' }).text, '');
  assert.equal(OX.formatCell(undefined, null).text, '');
  assert.equal(OX.formatCell({ t: 'n', v: 12.5 }, { fmt: '@' }).text, '12.5');
  assert.equal(OX.formatCell({ t: 'd', v: '2023-03-15' }, null).text, '2023-03-15');
  assert.equal(OX.formatCell({ t: 'd', v: '2023-03-15T06:00:00Z' }, { fmt: 'd-mmm-yy' }).text, '15-Mar-23');
  assert.equal(OX.formatCell({ t: 'd', v: '2023-03-15T06:00:00Z' }, null).kind, 'date');
  assert.equal(OX.formatCell({ t: 'n', v: NaN }, null).kind, 'error');
});

test('kind detection', () => {
  assert.equal(fc(1, '0.00').kind, 'number'); assert.equal(fc(1, 'yyyy-mm-dd').kind, 'date'); assert.equal(fc(1, '[h]:mm').kind, 'date');
  assert.equal(fc(1, '0.00 "days"').kind, 'number'); assert.equal(fc(1, '"d"0').kind, 'number'); assert.equal(fc(1, '0.00E+00').kind, 'number');
  assert.equal(fc(1, '[Red]0.00').kind, 'number'); assert.equal(fc('x', 'yyyy-mm-dd', false, 's').kind, 'text');
});

test('1904 system', () => {
  assert.equal(txt(0, 'yyyy-mm-dd', true), '1904-01-01'); assert.equal(txt(1462, 'yyyy-mm-dd', true), '1908-01-02');
  assert.equal(txt(43538, 'yyyy-mm-dd', true), '2023-03-15'); assert.equal(txt(0, 'dddd', true), 'Friday');
  assert.equal(txt(2957003, 'yyyy-mm-dd', true), '9999-12-31'); assert.equal(txt(2957004, 'yyyy-mm-dd', true), '########');
  assert.equal(txt(43538.5, 'yyyy-mm-dd hh:mm', true), '2023-03-15 12:00');
  assert.equal(txt(43538, '[$-409]yyyy-mm-dd', true), '2023-03-15'); // slow path
  assert.equal(txt(45000, 'yyyy-mm-dd', false), '2023-03-15');
});

test('never throws on bad formats', () => {
  for (const f of ['foo[', '"unterminated', '0.00;0.00;0.00;0.00;0.00', '[', ']', '\\', '_', '*', '0.0.0', '#,,,,##', ';;;', '[>x]0', '[Red', 'yyyy"', 'General;General;General;General;General']) {
    for (const v of [0, 1.5, -2, NaN, 1e300]) assert.doesNotThrow(() => fc(v, f), f);
    assert.doesNotThrow(() => OX.formatCell({ t: 's', v: 'x' }, { fmt: f }));
  }
  assert.equal(txt(1.5, 'foo['), '1.5'); assert.equal(txt(1.5, '"abc'), '1.5');
  assert.equal(txt(5, ';;;'), '');
});

test('fast paths match SSF (fuzz)', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const fmts = ['0', '0.0', '0.00', '0.000', '#,##0', '#,##0.00', '0%', '0.0%', '0.00%'];
  const dec = { '0': 0, '0.0': 1, '0.00': 2, '0.000': 3, '#,##0': 0, '#,##0.00': 2, '0%': 0, '0.0%': 1, '0.00%': 2 };
  let n = 0;
  for (let i = 0; i < 60000; i++) {
    const f = fmts[i % fmts.length];
    const mag = Math.pow(10, Math.floor(rnd() * 12) - 3);
    let v = (rnd() - 0.4) * mag;
    if (i % 3 === 0) v = Math.round(v * 1000) / 1000;
    const pct = f.endsWith('%'), d = dec[f] + (pct ? 2 : 0);
    const x = Math.abs(v) * Math.pow(10, d);
    if (Math.abs(x - Math.floor(x) - 0.5) < 1e-6) continue; // ties: SSF binary rounding differs from Excel
    const s = SSF.format(f, v);
    if (/^-?0([.,]0*)?%?$/.test(s) && v < 0) continue; // SSF drops '-' on zero
    assert.equal(txt(v, f), s, `${f} ${v}`); n++;
  }
  assert.ok(n > 40000);
});

test('General vs SSF where both agree with Excel (fuzz)', () => {
  let seed = 777;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  let diff = 0;
  for (let i = 0; i < 40000; i++) {
    const v = (rnd() - 0.5) * Math.pow(10, Math.floor(rnd() * 14) - 4);
    const a = Math.abs(v);
    if (a < 1e-3 || a >= 1e10) continue; // SSF deviates outside this window (see notes)
    const s = SSF.format('General', v);
    if (txt(v, 'General') !== s) { diff++; if (diff < 5) console.log('GENERAL DIFF', v, txt(v, 'General'), s); }
  }
  assert.ok(diff <= 20, 'diffs: ' + diff);
});

test('date fast path matches independent oracle (fuzz)', () => {
  let seed = 99;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const P2 = n => (n < 10 ? '0' : '') + n;
  for (let i = 0; i < 20000; i++) {
    const secsTotal = Math.floor(rnd() * 86400);
    const day = 61 + Math.floor(rnd() * 800000);
    const v = day + secsTotal / 86400;
    const d = OX.serialToDate(day, false);
    const exp = `${d.getUTCFullYear()}-${P2(d.getUTCMonth() + 1)}-${P2(d.getUTCDate())} ${P2(Math.floor(secsTotal / 3600))}:${P2(Math.floor(secsTotal / 60) % 60)}:${P2(secsTotal % 60)}`;
    assert.equal(txt(v, 'yyyy-mm-dd hh:mm:ss'), exp, String(v));
    assert.equal(txt(v, 'yyyy-mm-dd'), exp.slice(0, 10));
    const v2 = OX.dateToSerial(OX.serialToDate(v, true), true);
    assert.ok(Math.abs(v2 - v) < 1e-6);
    // slow path (bracket locale prefix) must agree with fast path on whole days
    if (i % 10 === 0) assert.equal(txt(day, '[$-409]yyyy-mm-dd'), exp.slice(0, 10));
  }
});

test('parseInput basics', () => {
  const P = (s, fmt, d) => OX.parseInput(s, undefined, fmt ? { fmt } : null, d);
  assert.equal(P(''), null);
  assert.deepEqual(P('=SUM(A1:A3)'), { t: 'n', v: null, f: 'SUM(A1:A3)' });
  assert.deepEqual(P('='), { t: 's', v: '=' });
  assert.deepEqual(P("'123"), { t: 's', v: '123' }); assert.deepEqual(P("'=1+1"), { t: 's', v: '=1+1' });
  for (const [s, v] of [['42', 42], ['-3.5', -3.5], ['+7', 7], ['.5', 0.5], ['5.', 5], [' 12 ', 12], ['1e3', 1000], ['1E-2', 0.01], ['-1.5e+3', -1500],
    ['1,234.5', 1234.5], ['1,234,567', 1234567], ['(12)', -12], ['007', 7], ['12%', 0.12], ['12.5%', 0.125], ['-5%', -0.05], ['0.07%', 0.0007], ['1,000%', 10], ['$1,234.50', 1234.5]])
    assert.deepEqual(P(s, 'General'), { t: 'n', v, ...(s.endsWith('%') ? { fmt: /\./.test(s) ? '0.00%' : '0%' } : {}) }, s);
  for (const s of ['1,23', '1,2345', ',5', '1.2.3', '12abc', 'abc', '1e', 'e5', '--1', '1 2', '(12', '12)', '$', '-', '+', '.', '1e999', '0x10', 'Infinity', 'NaN'])
    assert.deepEqual(P(s), { t: 's', v: s }, s);
  assert.deepEqual(P('  padded text  '), { t: 's', v: '  padded text  ' });
  assert.deepEqual(P('   '), { t: 's', v: '   ' });
  assert.deepEqual(P('TRUE'), { t: 'b', v: true }); assert.deepEqual(P('false'), { t: 'b', v: false }); assert.deepEqual(P(' True '), { t: 'b', v: true });
  assert.deepEqual(P('truee'), { t: 's', v: 'truee' });
  for (const e of ['#N/A', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#NULL!']) { assert.deepEqual(P(e), { t: 'e', v: e }); assert.deepEqual(P(e.toLowerCase()), { t: 'e', v: e }); }
  assert.deepEqual(P('#hashtag'), { t: 's', v: '#hashtag' });
  assert.deepEqual(P('12', '@'), { t: 's', v: '12' }); assert.deepEqual(P('=1', '@'), { t: 's', v: '=1' });
  assert.equal(P('-0').v, 0); assert.ok(!Object.is(P('-0').v, -0));
  assert.equal(P('007', '@').v, '007');
});

test('parseInput dates and times', () => {
  const P = (s, fmt, d) => OX.parseInput(s, undefined, fmt ? { fmt } : null, d);
  assert.equal(P('2023-03-15').v, 45000); assert.equal(P('2023-03-15').fmt, 'yyyy-mm-dd'); assert.equal(P('2023-03-15', 'yyyy-mm-dd').fmt, undefined);
  assert.equal(P('2023-3-5').v, 44990); assert.equal(P('1900-01-01').v, 1); assert.equal(P('1900-02-29').v, 60); assert.equal(P('1900-03-01').v, 61);
  assert.equal(P('9999-12-31').v, 2958465); assert.equal(P('2023-03-15', null, true).v, 45000 - 1462);
  assert.equal(P('2023-03-15 12:00').v, 45000.5); assert.equal(P('2023-03-15T18:00:00').v, 45000.75); assert.equal(P('2023-03-15 12:00:00').fmt, 'yyyy-mm-dd hh:mm:ss');
  assert.deepEqual(P('2023-02-29'), { t: 's', v: '2023-02-29' }); assert.deepEqual(P('2023-13-01'), { t: 's', v: '2023-13-01' });
  assert.deepEqual(P('2023-03-15 25:00'), { t: 's', v: '2023-03-15 25:00' }); assert.equal(P('2024-02-29').v, 45351);
  assert.deepEqual(P('1899-12-31'), { t: 's', v: '1899-12-31' });
  assert.equal(P('12:00').v, 0.5); assert.equal(P('18:30:00').v, 18.5 / 24); assert.equal(P('1:30 PM').v, 13.5 / 24); assert.equal(P('12:00 AM').v, 0); assert.equal(P('12:00 PM').v, 0.5);
  assert.equal(P('36:00:00').v, 1.5); assert.deepEqual(P('12:60'), { t: 's', v: '12:60' }); assert.deepEqual(P('13:00 PM'), { t: 's', v: '13:00 PM' });
  assert.equal(P('12:00').fmt, 'h:mm'); assert.equal(P('12:00:05').fmt, 'h:mm:ss'); assert.equal(P('12:00', 'h:mm:ss').fmt, undefined);
  // loose forms only with date format
  assert.deepEqual(P('3/15/2023'), { t: 'n', v: 45000, fmt: 'm/d/yyyy' }); assert.deepEqual(P('03/15/23'), { t: 's', v: '03/15/23' });
  for (const f of ['m/d/yyyy', 'yyyy-mm-dd', 'd-mmm-yy', 'mmm d, yyyy']) {
    assert.equal(P('3/15/2023', f).v, 45000, f); assert.equal(P('03/15/23', f).v, 45000); assert.equal(P('15.3.2023', f).v, 45000);
    assert.equal(P('Mar 15, 2023', f).v, 45000); assert.equal(P('March 15 2023', f).v, 45000); assert.equal(P('15-Mar-2023', f).v, 45000);
    assert.equal(P('15 Mar 23', f).v, 45000); assert.equal(P('3/15/2023 12:00', f).v, 45000.5); assert.equal(P('Mar 2023', f).v, 44986);
  }
  assert.equal(P('15.3.2023', 'd.m.yyyy').v, 45000); assert.equal(P('1/1/29', 'm/d/yy').v, OX.dateToSerial(new Date(Date.UTC(2029, 0, 1)), false));
  assert.equal(P('1/1/30', 'm/d/yy').v, OX.dateToSerial(new Date(Date.UTC(1930, 0, 1)), false));
  assert.deepEqual(P('2/30/2023', 'm/d/yyyy'), { t: 's', v: '2/30/2023' }); assert.deepEqual(P('Foo 15, 2023', 'm/d/yyyy'), { t: 's', v: 'Foo 15, 2023' });
  assert.deepEqual(P('hello', 'm/d/yyyy'), { t: 's', v: 'hello' });
});

test('exportText', () => {
  const E = (cell, fmt, d) => OX.exportText(cell, fmt ? { fmt } : null, d);
  assert.equal(E({ t: 'n', v: null, f: 'SUM(A1:A3)' }), '=SUM(A1:A3)'); assert.equal(E({ t: 'n', v: 6, f: 'A1+A2' }, '0.00'), '=A1+A2');
  assert.equal(E({ t: 'n', v: 0.1 + 0.2 }), '0.3'); assert.equal(E({ t: 'n', v: 1234.5 }, '#,##0.00'), '1234.5');
  assert.equal(E({ t: 'n', v: 1e21 }), '1e+21'); assert.equal(E({ t: 'n', v: 0 }), '0'); assert.equal(E({ t: 'n', v: -0 }), '0');
  assert.equal(E({ t: 'n', v: 0.256 }, '0%'), '25.6%'); assert.equal(E({ t: 'n', v: 0.07 }, '0.00%'), '7%');
  assert.equal(E({ t: 'n', v: 45000 }, 'm/d/yyyy'), '2023-03-15'); assert.equal(E({ t: 'n', v: 45000.5 }, 'm/d/yyyy h:mm'), '2023-03-15 12:00:00');
  assert.equal(E({ t: 'n', v: 0.5 }, 'h:mm'), '12:00:00'); assert.equal(E({ t: 'n', v: 1.5 }, '[h]:mm'), '36:00:00');
  assert.equal(E({ t: 'n', v: 60 }, 'yyyy-mm-dd'), '1900-02-29'); assert.equal(E({ t: 'n', v: -5 }, 'yyyy-mm-dd'), '-5');
  assert.equal(E({ t: 'n', v: 43538 }, 'yyyy-mm-dd', true), '2023-03-15');
  assert.equal(E({ t: 'b', v: true }), 'TRUE'); assert.equal(E({ t: 'b', v: false }), 'FALSE'); assert.equal(E({ t: 'e', v: '#N/A' }), '#N/A');
  assert.equal(E({ t: 'z', v: null }), ''); assert.equal(E({ t: 's', v: 'hello' }), 'hello'); assert.equal(E({ t: 's', v: '123' }), "'123");
  assert.equal(E({ t: 's', v: '123' }, '@'), '123'); assert.equal(E({ t: 's', v: '=x' }), "'=x"); assert.equal(E({ t: 's', v: "'q" }), "''q");
  assert.equal(E({ t: 's', v: 'TRUE' }), "'TRUE"); assert.equal(E(undefined), '');
});

test('round trips: parseInput(exportText(x)) preserves cell', () => {
  const cases = [
    [{ t: 'n', v: 42 }, 'General'], [{ t: 'n', v: -1234.5678 }, '0.00'], [{ t: 'n', v: 0.1 + 0.2 }, 'General'], [{ t: 'n', v: 1e21 }, 'General'],
    [{ t: 'n', v: 1e-9 }, 'General'], [{ t: 'n', v: 123456789012345 }, '#,##0'], [{ t: 'n', v: 0.256 }, '0.0%'], [{ t: 'n', v: 0.07 }, '0%'],
    [{ t: 'n', v: 45000 }, 'm/d/yyyy'], [{ t: 'n', v: 45000.5 }, 'yyyy-mm-dd hh:mm'], [{ t: 'n', v: 0.75 }, 'h:mm AM/PM'], [{ t: 'n', v: 1.5 }, '[h]:mm'],
    [{ t: 'n', v: 60 }, 'yyyy-mm-dd'], [{ t: 'n', v: 1 }, 'd-mmm-yy'], [{ t: 'n', v: 2958465 }, 'yyyy-mm-dd'],
    [{ t: 'b', v: true }, 'General'], [{ t: 'b', v: false }, 'General'], [{ t: 'e', v: '#DIV/0!' }, 'General'],
    [{ t: 's', v: 'hello world' }, 'General'], [{ t: 's', v: '123' }, 'General'], [{ t: 's', v: '=1+1' }, 'General'], [{ t: 's', v: "'tick" }, 'General'],
    [{ t: 's', v: '2023-03-15' }, 'General'], [{ t: 's', v: '12:30' }, 'General'], [{ t: 's', v: '12%' }, 'General'], [{ t: 's', v: 'TRUE' }, 'General'],
    [{ t: 's', v: '#N/A' }, 'General'], [{ t: 's', v: '3/15/2023' }, 'm/d/yyyy'], [{ t: 's', v: '007' }, '@'], [{ t: 's', v: ' lead' }, 'General'],
    [{ t: 'n', v: null, f: 'A1*2' }, 'General'],
  ];
  for (const d1904 of [false, true]) for (const [cell, fmt] of cases) {
    const style = { fmt };
    const text = OX.exportText(cell, style, d1904);
    const back = OX.parseInput(text, cell, style, d1904);
    if (cell.f) { assert.deepEqual(back, { t: 'n', v: null, f: cell.f }); continue; }
    assert.equal(back.t, cell.t, JSON.stringify([cell, fmt, text, back]));
    if (cell.t === 'n') {
      const tol = (fmt.includes('hh') || fmt.includes('mm') && !fmt.includes('d')) ? 1e-9 : 0;
      assert.ok(Math.abs(back.v - cell.v) <= tol + Math.abs(cell.v) * 1e-15, JSON.stringify([cell, fmt, text, back]));
    } else assert.equal(back.v, cell.v, JSON.stringify([cell, fmt, text, back]));
  }
  // formatted display of a typed value is stable
  for (const [typed, fmt, shown] of [['12.5%', '0.0%', '12.5%'], ['1,234.5', '#,##0.00', '1,234.50'], ['2023-03-15', 'd-mmm-yy', '15-Mar-23'], ['3/15/2023', 'yyyy-mm-dd', '2023-03-15'], ['13:45', 'h:mm AM/PM', '1:45 PM']]) {
    const c = OX.parseInput(typed, null, { fmt }, false);
    assert.equal(OX.formatCell(c, { fmt }, false).text, shown, typed);
  }
});

test('stats helpers', () => {
  const s = OX.createStats();
  assert.equal(s.count, 0); assert.ok(Number.isNaN(s.avg()));
  [3, 1, 2, -4].forEach(n => s.add(n));
  assert.equal(s.count, 4); assert.equal(s.sum, 2); assert.equal(s.min, -4); assert.equal(s.max, 3); assert.equal(s.avg(), 0.5);
  assert.ok(OX.isNumericCell({ t: 'n', v: 1 })); assert.ok(!OX.isNumericCell({ t: 'n', v: null })); assert.ok(!OX.isNumericCell({ t: 's', v: '1' }));
  assert.ok(!OX.isNumericCell({ t: 'n', v: NaN })); assert.ok(!OX.isNumericCell(undefined)); assert.ok(!OX.isNumericCell({ t: 'b', v: true }));
  assert.ok(OX.isNumericCell({ t: 'n', v: 0 }));
});

test('benchmark', () => {
  const styles = [null, { fmt: 'General' }, { fmt: '0.00' }, { fmt: '#,##0' }, { fmt: '#,##0.00' }, { fmt: '0%' }, { fmt: 'yyyy-mm-dd' }, { fmt: 'm/d/yyyy' },
    { fmt: '0.00E+00' }, { fmt: '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)' }, { fmt: '[Red]0.00;[Blue]-0.00' }, { fmt: 'h:mm:ss' }];
  const cells = [];
  let seed = 5;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 4000; i++) {
    const k = rnd();
    const c = k < 0.3 ? { t: 's', v: 'Item ' + i } : k < 0.5 ? { t: 'n', v: Math.floor(rnd() * 100000) } : k < 0.8 ? { t: 'n', v: Math.round(rnd() * 1e6) / 100 } : k < 0.9 ? { t: 'n', v: 40000 + Math.floor(rnd() * 8000) + (i % 3 ? 0 : 0.5) } : { t: 'b', v: i % 2 === 0 };
    c.si = c.t === 'n' ? 1 + Math.floor(rnd() * (styles.length - 1)) : 0;
    cells.push(c);
  }
  const N = 3000000;
  const run = () => { let len = 0; for (let i = 0; i < N; i++) { const c = cells[i % 4000]; len += OX.formatCell(c, styles[c.si], false).text.length; } return len; };
  run();
  const t0 = process.hrtime.bigint(); run(); const dt = Number(process.hrtime.bigint() - t0) / 1e9;
  const rate = N / dt;
  console.log(`formatCell mixed: ${(rate / 1e6).toFixed(2)}M calls/sec`);
  // typical grid: one style per column
  const t1 = process.hrtime.bigint();
  let len = 0;
  for (let i = 0; i < N; i++) { const c = cells[i % 4000]; len += OX.formatCell(c, styles[2 + (i % 4)], false).text.length; }
  console.log(`formatCell fast formats: ${(N / (Number(process.hrtime.bigint() - t1) / 1e9) / 1e6).toFixed(2)}M calls/sec`);
  assert.ok(rate > 1.5e6, 'rate ' + rate);
});

test('locale and odd format codes', () => {
  assert.equal(txt(0.5, '0 %'), '50 %'); assert.equal(txt(0.5, '0.00 %'), '50.00 %'); assert.equal(txt(0.5, '0\\ %'), '50 %');
  assert.equal(txt(0.256, '0.0 %;[Red]-0.0 %'), '25.6 %');
  assert.equal(txt(45000, '[$-407]dddd, d. mmmm yyyy'), 'Wednesday, 15. March 2023');
  assert.equal(txt(45000, '[$-804]yyyy年m月d日'), '2023年3月15日'); assert.equal(txt(45000, 'yyyy年m月d日'), '2023年3月15日');
  assert.equal(txt(1234.5, '0.00e+00'), '1.23e+03'); assert.equal(OX.formatCell({ t: 'n', v: 1234.5 }, { fmt: '0.00e+00' }).kind, 'number');
  assert.equal(txt(1234.5, '[$-409]#,##0.00'), '1,234.50'); assert.equal(txt(1234.5, '[$-409]General'), '1234.5');
  assert.equal(txt(1e21, '0'), '1000000000000000000000'); assert.equal(txt(1.5e17, '#,##0'), '150,000,000,000,000,000');
  assert.equal(txt(-2e21, '0.00'), '-2000000000000000000000.00');
});

test('typed times get duration and AM/PM formats', () => {
  const P = (s) => OX.parseInput(s, undefined, null, false);
  assert.equal(P('25:00').fmt, '[h]:mm'); assert.equal(P('25:00:10').fmt, '[h]:mm:ss');
  assert.equal(P('10:30 PM').fmt, 'h:mm AM/PM'); assert.equal(P('10:30:15 pm').fmt, 'h:mm:ss AM/PM'); assert.equal(P('10:30').fmt, 'h:mm');
  assert.equal(OX.exportText({ t: 'n', v: 0.1 + 0.2 }, null, false), '0.3');
  assert.equal(OX.parseInput('#SPILL!', undefined, null, false).t, 'e'); assert.equal(OX.parseInput('#GETTING_DATA', undefined, null, false).t, 's');
});

test('General cells convert full m/d/yyyy dates and keep ambiguous text', () => {
  const OXf = require('../out/core/format.js');
  const r = OXf.parseInput('12/25/2024', null, null, false);
  assert.equal(r.t, 'n'); assert.equal(r.fmt, 'm/d/yyyy'); assert.equal(r.v, 45651);
  assert.equal(OXf.parseInput('3/4/24', null, null, false).t, 's');
  assert.equal(OXf.parseInput('13/45/2024', null, null, false).t, 's');
});
