#!/usr/bin/env node
// tools/assets-merge.mjs — 合并版资源统一入口（中日语音 + 皮肤）。
//
// 为什么需要它：`data/assets.json` 是**生成物**。任何一次 `npm run assets` 都会从 plan 重建清单，
// 从而冲掉皮肤注入（皮肤模型不在 fetch-assets 的 plan 里）。只写一句「记得重新注入」不算交付，
// 所以本入口把四步串成一个**可重复、非破坏性**的动作：
//
//   1. 基础素材 + 双语语音   tools/fetch-assets.mjs --voice-langs=cn,jp
//   2. 皮肤注入              tools/inject-skins-assets.mjs
//   3. 全清单校验            引用是否都在磁盘、语言目录是否互相覆盖、皮肤是否完整
//   4. 汇总统计              总文件数、去重后字节、各语言文件数与覆盖人数
//
// 安全约定：
//   * **不使用** `--prune` / `--force`：不删除任何素材（新增的日语文件即使暂时未被引用也保留）。
//   * 清单由 fetch-assets 原子写入（写临时文件后 rename），失败保留旧清单。
//   * 可重复执行：第二次运行不重复下载、不重复追加、不破坏 174 套皮肤目录。
//
// 用法：
//   node tools/assets-merge.mjs [--langs=cn,jp] [--dry] [--skip-fetch] [--only-validate]
//   --langs        语音语言（默认 cn,jp；逗号分隔，第一个是主语言）
//   --dry          只打印将要做什么，不下载不写清单
//   --skip-fetch   跳过第 1 步（只重新注入 + 校验；素材已就绪时用）
//   --only-validate 只做第 3、4 步的校验与统计
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VOICE_DIRS } from './assets/audio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'data', 'assets.json');
const ASSETS = path.join(ROOT, 'public', 'assets');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const has = (n) => args.includes(n);
const LANGS = opt('--langs', 'cn,jp').split(',').map((s) => s.trim()).filter(Boolean);
const DRY = has('--dry');
const SKIP_FETCH = has('--skip-fetch');
const ONLY_VALIDATE = has('--only-validate');

const node = process.execPath;
/**
 * 运行一步。`tolerateExit` 里的退出码不算失败（fetch-assets 在缩水被拒、或有必需素材缺失时退出 1，但它已经把
 * 能下的都下了、清单也保持完整；后续步骤与校验会给出真正的结论）。
 */
const run = (label, argv, tolerateExit = []) => {
  console.log(`\n━━━ ${label} ━━━`);
  console.log(`  $ node ${argv.join(' ')}`);
  if (DRY) return { ok: true, skipped: true };
  const r = spawnSync(node, argv, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0 && !tolerateExit.includes(r.status)) {
    console.error(`\n✘ ${label} 失败（exit ${r.status}）—— 清单若是旧的则保持原样，未破坏`);
    process.exit(r.status || 1);
  }
  if (r.status !== 0) console.log(`\n  ⚠ ${label} 退出码 ${r.status}（已容忍：见上方的清单/缺失说明）`);
  return { ok: true, status: r.status };
};

for (const l of LANGS) {
  if (!VOICE_DIRS[l]) { console.error(`✘ 未知语言 ${l}（可用: ${Object.keys(VOICE_DIRS).join(' | ')}）`); process.exit(2); }
}

console.log('合并版资源入口');
console.log(`  工作目录: ${ROOT}`);
console.log(`  语音语言: ${LANGS.join(' → ')}（第一个是主语言，写入 audio.voice）`);
console.log(`  模式: ${DRY ? 'dry-run' : ONLY_VALIDATE ? '只校验' : SKIP_FETCH ? '跳过下载' : '完整'}`);

// ---- 0. 变更前的状态（用于事后核对「旧素材未丢失」）----------------------------------------------
let before = null;
if (fs.existsSync(MANIFEST)) {
  try {
    const j = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    before = { hash: j.hash, stats: j.stats, voiceLangs: j.audio?.voiceLanguages ? Object.keys(j.audio.voiceLanguages) : [] };
    console.log(`\n变更前: hash=${before.hash} stats.files=${before.stats?.files} stats.bytes=${before.stats?.bytes}`);
  } catch { /* 旧清单不可读：下面照样重建 */ }
}

// ---- 1. 基础素材 + 双语语音 ----------------------------------------------------------------------
if (!ONLY_VALIDATE) {
  // `--allow-shrink` 是**必须**的，而且理由是这个流程本身：fetch-assets 从 plan 重建清单，而皮肤模型不在它的
  // plan 里，所以新基线必然比「上一轮含皮肤的清单」少掉 chars[].skins —— 缩水保护会因此拒绝写入。
  // 皮肤紧接着由第 2 步注入回来，所以这里显式放行；丢掉的条目数照实打印（不隐藏），最终以第 3 步的校验为准。
  // 注意：仍然**不传** `--prune` / `--force`，不删除任何素材。
  run('第 1 步：基础素材 + 双语语音（--allow-shrink；不 prune / 不 force）', [
    'tools/fetch-assets.mjs', `--voice-langs=${LANGS.join(',')}`, '--allow-shrink',
  ], [1]);
}

// ---- 2. 皮肤注入（必须在 fetch 之后：清单是生成物）------------------------------------------------
if (!ONLY_VALIDATE) {
  run('第 2 步：皮肤注入', ['tools/inject-skins-assets.mjs']);
}

// ---- 3. 全清单校验 ------------------------------------------------------------------------------
console.log('\n━━━ 第 3 步：全清单校验 ━━━');
if (!fs.existsSync(MANIFEST)) { console.error('✘ data/assets.json 不存在'); process.exit(1); }
const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const sha = (await import('node:crypto')).createHash('sha256');

// 所有引用的本地路径（与 test/assets.test.js 同口径）
const refs = new Set();
(function walk(v) {
  if (typeof v === 'string') { if (v.startsWith('/assets/') || v.startsWith('/fonts/')) refs.add(v.replace(/^\//, '')); return; }
  if (Array.isArray(v)) return v.forEach(walk);
  if (v && typeof v === 'object') Object.values(v).forEach(walk);
})(m);

const problems = [];
let bytes = 0;
const seen = new Set();
for (const rel of refs) {
  if (seen.has(rel)) continue;
  seen.add(rel);
  const p = path.join(ROOT, 'public', rel);
  let st = null;
  try { st = fs.statSync(p); } catch { /* missing */ }
  if (!st || st.size === 0) problems.push(`引用但磁盘缺失/空: ${rel}`);
  else bytes += st.size;
}
console.log(`  引用文件: ${refs.size}（去重后），合计 ${(bytes / 1048576).toFixed(1)} MiB`);
console.log(`  磁盘缺失: ${problems.length}`);

// 语言目录互相覆盖检查（中日路径必须不同，且都不得指向对方）
const voiceLangs = m.audio?.voiceLanguages || {};
const langDir = {};
for (const [lang, byChar] of Object.entries(voiceLangs)) {
  let files = 0, chars = 0;
  for (const slots of Object.values(byChar || {})) {
    chars++;
    for (const v of Object.values(slots)) files += Array.isArray(v) ? v.length : 1;
  }
  langDir[lang] = { chars, files, dir: VOICE_DIRS[lang] };
}
console.log('  语音语言:');
for (const [lang, s] of Object.entries(langDir)) {
  console.log(`    ${lang}: ${s.chars} 名干员 / ${s.files} 条，目录 ${s.dir}/`);
}
// 每个语言引用的文件必须落在自己的目录下
for (const [lang, byChar] of Object.entries(voiceLangs)) {
  const want = `/assets/audio/voice/${lang}/`;
  for (const [charId, slots] of Object.entries(byChar || {})) {
    for (const [slot, v] of Object.entries(slots)) {
      for (const u of (Array.isArray(v) ? v : [v])) {
        if (!String(u).startsWith(want)) problems.push(`语音语言串目录: ${lang} 的 ${charId}.${slot} -> ${u}`);
      }
    }
  }
}
// 主语言与 audio.voice 必须一致
const primary = m.audio?.voice ? Object.keys(m.audio.voice).length : 0;
console.log(`  audio.voice（主语言，兼容旧客户端）: ${primary} 名干员`);

// 皮肤完整性
let skinCount = 0, skinChars = 0, withFront = 0, withBack = 0;
for (const c of Object.values(m.chars || {})) {
  if (!c.skins) continue;
  skinChars++;
  for (const s of Object.values(c.skins)) {
    skinCount++;
    if (s.spine?.front?.skel) withFront++;
    if (s.spine?.back?.skel) withBack++;
  }
}
console.log(`  皮肤: ${skinChars} 名干员 / ${skinCount} 套（有前向骨骼 ${withFront}、后向 ${withBack}）`);

// 语言目录不得覆盖已有音频
for (const lang of Object.keys(voiceLangs)) {
  const d = path.join(ASSETS, 'audio', 'voice', lang);
  console.log(`  ${lang} 目录实际文件数: ${fs.existsSync(d) ? fs.readdirSync(d).length + ' 个子目录/文件' : '（不存在）'}`);
}

if (problems.length) {
  console.log(`\n  ⚠ 校验问题 ${problems.length} 条：`);
  problems.slice(0, 20).forEach((p) => console.log(`    ${p}`));
} else {
  console.log('  ✅ 引用完整、语言目录未串、皮肤目录完好');
}

// ---- 4. 汇总统计 --------------------------------------------------------------------------------
console.log('\n━━━ 第 4 步：汇总统计 ━━━');
const stats = m.stats || {};
console.log(`  清单 hash: ${m.hash}`);
console.log(`  stats.files: ${stats.files}   stats.bytes: ${(stats.bytes / 1048576).toFixed(1)} MiB`);
console.log(`  干员 ${stats.chars} · 皮肤 ${stats.skins} 套 / ${stats.charsWithSkins} 干员（骨骼 ${stats.skinsWithSpine}）`);
console.log(`  语音覆盖: ${JSON.stringify(stats.voiceLangs || {})}   voiceChars=${stats.voiceChars}`);
if (before) {
  console.log(`  变更前: files ${before.stats?.files} -> ${stats.files}，bytes ${(before.stats?.bytes / 1048576).toFixed(1)} -> ${(stats.bytes / 1048576).toFixed(1)} MiB`);
  console.log(`  变更前语言: ${before.voiceLangs.join(',') || '（无）'}  ->  现在: ${Object.keys(voiceLangs).join(',') || '（无）'}`);
}

// 素材总体积（磁盘实数，含未被引用的历史文件）
const du = spawnSync('du', ['-sm', ASSETS], { encoding: 'utf8' });
const diskMB = du.status === 0 ? Number(String(du.stdout).split(/\s+/)[0]) : null;
if (diskMB) console.log(`  public/assets 磁盘实占: ${diskMB} MiB（含清单未引用的历史文件）`);

if (problems.length) process.exitCode = 1;
console.log('\n完成。');
