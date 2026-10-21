(function (root) {
    'use strict';
    const OX = root.OX || (root.OX = {});
    const MAX_SCROLL = 30e6;

    function colName(c) {
        let s = '';
        c++;
        while (c > 0) {
            const m = (c - 1) % 26;
            s = String.fromCharCode(65 + m) + s;
            c = ((c - 1 - m) / 26) | 0;
        }
        return s;
    }

    // Axis: layout of rows or columns with hidden items and zoom. Modes: uniform, sparse (few overrides over a default), dense (prefix sums).
    class Axis {
        constructor() {
            this.count = 0;
            this.def = 20;
            this.zoom = 1;
            this.uniform = true;
            this.mode = 0;
            this.u = 20;
            this.total = 0;
            this.base = null;
            this.sizes = null;
            this.pre = null;
            this.idx = null;
            this.bsz = null;
            this.cum = null;
        }
        // sizeFn(i)->px (unzoomed), hiddenFn(i)->bool
        build(count, sizeFn, hiddenFn, def, zoom) {
            let base = null,
                nd = 0;
            for (let i = 0; i < count; i++) {
                let s = hiddenFn && hiddenFn(i) ? 0 : sizeFn(i);
                if (!(s >= 0)) s = def;
                if (base === null) {
                    if (s === def) continue;
                    base = new Float64Array(count);
                    base.fill(def, 0, i);
                }
                base[i] = s;
                if (s !== def) nd++;
            }
            if (base === null) return this.buildUniform(count, def, zoom);
            if (nd * 16 < count) {
                const idx = new Int32Array(nd),
                    sz = new Float64Array(nd);
                let k = 0;
                for (let i = 0; i < count; i++)
                    if (base[i] !== def) {
                        idx[k] = i;
                        sz[k++] = base[i];
                    }
                return this._sparse(count, def, zoom, idx, sz);
            }
            return this._dense(count, def, zoom, base);
        }
        // quick path for huge uniform axes when the caller guarantees uniformity
        buildUniform(count, size, zoom) {
            this.count = count;
            this.def = size;
            this._z(zoom);
            this.mode = 0;
            this.uniform = true;
            this.base = this.sizes = this.pre = this.idx = this.bsz = this.cum = null;
            this.total = count * this.u;
            return this;
        }
        // overrides: Map/array of [index, unzoomedSize] over a uniform default; indices >= count ignored
        buildSparse(count, def, zoom, overrides) {
            const m = new Map();
            for (const [i, s] of overrides) if (i >= 0 && i < count) m.set(i, s >= 0 ? s : def);
            if (!m.size) return this.buildUniform(count, def, zoom);
            const idx = Int32Array.from(m.keys()).sort(),
                sz = new Float64Array(idx.length);
            for (let k = 0; k < idx.length; k++) sz[k] = m.get(idx[k]);
            return this._sparse(count, def, zoom, idx, sz);
        }
        _z(zoom) {
            this.zoom = zoom || 1;
            this.u = Math.round(this.def * this.zoom * 100) / 100;
        }
        _sparse(count, def, zoom, idx, sz) {
            this.count = count;
            this.def = def;
            this._z(zoom);
            this.mode = 1;
            this.uniform = false;
            this.base = this.sizes = this.pre = null;
            this.idx = idx;
            this.bsz = sz;
            this._cumSparse();
            return this;
        }
        _cumSparse() {
            const n = this.idx.length,
                z = this.zoom,
                u = this.u,
                cum = this.cum && this.cum.length === n + 1 ? this.cum : new Float64Array(n + 1);
            let acc = 0;
            for (let k = 0; k < n; k++) {
                cum[k] = acc;
                acc += this.bsz[k] * z - u;
            }
            cum[n] = acc;
            this.cum = cum;
            this.total = this.count * u + acc;
        }
        _dense(count, def, zoom, base) {
            this.count = count;
            this.def = def;
            this._z(zoom);
            this.mode = 2;
            this.uniform = false;
            this.idx = this.bsz = this.cum = null;
            this.base = base;
            this.sizes = new Float64Array(count);
            this.pre = new Float64Array(count + 1);
            this._cumDense(0);
            return this;
        }
        _cumDense(from) {
            const n = this.count,
                z = this.zoom,
                base = this.base,
                sizes = this.sizes,
                pre = this.pre;
            let acc = from > 0 ? pre[from] : 0;
            for (let i = from; i < n; i++) {
                const s = base[i] * z;
                sizes[i] = s;
                pre[i] = acc;
                acc += s;
            }
            pre[n] = acc;
            this.total = acc;
        }
        setZoom(zoom) {
            if (this.mode === 0 || this.mode === 1) {
                this._z(zoom);
                if (this.mode === 0) this.total = this.count * this.u;
                else this._cumSparse();
            } else {
                this.zoom = zoom || 1;
                this._cumDense(0);
            }
            return this;
        }
        // change the item count keeping sizes (uniform/sparse axes only); false when a rebuild is needed
        setCount(n) {
            if (n === this.count) return true;
            if (this.mode === 2) return false;
            if (this.mode === 1 && n < this.count) {
                const k = this._lb(n);
                if (k < this.idx.length) {
                    this.idx = this.idx.slice(0, k);
                    this.bsz = this.bsz.slice(0, k);
                    this.cum = null;
                }
            }
            this.count = n;
            if (this.mode === 0) this.total = n * this.u;
            else this._cumSparse();
            return true;
        }
        // apply unzoomed size changes (Map index->px) without calling back into the provider
        setSizes(upd) {
            if (!upd.size) return this;
            if (this.mode === 0 || this.mode === 1) {
                const m = new Map();
                if (this.mode === 1) for (let k = 0; k < this.idx.length; k++) m.set(this.idx[k], this.bsz[k]);
                for (const [i, s] of upd)
                    if (i >= 0 && i < this.count) {
                        if (s === this.def) m.delete(i);
                        else m.set(i, s >= 0 ? s : this.def);
                    }
                if (m.size * 16 > this.count) {
                    const base = new Float64Array(this.count).fill(this.def);
                    for (const [i, s] of m) base[i] = s;
                    return this._dense(this.count, this.def, this.zoom, base);
                }
                if (!m.size) return this.buildUniform(this.count, this.def, this.zoom);
                const idx = Int32Array.from(m.keys()).sort(),
                    sz = new Float64Array(idx.length);
                for (let k = 0; k < idx.length; k++) sz[k] = m.get(idx[k]);
                this.idx = idx;
                this.bsz = sz;
                this.mode = 1;
                this.uniform = false;
                this.cum = null;
                this._cumSparse();
                return this;
            }
            let lo = this.count;
            for (const [i, s] of upd)
                if (i >= 0 && i < this.count) {
                    this.base[i] = s >= 0 ? s : this.def;
                    if (i < lo) lo = i;
                }
            if (lo < this.count) this._cumDense(lo);
            return this;
        }
        _lb(i) {
            // number of override indices < i
            const idx = this.idx;
            let lo = 0,
                hi = idx.length;
            while (lo < hi) {
                const m = (lo + hi) >> 1;
                if (idx[m] < i) lo = m + 1;
                else hi = m;
            }
            return lo;
        }
        offset(i) {
            if (i <= 0) return 0;
            if (i >= this.count) return this.total + (i - this.count) * this.u;
            return this.mode === 0 ? i * this.u : this.mode === 2 ? this.pre[i] : i * this.u + this.cum[this._lb(i)];
        }
        size(i) {
            if (i < 0) return 0;
            if (i >= this.count) return this.u;
            if (this.mode === 0) return this.u;
            if (this.mode === 2) return this.sizes[i];
            const k = this._lb(i);
            return k < this.idx.length && this.idx[k] === i ? this.bsz[k] * this.zoom : this.u;
        }
        // index containing pixel p (clamped to [0,count-1]); skips zero-size items forward
        indexAt(p) {
            const n = this.count;
            if (n === 0) return 0;
            if (p >= this.total) return n - 1;
            if (this.mode === 0) return p <= 0 ? 0 : Math.min(n - 1, Math.floor(p / this.u));
            let lo = 0;
            if (p > 0) {
                let hi = n - 1;
                if (this.mode === 2) {
                    const pre = this.pre;
                    while (lo < hi) {
                        const mid = (lo + hi + 1) >> 1;
                        if (pre[mid] <= p) lo = mid;
                        else hi = mid - 1;
                    }
                } else
                    while (lo < hi) {
                        const mid = (lo + hi + 1) >> 1;
                        if (this.offset(mid) <= p) lo = mid;
                        else hi = mid - 1;
                    }
            }
            while (lo < n - 1 && this.size(lo) === 0) lo++;
            return lo;
        }
        isHidden(i) {
            return i >= 0 && i < this.count && this.size(i) === 0;
        }
        // next visible index from i in direction d (+1/-1), or -1
        nextVisible(i, d) {
            i += d;
            while (i >= 0 && i < this.count && this.size(i) === 0) i += d;
            return i >= 0 && i < this.count ? i : -1;
        }
    }

    // Scroll mapping for totals beyond browser limits.
    function scrollScale(total, viewport) {
        const max = Math.max(0, total - viewport);
        if (total <= MAX_SCROLL) return { cssTotal: total, ratio: 1 };
        const cssTotal = MAX_SCROLL;
        const cssMax = cssTotal - viewport;
        return { cssTotal, ratio: max / cssMax };
    }

    // Merge lookup: merges are bucketed by row block (16 rows); very tall merges live in a short side list. Cost is independent of the merge count.
    const MB = 4,
        MB_TALL = 256;
    class MergeIndex {
        constructor(merges) {
            const L = (this.list = merges || []);
            this.bk = new Map();
            this.tall = [];
            this.stamp = new Int32Array(L.length);
            this.st = 0;
            this.tmp = [];
            for (let i = 0; i < L.length; i++) {
                const m = L[i],
                    b1 = m.r1 >> MB,
                    b2 = m.r2 >> MB;
                if (b2 - b1 >= MB_TALL) {
                    this.tall.push(i);
                    continue;
                }
                for (let b = b1; b <= b2; b++) {
                    const a = this.bk.get(b);
                    if (a) a.push(i);
                    else this.bk.set(b, [i]);
                }
            }
        }
        get size() {
            return this.list.length;
        }
        at(r, c) {
            const L = this.list;
            if (!L.length) return null;
            const a = this.bk.get(r >> MB);
            if (a !== undefined)
                for (let k = 0; k < a.length; k++) {
                    const m = L[a[k]];
                    if (r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) return m;
                }
            const t = this.tall;
            for (let k = 0; k < t.length; k++) {
                const m = L[t[k]];
                if (r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) return m;
            }
            return null;
        }
        // true when any merge may touch rows r1..r2 (cheap pre-check for paint loops)
        hasInRows(r1, r2) {
            if (!this.list.length) return false;
            if (this.tall.length) return true;
            const b2 = r2 >> MB;
            if (b2 - (r1 >> MB) > 64) return true;
            for (let b = r1 >> MB; b <= b2; b++) if (this.bk.has(b)) return true;
            return false;
        }
        // merges intersecting the rect, appended to out (deduped)
        query(r1, c1, r2, c2, out) {
            const L = this.list;
            if (!L.length) return out;
            const b1 = r1 >> MB,
                b2 = r2 >> MB;
            if (b2 - b1 > 4096 || b2 - b1 > L.length) {
                for (let i = 0; i < L.length; i++) {
                    const m = L[i];
                    if (!(m.r1 > r2 || m.r2 < r1 || m.c1 > c2 || m.c2 < c1)) out.push(m);
                }
                return out;
            }
            const st = ++this.st,
                stamp = this.stamp;
            const chk = i => {
                if (stamp[i] === st) return;
                stamp[i] = st;
                const m = L[i];
                if (!(m.r1 > r2 || m.r2 < r1 || m.c1 > c2 || m.c2 < c1)) out.push(m);
            };
            for (let b = b1; b <= b2; b++) {
                const a = this.bk.get(b);
                if (a) for (let k = 0; k < a.length; k++) chk(a[k]);
            }
            for (let k = 0; k < this.tall.length; k++) chk(this.tall[k]);
            return out;
        }
        // expand rect until it fully contains any merge it touches
        expand(r1, c1, r2, c2) {
            if (!this.list.length) return { r1, c1, r2, c2 };
            const hit = this.tmp;
            for (let ch = true; ch;) {
                ch = false;
                hit.length = 0;
                this.query(r1, c1, r2, c2, hit);
                for (let k = 0; k < hit.length; k++) {
                    const m = hit[k];
                    if (m.r1 < r1) {
                        r1 = m.r1;
                        ch = true;
                    }
                    if (m.c1 < c1) {
                        c1 = m.c1;
                        ch = true;
                    }
                    if (m.r2 > r2) {
                        r2 = m.r2;
                        ch = true;
                    }
                    if (m.c2 > c2) {
                        c2 = m.c2;
                        ch = true;
                    }
                }
            }
            hit.length = 0;
            return { r1, c1, r2, c2 };
        }
    }

    const normRange = (r1, c1, r2, c2) => ({
        r1: Math.min(r1, r2),
        c1: Math.min(c1, c2),
        r2: Math.max(r1, r2),
        c2: Math.max(c1, c2)
    });
    const inRange = (g, r, c) => r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2;
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

    // Excel-like data-edge jump. isEmpty(r,c) -> bool.
    function dataEdge(isEmpty, r, c, dr, dc, maxR, maxC) {
        const inb = (rr, cc) => rr >= 0 && cc >= 0 && rr <= maxR && cc <= maxC;
        let nr = r + dr,
            nc = c + dc;
        if (!inb(nr, nc)) return { r, c };
        if (!isEmpty(r, c) && !isEmpty(nr, nc)) {
            // run to the last non-empty in the block
            while (inb(nr + dr, nc + dc) && !isEmpty(nr + dr, nc + dc)) {
                nr += dr;
                nc += dc;
            }
            return { r: nr, c: nc };
        }
        // skip empties to next non-empty, or the edge
        while (inb(nr, nc) && isEmpty(nr, nc)) {
            nr += dr;
            nc += dc;
        }
        if (!inb(nr, nc)) return { r: clamp(nr - dr, 0, maxR), c: clamp(nc - dc, 0, maxC) };
        return { r: nr, c: nc };
    }

    // TSV / CSV
    function needsQuote(s) {
        return s.indexOf('\t') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0 || s.indexOf('"') >= 0;
    }
    function encodeTSV(rows) {
        const out = [];
        for (const row of rows)
            out.push(
                row
                    .map(s => ((s = s == null ? '' : String(s)), needsQuote(s) ? '"' + s.replace(/"/g, '""') + '"' : s))
                    .join('\t')
            );
        return out.join('\r\n');
    }
    function decodeDelimited(text, d) {
        const rows = [];
        let row = [],
            i = 0,
            n = text.length,
            field = '';
        while (i < n) {
            const ch = text.charCodeAt(i);
            if (ch === 34 && field === '') {
                i++;
                let s = '';
                for (;;) {
                    const q = text.indexOf('"', i);
                    if (q < 0) {
                        s += text.slice(i);
                        i = n;
                        break;
                    }
                    s += text.slice(i, q);
                    if (text.charCodeAt(q + 1) === 34) {
                        s += '"';
                        i = q + 2;
                    } else {
                        i = q + 1;
                        break;
                    }
                }
                field = s;
                // trailing garbage until delimiter/newline kept literally
                while (i < n) {
                    const x = text[i];
                    if (x === d || x === '\n' || x === '\r') break;
                    field += x;
                    i++;
                }
                continue;
            }
            if (text[i] === d) {
                row.push(field);
                field = '';
                i++;
                continue;
            }
            if (ch === 10 || ch === 13) {
                row.push(field);
                field = '';
                rows.push(row);
                row = [];
                if (ch === 13 && text.charCodeAt(i + 1) === 10) i++;
                i++;
                continue;
            }
            let j = i;
            while (j < n) {
                const x = text[j];
                if (x === d || x === '\n' || x === '\r') break;
                j++;
            }
            field += text.slice(i, j);
            i = j;
        }
        if (field !== '' || row.length) {
            row.push(field);
            rows.push(row);
        }
        return rows;
    }
    // tabs present -> TSV, else CSV when it looks like one, else single column
    function decodeClipboard(text) {
        if (text == null || text === '') return [['']];
        if (text.indexOf('\t') >= 0) return decodeDelimited(text, '\t');
        if (text.indexOf(',') >= 0 && /[\r\n]/.test(text.replace(/[\r\n]+$/, ''))) {
            const rows = decodeDelimited(text, ',');
            const w = rows[0].length;
            if (w > 1 && rows.every(r => r.length === w)) return rows;
        }
        return decodeDelimited(text, '\u0000');
    }

    function toMarkdown(rows) {
        if (!rows.length) return '';
        const esc = s =>
            String(s == null ? '' : s)
                .replace(/\\/g, '\\\\')
                .replace(/\|/g, '\\|')
                .replace(/\r\n|\r|\n/g, '<br>')
                .replace(/\t/g, ' ')
                .trim();
        let w = 0;
        for (const r of rows) if (r.length > w) w = r.length;
        if (!w) return '';
        const line = r => {
            let o = '|';
            for (let i = 0; i < w; i++) o += ' ' + esc(r[i]) + ' |';
            return o;
        };
        const out = [line(rows[0]), '|' + ' --- |'.repeat(w)];
        for (let i = 1; i < rows.length; i++) out.push(line(rows[i]));
        return out.join('\n');
    }

    // Series detection for fill: returns step if all numbers evenly spaced.
    function fillSeries(values) {
        const nums = values.map(v => (v !== '' && isFinite(Number(v)) ? Number(v) : NaN));
        if (!nums.length || nums.some(isNaN)) return null;
        if (nums.length === 1) return { start: nums[0], step: 1, single: true };
        const step = nums[1] - nums[0];
        for (let i = 2; i < nums.length; i++)
            if (Math.abs(nums[i] - nums[i - 1] - step) > 1e-9 * Math.max(1, Math.abs(step))) return null;
        return { start: nums[0], step, single: false };
    }
    function fmtNum(n) {
        return String(Math.round(n * 1e10) / 1e10);
    }

    // Two-generation width cache bounded by entry count and total key chars; long strings are measured but not cached.
    class WidthCache {
        constructor(cap, maxChars, maxLen) {
            this.cap = cap || 20000;
            this.maxChars = maxChars || 2e6;
            this.maxLen = maxLen || 400;
            this.m = new Map();
            this.old = null;
            this.n = 0;
            this.chars = 0;
        }
        get(font, text, measure) {
            let fm = this.m.get(font);
            if (fm !== undefined) {
                const w = fm.get(text);
                if (w !== undefined) return w;
            }
            if (this.old !== null) {
                const of = this.old.get(font);
                if (of !== undefined) {
                    const w = of.get(text);
                    if (w !== undefined) {
                        this._put(font, fm, text, w);
                        return w;
                    }
                }
            }
            const w = measure(text);
            if (text.length <= this.maxLen) this._put(font, fm, text, w);
            return w;
        }
        _put(font, fm, text, w) {
            if (this.n >= this.cap || this.chars >= this.maxChars) {
                this.old = this.m;
                this.m = new Map();
                this.n = 0;
                this.chars = 0;
                fm = undefined;
            }
            if (fm === undefined) {
                fm = this.m.get(font);
                if (fm === undefined) {
                    fm = new Map();
                    this.m.set(font, fm);
                }
            }
            fm.set(text, w);
            this.n++;
            this.chars += text.length;
        }
    }

    // Shift relative A1 refs in a formula (skips string literals).
    function shiftFormula(f, dr, dc) {
        if (!f || (!dr && !dc)) return f;
        const lead = f.charCodeAt(0) === 61;
        const body = lead ? f.slice(1) : f;
        const parts = body.split('"');
        for (let i = 0; i < parts.length; i += 2) {
            parts[i] = parts[i].replace(
                /(^|[^A-Za-z0-9_.$])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(])/g,
                (m, pre, ca, col, ra, row) => {
                    let c = col.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
                    let r = parseInt(row, 10) - 1;
                    if (!ca) c += dc;
                    if (!ra) r += dr;
                    if (c < 0 || r < 0 || c > 16383 || r > 1048575) return pre + '#REF!';
                    return pre + ca + colName(c) + ra + (r + 1);
                }
            );
        }
        return (lead ? '=' : '') + parts.join('"');
    }

    // View-order mapping: visible row index -> source row.
    function makeViewMap(order, rowCount) {
        if (!order) return { count: rowCount, toSource: v => v, toView: s => s, order: null };
        let inv = null;
        return {
            count: order.length,
            order,
            toSource: v => (v < order.length ? order[v] : v - order.length + rowCount),
            toView: s => {
                if (!inv) {
                    inv = new Int32Array(rowCount).fill(-1);
                    for (let i = 0; i < order.length; i++) if (order[i] < rowCount) inv[order[i]] = i;
                }
                return s < rowCount ? inv[s] : s - rowCount + order.length;
            }
        };
    }

    // Search all cells; getText(r,c)->string|undefined. Returns [r,c] pairs flat array.
    function findAll(rowCount, colCount, getText, query, opts) {
        const out = [];
        if (!query) return out;
        const mc = opts && opts.matchCase,
            whole = opts && opts.wholeCell;
        const q = mc ? query : query.toLowerCase();
        for (let r = 0; r < rowCount; r++)
            for (let c = 0; c < colCount; c++) {
                let t = getText(r, c);
                if (!t) continue;
                if (!mc) t = t.toLowerCase();
                if (whole ? t === q : t.indexOf(q) >= 0) out.push(r, c);
            }
        return out;
    }

    // text predicate for find: (text)->bool, no per-call allocation
    function makeMatcher(query, opts) {
        const mc = opts && opts.matchCase,
            whole = opts && opts.wholeCell;
        if (!query) return () => false;
        if (mc) return whole ? t => t === query : t => t.indexOf(query) >= 0;
        const q = query.toLowerCase();
        if (whole) return t => t.length === q.length && t.toLowerCase() === q;
        const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        return t => t.length >= q.length && re.test(t);
    }

    // Time-sliced task runner: step(deadline)->true when finished. First slice runs synchronously on start(true).
    let _chan = null;
    function defaultDefer(f) {
        if (typeof MessageChannel === 'function') {
            if (!_chan) {
                const q = [];
                const ch = new MessageChannel();
                ch.port1.onmessage = () => {
                    const fn = q.shift();
                    if (fn) fn();
                };
                if (ch.port1.unref) ch.port1.unref();
                _chan = { q, port: ch.port2 };
            }
            _chan.q.push(f);
            _chan.port.postMessage(0);
        } else setTimeout(f, 0);
    }
    function createSlicer(step, o) {
        o = o || {};
        const now = o.now || (() => (typeof performance !== 'undefined' ? performance : Date).now()),
            budget = o.budget || 8,
            defer = o.defer || defaultDefer;
        const t = { cancelled: false, finished: false, slices: 0 };
        let queued = false;
        const run = () => {
            queued = false;
            if (t.cancelled || t.finished) return;
            t.slices++;
            if (step(now() + budget)) {
                t.finished = true;
                if (o.onDone) o.onDone();
            } else if (!t.cancelled) {
                queued = true;
                defer(run);
            }
        };
        t.start = sync => {
            if (sync) run();
            else if (!queued) {
                queued = true;
                defer(run);
            }
            return t;
        };
        t.cancel = () => {
            t.cancelled = true;
        };
        return t;
    }

    class MatchList {
        constructor() {
            this.a = new Float64Array(64);
            this.n = 0;
        }
        push(k) {
            if (this.n === this.a.length) {
                const b = new Float64Array(this.n * 2);
                b.set(this.a);
                this.a = b;
            }
            this.a[this.n++] = k;
        }
    }
    // Incremental find over rows; scans [startRow,end) then [0,startRow). Keys are r*65536+c; list B (rows < startRow) sorts before list A.
    class FindScan {
        constructor(o) {
            this.rows = Math.max(0, o.rowCount | 0);
            this.cols = Math.max(0, o.colCount | 0);
            this.get = o.getText;
            this.get2 = o.getText2 || null;
            this.match = o.match;
            this.max = o.maxMatches || 5e6;
            this.s = Math.min(Math.max(0, o.startRow | 0), this.rows);
            this.A = new MatchList();
            this.B = new MatchList();
            this.phase = 0;
            this.r = this.s;
            this.end = this.rows;
            this.done = false;
            this.truncated = false;
            this.scanned = 0;
        }
        get count() {
            return this.A.n + this.B.n;
        }
        step(deadline, now) {
            const cols = this.cols,
                get = this.get,
                get2 = this.get2,
                match = this.match;
            while (!this.done) {
                if (this.r >= this.end) {
                    if (this.phase === 0 && this.s > 0) {
                        this.phase = 1;
                        this.r = 0;
                        this.end = this.s;
                        continue;
                    }
                    this.done = true;
                    break;
                }
                const r = this.r,
                    list = this.phase ? this.B : this.A,
                    base = r * 65536;
                for (let c = 0; c < cols; c++) {
                    let t = get(r, c),
                        hit = !!t && match(t);
                    if (!hit && get2 !== null) {
                        t = get2(r, c);
                        hit = !!t && match(t);
                    }
                    if (hit) {
                        list.push(base + c);
                        if (this.A.n + this.B.n >= this.max) {
                            this.truncated = true;
                            this.done = true;
                            return true;
                        }
                    }
                }
                this.r++;
                this.scanned++;
                if ((this.scanned & 7) === 0 && now() >= deadline) break;
            }
            return this.done;
        }
    }
    // number of keys in MatchList strictly below k
    function lowerBound(list, k) {
        const a = list.a;
        let lo = 0,
            hi = list.n;
        while (lo < hi) {
            const m = (lo + hi) >> 1;
            if (a[m] < k) lo = m + 1;
            else hi = m;
        }
        return lo;
    }

    const TSV_Q = /[\t\n\r"]/;
    function tsvField(s) {
        return TSV_Q.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    // Chunked TSV assembly: getRow(i)->row string | null (skip). Bounded by maxChars; rows are joined in blocks to keep the heap flat.
    class TsvBuilder {
        constructor(o) {
            this.n = o.rowCount;
            this.getRow = o.getRow;
            this.max = o.maxChars || 64e6;
            this.i = 0;
            this.rows = 0;
            this.chars = 0;
            this.parts = [];
            this.cur = [];
            this.done = false;
            this.tooLarge = false;
            this.projected = 0;
        }
        step(deadline, now) {
            const n = this.n,
                getRow = this.getRow,
                cur = this.cur;
            while (this.i < n) {
                const s = getRow(this.i++);
                if (s !== null) {
                    this.chars += s.length + (this.rows ? 2 : 0);
                    this.rows++;
                    if (this.chars > this.max) return this._abort(this.chars);
                    cur.push(s);
                    if (cur.length >= 4096) {
                        this.parts.push(cur.join('\r\n'));
                        cur.length = 0;
                    }
                }
                if ((this.i & 15) === 0) {
                    if (this.i === 2048 || this.i === 16384) {
                        const proj = (this.chars / this.i) * n;
                        if (proj > this.max * 4) return this._abort(proj);
                    }
                    if (now() >= deadline) return false;
                }
            }
            if (cur.length) {
                this.parts.push(cur.join('\r\n'));
                cur.length = 0;
            }
            this.done = true;
            return true;
        }
        _abort(proj) {
            this.tooLarge = true;
            this.projected = proj;
            this.parts = [];
            this.cur.length = 0;
            this.done = true;
            return true;
        }
        text() {
            return this.parts.length === 1 ? this.parts[0] : this.parts.join('\r\n');
        }
    }

    OX.GridCore = {
        colName,
        Axis,
        scrollScale,
        MergeIndex,
        normRange,
        inRange,
        clamp,
        dataEdge,
        encodeTSV,
        decodeDelimited,
        decodeClipboard,
        toMarkdown,
        fillSeries,
        fmtNum,
        WidthCache,
        shiftFormula,
        makeViewMap,
        findAll,
        makeMatcher,
        createSlicer,
        FindScan,
        MatchList,
        lowerBound,
        TsvBuilder,
        tsvField,
        MAX_SCROLL
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = OX;
})(typeof globalThis !== 'undefined' ? globalThis : this);
