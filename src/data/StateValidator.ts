import {
  ADMIN_ROLES,
  BOX_PRICE_SEN,
  BOX_TRANSITIONS,
  MAX_CART_QUANTITY,
  ORDER_TRANSITIONS,
  PAYMENT_TRANSITIONS,
  POLICY_ACKNOWLEDGEMENT,
  SCHEMA_VERSION,
  SERIES_ALLOCATION_TOTAL,
  SERIES_ID,
  SHIPPING_FEES,
  SHIPMENT_TRANSITIONS,
} from '../domain/constants'
import { validateCanonicalAuditEvidence } from '../domain/auditEvidence'
import {
  assert,
  CHECKOUT_REQUEST_ID_PATTERN,
  isClearlyFictionalCarrier,
  isValidDemoTracking,
  sanitizeText,
  validateDemoAddress,
  validateDemoEmail,
  validateDemoUserName,
} from '../domain/guards'
import {
  shipmentClaimEligibility,
  valueFloorClaimEligibility,
} from '../domain/claimEligibility'
import {
  canWidenClaimEvidence,
  CLAIM_EVIDENCE_WIDENING_NOTE,
  isOpenClaimStatus,
} from '../domain/claimStatus'
import { deriveOrderStatusFromShipments } from '../domain/orderStatus'
import { isValidPrizeDefinition } from '../domain/prizeValidation'
import type {
  Box,
  BoxStatus,
  ClaimKind,
  ClaimResolutionOutcome,
  ClaimStatus,
  DemoState,
  FulfilmentKind,
  OrderStatus,
  Payment,
  PaymentMethod,
  PaymentStatus,
  Role,
  SeriesStatus,
  ShippingMethod,
  ShipmentStatus,
} from '../domain/types'

const ROLES: Role[] = ['customer', ...ADMIN_ROLES]
const ACTIVE_PAYMENT = new Set(['created', 'pending', 'processing'])
const FINANCIAL_STOP = new Set<OrderStatus>(['cancelled', 'refunded', 'disputed'])
const UNSHIPPED = new Set<ShipmentStatus>(['unfulfilled', 'picking', 'packed', 'label_created'])
const ORDER_STATUSES = new Set<OrderStatus>(Object.keys(ORDER_TRANSITIONS) as OrderStatus[])
const PAYMENT_STATUSES = new Set<PaymentStatus>(Object.keys(PAYMENT_TRANSITIONS) as PaymentStatus[])
const BOX_STATUSES = new Set<BoxStatus>(Object.keys(BOX_TRANSITIONS) as BoxStatus[])
const SHIPMENT_STATUSES = new Set<ShipmentStatus>(Object.keys(SHIPMENT_TRANSITIONS) as ShipmentStatus[])
const CLAIM_STATUSES = new Set<ClaimStatus>(['submitted', 'reviewing', 'approved', 'rejected', 'resolved'])
const CLAIM_KINDS = new Set<ClaimKind>(['damage', 'non_delivery', 'value_floor'])
const CLAIM_RESOLUTION_OUTCOMES = new Set<ClaimResolutionOutcome>([
  'replacement_authorized',
  'return_rma_created',
  'refund_recorded',
  'no_remedy',
])
const SERIES_STATUSES = new Set<SeriesStatus>(['draft', 'published'])
const FULFILMENT_KINDS = new Set<FulfilmentKind>(['PARCEL', 'BULKY', 'DIGITAL', 'SELF_COLLECT'])
const SHIPPING_METHODS = new Set<ShippingMethod>(['standard', 'priority', 'self_collect'])
const PAYMENT_METHODS = new Set<PaymentMethod>(['FPX', 'DUITNOW', 'CARD', 'GRABPAY', 'TNG'])
const NORMAL_PAID_ORDER_STATUSES = new Set<OrderStatus>([
  'confirmed',
  'processing',
  'partially_fulfilled',
  'fulfilled',
  'closed',
])
const NORMAL_CAPTURE_STATUSES = new Set<PaymentStatus>(['succeeded', 'partially_refunded'])
const CLAIM_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  submitted: ['reviewing', 'rejected'],
  reviewing: ['approved', 'rejected'],
  approved: ['resolved'],
  rejected: [],
  resolved: [],
}
const AUDIT_OUTCOMES = new Set(['applied', 'ignored'])

function integer(value: unknown, minimum = 0) {
  return Number.isInteger(value) && Number(value) >= minimum
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizedText(value: unknown, maximum: number) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    sanitizeText(value, maximum) === value
  )
}

function validIso(value: unknown) {
  return typeof value === 'string' && value.endsWith('Z') && Number.isFinite(Date.parse(value))
}

function timestamp(value: string) {
  return Date.parse(value)
}

function chronological(values: string[], label: string) {
  for (let index = 1; index < values.length; index += 1) {
    assert(timestamp(values[index]) >= timestamp(values[index - 1]), `${label} must be chronological.`)
  }
}

function unique(values: string[], label: string) {
  assert(values.every((value) => typeof value === 'string' && value.length > 0), `${label} IDs are invalid.`)
  assert(new Set(values).size === values.length, `${label} IDs must be unique.`)
}

function changedStatusesAreLegal<T extends string>(
  statuses: T[],
  transitions: Record<T, T[]>,
  label: string,
) {
  for (let index = 1; index < statuses.length; index += 1) {
    const before = statuses[index - 1]
    const after = statuses[index]
    if (before !== after) assert(transitions[before]?.includes(after), `${label} timeline has an illegal ${before} to ${after} jump.`)
  }
}

function captured(payment: Payment) {
  return payment.events.some((event) => event.type === 'succeeded' && !event.ignoredReason)
}

function capturedAt(payment: Payment) {
  const event = payment.events.find((entry) => entry.type === 'succeeded' && !entry.ignoredReason)
  return event?.processedAt
}

function replayPaymentStatus(payment: Payment) {
  const first = payment.events[0]
  assert(
    first && !first.ignoredReason && (first.type === 'created' || first.type === 'succeeded'),
    `Payment ${payment.id} history must begin with an accepted created or seeded succeeded event.`,
  )
  let effective: PaymentStatus = first.type === 'created' ? 'pending' : 'succeeded'
  for (const event of payment.events.slice(1)) {
    if (event.ignoredReason) continue
    assert(
      PAYMENT_TRANSITIONS[effective].includes(event.type),
      `Payment ${payment.id} history has an illegal accepted ${effective} to ${event.type} jump.`,
    )
    effective = event.type
  }
  return effective
}

function customerClaimNoteIsSafe(value: unknown) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 500 || !/\bDEMO\b/i.test(value)) return false
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(value)) return false
  const phoneLike = value.match(/\+?\d[\d\s().-]{6,}\d/g) ?? []
  return phoneLike.every((candidate) => candidate.replace(/\D/g, '').length < 8)
}

function everyOrderBoxRevealedAt(state: DemoState, orderId: string, at: string) {
  const order = state.orders.find((entry) => entry.id === orderId)
  return Boolean(
    order?.boxIds.length &&
    order.boxIds.every((boxId) => {
      const box = state.boxes.find((entry) => entry.id === boxId && entry.orderId === order.id)
      return Boolean(box?.revealedAt && timestamp(box.revealedAt) <= timestamp(at))
    }),
  )
}

function eligibleClaimShipmentIds(
  state: DemoState,
  orderId: string,
  kind: Extract<ClaimKind, 'damage' | 'non_delivery'>,
  at: string,
) {
  return state.shipments
    .filter((shipment) =>
      shipment.orderId === orderId &&
      shipmentClaimEligibility(shipment, kind, at).eligible,
    )
    .map((shipment) => shipment.id)
    .sort((left, right) => left.localeCompare(right))
}

function validateOrderFulfilment(state: DemoState, orderId: string) {
  const order = state.orders.find((entry) => entry.id === orderId)!
  const shipments = state.shipments.filter((entry) => entry.orderId === order.id)
  if (FINANCIAL_STOP.has(order.status)) {
    assert(
      shipments.every((shipment) => !UNSHIPPED.has(shipment.status)),
      'A financially stopped order cannot retain eligible unshipped fulfilment.',
    )
    return
  }
  if (order.status === 'pending_payment') {
    assert(shipments.length === 0, 'An unpaid order cannot have shipments.')
    return
  }
  assert(shipments.length > 0, 'A paid order must have coherent fulfilment records.')
  const derived = deriveOrderStatusFromShipments(shipments.map((shipment) => shipment.status))
  if (order.status === 'closed') {
    assert(derived === 'fulfilled', 'A closed order requires every shipment to be delivered.')
    return
  }
  assert(
    order.status === derived,
    `Order ${order.id} status must be ${derived} for its shipment progress.`,
  )
}

function validateBoxShipment(state: DemoState, box: Box) {
  if (!box.prizeId) {
    assert(!box.shipmentId, 'An unallocated box cannot have a shipment.')
    return
  }
  assert(box.shipmentId, 'Every allocated box needs a documented fulfilment record.')
  const shipment = state.shipments.find((entry) => entry.id === box.shipmentId)
  assert(shipment && shipment.boxIds.includes(box.id), 'Box shipment reference is inconsistent.')
  const order = state.orders.find((entry) => entry.id === box.orderId)!
  if (FINANCIAL_STOP.has(order.status)) {
    if (!box.revealedAt) assert(box.status === 'on_hold', 'An unopened allocated box must stay on financial hold.')
    return
  }
  if (shipment.status === 'shipped') assert(box.status === 'fulfillment_pending', 'A shipped box must be in fulfilment.')
  if (shipment.status === 'delivered') assert(box.status === 'fulfilled', 'A delivered box must be fulfilled.')
  if (['failed_delivery', 'lost', 'returned', 'cancelled'].includes(shipment.status)) {
    assert(box.status === 'on_hold', 'A shipment exception must put its box on hold.')
  }
}

export function validateDemoState(value: unknown): asserts value is DemoState {
  assert(value && typeof value === 'object', 'State must be an object.')
  const state = value as DemoState
  assert(state.schemaVersion === SCHEMA_VERSION, 'Schema version is not current.')
  assert(integer(state.revision), 'Revision must be a nonnegative integer.')
  assert(integer(state.nextSequence, 1), 'Next sequence must be a positive integer.')
  for (const key of ['users', 'series', 'cart', 'orders', 'payments', 'boxes', 'shipments', 'claims', 'audits'] as const) {
    assert(Array.isArray(state[key]), `${key} must be a collection.`)
  }

  unique(state.users.map((entry) => entry.id), 'User')
  unique(state.series.map((entry) => entry.id), 'Series')
  unique(state.orders.map((entry) => entry.id), 'Order')
  unique(state.orders.map((entry) => entry.checkoutRequestId), 'Checkout request')
  unique(state.payments.map((entry) => entry.id), 'Payment')
  unique(state.boxes.map((entry) => entry.id), 'Box')
  unique(state.shipments.map((entry) => entry.id), 'Shipment')
  unique(state.claims.map((entry) => entry.id), 'Claim')
  unique(state.audits.map((entry) => entry.id), 'Audit')
  assert(state.audits.length > 0, 'Audit history must not be empty.')
  assert(
    integer(state.auditCount, 1) && state.auditCount === state.audits.length,
    'Audit count must exactly match audit history.',
  )
  assert(
    normalizedText(state.auditHeadId, 120) &&
      state.auditHeadId === state.audits.at(-1)?.id,
    'Audit head must reference the latest audit entry.',
  )
  assert(state.payments.every((entry) => Array.isArray(entry.events)), 'Payment events must be collections.')
  assert(state.orders.every((entry) => Array.isArray(entry.timeline)), 'Order timelines must be collections.')
  assert(state.shipments.every((entry) => Array.isArray(entry.timeline)), 'Shipment timelines must be collections.')
  assert(state.claims.every((entry) => Array.isArray(entry.history)), 'Claim histories must be collections.')
  unique(state.payments.flatMap((entry) => entry.events.map((event) => event.id)), 'Payment event')
  unique(state.orders.flatMap((entry) => entry.timeline.map((event) => event.id)), 'Order timeline')
  unique(state.shipments.flatMap((entry) => entry.timeline.map((event) => event.id)), 'Shipment timeline')
  unique(state.claims.flatMap((entry) => entry.history.map((event) => event.id)), 'Claim history')

  assert(
    state.sessionUserId === null || state.users.some((user) => user.id === state.sessionUserId && user.status === 'active'),
    'Session user must reference an active user.',
  )
  for (const user of state.users) {
    assert(ROLES.includes(user.role) && ['active', 'suspended'].includes(user.status), 'User role or status is invalid.')
    assert(validateDemoEmail(user.email) === user.email, 'User email must remain normalized fictional data.')
    assert(validateDemoUserName(user.name) === user.name, 'User name must remain normalized fictional data.')
    assert(validIso(user.createdAt), 'User time is invalid.')
  }
  const userEmails = state.users.map((user) => user.email)
  assert(new Set(userEmails).size === userEmails.length, 'User emails must be globally unique.')

  const publishedSeries = state.series.filter((entry) => entry.status === 'published')
  assert(
    publishedSeries.length === 1 &&
      publishedSeries[0].id === SERIES_ID &&
      publishedSeries[0].allocationTotal === SERIES_ALLOCATION_TOTAL,
    'Published Series 001 must contain exactly 10,000 boxes.',
  )
  for (const series of state.series) {
    assert(SERIES_STATUSES.has(series.status), 'Series status is invalid.')
    assert(integer(series.allocationTotal, 1) && integer(series.reservedBoxes), 'Series counters are invalid.')
    unique(series.inventory.map((counter) => counter.prizeId), 'Inventory prize')
    assert(series.inventory.every((counter) => integer(counter.assigned)), 'Assigned counts must be nonnegative integers.')
    if (series.status === 'published') {
      assert(Array.isArray(series.publishedPrizes) && series.publishedPrizes.length > 0, 'Published series snapshot is required.')
      unique(series.publishedPrizes.map((prize) => prize.id), 'Published prize')
      assert(
        series.publishedPrizes.every((prize) =>
          isValidPrizeDefinition(prize, series.allocationTotal)),
        'Published prize definitions are invalid.',
      )
      assert(
        series.publishedPrizes.reduce((sum, prize) => sum + prize.allocation, 0) === series.allocationTotal,
        'Published allocation total does not match its frozen snapshot.',
      )
      assert(
        series.inventory.length === series.publishedPrizes.length &&
          series.inventory.every((counter) => series.publishedPrizes!.some((prize) => prize.id === counter.prizeId)),
        'Published inventory does not match its frozen snapshot.',
      )
      for (const counter of series.inventory) {
        const prize = series.publishedPrizes.find((entry) => entry.id === counter.prizeId)!
        assert(counter.assigned <= prize.allocation, 'Assigned inventory exceeds its frozen allocation.')
        const actual = state.boxes.filter((box) => box.seriesId === series.id && box.prizeId === counter.prizeId).length
        assert(counter.assigned === actual, 'Assigned inventory does not match allocated boxes.')
      }
      const reserved = state.boxes.filter((box) => box.seriesId === series.id && box.status === 'reserved' && !box.prizeId).length
      assert(series.reservedBoxes === reserved, 'Reserved counter does not match reserved boxes.')
      const assigned = series.inventory.reduce((sum, counter) => sum + counter.assigned, 0)
      assert(assigned + series.reservedBoxes <= series.allocationTotal, 'Series counters exceed total allocation.')
    } else {
      assert(
        Array.isArray(series.draftPrizes) && series.draftPrizes.length > 0,
        'Draft prize definitions are required.',
      )
      unique(series.draftPrizes.map((prize) => prize.id), 'Draft prize')
      assert(
        series.draftPrizes.every((prize) =>
          isValidPrizeDefinition(prize, series.allocationTotal)),
        'Draft prize definitions are invalid.',
      )
      assert(
        series.draftPrizes.reduce((sum, prize) => sum + prize.allocation, 0) ===
          series.allocationTotal,
        'Draft allocation total does not match its definitions.',
      )
      assert(
        series.inventory.length === series.draftPrizes.length &&
          series.inventory.every((counter) =>
            counter.assigned === 0 &&
            series.draftPrizes!.some((prize) => prize.id === counter.prizeId)),
        'Draft inventory must match its prize definitions without assigned boxes.',
      )
    }
  }

  unique(state.cart.map((item) => item.seriesId), 'Cart series')
  for (const item of state.cart) {
    assert(integer(item.quantity, 1) && item.quantity <= MAX_CART_QUANTITY, 'Cart quantity is invalid.')
    assert(item.unitPriceSen === BOX_PRICE_SEN, 'Cart price must match the fixed demo box price.')
    assert(state.series.some((series) => series.id === item.seriesId && series.status === 'published'), 'Cart series is invalid.')
  }

  for (const order of state.orders) {
    assert(ORDER_STATUSES.has(order.status), 'Order status is invalid.')
    assert(CHECKOUT_REQUEST_ID_PATTERN.test(order.checkoutRequestId), 'Checkout request identity is invalid.')
    assert(state.users.some((user) => user.id === order.userId && user.role === 'customer'), 'Order user reference is invalid.')
    assert(record(order.snapshot), 'Order snapshot is invalid.')
    assert(record(order.snapshot.totals), 'Order totals snapshot is invalid.')
    assert(record(order.snapshot.address), 'Order address snapshot is invalid.')
    assert(
      nonEmptyString(order.snapshot.itemName) &&
        nonEmptyString(order.snapshot.seriesId) &&
        nonEmptyString(order.snapshot.oddsVersion) &&
        nonEmptyString(order.snapshot.policyVersion) &&
        order.snapshot.acknowledgement === POLICY_ACKNOWLEDGEMENT,
      'Order snapshot text or acknowledgement is invalid.',
    )
    assert(SHIPPING_METHODS.has(order.snapshot.shippingMethod), 'Order shipping method is invalid.')
    const address = order.snapshot.address
    assert(
      JSON.stringify(validateDemoAddress(address)) === JSON.stringify(address),
      'Order address must remain fully validated, normalized, and visibly fictional.',
    )
    const orderSeries = state.series.find(
      (series) => series.id === order.snapshot.seriesId && series.status === 'published',
    )
    assert(orderSeries, 'Order series reference is invalid.')
    assert(
      order.snapshot.oddsVersion === orderSeries.oddsVersion &&
        order.snapshot.policyVersion === orderSeries.policyVersion,
      'Order snapshot versions must match its published series.',
    )
    assert(
      integer(order.snapshot.quantity, 1) && order.snapshot.quantity <= MAX_CART_QUANTITY,
      'Order quantity is invalid.',
    )
    assert(
      Number.isSafeInteger(order.snapshot.valueFloorSen) &&
        order.snapshot.valueFloorSen > 0,
      'Order value-floor snapshot must be a positive bounded safe integer-sen amount.',
    )
    assert(
      [order.snapshot.unitPriceSen, order.snapshot.totals.itemSubtotalSen, order.snapshot.totals.shippingSen, order.snapshot.totals.totalSen]
        .every((amount) => integer(amount)),
      'Order money must use integer sen.',
    )
    assert(
      order.snapshot.unitPriceSen === BOX_PRICE_SEN,
      'Order unit price must match the immutable demo box price.',
    )
    assert(
      order.snapshot.totals.itemSubtotalSen === BOX_PRICE_SEN * order.snapshot.quantity,
      'Order subtotal must match the immutable demo box price and quantity.',
    )
    assert(
      order.snapshot.totals.shippingSen === SHIPPING_FEES[order.snapshot.shippingMethod],
      'Order shipping must match the immutable demo shipping schedule.',
    )
    assert(
      order.snapshot.totals.totalSen ===
        BOX_PRICE_SEN * order.snapshot.quantity + SHIPPING_FEES[order.snapshot.shippingMethod],
      'Order total must match the immutable item subtotal and shipping schedule.',
    )
    assert(Array.isArray(order.paymentIds) && Array.isArray(order.boxIds) && Array.isArray(order.claimIds), 'Order links must be collections.')
    assert(Array.isArray(order.timeline), 'Order timeline must be a collection.')
    unique(order.paymentIds, `Order ${order.id} payment`)
    unique(order.boxIds, `Order ${order.id} box`)
    unique(order.claimIds, `Order ${order.id} claim`)
    assert(order.boxIds.length === order.snapshot.quantity, 'Order box count does not match quantity.')
    assert(order.paymentIds.every((id) => state.payments.some((payment) => payment.id === id && payment.orderId === order.id)), 'Order payment reference is invalid.')
    assert(order.boxIds.every((id) => state.boxes.some((box) => box.id === id && box.orderId === order.id && box.ownerId === order.userId)), 'Order box reference is invalid.')
    assert(order.claimIds.every((id) => state.claims.some((claim) => claim.id === id && claim.orderId === order.id)), 'Order claim reference is invalid.')
    assert(validIso(order.createdAt) && validIso(order.updatedAt) && validIso(order.reservationExpiresAt), 'Order time is invalid.')
    assert(timestamp(order.updatedAt) >= timestamp(order.createdAt), 'Order updated time cannot precede creation.')
    assert(timestamp(order.reservationExpiresAt) >= timestamp(order.createdAt), 'Order reservation cannot precede creation.')
    assert(
      order.timeline.length > 0 &&
        order.timeline[0].status === 'pending_payment' &&
        order.timeline.at(-1)?.status === order.status,
      'Order timeline must begin at pending payment and end at current status.',
    )
    assert(
      order.timeline.every((entry) =>
        ORDER_STATUSES.has(entry.status) &&
        validIso(entry.at) &&
        typeof entry.label === 'string' &&
        entry.label.length > 0 &&
        (!entry.financialHoldPreviousStatus ||
          (ORDER_STATUSES.has(entry.financialHoldPreviousStatus) && FINANCIAL_STOP.has(entry.status)))),
      'Order timeline entry is invalid.',
    )
    chronological(order.timeline.map((entry) => entry.at), `Order ${order.id} timeline`)
    assert(order.timeline[0].at === order.createdAt, 'Order timeline must begin at order creation.')
    assert(timestamp(order.timeline.at(-1)!.at) <= timestamp(order.updatedAt), 'Order timeline cannot end after its updated time.')
    changedStatusesAreLegal(order.timeline.map((entry) => entry.status), ORDER_TRANSITIONS, `Order ${order.id}`)
    validateOrderFulfilment(state, order.id)
  }

  for (const payment of state.payments) {
    assert(PAYMENT_STATUSES.has(payment.status), 'Payment status is invalid.')
    assert(PAYMENT_METHODS.has(payment.method as PaymentMethod), 'Payment method is invalid.')
    const order = state.orders.find((entry) => entry.id === payment.orderId)
    assert(order && order.userId === payment.userId && order.paymentIds.includes(payment.id), 'Payment cross-reference is invalid.')
    assert(integer(payment.attempt, 1) && integer(payment.amountSen, 1) && integer(payment.refundedSen), 'Payment counters are invalid.')
    assert(payment.amountSen === order.snapshot.totals.totalSen && payment.refundedSen <= payment.amountSen, 'Payment amount is inconsistent.')
    assert(validIso(payment.createdAt) && validIso(payment.updatedAt), 'Payment time is invalid.')
    assert(timestamp(payment.updatedAt) >= timestamp(payment.createdAt), 'Payment updated time cannot precede creation.')
    assert(Array.isArray(payment.events) && payment.events.length > 0, 'Payment event history is required.')
    assert(
      payment.events.every((event) =>
        PAYMENT_STATUSES.has(event.type) &&
        ['mock_webhook', 'admin_reconcile', 'reservation_clock'].includes(event.source) &&
        typeof event.requestId === 'string' &&
        event.requestId.length > 0 &&
        (event.ignoredReason === undefined || nonEmptyString(event.ignoredReason)) &&
        validIso(event.createdAt) &&
        validIso(event.processedAt)),
      'Payment event is invalid.',
    )
    for (const event of payment.events) {
      assert(timestamp(event.createdAt) >= timestamp(payment.createdAt), 'Payment event cannot precede payment creation.')
      assert(timestamp(event.processedAt) >= timestamp(event.createdAt), 'Payment processing cannot precede event creation.')
      if (event.refundIntent !== undefined) {
        assert(record(event.refundIntent), 'Refund intent must be a structured record.')
        assert(
          ['partially_refunded', 'refunded'].includes(event.type) &&
            event.source === 'admin_reconcile' &&
            event.refundIntent.paymentId === payment.id &&
            integer(event.refundIntent.amountSen, 1) &&
            event.refundIntent.amountSen <= payment.amountSen &&
            typeof event.refundIntent.reason === 'string' &&
            event.refundIntent.reason.length >= 8 &&
            event.refundIntent.reason.length <= 240 &&
            sanitizeText(event.refundIntent.reason, 240) === event.refundIntent.reason,
          'Refund intent is invalid.',
        )
      }
    }
    chronological(payment.events.map((event) => event.processedAt), `Payment ${payment.id} events`)
    const recordedRefundTotal = payment.events.reduce(
      (sum, event) => sum + (event.refundIntent?.amountSen ?? 0),
      0,
    )
    assert(
      recordedRefundTotal === payment.refundedSen,
      `Payment ${payment.id} refund intents must exactly explain its refunded amount.`,
    )
    assert(timestamp(payment.events.at(-1)!.processedAt) <= timestamp(payment.updatedAt), 'Payment events cannot end after its updated time.')
    assert(
      replayPaymentStatus(payment) === payment.status,
      `Payment ${payment.id} current status does not match its accepted event history.`,
    )
    const hasAcceptedPartialRefund = payment.events.some((event) =>
      event.type === 'partially_refunded' && !event.ignoredReason,
    )
    if (payment.status === 'refunded') {
      assert(payment.refundedSen === payment.amountSen, 'A refunded payment must be fully refunded.')
    } else if (payment.status === 'partially_refunded') {
      assert(payment.refundedSen > 0 && payment.refundedSen < payment.amountSen, 'A partial refund amount is invalid.')
    } else if (payment.status === 'disputed') {
      if (hasAcceptedPartialRefund) {
        assert(
          payment.refundedSen > 0 && payment.refundedSen < payment.amountSen,
          'A disputed payment must preserve its prior partial refund amount.',
        )
      } else {
        assert(payment.refundedSen === 0, 'A disputed payment cannot invent a refund without accepted history.')
      }
    } else {
      assert(payment.refundedSen === 0, 'A non-refund payment status must have a zero refunded amount.')
    }
  }
  unique(
    state.payments.flatMap((payment) => payment.events.map((event) => event.requestId)),
    'Payment event request',
  )
  for (const order of state.orders) {
    const payments = state.payments.filter((payment) => payment.orderId === order.id)
    unique(payments.map((payment) => String(payment.attempt)), `Order ${order.id} payment attempt`)
    const activePayments = payments.filter((payment) => ACTIVE_PAYMENT.has(payment.status))
    const capturedPayments = payments.filter(captured)
    assert(activePayments.length <= 1, 'An order has more than one active payment.')
    assert(capturedPayments.length <= 1, 'An order has more than one captured payment.')
    assert(
      activePayments.length === 0 || capturedPayments.length === 0,
      'An active payment attempt cannot coexist with a captured payment.',
    )
    if (order.status === 'pending_payment') {
      assert(capturedPayments.length === 0, 'A pending order cannot have a captured payment.')
    } else if (order.status === 'cancelled') {
      assert(
        capturedPayments.length === 0 && activePayments.length === 0,
        'A cancelled order cannot have a captured or active payment.',
      )
    } else if (NORMAL_PAID_ORDER_STATUSES.has(order.status)) {
      assert(
        capturedPayments.length === 1 &&
          NORMAL_CAPTURE_STATUSES.has(capturedPayments[0].status) &&
          activePayments.length === 0,
        'A normal paid order needs one settled captured payment and no active attempt.',
      )
    } else if (order.status === 'disputed') {
      assert(
        capturedPayments.length === 1 &&
          capturedPayments[0].status === 'disputed' &&
          activePayments.length === 0,
        'A disputed order must match one disputed captured payment.',
      )
    } else if (order.status === 'refunded') {
      assert(
        capturedPayments.length === 1 &&
          capturedPayments[0].status === 'refunded' &&
          activePayments.length === 0,
        'A refunded order must match one fully refunded captured payment.',
      )
    }
  }

  for (const box of state.boxes) {
    assert(BOX_STATUSES.has(box.status), 'Box status is invalid.')
    const order = state.orders.find((entry) => entry.id === box.orderId)
    const series = state.series.find((entry) => entry.id === box.seriesId)
    assert(order, 'Box order reference is invalid.')
    assert(order.boxIds.includes(box.id) && order.userId === box.ownerId, 'Box order or owner reference is invalid.')
    assert(series?.status === 'published', 'Box series reference is invalid.')
    assert(integer(box.number, 1), 'Box number is invalid.')
    if (box.prizeId) {
      assert(series.publishedPrizes?.some((prize) => prize.id === box.prizeId), 'Box prize is absent from the frozen series.')
      assert(validIso(box.assignedAt), 'Allocated box assignment time is invalid.')
      const captureTime = state.payments
        .filter((payment) => payment.orderId === order.id)
        .map(capturedAt)
        .find(Boolean)
      assert(captureTime, 'Allocated box requires a captured payment time.')
      assert(timestamp(box.assignedAt!) >= timestamp(order.createdAt), 'Box allocation cannot precede order creation.')
      assert(timestamp(box.assignedAt!) >= timestamp(captureTime), 'Box allocation cannot precede captured payment.')
    } else {
      assert(['reserved', 'void'].includes(box.status) && !box.assignedAt && !box.revealedAt, 'Unallocated box state is invalid.')
    }
    if (box.revealedAt) {
      assert(box.prizeId && validIso(box.revealedAt), 'Revealed box record is invalid.')
      assert(timestamp(box.revealedAt) >= timestamp(box.assignedAt!), 'Box reveal cannot precede assignment.')
      assert(
        !['reserved', 'paid_unopened', 'void'].includes(box.status),
        'A revealed box cannot remain reserved, paid unopened, or void.',
      )
    }
    if (box.status === 'opened') assert(box.revealedAt, 'An opened box requires a reveal time.')
    validateBoxShipment(state, box)
  }

  unique(state.boxes.map((box) => box.manifestId), 'Box manifest')
  unique(state.shipments.map((shipment) => shipment.trackingNumber), 'Shipment tracking')
  for (const shipment of state.shipments) {
    assert(SHIPMENT_STATUSES.has(shipment.status) && FULFILMENT_KINDS.has(shipment.kind), 'Shipment status or kind is invalid.')
    const order = state.orders.find((entry) => entry.id === shipment.orderId)
    assert(order, 'Shipment order reference is invalid.')
    assert(Array.isArray(shipment.boxIds) && Array.isArray(shipment.timeline), 'Shipment links and timeline must be collections.')
    unique(shipment.boxIds, `Shipment ${shipment.id} box`)
    assert(shipment.boxIds.length > 0, 'Shipment must contain a box.')
    assert(shipment.boxIds.every((id) => state.boxes.some((box) => box.id === id && box.shipmentId === shipment.id && box.orderId === order.id)), 'Shipment box reference is invalid.')
    const linkedPrizes = shipment.boxIds.map((boxId) => {
      const box = state.boxes.find((entry) => entry.id === boxId)!
      const series = state.series.find((entry) => entry.id === box.seriesId)
      return series?.publishedPrizes?.find((prize) => prize.id === box.prizeId)
    })
    assert(linkedPrizes.every(Boolean), 'Shipment linked prize reference is invalid.')
    assert(
      linkedPrizes.every((prize) =>
        shipment.kind === (
          order.snapshot.shippingMethod === 'self_collect'
            ? 'SELF_COLLECT'
            : prize!.fulfilment
        )),
      'Shipment kind must match its linked prizes and order shipping method.',
    )
    assert(
      shipment.insured === linkedPrizes.some((prize) => prize!.insured) &&
        shipment.signatureRequired === linkedPrizes.some((prize) => prize!.signatureRequired),
      'Shipment insurance and signature flags must match linked prize requirements.',
    )
    assert(isClearlyFictionalCarrier(shipment.carrier), 'Shipment carrier must remain clearly fictional.')
    assert(isValidDemoTracking(shipment.trackingNumber), 'Shipment tracking must remain a valid DEMO- code.')
    assert(validIso(shipment.createdAt), 'Shipment time is invalid.')
    assert(shipment.timeline.length > 0 && shipment.timeline[0].status === 'unfulfilled' && shipment.timeline.at(-1)?.status === shipment.status, 'Shipment timeline is incomplete.')
    assert(
      shipment.timeline.every((entry) =>
        SHIPMENT_STATUSES.has(entry.status) &&
        validIso(entry.at) &&
        typeof entry.label === 'string' &&
        entry.label.length > 0 &&
        (!entry.financialHold || (FINANCIAL_STOP.has(entry.financialHold) && entry.status === 'cancelled'))),
      'Shipment timeline entry is invalid.',
    )
    chronological(shipment.timeline.map((entry) => entry.at), `Shipment ${shipment.id} timeline`)
    assert(shipment.timeline[0].at === shipment.createdAt, 'Shipment timeline must begin at shipment creation.')
    for (const boxId of shipment.boxIds) {
      const box = state.boxes.find((entry) => entry.id === boxId)!
      assert(timestamp(shipment.createdAt) >= timestamp(box.assignedAt!), 'Shipment cannot precede paid box allocation.')
    }
    const captureTime = state.payments
      .filter((payment) => payment.orderId === order.id)
      .map(capturedAt)
      .find(Boolean)
    assert(captureTime && timestamp(shipment.createdAt) >= timestamp(captureTime), 'Shipment cannot precede captured payment.')
    changedStatusesAreLegal(shipment.timeline.map((entry) => entry.status), SHIPMENT_TRANSITIONS, `Shipment ${shipment.id}`)
  }

  unique(state.claims.map((claim) => claim.requestId), 'Claim request')
  for (const claim of state.claims) {
    assert(CLAIM_KINDS.has(claim.kind) && CLAIM_STATUSES.has(claim.status), 'Claim kind or status is invalid.')
    const order = state.orders.find((entry) => entry.id === claim.orderId)
    assert(order?.userId === claim.userId && order.claimIds.includes(claim.id), 'Claim order reference is invalid.')
    assert(customerClaimNoteIsSafe(claim.note), 'Customer claim note must be fictional and include DEMO without email or phone data.')
    assert(validIso(claim.createdAt) && validIso(claim.updatedAt), 'Claim time is invalid.')
    assert(timestamp(claim.createdAt) >= timestamp(order.createdAt), 'Claim cannot precede its order.')
    assert(timestamp(claim.updatedAt) >= timestamp(claim.createdAt), 'Claim updated time cannot precede creation.')
    assert(Array.isArray(claim.history) && claim.history.length > 0 && claim.history[0].status === 'submitted' && claim.history.at(-1)?.status === claim.status, 'Claim history must start submitted and end at current status.')
    assert(
      claim.history.every((entry) =>
        CLAIM_STATUSES.has(entry.status) &&
        ROLES.includes(entry.actorRole) &&
        validIso(entry.at) &&
        typeof entry.note === 'string' &&
        entry.note.length > 0),
      'Claim history entry is invalid.',
    )
    chronological(claim.history.map((entry) => entry.at), `Claim ${claim.id} history`)
    assert(claim.history[0].at === claim.createdAt, 'Claim history must begin at claim creation.')
    assert(
      claim.history[0].actorId === claim.userId &&
        claim.history[0].actorRole === 'customer' &&
        claim.history[0].note === claim.note,
      'Claim submission history must preserve the customer note.',
    )
    assert(timestamp(claim.history.at(-1)!.at) <= timestamp(claim.updatedAt), 'Claim history cannot end after its updated time.')
    changedStatusesAreLegal(claim.history.map((entry) => entry.status), CLAIM_TRANSITIONS, `Claim ${claim.id}`)
    const hasBoxLink = claim.boxId !== undefined
    const hasExactShipmentLink = claim.shipmentId !== undefined
    const hasOrderLevelCandidates = claim.shipmentCandidateIds !== undefined
    assert(
      Number(hasBoxLink) + Number(hasExactShipmentLink) + Number(hasOrderLevelCandidates) === 1,
      'Claim evidence must use exactly one box, exact shipment, or order-level candidate set.',
    )
    if (claim.kind === 'value_floor') {
      assert(hasBoxLink && !hasExactShipmentLink && !hasOrderLevelCandidates, 'Value-floor claim link is invalid.')
      assert(
        claim.shipmentCandidateEvidenceAt === undefined,
        'Value-floor claims cannot store shipment candidate evidence.',
      )
      const box = state.boxes.find((entry) => entry.id === claim.boxId && entry.orderId === claim.orderId && entry.ownerId === claim.userId)
      assert(box?.prizeId && validIso(box.assignedAt), 'Value-floor claim requires an assigned box.')
      assert(
        valueFloorClaimEligibility(box, claim.createdAt).eligible,
        'Value-floor claim requires an assigned box revealed by claim creation.',
      )
    } else if (hasExactShipmentLink) {
      assert(!hasBoxLink && !hasOrderLevelCandidates, 'Exact shipment claim link is invalid.')
      assert(
        claim.shipmentCandidateEvidenceAt === undefined,
        'Exact shipment claims cannot store order-level candidate evidence.',
      )
      assert(
        everyOrderBoxRevealedAt(state, claim.orderId, claim.createdAt),
        'Exact shipment claims require every order box to be revealed by claim creation.',
      )
      const shipment = state.shipments.find((entry) => entry.id === claim.shipmentId && entry.orderId === claim.orderId)
      assert(shipment, 'Claim shipment reference is invalid.')
      assert(
        shipmentClaimEligibility(shipment, claim.kind, claim.createdAt).eligible,
        claim.kind === 'damage'
          ? 'Damage claim requires physical delivery by claim creation.'
          : 'Non-delivery claim requires eligible evidence at claim creation.',
      )
    } else {
      const deliveryKind = claim.kind as Extract<ClaimKind, 'damage' | 'non_delivery'>
      assert(
        !hasBoxLink && !hasExactShipmentLink && Array.isArray(claim.shipmentCandidateIds),
        'Order-level shipment candidate link is invalid.',
      )
      assert(
        !everyOrderBoxRevealedAt(state, claim.orderId, claim.createdAt),
        'Order-level delivery evidence requires at least one sealed box at claim creation.',
      )
      assert(claim.shipmentCandidateIds.length > 0, 'Order-level shipment candidates cannot be empty.')
      unique(claim.shipmentCandidateIds, `Claim ${claim.id} shipment candidate`)
      const canonicalCandidates = [...claim.shipmentCandidateIds].sort((left, right) => left.localeCompare(right))
      assert(
        JSON.stringify(claim.shipmentCandidateIds) === JSON.stringify(canonicalCandidates),
        'Order-level shipment candidates must use canonical order.',
      )
      if (claim.shipmentCandidateEvidenceAt === undefined) {
        assert(
          JSON.stringify(claim.shipmentCandidateIds) ===
            JSON.stringify(eligibleClaimShipmentIds(
              state,
              claim.orderId,
              deliveryKind,
              claim.createdAt,
            )),
          'Order-level shipment candidates must canonically include every eligible physical shipment.',
        )
      } else {
        assert(
          record(claim.shipmentCandidateEvidenceAt),
          'Order-level shipment candidate evidence must be a record.',
        )
        const evidenceKeys = Object.keys(claim.shipmentCandidateEvidenceAt)
          .sort((left, right) => left.localeCompare(right))
        assert(
          JSON.stringify(evidenceKeys) === JSON.stringify(canonicalCandidates),
          'Order-level shipment candidate evidence must exactly match its candidates.',
        )
        const evidenceTimes = [...new Set(canonicalCandidates.map((shipmentId) => {
          const evidenceAt = claim.shipmentCandidateEvidenceAt![shipmentId]
          assert(validIso(evidenceAt), 'Order-level shipment candidate evidence time is invalid.')
          assert(
            timestamp(evidenceAt) >= timestamp(claim.createdAt) &&
              timestamp(evidenceAt) <= timestamp(claim.updatedAt),
            'Order-level shipment candidate evidence time is outside the claim history.',
          )
          const shipment = state.shipments.find((entry) =>
            entry.id === shipmentId && entry.orderId === claim.orderId)
          assert(
            shipment && shipmentClaimEligibility(shipment, deliveryKind, evidenceAt).eligible,
            'Every order-level shipment candidate must belong to the order and be eligible at its evidence time.',
          )
          return evidenceAt
        }))].sort((left, right) => left.localeCompare(right))
        const initialCandidates = canonicalCandidates.filter((shipmentId) =>
          claim.shipmentCandidateEvidenceAt![shipmentId] === claim.createdAt)
        assert(
          initialCandidates.length > 0 &&
            JSON.stringify(initialCandidates) ===
              JSON.stringify(eligibleClaimShipmentIds(
                state,
                claim.orderId,
                deliveryKind,
                claim.createdAt,
              )),
          'Mapped order-level evidence must preserve the exact nonempty candidate set from claim creation.',
        )
        const accumulatedCandidates = new Set<string>()
        for (const evidenceAt of evidenceTimes) {
          eligibleClaimShipmentIds(state, claim.orderId, deliveryKind, evidenceAt)
            .forEach((shipmentId) => accumulatedCandidates.add(shipmentId))
          if (evidenceAt === claim.createdAt) continue
          const beforeCandidateIds = canonicalCandidates.filter((shipmentId) =>
            timestamp(claim.shipmentCandidateEvidenceAt![shipmentId]) < timestamp(evidenceAt))
          const afterCandidateIds = canonicalCandidates.filter((shipmentId) =>
            timestamp(claim.shipmentCandidateEvidenceAt![shipmentId]) <= timestamp(evidenceAt))
          const widenedAt = state.audits.some((audit) => {
            const before = audit.before
            const after = audit.after
            if (
              audit.action !== 'claim.order_level_evidence_widened' ||
              audit.targetType !== 'claim' ||
              audit.targetId !== claim.id ||
              audit.actorId !== claim.userId ||
              audit.actorRole !== 'customer' ||
              audit.at !== evidenceAt ||
              audit.reason !== CLAIM_EVIDENCE_WIDENING_NOTE ||
              !record(before) ||
              !record(after) ||
              !Array.isArray(before.shipmentCandidateIds) ||
              !Array.isArray(after.shipmentCandidateIds)
            ) return false
            return (
              JSON.stringify(before.shipmentCandidateIds) ===
                JSON.stringify(beforeCandidateIds) &&
              JSON.stringify(after.shipmentCandidateIds) ===
                JSON.stringify(afterCandidateIds)
            )
          })
          assert(
            widenedAt,
            'Widened order-level shipment candidate evidence requires a matching customer audit.',
          )
          const wideningHistoryIndex = claim.history.findIndex((entry, index) =>
            index > 0 &&
            entry.at === evidenceAt &&
            entry.actorId === claim.userId &&
            entry.actorRole === 'customer' &&
            entry.note === CLAIM_EVIDENCE_WIDENING_NOTE &&
            canWidenClaimEvidence(entry.status) &&
            claim.history[index - 1].status === entry.status)
          assert(
            wideningHistoryIndex > 0,
            'Widened order-level shipment candidate evidence requires matching unchanged-status customer history.',
          )
        }
        assert(
          JSON.stringify([...accumulatedCandidates].sort((left, right) => left.localeCompare(right))) ===
            JSON.stringify(canonicalCandidates),
          'Order-level shipment candidates must preserve the canonical union of eligible evidence snapshots.',
        )
      }
    }
    if (claim.shipmentId) assert(state.shipments.some((shipment) => shipment.id === claim.shipmentId && shipment.orderId === claim.orderId), 'Claim shipment reference is invalid.')
    if (claim.boxId) assert(state.boxes.some((box) => box.id === claim.boxId && box.orderId === claim.orderId && box.ownerId === claim.userId), 'Claim box reference is invalid.')
    if (claim.status === 'resolved') {
      assert(
        CLAIM_RESOLUTION_OUTCOMES.has(claim.resolutionOutcome as ClaimResolutionOutcome) &&
          nonEmptyString(claim.resolutionReference) &&
          nonEmptyString(claim.resolutionNote),
        'Resolved claims require structured outcome, reference, and note evidence.',
      )
      if (claim.resolutionOutcome === 'refund_recorded') {
        const payment = state.payments.find((entry) =>
          entry.orderId === claim.orderId &&
          entry.events.some((event) =>
            event.id === claim.resolutionReference &&
            !event.ignoredReason &&
            Boolean(event.refundIntent) &&
            ['partially_refunded', 'refunded'].includes(event.type),
          ),
        )
        assert(
          payment &&
            state.audits.some((audit) =>
              audit.targetType === 'payment' &&
              audit.targetId === payment.id &&
              audit.eventId === claim.resolutionReference &&
              ['payment.partially_refunded', 'payment.refunded'].includes(audit.action),
            ),
          'Refund-recorded resolution must reference an audited refund event on the claim order.',
        )
      } else {
        assert(
          /^DEMO-[A-Z0-9][A-Z0-9-]{2,96}$/.test(claim.resolutionReference!) &&
            claim.resolutionNote!.length >= 16,
          'Non-refund resolutions require a descriptive note and fictional DEMO- reference.',
        )
      }
    } else {
      assert(
        claim.resolutionOutcome === undefined && claim.resolutionReference === undefined,
        'Only resolved claims may store structured resolution evidence.',
      )
    }
  }
  const openClaims = state.claims.filter((claim) => isOpenClaimStatus(claim.status))
  unique(
    openClaims.map((claim) => {
      const scope = claim.kind === 'value_floor'
        ? `box:${claim.boxId}`
        : claim.shipmentCandidateIds
          ? 'order-level'
          : `shipment:${claim.shipmentId}`
      return `${claim.orderId}:${claim.kind}:${scope}`
    }),
    'Open claim',
  )
  for (let leftIndex = 0; leftIndex < openClaims.length; leftIndex += 1) {
    const left = openClaims[leftIndex]
    if (left.kind === 'value_floor') continue
    const leftTargets = left.shipmentCandidateIds ?? (left.shipmentId ? [left.shipmentId] : [])
    for (const right of openClaims.slice(leftIndex + 1)) {
      if (right.orderId !== left.orderId || right.kind !== left.kind) continue
      const rightTargets = right.shipmentCandidateIds ?? (right.shipmentId ? [right.shipmentId] : [])
      assert(
        !leftTargets.some((shipmentId) => rightTargets.includes(shipmentId)),
        'Open claim shipment evidence scopes cannot overlap.',
      )
    }
  }

  for (const [index, audit] of state.audits.entries()) {
    const expectedSequence = index + 1
    assert(
      audit.sequence === expectedSequence,
      'Audit sequence must be contiguous and begin at one.',
    )
    assert(
      expectedSequence === 1
        ? audit.previousId === undefined
        : audit.previousId === state.audits[index - 1].id,
      'Audit previous link must reference the immediately preceding entry.',
    )
    assert(AUDIT_OUTCOMES.has(audit.outcome), 'Audit outcome is invalid.')
    assert(
      normalizedText(audit.id, 120) &&
        normalizedText(audit.actorId, 120) &&
        normalizedText(audit.action, 120) &&
        normalizedText(audit.targetType, 80) &&
        normalizedText(audit.targetId, 120) &&
        normalizedText(audit.reason, 500) &&
        normalizedText(audit.requestId, 120) &&
        (audit.eventId === undefined || normalizedText(audit.eventId, 120)),
      'Audit text fields must be nonempty, bounded, and normalized.',
    )
    assert(ROLES.includes(audit.actorRole) && validIso(audit.at), 'Audit actor or time is invalid.')
    if (Object.prototype.hasOwnProperty.call(audit, 'before')) {
      validateCanonicalAuditEvidence(audit.before, `Audit ${audit.id} before evidence`)
    }
    if (Object.prototype.hasOwnProperty.call(audit, 'after')) {
      validateCanonicalAuditEvidence(audit.after, `Audit ${audit.id} after evidence`)
    }
  }
}

export function isDemoState(value: unknown): value is DemoState {
  try {
    validateDemoState(value)
    return true
  } catch {
    return false
  }
}
