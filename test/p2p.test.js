'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createService, parseUnits, fiatFor } = require('../p2p/service');
const { verifySignature } = require('../p2p/routes');

const ADMIN = { id: 'adm', role: 'admin' };
const SUPPORT = { id: 'sup', role: 'support' };

function makeMain() {
  const bal = new Map(), txs = new Set();
  return {
    set: (u, c) => bal.set(u, c), get: (u) => bal.get(u) || 0,
    debit(u, c, id) { if ((bal.get(u) || 0) < c) return 'INSUFFICIENT'; bal.set(u, bal.get(u) - c); txs.add(id); return 'OK'; },
    credit(u, c, id) { if (txs.has(id)) return; bal.set(u, (bal.get(u) || 0) + c); txs.add(id); },
    has: (u, id) => txs.has(id)
  };
}
function setup(extra = {}) {
  const clock = { t: 1_700_000_000_000 };
  const main = makeMain();
  const S = createService({ now: () => clock.t, main, ...extra });
  return { S, clock, main };
}
const fund = (ctx, user, usdt) => { ctx.main.set(user, ctx.main.get(user) + usdt * 100); ctx.S.bridgeIn(user, usdt * 100, 'fund-' + user + '-' + crypto.randomUUID()); };
const sellAd = (S, user, over = {}) => S.createAd(user, {
  type: 'SELL', fiat: 'HTG', price: '140.00', total: '100', minFiat: '100', maxFiat: '20000', methods: ['MonCash'],
  payDetails: { MonCash: { account: '50937000000', name: 'Vandè Test' } }, payWindowMin: 15, ...over
});
const order = (S, buyer, ad, crypto = '10', over = {}) => S.createOrder(buyer, { adId: ad.id, crypto, method: 'MonCash', ...over });
const throwsCode = (fn, code) => assert.throws(fn, (e) => { assert.equal(e.code, code, `got ${e.code}: ${e.message}`); return true; });
const clean = (S) => { const r = S.reconcile(); assert.deepEqual(r.issues, [], JSON.stringify(r.issues)); };
const bal = (S, u) => S.wallet(u);

// ---------- inite ----------
test('inite: pa gen float, 6 desimal, awondi antye', () => {
  assert.equal(parseUnits('0.1', 6), 100000);
  assert.equal(parseUnits('1.234567', 6), 1234567);
  assert.throws(() => parseUnits('1.1234567', 6));
  assert.throws(() => parseUnits('-1', 6));
  assert.throws(() => parseUnits('1e3', 6));
  assert.equal(fiatFor(10_000_000, 14000), 140000); // 10 USDT * 140.00 = 1400.00
  assert.equal(fiatFor(333_333, 14050), 4683);      // 46.8333 -> 46.83 (awondi, antye)
  assert.equal(fiatFor(500_000, 14001), 7001);     // 7000.5 -> awondi anwo (half-up), san float
});

// ---------- 1. de achtè, menm lajan ----------
test('1. de achtè pa ka rezève menm lajan (menm vandè, 2 anons)', () => {
  const c = setup(); fund(c, 'seller', 100);
  const a1 = sellAd(c.S, 'seller'), a2 = sellAd(c.S, 'seller'); // chak anons pa rezève anyen
  order(c.S, 'b1', a1, '60');
  throwsCode(() => order(c.S, 'b2', a2, '60'), 'INSUFFICIENT_FUNDS');
  assert.equal(bal(c.S, 'seller').available, 40_000_000);
  assert.equal(bal(c.S, 'seller').reserved, 60_000_000);
  assert.equal(c.S.q1('SELECT COUNT(*) c FROM orders').c, 1);        // lòd ki echwe a pa kreye
  assert.equal(c.S.q1('SELECT available_micro a FROM ads WHERE id=?', a2.id).a, 100_000_000); // anons lan pa redui
  clean(c.S);
});
test('1b. menm anons: dezyèm achtè pa ka depase kantite ki rete', () => {
  const c = setup(); fund(c, 'seller', 100);
  const ad = sellAd(c.S, 'seller');
  order(c.S, 'b1', ad, '60');
  throwsCode(() => order(c.S, 'b2', ad, '60'), 'AD_EXHAUSTED');
  clean(c.S);
});
test('1c. 6 PWOSESIS an paralèl sou menm anons: yon sèl lòd pase, lajan pa double-spend', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-')), 'db.sqlite');
  const c = setup({ dbPath }); fund(c, 'seller', 100);
  const ad = sellAd(c.S, 'seller');
  const runs = await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'worker.js')], { env: { ...process.env, DB: dbPath, USER: 'buyer' + i, AD: ad.id, CRYPTO: '60' } });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.on('close', () => resolve(out.trim()));
  })));
  const ok = runs.filter((r) => r === 'OK').length;
  assert.equal(ok, 1, runs.join(','));
  assert.equal(c.S.q1("SELECT COUNT(*) c FROM orders WHERE status='WAITING_PAYMENT'").c, 1);
  assert.equal(bal(c.S, 'seller').reserved, 60_000_000);
  assert.equal(bal(c.S, 'seller').available, 40_000_000);
  clean(c.S);
});

// ---------- 2. klike peman repete ----------
test('2. achtè klike "mwen peye" plizyè fwa: yon sèl tranzisyon, pa gen lage', () => {
  const c = setup(); fund(c, 'seller', 100);
  const o = order(c.S, 'buyer', sellAd(c.S, 'seller'));
  for (let i = 0; i < 5; i++) c.S.markPaid('buyer', o.id, 'TX12345');
  assert.equal(c.S.q1('SELECT COUNT(*) c FROM order_events WHERE order_id=? AND action=?', o.id, 'PAYMENT_MARKED').c, 1);
  const v = c.S.getOrderFor({ id: 'seller' }, o.id);
  assert.equal(v.status, 'PAYMENT_MARKED'); assert.equal(v.escrow, 'LOCKED');
  assert.equal(bal(c.S, 'buyer').available, 0);                 // pa gen USDT lage sèlman paske li klike
  throwsCode(() => c.S.markPaid('seller', o.id, 'TX12345'), 'FORBIDDEN');
  throwsCode(() => c.S.markPaid('buyer', o.id, 'x'), 'BAD_INPUT');
  clean(c.S);
});

// ---------- 3. vandè lage de fwa ----------
test('3. vandè lage escrow de fwa: achtè kredite yon sèl fwa', () => {
  const c = setup(); fund(c, 'seller', 100);
  const o = order(c.S, 'buyer', sellAd(c.S, 'seller'), '25');
  throwsCode(() => c.S.release('seller', o.id), 'ILLEGAL_TRANSITION');   // pa ka lage anvan peman make
  c.S.markPaid('buyer', o.id, 'TX999');
  c.S.release('seller', o.id); c.S.release('seller', o.id); c.S.release('seller', o.id);
  assert.equal(bal(c.S, 'buyer').available, 25_000_000);
  assert.equal(bal(c.S, 'seller').available, 75_000_000);
  assert.equal(c.S.q1("SELECT COUNT(*) c FROM ledger_txs WHERE type='ESCROW_RELEASE'").c, 1);
  throwsCode(() => c.S.release('buyer', o.id), 'FORBIDDEN');             // achtè pa ka lage tèt li
  clean(c.S);
});

// ---------- 4. kraze pandan transfè ----------
function runChild(script, env) {
  return new Promise((resolve) => { const p = spawn(process.execPath, [path.join(__dirname, script)], { env: { ...process.env, ...env } }); let out = ''; p.stdout.on('data', (d) => (out += d)); p.on('close', (code) => resolve({ code, out: out.trim() })); });
}
test('4. sèvè kraze pandan lage: anyen pa mwatye fèt, rekòmanse mache yon sèl fwa', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p2p-')), 'db.sqlite');
  const c = setup({ dbPath }); fund(c, 'seller', 100);
  const o = order(c.S, 'buyer', sellAd(c.S, 'seller'), '40'); c.S.markPaid('buyer', o.id, 'TXCRASH');
  const r = await runChild('crash.js', { DB: dbPath, USER: 'seller', ORDER: o.id, CRASH_AT: 'release.beforeCommit' });
  assert.equal(r.code, 42);                                           // pwosesis la mouri nan mitan tranzaksyon an
  const after = createService({ dbPath, main: makeMain() });          // re-louvri baz la (rekiperasyon WAL)
  assert.equal(after.getOrderFor({ id: 'seller' }, o.id).status, 'PAYMENT_MARKED');
  assert.equal(after.getOrderFor({ id: 'seller' }, o.id).escrow, 'LOCKED');
  assert.equal(after.wallet('buyer').available, 0);
  clean(after);
  after.release('seller', o.id);
  assert.equal(after.wallet('buyer').available, 40_000_000);
  clean(after);
});
test('4b. kraze nan mitan pon an (apre debi prensipal): lajan pa kreye, rekiperasyon fini yon sèl fwa', () => {
  let boom = true;
  const c = setup({ hooks: { crash: (p) => { if (boom && p === 'bridge.in.afterMainDebit') throw new Error('crash'); } } });
  c.main.set('u', 5000);
  assert.throws(() => c.S.bridgeIn('u', 3000, 'k1'), /crash/);
  assert.equal(c.main.get('u'), 2000);                  // prensipal debite
  assert.equal(bal(c.S, 'u').available, 0);             // ledger poko kredite: pa gen lajan kreye
  boom = false;
  assert.equal(c.S.recoverBridge(0), 1);
  assert.equal(bal(c.S, 'u').available, 30_000_000);
  assert.equal(c.S.recoverBridge(0), 0);                // dezyèm rekiperasyon pa fè anyen
  c.S.bridgeIn('u', 3000, 'k1');                        // retry menm kle = pa double kredite
  assert.equal(bal(c.S, 'u').available, 30_000_000); assert.equal(c.main.get('u'), 2000);
  clean(c.S);
});
test('4c. kraze si lòd la (apre lock escrow, anvan commit): tranzaksyon an anile nèt', () => {
  const c = setup({ hooks: { crash: (p) => { if (p === 'createOrder.afterLock') throw new Error('crash'); } } });
  fund(c, 'seller', 50);
  const ad = sellAd(c.S, 'seller', { total: '50' });
  assert.throws(() => order(c.S, 'buyer', ad, '20'), /crash/);
  assert.equal(c.S.q1('SELECT COUNT(*) c FROM orders').c, 0);
  assert.equal(bal(c.S, 'seller').available, 50_000_000);
  assert.equal(c.S.q1('SELECT available_micro a FROM ads WHERE id=?', ad.id).a, 50_000_000);
  clean(c.S);
});

// ---------- 5. webhook double ----------
test('5. webhook: siyati, double evènman, montan/lajan/destinatè, pa janm lage escrow', () => {
  assert.equal(verifySignature('s3cret', Buffer.from('{"a":1}'), crypto.createHmac('sha256', 's3cret').update('{"a":1}').digest('hex')), true);
  assert.equal(verifySignature('s3cret', Buffer.from('{"a":1}'), 'bad'), false);
  assert.equal(verifySignature('', Buffer.from('x'), 'x'), false);
  const c = setup(); fund(c, 'seller', 100);
  const o = order(c.S, 'buyer', sellAd(c.S, 'seller'), '10');
  const ev = { event_id: 'e1', reference: o.payRef, amount_cents: 140000, currency: 'HTG', recipient: '50937000000', status: 'SUCCEEDED' };
  assert.equal(c.S.processProviderEvent('prov', { ...ev, event_id: 'bad1', amount_cents: 1 }).outcome, 'MISMATCH');
  assert.equal(c.S.processProviderEvent('prov', { ...ev, event_id: 'bad2', recipient: 'other' }).outcome, 'MISMATCH');
  assert.equal(c.S.processProviderEvent('prov', { ...ev, event_id: 'bad3', currency: 'USD' }).outcome, 'MISMATCH');
  assert.equal(c.S.getOrderFor({ id: 'seller' }, o.id).status, 'WAITING_PAYMENT');
  assert.equal(c.S.processProviderEvent('prov', ev).outcome, 'VERIFIED');
  assert.equal(c.S.processProviderEvent('prov', ev).duplicate, true);                // doub = rejte
  assert.equal(c.S.processProviderEvent('prov', { ...ev, event_id: 'e2' }).outcome, 'VERIFIED'); // lòt evènman, menm lòd: toujou yon sèl tranzisyon
  const v = c.S.getOrderFor({ id: 'seller' }, o.id);
  assert.equal(v.status, 'PAYMENT_MARKED'); assert.equal(v.providerVerified, true); assert.equal(v.escrow, 'LOCKED');
  assert.equal(bal(c.S, 'buyer').available, 0);                                       // verifye ≠ lage
  assert.equal(c.S.q1("SELECT COUNT(*) c FROM order_events WHERE order_id=? AND action='PAYMENT_MARKED_BY_PROVIDER'", o.id).c, 1);
  assert.equal(c.S.processProviderEvent('prov', { ...ev, event_id: 'e3', reference: 'NOPE' }).outcome, 'NO_ORDER');
  clean(c.S);
});

// ---------- 6. ekspirasyon + reklamasyon peman ----------
test('6. lòd ekspire san peman: escrow tounen; ekspirasyon idempotan', () => {
  const c = setup(); fund(c, 'seller', 100);
  const ad = sellAd(c.S, 'seller'); const o = order(c.S, 'buyer', ad, '30');
  c.clock.t += 16 * 60e3;
  c.S.expireDue(); c.S.expireDue(); c.S.expireDue();
  assert.equal(c.S.getOrderFor({ id: 'buyer' }, o.id).status, 'EXPIRED');
  assert.equal(bal(c.S, 'seller').available, 100_000_000);
  assert.equal(c.S.q1("SELECT COUNT(*) c FROM ledger_txs WHERE type='ESCROW_RETURN'").c, 1);
  assert.equal(c.S.q1('SELECT available_micro a FROM ads WHERE id=?', ad.id).a, 100_000_000);
  throwsCode(() => c.S.markPaid('buyer', o.id, 'TXLATE'), 'ILLEGAL_TRANSITION');
  clean(c.S);
});
test('6b. peman make avan delè: ekspirasyon PA debloke escrow; vandè pa reponn => dispit otomatik', () => {
  const c = setup(); fund(c, 'seller', 100);
  const o = order(c.S, 'buyer', sellAd(c.S, 'seller'), '30');
  c.S.markPaid('buyer', o.id, 'TXPAID');
  c.clock.t += 16 * 60e3; c.S.expireDue();
  assert.equal(c.S.getOrderFor({ id: 'buyer' }, o.id).status, 'PAYMENT_MARKED');   // pa ekspire
  assert.equal(c.S.getOrderFor({ id: 'buyer' }, o.id).escrow, 'LOCKED');
  c.clock.t += 31 * 60e3; c.S.expireDue(); c.S.expireDue();
  const v = c.S.getOrderFor({ id: 'buyer' }, o.id);
  assert.equal(v.status, 'DISPUTED'); assert.equal(v.escrow, 'LOCKED');
  assert.equal(c.S.q1('SELECT COUNT(*) c FROM disputes').c, 1);
  clean(c.S);
});
test('6c. reklamasyon peman an reta: dispit sou lòd EXPIRED, admin rezoud, lajan deplase yon sèl fwa', () => {
  const c = setup(); fund(c, 'seller', 100);
  const o = order(c.S, 'buyer', sellAd(c.S, 'seller'), '30');
  c.clock.t += 16 * 60e3; c.S.expireDue();
  throwsCode(() => c.S.openDispute('seller', o.id, 'Mwen pa dakò ak sa a menm.'), 'ILLEGAL_TRANSITION');
  const v = c.S.openDispute('buyer', o.id, 'Mwen te peye men mwen te reta, men prèv la.');
  assert.equal(v.status, 'DISPUTED'); assert.equal(v.lateClaim, true);
  const d = c.S.q1('SELECT id FROM disputes').id;
  c.S.takeDispute(ADMIN, d);
  c.S.resolveDispute(ADMIN, d, 'RELEASE_TO_BUYER', 'Prèv peman verifye pa sipò.');
  c.S.resolveDispute(ADMIN, d, 'RELEASE_TO_BUYER', 'Prèv peman verifye pa sipò.'); // retry
  assert.equal(bal(c.S, 'buyer').available, 30_000_000); assert.equal(bal(c.S, 'seller').available, 70_000_000);
  throwsCode(() => c.S.resolveDispute(ADMIN, d, 'RETURN_TO_SELLER', 'Chanje lide mwen kounye a.'), 'ALREADY_RESOLVED');
  clean(c.S);
});
test('6d. reklamasyon an reta: si vandè pa gen ase balans, admin pa ka kreye lajan', () => {
  const c = setup(); fund(c, 'seller', 30);
  const o = order(c.S, 'buyer', sellAd(c.S, 'seller', { total: '30' }), '30');
  c.clock.t += 16 * 60e3; c.S.expireDue();
  c.S.bridgeOut('seller', 3000, 'out1');                              // vandè retire lajan an
  c.S.openDispute('buyer', o.id, 'Mwen te peye men mwen te reta, men prèv la.');
  const d = c.S.q1('SELECT id FROM disputes').id; c.S.takeDispute(ADMIN, d);
  throwsCode(() => c.S.resolveDispute(ADMIN, d, 'RELEASE_TO_BUYER', 'Prèv peman verifye pa sipò.'), 'INSUFFICIENT_FUNDS');
  assert.equal(c.S.q1('SELECT status FROM disputes WHERE id=?', d).status, 'UNDER_REVIEW'); // anyen pa chanje
  clean(c.S);
});
test('6e. webhook an reta (lòd EXPIRED): louvri dispit otomatik, pa lage anyen', () => {
  const c = setup(); fund(c, 'seller', 100);
  const o = order(c.S, 'buyer', sellAd(c.S, 'seller'), '10');
  c.clock.t += 16 * 60e3; c.S.expireDue();
  const r = c.S.processProviderEvent('prov', { event_id: 'late1', reference: o.payRef, amount_cents: 140000, currency: 'HTG', recipient: '50937000000', status: 'SUCCEEDED' });
  assert.equal(r.outcome, 'VERIFIED');
  assert.equal(c.S.getOrderFor({ id: 'buyer' }, o.id).status, 'DISPUTED');
  assert.equal(bal(c.S, 'buyer').available, 0);
  clean(c.S);
});

// ---------- 7. dispit anvan lage ----------
test('7. dispit louvri anvan lage: vandè pa ka lage, escrow rete bloke jiskaske admin deside', () => {
  const c = setup(); fund(c, 'seller', 100);
  const o = order(c.S, 'buyer', sellAd(c.S, 'seller'), '20'); c.S.markPaid('buyer', o.id, 'TXDISP');
  c.S.openDispute('seller', o.id, 'Mwen pa wè lajan an sou kont mwen.');
  c.S.openDispute('buyer', o.id, 'Dezyèm eseye menm bagay la.');                 // idempotan
  assert.equal(c.S.q1('SELECT COUNT(*) c FROM disputes').c, 1);
  throwsCode(() => c.S.release('seller', o.id), 'ILLEGAL_TRANSITION');
  throwsCode(() => c.S.cancel('buyer', o.id), 'ILLEGAL_TRANSITION');
  c.clock.t += 10 * 3600e3; c.S.expireDue();                                    // tan pa debloke anyen
  assert.equal(c.S.getOrderFor({ id: 'buyer' }, o.id).escrow, 'LOCKED');
  const d = c.S.q1('SELECT id FROM disputes').id;
  throwsCode(() => c.S.resolveDispute(ADMIN, d, 'RELEASE_TO_BUYER', 'Mwen verifye prèv yo.'), 'TAKE_FIRST');
  c.S.takeDispute(SUPPORT, d);                                                  // support ka pran dispit la
  c.S.resolveDispute(ADMIN, d, 'RETURN_TO_SELLER', 'Vandè a montre relve labank: pa gen lajan.');
  assert.equal(bal(c.S, 'seller').available, 100_000_000); assert.equal(bal(c.S, 'buyer').available, 0);
  assert.equal(c.S.getOrderFor({ id: 'buyer' }, o.id).status, 'CANCELLED');
  assert.equal(c.S.q1('SELECT COUNT(*) c FROM decision_log WHERE dispute_id=?', d).c, 2);
  clean(c.S);
});

// ---------- 8. balans pa sifi ----------
test('8. balans ensifizan: anons, lòd, retrè', () => {
  const c = setup(); fund(c, 'seller', 10);
  throwsCode(() => sellAd(c.S, 'seller', { total: '11' }), 'INSUFFICIENT_FUNDS');
  const ad = sellAd(c.S, 'seller', { total: '10' });
  throwsCode(() => order(c.S, 'b', ad, '10.000001'), 'AD_EXHAUSTED');
  order(c.S, 'b', ad, '10');
  throwsCode(() => c.S.bridgeOut('seller', 100, 'o1'), 'INSUFFICIENT_FUNDS');   // lajan an escrow pa disponib
  throwsCode(() => c.S.bridgeIn('seller', 999999, 'i1'), 'INSUFFICIENT_FUNDS');  // balans prensipal pa sifi
  clean(c.S);
});
test('8b. limit, metòd, pwòp anons, eligibilite', () => {
  const c = setup({ eligible: (u) => (u === 'banned' ? { ok: false, reason: 'Kont bani.' } : { ok: true }) });
  fund(c, 'seller', 100); const ad = sellAd(c.S, 'seller');
  throwsCode(() => order(c.S, 'b', ad, '0.5'), 'LIMITS');                       // 70 HTG < min 100
  throwsCode(() => order(c.S, 'b', ad, '200'), 'AD_EXHAUSTED');
  throwsCode(() => c.S.createOrder('b', { adId: ad.id, crypto: '5', method: 'NatCash' }), 'BAD_METHOD');
  throwsCode(() => order(c.S, 'seller', ad, '5'), 'OWN_AD');
  throwsCode(() => order(c.S, 'banned', ad, '5'), 'NOT_ELIGIBLE');
  throwsCode(() => c.S.createAd('banned', {}), 'NOT_ELIGIBLE');
  throwsCode(() => order(c.S, 'b', { id: 'nope' }, '5'), 'AD_UNAVAILABLE');
  c.S.setAdStatus({ id: 'seller' }, ad.id, 'PAUSED'); throwsCode(() => order(c.S, 'b', ad, '5'), 'AD_UNAVAILABLE');
  throwsCode(() => c.S.setAdStatus({ id: 'b' }, ad.id, 'ACTIVE'), 'FORBIDDEN');
  clean(c.S);
});
test('8c. anons AWAT (BUY): vandè se moun k pran an; escrow soti nan li', () => {
  const c = setup(); fund(c, 'taker', 50);
  const ad = c.S.createAd('adv', { type: 'BUY', fiat: 'HTG', price: '139.00', total: '50', minFiat: '100', maxFiat: '20000', methods: ['MonCash'], payWindowMin: 15 });
  throwsCode(() => c.S.createOrder('taker', { adId: ad.id, crypto: '10', method: 'MonCash' }), 'BAD_INPUT'); // bezwen enfo kont vandè a
  const o = c.S.createOrder('taker', { adId: ad.id, crypto: '10', method: 'MonCash', payDetails: { account: '50937111111', name: 'Taker' } });
  assert.equal(o.role, 'SELLER'); assert.equal(bal(c.S, 'taker').reserved, 10_000_000);
  c.S.markPaid('adv', o.id, 'TXBUY'); c.S.release('taker', o.id);
  assert.equal(bal(c.S, 'adv').available, 10_000_000); clean(c.S);
});

// ---------- 9. anilasyon vs peman an menm tan ----------
test('9. anilasyon ak konfimasyon peman nan tout lòd: yon sèl rezilta, lajan konsistan', () => {
  for (const cancelFirst of [true, false]) {
    const c = setup(); fund(c, 'seller', 100);
    const o = order(c.S, 'buyer', sellAd(c.S, 'seller'), '20');
    const calls = [() => c.S.cancel('buyer', o.id), () => c.S.markPaid('buyer', o.id, 'TXRACE')];
    if (!cancelFirst) calls.reverse();
    const res = calls.map((f) => { try { f(); return 'ok'; } catch (e) { return e.code; } });
    const v = c.S.getOrderFor({ id: 'buyer' }, o.id);
    if (cancelFirst) { assert.equal(v.status, 'CANCELLED'); assert.equal(res[1], 'ILLEGAL_TRANSITION'); assert.equal(bal(c.S, 'seller').available, 100_000_000); }
    else { assert.equal(v.status, 'PAYMENT_MARKED'); assert.equal(res[1], 'ILLEGAL_TRANSITION'); assert.equal(v.escrow, 'LOCKED'); }
    clean(c.S);
  }
});
test('9b. eta final: lòd COMPLETED/CANCELLED pa ka chanje (menm ak SQL dirèk)', () => {
  const c = setup(); fund(c, 'seller', 100);
  const o = order(c.S, 'buyer', sellAd(c.S, 'seller'), '20'); c.S.markPaid('buyer', o.id, 'TXFINAL'); c.S.release('seller', o.id);
  throwsCode(() => c.S.cancel('buyer', o.id), 'ILLEGAL_TRANSITION');
  throwsCode(() => c.S.openDispute('seller', o.id, 'Eseye louvri dispit apre fini.'), 'ILLEGAL_TRANSITION');
  assert.throws(() => c.S.db.prepare("UPDATE orders SET status='WAITING_PAYMENT' WHERE id=?").run(o.id), /terminal/);
  assert.throws(() => c.S.db.prepare("UPDATE escrows SET status='LOCKED' WHERE order_id=?").run(o.id), /final/);
  clean(c.S);
});

// ---------- 10. aksyon admin san otorizasyon ----------
test('10. aksyon admin san otorizasyon refize', () => {
  const c = setup(); fund(c, 'seller', 100);
  const ad = sellAd(c.S, 'seller'); const o = order(c.S, 'buyer', ad, '20'); c.S.markPaid('buyer', o.id, 'TXAUTH');
  c.S.openDispute('buyer', o.id, 'Vandè a pa reponn mesaj mwen yo.');
  const d = c.S.q1('SELECT id FROM disputes').id;
  throwsCode(() => c.S.takeDispute({ id: 'user1', role: 'user' }, d), 'FORBIDDEN');
  c.S.takeDispute(SUPPORT, d);
  throwsCode(() => c.S.resolveDispute(SUPPORT, d, 'RELEASE_TO_BUYER', 'Mwen se sipò men mwen vle lage.'), 'FORBIDDEN');
  throwsCode(() => c.S.resolveDispute({ id: 'user1', role: 'user' }, d, 'RELEASE_TO_BUYER', 'Se mwen ki achtè a mwen.'), 'FORBIDDEN');
  throwsCode(() => c.S.resolveDispute(ADMIN, d, 'RELEASE_TO_BUYER', ''), 'REASON_REQUIRED');
  throwsCode(() => c.S.resolveDispute(ADMIN, d, 'RELEASE_TO_BUYER', 'kout'), 'REASON_REQUIRED');
  throwsCode(() => c.S.resolveDispute(ADMIN, d, 'KREYE_LAJAN', 'Rezon ki ase long.'), 'BAD_INPUT');
  throwsCode(() => c.S.admin.ledger(SUPPORT), 'FORBIDDEN');
  throwsCode(() => c.S.admin.audit(SUPPORT), 'FORBIDDEN');
  throwsCode(() => c.S.admin.reconcile(SUPPORT), 'FORBIDDEN');
  throwsCode(() => c.S.setAdStatus(SUPPORT, ad.id, 'SUSPENDED', 'Rezon ki ase long.'), 'FORBIDDEN');
  throwsCode(() => c.S.setAdStatus(ADMIN, ad.id, 'SUSPENDED', ''), 'REASON_REQUIRED');
  assert.equal(c.S.getOrderFor({ id: 'buyer' }, o.id).escrow, 'LOCKED');     // anyen pa deplase
  c.S.setAdStatus(ADMIN, ad.id, 'SUSPENDED', 'Anons sispèk: pri twò ba.');
  throwsCode(() => order(c.S, 'b2', ad, '5'), 'AD_UNAVAILABLE');
  throwsCode(() => c.S.setAdStatus({ id: 'seller' }, ad.id, 'ACTIVE'), 'SUSPENDED');
  // moun ki pa patisipan pa ka wè lòd la ni voye mesaj
  throwsCode(() => c.S.getOrderFor({ id: 'stranger' }, o.id), 'FORBIDDEN');
  throwsCode(() => c.S.postMessage({ id: 'stranger' }, o.id, 'sal'), 'FORBIDDEN');
  throwsCode(() => c.S.release('stranger', o.id), 'FORBIDDEN');
  clean(c.S);
});

// ---------- 11. ledger ----------
test('11. ledger: debi=kredi, imitab, odit, reconciliation detekte koripsyon', () => {
  const c = setup(); fund(c, 'seller', 100);
  const o = order(c.S, 'buyer', sellAd(c.S, 'seller'), '33.333333'); c.S.markPaid('buyer', o.id, 'TXLEDGER'); c.S.release('seller', o.id);
  clean(c.S);
  assert.equal(c.S.q1('SELECT COALESCE(SUM(balance),0) s FROM accounts').s, 0);
  const unb = c.S.q("SELECT tx_id FROM ledger_entries GROUP BY tx_id HAVING SUM(CASE dir WHEN 'DEBIT' THEN amount ELSE -amount END)<>0");
  assert.equal(unb.length, 0);
  assert.throws(() => c.S.db.prepare('UPDATE ledger_entries SET amount=amount+1').run(), /immutable/);
  assert.throws(() => c.S.db.prepare('DELETE FROM ledger_txs').run(), /immutable/);
  assert.throws(() => c.S.db.prepare('DELETE FROM audit_log').run(), /immutable/);
  assert.throws(() => c.S.db.prepare('UPDATE order_events SET action=1').run(), /immutable/);
  assert.throws(() => c.S.db.prepare("UPDATE accounts SET balance=-5 WHERE kind='AVAILABLE'").run(), /CHECK/);
  assert.ok(c.S.admin.audit(ADMIN).length >= 3);
  // koripsyon dirèk nan balans => reconciliation lanse CRITICAL
  c.S.db.prepare("UPDATE accounts SET balance=balance+7 WHERE kind='AVAILABLE' AND owner='buyer'").run();
  const r = c.S.reconcile();
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.code === 'BALANCE_MISMATCH') && r.issues.some((i) => i.code === 'GLOBAL_SUM_NONZERO'));
  assert.ok(c.S.admin.alerts(ADMIN).some((a) => a.kind === 'RECONCILIATION'));
});
test('11b. reconciliation detekte escrow bloke sou lòd fèmen', () => {
  const c = setup(); fund(c, 'seller', 100);
  const o = order(c.S, 'buyer', sellAd(c.S, 'seller'), '10');
  c.S.db.exec('DROP TRIGGER orders_terminal');
  c.S.db.prepare("UPDATE orders SET status='CANCELLED' WHERE id=?").run(o.id);
  assert.ok(c.S.reconcile().issues.some((i) => i.code === 'ESCROW_LOCKED_ON_CLOSED_ORDER'));
});
test('11c. lòd kole nan CREATED apre kraze: rekiperasyon fini oswa anile', () => {
  const c = setup(); fund(c, 'seller', 100);
  const o = order(c.S, 'buyer', sellAd(c.S, 'seller'), '10');
  c.S.db.exec('DROP TRIGGER orders_terminal');
  c.S.db.prepare("UPDATE orders SET status='ESCROW_LOCKED' WHERE id=?").run(o.id);
  c.clock.t += 3 * 60e3;
  assert.ok(c.S.reconcile().issues.some((i) => i.code === 'STUCK_ORDER'));
  c.S.recoverStuck();
  assert.equal(c.S.getOrderFor({ id: 'buyer' }, o.id).status, 'WAITING_PAYMENT');
  clean(c.S);
});

// ---------- 12. reyseau + retry ----------
test('12. timeout/retry: menm kle idempotans = menm lòd, yon sèl escrow', () => {
  const c = setup(); fund(c, 'seller', 100);
  const ad = sellAd(c.S, 'seller');
  const key = 'idem-key-' + crypto.randomUUID();
  const a = c.S.createOrder('buyer', { adId: ad.id, crypto: '10', method: 'MonCash' }, key);
  const b = c.S.createOrder('buyer', { adId: ad.id, crypto: '10', method: 'MonCash' }, key);   // kliyan an re-eseye apre timeout
  assert.equal(a.id, b.id);
  assert.equal(c.S.q1('SELECT COUNT(*) c FROM orders').c, 1);
  assert.equal(bal(c.S, 'seller').reserved, 10_000_000);
  const c2 = c.S.createOrder('buyer', { adId: ad.id, crypto: '10', method: 'MonCash' }, 'idem-key-other-' + crypto.randomUUID());
  assert.notEqual(c2.id, a.id);
  const k = 'ad-key-' + crypto.randomUUID();
  const x = c.S.createAd('seller', { type: 'SELL', fiat: 'HTG', price: '140', total: '5', minFiat: '100', maxFiat: '5000', methods: ['MonCash'], payDetails: { MonCash: { account: '50937000000', name: 'V T' } } }, k);
  const y = c.S.createAd('seller', { type: 'SELL', fiat: 'HTG', price: '140', total: '5', minFiat: '100', maxFiat: '5000', methods: ['MonCash'], payDetails: { MonCash: { account: '50937000000', name: 'V T' } } }, k);
  assert.equal(x.id, y.id);
  clean(c.S);
});
test('12b. pon: retry ak menm kle pa double debi', () => {
  const c = setup(); c.main.set('u', 10000);
  for (let i = 0; i < 4; i++) c.S.bridgeIn('u', 2500, 'same-key');
  assert.equal(c.main.get('u'), 7500); assert.equal(bal(c.S, 'u').available, 25_000_000);
  for (let i = 0; i < 4; i++) c.S.bridgeOut('u', 1000, 'out-key');
  assert.equal(c.main.get('u'), 8500); assert.equal(bal(c.S, 'u').available, 15_000_000);
  clean(c.S);
});

// ---------- machin eta + chat + prèv ----------
test('chat ak prèv: sèlman patisipan; staff sèlman nan dispit; prèv limite pa eta', () => {
  const c = setup(); fund(c, 'seller', 100);
  const o = order(c.S, 'buyer', sellAd(c.S, 'seller'), '10');
  c.S.postMessage({ id: 'buyer' }, o.id, 'Bonjou, mwen pral peye kounye a');
  throwsCode(() => c.S.postMessage(SUPPORT.id && { ...SUPPORT, staff: true }, o.id, 'Bonjou'), 'NO_DISPUTE');
  c.S.addEvidence({ id: 'buyer' }, o.id, 'PAYMENT_PROOF', 'x/a.jpg', 'abc');
  c.S.markPaid('buyer', o.id, 'TXCHAT'); c.S.openDispute('seller', o.id, 'Mwen pa wè lajan an anko.');
  c.S.postMessage({ ...SUPPORT, staff: true }, o.id, 'Mande prèv relve a');
  const msgs = c.S.listMessages({ id: 'seller' }, o.id);
  assert.ok(msgs.some((m) => m.from === 'STAFF') && msgs.some((m) => m.from === 'BUYER') && msgs.some((m) => m.from === 'SYSTEM'));
  throwsCode(() => c.S.addEvidence({ ...SUPPORT, staff: true }, o.id, 'DISPUTE', 'x/b.jpg', 'abc'), 'FORBIDDEN');
  const v = c.S.admin.order(SUPPORT, o.id);
  assert.equal(v.status, 'DISPUTED'); assert.ok(v.messages.length >= 3);
  clean(c.S);
});
test('machin eta: pa gen chemen ilegal', () => {
  const c = setup(); fund(c, 'seller', 100);
  const o = order(c.S, 'buyer', sellAd(c.S, 'seller'), '10');
  throwsCode(() => c.S.release('seller', o.id), 'ILLEGAL_TRANSITION');           // WAITING_PAYMENT -> COMPLETED
  throwsCode(() => c.S.openDispute('buyer', o.id, 'Mwen vle yon dispit san peman'), 'ILLEGAL_TRANSITION'); // WAITING_PAYMENT -> DISPUTED
  throwsCode(() => c.S.cancel('seller', o.id), 'FORBIDDEN');                       // vandè pa ka anile
  throwsCode(() => c.S.takeDispute(ADMIN, 999), 'NOT_FOUND');
  clean(c.S);
});
