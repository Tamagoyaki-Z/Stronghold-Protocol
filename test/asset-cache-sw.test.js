import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as helpers from '../shared/assetCache.js';
import * as importHelpers from '../public/js/importCache.js';

const origin = 'https://game.test';
const body = new TextEncoder().encode('atlas bytes');
const sha256 = await helpers.sha256Hex(body);
const entry = { url: '/assets/model.atlas', bytes: body.length, sha256, type: 'text/plain', aliases: [] };
const catalog = { schema: 1, version: await helpers.sha256Hex(new TextEncoder().encode(JSON.stringify({ schema: 1, files: [entry] }))), files: [entry], totalFiles: 1, totalBytes: body.length,
  complete: true, missing: [], app: 'test' };
const source = (await fs.readFile(new URL('../public/asset-cache-sw.js', import.meta.url), 'utf8'))
  .replace(/import \{[\s\S]*?\} from '[^']+';/g, '');

async function fixture({ slowMetadata = false, blockPassive = false } = {}) {
  const handlers = new Map(), stores = new Map(), windows = new Map();
  let network = 0, locks = 0;
  const storage = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const records = stores.get(name);
      return {
        async match(value) { return records.get(typeof value === 'string' ? value : value.url)?.response.clone(); },
        async put(value, response) {
          if (slowMetadata && name === helpers.ASSET_CACHE_META) await new Promise((resolve) => setTimeout(resolve, 2));
          const request = typeof value === 'string' ? new Request(value) : value.clone();
          records.set(request.url, { request, response: response.clone() });
        },
        async keys() { return [...records.values()].map((record) => record.request.clone()); },
        async delete(value) { return records.delete(typeof value === 'string' ? value : value.url); },
      };
    },
    async delete(name) { return stores.delete(name); },
  };
  const clients = { async matchAll() { return [...windows.values()]; }, async claim() {} };
  const self = { location: { origin }, clients, skipWaiting: async () => {}, navigator: { locks: { async request(_name, _options, fn) {
    locks++; return fn(blockPassive ? null : {});
  } } }, addEventListener(name, callback) { handlers.set(name, callback); } };
  const context = vm.createContext({ ...helpers, ...importHelpers, self, caches: storage, fetch: async () => {
    network++;
    // Fetch returns decoded bytes, while Content-Length still describes the compressed wire body.
    return new Response(body, { headers: { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip', 'Content-Length': '7' } });
  }, Request, Response, Headers, URL, Uint8Array, crypto: globalThis.crypto, Date, Promise, Map, Set });
  vm.runInContext(source, context);
  const addClient = (id) => windows.set(id, { id, postMessage() {} });
  const message = (id, data) => new Promise((resolve, reject) => {
    handlers.get('message')({ source: windows.get(id), data, ports: [{ postMessage: resolve }],
      waitUntil(promise) { promise.catch(reject); } });
  });
  const fetchFile = async (id, request = new Request(origin + entry.url)) => {
    const waits = []; let result;
    handlers.get('fetch')({ clientId: id, request,
      respondWith(promise) { result = promise; }, waitUntil(promise) { waits.push(promise); } });
    const response = await result;
    await Promise.all(waits);
    return response;
  };
  return { addClient, message, fetchFile, storage, network: () => network, locks: () => locks };
}

test('SW uses the ordinary network until this document pins its own catalog, even if old verified cache exists', async () => {
  const f = await fixture(); f.addClient('old'); f.addClient('new');
  await f.message('old', { type: 'ASSET_CACHE_PIN', catalog });
  const cache = await f.storage.open(helpers.ASSET_CACHE_NAME);
  await cache.put(origin + helpers.assetContentKey(sha256), new Response('old-cache!!', { headers: helpers.validatedCacheHeaders(entry) }));
  assert.equal(await (await f.fetchFile('new')).text(), 'atlas bytes');
  assert.equal(f.network(), 1, 'new document must not inherit the old page catalog');
  assert.equal(await (await f.fetchFile('old')).text(), 'old-cache!!');
  assert.equal(f.network(), 1);
});

test('SW passive caching verifies decoded gzip bytes and respects the shared mutation lock', async () => {
  const f = await fixture(); f.addClient('page');
  await f.message('page', { type: 'ASSET_CACHE_PIN', catalog });
  assert.equal(await (await f.fetchFile('page')).text(), 'atlas bytes');
  assert.equal(f.network(), 1); assert.equal(f.locks(), 1);
  assert.equal(await (await f.fetchFile('page')).text(), 'atlas bytes');
  assert.equal(f.network(), 1, 'gzip body was validated and cached locally');
  const blocked = await fixture({ blockPassive: true }); blocked.addClient('page');
  await blocked.message('page', { type: 'ASSET_CACHE_PIN', catalog });
  await blocked.fetchFile('page'); await blocked.fetchFile('page');
  assert.equal(blocked.network(), 2, 'clear/import/deep scan lock prevents competing passive writes');
});

test('SW serializes pin/playing writes and never lets a late same-version pin clear the live match flag', async () => {
  const f = await fixture({ slowMetadata: true }); f.addClient('page');
  const pinned = f.message('page', { type: 'ASSET_CACHE_PIN', catalog, playing: false });
  const entered = f.message('page', { type: 'ASSET_CACHE_PLAYING', playing: true });
  assert.equal((await pinned).ok, true); assert.equal((await entered).playing, true);
  assert.equal((await f.message('page', { type: 'ASSET_CACHE_PIN', catalog, playing: false })).ok, true);
  assert.equal((await f.message('page', { type: 'ASSET_CACHE_CAN_MUTATE' })).playing, true);
  assert.equal((await f.message('page', { type: 'ASSET_CACHE_CLEAR' })).error, 'ASSET_CACHE_PLAYING');
});

test('SW allows the first verified pin during direct reconnect, but refuses directory changes during a live match', async () => {
  const f = await fixture(); f.addClient('page');
  assert.equal((await f.message('page', { type: 'ASSET_CACHE_PLAYING', playing: true })).playing, true);
  assert.equal((await f.message('page', { type: 'ASSET_CACHE_PIN', catalog })).ok, true);
  const changed = structuredClone(catalog);
  changed.files[0].url = '/assets/other.atlas';
  changed.version = await helpers.sha256Hex(new TextEncoder().encode(JSON.stringify({ schema: 1, files: changed.files })));
  assert.equal((await f.message('page', { type: 'ASSET_CACHE_PIN', catalog: changed })).error, 'ASSET_CACHE_PLAYING');
  assert.equal((await f.message('page', { type: 'ASSET_CACHE_CAN_MUTATE' })).playing, true);
});

// <audio>, <video> and WebAudio send a Range on every play and every seek, so the imported pack must be able to
// answer one from its own bytes: the player already holds 12,637 mp3 files that would otherwise return from the
// CDN on every playback. The catalog branch is a separate generator and keeps its own verified response path.
const importedPath = '/media/~0123456789abcdef/audio/bgm/a';
const importedURL = origin + importedPath;
const importedBody = new TextEncoder().encode('x'.repeat(200));
const rangeRequest = (url, range) => new Request(url, range ? { headers: { Range: range } } : undefined);

async function importedFixture() {
  const f = await fixture();
  f.addClient('page');
  const cache = await f.storage.open(importHelpers.IMPORTED_ASSET_CACHE);
  await cache.put(importedURL, new Response(importedBody, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }));
  return f;
}

test('SW slices a single-part Range for an imported pack hit into 206 from the cached bytes', async () => {
  const f = await importedFixture();
  const response = await f.fetchFile('page', rangeRequest(importedURL, 'bytes=0-99'));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-99/200');
  assert.equal(response.headers.get('content-length'), '100');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-type'), 'audio/mpeg', 'the stored Content-Type is kept');
  assert.equal(await response.text(), 'x'.repeat(100));
  assert.equal(f.network(), 0, 'an imported hit never reaches the network');
});

test('SW answers an imported hit without a Range with the whole stored body', async () => {
  const f = await importedFixture();
  const response = await f.fetchFile('page', rangeRequest(importedURL));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-range'), null);
  assert.equal(await response.text(), 'x'.repeat(200));
  assert.equal(f.network(), 0);
});

test('SW leaves a Range for an imported miss to the network instead of synthesizing one', async () => {
  const f = await importedFixture();
  const response = await f.fetchFile('page', rangeRequest(`${origin}/media/~0123456789abcdef/audio/bgm/miss`, 'bytes=0-99'));
  assert.equal(response.status, 200, 'nothing is invented for a URL the pack does not hold');
  assert.equal(response.headers.get('content-range'), null);
  assert.equal(f.network(), 1);
});

test('SW answers an unsatisfiable or malformed imported Range with 416 and the stored length', async () => {
  const f = await importedFixture();
  const past = await f.fetchFile('page', rangeRequest(importedURL, 'bytes=500-'));
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), 'bytes */200');
  assert.equal((await f.fetchFile('page', rangeRequest(importedURL, 'bytes=9-4'))).status, 416);
  assert.equal((await f.fetchFile('page', rangeRequest(importedURL, 'bytes=abc-def'))).status, 416);
  assert.equal(f.network(), 0, 'a stored file is never fetched just to reject a bad range');
});

test('SW sends a multi-part Range to the network even on an imported hit and caches no partial body', async () => {
  const f = await importedFixture();
  const response = await f.fetchFile('page', rangeRequest(importedURL, 'bytes=0-9,20-29'));
  assert.equal(response.status, 200, 'a multi-part Range is not sliced here');
  assert.equal(response.headers.get('content-range'), null);
  assert.equal(f.network(), 1);
  const imported = await f.storage.open(importHelpers.IMPORTED_ASSET_CACHE);
  assert.deepEqual((await imported.keys()).map((key) => key.url), [importedURL], 'no partial response entered the import cache');
  const verified = await f.storage.open(helpers.ASSET_CACHE_NAME);
  assert.deepEqual(await verified.keys(), [], 'a Range response never enters the verified content cache');
});

test('SW slices a Range for an imported type the catalog cannot list, not only audio under /media/', async () => {
  const f = await fixture(); f.addClient('page');
  const videoURL = `${origin}/assets/~0123456789abcdef/video/clip.mp4`;
  const cache = await f.storage.open(importHelpers.IMPORTED_ASSET_CACHE);
  await cache.put(videoURL, new Response(importedBody, { status: 200, headers: { 'Content-Type': 'video/mp4' } }));
  // The catalog's own allowlist has no video suffix, so decodedAssetPath() refuses this URL: only the imported
  // branch can answer it, and it must answer a Range as well as a plain GET.
  assert.equal(helpers.decodedAssetPath(videoURL, origin), null);
  const response = await f.fetchFile('page', rangeRequest(videoURL, 'bytes=10-19'));
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 10-19/200');
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(await response.text(), 'x'.repeat(10));
  assert.equal(f.network(), 0);
});
