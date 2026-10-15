'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sim = require('./helpers/csv-host-sim.js');
const { run, edit, editMany, del, add, drain } = require('./helpers/csv-host-ops.js');

// Drives the real src/csvDocumentView.ts + out/csv.js + csv-parser/provider against a fake VS Code document.
const good = async (name, text, eol, steps, o) => {
  const r = await run(name, text, eol, steps, o);
  assert.ok(r.ok, r.msg);
  return r.w;
};

const base = 'a,b\n1,2\n3,4\n5,6\n';

test('basic edits, multi-line cells, header edits', async () => {
  await good('edit', base, 1, [edit(1, 0, 'X')]);
  await good('multiline', base, 1, [edit(1, 0, 'X\nY'), edit(3, 1, 'Z')]);
  await good('multiline batch', base, 1, [editMany([[1, 0, 'p\nq'], [2, 0, 'r\ns'], [3, 1, 't']])]);
  await good('header', base, 1, [edit(0, 0, 'H\nH2'), edit(1, 1, 'k'), edit(0, 1, '')]);
});

test('delete rows (single, ranges, all) and add rows', async () => {
  await good('del mid', base, 1, [del([2])]);
  await good('del range', base, 1, [del([1, 2])]);
  await good('del first+last', base, 1, [del([1, 3])]);
  await good('del all', base, 1, [del([1, 2, 3])]);
  await good('add', base, 1, [add, add]);
  await good('paste beyond end', base, 1, [editMany([[1, 0, 'Q'], [5, 0, 'x'], [6, 1, 'y']])]);
});

test('no trailing newline: last row edit + append in one batch stays aligned', async () => {
  const nt = 'a,b\n1,2\n3,4';
  const w = await good('batch', nt, 1, [editMany([[2, 0, 'p'], [3, 0, 'q']]), edit(3, 1, 'M'), add]);
  assert.strictEqual(w.doc.text, 'a,b\n1,2\np,4\nq,M\n,');
  await good('batch big', nt, 1, [editMany([[2, 0, 'p'], [2, 1, 'p'], [3, 0, 'q'], [3, 1, 'r'], [4, 0, 's']])]);
  await good('crlf', 'a,b\r\n1,2\r\n3,4', 2, [editMany([[2, 0, 'p'], [3, 0, 'q']]), edit(3, 1, 'z')]);
  await good('single row', 'a,b\n1,2', 1, [editMany([[1, 0, 'p'], [2, 0, 'q']])]);
  await good('header only', 'a,b', 1, [editMany([[0, 0, 'p'], [1, 0, 'q']])]);
  const e = await good('edit only keeps no eol', nt, 1, [edit(2, 0, 'Z')]);
  assert.strictEqual(e.doc.text, 'a,b\n1,2\nZ,4');
  const d = await good('delete last', nt, 1, [del([2]), add]);
  assert.strictEqual(d.doc.text, 'a,b\n1,2\n,');
  await good('delete tail range', nt, 1, [del([1, 2])]);
  await good('delete + append batch', nt, 1, [del([2]), editMany([[2, 0, 'n']])]);
});

test('single column files keep empty rows', async () => {
  const w = await good('clear', 'a\n1\n2\n3\n', 1, [edit(1, 0, ''), edit(3, 0, 'Z')]);
  assert.strictEqual(w.doc.text, 'a\n""\n2\nZ\n');
  await good('clear 2', 'a\n1\n2\n3\n', 1, [edit(1, 0, ''), edit(2, 0, 'Q'), edit(3, 0, 'R')]);
  await good('add rows', 'a\n1\n', 1, [add, add, edit(3, 0, 'x')]);
  await good('no header', '1\n2\n3\n', 1, [edit(0, 0, ''), edit(1, 0, 'Q')], { hasHeaders: false });
  await good('header clear', 'a\n1\n2\n', 1, [edit(0, 0, ''), edit(1, 0, 'Q')]);
  await good('1col nt add', 'a\n1', 1, [add, edit(2, 0, 'x'), add]);
});

test('CRLF, BOM and sep= documents', async () => {
  await good('crlf', base.replace(/\n/g, '\r\n'), 2, [edit(1, 0, 'X\nY'), edit(2, 1, 'W'), add, del([2])]);
  await good('bom', '﻿' + base, 1, [edit(1, 0, 'X'), add]);
  await good('sep', 'sep=;\na;b\n1;2\n', 1, [edit(1, 0, 'X'), add]);
});

test('self edits do not swallow a concurrent undo/external change', async () => {
  const w = sim.makeWebview(base, 1);
  await drain(w);
  const posted = [];
  const orig = w.view.webview.postMessage;
  w.view.webview.postMessage = (m) => { posted.push(m); return orig(m); };
  sim.vscode._after = () => { sim.externalEdit('a,b\nEXT,2\n3,4\n5,6\n'); };
  w.shell().o.onEdit([{ r: 1, c: 1, text: 'Z' }], 'type');
  await new Promise(r => setTimeout(r, 80));
  assert.ok(posted.some(m => m.refresh), 'external change must trigger a refresh');
  const last = posted.filter(m => m.refresh).pop();
  assert.ok(/EXT/.test(last.content));
});

test('plain own edits do not echo a refresh', async () => {
  const w = sim.makeWebview(base, 1);
  await drain(w);
  const posted = [];
  const orig = w.view.webview.postMessage;
  w.view.webview.postMessage = (m) => { posted.push(m); return orig(m); };
  w.shell().o.onEdit([{ r: 1, c: 1, text: 'Z' }], 'type');
  await new Promise(r => setTimeout(r, 80));
  assert.strictEqual(posted.filter(m => m.refresh).length, 0);
});

test('randomized operation sequences stay aligned with the document', async () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const docs = [
    ['a,b\n1,2\n3,4\n5,6\n', 1], ['a,b\n1,2\n3,4\n5,6', 1], ['a,b\r\n1,2\r\n3,4', 2], ['a\n1\n2\n3', 1],
    ['a,b\n"x\ny",2\n3,4\n', 1], ['a,b\n1,2\n\n3,4\n', 1]
  ];
  for (let i = 0; i < 40; i++) {
    const [text, eol] = docs[i % docs.length];
    const steps = [];
    for (let k = 0; k < 6; k++) {
      const op = rnd(5), v = ['', 'q', 'a,b', 'm\nn', '"'][rnd(5)];
      if (op === 0) steps.push((w, sh) => { const p = sh.provider; sh.o.onEdit([{ r: rnd(p.rowCount), c: rnd(Math.max(1, p.colCount)), text: v }], 'type'); });
      else if (op === 1) steps.push((w, sh) => { const p = sh.provider; const r = rnd(p.rowCount); sh.o.onEdit([{ r, c: 0, text: v }, { r: r + 1, c: 0, text: v + '1' }, { r: p.rowCount + rnd(2), c: 0, text: 'z' }], 'paste'); });
      else if (op === 2) steps.push(add);
      else if (op === 3) steps.push((w, sh) => { const p = sh.provider; if (p.rowCount > 2) del([1 + rnd(p.rowCount - 1)])(w, sh); });
      else steps.push((w, sh) => { const p = sh.provider; if (p.rowCount > 3) { const r = 1 + rnd(p.rowCount - 2); del([r, r + 1])(w, sh); } });
    }
    await good('fuzz' + i + ' ' + JSON.stringify(text), text, eol, steps);
  }
});
