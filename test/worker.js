// Pwosesis separe: eseye kreye yon lòd sou menm baz SQLite la (tès konkirans ant pwosesis).
const { createService } = require('../p2p/service');
const S = createService({ dbPath: process.env.DB, main: { has: () => false } });
try {
  S.createOrder(process.env.USER, { adId: process.env.AD, crypto: process.env.CRYPTO, method: 'MonCash' });
  console.log('OK');
} catch (e) { console.log(e.code || 'ERR:' + e.message); }
