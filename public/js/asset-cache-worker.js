// The ZIP stays a File/Blob. Only one bounded entry is decompressed and hashed at a time.
// Disk IO, downloads, deep verification and ZIP work all run off the UI thread.
importScripts('/vendor/zip-native.min.js');
zip.configure({ useWebWorkers: false });
const helpers = import('../../shared/assetCache.js');
let active = null;

function cancelled() {
  if (active?.paused) throw Object.assign(new Error('ASSET_CACHE_PAUSED'), { code: 'ASSET_CACHE_PAUSED' });
}
const send = (id, type, value = {}) => self.postMessage({ id, type, ...value });

/** Only a bounded explicit response identifies why an online transfer was refused. */
async function unavailableCode(response) {
  if (!response.body) return 'ASSET_CACHE_DOWNLOAD_FAILED';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      cancelled();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) return 'ASSET_CACHE_DOWNLOAD_FAILED';
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const code = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))?.error;
    if (code === 'ASSET_CACHE_EMERGENCY' || code === 'SERVER_EMERGENCY') return 'ASSET_CACHE_EMERGENCY';
    return code === 'ASSET_CACHE_ONLINE_DISABLED' ? code : 'ASSET_CACHE_DOWNLOAD_FAILED';
  } catch { return 'ASSET_CACHE_DOWNLOAD_FAILED'; }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

class LimitedWriter extends zip.Writer {
  constructor(limit) { super(); this.limit = limit; this.chunks = []; this.length = 0; }
  writeUint8Array(chunk) {
    cancelled();
    if (this.length + chunk.length > this.limit) {
      throw Object.assign(new Error('ASSET_CACHE_FILE_TOO_LARGE'), { code: 'ASSET_CACHE_FILE_TOO_LARGE' });
    }
    this.chunks.push(chunk); this.length += chunk.length;
  }
  getData() { return new Blob(this.chunks); }
}

async function archiveEntries(reader, h) {
  const entries = [], seen = new Set();
  for await (const entry of reader.getEntriesGenerator()) {
    cancelled();
    if (entries.length >= h.MAX_CATALOG_FILES * 2) throw h.assetCacheError('ASSET_CACHE_ZIP_TOO_LARGE');
    if (!h.safeAssetZipName(entry.filename) || entry.encrypted || entry.symlink || entry.executable || seen.has(entry.filename)) {
      throw h.assetCacheError('ASSET_CACHE_ZIP_UNSAFE');
    }
    seen.add(entry.filename); entries.push(entry);
  }
  return entries;
}

async function readCatalog(message, h) {
  if (!(message.file instanceof Blob)) throw h.assetCacheError('ASSET_CACHE_BAD_CATALOG');
  let blob = message.file;
  let reader;
  try {
    if (message.format === 'zip') {
      reader = new zip.ZipReader(new zip.BlobReader(blob), { useWebWorkers: false, checkSignature: true });
      const entries = await archiveEntries(reader, h);
      const entry = entries.find((item) => !item.directory && item.filename === 'manifest.json');
      if (!entry) throw h.assetCacheError('ASSET_CACHE_CATALOG_REQUIRED');
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 1
        || entry.uncompressedSize > h.MAX_MANIFEST_BYTES || ![0, 8].includes(entry.compressionMethod)) {
        throw h.assetCacheError('ASSET_CACHE_BAD_CATALOG');
      }
      blob = await entry.getData(new LimitedWriter(h.MAX_MANIFEST_BYTES), { useWebWorkers: false, checkSignature: true,
        signal: active.abort.signal });
    } else if (message.format !== 'json') throw h.assetCacheError('ASSET_CACHE_BAD_MESSAGE');
    if (blob.size < 1 || blob.size > h.MAX_MANIFEST_BYTES) throw h.assetCacheError('ASSET_CACHE_BAD_CATALOG');
    const bytes = await blob.arrayBuffer();
    cancelled();
    const catalog = await h.verifyAssetCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    cancelled();
    return { catalog };
  } catch (error) {
    if (error.code) throw error;
    throw h.assetCacheError(message.format === 'zip' ? 'ASSET_CACHE_ZIP_INVALID' : 'ASSET_CACHE_BAD_CATALOG', error);
  } finally { await reader?.close(); }
}

// One whole-directory walk materialises a Request per stored file and is the operation a browser interrupts on a
// large cache (AbortError, legacy numeric code 20). The walk below is bounded, chunked and fallible as DATA: a
// recount that cannot be completed keeps the last count that was (ASSET_CACHE_STATS_KEY) and reports the counts as
// unavailable instead of 「0 cached」, which is how one interrupted walk turned a full 980 MB cache into
// 「已缓存 0 / 19,599」 and switched the create fast path off.
const SCAN_BUDGET_MS = 8000;
const SCAN_CHUNK = 256;
const SCAN_SAMPLE = 16;

function withDeadline(promise, ms, code) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(code), { code })), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

const yieldThread = () => new Promise((done) => setTimeout(done, 0));

async function work(message) {
  const h = await helpers;
  if (message.action === 'read-catalog') return readCatalog(message, h);
  const catalog = h.validateAssetCatalog(message.catalog);
  const origin = self.location.origin;
  const cache = await caches.open(h.ASSET_CACHE_NAME);
  // Statistics are an optimisation, not evidence: their cache failing must not fail the scan that reads it.
  let meta = null;
  try { meta = await caches.open(h.ASSET_CACHE_META); } catch { meta = null; }
  const hashes = new Map();
  // `presence` describes the last walk ({ partial, error, scanned }); `stats` is the last count that completed and
  // is the fallback whenever a later walk cannot be.
  let presence = null, stats = null;
  const ready = (entry) => hashes.get(entry.sha256) === entry.bytes;
  const counted = () => {
    let readyFiles = 0, readyBytes = 0;
    for (const entry of catalog.files) if (ready(entry)) { readyFiles++; readyBytes += entry.bytes; }
    return { readyFiles, readyBytes, missingFiles: catalog.totalFiles - readyFiles, missingBytes: catalog.totalBytes - readyBytes };
  };
  const recalled = () => ({ readyFiles: stats.readyFiles, readyBytes: stats.readyBytes,
    missingFiles: Math.max(0, catalog.totalFiles - stats.readyFiles), missingBytes: Math.max(0, catalog.totalBytes - stats.readyBytes) });
  const exact = () => !!presence && !presence.partial && !presence.error;
  // 「the last recount did not complete」, so every frame agrees with the frame that reported the failure.
  const walkFailed = () => !!presence && (presence.partial || !!presence.error);
  /** Every progress frame carries the counts AND their provenance. A partial or failed walk falls back to the last
   *  completed count; with none the counts are null (countsKnown false), never 0. */
  const counts = () => {
    if (exact()) return { ...counted(), countsKnown: true, statsUnavailable: false };
    if (stats) return { ...recalled(), countsKnown: true, statsAt: stats.at, statsSource: 'metadata',
      statsUnavailable: walkFailed() };
    return { readyFiles: null, readyBytes: null, missingFiles: null, missingBytes: null,
      countsKnown: false, statsUnavailable: true, statsAt: 0, statsSource: null };
  };
  const report = (extra = {}) => send(message.id, 'progress', { ...counts(), ...extra });
  const readStats = async () => {
    if (!meta) return null;
    try {
      const value = await (await meta.match(origin + h.ASSET_CACHE_STATS_KEY))?.json();
      return h.isAssetCacheStats(value, catalog.version) && value.totalFiles === catalog.totalFiles
        && value.totalBytes === catalog.totalBytes ? value : null;
    } catch { return null; }
  };
  /** Only a walk that counted every entry may become the fallback for the next failure; returns that record. */
  const writeStats = async () => {
    if (!meta || !exact()) return null;
    const { readyFiles, readyBytes } = counted();
    const record = { schema: h.CACHE_SCHEMA, version: catalog.version, totalFiles: catalog.totalFiles,
      totalBytes: catalog.totalBytes, readyFiles, readyBytes,
      complete: readyFiles === catalog.totalFiles && readyBytes === catalog.totalBytes, at: Date.now() };
    try { await meta.put(new Request(origin + h.ASSET_CACHE_STATS_KEY), Response.json(record)); }
    catch { return null; }
    return record;
  };
  /** What a bounded walk managed to prove. A storage failure or a budget overrun is a value here, never a throw. */
  const enumerate = async (budgetMs) => {
    const deadline = Date.now() + budgetMs;
    const result = { partial: false, error: null, scanned: 0 };
    let keys;
    try { keys = await withDeadline(cache.keys(), budgetMs, 'ASSET_CACHE_SCAN_TIMEOUT'); }
    catch (error) { result.error = storageCode(error); return result; }
    for (const key of keys) {
      const hash = key.headers.get('x-sp-asset-sha256');
      if (/^[a-f0-9]{64}$/.test(hash || '') && key.url === origin + h.assetContentKey(hash)) {
        hashes.set(hash, Number(key.headers.get('x-sp-asset-bytes')));
      }
      result.scanned++;
      if (result.scanned % SCAN_CHUNK === 0) {
        await yieldThread();
        if (Date.now() > deadline) { result.partial = true; break; }
      }
    }
    return result;
  };
  /** Bounded probe over entries spread across the catalog: recalled statistics are only trusted while the pinned
   *  directory still holds those bytes, so an eviction or a clear is noticed without a full walk. */
  const sampleIntact = async () => {
    const total = catalog.files.length;
    if (!total) return false;
    const step = Math.max(1, Math.floor(total / SCAN_SAMPLE));
    for (let index = 0; index < total; index += step) {
      const entry = catalog.files[index];
      const hit = await cache.match(origin + h.assetContentKey(entry.sha256));
      if (!h.isVerifiedAssetResponse(hit, entry)) return false;
    }
    return true;
  };
  const absentCount = () => (exact() ? catalog.files.filter((entry) => !ready(entry)).length : null);
  const store = async (entry, body) => {

    cancelled();
    if (body.byteLength !== entry.bytes || await h.sha256Hex(body) !== entry.sha256) throw h.assetCacheError('ASSET_CACHE_HASH_MISMATCH');
    cancelled();
    const request = new Request(origin + h.assetContentKey(entry.sha256), { headers: {
      'X-SP-Asset-SHA256': entry.sha256, 'X-SP-Asset-Bytes': String(entry.bytes) } });
    await cache.put(request, new Response(body, { headers: h.validatedCacheHeaders(entry) }));
    hashes.set(entry.sha256, entry.bytes);
  };
  stats = await readStats();
  report();
  if (message.action === 'scan') {
    if (message.deep) {
      presence = await enumerate(SCAN_BUDGET_MS);
      let checked = 0, invalid = 0;
      const verified = new Set();
      // A partial walk means some entries were never enumerated: verify the ones it did prove instead of treating
      // the rest as absent, and never let the partial map reach the panel as a count (counts() falls back).
      if (exact()) {
        for (const entry of catalog.files) {
          cancelled();
          if (!ready(entry) || verified.has(entry.sha256)) continue;
          verified.add(entry.sha256);
          const response = await cache.match(origin + h.assetContentKey(entry.sha256));
          let valid = h.isVerifiedAssetResponse(response, entry);
          if (valid) {
            const body = await response.arrayBuffer();
            valid = body.byteLength === entry.bytes && await h.sha256Hex(body) === entry.sha256;
          }
          if (!valid) { hashes.delete(entry.sha256); await cache.delete(origin + h.assetContentKey(entry.sha256)); invalid++; }
          checked++;
          if (checked % 20 === 0) report({ scanStats: { checked, invalid } });
        }
      }
      stats = await writeStats() || stats;
      report({ scanStats: { checked, invalid, partial: presence.partial, error: presence.error },
        ...(exact() ? {} : { statsUnavailable: true }) });
    } else if (stats && await sampleIntact()) {
      // The last completed count still describes the pinned directory: answer from metadata, no walk at all.
      report();
    } else {
      presence = await enumerate(SCAN_BUDGET_MS);
      if (exact()) {
        stats = await writeStats() || stats;
        report({ statsSource: 'scan', statsAt: stats?.at || Date.now() });
      } else {
        // 「统计不可用，但缓存仍在使用」: the last completed count stays the answer and the walk's failure is data.
        report({ statsUnavailable: true, scanStats: { checked: presence.scanned, invalid: 0,
          partial: presence.partial, error: presence.error } });
      }
    }
  } else if (message.action === 'download') {
    presence = await enumerate(SCAN_BUDGET_MS);
    // A failed walk cannot tell 「absent」 from 「not counted」. Re-downloading a complete 980 MB directory from the
    // server is far worse than refusing, so download requires the exact map; import below stays available.
    if (!exact()) throw h.assetCacheError('ASSET_CACHE_SCAN_INCOMPLETE', new Error(presence.error || 'partial walk'));
    report();
    let received = 0;
    const started = performance.now();
    for (const entry of catalog.files) {
      cancelled();
      if (ready(entry)) continue;
      let response;
      for (let retry = 0; retry < 6; retry++) {
        cancelled();
        response = await fetch(`/api/asset-cache/file?url=${encodeURIComponent(entry.url)}&hash=${entry.sha256}`, {
          cache: 'no-store', signal: active.abort.signal });
        if (response.status !== 429) break;
        const seconds = Math.max(1, Math.min(30, Number(response.headers.get('retry-after')) || 3));
        report({ waiting: true, speedBps: 0 });
        await sleep(seconds * 1000, active.abort.signal);
      }
      if (response.status === 409) throw h.assetCacheError('ASSET_CACHE_STALE_CATALOG');
      if (response.status === 503) throw h.assetCacheError(await unavailableCode(response));
      if (response.status === 429) throw h.assetCacheError('ASSET_CACHE_BUSY');
      if (response.status !== 200 || Number(response.headers.get('content-length')) !== entry.bytes)
        throw h.assetCacheError('ASSET_CACHE_DOWNLOAD_FAILED');
      const buffer = new Uint8Array(entry.bytes);
      const reader = response.body.getReader();
      let offset = 0, lastReport = 0;
      try {
        while (true) {
          cancelled();
          const chunk = await reader.read();
          if (chunk.done) break;
          if (offset + chunk.value.length > entry.bytes) throw h.assetCacheError('ASSET_CACHE_FILE_TOO_LARGE');
          buffer.set(chunk.value, offset); offset += chunk.value.length; received += chunk.value.length;
          if (performance.now() - lastReport > 250) {
            report({ waiting: false, speedBps: Math.round(received * 1000 / Math.max(1, performance.now() - started)) });
            lastReport = performance.now();
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (offset !== entry.bytes) throw h.assetCacheError('ASSET_CACHE_DOWNLOAD_FAILED');
      await store(entry, buffer);
      report({ waiting: false, speedBps: Math.round(received * 1000 / Math.max(1, performance.now() - started)) });
    }
  } else if (message.action === 'import') {
    if (!(message.file instanceof Blob)) throw h.assetCacheError('ASSET_CACHE_ZIP_INVALID');
    // Import stays available on a partial walk: it re-verifies every entry it rewrites, so an incomplete map costs
    // re-reads only. Download refuses for exactly the opposite reason.
    presence = await enumerate(SCAN_BUDGET_MS);
    report();
    const reader = new zip.ZipReader(new zip.BlobReader(message.file), { useWebWorkers: false, checkSignature: true });
    let entries;
    const expected = new Map(catalog.files.map((entry) => [entry.url.slice(1), entry]));
    const stats = { imported: 0, reused: 0, invalid: 0, unknown: 0, absent: 0 };
    try {
      // Reject unsafe archives before writing any file. Ordinary old/extra asset entries are skipped.
      entries = await archiveEntries(reader, h);
      const candidates = entries.filter((entry) => !entry.directory && entry.filename !== 'manifest.json');
      const importedHashes = new Set();
      for (const entry of candidates) {
        cancelled();
        const target = expected.get(entry.filename);
        if (!target) { stats.unknown++; continue; }
        if (importedHashes.has(target.sha256) || ready(target)) { stats.reused++; continue; }
        if (entry.uncompressedSize !== target.bytes || ![0, 8].includes(entry.compressionMethod)) { stats.invalid++; continue; }
        try {
          const blob = await entry.getData(new LimitedWriter(target.bytes), { useWebWorkers: false, checkSignature: true,
            signal: active.abort.signal });
          const body = await blob.arrayBuffer();
          if (body.byteLength !== target.bytes || await h.sha256Hex(body) !== target.sha256) { stats.invalid++; continue; }
          await store(target, body); importedHashes.add(target.sha256); stats.imported++;
        } catch (error) {
          if (active.paused || error.name === 'QuotaExceededError') throw error;
          stats.invalid++;
        }
        if ((stats.imported + stats.reused + stats.invalid) % 10 === 0) report({ importStats: { ...stats } });
      }
      stats.absent = absentCount();
      report({ importStats: stats });
    } catch (error) {
      if (error.code || error.name === 'QuotaExceededError') throw error;
      throw h.assetCacheError('ASSET_CACHE_ZIP_INVALID', error);
    } finally { await reader.close(); }
  } else throw h.assetCacheError('ASSET_CACHE_BAD_MESSAGE');
  stats = await writeStats() || stats;
  report({ speedBps: 0, waiting: false });
}

/**
 * The page switches on symbolic ASSET_CACHE_* codes (public/js/ui/assetCache.js). A DOMException carries a
 * numeric legacy code instead (20 = AbortError, 22 = QuotaExceededError), and forwarding that number made a
 * failed directory scan print `[asset-cache] 20: 素材预缓存未生效…` with a code no consumer can read.
 * Only a non-empty string from our own assetCacheError() passes through; anything else is the storage bucket.
 */
function storageCode(error) {
  return typeof error?.code === 'string' && error.code ? error.code : 'ASSET_CACHE_STORAGE_ERROR';
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener('abort', aborted); resolve(); }
    function aborted() { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(new DOMException('Paused', 'AbortError')); }
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

self.onmessage = async ({ data }) => {
  if (data?.type === 'pause') { if (active) { active.paused = true; active.abort.abort(); } return; }
  if (active) { send(data?.id, 'error', { code: 'ASSET_CACHE_BUSY' }); return; }
  active = { id: data.id, paused: false, abort: new AbortController() };
  try { const result = await work(data); send(data.id, 'done', result); }
  catch (error) { send(data.id, 'error', { code: active.paused ? 'ASSET_CACHE_PAUSED'
    : error.name === 'QuotaExceededError' ? 'ASSET_CACHE_QUOTA' : storageCode(error) }); }
  finally { active = null; }
};
