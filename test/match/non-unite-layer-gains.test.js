// 盟约层数增长的两条规则（用户报告：6 人房分 2 组的普通战场里层数不涨）：
//   * 联防（kind 'unite'）按官方设计不叠层 —— 回归保护，绝不能改；
//   * 其它一切战场（含 6 人房 3+3 固定组里的普通场）必须叠层（Battle.flags.layerGainsEnabled）。
// 用真 Battle（不是 FakeBattle）跑阿戈尔开场吞噬：bonds/core.js devour → support.gainLayers，t=0 就给标记者叠层。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { makeMatch, give } from './harness.js';
import { makeBattle } from '../helpers/battleHarness.js';

const EGIR = ['chess_char_5_05_a', 'chess_char_3_05_a', 'chess_char_1_04_a'];
const START = 14;
const egirChain = (kind, flags) => makeBattle({
  seed: 4, timeLimit: 30, autoFinish: false, kind,
  units: EGIR.map((chessId, i) => ({ chessId, row: 10, col: 3 + i })),
  bonds: { egirShip: { count: EGIR.length, active: true, tier: 3, layers: START } },
  ...(flags ? { flags } : null),
});

test('层数开关：非联防默认开启，联防默认关闭，显式 flags 仍然优先', () => {
  assert.equal(egirChain('normal').b.flags.layerGainsEnabled, true, '普通场必须允许叠层');
  assert.equal(egirChain('unite').b.flags.layerGainsEnabled, false, '联防按官方不叠层');
  assert.equal(egirChain('unite', { layerGainsEnabled: true }).b.flags.layerGainsEnabled, true, '显式 flags 覆盖默认');
});

test('同一套阿戈尔阵容：普通场 14 → 18 层，联防场 14 → 14 层', () => {
  const n = egirChain('normal').step();
  const liveN = n.b.getPlayer('p1').bonds.egirShip.layers;
  assert.ok(liveN > START, `普通场应叠层，实际 ${START} → ${liveN}`);

  const u = egirChain('unite').step();
  const liveU = u.b.getPlayer('p1').bonds.egirShip.layers;
  assert.equal(liveU, START, `联防场不得叠层，实际 ${START} → ${liveU}`);
});

test('6 人房 2 组的普通场（真 Battle）：层数增长并在结算保留', () => {
  const h = makeMatch({ humans: 6, seed: 4242 }).start();
  const m = h.m;
  h.toPrep(1);
  assert.deepEqual(m.poolGroups.map((g) => g.playerIds.length), [3, 3], '6 人房分 3+3 两组');
  const kinds = [];
  const newBattle = m.newBattle.bind(m);
  m.newBattle = (opts, o) => { kinds.push(opts.kind); return newBattle(opts, o); };
  const p0 = h.ps('p_0');
  EGIR.forEach((id, i) => give(m, p0, id, 'board', [10, 3 + i]));
  p0.recompute();
  assert.ok(p0.bonds.egirShip && p0.bonds.egirShip.active, '阿戈尔已激活');
  h.drive(() => m.phase === PHASE.SETTLE);
  assert.equal(kinds.filter((k) => k === 'normal').length, 6, `6 名存活玩家各有 1 个普通场: ${kinds.join(',')}`);
  const r = m.lastResults.get('p_0');
  assert.ok(r && r.layerGains && r.layerGains.egirShip > 0, `普通场结果应带动层数: ${JSON.stringify(r && r.layerGains)}`);
  assert.ok(p0.layers.egirShip > 0, `结算后层数保留: ${JSON.stringify(p0.layers)}`);
  assert.deepEqual(h.logs.error, [], '无引擎错误');
  m.dispose();
});
