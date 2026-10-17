// test/prep-scale.test.js — 房间「准备时间倍率」 (room.setPrepScale, user request 2026-10-17).
//
// Four contracts:
//   ① a room's factor scales the ONLINE prep length: round(prepTime × factor) whole seconds, the one value the
//      phase deadline is armed with and the rule auditor expects (so the two can never disagree);
//   ② a solo / single-human match stays untimed at any factor — the setting must never give 独立模拟's
//      wait-for-ready prep a countdown;
//   ③ only the host may change it (NOT_HOST), and a running match refuses it (ROOM_STARTED);
//   ④ an old client that never sends the field reads the default ×1, on the wire and in the client's countdown
//      gauge (phaseTotalSeconds, test/ui/gameLogic.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { validateC2S } from '../shared/protocol.js';
import { PREP_SCALES, DEFAULT_PREP_SCALE, PHASE } from '../shared/constants.js';
import { writeServerSettings } from '../server/serverSettings.js';
import { attachAudit } from '../server/match/audit.js';
import { makeMatch } from './match/harness.js';

async function scaleServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-prepscale-'));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('sp-prepscale-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  writeServerSettings(dir, { maxAiPerRoom: null, requireAssetCache: false });
  return startServer({ port: 0, host: '127.0.0.1', quiet: true, MatchClass: StubMatch, serverSettingsDir: dir });
}

function players(srv, clients) {
  return async (name) => {
    const c = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
    clients.push(c);
    c.id = (await c.hello(name)).playerId;
    return c;
  };
}

test('room.setPrepScale: only the four offered factors pass the protocol boundary', () => {
  assert.deepEqual([...PREP_SCALES], [1, 1.25, 1.5, 2]);
  assert.equal(DEFAULT_PREP_SCALE, 1);
  for (const prepScale of PREP_SCALES) assert.equal(validateC2S({ t: 'room.setPrepScale', prepScale }), null, `×${prepScale} is offered`);
  for (const bad of [0, 1.1, 3, -1, '1.5', null, undefined, NaN, true, {}]) {
    assert.notEqual(validateC2S({ t: 'room.setPrepScale', prepScale: bad }), null, `refused: ${String(bad)}`);
  }
  assert.notEqual(validateC2S({ t: 'room.setPrepScale' }), null, 'the field is required on the wire, never silently defaulted');
});

test('④ a room opens at ×1, only its host may change it, and every member is told', async (t) => {
  const clients = [];
  const srv = await scaleServer(t);
  try {
    const player = players(srv, clients);
    const host = await player('Host');
    assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
    const opened = await host.waitFor('room.state');
    assert.equal(opened.prepScale, DEFAULT_PREP_SCALE, 'a room nobody touched is ×1');
    const guest = await player('Guest');
    assert.equal((await guest.request({ t: 'room.join', code: opened.code })).t, 'ok');
    assert.equal((await guest.waitFor('room.state')).prepScale, DEFAULT_PREP_SCALE, 'a member that never touched it sees ×1');
    // ③ non-host refused; the room is unchanged
    assert.equal((await guest.request({ t: 'room.setPrepScale', prepScale: 2 })).code, 'NOT_HOST');
    assert.equal((await host.request({ t: 'room.setPrepScale', prepScale: 1.5 })).t, 'ok');
    assert.equal((await host.waitFor('room.state', (s) => s.prepScale === 1.5)).prepScale, 1.5);
    assert.equal((await guest.waitFor('room.state', (s) => s.prepScale === 1.5)).prepScale, 1.5, 'the whole room is told');
    for (const prepScale of PREP_SCALES) {
      assert.equal((await host.request({ t: 'room.setPrepScale', prepScale })).t, 'ok', `×${prepScale} is accepted`);
    }
    assert.equal((await host.waitFor('room.state', (s) => s.prepScale === 2)).prepScale, 2);
    assert.equal((await host.request({ t: 'room.setPrepScale', prepScale: 3 })).code, 'BAD_MSG', 'not a PREP_SCALES factor');
  } finally {
    await Promise.all(clients.map((c) => c.terminate()));
    await srv.close();
  }
});

test('③ a running match refuses a factor change (it keeps the factor it started with)', async (t) => {
  const clients = [];
  const srv = await scaleServer(t);
  try {
    const player = players(srv, clients);
    const host = await player('Host');
    assert.equal((await host.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' })).t, 'ok');
    const opened = await host.waitFor('room.state');
    const guest = await player('Guest');
    assert.equal((await guest.request({ t: 'room.join', code: opened.code })).t, 'ok');
    assert.equal((await host.request({ t: 'room.setPrepScale', prepScale: 1.5 })).t, 'ok');
    assert.equal((await guest.request({ t: 'room.ready', ready: true })).t, 'ok');
    assert.equal((await host.request({ t: 'room.start' })).t, 'ok');
    await host.waitFor('m.public');
    assert.equal((await host.request({ t: 'room.setPrepScale', prepScale: 2 })).code, 'ROOM_STARTED');
  } finally {
    await Promise.all(clients.map((c) => c.terminate()));
    await srv.close();
  }
});

test('① a ×1.5 room preps for round(prepTime × 1.5) seconds — deadline and auditor read that one value', () => {
  for (const factor of PREP_SCALES) {
    const h = makeMatch({ mode: 'coop', humans: 2, bots: 0, seed: 11 });
    assert.equal(h.m.soloUntimed, false, 'two humans: the co-op timers run');
    // what Lobby.startMatch hands the match (startMatch opts.prepScale = room.state.prepScale)
    h.m.opts.prepScale = factor;
    const audit = attachAudit(h.m);
    const base = h.m.gd.prepTime(1);
    assert.ok(Number.isFinite(base) && base > 0, 'the test mode has a round-1 prepTime');
    const want = Math.round(base * factor);
    h.start();
    h.toPrep(1);
    assert.equal(h.m.phase, PHASE.PREP);
    assert.equal(h.m.prepSeconds(1), want, `×${factor}: the prep length is round(prepTime × ${factor})`);
    assert.equal(h.m.deadline - h.m.sched.gameNow(), want * 1000, `×${factor}: the deadline is armed with it`);
    assert.deepEqual(audit.violations, [], audit.violations.join('\n'));
    h.m.dispose();
  }
});

test('② solo / single-human preps stay untimed at any factor', () => {
  for (const cfg of [{ mode: 'coop', humans: 1 }, { mode: 'solo', humans: 1 }]) {
    const h = makeMatch({ ...cfg, bots: 0, fake: true, seed: 4 });
    h.m.opts.prepScale = 2;
    assert.equal(h.m.soloUntimed, true, `${cfg.mode} with one human is untimed`);
    h.start();
    h.toPrep(1);
    assert.equal(h.m.prepSeconds(1), null, 'the factor never gives an untimed prep a length');
    assert.equal(h.m.deadline, 0, 'no deadline is armed');
    assert.equal(h.m._phaseTimer, null, 'no prep timer is armed');
    h.m.dispose();
  }
});
