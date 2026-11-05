'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { usdToCents } = require('./virtual-card-setup');
const { validId } = require('./ziiropay-cards');
const uuid = (s) => typeof s === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s);
const norm = (s) => String(s || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const error = (code, status = 409) => Object.assign(new Error(code), { code, status });
const digest = (u, b) => crypto.createHash('sha256').update(JSON.stringify([
  u.id, norm(u.email), norm(u.profile?.firstName), norm(u.profile?.lastName), b.customerId
])).digest('hex');
const messages = {
  CARD_DISABLED: 'Kreasyon kat la poko aktive pou kliyan yo.',
  CARD_SETTINGS_UNAVAILABLE: 'Admin dwe fikse pri kreasyon kat la anvan.',
  CARD_NOT_ELIGIBLE: 'Cardholder ou dwe apwouve epi asosye ak kont ou anvan.',
  CARD_INSUFFICIENT: 'Balans USD disponib ou pa ase pou pri total la.',
  CARD_STALE_QUOTE: 'Pri oswa dosye a chanje, oswa estimasyon an ekspire. Rekalkile pri a.',
  CARD_INVALID_REQUEST: 'Demann kat la pa valid.',
  CARD_WALLET_UNCERTAIN: 'Verifikasyon balans lan poko fini. Pa fè yon lòt demann; kontakte admin.',
  CARD_PROVIDER_REJECTED: 'ZiiroPay rejte demann lan. Rezèv la anile; pa gen debi final.',
  CARD_REVIEW_REQUIRED: 'Rezilta demann lan mande verifikasyon admin. Rezèv oswa peman an poko finalize; pa repete acha a.',
  CARD_BUSY: 'Gen yon operasyon sou demann sa a deja an kou.',
  CARD_NOT_FOUND: 'Demann kat sa a pa disponib.',
  CARD_REVEAL_UNAVAILABLE: 'Detay sekirize kat la pa disponib kounye a.',
  CARD_INTERNAL_ERROR: 'Nou pa ka fini verifikasyon an kounye a. Rechaje estati a anvan nenpòt lòt aksyon.'
};

function createCardOrders(options) {
  const { dataDir, wallet, provider, kycProvider, settings, getUser, getBinding } = options;
  const now = options.now || Date.now;
  const enabled = options.enabled ?? (process.env.ZIIROPAY_CARD_ISSUING_ENABLED === 'true' && provider.mode === 'live');
  const activeJobs = new Map();
  let db, recovering = false;
  function storage() {
    if (db) return db;
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, 'virtual-card-orders.sqlite');
    db = new DatabaseSync(file); fs.chmodSync(file, 0o600);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS card_quotes(
        id TEXT PRIMARY KEY,user_id TEXT NOT NULL,customer_id TEXT NOT NULL,binding_revision TEXT NOT NULL,
        identity_hash TEXT NOT NULL,price_revision TEXT NOT NULL,fee_cents INTEGER NOT NULL,
        funding_cents INTEGER NOT NULL,total_cents INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS card_orders(
        id TEXT PRIMARY KEY,user_id TEXT NOT NULL,request_key TEXT NOT NULL,quote_id TEXT NOT NULL UNIQUE,
        customer_id TEXT NOT NULL,binding_revision TEXT NOT NULL,identity_hash TEXT NOT NULL,
        fee_cents INTEGER NOT NULL,funding_cents INTEGER NOT NULL,total_cents INTEGER NOT NULL,
        state TEXT NOT NULL,created_at INTEGER NOT NULL,attempt_started_at INTEGER,
        candidate_id TEXT,card_id TEXT UNIQUE,provider_reference TEXT UNIQUE,public_card TEXT,code TEXT,notice_done INTEGER NOT NULL DEFAULT 0,
        UNIQUE(user_id,request_key));
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_card_per_user ON card_orders(user_id) WHERE state!='FAILED';
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_card_per_cardholder ON card_orders(customer_id) WHERE state!='FAILED';
      CREATE TABLE IF NOT EXISTS card_order_audit(
        id INTEGER PRIMARY KEY,order_id TEXT NOT NULL,actor_id TEXT NOT NULL,action TEXT NOT NULL,at INTEGER NOT NULL);`);
    return db;
  }
  const row = (id) => storage().prepare('SELECT * FROM card_orders WHERE id=?').get(id);
  const update = (id, state, code = null) => storage().prepare('UPDATE card_orders SET state=?,code=? WHERE id=?').run(state, code, id);
  const audit = (op, actor, action) => storage().prepare(
    'INSERT INTO card_order_audit(order_id,actor_id,action,at) VALUES(?,?,?,?)').run(op.id, actor, action, now());
  function eligible(user) {
    const b = user && getBinding(user);
    if (!user || user.banned || (user.role && user.role !== 'user') ||
        user.kyc?.status !== 'approved' || !b?.cardholderApproved || !validId(b.customerId)) {
      throw error('CARD_NOT_ELIGIBLE', 403);
    }
    return b;
  }
  function sameAccount(op, user, allowFreshRebinding = false) {
    const b = eligible(user);
    if (b.customerId !== op.customer_id || (!allowFreshRebinding && b.revision !== op.binding_revision) ||
        digest(user, b) !== op.identity_hash) {
      throw error('CARD_STALE_QUOTE');
    }
    return b;
  }
  function on() {
    if (!enabled || !provider.configured || !kycProvider.configured) throw error('CARD_DISABLED', 503);
  }
  function view(op) {
    if (!op) return null;
    const state = op.state === 'READY' || op.state === 'FAILED' || op.state === 'REVIEW' ? op.state : 'PENDING';
    return { id: op.id, state, code: op.code || null, createdAt: new Date(op.created_at).toISOString(),
      creationFeeUSD: (op.fee_cents / 100).toFixed(2), initialFundingUSD: (op.funding_cents / 100).toFixed(2),
      totalUSD: (op.total_cents / 100).toFixed(2), reservationStatus: state === 'READY' ? 'SETTLED' :
        state === 'FAILED' ? 'RELEASED' : 'VERIFYING',
      card: op.state === 'READY' && op.public_card ? JSON.parse(op.public_card) : null,
      message: state === 'READY' ? 'Kat ou kreye epi verifye. Rezèv la tounen yon sèl peman final.' :
        state === 'FAILED' ? 'Demann lan echwe; pa gen debi final, epi nenpòt rezèv ki te fèt anile.' :
          state === 'REVIEW' ? messages.CARD_REVIEW_REQUIRED : 'Demann ou an kou. Pa fè yon lòt acha.' };
  }
  function owned(userId, id) {
    if (!uuid(id)) throw error('CARD_NOT_FOUND', 404);
    const op = row(id);
    if (!op || op.user_id !== userId) throw error('CARD_NOT_FOUND', 404);
    return op;
  }
  function admin(actor) {
    const fresh = actor && getUser(actor.id);
    if (actor?.role !== 'admin' || fresh?.role !== 'admin' || fresh.banned) throw error('CARD_NOT_ELIGIBLE', 403);
  }
  function current(userId) {
    const user = getUser(userId);
    let approved = false, priceConfigured = false;
    try { eligible(user); approved = true; } catch {}
    try { priceConfigured = Number.isSafeInteger(settings.read().creationPriceCents); } catch {}
    const ops = storage().prepare('SELECT * FROM card_orders WHERE user_id=? ORDER BY created_at DESC LIMIT 10').all(userId);
    return { enabled: Boolean(enabled && provider.configured && kycProvider.configured),
      creationPriceConfigured: priceConfigured, cardholderApproved: approved,
      availableUSD: (Number(user?.usd || 0)).toFixed(2), orders: ops.map(view) };
  }
  function quote(userId, fundingUSD) {
    on();
    const user = getUser(userId), b = eligible(user), funding = usdToCents(fundingUSD);
    if (funding === null) throw error('CARD_INVALID_REQUEST', 400);
    const price = settings.read();
    if (!Number.isSafeInteger(price.creationPriceCents) || !price.revision) throw error('CARD_SETTINGS_UNAVAILABLE', 503);
    const fee = price.creationPriceCents, total = fee + funding;
    if (Math.round(Number(user.usd || 0) * 100) < total) throw error('CARD_INSUFFICIENT');
    const id = crypto.randomUUID(), expires = now() + 3 * 60 * 1000;
    storage().prepare('DELETE FROM card_quotes WHERE expires_at<? AND id NOT IN (SELECT quote_id FROM card_orders)').run(now());
    storage().prepare('INSERT INTO card_quotes VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, userId, b.customerId, b.revision, digest(user, b), price.revision, fee, funding, total, expires);
    return { id, creationFeeUSD: (fee / 100).toFixed(2), initialFundingUSD: (funding / 100).toFixed(2),
      totalUSD: (total / 100).toFixed(2), expiresAt: new Date(expires).toISOString() };
  }
  async function notice(op) {
    if (op.notice_done || !['READY', 'FAILED'].includes(op.state)) return;
    try {
      if (await options.notifyOutcome?.(getUser(op.user_id), {
        id: op.id, state: op.state, totalUSD: (op.total_cents / 100).toFixed(2),
        occurredAt: new Date(now()).toISOString(), providerAttempted: op.attempt_started_at !== null
      })) storage().prepare('UPDATE card_orders SET notice_done=1 WHERE id=?').run(op.id);
    } catch { /* durable pending notice; never affects financial result */ }
  }
  async function refund(op, code, actorId, guard) {
    await wallet.refund(op, guard);
    update(op.id, 'FAILED', code);
    audit(op, actorId, 'RESERVATION_RELEASED');
    await notice(row(op.id));
    return view(row(op.id));
  }
  function verifyCard(op, result, user, allowFreshRebinding = false) {
    sameAccount(op, user, allowFreshRebinding);
    const c = result?.card;
    const expiry = typeof c?.expiry === 'string' && /^(0[1-9]|1[0-2])\/(20\d{2})$/.exec(c.expiry);
    if (!result?.ok || !c || c.customerId !== op.customer_id || c.status !== 'active' ||
        !Number.isSafeInteger(c.balanceCents) || !expiry || Date.UTC(Number(expiry[2]), Number(expiry[1]), 1) <= now() ||
        norm(c.email) !== norm(user.email) || norm(c.holder) !== norm(user.profile.firstName + ' ' + user.profile.lastName) ||
        c.balanceCents < op.funding_cents || Date.parse(c.createdAt) < op.created_at - 300000 ||
        Date.parse(c.createdAt) > now() + 300000) throw error('CARD_REVIEW_REQUIRED');
    return c;
  }
  async function finish(op, cardId, actorId, actor) {
    if (op.card_id && op.card_id !== cardId) throw error('CARD_REVIEW_REQUIRED');
    const result = await provider.details(cardId);
    if (actor) admin(actor);
    const c = verifyCard(op, result, getUser(op.user_id), Boolean(actor));
    if (c.cardId !== cardId) throw error('CARD_REVIEW_REQUIRED');
    const existing = storage().prepare('SELECT id FROM card_orders WHERE card_id=? AND id!=?').get(cardId, op.id);
    if (existing) throw error('CARD_REVIEW_REQUIRED');
    // Save independently verified identity before settlement; no PAN/CVV/URLs.
    const publicCard = { last4: c.last4, expiry: c.expiry, brand: c.brand, status: c.status,
      balanceUSD: (c.balanceCents / 100).toFixed(2), checkedAt: new Date(now()).toISOString() };
    storage().prepare('UPDATE card_orders SET card_id=?,provider_reference=?,public_card=? WHERE id=?')
      .run(cardId, c.reference, JSON.stringify(publicCard), op.id);
    await wallet.settle(op, (u) => { if (actor) admin(actor); sameAccount(op, u, Boolean(actor)); });
    update(op.id, 'READY');
    audit(op, actorId, 'VERIFIED_CARD_SETTLED');
    await notice(row(op.id));
    return view(row(op.id));
  }
  async function create(userId, input) {
    on();
    if (!uuid(input?.quoteId) || !uuid(input?.requestKey) || input.consent !== true ||
        usdToCents(input.acceptedTotalUSD) === null) throw error('CARD_INVALID_REQUEST', 400);
    const prior = storage().prepare('SELECT * FROM card_orders WHERE user_id=? AND request_key=?').get(userId, input.requestKey);
    if (prior) return view(prior);
    const active = storage().prepare("SELECT * FROM card_orders WHERE user_id=? AND state!='FAILED'").get(userId);
    if (active) return view(active);
    const q = storage().prepare('SELECT * FROM card_quotes WHERE id=? AND user_id=?').get(input.quoteId, userId);
    const price = settings.read();
    if (!q || q.expires_at <= now() || q.price_revision !== price.revision ||
        usdToCents(input.acceptedTotalUSD) !== q.total_cents) throw error('CARD_STALE_QUOTE');
    const op = { ...q, id: crypto.randomUUID(), quote_id: q.id, user_id: userId,
      request_key: input.requestKey, state: 'PREPARING', created_at: now() };
    sameAccount(op, getUser(userId));
    storage().prepare(`INSERT INTO card_orders(
      id,user_id,request_key,quote_id,customer_id,binding_revision,identity_hash,fee_cents,funding_cents,total_cents,state,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(op.id, userId, input.requestKey, q.id, q.customer_id,
      q.binding_revision, q.identity_hash, q.fee_cents, q.funding_cents, q.total_cents, 'PREPARING', op.created_at);
    audit(op, userId, 'CUSTOMER_ACCEPTED_QUOTE');
    activeJobs.set(op.id, true);
    try {
      const user = getUser(userId), kyc = await kycProvider.lookup(user.email);
      const identity = kyc.identity;
      if (!kyc.ok || !kyc.approved || identity?.customer_id !== op.customer_id ||
          norm(identity.email) !== norm(user.email) || norm(identity.first_name) !== norm(user.profile.firstName) ||
          norm(identity.last_name) !== norm(user.profile.lastName)) throw error('CARD_NOT_ELIGIBLE', 403);
      sameAccount(op, getUser(userId));
      if (settings.read().revision !== q.price_revision || q.expires_at <= now()) throw error('CARD_STALE_QUOTE');
      update(op.id, 'RESERVING');
      await wallet.reserve(op, (u) => sameAccount(op, u));
      const fresh = getUser(userId);
      sameAccount(op, fresh);
      // A FULL synchronous commit records intent BEFORE the sole provider POST.
      // From this point all uncertain outcomes remain REVIEW, never auto-retry.
      storage().prepare("UPDATE card_orders SET state='SUBMITTING',attempt_started_at=? WHERE id=?").run(now(), op.id);
      const result = await provider.create({ customerId: op.customer_id,
        name: fresh.profile.firstName + ' ' + fresh.profile.lastName, fundingCents: op.funding_cents });
      if (result.rejected) return await refund(op, 'CARD_PROVIDER_REJECTED', userId);
      if (!result.ok || !validId(result.candidateId)) throw error('CARD_REVIEW_REQUIRED');
      storage().prepare('UPDATE card_orders SET candidate_id=? WHERE id=?').run(result.candidateId, op.id);
      return await finish(op, result.candidateId, userId);
    } catch (e) {
      const saved = row(op.id);
      if (saved.attempt_started_at === null && e.code !== 'CARD_WALLET_UNCERTAIN') {
        try { return await refund(op, Object.hasOwn(messages, e.code) ? e.code : 'CARD_INTERNAL_ERROR', userId); }
        catch { /* leave durable unresolved reservation for recovery */ }
      }
      update(op.id, 'REVIEW', e.code === 'CARD_WALLET_UNCERTAIN' ? e.code : 'CARD_REVIEW_REQUIRED');
      return view(row(op.id));
    } finally { activeJobs.delete(op.id); }
  }
  async function reconcile(actor, id, cardId) {
    admin(actor);
    if (!uuid(id) || !validId(cardId)) throw error('CARD_INVALID_REQUEST', 400);
    const op = row(id);
    if (!op || op.state === 'FAILED') throw error('CARD_NOT_FOUND', 404);
    if (activeJobs.has(id)) throw error('CARD_BUSY');
    if (op.state === 'READY') return view(op);
    if (op.attempt_started_at === null) throw error('CARD_REVIEW_REQUIRED');
    activeJobs.set(id, true);
    try {
      audit(op, actor.id, 'ADMIN_READ_ONLY_RECONCILIATION');
      return await finish(op, cardId, actor.id, actor);
    } finally { activeJobs.delete(id); }
  }
  async function release(actor, id, confirmation) {
    admin(actor);
    if (!uuid(id) || confirmation !== 'CONFIRMED_NO_CARD_IN_ZIIROPAY') throw error('CARD_INVALID_REQUEST', 400);
    const op = row(id);
    if (!op || op.state === 'READY') throw error('CARD_NOT_FOUND', 404);
    if (op.card_id) throw error('CARD_REVIEW_REQUIRED');
    if (op.state === 'FAILED') return view(op);
    if (activeJobs.has(id)) throw error('CARD_BUSY');
    activeJobs.set(id, true);
    try {
      audit(op, actor.id, 'ADMIN_ATTESTED_NO_PROVIDER_CARD');
      return await refund(op, 'ADMIN_CONFIRMED_NO_CARD', actor.id, () => admin(actor));
    } finally { activeJobs.delete(id); }
  }
  async function recover() {
    if (recovering || (!db && !fs.existsSync(path.join(dataDir, 'virtual-card-orders.sqlite')))) return;
    recovering = true;
    try {
      for (const op of storage().prepare("SELECT * FROM card_orders WHERE state NOT IN ('READY','FAILED') LIMIT 25").all()) {
        if (activeJobs.has(op.id)) continue;
        activeJobs.set(op.id, true);
        try {
          if (op.attempt_started_at === null) await refund(op, 'INTERRUPTED_BEFORE_SEND', 'system');
          else update(op.id, 'REVIEW', 'CARD_REVIEW_REQUIRED');
        } catch { update(op.id, 'REVIEW', 'CARD_WALLET_UNCERTAIN'); }
        finally { activeJobs.delete(op.id); }
      }
      for (const op of storage().prepare("SELECT * FROM card_orders WHERE state IN ('READY','FAILED') AND notice_done=0 LIMIT 10").all()) {
        if (!activeJobs.has(op.id)) await notice(op);
      }
    } finally { recovering = false; }
  }
  async function reveal(userId, id) {
    const op = owned(userId, id);
    if (op.state !== 'READY') throw error('CARD_REVEAL_UNAVAILABLE', 409);
    const result = await provider.details(op.card_id, true);
    const card = verifyCard({ ...op, funding_cents: 0 }, result, getUser(userId), true);
    if (!card.number || !card.cvv) throw error('CARD_REVEAL_UNAVAILABLE', 503);
    return { number: card.number, cvv: card.cvv, expiry: card.expiry, expiresInSeconds: 30 };
  }
  return { quote, create, current, reconcile, release, recover, reveal,
    adminList(actor, userId) {
      admin(actor);
      if (typeof userId !== 'string' || userId.length > 128) throw error('CARD_INVALID_REQUEST', 400);
      return { orders: storage().prepare('SELECT * FROM card_orders WHERE user_id=? ORDER BY created_at DESC LIMIT 10').all(userId).map(view) };
    },
    close() { if (db) { db.close(); db = undefined; } }
  };
}

function mountCardOrders(app, { service, auth, adminOnly, pinGuard, rateLimit, pageFile, scriptFile }) {
  const privateHeaders = (req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' }); next();
  };
  const handler = (fn) => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) {
      const code = Object.hasOwn(messages, e.code) ? e.code : 'CARD_INTERNAL_ERROR';
      res.status(Object.hasOwn(messages, e.code) ? e.status || 503 : 503).json({ code, error: messages[code] });
    }
  };
  const ajax = (req, res, next) => req.get('X-Requested-With') === 'XMLHttpRequest'
    ? next() : res.status(403).json({ error: 'Demann lan pa otorize.' });
  const strict = (fields) => (req, res, next) => {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).some((k) => !fields.includes(k)) ||
        fields.some((k) => !Object.hasOwn(req.body, k))) return res.status(400).json({ error: messages.CARD_INVALID_REQUEST });
    next();
  };
  app.get('/virtual-card.html', privateHeaders, auth, (req, res) => {
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
    res.sendFile(pageFile);
  });
  app.get('/virtual-card.js', (req, res) => res.sendFile(scriptFile));
  app.get('/api/virtual-cards/orders', privateHeaders, auth, handler((req) => service.current(req.user.id)));
  app.post('/api/virtual-cards/quote', privateHeaders, auth, ajax, rateLimit(20, 15 * 60 * 1000),
    strict(['initialFundingUSD']), handler((req) => service.quote(req.user.id, req.body.initialFundingUSD)));
  app.post('/api/virtual-cards/orders', privateHeaders, auth, ajax, rateLimit(10, 15 * 60 * 1000),
    strict(['quoteId', 'requestKey', 'acceptedTotalUSD', 'consent', 'pin']), pinGuard,
    handler((req) => service.create(req.user.id, { quoteId: req.body.quoteId, requestKey: req.body.requestKey,
      acceptedTotalUSD: req.body.acceptedTotalUSD, consent: req.body.consent })));
  app.post('/api/virtual-cards/orders/:id/reveal', privateHeaders, auth, ajax, rateLimit(10, 15 * 60 * 1000),
    strict(['pin']), pinGuard, handler((req) => service.reveal(req.user.id, req.params.id)));
  app.get('/api/admin/virtual-cards/orders', privateHeaders, adminOnly, handler((req) => service.adminList(req.user, req.query.userId)));
  app.post('/api/admin/virtual-cards/orders/:id/reconcile', privateHeaders, adminOnly, ajax, rateLimit(10, 15 * 60 * 1000),
    strict(['cardId', 'pin']), pinGuard, handler((req) => service.reconcile(req.user, req.params.id, req.body.cardId)));
  app.post('/api/admin/virtual-cards/orders/:id/refund', privateHeaders, adminOnly, ajax, rateLimit(10, 15 * 60 * 1000),
    strict(['confirmation', 'pin']), pinGuard, handler((req) => service.release(req.user, req.params.id, req.body.confirmation)));
}

module.exports = { createCardOrders, mountCardOrders, messages };
