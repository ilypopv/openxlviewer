'use strict';
import { WebviewPanel, WebviewPanelSerializer, ExtensionContext, Uri } from 'vscode';
import CsvDocumentView from './csvDocumentView';
import ExcelDocumentView from './excelDocumentView';

export class CsvSerializer implements WebviewPanelSerializer {

    constructor(private readonly context: ExtensionContext) {
    }

    public async deserializeWebviewPanel(webviewPanel: WebviewPanel, state: any) {
        CsvDocumentView.revive(this.context, Uri.parse(state.uri), webviewPanel);
    }
}

export class ExcelSerializer implements WebviewPanelSerializer {

    constructor(private readonly context: ExtensionContext) {
    }

    public async deserializeWebviewPanel(webviewPanel: WebviewPanel, state: any) {
        ExcelDocumentView.revive(this.context, Uri.parse(state.uri), webviewPanel);
    }
}
