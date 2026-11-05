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
