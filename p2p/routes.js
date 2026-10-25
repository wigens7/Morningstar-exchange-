'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { P2PError, parseUnits } = require('./service');

// Siyati HMAC-SHA256 (hex) sou kò brit demann lan. Konparezon an tan konstan.
function verifySignature(secret, rawBody, signature) {
  if (!secret || !rawBody || !signature) return false;
  const exp = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
  const got = Buffer.from(String(signature).replace(/^sha256=/, ''));
  return exp.length === got.length && crypto.timingSafeEqual(exp, got);
}

function mount(app, deps) {
  const { auth, rateLimit, service: S, upload, detectExt, evidenceDir, isStaffRole } = deps;
  const pin = deps.pinGuard || ((q, s, n) => n()); // si kliyan an gen PIN, li mande l sou lage USDT ak retrè
  fs.mkdirSync(evidenceDir, { recursive: true });

  const viewerOf = (req) => ({ id: req.user.id, role: req.user.role || 'user', staff: isStaffRole(req.user.role) });
  const fail = (res, e) => {
    if (e instanceof P2PError) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error('[p2p]', e);
    res.status(500).json({ error: 'Erè sèvè. Eseye ankò.' });
  };
  const h = (fn) => (req, res) => { try { const out = fn(req, res); if (out !== undefined && !res.headersSent) res.json(out); } catch (e) { fail(res, e); } };
  const staffOnly = (req, res, next) => auth(req, res, () => (isStaffRole(req.user.role) ? next() : res.status(403).json({ error: 'Pa otorize.' })));
  const idemKey = (req) => { const k = String(req.get('idempotency-key') || '').trim(); return /^[\w-]{8,100}$/.test(k) ? k : null; };
  const ip = (req) => req.ip;
  const tight = rateLimit(30, 60e3), loose = rateLimit(120, 60e3);

  // ----- pòtfèy + pon -----
  app.get('/api/p2p/wallet', auth, loose, h((req) => S.wallet(req.user.id)));
  const cents = (v) => Math.round(Number(parseUnits(v, 2)));
  app.post('/api/p2p/wallet/deposit', auth, tight, h((req) => { S.bridgeIn(req.user.id, cents(req.body.amount), idemKey(req)); return S.wallet(req.user.id); }));
  app.post('/api/p2p/wallet/withdraw', auth, tight, pin, h((req) => { S.bridgeOut(req.user.id, cents(req.body.amount), idemKey(req)); return S.wallet(req.user.id); }));

  // ----- anons -----
  app.get('/api/p2p/ads', auth, loose, h((req) => S.listAds({ type: req.query.type, fiat: req.query.fiat, method: req.query.method || '', amount: req.query.amount || '', viewerId: req.user.id })));
  app.get('/api/p2p/my-ads', auth, loose, h((req) => S.myAds(req.user.id)));
  app.post('/api/p2p/ads', auth, tight, h((req, res) => { res.status(201); return S.createAd(req.user.id, req.body, idemKey(req), ip(req)); }));
  app.post('/api/p2p/ads/:id/status', auth, tight, h((req) => S.setAdStatus(viewerOf(req), req.params.id, String(req.body.status), null, ip(req))));

  // ----- lòd -----
  app.post('/api/p2p/orders', auth, tight, h((req, res) => { res.status(201); return S.createOrder(req.user.id, req.body, idemKey(req), ip(req)); }));
  app.get('/api/p2p/orders', auth, loose, h((req) => S.myOrders(req.user.id)));
  app.get('/api/p2p/orders/:id', auth, loose, h((req) => S.getOrderFor(viewerOf(req), req.params.id)));
  app.post('/api/p2p/orders/:id/paid', auth, tight, h((req) => S.markPaid(req.user.id, req.params.id, req.body.reference, ip(req))));
  app.post('/api/p2p/orders/:id/release', auth, tight, pin, h((req) => S.release(req.user.id, req.params.id, ip(req))));
  app.post('/api/p2p/orders/:id/cancel', auth, tight, h((req) => S.cancel(req.user.id, req.params.id, ip(req))));
  app.post('/api/p2p/orders/:id/dispute', auth, tight, h((req) => S.openDispute(req.user.id, req.params.id, req.body.reason, ip(req))));

  // ----- chat -----
  app.get('/api/p2p/orders/:id/messages', auth, loose, h((req) => S.listMessages(viewerOf(req), req.params.id, req.query.after)));
  app.post('/api/p2p/orders/:id/messages', auth, tight, h((req) => S.postMessage(viewerOf(req), req.params.id, req.body.body)));

  // ----- prèv (foto) -----
  app.post('/api/p2p/orders/:id/evidence', auth, tight, (req, res) => {
    upload(req, res, (err) => {
      try {
        if (err) throw new P2PError('UPLOAD', 400, err.code === 'LIMIT_FILE_SIZE' ? 'Foto a twò gwo (maks 5 MB).' : 'Pwoblèm ak fichye a.');
        const f = req.file;
        if (!f) throw new P2PError('UPLOAD', 400, 'Ajoute yon foto.');
        const ext = detectExt(f.buffer);
        if (!ext) throw new P2PError('UPLOAD', 400, 'Sèlman foto JPG, PNG oswa WEBP.');
        const orderId = String(req.params.id).replace(/[^\w-]/g, '');
        const rel = path.join(orderId, crypto.randomUUID() + '.' + ext);
        const abs = path.join(evidenceDir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
        fs.writeFileSync(abs, f.buffer, { mode: 0o600 });
        try {
          const r = S.addEvidence(viewerOf(req), req.params.id, String(req.body.kind || ''), rel, crypto.createHash('sha256').update(f.buffer).digest('hex'));
          res.status(201).json(r);
        } catch (e) { fs.rmSync(abs, { force: true }); throw e; }
      } catch (e) { fail(res, e); }
    });
  });
  app.get('/api/p2p/evidence/:id', auth, loose, (req, res) => {
    try { const ev = S.evidenceFile(viewerOf(req), req.params.id); res.sendFile(path.join(evidenceDir, ev.file)); } catch (e) { fail(res, e); }
  });

  app.post('/api/p2p/reports', auth, tight, h((req) => S.report(req.user.id, String(req.body.targetType), String(req.body.targetId), req.body.reason)));

  // ----- webhook pwovizè (sèlman si P2P_WEBHOOK_SECRET_<PROVIZÈ> konfigire) -----
  app.post('/api/p2p/webhooks/:provider', rateLimit(300, 60e3), (req, res) => {
    try {
      const provider = String(req.params.provider).toLowerCase().replace(/[^a-z0-9]/g, '');
      const secret = process.env['P2P_WEBHOOK_SECRET_' + provider.toUpperCase()];
      if (!secret) return res.status(503).json({ error: 'Pwovizè sa a pa konfigire.' });
      if (!verifySignature(secret, req.rawBody, req.get('x-signature'))) return res.status(401).json({ error: 'Siyati envalid.' });
      res.json(S.processProviderEvent(provider, req.body || {}));
    } catch (e) { fail(res, e); }
  });

  // ----- admin / staff -----
  const A = S.admin;
  const st = (req) => ({ id: req.user.id, role: req.user.role });
  app.get('/api/p2p/admin/orders', staffOnly, h((req) => A.orders(st(req), { status: req.query.status, limit: req.query.limit })));
  app.get('/api/p2p/admin/orders/:id', staffOnly, h((req) => A.order(st(req), req.params.id)));
  app.get('/api/p2p/admin/disputes', staffOnly, h((req) => A.disputes(st(req), { status: req.query.status })));
  app.get('/api/p2p/admin/disputes/:id/decisions', staffOnly, h((req) => A.decisions(st(req), Number(req.params.id))));
  app.post('/api/p2p/admin/disputes/:id/take', staffOnly, h((req) => S.takeDispute(st(req), Number(req.params.id), ip(req))));
  app.post('/api/p2p/admin/disputes/:id/resolve', staffOnly, h((req) => S.resolveDispute(st(req), Number(req.params.id), String(req.body.decision), req.body.reason, ip(req))));
  app.post('/api/p2p/admin/orders/:id/messages', staffOnly, h((req) => S.postMessage({ ...viewerOf(req) }, req.params.id, req.body.body)));
  app.get('/api/p2p/admin/escrows', staffOnly, h((req) => A.escrows(st(req))));
  app.get('/api/p2p/admin/ledger', staffOnly, h((req) => A.ledger(st(req), { limit: req.query.limit, orderId: req.query.orderId })));
  app.get('/api/p2p/admin/audit', staffOnly, h((req) => A.audit(st(req), { limit: req.query.limit })));
  app.get('/api/p2p/admin/alerts', staffOnly, h((req) => A.alerts(st(req))));
  app.get('/api/p2p/admin/reports', staffOnly, h((req) => A.reports(st(req))));
  app.get('/api/p2p/admin/ads', staffOnly, h((req) => A.ads(st(req))));
  app.post('/api/p2p/admin/ads/:id/suspend', staffOnly, h((req) => S.setAdStatus(st(req), req.params.id, 'SUSPENDED', req.body.reason, ip(req))));
  app.get('/api/p2p/admin/jobs', staffOnly, h((req) => A.jobs(st(req))));
  app.post('/api/p2p/admin/reconcile', staffOnly, h((req) => A.reconcile(st(req))));
  app.post('/api/p2p/admin/run-jobs', staffOnly, h((req) => A.runJobs(st(req))));
}

module.exports = { mount, verifySignature };
