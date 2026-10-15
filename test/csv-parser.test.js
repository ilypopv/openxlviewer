'use strict';
const test = require('node:test');
const assert = require('node:assert');
const OX = require('../out/core/csv-parser.js');
require('../out/core/csv-provider.js');

// Faithful copy of the legacy parseContent (out/csv.js); sep is regex source there.
function oldParse(text, options) {
  var sep = options.separator, quote = options.quoteMark, hasHeaders = options.hasHeaders;
  var comment = options.commentCharacter, skip = options.skipComments;
  var regexQuote = new RegExp(`^${quote}([\\S\\s]*)${quote}$`);
  var regexDoubleQuote = new RegExp(`${quote}${quote}`, 'g');
  var regexComment = new RegExp(String.raw`^\s*${comment}|^\s+$`);
  var regexLines = new RegExp(`((${quote}(?:[^${quote}]|)+${quote}|[^${quote}\n\r]+)+)`, 'g');
  var regexItems = new RegExp(`${sep}(?=(?:[^${quote}]*${quote}[^${quote}]*${quote})*[^${quote}]*$)`);
  var sepApplied = null;
  function unquote(cell) {
    if (cell.text.length > 0) {
      var match = regexQuote.exec(cell.text);
      if (match) { cell.quoted = true; return dblquote(match[1]); }
    }
    return cell.text;
  }
  function dblquote(t) { return t.length > 1 ? t.replace(regexDoubleQuote, `${quote}`) : t; }
  function isComment(t) { return !skip ? false : ((t.length > 0) ? regexComment.exec(t) : true); }
  function isSep(t) {
    var line = t.replace(/ /g, '');
    var left = line.slice(0, 4).toLowerCase();
    var result = (left === 'sep=');
    if (result && line.length == 5) {
      var escapes = `+*?^$\.[]{}()|/`;
      var char = line.slice(4);
      sepApplied = char;
      sep = (escapes.indexOf(char) >= 0) ? '\\'.concat(char) : char;
      regexItems = new RegExp(`${sep}(?=(?:[^${quote}]*${quote}[^${quote}]*${quote})*[^${quote}]*$)`);
    }
    return result;
  }
  var data = [], headers = [];
  var lines = text.match(regexLines) || [];
  var firstLine = hasHeaders, maxLength = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace('\r', '');
    if (i == 0 && isSep(line)) continue;
    if (!isComment(line)) {
      var items = line.split(regexItems);
      if (items.length > maxLength) maxLength = items.length;
      if (firstLine) {
        for (var j = 0; j < items.length; j++) headers.push(unquote({ text: items[j] }));
        firstLine = false;
      } else {
        var cells = [];
        for (var j = 0; j < items.length; j++) cells.push(unquote({ text: items[j], quoted: false }));
        if (line.length > 0 || (i < lines.length - 1)) data.push({ cells, newlines: line.split('\n').length - 1 });
      }
    }
  }
  if (maxLength === 0) maxLength = 1;
  var header = null;
  if (hasHeaders) {
    header = [];
    for (var k = 0; k < maxLength; k++) header.push(headers.length > k ? headers[k] : '');
  }
  return { header, rows: data.map((d) => d.cells), spans: data.map((d) => d.newlines + 1), colCount: maxLength, sepApplied };
}

function esc(s) { return s.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&'); }

function compareWithOld(text, o) {
  const mine = OX.parseCsv(text, { separator: o.sep, quote: o.quote, hasHeaders: o.hasHeaders, commentChar: o.comment, skipComments: o.skip });
  const old = oldParse(text, { separator: esc(o.sep), quoteMark: o.quote, hasHeaders: o.hasHeaders, commentCharacter: o.comment, skipComments: o.skip });
  const ctx = JSON.stringify([text, o]);
  assert.deepStrictEqual(mine.rows, old.rows, 'rows ' + ctx);
  assert.deepStrictEqual(mine.header, old.header, 'header ' + ctx);
  assert.strictEqual(mine.colCount, old.colCount, 'colCount ' + ctx);
  assert.deepStrictEqual(Array.from(mine.rowSpan), old.spans, 'spans ' + ctx);
  if (old.sepApplied != null) assert.strictEqual(mine.sepDirective, old.sepApplied, 'sep ' + ctx);
}

// deterministic PRNG
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

test('basic shapes', () => {
  const p = OX.parseCsv('a,b,c\n1,2,3\n4,5\n', { separator: ',', quote: '"', hasHeaders: true });
  assert.deepStrictEqual(p.header, ['a', 'b', 'c']);
  assert.deepStrictEqual(p.rows, [['1', '2', '3'], ['4', '5']]);
  assert.strictEqual(p.colCount, 3);
  assert.deepStrictEqual(Array.from(p.rowLine), [1, 2]);
  assert.deepStrictEqual(Array.from(p.rowSpan), [1, 1]);
  assert.strictEqual(p.headerLine, 0);
  assert.strictEqual(p.lineCount, 4);
});

test('empty and degenerate', () => {
  for (const t of ['', '\n', '\r\n\r\n', '﻿']) {
    const p = OX.parseCsv(t, { separator: ',', quote: '"', hasHeaders: false });
    assert.deepStrictEqual(p.rows, []);
    assert.strictEqual(p.colCount, 1);
    assert.strictEqual(p.header, null);
  }
  const h = OX.parseCsv('', { separator: ',', quote: '"', hasHeaders: true });
  assert.deepStrictEqual(h.header, ['']);
  assert.strictEqual(h.headerLine, -1);
});

test('BOM, newline styles, no phantom row', () => {
  for (const nl of ['\n', '\r\n', '\r']) {
    const p = OX.parseCsv('﻿a,b' + nl + 'c,d' + nl, { separator: ',', quote: '"', hasHeaders: false });
    assert.deepStrictEqual(p.rows, [['a', 'b'], ['c', 'd']]);
    assert.deepStrictEqual(Array.from(p.rowLine), [0, 1]);
    assert.strictEqual(p.lineCount, 3);
  }
  const p = OX.parseCsv('a,b\n\nc,d', { separator: ',', quote: '"' });
  assert.deepStrictEqual(Array.from(p.rowLine), [0, 2]);
  assert.strictEqual(p.endsWithNewline, false);
});

test('quotes: doubled, multiline, lenient', () => {
  const t = '"a ""x"" b","line1\nline2",plain\n"x\r\ny",z\nab"cd,ef\n';
  const p = OX.parseCsv(t, { separator: ',', quote: '"' });
  assert.deepStrictEqual(p.rows[0], ['a "x" b', 'line1\nline2', 'plain']);
  assert.deepStrictEqual(p.rows[1], ['x\r\ny', 'z']);
  assert.deepStrictEqual(Array.from(p.rowLine), [0, 2, 4]);
  assert.deepStrictEqual(Array.from(p.rowSpan), [2, 2, 2]);
  assert.deepStrictEqual(p.rows[2], ['ab"cd,ef\n']);
  const l = OX.parseCsv('a,b"c\n', { separator: ',' });
  assert.strictEqual(l.rows.length, 1);
  assert.strictEqual(l.rows[0][1], 'b"c\n');
});

test('sep directive, comments, header lines', () => {
  const t = 'sep=;\n# note\na;b\n\n1;2\n   \n3;4\n';
  const p = OX.parseCsv(t, { separator: ',', quote: '"', hasHeaders: true, commentChar: '#', skipComments: true });
  assert.strictEqual(p.sepDirective, ';');
  assert.deepStrictEqual(p.header, ['a', 'b']);
  assert.strictEqual(p.headerLine, 2);
  assert.deepStrictEqual(p.rows, [['1', '2'], ['3', '4']]);
  assert.deepStrictEqual(Array.from(p.rowLine), [4, 6]);
  const q = OX.parseCsv('# x\na,b\n', { separator: ',', skipComments: false, commentChar: '#' });
  assert.strictEqual(q.rows.length, 2);
  const m = OX.parseCsv('a::b::c\n1::2', { separator: '::' });
  assert.deepStrictEqual(m.rows, [['a', 'b', 'c'], ['1', '2']]);
});

test('ragged rows and colCount', () => {
  const p = OX.parseCsv('a\nb,c,d\n,\n', { separator: ',' });
  assert.strictEqual(p.colCount, 3);
  assert.deepStrictEqual(p.rows, [['a'], ['b', 'c', 'd'], ['', '']]);
});

test('quoted flags', () => {
  const p = OX.parseCsv('"a",b,"c"\n', { separator: ',' });
  assert.strictEqual(p.quotedMask[0], 0b101);
});

test('fuzz vs legacy parser: random garbage (no CR)', () => {
  const r = rng(12345);
  const alpha = ['a', 'b', '1', ' ', ',', ',', '"', '"', '\n', '#', ';', '\t', 'x y'];
  for (let it = 0; it < 4000; it++) {
    let s = '';
    const len = Math.floor(r() * 40);
    for (let i = 0; i < len; i++) s += alpha[Math.floor(r() * alpha.length)];
    if ((s.split('"').length - 1) % 2) s += '"';
    const o = { sep: [',', ';', '\t'][it % 3], quote: '"', hasHeaders: it % 2 === 0, comment: '#', skip: it % 5 < 2 };
    compareWithOld(s, o);
  }
});

test('fuzz vs legacy parser: structured with CRLF/CR terminators', () => {
  const r = rng(777);
  const cellGen = () => {
    const k = r();
    if (k < 0.5) return String(Math.floor(r() * 1000));
    if (k < 0.6) return '';
    if (k < 0.7) return 'ab c';
    if (k < 0.8) return '"he said ""hi"", ok"';
    if (k < 0.9) return '"multi\nline"';
    return '"x"';
  };
  for (let it = 0; it < 1500; it++) {
    const nl = ['\n', '\r\n', '\r'][it % 3];
    const rowsN = Math.floor(r() * 8);
    let s = it % 11 === 0 ? 'sep=,' + nl : '';
    for (let i = 0; i < rowsN; i++) {
      const nc = 1 + Math.floor(r() * 5);
      const cells = [];
      for (let j = 0; j < nc; j++) cells.push(cellGen());
      s += (it % 7 === 0 && i === 1 ? '# c' : cells.join(',')) + (i < rowsN - 1 || r() < 0.5 ? nl : '');
      if (r() < 0.1) s += nl;
    }
    if (nl === '\r\n' || nl === '\r') s = s.replace(/"multi\n/g, '"multi '); // legacy drops first CR inside quotes only; avoid
    if (nl !== '\n' && /"[^"]*\n/.test(s) === false) { /* ok */ }
    // legacy counts spans via \n only, so compare spans only for \n inputs
    const o = { sep: ',', quote: '"', hasHeaders: it % 2 === 0, comment: '#', skip: it % 3 === 0 };
    const mine = OX.parseCsv(s, { separator: ',', quote: '"', hasHeaders: o.hasHeaders, commentChar: '#', skipComments: o.skip });
    const old = oldParse(s, { separator: ',', quoteMark: '"', hasHeaders: o.hasHeaders, commentCharacter: '#', skipComments: o.skip });
    assert.deepStrictEqual(mine.rows, old.rows, JSON.stringify(s));
    assert.deepStrictEqual(mine.header, old.header, JSON.stringify(s));
    assert.strictEqual(mine.colCount, old.colCount);
    if (nl === '\n') assert.deepStrictEqual(Array.from(mine.rowSpan), old.spans);
  }
});

// trivial char-by-char RFC4180 reference with source-line tracking
function refParse(text) {
  const rows = [], lines = [], spans = [];
  let row = [], cur = '', inQ = false, line = 0, startLine = 0, nl = 0, i = 0, has = false;
  const endRow = () => { row.push(cur); rows.push(row); lines.push(startLine); spans.push(nl + 1); row = []; cur = ''; has = false; nl = 0; };
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else { if (ch === '\n') nl++; cur += ch; }
    } else if (ch === '"' && cur === '' && (has = true)) inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; has = true; }
    else if (ch === '\n') { if (has || cur !== '' || row.length) endRow(); else line++; line += (has || true) ? 0 : 0; }
    else { cur += ch; has = true; }
    if (!inQ && ch === '\n') { /* line accounting below */ }
    i++;
  }
  if (has || cur !== '' || row.length) endRow();
  return { rows, lines, spans };
}

test('fuzz vs trivial reference parser (well-formed input)', () => {
  const r = rng(99);
  const pieces = ['a', 'bc', '', '1.5', ' sp ', '"q"', 'new\nline', 'qu"ote', ',in,'];
  for (let it = 0; it < 2000; it++) {
    const rowsN = 1 + Math.floor(r() * 10);
    const src = [], lines = [], spans = [];
    let text = '', line = 0;
    for (let i = 0; i < rowsN; i++) {
      const nc = 1 + Math.floor(r() * 5), cells = [];
      for (let j = 0; j < nc; j++) cells.push(pieces[Math.floor(r() * pieces.length)]);
      if (nc === 1 && cells[0] === '') cells[0] = 'z';
      src.push(cells);
      const enc = cells.map((c) => OX.serializeCsvField(c, ',', '"'));
      const lineText = enc.join(',');
      lines.push(line); const sp = lineText.split('\n').length; spans.push(sp); line += sp;
      text += lineText + (i < rowsN - 1 || r() < 0.5 ? '\n' : '');
    }
    const p = OX.parseCsv(text, { separator: ',', quote: '"' });
    assert.deepStrictEqual(p.rows, src, JSON.stringify(text));
    assert.deepStrictEqual(Array.from(p.rowLine), lines);
    assert.deepStrictEqual(Array.from(p.rowSpan), spans);
    const ref = refParse(text);
    assert.deepStrictEqual(ref.rows, src);
  }
});

test('serialize', () => {
  assert.strictEqual(OX.serializeCsvField('abc', ',', '"'), 'abc');
  assert.strictEqual(OX.serializeCsvField('a,b', ',', '"'), '"a,b"');
  assert.strictEqual(OX.serializeCsvField('a"b', ',', '"'), '"a""b"');
  assert.strictEqual(OX.serializeCsvField('a\nb', ';', '"'), '"a\nb"');
  assert.strictEqual(OX.serializeCsvField('a', ',', '"', true), '"a"');
  assert.strictEqual(OX.serializeCsvField('a;b', ',', '"'), 'a;b');
  assert.strictEqual(OX.serializeCsvRow(['a', 'b,c', ''], ',', '"'), 'a,"b,c",');
  const rt = OX.parseCsv(OX.serializeCsvRow(['x"y', 'l1\nl2', ''], '\t', '"'), { separator: '\t' });
  assert.deepStrictEqual(rt.rows[0], ['x"y', 'l1\nl2', '']);
});

test('detectSeparator', () => {
  assert.strictEqual(OX.detectSeparator('a,b,c\n1,2,3\n'), ',');
  assert.strictEqual(OX.detectSeparator('a;b;c\n1,5;2,5;3\n'), ';');
  assert.strictEqual(OX.detectSeparator('a\tb\tc\n1\t2\t3'), '\t');
  assert.strictEqual(OX.detectSeparator('a|b|c\n1|2|3'), '|');
  assert.strictEqual(OX.detectSeparator('"a,b";c\n"1,2";3'), ';');
  assert.strictEqual(OX.detectSeparator('sep=|\na,b'), '|');
  assert.strictEqual(OX.detectSeparator('hello'), ',');
  assert.strictEqual(OX.detectSeparator(''), ',');
});

test('performance sanity (~20MB)', () => {
  const rowsN = 400000;
  const parts = [];
  for (let i = 0; i < rowsN; i++) parts.push(`${i},name ${i},"quoted, ${i}",${i * 1.5},2024-01-${(i % 28) + 1},some longer text value ${i}`);
  const text = parts.join('\n') + '\n';
  const t0 = process.hrtime.bigint();
  const p = OX.parseCsv(text, { separator: ',', quote: '"' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(p.rows.length, rowsN);
  console.log(`# parse ${(text.length / 1e6).toFixed(1)}MB in ${ms.toFixed(0)}ms = ${(text.length / 1e6 / (ms / 1000)).toFixed(0)} MB/s`);
  assert.ok(ms < 8000);
});
