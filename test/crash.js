// Pwosesis ki mouri brital nan mitan yon tranzaksyon (pa gen COMMIT).
const { createService } = require('../p2p/service');
const S = createService({
  dbPath: process.env.DB, main: { has: () => false },
  hooks: { crash: (p) => { if (p === process.env.CRASH_AT) process.exit(42); } }
});
try { S.release(process.env.USER, process.env.ORDER); console.log('NO_CRASH'); } catch (e) { console.log('ERR ' + e.message); process.exit(1); }
