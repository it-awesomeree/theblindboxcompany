# Demo flows in plain language

## Safety rule that sits above every flow

This is a public browser simulation. It never asks for a password, card number,
bank login, CVV, real phone, or real street address. Nothing is sent to HitPay,
Google, a courier, or an employee. A GitHub Pages screen is never treated as a
trusted backend.

The demo is also single-tab and local. Its `localStorage` repository cannot
coordinate two tabs, browsers, devices or staff members. One-click roles and
browser-visible prize definitions exist only to make review easy.

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
A full refund moves the order to `refunded` when allowed.

An assigned prize is never rerolled or returned to the series. A revealed box
keeps its immutable result. An unopened refunded box is held, not reallocated.
The same financial-stop helper cancels only unshipped fulfilment records and
keeps shipped/delivered history intact. A refunded or disputed order remains
financially stopped and unopened boxes stay on hold, but an already-shipped
record may still receive legal real-world carrier outcomes such as delivered,
failed delivery, lost or returned. This does not reopen fulfilment, and tracking
details remain locked. A disputed order can resume eligible held work only
through an explicit protected resolution. That resolution restarts only
shipments stopped by that dispute, preserves any earlier partial refund, and
restores the prior coherent order state (including `closed`).

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
  Submission stores the complete sorted set of eligible physical shipment IDs
  at that moment, with no arbitrary exact shipment link. The customer never
  sees that set, split count, IDs, carrier, kind, flags, prize or per-split
  status; authorized claim staff may inspect the internal evidence. Exact
  shipment selection becomes available only after every box is revealed.
- Repeating the same open claim returns the existing claim with no repository
  revision, storage write, listener, audit or timestamp change.

Support/admin review requires a note for acknowledge, approve, reject and
resolve. The approved → resolved step also requires one structured outcome:
replacement authorized, return/RMA created, refund recorded or no remedy. A
replacement, RMA or no-remedy result needs a clearly fictional `DEMO-` reference
and descriptive note. A refund-recorded result must name an existing audited
refund event for a payment on that order. The outcome and reference stay
visible to both admin and customer. Every step appends customer-visible history
and protected audit evidence. A claim never creates a refund implicitly; refund
remains a separate finance action.

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
- **Return, replacement and RMA:** open a separate case, link the exact item and
  shipment, record receipt/inspection, then approve replacement stock or send an
  approved amount to finance. Neither outcome happens when the case is opened.
- **Approved claim to finance:** Claims shows the exact-order Payments handoff.
  Approval does not refund automatically; a permitted finance user must review
  the payment and confirm a separate audited action.
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
Malformed current-schema storage is replaced by these deterministic fixtures.
