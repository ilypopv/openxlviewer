'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sim = require('./helpers/csv-host-sim.js');
const { drain } = require('./helpers/csv-host-ops.js');

const big = (rows, tag) => 'id,name,val\n' + Array.from({ length: rows }, (_, i) => i + ',n' + (tag || '') + i + ',' + i * 2).join('\n') + '\n';
const settle = async (w, ms = 40) => { await drain(w); await new Promise((r) => setTimeout(r, ms)); await drain(w); };
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } };

function spy(w) {
  const posted = [];
  const orig = w.view.webview.postMessage;
  w.view.webview.postMessage = (m) => { posted.push(m); return orig(m); };
  return posted;
}

test('small documents still travel as one refresh message with content', async () => {
  const w = sim.makeWebview('a,b\n1,2\n', 1);
  const posted = spy(w);
  await settle(w);
  w.view.refresh();
  await settle(w);
  assert.ok(posted.some((m) => m.refresh && m.content === 'a,b\n1,2\n'));
  assert.ok(!posted.some((m) => m.refreshChunk));
});

test('documents above the inline limit are sent as ordered line-aligned chunks and rebuilt exactly', async () => {
  const text = big(260000);
  assert.ok(text.length > 4 * 1024 * 1024);
  const w = sim.makeWebview(text, 1);
  const posted = spy(w);
  w.view.refresh();
  await until(() => posted.some((m) => m.refreshChunk === 'end'));
  await settle(w);
  const chunks = posted.filter((m) => m.refreshChunk);
  assert.strictEqual(chunks[0].refreshChunk, 'start');
  assert.strictEqual(chunks[0].chars, text.length);
  const data = chunks.filter((m) => m.refreshChunk === 'data');
  assert.ok(data.length > 2);
  data.forEach((m, i) => { assert.strictEqual(m.seq, i); assert.ok(m.text.length <= 2 * 1024 * 1024); });
  assert.strictEqual(data.map((m) => m.text).join(''), text);
  assert.strictEqual(chunks[chunks.length - 1].count, data.length);
  assert.ok(new Set(chunks.map((m) => m.id)).size === 1);
  assert.ok(!posted.some((m) => m.refresh && m.content));
  await until(() => { const sh = w.shell(); return sh && sh.provider && !sh.loading && sh.provider.dataRowCount === 260000; });
  const p = w.shell().provider;
  assert.strictEqual(p.getRaw(1, 1), 'n0');
  assert.strictEqual(p.getRaw(260000, 2), String(259999 * 2));
});

test('a newer refresh cancels the transfer in flight; the webview ends up with the latest document', async () => {
  const w = sim.makeWebview(big(260000, 'a'), 1);
  const posted = spy(w);
  await until(() => { const sh = w.shell(); return sh && sh.provider && !sh.loading && sh.provider.dataRowCount === 260000; });
  await settle(w);
  posted.length = 0;
  const slow = w.view.webview.postMessage;
  w.view.webview.postMessage = async (m) => { await new Promise((r) => setTimeout(r, 3)); return slow(m); };
  w.view.refresh();
  await until(() => posted.some((m) => m.refreshChunk === 'data'));
  sim.externalEdit(big(260000, 'b'));
  await until(() => posted.filter((m) => m.refreshChunk === 'end').length >= 1 && w.shell().provider && w.shell().provider.getRaw(1, 1) === 'nb0');
  await settle(w);
  const starts = posted.filter((m) => m.refreshChunk === 'start');
  assert.ok(starts.length >= 2, 'a second transfer started');
  const ends = posted.filter((m) => m.refreshChunk === 'end');
  assert.strictEqual(ends.length, 1, 'the cancelled transfer never sent its end');
  assert.notStrictEqual(starts[0].id, starts[starts.length - 1].id);
  assert.strictEqual(w.shell().provider.getRaw(260000, 1), 'nb259999');
});

test('stale or out-of-order chunks are ignored and trigger a resync request', async () => {
  const w = sim.makeWebview('a\n1\n', 1);
  await settle(w);
  const o = w.vctx.window.oxCsv;
  o.chunk({ refreshChunk: 'start', id: 5, chars: 100 });
  o.chunk({ refreshChunk: 'data', id: 4, seq: 0, text: 'zzz\n' }); // stale id
  o.chunk({ refreshChunk: 'data', id: 5, seq: 0, text: 'h\n1\n' });
  o.chunk({ refreshChunk: 'data', id: 5, seq: 2, text: '9\n' }); // gap -> abort + resync
  o.chunk({ refreshChunk: 'end', id: 5, count: 3 });
  await settle(w);
  assert.strictEqual(w.shell().provider.getRaw(0, 0), 'a', 'previous document stays until a complete transfer arrives');
});

test('edits are refused while the file is still loading', async () => {
  const w = sim.makeWebview('a\n1\n', 1);
  await settle(w);
  const sh = w.shell();
  sh.loading = true;
  const before = w.doc.text;
  sh.o.onEdit([{ r: 1, c: 0, text: 'X' }], 'type');
  await settle(w);
  assert.strictEqual(w.doc.text, before);
  sh.loading = false;
  sh.o.onEdit([{ r: 1, c: 0, text: 'X' }], 'type');
  await settle(w);
  assert.strictEqual(w.doc.text, 'a\nX\n');
});
