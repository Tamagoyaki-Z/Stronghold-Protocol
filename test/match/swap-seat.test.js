// ⇄ 换位 (LoL-style champion swap: room.swapAsk / room.swapAnswer / room.swapCancel) over real sockets, plus the
// client-side rules that a pending negotiation never reorders a seat on its own.
//
// The user request of 2026-10-12 replaced the old shape of this feature (only the host, effective immediately) with a
// NEGOTIATION: any HUMAN asks any other HUMAN (never itself, an AI or a spectator), the asked player confirms, an
// unanswered ask expires into a refusal, and both sides must be UNREADY (准备后不再换位). The seat exchange reuses
// room.moveSeat's semantics — the seat records travel with their index — so a moved doctor keeps its playerId, loadout,
// ownership and DIY picks; the assertions below therefore read `seats[i].playerId`.
//
// Every mutation goes through `step`/`arm`: ALL clients drop the frames a previous step left unconsumed, the waits are
// armed BEFORE the message goes out, and each predicate pins the negotiation count, the occupied seats and a seat map.
// A stale frame (a join, a ready toggle) therefore cannot satisfy a wait — the trap that a bare "swaps is empty"
// predicate falls into, because the frame of the step before last is empty too.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../server/index.js';
import { Match } from '../../server/match/Match.js';
import { TestClient } from '../helpers/wsClient.js';
import { FakeBattle } from './fakeBattle.js';
import { validateC2S, S2C } from '../../shared/protocol.js';
import { ERR } from '../../shared/constants.js';
import {
  roomFacts, normalizeSeats, swapState, swapTarget, swapTargetSeat, swapDeadline,
} from '../../public/js/screens/room.js';

// Client-side combat is off and the phases are irrelevant here, so a test may leave a match right after starting it.
class FastMatch extends Match {
  constructor(o) { super({ ...o, timerScale: 2, BattleClass: FakeBattle, clientCombat: false }); }
}

/** The answer window the test server runs with (the production default is 30 s). */
const TTL = 400;
/** How long a test may wait for a frame (well past TTL, so a timeout test still sees its own frame). */
const WAIT = 6000;

const errors = [];
const log = { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) };
let srv = null;
const clients = [];

async function server() {
  if (!srv) {
    srv = await startServer({ port: 0, host: '127.0.0.1', log, MatchClass: FastMatch, seedFn: () => 1, swapTtlMs: TTL });
  }
  return srv;
}

/** Create a co-op room of `capacity` seats on a fresh socket; the room code comes back. */
async function room(name, capacity = 8) {
  const s = await server();
  const c = await TestClient.connect(`ws://127.0.0.1:${s.port}/ws`);
  clients.push(c);
  const w = await c.hello(name);
  c.id = w.playerId;
  c.token = w.token;
  c.name = name;
  const created = await c.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', capacity });
  assert.equal(created.t, 'ok', JSON.stringify(created));
  const st = await c.waitFor('room.state', (m) => m.hostId === c.id);
  c.code = st.code;
  return c;
}

/** A second human joining the room `code`; resolves once its own seat is in a frame. */
async function join(code, name) {
  const s = await server();
  const c = await TestClient.connect(`ws://127.0.0.1:${s.port}/ws`);
  clients.push(c);
  const w = await c.hello(name);
  c.id = w.playerId;
  c.token = w.token;
  c.name = name;
  const joined = await c.request({ t: 'room.join', code });
  assert.equal(joined.t, 'ok', JSON.stringify(joined));
  await c.waitFor('room.state', (m) => m.seats.some((x) => x && x.playerId === c.id));
  return c;
}

/** room.addBot, waited for exactly: the AI takes the lowest free seat (the server rule). */
async function addBot(host, seat, filled) {
  const r = await host.request({ t: 'room.addBot' });
  assert.equal(r.t, 'ok', JSON.stringify(r));
  const st = await host.waitFor('room.state', (m) => m.seats.filter(Boolean).length === filled
    && m.seats[seat] && m.seats[seat].isBot, WAIT);
  return st.seats[seat].playerId;
}

const lastState = (c) => [...c.log].reverse().find((m) => m.t === 'room.state');
const seatIndexOf = (state, playerId) => state.seats.findIndex((x) => x && x.playerId === playerId);

/**
 * A `room.state` observer: `n` negotiations in flight, `count` occupied seats and every entry of `want`
 * (`{ index: playerId }`, null = "this index is empty") in place.
 */
function stateObs(c, n, count, want = {}) {
  const entries = Object.entries(want).map(([i, id]) => [Number(i), id]);
  return [c, 'room.state', (m) => Array.isArray(m.swaps) && m.swaps.length === n
    && (count == null || m.seats.filter(Boolean).length === count)
    && entries.every(([i, id]) => (id === null ? !m.seats[i] : !!m.seats[i] && m.seats[i].playerId === id))];
}

/** Drop every frame still unconsumed, then arm the observers. @returns {Promise<any>[]} */
function arm(observers) {
  for (const c of clients) c.clearInbox();
  return observers.map(([c, type, predicate]) => c.waitFor(type, predicate || (() => true), WAIT));
}

/** Arm the observers, run one mutation, and return `{ reply, frames }` (frames in the observers' order). */
async function step(actor, msg, observers = []) {
  const pending = arm(observers);
  const reply = await actor.request(msg);
  return { reply, frames: await Promise.all(pending) };
}

const okReply = (reply, msg) => assert.equal(reply.t, 'ok', `${msg.t}: ${JSON.stringify(reply)}`);
const errReply = (reply, msg, code) => {
  assert.equal(reply.t, 'error', `${msg.t}: ${JSON.stringify(reply)}`);
  assert.equal(reply.code, code, `${msg.t}: ${JSON.stringify(reply)}`);
};

after(async () => {
  for (const c of clients) await c.terminate().catch(() => {});
  if (srv) await srv.close();
  assert.deepEqual(errors, [], 'the server logged no errors');
});

test('room.swapAsk: any doctor — not only the host — asks, and the seats move only after the target agrees', async () => {
  const host = await room('Host', 8);
  const guest = await join(host.code, 'Guest');
  const other = await join(host.code, 'Other');
  const before = lastState(host);
  const h = seatIndexOf(before, host.id);
  const g = seatIndexOf(before, guest.id);
  const o = seatIndexOf(before, other.id);
  assert.deepEqual([h, g, o], [0, 1, 2], 'the three humans hold the first three seats');
  const want = { [h]: host.id, [g]: guest.id, [o]: other.id };

  // a NON-host asks another NON-host: the old shape let only the host move anybody, and moved them at once
  const ask = { t: 'room.swapAsk', to: other.id };
  const { reply, frames } = await step(guest, ask,
    [stateObs(host, 1, 3, want), stateObs(guest, 1, 3, want), stateObs(other, 1, 3, want), [other, 'room.swapAsked']]);
  okReply(reply, ask);
  const [hostView, guestView, otherView, asked] = frames;
  assert.equal(asked.from, guest.id, 'the private dialog names the asker');
  assert.equal(asked.fromName, 'Guest');
  assert.equal(asked.ttlMs, TTL, 'the private frame carries the answer window the dialog counts down');
  // the private dialog went to the target alone; the host is a bystander here
  await host.expectNone('room.swapAsked', () => true, 200);

  // the negotiation is published: the asker, the target and every bystander read the same room.state
  assert.deepEqual(hostView.swaps.map((x) => [x.from, x.to]), [[guest.id, other.id]]);
  assert.ok(hostView.swaps[0].ttlMs > 0 && hostView.swaps[0].ttlMs <= TTL, 'the frame carries the remaining window');
  assert.deepEqual(guestView.swaps, hostView.swaps, 'both sides see the same negotiation');
  assert.deepEqual(otherView.swaps, hostView.swaps, 'and so does the bystander');
  // ... and nothing moved: consent is what moves seats, a pending ask never does
  assert.equal(guestView.seats[g].playerId, guest.id);
  assert.equal(guestView.seats[o].playerId, other.id);

  // the client renders only that frame: a pending ask reorders nothing on its own
  const pendingFacts = roomFacts(guestView, guest.id);
  assert.deepEqual(pendingFacts.seats.map((x) => x && x.playerId), normalizeSeats(guestView).map((x) => x && x.playerId));
  assert.equal(pendingFacts.swaps.mine.to, other.id);
  assert.equal(pendingFacts.swaps.incoming, null);

  // the target agrees
  const accept = { t: 'room.swapAnswer', from: guest.id, accept: true };
  const swapped = { [g]: other.id, [o]: guest.id };
  const done = await step(other, accept,
    [stateObs(host, 0, 3, swapped), stateObs(other, 0, 3, swapped), stateObs(guest, 0, 3, swapped),
      [guest, 'room.swapEnded'], [other, 'room.swapEnded']]);
  okReply(done.reply, accept);
  const [hostDone, otherDone, guestDone, endedAsker, endedTarget] = done.frames;
  assert.deepEqual(hostDone.swaps, [], 'the negotiation is over');
  assert.equal(hostDone.seats[g].name, 'Other', 'the seat record moved with its playerId');
  assert.equal(hostDone.seats[o].name, 'Guest');
  assert.equal(hostDone.hostId, host.id, 'the host identity is a playerId and survives the swap');
  assert.equal(endedAsker.reason, 'accepted');
  assert.equal(endedTarget.reason, 'accepted');
  // every member reads the same new order, socket for socket
  assert.deepEqual(otherDone.seats.map((x) => x && x.playerId), hostDone.seats.map((x) => x && x.playerId));
  assert.deepEqual(guestDone.seats.map((x) => x && x.playerId), hostDone.seats.map((x) => x && x.playerId));
  assert.equal(roomFacts(hostDone, guest.id).mine.seat, o, 'the client follows the frame, not the ask');
  assert.deepEqual(hostDone.seats.filter(Boolean).map((x) => x.ready), [false, false, false]);
});

test('room.swapAnswer: consent moves the two parties only — a third doctor stays 准备', async () => {
  // 只清当事人的准备状态 (user rule, 2026-10-12). The v0.2.3 shape of a seat move (room.moveSeat / setDifficulty)
  // un-readied EVERY other human, because those regroup the whole room; a swap moves two seat records between two
  // indices and leaves every other seat index — and the draft group it readied for — exactly where it was. This test
  // is the regression guard for that: a bystander who readied must still be ready once the two seats have moved.
  const host = await room('Host', 8);
  const guest = await join(host.code, 'Guest');
  const other = await join(host.code, 'Other');
  const bystander = await join(host.code, 'Bystander');

  // the third doctor readies for the group its own seat index belongs to
  const readied = await step(bystander, { t: 'room.ready', ready: true }, [stateObs(host, 0, 4)]);
  okReply(readied.reply, { t: 'room.ready' });

  const before = lastState(host);
  const h = seatIndexOf(before, host.id);
  const g = seatIndexOf(before, guest.id);
  const o = seatIndexOf(before, other.id);
  const b = seatIndexOf(before, bystander.id);
  assert.deepEqual([h, g, o, b], [0, 1, 2, 3], 'the four humans hold the first four seats');
  assert.equal(before.seats[b].ready, true, 'the bystander is ready before the swap');
  assert.equal(before.seats[g].ready, false);
  assert.equal(before.seats[o].ready, false);

  const swap = await step(guest, { t: 'room.swapAsk', to: other.id },
    [stateObs(host, 1, 4), [other, 'room.swapAsked']]);
  okReply(swap.reply, { t: 'room.swapAsk' });
  assert.equal(lastState(host).seats[b].ready, true, 'asking changes nobody\'s readiness either');

  const answer = { t: 'room.swapAnswer', from: guest.id, accept: true };
  const swapped = { [g]: other.id, [o]: guest.id, [b]: bystander.id };
  const done = await step(other, answer,
    [stateObs(host, 0, 4, swapped), [guest, 'room.swapEnded'], [other, 'room.swapEnded']]);
  okReply(done.reply, answer);
  const [after, endedAsker, endedTarget] = done.frames;
  assert.equal(endedAsker.reason, 'accepted');
  assert.equal(endedTarget.reason, 'accepted');
  assert.equal(after.seats[g].playerId, other.id, 'the two parties really exchanged seats');
  assert.equal(after.seats[o].playerId, guest.id);
  assert.equal(after.seats[b].playerId, bystander.id, 'the bystander kept its seat');
  assert.equal(after.seats[b].ready, true, 'a third doctor who readied for its group is still ready');
  assert.deepEqual(after.seats.filter(Boolean).map((x) => [x.playerId, x.ready]),
    [[host.id, false], [other.id, false], [guest.id, false], [bystander.id, true]],
    'only the two parties were involved: both were unready and stay unready, the bystander keeps its 准备');
});

test('room.swapAsk: a refusal leaves every seat where it was', async () => {
  const host = await room('Host', 8);
  const guest = await join(host.code, 'Guest');
  const before = lastState(host);
  const h = seatIndexOf(before, host.id);
  const g = seatIndexOf(before, guest.id);
  const want = { [h]: host.id, [g]: guest.id };

  const ask = { t: 'room.swapAsk', to: host.id };
  const asked = await step(guest, ask, [stateObs(host, 1, 2, want), [host, 'room.swapAsked']]);
  okReply(asked.reply, ask);
  assert.equal(asked.frames[1].from, guest.id);

  const answer = { t: 'room.swapAnswer', from: guest.id, accept: false };
  const out = await step(host, answer, [stateObs(host, 0, 2, want), stateObs(guest, 0, 2, want), [guest, 'room.swapEnded']]);
  okReply(out.reply, answer);
  const [hostAfter, guestAfter, ended] = out.frames;
  assert.equal(ended.reason, 'declined');
  assert.equal(hostAfter.seats[h].playerId, host.id, 'the host kept its seat');
  assert.equal(hostAfter.seats[g].playerId, guest.id, 'the asker kept its seat');
  assert.deepEqual(guestAfter.seats.map((x) => x && x.playerId), hostAfter.seats.map((x) => x && x.playerId));
});

test('room.swapAsk: an unanswered ask expires into a refusal and cleans itself up', async () => {
  const host = await room('Host', 8);
  const guest = await join(host.code, 'Guest');
  const before = lastState(host);
  const h = seatIndexOf(before, host.id);
  const g = seatIndexOf(before, guest.id);
  const want = { [h]: host.id, [g]: guest.id };

  const ask = { t: 'room.swapAsk', to: host.id };
  const asked = await step(guest, ask, [stateObs(host, 1, 2, want), [host, 'room.swapAsked']]);
  okReply(asked.reply, ask);

  // no answer at all: the window closes on its own (a timeout IS a refusal) and nobody moved
  const pending = arm([stateObs(host, 0, 2, want), stateObs(guest, 0, 2, want),
    [guest, 'room.swapEnded', (m) => m.reason === 'timeout']]);
  const [hostAfter, guestAfter, ended] = await Promise.all(pending);
  assert.equal(ended.reason, 'timeout');
  assert.equal(hostAfter.seats[h].playerId, host.id, 'the timeout moved nobody');
  assert.equal(hostAfter.seats[g].playerId, guest.id);
  assert.equal(guestAfter.seats[h].playerId, host.id);

  // and the slot is free again: the expired ask does not hold the doctor
  const again = await step(guest, { t: 'room.swapAsk', to: host.id }, [stateObs(host, 1, 2, want)]);
  okReply(again.reply, { t: 'room.swapAsk' });
  const cancel = await step(guest, { t: 'room.swapCancel' }, [stateObs(host, 0, 2, want)]);
  okReply(cancel.reply, { t: 'room.swapCancel' });
});

test('room.swapAsk: refused for an AI, for oneself, for a stranger, and for a second negotiation', async () => {
  const host = await room('Host', 8);
  const guest = await join(host.code, 'Guest');
  const bot = await addBot(host, 2, 3);

  // never an AI, never oneself, never a doctor who is not in this room, and nothing to withdraw
  for (const [msg, code] of [
    [{ t: 'room.swapAsk', to: bot }, ERR.BAD_TARGET],
    [{ t: 'room.swapAsk', to: guest.id }, ERR.BAD_TARGET],
    [{ t: 'room.swapAsk', to: 'nobody_at_all' }, ERR.BAD_TARGET],
    [{ t: 'room.swapCancel' }, ERR.BAD_TARGET],
  ]) {
    const { reply } = await step(guest, msg);
    errReply(reply, msg, code);
  }

  // one negotiation per doctor, and nobody who is already negotiating can be named
  const before = lastState(host);
  const want = { [seatIndexOf(before, host.id)]: host.id, [seatIndexOf(before, guest.id)]: guest.id,
    [seatIndexOf(before, bot)]: bot };
  const ask = { t: 'room.swapAsk', to: host.id };
  const first = await step(guest, ask, [stateObs(host, 1, 3, want)]);
  okReply(first.reply, ask);
  const twice = await step(guest, ask);
  errReply(twice.reply, ask, ERR.ALREADY);

  const third = await join(host.code, 'Third');
  for (const to of [host.id, guest.id]) {
    const msg = { t: 'room.swapAsk', to };
    const { reply } = await step(third, msg);
    errReply(reply, msg, ERR.BAD_TARGET);
  }

  // the asker withdraws: the target is told and the slot frees up
  const out = await step(guest, { t: 'room.swapCancel' }, [stateObs(host, 0, 4), [host, 'room.swapEnded']]);
  okReply(out.reply, { t: 'room.swapCancel' });
  assert.equal(out.frames[1].reason, 'cancelled');
  const taken = await step(third, { t: 'room.swapAsk', to: guest.id }, [stateObs(host, 1, 4)]);
  okReply(taken.reply, { t: 'room.swapAsk' });
});

test('准备后不再换位: a ready seat can neither ask nor be asked, and readying voids a pending ask', async () => {
  const host = await room('Host', 8);
  const guest = await join(host.code, 'Guest');
  const third = await join(host.code, 'Third');
  const before = lastState(host);
  const g = seatIndexOf(before, guest.id);
  const t = seatIndexOf(before, third.id);
  const want = { [seatIndexOf(before, host.id)]: host.id, [g]: guest.id, [t]: third.id };

  // the asker is ready: no ask of its own (the server refuses it, not just the greyed-out button)
  okReply((await step(guest, { t: 'room.ready', ready: true }, [stateObs(host, 0, 3, want)])).reply, { t: 'room.ready' });
  for (const [actor, msg] of [[guest, { t: 'room.swapAsk', to: third.id }], [third, { t: 'room.swapAsk', to: guest.id }]]) {
    const { reply } = await step(actor, msg);
    errReply(reply, msg, ERR.NOT_READY);
  }
  okReply((await step(guest, { t: 'room.ready', ready: false })).reply, { t: 'room.ready' });

  // a pending ask dies when the TARGET readies before answering
  const ask = { t: 'room.swapAsk', to: guest.id };
  const asked = await step(third, ask, [stateObs(host, 1, 3, want), [guest, 'room.swapAsked']]);
  okReply(asked.reply, ask);
  assert.equal(asked.frames[1].from, third.id);
  const readied = await step(guest, { t: 'room.ready', ready: true });
  okReply(readied.reply, { t: 'room.ready' });
  const answer = { t: 'room.swapAnswer', from: third.id, accept: true };
  const out = await step(guest, answer, [stateObs(host, 0, 3, want), [third, 'room.swapEnded']]);
  errReply(out.reply, answer, ERR.NOT_READY);
  assert.equal(out.frames[1].reason, 'voided', 'the asker is told the ask no longer applies');
  assert.equal(out.frames[0].seats[g].playerId, guest.id, 'a ready doctor is not moved');
  assert.equal(out.frames[0].seats[t].playerId, third.id, 'and neither is the one who asked');
  okReply((await step(guest, { t: 'room.ready', ready: false })).reply, { t: 'room.ready' });

  // ... and when the ASKER readies before the answer
  const ask2 = { t: 'room.swapAsk', to: third.id };
  const asked2 = await step(guest, ask2, [stateObs(host, 1, 3, want), [third, 'room.swapAsked']]);
  okReply(asked2.reply, ask2);
  okReply((await step(guest, { t: 'room.ready', ready: true })).reply, { t: 'room.ready' });
  const answer2 = { t: 'room.swapAnswer', from: guest.id, accept: true };
  const out2 = await step(third, answer2, [stateObs(host, 0, 3, want), [guest, 'room.swapEnded']]);
  errReply(out2.reply, answer2, ERR.NOT_READY);
  assert.equal(out2.frames[1].reason, 'voided');
  assert.equal(out2.frames[0].seats[g].playerId, guest.id);
  assert.equal(out2.frames[0].seats[t].playerId, third.id);
});

test('room.swapAsk: a dropped connection voids the negotiation it takes part in', async () => {
  const host = await room('Host', 8);
  const guest = await join(host.code, 'Guest');
  const third = await join(host.code, 'Third');
  const thirdId = third.id;
  const before = lastState(host);
  const want = { [seatIndexOf(before, host.id)]: host.id, [seatIndexOf(before, guest.id)]: guest.id, [seatIndexOf(before, thirdId)]: thirdId };

  const ask = { t: 'room.swapAsk', to: thirdId };
  const asked = await step(guest, ask, [stateObs(host, 1, 3, want), [third, 'room.swapAsked']]);
  okReply(asked.reply, ask);

  const pending = arm([stateObs(host, 0, 3, want), [guest, 'room.swapEnded', (m) => m.reason === 'voided']]);
  await third.terminate();
  const [hostAfter, ended] = await Promise.all(pending);
  assert.equal(ended.reason, 'voided');
  assert.deepEqual(hostAfter.swaps, []);
  assert.equal(hostAfter.seats[seatIndexOf(before, thirdId)].playerId, thirdId,
    'a dropped seat is kept for the grace window (the deal is off, the seat is not)');
  assert.equal(hostAfter.seats[seatIndexOf(before, thirdId)].connected, false);
});

test('room.swapAsk: refused once the match started, and a solo room offers no swap at all', async () => {
  const host = await room('Host', 8);
  const bot = await addBot(host, 1, 2);
  const started = await step(host, { t: 'room.start' }, [[host, 'room.state', (m) => m.inMatch === true]]);
  okReply(started.reply, { t: 'room.start' });
  assert.deepEqual(started.frames[0].swaps, [], 'starting the match voids whatever was pending');
  for (const to of [bot, host.id]) {
    const msg = { t: 'room.swapAsk', to };
    const { reply } = await step(host, msg);
    errReply(reply, msg, ERR.ROOM_STARTED);
  }
  // a solo room has a single seat: the client never offers ⇄ there
  const solo = { mode: 'solo', capacity: 1, hostId: host.id, inMatch: false,
    seats: [{ seat: 0, playerId: host.id, name: 'Host', isBot: false, ready: false, connected: true }] };
  assert.equal(roomFacts(solo, host.id).canSwap, false);
});

test('protocol + client: the swap messages validate, and the client only ever reads the server frame', () => {
  assert.ok(S2C.includes('room.swapAsked') && S2C.includes('room.swapEnded'), 'the two pushes are declared');
  assert.equal(validateC2S({ t: 'room.swapAsk', to: 'p1' }), null);
  assert.equal(validateC2S({ t: 'room.swapAnswer', from: 'p1', accept: false }), null);
  assert.equal(validateC2S({ t: 'room.swapCancel' }), null);
  // unknown extra fields are ignored by the wire contract (validateC2S), so only bad values are refused
  assert.equal(validateC2S({ t: 'room.swapCancel', to: 'p1' }), null, 'an extra field is not a protocol error');
  for (const bad of [{ t: 'room.swapAsk' }, { t: 'room.swapAsk', to: 7 }, { t: 'room.swapAsk', to: '' },
    { t: 'room.swapAnswer', from: 'p1' }, { t: 'room.swapAnswer', from: 'p1', accept: 'yes' }]) {
    assert.notEqual(validateC2S(bad), null, JSON.stringify(bad));
  }

  const seats = [
    { seat: 0, playerId: 'h', name: 'Host', isBot: false, ready: false, connected: true },
    { seat: 1, playerId: 'g', name: 'Guest', isBot: false, ready: false, connected: true },
    { seat: 2, playerId: 'r', name: 'Ready', isBot: false, ready: true, connected: true },
    null,
  ];
  const base = { t: 'room.state', code: 'AAAA', hostId: 'h', mode: 'coop', difficulty: 'NORMAL', capacity: 4, seats, spectators: [] };
  const pending = { ...base, swaps: [{ from: 'g', to: 'h', ttlMs: 30_000 }] };

  // a pending negotiation does NOT reorder a single seat: only a frame that follows consent does
  assert.deepEqual(normalizeSeats(pending).map((s) => s && s.playerId), ['h', 'g', 'r', null]);
  const hostFacts = roomFacts(pending, 'h');
  assert.deepEqual(hostFacts.seats.map((s) => s && s.playerId), ['h', 'g', 'r', null], 'the layout is the frame');
  assert.deepEqual(hostFacts.swaps.all, pending.swaps);
  assert.deepEqual([hostFacts.swaps.incoming.from, hostFacts.swaps.mine], ['g', null]);
  assert.equal(roomFacts(pending, 'g').swaps.mine.to, 'h');
  assert.deepEqual([...hostFacts.swaps.busy].sort(), ['g', 'h'], 'both parties are negotiating');

  // the rules the greyed-out ⇄ buttons use — every one of them is server-enforced too
  const free = { ...base, swaps: [] };
  assert.equal(swapTarget(free, 'g', free.seats[0]).allowed, true);
  assert.equal(roomFacts(free, 'h').canSwap, true, 'the host uses the very same flow (no host privilege)');
  assert.equal(swapTarget(pending, 'g', pending.seats[0]).hint, '等待对方确认…', 'one ask at a time');
  assert.equal(swapTarget(free, 'g', free.seats[2]).hint, '对方已准备，无法换位');
  assert.equal(swapTarget(free, 'g', free.seats[1]).show, false, 'never towards oneself');
  assert.equal(swapTarget(free, 'g', { ...free.seats[2], isBot: true }).show, false, 'never towards an AI');
  const readyMe = { ...base, swaps: [], seats: [seats[0], { ...seats[1], ready: true }, seats[2], null] };
  assert.equal(swapTarget(readyMe, 'g', readyMe.seats[0]).hint, '准备后无法换位', '准备后不再换位 (the asker)');
  assert.equal(roomFacts(readyMe, 'g').canSwap, false);
  assert.equal(swapTarget({ ...base, swaps: [], inMatch: true }, 'g', seats[0]).hint, '开局后无法换位');
  const noSeat = { ...base, swaps: [], seats: [seats[0], null, seats[2], null] };
  const outsider = roomFacts(noSeat, 'g');
  assert.equal(outsider.mine, null);
  assert.equal(swapTargetSeat(outsider, noSeat.seats[0], 'g').show, false, 'a doctor without a seat gets no ⇄');
  const busy = { ...base, swaps: [{ from: 'h', to: 'r', ttlMs: 1000 }] };
  assert.equal(swapTarget(busy, 'g', busy.seats[0]).hint, '对方正在协商换位');
  const offline = { ...base, swaps: [], seats: [seats[0], seats[1], { ...seats[2], connected: false }, null] };
  assert.equal(swapTarget(offline, 'g', offline.seats[2]).hint, '对方已离线，无法换位');

  // the countdown anchor: the server recomputes ttlMs per frame, so a re-render keeps the anchor and a NEW frame
  // re-takes it (taking it on every render would freeze the countdown at its first value)
  const ref = { current: null };
  const d1 = swapDeadline(ref, { from: 'g', ttlMs: 5000 });
  assert.ok(d1 > Date.now(), 'the deadline is ahead of the client clock');
  assert.equal(swapDeadline(ref, { from: 'g', ttlMs: 5000 }), d1, 'the same frame keeps one anchor');
  assert.ok(swapDeadline(ref, { from: 'g', ttlMs: 4000 }) < d1, 'a new frame re-anchors on the server remainder');
  assert.equal(swapDeadline(ref, null), 0, 'no ask, no countdown');
  assert.deepEqual(swapState(base, 'g'), { all: [], mine: null, incoming: null, busy: new Set() });
});
