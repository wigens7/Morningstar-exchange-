'use strict';
// UI simulation only; actual auth/PIN/wallet/provider wiring tested separately.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-browser-'));
const artifacts = process.env.BROWSER_ARTIFACT_DIR || path.join(os.tmpdir(), 'card-browser-artifacts');
const secret = 'synthetic-card-browser-secret';
let child, browser;
async function run() {
  fs.mkdirSync(artifacts, { recursive: true });
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: 'customer', role: 'user',
    email: 'fixture@example.test', kyc: { status: 'approved' }, usd: 0, balance: 0, swaps: [], notifs: [] }]));
  const socket = net.createServer(); await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise((r) => socket.close(r));
  const base = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, JWT_SECRET: secret, NODE_ENV: 'test', NODE_OPTIONS: '',
      SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', ADMIN_EMAIL: '', ADMIN_PASSWORD: '', TEST_USER_EMAIL: '', TEST2_USER_EMAIL: '',
      RESEND_API_KEY: '', ZIIROPAY_API_KEY: '', ZIIROPAY_CONNECTION_CHECK_ON_BOOT: 'false',
      ZIIROPAY_CARD_ISSUING_ENABLED: 'false', ZIIROPAY_KYC_ENABLED: 'false', ZIIROPAY_SANDBOX_KYC_PROBE: 'false' },
    stdio: 'ignore'
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/pin-hint')).status === 200) { ready = true; break; } } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(ready, true);
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await c.addCookies([{ name: 'token', value: jwt.sign({ sub: 'customer', v: 0 }, secret), url: base }]);
  const p = await c.newPage(); p.setDefaultTimeout(10000);
  await p.clock.install();
  let posted = 0, reveals = 0, state = 'EMPTY', enabled = true;
  const quoteId = '0fe87ef1-1453-4f22-9c47-e5394d9bdd72', orderId = 'c862ae25-aa4e-4a09-a0ce-b6482b703439';
  const order = () => ({ id: orderId, state, message: state === 'READY' ? 'Kat ou kreye epi verifye.' : 'Admin dwe verifye demann lan; pa repete acha a.',
    creationFeeUSD: '5.00', initialFundingUSD: '3.00', totalUSD: '8.00',
    card: state === 'READY' ? { last4: '1111', expiry: '04/2029', brand: 'visa', balanceUSD: '3.00' } : null });
  await p.route('**/api/virtual-cards/**', async (route) => {
    const url = new URL(route.request().url()), method = route.request().method();
    const respond = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    if (url.pathname.endsWith('/quote')) {
      assert.equal(route.request().postDataJSON().initialFundingUSD, '3.00');
      return respond({ id: quoteId, creationFeeUSD: '5.00', initialFundingUSD: '3.00', totalUSD: '8.00' });
    }
    if (url.pathname.endsWith('/reveal')) {
      reveals++; assert.match(route.request().postDataJSON().pin, /^\d{6}$/);
      return respond({ number: '1111111111111111', cvv: '000', expiry: '04/2029', expiresInSeconds: 30 });
    }
    if (method === 'POST') {
      posted++; const body = route.request().postDataJSON();
      assert.equal(body.consent, true); assert.equal(body.acceptedTotalUSD, '8.00'); assert.equal(body.quoteId, quoteId);
      assert.equal(Object.hasOwn(body, 'customer_id'), false);
      assert.equal(route.request().headers()['x-requested-with'], 'XMLHttpRequest');
      state = 'READY'; await new Promise((r) => setTimeout(r, 70)); return respond(order());
    }
    return respond({ enabled, cardholderApproved: true, availableUSD: '100.00', orders: state === 'EMPTY' ? [] : [order()] });
  });
  await p.goto(base + '/virtual-card.html'); await p.locator('#buy:not([hidden])').waitFor();
  assert.equal(posted, 0);
  for (const width of [320, 390, 768, 1280]) {
    await p.setViewportSize({ width, height: 844 });
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.ok(await p.locator('#funding').evaluate((e) => parseFloat(getComputedStyle(e).fontSize)) >= 16);
  }
  await p.setViewportSize({ width: 390, height: 844 });
  await p.locator('#funding').fill('3.00'); await p.locator('#quote').click();
  await p.locator('#offer:not([hidden])').waitFor();
  assert.equal(await p.locator('#total').textContent(), '$8.00 USD');
  await p.locator('#create').click(); assert.equal(posted, 0);
  await p.locator('#consent').check(); await p.locator('#pin').fill('123456');
  await p.evaluate(() => { document.getElementById('create').click(); document.getElementById('create').click(); });
  await p.locator('#orders h2').filter({ hasText: 'Kat ou pare' }).waitFor();
  assert.equal(posted, 1); assert.equal(reveals, 0);
  assert.equal(await p.locator('#pin').inputValue(), '');
  await p.screenshot({ path: path.join(artifacts, 'virtual-card-ready-masked-390.png'), fullPage: true });
  await p.bringToFront(); await p.locator('#reveal-pin').fill('123456'); await p.locator('#reveal').click();
  await p.locator('#secret:not([hidden])').waitFor();
  assert.equal(reveals, 1); assert.equal(await p.locator('#reveal-pin').inputValue(), '');
  await p.clock.fastForward(30001); assert.equal(await p.locator('#secret').textContent(), '');
  assert.equal(await p.evaluate(() => localStorage.length + sessionStorage.length), 0);
  state = 'REVIEW'; await p.reload(); await p.locator('#orders h2').waitFor();
  assert.equal(await p.locator('#buy').isVisible(), false); assert.equal(await p.locator('#reveal-box').isVisible(), false);
  assert.equal(posted, 1);
  state = 'EMPTY'; enabled = false; await p.reload();
  await p.locator('#message').filter({ hasText: 'poko aktive' }).waitFor();
  assert.equal(await p.locator('#buy').isVisible(), false);
  await c.close();
  console.log('PASS: card UI 320/390/768/1280; quote/explicit consent/PIN; one POST; masked-only default; reveal/30s clearing; no browser storage; review/disabled no purchase.');
}
run().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) { const done = new Promise((r) => child.once('exit', r)); child.kill('SIGKILL'); await done; }
  fs.rmSync(dir, { recursive: true, force: true });
});
