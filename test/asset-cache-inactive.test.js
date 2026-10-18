// A worker or pin failure used to vanish: boot ignored the registration result (main.js) and the panel's recheck
// catch was empty. The page then read every asset from the CDN while the panel looked healthy, which is how the
// whole directory cache could be dead without anyone noticing. These tests pin the replacement contract — one
// console.warn per page, carrying the code, plus that code readable in the state the panel already renders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSET_CACHE_LATEST_KEY, assetCacheCatalogKey, sha256Hex, verifyAssetCatalog } from '../shared/assetCache.js';
import { registerImportedAssetWorker } from '../public/js/importCache.js';
import { createAssetCacheManager } from '../public/js/assetCache.js';

const origin = 'https://game.test';
const warns = [];

/** One origin, no worker that ever answers, and a collector for what the manager would put on the console. */
function environment(overrides = {}) {
  return {
    isSecureContext: true,
    location: { origin },
    crypto: globalThis.crypto,
    MessageChannel, AbortController, clearTimeout,
    // A worker that never answers rejects with its code in a browser too; clamp the wait like the other fixtures.
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
    caches: { open: async () => ({ match: async () => undefined, put: async () => {} }) },
    Worker: class { postMessage() {} terminate() {} },
    fetch: async () => { throw new Error('offline'); },
    console: { warn: (...args) => warns.push(args) },
    navigator: { serviceWorker: { controller: null, addEventListener() {}, removeEventListener() {},
      register: () => new Promise(() => {}), get ready() { return new Promise(() => {}) } },
    locks: { request: async (_name, _options, fn) => fn({}) } },
    ...overrides,
  };
}

test('a boot registration failure is warned once with its code instead of vanishing', async () => {
  const original = console.warn;
  const boot = [];
  console.warn = (...args) => boot.push(args);
  try {
    const registered = await registerImportedAssetWorker(
      { serviceWorker: { register: () => Promise.reject(new Error('blocked')) } }, true);
    assert.equal(registered, false, 'boot still proceeds without a worker');
  } finally { console.warn = original; }
  assert.equal(boot.length, 1, 'the failure is no longer silent');
  assert.equal(boot[0][0].includes('ASSET_CACHE_SW_UNAVAILABLE'), true, 'the warning carries the code');
});

test('a worker failure stays readable in the state and does not warn twice for one page', async () => {
  const manager = createAssetCacheManager({ environment: environment() });
  const state = await manager.initialize();
  assert.equal(state.swError, 'ASSET_CACHE_SW_UNAVAILABLE', 'the code the page can read back');
  assert.equal(state.error, 'ASSET_CACHE_SW_UNAVAILABLE', 'the panel already renders state.error');
  assert.equal(state.phase, 'error');
  // The once-per-page flag is in importCache.js, so the boot failure above already spent the single warning:
  // these assertions hold in either order of the two failures, and only fail if a warn is repeated per call site.
  assert.deepEqual(warns, []);
});

test('a pin the worker never accepts is not silent: the code stays in the state', async () => {
  const body = new TextEncoder().encode('atlas bytes');
  const file = { url: '/assets/model.atlas', bytes: body.length, sha256: await sha256Hex(body), type: 'text/plain', aliases: [] };
  const catalog = { schema: 1, files: [file], totalFiles: 1, totalBytes: body.length, complete: true, missing: [], app: 'test',
    version: await sha256Hex(new TextEncoder().encode(JSON.stringify({ schema: 1, files: [file] }))) };
  await verifyAssetCatalog(catalog);
  const meta = new Map([[origin + ASSET_CACHE_LATEST_KEY, Response.json({ version: catalog.version })],
    [origin + assetCacheCatalogKey(catalog.version), Response.json(catalog)]]);
  const panelEnv = environment({
    caches: { open: async () => ({
      async match(key) { return meta.get(typeof key === 'string' ? key : key.url)?.clone(); },
      async put() {},
    }) },
  });
  // A worker that registers and becomes ready, then never answers ASSET_CACHE_PIN: the local catalog is not pinned.
  panelEnv.navigator = { ...panelEnv.navigator, serviceWorker: {
    controller: null, addEventListener() {}, removeEventListener() {},
    register: async (url, options) => ({ scope: options?.scope, scriptURL: url, active: { scriptURL: url, postMessage() {} } }),
    get ready() { return Promise.resolve({ active: { postMessage() {} } }); },
  } };
  const manager = createAssetCacheManager({ environment: panelEnv });
  const state = await manager.initialize();
  assert.equal(state.swError, 'ASSET_CACHE_SW_UNAVAILABLE');
  assert.equal(state.error, 'ASSET_CACHE_SW_UNAVAILABLE', 'an unanswered pin no longer looks like a healthy cache');
  assert.equal(state.hasCatalog, false, 'the pin did not take');
});
