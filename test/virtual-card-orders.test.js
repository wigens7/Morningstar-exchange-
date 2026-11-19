'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createStore, fileBackend } = require('../userstore');
const { createCardSettings } = require('../virtual-card-setup');
const { createCardWallet } = require('../card-wallet');
const { createCardOrders } = require('../virtual-card-orders');
const { createCardProvider } = require('../ziiropay-cards');
const { notificationEmail } = require('../email-templates');
const admin = { id: 'admin', role: 'admin' };
const client = { id: 'customer', role: 'user', usd: 100, balance: 200, email: 'fixture@example.test',
  kyc: { status: 'approved' }, profile: { firstName: 'Fixture', lastName: 'Customer' } };
const cid = 'customer-provider-fixture';
const cardId = 'card-provider-fixture';
const normIdentity = () => ({ customer_id: cid, email: client.email, first_name: 'Fixture', last_name: 'Customer' });
async function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-orders-'));
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([admin, client]));
  const store = createStore({ backend: fileBackend(path.join(dir, 'users.json')) });
  await store.init();
  const settings = createCardSettings(dir); settings.save('5.00', null);
  let calls = 0, notices = 0;
  const binding = { cardholderApproved: true, customerId: cid, revision: crypto.randomUUID() };
  const card = { cardId, customerId: cid, email: client.email, holder: 'Fixture Customer',
    last4: '1111', expiry: '04/2029', brand: 'visa', status: 'active', balanceCents: 300,
    reference: 'CARD_FIXTURE_123', createdAt: new Date().toISOString() };
  const provider = { configured: true, mode: 'live',
    async create() { calls++; return { ok: true, candidateId: cardId }; },
    async details() { return { ok: true, card: structuredClone(card) }; } };
  const wallet = createCardWallet(store);
  const opts = { dataDir: dir, enabled: true, getUser: store.getUser, getBinding: () => binding, settings, wallet, provider,
    kycProvider: { configured: true, async lookup() { return { ok: true, approved: true, identity: normIdentity() }; } },
    notifyOutcome: async () => { notices++; return true; }, ...options };
  let service = createCardOrders(opts);
  return { dir, store, settings, opts, provider, wallet, binding, card,
    get service() { return service; }, calls: () => calls, notices: () => notices,
    request() { return { quoteId: service.quote('customer', '3.00').id, requestKey: crypto.randomUUID(),
      acceptedTotalUSD: '8.00', consent: true }; },
    restart() { service.close(); service = createCardOrders(opts); return service; },
    close() { service.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const checkError = (fn, code) => assert.throws(fn, (e) => e.code === code);
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code);

test('quote is server-priced, expires and rejects disabled/unverified/invalid/insufficient requests before any provider POST', async () => {
  const f = await fixture();
  try {
    for (const value of ['-1', '1e2', 3, '0.001', '9999999', 'NaN']) checkError(() => f.service.quote('customer', value), 'CARD_INVALID_REQUEST');
    assert.equal(f.service.quote('customer', '3').totalUSD, '8.00');
    checkError(() => f.service.quote('customer', '100'), 'CARD_INSUFFICIENT');
    f.binding.cardholderApproved = false;
    checkError(() => f.service.quote('customer', '3'), 'CARD_NOT_ELIGIBLE');
    f.binding.cardholderApproved = true;
    const request = f.request();
    await rejects(f.service.create('customer', { ...request, consent: false }), 'CARD_INVALID_REQUEST');
    await rejects(f.service.create('customer', { ...request, acceptedTotalUSD: '7.99' }), 'CARD_STALE_QUOTE');
    const expired = createCardOrders({ ...f.opts, now: () => Date.now() + 240000 });
    await rejects(expired.create('customer', request), 'CARD_STALE_QUOTE'); expired.close();
    const revision = f.settings.read().revision; f.settings.save('7.00', revision);
    await rejects(f.service.create('customer', request), 'CARD_STALE_QUOTE');
    const off = createCardOrders({ ...f.opts, enabled: false });
    checkError(() => off.quote('customer', '3'), 'CARD_DISABLED'); off.close();
    assert.equal(f.calls(), 0); assert.equal(f.store.getUser('customer').usd, 100);
  } finally { f.close(); }
});

test('one verified issuance reserves once, settles without another debit, suppresses double click and survives restart', async () => {
  const f = await fixture();
  try {
    const request = f.request();
    const [a] = await Promise.all([f.service.create('customer', request), f.service.create('customer', request)]);
    assert.equal(a.state, 'READY'); assert.equal(a.totalUSD, '8.00'); assert.equal(a.card.last4, '1111');
    assert.equal(f.calls(), 1); assert.equal(f.notices(), 1);
    assert.equal(f.store.getUser('customer').usd, 92); assert.equal(f.store.getUser('customer').balance, 200);
    const record = f.store.getUser('customer').cardPayments[a.id];
    assert.equal(record.state, 'SETTLED'); assert.equal(record.amountCents, 800);
    assert.equal((await f.service.create('customer', request)).state, 'READY');
    const another = f.request(); assert.equal((await f.service.create('customer', another)).id, a.id);
    f.restart(); await f.service.recover();
    assert.equal(f.service.current('customer').orders[0].state, 'READY');
    assert.equal(f.calls(), 1); assert.equal(f.store.getUser('customer').usd, 92); assert.equal(f.notices(), 1);
    const serialized = JSON.stringify(f.service.current('customer'));
    assert.equal(serialized.includes(cid), false); assert.equal(serialized.includes(cardId), false);
    assert.equal(fs.statSync(path.join(f.dir, 'virtual-card-orders.sqlite')).mode & 0o777, 0o600);
  } finally { f.close(); }
});

test('definitive provider rejection refunds the sole reservation; replay and admin release cannot refund twice', async () => {
  const f = await fixture();
  try {
    f.provider.create = async () => ({ ok: false, rejected: true });
    const request = f.request(), result = await f.service.create('customer', request);
    assert.equal(result.state, 'FAILED'); assert.equal(f.store.getUser('customer').usd, 100);
    assert.equal(f.store.getUser('customer').cardPayments[result.id].state, 'REFUNDED');
    await f.service.create('customer', request);
    await f.service.release(admin, result.id, 'CONFIRMED_NO_CARD_IN_ZIIROPAY');
    assert.equal(f.store.getUser('customer').usd, 100);
  } finally { f.close(); }
});

test('ambiguous timeout is durable review, never resends POST after retry/restart; independent admin GET settles once', async () => {
  const f = await fixture();
  try {
    let calls = 0; f.provider.create = async () => { calls++; return { ok: false }; };
    const request = f.request(), result = await f.service.create('customer', request);
    assert.equal(result.state, 'REVIEW'); assert.equal(result.card, null); assert.equal(f.store.getUser('customer').usd, 92);
    await f.service.create('customer', request); f.restart(); await f.service.recover();
    assert.equal(calls, 1);
    await rejects(f.service.reconcile({ id: 'admin', role: 'support' }, result.id, cardId), 'CARD_NOT_ELIGIBLE');
    const finished = await f.service.reconcile(admin, result.id, cardId);
    assert.equal(finished.state, 'READY');
    assert.equal(f.store.getUser('customer').usd, 92); assert.equal(calls, 1);
    await rejects(f.service.release(admin, result.id, 'CONFIRMED_NO_CARD_IN_ZIIROPAY'), 'CARD_NOT_FOUND');
  } finally { f.close(); }
});

test('wrong owner/email/name/card status/initial funding/time never finalizes payment or exposes a card', async () => {
  for (const patch of [{ customerId: 'wrong-customer' }, { email: 'wrong@example.test' }, { holder: 'Other Person' },
    { status: 'frozen' }, { balanceCents: 299 }, { expiry: '04/2020' },
    { createdAt: '2020-01-01T00:00:00Z' }, { cardId: 'wrong-card-id' }]) {
    const f = await fixture();
    try {
      Object.assign(f.card, patch);
      const result = await f.service.create('customer', f.request());
      assert.equal(result.state, 'REVIEW'); assert.equal(result.card, null);
      assert.equal(f.store.getUser('customer').cardPayments[result.id].state, 'HELD');
      await rejects(f.service.reconcile(admin, result.id, cardId), 'CARD_REVIEW_REQUIRED');
      await f.service.release(admin, result.id, 'CONFIRMED_NO_CARD_IN_ZIIROPAY');
      assert.equal(f.store.getUser('customer').usd, 100);
    } finally { f.close(); }
  }
});

test('account changes after KYC await cannot initiate a provider POST', async () => {
  const f = await fixture();
  try {
    f.opts.kycProvider.lookup = async () => {
      const users = f.store.loadUsers(); users.find((u) => u.id === 'customer').profile.lastName = 'Changed';
      await f.store.saveUsers(users);
      return { ok: true, approved: true, identity: normIdentity() };
    };
    const result = await f.service.create('customer', f.request());
    assert.equal(result.state, 'FAILED'); assert.equal(f.calls(), 0); assert.equal(f.store.getUser('customer').usd, 100);
  } finally { f.close(); }
});

test('account changes during reservation ACK are refunded before the irreversible marker and never issue a card', async () => {
  const f = await fixture();
  try {
    // Capture an independent wallet method before replacing the injected one.
    f.opts.wallet.reserve = ((original) => async (op, guard) => {
      await original(op, guard);
      const users = f.store.loadUsers(); users.find((u) => u.id === 'customer').profile.lastName = 'Changed';
      await f.store.saveUsers(users);
    })(createCardWallet(f.store).reserve);
    const result = await f.service.create('customer', f.request());
    assert.equal(result.state, 'FAILED'); assert.equal(f.calls(), 0); assert.equal(f.store.getUser('customer').usd, 100);
  } finally { f.close(); }
});

test('wallet write with lost ACK is independently confirmed and never debited/refunded twice', async () => {
  const f = await fixture();
  try {
    let lost = true;
    const store = { ...f.store, saveUsers: async (users) => {
      await f.store.saveUsers(users); if (lost) { lost = false; throw new Error('fake lost acknowledgement'); }
    } };
    const wallet = createCardWallet(store);
    const op = { id: crypto.randomUUID(), user_id: 'customer', total_cents: 800 };
    assert.equal(await wallet.reserve(op), 'HELD');
    assert.equal(await wallet.reserve(op), 'HELD');
    assert.equal(f.store.getUser('customer').usd, 92);
    assert.equal(await wallet.refund(op), 'REFUNDED');
    assert.equal(await wallet.refund(op), 'REFUNDED');
    assert.equal(f.store.getUser('customer').usd, 100);
    await rejects(wallet.settle(op), 'CARD_WALLET_UNCERTAIN');
    await rejects(wallet.reserve({ ...op, id: crypto.randomUUID(), total_cents: -1 }), 'CARD_WALLET_UNCERTAIN');
  } finally { f.close(); }
});

test('a crash before the irreversible marker refunds after recovery; a post-marker crash never resends/refunds automatically', async () => {
  for (const sent of [false, true]) {
    const f = await fixture();
    try {
      f.provider.create = async () => ({ ok: false });
      const result = await f.service.create('customer', f.request());
      f.service.close();
      const db = new DatabaseSync(path.join(f.dir, 'virtual-card-orders.sqlite'));
      db.prepare('UPDATE card_orders SET state=?,attempt_started_at=? WHERE id=?')
        .run(sent ? 'SUBMITTING' : 'RESERVING', sent ? Date.now() : null, result.id); db.close();
      f.restart(); await f.service.recover();
      assert.equal(f.service.current('customer').orders[0].state, sent ? 'REVIEW' : 'FAILED');
      assert.equal(f.store.getUser('customer').usd, sent ? 92 : 100);
    } finally { f.close(); }
  }
});

test('private reveal is owner-bound and only available after independent verification/settlement', async () => {
  const f = await fixture();
  try {
    const result = await f.service.create('customer', f.request());
    await rejects(f.service.reveal('other', result.id), 'CARD_NOT_FOUND');
    await rejects(f.service.reveal('customer', result.id), 'CARD_REVEAL_UNAVAILABLE');
    const secret = { number: '1111111111111111', cvv: '000' }; // synthetic only
    Object.assign(f.card, secret);
    f.binding.revision = crypto.randomUUID(); // same identity reverified by admin
    const revealed = await f.service.reveal('customer', result.id);
    assert.equal(revealed.expiresInSeconds, 30);
    assert.equal(JSON.stringify(f.service.current('customer')).includes(secret.number), false);
    const db = new DatabaseSync(path.join(f.dir, 'virtual-card-orders.sqlite'));
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM card_orders').all()).includes(secret.number), false); db.close();
  } finally { f.close(); }
});

test('provider adapter uses documented fixed endpoints, bounds response, discards secrets and never retries financial POST', async () => {
  const calls = [];
  const raw = { card_id: cardId, customer_id: cid, card_holder_name: 'Fixture Customer', customer_email: client.email,
    last4: '1111', expiry: '04/2029', balance: '3.00', reference: 'CARD_FIXTURE_123', created_at: new Date().toISOString(),
    card_type: 'virtual', card_brand: 'visa', card_status: 'active',
    card_number: '1111111111111111', cvv: '000', card_number_url: 'https://example.test/private-token' };
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return Response.json(init.method === 'POST' ? { success: true, response: { card_id: cardId } }
      : { success: true, response: { card_detail: raw } });
  };
  const p = createCardProvider({ apiKey: 'synthetic-not-a-key', mode: 'sandbox', fetchImpl });
  assert.equal((await p.create({ customerId: cid, name: 'Fixture Customer', fundingCents: 300 })).candidateId, cardId);
  const detail = await p.details(cardId);
  assert.equal(detail.ok, true); assert.equal('number' in detail.card, false); assert.equal('cvv' in detail.card, false);
  assert.equal(JSON.stringify(detail).includes('private-token'), false);
  assert.equal((await p.details(cardId, true)).card.number, raw.card_number);
  for (const call of calls) {
    assert.equal(call.url.origin, 'https://www.ziiropay.com'); assert.equal(call.url.searchParams.get('mode'), 'sandbox');
    assert.equal(call.init.redirect, 'error'); assert.equal(call.init.cache, 'no-store');
  }
  let attempts = 0;
  const timeout = createCardProvider({ apiKey: 'synthetic', fetchImpl: async () => { attempts++; throw Error('contains fake secret URL'); } });
  const result = await timeout.create({ customerId: cid, name: 'Fixture Customer', fundingCents: 300 });
  assert.deepEqual(result, { ok: false, code: 'CARD_PROVIDER_UNCERTAIN' }); assert.equal(attempts, 1);
  const reject = createCardProvider({ apiKey: 'synthetic', fetchImpl: async () => Response.json({ success: false, errors: { amount: ['Invalid'] } }, { status: 422 }) });
  assert.equal((await reject.create({ customerId: cid, name: 'Fixture Customer', fundingCents: 300 })).rejected, true);
  const unknown = createCardProvider({ apiKey: 'synthetic', fetchImpl: async () => Response.json({ success: true, data: {} }) });
  assert.equal((await unknown.create({ customerId: cid, name: 'Fixture Customer', fundingCents: 300 })).ok, false);
  const contradictory = createCardProvider({ apiKey: 'synthetic', fetchImpl: async () =>
    Response.json({ success: false, errors: { amount: ['Invalid'] }, card_id: cardId }, { status: 422 }) });
  assert.notEqual((await contradictory.create({ customerId: cid, name: 'Fixture Customer', fundingCents: 300 })).rejected, true);
  const wrongMode = createCardProvider({ apiKey: 'synthetic', mode: 'live', fetchImpl: async () =>
    Response.json({ success: true, response: { card_detail: { ...raw, mode: 'sandbox' } } }) });
  assert.equal((await wrongMode.details(cardId)).ok, false);
});

test('card emails remain Creole and distinguish verified creation from refunded failure', () => {
  for (const locale of ['ht', 'fr', 'en', 'es']) {
    const ready = notificationEmail({ eventType: 'CARD_CREATED', locale });
    const failed = notificationEmail({ eventType: 'CARD_ISSUE_FAILED', locale });
    assert.match(ready.text, /yon sèl peman final/); assert.match(failed.text, /pa gen debi final/);
    assert.doesNotMatch(failed.text, /Kat vityèl ou kreye/);
  }
});

test('one-click createNow needs no PIN/quote input, funds $5 plus the fee and rejects insufficient USD', async () => {
  client.usd = 9;
  const f = await fixture();
  client.usd = 100;
  try {
    await assert.rejects(f.service.createNow('customer'), (e) => e.code === 'CARD_INSUFFICIENT');
    assert.equal(f.calls(), 0);
  } finally { f.close(); }
  const g = await fixture();
  try {
    g.card.balanceCents = 500;
    const r = await g.service.createNow('customer');
    assert.equal(r.state, 'READY'); assert.equal(r.totalUSD, '10.00'); assert.equal(r.initialFundingUSD, '5.00'); assert.equal(g.calls(), 1);
  } finally { g.close(); }
});

test('admin retry re-sends the provider POST for a REVIEW order with no card, reusing the reservation', async () => {
  const f = await fixture();
  try {
    let n = 0;
    f.provider.create = async () => { f.calls; n++; return n === 1 ? { ok: false, code: 'CARD_PROVIDER_UNCERTAIN' } : { ok: true, candidateId: cardId }; };
    const result = await f.service.create('customer', f.request());
    assert.equal(result.state, 'REVIEW');
    await rejects(f.service.retry({ id: 'admin', role: 'support' }, result.id, 'CONFIRMED_NO_CARD_IN_ZIIROPAY'), 'CARD_NOT_ELIGIBLE');
    const done = await f.service.retry(admin, result.id, 'CONFIRMED_NO_CARD_IN_ZIIROPAY');
    assert.equal(done.state, 'READY'); assert.equal(n, 2);
    assert.equal(f.store.getUser('customer').usd, 92);
    await rejects(f.service.retry(admin, result.id, 'CONFIRMED_NO_CARD_IN_ZIIROPAY'), 'CARD_NOT_FOUND');
  } finally { f.close(); }
});

test('provider out of funds keeps the order pending (no refund, no review) until admin Retry creates the card', async () => {
  const f = await fixture();
  try {
    let n = 0;
    f.provider.create = async () => { n++; return n === 1 ? { ok: false, awaitingFunds: true, code: 'CARD_PROVIDER_FUNDS' } : { ok: true, candidateId: cardId }; };
    const r = await f.service.create('customer', f.request());
    assert.equal(r.state, 'PENDING'); assert.equal(r.code, 'PROVIDER_FUNDS');
    assert.doesNotMatch(r.message, /verifikasyon admin/);
    await f.service.recover();
    assert.equal(f.service.adminList(admin, 'customer').orders[0].code, 'PROVIDER_FUNDS');
    const done = await f.service.retry(admin, r.id, 'CONFIRMED_NO_CARD_IN_ZIIROPAY');
    assert.equal(done.state, 'READY'); assert.equal(n, 2);
  } finally { f.close(); }
});

test('provider adapter maps "Insufficient funds" (any shape/status <500) to awaitingFunds, never rejected', async () => {
  for (const [status, body] of [[200, { success: false, message: 'Insufficient funds' }],
    [400, { success: false, error: 'Insufficient funds' }], [422, { success: false, errors: { balance: ['Insufficient funds'] } }],
    [402, { success: false }]]) {
    const p = createCardProvider({ apiKey: 'synthetic-not-a-key', mode: 'live', fetchImpl: async () => Response.json(body, { status }) });
    const r = await p.create({ customerId: cid, name: 'Fixture Customer', fundingCents: 500 });
    assert.deepEqual([r.ok, r.awaitingFunds, r.rejected], [false, true, undefined], status + JSON.stringify(body));
  }
  const p = createCardProvider({ apiKey: 'synthetic-not-a-key', mode: 'live', fetchImpl: async () => Response.json({ success: false, message: 'Insufficient funds' }, { status: 503 }) });
  assert.equal((await p.create({ customerId: cid, name: 'Fixture Customer', fundingCents: 500 })).awaitingFunds, undefined);
});

test('bulk cancel refunds unfinished orders (no provider card) once and is admin-only', async () => {
  const f = await fixture({ provider: { configured: true, mode: 'live', async create() { return { awaitingFunds: true }; },
    async details() { return { ok: false }; } } });
  try {
    assert.equal((await f.service.create('customer', f.request())).code, 'PROVIDER_FUNDS');
    assert.equal(f.store.getUser('customer').usd, 92);
    await rejects(f.service.releaseAwaiting({ id: 'customer', role: 'user' }), 'CARD_NOT_ELIGIBLE');
    assert.deepEqual(await f.service.releaseAwaiting(admin), { refunded: 1, skipped: 0, failed: 0 });
    assert.equal(f.store.getUser('customer').usd, 100);
    assert.deepEqual(await f.service.releaseAwaiting(admin), { refunded: 0, skipped: 0, failed: 0 });
    assert.equal(f.store.getUser('customer').usd, 100);
  } finally { f.close(); }
});

test('bulk cancel also refunds REVIEW orders that have no provider card id', async () => {
  const f = await fixture({ provider: { configured: true, mode: 'live', async create() { throw new Error('timeout'); },
    async details() { return { ok: false }; } } });
  try {
    assert.equal((await f.service.create('customer', f.request())).state, 'REVIEW');
    assert.equal(f.store.getUser('customer').usd, 92);
    assert.deepEqual(await f.service.releaseAwaiting(admin), { refunded: 1, skipped: 0, failed: 0 });
    assert.equal(f.store.getUser('customer').usd, 100);
  } finally { f.close(); }
});

test('bulk cancel refunds REVIEW orders that got a candidate id but failed verification', async () => {
  const f = await fixture({ provider: { configured: true, mode: 'live', async create() { return { ok: true, candidateId: cardId }; },
    async details() { return { ok: false }; } } });
  try {
    assert.equal((await f.service.create('customer', f.request())).state, 'REVIEW');
    assert.equal(f.store.getUser('customer').usd, 92);
    assert.deepEqual(await f.service.releaseAwaiting(admin), { refunded: 1, skipped: 0, failed: 0 });
    assert.equal(f.store.getUser('customer').usd, 100);
  } finally { f.close(); }
});

test('autoComplete finishes an AWAITING_FUNDS order once the provider has funds, charging the customer once', async () => {
  let funded = false, creates = 0, skew = 0;
  const f = await fixture({ now: () => Date.now() + skew, provider: { configured: true, mode: 'live',
    async create() { creates++; return funded ? { ok: true, candidateId: cardId } : { awaitingFunds: true }; },
    async details() { return { ok: true, card: structuredClone(f.card) }; } } });
  try {
    assert.equal((await f.service.create('customer', f.request())).code, 'PROVIDER_FUNDS');
    assert.equal(f.service.adminHolders(admin).holders[0].state, 'PENDING');
    await f.service.autoComplete();                       // too soon: not re-sent within a minute
    assert.equal(creates, 1);
    funded = true;
    skew = 61000; await f.service.autoComplete();
    assert.equal(creates, 2);
    assert.equal(f.service.current('customer').orders[0].state, 'READY');
    assert.equal(f.store.getUser('customer').usd, 92);
    const h = f.service.adminHolders(admin).holders;       // what the admin "Kliyan ak Kat" tab lists
    assert.equal(h.length, 1); assert.equal(h[0].state, 'READY'); assert.equal(h[0].last4, '1111');
  } finally { f.close(); }
});

test('autoComplete settles a REVIEW order with a candidate id once the card verifies', async () => {
  let ok = false;
  const f = await fixture({ provider: { configured: true, mode: 'live', async create() { return { ok: true, candidateId: cardId }; },
    async details() { return ok ? { ok: true, card: structuredClone(f.card) } : { ok: false }; } } });
  try {
    assert.equal((await f.service.create('customer', f.request())).state, 'REVIEW');
    await f.service.autoComplete();
    assert.equal(f.service.current('customer').orders[0].state, 'REVIEW');
    ok = true; await f.service.autoComplete();
    assert.equal(f.service.current('customer').orders[0].state, 'READY');
    assert.equal(f.store.getUser('customer').usd, 92);
  } finally { f.close(); }
});

test('quote refuses to sell a card below the provider cost', async () => {
  const f = await fixture();
  try {
    const dir = f.dir, fileName = path.join(dir, 'virtual-card-settings.json');
    const v = JSON.parse(fs.readFileSync(fileName, 'utf8')); v.creationPriceCents = 100;   // below $2.58 cost for $5.00
    fs.writeFileSync(fileName, JSON.stringify(v));
    await rejects(f.service.createNow('customer'), 'CARD_SETTINGS_UNAVAILABLE');
    assert.equal(f.store.getUser('customer').usd, 100);
  } finally { f.close(); }
});

test('a card the provider reports as pending stays under automatic re-check and settles once it is active', async () => {
  let status = 'pending';
  const f = await fixture({ provider: { configured: true, mode: 'live', async create() { return { ok: true, candidateId: cardId }; },
    async details() { return { ok: true, card: { ...structuredClone(f.card), status } }; } } });
  try {
    assert.equal((await f.service.create('customer', f.request())).state, 'REVIEW');
    await f.service.autoComplete();
    assert.equal(f.service.current('customer').orders[0].state, 'REVIEW');
    status = 'active'; await f.service.autoComplete();
    assert.equal(f.service.current('customer').orders[0].state, 'READY');
    assert.equal(f.store.getUser('customer').usd, 92);
  } finally { f.close(); }
});

test('webhook card id completes a paid order whose create answer had no card id, only after ZiiroPay confirms it', async () => {
  const f = await fixture({ provider: { configured: true, mode: 'live', async create() { return { ok: false, code: 'CARD_PROVIDER_UNCERTAIN' }; },
    async details(id) { return id === cardId ? { ok: true, card: structuredClone(f.card) } : { ok: false, code: 'CARD_DETAILS_UNVERIFIED' }; } } });
  try {
    assert.equal((await f.service.create('customer', f.request())).state, 'REVIEW');
    assert.deepEqual(await f.service.adoptCard('not a valid id!'), { adopted: false });
    f.card.customerId = '00000000-0000-4000-8000-000000000000';
    assert.deepEqual(await f.service.adoptCard(cardId), { adopted: false });
    assert.equal(f.service.current('customer').orders[0].state, 'REVIEW');
    f.card.customerId = cid;
    assert.deepEqual(await f.service.adoptCard(cardId), { adopted: true });
    assert.equal(f.service.current('customer').orders[0].state, 'READY');
    assert.deepEqual(await f.service.adoptCard(cardId), { adopted: false });
  } finally { f.close(); }
});

test('admin customer view shows live provider status, balance and last four, never the card number', async () => {
  const f = await fixture();
  try {
    await f.service.create('customer', f.request());
    f.card.balanceCents = 250; f.card.status = 'frozen';
    const out = await f.service.adminCards(admin, 'customer');
    const pc = out.orders[0].providerCard;
    assert.deepEqual([pc.status, pc.balanceUSD, pc.last4, pc.live, out.orders[0].provider], ['frozen', '2.50', '1111', true, 'ZiiroPay']);
    assert.doesNotMatch(JSON.stringify(out), /"number"|"cvv"/);
    await rejects(f.service.adminCards(client, 'customer'), 'CARD_NOT_ELIGIBLE');
  } finally { f.close(); }
});

test('customer card page: no card says so; with a card it returns live status, balance and ZiiroPay history, never the number', async () => {
  const f = await fixture({ provider: { configured: true, mode: 'live', async create() { return { ok: true, candidateId: cardId }; },
    async details() { return { ok: true, card: structuredClone(f.card) }; },
    async history() { return { ok: true, known: true, items: [{ id: 't1', date: '2026-11-18', type: 'fund', description: 'Funding', amount: '3.00', status: 'success', currency: 'USD' }] }; } } });
  try {
    assert.deepEqual(await f.service.myCard('customer'), { hasCard: false });
    await f.service.create('customer', f.request());
    f.card.balanceCents = 275;
    const out = await f.service.myCard('customer');
    assert.deepEqual([out.hasCard, out.live, out.card.balanceUSD, out.card.last4, out.card.status, out.historyAvailable, out.history.length],
      [true, true, '2.75', '1111', 'active', true, 1]);
    assert.doesNotMatch(JSON.stringify(out), /"number"|"cvv"/);
    assert.deepEqual(await f.service.myCard('admin'), { hasCard: false });
  } finally { f.close(); }
});

test('provider history keeps only short plain fields and drops anything that looks like a card number', async () => {
  const { createCardProvider } = require('../ziiropay-cards');
  const mk = (body) => createCardProvider({ apiKey: 'k', mode: 'live', fetchImpl: async () => new Response(JSON.stringify(body),
    { headers: { 'content-type': 'application/json' } }) });
  const out = await mk({ success: true, response: { transactions: [{ id: 5, description: 'Card 4111111111111111 funded', amount: '3.00', status: 'success', url: 'https://x' }] } }).history('abcdef123456');
  assert.equal(out.items[0].description, 'Card  funded');
  assert.equal(out.items[0].url, undefined);
  assert.deepEqual((await mk({ success: true, response: {} }).history('abcdef123456')).items, []);
});

function topupFixture(fund) {
  let f;
  const provider = { configured: true, mode: 'live', async create() { return { ok: true, candidateId: cardId }; },
    async details() { return { ok: true, card: structuredClone(f.card) }; },
    async history() { return { ok: true, items: [] }; }, fund: (id, cents) => fund(f, id, cents) };
  return (async () => { f = await fixture({ provider }); await f.service.create('customer', f.request()); return f; })();
}
const topupBody = (amountUSD = '10.00') => ({ amountUSD, requestKey: crypto.randomUUID() });

test('add funds moves USD from the system balance to the card exactly once, and the card balance proves it', async () => {
  const calls = [];
  const f = await topupFixture(async (x, id, cents) => { calls.push(cents); x.card.balanceCents += cents; return { ok: true }; });
  try {
    const usdBefore = f.store.getUser('customer').usd;
    const body = topupBody('10.00');
    assert.equal((await f.service.topUp('customer', body)).state, 'DONE');
    assert.equal(f.store.getUser('customer').usd, usdBefore - 10.5);
    assert.deepEqual(await f.service.topUp('customer', body), { ...(await f.service.topUp('customer', body)) });
    assert.deepEqual(calls, [1000], 'same requestKey never funds twice');
    assert.equal(f.store.getUser('customer').usd, usdBefore - 10.5);
    const out = await f.service.myCard('customer');
    assert.equal(out.card.balanceUSD, '13.00'); assert.equal(out.topups[0].amountUSD, '10.00'); assert.equal(out.topups[0].feeUSD, '0.50'); assert.equal(out.topUpFeeUSD, '0.50');
    assert.equal(out.billingAddress.postalCode, '33127'); assert.equal(out.billingAddress.city, 'Miami');
    for (const bad of ['0.50', '4.99', '501', '-5', '1e2', 'abc']) await rejects(f.service.topUp('customer', topupBody(bad)), 'TOPUP_INVALID_AMOUNT');
    await rejects(f.service.topUp('customer', topupBody('400')), 'CARD_INSUFFICIENT');
    assert.equal(f.store.getUser('customer').usd, usdBefore - 10.5);
  } finally { f.close(); }
});

test('add funds: a definite ZiiroPay refusal gives the USD back', async () => {
  const f = await topupFixture(async () => ({ ok: false, definitive: true, code: 'CARD_PROVIDER_REJECTED' }));
  try {
    const usdBefore = f.store.getUser('customer').usd;
    await rejects(f.service.topUp('customer', topupBody('10')), 'TOPUP_PROVIDER_REFUSED');
    assert.equal(f.store.getUser('customer').usd, usdBefore);
    assert.equal((await f.service.myCard('customer')).topups[0].state, 'FAILED');
  } finally { f.close(); }
});

test('add funds: an uncertain answer keeps the USD held, blocks a second top-up, and settles once the balance shows it', async () => {
  let sent = 0;
  const f = await topupFixture(async () => { sent++; return { ok: false, definitive: false, code: 'CARD_PROVIDER_UNCERTAIN' }; });
  try {
    const usdBefore = f.store.getUser('customer').usd;
    assert.equal((await f.service.topUp('customer', topupBody('10'))).state, 'PENDING');
    assert.equal(f.store.getUser('customer').usd, usdBefore - 10.5);
    await rejects(f.service.topUp('customer', topupBody('5')), 'TOPUP_PENDING');
    await f.service.autoComplete();
    assert.equal((await f.service.myCard('customer')).topups[0].state, 'PENDING');
    f.card.balanceCents += 1000; await f.service.autoComplete();
    assert.equal((await f.service.myCard('customer')).topups[0].state, 'DONE');
    assert.equal(sent, 1, 'ZiiroPay is never asked twice');
    assert.equal(f.store.getUser('customer').usd, usdBefore - 10.5);
  } finally { f.close(); }
});

test('add funds needs an existing active card', async () => {
  const f = await fixture();
  try { await rejects(f.service.topUp('customer', topupBody('10')), 'TOPUP_NO_CARD'); } finally { f.close(); }
});
