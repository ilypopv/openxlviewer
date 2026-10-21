(function (root) {
    'use strict';
    const OX = root.OX || (root.OX = {});
    const lineBreaks = s => OX.csvLineBreaks(s);

    function groupInt(s) {
        let out = '';
        for (let i = s.length; i > 0; i -= 3) out = s.slice(Math.max(0, i - 3), i) + (out ? ',' + out : '');
        return out;
    }

    // Small .NET-style numeric format strings: g n f d c p e x
    function formatNumberNet(v, fmt) {
        const m = /^([a-zA-Z])(\d*)$/.exec(fmt || '');
        if (!m || typeof v !== 'number' || !isFinite(v)) return String(v);
        const p = m[2] === '' ? null : parseInt(m[2], 10);
        const kind = m[1];
        const grouped = (x, d) => {
            const s = Math.abs(x).toFixed(d);
            const dot = s.indexOf('.');
            const body = dot < 0 ? groupInt(s) : groupInt(s.slice(0, dot)) + s.slice(dot);
            return (x < 0 && Number(s) !== 0 ? '-' : '') + body;
        };
        switch (kind.toLowerCase()) {
            case 'g':
                return p ? String(Number(v.toPrecision(Math.min(p, 100)))) : String(v);
            case 'n':
                return grouped(v, Math.min(p === null ? 2 : p, 100));
            case 'f':
                return v.toFixed(Math.min(p === null ? 2 : p, 100));
            case 'd': {
                let s = String(Math.trunc(Math.abs(v)));
                while (p && s.length < p) s = '0' + s;
                return (v < 0 ? '-' : '') + s;
            }
            case 'c': {
                const g = grouped(v, Math.min(p === null ? 2 : p, 100));
                return g[0] === '-' ? '-$' + g.slice(1) : '$' + g;
            }
            case 'p':
                return (v * 100).toFixed(Math.min(p === null ? 2 : p, 100)) + '%';
            case 'e': {
                const s = v.toExponential(Math.min(p === null ? 6 : p, 100));
                return kind === 'E' ? s.toUpperCase() : s;
            }
            case 'x': {
                const s = Math.trunc(v).toString(16);
                return kind === 'X' ? s.toUpperCase() : s;
            }
        }
        return String(v);
    }

    // [+-]?(int[.frac?]|.frac)([eE][+-]?d+)?, no leading zeros on multi-digit ints, <=15 integer digits.
    function isNumeric(s) {
        const n = s.length;
        if (n === 0 || n > 40) return false;
        let i = 0,
            c = s.charCodeAt(0);
        if (c === 45 || c === 43) {
            i = 1;
            if (n === 1) return false;
        }
        const is = i;
        while (i < n && (c = s.charCodeAt(i)) >= 48 && c <= 57) i++;
        const intLen = i - is;
        if (intLen > 15 || (intLen > 1 && s.charCodeAt(is) === 48)) return false;
        let frac = 0;
        if (i < n && s.charCodeAt(i) === 46) {
            i++;
            const fs = i;
            while (i < n && (c = s.charCodeAt(i)) >= 48 && c <= 57) i++;
            frac = i - fs;
        }
        if (intLen === 0 && frac === 0) return false;
        if (i < n && ((c = s.charCodeAt(i)) === 101 || c === 69)) {
            i++;
            if (i < n && ((c = s.charCodeAt(i)) === 43 || c === 45)) i++;
            const es = i;
            while (i < n && (c = s.charCodeAt(i)) >= 48 && c <= 57) i++;
            if (i === es) return false;
        }
        return i === n;
    }

    function toHeaderCase(t) {
        t = t.replace(/([a-z])([A-Z])/g, '$1 $2');
        return t.length ? t.charAt(0).toUpperCase() + t.slice(1) : t;
    }

    function mkStyle(o) {
        return Object.assign(
            {
                fmt: 'General',
                b: false,
                i: false,
                u: false,
                strike: false,
                color: null,
                size: 0,
                font: '',
                bg: null,
                h: 'general',
                v: 'center',
                wrap: false,
                indent: 0,
                bl: null,
                br: null,
                bt: null,
                bb: null
            },
            o
        );
    }

    const LINE_H = 16;
    const MAX_CACHE = 30000;
    const OVK = 1048576; // overlay key = row * OVK + col
    const MEASURE_COLS = 24;
    const YIELD_BYTES = 1 << 18;
    const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
    const f64 = new Float64Array(1),
        u32 = new Uint32Array(f64.buffer);

    function growI32(a, cap) {
        const b = new Int32Array(cap);
        b.set(a);
        return b;
    }

    // Open-addressing hash of byte ranges of the source buffer -> dense ids (no per-value allocation).
    class Interner {
        constructor(ix, max) {
            this.ix = ix;
            this.max = max || 0x7fffffff;
            this.tab = new Int32Array(1 << 12);
            this.mask = this.tab.length - 1;
            this.cap = 1024;
            this.ss = new Int32Array(this.cap);
            this.ee = new Int32Array(this.cap);
            this.hh = new Int32Array(this.cap);
            this.count = 0;
        }
        // id, or -1 when the distinct limit is exceeded
        intern(s, e) {
            const b = this.ix.bytes;
            let h = 0x811c9dc5 | 0;
            for (let i = s; i < e; i++) h = Math.imul(h ^ b[i], 16777619);
            const tab = this.tab,
                mask = this.mask,
                len = e - s;
            let k = h & mask;
            for (;;) {
                const t = tab[k];
                if (t === 0) break;
                const id = t - 1;
                if (this.hh[id] === h) {
                    const a = this.ss[id];
                    if (this.ee[id] - a === len) {
                        let j = 0;
                        while (j < len && b[a + j] === b[s + j]) j++;
                        if (j === len) return id;
                    }
                }
                k = (k + 1) & mask;
            }
            if (this.count >= this.max) return -1;
            const id = this.count++;
            if (id === this.cap) {
                this.cap *= 2;
                this.ss = growI32(this.ss, this.cap);
                this.ee = growI32(this.ee, this.cap);
                this.hh = growI32(this.hh, this.cap);
            }
            this.ss[id] = s;
            this.ee[id] = e;
            this.hh[id] = h;
            tab[k] = id + 1;
            if (this.count * 2 > tab.length) this._rehash();
            return id;
        }
        _rehash() {
            const nt = new Int32Array(this.tab.length * 2),
                mask = nt.length - 1;
            for (let id = 0; id < this.count; id++) {
                let k = this.hh[id] & mask;
                while (nt[k] !== 0) k = (k + 1) & mask;
                nt[k] = id + 1;
            }
            this.tab = nt;
            this.mask = mask;
        }
    }

    class CsvProvider {
        // ix: OX.CsvIndex (may still be indexing; call sync() as rows arrive)
        constructor(ix, o) {
            o = o || {};
            this.opts = o;
            this.ix = ix;
            this.hasHeaders = !!(o.hasHeaders && ix.header);
            this.header = this.hasHeaders ? ix.header.slice() : null;
            this.headerLine = ix.headerLine;
            this.headerSpan = ix.headerSpan || 1;
            this.capitalizeHeaders = !!o.capitalizeHeaders;
            this.formatValues = o.formatValues || 'never';
            this.numberFormat = o.numberFormat || '';
            this.lineNumbers = o.lineNumbers || 'none';
            this.measure = o.measure || (s => s.length * 7.2);
            this.wrapMultiline = !!o.wrapMultiline;
            this.defaultRowHeight = o.rowHeight || 24;
            this.sep = ix.sep || ',';
            this.quote = ix.quoteStr || '"';
            this.literalText = true; // cells are literal text: grid/app must not shift or evaluate '=...' on fill/paste
            this._colCount = ix.colCount || 1;
            this.merges = [];
            this.frozenRows = this.hasHeaders ? 1 : 0;
            this.frozenCols = 0;
            this.showGridLines = true;
            this.off = this.hasHeaders ? 1 : 0;

            this._gap = null; // allocated on the first edit (line = f(span, gap))
            this._ov = new Map(); // edited cells
            this._scanD = -1;
            this._scanN = 0;
            this._lines = null; // per-row display line count cache (wrapMultiline)
            this._cache = new Map();
            this._colCache = new Map();
            this._agg = new Map();
            this._widths = [];
            this._widthsFilled = false;
            this._userWidths = new Map();
            this._userHeights = new Map();
            this.dataVersion = 0;
            this._n = 0;
            this._dirty = 0;
            this.sync();
            this.setDark(!!o.dark);
            if (o.headerBg) this.headerStyle.bg = o.headerBg;
        }

        // Picks up rows indexed since the last call (only valid before the first edit).
        sync() {
            const ix = this.ix;
            this._start = ix.start;
            this._line = ix.lineAt;
            this._span = ix.span;
            if (ix.n !== this._n) {
                this._agg.clear();
                this._colCache.clear();
                this._lines = null;
            }
            this._scanD = -1;
            this._n = ix.n;
            this._dirty = ix.n;
            if (ix.colCount > this._colCount) {
                this._colCount = ix.colCount;
                this._cache.clear();
            }
            if (ix.header && !this.header && this.hasHeaders) this.header = ix.header.slice();
            if (ix.done) {
                this._docLines = ix.lineCount;
                this._lastEmpty = ix.endsWithNewline !== false;
                if (this.hasHeaders && ix.header.length > this.header.length) {
                    for (let i = this.header.length; i < ix.header.length; i++) this.header.push(ix.header[i]);
                }
            }
            if (this._lines && this._lines.length < this._n) this._lines = null;
        }

        get dataRowCount() {
            return this._n;
        }

        setDark(dark) {
            this.dark = dark;
            this.headerStyle = mkStyle({ b: true, bg: this.opts.headerBg || (dark ? '#2b3140' : '#e6ebf3') });
            this._wrapStyle = mkStyle({ wrap: true, v: 'top' });
            this._cache.clear();
        }

        get rowCount() {
            return this._n + this.off;
        }
        get colCount() {
            return this._colCount;
        }
        isColHidden() {
            return false;
        }
        isRowHidden() {
            return false;
        }
        dataRow(r) {
            return r - this.off;
        }

        rowName(r) {
            if (this.lineNumbers === 'none') return '';
            if (this.hasHeaders && r === 0)
                return this.lineNumbers === 'source' && this.headerLine >= 0 ? String(this.headerLine + 1) : '';
            const d = r - this.off;
            if (d >= this._n) return '';
            if (this.lineNumbers === 'ordinal') return String(d + 1);
            this._ensure(d);
            return String(this._line[d] + 1);
        }

        // Single-row cache over the shared ix.fs/fe scratch; every other scanRow user must go through _rawScan.
        _scan(d) {
            if (this._scanD === d) return this._scanN;
            const st = this._start[d];
            const nf = st < 0 ? 0 : this.ix.scanRow(st);
            this._scanD = d;
            this._scanN = nf;
            return nf;
        }

        // Scans a row into the scratch without trusting/keeping the _scan cache (it is invalidated, the scratch is overwritten).
        _rawScan(st, upto) {
            this._scanD = -1;
            return this.ix.scanRow(st, upto);
        }

        _src(d, c) {
            const nf = this._scan(d);
            if (c >= nf) return '';
            const ix = this.ix;
            return ix.field(ix.fs[c], ix.fe[c]);
        }

        getRaw(r, c) {
            if (this.hasHeaders && r === 0) {
                const h = this.header[c];
                return h === undefined ? '' : h;
            }
            const d = r - this.off;
            if (d < 0 || d >= this._n) return '';
            if (this._ov.size) {
                const v = this._ov.get(d * OVK + c);
                if (v !== undefined) return v;
            }
            return this._src(d, c);
        }

        _wantsQ(q) {
            const f = this.formatValues;
            return f === 'always' || (f === 'unquoted' && !q);
        }

        _wantsNumber(d, c) {
            const f = this.formatValues;
            return f === 'always' || (f === 'unquoted' && !this.isQuoted(d, c));
        }

        isQuoted(d, c) {
            if (d < 0 || d >= this._n) return false;
            const nf = this._scan(d);
            if (c >= nf) return false;
            const ix = this.ix;
            return ix.isQuotedRange(ix.fs[c], ix.fe[c]);
        }

        _view(text, wantsNum) {
            if (wantsNum && isNumeric(text)) {
                return {
                    text: this.numberFormat ? formatNumberNet(Number(text), this.numberFormat) : text,
                    kind: 'number',
                    style: null
                };
            }
            let multi = false;
            if (text.length > 2000) text = text.slice(0, 2000);
            if (text.indexOf('\n') >= 0 || text.indexOf('\r') >= 0) {
                multi = true;
                if (!this.wrapMultiline) text = text.split(/\r\n|\n|\r/, 1)[0];
            }
            return { text, kind: 'text', style: multi && this.wrapMultiline ? this._wrapStyle : null };
        }

        getCell(r, c) {
            let text;
            if (this.hasHeaders && r === 0) {
                text = this.header[c];
                if (text === undefined || text === '') return undefined;
                const hk = -1 - c;
                let hv = this._cache.get(hk);
                if (!hv) {
                    hv = {
                        text: this.capitalizeHeaders ? toHeaderCase(text) : text,
                        kind: 'text',
                        style: this.headerStyle
                    };
                    if (hv.text.indexOf('\n') >= 0) hv.text = hv.text.split('\n')[0];
                    this._cache.set(hk, hv);
                }
                return hv;
            }
            const d = r - this.off;
            if (d < 0 || d >= this._n || c < 0 || c >= this._colCount) return undefined;
            const key = d * this._colCount + c; // collision-free: c < colCount, cache cleared whenever colCount changes
            let v = this._cache.get(key);
            if (v) return v;
            text = this.getRaw(r, c);
            if (text === '') return undefined;
            if (this._cache.size > MAX_CACHE) this._cache.clear();
            v = this._view(text, this.formatValues !== 'never' && this._wantsNumber(d, c));
            this._cache.set(key, v);
            return v;
        }

        searchText(r, c) {
            return this.getRaw(r, c);
        }

        setRowHeight(r, h) {
            this._userHeights.set(r, Math.max(8, h));
        }

        rowHeight(r) {
            if (this._userHeights.size) {
                const u = this._userHeights.get(r);
                if (u !== undefined) return u;
            }
            const h = this.defaultRowHeight;
            if (!this.wrapMultiline || (this.hasHeaders && r === 0)) return h;
            const d = r - this.off;
            if (d < 0 || d >= this._n || this._span[d] <= 1) return h;
            if (!this._lines || this._lines.length < this._n) {
                const l = new Uint8Array(Math.max(this._n, 16) + (this._n >> 1) + 16);
                if (this._lines) l.set(this._lines);
                this._lines = l;
            }
            let k = this._lines[d];
            if (!k) {
                let mx = 1;
                const row = this._rowStrings(d);
                for (let c = 0; c < row.length; c++) {
                    const s = row[c];
                    if (s && s.length > 1 && (s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0)) {
                        const lb = lineBreaks(s) + 1;
                        if (lb > mx) mx = lb;
                    }
                }
                k = this._lines[d] = Math.min(mx, 6);
            }
            return h + (k - 1) * LINE_H;
        }

        // Materialized fields of a data row (source + edits), length colCount.
        _rowStrings(d) {
            const n = this._colCount,
                out = new Array(n),
                ov = this._ov;
            const nf = this._scan(d),
                ix = this.ix;
            for (let c = 0; c < n; c++) {
                let v;
                if (ov.size && (v = ov.get(d * OVK + c)) !== undefined) {
                    out[c] = v;
                    continue;
                }
                out[c] = c < nf ? ix.field(ix.fs[c], ix.fe[c]) : '';
            }
            return out;
        }

        // ---- widths ----
        colWidth(c) {
            const u = this._userWidths.get(c);
            if (u !== undefined) return u;
            if (c >= this._colCount) return 48;
            let w = this._widths[c];
            if (w === undefined) {
                if (!this._widthsFilled && this._n > 0) this._fillWidths(400, MEASURE_COLS);
                w = this._widths[c];
                if (w === undefined) w = this._widths[c] = this._compute(c, 400);
            }
            return w;
        }

        setColWidth(c, w) {
            this._userWidths.set(c, Math.max(8, w));
        }

        // Recompute from content (rows sampled from the start); clears any user width.
        autosizeCol(c, maxRows) {
            this._userWidths.delete(c);
            return (this._widths[c] = this._compute(c, maxRows || 1000));
        }

        autosizeAll(maxRows) {
            this._userWidths.clear();
            this._fillWidths(maxRows || 1000, 64);
        }

        _compute(c, maxRows) {
            let mx = 0;
            if (this.hasHeaders) {
                const hv = this.getCell(0, c);
                if (hv) mx = this.measure(hv.text) * 1.1;
            }
            const n = Math.min(this._n, maxRows);
            for (let d = 0; d < n; d++) {
                const v = this.getCell(d + this.off, c);
                if (v) {
                    const m = this.measure(v.text.length > 120 ? v.text.slice(0, 120) : v.text);
                    if (m > mx) mx = m;
                }
            }
            return Math.max(48, Math.min(400, Math.ceil(mx) + 20));
        }

        // One pass over the sample rows for all columns; columns >= realCols use a byte-length estimate.
        _fillWidths(maxRows, realCols) {
            this._widthsFilled = true;
            const cc = this._colCount,
                mx = new Float64Array(cc),
                ix = this.ix;
            if (this.hasHeaders)
                for (let c = 0; c < cc; c++) {
                    const hv = this.getCell(0, c);
                    if (hv) mx[c] = this.measure(hv.text) * 1.1;
                }
            const n = Math.min(this._n, maxRows),
                ov = this._ov.size > 0;
            for (let d = 0; d < n; d++) {
                const r = d + this.off;
                const nf = this._scan(d);
                for (let c = 0; c < cc; c++) {
                    if (c < realCols || (ov && this._ov.has(d * OVK + c))) {
                        const v = this.getCell(r, c);
                        if (v) {
                            const m = this.measure(v.text.length > 120 ? v.text.slice(0, 120) : v.text);
                            if (m > mx[c]) mx[c] = m;
                        }
                    } else if (c < nf) {
                        const len = ix.fe[c] - ix.fs[c],
                            m = (len > 120 ? 120 : len) * 7.2;
                        if (m > mx[c]) mx[c] = m;
                    }
                }
            }
            for (let c = 0; c < cc; c++)
                if (this._widths[c] === undefined || realCols >= cc)
                    this._widths[c] = Math.max(48, Math.min(400, Math.ceil(mx[c]) + 20));
        }

        // ---- editing ----
        _ensureGap() {
            if (this._gap) return;
            const n = this._n,
                L = this._line,
                S = this._span,
                G = (this._gap = new Int32Array(this._start.length));
            for (let i = 0; i < n; i++) G[i] = i ? L[i] - L[i - 1] - S[i - 1] : L[0];
            this._dirty = n;
        }

        _ensure(d) {
            if (this._dirty > d) return;
            const L = this._line,
                S = this._span,
                G = this._gap;
            for (let i = this._dirty; i <= d; i++) L[i] = i ? L[i - 1] + S[i - 1] + G[i] : G[0];
            this._dirty = d + 1;
        }

        _touch(d) {
            if (d + 1 < this._dirty) this._dirty = d + 1;
        }

        _edited() {
            this.dataVersion++;
            if (this._colCache.size) this._colCache.clear();
            if (this._agg.size) this._agg.clear();
        }

        getSourceRange(r) {
            // Header without a source line (empty / blank-only / comment-only file): empty range at line 0 = insert there.
            if (this.hasHeaders && r === 0)
                return this.headerLine < 0
                    ? { start: 0, end: 0 }
                    : { start: this.headerLine, end: this.headerLine + this.headerSpan };
            const d = r - this.off;
            if (d < 0 || d >= this._n) return { start: 0, end: 0 };
            this._ensure(d);
            return { start: this._line[d], end: this._line[d] + this._span[d] };
        }

        setCell(r, c, text) {
            if (!this.ix.done) return;
            text = text == null ? '' : String(text);
            if (this.hasHeaders && r === 0) {
                const old = this.header[c] || '';
                if (old === text) return;
                this._ensureGap();
                while (this.header.length <= c) this.header.push('');
                this.header[c] = text;
                if (c >= this._colCount) this._growCols(c + 1);
                let delta = lineBreaks(text) - lineBreaks(old);
                if (this.headerLine < 0) {
                    // First header text of a header-less doc: it becomes a real line inserted at line 0, shifting every row.
                    this.headerLine = 0;
                    this.headerSpan = lineBreaks(text) + 1;
                    delta = this.headerSpan;
                } else if (delta) this.headerSpan += delta;
                if (delta) {
                    this._docLines += delta;
                    if (this._n) {
                        this._gap[0] += delta;
                        this._dirty = 0;
                    }
                }
                this._cache.delete(-1 - c);
                this._widths[c] = undefined;
                this._edited();
                return;
            }
            const d = r - this.off;
            if (d < 0 || d >= this._n) return;
            const old = this.getRaw(r, c);
            if (old === text) return;
            this._ensureGap();
            this._ov.set(d * OVK + c, text);
            if (c >= this._colCount) this._growCols(c + 1);
            const delta = lineBreaks(text) - lineBreaks(old);
            if (delta) {
                this._span[d] += delta;
                this._docLines += delta;
                this._touch(d);
            }
            this._cache.delete(d * this._colCount + c);
            if (this._lines && d < this._lines.length) this._lines[d] = 0;
            this._edited();
        }

        _growCols(n) {
            this._colCount = n;
            this._cache.clear();
        }

        // Deletes provider rows (header ignored); returns pre-deletion source ranges, ascending.
        deleteRows(indices) {
            const ranges = [];
            if (!this.ix.done) return ranges;
            const del = Array.from(
                new Set(indices.filter(r => r >= this.off && r < this.rowCount).map(r => r - this.off))
            ).sort((a, b) => a - b);
            if (!del.length) return ranges;
            this._ensureGap();
            this._ensure(del[del.length - 1]);
            for (const d of del) {
                ranges.push({ start: this._line[d], end: this._line[d] + this._span[d] });
                this._docLines -= this._span[d];
            }
            const n = this._n;
            let j = 0,
                k = 0,
                carry = 0;
            const L = this._line,
                S = this._span,
                G = this._gap,
                T = this._start;
            for (let i = 0; i < n; i++) {
                if (k < del.length && del[k] === i) {
                    k++;
                    carry += G[i];
                    continue;
                }
                T[j] = T[i];
                S[j] = S[i];
                G[j] = G[i] + carry;
                L[j] = L[i];
                carry = 0;
                j++;
            }
            this._n = j;
            if (this._ov.size) {
                const nov = new Map();
                this._ov.forEach((v, key) => {
                    const d = Math.floor(key / OVK);
                    let lo = 0,
                        hi = del.length;
                    while (lo < hi) {
                        const m = (lo + hi) >> 1;
                        if (del[m] < d) lo = m + 1;
                        else hi = m;
                    }
                    if (lo < del.length && del[lo] === d) return;
                    nov.set((d - lo) * OVK + (key - d * OVK), v);
                });
                this._ov = nov;
            }
            this._scanD = -1;
            this._dirty = Math.min(this._dirty, del[0]);
            if (this._userHeights.size) {
                const delSet = new Set(del.map(d => d + this.off)),
                    nh = new Map();
                this._userHeights.forEach((h, r) => {
                    if (delSet.has(r)) return;
                    let shift = 0;
                    for (const x of del)
                        if (x + this.off < r) shift++;
                        else break;
                    nh.set(r - shift, h);
                });
                this._userHeights = nh;
            }
            this._cache.clear();
            this._lines = null;
            this._edited();
            return ranges;
        }

        // Returns the new provider row index.
        appendRow() {
            if (!this.ix.done) return -1;
            this._ensureGap();
            const n = this._n;
            if (n >= this._start.length) {
                const cap = Math.max(16, this._start.length * 2);
                this._line = growI32(this._line, cap);
                this._span = growI32(this._span, cap);
                this._gap = growI32(this._gap, cap);
                this._start = growI32(this._start, cap);
            }
            this._ensure(n - 1);
            const newLine = this._lastEmpty ? Math.max(this._docLines - 1, 0) : this._docLines;
            const end = n ? this._line[n - 1] + this._span[n - 1] : 0;
            this._gap[n] = newLine - end;
            this._line[n] = newLine;
            this._span[n] = 1;
            this._start[n] = -1;
            this._n = n + 1;
            this._scanD = -1;
            this._dirty = n + 1;
            this._docLines = newLine + 2;
            this._lastEmpty = true;
            this._edited();
            return n + this.off;
        }

        serializeRow(r) {
            const isHdr = this.hasHeaders && r === 0;
            const cc = this._colCount,
                out = new Array(cc),
                fl = new Array(cc);
            if (isHdr) {
                for (let c = 0; c < cc; c++) {
                    out[c] = this.header[c] !== undefined ? this.header[c] : '';
                    fl[c] = false;
                }
            } else {
                const d = r - this.off,
                    row = d >= 0 && d < this._n ? this._rowStrings(d) : null;
                for (let c = 0; c < cc; c++) {
                    out[c] = row ? row[c] : '';
                    fl[c] = row ? this.isQuoted(d, c) : false;
                }
            }
            // A lone empty field would be an empty line, which the parser skips; quote it so the row survives.
            if (cc === 1 && out[0] === '') fl[0] = true;
            return OX.serializeCsvRow(out, this.sep, this.quote, fl);
        }

        // ---- column analytics (generators: iterate with next(); a yielded number is a progress fraction) ----
        _fast() {
            return this.ix.qlen === 1;
        }

        // Sort keys per provider row: cat 0 number (hi/lo = order-preserving uint64), 1 text (lo = index into strs), 2 blank.
        *sortKeyColumn(c) {
            const R = this.rowCount,
                off = this.off,
                n = this._n,
                ix = this.ix;
            const cat = new Uint8Array(R).fill(2),
                hi = new Uint32Array(R),
                lo = new Uint32Array(R);
            const ov = this._ov,
                hasOv = ov.size > 0,
                T = this._start,
                q0 = ix.q0,
                fast = this._fast();
            const it = new Interner(ix),
                eMap = new Map(),
                eList = [];
            const hiI = LE ? 1 : 0,
                loI = LE ? 0 : 1,
                EBASE = 0x40000000;
            const setNum = (r, x) => {
                f64[0] = x === 0 ? 0 : x;
                let h = u32[hiI],
                    l = u32[loI];
                if (h & 0x80000000) {
                    h = ~h;
                    l = ~l;
                } else h |= 0x80000000;
                cat[r] = 0;
                hi[r] = h >>> 0;
                lo[r] = l >>> 0;
            };
            const setStr = (v, r) => {
                if (v === '') return;
                const bb = OX.csvToBytes(v),
                    x = OX.csvNumBytes(bb, 0, bb.length, false);
                if (x === x) {
                    setNum(r, x);
                    return;
                }
                let id = eMap.get(v);
                if (id === undefined) {
                    id = eList.length;
                    eList.push(v);
                    eMap.set(v, id);
                }
                cat[r] = 1;
                lo[r] = EBASE + id;
            };
            let mark = 0;
            for (let d = 0; d < n; d++) {
                const st = T[d],
                    r = d + off;
                if (st - mark > YIELD_BYTES) {
                    mark = st;
                    yield (0.6 * d) / n;
                }
                if (hasOv) {
                    const v = ov.get(d * OVK + c);
                    if (v !== undefined) {
                        setStr(v, r);
                        continue;
                    }
                }
                if (st < 0) continue;
                const nf = this._rawScan(st, c);
                if (c >= nf) continue;
                let s = ix.fs[c],
                    e = ix.fe[c];
                if (e === s) continue;
                if (!fast) {
                    setStr(ix.field(s, e), r);
                    continue;
                }
                const b = ix.bytes;
                if (e - s >= 2 && b[s] === q0 && b[e - 1] === q0) {
                    const s0 = s,
                        e0 = e;
                    s++;
                    e--;
                    if (e === s) continue;
                    let odd = false;
                    for (let i = s; i < e; i++)
                        if (b[i] === q0) {
                            odd = true;
                            break;
                        }
                    if (odd) {
                        setStr(ix.field(s0, e0), r);
                        continue;
                    }
                }
                const x = OX.csvNumBytes(b, s, e, false);
                if (x === x) {
                    setNum(r, x);
                    continue;
                }
                cat[r] = 1;
                lo[r] = it.intern(s, e);
            }
            const base = it.count,
                strs = new Array(base + eList.length);
            for (let id = 0; id < base; id++) {
                if ((id & 4095) === 4095) yield 0.6 + (0.1 * id) / base;
                strs[id] = ix.field(it.ss[id], it.ee[id]).toLowerCase();
            }
            for (let i = 0; i < eList.length; i++) strs[base + i] = eList[i].toLowerCase();
            if (eList.length)
                for (let r = off; r < R; r++) if (cat[r] === 1 && lo[r] >= EBASE) lo[r] = lo[r] - EBASE + base;
            return { cat, hi, lo, strs };
        }

        // Per-row ids into the distinct display values of column c; ids/values null when more than maxDistinct values.
        *columnIds(c, maxDistinct, raw) {
            maxDistinct = maxDistinct || 50000;
            const ck = c * 4 + (raw ? 2 : 1),
                cached = this._colCache.get(ck);
            if (cached && cached.max >= maxDistinct) return cached;
            const R = this.rowCount,
                off = this.off,
                n = this._n,
                ix = this.ix;
            const ids = new Int32Array(R).fill(-1),
                ov = this._ov,
                hasOv = ov.size > 0,
                T = this._start;
            const it = new Interner(ix, maxDistinct + 1),
                eMap = new Map(),
                eList = [];
            const BLANK = 0x20000000,
                EBASE = 0x40000000;
            let sawBlank = false,
                mark = 0;
            const res = { ids: null, values: null, counts: null, truncated: false, max: maxDistinct };
            for (let d = 0; d < n; d++) {
                const st = T[d],
                    r = d + off;
                if (st - mark > YIELD_BYTES) {
                    mark = st;
                    yield (0.7 * d) / n;
                }
                if (hasOv) {
                    const v = ov.get(d * OVK + c);
                    if (v !== undefined) {
                        let id = eMap.get(v);
                        if (id === undefined) {
                            id = eList.length;
                            eList.push({ v, q: this.isQuoted(d, c) });
                            eMap.set(v, id);
                        }
                        ids[r] = EBASE + id;
                        continue;
                    }
                }
                let s = 0,
                    e = 0;
                if (st >= 0) {
                    const nf = this._rawScan(st, c);
                    if (c < nf) {
                        s = ix.fs[c];
                        e = ix.fe[c];
                    }
                }
                if (e === s) {
                    ids[r] = BLANK;
                    sawBlank = true;
                    continue;
                }
                const id = it.intern(s, e);
                if (id < 0) {
                    res.truncated = true;
                    return res;
                }
                ids[r] = id;
            }
            const map = new Map(),
                values = [],
                cnt = [];
            const dense = text => {
                let k = map.get(text);
                if (k === undefined) {
                    k = values.length;
                    values.push(text);
                    cnt.push(0);
                    map.set(text, k);
                }
                return k;
            };
            const base = it.count,
                l1 = new Int32Array(base);
            for (let id = 0; id < base; id++) {
                if ((id & 2047) === 2047) yield 0.7 + (0.1 * id) / base;
                const s = it.ss[id],
                    e = it.ee[id];
                const txt = ix.field(s, e);
                l1[id] =
                    txt === ''
                        ? dense('')
                        : dense(raw ? txt : this._view(txt, this._wantsQ(ix.isQuotedRange(s, e))).text);
            }
            const eIds = eList.map(x => dense(x.v === '' || raw ? x.v : this._view(x.v, this._wantsQ(x.q)).text));
            const blankId = sawBlank ? dense('') : -1;
            for (let r = off; r < R; r++) {
                if (((r - off) & 0x3ffff) === 0x3ffff) yield 0.8 + (0.2 * (r - off)) / Math.max(1, n);
                const v = ids[r];
                if (v < 0) continue;
                const k = v >= EBASE ? eIds[v - EBASE] : v >= BLANK ? blankId : l1[v];
                ids[r] = k;
                cnt[k]++;
            }
            res.ids = ids;
            res.values = values;
            res.counts = Int32Array.from(cnt);
            if (this._colCache.size >= 3) this._colCache.clear();
            this._colCache.set(ck, res);
            return res;
        }

        // Accumulates count/sum/min/max (acc: {cnt,nums,sum,min,max}) over a rectangle; `rows` optionally maps view rows to
        // provider rows. Whole data columns are cached until the next edit.
        *rangeStats(acc, rows, r1, r2, c1, c2) {
            const off = this.off,
                n = this._n,
                ix = this.ix,
                ov = this._ov,
                hasOv = ov.size > 0,
                T = this._start;
            const fmt = this.formatValues,
                q0 = ix.q0,
                fast = this._fast(),
                wantNum = fmt !== 'never';
            c2 = Math.min(c2, this._colCount - 1);
            const nc = c2 - c1 + 1;
            const reset = () => {
                acc.cnt = 0;
                acc.nums = 0;
                acc.sum = 0;
                acc.min = Infinity;
                acc.max = -Infinity;
            };
            reset();
            if (nc <= 0) return acc;
            const cnt = new Float64Array(nc),
                nums = new Float64Array(nc),
                sum = new Float64Array(nc),
                hc = new Float64Array(nc);
            const mn = new Float64Array(nc).fill(Infinity),
                mx = new Float64Array(nc).fill(-Infinity),
                have = new Uint8Array(nc);
            const total = rows ? Math.min(r2, rows.length - 1) - r1 + 1 : r2 - r1 + 1;
            const whole = !rows && r1 <= off && r2 >= this.rowCount - 1 && fast;
            let hi = c2;
            if (whole) {
                hi = -1;
                for (let c = c1; c <= c2; c++) {
                    const a = this._agg.get(c),
                        k = c - c1;
                    if (a) {
                        have[k] = 1;
                        cnt[k] = a.cnt;
                        nums[k] = a.nums;
                        sum[k] = a.sum;
                        mn[k] = a.min;
                        mx[k] = a.max;
                    } else hi = c;
                }
            }
            const snap = () => {
                reset();
                for (let k = 0; k < nc; k++) {
                    acc.cnt += cnt[k] + hc[k];
                    acc.nums += nums[k];
                    acc.sum += sum[k];
                    if (mn[k] < acc.min) acc.min = mn[k];
                    if (mx[k] > acc.max) acc.max = mx[k];
                }
            };
            let mark = 0,
                tick = 0;
            for (let i = 0; hi >= 0 && i < total; i++) {
                const r = rows ? rows[r1 + i] : r1 + i;
                if (this.hasHeaders && r === 0) {
                    for (let c = c1; c <= c2; c++) {
                        const h = this.header[c];
                        if (h !== undefined && h !== '') hc[c - c1] = 1;
                    }
                    continue;
                }
                const d = r - off;
                if (d < 0 || d >= n) continue;
                const st = T[d];
                if (st - mark > YIELD_BYTES || (++tick & 0x3fff) === 0) {
                    if (st > mark) mark = st;
                    snap();
                    yield i / total;
                }
                if (!fast) {
                    for (let c = c1; c <= c2; c++) {
                        const cv = this.getCell(r, c);
                        if (!cv || cv.text === '') continue;
                        const k = c - c1;
                        cnt[k]++;
                        if (cv.kind === 'number') {
                            const x = Number(this.getRaw(r, c));
                            if (x === x) {
                                nums[k]++;
                                sum[k] += x;
                                if (x < mn[k]) mn[k] = x;
                                if (x > mx[k]) mx[k] = x;
                            }
                        }
                    }
                    continue;
                }
                const nf = st >= 0 ? this._rawScan(st, hi) : 0,
                    b = ix.bytes,
                    fs = ix.fs,
                    fe = ix.fe;
                for (let c = c1; c <= hi; c++) {
                    const k = c - c1;
                    if (have[k]) continue;
                    let s = 0,
                        e = 0,
                        quoted = false,
                        v;
                    if (hasOv && (v = ov.get(d * OVK + c)) !== undefined) {
                        if (v === '') continue;
                        cnt[k]++;
                        if (wantNum && (fmt === 'always' || !(c < nf && ix.isQuotedRange(fs[c], fe[c])))) {
                            const bb = OX.csvToBytes(v),
                                x = OX.csvNumBytes(bb, 0, bb.length, true);
                            if (x === x) {
                                nums[k]++;
                                sum[k] += x;
                                if (x < mn[k]) mn[k] = x;
                                if (x > mx[k]) mx[k] = x;
                            }
                        }
                        continue;
                    }
                    if (c >= nf) {
                        if (!hasOv) break;
                        continue;
                    }
                    s = fs[c];
                    e = fe[c];
                    if (e === s) continue;
                    if (e - s >= 2 && b[s] === q0 && b[e - 1] === q0) {
                        quoted = true;
                        s++;
                        e--;
                        if (e === s) continue;
                    }
                    cnt[k]++;
                    if (wantNum && (fmt === 'always' || !quoted)) {
                        const x = OX.csvNumBytes(b, s, e, true);
                        if (x === x) {
                            nums[k]++;
                            sum[k] += x;
                            if (x < mn[k]) mn[k] = x;
                            if (x > mx[k]) mx[k] = x;
                        }
                    }
                }
            }
            if (whole) {
                if (this._agg.size > 64) this._agg.clear();
                for (let k = 0; k < nc; k++)
                    if (!have[k])
                        this._agg.set(c1 + k, { cnt: cnt[k], nums: nums[k], sum: sum[k], min: mn[k], max: mx[k] });
                if (this.hasHeaders && r1 === 0)
                    for (let c = c1; c <= c2; c++) {
                        const h = this.header[c];
                        if (h !== undefined && h !== '') hc[c - c1] = 1;
                    }
            }
            snap();
            return acc;
        }
    }

    OX.CsvProvider = CsvProvider;
    OX.formatNumberNet = formatNumberNet;
    OX.csvIsNumeric = isNumeric;
    if (typeof module !== 'undefined' && module.exports) module.exports = OX;
})(typeof globalThis !== 'undefined' ? globalThis : this);
