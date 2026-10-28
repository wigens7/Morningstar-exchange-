'use strict';
// Estokaj foto KYC + prèv P2P nan Supabase Storage (buckets PRIVE), ak lekti ansyen fichye sou disk (Railway Volume).
// Se sèvè a SÈL ki pale ak Supabase (kle service_role pa janm kite sèvè a). Pa gen URL piblik: foto yo sèvi atravè sèvè a, apre otorizasyon.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const MAX_BYTES = 5 * 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/; // non fichye (pa gen / ni ..)
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}){0,3}$/;

class StorageError extends Error {
  constructor(msg, status) { super(msg); this.name = 'StorageError'; this.code = 'STORAGE'; this.status = status || 503; }
}

// ---------------------------------------------------------------- Kliyan Supabase Storage (REST)
function supabaseStorage({ url, key, timeoutMs = 15000, fetchImpl }) {
  const base = String(url).replace(/\/+$/, '') + '/storage/v1/object';
  const doFetch = fetchImpl || fetch;
  const headers = { apikey: key };
  if (String(key).startsWith('eyJ')) headers.Authorization = 'Bearer ' + key; // ansyen kle JWT sèlman
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  const target = (bucket, p) => {
    if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(bucket)) throw new StorageError('Non bucket pa valid.', 500);
    if (!SAFE_PATH.test(p) || p.includes('..')) throw new StorageError('Chemen fichye pa valid.', 500);
    return `${base}/${encodeURIComponent(bucket)}/${enc(p)}`;
  };
  async function call(method, u, opts = {}) {
    try {
      return await doFetch(u, { method, headers: { ...headers, ...(opts.headers || {}) }, body: opts.body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) { throw new StorageError('Supabase Storage pa reponn (' + (e && e.name ? e.name : 'erè rezo') + ')'); }
  }
  const msg = async (r) => { try { const j = await r.json(); return String(j.message || j.error || '').slice(0, 160); } catch { return ''; } };
  const isNotFound = async (r) => {
    if (r.status === 404) return true;
    if (r.status === 400) { try { const j = await r.clone().json(); return String(j.statusCode) === '404' || j.error === 'not_found'; } catch { return false; } }
    return false;
  };
  return {
    // upsert=false: pa janm ranplase yon fichye ki deja la
    async put(bucket, p, buffer, contentType) {
      const r = await call('POST', target(bucket, p), { headers: { 'Content-Type': contentType, 'x-upsert': 'false' }, body: buffer });
      if (!r.ok) throw new StorageError(`Supabase Storage upload echwe (${r.status}): ${await msg(r)}`);
      await r.arrayBuffer().catch(() => {}); // konsome repons lan pou libere koneksyon an
    },
    // retounen { buffer } oswa null si pa egziste
    async get(bucket, p) {
      const r = await call('GET', target(bucket, p));
      if (await isNotFound(r)) return null;
      if (!r.ok) throw new StorageError(`Supabase Storage lekti echwe (${r.status}): ${await msg(r)}`);
      return { buffer: Buffer.from(await r.arrayBuffer()) };
    },
    async remove(bucket, p) {
      const r = await call('DELETE', target(bucket, p));
      if (r.ok) { await r.arrayBuffer().catch(() => {}); return; }
      if (await isNotFound(r)) return;
      throw new StorageError(`Supabase Storage efasman echwe (${r.status}): ${await msg(r)}`);
    }
  };
}

// ---------------------------------------------------------------- Couche fichye (Supabase + disk ansyen)
// opts: { storage|null, writeToStorage: bool, kycBucket, p2pBucket, kycDir, p2pDir, log }
function createFiles(opts) {
  const { storage = null, writeToStorage = false, kycBucket = 'kyc-documents', p2pBucket = 'p2p-evidence', kycDir, p2pDir, log = console } = opts;
  const bucketOf = (kind) => (kind === 'kyc' ? kycBucket : p2pBucket);
  const extOf = (name) => (String(name).split('.').pop() || '').toLowerCase();
  const inside = (root, abs) => { const r = path.resolve(root) + path.sep; return path.resolve(abs).startsWith(r); };

  const api = {
    canRead: !!storage,
    canWrite: !!storage && !!writeToStorage,
    kycBucket, p2pBucket,
    ext: extOf,
    mime: (name) => MIME[extOf(name)] || null,

    async put(kind, p, buffer, ext) {
      if (!storage) throw new StorageError('Supabase Storage pa konfigire.', 503);
      if (!MIME[ext]) throw new StorageError('Tip fichye pa aksepte.', 400);
      if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_BYTES) throw new StorageError('Fichye a twò gwo oswa vid.', 400);
      await storage.put(bucketOf(kind), p, buffer, MIME[ext]);
    },
    async get(kind, p) { if (!storage) throw new StorageError('Supabase Storage pa konfigire.', 503); return storage.get(bucketOf(kind), p); },
    async remove(kind, p) { if (storage) await storage.remove(bucketOf(kind), p); },
    async removeQuiet(kind, p) { try { await api.remove(kind, p); } catch (e) { log.error('[files] efasman echwe', kind, p, '-', e.message); } },

    // ---------- KYC ----------
    // saved = { slot: { ext, buffer } }. Retounen { files, store, undo() }. Si yon upload echwe, sa ki te fin monte a efase epi li voye erè.
    async saveKyc(userId, saved) {
      if (!api.canWrite) {
        // ansyen konpòtman (disk lokal)
        const dir = path.join(kycDir, userId);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const files = {};
        for (const [slot, { ext, buffer }] of Object.entries(saved)) {
          files[slot] = `${slot}.${ext}`;
          fs.writeFileSync(path.join(dir, files[slot]), buffer, { mode: 0o600 });
        }
        return { files, store: undefined, undo: async () => {} };
      }
      const tag = crypto.randomBytes(6).toString('hex');
      const files = {}, done = [];
      try {
        for (const [slot, { ext, buffer }] of Object.entries(saved)) {
          const name = `${slot}-${tag}.${ext}`;
          await api.put('kyc', `${userId}/${name}`, buffer, ext);
          files[slot] = name; done.push(name);
        }
      } catch (e) {
        for (const n of done) await api.removeQuiet('kyc', `${userId}/${n}`);
        throw e;
      }
      return { files, store: 'supabase', undo: async () => { for (const n of done) await api.removeQuiet('kyc', `${userId}/${n}`); } };
    },
    // Efase ansyen foto yo (apre nouvo soumisyon an fin sove, oswa lè yo efase kont lan)
    async removeKyc(userId, kyc, { disk = true } = {}) {
      if (kyc && kyc.store === 'supabase' && kyc.files) {
        for (const n of Object.values(kyc.files)) if (SAFE_NAME.test(String(n))) await api.removeQuiet('kyc', `${userId}/${n}`);
      }
      if (disk) { try { fs.rmSync(path.join(kycDir, userId), { recursive: true, force: true }); } catch (e) { log.error('[files] efase dosye disk KYC', e.message); } }
    },
    // retounen { buffer, name } oswa null (pa jwenn). Ansyen fichye sou disk yo toujou li.
    async readKyc(user, slot) {
      const name = user && user.kyc && user.kyc.files && Object.prototype.hasOwnProperty.call(user.kyc.files, slot) ? String(user.kyc.files[slot]) : null;
      if (!name || !SAFE_NAME.test(name) || !MIME[extOf(name)]) return null;
      if (user.kyc.store === 'supabase') {
        const o = await api.get('kyc', `${user.id}/${name}`);
        return o ? { buffer: o.buffer, name } : null;
      }
      const abs = path.join(kycDir, user.id, name);
      if (!inside(path.join(kycDir, user.id), abs) || !fs.existsSync(abs)) return null;
      return { buffer: fs.readFileSync(abs), name };
    },

    // ---------- P2P ----------
    // Anrejistreman nan baz la: "sb:<orderId>/<non>" = Supabase, sinon chemen relatif sou disk (ansyen).
    async saveEvidence(orderId, ext, buffer) {
      const name = crypto.randomUUID() + '.' + ext;
      if (!api.canWrite) {
        const rel = path.join(orderId, name), abs = path.join(p2pDir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
        fs.writeFileSync(abs, buffer, { mode: 0o600 });
        return { ref: rel, undo: async () => fs.rmSync(abs, { force: true }) };
      }
      const p = `${orderId}/${name}`;
      await api.put('p2p', p, buffer, ext);
      return { ref: 'sb:' + p, undo: () => api.removeQuiet('p2p', p) };
    },
    async readEvidence(ref) {
      ref = String(ref || '');
      if (ref.startsWith('sb:')) {
        const p = ref.slice(3);
        const o = await api.get('p2p', p);
        return o ? { buffer: o.buffer, name: p.split('/').pop() } : null;
      }
      const abs = path.join(p2pDir, ref);
      if (!inside(p2pDir, abs) || !fs.existsSync(abs)) return null;
      return { buffer: fs.readFileSync(abs), name: path.basename(abs) };
    }
  };
  return api;
}

// Voye yon imaj bay kliyan an ak header sekirite. Tip la sòti nan ekstansyon fichye nou menm nou kreye a (pa nan Storage).
function sendImage(res, { buffer, name }, { download = false, filename } = {}) {
  const ext = String(name).split('.').pop().toLowerCase();
  const type = MIME[ext];
  if (!type) return res.status(404).json({ error: 'Fichye a pa jwenn.' });
  res.set({
    'Content-Type': type,
    'Content-Length': String(buffer.length),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${String(filename || name).replace(/[^\w.-]/g, '_')}"`
  });
  return res.status(200).end(buffer);
}

module.exports = { supabaseStorage, createFiles, sendImage, StorageError, MIME, MAX_BYTES };
