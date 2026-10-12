// 乐观界面反馈 (approved plan A, 2026-10-12): a tap must acknowledge itself on its own frame instead of waiting for the
// round trip (~2× main-thread queueing + 2× network; the server itself spends 1–2 ms). ui/gameActions.js `act()`
// publishes a *pending* intent for exactly as long as one request is unanswered and ui/shopBar.js / ui/hud.js paint a
// purely visual held state from it. What this file pins down:
//   * the pending signal appears synchronously — before any await, i.e. in the tap's own frame;
//   * one token per request, counted per UI key: a refused intent never withdraws another intent's feedback;
//   * a refusal (or the 8 s timeout) clears the feedback and says why through the *existing* toast path, once;
//   * no authoritative value is guessed: with a real match's frame, a pending buy still renders an unsold card, and the
//     server's frame — not the pending state — is what turns it into 已招募 (the frame always wins);
//   * with 乐观界面反馈 off the snapshot is empty, so every component renders what it rendered before the feature.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// data.get()'s transport (test/ui/feedback1-offers.test.js does the same; written without try/catch, whose `catch`
// block eslint's rewritten no-unreachable rule flags in this position)
globalThis.fetch = async (url) => {
  const file = path.join(ROOT, 'data', String(url).split('/').pop());
  if (!existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
  const body = readFileSync(file, 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(body) };
};

const { act, actions, pendingKey, pendingKeys, isPendingKey, isPendingType, pendingTotal, onPendingChange } =
  await import('../../public/js/ui/gameActions.js');
const { net, Net, NetError, REQUEST_TIMEOUT_MS } = await import('../../public/js/net.js');
const { ChessCard, ItemCard, RewardCards, shopPending } = await import('../../public/js/ui/shopBar.js');
// The refusal's user-visible half is the *existing* toast path (ui/toasts.js); it is observed through diag.js's error
// log, because toastError() records before it shows and `recordError` counts repeats — Ui/ToastHost itself is a
// component and needs a hook context to render.
const { errorLog, errorCount, clearErrorLog } = await import('../../public/js/diag.js');
const { data } = await import('../../public/js/data.js');
const { makeMatch } = await import('../match/harness.js');

await data.loadAll('chess', 'bonds', 'items', 'assets');

// ---- vnode helpers (no DOM: the components return htm vnodes) ------------------------------------------------------

function* walk(v) {
  if (Array.isArray(v)) { for (const x of v) yield* walk(x); return; }
  if (!v || typeof v !== 'object') return;
  yield v;
  yield* walk(v.props?.children);
}
const classOf = (v) => String(v?.props?.class ?? '');
const hasClass = (v, c) => classOf(v).split(/\s+/).includes(c);
const textOf = (v) => [...walk(v)].filter((n) => typeof n === 'string' || typeof n === 'number').join('');
const marked = (v) => [...walk(v)].filter((n) => n.props?.['aria-busy'] === 'true');

/** A stub `net.request` whose promises the test settles by hand (act() looks net.request up per call). */
function stubNet() {
  const orig = net.request;
  const calls = [];
  net.request = (t, fields) => {
    const entry = { t, fields };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = () => resolve({ t: 'ok' });
      entry.reject = (err) => reject(err);
    });
    calls.push(entry);
    return entry.promise;
  };
  return { calls, restore: () => { net.request = orig; } };
}

/** The snapshot of unanswered intents that screens/game.js hands the bar. */
function pendingOf(keys) {
  const set = new Set(keys);
  return { keys: set, has: (t, fields) => set.has(pendingKey(t, fields)) };
}
const NO_PENDING = pendingOf([]);

/**
 * The card ui/shopBar.js renders for a frame's slot, with the key mapping the bar applies (`ShopBar` itself needs
 * Preact's hook context — useTwoTap — so the bar's own wiring is covered by the source assertions in section 4 and by
 * test/ui/*.e2e.test.js; ChessCard / ItemCard are hook-free and render here for real).
 */
function cardAt(priv, slotIdx, pending) {
  const slot = priv.shop.slots[slotIdx];
  const pend = shopPending(pending);
  return slot.kind === 'item'
    ? ItemCard({ slot, idx: slotIdx, onBuy() {}, onDetail() {}, pending: pend.buy(slotIdx) })
    : ChessCard({ slot, idx: slotIdx, priv, onBuy() {}, onDetail() {}, pending: pend.buy(slotIdx) });
}

/** A solo prep with funds and a filled shop — its privateView() IS the server frame. */
function prep(seed = 71) {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed, fake: true }).start();
  h.toPrep(1);
  const ps = h.ps('p_0');
  ps.funds = 40;
  ps.recompute();
  return { m: h.m, ps };
}
/** The buyable operator slots in the order the bar renders them. */
const operatorSlots = (frame) => frame.shop.slots.map((s, i) => ({ s, i })).filter(({ s }) => s && s.kind !== 'item');

// ---- 1. the pending signal is synchronous (the tap's own frame) ----------------------------------------------------

describe('乐观界面反馈: act() publishes a pending intent', () => {
  test('a tap holds the UI before anything is awaited, and the reply clears it', async () => {
    const stub = stubNet();
    const ticks = [];
    const off = onPendingChange(() => ticks.push([...pendingKeys()]));
    try {
      const p = actions.buy(2);                       // deliberately NOT awaited
      assert.equal(stub.calls.length, 1, 'the request went out on the same turn');
      assert.deepEqual(stub.calls[0].fields, { slot: 2 });
      assert.equal(isPendingKey('g.buy:2'), true, 'pending the instant the tap is handled — no await, no timer');
      assert.equal(pendingTotal(), 1);
      assert.equal(ticks.length, 1, 'the subscriber ran synchronously, so the UI paints in the tap\'s own frame');
      stub.calls[0].resolve();
      assert.equal(await p, true);
      assert.equal(isPendingKey('g.buy:2'), false, 'the reply withdrew the feedback');
      assert.equal(pendingTotal(), 0);
      assert.equal(ticks.length, 2);
    } finally { off(); stub.restore(); }
  });

  test('the key names the tapped target, so two different cards never share one feedback', async () => {
    const stub = stubNet();
    try {
      const a = actions.buy(0);
      const b = actions.buy(3);
      assert.equal(isPendingKey('g.buy:0'), true);
      assert.equal(isPendingKey('g.buy:3'), true);
      assert.equal(isPendingKey('g.buy:1'), false);
      assert.equal(isPendingType('g.buy'), true);
      assert.equal(isPendingType('g.refresh'), false);
      stub.calls[0].resolve();
      assert.equal(await a, true);
      assert.equal(isPendingKey('g.buy:0'), false, 'the answered card is released');
      assert.equal(isPendingKey('g.buy:3'), true, 'the other card is untouched');
      stub.calls[1].resolve();
      assert.equal(await b, true);
      assert.equal(pendingTotal(), 0);
    } finally { stub.restore(); }
  });

  test('the key of every priority intent, and the type lookup', async () => {
    const stub = stubNet();
    try {
      const p = actions.ready(true);
      assert.equal(isPendingType('g.ready'), true);
      assert.equal(pendingKey('g.ready', { ready: true }), 'g.ready:true');
      assert.equal(isPendingType('g.band'), false);
      assert.equal(isPendingType('g.bandFocus'), false, 'g.bandFocus is its own type, never counted as g.band');
      // 换位 / 上阵 / 撤回 / 出售 carry the piece they move, so a second piece's feedback is independent
      assert.equal(pendingKey('g.move', { uid: 17, to: { area: 'hand', idx: 2 } }), 'g.move:17');
      assert.equal(pendingKey('g.art', { itemUid: 9, row: 11, col: 6 }), 'g.art:9');
      assert.equal(pendingKey('g.equip', { itemUid: 4, targetUid: 7 }), 'g.equip:4');
      assert.equal(pendingKey('g.sell', { uid: 5 }), 'g.sell:5');
      assert.equal(pendingKey('g.reward', { idx: 1 }), 'g.reward:1');
      assert.equal(pendingKey('g.refresh'), 'g.refresh', 'an intent without a target is keyed by its type');
      stub.calls[0].resolve();
      assert.equal(await p, true);
    } finally { stub.restore(); }
  });

  test('a quiet (fire-and-forget) intent publishes nothing — g.bandFocus must not churn the UI', async () => {
    const stub = stubNet();
    try {
      const p = act('g.bandFocus', { bandId: 'band_cathy' }, { sfx: false, quiet: true });
      assert.equal(pendingTotal(), 0, 'a highlight change holds no button');
      assert.equal(stub.calls.length, 1, 'it is still sent');
      stub.calls[0].resolve();
      await p;
      assert.equal(pendingTotal(), 0);
      const e = actions.emote('hi');                  // also quiet
      assert.equal(pendingTotal(), 0);
      stub.calls[1].resolve();
      await e;
    } finally { stub.restore(); }
  });
});

// ---- 2. a refusal / timeout withdraws the feedback, through the existing toast path --------------------------------

describe('乐观界面反馈: a refusal withdraws it and says why (existing toast, once)', () => {
  test('error ⇒ feedback cleared + exactly one error toast', async () => {
    const stub = stubNet();
    clearErrorLog();
    try {
      const p = actions.buy(1);
      assert.equal(isPendingKey('g.buy:1'), true);
      stub.calls[0].reject(new NetError('NO_FUNDS'));
      assert.equal(await p, false);
      assert.equal(isPendingKey('g.buy:1'), false, 'a refused intent must not leave the card held');
      assert.equal(pendingTotal(), 0);
      const log = errorLog();
      assert.equal(errorCount(), 1, 'exactly one report — act()\'s existing error path, never a second message');
      assert.equal(log.length, 1);
      assert.equal(log[0].source, 'request', 'toastError (ui/toasts.js) is the reporter');
      assert.match(log[0].message, /资金不足/, 'with the server\'s reason');
      assert.equal(log[0].count, 1, 'and not a merged duplicate (×2 would mean double reporting)');
    } finally { stub.restore(); }
  });

  test('one intent\'s failure never withdraws another intent\'s feedback (even on the same key)', async () => {
    const stub = stubNet();
    try {
      const first = actions.refresh();
      const second = actions.refresh();               // same key: a second unanswered request
      assert.equal(pendingTotal(), 2, 'counted, not a boolean');
      stub.calls[0].reject(new Error('boom'));
      assert.equal(await first, false);
      assert.equal(isPendingKey('g.refresh'), true, 'the second request is still unanswered — stay held');
      stub.calls[1].resolve();
      assert.equal(await second, true);
      assert.equal(isPendingKey('g.refresh'), false);
      assert.equal(pendingTotal(), 0);
    } finally { stub.restore(); }
  });

  test('the 8 s request timeout is what bounds the feedback (no stuck held state)', async () => {
    assert.equal(REQUEST_TIMEOUT_MS, 8000);
    const timers = {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, Math.min(ms, 1)),
      clearTimeout: (id) => globalThis.clearTimeout(id),
      setInterval: () => 0, clearInterval: () => {},
    };
    const sock = { readyState: 1, send() {}, close() {} };
    const real = new Net({ url: 'ws://t/ws', WebSocket: function FakeWS() { return sock; }, timers, getToken: () => null });
    real.status = 'online';
    real.ws = sock;
    const orig = net.request;
    net.request = (t, f) => real.request(t, f);
    clearErrorLog();
    try {
      const p = actions.buy(4);
      assert.equal(isPendingKey('g.buy:4'), true);
      assert.equal(await p, false, 'a timeout is a failure (the usual toast)');
      assert.equal(isPendingKey('g.buy:4'), false, 'and the feedback goes with it');
      const log = errorLog();
      assert.equal(errorCount(), 1);
      assert.match(log[0].message, /请求超时，请重试/, 'the 8 s timeout is what ended the held state');
      assert.equal(real.pendingCount, 0);
    } finally { net.request = orig; }
  });
});

// ---- 3. nothing authoritative is guessed; the server frame wins ----------------------------------------------------

describe('乐观界面反馈: the frame, not the pending state, decides what a card shows', () => {
  test('a pending buy still renders a buyable card — the server frame is what sells it', () => {
    const { m, ps } = prep();
    const order = operatorSlots(ps.privateView());
    assert.ok(order.length >= 1, 'the shop deals operator cards');
    const { s: target, i: slot } = order[order.length - 1];
    const frame0 = ps.privateView();

    const before = cardAt(frame0, slot, NO_PENDING);
    assert.equal(hasClass(before, 'scard--sold'), false, 'the frame says this slot is unsold');
    assert.equal(marked(before).length, 0);

    // the player tapped that card a second time: the card is held, but keeps rendering the UNSOLD card
    const held = cardAt(frame0, slot, pendingOf([pendingKey('g.buy', { slot })]));
    assert.equal(hasClass(held, 'scard--sold'), false, 'no optimistic sale is ever guessed');
    assert.equal(textOf(held).includes('已招募'), false, 'and never the server\'s word for it');
    assert.equal(held.props['aria-busy'], 'true', 'the card is only marked as pending');
    assert.equal(held.props.disabled, true, 'and it cannot be tapped again');
    assert.equal([...walk(held)].some((v) => hasClass(v, 'apend')), true, 'with the sweep bar');
    assert.equal(textOf(held), textOf(before), 'the pending state adds no content of its own');
    assert.equal(held.props['aria-label'], before.props['aria-label'], 'the card is still the frame\'s own card');

    // the frame is untouched by the local feedback (nothing authoritative is ever written locally)
    const snapshot = (v) => JSON.parse(JSON.stringify(v));
    assert.deepEqual(snapshot(ps.privateView()), snapshot(frame0), 'the pending state never mutates the frame');

    // the server applies it and pushes the frame: the frame — and only the frame — carries the sale
    assert.deepEqual(m.handle('p_0', { t: 'g.buy', slot }), { ok: true });
    const frame1 = ps.privateView();
    assert.equal(frame1.shop.slots[slot].sold, true, 'the server frame now says sold');
    assert.equal(frame1.shop.slots[slot].id, target.id, 'for the slot the player bought');
    assert.ok(frame1.funds < frame0.funds, 'and it charged the funds');
    assert.equal(marked(cardAt(frame1, slot, NO_PENDING)).length, 0, 'no feedback is left behind once the frame moved');
    // the bar draws 已招募 from that one flag and from nothing else (`s.sold` is the frame's own field)
    const src = readFileSync(path.join(ROOT, 'public/js/ui/shopBar.js'), 'utf8');
    assert.match(src, /if \(s\.sold\) return html`<\$\{SoldCard\}/, 'the sold card is chosen from the frame alone');
    m.dispose();
  });

  test('a refused buy leaves the frame exactly as it was — the card stays buyable', async () => {
    const { m, ps } = prep(74);
    const slot = operatorSlots(ps.privateView()).at(-1).i;
    const before = JSON.parse(JSON.stringify(ps.privateView()));
    const stub = stubNet();
    try {
      const p = actions.buy(slot);
      assert.equal(isPendingKey(`g.buy:${slot}`), true);
      stub.calls[0].reject(new NetError('NO_FUNDS'));
      assert.equal(await p, false);
      assert.equal(isPendingKey(`g.buy:${slot}`), false);
      assert.deepEqual(JSON.parse(JSON.stringify(ps.privateView())), before, 'a refusal changes nothing authoritative');
      assert.equal(marked(cardAt(ps.privateView(), slot, NO_PENDING)).length, 0, 'and the card is rendered plainly again');
    } finally { stub.restore(); m.dispose(); }
  });

  test('the bar maps each of its elements to the key act() publishes', () => {
    const keys = [pendingKey('g.buy', { slot: 2 }), pendingKey('g.refresh')];
    const p = shopPending(pendingOf(keys));
    assert.equal(p.buy(2), true, 'the tapped slot');
    assert.equal(p.buy(1), false, 'and only that slot');
    assert.equal(p.buy(0), false);
    assert.equal(p.refresh, true);
    assert.equal(p.freeze, false);
    assert.equal(p.level, false);
    assert.equal(p.reward(0), false, 'a reward pick is its own intent (g.reward), never a buy');

    const reward = shopPending(pendingOf([pendingKey('g.reward', { idx: 1 }), pendingKey('g.freeze'), pendingKey('g.levelUp')]));
    assert.equal(reward.reward(1), true);
    assert.equal(reward.reward(0), false);
    assert.equal(reward.buy(1), false, 'the same index under another intent type is not the same element');
    assert.equal(reward.freeze, true);
    assert.equal(reward.level, true);
    assert.equal(reward.refresh, false);

    // no snapshot / the switch off ⇒ nothing is marked anywhere
    for (const off of [null, pendingOf([])]) {
      const q = shopPending(off);
      assert.equal(q.refresh || q.freeze || q.level || q.buy(0) || q.buy(1) || q.reward(0), false);
    }
  });

  test('a reward offer renders its cards for real, and holds only the picked one', () => {
    const { m, ps } = prep(75);
    // 凯瑟琳 定向投放 (the strategy feedback1-offers.test.js uses): a level-up queues three free item slots
    ps.bandId = 'band_cathy';
    ps.recompute();
    ps.shop.upgradePrice = 0;
    assert.deepEqual(m.handle('p_0', { t: 'g.levelUp' }), { ok: true }, 'the level-up queues an offer');
    const offer = ps.privateView().shop.rewardOffer;
    assert.ok(offer && offer.slots.length >= 2, `an offer with several slots (${offer && offer.slots.length})`);
    const priv = ps.privateView();
    const render = (pending) => RewardCards({
      offer, priv, editable: true, onPick() {}, onDetail() {}, onLater() {}, armed: null, onTap() {}, pending,
    });
    const cards = (v) => [...walk(v)].filter((n) => n.type === ItemCard || n.type === ChessCard);

    const plain = render(null);
    assert.equal(cards(plain).length, offer.slots.length);
    assert.equal(marked(plain).length, 0, 'nothing held without an unanswered intent');

    const pick = offer.slots.length - 1;
    const held = render(pendingOf([pendingKey('g.reward', { idx: pick })]));
    // RewardCards returns the *unrendered* ItemCard/ChessCard vnodes, so this reads the prop it passes down
    // (the render test above pins what a card does with `pending: true`).
    const busy = cards(held).filter((v) => v.props.pending === true);
    assert.equal(busy.length, 1, 'exactly the picked slot is held');
    assert.equal(cards(held).indexOf(busy[0]), pick, 'and it is the one the player tapped');
    assert.equal(cards(held)[0].props.pending, false, 'the other offer slots stay tappable');
    m.dispose();
  });
});

// ---- 4. the switch (设置 → 乐观界面反馈) and its wiring ------------------------------------------------------------

describe('乐观界面反馈: the setting is ON by default and gates every marker', () => {
  test('screens/game.js builds an empty snapshot when the setting is off', () => {
    const src = readFileSync(path.join(ROOT, 'public/js/screens/game.js'), 'utf8');
    assert.match(src, /optimisticFeedback !== false/, 'default ON (a profile saved before the setting keeps it on)');
    assert.match(src, /if \(!optimistic\) return EMPTY_PENDING;/, 'off ⇒ the empty snapshot ⇒ no marker is rendered');
    assert.match(src, /pending=\$\{pending\}/, 'the bar gets the snapshot');
    assert.match(src, /readyPending=\$\{readyBusy && optimistic\}/, 'the ready marker is gated too, its disable is not');
  });

  test('the shop bar wears the marker on the element it belongs to (source, ShopBar needs a render context)', () => {
    const src = readFileSync(path.join(ROOT, 'public/js/ui/shopBar.js'), 'utf8');
    // the cards / the two tool buttons are held and disabled; the level card only flips aria-busy
    assert.match(src, /disabled=\$\{pending \? true : undefined\} aria-busy=\$\{pending \? 'true' : undefined\}/);
    assert.match(src, /class=\$\{cx\('toolbtn', 'toolbtn--ice', frozen && 'is-on'\)\} disabled=\$\{\!\!frzReason \|\| frzPending\}/);
    assert.match(src, /class="toolbtn toolbtn--amber" disabled=\$\{\!\!refReason \|\| refPending\}/);
    assert.match(src, /aria-busy=\$\{pending \? 'true' : undefined\}\n *title=/);
    assert.equal((src.match(/class="apend"/g) || []).length, 5, 'both cards, 冻结, 刷新 and the level card carry the sweep bar');
  });

  test('the ready toggle is disabled by its own busy flag and painted from the gated marker', () => {
    const src = readFileSync(path.join(ROOT, 'public/js/ui/hud.js'), 'utf8');
    assert.match(src, /disabled=\$\{\!\!reason \|\| busy\}/, 'the disable behaviour is the pre-existing one');
    assert.match(src, /aria-busy=\$\{pendingMark \? 'true' : undefined\}/);
    assert.match(src, /pendingMark \? html`<span class="apend"/);
    assert.match(src, /pendingMark=\$\{readyPending\}/);
  });

  test('every element of the bar asks about exactly one intent type', () => {
    const src = readFileSync(path.join(ROOT, 'public/js/ui/shopBar.js'), 'utf8');
    // only shopPending() probes a key by hand; the bar itself goes through it
    for (const t of ['g.buy', 'g.reward', 'g.refresh', 'g.freeze', 'g.levelUp']) {
      assert.ok(src.includes(`has('${t}'`), `the bar maps ${t}`);
    }
    assert.match(src, /pending=\$\{pend\.buy\(i\)\}/, 'a card asks about its own slot');
    assert.match(src, /pending: pend\.reward\(i\)/, 'a reward card asks about its own pick');
    assert.match(src, /pending=\$\{lvPending\}/);
    const game = readFileSync(path.join(ROOT, 'public/js/screens/game.js'), 'utf8');
    assert.match(game, /onReward=\$\{\(i\) => actions\.reward\(i\)\}/, 'the reward pick really goes through act()');
    assert.match(game, /onLevel=\$\{\(\) => actions\.levelUp\(\)\}/);
    assert.match(game, /onRefresh=\$\{\(\) => actions\.refresh\(\)\}/);
    assert.match(game, /onFreeze=\$\{\(\) => actions\.freeze\(\)\}/);
  });

  test('the settings modal exposes the switch', () => {
    const src = readFileSync(path.join(ROOT, 'public/js/ui/settings.js'), 'utf8');
    assert.match(src, /data-testid="optimistic-feedback"/);
    assert.match(src, /updateSettings\(\{ optimisticFeedback: v \}\)/);
  });
});
