'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.SSF = require('../out/vendor/ssf.js');
const OX = require('../out/core/calc.js');
const { Calc } = OX;

// ---- in-memory store (rows[r][c] = cell)
function cellOf(x) {
  if (x === undefined || x === null) return undefined;
  if (typeof x === 'object') return x;
  if (typeof x === 'number') return { t: 'n', v: x, s: 0 };
  if (typeof x === 'boolean') return { t: 'b', v: x, s: 0 };
  if (typeof x === 'string') {
    if (x[0] === '=') return { t: 'n', v: 0, f: x.slice(1), s: 0 };
    if (x[0] === '#') return { t: 'e', v: x, s: 0 };
    return { t: 's', v: x, s: 0 };
  }
}
class Store {
  constructor(sheets, opts) {
    this.sheetNames = Object.keys(sheets); this.date1904 = !!(opts && opts.date1904);
    this.now = opts && opts.now;
    this.rows = this.sheetNames.map((n) => {
      const rows = [];
      for (const [addr, val] of Object.entries(sheets[n])) {
        const m = /^([A-Z]+)(\d+)$/.exec(addr); let c = 0;
        for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
        const r = +m[2] - 1; c -= 1;
        (rows[r] || (rows[r] = []))[c] = cellOf(val);
      }
      return rows;
    });
  }
  sheetIndexByName(n) { const l = n.toLowerCase(); return this.sheetNames.findIndex((x) => x.toLowerCase() === l); }
  getCell(s, r, c) { const row = this.rows[s] && this.rows[s][r]; return row ? row[c] : undefined; }
  setCell(s, r, c, x) { const rows = this.rows[s]; (rows[r] || (rows[r] = []))[c] = cellOf(x); }
  getExtent(s) { const rows = this.rows[s]; let cols = 0; for (const r of rows) if (r && r.length > cols) cols = r.length; return { rowCount: rows.length, colCount: cols }; }
  forEachCell(s, r1, c1, r2, c2, cb) {
    const rows = this.rows[s]; const re = Math.min(r2, rows.length - 1);
    for (let r = r1; r <= re; r++) { const row = rows[r]; if (!row) continue; const ce = Math.min(c2, row.length - 1); for (let c = c1; c <= ce; c++) { const cell = row[c]; if (cell !== undefined) cb(r, c, cell); } }
  }
}
const FIX = {
  Sheet1: {
    A1: 10, A2: 20, A3: 30, A4: 40, A5: 50,
    B1: 'apple', B2: 'banana', B3: 'cherry', B4: 'apricot', B5: 'Blueberry',
    C1: 1, C2: 'x', C3: true, C5: 5,
    D1: 1, D2: 2, D3: 3, D4: '4',
    E1: '#DIV/0!', F1: 'a', F2: 'b', F3: 'a', F4: 'c', G1: 1, G2: 2, G3: 3, G4: 4,
    H1: 'text', H2: '', I1: 3.5, I2: -2.5, I3: 0,
  },
  'My Sheet': { A1: 100, B1: 'it\'s' },
};
function ev(f, sheets, opts) {
  const st = new Store(sheets || FIX, opts); const c = new Calc(st);
  const r = c.evaluate(0, 20, 20, f);
  return r;
}
const val = (f, sheets, opts) => { const r = ev(f, sheets, opts); return r.v; };
function close(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-9) * Math.max(1, Math.abs(b)); }
function table(name, rows, sheets, opts) {
  test(name, () => {
    for (const [f, exp] of rows) {
      const r = ev(f, sheets, opts);
      if (typeof exp === 'number' && !Number.isInteger(exp)) assert.ok(r.t === 'n' && close(r.v, exp), `${f} => ${JSON.stringify(r)} expected ${exp}`);
      else assert.equal(r.v, exp, `${f} => ${JSON.stringify(r)} expected ${exp}`);
    }
  });
}

table('operators and precedence', [
  ['1+2*3', 7], ['(1+2)*3', 9], ['-2^2', 4], ['2^-1', 0.5], ['2^3^2', 64], ['-2^2+1', 5], ['10-2-3', 5], ['2*3%', 0.06], ['50%', 0.5],
  ['100/3*3', 100], ['1/0', '#DIV/0!'], ['0/0', '#DIV/0!'], ['0^0', '#NUM!'], ['(-8)^(1/3)', '#NUM!'], ['0^-1', '#DIV/0!'], ['2^0.5', Math.SQRT2],
  ['"a"&"b"', 'ab'], ['1&2', '12'], ['1.5&""', '1.5'], ['TRUE&"x"', 'TRUEx'], ['"a"&1+2', 'a3'], ['1+2&3', '33'],
  ['--5', 5], ['+5', 5], ['-"3"', -3], ['"3"+4', 7], ['"3.5"*2', 7], ['" 3 "+1', 4], ['TRUE+1', 2], ['"a"+1', '#VALUE!'], ['""+1', '#VALUE!'],
  ['"5%"+1', 1.05], ['"1,000"+1', 1001], ['1=1', true], ['1<>1', false], ['1<2', true], ['2<=2', true], ['3>=4', false],
  ['"a"="A"', true], ['"a"<"B"', true], ['"b">"A"', true], ['"a"<1', false], ['"a">1', true], ['TRUE>5', true], ['TRUE>"z"', true], ['1=TRUE', false],
  ['A99=0', true], ['A99=""', true], ['A99=FALSE', true], ['A99<1', true], ['"abc"="abc"', true], ['1+(2', '#NAME?'], ['0.1+0.2=0.3', true], ['0.1+0.2-0.3', 0], ['1.1-1=0.1', true], ['0.1+0.2>0.3', false], ['1E-20+1E-21=0', false],
  ['1E3', 1000], ['1.5e-3', 0.0015], ['.5+.5', 1], ['#N/A', '#N/A'], ['#DIV/0!+1', '#DIV/0!'], ['1+#N/A', '#N/A'], ['#N/A+#DIV/0!', '#N/A'],
  ['"x"&E1', '#DIV/0!'], ['E1=1', '#DIV/0!'], ['-E1', '#DIV/0!'], ['SUMPRODUCT(--(A1:A3=10))', 1], ['A1:A3=10', '#VALUE!'], ['5 5', '#NAME?'], ['(1+2)%', 0.03], ['2^2%', 2 ** 0.02],
  ['1=1=TRUE', true], ['"10"<"9"', true], ['10<"9"', true], ['1<2<3', false], ['9.99999999999999e307*10', '#NUM!'], ['"1/2/2020"+0', 43832], ['"2020-01-15"+0', 43845],
  ['"12:00"+0', 0.5],
]);

table('references, ranges, sheets', [
  ['A1', 10], ['$A$1', 10], ['A$1+$A2', 30], ['SUM(A1:A5)', 150], ['SUM(A5:A1)', 150], ['SUM(A1:B5)', 150], ['SUM(A:A)', 150], ['SUM(2:2)', 21.5], ['SUM(1:1)', '#DIV/0!'],
  ["'My Sheet'!A1", 100], ["'My Sheet'!A1+A1", 110], ["SUM('My Sheet'!A1:B1)", 100], ["'my sheet'!a1", 100], ['Nope!A1', '#REF!'], ["'it''s'!A1", '#REF!'],
  ['Sheet1!A2', 20], ['SUM(sheet1!$A$2:$A$3)', 50], ['SUM(Sheet1!A1:Sheet1!A3)', 60], ['B1', 'apple'], ['ZZ9', 0], ['A1:A2', '#VALUE!'],
  ['SUM(A1:A3,10)', 70], ['SUM(A1:INDEX(A1:A5,3))', 60], ['SUM(INDEX(A1:A5,2):A4)', 90], ['Foo', '#NAME?'], ['Table1[Col]', '#NAME?'], ['XFD1', 0], ['XFE1', '#NAME?'],
  ['COUNT(A1:A5)', 5], ['ROW(A5)', 5], ['COLUMN(C1)', 3], ['ROW()', 21], ['COLUMN()', 21], ['ROWS(A1:A5)', 5], ['COLUMNS(A1:C1)', 3], ['ROWS(A:A)', 1048576], ['ROW(B2:B4)', 2],
]);

table('arithmetic and rounding functions', [
  ['ABS(-3)', 3], ['ABS("-2")', 2], ['ABS(A99)', 0], ['ROUND(2.5,0)', 3], ['ROUND(-2.5,0)', -3], ['ROUND(1.005,2)', 1.01], ['ROUND(2.675,2)', 2.68], ['ROUND(1234.567,-2)', 1200], ['ROUND(0.5,0)', 1],
  ['ROUND(1.45,1)', 1.5], ['ROUND(-1.45,1)', -1.5], ['ROUND(5,-1)', 10], ['ROUND(4.9,-1)', 0], ['ROUND(3.14159,3)', 3.142], ['ROUNDUP(2.1,0)', 3], ['ROUNDUP(-2.1,0)', -3], ['ROUNDUP(3.14159,2)', 3.15],
  ['ROUNDDOWN(2.9,0)', 2], ['ROUNDDOWN(-2.9,0)', -2], ['ROUNDDOWN(3.14159,2)', 3.14], ['ROUNDUP(1234,-2)', 1300], ['INT(2.9)', 2], ['INT(-2.1)', -3], ['TRUNC(-2.9)', -2], ['TRUNC(3.789,1)', 3.7], ['TRUNC(-3.789,2)', -3.78],
  ['MOD(10,3)', 1], ['MOD(-10,3)', 2], ['MOD(10,-3)', -2], ['MOD(-10,-3)', -1], ['MOD(5,0)', '#DIV/0!'], ['MOD(5.5,2)', 1.5], ['MOD(3,3)', 0],
  ['POWER(2,10)', 1024], ['POWER(2,-1)', 0.5], ['POWER(0,0)', '#NUM!'], ['SQRT(16)', 4], ['SQRT(-1)', '#NUM!'], ['EXP(0)', 1], ['EXP(1)', Math.E], ['LN(1)', 0], ['LN(0)', '#NUM!'], ['LN(-1)', '#NUM!'],
  ['LOG(100)', 2], ['LOG(8,2)', 3], ['LOG(1,1)', '#DIV/0!'], ['LOG(0)', '#NUM!'], ['LOG10(1000)', 3], ['CEILING(2.5,1)', 3], ['CEILING(-2.5,2)', -2], ['CEILING(-2.5,-2)', -4], ['CEILING(2.5,-1)', '#NUM!'], ['CEILING(5,0)', 0],
  ['CEILING(0.234,0.01)', 0.24], ['FLOOR(2.5,1)', 2], ['FLOOR(-2.5,2)', -4], ['FLOOR(-2.5,-2)', -2], ['FLOOR(5,0)', '#DIV/0!'], ['FLOOR(3.7,2)', 2], ['SIGN(-5)', -1], ['SIGN(0)', 0], ['SIGN(9)', 1],
  ['PI()', Math.PI], ['CEILING.MATH(-2.5)', -2], ['CEILING.MATH(-2.5,1,1)', -3], ['FLOOR.MATH(-2.5)', -3], ['FLOOR.MATH(-2.5,1,1)', -2], ['FLOOR.MATH(2.5)', 2], ['MROUND(10,3)', 9], ['MROUND(-10,-3)', -9], ['MROUND(10,-3)', '#NUM!'],
  ['EVEN(3)', 4], ['EVEN(-1)', -2], ['ODD(2)', 3], ['ODD(-2)', -3], ['QUOTIENT(7,2)', 3], ['QUOTIENT(-7,2)', -3], ['FACT(5)', 120], ['FACT(0)', 1], ['FACT(-1)', '#NUM!'], ['COMBIN(5,2)', 10], ['GCD(12,18)', 6], ['LCM(4,6)', 12],
  ['SIN(0)', 0], ['COS(0)', 1], ['ATAN2(1,1)', Math.PI / 4], ['DEGREES(PI())', 180], ['RADIANS(180)', Math.PI], ['ASIN(2)', '#NUM!'], ['ISEVEN(4)', true], ['ISODD(4)', false],
  ['ROUND("a",1)', '#VALUE!'], ['ROUND(E1,1)', '#DIV/0!'], ['ABS()', '#VALUE!'],
]);

table('SUM / aggregates / stats', [
  ['SUM(1,2,3)', 6], ['SUM()', '#VALUE!'], ['SUM(A1:A5)', 150], ['SUM(C1:C5)', 6], ['SUM(C1:C3)', 1], ['SUM(TRUE,TRUE)', 2], ['SUM("3",4)', 7], ['SUM("a",4)', '#VALUE!'], ['SUM(E1)', '#DIV/0!'], ['SUM(A1:E1)', '#DIV/0!'], ['SUM({1,2;3,4})', 10],
  ['SUM(D1:D4)', 6], ['SUM(A1,,2)', 12], ['PRODUCT(1,2,3,4)', 24], ['PRODUCT(A1:A2)', 200], ['PRODUCT(B1:B2)', 0], ['SUMSQ(3,4)', 25],
  ['AVERAGE(A1:A5)', 30], ['AVERAGE(1,"3")', 2], ['AVERAGE(B1:B2)', '#DIV/0!'], ['AVERAGE(C1:C5)', 3], ['AVERAGE(TRUE,3)', 2], ['AVERAGE(D1:D4)', 2],
  ['MIN(A1:A5)', 10], ['MAX(A1:A5)', 50], ['MIN(B1:B2)', 0], ['MAX(B1:B2)', 0], ['MAX(1,TRUE)', 1], ['MIN(-1,"2")', -1], ['MAX(C1:C3)', 1], ['MIN(E1,1)', '#DIV/0!'], ['MAX(A1:A2,100)', 100],
  ['COUNT(A1:A5,B1:B5)', 5], ['COUNT(C1:C5)', 2], ['COUNT(1,"2","x",TRUE)', 3], ['COUNT(E1)', 0], ['COUNTA(A1:C5)', 14], ['COUNTA(1,"")', 2], ['COUNTA(H2)', 1], ['COUNTA(A99)', 0], ['COUNTBLANK(C1:C5)', 1], ['COUNTBLANK(H1:H3)', 2], ['COUNTBLANK(A99)', 1],
  ['MEDIAN(1,2,3,4)', 2.5], ['MEDIAN(5,1,3)', 3], ['MEDIAN(A1:A5)', 30], ['MEDIAN(B1)', '#NUM!'], ['STDEV.S(2,4,4,4,5,5,7,9)', Math.sqrt(32 / 7)], ['STDEV.P(2,4,4,4,5,5,7,9)', 2], ['VAR.S(1,2,3,4)', 5 / 3], ['VAR.P(1,2,3,4)', 1.25], ['STDEV(1)', '#DIV/0!'], ['VAR.P(5)', 0], ['STDEV.P(5)', 0],
  ['LARGE(A1:A5,1)', 50], ['LARGE(A1:A5,5)', 10], ['LARGE(A1:A5,6)', '#NUM!'], ['SMALL(A1:A5,2)', 20], ['SMALL(A1:A5,0)', '#NUM!'], ['LARGE({3,1,2},2)', 2],
  ['RANK(30,A1:A5)', 3], ['RANK(30,A1:A5,1)', 3], ['RANK(50,A1:A5)', 1], ['RANK(35,A1:A5)', '#N/A'], ['RANK.EQ(10,A1:A5,1)', 1], ['MODE.SNGL(1,2,2,3,3,3)', 3], ['MODE.SNGL(1,2,3)', '#N/A'], ['MODE(1,1,2,2)', 1],
  ['SUMPRODUCT(A1:A3,D1:D3)', 140], ['SUMPRODUCT(A1:A3)', 60], ['SUMPRODUCT((A1:A5>20)*(A1:A5<50))', 2], ['SUMPRODUCT((A1:A5>20)*A1:A5)', 120], ['SUMPRODUCT(A1:A3,D1:D2)', '#VALUE!'], ['SUMPRODUCT(--(B1:B5="apple"))', 1], ['SUMPRODUCT({1,2,3},{4,5,6})', 32],
  ['SUMPRODUCT(ABS(I1:I3))', 6], ['SUMPRODUCT(A1:A5*2)', 300],
]);

table('conditional aggregates', [
  ['SUMIF(A1:A5,">20")', 120], ['SUMIF(A1:A5,">=20")', 140], ['SUMIF(A1:A5,"<20")', 10], ['SUMIF(A1:A5,"<>30")', 120], ['SUMIF(A1:A5,30)', 30], ['SUMIF(A1:A5,"=30")', 30], ['SUMIF(B1:B5,"a*",A1:A5)', 50], ['SUMIF(B1:B5,"apple",A1:A5)', 10],
  ['SUMIF(B1:B5,"APPLE",A1:A5)', 10], ['SUMIF(B1:B5,"*e",A1:A5)', 10], ['SUMIF(B1:B5,"*y",A1:A5)', 80], ['SUMIF(B1:B5,"?pple",A1:A5)', 10], ['SUMIF(B1:B5,"b*",A1:A5)', 20 + 50], ['SUMIF(F1:F4,"a",G1:G4)', 4], ['SUMIF(F1:F4,"<>a",G1:G4)', 6],
  ['COUNTIF(A1:A5,">=30")', 3], ['COUNTIF(B1:B5,"a*")', 2], ['COUNTIF(B1:B5,"*an*")', 1], ['COUNTIF(B1:B5,"<>apple")', 4], ['COUNTIF(F1:F4,"a")', 2], ['COUNTIF(F1:F4,F1)', 2], ['COUNTIF(D1:D4,4)', 1], ['COUNTIF(D1:D4,"4")', 1],
  ['COUNTIF(D1:D4,">1")', 2], ['COUNTIF(C1:C5,TRUE)', 1], ['COUNTIF(C1:C5,"")', 1], ['COUNTIF(H1:H3,"")', 2], ['COUNTIF(H1:H3,"<>")', 1], ['COUNTIF(C1:C5,"<>x")', 4], ['COUNTIF(E1,"#DIV/0!")', 1], ['COUNTIF(B1:B5,"~*")', 0],
  ['COUNTIFS(A1:A5,">10",A1:A5,"<50")', 3], ['COUNTIFS(F1:F4,"a",G1:G4,">1")', 1], ['COUNTIFS(F1:F4,"a")', 2], ['COUNTIFS(A1:A5,">10",G1:G3,"1")', '#VALUE!'],
  ['SUMIFS(A1:A5,A1:A5,">10",A1:A5,"<50")', 90], ['SUMIFS(G1:G4,F1:F4,"a")', 4], ['SUMIFS(G1:G4,F1:F4,"a",G1:G4,">1")', 3], ['SUMIFS(G1:G4,F1:F4,"zz")', 0],
  ['AVERAGEIF(A1:A5,">20")', 40], ['AVERAGEIF(A1:A5,">100")', '#DIV/0!'], ['AVERAGEIFS(G1:G4,F1:F4,"a")', 2], ['MINIFS(G1:G4,F1:F4,"a")', 1], ['MAXIFS(G1:G4,F1:F4,"a")', 3], ['MAXIFS(G1:G4,F1:F4,"zz")', 0],
  ['SUMIF(A1:A5,">"&A2)', 120], ['SUMIF(C1:C5,">0")', 6], ['SUMIF(A:A,">=40")', 90], ['COUNTIF(A:A,">0")', 5], ['SUMIF(E1:E2,"#DIV/0!")', '#DIV/0!'],
]);

table('logical functions', [
  ['IF(TRUE,1,2)', 1], ['IF(0,1,2)', 2], ['IF(FALSE,1)', false], ['IF("a",1,2)', '#VALUE!'], ['IF("TRUE",1,2)', 1], ['IF(E1,1,2)', '#DIV/0!'], ['IF(1,,2)', 0], ['IF(TRUE,1,1/0)', 1], ['IF(FALSE,1/0,2)', 2], ['IF(A99,1,2)', 2],
  ['IFERROR(1/0,"x")', 'x'], ['IFERROR(5,"x")', 5], ['IFERROR(E1,"z")', 'z'], ['IFERROR(NA(),0)', 0], ['IFNA(NA(),7)', 7], ['IFNA(1/0,7)', '#DIV/0!'], ['IFNA(3,7)', 3],
  ['IFS(FALSE,1,TRUE,2)', 2], ['IFS(FALSE,1)', '#N/A'], ['IFS(A1>5,"big",TRUE,"small")', 'big'],
  ['AND(TRUE,1)', true], ['AND(TRUE,0)', false], ['AND(A1:A3)', true], ['AND(C1:C5)', true], ['AND("a")', '#VALUE!'], ['AND(B1:B2)', '#VALUE!'], ['AND("TRUE",TRUE)', true], ['AND(E1,FALSE)', '#DIV/0!'],
  ['OR(FALSE,0)', false], ['OR(0,1)', true], ['OR(I3,I3)', false], ['XOR(TRUE,TRUE)', false], ['XOR(TRUE,FALSE,TRUE,TRUE)', true], ['NOT(TRUE)', false], ['NOT(0)', true], ['NOT("a")', '#VALUE!'], ['NOT(E1)', '#DIV/0!'],
  ['SWITCH(2,1,"a",2,"b","z")', 'b'], ['SWITCH(9,1,"a","z")', 'z'], ['SWITCH(9,1,"a")', '#N/A'], ['SWITCH("A","a",1,2)', 1], ['CHOOSE(2,"a","b","c")', 'b'], ['CHOOSE(0,"a")', '#VALUE!'], ['CHOOSE(4,"a","b","c")', '#VALUE!'], ['CHOOSE(2.9,"a","b","c")', 'b'],
  ['TRUE()', true], ['FALSE()', false], ['TRUE', true], ['false', false],
]);

table('text functions', [
  ['LEFT("hello",2)', 'he'], ['LEFT("hello")', 'h'], ['LEFT("hi",10)', 'hi'], ['LEFT("hi",-1)', '#VALUE!'], ['LEFT(12345,2)', '12'], ['RIGHT("hello",3)', 'llo'], ['RIGHT("abc",0)', ''], ['RIGHT("abc")', 'c'], ['MID("hello",2,3)', 'ell'], ['MID("abc",5,2)', ''], ['MID("abc",0,1)', '#VALUE!'], ['MID("abc",2,100)', 'bc'],
  ['UPPER("aBc")', 'ABC'], ['LOWER("aBc")', 'abc'], ['PROPER("hello wORLD-foo bar\'s")', "Hello World-Foo Bar'S"], ['PROPER("2nd place")', '2Nd Place'], ['TRIM("  a   b  ")', 'a b'], ['TRIM("a")', 'a'], ['LEN("")', 0], ['LEN(12345)', 5], ['LEN(1.5)', 3], ['LEN(TRUE)', 4], ['LEN(E1)', '#DIV/0!'],
  ['SUBSTITUTE("aaa","a","b")', 'bbb'], ['SUBSTITUTE("aaa","a","b",2)', 'aba'], ['SUBSTITUTE("abc","","x")', 'abc'], ['SUBSTITUTE("abc","b","")', 'ac'], ['SUBSTITUTE("aaa","a","b",5)', 'aaa'], ['SUBSTITUTE("Abc","a","x")', 'Abc'],
  ['REPLACE("abcdef",2,3,"X")', 'aXef'], ['REPLACE("abc",5,1,"Z")', 'abcZ'], ['REPLACE("abc",1,0,"Z")', 'Zabc'], ['FIND("b","abc")', 2], ['FIND("B","abc")', '#VALUE!'], ['FIND("","abc")', 1], ['FIND("a","banana",3)', 4], ['FIND("a","abc",5)', '#VALUE!'],
  ['SEARCH("B","abc")', 2], ['SEARCH("a?c","xabc")', 2], ['SEARCH("*c","abc")', 1], ['SEARCH("z","abc")', '#VALUE!'], ['SEARCH("~?","a?c")', 2], ['REPT("ab",3)', 'ababab'], ['REPT("a",0)', ''], ['REPT("a",-1)', '#VALUE!'],
  ['EXACT("a","A")', false], ['EXACT("a","a")', true], ['EXACT(1,"1")', true], ['CHAR(65)', 'A'], ['CHAR(0)', '#VALUE!'], ['CODE("A")', 65], ['CODE("")', '#VALUE!'], ['CLEAN("a"&CHAR(7)&"b")', 'ab'],
  ['CONCAT(A1:A2,"x")', '1020x'], ['CONCAT("a",1,TRUE)', 'a1TRUE'], ['CONCATENATE("a",1,TRUE)', 'a1TRUE'], ['CONCAT(B1:B2)', 'applebanana'], ['CONCAT(E1)', '#DIV/0!'],
  ['TEXTJOIN(",",TRUE,"a","","b")', 'a,b'], ['TEXTJOIN(",",FALSE,"a","","b")', 'a,,b'], ['TEXTJOIN("-",TRUE,F1:F4)', 'a-b-a-c'], ['TEXTJOIN(", ",TRUE,C1:C5)', '1, x, TRUE, 5'], ['TEXTJOIN(",",TRUE,H1:H3)', 'text'],
  ['VALUE("12.5")', 12.5], ['VALUE("abc")', '#VALUE!'], ['VALUE("1,234")', 1234], ['VALUE("10%")', 0.1], ['VALUE(" 5 ")', 5], ['VALUE("2020-01-15")', 43845], ['VALUE(5)', 5], ['VALUE("")', '#VALUE!'], ['VALUE("1e3")', 1000],
  ['TEXT(1234.5,"#,##0.00")', '1,234.50'], ['TEXT(0.256,"0.0%")', '25.6%'], ['TEXT(5,"000")', '005'], ['TEXT(43845,"yyyy-mm-dd")', '2020-01-15'], ['TEXT(43845,"dddd")', 'Wednesday'], ['TEXT("abc","0")', 'abc'], ['TEXT(1,"")', ''],
  ['TEXT(0.5,"0%")', '50%'], ['TEXT(1234,"0.00")', '1234.00'], ['TEXT(0.5,"hh:mm")', '12:00'], ['TEXT(-1.5,"0.0")', '-1.5'], ['TEXT(TRUE,"0")', 'TRUE'], ['TEXT(1234567,"#,##0")', '1,234,567'], ['TEXT(2.5,"General")', '2.5'],
  ['"x"&1/4', 'x0.25'], ['1/3&""', '0.333333333333333'], ['1E+21&""', '1E+21'], ['123456789012345678&""', '1.23456789012346E+17'], ['0.1+0.2&""', '0.3'], ['100&""', '100'], ['-0.5&""', '-0.5'],
  ['T("a")', 'a'], ['T(5)', ''],
]);

table('lookup functions', [
  ['MATCH(30,A1:A5,0)', 3], ['MATCH(35,A1:A5,1)', 3], ['MATCH(35,A1:A5)', 3], ['MATCH(5,A1:A5,1)', '#N/A'], ['MATCH(60,A1:A5,1)', 5], ['MATCH("banana",B1:B5,0)', 2], ['MATCH("BANANA",B1:B5,0)', 2], ['MATCH("b*",B1:B5,0)', 2], ['MATCH("zzz",B1:B5,0)', '#N/A'], ['MATCH(2,{1,2,3},0)', 2],
  ['MATCH(30,A1:B5,0)', '#N/A'], ['MATCH("30",A1:A5,0)', '#N/A'], ['MATCH(E1,A1:A5,0)', '#DIV/0!'], ['MATCH(3,{5;4;3;1},-1)', 3], ['MATCH(2,{5;4;3;1},-1)', 3], ['MATCH(TRUE,C1:C5,0)', 3],
  ['INDEX(A1:A5,3)', 30], ['INDEX(A1:B5,2,2)', 'banana'], ['SUM(INDEX(A1:B5,0,1))', 150], ['INDEX(A1:A5,6)', '#REF!'], ['INDEX({1,2;3,4},2,1)', 3], ['INDEX(A1:C1,3)', 1], ['INDEX(A1:C1,1,2)', 'apple'], ['INDEX(A1:A5,0)', '#VALUE!'], ['INDEX(A1:B5,1)', '#VALUE!'], ['SUM(INDEX(A1:B5,1,0))', 10], ['INDEX(A99:A100,1)', 0],
  ['VLOOKUP(30,A1:B5,2,FALSE)', 'cherry'], ['VLOOKUP(35,A1:B5,2,TRUE)', 'cherry'], ['VLOOKUP(35,A1:B5,2)', 'cherry'], ['VLOOKUP(5,A1:B5,2)', '#N/A'], ['VLOOKUP(99,A1:B5,2,FALSE)', '#N/A'], ['VLOOKUP(10,A1:B5,3,FALSE)', '#REF!'], ['VLOOKUP("apple",B1:B5,1,0)', 'apple'],
  ['VLOOKUP("a*",B1:B5,1,FALSE)', 'apple'], ['VLOOKUP(30,A1:B5,0,0)', '#VALUE!'], ['VLOOKUP("APPLE",B1:B5,1,FALSE)', 'apple'], ['VLOOKUP(10,A:B,2,FALSE)', 'apple'], ['VLOOKUP(50,A1:A5,1)', 50], ['VLOOKUP(E1,A1:B5,2)', '#DIV/0!'],
  ['HLOOKUP(2,{1,2,3;"a","b","c"},2,FALSE)', 'b'], ['HLOOKUP(2.5,{1,2,3;"a","b","c"},2)', 'b'], ['HLOOKUP(9,{1,2,3;"a","b","c"},2)', 'c'], ['HLOOKUP(7,{1,2,3;"a","b","c"},2,FALSE)', '#N/A'],
  ['XLOOKUP(30,A1:A5,B1:B5)', 'cherry'], ['XLOOKUP(31,A1:A5,B1:B5,"none")', 'none'], ['XLOOKUP(31,A1:A5,B1:B5,,-1)', 'cherry'], ['XLOOKUP(31,A1:A5,B1:B5,,1)', 'apricot'], ['XLOOKUP(31,A1:A5,B1:B5)', '#N/A'], ['XLOOKUP("a",F1:F4,G1:G4,,0,-1)', 3], ['XLOOKUP("a",F1:F4,G1:G4)', 1], ['XLOOKUP("a*",B1:B5,A1:A5,,2)', 10],
  ['LOOKUP(35,A1:A5,B1:B5)', 'cherry'], ['LOOKUP(35,A1:A5)', 30], ['LOOKUP(5,A1:A5)', '#N/A'],
  ['SUM(OFFSET(A1,0,0,3,1))', 60], ['OFFSET(A1,2,0)', 30], ['OFFSET(A1,-1,0)', '#REF!'], ['OFFSET(A1:A2,1,0)', '#VALUE!'], ['INDIRECT("A3")', 30], ['INDIRECT("\'My Sheet\'!A1")', 100], ['INDIRECT("Nope!A1")', '#REF!'], ['INDIRECT("zz")', '#REF!'], ['INDIRECT("A"&2)', 20], ['SUM(INDIRECT("A1:A3"))', 60], ['INDIRECT("A1",FALSE)', '#REF!'],
  ['CHOOSE(2,A1,A2)', 20], ['SUM(CHOOSE(1,A1:A2,A3:A4))', 30], ['SUM(TRANSPOSE({1,2,3}))', 6],
]);

table('date and time functions', [
  ['DATE(2020,1,15)', 43845], ['DATE(2020,13,1)', 44197], ['DATE(2020,1,0)', 43830], ['DATE(2020,2,30)', 43891], ['DATE(1900,1,1)', 1], ['DATE(1900,2,28)', 59], ['DATE(1900,2,29)', 60], ['DATE(1900,3,1)', 61], ['DATE(99,1,1)', 36161], ['DATE(2020,0,1)', 43800], ['DATE(2020,1,-1)', 43829], ['DATE(-1,1,1)', '#NUM!'], ['DATE(2000,1,1)', 36526],
  ['YEAR(43845)', 2020], ['MONTH(43845)', 1], ['DAY(43845)', 15], ['YEAR(1)', 1900], ['DAY(60)', 29], ['MONTH(60)', 2], ['YEAR(-1)', '#NUM!'], ['YEAR("2020-01-15")', 2020], ['MONTH(36526)', 1], ['DAY(36526.9)', 1],
  ['WEEKDAY(43845)', 4], ['WEEKDAY(43845,2)', 3], ['WEEKDAY(43845,3)', 2], ['WEEKDAY(43845,11)', 3], ['WEEKDAY(43845,16)', 5], ['WEEKDAY(43841)', 7], ['WEEKDAY(43842)', 1], ['WEEKDAY(43842,2)', 7], ['WEEKDAY(43845,9)', '#NUM!'],
  ['HOUR(0.75)', 18], ['MINUTE(0.5+1/1440)', 1], ['SECOND(0.5+30/86400)', 30], ['HOUR(43845.5)', 12], ['HOUR(0.999999)', 0], ['TIME(12,30,0)', 0.5208333333333334], ['TIME(25,0,0)', 1 / 24], ['TIME(0,0,-1)', '#NUM!'],
  ['EDATE(43845,1)', 43876], ['EDATE(DATE(2020,1,31),1)', 43890], ['EDATE(43845,-1)', 43814], ['EOMONTH(43845,0)', 43861], ['EOMONTH(43845,1)', 43890], ['EOMONTH(43845,-1)', 43830], ['DAYS(43845,43831)', 14], ['DAYS(43831,43845)', -14],
  ['DATEDIF(DATE(2020,1,15),DATE(2021,3,10),"Y")', 1], ['DATEDIF(DATE(2020,1,15),DATE(2021,3,10),"M")', 13], ['DATEDIF(DATE(2020,1,15),DATE(2021,3,10),"D")', 420], ['DATEDIF(DATE(2020,1,15),DATE(2021,3,10),"YM")', 1], ['DATEDIF(DATE(2020,1,15),DATE(2021,3,10),"MD")', 23], ['DATEDIF(DATE(2020,1,15),DATE(2021,3,10),"YD")', 54],
  ['DATEDIF(43845,43831,"D")', '#NUM!'], ['DATEDIF(43831,43845,"X")', '#NUM!'], ['DATEVALUE("2020-01-15")', 43845], ['DATEVALUE("1/15/2020")', 43845], ['DATEVALUE("nope")', '#VALUE!'], ['TIMEVALUE("12:00")', 0.5], ['TIMEVALUE("6:30 PM")', 0.7708333333333334],
  ['DATE(2020,1,15)+30', 43875], ['DATE(2024,2,29)', 45351], ['YEAR(DATE(2024,2,29)+365)', 2025], ['MONTH(EOMONTH(DATE(2023,1,31),1))', 2], ['DAY(EOMONTH(DATE(2024,1,31),1))', 29],
]);

table('TODAY/NOW with injected clock', [['TODAY()', 43845], ['NOW()', 43845.5], ['INT(NOW())', 43845], ['YEAR(TODAY())', 2020]], undefined, { now: () => new Date(2020, 0, 15, 12, 0, 0) });
table('1904 date system', [['DATE(2020,1,15)', 42383], ['YEAR(42383)', 2020], ['TEXT(42383,"yyyy-mm-dd")', '2020-01-15'], ['DATE(1904,1,1)', 0], ['WEEKDAY(DATE(2020,1,15))', 4]], undefined, { date1904: true });

table('info functions', [
  ['ISNUMBER(A1)', true], ['ISNUMBER(B1)', false], ['ISNUMBER("1")', false], ['ISNUMBER(A99)', false], ['ISTEXT(B1)', true], ['ISTEXT(1)', false], ['ISNONTEXT(B1)', false], ['ISNONTEXT(A99)', true], ['ISBLANK(A99)', true], ['ISBLANK(H2)', false], ['ISBLANK(A1)', false],
  ['ISERROR(E1)', true], ['ISERROR(1)', false], ['ISERROR(1/0)', true], ['ISERR(NA())', false], ['ISERR(E1)', true], ['ISNA(NA())', true], ['ISNA(E1)', false], ['ISLOGICAL(C3)', true], ['ISLOGICAL(1)', false],
  ['N(TRUE)', 1], ['N("a")', 0], ['N(5)', 5], ['N(A99)', 0], ['NA()', '#N/A'], ['TYPE(1)', 1], ['TYPE("a")', 2], ['TYPE(TRUE)', 4], ['TYPE(E1)', 16], ['TYPE({1,2})', 64], ['TYPE(A1:A3)', 64],
]);

table('parser edge cases', [
  ['=1+2', 3], [' 1 + 2 ', 3], ['sum(1,2)', 3], ['"a""b"', 'a"b'], ['"é€ü"&"x"', 'é€üx'], ['_xlfn.IFNA(NA(),2)', 2], ['_xlfn._xlws.TEXTJOIN(",",TRUE,"a","b")', 'a,b'], ['_xlfn.STDEV.S(1,2,3)', 1], ['_xlfn.CONCAT("a","b")', 'ab'], ['UnknownFn(1)', '#NAME?'],
  ['((((((1))))))', 1], ['{1,2,3}', 1], ['{-1,2}', -1], ['SUM({1,2;3,4})', 10], ['ROWS({1,2;3,4})', 2], ['COLUMNS({1,2;3,4})', 2], ['INDEX({1,2;3,4},2,2)', 4], ['{"a","b"}', 'a'], ['{1,2;3}', '#NAME?'], ['SUM(', '#NAME?'], ['1+', '#NAME?'], ['"abc', '#NAME?'], ['SUM(1,,)', 1], ['IF(,1,2)', 2],
  ['1 +  \n 2', 3], ['SUM(\t1,\t2)', 3], ['A1+', '#NAME?'], [')', '#NAME?'], ['1,2', '#NAME?'], ['(1,2)', '#NAME?'], ['#REF!', '#REF!'], ['SUM(#REF!)', '#REF!'], ['Sheet1!#REF!', '#REF!'], ['1e', '#NAME?'], ['\'', '#NAME?'], ['A1:', '#NAME?'], ['A1:B', '#NAME?'], ['$A$1:$B$2', '#VALUE!'],
  ['AND(TRUE,FALSE)=FALSE', true], ['-A1', -10], ['-A1^2', 100], ['-(A1)^2', 100], ['3-A1', -7], ['A1%', 0.1], ['A1&A2', '1020'], ['SUM(A1:A3)/COUNT(A1:A3)', 20],
]);

// ---------------- engine: dependency recalculation ----------------
const addr = (a) => { const m = /^([A-Z]+)(\d+)$/.exec(a); let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return [+m[2] - 1, c - 1]; };
function apply(store, results) {
  for (const [k, res] of results) {
    const [s, r, c] = k.split(',').map(Number); const cell = store.getCell(s, r, c);
    if (cell) { cell.t = res.t; cell.v = res.v; }
  }
}
function edit(store, calc, sheet, a, x, opts) {
  const [r, c] = addr(a); store.setCell(sheet, r, c, x);
  const res = calc.recalcDependents([{ sheet, r, c }], opts); apply(store, res); return res;
}
const got = (res, sheet, a) => { const [r, c] = addr(a); const x = res.get(`${sheet},${r},${c}`); return x ? x.v : undefined; };

test('recalcDependents: only affected cells, correct values, chained edits', () => {
  const st = new Store({ S: { A1: 1, A2: '=A1+1', A3: '=A2*2', B1: '=SUM(A1:A3)', C1: '=10+1', D1: 7 } });
  const c = new Calc(st);
  let res = edit(st, c, 0, 'A1', 5);
  assert.equal(got(res, 0, 'A2'), 6); assert.equal(got(res, 0, 'A3'), 12); assert.equal(got(res, 0, 'B1'), 23);
  assert.equal(res.size, 3); assert.equal(got(res, 0, 'C1'), undefined); assert.equal(res.partial, false);
  res = edit(st, c, 0, 'A1', 0);
  assert.equal(got(res, 0, 'B1'), 0 + 1 + 2);
  res = edit(st, c, 0, 'D1', 8); assert.equal(res.size, 0);
  res = edit(st, c, 0, 'A2', 100); // overwrite a formula with a constant
  assert.equal(got(res, 0, 'A3'), 200); assert.equal(got(res, 0, 'B1'), 0 + 100 + 200);
  res = edit(st, c, 0, 'A1', 9); assert.equal(res.size, 1); assert.equal(got(res, 0, 'B1'), 9 + 100 + 200);
});

test('recalcDependents: new formula, replaced formula, removed formula', () => {
  const st = new Store({ S: { A1: 1, A2: 2, B1: '=A1+A2' } });
  const c = new Calc(st);
  let res = edit(st, c, 0, 'C1', '=B1*10');
  assert.equal(got(res, 0, 'C1'), 0); // B1 cached value is 0 in the fixture (file cache not recalculated)
  res = edit(st, c, 0, 'A1', 3); assert.equal(got(res, 0, 'B1'), 5); assert.equal(got(res, 0, 'C1'), 50);
  res = edit(st, c, 0, 'B1', '=A2*100'); assert.equal(got(res, 0, 'B1'), 200); assert.equal(got(res, 0, 'C1'), 2000);
  res = edit(st, c, 0, 'A1', 4); assert.equal(res.size, 0); // B1 no longer depends on A1
  res = edit(st, c, 0, 'A2', 3); assert.equal(got(res, 0, 'C1'), 3000);
  res = edit(st, c, 0, 'B1', 'plain text'); assert.equal(got(res, 0, 'C1'), '#VALUE!'); // text * 10
  res = edit(st, c, 0, 'A2', 9); assert.equal(res.size, 0);
});

test('recalcDependents: cross-sheet, whole-column, range growth, sheet-qualified names', () => {
  const st = new Store({ A: { A1: 1, B1: '=SUM(A:A)', C1: "='Two Words'!A1+1" }, 'Two Words': { A1: 5, B1: '=A!A1*2', C1: '=SUM(A!A1:A3)' } });
  const c = new Calc(st);
  let res = edit(st, c, 0, 'A100', 7);
  assert.equal(got(res, 0, 'B1'), 8); assert.equal(got(res, 1, 'B1'), undefined);
  res = edit(st, c, 0, 'A1', 2);
  assert.equal(got(res, 0, 'B1'), 9); assert.equal(got(res, 1, 'B1'), 4); assert.equal(got(res, 1, 'C1'), 2);
  res = edit(st, c, 1, 'A1', 50); assert.equal(got(res, 0, 'C1'), 51);
  res = edit(st, c, 0, 'A3', 10); assert.equal(got(res, 1, 'C1'), 12); assert.equal(got(res, 0, 'B1'), 19);
});

test('recalcDependents: interval index selects exactly the intersecting ranges', () => {
  const sheet = {};
  for (let i = 1; i <= 50; i++) sheet['A' + i] = i;
  for (let i = 1; i <= 40; i++) sheet['C' + i] = `=SUM(A${i}:A${i + 9})`; // sliding windows
  sheet.D1 = '=SUM(A1:A50)'; sheet.D2 = '=SUM(B1:B50)'; sheet.D3 = '=COUNT(A$20:A$20)';
  const st = new Store({ S: sheet }); const c = new Calc(st); c.recalcAll();
  const res = c.recalcDependents([{ sheet: 0, r: 24, c: 0 }]); // A25
  const keys = [...res.keys()].sort();
  const want = []; for (let i = 16; i <= 25; i++) want.push(`0,${i - 1},2`); want.push('0,0,3');
  assert.deepEqual(keys, want.sort());
});

test('recalcDependents: shared dependents are computed once, after all precedents (diamond)', () => {
  const st = new Store({ S: { A1: 1, B1: '=A1+1', B2: '=A1+2', C1: '=B1+B2', D1: '=C1+A1+B1' } });
  const c = new Calc(st);
  const res = edit(st, c, 0, 'A1', 10);
  assert.equal(got(res, 0, 'C1'), 23); assert.equal(got(res, 0, 'D1'), 23 + 10 + 11); assert.equal(res.evals, 4);
});

test('cycles: reported as #CIRC!, never hang, recover after fix', () => {
  const st = new Store({ S: { A1: '=B1+1', B1: '=A1+1', C1: '=A1*2', D1: '=D1+1', E1: 1, F1: '=E1+1' } });
  const c = new Calc(st);
  let res = c.recalcAll();
  for (const a of ['A1', 'B1', 'D1', 'C1']) assert.equal(got(res, 0, a), '#CIRC!', a);
  assert.equal(res.get('0,0,0').t, 'e'); assert.equal(got(res, 0, 'F1'), 2); assert.ok(res.circular >= 3);
  apply(st, res);
  res = edit(st, c, 0, 'B1', 5);
  assert.equal(got(res, 0, 'A1'), 6); assert.equal(got(res, 0, 'C1'), 12);
  res = edit(st, c, 0, 'D1', '=E1+D2'); assert.equal(got(res, 0, 'D1'), 1);
  res = edit(st, c, 0, 'B1', '=C1'); // A1 -> B1 -> C1 -> A1
  assert.equal(got(res, 0, 'C1'), '#CIRC!');
  assert.equal(c.evaluate(0, 0, 0, 'A1+1').t, 'e'); // downstream of circular value stays an error
});

test('self reference through a range is a cycle', () => {
  const st = new Store({ S: { A1: 1, A2: 2, A3: '=SUM(A1:A3)' } });
  const res = new Calc(st).recalcAll();
  assert.equal(got(res, 0, 'A3'), '#CIRC!');
});

test('volatile cells recalc on every call; INDIRECT/OFFSET are volatile', () => {
  let t = 0; const st = new Store({ S: { A1: 1, B1: '=NOW()', C1: '=INDIRECT("A1")+1', D1: '=A1+1' } }, { now: () => new Date(2020, 0, 15, 12, 0, t++) });
  const c = new Calc(st);
  const r1 = c.recalcDependents([]); assert.ok(r1.has('0,0,1') && r1.has('0,0,2') && !r1.has('0,0,3'));
  const r2 = c.recalcDependents([]); assert.notEqual(r1.get('0,0,1').v, r2.get('0,0,1').v);
  assert.equal(c.recalcDependents([], { volatile: false }).size, 0);
});

test('partial results: work cap and pending list resume to the same final state', () => {
  const sheet = { A1: 1 }; for (let i = 2; i <= 300; i++) sheet['A' + i] = `=A${i - 1}+1`;
  const st = new Store({ S: sheet }); const c = new Calc(st);
  const [r, cc] = addr('A1'); st.setCell(0, r, cc, 10);
  let res = c.recalcDependents([{ sheet: 0, r, c: cc }], { maxEvals: 100 });
  assert.equal(res.partial, true); assert.equal(res.pending.length, 199); apply(st, res);
  const res2 = c.recalcDependents(res.pending, { maxEvals: 1000 });
  assert.equal(res2.partial, false); assert.equal(got(res2, 0, 'A300'), 309);
});

test('time budget yields partial results', () => {
  const sheet = { A1: 1 }; for (let i = 2; i <= 20000; i++) sheet['A' + i] = `=A${i - 1}+1`;
  const st = new Store({ S: sheet }); const c = new Calc(st);
  const res = c.recalcDependents([{ sheet: 0, r: 0, c: 0 }], { timeBudgetMs: 1 });
  assert.ok(res.partial === true || res.evals === 19999);
  if (res.partial) assert.ok(res.pending.length > 0 && res.evals < 19999);
});

test('implicit intersection and array formulas', () => {
  const st = new Store({ S: { A1: 1, A2: 2, A3: 3, B1: 'x', B2: 'y', B3: 'z', C1: 1, C2: '', C3: 1, D1: 5 } });
  const c = new Calc(st);
  assert.equal(c.evaluate(0, 2, 5, 'A1:A3*2').v, 6); // row 3 -> A3
  assert.equal(c.evaluate(0, 1, 5, '$A$1:$A$3+10').v, 12);
  assert.equal(c.evaluate(0, 5, 5, 'A1:A3*2').v, '#VALUE!');
  assert.equal(c.evaluate(0, 0, 1, 'A1:C1').v, 'x' === 'x' ? 'x' : 0); // row range at column B -> B1
  assert.equal(c.evaluate(0, 9, 9, 'INDEX(B1:B3,MATCH(2,A1:A3*1,0))').v, '#VALUE!');
  assert.equal(c.evaluate(0, 9, 9, 'INDEX(B1:B3,MATCH(2,A1:A3*1,0))', { array: true }).v, 'y');
  assert.equal(c.evaluate(0, 9, 9, 'INDEX(B1:B3,MATCH(1,(A1:A3>1)*(C1:C3=1),0))', { array: true }).v, 'z');
  assert.equal(c.evaluate(0, 9, 9, 'SUM(IF(A1:A3>1,A1:A3,0))', { array: true }).v, 5);
  assert.equal(c.evaluate(0, 9, 9, 'SUM(IF(A1:A3>1,A1:A3,0))').v, '#VALUE!');
  assert.equal(c.evaluate(0, 9, 9, 'SUMPRODUCT(--(A1:A3>1),A1:A3)').v, 5);
  assert.equal(c.evaluate(0, 9, 9, 'SUMPRODUCT(LEN(B1:B3))').v, 3);
  assert.equal(c.evaluate(0, 9, 9, 'MAX(A1:A3*2)', { array: true }).v, 6);
  assert.equal(c.evaluate(0, 9, 9, 'SUM(--(A1:A3>1))', { array: true }).v, 2);
  assert.equal(c.evaluate(0, 9, 9, 'ROW(A1:A3)', { array: true }).v, 1);
  assert.equal(c.evaluate(0, 9, 9, 'SUM(ROW(A1:A3))', { array: true }).v, 6);
  assert.equal(c.evaluate(0, 9, 9, 'SUM(ABS(A1:A3-2))', { array: true }).v, 2);
  assert.equal(c.evaluate(0, 9, 9, 'SUM(A1:A3*{1,2,3})', { array: true }).v, 36);
});

test('recalc honours the cell array flag', () => {
  const st = new Store({ S: { A1: 1, A2: 2, A3: 3, B1: 'x', B2: 'y', B3: 'z', E1: { t: 's', v: '', f: 'INDEX(B1:B3,MATCH(2,A1:A3*1,0))', fa: true, s: 0 } } });
  const res = new Calc(st).recalcAll();
  assert.equal(got(res, 0, 'E1'), 'y');
});

test('errors in store cells and typed cells', () => {
  const st = new Store({ S: { A1: { t: 'e', v: '#N/A', s: 0 }, A2: { t: 'd', v: 43845, s: 0 }, A3: { t: 'z', v: null, s: 0 }, A4: { t: 'b', v: true, s: 0 }, A5: { t: 's', v: '', s: 0 }, A6: { t: 'd', v: '2020-01-15', s: 0 } } });
  const c = new Calc(st);
  assert.equal(c.evaluate(0, 9, 9, 'A1+1').v, '#N/A'); assert.equal(c.evaluate(0, 9, 9, 'A2+1').v, 43846); assert.equal(c.evaluate(0, 9, 9, 'A3').v, 0);
  assert.equal(c.evaluate(0, 9, 9, 'ISBLANK(A3)').v, true); assert.equal(c.evaluate(0, 9, 9, 'A4+0').v, 1); assert.equal(c.evaluate(0, 9, 9, 'ISBLANK(A5)').v, false);
  assert.equal(c.evaluate(0, 9, 9, 'A6+0').v, 43845); assert.equal(c.evaluate(0, 9, 9, 'COUNTA(A1:A6)').v, 5);
  assert.equal(c.evaluate(0, 9, 9, 'A1').t, 'e');
  assert.equal(c.evaluate(0, 9, 9, 'A5').t, 's');
  assert.equal(c.evaluate(0, 9, 9, 'A4').t, 'b');
});

test('store without forEachCell/getExtent still evaluates direct references', () => {
  const rows = { '0,0': 3, '1,0': 4 };
  const c = new Calc({ getCell: (s, r, cc) => rows[r + ',' + cc] === undefined ? undefined : { t: 'n', v: rows[r + ',' + cc] }, sheetNames: ['S'], sheetIndexByName: (n) => n === 'S' ? 0 : -1 });
  assert.equal(c.evaluate(0, 5, 5, 'A1+A2').v, 7); assert.equal(c.evaluate(0, 5, 5, 'SUM(A1:A10)').v, 7); assert.equal(c.evaluate(0, 5, 5, 'S!A2').v, 4);
});

test('parse cache and AST shape', () => {
  assert.equal(Calc.parse('1+2'), Calc.parse('1+2'));
  assert.equal(Calc.parse('SUM(').error, '#NAME?');
  assert.equal(Calc.parse('SUM(A1:B2)').k, 'fn');
  assert.ok(Calc.functionNames().length >= 140);
  for (const n of ['SUM', 'VLOOKUP', 'XLOOKUP', 'TEXTJOIN', 'SUMIFS', 'DATEDIF', 'IFS', 'SWITCH']) assert.ok(Calc.functionNames().includes(n), n);
});

// ---------------- property tests: incremental == full recomputation ----------------
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const colName = (c) => String.fromCharCode(65 + c);
// independent oracle: lazily/recursively evaluates formula cells with a fresh engine per formula (no graph, no overlay)
class OracleStore {
  constructor(base) { this.base = base; this.sheetNames = base.sheetNames; this.date1904 = base.date1904; this.memo = new Map(); }
  sheetIndexByName(n) { return this.base.sheetIndexByName(n); }
  getExtent(s) { return this.base.getExtent(s); }
  getCell(s, r, c) {
    const cell = this.base.getCell(s, r, c);
    if (!cell || !cell.f) return cell;
    const k = s + ',' + r + ',' + c; let m = this.memo.get(k);
    if (!m) { this.memo.set(k, { t: 'n', v: 0 }); const res = new Calc(this).evaluate(s, r, c, cell.f, { array: !!cell.fa }); m = { t: res.t, v: res.v, f: cell.f, s: 0 }; this.memo.set(k, m); }
    return m;
  }
  forEachCell(s, r1, c1, r2, c2, cb) { this.base.forEachCell(s, r1, c1, r2, c2, (r, c) => cb(r, c, this.getCell(s, r, c))); }
}
function randomFormula(rnd, nr, nc, r, c, sheets) {
  if (r === 0) return '1+1';
  const ref = () => { const rr = Math.floor(rnd() * r), cc = Math.floor(rnd() * nc); return colName(cc) + (rr + 1); };
  const rangeRef = () => { const r1 = Math.floor(rnd() * r), r2 = Math.min(r - 1, r1 + Math.floor(rnd() * 5)), c1 = Math.floor(rnd() * nc), c2 = Math.min(nc - 1, c1 + Math.floor(rnd() * 3)); return `${colName(c1)}${r1 + 1}:${colName(c2)}${r2 + 1}`; };
  const xs = sheets > 1 && rnd() < 0.25 ? 'S1!' : '';
  switch (Math.floor(rnd() * 14)) {
    case 0: return `${ref()}+${ref()}`;
    case 1: return `SUM(${xs}${rangeRef()})`;
    case 2: return `IF(${ref()}>${ref()},${ref()},${ref()}*2)`;
    case 3: return `MAX(${rangeRef()})-MIN(${rangeRef()})`;
    case 4: return `IFERROR(${ref()}/${ref()},-1)`;
    case 5: return `${ref()}/${ref()}`;
    case 6: return `COUNT(${xs}${rangeRef()})+COUNTA(${rangeRef()})`;
    case 7: return `SUMIF(${rangeRef()},">2")`;
    case 8: return `${ref()}&"-"&${ref()}`;
    case 9: return `AVERAGE(${rangeRef()})`;
    case 10: return `SUM(A1:A${r})`;
    case 11: return `INDEX(${rangeRef()},1,1)+LEN(${ref()})`;
    case 12: return `VLOOKUP(${ref()},${rangeRef()},1,FALSE)`;
    default: return `${ref()}*2-${ref()}`;
  }
}
function buildRandom(rnd, nsheets, nr, nc) {
  const sheets = {};
  for (let s = 0; s < nsheets; s++) {
    const sh = {};
    for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
      const x = rnd();
      if (x < 0.45) sh[colName(c) + (r + 1)] = Math.floor(rnd() * 7) - 2;
      else if (x < 0.5) sh[colName(c) + (r + 1)] = ['a', 'b', 'x'][Math.floor(rnd() * 3)];
      else if (x < 0.62) continue;
      else sh[colName(c) + (r + 1)] = '=' + randomFormula(rnd, nr, nc, r, c, nsheets);
    }
    sheets['S' + s] = sh;
  }
  return sheets;
}
function compareToOracle(st, label) {
  const o = new OracleStore(st);
  for (let s = 0; s < st.rows.length; s++) st.forEachCell(s, 0, 0, 1e6, 1e6, (r, c, cell) => {
    if (!cell.f) return;
    const exp = o.getCell(s, r, c);
    const ok = cell.t === exp.t && (typeof exp.v === 'number' ? close(cell.v, exp.v, 1e-9) : cell.v === exp.v);
    assert.ok(ok, `${label}: ${s}!${colName(c)}${r + 1} =${cell.f}: got ${cell.t}:${cell.v} expected ${exp.t}:${exp.v}`);
  });
}
test('property: incremental recalculation equals full recalculation on random sheets with random edits', () => {
  let total = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const rnd = rng(seed);
    const nsheets = 1 + (seed % 2), nr = 12 + (seed % 7), nc = 4 + (seed % 3);
    const st = new Store(buildRandom(rnd, nsheets, nr, nc));
    const calc = new Calc(st);
    apply(st, calc.recalcAll());
    compareToOracle(st, `seed ${seed} initial`);
    for (let round = 0; round < 12; round++) {
      const changed = []; const k = 1 + Math.floor(rnd() * 3);
      for (let i = 0; i < k; i++) {
        const s = Math.floor(rnd() * nsheets), r = Math.floor(rnd() * nr), c = Math.floor(rnd() * nc), x = rnd();
        let nv;
        if (x < 0.55) nv = Math.floor(rnd() * 9) - 3; else if (x < 0.65) nv = ['a', 'b', 'x', ''][Math.floor(rnd() * 4)];
        else if (x < 0.72) nv = undefined; else nv = '=' + randomFormula(rnd, nr, nc, r, c, nsheets);
        st.setCell(s, r, c, nv); changed.push({ sheet: s, r, c });
      }
      const res = calc.recalcDependents(changed); total += res.size;
      assert.equal(res.circular, 0); assert.equal(res.partial, false);
      apply(st, res);
      compareToOracle(st, `seed ${seed} round ${round}`);
    }
  }
  assert.ok(total > 200, 'recalculated ' + total);
});

test('property: recalcAll after reset gives the same values as the incremental engine', () => {
  for (let seed = 100; seed < 110; seed++) {
    const rnd = rng(seed); const st = new Store(buildRandom(rnd, 2, 20, 5));
    const a = new Calc(st); const full = a.recalcAll(); apply(st, full);
    const b = new Calc(st); const full2 = b.recalcAll();
    for (const [k, v] of full) assert.deepEqual({ t: full2.get(k).t, v: full2.get(k).v }, { t: v.t, v: v.v });
  }
});

test('property: cycles injected into random sheets never hang and non-cyclic cells stay correct', () => {
  for (let seed = 200; seed < 215; seed++) {
    const rnd = rng(seed); const st = new Store(buildRandom(rnd, 1, 15, 4));
    st.setCell(0, 2, 1, '=D14+1'); st.setCell(0, 13, 3, '=B3+1');
    const c = new Calc(st); const res = c.recalcAll();
    assert.equal(got(res, 0, 'B3'), '#CIRC!'); assert.equal(got(res, 0, 'D14'), '#CIRC!');
  }
});

// ---------------- performance ----------------
function bigStore(rows, cols, fill) {
  const st = new Store({ S: {} }); const data = new Array(rows);
  for (let r = 0; r < rows; r++) { const row = new Array(cols); for (let c = 0; c < cols; c++) row[c] = fill(r, c); data[r] = row; }
  st.rows[0] = data; return st;
}
test('perf: parser handles 8192-char formulas quickly, deep nesting safely', () => {
  let f = '1'; while (f.length < 8000) f += '+A1*2';
  let t = process.hrtime.bigint(); const ast = Calc.parse(f); const dt = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(!ast.error); assert.ok(dt < 50, 'parse ms ' + dt);
  let g = 'SUM('; while (g.length < 8000) g += 'A1,'; g += '1)';
  t = process.hrtime.bigint(); assert.ok(!Calc.parse(g).error); const dt2 = Number(process.hrtime.bigint() - t) / 1e6;
  const deep = '('.repeat(3000) + '1' + ')'.repeat(3000); assert.equal(Calc.parse(deep).error, '#NAME?');
  const evil = '"' + 'a'.repeat(8000); assert.ok(Calc.parse(evil).error);
  const evil2 = ':'.repeat(8000) + 'A'.repeat(100); assert.ok(Calc.parse(evil2).error);
  const evil3 = 'A1'.repeat(3000); const t3 = process.hrtime.bigint(); Calc.parse(evil3); const dt3 = Number(process.hrtime.bigint() - t3) / 1e6; assert.ok(dt3 < 50);
  const st = new Store({ S: { A1: 1 } }); const t4 = process.hrtime.bigint(); const r = new Calc(st).evaluate(0, 0, 1, f); const dt4 = Number(process.hrtime.bigint() - t4) / 1e6;
  assert.equal(r.v, 1 + 2 * ((f.length - 1) / 5));
  console.log(`[perf] parse 8000-char ${dt.toFixed(2)} ms, 8000-char SUM args ${dt2.toFixed(2)} ms, parse+eval ${dt4.toFixed(2)} ms`);
});

test('perf: 1M-cell SUM via forEachCell fast path < 100 ms', () => {
  const st = bigStore(1000, 1000, (r, c) => ({ t: 'n', v: r + c, s: 0 }));
  const calc = new Calc(st); calc.evaluate(0, 0, 0, 'SUM(A1:ALL1000)');
  const t = process.hrtime.bigint(); const res = calc.evaluate(0, 2000, 0, 'SUM(A1:ALL1000)'); const dt = Number(process.hrtime.bigint() - t) / 1e6;
  let exp = 0; for (let r = 0; r < 1000; r++) for (let c = 0; c < 1000; c++) exp += r + c;
  assert.equal(res.v, exp);
  const t2 = process.hrtime.bigint(); calc.evaluate(0, 2000, 0, 'COUNTIF(A1:ALL1000,">1000")'); const dt2 = Number(process.hrtime.bigint() - t2) / 1e6;
  const t3 = process.hrtime.bigint(); calc.evaluate(0, 2000, 0, 'MAX(A:ALL)'); const dt3 = Number(process.hrtime.bigint() - t3) / 1e6;
  console.log(`[perf] SUM over 1,000,000 cells: ${dt.toFixed(1)} ms; COUNTIF over 1M: ${dt2.toFixed(1)} ms; MAX over whole columns: ${dt3.toFixed(1)} ms`);
  assert.ok(dt < 100, 'SUM took ' + dt);
});

test('perf: 100k-formula chain recalculates iteratively (no recursion limits)', () => {
  const N = 100000;
  const st = bigStore(N, 1, (r) => r === 0 ? { t: 'n', v: 1, s: 0 } : { t: 'n', v: 0, f: `A${r}+1`, s: 0 });
  const calc = new Calc(st);
  let t = process.hrtime.bigint(); const res0 = calc.recalcDependents([{ sheet: 0, r: 0, c: 0 }]); const dtFirst = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(res0.size, N - 1); assert.equal(res0.get(`0,${N - 1},0`).v, N);
  apply(st, res0);
  st.setCell(0, 0, 0, 5);
  t = process.hrtime.bigint(); const res = calc.recalcDependents([{ sheet: 0, r: 0, c: 0 }]); const dt = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(res.get(`0,${N - 1},0`).v, N + 4); assert.equal(res.partial, false);
  console.log(`[perf] 100k chain: first call (scan+parse+calc) ${dtFirst.toFixed(0)} ms, incremental edit ${dt.toFixed(0)} ms`);
  assert.ok(dt < 3000);
  assert.equal(calc.evaluate(0, 0, 1, 'A100000').v, N + 4);
});

test('perf: 100k fan-in / fan-out', () => {
  const N = 100000;
  const st = bigStore(N, 3, (r, c) => c === 0 ? { t: 'n', v: r, s: 0 } : c === 1 ? { t: 'n', v: 0, f: `A${r + 1}*2`, s: 0 } : r === 0 ? { t: 'n', v: 0, f: `SUM(B1:B${N})`, s: 0 } : undefined);
  const calc = new Calc(st);
  let t = process.hrtime.bigint(); let res = calc.recalcAll(); const dtAll = Number(process.hrtime.bigint() - t) / 1e6;
  apply(st, res); assert.equal(res.get('0,0,2').v, 2 * (N * (N - 1) / 2));
  st.setCell(0, 500, 0, 1000);
  t = process.hrtime.bigint(); res = calc.recalcDependents([{ sheet: 0, r: 500, c: 0 }]); const dt1 = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(res.size, 2); assert.equal(res.get('0,0,2').v, 2 * (N * (N - 1) / 2) - 1000 + 2000);
  apply(st, res);
  const all = []; for (let r = 0; r < N; r++) { st.getCell(0, r, 0).v = 1; all.push({ sheet: 0, r, c: 0 }); }
  t = process.hrtime.bigint(); res = calc.recalcDependents(all); const dt2 = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(res.size, N + 1); assert.equal(res.get('0,0,2').v, 2 * N);
  console.log(`[perf] fan-in 100k: recalcAll ${dtAll.toFixed(0)} ms (incl. scan), single edit ${dt1.toFixed(1)} ms, 100k edits at once ${dt2.toFixed(0)} ms`);
});

test('perf: work cap returns partial', () => {
  const st = bigStore(5000, 1, (r) => r === 0 ? { t: 'n', v: 1, s: 0 } : { t: 'n', v: 0, f: `A${r}+1`, s: 0 });
  const res = new Calc(st).recalcDependents([{ sheet: 0, r: 0, c: 0 }], { maxEvals: 1000 });
  assert.equal(res.partial, true); assert.equal(res.evals, 1000); assert.equal(res.pending.length, 4999 - 1000);
});

test('perf: VLOOKUP exact over 20k rows x 20k lookups uses the cached index', () => {
  const N = 20000;
  const st = bigStore(N, 3, (r, c) => c === 0 ? { t: 'n', v: r * 3, s: 0 } : c === 1 ? { t: 'n', v: r, s: 0 } : { t: 'n', v: 0, f: `VLOOKUP(${(N - r - 1) * 3},A$1:B$${N},2,FALSE)`, s: 0 });
  const calc = new Calc(st);
  const t = process.hrtime.bigint(); const res = calc.recalcAll(); const dt = Number(process.hrtime.bigint() - t) / 1e6;
  assert.equal(res.get(`0,0,2`).v, N - 1); assert.equal(res.get(`0,${N - 1},2`).v, 0);
  console.log(`[perf] 20k exact VLOOKUPs over 20k rows: ${dt.toFixed(0)} ms`);
  assert.ok(dt < 3000);
});

test('array formulas: evaluateMatrix returns all members, recalc results flag array masters', () => {
  const st = new Store({ S: { A1: 1, A2: 2, A3: 3, E1: { t: 'n', v: 2, f: 'A1:A3*2', fa: true, s: 0 } } });
  const c = new Calc(st);
  const m = c.evaluateMatrix(0, 0, 4, 'A1:A3*2');
  assert.deepEqual(m.map((row) => row.map((x) => x.v)), [[2], [4], [6]]);
  st.setCell(0, 0, 0, 10);
  const res = c.recalcDependents([{ sheet: 0, r: 0, c: 0 }]);
  assert.deepEqual(res.arrays, [{ sheet: 0, r: 0, c: 4 }]);
  assert.equal(res.get('0,0,4').array, true);
  assert.deepEqual(c.evaluateMatrix(0, 0, 4, 'A1:A3*2').map((row) => row[0].v), [20, 4, 6]);
  assert.deepEqual(c.evaluateMatrix(0, 0, 4, '1+1'), [[{ t: 'n', v: 2 }]]);
});
