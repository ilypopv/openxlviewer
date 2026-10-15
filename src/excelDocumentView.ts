'use strict';
import { window, workspace, WebviewPanel, ExtensionContext, ViewColumn, CancellationToken, Disposable, RelativePattern } from 'vscode';
import { URI, Utils } from 'vscode-uri';
import { safeJson, makeNonce, csp } from './html';
import BaseDocumentView from './baseDocumentView';
import { ExcelDocument } from './excelEditor';

const DATA_TIMEOUT_MS = 60000;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

// Only a non-empty zip container (PK signature) of sane size may replace the file on disk.
export function toWorkbookBytes(body: any): Uint8Array | undefined {
    let out: Uint8Array | undefined;
    if (body instanceof Uint8Array) {
        out = body;
    } else if (body instanceof ArrayBuffer) {
        out = new Uint8Array(body);
    } else if (ArrayBuffer.isView(body)) {
        out = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    } else if (body && typeof body === 'object' && Number.isInteger(body.length) && body.length > 0 && body.length <= MAX_FILE_BYTES) {
        out = Uint8Array.from(body as ArrayLike<number>); // structured-clone fallback for array-likes
    }
    if (!out || out.length < 4 || out.length > MAX_FILE_BYTES || out[0] !== 0x50 || out[1] !== 0x4b) {
        return undefined;
    }
    return out;
}

export default class ExcelDocumentView extends BaseDocumentView {

    static create(context: ExtensionContext, uri: URI, viewColumn: ViewColumn): ExcelDocumentView {
        let preview = new ExcelDocumentView(context, uri);
        preview.scheme = "excel-preview";
        preview.initWebviewPanel(viewColumn);
        preview.initialize();
        return preview;
    }

    static revive(context: ExtensionContext, uri: URI, webviewPanel: WebviewPanel): ExcelDocumentView {
        let preview = new ExcelDocumentView(context, uri);
        preview.scheme = "excel-preview";
        preview.attachWebviewPanel(webviewPanel);
        preview.initialize();
        return preview;
    }

    public getOptions(): any {    

        return {
            customEditor: this.hasCustomEditor,
            uri: this.uri.toString(),
            previewUri: this.previewUri.toString(),
            state: this.state
        };
    }

    private _document: ExcelDocument;
    private _requestId = 0;
    private readonly _pending = new Map<number, { resolve: (b: Uint8Array) => void, reject: (e: Error) => void }>();

    public enableEditing(document: ExcelDocument) {
        this._document = document;
        this.webview.onDidReceiveMessage((e) => {
            if (!e || typeof e !== 'object') {
                return;
            }
            if (e.changed) {
                this._document.change(typeof e.reason === 'string' ? e.reason.slice(0, 100) : 'Edit', this);
            } else if (e.response) {
                const p = this._pending.get(e.requestId);
                if (!p) {
                    return;
                }
                this._pending.delete(e.requestId);
                if (e.error) {
                    p.reject(new Error(String(e.error)));
                } else {
                    const bytes = toWorkbookBytes(e.body);
                    if (bytes) {
                        p.resolve(bytes);
                    } else {
                        p.reject(new Error('The Excel editor returned no valid workbook data; the file was not written.'));
                    }
                }
            }
        }, this, this._disposables);
    }

    // Asks the webview for the current workbook bytes; rejects on webview error, cancellation, close or timeout.
    public requestData(token?: CancellationToken): Promise<Uint8Array> {
        if (this._disposed) {
            return Promise.reject(new Error('The Excel editor was closed.'));
        }
        const id = ++this._requestId;
        return new Promise<Uint8Array>((resolve, reject) => {
            let sub: Disposable | undefined;
            const done = () => {
                clearTimeout(timer);
                if (sub) { sub.dispose(); }
                this._pending.delete(id);
            };
            const timer = setTimeout(() => {
                done();
                reject(new Error('Timed out waiting for the Excel editor to produce the file.'));
            }, DATA_TIMEOUT_MS);
            if (token) {
                sub = token.onCancellationRequested(() => { done(); reject(new Error('Cancelled.')); });
            }
            this._pending.set(id, {
                resolve: (b) => { done(); resolve(b); },
                reject: (e) => { done(); reject(e); }
            });
            this.webview.postMessage({ type: 'getData', requestId: id });
        });
    }

    public initialize() {
        super.initialize();
        if (!this.hasCustomEditor) {
            // read-only preview: follow the file on disk
            let timer: any;
            const watcher = workspace.createFileSystemWatcher(new RelativePattern(Utils.dirname(this.uri) as any, Utils.basename(this.uri)));
            const reload = () => {
                clearTimeout(timer);
                timer = setTimeout(() => { if (!this._disposed) { this.refresh(); } }, 300);
            };
            this._disposables.push(watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload),
                { dispose: () => clearTimeout(timer) });
        }
    }

    public get hasUnsavedEdits(): boolean {
        return !!this._document && this._document.dirty;
    }

    public dispose() {
        const pending = Array.from(this._pending.values());
        this._pending.clear();
        super.dispose();
        pending.forEach(p => p.reject(new Error('The Excel editor was closed.')));
    }

    refresh(): void {
        // A custom editor shows the document model (this is what restores hot-exit backups); previews read the disk.
        if (this._document) {
            this.webview.postMessage({
                refresh: true,
                content: this._document.documentData
            });
            return;
        }
        workspace.fs.readFile(this.uri).then(buffer => {
            if (!this._disposed) {
                this.webview.postMessage({
                    refresh: true,
                    content: buffer
                });
            }
        }, reason => {
            window.showInformationMessage(String((reason && reason.message) || reason));
        });
    }

    undo(): void {
        this.webview.postMessage({
            undo: true
        });
    }

    redo(): void {
        this.webview.postMessage({
            redo: true
        });
    }
    
    getHtml(ignoreState: boolean = false): string {
        const s = this.scriptUri;
        const nonce = makeNonce();
        return `
        <!DOCTYPE html>
        <html>
        <head>
        <meta http-equiv="Content-Security-Policy" content="${csp(this.webview.cspSource, nonce)}">
            <link href="${s}/core/grid.css" rel="stylesheet" type="text/css" />
            <link href="${s}/styles/vscode.css" rel="stylesheet" type="text/css" />
        </head>
        <body>
            <div id="app"></div>
            <script nonce="${nonce}" src="${s}/vendor/fflate.js"></script>
            <script nonce="${nonce}" src="${s}/vendor/ssf.js"></script>
            <script nonce="${nonce}" src="${s}/core/format.js"></script>
            <script nonce="${nonce}" src="${s}/core/xlsx-reader.js"></script>
            <script nonce="${nonce}" src="${s}/core/xlsx-writer.js"></script>
            <script nonce="${nonce}" src="${s}/core/xlsx-provider.js"></script>
            <script nonce="${nonce}" src="${s}/core/calc.js"></script>
            <script nonce="${nonce}" src="${s}/core/grid-core.js"></script>
            <script nonce="${nonce}" src="${s}/core/grid.js"></script>
            <script nonce="${nonce}" src="${s}/core/app-shell.js"></script>
            <script nonce="${nonce}" src="${s}/excel.js"></script>
            <script nonce="${nonce}" type="text/javascript">
                function ignoreState() {
                    return ${ignoreState === true};
                }
                function getOptions() {
                    return ${safeJson(this.getOptions())};
                }
                handleEvents();
                initPage();
            </script>
        </body>
        </html>`;
    }

    get viewType(): string {
        return "openxlviewer-excel-preview";
    }

    get configurable(): boolean {
        return false;
    }
}
