'use strict';
import { Uri } from 'vscode';
import BaseDocumentView from './baseDocumentView';

export class DocumentViewManager {
    
    private static _instance: DocumentViewManager;
    private _views: BaseDocumentView[] = [];

    private constructor() {
    }

    public static get Instance() {
        return this._instance || (this._instance = new this());
    }

    public add(view: BaseDocumentView): void {
        this._views.push(view!);
    }

    public remove(view: BaseDocumentView): void {
        let found = this._views.indexOf(view!);
        if (found >= 0) {
            this._views.splice(found, 1);
        }
    }

    // editor: true = custom editors only, false = preview panels only, undefined = either
    public find(uri: Uri, editor?: boolean): BaseDocumentView | undefined {
        return this.filter(uri, editor)[0];
    }

    public filter(uri: Uri, editor?: boolean): BaseDocumentView[] {
        const key = uri.toString();
        return this._views.filter(p => !p.isDisposed && p.uri.toString() === key && (editor === undefined || p.hasCustomEditor === editor));
    }

    public active(): BaseDocumentView | undefined {
        return this._views.find(p => !p.isDisposed && p.visible && p.focused) || this._views.find(p => !p.isDisposed && p.visible);
    }
    
    public configure(): void {
        this._views.slice().forEach(p => p.configure());
    }
}

export const documentViewManager = DocumentViewManager.Instance;
