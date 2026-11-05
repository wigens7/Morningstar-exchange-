'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

test('actual application: explicit activation, authorization/PIN, verified creation, refund, private reveal, kill/restart without duplicate financial POST', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-app-'));
  const secret = 'synthetic-local-jwt-secret';
  const pinHash = await bcrypt.hash('123456', 4);
  const users = ['admin', 'support', 'customer', 'rejected', 'unknown'].map((id) => ({
    id, role: ['admin', 'support'].includes(id) ? id : 'user', uid: id, name: 'Fixture Customer',
    email: id + '@example.test', emailVerifiedAt: '2026-01-01T00:00:00Z', emailVerificationRequired: true,
    profile: { firstName: 'Fixture', lastName: 'Customer' }, kyc: { status: 'approved', submittedAt: '2026-01-01' },
    pinActive: true, pinHash, usd: 100, balance: 200, swaps: [], notifs: []
  }));
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify(users));
  const preload = path.join(dir, 'provider-fake.cjs');
  fs.writeFileSync(preload, `
    const fs=require('node:fs'),path=require('node:path');const dir=process.env.DATA_DIR;
    global.fetch=async(input,init={})=>{
      const u=new URL(String(input));if(u.origin!=='https://www.ziiropay.com')throw Error('external requests disabled');
      const get=(id)=>JSON.parse(fs.readFileSync(path.join(dir,'users.json'),'utf8')).find(x=>x.id===id);
      if(u.pathname.endsWith('/cardkycstatus')){
        const user=JSON.parse(fs.readFileSync(path.join(dir,'users.json'),'utf8')).find(x=>x.email===u.searchParams.get('email'));
        return Response.json({success:true,data:{customer_id:'holder-'+user.id,status:'approved',first_name:user.profile.firstName,
          last_name:user.profile.lastName,email:user.email,phone_number:'12025550123',dial_code:'+1',country:'USA'}});
      }
      if(u.pathname.endsWith('/create-nfc-card')){
        if(init.method!=='POST'||u.searchParams.has('mode'))throw Error('incorrect method/mode');
        const cid=u.searchParams.get('customer_id');fs.appendFileSync(path.join(dir,'outbound.txt'),cid+'\\n');
        if(cid==='holder-rejected')return Response.json({success:false,errors:{amount:['Rejected fixture']}},{status:422});
        if(cid==='holder-unknown')return await new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(Error('fake timeout')),{once:true}));
        return Response.json({success:true,response:{card_id:'card-'+cid}});
      }
      if(u.pathname.endsWith('/fetch-nfccard-detail')){
        const cardId=u.searchParams.get('card_id'),cid=cardId.slice(5),user=get(cid.slice(7));
        return Response.json({success:true,response:{card_detail:{
          card_id:cardId,customer_id:cid,customer_email:user.email,card_holder_name:'Fixture Customer',
          card_type:'virtual',card_status:'active',card_brand:'visa',last4:'1111',expiry:'04/2029',
          balance:'3.00',reference:'REFERENCE_'+cardId,created_at:new Date().toISOString(),
          card_number:'1111111111111111',cvv:'000'
        }}});
      }
      throw Error('unexpected provider request');
    };
  `);
  const socket = net.createServer(); await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise((r) => socket.close(r));
  const base = 'http://127.0.0.1:' + port;
  let child, output = '';
  async function start(enabled = true) {
    child = spawn(process.execPath, ['--require', preload, path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, DATA_DIR: dir, PORT: String(port), JWT_SECRET: secret, NODE_ENV: 'test', NODE_OPTIONS: '',
        SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', RESEND_API_KEY: '', ADMIN_EMAIL: '', ADMIN_PASSWORD: '',
        TEST_USER_EMAIL: '', TEST2_USER_EMAIL: '', ZIIROPAY_API_KEY: 'synthetic-not-a-real-key',
        ZIIROPAY_CARD_MODE: 'live', ZIIROPAY_CARD_ISSUING_ENABLED: enabled ? 'true' : 'false',
        ZIIROPAY_CONNECTION_CHECK_ON_BOOT: 'false', ZIIROPAY_KYC_ENABLED: 'false', ZIIROPAY_SANDBOX_KYC_PROBE: 'false' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (x) => { output += x; }); child.stderr.on('data', (x) => { output += x; });
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(base + '/api/pin-hint', { signal: AbortSignal.timeout(500) })).status === 200) return; } catch {}
      await new Promise((r) => setTimeout(r, 40));
    }
    throw Error('local fixture server startup failed');
  }
  async function stop(signal = 'SIGTERM') {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise((r) => child.once('exit', r)); child.kill(signal); await done;
  }
  async function call(url, id, body, extra = {}) {
    const headers = { ...(id ? { Cookie: 'token=' + jwt.sign({ sub: id, v: 0 }, secret, { expiresIn: '1h' }) } : {}),
      ...(body ? { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' } : {}), ...(extra.headers || {}) };
    const r = await fetch(base + url, { method: body ? 'POST' : 'GET', ...extra, headers,
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
    return { status: r.status, headers: r.headers, data: await r.json().catch(() => ({})) };
  }
  const wallet = (id) => JSON.parse(fs.readFileSync(path.join(dir, 'users.json'))).find((u) => u.id === id);
  async function bind(id) {
    const result = await call('/api/admin/users/' + id + '/cardholder', 'admin', { customerId: 'holder-' + id, revision: null });
    assert.equal(result.status, 200);
  }
  async function order(id) {
    const q = await call('/api/virtual-cards/quote', id, { initialFundingUSD: '3.00' });
    assert.equal(q.status, 200); assert.equal(q.data.totalUSD, '8.00');
    return { quoteId: q.data.id, requestKey: crypto.randomUUID(), acceptedTotalUSD: q.data.totalUSD, consent: true, pin: '123456' };
  }
  try {
    await start(false);
    assert.equal((await call('/virtual-card.html')).status, 401);
    assert.equal((await call('/api/virtual-cards/orders')).status, 401);
    assert.equal((await call('/api/admin/virtual-cards/orders?userId=customer', 'support')).status, 403);
    assert.equal((await call('/api/virtual-cards/quote', 'customer', { initialFundingUSD: '3.00' })).status, 503);
    assert.equal((await call('/api/admin/virtual-cards/settings', 'admin', { creationPriceUSD: '5.00', revision: null })).status, 200);
    for (const id of ['customer', 'rejected', 'unknown']) await bind(id);
    await stop(); await start(true);
    const page = await call('/virtual-card.html', 'customer');
    assert.equal(page.status, 200); assert.match(page.headers.get('Content-Security-Policy'), /default-src 'none'/);
    const setup = await call('/api/virtual-cards/setup', 'customer');
    assert.equal(setup.data.cardOperationsEnabled, true); assert.equal(setup.data.withdrawalEnabled, false);
    assert.equal((await call('/api/admin/virtual-cards/readiness', 'admin')).data.cardIssuanceEnabled, true);
    const input = await order('customer');
    assert.equal((await call('/api/virtual-cards/orders', 'customer', { ...input, pin: '000000' })).status, 403);
    assert.equal((await call('/api/virtual-cards/orders', 'customer', { ...input, customer_id: 'other' })).status, 400);
    assert.equal((await call('/api/virtual-cards/orders', 'customer', input, { headers: { 'X-Requested-With': '' } })).status, 403);
    const result = await call('/api/virtual-cards/orders', 'customer', input);
    assert.equal(result.status, 200); assert.equal(result.data.state, 'READY');
    const id = result.data.id;
    await call('/api/virtual-cards/orders', 'customer', input);
    assert.equal(wallet('customer').usd, 92); assert.equal(wallet('customer').balance, 200);
    assert.equal((await call('/api/virtual-cards/orders/' + id + '/reveal', 'rejected', { pin: '123456' })).status, 404);
    const revealed = await call('/api/virtual-cards/orders/' + id + '/reveal', 'customer', { pin: '123456' });
    assert.equal(revealed.status, 200); assert.equal(revealed.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(revealed.data.expiresInSeconds, 30);
    assert.equal(JSON.stringify((await call('/api/virtual-cards/orders', 'customer')).data).includes('number'), false);
    assert.equal((await call('/api/virtual-cards/orders', 'rejected', await order('rejected'))).data.state, 'FAILED');
    assert.equal(wallet('rejected').usd, 100);
    const pendingInput = await order('unknown');
    const inFlight = call('/api/virtual-cards/orders', 'unknown', pendingInput).catch(() => null);
    for (let i = 0; i < 100; i++) {
      if (fs.readFileSync(path.join(dir, 'outbound.txt'), 'utf8').includes('holder-unknown')) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(wallet('unknown').usd, 92);
    await stop('SIGKILL'); await inFlight; await start(true);
    assert.equal((await call('/api/virtual-cards/orders', 'unknown')).data.orders[0].state, 'REVIEW');
    assert.equal((await call('/api/virtual-cards/orders', 'unknown', pendingInput)).data.state, 'REVIEW');
    const counts = fs.readFileSync(path.join(dir, 'outbound.txt'), 'utf8').trim().split('\n');
    for (const id of ['customer', 'rejected', 'unknown']) assert.equal(counts.filter((x) => x === 'holder-' + id).length, 1);
    const pending = (await call('/api/virtual-cards/orders', 'unknown')).data.orders[0];
    assert.equal((await call('/api/admin/virtual-cards/orders/' + pending.id + '/refund', 'admin',
      { confirmation: 'wrong', pin: '123456' })).status, 400);
    const release = await call('/api/admin/virtual-cards/orders/' + pending.id + '/refund', 'admin',
      { confirmation: 'CONFIRMED_NO_CARD_IN_ZIIROPAY', pin: '123456' });
    assert.equal(release.data.state, 'FAILED'); assert.equal(wallet('unknown').usd, 100);
    const db = new DatabaseSync(path.join(dir, 'p2p.sqlite'));
    assert.equal(db.prepare("SELECT count(*) n FROM email_outbox WHERE event_type='CARD_CREATED'").get().n, 1); db.close();
    const ledger = new DatabaseSync(path.join(dir, 'virtual-card-orders.sqlite'));
    const serialized = JSON.stringify(ledger.prepare('SELECT * FROM card_orders').all()); ledger.close();
    assert.equal(serialized.includes('1111111111111111'), false);
    assert.equal(output.includes('synthetic-not-a-real-key'), false); assert.equal(output.includes('1111111111111111'), false);
  } finally { await stop('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
});
