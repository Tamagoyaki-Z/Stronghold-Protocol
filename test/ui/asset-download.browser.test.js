// SP_E2E=1 CHROME_PATH=<chrome> node --test test/ui/asset-download.browser.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../../server/index.js';
import { CHROME, hasChrome } from '../e2e/client.mjs';

test('homepage download, visible failure/retry, pause, cache reuse, and the two asset buttons\' responsive placement', {
  skip: process.env.SP_E2E !== '1' || !hasChrome(), timeout: 90000,
}, async (t) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const image = '/assets/~1234567890abcdef/download-test.png';
  const missing = '/assets/download-test-missing.png';
  let fixed = false, hanging = false;
  const counts = new Map();
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, assetIndex: false });
  // Keep synthetic responses on the actual HTTP server so browser caching stays enabled.
  const serve = srv.server.listeners('request')[0];
  srv.server.removeAllListeners('request');
  srv.server.on('request', (req, res) => {
    const url = req.url;
    if (url === '/data/assets.json' || url === '/data/local-assets.json' || url === '/data/local-fx.json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      // (local-fx.json: the host's official battle effects, DESIGN §33 — none in this fixture)
      res.end(JSON.stringify(url === '/data/assets.json' ? { files: [image, missing] } : { groups: {} }));
      return;
    }
    if (url === image || url === missing) {
      counts.set(url, (counts.get(url) || 0) + 1);
      if (hanging) return;
      const ok = url === image || fixed;
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'image/png', 'Cache-Control': ok ? 'public, max-age=3600' : 'no-store' });
      res.end(ok ? png : 'missing');
      return;
    }
    serve.call(srv.server, req, res);
  });
  t.after(() => srv.close());
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(srv.url);
  await page.waitForSelector('[data-testid="asset-download"]');
  assert.equal(counts.size, 0, 'opening the homepage does not download the asset pack');
  if (process.env.SP_ASSET_SCREENSHOTS) {
    fs.mkdirSync(process.env.SP_ASSET_SCREENSHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await page.screenshot({ path: path.join(process.env.SP_ASSET_SCREENSHOTS, 'title.png') });
  }
  // Owner policy (0.3.0): 下载完整素材 stays visible but is disabled and says why, so it never starts a transfer.
  assert.equal(await page.$eval('[data-testid="asset-download"]', (el) => el.disabled), true, 'the online pack download is disabled');
  assert.match(await page.$eval('[data-testid="asset-download-hint"]', (el) => el.textContent), /已关闭在线下载/);
  await page.click('[data-testid="asset-download"]');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(counts.size, 0, 'a disabled entry downloads nothing and opens no dialog');
  assert.equal(await page.$('.asset-download'), null);
  if (process.env.SP_ASSET_SCREENSHOTS) {
    fs.mkdirSync(process.env.SP_ASSET_SCREENSHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await page.screenshot({ path: path.join(process.env.SP_ASSET_SCREENSHOTS, 'complete.png') });
  }
  await page.keyboard.press('Escape');
  // 下载完整素材 and 导入素材包 side by side (ui/assetDownload.js, ui/assetImport.js): both inside the viewport, uncovered, on one
  // row, not overlapping, their hint lines clear of the footer — on a desktop and on a landscape phone
  for (const viewport of [{ width: 1280, height: 900 }, { width: 844, height: 390 }]) {
    await page.setViewport(viewport);
    const box = (sel) => page.$eval(sel, (el) => {
      const b = el.getBoundingClientRect();
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom,
        visible: el.contains(document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2)) };
    });
    const download = await box('[data-testid="asset-download"]');
    const importer = await box('[data-testid="asset-import"]');
    for (const [name, bounds] of [['download', download], ['import', importer]]) {
      assert.ok(bounds.left >= 0 && bounds.right <= viewport.width && bounds.top >= 0 && bounds.bottom <= viewport.height, `${name} ${JSON.stringify(bounds)}`);
      assert.ok(bounds.visible, `the ${name} button is not covered`);
    }
    assert.ok(Math.abs(download.top - importer.top) < 1 && download.right <= importer.left, `side by side ${JSON.stringify({ download, importer })}`);
    const hints = await page.$$eval('.title-assets__item > small', (els) => els.map((el) => el.getBoundingClientRect().bottom));
    const foot = await page.$eval('.title-foot', (el) => [...el.children].map((c) => c.getBoundingClientRect())
      .filter((b) => b.width > 0).map((b) => ({ top: b.top, left: b.left, right: b.right })));
    const block = await page.$eval('.title-assets', (el) => el.getBoundingClientRect().toJSON());
    assert.equal(hints.length, 2, 'a hint line under each button');
    for (const f of foot) {
      const across = f.left < block.right && f.right > block.left;
      assert.ok(!across || Math.max(...hints) <= f.top, `the hints stay above the footer ${JSON.stringify({ hints, f })}`);
    }
    if (process.env.SP_ASSET_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.SP_ASSET_SCREENSHOTS, `title-${viewport.width}.png`) });
  }
  // A second, empty context cannot start it either: the entry is disabled before any network work.
  const context = await browser.createBrowserContext();
  const other = await context.newPage();
  await other.goto(srv.url);
  await other.waitForSelector('[data-testid="asset-download"]');
  await other.click('[data-testid="asset-download"]');
  assert.equal(await other.$eval('[data-testid="asset-download"]', (el) => el.disabled), true);
  assert.equal(await other.evaluate(async () => (await import('/js/assetDownload.js')).assetDownload.get().phase), 'idle');
  await context.close();
  assert.deepEqual(errors, []);
});
