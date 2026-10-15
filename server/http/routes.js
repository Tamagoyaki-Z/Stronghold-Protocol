// server/http/routes.js — the node:http request listener. Every response gets the security headers (common.js), then:
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)
//
//   * a URL longer than 4096 characters → 414; one that does not parse → 400;
//   * any method but GET / HEAD → 405 with `Allow: GET, HEAD`;
//   * GET /healthz → JSON status (protocol `version`, release `app`, uptime, the served `build`, sockets, sessions,
//     rooms, matches), never cached; `?traffic=1` adds the traffic counters (traffic.js: bytes by category since the
//     start, WebSocket wire and payload bytes) for a loopback or private-network client only — the maintainer's
//     decision of 2026-10-12: the figures are the host's, so any other client, also one a tunnel or proxy on this
//     machine forwards, gets the plain report (net.js clientAddress, honouring TRUST_PROXY like the WebSocket limits);
//   * everything else → the static files (static.js).
// Every response's body bytes count in the traffic counters (traffic.js meter). A route that throws is logged and
// answers 500.

import { PROTOCOL_VERSION, APP_VERSION, MAX_SEATS, MAX_SPECTATORS } from '../../shared/constants.js';
import { isAnnouncementId } from '../../shared/announcements.js';
import { ANNOUNCEMENT_ASSET_URL_PREFIX } from '../../shared/announcementAssets.js';
import { serveAnnouncementAsset } from './announcementAssets.js';
import { ASSET_CACHE_PREFIX } from './assetCache.js';
import { buildTag } from './buildTag.js';
import { setSecurityHeaders, sendError, sendJson, splitUrl } from './common.js';
import { clientAddress, isLocalIp } from '../net.js';

const MAX_URL_LENGTH = 4096;

/**
 * The GET /healthz body (`withTraffic`: plus the traffic counters and the asset index's state, `?traffic=1`).
 * @param {{ startedAt: number, network: import('../net.js').Network, registry: import('../net.js').SessionRegistry,
 *           lobby: import('../lobby.js').Lobby, bandwidthEmergency?: object,
 *           traffic?: ReturnType<typeof import('./traffic.js').createTrafficCounter>,
 *           assetIndex?: ReturnType<typeof import('./assetIndex.js').createAssetIndex> | null,
 *           views?: ReturnType<typeof import('./assetViews.js').createManifestViews> | null }} health
 * @param {boolean} [withTraffic]
 */
export function healthReport({ startedAt, network, registry, lobby, bandwidthEmergency, traffic, assetIndex, views }, withTraffic = false) {
  const report = {
    ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    // the runtime the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
    // older than this reloads itself, so a deploy reaches clients that never reload
    build: buildTag(),
    sockets: network.connectionCount, sessions: registry.size, ...lobby.stats(),
    // the room's size limits (the fork's 20 seats and 10 spectator seats; shared/constants.js) — a cheap way for a
    // host's monitor to check them without a room existing (the red-line probe reads /healthz maxSeats=20)
    maxSeats: MAX_SEATS, maxSpectators: MAX_SPECTATORS,
    ...(bandwidthEmergency ? { bandwidthEmergency: bandwidthEmergency.status() } : {}),
  };
  if (withTraffic && traffic) report.traffic = traffic.snapshot();
  // content-hashed asset URLs (assetIndex.js / assetViews.js): off, building, or ready with how many files and URLs
  if (withTraffic) report.assetHashes = assetIndex ? { ...assetIndex.stats(), views: views ? views.stats() : null } : null;
  return report;
}

/** Does the query ask for the traffic counters (`traffic`, `traffic=1`, `traffic=true`)? */
const wantsTraffic = (query) => /(?:^|&)traffic(?:=(?:1|true|yes))?(?:&|$)/i.test(query || '');

/**
 * The request listener for `http.createServer`.
 * @param {{ serveStatic: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *             rawPath: string, query: string) => Promise<void>,
 *           health: Parameters<typeof healthReport>[0], log: object, trustProxy?: 'auto' | boolean,
 *           announcements?: ReturnType<typeof import('../announcements.js').createAnnouncementStore>,
 *           assetCache?: ReturnType<typeof import('./assetCache.js').createAssetCacheHandler>,
 *           emergency?: () => ({ active?: boolean, retryAt?: number } | null) }} deps
 *   trustProxy: whose forwarding headers name the client (net.js clientAddress; the server's TRUST_PROXY)
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ serveStatic, health, log, trustProxy = 'auto', announcements, assetCache, emergency = () => null }) {
  // Include in-flight ordinary assets/runtime/announcements, not just explicit filling. Emergency trip
  // releases these responses as well, so a cold visitor cannot retain its old streaming budget.
  const publicResponses = new Set();
  function track(res) {
    publicResponses.add(res);
    const done = () => { publicResponses.delete(res); res.off('finish', done); res.off('close', done); };
    res.once('finish', done); res.once('close', done);
  }
  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if (parts.rawPath === '/healthz') {
      const withTraffic = wantsTraffic(parts.query) && isLocalIp(clientAddress(req, trustProxy).ip);
      sendJson(req, res, 200, healthReport(health, withTraffic));
      return;
    }
    const protection = emergency();
    if (protection?.active) {
      const seconds = protection.retryAt ? Math.max(1, Math.ceil((protection.retryAt - Date.now()) / 1000)) : 120;
      res.setHeader('Retry-After', String(seconds));
      res.setHeader('Connection', 'close');
      sendJson(req, res, 503, { error: parts.rawPath.startsWith(ASSET_CACHE_PREFIX)
        ? 'ASSET_CACHE_EMERGENCY' : 'SERVER_EMERGENCY', emergency: true, retryAfterSec: seconds });
      return;
    }
    track(res);
    res.setHeader('X-Accel-Buffering', 'no');
    if (parts.rawPath.startsWith(ASSET_CACHE_PREFIX)) {
      if (!assetCache) { sendJson(req, res, 503, { error: 'ASSET_CACHE_UNAVAILABLE' }); return; }
      await assetCache.serve(req, res, parts.rawPath, parts.query);
      return;
    }
    if (parts.rawPath === '/api/announcements') {
      sendJson(req, res, 200, announcements?.list() || { revision: '', pinnedId: null, items: [] });
      return;
    }
    if (parts.rawPath.startsWith('/api/announcements/')) {
      let id;
      try { id = decodeURIComponent(parts.rawPath.slice('/api/announcements/'.length)); } catch { /* invalid URL */ }
      const article = isAnnouncementId(id) ? announcements?.read(id) : null;
      sendJson(req, res, article ? 200 : 404, article || { error: 'ANNOUNCEMENT_NOT_FOUND' });
      return;
    }
    if (parts.rawPath === ANNOUNCEMENT_ASSET_URL_PREFIX.slice(0, -1) || parts.rawPath.startsWith(ANNOUNCEMENT_ASSET_URL_PREFIX)) {
      await serveAnnouncementAsset(req, res, parts.rawPath.slice(ANNOUNCEMENT_ASSET_URL_PREFIX.length), announcements, log);
      return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  const listener = (req, res) => {
    setSecurityHeaders(res);
    // The traffic meter is optional: a test or an embedder may build the handler with only serveStatic (the fork's
    // test/asset-cache-http.test.js does). Upstream 0.2.6's `health.traffic` assumed a full startServer() wiring.
    if (health?.traffic) health.traffic.meter(res, splitUrl(req.url || '/')?.rawPath || '/');
    handleRequest(req, res).catch((e) => {
      if (res.destroyed) return;
      log.error('[http] request failed', e);
      sendError(req, res, 500, '服务器内部错误 · Internal error');
    });
  };
  listener.abortPublicRequests = () => {
    for (const res of publicResponses) res.destroy();
    publicResponses.clear();
  };
  return listener;
}
