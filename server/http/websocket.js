// server/http/websocket.js — the real-time side of the server:
//
//   * session wiring: SessionRegistry (reconnect tokens) → Lobby (rooms, server/lobby.js) → Network (the socket
//     protocol, server/net.js), built from the startServer() options (config.js decides which go where);
//   * WebSocket (ws) at /ws, maxPayload 64 KB after inflation, permessage-deflate → Network.handleConnection. Refused at the
//     upgrade: any other path 404; per-network socket limit for internet clients (maxConnectionsPerAddr, see net.js
//     clientAddress; local/LAN peers are exempt) 429; server full (maxConnections) or shutting down 503.

import { WebSocketServer } from 'ws';
import { Network, SessionRegistry, NET_DEFAULTS } from '../net.js';
import { Lobby } from '../lobby.js';
import { splitUrl } from './common.js';
import { netOptionsFrom, lobbyOptionsFrom } from './config.js';

/** Inbound WebSocket frame limit (DESIGN §8). */
export const WS_MAX_PAYLOAD = 64 * 1024;

// RFC 7692 raw DEFLATE. Retaining the outbound 32 KiB dictionary exploits repeated views; ws bounds global zlib work.
// Incoming clients do not retain context, and maxPayload still bounds decompressed input. No custom browser inflater.
export const WS_COMPRESSION = Object.freeze({
  serverNoContextTakeover: false, clientNoContextTakeover: true,
  serverMaxWindowBits: 15, concurrencyLimit: 4, threshold: 256,
  zlibDeflateOptions: Object.freeze({ level: 6, memLevel: 7 }),
});

/**
 * The session stack of one server.
 * @param {{ MatchClass?: Function, seedFn?: () => number, [option: string]: any }} opts startServer() options
 * @param {{ data: object, log: object }} deps the game data the lobby's matches use, the logger
 * @returns {{ registry: SessionRegistry, lobby: Lobby, network: Network }}
 */
export function createSessionStack(opts, { data, log }) {
  const netOptions = netOptionsFrom(opts);
  const registry = new SessionRegistry({ reconnectWindowMs: netOptions.reconnectWindowMs ?? NET_DEFAULTS.reconnectWindowMs });
  const lobbyOptions = lobbyOptionsFrom(opts);
  const lobby = new Lobby({ registry, log, MatchClass: opts.MatchClass, getData: () => data, seedFn: opts.seedFn, options: lobbyOptions });
  const network = new Network({ registry, handler: lobby, log, options: netOptions });
  return { registry, lobby, network };
}

/**
 * Serve the WebSocket endpoint /ws on `server` (its 'upgrade' event).
 * @param {import('node:http').Server} server
 * @param {{ network: Network, log: object }} deps
 * @returns {WebSocketServer}
 */
export function attachWebSocket(server, { network, log }) {
  const compression = process.env.SP_WS_DEFLATE === '0' ? false : { ...WS_COMPRESSION };
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: compression, clientTracking: false });
  wss.on('connection', (ws, req) => {
    // Nagle OFF on every accepted socket (TCP_NODELAY). Node's net.Socket defaults to Nagle ON, and this protocol is a
    // trickle of tiny JSON frames: without this, a pong / room.state written while the previous segment is still
    // unacknowledged waits for that ACK, and a Windows peer's delayed ACK adds its own ~200 ms on top — the client then
    // measures a ~200 ms WebSocket round trip over a link whose ICMP is 44 ms, while the server's own handling is 1–2 ms.
    // Nagle is a property of the sender's egress socket, so the node→client half is all that has to be set (the
    // Caddy→node hop is a separate socket, not ours to tune). maxPayload / perMessageDeflate are untouched: Nagle
    // buffers the wire, while compression only changes how a large message is packed inside one frame.
    try { ws._socket?.setNoDelay?.(true); } catch (e) { log.debug?.('[ws] setNoDelay failed', e); }
    network.handleConnection(ws, req);
  });
  wss.on('error', (e) => log.error('[ws] server error', e));

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const parts = splitUrl(req.url || '/');
    const reject = (status, text) => {
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
    };
    if (!parts || parts.rawPath !== '/ws') { reject(404, 'Not Found'); return; }
    const refused = network.admission(req);
    if (refused === 'per-address') { reject(429, 'Too Many Requests'); return; }
    if (refused) { reject(503, 'Service Unavailable'); return; }
    try {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (e) {
      log.error('[ws] upgrade failed', e);
      socket.destroy();
    }
  });
  return wss;
}
