'use strict';

// QR peman admin yo rete anba DATA_DIR sou volume pèmanan an.
// Yo pa konfimasyon peman: tout validasyon depo ki deja egziste rete menm jan.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MIME, MAX_BYTES, sendImage } = require('./filestore');

const QR_SLOTS = Object.freeze({
  MonCash: ['account'], NatCash: ['account'], PayPal: ['account'],
  Zelle: ['account'], Meru: ['account'], CashApp: ['account'], Wise: ['account'],
  USDT: ['binance-id', 'binance-email', 'TRC20', 'BEP20']
});
const safeFile = (name) => typeof name === 'string' && /^[a-f0-9-]{36}\.(png|jpg|webp)$/.test(name);
const slotsFor = (method) => Object.hasOwn(QR_SLOTS, method) ? QR_SLOTS[method] : [];
const validSlot = (method, slot) => slotsFor(method).includes(slot);
function qrUrls(method, entry = {}) {
  return Object.fromEntries(slotsFor(method).filter((slot) => safeFile(entry?.qr?.[slot]))
    .map((slot) => [slot, `/api/deposit-qr/${method}/${slot}/${entry.qr[slot]}`]));
}
function configured(method, slot, entry) {
  if (method !== 'USDT') return !!entry.account;
  if (slot.startsWith('binance-')) return !!entry.binance?.[slot.slice(8)];
  return !!entry.networks?.[slot];
}
function destination(method, slot, entry = {}) {
  if (method !== 'USDT') return entry?.account || '';
  return slot.startsWith('binance-') ? entry?.binance?.[slot.slice(8)] || '' : entry?.networks?.[slot] || '';
}
function preservedQr(method, previous = {}, next = {}) {
  return Object.fromEntries(slotsFor(method).filter((slot) =>
    safeFile(previous?.qr?.[slot]) && destination(method, slot, next)
      && destination(method, slot, previous) === destination(method, slot, next))
    .map((slot) => [slot, previous.qr[slot]]));
}

function mount(app, { dataDir, auth, adminOnly, rateLimit, upload, detectExt, getSettings, saveSettings }) {
  const dir = path.join(dataDir, 'deposit-qr');
  const checkSlot = (req, res, next) => validSlot(req.params.method, req.params.slot)
    ? next() : res.status(400).json({ error: 'Metòd oswa destinasyon QR la pa valid.' });
  // Yon fòm sou yon lòt sit pa ka mete header sa a san yon CORS preflight.
  const sameOriginWrite = (req, res, next) => req.get('X-Requested-With') === 'XMLHttpRequest'
    ? next() : res.status(403).json({ error: 'Demann QR la pa otorize.' });
  const parseUpload = (req, res, next) => upload(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE'
      ? 'QR la dwe mwens pase 5 MB.' : 'Voye yon sèl imaj QR, san lòt fichye.' });
    next();
  });
  const removeQuiet = (name) => {
    if (safeFile(name)) {
      try { fs.rmSync(path.join(dir, name), { force: true }); }
      catch { console.error('[deposit-qr] Netwayaj ansyen imaj la echwe.'); }
    }
  };

  app.post('/api/admin/deposit-info/:method/qr/:slot', adminOnly, sameOriginWrite,
    rateLimit(30, 10 * 60 * 1000), checkSlot, parseUpload, (req, res) => {
      const ext = req.file && detectExt(req.file.buffer);
      if (!ext || MIME[ext] !== req.file.mimetype || !req.file.size || req.file.size > MAX_BYTES) {
        return res.status(400).json({ error: 'Chwazi yon imaj PNG, JPEG oswa WebP valid (5 MB maksimòm). SVG pa aksepte.' });
      }
      const { method, slot } = req.params;
      // Re-li apre multipart la pou pa efase lòt chanjman ki te fèt pandan upload la.
      const st = getSettings(), entry = st.deposit[method] || {};
      if (!configured(method, slot, entry)) {
        return res.status(400).json({ error: 'Sove kont, nimewo oswa rezo sa a anvan ou ajoute QR li.' });
      }
      const old = entry.qr?.[slot], name = crypto.randomUUID() + '.' + ext;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, name), req.file.buffer, { flag: 'wx', mode: 0o600 });
      try {
        saveSettings({ ...st, deposit: { ...st.deposit, [method]: { ...entry, qr: { ...entry.qr, [slot]: name } } } });
      } catch (err) { removeQuiet(name); throw err; }
      removeQuiet(old);
      res.status(201).json({ ok: true, url: qrUrls(method, { qr: { [slot]: name } })[slot] });
    });

  app.delete('/api/admin/deposit-info/:method/qr/:slot', adminOnly, sameOriginWrite, checkSlot, (req, res) => {
    const { method, slot } = req.params, st = getSettings(), entry = st.deposit[method] || {};
    const qr = { ...entry.qr }, old = qr[slot];
    delete qr[slot];
    saveSettings({ ...st, deposit: { ...st.deposit, [method]: { ...entry, qr } } });
    removeQuiet(old);
    res.json({ ok: true });
  });

  app.get('/api/deposit-qr/:method/:slot/:name', auth, (req, res) => {
    const { method, slot, name } = req.params;
    if (!validSlot(method, slot) || !safeFile(name)) return res.status(404).end();
    const entry = getSettings().deposit[method];
    if (!entry || entry.qr?.[slot] !== name) return res.status(404).end();
    if (req.user.role !== 'admin' && (!entry.active || !entry.account || !configured(method, slot, entry))) {
      return res.status(404).end();
    }
    const abs = path.join(dir, name);
    if (!fs.existsSync(abs)) return res.status(404).end();
    res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    return sendImage(res, { name, buffer: fs.readFileSync(abs) }, { download: req.query.download === '1' });
  });
  return {
    prune(before, after) {
      for (const [method, slots] of Object.entries(QR_SLOTS)) {
        for (const slot of slots) {
          const old = before[method]?.qr?.[slot];
          if (old && old !== after[method]?.qr?.[slot]) removeQuiet(old);
        }
      }
    }
  };
}

module.exports = { mount, qrUrls, preservedQr, QR_SLOTS };
