'use strict';
// Builders for realistic XLSX packages (written the way Excel lays them out).
const fflate = globalThis.fflate || (globalThis.fflate = require('../../out/vendor/fflate.js'));

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const HDR = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function zip(files, opts) {
  const o = {};
  for (const k of Object.keys(files)) {
    const v = files[k];
    o[k] = [typeof v === 'string' ? fflate.strToU8(v) : v, { level: (opts && opts.level) != null ? opts.level : 6 }];
  }
  return fflate.zipSync(o);
}

function colName(c) {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const THEME = HDR + `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

// cellXfs index map used by the full workbook fixture
const STYLES = HDR + `<styleSheet xmlns="${NS}">
<numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="[&gt;=100]0.0;0"/></numFmts>
<fonts count="4">
<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>
<font><b/><sz val="14"/><color rgb="FFFF0000"/><name val="Arial"/><family val="2"/></font>
<font><i/><u/><strike/><sz val="9"/><color theme="4" tint="-0.249977111117893"/><name val="Calibri"/></font>
<font><b val="0"/><sz val="11"/><color indexed="12"/><name val="Calibri"/></font>
</fonts>
<fills count="5">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor theme="4" tint="0.79998168889431442"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>
<fill><gradientFill degree="90"><stop position="0"><color rgb="FF00FF00"/></stop><stop position="1"><color rgb="FF0000FF"/></stop></gradientFill></fill>
</fills>
<borders count="3">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color auto="1"/></left><right style="thin"><color rgb="FFFF0000"/></right><top style="medium"><color theme="1"/></top><bottom style="double"><color indexed="64"/></bottom><diagonal/></border>
<border><left/><right/><top/><bottom style="thick"><color theme="0" tint="-0.0499893185216834"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="11">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="3" borderId="2" xfId="0"><alignment horizontal="center" vertical="center" wrapText="1" indent="2"/></xf>
<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="3" fillId="4" borderId="0" xfId="0"/>
<xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0"/>
<xf numFmtId="44" fontId="0" fillId="0" borderId="0" xfId="0"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="1"><dxf><font><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf></dxfs>
</styleSheet>`;

function sst(items) {
  let n = 0;
  const body = items.map((it) => {
    n++;
    if (typeof it === 'string') {
      const sp = /^\s|\s$|\n/.test(it) ? ' xml:space="preserve"' : '';
      return `<si><t${sp}>${esc(it)}</t></si>`;
    }
    return '<si>' + it.raw + '</si>';
  }).join('');
  return HDR + `<sst xmlns="${NS}" count="${n}" uniqueCount="${n}">${body}</sst>`;
}

function contentTypes(extra) {
  return HDR + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${extra || ''}</Types>`;
}
const ROOT_RELS = HDR + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';

// opts: { sheets:[{name,state,xml,rels,relType,target}], date1904, sst, styles, theme, extraFiles, absoluteTargets, calcChain }
function buildPackage(o) {
  const sheets = o.sheets;
  const files = {};
  let ct = '';
  files['_rels/.rels'] = ROOT_RELS;
  let wbSheets = '', rels = '';
  sheets.forEach((s, i) => {
    const target = s.target || `worksheets/sheet${i + 1}.xml`;
    const full = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    files[full] = s.xml;
    ct += `<Override PartName="/${full}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.${s.relType === 'chartsheet' ? 'chartsheet' : 'worksheet'}+xml"/>`;
    if (s.rels) files[full.replace(/([^/]+)$/, '_rels/$1.rels')] = s.rels;
    wbSheets += `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`;
    const type = s.relType || 'worksheet';
    rels += `<Relationship Id="rId${i + 1}" Type="${NS_R}/${type}" Target="${target}"/>`;
  });
  let n = sheets.length;
  if (o.sst) { files['xl/sharedStrings.xml'] = o.sst; ct += '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'; rels += `<Relationship Id="rId${++n}" Type="${NS_R}/sharedStrings" Target="sharedStrings.xml"/>`; }
  if (o.styles) { files['xl/styles.xml'] = o.styles; ct += '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'; rels += `<Relationship Id="rId${++n}" Type="${NS_R}/styles" Target="${o.absoluteTargets ? '/xl/styles.xml' : 'styles.xml'}"/>`; }
  if (o.theme) { files['xl/theme/theme1.xml'] = o.theme; ct += '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'; rels += `<Relationship Id="rId${++n}" Type="${NS_R}/theme" Target="theme/theme1.xml"/>`; }
  if (o.calcChain) { files['xl/calcChain.xml'] = o.calcChain; rels += `<Relationship Id="rId${++n}" Type="${NS_R}/calcChain" Target="calcChain.xml"/>`; }
  files['[Content_Types].xml'] = contentTypes(ct);
  files['xl/workbook.xml'] = HDR + `<workbook xmlns="${NS}" xmlns:r="${NS_R}"><fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="22228"/><workbookPr${o.date1904 ? ' date1904="1"' : ''} defaultThemeVersion="166925"/><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="12300"/></bookViews><sheets>${wbSheets}</sheets>${o.definedNames || ''}<calcPr calcId="191029"/></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = HDR + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
  if (o.extraFiles) Object.assign(files, o.extraFiles);
  return zip(files, { level: o.level });
}

function sheetXml(parts) {
  const p = Object.assign({ pr: '', dim: '', views: '<sheetViews><sheetView workbookViewId="0"/></sheetViews>', fmt: '<sheetFormatPr defaultRowHeight="15"/>', cols: '', data: '', post: '' }, parts);
  return HDR + `<worksheet xmlns="${NS}" xmlns:r="${NS_R}">${p.pr}${p.dim}${p.views}${p.fmt}${p.cols}<sheetData>${p.data}</sheetData>${p.post}</worksheet>`;
}

// A feature-rich workbook. Returns bytes; `expected` documents what the reader should see.
function fullWorkbook() {
  const strings = [
    'Name', 'Value', 'Hello & <World>', ' padded ',
    { raw: '<r><rPr><b/><sz val="11"/><color rgb="FFFF0000"/><rFont val="Calibri"/></rPr><t>Rich</t></r><r><rPr><sz val="11"/><rFont val="Calibri"/></rPr><t xml:space="preserve"> text &amp; more</t></r>' },
    { raw: '<t>Kanji</t><rPh sb="0" eb="1"><t>ignored</t></rPh><phoneticPr fontId="1"/>' },
    'line1\nline2', 'a_x000D_b', { raw: '<t>Emoji &#x1F600; &#65;</t>' }, 'Link', 'Total',
  ];
  const sheet1 = sheetXml({
    pr: '<sheetPr><tabColor theme="5" tint="0.39997558519241921"/></sheetPr>',
    dim: '<dimension ref="A1:F12"/>',
    views: '<sheetViews><sheetView showGridLines="0" tabSelected="1" zoomScale="120" workbookViewId="0"><pane xSplit="1" ySplit="2" topLeftCell="B3" activePane="bottomRight" state="frozen"/><selection pane="topRight"/><selection pane="bottomLeft"/><selection pane="bottomRight" activeCell="B3" sqref="B3"/></sheetView></sheetViews>',
    fmt: '<sheetFormatPr baseColWidth="10" defaultColWidth="10.5" defaultRowHeight="16" x14ac:dyDescent="0.2" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"/>',
    cols: '<cols><col min="1" max="1" width="20.7109375" customWidth="1"/><col min="3" max="4" width="12.140625" style="3" customWidth="1"/><col min="5" max="5" width="9.140625" hidden="1" customWidth="1"/></cols>',
    data:
      '<row r="1" spans="1:6" ht="30" customHeight="1"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1" s="1" t="s"><v>1</v></c><c r="C1" s="1"/></row>' +
      '<row r="2" spans="1:6"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1234.5</v></c><c r="C2" s="2"><v>44927</v></c><c r="D2" s="3"><v>-0.000125</v></c><c r="E2" t="b"><v>1</v></c><c r="F2" t="e"><v>#DIV/0!</v></c></row>' +
      '<row r="3" hidden="1"><c r="A3" t="s"><v>3</v></c><c r="B3" t="s"><v>4</v></c><c r="C3" t="s"><v>5</v></c><c r="D3" t="s"><v>6</v></c><c r="E3" t="s"><v>7</v></c><c r="F3" t="s"><v>8</v></c></row>' +
      '<row r="4"><c r="A4"><v>1</v></c><c r="B4"><f t="shared" ref="B4:B8" si="0">A4*2+Sheet2!$A$1</f><v>2</v></c><c r="C4"><f>SUM(A4:B4)</f><v>3</v></c><c r="D4" t="str"><f>"x"&amp;A4</f><v>x1</v></c><c r="E4" t="inlineStr"><is><t>inline &amp; ok</t></is></c></row>' +
      '<row r="5"><c r="A5"><v>2</v></c><c r="B5"><f t="shared" si="0"/><v>4</v></c><c r="C5"><f>SUM(A5:B5)</f><v>6</v></c></row>' +
      '<row r="6"><c r="A6"><v>3</v></c><c r="B6"><f t="shared" si="0"/><v>6</v></c></row>' +
      '<row r="7"><c r="A7"><v>4</v></c><c r="B7"><f t="shared" si="0"/><v>8</v></c></row>' +
      '<row r="8"><c r="A8"><v>5</v></c><c r="B8"><f t="shared" si="0"/><v>10</v></c><c r="D8" s="4"><v>0.256</v></c><c r="E8" s="5"><v>0.256</v></c><c r="F8" s="6"><v>150</v></c></row>' +
      '<row r="9"><c r="A9" t="s"><v>10</v></c><c r="B9"><f>SUM(B4:B8)</f><v>30</v></c><c r="C9"><f t="array" ref="C9:C9">TRANSPOSE(A4:A8)</f><v>1</v></c></row>' +
      '<row r="10"><c r="A10" t="s"><v>9</v></c><c r="B10" s="7"><v>44927.75</v></c><c r="C10" s="8" t="s"><v>3</v></c><c r="D10" s="10"><v>12.5</v></c></row>' +
      '<row r="11" ht="12" customHeight="1"><c r="B11" s="9"/><c r="D11" t="d"><v>2023-01-01T10:00:00Z</v></c></row>' +
      '<row r="12"/>',
    post:
      '<autoFilter ref="A1:B8"/>' +
      '<mergeCells count="2"><mergeCell ref="A1:A2"/><mergeCell ref="D3:F3"/></mergeCells>' +
      '<conditionalFormatting sqref="B2:B8"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>5</formula></cfRule></conditionalFormatting>' +
      '<hyperlinks><hyperlink ref="A10" r:id="rId1" tooltip="Go &amp; see"/><hyperlink ref="B10" location="Sheet2!A1" display="Sheet2!A1"/></hyperlinks>' +
      '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><drawing r:id="rId2"/>',
  });
  const sheet1Rels = HDR + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS_R}/hyperlink" Target="https://example.com/a?b=1&amp;c=2" TargetMode="External"/><Relationship Id="rId2" Type="${NS_R}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`;
  const sheet2 = sheetXml({ data: '<row r="1"><c r="A1"><v>42</v></c></row>' });
  const sheet3 = sheetXml({ data: '<row r="1"><c r="A1" t="inlineStr"><is><t>hidden</t></is></c></row>' });
  const chartsheet = HDR + `<chartsheet xmlns="${NS}" xmlns:r="${NS_R}"><sheetViews><sheetView workbookViewId="0"/></sheetViews><drawing r:id="rId1"/></chartsheet>`;
  return buildPackage({
    sheets: [
      { name: 'Data & Stuff', xml: sheet1, rels: sheet1Rels },
      { name: 'Sheet2', xml: sheet2 },
      { name: 'Hidden', state: 'hidden', xml: sheet3 },
      { name: 'VeryHidden', state: 'veryHidden', xml: sheet3 },
      { name: 'Chart1', xml: chartsheet, relType: 'chartsheet', target: 'chartsheets/sheet1.xml' },
    ],
    sst: sst(strings), styles: STYLES, theme: THEME, calcChain: HDR + `<calcChain xmlns="${NS}"><c r="B4" i="1"/></calcChain>`,
    extraFiles: {
      'xl/drawings/drawing1.xml': HDR + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>',
      'xl/charts/chart1.xml': HDR + '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>',
      'docProps/app.xml': HDR + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"/>',
    },
  });
}

// Minimal workbook from rows of plain JS values (string|number|boolean|null), strings inline-shared.
function simpleWorkbook(rows, opts) {
  opts = opts || {};
  const strs = [], idx = new Map();
  let data = '';
  rows.forEach((row, r) => {
    let cs = '';
    row.forEach((v, c) => {
      if (v === null || v === undefined) return;
      const ref = colName(c) + (r + 1);
      if (typeof v === 'string') {
        let i = idx.get(v);
        if (i === undefined) { i = strs.length; idx.set(v, i); strs.push(v); }
        cs += `<c r="${ref}" t="s"><v>${i}</v></c>`;
      } else if (typeof v === 'boolean') cs += `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
      else cs += `<c r="${ref}"><v>${v}</v></c>`;
    });
    data += `<row r="${r + 1}">${cs}</row>`;
  });
  return buildPackage({ sheets: [{ name: 'Sheet1', xml: sheetXml({ data }) }], sst: sst(strs), styles: opts.styles, theme: opts.theme, date1904: opts.date1904 });
}

// Big sheet for perf tests: numeric/string/formula mix, ~cols per row.
function bigWorkbook(rows, cols) {
  const strs = [];
  for (let i = 0; i < 1000; i++) strs.push('Item ' + i);
  const chunks = [];
  for (let r = 0; r < rows; r++) {
    let row = `<row r="${r + 1}" spans="1:${cols}">`;
    for (let c = 0; c < cols; c++) {
      const ref = colName(c) + (r + 1);
      const k = c % 5;
      if (k === 0) row += `<c r="${ref}" t="s"><v>${(r * 7 + c) % 1000}</v></c>`;
      else if (k === 1) row += `<c r="${ref}" s="2"><v>${44000 + (r % 900)}</v></c>`;
      else if (k === 2) row += `<c r="${ref}"><v>${(r * 31 + c) / 7}</v></c>`;
      else if (k === 3) row += `<c r="${ref}"><f>${colName(c - 1)}${r + 1}*2</f><v>${r}</v></c>`;
      else row += `<c r="${ref}" t="b"><v>${r & 1}</v></c>`;
    }
    chunks.push(row + '</row>');
  }
  return buildPackage({ sheets: [{ name: 'Big', xml: sheetXml({ data: chunks.join('') }) }], sst: sst(strs), styles: STYLES, theme: THEME, level: 1 });
}

module.exports = { fflate, esc, zip, colName, buildPackage, sheetXml, sst, fullWorkbook, simpleWorkbook, bigWorkbook, STYLES, THEME, HDR, NS, NS_R, ROOT_RELS, contentTypes };
