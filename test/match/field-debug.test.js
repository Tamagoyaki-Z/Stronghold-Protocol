// The battle-type debug output (user report of 2026-10-19: 「界面上没有「联防」字样，但盟约层数不涨」 — the B plan): one
// [field-debug] line per field built or handed to the clients (server/match/match/combat.js _logFieldDebug), and the field
// kind in the public snapshot the HUD draws its battle-type mark from (server/match/match/views.js fieldKindView).
// A 联防 field is the only kind whose layer gains are off (Battle.flags.layerGainsEnabled): its line says
// layerGains="false" — the rule itself is test/match/non-unite-layer-gains.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE } from '../../shared/constants.js';
import { makeMatch } from './harness.js';

const LINE = /^(WARN )?\[field-debug\] round=(\d+) field=(\S+) kind=(\w+) layerGains="(true|false)" players=\[([^\]]*)\] bonds=(\S+)$/;
const fieldDebug = (h) => ({
  info: h.logs.info.filter((l) => l.includes('[field-debug]')),
  warn: h.logs.warn.filter((l) => l.includes('[field-debug]')),
});

test('每个战场一行 [field-debug]: a normal field is an info line (kind=normal, layerGains="true"), the 联防 is a WARN', () => {
  const h = makeMatch({ mode: 'coop', humans: 4, seed: 34, fake: true, script: (b) => (b.kind === 'normal' ? { leaks: { p_0: 6 } } : {}) }).start();
  const m = h.m;
  h.toPrep(1);
  h.drive(() => m.phase === PHASE.COMBAT || m.phase === PHASE.UNITE);
  const combat = m.publicView();
  assert.equal(combat.fields.length, 4, 'one normal field per alive player');
  assert.deepEqual(combat.fields.map((f) => f.kind), ['normal', 'normal', 'normal', 'normal']);
  // the snapshot carries every player's own field kind (the HUD's mark): 'normal' shows none
  assert.deepEqual(combat.players.map((p) => p.fieldKind), ['normal', 'normal', 'normal', 'normal']);
  const info = fieldDebug(h).info;
  assert.equal(info.length, 4, `one line per normal field: ${info.join(' | ')}`);
  for (const line of info) {
    const mm = LINE.exec(line);
    assert.ok(mm, `line shape: ${line}`);
    assert.equal(mm[1], undefined, 'a normal field without bond layers is a routine info line');
    assert.equal(mm[2], String(m.round));
    assert.equal(mm[4], 'normal');
    assert.equal(mm[5], 'true', 'a normal field gains layers');
    assert.equal(mm[7], '-', 'no bond layers on an empty board');
  }
  // 联防: the helpers' field — the one field whose layer gains are off
  h.drive(() => m.phase === PHASE.UNITE);
  const united = m.publicView();
  assert.equal(united.fields[0].kind, 'unite');
  const helpers = m.unitePlan.helpers.map((p) => p.playerId);
  assert.deepEqual(helpers.map((id) => united.players.find((p) => p.playerId === id).fieldKind), ['unite', 'unite'],
    'the helpers read 联防 in the public snapshot (the HUD mark)');
  const warn = fieldDebug(h).warn;
  assert.equal(warn.length, 1, `one 联防 line: ${warn.join(' | ')}`);
  const mm = LINE.exec(warn[0]);
  assert.ok(mm, `line shape: ${warn[0]}`);
  assert.equal(mm[1], 'WARN ', 'a field worth reading is a WARN line');
  assert.equal(mm[3], 'u', 'the 联防 field id');
  assert.equal(mm[4], 'unite');
  assert.equal(mm[5], 'false', '联防: no layer gains');
  assert.deepEqual(mm[6].split(','), helpers);
  m.dispose();
});

test('bonds=<bond:layers,...>: a normal field whose players carry bond layers is loud too, and only one line is written', () => {
  const h = makeMatch({ humans: 1, seed: 5 });
  const m = h.m;
  const before = h.logs.warn.length;
  m._logFieldDebug({ round: 3, fieldId: 'n:p_0', kind: 'normal',
    players: [{ playerId: 'p_0', bonds: { egirShip: { layers: 14 }, steadShip: { layers: 0 } } }] });
  assert.equal(h.logs.warn.length, before + 1, 'one line, not a state dump');
  const mm = LINE.exec(h.logs.warn[before]);
  assert.ok(mm, `line shape: ${h.logs.warn[before]}`);
  assert.equal(mm[1], 'WARN ', 'bond layers make the line loud');
  assert.equal(mm[2], '3');
  assert.equal(mm[3], 'n:p_0');
  assert.equal(mm[4], 'normal');
  assert.equal(mm[5], 'true', 'no flags stated → the kind default (normal gains layers)');
  assert.equal(mm[6], 'p_0');
  assert.equal(mm[7], 'egirShip:14', 'only bonds with layers (steadShip:0 is no bond)');
  m.dispose();
});
