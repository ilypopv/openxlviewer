var sendMessage;

function initPage() {
    const vscode = acquireVsCodeApi();
    const options = getOptions();
    const STATE_VERSION = '6';
    const readOnly = !options.customEditor;
    sendMessage = function (m) { vscode.postMessage(m); };

    const app = document.getElementById('app');
    let provider = null, shell = null, sepSent = false;
    // docVersion: document version the displayed rows were computed from (echoed with edits); transferring: a chunked refresh is in flight
    let docVersion = null, transferring = false;

    const saved = (function () {
        if (ignoreState()) return null;
        const s = vscode.getState() || options.state;
        return s && s.version === STATE_VERSION ? s : null;
    })();

    function measure(text) {
        let c = measure.ctx;
        if (!c) { c = measure.ctx = document.createElement('canvas').getContext('2d'); c.font = '13px system-ui'; }
        return c.measureText(text).width;
    }

    shell = new OX.Shell(app, {
        readOnly: readOnly,
        tabs: false,
        headerRows: function () { return provider ? provider.frozenRows : 0; },
        onEdit: applyEdits,
        onViewState: function (vs) {
            const state = { version: STATE_VERSION, uri: options.uri, view: vs };
            vscode.setState(state);
            vscode.postMessage({ save: true, state: state });
        },
        onLink: function () { }
    });

    if (!readOnly) {
        const add = document.createElement('button');
        add.className = 'ox-btn ox-add'; add.textContent = 'Add row'; add.title = 'Append a row at the end';
        add.addEventListener('click', addRow);
        shell.bar.insertBefore(add, shell.btnClear);
        shell.grid.on('contextmenu', onRowMenu);
    }

    function sourceRows(view) {
        const order = shell._order, rows = new Set();
        for (const rg of view.ranges) {
            const r2 = Math.min(rg.r2, (order ? order.length : provider.rowCount) - 1);
            for (let r = rg.r1; r <= r2; r++) rows.add(order ? order[r] : r);
        }
        return Array.from(rows);
    }

    function onRowMenu(e) {
        if (e.zone !== 'rowhdr' || !provider) return;
        e.handled = true;
        const sel = shell.grid.getSelection();
        const rows = sourceRows(sel).filter(function (r) { return !(provider.hasHeaders && r === 0); });
        const g = shell.grid;
        g._showMenu([
            ['Copy', '', function () { g.copy(false); }],
            null,
            ['Delete ' + (rows.length > 1 ? rows.length + ' rows' : 'row'), '', function () { deleteRows(rows); }, !rows.length],
            ['Add row at end', '', addRow]
        ], e.clientX, e.clientY);
    }

    function post(edits) {
        if (!edits.length) return;
        // an empty or comment-only file has no header line (-1): clamp so the host never sees negative lines
        const clean = edits.map(function (e) {
            const s = Math.max(0, e.start | 0);
            return { start: s, end: Math.max(s, e.end | 0), text: e.text };
        });
        sendMessage({ lineEdits: clean, version: docVersion });
        // the host applies a batch as exactly one document version
        if (docVersion !== null) docVersion++;
    }

    function busy() {
        if (!shell.loading && !transferring && docVersion !== null) return false;
        shell.setMessage('Still loading: editing is available when the file is fully loaded');
        shell.grid.refresh();
        return true;
    }

    function applyEdits(edits) {
        if (readOnly || !provider || busy()) return;
        const p = provider, changed = new Map(), appended = [];
        let maxR = -1;
        edits.forEach(function (e) { if (e.r > maxR) maxR = e.r; });
        const startCount = p.rowCount;
        const viewActive = !!shell._order;
        while (p.rowCount <= maxR) {
            const r = p.appendRow();
            appended.push({ r: r, range: p.getSourceRange(r) });
        }
        const ordered = edits.filter(function (e) { return e.r >= startCount || p.getRaw(e.r, e.c) !== e.text; });
        const lineEdits = [];
        ordered.forEach(function (e) {
            if (e.r < startCount && !changed.has(e.r)) changed.set(e.r, p.getSourceRange(e.r));
        });
        ordered.forEach(function (e) { p.setCell(e.r, e.c, e.text); });
        changed.forEach(function (range, r) { lineEdits.push({ start: range.start, end: range.end, text: p.serializeRow(r) }); });
        if (appended.length) {
            const text = appended.map(function (a) { return p.serializeRow(a.r); }).join('\n');
            lineEdits.push({ start: appended[0].range.start, end: appended[0].range.start, text: text });
        }
        // New rows are not part of a sort/filter order; drop the view so they are visible.
        if (appended.length && viewActive) { shell.clearView(); shell.setMessage('Sort/filter cleared: rows were added'); }
        shell.grid.invalidate();
        shell.grid.refresh();
        shell._updateAll();
        post(lineEdits);
    }

    function addRow() {
        if (readOnly || !provider || busy()) return;
        const r = provider.appendRow();
        const range = provider.getSourceRange(r);
        post([{ start: range.start, end: range.start, text: provider.serializeRow(r) }]);
        if (shell._order) shell.clearView();
        shell.grid.invalidate();
        shell.grid.select(r, 0);
        shell.grid.scrollTo(r, 0);
    }

    function deleteRows(rows) {
        if (readOnly || !provider || !rows.length || busy()) return;
        const ranges = provider.deleteRows(rows);
        const merged = [];
        ranges.forEach(function (g) {
            const last = merged[merged.length - 1];
            if (last && last.end === g.start) last.end = g.end; else merged.push({ start: g.start, end: g.end, text: '' });
        });
        post(merged);
        shell.clearView();
        shell.grid.invalidate();
        shell.grid.refresh();
    }

    const later = typeof MessageChannel !== 'undefined' && typeof window !== 'undefined' && window.addEventListener
        ? (function () { const ch = new MessageChannel(), q = []; ch.port1.onmessage = function () { const f = q.shift(); if (f) f(); }; return function (fn) { q.push(fn); ch.port2.postMessage(0); }; })()
        : function (fn) { setTimeout(fn, 0); };
    const SYNC_LIMIT = 4000000, FIRST_ROWS = 2000;
    let job = null, enc = null;

    function parseOptions() {
        return {
            separator: options.separator,
            quote: options.quoteMark || '"',
            hasHeaders: options.hasHeaders,
            commentChar: options.commentCharacter,
            skipComments: options.skipComments
        };
    }

    function beginLoad(expectedChars, id) {
        if (job) job.cancelled = true;
        transferring = id !== null && id !== undefined;
        const prevProvider = provider;
        job = {
            id: id, seq: 0, cancelled: false, final: false, pumping: false, swapped: false, sync: false,
            buf: new Uint8Array(Math.max(1024, expectedChars | 0)), filled: 0, expected: expectedChars | 0,
            ix: new OX.CsvIndex(parseOptions()), t0: performance.now(), lastPos: -1, lastInv: 0,
            prev: prevProvider ? shell.getViewState() : null, prevProvider: prevProvider, state0: null
        };
        return job;
    }

    function feed(j, text) {
        enc = enc || new TextEncoder();
        let pos = 0;
        while (pos < text.length) {
            const rest = pos ? text.slice(pos) : text;
            const r = enc.encodeInto(rest, j.buf.subarray(j.filled));
            j.filled += r.written; pos += r.read;
            if (r.read < rest.length) {
                const nb = new Uint8Array(Math.max(Math.ceil(j.buf.length * 1.2), j.filled + (rest.length - r.read) + 65536));
                nb.set(j.buf.subarray(0, j.filled));
                j.buf = nb;
            }
        }
        j.ix.setSource(j.buf, j.filled, false);
    }

    function makeProvider(j) {
        const ix = j.ix;
        provider = new OX.CsvProvider(ix, {
            hasHeaders: options.hasHeaders,
            capitalizeHeaders: options.capitalizeHeaders,
            formatValues: options.formatValues,
            numberFormat: options.numberFormat,
            lineNumbers: options.lineNumbers,
            separator: ix.sepDirective || options.separator,
            quote: options.quoteMark || '"',
            dark: shell.isDark(),
            measure: measure
        });
        if (j.prevProvider) j.prevProvider._userWidths.forEach(function (w, c) { provider.setColWidth(c, w); });
        shell.setProvider(provider);
        j.swapped = true;
        if (ix.done) autosize();
        if (ix.sepDirective && !sepSent) { sepSent = true; sendMessage({ separator: ix.sepDirective }); }
        const vs = j.prev || (saved && saved.view) || null;
        shell.applyViewState(vs);
        j.state0 = JSON.stringify(shell.getViewState());
        j.vs = vs;
    }

    function status(j, done) {
        if (done) {
            const n = provider.rowCount - (provider.hasHeaders ? 1 : 0);
            shell.setMessage(n.toLocaleString() + ' rows, ' + provider.colCount + ' columns  |  parsed in ' + Math.round(performance.now() - j.t0) + ' ms');
        } else {
            const total = j.final ? j.filled : Math.max(j.expected, j.filled);
            const pct = total ? Math.min(99, Math.floor(100 * j.ix.pos / total)) : 0;
            shell.setMessage('Parsing ' + pct + '%  |  ' + Math.max(0, provider ? provider.rowCount - (provider.hasHeaders ? 1 : 0) : 0).toLocaleString() + ' rows');
        }
    }

    function autosize() {
        if (options.resizeColumns !== 'all') return;
        provider.autosizeAll();
        shell.grid.invalidate();
    }

    function complete(j) {
        provider.sync();
        if (j.prevProvider && j.prevProvider.dataRowCount === provider.dataRowCount) {
            j.prevProvider._userHeights.forEach(function (h, r) { provider.setRowHeight(r, h); });
        }
        shell.loading = false;
        transferring = false;
        docVersion = j.version === undefined ? null : j.version;
        if (j.reapply) {
            autosize();
            shell.grid.invalidate();
            if (j.vs && JSON.stringify(shell.getViewState()) === j.state0) shell.applyViewState(j.vs);
        }
        status(j, true);
        job = null;
    }

    // Indexes available data in slices; the grid shows the first rows as soon as they exist.
    function step(j) {
        if (j.cancelled) return;
        const ix = j.ix;
        ix.run(j.sync ? 0 : 12);
        if (!j.swapped && (ix.done || ((ix.header !== null || !options.hasHeaders) && ix.n >= FIRST_ROWS))) {
            makeProvider(j);
            j.reapply = !ix.done;
            shell.loading = !ix.done;
        } else if (j.swapped) {
            provider.sync();
            const t = performance.now();
            if (!ix.done && t - j.lastInv > 300) { j.lastInv = t; shell.grid.invalidate(); }
        }
        if (ix.done) { complete(j); return; }
        status(j, false);
        if (ix.pos !== j.lastPos) { j.lastPos = ix.pos; later(function () { step(j); }); } else j.pumping = false;
    }

    function pump(j) {
        if (j.pumping || j.cancelled) return;
        j.pumping = true; j.lastPos = -1;
        later(function () { step(j); });
    }

    function finishLoad(j) {
        j.final = true;
        j.ix.setSource(j.buf, j.filled, true);
        if (j.filled <= SYNC_LIMIT) { j.sync = true; j.pumping = true; step(j); } else pump(j);
    }

    // Whole document as one string (small files, tests, tools).
    function load(text, version) {
        text = text || '';
        const j = beginLoad(0, null);
        j.version = version;
        enc = enc || new TextEncoder();
        j.buf = enc.encode(text); j.filled = j.buf.length; j.expected = j.filled;
        finishLoad(j);
    }

    // Large documents arrive as ordered chunks: {refreshChunk:'start'|'data'|'end', id, ...}; a newer start cancels the old transfer.
    function chunk(m) {
        if (m.refreshChunk === 'start') { beginLoad(m.chars, m.id).version = m.version; shell.setMessage('Loading...'); return; }
        const j = job;
        if (!j || j.id !== m.id || j.final) return;
        if (m.refreshChunk === 'data') {
            if (m.seq !== j.seq) { j.cancelled = true; job = null; transferring = false; vscode.postMessage({ refresh: true }); return; }
            j.seq++;
            feed(j, m.text);
            if (!j.swapped) shell.setMessage('Loading ' + Math.floor(100 * j.filled / Math.max(1, j.expected)) + '%...');
            pump(j);
        } else if (m.refreshChunk === 'end') {
            if (m.count !== j.seq) { j.cancelled = true; job = null; transferring = false; vscode.postMessage({ refresh: true }); return; }
            finishLoad(j);
        }
    }

    window.oxCsv = { load: load, chunk: chunk, shell: shell };
    shell.setMessage('Opening...');
    vscode.postMessage({ refresh: true });
}

function handleEvents() {
    window.addEventListener('message', function (event) {
        const d = event.data;
        if (!d || !window.oxCsv) return;
        if (d.refreshChunk) window.oxCsv.chunk(d);
        else if (d.refresh) window.oxCsv.load(d.content, d.version);
    });
}
