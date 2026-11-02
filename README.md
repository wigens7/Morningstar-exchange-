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
- Tès: `npm test` (ladan yo konkirans ant pwosesis ak kraze brital).
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

## Admin mobil + QR peman depo
- Meni admin sou mobil la defile agoch/adwat (glise oswa itilize flèch yo). Grid la pa fòse paj la pi laj pase ekran an; chan yo itilize 16 px sou mobil.
- Nan **Enfo Depo**, sove kont/nimewo a dabò, apre sa louvri **Ajoute / jere QR peman**. PNG, JPEG ak WebP sèlman, 5 MB maksimòm. Upload la sove touswit; bouton **Sove** a sove rès enfòmasyon kont lan.
- USDT gen QR separe pou Binance ID, imèl Binance, TRC20 ak BEP20. Pa itilize menm QR la pou yon lòt rezo.
- Si kont/rezo a chanje, QR ki te mare ak ansyen destinasyon an retire otomatikman. Chanjman nòt oswa estati aktif pa efase QR la.
- Kliyan an ka chwazi **Kont / Nimewo** oswa **QR peman**, epi telechaje QR la si li sou menm telefòn nan. Pa gen QR => ansyen afichaj kont/nimewo a rete.
- QR yo sove anba `$DATA_DIR/deposit-qr/`; referans yo rete nan `$DATA_DIR/settings.json`. `DATA_DIR=/data` dwe rete sou volume Railway pèmanan an. Pa gen nouvo variable ni migrasyon baz done.
- Sèl admin ka upload/retire QR; kliyan konekte ka wè sèlman QR yon metòd aktif ak destinasyon ki konfigire. SVG ak lòt dokiman pa aksepte. Fichye yo pa sèvi atravè yon dosye piblik.
- QR la pa pwouve yon peman fèt. Referans/TXID, kazye 24–48 èdtan, ak apwobasyon admin rete obligatwa; pa gen chanjman nan balans, escrow, to oswa frè.

## Tès navigatè lokal
- `npm test`: backend, OTP/imèl, P2P, sekirite QR, ranplasman/efasman, ak konsèvasyon apre rekòmanse ak menm `DATA_DIR`.
- Enstale dev dependencies, epi `npx playwright install chromium`; sou Linux, enstale bibliyotèk sistèm Playwright mande yo tou.
- `npm run test:browser`: fixture lokal sèlman, pa kont production. Verifye 360/390/768/1280 px, scroll, upload, chwa QR/nimewo, download, rezo USDT ak echèk imaj/upload.
- Tès navigatè yo itilize vrè Tailwind men dezaktive fonts/icons CDN opsyonèl yo pou teste fallback fonts yo. `TEST_TAILWIND_PATH` ka bay yon kopi lokal script Tailwind la. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` ka bay yon Chromium ki deja enstale.
