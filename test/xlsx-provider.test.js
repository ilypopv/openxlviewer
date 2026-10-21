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

function open() {
    const bytes = F.fullWorkbook();
    const wb = OX.readXlsx(bytes);
    return { bytes, wb, p: new OX.XlsxProvider(wb, wb.loadSheet(0)) };
}

test('provider exposes cells, raw text and extents', () => {
    const { p } = open();
    assert.ok(p.rowCount > 0 && p.colCount > 0);
    let seen = 0;
    p.forEachCell(0, 0, p.rowCount, p.colCount, () => seen++);
    assert.ok(seen > 0);
    const cv = p.getCell(0, 0);
    assert.ok(cv === undefined || typeof cv.text === 'string');
});

test('edit overlay, undo slot and patch round trip', () => {
    const { bytes, wb, p } = open();
    const cell = p.editFromText(2, 1, 'hello');
    const slot = p.setCell(2, 1, cell);
    assert.equal(p.getCell(2, 1).text, 'hello');
    assert.equal(p.getRaw(2, 1), 'hello');
    assert.ok(p.dirty);
    const edits = p.pendingEdits(0);
    assert.equal(edits.length, 1);
    const out = OX.patchXlsx(bytes, edits);
    const wb2 = OX.readXlsx(out);
    const sh2 = wb2.loadSheet(0);
    assert.equal(sh2.rows[2][1].v, 'hello');
    p.restoreSlot(2, 1, slot);
    assert.ok(!p.dirty);
});

test('formula text and clearing', () => {
    const { p } = open();
    p.setCell(0, 0, p.editFromText(0, 0, '=1+2'));
    assert.equal(p.getRaw(0, 0), '=1+2');
    p.setCell(0, 0, p.editFromText(0, 0, ''));
    assert.equal(p.getRaw(0, 0), '');
});

test('extent grows with edits', () => {
    const { p } = open();
    const before = p.rowCount;
    p.setCell(before + 5, 2, { t: 'n', v: 1, s: 0 });
    assert.equal(p.rowCount, before + 6);
});
