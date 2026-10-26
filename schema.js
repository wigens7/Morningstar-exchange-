// Schema SQLite pou P2P. Lajan = antye (USDT an micro-inite: 1 USDT = 1_000_000; fiat an santim).
module.exports = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('AVAILABLE','ESCROW','SYSTEM')),
  owner TEXT NOT NULL,                 -- userId | orderId | 'BRIDGE'
  asset TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,  -- kredi - debi
  allow_negative INTEGER NOT NULL DEFAULT 0,
  UNIQUE (kind, owner, asset),
  CHECK (allow_negative = 1 OR balance >= 0)
);
CREATE TABLE IF NOT EXISTS ledger_txs (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,            -- kle idempotans: yon mouvman pa janm fèt de fwa
  type TEXT NOT NULL,
  order_id TEXT,
  created_at INTEGER NOT NULL,
  meta TEXT
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY,
  tx_id INTEGER NOT NULL REFERENCES ledger_txs(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  dir TEXT NOT NULL CHECK (dir IN ('DEBIT','CREDIT')),
  amount INTEGER NOT NULL CHECK (amount > 0)
);
CREATE INDEX IF NOT EXISTS idx_entries_tx ON ledger_entries(tx_id);
CREATE INDEX IF NOT EXISTS idx_entries_acct ON ledger_entries(account_id);

CREATE TABLE IF NOT EXISTS ads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('BUY','SELL')),   -- pèspektiv piblikatè a
  asset TEXT NOT NULL,
  fiat TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  total_micro INTEGER NOT NULL CHECK (total_micro > 0),
  available_micro INTEGER NOT NULL CHECK (available_micro >= 0),
  min_fiat_cents INTEGER NOT NULL CHECK (min_fiat_cents > 0),
  max_fiat_cents INTEGER NOT NULL,
  methods TEXT NOT NULL,
  pay_details TEXT,
  pay_window_min INTEGER NOT NULL CHECK (pay_window_min BETWEEN 5 AND 60),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','PAUSED','CLOSED','SUSPENDED')),
  advertiser_name TEXT,
  terms TEXT,
  idem TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (max_fiat_cents >= min_fiat_cents)
);
CREATE INDEX IF NOT EXISTS idx_ads_market ON ads(status, type, fiat);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  ad_id TEXT NOT NULL REFERENCES ads(id),
  buyer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  asset TEXT NOT NULL,
  fiat TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  crypto_micro INTEGER NOT NULL CHECK (crypto_micro > 0),
  fiat_cents INTEGER NOT NULL CHECK (fiat_cents > 0),
  method TEXT NOT NULL,
  seller_pay TEXT NOT NULL,
  pay_ref TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('CREATED','ESCROW_LOCKED','WAITING_PAYMENT','PAYMENT_MARKED','COMPLETED','CANCELLED','EXPIRED','DISPUTED','UNDER_REVIEW')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER,
  seller_deadline INTEGER,
  completed_at INTEGER,
  payment_note TEXT,
  provider_verified INTEGER NOT NULL DEFAULT 0,
  late_claim INTEGER NOT NULL DEFAULT 0,
  closed_reason TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  CHECK (buyer_id <> seller_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS escrows (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  seller_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL CHECK (status IN ('LOCKED','RELEASED_TO_BUYER','RETURNED_TO_SELLER')),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY, order_id TEXT NOT NULL, ts INTEGER NOT NULL,
  actor TEXT, actor_role TEXT, from_status TEXT, to_status TEXT, action TEXT NOT NULL, details TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT NOT NULL, user_id TEXT NOT NULL, route TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (key, user_id, route)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, order_id TEXT NOT NULL, sender_id TEXT, role TEXT NOT NULL CHECK (role IN ('USER','STAFF','SYSTEM')),
  body TEXT NOT NULL, ts INTEGER NOT NULL, evidence_id TEXT, kind TEXT
);
CREATE INDEX IF NOT EXISTS idx_msgs_order ON messages(order_id);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, uploader_id TEXT NOT NULL, kind TEXT NOT NULL,
  file TEXT NOT NULL, sha256 TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  opened_by TEXT NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN','UNDER_REVIEW','RESOLVED')),
  opened_at INTEGER NOT NULL, assigned_to TEXT,
  resolution TEXT CHECK (resolution IN ('RELEASE_TO_BUYER','RETURN_TO_SELLER')),
  resolution_reason TEXT, resolved_by TEXT, resolved_at INTEGER
);
CREATE TABLE IF NOT EXISTS decision_log (
  id INTEGER PRIMARY KEY, dispute_id INTEGER NOT NULL, ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, reason TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT, role TEXT, action TEXT NOT NULL,
  entity TEXT, entity_id TEXT, details TEXT, ip TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user_id TEXT, kind TEXT NOT NULL, details TEXT, status TEXT NOT NULL DEFAULT 'OPEN'
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, reporter_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
  reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN'
);
CREATE TABLE IF NOT EXISTS webhook_events (
  provider TEXT NOT NULL, event_id TEXT NOT NULL, ts INTEGER NOT NULL, payload_hash TEXT NOT NULL, outcome TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, ok INTEGER, processed INTEGER, error TEXT
);
-- Pwofil machann: non biznis (inik, pa ka chanje) + mesaj otomatik pou tout achtè yo
CREATE TABLE IF NOT EXISTS merchants (
  user_id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  auto_message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS merchants_name_locked BEFORE UPDATE OF business_name ON merchants
  WHEN NEW.business_name <> OLD.business_name BEGIN SELECT RAISE(ABORT,'business name is locked'); END;
CREATE TABLE IF NOT EXISTS bridge_transfers (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, dir TEXT NOT NULL CHECK (dir IN ('IN','OUT')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL CHECK (status IN ('PENDING_DEBIT','PENDING_CREDIT','COMPLETED','FAILED')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

-- Imitabilite: ledger + odit + istwa pa ka modifye oswa efase.
CREATE TRIGGER IF NOT EXISTS ledger_txs_no_update BEFORE UPDATE ON ledger_txs BEGIN SELECT RAISE(ABORT,'ledger is immutable'); END;
CREATE TRIGGER IF NOT EXISTS ledger_txs_no_delete BEFORE DELETE ON ledger_txs BEGIN SELECT RAISE(ABORT,'ledger is immutable'); END;
CREATE TRIGGER IF NOT EXISTS ledger_entries_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT,'ledger is immutable'); END;
CREATE TRIGGER IF NOT EXISTS ledger_entries_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT,'ledger is immutable'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT,'audit log is immutable'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT,'audit log is immutable'); END;
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON order_events BEGIN SELECT RAISE(ABORT,'order history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON order_events BEGIN SELECT RAISE(ABORT,'order history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS decisions_no_update BEFORE UPDATE ON decision_log BEGIN SELECT RAISE(ABORT,'decision log is immutable'); END;
CREATE TRIGGER IF NOT EXISTS decisions_no_delete BEFORE DELETE ON decision_log BEGIN SELECT RAISE(ABORT,'decision log is immutable'); END;
-- Yon escrow ki lage oswa retounen pa ka re-louvri.
CREATE TRIGGER IF NOT EXISTS escrow_final BEFORE UPDATE ON escrows WHEN OLD.status <> 'LOCKED'
  BEGIN SELECT RAISE(ABORT,'escrow is final'); END;
-- Yon lòd COMPLETED/CANCELLED pa ka chanje eta ankò.
CREATE TRIGGER IF NOT EXISTS orders_terminal BEFORE UPDATE OF status ON orders
  WHEN OLD.status IN ('COMPLETED','CANCELLED') AND NEW.status <> OLD.status
  BEGIN SELECT RAISE(ABORT,'terminal order cannot change state'); END;
`;
