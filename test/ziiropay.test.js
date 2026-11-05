'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const { createZiiroPayClient, mountZiiroPayDiagnostics, runZiiroPayStartupCheck } = require('../ziiropay');
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' }
});

test('ZiiroPay unconfigured fails closed and never fetches', async () => {
  let calls = 0;
  const client = createZiiroPayClient({ apiKey: '', webhookSecret: '', fetchImpl: async () => { calls++; } });
  assert.equal((await client.checkConnection()).code, 'ZIIROPAY_NOT_CONFIGURED');
  assert.deepEqual(client.readiness(), {
    apiKeyConfigured: false, webhookSecretConfigured: false, connectionVerified: false,
    cardOperationsEnabled: false, webhookVerificationReady: false, stage: 'read_only_connection_check'
  });
  assert.equal(calls, 0);
});

test('ZiiroPay documented GET validates shape and discards secrets and merchant balance', async () => {
  const key = 'local-synthetic-api-credential';
  let calls = 0;
  const client = createZiiroPayClient({
    apiKey: key, webhookSecret: 'local-synthetic-webhook-credential',
    fetchImpl: async (url, options) => {
      calls++;
      const u = new URL(url);
      assert.equal(u.origin, 'https://www.ziiropay.com');
      assert.equal(u.pathname, '/api/wallet/balance/USD');
      assert.equal(u.searchParams.get('public_key'), key);
      assert.equal(u.searchParams.has('mode'), false, 'balance endpoint has no documented mode parameter');
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.body, undefined);
      assert.equal(options.headers.Authorization, undefined);
      return json({ balance: '1234.56', private: key });
    }
  });
  const result = await client.checkConnection();
  assert.equal(result.connected, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.cached, false);
  assert.ok(!JSON.stringify(result).includes(key));
  assert.ok(!JSON.stringify(result).includes('1234.56'));
  assert.equal(client.readiness().connectionVerified, true);
  assert.equal(client.readiness().webhookVerificationReady, false);
  assert.equal(client.readiness().cardOperationsEnabled, false);
  assert.equal(calls, 1);
});

test('ZiiroPay empty merchant balance is valid but success:true alone is not', async () => {
  assert.equal((await createZiiroPayClient({ apiKey: 'fixture', fetchImpl: async () => json({ balance: '0.00' }) }).checkConnection()).connected, true);
  for (const body of [null, [], {}, { success: true }, { balance: -1 }, { balance: '-1.00' },
    { balance: 'NaN' }, { balance: 2 }, { balance: '2e8' }, { success: false, balance: '1.00' }]) {
    const result = await createZiiroPayClient({ apiKey: 'fixture', fetchImpl: async () => json(body) }).checkConnection();
    assert.equal(result.connected, false);
    assert.equal(result.code, 'ZIIROPAY_UNEXPECTED_RESPONSE');
  }
});

test('ZiiroPay auth, rate-limit and server errors are sanitized without automatic retry', async () => {
  for (const [status, code] of [[401, 'ZIIROPAY_AUTH_REJECTED'], [403, 'ZIIROPAY_AUTH_REJECTED'],
    [429, 'ZIIROPAY_RATE_LIMITED'], [500, 'ZIIROPAY_HTTP_ERROR']]) {
    let calls = 0;
    const client = createZiiroPayClient({ apiKey: 'fixture', fetchImpl: async () => {
      calls++; return json({ error: 'private-provider-error', token: 'not-for-client' }, status);
    } });
    const result = await client.checkConnection();
    assert.equal(result.code, code);
    assert.equal(result.httpStatus, status);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(result).includes('private-provider-error'));
  }
});

test('ZiiroPay redirect/network errors cannot leak credential-bearing exception messages', async () => {
  const client = createZiiroPayClient({ apiKey: 'fixture', fetchImpl: async (_, options) => {
    assert.equal(options.redirect, 'error');
    throw new Error('secret-key-in-private-provider-url');
  } });
  const result = await client.checkConnection();
  assert.equal(result.code, 'ZIIROPAY_NETWORK_ERROR');
  assert.ok(!JSON.stringify(result).includes('secret-key'));
});

test('ZiiroPay rejects HTML, malformed JSON and oversized responses', async () => {
  for (const [response, code] of [
    [new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } }), 'ZIIROPAY_UNEXPECTED_RESPONSE'],
    [new Response('{bad', { headers: { 'content-type': 'application/json' } }), 'ZIIROPAY_UNEXPECTED_RESPONSE'],
    [json({ balance: '1.00', padding: 'x'.repeat(9000) }), 'ZIIROPAY_RESPONSE_TOO_LARGE']
  ]) {
    const client = createZiiroPayClient({ apiKey: 'fixture', fetchImpl: async () => response });
    assert.equal((await client.checkConnection()).code, code);
  }
});

test('ZiiroPay deadline covers a stalled connection', async () => {
  const client = createZiiroPayClient({ apiKey: 'fixture', timeoutMs: 15, fetchImpl: async (_, { signal }) =>
    new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('private-url')), { once: true }))
  });
  assert.equal((await client.checkConnection()).code, 'ZIIROPAY_TIMEOUT');
});

test('ZiiroPay deadline covers a stalled response body', async () => {
  const client = createZiiroPayClient({ apiKey: 'fixture', timeoutMs: 15, fetchImpl: async (_, { signal }) =>
    new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(new Error('private-url')), { once: true });
      }
    }), { headers: { 'content-type': 'application/json' } })
  });
  assert.equal((await client.checkConnection()).code, 'ZIIROPAY_TIMEOUT');
});

test('ZiiroPay safe result cache and single-flight limit outbound traffic', async () => {
  let calls = 0, time = 1700000000000;
  const client = createZiiroPayClient({ apiKey: 'fixture', now: () => time, fetchImpl: async () => {
    calls++; await new Promise((resolve) => setTimeout(resolve, 10));
    return json({ balance: '1.00' });
  } });
  const results = await Promise.all(Array.from({ length: 10 }, () => client.checkConnection()));
  assert.ok(results.every((r) => r.connected));
  assert.equal(calls, 1);
  assert.equal((await client.checkConnection()).cached, true);
  time += 60001;
  assert.equal(client.readiness().connectionVerified, false);
  await client.checkConnection();
  assert.equal(calls, 2);
});

test('ZiiroPay diagnostics require full admin and custom header, expose no balance, enforce rate limit', async () => {
  let probes = 0, authorizedTests = 0;
  const app = express();
  const client = {
    readiness: () => ({ apiKeyConfigured: true, cardOperationsEnabled: false }),
    checkConnection: async () => { probes++; return { connected: true, code: 'ZIIROPAY_CONNECTION_VERIFIED' }; }
  };
  const adminOnly = (req, res, next) => {
    const role = req.get('x-fixture-role');
    if (!role) return res.status(401).json({ error: 'Auth required' });
    if (role !== 'admin') return res.status(403).json({ error: 'Admin required' });
    next();
  };
  const rateLimit = (max) => (req, res, next) => {
    if (++authorizedTests > max) return res.status(429).json({ error: 'Limit' });
    next();
  };
  mountZiiroPayDiagnostics(app, { adminOnly, rateLimit, client });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const endpoint = '/api/admin/virtual-cards/connection-test';
  try {
    for (const [role, status] of [[null, 401], ['user', 403], ['support', 403]]) {
      const headers = role ? { 'x-fixture-role': role } : {};
      assert.equal((await fetch(base + endpoint, { method: 'POST', headers })).status, status);
      assert.equal((await fetch(base + '/api/admin/virtual-cards/readiness', { headers })).status, status);
    }
    assert.equal(probes, 0);
    assert.equal((await fetch(base + endpoint, { method: 'POST', headers: { 'x-fixture-role': 'admin' } })).status, 403);
    const headers = { 'x-fixture-role': 'admin', 'X-Requested-With': 'XMLHttpRequest' };
    const readiness = await fetch(base + '/api/admin/virtual-cards/readiness', { headers });
    assert.equal(readiness.status, 200);
    assert.equal(readiness.headers.get('cache-control'), 'no-store');
    assert.equal(probes, 0, 'reading readiness does not call provider');
    for (let i = 0; i < 6; i++) {
      const response = await fetch(base + endpoint, { method: 'POST', headers });
      assert.equal(response.status, i < 5 ? 200 : 429);
      if (i < 5) {
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(Object.hasOwn(await response.json(), 'balance'), false);
      }
    }
    assert.equal(probes, 5);
    for (const route of ['/api/cards', '/api/cards/fund', '/api/cards/withdraw', '/api/webhooks/ziiropay']) {
      assert.equal((await fetch(base + route, { method: 'POST', headers })).status, 404);
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('ZiiroPay diagnostic failures stay sanitized even when an injected client throws', async () => {
  const app = express();
  mountZiiroPayDiagnostics(app, {
    adminOnly: (req, res, next) => next(),
    rateLimit: () => (req, res, next) => next(),
    client: { checkConnection: async () => { throw new Error('private-secret'); } }
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/admin/virtual-cards/connection-test', {
      method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { connected: false, code: 'ZIIROPAY_CHECK_FAILED' });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('ZiiroPay admin UI parses, uses safe status text and never implies card issuance is verified', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  for (const script of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(script[1]);
  assert.match(source, /onclick="checkZiiroPay\(\)"/);
  const functionSource = source.slice(source.indexOf('async function checkZiiroPay()'), source.indexOf('async function saveSettings()'));
  assert.match(functionSource, /X-Requested-With/);
  assert.match(functionSource, /result\.textContent/);
  assert.doesNotMatch(functionSource, /innerHTML/);
  assert.match(functionSource, /Sa pa konfime dwa emisyon kat/);
  assert.doesNotMatch(functionSource, /ZIIROPAY_API_KEY|ZIIROPAY_WEBHOOK_SECRET/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /mountZiiroPayDiagnostics\(app, \{ adminOnly, rateLimit, client: ziiropayClient \}\)/);
});

test('ZiiroPay boot check requires explicit opt-in and logs only allowlisted codes', async () => {
  let calls = 0;
  const logs = [];
  const client = { checkConnection: async () => { calls++; return { code: 'ZIIROPAY_CONNECTION_VERIFIED', balance: '99.99' }; } };
  for (const enabled of ['false', '', '1', true]) {
    assert.equal(await runZiiroPayStartupCheck(client, { enabled, log: (s) => logs.push(s) }), null);
  }
  assert.equal(calls, 0);
  await runZiiroPayStartupCheck(client, { enabled: 'true', log: (s) => logs.push(s) });
  assert.deepEqual(logs, ['[ziiropay] connection-check ZIIROPAY_CONNECTION_VERIFIED']);
  await runZiiroPayStartupCheck({ checkConnection: async () => ({ code: 'private-secret' }) },
    { enabled: 'true', log: (s) => logs.push(s) });
  assert.equal(logs.at(-1), '[ziiropay] connection-check ZIIROPAY_CHECK_FAILED');
  assert.ok(!JSON.stringify(logs).includes('99.99'));
  assert.ok(!JSON.stringify(logs).includes('private-secret'));
});

test('ZiiroPay actual app wiring protects diagnostics and leaves local balances/settings intact', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morningstar-ziiro-'));
  const secret = 'local-ziiro-app-fixture';
  const roles = ['admin', 'user', 'support'];
  const users = roles.map((role, i) => ({
    id: role, role, uid: String(1000001 + i), name: 'Local ' + role,
    email: role + '@example.test', balance: 123.45, usd: 6.78,
    kyc: { status: 'approved' }, swaps: [], tokenVersion: 0
  }));
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(users));
  const settings = JSON.stringify({ rate: 144, feeActive: false, feePercent: 1.5 });
  fs.writeFileSync(path.join(dir, 'settings.json'), settings);
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port), DATA_DIR: dir, JWT_SECRET: secret,
      SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', RESEND_API_KEY: '', NODE_OPTIONS: '',
      ADMIN_EMAIL: '', ADMIN_PASSWORD: '', TEST_USER_EMAIL: '', TEST2_USER_EMAIL: '',
      ZIIROPAY_API_KEY: '', ZIIROPAY_WEBHOOK_SECRET: '', ZIIROPAY_CONNECTION_CHECK_ON_BOOT: 'false' },
    stdio: 'ignore'
  });
  const base = 'http://127.0.0.1:' + port;
  const headersFor = (role) => role ? { cookie: 'token=' + jwt.sign({ sub: role, v: 0 }, secret) } : {};
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/api/pin-hint')).ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'fixture app starts');
    for (const [role, status] of [[null, 401], ['user', 403], ['support', 403]]) {
      assert.equal((await fetch(base + '/api/admin/virtual-cards/readiness', { headers: headersFor(role) })).status, status);
      assert.equal((await fetch(base + '/api/admin/virtual-cards/connection-test', {
        method: 'POST', headers: { ...headersFor(role), 'X-Requested-With': 'XMLHttpRequest' }
      })).status, status);
    }
    const readiness = await fetch(base + '/api/admin/virtual-cards/readiness', { headers: headersFor('admin') });
    assert.equal(readiness.status, 200);
    assert.equal((await readiness.json()).cardOperationsEnabled, false);
    assert.equal((await fetch(base + '/api/admin/virtual-cards/connection-test', {
      method: 'POST', headers: headersFor('admin')
    })).status, 403);
    const checked = await fetch(base + '/api/admin/virtual-cards/connection-test', {
      method: 'POST', headers: { ...headersFor('admin'), 'X-Requested-With': 'XMLHttpRequest' }
    });
    assert.equal(checked.status, 503);
    assert.equal((await checked.json()).code, 'ZIIROPAY_NOT_CONFIGURED');
    for (const file of ['ziiropay.js', 'ZIIROPAY_INTEGRATION.md']) {
      assert.equal((await fetch(base + '/' + file)).status, 404);
    }
    for (const user of JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'))) {
      assert.equal(user.balance, 123.45);
      assert.equal(user.usd, 6.78);
      assert.deepEqual(user.swaps, []);
    }
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), settings);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
