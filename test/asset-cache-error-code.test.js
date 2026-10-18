// The panel switches on symbolic ASSET_CACHE_* codes (public/js/ui/assetCache.js cacheErrorText). Two ways that
// contract was broken, both reproduced by the live "素材预缓存未生效" warning:
//
//  1. handleMessage opened the metadata cache OUTSIDE its try, so a Cache Storage failure rejected the handler:
//     nothing was posted on the port and the page sat out its full 10 s before reporting
//     ASSET_CACHE_SW_UNAVAILABLE — the real cause was never named.
//  2. asset-cache-worker.js forwarded `error.code` verbatim. A DOMException carries a NUMERIC legacy code
//     (20 = AbortError), so a scan failure reached the page as `assetCacheError(20)` and printed
//     `[asset-cache] 20: 素材预缓存未生效…` — a code no consumer can read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import * as helpers from '../shared/assetCache.js';
import * as importHelpers from '../public/js/importCache.js';

const origin = 'https://game.test';
const source = (await fs.readFile(new URL('../public/asset-cache-sw.js', import.meta.url), 'utf8'))
  .replace(/import \{[\s\S]*?\} from '[^']+';/g, '');

/** One origin whose metadata cache cannot be opened at all, and a client that records port replies. */
function fixture() {
  const handlers = new Map();
  const clients = new Map([[ 'page', { id: 'page', postMessage() {} } ]]);
  const storage = {
    async open() { throw new DOMException('storage unavailable', 'AbortError'); },
    async delete() { return true; },
  };
  const self = { location: { origin }, clients: { async matchAll() { return [...clients.values()]; }, async claim() {} },
    skipWaiting: async () => {}, navigator: { locks: { async request(_n, _o, fn) { return fn({}); } } },
    addEventListener(name, callback) { handlers.set(name, callback); } };
  const context = vm.createContext({ ...helpers, ...importHelpers, self, caches: storage,
    fetch: async () => new Response(null), Request, Response, Headers, URL, Uint8Array,
    crypto: globalThis.crypto, Date, Promise, Map, Set, DOMException });
  vm.runInContext(source, context);
  return {
    message: (data) => new Promise((resolve) => {
      const replies = [], waits = [];
      handlers.get('message')({ source: clients.get('page'), data, ports: [{ postMessage: (m) => replies.push(m) }],
        waitUntil(promise) { waits.push(promise); } });
      const done = () => setTimeout(() => resolve({ replies, waits }), 20);
      Promise.allSettled(waits).then(done, done);
    }),
  };
}

test('metadata storage failure still answers every message, with a symbolic code and not a numeric one', async () => {
  const f = fixture();
  for (const type of ['ASSET_CACHE_CAN_MUTATE', 'ASSET_CACHE_PLAYING', 'ASSET_CACHE_PRUNE', 'ASSET_CACHE_CLEAR']) {
    const { replies, waits } = await f.message({ type });
    assert.equal(replies.length, 1, `${type} must be answered exactly once, never left to the page's 10s timeout`);
    assert.equal(replies[0].ok, false);
    assert.equal(replies[0].error, 'ASSET_CACHE_STORAGE_ERROR', 'a DOMException stays inside the storage bucket');
    assert.equal(typeof replies[0].error, 'string', 'the page switches on strings; a number is unreadable');
    assert.equal(waits.length, 1, 'the async reply is kept alive with waitUntil');
  }
});

test('the worker never forwards a DOMException numeric code to the page', async () => {
  const worker = await fs.readFile(new URL('../public/js/asset-cache-worker.js', import.meta.url), 'utf8');
  // A DOMException's numeric legacy code (20 = AbortError, 22 = QuotaExceededError) is not a page code. The old
  // send read `error.code || 'ASSET_CACHE_STORAGE_ERROR'`, and `20` is truthy, so it went out verbatim.
  assert.match(worker, /storageCode\(error\)/, 'the error code goes through the symbolic-code guard');
  // Only the send() fallback is the defect; `if (error.code || error.name === …) throw error` elsewhere in
  // work() is a legitimate rethrow test and must stay.
  assert.doesNotMatch(worker, /:\s*error\.code\s*\|\|/, 'a raw error.code must not reach send()');
});
