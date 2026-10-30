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

## Swap + Retrè (HTG)
- Swap: `POST /api/swap/to-htg` (dola USD/USDT/fiat -> HTG, sèvi ak to + frè admin) ak `POST /api/swap` (HTG -> dola, pou P2P).
- Retrè: HTG sèlman, sèlman sou MonCash / NatCash. Dola yo dwe swap an HTG dabò (`/api/withdraw` rejte `currency != HTG`).
- Depo + retrè: kazye obligatwa "24-48 èdtan pou valide" (UI + sèvè: `ack: true` obligatwa, `ackAt` sove sou tranzaksyon an).

## Notifikasyon (klòch)
- Sove nan done kliyan an (`notifs`, max 50). Kliyan wè konbyen ki pa li (badj wouj) epi louvri lis la; ouvri l make yo kòm li (`POST /api/notifications/read`).
- Konekte sou: depo (resevwa/apwouve/refize), retrè (resevwa/fini/refize), swap, KYC, ajisteman balans admin, pon P2P (voye/retounen), repons Support nan chat.
- Dashboard rafrechi notifikasyon yo chak 30s.

## Depo USDT
- Admin mete (Depo → USDT): Binance ID ak/oswa imèl Binance, adrès TRC20 ak/oswa BEP20.
- Kliyan chwazi Binance (ID oswa imèl) oswa Wallet (rezo). Binance => Transaction ID obligatwa. Wallet => TXID obligatwa (64 hex).
