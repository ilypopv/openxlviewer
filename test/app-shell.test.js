'use strict';
const test = require('node:test');
const assert = require('node:assert');
const OX = require('../out/core/csv-parser.js');
require('../out/core/csv-provider.js');
require('../out/core/format.js');
require('../out/core/grid-core.js');
require('../out/core/app-shell.js');
const { budget } = require('./helpers/timing.js');

let seed = 987654321;
const rnd = n => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 4294967296) * n);
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000) => {
    const t0 = Date.now();
    while (!fn()) {
        if (Date.now() - t0 > ms) throw new Error('timeout');
        await wait(2);
    }
};

// A Shell without DOM: only the view/stats pipeline is exercised.
function mkShell(provider, hdr, sel) {
    const sh = Object.create(OX.Shell.prototype);
    Object.assign(sh, {
        provider,
        view: { sort: null, filters: new Map() },
        o: { headerRows: () => hdr },
        _tasks: {},
        _colCache: new Map(),
        loading: false,
        _order: null,
        msgs: [],
        stats: { textContent: '' },
        btnClear: { style: {} },
        grid: {
            setView(v) {
                sh.gridView = v;
            },
            getSelection: () => sel || { ranges: [{ r1: 0, c1: 0, r2: 0, c2: 0 }] }
        }
    });
    sh.setMessage = m => sh.msgs.push(m);
    sh._updateAll = () => {};
    return sh;
}
const csvProvider = (text, o) =>
    new OX.CsvProvider(OX.indexCsv(text, { hasHeaders: true }), Object.assign({ hasHeaders: true }, o));
const done = sh => waitFor(() => !sh.busy());

// the pre-redesign comparator, as the oracle
function oracle(p, hdr, c, dir, filt) {
    const keyOf = r => {
        const raw = p.getRaw(r, c);
        if (raw === '') return null;
        const n = Number(raw);
        return n === n && raw.trim() !== '' && !/^[=']/.test(raw) ? n : raw.toLowerCase();
    };
    let rows = [];
    for (let r = hdr; r < p.rowCount; r++) {
        if (filt && !filt(r)) continue;
        rows.push(r);
    }
    const keys = new Map(rows.map(r => [r, keyOf(r)]));
    rows.sort((a, b) => {
        const ka = keys.get(a),
            kb = keys.get(b);
        if (ka === kb) return a - b;
        if (ka === null) return 1;
        if (kb === null) return -1;
        const na = typeof ka === 'number',
            nb = typeof kb === 'number';
        if (na !== nb) return na ? -1 : 1;
        const d = na ? ka - kb : ka < kb ? -1 : 1;
        return d * dir || a - b;
    });
    const out = [];
    for (let r = 0; r < hdr; r++) out.push(r);
    return out.concat(rows);
}

function genCsv(rows) {
    const names = ['alpha', 'Beta', 'gamma', 'Delta', 'epsilon', 'ALPHA', 'beta', ''];
    const lines = ['id,num,txt,mixed'];
    for (let i = 0; i < rows; i++) {
        const num = rnd(5) === 0 ? '' : String((rnd(2000) - 1000) / (rnd(3) + 1));
        const mixed = rnd(3) === 0 ? names[rnd(names.length)] : rnd(4) === 0 ? '' : String(rnd(300));
        lines.push(i + ',' + num + ',' + names[rnd(names.length)] + (rnd(4) === 0 ? rnd(50) : '') + ',' + mixed);
    }
    return lines.join('\n') + '\n';
}

// a provider that only offers getRaw/getCell, like the XLSX one: exercises the generic fallbacks
function plain(p) {
    return {
        get rowCount() {
            return p.rowCount;
        },
        get colCount() {
            return p.colCount;
        },
        getRaw: (r, c) => p.getRaw(r, c),
        getCell: (r, c) => p.getCell(r, c),
        frozenRows: 1
    };
}

test('sort: CSV fast path and generic path equal the old comparator (asc/desc, blanks last, ties by row)', async () => {
    const p = csvProvider(genCsv(3000));
    for (const prov of [p, plain(p)]) {
        for (let c = 0; c < 4; c++)
            for (const dir of [1, -1]) {
                const sh = mkShell(prov, 1);
                sh.sortBy(c, dir);
                await done(sh);
                assert.deepStrictEqual(Array.from(sh._order), oracle(p, 1, c, dir), 'col ' + c + ' dir ' + dir);
            }
    }
});

test('filter by values and by text, combined with sort, equals a direct row scan', async () => {
    const p = csvProvider(genCsv(4000));
    for (const prov of [p, plain(p)]) {
        const sh = mkShell(prov, 1);
        sh.view.filters.set(2, { kind: 'set', set: new Set(['alpha', 'Beta', '']) });
        sh.view.filters.set(3, { kind: 'text', op: 'contains', q: '1' });
        sh.view.sort = { c: 1, dir: -1 };
        sh.recomputeView();
        await done(sh);
        const want = oracle(
            p,
            1,
            1,
            -1,
            r =>
                ['alpha', 'Beta', ''].includes(p.getCell(r, 2) ? p.getCell(r, 2).text : '') &&
                p.getRaw(r, 3).toLowerCase().includes('1')
        );
        assert.deepStrictEqual(Array.from(sh._order), want);
        assert.strictEqual(sh.gridView.order, sh._order);
        for (const [op, f] of [
            ['equals', s => s === 'beta'],
            ['starts', s => s.startsWith('al')],
            ['ends', s => s.endsWith('a')],
            ['notcontains', s => !s.includes('a')]
        ]) {
            const s2 = mkShell(prov, 1);
            s2.view.filters.set(2, {
                kind: 'text',
                op,
                q: op === 'equals' ? 'BETA' : op === 'starts' ? 'AL' : op === 'ends' ? 'A' : 'a'
            });
            s2.recomputeView();
            await done(s2);
            const exp = [0];
            for (let r = 1; r < p.rowCount; r++) if (f(p.getRaw(r, 2).toLowerCase())) exp.push(r);
            assert.deepStrictEqual(Array.from(s2._order), exp, op);
        }
    }
});

test('filtering a column with more than 50000 distinct values never silently hides rows', async () => {
    const n = 60000,
        lines = ['id,k'];
    for (let i = 0; i < n; i++) lines.push(i + ',key' + i);
    const p = csvProvider(lines.join('\n') + '\n');
    const sh = mkShell(p, 1);
    const it = sh._columnIds(1, false);
    let r = it.next();
    while (!r.done) r = it.next();
    assert.strictEqual(r.value.ids, null);
    assert.strictEqual(r.value.truncated, true);
    // text filter works on such columns and really filters
    sh.view.filters.set(1, { kind: 'text', op: 'contains', q: 'key5999' });
    sh.recomputeView();
    await done(sh);
    const want = [0];
    for (let i = 0; i < n; i++) if (('key' + i).includes('key5999')) want.push(i + 1);
    assert.deepStrictEqual(Array.from(sh._order), want);
    // a set filter stored before the column grew past the limit is still applied exactly (per-row path)
    const keep = new Set(['key1', 'key59999']);
    const s2 = mkShell(p, 1);
    s2.view.filters.set(1, { kind: 'set', set: keep });
    s2.recomputeView();
    await done(s2);
    assert.deepStrictEqual(Array.from(s2._order), [0, 2, 60000]);
});

test('a new request cancels the running one; clearView resets', async () => {
    const p = csvProvider(genCsv(120000));
    const sh = mkShell(p, 1);
    sh.sortBy(1, 1);
    assert.ok(sh.busy(), 'a 120k-row sort must not complete inside its first slice');
    sh.sortBy(3, -1);
    await done(sh);
    assert.deepStrictEqual(Array.from(sh._order.slice(0, 50)), oracle(p, 1, 3, -1).slice(0, 50));
    sh.clearView();
    assert.strictEqual(sh._order, null);
    assert.strictEqual(sh.gridView, null);
});

test('sorting 600k rows never blocks the event loop for long', async () => {
    const lines = ['a,b,c'];
    for (let i = 0; i < 600000; i++) lines.push(rnd(1e6) / 7 + ',w' + rnd(30000) + ',' + i);
    const p = csvProvider(lines.join('\n') + '\n');
    for (const c of [0, 1]) {
        const sh = mkShell(p, 1);
        let max = 0,
            ticks = 0,
            last = performance.now();
        const iv = setInterval(() => {
            const t = performance.now();
            max = Math.max(max, t - last);
            last = t;
            ticks++;
        }, 1);
        sh.sortBy(c, 1);
        await done(sh);
        clearInterval(iv);
        assert.strictEqual(sh._order.length, 600001);
        for (let i = 2; i < 600001; i += 997) {
            const a = p.getRaw(sh._order[i - 1], c),
                b = p.getRaw(sh._order[i], c);
            if (c === 0) assert.ok(Number(a) <= Number(b));
            else assert.ok(a.toLowerCase() <= b.toLowerCase());
        }
        assert.ok(ticks >= 3, 'the sort ran as one block: only ' + ticks + ' event-loop turns (col ' + c + ')');
        assert.ok(max < budget(120), 'longest stall ' + max.toFixed(0) + ' ms (col ' + c + ')');
    }
});

test('stats: selections are computed in the background, whole columns come from the cache, results are never partial', async () => {
    const lines = ['a,b,c'];
    let sum = 0,
        nums = 0,
        cnt = 0;
    const n = 300000;
    for (let i = 0; i < n; i++) {
        const v = i % 10 === 0 ? '' : i % 7 === 0 ? 'txt' : String(i % 1000);
        lines.push(v + ',' + i + ',x');
        if (v !== '') cnt++;
        if (v !== '' && v !== 'txt') {
            sum += Number(v);
            nums++;
        }
    }
    const p = csvProvider(lines.join('\n') + '\n', { formatValues: 'always' });
    const sel = { active: { r: 0, c: 0 }, ranges: [{ r1: 0, c1: 0, r2: n, c2: 0 }] };
    const sh = mkShell(p, 1, sel);
    sh._viewState = () => {};
    sh._updateName = () => {};
    sh._updateFormula = () => {};
    sh._runStats(sel);
    assert.ok(sh.busy() || /Count/.test(sh.stats.textContent));
    await done(sh);
    assert.ok(sh.stats.textContent.includes('Count: ' + (cnt + 1)), sh.stats.textContent); // + header cell
    assert.ok(
        sh.stats.textContent.includes('Sum: ' + sum) && sh.stats.textContent.includes('Count: ' + (cnt + 1)),
        sh.stats.textContent
    );
    assert.ok(!/partial/.test(sh.stats.textContent));
    const t0 = performance.now();
    sh._statKey = null;
    sh._runStats(sel);
    await done(sh);
    assert.ok(performance.now() - t0 < budget(50), 'cached whole-column stats');
    // select-all style multi column
    const all = { active: { r: 0, c: 0 }, ranges: [{ r1: 0, c1: 0, r2: n, c2: 2 }] };
    const s2 = mkShell(p, 1, all);
    s2._runStats(all);
    await done(s2);
    assert.ok(s2.stats.textContent.includes('Count: ' + (cnt + 1 + (n + 1) + (n + 1))), s2.stats.textContent);
    // a newer selection cancels the older computation
    const s3 = mkShell(p, 1, all);
    s3._runStats(all);
    const small = { active: { r: 1, c: 0 }, ranges: [{ r1: 1, c1: 1, r2: 3, c2: 1 }] };
    s3.grid.getSelection = () => small;
    s3._runStats(small);
    await done(s3);
    assert.ok(/Count: 3/.test(s3.stats.textContent), s3.stats.textContent);
});

test('stats under a sort/filter order only count the visible rows; generic providers work too', async () => {
    const p = csvProvider('a,b\n1,2\n3,4\n5,6\n7,8\n', { formatValues: 'always' });
    const sel = { active: { r: 0, c: 0 }, ranges: [{ r1: 1, c1: 0, r2: 2, c2: 1 }] };
    for (const prov of [p, plain(p)]) {
        const sh = mkShell(prov, 1, sel);
        sh._order = Int32Array.from([0, 4, 2]);
        sh._runStats(sel);
        await done(sh);
        assert.ok(/Count: 4 .*Sum: 22 .*Min: 3 .*Max: 8/.test(sh.stats.textContent), sh.stats.textContent); // view rows 1,2 = source rows 4 and 2
    }
});

test('mergeSortGen and radixRows are stable and correct', () => {
    const n = 5000,
        a = new Int32Array(n),
        vals = new Array(n);
    for (let i = 0; i < n; i++) {
        a[i] = i;
        vals[i] = rnd(50);
    }
    const g = OX.mergeSortGen(a, (x, y) => vals[x] < vals[y]);
    while (!g.next().done);
    for (let i = 1; i < n; i++)
        assert.ok(vals[a[i - 1]] < vals[a[i]] || (vals[a[i - 1]] === vals[a[i]] && a[i - 1] < a[i]));
    const cat = new Uint8Array(n),
        hi = new Uint32Array(n),
        lo = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        cat[i] = rnd(3);
        hi[i] = rnd(4) * 70000;
        lo[i] = rnd(100) * 1000;
    }
    const rows = new Int32Array(n);
    for (let i = 0; i < n; i++) rows[i] = i;
    const r = OX.radixRows(rows, cat, hi, lo);
    let x = r.next();
    while (!x.done) x = r.next();
    const out = x.value;
    for (let i = 1; i < n; i++) {
        const p = out[i - 1],
            q = out[i];
        const kp = [cat[p], hi[p], lo[p], p],
            kq = [cat[q], hi[q], lo[q], q];
        let le = true;
        for (let k = 0; k < 4; k++) {
            if (kp[k] < kq[k]) break;
            if (kp[k] > kq[k]) {
                le = false;
                break;
            }
        }
        assert.ok(le);
    }
});

test('runTask slices work, reports progress and can be cancelled', async () => {
    let ticks = 0,
        finished = false,
        prog = 0;
    function* g() {
        for (let i = 0; i < 50; i++) {
            const t = performance.now();
            while (performance.now() - t < 2);
            ticks++;
            yield i / 50;
        }
        return 7;
    }
    const t = OX.runTask(g(), {
        budget: 5,
        onProgress: p => {
            prog = p;
        },
        onDone: v => {
            finished = v === 7;
        }
    });
    assert.ok(!t.done && ticks < 50 && ticks >= 1);
    await waitFor(() => t.done);
    assert.ok(finished && prog > 0);
    let c2 = 0;
    function* h() {
        for (;;) {
            c2++;
            yield 0;
        }
    }
    const t2 = OX.runTask(h(), { budget: 3 });
    t2.cancel();
    const seen = c2;
    await wait(20);
    assert.strictEqual(c2, seen);
});
