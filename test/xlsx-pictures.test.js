'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.fflate = require('../out/vendor/fflate.js');
globalThis.SSF = require('../out/vendor/ssf.js');
const OX = require('../out/core/xlsx-reader.js');
require('../out/core/xlsx-writer.js');
const F = require('./helpers/xlsx-fixtures.js');

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DML = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const DR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const HDR = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function drawingXml() {
  return HDR + `<xdr:wsDr xmlns:xdr="${DR}" xmlns:a="${DML}">` +
    `<xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>9525</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:from>` +
    `<xdr:ext cx="190500" cy="95250"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="pic"/><xdr:cNvPicPr/></xdr:nvPicPr>` +
    `<xdr:blipFill><a:blip xmlns:r="${RNS}" r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
    `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
    `</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>` +
    `<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="vec"/><xdr:cNvPicPr/></xdr:nvPicPr>` +
    `<xdr:blipFill><a:blip xmlns:r="${RNS}" r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
    `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
    `</xdr:pic><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;
}

function workbookWithPics() {
  const sheet = HDR + `<worksheet xmlns="${NS}" xmlns:r="${RNS}"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><drawing r:id="rId1"/></worksheet>`;
  const sheetRels = HDR + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RNS}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`;
  const drawingRels = HDR + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RNS}/image" Target="../media/pic.png"/><Relationship Id="rId2" Type="${RNS}/image" Target="../media/chart.emf"/></Relationships>`;
  return F.buildPackage({
    sheets: [{ name: 'Pics', xml: sheet, rels: sheetRels }],
    extraFiles: {
      'xl/drawings/drawing1.xml': drawingXml(),
      'xl/drawings/_rels/drawing1.xml.rels': drawingRels,
      'xl/media/pic.png': new Uint8Array(PNG),
      'xl/media/chart.emf': new Uint8Array([1, 2, 3, 4]),
    },
  });
}

test('drawings: anchored raster picture is exposed, emf is skipped', () => {
  const wb = OX.readXlsx(workbookWithPics());
  const sh = wb.loadSheet(0);
  assert.equal(sh.pictures.length, 1);
  const p = sh.pictures[0];
  assert.deepEqual({ r: p.r, c: p.c, dx: p.dx, dy: p.dy, w: p.w, h: p.h }, { r: 2, c: 1, dx: 1, dy: 2, w: 20, h: 10 });
  assert.ok(p.url.startsWith('data:image/png;base64,'), 'data URL with mime');
  assert.equal(p.url, 'data:image/png;base64,' + PNG.toString('base64'));
});

test('drawings: sheet without drawings has no pictures', () => {
  const wb = OX.readXlsx(F.simpleWorkbook([['a']]));
  assert.deepEqual(wb.loadSheet(0).pictures, []);
});

test('drawings: patchXlsx keeps drawing parts byte-for-byte', () => {
  const orig = workbookWithPics();
  const out = OX.patchXlsx(orig, [{ sheet: 0, r: 0, c: 0, cell: { t: 'n', v: 2 } }]);
  const sh = OX.readXlsx(out).loadSheet(0);
  assert.equal(sh.pictures.length, 1);
  assert.equal(sh.pictures[0].url, 'data:image/png;base64,' + PNG.toString('base64'));
});
