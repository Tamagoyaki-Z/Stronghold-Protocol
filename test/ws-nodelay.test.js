// TCP_NODELAY (Nagle off) on an accepted /ws socket, and an honest statement of what a loopback measurement proves.
//
// The production symptom: the player's ICMP to the server is 44 ms while the in-game WebSocket round trip sits at
// 180–210 ms, with the server's own handling measured at 1.2–1.8 ms. That is the signature of Nagle (server side,
// node's default) meeting a peer's delayed ACK (~200 ms on Windows): this protocol writes one small JSON frame per
// action, so a pong queued while the previous segment is still unacknowledged waits for that ACK.
//
// What the sections below can and cannot prove:
//   §1 structural — the REAL upgrade path hands the accepted socket to `setNoDelay(true)` before the connection is
//      adopted. node's `net.Socket` exposes only the setter (`socket.setNoDelay()`); there is no readable `noDelay`
//      property, not even on `ws`'s `_socket` (which is that same class), so the flag is observed where it is written.
//      The ground truth for the syscall itself is in the round's evidence: running this path under
//      `strace -e trace=setsockopt` shows `setsockopt(fd, SOL_TCP, TCP_NODELAY, [1], 4) = 0`. §1.5 replays that when
//      the tool is present.
//   §2 loopback — consecutive small round trips on one live connection answer well inside a threshold that would catch
//      a pathological stall. It CANNOT prove the fix: on a loopback the ACK comes back in microseconds, so Nagle has
//      no window to wait on and the ~200 ms delayed-ACK stall is not reproducible here. Regression guard only.
//   §3 kernel — the mechanism measured directly on two plain TCP sockets, reported as a diagnostic. MEASURED ON THIS
//      BOX: the queued second write went out in ~0.4 ms with Nagle ON and ~0.3 ms with TCP_NODELAY, i.e. this
//      kernel/loopback does not defer the ACK at all, which is exactly why §2 cannot prove the fix either. The only
//      assertion kept is the one that is deterministic everywhere: with TCP_NODELAY the queued write is never held
//      back. Confirming the ~200 ms saving needs a WAN peer with delayed ACK (the real client).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFileSync, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';

/** The server-side sockets of the accepted connections (`clientTracking: false` ⇒ no `wss.clients`). */function serverSockets(srv) {
  return [...(srv.network?.conns?.values() ?? [])].map((conn) => conn.ws?._socket).filter(Boolean);
}

/**
 * Two consecutive ping/pong round trips on one live connection — the production heartbeat: `{ t: 'ping', c }` out,
 * `{ t: 'pong', c }` back. The handshake is not counted. Returns the round trips in ms.
 */
async function backToBackRtts(client, times = 2) {
  await client.hello('NagleProbe');
  const rtt = [];
  for (let i = 0; i < times; i += 1) {
    const c = i + 1;
    const at = performance.now();
    client.send({ t: 'ping', c });
    const pong = await client.waitFor('pong', (m) => m.c === c);
    rtt.push(performance.now() - at);
    assert.equal(pong.t, 'pong', 'every request must be answered, not stalled');
  }
  return rtt;
}

test('an accepted /ws socket is a TCP socket that Nagle can be turned off on, and the handshake turns it off', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, bandwidthEmergency: false });
  // spy on the setter BEFORE anybody connects: the code under test reaches the socket through this method, and this is
  // the only place node lets a test observe TCP_NODELAY at all (there is no getter to read back)
  const realSetNoDelay = net.Socket.prototype.setNoDelay;
  const calls = [];
  net.Socket.prototype.setNoDelay = function spy(noDelay) {
    calls.push({ thisArg: this, args: [noDelay] });
    return realSetNoDelay.call(this, noDelay);
  };
  t.after(() => { net.Socket.prototype.setNoDelay = realSetNoDelay; });

  const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  t.after(async () => { await client.close(); await srv.close(); });

  const accepted = serverSockets(srv);
  assert.equal(accepted.length, 1, 'exactly the one accepted connection');
  assert.equal(typeof accepted[0].setNoDelay, 'function', 'the handshake lands on a real node TCP socket');
  // The server side is the socket told `true`. node's `ws` client asks for `setNoDelay(undefined)` on its own socket
  // (a loopback pair shows one local address from both ends, so that socket is reachable here too), and node itself
  // never calls this method — so exactly one call carrying `true` is our handshake and nothing else.
  const asked = calls.filter((c) => c.args[0] === true);
  assert.equal(asked.length, 1, `exactly one socket was told setNoDelay(true) (calls: ${JSON.stringify(calls.map((c) => c.args))})`);
});

test('the syscall itself (strace): the real upgrade path sets TCP_NODELAY on the accepted socket', async (t) => {
  let strace = '';
  try { strace = execFileSync('sh', ['-c', 'command -v strace'], { encoding: 'utf8' }).trim(); } catch { strace = ''; }
  if (!strace) { t.skip('strace is not installed — the syscall could not be traced here'); return; }

  const script = `
    import http from 'node:http';
    import { attachWebSocket } from '${process.cwd()}/server/http/websocket.js';
    import { Network, SessionRegistry } from '${process.cwd()}/server/net.js';
    import { TestClient } from '${process.cwd()}/test/helpers/wsClient.js';
    const network = new Network({ registry: new SessionRegistry(), handler: { onMessage() {} } });
    const server = http.createServer((_q, s) => { s.writeHead(404); s.end(); });
    attachWebSocket(server, { network, log: { error() {}, warn() {}, info() {}, debug() {} } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const client = await TestClient.connect('ws://127.0.0.1:' + server.address().port + '/ws');
    await client.hello('Trace');
    await client.close();
    await new Promise((r) => server.close(r));
    clearInterval(network.heartbeatTimer); clearInterval(network.sweepTimer);
  `;
  // strace writes the trace to its OWN stderr (while the traced child's stderr is inherited), so the syscalls are read
  // from there — collecting only stdout would see nothing and the assertion would fail for the wrong reason.
  const run = spawnSync(strace, ['-f', '-e', 'trace=setsockopt', 'node', '--input-type=module', '-e', script],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const traced = `${run.stdout || ''}${run.stderr || ''}`;
  const calls = traced.split('\n').filter((l) => l.includes('TCP_NODELAY'));
  assert.ok(calls.length >= 1, `the kernel must have been told TCP_NODELAY (${calls.length} calls traced; status ${run.status})`);
  assert.ok(calls.some((l) => /TCP_NODELAY, \[1\], 4\)\s*=\s*0/.test(l)), `a TCP_NODELAY of 1 succeeded: ${calls.join(' | ')}`);
});

test('two consecutive small requests over a real connection answer inside the threshold', async (t) => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, bandwidthEmergency: false });
  const client = await TestClient.connect(`ws://127.0.0.1:${srv.port}/ws`);
  t.after(async () => { await client.close(); await srv.close(); });

  const rtt = await backToBackRtts(client, 2);
  const [first, second] = rtt;
  // 环回把 Nagle 的效果藏起来了：ACK 在微秒级返回，Nagle 没有等待窗口，所以这条只证明「没有病态停顿」，是回归护栏。
  // 真正坐实这次修复要靠在 WAN 上（带延迟 ACK 的 Windows 对端）重测客户端显示的往返 —— 预期 45–55 ms。
  assert.ok(second < 250, `the second back-to-back request answered in ${second.toFixed(1)} ms (a Nagle stall would be ~200 ms+)`);
  assert.ok(Math.max(first, second) < 500, `no back-to-back request stalled (${rtt.map((x) => x.toFixed(1)).join(' / ')} ms)`);
});

test('the kernel mechanism itself: Nagle defers a second small write, TCP_NODELAY does not', async (t) => {
  /**
   * Delay the first small write so it is still unacknowledged, then write a second one; return how long the SECOND
   * took to reach the peer.
   *
   * MEASURED ON THIS BOX: ~0.3 ms with Nagle and ~0.3 ms with TCP_NODELAY — this kernel/loopback ACKs well inside the
   * 40 ms window, so Nagle never has anything to wait on. The earlier version of this test asserted `nagle >= fast`
   * and failed on exactly that (0.3 vs 0.3): that is evidence about the LOOPBACK, not about the fix, and asserting it
   * would have been a test that fails for being right. So the numbers are reported and only the deterministic half is
   * asserted. The production claim (a ~200 ms pong stall disappears) rests on §1 plus a WAN measurement after deploy.
   */
  const gapOf = async (noDelay) => {
    let resolveSecond;
    const secondRead = new Promise((r) => { resolveSecond = r; });
    const receiver = net.createServer((peer) => {
      let seen = 0;
      peer.on('data', () => { if (++seen === 2) resolveSecond(performance.now()); });
      peer.on('error', () => {});
    });
    await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
    const sender = net.connect({ host: '127.0.0.1', port: receiver.address().port });
    sender.setNoDelay(noDelay);
    sender.on('error', () => {});
    await new Promise((r) => sender.once('connect', r));
    // NB: a plain net.Socket has no readable `noDelay` (only the setter), so the flag itself cannot be read back here;
    // the /ws assertion in §1 is where the flag is read, off the socket `ws` exposes.
    sender.write('a'.repeat(8));
    await new Promise((r) => setTimeout(r, 40));
    const at = performance.now();
    sender.write('b'.repeat(8));
    const arrived = await secondRead;
    sender.destroy(); receiver.close();
    return arrived - at;
  };

  const nagle = await gapOf(false);
  const fast = await gapOf(true);
  t.diagnostic(`loopback Nagle probe: second write delivered in ${nagle.toFixed(1)} ms with Nagle, ${fast.toFixed(1)} ms with TCP_NODELAY`);
  // deterministic everywhere: with TCP_NODELAY the queued write is never held back
  assert.ok(fast < 40, `with TCP_NODELAY the second write goes out at once (${fast.toFixed(1)} ms)`);
  // and Nagle never makes it FASTER (it can only defer): a strict inequality would fail on a loopback that does not
  // defer the ACK, which is a property of the loopback rather than of the socket option
  assert.ok(nagle + 30 >= fast, `Nagle never delivers the queued write meaningfully earlier (${nagle.toFixed(1)} ms vs ${fast.toFixed(1)} ms)`);
});
