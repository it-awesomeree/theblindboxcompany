# Demo flows in plain language

## Safety rule that sits above every flow

This is a public browser simulation. It never asks for a password, card number,
bank login, CVV, real phone, or real street address. Nothing is sent to HitPay,
Google, a courier, or an employee. A GitHub Pages screen is never treated as a
trusted backend.

The demo is browser-local and permits only one active tab at a time. Two tabs
are coordinated through an exclusive Web Lock: the second tab has no shop or
admin actions while it waits, then takes authority automatically after the
active tab closes. This handoff does not coordinate different browsers,
devices or real staff members. One-click roles and browser-visible prize
definitions exist only to make review easy.

## Customer purchase

1. The customer adds 1–10 RM100 boxes.
2. Checkout requires a fictional demo customer.
3. The fake Malaysian address and fixed shipping option are reviewed.
4. The customer accepts the exact Series 001 odds and policy version.
5. `OrderService` ignores browser arithmetic and calculates item, shipping and
   total again in integer sen.
6. A 15-minute local stock reservation and frozen order snapshot are created.
7. The customer chooses a mock HitPay method. No payment details are collected.
8. A payment attempt can be pending, processing, succeeded, failed, cancelled
   or expired. Failed/cancelled/expired attempts can safely retry.

Checkout carries one stable, safe request identity. An exact duplicate from the
same customer returns the existing order without another reservation, box or
audit entry. Reusing that identity for another customer or changed intent is
rejected.

Customer and admin retry use one order-wide guard: an order may have at most one
created/pending/processing attempt and at most one attempt that ever captured.
A processing attempt shows only transitions that are legal from processing;
misleading Cancel controls are not displayed.

The stored service clock, not a countdown on the page, decides expiry. At the
exact saved deadline, the next service check marks active unpaid attempts
expired, moves only still-reserved boxes to `void`, releases the stock once and
appends audit evidence. A retry must first move those same boxes back through a
guarded renewal and receives a new deadline. Repeated or late terminal events
cannot release the renewed reservation.

## Payment proof

The provider-style return page always starts from this rule:

> A redirect is not payment proof.

Only one new idempotent mock webhook/event may move the order to paid.
Duplicates are ignored. A second distinct success event on an old or different
attempt is recorded as ignored and cannot change payment, inventory, boxes,
allocations, audit or fulfilment twice.

Protected finance events validate their reason before checking for a duplicate.
The reason must already be safe normalized text no longer than 240 characters;
unsafe markup, extra normalization or truncation is rejected. An accepted
dispute or dispute resolution/refund keeps its canonical reason in the exact
immutable audit (and in the refund intent when money moves). A current ignored
event also stores its canonical submitted reason, route, effective prior status,
ignored outcome/reason and related payment when applicable, all bound to one
immutable ignored audit. An exact accepted or fully evidenced ignored replay is
a write-free read with the original stored result. Changing its payment, type,
source, route, request ID or reason is an idempotency conflict, including when
another transaction stored the event first. A generic ignored event cannot
masquerade as a dispute or dispute resolution/refund. A dispute-resolution ID
is valid only when its immutable immediate prior accepted status is `disputed`;
a generic or claim-refund request is valid only after `succeeded` or
`partially_refunded`. A fresh dispute-resolution ID still requires a currently
disputed payment. Exact migrated v8 ignored events retain explicit immutable
non-replayable migration evidence when the old writer did not preserve their
submitted reason and route; the demo never guesses those missing inputs.

On the first accepted success only:

1. The order becomes confirmed.
2. Each reserved box receives one hidden prize.
3. `PrizeService` selects deterministically from the remaining fixed allocation
   counts in the published series’ frozen prize snapshot; mutable defaults and
   draft edits are not involved.
4. Assigned counters increase once and reservation count decreases once.
5. Physical, bulky, digital or self-collect boxes are grouped into split
   shipments.

## Opening a paid box

1. Ownership, paid allocation, order financial state and current box state are checked.
2. The stored prize is revealed once.
3. The vault animation displays that stored result; it never draws a prize.
4. Repeat, Back, refresh or another open call returns the same prize, box ID,
   manifest ID and reveal time.
5. The customer can open now or leave it sealed in Account.

Reveal and shipment are separate facts. Shipment may advance an unopened box to
shipped, delivered or an exception state; opening later records `revealedAt`
once without downgrading that fulfilment state. Shipment changes never erase the
stored prize or reveal time.

An unopened box cannot first reveal after full refund, cancellation or dispute.
It shows a clear hold message instead of an Open button. A box revealed before
the financial event remains viewable with the same immutable result.

The opener on the public home hero is a separate, clearly labelled
**boosted demo opener**. It is entertainment-only and cannot read or write a
purchased box.

## Refunds

Finance/admin roles must confirm a partial or full fictional refund. A request
ID makes the operation idempotent across every payment. The stored normalized
intent includes the payment ID, amount and sanitized reason. An exact replay
returns the original target with no write, revision, listener, audit or
timestamp change. Reusing the ID with different intent is an explicit conflict.

A partial goodwill refund is a separate, unlinked finance adjustment and is
permitted while the payment is safely refundable. It does not consume a box
remedy entitlement, satisfy a claim settlement or finalize any claim. A generic
full-payment refund, including a refund that ends a dispute, must coordinate
with every claim on the order. Open claims, RMA work, linked-but-unfinalized
refunds, undelivered replacements and malformed terminal evidence block it. An
exact audited completed modern claim refund or delivered replacement
permanently keeps its remedy entitlement and evidence, but no longer blocks a
later unlinked payment-level refund of the remaining balance. The same narrow
exception applies to an exactly preserved migrated legacy under-settled refund:
it must be resolved as `refund_completed`/`refund_recorded`, reference its one
accepted same-order refund event, retain its legacy marker with no settlement
policy, accept a positive amount below the requirement, and match the exact
payment-refund, claim-link and final resolution audits/history. Malformed legacy
history fails closed. The admin record and confirmation warn that a later
refund may compensate the customer again. The later event never links to, edits
or removes the completed claim, legacy history or replacement. A full refund
moves the order to `refunded` only when those checks allow it.

Every accepted refund intent binds to exactly one matching audit. Generic and
dispute-origin refunds record the exact action, payment, prior status and
refunded total, resulting status and refunded total, amount, zero returned
allocations, reason, request/event IDs and event time. Dispute refunds also bind
the refunded order status. When earlier completed modern or exact preserved
legacy claims exist on that order, the audit includes their exact sorted,
unique IDs; the field is omitted when the set is empty. Ignored events may
never carry a refund intent, and only accepted intents contribute to
`refundedSen`.

An assigned prize is never rerolled or returned to the series. A revealed box
keeps its immutable result. An unopened refunded box is held, not reallocated.
The same financial-stop helper cancels only unshipped fulfilment records and
keeps shipped/delivered history intact. A refunded or disputed order remains
financially stopped and unopened boxes stay on hold, but an already-shipped
**original physical carrier record** may still receive legal real-world
carrier outcomes such as delivered, failed delivery, lost or returned. This
exception does not apply to digital delivery, replacement work or an unshipped
original. It does not reopen fulfilment, and tracking details remain locked. A
disputed order can resume eligible held work only through an explicit protected
resolution. That resolution restarts only shipments stopped by that dispute,
preserves any earlier partial refund, and restores the prior coherent order
state (including `closed`).

## Fulfilment and tracking

Paid allocations group into:

- `PARCEL` — normal parcel.
- `BULKY` — groceries such as water, eggs or rice.
- `DIGITAL` — fictional Touch ’n Go fulfilment.
- `SELF_COLLECT` — demo counter collection.

High-value electronics are marked insured and signature-required. A guarded
shipment moves through unfulfilled → picking → packed → label created → shipped
→ delivered. Shipped parcels may enter failed delivery, lost or returned
exceptions. A delivered shipment may be explicitly recorded as returned; this
reopens the affected order and holds its boxes but does not create a claim or
refund. Customer order pages show individual shipment groups, carrier, tracking
and flags only after every box in that order has been revealed. While any box
is still sealed, all split groups collapse into one generic order-level
delivery summary with one neutral combined status, one fictional order-level
reference and generic progress. It does not expose one card per split. Raw
shipment IDs, prize-derived kind, carrier, insurance/signature flags, linked
box IDs and prize names stay hidden. Before shipment, fulfilment/admin roles
may enter a clearly fictional carrier and `DEMO-` tracking code. The service
validates uniqueness and demo-only format, locks the fields after shipping, and
records confirmed before/after values in audit.

Account’s in-transit number uses the actionable-shipment policy. A sent/shipped
original stops counting when an exact authorized overlapping reissue is active
or delivered. The authorized sent/shipped reissue counts instead. If that
reissue is physical and becomes terminal lost or returned, the still
sent/shipped physical original is actionable again. Failed or cancelled
reissues do not reactivate an original, and a digital original never reactivates
after any exact authorized reissue.

A late delivery on an original physical shipment is allowed after replacement
authorization only when every authorized replacement overlapping that box
scope is physical and currently terminal `lost` or `returned`. Any active,
delivered or digital reissue blocks it. The late carrier fact never changes the
claim, remedy or payment, and a cancelled/refunded/disputed financial hold
stays held. The validator still permits only one effective delivered shipment
per box and requires the exact late transition audit.

## Claims

Customers can create fake damage, non-delivery or value-floor claims. Notes are
sanitized, attached to the order and audited. Real incident details must never
be entered.

- Damage must link a delivered, non-digital shipment.
- Non-delivery must link a failed-delivery, lost or returned-to-sender physical
  shipment, or one still shipped for at least three days. A return is valid
  non-delivery evidence only when no delivered event exists at or before claim
  creation. A customer return after delivery and any returned digital
  fulfilment are never physical non-delivery evidence.
- Value-floor review must link that exact already revealed box.
- Delivery claims do not require every prize to be revealed. Before all boxes
  are revealed, the customer sees exactly one generic order-delivery option.
  Submission stores the complete sorted set of available eligible original
  shipment IDs at that moment: delivered physical evidence for damage, or
  eligible failed/overdue physical or digital evidence for non-delivery. It
  never chooses an arbitrary exact shipment link. A whole delivery shipment is
  unavailable if any box in it was already covered by a remedy entitlement at
  that evidence time; this model never partly settles one shipment. The
  customer never sees that set, split count, IDs, carrier, kind, flags, prize
  or per-split status; authorized claim staff may inspect the internal evidence.
  Exact shipment selection becomes available only after every box is revealed.
- Repeating the same open claim returns the existing claim with no repository
  revision, storage write, listener, audit or timestamp change. This exact
  replay check happens before current remedy availability for an exact
  shipment, value-floor box, or the sole neutral order-level claim, so it still
  works after that claim starts or resolves a remedy. The kind, scope, note and
  evidence must be identical; changing the note/evidence is an idempotency
  conflict. Submitted or reviewing neutral claims may widen when new available
  evidence appears. Evidence already reserved or remediated by an earlier claim
  is excluded, so a later disjoint failed shipment can create a second claim
  instead of being trapped in the first scope. Eligibility UI keeps only the
  replay option and never exposes neutral candidate IDs.

Shipment history is ordered by parsed UTC instant and then immutable audit
sequence when instants are equal. Every ordinary shipment transition,
financial stop/resume transition, and the original return atomically recorded
by RMA receipt must map to its exact audit. Claim submission and each neutral
widening use the sequence of the audit that established that evidence set.
Canonical widening audits and same-status customer history rows are paired
one-to-one in deterministic order, including when two widenings share the same
timestamp; extra, missing or retimed rows fail validation. Equivalent ISO
precision (for example `.000Z` and `Z`) compares as the same instant, while a
later audit at that instant cannot rewrite an earlier claim.

Support/admin review requires a note for acknowledge, approve, reject and
the final claim audit. Approval opens a typed remedy path; it does not itself
resolve the claim or issue money. Exactly one claim may hold the remedy
entitlement for a given order box at a time, even when overlapping claims have
different kinds.

The guarded remedy paths are:

- RMA created → received → inspected remains approved/open throughout and keeps
  the box entitlement. Recording RMA received atomically marks a still-delivered
  linked original as returned, with shipment timeline and claim audit evidence;
  an already-returned original is a safe replay path. Inspection is evidence
  for the next decision, not a resolution.
- Replacement authorization creates linked fulfilment work but remains
  approved/open and keeps the entitlement until that exact replacement is
  delivered. A physical damage or post-delivery value-floor replacement cannot
  be authorized until its return/RMA is received, inspected and the original is
  returned. Direct replacement remains available for genuine non-delivery,
  digital failure and other originals that were not already delivered.
  Delivery records the final resolution, and one box can still have only one
  effective delivered original/replacement shipment. A terminal digital
  failure or terminal physical loss/return can instead open a linked refund
  fallback.
- An ordinary linked refund must equal the snapshotted required settlement. A
  terminal replacement fallback is exactly the smaller of the required claim
  settlement and the selected payment’s remaining refundable balance; it never
  uses an uncapped payment-remainder rule.
- Recording an accepted linked refund leaves the claim approved/open. Claims
  must perform a separate final audit against that exact refund event before
  the claim and remedy scope become complete.
- An explicit no-remedy decision may close the claim with a clearly fictional
  `DEMO-` reference and descriptive note.

Every step appends customer-visible history and protected audit evidence. A
claim never creates a refund implicitly; refund remains a separate finance
action. Exact preserved legacy under-settled history is immutable, permanently
owns its remedy scope and remains ineligible to mark delivery fulfilled. It
cannot be changed or upgraded. Its exact final history permits only the
payment’s remaining balance to be refunded later through a separate unlinked
refund or customer-won dispute.

## Admin

Opening an admin URL calls `AdminService`; hiding a menu item is not considered
protection.

- Support can inspect users and claims.
- Fulfilment can inspect and move shipments.
- Finance can inspect payments, reconcile and refund.
- Catalog can inspect inventory and edit a draft series copy.
- The combined Orders workspace is admin/super-admin only because it joins
  customer, payment, hidden-prize, fulfilment and claim data.
- Admin/super admin have wider access.
- An admin cannot suspend their own account.
- Only a `super_admin` can change another `super_admin`; an ordinary admin
  cannot suspend or reactivate one.
- Users links to that fictional user’s filtered order list; Orders can filter by
  every order state, user, order/payment identity and tracking text.

Overview and navigation show only permitted work areas. Lower staff roles cannot
read the cross-department overview, payments, fulfilment or audit sections
unless their role matrix grants that exact section. The same matrix is enforced
by services.

Published Series 001 is read-only and owns a frozen prize-definition snapshot.
The draft button makes a separate editable copy. Sensitive changes use
confirmation dialogs and append actor, role, action, target, reason, UTC time,
request/event ID and before-after evidence to the audit log. Manual order status
changes cannot imitate payment or shipment services. There is no audit
edit/delete operation.

## Demo versus production handoffs

The screens below are review aids only. A production store needs these additional
server-side flows and written operating rules:

- **Cancellation window:** the server decides whether a customer request is
  still before the saved cancellation deadline. After capture/picking, route the
  request into the return/RMA policy instead of force-cancelling the order.
- **Return, replacement and RMA:** open a separate case, lock its exact box
  entitlement across claim kinds, link the exact item and shipment, and record
  receipt/inspection. Replacement authorization stays open until delivery; a
  refund stays separate and needs its final claim audit.
- **Approved claim to finance:** Claims shows the exact-order Payments handoff.
  Approval does not refund automatically; a permitted finance user must review
  the payment and confirm a separate audited linked action. Unlinked partial
  goodwill cannot finalize the claim.
- **Tax and accounting:** production must create invoice/credit-note records and
  reconcile order totals, tax, provider settlements, refunds and disputes with
  the accounting ledger. The demo totals are not invoices.
- **Delivery scope and proof:** production postcode rules calculate bulky and
  remote surcharges and reject unsupported service areas before payment. Digital
  delivery needs provider evidence; self-collect needs verified collection
  evidence, not just a screen click.
- **Notification outbox:** one unique queued notification per business event,
  recipient and template version; retry temporary failures with bounded backoff,
  alert on exhausted attempts, and move them to a dead-letter queue for safe,
  idempotent replay. The demo sends no notifications.

## Seeded review cases

Aina Demo begins with fictional records covering:

- paid and unopened;
- revealed and processing;
- shipped high-value parcel;
- delivered bulky shipment;
- failed delivery;
- fully refunded revealed box.

Reset demo data restores these exact cases.

The repository validates all required collections, cart, integer counters,
unique IDs, globally unique normalized fictional email addresses, complete
normalized demo addresses, active session identity, the exact published Series
001 total of 10,000, assigned and reserved counts, global refund intent,
structured resolution evidence, and important
order/payment/box/shipment/claim links before a write is accepted. The stronger
order checks also enforce the fixed RM100 unit price, fixed shipping schedule,
integer quantity from 1–10, exact published odds and policy versions, matching
box count, and coherent assignment/reveal time and reveal-state combinations.
Malformed current-schema storage enters protected recovery without overwriting
its original bytes. The current schema is version 9. The v5/v6/v7 path first
produces version 8. Before the explicit v8-to-v9 migration changes a cloned
candidate, read-only preflights reject malformed disputed-resolution, RMA
receipt, direct post-delivery replacement and ignored-payment history and
collision-check every synthetic identity. An exact old RMA receipt preserves
the v8 audit prefix and gains a deterministic returned-original timeline plus
rich receipt evidence. An exact old direct post-delivery replacement gains an
explicit migration-only marker and audit without inventing an RMA. The frozen
version 8 rule that one box cannot be effectively delivered twice is rechecked;
impossible original-plus-replacement dual delivery fails closed rather than
gaining a migration exception. Exact old ignored events that lack submitted
reason/route evidence remain non-replayable. Only after these checks may the
clone receive deterministic migration and missing transition/refund evidence.
Failed recovery leaves the source object and exact raw older bytes untouched.
