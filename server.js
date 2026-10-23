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

// ---------- Stockage senp (fichye JSON) ----------
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return []; }
}
function saveUsers(users) {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}
const round2 = (n) => Math.round(n * 100) / 100;
const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role || 'user', balance: u.balance || 0,
  kyc: { status: u.kyc.status, idType: u.kyc.idType || null, reason: u.kyc.reason || null },
  swaps: (u.swaps || []).slice(-10).reverse()
});

// Kont admin kreye soti nan Variables (pa janm ekri nan kòd la)
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (ADMIN_EMAIL && ADMIN_PASSWORD.length >= 10) {
  const users = loadUsers();
  let a = users.find((u) => u.email === ADMIN_EMAIL);
  if (!a) {
    a = { id: crypto.randomUUID(), name: 'Admin', email: ADMIN_EMAIL, createdAt: new Date().toISOString(), balance: 0, swaps: [], kyc: { status: 'approved' } };
    users.push(a);
  }
  a.role = 'admin';
  if (!a.passwordHash || !bcrypt.compareSync(ADMIN_PASSWORD, a.passwordHash)) a.passwordHash = bcrypt.hashSync(ADMIN_PASSWORD, 12);
  saveUsers(users);
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
  saveUsers(users);
}

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
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

function setSession(res, user, remember) {
  const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: remember ? '30d' : '1d' });
  res.cookie('token', token, {
    httpOnly: true, sameSite: 'lax', secure: isProd,
    maxAge: (remember ? 30 : 1) * 24 * 3600 * 1000
  });
}

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

// ---------- Auth ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/signup', rateLimit(10, 15 * 60 * 1000), async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'Non an pa valid.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Imèl la pa valid.' });
  if (password.length < 8 || password.length > 100) return res.status(400).json({ error: 'Mòdpas la dwe gen omwen 8 karaktè.' });

  const users = loadUsers();
  if (users.some((u) => u.email === email)) return res.status(409).json({ error: 'Imèl sa a deja itilize.' });

  const user = {
    id: crypto.randomUUID(), name, email,
    passwordHash: await bcrypt.hash(password, 12),
    createdAt: new Date().toISOString(),
    role: 'user', balance: 0, swaps: [],
    kyc: { status: 'none' }
  };
  users.push(user);
  saveUsers(users);
  setSession(res, user, false);
  res.status(201).json(publicUser(user));
});

app.post('/api/login', rateLimit(10, 15 * 60 * 1000), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = loadUsers().find((u) => u.email === email);
  const ok = user && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) return res.status(401).json({ error: 'Imèl oswa mòdpas la pa kòrèk.' });
  setSession(res, user, !!req.body.remember);
  res.json(publicUser(user));
});

app.post('/api/logout', (req, res) => {
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

app.post('/api/kyc', auth, (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Chak foto dwe mwens pase 5 MB.' : 'Pwoblèm ak fichye yo.';
      return res.status(400).json({ error: msg });
    }
    const user = req.user;
    if (!['none', 'reupload'].includes(user.kyc.status)) {
      return res.status(409).json({ error: 'KYC ou a deja soumèt.' });
    }
    const idType = String(req.body.idType || '');
    const needed = ID_TYPES[idType];
    if (!needed) return res.status(400).json({ error: 'Tip dokiman an pa valid.' });

    const dir = path.join(KYC_DIR, user.id);
    const saved = {};
    for (const slot of needed) {
      const f = req.files && req.files[slot] && req.files[slot][0];
      if (!f) return res.status(400).json({ error: 'Tout foto ki obligatwa yo dwe ajoute.' });
      const ext = detectExt(f.buffer);
      if (!ext) return res.status(400).json({ error: 'Sèlman foto JPG, PNG oswa WEBP aksepte.' });
      saved[slot] = { ext, buffer: f.buffer };
    }

    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const files = {};
    for (const [slot, { ext, buffer }] of Object.entries(saved)) {
      files[slot] = `${slot}.${ext}`;
      fs.writeFileSync(path.join(dir, files[slot]), buffer, { mode: 0o600 });
    }

    user.kyc = { status: 'pending', idType, files, submittedAt: new Date().toISOString() };
    saveUsers(req.users);
    res.json(publicUser(user));
  });
});

// ---------- Swap ----------
const METHODS = ['MonCash', 'NatCash', 'Meru', 'USDT', 'Zelle', 'CashApp'];

app.post('/api/swap', auth, (req, res) => {
  const u = req.user;
  if (u.kyc.status !== 'approved') return res.status(403).json({ error: 'KYC ou dwe apwouve anvan ou fè yon swap.' });
  const method = String(req.body.method || '');
  const amount = round2(Number(req.body.amount));
  const account = String(req.body.account || '').trim();
  if (!METHODS.includes(method)) return res.status(400).json({ error: 'Metòd la pa valid.' });
  if (!(amount > 0)) return res.status(400).json({ error: 'Montan an pa valid.' });
  if (amount > (u.balance || 0)) return res.status(400).json({ error: 'Balans ou pa sifi.' });
  if (account.length < 3 || account.length > 100) return res.status(400).json({ error: 'Antre kont oswa nimewo destinasyon an.' });
  u.balance = round2(u.balance - amount);
  u.swaps = u.swaps || [];
  u.swaps.push({ id: crypto.randomUUID(), method, amount, account, status: 'pending', createdAt: new Date().toISOString() });
  saveUsers(req.users);
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
    id: u.id, name: u.name, email: u.email, role: u.role || 'user',
    balance: u.balance || 0, kycStatus: u.kyc.status, createdAt: u.createdAt
  })))
);

app.post('/api/admin/users/:id/balance', adminOnly, (req, res) => {
  const u = req.users.find((x) => x.id === req.params.id);
  const delta = round2(Number(req.body.delta));
  if (!u || !Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: 'Done pa valid.' });
  if ((u.balance || 0) + delta < 0) return res.status(400).json({ error: 'Balans pa ka negatif.' });
  u.balance = round2((u.balance || 0) + delta);
  saveUsers(req.users);
  res.json({ balance: u.balance });
});

app.get('/api/admin/kyc', adminOnly, (req, res) =>
  res.json(req.users.filter((u) => u.kyc.status !== 'none').map((u) => ({
    id: u.id, name: u.name, email: u.email, ...u.kyc
  })))
);

app.get('/api/admin/kyc/:id/:slot', adminOnly, (req, res) => {
  const user = req.users.find((u) => u.id === req.params.id);
  const file = user && user.kyc.files && user.kyc.files[req.params.slot];
  if (!file) return res.status(404).json({ error: 'Pa jwenn.' });
  res.sendFile(path.join(KYC_DIR, user.id, file));
});

app.post('/api/admin/kyc/:id/decision', adminOnly, (req, res) => {
  const user = req.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Pa jwenn.' });
  const { decision, reason } = req.body;
  if (!['approved', 'rejected', 'reupload', 'pending'].includes(decision)) return res.status(400).json({ error: 'Desizyon pa valid.' });
  const defaults = { rejected: 'KYC ou refize.', reupload: 'Foto yo pa klè. Tanpri re-voye dokiman yo.' };
  user.kyc.status = decision;
  user.kyc.reason = defaults[decision] ? String(reason || '').slice(0, 300) || defaults[decision] : null;
  user.kyc.reviewedAt = new Date().toISOString();
  saveUsers(req.users);
  res.json({ ok: true });
});

app.get('/api/admin/swaps', adminOnly, (req, res) =>
  res.json(req.users.flatMap((u) => (u.swaps || []).map((s) => ({ ...s, name: u.name, email: u.email })))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
);

app.post('/api/admin/swaps/:id/status', adminOnly, (req, res) => {
  const status = req.body.status;
  if (!['done', 'rejected'].includes(status)) return res.status(400).json({ error: 'Estati pa valid.' });
  for (const u of req.users) {
    const sw = (u.swaps || []).find((x) => x.id === req.params.id);
    if (!sw) continue;
    if (sw.status !== 'pending') return res.status(409).json({ error: 'Swap sa deja trete.' });
    sw.status = status;
    if (status === 'rejected') u.balance = round2((u.balance || 0) + sw.amount); // ranbouse
    saveUsers(req.users);
    return res.json({ ok: true });
  }
  res.status(404).json({ error: 'Pa jwenn.' });
});

// ---------- Paj yo ----------
// Sèlman 2 paj sa yo ki piblik (server.js ak lòt fichye yo pa janm sèvi)
const page = (file) => (req, res) => res.sendFile(path.join(__dirname, file));
app.get('/', page('index.html'));
app.get('/index.html', page('index.html'));
app.get('/kyc.html', page('kyc.html'));
app.get('/dashboard.html', page('dashboard.html'));
app.get('/admin.html', page('admin.html'));
app.get('/kyc', (req, res) => res.redirect('/kyc.html'));

app.listen(PORT, '0.0.0.0', () => console.log(`Morningstar Exchange ap kouri sou pò ${PORT}`));
