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
const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email,
  kyc: { status: u.kyc.status, idType: u.kyc.idType || null, reason: u.kyc.reason || null }
});

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
    if (user.kyc.status === 'pending' || user.kyc.status === 'approved') {
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

// ---------- Admin (revizyon KYC) : header x-admin-key ----------
function adminOnly(req, res, next) {
  const given = Buffer.from(String(req.get('x-admin-key') || ''));
  const real = Buffer.from(ADMIN_KEY);
  if (!ADMIN_KEY || given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
    return res.status(403).json({ error: 'Pa otorize.' });
  }
  next();
}

app.get('/api/admin/kyc', adminOnly, (req, res) => {
  const status = req.query.status || 'pending';
  res.json(
    loadUsers().filter((u) => u.kyc.status === status).map((u) => ({
      id: u.id, name: u.name, email: u.email, ...u.kyc
    }))
  );
});

app.get('/api/admin/kyc/:id/:slot', adminOnly, (req, res) => {
  const user = loadUsers().find((u) => u.id === req.params.id);
  const file = user && user.kyc.files && user.kyc.files[req.params.slot];
  if (!file) return res.status(404).json({ error: 'Pa jwenn.' });
  res.sendFile(path.join(KYC_DIR, user.id, file));
});

app.post('/api/admin/kyc/:id/decision', adminOnly, (req, res) => {
  const users = loadUsers();
  const user = users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Pa jwenn.' });
  const { decision, reason } = req.body;
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Desizyon pa valid.' });
  user.kyc.status = decision;
  user.kyc.reason = decision === 'rejected' ? String(reason || 'Foto yo pa klè. Tanpri re-soumèt.') : null;
  user.kyc.reviewedAt = new Date().toISOString();
  saveUsers(users);
  res.json({ ok: true });
});

// ---------- Paj yo ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('/kyc', (req, res) => res.redirect('/kyc.html'));

app.listen(PORT, '0.0.0.0', () => console.log(`Morningstar Exchange ap kouri sou pò ${PORT}`));
