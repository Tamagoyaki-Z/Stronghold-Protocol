// 干员皮肤 (docs/SKINS.md) — the BATTLE half of the link.
//
// The off-match half (room.skins → freezeSkins → seat → PlayerState → publicView → 候室 / 卡面) is covered by
// test/match/skins.test.js. This suite covers the half a player only sees once the match has started:
//
//   PlayerState.skins → battleInput().units[].skin        (server/match/player/round.js)
//     → the sim ally unit                                 (server/sim/battle/players.js, _makeAlly)
//     → UnitInfo.skin                                     (server/sim/snapshot.js unitInfo) — the m.field / 'spawn' frame
//     → renderInfo(UnitInfo).skin                         (public/js/render/app/info.js) → UnitView's picture / Spine
//   and, for the prep board and its scouting copies,       (server/match/player/views.js pieceView) → m.private.board[].skin
//
// Regression guarded here — player report 2026-10-13 「进入战斗之后皮肤没了」: the skin layer reached the v0.2.4/v0.2.5
// line through 742ed431 port(skin) / 0b2ac26a wire(skin), but 742ed431 took a file from the v0.2.3 (migrate) tree only
// when it was byte-identical to the v0.2.4 baseline. server/sim/battle/players.js, server/sim/snapshot.js and
// server/match/player/views.js are NOT (upstream had touched them), so all three were left without the skin hook and
// every unit in the battle silently fell back to its default model. The off-match carriers were restored, so the room and
// the shop cards kept showing skins — exactly the reported asymmetry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DATA, makeMatch, give } from './harness.js';
import { buildBattleSpec, createBattleFromSpec } from '../../server/sim/spec.js';
import { unitInfo } from '../../server/sim/snapshot.js';
import { renderInfo } from '../../public/js/render/app/info.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'data', 'assets.json'), 'utf8'));

/** The seats a match starts from — the shape server/lobby.js hands over (`skins` = { [baseChessId]: skinId }). */
const seatsWith = (skins) => [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true, skins }];

/**
 * The first operator the REAL data both gives an installed skin and this match's pool can field. The pool is per match,
 * so this needs a live match — the caller passes a throwaway one.
 * @returns {{ chessId: string, skinId: string, charId: string } | null}
 */
function findSkinnable(m) {
  for (const [id, rec] of Object.entries(DATA.chess)) {
    if (!rec || rec.isGolden || rec.isDiy || rec.isHidden || rec.visible === false) continue;
    if (rec.baseId && rec.baseId !== id) continue;              // the elite record: a skin key must be the base id
    if (rec.tokens && rec.tokens.length) continue;              // a token summon, not an operator piece
    if (!m.pool.has(id)) continue;
    const skinId = Object.keys(manifest.chars?.[rec.charId]?.skins || {})[0];
    if (skinId) return { chessId: id, skinId, charId: rec.charId };
  }
  return null;
}

/** A disposable bare match, only to read its per-match pool. */
function pickOperand() {
  const probe = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed: 11 }).start();
  const pick = findSkinnable(probe.m);
  probe.m.dispose();
  return pick;
}

/** A solo prep match with a clean board, exactly like test/match/facing.test.js: known stage, no stray copies. */
function prepMatch(skins) {
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed: 11, seats: seatsWith(skins) }).start();
  h.toPrep(1);
  h.setStage('act2autochess_m01');
  const ps = h.ps('p_0');
  for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean)]) if (p.kind === 'chess') ps.returnCopies(p);
  ps.board.clear();
  ps.hand.fill(null);
  ps.recompute();
  return { h, m: h.m, ps };
}

/** The chosen operator on the board, and the BattleSpec / battle the round would run. */
function deployAndBuild(h, ps, chessId) {
  const piece = give(h.m, ps, chessId, 'hand');
  assert.ok(piece, 'the operand was given to the hand');
  assert.deepEqual(ps.move(piece.uid, { area: 'board', row: 9, col: 3 }), { ok: true });
  const input = ps.battleInput();
  const spec = buildBattleSpec({ kind: 'normal', seed: 3, stageId: h.m.stageId, players: [input], spawns: [], routes: [], timeLimit: 30 });
  const battle = createBattleFromSpec(spec, DATA);
  return { piece, input, spec, battle };
}

test('the real data pairs a pool operator with an installed skin (guards this suite against a silent data change)', () => {
  const pick = pickOperand();
  assert.ok(pick, 'some pool operator has a skin in data/assets.json');
  assert.ok(!pick.chessId.includes('diy'), 'the operand is a real operator, not a 自选 slot');
});

test('battle: the chosen skin travels PlayerState → battleInput → the sim ally → UnitInfo → renderInfo', () => {
  const pick = pickOperand();
  const { h, m, ps } = prepMatch({ [pick.chessId]: pick.skinId });
  assert.deepEqual(ps.skins, { [pick.chessId]: pick.skinId }, 'the seat record reached PlayerState');

  const { piece, input, battle } = deployAndBuild(h, ps, pick.chessId);

  // ① PlayerState → the battle input (server/match/player/round.js) — this half always survived
  assert.equal(input.units.find((u) => u.uid === piece.uid).skin, pick.skinId,
    'battleInput.units[].skin carries the choice into the sim');

  // ② the battle input → the ally unit the sim actually deploys (server/sim/battle/players.js _makeAlly)
  const unit = battle.allyUnits.find((u) => u.uid === piece.uid);
  assert.ok(unit, 'the sim deployed the operand');
  assert.equal(unit.skin, pick.skinId, 'the sim ally wears the chosen skin (init.skin reaches _makeAlly)');

  // ③ the ally unit → the frame the client gets (server/sim/snapshot.js unitInfo: m.field / the 'spawn' event)
  const frame = unitInfo(unit);
  assert.equal(frame.skin, pick.skinId, 'UnitInfo publishes the skin — without it the client has nothing to draw');

  // ④ the frame → the renderer's info (public/js/render/app/info.js, read by render/units.js for the picture and Spine)
  assert.equal(renderInfo(frame).skin, pick.skinId,
    'renderInfo keeps it, so UnitView draws the skin instead of the operator default');

  m.dispose();
});

test('prep: m.private.board[].skin carries the choice too (server/match/player/views.js pieceView)', () => {
  const pick = pickOperand();
  const { h, m, ps } = prepMatch({ [pick.chessId]: pick.skinId });
  const { piece } = deployAndBuild(h, ps, pick.chessId);

  const pv = ps.privateView().board.find((p) => p.uid === piece.uid);
  assert.ok(pv, 'the piece is on the board of m.private');
  assert.equal(pv.skin, pick.skinId, 'pieceView publishes the skin for the prep board and every scouting copy of it');

  // a token is never an operator and never wears a skin
  const tok = [...ps.board.values()].find((p) => p.kind !== 'chess');
  if (tok) assert.equal(ps.pieceView(tok).skin, null, 'a non-chess piece has no skin at all');

  m.dispose();
});

test('omission: with no skin chosen the field is DROPPED, never null (the wire contract relies on it)', () => {
  const pick = pickOperand();
  const { h, m, ps } = prepMatch(null);
  const { piece, input, battle } = deployAndBuild(h, ps, pick.chessId);

  assert.deepEqual(ps.skins, {}, 'no choice, no skins');
  assert.equal('skin' in input.units.find((u) => u.uid === piece.uid), false, 'battleInput omits it');
  const unit = battle.allyUnits.find((u) => u.uid === piece.uid);
  assert.equal(unit.skin, null, 'the Unit carries null internally (units.js init.skin ?? null)');
  assert.equal(unitInfo(unit).skin, undefined, 'UnitInfo omits the key: JSON.stringify drops it, no bytes on the hot path');
  assert.equal(renderInfo(unitInfo(unit)).skin, null, 'the renderer reads an absent skin as the default model');
  assert.equal('skin' in ps.privateView().board.find((p) => p.uid === piece.uid), false, 'pieceView omits it as well');

  m.dispose();
});

test('the guard is by BASE id: an elite (精锐) card wears the skin chosen for its base card', () => {
  const pick = pickOperand();
  const elite = Object.values(DATA.chess).find((c) => c && c.isGolden && c.baseId === pick.chessId);
  if (!elite) return; // this operator has no 精锐 record in this data set — nothing to prove here
  const { m, ps } = prepMatch({ [pick.chessId]: pick.skinId });
  const piece = give(m, ps, elite.chessId, 'hand');
  assert.ok(piece, 'the 精锐 card was given to the hand');
  assert.equal(ps.pieceView(piece).skin, pick.skinId,
    'the golden record reads the choice stored under its base id (the historical elite-key bug)');
  m.dispose();
});
