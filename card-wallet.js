'use strict';

// USD available balance is reserved once before issuing. Pending funds are not
// spent a second time by existing debit paths, because those paths already use
// u.usd. Settlement does NOT debit again. Refund restores only an existing hold.
function createCardWallet(store) {
  const failure = () => Object.assign(new Error('CARD_WALLET_UNCERTAIN'), { code: 'CARD_WALLET_UNCERTAIN', status: 503 });
  const ledger = (u, op) => {
    const item = u?.cardPayments?.[op.id];
    if (item && item.amountCents !== op.total_cents) throw failure();
    return item;
  };
  async function change(op, desired, guard = () => {}) {
    if (!op || typeof op.id !== 'string' || typeof op.user_id !== 'string' ||
        !Number.isSafeInteger(op.total_cents) || op.total_cents < 0 || op.total_cents > 199999998) throw failure();
    for (let attempt = 0; attempt < 3; attempt++) {
      await store.refreshUser(op.user_id);
      const users = store.loadUsers(), user = users.find((u) => u.id === op.user_id);
      if (!user) throw failure();
      const prior = ledger(user, op);
      if (prior?.state === desired || (desired === 'HELD' && prior?.state === 'SETTLED')) return prior.state;
      if (desired === 'REFUNDED' && !prior) return 'NOT_RESERVED';
      if (desired === 'HELD') {
        if (prior) throw failure();
        guard(user);
        const have = Math.round(Number(user.usd || 0) * 100);
        if (!Number.isSafeInteger(have) || have < 0) throw failure();
        if (have < op.total_cents) throw Object.assign(new Error('CARD_INSUFFICIENT'), { code: 'CARD_INSUFFICIENT', status: 409 });
        user.usd = (have - op.total_cents) / 100;
      } else {
        if (prior?.state !== 'HELD') throw failure();
        guard(user);
        if (desired === 'REFUNDED') {
          const have = Math.round(Number(user.usd || 0) * 100);
          if (!Number.isSafeInteger(have) || have < 0 || !Number.isSafeInteger(have + op.total_cents)) throw failure();
          user.usd = (have + op.total_cents) / 100;
        }
      }
      user.cardPayments = { ...(user.cardPayments || {}), [op.id]: {
        amountCents: op.total_cents, state: desired,
        reservedAt: prior?.reservedAt || new Date().toISOString(), updatedAt: new Date().toISOString()
      } };
      try {
        await store.saveUsers(users);
        // Verify ACK loss / backend durability using a fresh persisted read.
        if (ledger(await store.refreshUser(op.user_id), op)?.state === desired) return desired;
        throw failure();
      } catch {
        try {
          if (ledger(await store.refreshUser(op.user_id), op)?.state === desired) return desired;
        } catch { throw failure(); }
        if (attempt === 2) throw failure();
      }
    }
    throw failure();
  }
  return {
    reserve: (op, guard) => change(op, 'HELD', guard),
    settle: (op, guard) => change(op, 'SETTLED', guard),
    refund: (op, guard) => change(op, 'REFUNDED', guard)
  };
}

module.exports = { createCardWallet };
