(function (root) {
  'use strict';
  const OX = root.OX || (root.OX = {});
  const KEY = 16384;
  const CACHE_MAX = 60000;

  class XlsxProvider {
    constructor(workbook, sheet, opts) {
      this.wb = workbook;
      this.sheet = sheet;
      this.merges = sheet.merges;
      this.frozenRows = sheet.frozenRows;
      this.frozenCols = sheet.frozenCols;
      this.showGridLines = sheet.showGridLines;
      this.date1904 = workbook.date1904;
      this.overlay = new Map();
      this.colOverride = new Map();
      this._cache = new Map();
      this._extraRows = 0;
      this._extraCols = 0;
      this._measure = (opts && opts.measure) || null;
      this._extDirty = false;
      this._zh = !!sheet.zeroHeightRows;
      this._shownEdit = new Set();
      this._st = sheet.store || null;
      this._blank = new Map();
    }

    // default styles can appear while a sheet is still streaming in
    get _hasDef() { const s = this.sheet; return !!((s.rowStyles && s.rowStyles.size) || (s.colStyles && s.colStyles.length)); }
    get partial() { return !!this.sheet.partial; }
    // while streaming, <dimension> gives the scroll extent early
    get rowCount() {
      if (this._extDirty) this._recalcExtent();
      const s = this.sheet;
      return Math.max(s.rowCount, this._extraRows, s.partial && s.dimension ? s.dimension.r2 + 1 : 0);
    }
    get colCount() {
      if (this._extDirty) this._recalcExtent();
      const s = this.sheet;
      return Math.max(s.colCount, this._extraCols, s.partial && s.dimension ? s.dimension.c2 + 1 : 0);
    }

    _recalcExtent() {
      let rr = 0, cc = 0;
      this.overlay.forEach((cell, key) => {
        if (!cell) return;
        const r = Math.floor(key / KEY), c = key - r * KEY;
        if (r + 1 > rr) rr = r + 1;
        if (c + 1 > cc) cc = c + 1;
      });
      this._extraRows = rr; this._extraCols = cc; this._extDirty = false;
    }

    // default style index of a cell that does not exist (row style wins over column style)
    _defS(r, c) {
      if (!this._hasDef) return 0;
      const rs = this.sheet.rowStyles.get(r);
      if (rs !== undefined) return rs;
      const cs = this.sheet.colStyles;
      for (let i = 0; i < cs.length; i++) if (c >= cs[i].c1 && c <= cs[i].c2) return cs[i].s;
      return 0;
    }

    _blankView(r, c) {
      const s = this._defS(r, c);
      if (!s) return undefined;
      let v = this._blank.get(s);
      if (v === undefined) {
        const st = this.wb.styles[s];
        v = st && (st.bg || st.bl || st.br || st.bt || st.bb) ? { text: '', kind: 'text', style: st, color: undefined, link: false } : null;
        this._blank.set(s, v);
      }
      return v === null ? undefined : v;
    }

    // style index = `s` with number format `fmt`; registers a derived Style in wb.styles (shared per workbook)
    _derive(s, fmt) {
      const wb = this.wb;
      const d = wb._dx || (wb._dx = { map: new Map(), info: new Map() });
      const inf = d.info.get(s), base = inf ? inf.base : s, key = base + '|' + fmt;
      let idx = d.map.get(key);
      if (idx === undefined) {
        idx = wb.styles.length;
        wb.styles.push(Object.assign({}, wb.styles[base] || wb.styles[0] || {}, { fmt }));
        d.map.set(key, idx); d.info.set(idx, { base, fmt });
      }
      return idx;
    }
    _fmtOf(s) {
      const d = this.wb._dx, inf = d && d.info.get(s);
      return inf ? inf.fmt : undefined;
    }

    cellAt(r, c) {
      if (this.overlay.size !== 0) {
        const o = this.overlay.get(r * KEY + c);
        if (o !== undefined) return o === null ? undefined : o;
      }
      return this._orig(r, c);
    }

    getCell(r, c) {
      const key = r * KEY + c;
      let v = this._cache.get(key);
      if (v !== undefined) return v;
      const cell = this.cellAt(r, c);
      if (cell === undefined) return this._hasDef ? this._blankView(r, c) : undefined;
      const style = this.wb.styles[cell.s] || null;
      if (cell.t === 'z' && !style && !cell.f) return undefined;
      const f = OX.formatCell(cell, style, this.date1904);
      v = { text: f.text, kind: f.kind, style: style, color: f.color, link: this.sheet.hyperlinks.size > 0 && this.sheet.hyperlinks.has(r + ',' + c) };
      if (this._cache.size >= CACHE_MAX) this._cache.clear();
      this._cache.set(key, v);
      return v;
    }

    getRaw(r, c) {
      const cell = this.cellAt(r, c);
      if (cell === undefined) return '';
      return OX.exportText(cell, this.wb.styles[cell.s] || null, this.date1904);
    }

    colWidth(c) {
      const o = this.colOverride.get(c);
      if (o !== undefined) return o;
      const w = this.sheet.colWidths.get(c);
      return w !== undefined ? w : this.sheet.defaultColWidth;
    }

    rowHeight(r) {
      const h = this.sheet.rowHeights.get(r);
      return h !== undefined ? h : this.sheet.defaultRowHeight;
    }

    isColHidden(c) { return this.sheet.hiddenCols.has(c); }
    isRowHidden(r) {
      if (this.sheet.hiddenRows.has(r)) return true;
      return this._zh && !this.sheet.shownRows.has(r) && !this._shownEdit.has(r);
    }
    setColWidth(c, w) { this.colOverride.set(c, w); }
    setRowHeight(r, h) { this.sheet.rowHeights.set(r, h); }

    _same(o, cell) {
      return o !== undefined && o.t === cell.t && o.v === cell.v && (o.f || '') === (cell.f || '') && o.s === cell.s;
    }

    // returns the previous overlay slot so callers can undo; an {error} result from editFromText is refused
    setCell(r, c, cell) {
      const key = r * KEY + c;
      const prev = this.overlay.has(key) ? this.overlay.get(key) : undefined;
      if (cell && cell.error !== undefined) return prev;
      const orig = this._orig(r, c);
      if (cell === undefined || (cell === orig && orig !== undefined)) this.overlay.delete(key);
      else if (cell === null) {
        if (!orig || (orig.t === 'z' && !orig.f)) this.overlay.delete(key);
        else this.overlay.set(key, orig.s ? { t: 'z', v: null, s: orig.s } : null); // keep the style visible
      } else {
        const base = orig || prev;
        let st = cell.s !== undefined ? cell.s : (base ? base.s : this._defS(r, c));
        if (cell.fmt) st = this._derive(st, cell.fmt);
        const withStyle = { t: cell.t, v: cell.v, s: st };
        if (cell.f !== undefined) withStyle.f = cell.f;
        if (orig !== undefined && this._same(orig, withStyle)) this.overlay.delete(key);
        else this.overlay.set(key, withStyle);
      }
      this._cache.delete(key);
      if (cell) {
        if (r + 1 > this._extraRows) this._extraRows = r + 1;
        if (c + 1 > this._extraCols) this._extraCols = c + 1;
        if (this._zh) this._shownEdit.add(r);
      }
      return prev;
    }

    restoreSlot(r, c, slot) {
      const key = r * KEY + c;
      if (slot === undefined) this.overlay.delete(key);
      else this.overlay.set(key, slot);
      this._cache.delete(key);
      this._extDirty = true;
    }

    _orig(r, c) {
      const st = this._st;
      if (st !== null) {
        const i = st.index(r, c);
        return i < 0 ? undefined : st.cellAt(i, r, c);
      }
      const row = this.sheet.rows[r];
      return row === undefined ? undefined : row[c];
    }

    _tableAt(r, c) {
      const ts = this.sheet.tables;
      if (ts) for (const t of ts) if (t.header && r === t.r1 && c >= t.c1 && c <= t.c2) return t;
      return null;
    }

    // array (CSE) formula ranges of this sheet: [{r1,c1,r2,c2,mr,mc}] (mr,mc = master cell); cheap, no cell scan
    arrayRanges() {
      const a = this.sheet.arrays;
      return a ? a.map((x) => ({ r1: x.r1, c1: x.c1, r2: x.r2, c2: x.c2, mr: x.mr, mc: x.mc })) : [];
    }

    // the array formula range covering (r,c) or null
    arrayAt(r, c) {
      const a = this.sheet.arrays;
      if (a) for (const x of a) if (r >= x.r1 && r <= x.r2 && c >= x.c1 && c <= x.c2) return { r1: x.r1, c1: x.c1, r2: x.r2, c2: x.c2, mr: x.mr, mc: x.mc };
      return null;
    }

    // typed text -> edit cell {t,v,f?,fmt?}; keeps existing style. Returns {error} when the input cannot be saved.
    editFromText(r, c, text) {
      const prev = this.cellAt(r, c);
      if (typeof text === 'string' && text.length > 32767) return { error: 'Text is longer than the 32767 character limit of a cell.' };
      const arrs = this.sheet.arrays;
      if (arrs && arrs.length) {
        for (const a of arrs) {
          if (r < a.r1 || r > a.r2 || c < a.c1 || c > a.c2 || (r === a.mr && c === a.mc) || this.overlay.has(a.mr * KEY + a.mc)) continue;
          return { error: 'Cannot change part of an array formula (' + OX.cellRef(r, c) + ' is inside ' + OX.cellRef(a.r1, a.c1) + ':' + OX.cellRef(a.r2, a.c2) + '). Edit ' + OX.cellRef(a.mr, a.mc) + ' or clear the whole array.' };
        }
      }
      const style = prev ? this.wb.styles[prev.s] || null : null;
      const parsed = OX.parseInput(text, prev, style, this.date1904);
      const tbl = this._tableAt(r, c);
      if (tbl) {
        if (parsed === null) return { error: 'A table header cell cannot be empty.' };
        if (parsed.f !== undefined || parsed.t === 'e') return { error: 'A table header must be plain text, not a formula or error.' };
        const v = parsed.t === 's' ? parsed.v : String(text).trim();
        const lv = v.toLowerCase();
        for (let k = tbl.c1; k <= tbl.c2; k++) {
          if (k === c) continue;
          const o = this.cellAt(r, k);
          if (o && o.v != null && String(o.v).toLowerCase() === lv) return { error: 'Table column names must be unique ("' + v + '" is already used).' };
        }
        return { t: 's', v, f: undefined, s: prev ? prev.s : this._defS(r, c) };
      }
      if (parsed === null) return prev === undefined || (prev.t === 'z' && !prev.f) ? undefined : { t: 'z', v: null, s: prev.s, cleared: true };
      if (parsed.f !== undefined && OX.validateFormula) {
        const err = OX.validateFormula('=' + parsed.f);
        if (err) return { error: err };
      }
      let st = prev ? prev.s : this._defS(r, c);
      const out = { t: parsed.t, v: parsed.v, f: parsed.f, s: st };
      if (parsed.fmt) { out.fmt = parsed.fmt; out.s = this._derive(st, parsed.fmt); }
      return out;
    }

    // writer edit cell contract: {t, v, f?, fmt?}; cleared cells are null
    pendingEdits(sheetIndex) {
      const out = [];
      this.overlay.forEach((cell, key) => {
        const r = Math.floor(key / KEY), c = key - r * KEY;
        const orig = this._orig(r, c);
        if (cell === null || (cell.t === 'z' && !cell.f)) {
          if (orig === undefined || (orig.t === 'z' && !orig.f)) return;
          out.push({ sheet: sheetIndex, r: r, c: c, cell: null });
          return;
        }
        const fmt = this._fmtOf(cell.s);
        if (fmt === undefined && orig !== undefined && this._same(orig, cell)) return;
        const e = { t: cell.t, v: cell.v, f: cell.f };
        if (fmt !== undefined) e.fmt = fmt;
        out.push({ sheet: sheetIndex, r: r, c: c, cell: e });
      });
      return out;
    }

    get dirty() { return this.overlay.size > 0; }

    forEachCell(r1, c1, r2, c2, fn) {
      const st = this._st, ov = this.overlay;
      if (st !== null) {
        if (ov.size === 0) { st.each(r1, c1, r2, c2, fn); return; }
        st.each(r1, c1, r2, c2, (cell, r, c) => {
          const o = ov.get(r * KEY + c);
          if (o === undefined) fn(cell, r, c);
          else if (o) fn(o, r, c);
        });
        ov.forEach((cell, key) => {
          const r = Math.floor(key / KEY), c = key - r * KEY;
          if (cell && r >= r1 && r <= r2 && c >= c1 && c <= c2 && st.index(r, c) < 0) fn(cell, r, c);
        });
        return;
      }
      const rows = this.sheet.rows;
      const lastR = Math.min(r2, rows.length - 1);
      for (let r = r1; r <= lastR; r++) {
        const row = rows[r];
        if (row === undefined) continue;
        const lastC = Math.min(c2, row.length - 1);
        for (let c = c1; c <= lastC; c++) {
          const cell = ov.size ? this.cellAt(r, c) : row[c];
          if (cell !== undefined) fn(cell, r, c);
        }
      }
      if (ov.size) {
        ov.forEach((cell, key) => {
          const r = Math.floor(key / KEY), c = key - r * KEY;
          if (r >= r1 && r <= r2 && c >= c1 && c <= c2 && (r >= rows.length || rows[r] === undefined || rows[r][c] === undefined) && cell) fn(cell, r, c);
        });
      }
    }

    autosizeCol(c, measure) {
      const m = measure || this._measure;
      if (!m) return this.colWidth(c);
      let max = 0, n = 0;
      const st = this._st, ov = this.overlay.size > 0;
      const end = st !== null ? Math.max(this.sheet.rowCount, this._extraRows) : this.sheet.rows.length;
      for (let r = 0; r < end && n < 3000; r++) {
        if (st !== null && !ov && st.index(r, c) < 0 && !this._hasDef) continue;
        const cv = this.getCell(r, c);
        if (cv === undefined || cv.text === '') continue;
        n++;
        const w = m(cv.text, cv.style);
        if (w > max) max = w;
      }
      const px = Math.max(48, Math.min(600, Math.ceil(max) + 16));
      this.colOverride.set(c, px);
      return px;
    }
  }

  OX.XlsxProvider = XlsxProvider;
  if (typeof module !== 'undefined' && module.exports) module.exports = OX;
})(typeof globalThis !== 'undefined' ? globalThis : this);
