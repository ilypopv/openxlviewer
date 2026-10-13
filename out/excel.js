var sendMessage;
var excelApp = null;

function initPage() {
    const vscode = acquireVsCodeApi();
    const options = getOptions();
    const STATE_VERSION = "5.0.0";
    const MIN_ROWS = 100, MIN_COLS = 26;
    sendMessage = function (m) { vscode.postMessage(m); };

    var wb = null;
    var sheetIdx = 0;
    var table = null;
    var ready = false;
    var view = null;
    var undoStack = [];
    var redoStack = [];
    var scrollTimer = null;

    var tabs = document.createElement("div");
    tabs.id = "tabs";
    var wrap = document.getElementById("gridwrap");
    wrap.parentNode.insertBefore(tabs, wrap.nextSibling);

    // ---- helpers ----
    function esc(text) {
        return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function currentSheet() {
        return wb.Sheets[wb.SheetNames[sheetIdx]];
    }

    function cellAt(ws, r, c) {
        return ws[XLSX.utils.encode_cell({ r: r, c: c })];
    }

    function rawValue(cell) {
        if (!cell) return "";
        if (cell.v === undefined || cell.v === null) return cell.f ? "=" + cell.f : "";
        return cell.v;
    }

    function displayText(cell) {
        if (!cell) return "";
        if (cell.w !== undefined) return cell.w;
        if (cell.v === undefined || cell.v === null) return cell.f ? "=" + cell.f : "";
        return String(cell.v);
    }

    function editText(cell) {
        if (!cell) return "";
        if (cell.f) return "=" + cell.f;
        return cell.v === undefined || cell.v === null ? "" : String(cell.v);
    }

    function mixedSorter(a, b) {
        var an = typeof a === "number", bn = typeof b === "number";
        if (an && bn) return a - b;
        if (an) return -1;
        if (bn) return 1;
        return String(a === undefined || a === null ? "" : a).localeCompare(String(b === undefined || b === null ? "" : b), undefined, { numeric: true });
    }

    function containsFilter(headerValue, rowValue) {
        return String(rowValue === undefined || rowValue === null ? "" : rowValue).toLowerCase().indexOf(String(headerValue).toLowerCase()) >= 0;
    }

    function cloneCell(cell) {
        return cell ? JSON.parse(JSON.stringify(cell)) : undefined;
    }

    function parseTyped(text, old) {
        if (text === "") return undefined;
        var cell;
        if (text.length > 1 && text.charAt(0) === "=") {
            cell = { t: "n", f: text.slice(1) };
        } else if (text.trim() !== "" && isFinite(Number(text))) {
            var n = Number(text);
            cell = { t: "n", v: n };
            if (old && old.z) cell.z = old.z;
            try { cell.w = XLSX.SSF.format(cell.z || "General", n); } catch (e) { cell.w = text; }
        } else if (/^(true|false)$/i.test(text)) {
            cell = { t: "b", v: text.toLowerCase() === "true" };
            cell.w = cell.v ? "TRUE" : "FALSE";
        } else {
            cell = { t: "s", v: text, w: text };
        }
        return cell;
    }

    // ---- state ----
    function getState() {
        var sorters = [], filters = [];
        var holder = table ? table.element.querySelector(".tabulator-tableholder") : null;
        if (table) {
            table.getSorters().forEach(function (s) { sorters.push({ column: s.field, dir: s.dir }); });
            table.getHeaderFilters().forEach(function (f) { filters.push({ field: f.field, value: f.value }); });
        }
        return {
            uri: options.uri,
            previewUri: options.previewUri,
            selectedSheetIndex: sheetIdx,
            sorters: sorters,
            filters: filters,
            scrollTop: holder ? holder.scrollTop : 0,
            scrollLeft: holder ? holder.scrollLeft : 0,
            version: STATE_VERSION
        };
    }

    function preserveState() {
        if (!ready) return;
        var state = getState();
        vscode.setState(state);
        vscode.postMessage({ save: true, state: state });
    }

    function savedState() {
        if (ignoreState()) return null;
        var json = vscode.getState() || options.state;
        return json && json.version === STATE_VERSION ? json : null;
    }

    // ---- editing ----
    function textEditor(c) {
        return function (cell, onRendered, success, cancel) {
            var ta = document.createElement("textarea");
            var done = false;
            ta.value = editText(cellAt(currentSheet(), view.r0 + cell.getData().__r, view.c0 + c));
            ta.className = "cell-editor";
            onRendered(function () { ta.focus(); ta.select(); });
            ta.addEventListener("keydown", function (e) {
                if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!done) { done = true; success(ta.value); }
                } else if (e.key === "Escape") {
                    e.stopPropagation();
                    if (!done) { done = true; cancel(); }
                }
            });
            ta.addEventListener("blur", function () {
                if (!done) { done = true; success(ta.value); }
            });
            return ta;
        };
    }

    function writeCell(si, r, c, cell) {
        var ws = wb.Sheets[wb.SheetNames[si]];
        var addr = XLSX.utils.encode_cell({ r: r, c: c });
        if (cell === undefined) {
            delete ws[addr];
        } else {
            ws[addr] = cell;
            var range = XLSX.utils.decode_range(ws["!ref"] || "A1");
            if (r > range.e.r) range.e.r = r;
            if (c > range.e.c) range.e.c = c;
            if (r < range.s.r) range.s.r = r;
            if (c < range.s.c) range.s.c = c;
            ws["!ref"] = XLSX.utils.encode_range(range);
        }
    }

    function refreshRow(rowIdx, c) {
        if (!table) return;
        var row = table.getRow(rowIdx);
        if (!row) return;
        var upd = {};
        upd["c" + c] = rawValue(cellAt(currentSheet(), view.r0 + rowIdx, view.c0 + c));
        row.update(upd);
        row.reformat();
    }

    function applyChange(ch, useAfter) {
        if (ch.si !== sheetIdx) showSheet(ch.si);
        writeCell(ch.si, ch.r, ch.c, cloneCell(useAfter ? ch.after : ch.before));
        refreshRow(ch.r - view.r0, ch.c - view.c0);
    }

    function onCellEdited(cell) {
        var c = parseInt(cell.getField().slice(1), 10);
        var rowIdx = cell.getRow().getData().__r;
        var r = view.r0 + rowIdx, cc = view.c0 + c;
        var ws = currentSheet();
        var old = cellAt(ws, r, cc);
        var text = String(cell.getValue() === undefined || cell.getValue() === null ? "" : cell.getValue());
        if (text === editText(old)) {
            refreshRow(rowIdx, c);
            return;
        }
        var after = parseTyped(text, old);
        undoStack.push({ si: sheetIdx, r: r, c: cc, before: cloneCell(old), after: cloneCell(after) });
        redoStack = [];
        writeCell(sheetIdx, r, cc, after);
        wb.Workbook = wb.Workbook || {};
        wb.Workbook.CalcPr = wb.Workbook.CalcPr || {};
        wb.Workbook.CalcPr.fullCalcOnLoad = true;
        refreshRow(rowIdx, c);
        vscode.postMessage({ changed: true, reason: "Cell Edited" });
    }

    function undo() {
        var ch = undoStack.pop();
        if (!ch) return;
        redoStack.push(ch);
        applyChange(ch, false);
    }

    function redo() {
        var ch = redoStack.pop();
        if (!ch) return;
        undoStack.push(ch);
        applyChange(ch, true);
    }

    // ---- rendering ----
    function renderTabs() {
        tabs.innerHTML = "";
        wb.SheetNames.forEach(function (name, i) {
            var b = document.createElement("button");
            b.textContent = name;
            if (i === sheetIdx) b.className = "active";
            b.addEventListener("click", function () {
                if (i === sheetIdx) return;
                showSheet(i);
                preserveState();
            });
            tabs.appendChild(b);
        });
    }

    function showSheet(i, saved) {
        sheetIdx = i;
        ready = false;
        if (table) {
            table.destroy();
            table = null;
        }
        renderTabs();
        var ws = currentSheet();
        var range = XLSX.utils.decode_range(ws["!ref"] || "A1:A1");
        var hasData = !!ws["!ref"];
        var nrows = hasData ? range.e.r - range.s.r + 1 : 0;
        var ncols = hasData ? range.e.c - range.s.c + 1 : 0;
        if (!hasData) {
            nrows = MIN_ROWS;
            ncols = MIN_COLS;
        } else if (options.customEditor) {
            nrows += 20;
            ncols += 2;
        }
        view = { r0: hasData ? range.s.r : 0, c0: hasData ? range.s.c : 0, nrows: nrows, ncols: ncols };

        var cols = [{
            title: "",
            field: "__rn",
            formatter: function (cell) { return String(view.r0 + cell.getData().__r + 1); },
            hozAlign: "right",
            headerSort: false,
            resizable: false,
            frozen: true,
            cssClass: "row-header"
        }];
        var wcols = ws["!cols"] || [];
        for (var c = 0; c < ncols; c++) {
            (function (c) {
                var info = wcols[view.c0 + c];
                var width = 90;
                if (info) {
                    if (info.wpx) width = info.wpx;
                    else if (info.wch) width = Math.round(info.wch * 7 + 5);
                    else if (info.width) width = Math.round(info.width * 7 + 5);
                }
                cols.push({
                    title: XLSX.utils.encode_col(view.c0 + c),
                    field: "c" + c,
                    width: width,
                    sorter: mixedSorter,
                    headerFilter: "input",
                    headerFilterFunc: containsFilter,
                    formatter: function (cell) {
                        return esc(displayText(cellAt(currentSheet(), view.r0 + cell.getData().__r, view.c0 + c)));
                    },
                    editor: options.customEditor ? textEditor(c) : false
                });
            })(c);
        }

        var data = new Array(nrows);
        for (var r = 0; r < nrows; r++) {
            var row = { __r: r };
            for (var c = 0; c < ncols; c++) {
                row["c" + c] = rawValue(cellAt(ws, view.r0 + r, view.c0 + c));
            }
            data[r] = row;
        }

        var opts = {
            index: "__r",
            height: "100%",
            layout: "fitData",
            columns: cols,
            columnDefaults: { headerSortTristate: true },
            editTriggerEvent: "dblclick",
            selectableRows: false,
            renderHorizontal: ncols > 40 ? "virtual" : "basic"
        };
        if (saved) {
            if (saved.sorters && saved.sorters.length) opts.initialSort = saved.sorters;
            if (saved.filters && saved.filters.length) opts.initialHeaderFilter = saved.filters;
        }
        table = new Tabulator("#sheet", opts);
        table.on("tableBuilt", function () {
            table.setData(data).then(function () {
                var holder = table.element.querySelector(".tabulator-tableholder");
                if (saved && holder) {
                    holder.scrollTop = saved.scrollTop || 0;
                    holder.scrollLeft = saved.scrollLeft || 0;
                }
                ready = true;
                preserveState();
            });
            var h = table.element.querySelector(".tabulator-tableholder");
            if (h) {
                h.addEventListener("scroll", function () {
                    clearTimeout(scrollTimer);
                    scrollTimer = setTimeout(preserveState, 300);
                });
            }
        });
        table.on("dataSorted", preserveState);
        table.on("dataFiltered", preserveState);
        table.on("cellEdited", onCellEdited);
    }

    function loadWorkbook(bytes) {
        if (!bytes || bytes.length === 0) {
            wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), "Sheet1");
        } else {
            wb = XLSX.read(bytes, { type: "array", cellNF: true, cellText: true, cellFormula: true });
        }
        if (!wb.SheetNames.length) {
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), "Sheet1");
        }
        undoStack = [];
        redoStack = [];
        var saved = savedState();
        var idx = saved && saved.selectedSheetIndex >= 0 && saved.selectedSheetIndex < wb.SheetNames.length ? saved.selectedSheetIndex : 0;
        showSheet(idx, saved && saved.selectedSheetIndex === idx ? saved : null);
    }

    function getBytes() {
        var out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
        return new Uint8Array(out);
    }

    excelApp = {
        load: function (content) {
            var data = content && content.data !== undefined ? content.data : content;
            loadWorkbook(new Uint8Array(data));
        },
        getBytes: getBytes,
        undo: undo,
        redo: redo
    };

    vscode.postMessage({ refresh: true });
}

function handleEvents() {
    window.addEventListener("message", event => {
        var d = event.data;
        if (!excelApp) return;
        if (d.refresh) {
            excelApp.load(d.content);
        }
        else if (d.type == "getData") {
            sendMessage({
                response: true,
                requestId: d.requestId,
                body: excelApp.getBytes()
            });
        }
        else if (d.undo) {
            excelApp.undo();
        }
        else if (d.redo) {
            excelApp.redo();
        }
        else if (d.content && !d.type) {
            excelApp.load(d.content);
        }
    });
}
