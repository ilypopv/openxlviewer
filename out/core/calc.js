(function (root) {
    'use strict';
    const OX = root.OX || (root.OX = {});

    // ---------- values ----------
    class XErr {
        constructor(e) {
            this.e = e;
        }
    }
    const ERRS = Object.create(null);
    const E = c => ERRS[c] || (ERRS[c] = new XErr(c));
    const DIV0 = E('#DIV/0!'),
        NA = E('#N/A'),
        NAME = E('#NAME?'),
        NUM = E('#NUM!'),
        REF = E('#REF!'),
        VALUE = E('#VALUE!'),
        CIRC = E('#CIRC!');
    class Ref {
        constructor(sheet, r1, c1, r2, c2) {
            this.sheet = sheet;
            this.r1 = r1;
            this.c1 = c1;
            this.r2 = r2;
            this.c2 = c2;
        }
    }
    class Arr {
        constructor(rows) {
            this.rows = rows;
            this.nr = rows.length;
            this.nc = rows.length ? rows[0].length : 0;
        }
    }
    const MAXR = 1048575,
        MAXC = 16383;

    // ---------- parser ----------
    class PErr extends Error {}
    const ERR_LITS = ['#DIV/0!', '#N/A', '#NAME?', '#NULL!', '#NUM!', '#REF!', '#VALUE!'];

    function parseRefWord(w) {
        // returns {k:'cell',r,c,ar,ac} | {k:'col',c,ac} | {k:'row',r,ar} | null
        const n = w.length;
        let i = 0,
            ac = false,
            ar = false;
        if (w.charCodeAt(0) === 36) {
            ac = true;
            i = 1;
        }
        let c = 0,
            nl = 0;
        while (i < n) {
            let ch = w.charCodeAt(i);
            if (ch >= 97 && ch <= 122) ch -= 32;
            if (ch < 65 || ch > 90) break;
            c = c * 26 + (ch - 64);
            nl++;
            i++;
            if (nl > 3) return null;
        }
        if (nl > 0) {
            if (c > 16384) return null;
            if (i === n) return { k: 'col', c: c - 1, ac };
            if (w.charCodeAt(i) === 36) {
                ar = true;
                i++;
            }
            let r = 0,
                nd = 0;
            while (i < n) {
                const ch = w.charCodeAt(i);
                if (ch < 48 || ch > 57) return null;
                r = r * 10 + ch - 48;
                nd++;
                i++;
                if (nd > 7) return null;
            }
            if (nd === 0 || r < 1 || r > 1048576) return null;
            return { k: 'cell', r: r - 1, c: c - 1, ar, ac };
        }
        if (ac) {
            let r = 0,
                nd = 0;
            while (i < n) {
                const ch = w.charCodeAt(i);
                if (ch < 48 || ch > 57) return null;
                r = r * 10 + ch - 48;
                nd++;
                i++;
                if (nd > 7) return null;
            }
            if (nd === 0 || r < 1 || r > 1048576) return null;
            return { k: 'row', r: r - 1, ar: false };
        }
        return null;
    }

    const isWordCh = ch =>
        (ch >= 48 && ch <= 57) ||
        (ch >= 65 && ch <= 90) ||
        (ch >= 97 && ch <= 122) ||
        ch === 95 ||
        ch === 46 ||
        ch === 36 ||
        ch === 92 ||
        ch > 127;

    function normFn(name) {
        let u = name.toUpperCase();
        if (u.charCodeAt(0) === 95) {
            if (u.startsWith('_XLFN._XLWS.')) u = u.slice(12);
            else if (u.startsWith('_XLFN.')) u = u.slice(6);
            else if (u.startsWith('_XLWS.')) u = u.slice(6);
        }
        return u;
    }

    class Parser {
        constructor(s) {
            this.s = s;
            this.i = 0;
            this.n = s.length;
            this.depth = 0;
        }
        ws() {
            const s = this.s;
            while (this.i < this.n) {
                const c = s.charCodeAt(this.i);
                if (c === 32 || c === 9 || c === 10 || c === 13 || c === 160) this.i++;
                else break;
            }
        }
        peek() {
            this.ws();
            return this.i < this.n ? this.s[this.i] : '';
        }
        cmp() {
            let a = this.concat();
            for (;;) {
                this.ws();
                const s = this.s,
                    i = this.i,
                    ch = s[i];
                let op = null;
                if (ch === '=') op = '=';
                else if (ch === '<') op = s[i + 1] === '>' ? '<>' : s[i + 1] === '=' ? '<=' : '<';
                else if (ch === '>') op = s[i + 1] === '=' ? '>=' : '>';
                if (!op) return a;
                this.i += op.length;
                a = { k: 'bin', op, a, b: this.concat() };
            }
        }
        concat() {
            let a = this.add();
            while (this.peek() === '&') {
                this.i++;
                a = { k: 'bin', op: '&', a, b: this.add() };
            }
            return a;
        }
        add() {
            let a = this.mul();
            for (;;) {
                const ch = this.peek();
                if (ch !== '+' && ch !== '-') return a;
                this.i++;
                a = { k: 'bin', op: ch, a, b: this.mul() };
            }
        }
        mul() {
            let a = this.pow();
            for (;;) {
                const ch = this.peek();
                if (ch !== '*' && ch !== '/') return a;
                this.i++;
                a = { k: 'bin', op: ch, a, b: this.pow() };
            }
        }
        pow() {
            let a = this.unary();
            while (this.peek() === '^') {
                this.i++;
                a = { k: 'bin', op: '^', a, b: this.unary() };
            }
            return a;
        }
        unary() {
            const ch = this.peek();
            if (ch === '-') {
                this.i++;
                if (++this.depth > 400) throw new PErr();
                const a = this.unary();
                this.depth--;
                return { k: 'neg', a };
            }
            if (ch === '+') {
                this.i++;
                if (++this.depth > 400) throw new PErr();
                const a = this.unary();
                this.depth--;
                return { k: 'pos', a };
            }
            let p = this.primary();
            while (this.peek() === ':' && (p.k === 'fn' || p.k === 'paren' || p.k === 'ref')) {
                this.i++;
                p = { k: 'rng', a: p, b: this.primary() };
            }
            while (this.peek() === '%') {
                this.i++;
                p = { k: 'pct', a: p };
            }
            return p;
        }
        primary() {
            this.ws();
            const s = this.s,
                ch = s.charCodeAt(this.i);
            if (this.i >= this.n) throw new PErr();
            if (ch === 40) {
                if (++this.depth > 400) throw new PErr();
                this.i++;
                const e = this.cmp();
                if (this.peek() !== ')') throw new PErr();
                this.i++;
                this.depth--;
                return { k: 'paren', a: e };
            }
            if (ch === 34) return { k: 's', v: this.str() };
            if (ch === 123) return this.arrayConst();
            if (ch === 35) return this.errLit();
            if ((ch >= 48 && ch <= 57) || ch === 46) return this.number();
            if (ch === 39) {
                const name = this.quoted();
                if (s[this.i] !== '!') throw new PErr();
                this.i++;
                return this.afterSheet(name);
            }
            if (isWordCh(ch) && ch !== 46) {
                const st = this.i;
                let j = st;
                while (j < this.n && isWordCh(s.charCodeAt(j))) j++;
                const w = s.slice(st, j);
                if (s[j] === '!') {
                    this.i = j + 1;
                    return this.afterSheet(w);
                }
                if (s[j] === '(') {
                    this.i = j + 1;
                    return this.call(w);
                }
                if (s[j] === '[') {
                    // structured table ref: unsupported
                    let d = 0;
                    while (j < this.n) {
                        const c2 = s[j];
                        if (c2 === '[') d++;
                        else if (c2 === ']') {
                            d--;
                            if (d === 0) {
                                j++;
                                break;
                            }
                        }
                        j++;
                    }
                    this.i = j;
                    return { k: 'e', v: '#NAME?' };
                }
                this.i = j;
                return this.refOrName(w, null);
            }
            throw new PErr();
        }
        str() {
            const s = this.s;
            let i = this.i + 1,
                out = '',
                st = i;
            for (;;) {
                if (i >= this.n) throw new PErr();
                if (s.charCodeAt(i) === 34) {
                    if (s.charCodeAt(i + 1) === 34) {
                        out += s.slice(st, i + 1);
                        i += 2;
                        st = i;
                        continue;
                    }
                    out += s.slice(st, i);
                    this.i = i + 1;
                    return out;
                }
                i++;
            }
        }
        quoted() {
            const s = this.s;
            let i = this.i + 1,
                out = '',
                st = i;
            for (;;) {
                if (i >= this.n) throw new PErr();
                if (s.charCodeAt(i) === 39) {
                    if (s.charCodeAt(i + 1) === 39) {
                        out += s.slice(st, i + 1);
                        i += 2;
                        st = i;
                        continue;
                    }
                    out += s.slice(st, i);
                    this.i = i + 1;
                    return out;
                }
                i++;
            }
        }
        errLit() {
            const s = this.s;
            for (const e of ERR_LITS)
                if (s.startsWith(e, this.i)) {
                    this.i += e.length;
                    return { k: 'e', v: e };
                }
            throw new PErr();
        }
        number() {
            const s = this.s,
                st = this.i;
            let i = st,
                ch;
            while (i < this.n && (ch = s.charCodeAt(i)) >= 48 && ch <= 57) i++;
            const intEnd = i;
            let dot = false;
            if (s.charCodeAt(i) === 46) {
                dot = true;
                i++;
                while (i < this.n && (ch = s.charCodeAt(i)) >= 48 && ch <= 57) i++;
            }
            if (i === st || (dot && i === st + 1)) throw new PErr();
            ch = s.charCodeAt(i);
            if (ch === 69 || ch === 101) {
                let j = i + 1;
                const sg = s.charCodeAt(j);
                if (sg === 43 || sg === 45) j++;
                const ds = j;
                while (j < this.n && (ch = s.charCodeAt(j)) >= 48 && ch <= 57) j++;
                if (j > ds) {
                    i = j;
                    dot = true;
                }
            }
            this.i = i;
            if (!dot && s.charCodeAt(i) === 58 && intEnd === i) {
                // row range 1:1
                const r1 = parseInt(s.slice(st, i), 10) - 1;
                this.i = i + 1;
                const st2 = this.i;
                let j = st2;
                while (j < this.n && (((ch = s.charCodeAt(j)) >= 48 && ch <= 57) || ch === 36)) j++;
                const t = parseRefWord('$' + s.slice(st2, j).replace('$', ''));
                if (!t || t.k !== 'row' || r1 < 0 || r1 > MAXR) throw new PErr();
                this.i = j;
                return this.mkRef(null, Math.min(r1, t.r), 0, Math.max(r1, t.r), MAXC);
            }
            const v = +s.slice(st, i);
            if (!isFinite(v)) throw new PErr();
            return { k: 'n', v };
        }
        mkRef(sheet, r1, c1, r2, c2) {
            return { k: 'ref', sheet, r1, c1, r2, c2 };
        }
        afterSheet(name) {
            const s = this.s;
            if (s[this.i] === '#') {
                this.errLit();
                return { k: 'e', v: '#REF!' };
            }
            const st = this.i;
            let j = st;
            while (j < this.n && isWordCh(s.charCodeAt(j))) j++;
            if (j === st) throw new PErr();
            this.i = j;
            return this.refOrName(s.slice(st, j), name);
        }
        refOrName(w, sheet) {
            const s = this.s;
            const t = parseRefWord(w);
            if (t) {
                if (s.charCodeAt(this.i) === 58) {
                    // range
                    this.i++;
                    if (s[this.i] === "'") {
                        this.quoted();
                        if (s[this.i] !== '!') throw new PErr();
                        this.i++;
                    }
                    const st = this.i;
                    let j = st;
                    while (j < this.n && isWordCh(s.charCodeAt(j))) j++;
                    if (s[j] === '(' && j > st) {
                        if (t.k !== 'cell') throw new PErr();
                        const a = this.mkRef(sheet, t.r, t.c, t.r, t.c);
                        return { k: 'rng', a, b: this.primary() };
                    }
                    if (j === st) throw new PErr();
                    let w2 = s.slice(st, j);
                    if (s[j] === '!') {
                        this.i = j + 1;
                        const st3 = this.i;
                        j = st3;
                        while (j < this.n && isWordCh(s.charCodeAt(j))) j++;
                        w2 = s.slice(st3, j);
                    }
                    this.i = j;
                    const t2 = parseRefWord(w2);
                    if (!t2 || t2.k !== t.k) throw new PErr();
                    if (t.k === 'cell')
                        return this.mkRef(
                            sheet,
                            Math.min(t.r, t2.r),
                            Math.min(t.c, t2.c),
                            Math.max(t.r, t2.r),
                            Math.max(t.c, t2.c)
                        );
                    if (t.k === 'col') return this.mkRef(sheet, 0, Math.min(t.c, t2.c), MAXR, Math.max(t.c, t2.c));
                    return this.mkRef(sheet, Math.min(t.r, t2.r), 0, Math.max(t.r, t2.r), MAXC);
                }
                if (t.k === 'cell') return this.mkRef(sheet, t.r, t.c, t.r, t.c);
            }
            if (sheet === null) {
                const u = w.toUpperCase();
                if (u === 'TRUE') return { k: 'b', v: true };
                if (u === 'FALSE') return { k: 'b', v: false };
            }
            return { k: 'name', v: w };
        }
        call(w) {
            const args = [];
            if (++this.depth > 400) throw new PErr();
            if (this.peek() === ')') this.i++;
            else {
                for (;;) {
                    const ch = this.peek();
                    if (ch === ',' || ch === ')') args.push({ k: 'missing' });
                    else args.push(this.cmp());
                    const c2 = this.peek();
                    if (c2 === ',') {
                        this.i++;
                        continue;
                    }
                    if (c2 === ')') {
                        this.i++;
                        break;
                    }
                    throw new PErr();
                }
            }
            this.depth--;
            return { k: 'fn', name: normFn(w), args };
        }
        arrayConst() {
            this.i++;
            const rows = [];
            let row = [];
            for (;;) {
                this.ws();
                const ch = this.s[this.i];
                let neg = false,
                    node;
                if (ch === '-') {
                    neg = true;
                    this.i++;
                    this.ws();
                } else if (ch === '+') {
                    this.i++;
                    this.ws();
                }
                const c = this.s.charCodeAt(this.i);
                if (c === 34) node = { k: 's', v: this.str() };
                else if (c === 35) node = this.errLit();
                else if ((c >= 48 && c <= 57) || c === 46) node = this.number();
                else {
                    const st = this.i;
                    let j = st;
                    while (j < this.n && isWordCh(this.s.charCodeAt(j))) j++;
                    const u = this.s.slice(st, j).toUpperCase();
                    if (u === 'TRUE') node = { k: 'b', v: true };
                    else if (u === 'FALSE') node = { k: 'b', v: false };
                    else throw new PErr();
                    this.i = j;
                }
                if (node.k === 'ref') throw new PErr();
                let v = node.k === 'e' ? E(node.v) : node.v;
                if (neg) {
                    if (typeof v !== 'number') throw new PErr();
                    v = -v;
                }
                row.push(v);
                const d = this.peek();
                if (d === ',') {
                    this.i++;
                    continue;
                }
                if (d === ';') {
                    this.i++;
                    rows.push(row);
                    row = [];
                    continue;
                }
                if (d === '}') {
                    this.i++;
                    rows.push(row);
                    break;
                }
                throw new PErr();
            }
            const w = rows[0].length;
            for (const r of rows) if (r.length !== w) throw new PErr();
            return { k: 'arr', v: new Arr(rows) };
        }
    }

    const PCACHE = new Map();
    function parse(text) {
        let ast = PCACHE.get(text);
        if (ast) return ast;
        try {
            const p = new Parser(text.charCodeAt(0) === 61 ? text.slice(1) : text);
            ast = p.cmp();
            p.ws();
            if (p.i < p.n) throw new PErr();
        } catch (e) {
            if (!(e instanceof PErr)) throw e;
            ast = { k: 'e', v: '#NAME?', parseError: true, error: '#NAME?' };
        }
        if (PCACHE.size > 200000) PCACHE.clear();
        PCACHE.set(text, ast);
        return ast;
    }

    // ---------- coercion ----------
    const NUMRE = /^[+-]?\$?(?:\d+(?:,\d{3})*|\d*)(?:\.\d*)?(?:[eE][+-]?\d+)?%?$/;
    function ymdToSerial(y, m, d, d1904) {
        if (y === 1900 && m === 2 && d === 29) return d1904 ? 60 - 1462 : 60;
        const t = Date.UTC(2000, 0, 1); // keeps Date.UTC from mapping years 0-99 to 1900+
        const dt = new Date(t);
        dt.setUTCFullYear(y, m - 1, d);
        dt.setUTCHours(0, 0, 0, 0);
        let s = Math.round(dt.getTime() / 86400000) + 25569;
        if (s < 61) s -= 1;
        return d1904 ? s - 1462 : s;
    }
    function serialToYmd(s, d1904) {
        s = Math.floor(s);
        if (d1904) s += 1462;
        if (s === 60) return { y: 1900, m: 2, d: 29 };
        if (s < 0) return null;
        const real = s < 60 ? s + 1 : s;
        const dt = new Date((real - 25569) * 86400000);
        return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
    }
    function parseDateText(s, d1904) {
        s = s.trim();
        let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?$/.exec(s);
        let y,
            mo,
            d,
            tm = 0;
        if (m) {
            y = +m[1];
            mo = +m[2];
            d = +m[3];
            if (m[4] !== undefined) tm = (+m[4] * 3600 + +m[5] * 60 + +(m[6] || 0)) / 86400;
        } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s))) {
            mo = +m[1];
            d = +m[2];
            y = +m[3];
            if (m[3].length <= 2) y += y < 30 ? 2000 : 1900;
        } else if ((m = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*([aApP][mM])?$/.exec(s))) {
            let h = +m[1];
            if (m[4]) {
                if (h < 1 || h > 12) return NaN;
                h = (h % 12) + (m[4][0].toLowerCase() === 'p' ? 12 : 0);
            }
            return (h * 3600 + +m[2] * 60 + +(m[3] || 0)) / 86400;
        } else return NaN;
        if (mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
        const ser = ymdToSerial(y, mo, d, d1904);
        const chk = serialToYmd(ser, d1904);
        if (!chk || chk.d !== d) return NaN;
        return ser + tm;
    }
    function parseNumText(s) {
        if (s.length > 80) return NaN;
        s = s.trim();
        if (s === '') return NaN;
        if (NUMRE.test(s)) {
            let pct = false;
            if (s.charCodeAt(s.length - 1) === 37) {
                pct = true;
                s = s.slice(0, -1);
            }
            s = s.replace(/[$,]/g, '');
            if (s === '' || s === '+' || s === '-' || s === '.') return NaN;
            const v = +s;
            return pct ? v / 100 : v;
        }
        return NaN;
    }
    function toNum(v, d1904) {
        switch (typeof v) {
            case 'number':
                return v;
            case 'boolean':
                return v ? 1 : 0;
            case 'string': {
                let n = parseNumText(v);
                if (n !== n) n = parseDateText(v, d1904);
                return n === n ? n : VALUE;
            }
            default:
                return v === null || v === undefined ? 0 : v;
        }
    }
    function numStr(v) {
        if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
        let s = String(Number(v.toPrecision(15)));
        if (Math.abs(v) >= 1e15 && s.indexOf('e') < 0) s = Number(v.toPrecision(15)).toExponential();
        const e = s.indexOf('e');
        if (e >= 0) {
            let ex = s.slice(e + 2);
            if (ex.length < 2) ex = '0' + ex;
            s = s.slice(0, e) + 'E' + s[e + 1] + ex;
        }
        return s;
    }
    function toStr(v) {
        switch (typeof v) {
            case 'string':
                return v;
            case 'number':
                return numStr(v);
            case 'boolean':
                return v ? 'TRUE' : 'FALSE';
            default:
                return v === null || v === undefined ? '' : v;
        }
    }
    function toBool(v) {
        switch (typeof v) {
            case 'boolean':
                return v;
            case 'number':
                return v !== 0;
            case 'string': {
                const u = v.toUpperCase();
                return u === 'TRUE' ? true : u === 'FALSE' ? false : VALUE;
            }
            default:
                return v === null || v === undefined ? false : v;
        }
    }
    const typeRank = v => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
    // compare two scalar non-error values (null = empty); returns -1/0/1
    function cmpVals(a, b) {
        if (a === null || a === undefined) {
            if (b === null || b === undefined) return 0;
            a = typeof b === 'number' ? 0 : typeof b === 'string' ? '' : false;
        } else if (b === null || b === undefined) b = typeof a === 'number' ? 0 : typeof a === 'string' ? '' : false;
        const ra = typeRank(a),
            rb = typeRank(b);
        if (ra !== rb) return ra < rb ? -1 : 1;
        if (ra === 1) {
            const x = a.toLowerCase(),
                y = b.toLowerCase();
            return x < y ? -1 : x > y ? 1 : 0;
        }
        if (a === b) return 0;
        if (ra === 0) {
            const d = Math.abs(a - b);
            if (d < 1e-14 * Math.max(Math.abs(a), Math.abs(b)) && +a.toPrecision(15) === +b.toPrecision(15)) return 0;
        }
        return a < b ? -1 : 1;
    }
    function cv(cell, d1904) {
        const v = cell.v;
        if (v === null || v === undefined) return null;
        switch (cell.t) {
            case 'n':
            case 's':
                return v;
            case 'b':
                return !!v;
            case 'e':
                return E(String(v));
            case 'd':
                return typeof v === 'number'
                    ? v
                    : (() => {
                          const n = parseDateText(String(v), d1904);
                          return n === n ? n : String(v);
                      })();
            case 'z':
                return null;
            default:
                return v;
        }
    }

    function arith(op, a, b, d1904) {
        if (a instanceof XErr) return a;
        if (b instanceof XErr) return b;
        if (typeof a !== 'number') {
            a = toNum(a, d1904);
            if (a instanceof XErr) return a;
        }
        if (typeof b !== 'number') {
            b = toNum(b, d1904);
            if (b instanceof XErr) return b;
        }
        let r;
        switch (op) {
            case '+':
                r = a + b;
                if (r !== 0 && Math.abs(r) < 1e-15 * Math.max(Math.abs(a), Math.abs(b))) r = 0;
                break;
            case '-':
                r = a - b;
                if (r !== 0 && Math.abs(r) < 1e-15 * Math.max(Math.abs(a), Math.abs(b))) r = 0;
                break;
            case '*':
                r = a * b;
                break;
            case '/':
                if (b === 0) return DIV0;
                r = a / b;
                break;
            default: // ^
                if (a === 0 && b === 0) return NUM;
                if (a === 0 && b < 0) return DIV0;
                r = Math.pow(a, b);
        }
        return r !== r || r === Infinity || r === -Infinity ? NUM : r;
    }
    function binScalar(op, a, b, d1904) {
        switch (op) {
            case '+':
            case '-':
            case '*':
            case '/':
            case '^':
                return arith(op, a, b, d1904);
            case '&':
                if (a instanceof XErr) return a;
                if (b instanceof XErr) return b;
                return toStr(a) + toStr(b);
            default: {
                if (a instanceof XErr) return a;
                if (b instanceof XErr) return b;
                const c = cmpVals(a, b);
                switch (op) {
                    case '=':
                        return c === 0;
                    case '<>':
                        return c !== 0;
                    case '<':
                        return c < 0;
                    case '>':
                        return c > 0;
                    case '<=':
                        return c <= 0;
                    default:
                        return c >= 0;
                }
            }
        }
    }
    const FN = Object.create(null);

    // ---------- engine ----------
    const KR = 1048576,
        KC = 16384;
    const keyOf = (s, r, c) => (s * KR + r) * KC + c;

    function analyze(ast) {
        if (ast._refs) return ast;
        const refs = [];
        let vol = false;
        const seen = new Set();
        const stack = [ast];
        while (stack.length) {
            const n = stack.pop();
            switch (n.k) {
                case 'ref': {
                    const id = (n.sheet || '') + '|' + n.r1 + ',' + n.c1 + ',' + n.r2 + ',' + n.c2;
                    if (!seen.has(id)) {
                        seen.add(id);
                        refs.push(n);
                    }
                    break;
                }
                case 'bin':
                    stack.push(n.a, n.b);
                    break;
                case 'neg':
                case 'pos':
                case 'pct':
                case 'paren':
                    stack.push(n.a);
                    break;
                case 'rng':
                    stack.push(n.a, n.b);
                    break;
                case 'fn': {
                    const u = n.name;
                    if (
                        u === 'TODAY' ||
                        u === 'NOW' ||
                        u === 'RAND' ||
                        u === 'RANDBETWEEN' ||
                        u === 'OFFSET' ||
                        u === 'INDIRECT'
                    )
                        vol = true;
                    for (const a of n.args) stack.push(a);
                    break;
                }
            }
        }
        ast._refs = refs;
        ast._vol = vol;
        return ast;
    }

    class Calc {
        constructor(store) {
            this.store = store;
            this.names = store.sheetNames || [];
            this.d1904 = !!store.date1904;
            this.nowFn = store.now || (() => new Date());
            this.ov = new Map();
            this.cur = { sheet: 0, r: 0, c: 0 };
            this.arr = 0;
            this._sidx = new Map();
            this._ext = new Map();
            this.lc = new Map();
            this.resetGraph();
        }
        resetGraph() {
            this.fcells = new Map();
            this.cellDeps = new Map();
            this.buckets = new Map();
            this.wide = new Map();
            this.scanned = new Set();
            this.volatile = new Set();
            this.gen = 0;
        }
        reset() {
            this.ov.clear();
            this.lc.clear();
            this._sidx.clear();
            this._ext.clear();
            this.names = this.store.sheetNames || [];
            this.resetGraph();
        }
        sheetIdx(name) {
            let i = this._sidx.get(name);
            if (i !== undefined) return i;
            i = -1;
            if (this.store.sheetIndexByName) {
                const x = this.store.sheetIndexByName(name);
                i = x === undefined || x === null ? -1 : x;
            } else {
                const l = name.toLowerCase();
                for (let k = 0; k < this.names.length; k++)
                    if (this.names[k].toLowerCase() === l) {
                        i = k;
                        break;
                    }
            }
            this._sidx.set(name, i);
            return i;
        }
        extent(sh) {
            let e = this._ext.get(sh);
            if (e !== undefined) return e;
            e = null;
            if (this.store.getExtent) {
                const x = this.store.getExtent(sh);
                if (x)
                    e = {
                        rows: x.rowCount !== undefined ? x.rowCount : x.rows,
                        cols: x.colCount !== undefined ? x.colCount : x.cols
                    };
            }
            this._ext.set(sh, e);
            return e;
        }
        // ---- cell access
        cellVal(sh, r, c) {
            if (sh < 0) return REF;
            if (this.ov.size) {
                const o = this.ov.get((sh * KR + r) * KC + c);
                if (o !== undefined) return o;
            }
            const cell = this.store.getCell(sh, r, c);
            return cell ? cv(cell, this.d1904) : null;
        }
        eachCell(sh, r1, c1, r2, c2, cb) {
            const st = this.store,
                ex = this.extent(sh);
            if (ex) {
                if (r2 > ex.rows - 1) r2 = ex.rows - 1;
                if (c2 > ex.cols - 1) c2 = ex.cols - 1;
            } else if (!st.forEachCell) {
                if (r2 > r1 + 9999) r2 = r1 + 9999;
                if (c2 > c1 + 255) c2 = c1 + 255;
            }
            if (r1 > r2 || c1 > c2) return;
            const ov = this.ov,
                d = this.d1904,
                useOv = ov.size > 0,
                base = sh * KR;
            const one = (r, c, cell) => {
                let v;
                if (useOv && cell.f !== undefined) {
                    v = ov.get((base + r) * KC + c);
                    if (v === undefined) v = cv(cell, d);
                } else v = cv(cell, d);
                if (v !== null) cb(v, r, c);
            };
            if (st.forEachCell) st.forEachCell(sh, r1, c1, r2, c2, one);
            else
                for (let r = r1; r <= r2; r++)
                    for (let c = c1; c <= c2; c++) {
                        const cell = st.getCell(sh, r, c);
                        if (cell) one(r, c, cell);
                    }
        }
        // dense materialization (null = empty); whole row/col refs clamp to used extent
        toArr(ref) {
            let { sheet: sh, r1, c1, r2, c2 } = ref;
            if (sh < 0) return null;
            if (r2 === MAXR || c2 === MAXC) {
                const ex = this.extent(sh);
                if (ex) {
                    r2 = Math.min(r2, Math.max(ex.rows - 1, r1));
                    c2 = Math.min(c2, Math.max(ex.cols - 1, c1));
                } else {
                    r2 = Math.min(r2, r1 + 9999);
                    c2 = Math.min(c2, c1 + 255);
                }
            }
            const nr = r2 - r1 + 1,
                nc = c2 - c1 + 1,
                rows = new Array(nr);
            for (let i = 0; i < nr; i++) {
                const row = new Array(nc);
                for (let j = 0; j < nc; j++) row[j] = null;
                rows[i] = row;
            }
            this.eachCell(sh, r1, c1, r2, c2, (v, r, c) => {
                rows[r - r1][c - c1] = v;
            });
            const a = new Arr(rows);
            return a;
        }
        // ---- evaluation
        sc(v) {
            if (v instanceof Ref) {
                if (v.sheet < 0) return REF;
                if (v.r1 === v.r2 && v.c1 === v.c2) return this.cellVal(v.sheet, v.r1, v.c1);
                const cur = this.cur;
                if (v.c1 === v.c2 && cur.r >= v.r1 && cur.r <= v.r2) return this.cellVal(v.sheet, cur.r, v.c1);
                if (v.r1 === v.r2 && cur.c >= v.c1 && cur.c <= v.c2) return this.cellVal(v.sheet, v.r1, cur.c);
                return VALUE;
            }
            if (v instanceof Arr) return v.nr && v.nc ? v.rows[0][0] : VALUE;
            return v;
        }
        refSheet(n) {
            return n.sheet === null ? this.cur.sheet : this.sheetIdx(n.sheet);
        }
        evs(n) {
            if (n.k === 'ref' && n.r1 === n.r2 && n.c1 === n.c2) return this.cellVal(this.refSheet(n), n.r1, n.c1);
            const v = this.ev(n);
            return v instanceof Ref ? this.sc(v) : v;
        }
        ev(n) {
            switch (n.k) {
                case 'n':
                case 's':
                case 'b':
                    return n.v;
                case 'e':
                    return E(n.v);
                case 'arr':
                    return n.v;
                case 'paren':
                    return this.ev(n.a);
                case 'ref': {
                    const sh = this.refSheet(n);
                    return sh < 0 ? REF : new Ref(sh, n.r1, n.c1, n.r2, n.c2);
                }
                case 'name':
                    return NAME;
                case 'missing':
                    return undefined;
                case 'rng': {
                    const a = this.ev(n.a),
                        b = this.ev(n.b);
                    if (!(a instanceof Ref) || !(b instanceof Ref))
                        return a instanceof XErr ? a : b instanceof XErr ? b : VALUE;
                    if (a.sheet !== b.sheet) return VALUE;
                    return new Ref(
                        a.sheet,
                        Math.min(a.r1, b.r1),
                        Math.min(a.c1, b.c1),
                        Math.max(a.r2, b.r2),
                        Math.max(a.c2, b.c2)
                    );
                }
                case 'neg':
                case 'pos':
                case 'pct':
                    return this.unaryOp(n);
                case 'bin':
                    return this.bin(n);
                case 'fn':
                    return this.callFn(n);
            }
            return VALUE;
        }
        unaryOp(n) {
            const v = n.k === 'pos' ? this.ev(n.a) : this.evs0(n.a);
            if (n.k === 'pos') return v instanceof Ref && this.arr === 0 ? this.sc(v) : v;
            if (v instanceof Arr || (v instanceof Ref && this.arr > 0 && !(v.r1 === v.r2 && v.c1 === v.c2))) {
                const a = v instanceof Ref ? this.toArr(v) : v;
                return mapArr(a, x => this.unScalar(n.k, x));
            }
            return this.unScalar(n.k, v instanceof Ref ? this.sc(v) : v);
        }
        evs0(n) {
            return n.k === 'ref' && n.r1 === n.r2 && n.c1 === n.c2
                ? this.cellVal(this.refSheet(n), n.r1, n.c1)
                : this.ev(n);
        }
        unScalar(k, x) {
            if (x instanceof XErr) return x;
            const v = toNum(x, this.d1904);
            if (v instanceof XErr) return v;
            return k === 'neg' ? (v === 0 ? 0 : -v) : v / 100;
        }
        bin(n) {
            const a = this.evs0(n.a),
                b = this.evs0(n.b);
            if (a instanceof Ref || a instanceof Arr || b instanceof Ref || b instanceof Arr)
                return this.binMixed(n.op, a, b);
            return binScalar(n.op, a, b, this.d1904);
        }
        binMixed(op, a, b) {
            const aA = a instanceof Arr,
                bA = b instanceof Arr;
            const aR = a instanceof Ref && !(a.r1 === a.r2 && a.c1 === a.c2),
                bR = b instanceof Ref && !(b.r1 === b.r2 && b.c1 === b.c2);
            if (!(aA || bA) && !(this.arr > 0 && (aR || bR))) {
                return binScalar(op, a instanceof Ref ? this.sc(a) : a, b instanceof Ref ? this.sc(b) : b, this.d1904);
            }
            const A = a instanceof Ref ? this.toArr(a) : a,
                B = b instanceof Ref ? this.toArr(b) : b;
            return broadcast([A, B], (x, y) => binScalar(op, x, y, this.d1904));
        }
        callFn(n) {
            const def = FN[n.name];
            if (!def) return NAME;
            const an = n.args;
            if (an.length < def.min || an.length > def.max) return VALUE;
            if (def.lazy) return def.f.call(this, an);
            const args = new Array(an.length);
            if (def.arr) this.arr++;
            for (let i = 0; i < an.length; i++) args[i] = this.ev(an[i]);
            if (def.arr) this.arr--;
            return def.f.call(this, args);
        }
        finish(v) {
            if (v instanceof Ref) {
                if (v.sheet < 0) v = REF;
                else v = this.arr > 0 ? this.cellVal(v.sheet, v.r1, v.c1) : this.sc(v);
            } else if (v instanceof Arr) v = v.nr && v.nc ? v.rows[0][0] : VALUE;
            return v === null || v === undefined ? 0 : v;
        }
        run(sheet, r, c, ast, array) {
            const cur = this.cur;
            cur.sheet = sheet;
            cur.r = r;
            cur.c = c;
            this.arr = array ? 1 : 0;
            let v;
            try {
                v = ast.parseError ? NAME : this.finish(this.ev(ast));
            } catch (e) {
                if (e instanceof RangeError) v = VALUE;
                else throw e;
            }
            if (typeof v === 'number' && !isFinite(v)) v = NUM;
            return v;
        }
        evaluate(sheet, r, c, text, opts) {
            this.lc.clear();
            return toResult(this.run(sheet, r, c, parse(text), opts && opts.array));
        }
        // array (CSE) formula -> matrix of {t,v}; result is never written anywhere, the host decides which member cells to update
        evaluateMatrix(sheet, r, c, text) {
            this.lc.clear();
            const cur = this.cur;
            cur.sheet = sheet;
            cur.r = r;
            cur.c = c;
            this.arr = 1;
            const ast = parse(text);
            let v;
            try {
                v = ast.parseError ? NAME : this.ev(ast);
            } catch (e) {
                if (e instanceof RangeError) v = VALUE;
                else throw e;
            }
            if (v instanceof Ref) v = v.sheet < 0 ? REF : this.toArr(v);
            const fix = x => {
                if (x === null || x === undefined) x = 0;
                if (typeof x === 'number' && !isFinite(x)) x = NUM;
                return toResult(x);
            };
            if (v instanceof Arr) return v.rows.map(row => row.map(fix));
            return [[fix(v)]];
        }
        parse(text) {
            return parse(text);
        }
    }
    function toResult(v) {
        switch (typeof v) {
            case 'number':
                return { t: 'n', v };
            case 'string':
                return { t: 's', v };
            case 'boolean':
                return { t: 'b', v };
            default:
                return { t: 'e', v: v.e };
        }
    }
    function mapArr(a, f) {
        const rows = new Array(a.nr);
        for (let i = 0; i < a.nr; i++) {
            const src = a.rows[i],
                row = new Array(a.nc);
            for (let j = 0; j < a.nc; j++) row[j] = f(src[j]);
            rows[i] = row;
        }
        return new Arr(rows);
    }
    // elementwise over scalars/Arr with 1xN / Nx1 broadcasting; out of range -> #N/A
    function broadcast(items, f) {
        let nr = 1,
            nc = 1;
        for (const x of items)
            if (x instanceof Arr) {
                if (x.nr > nr) nr = x.nr;
                if (x.nc > nc) nc = x.nc;
            }
        const rows = new Array(nr),
            n = items.length,
            vals = new Array(n);
        for (let i = 0; i < nr; i++) {
            const row = new Array(nc);
            for (let j = 0; j < nc; j++) {
                let bad = false;
                for (let k = 0; k < n; k++) {
                    const x = items[k];
                    if (x instanceof Arr) {
                        const ii = x.nr === 1 ? 0 : i,
                            jj = x.nc === 1 ? 0 : j;
                        if (ii >= x.nr || jj >= x.nc) {
                            bad = true;
                            break;
                        }
                        vals[k] = x.rows[ii][jj];
                    } else vals[k] = x;
                }
                row[j] = bad ? NA : f.apply(null, vals);
            }
            rows[i] = row;
        }
        return new Arr(rows);
    }

    // ---------- dependency graph ----------
    const WIDE = 64;
    const P = Calc.prototype;
    P.cellFormulaText = function (cell) {
        return cell && typeof cell.f === 'string' && cell.f !== '' ? cell.f : null;
    };
    P.scanSheet = function (sh) {
        if (this.scanned.has(sh)) return;
        this.scanned.add(sh);
        const st = this.store,
            ex = this.extent(sh);
        if (!ex) return;
        const add = (r, c, cell) => {
            if (cell.f !== undefined && cell.f !== null && cell.f !== '') this.register(sh, r, c, cell);
        };
        if (st.forEachCell) st.forEachCell(sh, 0, 0, ex.rows - 1, ex.cols - 1, add);
        else
            for (let r = 0; r < ex.rows; r++)
                for (let c = 0; c < ex.cols; c++) {
                    const cell = st.getCell(sh, r, c);
                    if (cell) add(r, c, cell);
                }
    };
    P.ensureScanned = function () {
        const n = this.names.length || 1;
        for (let s = 0; s < n; s++) this.scanSheet(s);
    };
    P.register = function (sh, r, c, cell) {
        const key = keyOf(sh, r, c),
            text = cell.f;
        let F = this.fcells.get(key);
        if (F && F.text === text) {
            F.arr = !!(cell.fa || cell.arr || cell.array);
            return F;
        }
        if (F) this.unregisterF(F);
        const ast = analyze(parse(text));
        F = {
            key,
            sheet: sh,
            r,
            c,
            text,
            ast,
            arr: !!(cell.fa || cell.arr || cell.array),
            cellRefs: [],
            rangeRefs: []
        };
        this.fcells.set(key, F);
        if (ast._vol) this.volatile.add(key);
        for (const n of ast._refs) {
            const ts = n.sheet === null ? sh : this.sheetIdx(n.sheet);
            if (ts < 0) continue;
            const area = (n.r2 - n.r1 + 1) * (n.c2 - n.c1 + 1);
            if (area <= 8) {
                for (let rr = n.r1; rr <= n.r2; rr++)
                    for (let cc = n.c1; cc <= n.c2; cc++) {
                        const pk = keyOf(ts, rr, cc),
                            cur = this.cellDeps.get(pk);
                        if (cur === undefined) this.cellDeps.set(pk, key);
                        else if (typeof cur === 'number') {
                            if (cur !== key) this.cellDeps.set(pk, [cur, key]);
                        } else if (cur[cur.length - 1] !== key) cur.push(key);
                        F.cellRefs.push(pk);
                    }
            } else {
                const ent = { sheet: ts, r1: n.r1, c1: n.c1, r2: n.r2, c2: n.c2, f: key, dead: false };
                F.rangeRefs.push(ent);
                if (n.c2 - n.c1 >= WIDE) {
                    let w = this.wide.get(ts);
                    if (!w) this.wide.set(ts, (w = []));
                    w.push(ent);
                } else
                    for (let cc = n.c1; cc <= n.c2; cc++) {
                        const bk = ts * KC + cc;
                        let b = this.buckets.get(bk);
                        if (!b) this.buckets.set(bk, (b = { items: [], sorted: true, pm: null }));
                        b.items.push(ent);
                        b.sorted = false;
                    }
            }
        }
        return F;
    };
    P.unregisterF = function (F) {
        this.fcells.delete(F.key);
        this.volatile.delete(F.key);
        for (const pk of F.cellRefs) {
            const cur = this.cellDeps.get(pk);
            if (cur === undefined) continue;
            if (typeof cur === 'number') {
                if (cur === F.key) this.cellDeps.delete(pk);
            } else {
                const i = cur.indexOf(F.key);
                if (i >= 0) cur.splice(i, 1);
                if (cur.length === 1) this.cellDeps.set(pk, cur[0]);
                else if (!cur.length) this.cellDeps.delete(pk);
            }
        }
        for (const e of F.rangeRefs) e.dead = true;
        F.cellRefs = [];
        F.rangeRefs = [];
    };
    function sortBucket(b) {
        const items = b.items.filter(e => !e.dead);
        items.sort((x, y) => x.r1 - y.r1);
        const pm = new Array(items.length);
        let m = -1;
        for (let i = 0; i < items.length; i++) {
            if (items[i].r2 > m) m = items[i].r2;
            pm[i] = m;
        }
        b.items = items;
        b.pm = pm;
        b.sorted = true;
    }
    // collect dependents of cell into out (array of formula keys)
    P.dependentsOf = function (sh, r, c, out) {
        const cur = this.cellDeps.get(keyOf(sh, r, c));
        if (cur !== undefined) {
            if (typeof cur === 'number') out.push(cur);
            else for (let i = 0; i < cur.length; i++) out.push(cur[i]);
        }
        const b = this.buckets.get(sh * KC + c);
        if (b) {
            if (!b.sorted) sortBucket(b);
            const it = b.items,
                pm = b.pm;
            let lo = 0,
                hi = it.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (it[mid].r1 <= r) lo = mid + 1;
                else hi = mid;
            }
            for (let i = lo - 1; i >= 0 && pm[i] >= r; i--) {
                const e = it[i];
                if (!e.dead && e.r2 >= r) out.push(e.f);
            }
        }
        const w = this.wide.get(sh);
        if (w)
            for (let i = 0; i < w.length; i++) {
                const e = w[i];
                if (!e.dead && r >= e.r1 && r <= e.r2 && c >= e.c1 && c <= e.c2) out.push(e.f);
            }
    };
    P.invalidate = function () {
        this.reset();
    };

    P.recalcDependents = function (changed, opts) {
        opts = opts || {};
        const cap = opts.maxEvals || 2000000,
            budget = opts.timeBudgetMs || 0;
        const t0 = budget ? Date.now() : 0;
        this.ensureScanned();
        this.lc.clear();
        const nodes = new Map(); // fkey -> node
        const queue = [];
        const mk = F => {
            let nd = nodes.get(F.key);
            if (!nd) {
                nd = { F, indeg: 0, out: [], done: false };
                nodes.set(F.key, nd);
                queue.push(nd);
            }
            return nd;
        };
        const plain = [];
        for (const ch of changed) {
            const key = keyOf(ch.sheet, ch.r, ch.c);
            this.ov.delete(key);
            const cell = this.store.getCell(ch.sheet, ch.r, ch.c);
            if (this.cellFormulaText(cell)) mk(this.register(ch.sheet, ch.r, ch.c, cell));
            else {
                const F = this.fcells.get(key);
                if (F) this.unregisterF(F);
                plain.push(ch);
            }
        }
        if (opts.volatile !== false)
            for (const k of this.volatile) {
                const F = this.fcells.get(k);
                if (F) mk(F);
            }
        const seen = new Map();
        let stamp = 0,
            edgeWork = 0,
            partial = false;
        const tmp = [];
        const expand = (sh, r, c, src) => {
            tmp.length = 0;
            this.dependentsOf(sh, r, c, tmp);
            stamp++;
            for (let i = 0; i < tmp.length; i++) {
                const fk = tmp[i];
                if (seen.get(fk) === stamp) continue;
                seen.set(fk, stamp);
                const F = this.fcells.get(fk);
                if (!F) continue;
                const nd = mk(F);
                if (src) {
                    src.out.push(nd);
                    nd.indeg++;
                }
            }
            edgeWork += tmp.length;
        };
        for (const ch of plain) expand(ch.sheet, ch.r, ch.c, null);
        for (let qi = 0; qi < queue.length; qi++) {
            const nd = queue[qi];
            expand(nd.F.sheet, nd.F.r, nd.F.c, nd);
            if (edgeWork > cap * 8) {
                partial = true;
                break;
            }
        }
        const results = new Map(),
            arrays = [];
        let evals = 0,
            circ = 0;
        const ready = [];
        for (const nd of queue) if (nd.indeg === 0) ready.push(nd);
        let rp = 0;
        const pending = [];
        if (!partial) {
            while (rp < ready.length) {
                if (evals >= cap || (budget && (evals & 255) === 0 && Date.now() - t0 > budget)) {
                    partial = true;
                    break;
                }
                const nd = ready[rp++],
                    F = nd.F;
                const v = this.run(F.sheet, F.r, F.c, F.ast, F.arr);
                this.ov.set(F.key, v);
                evals++;
                const res = toResult(v);
                res.sheet = F.sheet;
                res.r = F.r;
                res.c = F.c;
                if (F.arr) {
                    res.array = true;
                    arrays.push({ sheet: F.sheet, r: F.r, c: F.c });
                }
                results.set(F.sheet + ',' + F.r + ',' + F.c, res);
                nd.done = true;
                for (let i = 0; i < nd.out.length; i++) {
                    const o = nd.out[i];
                    if (--o.indeg === 0) ready.push(o);
                }
            }
        }
        if (partial) {
            for (const nd of queue) if (!nd.done) pending.push({ sheet: nd.F.sheet, r: nd.F.r, c: nd.F.c });
        } else if (rp < queue.length) {
            for (const nd of queue)
                if (!nd.done) {
                    const F = nd.F;
                    this.ov.set(F.key, CIRC);
                    circ++;
                    results.set(F.sheet + ',' + F.r + ',' + F.c, {
                        t: 'e',
                        v: '#CIRC!',
                        circular: true,
                        sheet: F.sheet,
                        r: F.r,
                        c: F.c
                    });
                }
        }
        results.arrays = arrays;
        results.partial = partial;
        results.pending = pending;
        results.evals = evals;
        results.circular = circ;
        return results;
    };
    P.recalcAll = function (opts) {
        this.ensureScanned();
        const list = [];
        for (const F of this.fcells.values()) list.push({ sheet: F.sheet, r: F.r, c: F.c });
        return this.recalcDependents(list, opts);
    };

    // ---------- function helpers ----------
    function def(names, min, max, f, o) {
        for (const n of names.split(' ')) FN[n] = Object.assign({ f, min, max }, o);
    }
    // scalar function: args auto-resolved (implicit intersection) or lifted elementwise over arrays
    function defS(names, min, max, impl, o) {
        const raw = o && o.raw;
        const f = function (args) {
            const n = args.length;
            let lift = false;
            for (let i = 0; i < n; i++) {
                const a = args[i];
                if (a instanceof Arr || (this.arr > 0 && a instanceof Ref && !(a.r1 === a.r2 && a.c1 === a.c2))) {
                    lift = true;
                    break;
                }
            }
            if (!lift) {
                for (let i = 0; i < n; i++) {
                    let a = args[i];
                    if (a instanceof Ref) a = this.sc(a);
                    if (!raw && a instanceof XErr) return a;
                    args[i] = a;
                }
                return impl.apply(this, args);
            }
            const items = args.map(a => (a instanceof Ref ? this.toArr(a) : a));
            return broadcast(items, (...v) => {
                if (!raw) for (const x of v) if (x instanceof XErr) return x;
                return impl.apply(this, v);
            });
        };
        def(names, min, max, f, o);
    }
    function walk(eng, args, f) {
        let err = null;
        const cb = v => {
            if (err === null) {
                const r = f(v, false);
                if (r) err = r;
            }
        };
        for (let i = 0; i < args.length && err === null; i++) {
            const a = args[i];
            if (a instanceof Ref) {
                if (a.sheet < 0) return REF;
                eng.eachCell(a.sheet, a.r1, a.c1, a.r2, a.c2, cb);
            } else if (a instanceof Arr) {
                for (let r = 0; r < a.nr; r++) {
                    const row = a.rows[r];
                    for (let c = 0; c < a.nc; c++) if (row[c] !== null) cb(row[c]);
                }
            } else {
                const r = f(a === undefined ? null : a, true);
                if (r) err = r;
            }
        }
        return err;
    }
    // numbers as an array (reference text/bools ignored, direct args coerced)
    function collectNums(eng, args) {
        const out = [];
        const err = walk(eng, args, (v, d) => {
            if (typeof v === 'number') out.push(v);
            else if (v instanceof XErr) return v;
            else if (d) {
                if (typeof v === 'boolean') out.push(v ? 1 : 0);
                else if (typeof v === 'string') {
                    const n = toNum(v, eng.d1904);
                    if (n instanceof XErr) return n;
                    out.push(n);
                } else if (v === null) out.push(0);
            }
            return null;
        });
        return err || out;
    }
    function numArg(eng, v) {
        if (v instanceof XErr) return v;
        return toNum(v, eng.d1904);
    }
    function intArg(eng, v) {
        const n = numArg(eng, v);
        return n instanceof XErr ? n : Math.trunc(n);
    }
    function roundDig(x, d, mode) {
        if (!isFinite(x)) return x;
        const neg = x < 0,
            a = Math.abs(x);
        let s = String(a),
            r;
        const fn = mode === 0 ? Math.round : mode === 1 ? Math.ceil : Math.floor;
        if (s.indexOf('e') >= 0 || d > 300 || d < -300) {
            const m = Math.pow(10, d);
            r = fn(a * m) / m;
        } else {
            r = Number(fn(Number(s + 'e' + d)) + 'e' + -d);
        }
        return neg ? -r : r;
    }
    function chk(v) {
        return v !== v || v === Infinity || v === -Infinity ? NUM : v;
    }

    // ---------- criteria ----------
    function wildMatch(pat, s) {
        // pat tokens: prebuilt array; s lowercased
        let pi = 0,
            si = 0,
            star = -1,
            mark = 0;
        const pn = pat.length,
            sn = s.length;
        while (si < sn) {
            if (pi < pn && pat[pi] === 1) {
                star = pi++;
                mark = si;
            } else if (pi < pn && (pat[pi] === 2 || pat[pi] === s[si])) {
                pi++;
                si++;
            } else if (star >= 0) {
                pi = star + 1;
                si = ++mark;
            } else return false;
        }
        while (pi < pn && pat[pi] === 1) pi++;
        return pi === pn;
    }
    function wildTokens(t) {
        const out = [];
        let hasW = false;
        for (let i = 0; i < t.length; i++) {
            const ch = t[i];
            if (ch === '~' && i + 1 < t.length && (t[i + 1] === '*' || t[i + 1] === '?' || t[i + 1] === '~')) {
                out.push(t[++i]);
                hasW = true;
            } else if (ch === '*') {
                out.push(1);
                hasW = true;
            } else if (ch === '?') {
                out.push(2);
                hasW = true;
            } else out.push(ch);
        }
        return hasW ? out : null;
    }
    function makeCrit(crit, d1904) {
        let f,
            me = false;
        if (crit instanceof XErr) {
            f = v => v instanceof XErr && v.e === crit.e;
        } else if (typeof crit === 'number') f = numPred('=', crit);
        else if (typeof crit === 'boolean') f = v => v === crit;
        else if (crit === null || crit === undefined) f = numPred('=', 0);
        else {
            let t = crit,
                op = '=';
            const c0 = t[0],
                c1 = t[1];
            if (c0 === '>' || c0 === '<' || c0 === '=') {
                if (c0 === '>' && c1 === '=') {
                    op = '>=';
                    t = t.slice(2);
                } else if (c0 === '<' && c1 === '=') {
                    op = '<=';
                    t = t.slice(2);
                } else if (c0 === '<' && c1 === '>') {
                    op = '<>';
                    t = t.slice(2);
                } else {
                    op = c0;
                    t = t.slice(1);
                }
            }
            const u = t.toUpperCase();
            let n = t === '' ? NaN : parseNumText(t);
            if (n !== n && t !== '') n = parseDateText(t, d1904);
            if (n === n) {
                f = numPred(op, n);
                me = op === '<>';
            } else if (u === 'TRUE' || u === 'FALSE') {
                const b = u === 'TRUE';
                f = op === '<>' ? v => v !== b : v => v === b;
                me = op === '<>';
            } else if (t[0] === '#' && ERR_LITS.indexOf(u) >= 0) {
                f = op === '<>' ? v => !(v instanceof XErr && v.e === u) : v => v instanceof XErr && v.e === u;
                me = op === '<>';
            } else if (t === '') {
                if (op === '=') {
                    f = v => v === null || v === '';
                    me = true;
                } else if (op === '<>') f = v => v !== null && v !== '';
                else f = () => false;
            } else {
                const lt = t.toLowerCase(),
                    tok = wildTokens(lt);
                const eq = tok
                    ? v => typeof v === 'string' && wildMatch(tok, v.toLowerCase())
                    : v => typeof v === 'string' && v.toLowerCase() === lt;
                if (op === '=') f = eq;
                else if (op === '<>') {
                    f = v => !eq(v);
                    me = true;
                } else {
                    f = v => {
                        if (typeof v !== 'string') return false;
                        const x = v.toLowerCase();
                        return op === '>' ? x > lt : op === '<' ? x < lt : op === '>=' ? x >= lt : x <= lt;
                    };
                }
            }
        }
        f.me = me || crit === '' || crit === '=';
        return f;
    }
    function numPred(op, n) {
        switch (op) {
            case '=':
                return v => (typeof v === 'number' ? v === n : typeof v === 'string' && parseNumText(v) === n);
            case '<>':
                return v => (typeof v === 'number' ? v !== n : !(typeof v === 'string' && parseNumText(v) === n));
            case '>':
                return v => typeof v === 'number' && v > n;
            case '<':
                return v => typeof v === 'number' && v < n;
            case '>=':
                return v => typeof v === 'number' && v >= n;
            default:
                return v => typeof v === 'number' && v <= n;
        }
    }
    // iterate positions satisfying all (range,crit) pairs; cb(di, dj). Returns error or null.
    function ifsIter(eng, ranges, crits, cb) {
        const preds = [];
        let nr = 0,
            nc = 0;
        for (let k = 0; k < ranges.length; k++) {
            const R = ranges[k];
            if (!(R instanceof Ref)) return VALUE;
            if (R.sheet < 0) return REF;
            const h = R.r2 - R.r1 + 1,
                w = R.c2 - R.c1 + 1;
            if (k === 0) {
                nr = h;
                nc = w;
            } else if (h !== nr || w !== nc) return VALUE;
            const cr = crits[k] instanceof Ref ? eng.sc(crits[k]) : crits[k];
            preds.push(makeCrit(cr, eng.d1904));
        }
        // clamp whole-line refs to used extent (max over ranges)
        let er = 0,
            ec = 0;
        for (const R of ranges) {
            const ex = eng.extent(R.sheet);
            const rr = ex ? Math.min(R.r2, Math.max(ex.rows - 1, R.r1)) - R.r1 + 1 : Math.min(nr, 10000);
            const cc = ex ? Math.min(R.c2, Math.max(ex.cols - 1, R.c1)) - R.c1 + 1 : Math.min(nc, 256);
            if (rr > er) er = rr;
            if (cc > ec) ec = cc;
        }
        if (er > nr) er = nr;
        if (ec > nc) ec = nc;
        const R0 = ranges[0];
        const test = (di, dj) => {
            for (let k = 1; k < preds.length; k++) {
                const R = ranges[k];
                if (!preds[k](eng.cellVal(R.sheet, R.r1 + di, R.c1 + dj))) return;
            }
            cb(di, dj);
        };
        if (preds[0].me) {
            for (let di = 0; di < er; di++)
                for (let dj = 0; dj < ec; dj++)
                    if (preds[0](eng.cellVal(R0.sheet, R0.r1 + di, R0.c1 + dj))) test(di, dj);
        } else {
            eng.eachCell(R0.sheet, R0.r1, R0.c1, R0.r1 + er - 1, R0.c1 + ec - 1, (v, r, c) => {
                if (preds[0](v)) test(r - R0.r1, c - R0.c1);
            });
        }
        return null;
    }

    // ---------- math / statistical ----------
    def('SUM', 1, 255, function (args) {
        let s = 0;
        const err = walk(this, args, (v, d) => {
            if (typeof v === 'number') s += v;
            else if (v instanceof XErr) return v;
            else if (d) {
                if (typeof v === 'boolean') s += v ? 1 : 0;
                else if (typeof v === 'string') {
                    const n = toNum(v, this.d1904);
                    if (n instanceof XErr) return n;
                    s += n;
                }
            }
            return null;
        });
        return err || chk(s);
    });
    def('PRODUCT', 1, 255, function (args) {
        const a = collectNums(this, args);
        if (a instanceof XErr) return a;
        if (!a.length) return 0;
        let p = 1;
        for (const x of a) p *= x;
        return chk(p);
    });
    def('SUMSQ', 1, 255, function (args) {
        const a = collectNums(this, args);
        if (a instanceof XErr) return a;
        let s = 0;
        for (const x of a) s += x * x;
        return chk(s);
    });
    def('AVERAGE', 1, 255, function (args) {
        let s = 0,
            n = 0;
        const err = walk(this, args, (v, d) => {
            if (typeof v === 'number') {
                s += v;
                n++;
            } else if (v instanceof XErr) return v;
            else if (d) {
                if (typeof v === 'boolean') {
                    s += v ? 1 : 0;
                    n++;
                } else if (typeof v === 'string') {
                    const x = toNum(v, this.d1904);
                    if (x instanceof XErr) return x;
                    s += x;
                    n++;
                }
            }
            return null;
        });
        return err || (n === 0 ? DIV0 : s / n);
    });
    function minmax(isMax) {
        return function (args) {
            let m = null;
            const err = walk(this, args, (v, d) => {
                let x;
                if (typeof v === 'number') x = v;
                else if (v instanceof XErr) return v;
                else if (d) {
                    if (typeof v === 'boolean') x = v ? 1 : 0;
                    else if (typeof v === 'string') {
                        x = toNum(v, this.d1904);
                        if (x instanceof XErr) return x;
                    } else return null;
                } else return null;
                if (m === null || (isMax ? x > m : x < m)) m = x;
                return null;
            });
            return err || (m === null ? 0 : m);
        };
    }
    def('MAX', 1, 255, minmax(true));
    def('MIN', 1, 255, minmax(false));
    def('COUNT', 1, 255, function (args) {
        let n = 0;
        walk(this, args, (v, d) => {
            if (typeof v === 'number') n++;
            else if (
                d &&
                (typeof v === 'boolean' || (typeof v === 'string' && !(toNum(v, this.d1904) instanceof XErr)))
            )
                n++;
            return null;
        });
        return n;
    });
    def('COUNTA', 1, 255, function (args) {
        let n = 0;
        walk(this, args, (v, d) => {
            if (d && v === null) return null;
            n++;
            return null;
        });
        return n;
    });
    def('COUNTBLANK', 1, 1, function (args) {
        const a = args[0];
        if (a instanceof Ref) {
            if (a.sheet < 0) return REF;
            const ex = this.extent(a.sheet);
            let r2 = a.r2,
                c2 = a.c2;
            if (ex) {
                r2 = Math.min(r2, Math.max(ex.rows - 1, a.r1));
                c2 = Math.min(c2, Math.max(ex.cols - 1, a.c1));
            }
            let total = (r2 - a.r1 + 1) * (c2 - a.c1 + 1),
                non = 0;
            this.eachCell(a.sheet, a.r1, a.c1, r2, c2, v => {
                if (v !== '') non++;
            });
            return total - non;
        }
        if (a instanceof Arr) {
            let n = 0;
            for (const row of a.rows) for (const v of row) if (v === null || v === '') n++;
            return n;
        }
        return a === null || a === '' || a === undefined ? 1 : 0;
    });
    defS('ABS', 1, 1, function (a) {
        const n = numArg(this, a);
        return n instanceof XErr ? n : Math.abs(n);
    });
    function rounder(mode) {
        return function (a, d) {
            const n = numArg(this, a);
            if (n instanceof XErr) return n;
            const dg = intArg(this, d === undefined ? 0 : d);
            if (dg instanceof XErr) return dg;
            return chk(roundDig(n, dg, mode));
        };
    }
    defS('ROUND', 2, 2, rounder(0));
    defS('ROUNDUP', 2, 2, function (a, d) {
        // away from zero
        const n = numArg(this, a);
        if (n instanceof XErr) return n;
        const dg = intArg(this, d);
        if (dg instanceof XErr) return dg;
        return chk(n < 0 ? -roundDig(-n, dg, 1) : roundDig(n, dg, 1));
    });
    defS('ROUNDDOWN', 2, 2, function (a, d) {
        const n = numArg(this, a);
        if (n instanceof XErr) return n;
        const dg = intArg(this, d);
        if (dg instanceof XErr) return dg;
        return chk(n < 0 ? -roundDig(-n, dg, 2) : roundDig(n, dg, 2));
    });
    defS('TRUNC', 1, 2, function (a, d) {
        const n = numArg(this, a);
        if (n instanceof XErr) return n;
        const dg = intArg(this, d === undefined ? 0 : d);
        if (dg instanceof XErr) return dg;
        return chk(n < 0 ? -roundDig(-n, dg, 2) : roundDig(n, dg, 2));
    });
    defS('INT', 1, 1, function (a) {
        const n = numArg(this, a);
        return n instanceof XErr ? n : Math.floor(n);
    });
    defS('MOD', 2, 2, function (a, b) {
        const n = numArg(this, a),
            d = numArg(this, b);
        if (n instanceof XErr) return n;
        if (d instanceof XErr) return d;
        if (d === 0) return DIV0;
        let r = n % d;
        if (r !== 0 && r < 0 !== d < 0) r += d;
        return r;
    });
    defS('POWER', 2, 2, function (a, b) {
        return arith('^', a, b, this.d1904);
    });
    defS('SQRT', 1, 1, function (a) {
        const n = numArg(this, a);
        return n instanceof XErr ? n : n < 0 ? NUM : Math.sqrt(n);
    });
    defS('EXP', 1, 1, function (a) {
        const n = numArg(this, a);
        return n instanceof XErr ? n : chk(Math.exp(n));
    });
    defS('LN', 1, 1, function (a) {
        const n = numArg(this, a);
        return n instanceof XErr ? n : n <= 0 ? NUM : Math.log(n);
    });
    defS('LOG10', 1, 1, function (a) {
        const n = numArg(this, a);
        return n instanceof XErr ? n : n <= 0 ? NUM : Math.log10(n);
    });
    defS('LOG', 1, 2, function (a, b) {
        const n = numArg(this, a);
        if (n instanceof XErr) return n;
        const base = b === undefined ? 10 : numArg(this, b);
        if (base instanceof XErr) return base;
        if (n <= 0 || base <= 0) return NUM;
        if (base === 1) return DIV0;
        return base === 10 ? Math.log10(n) : Math.log(n) / Math.log(base);
    });
    defS('SIGN', 1, 1, function (a) {
        const n = numArg(this, a);
        return n instanceof XErr ? n : n > 0 ? 1 : n < 0 ? -1 : 0;
    });
    defS('CEILING', 1, 2, function (a, b) {
        const n = numArg(this, a),
            s = b === undefined ? 1 : numArg(this, b);
        if (n instanceof XErr) return n;
        if (s instanceof XErr) return s;
        if (s === 0) return 0;
        if (n > 0 && s < 0) return NUM;
        return chk(Math.ceil(+(n / s).toPrecision(14)) * s);
    });
    defS('FLOOR', 1, 2, function (a, b) {
        const n = numArg(this, a),
            s = b === undefined ? 1 : numArg(this, b);
        if (n instanceof XErr) return n;
        if (s instanceof XErr) return s;
        if (s === 0) return DIV0;
        if (n > 0 && s < 0) return NUM;
        return chk(Math.floor(+(n / s).toPrecision(14)) * s);
    });
    defS('CEILING.MATH', 1, 3, function (a, b, m) {
        const n = numArg(this, a);
        if (n instanceof XErr) return n;
        let s = b === undefined ? 1 : numArg(this, b);
        if (s instanceof XErr) return s;
        s = Math.abs(s);
        const md = m === undefined ? 0 : numArg(this, m);
        if (md instanceof XErr) return md;
        if (s === 0) return 0;
        const q = +(n / s).toPrecision(14);
        return n >= 0 || md === 0 ? Math.ceil(q) * s : Math.floor(q) * s;
    });
    defS('FLOOR.MATH', 1, 3, function (a, b, m) {
        const n = numArg(this, a);
        if (n instanceof XErr) return n;
        let s = b === undefined ? 1 : numArg(this, b);
        if (s instanceof XErr) return s;
        s = Math.abs(s);
        const md = m === undefined ? 0 : numArg(this, m);
        if (md instanceof XErr) return md;
        if (s === 0) return 0;
        const q = +(n / s).toPrecision(14);
        return n >= 0 || md === 0 ? Math.floor(q) * s : Math.ceil(q) * s;
    });
    defS('MROUND', 2, 2, function (a, b) {
        const n = numArg(this, a),
            m = numArg(this, b);
        if (n instanceof XErr) return n;
        if (m instanceof XErr) return m;
        if (m === 0) return 0;
        if (n * m < 0) return NUM;
        return chk(roundDig(n / m, 0, 0) * m);
    });
    defS('EVEN', 1, 1, function (a) {
        const n = numArg(this, a);
        if (n instanceof XErr) return n;
        const x = Math.ceil(Math.abs(n) / 2) * 2;
        return n < 0 ? -x : x;
    });
    defS('ODD', 1, 1, function (a) {
        const n = numArg(this, a);
        if (n instanceof XErr) return n;
        let x = Math.ceil(Math.abs(n));
        if (x % 2 === 0) x++;
        return n < 0 ? -x : x;
    });
    defS('QUOTIENT', 2, 2, function (a, b) {
        const n = numArg(this, a),
            d = numArg(this, b);
        if (n instanceof XErr) return n;
        if (d instanceof XErr) return d;
        return d === 0 ? DIV0 : Math.trunc(n / d);
    });
    defS('FACT', 1, 1, function (a) {
        const n = numArg(this, a);
        if (n instanceof XErr) return n;
        if (n < 0) return NUM;
        let r = 1;
        for (let i = 2; i <= Math.floor(n); i++) r *= i;
        return chk(r);
    });
    defS('COMBIN', 2, 2, function (a, b) {
        const n = intArg(this, a),
            k = intArg(this, b);
        if (n instanceof XErr) return n;
        if (k instanceof XErr) return k;
        if (n < 0 || k < 0 || k > n) return NUM;
        let r = 1;
        for (let i = 1; i <= Math.min(k, n - k); i++) r = (r * (n - i + 1)) / i;
        return Math.round(r);
    });
    const gcd = (a, b) => {
        while (b) {
            const t = a % b;
            a = b;
            b = t;
        }
        return a;
    };
    def('GCD', 1, 255, function (args) {
        const a = collectNums(this, args);
        if (a instanceof XErr) return a;
        let g = 0;
        for (const x of a) {
            if (x < 0) return NUM;
            g = gcd(g, Math.floor(x));
        }
        return g;
    });
    def('LCM', 1, 255, function (args) {
        const a = collectNums(this, args);
        if (a instanceof XErr) return a;
        let l = 1;
        for (const x of a) {
            if (x < 0) return NUM;
            const f = Math.floor(x);
            if (f === 0) return 0;
            l = (l / gcd(l, f)) * f;
        }
        return chk(l);
    });
    def('PI', 0, 0, function () {
        return Math.PI;
    });
    def('RAND', 0, 0, function () {
        return Math.random();
    });
    defS('RANDBETWEEN', 2, 2, function (a, b) {
        const lo = Math.ceil(numArg(this, a)),
            hi = Math.floor(numArg(this, b));
        if (!(lo <= hi)) return NUM;
        return lo + Math.floor(Math.random() * (hi - lo + 1));
    });
    for (const [nm, fn] of [
        ['SIN', Math.sin],
        ['COS', Math.cos],
        ['TAN', Math.tan],
        ['ATAN', Math.atan],
        ['SINH', Math.sinh],
        ['COSH', Math.cosh],
        ['TANH', Math.tanh],
        ['DEGREES', x => (x * 180) / Math.PI],
        ['RADIANS', x => (x * Math.PI) / 180]
    ]) {
        defS(nm, 1, 1, function (a) {
            const n = numArg(this, a);
            return n instanceof XErr ? n : chk(fn(n));
        });
    }
    defS('ASIN', 1, 1, function (a) {
        const n = numArg(this, a);
        return n instanceof XErr ? n : n < -1 || n > 1 ? NUM : Math.asin(n);
    });
    defS('ACOS', 1, 1, function (a) {
        const n = numArg(this, a);
        return n instanceof XErr ? n : n < -1 || n > 1 ? NUM : Math.acos(n);
    });
    defS('ATAN2', 2, 2, function (x, y) {
        const a = numArg(this, x),
            b = numArg(this, y);
        if (a instanceof XErr) return a;
        if (b instanceof XErr) return b;
        return a === 0 && b === 0 ? DIV0 : Math.atan2(b, a);
    });

    def('MEDIAN', 1, 255, function (args) {
        const a = collectNums(this, args);
        if (a instanceof XErr) return a;
        if (!a.length) return NUM;
        a.sort((x, y) => x - y);
        const m = a.length >> 1;
        return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    });
    function variance(sample, isSd) {
        return function (args) {
            const a = collectNums(this, args);
            if (a instanceof XErr) return a;
            const n = a.length;
            if (n < (sample ? 2 : 1)) return DIV0;
            let m = 0;
            for (const x of a) m += x;
            m /= n;
            let s = 0;
            for (const x of a) s += (x - m) * (x - m);
            const v = s / (sample ? n - 1 : n);
            return isSd ? Math.sqrt(v) : v;
        };
    }
    def('STDEV.S STDEV', 1, 255, variance(true, true));
    def('STDEV.P STDEVP', 1, 255, variance(false, true));
    def('VAR.S VAR', 1, 255, variance(true, false));
    def('VAR.P VARP', 1, 255, variance(false, false));
    function nth(large) {
        return function (args) {
            const a = collectNums(this, [args[0]]);
            if (a instanceof XErr) return a;
            const kk = numArg(this, this.sc(args[1]));
            if (kk instanceof XErr) return kk;
            const k = Math.ceil(kk);
            if (k < 1 || k > a.length) return NUM;
            a.sort((x, y) => (large ? y - x : x - y));
            return a[k - 1];
        };
    }
    def('LARGE', 2, 2, nth(true));
    def('SMALL', 2, 2, nth(false));
    def('RANK RANK.EQ', 2, 3, function (args) {
        const x = numArg(this, this.sc(args[0]));
        if (x instanceof XErr) return x;
        const a = collectNums(this, [args[1]]);
        if (a instanceof XErr) return a;
        const asc = args[2] !== undefined && numArg(this, this.sc(args[2])) !== 0;
        let found = false,
            rank = 1;
        for (const v of a) {
            if (v === x) found = true;
            else if (asc ? v < x : v > x) rank++;
        }
        return found ? rank : NA;
    });
    def('MODE.SNGL MODE', 1, 255, function (args) {
        const a = collectNums(this, args);
        if (a instanceof XErr) return a;
        const cnt = new Map();
        let best = null,
            bc = 1;
        for (const v of a) cnt.set(v, (cnt.get(v) || 0) + 1);
        for (const v of a) {
            const c = cnt.get(v);
            if (c > bc) {
                bc = c;
                best = v;
            }
        }
        return best === null ? NA : best;
    });
    def(
        'SUMPRODUCT',
        1,
        255,
        function (args) {
            const arrs = args.map(a => (a instanceof Ref ? this.toArr(a) : a));
            for (const a of arrs) if (a instanceof XErr) return a;
            let nr = 1,
                nc = 1;
            const first = arrs[0] instanceof Arr ? arrs[0] : null;
            if (first) {
                nr = first.nr;
                nc = first.nc;
            }
            for (const a of arrs) {
                const h = a instanceof Arr ? a.nr : 1,
                    w = a instanceof Arr ? a.nc : 1;
                if (h !== nr || w !== nc) return VALUE;
            }
            let s = 0;
            for (let i = 0; i < nr; i++)
                for (let j = 0; j < nc; j++) {
                    let p = 1;
                    for (const a of arrs) {
                        const v = a instanceof Arr ? a.rows[i][j] : a;
                        if (v instanceof XErr) return v;
                        if (typeof v === 'number') p *= v;
                        else p = 0;
                    }
                    s += p;
                }
            return chk(s);
        },
        { arr: true }
    );

    // *IF family
    def('COUNTIF', 2, 2, function (args) {
        const R = args[0];
        if (!(R instanceof Ref)) return VALUE;
        let n = 0;
        const err = ifsIter(this, [R], [args[1]], () => {
            n++;
        });
        return err || n;
    });
    def('COUNTIFS', 2, 254, function (args) {
        if (args.length % 2) return VALUE;
        const rs = [],
            cs = [];
        for (let i = 0; i < args.length; i += 2) {
            rs.push(args[i]);
            cs.push(args[i + 1]);
        }
        let n = 0;
        const err = ifsIter(this, rs, cs, () => {
            n++;
        });
        return err || n;
    });
    function sumLike(kind, hasPairsFirst) {
        // kind: sum, avg, min, max
        return function (args) {
            let target,
                rs = [],
                cs = [];
            if (hasPairsFirst) {
                // SUMIFS-style: (target, r1, c1, ...)
                if (args.length < 3 || args.length % 2 === 0) return VALUE;
                target = args[0];
                for (let i = 1; i < args.length; i += 2) {
                    rs.push(args[i]);
                    cs.push(args[i + 1]);
                }
            } else {
                // SUMIF-style: (range, crit, [target])
                if (!(args[0] instanceof Ref)) return VALUE;
                rs = [args[0]];
                cs = [args[1]];
                target = args[2] === undefined ? args[0] : args[2];
            }
            if (!(target instanceof Ref)) return VALUE;
            if (target.sheet < 0) return REF;
            let s = 0,
                n = 0,
                m = null,
                bad = null;
            const err = ifsIter(this, rs, cs, (di, dj) => {
                if (bad) return;
                const v = this.cellVal(target.sheet, target.r1 + di, target.c1 + dj);
                if (v instanceof XErr) {
                    bad = v;
                    return;
                }
                if (typeof v !== 'number') return;
                s += v;
                n++;
                if (m === null) m = v;
                else if (kind === 'max' ? v > m : v < m) m = v;
            });
            if (err) return err;
            if (bad) return bad;
            switch (kind) {
                case 'sum':
                    return chk(s);
                case 'avg':
                    return n ? s / n : DIV0;
                default:
                    return m === null ? 0 : m;
            }
        };
    }
    def('SUMIF', 2, 3, sumLike('sum', false));
    def('SUMIFS', 3, 255, sumLike('sum', true));
    def('AVERAGEIF', 2, 3, sumLike('avg', false));
    def('AVERAGEIFS', 3, 255, sumLike('avg', true));
    def('MINIFS', 3, 255, sumLike('min', true));
    def('MAXIFS', 3, 255, sumLike('max', true));

    // ---------- logical ----------
    const isMulti = v => v instanceof Ref && !(v.r1 === v.r2 && v.c1 === v.c2);
    def(
        'IF',
        2,
        3,
        function (nodes) {
            let c = this.ev(nodes[0]);
            if (c instanceof Arr || (this.arr > 0 && isMulti(c))) {
                if (c instanceof Ref) c = this.toArr(c);
                const t = nodes[1].k === 'missing' ? 0 : this.ev(nodes[1]),
                    e = nodes.length < 3 ? false : nodes[2].k === 'missing' ? 0 : this.ev(nodes[2]);
                const fix = x => (x instanceof Ref ? this.toArr(x) : x);
                return broadcast([c, fix(t), fix(e)], (cc, tt, ee) => {
                    if (cc instanceof XErr) return cc;
                    const b = toBool(cc);
                    return b instanceof XErr ? b : b ? (tt === null ? 0 : tt) : ee === null ? 0 : ee;
                });
            }
            if (c instanceof Ref) c = this.sc(c);
            if (c instanceof XErr) return c;
            const b = toBool(c);
            if (b instanceof XErr) return b;
            if (b) return nodes[1].k === 'missing' ? 0 : this.ev(nodes[1]);
            return nodes.length < 3 ? false : nodes[2].k === 'missing' ? 0 : this.ev(nodes[2]);
        },
        { lazy: true, min: 2, max: 3 }
    );
    FN.IF.lazyCheck = true;
    def(
        'IFS',
        2,
        254,
        function (nodes) {
            if (nodes.length % 2) return NA;
            for (let i = 0; i < nodes.length; i += 2) {
                const c = this.evs(nodes[i]);
                if (c instanceof XErr) return c;
                const b = toBool(c);
                if (b instanceof XErr) return b;
                if (b) return this.ev(nodes[i + 1]);
            }
            return NA;
        },
        { lazy: true }
    );
    def(
        'IFERROR',
        2,
        2,
        function (nodes) {
            let v = this.ev(nodes[0]);
            if (v instanceof Ref) v = this.sc(v);
            if (v instanceof XErr) return this.ev(nodes[1]);
            if (v instanceof Arr) return mapArr(v, x => (x instanceof XErr ? this.sc(this.ev(nodes[1])) : x));
            return v;
        },
        { lazy: true }
    );
    def(
        'IFNA',
        2,
        2,
        function (nodes) {
            let v = this.ev(nodes[0]);
            if (v instanceof Ref) v = this.sc(v);
            if (v === NA) return this.ev(nodes[1]);
            return v;
        },
        { lazy: true }
    );
    def(
        'SWITCH',
        3,
        254,
        function (nodes) {
            const x = this.evs(nodes[0]);
            if (x instanceof XErr) return x;
            let i = 1;
            for (; i + 1 < nodes.length; i += 2) {
                const v = this.evs(nodes[i]);
                if (v instanceof XErr) return v;
                if ((cmpVals(x, v) === 0 && typeof x === typeof v) || (x === null && v === null))
                    return this.ev(nodes[i + 1]);
            }
            return i < nodes.length ? this.ev(nodes[i]) : NA;
        },
        { lazy: true }
    );
    def(
        'CHOOSE',
        2,
        255,
        function (nodes) {
            const i = this.evs(nodes[0]);
            if (i instanceof XErr) return i;
            const n = toNum(i, this.d1904);
            if (n instanceof XErr) return n;
            const k = Math.floor(n);
            if (k < 1 || k >= nodes.length) return VALUE;
            return this.ev(nodes[k]);
        },
        { lazy: true }
    );
    function boolWalk(eng, args, onB) {
        let any = false;
        const err = walk(eng, args, (v, d) => {
            if (v instanceof XErr) return v;
            if (typeof v === 'boolean') {
                any = true;
                onB(v);
            } else if (typeof v === 'number') {
                any = true;
                onB(v !== 0);
            } else if (d) {
                if (typeof v === 'string') {
                    const b = toBool(v);
                    if (b instanceof XErr) return b;
                    any = true;
                    onB(b);
                }
            }
            return null;
        });
        return err || (any ? null : VALUE);
    }
    def('AND', 1, 255, function (args) {
        let r = true;
        const e = boolWalk(this, args, b => {
            if (!b) r = false;
        });
        return e || r;
    });
    def('OR', 1, 255, function (args) {
        let r = false;
        const e = boolWalk(this, args, b => {
            if (b) r = true;
        });
        return e || r;
    });
    def('XOR', 1, 255, function (args) {
        let r = false;
        const e = boolWalk(this, args, b => {
            if (b) r = !r;
        });
        return e || r;
    });
    defS('NOT', 1, 1, function (a) {
        const b = toBool(a);
        return b instanceof XErr ? b : !b;
    });
    def('TRUE', 0, 0, () => true);
    def('FALSE', 0, 0, () => false);

    // ---------- text ----------
    const S = v => toStr(v);
    defS('LEN', 1, 1, function (a) {
        return S(a).length;
    });
    function cnt(eng, v, dflt) {
        if (v === undefined) return dflt;
        const n = numArg(eng, v);
        return n instanceof XErr ? n : Math.floor(n);
    }
    defS('LEFT', 1, 2, function (a, n) {
        const k = cnt(this, n, 1);
        return k instanceof XErr ? k : k < 0 ? VALUE : S(a).slice(0, k);
    });
    defS('RIGHT', 1, 2, function (a, n) {
        const k = cnt(this, n, 1);
        if (k instanceof XErr) return k;
        if (k < 0) return VALUE;
        const s = S(a);
        return k === 0 ? '' : s.slice(-k);
    });
    defS('MID', 3, 3, function (a, st, n) {
        const s0 = cnt(this, st, 1),
            k = cnt(this, n, 0);
        if (s0 instanceof XErr) return s0;
        if (k instanceof XErr) return k;
        if (s0 < 1 || k < 0) return VALUE;
        return S(a).substr(s0 - 1, k);
    });
    defS('UPPER', 1, 1, function (a) {
        return S(a).toUpperCase();
    });
    defS('LOWER', 1, 1, function (a) {
        return S(a).toLowerCase();
    });
    defS('PROPER', 1, 1, function (a) {
        const s = S(a);
        let out = '',
            up = true;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i],
                isL = ch.toLowerCase() !== ch.toUpperCase();
            out += isL ? (up ? ch.toUpperCase() : ch.toLowerCase()) : ch;
            up = !isL;
        }
        return out;
    });
    defS('TRIM', 1, 1, function (a) {
        return S(a).replace(/ +/g, ' ').replace(/^ | $/g, '');
    });
    defS('CLEAN', 1, 1, function (a) {
        return S(a).replace(/[\x00-\x1f]/g, '');
    });
    defS('SUBSTITUTE', 3, 4, function (t, o, n, inst) {
        const s = S(t),
            old = S(o),
            nw = S(n);
        if (old === '') return s;
        if (inst === undefined) return s.split(old).join(nw);
        const k = cnt(this, inst, 1);
        if (k instanceof XErr) return k;
        if (k < 1) return VALUE;
        let idx = -1,
            from = 0;
        for (let i = 0; i < k; i++) {
            idx = s.indexOf(old, from);
            if (idx < 0) return s;
            from = idx + old.length;
        }
        return s.slice(0, idx) + nw + s.slice(idx + old.length);
    });
    defS('REPLACE', 4, 4, function (t, st, n, nw) {
        const s0 = cnt(this, st, 1),
            k = cnt(this, n, 0);
        if (s0 instanceof XErr) return s0;
        if (k instanceof XErr) return k;
        if (s0 < 1 || k < 0) return VALUE;
        const s = S(t);
        return s.slice(0, s0 - 1) + S(nw) + s.slice(s0 - 1 + k);
    });
    defS('FIND', 2, 3, function (f, w, st) {
        const k = cnt(this, st, 1);
        if (k instanceof XErr) return k;
        const within = S(w);
        if (k < 1 || k > within.length + 1) return VALUE;
        const i = within.indexOf(S(f), k - 1);
        return i < 0 ? VALUE : i + 1;
    });
    defS('SEARCH', 2, 3, function (f, w, st) {
        const k = cnt(this, st, 1);
        if (k instanceof XErr) return k;
        const within = S(w).toLowerCase();
        if (k < 1 || k > within.length + 1) return VALUE;
        const pat = S(f).toLowerCase(),
            tok = wildTokens(pat);
        if (!tok) {
            const i = within.indexOf(pat, k - 1);
            return i < 0 ? VALUE : i + 1;
        }
        for (let i = k - 1; i < within.length; i++) {
            for (let j = i; j <= within.length; j++) if (wildMatch(tok, within.slice(i, j))) return i + 1;
        }
        return VALUE;
    });
    defS('REPT', 2, 2, function (t, n) {
        const k = cnt(this, n, 0);
        if (k instanceof XErr) return k;
        if (k < 0) return VALUE;
        const s = S(t);
        if (s.length * k > 32767) return VALUE;
        return s.repeat(k);
    });
    defS('EXACT', 2, 2, function (a, b) {
        return S(a) === S(b);
    });
    defS('CHAR', 1, 1, function (a) {
        const k = cnt(this, a, 0);
        if (k instanceof XErr) return k;
        return k < 1 || k > 255 ? VALUE : String.fromCharCode(k);
    });
    defS('UNICHAR', 1, 1, function (a) {
        const k = cnt(this, a, 0);
        if (k instanceof XErr) return k;
        return k < 1 || k > 0x10ffff ? VALUE : String.fromCodePoint(k);
    });
    defS('CODE', 1, 1, function (a) {
        const s = S(a);
        return s === '' ? VALUE : s.charCodeAt(0);
    });
    defS('UNICODE', 1, 1, function (a) {
        const s = S(a);
        return s === '' ? VALUE : s.codePointAt(0);
    });
    defS('T', 1, 1, function (a) {
        return typeof a === 'string' ? a : '';
    });
    defS('VALUE', 1, 1, function (a) {
        if (typeof a === 'number') return a;
        if (typeof a === 'boolean') return VALUE;
        const n = toNum(S(a), this.d1904);
        return n;
    });
    def('CONCAT', 1, 255, function (args) {
        let out = '';
        const err = walk(this, args, v => {
            if (v instanceof XErr) return v;
            out += toStr(v);
            return null;
        });
        return err || out;
    });
    defS('CONCATENATE', 1, 255, function (...a) {
        let o = '';
        for (const x of a) o += S(x);
        return o;
    });
    def('TEXTJOIN', 3, 255, function (args) {
        const d = this.sc(args[0]);
        if (d instanceof XErr) return d;
        const ig = toBool(this.sc(args[1]));
        if (ig instanceof XErr) return ig;
        const parts = [];
        const err = walk(this, args.slice(2), (v, direct) => {
            if (v instanceof XErr) return v;
            if (v === null && !direct) {
                if (!ig) parts.push('');
                return null;
            }
            const s = toStr(v);
            if (s === '' && ig) return null;
            parts.push(s);
            return null;
        });
        return err || parts.join(toStr(d));
    });
    function basicFormat(fmt, v) {
        if (fmt === 'General' || fmt === '@') return numStr(v);
        const pct = fmt.endsWith('%');
        const f = pct ? fmt.slice(0, -1) : fmt;
        const m = /^([#0,]*)(?:\.([0#]+))?$/.exec(f);
        if (!m) return numStr(v);
        const dec = m[2] ? m[2].length : 0,
            x = pct ? v * 100 : v;
        let s = Math.abs(roundDig(x, dec, 0)).toFixed(dec);
        if (m[1].indexOf(',') >= 0) {
            const [i, d] = s.split('.');
            s = i.replace(/\B(?=(\d{3})+$)/g, ',') + (d ? '.' + d : '');
        }
        const minInt = (m[1].replace(/,/g, '').match(/0/g) || []).length;
        if (minInt === 0 && /^0(\.|$)/.test(s) && Math.abs(x) < 1) s = s.slice(1);
        return (x < 0 && Number(s.replace(/,/g, '')) !== 0 ? '-' : '') + s + (pct ? '%' : '');
    }
    defS('TEXT', 2, 2, function (v, f) {
        const fmt = S(f);
        if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
        let n = v;
        if (typeof v === 'string') {
            n = parseNumText(v);
            if (n !== n) n = parseDateText(v, this.d1904);
            if (n !== n) return v;
        }
        if (n === null) n = 0;
        if (fmt === '') return '';
        try {
            const ssf = root.SSF;
            if (ssf && ssf.format) return ssf.format(fmt, n, this.d1904 ? { date1904: true } : undefined);
        } catch (_) {
            return VALUE;
        }
        return basicFormat(fmt, n);
    });

    // ---------- info ----------
    defS('ISNUMBER', 1, 1, a => typeof a === 'number', { raw: true });
    defS('ISTEXT', 1, 1, a => typeof a === 'string', { raw: true });
    defS('ISNONTEXT', 1, 1, a => typeof a !== 'string', { raw: true });
    defS('ISBLANK', 1, 1, a => a === null || a === undefined, { raw: true });
    defS('ISLOGICAL', 1, 1, a => typeof a === 'boolean', { raw: true });
    defS('ISERROR', 1, 1, a => a instanceof XErr, { raw: true });
    defS('ISERR', 1, 1, a => a instanceof XErr && a !== NA, { raw: true });
    defS('ISNA', 1, 1, a => a === NA, { raw: true });
    defS('ISEVEN', 1, 1, function (a) {
        const n = numArg(this, a);
        return n instanceof XErr ? n : Math.floor(Math.abs(n)) % 2 === 0;
    });
    defS('ISODD', 1, 1, function (a) {
        const n = numArg(this, a);
        return n instanceof XErr ? n : Math.floor(Math.abs(n)) % 2 === 1;
    });
    defS(
        'N',
        1,
        1,
        function (a) {
            return typeof a === 'number' ? a : typeof a === 'boolean' ? (a ? 1 : 0) : a instanceof XErr ? a : 0;
        },
        { raw: true }
    );
    def('NA', 0, 0, () => NA);
    def('TYPE', 1, 1, function (args) {
        const a = args[0];
        if (a instanceof Arr || isMulti(a)) return 64;
        const v = a instanceof Ref ? this.sc(a) : a;
        return v instanceof XErr
            ? 16
            : typeof v === 'number'
              ? 1
              : typeof v === 'string'
                ? 2
                : typeof v === 'boolean'
                  ? 4
                  : 1;
    });

    // ---------- lookup / reference ----------
    const cmpL = (e, v) => {
        if (e === null || e === undefined) return -1;
        const a = typeRank(e),
            b = typeRank(v);
        if (a !== b) return a < b ? -1 : 1;
        if (a === 1) {
            const x = e.toLowerCase(),
                y = v.toLowerCase();
            return x < y ? -1 : x > y ? 1 : 0;
        }
        return e < v ? -1 : e > v ? 1 : 0;
    };
    function trimVec(vals) {
        let n = vals.length;
        while (n > 0 && vals[n - 1] === null) n--;
        return n;
    }
    function refVec(eng, ref, vertical, idx) {
        // dense vector along `idx` column (vertical) or row, clamped to used extent
        const key =
            ref.sheet +
            ':' +
            (vertical ? 'c' + idx + ':' + ref.r1 + ':' + ref.r2 : 'r' + idx + ':' + ref.c1 + ':' + ref.c2);
        let v = eng.lc.get(key);
        if (v) return v;
        const ex = eng.extent(ref.sheet);
        const vals = [];
        if (vertical) {
            let r2 = ref.r2;
            if (ex) r2 = Math.min(r2, Math.max(ex.rows - 1, ref.r1));
            else r2 = Math.min(r2, ref.r1 + 99999);
            const n = Math.max(0, r2 - ref.r1 + 1);
            for (let i = 0; i < n; i++) vals.push(null);
            eng.eachCell(ref.sheet, ref.r1, idx, r2, idx, (x, r) => {
                vals[r - ref.r1] = x;
            });
        } else {
            let c2 = ref.c2;
            if (ex) c2 = Math.min(c2, Math.max(ex.cols - 1, ref.c1));
            else c2 = Math.min(c2, ref.c1 + 255);
            const n = Math.max(0, c2 - ref.c1 + 1);
            for (let i = 0; i < n; i++) vals.push(null);
            eng.eachCell(ref.sheet, idx, ref.c1, idx, c2, (x, r, c) => {
                vals[c - ref.c1] = x;
            });
        }
        v = { vals, n: trimVec(vals), map: null };
        eng.lc.set(key, v);
        return v;
    }
    function vec1d(eng, x) {
        // 1-D vector from Ref/Arr: {vals,n,vertical,ref}
        if (x instanceof Ref) {
            if (x.sheet < 0) return REF;
            const h = x.r2 - x.r1 + 1,
                w = x.c2 - x.c1 + 1;
            if (w === 1) return Object.assign({ vertical: true, ref: x }, refVec(eng, x, true, x.c1));
            if (h === 1) return Object.assign({ vertical: false, ref: x }, refVec(eng, x, false, x.r1));
            return NA;
        }
        if (x instanceof Arr) {
            if (x.nc === 1) {
                const vals = x.rows.map(r => r[0]);
                return { vals, n: vals.length, map: null, vertical: true };
            }
            if (x.nr === 1) {
                const vals = x.rows[0].slice();
                return { vals, n: vals.length, map: null, vertical: false };
            }
            return NA;
        }
        if (x instanceof XErr) return x;
        return { vals: [x], n: 1, map: null, vertical: true };
    }
    function findExact(vec, v) {
        if (typeof v === 'string' && /[*?~]/.test(v)) {
            const tok = wildTokens(v.toLowerCase());
            if (tok) {
                for (let i = 0; i < vec.n; i++) {
                    const e = vec.vals[i];
                    if (typeof e === 'string' && wildMatch(tok, e.toLowerCase())) return i;
                }
                return -1;
            }
        }
        if (vec.n > 16) {
            if (!vec.map) {
                const m = new Map();
                for (let i = 0; i < vec.n; i++) {
                    const e = vec.vals[i];
                    if (e === null || e instanceof XErr) continue;
                    const k = typeof e === 'string' ? e.toLowerCase() : e;
                    if (!m.has(k)) m.set(k, i);
                }
                vec.map = m;
            }
            const i = vec.map.get(typeof v === 'string' ? v.toLowerCase() : v);
            return i === undefined ? -1 : i;
        }
        for (let i = 0; i < vec.n; i++) {
            const e = vec.vals[i];
            if (e !== null && !(e instanceof XErr) && typeRank(e) === typeRank(v) && cmpVals(e, v) === 0) return i;
        }
        return -1;
    }
    function findApprox(vec, v, type) {
        const vals = vec.vals;
        let lo = 0,
            hi = vec.n - 1,
            res = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1,
                c = cmpL(vals[mid], v);
            if (type > 0 ? c <= 0 : c >= 0) {
                res = mid;
                lo = mid + 1;
            } else hi = mid - 1;
        }
        if (res >= 0 && vals[res] !== null && typeRank(vals[res]) !== typeRank(v)) return -1;
        return res;
    }
    function lookupVal(eng, a) {
        const v = a instanceof Ref ? eng.sc(a) : a instanceof Arr ? a.rows[0][0] : a;
        return v === null || v === undefined ? 0 : v;
    }
    def('MATCH', 2, 3, function (args) {
        const v = lookupVal(this, args[0]);
        if (v instanceof XErr) return v;
        const vec = vec1d(this, args[1]);
        if (vec instanceof XErr) return vec;
        const t = args[2] === undefined ? 1 : numArg(this, this.sc(args[2]));
        if (t instanceof XErr) return t;
        const i = t === 0 ? findExact(vec, v) : findApprox(vec, v, t > 0 ? 1 : -1);
        return i < 0 ? NA : i + 1;
    });
    function tableLookup(vertical) {
        return function (args) {
            const v = lookupVal(this, args[0]);
            if (v instanceof XErr) return v;
            const T = args[1],
                k = intArg(this, this.sc(args[2]));
            if (k instanceof XErr) return k;
            let approx = true;
            if (args[3] !== undefined) {
                const b = toBool(this.sc(args[3]));
                if (b instanceof XErr) return b;
                approx = b;
            }
            if (k < 1) return VALUE;
            let vec, get;
            if (T instanceof Ref) {
                if (T.sheet < 0) return REF;
                const w = T.c2 - T.c1 + 1,
                    h = T.r2 - T.r1 + 1;
                if (k > (vertical ? w : h)) return REF;
                vec = vertical ? refVec(this, T, true, T.c1) : refVec(this, T, false, T.r1);
                get = i =>
                    vertical
                        ? this.cellVal(T.sheet, T.r1 + i, T.c1 + k - 1)
                        : this.cellVal(T.sheet, T.r1 + k - 1, T.c1 + i);
            } else if (T instanceof Arr) {
                if (k > (vertical ? T.nc : T.nr)) return REF;
                const vals = vertical ? T.rows.map(r => r[0]) : T.rows[0].slice();
                vec = { vals, n: vals.length, map: null };
                get = i => (vertical ? T.rows[i][k - 1] : T.rows[k - 1][i]);
            } else return VALUE;
            const i = approx ? findApprox(vec, v, 1) : findExact(vec, v);
            if (i < 0) return NA;
            const r = get(i);
            return r === null ? 0 : r;
        };
    }
    def('VLOOKUP', 3, 4, tableLookup(true));
    def('HLOOKUP', 3, 4, tableLookup(false));
    def('LOOKUP', 2, 3, function (args) {
        const v = lookupVal(this, args[0]);
        if (v instanceof XErr) return v;
        const vec = vec1d(this, args[1]);
        if (vec instanceof XErr) return vec;
        const i = findApprox(vec, v, 1);
        if (i < 0) return NA;
        if (args[2] === undefined) return vec.vals[i] === null ? 0 : vec.vals[i];
        const rv = vec1d(this, args[2]);
        if (rv instanceof XErr) return rv;
        const r = rv.vals[i];
        return r === undefined || r === null ? 0 : r;
    });
    def('XLOOKUP', 3, 6, function (args) {
        const v = lookupVal(this, args[0]);
        if (v instanceof XErr) return v;
        const vec = vec1d(this, args[1]);
        if (vec instanceof XErr) return vec;
        const mm = args[4] === undefined ? 0 : numArg(this, this.sc(args[4]));
        if (mm instanceof XErr) return mm;
        const sm = args[5] === undefined ? 1 : numArg(this, this.sc(args[5]));
        if (sm instanceof XErr) return sm;
        let idx = -1;
        const rev = sm === -1 || sm === -2;
        const same = e => e !== null && !(e instanceof XErr) && typeRank(e) === typeRank(v);
        if (mm === 0 && !rev) idx = findExact(vec, v);
        else if (mm === 2 && !rev) idx = findExact(vec, v);
        else {
            let best = -1;
            const tok = mm === 2 && typeof v === 'string' ? wildTokens(v.toLowerCase()) : null;
            for (let q = 0; q < vec.n; q++) {
                const i = rev ? vec.n - 1 - q : q,
                    e = vec.vals[i];
                if (!same(e)) continue;
                const c = tok ? (typeof e === 'string' && wildMatch(tok, e.toLowerCase()) ? 0 : 2) : cmpVals(e, v);
                if (c === 0) {
                    best = i;
                    break;
                }
                if (mm === -1 && c < 0 && (best < 0 || cmpVals(e, vec.vals[best]) > 0)) best = i;
                else if (mm === 1 && c > 0 && c !== 2 && (best < 0 || cmpVals(e, vec.vals[best]) < 0)) best = i;
            }
            idx = best;
        }
        if (idx < 0) return args[3] !== undefined ? args[3] : NA;
        const R = args[2];
        if (R instanceof Ref) {
            if (R.sheet < 0) return REF;
            const rr = vec.vertical
                ? new Ref(R.sheet, R.r1 + idx, R.c1, R.r1 + idx, R.c1)
                : new Ref(R.sheet, R.r1, R.c1 + idx, R.r1, R.c1 + idx);
            if (rr.r1 > R.r2 || rr.c1 > R.c2) return NA;
            return rr;
        }
        if (R instanceof Arr) {
            const x = vec.vertical ? R.rows[idx] && R.rows[idx][0] : R.rows[0][idx];
            return x === undefined ? NA : x;
        }
        return R;
    });
    def('INDEX', 2, 4, function (args) {
        const A = args[0];
        let rn = args[1] === undefined ? 0 : numArg(this, this.sc(args[1]));
        if (rn instanceof XErr) return rn;
        let cn = args[2] === undefined ? undefined : numArg(this, this.sc(args[2]));
        if (cn instanceof XErr) return cn;
        rn = Math.trunc(rn);
        if (cn !== undefined) cn = Math.trunc(cn);
        const h = A instanceof Ref ? A.r2 - A.r1 + 1 : A instanceof Arr ? A.nr : 1,
            w = A instanceof Ref ? A.c2 - A.c1 + 1 : A instanceof Arr ? A.nc : 1;
        if (cn === undefined) {
            if (h === 1) {
                cn = rn;
                rn = 1;
            } else cn = 0;
        }
        if (rn < 0 || cn < 0 || rn > h || cn > w) return REF;
        if (A instanceof Ref) {
            if (A.sheet < 0) return REF;
            const r1 = rn === 0 ? A.r1 : A.r1 + rn - 1,
                r2 = rn === 0 ? A.r2 : r1,
                c1 = cn === 0 ? A.c1 : A.c1 + cn - 1,
                c2 = cn === 0 ? A.c2 : c1;
            return new Ref(A.sheet, r1, c1, r2, c2);
        }
        if (A instanceof Arr) {
            const rows = rn === 0 ? A.rows : [A.rows[rn - 1]];
            const out = rows.map(r => (cn === 0 ? r : [r[cn - 1]]));
            return out.length === 1 && out[0].length === 1 ? out[0][0] : new Arr(out);
        }
        return rn <= 1 && cn <= 1 ? A : REF;
    });
    def('ROW', 0, 1, function (args) {
        const a = args[0];
        if (a === undefined) return this.cur.r + 1;
        if (!(a instanceof Ref)) return NA;
        if (this.arr > 0 && a.r2 > a.r1) {
            const rows = [];
            for (let r = a.r1; r <= Math.min(a.r2, a.r1 + 99999); r++) rows.push([r + 1]);
            return new Arr(rows);
        }
        return a.r1 + 1;
    });
    def('COLUMN', 0, 1, function (args) {
        const a = args[0];
        if (a === undefined) return this.cur.c + 1;
        if (!(a instanceof Ref)) return NA;
        if (this.arr > 0 && a.c2 > a.c1) {
            const row = [];
            for (let c = a.c1; c <= Math.min(a.c2, a.c1 + 16383); c++) row.push(c + 1);
            return new Arr([row]);
        }
        return a.c1 + 1;
    });
    def('ROWS', 1, 1, function (args) {
        const a = args[0];
        return a instanceof Ref ? a.r2 - a.r1 + 1 : a instanceof Arr ? a.nr : 1;
    });
    def('COLUMNS', 1, 1, function (args) {
        const a = args[0];
        return a instanceof Ref ? a.c2 - a.c1 + 1 : a instanceof Arr ? a.nc : 1;
    });
    def('OFFSET', 3, 5, function (args) {
        const A = args[0];
        if (!(A instanceof Ref)) return A instanceof XErr ? A : VALUE;
        const n = [1, 2, 3, 4].map(i => (args[i] === undefined ? undefined : intArg(this, this.sc(args[i]))));
        for (const x of n) if (x instanceof XErr) return x;
        const h = n[2] === undefined ? A.r2 - A.r1 + 1 : n[2],
            w = n[3] === undefined ? A.c2 - A.c1 + 1 : n[3];
        const r1 = A.r1 + n[0],
            c1 = A.c1 + n[1];
        if (h < 1 || w < 1 || r1 < 0 || c1 < 0 || r1 + h - 1 > MAXR || c1 + w - 1 > MAXC) return REF;
        return new Ref(A.sheet, r1, c1, r1 + h - 1, c1 + w - 1);
    });
    def('INDIRECT', 1, 2, function (args) {
        const t = this.sc(args[0]);
        if (t instanceof XErr) return t;
        if (args[1] !== undefined) {
            const b = toBool(this.sc(args[1]));
            if (b instanceof XErr) return b;
            if (!b) return REF;
        }
        let node;
        try {
            const p = new Parser(toStr(t).trim());
            node = p.cmp();
            p.ws();
            if (p.i < p.n) return REF;
        } catch (e) {
            return REF;
        }
        if (node.k !== 'ref') return REF;
        const sh = node.sheet === null ? this.cur.sheet : this.sheetIdx(node.sheet);
        return sh < 0 ? REF : new Ref(sh, node.r1, node.c1, node.r2, node.c2);
    });
    def(
        'TRANSPOSE',
        1,
        1,
        function (args) {
            const a = args[0] instanceof Ref ? this.toArr(args[0]) : args[0];
            if (!(a instanceof Arr)) return a;
            const rows = [];
            for (let j = 0; j < a.nc; j++) {
                const r = [];
                for (let i = 0; i < a.nr; i++) r.push(a.rows[i][j]);
                rows.push(r);
            }
            return new Arr(rows);
        },
        { arr: true }
    );

    // ---------- date / time ----------
    const nowParts = eng => {
        const d = eng.nowFn();
        return {
            d,
            serial: ymdToSerial(d.getFullYear(), d.getMonth() + 1, d.getDate(), eng.d1904),
            frac: (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000) / 86400
        };
    };
    def('TODAY', 0, 0, function () {
        return nowParts(this).serial;
    });
    def('NOW', 0, 0, function () {
        const n = nowParts(this);
        return n.serial + n.frac;
    });
    defS('DATE', 3, 3, function (y, m, d) {
        let yy = intArg(this, y),
            mm = intArg(this, m),
            dd = intArg(this, d);
        for (const x of [yy, mm, dd]) if (x instanceof XErr) return x;
        if (yy < 0 || yy >= 10000) return NUM;
        if (yy < 1900) yy += 1900;
        const s = ymdToSerial(yy, mm, dd, this.d1904);
        return s < 0 ? NUM : s;
    });
    function ymdOf(eng, v) {
        const n = numArg(eng, v);
        if (n instanceof XErr) return n;
        if (n < 0) return NUM;
        const r = serialToYmd(n, eng.d1904);
        return r || NUM;
    }
    defS('YEAR', 1, 1, function (a) {
        const r = ymdOf(this, a);
        return r instanceof XErr ? r : r.y;
    });
    defS('MONTH', 1, 1, function (a) {
        const r = ymdOf(this, a);
        return r instanceof XErr ? r : r.m;
    });
    defS('DAY', 1, 1, function (a) {
        const r = ymdOf(this, a);
        return r instanceof XErr ? r : r.d;
    });
    function secOfDay(eng, a) {
        const n = numArg(eng, a);
        if (n instanceof XErr) return n;
        if (n < 0) return NUM;
        return Math.round((n - Math.floor(n)) * 86400) % 86400;
    }
    defS('HOUR', 1, 1, function (a) {
        const s = secOfDay(this, a);
        return s instanceof XErr ? s : Math.floor(s / 3600);
    });
    defS('MINUTE', 1, 1, function (a) {
        const s = secOfDay(this, a);
        return s instanceof XErr ? s : Math.floor(s / 60) % 60;
    });
    defS('SECOND', 1, 1, function (a) {
        const s = secOfDay(this, a);
        return s instanceof XErr ? s : s % 60;
    });
    defS('TIME', 3, 3, function (h, m, s) {
        const a = intArg(this, h),
            b = intArg(this, m),
            c = intArg(this, s);
        for (const x of [a, b, c]) if (x instanceof XErr) return x;
        if (a < 0 || b < 0 || c < 0 || a > 32767 || b > 32767 || c > 32767) return NUM;
        const t = (a * 3600 + b * 60 + c) / 86400;
        return t - Math.floor(t);
    });
    defS('WEEKDAY', 1, 2, function (a, t) {
        let n = numArg(this, a);
        if (n instanceof XErr) return n;
        if (n < 0) return NUM;
        const ty = t === undefined ? 1 : intArg(this, t);
        if (ty instanceof XErr) return ty;
        n = Math.floor(n) + (this.d1904 ? 1462 : 0);
        const sun0 = (((n - 1) % 7) + 7) % 7;
        if (ty === 1) return sun0 + 1;
        if (ty === 2) return ((sun0 + 6) % 7) + 1;
        if (ty === 3) return (sun0 + 6) % 7;
        if (ty >= 11 && ty <= 17) {
            const st = (ty - 10) % 7;
            return ((sun0 - st + 7) % 7) + 1;
        }
        return NUM;
    });
    const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
    function addMonths(eng, s, months, eom) {
        const p = ymdOf(eng, s);
        if (p instanceof XErr) return p;
        const k = intArg(eng, months);
        if (k instanceof XErr) return k;
        let m0 = p.y * 12 + (p.m - 1) + k;
        const y = Math.floor(m0 / 12),
            m = m0 - y * 12 + 1;
        if (y < 1900 && !(y === 1900)) return NUM;
        const d = eom ? dim(y, m) : Math.min(p.d, dim(y, m));
        const r = ymdToSerial(y, m, d, eng.d1904);
        return r < 0 ? NUM : r;
    }
    defS('EDATE', 2, 2, function (s, m) {
        return addMonths(this, s, m, false);
    });
    defS('EOMONTH', 2, 2, function (s, m) {
        return addMonths(this, s, m, true);
    });
    defS('DAYS', 2, 2, function (e, s) {
        const a = numArg(this, e),
            b = numArg(this, s);
        if (a instanceof XErr) return a;
        if (b instanceof XErr) return b;
        return Math.floor(a) - Math.floor(b);
    });
    defS('DATEVALUE', 1, 1, function (a) {
        const n = parseDateText(toStr(a), this.d1904);
        return n !== n ? VALUE : Math.floor(n);
    });
    defS('TIMEVALUE', 1, 1, function (a) {
        const n = parseDateText(toStr(a), this.d1904);
        return n !== n ? VALUE : n - Math.floor(n);
    });
    defS('DATEDIF', 3, 3, function (s, e, u) {
        const a = numArg(this, s),
            b = numArg(this, e);
        if (a instanceof XErr) return a;
        if (b instanceof XErr) return b;
        if (a > b) return NUM;
        const p = ymdOf(this, a),
            q = ymdOf(this, b);
        if (p instanceof XErr) return p;
        if (q instanceof XErr) return q;
        const unit = toStr(u).toUpperCase();
        let months = (q.y - p.y) * 12 + (q.m - p.m);
        if (q.d < p.d) months--;
        switch (unit) {
            case 'Y':
                return Math.floor(months / 12);
            case 'M':
                return months;
            case 'D':
                return Math.floor(b) - Math.floor(a);
            case 'YM':
                return ((months % 12) + 12) % 12;
            case 'MD': {
                if (q.d >= p.d) return q.d - p.d;
                const pm = q.m === 1 ? 12 : q.m - 1,
                    py = q.m === 1 ? q.y - 1 : q.y;
                return q.d + dim(py, pm) - p.d;
            }
            case 'YD': {
                let y = q.y;
                let st = ymdToSerial(y, p.m, Math.min(p.d, dim(y, p.m)), this.d1904);
                if (st > Math.floor(b)) {
                    y--;
                    st = ymdToSerial(y, p.m, Math.min(p.d, dim(y, p.m)), this.d1904);
                }
                return Math.floor(b) - st;
            }
            default:
                return NUM;
        }
    });

    // ---------- public API ----------
    Calc.parse = parse;
    Calc.functionNames = () => Object.keys(FN).sort();
    Calc.keyOf = keyOf;
    Calc.XErr = XErr;
    Calc.ymdToSerial = ymdToSerial;
    Calc.serialToYmd = serialToYmd;
    Calc.clearParseCache = () => PCACHE.clear();
    OX.Calc = Calc;
    if (typeof module !== 'undefined' && module.exports) module.exports = OX;
})(typeof globalThis !== 'undefined' ? globalThis : this);
