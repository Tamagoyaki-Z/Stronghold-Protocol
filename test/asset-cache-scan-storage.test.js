// The live 「已缓存 0 / 19,599」 was a RECOUNT FAILURE PRESENTED AS FACT. public/js/asset-cache-worker.js enumerated
// the whole directory with one cache.keys(); a browser interrupts that operation on a large cache (AbortError,
// legacy numeric code 20), and the zeroed counts left behind by catalog adoption were never corrected — so a full
// 980 MB cache looked empty, 「缓存操作失败」 appeared, and the create fast path (net.js admission({fast:true}) ->
// server/lobby.js assetCacheAdmission) stopped certifying the player. These tests pin the replacement contract:
//   * a walk that throws, that returns 20,000 entries slowly, or that outlives its budget is DATA (partial/error),
//     never a thrown fatal error and never a rejection of the operation;
//   * a failed walk falls back to the last statistics completed (sp-asset-cache-meta-v1),
//   * it never reports 「all missing」 and never counts a partial walk as a count,
//   * a completed count answers the next scan WITHOUT walking the directory again,
//   * the coordinator keeps those numbers, reports 「统计不可用，但缓存仍在使用」 and keeps the fast path alive.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import * as helpers from '../shared/assetCache.js';
import { ASSET_CACHE_STATS_KEY, ASSET_CACHE_LATEST_KEY, assetCacheCatalogKey, assetCacheSummary,
  isAssetCacheStats } from '../shared/assetCache.js';
import { createAssetCacheManager } from '../public/js/assetCache.js';

const origin = 'https://scan.test';
// 40 ms in place of the shipped 8000 keeps the budget paths testable, exactly like the helpers import rewrite below.
const source = (await fs.readFile(new URL('../public/js/asset-cache-worker.js', import.meta.url), 'utf8'))
  .replace("const helpers = import('../../shared/assetCache.js');", 'const helpers = Promise.resolve(__helpers);')
  .replace('const SCAN_BUDGET_MS = 8000;', 'const SCAN_BUDGET_MS = 40;');

const encoder = new TextEncoder();
const bytesOf = (name) => encoder.encode(name + ' bytes');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const urlOf = (value) => (typeof value === 'string' ? value : value.url);

/** A catalog whose files are named, exactly what validateAssetCatalog/verifyAssetCatalog accept. */
function directory(names) {
  const files = names.map((name) => ({ url: '/assets/' + name, bytes: bytesOf(name).length,
    sha256: sha(bytesOf(name)), type: 'image/png', aliases: [] }));
  const catalog = { schema: 1, files, totalFiles: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), complete: true, missing: [] };
  catalog.version = sha(JSON.stringify({ schema: 1, files }));
  return catalog;
}

/** The statistics record the worker persists (shared/assetCache.js isAssetCacheStats). */
function statsRecord(catalog, readyFiles) {
  const ready = catalog.files.slice(0, readyFiles);
  return { schema: 1, version: catalog.version, totalFiles: catalog.totalFiles, totalBytes: catalog.totalBytes,
    readyFiles, readyBytes: ready.reduce((sum, file) => sum + file.bytes, 0),
    complete: readyFiles === catalog.totalFiles, at: 1 };
}

/**
 * The real Worker in a VM over a fake Cache Storage: `present` entries exist, `keysFailure` makes the walk throw
 * the way the browser interrupts it, `keyCount` answers with that many keys at once (the 20k case), `keysSlowMs`
 * delays the walk past its budget, `metaStats` seeds the statistics of a previous completed scan.
 */
function harness({ catalog, present = 0, keysFailure = null, keysSlowMs = 0, keyCount = 0, metaStats = null,
  metaUnavailable = false, clock = null } = {}) {
  const content = new Map(), metaStore = new Map(), calls = { keys: 0 };
  for (let index = 0; index < present; index++) {
    const entry = catalog.files[index];
    const url = origin + helpers.assetContentKey(entry.sha256);
    content.set(url, { request: new Request(url, { headers: { 'X-SP-Asset-SHA256': entry.sha256,
      'X-SP-Asset-Bytes': String(entry.bytes) } }),
      response: new Response(new Uint8Array(entry.bytes), { headers: helpers.validatedCacheHeaders(entry) }) });
  }
  if (metaStats) metaStore.set(origin + ASSET_CACHE_STATS_KEY, Response.json(metaStats));
  // Built once, outside the timed section: the walk's own cost must not be what a budget test measures.
  const bulk = keyCount ? Array.from({ length: keyCount }, (unused, index) => {
    const hash = index.toString(16).padStart(64, '0');
    const url = origin + helpers.assetContentKey(hash);
    return new Request(url, { headers: { 'X-SP-Asset-SHA256': hash, 'X-SP-Asset-Bytes': '1' } });
  }) : null;
  const contentStore = {
    async keys() {
      calls.keys++;
      if (keysSlowMs) await new Promise((done) => setTimeout(done, keysSlowMs));
      if (keysFailure) throw keysFailure;
      if (bulk) return bulk;
      return [...content.values()].map(({ request }) => request.clone());
    },
    async match(value) { return content.get(urlOf(value))?.response.clone(); },
    async put(request, response) { content.set(urlOf(request), { request: request.clone(), response: response.clone() }); },
    async delete(value) { return content.delete(urlOf(value)); },
  };
  const stores = { async open(name) {
    if (name !== helpers.ASSET_CACHE_META) return contentStore;
    if (metaUnavailable) throw new DOMException('metadata cache unavailable', 'AbortError');
    return {
      async match(value) { return metaStore.get(urlOf(value))?.clone(); },
      async put(request, response) { metaStore.set(urlOf(request), response.clone()); },
      async delete(value) { return metaStore.delete(urlOf(value)); },
    };
  } };
  const messages = [];
  const self = { location: { origin }, postMessage(message) { messages.push(message); } };
  const context = { self, importScripts() {}, zip: { configure() {}, Writer: class {} }, __helpers: helpers, caches: stores,
    fetch: async () => { throw new Error('a directory scan must not touch the network'); }, Blob, TextDecoder,
    TextEncoder, Uint8Array, Request, Response, AbortController, DOMException, performance, setTimeout, clearTimeout,
    Map, Set, Date: clock ? { now: clock } : Date };
  vm.runInContext(source, vm.createContext(context));
  let id = 0;
  const scan = async (extra = {}) => {
    const jobId = ++id;
    await self.onmessage({ data: { id: jobId, action: 'scan', catalog, ...extra } });
    const frames = messages.filter((message) => message.id === jobId);
    return { frames, error: frames.find((frame) => frame.type === 'error'),
      done: frames.find((frame) => frame.type === 'done'),
      last: frames.filter((frame) => frame.type === 'progress').at(-1),
      // The frame that carries the walk's own outcome; the final frame only repeats counts for the panel.
      walk: frames.filter((frame) => frame.type === 'progress' && frame.scanStats).at(-1) };
  };
  return { scan, calls, metaStore };
}

test('an interrupted walk is data: the scan still answers, claims no count, and never says 「all missing」', async () => {
  const catalog = directory(['a.png', 'b.png', 'c.png', 'd.png']);
  const w = harness({ catalog, present: 3, keysFailure: new DOMException('walk interrupted', 'AbortError') });
  const result = await w.scan();
  assert.equal(result.error, undefined, 'a walk the browser interrupts must not reject the operation');
  assert.ok(result.done, 'the page is answered with done, so the panel leaves 「正在检查缓存」');
  assert.equal(result.last.readyFiles, null, 'a count nobody could prove is claimed as null, not 0');
  assert.equal(result.last.missingFiles, null);
  assert.notEqual(result.last.missingFiles, catalog.totalFiles, 'a failed recount is never 「all missing」');
  assert.equal(result.last.countsKnown, false);
  assert.equal(result.last.statsUnavailable, true);
  assert.equal(result.walk.scanStats.error, 'ASSET_CACHE_STORAGE_ERROR');
  assert.equal(typeof result.walk.scanStats.error, 'string', 'the numeric DOMException code stays a symbolic one');
});

test('a failed walk falls back to the last completed statistics and names them as a fallback', async () => {
  const catalog = directory(['a.png', 'b.png', 'c.png', 'd.png']);
  const w = harness({ catalog, present: 3, keysFailure: new DOMException('walk interrupted', 'AbortError'),
    metaStats: statsRecord(catalog, 3) });
  const result = await w.scan();
  assert.equal(result.error, undefined);
  assert.equal(result.last.readyFiles, 3, 'the last count that completed stays the answer');
  assert.equal(result.last.missingFiles, 1, 'and the missing list is that one, not the whole directory');
  assert.equal(result.last.countsKnown, true);
  assert.equal(result.last.statsUnavailable, true, 'the panel is told these counts are a fallback');
});

test('a completed count answers the panel without walking the directory again', async () => {
  const catalog = directory(['a.png', 'b.png', 'c.png', 'd.png']);
  const w = harness({ catalog, present: 4, metaStats: statsRecord(catalog, 4) });
  const result = await w.scan();
  assert.equal(w.calls.keys, 0, 'the 19k-entry walk is skipped entirely when a count already exists');
  assert.equal(result.error, undefined);
  assert.equal(result.last.readyFiles, 4);
  assert.equal(result.last.missingFiles, 0);
  assert.equal(result.last.countsKnown, true);
  assert.equal(result.last.statsUnavailable, false);
});

test('a walk that does complete counts the directory and persists the count for the next failure', async () => {
  const catalog = directory(['a.png', 'b.png', 'c.png', 'd.png']);
  const w = harness({ catalog, present: 3 });
  const result = await w.scan();
  assert.equal(w.calls.keys, 1);
  assert.equal(result.last.readyFiles, 3);
  assert.equal(result.last.missingFiles, 1);
  assert.equal(result.last.countsKnown, true);
  assert.equal(result.last.statsUnavailable, false);
  const saved = await w.metaStore.get(origin + ASSET_CACHE_STATS_KEY).json();
  assert.ok(isAssetCacheStats(saved, catalog.version), 'the record is valid for this catalog version');
  assert.equal(saved.readyFiles, 3);
  assert.equal(saved.complete, false);
});

test('20,000 entries under a spent budget return a partial result instead of a fatal error', async () => {
  const catalog = directory(['a.png', 'b.png']);
  let ticks = 0;
  const w = harness({ catalog, keyCount: 20000, clock: () => 1000 + (++ticks) * 100 });
  const result = await w.scan();
  assert.equal(result.error, undefined, 'a spent budget is not a fatal scan failure');
  assert.ok(result.done);
  assert.equal(result.walk.scanStats.partial, true);
  assert.ok(result.walk.scanStats.checked >= 256, 'the walk yielded after whole chunks');
  assert.ok(result.walk.scanStats.checked < 20000, 'the budget stopped the walk');
  assert.equal(result.last.readyFiles, null, 'a partial walk claims no count');
  assert.notEqual(result.last.missingFiles, catalog.totalFiles);
});

test('a walk that outlives its budget is abandoned, not waited on and not thrown', async () => {
  const catalog = directory(['a.png']);
  const started = Date.now();
  const w = harness({ catalog, present: 1, keysSlowMs: 250 });
  const result = await w.scan();
  assert.equal(result.error, undefined);
  assert.equal(result.walk.scanStats.error, 'ASSET_CACHE_SCAN_TIMEOUT');
  assert.equal(result.last.readyFiles, null);
  assert.ok(Date.now() - started < 200, 'the scan does not wait out the walk it abandoned');
});

test('statistics storage being unavailable does not break the walk', async () => {
  const catalog = directory(['a.png', 'b.png']);
  const w = harness({ catalog, present: 1, metaUnavailable: true });
  const result = await w.scan();
  assert.equal(result.error, undefined);
  assert.equal(result.last.readyFiles, 1, 'the walk is still the answer when the statistics cache cannot open');
  assert.equal(result.last.countsKnown, true);
});

/** The coordinator over a fake page, a fake worker that CANNOT complete a scan, and a pinned catalog. */
function coordinator({ stats }) {
  const catalog = directory(['a.png', 'b.png', 'c.png', 'd.png']);
  const metadata = new Map([[origin + ASSET_CACHE_LATEST_KEY, { version: catalog.version }],
    [origin + assetCacheCatalogKey(catalog.version), catalog]]);
  if (stats) metadata.set(origin + ASSET_CACHE_STATS_KEY, stats);
  const warns = [], jobs = [];
  const sw = { postMessage(data, ports) {
    if (data.type === 'ASSET_CACHE_PIN') metadata.set(origin + ASSET_CACHE_LATEST_KEY, { version: data.catalog.version });
    ports[0].postMessage({ ok: true, playing: false });
  } };
  const environment = {
    isSecureContext: true, location: { origin }, crypto: globalThis.crypto, Blob, MessageChannel, AbortController,
    clearTimeout, setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
    caches: { async open() { return {
      async match(value) { const hit = metadata.get(urlOf(value)); return hit ? Response.json(hit).clone() : undefined; },
      async put() {}, async delete() { return true; },
    }; } },
    Worker: class {
      postMessage(message) {
        jobs.push(message);
        setTimeout(() => {
          // The live failure: the storage walk cannot be completed, and the worker answers with a symbolic code.
          if (message.action === 'scan') this.onmessage?.({ data: { id: message.id, type: 'error', code: 'ASSET_CACHE_STORAGE_ERROR' } });
          else this.onmessage?.({ data: { id: message.id, type: 'done' } });
        }, 0);
      }
      terminate() {}
    },
    console: { warn: (...args) => warns.push(args) },
    navigator: {
      serviceWorker: { controller: sw, ready: Promise.resolve({ active: sw }), register: async () => ({ active: sw }),
        addEventListener() {}, removeEventListener() {} },
      locks: { request: async (name, options, fn) => fn({}) },
      storage: { estimate: async () => ({ usage: 994.5 * 1048576, quota: 2 * 1048576 * 1024 }), persisted: async () => false },
    },
  };
  const manager = createAssetCacheManager({ environment, doFetch: async (url) => {
    if (url.includes('/api/asset-cache/status')) return Response.json({ ...assetCacheSummary(catalog), policy: { enabled: true } });
    return Response.json({ error: 'unexpected request' }, { status: 404 });
  } });
  return { manager, catalog, warns, jobs };
}

test('a scan the worker cannot complete keeps the last statistics, is no panel error, and keeps the fast create path', async () => {
  const catalog = directory(['a.png', 'b.png', 'c.png', 'd.png']);
  const f = coordinator({ stats: statsRecord(catalog, 4) });
  try {
    const state = await f.manager.initialize();
    assert.equal(f.jobs.some((job) => job.action === 'scan'), true, 'the panel still tries to recount');
    assert.equal(state.error, null, 'a recount failure is NOT 「缓存操作失败，已完成文件保留，请重试」');
    assert.equal(state.swError, null, 'and it is not 「素材预缓存未生效…将回源服务器」: the cache is still in use');
    assert.deepEqual(f.warns, [], 'no 回源 warning is raised for a failed recount');
    assert.equal(state.countsKnown, true, 'the last completed count is kept');
    assert.equal(state.statsUnavailable, true, 'and the panel is told it is a fallback (统计不可用，但缓存仍在使用)');
    assert.equal(state.readyFiles, 4, 'never 0');
    assert.equal(state.missingFiles, 0, 'never 「all 19,599 missing」');
    assert.equal(state.phase, 'ready');
    const report = await f.manager.admission({ fast: true });
    assert.deepEqual(report, { schema: 1, version: catalog.version, readyFiles: 4, readyBytes: catalog.totalBytes },
      'the create fast path keeps certifying from the last completed statistics');
  } finally { f.manager.destroy(); }
});

test('a first-ever scan failure reports the counts as unavailable instead of 0 / total', async () => {
  const f = coordinator({ stats: null });
  try {
    const state = await f.manager.initialize();
    assert.equal(state.error, null);
    assert.equal(state.countsKnown, false);
    assert.equal(state.statsUnavailable, true);
    assert.equal(state.readyFiles, null, 'a placeholder zero must not survive as a count');
    assert.equal(state.missingFiles, null, 'and it must not become 「all missing」 either');
    assert.equal(await f.manager.admission({ fast: true }), null, 'an unproven cache is still not certified to the server');
    assert.deepEqual(f.warns, []);
  } finally { f.manager.destroy(); }
});
