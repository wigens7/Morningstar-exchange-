'use strict';

// Preparasyon sèlman: okenn fonksyon nan modil sa a pa rele ZiiroPay,
// pa resevwa dokiman KYC, ni pa li/modifye balans kliyan.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WEBHOOK_PATH = '/api/webhooks/ziiropay';
const KYC_PATH = '/card-kyc.html';
const MAX_PRICE_CENTS = 99999999;

function usdToCents(value) {
  // Montan soti nan yon string desimal, pa floating-point oswa exponent.
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return cents <= MAX_PRICE_CENTS ? cents : null;
}

function createCardSettings(dataDir) {
  const file = path.join(dataDir, 'virtual-card-settings.json');
  function read() {
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
      if (e.code === 'ENOENT') return { revision: null, creationPriceCents: null, updatedAt: null };
      throw new Error('CARD_SETTINGS_UNAVAILABLE');
    }
    if (!value || value.schemaVersion !== 1 ||
        typeof value.revision !== 'string' || !/^[a-f0-9-]{36}$/.test(value.revision) ||
        !Number.isSafeInteger(value.creationPriceCents) || value.creationPriceCents < 0 ||
        value.creationPriceCents > MAX_PRICE_CENTS ||
        typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) {
      throw new Error('CARD_SETTINGS_UNAVAILABLE');
    }
    return value;
  }
  function save(price, revision) {
    const cents = usdToCents(price);
    if (cents === null) return { error: 'INVALID_PRICE' };
    const current = read();
    if (revision !== current.revision) return { error: 'STALE_SETTINGS' };
    const value = {
      schemaVersion: 1, revision: crypto.randomUUID(),
      creationPriceCents: cents, updatedAt: new Date().toISOString()
    };
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    let fd;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(value));
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
      const directory = fs.openSync(dataDir, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch {
      throw new Error('CARD_SETTINGS_UNAVAILABLE');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch {}
    }
    return value;
  }
  return { read, save };
}

function publicSetup(value) {
  return {
    currency: 'USD',
    creationPriceUSD: value.creationPriceCents === null ? null : (value.creationPriceCents / 100).toFixed(2),
    creationPriceConfigured: value.creationPriceCents !== null,
    cardOperationsEnabled: false,
    withdrawalEnabled: false,
    kycSubmissionEnabled: false,
    webhookVerificationReady: false,
    kycPath: KYC_PATH
  };
}

function mountVirtualCardSetup(app, { dataDir, auth, adminOnly, rateLimit, pageFile, settings = createCardSettings(dataDir) }) {
  const noStore = (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); };
  app.get('/api/admin/virtual-cards/settings', noStore, adminOnly, (req, res) => {
    try {
      const value = settings.read();
      res.json({ ...publicSetup(value), revision: value.revision, updatedAt: value.updatedAt, webhookPath: WEBHOOK_PATH });
    } catch {
      res.status(503).json({ code: 'CARD_SETTINGS_UNAVAILABLE', error: 'Pri kat la pa disponib. Pa gen operasyon finansye ki fèt.' });
    }
  });
  app.post('/api/admin/virtual-cards/settings', noStore, adminOnly, (req, res, next) => {
    if (req.get('X-Requested-With') !== 'XMLHttpRequest') return res.status(403).json({ error: 'Demann lan pa otorize.' });
    next();
  }, rateLimit(20, 15 * 60 * 1000), (req, res) => {
    // Rejte kle siplemantè: yon kliyan pa ka aktive retrè oswa operasyon yo.
    const body = req.body;
    if (!body || Array.isArray(body) ||
        Object.keys(body).some((k) => !['creationPriceUSD', 'revision'].includes(k))) {
      return res.status(400).json({ error: 'Demann pri kat la pa valid.' });
    }
    try {
      const value = settings.save(body.creationPriceUSD, body.revision);
      if (value.error === 'INVALID_PRICE') return res.status(400).json({ error: 'Mete yon pri USD ant 0 ak 999999.99, avèk 2 desimal maksimòm.' });
      if (value.error === 'STALE_SETTINGS') return res.status(409).json({ error: 'Pri a fèk chanje. Rechaje seksyon an anvan ou sove ankò.' });
      res.json({ ...publicSetup(value), revision: value.revision, updatedAt: value.updatedAt, webhookPath: WEBHOOK_PATH });
    } catch {
      res.status(503).json({ code: 'CARD_SETTINGS_UNAVAILABLE', error: 'Nou pa ka sove pri kat la. Rechaje seksyon an pou verifye valè a.' });
    }
  });
  app.get('/api/virtual-cards/setup', noStore, auth, (req, res) => {
    try { res.json(publicSetup(settings.read())); }
    catch { res.status(503).json({ code: 'CARD_SETTINGS_UNAVAILABLE', error: 'Preparasyon kat la pa disponib.' }); }
  });
  app.get(KYC_PATH, noStore, (req, res, next) => {
    // HTML pa kenbe PII; sesyon an nesesè menm pou paj preparasyon an.
    res.set({ 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    auth(req, res, next);
  }, (req, res) => res.sendFile(pageFile));
  app.post('/api/virtual-cards/kyc', noStore, auth, (req, res) => {
    // Pa kolekte, pa estoke, pa retransmèt PII pandan entegrasyon an fèmen.
    res.status(503).json({ code: 'CARD_KYC_NOT_ENABLED', error: 'Soumisyon KYC kat la poko aktive. Pa voye dokiman kounye a.' });
  });
}

function mountZiiroPayWebhook(app) {
  // Monte anvan JSON parser la: menm JSON malfòme pa dwe antre nan logs.
  // Pa envante yon siyati: dokiman piblik yo pa bay header/algoritm lan.
  // Pa akize resepsyon avèk 2xx, pa anrejistre payload, pa voye imel,
  // pa rele founisè a, pa kredite/debite okenn balans, menm si JSON di success.
  app.post(WEBHOOK_PATH, (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.status(503).json({ code: 'ZIIROPAY_WEBHOOK_NOT_ENABLED', error: 'Verifikasyon webhook la poko aktive.' });
  });
  app.get(WEBHOOK_PATH, (req, res) => {
    res.set({ 'Cache-Control': 'no-store', Allow: 'POST' });
    res.status(405).json({ code: 'WEBHOOK_POST_ONLY' });
  });
}

module.exports = { createCardSettings, mountVirtualCardSetup, mountZiiroPayWebhook, usdToCents, publicSetup, WEBHOOK_PATH, KYC_PATH };
