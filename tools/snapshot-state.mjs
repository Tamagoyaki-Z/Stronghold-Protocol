// tools/snapshot-state.mjs — 完整状态快照（不是只存 HEAD）。
//
// 交付/交接用：把「代码改动 + 生成清单 + 全部素材引用」落成一份可恢复、可校验、可重复执行的快照。
// 恢复时不需要重新下载素材也能重建：清单里有每个素材的 URL、字节数与 sha256。
//
// 用法： node tools/snapshot-state.mjs [--out <目录>] [--no-assets] [--label <标签>]
//   --out       输出目录（默认 .snapshot/<时间戳>）
//   --no-assets 只快照代码与清单，不逐文件哈希素材（快很多）
//   --label     标签，写进 manifest.json（例如 before-voice-merge / after-voice-merge）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const NO_ASSETS = args.includes('--no-assets');
const LABEL = opt('--label', 'snapshot');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.resolve(opt('--out', path.join(ROOT, '.snapshot', `${stamp}-${LABEL}`)));

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/** 不参与源码快照的目录（素材单独走清单；node_modules/缓存是派生物）。 */
const SKIP_DIRS = new Set(['node_modules', '.cache', '.snapshot', '.git', '.venv-extract']);
const isAssetPath = (r) => r.startsWith('public/assets/') || r.startsWith('public/fonts/');

await fsp.mkdir(OUT, { recursive: true });

// ---- 1. git 状态（未提交的改动是快照的主体，HEAD 本身不够）-------------------------------------
const git = (a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }); } catch (e) { return `(git ${a.join(' ')} 失败: ${e.message})`; } };
const gitStatus = git(['status', '--short']);
const gitHead = git(['log', '-1', '--format=%H %ad %s', '--date=iso']);
await fsp.writeFile(path.join(OUT, 'git-status.txt'), gitStatus, 'utf8');
await fsp.writeFile(path.join(OUT, 'git-head.txt'), gitHead, 'utf8');

// 已跟踪文件的改动（含二进制）+ 未跟踪但已 add 的新文件：做成可 git apply 的补丁
await fsp.writeFile(path.join(OUT, 'changes.patch'), git(['diff', 'HEAD', '--binary']), 'utf8');
// 未跟踪文件（理论上应为空；不为空也一并存内容）
const untracked = gitStatus.split('\n').filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim()).filter(Boolean);

// ---- 2. 源码与生成清单逐文件快照 ---------------------------------------------------------------
const manifest = { label: LABEL, at: new Date().toISOString(), root: ROOT, files: [], assets: [], skippedBodies: [] };

async function walk(dir) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const r = rel(p);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (r === 'public/assets' || r === 'public/fonts') continue; // 素材走清单那一节
      await walk(p);
      continue;
    }
    if (!e.isFile()) continue;
    if (isAssetPath(r)) continue;
    const buf = await fsp.readFile(p);
    const st = await fsp.stat(p);
    const entry = { path: r, bytes: buf.length, sha256: sha256(buf), mtime: st.mtime.toISOString() };
    // 大文件（例如生成清单）只记哈希，正文仍存一份（可恢复性优先）
    await fsp.mkdir(path.dirname(path.join(OUT, 'files', r)), { recursive: true });
    await fsp.writeFile(path.join(OUT, 'files', r), buf);
    manifest.files.push(entry);
  }
}
await walk(ROOT);

for (const r of untracked) {
  try {
    const buf = await fsp.readFile(path.join(ROOT, r));
    await fsp.mkdir(path.dirname(path.join(OUT, 'files', r)), { recursive: true });
    await fsp.writeFile(path.join(OUT, 'files', r), buf);
    manifest.files.push({ path: r, bytes: buf.length, sha256: sha256(buf), untracked: true });
  } catch { /* 已在本体快照里 */ }
}

// ---- 3. 素材清单：每个引用文件的 URL / 大小 / sha256（可据此从镜像重建，无需重下）------------------
const ASSETS = path.join(ROOT, 'data', 'assets.json');
if (fs.existsSync(ASSETS)) {
  const j = JSON.parse(await fsp.readFile(ASSETS, 'utf8'));
  const refs = new Set();
  (function w(v) {
    if (typeof v === 'string') { if (v.startsWith('/assets/') || v.startsWith('/fonts/')) refs.add(v); return; }
    if (Array.isArray(v)) return v.forEach(w);
    if (v && typeof v === 'object') Object.values(v).forEach(w);
  })(j);
  let done = 0;
  for (const u of [...refs].sort()) {
    const p = path.join(ROOT, 'public', u.replace(/^\//, ''));
    try {
      const st = await fsp.stat(p);
      const e = { url: u, bytes: st.size };
      if (!NO_ASSETS) e.sha256 = sha256(await fsp.readFile(p));
      manifest.assets.push(e);
    } catch {
      manifest.assets.push({ url: u, bytes: null, missing: true });
    }
    if (++done % 500 === 0) process.stderr.write(`\r  [snapshot] 素材 ${done}/${refs.size}   `);
  }
  process.stderr.write(`\r  [snapshot] 素材 ${done}/${refs.size} 完毕\n`);
  manifest.manifestHash = j.hash || null;
  manifest.stats = j.stats || null;
}

manifest.fileCount = manifest.files.length;
manifest.assetCount = manifest.assets.length;
manifest.assetBytes = manifest.assets.reduce((s, a) => s + (a.bytes || 0), 0);
manifest.missingAssets = manifest.assets.filter((a) => a.missing).length;

await fsp.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

console.log(`[snapshot] 输出: ${OUT}`);
console.log(`  代码/清单文件: ${manifest.fileCount}`);
console.log(`  素材引用: ${manifest.assetCount}（缺失 ${manifest.missingAssets}），共 ${(manifest.assetBytes / 1048576).toFixed(1)} MiB`);
console.log(`  清单 hash: ${manifest.manifestHash}  stats.files=${manifest.stats?.files} stats.bytes=${manifest.stats?.bytes}`);
console.log(`  changes.patch: ${(await fsp.stat(path.join(OUT, 'changes.patch'))).size} B（git apply 可复原代码改动）`);
