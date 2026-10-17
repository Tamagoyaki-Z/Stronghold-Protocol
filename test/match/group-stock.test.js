import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx } from '../../server/match/effectsMeta.js';
import { installDraftFacade } from '../../server/match/match/phases.js';
import { DATA, makeMatch, checkInvariants } from './harness.js';
import { PHASE } from '../../shared/constants.js';
import { scaleCopies, poolGroupScale } from '../../shared/playerCapacity.js';

const PACK = 'chess_item_5_07_e_a';
const SMALL = 'chess_item_1_01_e_a';

function stockData() {
  return { ...DATA, choices: { ...DATA.choices, pools: {
    ...DATA.choices.pools, test_group_item: { kind: 'equip', items: [PACK] },
  } } };
}

test('Mimic overdraw stays in the receiving fixed group, with public supply clamped until ownership leaves', () => {
  const h = makeMatch({ humans: 7, seed: 11, fake: true, data: stockData() }).start().toPrep(1);
  const m = h.m, a = h.ps('p_0'), b = h.ps('p_4');
  try {
    const id = [...a.pool.entries.keys()].find(id => m.gd.tierOf(id) === 6 && m.gd.mergeCount(id) === 3);
    const cap = a.pool.cap(id), other = b.pool.snapshot();
    for (let i = 0; i < 2; i++) assert.ok(a.acquireChess(id, { silent: true }));
    for (let i = 2; i < cap; i++) assert.ok(h.ps('p_1').acquireChess(id, { silent: true }));
    const target = a.allChess().find(p => p.id === id);
    assert.ok(target, 'two owned normal copies force Mimic to clone this target');
    const mimic = a.acquireItem('chess_item_5_05_e_a');
    assert.ok(mimic);
    assert.ok(a.equip(mimic.uid, target.uid).ok);
    assert.equal(a.pool.entries.get(id).left, -1);
    assert.equal(a.pool.left(id), 0);
    assert.equal(a.pool.snapshot()[id], 0);
    assert.deepEqual(b.pool.snapshot(), other);
    const ctx = makeCtx(m, a, { key: 'test' }, 'onTest');
    assert.equal(ctx.rollChess({ filter: x => x === id }), null);
    assert.equal(ctx.rollChess({ filter: x => x === id, ignoreCounts: true }), id);
    checkInvariants(m);
    const elite = a.allChess().find(p => m.gd.baseIdOf(p.id) === id && m.gd.isGolden(p.id));
    assert.ok(a.sell(elite.uid).ok);
    assert.equal(a.pool.left(id), 2, 'returning three copies pays the deficit before adding public supply');
    assert.deepEqual(b.pool.snapshot(), other);
    checkInvariants(m);
  } finally { m.dispose(); }
});

test('equipment stock scales with its group: full for three/four, x1.25 for five, x0.75 for a six-room group', () => {
  for (const humans of [3, 4, 5, 6, 9, 20]) {
    const h = makeMatch({ humans, seed: 11 });
    try {
      for (const g of h.m.poolGroups) {
        const stock = g.itemPool;
        assert.equal(stock.cap(PACK), Math.ceil(2 * g.scale));
        assert.equal(stock.cap(SMALL), Math.ceil(4 * g.scale));
        // the shared rule has no tier III floor for equipment: every tier is ceiled at the group's scale
        assert.equal(stock.cap(SMALL), scaleCopies(4, g.scale, 0));
        assert.equal(stock.cap('chess_item_2_03_e_a'), null, 'effect-only equipment remains uncapped');
        assert.ok(g.playerIds.every((id) => h.m.itemPoolFor(id) === stock));
      }
      assert.equal(h.m.itemPool, h.m.poolGroups[0].itemPool, 'legacy diagnostics use the first group');
    } finally { h.m.dispose(); }
  }
});

test('exhausting one equipment group gates its fresh rolls and grants; a displayed card or reward overdraws and records the debt', () => {
  const h = makeMatch({ humans: 7, seed: 11, fake: true, data: stockData() }).start().toPrep(1);
  const m = h.m, a = h.ps('p_0'), teammate = h.ps('p_1'), b = h.ps('p_4');
  try {
    m.gd.shopItemsByTier = { 5: [PACK] };
    a.funds = b.funds = 20;
    a.shop.level = b.shop.level = 5;
    a.shop.slots[0] = b.shop.slots[0] = { kind: 'item', id: PACK, basePrice: 1, sold: false, frozen: true };
    assert.ok(a.pushItemOffer([PACK]));
    assert.ok(b.pushItemOffer([PACK]));
    const x = a.acquireItem(PACK), y = teammate.acquireItem(PACK);
    assert.ok(x && y);
    assert.equal(m.itemPoolFor(a).left(PACK), 0);
    assert.equal(m.itemPoolFor(b).left(PACK), 2);
    // An already-displayed card, and an already-displayed item reward, are never stock-gated: they overdraw and the
    // group records the shortfall as debt (upstream #498/#624, inherited by the merge commit d80bb50c). The fork's
    // pre-merge expectation here was SOLD_OUT, which now means only "this slot is already sold".
    assert.deepEqual(a.buy(0), { ok: true });
    assert.equal(a.funds, 19, 'a displayed purchase is charged');
    assert.equal(m.itemPoolFor(a).debtOf(PACK), 1, 'the displayed purchase overdraws one copy of its group stock');
    assert.deepEqual(a.pickReward(0), { ok: true });
    assert.equal(a.offers.length, 0, 'the pick consumed the offer');
    assert.equal(m.itemPoolFor(a).debtOf(PACK), 2, 'the displayed reward overdraws too');
    assert.equal(a.upgradeItem(x), false);
    assert.equal(a._rollItemSlot(), null);
    assert.equal(b._rollItemSlot().id, PACK);
    const ca = makeCtx(m, a, { key: 'test' }, 'onTest'), cb = makeCtx(m, b, { key: 'test' }, 'onTest');
    assert.equal(ca.rollItem({ tier: 5 }), null);
    assert.equal(cb.rollItem({ tier: 5 }), PACK);
    assert.equal(ca.rollPool('test_group_item'), null);
    assert.deepEqual(cb.rollPool('test_group_item'), { kind: 'item', id: PACK });
    assert.ok(b.pickReward(0).ok);
    assert.equal(m.itemPoolFor(b).left(PACK), 1);
    // A fresh (not displayed) grant stays gated while the group is overdrawn, and the gate reopens as the overage
    // actually leaves the match: destroying the two overdrawn copies repays the debt and frees the teammate's copy.
    // (x itself is gone: buying the displayed card merged a's two normal copies into the golden item.)
    assert.equal(a.acquireItem(PACK), null, 'a fresh grant never overdraws');
    const overdrawn = [...a.hand, ...a.temp].filter((p) => p && p.kind === 'item' && m.gd.baseIdOf(p.id) === PACK);
    assert.equal(overdrawn.length, 2, 'the reward copy and the golden its two purchased normals merged into');
    assert.ok(a.destroy(overdrawn.find((p) => p.id === PACK).uid).ok);
    assert.equal(m.itemPoolFor(a).debtOf(PACK), 1, 'one copy left play: one debt repaid');
    assert.ok(a.destroy(overdrawn.find((p) => p.id !== PACK).uid).ok);
    assert.equal(m.itemPoolFor(a).debtOf(PACK), 0);
    assert.equal(m.itemPoolFor(a).left(PACK), 1, 'the teammate still holds the group\'s other copy');
    assert.equal(m.itemPoolFor(b).left(PACK), 1);
    assert.ok(a.acquireItem(PACK), 'the freed copy is available again');
    assert.equal(m.itemPoolFor(a).left(PACK), 0);
    checkInvariants(m);
  } finally { m.dispose(); }
});

function supplyData() {
  const id = 'mode_multi_normal', schedule = DATA.choices.schedule[id];
  return { ...DATA, choices: { ...DATA.choices, schedule: { ...DATA.choices.schedule,
    [id]: { ...schedule, rounds: { ...schedule.rounds,
      3: { ...schedule.rounds[3], families: [{ family: 'supply', weight: 1 }], supplyTiers: [5, 5] },
    } },
  } } };
}

test('an exhausted first equipment page finishes while another fixed group still receives its six cards', () => {
  const h = makeMatch({ humans: 7, data: supplyData(), seed: 11, fake: true });
  const m = h.m, a = h.ps('p_0');
  try {
    m.gd.shopItemsByTier = { 5: [PACK] };
    assert.ok(a.acquireItem(PACK)); assert.ok(a.acquireItem(PACK));
    m.round = 3;
    m.enterSpDraft();
    assert.equal(m.phase, PHASE.SP_DRAFT);
    const [empty, active] = m.sp.groups;
    assert.equal(empty.cards.length, 0); assert.equal(empty.done, true);
    assert.equal(active.cards.length, 6); assert.equal(active.done, false);
    assert.ok(active.cards.every((c) => c.id === PACK));
    const picker = m.players.get(active.order[0]);
    assert.ok(m.pickCard(picker, 0).ok);
    assert.equal(m.spCardAvailable(active.cards[1], active), true);
    assert.equal(m.publicView().sp.groups[1].cards[1].soldOut, false);
    checkInvariants(m);
  } finally { m.dispose(); }
});

function manualPages(m, cards) {
  const groups = m.makeDraftGroups({ shuffle: false });
  for (const [i, g] of groups.entries()) Object.assign(g, { cards: cards[i].map((c, idx) => ({ ...c, idx })), taken: {} });
  m.phase = PHASE.SP_DRAFT;
  m.sp = installDraftFacade({ id: m.nextDraftId('sp'), groups, picks: {}, untimed: m.soloUntimed },
    ['order', 'idx', 'cards', 'taken', 'turnDeadline', 'turnSeconds']);
  for (const g of groups) m.startSpTurn(g);
  return groups;
}

/**
 * 【本服主动放宽】 The official rule closed a 机变 page whose only equipment card had run out of shared stock
 * (docs/history/0.3.0.md §32.14.24). After 方案 A that page stays open and its card stays pickable: shared stock only
 * decides what may be DRAWN (spDraft.enterSpDraft itemAvailable), never whether a card already on screen may be taken.
 * The mechanism that still closes a page is every position being taken.
 */
test('stock exhaustion no longer closes a 机变 page, while a fully taken page still does, without resetting another (本服主动放宽)', () => {
  for (const untimed of [true, false]) {
    const h = makeMatch({ humans: untimed ? 1 : 10, bots: untimed ? 9 : 0, seed: 11, fake: true, data: stockData() });
    const m = h.m;
    try {
      const effectId = 'test_group_team_equipment';
      m.gd.effect = ((base) => (id) => id === effectId ? {
        buffs: [{ key: 'global_special_choice_gain_equip', bb: { count: 1 }, bbStr: { pool: 'test_group_item' } }],
      } : base(id))(m.gd.effect.bind(m.gd));
      // The second and third groups each hold one of their two copies before the all-room grant: each may accept one more.
      assert.ok(m.players.get(m.poolGroups[1].playerIds[0]).acquireItem(PACK));
      assert.ok(m.players.get(m.poolGroups[2].playerIds[0]).acquireItem(PACK));
      const groups = manualPages(m, [
        [{ kind: 'tactic', id: effectId, team: true }, { kind: 'item', id: SMALL }],
        [{ kind: 'item', id: PACK }, { kind: 'item', id: SMALL }],
        [{ kind: 'item', id: SMALL }],
      ]);
      const drained = groups[1], last = groups[2];
      const clock = { token: drained.token, timer: drained.timer, deadline: drained.turnDeadline };
      const lastClock = { token: last.token, timer: last.timer, deadline: last.turnDeadline };
      assert.ok(groups.every((g) => g.untimed === untimed));
      assert.ok(m.pickCard(h.ps('p_0'), 0).ok);
      // The team grant drained the second group's shared stock for PACK …
      assert.equal(m.itemPoolFor(drained.playerIds[0]).left(PACK), 0);
      // … but a card already on screen is still takeable: no 库存不足, no early close, and no clock reset.
      assert.equal(m.publicView().sp.groups[1].cards[0].soldOut, false, 'stock exhaustion never marks a displayed card sold out');
      assert.equal(drained.done, false, 'stock exhaustion no longer closes the page');
      assert.notEqual(m.spTurn(drained.playerIds[0]), null, 'the second group still has a turn');
      assert.deepEqual({ token: drained.token, timer: drained.timer, deadline: drained.turnDeadline }, clock,
        'a page that can still choose keeps its clock');
      assert.deepEqual({ token: last.token, timer: last.timer, deadline: last.turnDeadline }, lastClock,
        'an unrelated page is not reset');
      // The still-working close: every position taken.
      const lastTurn = m.spTurn(last.playerIds[0]);
      assert.ok(lastTurn);
      assert.ok(m.pickCard(m.players.get(lastTurn), 0).ok);
      assert.equal(last.done, true, 'a page whose every position is taken still closes');
      assert.equal(m.spTurn(last.playerIds[0]), null);
      // Nobody overdrew: the second group's only stock change is PACK leaving play, not a granted overrun.
      assert.ok(m.order.every((ps) => m.itemPoolFor(ps).held(PACK) <= m.itemPoolFor(ps).cap(PACK)));
      checkInvariants(m);
    } finally { m.dispose(); }
  }
});

test('an opening setup reroll recreates all fixed equipment pools, including the five-person scale', () => {
  const h = makeMatch({ humans: 9, seed: 11, fake: true }).start();
  const m = h.m;
  try {
    const previous = m.poolGroups.map((g) => g.itemPool);
    assert.ok(m.requestSetupReroll('p_0', 0).ok);
    const voteId = m.setupVote.id;
    for (const ps of m.order.slice(1)) assert.ok(m.voteSetupReroll(ps, voteId, true).ok);
    assert.equal(m.setupRevision, 1);
    assert.deepEqual(m.poolGroups.map((g) => g.playerIds.length), [4, 5]);
    for (const [i, g] of m.poolGroups.entries()) {
      assert.notEqual(g.itemPool, previous[i]);
      assert.equal(g.itemPool.cap(PACK), i === 0 ? 2 : 3, 'four-person group x1, five-person group x1.25');
      assert.ok(g.playerIds.every((id) => m.itemPoolFor(id) === g.itemPool));
    }
    assert.equal(m.itemPool, m.poolGroups[0].itemPool);
    checkInvariants(m);
  } finally { m.dispose(); }
});

test('overdrawn private DIY stock remains personal even in a five-player group', () => {
  const slot = 'chess_char_5_diy1_a';
  const seats = Array.from({ length: 9 }, (_, seat) => ({
    seat, playerId: `p_${seat}`, name: `P${seat}`, connected: true, isBot: false,
    diy: seat >= 7 ? { [slot]: { charId: 'char_609_acguad' } } : null,
  }));
  const h = makeMatch({ seats, seed: 11, fake: true });
  const m = h.m, a = h.ps('p_7'), b = h.ps('p_8');
  try {
    const before = m.poolGroups.map(g => g.pool.snapshot());
    const cap = a.diyStock.cap(slot);
    for (let i = 0; i <= cap; i++) assert.ok(a.acquireChess(slot, { silent: true }));
    assert.equal(a.diyStock.entries.get(slot).left, -1);
    assert.equal(a.diyStock.left(slot), 0);
    assert.equal(b.diyStock.left(slot), cap);
    assert.deepEqual(m.poolGroups.map(g => g.pool.snapshot()), before);
    checkInvariants(m);
    a.eliminate(1);
    assert.equal(a.diyStock.left(slot), cap);
    assert.equal(b.diyStock.left(slot), cap);
    checkInvariants(m);
  } finally { m.dispose(); }
});
