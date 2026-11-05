'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createCardKyc, createKycStore, validateSubmission, identityMatches, CONSENT_VERSION, country3 } = require('../card-kyc');
const { createKycProvider, FIELDS } = require('../ziiropay-kyc');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV9kAAAAASUVORK5CYII=', 'base64');
const user = (id = 'fixture-user') => ({
  id, role: 'user', email: id + '@example.test', emailVerified: true,
  pinActive: true, pinHash: 'fixture-hash', balance: 100, usd: 50,
  kyc: { status: 'approved', idType: 'national_id', files: { front: 'front.png' } },
  profile: { firstName: 'Nadia', lastName: 'Pierre', dob: '1990-01-15', country: 'HT',
    phone: '+50937000000', address: 'Adrès sentetik pou tès' }
});
const body = () => ({
  id_number: 'SYNTHETIC-DOCUMENT-123', dial_code: '+509', country: 'HTI',
  state: 'Depatman tès', postal_code: 'HT0000', city: 'Vil tès',
  occupation: 'office_worker', employment_status: 'employed', account_purpose: 'Peman sou entènèt',
  annual_salary: '1000', expected_monthly_volume: '100', place_of_birth: 'Kote tès',
  consent: true, consentVersion: CONSENT_VERSION, pin: '123456'
});
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const approved = (identity, id = 'fixture-customer-id') => ({
  ok: true, approved: true, identity: { ...identity, customer_id: id }
});
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'card-kyc-'));

test('KYC consent, ownership fields, immutable profile, local approval, age and ISO countries are validated', () => {
  const u = user(), b = body();
  const payload = validateSubmission(u, b);
  assert.equal(payload.email, u.email);
  assert.equal(payload.first_name, u.profile.firstName);
  assert.equal(payload.id_type, 'national_id');
  assert.equal(payload.country, 'HTI');
  assert.equal(payload.phone_number, '50937000000');
  for (const extra of ['customer_id', 'user_id', 'email', 'first_name', 'id_front_image', 'mode']) {
    assert.throws(() => validateSubmission(u, { ...b, [extra]: 'caller-controlled' }), /INVALID_KYC_FIELDS/);
  }
  for (const consent of [false, 'true', 1, undefined]) assert.throws(() => validateSubmission(u, { ...b, consent }), /CONSENT_REQUIRED/);
  assert.throws(() => validateSubmission(u, { ...b, consentVersion: 'old' }), /CONSENT_REQUIRED/);
  for (const patch of [{ banned: true }, { role: 'admin' }, { role: 'support' }, { emailVerified: false }, { pinActive: false }, { kyc: { status: 'pending' } }]) {
    assert.throws(() => validateSubmission({ ...u, ...patch }, b));
  }
  for (const patch of [{ dob: '2020-01-01' }, { dob: '1990-02-31' }, { country: 'unknown' }]) {
    assert.throws(() => validateSubmission({ ...u, profile: { ...u.profile, ...patch } }, b));
  }
  for (const patch of [{ country: 'USA' }, { dial_code: '+1' }, { annual_salary: '-1' }, { occupation: '<script>' }]) {
    assert.throws(() => validateSubmission(u, { ...b, ...patch }));
  }
  const settings = fs.readFileSync(path.join(__dirname, '..', 'settings.html'), 'utf8');
  const countries = /const CODES = '([^']+)'/.exec(settings)[1].split(' ');
  assert.ok(countries.every((code) => /^[A-Z]{3}$/.test(country3(code))));
  assert.equal(country3('US'), 'USA'); assert.equal(country3('Haïti'), 'HTI');
  assert.equal(country3('ZZ'), null);
});

test('KYC disabled by default or incomplete configuration: no storage, document access or provider calls', async () => {
  const root = dir();
  try {
    for (const patch of [{}, { enabled: 'true' }, { enabled: 'true', mode: 'sandbox' }, { enabled: 'true', mode: 'live', keyHex: '' }]) {
      const service = createCardKyc({ dataDir: root, keyHex: '', ...patch,
        provider: { configured: true, submit() { assert.fail('No submission'); } },
        readDocument() { assert.fail('No document access'); } });
      assert.equal(service.context(user()).enabled, false);
      await assert.rejects(service.submit(user(), body()), /CARD_KYC_NOT_ENABLED/);
      assert.deepEqual(fs.readdirSync(root), []);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('KYC durable consent, one transmission across concurrent calls/restart, encrypted identity and authoritative approval', async () => {
  const root = dir(), keyHex = crypto.randomBytes(32).toString('hex'), u = user();
  let sent = 0, lookups = 0, result;
  const provider = {
    configured: true,
    async submit(payload) { sent++; assert.equal(payload.id_front_image, image.toString('base64')); return { ok: true, customer_id: 'untrusted-post-id' }; },
    async lookup(email) { lookups++; assert.equal(email, u.email); return result; }
  };
  const options = { dataDir: root, keyHex, enabled: 'true', mode: 'live', provider,
    readDocument: async () => ({ buffer: image }), detectExt: () => 'png' };
  let service = createCardKyc(options);
  try {
    await assert.rejects(service.submit(u, { ...body(), consent: false }), /CONSENT_REQUIRED/);
    assert.equal(sent, 0);
    const replies = await Promise.all([service.submit(u, body()), service.submit(u, body()), service.submit(u, body())]);
    assert.equal(sent, 1);
    assert.ok(replies.every((r) => r.status === 'PENDING' || r.status === 'SUBMITTING'));
    assert.equal(service.status(u).status, 'PENDING');
    service.close(); service = createCardKyc(options);
    await service.submit(u, body()); assert.equal(sent, 1);
    const identity = validateSubmission(u, body());
    result = approved(identity);
    const output = await service.refresh(u);
    assert.equal(output.status, 'APPROVED'); assert.equal(lookups, 1);
    assert.equal(JSON.stringify(output).includes('fixture-customer-id'), false);
    await service.refresh(u); assert.equal(lookups, 1);
    assert.equal(service.status({ ...u, email: 'changed@example.test' }).code, 'KYC_IDENTITY_CHANGED');
    assert.equal(service.status({ ...u, kyc: { ...u.kyc, submittedAt: 'new-document-version' } }).code, 'KYC_IDENTITY_CHANGED');
    service.close();
    const storage = createKycStore(root, keyHex);
    const row = storage.get(u.id);
    assert.equal(row.value.customerId, 'fixture-customer-id');
    assert.equal(row.value.consent.version, CONSENT_VERSION);
    assert.equal(row.value.consent.userId, u.id);
    assert.equal(row.value.consent.recipient, 'ZiiroPay');
    assert.equal(row.value.documentHash, crypto.createHash('sha256').update(image).digest('hex'));
    assert.equal(Object.hasOwn(row.value.identity, 'id_front_image'), false);
    assert.equal(Object.hasOwn(row.value.identity, 'pin'), false);
    storage.close();
    const bytes = fs.readFileSync(path.join(root, 'card-kyc', 'kyc.sqlite'));
    for (const value of [u.email, body().id_number, u.profile.address, 'fixture-customer-id', image.toString('base64')]) {
      assert.equal(bytes.includes(Buffer.from(value)), false, 'No raw PII in SQLite');
    }
    assert.equal(fs.statSync(path.join(root, 'card-kyc')).mode & 0o777, 0o700);
    assert.throws(() => createKycStore(root, crypto.randomBytes(32).toString('hex')), /KYC_STORAGE_UNAVAILABLE/);
  } finally { try { service.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); }
});

test('KYC ambiguous POST never retries; lookups are read-only and rate-gated across restarts', async () => {
  const root = dir(), keyHex = crypto.randomBytes(32).toString('hex');
  let submissions = 0, lookups = 0;
  const options = { dataDir: root, keyHex, enabled: 'true', mode: 'live',
    readDocument: async () => ({ buffer: image }), detectExt: () => 'png',
    provider: { configured: true, submit: async () => { submissions++; throw new Error('private provider URL'); },
      lookup: async () => { lookups++; return { ok: true, approved: false }; } } };
  let service = createCardKyc(options);
  try {
    assert.equal((await service.submit(user(), body())).status, 'UNKNOWN');
    await service.submit(user(), body()); assert.equal(submissions, 1);
    await Promise.all([service.refresh(user()), service.refresh(user())]); assert.equal(lookups, 1);
    service.close(); service = createCardKyc(options);
    await service.submit(user(), body()); await service.refresh(user());
    assert.equal(submissions, 1); assert.equal(lookups, 1);
  } finally { service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a pre-existing SUBMITTING record after a crash never causes another provider POST', async () => {
  const root = dir(), keyHex = crypto.randomBytes(32).toString('hex'), u = user();
  const storage = createKycStore(root, keyHex);
  storage.begin(u.id, { identity: validateSubmission(u, body()), localKycSubmittedAt: null,
    documentHash: 'fixture-hash', consent: { version: CONSENT_VERSION, accepted: true } });
  storage.close();
  const service = createCardKyc({ dataDir: root, keyHex, enabled: 'true', mode: 'live',
    provider: { configured: true, submit: async () => assert.fail('No retry after crash') },
    readDocument: async () => assert.fail('No duplicate document access') });
  try {
    assert.equal((await service.submit(u, body())).status, 'SUBMITTING');
    assert.equal(service.status(user('different')).status, 'NOT_SUBMITTED');
  } finally { service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('KYC account change during document read aborts before persisting consent or calling provider', async () => {
  const root = dir(), u = user();
  let current = u;
  const service = createCardKyc({ dataDir: root, keyHex: crypto.randomBytes(32).toString('hex'), enabled: 'true', mode: 'live',
    getUser: () => current, detectExt: () => 'png',
    readDocument: async () => { current = { ...u, banned: true }; return { buffer: image }; },
    provider: { configured: true, submit: async () => assert.fail('No private-data transmission') } });
  try {
    await assert.rejects(service.submit(u, body()), /KYC_IDENTITY_CHANGED/);
    assert.equal(service.status(u).status, 'NOT_SUBMITTED');
  } finally { service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('wrong identity or duplicate provider customer_id cannot bind; unrelated accounts remain isolated', async () => {
  for (const mismatch of ['email', 'first_name', 'last_name', 'country', 'phone_number', 'dial_code']) {
    const root = dir(), u = user();
    const actual = { ...validateSubmission(u, body()), [mismatch]: 'wrong', customer_id: 'provider-id-123' };
    const service = createCardKyc({ dataDir: root, keyHex: crypto.randomBytes(32).toString('hex'), enabled: 'true', mode: 'live',
      readDocument: async () => ({ buffer: image }), detectExt: () => 'png',
      provider: { configured: true, submit: async () => ({ ok: true }), lookup: async () => approved(actual) } });
    try {
      await service.submit(u, body());
      assert.equal((await service.refresh(u)).status, 'REVIEW_REQUIRED');
      assert.equal(service.status(user('other')).status, 'NOT_SUBMITTED');
    } finally { service.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
  const root = dir();
  let expected;
  const service = createCardKyc({ dataDir: root, keyHex: crypto.randomBytes(32).toString('hex'), enabled: 'true', mode: 'live',
    readDocument: async () => ({ buffer: image }), detectExt: () => 'png',
    provider: { configured: true, submit: async () => ({ ok: true }), lookup: async () => approved(expected, 'same-provider-id') } });
  try {
    for (const [id, status] of [['first', 'APPROVED'], ['second', 'REVIEW_REQUIRED']]) {
      const u = user(id); expected = validateSubmission(u, body());
      await service.submit(u, body());
      assert.equal((await service.refresh(u)).status, status);
    }
  } finally { service.close(); fs.rmSync(root, { recursive: true, force: true }); }
  assert.equal(identityMatches(null, {}), false);
});

test('background KYC status check binds only verified identity and never retransmits or checks blocked users', async () => {
  const root = dir(), u = user();
  let submitted = 0, lookups = 0, current = u;
  const service = createCardKyc({ dataDir: root, keyHex: crypto.randomBytes(32).toString('hex'),
    enabled: 'true', mode: 'live', getUser: () => current,
    readDocument: async () => ({ buffer: image }), detectExt: () => 'png',
    provider: { configured: true, submit: async () => { submitted++; return { ok: true }; },
      lookup: async () => { lookups++; return approved(validateSubmission(u, body())); } } });
  try {
    await service.submit(u, body());
    current = { ...u, banned: true };
    assert.equal(await service.runChecks(), 0); assert.equal(lookups, 0);
    current = u;
    await Promise.all([service.runChecks(), service.runChecks()]);
    assert.equal(service.status(u).status, 'APPROVED');
    assert.equal(lookups, 1); assert.equal(submitted, 1);
    assert.equal(await service.runChecks(), 0);
  } finally { service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('provider uses documented server-only query, discards POST ids, validates GET identity and sanitizes failures', async () => {
  const expected = validateSubmission(user(), body());
  const payload = { ...expected, id_front_image: image.toString('base64') };
  let calls = 0;
  const client = createKycProvider({ apiKey: 'synthetic-key-not-real', fetchImpl: async (url, options) => {
    calls++; const u = new URL(url);
    assert.equal(u.origin, 'https://www.ziiropay.com');
    assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
    assert.equal(u.searchParams.has('mode'), false);
    if (options.method === 'POST') {
      assert.equal(u.pathname, '/api/bitvcard/cardkyc');
      assert.ok(FIELDS.every((f) => u.searchParams.get(f) === payload[f]));
      assert.equal(u.searchParams.has('pin'), false);
      return json({ success: true, customer_id: 'untrusted-id' });
    }
    assert.equal(u.pathname, '/api/bitvcard/cardkycstatus');
    assert.equal(u.searchParams.get('email'), expected.email);
    return json({ success: true, data: { ...expected, status: 'approved', customer_id: 'verified-customer' } });
  } });
  assert.deepEqual(await client.submit(payload), { ok: true, code: 'SUBMISSION_RESPONSE_RECEIVED' });
  const found = await client.lookup(expected.email);
  assert.equal(found.identity.customer_id, 'verified-customer');
  assert.equal(found.approved, true); assert.equal(calls, 2);
  assert.equal((await client.submit({ ...payload, customer_id: 'forged' })).ok, false); assert.equal(calls, 2);
  for (const response of [
    () => json({ success: true, data: { ...expected, status: 'pending', customer_id: 'forged' } }),
    () => json({ success: true, data: { ...expected, status: 'approved', customer_id: 'bad id' } }),
    () => json({ success: true, data: { ...expected, status: 'approved', customer_id: 'valid-id', phone_number: 'invalid' } }),
    () => json({ success: false }), () => json({}, 401), () => new Response('<html>private</html>'),
    () => new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    () => json({ text: 'x'.repeat(17000) }),
    () => { throw new Error('URL with private key and document'); }
  ]) {
    const result = await createKycProvider({ apiKey: 'synthetic', fetchImpl: async () => response() }).lookup(expected.email);
    assert.notEqual(result.approved, true);
    assert.doesNotMatch(JSON.stringify(result), /private|synthetic|SYNTHETIC|@example/);
  }
  const bodyTimeout = createKycProvider({ apiKey: 'synthetic', timeoutMs: 10,
    fetchImpl: async (url, options) => {
      const stalled = new ReadableStream({ start(controller) {
        options.signal.addEventListener('abort', () => controller.error(new Error('private')));
      } });
      return new Response(stalled, { headers: { 'Content-Type': 'application/json' } });
    } });
  assert.equal((await bodyTimeout.lookup(expected.email)).code, 'PROVIDER_TIMEOUT');
  const connectionTimeout = createKycProvider({ apiKey: 'synthetic', timeoutMs: 5,
    fetchImpl: (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('private')))) });
  assert.equal((await connectionTimeout.lookup(expected.email)).code, 'PROVIDER_TIMEOUT');
});

test('actual app: JWT/PIN/consent enforced, encrypted approval survives restart, wallets untouched, no PII logs', { timeout: 25000 }, async () => {
  const root = dir(), secret = crypto.randomBytes(32).toString('hex'), keyHex = crypto.randomBytes(32).toString('hex');
  const u = user('customer'); u.pinHash = await bcrypt.hash(body().pin, 4);
  const other = user('other');
  fs.mkdirSync(path.join(root, 'kyc', u.id), { recursive: true });
  fs.writeFileSync(path.join(root, 'kyc', u.id, 'front.png'), image);
  fs.writeFileSync(path.join(root, 'users.json'), JSON.stringify([u, other]));
  const settings = JSON.stringify({ rate: 144, feeActive: false, deposit: { fixture: true } });
  fs.writeFileSync(path.join(root, 'settings.json'), settings);
  const countFile = path.join(root, 'fake-provider-counts.json');
  const socket = net.createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise((r) => socket.close(r));
  const base = 'http://127.0.0.1:' + port;
  let child, logs = '';
  async function start() {
    child = spawn(process.execPath, ['--require', './test/mock-ziiropay-kyc.cjs', 'server.js'], {
      cwd: path.join(__dirname, '..'), env: {
        ...process.env, NODE_ENV: 'test', PORT: String(port), DATA_DIR: root, JWT_SECRET: secret,
        SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', RESEND_API_KEY: '', NODE_OPTIONS: '',
        ADMIN_EMAIL: '', ADMIN_PASSWORD: '', TEST_USER_EMAIL: '', TEST2_USER_EMAIL: '',
        ZIIROPAY_API_KEY: 'synthetic-test-key', ZIIROPAY_CONNECTION_CHECK_ON_BOOT: 'false',
        ZIIROPAY_KYC_ENABLED: 'true', ZIIROPAY_KYC_MODE: 'live', ZIIROPAY_KYC_ENCRYPTION_KEY: keyHex,
        MOCK_KYC_CALLS_FILE: countFile
      }, stdio: ['ignore', 'pipe', 'pipe']
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (d) => { logs += d; });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/api/pin-hint')).ok) return; } catch {}
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('Fixture did not start');
  }
  async function stop() {
    if (child?.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); }
  }
  const headers = (id = u.id, ajax = true) => ({
    ...(id ? { cookie: 'token=' + jwt.sign({ sub: id, v: 0 }, secret) } : {}),
    'Content-Type': 'application/json', ...(ajax ? { 'X-Requested-With': 'XMLHttpRequest' } : {})
  });
  const submit = (b, h = headers()) => fetch(base + '/api/virtual-cards/kyc', { method: 'POST', headers: h, body: JSON.stringify(b) });
  try {
    await start();
    assert.equal((await submit(body(), headers(null))).status, 401);
    assert.equal((await submit(body(), headers(u.id, false))).status, 403);
    assert.equal((await submit({ ...body(), consent: false })).status, 400);
    assert.equal((await submit({ ...body(), pin: '000000' })).status, 403);
    assert.equal(fs.existsSync(countFile), false);
    const replies = await Promise.all([submit(body()), submit(body())]);
    assert.ok(replies.every((r) => r.status === 202));
    for (const r of replies) assert.notEqual((await r.json()).status, 'APPROVED');
    assert.equal(JSON.parse(fs.readFileSync(countFile)).submissions, 1);
    const refresh = await fetch(base + '/api/virtual-cards/kyc/refresh', { method: 'POST', headers: headers() });
    const publicStatus = await refresh.json();
    assert.equal(publicStatus.status, 'APPROVED');
    assert.doesNotMatch(JSON.stringify(publicStatus), /verified-provider-customer|SYNTHETIC-DOCUMENT|@example/);
    const otherStatus = await (await fetch(base + '/api/virtual-cards/kyc', { headers: headers(other.id) })).json();
    assert.equal(otherStatus.status, 'NOT_SUBMITTED');
    const malformed = await fetch(base + '/api/virtual-cards/kyc', { method: 'POST', headers: headers(), body: '{"SYNTHETIC-DOCUMENT-123":' });
    assert.equal(malformed.status, 400);
    assert.equal((await fetch(base + '/card-kyc.js')).status, 404);
    await stop(); await start();
    const restored = await (await fetch(base + '/api/virtual-cards/kyc', { headers: headers() })).json();
    assert.equal(restored.status, 'APPROVED');
    await submit(body());
    assert.deepEqual(JSON.parse(fs.readFileSync(countFile)), { submissions: 1, lookups: 1 });
    for (const value of JSON.parse(fs.readFileSync(path.join(root, 'users.json'), 'utf8'))) {
      assert.equal(value.balance, 100); assert.equal(value.usd, 50); assert.equal(value.kyc.status, 'approved');
    }
    assert.equal(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'), settings);
  } finally { await stop(); fs.rmSync(root, { recursive: true, force: true }); }
  assert.doesNotMatch(logs, /SYNTHETIC-DOCUMENT|@example|synthetic-test-key|verified-provider-customer/);
});
