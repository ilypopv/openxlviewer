'use strict';
import { WebviewPanel, WebviewPanelSerializer, ExtensionContext, Uri, workspace } from 'vscode';
import BaseDocumentView from './baseDocumentView';
import CsvDocumentView from './csvDocumentView';
import ExcelDocumentView from './excelDocumentView';
import { documentViewManager } from './documentViewManager';

type Revive = (context: ExtensionContext, uri: Uri, panel: WebviewPanel) => BaseDocumentView;

async function restore(context: ExtensionContext, panel: WebviewPanel, state: any, revive: Revive) {
    let uri: Uri | undefined;
    try {
        uri = state && typeof state.uri === 'string' ? Uri.parse(state.uri, true) : undefined;
    } catch (e) {
        uri = undefined;
    }
    // Without a persisted uri there is nothing to show; drop the dead panel instead of opening file:///undefined.
    if (!uri || documentViewManager.find(uri, false)) {
        panel.dispose();
        return;
    }
    try {
        await workspace.fs.stat(uri);
    } catch (e) {
        panel.dispose();
        return;
    }
    revive(context, uri, panel);
}

export class CsvSerializer implements WebviewPanelSerializer {

    constructor(private readonly context: ExtensionContext) {
    }

    public async deserializeWebviewPanel(webviewPanel: WebviewPanel, state: any) {
        await restore(this.context, webviewPanel, state, CsvDocumentView.revive);
    }
}

export class ExcelSerializer implements WebviewPanelSerializer {

    constructor(private readonly context: ExtensionContext) {
    }

    public async deserializeWebviewPanel(webviewPanel: WebviewPanel, state: any) {
        await restore(this.context, webviewPanel, state, ExcelDocumentView.revive);
    }
}
