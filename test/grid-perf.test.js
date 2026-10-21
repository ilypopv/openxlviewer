const test = require('node:test');
const assert = require('node:assert');
const OX = require('../out/core/grid-core.js');
const { budget } = require('./helpers/timing.js');
const C = OX.GridCore;

function rng(seed) {
    let s = seed >>> 0;
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

// reference: dense prefix sums over the same sizes
function refAxis(count, sizes, def, z) {
    const u = Math.round(def * z * 100) / 100,
        pre = [0];
    for (let i = 0; i < count; i++) pre.push(pre[i] + (sizes.has(i) ? sizes.get(i) * z : u));
    return { pre, size: i => (sizes.has(i) ? sizes.get(i) * z : u) };
}

test('Axis picks sparse mode for few overrides and agrees with dense reference', () => {
    const count = 5000,
        def = 20,
        sizes = new Map([
            [3, 50],
            [4, 0],
            [100, 31],
            [4999, 7],
            [2500, 0]
        ]);
    const a = new C.Axis().build(count, i => (sizes.has(i) ? sizes.get(i) : def), null, def, 1);
    assert.equal(a.mode, 1);
    for (const z of [1, 1.5, 0.5]) {
        a.setZoom(z);
        const r = refAxis(count, sizes, def, z);
        for (const i of [0, 1, 3, 4, 5, 99, 100, 101, 2499, 2500, 2501, 4998, 4999]) {
            assert.ok(Math.abs(a.offset(i) - r.pre[i]) < 1e-6, 'offset ' + i);
            assert.ok(Math.abs(a.size(i) - r.size(i)) < 1e-9, 'size ' + i);
        }
        assert.ok(Math.abs(a.total - r.pre[count]) < 1e-6);
        for (const p of [0, 10, 70, 71, 5000, 49000, a.total - 1, a.total + 5]) {
            const i = a.indexAt(p);
            assert.ok(a.size(i) > 0 || i === count - 1);
            if (p < a.total) assert.ok(a.offset(i) <= p + 1e-6);
        }
    }
    assert.equal(a.nextVisible(3, 1), 5);
    assert.equal(a.nextVisible(5, -1), 3);
});

test('Axis.buildSparse equals build and setSizes updates incrementally', () => {
    const count = 100000,
        def = 24;
    const a = new C.Axis().buildSparse(
        count,
        def,
        1,
        new Map([
            [10, 40],
            [20, 0]
        ])
    );
    assert.equal(a.mode, 1);
    assert.equal(a.total, count * def + 16 - 24);
    a.setSizes(
        new Map([
            [10, 24],
            [30, 100]
        ])
    );
    assert.equal(a.size(10), 24);
    assert.equal(a.offset(31), 31 * 24 - 24 + 76);
    a.setSizes(
        new Map([
            [20, 24],
            [30, 24]
        ])
    );
    assert.equal(a.mode, 0);
    assert.equal(a.total, count * def);
    // many overrides switch to dense and stay consistent
    const m = new Map();
    for (let i = 0; i < count; i += 3) m.set(i, 10 + (i % 7));
    a.setSizes(m);
    assert.equal(a.mode, 2);
    let acc = 0;
    for (let i = 0; i < 300; i++) {
        assert.equal(a.offset(i), acc);
        acc += m.has(i) ? m.get(i) : def;
    }
    a.setSizes(new Map([[5, 99]]));
    assert.equal(a.offset(6) - a.offset(5), 99);
    const t = a.total;
    a.setZoom(2);
    assert.ok(Math.abs(a.total - 2 * t) < 1e-6);
});

test('Axis.setCount keeps sizes (uniform/sparse) and refuses dense', () => {
    const a = new C.Axis().buildSparse(1000, 20, 1, new Map([[900, 50]]));
    assert.ok(a.setCount(2000));
    assert.equal(a.total, 2000 * 20 + 30);
    assert.equal(a.size(900), 50);
    assert.ok(a.setCount(500));
    assert.equal(a.total, 500 * 20);
    assert.equal(a.size(900), 20);
    const d = new C.Axis().build(10, i => (i % 2 ? 5 : 30), null, 20, 1);
    assert.equal(d.mode, 2);
    assert.equal(d.setCount(11), false);
});

test('MergeIndex matches brute force on random non-overlapping merges', () => {
    const rnd = rng(7),
        merges = [];
    // grid of disjoint blocks of random sizes
    for (let r = 0; r < 4000; r += 7)
        for (let c = 0; c < 40; c += 9)
            if (rnd() < 0.6)
                merges.push({ r1: r, c1: c, r2: r + Math.floor(rnd() * 6), c2: c + Math.floor(rnd() * 8) });
    merges.push({ r1: 100000, c1: 0, r2: 900000, c2: 3 }); // tall
    const mi = new C.MergeIndex(merges);
    const brute = (r, c) => merges.find(m => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) || null;
    for (let i = 0; i < 20000; i++) {
        const r = Math.floor(rnd() * 4100),
            c = Math.floor(rnd() * 45);
        assert.equal(mi.at(r, c), brute(r, c));
    }
    assert.equal(mi.at(500000, 2), merges[merges.length - 1]);
    assert.equal(mi.at(500000, 4), null);
    assert.ok(mi.hasInRows(0, 20));
    assert.ok(mi.hasInRows(500000, 500001));
    const small = new C.MergeIndex([{ r1: 50, c1: 0, r2: 51, c2: 1 }]);
    assert.ok(!small.hasInRows(0, 40));
    assert.ok(small.hasInRows(40, 50));
    assert.ok(!small.hasInRows(100, 200));
    // expand equals fixed-point brute force
    const expandBrute = (r1, c1, r2, c2) => {
        for (let ch = true; ch;) {
            ch = false;
            for (const m of merges) {
                if (m.r1 > r2 || m.r2 < r1 || m.c1 > c2 || m.c2 < c1) continue;
                if (m.r1 < r1) {
                    r1 = m.r1;
                    ch = true;
                }
                if (m.c1 < c1) {
                    c1 = m.c1;
                    ch = true;
                }
                if (m.r2 > r2) {
                    r2 = m.r2;
                    ch = true;
                }
                if (m.c2 > c2) {
                    c2 = m.c2;
                    ch = true;
                }
            }
        }
        return { r1, c1, r2, c2 };
    };
    for (let i = 0; i < 300; i++) {
        const r1 = Math.floor(rnd() * 4000),
            c1 = Math.floor(rnd() * 40),
            r2 = r1 + Math.floor(rnd() * 30),
            c2 = c1 + Math.floor(rnd() * 12);
        assert.deepEqual(mi.expand(r1, c1, r2, c2), expandBrute(r1, c1, r2, c2));
    }
    assert.deepEqual(mi.expand(0, 0, 1e6, 100), expandBrute(0, 0, 1e6, 100));
});

test('MergeIndex with millions of merged cells answers fast', () => {
    const merges = [];
    for (let r = 0; r < 300000; r += 2) merges.push({ r1: r, c1: 0, r2: r + 1, c2: 9 });
    const mi = new C.MergeIndex(merges);
    const t0 = Date.now();
    let hits = 0;
    for (let r = 150000; r < 150060; r++) for (let c = 0; c < 30; c++) if (mi.at(r, c)) hits++;
    assert.equal(hits, 600);
    assert.ok(Date.now() - t0 < budget(50));
});

test('WidthCache stays bounded by entries and chars, skips long strings, keeps hot keys', () => {
    const w = new C.WidthCache(100, 500, 20);
    let calls = 0;
    const f = s => (calls++, s.length);
    for (let i = 0; i < 1000; i++) w.get('f', 'key' + i, f);
    assert.ok(w.n <= 100 && w.chars <= 500 + 10);
    const long = 'x'.repeat(50);
    calls = 0;
    w.get('f', long, f);
    w.get('f', long, f);
    assert.equal(calls, 2);
    calls = 0;
    w.get('f', 'hot', f);
    for (let i = 0; i < 50; i++) {
        w.get('f', 'k' + i, f);
        w.get('f', 'hot', f);
    }
    assert.equal(calls, 1 + 50);
});

test('makeMatcher: case, whole cell, regex-special chars', () => {
    assert.ok(C.makeMatcher('a.c', {})('xA.Cx'));
    assert.ok(!C.makeMatcher('a.c', {})('xABCx'));
    assert.ok(C.makeMatcher('Abc', { matchCase: true })('xAbcx'));
    assert.ok(!C.makeMatcher('Abc', { matchCase: true })('xabcx'));
    assert.ok(C.makeMatcher('abc', { wholeCell: true })('ABC'));
    assert.ok(!C.makeMatcher('abc', { wholeCell: true })('ABCD'));
    assert.ok(C.makeMatcher('line2', {})('line1\nLine2'));
    assert.ok(C.makeMatcher('(x)', {})('a(X)b'));
});

test('createSlicer: sync first slice, deferred rest, budget passed, cancel', () => {
    let t = 0;
    const q = [];
    const defer = f => q.push(f);
    const seen = [];
    let n = 0;
    const s = C.createSlicer(
        deadline => {
            seen.push(deadline);
            t += 3;
            return ++n >= 4;
        },
        { now: () => t, budget: 8, defer }
    );
    let done = 0;
    const s2 = C.createSlicer(() => true, { now: () => t, defer, onDone: () => done++ });
    s.start(true);
    assert.equal(n, 1);
    assert.equal(q.length, 1);
    assert.equal(seen[0], 8);
    while (q.length) q.shift()();
    assert.equal(n, 4);
    assert.ok(s.finished);
    s2.start(true);
    assert.equal(done, 1);
    assert.equal(q.length, 0);
    let m = 0;
    const s3 = C.createSlicer(
        () => {
            m++;
            return false;
        },
        { now: () => t, defer }
    );
    s3.start(false);
    s3.start(false);
    assert.equal(q.length, 1);
    q.shift()();
    assert.equal(m, 1);
    s3.cancel();
    q.shift()();
    assert.equal(m, 1);
});

test('FindScan: two-phase order, resumable, deadline, truncation, get2 fallback', () => {
    const texts = new Map([
        ['2,1', 'foo'],
        ['5,0', 'FOO bar'],
        ['8,3', 'xfoo'],
        ['0,2', 'foo'],
        ['3,3', 'zzz']
    ]);
    const raw = new Map([['4,4', 'hidden foo line2']]);
    const get = (r, c) => texts.get(r + ',' + c);
    const get2 = (r, c) => raw.get(r + ',' + c);
    const match = C.makeMatcher('foo', {});
    const s = new C.FindScan({ rowCount: 10, colCount: 5, getText: get, getText2: get2, match, startRow: 4 });
    let t = 0,
        slices = 0;
    while (!s.step(t + 1, () => (t += 1))) slices++;
    assert.ok(slices >= 1, 'yields before finishing when the deadline is tiny');
    const keys = [...Array.from(s.B.a.subarray(0, s.B.n)), ...Array.from(s.A.a.subarray(0, s.A.n))];
    assert.deepEqual(keys, [0 * 65536 + 2, 2 * 65536 + 1, 4 * 65536 + 4, 5 * 65536, 8 * 65536 + 3]);
    assert.deepEqual(
        keys,
        keys.slice().sort((a, b) => a - b)
    );
    assert.equal(C.lowerBound(s.A, 5 * 65536), 1);
    const lim = new C.FindScan({
        rowCount: 10,
        colCount: 5,
        getText: get,
        getText2: get2,
        match,
        startRow: 0,
        maxMatches: 2
    });
    assert.ok(lim.step(Infinity, () => 0));
    assert.ok(lim.truncated);
    assert.equal(lim.count, 2);
    const start = new C.FindScan({
        rowCount: 3,
        colCount: 3,
        getText: () => 'q',
        match: C.makeMatcher('q', {}),
        startRow: 99
    });
    start.step(Infinity, () => 0);
    assert.equal(start.count, 9);
    assert.equal(start.B.n, 9);
});

test('FindScan yields every few rows without losing matches', () => {
    const rows = 5000,
        get = (r, c) => (c === 0 && r % 7 === 0 ? 'hit' + r : undefined);
    const s = new C.FindScan({
        rowCount: rows,
        colCount: 3,
        getText: get,
        match: C.makeMatcher('hit', {}),
        startRow: 2500
    });
    let t = 0,
        n = 0;
    while (!s.step(t + 5, () => (t += 0.1))) n++;
    assert.ok(n > 5);
    assert.equal(s.count, Math.ceil(rows / 7));
});

test('TsvBuilder equals encodeTSV, resumes across slices, skips rows', () => {
    const rows = [];
    for (let i = 0; i < 9000; i++) rows.push(['a' + i, i % 5 === 0 ? 'x\ty' : '', i % 7 === 0 ? 'say "hi"\nnow' : 'v']);
    const skip = i => i % 11 === 10;
    const b = new C.TsvBuilder({
        rowCount: rows.length,
        getRow: i => (skip(i) ? null : rows[i].map(s => (s === '' ? s : C.tsvField(s))).join('\t'))
    });
    let t = 0,
        slices = 0;
    while (!b.step(t + 2, () => (t += 0.05))) slices++;
    assert.ok(slices > 1);
    assert.equal(b.text(), C.encodeTSV(rows.filter((_, i) => !skip(i))));
    assert.ok(b.parts.length >= 2);
});

test('TsvBuilder enforces the size cap and aborts early on a huge projection', () => {
    const b = new C.TsvBuilder({ rowCount: 1e6, maxChars: 1000, getRow: () => 'x'.repeat(100) });
    assert.ok(b.step(Infinity, () => 0));
    assert.ok(b.tooLarge);
    assert.equal(b.text(), '');
    const c = new C.TsvBuilder({ rowCount: 1e6, maxChars: 1e7, getRow: () => 'x'.repeat(1000) });
    assert.ok(c.step(Infinity, () => 0));
    assert.ok(c.tooLarge);
    assert.ok(c.i < 3000, 'projection abort after the sample');
    assert.ok(c.projected > 4e7);
    const e = new C.TsvBuilder({ rowCount: 0, getRow: () => '' });
    assert.ok(e.step(Infinity, () => 0));
    assert.equal(e.text(), '');
});
