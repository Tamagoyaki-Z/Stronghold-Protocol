import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DATA, makeMatch, give } from './harness.js';
import { poolGroupSizes, poolCopyScale, poolGroupScale, scaleCopies } from '../../shared/playerCapacity.js';
import { makeCtx } from '../../server/match/effectsMeta.js';

const GROUP_CASES = [[1, [1]], [2, [2]], [3, [3]], [4, [4]], [5, [5]], [6, [3, 3]], [7, [4, 3]],
  [8, [4, 4]], [9, [4, 5]], [10, [4, 3, 3]], [11, [4, 4, 3]], [12, [4, 4, 4]], [13, [5, 4, 4]],
  [14, [4, 4, 3, 3]], [15, [4, 4, 4, 3]], [16, [4, 4, 4, 4]], [17, [5, 4, 4, 4]],
  [18, [4, 4, 4, 3, 3]], [19, [4, 4, 4, 4, 3]], [20, [4, 4, 4, 4, 4]]];
const COOP_CAPS = { 1: 24, 2: 28, 3: 36, 4: 32, 5: 16, 6: 10 };
const FIVE_PLAYER_CAPS = { 1: 30, 2: 35, 3: 45, 4: 40, 5: 20, 6: 13 };
// 0.75 x the four-person baseline (user decision 2026-10-13): a three-person group fields that share of the pool.
// III is floored (36 * .75 = 27), the rest ceiled (24 * .75 = 18, 28 * .75 = 21, 32 * .75 = 24, 16 * .75 = 12,
// 10 * .75 = 7.5 -> 8), so the chess with the measured 4x identity still costs 27.
const THREE_PLAYER_CAPS = { 1: 18, 2: 21, 3: 27, 4: 24, 5: 12, 6: 8 };

for (const [count, sizes] of GROUP_CASES) {
  test(`${count} players: fixed pool groups ${sizes.join('+')}, each scaled to its share of the four-person baseline`, () => {
    const h = makeMatch({ humans: count, fake: true });
    const m = h.m;
    assert.deepEqual(poolGroupSizes(count), sizes);
    assert.deepEqual(m.poolGroups.map((g) => g.playerIds.length), sizes);
    assert.equal(new Set(m.poolGroups.flatMap((g) => g.playerIds)).size, count);
    for (const group of m.poolGroups) {
      assert.equal(group.scale, poolGroupScale(group.playerIds.length));
      for (const [id, entry] of group.pool.entries) {
        const size = group.playerIds.length;
        const expected = scaleCopies(m.gd.poolCopies(id), group.scale, entry.tier);
        assert.equal(entry.cap, expected, id);
        if (!Object.hasOwn(m.gd.economy.poolCopiesOverrides || {}, id)) {
          const table = size === 5 ? FIVE_PLAYER_CAPS : size === 3 ? THREE_PLAYER_CAPS : COOP_CAPS;
          assert.equal(entry.cap, table[entry.tier], `${id} tier baseline`);
        }
      }
      for (const id of group.playerIds) assert.equal(m.poolFor(id), group.pool);
    }
    h.invariants();
    m.dispose();
  });
}

test('pool group sizes reject invalid counts and cannot be changed by a previous caller', () => {
  for (const count of [0, -1, 21, 1.5, NaN, Infinity]) assert.throws(() => poolGroupSizes(count), RangeError);
  const first = poolGroupSizes(9);
  first[0] = 9;
  first.pop();
  assert.deepEqual(poolGroupSizes(9), [4, 5]);
});

test('nine occupied seats are assigned in seat order, including empty seat gaps and reversed input', () => {
  const seats = [0, 2, 4, 6, 8, 10, 12, 14, 19].map((seat) => ({
    seat, playerId: `seat_${seat}`, name: `P${seat}`, isBot: false, connected: true,
  })).reverse();
  const h = makeMatch({ seats, fake: true });
  assert.deepEqual(h.m.poolGroups.map((g) => g.playerIds), [
    ['seat_0', 'seat_2', 'seat_4', 'seat_6'], ['seat_8', 'seat_10', 'seat_12', 'seat_14', 'seat_19'],
  ]);
  h.invariants();
  h.m.dispose();
});

for (const [count, firstSize] of [[6, 3], [8, 4], [9, 4], [13, 5]]) {
  test(`${count} players: buying, merging, selling and elimination preserve every other group's copies`, () => {
    const h = makeMatch({ humans: count, fake: true });
    const m = h.m, p0 = h.ps('p_0'), matePs = h.ps(`p_${firstSize}`);
    const id = [...p0.pool.entries.keys()].find((id) => m.gd.tierOf(id) === 3 && m.gd.goldenIdOf(id) && m.gd.mergeCount(id) === 3);
    const caps = m.poolGroups.map((g) => g.pool.cap(id));
    const left = () => m.poolGroups.map((g) => g.pool.left(id));
    for (let i = 0; i < 3; i++) p0.acquireChess(id, { source: 'test' });
    assert.deepEqual(left(), caps.map((n, i) => n - (i === 0 ? 3 : 0)));
    assert.ok(p0.hand.some((p) => p && p.id === m.gd.goldenIdOf(id)));
    const mate = give(m, matePs, id);
    assert.deepEqual(left(), caps.map((n, i) => n - (i === 0 ? 3 : i === 1 ? 1 : 0)));
    p0.eliminate(1);
    assert.deepEqual(left(), caps.map((n, i) => n - (i === 1 ? 1 : 0)));
    assert.equal(m.poolGroups[0].playerIds.length, firstSize, 'elimination never reshuffles the groups');
    matePs.returnCopies(mate);
    matePs.hand.fill(null);
    matePs.recompute();
    assert.deepEqual(left(), caps);
    h.invariants();
    m.dispose();
  });
}

test('depleting one group leaves shop rolls and effect grants of the other group available', () => {
  const h = makeMatch({ humans: 7, fake: true });
  const p0 = h.ps('p_0'), p4 = h.ps('p_4');
  const id = [...p0.pool.entries.keys()][0];
  const held = p0.pool.take(id, 1000);
  assert.equal(p0.pool.roll(h.m.rngMeta, { filter: (x) => x === id }), null);
  assert.equal(p4.pool.roll(h.m.rngMeta, { filter: (x) => x === id }), id);
  assert.equal(p4.pool.cap(id), scaleCopies(h.m.gd.poolCopies(id), 0.75, p4.pool.entries.get(id).tier),
    'a three-player group fields three quarters of the four-person amount');
  p0.pool.give(id, held);
  h.invariants();
  h.m.dispose();
});

// 0.75 x the four-person baseline (user decision 2026-10-13: 「按比例缩放」), as a printed对照表 so a reader can
// check the numbers without running the match. identity overrides are scaled the same way (mlyss 4 -> 3).
for (const [count, sizes, scales] of [[6, [3, 3], [0.75, 0.75]], [10, [4, 3, 3], [1, 0.75, 0.75]]]) {
  test(`${count} players: every group's copies are its share of the four-person baseline (${sizes.join('+')})`, () => {
    const h = makeMatch({ humans: count, fake: true });
    const m = h.m;
    try {
      assert.deepEqual(m.poolGroups.map((g) => g.playerIds.length), sizes);
      assert.deepEqual(m.poolGroups.map((g) => g.scale), scales);
      const table = (size, tier) => {
        const fixed = size === 5 ? FIVE_PLAYER_CAPS : size === 3 ? THREE_PLAYER_CAPS : COOP_CAPS;
        return size >= 3 ? fixed[tier] : COOP_CAPS[tier];
      };
      for (const g of m.poolGroups) {
        const size = g.playerIds.length;
        for (const [id, entry] of g.pool.entries) {
          const want = scaleCopies(m.gd.poolCopies(id), g.scale, entry.tier);
          if (entry.cap !== want) {
            console.log('DIAG', JSON.stringify({ size, scale: g.scale, id, tier: entry.tier, override: (m.gd.economy.poolCopiesOverrides || {})[id] ?? null, gdCopies: m.gd.poolCopies(id), want, cap: entry.cap }));
          }
          assert.equal(entry.cap, want, `${id} in the ${size}-person group`);
          if (!Object.hasOwn(m.gd.economy.poolCopiesOverrides || {}, id)) {
            assert.equal(entry.cap, table(size, entry.tier), `${id} tier ${entry.tier} at scale ${g.scale}`);
          }
        }
        // equipment follows the same scale (SharedItemPool)
        for (const id of ['chess_item_1_01_e_a', 'chess_item_5_07_e_a']) {
          const cap = g.itemPool.cap(id);
          if (cap == null) continue;
          assert.equal(cap, Math.ceil(m.gd.itemPoolCopies(id) * g.scale), `${id} equipment at scale ${g.scale}`);
        }
      }
      // the measured identity override scales too (4 * .75 = 3 for a three-person group, never the full four)
      assert.equal(m.poolGroups[0].pool.cap('chess_char_6_11_a'),
        Math.ceil(m.gd.poolCopies('chess_char_6_11_a') * m.poolGroups[0].scale), 'identity override scales');
      h.invariants();
    } finally { m.dispose(); }
  });
}

test('nine players: a five-player group does not expand private DIY stock', () => {
  const slotId = 'chess_char_5_diy1_a';
  const seats = Array.from({ length: 9 }, (_, seat) => ({
    seat, playerId: `p_${seat}`, name: `P${seat}`, connected: true, isBot: false,
    diy: seat === 8 ? { [slotId]: { charId: 'char_609_acguad' } } : null,
  }));
  const h = makeMatch({ seats, fake: true });
  const ps = h.ps('p_8');
  assert.equal(h.m.poolGroups[1].playerIds.length, 5);
  assert.equal(ps.diyStock.cap(slotId), 8, 'private tier V remains the original eight copies');
  for (const group of h.m.poolGroups) assert.equal(group.pool.has(slotId), false);
  const piece = ps.acquireChess(slotId, { source: 'test' });
  assert.ok(piece);
  assert.equal(ps.diyStock.left(slotId), 7);
  ps.eliminate(1);
  assert.equal(ps.diyStock.left(slotId), 8);
  h.invariants();
  h.m.dispose();
});

test('twenty client-combat participants finish a complete match with grouped pools and no engine errors', () => {
  const h = makeMatch({ humans: 20, fake: true, clientCombat: true, seed: 2050,
    script: (battle) => battle.kind === 'boss' || battle.kind === 'hidden' ? { bossDps: 1e9 } : {},
  }).start().autoHumans();
  const result = h.runToEnd();
  assert.equal(result.players.length, 20);
  assert.equal(result.reason, 'victory');
  assert.equal(h.m.errorCount, 0);
  assert.deepEqual(h.m.poolGroups.map((g) => g.playerIds.length), [4, 4, 4, 4, 4]);
  h.invariants();
  h.m.dispose();
});

test('twenty players: buying, merging, selling and eliminating DIY / stand-in pieces preserves the last group and each personal stock', () => {
  const slotId = 'chess_char_5_diy1_a';
  const notOwned = Object.values(DATA.chess)
    .filter((c) => c.visible && !c.isGolden && c.chessType === 'NORMAL' && c.backup)
    .map((c) => c.chessId);
  const seats = Array.from({ length: 20 }, (_, seat) => ({
    seat, playerId: `p_${seat}`, name: `P${seat}`, connected: true, isBot: false,
    diy: [0, 8, 19].includes(seat) ? { [slotId]: { charId: 'char_609_acguad' } } : null,
    notOwned: seat === 19 ? notOwned : null,
  }));
  const h = makeMatch({ seats, seed: 11, fake: true }).start();
  h.toPrep(1);
  const m = h.m;
  const ps = h.ps('p_19');
  ps.shop.level = 6;
  ps.funds = 100;
  const buy = (id) => {
    ps.shop.slots[0] = { kind: 'chess', id, basePrice: ps.gd.chessPrice(id), frozen: false, sold: false };
    assert.deepEqual(m.handle(ps.playerId, { t: 'g.buy', slot: 0 }), { ok: true });
  };
  assert.equal(ps.pool, m.poolGroups[4].pool, 'the last seat belongs to the fifth shared pool');
  for (const group of m.poolGroups) assert.equal(group.pool.has(slotId), false, 'DIY stock never joins a group pool');
  for (let i = 0; i < 3; i++) buy(slotId);
  const diyElite = ps.allChess().find((p) => p.id === ps.gd.goldenIdOf(slotId));
  assert.ok(diyElite);
  assert.equal(ps.diyStock.left(slotId), 5);
  assert.equal(h.ps('p_0').diyStock.left(slotId), 8);
  assert.equal(h.ps('p_8').diyStock.left(slotId), 8);
  assert.deepEqual(m.handle(ps.playerId, { t: 'g.sell', uid: diyElite.uid }), { ok: true });
  assert.equal(ps.diyStock.left(slotId), 8);

  const id = [...ps.pool.entries.keys()].find((id) => ps.fieldsStandIn(id)
    && ps.pool.left(id) >= 3 && !ps.allChess().some((p) => ps.gd.baseIdOf(p.id) === id));
  assert.ok(id, 'an unowned operator with three free copies in the fifth group');
  const before = m.poolGroups.map((g) => g.pool.left(id));
  for (let i = 0; i < 3; i++) buy(id);
  const standInElite = ps.allChess().find((p) => p.id === ps.gd.goldenIdOf(id));
  assert.ok(standInElite && ps.fieldsStandIn(standInElite.id));
  assert.deepEqual(m.poolGroups.map((g) => g.pool.left(id)), before.map((n, i) => n - (i === 4 ? 3 : 0)));
  assert.deepEqual(m.handle(ps.playerId, { t: 'g.sell', uid: standInElite.uid }), { ok: true });
  assert.deepEqual(m.poolGroups.map((g) => g.pool.left(id)), before);

  const ctx = makeCtx(m, ps, { key: 'test' }, 'onTest');
  assert.ok(ctx.grantChess(slotId));
  assert.equal(ps.diyStock.left(slotId), 7, 'effect grants take the receiver\'s private stock');
  assert.ok(ctx.grantChess(id));
  assert.equal(ps.pool.left(id), before[4] - 1, 'stand-in still spends the original operator\'s group copy');
  h.invariants();
  ps.eliminate(1);
  assert.equal(ps.diyStock.left(slotId), 8);
  assert.deepEqual(m.poolGroups.map((g) => g.pool.left(id)), before);
  h.invariants();
  assert.equal(m.errorCount, 0);
  m.dispose();
});
