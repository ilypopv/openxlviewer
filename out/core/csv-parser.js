(function (root) {
    'use strict';
    const OX = root.OX || (root.OX = {});

    // JS \s set
    function isWs(c) {
        return (
            c === 32 ||
            (c >= 9 && c <= 13) ||
            c === 0xa0 ||
            c === 0x1680 ||
            (c >= 0x2000 && c <= 0x200a) ||
            c === 0x2028 ||
            c === 0x2029 ||
            c === 0x202f ||
            c === 0x205f ||
            c === 0x3000 ||
            c === 0xfeff
        );
    }

    // Counts source line breaks: \n, \r\n and lone \r each count once.
    function lineBreaks(s) {
        let n = 0,
            i = s.indexOf('\n');
        const hasCr = s.indexOf('\r') >= 0;
        if (!hasCr) {
            while (i >= 0) {
                n++;
                i = s.indexOf('\n', i + 1);
            }
            return n;
        }
        for (i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c === 10) n++;
            else if (c === 13 && s.charCodeAt(i + 1) !== 10) n++;
        }
        return n;
    }

    function growI32(a, cap) {
        const b = new Int32Array(cap);
        b.set(a);
        return b;
    }

    // Parity scanner: a quote char anywhere toggles quoted state (lenient, same as the legacy regex parser).
    function parseCsv(text, opts) {
        opts = opts || {};
        text = text == null ? '' : String(text);
        let sep = opts.separator == null || opts.separator === '' ? ',' : String(opts.separator);
        const quoteStr = opts.quote ? String(opts.quote).charAt(0) : '"';
        const q = quoteStr.charCodeAt(0);
        const dq = quoteStr + quoteStr;
        const hasHeaders = !!opts.hasHeaders;
        const skipComments = !!opts.skipComments;
        const cm = opts.commentChar ? String(opts.commentChar) : '';
        let sepCode = sep.charCodeAt(0),
            sepLen = sep.length,
            multi = sepLen > 1;
        const n = text.length;
        let pos = n && text.charCodeAt(0) === 0xfeff ? 1 : 0;
        let line = 0;
        let first = true;
        let sepDirective = null;

        let starts = new Int32Array(64),
            ends = new Int32Array(64);
        let cap = 1024;
        let rowLine = new Int32Array(cap),
            rowSpan = new Int32Array(cap),
            qmask = new Int32Array(cap);
        let qextra = null;
        const rows = [];
        let nr = 0;
        let header = null,
            headerLine = -1,
            headerSpan = 0;
        let colCount = 0;
        let qflag = false;

        function mk(s, e) {
            if (e - s >= 2 && text.charCodeAt(s) === q && text.charCodeAt(e - 1) === q) {
                qflag = true;
                const inner = text.substring(s + 1, e - 1);
                return inner.length > 1 && inner.indexOf(dq) >= 0 ? inner.split(dq).join(quoteStr) : inner;
            }
            qflag = false;
            return text.substring(s, e);
        }

        while (pos < n) {
            const c0 = text.charCodeAt(pos);
            if (c0 === 10) {
                pos++;
                line++;
                continue;
            }
            if (c0 === 13) {
                pos++;
                if (text.charCodeAt(pos) === 10) pos++;
                line++;
                continue;
            }
            const ls = pos;
            let nf = 0,
                fs = pos,
                par = 0,
                nl = 0,
                i = pos;
            for (; i < n; i++) {
                const c = text.charCodeAt(i);
                if (c === q) par ^= 1;
                else if (par === 0) {
                    if (c === sepCode && (!multi || text.startsWith(sep, i))) {
                        if (nf === starts.length) {
                            starts = growI32(starts, nf * 2);
                            ends = growI32(ends, nf * 2);
                        }
                        starts[nf] = fs;
                        ends[nf] = i;
                        nf++;
                        fs = i + sepLen;
                        i += sepLen - 1;
                    } else if (c === 10 || c === 13) break;
                } else if (c === 10) nl++;
                else if (c === 13 && text.charCodeAt(i + 1) !== 10) nl++;
            }
            if (nf === starts.length) {
                starts = growI32(starts, nf * 2);
                ends = growI32(ends, nf * 2);
            }
            starts[nf] = fs;
            ends[nf] = i;
            nf++;
            const le = i;
            let term = false;
            if (i < n) {
                term = true;
                if (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) === 10) i++;
                i++;
            }
            pos = i;
            const lineAt = line;
            line += nl + (term ? 1 : 0);

            if (first) {
                first = false;
                if (le - ls < 256) {
                    const stripped = text.substring(ls, le).replace(/ /g, '');
                    if (stripped.slice(0, 4).toLowerCase() === 'sep=') {
                        if (stripped.length === 5) {
                            sepDirective = stripped.charAt(4);
                            sep = sepDirective;
                            sepCode = sep.charCodeAt(0);
                            sepLen = 1;
                            multi = false;
                        }
                        continue;
                    }
                }
            }
            if (skipComments) {
                let k = ls;
                while (k < le && isWs(text.charCodeAt(k))) k++;
                if (k === le || (cm && text.startsWith(cm, k))) continue;
            }
            if (nf > colCount) colCount = nf;

            if (hasHeaders && header === null) {
                header = new Array(nf);
                for (let j = 0; j < nf; j++) header[j] = mk(starts[j], ends[j]);
                headerLine = lineAt;
                headerSpan = nl + 1;
                continue;
            }
            const row = new Array(nf);
            let mask = 0;
            for (let j = 0; j < nf; j++) {
                row[j] = mk(starts[j], ends[j]);
                if (qflag) {
                    if (j < 32) mask |= 1 << j;
                    else {
                        if (!qextra) qextra = new Set();
                        qextra.add(nr * 1048576 + j);
                    }
                }
            }
            if (nr === cap) {
                cap *= 2;
                rowLine = growI32(rowLine, cap);
                rowSpan = growI32(rowSpan, cap);
                qmask = growI32(qmask, cap);
            }
            rowLine[nr] = lineAt;
            rowSpan[nr] = nl + 1;
            qmask[nr] = mask;
            rows.push(row);
            nr++;
        }

        if (colCount === 0) colCount = 1;
        if (hasHeaders) {
            if (header === null) header = [];
            while (header.length < colCount) header.push('');
        }
        const endsWithNewline =
            n === 0 || (pos >= n && (text.charCodeAt(n - 1) === 10 || text.charCodeAt(n - 1) === 13));
        return {
            header,
            rows,
            colCount,
            sepDirective,
            rowLine: rowLine.slice(0, nr),
            rowSpan: rowSpan.slice(0, nr),
            headerLine,
            headerSpan,
            lineCount: line + 1,
            endsWithNewline,
            quotedMask: qmask.slice(0, nr),
            quotedExtra: qextra
        };
    }

    // ---- byte-level incremental index (see CsvIndex) ----
    const P10 = [
        1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19,
        1e20, 1e21, 1e22
    ];
    let _enc = null,
        _dec = null;
    const encoder = () => _enc || (_enc = new TextEncoder());
    const decoder = () => _dec || (_dec = new TextDecoder('utf-8', { ignoreBOM: true }));
    const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const tmp16 = new Uint16Array(64);

    function toBytes(x) {
        if (x == null) return new Uint8Array(0);
        if (typeof x === 'string') return encoder().encode(x);
        return x;
    }

    // Number grammar on bytes [s,e): [+-]?(d+[.d*]|.d+)([eE][+-]?d+)?; returns NaN when not a number.
    // strict mirrors CsvProvider's isNumeric (<=15 int digits, no leading zeros, <=40 chars).
    function numBytes(b, s, e, strict) {
        const n = e - s;
        if (n <= 0 || (strict && n > 40)) return NaN;
        let i = s,
            c = b[i],
            neg = false;
        if (c === 45 || c === 43) {
            neg = c === 45;
            i++;
            if (i === e) return NaN;
        }
        const is = i;
        let m = 0,
            sig = 0;
        while (i < e && (c = b[i]) >= 48 && c <= 57) {
            if (sig || c !== 48) sig++;
            m = m * 10 + (c - 48);
            i++;
        }
        const intLen = i - is;
        if (strict && (intLen > 15 || (intLen > 1 && b[is] === 48))) return NaN;
        let frac = 0;
        if (i < e && b[i] === 46) {
            i++;
            const fs = i;
            while (i < e && (c = b[i]) >= 48 && c <= 57) {
                if (sig || c !== 48) sig++;
                m = m * 10 + (c - 48);
                i++;
            }
            frac = i - fs;
        }
        if (intLen === 0 && frac === 0) return NaN;
        let ex = 0;
        if (i < e && ((c = b[i]) === 101 || c === 69)) {
            i++;
            let eneg = false;
            if (i < e && ((c = b[i]) === 43 || c === 45)) {
                eneg = c === 45;
                i++;
            }
            const es = i;
            while (i < e && (c = b[i]) >= 48 && c <= 57) {
                if (ex < 100000) ex = ex * 10 + (c - 48);
                i++;
            }
            if (i === es) return NaN;
            if (eneg) ex = -ex;
        }
        if (i !== e) return NaN;
        const x = ex - frac;
        let v;
        if (sig <= 15 && x >= -22 && x <= 22) v = x < 0 ? m / P10[-x] : m * P10[x];
        else {
            return Number(decoder().decode(b.subarray(s, e)));
        }
        return neg ? -v : v;
    }

    function matchAt(b, i, p) {
        for (let k = 1; k < p.length; k++) if (b[i + k] !== p[k]) return false;
        return true;
    }

    // Row index over a UTF-8 byte buffer: start offset, source line and line span per row; fields are located on demand.
    class CsvIndex {
        constructor(opts) {
            opts = opts || {};
            const sep = opts.separator == null || opts.separator === '' ? ',' : String(opts.separator);
            const quoteStr = opts.quote ? String(opts.quote).charAt(0) : '"';
            this.quoteStr = quoteStr;
            this.dq = quoteStr + quoteStr;
            this.qc = quoteStr.charCodeAt(0);
            this.qb = encoder().encode(quoteStr);
            this.q0 = this.qb[0];
            this.qlen = this.qb.length;
            this._setSep(sep);
            this.hasHeaders = !!opts.hasHeaders;
            this.skipComments = !!opts.skipComments;
            this.cm = opts.commentChar ? String(opts.commentChar) : '';
            this.cmb = this.cm ? encoder().encode(this.cm) : null;
            this.bytes = new Uint8Array(0);
            this.filled = 0;
            this.final = false;
            this.pos = 0;
            this.line = 0;
            this.first = true;
            this.started = false;
            this.cap = 1024;
            this.start = new Int32Array(this.cap);
            this.lineAt = new Int32Array(this.cap);
            this.span = new Int32Array(this.cap);
            this.n = 0;
            this.colCount = 0;
            this.header = null;
            this.headerLine = -1;
            this.headerSpan = 0;
            this.sepDirective = null;
            this.fs = new Int32Array(64);
            this.fe = new Int32Array(64);
            this.done = false;
            this.lineCount = 1;
            this.endsWithNewline = true;
        }

        _setSep(sep) {
            this.sep = sep;
            this.sepb = encoder().encode(sep);
            this.sep0 = this.sepb[0];
            this.sepLen = this.sepb.length;
        }

        // bytes may be reallocated between calls; filled = valid prefix length; final = no more data will follow.
        setSource(bytes, filled, final) {
            this.bytes = bytes;
            this.filled = filled;
            this.final = !!final;
        }

        decode(s, e) {
            const n = e - s;
            if (n <= 0) return '';
            const b = this.bytes;
            if (n <= 64) {
                let i = 0;
                for (; i < n; i++) {
                    const c = b[s + i];
                    if (c > 127) break;
                    tmp16[i] = c;
                }
                if (i === n) return String.fromCharCode.apply(null, tmp16.subarray(0, n));
            }
            return decoder().decode(b.subarray(s, e));
        }

        // Field value for bytes [s,e): strips the quote pair and unescapes doubled quotes (same rules as parseCsv).
        field(s, e) {
            if (e - s >= 2 && this.qlen === 1 && this.bytes[s] === this.q0 && this.bytes[e - 1] === this.q0) {
                const inner = this.decode(s + 1, e - 1);
                return inner.length > 1 && inner.indexOf(this.dq) >= 0
                    ? inner.split(this.dq).join(this.quoteStr)
                    : inner;
            }
            const raw = this.decode(s, e);
            if (raw.length >= 2 && raw.charCodeAt(0) === this.qc && raw.charCodeAt(raw.length - 1) === this.qc) {
                const inner = raw.substring(1, raw.length - 1);
                return inner.length > 1 && inner.indexOf(this.dq) >= 0
                    ? inner.split(this.dq).join(this.quoteStr)
                    : inner;
            }
            return raw;
        }

        isQuotedRange(s, e) {
            if (e - s < 2) return false;
            const b = this.bytes;
            if (this.qlen === 1) return b[s] === this.q0 && b[e - 1] === this.q0;
            const raw = this.decode(s, e);
            return raw.length >= 2 && raw.charCodeAt(0) === this.qc && raw.charCodeAt(raw.length - 1) === this.qc;
        }

        // Locates fields of the row starting at byte `st` into this.fs/this.fe; returns the field count.
        // With `upto`, stops once field index `upto` is recorded (later fields are not located).
        scanRow(st, upto) {
            if (upto === undefined) upto = 0x7fffffff;
            const b = this.bytes,
                end = this.filled,
                q0 = this.q0,
                qlen = this.qlen,
                qb = this.qb;
            const sep0 = this.sep0,
                sepLen = this.sepLen,
                sepb = this.sepb;
            let fs = this.fs,
                fe = this.fe,
                nf = 0,
                f0 = st,
                par = 0,
                i = st;
            for (; i < end; i++) {
                const c = b[i];
                if (c === q0 && (qlen === 1 || matchAt(b, i, qb))) {
                    par ^= 1;
                    i += qlen - 1;
                } else if (par === 0) {
                    if (c === sep0 && (sepLen === 1 || matchAt(b, i, sepb))) {
                        if (nf === fs.length) {
                            fs = this.fs = growI32(fs, nf * 2);
                            fe = this.fe = growI32(fe, nf * 2);
                        }
                        fs[nf] = f0;
                        fe[nf] = i;
                        nf++;
                        if (nf > upto) return nf;
                        i += sepLen - 1;
                        f0 = i + 1;
                    } else if (c === 10 || c === 13) break;
                }
            }
            if (nf === fs.length) {
                fs = this.fs = growI32(fs, nf * 2);
                fe = this.fe = growI32(fe, nf * 2);
            }
            fs[nf] = f0;
            fe[nf] = i;
            nf++;
            return nf;
        }

        _blankOrComment(ls, le) {
            const b = this.bytes;
            let k = ls;
            while (k < le) {
                const c = b[k];
                if (c === 32 || (c >= 9 && c <= 13)) k++;
                else if (c < 128) break;
                else {
                    const t = this.decode(ls, le);
                    let j = 0;
                    while (j < t.length && isWs(t.charCodeAt(j))) j++;
                    return j === t.length || (!!this.cm && t.startsWith(this.cm, j));
                }
            }
            if (k === le) return true;
            const cmb = this.cmb;
            if (!cmb) return false;
            if (k + cmb.length > le) return false;
            for (let x = 0; x < cmb.length; x++) if (b[k + x] !== cmb[x]) return false;
            return true;
        }

        _grow() {
            this.cap *= 2;
            this.start = growI32(this.start, this.cap);
            this.lineAt = growI32(this.lineAt, this.cap);
            this.span = growI32(this.span, this.cap);
        }

        // Indexes complete rows until the budget (ms, 0 = unbounded) is spent or data runs out; true when finished.
        run(budget) {
            if (this.done) return true;
            const b = this.bytes,
                end = this.filled,
                fin = this.final,
                q0 = this.q0,
                qlen = this.qlen,
                qb = this.qb;
            let sep0 = this.sep0,
                sepLen = this.sepLen,
                sepb = this.sepb;
            if (!this.started) {
                if (end > 0 && b[0] !== 0xef) this.started = true;
                else if (end >= 3) {
                    if (b[1] === 0xbb && b[2] === 0xbf) this.pos = 3;
                    this.started = true;
                } else if (fin) this.started = true;
                else return false;
            }
            const t0 = budget > 0 ? nowMs() : 0;
            let pos = this.pos,
                line = this.line,
                iter = 0;
            while (pos < end) {
                const c0 = b[pos];
                if (c0 === 10) {
                    pos++;
                    line++;
                    continue;
                }
                if (c0 === 13) {
                    if (pos + 1 >= end && !fin) break;
                    pos++;
                    if (b[pos] === 10) pos++;
                    line++;
                    continue;
                }
                const ls = pos;
                let nf = 0,
                    par = 0,
                    nl = 0,
                    i = pos;
                for (; i < end; i++) {
                    const c = b[i];
                    if (c === q0 && (qlen === 1 || matchAt(b, i, qb))) {
                        par ^= 1;
                        i += qlen - 1;
                    } else if (par === 0) {
                        if (c === sep0 && (sepLen === 1 || matchAt(b, i, sepb))) {
                            nf++;
                            i += sepLen - 1;
                        } else if (c === 10 || c === 13) break;
                    } else if (c === 10) nl++;
                    else if (c === 13 && b[i + 1] !== 10) nl++;
                }
                if (!fin && (i >= end || (b[i] === 13 && i + 1 >= end))) break;
                nf++;
                const le = i;
                let term = false;
                if (i < end) {
                    term = true;
                    if (b[i] === 13 && b[i + 1] === 10) i++;
                    i++;
                }
                pos = i;
                const lineAt = line;
                line += nl + (term ? 1 : 0);

                if (this.first) {
                    this.first = false;
                    if (le - ls < 1024) {
                        const t = this.decode(ls, le),
                            stripped = t.length < 256 ? t.replace(/ /g, '') : '';
                        if (stripped.slice(0, 4).toLowerCase() === 'sep=') {
                            if (stripped.length === 5) {
                                this.sepDirective = stripped.charAt(4);
                                this._setSep(this.sepDirective);
                                sep0 = this.sep0;
                                sepLen = this.sepLen;
                                sepb = this.sepb;
                            }
                            continue;
                        }
                    }
                }
                if (this.skipComments && this._blankOrComment(ls, le)) continue;
                if (nf > this.colCount) this.colCount = nf;

                if (this.hasHeaders && this.header === null) {
                    const k = this.scanRow(ls),
                        h = new Array(k);
                    for (let j = 0; j < k; j++) h[j] = this.field(this.fs[j], this.fe[j]);
                    this.header = h;
                    this.headerLine = lineAt;
                    this.headerSpan = nl + 1;
                    continue;
                }
                if (this.n === this.cap) this._grow();
                const nr = this.n++;
                this.start[nr] = ls;
                this.lineAt[nr] = lineAt;
                this.span[nr] = nl + 1;
                if (budget > 0 && (++iter & 127) === 0 && nowMs() - t0 > budget) break;
            }
            this.pos = pos;
            this.line = line;
            if (fin && pos >= end) this._finish();
            return this.done;
        }

        _finish() {
            this.done = true;
            const n = this.n,
                end = this.filled;
            if (this.colCount === 0) this.colCount = 1;
            if (this.hasHeaders) {
                if (this.header === null) this.header = [];
                while (this.header.length < this.colCount) this.header.push('');
            }
            if (this.cap > n + 16) {
                this.start = this.start.slice(0, n);
                this.lineAt = this.lineAt.slice(0, n);
                this.span = this.span.slice(0, n);
                this.cap = n;
            }
            if (this.bytes.length !== end) this.bytes = this.bytes.subarray(0, end);
            this.lineCount = this.line + 1;
            const last = end ? this.bytes[end - 1] : 10;
            this.endsWithNewline = end === 0 || last === 10 || last === 13;
        }

        // parseCsv-compatible views of the finished index.
        get rowLine() {
            return this.lineAt.subarray(0, this.n);
        }
        get rowSpan() {
            return this.span.subarray(0, this.n);
        }
    }

    function indexCsv(input, opts) {
        const bytes = toBytes(input);
        const ix = new CsvIndex(opts);
        ix.setSource(bytes, bytes.length, true);
        ix.run(0);
        return ix;
    }

    function serializeCsvField(text, sep, quote, forceQuote) {
        text = text == null ? '' : String(text);
        quote = quote || '"';
        sep = sep == null || sep === '' ? ',' : sep;
        let need = !!forceQuote;
        if (!need) {
            need =
                text.indexOf(quote) >= 0 ||
                text.indexOf(sep) >= 0 ||
                text.indexOf('\n') >= 0 ||
                text.indexOf('\r') >= 0;
        }
        if (!need) return text;
        return quote + (text.indexOf(quote) >= 0 ? text.split(quote).join(quote + quote) : text) + quote;
    }

    function serializeCsvRow(fields, sep, quote, quotedFlags) {
        sep = sep == null || sep === '' ? ',' : sep;
        let out = '';
        for (let i = 0; i < fields.length; i++) {
            if (i) out += sep;
            out += serializeCsvField(fields[i], sep, quote, quotedFlags ? quotedFlags[i] : false);
        }
        return out;
    }

    function detectSeparator(text) {
        const cands = [',', ';', '\t', '|'];
        text = text == null ? '' : String(text);
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        const lim = Math.min(text.length, 1 << 16);
        const lines = [];
        let counts = [0, 0, 0, 0],
            par = 0,
            any = false,
            startOfText = true;
        for (let i = 0; i <= lim; i++) {
            const c = i < lim ? text.charCodeAt(i) : -1;
            if (c === 34) {
                par ^= 1;
                any = true;
                continue;
            }
            if (par === 0 && (c === 10 || c === 13 || c === -1)) {
                if (any) {
                    if (startOfText) {
                        const m = /^\s*sep=(.)\s*$/i.exec(text.substring(0, i));
                        if (m) return m[1];
                    }
                    lines.push(counts);
                    if (lines.length >= 30) break;
                }
                startOfText = false;
                counts = [0, 0, 0, 0];
                any = false;
                if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
                continue;
            }
            any = true;
            if (par === 0) {
                if (c === 44) counts[0]++;
                else if (c === 59) counts[1]++;
                else if (c === 9) counts[2]++;
                else if (c === 124) counts[3]++;
            }
        }
        if (!lines.length) return ',';
        let best = -1,
            bestScore = 0,
            bestMode = 0;
        for (let k = 0; k < 4; k++) {
            const freq = new Map();
            for (const l of lines) if (l[k] > 0) freq.set(l[k], (freq.get(l[k]) || 0) + 1);
            let mode = 0,
                mc = 0;
            for (const [v, f] of freq)
                if (f > mc || (f === mc && v > mode)) {
                    mode = v;
                    mc = f;
                }
            const score = mc / lines.length;
            if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) < 1e-9 && score > 0 && mode > bestMode)) {
                best = k;
                bestScore = score;
                bestMode = mode;
            }
        }
        return best < 0 ? ',' : cands[best];
    }

    OX.parseCsv = parseCsv;
    OX.indexCsv = indexCsv;
    OX.CsvIndex = CsvIndex;
    OX.csvNumBytes = numBytes;
    OX.csvToBytes = toBytes;
    OX.serializeCsvField = serializeCsvField;
    OX.serializeCsvRow = serializeCsvRow;
    OX.detectSeparator = detectSeparator;
    OX.csvLineBreaks = lineBreaks;
    if (typeof module !== 'undefined' && module.exports) module.exports = OX;
})(typeof globalThis !== 'undefined' ? globalThis : this);
