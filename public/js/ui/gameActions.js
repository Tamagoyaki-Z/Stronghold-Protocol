// In-match intents (`g.*`, DESIGN §8.2) with uniform error handling: every request goes through
// `act()`, which plays a UI sound on success, shows the ERR_TEXT toast on failure and never throws.
// The UI never mutates *state* optimistically — it waits for the next m.private / m.public push.
// `net.request` is looked up at call time so the dev mock harness can stub it.
//
// Optimistic *interface* feedback (approved plan A, 2026-10-12): the round trip costs ~2× the main
// thread's queueing plus 2× the network, so a tap that only acknowledged the server's reply felt dead
// for a few hundred ms. `act()` therefore publishes a *pending* intent — see the section at the bottom
// — for exactly as long as one request is unanswered, and the UI may paint a purely visual state from
// it (held button, dimmed card, sweep bar). Hard rules of that state:
//   * it is NEVER an authoritative value: no funds, shop slot, seat, score, round or ready flag is
//     guessed locally; every rendered value still comes from the server frame alone, so a frame that
//     arrives after the reply renders exactly what the server says (a late/foreign frame always wins);
//   * it is bounded by the request itself: `ok`, `error`, a dropped socket and the 8 s
//     REQUEST_TIMEOUT_MS all land in `act()`'s `finally`, which clears it (the error path is the
//     existing one — one toast, no second message);
//   * one token per `act()` call = one token per `net.request` (its `rid`), counted per UI key, so a
//     failed intent can never clear another intent's feedback.

import { net } from '../net.js';
import { toastError } from './toasts.js';
import { audio } from '../audio.js';

const SUCCESS_SFX = {
  'g.buy': 'buy', 'g.sell': 'sell', 'g.refresh': 'refresh', 'g.freeze': 'freeze', 'g.levelUp': 'levelup',
  'g.move': 'drop', 'g.equip': 'equip', 'g.art': 'artPlace', 'g.reward': 'pick', 'g.choice': 'pick',
  'g.band': 'confirm', 'g.bandSkip': 'back', 'g.infoReady': 'ready', 'g.emote': 'emote', 'g.destroy': 'back',
};

let inflight = 0;
const busyListeners = new Set();
const emitBusy = () => { for (const fn of [...busyListeners]) { try { fn(inflight); } catch { /* ignore */ } } };

/** Subscribe to the number of in-flight intents (for subtle busy indicators). */
export function onBusy(fn) { busyListeners.add(fn); return () => busyListeners.delete(fn); }

// ---- pending intents (optimistic interface feedback) ------------------------------------------------------------
//
// One token per `act()` call, i.e. one token per `net.request` and its `rid`. The token's *key* is what a UI
// component asks about (`g.buy:2`, `g.refresh`, `g.ready:true`); counts, not booleans, so two unanswered
// intents on the same key (a double tap) keep the feedback until the last reply lands.

/** Fields that identify the UI target of an intent, most specific first (the key's discriminator). */
const PENDING_DISCRIMINATORS = ['slot', 'uid', 'itemUid', 'idx', 'bandId', 'choiceId', 'voteId', 'ready', 'on', 'playerId', 'fieldId', 'id'];

let pendingSeq = 0;
const pendingIntents = new Map(); // token -> { t, key }
const pendingCounts = new Map();  // key -> number of unanswered intents
const pendingListeners = new Set();

/**
 * The UI key of an intent: `t` plus the first identifying field (`g.buy:2`, `g.move:17`, `g.ready:true`),
 * or just `t` when it has none (`g.refresh`).
 * @param {string} t
 * @param {object} [fields]
 * @returns {string}
 */
export function pendingKey(t, fields = {}) {
  const f = fields && typeof fields === 'object' ? fields : {};
  for (const k of PENDING_DISCRIMINATORS) {
    const v = f[k];
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return `${t}:${v}`;
    return `${t}:${JSON.stringify(v)}`;
  }
  return String(t);
}

/** Is any intent with this exact key still unanswered? */
export function isPendingKey(key) { return (pendingCounts.get(key) || 0) > 0; }

/** Is any intent of this type still unanswered (`isPendingType('g.ready')` — g.bandFocus never counts as g.band)? */
export function isPendingType(t) {
  const head = `${t}:`;
  for (const [key, n] of pendingCounts) if (n > 0 && (key === t || key.startsWith(head))) return true;
  return false;
}

/** Every key with at least one unanswered intent (a fresh Set — a UI snapshot). */
export function pendingKeys() {
  const keys = new Set();
  for (const [key, n] of pendingCounts) if (n > 0) keys.add(key);
  return keys;
}

/** How many intents are unanswered right now (any type). */
export function pendingTotal() {
  let n = 0;
  for (const c of pendingCounts.values()) n += c;
  return n;
}

/** Subscribe to pending-set changes (enter and leave). Returns an unsubscribe. */
export function onPendingChange(fn) { pendingListeners.add(fn); return () => pendingListeners.delete(fn); }

const emitPending = () => { for (const fn of [...pendingListeners]) { try { fn(); } catch { /* ignore */ } } };

/** Register a pending intent. Runs synchronously, before the request goes out — a tap paints on its own frame. */
function enterPending(t, fields) {
  const token = ++pendingSeq;
  const key = pendingKey(t, fields);
  pendingIntents.set(token, { t, key });
  pendingCounts.set(key, (pendingCounts.get(key) || 0) + 1);
  emitPending();
  return token;
}

/** Clear one pending intent (reply, error, timeout or disconnect). */
function leavePending(token) {
  const entry = pendingIntents.get(token);
  if (!entry) return;
  pendingIntents.delete(token);
  const left = (pendingCounts.get(entry.key) || 0) - 1;
  if (left > 0) pendingCounts.set(entry.key, left);
  else pendingCounts.delete(entry.key);
  emitPending();
}

/**
 * Send an intent. Resolves true on `ok`, false on error (already toasted).
 * Publishes a pending signal for the UI for as long as the request is unanswered (see the section above).
 * @param {string} t
 * @param {object} [fields]
 * @param {{ sfx?: string|false, quiet?: boolean, pending?: boolean }} [opts] `pending: false` (or `quiet`, a
 *   fire-and-forget intent with no toast) publishes no UI feedback — e.g. g.bandFocus fires on every highlight
 * @returns {Promise<boolean>}
 */
export async function act(t, fields = {}, opts = {}) {
  inflight += 1;
  emitBusy();
  // registered synchronously, so a tap's own frame already shows the held state
  const token = opts.pending === false || opts.quiet ? 0 : enterPending(t, fields);
  try {
    await net.request(t, fields);
    const s = opts.sfx === undefined ? SUCCESS_SFX[t] : opts.sfx;
    if (s) audio.sfx(s);
    return true;
  } catch (err) {
    if (!opts.quiet) {
      toastError(err);
      audio.sfx('error', { volume: 0.6 });
    }
    return false;
  } finally {
    // reply / error / timeout / dropped socket: the optimistic feedback is withdrawn here, exactly once
    leavePending(token);
    inflight = Math.max(0, inflight - 1);
    emitBusy();
  }
}

/** Legacy/dev frames may lack identity; omit absent guards rather than sending protocol-invalid nulls. */
export function draftRequestScope({ draftId, groupId } = {}) {
  return { ...(draftId != null ? { draftId } : {}), ...(groupId != null ? { groupId } : {}) };
}

/**
 * Personal PREP choices use choiceId; public group drafts use draftId / groupId.
 * @param {string|{ choiceId?: string|null, draftId?: string|null, groupId?: number|null }} [opts]
 */
export function choiceRequestScope(opts = {}) {
  if (typeof opts === 'string') return { choiceId: opts };
  return { ...draftRequestScope(opts), ...(opts.choiceId != null ? { choiceId: opts.choiceId } : {}) };
}

export const actions = {
  infoReady: (setupRevision = 0) => act('g.infoReady', { setupRevision }),
  rerollSetup: (setupRevision) => act('room.rerollSetup', { setupRevision }, { sfx: 'confirm' }),
  rerollVote: (voteId, agree) => act('g.rerollVote', { voteId, agree }, { sfx: agree ? 'confirm' : 'back' }),
  cancelReroll: (voteId) => act('room.cancelReroll', { voteId }, { sfx: 'back' }),
  band: (bandId, opts = {}) => act('g.band', { bandId, ...draftRequestScope(opts) }),
  bandSkip: (opts = {}) => act('g.bandSkip', draftRequestScope(opts)),
  buy: (slot) => act('g.buy', { slot }),
  refresh: () => act('g.refresh'),
  freeze: () => act('g.freeze'),
  levelUp: () => act('g.levelUp'),
  sell: (uid) => act('g.sell', { uid }),
  // `dir` (UP|RIGHT|DOWN|LEFT): the direction chosen with the deploy wheel (research 09 §6.1 — g.move / g.art carry it;
  // the server defaults to RIGHT when absent)
  move: (uid, to, dir) => act('g.move', dir ? { uid, to, dir } : { uid, to }),
  // `replaceUid`: the equipped item the replace dialog picked (ui/equipReplace.js) — it is destroyed; absent ⇒ none needed
  equip: (itemUid, targetUid, replaceUid) => act('g.equip', Number.isInteger(replaceUid) ? { itemUid, targetUid, replaceUid } : { itemUid, targetUid }),
  art: (itemUid, row, col, dir) => act('g.art', dir ? { itemUid, row, col, dir } : { itemUid, row, col }),
  destroy: (uid) => act('g.destroy', { uid }),
  reward: (idx) => act('g.reward', { idx }),
  choice: (idx, opts = {}) => act('g.choice', { idx, ...choiceRequestScope(opts) }),
  ready: (ready) => act('g.ready', { ready }, { sfx: ready ? 'ready' : 'back' }),
  emote: (id) => act('g.emote', { id }, { quiet: true }),
  // `playerId`: the player tapped in the team panel (a shared field shows two) — what an eliminated viewer follows
  watch: (fieldId, playerId = null) => act('g.watch', typeof playerId === 'string' && playerId ? { fieldId, playerId } : { fieldId }, { sfx: 'tab' }),
  autoplay: (on) => act('g.autoplay', { on }),
  uniteSkipVote: ({ voteId } = {}) => act('g.uniteSkipVote', voteId == null ? {} : { voteId }, { sfx: 'confirm' }),
  // solo battles only (ui/matchStatus.js pauseAvailable): m.public.paused follows
  pause: (on) => act('g.pause', { on: !!on }, { sfx: on ? 'click' : 'confirm' }),
  // room-level intent (NOT g.*): the host frees a spectator seat while the match runs — the server takes room.removeSpectator at
  // any time (server/lobby.js removeSpectator), the game screen had no entry for it (ui/hud.js SpectatorPill; GitHub #120)
  removeSpectator: (playerId) => act('room.removeSpectator', { playerId }, { sfx: 'back' }),
};
