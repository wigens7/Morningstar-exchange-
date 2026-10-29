'use strict';
// Chat support (live chat): mesaj kliyan <-> staff. SÈLMAN TÈKS. Sove nan Supabase (tab public.support_messages),
// oswa nan yon fichye JSON si Supabase pa konfigire (devlopman).
const fs = require('fs');

const MAX_LEN = 1000;
// Netwaye yon mesaj: sèlman string, retire karaktè kontwòl, 1..1000 karaktè. Retounen null si pa valid.
function cleanBody(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '');
  s = s.replace(/\n{4,}/g, '\n\n\n').trim();
  return s.length >= 1 && s.length <= MAX_LEN ? s : null;
}

class SupportError extends Error { constructor(m) { super(m); this.name = 'SupportError'; this.code = 'SUPPORT'; } }

// ---------------------------------------------------------------- Supabase (REST)
function supabaseSupport({ url, key, timeoutMs = 10000, fetchImpl }) {
  const base = String(url).replace(/\/+$/, '') + '/rest/v1/support_messages';
  const doFetch = fetchImpl || fetch;
  const baseHeaders = { apikey: key, 'Content-Type': 'application/json' };
  if (String(key).startsWith('eyJ')) baseHeaders.Authorization = 'Bearer ' + key;
  const enc = encodeURIComponent;
  async function call(method, qs, body, prefer) {
    const headers = { ...baseHeaders }; if (prefer) headers.Prefer = prefer;
    let res;
    try { res = await doFetch(base + qs, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw new SupportError('Supabase pa reponn (' + (e && e.name ? e.name : 'erè rezo') + ')'); }
    const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* pa JSON */ }
    if (!res.ok) throw new SupportError(`Supabase chat echwe (${res.status}): ${String((json && (json.message || json.error)) || text).slice(0, 160)}`);
    return json;
  }
  return {
    name: 'supabase',
    async add({ userId, sender, staffId, body }) {
      const rows = await call('POST', '?select=id,user_id,sender,body,created_at', { user_id: userId, sender, staff_id: staffId || null, body }, 'return=representation');
      if (!Array.isArray(rows) || !rows[0]) throw new SupportError('Supabase pa retounen mesaj la.');
      return rows[0];
    },
    async list(userId, after, limit) {
      const sel = 'select=id,sender,body,created_at,staff_read';
      if (after > 0) return call('GET', `?user_id=eq.${enc(userId)}&id=gt.${Number(after)}&order=id.asc&limit=${limit}&${sel}`);
      const rows = await call('GET', `?user_id=eq.${enc(userId)}&order=id.desc&limit=${limit}&${sel}`);
      return rows.reverse();
    },
    async recent(limit) { return call('GET', `?select=id,user_id,sender,body,created_at&order=id.desc&limit=${limit}`); },
    async unreadRows() { return call('GET', '?sender=eq.user&staff_read=eq.false&select=user_id&limit=5000'); },
    async markRead(userId) { await call('PATCH', `?user_id=eq.${enc(userId)}&sender=eq.user&staff_read=eq.false`, { staff_read: true }, 'return=minimal'); },
    async removeThread(userId) { await call('DELETE', `?user_id=eq.${enc(userId)}`); }
  };
}

// ---------------------------------------------------------------- Fichye JSON (devlopman, san Supabase)
function fileSupport(file) {
  let rows = null, seq = 0;
  const load = () => { if (rows) return; try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { rows = []; } seq = rows.reduce((m, r) => Math.max(m, r.id), 0); };
  const save = () => { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(rows)); fs.renameSync(t, file); };
  const pub = (r) => ({ id: r.id, sender: r.sender, body: r.body, created_at: r.created_at, staff_read: r.staff_read });
  return {
    name: 'file',
    async add({ userId, sender, staffId, body }) { load(); const r = { id: ++seq, user_id: userId, sender, staff_id: staffId || null, body, staff_read: false, created_at: new Date().toISOString() }; rows.push(r); save(); return r; },
    async list(userId, after, limit) { load(); const mine = rows.filter((r) => r.user_id === userId && r.id > after); return (after > 0 ? mine.slice(0, limit) : mine.slice(-limit)).map(pub); },
    async recent(limit) { load(); return rows.slice(-limit).reverse(); },
    async unreadRows() { load(); return rows.filter((r) => r.sender === 'user' && !r.staff_read).map((r) => ({ user_id: r.user_id })); },
    async markRead(userId) { load(); let c = false; for (const r of rows) if (r.user_id === userId && r.sender === 'user' && !r.staff_read) { r.staff_read = true; c = true; } if (c) save(); },
    async removeThread(userId) { load(); rows = rows.filter((r) => r.user_id !== userId); save(); }
  };
}

// ---------------------------------------------------------------- Store
function createSupport(backend) {
  const pubMsg = (m) => ({ id: m.id, sender: m.sender, body: m.body, createdAt: m.created_at });
  return {
    backend,
    // Kliyan: li pwòp fil li SÈLMAN (userId sòti nan sesyon an, pa nan demann lan)
    async listForUser(userId, after = 0) { return (await backend.list(userId, after, 100)).map(pubMsg); },
    async send(userId, body) { return pubMsg(await backend.add({ userId, sender: 'user', body })); },
    // Staff
    async reply(userId, staffId, body) { const m = pubMsg(await backend.add({ userId, sender: 'staff', staffId, body })); await backend.markRead(userId); return m; },
    async listForStaff(userId, after = 0) {
      const rows = await backend.list(userId, after, 200);
      if (rows.some((m) => m.sender === 'user' && !m.staff_read)) await backend.markRead(userId);
      return rows.map(pubMsg);
    },
    async threads() {
      const [recent, unread] = await Promise.all([backend.recent(500), backend.unreadRows()]);
      const un = new Map(); for (const r of unread) un.set(r.user_id, (un.get(r.user_id) || 0) + 1);
      const seen = new Map();
      for (const m of recent) if (!seen.has(m.user_id)) seen.set(m.user_id, { userId: m.user_id, lastBody: String(m.body).slice(0, 120), lastSender: m.sender, lastAt: m.created_at, unread: un.get(m.user_id) || 0 });
      for (const [uid, n] of un) if (!seen.has(uid)) seen.set(uid, { userId: uid, lastBody: '', lastSender: 'user', lastAt: null, unread: n });
      return [...seen.values()];
    },
    async unreadTotal() { return (await backend.unreadRows()).length; },
    async removeThread(userId) { await backend.removeThread(userId); }
  };
}

module.exports = { cleanBody, createSupport, supabaseSupport, fileSupport, SupportError, MAX_LEN };
