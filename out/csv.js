var sendMessage;
var csvTable = null;

function initPage() {
    const vscode = acquireVsCodeApi();
    const options = getOptions();
    const NEWLINES = "__newlines";
    const STATE_VERSION = "5.0.0";
    sendMessage = function (m) { vscode.postMessage(m); };

    var table = null;
    var ready = false;
    var pending = null;
    var headers = [];
    var fields = [];
    var source = [];
    var itemById = new Map();
    var scrollTimer = null;

    var numbersOrdinal = options.lineNumbers === "ordinal";
    var numbersSource = options.lineNumbers === "source";
    var lineNumbers = numbersOrdinal || numbersSource;

    // ---- toolbar (custom editor only) ----
    if (options.customEditor) {
        var bar = document.createElement("div");
        bar.id = "toolbar";
        var add = document.createElement("button");
        add.textContent = "Add row";
        add.addEventListener("click", addRow);
        var del = document.createElement("button");
        del.textContent = "Delete selected rows";
        del.addEventListener("click", deleteSelected);
        bar.appendChild(add);
        bar.appendChild(del);
        var wrap = document.getElementById("gridwrap");
        wrap.parentNode.insertBefore(bar, wrap);
        document.addEventListener("keydown", function (e) {
            var t = e.target && e.target.tagName;
            if (e.key === "Delete" && t !== "TEXTAREA" && t !== "INPUT") {
                deleteSelected();
            }
        });
    }

    // ---- state ----
    function getState() {
        var widths = {};
        var sorters = [];
        var filters = [];
        var holder = table.element.querySelector(".tabulator-tableholder");
        table.getColumns().forEach(function (c) {
            if (c.getField() && c.getField().indexOf("__") !== 0) {
                widths[c.getField()] = c.getWidth();
            }
        });
        table.getSorters().forEach(function (s) {
            sorters.push({ column: s.field, dir: s.dir });
        });
        table.getHeaderFilters().forEach(function (f) {
            filters.push({ field: f.field, value: f.value });
        });
        return {
            uri: options.uri,
            previewUri: options.previewUri,
            languageId: options.languageId,
            headers: headers,
            widths: widths,
            sorters: sorters,
            filters: filters,
            scrollTop: holder ? holder.scrollTop : 0,
            scrollLeft: holder ? holder.scrollLeft : 0,
            version: STATE_VERSION
        };
    }

    function preserveState() {
        if (!table || !ready) return;
        var state = getState();
        vscode.setState(state);
        vscode.postMessage({ save: true, state: state });
    }

    function sameHeaders(a, b) {
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    function usableState(content) {
        if (ignoreState()) return null;
        var json = vscode.getState() || options.state;
        if (json && json.version === STATE_VERSION && sameHeaders(json.headers || [], content.bindings.map(function (b) { return b.header; }))) {
            return json;
        }
        return null;
    }

    // ---- formatting ----
    function esc(text) {
        return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function toHeaderCase(text) {
        var t = text.replace(/([a-z])([A-Z])/g, "$1 $2");
        return t.length ? t.charAt(0).toUpperCase() + t.slice(1) : t;
    }

    function formatNumber(v, fmt) {
        try {
            var m = /^([a-zA-Z])(\d*)$/.exec(fmt || "");
            if (!m) return String(v);
            var p = m[2] === "" ? null : parseInt(m[2], 10);
            switch (m[1].toLowerCase()) {
                case "g": return p ? String(Number(v.toPrecision(p))) : String(v);
                case "n": var d = p === null ? 2 : p; return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
                case "f": return v.toFixed(p === null ? 2 : p);
                case "d": var s = String(Math.trunc(Math.abs(v))); while (p && s.length < p) s = "0" + s; return (v < 0 ? "-" : "") + s;
                case "c": var c = p === null ? 2 : p; return v.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: c, maximumFractionDigits: c });
                case "p": return (v * 100).toFixed(p === null ? 2 : p) + "%";
                case "e": return v.toExponential(p === null ? 6 : p);
                case "x": return Math.trunc(v).toString(16);
            }
        } catch (e) { }
        return String(v);
    }

    function valueFormatter(cell) {
        var v = cell.getValue();
        if (v === null || v === undefined) return "";
        return esc(typeof v === "number" ? formatNumber(v, options.numberFormat) : v);
    }

    function lineFormatter(cell) {
        if (numbersSource) return String(cell.getValue());
        if (numbersOrdinal) {
            try { return String(cell.getRow().getPosition(true)); } catch (e) { return ""; }
        }
        return "";
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

    function toCellValue(text) {
        if (options.formatValues === "always" && text.length) {
            var num = Number(text);
            if (!isNaN(num)) return num;
        }
        return text;
    }

    // ---- editing ----
    function cellEditor(cell, onRendered, success, cancel) {
        var ta = document.createElement("textarea");
        var v = cell.getValue();
        var done = false;
        ta.value = v === null || v === undefined ? "" : String(v);
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
    }

    function countNewlines(obj) {
        var count = 0;
        Object.keys(obj).forEach(function (key) {
            var value = obj[key];
            if (typeof value === "string") {
                count += value.split("\n").length - 1;
            }
        });
        return count;
    }

    function rangeFor(item, refreshNewlines) {
        var idx = source.indexOf(item);
        var start = idx;
        for (var i = 0; i < idx; i++) start += source[i][NEWLINES];
        var end = start + item[NEWLINES] + 1;
        if (refreshNewlines) item[NEWLINES] = countNewlines(item);
        return { start: start, end: end };
    }

    function onCellEdited(cell) {
        var field = cell.getField();
        var row = cell.getRow();
        var item = itemById.get(row.getData().__id);
        if (!item) return;
        var oldVal = cell.getOldValue();
        var old = oldVal === null || oldVal === undefined ? "" : String(oldVal);
        var text = String(cell.getValue());
        var converted = toCellValue(text);
        item[field] = converted;
        var upd = {};
        upd[field] = converted;
        row.update(upd);
        if (text === old) return;
        sendMessage({
            cellEditEnded: true,
            rows: rangeFor(item, true),
            col: fields.indexOf(field),
            value: text
        });
        sendMessage({ rowEditEnded: true, cancel: false });
    }

    function addRow() {
        sendMessage({ rowAdded: true, count: fields.length });
        sendMessage({ rowEditEnded: true, cancel: false });
    }

    function deleteSelected() {
        if (!table || !options.customEditor) return;
        var rows = table.getSelectedRows();
        if (!rows.length) return;
        var items = rows.map(function (r) { return itemById.get(r.getData().__id); }).filter(Boolean);
        var ranges = items.map(function (item) { return rangeFor(item, false); });
        rows.forEach(function (r) { r.delete(); });
        items.forEach(function (item) {
            source.splice(source.indexOf(item), 1);
            itemById.delete(item.__id);
        });
        sendMessage({ deleteRows: true, rows: ranges });
    }

    // ---- rendering ----
    function columnWidth(i, saved, field) {
        if (saved && saved.widths && saved.widths[field]) return saved.widths[field];
        if (options.resizeColumns === "all") return undefined;
        if (options.resizeColumns === "first" && i === 0) return undefined;
        return 100;
    }

    function buildColumns(content, saved) {
        var cols = [];
        if (lineNumbers || options.customEditor) {
            cols.push({
                title: "",
                field: "__line",
                formatter: lineFormatter,
                hozAlign: "right",
                headerSort: false,
                resizable: false,
                frozen: true,
                cssClass: "row-header",
                cellClick: options.customEditor ? function (e, cell) { cell.getRow().toggleSelect(); } : undefined
            });
        }
        content.bindings.forEach(function (b, i) {
            var title = b.header;
            if (options.capitalizeHeaders) title = toHeaderCase(title);
            var def = {
                title: esc(title),
                field: b.binding,
                formatter: valueFormatter,
                sorter: mixedSorter,
                headerFilter: "input",
                headerFilterFunc: containsFilter,
                editor: options.customEditor ? cellEditor : false
            };
            var w = columnWidth(i, saved, b.binding);
            if (w) def.width = w;
            cols.push(def);
        });
        return cols;
    }

    function setContent(content) {
        source = content.data;
        itemById = new Map();
        source.forEach(function (item) { itemById.set(item.__id, item); });
    }

    function render(content) {
        var newHeaders = content.bindings.map(function (b) { return b.header; });
        if (table && ready && sameHeaders(newHeaders, headers)) {
            setContent(content);
            table.replaceData(content.data);
            return;
        }
        if (table && !ready) {
            pending = content;
            return;
        }
        var saved = table ? null : usableState(content);
        if (table) {
            table.destroy();
            table = null;
        }
        ready = false;
        headers = newHeaders;
        fields = content.bindings.map(function (b) { return b.binding; });
        setContent(content);

        var opts = {
            index: "__id",
            height: "100%",
            layout: "fitData",
            columns: buildColumns(content, saved),
            columnDefaults: { headerSortTristate: true },
            editTriggerEvent: "dblclick",
            selectableRows: options.customEditor ? true : false,
            selectableRowsRangeMode: "click",
            renderHorizontal: fields.length > 50 ? "virtual" : "basic"
        };
        if (saved) {
            if (saved.sorters && saved.sorters.length) opts.initialSort = saved.sorters;
            if (saved.filters && saved.filters.length) opts.initialHeaderFilter = saved.filters;
        }
        table = new Tabulator("#flex", opts);
        csvTable = table;

        table.on("tableBuilt", function () {
            table.setData(content.data).then(function () {
                var holder = table.element.querySelector(".tabulator-tableholder");
                if (saved && holder) {
                    holder.scrollTop = saved.scrollTop || 0;
                    holder.scrollLeft = saved.scrollLeft || 0;
                }
                ready = true;
                preserveState();
                if (pending) {
                    var p = pending;
                    pending = null;
                    render(p);
                }
            });
            var h = table.element.querySelector(".tabulator-tableholder");
            if (h) {
                h.addEventListener("scroll", function () {
                    clearTimeout(scrollTimer);
                    scrollTimer = setTimeout(preserveState, 300);
                });
            }
        });
        table.on("dataSorted", function () {
            if (numbersOrdinal && ready) table.redraw(true);
            preserveState();
        });
        table.on("dataFiltered", function () {
            if (numbersOrdinal && ready) table.redraw(true);
            preserveState();
        });
        table.on("columnResized", preserveState);
        table.on("cellEdited", onCellEdited);
    }

    window.csvRender = render;
    vscode.postMessage({ refresh: true });
}

function parseContent(text) {
    const options = getOptions();
    var sep = options.separator;
    var quote = options.quoteMark;
    var hasHeaders = options.hasHeaders;
    var comment = options.commentCharacter;
    var skip = options.skipComments;
    var formatAlways = options.formatValues === "always";
    var formatUnquoted = options.formatValues === "unquoted";

    var regexQuote = new RegExp(`^${quote}([\\S\\s]*)${quote}$`);
    var regexDoubleQuote = new RegExp(`${quote}${quote}`, 'g');
    var regexComment = new RegExp(String.raw`^\s*${comment}|^\s+$`);

    // based on https://softwareengineering.stackexchange.com/a/368124
    var regexLines = new RegExp(`((${quote}(?:[^${quote}]|)+${quote}|[^${quote}\n\r]+)+)`, 'g');

    // http://markmintoff.com/2013/03/regex-split-by-comma-not-surrounded-by-quotes/
    var regexItems = new RegExp(`${sep}(?=(?:[^${quote}]*${quote}[^${quote}]*${quote})*[^${quote}]*$)`);

    function unquote(cell) {
        if (cell.text.length > 0) {
            var match = regexQuote.exec(cell.text);
            if (match) {
                cell.quoted = true;
                return dblquote(match[1]);
            }
        }
        return cell.text;
    }

    function dblquote(text) {
        return text.length > 1 ? text.replace(regexDoubleQuote, `${quote}`) : text;
    }

    function isComment(text) {
        return !skip ? false : ((text.length > 0) ? regexComment.exec(text) : true);
    }

    function isSep(text) {
        var line = text.replace(/ /g, "");
        var left = line.slice(0, 4).toLowerCase();
        var result = (left === "sep=");
        if (result && line.length == 5) {
            var escapes = `+*?^$\.[]{}()|/`;
            var char = line.slice(4);
            sep = (escapes.indexOf(char) >= 0) ? "\\".concat(char) : char;
            regexItems = new RegExp(`${sep}(?=(?:[^${quote}]*${quote}[^${quote}]*${quote})*[^${quote}]*$)`);
            sendMessage({
                separator: sep
            });
        }
        return result;
    }

    function getBinding(n) {
        var h1 = Math.floor(n / 26);
        var h2 = n % 26;
        if (h1 > 0) {
            return String.fromCharCode(64 + h1) + String.fromCharCode(65 + h2);
        } else {
            return String.fromCharCode(65 + h2);
        }
    }

    var data = [], headers = [], bindings = [];
    var lines = text.match(regexLines) || [];
    var firstLine = hasHeaders;
    var maxLength = 0;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace("\r", "");
        if (i == 0 && isSep(line)) {
            continue;
        }
        if (!isComment(line)) {
            var items = line.split(regexItems);
            if (items.length > maxLength) {
                maxLength = items.length;
            }
            if (firstLine) {
                for (var j = 0; j < items.length; j++) {
                    var cell = { text: items[j] };
                    headers.push(unquote(cell));
                }
                firstLine = false;
            } else {
                var obj = {};
                obj["__newlines"] = line.split("\n").length - 1;
                for (var j = 0; j < items.length; j++) {
                    var cell = { text: items[j], quoted: false };
                    var value = unquote(cell);
                    if (formatAlways || (formatUnquoted && !cell.quoted)) {
                        var num = value.length ? Number(value) : NaN;
                        obj[getBinding(j)] = isNaN(num) ? value : num;
                    } else {
                        obj[getBinding(j)] = value;
                    }
                }
                if (line.length > 0 || (i < lines.length - 1)) {
                    obj["__id"] = ++parseContent.nextId;
                    obj["__line"] = data.length + 1;
                    data.push(obj);
                }
            }
        }
    }

    if (maxLength === 0) {
        maxLength = 1;
    }

    for (var i = 0; i < maxLength; i++) {
        var key = getBinding(i);
        var header = (headers.length > i) ? headers[i] : hasHeaders ? "" : key;
        bindings.push({
            binding: key,
            header: header.length > 0 ? header : " "
        });
    }

    return {
        data: data,
        bindings: bindings
    }
}
parseContent.nextId = 0;

function handleEvents() {
    window.addEventListener("message", event => {
        if (event.data.refresh) {
            window.csvRender(parseContent(event.data.content));
        }
    });
}
