'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const vm = require('node:vm');
const jwt = require('jsonwebtoken');
const { createCardSettings, usdToCents, publicSetup } = require('../virtual-card-setup');

test('card price uses exact integer cents; no inferred free card or unsafe amounts', () => {
  for (const [text, cents] of [['0', 0], ['0.01', 1], ['10', 1000], ['12.3', 1230], ['999999.99', 99999999]]) {
    assert.equal(usdToCents(text), cents);
  }
  for (const bad of [null, undefined, '', 10, true, {}, 'NaN', '-1', '+1', '01', '1e2', '1.001', ' 1', '1,50', '1000000', 'Infinity']) {
    assert.equal(usdToCents(bad), null);
  }
  assert.equal(publicSetup({ creationPriceCents: null }).creationPriceConfigured, false);
  assert.equal(publicSetup({ creationPriceCents: 0 }).creationPriceConfigured, true);
  assert.equal(publicSetup({ creationPriceCents: 1 }).creationPriceUSD, '0.01');
});

test('card price survives a new settings instance; stale save cannot overwrite it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-price-'));
  try {
    const first = createCardSettings(dir);
    assert.equal(first.read().creationPriceCents, null);
    assert.equal(first.save('1.001', null).error, 'INVALID_PRICE');
    assert.equal(fs.existsSync(path.join(dir, 'virtual-card-settings.json')), false);
    const saved = first.save('10.25', null);
    assert.equal(saved.creationPriceCents, 1025);
    const restarted = createCardSettings(dir);
    assert.deepEqual(restarted.read(), saved);
    assert.equal(restarted.save('99.99', null).error, 'STALE_SETTINGS');
    const updated = restarted.save('0', saved.revision);
    assert.equal(updated.creationPriceCents, 0);
    assert.notEqual(updated.revision, saved.revision);
    assert.equal(fs.statSync(path.join(dir, 'virtual-card-settings.json')).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['virtual-card-settings.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt or inaccessible card settings fail closed, not free/default and not overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-corrupt-'));
  const file = path.join(dir, 'virtual-card-settings.json');
  try {
    for (const text of ['{', '{}', 'null', JSON.stringify({ schemaVersion: 1, creationPriceCents: -1, revision: 'bad' })]) {
      fs.writeFileSync(file, text);
      assert.throws(() => createCardSettings(dir).read(), /CARD_SETTINGS_UNAVAILABLE/);
      assert.throws(() => createCardSettings(dir).save('10.00', null), /CARD_SETTINGS_UNAVAILABLE/);
      assert.equal(fs.readFileSync(file, 'utf8'), text);
    }
    fs.unlinkSync(file); fs.mkdirSync(file);
    assert.throws(() => createCardSettings(dir).read(), /CARD_SETTINGS_UNAVAILABLE/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('card setup pages parse, remain preparatory, do not collect PII or auto-call provider', () => {
  for (const name of ['admin.html', 'card-kyc.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
      if (match[1].trim()) new vm.Script(match[1]);
    }
  }
  const html = fs.readFileSync(path.join(__dirname, '..', 'card-kyc.html'), 'utf8');
  assert.match(html, /KYC kat ZiiroPay la poko ouvri/);
  assert.match(html, /pa soumèt enfòmasyon ni dokiman/);
  assert.doesNotMatch(html, /<input|<form|localStorage|sessionStorage|ziiropay\.com/i);
  assert.match(html, /status\.textContent/);
});

test('actual app: admin price, restart persistence, private KYC entry, rejected webhooks, zero wallet mutations', { timeout: 25000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-app-'));
  const secret = 'local-card-setup-fixture';
  const roles = ['admin', 'user', 'support'];
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(roles.map((role, i) => ({
    id: role, role, uid: String(1000001 + i), name: 'Kont tès',
    email: role + '@example.test', emailVerified: true, balance: 123.45, usd: 67.89,
    kyc: { status: 'approved' }, swaps: [], notifs: [], tokenVersion: 0
  }))));
  const originalSettings = JSON.stringify({ rate: 144, feeActive: false, deposit: { MonCash: { account: 'local-fixture' } } });
  fs.writeFileSync(path.join(dir, 'settings.json'), originalSettings);
  const socket = net.createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const base = 'http://127.0.0.1:' + port;
  let child, logs = '';
  async function start() {
    child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'), env: {
        ...process.env, NODE_ENV: 'test', PORT: String(port), DATA_DIR: dir, JWT_SECRET: secret,
        SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', RESEND_API_KEY: '', NODE_OPTIONS: '',
        ADMIN_EMAIL: '', ADMIN_PASSWORD: '', TEST_USER_EMAIL: '', TEST2_USER_EMAIL: '',
        ZIIROPAY_API_KEY: '', ZIIROPAY_WEBHOOK_SECRET: '', ZIIROPAY_CONNECTION_CHECK_ON_BOOT: 'false'
      }, stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (d) => { logs += d.toString(); });
    child.stderr.on('data', (d) => { logs += d.toString(); });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/api/pin-hint')).ok) return; } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Fixture app did not start');
  }
  async function stop() {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r));
    }
  }
  const headers = (role, ajax = true) => ({
    ...(role ? { cookie: 'token=' + jwt.sign({ sub: role, v: 0 }, secret) } : {}),
    'Content-Type': 'application/json', ...(ajax ? { 'X-Requested-With': 'XMLHttpRequest' } : {})
  });
  const save = (role, body, ajax = true) => fetch(base + '/api/admin/virtual-cards/settings', {
    method: 'POST', headers: headers(role, ajax), body: JSON.stringify(body)
  });
  try {
    await start();
    for (const [role, status] of [[null, 401], ['user', 403], ['support', 403]]) {
      assert.equal((await fetch(base + '/api/admin/virtual-cards/settings', { headers: headers(role) })).status, status);
      assert.equal((await save(role, { creationPriceUSD: '10.00', revision: null })).status, status);
    }
    assert.equal((await save('admin', { creationPriceUSD: '10.00', revision: null }, false)).status, 403);
    assert.equal((await save('admin', { creationPriceUSD: '1.001', revision: null })).status, 400);
    assert.equal((await save('admin', { creationPriceUSD: '10.00', revision: null, withdrawalEnabled: true })).status, 400);
    const unset = await (await fetch(base + '/api/admin/virtual-cards/settings', { headers: headers('admin') })).json();
    assert.equal(unset.creationPriceUSD, null);
    assert.equal(unset.cardOperationsEnabled, false);
    const r = await save('admin', { creationPriceUSD: '12.30', revision: null });
    assert.equal(r.status, 200);
    const saved = await r.json();
    assert.equal(saved.creationPriceUSD, '12.30');
    assert.equal(saved.withdrawalEnabled, false);
    assert.equal((await save('admin', { creationPriceUSD: '9.99', revision: null })).status, 409);

    assert.equal((await fetch(base + '/card-kyc.html')).status, 401);
    assert.equal((await fetch(base + '/api/virtual-cards/setup')).status, 401);
    const page = await fetch(base + '/card-kyc.html', { headers: headers('user') });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.match(page.headers.get('cache-control'), /no-store/);
    const setup = await (await fetch(base + '/api/virtual-cards/setup', { headers: headers('user') })).json();
    assert.equal(setup.creationPriceUSD, '12.30');
    assert.equal(setup.kycSubmissionEnabled, false);
    assert.equal(Object.hasOwn(setup, 'revision'), false);
    assert.equal((await fetch(base + '/api/virtual-cards/kyc', {
      method: 'POST', headers: headers('user'), body: JSON.stringify({ id_number: 'synthetic-sensitive-pii' })
    })).status, 503);

    for (let i = 0; i < 2; i++) {
      const hook = await fetch(base + '/api/webhooks/ziiropay', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': 'invented' },
        body: JSON.stringify({ id: 'local-duplicate-event', event: 'virtualcard.withdrawal.success',
          amount: '5.00', status: 'complete', id_number: 'synthetic-sensitive-pii' })
      });
      assert.equal(hook.status, 503);
      assert.equal((await hook.json()).code, 'ZIIROPAY_WEBHOOK_NOT_ENABLED');
    }
    const malformed = await fetch(base + '/api/webhooks/ziiropay', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"synthetic-sensitive-pii":'
    });
    assert.equal(malformed.status, 503, 'reject before JSON parsing');
    assert.equal((await fetch(base + '/api/webhooks/ziiropay')).status, 405);
    for (const name of ['virtual-card-setup.js', 'virtual-card-settings.json', 'data/virtual-card-settings.json']) {
      assert.equal((await fetch(base + '/' + name)).status, 404);
    }
    await stop(); await start();
    const restored = await (await fetch(base + '/api/admin/virtual-cards/settings', { headers: headers('admin') })).json();
    assert.equal(restored.creationPriceUSD, '12.30');
    assert.equal(restored.revision, saved.revision);
    assert.equal(restored.cardOperationsEnabled, false);
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), originalSettings);
    for (const user of JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'))) {
      assert.equal(user.balance, 123.45);
      assert.equal(user.usd, 67.89);
      assert.deepEqual(user.swaps, []);
    }
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'virtual-card-settings.json'), 'utf8'), /synthetic-sensitive-pii|local-duplicate-event/);
    fs.writeFileSync(path.join(dir, 'virtual-card-settings.json'), '{');
    assert.equal((await fetch(base + '/api/virtual-cards/setup', { headers: headers('user') })).status, 503);
    assert.equal((await save('admin', { creationPriceUSD: '0', revision: saved.revision })).status, 503);
    assert.equal(fs.readFileSync(path.join(dir, 'virtual-card-settings.json'), 'utf8'), '{');
  } finally {
    await stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.doesNotMatch(logs, /synthetic-sensitive-pii|local-duplicate-event/);
});
