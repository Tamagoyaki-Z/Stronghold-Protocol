// The origin's one service worker, registered at scope '/'. It serves two disjoint concerns:
//   1. the pack a player imported (the branch public/sw.js owned before it was retired; see js/importCache.js);
//   2. this origin's own assets, verified against a per-client pinned catalog.
// Asset-only cache: HTML, application code, data, APIs and private announcements never enter it.
// Content hashes let unchanged files survive upgrades; per-client catalogs pin live matches.
import { ASSET_CACHE_NAME, ASSET_CACHE_META, assetContentKey, catalogURLMap,
  verifyAssetCatalog, decodedAssetPath, isVerifiedAssetResponse, validatedCacheHeaders,
  parseAssetRange, sha256Hex } from '/shared/assetCache.js';
import { IMPORTED_ASSET_CACHE, IMPORTED_ASSET_CACHE_PREFIX, shouldServeImportedAsset } from '/js/importCache.js';

const origin = self.location.origin;
const catalogPath = (version) => `${origin}/__sp_asset_cache__/catalog/${version}`;
const pinPath = (id) => `${origin}/__sp_asset_cache__/pin/${encodeURIComponent(id)}`;
const latestPath = `${origin}/__sp_asset_cache__/latest`;
const catalogs = new Map();
const pins = new Map();
let passiveActive = 0;
let lastNotify = 0;
let messages = Promise.resolve();

// Take the scope over at once. A page whose retired classic worker (public/sw.js) still controls it would
// otherwise keep posting the catalog protocol to a worker that never answers, and this worker would wait
// until every tab closed — the panel would stay on 正在检查缓存. Activating mid-session is safe: every served
// byte is content-addressed and the catalog/pin metadata lives in Cache Storage, not in worker memory.
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names
    .filter((name) => name.startsWith(IMPORTED_ASSET_CACHE_PREFIX) && name !== IMPORTED_ASSET_CACHE)
    .map((name) => caches.delete(name)));
  await self.clients.claim();
})()));

async function readJSON(cache, path) {
  try { return await (await cache.match(path))?.json(); } catch { return null; }
}

async function getCatalog(version) {
  if (!version) return null;
  if (!catalogs.has(version)) {
    const meta = await caches.open(ASSET_CACHE_META);
    const catalog = await readJSON(meta, catalogPath(version));
    try { const checked = await verifyAssetCatalog(catalog); catalogs.set(version, { catalog: checked, urls: catalogURLMap(checked) }); }
    catch { return null; }
  }
  return catalogs.get(version);
}

async function getPin(clientId) {
  if (pins.has(clientId)) return pins.get(clientId);
  const meta = await caches.open(ASSET_CACHE_META);
  const pin = await readJSON(meta, pinPath(clientId));
  if (pin) pins.set(clientId, pin);
  return pin;
}

async function livePlaying() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const liveIDs = new Set(clients.map((client) => client.id));
  // A browser tab can disappear without a final page message. Do not let its playing pin
  // permanently block cache maintenance in all other tabs.
  for (const id of [...pins.keys()]) if (!liveIDs.has(id)) pins.delete(id);
  const states = await Promise.all(clients.map((client) => getPin(client.id)));
  return states.some((pin) => pin?.playing);
}

async function broadcast(message) {
  for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage(message);
}

const SYMBOLIC_CODE = /^ASSET_CACHE_[A-Z0-9_]+$/;

/**
 * A symbolic ASSET_CACHE_* code, else the storage bucket. The panel switches on these strings
 * (public/js/ui/assetCache.js cacheErrorText), so neither a DOMException's numeric legacy code (20 = AbortError)
 * nor free-form prose from the platform may be posted as `error`. This worker's own guards are thrown as bare
 * Errors carrying the code in `message` (`new Error('ASSET_CACHE_PLAYING')`), so the message is checked too.
 */
function symbolicCode(error) {
  for (const value of [error?.code, error?.message]) if (typeof value === 'string' && SYMBOLIC_CODE.test(value)) return value;
  return 'ASSET_CACHE_STORAGE_ERROR';
}

async function handleMessage(event) {
  const data = event.data;
  const source = event.source;
  if (!data || !source?.id || !event.ports?.[0]) return;
  const port = event.ports[0];
  try {
    // Opened inside the guard on purpose: metadata storage that fails (evicted origin, quota, an aborted
    // Cache Storage operation) must still be ANSWERED. Outside the guard handleMessage rejects, nothing is
    // posted on the port, and the page waits its full 10 s before reporting the worker unavailable instead
    // of the real code (public/js/assetCache.js swMessage -> ASSET_CACHE_SW_UNAVAILABLE on timeout).
    const meta = await caches.open(ASSET_CACHE_META);
    if (data.type === 'ASSET_CACHE_PIN') {
      const catalog = await verifyAssetCatalog(data.catalog);
      const previous = await getPin(source.id);
      // A live page cannot change its material interpretation mid-match.
      if (previous?.playing && previous.version && previous.version !== catalog.version) throw new Error('ASSET_CACHE_PLAYING');
      await meta.put(catalogPath(catalog.version), Response.json(catalog));
      await meta.put(latestPath, Response.json({ version: catalog.version }));
      catalogs.set(catalog.version, { catalog, urls: catalogURLMap(catalog) });
      // Only the explicit PLAYING message may clear this flag. A pending catalog adoption
      // must not downgrade a page that entered a match while storage was being written.
      const pin = { version: catalog.version, playing: !!previous?.playing || !!data.playing };
      await meta.put(pinPath(source.id), Response.json(pin)); pins.set(source.id, pin);
      port.postMessage({ ok: true });
    } else if (data.type === 'ASSET_CACHE_PLAYING') {
      const pin = await getPin(source.id) || { version: null };
      pin.playing = !!data.playing;
      await meta.put(pinPath(source.id), Response.json(pin)); pins.set(source.id, pin);
      const playing = await livePlaying();
      await broadcast({ type: 'ASSET_CACHE_PLAYING_CHANGED', playing });
      port.postMessage({ ok: true, playing });
    } else if (data.type === 'ASSET_CACHE_CAN_MUTATE') {
      port.postMessage({ ok: true, playing: await livePlaying() });
    } else if (data.type === 'ASSET_CACHE_CLEAR') {
      if (await livePlaying()) throw new Error('ASSET_CACHE_PLAYING');
      await caches.delete(ASSET_CACHE_NAME);
      await broadcast({ type: 'ASSET_CACHE_UPDATED' });
      port.postMessage({ ok: true });
    } else if (data.type === 'ASSET_CACHE_PRUNE') {
      if (await livePlaying()) throw new Error('ASSET_CACHE_PLAYING');
      const live = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const versions = new Set([(await readJSON(meta, latestPath))?.version]);
      for (const client of live) versions.add((await getPin(client.id))?.version);
      const keep = new Set();
      for (const version of versions) {
        const indexed = await getCatalog(version);
        for (const entry of indexed?.catalog.files || []) keep.add(origin + assetContentKey(entry.sha256));
      }
      const cache = await caches.open(ASSET_CACHE_NAME);
      for (const key of await cache.keys()) if (!keep.has(key.url)) await cache.delete(key);
      const livePins = new Set(live.map((client) => pinPath(client.id)));
      for (const key of await meta.keys()) {
        if (key.url.includes('/__sp_asset_cache__/pin/') && !livePins.has(key.url)) { await meta.delete(key); }
        if (key.url.includes('/__sp_asset_cache__/catalog/') && !versions.has(key.url.split('/').at(-1))) {
          await meta.delete(key); catalogs.delete(key.url.split('/').at(-1));
        }
      }
      for (const id of pins.keys()) if (!livePins.has(pinPath(id))) pins.delete(id);
      port.postMessage({ ok: true });
    } else throw new Error('ASSET_CACHE_BAD_MESSAGE');
  } catch (error) {
    // Only a symbolic ASSET_CACHE_* string is readable by the panel (public/js/ui/assetCache.js switches on
    // those); a DOMException carries a numeric legacy code instead (20 = AbortError), which must not leak.
    port.postMessage({ ok: false, error: symbolicCode(error) });
  }
}
self.addEventListener('message', (event) => {
  // Metadata writes are asynchronous. Preserve delivery order so PIN and PLAYING do not
  // race their reads/puts and silently lose either the pinned version or the match guard.
  messages = messages.then(() => handleMessage(event), () => handleMessage(event));
  event.waitUntil(messages);
});

async function notifyUpdate() {
  if (Date.now() - lastNotify < 1000) return;
  lastNotify = Date.now();
  await broadcast({ type: 'ASSET_CACHE_UPDATED' });
}

async function cachedResponse(response, entry, request) {
  const headers = new Headers(validatedCacheHeaders(entry));
  headers.set('Accept-Ranges', 'bytes');
  const range = request.headers.get('range');
  if (range) {
    const part = parseAssetRange(range, entry.bytes);
    if (!part) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${entry.bytes}` } });
    // A Range response is created from the full verified body; partial downloads never enter cache.
    const bytes = await response.arrayBuffer();
    headers.set('Content-Length', String(part.end - part.start + 1));
    headers.set('Content-Range', `bytes ${part.start}-${part.end}/${entry.bytes}`);
    return new Response(bytes.slice(part.start, part.end + 1), { status: 206, headers });
  }
  return new Response(response.body, { status: 200, headers });
}

async function fetchAsset(event, path) {
  try {
    const pin = await getPin(event.clientId);
    // A new document has fresh application data but has not declared its asset version yet.
    // Never serve another page's last catalog before it pins its own version after deployment.
    const indexed = await getCatalog(pin?.version);
    const entry = indexed?.urls.get(path);
    if (!entry) return fetch(event.request);
    const cache = await caches.open(ASSET_CACHE_NAME);
    const key = origin + assetContentKey(entry.sha256);
    const hit = await cache.match(key);
    if (isVerifiedAssetResponse(hit, entry)) return cachedResponse(hit, entry, event.request);
    const response = await fetch(event.request);
    // Ordinary gameplay remains immediate. Verification runs after returning the network response,
    // with a small concurrency ceiling so a model burst cannot create hundreds of buffered bodies.
    if (response.status === 200 && !event.request.headers.has('range') && passiveActive < 2) {
      const reported = Number(response.headers.get('content-length'));
      if (response.headers.has('content-encoding') || !reported || reported === entry.bytes) {
        passiveActive++;
        const copy = response.clone();
        event.waitUntil((async () => {
          try {
            const reader = copy.body.getReader();
            const body = new Uint8Array(entry.bytes);
            let offset = 0;
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                if (offset + chunk.value.length > entry.bytes) return;
                body.set(chunk.value, offset); offset += chunk.value.length;
              }
            } finally { await reader.cancel().catch(() => {}); }
            if (offset === entry.bytes && await sha256Hex(body) === entry.sha256) {
              const request = new Request(key, { headers: { 'X-SP-Asset-SHA256': entry.sha256, 'X-SP-Asset-Bytes': String(entry.bytes) } });
              // Passive fills share the mutation lock with import/verification/clear. Never
              // re-create cleared content or overwrite a verification result concurrently.
              await self.navigator.locks.request('sp-asset-cache-mutation', { ifAvailable: true }, async (lock) => {
                if (!lock) return;
                await cache.put(request, new Response(body, { headers: validatedCacheHeaders(entry) }));
                await notifyUpdate();
              });
            }
          } catch { /* Quota, unavailable disk and a stale server asset must not break gameplay. */ }
          finally { passiveActive--; }
        })());
      }
    }
    return response;
  } catch { return fetch(event.request); }
}

/** Answer one request from the imported pack: the exact key, no query, and never a cached network answer. */
async function serveImportedAsset(request) {
  const url = new URL(request.url);
  // The exact key: an import stores each URL without a query, so the path is the key. Matching with ignoreSearch would make
  // Chrome scan every entry — about 4 s per request once a whole pack (some 43,000 entries) is imported.
  const cache = await caches.open(IMPORTED_ASSET_CACHE);
  const hit = await cache.match(url.origin + url.pathname);
  if (hit) return hit;
  // Do not cache the network response. The browser's own HTTP cache still applies to this fetch.
  return fetch(request);
}

/** A GET for a URL this origin's imported pack stores, Range or not. shouldServeImportedAsset() refuses a Range
 * request itself (public/sw.js, still shipped, relies on that), so ask it about the URL alone. */
const importedAssetURL = (request) => shouldServeImportedAsset({ url: request.url, method: request.method }, origin);

/**
 * The sliced 206 of one stored imported response. The entry keeps its own Content-Type; only the length and the
 * range change. A partial body is built here and never written back to the cache. A range that is malformed or
 * unsatisfiable (start past the end, last before first, a non-numeric bound) is 416, as the catalog branch does.
 */
async function rangedImportedResponse(hit, range) {
  // The import stores decoded bytes, and only the whole body can be sliced: the same read the catalog branch does.
  const bytes = new Uint8Array(await hit.arrayBuffer());
  const part = parseAssetRange(range, bytes.byteLength);
  if (!part) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.byteLength}` } });
  const headers = new Headers(hit.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(part.end - part.start + 1));
  headers.set('Content-Range', `bytes ${part.start}-${part.end}/${bytes.byteLength}`);
  return new Response(bytes.slice(part.start, part.end + 1), { status: 206, headers });
}

/**
 * A Range request for a URL the imported pack stores. <audio>, <video> and WebAudio always send one, so audio the
 * player already imported would otherwise leave the origin on every play and every seek. A hit is answered as 206
 * from the cached bytes. A multi-part Range (a comma) is not sliced here at all and goes to the network, and a miss
 * stays with the catalog branch — which answers 206 from a verified sp-asset-cache-v1 entry or goes to the network —
 * so no byte this browser already holds is fetched again.
 */
async function serveRangedImportedAsset(event, path) {
  const request = event.request;
  if ((request.headers.get('range') || '').includes(',')) return fetch(request);
  const url = new URL(request.url);
  const cache = await caches.open(IMPORTED_ASSET_CACHE);
  const hit = await cache.match(url.origin + url.pathname);
  if (!hit) return path ? fetchAsset(event, path) : fetch(request);
  return rangedImportedResponse(hit, request.headers.get('range') || '');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  // A player who imported this origin's art must be served those bytes, so the imported pack wins.
  if (shouldServeImportedAsset(request, origin)) { event.respondWith(serveImportedAsset(request)); return; }
  const path = decodedAssetPath(request.url, origin);
  // The same art with a Range header: playback and seeking ask for a byte range every time, so answer from the
  // imported bytes instead of returning to the CDN for content the player already has. This asks about the URL
  // only (a pack may hold a type the catalog does not list, and the imported branch above serves it too). A
  // non-GET (HEAD) never reaches either branch, and no Range response is ever written to a cache (see fetchAsset).
  if (request.headers.has('range') && importedAssetURL(request)) {
    event.respondWith(serveRangedImportedAsset(event, path)); return;
  }
  if (path) event.respondWith(fetchAsset(event, path));
});
