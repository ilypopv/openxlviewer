const { makeWebview, OX, EndOfLine } = require('./csv-host-sim.js');
const tick = async () => {
    for (let i = 0; i < 3; i++) {
        await new Promise(r => setImmediate(r));
    }
};
let drain = async w => {
    await w.view._queue;
    await tick();
    await w.view._queue;
};
function reparse(w) {
    const o = w.view.getOptions();
    return OX.parseCsv(w.doc.text, {
        separator: o.separator,
        quote: '"',
        hasHeaders: o.hasHeaders,
        commentChar: '#',
        skipComments: o.skipComments
    });
}
function state(w) {
    const p = w.shell().provider;
    const rows = [];
    for (let r = 0; r < p.rowCount; r++) {
        const a = [];
        for (let c = 0; c < p.colCount; c++) a.push(p.getRaw(r, c));
        rows.push(a);
    }
    return rows;
}
function check(name, w) {
    // compare provider vs reparse
    const p = w.shell().provider;
    const pr = reparse(w);
    const exp = (pr.header ? [pr.header] : []).concat(pr.rows);
    const got = state(w);
    let ok = true,
        msg = [];
    const norm = a =>
        a.map(r => {
            r = r.map(x => x.replace(/\r\n/g, '\n'));
            while (r.length < p.colCount) r.push('');
            return JSON.stringify(r);
        });
    const E = norm(exp),
        G = norm(got);
    if (E.length !== G.length || E.some((x, i) => x !== G[i])) {
        ok = false;
        msg.push('CELLS differ\n exp ' + E.join('|') + '\n got ' + G.join('|'));
    }
    // line bookkeeping
    for (let r = 0; r < p.rowCount; r++) {
        const sr = p.getSourceRange(r);
        const hh = !!pr.header;
        const el = hh && r === 0 ? pr.headerLine : pr.rowLine[r - (hh ? 1 : 0)];
        const es = hh && r === 0 ? pr.headerSpan : pr.rowSpan[r - (hh ? 1 : 0)];
        if (sr.start !== el || sr.end !== el + es) {
            ok = false;
            msg.push('range r' + r + ' prov ' + JSON.stringify(sr) + ' doc ' + el + '+' + es);
        }
    }
    return { ok, msg: name + ' text=' + JSON.stringify(w.doc.text) + '\n' + msg.join('\n') };
}
async function run(name, text, eol, steps, o) {
    const w = makeWebview(text, eol, o);
    await drain(w);
    const sh = w.shell();
    try {
        for (const s of steps) {
            await s(w, sh);
            await drain(w);
        }
    } catch (e) {
        return { ok: false, msg: 'EXC ' + name + ' ' + e.stack, w };
    }
    const res = check(name, w);
    res.w = w;
    return res;
}
const edit = (r, c, t) => (w, sh) => sh.o.onEdit([{ r, c, text: t }], 'type');
const editMany = a => (w, sh) =>
    sh.o.onEdit(
        a.map(([r, c, t]) => ({ r, c, text: t })),
        'paste'
    );
const del = rows => (w, sh) => {
    // emulate context-menu delete
    const g = sh.grid;
    g.getSelection = () => ({ ranges: rows.map(r => ({ r1: r, r2: r, c1: 0, c2: 0 })) });
    let items;
    g._showMenu = it => {
        items = it;
    };
    g.h.contextmenu({ zone: 'rowhdr', clientX: 0, clientY: 0 });
    const d = items.find(i => i && /^Delete/.test(i[0]));
    d[2]();
};
const add = (w, sh) => {
    const g = sh.grid;
    let items;
    g._showMenu = it => {
        items = it;
    };
    g.getSelection = () => ({ ranges: [{ r1: 1, r2: 1, c1: 0, c2: 0 }] });
    g.h.contextmenu({ zone: 'rowhdr' });
    items.find(i => i && /^Add/.test(i[0]))[2]();
};

module.exports = { run, edit, editMany, del, add, tick, drain, check, state, reparse };
