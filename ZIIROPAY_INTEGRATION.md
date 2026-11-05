# ZiiroPay integration — stage 1, read-only

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

1. Deploy this approved stage and run the admin diagnostic with the existing
   Railway key, or explicitly opt in to the boot check and read its sanitized
   log result. Do not retrieve keys into chat or local development.
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

## Next implementation, after contract verification

- Bind provider customer/card IDs to authenticated Morningstar user IDs;
  ownership must be enforced server-side, never via caller-supplied card IDs.
- Collect missing card-KYC fields and explicit consent without assuming that
  local KYC approval satisfies ZiiroPay. Do not submit real customer documents
  during development.
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

This stage changes no balances, swap/deposit/withdrawal/P2P calculations, user
data, database schema or deployment configuration. Existing customer card-menu
behavior is unchanged deliberately. Webhook samples are not ingested or stored.
No secrets, real card details or customer data belong in tests or this document.

Merge/deployment requires user approval. A final live confirmation requires the
exact deployment commit, Online replica status, HTTP checks and the protected
diagnostic result. Local mocks do not establish live provider connectivity.
