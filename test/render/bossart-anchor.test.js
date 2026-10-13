// test/render/bossart-anchor.test.js — 「巨型 BOSS 的立绘锚点 = 判定框中心」（r024k；用户已拍板：**只改显示**）
//
// 现象：假想敌：管（隐秘核心）`enemy_9021_acduml_2` 的立绘看起来比红色 / 橙色生效范围格**左偏一格**。
// 事实（上一轮已查明，本文件不复查）：立绘原先画在单位 (x, y)，而生效方块中心 = (x + dx, y + dy)
// （server/sim/body.js hitRect）。7 只巨型 BOSS 里 6 只 dx = 0、7 只全部 dy = 1，只有
// `enemy_9021_acduml_2` 的 dx = 1（官方 PRTS「…向上偏移1.0，向右偏移1.0」，tools/build-data.mjs HIT_AREAS）
// —— 那一格就是它。**判定 / 范围 / 官方数据一律不动**，只把立绘（含脚下的影子）画到 (x + dx, y)。
//
// 本文件钉住五条口径（红/绿口径见每条的标注）：
//   ① dx = 1 的 BOSS：立绘世界 x = 单位 x + 1（单位位置本身不动）。改动前**红**。
//   ② dx = 0 的单位（含 dy = 1 的 6 只巨型 BOSS、普通敌人、干员）：立绘世界坐标与改动前**逐位相同**。
//      改动前**绿**、改动后**绿** —— 这条只断言画出来的世界点，不引用任何新 API，所以它证明的是
//      「没被顺手改动」，而不是「新代码存在」。
//   ③ 同上，但换成直接对照：带着 dx = 0 的 hitArea 的视图 vs 完全没有 hitArea 的视图，
//      root / 影子屏幕坐标与整帧交给相机的世界点完全一致。改动前**绿**、改动后**绿**。
//   ④ 立绘世界 **y** 仍然是单位 y：绝不叠 `dy`（否则 7 只巨型 BOSS 会整体上移一格）。改动前**绿**、改动后**绿**。
//   ⑤ 半场换算（render/prepfield.js）：左右半区（右半区列镜像 20 − c）立绘锚点都落在生效范围格的**中心列**上。
//      改动前**红**。另有本条新口径本身的用例（artDx / artX），改动前**红**（方法还不存在）。
//
// 「立绘世界坐标」的取证方式：用记录型相机（真 presetCamera + 抄一份入参）抓下渲染真正交给相机的世界点 ——
// 渲染层每帧就是在 render/units.js `update()` 的 `cam.project(...)` 里把立绘的位置交给相机的，抓到的即画出来的。

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installFakePixi, fakeViewCtx } from './fakepixi.js';
import { presetCamera } from '../../public/js/render/projection.js';
import { bossPrepField, leaderStand } from '../../public/js/render/prepfield.js';
import { hitTiles } from '../../public/js/render/pick.js';

const DATA = JSON.parse(readFileSync(new URL('../../data/enemies.json', import.meta.url), 'utf8'));
/** 巨型 BOSS = data/enemies.json 里带 `hitArea` 的 7 只（server/sim/body.js 的巨型单位）。 */
const HUGE = [
  'enemy_9013_acstmk', 'enemy_9013_acstmk_2',
  'enemy_9021_acduml', 'enemy_9021_acduml_2',
  'enemy_1521_dslily', 'enemy_9032_aclionk', 'enemy_9033_acdeer',
];
const HIDDEN = 'enemy_9021_acduml_2';                       // 假想敌：管（隐秘核心），唯一 dx = 1
const hitAreaOf = (k) => DATA[k]?.hitArea ?? null;
/** render/app.js 的 `ctx.lookupDef`（app.js:334）：敌人 → data/enemies.json 的整条记录（modelScale / hitArea 同源）。 */
const lookupDef = (info) => (info?.side === 'enemy' ? DATA[info.defId] ?? null : null);

let fake, UnitView;
before(async () => {
  fake = installFakePixi();
  ({ UnitView } = await import('../../public/js/render/units.js'));
});
after(() => fake.restore());

/** 记录型相机：真的 presetCamera 之上，把每个世界点抄一份下来。 */
function recorder() {
  const base = presetCamera('prep', { width: 1280, height: 720 });
  const seen = [];
  const cam = new Proxy(base, {
    get(t, k) {
      if (k === 'project') return (x, y, z, out) => { seen.push([x, y, z]); return t.project(x, y, z, out); };
      return Reflect.get(t, k);
    },
  });
  return { cam, seen };
}

/** 资产桩（test/render/unitview.test.js 同款，去掉了 Spine）：只要视图能建起来并走完一帧。 */
const store = () => ({
  picture: (id) => (id ? `/pic/${id}.png` : null),
  image: async () => ({ width: 180, height: 180 }),
  spineEntry: () => null,
  spine: { acquire: async () => null, release() {} },
});

/** 与 render/app.js 一样构造视图：敌人的记录经 ctx.lookupDef 进来。 */
function makeView(info, opts = {}) {
  const ctx = fakeViewCtx(fake.P, { assets: store(), lookupDef, cam: () => presetCamera('prep', { width: 1280, height: 720 }) });
  return new UnitView(ctx, { id: 1, side: 'enemy', kind: 'enemy', boss: true, maxHp: 1, ...info }, opts);
}

/** 第一帧交给相机的世界点 = 立绘（root）画在哪。 */
function drawPoint(info, opts = {}) {
  const v = makeView(info, opts);
  const { cam, seen } = recorder();
  v.update(1 / 60, cam, 0);
  assert.ok(seen.length >= 1, '一帧里立绘的位置必须交给相机');
  return { v, at: seen[0], seen };
}

describe('巨型 BOSS 立绘锚点（r024k，只改显示）', () => {
  test('①【改动前红】dx = 1 的 BOSS：立绘世界 x = 单位 x + 1，单位（判定中心）不动', () => {
    assert.equal(hitAreaOf(HIDDEN).dx, 1, '官方数据：唯一「向右偏移 1.0」的巨型 BOSS');
    const { v, at } = drawPoint({ defId: HIDDEN, x: 9, y: 3 });
    assert.equal(v.x, 9, '单位 x 仍是 9 —— 判定中心 / 逻辑没动');
    assert.equal(at[0], 10, '立绘世界 x = 9 + 1');
  });

  test('②【改动前后都绿】dx = 0 的单位：立绘世界坐标逐位不变（含 dy = 1 的 6 只巨型 BOSS）', () => {
    const zero = HUGE.filter((k) => !hitAreaOf(k).dx);
    assert.equal(zero.length, 6, '7 只巨型 BOSS 里 6 只 dx = 0（它们的立绘与生效范围本来就同心）');
    for (const key of [...zero, 'enemy_1007_slime']) {
      const { at } = drawPoint({ defId: key, x: 9, y: 3 });
      assert.ok(Object.is(at[0], 9), `${key}: 立绘世界 x 逐位等于 9`);
      assert.ok(Object.is(at[1], 3), `${key}: 立绘世界 y 逐位等于 3`);
    }
    const { at } = drawPoint({ defId: 'char_x', side: 'ally', kind: 'chess', boss: false, x: 9, y: 3 });
    assert.ok(Object.is(at[0], 9), '干员不受影响（lookupDef 给的记录没有 hitArea）');
  });

  test('③【改动前后都绿】直接对照：带 dx = 0 的 hitArea 与完全没有 hitArea，两个视图完全一致', () => {
    const withDef = makeView({ defId: 'enemy_9021_acduml', x: 8.5, y: 4 });    // dx = 0, dy = 1
    const noDef = makeView({ defId: 'enemy_not_in_data', x: 8.5, y: 4 });
    const a = recorder(), b = recorder();
    withDef.update(1 / 60, a.cam, 0);
    noDef.update(1 / 60, b.cam, 0);
    assert.ok(Object.is(withDef.root.position.x, noDef.root.position.x), 'root.x 相同');
    assert.ok(Object.is(withDef.root.position.y, noDef.root.position.y), 'root.y 相同');
    assert.ok(Object.is(withDef.shadow.position.x, noDef.shadow.position.x), '影子 x 相同');
    assert.ok(Object.is(withDef.shadow.position.y, noDef.shadow.position.y), '影子 y 相同');
    assert.deepEqual(a.seen, b.seen, '这一帧交给相机的世界点完全相同');
  });

  test('④【改动前后都绿】dy 绝不叠加：7 只巨型 BOSS（含 dx = 1 的那只）立绘世界 y = 单位 y', () => {
    for (const key of HUGE) {
      for (const y of [3, 4, 10.5]) {
        const { at } = drawPoint({ defId: key, x: 9, y });
        assert.ok(Object.is(at[1], y), `${key} @ y=${y}：立绘世界 y = 单位 y（加了 dy = 1 会让 7 只整体上移一格）`);
      }
    }
  });

  test('⑤【改动前红】半场换算：左右半区（右半区列镜像 20 − c）立绘锚点都落在生效范围格的中心列', () => {
    for (const side of ['L', 'R']) {
      const xf = bossPrepField(side);
      const disp = xf.toDisp(10, 7);                       // 棋盘 (行 10, 列 7) → BOSS 半场显示格
      assert.equal(disp.row, 3, `${side}：只换行（10 − 7）`);
      assert.equal(disp.col, side === 'R' ? 13 : 7, `${side}：右半区列镜像 20 − 7 = 13`);
      // render/app.js setLeader → syncLeaderHits 的同一条路径：leaderStand 用显示格算出生效范围格
      const stand = leaderStand([{ boss: true, enemyKey: HIDDEN, count: 1, start: [disp.row, disp.col] }], hitAreaOf, hitTiles);
      assert.ok(stand, `${side}：leaderStand 找到站在 BOSS 半场的 leader`);
      assert.equal(stand.col, disp.col);
      const cols = [...new Set(stand.tiles.map(([, c]) => c))].sort((p, q) => p - q);
      const centre = (cols[0] + cols[cols.length - 1]) / 2;
      assert.deepEqual(cols, [disp.col - 1, disp.col, disp.col + 1, disp.col + 2, disp.col + 3], `${side}：5 列生效范围`);
      assert.equal(centre, disp.col + 1, `${side}：生效范围格的中心列 = 显示列 + dx`);
      // 立绘：单位显示列 = stand.col，画到哪？
      const { at } = drawPoint({ defId: HIDDEN, x: stand.col, y: stand.row });
      assert.equal(at[0], stand.col + 1, `${side}：立绘锚点 = 显示列 + dx`);
      assert.equal(at[0], centre, `${side}：立绘锚点与生效范围格中心重合 ✅`);
    }
  });

  test('⑥【改动前红】新读取口径本身：artDx = hitArea.dx，且 dx = 0 时 artX() 就是 this.x', () => {
    const hidden = makeView({ defId: HIDDEN, x: 9, y: 3 });
    assert.equal(hidden.artDx, 1);
    assert.equal(hidden.artX(), 10);
    for (const key of HUGE.filter((k) => !hitAreaOf(k).dx).concat('enemy_1007_slime', 'char_x')) {
      const v = makeView({ defId: key, x: 4.25, y: 3 });
      assert.equal(v.artDx, 0, `${key}: artDx = 0`);
      assert.ok(Object.is(v.artX(), v.x), `${key}: dx = 0 时 artX() 返回 this.x 本身（逐位相同）`);
    }
  });
});
