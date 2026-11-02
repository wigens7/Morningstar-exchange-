'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const { preservedQr, qrUrls } = require('../deposit-qr');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV9kAAAAASUVORK5CYII=', 'base64');
const SECRET = 'local-qr-integration-test-secret';
const headers = (role) => role ? { cookie: `token=${jwt.sign({ sub: role, v: 0 }, SECRET)}` } : {};
const slotPath = (m = 'MonCash', slot = 'account') => `/api/admin/deposit-info/${m}/qr/${slot}`;
const editHeaders = { 'X-Requested-With': 'XMLHttpRequest' };
async function freePort() {
  const s = net.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}
async function start(dir) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, JWT_SECRET: SECRET, NODE_ENV: 'test',
      SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', ADMIN_EMAIL: '', ADMIN_PASSWORD: '',
      TEST_USER_EMAIL: '', TEST2_USER_EMAIL: '', RESEND_API_KEY: '', NODE_OPTIONS: '' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let errors = '';
  child.stderr.on('data', (d) => errors += d);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Server stopped: ' + errors);
    try { if ((await fetch(base + '/api/pin-hint')).ok) return { child, base }; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error('Server did not start: ' + errors);
}
async function stop(server) {
  if (server.child.exitCode !== null) return;
  await new Promise((resolve) => {
    server.child.once('exit', resolve);
    server.child.kill('SIGTERM');
  });
}

test('QR metadata only survives unchanged destinations', () => {
  assert.deepEqual(qrUrls('MonCash', null), {});
  assert.deepEqual(preservedQr('MonCash', null, { account: 'new' }), {});
  assert.deepEqual(qrUrls('__proto__'), {});
  const name = '11111111-1111-4111-8111-111111111111.png';
  assert.deepEqual(preservedQr('MonCash', { account: 'old', qr: { account: name } }, { account: 'new' }), {});
  assert.deepEqual(preservedQr('MonCash', { account: 'old', qr: { account: name } }, { account: 'old' }), { account: name });
  assert.deepEqual(preservedQr('MonCash', { account: 'old', qr: { account: '../../secrets.png' } }, { account: 'old' }), {});
});

test('deposit QR authorization, validation, settings preservation and restart persistence', { timeout: 45000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morningstar-qr-'));
  const users = ['admin', 'customer', 'support'].map((role) => ({
    id: role, uid: { admin: '1000001', customer: '1000002', support: '1000003' }[role],
    role: role === 'customer' ? 'user' : role, name: 'Local ' + role, email: role + '@example.test',
    emailVerified: true, balance: 0, usd: 0, swaps: [], notifs: [], kyc: { status: 'approved' },
    createdAt: new Date().toISOString()
  }));
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(users));
  let server = await start(dir);
  const request = (url, role = 'admin', options = {}) => fetch(server.base + url, {
    ...options, headers: { ...headers(role), ...options.headers }
  });
  let info = { MonCash: { active: true, account: '50937000000', name: 'Local test', note: 'Verify before paying' } };
  const save = () => request('/api/admin/deposit-info', 'admin', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ info })
  });
  const upload = (m = 'MonCash', slot = 'account', { bytes = PNG, type = 'image/png', role = 'admin', custom = true } = {}) => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), 'ignored-untrusted-name.png');
    return request(slotPath(m, slot), role, { method: 'POST', headers: custom ? editHeaders : {}, body: form });
  };
  let url;
  try {
    await t.test('only authenticated full admins can upload or delete; custom header required', async () => {
      assert.equal((await upload('MonCash', 'account', { role: null })).status, 401);
      for (const role of ['customer', 'support']) {
        assert.equal((await upload('MonCash', 'account', { role })).status, 403);
        assert.equal((await request(slotPath(), role, { method: 'DELETE', headers: editHeaders })).status, 403);
      }
      assert.equal((await upload('MonCash', 'account', { custom: false })).status, 403);
      assert.equal((await upload('unknown', 'account')).status, 400);
      assert.equal((await upload('USDT', 'unknown-network')).status, 400);
    });
    await t.test('account must be saved before adding QR; original account-only behavior works', async () => {
      assert.equal((await upload()).status, 400);
      assert.equal((await save()).status, 200);
      const methods = await (await request('/api/deposit-info', 'customer')).json();
      assert.equal(methods[0].account, info.MonCash.account);
      assert.deepEqual(methods[0].qr, {});
    });
    await t.test('reject SVG, mismatched MIME, empty images and uploads above 5 MB', async () => {
      assert.equal((await upload('MonCash', 'account', { bytes: Buffer.from('<svg onload="alert(1)"/>'), type: 'image/svg+xml' })).status, 400);
      assert.equal((await upload('MonCash', 'account', { type: 'image/jpeg' })).status, 400);
      assert.equal((await upload('MonCash', 'account', { bytes: Buffer.alloc(0) })).status, 400);
      assert.equal((await upload('MonCash', 'account', { bytes: Buffer.alloc(5 * 1024 * 1024 + 1) })).status, 400);
    });
    await t.test('upload, authenticated preview and download use safe image headers', async () => {
      const r = await upload();
      assert.equal(r.status, 201, await r.clone().text());
      url = (await r.json()).url;
      assert.equal((await request(url, null)).status, 401);
      const image = await request(url, 'customer');
      assert.equal(image.status, 200);
      assert.equal(image.headers.get('content-type'), 'image/png');
      assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(image.headers.get('cache-control'), 'private, no-store');
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
      assert.match((await request(url + '?download=1', 'customer')).headers.get('content-disposition'), /^attachment/);
      assert.equal((await request(url.replace('/account/', '/invalid/'), 'customer')).status, 404);
    });
    await t.test('ordinary settings saves preserve QR and ignore client-supplied QR references', async () => {
      info.MonCash.qr = { account: 'https://attacker.example/unsafe.svg' };
      assert.equal((await save()).status, 200);
      const actual = await (await request('/api/admin/deposit-info')).json();
      assert.equal(actual.MonCash.qr.account, url);
      assert.equal((await request(url, 'customer')).status, 200);
    });
    await t.test('replacement invalidates old URL and removes its file without changing account', async () => {
      const oldUrl = url, oldName = url.split('/').pop();
      url = (await (await upload()).json()).url;
      assert.notEqual(url, oldUrl);
      assert.equal((await request(oldUrl, 'customer')).status, 404);
      assert.equal(fs.existsSync(path.join(dir, 'deposit-qr', oldName)), false);
      assert.equal((await (await request('/api/admin/deposit-info')).json()).MonCash.account, info.MonCash.account);
    });
    await t.test('QR file and settings survive restarting the backend with the same DATA_DIR', async () => {
      await stop(server);
      server = await start(dir);
      const methods = await (await request('/api/deposit-info', 'customer')).json();
      assert.equal(methods[0].qr.account, url);
      assert.deepEqual(Buffer.from(await (await request(url, 'customer')).arrayBuffer()), PNG);
    });
    await t.test('inactive payment methods hide QR from customers but allow admin preview', async () => {
      info.MonCash.active = false;
      await save();
      assert.equal((await request(url, 'customer')).status, 404);
      assert.equal((await request(url)).status, 200);
      info.MonCash.active = true;
      await save();
    });
    await t.test('USDT QR is scoped to Binance destination or exact wallet network', async () => {
      info.USDT = { active: true, binance: { id: '12345678' }, networks: { TRC20: 'T' + '1'.repeat(33), BEP20: '0x' + '1'.repeat(40) } };
      await save();
      const trc = await upload('USDT', 'TRC20'), bin = await upload('USDT', 'binance-id');
      assert.equal(trc.status, 201);
      assert.equal(bin.status, 201);
      const actual = await (await request('/api/admin/deposit-info')).json();
      assert.ok(actual.USDT.qr.TRC20);
      assert.ok(actual.USDT.qr['binance-id']);
      assert.equal(actual.USDT.qr.BEP20, undefined);
      assert.equal((await request(actual.USDT.qr.TRC20.replace('/TRC20/', '/BEP20/'), 'customer')).status, 404);
      const old = actual.USDT.qr.TRC20;
      info.USDT.networks.TRC20 = 'T' + '2'.repeat(33);
      await save();
      const changed = await (await request('/api/admin/deposit-info')).json();
      assert.equal(changed.USDT.qr.TRC20, undefined);
      assert.equal(changed.USDT.qr['binance-id'], actual.USDT.qr['binance-id']);
      assert.equal((await request(old, 'customer')).status, 404);
    });
    await t.test('changed account clears a stale QR instead of sending users to old payment details', async () => {
      const old = url;
      info.MonCash.account = '50938000000';
      await save();
      assert.deepEqual((await (await request('/api/admin/deposit-info')).json()).MonCash.qr, {});
      assert.equal((await request(old, 'customer')).status, 404);
      assert.equal(fs.existsSync(path.join(dir, 'deposit-qr', old.split('/').pop())), false);
      url = (await (await upload()).json()).url;
    });
    await t.test('viewing QR never credits balances; deposit still requires acknowledgement and manual approval', async () => {
      const before = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'))).find((u) => u.id === 'customer');
      await request(url, 'customer');
      const body = { method: 'MonCash', amount: 25, reference: 'QR-LOCAL-TEST' };
      const opts = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
      assert.equal((await request('/api/deposit', 'customer', opts)).status, 400);
      opts.body = JSON.stringify({ ...body, ack: true });
      assert.equal((await request('/api/deposit', 'customer', opts)).status, 201);
      const after = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'))).find((u) => u.id === 'customer');
      assert.equal(after.balance, before.balance);
      assert.equal(after.usd, before.usd);
      assert.equal(after.swaps.at(-1).status, 'pending');
    });
    await t.test('deletion removes only QR and preserves payment account; repeated deletion is safe', async () => {
      const file = path.join(dir, 'deposit-qr', url.split('/').pop());
      assert.equal((await request(slotPath(), 'admin', { method: 'DELETE', headers: editHeaders })).status, 200);
      assert.equal((await request(slotPath(), 'admin', { method: 'DELETE', headers: editHeaders })).status, 200);
      assert.equal(fs.existsSync(file), false);
      assert.equal((await request(url, 'customer')).status, 404);
      const actual = await (await request('/api/admin/deposit-info')).json();
      assert.equal(actual.MonCash.account, info.MonCash.account);
      assert.deepEqual(actual.MonCash.qr, {});
    });
  } finally {
    await stop(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
