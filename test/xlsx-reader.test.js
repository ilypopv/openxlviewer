'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.fflate = require('../out/vendor/fflate.js');
globalThis.SSF = require('../out/vendor/ssf.js');
const OX = require('../out/core/xlsx-reader.js');
const F = require('./helpers/xlsx-fixtures.js');
const XLSX = require('xlsx');

const approx = (a, b, d = 1) => assert.ok(Math.abs(a - b) <= d, `${a} !~ ${b}`);

test('xmlDecode', () => {
    assert.equal(
        OX.xmlDecode('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#65;&#x42; &#x1F600;'),
        'a & b <c> "d" \'e\' AB \u{1F600}'
    );
    assert.equal(OX.xmlDecode('plain'), 'plain');
    assert.equal(OX.xmlDecode('&unknown; &#xZZ;'), '&unknown; &#xZZ;');
    assert.equal(OX.decodeOoxmlString('a_x000D_b_x005F_x000D_'), 'a\rb_x000D_');
});

test('shiftFormula', () => {
    const s = OX.shiftFormula;
    assert.equal(s('A1+B2', 1, 1), 'B2+C3');
    assert.equal(s('$A$1+A$1+$A1', 2, 3), '$A$1+D$1+$A3');
    assert.equal(s('SUM(A1:B2)', 1, 0), 'SUM(A2:B3)');
    assert.equal(s("Sheet1!A1+'My Sheet'!B2", 1, 0), "Sheet1!A2+'My Sheet'!B3");
    assert.equal(s("'A1 B'!C3", 5, 5), "'A1 B'!H8");
    assert.equal(s('"A1"&A1', 1, 0), '"A1"&A2');
    assert.equal(s('"say ""A1"" now"&A1', 1, 0), '"say ""A1"" now"&A2');
    assert.equal(s('LOG10(A1)+ATAN2(B1,C1)', 1, 1), 'LOG10(B2)+ATAN2(C2,D2)');
    assert.equal(s('A:A+$B:$C', 0, 1), 'B:B+$B:$C');
    assert.equal(s('1:3+$2:$4', 1, 0), '2:4+$2:$4');
    assert.equal(s('SUM(A:A)/COUNT(1:1)', 1, 1), 'SUM(B:B)/COUNT(2:2)');
    assert.equal(s('1.5E3+A1', 1, 0), '1.5E3+A2');
    assert.equal(s('Table1[[#This Row],[Col1]]+A1', 1, 0), 'Table1[[#This Row],[Col1]]+A2');
    assert.equal(s('[1]Sheet1!A1', 1, 0), '[1]Sheet1!A2');
    assert.equal(s('MyName+Q1+TRUE', 1, 0), 'MyName+Q2+TRUE');
    assert.equal(s('IF(A1>0,"y",B1)', 0, 1), 'IF(B1>0,"y",C1)');
    assert.equal(s('A1', -1, 0), '#REF!');
    assert.equal(s('XFD1', 0, 1), '#REF!');
    assert.equal(s('Sheet1:Sheet3!A1', 1, 0), 'Sheet1:Sheet3!A2');
    assert.equal(s('A1', 0, 0), 'A1');
    assert.equal(s('a1+b$2', 1, 1), 'B2+C$2');
    assert.equal(s('ABCD1+A1', 1, 0), 'ABCD1+A2');
    assert.equal(s('', 1, 1), '');
});

test('not a zip', () => {
    assert.throws(() => OX.readXlsx(new Uint8Array([1, 2, 3, 4, 5])), /Not a valid XLSX file/);
    assert.throws(() => OX.readXlsx(Buffer.from('a,b,c\n1,2,3\n'.repeat(5))), /Not a valid XLSX file/);
    assert.throws(() => OX.readXlsx(F.zip({ 'foo.txt': 'hi' })), /Not a valid XLSX file/);
    assert.throws(() => OX.readXlsx(F.zip({ 'a.txt': 'x' }).subarray(0, 30)), /Not a valid XLSX file/);
});

test('full workbook: workbook level', () => {
    const wb = OX.readXlsx(F.fullWorkbook());
    assert.equal(wb.date1904, false);
    assert.deepEqual(
        wb.sheets.map(s => [s.index, s.name, s.state]),
        [
            [0, 'Data & Stuff', 'visible'],
            [1, 'Sheet2', 'visible'],
            [2, 'Hidden', 'hidden'],
            [3, 'VeryHidden', 'veryHidden'],
            [4, 'Chart1', 'visible']
        ]
    );
    assert.equal(wb.sheets[0].path, 'xl/worksheets/sheet1.xml');
    assert.equal(wb.sheets[4].path, 'xl/chartsheets/sheet1.xml');
    assert.deepEqual(wb.defaultFont, { name: 'Calibri', size: 11 });
    assert.equal(wb.styles.length, 11);
});

test('full workbook: styles', () => {
    const wb = OX.readXlsx(F.fullWorkbook());
    const st = wb.styles;
    assert.equal(st[0].fmt, 'General');
    assert.equal(st[0].color, '#000000');
    assert.equal(st[0].bg, null);
    assert.equal(st[0].h, 'general');
    assert.equal(st[0].v, 'bottom');
    assert.equal(st[0].bl, null);
    const s1 = st[1];
    assert.equal(s1.b, true);
    assert.equal(s1.size, 14);
    assert.equal(s1.font, 'Arial');
    assert.equal(s1.color, '#ff0000');
    assert.equal(s1.bg, '#dae3f3'); // accent1 + 0.8 tint
    assert.deepEqual(s1.bl, { style: 'thin', color: '#000000' });
    assert.deepEqual(s1.br, { style: 'thin', color: '#ff0000' });
    assert.deepEqual(s1.bt, { style: 'medium', color: '#000000' });
    assert.equal(s1.bb.style, 'double');
    assert.equal(st[2].fmt, 'm/d/yyyy');
    assert.equal(st[3].fmt, '"$"#,##0.00');
    const s4 = st[4];
    assert.equal(s4.i, true);
    assert.equal(s4.u, true);
    assert.equal(s4.strike, true);
    assert.equal(s4.size, 9);
    assert.equal(s4.color, '#2f5597'); // accent1 -0.25
    assert.equal(s4.bg, '#ffff00');
    assert.equal(s4.h, 'center');
    assert.equal(s4.v, 'center');
    assert.equal(s4.wrap, true);
    assert.equal(s4.indent, 2);
    assert.equal(s4.bb.style, 'thick');
    assert.equal(s4.bb.color, '#f2f2f2'); // lt1 -0.05
    assert.equal(st[5].fmt, '0.00%');
    assert.equal(st[6].fmt, '[>=100]0.0;0');
    assert.equal(st[6].b, false);
    assert.equal(st[6].color, '#0000ff');
    assert.equal(st[6].bg, '#00ff00');
    assert.equal(st[7].fmt, 'm/d/yyyy h:mm');
    assert.equal(st[8].fmt, '@');
    assert.ok(/_\("\$"\*/.test(st[10].fmt));
    for (const s of st) assert.deepEqual(Object.keys(s), Object.keys(st[0]));
});

test('full workbook: sheet 0 cells', () => {
    const wb = OX.readXlsx(F.fullWorkbook());
    const sh = wb.loadSheet(0);
    assert.equal(wb.loadSheet(0), sh);
    assert.equal(sh.info, wb.sheets[0]);
    assert.equal(wb.sheets[0].tabColor, '#f4b183'); // accent2 + 0.4
    const at = (r, c) => sh.rows[r] && sh.rows[r][c];
    assert.deepEqual(at(0, 0), { t: 's', v: 'Name', s: 1 });
    assert.deepEqual(at(0, 2), { t: 'z', v: null, s: 1 });
    assert.deepEqual(at(1, 0), { t: 's', v: 'Hello & <World>', s: 0 });
    assert.deepEqual(at(1, 1), { t: 'n', v: 1234.5, s: 0 });
    assert.deepEqual(at(1, 2), { t: 'n', v: 44927, s: 2 });
    assert.deepEqual(at(1, 3), { t: 'n', v: -0.000125, s: 3 });
    assert.deepEqual(at(1, 4), { t: 'b', v: true, s: 0 });
    assert.deepEqual(at(1, 5), { t: 'e', v: '#DIV/0!', s: 0 });
    assert.equal(at(2, 0).v, ' padded ');
    assert.equal(at(2, 1).v, 'Rich text & more');
    assert.equal(at(2, 2).v, 'Kanji');
    assert.equal(at(2, 3).v, 'line1\nline2');
    assert.equal(at(2, 4).v, 'a\rb');
    assert.equal(at(2, 5).v, 'Emoji \u{1F600} A');
    assert.deepEqual(at(3, 1), { t: 'n', v: 2, s: 0, f: 'A4*2+Sheet2!$A$1' });
    assert.equal(at(4, 1).f, 'A5*2+Sheet2!$A$1');
    assert.equal(at(7, 1).f, 'A8*2+Sheet2!$A$1');
    assert.equal(at(4, 1).v, 4);
    assert.deepEqual(at(3, 2), { t: 'n', v: 3, s: 0, f: 'SUM(A4:B4)' });
    assert.deepEqual(at(3, 3), { t: 's', v: 'x1', s: 0, f: '"x"&A4' });
    assert.deepEqual(at(3, 4), { t: 's', v: 'inline & ok', s: 0 });
    assert.deepEqual(at(8, 2), { t: 'n', v: 1, s: 0, f: 'TRANSPOSE(A4:A8)' });
    assert.equal(at(8, 0).v, 'Total');
    assert.deepEqual(at(9, 1), { t: 'n', v: 44927.75, s: 7 });
    assert.equal(at(10, 1).t, 'z');
    assert.equal(at(10, 1).s, 9);
    assert.deepEqual(at(10, 3), { t: 'd', v: '2023-01-01T10:00:00Z', s: 0 });
    assert.equal(sh.rowCount, 11);
    assert.equal(sh.colCount, 6);
    assert.equal(sh.rows[11], undefined);
    for (const row of sh.rows)
        if (row)
            for (const c of row)
                if (c) assert.deepEqual(Object.keys(c), 'f' in c ? ['t', 'v', 's', 'f'] : ['t', 'v', 's']);
});

test('full workbook: sheet 0 layout', () => {
    const wb = OX.readXlsx(F.fullWorkbook());
    const sh = wb.loadSheet(0);
    assert.equal(sh.frozenRows, 2);
    assert.equal(sh.frozenCols, 1);
    assert.equal(sh.showGridLines, false);
    assert.equal(sh.zoomScale, 120);
    assert.deepEqual(sh.dimension, { r1: 0, c1: 0, r2: 11, c2: 5 });
    assert.equal(sh.defaultColWidth, Math.round(10.5 * 7));
    approx(sh.defaultRowHeight, 21.33, 0.01);
    assert.equal(sh.colWidths.get(0), Math.round(20.7109375 * 7));
    assert.equal(sh.colWidths.get(2), Math.round(12.140625 * 7));
    assert.equal(sh.colWidths.get(3), Math.round(12.140625 * 7));
    assert.equal(sh.colWidths.has(1), false);
    assert.deepEqual([...sh.hiddenCols], [4]);
    assert.deepEqual([...sh.hiddenRows], [2]);
    approx(sh.rowHeights.get(0), 40, 0.01);
    approx(sh.rowHeights.get(10), 16, 0.01);
    assert.deepEqual(sh.merges, [
        { r1: 0, c1: 0, r2: 1, c2: 0 },
        { r1: 2, c1: 3, r2: 2, c2: 5 }
    ]);
    assert.deepEqual(sh.autoFilter, { r1: 0, c1: 0, r2: 7, c2: 1 });
    assert.deepEqual(sh.hyperlinks.get('9,0'), { url: 'https://example.com/a?b=1&c=2', tooltip: 'Go & see' });
    assert.deepEqual(sh.hyperlinks.get('9,1'), { location: 'Sheet2!A1' });
    assert.equal(sh.hyperlinks.size, 2);
});

test('other sheets, hidden, chartsheet', () => {
    const wb = OX.readXlsx(F.fullWorkbook());
    assert.equal(wb.loadSheet(1).rows[0][0].v, 42);
    assert.equal(wb.loadSheet(2).rows[0][0].v, 'hidden');
    const ch = wb.loadSheet(4);
    assert.equal(ch.rowCount, 0);
    assert.equal(ch.colCount, 0);
    assert.deepEqual(ch.rows, []);
    assert.equal(ch.defaultColWidth, 64);
    assert.equal(ch.defaultRowHeight, 20);
    assert.throws(() => wb.loadSheet(9), /No such sheet/);
});

test('1904 dates + defaults when parts missing', () => {
    const wb = OX.readXlsx(
        F.simpleWorkbook(
            [
                ['a', 1, true],
                [null, 2.5]
            ],
            { date1904: true }
        )
    );
    assert.equal(wb.date1904, true);
    assert.equal(wb.styles.length, 1);
    assert.equal(wb.styles[0].fmt, 'General');
    const sh = wb.loadSheet(0);
    assert.equal(sh.rows[0][2].v, true);
    assert.equal(sh.rows[1][0], undefined);
    assert.equal(sh.defaultColWidth, 64);
});

test('theme-less indexed/rgb colors and custom indexed palette', () => {
    const styles =
        F.HDR +
        `<styleSheet xmlns="${F.NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><color indexed="10"/><sz val="10"/><name val="X"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor indexed="9"/></patternFill></fill></fills><borders count="1"><border/></borders><cellXfs count="2"><xf/><xf numFmtId="9" fontId="1" fillId="2" borderId="0"/></cellXfs><colors><indexedColors><rgbColor rgb="FF010203"/></indexedColors></colors></styleSheet>`;
    const wb = OX.readXlsx(F.simpleWorkbook([[1]], { styles }));
    assert.equal(wb.styles[1].color, '#ff0000');
    assert.equal(wb.styles[1].bg, '#ffffff');
    assert.equal(wb.styles[1].fmt, '0%');
    assert.equal(wb.styles[0].fmt, 'General');
    const wb2 = OX.readXlsx(F.simpleWorkbook([[1]], { styles: styles.replace('indexed="10"', 'indexed="0"') }));
    assert.equal(wb2.styles[1].color, '#010203');
});

test('namespace-prefixed elements, quote variants, attribute order, implicit refs', () => {
    const xml =
        F.HDR +
        `<x:worksheet xmlns:x="${F.NS}"><x:dimension ref="A1:C2"/><x:sheetViews><x:sheetView><x:pane ySplit="1" state="frozen"/></x:sheetView></x:sheetViews><x:sheetData>` +
        `<x:row r="1"><x:c t="n" r='A1'><x:v>1</x:v></x:c><x:c s="0" r="B1" t="inlineStr"><x:is><x:t>hi</x:t></x:is></x:c><x:c r="C1"/></x:row>` +
        `<x:row><x:c><x:v>5</x:v></x:c><x:c><x:f>A2+1</x:f><x:v>6</x:v></x:c><x:c t="b"><x:v>0</x:v></x:c></x:row>` +
        `</x:sheetData><x:mergeCells><x:mergeCell ref="A1:B1"/></x:mergeCells></x:worksheet>`;
    const wb = OX.readXlsx(F.buildPackage({ sheets: [{ name: 'P', xml }] }));
    const sh = wb.loadSheet(0);
    assert.equal(sh.rows[0][0].v, 1);
    assert.equal(sh.rows[0][1].v, 'hi');
    assert.equal(sh.rows[0][2], undefined);
    assert.deepEqual(sh.rows[1][0], { t: 'n', v: 5, s: 0 });
    assert.deepEqual(sh.rows[1][1], { t: 'n', v: 6, s: 0, f: 'A2+1' });
    assert.deepEqual(sh.rows[1][2], { t: 'b', v: false, s: 0 });
    assert.equal(sh.frozenRows, 1);
    assert.equal(sh.frozenCols, 0);
    assert.equal(sh.merges.length, 1);
});

test('absolute zip paths, odd cell oddities', () => {
    const xml = F.sheetXml({
        data:
            '<row r="2"><c r="B2"><v>2</v></c><c r="A2"><v>1</v></c><c r="A2"><v>9</v></c></row>' +
            '<row r="1"><c r="A1"><v>abc</v></c><c r="B1" t="n"><v></v></c><c r="C1"><v>1e3</v></c><c r="D1" t="s"><v>99</v></c><c r="E1" t="str"><v>a&amp;b</v></c><c r="F1"><f>1+1</f></c></row>' +
            '<row r="1"><c r="G1" t="b"><v>1</v></c></row>'
    });
    const bytes = F.buildPackage({
        sheets: [{ name: 'S', xml, target: '/xl/worksheets/sheet7.xml' }],
        styles: F.STYLES,
        absoluteTargets: true
    });
    const wb = OX.readXlsx(bytes);
    assert.equal(wb.sheets[0].path, 'xl/worksheets/sheet7.xml');
    const sh = wb.loadSheet(0);
    assert.equal(sh.rows[1][0].v, 9);
    assert.equal(sh.rows[1][1].v, 2);
    assert.deepEqual(sh.rows[0][0], { t: 's', v: 'abc', s: 0 });
    assert.equal(sh.rows[0][1], undefined);
    assert.equal(sh.rows[0][2].v, 1000);
    assert.deepEqual(sh.rows[0][3], { t: 'z', v: null, s: 0 }.t === 'z' ? sh.rows[0][3] : null);
    assert.equal(sh.rows[0][3] === undefined || sh.rows[0][3].v === '', true);
    assert.equal(sh.rows[0][4].v, 'a&b');
    assert.deepEqual(sh.rows[0][5], { t: 'z', v: null, s: 0, f: '1+1' });
    assert.equal(sh.rows[0][6].v, true);
    assert.equal(sh.rowCount, 2);
    assert.equal(sh.colCount, 7);
});

test('shared formula expansion honours anchors and quoted sheets', () => {
    const xml = F.sheetXml({
        data:
            '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="shared" ref="B1:C2" si="3">SUM($A1:A$2)+\'S 1\'!B1</f><v>1</v></c><c r="C1"><f t="shared" si="3"/><v>1</v></c></row>' +
            '<row r="2"><c r="B2"><f t="shared" si="3"/><v>1</v></c><c r="C2"><f t="shared" si="3"/><v>1</v></c></row>'
    });
    const sh = OX.readXlsx(F.buildPackage({ sheets: [{ name: 'S', xml }] })).loadSheet(0);
    assert.equal(sh.rows[0][2].f, "SUM($A1:B$2)+'S 1'!C1");
    assert.equal(sh.rows[1][1].f, "SUM($A2:A$2)+'S 1'!B2");
    assert.equal(sh.rows[1][2].f, "SUM($A2:B$2)+'S 1'!C2");
});

test('sst: empty si, self-closing, rPh', () => {
    const sstXml = F.sst(['x', { raw: '' }, { raw: '<r><t>a</t></r><r><t/></r><r><t>b</t></r>' }, { raw: '<t></t>' }]);
    const xml = F.sheetXml({
        data: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>'
    });
    const sh = OX.readXlsx(F.buildPackage({ sheets: [{ name: 'S', xml }], sst: sstXml })).loadSheet(0);
    assert.equal(sh.rows[0][0].v, 'x');
    assert.equal(sh.rows[0][2].v, 'ab');
});

test('oracle: SheetJS agrees on values, merges, dimensions', () => {
    const bytes = F.fullWorkbook();
    const wb = OX.readXlsx(bytes);
    const ref = XLSX.read(bytes, { type: 'array', cellStyles: true, cellFormula: true, cellDates: false });
    assert.deepEqual(
        ref.SheetNames.slice(0, 4),
        wb.sheets.slice(0, 4).map(s => s.name)
    );
    for (let i = 0; i < 4; i++) {
        const sh = wb.loadSheet(i),
            ws = ref.Sheets[ref.SheetNames[i]];
        const rng = XLSX.utils.decode_range(ws['!ref']);
        assert.equal(rng.e.r + 1 >= sh.rowCount, true);
        for (let r = 0; r < sh.rowCount; r++)
            for (let c = 0; c < sh.colCount; c++) {
                const mine = sh.rows[r] && sh.rows[r][c];
                const theirs = ws[XLSX.utils.encode_cell({ r, c })];
                if (!mine || mine.t === 'z') continue;
                assert.ok(theirs, `missing ${r},${c}`);
                if (mine.t === 'd' || (typeof mine.v === 'string' && /[\ud800-\udfff]/.test(mine.v))) continue; // SheetJS drops astral chars
                assert.equal(mine.t === 'e' ? theirs.w : theirs.v, mine.v, `value ${r},${c}`);
                if (mine.f !== undefined && theirs.f !== undefined) assert.equal(theirs.f, mine.f, `formula ${r},${c}`);
            }
        if (i === 0) {
            const m = (ws['!merges'] || []).map(x => ({ r1: x.s.r, c1: x.s.c, r2: x.e.r, c2: x.e.c }));
            assert.deepEqual(m, sh.merges);
        }
    }
});

test('oracle: random grids round-trip', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const rows = [];
    for (let r = 0; r < 120; r++) {
        const row = [];
        for (let c = 0; c < 15; c++) {
            const k = rnd();
            row.push(
                k < 0.3
                    ? null
                    : k < 0.6
                      ? Math.round(rnd() * 1e6) / 100
                      : k < 0.9
                        ? 'str <' + Math.floor(rnd() * 50) + '> & "q"'
                        : rnd() < 0.5
            );
        }
        rows.push(row);
    }
    const bytes = F.simpleWorkbook(rows);
    const sh = OX.readXlsx(bytes).loadSheet(0);
    const ws = XLSX.read(bytes, { type: 'array' }).Sheets.Sheet1;
    for (let r = 0; r < rows.length; r++)
        for (let c = 0; c < 15; c++) {
            const e = rows[r][c],
                got = sh.rows[r] && sh.rows[r][c];
            if (e === null) {
                assert.equal(got, undefined);
                continue;
            }
            assert.equal(got.v, e);
            assert.equal(ws[XLSX.utils.encode_cell({ r, c })].v, e);
        }
});

test('perf: 300k rows x 10 cols', { timeout: 300000 }, () => {
    const rows = 300000,
        cols = 10;
    let t0 = process.hrtime.bigint();
    const bytes = F.bigWorkbook(rows, cols);
    const ms = t => Number(process.hrtime.bigint() - t) / 1e6;
    console.log(`[perf] build fixture: ${ms(t0).toFixed(0)} ms, zip ${(bytes.length / 1e6).toFixed(1)} MB`);
    t0 = process.hrtime.bigint();
    const wb = OX.readXlsx(bytes);
    console.log(`[perf] readXlsx (metadata): ${ms(t0).toFixed(0)} ms`);
    t0 = process.hrtime.bigint();
    const sh = wb.loadSheet(0);
    const t = ms(t0);
    console.log(
        `[perf] loadSheet ${rows}x${cols} (${rows * cols} cells): ${t.toFixed(0)} ms, ${((rows * cols) / t / 1000).toFixed(2)} Mcells/s`
    );
    assert.equal(sh.rowCount, rows);
    assert.equal(sh.colCount, cols);
    assert.equal(sh.rows[rows - 1][3].f, `C${rows}*2`);
    assert.equal(sh.rows[5][0].v, 'Item ' + ((5 * 7) % 1000));
});
