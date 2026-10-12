import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Button } from '../../public/js/ui/components.js';
import {
  roomFacts, SeatCard, MatchmakingControl, roomShowsGroups, poolGroups, seatGroup, seatGroupOf, groupLetter, groupColor,
  GROUP_COLORS, skinAvatarFor,
} from '../../public/js/screens/room.js';

function* walk(node) {
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; }
  if (!node || typeof node !== 'object') return;
  yield node;
  yield* walk(node.props?.children);
}

const host = { seat: 0, playerId: 'host', name: 'Host', connected: true, ready: false, isBot: false };
const guest = { seat: 1, playerId: 'guest', name: 'Guest', connected: true, ready: true, isBot: false };
const bot = { seat: 2, playerId: 'bot', name: 'AI', connected: true, ready: true, isBot: true };
const room = (changes = {}) => ({ hostId: host.playerId, mode: 'coop', capacity: 4, inMatch: false, seats: [host, guest, bot, null], ...changes });

test('matchmaking defaults open in old frames and only a seated waiting co-op host can change it', () => {
  for (const capacity of [4, 8, 20]) {
    const source = room({ capacity });
    assert.equal(roomFacts(source, 'host').allowMatchmaking, true);
    assert.equal(roomFacts(source, 'host').canSetMatchmaking, true);
    assert.equal(roomFacts({ ...source, allowMatchmaking: false }, 'host').allowMatchmaking, false);
    for (const id of ['guest', 'bot', 'spectator', 'missing']) assert.equal(roomFacts(source, id).canSetMatchmaking, false);
  }
  for (const changes of [{ inMatch: true }, { mode: 'solo' }, { seats: [null, guest] }, { seats: [{ ...host, left: true }] }, { seats: [{ ...host, isBot: true }] }]) {
    assert.equal(roomFacts(room(changes), 'host').canSetMatchmaking, false);
  }
});

test('matchmaking switch follows server state, busy and connection state, and host-transfer permissions', () => {
  const changed = [];
  const facts = roomFacts(room(), 'host');
  const props = { facts, connected: true, busy: null, onChange: (allowed) => changed.push(allowed) };
  const control = MatchmakingControl(props);
  assert.equal(control.type, 'button');
  assert.equal(control.props.role, 'switch');
  assert.equal(control.props['aria-checked'], 'true');
  assert.equal(control.props['aria-label'], '允许匹配');
  assert.equal(control.props.disabled, false);
  assert.match(control.props.title, /邀请码仍可加入，观战不受影响/);
  control.props.onClick();
  const closed = MatchmakingControl({ ...props, facts: roomFacts(room({ allowMatchmaking: false }), 'host') });
  assert.equal(closed.props['aria-checked'], 'false');
  closed.props.onClick();
  assert.deepEqual(changed, [false, true]);
  assert.equal(MatchmakingControl({ ...props, busy: 'capacity' }).props.disabled, true);
  assert.equal(MatchmakingControl({ ...props, connected: false }).props.disabled, true);
  const transferred = room({ hostId: 'guest', allowMatchmaking: false, seats: [{ ...guest, seat: 0 }, { ...host, seat: 1 }, bot] });
  const oldHost = MatchmakingControl({ ...props, facts: roomFacts(transferred, 'host') });
  assert.equal(oldHost.type, 'span');
  assert.equal(oldHost.props.onClick, undefined);
  assert.equal(oldHost.props.role, 'status');
  const newHost = MatchmakingControl({ ...props, facts: roomFacts(transferred, 'guest') });
  assert.equal(newHost.type, 'button');
  assert.equal(newHost.props['aria-checked'], 'false');
});

test('AI room limit counts only AI, supports zero and unrestricted old frames, and never expands capacity', () => {
  for (const capacity of [4, 8, 20]) {
    const source = room({ capacity });
    assert.equal(roomFacts(source, 'host').canAddBot, true);
    assert.equal(roomFacts({ ...source, maxAiPerRoom: null }, 'host').maxAiPerRoom, null);
    const atLimit = roomFacts({ ...source, maxAiPerRoom: 1 }, 'host');
    assert.equal(atLimit.botCount, 1);
    assert.equal(atLimit.aiLimitReached, true);
    assert.equal(atLimit.aiLimitExceeded, false);
    assert.equal(atLimit.canAddBot, false);
    assert.equal(atLimit.canStart, true);
    const overLimit = roomFacts({ ...source, maxAiPerRoom: 0 }, 'host');
    assert.equal(overLimit.aiLimitExceeded, true);
    assert.equal(overLimit.canStart, false);
  }
  assert.equal(roomFacts(room({ maxAiPerRoom: 19, seats: [host, guest, bot, { ...bot, seat: 3, playerId: 'bot2' }] }), 'host').canAddBot, false);
  assert.equal(roomFacts(room(), 'guest').canAddBot, false);
  assert.equal(roomFacts(room({ inMatch: true }), 'host').canAddBot, false);
  assert.equal(roomFacts(room({ mode: 'solo', capacity: 1, seats: [host] }), 'host').canAddBot, false);
});

test('room transfer eligibility contains only online other humans and never observers or playing matches', () => {
  const offline = { ...guest, seat: 3, playerId: 'offline', connected: false };
  const source = room({ seats: [host, guest, bot, offline], spectators: [{ playerId: 'spectator', connected: true }] });
  assert.deepEqual(roomFacts(source, 'host').transferableHumans.map((s) => s.playerId), ['guest']);
  for (const playerId of ['guest', 'bot', 'spectator', 'missing']) {
    assert.deepEqual(roomFacts(source, playerId).transferableHumans, []);
  }
  assert.deepEqual(roomFacts({ ...source, inMatch: true }, 'host').transferableHumans, []);
});

test('member controls render transfer beside kick, preserve confirmed identities, and disable while busy', () => {
  const source = room();
  const calls = [];
  const props = { seat: guest, index: 1, room: source, facts: roomFacts(source, 'host'), myId: 'host', busy: null,
    onTransferHost: (...args) => calls.push(args), onKick: (...args) => calls.push(args) };
  const buttons = [...walk(SeatCard(props))].filter((n) => n.type === Button);
  // the third control is ⇄ 换位 (room.swapAsk): it is greyed out here because this fixture's Guest is ready
  // (准备后不再换位 — and the server refuses the same ask, so the button only ever mirrors the rule)
  assert.deepEqual(buttons.map((n) => n.props.icon), ['crown', 'close', 'swap']);
  assert.equal(buttons[2].props['aria-label'], '请求与该博士交换位置');
  assert.equal(buttons[2].props.disabled, true, 'a ready doctor is never named');
  assert.equal(buttons[0].props['aria-label'], '转让房主给该博士');
  buttons[0].props.onClick();
  buttons[1].props.onClick();
  assert.deepEqual(calls, [[1, 'Guest', 'guest'], [1, 'Guest', 'guest']]);
  assert.ok([...walk(SeatCard({ ...props, busy: 'transfer1' }))].filter((n) => n.type === Button).every((n) => n.props.disabled));
  const botCard = SeatCard({ ...props, seat: bot, index: 2, onRemoveBot: (...args) => calls.push(args) });
  const botButtons = [...walk(botCard)].filter((n) => n.type === Button);
  assert.equal(botButtons.length, 1);
  botButtons[0].props.onClick();
  assert.deepEqual(calls.at(-1), [2, 'bot']);
  // ⇄ 换位: an unready doctor may be asked, a ready one never (the same rule the server enforces)
  const open = { ...guest, ready: false };
  const openSource = room({ seats: [host, open, bot, null] });
  const openCard = [...walk(SeatCard({ ...props, seat: open, facts: roomFacts(openSource, 'host') }))].filter((n) => n.type === Button);
  assert.equal(openCard.find((n) => n.props.icon === 'swap').props.disabled, false);
  const readyAsker = [...walk(SeatCard({ ...props, myId: 'guest', seat: host, facts: roomFacts(source, 'guest') }))]
    .filter((n) => n.type === Button && n.props.icon === 'swap');
  assert.equal(readyAsker.length, 1, 'the ready asker still sees the control…');
  assert.equal(readyAsker[0].props.disabled, true, '…greyed out (准备后无法换位)');
  // the offline doctor keeps its own greyed ⇄ beside the host's ✕
  assert.equal([...walk(SeatCard({ ...props, seat: { ...guest, connected: false } }))].filter((n) => n.type === Button).length, 2);
  assert.equal([...walk(SeatCard({ ...props, myId: 'guest', facts: roomFacts(source, 'guest') }))].filter((n) => n.type === Button).length, 0);
});

test('empty seats explain server AI limit and block repeated or conflicting additions', () => {
  const source = room({ maxAiPerRoom: 1 });
  const props = { seat: null, index: 3, room: source, facts: roomFacts(source, 'host'), myId: 'host', busy: null };
  const button = [...walk(SeatCard(props))].find((n) => n.type === Button);
  assert.equal(button.props.disabled, true);
  assert.equal(button.props.title, '已达到服务器允许的 AI 队友上限');
  const unrestricted = room();
  const busyButton = [...walk(SeatCard({ ...props, room: unrestricted, facts: roomFacts(unrestricted, 'host'), busy: 'transfer1' }))].find((n) => n.type === Button);
  assert.equal(busyButton.props.disabled, true);
});

// ---- ③b 卡池分组显示 (owner's decision 2026-10-10) ----------------------------------------------------------------

test('the seat groups follow the server frame, and the shared rule only for a seat-only one', () => {
  // the server sends `groups` once the room actually splits (>5); the client then never recomputes it
  const six = { seat: 0, playerId: 'p0', name: 'P0', isBot: false, ready: false, connected: true };
  const source = room({ capacity: 8, groups: [3, 3], seats: [0, 1, 2, 3, 4, 5].map((i) => ({ ...six, seat: i, playerId: `p${i}` })) });
  assert.deepEqual(roomFacts(source, 'p0').groups, [3, 3]);
  assert.equal(roomShowsGroups(source, roomFacts(source, 'p0')), true);
  // a seat-only frame (an older server) falls back to the shared layout, in occupied seat order
  const bare = { ...source };
  delete bare.groups;
  assert.deepEqual(roomFacts(bare, 'p0').groups, [3, 3]);
  // five or fewer share ONE pool: the server omits `groups` and no chip is drawn
  const five = { ...source, seats: source.seats.slice(0, 5) };
  delete five.groups;
  assert.deepEqual(roomFacts(five, 'p0').groups, []);
  assert.equal(roomShowsGroups(five, roomFacts(five, 'p0')), false, 'never a single 「A 组」 label for a whole room');
  // solo rooms have no groups at all
  const solo = room({ mode: 'solo', capacity: 1, seats: [host] });
  assert.deepEqual(poolGroups(solo), []);
  assert.equal(roomShowsGroups(solo, roomFacts(solo, 'host')), false);
  // an impossible player count must not throw out of a render
  assert.deepEqual(poolGroups({ mode: 'coop', capacity: 20, seats: [{ ...six, seat: 0 }], groups: 'x' }), []);
});

test('seatGroup / seatGroupOf / groupLetter / groupColor: the chip is the server s group, else the seat rank', () => {
  assert.equal(seatGroup(0, 6), 0);
  assert.equal(seatGroup(2, 6), 0, 'the 3/3 layout: the first three seats are A');
  assert.equal(seatGroup(3, 6), 1);
  assert.equal(seatGroup(5, 6), 1);
  assert.equal(seatGroup(0, 5), -1, 'one shared pool below six players');
  assert.equal(seatGroup(-1, 6), -1);
  assert.equal(seatGroup(0, 99), -1, 'the shared rule refuses an unknown count instead of throwing');
  // the wire contract wins over the local computation
  assert.equal(seatGroupOf({ group: 1 }, 0, 6), 1);
  assert.equal(seatGroupOf({ group: -1 }, 3, 6), 1, '-1 (the server s "no group") falls back to the rank');
  assert.equal(seatGroupOf(null, 0, 6), -1);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(groupLetter), ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.equal(groupLetter(-1), '');
  assert.equal(groupLetter(26), '');
  assert.equal(groupColor(0), GROUP_COLORS[0]);
  assert.equal(groupColor(-1), GROUP_COLORS[0]);
  assert.equal(groupColor(5), GROUP_COLORS[0], 'the colours cycle past the fifth group');
});

test('SeatCard paints the group badge, the tint and the 3px edge — and nothing when there is no group', () => {
  const source = room({ capacity: 8, groups: [3, 3], seats: [0, 1, 2, 3, 4, 5].map((i) => ({ ...host, seat: i, playerId: `p${i}` })) });
  const facts = roomFacts(source, 'p0');
  const props = { room: source, facts, myId: 'p0', busy: null, onAddBot() {}, onRemoveBot() {}, onKick() {}, onTransferHost() {}, onSwap() {} };
  const card = (seat, index, group) => SeatCard({ seat, index, group, ...props });
  // the badge is a <GroupChip> vnode here (these tests do not render), so the prop it is handed IS the group
  const badge = (v) => [...walk(v)].filter((n) => typeof n.type === 'function' && n.type.name === 'GroupChip');

  const first = card(source.seats[0], 0, 0);
  assert.equal(badge(first).length, 1, 'the A-组 badge');
  assert.equal(badge(first)[0].props.group, 0);
  assert.match(first.props.class, / is-grouped/, 'the 3px left edge class');
  assert.match(first.props.style, /--group-color:#4ed8af/, "the group's own colour rides the card");
  // the second group is a different colour, and the third seat still belongs to A
  assert.equal(badge(card(source.seats[3], 3, 1))[0].props.group, 1);
  assert.match(card(source.seats[3], 3, 1).props.style, /--group-color:#f6a329/);
  assert.equal(badge(card(source.seats[2], 2, 0))[0].props.group, 0);
  // an empty seat carries the group too (it belongs to one of the fixed groups)
  const empty = card(null, 6, 1);
  assert.match(empty.props.class, /seat--empty is-grouped/);
  assert.equal(badge(empty)[0].props.group, 1);
  // no group (five or fewer) ⇒ no badge, no tint, no edge class
  const plain = card(source.seats[0], 0, -1);
  assert.equal(badge(plain).length, 0);
  assert.equal(/ is-grouped/.test(plain.props.class), false);
  assert.equal(/--group-color/.test(plain.props.style), false);
});

// ---- ③c 候室队友皮肤 ------------------------------------------------------------------------------------------------

test('skinAvatarFor: the seat card draws the chosen skin, everything else falls back to the operator art', () => {
  // the manifest shape chessAvatarUrl reads: chars[operator].skins[skinId].avatar
  const M = { chars: { c1: { avatar: 'a/c1.png', skins: { s1: { avatar: 'a/c1_s1.png' } } } } };
  const CHESS = { chess_char_9_01_a: { charId: 'c1' } };
  const lookup = (group, id) => (group === 'chess' ? CHESS[id] || null : null);

  assert.equal(skinAvatarFor({ skins: { chess_char_9_01_a: 's1' } }, M, lookup), 'a/c1_s1.png', 'the chosen skin');
  assert.equal(skinAvatarFor({ skins: { chess_char_9_01_a: 'nope' } }, M, lookup), 'a/c1.png',
    'an unknown skin id falls back to the operator\'s own avatar (auto-fallback since ①)');
  assert.equal(skinAvatarFor({ skins: { chess_char_nodes: 's1' } }, M, lookup), null,
    'a key the data does not know is skipped — and nothing is drawn for it');
  // the representative is deterministic: the first RESOLVABLE key in sorted order (a waiting room has no chosen operator)
  assert.equal(skinAvatarFor({ skins: { zz: 's1', chess_char_9_01_a: 's1' } }, M, lookup), 'a/c1_s1.png');
  assert.equal(skinAvatarFor({ skins: { aa: 's1', chess_char_9_01_a: 's1' } }, M, lookup), 'a/c1_s1.png');
  // nothing to draw: no skins / no manifest / no seat ⇒ the seat card keeps its own glyph (never a blank avatar)
  for (const [seat, m] of [[{}, M], [{ skins: null }, M], [{ skins: {} }, M], [{ skins: { chess_char_9_01_a: 's1' } }, null], [null, M]]) {
    assert.equal(skinAvatarFor(seat, m, lookup), null);
  }
  // SeatCard hands it to AvatarFrame as `src` (bots never get one: they wear the default models)
  const source = room({ capacity: 4, seats: [{ ...host, skins: { chess_char_9_01_a: 's1' } }, guest, bot, null] });
  const facts = roomFacts(source, 'host');
  const props = { room: source, facts, myId: 'host', busy: null, onAddBot() {}, onRemoveBot() {}, onKick() {}, onTransferHost() {}, onSwap() {} };
  const frames = (v) => [...walk(v)].filter((n) => typeof n.type === 'function' && n.type.name === 'AvatarFrame');
  assert.equal(frames(SeatCard({ seat: source.seats[0], index: 0, ...props })).length, 1);
  assert.equal(frames(SeatCard({ seat: source.seats[2], index: 2, ...props }))[0].props.src, null,
    'a bot seat never asks for a skin avatar');
});
