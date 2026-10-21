'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.fflate = require('../out/vendor/fflate.js');
globalThis.SSF = require('../out/vendor/ssf.js');
const OX = require('../out/core/xlsx-reader.js');
require('../out/core/format.js');
require('../out/core/xlsx-writer.js');
require('../out/core/xlsx-provider.js');
const fl = globalThis.fflate;
const enc = s => new TextEncoder().encode(s);
const BOMB = /too large or looks like a zip bomb/;

function pkg(sheetBytes, extra) {
    const o = {
        '[Content_Types].xml': enc('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
        '_rels/.rels': enc(
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
        ),
        'xl/workbook.xml': enc(
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'
        ),
        'xl/_rels/workbook.xml.rels': enc(
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
        ),
        'xl/worksheets/sheet1.xml': sheetBytes
    };
    return fl.zipSync(Object.assign(o, extra || {}), { level: 9 });
}
const head = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
const bombSheet = mb => {
    const u = new Uint8Array(mb * 1048576);
    u.fill(32);
    u.set(enc(head), 0);
    return u;
};

function forge(z, name) {
    const dv = new DataView(z.buffer, z.byteOffset, z.length);
    const eo = z.length - 22;
    let q = dv.getUint32(eo + 16, true);
    for (let k = 0; k < dv.getUint16(eo + 10, true); k++) {
        const nl = dv.getUint16(q + 28, true),
            el = dv.getUint16(q + 30, true),
            cl = dv.getUint16(q + 32, true);
        if (Buffer.from(z.subarray(q + 46, q + 46 + nl)).toString() === name) dv.setUint32(q + 24, 10, true);
        q += 46 + nl + el + cl;
    }
    return z;
}

test('streamed sheet over the size limit aborts with the bomb error', async () => {
    const z = forge(pkg(bombSheet(8)), 'xl/worksheets/sheet1.xml');
    assert.ok(z.length < 100000);
    assert.throws(() => OX.readXlsx(pkg(bombSheet(8)), { limits: { maxSheet: 2 * 1048576 } }), BOMB);
    const wb = OX.readXlsx(z, { limits: { maxSheet: 2 * 1048576, maxTotal: 1e12 } });
    await assert.rejects(wb.loadSheetAsync(0), BOMB);
    assert.throws(() => wb.loadSheet(0), BOMB);
});

test('ratio rule aborts streaming only when the output is also large', async () => {
    const z = pkg(bombSheet(8));
    const wb = OX.readXlsx(z, { limits: { ratio: 100, ratioMin: 1048576 } });
    await assert.rejects(wb.loadSheetAsync(0), BOMB);
    const ok = OX.readXlsx(z, { limits: { ratio: 100, ratioMin: 64 * 1048576 } });
    assert.ok(await ok.loadSheetAsync(0));
});

test('declared total size, per-part size and entry count are capped', () => {
    const z = pkg(bombSheet(4));
    assert.throws(() => OX.readXlsx(z, { limits: { maxTotal: 1048576 } }), BOMB);
    const sst = pkg(enc(head + '</sheetData></worksheet>'), { 'xl/sharedStrings.xml': bombSheet(4) });
    assert.throws(() => OX.readXlsx(sst, { limits: { maxPart: 1048576 } }), BOMB);
    const many = {};
    for (let i = 0; i < 50; i++) many['docProps/x' + i + '.txt'] = enc('x');
    assert.throws(
        () => OX.readXlsx(pkg(enc(head + '</sheetData></worksheet>'), many), { limits: { maxEntries: 20 } }),
        BOMB
    );
});

test('lying header sizes cannot bypass the inflate cap', () => {
    const z = pkg(enc(head + '</sheetData></worksheet>'), { 'xl/sharedStrings.xml': bombSheet(4) });
    forge(z, 'xl/sharedStrings.xml');
    assert.throws(() => OX.readXlsx(z, { limits: { maxPart: 1048576 } }), BOMB);
});

test('writer inflate paths are guarded too', () => {
    const z = pkg(bombSheet(4));
    const saved = Object.assign({}, OX.zipLimits);
    try {
        OX.zipLimits.maxSheet = 1048576;
        assert.throws(() => OX.patchXlsx(z, [{ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: 1 } }]), BOMB);
        Object.assign(OX.zipLimits, saved, { maxEntries: 3 });
        assert.throws(() => OX.patchXlsx(z, [{ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: 1 } }]), BOMB);
    } finally {
        Object.assign(OX.zipLimits, saved);
    }
});

test('odd entry names are inert lookup keys', () => {
    const z = pkg(enc(head + '<row r="1"><c r="A1"><v>5</v></c></row></sheetData></worksheet>'), {
        '../../evil.xml': enc('x'),
        '/abs/__proto__': enc('y')
    });
    const wb = OX.readXlsx(z);
    assert.equal(wb.loadSheet(0).rows[0][0].v, 5);
    assert.ok(OX.patchXlsx(z, [{ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: 6 } }]).length > 0);
});

test('provider exposes array formula ranges', () => {
    const sheet =
        head +
        '<row r="1"><c r="E1"><f t="array" ref="E1:E3">A1:A3*2</f><v>2</v></c></row><row r="2"><c r="E2"><v>4</v></c></row></sheetData></worksheet>';
    const wb = OX.readXlsx(pkg(enc(sheet)));
    const p = new OX.XlsxProvider(wb, wb.loadSheet(0));
    assert.deepEqual(p.arrayRanges(), [{ r1: 0, c1: 4, r2: 2, c2: 4, mr: 0, mc: 4 }]);
    assert.equal(p.arrayAt(1, 4).mr, 0);
    assert.equal(p.arrayAt(1, 3), null);
});
