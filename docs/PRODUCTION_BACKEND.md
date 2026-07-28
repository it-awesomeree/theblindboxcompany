# Production backend boundary and launch plan

This document is a plan, not an implementation. The public GitHub Pages demo
must stay fake. A commercial shop needs a separately deployed, reviewed backend
that owns money, identity, inventory, prize assignment and fulfilment.

## Recommended production shape

Use Supabase as a managed starting point:

- **Supabase Auth** for verified customer/admin identities. Enable MFA for every
  privileged role and do not store passwords in application tables.
- **Postgres** for orders, payment attempts/events, immutable series allocations,
  boxes, reveals, shipments, claims and audit.
- **Row Level Security (RLS)** on every exposed table. A customer may read only
  their own records. Browser clients receive no ability to allocate prizes,
  confirm money, refund, change published series or edit audit.
- **Edge Functions or another commercial server runtime** for trusted order
  calculation, HitPay calls, raw webhook verification, allocation, refunds and
  fulfilment transitions.
- A commercial web host for the customer/admin app with environment separation,
  security headers, access logs and rollback. GitHub Pages may continue hosting
  this labelled public prototype only.

Use separate development, staging and production Supabase projects and HitPay
accounts. Never copy production personal data into fixtures.

## Core database records

Use UUID primary keys, `timestamptz` UTC times and integer `bigint` sen for money.
Important uniqueness/check rules include:

- `orders(checkout_request_id)` unique, with exact owned replays returning the
  existing order and conflicting reuse rejected.
- `payment_events(provider, provider_event_id)` unique.
- `payment_attempts(provider_payment_id)` unique when present.
- a partial unique constraint for one active payment attempt per order;
- a capture ledger/constraint that permits at most one captured payment per
  order even if attempts and provider event IDs differ;
- one prize assignment per `box_id`.
- one reveal record per `box_id`.
- `(series_id, allocation_serial)` unique.
- refund request ID unique.
- shipment event request ID unique.
- quantities and money non-negative; declared prize value at least 10,000 sen
  for a published RM100-floor series.
- append-only audit table with database permissions that deny update/delete.

Published series rows and their allocation lines must be immutable. Editing
starts a new draft/version. Orders snapshot item price, shipping fee, address,
odds version, policy version, acknowledgements and calculated totals so later
catalog edits do not rewrite history.

Use a transaction and row locks when reserving/releasing stock, confirming the
first valid payment, consuming exact fixed allocations, and creating boxes.
Compact counters are useful for dashboards but database constraints and a
reconciliation ledger remain the source of truth.

Full refund, accepted cancellation and dispute handling must update the payment,
order, eligible unshipped fulfilment and unopened-box holds in one database
transaction. Already shipped/delivered events remain append-only history.
Resuming a dispute hold needs its own authorized resolution command and audit
record; it must not be a generic status edit.

## Trusted checkout creation

1. The browser sends product, quantity, shipping selection and an address.
2. The server validates/sanitizes them and reads current price, availability,
   shipping and published policy from Postgres.
3. The server calculates all totals in integer sen. Never trust a browser total.
4. A short stock reservation and `pending_payment` order are committed.
5. The server sends a HitPay payment-request call with its secret credential.
6. Only the safe hosted payment URL and public reference return to the browser.

Checkout creation must require a client-generated, safe, bounded request
identity. The server stores it on the order under a database unique constraint.
Inside the same transaction, an exact replay by the same authenticated owner
returns that order; a reused identity with a different owner or canonical
quantity, shipping, address, policy acknowledgement or total is rejected.

The browser must never receive HitPay API secrets or webhook salt. It must never
host raw card-entry fields unless a properly assessed PCI design explicitly
requires it; prefer HitPay’s hosted checkout.

## HitPay webhook verification

Register the production HTTPS webhook URL in the HitPay dashboard. Confirm the
exact signature header, signing algorithm, field order/raw-body rules, event
types and retry behavior against the current official HitPay documentation
before writing code.

The handler must receive the untouched raw request bytes. Do not parse and
re-serialize JSON before verifying. A Node-style pattern is:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

function verifyHitPay(rawBody: Buffer, receivedHex: string, webhookSalt: string) {
  const expected = createHmac('sha256', webhookSalt).update(rawBody).digest()
  const received = Buffer.from(receivedHex, 'hex')
  return received.length === expected.length && timingSafeEqual(received, expected)
}
```

This example intentionally contains no real salt or header name. The production
function must follow HitPay’s currently documented payload/signature contract
exactly.

After a valid signature:

1. Start a database transaction.
2. Insert the provider event using its unique event ID. If it already exists,
   return a safe 2xx without repeating work.
3. Lock the matching payment/order rows.
4. Verify merchant account, currency, amount, provider payment ID and allowed
   transition.
5. Mark payment/order paid only for the provider’s final successful event.
6. Allocate one still-available fixed Series 001 slot per box.
7. Create immutable box/prize assignments and fulfilment work.
8. Commit, then enqueue mail/operations notifications.

Events can be duplicated or arrive out of order. Database uniqueness and state
guards must prevent extra deductions, boxes, prize allocations, reveals,
refunds or shipments.

The guard must be order-wide, not attempt-local: customer retry, staff retry,
webhook reconciliation and forced/late success all lock the order and inspect
every attempt before accepting a capture.

**The customer redirect/return URL is never proof.** It may say “Confirming
payment” and poll the backend. Only the validated webhook transaction confirms
the order and allows prize allocation.

## Prize allocation and reveal

Allocation happens only after validated payment inside a server/database
transaction. Select from remaining fixed allocation rows using a
cryptographically secure server-side draw appropriate to reviewed fairness
requirements. Store the chosen allocation immediately.

Opening checks authenticated ownership and successful payment, then inserts the
one reveal row if missing and returns the stored assignment. An animation can
start after the response, but cannot choose, replace or reroll the prize.

Refunds do not return a revealed or assigned slot to the pool unless a separately
reviewed, legally valid policy explicitly models a void before assignment.
Never offer an admin “reroll” control.

A new reveal is forbidden while the order is cancelled, fully refunded or
disputed. Previously stored reveal rows remain readable. The published series
version stores immutable prize definitions as well as allocation rows, so a
later application constant or draft edit cannot rewrite allocation meaning.

## Production claims

Claims need authenticated ownership, type-specific eligibility and a direct
shipment/box foreign key. Use a unique open-claim key for order, type and linked
record. Damage requires delivered physical goods; non-delivery needs a reviewed
overdue shipment/exception rule; value-floor review needs an immutable reveal.

Store append-only claim events for acknowledge, approve, reject and resolve,
including actor, note and UTC time. Claim approval must not silently issue
money. A separate finance permission, idempotency key and refund transaction are
required.

## Roles and admin security

Store roles/permissions server-side and check them inside every privileged
function. Use least privilege for customer, support, fulfilment, finance,
catalog, admin and super admin. Require:

- MFA and short sessions for staff;
- step-up confirmation for refunds, user suspension, series publishing and
  shipment exceptions;
- self-suspension protection;
- reason and request ID on sensitive actions;
- rate limits and alerting;
- append-only audit with before/after evidence;
- periodic access reviews and immediate offboarding.

Do not rely on hidden navigation, frontend route guards or editable JWT metadata
alone.

## Secrets and deployment

- Store HitPay keys/salt, Supabase service-role key, mail and courier credentials
  only in the production host’s encrypted secret manager.
- Never use a `VITE_` or public browser variable for a secret.
- Rotate secrets, document owners, and alert on failed verification or unusual
  refund/admin activity.
- Protect deploy branches, require review, run migrations separately, and keep a
  tested rollback.
- Add CSP, HSTS, secure cookies, CSRF protections where applicable, dependency
  scanning and regular penetration/security review.

## Mail, shipping and operations

Use a transactional mail provider for verification, receipts, payment outcome,
reveal/manifest, shipping and claim notices. Messages should be queued after the
database transaction and sent idempotently.

Integrate courier/carrier APIs server-side. Store carrier references and ingest
signed/verified or reconciled tracking events. Treat bulky, digital and
self-collect workflows separately. High-value electronics need insured service,
signature/identity procedures and exception escalation.

Add dashboards and alerts for:

- webhook signature failures, retries and event lag;
- reservations nearing expiry;
- payment/order reconciliation mismatches;
- allocation counter mismatch or value-floor violation;
- refund spikes and disputed payments;
- shipment/claim exceptions;
- database errors, latency and failed background jobs.

## Backups, privacy and retention

Enable encrypted automatic Postgres backups, point-in-time recovery, restore
tests, and documented recovery time/recovery point goals. Back up configuration
and audit exports without duplicating secrets.

Before launch, obtain Malaysian legal advice covering promotion/lottery,
consumer, pricing, refund, product, tax and advertising rules. Complete a PDPA
data map and policy covering purpose, consent/notice, access, correction,
retention, deletion, breach response, processors, cross-border transfer and
least-data collection. Do not retain addresses, phones or identity data longer
than the documented business/legal need.

## Production operating rules still required

The demo shows guarded states, but it does not implement these commercial
policies. Before launch, write and test them as backend-owned workflows:

- Define customer cancellation deadlines (for example, before capture or before
  picking), store the applicable deadline on the order, and evaluate it on the
  server. A request outside the window becomes a reviewed return/RMA request,
  never a browser-only status change.
- Give every return, replacement and RMA its own identity, linked items,
  eligibility, received/inspection evidence and append-only history. Replacement
  stock allocation and any refund remain separate idempotent finance actions.
- Route an approved claim to a finance queue for its exact order/payment. Approval
  is evidence for review; it must not call the refund command automatically.
- Snapshot tax treatment and invoice fields on the order, issue legally reviewed
  credit notes for adjustments, and reconcile provider settlement, refunds,
  disputes, invoices, tax and the accounting ledger daily.
- Calculate bulky/remote-area surcharges and serviceability from server-owned
  postcode/service-area tables before payment. Reject unavailable destinations
  clearly and version the rules captured by the order.
- Record provider delivery evidence for digital goods and signed identity,
  collection code and staff evidence for self-collect. Never treat an email send,
  page view or button click alone as fulfilment proof.
- Use a transactional notification outbox with a unique business-event,
  recipient and template/version key. Retry temporary failures with bounded
  backoff and jitter; move exhausted/permanent failures to a dead-letter queue
  with alerts, safe inspection and an idempotent manual replay.

## Minimum launch gate

**STOP: the public demo is not production.** Do not accept a real order until
all of these are independently verified:

- legal/compliance approval for the product, odds, language and RM100 claim;
- production RLS and role tests;
- raw-body HMAC webhook tests using current HitPay documentation;
- duplicate/out-of-order/retry/refund reconciliation tests;
- exact 10,000-slot allocation and immutable reveal tests;
- real fulfilment, insurance, returns and claims procedures;
- monitoring, alerting, backups and restore drill;
- privacy notices, retention, incident response and staff access review;
- security review with no secrets in public assets.
