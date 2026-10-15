(function (root) {
  'use strict';
  const OX = root.OX || (root.OX = {});
  const MAXR = 1048576, MAXC = 16384;
  const ERRORS = new Set(['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#SPILL!', '#CALC!']);
  const STORED_EXT = /\.(png|jpe?g|gif|webp|zip|xlsx|xlsm|docx|pptx|mp[34]|mov|avi|pdf|jfif|bin|wmf|emf)$/i;

  const isWs = (k) => k === 32 || k === 9 || k === 10 || k === 13;

  function colName(c) {
    let s = '';
    c++;
    while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = (c - 1 - m) / 26; }
    return s;
  }
  function colOfRef(ref) { // 1-based column from "AB12"
    let c = 0;
    for (let i = 0; i < ref.length; i++) {
      const k = ref.charCodeAt(i);
      if (k >= 65 && k <= 90) c = c * 26 + k - 64;
      else if (k >= 97 && k <= 122) c = c * 26 + k - 96;
      else break;
    }
    return c;
  }
  function rowOfRef(ref) {
    let i = 0;
    while (i < ref.length) { const k = ref.charCodeAt(i); if (k >= 48 && k <= 57) break; i++; }
    let r = 0;
    for (; i < ref.length; i++) { const k = ref.charCodeAt(i) - 48; if (k < 0 || k > 9) break; r = r * 10 + k; }
    return r;
  }
  function parseRange(ref) { // "A1:B3" -> {r1,c1,r2,c2} 1-based
    const p = ref.replace(/\$/g, '').split(':');
    const a = p[0], b = p.length > 1 ? p[1] : p[0];
    return { r1: rowOfRef(a), c1: colOfRef(a), r2: rowOfRef(b), c2: colOfRef(b) };
  }

  // ---- escaping ----
  function escapeXml(s) {
    s = String(s);
    if (/[&<>"\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF\uD800-\uDFFF]/.test(s)) {
      s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : ''));
      s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    return s;
  }
  function unescapeXml(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
      switch (e) {
        case 'amp': return '&'; case 'lt': return '<'; case 'gt': return '>'; case 'quot': return '"'; case 'apos': return "'";
      }
      const cp = e.charCodeAt(1) === 120 ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch (_) { return m; }
    });
  }
  const hex4 = (k) => '_x' + k.toString(16).toUpperCase().padStart(4, '0') + '_';
  // Text content (ST_Xstring): control chars become _xHHHH_ like Excel; literal "_xHHHH_" gets its underscore escaped.
  function escapeText(s) {
    if (/[&<>\x00-\x08\x0B\x0C\x0E-\x1F\r\uD800-\uDFFF\uFFFE\uFFFF_]/.test(s)) {
      s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (s.indexOf('_x') >= 0) s = s.replace(/_(x[0-9A-Fa-f]{4}_)/g, '_x005F_$1');
      s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\r\uFFFE\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : hex4(m.charCodeAt(0))));
    }
    return s;
  }
  function escapeFormula(f) {
    f = f.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\r\uFFFE\uFFFF]/g, '');
    return f.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- formula shifting (shared formulas) ----
  const CELL_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/;
  const COL_RE = /^(\$?)([A-Za-z]{1,3})$/;
  const ROW_RE = /^(\$?)(\d+)$/;
  const isRunCh = (k) => (k >= 48 && k <= 57) || (k >= 65 && k <= 90) || (k >= 97 && k <= 122) || k === 95 || k === 46 || k === 36 || k === 92;
  const wrap = (x, n) => ((x - 1) % n + n) % n + 1;

  function shiftFormula(f, dr, dc) {
    if (!dr && !dc) return f;
    let out = '', i = 0, last = 0;
    const n = f.length;
    const shiftCol = (abs, letters) => {
      if (abs) return '$' + letters;
      return colName(wrap(colOfRef(letters) + dc, MAXC) - 1);
    };
    const shiftRow = (abs, digits) => (abs ? '$' + digits : String(wrap(parseInt(digits, 10) + dr, MAXR)));
    const runEnd = (j) => { while (j < n && isRunCh(f.charCodeAt(j))) j++; return j; };
    while (i < n) {
      const k = f.charCodeAt(i);
      if (k === 34 || k === 39) {
        let j = i + 1;
        for (; j < n; j++) {
          if (f.charCodeAt(j) === k) { if (f.charCodeAt(j + 1) === k) { j++; continue; } break; }
        }
        i = j + 1; continue;
      }
      if (k === 91) {
        let d = 0, j = i;
        for (; j < n; j++) { const ch = f.charCodeAt(j); if (ch === 91) d++; else if (ch === 93 && --d === 0) break; }
        i = j + 1; continue;
      }
      if (!isRunCh(k)) { i++; continue; }
      const j = runEnd(i + 1);
      const tok = f.slice(i, j), nx = f.charCodeAt(j);
      let rep = null, endAt = j, m;
      if ((m = CELL_RE.exec(tok)) && nx !== 40 && nx !== 33) {
        const col = colOfRef(m[2]), row = parseInt(m[4], 10);
        if (col <= MAXC && row >= 1 && row <= MAXR) rep = shiftCol(m[1], m[2]) + shiftRow(m[3], m[4]);
      } else if (nx === 58 && (m = COL_RE.exec(tok)) && colOfRef(m[2]) <= MAXC) {
        const j2 = runEnd(j + 1), t2 = f.slice(j + 1, j2), n2 = f.charCodeAt(j2), m2 = COL_RE.exec(t2);
        if (m2 && colOfRef(m2[2]) <= MAXC && n2 !== 40 && n2 !== 33) { rep = shiftCol(m[1], m[2]) + ':' + shiftCol(m2[1], m2[2]); endAt = j2; }
      } else if (nx === 58 && (m = ROW_RE.exec(tok))) {
        const j2 = runEnd(j + 1), m2 = ROW_RE.exec(f.slice(j + 1, j2));
        if (m2) { rep = shiftRow(m[1], m[2]) + ':' + shiftRow(m2[1], m2[2]); endAt = j2; }
      }
      if (rep !== null) { out += f.slice(last, i) + rep; last = endAt; }
      i = endAt;
    }
    return last === 0 ? f : out + f.slice(last);
  }

  // ---- small xml helpers ----
  function attr(tag, name) { // tag is a short tag-text slice: search stays bounded
    const p = ' ' + name + '=';
    let i = tag.indexOf(p + '"');
    if (i >= 0) { const s = i + p.length + 1; return tag.slice(s, tag.indexOf('"', s)); }
    i = tag.indexOf(p + "'");
    if (i >= 0) { const s = i + p.length + 1; return tag.slice(s, tag.indexOf("'", s)); }
    return null;
  }
  function parseAttrs(tag) {
    const o = {};
    const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(tag))) o[m[1]] = unescapeXml(m[2] !== undefined ? m[2] : m[3]);
    return o;
  }
  const dec = () => new TextDecoder('utf-8');
  function decodeXml(u8, name) {
    if (u8.length >= 2 && ((u8[0] === 0xFF && u8[1] === 0xFE) || (u8[0] === 0xFE && u8[1] === 0xFF))) throw new Error('UTF-16 XML part not supported: ' + name);
    return dec().decode(u8);
  }
  function resolveTarget(baseDir, target) {
    if (target.charCodeAt(0) === 47) return target.slice(1);
    const parts = baseDir ? baseDir.split('/') : [];
    for (const seg of target.split('/')) {
      if (seg === '..') parts.pop(); else if (seg !== '.' && seg !== '') parts.push(seg);
    }
    return parts.join('/');
  }
  const relsOf = (p) => (p.lastIndexOf('/') >= 0 ? p.slice(0, p.lastIndexOf('/') + 1) : '') + '_rels/' + p.slice(p.lastIndexOf('/') + 1) + '.rels';
  const dirOf = (p) => (p.lastIndexOf('/') >= 0 ? p.slice(0, p.lastIndexOf('/')) : '');
  const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
  function findFile(files, path) {
    if (path in files) return path;
    const lp = path.toLowerCase();
    for (const k in files) if (k.toLowerCase() === lp) return k;
    return null;
  }
  function readRels(files, relPath) {
    const k = findFile(files, relPath);
    const out = [];
    if (!k) return out;
    const x = decodeXml(files[k], k);
    const re = /<(?:[\w.-]+:)?Relationship\b[^>]*>/g;
    let m;
    while ((m = re.exec(x))) {
      const a = parseAttrs(m[0]);
      out.push({ id: a.Id, type: a.Type || '', target: a.Target || '', mode: a.TargetMode || '' });
    }
    return out;
  }

  function locateSheets(files) {
    let wbPath = 'xl/workbook.xml';
    const root = readRels(files, '_rels/.rels');
    for (const r of root) if (/\/officeDocument$/.test(r.type) && r.mode !== 'External') { wbPath = resolveTarget('', r.target); break; }
    const wbKey = findFile(files, wbPath);
    if (!wbKey) throw new Error('workbook.xml not found');
    const wb = decodeXml(files[wbKey], wbKey);
    const rels = readRels(files, relsOf(wbKey));
    const byId = {};
    for (const r of rels) byId[r.id] = r;
    const s0 = wb.search(/<(?:[\w.-]+:)?sheets[\s>]/);
    const s1 = wb.search(/<\/(?:[\w.-]+:)?sheets>/);
    if (s0 < 0 || s1 < 0) throw new Error('workbook has no <sheets>');
    const region = wb.slice(s0, s1);
    const re = /<(?:[\w.-]+:)?sheet\b[^>]*>/g;
    const sheets = [];
    let m;
    while ((m = re.exec(region))) {
      const a = parseAttrs(m[0]);
      let rid = null;
      for (const k in a) if (k === 'id' || k.endsWith(':id')) rid = a[k];
      const rel = rid && byId[rid];
      sheets.push({ name: a.name, rel: rel || null, path: rel ? resolveTarget(dirOf(wbKey), rel.target) : null });
    }
    return { wbKey, wb, rels, sheets };
  }

  // ---- cell encoding ----
  function numStr(v) {
    if (typeof v !== 'number' || !isFinite(v)) throw new Error('Invalid number value: ' + v);
    return v === 0 ? '0' : String(v);
  }
  // returns a reason string when the formula text cannot be written safely, else null
  function formulaError(f) {
    const n = f.length;
    if (!n) return 'the formula is empty';
    if (n > 8192) return 'the formula is longer than 8192 characters';
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(f)) return 'the formula contains control characters';
    let par = 0, brace = 0, first = -1, last = -1;
    for (let i = 0; i < n;) {
      const c = f.charCodeAt(i);
      if (c === 34 || c === 39) {
        let j = i + 1;
        for (;;) {
          j = f.indexOf(c === 34 ? '"' : "'", j);
          if (j < 0) return c === 34 ? 'a text string is missing its closing quote (")' : "a sheet name is missing its closing quote (')";
          if (f.charCodeAt(j + 1) === c) { j += 2; continue; }
          break;
        }
        if (first < 0) first = c;
        last = c; i = j + 1; continue;
      }
      if (c === 91) {
        let d = 0, j = i;
        for (; j < n; j++) {
          const ch = f.charCodeAt(j);
          if (ch === 39) j++; else if (ch === 91) d++; else if (ch === 93 && --d === 0) break;
        }
        if (j >= n) return 'brackets [ ] are not balanced';
        if (first < 0) first = 91;
        last = 93; i = j + 1; continue;
      }
      if (c === 40) par++;
      else if (c === 41) { if (--par < 0) return 'parentheses are not balanced (extra ")")'; }
      else if (c === 123) brace++;
      else if (c === 125) { if (--brace < 0) return 'braces are not balanced (extra "}")'; }
      else if (c === 59 && brace === 0) return "';' is not allowed, use ',' to separate arguments";
      if (c > 32) { if (first < 0) first = c; last = c; }
      i++;
    }
    if (par !== 0) return 'parentheses are not balanced (missing ")")';
    if (brace !== 0) return 'braces are not balanced (missing "}")';
    if (first < 0) return 'the formula is empty';
    if (first === 42 || first === 47 || first === 94 || first === 38 || first === 61 || first === 60 || first === 62 || first === 44 || first === 41 || first === 37 || first === 58) return 'the formula starts with an operator';
    if (last === 43 || last === 45 || last === 42 || last === 47 || last === 94 || last === 38 || last === 61 || last === 60 || last === 62 || last === 44 || last === 58 || last === 33) return 'the formula ends with an operator';
    return null;
  }

  // functions Excel stores with a prefix (post-2007); value = prefix
  const XLFN = new Map();
  ('ACOT ACOTH ARABIC ARRAYTOTEXT BASE BETA.DIST BETA.INV BINOM.DIST BINOM.DIST.RANGE BINOM.INV BITAND BITLSHIFT BITOR BITRSHIFT BITXOR BYCOL BYROW CEILING.MATH CEILING.PRECISE CHISQ.DIST CHISQ.DIST.RT CHISQ.INV CHISQ.INV.RT CHISQ.TEST CHOOSECOLS CHOOSEROWS COMBINA CONCAT CONFIDENCE.NORM CONFIDENCE.T COT COTH COVARIANCE.P COVARIANCE.S CSC CSCH DAYS DECIMAL DROP ERF.PRECISE ERFC.PRECISE EXPAND EXPON.DIST F.DIST F.DIST.RT F.INV F.INV.RT F.TEST FILTERXML FLOOR.MATH FLOOR.PRECISE FORECAST.ETS FORECAST.ETS.CONFINT FORECAST.ETS.SEASONALITY FORECAST.ETS.STAT FORECAST.LINEAR FORMULATEXT GAMMA GAMMA.DIST GAMMA.INV GAMMALN.PRECISE GAUSS HSTACK HYPGEOM.DIST IFNA IFS IMAGE IMCOSH IMCOT IMCSC IMCSCH IMSEC IMSECH IMSINH IMTAN ISFORMULA ISOMITTED ISOWEEKNUM LAMBDA LET LOGNORM.DIST LOGNORM.INV MAKEARRAY MAP MAXIFS MINIFS MODE.MULT MODE.SNGL MUNIT NEGBINOM.DIST NETWORKDAYS.INTL NORM.DIST NORM.INV NORM.S.DIST NORM.S.INV NUMBERVALUE PDURATION PERCENTILE.EXC PERCENTILE.INC PERCENTRANK.EXC PERCENTRANK.INC PERMUTATIONA PHI POISSON.DIST QUARTILE.EXC QUARTILE.INC QUERYSTRING RANDARRAY RANK.AVG RANK.EQ REDUCE RRI SCAN SEC SECH SEQUENCE SHEET SHEETS SINGLE SKEW.P SORTBY STDEV.P STDEV.S SWITCH T.DIST T.DIST.2T T.DIST.RT T.INV T.INV.2T T.TEST TAKE TEXTAFTER TEXTBEFORE TEXTJOIN TEXTSPLIT TOCOL TOROW UNICHAR UNICODE UNIQUE VALUETOTEXT VAR.P VAR.S VSTACK WEBSERVICE WEIBULL.DIST WORKDAY.INTL WRAPCOLS WRAPROWS XLOOKUP XMATCH XOR Z.TEST').split(' ').forEach((n) => XLFN.set(n, '_xlfn.'));
  XLFN.set('FILTER', '_xlfn._xlws.'); XLFN.set('SORT', '_xlfn._xlws.');
  const isNameCh = (k) => (k >= 48 && k <= 57) || (k >= 65 && k <= 90) || (k >= 97 && k <= 122) || k === 95 || k === 46;
  function addXlfn(f) {
    let out = '', last = 0;
    const n = f.length;
    for (let i = 0; i < n;) {
      const c = f.charCodeAt(i);
      if (c === 34 || c === 39) {
        let j = i + 1;
        for (; j < n; j++) if (f.charCodeAt(j) === c) { if (f.charCodeAt(j + 1) === c) j++; else break; }
        i = j + 1; continue;
      }
      if (c === 91) {
        let d = 0, j = i;
        for (; j < n; j++) { const ch = f.charCodeAt(j); if (ch === 39) j++; else if (ch === 91) d++; else if (ch === 93 && --d === 0) break; }
        i = j + 1; continue;
      }
      if (((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) && (i === 0 || !isNameCh(f.charCodeAt(i - 1)))) {
        let j = i + 1;
        while (j < n && isNameCh(f.charCodeAt(j))) j++;
        if (f.charCodeAt(j) === 40) {
          const tok = f.slice(i, j).toUpperCase(), pre = XLFN.get(tok);
          if (pre !== undefined) { out += f.slice(last, i) + pre + tok; last = j; }
        }
        i = j; continue;
      }
      i++;
    }
    return last === 0 ? f : out + f.slice(last);
  }
  // user-facing message for an unwritable formula (text without or with leading '='), else null
  function validateFormula(f) {
    f = String(f);
    if (f.charCodeAt(0) === 61) f = f.slice(1);
    const err = formulaError(f);
    return err ? 'Invalid formula "=' + (f.length > 60 ? f.slice(0, 60) + '...' : f) + '": ' + err + '.' : null;
  }
  function normFormula(f) {
    f = String(f);
    if (f.charCodeAt(0) === 61) f = f.slice(1);
    const err = validateFormula(f);
    if (err) throw new Error(err);
    return addXlfn(f);
  }
  function checkStr(s) {
    if (s.length > 32767) throw new Error('Text exceeds 32767 characters');
    return s;
  }
  // Validates/normalizes an edit cell once up front so errors surface before any patching.
  function normCell(cell) {
    if (cell === null) return null;
    if (!cell || typeof cell !== 'object') throw new Error('Invalid cell');
    const t = cell.t;
    if (t !== 'n' && t !== 's' && t !== 'b' && t !== 'e') throw new Error('Invalid cell type: ' + t);
    const o = { t, v: cell.v, f: null, fmt: null };
    if (cell.fmt !== undefined && cell.fmt !== null && cell.fmt !== 'General') {
      if (typeof cell.fmt !== 'string' || !cell.fmt || cell.fmt.length > 255 || /[\x00-\x1F]/.test(cell.fmt)) throw new Error('Invalid number format: ' + cell.fmt);
      o.fmt = cell.fmt;
    }
    if (cell.f !== undefined && cell.f !== null && cell.f !== '') o.f = normFormula(cell.f);
    const hasV = cell.v !== undefined && cell.v !== null;
    if (!hasV && !o.f) throw new Error('Cell value missing');
    if (hasV) {
      if (t === 'n') {
        const n = typeof cell.v === 'number' ? cell.v : Number(cell.v);
        if (!isFinite(n)) { if (o.f) o.v = undefined; else throw new Error('Invalid number value: ' + cell.v); } else o.v = n;
      } else if (t === 's') o.v = checkStr(String(cell.v));
      else if (t === 'b') o.v = !!cell.v;
      else if (!ERRORS.has(String(cell.v))) { if (o.f) o.v = undefined; else throw new Error('Invalid error value: ' + cell.v); } else o.v = String(cell.v);
    }
    return o;
  }
  function buildCellU(ref, s, cell) {
    const sa = s !== null && s !== undefined ? ' s="' + s + '"' : '';
    if (cell === null) return sa ? '<c r="' + ref + '"' + sa + '/>' : '';
    const hasV = cell.v !== undefined && cell.v !== null;
    if (cell.f) {
      let t = '', v = '';
      if (hasV) {
        if (cell.t === 'n') v = '<v>' + numStr(cell.v) + '</v>';
        else if (cell.t === 's') { t = ' t="str"'; v = '<v>' + escapeText(cell.v) + '</v>'; }
        else if (cell.t === 'b') { t = ' t="b"'; v = '<v>' + (cell.v ? 1 : 0) + '</v>'; }
        else { t = ' t="e"'; v = '<v>' + cell.v + '</v>'; }
      }
      return '<c r="' + ref + '"' + sa + t + '><f>' + escapeFormula(cell.f) + '</f>' + v + '</c>';
    }
    switch (cell.t) {
      case 'n': return '<c r="' + ref + '"' + sa + '><v>' + numStr(cell.v) + '</v></c>';
      case 'b': return '<c r="' + ref + '"' + sa + ' t="b"><v>' + (cell.v ? 1 : 0) + '</v></c>';
      case 'e': return '<c r="' + ref + '"' + sa + ' t="e"><v>' + cell.v + '</v></c>';
      default: return '<c r="' + ref + '"' + sa + ' t="inlineStr"><is><t xml:space="preserve">' + escapeText(cell.v) + '</t></is></c>';
    }
  }

  // ---- styles.xml patching: derive cellXfs entries that differ only by number format ----
  const BUILTIN_IDS = { General: 0, '0': 1, '0.00': 2, '#,##0': 3, '#,##0.00': 4, '0%': 9, '0.00%': 10, '0.00E+00': 11, '# ?/?': 12, '# ??/??': 13, 'h:mm AM/PM': 18, 'h:mm:ss AM/PM': 19, 'h:mm': 20, 'h:mm:ss': 21, 'mm:ss': 45, '[h]:mm:ss': 46, 'mmss.0': 47, '##0.0E+0': 48, '@': 49 };
  const DEFAULT_XF = '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';

  function createStyler(files, wbKey, rels) {
    let path = null;
    for (const r of rels) if (/\/styles$/.test(r.type) && r.mode !== 'External') { path = resolveTarget(dirOf(wbKey), r.target); break; }
    const key = findFile(files, path || 'xl/styles.xml');
    if (!key) throw new Error('styles.xml not found; cannot save number formats');
    let xml = decodeXml(files[key], key);
    const rm = /<((?:[\w.-]+:)?)styleSheet[\s>]/.exec(xml);
    if (!rm) throw new Error('styles.xml is not a style sheet');
    const pre = rm[1];
    const xfOpen = new RegExp('<' + pre + 'cellXfs\\b[^>]*>'), nfOpen = new RegExp('<' + pre + 'numFmts\\b[^>]*>');
    const xfClose = '</' + pre + 'cellXfs>', nfClose = '</' + pre + 'numFmts>';
    // number formats
    const codes = new Map();
    let maxId = 163, nfCount = 0;
    const nm = nfOpen.exec(xml);
    if (nm && xml.charCodeAt(nm.index + nm[0].length - 2) !== 47) {
      const body = xml.slice(nm.index, xml.indexOf(nfClose, nm.index));
      const re = new RegExp('<' + pre + 'numFmt\\b[^>]*>', 'g');
      let m;
      while ((m = re.exec(body))) {
        const a = parseAttrs(m[0]);
        nfCount++;
        const id = parseInt(a.numFmtId, 10);
        if (id > maxId) maxId = id;
        if (a.formatCode !== undefined && !codes.has(a.formatCode)) codes.set(a.formatCode, id);
      }
    }
    const newFmts = [];
    // cellXfs
    const xfs = [];
    const xm = xfOpen.exec(xml);
    if (xm && xml.charCodeAt(xm.index + xm[0].length - 2) !== 47) {
      const end = xml.indexOf(xfClose, xm.index);
      const body = xml.slice(xm.index + xm[0].length, end < 0 ? xml.length : end);
      const re = new RegExp('<' + pre + 'xf\\b', 'g');
      let m;
      while ((m = re.exec(body))) {
        const gt = body.indexOf('>', m.index);
        const e = body.charCodeAt(gt - 1) === 47 ? gt + 1 : body.indexOf('</' + pre + 'xf>', gt) + pre.length + 5;
        xfs.push(body.slice(m.index, e));
        re.lastIndex = e;
      }
    }
    const baseCount = xfs.length;
    if (!xfs.length) xfs.push(pre ? DEFAULT_XF.replace('<xf', '<' + pre + 'xf') : DEFAULT_XF);
    const known = new Map();
    xfs.forEach((x, i) => { if (!known.has(x)) known.set(x, i); });
    const cache = new Map();
    const nfAttr = /\snumFmtId\s*=\s*(?:"[^"]*"|'[^']*')/, apAttr = /\sapplyNumberFormat\s*=\s*(?:"[^"]*"|'[^']*')/;

    function fmtId(code) {
      const b = BUILTIN_IDS[code];
      if (b !== undefined) return b;
      let id = codes.get(code);
      if (id === undefined) { id = ++maxId; codes.set(code, id); newFmts.push('<' + pre + 'numFmt numFmtId="' + id + '" formatCode="' + escapeXml(code) + '"/>'); }
      return id;
    }
    function derive(base, code) {
      const ck = base + '|' + code;
      let idx = cache.get(ck);
      if (idx !== undefined) return idx;
      const raw = xfs[base < xfs.length ? base : 0];
      const gt = raw.indexOf('>');
      let open = raw.slice(0, gt + 1);
      const sc = open.charCodeAt(open.length - 2) === 47;
      if (sc) open = open.slice(0, -2);
      else open = open.slice(0, -1);
      const id = fmtId(code);
      open = nfAttr.test(open) ? open.replace(nfAttr, ' numFmtId="' + id + '"') : open.replace(new RegExp('^<' + pre + 'xf'), '$&' + ' numFmtId="' + id + '"');
      open = apAttr.test(open) ? open.replace(apAttr, ' applyNumberFormat="1"') : open + ' applyNumberFormat="1"';
      const nx = open + (sc ? '/>' : '>') + raw.slice(gt + 1);
      idx = known.get(nx);
      if (idx === undefined) {
        if (xfs.length >= 64000) throw new Error('Too many cell formats in styles.xml');
        idx = xfs.length; xfs.push(nx); known.set(nx, idx);
      }
      cache.set(ck, idx);
      return idx;
    }
    function finalize() {
      const added = xfs.slice(baseCount);
      if (added.length) {
        const m = xfOpen.exec(xml);
        if (!m) {
          const blk = '<' + pre + 'cellXfs count="' + xfs.length + '">' + xfs.join('') + xfClose;
          const nxt = new RegExp('<' + pre + '(?:cellStyles|dxfs|tableStyles|colors|extLst)[\\s/>]').exec(xml);
          const at = nxt ? nxt.index : xml.lastIndexOf('</' + pre + 'styleSheet>');
          if (at < 0) throw new Error('Malformed styles.xml');
          xml = xml.slice(0, at) + blk + xml.slice(at);
        } else {
          const sc = xml.charCodeAt(m.index + m[0].length - 2) === 47;
          let open = m[0].replace(/\scount\s*=\s*(?:"[^"]*"|'[^']*')/, '');
          if (sc) open = open.slice(0, -2) + ' count="' + xfs.length + '">' + added.join('') + xfClose;
          else open = open.slice(0, -1) + ' count="' + xfs.length + '">';
          if (sc) xml = xml.slice(0, m.index) + open + xml.slice(m.index + m[0].length);
          else {
            const end = xml.indexOf(xfClose, m.index);
            if (end < 0) throw new Error('Malformed styles.xml (cellXfs)');
            xml = xml.slice(0, m.index) + open + xml.slice(m.index + m[0].length, end) + added.join('') + xml.slice(end);
          }
        }
      }
      if (newFmts.length) {
        const m = nfOpen.exec(xml);
        if (!m) {
          const gt = xml.indexOf('>', rm.index);
          xml = xml.slice(0, gt + 1) + '<' + pre + 'numFmts count="' + newFmts.length + '">' + newFmts.join('') + nfClose + xml.slice(gt + 1);
        } else {
          const sc = xml.charCodeAt(m.index + m[0].length - 2) === 47;
          const total = nfCount + newFmts.length;
          let open = m[0].replace(/\scount\s*=\s*(?:"[^"]*"|'[^']*')/, '');
          if (sc) {
            open = open.slice(0, -2) + ' count="' + total + '">' + newFmts.join('') + nfClose;
            xml = xml.slice(0, m.index) + open + xml.slice(m.index + m[0].length);
          } else {
            open = open.slice(0, -1) + ' count="' + total + '">';
            const end = xml.indexOf(nfClose, m.index);
            if (end < 0) throw new Error('Malformed styles.xml (numFmts)');
            xml = xml.slice(0, m.index) + open + xml.slice(m.index + m[0].length, end) + newFmts.join('') + xml.slice(end);
          }
        }
      }
      return { key, xml };
    }
    return { derive, finalize };
  }

  // ---- table header edits: keep <tableColumn name> in sync with the header cells ----
  function patchTables(files, sheetKey, rowsMap, sheetName) {
    const rk = findFile(files, dirOf(sheetKey) + '/_rels/' + baseOf(sheetKey) + '.rels');
    if (!rk) return [];
    const out = [];
    for (const rel of readRels(files, rk)) {
      if (!/\/table$/.test(rel.type) || rel.mode === 'External') continue;
      const tk = findFile(files, resolveTarget(dirOf(sheetKey), rel.target));
      if (!tk) continue;
      const xml = decodeXml(files[tk], tk);
      const tm = /<(?:[\w.-]+:)?table\b[^>]*>/.exec(xml);
      if (!tm) continue;
      const ta = parseAttrs(tm[0]);
      const rg = ta.ref ? parseRange(ta.ref) : null;
      const hdr = ta.headerRowCount === undefined ? 1 : parseInt(ta.headerRowCount, 10);
      if (!rg || !(hdr >= 1) || !rowsMap.has(rg.r1)) continue;
      const row = rowsMap.get(rg.r1);
      const tcRe = /<(?:[\w.-]+:)?tableColumn\b[^>]*>/g;
      const cols = [];
      let m;
      while ((m = tcRe.exec(xml))) cols.push({ at: m.index, tag: m[0], name: parseAttrs(m[0]).name });
      const renamed = [];
      for (const [c, cell] of row) {
        if (c < rg.c1 || c > rg.c2) continue;
        const where = colName(c - 1) + rg.r1 + ' on ' + sheetName;
        if (cell === null) throw new Error('Table header cell ' + where + ' cannot be empty');
        if (cell.f) throw new Error('Table header cell ' + where + ' cannot contain a formula');
        if (cell.t === 'e') throw new Error('Table header cell ' + where + ' cannot be an error value');
        const text = cell.t === 's' ? String(cell.v) : cell.t === 'b' ? (cell.v ? 'TRUE' : 'FALSE') : String(cell.v);
        if (text === '') throw new Error('Table header cell ' + where + ' cannot be empty');
        const col = cols[c - rg.c1];
        if (!col) continue;
        row.set(c, { t: 's', v: text, f: null, fmt: null });
        if (col.name !== text) { renamed.push({ col, from: col.name, to: text }); }
      }
      if (!renamed.length) continue;
      const names = cols.map((x) => x.name);
      for (const r of renamed) names[cols.indexOf(r.col)] = r.to;
      const seen = new Set();
      for (const n of names) {
        const k = String(n).toLowerCase();
        if (seen.has(k)) throw new Error('Table header names must be unique ("' + n + '" is used twice on ' + sheetName + ')');
        seen.add(k);
      }
      let res = '', last = 0, y = xml;
      for (const r of renamed) {
        const nt = r.col.tag.replace(/(\sname\s*=\s*)(?:"[^"]*"|'[^']*')/, (mm, a) => a + '"' + escapeXml(r.to).replace(/\r?\n/g, '_x000a_') + '"');
        res += xml.slice(last, r.col.at) + nt; last = r.col.at + r.col.tag.length;
      }
      y = res + xml.slice(last);
      const swaps = renamed.filter((r) => r.from);
      if (swaps.length && y.indexOf('calculatedColumnFormula') >= 0) {
        y = y.replace(/(<(?:[\w.-]+:)?calculatedColumnFormula\b[^>]*>)([\s\S]*?)(<\/(?:[\w.-]+:)?calculatedColumnFormula>)/g, (mm, a, b, c) => {
          for (const r of swaps) b = b.split('[' + escapeFormula(r.from) + ']').join('[' + escapeFormula(r.to) + ']');
          return a + b + c;
        });
      }
      out.push({ key: tk, xml: y });
    }
    return out;
  }

  // ---- worksheet patching ----
  const AFTER_SHEETDATA = /<(?:sheetCalcPr|sheetProtection|protectedRanges|scenarios|autoFilter|sortState|dataConsolidate|customSheetViews|mergeCells|phoneticPr|conditionalFormatting|dataValidations|hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|legacyDrawingHF|drawingHF|picture|oleObjects|controls|webPublishItems|tableParts)[\s/>]/;

  function parseCols(head) {
    const out = [];
    const a = head.indexOf('<cols>'), b = head.indexOf('</cols>');
    if (a < 0 || b < 0) return out;
    const re = /<col\b[^>]*>/g;
    const reg = head.slice(a, b);
    let m;
    while ((m = re.exec(reg))) {
      const at = parseAttrs(m[0]);
      if (at.style !== undefined) out.push({ min: +at.min, max: +at.max, style: at.style });
    }
    return out;
  }

  // xml is a latin1 "binary string" (1 char = 1 byte) so offsets are byte offsets; returns a parts list
  // (binary strings and [from, to) byte ranges of the original) or null when nothing changed.
  function patchSheetXml(xml, rowsMap, bbox, sheetName, derive) {
    const buildCell = (ref, s, cl) => strToBin(buildCellU(ref, s, cl));
    const hs = xml.slice(0, 4096);
    if (/<[A-Za-z_][\w.-]*:worksheet[\s>]/.test(hs)) throw new Error('Prefixed worksheet XML (' + sheetName + ') is not supported for editing');
    if (xml.indexOf('<worksheet') < 0) throw new Error('Not a worksheet part: ' + sheetName);

    // locate sheetData
    let sdStart = -1, gt = -1, selfClosed = false, openTag = '<sheetData>';
    for (let p = 0; ;) {
      const i = xml.indexOf('<sheetData', p);
      if (i < 0) break;
      const ch = xml.charCodeAt(i + 10);
      if (isWs(ch) || ch === 62 || ch === 47) { sdStart = i; break; }
      p = i + 10;
    }
    let dataStart, dataEnd;
    if (sdStart < 0) {
      let at = xml.search(AFTER_SHEETDATA);
      if (at < 0) at = xml.lastIndexOf('<extLst');
      if (at < 0) at = xml.lastIndexOf('</worksheet>');
      if (at < 0) throw new Error('Malformed worksheet XML');
      sdStart = at; gt = at - 1; selfClosed = true; dataStart = dataEnd = at;
    } else {
      gt = xml.indexOf('>', sdStart);
      selfClosed = xml.charCodeAt(gt - 1) === 47;
      if (selfClosed) { openTag = xml.slice(sdStart, gt - 1).replace(/\s+$/, '') + '>'; dataStart = dataEnd = gt + 1; }
      else {
        openTag = xml.slice(sdStart, gt + 1);
        dataStart = gt + 1;
        dataEnd = xml.indexOf('</sheetData>', dataStart);
        if (dataEnd < 0) throw new Error('Malformed worksheet XML (no </sheetData>)');
      }
    }
    const hasRows = (() => { const i = xml.indexOf('<row', dataStart); return i >= 0 && i < dataEnd; })();

    // array formulas: guard against editing the interior of an array
    if (xml.indexOf('array') >= 0 && /\st\s*=\s*["']array["']/.test(xml)) checkArrays(xml, rowsMap, sheetName);

    const erows = Array.from(rowsMap.keys()).sort((a, b) => a - b);
    let ep = 0;
    const parts = [];
    let head = xml.slice(0, sdStart);
    head = fixDimension(head, bbox, !hasRows);
    parts.push(head, openTag);

    let colStyles = null;
    const colStyle = (c) => {
      if (colStyles === null) colStyles = parseCols(head);
      for (const s of colStyles) if (c >= s.min && c <= s.max) return s.style;
      return null;
    };
    const sFor = (s, cell) => (cell !== null && cell.fmt ? String(derive(s === null || s === undefined ? 0 : parseInt(s, 10) || 0, cell.fmt)) : s);
    const killed = new Map();
    const killRanges = [];
    let killMin = Infinity, killMax = -1;
    const inKill = (rn) => {
      if (rn < killMin || rn > killMax) return false;
      for (const k of killRanges) if (rn >= k.r1 && rn <= k.r2) return true;
      return false;
    };
    const sortedCols = (cmap) => Array.from(cmap.keys()).sort((a, b) => a - b);

    function newRow(rn, cmap) {
      let cells = '';
      for (const c of sortedCols(cmap)) { const cl = cmap.get(c); cells += buildCell(colName(c - 1) + rn, sFor(colStyle(c), cl), cl); }
      return cells ? '<row r="' + rn + '">' + cells + '</row>' : '';
    }

    // f element info within a cell slice (offsets relative to the slice), or null
    function findF(cs) {
      const fi = cs.indexOf('<f');
      if (fi < 0) return null;
      const ch = cs.charCodeAt(fi + 2);
      if (!(isWs(ch) || ch === 62 || ch === 47)) return null;
      const fg = cs.indexOf('>', fi);
      const fsc = cs.charCodeAt(fg - 1) === 47;
      const fe = fsc ? fg + 1 : cs.indexOf('</f>', fg) + 4;
      return { fi, fe, tag: cs.slice(fi, fg + 1), text: fsc ? '' : binToStr(cs.slice(fg + 1, fe - 4)) };
    }

    function rebuildRow(i, rgt, rsc, rowEnd, rn, cmap) {
      let open = xml.slice(i, rgt + 1);
      const rtag = xml.slice(i, rgt), rowS = attr(rtag, 's'), cf = attr(rtag, 'customFormat');
      const rowStyle = rowS !== null && cf !== null && cf !== '0' && cf !== 'false' ? rowS : null;
      open = open.replace(/\sspans\s*=\s*(?:"[^"]*"|'[^']*')/, '');
      if (rsc) open = open.replace(/\s*\/>$/, '>');
      const out = [open];
      const cols = cmap ? sortedCols(cmap) : null;
      let ci = 0, n = 0, dirty = false, prevCol = 0;
      const end = rsc ? rgt + 1 : rowEnd - 6;
      const emitNew = (c) => {
        const cl = cmap.get(c);
        const s = buildCell(colName(c - 1) + rn, sFor(rowStyle !== null ? rowStyle : colStyle(c), cl), cl);
        if (s) { out.push(s); n++; dirty = true; }
      };
      let pos = rgt + 1;
      while (!rsc) {
        const j = xml.indexOf('<c', pos);
        if (j < 0 || j >= end) break;
        const ch = xml.charCodeAt(j + 2);
        if (!(isWs(ch) || ch === 62 || ch === 47)) { pos = j + 2; continue; }
        const cgt = xml.indexOf('>', j);
        const csc = xml.charCodeAt(cgt - 1) === 47;
        const cend = csc ? cgt + 1 : xml.indexOf('</c>', cgt) + 4;
        const ctag = xml.slice(j, cgt), ref = attr(ctag, 'r');
        const col = ref !== null ? colOfRef(ref) : prevCol + 1;
        prevCol = col;
        while (cols && ci < cols.length && cols[ci] < col) emitNew(cols[ci++]);
        if (cols && ci < cols.length && cols[ci] === col) {
          const ed = cmap.get(col);
          ci++;
          const cs = csc ? '' : xml.slice(j, cend);
          if (cs.indexOf('shared') >= 0) {
            const f = findF(cs);
            if (f && /\st\s*=\s*["']shared["']/.test(f.tag) && f.text) {
              const fa = parseAttrs(f.tag), si = fa.si;
              if (si !== undefined && !killed.has(si)) {
                const ra = fa.ref;
                const rg = ra ? parseRange(ra) : { r1: rn, c1: col, r2: MAXR, c2: MAXC };
                killed.set(si, { text: unescapeXml(f.text), mr: rn, mc: col });
                killRanges.push(rg);
                killMin = Math.min(killMin, rg.r1); killMax = Math.max(killMax, rg.r2);
              }
            }
          }
          const s = buildCell(ref !== null ? ref : colName(col - 1) + rn, sFor(attr(ctag, 's'), ed), ed);
          if (s) { out.push(s); n++; }
          dirty = true;
          pos = cend; continue;
        }
        if (killed.size && !csc) {
          const cs = xml.slice(j, cend);
          const f = cs.indexOf('shared') >= 0 ? findF(cs) : null;
          if (f && /\st\s*=\s*["']shared["']/.test(f.tag)) {
            const si = parseAttrs(f.tag).si, k = killed.get(si);
            if (k) {
              const txt = shiftFormula(k.text, rn - k.mr, col - k.mc);
              out.push(cs.slice(0, f.fi) + '<f>' + strToBin(escapeFormula(txt)) + '</f>' + cs.slice(f.fe));
              n++; dirty = true; pos = cend; continue;
            }
          }
        }
        out.push(xml.slice(j, cend)); n++;
        pos = cend;
      }
      while (cols && ci < cols.length) emitNew(cols[ci++]);
      if (!dirty) return null;
      if (n === 0) return open.replace(/>$/, '/>');
      out.push('</row>');
      return out.join('');
    }

    let pos = dataStart, copyFrom = dataStart, lastRn = 0, changed = false;
    // gallop over untouched rows: binary-search the byte range for the last row numbered below the next edit
    let canJump = true, needJump = true;
    const rowNo = (q) => { const g = xml.indexOf('>', q); const a = g < 0 ? null : attr(xml.slice(q, g), 'r'); return a === null ? -1 : parseInt(a, 10); };
    const jump = (from, t) => {
      let lo = from, hi = dataEnd, best = -1;
      while (hi - lo > 8192) {
        const mid = (lo + hi) >> 1;
        let q = mid;
        for (;;) {
          q = xml.indexOf('<row', q);
          if (q < 0 || q >= hi) { q = -1; break; }
          const ch = xml.charCodeAt(q + 4);
          if (isWs(ch) || ch === 62 || ch === 47) break;
          q += 4;
        }
        if (q < 0) { hi = mid; continue; }
        const r = rowNo(q);
        if (r < 0) { canJump = false; return from; }
        if (r < t) { best = q; lo = q + 4; } else hi = mid;
      }
      return best < 0 ? from : best;
    };
    const flush = (i) => { if (i > copyFrom) { parts.push([copyFrom, i]); copyFrom = i; } };
    while (hasRows) {
      if (needJump && canJump && ep < erows.length && killRanges.length === 0 && dataEnd - pos > 65536) { pos = jump(pos, erows[ep]); needJump = false; }
      const i = xml.indexOf('<row', pos);
      if (i < 0 || i >= dataEnd) break;
      const ch = xml.charCodeAt(i + 4);
      if (!(isWs(ch) || ch === 62 || ch === 47)) { pos = i + 4; continue; }
      const rgt = xml.indexOf('>', i);
      const ra = attr(xml.slice(i, rgt), 'r');
      const rn = ra !== null ? parseInt(ra, 10) : lastRn + 1;
      lastRn = rn;
      while (ep < erows.length && erows[ep] < rn) {
        const s = newRow(erows[ep], rowsMap.get(erows[ep]));
        ep++;
        if (s) { flush(i); parts.push(s); changed = true; }
        needJump = true;
      }
      const rsc = xml.charCodeAt(rgt - 1) === 47;
      let cmap;
      if (ep < erows.length && erows[ep] === rn) { cmap = rowsMap.get(rn); ep++; needJump = true; }
      if (cmap || inKill(rn)) {
        const rowEnd = rsc ? rgt + 1 : xml.indexOf('</row>', rgt) + 6;
        const s = rebuildRow(i, rgt, rsc, rowEnd, rn, cmap);
        if (s !== null) { flush(i); parts.push(s); copyFrom = rowEnd; changed = true; }
        pos = rowEnd;
      } else pos = rgt + 1;
    }
    flush(dataEnd);
    while (ep < erows.length) {
      const s = newRow(erows[ep], rowsMap.get(erows[ep]));
      ep++;
      if (s) { parts.push(s); changed = true; }
    }
    if (!changed) return null;
    if (selfClosed) parts.push('</sheetData>', [gt + 1, xml.length]);
    else parts.push([dataEnd, xml.length]);
    return parts;
  }

  function checkArrays(xml, rowsMap, sheetName) {
    const re = /<f\b[^>]*\st\s*=\s*["']array["'][^>]*>/g;
    const arrays = [];
    let m;
    while ((m = re.exec(xml))) {
      const cs = xml.lastIndexOf('<c', m.index);
      if (cs < 0) continue;
      const ref = attr(xml.slice(cs, xml.indexOf('>', cs)), 'r');
      const fa = parseAttrs(m[0]);
      if (!ref || !fa.ref) continue;
      const rg = parseRange(fa.ref);
      rg.mr = rowOfRef(ref); rg.mc = colOfRef(ref); rg.text = fa.ref;
      arrays.push(rg);
    }
    if (!arrays.length) return;
    const hit = (r, c) => {
      for (const a of arrays) {
        if (r < a.r1 || r > a.r2 || c < a.c1 || c > a.c2 || (rowsMap.has(a.mr) && rowsMap.get(a.mr).has(a.mc))) continue;
        throw new Error('Cannot change part of an array formula: ' + colName(c - 1) + r + ' is inside the array ' + a.text.replace(/\$/g, '') + ' on sheet "' + sheetName + '". Edit its first cell ' + colName(a.mc - 1) + a.mr + ' or clear the whole array.');
      }
    };
    for (const [r, cm] of rowsMap) for (const c of cm.keys()) hit(r, c);
  }

  function fixDimension(head, bbox, empty) {
    const i = head.indexOf('<dimension');
    if (i < 0 || !bbox) return head;
    const gt = head.indexOf('>', i);
    const tag = head.slice(i, gt + 1);
    const m = /\sref\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
    if (!m) return head;
    let { r1, c1, r2, c2 } = bbox;
    if (!empty) {
      const o = parseRange(m[1] !== undefined ? m[1] : m[2]);
      if (o.r1 && o.c1) { r1 = Math.min(r1, o.r1); c1 = Math.min(c1, o.c1); r2 = Math.max(r2, o.r2); c2 = Math.max(c2, o.c2); }
    }
    const a = colName(c1 - 1) + r1, b = colName(c2 - 1) + r2;
    const nt = tag.replace(m[0], ' ref="' + (a === b ? a : a + ':' + b) + '"');
    return head.slice(0, i) + nt + head.slice(gt + 1);
  }

  // ---- workbook-level ----
  function setFullCalc(wb) {
    const re = /<((?:[\w.-]+:)?)calcPr\b([^>]*?)(\/?)>/;
    const m = re.exec(wb);
    if (m) {
      let a = m[2];
      if (/\sfullCalcOnLoad\s*=/.test(a)) a = a.replace(/\sfullCalcOnLoad\s*=\s*(?:"[^"]*"|'[^']*')/, ' fullCalcOnLoad="1"');
      else a = a.replace(/\s+$/, '') + ' fullCalcOnLoad="1"';
      return wb.slice(0, m.index) + '<' + m[1] + 'calcPr' + a + m[3] + '>' + wb.slice(m.index + m[0].length);
    }
    const pm = /<((?:[\w.-]+:)?)sheets[\s>]/.exec(wb);
    const pre = pm ? pm[1] : '';
    const el = '<' + pre + 'calcPr fullCalcOnLoad="1"/>';
    const nxt = new RegExp('<' + pre + '(?:oleSize|customWorkbookViews|pivotCaches|smartTagPr|smartTagTypes|webPublishing|fileRecoveryPr|webPublishObjects|extLst)[\\s/>]');
    let at = wb.search(nxt);
    if (at < 0) at = wb.lastIndexOf('</' + pre + 'workbook>');
    if (at < 0) throw new Error('Malformed workbook.xml');
    return wb.slice(0, at) + el + wb.slice(at);
  }

  function dropCalcChain(files, wbKey, rels) {
    const paths = new Set();
    for (const r of rels) if (/\/calcChain$/.test(r.type) || /(^|\/)calcChain\.xml$/i.test(r.target)) paths.add(resolveTarget(dirOf(wbKey), r.target));
    const dflt = findFile(files, 'xl/calcChain.xml');
    if (dflt) paths.add(dflt);
    const found = [];
    for (const p of paths) { const k = findFile(files, p); if (k) { found.push(k); delete files[k]; } }
    const lower = new Set(Array.from(paths).concat(found).map((p) => '/' + p.toLowerCase()));
    const ctKey = findFile(files, '[Content_Types].xml');
    if (ctKey) {
      const x = decodeXml(files[ctKey], ctKey);
      const y = x.replace(/<(?:[\w.-]+:)?Override\b[^>]*?(?:\/>|>\s*<\/(?:[\w.-]+:)?Override>)/g, (t) => {
        const a = parseAttrs(t);
        return a.PartName && lower.has(a.PartName.toLowerCase()) ? '' : t;
      });
      if (y !== x) files[ctKey] = enc(y);
    }
    const rk = findFile(files, relsOf(wbKey));
    if (rk) {
      const x = decodeXml(files[rk], rk);
      const y = x.replace(/<(?:[\w.-]+:)?Relationship\b[^>]*?(?:\/>|>\s*<\/(?:[\w.-]+:)?Relationship>)/g, (t) => {
        const a = parseAttrs(t);
        return /\/calcChain$/.test(a.Type || '') || lower.has('/' + resolveTarget(dirOf(wbKey), a.Target || '').toLowerCase()) ? '' : t;
      });
      if (y !== x) files[rk] = enc(y);
    }
  }
  const enc = (s) => new TextEncoder().encode(s);

  // ---- binary-string helpers (latin1: 1 char = 1 byte) ----
  const MAXSTR = 0x1fffffe8;
  const TOO_BIG = 'sheet too large to edit';
  const ZIP_BOMB = 'File is too large or looks like a zip bomb';
  const ZL = () => Object.assign({ maxEntries: 100000, maxTotal: 2 * 1024 ** 3, maxPart: 256 * 1024 ** 2, maxSheet: 1.5 * 1024 ** 3, ratio: 1000, ratioMin: 256 * 1024 ** 2 }, OX.zipLimits);
  const bombErr = () => { const e = new Error(ZIP_BOMB); e.code = 'ZIPBOMB'; return e; };
  function latin1(u8) {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.length).latin1Slice(0, u8.length);
    let s = '';
    for (let i = 0; i < u8.length; i += 16384) s += String.fromCharCode.apply(null, u8.subarray(i, i + 16384));
    return s;
  }
  function strToBin(s) { return /[^\x00-\x7f]/.test(s) ? latin1(enc(s)) : s; }
  function binToStr(s) {
    if (!/[\x80-\xff]/.test(s)) return s;
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return dec().decode(u);
  }

  // ---- crc32 (slice-by-8) ----
  let CRC_T = null;
  function crc32(c, b, i, end) {
    if (!CRC_T) {
      CRC_T = new Int32Array(2048);
      for (let n = 0; n < 256; n++) { let v = n; for (let k = 0; k < 8; k++) v = v & 1 ? (v >>> 1) ^ 0xEDB88320 : v >>> 1; CRC_T[n] = v; }
      for (let n = 0; n < 256; n++) { let v = CRC_T[n]; for (let t = 1; t < 8; t++) { v = CRC_T[v & 255] ^ (v >>> 8); CRC_T[t * 256 + n] = v; } }
    }
    const T = CRC_T;
    for (; i + 8 <= end; i += 8) {
      const a = c ^ (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24);
      c = T[1792 + (a & 255)] ^ T[1536 + ((a >>> 8) & 255)] ^ T[1280 + ((a >>> 16) & 255)] ^ T[1024 + (a >>> 24)] ^ T[768 + b[i + 4]] ^ T[512 + b[i + 5]] ^ T[256 + b[i + 6]] ^ T[b[i + 7]];
    }
    for (; i < end; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8);
    return c;
  }

  // ---- zip container: central-directory reader / raw-copy writer ----
  const u16 = (b, o) => b[o] | b[o + 1] << 8;
  const u32 = (b, o) => (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
  const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 4294967296;
  const badZip = (m) => new Error('Corrupt or unsupported zip: ' + m);

  function zipName(nb, flag) {
    let ascii = true;
    for (let i = 0; i < nb.length; i++) if (nb[i] > 127) { ascii = false; break; }
    if (ascii) return latin1(nb);
    if (flag & 0x800) return dec().decode(nb);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(nb); } catch (_) { return latin1(nb); }
  }

  function readZip(b) {
    const n = b.length;
    let eo = -1;
    for (let i = n - 22, lim = Math.max(0, n - 22 - 65535); i >= lim; i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6 && i + 22 + u16(b, i + 20) <= n) { eo = i; break; }
    }
    if (eo < 0) throw badZip('no end of central directory');
    let cnt = u16(b, eo + 10), cdSize = u32(b, eo + 12), cdOff = u32(b, eo + 16), z64 = -1;
    if (cnt === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) {
      if (eo >= 20 && u32(b, eo - 20) === 0x07064b50) {
        const zo = u64(b, eo - 12);
        if (zo + 56 <= n && u32(b, zo) === 0x06064b50) { z64 = zo; cnt = u64(b, zo + 32); cdSize = u64(b, zo + 40); cdOff = u64(b, zo + 48); }
      }
    }
    let delta = 0;
    if (cdOff + 4 > n || u32(b, cdOff) !== 0x02014b50) { // prefixed data (e.g. a stub): offsets are relative to the zip start
      const alt = (z64 >= 0 ? z64 : eo) - cdSize;
      if (alt >= 0 && u32(b, alt) === 0x02014b50) { delta = alt - cdOff; cdOff = alt; } else if (cnt) throw badZip('bad central directory offset');
    }
    const ents = [], LM = ZL();
    let p = cdOff, declared = 0;
    if (cnt > LM.maxEntries) throw bombErr();
    for (let k = 0; k < cnt; k++) {
      if (p + 46 > n || u32(b, p) !== 0x02014b50) throw badZip('bad central directory entry');
      const nl = u16(b, p + 28), el = u16(b, p + 30), cl = u16(b, p + 32);
      if (p + 46 + nl + el + cl > n) throw badZip('truncated central directory');
      const e = {
        madeBy: u16(b, p + 4), need: u16(b, p + 6), flag: u16(b, p + 8), method: u16(b, p + 10), time: u16(b, p + 12), date: u16(b, p + 14),
        crc: u32(b, p + 16), csize: u32(b, p + 20), usize: u32(b, p + 24), iattr: u16(b, p + 36), eattr: u32(b, p + 38), lho: u32(b, p + 42),
        nameBytes: b.subarray(p + 46, p + 46 + nl), comment: b.subarray(p + 46 + nl + el, p + 46 + nl + el + cl), extra: null, cache: undefined, mod: undefined, name: '',
      };
      e.name = zipName(e.nameBytes, e.flag);
      // extra fields: zip64 values are folded in; the rest is kept when well formed
      const ex = b.subarray(p + 46 + nl, p + 46 + nl + el);
      const keep = [];
      let ok = true;
      for (let q = 0; q < ex.length;) {
        if (q + 4 > ex.length) { ok = false; break; }
        const id = u16(ex, q), sz = u16(ex, q + 2);
        if (q + 4 + sz > ex.length) { ok = false; break; }
        if (id === 1) {
          let o = q + 4;
          const rd = () => { const v = o + 8 <= q + 4 + sz ? u64(ex, o) : 0; o += 8; return v; };
          if (e.usize === 0xFFFFFFFF) e.usize = rd();
          if (e.csize === 0xFFFFFFFF) e.csize = rd();
          if (e.lho === 0xFFFFFFFF) e.lho = rd();
        } else keep.push(ex.subarray(q, q + 4 + sz));
        q += 4 + sz;
      }
      e.extra = ok ? keep : [];
      e.lho += delta;
      declared += e.usize;
      if (e.usize > LM.maxSheet || declared > LM.maxTotal) throw bombErr();
      ents.push(e);
      p += 46 + nl + el + cl;
    }
    return ents;
  }

  // start of an entry's data, validated against the local header
  function dataStart(b, e) {
    const o = e.lho;
    if (o + 30 > b.length || u32(b, o) !== 0x04034b50) throw badZip('bad local header for ' + e.name);
    const ds = o + 30 + u16(b, o + 26) + u16(b, o + 28);
    if (ds + e.csize > b.length) throw badZip('truncated entry ' + e.name);
    return ds;
  }

  function inflateEntry(b, e) {
    if (e.flag & 1) throw new Error('Encrypted zip entry: ' + e.name);
    if (e.method !== 0 && e.method !== 8) throw new Error('Unsupported zip compression method ' + e.method + ' for ' + e.name);
    const ds = dataStart(b, e);
    const raw = b.subarray(ds, ds + e.csize);
    if (e.method === 0) return raw;
    if (e.csize === 0) return new Uint8Array(0);
    const f = root.fflate, LM = ZL();
    const limit = /(^|\/)worksheets\/[^/]*\.xml$/i.test(e.name) ? Math.min(LM.maxSheet, MAXSTR * 2) : LM.maxPart;
    if (e.usize > limit) throw limit === MAXSTR * 2 && e.usize <= LM.maxSheet ? new Error(TOO_BIG) : bombErr();
    const parts = [];
    let got = 0, fed = 0;
    const inf = new f.Inflate((c) => {
      got += c.length;
      if (got > limit || (got > LM.ratioMin && got > LM.ratio * Math.max(1, fed))) throw bombErr();
      parts.push(c);
    });
    for (let o = 0; ; o += 262144) {
      const end = Math.min(raw.length, o + 262144);
      fed = end;
      inf.push(raw.subarray(o, end), end >= raw.length);
      if (end >= raw.length) break;
    }
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(got);
    let q = 0;
    for (const c of parts) { out.set(c, q); q += c.length; }
    return out;
  }

  // lazy name -> bytes view of the package (entries are inflated on first read)
  function openZip(b) {
    const entries = readZip(b);
    const files = Object.create(null);
    for (const e of entries) {
      Object.defineProperty(files, e.name, {
        enumerable: true, configurable: true,
        get() { return e.mod !== undefined ? e.mod : e.cache !== undefined ? e.cache : (e.cache = inflateEntry(b, e)); },
        set(v) { e.mod = v; },
      });
    }
    return { entries, files };
  }

  // piece = binary string | Uint8Array | [from, to) range of base. Returns raw-deflated data, crc, size.
  function packParts(parts, base, level) {
    const F = root.fflate;
    const out = [];
    let olen = 0;
    const d = new F.Deflate({ level });
    d.ondata = (c) => { out.push(c); olen += c.length; };
    let crc = -1, usize = 0, buf = new Uint8Array(1 << 20), bl = 0;
    const push = (u) => { crc = crc32(crc, u, 0, u.length); usize += u.length; d.push(u, false); };
    const flushBuf = () => { if (bl) { push(buf.subarray(0, bl)); buf = new Uint8Array(1 << 20); bl = 0; } };
    const put = (u) => {
      if (u.length < 65536) {
        if (bl + u.length > buf.length) flushBuf();
        buf.set(u, bl); bl += u.length;
      } else {
        flushBuf();
        for (let i = 0; i < u.length; i += 4194304) push(u.subarray(i, Math.min(u.length, i + 4194304)));
      }
    };
    for (const p of parts) {
      if (typeof p === 'string') {
        for (let i = 0; i < p.length; i += 65536) {
          const m = Math.min(p.length, i + 65536) - i;
          if (bl + m > buf.length) flushBuf();
          for (let k = 0; k < m; k++) buf[bl + k] = p.charCodeAt(i + k);
          bl += m;
        }
      } else if (p instanceof Uint8Array) put(p);
      else if (p[1] > p[0]) put(base.subarray(p[0], p[1]));
    }
    flushBuf();
    d.push(new Uint8Array(0), true);
    let data = out[0];
    if (out.length !== 1) { data = new Uint8Array(olen); let o = 0; for (const c of out) { data.set(c, o); o += c.length; } }
    return { data, crc: (crc ^ -1) >>> 0, usize };
  }

  function w16(b, o, v) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; }
  function w32(b, o, v) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; }

  // order: entries to emit; repl: Map(entry -> packed) for rewritten ones, the rest are copied as raw compressed bytes
  function writeZip(src, order, repl) {
    const LIM = 0xFFFFFFFF;
    const pieces = [], central = [];
    let pos = 0, cdSize = 0;
    const push = (u) => { if (u.length) { pieces.push(u); pos += u.length; } };
    for (const e of order) {
      const rp = repl.get(e);
      const nb = e.nameBytes;
      let flag, method, crc, csize, usize, body, hdr = null;
      const off = pos;
      if (rp) {
        flag = e.flag & 0x800; method = 8; crc = rp.crc; csize = rp.data.length; usize = rp.usize; body = rp.data;
      } else {
        const ds = dataStart(src, e);
        body = src.subarray(ds, ds + e.csize);
        flag = e.flag; method = e.method; crc = e.crc; csize = e.csize; usize = e.usize;
        // data descriptor / zip64-marker local headers are rewritten with the real crc and sizes
        if (flag & 8) flag &= ~8;
        else if (u32(src, e.lho + 18) === LIM || u32(src, e.lho + 22) === LIM) { /* rewrite */ } else hdr = src.subarray(e.lho, ds);
      }
      if (csize >= LIM || usize >= LIM || off >= LIM) throw new Error('Package too large to rewrite');
      if (hdr === null) {
        hdr = new Uint8Array(30 + nb.length);
        w32(hdr, 0, 0x04034b50); w16(hdr, 4, method === 8 ? 20 : 10);
        w16(hdr, 6, flag); w16(hdr, 8, method); w16(hdr, 10, e.time); w16(hdr, 12, e.date);
        w32(hdr, 14, crc); w32(hdr, 18, csize); w32(hdr, 22, usize); w16(hdr, 26, nb.length); w16(hdr, 28, 0);
        hdr.set(nb, 30);
      }
      push(hdr); push(body);
      let xl = 0;
      for (const x of e.extra) xl += x.length;
      const cr = new Uint8Array(46 + nb.length + xl + e.comment.length);
      w32(cr, 0, 0x02014b50); w16(cr, 4, e.madeBy); w16(cr, 6, Math.min(e.need || 20, 20)); w16(cr, 8, flag); w16(cr, 10, method);
      w16(cr, 12, e.time); w16(cr, 14, e.date); w32(cr, 16, crc); w32(cr, 20, csize); w32(cr, 24, usize);
      w16(cr, 28, nb.length); w16(cr, 30, xl); w16(cr, 32, e.comment.length); w16(cr, 34, 0); w16(cr, 36, e.iattr); w32(cr, 38, e.eattr); w32(cr, 42, off);
      let o = 46;
      cr.set(nb, o); o += nb.length;
      for (const x of e.extra) { cr.set(x, o); o += x.length; }
      cr.set(e.comment, o);
      central.push(cr); cdSize += cr.length;
    }
    const cdOff = pos;
    const z64 = order.length >= 0xFFFF;
    const total = pos + cdSize + (z64 ? 76 : 0) + 22;
    if (total >= LIM) throw new Error('Package too large to rewrite');
    const out = new Uint8Array(total);
    let o = 0;
    for (const u of pieces) { out.set(u, o); o += u.length; }
    for (const u of central) { out.set(u, o); o += u.length; }
    if (z64) { // zip64 end record + locator
      w32(out, o, 0x06064b50); w32(out, o + 4, 44); w16(out, o + 12, 45); w16(out, o + 14, 45);
      w32(out, o + 24, order.length); w32(out, o + 32, order.length); w32(out, o + 40, cdSize); w32(out, o + 48, cdOff);
      w32(out, o + 56, 0x07064b50); w32(out, o + 64, cdOff + cdSize); w32(out, o + 72, 1);
      o += 76;
    }
    w32(out, o, 0x06054b50);
    w16(out, o + 8, z64 ? 0xFFFF : order.length); w16(out, o + 10, z64 ? 0xFFFF : order.length);
    w32(out, o + 12, cdSize); w32(out, o + 16, cdOff);
    return out;
  }

  // ---- public API ----
  function patchXlsxSheets(original, editsBySheet, options) {
    const fflate = root.fflate;
    if (!fflate) throw new Error('fflate not loaded');
    options = options || {};
    const idxs = Object.keys(editsBySheet).map(Number).sort((a, b) => a - b);
    // validate and normalize before touching anything
    const norm = new Map();
    for (const si of idxs) {
      if (!Number.isInteger(si) || si < 0) throw new Error('Invalid sheet index ' + si);
      const rows = new Map();
      for (const e of editsBySheet[si]) {
        if (!e || !Number.isInteger(e.r) || !Number.isInteger(e.c) || e.r < 0 || e.c < 0 || e.r >= MAXR || e.c >= MAXC) throw new Error('Cell out of range: r=' + (e && e.r) + ' c=' + (e && e.c));
        const cell = normCell(e.cell === undefined ? null : e.cell);
        let rm = rows.get(e.r + 1);
        if (!rm) rows.set(e.r + 1, (rm = new Map()));
        rm.set(e.c + 1, cell);
      }
      if (rows.size) norm.set(si, rows);
    }
    if (!norm.size) return original;

    const zip = openZip(original);
    const files = zip.files;
    const entryOf = new Map();
    for (const e of zip.entries) entryOf.set(e.name, e);
    const info = locateSheets(files);
    const sheetPacked = new Map();
    let styler = null, changed = false;
    const derive = (base, code) => (styler || (styler = createStyler(files, info.wbKey, info.rels))).derive(base, code);
    for (const [si, rowsMap] of norm) {
      if (si >= info.sheets.length) throw new Error('Sheet index out of range: ' + si);
      const sh = info.sheets[si];
      const key = sh.path && findFile(files, sh.path);
      if (!key) throw new Error('Worksheet part not found for sheet ' + si);
      if (sh.rel && !/\/worksheet$/.test(sh.rel.type)) throw new Error('Sheet ' + si + ' is not a worksheet');
      let r1 = Infinity, c1 = Infinity, r2 = 0, c2 = 0;
      for (const [r, cm] of rowsMap) for (const [c, cell] of cm) {
        if (cell === null) continue;
        if (r < r1) r1 = r; if (r > r2) r2 = r; if (c < c1) c1 = c; if (c > c2) c2 = c;
      }
      const bbox = r2 ? { r1, c1, r2, c2 } : null;
      const tables = patchTables(files, key, rowsMap, sh.name || String(si));
      const ent = entryOf.get(key);
      if (ent.method === 8 && ent.usize > MAXSTR) throw new Error(TOO_BIG);
      let base = files[key];
      if (base.length > MAXSTR) throw new Error(TOO_BIG);
      if (base.length >= 2 && ((base[0] === 0xFF && base[1] === 0xFE) || (base[0] === 0xFE && base[1] === 0xFF))) throw new Error('UTF-16 XML part not supported: ' + key);
      let bin;
      try { bin = latin1(base); } catch (e) { if (e instanceof RangeError) throw new Error(TOO_BIG); throw e; }
      const parts = patchSheetXml(bin, rowsMap, bbox, sh.name || String(si), derive);
      bin = null;
      if (parts !== null) {
        sheetPacked.set(key, packParts(parts, base, base.length > 4e6 ? 1 : 6));
        for (const t of tables) files[t.key] = enc(t.xml);
        changed = true;
      }
      ent.cache = undefined; base = null;
    }
    if (!changed) return original;
    if (styler) { const st = styler.finalize(); files[st.key] = enc(st.xml); }
    if (options.fullCalcOnLoad !== false) {
      files[info.wbKey] = enc(setFullCalc(info.wb));
      dropCalcChain(files, info.wbKey, info.rels);
    }
    // emit: [Content_Types].xml first, original order, removed entries dropped, rewritten ones recompressed
    const repl = new Map(), order = [];
    const ctKey = findFile(files, '[Content_Types].xml');
    const emit = (name) => {
      const e = entryOf.get(name);
      if (!e || !(name in files)) return;
      if (sheetPacked.has(name)) repl.set(e, sheetPacked.get(name));
      else if (e.mod !== undefined) repl.set(e, packParts([e.mod], null, e.mod.length > 4e6 ? 3 : 6));
      order.push(e);
    };
    if (ctKey) emit(ctKey);
    for (const e of zip.entries) if (e.name !== ctKey && entryOf.get(e.name) === e) emit(e.name);
    return writeZip(original, order, repl);
  }

  function patchXlsx(original, edits, options) {
    if (!(original instanceof Uint8Array)) throw new Error('originalBytes must be a Uint8Array');
    const by = {};
    for (const e of edits || []) {
      if (!e || !Number.isInteger(e.sheet) || e.sheet < 0) throw new Error('Invalid sheet index ' + (e && e.sheet));
      (by[e.sheet] || (by[e.sheet] = [])).push(e);
    }
    return patchXlsxSheets(original, by, options);
  }

  OX.patchXlsx = patchXlsx;
  OX.patchXlsxSheets = patchXlsxSheets;
  OX.escapeXml = escapeXml;
  OX.validateFormula = validateFormula;
  OX.addFormulaPrefixes = addXlfn;
  OX.writerShiftFormula = shiftFormula;
  if (typeof module !== 'undefined' && module.exports) module.exports = OX;
})(typeof globalThis !== 'undefined' ? globalThis : this);
