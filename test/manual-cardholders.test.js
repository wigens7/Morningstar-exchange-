'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const jwt = require('jsonwebtoken');
const { createManualCardholders } = require('../manual-cardholders');
const { notificationEmail } = require('../email-templates');
const admin = { id: 'admin', role: 'admin' };
const customer = (id = 'customer') => ({ id, role: 'user', email: id + '@example.test',
  emailVerifiedAt: '2026-01-01T00:00:00Z', emailVerificationRequired: true,
  profile: { firstName: 'Fixture', lastName: 'Customer' },
  kyc: { status: 'approved', submittedAt: '2026-01-01' }, usd: 50, balance: 100 });
const identity = (user, id = 'provider-fixture-123') => ({
  first_name: user.profile.firstName, last_name: user.profile.lastName, email: user.email,
  customer_id: id, phone_number: '12025550123', dial_code: '+1', country: 'USA'
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-cardholder-'));
  const users = new Map([admin, customer(), customer('other')].map((u) => [u.id, structuredClone(u)]));
  let calls = 0, notices = 0;
  const options = { dataDir: dir, getUser: (id) => structuredClone(users.get(id)),
    provider: { configured: true, async lookup(email) {
      calls++; const u = [...users.values()].find((x) => x.email === email);
      return { ok: true, approved: true, identity: identity(u) };
    } },
    notifyLinked: async () => { notices++; return true; } };
  const service = createManualCardholders(options);
  return { dir, users, options, service, calls: () => calls, notices: () => notices,
    close() { service.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const body = (customerId = 'provider-fixture-123', revision = null) => ({ customerId, revision });
const rejects = (promise, code) => assert.rejects(promise, (e) => e.code === code);

test('manual workflow respects existing legacy email policy without inventing a new verification flag', async () => {
  const f = fixture();
  try {
    const u = f.users.get('customer');
    delete u.emailVerifiedAt; delete u.emailVerificationRequired; delete u.role;
    assert.equal((await f.service.link(admin, u.id, body())).cardholderApproved, true);
  } finally { f.close(); }
});

test('manual cardholder requires full admin, active locally approved customer and strictly scoped input', async () => {
  const f = fixture();
  try {
    await rejects(f.service.link(customer(), 'customer', body()), 'CARDHOLDER_ADMIN_REQUIRED');
    for (const input of [null, [], body('bad id'), { ...body(), email: 'other@example.test' }, { customerId: 'provider-fixture-123' }]) {
      await rejects(f.service.link(admin, 'customer', input), 'CARDHOLDER_INVALID_FIELDS');
    }
    for (const [key, value, code] of [
      ['banned', true, 'CARDHOLDER_CUSTOMER_REQUIRED'], ['role', 'support', 'CARDHOLDER_CUSTOMER_REQUIRED'],
      ['emailVerifiedAt', null, 'CARDHOLDER_EMAIL_REQUIRED'], ['kyc', { status: 'pending' }, 'CARDHOLDER_LOCAL_KYC_REQUIRED'],
      ['profile', {}, 'CARDHOLDER_PROFILE_REQUIRED']
    ]) {
      f.users.set('customer', { ...customer(), [key]: value });
      await rejects(f.service.link(admin, 'customer', body()), code);
    }
    assert.equal(f.calls(), 0); assert.equal(f.notices(), 0);
  } finally { f.close(); }
});

test('manual link verifies provider, persists across restart, notifies once, exposes no ID to customer and never alters wallets', async () => {
  const f = fixture(); let restarted;
  try {
    const result = await f.service.link(admin, 'customer', body());
    assert.equal(result.cardholderApproved, true); assert.equal(result.cardOperationsEnabled, false);
    assert.equal(result.customerId, 'provider-fixture-123'); assert.equal(result.notificationPending, false);
    await f.service.link(admin, 'customer', body('provider-fixture-123', result.revision));
    assert.equal(f.notices(), 1);
    const publicView = f.service.status(f.users.get('customer'));
    assert.doesNotMatch(JSON.stringify(publicView), /provider-fixture|customer@example|admin|revision/);
    assert.equal(f.service.status(f.users.get('other')).cardholderApproved, false);
    f.service.close(); restarted = createManualCardholders(f.options);
    assert.equal(restarted.status(f.users.get('customer')).cardholderApproved, true);
    assert.equal(await restarted.retryNotifications(), 0);
    assert.equal(f.users.get('customer').usd, 50); assert.equal(f.users.get('customer').balance, 100);
    assert.equal(fs.statSync(path.join(f.dir, 'ziiropay-cardholders.sqlite')).mode & 0o777, 0o600);
    const db = new DatabaseSync(path.join(f.dir, 'ziiropay-cardholders.sqlite'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM cardholder_audit').get().n, 1); db.close();
  } finally { restarted?.close(); f.close(); }
});

test('wrong provider ID, identity mismatch, unapproved and unavailable provider cannot create a manual association', async () => {
  for (const change of [
    { ok: false }, { ok: true, approved: false },
    ...['customer_id', 'email', 'first_name', 'last_name'].map((key) => ({
      ok: true, approved: true, identity: { ...identity(customer()), [key]: 'WRONG' }
    }))
  ]) {
    const f = fixture(); let service;
    try {
      service = createManualCardholders({ ...f.options, provider: { configured: true, lookup: async () => change } });
      await assert.rejects(service.link(admin, 'customer', body()));
      assert.equal(service.status(customer()).linked, false); assert.equal(f.notices(), 0);
    } finally { service?.close(); f.close(); }
  }
});

test('concurrent manual links are idempotent; a provider ID cannot belong to two customers; existing link cannot be replaced', async () => {
  const f = fixture();
  try {
    const results = await Promise.all([f.service.link(admin, 'customer', body()), f.service.link(admin, 'customer', body())]);
    assert.equal(results[0].revision, results[1].revision);
    assert.equal(f.notices(), 1);
    await rejects(f.service.link(admin, 'other', body()), 'CARDHOLDER_ASSOCIATION_CONFLICT');
    await rejects(f.service.link(admin, 'customer', body('different-provider-id', results[0].revision)), 'CARDHOLDER_ALREADY_LINKED');
    await rejects(f.service.link(admin, 'customer', body()), 'CARDHOLDER_STALE');
    assert.equal(f.service.status(customer('other')).linked, false);
  } finally { f.close(); }
});

test('profile/admin changes during provider lookup block linking; later identity changes invalidate readiness', async () => {
  for (const revokeAdmin of [false, true]) {
    const f = fixture(); let service;
    try {
      service = createManualCardholders({ ...f.options, provider: { configured: true, async lookup() {
        if (revokeAdmin) f.users.get('admin').role = 'support';
        else f.users.get('customer').email = 'changed@example.test';
        return { ok: true, approved: true, identity: identity(customer()) };
      } } });
      await rejects(service.link(admin, 'customer', body()), revokeAdmin ? 'CARDHOLDER_ADMIN_REQUIRED' : 'CARDHOLDER_ACCOUNT_CHANGED');
      assert.equal(service.status(f.users.get('customer')).linked, false);
    } finally { service?.close(); f.close(); }
  }
  const f = fixture();
  try {
    await f.service.link(admin, 'customer', body());
    f.users.get('customer').profile.lastName = 'Changed';
    assert.equal(f.service.status(f.users.get('customer')).status, 'REVIEW_REQUIRED');
    const result = await f.service.link(admin, 'customer', body('provider-fixture-123', f.service.status(f.users.get('customer'), true).revision));
    assert.equal(result.cardholderApproved, true); assert.equal(f.notices(), 2);
  } finally { f.close(); }
});

test('failed notification does not undo link; durable pending notices resume after restart without another provider lookup', async () => {
  const f = fixture(); let restarted, first;
  try {
    first = createManualCardholders({ ...f.options, notifyLinked: async () => { throw new Error('private'); } });
    const linked = await first.link(admin, 'customer', body());
    assert.equal(linked.cardholderApproved, true); assert.equal(linked.notificationPending, true);
    first.close();
    restarted = createManualCardholders(f.options);
    assert.equal(await restarted.retryNotifications(), 1);
    assert.equal(await restarted.retryNotifications(), 0);
    assert.equal(f.calls(), 1); assert.equal(f.notices(), 1);
  } finally { first?.close(); restarted?.close(); f.close(); }
});

test('a definitive failed provider recheck invalidates the old ready state, and reapproval can restore the same ID', async () => {
  const f = fixture(); let service, approved = true;
  try {
    service = createManualCardholders({ ...f.options, provider: { configured: true,
      lookup: async () => ({ ok: true, approved, identity: identity(customer()) }) } });
    const linked = await service.link(admin, 'customer', body());
    approved = false;
    await rejects(service.link(admin, 'customer', body('provider-fixture-123', linked.revision)), 'CARDHOLDER_NOT_APPROVED');
    assert.equal(service.status(customer()).status, 'REVIEW_REQUIRED');
    approved = true;
    assert.equal((await service.link(admin, 'customer', body('provider-fixture-123', linked.revision))).cardholderApproved, true);
  } finally { service?.close(); f.close(); }
});

test('manual cardholder email is Haitian Creole only and does not falsely claim an issued card', () => {
  for (const locale of ['ht', 'en', 'fr', 'es']) {
    const message = notificationEmail({ eventType: 'CARDHOLDER_APPROVED', audience: 'USER', locale,
      payload: { occurredAt: '2026-11-05T17:00:00Z' } });
    assert.match(message.subject, /Dosye kat ou pare/);
    assert.match(message.text, /pa yon konfimasyon kreyasyon kat/);
    assert.match(message.html, /lang="ht"/);
    assert.doesNotMatch(message.text, /provider-fixture|Customer ID/);
  }
});

test('actual app manual endpoints enforce admin/session/CSRF and queue only one notice without KYC submissions or money writes', { timeout: 15000 }, async () => {
  const f = fixture(), preload = path.join(f.dir, 'mock-provider.cjs'), counts = path.join(f.dir, 'calls.json');
  const key = 'synthetic-manual-provider-key', secret = 'synthetic-manual-jwt';
  fs.writeFileSync(path.join(f.dir, 'users.json'), JSON.stringify([...f.users.values(), { id: 'support', role: 'support' }]));
  const settings = JSON.stringify({ rate: 140, feeActive: false, deposit: { MonCash: { account: 'fixture' } } });
  fs.writeFileSync(path.join(f.dir, 'settings.json'), settings);
  fs.writeFileSync(preload, `const fs=require('node:fs');
globalThis.fetch=async(url,options)=>{
 const u=new URL(url);
 if(u.origin!=='https://www.ziiropay.com'||u.pathname!=='/api/bitvcard/cardkycstatus'||options.method!=='GET')throw new Error('TEST_NETWORK_BLOCKED');
 const file=process.env.TEST_CALLS_FILE,n=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)).count:0;
 fs.writeFileSync(file,JSON.stringify({count:n+1}));
 return new Response(JSON.stringify({success:true,data:{status:'approved',customer_id:'provider-fixture-123',
 first_name:'Fixture',last_name:'Customer',email:u.searchParams.get('email'),phone_number:'12025550123',dial_code:'+1',country:'USA'}}),
 {headers:{'Content-Type':'application/json'}});
};`);
  const socket = net.createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  let child, logs = '';
  const base = 'http://127.0.0.1:' + port;
  async function start() {
    child = spawn(process.execPath, ['--require', preload, 'server.js'], { cwd: path.join(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'test', DATA_DIR: f.dir, PORT: String(port), JWT_SECRET: secret,
        SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', RESEND_API_KEY: '', NODE_OPTIONS: '',
        ADMIN_EMAIL: '', ADMIN_PASSWORD: '', TEST_USER_EMAIL: '', TEST2_USER_EMAIL: '',
        ZIIROPAY_API_KEY: key, ZIIROPAY_KYC_ENABLED: 'false', ZIIROPAY_CONNECTION_CHECK_ON_BOOT: 'false',
        ZIIROPAY_SANDBOX_KYC_PROBE: 'false', TEST_CALLS_FILE: counts }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (b) => { logs += b; }); child.stderr.on('data', (b) => { logs += b; });
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(base + '/api/pin-hint')).ok) return; } catch {}
      if (child.exitCode !== null) assert.fail('Fixture server exited');
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.fail('Fixture server did not start');
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) await new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); });
  }
  const headers = (id = 'admin', ajax = true) => ({ 'Content-Type': 'application/json',
    ...(id ? { cookie: 'token=' + jwt.sign({ sub: id, v: 0 }, secret) } : {}),
    ...(ajax ? { 'X-Requested-With': 'XMLHttpRequest' } : {}) });
  const submit = (payload, h = headers(), id = 'customer') => fetch(base + '/api/admin/users/' + id + '/cardholder',
    { method: 'POST', headers: h, body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  try {
    await start();
    assert.equal((await submit(body(), headers(null))).status, 401);
    assert.equal((await submit(body(), headers('support'))).status, 403);
    assert.equal((await submit(body(), headers('customer'))).status, 403);
    assert.equal((await submit(body(), headers('admin', false))).status, 403);
    assert.equal((await submit({ ...body(), email: 'wrong@example.test' })).status, 400);
    assert.equal(fs.existsSync(counts), false);
    assert.equal((await submit(body('wrong-provider-id'))).status, 409);
    const response = await submit(body()); assert.equal(response.status, 200);
    const linked = await response.json(); assert.equal(linked.cardholderApproved, true);
    assert.equal((await submit(body('provider-fixture-123', linked.revision))).status, 200);
    assert.equal((await submit(body(), headers(), 'other')).status, 409);
    assert.equal((await submit('{"PRIVATE-SYNTHETIC-VALUE":')).status, 400);
    const publicView = await (await fetch(base + '/api/virtual-cards/cardholder', { headers: headers('customer') })).json();
    assert.equal(publicView.cardholderApproved, true);
    assert.doesNotMatch(JSON.stringify(publicView), /provider-fixture|@example|revision/);
    assert.equal((await fetch(base + '/manual-cardholders.js')).status, 404);
    const db = new DatabaseSync(path.join(f.dir, 'p2p.sqlite'));
    assert.equal(db.prepare("SELECT count(*) AS n FROM email_outbox WHERE event_type='CARDHOLDER_APPROVED'").get().n, 1);
    db.close();
    await stop(); await start();
    assert.equal((await (await fetch(base + '/api/virtual-cards/cardholder', { headers: headers('customer') })).json()).cardholderApproved, true);
    await stop();
    const user = JSON.parse(fs.readFileSync(path.join(f.dir, 'users.json'))).find((u) => u.id === 'customer');
    assert.equal(user.notifs.filter((n) => n.k === 'nCardholderReady').length, 1);
    assert.equal(user.usd, 50); assert.equal(user.balance, 100); assert.equal(user.kyc.status, 'approved');
    assert.equal(fs.readFileSync(path.join(f.dir, 'settings.json'), 'utf8'), settings);
    assert.doesNotMatch(logs, /PRIVATE-SYNTHETIC|provider-fixture|synthetic-manual-provider-key|@example/);
  } finally { await stop(); f.close(); }
});
