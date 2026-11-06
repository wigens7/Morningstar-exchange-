'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const test = require('node:test');

test('admin can rename a customer with validation and an audit record', { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morningstar-admin-name-'));
  const secret = 'fixture-admin-name-secret';
  const makeUser = (id, name, role, email) => ({
    id, uid: id === 'admin' ? '1000001' : '1000002', name, role, email,
    tokenVersion: 0, createdAt: new Date().toISOString(), balance: 0, usd: 0,
    swaps: [], activity: [], kyc: { status: 'none' }
  });
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([
    makeUser('admin', 'Admin', 'admin', 'admin@example.test'),
    makeUser('support', 'Support', 'support', 'support@example.test'),
    { ...makeUser('customer', 'Old Name', 'user', 'customer@example.test'), profile: { firstName: 'Old', lastName: 'Name', dob: '1990-01-01', country: 'Haiti', phone: '+5090000000', address: 'somewhere 1' } }
  ]));

  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));

  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), DATA_DIR: dir, JWT_SECRET: secret,
      SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', RESEND_API_KEY: '',
      ADMIN_EMAIL: '', ADMIN_PASSWORD: '', TEST_USER_EMAIL: '', TEST_USER_PASSWORD: '',
      ZIIROPAY_API_KEY: '', ZIIROPAY_KYC_ENABLED: 'false',
      ZIIROPAY_CONNECTION_CHECK_ON_BOOT: 'false', ZIIROPAY_SANDBOX_KYC_PROBE: 'false',
      NODE_OPTIONS: ''
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const headers = (id) => ({
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    ...(id ? { cookie: 'token=' + jwt.sign({ sub: id, v: 0 }, secret) } : {})
  });
  const post = (id, body) => fetch(base + '/api/admin/users/' + id + '/name', {
    method: 'POST',
    headers: headers('admin'),
    body: JSON.stringify(body)
  });

  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) break;
      try {
        if ((await fetch(base + '/api/pin-hint')).ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(ready, true, 'fixture server did not start: ' + stderr.slice(-500));

    const unauthorized = await fetch(base + '/api/admin/users/customer/name', {
      method: 'POST', headers: headers(null), body: JSON.stringify({ name: 'New Name' })
    });
    assert.equal(unauthorized.status, 401);

    const support = await fetch(base + '/api/admin/users/customer/name', {
      method: 'POST', headers: headers('support'), body: JSON.stringify({ name: 'New Name' })
    });
    assert.equal(support.status, 403);

    const renamed = await post('customer', { name: '  New   Name  ' });
    assert.equal(renamed.status, 200);
    assert.deepEqual(await renamed.json(), { name: 'New Name', firstName: 'New', lastName: 'Name' });

    const split = await post('customer', { firstName: ' Marie ', lastName: 'Marthe' });
    assert.equal(split.status, 200);
    assert.equal((await post('customer', { name: 'mariemarthe' })).status, 400);
    assert.equal((await post('customer', { firstName: 'M', lastName: 'Marthe' })).status, 400);

    assert.equal((await post('customer', { name: ' ' })).status, 400);
    assert.equal((await post('customer', { name: 'x'.repeat(101) })).status, 400);
    assert.equal((await post('customer', { name: 42 })).status, 400);
    assert.equal((await post('admin', { name: 'Changed Admin' })).status, 400);

    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'));
    const customer = persisted.find((user) => user.id === 'customer');
    assert.equal(customer.name, 'Marie Marthe');
    assert.equal(customer.profile.firstName, 'Marie');
    assert.equal(customer.profile.lastName, 'Marthe');
    const event = customer.activity.filter((entry) => entry.type === 'name_change').pop();
    assert.equal(event.by, 'admin@example.test');
    assert.match(event.detail, /New Name.*Marie Marthe/);
    assert.equal(persisted.find((user) => user.id === 'admin').name, 'Admin');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
