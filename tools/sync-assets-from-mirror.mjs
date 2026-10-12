// tools/sync-assets-from-mirror.mjs — 从一个已经在跑的同类实例（或任意静态源）镜像全套素材。
//
// 为什么需要它：`tools/fetch-assets.mjs` 不认识干员皮肤（它的 plan 里没有皮肤模型），所以
// **皮肤骨骼只能由本仓库自己的工具准备**。本脚本按 manifest 逐文件取，任何在跑的实例都能当源。
//
// 部署到新机器时的完整顺序（见 SKINS-BUILTIN-PLAN.md）：
//   npm run assets                                        # 核心素材（约 460 MB）
//   node tools/fetch-skin-spines.mjs                      # 皮肤骨骼（174 套，约 190 MB；可中断续传）
//   node tools/sync-assets-from-mirror.mjs --from <URL>   # 可选：从已有实例补齐（比走 GitHub 快得多）
//   node tools/inject-skins-assets.mjs                    # 注入 data/assets.json（必须在 assets 之后）
//
// 用法： node tools/sync-assets-from-mirror.mjs --from https://sp.bs.leio.fun [--concurrency 12] [--dry]
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MANIFEST = path.join(ROOT, 'data', 'assets.json');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const FROM = opt('--from', '').replace(/\/+$/, '');
const CONCURRENCY = Number(opt('--concurrency', 12));
const DRY = args.includes('--dry');

if (!FROM) {
  console.error('用法: node tools/sync-assets-from-mirror.mjs --from <https://实例地址> [--concurrency 12] [--dry]');
  process.exit(1);
}
if (!fs.existsSync(MANIFEST)) {
  console.error('✘ data/assets.json 不存在 —— 先跑 npm run assets（或先注入皮肤）');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

/** 清单里所有需要落盘的文件路径（与 test/assets.test.js 的遍历口径一致，含皮肤骨骼）。 */
const files = new Set();
(function walk(v) {
  if (typeof v === 'string') { if (v.startsWith('/assets/') || v.startsWith('/fonts/')) files.add(v); return; }
  if (Array.isArray(v)) return v.forEach(walk);
  if (v && typeof v === 'object') Object.values(v).forEach(walk);
})(manifest);

const list = [...files].sort();
console.log(`[mirror] 源: ${FROM}`);
console.log(`[mirror] 清单声明 ${list.length} 个文件`);

let have = 0;
const need = [];
for (const u of list) {
  const p = path.join(PUBLIC, u.replace(/^\//, ''));
  let st = null;
  try { st = await fsp.stat(p); } catch { /* missing */ }
  if (st && st.size > 0) have++;
  else need.push(u);
}
console.log(`[mirror] 已在磁盘 ${have}，待取 ${need.length}`);
if (DRY || !need.length) {
  console.log(DRY ? '[mirror] --dry：未下载' : '[mirror] 无需下载');
  process.exit(0);
}

let done = 0, failed = 0, bytes = 0;
const t0 = Date.now();
const failedList = [];
let cursor = 0;

async function worker() {
  while (cursor < need.length) {
    const u = need[cursor++];
    const dest = path.join(PUBLIC, u.replace(/^\//, ''));
    try {
      const res = await fetch(FROM + u, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('empty');
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, buf);
      bytes += buf.length;
    } catch (e) {
      failed++;
      failedList.push(`${u} (${String(e.message || e).slice(0, 60)})`);
    }
    done++;
    if (done % 100 === 0 || done === need.length) {
      const el = (Date.now() - t0) / 1000;
      process.stderr.write(`\r  ${done}/${need.length}  ${(bytes / 1048576).toFixed(1)} MiB  ${(bytes / 1024 / (el || 1)).toFixed(0)} KB/s  失败 ${failed}   `);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
const el = (Date.now() - t0) / 1000;
console.log(`\n[mirror] 完成：取回 ${need.length - failed} 个文件, ${(bytes / 1048576).toFixed(1)} MiB, ${(el / 60).toFixed(1)} min, 失败 ${failed}`);
if (failedList.length) {
  fs.mkdirSync(path.join(ROOT, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.cache', 'mirror-failed.txt'), failedList.join('\n'));
  console.log(`[mirror] 失败清单: .cache/mirror-failed.txt（前 5 条）`);
  failedList.slice(0, 5).forEach((f) => console.log(`    ${f}`));
  process.exitCode = 1;
}
