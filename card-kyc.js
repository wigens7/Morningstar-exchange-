'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createKycProvider } = require('./ziiropay-kyc');

const CONSENT_VERSION = 'morningstar-ziiropay-card-kyc-v1';
const EXTRA = ['id_number', 'dial_code', 'country', 'state', 'postal_code', 'city',
  'occupation', 'employment_status', 'account_purpose', 'annual_salary',
  'expected_monthly_volume', 'place_of_birth'];
const TYPES = { national_id: 'national_id', driver_license: 'drivers_license', passport: 'passport' };
// ISO 3166-1 alpha-2 (stored by settings.html) -> alpha-3 (provider contract).
const COUNTRY3 = Object.fromEntries(('AD:AND AE:ARE AF:AFG AG:ATG AI:AIA AL:ALB AM:ARM AO:AGO AR:ARG AS:ASM AT:AUT AU:AUS AW:ABW AX:ALA AZ:AZE ' +
  'BA:BIH BB:BRB BD:BGD BE:BEL BF:BFA BG:BGR BH:BHR BI:BDI BJ:BEN BL:BLM BM:BMU BN:BRN BO:BOL BQ:BES BR:BRA BS:BHS BT:BTN BW:BWA BY:BLR BZ:BLZ ' +
  'CA:CAN CC:CCK CD:COD CF:CAF CG:COG CH:CHE CI:CIV CK:COK CL:CHL CM:CMR CN:CHN CO:COL CR:CRI CU:CUB CV:CPV CW:CUW CX:CXR CY:CYP CZ:CZE ' +
  'DE:DEU DJ:DJI DK:DNK DM:DMA DO:DOM DZ:DZA EC:ECU EE:EST EG:EGY EH:ESH ER:ERI ES:ESP ET:ETH FI:FIN FJ:FJI FK:FLK FM:FSM FO:FRO FR:FRA ' +
  'GA:GAB GB:GBR GD:GRD GE:GEO GF:GUF GG:GGY GH:GHA GI:GIB GL:GRL GM:GMB GN:GIN GP:GLP GQ:GNQ GR:GRC GT:GTM GU:GUM GW:GNB GY:GUY ' +
  'HK:HKG HN:HND HR:HRV HT:HTI HU:HUN ID:IDN IE:IRL IL:ISR IM:IMN IN:IND IO:IOT IQ:IRQ IR:IRN IS:ISL IT:ITA JE:JEY JM:JAM JO:JOR JP:JPN ' +
  'KE:KEN KG:KGZ KH:KHM KI:KIR KM:COM KN:KNA KP:PRK KR:KOR KW:KWT KY:CYM KZ:KAZ LA:LAO LB:LBN LC:LCA LI:LIE LK:LKA LR:LBR LS:LSO LT:LTU LU:LUX LV:LVA LY:LBY ' +
  'MA:MAR MC:MCO MD:MDA ME:MNE MF:MAF MG:MDG MH:MHL MK:MKD ML:MLI MM:MMR MN:MNG MO:MAC MP:MNP MQ:MTQ MR:MRT MS:MSR MT:MLT MU:MUS MV:MDV MW:MWI MX:MEX MY:MYS MZ:MOZ ' +
  'NA:NAM NC:NCL NE:NER NF:NFK NG:NGA NI:NIC NL:NLD NO:NOR NP:NPL NR:NRU NU:NIU NZ:NZL OM:OMN PA:PAN PE:PER PF:PYF PG:PNG PH:PHL PK:PAK PL:POL PM:SPM PN:PCN PR:PRI PS:PSE PT:PRT PW:PLW PY:PRY ' +
  'QA:QAT RE:REU RO:ROU RS:SRB RU:RUS RW:RWA SA:SAU SB:SLB SC:SYC SD:SDN SE:SWE SG:SGP SH:SHN SI:SVN SJ:SJM SK:SVK SL:SLE SM:SMR SN:SEN SO:SOM SR:SUR SS:SSD ST:STP SV:SLV SX:SXM SY:SYR SZ:SWZ ' +
  'TC:TCA TD:TCD TG:TGO TH:THA TJ:TJK TK:TKL TL:TLS TM:TKM TN:TUN TO:TON TR:TUR TT:TTO TV:TUV TW:TWN TZ:TZA UA:UKR UG:UGA US:USA UY:URY UZ:UZB VA:VAT VC:VCT VE:VEN VG:VGB VI:VIR VN:VNM VU:VUT WF:WLF WS:WSM YE:YEM YT:MYT ZA:ZAF ZM:ZMB ZW:ZWE').split(' ').map((v) => v.split(':')));
const norm = (v) => String(v).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const digits = (v) => String(v).replace(/\D/g, '');
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
function country3(value) {
  const code = String(value || '').trim().toUpperCase();
  if (COUNTRY3[code]) return COUNTRY3[code];
  if (Object.values(COUNTRY3).includes(code)) return code;
  return ['haiti', 'haïti', 'ayiti'].includes(norm(value)) ? 'HTI' : null;
}

function eligibility(user) {
  if (!user || user.banned || (user.role && user.role !== 'user')) return 'CUSTOMER_REQUIRED';
  if (user.emailVerified !== true) return 'VERIFIED_EMAIL_REQUIRED';
  if (user.kyc?.status !== 'approved' || !TYPES[user.kyc.idType]) return 'LOCAL_KYC_REQUIRED';
  if (!user.profile || !user.pinActive || !user.pinHash) return 'PROFILE_PIN_REQUIRED';
  return null;
}

function validateSubmission(user, body) {
  const issue = eligibility(user);
  if (issue) throw fail(issue, 403);
  if (!body || Array.isArray(body) || typeof body !== 'object' ||
      Object.keys(body).some((k) => ![...EXTRA, 'consent', 'consentVersion', 'pin'].includes(k))) throw fail('INVALID_KYC_FIELDS');
  if (body.consent !== true || body.consentVersion !== CONSENT_VERSION) throw fail('CONSENT_REQUIRED');
  const fields = {};
  for (const k of EXTRA) {
    if (typeof body[k] !== 'string') throw fail('INVALID_KYC_FIELDS');
    const text = body[k].normalize('NFKC').trim();
    if (!text || text.length > (k === 'account_purpose' ? 200 : 100) || /[\u0000-\u001f\u007f<>]/.test(text)) throw fail('INVALID_KYC_FIELDS');
    fields[k] = text;
  }
  if (!/^[A-Z]{3}$/.test(fields.country) || !/^\+[1-9]\d{0,3}$/.test(fields.dial_code) ||
      !/^[a-z][a-z0-9_]{1,59}$/.test(fields.occupation) ||
      !/^[a-z][a-z0-9_]{1,59}$/.test(fields.employment_status) ||
      !/^\d{1,12}(?:\.\d{1,2})?$/.test(fields.annual_salary) ||
      !/^\d{1,12}(?:\.\d{1,2})?$/.test(fields.expected_monthly_volume)) throw fail('INVALID_KYC_FIELDS');
  const p = user.profile;
  for (const v of [p.firstName, p.lastName, p.address, user.email, p.phone, p.dob]) {
    if (typeof v !== 'string' || !v.trim() || v.length > 254 || /[\u0000-\u001f\u007f<>]/.test(v)) throw fail('INVALID_PROFILE', 403);
  }
  const date = new Date(p.dob + 'T00:00:00Z');
  const today = new Date();
  const adult = new Date(Date.UTC(today.getUTCFullYear() - 18, today.getUTCMonth(), today.getUTCDate()));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.dob) || !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== p.dob || date > adult || date.getUTCFullYear() < 1900) throw fail('INVALID_PROFILE', 403);
  const dial = digits(fields.dial_code);
  const phone = digits(p.phone);
  if (!/^\d{6,15}$/.test(phone) || (p.phone.startsWith('+') && !phone.startsWith(dial))) throw fail('INVALID_PHONE');
  const international = phone.startsWith(dial) ? phone : dial + phone;
  if (international.length > 15) throw fail('INVALID_PHONE');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) throw fail('INVALID_PROFILE', 403);
  if (!country3(p.country) || fields.country !== country3(p.country)) throw fail('INVALID_KYC_FIELDS');
  return { ...fields, first_name: p.firstName.trim(), last_name: p.lastName.trim(),
    email: user.email.trim().toLowerCase(), phone_number: international, date_of_birth: p.dob,
    line1: p.address.trim(), id_type: TYPES[user.kyc.idType] };
}

function createKycStore(dataDir, keyHex) {
  if (typeof keyHex !== 'string' || !/^[a-fA-F0-9]{64}$/.test(keyHex)) throw fail('KYC_STORAGE_UNAVAILABLE', 503);
  const key = Buffer.from(keyHex, 'hex');
  const tag = (value) => crypto.createHmac('sha256', key).update(value).digest('hex');
  const dir = path.join(dataDir, 'card-kyc');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'kyc.sqlite');
  const db = new DatabaseSync(file);
  fs.chmodSync(file, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS key_check (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS applications (
      user_id TEXT PRIMARY KEY, email_tag TEXT NOT NULL UNIQUE, customer_tag TEXT UNIQUE,
      phase TEXT NOT NULL CHECK(phase IN ('SUBMITTING','PENDING','UNKNOWN','REVIEW_REQUIRED','APPROVED')),
      encrypted TEXT NOT NULL, next_check INTEGER NOT NULL DEFAULT 0,
      check_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );`);
  db.prepare('INSERT OR IGNORE INTO key_check(id,fingerprint) VALUES(1,?)').run(tag('key-check-v1'));
  if (db.prepare('SELECT fingerprint FROM key_check WHERE id=1').get().fingerprint !== tag('key-check-v1')) {
    db.close(); throw fail('KYC_STORAGE_UNAVAILABLE', 503);
  }
  const encrypt = (userId, value) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('card-kyc-v1:' + userId));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  };
  const decrypt = (row) => {
    const data = Buffer.from(row.encrypted, 'base64');
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    cipher.setAAD(Buffer.from('card-kyc-v1:' + row.user_id));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'));
  };
  function get(userId) {
    const row = db.prepare('SELECT * FROM applications WHERE user_id=?').get(userId);
    if (!row) return null;
    try { return { ...row, value: decrypt(row) }; }
    catch { throw fail('KYC_STORAGE_UNAVAILABLE', 503); }
  }
  return {
    get,
    begin(userId, value) {
      const encrypted = encrypt(userId, value);
      const inserted = db.prepare(`INSERT OR IGNORE INTO applications(user_id,email_tag,phase,encrypted,created_at)
        VALUES(?,?,'SUBMITTING',?,?)`).run(userId, tag('email:' + value.identity.email), encrypted, Date.now()).changes;
      if (!inserted && !get(userId)) throw fail('KYC_ASSOCIATION_CONFLICT', 409);
      return inserted === 1;
    },
    submitted(userId, received) {
      db.prepare("UPDATE applications SET phase=? WHERE user_id=? AND phase='SUBMITTING'").run(received ? 'PENDING' : 'UNKNOWN', userId);
    },
    claimCheck(userId, now) {
      return db.prepare(`UPDATE applications SET next_check=?,check_count=check_count+1
        WHERE user_id=? AND next_check<=? AND phase!='APPROVED' AND check_count<24 AND created_at>=?`)
        .run(now + 5 * 60 * 1000, userId, now, now - 24 * 60 * 60 * 1000).changes === 1;
    },
    dueUsers(now) {
      return db.prepare(`SELECT user_id FROM applications WHERE phase IN ('SUBMITTING','PENDING','UNKNOWN')
        AND next_check<=? AND check_count<24 AND created_at>=? ORDER BY next_check,user_id LIMIT 10`)
        .all(now, now - 24 * 60 * 60 * 1000).map((r) => r.user_id);
    },
    review(userId) { db.prepare("UPDATE applications SET phase='REVIEW_REQUIRED' WHERE user_id=? AND phase!='APPROVED'").run(userId); },
    bind(userId, customerId, verifiedAt) {
      const row = get(userId);
      if (!row) throw fail('KYC_NOT_SUBMITTED', 409);
      if (row.phase === 'APPROVED') return row.value.customerId === customerId;
      const encrypted = encrypt(userId, { ...row.value, customerId, verifiedAt });
      try {
        return db.prepare("UPDATE applications SET phase='APPROVED',customer_tag=?,encrypted=? WHERE user_id=? AND phase!='APPROVED'")
          .run(tag('customer:' + customerId), encrypted, userId).changes === 1;
      } catch {
        db.prepare("UPDATE applications SET phase='REVIEW_REQUIRED' WHERE user_id=? AND phase!='APPROVED'").run(userId);
        return false;
      }
    },
    close() { db.close(); key.fill(0); }
  };
}

function identityMatches(actual, expected) {
  if (!actual) return false;
  for (const k of ['first_name', 'last_name', 'email', 'country']) {
    if (typeof actual[k] !== 'string' || norm(actual[k]) !== norm(expected[k])) return false;
  }
  if (actual.dial_code !== expected.dial_code) return false;
  const phone = digits(actual.phone_number);
  return phone === expected.phone_number || digits(actual.dial_code) + phone === expected.phone_number;
}

function accountUnchanged(user, value) {
  const p = user.profile, identity = value.identity;
  const phone = digits(p.phone), dial = digits(identity.dial_code);
  return norm(user.email) === norm(identity.email) && norm(p.firstName) === norm(identity.first_name) &&
    norm(p.lastName) === norm(identity.last_name) && p.dob === identity.date_of_birth &&
    norm(p.address) === norm(identity.line1) && country3(p.country) === identity.country &&
    (phone.startsWith(dial) ? phone : dial + phone) === identity.phone_number &&
    TYPES[user.kyc.idType] === identity.id_type &&
    (user.kyc.submittedAt ?? null) === value.localKycSubmittedAt;
}

function createCardKyc(options) {
  const provider = options.provider ?? createKycProvider();
  const keyHex = options.keyHex ?? process.env.ZIIROPAY_KYC_ENCRYPTION_KEY ?? '';
  const enabled = (options.enabled ?? process.env.ZIIROPAY_KYC_ENABLED) === 'true' &&
    (options.mode ?? process.env.ZIIROPAY_KYC_MODE) === 'live' &&
    /^[a-fA-F0-9]{64}$/.test(keyHex) && provider.configured === true;
  let store;
  let checking = false;
  const storage = () => store ?? (store = createKycStore(options.dataDir, keyHex));
  function status(user) {
    if (!enabled) return { enabled: false, status: 'DISABLED', consentVersion: CONSENT_VERSION };
    const reason = eligibility(user);
    if (reason) return { enabled: true, eligible: false, status: 'INELIGIBLE', code: reason, consentVersion: CONSENT_VERSION };
    const row = storage().get(user.id);
    if (row && !accountUnchanged(user, row.value)) {
      return { enabled: true, eligible: false, status: 'REVIEW_REQUIRED', code: 'KYC_IDENTITY_CHANGED', consentVersion: CONSENT_VERSION };
    }
    return { enabled: true, eligible: true, status: row?.phase ?? 'NOT_SUBMITTED', consentVersion: CONSENT_VERSION,
      verificationPaused: Boolean(row && row.phase !== 'APPROVED' &&
        (row.check_count >= 24 || row.created_at < Date.now() - 24 * 60 * 60 * 1000)) };
  }
  function requireEnabled(user) {
    if (!enabled) throw fail('CARD_KYC_NOT_ENABLED', 503);
    const issue = eligibility(user);
    if (issue) throw fail(issue, 403);
  }
  const service = {
    enabled, status,
    context(user) {
      const result = status(user);
      return result.enabled && result.eligible ? { ...result, identity: {
        firstName: user.profile.firstName, lastName: user.profile.lastName, email: user.email,
        dob: user.profile.dob, phone: user.profile.phone, address: user.profile.address,
        country: user.profile.country, country3: country3(user.profile.country), idType: user.kyc.idType
      } } : result;
    },
    async submit(user, body) {
      requireEnabled(user);
      const identity = validateSubmission(user, body);
      if (storage().get(user.id)) return status(user); // Never retransmit, even after timeout/redeploy.
      const document = await options.readDocument(user);
      if (!document || !Buffer.isBuffer(document.buffer) || document.buffer.length < 13 ||
          document.buffer.length > 5 * 1024 * 1024 || !options.detectExt(document.buffer)) throw fail('APPROVED_DOCUMENT_UNAVAILABLE', 409);
      const saved = { identity, documentHash: crypto.createHash('sha256').update(document.buffer).digest('hex'),
        localKycSubmittedAt: user.kyc.submittedAt ?? null,
        consent: { version: CONSENT_VERSION, accepted: true, recipient: 'ZiiroPay',
          purpose: 'virtual-card-kyc', userId: user.id, acceptedAt: new Date().toISOString() } };
      if (typeof options.getUser === 'function') {
        const latest = options.getUser(user.id);
        if (!latest || eligibility(latest) || !accountUnchanged(latest, saved)) throw fail('KYC_IDENTITY_CHANGED', 409);
      }
      if (!storage().begin(user.id, saved)) return status(user);
      let result;
      try { result = await provider.submit({ ...identity, id_front_image: document.buffer.toString('base64') }); }
      catch { result = { ok: false }; }
      storage().submitted(user.id, result?.ok === true);
      return status(user);
    },
    async refresh(user) {
      requireEnabled(user);
      const row = storage().get(user.id);
      if (!row) throw fail('KYC_NOT_SUBMITTED', 409);
      if (!accountUnchanged(user, row.value)) {
        storage().review(user.id); throw fail('KYC_IDENTITY_CHANGED', 409);
      }
      if (row.phase === 'APPROVED' || !storage().claimCheck(user.id, Date.now())) return status(user);
      let result;
      try { result = await provider.lookup(row.value.identity.email); } catch { result = { ok: false }; }
      if (!result?.ok || result.approved !== true) return status(user);
      if (!identityMatches(result.identity, row.value.identity) ||
          !/^[A-Za-z0-9_-]{6,128}$/.test(result.identity.customer_id || '')) {
        storage().review(user.id); return status(user);
      }
      storage().bind(user.id, result.identity.customer_id, new Date().toISOString());
      return status(user);
    },
    async runChecks() {
      if (!enabled || checking || typeof options.getUser !== 'function') return 0;
      checking = true;
      let checked = 0;
      try {
        for (const id of storage().dueUsers(Date.now())) {
          try {
            const user = options.getUser(id);
            if (user && !eligibility(user)) { await service.refresh(user); checked++; }
          } catch { /* Erè prive yo pa dwe antre nan logs; pa resoumèt. */ }
        }
      } finally { checking = false; }
      return checked;
    },
    close() { if (store) store.close(); }
  };
  return service;
}

function mountCardKyc(app, { service, auth, pinGuard, rateLimit }) {
  const privateRoute = (req, res, next) => {
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  };
  const ajax = (req, res, next) => {
    if (req.get('X-Requested-With') !== 'XMLHttpRequest') return res.status(403).json({ error: 'Demann lan pa otorize.' });
    next();
  };
  const enabled = (req, res, next) => {
    if (!service.enabled) return res.status(503).json({ code: 'CARD_KYC_NOT_ENABLED', error: 'Soumisyon KYC kat la poko aktive. Pa voye dokiman kounye a.' });
    next();
  };
  const handle = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      const allowed = new Set(['CUSTOMER_REQUIRED', 'VERIFIED_EMAIL_REQUIRED', 'LOCAL_KYC_REQUIRED',
        'PROFILE_PIN_REQUIRED', 'INVALID_KYC_FIELDS', 'CONSENT_REQUIRED', 'INVALID_PROFILE',
        'INVALID_PHONE', 'APPROVED_DOCUMENT_UNAVAILABLE', 'KYC_ASSOCIATION_CONFLICT',
        'KYC_NOT_SUBMITTED', 'KYC_IDENTITY_CHANGED']);
      const code = allowed.has(e.code) ? e.code : 'KYC_UNAVAILABLE';
      res.status(allowed.has(e.code) ? e.status : 503).json({ code, error: 'Demann KYC a pa ka fini. Verifye enfòmasyon yo oswa kontakte sipò. Pa resoumèt yon dosye ki deja voye.' });
    }
  };
  app.get('/api/virtual-cards/kyc', privateRoute, auth, handle(async (req, res) => res.json(service.context(req.user))));
  app.post('/api/virtual-cards/kyc', privateRoute, auth, enabled, ajax, rateLimit(5, 15 * 60 * 1000),
    (req, res, next) => {
      try { validateSubmission(req.user, req.body); next(); }
      catch (e) { res.status(e.status ?? 400).json({ code: e.code, error: 'Enfòmasyon KYC yo oswa konsantman an pa valid.' }); }
    }, pinGuard, handle(async (req, res) => res.status(202).json(await service.submit(req.user, req.body))));
  app.post('/api/virtual-cards/kyc/refresh', privateRoute, auth, enabled, ajax,
    rateLimit(10, 15 * 60 * 1000), handle(async (req, res) => res.json(await service.refresh(req.user))));
}

module.exports = { CONSENT_VERSION, createKycStore, createCardKyc, mountCardKyc, validateSubmission, identityMatches, country3 };
