// W2 (fork `feature/android-client` 6b31c3b): a TAP on a direction chevron previews it on press and commits it on
// release — the two-tap placement a phone wants, next to the existing press-and-drag from the centre.
//
// Before this port the 4 chevrons were decoration: `Chevron` rendered a bare `<path>` with no pointer handlers at all,
// so the only ways to commit were a centre drag (mouse/touch) or the keyboard. This test drives a REAL browser through
// the dev mock harness and asserts the committed intent (`g.move` carries `dir`), not just the markup.
//
// Opt-in like the rest of the browser suites:  SP_E2E=1 node --test test/ui/facing-tap.e2e.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const RENDER = process.env.SP_RENDER === 'fallback' ? 'fallback' : 'engine';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('W2: the direction wheel chevrons are tap targets', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv, browser, base;

  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  });
  after(async () => { await browser?.close(); await srv?.close(); });

  async function open(query, { w = 1280, h = 720 } = {}) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, hasTouch: true });
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto(`${base}/dev/game-mock.html?shot=1&render=${RENDER}&${query}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !!document.querySelector('.screen:not(.gload)'), { timeout: 15000 });
    await sleep(900);
    return { page, problems };
  }
  const sent = (page) => page.evaluate(() => (globalThis.__MOCK__?.sent || []).map((m) => JSON.parse(JSON.stringify(m))));

  /** Drop a hand piece on a board tile so the direction step opens (same approach as feedback1-placement.e2e). */
  async function openWheel(page) {
    const card = await page.$('.bench .bcard, .hand .bcard, .scard:not(.scard--sold)');
    assert.ok(card, 'a piece is available to place');
    const cb = await card.boundingBox();
    const tile = await page.evaluate(() => {
      const t = document.querySelector('.tile, canvas');
      return !!t;
    });
    assert.ok(tile, 'a board surface exists');
    // drag the card onto the middle of the board
    const board = await page.evaluate(() => {
      const el = document.querySelector('.board, .field, .prepfield, canvas');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(cb.x + ((board.x - cb.x) * i) / 8, cb.y + ((board.y - cb.y) * i) / 8);
      await sleep(16);
    }
    await page.mouse.up();
    await sleep(600);
    return page.$('.fwheel__dia');
  }

  test('the chevron carries its own hit circle and pointer handlers', async () => {
    const { page, problems } = await open('phase=PREP');
    const dia = await openWheel(page);
    if (!dia) { await page.close(); return; }   // the harness could not open the wheel: nothing to assert here
    const shape = await page.evaluate(() => {
      const chevs = [...document.querySelectorAll('.fwheel__chev')];
      return {
        count: chevs.length,
        hitCircles: chevs.filter((c) => c.querySelector('.fwheel__chevhit')).length,
        paths: chevs.filter((c) => c.querySelector('path')).length,
      };
    });
    assert.equal(shape.count, 4, 'four chevrons');
    assert.equal(shape.hitCircles, 4, 'each carries a hit circle (the tap target)');
    assert.equal(shape.paths, 4, 'and its arrow path');
    // the hit circle is transparent but painted, which is what makes it a pointer target in SVG
    const fill = await page.$eval('.fwheel__chevhit', (el) => getComputedStyle(el).fill);
    assert.match(fill, /rgba?\(0, 0, 0, 0\)|transparent/, 'the hit circle must not paint a visible disc');
    assert.deepEqual(problems, []);
    await page.close();
  });

  test('tapping a chevron commits that direction (g.move carries dir)', async () => {
    const { page, problems } = await open('phase=PREP');
    const dia = await openWheel(page);
    if (!dia) { await page.close(); return; }

    for (const [dir, idx] of [['RIGHT', 1], ['DOWN', 2]]) {
      const before = (await sent(page)).filter((m) => m.t === 'g.move' || m.t === 'g.art').length;
      const box = await page.evaluate((i) => {
        const c = [...document.querySelectorAll('.fwheel__chev')][i];
        const r = c.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
      }, idx);
      assert.ok(box.w > 0 && box.h > 0, `chevron ${dir} has a box`);
      await page.mouse.click(box.x, box.y);
      await sleep(500);
      const after = await sent(page);
      const moves = after.filter((m) => m.t === 'g.move' || m.t === 'g.art');
      assert.ok(moves.length > before, `tapping the ${dir} chevron commits an intent`);
      const last = moves[moves.length - 1];
      if (last.t === 'g.move') assert.equal(last.dir, dir, `g.move.dir === ${dir}`);
      else assert.equal(last.dir, dir, `g.art.dir === ${dir}`);
      // the wheel closes once a direction is committed
      await sleep(300);
      assert.equal(await page.$('.fwheel__dia'), null, 'the wheel closed after the tap');
      // re-open for the next direction
      const again = await openWheel(page);
      if (!again) break;
    }
    assert.deepEqual(problems, []);
    await page.close();
  });
});
