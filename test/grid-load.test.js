const test = require('node:test');
const assert = require('node:assert');
const OX = require('../out/core/grid-core.js');
require('../out/core/grid.js');

test('Grid module loads headless and exposes API', () => {
  assert.equal(typeof OX.Grid, 'function');
  for (const m of ['setProvider', 'refresh', 'invalidate', 'select', 'getSelection', 'scrollTo', 'getScroll', 'setScroll', 'setZoom', 'getZoom', 'startEdit', 'find', 'findNext', 'findPrev', 'clearFind', 'setView', 'themeChanged', 'focus', 'destroy', 'on', 'off', 'getColumnValues'])
    assert.equal(typeof OX.Grid.prototype[m], 'function', m);
});

test('color parsing', () => {
  assert.deepEqual(OX.Grid._parseColor('#fff'), [255, 255, 255, 1]);
  assert.deepEqual(OX.Grid._parseColor('rgb(1, 2, 3)'), [1, 2, 3, 1]);
  assert.equal(OX.Grid._parseColor('nope'), null);
});

test('literalText providers: fill and internal paste do not shift =A2', () => {
  const mk = (literal) => {
    const raws = [['=A2'], ['']];
    const edits = [];
    const g = Object.create(OX.Grid.prototype);
    g.provider = { literalText: literal, getRaw: (r, c) => (raws[r] || [])[c] };
    g.view = { toSource: (v) => v };
    g.readOnly = false; g.active = { r: 2, c: 0 }; g.mi = { at: () => null };
    g.ranges = [{ r1: 0, c1: 0, r2: 0, c2: 0 }];
    g._clip = { raws: [['=A2']], text: '=A2', r: 0, c: 0 };
    g.emit = (n, e) => { if (n === 'edit') edits.push(...e.edits); };
    g._growPad = () => {}; g._clampSel = () => {}; g._selChanged = () => {};
    return { g, edits };
  };
  for (const [literal, want] of [[true, '=A2'], [false, '=A4']]) {
    const f = mk(literal);
    assert.equal(f.g._fillEdits({ r1: 0, c1: 0, r2: 0, c2: 0 }, 'down', 2, true)[1].text, want === '=A2' ? '=A2' : '=A4');
    const p = mk(literal);
    p.g.ranges = [{ r1: 2, c1: 0, r2: 2, c2: 0 }];
    p.g.pasteText('=A2');
    assert.equal(p.edits[0].text, literal ? '=A2' : '=A4');
  }
});
