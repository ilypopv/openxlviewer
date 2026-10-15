export interface LineEdit {
    start: number;
    end: number;
    text: string;
}

export interface TextOp {
    sl: number;
    sc: number;
    el: number;
    ec: number;
    text: string;
    eof?: boolean;
    eaten?: boolean;
}

export interface DocShape {
    lineCount: number;
    lineLength(line: number): number;
}

// Translates webview line edits (line-addressed, pre-edit coordinates) into character ops for a document.
export function buildTextOps(doc: DocShape, eol: string, edits: LineEdit[]): TextOp[] {
    const L = doc.lineCount;
    const lastLen = doc.lineLength(L - 1);
    const unterminated = lastLen > 0;
    const norm = (s: string) => s.replace(/\r?\n/g, eol);

    const merged: LineEdit[] = [];
    for (const e of edits) {
        const prev = merged[merged.length - 1];
        if (prev && !e.text && !prev.text && prev.start < prev.end && e.start === prev.end && e.end > e.start) {
            prev.end = e.end;
        } else {
            merged.push({ start: e.start, end: e.end, text: e.text });
        }
    }

    const ops: TextOp[] = [];
    let tail: TextOp | undefined;
    for (const e of merged) {
        if (e.start >= L) {
            const body = norm(e.text);
            if (tail) {
                const sep = tail.text.length === 0 ? (tail.eaten ? eol : '') : (tail.text.endsWith(eol) ? '' : eol);
                tail.text += sep + body;
            } else {
                tail = { sl: L - 1, sc: lastLen, el: L - 1, ec: lastLen, text: (unterminated ? eol : '') + body, eof: true };
                ops.push(tail);
            }
            continue;
        }
        const toEof = e.end >= L;
        const el = toEof ? L - 1 : e.end;
        const ec = toEof ? lastLen : 0;
        let op: TextOp;
        if (!e.text) {
            if (toEof && unterminated && e.start > 0) {
                op = { sl: e.start - 1, sc: doc.lineLength(e.start - 1), el, ec, text: '', eaten: true };
            } else {
                op = { sl: e.start, sc: 0, el, ec, text: '' };
            }
        } else {
            op = { sl: e.start, sc: 0, el, ec, text: norm(e.text) + (toEof && unterminated ? '' : eol) };
        }
        if (toEof) {
            op.eof = true;
            tail = op;
        }
        ops.push(op);
    }
    return ops;
}
