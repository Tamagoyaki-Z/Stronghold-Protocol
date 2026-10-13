// 换到空位 (room.moveToEmpty, user request 2026-10-13) over real sockets, plus the button the room screen puts on an
// EMPTY seat card.
//
// The occupied-seat flow is the LoL-style NEGOTIATION (test/match/swap-seat.test.js: room.swapAsk / room.swapAnswer,
// 准备后不再换位). An empty seat has nobody to ask, so this one moves at once: the click is the whole protocol.
//
// Every assertion below pins a rule the SERVER enforces (the client's greyed-out button only mirrors it) and the draft
// group the doctor ends up in: seats carry the fixed pool groups (shared/playerCapacity.js poolGroupOf, the same rule
// server/match/pool.js createPoolGroups applies at match start). The fixture is six humans in a capacity-8 room:
// seats 0..5 are taken in join order and seats 6/7 are empty. Occupancy cuts [3,3], so seat 1 (the guest) is group A
// and the first free seat 6 is group B — the move therefore moves the doctor into the OTHER group, and the group the
// match then gives it (asserted by starting a real match) is the same one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../server/index.js';
import { Match } from '../../server/match/Match.js';
import { TestClient } from '../helpers/wsClient.js';
import { FakeBattle } from './fakeBattle.js';
import { validateC2S, S2C } from '../../shared/protocol.js';
import { ERR } from '../../shared/constants.js';
import { poolGroupOf } from '../../shared/playerCapacity.js';
import { roomFacts, SeatCard, moveToEmpty, moveToEmptySeat, seatGroupOf } from '../../public/js/screens/room.js';
import { Button, Tooltip } from '../../public/js/ui/components.js';

// Client-side combat is off and the phases are irrelevant here, so a test may leave a match right after starting it.
// Every started match is kept, so a test can read the pool groups the SERVER really cut at match start.
const startedMatches = [];
class FastMatch extends Match {
  constructor(o) { super({ ...o, timerScale: 2, BattleClass: FakeBattle, clientCombat: false }); startedMatches.push(this); }
}

const WAIT = 6000;

const errors = [];
const log = { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) };
let srv = null;
const clients = [];

async function server() {
  if (!srv) srv = await startServer({ port: 0, host: '127.0.0.1', log, MatchClass: FastMatch, seedFn: () => 1, timerScale: 2 });
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

const lastState = (c) => [...c.log].reverse().find((m) => m.t === 'room.state');
const seatIndexOf = (state, playerId) => state.seats.findIndex((x) => x && x.playerId === playerId);
const order = (state) => state.seats.map((x) => (x ? x.playerId : null));

/** Drop every frame still unconsumed, then arm one `room.state` observer per client. */
function armStates(observers) {
  for (const c of clients) c.clearInbox();
  return observers.map(([c, predicate]) => c.waitFor('room.state', predicate, WAIT));
}
async function step(actor, msg, observers = []) {
  const pending = armStates(observers);
  const reply = await actor.request(msg);
  return { reply, frames: await Promise.all(pending) };
}

/**
 * SIX humans in a capacity-8 co-op room: seats 0..5 are taken in the order the doctors joined and the two seats
 * behind them (6, 7) are free. `empty` is the FIRST of those free seats — the one this feature moves a doctor onto.
 * Occupancy six cuts the groups [3,3]: seat 1 (the guest) is group A, seat 6 is group B.
 */
async function sixHumansTwoEmptySeats(prefix) {
  const host = await room(`${prefix}Host`, 8);
  const others = [];
  for (let i = 1; i <= 5; i++) others.push(await join(host.code, `${prefix}P${i}`));
  const empty = 6;
  const state = lastState(host);
  assert.equal(state.seats.filter(Boolean).length, 6, 'six humans, no AI');
  assert.deepEqual(state.seats.slice(0, 6).map((x) => (x ? x.playerId : null)), [host.id, ...others.map((o) => o.id)],
    'the six doctors, in the seat order they joined');
  assert.deepEqual(state.seats.slice(6).map((x) => (x ? x.playerId : null)), [null, null],
    'a waiting room hands out the LOWEST free seat, so 6 and 7 are the empty ones');
  assert.deepEqual(state.groups, [3, 3], 'the 3+3 split of six occupied seats is published');
  assert.deepEqual(state.seats.filter(Boolean).map((x) => [x.seat < 3 ? 0 : 1, x.group]),
    [[0, 0], [0, 0], [0, 0], [1, 1], [1, 1], [1, 1]], 'group A is seats 0..2, group B seats 3..5');
  assert.equal(poolGroupOf(empty, empty + 1), 1, 'the first free seat belongs to group B of that split');
  return { host, others, state, empty, ps: others };
}

after(async () => {
  for (const c of clients) await c.terminate().catch(() => {});
  if (srv) await srv.close();
  assert.deepEqual(errors, [], 'the server logged no errors');
});

test('room.moveToEmpty: the click alone moves the doctor, and its draft group follows the NEW seat', async () => {
  const { host, state, empty, ps } = await sixHumansTwoEmptySeats('Move');
  const guest = ps[0];
  const from = seatIndexOf(state, guest.id);
  assert.equal(from, 1);
  assert.equal(poolGroupOf(from, 6), 0, 'the guest sits in group A');
  const observer = (c) => [c, (m) => !!m.seats[empty] && m.seats[empty].playerId === guest.id];

  // no dialog and no consent frame: the actor, the host and a third doctor all read the same new room.state
  const move = { t: 'room.moveToEmpty', to: empty };
  const out = await step(guest, move, [observer(host), observer(guest), observer(ps[2])]);
  assert.equal(out.reply.t, 'ok', JSON.stringify(out.reply));
  const [hostView, guestView, thirdView] = out.frames;
  assert.equal(hostView.seats[from], null, 'seat 1 (P2) is empty again');
  assert.equal(hostView.seats[empty].playerId, guest.id);
  assert.equal(hostView.seats[empty].name, guest.name, 'the seat RECORD moved: playerId, name and the rest travel');
  assert.deepEqual(order(hostView), order(thirdView), 'every member reads the same order');
  assert.equal(hostView.hostId, host.id, 'the host identity is a playerId and never changes hands here');
  assert.deepEqual(hostView.seats.filter(Boolean).map((x) => x.ready),
    [false, false, false, false, false, false], 'nobody readied here: 准备 of others is untouched');

  // the pool-group consequence: occupancy is unchanged, and the doctor now sits in the OTHER group (B).
  // NOTE on the wire field: `poolGroupOf(seat, occupied)` only covers indices BELOW the occupied count, and a seat
  // that just became the 7th of 6 occupied ones is index 6 — so its raw `group` is -1 (the shared rule's existing
  // contract, unchanged here). What a player sees, and what the match gives that doctor, both follow the seat's RANK:
  // seatGroupOf falls back to it, and createPoolGroups cuts the same occupied order at start (asserted below).
  assert.deepEqual(hostView.groups, [3, 3], 'the split itself does not change');
  assert.deepEqual(hostView.seats.filter(Boolean).map((x) => x.seat), [0, 2, 3, 4, 5, 6],
    'the occupied seats after the move: 1 freed, 6 taken');
  const seatRanks = new Map(guestView.seats.map((x, i) => [i, x ? guestView.seats.slice(0, i).filter(Boolean).length : -1]));
  assert.equal(seatGroupOf(guestView.seats[empty], seatRanks.get(empty), 6), 1, 'the moved doctor\'s chip is group B');
  assert.equal(seatGroupOf(guestView.seats[0], seatRanks.get(0), 6), 0, 'while the host still draws group A');
  assert.equal(poolGroupOf(seatRanks.get(empty), 6), 1, 'and the rank pool rule agrees with that chip');

  // ...and the match really cuts that group for it (server/match/pool.js createPoolGroups). Six humans: everyone but
  // the host readies up first (the host's own 开始 is its ready), which is the room's normal start condition.
  for (const c of ps) {
    const r = await c.request({ t: 'room.ready', ready: true });
    assert.equal(r.t, 'ok', JSON.stringify(r));
  }
  const started = await step(host, { t: 'room.start' }, [[host, (m) => m.inMatch === true]]);
  assert.equal(started.reply.t, 'ok', JSON.stringify(started.reply));
  const match = startedMatches.at(-1);
  const groups = match.poolGroups;
  assert.deepEqual(groups.map((g) => g.playerIds.length), [3, 3], 'the opening 3+3 split');
  assert.equal(groups[0].playerIds.includes(guest.id), false, 'group A no longer holds the doctor that moved');
  assert.equal(groups[1].playerIds.includes(guest.id), true, 'group B does: ps.pool / poolFor follow this map');
  assert.equal(match.poolFor(guest.id), groups[1].pool, 'poolFor(guest) is the second group\'s pool');
  assert.equal(match.poolFor(host.id), groups[0].pool, 'the others kept theirs');
  assert.notEqual(groups[0].pool, groups[1].pool, 'two real pools, not one shared one');
});

test('room.moveToEmpty: a TAKEN seat is refused and nothing moves', async () => {
  const { host, state, empty, ps } = await sixHumansTwoEmptySeats('Taken');
  const guest = ps[0];
  const before = order(state);
  const taken = { t: 'room.moveToEmpty', to: seatIndexOf(state, host.id) };
  const { reply } = await step(guest, taken);
  assert.equal(reply.t, 'error', JSON.stringify(reply));
  assert.equal(reply.code, ERR.BAD_TARGET, JSON.stringify(reply));
  // the same click on a seat the doctor already HOLDS: also refused (that seat is not empty either), and nothing moves
  const self = await step(guest, { t: 'room.moveToEmpty', to: seatIndexOf(state, guest.id) });
  assert.equal(self.reply.t, 'error', JSON.stringify(self.reply));
  assert.equal(self.reply.code, ERR.BAD_TARGET, JSON.stringify(self.reply));
  // the other trailing empty seat is accepted, and only that one moved ...
  const trailing = await step(guest, { t: 'room.moveToEmpty', to: state.seats.length - 1 },
    [[host, (m) => !!m.seats[state.seats.length - 1] && m.seats[state.seats.length - 1].playerId === guest.id]]);
  assert.equal(trailing.reply.t, 'ok', JSON.stringify(trailing.reply));
  // ... back to the seat it came from, still nobody else touched
  const back = await step(guest, { t: 'room.moveToEmpty', to: seatIndexOf(state, guest.id) },
    [[host, (m) => !!m.seats[seatIndexOf(state, guest.id)] && m.seats[seatIndexOf(state, guest.id)].playerId === guest.id]]);
  assert.equal(back.reply.t, 'ok', JSON.stringify(back.reply));
  assert.deepEqual(order(lastState(host)), before, 'the room is exactly as it was');
  assert.equal(lastState(host).seats[empty], null, 'and the first free seat is still empty');
});

test('准备后不再换位: a READY doctor is refused by the server, its seat does not move', async () => {
  const { host, empty, ps } = await sixHumansTwoEmptySeats('Ready');
  const guest = ps[0];
  const from = seatIndexOf(lastState(host), guest.id);
  const readied = await step(guest, { t: 'room.ready', ready: true }, [[host, (m) => m.seats[from].ready === true]]);
  assert.equal(readied.reply.t, 'ok', JSON.stringify(readied.reply));

  const msg = { t: 'room.moveToEmpty', to: empty };
  const { reply } = await step(guest, msg);
  assert.equal(reply.t, 'error', JSON.stringify(reply));
  assert.equal(reply.code, ERR.NOT_READY, JSON.stringify(reply));
  assert.equal(lastState(host).seats[from].playerId, guest.id, 'the ready doctor did not move');
  assert.equal(lastState(host).seats[empty], null, 'the empty seat stays empty');
  // the gate is the swap's gate (server/lobby.js swappableSeat): unready again, the same click works
  const back = await step(guest, { t: 'room.ready', ready: false }, [[host, (m) => m.seats[from].ready === false]]);
  assert.equal(back.reply.t, 'ok', JSON.stringify(back.reply));
  const moved = await step(guest, msg, [[host, (m) => !!m.seats[empty] && m.seats[empty].playerId === guest.id]]);
  assert.equal(moved.reply.t, 'ok', JSON.stringify(moved.reply));
});

test('开赛后禁止: once the match runs, room.moveToEmpty is refused and the seats stay put', async () => {
  const host = await room('StartedHost', 6);
  const added = await step(host, { t: 'room.addBot' }, [[host, (m) => !!m.seats[1] && m.seats[1].isBot]]);
  assert.equal(added.reply.t, 'ok', JSON.stringify(added.reply));
  const freed = await step(host, { t: 'room.removeBot', seat: 1, playerId: added.frames[0].seats[1].playerId },
    [[host, (m) => !m.seats[1]]]);
  assert.equal(freed.reply.t, 'ok', JSON.stringify(freed.reply));
  const started = await step(host, { t: 'room.start' }, [[host, (m) => m.inMatch === true]]);
  assert.equal(started.reply.t, 'ok', JSON.stringify(started.reply));
  const msg = { t: 'room.moveToEmpty', to: 1 };
  const { reply } = await step(host, msg);
  assert.equal(reply.t, 'error', JSON.stringify(reply));
  assert.equal(reply.code, ERR.ROOM_STARTED, JSON.stringify(reply));
  assert.equal(lastState(host).seats[0].playerId, host.id, 'the doctor is still in P1');
  assert.equal(lastState(host).seats[1], null, 'and the empty seat is still empty');
});

test('protocol: room.moveToEmpty validates, and it has no push frame of its own', () => {
  assert.ok(!S2C.includes('room.moveToEmpty'), 'room.state is the whole answer');
  assert.equal(validateC2S({ t: 'room.moveToEmpty', to: 0 }), null);
  assert.equal(validateC2S({ t: 'room.moveToEmpty', to: 19 }), null);
  for (const bad of [{ t: 'room.moveToEmpty' }, { t: 'room.moveToEmpty', to: -1 }, { t: 'room.moveToEmpty', to: 20 },
    { t: 'room.moveToEmpty', to: '1' }, { t: 'room.moveToEmpty', to: 1.5 }]) {
    assert.notEqual(validateC2S(bad), null, JSON.stringify(bad));
  }
});

test('client: the button on an EMPTY seat is 换到空位 — no dialog, greyed out once ready, gone after the start', () => {
  const frame = (changes = {}) => ({
    t: 'room.state', code: 'AAAA', hostId: 'h', mode: 'coop', difficulty: 'NORMAL', capacity: 4,
    seats: [
      { seat: 0, playerId: 'h', name: 'Host', isBot: false, ready: false, connected: true },
      { seat: 1, playerId: 'g', name: 'Guest', isBot: false, ready: false, connected: true },
      null, null,
    ],
    spectators: [], swaps: [], inMatch: false, ...changes,
  });
  function* walk(node) {
    if (Array.isArray(node)) { for (const n of node) yield* walk(n); return; }
    if (!node || typeof node !== 'object') return;
    yield node;
    yield* walk(node.props?.children);
  }
  const buttonsOf = (card) => [...walk(card)].filter((n) => n.type === Button);
  const tipOf = (card) => [...walk(card)].find((n) => n.type === Tooltip);
  const swapOf = (card) => buttonsOf(card).find((n) => n.props.icon === 'swap');
  const emptyCardOf = (source) => SeatCard({ seat: null, index: 3, room: source, facts: roomFacts(source, 'g'),
    myId: 'g', busy: null });

  // an EMPTY seat: one button labelled 换到空位, enabled for a seated unready non-host; the click IS the request
  const free = frame();
  const calls = [];
  const emptyCard = SeatCard({ seat: null, index: 3, room: free, facts: roomFacts(free, 'g'), myId: 'g', busy: null,
    onAddBot: () => calls.push('bot'), onMoveToEmpty: (i) => calls.push(i) });
  const moveBtn = swapOf(emptyCard);
  assert.ok(moveBtn, 'the empty seat card carries the swap icon');
  assert.equal(moveBtn.props['aria-label'], '换到该空位');
  assert.equal(moveBtn.props['data-testid'], 'move-empty-3');
  assert.equal(moveBtn.props.disabled, false);
  assert.equal(moveBtn.props.loading, false);
  assert.equal(tipOf(emptyCard).props.text, '换到该空位', 'the tooltip states the action, not a refusal');
  moveBtn.props.onClick();
  assert.deepEqual(calls, [3], 'one click -> one room.moveToEmpty with that seat index, with no dialog in between');
  // the same rule straight off room.state (what the screen passes in)
  assert.deepEqual(moveToEmpty(free, 'g', 3), { show: true, allowed: true, hint: '换到该空位' });
  assert.deepEqual(moveToEmptySeat(roomFacts(free, 'g'), 3, 'g'), moveToEmpty(free, 'g', 3));

  // 准备后置灰 with the same wording the occupied button uses (the server refuses the identical request)
  const readyFrame = frame({ seats: [{ ...frame().seats[0] }, { ...frame().seats[1], ready: true }, null, null] });
  assert.deepEqual(moveToEmpty(readyFrame, 'g', 3), { show: true, allowed: false, hint: '准备后无法换位' });
  const readyCard = emptyCardOf(readyFrame);
  assert.equal(swapOf(readyCard).props.disabled, true);
  assert.equal(tipOf(readyCard).props.text, '准备后无法换位');

  // 开赛后隐藏 (the frame the server would refuse anyway), and never in a solo room or for a doctor without a seat
  const inMatch = frame({ inMatch: true });
  assert.equal(swapOf(emptyCardOf(inMatch)), undefined);
  assert.deepEqual(moveToEmpty(inMatch, 'g', 3), { show: false, allowed: false, hint: null });
  const solo = frame({ mode: 'solo', capacity: 1, seats: [{ ...frame().seats[0] }] });
  assert.deepEqual(moveToEmpty(solo, 'h', 1), { show: false, allowed: false, hint: null });
  const noSeat = frame({ seats: [frame().seats[0], null, null, null] });
  assert.equal(moveToEmpty(noSeat, 'g', 2).show, false, 'a doctor without a seat is never seated by this');
  // the host IS the seat-0 record while the room waits (server promoteHostSeat): it is told why, not bounced back
  assert.deepEqual(moveToEmpty(free, 'h', 3), { show: true, allowed: false, hint: '房主固定在 P1，无法换到空位' });
  // a pending outgoing ask blocks it exactly like the occupied button, and busy greys every button out
  const asking = frame({ swaps: [{ from: 'g', to: 'h', ttlMs: 30_000 }] });
  assert.equal(moveToEmpty(asking, 'g', 3).hint, '等待对方确认…');
  const busyCard = SeatCard({ seat: null, index: 3, room: free, facts: roomFacts(free, 'g'), myId: 'g',
    busy: 'move3', onMoveToEmpty: () => {} });
  assert.equal(swapOf(busyCard).props.disabled, true);
  assert.equal(swapOf(busyCard).props.loading, true);

  // OCCUPIED seats are untouched by all of this: their button keeps the negotiation, wording, test id and handler
  const occCard = SeatCard({ seat: free.seats[0], index: 0, room: free, facts: roomFacts(free, 'g'), myId: 'g', busy: null });
  const occ = swapOf(occCard);
  assert.equal(occ.props['aria-label'], '请求与该博士交换位置');
  assert.equal(occ.props['data-testid'], 'swap-0');
  assert.equal(tipOf(occCard).props.text, '请求与该博士交换位置', 'the occupied seat asks; the empty seat moves');
  // after the start the OCCUPIED button stays, greyed out with 开局后无法换位 (the empty one is gone, see above)
  const inMatchOcc = SeatCard({ seat: inMatch.seats[0], index: 0, room: inMatch, facts: roomFacts(inMatch, 'g'),
    myId: 'g', busy: null });
  assert.equal(swapOf(inMatchOcc).props.disabled, true);
  assert.equal(tipOf(inMatchOcc).props.text, '开局后无法换位');
  // an empty seat as seen by a spectator: no button at all
  const spectating = frame({ spectators: [{ playerId: 'g', connected: true }] });
  assert.equal(swapOf(emptyCardOf(spectating)), undefined, 'a spectator gets no button');
});
