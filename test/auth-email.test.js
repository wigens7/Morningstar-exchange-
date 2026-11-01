'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function readMail(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function otpFrom(mail) {
  const match = String(mail.text || '').match(/\n(\d{6})\n/);
  assert.ok(match, 'mock email should contain a six-digit code');
  return match[1];
}

function sessionCookie(response) {
  const values = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie') || ''];
  const token = values.map((v) => v.match(/(?:^|;\s*)token=([^;]+)/)).find(Boolean);
  assert.ok(token, 'expected a session cookie');
  return `token=${token[1]}`;
}

test('signup OTP verification and password-change OTP work end to end with mocked Resend', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morningstar-email-'));
  const port = await freePort();
  const capture = path.join(dir, 'mail-capture.jsonl');
  const preload = path.join(__dirname, 'mock-resend.cjs');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATA_DIR: dir,
      JWT_SECRET: 'test-only-jwt-secret',
      ADMIN_EMAIL: 'admin@example.test',
      RESEND_API_KEY: 'test-only-resend-key',
      RESEND_FROM_EMAIL: 'Morningstar Exchange <noreply@morningstarechanj.com>',
      RESEND_CAPTURE_FILE: capture,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload}`.trim()
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data.toString(); });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) break;
      try {
        const response = await fetch(`${base}/api/pin-hint`);
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, `server did not become ready: ${stderr.slice(-500)}`);

    const signup = await fetch(`${base}/api/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Test Customer', email: 'customer@example.test', password: 'old-pass-123' })
    });
    assert.equal(signup.status, 202);
    const pending = await signup.json();
    assert.equal(pending.pendingVerification, true);
    assert.equal(signup.headers.get('set-cookie'), null);
    const blockedLogin = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'customer@example.test', password: 'old-pass-123' })
    });
    assert.equal(blockedLogin.status, 403);
    assert.equal((await blockedLogin.json()).needsVerification, true);
    assert.equal(blockedLogin.headers.get('set-cookie'), null);
    let messages = readMail(capture);
    assert.equal(messages.length, 1);
    const signupCode = otpFrom(messages[0]);

    const verify = await fetch(`${base}/api/email/signup/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'customer@example.test', code: signupCode })
    });
    assert.equal(verify.status, 200);
    let cookie = sessionCookie(verify);
    assert.equal((await verify.json()).emailVerified, true);

    const requestChange = await fetch(`${base}/api/password/change/request`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ currentPassword: 'old-pass-123' })
    });
    assert.equal(requestChange.status, 200);
    messages = readMail(capture);
    const changeCode = otpFrom(messages[messages.length - 1]);

    const changed = await fetch(`${base}/api/password/change/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ code: changeCode, password: 'new-pass-456' })
    });
    assert.equal(changed.status, 200);
    cookie = sessionCookie(changed);

    const oldLogin = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'customer@example.test', password: 'old-pass-123' })
    });
    assert.equal(oldLogin.status, 401);
    const newLogin = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'customer@example.test', password: 'new-pass-456' })
    });
    assert.equal(newLogin.status, 200);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 5000).unref();
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
