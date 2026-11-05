'use strict';

// Admin creates/approves the cardholder on ZiiroPay, then pastes its ID here.
// Only read-only provider verification; no KYC submission or financial calls.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createKycProvider } = require('./ziiropay-kyc');
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
const normalize = (value) => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(value);

function eligibility(user) {
  if (!user || user.banned || (user.role && user.role !== 'user')) return 'CARDHOLDER_CUSTOMER_REQUIRED';
  if (user.emailVerificationRequired === true && !user.emailVerifiedAt) return 'CARDHOLDER_EMAIL_REQUIRED';
  if (user.kyc?.status !== 'approved') return 'CARDHOLDER_LOCAL_KYC_REQUIRED';
  if (![user.email, user.profile?.firstName, user.profile?.lastName].every((v) =>
    typeof v === 'string' && v.trim() && v.length <= 254 && !/[\u0000-\u001f\u007f<>]/.test(v))) return 'CARDHOLDER_PROFILE_REQUIRED';
  return null;
}
function fingerprint(user) {
  return hash(JSON.stringify([user.id, normalize(user.email), normalize(user.profile.firstName),
    normalize(user.profile.lastName), user.kyc.submittedAt ?? null]));
}
function createManualCardholders(options) {
  const provider = options.provider ?? createKycProvider();
  let db;
  const notificationJobs = new Map();
  const storage = () => {
    if (db) return db;
    fs.mkdirSync(options.dataDir, { recursive: true });
    const file = path.join(options.dataDir, 'ziiropay-cardholders.sqlite');
    db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cardholders (
        user_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL UNIQUE,
        email_tag TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
        revision TEXT NOT NULL UNIQUE, verified_at TEXT NOT NULL,
        admin_id TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS cardholder_audit (
        revision TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        admin_id TEXT NOT NULL, action TEXT NOT NULL, occurred_at TEXT NOT NULL
      );`);
    return db;
  };
  const rowFor = (id) => storage().prepare('SELECT * FROM cardholders WHERE user_id=?').get(id);
  const ready = (user, row) => Boolean(row && !eligibility(user) && fingerprint(user) === row.fingerprint);
  function view(user, admin = false) {
    if (!user) throw fail('CARDHOLDER_NOT_FOUND', 404);
    const row = rowFor(user.id), approved = ready(user, row);
    return {
      linked: Boolean(row), cardholderApproved: approved,
      status: approved ? 'CARDHOLDER_APPROVED' : row ? 'REVIEW_REQUIRED' : 'NOT_LINKED',
      cardOperationsEnabled: false,
      ...(admin ? { customerId: row?.customer_id ?? null, revision: row?.revision ?? null,
        verifiedAt: row?.verified_at ?? null, code: eligibility(user), notificationPending: Boolean(row && !row.notified) } : {})
    };
  }
  async function deliverOnce(row) {
    const user = options.getUser(row.user_id);
    if (!ready(user, row) || typeof options.notifyLinked !== 'function') return false;
    try {
      if (await options.notifyLinked(user, { revision: row.revision, verifiedAt: row.verified_at }) !== true) return false;
      storage().prepare('UPDATE cardholders SET notified=1 WHERE user_id=? AND revision=?').run(row.user_id, row.revision);
      return true;
    } catch { return false; } // Notification failure never undoes a verified association.
  }
  function deliver(row) {
    if (notificationJobs.has(row.revision)) return notificationJobs.get(row.revision);
    const job = deliverOnce(row).finally(() => notificationJobs.delete(row.revision));
    notificationJobs.set(row.revision, job);
    return job;
  }
  return {
    status: view,
    async link(actor, userId, body) {
      if (actor?.role !== 'admin' || actor.banned) throw fail('CARDHOLDER_ADMIN_REQUIRED', 403);
      if (!body || Array.isArray(body) || typeof body !== 'object' ||
          Object.keys(body).some((k) => !['customerId', 'revision'].includes(k)) ||
          !validId(body.customerId) ||
          !(body.revision === null || (typeof body.revision === 'string' && /^[a-f0-9-]{36}$/.test(body.revision)))) {
        throw fail('CARDHOLDER_INVALID_FIELDS');
      }
      let user = options.getUser(userId);
      const issue = eligibility(user);
      if (issue) throw fail(issue, user ? 403 : 404);
      if (provider.configured !== true) throw fail('CARDHOLDER_PROVIDER_UNAVAILABLE', 503);
      const before = rowFor(userId);
      if ((before?.revision ?? null) !== body.revision) throw fail('CARDHOLDER_STALE', 409);
      if (before && before.customer_id !== body.customerId) throw fail('CARDHOLDER_ALREADY_LINKED', 409);
      const expected = fingerprint(user);
      let result;
      try { result = await provider.lookup(user.email.trim().toLowerCase()); } catch {}
      if (!result?.ok) throw fail('CARDHOLDER_PROVIDER_UNAVAILABLE', 503);
      const reviewPrevious = () => {
        if (before) storage().prepare("UPDATE cardholders SET fingerprint='REVIEW_REQUIRED' WHERE user_id=? AND revision=?")
          .run(userId, before.revision);
      };
      if (result.approved !== true) {
        reviewPrevious(); throw fail('CARDHOLDER_NOT_APPROVED', 409);
      }
      const identity = result.identity;
      if (!identity || identity.customer_id !== body.customerId ||
          normalize(identity.email) !== normalize(user.email) ||
          normalize(identity.first_name) !== normalize(user.profile.firstName) ||
          normalize(identity.last_name) !== normalize(user.profile.lastName)) {
        reviewPrevious(); throw fail('CARDHOLDER_IDENTITY_MISMATCH', 409);
      }
      user = options.getUser(userId);
      if (eligibility(user) || fingerprint(user) !== expected) throw fail('CARDHOLDER_ACCOUNT_CHANGED', 409);
      const latestActor = options.getUser(actor.id);
      if (latestActor?.role !== 'admin' || latestActor.banned) throw fail('CARDHOLDER_ADMIN_REQUIRED', 403);
      const connection = storage();
      connection.exec('BEGIN IMMEDIATE');
      let row;
      try {
        row = rowFor(userId);
        if ((row?.revision ?? null) !== body.revision) {
          // Identical concurrent submissions are harmless; no second notice.
          if (!row || row.customer_id !== body.customerId || row.fingerprint !== expected) throw fail('CARDHOLDER_STALE', 409);
        } else if (!row || row.fingerprint !== expected) {
          const revision = crypto.randomUUID(), now = new Date().toISOString();
          if (!row) {
            connection.prepare(`INSERT INTO cardholders
              (user_id,customer_id,email_tag,fingerprint,revision,verified_at,admin_id)
              VALUES(?,?,?,?,?,?,?)`).run(userId, body.customerId, hash(normalize(user.email)), expected, revision, now, actor.id);
          } else {
            connection.prepare(`UPDATE cardholders SET email_tag=?,fingerprint=?,revision=?,verified_at=?,admin_id=?,notified=0
              WHERE user_id=?`).run(hash(normalize(user.email)), expected, revision, now, actor.id, userId);
          }
          connection.prepare('INSERT INTO cardholder_audit VALUES(?,?,?,?,?)')
            .run(revision, userId, actor.id, row ? 'REVERIFIED' : 'LINKED', now);
          row = rowFor(userId);
        }
        connection.exec('COMMIT');
      } catch (e) {
        try { connection.exec('ROLLBACK'); } catch {}
        if (e.code?.startsWith('CARDHOLDER_')) throw e;
        if ([1555, 2067].includes(e.errcode)) throw fail('CARDHOLDER_ASSOCIATION_CONFLICT', 409);
        throw fail('CARDHOLDER_STORAGE_UNAVAILABLE', 503);
      }
      if (!row.notified) await deliver(row);
      return view(options.getUser(userId), true);
    },
    async retryNotifications() {
      if (!db && !fs.existsSync(path.join(options.dataDir, 'ziiropay-cardholders.sqlite'))) return 0;
      storage();
      let delivered = 0;
      for (const row of db.prepare('SELECT * FROM cardholders WHERE notified=0 LIMIT 10').all()) {
        if (await deliver(row)) delivered++;
      }
      return delivered;
    },
    close() { if (db) db.close(); db = undefined; }
  };
}
function mountManualCardholders(app, { service, auth, adminOnly, rateLimit, issuanceEnabled = false }) {
  const privateRoute = (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); };
  const messages = {
    CARDHOLDER_ADMIN_REQUIRED: 'Se admin sèlman ki kapab asosye yon cardholder.',
    CARDHOLDER_CUSTOMER_REQUIRED: 'Chwazi yon kliyan aktif, pa yon kont staff.',
    CARDHOLDER_EMAIL_REQUIRED: 'Kliyan an dwe verifye imèl li.',
    CARDHOLDER_LOCAL_KYC_REQUIRED: 'KYC Morningstar kliyan an dwe apwouve.',
    CARDHOLDER_PROFILE_REQUIRED: 'Non, siyati ak imèl kliyan an dwe konplè.',
    CARDHOLDER_INVALID_FIELDS: 'Customer ID a oswa vèsyon dosye a pa valid.',
    CARDHOLDER_NOT_FOUND: 'Kliyan an pa jwenn.',
    CARDHOLDER_STALE: 'Dosye a fèk chanje. Rechaje li.',
    CARDHOLDER_ALREADY_LINKED: 'Kont sa a deja asosye ak yon lòt Customer ID.',
    CARDHOLDER_NOT_APPROVED: 'Cardholder la poko apwouve sou ZiiroPay.',
    CARDHOLDER_IDENTITY_MISMATCH: 'Customer ID, imèl oswa non ZiiroPay yo pa koresponn ak kliyan sa a.',
    CARDHOLDER_ACCOUNT_CHANGED: 'Enfòmasyon kliyan an chanje pandan verifikasyon an. Rechaje li.',
    CARDHOLDER_ASSOCIATION_CONFLICT: 'Customer ID oswa imèl sa a deja asosye ak yon lòt kont.',
    CARDHOLDER_STORAGE_UNAVAILABLE: 'Dosye a pa ka sove kounye a. Rechaje estati a pou verifye.',
    CARDHOLDER_PROVIDER_UNAVAILABLE: 'Verifikasyon ZiiroPay pa disponib. Pa gen asosiyasyon ki sove.'
  };
  const handle = (fn) => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) {
      const safe = Object.hasOwn(messages, e.code);
      res.status(safe ? e.status : 503).json({ code: safe ? e.code : 'CARDHOLDER_UNAVAILABLE',
        error: safe ? messages[e.code] : 'Dosye cardholder la pa disponib. Rechaje li pou verifye estati a.' });
    }
  };
  app.get('/api/admin/users/:id/cardholder', privateRoute, adminOnly,
    handle((req) => ({ ...service.status(req.users.find((u) => u.id === req.params.id), true),
      cardOperationsEnabled: Boolean(issuanceEnabled) })));
  app.post('/api/admin/users/:id/cardholder', privateRoute, adminOnly, (req, res, next) => {
    if (req.get('X-Requested-With') !== 'XMLHttpRequest') return res.status(403).json({ error: 'Demann lan pa otorize.' });
    next();
  }, rateLimit(10, 15 * 60 * 1000), handle(async (req) => ({
    ...await service.link(req.user, req.params.id, req.body), cardOperationsEnabled: Boolean(issuanceEnabled)
  })));
  app.get('/api/virtual-cards/cardholder', privateRoute, auth, handle((req) => ({
    ...service.status(req.user), cardOperationsEnabled: Boolean(issuanceEnabled)
  })));
}
module.exports = { createManualCardholders, mountManualCardholders };
