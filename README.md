# Morningstar Exchange

## Node
Node >= 22.13 (P2P itilize `node:sqlite`, pa gen nouvo pakè). Railway li `engines.node` nan package.json.

## Railway Variables
NODE_ENV=production, JWT_SECRET, DATA_DIR=/data (+ Volume sou /data), ADMIN_EMAIL, ADMIN_PASSWORD (min 10),
TEST_USER_EMAIL / TEST_USER_PASSWORD (opsyonèl).
P2P webhook pwovizè (opsyonèl, sèlman apre ou teste ak sandbox): P2P_WEBHOOK_SECRET_<PROVIZÈ> (egz. P2P_WEBHOOK_SECRET_ACME)

## P2P
- Baz: $DATA_DIR/p2p.sqlite (+ -wal, -shm). Prèv foto: $DATA_DIR/p2p-evidence/. SIK **yon sèl replica** (SQLite = yon sèl sèvè).
- Fè backup Volume la regilyèman. Konsèv tou 3 fichye SQLite yo ansanm.
- Tès: `npm test` (29 tès, ladan yo konkirans ant pwosesis ak kraze brital).
- Admin panel -> P2P: lòd, dispit, escrow, ledger, odit, alèt, rapò, anons, travay, reconciliation.
- Wòl `support`: ka wè lòd, pran dispit, chat. PA ka deplase lajan, wè ledger/odit, ni sispann anons.
- Pa gen frè plateform sou P2P (pa implemante).
- Pa gen pwovizè peman konfigire. Modil webhook la egziste men li retounen 503 jiskaske ou mete sekrè a.
