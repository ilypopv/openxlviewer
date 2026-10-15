(function (root) {
  'use strict';
  const OX = root.OX || (root.OX = {});
  const C = OX.GridCore || (typeof require !== 'undefined' ? require('./grid-core.js').GridCore : null);
  const { Axis, MergeIndex, WidthCache, clamp } = C;

  const MIN_ZOOM = 0.5, MAX_ZOOM = 3, PAD_ROWS = 100, PAD_COLS = 26;
  const HDR_H = 22;
  const rafOf = f => (root.requestAnimationFrame ? root.requestAnimationFrame(f) : setTimeout(f, 16));
  const cancelAnimationFrameOf = id => (root.cancelAnimationFrame ? root.cancelAnimationFrame(id) : clearTimeout(id));

  // ---- color utils ----
  function parseColor(s) {
    if (!s) return null;
    s = s.trim();
    let m;
    if ((m = /^#([0-9a-f]{3})$/i.exec(s))) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16), 1];
    if ((m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s))) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), m[2] ? parseInt(m[2], 16) / 255 : 1];
    if ((m = /^rgba?\(([^)]+)\)/i.exec(s))) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(parseFloat); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
    return null;
  }
  const lumOf = c => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  const rgba = (c, a) => 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')';
  const mix = (a, b, t) => 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * t) + ',' + Math.round(a[1] + (b[1] - a[1]) * t) + ',' + Math.round(a[2] + (b[2] - a[2]) * t) + ')';

  class Grid {
    constructor(el, opts) {
      opts = opts || {};
      this.el = el; this.readOnly = !!opts.readOnly;
      this.provider = opts.provider || { rowCount: 0, colCount: 0, getCell() {}, getRaw() { return ''; }, colWidth: () => 64, rowHeight: () => 20, isColHidden: () => false, isRowHidden: () => false, merges: [], frozenRows: 0, frozenCols: 0, showGridLines: true };
      this.zoom = 1; this.sx = 0; this.sy = 0; this.ratioX = 1; this.ratioY = 1;
      this.extraRows = PAD_ROWS; this.extraCols = PAD_COLS;
      this.rowAxis = new Axis(); this.colAxis = new Axis();
      this._order = null; this.rowOv = new Map(); this.colOv = new Map();
      this.ranges = [{ r1: 0, c1: 0, r2: 0, c2: 0 }]; this.active = { r: 0, c: 0 }; this.anchor = { r: 0, c: 0 }; this.focusCell = { r: 0, c: 0 };
      this.listeners = {}; this.stats = { paintMs: 0, cells: 0, frames: 0, avgMs: 0 };
      this.widths = new WidthCache(30000, 2e6, 400); this.wrapCache = new Map(); this._wrapChars = 0;
      this.maxCopyChars = 64e6; this.findBudgetMs = 8;
      this.styleCache = new WeakMap(); this.epoch = 1;
      this._bdw = new WeakMap(); this._bdi = new Map(); this._bact = [];
      this.find_ = null; this.edit_ = null; this.drag = null; this.guide = null; this.fillPreview = null;
      this._dead = false; this._raf = 0; this._clip = null; this._tm = {};
      this._buildDom();
      this._readTheme();
      this._layout();
      this._bind();
      this._resize();
    }

    on(n, f) { (this.listeners[n] || (this.listeners[n] = [])).push(f); return this; }
    off(n, f) { const l = this.listeners[n]; if (l) { const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); } return this; }
    emit(n, d) { const l = this.listeners[n]; if (l) for (const f of l.slice()) { try { f(d); } catch (e) { if (root.console) console.error(e); } } }

    _buildDom() {
      const el = this.el, d = el.ownerDocument;
      el.classList.add('oxg'); if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
      el.setAttribute('role', 'grid');
      this.canvas = d.createElement('canvas'); this.canvas.className = 'oxg-canvas';
      this.scroller = d.createElement('div'); this.scroller.className = 'oxg-scroller';
      this.spacer = d.createElement('div'); this.spacer.className = 'oxg-spacer';
      this.scroller.appendChild(this.spacer);
      this.live = d.createElement('div'); this.live.className = 'oxg-live'; this.live.setAttribute('role', 'status'); this.live.setAttribute('aria-live', 'polite');
      el.appendChild(this.canvas); el.appendChild(this.scroller); el.appendChild(this.live);
      this.ctx = this.canvas.getContext('2d', { alpha: false });
      this.dpr = root.devicePixelRatio || 1;
    }

    _readTheme() {
      const cs = root.getComputedStyle ? getComputedStyle(this.el) : null;
      const v = n => (cs ? cs.getPropertyValue(n).trim() : '');
      const bgS = v('--vscode-editor-background') || '#1e1e1e';
      const bg = parseColor(bgS) || [30, 30, 30, 1];
      const dark = lumOf(bg) < 0.5;
      const fg = parseColor(v('--vscode-editor-foreground')) || (dark ? [212, 212, 212, 1] : [51, 51, 51, 1]);
      const accent = parseColor(v('--vscode-focusBorder')) || (dark ? [76, 154, 255, 1] : [26, 115, 232, 1]);
      const side = parseColor(v('--vscode-sideBar-background')) || parseColor(v('--vscode-titleBar-activeBackground'));
      const hdrBase = side && Math.abs(lumOf(side) - lumOf(bg)) < 0.2 ? side : null;
      const T = this.theme = {
        dark, bg: mix(bg, bg, 0), fgC: fg, bgC: bg, fg: mix(fg, fg, 0), accent: mix(accent, accent, 0), accentC: accent,
        hdrBg: hdrBase ? mix(hdrBase, hdrBase, 0) : mix(bg, dark ? [255, 255, 255] : [0, 0, 0], dark ? 0.06 : 0.04),
        hdrFg: mix(fg, bg, 0.25), hdrFgSel: mix(fg, fg, 0),
        hdrLine: mix(bg, dark ? [255, 255, 255] : [0, 0, 0], dark ? 0.16 : 0.15),
        grid: mix(bg, dark ? [255, 255, 255] : [0, 0, 0], dark ? 0.11 : 0.12),
        selFill: rgba(accent, dark ? 0.2 : 0.14), hdrSel: rgba(accent, dark ? 0.28 : 0.2), hdrSelFull: rgba(accent, dark ? 0.5 : 0.38),
        match: dark ? 'rgba(234,180,40,0.35)' : 'rgba(255,214,0,0.45)', matchCur: dark ? 'rgba(255,140,0,0.65)' : 'rgba(255,140,0,0.6)',
        link: dark ? '#6cb0ff' : '#0563c1', divider: mix(bg, dark ? [255, 255, 255] : [0, 0, 0], dark ? 0.4 : 0.45),
        family: v('--vscode-font-family') || 'system-ui, -apple-system, "Segoe UI", sans-serif',
        editorFamily: v('--vscode-editor-font-family') || ''
      };
      T.cellFamily = T.family;
      this.epoch++;
    }
    themeChanged() { this._readTheme(); this._schedule(); }

    // ---- style cache ----
    _style(st) {
      let e = this.styleCache.get(st);
      if (e && e.epoch === this.epoch) return e;
      const z = this.zoom, T = this.theme;
      const px = Math.max(6, (st.size || 11) * 4 / 3 * z);
      const fam = st.font ? '"' + st.font.replace(/"/g, '') + '",' + T.cellFamily : T.cellFamily;
      let color = null;
      const bgc = st.bg ? parseColor(st.bg) : null;
      if (st.color) {
        const cc = parseColor(st.color);
        color = st.color;
        if (cc && !bgc) { if (Math.abs(lumOf(cc) - lumOf(T.bgC)) < 0.3) color = T.fg; }
      } else if (bgc) color = lumOf(bgc) > 0.55 ? '#1f1f1f' : '#f5f5f5';
      e = {
        epoch: this.epoch, px, font: (st.i ? 'italic ' : '') + (st.b ? 'bold ' : '') + px.toFixed(2) + 'px ' + fam,
        color: color || T.fg, bg: st.bg || null, hasBorder: !!(st.bl || st.br || st.bt || st.bb), lh: Math.round(px * 1.25)
      };
      this.styleCache.set(st, e);
      return e;
    }
    _defStyle() {
      if (!this._ds || this._ds.epoch !== this.epoch) {
        const px = 13 * this.zoom;
        this._ds = { epoch: this.epoch, px, font: px.toFixed(2) + 'px ' + this.theme.cellFamily, color: this.theme.fg, bg: null, hasBorder: false, lh: Math.round(px * 1.25) };
      }
      return this._ds;
    }
    _measure(font, text) {
      if (this._font !== font) { this._font = font; this.ctx.font = font; }
      return this.widths.get(font, text, this._mfn || (this._mfn = t => this.ctx.measureText(t).width));
    }

    // ---- provider / layout ----
    setProvider(p) {
      this.provider = p; this._order = null; this.rowOv.clear(); this.colOv.clear();
      this.extraRows = PAD_ROWS; this.extraCols = PAD_COLS;
      this.ranges = [{ r1: 0, c1: 0, r2: 0, c2: 0 }]; this.active = { r: 0, c: 0 }; this.anchor = { r: 0, c: 0 }; this.focusCell = { r: 0, c: 0 };
      this._cancelEdit(); this.clearFind(); this.sx = this.sy = 0;
      this.invalidate(); this.scroller.scrollTop = 0; this.scroller.scrollLeft = 0;
      this.ranges = [this.mi.expand(0, 0, 0, 0)]; this._snapActive(); this._selKey = null;
      this.emit('select', this.getSelection());
    }
    setView(v) { this._order = v && v.order ? v.order : null; this.rowOv.clear(); this._cancelEdit(); this.invalidate(); this._clampSel(); }
    refresh() { this._schedule(); if (this.find_) this._findDirty(); }
    // opts.keepSizes: row/col sizes, hidden and merges unchanged (e.g. after a cell edit): skip the O(rows) axis rebuild
    invalidate(opts) {
      const keep = !!(opts && opts.keepSizes);
      if (!keep) { this.rowOv.clear(); this.colOv.clear(); }
      this._layout(opts); this._applySize(); this._clampSel(); this._schedule();
      if (this.find_) this._findDirty();
    }
    // provider.rowLayout()/colLayout() -> {sizes?: Map<idx,px>, hidden?: Set<idx>} (every non-default item) avoids scanning all rows
    _buildAxis(axis, n, count, ov, sizeFn, hiddenFn, def, layoutFn) {
      const z = this.zoom;
      const lay = layoutFn && !(axis === this.rowAxis && this._order) ? layoutFn() : null;
      if (lay) {
        const m = new Map();
        if (lay.sizes) for (const [i, h] of lay.sizes) if (h !== def) m.set(i, h);
        if (lay.hidden) for (const i of lay.hidden) m.set(i, 0);
        for (const [i, h] of ov) m.set(i, h);
        axis.buildSparse(n, def, z, m);
      } else axis.build(n, ov.size ? (i => (ov.has(i) ? ov.get(i) : sizeFn(i))) : sizeFn, hiddenFn, def, z);
    }
    _layout(opts) {
      const p = this.provider, z = this.zoom;
      const rc = Math.max(0, p.rowCount | 0), cc = Math.max(0, p.colCount | 0);
      this.view = C.makeViewMap(this._order, rc);
      this.viewCount = this.view.count;
      this.nRows = this.viewCount + this.extraRows; this.nCols = cc + this.extraCols;
      const toS = this.view.toSource;
      const defR = p.rowHeight(rc) || 20, defC = p.colWidth(cc) || 64;
      const keep = opts && opts.keepSizes && this._defR === defR && this._defC === defC && this.rowAxis.zoom === z && this.colAxis.zoom === z;
      this._defR = defR; this._defC = defC;
      if (!(keep && this.rowAxis.setCount(this.nRows))) this._buildAxis(this.rowAxis, this.nRows, rc, this.rowOv, i => p.rowHeight(toS(i)), i => p.isRowHidden(toS(i)), defR, p.rowLayout && (() => p.rowLayout()));
      if (!(keep && this.colAxis.setCount(this.nCols))) this._buildAxis(this.colAxis, this.nCols, cc, this.colOv, i => p.colWidth(i), i => p.isColHidden(i), defC, p.colLayout && (() => p.colLayout()));
      this.fr = Math.min(p.frozenRows | 0, this.nRows); this.fc = Math.min(p.frozenCols | 0, this.nCols);
      this._metrics();
      const m = p.merges, ml = m ? m.length : 0, ordered = !!this._order;
      if (!this.mi || this._miSrc !== m || this._miLen !== ml || this._miOrdered !== ordered || (opts && opts.merges)) this.mi = ordered ? new MergeIndex([]) : new MergeIndex(m);
      this._miSrc = m; this._miLen = ml; this._miOrdered = ordered;
      this.el.setAttribute('aria-rowcount', String(this.nRows)); this.el.setAttribute('aria-colcount', String(this.nCols));
    }
    _metrics() {
      const z = this.zoom;
      this.hdrH = Math.round(HDR_H * z);
      this.hdrW = Math.round(Math.max(34, String(this.nRows).length * 8 + 16) * z);
    }
    _viewW() { return this.cw - this.hdrW; }
    _viewH() { return this.ch - this.hdrH; }
    _applySize() {
      const sc = this.scroller;
      this.cw = Math.max(1, sc.clientWidth || this.el.clientWidth); this.ch = Math.max(1, sc.clientHeight || this.el.clientHeight);
      const vw = this._viewW(), vh = this._viewH();
      const maxX = Math.max(0, this.colAxis.total - vw), maxY = Math.max(0, this.rowAxis.total - vh);
      const cx = Math.min(maxX, C.MAX_SCROLL), cy = Math.min(maxY, C.MAX_SCROLL);
      this.ratioX = cx > 0 ? maxX / cx : 1; this.ratioY = cy > 0 ? maxY / cy : 1;
      this.maxX = maxX; this.maxY = maxY;
      this.spacer.style.width = (this.cw + cx) + 'px'; this.spacer.style.height = (this.ch + cy) + 'px';
      this.sx = clamp(this.sx, 0, maxX); this.sy = clamp(this.sy, 0, maxY);
      this._pushScroll();
    }
    _pushScroll() {
      const sc = this.scroller;
      const t = this.sy / this.ratioY, l = this.sx / this.ratioX;
      if (Math.abs(sc.scrollTop - t) > 0.5) sc.scrollTop = t;
      if (Math.abs(sc.scrollLeft - l) > 0.5) sc.scrollLeft = l;
      this._cssTop = sc.scrollTop; this._cssLeft = sc.scrollLeft;
    }
    _resize() {
      const dpr = root.devicePixelRatio || 1;
      const w = this.el.clientWidth, h = this.el.clientHeight;
      if (this._elW === w && this._elH === h && this.dpr === dpr && this._sized) return;
      this.dpr = dpr; this._elW = w; this._elH = h; this._sized = true;
      this.canvas.width = Math.max(1, Math.floor(w * dpr)); this.canvas.height = Math.max(1, Math.floor(h * dpr));
      this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
      this._font = '';
      this._applySize();
      if (this._raf) { cancelAnimationFrameOf(this._raf); this._raf = 0; }
      this._paint();
    }
    _onScroll() {
      const sc = this.scroller;
      if (sc.scrollTop !== this._cssTop) { this._cssTop = sc.scrollTop; this.sy = clamp(sc.scrollTop * this.ratioY, 0, this.maxY); }
      if (sc.scrollLeft !== this._cssLeft) { this._cssLeft = sc.scrollLeft; this.sx = clamp(sc.scrollLeft * this.ratioX, 0, this.maxX); }
      this._schedule();
      if (!this._scrollEmit) this._scrollEmit = setTimeout(() => { this._scrollEmit = 0; this.emit('scroll', this.getScroll()); }, 50);
      if (this.edit_) this._placeEditor();
    }
    getScroll() { return { top: this.sy, left: this.sx }; }
    setScroll(s) {
      if (s.top != null) this.sy = clamp(s.top, 0, this.maxY);
      if (s.left != null) this.sx = clamp(s.left, 0, this.maxX);
      this._pushScroll(); this._schedule();
    }
    setZoom(z) {
      z = clamp(Math.round(z * 100) / 100, MIN_ZOOM, MAX_ZOOM);
      if (z === this.zoom) return;
      const r = this.rowAxis.indexAt(this.sy + this.fh()), c = this.colAxis.indexAt(this.sx + this.fw());
      this.zoom = z; this.epoch++; this.widths = new WidthCache(30000, 2e6, 400); this.wrapCache.clear(); this._wrapChars = 0;
      this.rowAxis.setZoom(z); this.colAxis.setZoom(z); this._metrics(); this._applySize();
      this.sy = clamp(this.rowAxis.offset(r) - this.fh(), 0, this.maxY); this.sx = clamp(this.colAxis.offset(c) - this.fw(), 0, this.maxX);
      this._pushScroll(); this._schedule();
      if (this.edit_) { this._styleEditor(); this._placeEditor(); }
      this.emit('zoom', { zoom: z });
    }
    getZoom() { return this.zoom; }
    fw() { return this.colAxis.offset(this.fc); }
    fh() { return this.rowAxis.offset(this.fr); }
    focus() { this.el.focus({ preventScroll: true }); }
    _schedule() { if (!this._raf && !this._dead) this._raf = rafOf(() => { this._raf = 0; if (!this._dead) this._paint(); }); }

    // cell rect in container coords (ignoring clipping); merged-aware
    cellRect(r, c, g) {
      const m = this.mi.at(r, c);
      const r1 = m ? m.r1 : r, c1 = m ? m.c1 : c, r2 = m ? m.r2 : r, c2 = m ? m.c2 : c;
      const ca = this.colAxis, ra = this.rowAxis;
      const ox = g ? g.ox : c1 < this.fc ? 0 : Math.round(this.sx), oy = g ? g.oy : r1 < this.fr ? 0 : Math.round(this.sy);
      const x = Math.round(this.hdrW + ca.offset(c1) - ox), y = Math.round(this.hdrH + ra.offset(r1) - oy);
      return { x, y, w: Math.round(this.hdrW + ca.offset(c2 + 1) - ox) - x, h: Math.round(this.hdrH + ra.offset(r2 + 1) - oy) - y, r1, c1, r2, c2 };
    }
    scrollTo(r, c) { this._reveal(r, c); }
    _reveal(r, c) {
      if (r < 0 || c < 0) return;
      const m = this.mi.at(r, c); if (m) { r = m.r1; c = m.c1; }
      const vw = this._viewW(), vh = this._viewH();
      if (c >= this.fc) {
        const fw = this.fw(), x0 = this.colAxis.offset(c), x1 = x0 + this.colAxis.size(c);
        if (x0 - this.sx < fw) this.sx = x0 - fw; else if (x1 - this.sx > vw) this.sx = Math.min(x0 - fw, x1 - vw);
      }
      if (r >= this.fr) {
        const fh = this.fh(), y0 = this.rowAxis.offset(r), y1 = y0 + this.rowAxis.size(r);
        if (y0 - this.sy < fh) this.sy = y0 - fh; else if (y1 - this.sy > vh) this.sy = Math.min(y0 - fh, y1 - vh);
      }
      this.sx = clamp(this.sx, 0, this.maxX); this.sy = clamp(this.sy, 0, this.maxY);
      this._pushScroll(); this._schedule();
    }
    colLabel(c) { const p = this.provider; return (p.colName && p.colName(c)) || C.colName(c); }
    rowLabel(vr) { const p = this.provider; const s = this.view.toSource(vr); return p.rowName ? p.rowName(s) : String(s + 1); }
    destroy() {
      this._dead = true; this._cancelEdit(true);
      if (this._unbind) this._unbind();
      clearTimeout(this._scrollEmit); clearTimeout(this._liveT); this._cancelFindJob(); this.cancelCopy(); if (this._zoomT) cancelAnimationFrameOf(this._zoomT); clearInterval(this._autoScroll);
      this._closeMenu();
      this.canvas.remove(); this.scroller.remove(); this.live.remove();
      this.el.classList.remove('oxg'); this.listeners = {};
    }
  }
  OX.Grid = Grid;
  const G = Grid.prototype;
  Grid._parseColor = parseColor; Grid._lumOf = lumOf; Grid._internals = { G, C, rafOf, parseColor, lumOf, rgba, mix, MIN_ZOOM, MAX_ZOOM };

  // ---------- painting ----------
  const SKIP = { text: '' };
  const mkReg = () => ({ ri0: 0, ri1: 0, ci0: 0, ci1: 0, x0: 0, y0: 0, x1: 0, y1: 0, ox: 0, oy: 0, fr: false, fcol: false });

  G._grow = function (name, n) {
    const t = this._tm;
    if (!t[name] || t[name].length < n) t[name] = new Int32Array(Math.max(64, n * 2));
    return t[name];
  };

  G._computeVisible = function () {
    const ca = this.colAxis, ra = this.rowAxis, hw = this.hdrW, hh = this.hdrH, cw = this.cw, ch = this.ch;
    const fc = this.fc, fr = this.fr;
    const sx = Math.round(this.sx), sy = Math.round(this.sy);
    let n = 0;
    let cIdx = this._grow('cIdx', fc + 8), cX = this._grow('cX', fc + 8), cW = this._grow('cW', fc + 8);
    const add = (i, ox) => {
      if (n + 1 >= cIdx.length) { cIdx = this._grow2('cIdx', n + 2); cX = this._grow2('cX', n + 2); cW = this._grow2('cW', n + 2); }
      const x = Math.round(hw + ca.offset(i) - ox);
      cIdx[n] = i; cX[n] = x; cW[n] = Math.round(hw + ca.offset(i + 1) - ox) - x; n++;
    };
    for (let c = 0; c < fc; c++) if (ca.size(c) > 0) add(c, 0);
    this.nfc = n;
    if (ca.count > fc) {
      let c = Math.max(fc, ca.indexAt(sx + ca.offset(fc)));
      for (; c < ca.count; c++) {
        if (hw + ca.offset(c) - sx >= cw) break;
        if (ca.size(c) > 0) add(c, sx);
      }
    }
    this.nc = n;
    n = 0;
    let rIdx = this._grow('rIdx', fr + 8), rY = this._grow('rY', fr + 8), rH = this._grow('rH', fr + 8), rS = this._grow('rS', fr + 8);
    const addR = (i, oy) => {
      if (n + 1 >= rIdx.length) { rIdx = this._grow2('rIdx', n + 2); rY = this._grow2('rY', n + 2); rH = this._grow2('rH', n + 2); rS = this._grow2('rS', n + 2); }
      const y = Math.round(hh + ra.offset(i) - oy);
      rIdx[n] = i; rY[n] = y; rH[n] = Math.round(hh + ra.offset(i + 1) - oy) - y; rS[n] = this.view.toSource(i); n++;
    };
    for (let r = 0; r < fr; r++) if (ra.size(r) > 0) addR(r, 0);
    this.nfr = n;
    if (ra.count > fr) {
      let r = Math.max(fr, ra.indexAt(sy + ra.offset(fr)));
      for (; r < ra.count; r++) {
        if (hh + ra.offset(r) - sy >= ch) break;
        if (ra.size(r) > 0) addR(r, sy);
      }
    }
    this.nr = n;
    this.cIdx = this._tm.cIdx; this.cX = this._tm.cX; this.cW = this._tm.cW;
    this.rIdx = this._tm.rIdx; this.rY = this._tm.rY; this.rH = this._tm.rH; this.rS = this._tm.rS;
  };
  G._grow2 = function (name, n) {
    const old = this._tm[name], nu = new Int32Array(n * 2);
    nu.set(old); this._tm[name] = nu; return nu;
  };

  G._paint = function () {
    const t0 = (root.performance || Date).now();
    const ctx = this.ctx, T = this.theme, dpr = this.dpr;
    const cw = this.cw, ch = this.ch;
    this.handle = null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, this._elW || this.el.clientWidth, this._elH || this.el.clientHeight);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    this._font = ''; this._fill = '';
    this.cellsDrawn = 0;
    this._computeVisible();
    const fwc = Math.min(Math.round(this.fw()), cw - this.hdrW), fhc = Math.min(Math.round(this.fh()), ch - this.hdrH);
    this._fwc = fwc; this._fhc = fhc;
    const R = this._regs || (this._regs = [mkReg(), mkReg(), mkReg(), mkReg()]);
    const sx = Math.round(this.sx), sy = Math.round(this.sy);
    const bx = this.hdrW + fwc, by = this.hdrH + fhc;
    const set = (g, ri0, ri1, ci0, ci1, x0, y0, x1, y1, ox, oy, fr, fcol) => { g.ri0 = ri0; g.ri1 = ri1; g.ci0 = ci0; g.ci1 = ci1; g.x0 = x0; g.y0 = y0; g.x1 = x1; g.y1 = y1; g.ox = ox; g.oy = oy; g.fr = fr; g.fcol = fcol; };
    set(R[0], this.nfr, this.nr, this.nfc, this.nc, bx, by, cw, ch, sx, sy, false, false);
    set(R[1], 0, this.nfr, this.nfc, this.nc, bx, this.hdrH, cw, by, sx, 0, true, false);
    set(R[2], this.nfr, this.nr, 0, this.nfc, this.hdrW, by, bx, ch, 0, sy, false, true);
    set(R[3], 0, this.nfr, 0, this.nfc, this.hdrW, this.hdrH, bx, by, 0, 0, true, true);
    for (let i = 0; i < 4; i++) {
      const g = R[i];
      if (g.x1 <= g.x0 || g.y1 <= g.y0) continue;
      this._paintRegion(g);
    }
    this._paintHeaders(fwc, fhc);
    this._paintDividers(fwc, fhc);
    if (this.guide) {
      ctx.fillStyle = T.accent;
      if (this.guide.x != null) ctx.fillRect(Math.round(this.guide.x) - 0.5 + 0.5, 0, 1, ch); else ctx.fillRect(0, Math.round(this.guide.y), cw, 1);
    }
    const t1 = (root.performance || Date).now();
    const s = this.stats; s.paintMs = t1 - t0; s.cells = this.cellsDrawn; s.frames++; s.avgMs = s.avgMs ? s.avgMs * 0.9 + s.paintMs * 0.1 : s.paintMs;
    this._queueLive();
  };

  G._setFont = function (f) { if (this._font !== f) { this._font = f; this.ctx.font = f; } };
  G._setFill = function (c) { if (this._fill !== c) { this._fill = c; this.ctx.fillStyle = c; } };

  const DASH_A = [3, 2], DASH_B = [1, 1], NO_DASH = [];
  // border descriptor (interned per kind+color): rects/segments are queued per region and drawn in one pass per descriptor
  G._bdesc = function (b) {
    let d = this._bdw.get(b);
    if (d !== undefined && d.epoch === this.epoch) return d;
    const s = b.style, col = b.color || this.theme.fg;
    const dash = s === 'dashed' || s === 'mediumDashed' || s === 'slantDashDot' || s === 'dashDot' || s === 'dashDotDot';
    const dot = s === 'dotted' || s === 'hair';
    // kinds: 0..2 solid width 1/2/3, 3 double, 4 dashed w1, 5 dashed w2, 6 dotted
    const kind = dash ? (s === 'mediumDashed' ? 5 : 4) : dot ? 6 : s === 'double' ? 3 : s === 'medium' ? 1 : s === 'thick' ? 2 : 0;
    const key = kind + '|' + col;
    let it = this._bdi.get(key);
    if (it === undefined) {
      if (this._bdi.size > 256) this._bdi.clear();
      it = { kind, col, a: [], n: 0, epoch: this.epoch }; this._bdi.set(key, it);
    }
    it.epoch = this.epoch;
    this._bdw.set(b, it);
    return it;
  };
  G._borders = function (st, x, y, w, h) {
    if (st.bl) this._line(this._bdesc(st.bl), x, y, h, true);
    if (st.br) this._line(this._bdesc(st.br), x + w, y, h, true);
    if (st.bt) this._line(this._bdesc(st.bt), x, y, w, false);
    if (st.bb) this._line(this._bdesc(st.bb), x, y + h, w, false);
  };
  // queue one edge: vertical edge at x=e from y=st over len, or horizontal edge at y=e from x=st
  G._line = function (d, a, bpos, len, vert) {
    const e = vert ? a : bpos, st = vert ? bpos : a, arr = d.a;
    let n = d.n;
    if (n === 0) this._bact.push(d);
    switch (d.kind) {
      case 0: case 1: case 2: { const w = d.kind + 1; if (vert) { arr[n] = e - 1; arr[n + 1] = st; arr[n + 2] = w; arr[n + 3] = len; } else { arr[n] = st; arr[n + 1] = e - 1; arr[n + 2] = len; arr[n + 3] = w; } n += 4; break; }
      case 3:
        if (vert) { arr[n] = e - 2; arr[n + 1] = st; arr[n + 2] = 1; arr[n + 3] = len; arr[n + 4] = e; arr[n + 5] = st; arr[n + 6] = 1; arr[n + 7] = len; }
        else { arr[n] = st; arr[n + 1] = e - 2; arr[n + 2] = len; arr[n + 3] = 1; arr[n + 4] = st; arr[n + 5] = e; arr[n + 6] = len; arr[n + 7] = 1; }
        n += 8; break;
      default: { const o = d.kind === 5 ? 0 : -0.5; if (vert) { arr[n] = e + o; arr[n + 1] = st; arr[n + 2] = e + o; arr[n + 3] = st + len; } else { arr[n] = st; arr[n + 1] = e + o; arr[n + 2] = st + len; arr[n + 3] = e + o; } n += 4; }
    }
    d.n = n;
  };
  G._flushBorders = function () {
    const act = this._bact, ctx = this.ctx;
    if (!act.length) return;
    let dashed = false;
    for (let i = 0; i < act.length; i++) {
      const d = act[i], a = d.a, n = d.n;
      if (d.kind < 4) {
        this._setFill(d.col);
        for (let j = 0; j < n; j += 4) ctx.fillRect(a[j], a[j + 1], a[j + 2], a[j + 3]);
      } else {
        ctx.strokeStyle = d.col; ctx.lineWidth = d.kind === 5 ? 2 : 1; ctx.setLineDash(d.kind === 6 ? DASH_B : DASH_A); dashed = true;
        ctx.beginPath();
        for (let j = 0; j < n; j += 4) { ctx.moveTo(a[j], a[j + 1]); ctx.lineTo(a[j + 2], a[j + 3]); }
        ctx.stroke();
      }
      d.n = 0;
    }
    if (dashed) ctx.setLineDash(NO_DASH);
    act.length = 0;
  };

  G._paintRegion = function (g) {
    const ctx = this.ctx, T = this.theme, p = this.provider;
    const ncol = g.ci1 - g.ci0, nrow = g.ri1 - g.ri0;
    ctx.save();
    ctx.beginPath(); ctx.rect(g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0); ctx.clip();
    this._fill = ''; this._font = '';
    const cIdx = this.cIdx, cX = this.cX, cW = this.cW, rIdx = this.rIdx, rY = this.rY, rH = this.rH, rS = this.rS;
    let buf = this._buf || (this._buf = []);
    const need = ncol * nrow;
    const mi = this.mi;
    const hasM = need > 0 && mi.size > 0 && mi.hasInRows(rIdx[g.ri0], rIdx[g.ri1 - 1]);
    let merges = null;
    if (need > 0) {
      let k = 0;
      for (let ri = g.ri0; ri < g.ri1; ri++) {
        const sr = rS[ri], vr = rIdx[ri];
        for (let ci = g.ci0; ci < g.ci1; ci++, k++) {
          if (hasM) {
            const m = mi.at(vr, cIdx[ci]);
            if (m) { buf[k] = SKIP; if (!merges) merges = this._mergeList || (this._mergeList = []); if (merges.indexOf(m) < 0) merges.push(m); continue; }
          }
          buf[k] = p.getCell(sr, cIdx[ci]);
        }
      }
      this.cellsDrawn += need;
    }
    // gridlines
    if (p.showGridLines !== false && need > 0) {
      ctx.beginPath();
      const y0 = rY[g.ri0], y1 = rY[g.ri1 - 1] + rH[g.ri1 - 1], x0 = cX[g.ci0], x1 = cX[g.ci1 - 1] + cW[g.ci1 - 1];
      for (let ci = g.ci0; ci < g.ci1; ci++) { const x = cX[ci] + cW[ci] - 0.5; ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
      for (let ri = g.ri0; ri < g.ri1; ri++) { const y = rY[ri] + rH[ri] - 0.5; ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
      ctx.lineWidth = 1; ctx.strokeStyle = T.grid; ctx.stroke();
    }
    // backgrounds, batched per color
    if (need > 0) {
      const fills = this._fills || (this._fills = new Map());
      if (fills.size > 64) fills.clear();
      let lastBg = null, le = null, anyBg = false, k = 0;
      for (let ri = g.ri0; ri < g.ri1; ri++) {
        const y = rY[ri], h = rH[ri];
        for (let ci = g.ci0; ci < g.ci1; ci++, k++) {
          const cv = buf[k];
          if (cv === undefined) continue;
          const st = cv.style;
          if (!st) continue;
          const bg = st.bg;
          if (!bg || cv === SKIP) continue;
          if (bg !== lastBg) { lastBg = bg; le = fills.get(bg); if (le === undefined) { le = { a: [], n: 0 }; fills.set(bg, le); } }
          const a = le.a, n = le.n;
          a[n] = cX[ci]; a[n + 1] = y; a[n + 2] = cW[ci]; a[n + 3] = h; le.n = n + 4; anyBg = true;
        }
      }
      if (anyBg) {
        for (const [col, e] of fills) {
          if (!e.n) continue;
          this._setFill(col);
          const a = e.a;
          for (let i = 0; i < e.n; i += 4) ctx.fillRect(a[i], a[i + 1], a[i + 2], a[i + 3]);
          e.n = 0;
        }
      }
    }
    let mrects = null;
    if (merges) {
      mrects = this._mrects || (this._mrects = []);
      mrects.length = 0;
      for (const m of merges) {
        const rc = this.cellRect(m.r1, m.c1, g);
        const cv = p.getCell(this.view.toSource(m.r1), m.c1);
        this._setFill((cv && cv.style && cv.style.bg) || T.bg); ctx.fillRect(rc.x, rc.y, rc.w, rc.h);
        mrects.push(rc, cv);
      }
      merges.length = 0;
    }
    // search highlights
    if (this.find_) this._paintMatches(g);
    // borders (queued, flushed once per descriptor)
    if (need > 0) {
      let k = 0;
      for (let ri = g.ri0; ri < g.ri1; ri++) {
        const y = rY[ri], h = rH[ri];
        for (let ci = g.ci0; ci < g.ci1; ci++, k++) {
          const cv = buf[k];
          if (cv === undefined) continue;
          const st = cv.style;
          if (st && (st.bl || st.br || st.bt || st.bb) && cv !== SKIP) this._borders(st, cX[ci], y, cW[ci], h);
        }
      }
    }
    if (mrects) for (let i = 0; i < mrects.length; i += 2) { const cv = mrects[i + 1], rc = mrects[i]; if (cv && cv.style) this._borders(cv.style, rc.x, rc.y, rc.w, rc.h); }
    this._flushBorders();
    // text
    if (need > 0) {
      let k = 0;
      for (let ri = g.ri0; ri < g.ri1; ri++) {
        const y = rY[ri], h = rH[ri];
        for (let ci = g.ci0; ci < g.ci1; ci++, k++) {
          const cv = buf[k];
          if (cv !== undefined && cv !== SKIP && cv.text) this._text(cv, cX[ci], y, cW[ci], h, buf, k, ci - g.ci0, ncol, g);
        }
      }
    }
    if (mrects) for (let i = 0; i < mrects.length; i += 2) { const cv = mrects[i + 1], rc = mrects[i]; if (cv && cv.text) this._text(cv, rc.x, rc.y, rc.w, rc.h, null, 0, 0, 0, g); }
    if (buf.length > 20000) buf.length = 20000;
    this._paintSelection(g);
    ctx.restore();
    this._font = ''; this._fill = '';
  };

  // line breaking cache: (font, width, text); text is bounded by the caller. Binary search splits over-long words.
  G._wrapLines = function (text, font, avail) {
    const key = font + '|' + (avail | 0) + '|' + text;
    let l = this.wrapCache.get(key);
    if (l !== undefined) return l;
    l = [];
    const m = this._wm || (this._wm = (s) => this._measure(this._wf, s));
    this._wf = font;
    const sp = m(' ');
    const paras = text.indexOf('\n') >= 0 ? text.split(/\r?\n/) : [text];
    for (let pi = 0; pi < paras.length; pi++) {
      let line = '', lw = 0;
      const words = paras[pi].split(' ');
      for (let wi = 0; wi < words.length; wi++) {
        const word = words[wi];
        const ww = m(word);
        if (line === '' && ww <= avail) { line = word; lw = ww; continue; }
        if (line !== '' && lw + sp + ww <= avail) { line += ' ' + word; lw += sp + ww; continue; }
        if (line !== '') { l.push(line); line = ''; lw = 0; }
        if (ww <= avail) { line = word; lw = ww; continue; }
        let rest = word;
        while (rest.length) {
          const rw = m(rest);
          if (rw <= avail) { line = rest; lw = rw; break; }
          let lo = 1, hi = rest.length - 1;
          while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (m(rest.slice(0, mid)) <= avail) lo = mid; else hi = mid - 1; }
          let k = lo;
          if (k > 1) { const cc = rest.charCodeAt(k - 1); if (cc >= 0xd800 && cc < 0xdc00) k--; }
          l.push(rest.slice(0, k)); rest = rest.slice(k);
        }
      }
      l.push(line);
    }
    if (this.wrapCache.size >= 3000 || this._wrapChars > 1.5e6) { this.wrapCache.clear(); this._wrapChars = 0; }
    this.wrapCache.set(key, l); this._wrapChars += key.length;
    return l;
  };

  // width of consecutive empty neighbour cells in direction dir (stops once >= limit)
  G._room = function (buf, k, cio, ncol, dir, limit, ci0) {
    if (!buf) return 0;
    const cW = this.cW;
    let sum = 0, j = cio + dir, kk = k + dir;
    while (j >= 0 && j < ncol && sum < limit) {
      const n = buf[kk];
      if (n === SKIP || (n !== undefined && n.text)) break;
      sum += cW[ci0 + j]; j += dir; kk += dir;
    }
    return sum;
  };

  const LONG_TEXT = 160;
  G._text = function (cv, x, y, w, h, buf, k, cio, ncol, g) {
    const ctx = this.ctx, T = this.theme, z = this.zoom;
    const st = cv.style, se = st ? this._style(st) : this._defStyle();
    let text = cv.text;
    const kind = cv.kind;
    let al = st ? st.h : 'general';
    if (al === 'general' || !al) al = kind === 'number' || kind === 'date' ? 'right' : kind === 'bool' || kind === 'error' ? 'center' : 'left';
    else if (al === 'centerContinuous') al = 'center';
    else if (al !== 'right' && al !== 'center') al = 'left';
    const pad = Math.max(2, Math.round(3 * z));
    const indent = st && st.indent > 0 && al !== 'center' ? st.indent * 9 * z : 0;
    const avail = w - 2 * pad - indent;
    this._setFont(se.font);
    this._setFill(cv.color || (cv.link ? T.link : se.color));
    const lh = se.lh, va = st ? st.v : 'center';
    if (st && st.wrap && kind === 'text') {
      if (avail < 4) return;
      let trunc = false;
      if (text.length > LONG_TEXT) {
        const cap = (Math.ceil(h / lh) + 1) * 2 * Math.ceil(avail / (0.2 * se.px)) + 32;
        if (text.length > cap) { text = text.slice(0, cap); trunc = true; }
      }
      const lines = this._wrapLines(text, se.font, avail);
      const total = lines.length * lh;
      const bottom = !trunc && (va === 'bottom' || !va);
      let y0 = va === 'top' ? y + 2 * z : bottom ? y + h - total - 2 * z : y + (h - total) / 2;
      const over = total > h - 2;
      if (over) y0 = bottom ? y0 : y + 1;
      if (over) { ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); }
      for (let i = 0; i < lines.length; i++) {
        const ly = y0 + i * lh;
        if (ly + lh < y) continue;
        if (ly > y + h) break;
        const lw = this._measure(se.font, lines[i]);
        const lx = al === 'right' ? x + w - pad - lw : al === 'center' ? x + (w - lw) / 2 : x + pad + indent;
        ctx.fillText(lines[i], Math.round(lx), Math.round(ly + lh / 2));
        if (st.u || cv.link) ctx.fillRect(Math.round(lx), Math.round(ly + lh / 2 + se.px * 0.5), Math.round(lw), 1);
        if (st.strike) ctx.fillRect(Math.round(lx), Math.round(ly + lh / 2), Math.round(lw), 1);
      }
      if (over) { ctx.restore(); this._font = ''; this._fill = ''; }
      return;
    }
    const ci0 = g.ci0;
    let roomL = -1, roomR = -1;
    if (text.length > LONG_TEXT && kind !== 'number' && kind !== 'date') {
      // only a bounded prefix can ever be visible: measure and draw that instead of the whole string
      let room;
      if (al === 'left') room = roomR = this._room(buf, k, cio, ncol, 1, 1e9, ci0);
      else if (al === 'right') room = roomL = this._room(buf, k, cio, ncol, -1, 1e9, ci0);
      else { roomL = this._room(buf, k, cio, ncol, -1, 1e9, ci0); roomR = this._room(buf, k, cio, ncol, 1, 1e9, ci0); room = 2 * Math.min(roomL, roomR); }
      const cap = Math.ceil((avail + room) / (0.2 * se.px)) + 4;
      if (text.length > cap) {
        text = al === 'left' ? text.slice(0, cap) : al === 'right' ? text.slice(text.length - cap) : text.slice((text.length - cap) >> 1, ((text.length - cap) >> 1) + cap);
      }
    }
    if (text.indexOf('\n') >= 0) text = text.replace(/\r?\n/g, ' ');
    let tw = this._measure(se.font, text);
    let clip = false, cx0 = x, cx1 = x + w;
    if (tw > avail) {
      if (kind === 'number' || kind === 'date') {
        const hw = this._measure(se.font, '#'), n = Math.floor(avail / hw);
        if (n < 1) return;
        text = '#'.repeat(n); tw = this._measure(se.font, text);
      } else {
        const need = tw - avail;
        let l = 0, r = 0;
        if (al === 'left') { r = roomR >= 0 ? roomR : this._room(buf, k, cio, ncol, 1, need, ci0); clip = need > r; }
        else if (al === 'right') { l = roomL >= 0 ? roomL : this._room(buf, k, cio, ncol, -1, need, ci0); clip = need > l; }
        else {
          l = roomL >= 0 ? roomL : this._room(buf, k, cio, ncol, -1, need / 2, ci0); r = roomR >= 0 ? roomR : this._room(buf, k, cio, ncol, 1, need / 2, ci0);
          clip = need / 2 > l || need / 2 > r;
        }
        cx0 = x - l; cx1 = x + w + r;
      }
    }
    const yc = va === 'top' ? y + 2 * z + lh / 2 : va === 'bottom' || !va ? y + h - 2 * z - lh / 2 : y + h / 2;
    const ty = Math.round(h < lh + 2 ? y + h / 2 : yc);
    const tx = Math.round(al === 'right' ? x + w - pad - tw : al === 'center' ? x + (w - tw) / 2 : x + pad + indent);
    if (clip) { ctx.save(); ctx.beginPath(); ctx.rect(cx0, y, cx1 - cx0, h); ctx.clip(); }
    ctx.fillText(text, tx, ty);
    if (st && (st.u || st.strike) || cv.link) {
      if ((st && st.u) || cv.link) ctx.fillRect(tx, Math.round(ty + se.px * 0.5), Math.round(tw), 1);
      if (st && st.strike) ctx.fillRect(tx, ty, Math.round(tw), 1);
    }
    if (clip) { ctx.restore(); this._font = ''; this._fill = ''; }
  };

  G._paintMatches = function (g) {
    const f = this.find_;
    if (g.ci1 <= g.ci0) return;
    if (f.B.n) this._paintList(f.B, g);
    if (f.A.n) this._paintList(f.A, g);
  };
  G._paintList = function (list, g) {
    const keys = list.a, nk = list.n, f = this.find_, ctx = this.ctx, T = this.theme;
    const cIdx = this.cIdx, cX = this.cX, cW = this.cW;
    const cLo = cIdx[g.ci0], cHi = cIdx[g.ci1 - 1];
    for (let ri = g.ri0; ri < g.ri1; ri++) {
      const vr = this.rIdx[ri], base = vr * 65536;
      let lo = 0, hi = nk;
      const k0 = base + cLo;
      while (lo < hi) { const m = (lo + hi) >> 1; if (keys[m] < k0) lo = m + 1; else hi = m; }
      for (; lo < nk && keys[lo] <= base + cHi; lo++) {
        const c = keys[lo] - base;
        let a = g.ci0, b = g.ci1 - 1;
        while (a < b) { const m = (a + b) >> 1; if (cIdx[m] < c) a = m + 1; else b = m; }
        if (cIdx[a] !== c) continue;
        this._setFill(f.curKey === keys[lo] ? T.matchCur : T.match);
        ctx.fillRect(cX[a], this.rY[ri], cW[a], this.rH[ri]);
      }
    }
    this._fill = '';
  };

  G._rangeRect = function (rg, g) {
    const ca = this.colAxis, ra = this.rowAxis, hw = this.hdrW, hh = this.hdrH, lim = 4000;
    const q = (v, mn, mx) => v < mn ? mn : v > mx ? mx : v;
    return {
      x1: q(Math.round(hw + ca.offset(rg.c1) - g.ox), -lim, this.cw + lim), x2: q(Math.round(hw + ca.offset(rg.c2 + 1) - g.ox), -lim, this.cw + lim),
      y1: q(Math.round(hh + ra.offset(rg.r1) - g.oy), -lim, this.ch + lim), y2: q(Math.round(hh + ra.offset(rg.r2 + 1) - g.oy), -lim, this.ch + lim)
    };
  };

  G._paintSelection = function (g) {
    const ctx = this.ctx, T = this.theme;
    const rs = this.ranges;
    const ar = this.cellRect(this.active.r, this.active.c, g);
    for (let i = 0; i < rs.length; i++) {
      const rg = rs[i], b = this._rangeRect(rg, g);
      if (b.x2 <= g.x0 - 3 || b.x1 >= g.x1 + 3 || b.y2 <= g.y0 - 3 || b.y1 >= g.y1 + 3) continue;
      const single = rg.r1 === rg.r2 && rg.c1 === rg.c2 || (this.mi.size && (() => { const m = this.mi.at(rg.r1, rg.c1); return m && m.r1 === rg.r1 && m.c1 === rg.c1 && m.r2 === rg.r2 && m.c2 === rg.c2; })());
      if (!single) {
        ctx.beginPath(); ctx.rect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
        if (C.inRange(rg, this.active.r, this.active.c)) ctx.rect(ar.x, ar.y, ar.w, ar.h);
        ctx.fillStyle = T.selFill; ctx.fill('evenodd'); this._fill = '';
      }
      ctx.strokeStyle = T.accent; ctx.lineWidth = 2; ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
    }
    if (this.find_ && this.find_.curKey >= 0) {
      const key = this.find_.curKey, vr = Math.floor(key / 65536), c = key - vr * 65536;
      const rc = this.cellRect(vr, c, g);
      ctx.strokeStyle = '#ff8c00'; ctx.lineWidth = 2; ctx.strokeRect(rc.x, rc.y, rc.w, rc.h);
    }
    const last = rs[rs.length - 1];
    if (last && !this.readOnly && !this.edit_) {
      if (g.fr === (last.r2 < this.fr) && g.fcol === (last.c2 < this.fc)) {
        const b = this._rangeRect(last, g);
        if (b.x2 >= g.x0 - 4 && b.x2 <= g.x1 + 4 && b.y2 >= g.y0 - 4 && b.y2 <= g.y1 + 4) {
          ctx.fillStyle = T.bg; ctx.fillRect(b.x2 - 4, b.y2 - 4, 8, 8);
          ctx.fillStyle = T.accent; ctx.fillRect(b.x2 - 3, b.y2 - 3, 6, 6); this._fill = '';
          this.handle = { x: b.x2, y: b.y2 };
        }
      }
    }
    if (this.fillPreview) {
      const b = this._rangeRect(this.fillPreview, g);
      ctx.save(); ctx.setLineDash([4, 3]); ctx.strokeStyle = T.fg; ctx.lineWidth = 1;
      ctx.strokeRect(b.x1 + 0.5, b.y1 + 0.5, b.x2 - b.x1 - 1, b.y2 - b.y1 - 1); ctx.restore();
    }
  };

  // 0 none, 1 contains selection, 2 fully selected
  G._hdrState = function (isCol, idx) {
    let s = 0;
    for (const rg of this.ranges) {
      if (isCol) { if (idx >= rg.c1 && idx <= rg.c2) { if (rg.r1 === 0 && rg.r2 >= this.nRows - 1) return 2; s = 1; } }
      else if (idx >= rg.r1 && idx <= rg.r2) { if (rg.c1 === 0 && rg.c2 >= this.nCols - 1) return 2; s = 1; }
    }
    return s;
  };

  G._paintHeaders = function (fwc, fhc) {
    const ctx = this.ctx, T = this.theme, z = this.zoom, hw = this.hdrW, hh = this.hdrH, cw = this.cw, ch = this.ch;
    const cIdx = this.cIdx, cX = this.cX, cW = this.cW, rIdx = this.rIdx, rY = this.rY, rH = this.rH;
    const hfont = (600 | 0) + ' ' + (11 * z).toFixed(2) + 'px ' + T.family, nfont = (11 * z).toFixed(2) + 'px ' + T.family;
    ctx.textAlign = 'center';
    const drawCols = (ci0, ci1, x0, x1) => {
      ctx.save(); ctx.beginPath(); ctx.rect(x0, 0, x1 - x0, hh); ctx.clip();
      ctx.fillStyle = T.hdrBg; ctx.fillRect(x0, 0, x1 - x0, hh);
      for (let ci = ci0; ci < ci1; ci++) {
        const s = this._hdrState(true, cIdx[ci]);
        if (s) { ctx.fillStyle = s === 2 ? T.hdrSelFull : T.hdrSel; ctx.fillRect(cX[ci], 0, cW[ci], hh); ctx.fillStyle = T.accent; ctx.fillRect(cX[ci], hh - 2, cW[ci], 2); }
      }
      ctx.beginPath();
      for (let ci = ci0; ci < ci1; ci++) { const x = cX[ci] + cW[ci] - 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, hh); }
      ctx.strokeStyle = T.hdrLine; ctx.lineWidth = 1; ctx.stroke();
      for (let ci = ci0; ci < ci1; ci++) {
        if (cW[ci] < 10) continue;
        const s = this._hdrState(true, cIdx[ci]);
        ctx.font = s ? hfont : nfont; ctx.fillStyle = s ? T.hdrFgSel : T.hdrFg;
        ctx.fillText(this.colLabel(cIdx[ci]), cX[ci] + cW[ci] / 2, Math.round(hh / 2));
      }
      ctx.restore();
    };
    const drawRows = (ri0, ri1, y0, y1) => {
      ctx.save(); ctx.beginPath(); ctx.rect(0, y0, hw, y1 - y0); ctx.clip();
      ctx.fillStyle = T.hdrBg; ctx.fillRect(0, y0, hw, y1 - y0);
      for (let ri = ri0; ri < ri1; ri++) {
        const s = this._hdrState(false, rIdx[ri]);
        if (s) { ctx.fillStyle = s === 2 ? T.hdrSelFull : T.hdrSel; ctx.fillRect(0, rY[ri], hw, rH[ri]); ctx.fillStyle = T.accent; ctx.fillRect(hw - 2, rY[ri], 2, rH[ri]); }
      }
      ctx.beginPath();
      for (let ri = ri0; ri < ri1; ri++) { const y = rY[ri] + rH[ri] - 0.5; ctx.moveTo(0, y); ctx.lineTo(hw, y); }
      ctx.strokeStyle = T.hdrLine; ctx.lineWidth = 1; ctx.stroke();
      for (let ri = ri0; ri < ri1; ri++) {
        if (rH[ri] < 8) continue;
        const s = this._hdrState(false, rIdx[ri]);
        ctx.font = s ? hfont : nfont; ctx.fillStyle = s ? T.hdrFgSel : T.hdrFg;
        ctx.fillText(this.rowLabel(rIdx[ri]), hw / 2, rY[ri] + Math.round(rH[ri] / 2));
      }
      ctx.restore();
    };
    drawCols(this.nfc, this.nc, hw + fwc, cw); if (this.nfc) drawCols(0, this.nfc, hw, hw + fwc);
    drawRows(this.nfr, this.nr, hh + fhc, ch); if (this.nfr) drawRows(0, this.nfr, hh, hh + fhc);
    ctx.fillStyle = T.hdrBg; ctx.fillRect(0, 0, hw, hh);
    ctx.fillStyle = T.hdrLine; ctx.fillRect(0, hh - 1, cw, 1); ctx.fillRect(hw - 1, 0, 1, ch);
    // select-all triangle
    const tz = Math.max(6, Math.round(9 * z));
    ctx.beginPath(); ctx.moveTo(hw - 4, hh - 4); ctx.lineTo(hw - 4 - tz, hh - 4); ctx.lineTo(hw - 4, hh - 4 - tz); ctx.closePath();
    ctx.fillStyle = mixAlpha(T, 0.45); ctx.fill();
    ctx.textAlign = 'left'; this._font = ''; this._fill = '';
  };
  function mixAlpha(T, a) { return T.dark ? 'rgba(255,255,255,' + a * 0.6 + ')' : 'rgba(0,0,0,' + a * 0.6 + ')'; }

  G._paintDividers = function (fwc, fhc) {
    const ctx = this.ctx, T = this.theme, hw = this.hdrW, hh = this.hdrH, cw = this.cw, ch = this.ch;
    if (this.fc > 0 && fwc > 0) {
      const x = hw + fwc;
      if (this.sx > 0 && x < cw) {
        const gr = ctx.createLinearGradient(x, 0, x + 6, 0);
        gr.addColorStop(0, T.dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.14)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gr; ctx.fillRect(x, hh, 6, ch - hh); this._fill = '';
      }
      ctx.fillStyle = T.divider; ctx.fillRect(x - 1, 0, 1, ch); this._fill = '';
    }
    if (this.fr > 0 && fhc > 0) {
      const y = hh + fhc;
      if (this.sy > 0 && y < ch) {
        const gr = ctx.createLinearGradient(0, y, 0, y + 6);
        gr.addColorStop(0, T.dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.14)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gr; ctx.fillRect(hw, y, cw - hw, 6); this._fill = '';
      }
      ctx.fillStyle = T.divider; ctx.fillRect(0, y - 1, cw, 1); this._fill = '';
    }
  };

  G._queueLive = function () {
    if (this._liveT) return;
    this._liveT = setTimeout(() => {
      this._liveT = 0;
      if (this._dead) return;
      const a = this.active, cv = this._cellAt(a.r, a.c);
      const msg = this.colLabel(a.c) + this.rowLabel(a.r) + (cv && cv.text ? ': ' + cv.text : ': empty');
      if (msg !== this._liveMsg) { this._liveMsg = msg; this.live.textContent = msg; }
    }, 200);
  };
  G._cellAt = function (vr, c) { return vr < this.viewCount && c < this.provider.colCount ? this.provider.getCell(this.view.toSource(vr), c) : undefined; };

  // ---------- selection ----------
  G.getSelection = function () {
    return { active: { r: this.active.r, c: this.active.c, sr: this.view.toSource(this.active.r) }, ranges: this.ranges.map(g => ({ r1: g.r1, c1: g.c1, r2: g.r2, c2: g.c2 })) };
  };
  G._clampSel = function () {
    const mr = Math.max(0, this.nRows - 1), mc = Math.max(0, this.nCols - 1);
    const cp = p => { p.r = clamp(p.r, 0, mr); p.c = clamp(p.c, 0, mc); };
    cp(this.active); cp(this.anchor); cp(this.focusCell);
    for (const g of this.ranges) { g.r1 = clamp(g.r1, 0, mr); g.r2 = clamp(g.r2, 0, mr); g.c1 = clamp(g.c1, 0, mc); g.c2 = clamp(g.c2, 0, mc); }
  };
  G._selChanged = function (reveal) {
    if (reveal !== false) this._reveal(this.focusCell.r, this.focusCell.c);
    this._schedule();
    const k = this.active.r + ',' + this.active.c + '|' + this.ranges.map(g => g.r1 + ',' + g.c1 + ',' + g.r2 + ',' + g.c2).join(';');
    if (k !== this._selKey) {
      this._selKey = k;
      const sel = this.getSelection(), d = this.drag;
      if (d && (d.type === 'cell' || d.type === 'cols' || d.type === 'rows')) { sel.dragging = true; this._dragSelEmitted = true; }
      this.emit('select', sel);
    }
  };
  G.select = function (r1, c1, r2, c2) {
    if (r2 == null) { r2 = r1; c2 = c1; }
    this._cancelEdit();
    this.anchor = { r: r1, c: c1 }; this.focusCell = { r: r2, c: c2 }; this.active = { r: r1, c: c1 };
    this._clampSel();
    this.ranges = [this.mi.expand(Math.min(this.anchor.r, this.focusCell.r), Math.min(this.anchor.c, this.focusCell.c), Math.max(this.anchor.r, this.focusCell.r), Math.max(this.anchor.c, this.focusCell.c))];
    this._snapActive();
    this._selChanged();
  };
  G._snapActive = function () {
    const m = this.mi.at(this.active.r, this.active.c);
    if (m && this.ranges.length === 1 && this.ranges[0].r1 === m.r1 && this.ranges[0].c1 === m.c1 && this.ranges[0].r2 === m.r2 && this.ranges[0].c2 === m.c2) this.active = { r: m.r1, c: m.c1 };
  };
  G._setFocus = function (r, c, additive) {
    this.focusCell = { r, c };
    const rg = this.mi.expand(Math.min(this.anchor.r, r), Math.min(this.anchor.c, c), Math.max(this.anchor.r, r), Math.max(this.anchor.c, c));
    if (additive) this.ranges.push(rg); else this.ranges[this.ranges.length - 1] = rg;
  };
  G._selectAll = function () {
    this.ranges = [{ r1: 0, c1: 0, r2: this.nRows - 1, c2: this.nCols - 1 }];
    this.anchor = { r: 0, c: 0 }; this.focusCell = { r: this.nRows - 1, c: this.nCols - 1 };
    this._selChanged(false);
  };
  G._topRow = function () { return this.fr > 0 ? 0 : this.rowAxis.indexAt(this.sy); };
  G._leftCol = function () { return this.fc > 0 ? 0 : this.colAxis.indexAt(this.sx); };
  G._selectCols = function (c1, c2, add, keepActive, replaceLast) {
    const rg = { r1: 0, c1: Math.min(c1, c2), r2: this.nRows - 1, c2: Math.max(c1, c2) };
    if (add && replaceLast) this.ranges[this.ranges.length - 1] = rg; else if (add) this.ranges.push(rg); else this.ranges = [rg];
    this.focusCell = { r: this.nRows - 1, c: c2 };
    if (!keepActive) { this.active = { r: this._topRow(), c: c1 }; this.anchor = { r: 0, c: c1 }; }
    this._selChanged(false);
  };
  G._selectRows = function (r1, r2, add, keepActive, replaceLast) {
    const rg = { r1: Math.min(r1, r2), c1: 0, r2: Math.max(r1, r2), c2: this.nCols - 1 };
    if (add && replaceLast) this.ranges[this.ranges.length - 1] = rg; else if (add) this.ranges.push(rg); else this.ranges = [rg];
    this.focusCell = { r: r2, c: this.nCols - 1 };
    if (!keepActive) { this.active = { r: r1, c: this._leftCol() }; this.anchor = { r: r1, c: 0 }; }
    this._selChanged(false);
  };

  // ---------- hit testing ----------
  G._colAt = function (x) {
    const rx = x - this.hdrW;
    return this.colAxis.indexAt(rx < this.fw() ? rx : rx + Math.round(this.sx));
  };
  G._rowAt = function (y) {
    const ry = y - this.hdrH;
    return this.rowAxis.indexAt(ry < this.fh() ? ry : ry + Math.round(this.sy));
  };
  G._hit = function (e, force) {
    const rc = this.scroller.getBoundingClientRect();
    const x = e.clientX - rc.left, y = e.clientY - rc.top;
    if (!force && (x >= this.scroller.clientWidth || y >= this.scroller.clientHeight || x < 0 || y < 0)) return null;
    const h = { x, y, zone: 'cell', r: 0, c: 0, edge: -1 };
    const inX = x < this.hdrW, inY = y < this.hdrH;
    if (inX && inY) { h.zone = 'corner'; return h; }
    if (inY) {
      h.zone = 'colhdr'; h.c = this._colAt(x);
      for (const c of [h.c, this._colAt(x - 4)]) {
        if (this.colAxis.size(c) <= 0) continue;
        const ox = c < this.fc ? 0 : Math.round(this.sx);
        const xr = Math.round(this.hdrW + this.colAxis.offset(c + 1) - ox);
        if (Math.abs(x - xr) <= 3 && xr > this.hdrW) { h.edge = c; break; }
      }
      return h;
    }
    if (inX) {
      h.zone = 'rowhdr'; h.r = this._rowAt(y);
      for (const r of [h.r, this._rowAt(y - 4)]) {
        if (this.rowAxis.size(r) <= 0) continue;
        const oy = r < this.fr ? 0 : Math.round(this.sy);
        const yb = Math.round(this.hdrH + this.rowAxis.offset(r + 1) - oy);
        if (Math.abs(y - yb) <= 3 && yb > this.hdrH) { h.edge = r; break; }
      }
      return h;
    }
    h.r = this._rowAt(y); h.c = this._colAt(x);
    if (this.handle && !this.readOnly && Math.abs(x - this.handle.x) <= 5 && Math.abs(y - this.handle.y) <= 5) h.zone = 'handle';
    return h;
  };

  // ---------- mouse ----------
  G._onMouseDown = function (e) {
    if (e.button === 2) { this._ctxDown(e); return; }
    if (e.button !== 0) return;
    const h = this._hit(e);
    if (!h) return;
    if (this.edit_) this.commitEdit();
    this._closeMenu();
    this.focus();
    e.preventDefault();
    const mod = e.ctrlKey || e.metaKey, shift = e.shiftKey;
    if (h.zone === 'cell') {
      if (mod && !shift) { this.anchor = { r: h.r, c: h.c }; this.active = { r: h.r, c: h.c }; this.focusCell = { r: h.r, c: h.c }; this.ranges.push(this.mi.expand(h.r, h.c, h.r, h.c)); }
      else if (shift) this._setFocus(h.r, h.c, false);
      else { this.anchor = { r: h.r, c: h.c }; this.active = { r: h.r, c: h.c }; this.focusCell = { r: h.r, c: h.c }; this.ranges = [this.mi.expand(h.r, h.c, h.r, h.c)]; this._snapActive(); }
      this._selChanged(false);
      this.drag = { type: 'cell', add: mod && !shift, x0: e.clientX, y0: e.clientY, r0: h.r, c0: h.c, shift };
    } else if (h.zone === 'handle') {
      this.drag = { type: 'fill', src: Object.assign({}, this.ranges[this.ranges.length - 1]) };
    } else if (h.zone === 'colhdr') {
      if (h.edge >= 0) {
        this.drag = { type: 'rcol', c: h.edge, x0: h.x, w0: this.colAxis.size(h.edge) / this.zoom, cols: this._colsToResize(h.edge) };
      } else {
        if (shift) this._selectCols(this.anchor.c, h.c, false, true);
        else { this._selectCols(h.c, h.c, mod); if (mod) this.anchor = { r: 0, c: h.c }; }
        this.drag = { type: 'cols', add: mod && !shift };
      }
    } else if (h.zone === 'rowhdr') {
      if (h.edge >= 0) this.drag = { type: 'rrow', r: h.edge, y0: h.y, h0: this.rowAxis.size(h.edge) / this.zoom, rows: this._rowsToResize(h.edge) };
      else {
        if (shift) this._selectRows(this.anchor.r, h.r, false, true);
        else { this._selectRows(h.r, h.r, mod); if (mod) this.anchor = { r: h.r, c: 0 }; }
        this.drag = { type: 'rows', add: mod && !shift };
      }
    } else if (h.zone === 'corner') {
      this._selectAll();
    }
    if (this.drag && !this._docMove) {
      this._docMove = ev => this._onDrag(ev); this._docUp = ev => this._onMouseUp(ev);
      const d = this.el.ownerDocument; d.addEventListener('mousemove', this._docMove); d.addEventListener('mouseup', this._docUp);
    }
    this._lastEv = e;
  };
  G._colsToResize = function (c) {
    const out = [c];
    for (const g of this.ranges) if (g.r1 === 0 && g.r2 >= this.nRows - 1 && c >= g.c1 && c <= g.c2) { out.length = 0; for (let i = g.c1; i <= Math.max(g.c1, Math.min(g.c2, this.provider.colCount - 1)); i++) if (this.colAxis.size(i) > 0) out.push(i); if (!out.length || !out.includes(c)) out.push(c); break; }
    return out;
  };
  G._rowsToResize = function (r) {
    const out = [r];
    for (const g of this.ranges) if (g.c1 === 0 && g.c2 >= this.nCols - 1 && r >= g.r1 && r <= g.r2 && Math.min(g.r2, this.viewCount - 1) - g.r1 < 5000) { out.length = 0; for (let i = g.r1; i <= Math.max(g.r1, Math.min(g.r2, this.viewCount - 1)); i++) if (this.rowAxis.size(i) > 0) out.push(i); if (!out.includes(r)) out.push(r); break; }
    return out;
  };
  G._onDrag = function (e) {
    const d = this.drag; if (!d) return;
    this._lastEv = e;
    const h = this._hit(e, true);
    if (d.type === 'cell' && !d.moved && (Math.abs(e.clientX - d.x0) > 3 || Math.abs(e.clientY - d.y0) > 3)) d.moved = true;
    if (d.type === 'rcol') {
      const w = Math.max(6, d.w0 + (h.x - d.x0) / this.zoom);
      d.w = w; this.guide = { x: h.x };
      for (const c of d.cols) this.colOv.set(c, w);
      this._resizeAxis(this.colAxis, d.cols, w); return;
    }
    if (d.type === 'rrow') {
      const hh = Math.max(4, d.h0 + (h.y - d.y0) / this.zoom);
      d.h = hh; this.guide = { y: h.y };
      if (this.nRows <= 50000 || this.rowAxis.mode !== 2) { for (const r of d.rows) this.rowOv.set(r, hh); this._resizeAxis(this.rowAxis, d.rows, hh); } else this._schedule();
      return;
    }
    // auto scroll
    const vw = this.scroller.clientWidth, vh = this.scroller.clientHeight;
    let dx = 0, dy = 0;
    if (d.type === 'cell' || d.type === 'fill' || d.type === 'cols' || d.type === 'rows') {
      if (d.type !== 'rows' && d.type !== 'cols' || true) {
        if (h.x > vw - 4 && d.type !== 'rows') dx = Math.min(60, (h.x - vw + 4) * 0.5 + 6); else if (h.x < this.hdrW + this._fwc && d.type !== 'rows' && this.sx > 0) dx = -Math.min(60, (this.hdrW + this._fwc - h.x) * 0.5 + 6);
        if (h.y > vh - 4 && d.type !== 'cols') dy = Math.min(80, (h.y - vh + 4) * 0.6 + 6); else if (h.y < this.hdrH + this._fhc && d.type !== 'cols' && this.sy > 0) dy = -Math.min(80, (this.hdrH + this._fhc - h.y) * 0.6 + 6);
      }
    }
    if (dx || dy) {
      if (!this._autoScroll) this._autoScroll = setInterval(() => { if (this._lastEv && this.drag) { this.setScroll({ top: this.sy + this._asDy, left: this.sx + this._asDx }); this._dragTo(this._lastEv); } }, 40);
      this._asDx = dx; this._asDy = dy;
    } else if (this._autoScroll) { clearInterval(this._autoScroll); this._autoScroll = 0; }
    this._dragTo(e);
  };
  G._dragTo = function (e) {
    const d = this.drag; if (!d) return;
    const h = this._hit(e, true);
    const x = clamp(h.x, this.hdrW + 1, this.cw - 1), y = clamp(h.y, this.hdrH + 1, this.ch - 1);
    const r = this._rowAt(h.zone === 'colhdr' || h.zone === 'corner' ? this.hdrH + 1 : y), c = this._colAt(h.zone === 'rowhdr' || h.zone === 'corner' ? this.hdrW + 1 : x);
    if (d.type === 'cell') { this._setFocus(r, c, false); this._selChanged(false); }
    else if (d.type === 'cols') { this._selectCols(this.anchor.c, this._colAt(clamp(h.x, this.hdrW + 1, this.cw - 1)), d.add, true, true); }
    else if (d.type === 'rows') this._selectRows(this.anchor.r, this._rowAt(clamp(h.y, this.hdrH + 1, this.ch - 1)), d.add, true, true);
    else if (d.type === 'fill') {
      const s = d.src; let pv = null;
      const dr = r > s.r2 ? r - s.r2 : r < s.r1 ? r - s.r1 : 0, dc = c > s.c2 ? c - s.c2 : c < s.c1 ? c - s.c1 : 0;
      if (Math.abs(dr) >= Math.abs(dc) && dr) pv = dr > 0 ? { r1: s.r1, c1: s.c1, r2: r, c2: s.c2 } : { r1: r, c1: s.c1, r2: s.r2, c2: s.c2 };
      else if (dc) pv = dc > 0 ? { r1: s.r1, c1: s.c1, r2: s.r2, c2: c } : { r1: s.r1, c1: c, r2: s.r2, c2: s.c2 };
      d.target = pv ? { dir: Math.abs(dr) >= Math.abs(dc) && dr ? (dr > 0 ? 'down' : 'up') : dc > 0 ? 'right' : 'left', r, c } : null;
      this.fillPreview = pv; this._schedule();
    }
  };
  // set explicit sizes for items without calling back into the provider (O(changed) / one prefix pass)
  G._resizeAxis = function (axis, items, size) {
    const m = new Map();
    for (const i of items) m.set(i, size);
    axis.setSizes(m);
    const sx = this.sx, sy = this.sy;
    this._applySize(); this.sx = clamp(sx, 0, this.maxX); this.sy = clamp(sy, 0, this.maxY); this._pushScroll(); this._schedule();
  };
  G._relayoutKeep = function (opts) {
    const sx = this.sx, sy = this.sy;
    this._layout(opts); this._applySize(); this.sx = clamp(sx, 0, this.maxX); this.sy = clamp(sy, 0, this.maxY); this._pushScroll(); this._schedule();
  };
  G._onMouseUp = function (e) {
    const d = this.drag; this.drag = null;
    const doc = this.el.ownerDocument;
    if (this._docMove) { doc.removeEventListener('mousemove', this._docMove); doc.removeEventListener('mouseup', this._docUp); this._docMove = this._docUp = null; }
    if (this._autoScroll) { clearInterval(this._autoScroll); this._autoScroll = 0; }
    this.guide = null; this.fillPreview = null;
    if (this._dragSelEmitted) { this._dragSelEmitted = false; const sel = this.getSelection(); sel.dragging = false; sel.final = true; this.emit('select', sel); }
    if (!d) return;
    if (d.type === 'rcol' && d.w != null) {
      for (const c of d.cols) this.emit('resizeCol', { c, width: d.w });
    } else if (d.type === 'rrow' && d.h != null) {
      for (const r of d.rows) this.rowOv.set(r, d.h);
      this._resizeAxis(this.rowAxis, d.rows, d.h);
      for (const r of d.rows) this.emit('resizeRow', { r: this.view.toSource(r), height: d.h });
    } else if (d.type === 'fill' && d.target) {
      this._doFillDrag(d);
    } else if (d.type === 'cell' && !d.moved) {
      const h = this._hit(e, true);
      if (h && h.zone === 'cell' && !d.shift && h.r === d.r0 && h.c === d.c0 && !this._dead) this._emitLink(h.r, h.c);
    }
    this._schedule();
  };
  G._emitLink = function (r, c) {
    const m = this.mi.at(r, c); if (m) { r = m.r1; c = m.c1; }
    const cv = this._cellAt(r, c); if (!cv || !cv.link) return;
    const sr = this.view.toSource(r), p = this.provider, pl = { r, c, sr };
    if (p.getLink) { const l = p.getLink(sr, c); if (l) { if (l.url) pl.url = l.url; if (l.location) pl.location = l.location; if (l.tooltip) pl.tooltip = l.tooltip; } }
    this.emit('link', pl);
  };
  G._onHover = function (e) {
    if (this.drag) return;
    const h = this._hit(e);
    let cur = '';
    if (h) {
      if (h.zone === 'colhdr' && h.edge >= 0) cur = 'col-resize';
      else if (h.zone === 'rowhdr' && h.edge >= 0) cur = 'row-resize';
      else if (h.zone === 'handle') cur = 'crosshair';
      else if (h.zone === 'colhdr' || h.zone === 'rowhdr' || h.zone === 'corner') cur = 'default';
      else { const cv = h.zone === 'cell' && this._cellAt(h.r, h.c); cur = cv && cv.link ? 'pointer' : 'cell'; }
    }
    if (cur !== this._cur) { this._cur = cur; this.scroller.style.cursor = cur; }
  };
  G._onDblClick = function (e) {
    const h = this._hit(e);
    if (!h) return;
    if (h.zone === 'colhdr' && h.edge >= 0) { this.autosizeColumn(h.edge); return; }
    if (h.zone === 'cell' && !this.readOnly) this.startEdit(h.r, h.c, null);
  };
  G._onWheel = function (e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
      this._zoomTo = (this._zoomTo || this.zoom) * f;
      if (!this._zoomT) this._zoomT = rafOf(() => { this._zoomT = 0; const z = this._zoomTo; this._zoomTo = 0; if (!this._dead && z) this.setZoom(z); });
    }
  };

  // ---------- keyboard ----------
  G._isEmptyAt = function (r, c) { const cv = this._cellAt(r, c); return !cv || !cv.text; };
  G._visible = function (axis, i, d) { return axis.size(i) > 0 ? i : (axis.nextVisible(i, d) >= 0 ? axis.nextVisible(i, d) : i); };
  G._growPad = function (r, c) {
    let ch = false;
    const oR = this.nRows, oC = this.nCols;
    if (r >= this.nRows - 2) { this.extraRows += 50; ch = true; }
    if (c >= this.nCols - 2) { this.extraCols += 10; ch = true; }
    if (ch) {
      this._relayoutKeep({ keepSizes: true });
      for (const g of this.ranges) {
        if (g.r1 === 0 && g.r2 === oR - 1) g.r2 = this.nRows - 1;
        if (g.c1 === 0 && g.c2 === oC - 1) g.c2 = this.nCols - 1;
      }
    }
  };
  G._moveTarget = function (base, dr, dc, ctrl) {
    let r = base.r, c = base.c;
    if (ctrl) {
      const t = C.dataEdge((rr, cc) => this._isEmptyAt(rr, cc), r, c, dr, dc, this.nRows - 1, this.nCols - 1);
      r = dr ? this._visible(this.rowAxis, t.r, -dr) : r; c = dc ? this._visible(this.colAxis, t.c, -dc) : c;
      return { r, c };
    }
    const m = this.mi.at(r, c);
    if (dr) { const from = dr > 0 ? (m ? m.r2 : r) : (m ? m.r1 : r); const n = this.rowAxis.nextVisible(from, dr); r = n >= 0 ? n : from; if (dr > 0) this._growPad(r, c); }
    if (dc) { const from = dc > 0 ? (m ? m.c2 : c) : (m ? m.c1 : c); const n = this.colAxis.nextVisible(from, dc); c = n >= 0 ? n : from; if (dc > 0) this._growPad(r, c); }
    return { r, c };
  };
  G._go = function (t, shift, o) {
    if (shift) { this._setFocus(t.r, t.c, false); }
    else {
      const m = this.mi.at(t.r, t.c);
      const a = m ? { r: m.r1, c: m.c1 } : t;
      this.active = { r: a.r, c: a.c }; this.anchor = { r: a.r, c: a.c }; this.focusCell = { r: a.r, c: a.c };
      this.ranges = [this.mi.expand(a.r, a.c, a.r, a.c)];
    }
    this._selChanged(!(o && o.noReveal));
    if (o && o.snap) {
      let ch = false;
      if (o.snap === 2 || t.r < this.fr) { if (this.sy) { this.sy = 0; ch = true; } }
      if (o.snap === 2 || t.c < this.fc) { if (this.sx) { this.sx = 0; ch = true; } }
      if (ch) { this._pushScroll(); this._schedule(); if (this.edit_) this._placeEditor(); }
    }
  };
  G._stepInSelection = function (dr, dc) {
    const rg = this.ranges[this.ranges.length - 1];
    const multi = rg.r1 !== rg.r2 || rg.c1 !== rg.c2;
    const m = this.mi.at(rg.r1, rg.c1);
    const isMerge = m && m.r1 === rg.r1 && m.c1 === rg.c1 && m.r2 === rg.r2 && m.c2 === rg.c2;
    if (!multi || isMerge) { this._go(this._moveTarget(this.active, dr, dc, false), false); return; }
    let { r, c } = this.active;
    const nextIn = (axis, i, d, lo, hi) => { let n = i + d; while (n >= lo && n <= hi && axis.size(n) <= 0) n += d; return n >= lo && n <= hi ? n : -1; };
    const first = (axis, lo, hi) => nextIn(axis, lo - 1, 1, lo, hi), last = (axis, lo, hi) => nextIn(axis, hi + 1, -1, lo, hi);
    if (dc) {
      let n = nextIn(this.colAxis, c, dc, rg.c1, rg.c2);
      if (n < 0) {
        const nr = nextIn(this.rowAxis, r, dc, rg.r1, rg.r2);
        r = nr >= 0 ? nr : (dc > 0 ? first(this.rowAxis, rg.r1, rg.r2) : last(this.rowAxis, rg.r1, rg.r2));
        n = dc > 0 ? first(this.colAxis, rg.c1, rg.c2) : last(this.colAxis, rg.c1, rg.c2);
      }
      c = n;
    } else {
      let n = nextIn(this.rowAxis, r, dr, rg.r1, rg.r2);
      if (n < 0) {
        const nc = nextIn(this.colAxis, c, dr, rg.c1, rg.c2);
        c = nc >= 0 ? nc : (dr > 0 ? first(this.colAxis, rg.c1, rg.c2) : last(this.colAxis, rg.c1, rg.c2));
        n = dr > 0 ? first(this.rowAxis, rg.r1, rg.r2) : last(this.rowAxis, rg.r1, rg.r2);
      }
      r = n;
    }
    if (r >= 0 && c >= 0) { this.active = { r, c }; this._selChanged(false); this._reveal(r, c); }
  };
  G._ours = function (e) { const t = e.target; return t === this.el || t === this.scroller || t === this.canvas; };
  G._onKeyDown = function (e) {
    if (this.edit_ || !this._ours(e)) return;
    const key = e.key || '', shift = e.shiftKey, alt = e.altKey;
    const single = key.length === 1 || [...key].length === 1;
    const altgr = (e.ctrlKey && alt && !e.metaKey && single) || (e.getModifierState && e.getModifierState('AltGraph') && single);
    const mod = !altgr && (e.ctrlKey || e.metaKey);
    if (e.isComposing || e.keyCode === 229) { if (!this.readOnly && !mod) this.startEdit(this.active.r, this.active.c, ''); return; }
    const prevent = () => { e.preventDefault(); };
    const nav = (dr, dc) => { prevent(); const base = shift ? this.focusCell : this.active; this._go(this._moveTarget(base, dr, dc, mod), shift, mod ? { snap: 1 } : null); };
    switch (key) {
      case 'ArrowUp': return nav(-1, 0);
      case 'ArrowDown': return nav(1, 0);
      case 'ArrowLeft': return nav(0, -1);
      case 'ArrowRight': return nav(0, 1);
      case 'Home': prevent(); return this._go(mod ? { r: this._visible(this.rowAxis, 0, 1), c: this._visible(this.colAxis, 0, 1) } : { r: (shift ? this.focusCell : this.active).r, c: this._visible(this.colAxis, 0, 1) }, shift, { snap: mod ? 2 : 1 });
      case 'End': {
        prevent();
        const lc = Math.max(0, this.provider.colCount - 1), lr = Math.max(0, this.viewCount - 1);
        return this._go(mod ? { r: lr, c: lc } : { r: (shift ? this.focusCell : this.active).r, c: lc }, shift);
      }
      case 'PageDown': case 'PageUp': {
        prevent();
        const d = key === 'PageDown' ? 1 : -1, base = shift ? this.focusCell : this.active;
        const dy = (this._viewH() - this.fh()) * d;
        const tr = clamp(this.rowAxis.indexAt(this.rowAxis.offset(base.r) + dy), 0, this.nRows - 1);
        if (d > 0) this._growPad(tr, base.c);
        const ny = this.sy + (this.rowAxis.offset(tr) - this.rowAxis.offset(base.r));
        this._go({ r: tr, c: base.c }, shift, { noReveal: true });
        this.setScroll({ top: ny });
        this._reveal(tr, base.c);
        return;
      }
      case 'Enter': prevent(); return this._stepInSelection(shift ? -1 : 1, 0);
      case 'Tab': prevent(); return this._stepInSelection(0, shift ? -1 : 1);
      case 'F2': if (!this.readOnly) { prevent(); this.startEdit(this.active.r, this.active.c, null); } return;
      case 'Delete': case 'Backspace': if (!this.readOnly) { prevent(); this.clearSelection(); } return;
      case 'Escape': if (this._copyJob) { this.cancelCopy(); return; } if (this.ranges.length > 1) { this.ranges = [this.ranges[this.ranges.length - 1]]; this._selChanged(false); } return;
      case ' ':
        if (mod) { prevent(); this._selectCols(this.active.c, this.active.c, false, true); return; }
        if (shift) { prevent(); this._selectRows(this.active.r, this.active.r, false, true); return; }
        break;
    }
    if (mod) {
      const k = key.toLowerCase();
      if (k === 'a') { prevent(); return this._selectAll(); }
      if (k === 'c') { prevent(); return this.copy(false); }
      if (k === 'x') { prevent(); return this.copy(true); }
      if (k === 'v') { this._pasteWait(); return; }
      if (k === 'd' && !this.readOnly) { prevent(); return this.fillDownRight('down'); }
      if (k === 'r' && !this.readOnly) { prevent(); return this.fillDownRight('right'); }
      if (k === 'z') { prevent(); return this.emit(shift ? 'redo' : 'undo'); }
      if (k === 'y') { prevent(); return this.emit('redo'); }
      if (k === 'f') { prevent(); return this.emit('findrequest'); }
      if (k === 'g') { prevent(); return this.emit('gotorequest'); }
      return;
    }
    if (!this.readOnly && !mod && single) { prevent(); this.startEdit(this.active.r, this.active.c, key, 'enter'); }
  };

  // ---------- editing ----------
  G._ensureEditor = function () {
    if (!this.editor) {
      const ed = this.editor = this.el.ownerDocument.createElement('textarea');
      ed.className = 'oxg-editor'; ed.spellcheck = false; ed.rows = 1; ed.setAttribute('autocomplete', 'off'); ed.setAttribute('aria-label', 'Cell editor');
      this.el.appendChild(ed);
      ed.addEventListener('keydown', e => this._onEditorKey(e));
      ed.addEventListener('input', () => this._placeEditor());
      ed.addEventListener('compositionstart', () => { this._composing = true; });
      ed.addEventListener('compositionend', () => { this._composing = false; this._placeEditor(); });
      ed.addEventListener('blur', () => { if (this.edit_ && !this._dead) this.commitEdit(); });
      ed.addEventListener('mousedown', e => e.stopPropagation());
    }
    return this.editor;
  };
  G.startEdit = function (r, c, initial) {
    if (this.readOnly || this._dead) return;
    this._cancelEdit(true);
    r = clamp(r, 0, this.nRows - 1); c = clamp(c, 0, this.nCols - 1);
    const m = this.mi.at(r, c); if (m) { r = m.r1; c = m.c1; }
    if (this.active.r !== r || this.active.c !== c || this.ranges.length !== 1) this._go({ r, c }, false);
    this._reveal(r, c);
    const sr = this.view.toSource(r);
    const raw = r < this.viewCount && c < this.provider.colCount ? (this.provider.getRaw(sr, c) || '') : '';
    const mode = initial != null ? (arguments[3] || 'enter') : 'edit';
    this.edit_ = { r, c, sr, orig: raw, mode };
    const ed = this._ensureEditor(), T = this.theme;
    const cv = this._cellAt(r, c), st = cv && cv.style, se = st ? this._style(st) : this._defStyle();
    this._styleEditor();
    ed.value = initial != null ? initial : raw;
    ed.style.display = 'block';
    this._placeEditor();
    ed.focus({ preventScroll: true });
    const n = ed.value.length; ed.setSelectionRange(n, n);
  };
  G._styleEditor = function () {
    const e = this.edit_; if (!e) return;
    const ed = this.editor, T = this.theme, cv = this._cellAt(e.r, e.c), st = cv && cv.style, se = st ? this._style(st) : this._defStyle();
    ed.style.font = se.font; ed.style.lineHeight = se.lh + 'px'; ed.style.color = se.color;
    ed.style.background = (st && st.bg) || T.bg; ed.style.textAlign = st && (st.h === 'right' || st.h === 'center') ? st.h : (cv && (cv.kind === 'number' || cv.kind === 'date') && (!st || st.h === 'general') ? 'right' : 'left');
  };
  G._placeEditor = function () {
    const e = this.edit_; if (!e) return;
    const ed = this.editor, rc = this.cellRect(e.r, e.c);
    const font = ed.style.font, lines = ed.value.split('\n');
    let mw = 0; for (const l of lines) mw = Math.max(mw, this._measure(font, l));
    const maxW = Math.max(rc.w, this.cw - rc.x - 4);
    const w = clamp(mw + 6 + 4 + 8, rc.w + 2, maxW);
    ed.classList.toggle('wrap', mw + 18 > maxW);
    ed.style.left = (rc.x - 1) + 'px'; ed.style.top = (rc.y - 1) + 'px'; ed.style.width = w + 'px'; ed.style.height = (rc.h + 2) + 'px';
    const need = ed.scrollHeight + 4;
    if (need > rc.h + 2) ed.style.height = Math.min(need, Math.max(rc.h + 2, this.ch - rc.y - 4)) + 'px';
    // keep the overlay out of the headers / hide when scrolled out of view
    const L = Math.max(0, this.hdrW - (rc.x - 1)), Tp = Math.max(0, this.hdrH - (rc.y - 1));
    ed.style.clipPath = L || Tp ? 'inset(' + Tp + 'px 0 0 ' + L + 'px)' : '';
    ed.style.visibility = rc.x + rc.w < this.hdrW || rc.y + rc.h < this.hdrH || rc.x > this.cw || rc.y > this.ch ? 'hidden' : '';
  };
  G._onEditorKey = function (e) {
    if (e.isComposing || e.keyCode === 229) return;
    const ed = this.editor, ed_ = this.edit_; if (!ed_) return;
    const k = e.key;
    if (k === 'Enter') {
      e.preventDefault();
      if (e.altKey) { const s = ed.selectionStart; ed.value = ed.value.slice(0, s) + '\n' + ed.value.slice(ed.selectionEnd); ed.setSelectionRange(s + 1, s + 1); this._placeEditor(); }
      else if (e.ctrlKey || e.metaKey) this.commitEdit();
      else this.commitEdit({ dr: e.shiftKey ? -1 : 1, dc: 0 });
    } else if (k === 'Tab') { e.preventDefault(); this.commitEdit({ dr: 0, dc: e.shiftKey ? -1 : 1 }); }
    else if (k === 'Escape') { e.preventDefault(); this._cancelEdit(); }
    else if (ed_.mode === 'enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && k.startsWith('Arrow')) {
      e.preventDefault();
      this.commitEdit({ dr: k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0, dc: k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0, arrow: true });
    } else if (k === 'F2') { e.preventDefault(); ed_.mode = ed_.mode === 'enter' ? 'edit' : 'enter'; }
    e.stopPropagation();
  };
  G.commitEdit = function (mv) {
    const e = this.edit_; if (!e) return;
    this.edit_ = null;
    const text = this.editor.value;
    this.editor.style.display = 'none';
    this.focus();
    if (text !== e.orig) this.emit('edit', { edits: [{ r: e.sr, c: e.c, text }], source: 'type' });
    if (mv) { if (mv.arrow) this._go(this._moveTarget(this.active, mv.dr, mv.dc, false), false); else this._stepInSelection(mv.dr, mv.dc); }
    this._schedule();
  };
  G._cancelEdit = function (silent) {
    if (!this.edit_) return;
    this.edit_ = null;
    if (this.editor) this.editor.style.display = 'none';
    if (!silent && !this._dead) this.focus();
    this._schedule();
  };

  // ---------- data helpers ----------
  G._dataRect = function (rg) {
    const r2 = Math.min(rg.r2, this.viewCount - 1), c2 = Math.min(rg.c2, this.provider.colCount - 1);
    if (r2 < rg.r1 || c2 < rg.c1) return null;
    return { r1: rg.r1, c1: rg.c1, r2, c2 };
  };
  const MAX_COPY_CELLS = 5e6;
  // text = full raw cell text (formula cells: their value); hidden rows/cols skipped
  G._grab = function (rg) {
    const d = this._dataRect(rg), p = this.provider;
    if (!d) return { rows: [['']], raws: [['']], rect: { r1: rg.r1, c1: rg.c1, r2: rg.r1, c2: rg.c1 }, rowIdx: [rg.r1], colIdx: [rg.c1] };
    const rows = [], raws = [], rowIdx = [], colIdx = [], ra = this.rowAxis, ca = this.colAxis;
    for (let c = d.c1; c <= d.c2; c++) if (ca.size(c) > 0) colIdx.push(c);
    for (let r = d.r1; r <= d.r2; r++) {
      if (ra.size(r) <= 0) continue;
      const sr = this.view.toSource(r), tr = new Array(colIdx.length), rr = new Array(colIdx.length);
      for (let k = 0; k < colIdx.length; k++) {
        const c = colIdx[k], raw = p.getRaw(sr, c) || '';
        let t = raw;
        if (raw.charCodeAt(0) === 61) { const cv = p.getCell(sr, c); if (cv && cv.text != null) t = cv.text; }
        tr[k] = t; rr[k] = raw;
      }
      rows.push(tr); raws.push(rr); rowIdx.push(r);
    }
    if (!rows.length) { rows.push(['']); raws.push(['']); rowIdx.push(d.r1); colIdx.length || colIdx.push(d.c1); }
    return { rows, raws, rect: d, rowIdx, colIdx };
  };
  G._copyRange = function () { return this.ranges[this.ranges.length - 1]; };
  G._tooLarge = function (rg) {
    const d = this._dataRect(rg); if (!d) return false;
    const cells = (d.r2 - d.r1 + 1) * (d.c2 - d.c1 + 1);
    if (cells > MAX_COPY_CELLS) { this.emit('copyTooLarge', { cells, limit: MAX_COPY_CELLS }); return true; }
    return false;
  };
  G.clearSelection = function () {
    if (this.readOnly) return;
    const edits = [], p = this.provider;
    for (const rg of this.ranges) {
      const d = this._dataRect(rg); if (!d) continue;
      for (let r = d.r1; r <= d.r2; r++) { const sr = this.view.toSource(r); for (let c = d.c1; c <= d.c2; c++) if (p.getRaw(sr, c)) edits.push({ r: sr, c, text: '' }); }
    }
    if (edits.length) this.emit('edit', { edits, source: 'clear' });
    this._schedule();
  };

  // ---------- clipboard ----------
  // Streaming copy: the TSV is built in time slices (bounded by maxCopyChars); small ranges finish synchronously inside the user gesture.
  G.copy = function (cut) {
    this.cancelCopy();
    const rg = this._copyRange(), p = this.provider, ra = this.rowAxis, ca = this.colAxis, toS = this.view.toSource;
    const d = this._dataRect(rg);
    const colIdx = [];
    if (d) for (let c = d.c1; c <= d.c2; c++) if (ca.size(c) > 0) colIdx.push(c);
    const nrows = d ? d.r2 - d.r1 + 1 : 0, ncols = colIdx.length, cells = nrows * ncols;
    const doCut = !!cut && !this.readOnly;
    const job = { cut: !!cut, cells, raws: cells <= 100000 ? [] : null, edits: doCut ? [] : null, r0: -1, c0: ncols ? colIdx[0] : -1, async: false, lastEmit: 0, b: null, slicer: null };
    const now = () => (root.performance || Date).now();
    job.b = new C.TsvBuilder({
      rowCount: nrows, maxChars: this.maxCopyChars,
      getRow: i => {
        const r = d.r1 + i;
        if (ra.size(r) <= 0) return null;
        const sr = toS(r), rr = job.raws ? new Array(ncols) : null;
        if (job.r0 < 0) job.r0 = r;
        let line = '';
        for (let k = 0; k < ncols; k++) {
          const c = colIdx[k], raw = p.getRaw(sr, c) || '';
          let t = raw;
          if (raw.charCodeAt(0) === 61) { const cv = p.getCell(sr, c); if (cv && cv.text != null) t = cv.text; }
          if (rr) rr[k] = raw;
          if (job.edits && raw) job.edits.push({ r: sr, c, text: '' });
          if (k) line += '\t';
          line += t === '' ? t : C.tsvField(t);
        }
        if (rr) job.raws.push(rr);
        return line;
      }
    });
    job.slicer = C.createSlicer(deadline => {
      const done = job.b.step(deadline, now);
      if (!done && this._copyJob === job) { job.async = true; this._copyProgress(job, false); }
      return done;
    }, { budget: 10, now, onDone: () => this._finishCopy(job) });
    this._copyJob = job;
    job.slicer.start(true);
  };
  G._copyProgress = function (job, done, extra) {
    const t = (root.performance || Date).now();
    if (!done && t - job.lastEmit < 100) return;
    job.lastEmit = t;
    this.emit('copyProgress', Object.assign({ rows: job.b.i, total: job.b.n, chars: job.b.chars, cells: job.cells, cut: job.cut, done }, extra));
  };
  G.cancelCopy = function () {
    const j = this._copyJob;
    if (!j) return;
    j.slicer.cancel(); this._copyJob = null;
    if (j.async) this._copyProgress(j, true, { cancelled: true });
  };
  G._finishCopy = function (job) {
    if (this._copyJob !== job) return;
    this._copyJob = null;
    const b = job.b;
    if (b.tooLarge) {
      this.emit('copyTooLarge', { cells: job.cells, limit: this.maxCopyChars, chars: Math.round(b.projected), unit: 'chars' });
      if (job.async) this._copyProgress(job, true, { tooLarge: true });
      return;
    }
    const text = b.text();
    this._clip = { text, raws: job.raws, r: job.r0 < 0 ? this.ranges[this.ranges.length - 1].r1 : job.r0, c: job.c0 < 0 ? this.ranges[this.ranges.length - 1].c1 : job.c0 };
    if (job.async) { this._writeClipboard(text); this._copyProgress(job, true, { finished: true }); }
    else {
      this._pendingCopy = text; this._copyHandled = false;
      const doc = this.el.ownerDocument;
      if (doc.activeElement === this.el) { try { doc.execCommand('copy'); } catch (e) { /* fall through */ } }
      this._pendingCopy = null;
      if (!this._copyHandled) this._writeClipboard(text);
    }
    this.emit('copy', { text, cut: job.cut });
    if (job.cut && !this.readOnly) {
      if (job.edits && job.edits.length) this.emit('edit', { edits: job.edits, source: 'cut' });
      this._schedule();
    }
  };
  G._writeClipboard = function (text) {
    const nav = root.navigator, doc = this.el.ownerDocument;
    const fb = () => {
      const ta = doc.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      doc.body.appendChild(ta); ta.select(); try { doc.execCommand('copy'); } catch (e) { /* ignore */ } ta.remove(); this.focus();
    };
    if (nav && nav.clipboard && nav.clipboard.writeText) nav.clipboard.writeText(text).catch(fb); else fb();
  };
  G._onCopyEvt = function (e, cut) {
    if (this.edit_ || !this._ours(e)) return;
    let text = this._pendingCopy;
    if (text == null) { this.copy(cut); if (this._copyJob) e.preventDefault(); return; }
    if (e.clipboardData) { e.clipboardData.setData('text/plain', text); e.preventDefault(); this._copyHandled = true; }
  };
  G._pasteWait = function () {
    if (this.readOnly) return;
    this._pasteGot = false;
    setTimeout(() => {
      if (this._pasteGot || this._dead) return;
      const nav = root.navigator;
      if (nav && nav.clipboard && nav.clipboard.readText) nav.clipboard.readText().then(t => { if (!this._pasteGot) this.pasteText(t); }).catch(() => {});
    }, 120);
  };
  G._onPasteEvt = function (e) {
    if (this.edit_ || !this._ours(e)) return;
    this._pasteGot = true;
    e.preventDefault();
    const t = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (t) this.pasteText(t);
  };
  G.pasteText = function (text) {
    if (this.readOnly || text == null) return;
    const rows = C.decodeClipboard(text);
    const internal = this._clip && this._clip.raws && this._clip.text === text ? this._clip : null;
    const h = rows.length; let w = 0; for (const r of rows) w = Math.max(w, r.length);
    const rg = this.ranges[this.ranges.length - 1];
    const edits = [];
    const val = (i, j, r, c) => {
      if (internal) { const raw = (internal.raws[i] || [])[j] || ''; return raw.charCodeAt(0) === 61 && this.provider.literalText !== true ? C.shiftFormula(raw, r - (internal.r + i), c - (internal.c + j)) : raw; }
      const row = rows[i]; return row && row[j] != null ? row[j] : '';
    };
    let sel;
    const multi = rg.r1 !== rg.r2 || rg.c1 !== rg.c2;
    if (h === 1 && w === 1 && multi && !(this.mi.at(rg.r1, rg.c1) && this.mi.at(rg.r1, rg.c1).r2 === rg.r2 && this.mi.at(rg.r1, rg.c1).c2 === rg.c2)) {
      const d = this._dataRect(rg) || { r1: rg.r1, c1: rg.c1, r2: rg.r1, c2: rg.c1 };
      for (let r = d.r1; r <= d.r2; r++) for (let c = d.c1; c <= d.c2; c++) edits.push({ r: this.view.toSource(r), c, text: val(0, 0, r, c) });
      sel = d;
    } else {
      const ar = multi ? rg.r1 : this.active.r, ac = multi ? rg.c1 : this.active.c;
      for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) { const r = ar + i, c = ac + j; edits.push({ r: this.view.toSource(r), c, text: val(i, j, r, c) }); }
      sel = { r1: ar, c1: ac, r2: ar + h - 1, c2: ac + w - 1 };
    }
    if (!edits.length) return;
    this.emit('edit', { edits, source: 'paste' });
    this._growPad(sel.r2, sel.c2);
    this.anchor = { r: sel.r1, c: sel.c1 }; this.active = { r: sel.r1, c: sel.c1 }; this.focusCell = { r: sel.r2, c: sel.c2 };
    this.ranges = [sel]; this._clampSel(); this._selChanged();
  };

  // ---------- fill ----------
  G._fillEdits = function (src, dir, end, series) {
    const p = this.provider, edits = [], vert = dir === 'down' || dir === 'up';
    const lo = vert ? src.r1 : src.c1, hi = vert ? src.r2 : src.c2, n = hi - lo + 1;
    const cross1 = vert ? src.c1 : src.r1, cross2 = vert ? src.c2 : src.r2;
    const fwd = dir === 'down' || dir === 'right';
    const count = fwd ? end - hi : lo - end;
    for (let x = cross1; x <= cross2; x++) {
      const raws = [];
      for (let i = lo; i <= hi; i++) raws.push(vert ? p.getRaw(this.view.toSource(i), x) || '' : p.getRaw(this.view.toSource(x), i) || '');
      const ser = series && n >= 2 ? C.fillSeries(raws) : null;
      for (let k = 0; k < count; k++) {
        const pos = fwd ? n + k : -(k + 1);
        const t = fwd ? hi + 1 + k : lo - 1 - k;
        const idx = ((pos % n) + n) % n;
        let v = raws[idx];
        if (ser) v = C.fmtNum(ser.start + ser.step * pos);
        else if (v.charCodeAt(0) === 61 && p.literalText !== true) v = vert ? C.shiftFormula(v, t - (lo + idx), 0) : C.shiftFormula(v, 0, t - (lo + idx));
        edits.push({ r: this.view.toSource(vert ? t : x), c: vert ? x : t, text: v });
      }
    }
    return edits;
  };
  G._doFillDrag = function (d) {
    const s = this._dataRect(d.src); if (!s) return;
    const t = d.target; let end;
    const dir = t.dir;
    end = dir === 'down' || dir === 'up' ? t.r : t.c;
    const edits = this._fillEdits(s, dir, end, true);
    if (!edits.length) return;
    this.emit('edit', { edits, source: 'fill' });
    const sel = dir === 'down' ? { r1: s.r1, c1: s.c1, r2: end, c2: s.c2 } : dir === 'up' ? { r1: end, c1: s.c1, r2: s.r2, c2: s.c2 } : dir === 'right' ? { r1: s.r1, c1: s.c1, r2: s.r2, c2: end } : { r1: s.r1, c1: end, r2: s.r2, c2: s.c2 };
    this.ranges = [sel]; this.anchor = { r: sel.r1, c: sel.c1 }; this.focusCell = { r: sel.r2, c: sel.c2 };
    this._selChanged(false);
  };
  G.fillDownRight = function (dir) {
    if (this.readOnly) return;
    let edits = [];
    for (const rg of this.ranges) {
      const d = this._dataRect(rg) || rg;
      if (dir === 'down') {
        if (d.r1 === d.r2) { if (d.r1 > 0) edits = edits.concat(this._fillEdits({ r1: d.r1 - 1, r2: d.r1 - 1, c1: d.c1, c2: d.c2 }, 'down', d.r1, false)); }
        else edits = edits.concat(this._fillEdits({ r1: d.r1, r2: d.r1, c1: d.c1, c2: d.c2 }, 'down', d.r2, false));
      } else {
        if (d.c1 === d.c2) { if (d.c1 > 0) edits = edits.concat(this._fillEdits({ r1: d.r1, r2: d.r2, c1: d.c1 - 1, c2: d.c1 - 1 }, 'right', d.c1, false)); }
        else edits = edits.concat(this._fillEdits({ r1: d.r1, r2: d.r2, c1: d.c1, c2: d.c1 }, 'right', d.c2, false));
      }
    }
    if (edits.length) this.emit('edit', { edits, source: 'fill' });
    this._schedule();
  };

  // ---------- find ----------
  // Incremental, time-sliced: find() scans one slice synchronously (so small sheets return a final result) and continues in the background.
  // 'find' events: {count, index, done, truncated}. A new query / clearFind() cancels the running scan.
  const keyAt = (f, i) => (i < f.B.n ? f.B.a[i] : f.A.a[i - f.B.n]);
  const fCount = f => f.A.n + f.B.n;
  const rankOf = (f, key) => { const i = C.lowerBound(f.B, key); return i < f.B.n ? i : f.B.n + C.lowerBound(f.A, key); };
  G._cancelFindJob = function () {
    if (this._findJob) { this._findJob.cancel(); this._findJob = null; }
    this._findPending = null;
    clearTimeout(this._findT);
  };
  G._searchFns = function () {
    const p = this.provider, toS = this.view.toSource;
    if (p.searchText) return { get: (vr, c) => p.searchText(toS(vr), c), get2: null };
    let lastKind = '';
    const get = (vr, c) => { const cv = p.getCell(toS(vr), c); if (!cv) { lastKind = ''; return undefined; } lastKind = cv.kind; return cv.text; };
    // text cells: also try the raw value (CSV display text is cut at the first line / 2000 chars)
    const get2 = (vr, c) => {
      if (lastKind !== 'text' || !p.getRaw) return undefined;
      const raw = p.getRaw(toS(vr), c);
      return raw && raw.charCodeAt(0) !== 61 ? raw : undefined;
    };
    return { get, get2 };
  };
  G._newFind = function (query, opts, startRow) {
    const fn = this._searchFns();
    const scan = new C.FindScan({ rowCount: this.viewCount, colCount: this.provider.colCount, getText: fn.get, getText2: fn.get2, match: C.makeMatcher(query, opts), startRow, maxMatches: opts && opts.maxMatches });
    return { query, opts: opts || {}, scan, A: scan.A, B: scan.B, curKey: -1, done: false, truncated: false, jumped: false, lastEmit: 0 };
  };
  G._runFind = function (f, silent, ak, prevKey) {
    const now = () => (root.performance || Date).now();
    const step = deadline => {
      const sc = f.scan;
      const done = sc.step(deadline, now);
      f.done = done; f.truncated = sc.truncated;
      if (!silent && !f.jumped && sc.count > 0) {
        let key = -1;
        const j = C.lowerBound(f.A, ak);
        if (j < f.A.n) key = f.A.a[j]; else if (sc.phase === 1 && f.B.n) key = f.B.a[0];
        if (key >= 0) { f.jumped = true; f.curKey = key; this._goKey(key); }
      }
      if (done && !f.jumped && sc.count > 0 && !silent) { f.jumped = true; f.curKey = keyAt(f, 0); this._goKey(f.curKey); }
      if (silent) {
        if (done) {
          this.find_ = f;
          if (prevKey >= 0 && fCount(f)) { const i = rankOf(f, prevKey); f.curKey = keyAt(f, Math.min(i, fCount(f) - 1)); }
          this._findPending = null; this._schedule(); this.emit('find', this._findState());
        }
      } else {
        this._schedule();
        const t = now();
        if (done || t - f.lastEmit >= 80) { f.lastEmit = t; if (this._findSyncDone) this.emit('find', this._findState()); }
      }
      return done;
    };
    this._findSyncDone = false;
    const job = C.createSlicer(step, { budget: this.findBudgetMs, now });
    this._findJob = job;
    if (!silent) this.find_ = f;
    else this._findPending = f;
    job.start(true);
    this._findSyncDone = true;
    return f;
  };
  G.find = function (query, opts) {
    opts = opts || {};
    this._cancelFindJob();
    this._findQ = { query, opts };
    if (!query) { this.find_ = null; this._schedule(); return { count: 0, index: 0, done: true, truncated: false }; }
    const f = this._newFind(query, opts, this.active.r);
    this._runFind(f, false, this.active.r * 65536 + this.active.c, -1);
    return this._findState();
  };
  G.cancelFind = function () { this._cancelFindJob(); if (this.find_ && !this.find_.done) { this.find_.done = true; this.find_.truncated = true; this.emit('find', this._findState()); } };
  G._findState = function () {
    const f = this.find_;
    if (!f) return { count: 0, index: 0, done: true, truncated: false };
    return { count: fCount(f), index: f.curKey >= 0 ? rankOf(f, f.curKey) + 1 : 0, done: f.done, truncated: f.truncated };
  };
  G._goKey = function (key) { const r = Math.floor(key / 65536); this._go({ r, c: key - r * 65536 }, false); };
  G.findNext = function () { return this._findStep(1); };
  G.findPrev = function () { return this._findStep(-1); };
  G._findStep = function (d) {
    const f = this.find_, n = f ? fCount(f) : 0;
    if (!n) return this._findState();
    let i;
    if (f.curKey < 0) i = d > 0 ? 0 : n - 1;
    else { const k = rankOf(f, f.curKey); i = (k + d + n) % n; }
    f.curKey = keyAt(f, i); f.jumped = true;
    this._goKey(f.curKey); this._schedule();
    return this._findState();
  };
  G.clearFind = function () { this._cancelFindJob(); this.find_ = null; this._findQ = null; this._schedule(); };
  G._findDirty = function () {
    clearTimeout(this._findT);
    this._findT = setTimeout(() => {
      const f = this.find_; if (!f || this._dead) return;
      if (this._findJob) { this._findJob.cancel(); this._findJob = null; }
      const nf = this._newFind(f.query, f.opts, 0);
      this._runFind(nf, true, 0, f.curKey);
    }, 300);
  };
  G.onSelectDebounced = function (fn, ms) {
    let t = 0, last = null;
    const h = sel => { last = sel; clearTimeout(t); t = setTimeout(() => { t = 0; fn(last); }, ms == null ? 120 : ms); };
    this.on('select', h);
    return () => { clearTimeout(t); this.off('select', h); };
  };

  // ---------- misc API ----------
  G.getColumnValues = function (c, limit) {
    limit = limit || 1000;
    const p = this.provider, m = new Map(); let truncated = false;
    for (let r = 0; r < p.rowCount; r++) {
      const cv = p.getCell(r, c), t = cv && cv.text != null ? cv.text : '';
      const e = m.get(t);
      if (e) e.count++; else { if (m.size >= limit) { truncated = true; continue; } m.set(t, { text: t, count: 1 }); }
    }
    const out = Array.from(m.values()); out.truncated = truncated; return out;
  };
  G.autosizeColumn = function (c) {
    const p = this.provider, z = this.zoom;
    const rows = new Set();
    for (let i = this.fr ? 0 : this.nfr; i < this.nr; i++) rows.add(this.rS[i]);
    const n = p.rowCount, step = Math.max(1, Math.floor(n / 2000));
    for (let r = 0; r < n; r += step) rows.add(r);
    let best = 0;
    for (const r of rows) {
      const cv = p.getCell(r, c); if (!cv || !cv.text || (cv.style && cv.style.wrap)) continue;
      const se = cv.style ? this._style(cv.style) : this._defStyle();
      let w = this._measure(se.font, cv.text.indexOf('\n') >= 0 ? cv.text.replace(/\r?\n/g, ' ') : cv.text) / z;
      if (cv.style && cv.style.indent) w += cv.style.indent * 9;
      if (w > best) best = w;
    }
    const width = best ? clamp(Math.ceil(best + 11), 24, 600) : this._defC;
    const cols = this._colsToResize(c);
    for (const cc of cols) { this.colOv.set(cc, width); this.emit('resizeCol', { c: cc, width }); }
    this._resizeAxis(this.colAxis, cols, width);
  };
  G.copyAsMarkdown = function () {
    const rg = this._copyRange();
    if (this._tooLarge(rg)) return;
    const text = C.toMarkdown(this._grab(rg).rows);
    this._writeClipboard(text);
    this.emit('copy', { text, cut: false, markdown: true });
  };

  // ---------- context menu ----------
  G._ctxDown = function (e) {
    const h = this._hit(e); if (!h) return;
    if (h.zone === 'cell') { if (!this.ranges.some(g => C.inRange(g, h.r, h.c))) this.select(h.r, h.c); }
    else if (h.zone === 'colhdr') { if (this._hdrState(true, h.c) === 0) this._selectCols(h.c, h.c, false); }
    else if (h.zone === 'rowhdr') { if (this._hdrState(false, h.r) === 0) this._selectRows(h.r, h.r, false); }
    this.focus();
  };
  G._onContext = function (e) {
    e.preventDefault();
    const h = this._hit(e); if (!h) return;
    const payload = { r: h.r, c: h.c, sr: this.view.toSource(h.r), zone: h.zone, clientX: e.clientX, clientY: e.clientY, handled: false };
    this.emit('contextmenu', payload);
    if (payload.handled) return;
    const mac = /Mac|iPhone|iPad/.test((root.navigator && root.navigator.platform) || '');
    const m = mac ? '⌘' : 'Ctrl+', ro = this.readOnly;
    const items = [
      ['Cut', m + 'X', () => this.copy(true), ro], ['Copy', m + 'C', () => this.copy(false)],
      ['Paste', m + 'V', () => { const nav = root.navigator; if (nav && nav.clipboard) nav.clipboard.readText().then(t => this.pasteText(t)).catch(() => {}); }, ro],
      ['Clear contents', 'Del', () => this.clearSelection(), ro], null,
      ['Select all', m + 'A', () => this._selectAll()],
      ['Autosize column', '', () => this.autosizeColumn(h.zone === 'cell' || h.zone === 'colhdr' ? h.c : this.active.c)],
      ['Copy as Markdown table', '', () => this.copyAsMarkdown()]
    ];
    this._showMenu(items, e.clientX, e.clientY);
  };
  G._showMenu = function (items, x, y) {
    this._closeMenu();
    const doc = this.el.ownerDocument, menu = doc.createElement('div'); menu.className = 'oxg-menu';
    for (const it of items) {
      if (!it) { menu.appendChild(doc.createElement('hr')); continue; }
      const d = doc.createElement('div'); if (it[3]) d.className = 'dis';
      const a = doc.createElement('span'); a.textContent = it[0]; const b = doc.createElement('kbd'); b.textContent = it[1] || '';
      d.appendChild(a); d.appendChild(b);
      d.addEventListener('mousedown', ev => { ev.stopPropagation(); ev.preventDefault(); this._closeMenu(); this.focus(); it[2](); });
      menu.appendChild(d);
    }
    doc.body.appendChild(menu);
    const w = menu.offsetWidth, h = menu.offsetHeight, vw = root.innerWidth, vh = root.innerHeight;
    menu.style.left = Math.max(0, Math.min(x, vw - w - 4)) + 'px'; menu.style.top = Math.max(0, Math.min(y, vh - h - 4)) + 'px';
    this._menu = menu;
    this._menuOff = ev => { if (!(ev.target instanceof Node) || !menu.contains(ev.target)) this._closeMenu(); };
    this._menuKey = ev => { if (ev.key === 'Escape') this._closeMenu(); };
    doc.addEventListener('mousedown', this._menuOff, true); doc.addEventListener('keydown', this._menuKey, true);
    this._menuBlur = () => this._closeMenu();
    root.addEventListener('blur', this._menuBlur);
  };
  G._closeMenu = function () {
    if (!this._menu) return;
    const doc = this.el.ownerDocument;
    this._menu.remove(); this._menu = null;
    doc.removeEventListener('mousedown', this._menuOff, true); doc.removeEventListener('keydown', this._menuKey, true); root.removeEventListener('blur', this._menuBlur);
  };

  // ---------- wiring ----------
  G._bind = function () {
    const offs = [], doc = this.el.ownerDocument;
    const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); offs.push(() => t.removeEventListener(ev, fn, o)); };
    const sc = this.scroller;
    on(sc, 'scroll', () => this._onScroll(), { passive: true });
    on(sc, 'mousedown', e => this._onMouseDown(e));
    on(sc, 'mousemove', e => this._onHover(e));
    on(sc, 'dblclick', e => this._onDblClick(e));
    on(sc, 'contextmenu', e => this._onContext(e));
    on(sc, 'wheel', e => this._onWheel(e), { passive: false });
    on(this.el, 'keydown', e => this._onKeyDown(e));
    on(this.el, 'compositionstart', e => { if (e.target === this.el && !this.edit_ && !this.readOnly) { this.startEdit(this.active.r, this.active.c, ''); if (this.edit_) this.edit_.fromComp = true; } });
    on(this.el, 'compositionend', e => {
      if (e.target !== this.el || !e.data || this.readOnly) return;
      if (!this.edit_) this.startEdit(this.active.r, this.active.c, e.data);
      else if (this.edit_.fromComp && !this.editor.value) { this.editor.value = e.data; this._placeEditor(); const n = e.data.length; this.editor.setSelectionRange(n, n); }
    });
    on(this.el, 'copy', e => this._onCopyEvt(e, false));
    on(this.el, 'cut', e => this._onCopyEvt(e, true));
    on(this.el, 'paste', e => this._onPasteEvt(e));
    let ro = null;
    if (root.ResizeObserver) { ro = new ResizeObserver(() => this._resize()); ro.observe(this.el); }
    else on(root, 'resize', () => this._resize());
    let mq = null;
    const armDpr = () => {
      if (!root.matchMedia) return;
      mq = root.matchMedia('(resolution: ' + (root.devicePixelRatio || 1) + 'dppx)');
      const h = () => { if (this._dead) return; this._resize(); mq.removeEventListener('change', h); armDpr(); };
      mq.addEventListener('change', h);
      offs.push(() => mq.removeEventListener('change', h));
    };
    armDpr();
    this._unbind = () => {
      offs.forEach(f => f()); if (ro) ro.disconnect();
      if (this._docMove) { doc.removeEventListener('mousemove', this._docMove); doc.removeEventListener('mouseup', this._docUp); }
      if (this.editor) this.editor.remove();
    };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = OX;
})(typeof globalThis !== 'undefined' ? globalThis : this);
