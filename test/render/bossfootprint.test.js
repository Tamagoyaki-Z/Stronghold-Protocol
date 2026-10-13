// BOSS 格子锚点 / 生效范围 一致性回归（r024k）
//
// 用户报告：「BOSS 的贴图和生效范围都往左偏了一格」——立绘在一个格子，而它的格子位置 / 技能生效范围
// 指示相对左偏 1 格。这份测试把「贴图锚点（渲染）」「格子占位（逻辑）」「生效范围方块（逻辑）」
// 三者之间的口径钉死，并说明哪一格差异是**官方数据**、哪一格才是缺陷。
//
// 结论（本文件的断言即证据）：
//   * 渲染侧（public/js/render/units.js:884 setWorld / 运行帧 units.js:1132-1133 `this.x = d[5]; this.y = d[4]`）
//     把立绘放在 **单位位置 (x, y) = 判定中心** 上，不叠加 hitArea.dx / dy —— 迁移前（migrate，0.2.3）
//     与当前 HEAD 逐字节相同（public/js/render/units.js 的这段逻辑不在 migrate..HEAD 的 diff 里），
//     所以「贴图锚点算法被换掉」这一假设不成立。
//   * 逻辑侧方块（server/sim/body.js:54 hitRect）= 以 (x + dx, y + dy) 为中心、w × h 的矩形。
//     7 只巨型 BOSS 里 **6 只 dx = 0**（立绘与方块同心），只有
//     **enemy_9021_acduml_2（假想敌：管，隐秘核心）dx = 1**：它的方块中心比立绘位置**右**偏 1 格，
//     于是画面读起来就是「立绘比生效范围左偏一格」。这不是我们引入的：该值来自 PRTS 原文
//     （tools/build-data.mjs HIT_AREAS 注释 "…向右偏移1.0"），且 data/enemies.json 与 migrate
//     逐字节相同（本文件第一个用例断言这条口径）。
//   * 棋盘 / 关卡原点、多格单位锚点换算（render/prepfield.js BOSS_ROW_SHIFT = −7、右半区列镜像
//     20 − c）在 migrate 与 HEAD 之间也没有变化，见下方用例。
//
// 本文件用固定数值（不依赖 data/ 生成物，除第一组读真实数据）把上面三条钉住。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { hitRect, normHitArea } from '../../server/sim/body.js';
import { bossPrepField, IDENTITY, MAX_COL, BOSS_ROW_SHIFT, BOSS_DISP_MAX_ROW, tilesToDisp } from '../../public/js/render/prepfield.js';

const E = JSON.parse(fs.readFileSync(new URL('../../data/enemies.json', import.meta.url), 'utf8'));

/** 巨型 BOSS（data `hitArea`）的完整名单：假想敌：胄 ×2、假想敌：管 ×2、盐风主教昆图斯、阿利斯泰尔、萨米的意志。 */
const HUGE = [
  'enemy_9013_acstmk', 'enemy_9013_acstmk_2',
  'enemy_9021_acduml', 'enemy_9021_acduml_2',
  'enemy_1521_dslily', 'enemy_9032_aclionk', 'enemy_9033_acdeer',
];

test('巨型 BOSS：贴图锚点（判定中心）必须与生效方块同心 —— 只有官方写明「向右偏移1.0」的假想敌：管（隐秘核心）为例外', () => {
  const withXOffset = [];
  for (const key of HUGE) {
    const rec = E[key];
    assert.ok(rec, `${key} 必须在 data/enemies.json 里`);
    const a = normHitArea(rec.hitArea);
    assert.ok(a, `${key} 必须带 hitArea（巨型单位）`);
    // 官方口径：长 4.95 × 宽 2.95，向上偏移 1.0（PRTS 巨型单位天赋）
    assert.equal(a.w, 4.95, `${key} w`);
    assert.equal(a.h, 2.95, `${key} h`);
    assert.equal(a.dy, 1, `${key} 向上偏移必须是 1.0`);
    // 立绘画在 (x, y)：方块中心相对立绘的横向偏移就是 dx，d 格 = 画面上「立绘相对生效范围」的横向偏移
    if (a.dx !== 0) withXOffset.push(key);
  }
  assert.deepEqual(withXOffset, ['enemy_9021_acduml_2'],
    '唯一带「向右偏移 1.0」的巨型 BOSS：假想敌：管（隐秘核心）。它的立绘与生效方块横向差 1 格是官方数据，'
    + '不是渲染回归；其余 6 只必须 dx = 0（立绘与生效范围同心）');
  const a = normHitArea(E.enemy_9021_acduml_2.hitArea);
  assert.equal(a.dx, 1, 'PRTS 原文：假想敌：管 隐秘核心「…向上偏移1.0，向右偏移1.0」');
  // 同一个 BOSS 的普通形态没有这一条
  assert.equal(normHitArea(E.enemy_9021_acduml.hitArea).dx, 0, '假想敌：管（普通）只有向上偏移');
});

test('生效方块 → 占据格子：dx = 0 的 BOSS 落在以自身格为中心的 5 × 3；dx = 1 的向右多占一格', () => {
  /** 与 server/sim/body.js bodyKeys 同一条开区间规则：只有被真正重叠的格子算占据。 */
  const tiles = (x, y, a) => {
    const R = hitRect({ x, y, hitArea: a });
    const out = [];
    for (let r = 0; r < 19; r++) {
      for (let c = 0; c < 21; c++) {
        if (c + 0.5 > R.x0 + 1e-9 && c - 0.5 < R.x1 - 1e-9 && r + 0.5 > R.y0 + 1e-9 && r - 0.5 < R.y1 - 1e-9) out.push([r, c]);
      }
    }
    return out;
  };
  const cols = (list) => [...new Set(list.map(([, c]) => c))].sort((p, q) => p - q);
  const rows = (list) => [...new Set(list.map(([r]) => r))].sort((p, q) => p - q);

  // 假想敌：管（普通）站在 (x 9, y 3)：方块中心仍是 (9, 4) → 列 7..11、行 3..5
  const plain = tiles(9, 3, normHitArea(E.enemy_9021_acduml.hitArea));
  assert.deepEqual(cols(plain), [7, 8, 9, 10, 11], 'dx = 0：以立绘所在列 9 为中心');
  assert.deepEqual(rows(plain), [3, 4, 5], 'dy = 1：向上偏移 1 格');

  // 隐秘核心形态站在同一格 (x 9, y 3)：方块中心变成 (10, 4) → 列 8..12（整体右移 1 格）
  const hidden = tiles(9, 3, normHitArea(E.enemy_9021_acduml_2.hitArea));
  assert.deepEqual(cols(hidden), [8, 9, 10, 11, 12], 'dx = 1：占据格子整体右偏 1 格 —— 画面上读作「立绘左偏一格」');
  assert.deepEqual(rows(hidden), [3, 4, 5]);
  // 两个形态的占格差正好 1 列
  assert.equal(cols(hidden)[0] - cols(plain)[0], 1, '差异恰为 1 格（这正是用户看到的那一格）');
});

test('棋盘 / 关卡原点：BOSS 半场的显示格就是关卡格本身（只换行，不额外挪列）', () => {
  // server/match/board.js BOARD_ROWS_ABOVE_BOSS = 7 = −render/prepfield.js BOSS_ROW_SHIFT
  assert.equal(BOSS_ROW_SHIFT, -7, '显示行 = 棋盘行 − 7');
  assert.equal(MAX_COL, 20, '右半区镜像列 = 20 − c');
  assert.equal(BOSS_DISP_MAX_ROW, 6, 'BOSS 半场显示行 0–6（含墙行）');
  // 左半区：只动行
  assert.deepEqual(bossPrepField('L').toDisp(10, 2), { row: 3, col: 2 }, '左半区列不变（BOSS 预备位 10,2 → 显示 3,2）');
  assert.deepEqual(bossPrepField('L').toDisp(12, 8), { row: 5, col: 8 });
  // 右半区：行相同，列镜像
  assert.deepEqual(bossPrepField('R').toDisp(10, 2), { row: 3, col: 18 });
  assert.deepEqual(bossPrepField('R').toDisp(12, 8), { row: 5, col: 12 });
  // 每一侧的换算都是双射，且坏格子被丢掉（不落到 BOSS 行上）
  for (const side of ['L', 'R']) {
    const xf = bossPrepField(side);
    for (let r = 7; r <= 12; r++) {
      for (let c = 0; c <= 10; c++) {
        const d = xf.toDisp(r, c);
        assert.deepEqual(xf.toBoard(d.row, d.col), { row: r, col: c }, `${side} ${r},${c} 往返`);
      }
    }
  }
  assert.deepEqual(tilesToDisp(bossPrepField('L'), [[6, 4], [9, 4]]), [[2, 4]], '落不到 BOSS 半场的格子被丢掉');
  assert.deepEqual(IDENTITY.toDisp(9, 2), { row: 9, col: 2 }, '普通预备场是恒等变换');
});
