// tools/inject-skins-assets.mjs — 把 docs/research/08-skins.json 的 174 套皮肤注入 data/assets.json。
//
// 与 fork 原版的差别（原版抄干员原皮的 anims，docs/SKINS.md:38-41 警告那会让模型加载失败）：
//
//   本版让每套皮肤的骨骼走**与干员模型完全相同的构建期管线**：
//     .skel → parseSkel() → resolveRoles() → { anims, animations, events, hits, bounds }
//   即 tools/assets/spine.mjs processModels() 对 `op:<char>:front|back` 做的那几行。这样皮肤的
//   anims 来自它**自己的**骨骼，技能剪辑、攻击剪辑、命中帧、包围盒都是真实的。
//
//   技能下标用 plan.mjs 的 skillIndicesByChar(03-operators.json) —— 与干员模型同一个来源，
//   所以「干员能装的技能」和「皮肤骨骼解析出的技能剪辑」永远一致。
//
// 幂等：只写磁盘上真实存在的文件；重复运行结果相同。data/assets.json 是生成物，
// 必须先跑 `npm run assets`（或 fetch-assets.mjs）再跑本脚本，否则会被下一次生成冲掉。
//
// 用法： node tools/inject-skins-assets.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { atlasInfo, normalizeAtlas } from './assets/atlas.mjs';
import { pngSize } from './assets/formats.mjs';
import { parseSkel, skelParserAvailable } from './assets/skel.mjs';
import { resolveRoles } from './assets/anim-roles.mjs';
import { skillIndicesByChar } from './assets/plan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESEARCH_PATH = path.join(ROOT, 'docs', 'research', '08-skins.json');
const OPS_PATH = path.join(ROOT, 'docs', 'research', '03-operators.json');
const ASSETS_PATH = path.join(ROOT, 'data', 'assets.json');
const DRY = process.argv.includes('--dry');

const research = JSON.parse(fs.readFileSync(RESEARCH_PATH, 'utf8'));
const assets = JSON.parse(fs.readFileSync(ASSETS_PATH, 'utf8'));

if (!assets.chars) {
  console.error('✘ data/assets.json 缺少 chars 字段（先跑 npm run assets）');
  process.exit(1);
}
if (!skelParserAvailable()) {
  console.error('✘ Spine 解析器不可用（@pixi-spine/runtime-3.8 缺失）—— 先 npm install');
  process.exit(1);
}

const ops03 = JSON.parse(fs.readFileSync(OPS_PATH, 'utf8'));
const skillIdx = skillIndicesByChar(ops03);

/**
 * 干员可装备的全部技能下标。
 *
 * 起点照 plan.mjs:359-360（干员模型用的同一算法），但**必须补齐到连续区间**：
 * resolveRoles 只给 `[1]` 时会返回 `skills: undefined`（编号剪辑 Skill_1_* 映射到下标 0、Skill_2_* 到 1，
 * 下标 0 缺席就整组丢失），而基座干员模型的 anims.skills 是满的（207/209 非空）。
 * 高级干员不带调配时按默认技能 0 出场，所以 0 下标尤其不能缺。
 */
function indicesFor(charId) {
  const o = ops03[charId] || {};
  const idx0 = skillIdx.get(charId) || [0];
  const extra = (o.skills || []).map((k) => k.index)
    .filter((i) => Number.isInteger(i) && i >= 0 && !idx0.includes(i));
  const used = [...new Set([...idx0, ...extra])];
  // 下界 1：resolveRoles 的编号是 1 基（下标 i → `Skill_${i+1}_*`），只给 [0] 找的是 `Skill_1_*`，
  //   而带 2 技能的干员（如 char_196_sunbr）骨骼里只有 `Skill_2_*` —— 只给 [0] 会把存在的剪辑漏掉。
  // 上界 max：干员技能数决定，不无谓地多解析。
  const max = Math.max(1, ...used);
  return Array.from({ length: max + 1 }, (_, i) => i);
}

/** 磁盘上某套皮肤某个朝向的三个文件都齐了吗 */
function sideReady(charId, stem, side) {
  const dir = path.join(ROOT, 'public', 'assets', 'spine', 'op', charId, stem, side);
  const ok = ['skel', 'atlas', 'png'].every((e) => {
    const p = path.join(dir, `${stem}.${e}`);
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  });
  return ok ? dir : null;
}

/**
 * 一套皮肤的骨骼 → 与 processModels 输出同形的 spine 条目。
 * @returns {{ entry: any, note: string|null }}
 */
function buildSide(charId, stem, side, dir, skillIndices) {
  const rel = `/assets/spine/op/${charId}/${stem}/${side}/${stem}`;
  try {
    const skelBuf = fs.readFileSync(path.join(dir, `${stem}.skel`));
    let atlasText = fs.readFileSync(path.join(dir, `${stem}.atlas`), 'utf8');
    // 与 tools/assets/spine.mjs processModels 对干员/敌人模型做的**同一件事**：给 atlas 补上 `size: W,H`。
    // 皮肤骨骼是 fetch-skin-spines 从 jsDelivr 直下的，没走那条管线，于是 341 个皮肤 atlas 全都没有 size 行
    // （fexli 的 atlas 一贯省略它；pixi-spine 会因为 size 为 0 而告警）。这里补上，保持与核心模型一致。
    {
      const info0 = atlasInfo(atlasText);
      const sizes = new Map();
      for (const page of info0.pages) {
        const buf = fs.existsSync(path.join(dir, page)) ? fs.readFileSync(path.join(dir, page)) : null;
        const sz = buf ? pngSize(buf) : null;
        if (sz) sizes.set(page, sz);
      }
      const norm = normalizeAtlas(atlasText, { pageSize: (p) => sizes.get(p) || null, pma: false });
      if (norm.changed && !norm.missingSize.length) {
        const tmp = path.join(dir, `${stem}.atlas.tmp`);
        fs.writeFileSync(tmp, norm.text);
        fs.renameSync(tmp, path.join(dir, `${stem}.atlas`));
        atlasText = norm.text;
      }
    }
    const info = atlasInfo(atlasText);
    const sk = parseSkel(skelBuf, info.regions);
    if (!sk.animations?.length) return { entry: null, note: `${stem}/${side}: 骨骼没有动画` };
    const anims = resolveRoles(sk.animations, { skillIndices, durations: sk.durations });
    const entry = {
      skel: `${rel}.skel`,
      atlas: `${rel}.atlas`,
      // the atlas pages the model actually references (usually one)
      textures: info.pages.map((p) => `/assets/spine/op/${charId}/${stem}/${side}/${p}`),
      pma: false,
      anims,
      animations: sk.durations,
      events: sk.events,
      hits: sk.hits,
      bounds: sk.bounds,
    };
    const warn = [];
    if (sk.missingRegions?.length) warn.push(`${sk.missingRegions.length} 个贴图区域不在 atlas 里`);
    // 基座干员模型的 anims.skills 是满的（207/209）；解析出空的说明下标给了但不匹配剪辑，要当成问题报出来
    if (anims.skills === undefined || Object.keys(anims.skills).length === 0) warn.push('没有解析出技能剪辑（客户端只能用攻击剪辑）');
    return { entry, note: warn.length ? `${stem}/${side}: ${warn.join('；')}` : null };
  } catch (e) {
    return { entry: null, note: `${stem}/${side}: 解析失败 (${e.message})` };
  }
}

let injected = 0, avatars = 0, charsTouched = 0, skippedNoChar = 0;
const notes = [];
const usedFallback = [];

for (const [charId, skinList] of Object.entries(research.skins || {})) {
  const charRec = assets.chars[charId];
  if (!charRec) { skippedNoChar += skinList.length; continue; }

  const skillIndices = indicesFor(charId);
  const skins = {};
  let any = false;

  for (const s of skinList) {
    const { skinId, stem } = s;
    const avatarPng = path.join(ROOT, 'public', 'assets', 'char', 'skin_avatar', `${stem}.png`);
    const hasAvatar = fs.existsSync(avatarPng);
    const entry = { name: s.name, group: s.group || '' };
    if (hasAvatar) {
      entry.avatar = `/assets/char/skin_avatar/${stem}.png`;
      avatars++;
    } else if (s.avatar?.url) {
      entry.avatar = s.avatar.url;
    }

    // 骨骼：只有磁盘上齐了才写 spine —— 缺文件时客户端平滑回落到干员原皮（spineEntry）
    const frontDir = sideReady(charId, stem, 'front');
    if (frontDir) {
      const f = buildSide(charId, stem, 'front', frontDir, skillIndices);
      if (f.note) notes.push(`${charId}/${f.note}`);
      if (f.entry) {
        const spine = { front: f.entry };
        const backDir = sideReady(charId, stem, 'back');
        if (backDir) {
          const b = buildSide(charId, stem, 'back', backDir, skillIndices);
          if (b.note) notes.push(`${charId}/${b.note}`);
          if (b.entry) spine.back = b.entry;
        }
        entry.spine = spine;
      }
    } else {
      usedFallback.push(`${charId}/${stem}`);
    }

    skins[skinId] = entry;
    injected++;
    any = true;
  }

  if (any) { charRec.skins = skins; charsTouched++; }
}

// stats 是**合并**更新（fork 原版整体替换，会抹掉 files/bytes/chars…）
assets.stats = assets.stats || {};
assets.stats.skins = injected;
assets.stats.charsWithSkins = charsTouched;
assets.stats.skinsWithSpine = injected - usedFallback.length;

console.log(`✔ 注入 ${charsTouched} 名干员的 ${injected} 套皮肤（头像 ${avatars} 个）`);
console.log(`  含骨骼: ${assets.stats.skinsWithSpine} 套；仅头像（骨骼缺失，客户端回落原皮）: ${usedFallback.length} 套`);
if (usedFallback.length) {
  console.log(`  仅头像的套: ${usedFallback.slice(0, 10).join(', ')}${usedFallback.length > 10 ? ` … 共 ${usedFallback.length}` : ''}`);
}
if (skippedNoChar) console.log(`  ⚠ 跳过 ${skippedNoChar} 套：其干员不在 data/assets.json 的 chars 里`);
if (notes.length) {
  console.log(`  解析告警 ${notes.length} 条（前 8 条）:`);
  notes.slice(0, 8).forEach((n) => console.log(`    ${n}`));
}

if (DRY) {
  console.log('\n--dry：未写入 data/assets.json');
} else {
  fs.writeFileSync(ASSETS_PATH, JSON.stringify(assets), 'utf8');
  console.log(`\n已写入 data/assets.json（stats 合并保留原有字段）`);
}
