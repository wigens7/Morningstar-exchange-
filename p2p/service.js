'use strict';
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const SCHEMA = require('./schema');

class P2PError extends Error {
  constructor(code, status, msg) { super(msg || code); this.code = code; this.status = status || 400; }
}
const E = (code, status, msg) => new P2PError(code, status, msg);

const ASSET = 'USDT';
const FIATS = { HTG: ['MonCash', 'NatCash'], USD: ['Zelle', 'CashApp', 'PayPal', 'Meru', 'Wise'] };
const HOUR = 3600e3;
const LATE_CLAIM_WINDOW = 24 * HOUR;
const SELLER_WINDOW = 30 * 60e3;       // tan vandè a gen pou konfime apre achtè a make peman
const STUCK_AFTER = 2 * 60e3;

// Machin eta: eta aktyèl -> eta swivan -> wòl ki gen dwa fè tranzisyon an
const TRANSITIONS = {
  CREATED: { ESCROW_LOCKED: ['SYSTEM'], CANCELLED: ['SYSTEM'] },
  ESCROW_LOCKED: { WAITING_PAYMENT: ['SYSTEM'], CANCELLED: ['SYSTEM'] },
  WAITING_PAYMENT: { PAYMENT_MARKED: ['BUYER', 'SYSTEM'], CANCELLED: ['BUYER'], EXPIRED: ['SYSTEM'] },
  PAYMENT_MARKED: { COMPLETED: ['SELLER'], DISPUTED: ['BUYER', 'SELLER', 'SYSTEM'] },
  EXPIRED: { DISPUTED: ['BUYER', 'SYSTEM'] },
  DISPUTED: { UNDER_REVIEW: ['STAFF'] },
  UNDER_REVIEW: { COMPLETED: ['ADMIN'], CANCELLED: ['ADMIN'] },
  COMPLETED: {}, CANCELLED: {}
};
const PERMS = { admin: ['*'], support: ['p2p.view', 'p2p.chat', 'p2p.dispute.take'] };
const can = (role, perm) => { const l = PERMS[role] || []; return l.includes('*') || l.includes(perm); };

// ---------- inite ----------
function parseUnits(str, dec) {
  const s = String(str == null ? '' : str).trim();
  if (!new RegExp('^\\d{1,12}(\\.\\d{1,' + dec + '})?$').test(s)) throw E('BAD_AMOUNT', 400, 'Montan an pa valid.');
  const [i, f = ''] = s.split('.');
  const n = Number(i + f.padEnd(dec, '0'));
  if (!Number.isSafeInteger(n) || n <= 0) throw E('BAD_AMOUNT', 400, 'Montan an pa valid.');
  return n;
}
const fmtUnits = (n, dec) => { const s = String(n).padStart(dec + 1, '0'); return s.slice(0, -dec) + '.' + s.slice(-dec); };
const micro = (n) => fmtUnits(n, 6);
const cents = (n) => fmtUnits(n, 2);
// kantite fiat (santim) = crypto(micro) * pri(santim/USDT) / 1e6, awondi, san float
const fiatFor = (cryptoMicro, priceCents) => Number((BigInt(cryptoMicro) * BigInt(priceCents) + 500000n) / 1000000n);

function createService(opts = {}) {
  const now = opts.now || (() => Date.now());
  const eligible = opts.eligible || (() => ({ ok: true }));
  const nameOf = opts.nameOf || ((id) => String(id).slice(0, 6));
  const main = opts.main;                       // adaptè balans prensipal la (users.json)
  const hooks = opts.hooks || {};
  const crash = (p) => { if (hooks.crash) hooks.crash(p); };
  const db = new DatabaseSync(opts.dbPath || ':memory:');
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=8000; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  // migrasyon: baz ki te egziste deja pa gen kolòn evidence_id (foto nan chat)
  const addCol = (t, c, d) => { if (!db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`); };
  addCol('messages', 'evidence_id', 'TEXT'); addCol('messages', 'kind', 'TEXT'); addCol('messages', 'read_at', 'INTEGER');
  addCol('ads', 'auto_paused', 'INTEGER NOT NULL DEFAULT 0');

  const q = (sql, ...p) => db.prepare(sql).all(...p);
  const q1 = (sql, ...p) => db.prepare(sql).get(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  // BEGIN IMMEDIATE = yon sèl moun ekri alafwa (menm ant plizyè pwosesis): sa ranplase "row lock".
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  }

  // ---------- odit ----------
  const audit = (actor, role, action, entity, id, details, ip) =>
    run('INSERT INTO audit_log(ts,actor,role,action,entity,entity_id,details,ip) VALUES(?,?,?,?,?,?,?,?)',
      now(), actor || null, role || null, action, entity || null, id == null ? null : String(id), details ? JSON.stringify(details) : null, ip || null);
  const alert = (userId, kind, details) =>
    run('INSERT INTO alerts(ts,user_id,kind,details) VALUES(?,?,?,?)', now(), userId || null, kind, JSON.stringify(details || {}));
  const sysMsg = (orderId, body, kind) => run('INSERT INTO messages(order_id,sender_id,role,body,ts,kind) VALUES(?,?,?,?,?,?)', orderId, null, 'SYSTEM', body, now(), kind || null);
  const requirePerm = (staff, perm) => { if (!staff || !can(staff.role, perm)) throw E('FORBIDDEN', 403, 'Ou pa gen pèmisyon pou aksyon sa a.'); };
  const needReason = (r) => { const s = String(r || '').trim(); if (s.length < 10) throw E('REASON_REQUIRED', 400, 'Yon rezon (omwen 10 karaktè) obligatwa.'); return s.slice(0, 500); };
  const CANCEL_REASONS = new Set(['NO_LONGER_NEEDED', 'PAYMENT_METHOD_ISSUE', 'ORDER_DETAILS_INCORRECT', 'CANNOT_PAY_IN_TIME', 'OTHER']);
  function cancellationReason(value) {
    const code = String(value && typeof value === 'object' ? value.code || '' : value || '').trim();
    const details = String(value && typeof value === 'object' ? value.details || '' : '').trim();
    if (!CANCEL_REASONS.has(code) || details.length > 500 || (code === 'OTHER' && details.length < 10)) {
      throw E('CANCEL_REASON_REQUIRED', 400, 'Chwazi yon rezon pou anilasyon an; si se “Lòt rezon”, bay omwen 10 karaktè.');
    }
    return { code, details };
  }

  // ---------- ledger ----------
  function acct(kind, owner, allowNeg = 0) {
    let a = q1('SELECT * FROM accounts WHERE kind=? AND owner=? AND asset=?', kind, String(owner), ASSET);
    if (!a) {
      const r = run('INSERT INTO accounts(kind,owner,asset,allow_negative) VALUES(?,?,?,?)', kind, String(owner), ASSET, allowNeg);
      a = q1('SELECT * FROM accounts WHERE id=?', r.lastInsertRowid);
    }
    return a;
  }
  // 1 debi + 1 kredi, menm montan. `ref` inik => pa gen doub debi/kredi (idempotan).
  function post(ref, type, orderId, debit, credit, amount, meta) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw E('BAD_AMOUNT', 400, 'Montan an pa valid.');
    if (debit.id === credit.id) throw E('BAD_LEDGER', 500, 'Kont yo dwe diferan.');
    const dup = q1('SELECT id FROM ledger_txs WHERE ref=?', ref);
    if (dup) return { id: dup.id, duplicate: true };
    const id = run('INSERT INTO ledger_txs(ref,type,order_id,created_at,meta) VALUES(?,?,?,?,?)', ref, type, orderId || null, now(), JSON.stringify(meta || {})).lastInsertRowid;
    try { run('UPDATE accounts SET balance=balance-? WHERE id=?', amount, debit.id); }
    catch (e) { if (/CHECK/.test(e.message)) throw E('INSUFFICIENT_FUNDS', 400, 'Balans USDT ou pa sifi.'); throw e; }
    run('UPDATE accounts SET balance=balance+? WHERE id=?', amount, credit.id);
    run('INSERT INTO ledger_entries(tx_id,account_id,dir,amount) VALUES(?,?,?,?)', id, debit.id, 'DEBIT', amount);
    run('INSERT INTO ledger_entries(tx_id,account_id,dir,amount) VALUES(?,?,?,?)', id, credit.id, 'CREDIT', amount);
    if (debit.kind === 'AVAILABLE') syncAdAvailabilityInTx(debit.owner, { resume: false });
    return { id, duplicate: false };
  }
  const bridgeAcct = () => acct('SYSTEM', 'BRIDGE', 1);

  function wallet(userId) {
    const a = q1("SELECT balance FROM accounts WHERE kind='AVAILABLE' AND owner=? AND asset=?", String(userId), ASSET);
    const r = q1("SELECT COALESCE(SUM(amount),0) s FROM escrows WHERE seller_id=? AND status='LOCKED'", String(userId));
    return { available: a ? a.balance : 0, reserved: r.s, availableStr: micro(a ? a.balance : 0), reservedStr: micro(r.s) };
  }

  // ---------- pon ak balans prensipal la ----------
  // IN : debi balans prensipal (users.json) PREMYE, apre kredite ledger. OUT: debi ledger PREMYE, apre kredite balans prensipal.
  // Si sèvè a kraze nan mitan, lajan an pa janm kreye: recoverBridge() fini travay la.
  function bridgeId(userId, key) { return key ? 'br_' + crypto.createHash('sha256').update(userId + ':' + key).digest('hex').slice(0, 24) : 'br_' + crypto.randomUUID(); }
  function bridgeIn(userId, amountCents, key) {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw E('BAD_AMOUNT', 400, 'Montan an pa valid.');
    const el = eligible(userId); if (!el.ok) throw E('NOT_ELIGIBLE', 403, el.reason);
    const id = bridgeId(userId, key), amt = amountCents * 10000;
    const created = tx(() => {
      const ex = q1('SELECT * FROM bridge_transfers WHERE id=?', id);
      if (ex) return false;
      run('INSERT INTO bridge_transfers(id,user_id,dir,amount,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', id, userId, 'IN', amt, 'PENDING_DEBIT', now(), now());
      return true;
    });
    if (!created) return finishBridge(id);
    crash('bridge.in.afterRecord');
    if (main.debit(userId, amountCents, id) === 'INSUFFICIENT') {
      tx(() => run("UPDATE bridge_transfers SET status='FAILED', updated_at=? WHERE id=?", now(), id));
      throw E('INSUFFICIENT_FUNDS', 400, 'Balans prensipal ou pa sifi.');
    }
    crash('bridge.in.afterMainDebit');
    return finishBridge(id);
  }
  function bridgeOut(userId, amountCents, key) {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw E('BAD_AMOUNT', 400, 'Montan an pa valid.');
    const id = bridgeId(userId, key), amt = amountCents * 10000;
    tx(() => {
      if (q1('SELECT id FROM bridge_transfers WHERE id=?', id)) return;
      post('bridge:' + id, 'BRIDGE_OUT', null, acct('AVAILABLE', userId), bridgeAcct(), amt, { userId });
      run('INSERT INTO bridge_transfers(id,user_id,dir,amount,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', id, userId, 'OUT', amt, 'PENDING_CREDIT', now(), now());
    });
    crash('bridge.out.afterLedger');
    return finishBridge(id);
  }
  function finishBridge(id) {
    const t = q1('SELECT * FROM bridge_transfers WHERE id=?', id);
    if (!t) throw E('NOT_FOUND', 404, 'Transfè pa jwenn.');
    if (t.status === 'COMPLETED' || t.status === 'FAILED') return { id, status: t.status };
    const amountCents = t.amount / 10000;
    if (t.dir === 'IN') {
      if (!main.has(t.user_id, id)) { tx(() => run("UPDATE bridge_transfers SET status='FAILED', updated_at=? WHERE id=? AND status='PENDING_DEBIT'", now(), id)); return { id, status: 'FAILED' }; }
      tx(() => {
        post('bridge:' + id, 'BRIDGE_IN', null, bridgeAcct(), acct('AVAILABLE', t.user_id), t.amount, { userId: t.user_id });
        run("UPDATE bridge_transfers SET status='COMPLETED', updated_at=? WHERE id=?", now(), id);
        audit(t.user_id, 'USER', 'BRIDGE_IN', 'bridge', id, { amount: t.amount });
        syncAdAvailabilityInTx(t.user_id, { resume: true });
      });
    } else {
      if (!main.has(t.user_id, id)) main.credit(t.user_id, amountCents, id);
      crash('bridge.out.afterMainCredit');
      tx(() => { run("UPDATE bridge_transfers SET status='COMPLETED', updated_at=? WHERE id=?", now(), id); audit(t.user_id, 'USER', 'BRIDGE_OUT', 'bridge', id, { amount: t.amount }); });
    }
    return { id, status: 'COMPLETED' };
  }
  function recoverBridge(olderThanMs = 0) {
    const rows = q("SELECT id FROM bridge_transfers WHERE status IN ('PENDING_DEBIT','PENDING_CREDIT') AND updated_at<=?", now() - olderThanMs);
    rows.forEach((r) => finishBridge(r.id));
    return rows.length;
  }

  // ---------- machann (non biznis + mesaj otomatik) ----------
  const merchantRow = (uid) => q1('SELECT * FROM merchants WHERE user_id=?', String(uid));
  const displayName = (uid) => { const m = merchantRow(uid); return m ? m.business_name : nameOf(uid); };
  const merchantView = (uid) => { const m = merchantRow(uid); return { businessName: m ? m.business_name : null, autoMessage: m ? m.auto_message : '', locked: !!m }; };
  const RESERVED_NAME = /(admin|support|staff|moderat|morningstar|official|sipo)/i;
  function saveMerchant(userId, input, ip) {
    const el = eligible(userId); if (!el.ok) throw E('NOT_ELIGIBLE', 403, el.reason);
    const auto = String(input.autoMessage || '').trim();
    if (auto.length > 500) throw E('BAD_INPUT', 400, 'Mesaj la twò long (maks 500 karaktè).');
    const nameIn = String(input.businessName == null ? '' : input.businessName).trim().replace(/\s+/g, ' ');
    return tx(() => {
      const cur = merchantRow(userId);
      if (cur) {
        if (nameIn && nameIn.toLowerCase() !== cur.business_name.toLowerCase()) throw E('NAME_LOCKED', 409, 'Non biznis la pa ka chanje ankò.');
        run('UPDATE merchants SET auto_message=? WHERE user_id=?', auto, userId);
      } else {
        if (!/^[\p{L}\p{N}][\p{L}\p{N} .&'_-]{2,29}$/u.test(nameIn)) throw E('BAD_NAME', 400, "Non biznis la dwe gen 3 a 30 karaktè (lèt, chif, espas, . & ' _ -).");
        if (RESERVED_NAME.test(nameIn)) throw E('BAD_NAME', 400, 'Non sa a pa otorize.');
        try { run('INSERT INTO merchants(user_id,business_name,auto_message,created_at) VALUES(?,?,?,?)', userId, nameIn, auto, now()); }
        catch (e) { if (/UNIQUE/.test(e.message)) throw E('NAME_TAKEN', 409, 'Non sa a deja pran. Chwazi yon lòt.'); throw e; }
      }
      audit(userId, 'USER', 'MERCHANT_SAVE', 'merchant', userId, { created: !cur }, ip);
      return merchantView(userId);
    });
  }
  // Admin ka efase non yon machann (non ofansif, enpèsonasyon). Anons li yo poze jiskaske li chwazi yon lòt non.
  function resetMerchant(staff, userId, reason, ip) {
    requirePerm(staff, 'p2p.merchant.manage');
    const why = needReason(reason);
    return tx(() => {
      const m = merchantRow(userId); if (!m) throw E('NOT_FOUND', 404, 'Machann pa jwenn.');
      run('DELETE FROM merchants WHERE user_id=?', String(userId));
      run("UPDATE ads SET status='PAUSED', updated_at=? WHERE user_id=? AND status='ACTIVE'", now(), String(userId));
      audit(staff.id, staff.role, 'MERCHANT_RESET', 'merchant', userId, { oldName: m.business_name, reason: why }, ip);
      return { ok: true };
    });
  }

  // ---------- anons ----------
  const adView = (a, stats) => ({
    id: a.id, type: a.type, asset: a.asset, fiat: a.fiat, price: cents(a.price_cents), priceCents: a.price_cents,
    available: micro(a.available_micro), availableMicro: a.available_micro, minFiat: cents(a.min_fiat_cents), maxFiat: cents(a.max_fiat_cents),
    methods: JSON.parse(a.methods), payWindowMin: a.pay_window_min, status: a.status, advertiser: displayName(a.user_id), terms: a.terms, userId: undefined,
    ...(stats || {})
  });
  function userStats(userId) {
    const r = q1(`SELECT SUM(status='COMPLETED') done, SUM(status IN ('COMPLETED','CANCELLED','EXPIRED')) term, COUNT(*) total
      FROM orders WHERE (buyer_id=? OR seller_id=?)`, userId, userId);
    return { completedOrders: r.done || 0, totalOrders: r.total || 0, completionRate: r.term ? Math.round((r.done * 100) / r.term) : null };
  }
  function createAd(userId, input, idemKey, ip) {
    const el = eligible(userId); if (!el.ok) throw E('NOT_ELIGIBLE', 403, el.reason);
    if (!merchantRow(userId)) throw E('MERCHANT_REQUIRED', 400, 'Kreye pwofil machann ou (non biznis) anvan ou piblye yon anons.');
    const type = String(input.type), fiat = String(input.fiat);
    if (!['BUY', 'SELL'].includes(type)) throw E('BAD_INPUT', 400, 'Tip anons lan pa valid.');
    if (!FIATS[fiat]) throw E('BAD_INPUT', 400, 'Lajan fiat la pa valid.');
    const price = parseUnits(input.price, 2), total = parseUnits(input.total, 6);
    const minF = parseUnits(input.minFiat, 2), maxF = parseUnits(input.maxFiat, 2);
    if (maxF < minF) throw E('BAD_INPUT', 400, 'Maksimòm nan dwe pi gran pase minimòm nan.');
    if (fiatFor(total, price) < minF) throw E('BAD_INPUT', 400, 'Kantite total la pi piti pase minimòm nan.');
    const methods = [...new Set(Array.isArray(input.methods) ? input.methods.map(String) : [])];
    if (!methods.length || methods.some((m) => !FIATS[fiat].includes(m))) throw E('BAD_INPUT', 400, 'Metòd peman yo pa valid pou lajan sa a.');
    const win = Number(input.payWindowMin || 15);
    if (!Number.isInteger(win) || win < 5 || win > 60) throw E('BAD_INPUT', 400, 'Delè peman an dwe ant 5 ak 60 minit.');
    let pay = null;
    if (type === 'SELL') {
      pay = {};
      for (const m of methods) {
        const d = (input.payDetails || {})[m] || {};
        const account = String(d.account || '').trim().slice(0, 100), name = String(d.name || '').trim().slice(0, 80);
        if (account.length < 3 || name.length < 2) throw E('BAD_INPUT', 400, `Antre enfo peman pou ${m} (kont ak non).`);
        pay[m] = { account, name };
      }
    }
    const idem = idemKey ? crypto.createHash('sha256').update(userId + ':ad:' + idemKey).digest('hex') : null;
    return tx(() => {
      if (idem) { const ex = q1('SELECT * FROM ads WHERE idem=?', idem); if (ex) return adView(ex); }
      if (q1("SELECT COUNT(*) c FROM ads WHERE user_id=? AND status IN ('ACTIVE','PAUSED')", userId).c >= 10) throw E('LIMIT', 400, 'Ou gen twòp anons aktif (maks 10).');
      if (type === 'SELL' && wallet(userId).available < total) throw E('INSUFFICIENT_FUNDS', 400, 'Balans USDT disponib ou pa sifi pou anons sa a.');
      const id = crypto.randomUUID();
      run(`INSERT INTO ads(id,user_id,type,asset,fiat,price_cents,total_micro,available_micro,min_fiat_cents,max_fiat_cents,methods,pay_details,pay_window_min,status,advertiser_name,terms,idem,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, userId, type, ASSET, fiat, price, total, total, minF, maxF, JSON.stringify(methods), pay ? JSON.stringify(pay) : null, win, 'ACTIVE', displayName(userId), String(input.terms || '').slice(0, 300), idem, now(), now());
      if (type === 'SELL') syncAdAvailabilityInTx(userId, { resume: true });
      audit(userId, 'USER', 'AD_CREATE', 'ad', id, { type, fiat, price, total }, ip);
      return adView(q1('SELECT * FROM ads WHERE id=?', id));
    });
  }
  function setAdStatus(actor, adId, status, reason, ip) {
    return tx(() => {
      const a = q1('SELECT * FROM ads WHERE id=?', adId);
      if (!a) throw E('NOT_FOUND', 404, 'Anons pa jwenn.');
      const staff = actor.staff;
      if (status === 'SUSPENDED') { requirePerm(actor, 'p2p.ad.suspend'); needReason(reason); }
      else {
        if (staff || a.user_id !== actor.id) throw E('FORBIDDEN', 403, 'Ou pa mèt anons sa a.');
        if (!['ACTIVE', 'PAUSED', 'CLOSED'].includes(status)) throw E('BAD_INPUT', 400, 'Eta pa valid.');
        if (a.status === 'SUSPENDED') throw E('SUSPENDED', 403, 'Anons sa a sispann pa admin.');
        if (a.status === 'CLOSED') throw E('CLOSED', 409, 'Anons sa a fèmen.');
        if (status === 'ACTIVE') {
          const el = eligible(actor.id); if (!el.ok) throw E('NOT_ELIGIBLE', 403, el.reason);
          if (a.type === 'SELL' && !adFundingEnough(a, wallet(actor.id).available)) throw E('INSUFFICIENT_FUNDS', 400, 'Balans USDT disponib la pa kouvri kantite ki rete sou anons sa a oswa minimòm lan.');
        }
      }
      run('UPDATE ads SET status=?, auto_paused=0, updated_at=? WHERE id=?', status, now(), adId);
      audit(actor.id, actor.role || 'USER', 'AD_' + status, 'ad', adId, { reason: reason || null }, ip);
      return adView(q1('SELECT * FROM ads WHERE id=?', adId));
    });
  }
  function listAds({ type, fiat, method, amount, viewerId }) {
    if (type !== 'BUY') syncAllAdAvailability();
    let sql = "SELECT * FROM ads WHERE status='ACTIVE' AND available_micro>0 AND type=? AND fiat=?";
    const p = [type === 'BUY' ? 'BUY' : 'SELL', fiat === 'USD' ? 'USD' : 'HTG'];
    if (viewerId) { sql += ' AND user_id<>?'; p.push(viewerId); }
    sql += ' ORDER BY price_cents ' + (type === 'BUY' ? 'DESC' : 'ASC') + ' LIMIT 100';
    let rows = q(sql, ...p);
    if (method) rows = rows.filter((a) => JSON.parse(a.methods).includes(method));
    if (amount) {
      const f = parseUnits(amount, 2);
      rows = rows.filter((a) => f >= a.min_fiat_cents && f <= Math.min(a.max_fiat_cents, fiatFor(a.available_micro, a.price_cents)));
    }
    return rows.map((a) => adView(a, userStats(a.user_id)));
  }
  const myAds = (userId) => {
    syncAdAvailability(userId, { resume: true });
    return q('SELECT * FROM ads WHERE user_id=? ORDER BY created_at DESC LIMIT 100', userId).map((a) => adView(a));
  };

  function adFundingEnough(ad, available) {
    return ad.available_micro > 0 &&
      ad.available_micro <= available &&
      fiatFor(ad.available_micro, ad.price_cents) >= ad.min_fiat_cents;
  }
  function syncAdAvailabilityInTx(userId, { resume = false } = {}) {
    const available = wallet(userId).available;
    const ads = q("SELECT * FROM ads WHERE user_id=? AND type='SELL' AND status IN ('ACTIVE','PAUSED') ORDER BY created_at,id", String(userId));
    let changed = 0;
    for (const ad of ads) {
      const enough = adFundingEnough(ad, available);
      if (ad.status === 'ACTIVE' && !enough) {
        const r = run("UPDATE ads SET status='PAUSED',auto_paused=1,updated_at=? WHERE id=? AND status='ACTIVE'", now(), ad.id);
        if (r.changes) {
          audit('system', 'SYSTEM', 'AD_AUTO_PAUSED', 'ad', ad.id, { availableMicro: available, adAvailableMicro: ad.available_micro });
          changed++;
        }
      } else if (resume && ad.status === 'PAUSED' && ad.auto_paused && enough) {
        const el = eligible(ad.user_id);
        if (!el.ok || !merchantRow(ad.user_id)) continue;
        const r = run("UPDATE ads SET status='ACTIVE',auto_paused=0,updated_at=? WHERE id=? AND status='PAUSED' AND auto_paused=1", now(), ad.id);
        if (r.changes) {
          audit('system', 'SYSTEM', 'AD_AUTO_RESUMED', 'ad', ad.id, { availableMicro: available, adAvailableMicro: ad.available_micro });
          changed++;
        }
      }
    }
    return changed;
  }
  function syncAdAvailability(userId, options) {
    return tx(() => syncAdAvailabilityInTx(userId, options));
  }
  function syncAllAdAvailability() {
    return tx(() => {
      let changed = 0;
      for (const row of q("SELECT DISTINCT user_id FROM ads WHERE type='SELL' AND status IN ('ACTIVE','PAUSED')")) {
        changed += syncAdAvailabilityInTx(row.user_id, { resume: true });
      }
      return changed;
    });
  }

  // ---------- lòd: machin eta ----------
  const getOrder = (id) => q1('SELECT * FROM orders WHERE id=?', id);
  const roleOf = (o, uid) => (uid === o.buyer_id ? 'BUYER' : uid === o.seller_id ? 'SELLER' : null);
  function event(o, actor, actorRole, from, to, action, details) {
    run('INSERT INTO order_events(order_id,ts,actor,actor_role,from_status,to_status,action,details) VALUES(?,?,?,?,?,?,?,?)',
      o.id, now(), actor || null, actorRole, from, to, action, details ? JSON.stringify(details) : null);
  }
  function transition(o, to, roles, action, actor, details) {
    const allowed = (TRANSITIONS[o.status] || {})[to];
    if (!allowed || !roles.some((r) => allowed.includes(r))) throw E('ILLEGAL_TRANSITION', 409, `Aksyon sa a pa posib sou yon lòd ${o.status}.`);
    const r = run('UPDATE orders SET status=?, version=version+1 WHERE id=? AND status=? AND version=?', to, o.id, o.status, o.version);
    if (r.changes !== 1) throw E('CONFLICT', 409, 'Lòd la fèk chanje. Eseye ankò.');
    event(o, actor, roles[0], o.status, to, action, details);
    return getOrder(o.id);
  }
  function releaseEscrow(o) { // escrow -> achtè (yon sèl fwa)
    const e = q1('SELECT * FROM escrows WHERE order_id=?', o.id);
    if (!e || e.status !== 'LOCKED') throw E('ESCROW_NOT_LOCKED', 409, 'Escrow la pa bloke.');
    post(`order:${o.id}:release`, 'ESCROW_RELEASE', o.id, acct('ESCROW', o.id), acct('AVAILABLE', o.buyer_id), e.amount, { buyer: o.buyer_id });
    run("UPDATE escrows SET status='RELEASED_TO_BUYER', updated_at=? WHERE order_id=?", now(), o.id);
    syncAdAvailabilityInTx(o.buyer_id, { resume: true });
  }
  function returnEscrow(o) { // escrow -> vandè
    const e = q1('SELECT * FROM escrows WHERE order_id=?', o.id);
    if (!e || e.status !== 'LOCKED') throw E('ESCROW_NOT_LOCKED', 409, 'Escrow la pa bloke.');
    post(`order:${o.id}:return`, 'ESCROW_RETURN', o.id, acct('ESCROW', o.id), acct('AVAILABLE', o.seller_id), e.amount, { seller: o.seller_id });
    run("UPDATE escrows SET status='RETURNED_TO_SELLER', updated_at=? WHERE order_id=?", now(), o.id);
    run("UPDATE ads SET available_micro=MIN(total_micro, available_micro+?), updated_at=? WHERE id=? AND status<>'CLOSED'", o.crypto_micro, now(), o.ad_id);
    syncAdAvailabilityInTx(o.seller_id, { resume: true });
  }

  function createOrder(userId, input, idemKey, ip) {
    const el = eligible(userId); if (!el.ok) throw E('NOT_ELIGIBLE', 403, el.reason);
    const cryptoMicro = parseUnits(input.crypto, 6);
    const candidate = q1('SELECT user_id,type FROM ads WHERE id=?', String(input.adId));
    if (candidate && candidate.type === 'SELL') syncAdAvailability(candidate.user_id, { resume: true });
    let sellerToSync = null;
    try { return tx(() => {
      if (idemKey) { const ex = q1('SELECT response FROM idempotency WHERE key=? AND user_id=? AND route=?', idemKey, userId, 'order.create'); if (ex) return JSON.parse(ex.response); }
      const ad = q1('SELECT * FROM ads WHERE id=?', String(input.adId));
      if (!ad || ad.status !== 'ACTIVE') throw E('AD_UNAVAILABLE', 409, 'Anons sa a pa disponib ankò.');
      if (ad.user_id === userId) throw E('OWN_AD', 400, 'Ou pa ka fè yon lòd sou pwòp anons ou.');
      const adv = eligible(ad.user_id); if (!adv.ok) throw E('AD_UNAVAILABLE', 409, 'Piblikatè a pa disponib kounye a.');
      const method = String(input.method || '');
      if (!JSON.parse(ad.methods).includes(method)) throw E('BAD_METHOD', 400, 'Metòd peman an pa disponib pou anons sa a.');
      if (cryptoMicro > ad.available_micro) throw E('AD_EXHAUSTED', 409, 'Anons lan pa gen ase USDT disponib.');
      const fiatCents = fiatFor(cryptoMicro, ad.price_cents);
      if (fiatCents < ad.min_fiat_cents || fiatCents > ad.max_fiat_cents) throw E('LIMITS', 400, `Montan an dwe ant ${cents(ad.min_fiat_cents)} ak ${cents(ad.max_fiat_cents)} ${ad.fiat}.`);
      if (q1("SELECT COUNT(*) c FROM orders WHERE (buyer_id=? OR seller_id=?) AND status IN ('CREATED','ESCROW_LOCKED','WAITING_PAYMENT','PAYMENT_MARKED')", userId, userId).c >= 10) throw E('LIMIT', 429, 'Ou gen twòp lòd an kou.');
      const sellerIsAdv = ad.type === 'SELL';
      const sellerId = sellerIsAdv ? ad.user_id : userId, buyerId = sellerIsAdv ? userId : ad.user_id;
      sellerToSync = sellerId;
      let pay;
      if (sellerIsAdv) pay = JSON.parse(ad.pay_details)[method];
      else {
        const d = input.payDetails || {};
        pay = { account: String(d.account || '').trim().slice(0, 100), name: String(d.name || '').trim().slice(0, 80) };
        if (pay.account.length < 3 || pay.name.length < 2) throw E('BAD_INPUT', 400, 'Antre kont ou kote ou vle resevwa lajan an (kont ak non).');
      }
      if (!pay) throw E('BAD_METHOD', 400, 'Metòd peman an pa disponib.');
      const t = now(), id = crypto.randomUUID();
      const payRef = 'P2P-' + crypto.randomBytes(5).toString('hex').toUpperCase();
      if (run('UPDATE ads SET available_micro=available_micro-?, updated_at=? WHERE id=? AND available_micro>=?', cryptoMicro, t, ad.id, cryptoMicro).changes !== 1) throw E('AD_EXHAUSTED', 409, 'Anons lan pa gen ase USDT disponib.');
      run(`INSERT INTO orders(id,ad_id,buyer_id,seller_id,asset,fiat,price_cents,crypto_micro,fiat_cents,method,seller_pay,pay_ref,status,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, ad.id, buyerId, sellerId, ASSET, ad.fiat, ad.price_cents, cryptoMicro, fiatCents, method, JSON.stringify(pay), payRef, 'CREATED', t, t + ad.pay_window_min * 60e3);
      let o = getOrder(id);
      event(o, userId, 'SYSTEM', null, 'CREATED', 'ORDER_CREATED', { adId: ad.id });
      // escrow: debi vandè (disponib) -> kont escrow lòd la. Si balans pa sifi, tout tranzaksyon an anile.
      post(`order:${id}:lock`, 'ESCROW_LOCK', id, acct('AVAILABLE', sellerId), acct('ESCROW', id), cryptoMicro, { seller: sellerId });
      run("INSERT INTO escrows(order_id,seller_id,amount,status,updated_at) VALUES(?,?,?,'LOCKED',?)", id, sellerId, cryptoMicro, t);
      crash('createOrder.afterLock');
      o = transition(o, 'ESCROW_LOCKED', ['SYSTEM'], 'ESCROW_LOCKED', userId);
      o = transition(o, 'WAITING_PAYMENT', ['SYSTEM'], 'AWAIT_PAYMENT', userId);
      sysMsg(id, `Voye ${cents(fiatCents)} ${ad.fiat} sou ${method}\nKont: ${pay.account}\nNon: ${pay.name}`, 'PAYINFO');
      const mer = merchantRow(ad.user_id);
      if (mer && mer.auto_message) run('INSERT INTO messages(order_id,sender_id,role,body,ts,kind) VALUES(?,?,?,?,?,?)', id, ad.user_id, 'USER', mer.auto_message, now(), 'AUTO'); // mesaj machann lan (kopi nan moman lòd la)
      audit(userId, 'USER', 'ORDER_CREATE', 'order', id, { adId: ad.id, crypto: cryptoMicro, fiat: fiatCents }, ip);
      if (q1('SELECT COUNT(*) c FROM orders WHERE (buyer_id=? OR seller_id=?) AND created_at>?', userId, userId, t - 10 * 60e3).c >= 5) alert(userId, 'RAPID_ORDERS', { orderId: id });
      if (cryptoMicro >= 5000e6) alert(userId, 'LARGE_ORDER', { orderId: id, crypto: cryptoMicro });
      const view = orderView(o, { id: userId });
      if (idemKey) run('INSERT INTO idempotency(key,user_id,route,response,created_at) VALUES(?,?,?,?,?)', idemKey, userId, 'order.create', JSON.stringify(view), t);
      return view;
    }); } catch (e) {
      if (e.code === 'INSUFFICIENT_FUNDS' && sellerToSync) syncAdAvailability(sellerToSync, { resume: false });
      throw e;
    }
  }

  function markPaid(userId, orderId, reference, ip) {
    const ref = String(reference || '').trim();            // referans/ID tranzaksyon se OPSYONÈL
    if (ref.length > 120) throw E('BAD_INPUT', 400, 'Referans lan twò long.');
    return tx(() => {
      let o = mustOrder(orderId);
      if (roleOf(o, userId) !== 'BUYER') throw E('FORBIDDEN', 403, 'Se sèlman achtè a ki ka make peman an.');
      if (o.status === 'PAYMENT_MARKED') return orderView(o, { id: userId }); // klike repete = menm rezilta
      if (o.status !== 'WAITING_PAYMENT') throw E('ILLEGAL_TRANSITION', 409, `Ou pa ka make peman sou yon lòd ${o.status}.`);
      if (now() > o.expires_at) throw E('PAYMENT_WINDOW_CLOSED', 409, 'Delè peman an fini.');
      run('UPDATE orders SET paid_at=?, seller_deadline=?, payment_note=? WHERE id=?', now(), now() + SELLER_WINDOW, ref || null, o.id);
      o = transition(getOrder(o.id), 'PAYMENT_MARKED', ['BUYER'], 'PAYMENT_MARKED', userId, { reference: ref });
      sysMsg(o.id, 'Achtè a make peman an voye. Vandè a dwe verifye ke lajan an antre vre anvan li lage USDT la.');
      audit(userId, 'USER', 'ORDER_PAID', 'order', o.id, { reference: ref }, ip);
      return orderView(o, { id: userId });
    });
  }
  function release(userId, orderId, ip) {
    return tx(() => {
      let o = mustOrder(orderId);
      if (roleOf(o, userId) !== 'SELLER') throw E('FORBIDDEN', 403, 'Se sèlman vandè a ki ka lage USDT la.');
      if (o.status === 'COMPLETED') return orderView(o, { id: userId }); // retry = pa gen 2yèm lage
      o = transition(o, 'COMPLETED', ['SELLER'], 'SELLER_RELEASED', userId);
      releaseEscrow(o);
      crash('release.beforeCommit');
      run('UPDATE orders SET completed_at=? WHERE id=?', now(), o.id);
      sysMsg(o.id, 'Vandè a konfime resepsyon an. USDT la lage bay achtè a.');
      audit(userId, 'USER', 'ORDER_RELEASE', 'order', o.id, null, ip);
      return orderView(getOrder(o.id), { id: userId });
    });
  }
  function cancel(userId, orderId, reason, ip) {
    return tx(() => {
      let o = mustOrder(orderId);
      if (roleOf(o, userId) !== 'BUYER') throw E('FORBIDDEN', 403, 'Se sèlman achtè a ki ka anile.');
      const dispute = q1('SELECT status FROM disputes WHERE order_id=?', o.id);
      if (dispute && dispute.status !== 'RESOLVED') throw E('DISPUTE_OPEN', 409, 'Gen yon dispit ouvè; swiv pwosedi rezolisyon an olye ou anile lòd la.');
      if (o.status !== 'WAITING_PAYMENT') {
        const message = o.status === 'PAYMENT_MARKED'
          ? 'Peman an make deja. Rapòte pwoblèm nan oswa louvri yon dispit.'
          : o.status === 'COMPLETED'
            ? 'Lòd la fini oswa crypto a deja lage; li pa ka anile.'
            : o.status === 'CANCELLED'
              ? 'Lòd sa a deja anile.'
              : `Ou pa ka anile yon lòd ${o.status}.`;
        throw E('ILLEGAL_TRANSITION', 409, message);
      }
      const why = cancellationReason(reason);
      o = transition(o, 'CANCELLED', ['BUYER'], 'BUYER_CANCELLED', userId, { reason: why.code, details: why.details || null });
      returnEscrow(o);
      run("UPDATE orders SET closed_reason='BUYER_CANCELLED' WHERE id=?", o.id);
      sysMsg(o.id, 'Achtè a anile lòd la. USDT la tounen bay vandè a.');
      audit(userId, 'USER', 'ORDER_CANCEL', 'order', o.id, { reason: why.code, details: why.details || null }, ip);
      if (q1("SELECT COUNT(*) c FROM order_events WHERE actor=? AND action='BUYER_CANCELLED' AND ts>?", userId, now() - 24 * HOUR).c >= 5) alert(userId, 'FREQUENT_CANCEL', { orderId: o.id });
      return orderView(getOrder(o.id), { id: userId });
    });
  }
  function mustOrder(id) { const o = getOrder(String(id)); if (!o) throw E('NOT_FOUND', 404, 'Lòd pa jwenn.'); return o; }

  // ---------- dispit ----------
  function openDispute(userId, orderId, reason, ip, systemReason) {
    const why = String(reason || '').trim();
    if (!systemReason && (why.length < 10 || why.length > 500)) throw E('BAD_INPUT', 400, 'Eksplike pwoblèm lan (10 a 500 karaktè).');
    return tx(() => {
      let o = mustOrder(orderId);
      const role = systemReason ? 'SYSTEM' : roleOf(o, userId);
      if (!role) throw E('FORBIDDEN', 403, 'Ou pa patisipan lòd sa a.');
      const ex = q1('SELECT id FROM disputes WHERE order_id=?', o.id);
      if (ex) return orderView(o, { id: userId });
      let late = 0;
      if (o.status === 'EXPIRED') {
        if (role === 'SELLER') throw E('ILLEGAL_TRANSITION', 409, 'Se achtè a ki ka reklame yon peman an reta.');
        if (!systemReason && now() > o.expires_at + LATE_CLAIM_WINDOW) throw E('TOO_LATE', 409, 'Delè pou reklame yon peman an reta fini (24è).');
        late = 1;
      }
      o = transition(o, 'DISPUTED', [role], 'DISPUTE_OPENED', userId, { late });
      const text = systemReason || why;
      run("INSERT INTO disputes(order_id,opened_by,reason,status,opened_at) VALUES(?,?,?,'OPEN',?)", o.id, systemReason ? 'SYSTEM' : userId, text, now());
      if (late) run('UPDATE orders SET late_claim=1 WHERE id=?', o.id);
      sysMsg(o.id, 'Yon dispit louvri. Escrow la rete bloke jiskaske yon admin deside.');
      audit(userId, role, 'DISPUTE_OPEN', 'order', o.id, { late, system: !!systemReason }, ip);
      if (!systemReason && q1("SELECT COUNT(*) c FROM disputes WHERE opened_by=? AND opened_at>?", userId, now() - 30 * 24 * HOUR).c >= 3) alert(userId, 'REPEATED_DISPUTES', { orderId: o.id });
      return orderView(getOrder(o.id), { id: userId });
    });
  }
  function takeDispute(staff, disputeId, ip) {
    requirePerm(staff, 'p2p.dispute.take');
    return tx(() => {
      const d = q1('SELECT * FROM disputes WHERE id=?', disputeId);
      if (!d) throw E('NOT_FOUND', 404, 'Dispit pa jwenn.');
      if (d.status !== 'OPEN') return d;
      const o = transition(mustOrder(d.order_id), 'UNDER_REVIEW', ['STAFF'], 'DISPUTE_TAKEN', staff.id);
      run("UPDATE disputes SET status='UNDER_REVIEW', assigned_to=? WHERE id=?", staff.id, d.id);
      run('INSERT INTO decision_log(dispute_id,ts,actor,action,reason) VALUES(?,?,?,?,?)', d.id, now(), staff.id, 'TAKEN', null);
      audit(staff.id, staff.role, 'DISPUTE_TAKE', 'dispute', d.id, null, ip);
      sysMsg(o.id, 'Yon manm ekip sipò a ap revize dispit la.');
      return q1('SELECT * FROM disputes WHERE id=?', d.id);
    });
  }
  // Sèl admin ki gen pèmisyon "p2p.escrow.resolve" ka deplase lajan, ak yon rezon ekri.
  function resolveDispute(staff, disputeId, decision, reason, ip) {
    requirePerm(staff, 'p2p.escrow.resolve');
    const why = needReason(reason);
    if (!['RELEASE_TO_BUYER', 'RETURN_TO_SELLER'].includes(decision)) throw E('BAD_INPUT', 400, 'Desizyon pa valid.');
    return tx(() => {
      const d = q1('SELECT * FROM disputes WHERE id=?', disputeId);
      if (!d) throw E('NOT_FOUND', 404, 'Dispit pa jwenn.');
      if (d.status === 'RESOLVED') { if (d.resolution === decision) return d; throw E('ALREADY_RESOLVED', 409, 'Dispit sa a deja rezoud ak yon lòt desizyon.'); }
      if (d.status !== 'UNDER_REVIEW') throw E('TAKE_FIRST', 409, 'Dispit la dwe an revizyon anvan yo rezoud li.');
      let o = mustOrder(d.order_id);
      const e = q1('SELECT * FROM escrows WHERE order_id=?', o.id);
      if (decision === 'RELEASE_TO_BUYER') {
        if (e.status === 'LOCKED') releaseEscrow(o);
        else if (o.late_claim && e.status === 'RETURNED_TO_SELLER') // reklamasyon an reta: escrow te deja tounen; re-debi dirèkteman vandè a
          post(`order:${o.id}:late_release`, 'LATE_RELEASE', o.id, acct('AVAILABLE', o.seller_id), acct('AVAILABLE', o.buyer_id), o.crypto_micro, { admin: staff.id });
        else throw E('ESCROW_NOT_LOCKED', 409, 'Escrow la pa bloke.');
        o = transition(o, 'COMPLETED', ['ADMIN'], 'ADMIN_RELEASED', staff.id, { reason: why });
        run('UPDATE orders SET completed_at=? WHERE id=?', now(), o.id);
      } else {
        if (e.status === 'LOCKED') returnEscrow(o);
        else if (!(o.late_claim && e.status === 'RETURNED_TO_SELLER')) throw E('ESCROW_NOT_LOCKED', 409, 'Escrow la pa bloke.');
        o = transition(o, 'CANCELLED', ['ADMIN'], 'ADMIN_RETURNED', staff.id, { reason: why });
        run("UPDATE orders SET closed_reason='ADMIN_RETURNED' WHERE id=?", o.id);
      }
      crash('resolve.beforeCommit');
      run("UPDATE disputes SET status='RESOLVED', resolution=?, resolution_reason=?, resolved_by=?, resolved_at=? WHERE id=?", decision, why, staff.id, now(), d.id);
      run('INSERT INTO decision_log(dispute_id,ts,actor,action,reason) VALUES(?,?,?,?,?)', d.id, now(), staff.id, decision, why);
      audit(staff.id, staff.role, 'DISPUTE_RESOLVE', 'dispute', d.id, { decision, reason: why }, ip);
      sysMsg(o.id, 'Admin lan rezoud dispit la: ' + (decision === 'RELEASE_TO_BUYER' ? 'USDT la lage bay achtè a.' : 'USDT la tounen bay vandè a.'));
      return q1('SELECT * FROM disputes WHERE id=?', d.id);
    });
  }

  // ---------- chat + prèv ----------
  function access(o, viewer) {
    const role = roleOf(o, viewer.id);
    if (role) return role;
    if (viewer.staff && can(viewer.role, 'p2p.view')) return 'STAFF';
    throw E('FORBIDDEN', 403, 'Ou pa gen aksè ak lòd sa a.');
  }
  function postMessage(viewer, orderId, body) {
    const text = String(body || '').trim();
    if (!text || text.length > 1000) throw E('BAD_INPUT', 400, 'Mesaj la dwe gen 1 a 1000 karaktè.');
    return tx(() => {
      const o = mustOrder(orderId), role = access(o, viewer);
      if (role === 'STAFF') { if (!can(viewer.role, 'p2p.chat')) throw E('FORBIDDEN', 403, 'Pa gen pèmisyon.'); if (!q1('SELECT id FROM disputes WHERE order_id=?', o.id)) throw E('NO_DISPUTE', 409, 'Staff ka ekri sèlman nan yon dispit.'); }
      if (q1('SELECT COUNT(*) c FROM messages WHERE order_id=?', o.id).c >= 300) throw E('LIMIT', 429, 'Twòp mesaj nan lòd sa a.');
      run('INSERT INTO messages(order_id,sender_id,role,body,ts) VALUES(?,?,?,?,?)', o.id, viewer.id, role === 'STAFF' ? 'STAFF' : 'USER', text, now());
      return { ok: true };
    });
  }
  function listMessages(viewer, orderId, afterId = 0) {
    const o = mustOrder(orderId), role = access(o, viewer);
    const after = Math.max(0, Number(afterId) || 0);
    return q(`SELECT id,sender_id,role,body,ts,evidence_id,kind,read_at FROM messages
      WHERE order_id=? AND (id>? OR (sender_id=? AND role='USER' AND read_at IS NOT NULL)) ORDER BY id LIMIT 300`, o.id, after, viewer.id)
      .map((m) => ({ id: m.id, evidenceId: m.evidence_id || null, kind: m.kind || null, role: m.role, mine: m.sender_id === viewer.id, from: m.role === 'USER' ? (m.sender_id === o.buyer_id ? 'BUYER' : 'SELLER') : m.role, body: m.body, ts: m.ts, readAt: m.sender_id === viewer.id ? m.read_at || null : null }));
  }
  function markMessagesRead(viewer, orderId, ids) {
    if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
      throw E('BAD_INPUT', 400, 'Lis mesaj yo pa valid.');
    }
    return tx(() => {
      const o = mustOrder(orderId), role = access(o, viewer);
      if (role !== 'BUYER' && role !== 'SELLER') throw E('FORBIDDEN', 403, 'Se achtè oswa vandè a ki ka make mesaj yo kòm li.');
      const senderId = role === 'BUYER' ? o.seller_id : o.buyer_id;
      const readAt = now();
      let updated = 0;
      const readIds = [];
      for (const id of new Set(ids.map(Number))) {
        const changed = run(`UPDATE messages SET read_at=? WHERE id=? AND order_id=? AND sender_id=? AND role='USER' AND read_at IS NULL`,
          readAt, id, o.id, senderId).changes;
        updated += changed;
        if (changed || q1(`SELECT id FROM messages WHERE id=? AND order_id=? AND sender_id=? AND role='USER' AND read_at IS NOT NULL`, id, o.id, senderId)) readIds.push(id);
      }
      return { updated, readIds, readAt: readIds.length ? readAt : null };
    });
  }
  const EVIDENCE_STATES = ['WAITING_PAYMENT', 'PAYMENT_MARKED', 'DISPUTED', 'UNDER_REVIEW', 'EXPIRED'];
  function addEvidence(viewer, orderId, kind, file, sha256, opts = {}) {
    return tx(() => {
      const o = mustOrder(orderId), role = access(o, viewer);
      if (role === 'STAFF') throw E('FORBIDDEN', 403, 'Staff pa voye prèv.');
      if (!EVIDENCE_STATES.includes(o.status)) throw E('ILLEGAL_TRANSITION', 409, 'Ou pa ka ajoute prèv sou lòd sa a ankò.');
      if (q1('SELECT COUNT(*) c FROM evidence WHERE order_id=? AND uploader_id=?', o.id, viewer.id).c >= 30) throw E('LIMIT', 429, 'Twòp foto (maks 30).');
      const id = crypto.randomUUID();
      const k = kind === 'DISPUTE' ? 'DISPUTE' : kind === 'CHAT' ? 'CHAT' : 'PAYMENT_PROOF';
      run('INSERT INTO evidence(id,order_id,uploader_id,kind,file,sha256,ts) VALUES(?,?,?,?,?,?,?)', id, o.id, viewer.id, k, file, sha256, now());
      // foto a parèt tou nan chat la (tankou WhatsApp); li rete prèv ki ka revize nan yon dispit
      if (opts.chat) run('INSERT INTO messages(order_id,sender_id,role,body,ts,evidence_id) VALUES(?,?,?,?,?,?)', o.id, viewer.id, 'USER', String(opts.caption || '').slice(0, 500), now(), id);
      audit(viewer.id, role, 'EVIDENCE_ADD', 'order', o.id, { id, kind }, null);
      return { id };
    });
  }
  function evidenceFile(viewer, evidenceId) {
    const ev = q1('SELECT * FROM evidence WHERE id=?', String(evidenceId));
    if (!ev) throw E('NOT_FOUND', 404, 'Prèv pa jwenn.');
    access(mustOrder(ev.order_id), viewer);
    return ev;
  }

  // ---------- vi (view) ----------
  function orderView(o, viewer) {
    const role = roleOf(o, viewer.id) || (viewer.staff ? 'STAFF' : null);
    const e = q1('SELECT status FROM escrows WHERE order_id=?', o.id);
    const d = q1('SELECT id,status,reason,opened_at,resolution,resolution_reason FROM disputes WHERE order_id=?', o.id);
    const actions = [];
    if (role === 'BUYER') {
      if (o.status === 'WAITING_PAYMENT') actions.push('PAY', 'CANCEL');
      if (o.status === 'PAYMENT_MARKED') actions.push('DISPUTE');
      if (o.status === 'EXPIRED' && !d && now() <= o.expires_at + LATE_CLAIM_WINDOW) actions.push('LATE_CLAIM');
    }
    if (role === 'SELLER' && o.status === 'PAYMENT_MARKED') actions.push('RELEASE', 'DISPUTE');
    return {
      id: o.id, status: o.status, role, asset: o.asset, fiat: o.fiat, method: o.method, payRef: o.pay_ref,
      crypto: micro(o.crypto_micro), fiatAmount: cents(o.fiat_cents), price: cents(o.price_cents),
      createdAt: o.created_at, expiresAt: o.expires_at, paidAt: o.paid_at, sellerDeadline: o.seller_deadline, completedAt: o.completed_at,
      paymentNote: o.payment_note, providerVerified: !!o.provider_verified, lateClaim: !!o.late_claim, closedReason: o.closed_reason,
      escrow: e ? e.status : null, dispute: d || null, sellerPay: JSON.parse(o.seller_pay),
      buyer: displayName(o.buyer_id), seller: displayName(o.seller_id), actions,
      ...(viewer.staff ? { buyerId: o.buyer_id, sellerId: o.seller_id, buyerReal: nameOf(o.buyer_id), sellerReal: nameOf(o.seller_id), adId: o.ad_id, version: o.version } : {}),
      evidence: q('SELECT id,kind,ts,uploader_id FROM evidence WHERE order_id=? ORDER BY ts', o.id).map((x) => ({ id: x.id, kind: x.kind, ts: x.ts, by: x.uploader_id === o.buyer_id ? 'BUYER' : 'SELLER' })),
      events: q('SELECT ts,actor_role,from_status,to_status,action FROM order_events WHERE order_id=? ORDER BY id', o.id)
    };
  }
  function getOrderFor(viewer, orderId) { const o = mustOrder(orderId); access(o, viewer); return orderView(o, viewer); }
  function myOrders(userId) {
    return q('SELECT * FROM orders WHERE buyer_id=? OR seller_id=? ORDER BY created_at DESC LIMIT 100', userId, userId).map((o) => {
      const v = orderView(o, { id: userId }); return { ...v, events: undefined, evidence: undefined, sellerPay: undefined };
    });
  }

  // ---------- peman pwovizè (webhook) ----------
  // Verifikasyon siyati fèt nan route la. Isit la: dedupe, validasyon referans/montan/lajan/destinatè. PA janm lage escrow.
  function processProviderEvent(provider, ev) {
    const eventId = String(ev.event_id || ''), reference = String(ev.reference || '');
    if (!eventId || !reference) throw E('BAD_EVENT', 400, 'Evènman pa valid.');
    const hash = crypto.createHash('sha256').update(JSON.stringify(ev)).digest('hex');
    return tx(() => {
      if (q1('SELECT 1 FROM webhook_events WHERE provider=? AND event_id=?', provider, eventId)) return { duplicate: true };
      const rec = (outcome) => run('INSERT INTO webhook_events(provider,event_id,ts,payload_hash,outcome) VALUES(?,?,?,?,?)', provider, eventId, now(), hash, outcome);
      let o = q1('SELECT * FROM orders WHERE pay_ref=?', reference);
      if (!o) { rec('NO_ORDER'); return { outcome: 'NO_ORDER' }; }
      const pay = JSON.parse(o.seller_pay);
      const norm = (s) => String(s || '').trim().toLowerCase();
      if (ev.status !== 'SUCCEEDED') { rec('NOT_SUCCEEDED'); return { outcome: 'NOT_SUCCEEDED' }; }
      if (Number(ev.amount_cents) !== o.fiat_cents || String(ev.currency) !== o.fiat || norm(ev.recipient) !== norm(pay.account)) {
        rec('MISMATCH'); alert(o.buyer_id, 'WEBHOOK_MISMATCH', { orderId: o.id, provider, eventId }); audit('system', 'SYSTEM', 'WEBHOOK_MISMATCH', 'order', o.id, { provider, eventId });
        return { outcome: 'MISMATCH' };
      }
      run('UPDATE orders SET provider_verified=1 WHERE id=?', o.id);
      event(o, 'system', 'SYSTEM', o.status, o.status, 'PROVIDER_VERIFIED', { provider, eventId });
      if (o.status === 'WAITING_PAYMENT') {
        run('UPDATE orders SET paid_at=?, seller_deadline=?, payment_note=? WHERE id=?', now(), now() + SELLER_WINDOW, 'provider:' + provider, o.id);
        transition(getOrder(o.id), 'PAYMENT_MARKED', ['SYSTEM'], 'PAYMENT_MARKED_BY_PROVIDER', 'system', { provider });
      } else if (o.status === 'EXPIRED') {
        run('UPDATE orders SET late_claim=1 WHERE id=?', o.id);
        transition(getOrder(o.id), 'DISPUTED', ['SYSTEM'], 'DISPUTE_OPENED', 'system', { late: 1, provider });
        run("INSERT INTO disputes(order_id,opened_by,reason,status,opened_at) VALUES(?,?,?,'OPEN',?)", o.id, 'SYSTEM', 'Peman verifye pa pwovizè a rive apre delè a fini.', now());
        sysMsg(o.id, 'Yon peman verifye rive apre delè a. Yon dispit louvri otomatikman.');
      }
      sysMsg(o.id, 'Pwovizè peman an verifye yon peman ki koresponn ak lòd sa a.');
      rec('VERIFIED');
      audit('system', 'SYSTEM', 'WEBHOOK_VERIFIED', 'order', o.id, { provider, eventId });
      return { outcome: 'VERIFIED' };
    });
  }

  // ---------- travay background ----------
  function runJob(name, fn) {
    const id = run('INSERT INTO jobs(name,started_at) VALUES(?,?)', name, now()).lastInsertRowid;
    try { const n = fn(); run('UPDATE jobs SET finished_at=?, ok=1, processed=? WHERE id=?', now(), n || 0, id); return n; }
    catch (e) { run('UPDATE jobs SET finished_at=?, ok=0, error=? WHERE id=?', now(), String(e.message).slice(0, 300), id); throw e; }
  }
  // Ekspirasyon idempotan: chak lòd re-li ak re-verifye nan pwòp tranzaksyon li.
  function expireDue() {
    return runJob('expireDue', () => {
      let n = 0; const t = now();
      for (const r of q("SELECT id FROM orders WHERE status='WAITING_PAYMENT' AND expires_at<?", t)) {
        try {
          tx(() => {
            const o = getOrder(r.id);
            if (o.status !== 'WAITING_PAYMENT' || o.paid_at || o.expires_at >= now() || q1('SELECT 1 FROM disputes WHERE order_id=?', o.id)) return;
            const x = transition(o, 'EXPIRED', ['SYSTEM'], 'EXPIRED', 'system');
            returnEscrow(x);
            run("UPDATE orders SET closed_reason='EXPIRED' WHERE id=?", o.id);
            sysMsg(o.id, 'Delè peman an fini. Lòd la ekspire epi USDT la tounen bay vandè a.');
            audit('system', 'SYSTEM', 'ORDER_EXPIRE', 'order', o.id); n++;
          });
        } catch (e) { alertJob('expire', r.id, e); }
      }
      // vandè pa reponn apre peman make => dispit otomatik (escrow rete bloke)
      for (const r of q("SELECT id FROM orders WHERE status='PAYMENT_MARKED' AND seller_deadline<?", t)) {
        try { openDispute('system', r.id, '', null, 'Vandè a pa t reponn nan delè a apre peman an te make.'); n++; } catch (e) { alertJob('autodispute', r.id, e); }
      }
      return n;
    });
  }
  function alertJob(kind, id, e) { try { tx(() => alert(null, 'JOB_ERROR', { kind, id, error: String(e.message).slice(0, 200) })); } catch {} }
  // Lòd ki kole nan CREATED/ESCROW_LOCKED apre yon kraze: fini yo oswa anile yo avèk ledger la kòm vèti.
  function recoverStuck() {
    return runJob('recoverStuck', () => {
      let n = recoverBridge(STUCK_AFTER);
      for (const r of q("SELECT id FROM orders WHERE status IN ('CREATED','ESCROW_LOCKED') AND created_at<?", now() - STUCK_AFTER)) {
        tx(() => {
          let o = getOrder(r.id);
          if (!['CREATED', 'ESCROW_LOCKED'].includes(o.status)) return;
          const e = q1('SELECT * FROM escrows WHERE order_id=?', o.id);
          if (e && e.status === 'LOCKED') {
            if (o.status === 'CREATED') o = transition(o, 'ESCROW_LOCKED', ['SYSTEM'], 'RECOVERED', 'system');
            transition(o, 'WAITING_PAYMENT', ['SYSTEM'], 'RECOVERED', 'system');
          } else {
            o = transition(o, 'CANCELLED', ['SYSTEM'], 'RECOVERED_CANCEL', 'system');
            run("UPDATE ads SET available_micro=MIN(total_micro, available_micro+?) WHERE id=?", o.crypto_micro, o.ad_id);
          }
          audit('system', 'SYSTEM', 'ORDER_RECOVER', 'order', o.id); n++;
        });
      }
      return n;
    });
  }
  const runJobs = () => { expireDue(); recoverStuck(); const r = reconcile(); return r; };

  // ---------- reconciliation ----------
  function reconcile() {
    const issues = [], add = (severity, code, detail) => issues.push({ severity, code, detail });
    q(`SELECT tx_id, SUM(CASE dir WHEN 'DEBIT' THEN amount ELSE -amount END) s, COUNT(*) n FROM ledger_entries GROUP BY tx_id HAVING s<>0 OR n<>2`).forEach((r) => add('CRITICAL', 'LEDGER_UNBALANCED', r));
    q(`SELECT a.id,a.kind,a.owner,a.balance, COALESCE(SUM(CASE e.dir WHEN 'CREDIT' THEN e.amount ELSE -e.amount END),0) calc
       FROM accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id GROUP BY a.id HAVING a.balance<>calc`).forEach((r) => add('CRITICAL', 'BALANCE_MISMATCH', r));
    q('SELECT id,kind,owner,balance FROM accounts WHERE allow_negative=0 AND balance<0').forEach((r) => add('CRITICAL', 'NEGATIVE_BALANCE', r));
    const sum = q1('SELECT COALESCE(SUM(balance),0) s FROM accounts').s;
    if (sum !== 0) add('CRITICAL', 'GLOBAL_SUM_NONZERO', { sum });
    q("SELECT a.owner, a.balance, e.amount, e.status FROM accounts a LEFT JOIN escrows e ON e.order_id=a.owner WHERE a.kind='ESCROW'").forEach((r) => {
      const expected = r.status === 'LOCKED' ? r.amount : 0;
      if (r.balance !== expected) add('CRITICAL', 'ESCROW_MISMATCH', r);
    });
    q(`SELECT o.id, o.status, e.status es, o.late_claim FROM orders o LEFT JOIN escrows e ON e.order_id=o.id`).forEach((r) => {
      const live = ['WAITING_PAYMENT', 'PAYMENT_MARKED', 'DISPUTED', 'UNDER_REVIEW'].includes(r.status);
      if (live && r.es !== 'LOCKED' && !r.late_claim) add('CRITICAL', 'ORDER_ESCROW_STATE', r);
      if (!live && r.es === 'LOCKED') add('CRITICAL', 'ESCROW_LOCKED_ON_CLOSED_ORDER', r);
    });
    const t = now();
    q("SELECT id,status,created_at FROM orders WHERE status IN ('CREATED','ESCROW_LOCKED') AND created_at<?", t - STUCK_AFTER).forEach((r) => add('WARNING', 'STUCK_ORDER', r));
    q("SELECT id,expires_at FROM orders WHERE status='WAITING_PAYMENT' AND expires_at<?", t - 5 * 60e3).forEach((r) => add('WARNING', 'OVERDUE_ORDER', r));
    q("SELECT id,status FROM bridge_transfers WHERE status IN ('PENDING_DEBIT','PENDING_CREDIT') AND updated_at<?", t - STUCK_AFTER).forEach((r) => add('WARNING', 'STUCK_BRIDGE', r));
    if (issues.length) tx(() => alert(null, 'RECONCILIATION', { count: issues.length, codes: [...new Set(issues.map((i) => i.code))] }));
    return { ok: issues.every((i) => i.severity !== 'CRITICAL'), clean: issues.length === 0, issues, checkedAt: t };
  }

  // ---------- rapò + admin ----------
  function report(userId, targetType, targetId, reason) {
    const r = String(reason || '').trim();
    if (!['USER', 'AD', 'ORDER'].includes(targetType) || r.length < 10 || r.length > 500) throw E('BAD_INPUT', 400, 'Rapò pa valid (rezon 10-500 karaktè).');
    run('INSERT INTO reports(ts,reporter_id,target_type,target_id,reason) VALUES(?,?,?,?,?)', now(), userId, targetType, String(targetId).slice(0, 80), r);
    return { ok: true };
  }
  const lim = (n) => Math.min(Math.max(Number(n) || 50, 1), 200);
  const admin = {
    orders(staff, { status, limit } = {}) { requirePerm(staff, 'p2p.view'); return q(`SELECT * FROM orders ${status ? 'WHERE status=?' : ''} ORDER BY created_at DESC LIMIT ${lim(limit)}`, ...(status ? [status] : [])).map((o) => ({ ...orderView(o, { ...staff, staff: true }), events: undefined, evidence: undefined })); },
    order(staff, id) { requirePerm(staff, 'p2p.view'); return { ...orderView(mustOrder(id), { ...staff, staff: true }), messages: listMessages({ ...staff, staff: true }, id), reserve: q1('SELECT * FROM escrows WHERE order_id=?', id) }; },
    disputes(staff, { status } = {}) { requirePerm(staff, 'p2p.view'); return q(`SELECT d.*, o.status order_status, o.crypto_micro, o.fiat, o.fiat_cents, o.late_claim FROM disputes d JOIN orders o ON o.id=d.order_id ${status ? 'WHERE d.status=?' : ''} ORDER BY d.opened_at DESC LIMIT 200`, ...(status ? [status] : [])); },
    decisions(staff, disputeId) { requirePerm(staff, 'p2p.view'); return q('SELECT * FROM decision_log WHERE dispute_id=? ORDER BY id', disputeId); },
    escrows(staff) { requirePerm(staff, 'p2p.view'); return q("SELECT * FROM escrows WHERE status='LOCKED' ORDER BY updated_at DESC LIMIT 200"); },
    ledger(staff, { limit, orderId } = {}) {
      requirePerm(staff, 'p2p.ledger.view');
      const txs = q(`SELECT * FROM ledger_txs ${orderId ? 'WHERE order_id=?' : ''} ORDER BY id DESC LIMIT ${lim(limit)}`, ...(orderId ? [orderId] : []));
      return txs.map((t) => ({ ...t, entries: q('SELECT e.dir,e.amount,a.kind,a.owner FROM ledger_entries e JOIN accounts a ON a.id=e.account_id WHERE e.tx_id=?', t.id) }));
    },
    audit(staff, { limit } = {}) { requirePerm(staff, 'p2p.audit.view'); return q(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ${lim(limit)}`); },
    alerts(staff) { requirePerm(staff, 'p2p.view'); return q('SELECT * FROM alerts ORDER BY id DESC LIMIT 100'); },
    reports(staff) { requirePerm(staff, 'p2p.view'); return q('SELECT * FROM reports ORDER BY id DESC LIMIT 100'); },
    ads(staff) { requirePerm(staff, 'p2p.view'); return q('SELECT * FROM ads ORDER BY created_at DESC LIMIT 200').map((a) => ({ ...adView(a), userId: a.user_id, realName: nameOf(a.user_id) })); },
    jobs(staff) { requirePerm(staff, 'p2p.view'); return q('SELECT * FROM jobs ORDER BY id DESC LIMIT 50'); },
    resetMerchant,
    reconcile(staff) { requirePerm(staff, 'p2p.reconcile'); return reconcile(); },
    runJobs(staff) { requirePerm(staff, 'p2p.reconcile'); return runJobs(); }
  };

  return {
    db, tx, q, q1, P2PError, can, parseUnits, fmtUnits, fiatFor, wallet, bridgeIn, bridgeOut, finishBridge, recoverBridge,
    getMerchant: merchantView, saveMerchant, createAd, setAdStatus, listAds, myAds, createOrder, markPaid, release, cancel, openDispute, takeDispute, resolveDispute,
    postMessage, listMessages, markMessagesRead, addEvidence, evidenceFile, getOrderFor, myOrders, processProviderEvent,
    expireDue, recoverStuck, runJobs, reconcile, report, admin, close: () => db.close()
  };
}
module.exports = { createService, P2PError, parseUnits, fmtUnits, fiatFor, can, FIATS };
