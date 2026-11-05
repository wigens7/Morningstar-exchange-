# ZiiroPay integration — diagnostics, pricing and opt-in KYC preparation

## Current rollout boundary

PR #10 established the real read-only provider connection. PR #11 delivered
admin card pricing and a closed preparation page. The next change prepares
automatic KYC behind explicit server-side opt-in, with fake-provider tests only.
It does NOT activate production KYC, create cards, fund/withdraw cards or wallets,
verify webhooks, change swap fees, or send new emails.

## Automatic KYC preparation (not activated)

- `/card-kyc.html` remains authenticated, no-store and no-referrer. When disabled
  it renders no personal-data form. When explicitly enabled it shows the current
  customer's profile read-only and asks for provider-required additional fields.
- Only an unbanned customer with verified email, full immutable profile, active
  PIN and supported approved local KYC can submit. The existing actual PIN guard,
  AJAX/JSON defenses and request limits apply. Country alpha-2 from the profile
  maps to ISO alpha-3; user input cannot change the authoritative country.
- Names, email, DOB, address, telephone and document type come from the
  authenticated server-side profile. `user_id`, `customer_id`, caller-provided
  identity fields, document references and provider mode are rejected.
- The unchecked, versioned consent explicitly covers the identity/contact/
  residence/employment/financial declarations and the existing approved front-ID
  image being sent to ZiiroPay for virtual-card KYC. No new upload is required.
  The backend rechecks the account after reading the private approved document.
- Before any provider POST, consent, identity snapshot, document SHA-256 and
  application state are committed in a separate durable SQLite WAL database,
  `DATA_DIR/card-kyc/kyc.sqlite` (parent 0700, DB 0600, synchronous FULL).
  Identity, ID number, consent and provider customer ID are AES-256-GCM encrypted,
  with per-user authenticated additional data. Email/customer uniqueness uses
  HMAC tags, not plaintext. The image and PIN are never copied to this database.
- A dedicated storage key is required. Do not reuse the JWT/API/webhook key.
  A key fingerprint makes a wrong/rotated key fail closed rather than silently
  creating another application. Back up database AND stable key securely;
  never commit or print the key. Key rotation needs a separate reviewed process.
- At most one provider submission per local application, including double-click,
  simultaneous requests, process restart or a crash in SUBMITTING. A timeout,
  rejected/unknown response or persistence failure never triggers an automatic
  POST retry. Such records need read-only reconciliation/support review.
- The documented POST query to `/api/bitvcard/cardkyc` is prepared server-side,
  with no redirects, 12-second deadline, bounded JSON response and sanitized
  error codes. A 2xx or POST `customer_id` never means approval.
- Only a successful GET `/api/bitvcard/cardkycstatus` with `success:true`,
  `status:approved`, valid ID and matching name/email/country/phone/dial code can
  bind a customer ID. The ID is unique across local users and stays server-side.
  This verifies the identity fields the GET actually returns, not an independent
  ID-number/DOB check the endpoint does not document. ZiiroPay performs the KYC.
- Background read-only verification runs every five minutes only while enabled,
  at most ten due users per run and at most 24 lookups per application in 24 hours.
  A persisted five-minute lease also applies to explicit customer refresh.
  No background task ever retransmits a KYC POST. Unapproved/mismatching,
  changed-profile/document-version, blocked/deleted or conflicted accounts do
  not gain a verified association. After limits expire, support reconciliation
  is required; automated indefinite polling is intentionally absent.
- Local Morningstar KYC approval and user balances/settings are never modified.
  The page never claims that approved KYC means a card was bought or issued.
  Existing customer dashboard card-menu behavior remains unchanged.
- JSON parser errors on the new KYC paths are sanitized before the generic error
  logger. Upstream bodies, credential-bearing URLs, ID images/numbers and PINs
  are not logged or echoed. No browser storage, emails or public KYC links.

### Activation prerequisites — do not set these as part of merge/deploy

- `ZIIROPAY_API_KEY`: already configured merchant key; never retrieve its value.
- `ZIIROPAY_KYC_ENCRYPTION_KEY`: dedicated 32-byte random key encoded as 64 hex
  characters, provisioned through the workspace Secrets flow, not chat.
- `ZIIROPAY_KYC_ENABLED=true`: explicit separate approval to accept real KYC.
- `ZIIROPAY_KYC_MODE=live`: explicit live-only scope. Missing mode or sandbox keeps
  this implementation disabled. No sandbox GET status namespace is documented;
  do not accidentally bind a live status lookup to a sandbox submission.
- Preserve `/data` volume and `DATA_DIR=/data`.

Before enabling real submissions, verify the provider's POST success/error
contract and transport limit for query/base64 ID images. The official reference
puts all fields, including the API key and base64 image, in the POST query;
large URLs may be rejected, and provider/proxy logs must not retain that PII.
Do not silently invent a JSON-body API. Confirm declaration units/allowed
values, retention/deletion policy and a support recovery procedure for declined,
expired or ambiguous applications. No real KYC or provider sandbox submission
was performed during development, so production submission compatibility is
not established by mocks.

Card issuance/funding/withdrawal and webhook signature/replay verification remain
separate blocked stages. Nothing in this KYC preparation enables them.

## Implemented

- Server-side adapter using the documented GET
  `https://www.ziiropay.com/api/wallet/balance/USD?public_key=...`.
- Credentials read only from `ZIIROPAY_API_KEY` and
  `ZIIROPAY_WEBHOOK_SECRET`; presence booleans only are returned.
- Admin-only readiness and explicit connection-test endpoints. The test returns
  sanitized status/schema results, never a balance, upstream body, URL or key.
- No redirects, no automatic retries, 12-second deadline, 8 KiB response limit,
  60-second safe-result cache/single-flight, 5 requests per 15 minutes.
- Admin Settings panel runs the read-only test on button press only, never on
  login or page load. No new email notifications.
- Optional `ZIIROPAY_CONNECTION_CHECK_ON_BOOT=true` performs the same safe GET
  on startup and logs only an allowlisted result code. It is off by default,
  must be explicitly approved before setting it in production, and does not
  block service startup. This allows a deployed connection check without
  exporting keys or obtaining an admin session in this conversation.
- Card financial operations remain disabled. This is not a complete card product.

## Stage 2 delivered in PR #11 (closed-default behavior retained)

- Only the full admin role can set the customer card-creation price, in USD.
  User/support roles are denied; the mutation requires the existing authenticated
  session, AJAX header and request limit. There is no hardcoded customer price.
- Exact decimal strings are converted to integer cents. An unset price is NULL,
  not zero; an explicitly saved zero is allowed. Bad precision/exponents,
  negative amounts and extra properties are rejected server-side.
- The independent `DATA_DIR/virtual-card-settings.json` contains price/revision/
  timestamp only (mode 0600). Atomic rename plus file/directory fsync is used.
  The current single-process service rejects stale revisions. This is NOT a
  multi-replica financial ledger; money operations remain disabled.
- Corruption/read errors fail closed with 503, never an inferred free card.
  Saving card settings never rewrites swap/deposit settings or user balances.
- `GET /card-kyc.html` is a session-protected **preparation/checklist page only**.
  The same path uses each customer's own session; no personal information,
  document or bearer token belongs in the URL. It is NOT a ZiiroPay-hosted link.
  No hosted/per-customer KYC URL API was found in the official reference index.
- `GET /api/virtual-cards/setup` returns only the configured price and disabled
  capability flags. `POST /api/virtual-cards/kyc` returns 503 while disabled.
  The preview contains no personal-data inputs or uploads. No customer PII is
  collected, stored or transmitted to ZiiroPay by this stage.
- Prepared webhook address:
  `https://morningstarechanj.com/api/webhooks/ziiropay`.
  Do not enable provider events until signature verification is implemented
  and deployed. The URL is only a planned address until this PR is deployed.
  POST always returns **503 ZIIROPAY_WEBHOOK_NOT_ENABLED**, including repeated
  success events. GET returns 405 (Allow: POST). It does not acknowledge receipt.
  The route precedes JSON parsing, so malformed payloads cannot leak through JSON
  parser errors. It stores/logs nothing from the request, calls no provider,
  sends no mail, and performs no wallet or card operation.
- Production's existing `/data` volume must remain mounted with `DATA_DIR=/data`.
  Local process-restart persistence tests are not a real production price save.

### Owner's financial rules (requirements, NOT implemented money operations)

1. Admin exclusively controls the customer creation price; do not borrow swap
   fee settings. Saving the price does not enable the product or charge anyone.
2. Failed card creation must not permanently debit the customer's USD balance.
   Reserve spendable funds durably before calling the provider; finalize a debit
   once after a verified successful creation, and release on definitive failure.
   A timeout/unknown outcome requires reconciliation, not blind refund or retry.
   Reservation integration must prevent spending the same funds via existing
   transfers/swaps/withdrawals/P2P during a pending operation.
3. Funding must automatically debit the customer's USD wallet exactly once and
   show success only after provider funding is confirmed. Definite failure
   releases funds; ambiguous outcomes remain pending reconciliation.
4. Card-to-wallet withdrawal stays disabled pending explicit owner approval and
   verified provider settlement semantics. Never credit from the example alone.
5. Persistent unique operation IDs/provider references, atomic wallet settlement,
   ownership checks and replay/crash/redeploy tests are required before financial
   activation. The current route rejection tests do not prove financial
   exactly-once execution.
6. Card KYC must have explicit informed consent, server-side ownership binding,
   authenticated backend submission and validated provider status. Never email
   raw KYC documents or embed PII/credentials in customer links.

## Known source contract

Public documentation was read, not assumed from another payment provider:

- https://ziiropay.readme.io/llms.txt
- https://ziiropay.readme.io/reference/submit-card-kyc
- https://ziiropay.readme.io/reference/get-kyc-status
- https://ziiropay.readme.io/reference/create-dollar-card
- https://ziiropay.readme.io/reference/get-card-details
- https://ziiropay.readme.io/reference/get-card-history
- https://ziiropay.readme.io/reference/fund-withdraw-card
- https://ziiropay.readme.io/reference/freezeactivate-card
- https://ziiropay.readme.io/reference/terminate-card
- https://ziiropay.readme.io/reference/webhook
- https://ziiropay.readme.io/reference/get-main-balance

The ReadMe reference documents query authentication with `public_key` and
`/api/bitvcard/...` card routes. The website homepage contains illustrative Bearer
and `/api/cards` examples; this stage uses the concrete reference endpoint only.
Do not infer the two API contracts are interchangeable.

The merchant-balance reference does not document a sandbox mode parameter.
Therefore this diagnostic is a read-only merchant-account request, NOT a
sandbox card issuance test. Successful balance access does not prove card
issuance permissions, business verification, prefunding or webhook authenticity.

## Verification still required before card operations

1. Stage 1 was merged in PR #10 and the actual server-side read-only probe logged
   `ZIIROPAY_CONNECTION_VERIFIED` on deployment
   `4ee8af9a-22c6-42b0-90be-45c927ed4381`. This does not establish card permissions.
   Do not retrieve keys into chat or local development.
2. Confirm webhook signature header, encoding, algorithm, exact signed bytes,
   timestamp/replay policy and retry semantics from ZiiroPay. A secret being
   present is not proof of the verification contract. Never accept an unsigned
   JSON event as authorization to credit a customer.
3. Verify sandbox responses for KYC, card issuance, funding, withdrawal and
   errors/timeouts. The public reference lacks full response schemas for these
   POSTs. No production POSTs are authorized by this stage.
4. Confirm provider creation/funding/withdrawal charges, minimums and customer
   pricing. Do not silently use zero fees or copy swap fee settings.
5. Confirm request idempotency and lookup/reconciliation after timeouts. Never
   retry an ambiguous money-changing request blindly.
6. Confirm where `virtualcard.withdrawal.success.credited` settles first.
   The supplied event alone does not authorize a Morningstar wallet credit.

## Remaining financial implementation, after contract verification

- Bind provider customer/card IDs to authenticated Morningstar user IDs;
  ownership must be enforced server-side, never via caller-supplied card IDs.
- Activate and verify the prepared card-KYC flow only after the documented
  prerequisites. Local KYC approval does not satisfy ZiiroPay by itself.
  Do not submit real customer documents during development.
- Store durable operation state and reservations, using integer USD cents and
  an atomic/compensated integration with the existing user store. Isolate card
  tables from the existing P2P ledger.
- Persist unique operation IDs and verified provider references before retries;
  use pending/unknown/reconciliation states for ambiguous outcomes.
- Require existing PIN guards for card money movements, CSRF defenses,
  per-user limits and server-controlled prices. No browser-held API key.
- Verify authenticated webhook integrity, event/card/user linkage, reference,
  amount/currency, independent provider status and exactly-once application
  across replay/redeploy/crash. Duplicate event IDs and duplicate operation
  references must not credit twice.
- Display masked cards only by default. Never persist/log CVV or full PAN;
  assess provider-hosted secure display and access controls before revealing
  sensitive details. Redact provider URLs containing tokens.
- Add customer UI for creation, card management, history, funding and withdrawal
  only when those operations can actually be executed safely.

## Scope and rollout

This change modifies no balances, swap/deposit/withdrawal/P2P calculations,
existing user records, existing database schema or deployment configuration.
It adds a separate settings file only after an explicit admin save, and an
isolated encrypted KYC database only when that flow is explicitly configured.
Existing customer card-menu behavior is unchanged deliberately. Webhook samples
are not ingested or stored.

Local verification: 106 automated tests passed, including the actual application
with real JWT/PIN middleware and an explicitly preloaded fake provider (no external
traffic), encrypted restart recovery, concurrent submission suppression, wrong/
duplicate provider IDs, consent and changed-account checks. The browser suite
passed both disabled-default UI and simulated opt-in form/approval flows at
320/390/768px. These are not proof of real provider POST compatibility.
No secrets, real card details or customer data belong in tests or this document.

Merge/deployment requires user approval. A final live confirmation requires the
exact deployment commit, Online replica status, HTTP checks and the protected
diagnostic result. Local mocks do not establish live provider connectivity.
