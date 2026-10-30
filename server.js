const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cookieParser = require('cookie-parser');

const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
// Sou Railway: monte yon Volume (egz. /data) epi mete DATA_DIR=/data
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const KYC_DIR = path.join(DATA_DIR, 'kyc');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const JWT_SECRET = process.env.JWT_SECRET || (isProd ? null : 'dev-secret-change-me');
const ADMIN_KEY = process.env.ADMIN_KEY || '';

if (!JWT_SECRET) {
  console.error('JWT_SECRET manke. Ajoute l nan Variables Railway.');
  process.exit(1);
}
fs.mkdirSync(KYC_DIR, { recursive: true });

// ---------- Stockage itilizatè: Supabase (si Variables yo la), sinon users.json ----------
const { createStore, supabaseBackend, fileBackend, ConflictError } = require('./userstore');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const useSupabase = !!(SUPABASE_URL && SUPABASE_KEY);
if (isProd && !useSupabase) console.warn('ATANSYON: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manke. Itilizatè yo ap sove nan users.json, PA nan Supabase.');
const store = createStore({
  backend: useSupabase ? supabaseBackend({ url: SUPABASE_URL, key: SUPABASE_KEY }) : fileBackend(USERS_FILE),
  pendingFile: useSupabase ? path.join(DATA_DIR, 'users-pending.json') : null,
  legacyFile: USERS_FILE,
  autoMigrate: process.env.MIGRATE_USERS_ON_BOOT === 'true'
});
// ---------- Foto KYC + prèv P2P: Supabase Storage (buckets prive) ----------
const { supabaseStorage, createFiles, sendImage, StorageError } = require('./filestore');
const fileStore = createFiles({
  storage: useSupabase ? supabaseStorage({ url: SUPABASE_URL, key: SUPABASE_KEY }) : null,
  // FILE_STORE=disk = kill-switch: nouvo foto yo tounen sou disk la (foto ki deja nan Supabase yo rete li)
  writeToStorage: useSupabase && (process.env.FILE_STORE || '').trim().toLowerCase() !== 'disk',
  kycBucket: (process.env.SUPABASE_KYC_BUCKET || 'kyc-documents').trim(),
  p2pBucket: (process.env.SUPABASE_P2P_BUCKET || 'p2p-evidence').trim(),
  kycDir: KYC_DIR,
  p2pDir: path.join(DATA_DIR, 'p2p-evidence')
});
if (isProd && !fileStore.canWrite) console.warn('ATANSYON: nouvo foto KYC/P2P ap sove sou disk lokal (Supabase Storage pa aktif).');
// ---------- Chat support (live chat, sèlman tèks) ----------
const { cleanBody, createSupport, supabaseSupport, fileSupport, SupportError } = require('./supportstore');
const support = createSupport(useSupabase
  ? supabaseSupport({ url: SUPABASE_URL, key: SUPABASE_KEY })
  : fileSupport(path.join(DATA_DIR, 'support-messages.json')));
const loadUsers = store.loadUsers;
const saveUsers = store.saveUsers; // asynchrone: toujou "await saveUsers(...)"
const round2 = (n) => Math.round(n * 100) / 100;
// Balans prensipal = HTG (goud). usd = balans dola (USD/USDT) apre kliyan an fè yon swap.
// To chanj + frè swap: admin kontwole yo (settings.json). Default: 1 USDT = 140 HTG, frè dezaktive.
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
// Aktif ki ka gen pwòp pousantaj frè swap (metòd dola yo)
const W_ASSETS = ['Meru', 'Zelle', 'USDT', 'CashApp', 'PayPal', 'Wise'];
// Frè swap pou yon aktif: pousantaj pa aktif la, sinon pousantaj jeneral la. 0 si frè yo dezaktive.
function feeFor(st, asset) {
  if (!st.feeActive) return 0;
  return asset && st.feeByAsset[asset] !== undefined ? st.feeByAsset[asset] : st.feePercent;
}
function getSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  return {
    rate: Number(s.rate) > 0 ? Number(s.rate) : 140,
    feeActive: !!s.feeActive,
    feePercent: Number(s.feePercent) >= 0 ? Number(s.feePercent) : 0,
    feeByAsset: Object.fromEntries(Object.entries(s.feeByAsset && typeof s.feeByAsset === 'object' ? s.feeByAsset : {}).filter(([k, v]) => W_ASSETS.includes(k) && v !== null && v !== '' && Number(v) >= 0 && Number(v) <= 50).map(([k, v]) => [k, Number(v)])),
    deposit: s.deposit && typeof s.deposit === 'object' ? s.deposit : {}
  };
}
function saveSettings(st) {
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
}
// Retrè: balans HTG => sèlman MonCash / NatCash. Balans dola (USD/USDT) => Meru, Zelle, USDT, CashApp, PayPal, Wise.
// Dola pa ka ale sou MonCash/NatCash dirèkteman: swap an HTG dabò.
const W_METHODS = { HTG: ['MonCash', 'NatCash'], USD: ['Meru', 'Zelle', 'USDT', 'CashApp', 'PayPal', 'Wise'] };
const USDT_NETWORKS = { TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, BEP20: /^0x[a-fA-F0-9]{40}$/ };
// USDT: Binance (ID oswa imèl) oswa wallet crypto (rezo TRC20/BEP20). Retounen { account, extra } oswa { error }
function usdtDestination(b) {
  const dest = String(b.dest || '');
  const val = String(b.account || '').trim();
  if (dest === 'binance') {
    const idType = String(b.idType || '');
    if (idType === 'id') return /^\d{5,20}$/.test(val) ? { account: val, extra: { dest, idType } } : { error: 'Binance ID pa valid (chif sèlman).' };
    if (idType === 'email') return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(val) && val.length <= 100 ? { account: val, extra: { dest, idType } } : { error: 'Imèl Binance pa valid.' };
    return { error: 'Chwazi si se Binance ID oswa imèl Binance.' };
  }
  if (dest === 'wallet') {
    const network = String(b.network || '');
    if (!USDT_NETWORKS[network]) return { error: 'Chwazi rezo a: TRC20 oswa BEP20.' };
    return USDT_NETWORKS[network].test(val) ? { account: val, extra: { dest, network } } : { error: 'Adrès wallet la pa valid pou rezo ' + network + '.' };
  }
  return { error: 'Chwazi Binance oswa wallet crypto.' };
}
// Checkbox obligatwa (depo + retrè): kliyan an dakò validasyon pran 24-48 èdtan
const ackOk = (req) => req.body && req.body.ack === true;
const ACK_ERR = 'Ou dwe make kazye a pou konfime depo/retrè a ka pran 24 a 48 èdtan pou valide.';
const txOf = (s) => ({ type: 'withdrawal', currency: 'HTG', ...s });
// ---------- Notifikasyon (klòch la) ----------
// Sove nan done kliyan an (u.notifs, max 50). Chak notifikasyon = yon kle (k) + paramèt (p); dashboard la tradui l nan lang kliyan an.
function notify(u, k, p) {
  if (!u) return;
  u.notifs = u.notifs || [];
  u.notifs.push({ id: crypto.randomUUID(), k, p: p || {}, at: new Date().toISOString(), read: false });
  if (u.notifs.length > 50) u.notifs = u.notifs.slice(-50);
}
const moneyTxt = (n, cur) => (cur === 'USD' ? '$' + Number(n).toFixed(2) : Number(n).toFixed(2) + ' HTG');
const publicUser = (u) => ({
  notifs: (u.notifs || []).slice(-30).reverse(), unread: (u.notifs || []).filter((n) => !n.read).length,
  id: u.id, name: u.name, email: u.email, role: u.role || 'user',
  balance: u.balance || 0, usd: u.usd || 0, rate: getSettings().rate,
  fee: { active: getSettings().feeActive, percent: getSettings().feePercent, byAsset: getSettings().feeByAsset }, banned: !!u.banned,
  uid: u.uid || null, lang: u.lang || 'ht', profile: u.profile || null, pinActive: !!u.pinActive,
  kyc: { status: u.kyc.status, idType: u.kyc.idType || null, reason: u.kyc.reason || null },
  txs: (u.swaps || []).slice(-30).map(txOf).reverse()
});

// Kont admin kreye soti nan Variables (pa janm ekri nan kòd la)
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// ID 7 chif inik pou chak itilizatè
const genUid = (users) => {
  let id;
  do { id = String(crypto.randomInt(1000000, 10000000)); } while (users.some((u) => u.uid === id));
  return id;
};
// Kreye kont admin / tès + ID 7 chif, apre itilizatè yo chaje nan Supabase
async function seedAccounts() {
if (ADMIN_EMAIL && ADMIN_PASSWORD.length >= 10) {
  const users = loadUsers();
  let a = users.find((u) => u.email === ADMIN_EMAIL);
  if (!a) {
    a = { id: crypto.randomUUID(), name: 'Admin', email: ADMIN_EMAIL, createdAt: new Date().toISOString(), balance: 0, swaps: [], kyc: { status: 'approved' } };
    users.push(a);
  }
  a.role = 'admin';
  if (!a.passwordHash || !bcrypt.compareSync(ADMIN_PASSWORD, a.passwordHash)) a.passwordHash = bcrypt.hashSync(ADMIN_PASSWORD, 12);
  await saveUsers(users);
} else {
  console.warn('Pa gen kont admin: mete ADMIN_EMAIL ak ADMIN_PASSWORD (omwen 10 karaktè) nan Variables.');
}

// Kont itilizatè tès (opsyonèl) soti nan Variables
const TEST_EMAIL = (process.env.TEST_USER_EMAIL || '').trim().toLowerCase();
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD || '';
if (TEST_EMAIL && TEST_PASSWORD.length >= 10 && TEST_EMAIL !== ADMIN_EMAIL) {
  const users = loadUsers();
  let t = users.find((u) => u.email === TEST_EMAIL);
  if (!t) {
    t = { id: crypto.randomUUID(), name: 'Test User', email: TEST_EMAIL, createdAt: new Date().toISOString(), role: 'user', balance: 0, swaps: [], kyc: { status: 'none' } };
    users.push(t);
  }
  if (!t.passwordHash || !bcrypt.compareSync(TEST_PASSWORD, t.passwordHash)) t.passwordHash = bcrypt.hashSync(TEST_PASSWORD, 12);
  await saveUsers(users);
}

{
  const us = loadUsers();
  let changed = false;
  for (const u of us) if (!u.uid) { u.uid = genUid(us); changed = true; }
  if (changed) await saveUsers(us);
}
}
const ready = (async () => { await store.init(); await seedAccounts(); })();

// ---------- App ----------
const app = express();
// Express 4 pa trape erè handler asynchrone: nou voye yo bay middleware erè a
for (const m of ['get', 'post', 'put', 'delete']) {
  const orig = app[m].bind(app);
  app[m] = (p, ...hs) => hs.length === 0 ? orig(p) : orig(p, ...hs.map((fn) => (typeof fn !== 'function' || fn.length > 3) ? fn : (req, res, next) => {
    try { const r = fn(req, res, next); if (r && typeof r.catch === 'function') r.catch(next); } catch (e) { next(e); }
  }));
}
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb', verify: (req, res, buf) => { req.rawBody = buf; } })); // rawBody: pou siyati webhook
app.use(cookieParser());
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin'
  });
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

// Limit senp pou login/signup (anti brute-force)
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Twòp tantativ. Tanpri tann kèk minit.' });
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}
setInterval(() => hits.clear(), 60 * 60 * 1000).unref();

// ---------- Jounal aktivite (pou panel admin: 360° itilizatè) ----------
const uaInfo = (ua = '') => {
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac OS X/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : '?';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '?';
  return br + ' · ' + os;
};
// Ajoute yon evènman sou objè itilizatè a (max 200). req = aksyon kliyan an (IP + aparèy); san req = aksyon admin (extra.by).
function logAct(u, type, detail, req, extra) {
  if (!u) return;
  u.activity = u.activity || [];
  const e = { at: new Date().toISOString(), type, detail: String(detail || '').slice(0, 200), ...extra };
  if (req) { e.ip = String(req.ip || '').slice(0, 64); e.device = uaInfo(req.get('user-agent') || ''); }
  u.activity.push(e);
  if (u.activity.length > 200) u.activity = u.activity.slice(-200);
}
// Pou evènman ki pa sove otomatikman (koneksyon, dekoneksyon). Pa janm bloke repons lan si sove a echwe.
async function recordAct(userId, type, detail, req, extra) {
  try {
    const users = loadUsers();
    const u = users.find((x) => x.id === userId);
    if (!u) return;
    logAct(u, type, detail, req, extra);
    await saveUsers(users);
  } catch (e) { console.error('[activity]', e.message); }
}

function setSession(res, user, remember) {
  const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: remember ? '30d' : '1d' });
  res.cookie('token', token, {
    httpOnly: true, sameSite: 'lax', secure: isProd,
    maxAge: (remember ? 30 : 1) * 24 * 3600 * 1000
  });
  setPinHint(res, user);
}

// Kouki "aparèy ki rekonèt" (30 jou): li pèmèt fòm PIN nan parèt sèlman si kliyan an gen PIN aktif
// epi sesyon aparèy la poko ekspire. Li pa konekte pesonn pou kont li: PIN lan toujou obligatwa.
function setPinHint(res, user) {
  if (!user.pinActive) return res.clearCookie('pinhint');
  const t = jwt.sign({ sub: user.id, k: 'pinhint' }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('pinhint', t, { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 30 * 24 * 3600 * 1000 });
}
function pinHintUser(req) {
  try {
    const p = jwt.verify(req.cookies.pinhint, JWT_SECRET);
    if (p.k !== 'pinhint') return null;
    const u = loadUsers().find((x) => x.id === p.sub);
    return u && u.pinActive && u.pinHash ? u : null;
  } catch { return null; }
}
const maskEmail = (e) => { const [a, b] = String(e).split('@'); return (a.length <= 2 ? a[0] : a.slice(0, 2)) + '•••@' + b; };

function auth(req, res, next) {
  try {
    const { sub } = jwt.verify(req.cookies.token, JWT_SECRET);
    const users = loadUsers();
    const user = users.find((u) => u.id === sub);
    if (!user) throw new Error('no user');
    req.users = users;
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Ou pa konekte.' });
  }
}

// Kont ki bani: sèlman depo. Tout lòt aksyon bloke.
function notBanned(req, res, next) {
  if (req.user.banned) return res.status(403).json({ error: 'Kont ou bani. Ou ka fè depo sèlman.' });
  next();
}

// PIN 6 chif: blokaj 30 min apre 5 move tantativ
const pinFails = new Map();
const pinLocked = (u) => { const f = pinFails.get(u.id); return !!(f && f.until > Date.now()); };
async function checkPin(u, pin) {
  if (!u.pinHash || pinLocked(u) || !/^\d{6}$/.test(String(pin))) return false;
  const ok = await bcrypt.compare(String(pin), u.pinHash);
  if (ok) pinFails.delete(u.id);
  else {
    const f = pinFails.get(u.id) || { n: 0 };
    f.n += 1;
    if (f.n >= 5) { f.until = Date.now() + 30 * 60 * 1000; f.n = 0; }
    pinFails.set(u.id, f);
  }
  return ok;
}
// Si PIN aktif, chak retrè mande PIN lan
async function pinGuard(req, res, next) {
  if (!req.user.pinActive) return next();
  if (pinLocked(req.user)) return res.status(429).json({ error: 'PIN bloke pou 30 minit.' });
  if (!(await checkPin(req.user, req.body.pin))) return res.status(403).json({ error: 'PIN pa kòrèk.' });
  req.users = loadUsers(); // re-li apre await pou pa pèdi chanjman lòt moun
  req.user = req.users.find((x) => x.id === req.user.id);
  next();
}
function needProfile(req, res, next) {
  if (!req.user.profile) return res.status(403).json({ error: 'Konplete enfòmasyon pèsonèl ou nan Paramèt anvan.' });
  next();
}

// ---------- Auth ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/signup', rateLimit(10, 15 * 60 * 1000), async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'Non an pa valid.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Imèl la pa valid.' });
  if (password.length < 8 || password.length > 100) return res.status(400).json({ error: 'Mòdpas la dwe gen omwen 8 karaktè.' });

  const passwordHash = await bcrypt.hash(password, 12);
  const users = loadUsers();
  if (users.some((u) => u.email === email)) return res.status(409).json({ error: 'Imèl sa a deja itilize.' });
  const refUser = users.find((x) => x.uid === String(req.body.ref || ''));

  const user = {
    id: crypto.randomUUID(), uid: genUid(users), name, email, passwordHash,
    referredBy: refUser ? refUser.uid : null,
    createdAt: new Date().toISOString(),
    role: 'user', balance: 0, swaps: [],
    kyc: { status: 'none' }
  };
  logAct(user, 'signup', 'Kont kreye', req);
  users.push(user);
  try { await saveUsers(users); } catch (e) {
    if (e instanceof ConflictError) return res.status(409).json({ error: 'Imèl sa a deja itilize.' });
    throw e;
  }
  setSession(res, user, false);
  res.status(201).json(publicUser(user));
});

app.post('/api/login', rateLimit(10, 15 * 60 * 1000), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = loadUsers().find((u) => u.email === email);
  const ok = !!user && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) {
    if (user) await recordAct(user.id, 'login_fail', 'Eseye konekte: mòdpas pa kòrèk', req);
    return res.status(401).json({ error: 'Imèl oswa mòdpas la pa kòrèk.' });
  }
  await recordAct(user.id, 'login', 'Koneksyon ak mòdpas' + (req.body.remember ? ' (sonje aparèy)' : ''), req);
  setSession(res, user, !!req.body.remember);
  res.json(publicUser(user));
});

// Fòm PIN: disponib sèlman si aparèy la gen yon kouki pinhint valid (PIN aktif + 30 jou poko pase)
app.get('/api/pin-hint', (req, res) => {
  const u = pinHintUser(req);
  res.json(u ? { available: true, email: maskEmail(u.email), name: String(u.name).split(' ')[0] } : { available: false });
});

app.post('/api/login-pin', rateLimit(10, 15 * 60 * 1000), async (req, res) => {
  const user = pinHintUser(req);
  if (!user) return res.status(401).json({ error: 'Sesyon PIN lan ekspire. Itilize imèl ak mòdpas ou.' });
  if (pinLocked(user)) return res.status(429).json({ error: 'PIN bloke pou 30 minit. Itilize mòdpas ou.' });
  if (!(await checkPin(user, req.body.pin))) {
    await recordAct(user.id, 'login_fail', 'Eseye konekte: PIN pa kòrèk', req);
    return res.status(401).json({ error: 'PIN pa kòrèk.' });
  }
  await recordAct(user.id, 'login_pin', 'Koneksyon ak PIN', req);
  setSession(res, user, !!req.body.remember);
  res.json(publicUser(user));
});

app.post('/api/logout', async (req, res) => {
  try { const { sub } = jwt.verify(req.cookies.token, JWT_SECRET); await recordAct(sub, 'logout', 'Dekonekte', req); } catch { /* pa konekte */ }
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user)));

// ---------- KYC ----------
// national_id => devan + dèyè + selfie | driver_license / passport => devan + selfie
const ID_TYPES = {
  national_id: ['front', 'back', 'selfie'],
  driver_license: ['front', 'selfie'],
  passport: ['front', 'selfie']
};

function detectExt(b) {
  if (b.length > 12) {
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
    if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'webp';
  }
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 3 }
}).fields([
  { name: 'front', maxCount: 1 },
  { name: 'back', maxCount: 1 },
  { name: 'selfie', maxCount: 1 }
]);

app.post('/api/kyc', auth, notBanned, async (req, res, next) => {
  upload(req, res, async (err) => {
   try {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Chak foto dwe mwens pase 5 MB.' : 'Pwoblèm ak fichye yo.';
      return res.status(400).json({ error: msg });
    }
    const users = loadUsers(); // re-li apre multer (li asynchrone) pou pa pèdi chanjman lòt moun
    const user = users.find((x) => x.id === req.user.id);
    if (!user) return res.status(401).json({ error: 'Ou pa konekte.' });
    if (!['none', 'reupload'].includes(user.kyc.status)) {
      return res.status(409).json({ error: 'KYC ou a deja soumèt.' });
    }
    const idType = String(req.body.idType || '');
    const needed = ID_TYPES[idType];
    if (!needed) return res.status(400).json({ error: 'Tip dokiman an pa valid.' });

    const saved = {};
    for (const slot of needed) {
      const f = req.files && req.files[slot] && req.files[slot][0];
      if (!f) return res.status(400).json({ error: 'Tout foto ki obligatwa yo dwe ajoute.' });
      const ext = detectExt(f.buffer);
      if (!ext) return res.status(400).json({ error: 'Sèlman foto JPG, PNG oswa WEBP aksepte.' });
      saved[slot] = { ext, buffer: f.buffer };
    }

    const previous = user.kyc; // pou nou ka efase ansyen foto yo apre nouvo a fin sove
    const stored = await fileStore.saveKyc(user.id, saved);
    user.kyc = { status: 'pending', idType, files: stored.files, ...(stored.store ? { store: stored.store } : {}), submittedAt: new Date().toISOString() };
    logAct(user, 'kyc_submit', 'KYC soumèt (' + idType + ')', req);
    try { await saveUsers(users); } catch (e) { await stored.undo(); throw e; }
    // efase ansyen foto yo. Dosye disk la efase sèlman si nouvo foto yo nan Supabase (sinon se li menm ki gen nouvo yo).
    await fileStore.removeKyc(user.id, previous, { disk: !!stored.store });
    res.json(publicUser(user));
   } catch (e) { next(e); }
  });
});

// ---------- Pwofil, lang, PIN, envitasyon ----------
app.post('/api/profile', auth, async (req, res) => {
  const u = req.user;
  if (u.profile) return res.status(409).json({ error: 'Enfòmasyon sa yo pa ka chanje ankò.' });
  const clean = (v, min, max) => { const s = String(v || '').trim().replace(/\s+/g, ' '); return s.length >= min && s.length <= max ? s : null; };
  const firstName = clean(req.body.firstName, 2, 50), lastName = clean(req.body.lastName, 2, 50);
  const country = clean(req.body.country, 2, 60), address = clean(req.body.address, 5, 200);
  const phone = String(req.body.phone || '').trim();
  const dob = String(req.body.dob || '');
  if (!firstName || !lastName || !country || !address || !/^\+?[0-9 ()-]{6,20}$/.test(phone) || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    return res.status(400).json({ error: 'Tout chan yo obligatwa epi dwe kòrèk.' });
  }
  const d = new Date(dob + 'T00:00:00Z'), now = new Date();
  if (isNaN(d) || d.toISOString().slice(0, 10) !== dob || d.getUTCFullYear() < 1900) return res.status(400).json({ error: 'Dat nesans lan pa valid.' });
  const eighteen = new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()));
  if (d > eighteen) return res.status(400).json({ error: 'Ou dwe gen omwen 18 an.' });
  u.profile = { firstName, lastName, dob, country, phone, address, savedAt: new Date().toISOString() };
  logAct(u, 'profile', 'Enfòmasyon pèsonèl konplete', req);
  await saveUsers(req.users);
  res.json(publicUser(u));
});

app.post('/api/notifications/read', auth, async (req, res) => {
  let changed = false;
  for (const n of req.user.notifs || []) if (!n.read) { n.read = true; changed = true; }
  if (changed) await saveUsers(req.users);
  res.json({ ok: true });
});

app.post('/api/lang', auth, async (req, res) => {
  if (!['ht', 'fr', 'en', 'es'].includes(req.body.lang)) return res.status(400).json({ error: 'Lang pa valid.' });
  req.user.lang = req.body.lang;
  await saveUsers(req.users);
  res.json({ lang: req.user.lang });
});

const WEAK_PINS = new Set(['000000', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888', '999999', '123456', '654321', '123123', '121212']);

app.post('/api/pin/set', auth, async (req, res) => {
  const pin = String(req.body.pin || '');
  if (!/^\d{6}$/.test(pin)) return res.status(400).json({ error: 'PIN a dwe gen 6 chif.' });
  if (WEAK_PINS.has(pin)) return res.status(400).json({ error: 'PIN twò senp. Chwazi yon lòt.' });
  if (!(await bcrypt.compare(String(req.body.password || ''), req.user.passwordHash))) return res.status(403).json({ error: 'Mòdpas la pa kòrèk.' });
  const pinHash = await bcrypt.hash(pin, 12);
  const users = loadUsers();
  const u = users.find((x) => x.id === req.user.id);
  u.pinHash = pinHash; u.pinActive = true;
  logAct(u, 'pin_set', 'PIN 6 chif aktive', req);
  await saveUsers(users);
  setPinHint(res, u);
  res.json(publicUser(u));
});

app.post('/api/pin/disable', auth, async (req, res) => {
  if (!(await bcrypt.compare(String(req.body.password || ''), req.user.passwordHash))) return res.status(403).json({ error: 'Mòdpas la pa kòrèk.' });
  const users = loadUsers();
  const u = users.find((x) => x.id === req.user.id);
  u.pinActive = false; delete u.pinHash;
  logAct(u, 'pin_disable', 'PIN 6 chif dezaktive', req);
  await saveUsers(users);
  res.clearCookie('pinhint');
  res.json(publicUser(u));
});

app.get('/api/invites', auth, (req, res) =>
  res.json({ uid: req.user.uid, count: req.users.filter((x) => x.referredBy === req.user.uid).length })
);

// ---------- Depo ----------
// MonCash/NatCash => HTG | PayPal, Zelle, Meru, CashApp, Wise, USDT => dola. Admin mete direksyon (kont/adrès) kote kliyan yo voye lajan an.
// USDT: admin mete (1) Binance ID ak/oswa imèl Binance, (2) yon adrès pa rezo (TRC20 / BEP20). Kliyan an chwazi Binance (ID oswa imèl) oswa wallet (rezo).
// Binance => Transaction ID obligatwa | Wallet => TXID obligatwa.
const BINANCE_TX = /^[A-Za-z0-9]{6,100}$/;
const TXID = { TRC20: /^[a-fA-F0-9]{64}$/, BEP20: /^(0x)?[a-fA-F0-9]{64}$/ };
const depBinance = (d) => Object.fromEntries(['id', 'email'].filter((k) => d && d.binance && typeof d.binance[k] === 'string' && d.binance[k]).map((k) => [k, d.binance[k]]));
const depNetworks = (d) => Object.fromEntries(Object.keys(USDT_NETWORKS).filter((n) => d && d.networks && typeof d.networks[n] === 'string' && d.networks[n]).map((n) => [n, d.networks[n]]));
const D_METHODS = { MonCash: 'HTG', NatCash: 'HTG', PayPal: 'USD', Zelle: 'USD', Meru: 'USD', CashApp: 'USD', Wise: 'USD', USDT: 'USD' };

app.get('/api/deposit-info', auth, async (req, res) => {
  const dep = getSettings().deposit;
  res.json(Object.keys(D_METHODS).filter((m) => dep[m] && dep[m].active && dep[m].account)
    .map((m) => m === 'USDT'
      ? { method: m, currency: 'USD', account: '', name: '', note: dep[m].note || '', binance: depBinance(dep[m]), networks: depNetworks(dep[m]) }
      : { method: m, currency: D_METHODS[m], account: dep[m].account, name: dep[m].name || '', note: dep[m].note || '' }));
});

// Kliyan an di li voye lajan an; admin verifye epi kredite. (Kont bani ka fè depo tou.)
app.post('/api/deposit', auth, async (req, res) => {
  const u = req.user;
  const method = String(req.body.method || '');
  if (!Object.prototype.hasOwnProperty.call(D_METHODS, method)) return res.status(400).json({ error: 'Metòd la pa valid.' });
  const info = getSettings().deposit[method];
  if (!info || !info.active || !info.account) return res.status(400).json({ error: 'Metòd sa a pa disponib kounye a.' });
  const amount = round2(Number(req.body.amount));
  if (!(amount > 0) || amount > 10000000) return res.status(400).json({ error: 'Montan an pa valid.' });
  const reference = String(req.body.reference || '').trim();
  if (reference.length < 3 || reference.length > 100) return res.status(400).json({ error: 'Antre referans tranzaksyon an.' });
  if (!ackOk(req)) return res.status(400).json({ error: ACK_ERR });
  let network = null, dest = null, idType = null;
  if (method === 'USDT') {
    dest = String(req.body.dest || '');
    if (dest === 'binance') {
      idType = String(req.body.idType || '');
      if (!depBinance(info)[idType]) return res.status(400).json({ error: 'Chwazi Binance ID oswa imèl Binance.' });
      if (!BINANCE_TX.test(reference)) return res.status(400).json({ error: 'Antre Transaction ID Binance lan (6 a 100 lèt/chif).' });
    } else if (dest === 'wallet') {
      network = String(req.body.network || '');
      if (!depNetworks(info)[network]) return res.status(400).json({ error: 'Chwazi rezo a: TRC20 oswa BEP20.' });
      if (!TXID[network].test(reference)) return res.status(400).json({ error: 'TXID la pa valid pou ' + network + ' (64 karaktè hex' + (network === 'BEP20' ? ', ak oswa san 0x' : '') + ').' });
    } else return res.status(400).json({ error: 'Chwazi Binance oswa wallet.' });
  }
  if ((u.swaps || []).filter((t) => t.type === 'deposit' && t.status === 'pending').length >= 5) {
    return res.status(429).json({ error: 'Ou gen twòp depo an kou. Tann yo trete.' });
  }
  const dup = req.users.some((x) => (x.swaps || []).some((t) => t.type === 'deposit' && t.method === method && t.status !== 'rejected' && String(t.reference).toLowerCase() === reference.toLowerCase()));
  if (dup) return res.status(409).json({ error: 'Referans sa a deja itilize.' });
  u.swaps = u.swaps || [];
  const depId = crypto.randomUUID();
  logAct(u, 'deposit', 'Demann depo ' + method + ' · ' + moneyTxt(amount, D_METHODS[method]), req, { ref: depId });
  u.swaps.push({ id: depId, type: 'deposit', currency: D_METHODS[method], method, ...(dest ? { dest } : {}), ...(idType ? { idType } : {}), ...(network ? { network } : {}), amount, reference, status: 'pending', ackAt: new Date().toISOString(), createdAt: new Date().toISOString() });
  notify(u, 'nDepPending', { a: moneyTxt(amount, D_METHODS[method]), m: method });
  await saveUsers(req.users);
  res.status(201).json(publicUser(u));
});

// ---------- Swap (HTG -> USD/USDT) ----------
app.post('/api/swap', auth, notBanned, needProfile, async (req, res) => {
  const u = req.user;
  if (u.kyc.status !== 'approved') return res.status(403).json({ error: 'KYC ou dwe apwouve anvan ou fè yon swap.' });
  const st = getSettings();
  const asset = W_ASSETS.includes(String(req.body.asset || '')) ? String(req.body.asset) : null;
  const pct = feeFor(st, asset);
  // Si admin lan chanje to a oswa frè a pandan kliyan an te sou paj la, pa fè swap la ak ansyen valè yo
  if (Number(req.body.rate) !== st.rate || Number(req.body.feePercent) !== pct) {
    return res.status(409).json({ error: 'To oswa frè a fèk chanje. Verifye nouvo valè yo epi eseye ankò.', user: publicUser(u) });
  }
  const amount = round2(Number(req.body.amount));
  if (!(amount > 0)) return res.status(400).json({ error: 'Montan an pa valid.' });
  if (amount > (u.balance || 0)) return res.status(400).json({ error: 'Balans HTG ou pa sifi.' });
  const fee = round2((amount * pct) / 100);
  const net = round2(amount - fee);
  const usd = Math.floor((net / st.rate) * 100) / 100;
  if (usd <= 0) return res.status(400).json({ error: 'Montan an twò piti pou yon swap.' });
  u.balance = round2(u.balance - amount);
  u.usd = round2((u.usd || 0) + usd);
  u.swaps = u.swaps || [];
  const swId = crypto.randomUUID();
  logAct(u, 'swap', 'Swap ' + amount.toFixed(2) + ' HTG → $' + usd.toFixed(2) + (asset ? ' (' + asset + ')' : ''), req, { ref: swId });
  u.swaps.push({ id: swId, type: 'swap', currency: 'HTG', amount, fee, feePercent: pct, asset, usd, rate: st.rate, status: 'done', createdAt: new Date().toISOString() });
  notify(u, 'nSwapUsd', { a: amount.toFixed(2) + ' HTG', b: '$' + usd.toFixed(2) });
  await saveUsers(req.users);
  res.status(201).json(publicUser(u));
});

// ---------- Swap (dola USD/USDT/fiat -> HTG) ----------
app.post('/api/swap/to-htg', auth, notBanned, needProfile, async (req, res) => {
  const u = req.user;
  if (u.kyc.status !== 'approved') return res.status(403).json({ error: 'KYC ou dwe apwouve anvan ou fè yon swap.' });
  const st = getSettings();
  const asset = W_ASSETS.includes(String(req.body.asset || '')) ? String(req.body.asset) : null;
  const pct = feeFor(st, asset);
  if (Number(req.body.rate) !== st.rate || Number(req.body.feePercent) !== pct) {
    return res.status(409).json({ error: 'To oswa frè a fèk chanje. Verifye nouvo valè yo epi eseye ankò.', user: publicUser(u) });
  }
  const usd = round2(Number(req.body.amount));
  if (!(usd > 0)) return res.status(400).json({ error: 'Montan an pa valid.' });
  if (usd > (u.usd || 0)) return res.status(400).json({ error: 'Balans dola ou pa sifi.' });
  const feeUsd = round2((usd * pct) / 100);
  const htg = Math.floor((usd - feeUsd) * st.rate * 100) / 100;
  if (htg <= 0) return res.status(400).json({ error: 'Montan an twò piti pou yon swap.' });
  u.usd = round2(u.usd - usd);
  u.balance = round2((u.balance || 0) + htg);
  u.swaps = u.swaps || [];
  const swId = crypto.randomUUID();
  logAct(u, 'swap', 'Swap $' + usd.toFixed(2) + ' → ' + htg.toFixed(2) + ' HTG' + (asset ? ' (' + asset + ')' : ''), req, { ref: swId });
  u.swaps.push({ id: swId, type: 'swap', dir: 'to_htg', currency: 'USD', amount: usd, fee: feeUsd, feePercent: pct, asset, htg, rate: st.rate, status: 'done', createdAt: new Date().toISOString() });
  notify(u, 'nSwapHtg', { a: '$' + usd.toFixed(2), b: htg.toFixed(2) + ' HTG' });
  await saveUsers(req.users);
  res.status(201).json(publicUser(u));
});

// ---------- Retrè ----------
// HTG => MonCash / NatCash | USD => Meru, Zelle, USDT (Binance/wallet), CashApp, PayPal, Wise
app.post('/api/withdraw', auth, notBanned, needProfile, pinGuard, async (req, res) => {
  const u = req.user;
  if (u.kyc.status !== 'approved') return res.status(403).json({ error: 'KYC ou dwe apwouve anvan ou fè yon retrè.' });
  const currency = String(req.body.currency || '');
  const method = String(req.body.method || '');
  const amount = round2(Number(req.body.amount));
  const account = String(req.body.account || '').trim();
  if (!Object.prototype.hasOwnProperty.call(W_METHODS, currency)) return res.status(400).json({ error: 'Lajan an pa valid.' });
  if (!W_METHODS[currency].includes(method)) {
    return res.status(400).json({ error: currency === 'HTG'
      ? 'Balans HTG ka retire sèlman sou MonCash oswa NatCash. Pou lòt metòd yo, swap an dola dabò.'
      : 'Balans dola pa ka retire sou MonCash/NatCash. Swap li an HTG dabò.' });
  }
  if (!ackOk(req)) return res.status(400).json({ error: ACK_ERR });
  const field = currency === 'HTG' ? 'balance' : 'usd';
  if (!(amount > 0)) return res.status(400).json({ error: 'Montan an pa valid.' });
  if (amount > (u[field] || 0)) return res.status(400).json({ error: 'Balans ou pa sifi.' });
  let destAccount = account, extra = {};
  if (method === 'USDT') {
    const d = usdtDestination(req.body);
    if (d.error) return res.status(400).json({ error: d.error });
    destAccount = d.account; extra = d.extra;
  } else if (account.length < 3 || account.length > 100) return res.status(400).json({ error: 'Antre kont oswa nimewo destinasyon an.' });
  u[field] = round2(u[field] - amount);
  u.swaps = u.swaps || [];
  const wdId = crypto.randomUUID();
  logAct(u, 'withdrawal', 'Demann retrè ' + method + ' · ' + moneyTxt(amount, currency), req, { ref: wdId });
  u.swaps.push({ id: wdId, type: 'withdrawal', currency, method, amount, account: destAccount, ...extra, status: 'pending', ackAt: new Date().toISOString(), createdAt: new Date().toISOString() });
  notify(u, 'nWdPending', { a: moneyTxt(amount, currency), m: method });
  await saveUsers(req.users);
  res.status(201).json(publicUser(u));
});

// ---------- Admin (sesyon + wòl admin) ----------
function adminOnly(req, res, next) {
  auth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Pa otorize.' });
    next();
  });
}

app.get('/api/admin/users', adminOnly, (req, res) =>
  res.json(req.users.map((u) => ({
    id: u.id, uid: u.uid, name: u.name, email: u.email, role: u.role || 'user',
    phone: u.profile ? u.profile.phone : null, country: u.profile ? u.profile.country : null,
    balance: u.balance || 0, usd: u.usd || 0, banned: !!u.banned, kycStatus: u.kyc.status, createdAt: u.createdAt
  })))
);


// 360° itilizatè: pwofil, koneksyon, ak tout aktivite (jounal + istorik tranzaksyon). Admin sèlman.
app.get('/api/admin/users/:id/activity', adminOnly, (req, res) => {
  const u = req.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Pa jwenn.' });
  const log = (u.activity || []).map((e) => ({ at: e.at, type: e.type, detail: e.detail, ip: e.ip || null, device: e.device || null, by: e.by || null }));
  const logged = new Set((u.activity || []).map((e) => e.ref).filter(Boolean));
  const has = (t) => log.some((e) => e.type === t);
  const ev = [...log];
  // Istorik ki egziste deja anvan jounal la (kont ansyen): nou rekonstwi l ak done ki deja la
  if (!has('signup') && u.createdAt) ev.push({ at: u.createdAt, type: 'signup', detail: 'Kont kreye' });
  if (!has('profile') && u.profile && u.profile.savedAt) ev.push({ at: u.profile.savedAt, type: 'profile', detail: 'Enfòmasyon pèsonèl konplete' });
  if (!has('kyc_submit') && u.kyc && u.kyc.submittedAt) ev.push({ at: u.kyc.submittedAt, type: 'kyc_submit', detail: 'KYC soumèt' });
  for (const t of u.swaps || []) {
    if (logged.has(t.id) || !t.createdAt) continue;
    const m = t.currency === 'USD' ? '$' + Number(t.amount).toFixed(2) : Number(t.amount).toFixed(2) + ' HTG';
    const d = t.type === 'deposit' ? 'Depo ' + t.method + ' · ' + m + ' (' + t.status + ')'
      : t.type === 'withdrawal' ? 'Retrè ' + t.method + ' · ' + m + ' (' + t.status + ')'
      : t.type === 'adjustment' ? 'Admin ' + (t.amount > 0 ? 'ajoute ' : 'retire ') + m.replace('-', '')
      : 'Swap ' + m;
    ev.push({ at: t.createdAt, type: t.type === 'adjustment' ? 'adjustment' : t.type, detail: d });
  }
  ev.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const logins = ev.filter((e) => ['login', 'login_pin', 'login_fail', 'logout'].includes(e.type));
  const ok = logins.filter((e) => e.type === 'login' || e.type === 'login_pin');
  const done = (type, cur) => (u.swaps || []).filter((t) => t.type === type && t.status === 'done' && t.currency === cur).reduce((a, t) => a + (Number(t.amount) || 0), 0);
  res.json({
    user: {
      id: u.id, uid: u.uid, name: u.name, email: u.email, role: u.role || 'user', banned: !!u.banned,
      createdAt: u.createdAt, kycStatus: u.kyc ? u.kyc.status : 'none', pinActive: !!u.pinActive,
      phone: u.profile ? u.profile.phone : null, country: u.profile ? u.profile.country : null,
      balance: u.balance || 0, usd: u.usd || 0
    },
    stats: {
      lastLogin: ok[0] || null, loginCount: ok.length, failCount: logins.filter((e) => e.type === 'login_fail').length,
      devices: [...new Set(ok.map((e) => e.device).filter(Boolean))].length, ips: [...new Set(ok.map((e) => e.ip).filter(Boolean))].length,
      depositedHTG: done('deposit', 'HTG'), depositedUSD: done('deposit', 'USD'), withdrawnHTG: done('withdrawal', 'HTG'), withdrawnUSD: done('withdrawal', 'USD'),
      swaps: (u.swaps || []).filter((t) => t.type === 'swap').length, pending: (u.swaps || []).filter((t) => t.status === 'pending').length
    },
    logins: logins.slice(0, 100), events: ev.slice(0, 400), logStart: (u.activity || [])[0] ? u.activity[0].at : null
  });
});

// Ajoute / retire lajan sou kont yon kliyan (HTG oswa USD). Kliyan an wè l nan istwa li.
app.post('/api/admin/users/:id/balance', adminOnly, async (req, res) => {
  const u = req.users.find((x) => x.id === req.params.id);
  const delta = round2(Number(req.body.delta));
  const currency = req.body.currency === 'USD' ? 'USD' : 'HTG';
  const field = currency === 'USD' ? 'usd' : 'balance';
  if (!u || !Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: 'Done pa valid.' });
  if (round2((u[field] || 0) + delta) < 0) return res.status(400).json({ error: 'Balans pa ka negatif.' });
  u[field] = round2((u[field] || 0) + delta);
  u.swaps = u.swaps || [];
  const adjId = crypto.randomUUID();
  logAct(u, 'adjustment', 'Admin ' + (delta > 0 ? 'ajoute ' : 'retire ') + moneyTxt(Math.abs(delta), currency), null, { ref: adjId, by: req.user.email });
  u.swaps.push({
    id: adjId, type: 'adjustment', currency, amount: delta,
    note: String(req.body.note || '').trim().slice(0, 100), status: 'done', createdAt: new Date().toISOString()
  });
  notify(u, delta > 0 ? 'nAdjPlus' : 'nAdjMinus', { a: moneyTxt(Math.abs(delta), currency) });
  await saveUsers(req.users);
  res.json({ balance: u.balance, usd: u.usd || 0 });
});

// Bani / debani yon kliyan (admin pa ka bani tèt li ni yon lòt admin)
app.post('/api/admin/users/:id/ban', adminOnly, async (req, res) => {
  const u = req.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Pa jwenn.' });
  if (u.role === 'admin') return res.status(400).json({ error: 'Ou pa ka bani yon admin.' });
  u.banned = !!req.body.banned;
  logAct(u, 'ban', u.banned ? 'Kont bani' : 'Kont debani', null, { by: req.user.email });
  await saveUsers(req.users);
  res.json({ banned: u.banned });
});

// Efase yon kont nèt (done + dosye KYC yo). Li pa ka konekte ankò.
app.delete('/api/admin/users/:id', adminOnly, async (req, res) => {
  const u = req.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Pa jwenn.' });
  if (u.role === 'admin') return res.status(400).json({ error: 'Ou pa ka efase yon admin.' });
  await store.removeUser(u.id);
  try { await support.removeThread(u.id); } catch (e) { console.error('[chat] pa ka efase fil la', e.message); }
  await fileStore.removeKyc(u.id, u.kyc); // foto yo (Supabase + disk). Si efasman an echwe, li ekri nan logs.
  res.json({ ok: true });
});

app.get('/api/admin/settings', adminOnly, (req, res) => res.json(getSettings()));

app.post('/api/admin/settings', adminOnly, async (req, res) => {
  const rate = Number(req.body.rate);
  const feePercent = Number(req.body.feePercent);
  if (!(rate > 0) || rate > 100000) return res.status(400).json({ error: 'To chanj la pa valid.' });
  if (!(feePercent >= 0) || feePercent > 50) return res.status(400).json({ error: 'Pousantaj la dwe ant 0 ak 50.' });
  const byIn = req.body.feeByAsset && typeof req.body.feeByAsset === 'object' ? req.body.feeByAsset : {};
  const feeByAsset = {};
  for (const a of W_ASSETS) {
    const v = byIn[a];
    if (v === undefined || v === null || String(v).trim() === '') continue; // vid = itilize pousantaj jeneral la
    const n = Number(v);
    if (!(n >= 0) || n > 50) return res.status(400).json({ error: `Pousantaj ${a} la dwe ant 0 ak 50.` });
    feeByAsset[a] = round2(n);
  }
  saveSettings({ ...getSettings(), rate: round2(rate), feeActive: !!req.body.feeActive, feePercent: round2(feePercent), feeByAsset });
  res.json(getSettings());
});

app.get('/api/admin/deposit-info', adminOnly, async (req, res) => {
  const dep = getSettings().deposit, out = {};
  for (const m of Object.keys(D_METHODS)) {
    out[m] = { active: !!(dep[m] && dep[m].active), account: (dep[m] && dep[m].account) || '', name: (dep[m] && dep[m].name) || '', note: (dep[m] && dep[m].note) || '' };
    if (m === 'USDT') { out[m].networks = depNetworks(dep[m]); out[m].binance = depBinance(dep[m]); }
  }
  res.json(out);
});

app.post('/api/admin/deposit-info', adminOnly, async (req, res) => {
  const inp = req.body.info || {}, dep = {};
  const cut = (v, n) => String(v || '').trim().slice(0, n);
  for (const m of Object.keys(D_METHODS)) {
    const i = inp[m] || {};
    if (m === 'USDT') {
      const nets = {}, bin = {};
      for (const n of Object.keys(USDT_NETWORKS)) {
        const a = cut(i.networks && i.networks[n], 100);
        if (a && !USDT_NETWORKS[n].test(a)) return res.status(400).json({ error: 'Adrès ' + n + ' la pa valid.' });
        if (a) nets[n] = a;
      }
      const bid = cut(i.binance && i.binance.id, 30), bem = cut(i.binance && i.binance.email, 100);
      if (bid && !/^\d{5,20}$/.test(bid)) return res.status(400).json({ error: 'Binance ID la pa valid (chif sèlman).' });
      if (bem && !/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(bem)) return res.status(400).json({ error: 'Imèl Binance la pa valid.' });
      if (bid) bin.id = bid;
      if (bem) bin.email = bem;
      dep[m] = { active: !!i.active, account: bin.id || bin.email || Object.values(nets)[0] || '', name: '', note: cut(i.note, 300), binance: bin, networks: nets };
      continue;
    }
    dep[m] = { active: !!i.active, account: cut(i.account, 150), name: cut(i.name, 100), note: cut(i.note, 300) };
  }
  saveSettings({ ...getSettings(), deposit: dep });
  res.json({ ok: true, visible: Object.keys(D_METHODS).filter((m) => dep[m].active && dep[m].account) });
});

app.get('/api/admin/deposits', adminOnly, (req, res) =>
  res.json(req.users.flatMap((u) => (u.swaps || []).filter((t) => t.type === 'deposit')
    .map((t) => ({ ...t, name: u.name, email: u.email, uid: u.uid })))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
);

app.post('/api/admin/deposits/:id/decision', adminOnly, async (req, res) => {
  const decision = req.body.decision;
  if (!['done', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Desizyon pa valid.' });
  for (const u of req.users) {
    const t = (u.swaps || []).find((x) => x.id === req.params.id && x.type === 'deposit');
    if (!t) continue;
    if (t.status !== 'pending') return res.status(409).json({ error: 'Depo sa deja trete.' });
    if (decision === 'done') {
      const amt = round2(Number(req.body.amount === undefined || req.body.amount === '' ? t.amount : req.body.amount));
      if (!(amt > 0)) return res.status(400).json({ error: 'Montan an pa valid.' });
      const field = t.currency === 'USD' ? 'usd' : 'balance';
      u[field] = round2((u[field] || 0) + amt);
      t.requested = t.amount; t.amount = amt; t.status = 'done';
      logAct(u, 'deposit_decision', 'Depo ' + t.method + ' konfime · ' + moneyTxt(amt, t.currency), null, { by: req.user.email });
      notify(u, 'nDepDone', { a: moneyTxt(amt, t.currency), m: t.method });
    } else {
      t.status = 'rejected'; t.note = String(req.body.reason || '').trim().slice(0, 200);
      logAct(u, 'deposit_decision', 'Depo ' + t.method + ' refize · ' + moneyTxt(t.amount, t.currency), null, { by: req.user.email });
      notify(u, 'nDepRej', { a: moneyTxt(t.amount, t.currency), m: t.method });
    }
    await saveUsers(req.users);
    return res.json({ ok: true });
  }
  res.status(404).json({ error: 'Pa jwenn.' });
});

app.get('/api/admin/kyc', adminOnly, (req, res) =>
  res.json(req.users.filter((u) => u.kyc.status !== 'none').map((u) => ({
    id: u.id, uid: u.uid, name: u.name, email: u.email, ...u.kyc
  })))
);

app.get('/api/admin/kyc/:id/:slot', adminOnly, async (req, res, next) => {
  try {
    const slot = String(req.params.slot);
    if (!['front', 'back', 'selfie'].includes(slot)) return res.status(404).json({ error: 'Pa jwenn.' });
    const user = req.users.find((u) => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Pa jwenn.' });
    const f = await fileStore.readKyc(user, slot);
    if (!f) return res.status(404).json({ error: 'Foto a pa jwenn (fichye a pa egziste ankò).' });
    sendImage(res, f, { download: req.query.download === '1', filename: `kyc-${user.uid || user.id}-${slot}.${fileStore.ext(f.name)}` });
  } catch (e) { next(e); }
});

// Tès sante estokaj (admin sèlman): monte, li, konpare epi efase yon ti PNG nan chak bucket. Pa montre kle ni done kliyan.
app.get('/api/admin/storage-check', adminOnly, async (req, res) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const out = { configured: fileStore.canRead, writeToSupabase: fileStore.canWrite, buckets: {} };
  for (const [kind, bucket] of [['kyc', fileStore.kycBucket], ['p2p', fileStore.p2pBucket]]) {
    const r = { bucket, upload: false, download: false, identical: false, missingReturnsNull: false, cleanup: false };
    const p = `healthcheck/${crypto.randomUUID()}.png`;
    try {
      await fileStore.put(kind, p, png, 'png'); r.upload = true;
      const g = await fileStore.get(kind, p); r.download = !!g; r.identical = !!g && g.buffer.equals(png);
      await fileStore.remove(kind, p); r.cleanup = true;
      r.missingReturnsNull = (await fileStore.get(kind, p)) === null;
    } catch (e) { r.error = String(e.message).slice(0, 200); await fileStore.removeQuiet(kind, p); }
    out.buckets[kind] = r;
  }
  out.ok = Object.values(out.buckets).every((b) => b.upload && b.download && b.identical && b.cleanup && b.missingReturnsNull);
  res.status(out.ok ? 200 : 503).json(out);
});

app.post('/api/admin/kyc/:id/decision', adminOnly, async (req, res) => {
  const user = req.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Pa jwenn.' });
  const { decision, reason } = req.body;
  if (!['approved', 'rejected', 'reupload', 'pending'].includes(decision)) return res.status(400).json({ error: 'Desizyon pa valid.' });
  const defaults = { rejected: 'KYC ou refize.', reupload: 'Foto yo pa klè. Tanpri re-voye dokiman yo.' };
  user.kyc.status = decision;
  user.kyc.reason = defaults[decision] ? String(reason || '').slice(0, 300) || defaults[decision] : null;
  user.kyc.reviewedAt = new Date().toISOString();
  logAct(user, 'kyc_decision', 'KYC: ' + ({ approved: 'aksepte', rejected: 'refize', reupload: 're-upload mande', pending: 'remèt an atant' }[decision]), null, { by: req.user.email });
  const kn = { approved: 'nKycOk', rejected: 'nKycRej', reupload: 'nKycRe' }[decision];
  if (kn) notify(user, kn, {});
  await saveUsers(req.users);
  res.json({ ok: true });
});

app.get('/api/admin/withdrawals', adminOnly, (req, res) =>
  res.json(req.users.flatMap((u) => (u.swaps || []).map(txOf).filter((t) => t.type === 'withdrawal')
    .map((t) => ({ ...t, name: u.name, email: u.email })))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
);

app.post('/api/admin/withdrawals/:id/status', adminOnly, async (req, res) => {
  const status = req.body.status;
  if (!['done', 'rejected'].includes(status)) return res.status(400).json({ error: 'Estati pa valid.' });
  for (const u of req.users) {
    const t = (u.swaps || []).find((x) => x.id === req.params.id);
    if (!t) continue;
    if (t.type !== 'withdrawal' && t.type) return res.status(400).json({ error: 'Se pa yon retrè.' });
    if (t.status !== 'pending') return res.status(409).json({ error: 'Retrè sa deja trete.' });
    t.status = status;
    logAct(u, 'withdraw_decision', 'Retrè ' + t.method + ' ' + (status === 'done' ? 'peye' : 'refize + ranbouse') + ' · ' + moneyTxt(t.amount, t.currency || 'HTG'), null, { by: req.user.email });
    if (status === 'rejected') { // ranbouse nan bon balans lan
      const field = (t.currency || 'HTG') === 'HTG' ? 'balance' : 'usd';
      u[field] = round2((u[field] || 0) + t.amount);
    }
    notify(u, status === 'done' ? 'nWdDone' : 'nWdRej', { a: moneyTxt(t.amount, t.currency || 'HTG'), m: t.method });
    await saveUsers(req.users);
    return res.json({ ok: true });
  }
  res.status(404).json({ error: 'Pa jwenn.' });
});

// ---------- Chat support: woutin ----------
// Kliyan: li/ekri SÈLMAN fil pa l (id la sòti nan sesyon an). Pa gen woutin pou voye imaj. Staff (admin/support): wè tout fil yo epi reponn.
const isStaff = (u) => !!u && (u.role === 'admin' || u.role === 'support');
const staffOnly = (req, res, next) => auth(req, res, () => (isStaff(req.user) ? next() : res.status(403).json({ error: 'Pa otorize.' })));
const customerOnly = (req, res, next) => (isStaff(req.user) ? res.status(403).json({ error: 'Staff pa itilize chat kliyan an.' }) : next());
const chatHits = new Map();
function chatLimit(key, max, windowMs) {
  const now = Date.now(), arr = (chatHits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now); chatHits.set(key, arr); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of chatHits) if (!a.length || now - a[a.length - 1] > 3600e3) chatHits.delete(k); }, 10 * 60e3).unref();
const afterId = (q) => Math.max(0, parseInt(q, 10) || 0);

app.get('/api/support/messages', auth, customerOnly, async (req, res) => {
  res.json({ userId: req.user.id, messages: await support.listForUser(req.user.id, afterId(req.query.after)) });
});
app.post('/api/support/messages', auth, customerOnly, async (req, res) => {
  const body = cleanBody(req.body && req.body.body);
  if (!body) return res.status(400).json({ error: 'Ekri yon mesaj (1 a 1000 karaktè).' });
  if (!chatLimit(`u:${req.user.id}:m`, 10, 60e3) || !chatLimit(`u:${req.user.id}:h`, 100, 3600e3)) return res.status(429).json({ error: 'Twòp mesaj. Tann yon ti moman.' });
  res.status(201).json({ message: await support.send(req.user.id, body) });
});

app.get('/api/admin/support/unread', staffOnly, async (req, res) => res.json({ unread: await support.unreadTotal() }));
app.get('/api/admin/support/threads', staffOnly, async (req, res) => {
  const byId = new Map(req.users.map((u) => [u.id, u]));
  const list = (await support.threads()).filter((t) => byId.has(t.userId) && !isStaff(byId.get(t.userId))).map((t) => {
    const u = byId.get(t.userId);
    return { userId: t.userId, name: u.name, email: u.email, uid: u.uid, banned: !!u.banned, lastBody: t.lastBody, lastSender: t.lastSender, lastAt: t.lastAt, unread: t.unread };
  });
  list.sort((a, b) => (b.unread > 0) - (a.unread > 0) || String(b.lastAt).localeCompare(String(a.lastAt)));
  res.json({ unread: list.reduce((n, t) => n + t.unread, 0), threads: list.slice(0, 100) });
});
app.get('/api/admin/support/threads/:userId/messages', staffOnly, async (req, res) => {
  const u = req.users.find((x) => x.id === req.params.userId);
  if (!u || isStaff(u)) return res.status(404).json({ error: 'Pa jwenn.' });
  res.json({ user: { id: u.id, name: u.name, email: u.email, uid: u.uid }, messages: await support.listForStaff(u.id, afterId(req.query.after)) });
});
app.post('/api/admin/support/threads/:userId/messages', staffOnly, async (req, res) => {
  const u = req.users.find((x) => x.id === req.params.userId);
  if (!u || isStaff(u)) return res.status(404).json({ error: 'Pa jwenn.' });
  const body = cleanBody(req.body && req.body.body);
  if (!body) return res.status(400).json({ error: 'Ekri yon repons (1 a 1000 karaktè).' });
  if (!chatLimit(`s:${req.user.id}`, 60, 60e3)) return res.status(429).json({ error: 'Twòp mesaj. Tann yon ti moman.' });
  const reply = await support.reply(u.id, req.user.id, body);
  const lastN = (u.notifs || [])[(u.notifs || []).length - 1];
  if (!(lastN && lastN.k === 'nSupport' && !lastN.read)) { notify(u, 'nSupport', {}); await saveUsers(req.users); }
  res.status(201).json({ message: reply });
});

// ---------- P2P (escrow, anons, lòd, dispit) ----------
const { createService } = require('./p2p/service');
const { mount: mountP2P } = require('./p2p/routes');
const isStaffRole = (r) => r === 'admin' || r === 'support';

// Adaptè balans prensipal la (itilizatè yo nan Supabase). Operasyon senkron: jounal lokal + Supabase an background. Chak operasyon idempotan pa id transfè a.
const mainStore = {
  has(userId, id) { const u = store.getUser(userId); return !!u && (u.swaps || []).some((t) => t.id === id); },
  debit(userId, amountCents, id) {
    return store.applySync(userId, (u) => {
      if (!u) return { result: 'INSUFFICIENT' };
      u.swaps = u.swaps || [];
      if (u.swaps.some((t) => t.id === id)) return { result: 'OK' };
      const have = Math.round((u.usd || 0) * 100);
      if (have < amountCents) return { result: 'INSUFFICIENT' };
      u.usd = round2((have - amountCents) / 100);
      u.swaps.push({ id, type: 'p2p_bridge', dir: 'to_p2p', currency: 'USD', amount: amountCents / 100, status: 'done', createdAt: new Date().toISOString() });
      notify(u, 'nP2pOut', { a: '$' + (amountCents / 100).toFixed(2) });
      return { result: 'OK', changed: true };
    });
  },
  credit(userId, amountCents, id) {
    if (!store.getUser(userId)) throw new Error('user missing');
    store.applySync(userId, (u) => {
      u.swaps = u.swaps || [];
      if (u.swaps.some((t) => t.id === id)) return { result: undefined };
      u.usd = round2(Math.round((u.usd || 0) * 100) / 100 + amountCents / 100);
      u.swaps.push({ id, type: 'p2p_bridge', dir: 'from_p2p', currency: 'USD', amount: amountCents / 100, status: 'done', createdAt: new Date().toISOString() });
      notify(u, 'nP2pIn', { a: '$' + (amountCents / 100).toFixed(2) });
      return { result: undefined, changed: true };
    });
  }
};
const p2pEligible = (userId) => {
  const u = loadUsers().find((x) => x.id === userId);
  if (!u) return { ok: false, reason: 'Kont pa jwenn.' };
  if (isStaffRole(u.role)) return { ok: false, reason: 'Kont staff pa ka fè P2P.' };
  if (u.banned) return { ok: false, reason: 'Kont ou bani.' };
  if (u.kyc.status !== 'approved') return { ok: false, reason: 'KYC ou dwe apwouve anvan ou itilize P2P.' };
  if (!u.profile) return { ok: false, reason: 'Konplete enfòmasyon pèsonèl ou nan Paramèt anvan.' };
  return { ok: true };
};
let nameCache = { t: 0, m: new Map() };
const p2pName = (id) => {
  if (Date.now() - nameCache.t > 5000) { nameCache = { t: Date.now(), m: new Map(loadUsers().map((u) => [u.id, u.profile ? `${u.profile.firstName} ${(u.profile.lastName || '')[0] || ''}.` : u.name])) }; }
  return nameCache.m.get(id) || 'Itilizatè';
};
const p2p = createService({ dbPath: path.join(DATA_DIR, 'p2p.sqlite'), eligible: p2pEligible, nameOf: p2pName, main: mainStore });
mountP2P(app, {
  auth, rateLimit, service: p2p, detectExt, isStaffRole, pinGuard,
  upload: multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single('file'),
  evidenceDir: path.join(DATA_DIR, 'p2p-evidence'),
  files: fileStore
});
// Rekiperasyon nan demaraj + travay peryodik (ekspirasyon, rekiperasyon, reconciliation)
// (rekiperasyon + travay peryodik P2P yo kòmanse nan ready.then(...) anba a, apre itilizatè yo chaje)

// Admin bay yon itilizatè wòl "support" (ka revize dispit, pa ka deplase lajan)
app.post('/api/admin/users/:id/role', adminOnly, async (req, res) => {
  const u = req.users.find((x) => x.id === req.params.id);
  const role = String(req.body.role || '');
  if (!u) return res.status(404).json({ error: 'Pa jwenn.' });
  if (u.role === 'admin') return res.status(400).json({ error: 'Ou pa ka chanje wòl yon admin.' });
  if (!['user', 'support'].includes(role)) return res.status(400).json({ error: 'Wòl pa valid.' });
  u.role = role;
  logAct(u, 'role', role === 'support' ? 'Wòl Support bay' : 'Wòl Support retire', null, { by: req.user.email });
  await saveUsers(req.users);
  res.json({ role });
});

// ---------- Paj yo ----------
// Sèlman 2 paj sa yo ki piblik (server.js ak lòt fichye yo pa janm sèvi)
const page = (file) => (req, res) => res.sendFile(path.join(__dirname, file));
app.get('/', page('index.html'));
app.get('/index.html', page('index.html'));
app.get('/privacy.html', page('privacy.html'));
app.get('/privacy', page('privacy.html'));
app.get('/kyc.html', page('kyc.html'));
app.get('/dashboard.html', page('dashboard.html'));
app.get('/admin.html', page('admin.html'));
app.get('/settings.html', page('settings.html'));
app.get('/p2p.html', page('p2p.html'));
app.get('/admin-p2p.js', page('admin-p2p.js'));
app.get('/i18n.js', page('i18n.js'));
app.get('/dialogs.js', page('dialogs.js'));
app.get('/support-chat.js', page('support-chat.js'));
app.get('/logos.js', page('logos.js'));
app.use('/logos', express.static(path.join(__dirname, 'logos'), { index: false }));
app.get('/kyc', (req, res) => res.redirect('/kyc.html'));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof ConflictError) return res.status(409).json({ error: 'Done yo fèk chanje. Eseye ankò.' });
  if (err instanceof SupportError) {
    console.error('[chat]', req.method, req.path, err.message);
    return res.status(503).json({ error: 'Chat la pa disponib kounye a. Eseye ankò nan kèk segonn.' });
  }
  if (err instanceof StorageError) {
    console.error('[estokaj]', req.method, req.path, err.message);
    return res.status(err.status === 400 ? 400 : 503).json({ error: err.status === 400 ? err.message : 'Estokaj foto a pa disponib kounye a. Eseye ankò nan kèk segonn.' });
  }
  console.error('[erè]', req.method, req.path, err && err.message);
  res.status(503).json({ error: 'Pwoblèm ak baz done a. Eseye ankò nan kèk segonn.' });
});

ready.then(() => {
  try { p2p.recoverBridge(0); p2p.recoverStuck(); } catch (e) { console.error('[p2p] recovery', e); }
  setInterval(() => { try { p2p.runJobs(); } catch (e) { console.error('[p2p] jobs', e); } }, 30 * 1000).unref();
  app.listen(PORT, '0.0.0.0', () => console.log(`Morningstar Exchange ap kouri sou pò ${PORT} (itilizatè: ${useSupabase ? 'Supabase' : 'users.json'})`));
}).catch((e) => { console.error('Pa ka demare:', e.message); process.exit(1); });

// Railway voye SIGTERM pandan redeploy: eseye fini sove sa ki rete anvan sèvè a fèmen
process.on('SIGTERM', () => {
  const t = setTimeout(() => process.exit(0), 8000); t.unref();
  store.flushAll().finally(() => process.exit(0));
});
