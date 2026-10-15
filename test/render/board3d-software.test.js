// test/render/board3d-software.test.js — 软件渲染 / 弱显卡下 3D 棋盘的判定（render/app.js 与 board3d/load.js）:
// 「gl2fast=false ⇒ 3D 不启用，或（显式 `?board=3d`）给出警告」。
//
// 现场问题（2026-10，多个玩家）: 进游戏后黑屏 + 鼠标不动，只能重启浏览器 / 电脑。3D 棋盘（three.js）在软件
// 渲染的机器上同样被开启 —— 老判定 `webgl2Available(boardPref === '3d')` 把 `?board=3d` 映射成 allowSlow=true，
// 于是「major performance caveat」（SwiftShader / llvmpipe / 被黑名单的核显）也能过闸，让 CPU 硬跑一个全分辨率、
// 带阴影、带抗锯齿的场景，把驱动压到复位。
//
// 判定链（高 → 低）: `?board=2d`（紧急 / 远程总开关，记住在 localStorage）> 软件渲染 ⇒ 2D > 性能模式 ⇒ 2D >
// `?board=3d`（显式覆盖，软件渲染下照旧开启但必须警告）> 默认 3D。`board3dGate` 是 render/app.js、
// `__SP_BOARD3D_PROBE__()` 与 `stats().boardGate` 共用的同一份判定，所以这里测它等于测真实路径。

import { test, describe, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { board3dGate, board3dDeviceClass, resetBoard3dDeviceClass, webgl2Available, boardPreferenceFromURL } from '../../public/js/render/board3d/load.js';
import { boardPreference, storedBoardPreference, rememberBoardPreference, boardForcedByURL, BOARD_PREF_KEY } from '../../public/js/render/app/view.js';

// The stubbed globals are process-wide: whatever one test installs would otherwise be seen by every test after it
// (a leaked `sp.pref.board` would keep `boardPreference()` on 2D). Capture the real ones once and put them back
// after each test — no test may depend on the order it ran in.
const REAL = {};
before(() => { REAL.document = globalThis.document; REAL.location = globalThis.location; REAL.localStorage = globalThis.localStorage; });
afterEach(() => {
  for (const k of ['document', 'location', 'localStorage']) {
    if (REAL[k] === undefined) delete globalThis[k]; else globalThis[k] = REAL[k];
  }
  resetBoard3dDeviceClass();
});

/** A `localStorage` (and `location.search`) stub; returns a restore function. */
function stubBrowser({ board = null, search = '' } = {}) {
  const prev = { ls: globalThis.localStorage, loc: globalThis.location };
  const store = new Map();
  if (board !== null) store.set('sp.pref.' + BOARD_PREF_KEY, board);
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  globalThis.location = { search };
  return {
    store,
    restore() {
      if (prev.ls === undefined) delete globalThis.localStorage; else globalThis.localStorage = prev.ls;
      if (prev.loc === undefined) delete globalThis.location; else globalThis.location = prev.loc;
    },
  };
}

/** A `document` whose canvas answers like a given WebGL2 device; returns a restore function. */
function stubDocument({ fast = false, any = true } = {}) {
  const hadDoc = 'document' in globalThis;
  const prevDoc = globalThis.document;
  const makeCtx = () => ({ getExtension: () => null });
  globalThis.document = {
    createElement: () => ({
      getContext(type, opts) {
        if (type !== 'webgl2') return null;
        if (opts && opts.failIfMajorPerformanceCaveat) return fast ? makeCtx() : null;
        return any ? makeCtx() : null;
      },
    }),
  };
  return () => {
    resetBoard3dDeviceClass();
    if (hadDoc) globalThis.document = prevDoc; else delete globalThis.document;
  };
}

describe('board3dGate: the software renderer can no longer reach the 3D board by accident', () => {
  test('gl2fast=false (软件渲染) + auto ⇒ 3D off, and the player is told why', () => {
    const g = board3dGate('auto', { gl2fast: false, perf: false });
    assert.equal(g.want, false, 'the 3D board must not load on a software renderer');
    assert.equal(g.software, true);
    assert.equal(g.reason, 'software');
    assert.equal(g.notice, 'software', 'the fallback is visible, not silent');
  });

  test('gl2fast=false + 性能模式 ⇒ still 2D, but the explicit performance mode needs no explanation', () => {
    const g = board3dGate('auto', { gl2fast: false, perf: true });
    assert.equal(g.want, false);
    assert.equal(g.reason, 'software', 'the device decides before the setting does');
    assert.equal(g.notice, 'software');
  });

  test('gl2fast=true (真显卡) + auto ⇒ 3D on, no notice (behaviour unchanged)', () => {
    const g = board3dGate('auto', { gl2: true, gl2fast: true, perf: false });
    assert.deepEqual(g, { want: true, pref: 'auto', software: false, reason: 'ok', notice: null });
  });

  test('?board=2d wins over everything, software renderer or not', () => {
    for (const probe of [{ gl2fast: true, perf: false }, { gl2fast: false, perf: false }, { gl2fast: true, perf: true }]) {
      const g = board3dGate('2d', probe);
      assert.equal(g.want, false, JSON.stringify(probe));
      assert.equal(g.reason, '2d');
      assert.equal(g.notice, null);
    }
  });

  test('?board=3d is still honoured, but a software renderer gets an explicit warning notice', () => {
    const g = board3dGate('3d', { gl2fast: false, perf: false });
    assert.equal(g.want, true, 'the override stays available (high-end machines / dev)');
    assert.equal(g.reason, 'forced-software');
    assert.equal(g.notice, 'forced-software', 'never silently: this is the link that froze players');
    const ok = board3dGate('3d', { gl2fast: true, perf: false });
    assert.deepEqual(ok, { want: true, pref: '3d', software: false, reason: 'ok', notice: null });
  });

  test('?board=3d overrides 性能模式 (an explicit request the player can see), still warned on software', () => {
    const g = board3dGate('3d', { gl2fast: false, perf: true });
    assert.equal(g.want, true);
    assert.equal(g.notice, 'forced-software');
  });

  test('性能模式 in auto mode on a real GPU ⇒ 2D, silently', () => {
    const g = board3dGate('auto', { gl2fast: true, perf: true });
    assert.equal(g.want, false);
    assert.equal(g.reason, 'perf');
    assert.equal(g.notice, null);
  });

  test('the live device class is the fallback when no probe is passed', () => {
    const restore = stubDocument({ fast: false, any: true });
    try {
      resetBoard3dDeviceClass();
      assert.equal(board3dDeviceClass().software, true);
      assert.equal(board3dGate('auto').want, false);
      assert.equal(board3dGate('auto').notice, 'software');
      assert.equal(board3dGate('3d').notice, 'forced-software');
    } finally { restore(); }
  });
});

describe('board3dDeviceClass: the once-per-page device class', () => {
  test('software: WebGL2 only WITH the performance caveat (gl2fast would be false)', () => {
    const restore = stubDocument({ fast: false, any: true });
    try {
      resetBoard3dDeviceClass();
      assert.deepEqual(board3dDeviceClass(), { software: true, lazy: false });
      assert.equal(webgl2Available(false), false, 'the fast ask refuses it');
      assert.equal(webgl2Available(true), true, 'the slow ask accepts it — the old gate let this through');
    } finally { restore(); }
  });

  test('a real GPU: both asks succeed ⇒ not software', () => {
    const restore = stubDocument({ fast: true, any: true });
    try {
      resetBoard3dDeviceClass();
      assert.deepEqual(board3dDeviceClass(), { software: false, lazy: false });
    } finally { restore(); }
  });

  test('no WebGL2 at all ⇒ lazy, never software, and the gate stays CLOSED (three needs WebGL2)', () => {
    const restore = stubDocument({ fast: false, any: false });
    try {
      resetBoard3dDeviceClass();
      assert.deepEqual(board3dDeviceClass(), { software: false, lazy: true });
      const g = board3dGate('auto');
      assert.equal(g.want, false, 'no WebGL2 ⇒ no 3D board');
      assert.equal(g.reason, 'nogl2');
      assert.equal(g.notice, null, 'nothing to warn about: 3D was never possible');
      // and the explicit override must not pretend either — a context still has to exist
      assert.equal(board3dGate('3d', { gl2: false, gl2fast: false }).want, false);
    } finally { restore(); }
  });

  test('Node (no document) ⇒ lazy, and the gate stays closed without a notice', () => {
    resetBoard3dDeviceClass();
    assert.equal(typeof globalThis.document, 'undefined', 'this suite runs in plain Node');
    assert.deepEqual(board3dDeviceClass(), { software: false, lazy: true });
    assert.equal(board3dGate('auto').want, false);
    assert.equal(board3dGate('auto').reason, 'nogl2');
    assert.equal(board3dGate('auto').notice, null);
  });

  test('the result is cached: the expensive probe runs once per page, and reset() re-probes', () => {
    let contextCalls = 0;
    globalThis.document = {
      createElement: () => ({
        getContext(type, opts) {
          if (type !== 'webgl2') return null;
          contextCalls++;
          return opts && opts.failIfMajorPerformanceCaveat ? { getExtension: () => null } : null;
        },
      }),
    };
    try {
      resetBoard3dDeviceClass();
      assert.equal(board3dDeviceClass().software, false);
      board3dDeviceClass();
      board3dGate('auto');
      assert.equal(contextCalls, 1, 'two gate evaluations, one probe');
      resetBoard3dDeviceClass();
      board3dDeviceClass();
      assert.equal(contextCalls, 2, 'reset() asks again');
    } finally {
      resetBoard3dDeviceClass();
    }
  });
});

// `?board=2d` is the emergency switch players are sent when the 3D board freezes their machine: it must beat the
// device, the settings and the view option, and it must survive the player walking into a room (a fresh URL).
describe('remote 2D switch: ?board=2d is immediate and sticky', () => {
  test('the URL wins over everything and is remembered, so the next page load keeps 2D', () => {
    const b = stubBrowser({ search: '?board=2d' });
    try {
      assert.equal(boardForcedByURL(), true, 'the notice of this page load keys off this');
      assert.equal(boardPreference('3d'), '2d', 'over the view option');
      assert.equal(b.store.get('sp.pref.' + BOARD_PREF_KEY), '2d', 'remembered');
      // a later page load WITHOUT the query string (the room URL) still resolves to 2D
      globalThis.location = { search: '?room=ABCD' };
      assert.equal(boardForcedByURL(), false);
      assert.equal(boardPreference('3d'), '2d', 'the sticky switch holds');
      assert.equal(storedBoardPreference(), '2d');
    } finally { b.restore(); }
  });

  test('?board=auto forgets a stored 2D; ?board=3d re-enables and remembers 3D', () => {
    const b = stubBrowser({ board: '2d', search: '?board=auto' });
    try {
      assert.equal(boardPreference('auto'), 'auto');
      assert.equal(storedBoardPreference(), null, 'forgotten');
      globalThis.location = { search: '?board=3d' };
      assert.equal(boardPreference('2d'), '3d');
      assert.equal(storedBoardPreference(), '3d');
    } finally { b.restore(); }
  });

  test('an unrelated ?board= value falls through to the stored choice / the option, and is not remembered', () => {
    const b = stubBrowser({ board: '2d', search: '?board=what' });
    try {
      assert.equal(boardPreference('3d'), '2d', 'the stored 2D still holds');
      assert.equal(storedBoardPreference(), '2d', 'unchanged');
      assert.equal(boardPreferenceFromURL('?board=3d'), '3d');
      assert.equal(boardPreferenceFromURL(''), null);
    } finally { b.restore(); }
  });

  test('no storage at all (private mode): the switch of THIS page load still works', () => {
    const prev = globalThis.location;
    globalThis.location = { search: '?board=2d' };
    globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
    try {
      assert.equal(boardPreference('3d'), '2d');
      assert.equal(storedBoardPreference(), null);
      assert.doesNotThrow(() => rememberBoardPreference('2d'));
    } finally {
      delete globalThis.localStorage;
      globalThis.location = prev;
    }
  });

  test('a URL-carried ?board=2d is reported to the player (notice remote-2d), a remembered one is not', () => {
    assert.equal(board3dGate('2d', { gl2fast: true, remote: true }).notice, 'remote-2d');
    assert.equal(board3dGate('2d', { gl2fast: true, remote: false }).notice, null, 'nobody asked: stay quiet');
    assert.equal(board3dGate('2d').notice, null, 'no probe ⇒ no remote flag');
    assert.equal(board3dGate('2d', { gl2fast: true, remote: true }).want, false, 'and 3D stays off');
  });

  test('the pure gate agrees with the live device probe (the one the game actually calls)', () => {
    for (const [label, fast, any] of [['software', false, true], ['real gpu', true, true], ['no webgl2', false, false]]) {
      const restore = stubDocument({ fast, any });
      try {
        resetBoard3dDeviceClass();
        const cls = board3dDeviceClass();
        const live = board3dGate('auto');
        const pure = board3dGate('auto', { gl2: !cls.lazy, gl2fast: !cls.software, perf: false });
        assert.deepEqual(live, pure, label);
        resetBoard3dDeviceClass();
      } finally { restore(); }
    }
  });
});
