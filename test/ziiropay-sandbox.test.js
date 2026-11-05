'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { runSandboxKycProbe, shapeOf } = require('../ziiropay-sandbox-probe');
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ziiro-sandbox-'));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const opts = (dataDir, fetchImpl) => ({ dataDir, enabled: 'approved-v1', apiKey: 'synthetic-key', fetchImpl, log() {} });

test('sandbox probe off unless exact approval, no customer input or missing persistence/key', async () => {
  const dir = root(); let calls = 0;
  const options = opts(dir, async () => { calls++; assert.fail('No request'); });
  try {
    for (const enabled of ['false', 'true', '', 'sandbox', true]) assert.equal(await runSandboxKycProbe({ ...options, enabled }), null);
    assert.equal((await runSandboxKycProbe({ ...options, dataDir: 'relative' })).requestCount, 0);
    assert.equal((await runSandboxKycProbe({ ...options, apiKey: '' })).requestCount, 0);
    assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('exactly one documented sandbox POST with synthetic fixtures; raw response and IDs never stored/logged', async () => {
  const dir = root(), logs = []; let calls = 0;
  try {
    const options = { ...opts(dir, async (url, init) => {
      calls++; const u = new URL(url);
      assert.equal(u.origin, 'https://www.ziiropay.com');
      assert.equal(u.pathname, '/api/bitvcard/cardkyc');
      assert.equal(u.searchParams.get('mode'), 'sandbox');
      assert.match(u.searchParams.get('email'), /^morningstar-sandbox-.*@example\.test$/);
      assert.equal(u.searchParams.get('id_number'), 'TESTONLY-NOT-A-REAL-DOCUMENT');
      assert.equal(u.searchParams.get('phone_number'), '12025550123');
      const image = Buffer.from(u.searchParams.get('id_front_image'), 'base64');
      assert.equal(image.subarray(1, 4).toString(), 'PNG');
      assert.equal(image.readUInt32BE(16), 320); assert.equal(image.readUInt32BE(20), 200);
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.body, undefined);
      const marker = JSON.parse(fs.readFileSync(path.join(dir, 'ziiropay-sandbox', 'kyc-attempt-v1.json'), 'utf8'));
      assert.equal(marker.phase, 'STARTED', 'durable intent before outgoing request');
      return json({ success: true, message: 'private echo synthetic-key', customer_id: 'private-id',
        data: { customer_id: 'private-id' }, 'private-id-as-key': 'not output' });
    }), log: (s) => logs.push(s) };
    const result = await runSandboxKycProbe(options);
    assert.equal(result.code, 'SANDBOX_RESPONSE_SUCCESS_NOT_KYC_APPROVAL');
    assert.equal(result.successFlag, true);
    assert.equal(result.shape['data.customer_id'], 'string');
    const repeated = await Promise.all([runSandboxKycProbe(options), runSandboxKycProbe(options)]);
    assert.ok(repeated.every((r) => r.requestCount === 0)); assert.equal(calls, 1);
    const record = fs.readFileSync(path.join(dir, 'ziiropay-sandbox', 'kyc-attempt-v1.json'), 'utf8');
    assert.doesNotMatch(record + logs.join(''), /synthetic-key|private-id|@example|TESTONLY|12025550123|public_key/);
    assert.equal(fs.statSync(path.join(dir, 'ziiropay-sandbox', 'kyc-attempt-v1.json')).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent startup and a crashed STARTED marker never repeat the sandbox POST', async () => {
  const dir = root(); let calls = 0;
  try {
    const options = opts(dir, async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return json({ name: 'private' }); });
    await Promise.all([runSandboxKycProbe(options), runSandboxKycProbe(options), runSandboxKycProbe(options)]);
    assert.equal(calls, 1);
    fs.writeFileSync(path.join(dir, 'ziiropay-sandbox', 'kyc-attempt-v1.json'), '{"phase":"STARTED"}');
    assert.equal((await runSandboxKycProbe(options)).requestCount, 0); assert.equal(calls, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sandbox validation/auth/schema failures expose only safe classifications and known field names', async () => {
  for (const [response, expected] of [
    [() => json({ success: false, errors: { id_front_image: ['private image'], 'secret-as-key': 'private' } }, 422), 'SANDBOX_VALIDATION_REJECTED'],
    [() => json({ error: 'private secret' }, 401), 'SANDBOX_AUTH_REJECTED'],
    [() => json({}, 429), 'SANDBOX_RATE_LIMITED'],
    [() => json({}, 503), 'SANDBOX_UPSTREAM_ERROR'],
    [() => new Response('private', { status: 414 }), 'SANDBOX_URI_TOO_LONG'],
    [() => new Response('private HTML'), 'SANDBOX_NON_JSON_RESPONSE'],
    [() => new Response('{', { headers: { 'Content-Type': 'application/json' } }), 'SANDBOX_INVALID_JSON'],
    [() => json({ text: 'x'.repeat(34000) }), 'SANDBOX_RESPONSE_TOO_LARGE'],
    [() => json({ success: false }), 'SANDBOX_REQUEST_REJECTED'],
    [() => json({ name: 'private' }), 'SANDBOX_RESPONSE_RECEIVED_UNVERIFIED'],
    [() => { throw new Error('private credential URL'); }, 'SANDBOX_NETWORK_ERROR_NO_RETRY']
  ]) {
    const dir = root();
    try {
      const result = await runSandboxKycProbe(opts(dir, async () => response()));
      assert.equal(result.code, expected);
      assert.doesNotMatch(JSON.stringify(result), /private|secret-as-key|synthetic-key/);
      if (expected === 'SANDBOX_VALIDATION_REJECTED') assert.deepEqual(result.validationFields, ['id_front_image']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  assert.deepEqual(shapeOf({ 'secret-as-key': 'private', message: 'private' }), { message: 'string' });
});

test('sandbox timeout covers request and response stream, persists outcome, never retries', async () => {
  for (const stallBody of [false, true]) {
    const dir = root(); let calls = 0;
    try {
      const options = { ...opts(dir, async (url, init) => {
        calls++;
        if (!stallBody) return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('private'))));
        return new Response(new ReadableStream({ start(controller) {
          init.signal.addEventListener('abort', () => controller.error(new Error('private')));
        } }), { headers: { 'Content-Type': 'application/json' } });
      }), timeoutMs: 5 };
      assert.equal((await runSandboxKycProbe(options)).code, 'SANDBOX_TIMEOUT_NO_RETRY');
      assert.equal((await runSandboxKycProbe(options)).requestCount, 0); assert.equal(calls, 1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('actual server sandbox boot sends once with fake network, preserves wallets and survives restart without another request', { timeout: 15000 }, async () => {
  const dir = root(), counts = path.join(dir, 'counts.json'), preload = path.join(dir, 'fake-network.cjs');
  const users = [{ id: 'fixture-user', role: 'user', email: 'fixture@example.test', name: 'Fixture User',
    usd: 20, balance: 1000, kyc: { status: 'approved' }, swaps: [], tokenVersion: 0 }];
  const settings = JSON.stringify({ rate: 140, feeActive: false });
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(users));
  fs.writeFileSync(path.join(dir, 'settings.json'), settings);
  fs.writeFileSync(preload, `const fs=require('node:fs');
globalThis.fetch=async(url,init)=>{
 const u=new URL(url);
 if(u.origin!=='https://www.ziiropay.com'||u.pathname!=='/api/bitvcard/cardkyc'||u.searchParams.get('mode')!=='sandbox'||init.method!=='POST')throw new Error('TEST_NETWORK_BLOCKED');
 const file=process.env.PROBE_TEST_COUNT_FILE;
 const count=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).count:0;
 fs.writeFileSync(file,JSON.stringify({count:count+1}));
 return new Response(JSON.stringify({success:true,data:{customer_id:'SYNTHETIC_PRIVATE_ID'},message:'synthetic-key'}),{headers:{'Content-Type':'application/json'}});
};`);
  const socket = net.createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  let child, logs = '';
  async function start() {
    child = spawn(process.execPath, ['--require', preload, 'server.js'], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, NODE_ENV: 'test', DATA_DIR: dir, PORT: String(port),
        JWT_SECRET: 'local-test-jwt', NODE_OPTIONS: '', SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '',
        RESEND_API_KEY: '', ADMIN_EMAIL: '', ADMIN_PASSWORD: '', TEST_USER_EMAIL: '', TEST2_USER_EMAIL: '',
        ZIIROPAY_API_KEY: 'synthetic-key', ZIIROPAY_WEBHOOK_SECRET: '', ZIIROPAY_CONNECTION_CHECK_ON_BOOT: 'false',
        ZIIROPAY_KYC_ENABLED: 'false', ZIIROPAY_SANDBOX_KYC_PROBE: 'approved-v1', PROBE_TEST_COUNT_FILE: counts },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (b) => { logs += b; }); child.stderr.on('data', (b) => { logs += b; });
    for (let i = 0; i < 160; i++) {
      try { if ((await fetch('http://127.0.0.1:' + port + '/api/pin-hint')).status === 200) return; } catch {}
      if (child.exitCode !== null) assert.fail('Fixture server exited');
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.fail('Fixture server did not start');
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGTERM'); });
    }
  }
  try {
    await start(); await stop();
    assert.equal(JSON.parse(fs.readFileSync(counts)).count, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'ziiropay-sandbox', 'kyc-attempt-v1.json'))).phase, 'FINISHED');
    await start(); await stop();
    assert.equal(JSON.parse(fs.readFileSync(counts)).count, 1);
    assert.match(logs, /SANDBOX_RESPONSE_SUCCESS_NOT_KYC_APPROVAL/);
    assert.match(logs, /SANDBOX_ALREADY_ATTEMPTED_NO_RETRY/);
    assert.doesNotMatch(logs, /SYNTHETIC_PRIVATE_ID|synthetic-key|TESTONLY-NOT|fixture@example/);
    const user = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'))).find((u) => u.id === 'fixture-user');
    assert.equal(user.usd, 20); assert.equal(user.balance, 1000); assert.deepEqual(user.swaps, []);
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), settings);
  } finally { await stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});
