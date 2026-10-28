'use strict';
// Stockage itilizatè yo.
//  - Backend "supabase": tab public.users nan Supabase (REST/PostgREST via fetch, pa gen nouvo dependans).
//  - Backend "file": users.json (konpòtman ansyen an, pou devlopman lokal).
// Sèvè a gen yon kach an memwa (yon sèl replica). Lekti = senkron nan kach la. Ekriti = asynchrone,
// sove nan baz la ak yon nimewo vèsyon (optimistic locking) pou pa janm pèdi yon chanjman san ou pa konnen.
const fs = require('fs');

class ConflictError extends Error {
  constructor(msg) { super(msg || 'Done yo fèk chanje.'); this.name = 'ConflictError'; this.code = 'CONFLICT'; }
}

// ---------------------------------------------------------------- Supabase
function supabaseBackend({ url, key, timeoutMs = 10000, fetchImpl }) {
  const base = String(url).replace(/\/+$/, '') + '/rest/v1/users';
  const doFetch = fetchImpl || fetch;
  const baseHeaders = { apikey: key, 'Content-Type': 'application/json' };
  if (String(key).startsWith('eyJ')) baseHeaders.Authorization = 'Bearer ' + key; // ansyen kle JWT sèlman
  const enc = encodeURIComponent;

  async function call(method, qs, body, prefer) {
    const headers = { ...baseHeaders };
    if (prefer) headers.Prefer = prefer;
    let res;
    try {
      res = await doFetch(base + qs, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      throw new Error('Supabase pa reponn (' + (e && e.name ? e.name : 'erè rezo') + ')');
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* pa JSON */ }
    return { status: res.status, ok: res.ok, json, text };
  }
  const reason = (r) => String((r.json && (r.json.message || r.json.error)) || r.text || '').slice(0, 200);
  const fail = (what, r) => new Error(`Supabase ${what} echwe (${r.status}): ${reason(r)}`);
  const row = (id, data, version) => ({ id, email: data.email, uid: data.uid || null, data, version, updated_at: new Date().toISOString() });

  return {
    name: 'supabase',
    async loadAll() {
      const out = [], PAGE = 1000;
      for (let off = 0; ; off += PAGE) {
        const r = await call('GET', `?select=id,data,version&order=created_at.asc,id.asc&limit=${PAGE}&offset=${off}`);
        if (!r.ok || !Array.isArray(r.json)) throw fail('li itilizatè yo', r);
        for (const x of r.json) out.push({ id: x.id, data: x.data, ver: x.version });
        if (r.json.length < PAGE) break;
      }
      return out;
    },
    async get(id) {
      const r = await call('GET', `?id=eq.${enc(id)}&select=id,data,version`);
      if (!r.ok || !Array.isArray(r.json)) throw fail('li yon itilizatè', r);
      return r.json[0] ? { id: r.json[0].id, data: r.json[0].data, ver: r.json[0].version } : null;
    },
    async insert(id, data) {
      const r = await call('POST', '', row(id, data, 1), 'return=minimal');
      if (r.status === 409) throw new ConflictError('Imèl oswa ID sa a deja egziste.');
      if (!r.ok) throw fail('kreye itilizatè', r);
      return 1;
    },
    // retounen nouvo vèsyon an, oswa null si vèsyon an pa t kòrèk ankò (yon lòt moun chanje l)
    async update(id, ver, data) {
      const r = await call('PATCH', `?id=eq.${enc(id)}&version=eq.${Number(ver)}&select=version`, row(id, data, ver + 1), 'return=representation');
      if (r.status === 409) throw new ConflictError('Imèl sa a deja itilize.');
      if (!r.ok || !Array.isArray(r.json)) throw fail('mete itilizatè ajou', r);
      return r.json.length ? ver + 1 : null;
    },
    async remove(id) {
      const r = await call('DELETE', `?id=eq.${enc(id)}`);
      if (!r.ok) throw fail('efase itilizatè', r);
    }
  };
}

// ---------------------------------------------------------------- Fichye JSON (ansyen fason)
function fileBackend(file) {
  let rows = [];
  const write = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rows.map((r) => r.data), null, 2));
    fs.renameSync(tmp, file);
  };
  return {
    name: 'file',
    async loadAll() {
      let arr = [];
      try { arr = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* pa gen fichye ankò */ }
      rows = arr.map((d) => ({ id: d.id, data: d, ver: 1 }));
      return rows.map((r) => ({ ...r }));
    },
    async get(id) { const r = rows.find((x) => x.id === id); return r ? { ...r } : null; },
    async insert(id, data) {
      if (rows.some((r) => r.id === id || r.data.email === data.email)) throw new ConflictError('Imèl oswa ID sa a deja egziste.');
      rows.push({ id, data: structuredClone(data), ver: 1 });
      write();
      return 1;
    },
    async update(id, ver, data) {
      const r = rows.find((x) => x.id === id);
      if (!r) return null;
      r.data = structuredClone(data);
      write();
      return ver;
    },
    async remove(id) { rows = rows.filter((r) => r.id !== id); write(); }
  };
}

// ---------------------------------------------------------------- Store
function createStore({ backend, pendingFile = null, legacyFile = null, autoMigrate = false, log = console }) {
  const cache = new Map();      // id -> { data, ver (vèsyon baz la), rev (kontè lokal), dirty, isNew }
  const bases = new WeakMap();  // lis ki soti nan loadUsers() -> Map(id -> { data, rev })
  const locks = new Map();      // yon sèl ekriti alafwa pou chak itilizatè
  let pending = {};             // jounal lokal pou operasyon senkron (pon P2P) pandan yo poko nan Supabase

  function lock(id, fn) {
    const prev = locks.get(id) || Promise.resolve();
    const p = prev.catch(() => {}).then(() => fn());
    const clean = () => { if (locks.get(id) === p) locks.delete(id); };
    locks.set(id, p);
    p.then(clean, clean);
    return p;
  }

  function writePending() {
    if (!pendingFile) return;
    const tmp = pendingFile + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(pending)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, pendingFile);
  }

  // Dwe rele anndan lock(id). Ekri dènye done kach la nan baz la.
  async function flush(id) {
    for (let i = 0; i < 5; i++) {
      const e = cache.get(id);
      if (!e || !e.dirty) break;
      const rev = e.rev, data = e.data;
      if (e.isNew) { e.ver = await backend.insert(id, data); e.isNew = false; }
      else {
        const v = await backend.update(id, e.ver, data);
        if (v === null) throw new ConflictError('Yon lòt sèvè te chanje itilizatè sa a.');
        e.ver = v;
      }
      if (e.rev === rev) e.dirty = false;
    }
    const e = cache.get(id);
    if (e && !e.dirty && pending[id]) { delete pending[id]; writePending(); }
  }

  async function reloadUser(id) {
    const r = await backend.get(id);
    const old = cache.get(id);
    if (old && old.dirty) return;
    if (!r) cache.delete(id);
    else cache.set(id, { data: r.data, ver: r.ver, rev: (old ? old.rev : 0) + 1, dirty: false });
  }

  function backgroundFlush(id, attempt = 0) {
    lock(id, () => flush(id)).catch((err) => {
      if (err instanceof ConflictError) {
        log.error('[users] KONFLI nan baz la pou', id, '-', err.message, '(jounal lokal la rete; verifye alamen)');
        return;
      }
      const delay = Math.min(30000, 1000 * 2 ** attempt);
      log.error('[users] sove nan Supabase echwe pou', id, '-', err.message, `(re-eseye nan ${delay / 1000}s)`);
      setTimeout(() => backgroundFlush(id, attempt + 1), delay).unref();
    });
  }

  async function init() {
    let rows = await backend.loadAll();
    if (backend.name === 'supabase' && rows.length === 0 && legacyFile) {
      let legacy = [];
      try { legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8')); } catch { /* pa gen fichye */ }
      if (Array.isArray(legacy) && legacy.length) {
        if (!autoMigrate) {
          throw new Error(`Supabase vid men ${legacyFile} gen ${legacy.length} itilizatè. Mete MIGRATE_USERS_ON_BOOT=true nan Variables (yon sèl fwa), redeploy, epi retire l apre.`);
        }
        // Kopi sèlman (pa efase users.json). Sèlman si Supabase vid.
        const seen = new Set();
        for (const u of legacy) {
          if (!u.id || !u.email || seen.has(u.id) || seen.has(u.email)) throw new Error('users.json gen done ki pa valid oswa double: ' + (u.email || u.id));
          seen.add(u.id); seen.add(u.email);
        }
        log.log(`[users] ap kopye ${legacy.length} itilizatè nan Supabase...`);
        for (const u of legacy) await backend.insert(u.id, u);
        rows = await backend.loadAll();
        if (rows.length !== legacy.length) throw new Error(`Migrasyon pa konplè: ${rows.length}/${legacy.length}. Pa demare.`);
        log.log(`[users] migrasyon fini: ${rows.length} itilizatè. Retire MIGRATE_USERS_ON_BOOT nan Variables.`);
      }
    }
    for (const r of rows) cache.set(r.id, { data: r.data, ver: r.ver, rev: 1, dirty: false });
    if (pendingFile) {
      try { pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); } catch { pending = {}; }
      for (const [id, p] of Object.entries(pending)) {
        const e = cache.get(id);
        if (!e && p.isNew) {
          cache.set(id, { data: p.data, ver: 0, rev: 1, dirty: true, isNew: true });
          backgroundFlush(id);
        } else if (e && e.ver === p.ver) { // chanjman sa a pa t rive nan Supabase: aplike l ankò
          e.data = p.data; e.rev += 1; e.dirty = true;
          backgroundFlush(id);
        } else {
          log.warn('[users] jounal lokal ignore pou', id, '(Supabase deja gen yon vèsyon pi nouvo)');
          delete pending[id];
        }
      }
      writePending();
    }
  }

  // ---- API piblik
  function loadUsers() {
    const arr = [], base = new Map();
    for (const [id, e] of cache) { arr.push(structuredClone(e.data)); base.set(id, { data: e.data, rev: e.rev }); }
    bases.set(arr, base);
    return arr;
  }

  function getUser(id) {
    const e = cache.get(id);
    return e ? structuredClone(e.data) : null;
  }

  async function persistChange({ u, b, isNew }, base) {
    const id = u.id;
    let e = cache.get(id), prev = null;
    if (isNew) {
      if (e) throw new ConflictError('ID sa a deja egziste.');
      for (const x of cache.values()) if (x.data.email === u.email) throw new ConflictError('Imèl sa a deja itilize.');
      e = { data: structuredClone(u), ver: 0, rev: 1, dirty: true, isNew: true };
      cache.set(id, e);
    } else {
      if (!e || e.rev !== b.rev) throw new ConflictError();
      prev = { data: e.data, dirty: e.dirty };
      e.data = structuredClone(u); e.rev += 1; e.dirty = true;
    }
    const myRev = e.rev;
    try {
      await lock(id, () => flush(id));
    } catch (err) {
      const cur = cache.get(id);
      if (cur && cur.rev === myRev) {            // pèsonn pa manyen l apre nou: nou ka defèt chanjman an
        if (isNew) cache.delete(id);
        else { cur.data = prev.data; cur.dirty = prev.dirty; cur.rev = myRev + 1; if (cur.dirty) backgroundFlush(id); }
      } else if (cur && cur.dirty) backgroundFlush(id);
      if (err instanceof ConflictError && !isNew) await reloadUser(id).catch(() => {});
      throw err;
    }
    base.set(id, { data: cache.get(id).data, rev: cache.get(id).rev });
  }

  // Sove chanjman yo nan yon lis ki soti nan loadUsers(). Rele ak await. Voye ConflictError si done yo te chanje.
  // Nòt: si plizyè itilizatè chanje nan yon sèl rele, yo sove youn apre lòt (pa yon sèl tranzaksyon).
  async function saveUsers(arr) {
    const base = bases.get(arr);
    if (!base) throw new Error('saveUsers: lis la dwe soti nan loadUsers().');
    const changes = [];
    for (const u of arr) {
      const b = base.get(u.id);
      if (!b) changes.push({ u, isNew: true });
      else if (JSON.stringify(u) !== JSON.stringify(b.data)) changes.push({ u, b });
    }
    for (const ch of changes) await persistChange(ch, base);
  }

  // Operasyon senkron (pou pon P2P la ki pa ka tann). fn(draft) -> { result, changed }.
  // Chanjman an ekri nan yon jounal lokal (fsync) anvan li retounen, epi li ale nan Supabase an background.
  function applySync(id, fn) {
    const e = cache.get(id);
    if (!e) return fn(null).result;
    const draft = structuredClone(e.data);
    const out = fn(draft);
    if (out.changed) {
      const prevPending = pending[id];
      pending[id] = { ver: e.ver, isNew: !!e.isNew, data: draft };
      try { writePending(); } catch (err) {
        if (prevPending) pending[id] = prevPending; else delete pending[id];
        throw err;
      }
      e.data = draft; e.rev += 1; e.dirty = true;
      backgroundFlush(id);
    }
    return out.result;
  }

  async function removeUser(id) {
    await lock(id, async () => {
      await backend.remove(id);
      cache.delete(id);
      if (pending[id]) { delete pending[id]; writePending(); }
    });
  }

  async function flushAll() {
    for (const [id, e] of [...cache]) {
      if (e.dirty) { try { await lock(id, () => flush(id)); } catch (err) { log.error('[users] flushAll', id, err.message); } }
    }
  }

  return { init, loadUsers, getUser, saveUsers, applySync, removeUser, flushAll, _cache: cache };
}

module.exports = { createStore, supabaseBackend, fileBackend, ConflictError };
