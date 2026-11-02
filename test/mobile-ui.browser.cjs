'use strict';
// Local fixtures only. Run npm run test:browser after npx playwright install chromium.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV9kAAAAASUVORK5CYII=', 'base64');
const secret = 'local-browser-fixture-secret';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morningstar-browser-'));
const artifacts = process.env.BROWSER_ARTIFACT_DIR || path.join(os.tmpdir(), 'morningstar-ui-browser');
const report = [];
let child, browser, lastPage;
const token = (role) => jwt.sign({ sub: role, v: 0 }, secret);
const info = {
  MonCash: { active: true, account: '50937000000', name: 'Nadia Pierre', note: 'Toujou verifye non moun k ap resevwa a anvan ou konfime depo a. Asire w enfòmasyon yo kòrèk pou evite erè.' },
  USDT: { active: true, account: '12345678', binance: { id: '12345678' }, networks: { TRC20: 'T' + '1'.repeat(33), BEP20: '0x' + '1'.repeat(40) } }
};
async function run() {
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(['admin', 'customer'].map((role, i) => ({
    id: role, uid: String(1000001 + i), role: role === 'admin' ? 'admin' : 'user',
    name: 'Kont tès lokal', email: role + '@example.test', emailVerified: true,
    balance: 0, usd: 0, swaps: [], notifs: [], kyc: { status: 'approved' }, createdAt: new Date().toISOString()
  }))));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ rate: 140, feeActive: false, deposit: info }));
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, JWT_SECRET: secret, NODE_ENV: 'test',
      SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', ADMIN_EMAIL: '', ADMIN_PASSWORD: '',
      TEST_USER_EMAIL: '', TEST2_USER_EMAIL: '', RESEND_API_KEY: '', NODE_OPTIONS: '' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let errors = '';
  child.stderr.on('data', (d) => errors += d);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/pin-hint')).ok) { ready = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, 'Local fixture failed to start: ' + errors);
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  // Load actual Tailwind once. Disable optional external fonts/icons so tests exercise
  // the supported system-font fallback without depending on those CDNs.
  const tailwind = process.env.TEST_TAILWIND_PATH ? fs.readFileSync(process.env.TEST_TAILWIND_PATH)
    : Buffer.from(await (await fetch('https://cdn.tailwindcss.com', { signal: AbortSignal.timeout(15000) })).arrayBuffer());
  const context = async (role, width) => {
    const c = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 1,
      ignoreHTTPSErrors: true, acceptDownloads: true });
    await c.addCookies([{ name: 'token', value: token(role), url: base }]);
    await c.route('https://**/*', async (route) => {
      const url = route.request().url();
      if (new URL(url).hostname === 'cdn.tailwindcss.com') {
        await route.fulfill({ status: 200, contentType: 'text/javascript', body: tailwind });
      } else await route.abort();
    });
    const p = await c.newPage();
    lastPage = p;
    p.setDefaultNavigationTimeout(30000);
    p.setDefaultTimeout(15000);
    if (process.env.BROWSER_DEBUG) {
      p.on('requestfailed', (req) => console.log('request failed', req.url(), req.failure()?.errorText));
      p.on('response', (res) => console.log('response', res.status(), res.url()));
      p.on('pageerror', (e) => console.log('page error', e.message));
    }
    p.on('pageerror', (e) => errors += '\nBROWSER: ' + e.message);
    return { c, p };
  };
  const apiUpload = async (method, slot) => {
    const form = new FormData(); form.append('file', new Blob([PNG], { type: 'image/png' }), 'test.png');
    const r = await fetch(`${base}/api/admin/deposit-info/${method}/qr/${slot}`, {
      method: 'POST', headers: { cookie: 'token=' + token('admin'), 'X-Requested-With': 'XMLHttpRequest' }, body: form
    });
    assert.equal(r.status, 201);
    return (await r.json()).url;
  };
  // Optional before/after check against a local copy of the original admin file.
  if (process.env.BASELINE_ADMIN) {
    const { c, p } = await context('admin', 390);
    await p.route('**/admin.html', (route) => route.fulfill({
      contentType: 'text/html', body: fs.readFileSync(process.env.BASELINE_ADMIN, 'utf8')
    }));
    await p.goto(base + '/admin.html');
    await p.waitForFunction(() => window.ME_ROLE === 'admin', null, { polling: 100, timeout: 60000 });
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow > 20, 'Expected the original grid to overflow on mobile');
    report.push({ check: 'original mobile overflow reproduced', overflowPx: overflow });
    await c.close();
    console.log('PASS: original mobile overflow reproduced');
  }
  for (const width of [360, 390, 768, 1280]) {
    const { c, p } = await context('admin', width);
    await p.goto(base + '/admin.html');
    await p.waitForFunction(() => window.ME_ROLE === 'admin', null, { polling: 100, timeout: 60000 });
    await p.locator('#list .chips').waitFor();
    await p.evaluate(() => go('dinfo'));
    await p.locator('[data-m="MonCash"] .d-acc').waitFor();
    const metrics = await p.evaluate(() => ({
      viewport: innerWidth, page: document.documentElement.scrollWidth,
      input: parseFloat(getComputedStyle(document.querySelector('.d-acc')).fontSize),
      text: parseFloat(getComputedStyle(document.querySelector('[data-m="MonCash"] .text-sm')).fontSize),
      navWidth: document.getElementById('nav').clientWidth,
      navContent: document.getElementById('nav').scrollWidth
    }));
    assert.ok(metrics.page <= width + 1, JSON.stringify(metrics));
    if (width < 900) {
      assert.ok(metrics.input >= 16);
      assert.ok(metrics.text >= 16);
      assert.ok(metrics.navContent > metrics.navWidth);
      await p.evaluate(() => document.getElementById('nav').scrollTo(0, 0));
      await p.locator('#nav-right').click();
      await p.waitForFunction(() => document.getElementById('nav').scrollLeft > 50, null, { polling: 100 });
      await p.locator('#nav-left').click();
      await p.waitForFunction(() => document.getElementById('nav').scrollLeft < 5, null, { polling: 100 });
    }
    await p.screenshot({ path: path.join(artifacts, `admin-${width}.png`), fullPage: false });
    await p.evaluate(() => go('p2p'));
    await p.locator('.admin-subnav').waitFor();
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (width < 900) assert.ok(await p.locator('.admin-subnav').evaluate((el) => el.scrollWidth > el.clientWidth));
    report.push({ check: 'admin responsive layout and scroll', width, ...metrics });
    console.log('PASS: admin responsive layout and scroll at ' + width);
    await c.close();
  }
  const { c: adminContext, p: admin } = await context('admin', 390);
  await admin.goto(base + '/admin.html');
  await admin.waitForFunction(() => window.ME_ROLE === 'admin', null, { polling: 100, timeout: 60000 });
  await admin.locator('#list .chips').waitFor();
  await admin.evaluate(() => { window.uiConfirm = async () => true; go('dinfo'); });
  const card = admin.locator('[data-m="MonCash"]');
  await card.locator('summary').click();
  const upload = card.locator('input[type=file]');
  await upload.setInputFiles({ name: 'payment.png', mimeType: 'image/png', buffer: PNG });
  await card.getByText('QR la sove.', { exact: false }).waitFor();
  await card.locator('.qr-preview img').waitFor();
  const qrUrl = await card.locator('.qr-preview img').getAttribute('src');
  assert.ok(qrUrl.startsWith('/api/deposit-qr/MonCash/account/'));
  await admin.getByRole('button', { name: 'Sove', exact: true }).click();
  await admin.locator('#di-ok').filter({ hasText: 'Sove!' }).waitFor();
  assert.equal(await card.locator('.qr-preview img').getAttribute('src'), qrUrl);
  await card.locator('.d-acc').fill('unsaved-account');
  await upload.setInputFiles({ name: 'payment.png', mimeType: 'image/png', buffer: PNG });
  await card.getByText('Peze Sove pou kont/rezo sa a', { exact: false }).waitFor();
  await card.locator('.d-acc').fill(info.MonCash.account);
  await admin.route('**/api/admin/deposit-info/MonCash/qr/account', (route) => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Erè upload tès lokal.' })
  }));
  await upload.setInputFiles({ name: 'payment.png', mimeType: 'image/png', buffer: PNG });
  await card.getByText('Erè upload tès lokal.').waitFor();
  assert.equal(await card.locator('.qr-preview img').getAttribute('src'), qrUrl);
  await admin.unroute('**/api/admin/deposit-info/MonCash/qr/account');
  await admin.screenshot({ path: path.join(artifacts, 'admin-qr-390.png'), fullPage: false });
  report.push({ check: 'admin upload, settings preservation, unsaved-account guard and failed-upload recovery', passed: true });

  const trcUrl = await apiUpload('USDT', 'TRC20');
  const binUrl = await apiUpload('USDT', 'binance-id');
  const { c: customerContext, p: customer } = await context('customer', 390);
  let deposits = 0;
  customer.on('request', (req) => { if (req.method() === 'POST' && req.url() === base + '/api/deposit') deposits++; });
  await customer.goto(base + '/dashboard.html');
  await customer.waitForFunction(() => document.getElementById('uname').textContent.includes('Kont tès'), null, { polling: 100, timeout: 60000 });
  await customer.evaluate(() => openDep());
  await customer.locator('#dep-body button').first().waitFor();
  await customer.evaluate(() => depPick('MonCash'));
  await customer.locator('#d-amount').fill('25.50');
  await customer.locator('#d-ref').fill('LOCAL-REFERENCE');
  await customer.locator('#d-ack').check();
  await customer.getByRole('button', { name: 'QR peman', exact: true }).click();
  assert.equal(await customer.locator('#d-amount').inputValue(), '25.50');
  assert.equal(await customer.locator('#d-ref').inputValue(), 'LOCAL-REFERENCE');
  assert.equal(await customer.locator('#d-ack').isChecked(), true);
  await customer.waitForFunction(() => {
    const img = document.querySelector('#dep-body img[src^="/api/deposit-qr/"]');
    return img?.complete && img.naturalWidth > 0;
  }, null, { polling: 100 });
  assert.ok(await customer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const downloading = customer.waitForEvent('download');
  await customer.getByRole('link', { name: 'Telechaje QR la' }).click();
  const download = await downloading;
  assert.match(download.suggestedFilename(), /\.png$/);
  await download.cancel();
  await customer.screenshot({ path: path.join(artifacts, 'customer-qr-390.png'), fullPage: false });
  await customer.getByRole('button', { name: 'Kont / Nimewo', exact: true }).click();
  assert.ok(await customer.locator('#dep-body').textContent().then((s) => s.includes(info.MonCash.account)));
  assert.equal(await customer.locator('#d-ref').inputValue(), 'LOCAL-REFERENCE');
  report.push({ check: 'customer QR/number choice, image rendering, download and form-state retention', passed: true });
  await customerContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  for (const width of [320, 360, 390, 430, 768, 1280]) {
    await customer.setViewportSize({ width, height: 844 });
    const detail = await customer.locator('.dep-detail').evaluateAll((rows) => rows.map((row) => {
      const value = row.querySelector('.dep-value'), label = row.querySelector('.dep-label'), copy = row.querySelector('.dep-copy');
      const v = value.getBoundingClientRect(), l = label.getBoundingClientRect(), c = copy.getBoundingClientRect();
      const style = getComputedStyle(value);
      return { x: v.x, font: style.fontSize, weight: style.fontWeight, color: style.color,
        wordBreak: style.wordBreak, width: v.width, labelTop: l.y, copyBottom: c.bottom, valueTop: v.y,
        copyHeight: c.height, copyWidth: c.width };
    }));
    assert.equal(detail.length, 3);
    assert.ok(detail.every((v) => v.font === '16px' && v.weight === detail[0].weight && v.color === detail[0].color));
    assert.ok(detail.every((v) => Math.abs(v.x - detail[0].x) < 1 && v.wordBreak === 'normal'));
    assert.ok(detail.every((v) => v.valueTop >= v.copyBottom && v.copyHeight >= 44 && v.copyWidth >= 44));
    assert.ok(await customer.locator('#m-dep .sheet').evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
    assert.ok(await customer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await customer.getByRole('button', { name: 'Kopye: Kont / Nimewo', exact: true }).click();
    assert.equal(await customer.evaluate(() => navigator.clipboard.readText()), info.MonCash.account);
    await customer.getByRole('button', { name: 'Kopye: Non sou kont lan', exact: true }).click();
    assert.equal(await customer.evaluate(() => navigator.clipboard.readText()), info.MonCash.name);
    await customer.getByRole('button', { name: 'Kopye: Enstriksyon', exact: true }).click();
    assert.equal(await customer.evaluate(() => navigator.clipboard.readText()), info.MonCash.note);
  }
  await customer.locator('#d-ack').uncheck();
  await customer.locator('#d-go').click();
  assert.equal(deposits, 0);
  await customer.locator('#d-err').waitFor({ state: 'visible' });
  assert.ok(await customer.locator('#d-err').textContent());
  // All existing interface languages retain the same values and field hierarchy.
  await customer.setViewportSize({ width: 320, height: 844 });
  for (const lang of ['fr', 'en', 'es', 'ht']) {
    await customer.evaluate((lang) => { setLang(lang); depRender(); }, lang);
    assert.equal(await customer.locator('.dep-value').first().textContent(), info.MonCash.account);
    assert.equal(await customer.locator('.dep-detail').count(), 3);
    assert.ok(!(await customer.locator('#dep-declaration-title').textContent()).includes('depDeclaration'));
    assert.ok(await customer.locator('#m-dep .sheet').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), lang + ' overflow');
  }
  await customer.setViewportSize({ width: 390, height: 1400 });
  await customer.locator('#m-dep .sheet').evaluate((el) => el.scrollTop = 0);
  await customer.locator('#m-dep .sheet').screenshot({ path: path.join(artifacts, 'customer-account-professional-390.png') });
  await customer.setViewportSize({ width: 390, height: 844 });
  report.push({ check: 'uniform deposit fields, natural wrapping, 44px copy targets, real clipboard, acknowledgement, 6 viewport sizes and 4 languages', passed: true });
  await customer.evaluate(() => depPick('USDT'));
  await customer.evaluate(() => depSet('dest', 'wallet'));
  await customer.evaluate(() => depSet('net', 'TRC20'));
  await customer.getByRole('button', { name: 'QR peman', exact: true }).click();
  assert.equal(await customer.locator('#dep-body img[src^="/api/deposit-qr/"]').getAttribute('src'), trcUrl);
  await customer.evaluate(() => depSet('net', 'BEP20'));
  assert.equal(await customer.getByRole('button', { name: 'QR peman', exact: true }).count(), 0);
  await customer.evaluate(() => depSet('dest', 'binance'));
  await customer.getByRole('button', { name: 'QR peman', exact: true }).click();
  assert.equal(await customer.locator('#dep-body img[src^="/api/deposit-qr/"]').getAttribute('src'), binUrl);
  report.push({ check: 'USDT QR remains scoped to selected destination/network', passed: true });
  await customer.route('**/api/deposit-qr/**', (route) => route.fulfill({ status: 404, body: '' }));
  await customer.evaluate(() => {
    depPick('MonCash');
    depM.qr.account += '?local-test=missing'; // avoid reuse of the previously decoded image
  });
  await customer.getByRole('button', { name: 'QR peman', exact: true }).click();
  await customer.locator('#d-qr-error').waitFor({ state: 'visible' });
  await customer.getByRole('button', { name: 'Kont / Nimewo', exact: true }).click();
  assert.equal(await customer.locator('#d-amount').count(), 1);
  assert.equal(deposits, 0, 'Choosing/viewing QR must never submit or credit a deposit');
  report.push({ check: 'image-failure fallback and zero automatic deposit submissions', passed: true });
  assert.ok(!errors.includes('BROWSER:'), errors);
  await adminContext.close();
  await customerContext.close();
  console.log(JSON.stringify({ passed: report.length, checks: report, screenshots: artifacts }, null, 2));
}
run().catch(async (err) => {
  console.error(err);
  if (lastPage && !lastPage.isClosed()) {
    console.error(await lastPage.evaluate(() => ({ role: window.ME_ROLE, title: document.getElementById('page-title')?.textContent,
      list: document.getElementById('list')?.textContent.slice(0, 800), width: innerWidth, scroll: document.documentElement.scrollWidth })));
    await lastPage.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: false }).catch(() => {});
  }
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); });
  fs.rmSync(dir, { recursive: true, force: true });
});
