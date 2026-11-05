# Card issuance — new implementation, activation requires owner approval

This connects the existing dashboard's virtual-card menu to `/virtual-card.html`
instead of a coming-soon button. Manual cardholder approval/linking is retained.

## Customer/operator workflow and price policy

1. Admin creates/approves the cardholder on ZiiroPay and links its Customer ID
   to the matching approved Morningstar customer.
2. Admin sets the existing creation price. **This is the creation fee, not the
   initial card balance.** Customer chooses initial funding; the quote explicitly
   shows fee + initial funding = total. No provider fee/minimum/rate is invented.
3. Backend snapshots the configured fee/revision, binding and identity into a
   private three-minute quote. Customer accepts that exact total and enters PIN.
4. Fresh provider KYC-status GET verifies approval/ownership. Available main USD
   is reserved once through the optimistic user store. Existing debit paths
   cannot spend reserved USD because they already use that available `usd` field.
5. A FULL-sync intent marker commits before one application invocation of the
   create POST. Quote/request key and unique open-order constraints suppress
   duplicate clicks/replays. No automatic POST retry, including after restart.
6. Creation response supplies only a candidate ID. Independent GET Card Details
   must verify ID, customer/email/name, active virtual card, initial funding,
   creation time and unique reference. Then settlement does not debit again,
   the masked card appears and the verified-creation notice is queued.

## Failure/recovery and operator tools

- Private `DATA_DIR/virtual-card-orders.sqlite`, mode 0600, WAL + FULL sync:
  quotes, intent, uniqueness, masked card metadata and actor/action/time audit.
- User JSON gains `cardPayments[orderId]`: integer cents and HELD/SETTLED/REFUNDED.
  Reserve subtracts from available USD once; settlement does not subtract again;
  refund restores only an existing hold once. No P2P/swap/deposit arithmetic edits.
- Additive `userstore.refreshUser` uses locked persisted reads to resolve lost
  acknowledgements. File-backend writes now fsync temporary file and directory.
  Existing persistence APIs and CAS conflict behavior stay intact.
- Pre-send failures or explicit 422 validation/authentication rejection with
  no success/card hints release a hold. Timeout, missing/contradictory response,
  HTTP 200 `success:false`, unverified details or uncertain wallet ACK -> REVIEW.
  Never assume an unclear POST failed; never automatically issue another card.
- On restart, interrupted pre-intent work can release a reservation; post-intent
  work becomes REVIEW. Recovery does not call a provider financial endpoint.
  Unresolved UI says authorization/payment needs verification, not success.
- Admin -> customer's 360° -> Demann kreasyon kat: inspect requests. For REVIEW,
  enter provider Card ID + admin PIN for read-only reconciliation/settlement.
  Or explicitly attest no card exists on ZiiroPay, with admin PIN, before releasing
  the reservation. An independently verified card cannot use this refund path.
- Failed/retried notices never undo financial state; durable pending retries use
  existing in-app/outbox deduplication. Pre-send failures consume no email.
  All notices are Haitian Creole; no login emails or other UI language changes.

## Private card viewing

Default storage/API/UI: last four digits, brand, expiry and timestamped balance
snapshot, not live spending balance. Own-customer reveal requires session,
same-origin AJAX header and PIN. PAN/CVV come from fresh owned-card GET, are not
persisted/logged, and clear after 30 seconds/blur/hide/page exit. The private
no-third-party page uses no-store, no-referrer, frame denial and restrictive CSP.
No PAN/CVV/provider-token URL/key enters audit, outbox or browser storage.

## Configuration and remaining uncertainty

Existing requirements: persistent DATA_DIR volume, one replica, user-store/
Supabase configuration, ZIIROPAY_API_KEY, approved manual cardholder and admin fee.
Explicit activation additionally requires:

- `ZIIROPAY_CARD_ISSUING_ENABLED=true`
- `ZIIROPAY_CARD_MODE=live`

Without both, no customer financial POST is allowed. Sandbox adapter tests are
explicit and never charged to customer wallets. Live omits optional sandbox mode,
following the provider's test-mode convention. Old automatic-KYC and one-shot
sandbox-probe flags are not enabled.

Official references:
- https://ziiropay.readme.io/reference/create-dollar-card
- https://ziiropay.readme.io/reference/get-card-details
- https://ziiropay.readme.io/reference/get-kyc-status
- https://ziiropay.readme.io/reference/submit-card-kyc (mode convention)

**No real provider create POST, card, money, customer association, document or
email was used to verify this implementation.** Published create response 200 has
no schema; candidate hints are not success proof. An unexpected response stays
in admin review. Live issuing permissions, accepted initial amount/provider fees,
actual display fields and live-mode behavior remain unverified with the provider.
Local simulations are not proof of production financial readiness or provider
exactly-once processing. Merge, live activation and any real test require consent.

135 automated local tests passed, including actual-app fake network:
activation off/on, authorization/PIN/CSRF/strict input, reserve/create/settle,
rejection/refund, owner-only reveal and SIGKILL/restart in an in-flight POST.
The killed request is not resent, the hold persists and admin release is guarded.
Dedicated card browser suite passed quote/consent/one POST, masked default,
PIN reveal/30-second clearing, no storage, disabled/review states and layouts at
320/390/768/1280px. Fake provider only, no merchant financial requests.

The focused admin/card browser run also passed responsive admin, price save/
reload, manual linking and the explicit PIN/attestation review/refund UI
(`BROWSER_CARD_ADMIN_ONLY=1 npm run test:browser`).
The broader legacy browser run was attempted but did NOT complete: native
checkbox action timeouts around `#kyc-consent` / `#d-ack` and a later overall
run timeout. Its cause is not established; do not report full browser-regression
success. Legacy KYC/deposit UI logic is unchanged; this does not by itself
prove either a production defect or absence of one.

Existing-card re-funding, withdrawals, real-time history/balance, freezing/
termination and webhook financial processing are not enabled in this change.
