// 「使用原皮」 (user request 2026-10-13) — the 房间头像 row of the 干员调配 皮肤 section.
//
// The reference a pick produces is `{ chessId, skinId: null }` (shared/protocol.js isRoomAvatar): the operator's own
// installed art, resolved by ui/skins.js roomAvatarUrl. The entry is per OPERATOR and needs no installed skin, so the
// section must not disappear for an operator whose 皮肤 list is empty — that is what these tests pin down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomAvatarRow } from '../../public/js/ui/skinPicker.js';

function* walk(node) {
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; }
  if (!node || typeof node !== 'object') return;
  yield node;
  yield* walk(node.props?.children);
}

const find = (v, testid) => [...walk(v)].find((n) => n.type === 'button' && n.props?.['data-testid'] === testid);

// c2 has no skin at all; c1 has two, so the same row has to serve both kinds of operator.
const MANIFEST = { chars: {
  c1: { avatar: 'a/c1.png', skins: { s1: { avatar: 'a/c1_s1.png' }, s2: { avatar: 'a/c1_s2.png' } } },
  c2: { avatar: 'a/c2.png' },
} };
const CHESS = {
  chess_char_6_04_a: { chessId: 'chess_char_6_04_a', charId: 'c1' },
  chess_char_2_01_a: { chessId: 'chess_char_2_01_a', charId: 'c2' },
};
const lookup = (group, id) => (group === 'chess' ? CHESS[id] || null : null);
const pickSpy = () => { const calls = []; return { calls, onPick: (chessId, skinId) => calls.push([chessId, skinId]) }; };

test('an operator with NO skin still offers 「使用原皮」, and the pick is exactly { chessId, skinId: null }', () => {
  const spy = pickSpy();
  const cleared = [];
  const row = RoomAvatarRow({
    chessId: 'chess_char_2_01_a', avatar: null, hasSkins: false,
    manifest: MANIFEST, lookup, onPick: spy.onPick, onClear: () => cleared.push('cleared'),
  });

  assert.equal(row.props['data-testid'], 'room-avatar-row');
  assert.equal(row.props['data-has-skins'], '0', 'no installed skin: only the skin LIST is empty, the row is not');
  // 未设置 ⇒ the row says so, and the seat card keeps its own placeholder (never a blank avatar)
  assert.ok([...walk(row)].some((n) => typeof n.props?.children === 'string' && /默认头像/.test(n.props.children)));

  const useOriginal = find(row, 'room-avatar-default');
  assert.ok(useOriginal, 'the entry exists without any skin to choose from');
  assert.equal(useOriginal.props['data-use-original-art'], '1');
  assert.equal(useOriginal.props.title, '使用原皮');
  assert.equal(useOriginal.props['aria-pressed'], 'false', 'nothing picked yet');

  useOriginal.props.onClick();
  assert.deepEqual(spy.calls, [['chess_char_2_01_a', null]],
    '原皮 is a reference to the operator with skinId null — not a clear, and not a skin');
  assert.deepEqual(cleared, [], '「使用原皮」 never clears the room avatar');
});

test('the picked 原皮 is what the row previews: the operator DEFAULT art, not a placeholder or a random skin', () => {
  const row = RoomAvatarRow({
    chessId: 'chess_char_2_01_a', avatar: { chessId: 'chess_char_2_01_a', skinId: null }, hasSkins: false,
    manifest: MANIFEST, lookup, onPick: () => {},
  });
  const img = [...walk(row)].find((n) => n.type === 'img');
  assert.equal(img?.props.src, 'a/c2.png', 'the operator default art — for an operator with no skins at all');
  assert.equal(find(row, 'room-avatar-default').props['aria-pressed'], 'true', 'the current room avatar IS the 原皮');
  // a skin of the same operator is a different art, so the preview must follow the reference and not "some skin"
  const skinned = RoomAvatarRow({
    chessId: 'chess_char_6_04_a', avatar: { chessId: 'chess_char_6_04_a', skinId: 's1' }, hasSkins: true,
    manifest: MANIFEST, lookup, onPick: () => {},
  });
  assert.equal([...walk(skinned)].find((n) => n.type === 'img')?.props.src, 'a/c1_s1.png');
  assert.equal(find(skinned, 'room-avatar-default').props['aria-pressed'], 'false', 'a skin is not 原皮');
});

test('every operator gets the entry: it is marked only for its OWN 原皮, and 取消房间头像 stays available', () => {
  const spy = pickSpy();
  const cleared = [];
  const row = RoomAvatarRow({
    chessId: 'chess_char_6_04_a', avatar: { chessId: 'chess_char_6_04_a', skinId: null }, hasSkins: true,
    manifest: MANIFEST, lookup, onPick: spy.onPick, onClear: () => cleared.push('cleared'),
  });
  assert.equal(row.props['data-has-skins'], '1');
  const useOriginal = find(row, 'room-avatar-default');
  assert.equal(useOriginal.props['aria-pressed'], 'true');
  assert.match(useOriginal.props.class, /\bis-on\b/);
  useOriginal.props.onClick();
  assert.deepEqual(spy.calls, [['chess_char_6_04_a', null]]);
  // another operator's 原皮 never marks this operator's entry (the reference carries the operator)
  const other = RoomAvatarRow({
    chessId: 'chess_char_6_04_a', avatar: { chessId: 'chess_char_2_01_a', skinId: null }, hasSkins: true,
    manifest: MANIFEST, lookup, onPick: () => {},
  });
  assert.equal(find(other, 'room-avatar-default').props['aria-pressed'], 'false');
  // clearing is still its own action, on the same row
  [...walk(row)].find((n) => n.props?.['data-clear-room-avatar'] === '1').props.onClick();
  assert.deepEqual(cleared, ['cleared']);
});
