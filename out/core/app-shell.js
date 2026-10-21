(function (root) {
    'use strict';
    const OX = root.OX || (root.OX = {});
    const MAX_DISTINCT = 50000;
    const SMALL_STATS = 20000;
    const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const tick = (function () {
        if (typeof window !== 'undefined' && typeof MessageChannel !== 'undefined') {
            const ch = new MessageChannel(),
                q = [];
            ch.port1.onmessage = () => {
                const f = q.shift();
                if (f) f();
            };
            return fn => {
                q.push(fn);
                ch.port2.postMessage(0);
            };
        }
        return fn => setTimeout(fn, 0);
    })();

    // Runs generator `gen` in slices of ~budget ms; a yielded number is the progress (0..1). First slice runs synchronously.
    function runTask(gen, o) {
        o = o || {};
        const budget = o.budget || 8,
            t = { cancelled: false, done: false, progress: 0 };
        t.cancel = () => {
            if (!t.done) {
                t.cancelled = true;
                t.done = true;
                try {
                    gen.return();
                } catch (e) {
                    /* closing */
                }
            }
        };
        const step = () => {
            if (t.cancelled) return;
            const t0 = nowMs();
            try {
                for (;;) {
                    const r = gen.next();
                    if (r.done) {
                        t.done = true;
                        if (o.onDone) o.onDone(r.value);
                        return;
                    }
                    if (typeof r.value === 'number') t.progress = r.value;
                    if (nowMs() - t0 >= budget) break;
                }
            } catch (e) {
                t.done = true;
                if (o.onError) o.onError(e);
                else if (root.console) console.error(e);
                return;
            }
            if (o.onProgress) o.onProgress(t.progress);
            tick(step);
        };
        step();
        return t;
    }

    // Stable bottom-up merge sort of an Int32Array of indices, sliceable.
    function* mergeSortGen(a, less) {
        const n = a.length,
            RUN = 16;
        let src = a,
            dst = new Int32Array(n),
            work = 0;
        for (let s = 0; s < n; s += RUN) {
            const e = Math.min(n, s + RUN);
            for (let i = s + 1; i < e; i++) {
                const v = src[i];
                let j = i - 1;
                while (j >= s && less(v, src[j])) {
                    src[j + 1] = src[j];
                    j--;
                }
                src[j + 1] = v;
            }
            work += RUN;
            if (work > 40000) {
                work = 0;
                yield 0;
            }
        }
        let passes = 0;
        for (let w = RUN; w < n; w *= 2) passes++;
        for (let w = RUN, ps = 0; w < n; w *= 2, ps++) {
            for (let s = 0; s < n; s += 2 * w) {
                const m = Math.min(n, s + w),
                    e = Math.min(n, s + 2 * w);
                let i = s,
                    j = m,
                    k = s;
                while (i < m && j < e) dst[k++] = less(src[j], src[i]) ? src[j++] : src[i++];
                while (i < m) dst[k++] = src[i++];
                while (j < e) dst[k++] = src[j++];
                work += e - s;
                if (work > 40000) {
                    work = 0;
                    yield (ps + s / n) / Math.max(1, passes);
                }
            }
            const t = src;
            src = dst;
            dst = t;
        }
        if (src !== a) a.set(src);
        return a;
    }

    // LSD radix sort of source rows by (cat, hi, lo) keys indexed by row; stable, so ties keep ascending row order.
    function* radixRows(rows, cat, hi, lo) {
        const n = rows.length,
            B = 1 << 16;
        const passes = [
            { arr: lo, sh: 0, h: new Uint32Array(B) },
            { arr: lo, sh: 16, h: new Uint32Array(B) },
            { arr: hi, sh: 0, h: new Uint32Array(B) },
            { arr: hi, sh: 16, h: new Uint32Array(B) },
            { arr: cat, sh: 0, h: new Uint32Array(256) }
        ];
        const h0 = passes[0].h,
            h1 = passes[1].h,
            h2 = passes[2].h,
            h3 = passes[3].h,
            h4 = passes[4].h;
        for (let i = 0; i < n; i++) {
            const r = rows[i],
                l = lo[r],
                g = hi[r];
            h0[l & 0xffff]++;
            h1[l >>> 16]++;
            h2[g & 0xffff]++;
            h3[g >>> 16]++;
            h4[cat[r]]++;
            if ((i & 0x3ffff) === 0x3ffff) yield 0;
        }
        let src = rows.slice(),
            dst = new Int32Array(n);
        let done = 0;
        for (const ps of passes) {
            const h = ps.h;
            let trivial = false,
                sum = 0;
            for (let k = 0; k < h.length; k++) {
                if (h[k] === n) trivial = true;
                const c = h[k];
                h[k] = sum;
                sum += c;
            }
            if (trivial) {
                done++;
                continue;
            }
            const arr = ps.arr,
                sh = ps.sh,
                mask = h.length - 1;
            for (let i = 0; i < n; i++) {
                const r = src[i];
                dst[h[(arr[r] >>> sh) & mask]++] = r;
                if ((i & 0x1ffff) === 0x1ffff) yield (done + i / n) / 5;
            }
            const t = src;
            src = dst;
            dst = t;
            done++;
            yield done / 5;
        }
        return src;
    }

    const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
    const f64 = new Float64Array(1),
        u32 = new Uint32Array(f64.buffer),
        LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

    function matchText(spec) {
        const q = spec.q.toLowerCase();
        switch (spec.op) {
            case 'equals':
                return s => s.toLowerCase() === q;
            case 'starts':
                return s => s.toLowerCase().startsWith(q);
            case 'ends':
                return s => s.toLowerCase().endsWith(q);
            case 'notcontains':
                return s => s.toLowerCase().indexOf(q) < 0;
            default:
                return s => s.toLowerCase().indexOf(q) >= 0;
        }
    }

    function h(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function icon(path) {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        s.setAttribute('viewBox', '0 0 16 16');
        s.setAttribute('width', '14');
        s.setAttribute('height', '14');
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', path);
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke', 'currentColor');
        p.setAttribute('stroke-width', '1.5');
        p.setAttribute('stroke-linecap', 'round');
        p.setAttribute('stroke-linejoin', 'round');
        s.appendChild(p);
        return s;
    }

    const fmtNum = n => (OX.formatGeneral ? OX.formatGeneral(Math.round(n * 1e9) / 1e9) : String(n));

    class Shell {
        // opts: { readOnly, tabs, onEdit(edits, source), headerRows(), onViewState(state), onLink(e) }
        constructor(app, opts) {
            this.app = app;
            this.o = opts || {};
            this.provider = null;
            this.view = { sort: null, filters: new Map() };
            this.loading = false;
            this._tasks = {};
            this._colCache = new Map();
            this._statKey = null;
            this._build();
            this.grid = new OX.Grid(this.gridHost, { provider: null, readOnly: !!this.o.readOnly });
            this._wire();
        }

        _build() {
            const a = this.app;
            a.classList.add('ox-app');
            this.bar = h('div', 'ox-bar');
            this.nameBox = h('input', 'ox-name');
            this.nameBox.spellcheck = false;
            this.nameBox.setAttribute('aria-label', 'Name box');
            this.fx = h('span', 'ox-fx', 'fx');
            this.formula = h('textarea', 'ox-formula');
            this.formula.rows = 1;
            this.formula.wrap = 'off';
            this.formula.spellcheck = false;
            this.formula.setAttribute('aria-label', 'Formula bar');
            this.fxExpand = h('button', 'ox-btn ox-fxexp', '\u22EF');
            this.fxExpand.title = 'Multi-line value: click to expand';
            this.fxExpand.style.display = 'none';
            this.fxBox = h('div', 'ox-fxbox');
            this.fxBox.append(this.formula, this.fxExpand);
            this.btnFind = h('button', 'ox-btn');
            this.btnFind.title = 'Find (Ctrl+F)';
            this.btnFind.appendChild(icon('M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM11 11l3.5 3.5'));
            this.btnClear = h('button', 'ox-btn ox-clear', 'Clear sort & filter');
            this.btnClear.style.display = 'none';
            this.bar.append(this.nameBox, this.fx, this.fxBox, this.btnClear, this.btnFind);

            this.gridWrap = h('div', 'ox-grid');
            this.gridHost = h('div');
            this.gridWrap.appendChild(this.gridHost);
            this.findBar = this._buildFind();
            this.gridWrap.appendChild(this.findBar.el);

            this.tabs = h('div', 'ox-tabs');
            if (!this.o.tabs) this.tabs.style.display = 'none';
            this.status = h('div', 'ox-status');
            this.msg = h('span', 'ox-msg', 'Ready');
            this.stats = h('span', 'ox-stats');
            this.zoomBox = h('span', 'ox-zoom');
            this.zOut = h('button', 'ox-btn ox-z', '-');
            this.zVal = h('span', 'ox-zval', '100%');
            this.zIn = h('button', 'ox-btn ox-z', '+');
            this.zoomBox.append(this.zOut, this.zVal, this.zIn);
            this.status.append(this.msg, this.stats, this.zoomBox);
            a.append(this.bar, this.gridWrap, this.tabs, this.status);
        }

        _buildFind() {
            const el = h('div', 'ox-find');
            el.style.display = 'none';
            const input = h('input', 'ox-find-in');
            input.placeholder = 'Find';
            input.spellcheck = false;
            const count = h('span', 'ox-find-count');
            const prev = h('button', 'ox-btn');
            prev.title = 'Previous (Shift+Enter)';
            prev.appendChild(icon('M3 10l5-5 5 5'));
            const next = h('button', 'ox-btn');
            next.title = 'Next (Enter)';
            next.appendChild(icon('M3 6l5 5 5-5'));
            const mc = h('button', 'ox-btn ox-tog', 'Aa');
            mc.title = 'Match case';
            const wc = h('button', 'ox-btn ox-tog', '[ ]');
            wc.title = 'Match entire cell';
            const close = h('button', 'ox-btn');
            close.title = 'Close (Esc)';
            close.appendChild(icon('M4 4l8 8M12 4l-8 8'));
            el.append(input, count, prev, next, mc, wc, close);
            return { el, input, count, prev, next, mc, wc, close };
        }

        _wire() {
            const g = this.grid;
            g.on('select', e => this._onSelect(e));
            g.on('edit', e => {
                this._colCache.clear();
                this._statKey = null;
                if (this.o.onEdit) this.o.onEdit(e.edits, e.source);
            });
            g.on('resizeCol', e => {
                if (this.provider && this.provider.setColWidth) this.provider.setColWidth(e.c, e.width);
                this._viewState();
            });
            g.on('resizeRow', e => {
                if (this.provider && this.provider.setRowHeight) this.provider.setRowHeight(e.r, e.height);
            });
            g.on('scroll', () => this._viewState());
            g.on('zoom', z => {
                this.zVal.textContent = Math.round((z && z.zoom ? z.zoom : g.getZoom()) * 100) + '%';
                this._viewState();
            });
            g.on('findrequest', () => this.openFind());
            g.on('gotorequest', () => {
                this.nameBox.focus();
                this.nameBox.select();
            });
            g.on('find', r => this._findCount(r));
            g.on('copyTooLarge', e =>
                this.setMessage(
                    'Selection is too large to copy' + (e && e.cells ? ' (' + e.cells.toLocaleString() + ' cells)' : '')
                )
            );
            g.on('link', e => {
                if (this.o.onLink) this.o.onLink(e);
            });
            g.on('contextmenu', e => this._onContext(e));

            this.zOut.addEventListener('click', () => {
                g.setZoom(g.getZoom() / 1.15);
            });
            this.zIn.addEventListener('click', () => {
                g.setZoom(g.getZoom() * 1.15);
            });
            this.zVal.addEventListener('click', () => g.setZoom(1));
            this.btnFind.addEventListener('click', () => this.openFind());
            this.btnClear.addEventListener('click', () => this.clearView());

            this.nameBox.addEventListener('keydown', e => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (!this._goto(this.nameBox.value)) {
                        this.nameBox.classList.add('bad');
                        setTimeout(() => this.nameBox.classList.remove('bad'), 400);
                    } else g.focus();
                } else if (e.key === 'Escape') {
                    this._updateName();
                    g.focus();
                }
            });
            this.formula.addEventListener('keydown', e => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (e.altKey || e.shiftKey) this._fxNewline();
                    else this._commitFormula();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    this._updateFormula();
                    g.focus();
                }
            });
            this.formula.addEventListener('focus', () => {
                if (this._fxMulti()) this.fxBox.classList.add('open');
            });
            this.fxExpand.addEventListener('click', () => {
                this.fxBox.classList.toggle('open');
                this.formula.focus();
            });

            const f = this.findBar;
            f.input.addEventListener('input', () => {
                clearTimeout(this._findT);
                this._findT = setTimeout(() => {
                    this._findT = 0;
                    this._doFind(true);
                }, 160);
            });
            f.input.addEventListener('keydown', e => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (this._findT) {
                        clearTimeout(this._findT);
                        this._findT = 0;
                        this._doFind(true);
                        return;
                    }
                    const r = e.shiftKey ? g.findPrev() : g.findNext();
                    this._findCount(r);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    this.closeFind();
                }
            });
            f.next.addEventListener('click', () => this._findCount(g.findNext()));
            f.prev.addEventListener('click', () => this._findCount(g.findPrev()));
            f.close.addEventListener('click', () => this.closeFind());
            f.mc.addEventListener('click', () => {
                f.mc.classList.toggle('on');
                this._doFind(true);
            });
            f.wc.addEventListener('click', () => {
                f.wc.classList.toggle('on');
                this._doFind(true);
            });

            document.addEventListener('keydown', e => {
                const mod = e.metaKey || e.ctrlKey;
                if (mod && e.key.toLowerCase() === 'f' && !e.shiftKey) {
                    e.preventDefault();
                    this.openFind();
                }
            });
            const mo = new MutationObserver(() => {
                g.themeChanged();
                if (this.provider && this.provider.setDark) this.provider.setDark(this.isDark());
                g.refresh();
            });
            mo.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
            mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
        }

        isDark() {
            return !document.body.classList.contains('vscode-light');
        }

        setProvider(p) {
            this._cancelAll();
            this.provider = p;
            this._order = null;
            this._colCache.clear();
            this._statKey = null;
            this._closePopup();
            this.view = { sort: null, filters: new Map() };
            if (p && !p._shellColName) {
                const orig = p.colName ? p.colName.bind(p) : null;
                p._shellColName = true;
                p.colName = c => {
                    let base = orig ? orig(c) : OX.colName(c);
                    const v = this.view;
                    if (v.sort && v.sort.c === c) base += v.sort.dir > 0 ? ' ▲' : ' ▼';
                    if (v.filters.has(c)) base += ' ▾*';
                    return base;
                };
            }
            this.grid.setView(null);
            this.grid.setProvider(p);
            this._viewState();
            this._updateAll();
            this.btnClear.style.display = 'none';
        }

        setMessage(t) {
            this.msg.textContent = t;
        }

        // ---- background tasks ----
        _start(name, gen, o) {
            this._cancel(name);
            o = o || {};
            const slot = {};
            const finish = () => {
                if (slot.t && this._tasks[name] === slot.t) delete this._tasks[name];
            };
            const t = (slot.t = runTask(
                gen,
                Object.assign({}, o, {
                    onDone: v => {
                        finish();
                        if (o.onDone) o.onDone(v);
                    },
                    onError: e => {
                        finish();
                        if (o.onError) o.onError(e);
                        else if (root.console) console.error(e);
                    }
                })
            ));
            if (!t.done) this._tasks[name] = t;
            return t;
        }
        _cancel(name) {
            const t = this._tasks[name];
            if (t) {
                t.cancel();
                delete this._tasks[name];
            }
        }
        _cancelAll() {
            for (const k of Object.keys(this._tasks)) this._cancel(k);
            clearTimeout(this._statT);
            clearTimeout(this._findT);
            this._findT = 0;
        }
        busy() {
            return Object.keys(this._tasks).length > 0;
        }

        // ---- selection UI ----
        _onSelect(e) {
            this._updateName();
            this._updateFormula();
            this._scheduleStats(e && e.dragging);
            this._viewState();
        }
        _updateAll() {
            this._colCache.clear();
            this._statKey = null;
            this._updateName();
            this._updateFormula();
            this._scheduleStats(false);
        }

        _updateName() {
            const s = this.grid.getSelection();
            if (!s || !s.active) return;
            const rg = s.ranges[s.ranges.length - 1];
            const single = rg.r1 === rg.r2 && rg.c1 === rg.c2;
            if (single) this.nameBox.value = OX.cellRef(s.active.sr != null ? s.active.sr : s.active.r, s.active.c);
            else this.nameBox.value = rg.r2 - rg.r1 + 1 + 'R x ' + (rg.c2 - rg.c1 + 1) + 'C';
        }

        _updateFormula() {
            const s = this.grid.getSelection();
            if (!s || !s.active || !this.provider) {
                this.formula.value = '';
                return;
            }
            const sr = s.active.sr != null ? s.active.sr : s.active.r;
            this.formula.value = this.provider.getRaw(sr, s.active.c) || '';
            this._fxBase = this.formula.value;
            this.formula.readOnly = !!this.o.readOnly;
            const multi = this._fxMulti();
            this.fxExpand.style.display = multi ? '' : 'none';
            if (!multi) this.fxBox.classList.remove('open');
        }

        _fxMulti() {
            return this.formula.value.indexOf('\n') >= 0;
        }

        _fxNewline() {
            const f = this.formula;
            if (f.readOnly) return;
            const a = f.selectionStart,
                b = f.selectionEnd;
            f.value = f.value.slice(0, a) + '\n' + f.value.slice(b);
            f.selectionStart = f.selectionEnd = a + 1;
            this.fxExpand.style.display = '';
            this.fxBox.classList.add('open');
        }

        _closePopup() {
            if (this._popClose) this._popClose();
        }

        _commitFormula() {
            if (this.o.readOnly) return;
            const s = this.grid.getSelection();
            if (!s || !s.active) return;
            const sr = s.active.sr != null ? s.active.sr : s.active.r;
            // Untouched text is not re-committed (it would also round-trip multi-line cells through the input).
            if (this.formula.value !== this._fxBase && this.o.onEdit)
                this.o.onEdit([{ r: sr, c: s.active.c, text: this.formula.value }], 'formula');
            this.grid.refresh();
            this.grid.focus();
            this._updateFormula();
        }

        _goto(text) {
            const t = String(text).trim();
            if (!t) return false;
            const rg =
                OX.parseRange(t) ||
                (OX.parseRef(t) &&
                    (function (p) {
                        return { r1: p.r, c1: p.c, r2: p.r, c2: p.c };
                    })(OX.parseRef(t)));
            if (!rg) return false;
            this.grid.select(rg.r1, rg.c1, rg.r2, rg.c2);
            this.grid.scrollTo(rg.r1, rg.c1);
            return true;
        }

        _selCells(s) {
            let n = 0;
            for (const rg of s.ranges) n += (rg.r2 - rg.r1 + 1) * (rg.c2 - rg.c1 + 1);
            return n;
        }

        _scheduleStats(dragging) {
            clearTimeout(this._statT);
            const p = this.provider,
                s = this.grid.getSelection();
            if (!p || !s) {
                this._cancel('stats');
                this.stats.textContent = '';
                return;
            }
            const single =
                s.ranges.length === 1 && s.ranges[0].r1 === s.ranges[0].r2 && s.ranges[0].c1 === s.ranges[0].c2;
            if (single) {
                this._cancel('stats');
                this.stats.textContent = '';
                this._statKey = null;
                return;
            }
            if (dragging) return; // the grid sends a final select with dragging:false
            if (this._selCells(s) <= SMALL_STATS) {
                this._runStats(s);
                return;
            }
            this._statT = setTimeout(() => this._runStats(this.grid.getSelection()), 120);
        }

        _updateStats() {
            this._scheduleStats(false);
        }

        _statText(a, pct) {
            const parts = [];
            if (a.nums) parts.push('Average: ' + fmtNum(a.sum / a.nums));
            parts.push('Count: ' + a.cnt);
            if (a.nums) {
                parts.push('Sum: ' + fmtNum(a.sum));
                parts.push('Min: ' + fmtNum(a.min));
                parts.push('Max: ' + fmtNum(a.max));
            }
            return (
                parts.join('    ') + (pct == null ? '' : '    (partial, calculating ' + Math.round(pct * 100) + '%)')
            );
        }

        _runStats(s) {
            const p = this.provider;
            if (!p || !s) return;
            const key =
                s.ranges.map(g => g.r1 + ',' + g.c1 + ',' + g.r2 + ',' + g.c2).join(';') +
                '|' +
                (this._order ? this._order.length : -1) +
                '|' +
                p.rowCount;
            if (key === this._statKey && this._statText0 !== undefined && !this._tasks.stats) {
                this.stats.textContent = this._statText0;
                return;
            }
            const order = this._order,
                total = { cnt: 0, nums: 0, sum: 0, min: Infinity, max: -Infinity };
            const ranges = s.ranges.map(rg => ({
                r1: rg.r1,
                c1: rg.c1,
                r2: Math.min(rg.r2, (order ? order.length : p.rowCount) - 1),
                c2: Math.min(rg.c2, p.colCount - 1)
            }));
            const self = this;
            const cur = { acc: null };
            const live = () => {
                const t = { cnt: total.cnt, nums: total.nums, sum: total.sum, min: total.min, max: total.max };
                if (cur.acc) {
                    t.cnt += cur.acc.cnt;
                    t.nums += cur.acc.nums;
                    t.sum += cur.acc.sum;
                    if (cur.acc.min < t.min) t.min = cur.acc.min;
                    if (cur.acc.max > t.max) t.max = cur.acc.max;
                }
                return t;
            };
            function* gen() {
                for (let i = 0; i < ranges.length; i++) {
                    const rg = ranges[i];
                    if (rg.r2 < rg.r1 || rg.c2 < rg.c1) continue;
                    cur.acc = { cnt: 0, nums: 0, sum: 0, min: Infinity, max: -Infinity };
                    const it = p.rangeStats
                        ? p.rangeStats(cur.acc, order, rg.r1, rg.r2, rg.c1, rg.c2)
                        : self._genericStats(cur.acc, order, rg);
                    for (let r = it.next(); !r.done; r = it.next())
                        yield (i + (typeof r.value === 'number' ? r.value : 0)) / ranges.length;
                    total.cnt += cur.acc.cnt;
                    total.nums += cur.acc.nums;
                    total.sum += cur.acc.sum;
                    if (cur.acc.min < total.min) total.min = cur.acc.min;
                    if (cur.acc.max > total.max) total.max = cur.acc.max;
                    cur.acc = null;
                }
            }
            this._start('stats', gen(), {
                onProgress: pct => {
                    this.stats.textContent = this._statText(live(), pct);
                },
                onDone: () => {
                    this._statText0 = this._statText(total);
                    this._statKey = key;
                    this.stats.textContent = this._statText0;
                }
            });
        }

        // Provider-agnostic fallback (sliced): forEachCell per row slab, else getCell per cell.
        *_genericStats(a, order, rg) {
            const p = this.provider,
                nc = rg.c2 - rg.c1 + 1,
                nr = rg.r2 - rg.r1 + 1;
            if (!order && p.forEachCell) {
                const slab = Math.max(1, Math.floor(100000 / nc));
                const cb = cell => {
                    if (cell.t === 'z' || cell.v === null || cell.v === '') return;
                    a.cnt++;
                    if (cell.t === 'n') {
                        a.nums++;
                        a.sum += cell.v;
                        if (cell.v < a.min) a.min = cell.v;
                        if (cell.v > a.max) a.max = cell.v;
                    }
                };
                for (let r = rg.r1; r <= rg.r2; r += slab) {
                    p.forEachCell(r, rg.c1, Math.min(rg.r2, r + slab - 1), rg.c2, cb);
                    yield (r - rg.r1) / nr;
                }
                return a;
            }
            let work = 0;
            for (let r = rg.r1; r <= rg.r2; r++) {
                const sr = order ? order[r] : r;
                for (let c = rg.c1; c <= rg.c2; c++) {
                    const cv = p.getCell(sr, c);
                    if (!cv || cv.text === '') continue;
                    a.cnt++;
                    if (cv.kind === 'number') {
                        const n = Number(p.getRaw(sr, c));
                        if (n === n) {
                            a.nums++;
                            a.sum += n;
                            if (n < a.min) a.min = n;
                            if (n > a.max) a.max = n;
                        }
                    }
                }
                work += nc;
                if (work > 30000) {
                    work = 0;
                    yield (r - rg.r1) / nr;
                }
            }
            return a;
        }

        // ---- find ----
        openFind() {
            const f = this.findBar;
            f.el.style.display = 'flex';
            const s = this.grid.getSelection();
            if (s && s.active && this.provider && !f.input.value) {
                const raw = this.provider.getRaw(s.active.sr != null ? s.active.sr : s.active.r, s.active.c);
                if (raw && raw.indexOf('\n') < 0 && raw.length < 80) f.input.value = raw;
            }
            f.input.focus();
            f.input.select();
            this._doFind(false);
        }
        closeFind() {
            this.findBar.el.style.display = 'none';
            this.grid.clearFind();
            this.findBar.count.textContent = '';
            this.grid.focus();
        }
        _doFind(jump) {
            const f = this.findBar,
                q = f.input.value;
            if (!q) {
                this.grid.clearFind();
                f.count.textContent = '';
                return;
            }
            this._findCount(
                this.grid.find(q, {
                    matchCase: f.mc.classList.contains('on'),
                    wholeCell: f.wc.classList.contains('on')
                })
            );
        }
        _findCount(r) {
            if (!r) return;
            const more = r.done === false ? ' (searching...)' : r.truncated ? ' (limit reached)' : '';
            this.findBar.count.textContent = r.count
                ? r.index + ' of ' + r.count + more
                : r.done === false
                  ? 'Searching...'
                  : 'No results';
            this.findBar.count.classList.toggle('none', !r.count);
        }

        // ---- sort / filter (view only) ----
        _hdr() {
            return this.o.headerRows ? this.o.headerRows() : 0;
        }

        // Per-row ids into distinct values of column c (display text, or raw when raw=true); ids null if > MAX_DISTINCT values.
        *_columnIds(c, raw) {
            const p = this.provider,
                hdr = this._hdr();
            if (p.columnIds) return yield* p.columnIds(c, MAX_DISTINCT, raw);
            const key = c + (raw ? 'r' : 'd'),
                ver = p.dataVersion === undefined ? -1 : p.dataVersion;
            const hit = this._colCache.get(key);
            if (hit && hit.ver === ver) return hit.res;
            const total = p.rowCount,
                ids = new Int32Array(total).fill(-1),
                map = new Map(),
                values = [],
                cnt = [];
            let work = 0,
                truncated = false;
            for (let r = hdr; r < total; r++) {
                let t;
                if (raw) t = p.getRaw(r, c) || '';
                else {
                    const cv = p.getCell(r, c);
                    t = cv && cv.text != null ? cv.text : '';
                }
                let k = map.get(t);
                if (k === undefined) {
                    if (values.length >= MAX_DISTINCT) {
                        truncated = true;
                        break;
                    }
                    k = values.length;
                    values.push(t);
                    cnt.push(0);
                    map.set(t, k);
                }
                ids[r] = k;
                cnt[k]++;
                if (++work > 20000) {
                    work = 0;
                    yield r / total;
                }
            }
            const res = truncated
                ? { ids: null, values: null, counts: null, truncated: true }
                : { ids, values, counts: Int32Array.from(cnt), truncated: false };
            this._colCache.set(key, { ver, res });
            if (this._colCache.size > 6) this._colCache.delete(this._colCache.keys().next().value);
            return res;
        }

        // Row subset (Int32Array of source rows) passing one column filter; `rows` null = all body rows.
        *_applyFilter(rows, c, spec) {
            const p = this.provider,
                hdr = this._hdr(),
                total = p.rowCount;
            const isText = spec.kind === 'text';
            const col = yield* this._columnIds(c, isText);
            const n = rows ? rows.length : Math.max(0, total - hdr);
            const out = new Int32Array(n);
            let m = 0;
            if (col.ids) {
                const test = isText ? matchText(spec) : null,
                    allowed = new Uint8Array(col.values.length);
                for (let i = 0; i < allowed.length; i++)
                    allowed[i] = isText ? (test(col.values[i]) ? 1 : 0) : spec.set.has(col.values[i]) ? 1 : 0;
                const ids = col.ids;
                for (let i = 0; i < n; i++) {
                    const r = rows ? rows[i] : hdr + i;
                    if (allowed[ids[r]] === 1) out[m++] = r;
                    if ((i & 0x3ffff) === 0x3ffff) yield i / n;
                }
            } else {
                const test = isText ? matchText(spec) : null;
                for (let i = 0; i < n; i++) {
                    const r = rows ? rows[i] : hdr + i;
                    let ok;
                    if (isText) ok = test(p.getRaw(r, c) || '');
                    else {
                        const cv = p.getCell(r, c);
                        ok = spec.set.has(cv && cv.text != null ? cv.text : '');
                    }
                    if (ok) out[m++] = r;
                    if ((i & 0x7fff) === 0x7fff) yield i / n;
                }
            }
            return out.slice(0, m);
        }

        // Generic sort keys (same shape as CsvProvider.sortKeyColumn).
        *_sortKeys(c) {
            const p = this.provider;
            if (p.sortKeyColumn) return yield* p.sortKeyColumn(c);
            const R = p.rowCount,
                cat = new Uint8Array(R).fill(2),
                hi = new Uint32Array(R),
                lo = new Uint32Array(R),
                strs = [];
            const hiI = LE ? 1 : 0,
                loI = LE ? 0 : 1;
            let work = 0;
            for (let r = 0; r < R; r++) {
                const raw = p.getRaw(r, c);
                if (raw) {
                    const f = raw.charCodeAt(0);
                    if (
                        ((f >= 48 && f <= 57) || f === 45 || f === 43 || f === 46) &&
                        raw.length < 64 &&
                        NUM_RE.test(raw)
                    ) {
                        const x = Number(raw);
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
                    } else {
                        cat[r] = 1;
                        lo[r] = strs.length;
                        strs.push(raw.toLowerCase());
                    }
                }
                if (++work > 20000) {
                    work = 0;
                    yield (0.6 * r) / R;
                }
            }
            return { cat, hi, lo, strs };
        }

        *_sortRows(rows, c, dir) {
            const keys = yield* this._sortKeys(c),
                cat = keys.cat,
                hi = keys.hi,
                lo = keys.lo,
                strs = keys.strs;
            if (strs.length) {
                const idx = new Int32Array(strs.length);
                for (let i = 0; i < idx.length; i++) idx[i] = i;
                yield* mergeSortGen(idx, (a, b) => strs[a] < strs[b]);
                const rank = new Int32Array(idx.length);
                let rk = 0;
                for (let i = 0; i < idx.length; i++) {
                    if (i && strs[idx[i]] !== strs[idx[i - 1]]) rk = i;
                    rank[idx[i]] = rk;
                }
                for (let i = 0; i < rows.length; i++) {
                    const r = rows[i];
                    if (cat[r] === 1) lo[r] = rank[lo[r]];
                    if ((i & 0x3ffff) === 0x3ffff) yield 0.7;
                }
            }
            if (dir < 0) {
                for (let i = 0; i < rows.length; i++) {
                    const r = rows[i];
                    if (cat[r] !== 2) {
                        hi[r] = ~hi[r];
                        lo[r] = ~lo[r];
                    }
                    if ((i & 0x3ffff) === 0x3ffff) yield 0.75;
                }
            }
            return yield* radixRows(rows, cat, hi, lo);
        }

        *_viewGen() {
            const p = this.provider,
                v = this.view,
                hdr = this._hdr(),
                total = p.rowCount;
            let rows = null;
            const filt = [...v.filters.entries()],
                steps = filt.length + (v.sort ? 1 : 0);
            let stepNo = 0;
            for (const [c, spec] of filt) {
                const it = this._applyFilter(rows, c, spec);
                for (let r = it.next(); ; r = it.next()) {
                    if (r.done) {
                        rows = r.value;
                        break;
                    }
                    yield (stepNo + (r.value || 0)) / steps;
                }
                stepNo++;
            }
            if (!rows) {
                rows = new Int32Array(Math.max(0, total - hdr));
                for (let i = 0; i < rows.length; i++) rows[i] = hdr + i;
            }
            if (v.sort) {
                const it = this._sortRows(rows, v.sort.c, v.sort.dir);
                for (let r = it.next(); ; r = it.next()) {
                    if (r.done) {
                        rows = r.value;
                        break;
                    }
                    yield (stepNo + (r.value || 0)) / steps;
                }
            }
            const out = new Int32Array(Math.min(hdr, total) + rows.length);
            for (let i = 0; i < hdr && i < total; i++) out[i] = i;
            out.set(rows, Math.min(hdr, total));
            return out;
        }

        recomputeView() {
            const p = this.provider;
            if (!p) return;
            this._cancel('view');
            const v = this.view;
            if (!v.sort && !v.filters.size) {
                this._order = null;
                this.grid.setView(null);
                this.btnClear.style.display = 'none';
                this._updateAll();
                this._status();
                return;
            }
            const label =
                v.sort && !v.filters.size
                    ? 'Sorting'
                    : v.filters.size && !v.sort
                      ? 'Filtering'
                      : 'Sorting and filtering';
            this.btnClear.style.display = '';
            this.setMessage(label + '...');
            this._start('view', this._viewGen(), {
                budget: 10,
                onProgress: pct => this.setMessage(label + ' ' + Math.round(pct * 100) + '%...'),
                onDone: order => {
                    this._order = order;
                    this.grid.setView({ order });
                    this._status();
                    this._updateAll();
                },
                onError: e => {
                    this.setMessage('Sort/filter failed: ' + (e && e.message));
                    if (root.console) console.error(e);
                }
            });
        }

        _status() {
            const v = this.view,
                parts = [],
                hdr = this._hdr();
            if (v.sort)
                parts.push('Sorted by ' + OX.colName(v.sort.c) + (v.sort.dir > 0 ? ' ascending' : ' descending'));
            if (v.filters.size)
                parts.push(
                    'Filtered: ' +
                        (this._order ? Math.max(0, this._order.length - hdr) : 0) +
                        ' of ' +
                        Math.max(0, this.provider.rowCount - hdr) +
                        ' rows'
                );
            this.setMessage(parts.length ? parts.join('  |  ') + '  (view only, file unchanged)' : 'Ready');
        }

        sortBy(c, dir) {
            if (this._guardLoading()) return;
            this.view.sort = { c, dir };
            this.recomputeView();
        }
        clearView() {
            this.view = { sort: null, filters: new Map() };
            this.recomputeView();
        }

        _guardLoading() {
            if (!this.loading && !(this.provider && this.provider.partial)) return false;
            this.setMessage('Still loading: sort and filter are available when the file is fully loaded');
            return true;
        }

        filterColumn(c, x, y) {
            if (this._guardLoading()) return;
            const cur = this.view.filters.get(c);
            this._closePopup();
            const pop = h('div', 'ox-pop');
            pop.append(h('div', 'ox-pop-title', 'Filter column ' + OX.colName(c)));
            const mode = h('select', 'ox-pop-mode');
            [
                ['values', 'Choose values'],
                ['contains', 'Text contains'],
                ['equals', 'Text equals'],
                ['starts', 'Text starts with'],
                ['ends', 'Text ends with'],
                ['notcontains', 'Text does not contain']
            ].forEach(m => {
                const o = h('option', null, m[1]);
                o.value = m[0];
                mode.appendChild(o);
            });
            const search = h('input', 'ox-pop-search');
            search.spellcheck = false;
            const info = h('div', 'ox-pop-info', 'Scanning column...');
            const listBox = h('div', 'ox-pop-list'),
                spacer = h('div', 'ox-pop-spacer'),
                win = h('div', 'ox-pop-win');
            const all = h('label', 'ox-pop-row ox-pop-all');
            const allCb = h('input');
            allCb.type = 'checkbox';
            all.append(allCb, h('span', null, '(Select all)'));
            listBox.append(spacer);
            spacer.appendChild(win);
            const btns = h('div', 'ox-pop-btns');
            const ok = h('button', 'ox-btn ox-primary', 'Apply');
            const no = h('button', 'ox-btn', 'Cancel');
            btns.append(no, ok);
            pop.append(mode, search, info, all, listBox, btns);

            const ROW = 22,
                VIS = 12;
            let col = null,
                order = null,
                fl = null,
                sel = null;
            const curText = cur && cur.kind === 'text' ? cur : null;
            mode.value = curText ? curText.op : 'values';
            search.value = curText ? curText.q : '';
            const isValues = () => mode.value === 'values';
            const render = () => {
                if (!col || !col.ids) return;
                const top = Math.floor(listBox.scrollTop / ROW),
                    n = fl.length;
                win.style.transform = 'translateY(' + top * ROW + 'px)';
                win.textContent = '';
                for (let i = top; i < Math.min(n, top + VIS + 2); i++) {
                    const vi = fl[i],
                        l = h('label', 'ox-pop-row');
                    const cb = h('input');
                    cb.type = 'checkbox';
                    cb.checked = sel[vi] === 1;
                    cb.addEventListener('change', () => {
                        sel[vi] = cb.checked ? 1 : 0;
                        syncAll();
                    });
                    const v = col.values[vi];
                    l.append(cb, h('span', null, v === '' ? '(Blanks)' : v), h('em', null, String(col.counts[vi])));
                    win.appendChild(l);
                }
            };
            const syncAll = () => {
                if (!fl) return;
                let every = fl.length > 0;
                for (let i = 0; i < fl.length; i++)
                    if (sel[fl[i]] !== 1) {
                        every = false;
                        break;
                    }
                allCb.checked = every;
            };
            const refilter = () => {
                const q = search.value.toLowerCase();
                const keep = [];
                for (let i = 0; i < order.length; i++) {
                    const vi = order[i];
                    if (!q || col.values[vi].toLowerCase().indexOf(q) >= 0) keep.push(vi);
                }
                fl = Int32Array.from(keep);
                spacer.style.height = fl.length * ROW + 'px';
                listBox.scrollTop = 0;
                info.textContent = fl.length.toLocaleString() + ' of ' + col.values.length.toLocaleString() + ' values';
                syncAll();
                render();
            };
            const layout = () => {
                const vals = isValues() && col && col.ids;
                listBox.style.display = all.style.display = vals ? '' : 'none';
                search.placeholder = isValues() ? 'Search' : 'Text';
                if (col && !col.ids) mode.options[0].disabled = true;
                if (!isValues())
                    info.textContent =
                        col && !col.ids
                            ? 'More than ' + MAX_DISTINCT.toLocaleString() + ' distinct values: filter by text'
                            : 'Rows whose value matches the text (case-insensitive)';
                else if (col && col.ids)
                    info.textContent =
                        (fl ? fl.length : 0).toLocaleString() + ' of ' + col.values.length.toLocaleString() + ' values';
                if (vals) refilter();
            };
            listBox.addEventListener('scroll', render);
            allCb.addEventListener('change', () => {
                for (let i = 0; i < fl.length; i++) sel[fl[i]] = allCb.checked ? 1 : 0;
                render();
            });
            mode.addEventListener('change', () => {
                layout();
                search.focus();
            });
            search.addEventListener('input', () => {
                if (isValues() && col && col.ids) refilter();
            });
            const close = () => {
                this._cancel('filterScan');
                pop.remove();
                document.removeEventListener('mousedown', off, true);
                if (this._popClose === close) this._popClose = null;
                this.grid.focus();
            };
            this._popClose = close;
            const off = e => {
                if (!pop.contains(e.target)) close();
            };
            no.addEventListener('click', close);
            ok.addEventListener('click', () => {
                if (!isValues()) {
                    const q = search.value;
                    if (q === '') this.view.filters.delete(c);
                    else this.view.filters.set(c, { kind: 'text', op: mode.value, q });
                } else if (col && col.ids) {
                    let count = 0;
                    for (let i = 0; i < sel.length; i++) count += sel[i];
                    if (count === sel.length) this.view.filters.delete(c);
                    else {
                        const set = new Set();
                        for (let i = 0; i < sel.length; i++) if (sel[i]) set.add(col.values[i]);
                        this.view.filters.set(c, { kind: 'set', set });
                    }
                } else return;
                close();
                this.recomputeView();
            });
            pop.addEventListener('keydown', e => {
                if (e.key === 'Escape') close();
                else if (e.key === 'Enter' && (e.target === search || e.target === mode || e.target === pop)) {
                    e.preventDefault();
                    ok.click();
                }
            });
            document.body.appendChild(pop);
            pop.style.left = Math.max(4, Math.min(x, innerWidth - pop.offsetWidth - 8)) + 'px';
            pop.style.top = Math.max(4, Math.min(y, innerHeight - pop.offsetHeight - 8)) + 'px';
            document.addEventListener('mousedown', off, true);
            layout();
            search.focus();
            const self = this;
            function* scan() {
                const it = self._columnIds(c, false);
                let res;
                for (let r = it.next(); ; r = it.next()) {
                    if (r.done) {
                        res = r.value;
                        break;
                    }
                    yield r.value;
                }
                if (res.ids) {
                    const nums = [],
                        strs = [];
                    for (let i = 0; i < res.values.length; i++) {
                        const t = res.values[i];
                        (t !== '' && NUM_RE.test(t) ? nums : strs).push(i);
                    }
                    const vals = res.values,
                        coll = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { numeric: true }) : null;
                    const ni = Int32Array.from(nums),
                        si = Int32Array.from(strs);
                    yield* mergeSortGen(ni, (a, b) => Number(vals[a]) < Number(vals[b]));
                    yield* mergeSortGen(
                        si,
                        coll ? (a, b) => coll.compare(vals[a], vals[b]) < 0 : (a, b) => vals[a] < vals[b]
                    );
                    const ord = new Int32Array(vals.length);
                    let k = 0;
                    const blank = si.length && vals[si[0]] === '' ? 1 : 0;
                    if (blank) ord[k++] = si[0];
                    for (let i = 0; i < ni.length; i++) ord[k++] = ni[i];
                    for (let i = blank; i < si.length; i++) ord[k++] = si[i];
                    res = Object.assign({}, res, { order: ord });
                }
                return res;
            }
            this._start('filterScan', scan(), {
                budget: 8,
                onProgress: pct => {
                    info.textContent = 'Scanning column ' + Math.round(pct * 100) + '%...';
                },
                onDone: res => {
                    col = res;
                    if (col.ids) {
                        order = col.order;
                        sel = new Uint8Array(col.values.length);
                        const set = cur && cur.kind === 'set' ? cur.set : null;
                        for (let i = 0; i < sel.length; i++) sel[i] = set ? (set.has(col.values[i]) ? 1 : 0) : 1;
                    } else if (isValues()) mode.value = 'contains';
                    layout();
                }
            });
        }

        _onContext(e) {
            if (e.zone !== 'colhdr' || !this.provider) return;
            e.handled = true;
            const c = e.c,
                v = this.view;
            const items = [
                ['Sort A to Z', '', () => this.sortBy(c, 1)],
                ['Sort Z to A', '', () => this.sortBy(c, -1)],
                ['Filter...', '', () => this.filterColumn(c, e.clientX, e.clientY)],
                ['Clear sort & filter', '', () => this.clearView(), !(v.sort || v.filters.size)],
                null,
                ['Autosize column', '', () => this.grid.autosizeColumn(c)]
            ];
            this.grid._showMenu(items, e.clientX, e.clientY);
        }

        // ---- persisted view state ----
        getViewState() {
            const sel = this.grid.getSelection();
            return {
                zoom: this.grid.getZoom(),
                scroll: this.grid.getScroll(),
                active:
                    sel && sel.active
                        ? { r: sel.active.sr != null ? sel.active.sr : sel.active.r, c: sel.active.c }
                        : null
            };
        }
        applyViewState(s) {
            if (!s) return;
            if (s.zoom) this.grid.setZoom(s.zoom);
            if (s.active) this.grid.select(s.active.r, s.active.c);
            if (s.scroll) this.grid.setScroll(s.scroll);
        }
        _viewState() {
            if (!this.o.onViewState) return;
            clearTimeout(this._vt);
            this._vt = setTimeout(() => this.o.onViewState(this.getViewState()), 300);
        }
    }

    OX.runTask = runTask;
    OX.mergeSortGen = mergeSortGen;
    OX.radixRows = radixRows;
    OX.Shell = Shell;
    if (typeof module !== 'undefined' && module.exports) module.exports = OX;
})(typeof globalThis !== 'undefined' ? globalThis : this);
