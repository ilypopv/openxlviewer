import { env, Uri, window } from 'vscode';

const ALLOWED = ['http:', 'https:', 'mailto:'];

export function isSafeLink(url: string): boolean {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)/.exec(url.trim());
    return !!m && ALLOWED.indexOf(m[1].toLowerCase()) >= 0 && url.length < 4096;
}

export function openExternalLink(url: string) {
    if (!isSafeLink(url)) {
        window.showWarningMessage('OpenXL Viewer only opens http, https and mailto links.');
        return;
    }
    env.openExternal(Uri.parse(url.trim()));
}
