// Imported art in Cache Storage: the predicate the origin's single worker (public/asset-cache-sw.js) serves it with.
//
// That worker imports this module, so these three names are the copy in use. public/sw.js keeps a classic copy of
// them but is no longer registered: two registrations at scope '/' replace each other, and the page is then left
// with a worker that never answers the asset-cache coordinator (the 0.3.0 hang on 正在检查缓存).
//
// The worker serves only same-origin GET of a content-hashed /assets/, /fonts/ or /media/ URL. A hit comes from
// this cache. A miss goes to the network and is not written here. HTML, scripts, /data/, /sim/ and /ws are never
// matched. A Range request is left to the network so audio seeking still reaches the server. What an import stored is
// also listed in one index entry of the cache (IMPORTED_INDEX_URL): Chrome cannot list a cache that large.

/** Cache Storage name. Bump the suffix to drop previously imported bytes on the next activation. */
export const IMPORTED_ASSET_CACHE = 'sp-imported-assets-v1';

/** Prefix of every version of this cache. Activation deletes other names that start with it. */
export const IMPORTED_ASSET_CACHE_PREFIX = 'sp-imported-assets-';

/** Pathname of a URL this cache may answer. The hash is the same 16 hex digits as shared/assetPaths.js. */
export const IMPORTED_ASSET_PATH = /^\/(?:assets|fonts|media)\/~[0-9a-f]{16}\//;

/** The one service worker this origin registers. Both boot (so an imported pack is served without ever opening
 * the panel) and the asset-cache panel (public/js/assetCache.js) go through this script: registrations are keyed
 * by scope, so a second script at the same scope would replace this one. */
export const ASSET_CACHE_SW_URL = '/asset-cache-sw.js';

/** Scope of ASSET_CACHE_SW_URL. /assets/, /fonts/ and /media/ are sibling prefixes, so only the origin root
 * covers every path the worker serves (shared/assetCache.js safeAssetPath). */
export const ASSET_CACHE_SW_SCOPE = '/';

/**
 * Whether a request should be answered from the import cache.
 * `pageOrigin` is the page (and the worker) origin. A relative URL is resolved against it.
 * @param {Request | { url?: string, method?: string, headers?: { get?: Function, range?: string } } | string} request
 * @param {string} [pageOrigin]
 */
export function shouldServeImportedAsset(request, pageOrigin) {
  const method = typeof request === 'string' ? 'GET' : (request?.method || 'GET');
  if (String(method).toUpperCase() !== 'GET') return false;
  if (request && typeof request === 'object' && request.headers) {
    const headers = request.headers;
    const range = typeof headers.get === 'function' ? headers.get('range') : (headers.range || headers.Range);
    if (range) return false;
  }
  const raw = typeof request === 'string' ? request : request?.url;
  if (!raw || !pageOrigin) return false;
  let url;
  try { url = new URL(raw, pageOrigin); } catch { return false; }
  if (url.origin !== pageOrigin) return false;
  return IMPORTED_ASSET_PATH.test(url.pathname);
}

/** Why import is unavailable, or `{ ok: true }` on a secure context that has the APIs. */
export function importSupport(nav = globalThis.navigator, secure = globalThis.isSecureContext) {
  if (!secure) return { ok: false, reason: 'insecure' };
  if (!nav?.serviceWorker || !globalThis.caches || !globalThis.crypto?.subtle) return { ok: false, reason: 'unsupported' };
  return { ok: true };
}

/**
 * Register ASSET_CACHE_SW_URL and return its registration. The repository's only call into the
 * registration API: one script, one scope, so no worker can evict another.
 * @returns {Promise<ServiceWorkerRegistration>}
 */
export function registerAssetCacheWorker(nav = globalThis.navigator, url = ASSET_CACHE_SW_URL) {
  return nav.serviceWorker.register(url, { scope: ASSET_CACHE_SW_SCOPE, type: 'module', updateViaCache: 'none' });
}

/**
 * Boot's entry point for that same worker. Failures are swallowed: a missing worker must not stop the game.
 * Call only from boot. Unit tests import the downloader and must not register a worker as a side effect.
 * @returns {Promise<boolean>}
 */
export function registerImportedAssetWorker(nav = globalThis.navigator, secure = globalThis.isSecureContext) {
  if (!secure || !nav?.serviceWorker?.register) return Promise.resolve(false);
  return registerAssetCacheWorker(nav).then(() => true, () => false);
}

/** Content-Type stored with an imported response, chosen from the URL the game will request. */
export function contentTypeFor(url) {
  const path = String(url || '').split('?')[0].toLowerCase();
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  if (path.endsWith('.ogg') || path.endsWith('.oga')) return 'audio/ogg';
  if (path.endsWith('.m4a') || path.endsWith('.aac')) return 'audio/aac';
  if (path.endsWith('.wav')) return 'audio/wav';
  if (path.endsWith('.opus')) return 'audio/ogg';
  if (path.endsWith('.woff2')) return 'font/woff2';
  if (path.endsWith('.woff')) return 'font/woff';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.atlas')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/** Put one body at each URL. Each put gets its own copy: Cache Storage consumes the body. */
export async function putImportedAsset(cache, urls, bytes, typeFor = contentTypeFor) {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  await Promise.all([...urls].map((url) => {
    const copy = body.slice();
    const response = new Response(copy, {
      status: 200,
      headers: { 'Content-Type': typeFor(url) },
    });
    return cache.put(url, response);
  }));
}

function pathnameOf(url) {
  try { return new URL(url, 'http://localhost').pathname; } catch { return ''; }
}

/**
 * The import's own list of the pathnames it stored: a JSON array kept in the import cache at this same-origin path,
 * which the worker never answers (not a hashed /assets/, /fonts/ or /media/ URL). Chrome refuses Cache.keys() for a
 * cache of more than about 15,000 entries ("Operation too large"); a whole pack stores some 43,000 (the audio twice).
 */
export const IMPORTED_INDEX_URL = '/sp-imported-index.json';

/** The index as a Set, or null without a readable one. */
async function readImportIndex(cache) {
  try {
    const hit = await cache.match(IMPORTED_INDEX_URL);
    if (!hit) return null;
    const list = await hit.json();
    return Array.isArray(list) ? new Set(list.filter((p) => typeof p === 'string' && p !== IMPORTED_INDEX_URL)) : null;
  } catch {
    return null;
  }
}

/** Pathnames of Cache.keys() (throws for a cache too large to list). */
async function keyPaths(cache) {
  const out = new Set();
  for (const req of await cache.keys()) {
    const path = pathnameOf(typeof req === 'string' ? req : req.url);
    if (path && path !== IMPORTED_INDEX_URL) out.add(path);
  }
  return out;
}

/**
 * Pathnames currently stored for imported art (assets, fonts and the audio /media/ alias): the import's index, else
 * the cache's keys (a cache written without an index); an empty set when neither can be read.
 */
export async function listImportedPaths(cachesApi = globalThis.caches) {
  if (!cachesApi?.open) return new Set();
  try {
    const cache = await cachesApi.open(IMPORTED_ASSET_CACHE);
    return (await readImportIndex(cache)) ?? await keyPaths(cache);
  } catch {
    return new Set();
  }
}

/**
 * Add the pathnames an import stored to the index (assetPack.js, as an import ends — finished, cancelled or failed).
 * Without an index yet, the cache's keys seed it when Cache.keys() still answers.
 * @param {Cache} cache the open import cache
 * @param {Iterable<string>} paths
 */
export async function addImportedPaths(cache, paths) {
  let all = await readImportIndex(cache);
  if (!all) {
    try { all = await keyPaths(cache); } catch { all = new Set(); }
  }
  for (const p of paths) if (typeof p === 'string' && p && p !== IMPORTED_INDEX_URL) all.add(p);
  await cache.put(IMPORTED_INDEX_URL, new Response(JSON.stringify([...all].sort()), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }));
}

/** How many imported files are stored, counting /assets/ and /fonts/ only (not the /media/ alias). */
export async function countImportedFiles(cachesApi = globalThis.caches) {
  const paths = await listImportedPaths(cachesApi);
  let n = 0;
  for (const path of paths) {
    if (path.startsWith('/assets/') || path.startsWith('/fonts/')) n++;
  }
  return n;
}

/** Delete every version of the import cache. The worker stays registered. */
export async function clearImportedAssets(cachesApi = globalThis.caches) {
  if (!cachesApi?.delete) return false;
  try {
    if (cachesApi.keys) {
      const names = await cachesApi.keys();
      const ours = names.filter((name) => String(name).startsWith(IMPORTED_ASSET_CACHE_PREFIX));
      if (ours.length) {
        await Promise.all(ours.map((name) => cachesApi.delete(name)));
        return true;
      }
    }
    return await cachesApi.delete(IMPORTED_ASSET_CACHE);
  } catch {
    return false;
  }
}

/** `navigator.storage.estimate()`, or null. `usage` is the whole origin, not only this cache. */
export async function storageEstimate(nav = globalThis.navigator) {
  try {
    const est = await nav?.storage?.estimate?.();
    if (!est) return null;
    return { usage: est.usage || 0, quota: est.quota || 0 };
  } catch {
    return null;
  }
}

/**
 * Ask the browser to keep the origin's storage. The return value is not a promise that the bytes will survive
 * eviction (iOS may still drop them after about seven days).
 * @returns {Promise<boolean | null>}
 */
export async function askPersistStorage(nav = globalThis.navigator) {
  try {
    if (!nav?.storage?.persist) return null;
    return await nav.storage.persist();
  } catch {
    return null;
  }
}
