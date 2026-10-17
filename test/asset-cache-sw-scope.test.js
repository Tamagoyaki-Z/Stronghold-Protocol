// One origin, one Service Worker at scope '/'.
//
// Two registrations at one scope replace each other, and the page is then left with a worker that never answers
// the asset-cache coordinator: 0.3.0 shipped public/sw.js at scope '/' beside public/asset-cache-sw.js at scope
// '/', so 「检查更新与缺项」sat on 正在检查缓存 with 已缓存 0/0 and every button disabled. These tests pin the
// replacement contract: one script, one scope, and boot and the panel reach it through the same call site.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createAssetCacheManager } from '../public/js/assetCache.js';
import { ASSET_CACHE_SW_SCOPE, ASSET_CACHE_SW_URL, registerImportedAssetWorker } from '../public/js/importCache.js';

const root = new URL('../', import.meta.url);
const read = (rel) => fs.readFile(new URL(rel, root), 'utf8');
const countRegistrations = (source) => (source.match(/serviceWorker\.register\(/g) || []).length;

/** Every script the browser can execute from public/, so a new registration cannot hide in a helper. */
async function publicScripts(dir = new URL('public/', root), prefix = 'public/') {
  const found = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) {
      // public/vendor is third-party code and public/assets is art: neither is ours to police.
      if (entry.name === 'vendor' || entry.name === 'assets') continue;
      found.push(...await publicScripts(new URL(`${entry.name}/`, dir), `${rel}/`));
    } else if (rel.endsWith('.js') || rel.endsWith('.html')) found.push(rel);
  }
  return found;
}

/** A browser's registration table: one registration per scope, replaced in place by a different script URL. */
function fakeContainer() {
  const registrations = new Map();
  const calls = [];
  const serviceWorker = {
    controller: null,
    get ready() { return Promise.resolve([...registrations.values()][0]); },
    addEventListener() {}, removeEventListener() {},
    async register(url, options = {}) {
      const scope = options.scope ?? '/';
      calls.push({ url, scope, type: options.type || 'classic' });
      const registration = registrations.get(scope) || { scope, scriptURL: url, active: null, waiting: null };
      registration.scriptURL = url;
      registration.active = { scriptURL: url, postMessage() {} };
      registrations.set(scope, registration);
      serviceWorker.controller = registration.active;
      return registration;
    },
  };
  return { registrations, calls, serviceWorker };
}

test('the registered worker is one script whose scope covers every family it serves', () => {
  assert.equal(ASSET_CACHE_SW_URL, '/asset-cache-sw.js');
  assert.equal(ASSET_CACHE_SW_SCOPE, '/');
  // /assets/, /fonts/ and /media/ are siblings, so a narrower scope would silently drop fonts and audio.
  for (const url of ['/assets/model.atlas', '/fonts/ui.woff2', '/media/voice-line.ogg']) {
    assert.ok(url.startsWith(ASSET_CACHE_SW_SCOPE), `${url} would fall outside the worker scope`);
  }
});

test('boot and the panel share one registration call site, and no other file registers a worker', async () => {
  const [imports, panel] = await Promise.all([read('public/js/importCache.js'), read('public/js/assetCache.js')]);
  assert.equal(countRegistrations(imports), 1, 'the scope contract lives in one helper');
  assert.equal(countRegistrations(panel), 0, 'the panel must join boot\'s registration, not register its own');
  assert.match(imports, /register\(url, \{ scope: ASSET_CACHE_SW_SCOPE, type: 'module', updateViaCache: 'none' \}\)/);
  assert.match(panel, /swURL = ASSET_CACHE_SW_URL/);
  assert.match(panel, /registerAssetCacheWorker\(env\.navigator, swURL\)/);
  assert.doesNotMatch(panel, /scope: '\/'/);
  assert.doesNotMatch(panel, /'\/asset-cache-sw\.js'/);

  const hits = [];
  for (const rel of await publicScripts()) {
    const source = await read(rel);
    if (countRegistrations(source)) hits.push(rel);
  }
  assert.deepEqual(hits, ['public/js/importCache.js']);
  // The retired classic worker must stay unregistered: a comment in it says so, and no file may call it back.
  assert.equal(countRegistrations(await read('public/sw.js')), 0);
});

test('the merged worker serves the imported pack first and takes the scope over on install', async () => {
  const worker = await read('public/asset-cache-sw.js');
  assert.match(worker, /import \{ IMPORTED_ASSET_CACHE, IMPORTED_ASSET_CACHE_PREFIX, shouldServeImportedAsset \} from '\/js\/importCache\.js';/);
  // Without skipWaiting, a page still controlled by the retired /sw.js would keep it forever (a waiting worker
  // only activates once every tab closes), and the coordinator's messages would keep going unanswered.
  assert.match(worker, /self\.addEventListener\('install', \(event\) => event\.waitUntil\(self\.skipWaiting\(\)\)\)/);
  assert.match(worker, /cache\.match\(url\.origin \+ url\.pathname\)/);
  const handler = worker.slice(worker.indexOf("self.addEventListener('fetch'"));
  assert.ok(handler.indexOf('shouldServeImportedAsset(request, origin)') < handler.indexOf('decodedAssetPath(request.url, origin)'),
    'an imported asset must be served before the catalog branch');
});

test('after boot and the panel register, one worker at scope / controls the page', async () => {
  const { registrations, calls, serviceWorker } = fakeContainer();
  const environment = {
    isSecureContext: true,
    location: { origin: 'https://game.test' },
    crypto: globalThis.crypto,
    MessageChannel,
    AbortController,
    caches: { open: async () => ({ match: async () => undefined }) },
    Worker: class { postMessage() {} terminate() {} },
    fetch: async () => { throw new Error('offline'); },
    // A worker that never answers rejects after 10-15 s in a browser; here the assertion is the registration.
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
    clearTimeout,
    navigator: { serviceWorker, locks: { request: async (_name, _options, fn) => fn({}) } },
  };

  assert.equal(await registerImportedAssetWorker({ serviceWorker }, true), true);
  const manager = createAssetCacheManager({ environment });
  await manager.initialize();

  assert.equal(registrations.size, 1, 'exactly one registration exists');
  assert.equal([...registrations.values()][0].scriptURL, ASSET_CACHE_SW_URL);
  assert.equal(serviceWorker.controller.scriptURL, ASSET_CACHE_SW_URL, 'the controlling worker is the pre-cache one');
  assert.deepEqual([...new Set(calls.map((call) => `${call.url} ${call.scope} ${call.type}`))],
    [`${ASSET_CACHE_SW_URL} ${ASSET_CACHE_SW_SCOPE} module`]);
});

test('a second script at one scope takes it over — the mechanism that hung the panel', async () => {
  const { registrations, serviceWorker } = fakeContainer();
  await serviceWorker.register('/asset-cache-sw.js', { scope: '/' });
  await serviceWorker.register('/sw.js', { scope: '/' });
  assert.equal(registrations.size, 1, 'a browser keeps one registration per scope');
  assert.equal(serviceWorker.controller.scriptURL, '/sw.js', 'the later script owns the scope and the pre-cache worker no longer controls the page');
});
