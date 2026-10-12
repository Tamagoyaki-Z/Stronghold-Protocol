// server/lobby.js — rooms, seats, host, AI seats, ready/start, reconnect, and room → Match wiring
// (DESIGN §2, §6.1 LOBBY, §8.1). Implements the handler interface consumed by server/net.js.
//
// Rules (the choices where DESIGN is silent are marked ▸):
//   * Rooms are keyed by 4-letter codes from an unambiguous alphabet (no I/O, letters only). Join codes are
//     case-insensitive.
//   * 'solo' rooms hold exactly one human and never bots. 'coop' rooms offer 4 / 8 / 10 / 16 / 20 seats (humans + AI bots).
//     Humans and bots take the lowest free seat index. In a waiting room the host occupies seat 0;
//     host transfer/migration swaps only the host and seat 0. Running matches retain their fixed seats.
//   * ▸ Being in a LOBBY room and sending room.create / room.join implicitly leaves it. While your room is
//     in a match, create/join of another room fails with ROOM_STARTED (send g.leave or room.leave first).
//   * Host-only: room.setDifficulty, room.setAiPicksLast, room.addBot, room.removeBot, room.kick, room.start.
//     ▸ Changing the difficulty or the AI-picks-last option (co-op only) un-readies the other humans.
//     ▸ room.start requires every other human to be connected and ready; the host's start counts as the host's
//     ready (the host may still toggle room.ready for display).
//   * room.kick {seat, playerId} (community report #17, owner approved): before the match only, the host removes another
//     human like an AI seat (an AI seat stays room.removeBot's; never the host itself). `playerId` names the player the
//     host confirmed: a seat that changed hands meanwhile (left, someone else joined) is refused with BAD_TARGET. The
//     seat is freed at once and the player gets `room.closed {reason:'kicked'}` — now, or on the next resume when
//     offline (with the result replay, as the grace timeout) —, so the reconnect token no longer leads back to the seat
//     (it stays the player's identity: net.js sessions belong to players, not seats). ▸ No ban: the player may join
//     again with the code.
//   * Host migration: when the host leaves (or is removed), the lowest-seat remaining human (connected
//     ones first) becomes host. A room without humans is disposed (bots never keep a room alive).
//   * Disconnect in LOBBY: the seat shows connected=false and is freed after `lobbyGraceMs` (60 s); a
//     session that comes back after that gets `room.closed {reason:'timeout'}`.
//     Disconnect in a match: the seat is kept and match.onDisconnect(playerId) is called.
//   * Reconnect: `hello` with a known token (reconnect window, 10 min, see net.js) rebinds the session;
//     the lobby then broadcasts room.state and, in a match, calls match.onReconnect(playerId).
//     Solo runs (下半: "休整期及机变阶段没有时间限制…24小时内随时返回", research 01 §1 / 06 §17): a session that drops
//     while its solo room's match runs stays resumable for the official `config.constants.singleReconnectTime`
//     (86400 s; option `soloReconnectWindowMs` overrides it) instead of the 10-minute window — the untimed solo match
//     simply waits (net.js session.resumeWindowMs, set at every disconnect). Only after that does expiry turn into
//     match.onLeave ('abandoned'). The extension outlives the match, so a run that ended meanwhile (e.g. a server-run
//     Final Assault) still shows its result on the player's return.
//     A repeated hello on a live connection is a full resync: room.state goes to the requester only
//     (broadcast only when the seat visibly changed, e.g. a rename in LOBBY); the heavy part (match.onReconnect,
//     or the result replay below) runs at most once per `resyncMinGapMs` per session — extra requests inside
//     that window coalesce into one deferred resync, so hello spam cannot amplify into ~15 KB per request.
//   * Result replay: the match's final m.public and each human's m.result are kept after the match ends. A
//     human who resyncs (resume after a drop, a reloaded tab, a repeated hello) while the room is back in LOBBY
//     gets room.state followed by those two frames again, until they act in the room (ready, difficulty, the
//     AI-picks-last option, AI seats, start), leave it, or a new match starts. A human removed by the lobby grace
//     gets them right after `room.closed {timeout}` on their next resume (Match.onReconnect cannot do this: the
//     lobby drops the match reference at onEnd and disposes it on the next macrotask).
//   * Per-network limits (internet clients only, see net.js clientAddress): at most `maxRoomsPerAddr` rooms
//     created from one network may exist at once and at most `maxMatchesPerAddr` matches started from one
//     network may run at once (room.create / room.start → ERR.RATE). Without them a socket loop could fill
//     `maxRooms` or keep hundreds of unattended matches simulating for the whole reconnect window.
//   * Permanent departure during a match (room.leave, g.leave, reconnect window expired): the seat is
//     marked departed (shown as connected=false), match.onLeave(playerId) is called, and the seat is freed
//     when the match ends. 'g.leave' is handled here and never reaches match.handle().
//   * All other 'g.*' messages go to room.match.handle(playerId, msg); its {ok}/{error} becomes the reply.
//   * Match lifecycle: room.start → new Match({...}) → room.state (inMatch=true) → match.start(). The match gets
//     `matchNo` = the room's match number (1, 2, …): with the seed it keeps battleIds unique across the room's
//     matches, so a late b.progress / b.result of the previous match is ignored by the next one (DESIGN §14).
//     onEnd(summary) → room back to LOBBY (departed seats freed, humans un-readied, disconnected humans
//     get the lobby grace), dispose() on the next macrotask. Players can start again.
//   * room.closed reasons: 'timeout' (removed after lobby grace), 'kicked' (room.kick, room.removeSpectator), 'empty' (a
//     spectator whose room lost its last player), 'shutdown' (server stopping).
//   * Operator loadout (DESIGN §16): room.loadout { entries } is checked strictly against the game data
//     (shared/protocol.js checkLoadout: known visible chess, a skill index legal for the normal AND the elite status, a
//     module of the elite or 'none'; any bad entry rejects the whole message, nothing is stored). ▸ It is stored on the
//     session (it follows the player into every room they create/join, and survives a resume) and on the seat; the
//     match receives seats[].loadout (bots: none — they fight with the defaults). ▸ Accepted any time: in a LOBBY room
//     (or outside a room) it simply replaces the stored one; while the room's match runs it is also handed to
//     match.setLoadout(playerId, loadout), which accepts it only during INFO_CHECK (the 干员调配 entry of the briefing)
//     and refuses it afterwards (WRONG_PHASE: the match's loadout is locked, the stored one applies to the next match).
//     ▸ Its `ops` (0.2.2: the per-operator 潜能 / 练度, shared/protocol.js checkLoadoutOps — an operator of the 干员调配
//     roster or the 自选 owned pool, strict like the entries) travel with it: session.ops / seat.ops / seats[].ops and
//     match.setLoadout(playerId, loadout, ops); a message without `ops` sets none (every operator 潜能 6, 精英2 Lv.60).
//   * Operator ownership (干员持有, 0.2.0 补位, owner's decision 2026-10-05): room.ownership { notOwned } — the base chess
//     ids the player marked as not owned — is checked leniently (shared/protocol.js checkNotOwned: anything that is not
//     a droppable NORMAL chess is dropped, never the whole list; only a malformed list is BAD_MSG) and stored on the
//     session and the seat like the loadout. The match receives seats[].notOwned when it starts (bots: none — they own
//     every operator) and keeps it for its whole length: the setting is out of match ("局外设置，下一局生效"), so while
//     the room's match runs a new list is only stored for the next match (ROOM_STARTED 'stored for the next match',
//     never handed to the match). A spectator's list stays on its session.
//   * 自选编队 (0.2.0 DIY, the owner's decisions of 2026-10-05): room.diy { picks } — the player's picks for the four DIY
//     slots ({ [slotBaseId]: { charId, skillIndex?, uniEquipId? } | null }) — is checked leniently (shared/protocol.js
//     checkDiyPicks against the game data and the kit registry, server/sim/content/kits/index.js KITTED_CHARS: an
//     illegal pick — an operator without a kit, another tier's prototype, a prototype off its locked skill, a second slot
//     of one owned operator, the same operator twice in a tier, an unknown slot / skill / module — is dropped, never the
//     whole roster; only malformed picks are BAD_MSG) and stored on the session and the seat exactly like the
//     not-owned list: the match receives seats[].diy when it starts (bots: none — they field no 自选 piece [ASSUMED]),
//     and a change while it runs is stored for the next match (ROOM_STARTED 'stored for the next match'). Every
//     `welcome` carries `diyKitted` (welcomeInfo): the operators a DIY slot may field, so the client's picker offers
//     exactly what the server accepts.
//   * Spectator seats (community report #26, owner's decision 2026-10-04 — a remake feature, the official room has none):
//     room.spectate { code } takes one of a co-op room's MAX_SPECTATORS (2) spectator seats, in its lobby or while its
//     match runs (▸ solo rooms: ROOM_FULL). A spectator is not a player: never in `seats`, never counted for the 1–20 players
//     or the start gate, never host, never keeps a room alive (a room whose last human leaves closes with room.closed
//     {empty} for its spectators). It receives room.state (`spectators: [{ playerId, name, connected }]`) and every match
//     broadcast (m.public, m.ticker, m.emote, b.pool — public data); the match registers it (opts.spectators /
//     addSpectator) and shows it fields like an eliminated player (b.start watch / m.field), never an m.private. It may
//     only g.watch (the heavy bucket, like every watcher), g.leave / room.leave, and room.loadout / room.ownership /
//     room.diy (stored for its session, never handed to the match); anything else → SPECTATOR (▸ emotes too). Host: room.removeSpectator { playerId } any
//     time → room.closed {kicked} to it. A spectator in a LOBBY room may take a free player seat with room.join of the same
//     code; a player never switches to spectating in place (ALREADY). Disconnect / grace / reconnect / expiry work as for
//     a player seat (the seat is kept and given back on resume).

import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { ERR, PHASE, DEFAULT_SEATS, ROOM_CAPACITIES, MAX_SEATS, MAX_SPECTATORS, ROOM_CODE_LEN, modeIdFor } from '../shared/constants.js';
import { checkLoadout, checkLoadoutOps, cultivationCharIds, checkNotOwned, checkDiyPicks } from '../shared/protocol.js';
import { encode, prepareMessage, sendPrepared, isDroppable, isErrCode, sendRaw, sendSession } from './net.js';
import { getData as defaultGetData, lookup } from './data.js';
import { Match as DefaultMatch } from './match/Match.js';
import { KITTED_CHARS } from './sim/content/kits/index.js';
import { LobbyDiscovery } from './lobbyDiscovery.js';
import { assetCacheReadinessMatches } from '../shared/assetCache.js';
import { MatchChat } from './matchChat.js';

/** Room code alphabet: uppercase letters without I and O (and no digits, so no 0/1). */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Tunables. */
export const LOBBY_DEFAULTS = Object.freeze({
  lobbyGraceMs: 60_000,   // disconnected humans keep their lobby seat this long
  maxRooms: 1000,
  maxRoomsPerAddr: 16,    // rooms created from one client network that may exist at once (0 = unlimited)
  maxMatchesPerAddr: 8,   // matches started from one client network that may run at once (0 = unlimited)
  resyncMinGapMs: 1000,   // heavy resyncs (match state / result replay) per session at most this often on repeated hellos
  soloReconnectWindowMs: null, // a dropped solo run stays resumable this long (null = data singleReconnectTime, 24 h)
  swapTtlMs: 30_000,      // ⇄ 换位: how long room.swapAsk waits for the target's answer (a timeout is a refusal)
});

/** Official `singleReconnectTime` (s) when the data lacks it (constData, research 01 §1). */
export const SOLO_RECONNECT_FALLBACK_SEC = 86_400;

/** Display names for AI teammates (the tutorial NPCs first, then a few familiar faces). */
export const BOT_NAMES = Object.freeze(['AI·华法琳', 'AI·阿米娅', 'AI·惊蛰', 'AI·杜宾', 'AI·凯尔希', 'AI·可露希尔']); // i18n-ignore: player names (docs/I18N.md)

const OK = Object.freeze({ ok: true });
const fail = (code, detail) => (detail ? { error: code, detail } : { error: code });
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * @typedef {{ seat: number, playerId: string, name: string, isBot: boolean, ready: boolean,
 *             connected: boolean, left: boolean, loadout?: Record<string, { skill: number, module: string|null }> | null,
 *             ops?: Readonly<Record<string, { potential: number, cultivate: number }>> | null,
 *             notOwned?: readonly string[] | null, diy?: Readonly<Record<string, DiyLoadout>> | null }} Seat
 * @typedef {{ charId: string, skillIndex: number, uniEquipId: string|null }} DiyLoadout
 */

/** Deep-frozen copy of a checked loadout (shared by the session, the seat and the match's PlayerState). */
function freezeLoadout(loadout) {
  const out = {};
  for (const [id, e] of Object.entries(loadout || {})) out[id] = Object.freeze({ skill: e.skill, module: e.module ?? null });
  return Object.freeze(out);
}

/** Deep-frozen copy of checked operator settings (0.2.2 潜能 / 练度; shared by the session, the seat and the match). */
function freezeOps(ops) {
  const out = {};
  for (const [id, e] of Object.entries(ops || {})) out[id] = Object.freeze({ potential: e.potential, cultivate: e.cultivate });
  return Object.freeze(out);
}

/** The charIds a player may set a potential / 练度 for, per data object (shared/protocol.js cultivationCharIds). */
const OPS_IDS = new WeakMap();
function opsCharIds(data) {
  if (!data || typeof data !== 'object') return new Set();
  let ids = OPS_IDS.get(data);
  if (!ids) { ids = cultivationCharIds(data.chess, data.backups); OPS_IDS.set(data, ids); }
  return ids;
}

/**
 * Frozen copy of a skin selection, keeping only entries whose chess the game data knows (docs/SKINS.md).
 * @param {Record<string, string>} skins `{ [baseChessId]: skinId }`
 * @param {(id: string) => any} getChess
 */
function freezeSkins(skins, getChess) {
  const out = {};
  for (const [id, skinId] of Object.entries(skins || {})) {
    const rec = getChess(id);
    if (!rec || rec.isGolden || rec.visible === false || rec.isHidden || rec.isDiy || (rec.baseId && rec.baseId !== id)) continue;
    out[id] = String(skinId);
  }
  return Object.freeze(out);
}

/** Deep-frozen copy of checked 自选 picks (shared by the session, the seat and the match's PlayerState). */
function freezeDiy(picks) {
  const out = {};
  for (const [id, p] of Object.entries(picks || {})) out[id] = Object.freeze({ charId: p.charId, skillIndex: p.skillIndex, uniEquipId: p.uniEquipId ?? null });
  return Object.freeze(out);
}

/** One room: configurable player seats, host, difficulty, optional running match. */
export class Room {
  /** @param {string} code @param {'solo'|'coop'} mode @param {string} difficulty @param {number} now */
  constructor(code, mode, difficulty, now, capacity = DEFAULT_SEATS) {
    this.code = code;
    // Public directory identity is independent of the invitation code and lasts only for this room's lifetime.
    this.directoryId = randomUUID();
    this.allowMatchmaking = true;
    this.mode = mode;
    this.difficulty = difficulty;
    /**
     * Compatibility with upstream's option (GitHub #338). This capacity branch always orders manual, connected
     * humans first inside each draft group (D004/D012); disconnected/autoplay humans share the automatic category.
     */
    this.aiPicksLast = mode !== 'solo';
    /** @type {string | null} */
    this.hostId = null;
    /** @type {number | null} Server policy; null leaves AI seats bounded only by room capacity. */
    this.maxAiPerRoom = null;
    /** @type {(Seat | null)[]} */
    this.capacity = mode === 'solo' ? 1 : capacity;
    this.seats = new Array(this.capacity).fill(null);
    /** @type {{ playerId: string, name: string, connected: boolean }[]} spectator seats, ≤ MAX_SPECTATORS (header) */
    this.spectators = [];
    /**
     * ⇄ 换位 (room.swapAsk): the negotiations in flight, keyed by the asker's playerId (one per player). `toState`
     * publishes them as `{ from, to, ttlMs }`, so both sides and every bystander render the same waiting state.
     * @type {Map<string, { from: string, to: string, expiresAt: number, timer: any }>}
     */
    this.swaps = new Map();
    /** @type {any} running Match instance */
    this.match = null;
    /** @type {{ live: boolean, ended: boolean, disposed: boolean, match: any, chat: MatchChat } | null} */
    this.matchCtx = null;
    this.matchCount = 0;
    /** @type {any} summary passed to onEnd by the last match */
    this.lastSummary = null;
    /**
     * Frames of the last match's end, replayed on resync to humans who have not moved on yet.
     * @type {{ publicFrame: string | null, frames: Map<string, string>, pending: Set<string> } | null}
     */
    this.replay = null;
    /** @type {string | null} per-network limit key of the creator (net.js clientAddress) */
    this.ownerKey = null;
    /** @type {string | null} per-network limit key of whoever started the running match */
    this.matchKey = null;
    this.createdAt = now;
    this.disposed = false;
  }

  /** @param {string} playerId @returns {Seat | null} */
  seatOf(playerId) {
    for (const s of this.seats) if (s && s.playerId === playerId) return s;
    return null;
  }

  /** @param {string} playerId @returns {{ playerId: string, name: string, connected: boolean } | null} */
  spectatorOf(playerId) { return this.spectators.find((s) => s.playerId === playerId) || null; }

  /** Lowest free seat index, or -1. */
  freeSeat() { return this.seats.indexOf(null); }

  /** Humans that have not departed, in seat order. @returns {Seat[]} */
  activeHumans() { return this.seats.filter((s) => s && !s.isBot && !s.left); }

  /**
   * `room.state` frame (DESIGN §8.1) plus `inMatch` and the ⇄ 换位 negotiations in flight.
   * @param {number} [nowMs] the clock the lobby reads, so `swaps[].ttlMs` is the real remainder of an answer window
   *   instead of a number this class would have to guess from a timestamp taken when it was built
   */
  toState(nowMs = Date.now()) {
    return {
      t: 'room.state',
      code: this.code,
      hostId: this.hostId,
      maxAiPerRoom: this.maxAiPerRoom,
      mode: this.mode,
      difficulty: this.difficulty,
      capacity: this.capacity,
      aiPicksLast: this.aiPicksLast,
      allowMatchmaking: this.allowMatchmaking,
      inMatch: !!this.match,
      // v1 extension metadata only: message bodies never ride room/public snapshots or result replay.
      chatMatchId: this.match && this.matchCtx?.live && !this.matchCtx.ended && !this.matchCtx.chat.closed
        ? this.matchCtx.chat.matchId : null,
      seats: this.seats.map((s) => (s
        ? { seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, ready: s.ready, connected: s.connected && !s.left }
        : null)),
      spectators: this.spectators.map((s) => ({ playerId: s.playerId, name: s.name, connected: s.connected })),
      // ⇄ 换位: who negotiates with whom, and how long the target still has to answer. The only place a client learns
      // about a swap (`room.swapAsked` merely opens the target's dialog); seats move in the frame that follows consent.
      swaps: [...this.swaps.values()].map((s) => ({ from: s.from, to: s.to, ttlMs: Math.max(0, s.expiresAt - nowMs) })),
    };
  }
}

/** Room registry + lobby message handlers. Pass an instance as the `handler` of net.js Network. */
export class Lobby {
  /**
   * @param {{
   *   registry: import('./net.js').SessionRegistry,
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   MatchClass?: new (opts: object) => any,
   *   getData?: () => object,
   *   now?: () => number,
   *   seedFn?: () => number,
   *   options?: Partial<typeof LOBBY_DEFAULTS>,
   * }} opts
   */
  constructor({ registry, log = noopLog, MatchClass = DefaultMatch, getData = defaultGetData, now = Date.now, seedFn, options = {} }) {
    this.registry = registry;
    this.log = log;
    this.MatchClass = MatchClass;
    this.getData = getData;
    this.now = now;
    this.seedFn = seedFn || (() => randomInt(2 ** 32));
    this.opts = { ...LOBBY_DEFAULTS, ...options };
    /** ⇄ 换位 answer window (room.swapAsk): a non-negative integer of ms, else the default. */
    this.swapTtlMs = Number.isInteger(this.opts.swapTtlMs) && this.opts.swapTtlMs >= 0
      ? this.opts.swapTtlMs : LOBBY_DEFAULTS.swapTtlMs;
    /** @type {number | null} Owner-controlled AI ceiling, independent from the distributed bundle defaults. */
    this.maxAiPerRoom = null;
    this.requireAssetCache = false;
    this.emergency = { active: false };
    this.getAssetCacheSummary = () => null;
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    this.discovery = new LobbyDiscovery(this);
    /** @type {Map<string, NodeJS.Timeout>} lobby grace timers by playerId */
    this.graceTimers = new Map();
    /** @type {Map<string, NodeJS.Timeout>} deferred (coalesced) resyncs by playerId */
    this.resyncTimers = new Map();
    /** per-network limit warnings: at most one log line per 10 s (the rest are counted) */
    this.limitLog = { at: -Infinity, suppressed: 0 };
  }

  /** @param {string} code @returns {Room | null} */
  getRoom(code) { return this.rooms.get(String(code).toUpperCase()) || null; }

  /** Update the owner policy atomically; active matches keep their roster until their next waiting room. */
  setAiLimit(limit) {
    if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit >= MAX_SEATS)) {
      throw new RangeError(`AI limit must be null or an integer from 0 to ${MAX_SEATS - 1}`);
    }
    if (this.maxAiPerRoom === limit) return;
    this.maxAiPerRoom = limit;
    for (const room of this.rooms.values()) {
      room.maxAiPerRoom = limit;
      if (!room.match) this.trimBots(room);
      this.broadcastState(room);
    }
  }

  /** Owner policy affects new membership only. Network/Lobby dispatch stays entirely synchronous. */
  setAssetCachePolicy({ required, getSummary = this.getAssetCacheSummary }) {
    if (typeof required !== 'boolean' || typeof getSummary !== 'function') throw new TypeError('invalid asset-cache policy');
    this.getAssetCacheSummary = getSummary;
    if (this.requireAssetCache === required) return;
    this.requireAssetCache = required;
    this.discovery.changed();
  }

  assetCacheAdmission(report) {
    if (!this.requireAssetCache) return null;
    const expected = this.getAssetCacheSummary();
    if (assetCacheReadinessMatches(report, expected)) return null;
    return fail(ERR.ASSET_CACHE_REQUIRED, !expected ? 'server-assets-pending'
      : !expected.complete || expected.missingFiles ? 'server-assets-incomplete' : 'precache-missing');
  }

  /** Runtime bandwidth protection is independent from persistent owner settings. */
  setEmergency(state) {
    this.emergency = { active: !!state.active, reason: state.reason || 'bandwidth',
      since: state.startedAt || state.since || this.now(), retryAt: state.retryAt || 0 };
    for (const room of this.rooms.values()) if (room.match) {
      this.callMatch(room, 'setEmergencyFreeze', this.emergency.active, this.emergency);
    }
    this.discovery.changed();
  }

  allowEmergencyResume(session) { return !!this.roomOf(session)?.match; }

  /** Preserve the earliest AI seats and every human; remove only surplus trailing AI seats. */
  trimBots(room) {
    if (room.match || this.maxAiPerRoom === null) return;
    let surplus = room.seats.filter((s) => s?.isBot).length - this.maxAiPerRoom;
    for (let i = room.seats.length - 1; i >= 0 && surplus > 0; i--) {
      if (room.seats[i]?.isBot) { room.seats[i] = null; surplus--; }
    }
  }

  /** Counters for /healthz. */
  stats() {
    let matches = 0;
    let humans = 0;
    let bots = 0;
    let spectators = 0;
    for (const r of this.rooms.values()) {
      if (r.match) matches++;
      for (const s of r.seats) if (s && !s.left) (s.isBot ? bots++ : humans++);
      spectators += r.spectators.length;
    }
    return { rooms: this.rooms.size, matches, humans, bots, spectators };
  }

  // ---------------------------------------------------------------------------------------------------
  // net.js handler interface
  // ---------------------------------------------------------------------------------------------------

  /**
   * After `welcome`: resend room state / match state for resumed (or repeated) hellos.
   * @param {import('./net.js').Session} session
   * @param {{ resumed: boolean, repeat: boolean }} info
   */
  onHello(session, { resumed, repeat }) {
    if (resumed) this.discovery.forget(session.playerId);
    this.discovery.changed();
    if (!resumed && !repeat) return;
    const room = this.roomOf(session);
    if (!room) {
      if (session.notice) {
        sendSession(session, { t: 'room.closed', reason: session.notice });
        session.notice = null;
      }
      if (session.pendingResult) {
        for (const frame of session.pendingResult) if (frame) sendRaw(session.ws, frame);
        session.pendingResult = null;
      }
      return;
    }
    session.notice = null;
    session.pendingResult = null;
    // a player seat, or a spectator seat (header): both carry `connected` / `name`
    const seat = room.seatOf(session.playerId) || room.spectatorOf(session.playerId);
    this.clearGrace(session.playerId);
    // Only a visible change (reconnect, rename, new host) is broadcast; a plain resync (repeated hello on a
    // live socket) answers the requester alone, so hello spam cannot amplify into room-wide traffic.
    let changed = !seat.connected;
    seat.connected = true;
    if (!room.match && seat.name !== session.name) { seat.name = session.name; changed = true; }
    if (!room.hostId) { this.migrateHost(room); changed = true; }
    if (changed) this.broadcastState(room);
    else this.sendState(room, session);
    this.resync(session, !resumed);
  }

  /**
   * Validated client message from an identified session.
   * @param {import('./net.js').Session} session
   * @param {any} msg
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  onMessage(session, msg) {
    if (this.emergency.active && (['lobby.quickMatch', 'room.create', 'room.start', 'room.rerollSetup',
      'room.cancelReroll', 'room.loadout', 'room.ownership', 'room.diy', 'room.chat', 'room.skins'].includes(msg.t)
      || (msg.t === 'lobby.watch' && msg.on))) return fail(ERR.SERVER_EMERGENCY);
    switch (msg.t) {
      case 'lobby.watch': return this.discovery.watch(session, msg);
      case 'lobby.quickMatch': return this.discovery.quickMatch(session, msg);
      case 'lobby.join': return this.discovery.accessById(session, msg, false);
      case 'lobby.spectate': return this.discovery.accessById(session, msg, true);
      case 'room.create': return this.create(session, msg);
      case 'room.join': return this.join(session, msg);
      case 'room.leave': return this.leave(session);
      case 'room.ready': return this.ready(session, msg);
      case 'room.setDifficulty': return this.setDifficulty(session, msg);
      case 'room.setCapacity': return this.setCapacity(session, msg);
      case 'room.setMatchmaking': return this.setMatchmaking(session, msg);
      case 'room.setAiPicksLast': return this.setAiPicksLast(session, msg);
      case 'room.addBot': return this.addBot(session);
      case 'room.removeBot': return this.removeBot(session, msg);
      case 'room.kick': return this.kick(session, msg);
      case 'room.swapAsk': return this.swapAsk(session, msg);
      case 'room.swapAnswer': return this.swapAnswer(session, msg);
      case 'room.swapCancel': return this.swapCancel(session);
      case 'room.transferHost': return this.transferHost(session, msg);
      case 'room.start': return this.start(session);
      case 'room.rerollSetup': return this.rerollSetup(session, msg);
      case 'room.cancelReroll': return this.rerollSetup(session, msg, true);
      case 'room.loadout': return this.loadout(session, msg);
      case 'room.skins': return this.skins(session, msg);
      case 'room.ownership': return this.ownership(session, msg);
      case 'room.diy': return this.diy(session, msg);
      case 'room.spectate': return this.spectate(session, msg);
      case 'room.removeSpectator': return this.removeSpectator(session, msg);
      case 'room.chat': return this.chat(session, msg);
      default:
        if (typeof msg.t === 'string' && msg.t.startsWith('g.')) return this.routeGame(session, msg);
        return fail(ERR.BAD_MSG, `unhandled type ${String(msg.t).slice(0, 32)}`);
    }
  }

  /** The session's socket closed. @param {import('./net.js').Session} session */
  onDisconnect(session) {
    this.discovery.forget(session.playerId);
    this.discovery.changed();
    this.clearResync(session.playerId); // the next resume resyncs immediately
    const room = this.roomOf(session);
    // a solo run may be resumed within singleReconnectTime (24 h); everything else keeps the registry's window
    session.resumeWindowMs = room && room.match && room.mode === 'solo' ? this.soloResumeWindowMs() : null;
    if (!room) return;
    const player = room.seatOf(session.playerId);
    const seat = player || room.spectatorOf(session.playerId);
    seat.connected = false;
    // ⇄ 换位: a dropped connection voids the negotiations it took part in (an answer needs both sides present)
    this.dropSwapsFor(room, session.playerId);
    // a spectator's seat is kept like a player's (nothing to tell the match: it plays no field)
    if (room.match) { if (player) this.callMatch(room, 'onDisconnect', session.playerId); } else this.startGrace(room, seat);
    this.broadcastState(room);
  }

  /** The session's reconnect window elapsed (already removed from the registry). */
  onExpire(session) {
    this.discovery.forget(session.playerId);
    session.notice = null;
    session.pendingResult = null;
    this.clearResync(session.playerId);
    const code = session.roomCode;
    session.roomCode = null;
    const room = code ? this.rooms.get(code) : null;
    if (room) this.removeMember(room, session.playerId);
  }

  /**
   * Dispose every room (notifying members with room.closed) — used on server shutdown.
   * @param {string} [reason]
   */
  shutdown(reason = 'shutdown') {
    this.discovery.close();
    for (const room of [...this.rooms.values()]) this.disposeRoom(room, reason);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    for (const t of this.resyncTimers.values()) clearTimeout(t);
    this.resyncTimers.clear();
  }

  // ---------------------------------------------------------------------------------------------------
  // room.* handlers
  // ---------------------------------------------------------------------------------------------------

  create(session, { mode, difficulty, capacity = DEFAULT_SEATS, assetCache }) {
    if (this.emergency.active) return fail(ERR.SERVER_EMERGENCY);
    if (!ROOM_CAPACITIES.includes(capacity)) return fail(ERR.BAD_MSG, 'invalid capacity');
    const cur = this.roomOf(session);
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    const admission = this.assetCacheAdmission(assetCache);
    if (admission) return admission;
    if (this.rooms.size >= this.opts.maxRooms) return fail(ERR.INTERNAL, 'too many rooms');
    const key = session.limitKey || null;
    if (key && this.opts.maxRoomsPerAddr > 0) {
      // The room being left disappears with this create when the creator is its only human (a spectator is none).
      const leaving = cur && cur.ownerKey === key && cur.activeHumans().length === 1 && !cur.spectatorOf(session.playerId) ? 1 : 0;
      if (this.countRooms((r) => r.ownerKey === key) - leaving >= this.opts.maxRoomsPerAddr) {
        this.limitWarn(`room limit (${this.opts.maxRoomsPerAddr}) reached for ${session.addr}`);
        return fail(ERR.RATE, 'too many rooms from your network');
      }
    }
    const code = this.genCode();
    if (!code) return fail(ERR.INTERNAL, 'no room code available');
    if (cur) this.removeMember(cur, session.playerId);
    const room = new Room(code, mode, difficulty, this.now(), capacity);
    room.maxAiPerRoom = this.maxAiPerRoom;
    room.ownerKey = key;
    room.seats[0] = this.humanSeat(0, session);
    room.hostId = session.playerId;
    this.rooms.set(code, room);
    session.roomCode = code;
    this.discovery.forget(session.playerId);
    session.notice = null;
    session.pendingResult = null;
    this.log.info(`[lobby] ${code} created (${mode}/${difficulty}) by ${session.name}`);
    this.broadcastState(room);
    return OK;
  }

  join(session, { code, assetCache }) {
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) return fail(ERR.ROOM_NOT_FOUND);
    const cur = this.roomOf(session);
    // idempotent for members; a spectator of this room goes on below: it may take a free player seat (header)
    if (cur === room && !room.spectatorOf(session.playerId)) { this.discovery.forget(session.playerId); this.sendState(room, session); return OK; }
    if (this.emergency.active) return fail(ERR.SERVER_EMERGENCY);
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (room.match) return fail(ERR.ROOM_STARTED);
    const admission = this.assetCacheAdmission(assetCache);
    if (admission) return admission;
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    const idx = room.freeSeat();
    if (idx < 0) return fail(ERR.ROOM_FULL);
    if (cur) this.removeMember(cur, session.playerId);
    room.seats[idx] = this.humanSeat(idx, session);
    session.roomCode = room.code;
    this.discovery.forget(session.playerId);
    session.notice = null;
    session.pendingResult = null;
    if (!room.hostId) room.hostId = session.playerId;
    this.broadcastState(room);
    return OK;
  }

  leave(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    this.removeMember(room, session.playerId);
    return OK;
  }

  /**
   * room.spectate: one of a co-op room's MAX_SPECTATORS spectator seats, in its lobby or during its match (header). In a
   * running match the match registers the spectator and resends what it may see (Match.addSpectator).
   */
  spectate(session, { code, assetCache }) {
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) return fail(ERR.ROOM_NOT_FOUND);
    const cur = this.roomOf(session);
    if (cur === room) {
      if (!room.spectatorOf(session.playerId)) return fail(ERR.ALREADY, 'seated as a player');
      this.discovery.forget(session.playerId);
      this.sendState(room, session);
      return OK;
    }
    if (this.emergency.active) return fail(ERR.SERVER_EMERGENCY);
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    const admission = this.assetCacheAdmission(assetCache);
    if (admission) return admission;
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    if (room.spectators.length >= MAX_SPECTATORS) return fail(ERR.ROOM_FULL, 'no free spectator seat');
    if (cur) this.removeMember(cur, session.playerId);
    room.spectators.push({ playerId: session.playerId, name: session.name, connected: session.connected });
    session.roomCode = room.code;
    this.discovery.forget(session.playerId);
    session.notice = null;
    session.pendingResult = null;
    this.broadcastState(room);
    if (room.match) {
      this.callMatch(room, 'addSpectator', session.playerId);
      this.sendChatState(room, session.playerId);
    }
    return OK;
  }

  /** room.removeSpectator (host, any time): the spectator gets room.closed {kicked} and its seat is freed. */
  removeSpectator(session, { playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (!room.spectatorOf(playerId)) return fail(ERR.BAD_TARGET, 'not a spectator of this room');
    const target = this.registry.byId(playerId);
    const wasHere = !!target && target.roomCode === room.code;
    const replay = this.replayFor(room, playerId);
    this.removeMember(room, playerId);
    if (wasHere) {
      // like room.kick: now, or on the next resume (with the result replay, as after the grace timeout)
      if (target.connected) sendSession(target, { t: 'room.closed', reason: 'kicked' });
      else { target.notice = 'kicked'; target.pendingResult = replay; }
    }
    return OK;
  }

  ready(session, { ready }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const seat = room.seatOf(session.playerId);
    if (seat.ready !== ready) {
      seat.ready = ready;
      this.broadcastState(room);
    }
    return OK;
  }

  /** Resize only empty trailing seats; retain readiness and never move or eject a human or an AI. */
  setCapacity(session, { capacity }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo' || !ROOM_CAPACITIES.includes(capacity)) return fail(ERR.BAD_MSG, 'invalid capacity');
    if (room.seats.some((s, i) => s && i >= capacity)) return fail(ERR.BAD_TARGET, 'occupied seat outside requested capacity');
    if (room.capacity === capacity) return OK;
    this.dropReplay(room, session.playerId);
    if (capacity > room.capacity) room.seats.push(...new Array(capacity - room.capacity).fill(null));
    else room.seats.length = capacity;
    room.capacity = capacity;
    this.broadcastState(room);
    return OK;
  }

  /** Only a co-op waiting-room host controls public admission; invitations and observation stay available. */
  setMatchmaking(session, { allowed }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode !== 'coop') return fail(ERR.BAD_TARGET, 'solo rooms cannot be matched');
    if (typeof allowed !== 'boolean') return fail(ERR.BAD_MSG, 'invalid matchmaking policy');
    if (room.allowMatchmaking === allowed) return OK;
    this.dropReplay(room, session.playerId);
    room.allowMatchmaking = allowed;
    this.broadcastState(room);
    return OK;
  }

  setDifficulty(session, { difficulty }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    if (room.difficulty !== difficulty) {
      room.difficulty = difficulty;
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

  /** Accept old clients enabling the rule, but never disable this branch's fixed manual-human-first ordering. */
  setAiPicksLast(session, { on }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo') return fail(ERR.BAD_TARGET, 'solo rooms have no AI teammates');
    if (!on) return fail(ERR.BAD_TARGET, 'manual players always pick first in this capacity branch');
    this.dropReplay(room, session.playerId);
    return OK;
  }

  addBot(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo rooms cannot have AI teammates');
    const idx = room.freeSeat();
    if (idx < 0) return fail(ERR.ROOM_FULL);
    if (this.maxAiPerRoom !== null && room.seats.filter((s) => s?.isBot).length >= this.maxAiPerRoom) {
      return fail(ERR.AI_LIMIT);
    }
    const used = new Set(room.seats.filter((s) => s && s.isBot).map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `AI·${idx + 1}`;
    let playerId;
    do playerId = 'ai_' + randomBytes(4).toString('hex'); while (room.seatOf(playerId));
    room.seats[idx] = { seat: idx, playerId, name, isBot: true, ready: true, connected: true, left: false };
    this.broadcastState(room);
    return OK;
  }

  removeBot(session, { seat, playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const target = room.seats[seat];
    if (!target || !target.isBot) return fail(ERR.BAD_TARGET, 'seat does not hold an AI');
    if (playerId !== undefined && target.playerId !== playerId) return fail(ERR.BAD_TARGET, 'seat changed hands');
    room.seats[seat] = null;
    this.broadcastState(room);
    return OK;
  }

  /** Waiting-room handover to a connected human; identity is checked again after the confirmation dialog. */
  transferHost(session, { playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    const target = room.seatOf(playerId);
    const targetSession = this.registry.byId(playerId);
    if (!target || target.isBot || target.left || !target.connected || target.playerId === session.playerId
      || !targetSession?.connected || targetSession.roomCode !== room.code) {
      return fail(ERR.BAD_TARGET, 'target must be another connected human in this room');
    }
    this.dropReplay(room, session.playerId);
    room.hostId = playerId;
    this.promoteHostSeat(room);
    this.broadcastState(room);
    this.log.info(`[lobby] ${room.code} host transferred to ${target.name}`);
    return OK;
  }

  /** Host removes another human before the match (header: room.kick). */
  kick(session, { seat, playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const target = room.seats[seat];
    if (!target || target.left) return fail(ERR.BAD_TARGET, 'seat holds no player');
    if (target.playerId !== playerId) return fail(ERR.BAD_TARGET, 'seat changed hands'); // the confirmed player left meanwhile
    if (target.isBot) return fail(ERR.BAD_TARGET, 'seat holds an AI (room.removeBot)');
    if (target.playerId === session.playerId) return fail(ERR.BAD_TARGET, 'cannot kick yourself');
    const kicked = this.registry.byId(target.playerId);
    const wasHere = !!kicked && kicked.roomCode === room.code;
    const replay = this.replayFor(room, target.playerId);
    this.removeMember(room, target.playerId);
    if (wasHere) {
      if (kicked.connected) sendSession(kicked, { t: 'room.closed', reason: 'kicked' });
      else { kicked.notice = 'kicked'; kicked.pendingResult = replay; }
    }
    this.log.info(`[lobby] ${room.code} ${target.name} removed by the host`);
    return OK;
  }

  // ---------------------------------------------------------------------------------------------------
  // ⇄ 换位 (LoL-style champion swap)
  //
  // User request 2026-10-12: the OLD shape of this feature (the host moves anybody at once) is NOT what we ship. A
  // swap is a negotiation between two humans and nothing else: any human may ask any other human (never itself, never
  // an AI, never a spectator), the asked player confirms, and an ask that nobody answers inside `swapTtlMs` counts as
  // a refusal. Seat exchange itself reuses room.moveSeat's semantics (header): the seat RECORDS travel with their
  // index, so a moved human keeps its playerId, loadout, ownership and DIY picks, while the room's fixed draft groups
  // follow the occupied seat order (shared/playerCapacity.js) and therefore change with the swap.
  //
  // 准备后不再换位 (user rule, 2026-10-12): a seat that already readied for its draft group is never moved — the asker
  // and the target must BOTH be unready when the ask is made AND when it is answered. Unlike setDifficulty, which
  // regroups the WHOLE room and therefore un-readies the others, a swap moves two seat RECORDS between two indices:
  // everybody else keeps the seat index — and so the draft group — they readied for, so no third doctor's 准备 is
  // touched (只清当事人的准备状态, user rule the same day: and the two parties are unready by definition).
  // ---------------------------------------------------------------------------------------------------

  /** The negotiation a player takes part in — as its author (`from`) or its target (`to`) — or null. */
  swapOf(room, playerId) {
    for (const swap of room.swaps.values()) if (swap.from === playerId || swap.to === playerId) return swap;
    return null;
  }

  /** Forget one negotiation: stop its TTL timer. Nothing is sent here — the callers tell the two sides. */
  dropSwap(room, swap) {
    if (!swap) return;
    if (swap.timer) { clearTimeout(swap.timer); swap.timer = null; }
    if (room.swaps.get(swap.from) === swap) room.swaps.delete(swap.from);
  }

  /** `room.swapEnded` to both sides, so the target's dialog closes on the asker's decision as well as on its own. */
  notifySwapEnded(room, swap, reason) {
    this.sendToPlayer(room, swap.from, { t: 'room.swapEnded', with: swap.to, reason });
    this.sendToPlayer(room, swap.to, { t: 'room.swapEnded', with: swap.from, reason });
  }

  /** Void every negotiation a player takes part in — leaving, disconnecting and being kicked all mean the same. */
  dropSwapsFor(room, playerId) {
    for (const swap of [...room.swaps.values()]) {
      if (swap.from !== playerId && swap.to !== playerId) continue;
      this.dropSwap(room, swap);
      this.notifySwapEnded(room, swap, 'voided');
    }
  }

  /** Void every negotiation of a room at once (the match started, the room is going away). */
  clearSwaps(room, reason) {
    for (const swap of [...room.swaps.values()]) {
      this.dropSwap(room, swap);
      this.notifySwapEnded(room, swap, reason);
    }
  }

  /**
   * A seat a swap may move right now: a seated, connected, UNREADY human whose session still lives in this room.
   * @returns {Seat | null} the seat, or null when the player is a bot, a spectator, gone, offline or already readied
   */
  swappableSeat(room, playerId) {
    const seat = room.seatOf(playerId);
    if (!seat || seat.isBot || seat.left || !seat.connected || seat.ready) return null;
    const session = this.registry.byId(playerId);
    if (!session || !session.connected || session.roomCode !== room.code) return null;
    return seat;
  }

  /**
   * ⇄ 换位 (header): any human asks another human to exchange seats before the match. The asker needs an unready seat
   * of its own, the target an unready seat and one live negotiation per player (a second ask, or one pointed at
   * somebody already negotiating, is refused).
   */
  swapAsk(session, { to }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo') return fail(ERR.BAD_TARGET, 'a solo room has one seat');
    if (to === session.playerId) return fail(ERR.BAD_TARGET, 'a doctor cannot swap seats with itself');
    const mine = room.seatOf(session.playerId);
    if (!mine || mine.isBot || mine.left) return fail(ERR.SPECTATOR);
    // 准备后不再换位: whoever readied for a draft group stays where that group put them
    if (mine.ready) return fail(ERR.NOT_READY, 'a doctor who is ready cannot swap seats');
    const target = room.seatOf(to);
    if (!target || target.isBot || target.left) return fail(ERR.BAD_TARGET, 'the target must be another human in this room');
    if (target.ready) return fail(ERR.NOT_READY, 'the target is ready and cannot swap seats');
    const targetSession = this.registry.byId(to);
    if (!targetSession || !targetSession.connected || targetSession.roomCode !== room.code) {
      return fail(ERR.BAD_TARGET, 'the target must be connected');
    }
    if (room.swaps.has(session.playerId)) return fail(ERR.ALREADY, 'this doctor already has an outgoing swap request');
    if (this.swapOf(room, to)) return fail(ERR.BAD_TARGET, 'the target is already negotiating a swap');
    const swap = { from: session.playerId, to, expiresAt: this.now() + this.swapTtlMs, timer: null };
    swap.timer = setTimeout(() => this.expireSwap(room, swap), this.swapTtlMs);
    swap.timer.unref?.();
    room.swaps.set(session.playerId, swap);
    this.sendToPlayer(room, to, { t: 'room.swapAsked', from: session.playerId, fromName: mine.name, ttlMs: this.swapTtlMs });
    this.log.info(`[lobby] ${room.code} ${mine.name} asks ${target.name} to swap seats`);
    this.broadcastState(room);
    return OK;
  }

  /** The ask's window ran out: a timeout IS a refusal — nothing moves and both sides are told. */
  expireSwap(room, swap) {
    if (room.disposed || room.swaps.get(swap.from) !== swap) return;
    this.dropSwap(room, swap);
    this.notifySwapEnded(room, swap, 'timeout');
    this.log.info(`[lobby] ${room.code} seat swap ${swap.from} -> ${swap.to} timed out`);
    this.broadcastState(room);
  }

  /**
   * The target's decision (header: room.swapAnswer). Consent alone is never enough: both seats are re-checked against
   * the CURRENT room — still seated, still connected, still before the match, still unready — and an ask that no longer
   * applies is voided instead of moving anybody. That is also what makes 准备后不再换位 hold when the target readies
   * while the dialog is open.
   */
  swapAnswer(session, { from, accept }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    const swap = room.swaps.get(from) || null;
    if (!swap || swap.to !== session.playerId) return fail(ERR.BAD_TARGET, 'no pending swap request from that doctor');
    const a = this.swappableSeat(room, swap.from);
    const b = this.swappableSeat(room, swap.to);
    const readied = !!(room.seatOf(swap.from)?.ready || room.seatOf(swap.to)?.ready);
    this.dropSwap(room, swap);
    if (!accept) {
      this.notifySwapEnded(room, swap, 'declined');
      this.broadcastState(room);
      return OK;
    }
    if (room.match) {
      this.notifySwapEnded(room, swap, 'voided');
      this.broadcastState(room);
      return fail(ERR.ROOM_STARTED, 'the match started while the swap was pending');
    }
    if (!a || !b) {
      this.notifySwapEnded(room, swap, 'voided');
      this.broadcastState(room);
      return fail(readied ? ERR.NOT_READY : ERR.BAD_TARGET, 'the swap no longer applies');
    }
    this.exchangeSeats(room, a, b);
    this.notifySwapEnded(room, swap, 'accepted');
    this.log.info(`[lobby] ${room.code} ${a.name} <-> ${b.name} swapped seats`);
    this.broadcastState(room);
    return OK;
  }

  /** The asker withdraws its own ask; the target's dialog closes on the same frame. */
  swapCancel(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    const swap = room.swaps.get(session.playerId) || null;
    if (!swap) return fail(ERR.BAD_TARGET, 'no outgoing swap request');
    this.dropSwap(room, swap);
    this.notifySwapEnded(room, swap, 'cancelled');
    this.broadcastState(room);
    return OK;
  }

  /**
   * Exchange two seat records (room.moveSeat's semantics, header): the records travel with their index and keep
   * playerId / loadout / ownership / DIY picks.
   *
   * Nobody's ready flag is touched — not the two parties', not a bystander's (user rule, 2026-10-12:
   * 只清当事人的准备状态). Both parties are provably unready here (swappableSeat re-checked them), so clearing them
   * would be a no-op; and a third doctor who readied for the draft group its OWN seat index belongs to keeps that
   * seat index through somebody else's swap, so its readiness still describes the group it readied for. Un-readying
   * everybody, the way setDifficulty does when it changes the grouping itself, would silently disarm a third
   * player's 准备 for a regroup that never moved them.
   */
  exchangeSeats(room, a, b) {
    if (a.seat === b.seat) return;
    const from = a.seat;
    const to = b.seat;
    a.seat = to;
    b.seat = from;
    room.seats[to] = a;
    room.seats[from] = b;
  }

  start(session) {
    if (this.emergency.active) return fail(ERR.SERVER_EMERGENCY);
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    const humans = room.activeHumans();
    for (const s of humans) {
      if (s.playerId !== room.hostId && (!s.connected || !s.ready)) return fail(ERR.NOT_READY);
    }
    const bots = room.seats.filter((s) => s && s.isBot);
    if (this.maxAiPerRoom !== null && bots.length > this.maxAiPerRoom) return fail(ERR.AI_LIMIT);
    if (humans.length < 1 || (room.mode === 'solo' && (humans.length !== 1 || bots.length > 0))) {
      return fail(ERR.BAD_MSG, 'invalid seat configuration');
    }
    const key = session.limitKey || null;
    if (key && this.opts.maxMatchesPerAddr > 0 && this.countRooms((r) => !!r.match && r.matchKey === key) >= this.opts.maxMatchesPerAddr) {
      this.limitWarn(`match limit (${this.opts.maxMatchesPerAddr}) reached for ${session.addr}`);
      return fail(ERR.RATE, 'too many running matches from your network');
    }
    return this.startMatch(room, key);
  }

  /** Host authorization stays in the lobby; the match owns the vote and setup. */
  rerollSetup(session, msg, cancel = false) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    const method = cancel ? 'cancelSetupReroll' : 'requestSetupReroll';
    if (!room.match || typeof room.match[method] !== 'function') return fail(ERR.WRONG_PHASE);
    return this.callMatch(room, method, session.playerId, cancel ? msg.voteId : msg.setupRevision) || fail(ERR.INTERNAL);
  }

  /**
   * room.loadout (DESIGN §16): check the operator loadout — and its per-operator 潜能 / 练度 `ops` (0.2.2) — against the
   * game data, store both on the session and the seat, and — while a match runs — hand them to the match (accepted only
   * during INFO_CHECK, see the header). Either part refused: nothing is stored.
   */
  loadout(session, { entries, ops }) {
    const data = this.safeData();
    const res = checkLoadout(entries, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(res && isErrCode(res.error) ? res.error : ERR.BAD_MSG, res && res.detail);
    const ids = opsCharIds(data);
    const resOps = checkLoadoutOps(ops, (id) => ids.has(id));
    if (!resOps || resOps.error) return fail(resOps && isErrCode(resOps.error) ? resOps.error : ERR.BAD_MSG, resOps && resOps.detail);
    const loadout = freezeLoadout(res.loadout);
    const opsSet = freezeOps(resOps.ops);
    session.loadout = loadout;
    session.ops = opsSet;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) { seat.loadout = loadout; seat.ops = opsSet; }
    if (!room.match || !seat) return OK; // a spectator's loadout stays on its session, never reaching the match
    if (typeof room.match.setLoadout !== 'function') return fail(ERR.ROOM_STARTED, 'stored for the next match');
    let r;
    try {
      r = room.match.setLoadout(session.playerId, loadout, opsSet);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.setLoadout threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (r && typeof r === 'object' && r.error) {
      return fail(isErrCode(r.error) ? r.error : ERR.INTERNAL, typeof r.detail === 'string' ? r.detail : undefined);
    }
    return OK;
  }

  /**
   * room.skins (docs/SKINS.md): store the player's chosen operator skins on the session and the seat,
   * and hand them to a running match. No phase gate (unlike the loadout): a skin is cosmetic and public.
   */
  skins(session, { skins }) {
    const data = this.safeData();
    const cleaned = freezeSkins(skins, (id) => lookup('chess', id, data));
    session.skins = cleaned;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.skins = cleaned;
    if (!room.match) return OK;
    if (typeof room.match.setSkins !== 'function') return fail(ERR.ROOM_STARTED, 'stored for the next match');
    let r;
    try {
      r = room.match.setSkins(session.playerId, cleaned);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.setSkins threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (r && typeof r === 'object' && r.error) {
      return fail(isErrCode(r.error) ? r.error : ERR.INTERNAL, typeof r.detail === 'string' ? r.detail : undefined);
    }
    return OK;
  }

  /**
   * room.ownership (0.2.0 补位): keep the droppable chess of the not-owned list, store it on the session and the seat
   * (see the header). A running match never takes it: it keeps the list its seat had at its start.
   */
  ownership(session, { notOwned }) {
    const data = this.safeData();
    const res = checkNotOwned(notOwned, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(ERR.BAD_MSG, res && res.detail);
    const list = Object.freeze(res.notOwned.slice());
    session.notOwned = list;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.notOwned = list;
    if (room.match && seat) return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return OK;
  }

  /**
   * room.diy (0.2.0 自选编队): keep the legal picks (checkDiyPicks against the data and KITTED_CHARS), store them on the
   * session and the seat (see the header). A running match never takes them: it keeps the picks its seat had at its
   * start.
   */
  diy(session, { picks }) {
    const res = checkDiyPicks(picks, { data: this.safeData(), kitted: KITTED_CHARS });
    if (!res || !('ok' in res)) return fail(ERR.BAD_MSG, res && res.detail);
    const kept = freezeDiy(res.picks);
    session.diy = kept;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.diy = kept;
    if (room.match && seat) return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return OK;
  }

  /** Extra welcome fields: supported 自选 operators and the current owner-controlled precache policy. */
  welcomeInfo() {
    return { diyKitted: KITTED_CHARS, requireAssetCache: this.requireAssetCache, emergency: this.emergency };
  }

  // ---------------------------------------------------------------------------------------------------
  // Match wiring
  // ---------------------------------------------------------------------------------------------------

  /** @param {Room} room @param {string | null} [key] per-network limit key of the starter */
  startMatch(room, key = null) {
    const host = room.seatOf(room.hostId);
    if (host) host.ready = true;
    // ⇄ 换位: the waiting room is over — every negotiation in flight is void, no late answer may move a seat
    this.clearSwaps(room, 'voided');
    const seats = room.seats.filter(Boolean).map((s) => ({
      seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, connected: s.connected,
      // DESIGN §16: the human's checked operator loadout and (0.2.2) per-operator 潜能 / 练度 (bots fight with the defaults)
      loadout: s.isBot ? null : s.loadout || null,
      ops: s.isBot ? null : s.ops || null,
      skins: s.isBot ? null : s.skins || null,
      // 0.2.0 补位: the chess the human marked as not owned (bots own every operator)
      notOwned: s.isBot ? null : s.notOwned || null,
      // 0.2.0 自选编队: the human's checked DIY picks (bots field no 自选 piece [ASSUMED])
      diy: s.isBot ? null : s.diy || null,
    }));
    // lastPublic / results: the latest m.public broadcast and the m.result frames (encoded), kept for the replay.
    const ctx = { live: true, ended: false, disposed: false, match: null, lastPublic: null, sharedResult: null,
      results: new Map(), chat: new MatchChat({ now: this.now }) };
    let seed = 0;
    try { seed = this.seedFn() >>> 0; } catch { seed = randomInt(2 ** 32); }
    try {
      const match = new this.MatchClass({
        roomCode: room.code,
        mode: room.mode,
        difficulty: room.difficulty,
        modeId: modeIdFor(room.mode, room.difficulty),
        // 「AI 队友最后选择」 (GitHub #338): fixed for the match
        aiPicksLast: room.mode !== 'solo' && room.aiPicksLast === true,
        seats,
        // the spectator seats (header): watched like eliminated players, never players
        spectators: room.spectators.map((s) => s.playerId),
        seed,
        // the room's match number: with the seed it keeps battleIds unique across the room's matches (DESIGN §14)
        matchNo: room.matchCount + 1,
        data: this.safeData(),
        log: this.log,
        now: this.now,
        send: (playerId, msg) => (ctx.live ? this.matchSend(room, ctx, playerId, msg) : false),
        broadcast: (msg) => { if (ctx.live) this.matchBroadcast(room, ctx, msg); },
        onEnd: (summary) => this.onMatchEnd(room, ctx, summary),
      });
      ctx.match = match;
      room.match = match;
      room.matchCtx = ctx;
      room.matchKey = key;
      room.replay = null;
      room.matchCount++;
      this.log.info(`[lobby] ${room.code} match #${room.matchCount} starting (${room.mode}/${room.difficulty}, ${seats.length} seats, seed ${seed})`);
      this.broadcastState(room);
      match.start();
      if (room.matchCtx === ctx && !ctx.chat.closed) this.broadcastRoom(room, ctx.chat.snapshot());
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match failed to start`, e);
      if (room.matchCtx === ctx) { room.match = null; room.matchCtx = null; room.matchKey = null; }
      this.disposeMatchCtx(ctx);
      this.broadcastState(room);
      return fail(ERR.INTERNAL, 'match failed to start');
    }
    return OK;
  }

  /** onEnd callback: return the room to LOBBY and dispose the match on the next macrotask. */
  onMatchEnd(room, ctx, summary) {
    if (ctx.ended || !ctx.live || room.matchCtx !== ctx || room.disposed) return;
    ctx.ended = true;
    ctx.chat.clear();
    room.lastSummary = summary ?? null;
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = this.buildReplay(room, ctx);
    setImmediate(() => this.disposeMatchCtx(ctx));
    this.log.info(`[lobby] ${room.code} match #${room.matchCount} ended`);
    for (let i = 0; i < room.seats.length; i++) {
      const s = room.seats[i];
      if (!s || s.isBot) continue;
      if (s.left) { room.seats[i] = null; continue; }
      s.ready = false;
      if (!s.connected) this.startGrace(room, s);
    }
    for (const s of room.spectators) if (!s.connected) this.startGrace(room, s);
    const host = room.hostId ? room.seatOf(room.hostId) : null;
    if (!host || host.isBot || host.left) this.migrateHost(room);
    this.trimBots(room);
    this.promoteHostSeat(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else this.broadcastState(room);
  }

  /** Match unicast; m.result frames are also kept for the replay. */
  matchSend(room, ctx, playerId, msg) {
    if (msg && msg.t === 'm.result') {
      ctx.chat.clear();
      const data = encode(msg);
      if (data != null) ctx.results.set(playerId, data);
    }
    return this.sendToPlayer(room, playerId, msg);
  }

  /** Match broadcast; the latest m.public and a broadcast m.result are also kept for the replay. */
  matchBroadcast(room, ctx, msg) {
    if (msg?.t === 'm.result' || (msg?.t === 'm.public' && msg.phase === PHASE.RESULT)) ctx.chat.clear();
    const data = this.broadcastRoom(room, msg);
    if (data == null) return;
    if (msg.t === 'm.public') ctx.lastPublic = data;
    else if (msg.t === 'm.result') ctx.sharedResult = data;
  }

  /**
   * Replay record for the humans still seated when a match ends (null when the match produced no m.result,
   * e.g. it was abandoned: those clients then see "simulation closed").
   * @param {Room} room @returns {Room['replay']}
   */
  buildReplay(room, ctx) {
    const frames = new Map();
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || s.isBot || s.left) continue;
      const frame = ctx.results.get(s.playerId) || ctx.sharedResult;
      if (frame) frames.set(s.playerId, frame);
    }
    if (frames.size === 0) return null;
    return { publicFrame: ctx.lastPublic, frames, pending: new Set(frames.keys()) };
  }

  /** The replay frames still owed to a player (null when they moved on). @returns {string[] | null} */
  replayFor(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.has(playerId)) return null;
    return [r.publicFrame, r.frames.get(playerId)].filter(Boolean);
  }

  /** The player moved on from the result screen (acted in the room, left): stop replaying it. */
  dropReplay(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.delete(playerId)) return;
    r.frames.delete(playerId);
    if (r.pending.size === 0) room.replay = null;
  }

  /**
   * The heavy part of a resync — full match state (match.onReconnect) or, back in LOBBY, the result replay.
   * Immediate after a (re)connect; for repeated hellos on a live socket at most once per resyncMinGapMs
   * (requests inside the window coalesce into one deferred resync).
   * @param {import('./net.js').Session} session @param {boolean} coalesce
   */
  resync(session, coalesce) {
    const pid = session.playerId;
    if (coalesce) {
      if (this.resyncTimers.has(pid)) return; // the scheduled resync answers this request too
      const wait = (Number.isFinite(session.resyncAt) ? session.resyncAt : -Infinity) + this.opts.resyncMinGapMs - this.now();
      if (wait > 0) {
        const t = setTimeout(() => { this.resyncTimers.delete(pid); this.runResync(session); }, wait);
        t.unref?.();
        this.resyncTimers.set(pid, t);
        return;
      }
    } else {
      this.clearResync(pid);
    }
    this.runResync(session);
  }

  /** @param {import('./net.js').Session} session */
  runResync(session) {
    if (!session.connected || this.registry.byId(session.playerId) !== session) return;
    const room = this.roomOf(session);
    if (!room) return;
    session.resyncAt = this.now();
    if (room.match) {
      this.callMatch(room, room.spectatorOf(session.playerId) ? 'addSpectator' : 'onReconnect', session.playerId);
      this.sendChatState(room, session.playerId);
      return;
    }
    const frames = this.replayFor(room, session.playerId);
    if (frames) for (const frame of frames) sendRaw(session.ws, frame);
  }

  clearResync(playerId) {
    const t = this.resyncTimers.get(playerId);
    if (t) { clearTimeout(t); this.resyncTimers.delete(playerId); }
  }

  /** Log a per-network limit refusal without letting a refusal loop flood the log. */
  limitWarn(text) {
    const now = this.now();
    if (now - this.limitLog.at < 10_000) { this.limitLog.suppressed++; return; }
    const more = this.limitLog.suppressed ? ` (+${this.limitLog.suppressed} similar refusals)` : '';
    this.limitLog.at = now;
    this.limitLog.suppressed = 0;
    this.log.warn(`[lobby] ${text}${more}`);
  }

  /** Number of rooms matching a predicate. */
  countRooms(pred) {
    let n = 0;
    for (const r of this.rooms.values()) if (pred(r)) n++;
    return n;
  }

  /** Route a 'g.*' intent to the running match. */
  routeGame(session, msg) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (!room.match) return fail(ERR.WRONG_PHASE, 'no running match');
    if (msg.t === 'g.leave') {
      this.removeMember(room, session.playerId);
      return OK;
    }
    // a spectator only watches (header): nothing else of it ever reaches the match
    if (msg.t !== 'g.watch' && room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    let res;
    try {
      res = room.match.handle(session.playerId, msg);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (res && typeof res.then === 'function') {
      // Contract violation (handle must be synchronous): never let the rejection go unhandled.
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) returned a Promise; it must be synchronous`);
      Promise.resolve(res).catch((e) => this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) rejected`, e));
      return OK;
    }
    if (res && typeof res === 'object' && res.error) {
      return fail(isErrCode(res.error) ? res.error : ERR.INTERNAL, typeof res.detail === 'string' ? res.detail : undefined);
    }
    return OK;
  }

  /** Match chat belongs to connected room humans, including eliminated/autoplay players and spectators. */
  chat(session, { matchId, text }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    const ctx = room.matchCtx;
    if (!room.match || !ctx?.live || ctx.ended || ctx.chat.closed || room.match.phase === PHASE.RESULT) {
      return fail(ERR.WRONG_PHASE, 'no running chat match');
    }
    if (matchId !== ctx.chat.matchId) return fail(ERR.BAD_TARGET, 'stale chat match');
    const member = room.seatOf(session.playerId) || room.spectatorOf(session.playerId);
    if (!session.connected || this.registry.byId(session.playerId) !== session || !member || member.isBot || member.left || !member.connected) {
      return fail(ERR.NOT_IN_ROOM);
    }
    const spectator = !!room.spectatorOf(session.playerId);
    const res = ctx.chat.append({ playerId: member.playerId, name: member.name, seat: spectator ? null : member.seat,
      spectator }, text);
    if (res.error) return fail(res.error, res.detail);
    this.broadcastRoom(room, res.message);
    return OK;
  }

  /** Single bounded history on start/join/resume, under the existing heavy resync policy. */
  sendChatState(room, playerId) {
    const ctx = room.matchCtx;
    if (!room.match || !ctx?.live || ctx.ended || ctx.chat.closed || room.match.phase === PHASE.RESULT) return;
    this.sendToPlayer(room, playerId, ctx.chat.snapshot());
  }

  /** Call an optional match hook without letting it throw. onLeave falls back to onDisconnect. */
  callMatch(room, method, ...args) {
    const m = room.match;
    if (!m) return undefined;
    let fn = m[method];
    if (typeof fn !== 'function' && method === 'onLeave') fn = m.onDisconnect;
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(m, args);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.${method} threw`, e);
      return undefined;
    }
  }

  disposeMatchCtx(ctx) {
    if (ctx.disposed) return;
    ctx.disposed = true;
    ctx.live = false;
    ctx.chat.clear();
    try { ctx.match?.dispose?.(); } catch (e) { this.log.error('[lobby] match.dispose threw', e); }
  }

  safeData() {
    try { return this.getData(); } catch (e) { this.log.error('[lobby] getData failed', e); return Object.freeze({}); }
  }

  /** How long a dropped solo run stays resumable (ms): the option, else data singleReconnectTime, else 24 h. */
  soloResumeWindowMs() {
    const o = this.opts.soloReconnectWindowMs;
    if (typeof o === 'number' && Number.isFinite(o) && o > 0) return o;
    const sec = this.safeData()?.config?.constants?.singleReconnectTime;
    return (typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? sec : SOLO_RECONNECT_FALLBACK_SEC) * 1000;
  }

  // ---------------------------------------------------------------------------------------------------
  // Membership helpers
  // ---------------------------------------------------------------------------------------------------

  /** The session's current room (self-heals stale `roomCode`). @returns {Room | null} */
  roomOf(session) {
    if (!session.roomCode) return null;
    const room = this.rooms.get(session.roomCode);
    const seat = room ? room.seatOf(session.playerId) : null;
    if (room && !seat && room.spectatorOf(session.playerId)) return room; // a spectator seat
    if (!room || !seat || seat.left || seat.isBot) { session.roomCode = null; return null; }
    return room;
  }

  /** @returns {Seat} */
  humanSeat(idx, session) {
    return {
      seat: idx, playerId: session.playerId, name: session.name, isBot: false, ready: false, connected: session.connected, left: false,
      loadout: session.loadout || null,
      ops: session.ops || null,
      skins: session.skins || null,
      notOwned: session.notOwned || null,
      diy: session.diy || null,
    };
  }

  /**
   * Remove a human from a room permanently (leave, grace timeout, expiry, switching rooms).
   * In LOBBY the seat is freed; during a match it is marked departed and match.onLeave is called.
   * @param {Room} room @param {string} playerId
   */
  removeMember(room, playerId) {
    this.discovery.forget(playerId);
    const session = this.registry.byId(playerId);
    if (session && session.roomCode === room.code) session.roomCode = null;
    this.clearGrace(playerId);
    this.dropReplay(room, playerId);
    this.dropSwapsFor(room, playerId);
    if (this.freeSpectatorSeat(room, playerId)) return;
    const seat = room.seatOf(playerId);
    if (!seat || seat.isBot || seat.left || room.disposed) return;
    room.matchCtx?.chat.forgetPlayer(playerId);
    if (room.match) {
      seat.left = true;
      seat.connected = false;
      seat.ready = false;
      this.callMatch(room, 'onLeave', playerId);
    } else {
      room.seats[seat.seat] = null;
    }
    if (room.disposed) return; // onLeave may have ended the match and emptied the room
    if (room.hostId === playerId) this.migrateHost(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else this.broadcastState(room);
  }

  /**
   * Free a spectator seat (removeMember): the match forgets the spectator; never a host change or a disposal — a
   * spectator neither holds the host nor keeps a room alive. @returns {boolean} true when it was a spectator seat
   */
  freeSpectatorSeat(room, playerId) {
    const i = room.spectators.findIndex((s) => s.playerId === playerId);
    if (i < 0) return false;
    room.spectators.splice(i, 1);
    room.matchCtx?.chat.forgetPlayer(playerId);
    if (room.disposed) return true;
    this.callMatch(room, 'removeSpectator', playerId);
    this.broadcastState(room);
    return true;
  }

  /** Lowest-seat connected human becomes host (else lowest-seat human, else null). */
  migrateHost(room) {
    const humans = room.activeHumans();
    const pick = humans.find((s) => s.connected) || humans[0] || null;
    const prev = room.hostId;
    room.hostId = pick ? pick.playerId : null;
    this.promoteHostSeat(room);
    if (pick && prev !== pick.playerId) this.log.info(`[lobby] ${room.code} host → ${pick.name}`);
  }

  /** Change waiting-room seat order only; a running match owns its original seats and fixed pool groups. */
  promoteHostSeat(room) {
    if (room.match || !room.hostId) return;
    const host = room.seatOf(room.hostId);
    if (!host || host.isBot || host.left || host.seat === 0) return;
    const oldIndex = host.seat;
    const first = room.seats[0];
    room.seats[0] = host;
    host.seat = 0;
    room.seats[oldIndex] = first;
    if (first) first.seat = oldIndex;
  }

  startGrace(room, seat) {
    const playerId = seat.playerId;
    this.clearGrace(playerId);
    const t = setTimeout(() => {
      this.graceTimers.delete(playerId);
      if (room.disposed || room.match) return;
      const s = room.seatOf(playerId) || room.spectatorOf(playerId);
      if (!s || s.connected) return;
      const session = this.registry.byId(playerId);
      if (session && session.roomCode === room.code) {
        session.notice = 'timeout';
        session.pendingResult = this.replayFor(room, playerId); // still shown after room.closed on resume
      }
      this.removeMember(room, playerId);
    }, this.opts.lobbyGraceMs);
    t.unref?.();
    this.graceTimers.set(playerId, t);
  }

  clearGrace(playerId) {
    const t = this.graceTimers.get(playerId);
    if (t) { clearTimeout(t); this.graceTimers.delete(playerId); }
  }

  /**
   * Delete a room, detach its members (room.closed unless the room simply emptied) and dispose its match.
   * @param {Room} room @param {string} reason
   */
  disposeRoom(room, reason) {
    if (room.disposed) return;
    room.disposed = true;
    if (this.rooms.get(room.code) === room) this.rooms.delete(room.code);
    this.discovery.changed();
    const ctx = room.matchCtx;
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = null;
    for (const swap of room.swaps.values()) if (swap.timer) clearTimeout(swap.timer);
    room.swaps.clear();
    for (const s of room.seats) {
      if (!s || s.isBot) continue;
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (s.left || reason === 'empty') continue;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    // spectators did not leave: they are told whatever closed the room (its last human leaving included)
    for (const s of room.spectators) {
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    if (ctx) this.disposeMatchCtx(ctx);
    this.log.info(`[lobby] ${room.code} disposed (${reason})`);
  }

  genCode() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LEN; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------------------------------

  /** Connected, non-departed human sessions of a room — its spectators included (room.state, match broadcasts). */
  *memberSessions(room) {
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || s.isBot || s.left) continue;
      const session = this.registry.byId(s.playerId);
      if (session && session.connected && session.roomCode === room.code) yield session;
    }
  }

  broadcastState(room) {
    if (room.disposed) return;
    this.discovery.changed();
    const frame = prepareMessage(room.toState(this.now()));
    for (const session of this.memberSessions(room)) sendPrepared(session.ws, frame);
  }

  sendState(room, session) {
    sendSession(session, room.toState(this.now()));
  }

  /** Match broadcast: encode once, send to every connected member. @returns {string | null} the encoded frame */
  broadcastRoom(room, msg) {
    if (room.disposed) return null;
    const frame = prepareMessage(msg);
    const data = frame.json;
    if (data == null) { this.log.error(`[lobby] ${room.code} unserializable broadcast ${msg && msg.t}`); return null; }
    const droppable = isDroppable(msg);
    for (const session of this.memberSessions(room)) sendPrepared(session.ws, frame, { droppable });
    return data;
  }

  /** Match unicast. @returns {boolean} */
  sendToPlayer(room, playerId, msg) {
    if (room.disposed) return false;
    const seat = room.seatOf(playerId) || room.spectatorOf(playerId);
    if (!seat || seat.isBot || seat.left) return false;
    const session = this.registry.byId(playerId);
    if (!session || session.roomCode !== room.code) return false;
    return sendSession(session, msg);
  }
}
