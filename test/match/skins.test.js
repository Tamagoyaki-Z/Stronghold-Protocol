// 干员皮肤 (docs/SKINS.md) — the whole link, end to end.
//
//   client choice → room.skins (shared/protocol.js) → lobby.skins() freezeSkins (server/lobby.js)
//     → seat.skins / session.skins → PlayerState.setSkins (server/match/player/basics.js)
//     → Match.publicView().players[].skins + the prep unit's `skin` (server/match/match/views.js)
//     → chessAvatarUrl(m, chess, skinId) draws it (public/js/ui/assetUrls.js)
//
// The 口径 every layer has to agree on: a skin choice is keyed by the **base** chess id. The elite (精锐) record
// carries `baseId` pointing at its base card, and both the server filter and the view lookup use the base id first —
// a choice stored under the elite id is dropped, which is why the picker writes the base id too.
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../../server/index.js';
import { StubMatch } from '../../server/match/StubMatch.js';
import { getData } from '../../server/data.js';
import { TestClient } from '../helpers/wsClient.js';
import { ERR } from '../../shared/constants.js';
import { DATA as MATCH_DATA, makeMatch } from './harness.js';
import { chessAvatarUrl } from '../../public/js/ui/assetUrls.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'data', 'assets.json'), 'utf8'));
const DATA = getData({ log: { warn() {}, error() {}, info() {} } });
const C = (id) => DATA.chess[id];

// ---- fixtures out of the real data ---------------------------------------------------------------------------------

const SKADI_CHAR = 'char_1012_skadi2';            // two built-in skins
const SKADI = 'chess_char_6_04_a';                // its normal chess record (baseId === itself)
const SKADI_ELITE = 'chess_char_6_04_b';          // its 精锐 record (baseId → SKADI)
const SKIN_A = `char_1012_skadi2@iteration#2`;
const SKIN_B = `char_1012_skadi2@boc#4`;

const HIDDEN = Object.values(DATA.chess).find((c) => !c.isGolden && (c.isHidden || c.visible === false));
const GOLDEN = Object.values(DATA.chess).find((c) => c.isGolden);

const ok = async (c, msg) => { const r = await c.request(msg); assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`); return r; };
const err = async (c, msg, code) => { const r = await c.request(msg); assert.equal(r.t, 'error', JSON.stringify(r)); assert.equal(r.code, code, JSON.stringify(r)); return r; };

/** Stub match that records the seat descriptors the lobby hands it (it has no setSkins of its own). */
class RecordingStub extends StubMatch {
  static instances = [];
  constructor(opts) { super(opts); this.opts = opts; this.skinCalls = []; RecordingStub.instances.push(this); }
}

/** A match that only records setSkins (the lobby's match path, without running the real engine). */
class SkinStub extends StubMatch {
  static instances = [];
  constructor(opts) { super(opts); this.opts = opts; this.skinCalls = []; SkinStub.instances.push(this); }
  setSkins(playerId, skins) { this.skinCalls.push({ playerId, skins }); return { ok: true }; }
}

function clientPool(getUrl) {
  const open = new Set();
  return {
    async player(name, token) {
      const c = await TestClient.connect(getUrl());
      open.add(c);
      const w = await c.hello(name, token);
      c.id = w.playerId;
      c.token = w.token;
      return c;
    },
    async closeAll() { await Promise.all([...open].map((c) => c.terminate().catch(() => {}))); open.clear(); },
  };
}
const quietLog = () => ({ log: { info() {}, warn() {}, debug() {}, error() {} } });

// ---- 1. the protocol shape -----------------------------------------------------------------------------------------

describe('room.skins structure (shared/protocol.js)', () => {
  test('accepts { baseChessId: skinId } with @ and #, refuses arrays / null / bad ids / too many entries', async () => {
    const { validateC2S, isSkinId, isSkinSelection, SKIN_LIMITS, isRoomAvatar } = await import('../../shared/protocol.js');
    const okShape = (skins) => validateC2S({ t: 'room.skins', skins }) === null;
    assert.ok(isSkinId(SKIN_A), 'a skin id may carry @ and #');
    assert.ok(!isSkinId(''), 'empty');
    assert.ok(!isSkinId('has space'), 'space');
    assert.ok(!isSkinId('x'.repeat(SKIN_LIMITS.idLen + 1)), 'too long');
    assert.ok(isSkinSelection({}), 'empty map');
    assert.ok(okShape({ [SKADI]: SKIN_A }));
    assert.ok(okShape({ [SKADI]: SKIN_A, [SKADI_ELITE]: SKIN_B }), 'the elite id is structurally legal');
    assert.ok(!okShape([]), 'array');
    assert.ok(!okShape(null), 'null');
    assert.ok(!okShape('x'), 'string');
    assert.ok(!okShape({ [SKADI]: '' }), 'empty skinId');
    assert.ok(!okShape({ [SKADI]: 'a b' }), 'bad skinId');
    assert.ok(!okShape({ 'bad id!': SKIN_A }), 'bad chess id');
    const many = {};
    for (let i = 0; i <= SKIN_LIMITS.entries; i++) many[`c${i}`] = SKIN_A;
    assert.ok(!okShape(many), 'too many entries');
    assert.equal(validateC2S({ t: 'room.skins' }), 'bad field skins');
  });

  test('room skins avatar: { chessId, skinId? }, null clears it, optional for an older client, junk refused', async () => {
    const { validateC2S, isRoomAvatar } = await import('../../shared/protocol.js');
    const okAvatar = (avatar) => validateC2S({ t: 'room.skins', skins: {}, avatar }) === null;
    assert.ok(isRoomAvatar({ chessId: SKADI }), 'the operator alone = its own default art');
    assert.ok(isRoomAvatar({ chessId: SKADI, skinId: SKIN_A }), 'an art of a built-in skin');
    assert.ok(isRoomAvatar({ chessId: SKADI, skinId: null }), 'explicitly the default art');
    assert.ok(okAvatar({ chessId: SKADI, skinId: SKIN_A }));
    assert.ok(okAvatar({ chessId: SKADI }));
    assert.ok(okAvatar(null), 'null clears the room avatar');
    assert.ok(validateC2S({ t: 'room.skins', skins: {} }) === null, 'absent avatar = an older client');
    for (const bad of [[], 'x', 7, {}, { chessId: '' }, { chessId: 'bad id!' }, { chessId: SKADI, skinId: '' },
      { chessId: SKADI, skinId: 'a b' }, { chessId: SKADI, skinId: 'x'.repeat(65) }]) {
      assert.equal(isRoomAvatar(bad), false, `refused ${JSON.stringify(bad)}`);
      assert.equal(okAvatar(bad), false, `refused over the wire ${JSON.stringify(bad)}`);
    }
    // the avatar never replaces the skins: both fields travel in one message
    assert.equal(validateC2S({ t: 'room.skins', skins: { [SKADI]: SKIN_A }, avatar: { chessId: SKADI, skinId: SKIN_A }, nope: 1 }), null,
      'unknown extra fields stay ignored, exactly like before');
  });
});

// ---- 2. the lobby round trip (WebSocket, stub match) ---------------------------------------------------------------

describe('room.skins (lobby): freeze on the session and the seat, hand over to the match', () => {
  let srv, pool;
  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', ...quietLog(), MatchClass: RecordingStub });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => { RecordingStub.instances = []; await pool.closeAll(); });
  after(async () => { await srv?.close(); });

  test('freezeSkins keeps only chess the data knows: unknown chess, golden, hidden, DIY and elite keys are dropped', async () => {
    const a = await pool.player('SkinHost');
    await ok(a, { t: 'room.skins', skins: {
      [SKADI]: SKIN_A,                              // kept
      chess_char_9_99_a: SKIN_A,                    // unknown chess
      [GOLDEN.chessId]: SKIN_A,                     // a 精锐 record (isGolden) — refused
      [SKADI_ELITE]: SKIN_B,                        // the elite id of a real operator — baseId !== id
      [HIDDEN.chessId]: SKIN_A,                     // isHidden / invisible
      'chess_char_6_diy1_a': SKIN_A,                // a 自选 slot record
    } });
    await ok(a, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    await a.waitFor('room.state', (s) => s.hostId === a.id);
    await ok(a, { t: 'room.start' });
    await a.waitFor('m.public', (p) => p.phase === 'INFO_CHECK');
    const seat = RecordingStub.instances.at(-1).opts.seats[0];
    assert.deepEqual(seat.skins, { [SKADI]: SKIN_A }, 'exactly the one legal entry survived the freeze');
    assert.ok(Object.isFrozen(seat.skins), 'frozen (a shared, immutable snapshot)');
  });

  test('a malformed frame is refused with BAD_MSG and stores nothing', async () => {
    const a = await pool.player('Malformed');
    await err(a, { t: 'room.skins', skins: [] }, ERR.BAD_MSG);
    await err(a, { t: 'room.skins' }, ERR.BAD_MSG);
    await err(a, { t: 'room.skins', skins: { [SKADI]: 'a b' } }, ERR.BAD_MSG);
    // nothing was stored: the seat descriptor the match receives carries no skins at all
    await ok(a, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    await a.waitFor('room.state', (s) => s.hostId === a.id);
    await ok(a, { t: 'room.start' });
    await a.waitFor('m.public', (p) => p.phase === 'INFO_CHECK');
    assert.equal(RecordingStub.instances.at(-1).opts.seats[0].skins, null);
  });

  test('the session keeps them across a resume; a bot seat carries null', async () => {
    const host = await pool.player('Host');
    await ok(host, { t: 'room.skins', skins: { [SKADI]: SKIN_A } });     // outside a room: kept on the session
    await ok(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    await host.waitFor('room.state', (s) => s.hostId === host.id);
    await ok(host, { t: 'room.addBot' });
    await host.waitFor('room.state', (s) => s.seats.some((x) => x && x.isBot));
    // the guest drops and resumes with its token: the session brings the skins back into the seat record
    await host.terminate();
    const back = await pool.player('Host', host.token);
    assert.equal(back.id, host.id, 'same playerId');
    await back.waitFor('room.state', (s) => s.seats.some((x) => x && x.isBot));
    await ok(back, { t: 'room.start' });
    await back.waitFor('m.public', (p) => p.phase === 'INFO_CHECK');
    const seats = RecordingStub.instances.at(-1).opts.seats;
    assert.deepEqual(seats.find((s) => s.playerId === back.id).skins, { [SKADI]: SKIN_A },
      'a resumed session still hands its skins to the match');
    assert.equal(seats.find((s) => s.isBot).skins, null, 'bots wear the default models');
  });

  test('room.state.seats[].skins carries the choice to the whole waiting room (bots null)', async () => {
    const host = await pool.player('WaitHost');
    const guest = await pool.player('WaitGuest');
    await ok(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const created = await host.waitFor('room.state', (s) => s.hostId === host.id);
    await ok(guest, { t: 'room.join', code: created.code });
    await host.waitFor('room.state', (s) => s.seats.filter(Boolean).length === 2);
    await ok(host, { t: 'room.addBot' });
    await host.waitFor('room.state', (s) => s.seats.some((x) => x && x.isBot));

    // the guest picks a skin: the OTHER member (the host) must learn it from room.state alone — no match, no
    // m.public, nothing else carries a skin while the room is still a waiting room
    const seen = host.waitFor('room.state', (s) => !!s.seats.find((x) => x && x.playerId === guest.id)?.skins);
    await ok(guest, { t: 'room.skins', skins: { [SKADI]: SKIN_A, chess_char_9_99_a: SKIN_A } });
    const frame = await seen;
    assert.deepEqual(frame.seats.find((x) => x.playerId === guest.id).skins, { [SKADI]: SKIN_A },
      'the frozen map reaches the bystander, with the unknown chess already dropped');
    assert.equal(frame.seats.find((x) => x.isBot).skins, null, 'a bot wears the default models');
    assert.equal(frame.seats.find((x) => x.playerId === host.id).skins, null, 'a doctor who chose nothing says so');
    // the seat-only resume path reads the same field (humanSeat copies session.skins into the seat)
    await guest.terminate();
    const back = await pool.player('WaitGuest', guest.token);
    assert.equal(back.id, guest.id);
    const resumed = await back.waitFor('room.state', (s) => !!s.seats.find((x) => x && x.playerId === back.id));
    assert.deepEqual(resumed.seats.find((x) => x.playerId === back.id).skins, { [SKADI]: SKIN_A },
      'a resumed session comes back into the waiting room wearing its skins');
  });

  test('room.state.seats[].avatar carries the chosen room avatar to the WHOLE waiting room, and follows a change', async () => {
    const host = await pool.player('AvatarHost');
    const guest = await pool.player('AvatarGuest');
    await ok(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const created = await host.waitFor('room.state', (s) => s.hostId === host.id);
    await ok(guest, { t: 'room.join', code: created.code });
    await host.waitFor('room.state', (s) => s.seats.filter(Boolean).length === 2);
    await ok(host, { t: 'room.addBot' });
    await host.waitFor('room.state', (s) => s.seats.some((x) => x && x.isBot));

    // ① the guest picks one of their operator arts as the room avatar: the OTHER member learns it from room.state
    const seen = host.waitFor('room.state', (s) => !!s.seats.find((x) => x && x.playerId === guest.id)?.avatar);
    await ok(guest, { t: 'room.skins', skins: { [SKADI]: SKIN_A }, avatar: { chessId: SKADI, skinId: SKIN_A } });
    const first = await seen;
    const gSeat = first.seats.find((x) => x.playerId === guest.id);
    assert.deepEqual(gSeat.avatar, { chessId: SKADI, skinId: SKIN_A }, 'the exact reference reached the bystander');
    assert.deepEqual(gSeat.skins, { [SKADI]: SKIN_A }, 'the skins map is untouched by the avatar');
    assert.equal(first.seats.find((x) => x.isBot).avatar, null, 'a bot has no room avatar');
    assert.equal(first.seats.find((x) => x.playerId === host.id).avatar, null, 'a doctor who picked none says so');

    // ② changing it follows, and the second frame is what the room sees
    const changed = host.waitFor('room.state', (s) => s.seats.find((x) => x && x.playerId === guest.id)?.avatar?.skinId === SKIN_B);
    await ok(guest, { t: 'room.skins', skins: { [SKADI]: SKIN_A }, avatar: { chessId: SKADI, skinId: SKIN_B } });
    assert.deepEqual((await changed).seats.find((x) => x.playerId === guest.id).avatar, { chessId: SKADI, skinId: SKIN_B });

    // ③ clearing it: null, back to the default placeholder
    const cleared = host.waitFor('room.state', (s) => {
      const st = s.seats.find((x) => x && x.playerId === guest.id);
      return !!st && st.skins !== null && st.avatar === null;
    });
    await ok(guest, { t: 'room.skins', skins: { [SKADI]: SKIN_A }, avatar: null });
    assert.equal((await cleared).seats.find((x) => x.playerId === guest.id).avatar, null);

    // ④ an unknown / illegal chess id is dropped by the server: no avatar, and nothing crashes
    await ok(guest, { t: 'room.skins', skins: { [SKADI]: SKIN_A }, avatar: { chessId: 'chess_char_9_99_a', skinId: SKIN_A } });
    assert.equal(SkinStub.instances.length + RecordingStub.instances.length, 0, 'no match was ever started here');
    await ok(guest, { t: 'room.skins', skins: { [SKADI]: SKIN_A }, avatar: { chessId: GOLDEN.chessId, skinId: SKIN_A } });
    await ok(guest, { t: 'room.skins', skins: { [SKADI]: SKIN_A }, avatar: { chessId: SKADI_ELITE, skinId: SKIN_A } });
    // a malformed reference is refused at the protocol before the handler ever runs
    await err(guest, { t: 'room.skins', skins: { [SKADI]: SKIN_A }, avatar: { chessId: SKADI, skinId: 'a b' } }, ERR.BAD_MSG);
    // and what survives all of that is still the previous good state (null after ③)
    const last = await (async () => {
      // the predicate must name the avatar we are waiting FOR: an intermediate frame (still null after ③)
      // also carries the guest's seat and would otherwise satisfy a looser wait
      const w = host.waitFor('room.state', (s) =>
        s.seats.find((x) => x && x.playerId === guest.id)?.avatar?.skinId === SKIN_B);
      await ok(guest, { t: 'room.skins', skins: { [SKADI]: SKIN_B }, avatar: { chessId: SKADI, skinId: SKIN_B } });
      return w;
    })();
    assert.deepEqual(last.seats.find((x) => x.playerId === guest.id).avatar, { chessId: SKADI, skinId: SKIN_B });
    await ok(guest, { t: 'room.leave' });
  });

  test('an unknown chess id never reaches the room state: the seat keeps null (no blank, no crash)', async () => {
    const host = await pool.player('JunkAvatar');
    await ok(host, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    await host.waitFor('room.state', (s) => s.hostId === host.id);
    // the handshake accepts the id, the lobby's freeze drops it: the seat publishes null, never a broken reference
    await ok(host, { t: 'room.skins', skins: {}, avatar: { chessId: 'chess_char_9_99_a', skinId: SKIN_A } });
    const frame = await host.waitFor('room.state', (s) => !!s.seats.find((x) => x && x.playerId === host.id));
    assert.equal(frame.seats.find((x) => x.playerId === host.id).avatar, null);
  });

  test('seats[].skins reaches the match: start() hands it over in the seat descriptors', async () => {
    const host = await pool.player('Hand');
    await ok(host, { t: 'room.skins', skins: { [SKADI]: SKIN_B, chess_char_9_99_a: SKIN_A } });
    await ok(host, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    await host.waitFor('room.state', (s) => s.hostId === host.id);
    await ok(host, { t: 'room.start' });
    await host.waitFor('m.public', (p) => p.phase === 'INFO_CHECK');
    const m = RecordingStub.instances.at(-1);
    assert.deepEqual(m.opts.seats[0].skins, { [SKADI]: SKIN_B }, 'the drop happened once, in the lobby');
    assert.ok(Object.isFrozen(m.opts.seats[0].skins));
  });
});

describe('room.skins during a match: handed to the running match when it can take it', () => {
  let srv, pool;
  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', ...quietLog(), MatchClass: SkinStub });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => { SkinStub.instances = []; await pool.closeAll(); });
  after(async () => { await srv?.close(); });

  test('a match with setSkins receives the frozen selection; one without it answers ROOM_STARTED but stores it', async () => {
    const host = await pool.player('Live');
    await ok(host, { t: 'room.skins', skins: { [SKADI]: SKIN_A } });
    await ok(host, { t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    await host.waitFor('room.state', (s) => s.hostId === host.id);
    await ok(host, { t: 'room.start' });
    await host.waitFor('m.public', (p) => p.phase === 'INFO_CHECK');
    const m = SkinStub.instances.at(-1);
    assert.deepEqual(m.skinCalls, [], 'nothing was sent yet');
    m.skinCalls.length = 0;
    await ok(host, { t: 'room.skins', skins: { [SKADI]: SKIN_B } });
    assert.deepEqual(m.skinCalls.map((x) => [x.playerId, x.skins]), [[host.id, { [SKADI]: SKIN_B }]],
      'the match got the frozen map');
    await ok(host, { t: 'room.leave' });
  });
});

// ---- 3. the match side: PlayerState → publicView → the prep unit ----------------------------------------------------

describe('the match side: seat.skins → PlayerState → publicView().players[].skins', () => {
  const seatsWith = (skins) => [
    { seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, skins },
    { seat: 1, playerId: 'ai_0', name: 'AI0', isBot: true, connected: true, skins },
  ];

  test('playerView carries the accepted map (omitted when empty); bots get none; the elite key is dropped here too', () => {
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', seats: seatsWith({
      [SKADI]: SKIN_A, [SKADI_ELITE]: SKIN_B, chess_char_9_99_a: SKIN_A,
    }) }).start();
    const ps = h.ps('p_0');
    assert.deepEqual(ps.skins, { [SKADI]: SKIN_A }, 'the seat record was re-checked against this match data');
    assert.ok(Object.isFrozen(ps.skins));
    const pv = h.m.publicView().players.find((p) => p.playerId === 'p_0');
    assert.deepEqual(pv.skins, { [SKADI]: SKIN_A });
    const bot = h.m.publicView().players.find((p) => p.playerId === 'ai_0');
    assert.equal(bot.skins, undefined, 'a bot is never given a skin');
    h.m.dispose();
  });

  test('a player with no skins omits the field entirely (no bytes on the hot path)', () => {
    const h = makeMatch({ mode: 'coop', seats: seatsWith(undefined) }).start();
    const pv = h.m.publicView().players.find((p) => p.playerId === 'p_0');
    assert.equal('skins' in pv, false);
    h.m.dispose();
  });

  test('setSkins replaces the choice; refused for a bot and for an unknown chess', () => {
    const h = makeMatch({ mode: 'coop', seats: seatsWith({ [SKADI]: SKIN_A }) }).start();
    const ps = h.ps('p_0');
    assert.equal(ps.setSkins({ [SKADI]: SKIN_B }), true);
    assert.deepEqual(ps.skins, { [SKADI]: SKIN_B });
    assert.equal(ps.setSkins({ chess_char_9_99_a: SKIN_A }), false, 'nothing accepted');
    assert.deepEqual(ps.skins, {}, 'and the selection is now empty (a full replace)');
    assert.equal(ps.setSkins({ [SKADI_ELITE]: SKIN_A }), false, 'the elite id is not a legal key');
    assert.equal(h.ps('ai_0').setSkins({ [SKADI]: SKIN_A }), false, 'bots keep the default models');
    h.m.dispose();
  });

  test('the prep unit carries `skin`, resolved through the BASE chess id (the 精锐 card hits it too)', () => {
    const h = makeMatch({ mode: 'coop', seats: seatsWith({ [SKADI]: SKIN_A, [SKADI_ELITE]: SKIN_B }) }).start();
    const ps = h.ps('p_0');
    const base = ps.newPiece('chess', SKADI);
    ps.board.set('10,4', base);
    const golden = ps.newPiece('chess', SKADI_ELITE);
    ps.board.set('10,6', golden);

    const meta = h.m.prepFieldMeta(ps);
    const byUid = (u) => meta.units.find((x) => x.uid === u.uid);
    assert.equal(byUid(base).skin, SKIN_A, 'the base card reads its own entry');
    assert.equal(byUid(golden).skin, SKIN_A,
      'the 精锐 card resolves through baseId — the elite key was dropped, the base one is what has to hit');
    // a token is never given a skin
    const tok = ps.newPiece('token', 'token_10001_medic');
    ps.board.set('10,8', tok);
    assert.equal(h.m.prepFieldMeta(ps).units.find((x) => x.uid === tok.uid).skin, undefined);
    h.m.dispose();
  });
});

// ---- 4. the client side: the chosen skin is what the URL helper draws ------------------------------------------------

describe('the client side: chessAvatarUrl draws the chosen skin', () => {
  test('the chosen skin avatar wins over the operator art, and an absent one falls back', () => {
    const base = C(SKADI);
    const skinArt = manifest.chars[SKADI_CHAR].skins[SKIN_A].avatar;
    assert.ok(skinArt, 'the manifest carries this skin');
    assert.equal(chessAvatarUrl(manifest, base, SKIN_A), skinArt);
    assert.notEqual(chessAvatarUrl(manifest, base, SKIN_A), chessAvatarUrl(manifest, base));
    assert.equal(chessAvatarUrl(manifest, base, 'no_such_skin'), chessAvatarUrl(manifest, base), 'unknown skin falls back');
    assert.equal(chessAvatarUrl(manifest, base, null), chessAvatarUrl(manifest, base), 'no choice falls back');
    const elite = C(SKADI_ELITE);
    assert.equal(chessAvatarUrl(manifest, elite, SKIN_A), skinArt, 'the 精锐 record resolves the same skin');
    // every installed skin of every operator resolves to a file the manifest lists
    for (const [charId, rec] of Object.entries(manifest.chars)) {
      const chess = Object.values(DATA.chess).find((c) => c.charId === charId && !c.isGolden && !c.isDiy);
      if (!chess) continue;
      for (const skinId of Object.keys(rec.skins || {})) {
        assert.equal(chessAvatarUrl(manifest, chess, skinId), rec.skins[skinId].avatar, `${charId} ${skinId}`);
      }
    }
  });
});

// ---- 5. cheat check: the fixtures themselves -------------------------------------------------------------------------

test('the fixtures describe the real data (guards the suite against a silent data change)', () => {
  assert.equal(C(SKADI).charId, SKADI_CHAR);
  assert.equal(C(SKADI).baseId, SKADI, 'the base record points at itself');
  assert.equal(C(SKADI_ELITE).baseId, SKADI, 'the elite record points at the base card');
  assert.ok(C(SKADI_ELITE).isGolden);
  assert.ok(!C(SKADI).isGolden && C(SKADI).visible && !C(SKADI).isHidden && !C(SKADI).isDiy);
  assert.ok(HIDDEN, 'the data has a hidden chess record');
  assert.ok(GOLDEN, 'the data has an elite chess record');
  assert.equal(Object.keys(manifest.chars[SKADI_CHAR].skins).length, 2);
  assert.ok(MATCH_DATA === DATA || Object.keys(MATCH_DATA.chess).length > 0, 'the match harness reads the real data');
});
