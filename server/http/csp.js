// Site policy (DESIGN §32.11). Hash only import maps, never arbitrary inline script. Worker/UI policies are independent.
// worker-src 'self' is the asset service worker at /sw.js. blob: stays for workers the page already creates
// (the simulation worker). Do not add a remote worker origin. SIM_WORKER_CSP is that worker's own policy and
// must not gain the asset worker.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// SES evaluates confined code. This relaxation belongs only to the simulation Worker, never its parent document.
export const SIM_WORKER_CSP = "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'";

/** The documents whose import maps this policy allows inline. index.html is served rendered, see siteCsp. */
const POLICY_DOCS = ['index.html', 'studio/index.html', 'dev/game-mock.html', 'dev/render-demo.html', 'dev/battle-perf.html', 'dev/uikit.html'];
const IMPORT_MAP = /<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/g;

/** The `'sha256-…'` CSP source of every import map body in one HTML document, added to `into`. */
export function importMapHashes(html, into = new Set()) {
  for (const m of html.matchAll(IMPORT_MAP)) into.add(`'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  return into;
}

/** The policy that allows exactly the import maps in `hashes` (`'sha256-…'` sources). */
export function cspFromHashes(hashes) {
  return `default-src 'self'; script-src 'self'${hashes.size ? ' ' + [...hashes].join(' ') : ''}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: blob: https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self'; object-src 'none'; base-uri 'none'`;
}

/**
 * The site policy for the documents this server serves.
 *
 * `renderedIndex`: the import-map sources of the index document the server is about to send
 * (runtimeCache.renderIndex returns them). They REPLACE the ones read from public/index.html, because that file's
 * import map is only a pointer: the bytes the browser receives are the map expanded with every module's content
 * hash (runtimeCache.js), so a policy hashing the file leaves the served page's only inline script without a
 * matching source and the browser blocks it — no script-src violation to fix other than this one. When the page is
 * served unrendered (runtimeCache off, or HTML without an app import map) the file's own maps are the sent ones,
 * so they stay the fallback. Every other document here is always served as the bytes on disk.
 */
export function siteCsp(publicDir, renderedIndex = null) {
  const hashes = new Set();
  for (const rel of POLICY_DOCS) {
    if (rel === 'index.html' && renderedIndex) { for (const hash of renderedIndex) hashes.add(hash); continue; }
    let html;
    try { html = fs.readFileSync(path.join(publicDir, rel), 'utf8'); } catch { continue; }
    importMapHashes(html, hashes);
  }
  return cspFromHashes(hashes);
}
