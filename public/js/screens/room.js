// Room screen (同盟等待室): configurable seat cards (avatar frame, name, ready state, AI badge, host crown),
// host controls (difficulty picker, add/remove AI in co-op, start), invite code with copy code /
// copy link, ready toggle and leave.
// The capacity branch keeps manual humans first within every fixed draft group (D004); the room shows it read-only.
//
// Start rule (server/lobby.js): room.start needs every *other* human connected and ready; the
// host's start counts as the host's ready. So 开始模拟 is enabled exactly then and sends room.start
// alone (no separate room.ready round trip that could leave the host "ready" after a failed start).
// Solo rooms show a single seat.
// Spectator seats (community report #26, a remake feature): a co-op room with spectators shows the 观战席 strip under
// the seats — names, offline marks, the host's ✕ (room.removeSpectator) — and a spectator's own view swaps the ready
// button for 观战中 and offers 入座 (room.join of the room) while a player seat is free.
// ⇄ 换位 (LoL-style champion swap, user request 2026-10-12): ANY human may ask ANOTHER human to exchange seats before
// the match — the asked player confirms in a dialog (with a countdown) and the SERVER moves the seats, this screen
// only renders the frames it receives. Both sides must be unready (准备后不再换位), so the ⇄ shows greyed out with the
// reason when they are not; a negotiation in flight is published in room.state.swaps for both sides and bystanders.
// Plugins (DESIGN §32 P1a): the tag under the title — 「原版」 or 「插件 ×N」 — opens the 插件 panel (ui/pluginPanel.js:
// the host switches the room's plugins, everybody else reads them). With gameplay plugins (§32.6: a content set of its
// own — the tag reads 「非官方」 too) every seat shows whether its page has loaded and checked the room's content
// (seats[].content: 载入中 / 就绪 / 校验失败), 准备就绪 and 开始模拟 wait for it (the server refuses them before:
// CONTENT_NOT_READY), and a plugin mode the host chose shows beside the difficulty.
// Texts go through t() (docs/I18N.md).

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { DIFFICULTIES, DIFFICULTY_NAMES, DIFFICULTY_COLORS, MAX_SEATS, DEFAULT_SEATS, ROOM_CAPACITIES, PREP_SCALES, prepScaleOf, MAX_SPECTATORS } from '../../../shared/constants.js';
import {
  html, Button, Icon, MicroLabel, PingPill, AvatarFrame, DifficultyTag, DifficultyIcon, Tooltip, confirmDialog, doctorNo, useTicker, Modal,
} from '../ui/components.js';
import { toast, toastError } from '../ui/toasts.js';
import { copyText } from '../ui/clipboard.js';
import { GuideButton } from '../ui/guide.js';
import { AssetCacheButton } from '../ui/assetCache.js';
import { openStats } from './stats.js';
import { SettingsButton } from '../ui/settings.js';
import { LoadoutButton } from './loadout.js';
import { PluginTag, isModdedRoom } from '../ui/pluginTag.js';
import { hasScriptConsent, rememberScriptConsent } from '../content.js';
import { net } from '../net.js';
import { data } from '../data.js';
import { chessAvatarUrl } from '../ui/assetUrls.js';
import { roomAvatarUrl } from '../ui/skins.js';
import { store, useStore, shallowEqual, emptyMatch, isSpectating, serverNow } from '../store.js';
import { poolGroupOf, poolGroupSizes, GROUPED_POOL_MIN_PLAYERS } from '../../../shared/playerCapacity.js';
import { difficultyInfo } from './lobby.js';
import { t, tc, N_ } from '../../../shared/i18n.js';

/**
 * Seats padded to the room's capacity (co-op 4–20, solo 1), each null or a seat record.
 * @param {any} room room.state payload
 * @returns {(null | {seat:number, playerId:any, name:string, isBot:boolean, ready:boolean, connected:boolean})[]}
 */
export function normalizeSeats(room) {
  const src = Array.isArray(room?.seats) ? room.seats : [];
  const requested = Number.isInteger(room?.capacity) ? room.capacity : src.length || DEFAULT_SEATS;
  const cap = room?.mode === 'solo' ? 1 : Math.max(1, Math.min(MAX_SEATS, requested));
  const out = [];
  for (let i = 0; i < cap; i++) {
    const s = src[i];
    out.push(s && typeof s === 'object' ? { ...s, seat: Number.isInteger(s.seat) ? s.seat : i } : null);
  }
  return out;
}

/**
 * Derived room facts for the local player.
 * @param {any} room
 * @param {any} myId
 */
export function roomFacts(room, myId) {
  const seats = normalizeSeats(room);
  const occupied = seats.filter(Boolean);
  const humans = occupied.filter((s) => !s.isBot);
  const mine = occupied.find((s) => s.playerId === myId) || null;
  const isHost = room?.hostId != null && room.hostId === myId;
  const others = humans.filter((s) => s.playerId !== myId);
  // The host never readies: starting the match is the host's ready (server rule), so the count
  // treats the host as ready — "已就绪 0/1" next to "准许进入模拟" would contradict itself.
  const isReady = (s) => !!s.ready || s.playerId === room?.hostId;
  const readyHumans = humans.filter(isReady).length;
  const othersReady = others.every((s) => s.ready && s.connected !== false);
  const emptySeats = seats.filter((s) => !s).length;
  const botCount = occupied.filter((s) => s.isBot).length;
  const maxAiPerRoom = Number.isInteger(room?.maxAiPerRoom) && room.maxAiPerRoom >= 0 ? room.maxAiPerRoom : null;
  const aiLimitReached = maxAiPerRoom !== null && botCount >= maxAiPerRoom;
  const aiLimitExceeded = maxAiPerRoom !== null && botCount > maxAiPerRoom;
  const waiting = !room?.inMatch;
  const spectating = isSpectating(room, myId);
  const swaps = swapState(room, myId);
  // ⇄ 换位 needs a seat of one's own, a waiting co-op room and an unready seat (user rule 2026-10-12: 准备后不再换位)
  const canSwap = waiting && room?.mode !== 'solo' && !!mine && !mine.isBot && !mine.left && mine.connected !== false
    && !spectating && !mine.ready;
  // a room with gameplay plugins (DESIGN §32.6): every player's page has loaded and checked its content (the host's too)
  const modded = isModdedRoom(room);
  const contentReady = !modded || humans.every((s) => s.content === 'ready');
  return {
    seats, occupied, humans, mine, isHost, readyHumans, isReady,
    emptySeats, botCount, maxAiPerRoom, aiLimitReached, aiLimitExceeded,
    allowMatchmaking: room?.allowMatchmaking !== false,
    coop: room?.mode !== 'solo',
    inMatch: !waiting,
    swaps,
    canSwap,
    canSetMatchmaking: waiting && isHost && room?.mode === 'coop' && !!mine && !mine.isBot && !mine.left,
    canAddBot: waiting && isHost && room?.mode !== 'solo' && emptySeats > 0 && !aiLimitReached,
    transferableHumans: waiting && isHost && !!mine
      ? others.filter((s) => s.connected !== false && !s.left) : [],
    canStart: waiting && isHost && othersReady && !!mine && !aiLimitExceeded && contentReady
      && (!room?.content?.trusted || humans.every((s) => room.content.trusted.consent[s.seat])),
    othersReady,
    // fixed draft groups of this occupancy (shared/playerCapacity.js; server/match/pool.js uses the same rule)
    groups: poolGroups(room, seats),
    modded,
    contentReady,
    myContent: modded ? (mine?.content || 'loading') : 'ready',
    // spectator seats (never players: not in `humans`, never counted for ready / start)
    spectators: Array.isArray(room?.spectators) ? room.spectators.filter((s) => s && typeof s === 'object') : [],
    spectating,
  };
}

/**
 * The upstream 「AI 队友最后选择」 indicator follows D004 in this branch: online manual humans choose before AI,
 * managed and disconnected seats within each fixed group. Solo rooms have no teammates; co-op always shows it on
 * and read-only, including frames from an older server that omit the flag.
 * @param {any} room room.state payload
 * @returns {{ on: boolean, editable: boolean } | null}
 */
/** A seat shows its group chip only when the occupancy actually splits into several groups (5 or fewer share one). */
export function roomShowsGroups(room, facts) {
  return room?.mode !== 'solo' && Array.isArray(facts?.groups) && facts.groups.length > 1;
}

/**
 * 切换到观战 (0.2.4, the owner's request): may THIS doctor give its seat up and watch instead? The server is the gate
 * (server/lobby.js `seatToSpectate`) — this only decides the button's state and its hint, mirroring the server's rules
 * one for one: a seated human of a co-op room, a free spectator seat (MAX_SPECTATORS) and at least one other doctor to
 * keep the room. `reason` is a msgid the caller translates ('' when there is nothing to say).
 * @param {any} room room.state payload @param {string} myId
 * @returns {{ can: boolean, reason: string }} the reason (msgid) is non-empty only when `can` is false
 */
export function spectateSwitchGate(room, myId) {
  const facts = roomFacts(room, myId);
  const mine = facts.mine;
  if (!mine || mine.isBot || mine.left) return { can: false, reason: '' };      // no seat of one's own: nothing to give up
  // the owner's hard rule (2026-10-12): the switch is a waiting-room action only — the server refuses it in a match
  if (room?.inMatch) return { can: false, reason: N_('开局后无法切换观战') };
  if (room?.mode === 'solo') return { can: false, reason: N_('单人局没有观战席') };
  if (facts.spectators.length >= MAX_SPECTATORS) return { can: false, reason: N_('观战席已满') };
  if (facts.humans.filter((s) => s.playerId !== myId).length === 0) {
    return { can: false, reason: N_('你是同盟里唯一的博士，切换观战会让同盟解散') };
  }
  return { can: true, reason: '' };
}

/**
 * The fixed draft group sizes of a room: the server's `room.state.groups` when it sent one, else computed from the
 * occupied seat count with the shared rule (a state from an older server). A room of five or fewer has one shared
 * pool: the server omits `groups` there and this returns [] — never a single "A 组" label for a whole room.
 * @param {any} room room.state payload
 * @param {(null | {seat:number})[]} [seats] an already normalized seat list
 * @returns {number[]} one size per group, in occupied seat order
 */
export function poolGroups(room, seats) {
  if (!room || room.mode === 'solo') return [];
  if (Array.isArray(room.groups) && room.groups.every((n) => Number.isInteger(n) && n > 0)) return room.groups.slice();
  const occupied = (seats || normalizeSeats(room)).filter(Boolean).length;
  if (occupied < 1) return [];
  try {
    const sizes = poolGroupSizes(occupied);
    return sizes.length > 1 ? sizes : [];
  } catch { return []; }
}

/**
 * 0-based fixed draft group of a seat index, or -1 without a group. `rank` is the seat's position among the occupied
 * seats in seat order — the same order server/match/pool.js assigns groups in, so client and server always agree.
 * @param {number} rank position in occupied seat order
 * @param {number} occupied number of occupied seats
 */
export function seatGroup(rank, occupied) {
  const group = poolGroupOf(rank, occupied);
  return group >= 0 && occupied >= GROUPED_POOL_MIN_PLAYERS ? group : -1;
}

/**
 * The group the SERVER gave this seat (`room.state.seats[i].group`, the wire contract), or the locally computed one
 * for a state from an older server. -1 means "no group" (an empty seat, or one shared pool for the whole room).
 * @param {any} seat the seat record
 * @param {number} rank its position in occupied seat order
 * @param {number} occupied occupied seats in the room
 */
export function seatGroupOf(seat, rank, occupied) {
  if (!seat) return -1;
  if (Number.isInteger(seat.group) && seat.group >= 0) return seat.group;
  return seatGroup(rank, occupied);
}

/** 'A'…'Z' for a 0-based group number (a 20-seat room has at most five groups). */
export function groupLetter(index) {
  return index >= 0 && index < 26 ? String.fromCharCode(65 + index) : '';
}

/**
 * The fixed draft group of a seat (「A 组」). The five group colours are fixed per group index (A green, B orange,
 * C purple, D blue, E pink, then they cycle) and are carried ONLY here — the seat card's left edge, its badge — so
 * they never collide with the per-seat avatar hue (SEAT_HUES, ui/components.js).
 */
export const GROUP_COLORS = ['#4ed8af', '#f6a329', '#a06bff', '#4ea8ff', '#ff6fae'];

/** The colour of a 0-based group index (cycles past the fifth group). */
export function groupColor(index) {
  return GROUP_COLORS[index >= 0 ? index % GROUP_COLORS.length : 0];
}

function GroupChip({ group }) {
  const letter = groupLetter(group);
  if (!letter) return null;
  const label = t('{group}组', { group: letter });
  return html`<span class="seat__group" style=${`--group-color:${groupColor(group)}`}
    title=${t('本组内共享卡池')} aria-label=${label}>${label}</span>`;
}

/**
 * 候室皮肤 (user decision 2026-10-12): the operator avatar of a teammate's chosen skin, or null when there is
 * nothing to draw (the seat card then keeps its own glyph — never a blank avatar).
 *
 * 口径: `room.state.seats[].skins` is `{ [baseChessId]: skinId }` (docs/SKINS.md, the same map the match takes),
 * and a waiting room has no "chosen operator" yet — the loadout is per-player and private until the match. So the
 * FIRST key in sorted order that resolves to a real chess record (and, through it, to a real avatar) is used as
 * that doctor's representative. `chessAvatarUrl` already falls back to the operator's own art for an unknown skin
 * id, so a skin the local manifest does not have shows the 原皮 instead of nothing.
 * @param {any} seat a room.state seat record
 * @param {any} m the assets manifest (`data.get('assets')`)
 * @param {(group: string, id: string) => any} [lookup] chess lookup (injected by tests)
 * @returns {string|null}
 */
export function skinAvatarFor(seat, m, lookup = (group, id) => data.lookup(group, id)) {
  const table = seat && typeof seat === 'object' && seat.skins && typeof seat.skins === 'object' ? seat.skins : null;
  if (!table || !m) return null;
  for (const id of Object.keys(table).sort()) {
    const chess = lookup('chess', id);
    if (!chess) continue;
    const url = chessAvatarUrl(m, chess, table[id]);
    if (url) return url;
  }
  return null;
}

/**
 * The art a room seat card draws for one doctor, or null (the card then keeps its own default placeholder glyph).
 *
 * 房间头像 (user decision 2026-10-13: 「房间里的头像，只会选择整个干员列表里顺位第一的干员皮肤，没法换成其他的」): the
 * avatar is the art the player explicitly picked on the 皮肤 screen, published as `room.state.seats[].avatar`
 * (`{ chessId, skinId? }`) and resolved by the shared resolver (ui/skins.js roomAvatarUrl — the same
 * `chessAvatarUrl` every other avatar uses, so a 精锐 id reaches its base card and an unknown skin falls back to
 * the operator's own art).
 *
 * ⚠️ There is deliberately NO "representative skin" fallback here: picking whichever skin sorted first was
 * exactly the bug this replaces, because it showed a stranger's operator and never changed. A seat with no
 * avatar shows the default placeholder — the doctor's own choice, or nothing.
 * @param {any} seat a room.state seat record
 * @param {any} m the assets manifest (`data.get('assets')`)
 * @param {(group: string, id: string) => any} [lookup] chess lookup (injected by tests)
 * @returns {string|null}
 */
export function seatAvatarFor(seat, m, lookup = (group, id) => data.lookup(group, id)) {
  if (!seat || typeof seat !== 'object' || seat.isBot || !m) return null;
  return roomAvatarUrl(m, seat.avatar, lookup);
}

/** The card's own group colour: the --group-color the border, the badge and the totals row all read. */
function cardStyle(index, group) {
  const tint = group >= 0 ? `--group-color:${groupColor(group)};` : '';
  return `${tint}--seat-i:${index}`;
}
const groupedClass = (group) => (group >= 0 ? ' is-grouped' : '');

export function aiLastOption(room) {
  if (!room || room.mode === 'solo') return null;
  return { on: true, editable: false };
}

/** Invite link for a room code (current page URL with ?room=CODE). */
export function inviteLink(code) {
  const loc = globalThis.location;
  const base = loc ? `${loc.origin}${loc.pathname}` : '';
  return `${base}?room=${encodeURIComponent(code)}`;
}

/**
 * Copy text to the clipboard (async API with a textarea fallback for insecure contexts). Moved to ui/clipboard.js so
 * 干员调配 can use it without importing this screen (which imports loadout.js): re-exported here for existing callers.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export { copyText };

/**
 * ⇄ 换位 (header): a seat swap is a NEGOTIATION between two humans, never a host decision — anybody may ask anybody
 * else to exchange seats before the match, the asked player confirms, and the server moves the seats only then. This
 * module therefore READS `room.state.swaps` (the negotiations in flight, `[{ from, to, ttlMs }]`) and rearranges no
 * seat of its own: the layout below is the last frame the server sent, so nothing here can show a swap too early.
 * @param {any} room room.state payload
 * @param {any} myId
 * @returns {{ all: any[], mine: any|null, incoming: any|null, busy: Set<string> }} `mine` = the ask this player sent
 *   and is waiting on, `incoming` = the ask addressed to this player, `busy` = everybody taking part in a negotiation
 */
export function swapState(room, myId) {
  const all = Array.isArray(room?.swaps) ? room.swaps.filter((s) => s && typeof s === 'object') : [];
  const busy = new Set();
  let mine = null;
  let incoming = null;
  for (const swap of all) {
    busy.add(swap.from);
    busy.add(swap.to);
    if (swap.from === myId) mine = swap;
    else if (swap.to === myId) incoming = swap;
  }
  return { all, mine, incoming, busy };
}

/**
 * Whether the local player may ask `seat` for a swap right now, and — when not — the reason the greyed-out ⇄ shows.
 * One helper drives BOTH the button and its tests, and every condition it names is enforced by the server too
 * (server/lobby.js swapAsk / swapAnswer), so a stale frame can only make the button optimistic, never move a seat.
 * @param {ReturnType<typeof roomFacts>} facts
 * @param {any} seat the other player's seat record
 * @param {any} myId
 * @returns {{ show: boolean, allowed: boolean, hint: string|null }}
 */
export function swapTargetSeat(facts, seat, myId) {
  const mine = facts.mine;
  const show = !!mine && !mine.isBot && !mine.left && facts.coop && !facts.spectating;
  if (!seat || seat.isBot || seat.playerId === myId || !facts.coop) return { show: false, allowed: false, hint: null };
  let hint = null;
  if (facts.inMatch) hint = t('开局后无法换位');
  else if (mine?.ready) hint = t('准备后无法换位');
  else if (facts.swaps.mine) hint = t('等待对方确认…');
  else if (seat.connected === false || seat.left) hint = t('对方已离线，无法换位');
  else if (seat.ready) hint = t('对方已准备，无法换位');
  else if (facts.swaps.busy.has(seat.playerId)) hint = t('对方正在协商换位');
  return { show, allowed: hint === null, hint: hint || t('请求与该博士交换位置') };
}

/** {@link swapTargetSeat} straight off a `room.state` payload, for callers (and tests) without a `facts` object. */
export function swapTarget(room, myId, seat) {
  return swapTargetSeat(roomFacts(room, myId), seat, myId);
}

/**
 * ⇄ 换到空位 (user request 2026-10-13): the SAME ⇄ control, but aimed at an EMPTY seat — nobody holds it, so there
 * is nobody to ask and the click goes straight to the server (room.moveToEmpty; no dialog). One helper drives the
 * button and its tests, and every rule it names is server-enforced too (server/lobby.js moveToEmpty): an unready
 * seated human of a waiting co-op room, 开赛后不再出现, 准备后置灰. The empty seat is `null` in `room.state.seats[]`.
 * @param {ReturnType<typeof roomFacts>} facts
 * @param {number} index the EMPTY seat's index
 * @param {any} myId
 * @returns {{ show: boolean, allowed: boolean, hint: string|null }}
 */
export function moveToEmptySeat(facts, index, myId) {
  const mine = facts.mine;
  const show = !!mine && !mine.isBot && !mine.left && facts.coop && !facts.inMatch && !facts.spectating;
  if (!show || !Number.isInteger(index)) return { show: false, allowed: false, hint: null };
  let hint = null;
  // the host IS the seat-0 record while the room waits (server promoteHostSeat), so it never leaves P1 this way
  if (facts.isHost) hint = t('房主固定在 P1，无法换到空位');
  else if (mine.ready) hint = t('准备后无法换位');
  else if (facts.swaps.mine) hint = t('等待对方确认…');
  return { show, allowed: hint === null, hint: hint || t('换到该空位') };
}

/** {@link moveToEmptySeat} straight off a room.state payload, for callers (and tests) without a `facts` object. */
export function moveToEmpty(room, myId, index) {
  return moveToEmptySeat(roomFacts(room, myId), index, myId);
}

/**
 * The countdown anchor of an incoming ask. `room.state.swaps[].ttlMs` is the remainder the SERVER recomputed for the
 * frame just received, so the local deadline is `serverNow() + ttlMs` — re-taken only when a frame changes that pair,
 * because taking it on every render would freeze the countdown at its first value. The value is display-only: the
 * server ends the negotiation and its `room.state` is what removes the dialog.
 * @param {{ current: { key: string, deadline: number } | null }} ref
 * @param {any} ask `facts.swaps.incoming`
 * @returns {number} the deadline in `serverNow()` terms, or 0 while no ask is pending
 */
export function swapDeadline(ref, ask) {
  if (!ask) { ref.current = null; return 0; }
  const ttl = Math.max(0, Number(ask.ttlMs) || 0);
  const key = `${ask.from}:${ttl}`;
  if (!ref.current || ref.current.key !== key) ref.current = { key, deadline: serverNow() + ttl };
  return ref.current.deadline;
}

export function SeatCard({ seat, index, room, facts, myId, busy, group = -1, onAddBot, onRemoveBot, onKick, onTransferHost, onSwap, onMoveToEmpty }) {
  const coop = room.mode !== 'solo';
  const chip = group >= 0 ? html`<${GroupChip} group=${group} />` : null;
  // 房间头像 (user decision 2026-10-13): the art this doctor picked on the 皮肤 screen, or null ⇒ the card keeps
  // its own default placeholder glyph. AvatarFrame also falls back on a load error, so a missing file never
  // leaves a blank avatar.
  const skin = seatAvatarFor(seat, data.get('assets'));
  if (!seat) {
    const canAdd = coop && facts.isHost;
    // ⇄ 换到空位 (user request 2026-10-13): this empty seat has nobody to negotiate with, so the ⇄ moves the clicker
    // at once — 准备后置灰, 开赛后 the frame is inMatch and the control is gone. Occupied seats keep the negotiation.
    const move = moveToEmptySeat(facts, index, myId);
    return html`<article class=${`seat seat--empty${groupedClass(group)}`} style=${cardStyle(index, group)}>
      <header class="seat__head"><span class="seat__no num">P${index + 1}</span><${MicroLabel}>SEAT ${String(index + 1).padStart(2, '0')}<//>${chip}</header>
      <div class="seat__art seat__art--empty">
        <div class="seat__radar" aria-hidden="true"></div>
        <span class="seat__wait">${t('等待博士加入')}</span>
        <${MicroLabel}>AWAITING DOCTOR<//>
      </div>
      <footer class="seat__foot">
        ${canAdd
          ? html`<${Button} variant="secondary" size="sm" icon="robot" block=${true} loading=${busy === `add`}
              disabled=${!!busy || !facts.canAddBot} title=${facts.aiLimitReached ? t('已达到服务器允许的 AI 队友上限') : undefined}
              onClick=${onAddBot}>${t('添加 AI 队友')}<//>`
          : move.show ? null : html`<span class="seat__state t-dim">${t('空位')}</span>`}
        ${move.show ? html`<${Tooltip} text=${move.hint}>
          <${Button} variant="secondary" size="sm" square=${true} icon="swap" loading=${busy === `move${index}`}
            disabled=${!!busy || !move.allowed} onClick=${() => onMoveToEmpty(index)}
            data-testid=${`move-empty-${index}`} aria-label=${t('换到该空位')} />
        <//>` : null}
      </footer>
    </article>`;
  }
  const consent = room.content?.trusted?.consent?.[seat.seat];
  const isMe = seat.playerId === myId;
  const isHostSeat = seat.playerId === room.hostId;
  const swapping = facts.swaps.busy.has(seat.playerId);
  const swap = swapTargetSeat(facts, seat, myId);
  const offline = seat.connected === false && !seat.isBot;
  // The host never needs to toggle ready: starting the match readies them (server rule).
  const state = offline ? 'offline' : seat.ready || seat.isBot ? 'ready' : isHostSeat ? 'host' : 'waiting';
  return html`<article class=${`seat brackets${isMe ? ' is-me' : ''}${isHostSeat ? ' is-host' : ''}${seat.isBot ? ' is-bot' : ''} is-${state}${groupedClass(group)}`}
      style=${cardStyle(index, group)}>
    ${consent ? html`<span data-testid="script-consented">${t('已同意')}</span>` : null}
    <header class="seat__head">
      <span class="seat__no num">P${index + 1}</span>
      <${MicroLabel}>SEAT ${String(index + 1).padStart(2, '0')}<//>
      ${chip}
      ${isHostSeat ? html`<span class="seat__host"><${Icon} name="crown" />${t('房主')}</span>` : null}
    </header>
    <div class="seat__art">
      <div class="seat__stripes" aria-hidden="true"></div>
      <${AvatarFrame} size="xl" name=${seat.name} src=${skin} seat=${index} bot=${seat.isBot} self=${isMe} ready=${state === 'ready'} offline=${offline} />
      ${seat.isBot ? html`<span class="seat__bot-label"><${Icon} name="robot" />${t('AI 队友')}</span>` : null}
    </div>
    <div class="seat__who">
      <span class="seat__name">${seat.name || t('博士')}</span>
      ${isMe ? html`<span class="seat__you">${t('你')}</span>` : null}
      ${swapping ? html`<span class="seat__swapping"><${Icon} name="swap" />${t('协商中')}</span>` : null}
    </div>
    <${MicroLabel}>${seat.isBot ? 'AUTONOMOUS UNIT' : `DOCTOR #${doctorNo(seat.playerId)}`}<//>
    ${facts.modded && !seat.isBot ? html`<span class=${`seat__content is-${seat.content || 'loading'}`} data-testid="seat-content">
      ${seat.content === 'ready' ? t('插件内容就绪') : seat.content === 'failed' ? t('插件内容校验失败') : t('插件内容载入中')}
    </span>` : null}
    <footer class="seat__foot">
      <span class=${`seat__state seat__state--${state}`}>
        ${state === 'ready' ? html`<${Icon} name="check" />${t('已就绪')}`
          : state === 'offline' ? html`<${Icon} name="wifiOff" />${t('连接中断')}`
          : state === 'host' ? html`<${Icon} name="crown" />${t('待命中')}`
          : html`<${Icon} name="hourglass" />${t('准备中')}`}
      </span>
      ${facts.isHost && (seat.isBot || !isMe) ? html`<div class="seat__actions">
        ${!seat.isBot && !offline && facts.transferableHumans.some((s) => s.playerId === seat.playerId) ? html`<${Tooltip} text=${t('转让房主给该博士')}>
          <${Button} variant="secondary" size="sm" square=${true} icon="crown" loading=${busy === `transfer${index}`}
            disabled=${!!busy} onClick=${() => onTransferHost(index, seat.name, seat.playerId)} aria-label=${t('转让房主给该博士')} />
        <//>` : null}
        ${seat.isBot ? html`<${Tooltip} text=${t('移除该 AI 队友')}>
          <${Button} variant="ghost" size="sm" square=${true} icon="close" loading=${busy === `rm${index}`} disabled=${!!busy}
            onClick=${() => onRemoveBot(index, seat.playerId)} aria-label=${t('移除 AI 队友')} />
        <//>` : html`<${Tooltip} text=${t('将该博士移出同盟')}>
          <${Button} variant="ghost" size="sm" square=${true} icon="close" loading=${busy === `kick${index}`} disabled=${!!busy}
            onClick=${() => onKick(index, seat.name, seat.playerId)} aria-label=${t('移出该博士')} />
        <//>`}
      </div>` : null}
      ${swap.show ? html`<div class="seat__swap">
        <${Tooltip} text=${swap.hint}>
          <${Button} variant="secondary" size="sm" square=${true} icon="swap" loading=${busy === `swap${index}`}
            disabled=${!!busy || !swap.allowed} onClick=${() => onSwap(index, seat.name, seat.playerId)}
            data-testid=${`swap-${index}`} aria-label=${t('请求与该博士交换位置')} />
        <//>
      </div>` : null}
    </footer>
  </article>`;
}

/** 观战席: the room's spectators (host: ✕ frees a seat), and 入座 for a spectator while a player seat is free. */
function SpectatorBar({ facts, myId, busy, onRemove, onSit }) {
  if (!facts.spectators.length) return null;
  return html`<section class="specbar" aria-label=${t('观战席')}>
    <span class="specbar__label"><${Icon} name="eye" />${t('观战席')}<b class="num">${facts.spectators.length}</b><span class="num t-dim">/${MAX_SPECTATORS}</span></span>
    ${facts.spectators.map((s) => html`<span key=${s.playerId} class=${`specbar__who${s.playerId === myId ? ' is-me' : ''}${s.connected === false ? ' is-offline' : ''}`}>
      ${s.connected === false ? html`<${Icon} name="wifiOff" />` : null}${s.name || t('博士')}${s.playerId === myId ? html`<span class="seat__you">${t('你')}</span>` : null}
      ${facts.isHost ? html`<${Button} variant="ghost" size="sm" square=${true} icon="close" loading=${busy === `rs${s.playerId}`}
        onClick=${() => onRemove(s.playerId)} aria-label=${t('移出观战者 {name}', { name: s.name || '' })} title=${t('移出该观战者')} />` : null}
    </span>`)}
    ${facts.spectating && facts.emptySeats > 0 ? html`<${Button} size="sm" icon="user" loading=${busy === 'sit'} onClick=${onSit}>${t('入座')}<//>` : null}
  </section>`;
}

function InviteBox({ code, name, difficulty }) {
  const copy = async (what) => {
    // the copied link carries an invitation line (#103): 「{name}邀请你加入卫戍协议：盟约【{difficulty}】」
    const invite = t('{name}邀请你加入卫戍协议：盟约【{difficulty}】', { name: name ?? '', difficulty: DIFFICULTY_NAMES[difficulty] ? t(DIFFICULTY_NAMES[difficulty]) : '' });
    const ok = await copyText(what === 'code' ? code : `${inviteLink(code)} ${invite}`);
    if (ok) toast(what === 'code' ? t('已复制同盟密钥 {code}', { code }) : t('已复制邀请链接'), 'success');
    else toast(t('复制失败，请手动复制'), 'warn');
  };
  return html`<div class="invite brackets">
    <div class="invite__label"><${Icon} name="key" /><span>${t('同盟密钥')}</span><${MicroLabel}>ALLIANCE KEY<//></div>
    <div class="invite__code num selectable" aria-label=${t('同盟密钥 {code}', { code })}>${[...String(code)].map((ch, i) => html`<span key=${i}>${ch}</span>`)}</div>
    <div class="invite__btns">
      <${Button} size="sm" icon="copy" onClick=${() => copy('code')}>${t('复制密钥')}<//>
      <${Button} size="sm" icon="link" onClick=${() => copy('link')}>${t('复制链接')}<//>
    </div>
  </div>`;
}

function DifficultyPicker({ room, isHost, busy, onPick }) {
  if (!isHost) {
    return html`<div class="dpick dpick--ro">
      <${DifficultyTag} difficulty=${room.difficulty} size="lg" code=${difficultyInfo(room.mode, room.difficulty).code} />
      <span class="t-dim">${t('由房主选择')}</span>
    </div>`;
  }
  return html`<div class="dpick" role="radiogroup" aria-label=${t('模拟难度')}>
    ${DIFFICULTIES.map((d) => html`<button key=${d} type="button" role="radio" aria-checked=${room.difficulty === d ? 'true' : 'false'}
        class=${`dpick__opt${room.difficulty === d ? ' is-active' : ''}`} style=${`--d-color:${DIFFICULTY_COLORS[d]}`}
        disabled=${!!busy} onClick=${() => room.difficulty !== d && onPick(d)}>
      <${DifficultyIcon} difficulty=${d} />${t(DIFFICULTY_NAMES[d].replace('模拟', ''))}
    </button>`)}
  </div>`;
}

/** Waiting-room policy follows room.state, including the permission change after host transfer. */
export function MatchmakingControl({ facts, busy, connected, onChange }) {
  const on = facts.allowMatchmaking;
  const label = on ? t('允许匹配') : t('禁止匹配');
  const hint = t('关闭后不会参与最快匹配，也不能从房间列表加入；持有邀请码仍可加入，观战不受影响。');
  const cls = `room-matchmaking${on ? ' is-on' : ' is-private'}`;
  return facts.canSetMatchmaking
    ? html`<button type="button" class=${`${cls} tapx`} role="switch" aria-checked=${on ? 'true' : 'false'}
        aria-label=${t('允许匹配')} title=${hint} data-testid="room-matchmaking"
        disabled=${!!busy || !connected} onClick=${() => onChange(!on)}><${Icon} name=${on ? 'check' : 'close'} />${label}</button>`
    : html`<span class=${cls} role="status" title=${hint} data-testid="room-matchmaking-state"><${Icon} name=${on ? 'check' : 'close'} />${label}</span>`;
}

/** 准备时间倍率 (room.setPrepScale): the room bar's second host control, shaped like 人数上限's picker. A member who
 * is not the host reads the current factor — room.state.prepScale is the server's, the only writer. */
function PrepScalePicker({ room, facts, busy, connected, onPick }) {
  const scale = prepScaleOf(room.prepScale);
  const hint = t('仅联机计时生效；单人/人机休整期不计时。');
  const label = html`<span class="room-prep__label">${t('准备时间')} <b class="num">${'×' + scale}</b></span>`;
  if (!facts.isHost) {
    return html`<div class="room-prep" aria-label=${t('准备时间')} title=${hint}>
      ${label}<span class="t-dim">${t('由房主设置')}</span>
    </div>`;
  }
  return html`<div class="room-prep" aria-label=${t('准备时间')} title=${hint} data-testid="room-prep-scale">
    ${label}<div class="room-prep__options" role="radiogroup" aria-label=${t('准备时间')}>
      ${PREP_SCALES.map((v) => html`<button key=${v} type="button" role="radio" aria-checked=${scale === v ? 'true' : 'false'}
        class=${`room-prep__opt${scale === v ? ' is-active' : ''}`} disabled=${!!busy || !connected}
        data-testid=${`room-prep-${v}`} onClick=${() => v !== scale && onPick(v)}>${'×' + v}</button>`)}
    </div>
  </div>`;
}

function CapacityPicker({ room, facts, busy, connected, onPick, onMatchmaking }) {
  const capacity = room.capacity || facts.seats.length;
  const minCapacity = Math.max(1, ...facts.occupied.map((s) => s.seat + 1));
  // 「A 组 4 人 · B 组 4 人」 — one chip per group, in the group's own colour (nothing while the room is one pool)
  const perGroup = facts.groups.length > 1
    ? facts.groups.map((size, g) => ({ g, size })).filter((x) => x.size > 0)
    : [];
  return html`<div class="room-capacity" aria-label=${t('同盟席位')}>
    <span class="room-capacity__label">${t('人数上限')} <b class="num">${capacity}</b> ${t('人')}</span>
    ${facts.isHost ? html`<div class="room-capacity__options" role="radiogroup" aria-label=${t('调整同盟人数上限')}>
      ${ROOM_CAPACITIES.map((n) => html`<button key=${n} type="button" role="radio" aria-checked=${capacity === n ? 'true' : 'false'}
        class=${`room-capacity__opt${capacity === n ? ' is-active' : ''}`} disabled=${!!busy || n < minCapacity}
        title=${n < minCapacity ? t('先移除超出席位的玩家') : t('{n} 人房间', { n })}
        onClick=${() => n !== capacity && onPick(n)}>${n}</button>`)}
    </div>` : html`<span class="t-dim">${t('由房主设置')}</span>`}
    <span class="room-capacity__count num">${facts.occupied.length} / ${capacity}</span>
    ${perGroup.length ? html`<span class="room-groups" aria-label=${t('组别')}>
      ${perGroup.map(({ g, size }) => html`<span key=${g} class="room-groups__item" style=${`--group-color:${groupColor(g)}`}>
        <b>${t('{group}组', { group: groupLetter(g) })}</b><span class="num">${size}</span>${t('人')}
      </span>`)}
    </span>` : null}
    <${MatchmakingControl} facts=${facts} busy=${busy} connected=${connected} onChange=${onMatchmaking} />
    ${facts.maxAiPerRoom !== null ? html`<span class=${`room-ai-limit${facts.aiLimitReached ? ' is-full' : ''}`} role="status"
        title=${facts.aiLimitReached ? t('已达到服务器允许的 AI 队友上限') : t('服主设置的每房 AI 队友上限')}>
      <${Icon} name="robot" />${t('AI 队友 {used} / {limit}', { used: facts.botCount, limit: facts.maxAiPerRoom })}
      ${facts.aiLimitReached ? html`<span>${t('已达上限')}</span>` : null}
    </span>` : null}
  </div>`;
}

/** D004 is a fixed co-op rule, including managed and disconnected human seats after manual humans. */
function AiLastRule({ option }) {
  if (!option) return null;
  return html`<div class="ailast">
    <${Tooltip} text=${t('本分支固定由在线且未托管的博士先选，AI、托管和掉线席位随后选择')}>
      <button type="button" role="switch" aria-checked=${option.on ? 'true' : 'false'}
          class=${`dpick__opt ailast__opt${option.on ? ' is-active' : ''}`} disabled=${true}>
        <${Icon} name="check" class=${option.on ? 'is-on' : ''} />${t('AI 队友最后选择')}
      </button>
    <//>
    <span class="t-dim">${t('固定规则')}</span>
  </div>`;
}

/** The asker's own view while it waits: which doctor was asked, and how to take the ask back. */
function SwapBar({ facts, busy, onCancel }) {
  const mine = facts.swaps.mine;
  if (!mine) return null;
  const to = facts.occupied.find((s) => s.playerId === mine.to) || null;
  return html`<section class="swapbar" role="status" data-testid="swap-pending">
    <${Icon} name="swap" class="swapbar__icon" />
    <span class="swapbar__text">${t('等待「{name}」确认换位…', { name: to?.name || t('博士') })}</span>
    <${Button} variant="ghost" size="sm" icon="close" loading=${busy === 'swapCancel'} disabled=${!!busy}
      onClick=${onCancel} data-testid="swap-cancel">${t('撤销换位请求')}<//>
  </section>`;
}

/**
 * The asked player's dialog: who asks, which two seats are meant, a live countdown and the two answers. Escape and the
 * backdrop do not dismiss it — the ask is the server's, so the dialog lives exactly as long as room.state keeps it.
 */
function SwapDialog({ facts, busy, left, onAnswer }) {
  const ask = facts.swaps.incoming;
  if (!ask) return null;
  const asker = facts.occupied.find((s) => s.playerId === ask.from) || null;
  const a = Number.isInteger(asker?.seat) ? asker.seat + 1 : 0;
  const b = Number.isInteger(facts.mine?.seat) ? facts.mine.seat + 1 : 0;
  return html`<div class="swapdlg" role="presentation">
    <div class="swapdlg__box brackets" role="dialog" aria-modal="true" aria-label=${t('换位请求')} data-testid="swap-dialog">
      <${MicroLabel} tone="mint">SEAT SWAP<//>
      <h2 class="swapdlg__title"><${Icon} name="swap" />${t('换位请求')}</h2>
      <p class="swapdlg__text">${t('「{name}」请求与你交换位置（P{a} ⇄ P{b}）。', { name: asker?.name || t('博士'), a, b })}</p>
      <p class="swapdlg__count num">${t('{n} 秒后自动拒绝', { n: left })}</p>
      <div class="swapdlg__btns">
        <${Button} variant="primary" size="lg" icon="check" loading=${busy === 'swapYes'} disabled=${!!busy || left <= 0}
          onClick=${() => onAnswer(ask.from, true)} data-testid="swap-accept">${t('同意交换')}<//>
        <${Button} variant="secondary" size="lg" icon="close" loading=${busy === 'swapNo'} disabled=${!!busy}
          onClick=${() => onAnswer(ask.from, false)} data-testid="swap-decline">${t('拒绝')}<//>
      </div>
    </div>
  </div>`;
}

/** Room screen component. */
export function RoomScreen() {
  const room = useStore((s) => s.room);
  const me = useStore((s) => s.me, shallowEqual);
  const conn = useStore((s) => s.connection, shallowEqual);
  const [busy, setBusy] = useState(null);
  const alive = useRef(true);
  const inFlight = useRef(false); // synchronous guard against double clicks (state updates are async)
  useEffect(() => () => { alive.current = false; }, []);

  // ⇄ 换位: `room.swapEnded` is a courtesy notice — the dialog also disappears when `room.state` stops carrying the
  // ask, so a missed frame costs the toast and nothing else (the seat order never came from this event).
  useEffect(() => {
    const text = {
      declined: t('换位被拒绝'), cancelled: t('换位请求已取消'), timeout: t('换位请求已超时'),
      voided: t('换位请求已失效'), accepted: t('已交换位置'),
    };
    return net.on('room.swapEnded', (msg) => {
      const line = text[msg?.reason];
      if (line) toast(line, msg.reason === 'accepted' ? 'success' : 'warn');
    });
  }, []);

  // Hooks run in the same order on every render: the ⇄ 换位 countdown is armed before the empty-room exit below.
  const facts = room ? roomFacts(room, me.playerId) : null;
  const pendingAsk = facts ? facts.swaps.incoming : null;
  const swapAnchor = useRef(null);
  const swapEndsAt = swapDeadline(swapAnchor, pendingAsk);
  useTicker(swapEndsAt ? 200 : 0);

  if (!room || !facts) return null;
  const online = conn.status === 'online';
  const coop = room.mode !== 'solo';
  const myReady = !!facts.mine?.ready;
  const info = difficultyInfo(room.mode, room.difficulty);
  const swapLeftS = swapEndsAt ? Math.max(0, Math.ceil((swapEndsAt - serverNow()) / 1000)) : 0;

  const showsGroups = roomShowsGroups(room, facts);
  // seat index → its position among the occupied seats (the order the fixed draft groups are cut in, server-side)
  const seatRanks = new Map(facts.seats.map((s, i) => [i, s ? -1 : -2]));
  let rank = 0;
  facts.seats.forEach((s, i) => { if (s) seatRanks.set(i, rank++); });
  // per seat, the group the server sent (room.state.seats[].group), else the shared rule for a seat-only frame
  const groupOf = (seat, at) => (showsGroups ? seatGroupOf(seat, seatRanks.get(at) ?? -1, facts.occupied.length) : -1);

  const run = async (kind, fn) => {
    if (inFlight.current) return;
    if (!online) { toast(t('连接中断，请稍候重试'), 'warn'); return; }
    inFlight.current = true;
    setBusy(kind);
    try { await fn(); } catch (err) { toastError(err); } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const toggleReady = () => run('ready', () => net.request('room.ready', { ready: !myReady }));
  const start = () => run('start', () => net.request('room.start', {}));
  const addBot = () => run('add', () => net.request('room.addBot', {}));
  const removeBot = (seat, playerId) => run(`rm${seat}`, () => net.request('room.removeBot', { seat, playerId }));
  // the host removes a human before the match (community report #17): asked first; the player may join again. The
  // confirmed player's id goes along: if they left and someone else took the seat meanwhile, the server refuses it.
  const kick = (seat, name, playerId) => run(`kick${seat}`, async () => {
    const ok = await confirmDialog({ title: t('移出同盟'), text: t('确定将「{name}」移出同盟吗？对方可以凭同盟密钥重新加入。', { name: name || t('博士') }), okText: t('移出'), danger: true });
    if (ok) await net.request('room.kick', { seat, playerId });
  });
  const transferHost = (seat, name, playerId) => run(`transfer${seat}`, async () => {
    const ok = await confirmDialog({ title: t('转让房主'),
      text: t('确定将房主转让给「{name}」吗？双方将交换席位，新房主位于 P1。', { name: name || t('博士') }),
      okText: t('转让') });
    if (ok) await net.request('room.transferHost', { playerId });
  });
  const setDifficulty = (difficulty) => run('diff', () => net.request('room.setDifficulty', { difficulty }));
  const setCapacity = (capacity) => run('capacity', () => net.request('room.setCapacity', { capacity }));
  const setMatchmaking = (allowed) => run('matchmaking', () => net.request('room.setMatchmaking', { allowed }));
  const setPrepScale = (prepScale) => run('prepscale', () => net.request('room.setPrepScale', { prepScale }));
  // spectator seats: the host frees one; a spectator takes a free player seat with room.join of this room
  const removeSpectator = (playerId) => run(`rs${playerId}`, () => net.request('room.removeSpectator', { playerId }));
  const sit = () => run('sit', () => net.request('room.join', { code: room.code }));
  // 切换到观战: the same room.spectate entry an outsider uses — a seated doctor rides the seat→spectator branch of it.
  // Nothing is guessed locally: the seats and the spectator strip only ever come from the next room.state frame.
  const toSpectate = async () => {
    if (!spectateGate.can || inFlight.current) return;
    inFlight.current = true;
    setBusy('spectate');
    try {
      await net.request('room.spectate', { code: room.code });
    } catch (err) {
      toastError(err);
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };
  // ⇄ 换位: ask another doctor for its seat. The target decides; the seats move when the server says so.
  // ⇄ 换到空位: nobody holds that seat, so there is nothing to confirm — one request, no dialog (server.moveToEmpty)
  const moveToEmptySeat = (seat) => run(`move${seat}`, () => net.request('room.moveToEmpty', { to: seat }));
  const askSwap = (seat, name, playerId) => run(`swap${seat}`, async () => {
    const yes = await confirmDialog({ title: t('换位请求'),
      text: t('确定向「{name}」发起换位请求吗？对方同意后双方席位才会互换。', { name: name || t('博士') }),
      okText: t('发起请求') });
    if (yes) await net.request('room.swapAsk', { to: playerId });
  });
  const answerSwap = (from, accept) => run(accept ? 'swapYes' : 'swapNo', () => net.request('room.swapAnswer', { from, accept }));
  const cancelSwap = () => run('swapCancel', () => net.request('room.swapCancel', {}));
  const leave = async () => {
    if (inFlight.current) return;
    const othersHere = facts.humans.some((s) => s.playerId !== me.playerId);
    if (facts.isHost && othersHere) {
      const ok = await confirmDialog({ title: t('离开同盟'), text: t('你是同盟的房主，离开后房主身份将移交或同盟解散。确定离开吗？'), okText: t('离开'), danger: true });
      if (!ok) return;
    }
    inFlight.current = true;
    setBusy('leave');
    try {
      await net.request('room.leave', {});
    } catch (err) {
      if (err?.code !== 'NOT_IN_ROOM') toastError(err);
    } finally {
      // Leaving locally is always safe: the server either confirmed or no longer has us in the room.
      store.set({ room: null, match: emptyMatch() });
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };

  const spectateGate = spectateSwitchGate(room, me.playerId);
  const statusLine = !online
    ? html`<span class="t-orange"><${Icon} name="wifiOff" />${t('连接中断，正在重连…')}</span>`
    : facts.spectating
      ? html`<span class="t-lo"><${Icon} name="eye" />${t('观战中 · 不占博士席位，模拟开始后可切换观看各位博士')}</span>`
    : !coop
      ? html`<span class="t-mint">${t('*模拟协议已就绪，准许进入模拟')}</span>`
    : facts.modded && !facts.contentReady
      ? html`<span class="t-lo">${t('等待所有博士载入房间的插件内容')}</span>`
    : facts.isHost
      ? facts.canStart
        ? html`<span class="t-mint">${t('*同盟人数达标，准许进入模拟')}</span>`
        : html`<span class="t-lo">${t('等待所有博士准备就绪')}</span>`
      : myReady
        ? html`<span class="t-mint">${t('已就绪 · 等待房主开始模拟')}</span>`
        : html`<span class="t-lo">${t('准备就绪后，房主即可开始模拟')}</span>`;

  return html`<div class="screen room-screen">
    <header class="topbar">
      <div class="topbar__left">
        <${AssetCacheButton} compact=${true} />
        <${Tooltip} text=${t('离开同盟')} placement="bottom">
          <${Button} variant="danger" size="lg" square=${true} icon="exit" loading=${busy === 'leave'} onClick=${leave} aria-label=${t('离开同盟')} />
        <//>
        ${facts.mine ? html`<span class="room-spectate" data-spectate=${spectateGate.can ? 'on' : 'off'} data-reason=${spectateGate.reason}
            title=${spectateGate.can ? t('放弃席位，改为观看本局（房间密钥不变）') : t(spectateGate.reason)}>
          <${Button} variant="secondary" size="sm" icon="eye" loading=${busy === 'spectate'} disabled=${!spectateGate.can || !online}
            onClick=${toSpectate} aria-label=${t('切换到观战')}>${t('切换到观战')}<//>
        </span>` : null}
        <div class="room-ping">
          <${PingPill} ms=${conn.ping} raw=${conn.pingRaw} online=${online} drift=${conn.pingDrift} />
          <${MicroLabel}>${t('当前延迟')}<//>
        </div>
        <${Button} variant="secondary" size="sm" icon="chart" class="stats-entry" onClick=${openStats} title=${t('统计数据')} aria-label=${t('统计数据')}>${t('统计')}<//>
        <${SettingsButton} class="room-settings" variant="secondary" label=${t('设置')} />
        <${GuideButton} class="room-guide" variant="secondary" label=${t('玩法说明')} />
      </div>
      <div class="topbar__center">
        <${MicroLabel} tone="mint">${coop ? 'ALLIANCE LOBBY' : 'SOLO SIMULATION'}<//>
        <h1 class="topbar__title">${coop ? t('同盟模拟') : t('独立模拟')}<span class="topbar__sep"></span><${DifficultyTag} difficulty=${room.difficulty} size="lg" />
          ${room.content?.modeId ? html`<span class="room-mode" data-testid="room-mode">${(room.content.modes || []).find((m) => m.id === room.content.modeId)?.name || room.content.modeId}</span>` : null}</h1>
        <${PluginTag} room=${room} myId=${me.playerId} />
      </div>
      <div class="topbar__right">
        ${coop ? html`<${InviteBox} code=${room.code} name=${me.name} difficulty=${room.difficulty} />` : html`<div class="solo-note"><${MicroLabel}>SINGLE OPERATOR<//><span>${t('仅限 1 名博士')}</span></div>`}
      </div>
    </header>

    ${coop ? html`<${CapacityPicker} room=${room} facts=${facts} busy=${busy} connected=${online} onPick=${setCapacity} onMatchmaking=${setMatchmaking} />` : null}
    ${coop ? html`<${PrepScalePicker} room=${room} facts=${facts} busy=${busy} connected=${online} onPick=${setPrepScale} />` : null}
    <main class=${`seats${coop ? facts.seats.length > 10 ? ' seats--dense' : facts.seats.length > 4 ? ' seats--expanded' : '' : ' seats--solo'}${coop && facts.seats.length === 10 ? ' seats--ten' : ''}`}>
      ${facts.seats.map((s, i) => html`<${SeatCard} key=${s ? `p${s.playerId}` : `e${i}`} seat=${s} index=${i} room=${room} facts=${facts}
        myId=${me.playerId} busy=${busy} group=${groupOf(s, i)} onAddBot=${addBot} onRemoveBot=${removeBot} onKick=${kick} onTransferHost=${transferHost}
        onSwap=${askSwap} onMoveToEmpty=${moveToEmptySeat} />`)}
      ${coop ? null : html`<aside class="solo-brief brackets">
        <${MicroLabel} tone="mint">BRIEFING<//>
        <h2>${DIFFICULTY_NAMES[room.difficulty] ? t(DIFFICULTY_NAMES[room.difficulty]) : ''}<span class="num t-dim"> ${info.code}</span></h2>
        <p>${info.desc}</p>
        <ul>
          ${info.effects.map((e) => html`<li key=${e}>${e}</li>`)}
          <li>${t('共')} <b class="num">${info.rounds}</b> ${tc('rounds', '回合')}${info.hidden ? t('，满足条件时进入隐秘核心') : ''}</li>
          <li>${t('独立模拟中休整期与机变阶段不限时')}</li>
        </ul>
      </aside>`}
    </main>
    ${showsGroups ? html`<div class="seat-groups">
      <span class="seat-groups__mine"><${Icon} name="users" />${t('本组内共享卡池')}</span>
      <span class="seat-groups__rule">${t('超过 5 人时按座位分成若干组，同组玩家抽同一套卡池')}</span>
    </div>` : null}
    <${SpectatorBar} facts=${facts} myId=${me.playerId} busy=${busy} onRemove=${removeSpectator} onSit=${sit} />
    <${SwapBar} facts=${facts} busy=${busy} onCancel=${cancelSwap} />

    <footer class="room-bar">
      <div class="room-bar__left">
        <span class="room-bar__label">${t('模拟难度')}<${MicroLabel}>DIFFICULTY<//></span>
        <div class="room-bar__opts">
          <${DifficultyPicker} room=${room} isHost=${facts.isHost} busy=${busy} onPick=${setDifficulty} />
          <${AiLastRule} option=${aiLastOption(room)} />
        </div>
      </div>
      <div class="room-bar__center">
        <div class="ready-count" hidden=${!coop}>
          <span class="t-lo">${t('已就绪')}</span>
          <b class="num">${facts.readyHumans}</b><span class="num t-dim">/${facts.humans.length}</span>
          ${facts.humans.length <= 8 ? html`<span class="ready-count__icons" aria-hidden="true">
            ${facts.humans.map((s) => html`<${Icon} key=${s.playerId} name="user" class=${facts.isReady(s) ? 'is-on' : ''} />`)}
          </span>` : null}
        </div>
        <div class="room-bar__status">${statusLine}</div>
      </div>
      <div class="room-bar__right">
        <${LoadoutButton} from="room" size="lg" class="room-loadout" label=${t('干员调配')} />
        ${facts.isHost
          ? html`<${Tooltip} text=${facts.canStart ? null : !facts.contentReady ? t('仍有博士未载入房间的插件内容') : t('仍有博士未准备就绪')}>
              <${Button} variant="primary" size="xl" icon="play" loading=${busy === 'start'} disabled=${!facts.canStart || !online} onClick=${start}>${t('开始模拟')}<//>
            <//>`
          : facts.spectating
            ? html`<${Button} variant="secondary" size="xl" icon="eye" disabled=${true}>${t('观战中')}<//>`
          : html`<${Tooltip} text=${!myReady && facts.myContent !== 'ready' ? t('房间的插件内容载入并通过校验后才能准备') : null}>
              <${Button} variant=${myReady ? 'primary' : 'secondary'} size="xl" icon=${myReady ? 'check' : 'hourglass'} active=${myReady}
              loading=${busy === 'ready'} disabled=${!online || !facts.mine || (!myReady && facts.myContent !== 'ready')} onClick=${toggleReady}>${myReady ? t('已就绪') : t('准备就绪')}<//>
            <//>`}
      </div>
    </footer>
    <${SwapDialog} facts=${facts} busy=${busy} left=${swapLeftS} onAnswer=${answerSwap} />
  </div>`;
}

/** Persistent across room/game routes, including spectators who never consent. */
export function TrustedNotice() {
  const state = useStore(s => s);
  const room = state.room, cs = room?.content?.cs, trusted = room?.content?.trusted;
  const seat = room?.seats?.find(s => s && s.playerId === state.me?.playerId);
  const [dismissed,setDismissed] = useState(null);
  const [busy,setBusy] = useState(false);
  const [review,setReview] = useState(false);
  const choose = async accept => {
    setBusy(true);
    try {
      if (seat) await net.request('room.consent',{cs,accept});
      rememberScriptConsent(cs,accept);
      setDismissed(cs); setReview(false);
      if (accept && trusted.plugins.some(p => p.permissions.includes('trusted.page'))) {
        const url = new URL(location.href); url.searchParams.set('cs',cs); url.searchParams.set('room',room.code);
        location.assign(url.href); return;
      }
      store.set({room:{...store.get().room}}); // wake the content loader after local persistence
    } catch (e) { toastError(e); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (trusted && seat && hasScriptConsent(cs) && !trusted.consent?.[seat.seat] && !room.inMatch) {
      net.request('room.consent',{cs,accept:true}).catch(toastError);
    }
  },[cs,seat?.seat,!!trusted?.consent?.[seat?.seat]]);
  if (!trusted) return null;
  return html`<aside class="trusted-banner" data-testid="trusted-banner">
    <strong>${t('受信任插件')}</strong>
    <button onClick=${() => setReview(true)}>${t('查看风险与同意状态')}</button>
    <${Modal} open=${review || (dismissed !== cs && !hasScriptConsent(cs))} title=${t('受信任插件')} tone="red" closeOnBackdrop=${false}
      onClose=${() => room.inMatch ? setReview(false) : choose(false)} actions=${html`<${Button} disabled=${busy} onClick=${() => choose(false)} data-testid="script-decline">${t('拒绝')}<//>
        <${Button} disabled=${busy} onClick=${() => choose(true)} data-testid="script-accept">${t('同意运行')}<//>`}>
      <p>${t('它可以完全控制你的游戏页面')}</p>
      <p>${t('仅在你信任所有作者及以下代码时同意。换了内容组合需要重新同意。')}</p>
      <ul>${trusted.plugins.map(p => html`<li key=${p.id}><strong>${p.id} ${p.version}</strong>
        <p>${t('作者：{authors}',{authors:(p.authors || []).join(', ') || '—'})}</p>
        <p class="trusted-hash">SHA-256: ${p.hash}</p><p>${t('权限：{permissions}',{permissions:p.permissions.join(', ')})}</p></li>`)}</ul>
    <//>
  </aside>`;
}
