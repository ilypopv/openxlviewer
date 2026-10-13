'use strict';
import { window, workspace, WebviewPanel, ExtensionContext, ViewColumn } from 'vscode';
import { URI } from 'vscode-uri';
import BaseDocumentView from './baseDocumentView';
import { ExcelDocument } from './excelEditor';

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

    public enableEditing(document: ExcelDocument) {
        this._document = document;
        this.webview.onDidReceiveMessage((e) => {
            if (e.changed) {
                this._document.change(e.reason);
            }
        }, this, this._disposables);
    }

    refresh(): void {
        let self = this;
        workspace.fs.readFile(this.uri).then(buffer => {
            self.webview.postMessage({
                refresh: true,
                content: buffer
            })
        }, reason => {
            window.showInformationMessage(reason);
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
		return `
        <!DOCTYPE html>
        <html>
        <head>
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.webview.cspSource} 'unsafe-inline'; script-src ${this.webview.cspSource} 'unsafe-inline';">
            <link href="${this.scriptUri}/vendor/tabulator.min.css" rel="stylesheet" type="text/css" />
            <link href="${this.scriptUri}/styles/vscode.css" rel="stylesheet" type="text/css" />
        </head>
        <script src="${this.scriptUri}/vendor/tabulator.min.js"></script>
        <script src="${this.scriptUri}/vendor/xlsx.full.min.js"></script>
        <script src="${this.scriptUri}/excel.js"></script>
        <body style="padding:0px; overflow:hidden">
            <div id="gridwrap"><div id="sheet"></div></div>
        </body>
        <script type="text/javascript">
            function ignoreState() {
                return ${ignoreState};
            }
            function getOptions() {
                return ${JSON.stringify(this.getOptions())};
            }
            handleEvents();
            initPage();
        </script>
        </html>`;
	}

    get viewType(): string {
        return "openxlviewer-excel-preview";
    }

    get configurable(): boolean {
        return false;
    }
}
