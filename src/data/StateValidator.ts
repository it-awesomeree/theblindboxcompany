import {
  ADMIN_ROLES,
  BOX_PRICE_SEN,
  BOX_TRANSITIONS,
  MAX_CART_QUANTITY,
  ORDER_TRANSITIONS,
  PAYMENT_TRANSITIONS,
  SCHEMA_VERSION,
  SHIPMENT_TRANSITIONS,
} from '../domain/constants'
import { assert, CHECKOUT_REQUEST_ID_PATTERN } from '../domain/guards'
import type {
  Box,
  BoxStatus,
  ClaimKind,
  ClaimStatus,
  DemoState,
  FulfilmentKind,
  OrderStatus,
  Payment,
  PaymentStatus,
  Role,
  SeriesStatus,
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
const SERIES_STATUSES = new Set<SeriesStatus>(['draft', 'published'])
const FULFILMENT_KINDS = new Set<FulfilmentKind>(['PARCEL', 'BULKY', 'DIGITAL', 'SELF_COLLECT'])
const CLAIM_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  submitted: ['reviewing', 'rejected'],
  reviewing: ['approved', 'rejected'],
  approved: ['resolved'],
  rejected: [],
  resolved: [],
}

function integer(value: unknown, minimum = 0) {
  return Number.isInteger(value) && Number(value) >= minimum
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
  const delivered = shipments.filter((shipment) => shipment.status === 'delivered').length
  const advanced = shipments.some((shipment) => shipment.status !== 'unfulfilled')
  if (order.status === 'confirmed') {
    assert(shipments.every((shipment) => shipment.status === 'unfulfilled'), 'A confirmed order cannot contain advanced fulfilment.')
  } else if (order.status === 'processing') {
    assert(advanced && delivered < shipments.length, 'A processing order needs an active, incomplete shipment.')
  } else if (order.status === 'partially_fulfilled') {
    assert(delivered > 0 && delivered < shipments.length, 'A partially fulfilled order needs both delivered and incomplete shipments.')
  } else if (order.status === 'fulfilled' || order.status === 'closed') {
    assert(delivered === shipments.length, 'A fulfilled order requires every shipment to be delivered.')
  }
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
    assert(validIso(user.createdAt), 'User time is invalid.')
  }

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
          integer(prize.valueSen, BOX_PRICE_SEN) &&
          integer(prize.allocation, 1) &&
          typeof prize.name === 'string' &&
          prize.name.length > 0 &&
          FULFILMENT_KINDS.has(prize.fulfilment)),
        'Published prize counters are invalid.',
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
      assert(Array.isArray(series.draftPrizes), 'Draft prize definitions are required.')
    }
  }

  unique(state.cart.map((item) => item.seriesId), 'Cart series')
  for (const item of state.cart) {
    assert(integer(item.quantity, 1) && item.quantity <= MAX_CART_QUANTITY, 'Cart quantity is invalid.')
    assert(integer(item.unitPriceSen, 1), 'Cart price must use positive integer sen.')
    assert(state.series.some((series) => series.id === item.seriesId && series.status === 'published'), 'Cart series is invalid.')
  }

  for (const order of state.orders) {
    assert(ORDER_STATUSES.has(order.status), 'Order status is invalid.')
    assert(CHECKOUT_REQUEST_ID_PATTERN.test(order.checkoutRequestId), 'Checkout request identity is invalid.')
    assert(state.users.some((user) => user.id === order.userId && user.role === 'customer'), 'Order user reference is invalid.')
    assert(state.series.some((series) => series.id === order.snapshot.seriesId && series.status === 'published'), 'Order series reference is invalid.')
    assert(integer(order.snapshot.quantity, 1), 'Order quantity is invalid.')
    assert(
      [order.snapshot.unitPriceSen, order.snapshot.totals.itemSubtotalSen, order.snapshot.totals.shippingSen, order.snapshot.totals.totalSen]
        .every((amount) => integer(amount)),
      'Order money must use integer sen.',
    )
    assert(
      order.snapshot.totals.itemSubtotalSen + order.snapshot.totals.shippingSen === order.snapshot.totals.totalSen,
      'Order total is inconsistent.',
    )
    assert(
      order.snapshot.unitPriceSen * order.snapshot.quantity === order.snapshot.totals.itemSubtotalSen,
      'Order subtotal is inconsistent.',
    )
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
    assert(order.timeline.length > 0 && order.timeline.at(-1)?.status === order.status, 'Order timeline must end at current status.')
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
    const order = state.orders.find((entry) => entry.id === payment.orderId)
    assert(order && order.userId === payment.userId && order.paymentIds.includes(payment.id), 'Payment cross-reference is invalid.')
    assert(integer(payment.attempt, 1) && integer(payment.amountSen, 1) && integer(payment.refundedSen), 'Payment counters are invalid.')
    assert(payment.amountSen === order.snapshot.totals.totalSen && payment.refundedSen <= payment.amountSen, 'Payment amount is inconsistent.')
    assert(validIso(payment.createdAt) && validIso(payment.updatedAt), 'Payment time is invalid.')
    assert(timestamp(payment.updatedAt) >= timestamp(payment.createdAt), 'Payment updated time cannot precede creation.')
    assert(payment.events.length > 0, 'Payment event history is required.')
    assert(
      payment.events.every((event) =>
        PAYMENT_STATUSES.has(event.type) &&
        ['mock_webhook', 'admin_reconcile', 'reservation_clock'].includes(event.source) &&
        typeof event.requestId === 'string' &&
        event.requestId.length > 0 &&
        validIso(event.createdAt) &&
        validIso(event.processedAt)),
      'Payment event is invalid.',
    )
    for (const event of payment.events) {
      assert(timestamp(event.createdAt) >= timestamp(payment.createdAt), 'Payment event cannot precede payment creation.')
      assert(timestamp(event.processedAt) >= timestamp(event.createdAt), 'Payment processing cannot precede event creation.')
    }
    chronological(payment.events.map((event) => event.processedAt), `Payment ${payment.id} events`)
    assert(timestamp(payment.events.at(-1)!.processedAt) <= timestamp(payment.updatedAt), 'Payment events cannot end after its updated time.')
    const successfulState = ['succeeded', 'partially_refunded', 'refunded', 'disputed'].includes(payment.status)
    assert(!successfulState || captured(payment), 'Captured payment state requires a successful event.')
    if (payment.status === 'refunded') assert(payment.refundedSen === payment.amountSen, 'A refunded payment must be fully refunded.')
    if (payment.status === 'partially_refunded') {
      assert(payment.refundedSen > 0 && payment.refundedSen < payment.amountSen, 'A partial refund amount is invalid.')
    }
  }
  for (const order of state.orders) {
    const payments = state.payments.filter((payment) => payment.orderId === order.id)
    unique(payments.map((payment) => String(payment.attempt)), `Order ${order.id} payment attempt`)
    assert(payments.filter((payment) => ACTIVE_PAYMENT.has(payment.status)).length <= 1, 'An order has more than one active payment.')
    const captureCount = payments.filter(captured).length
    assert(captureCount <= 1, 'An order has more than one captured payment.')
    if (order.status === 'pending_payment') assert(captureCount === 0, 'A pending order cannot have a captured payment.')
    if (!['pending_payment', 'cancelled'].includes(order.status)) {
      assert(captureCount === 1, 'A paid order needs exactly one captured payment.')
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
    }
    validateBoxShipment(state, box)
  }

  unique(state.shipments.map((shipment) => shipment.trackingNumber), 'Shipment tracking')
  for (const shipment of state.shipments) {
    assert(SHIPMENT_STATUSES.has(shipment.status) && FULFILMENT_KINDS.has(shipment.kind), 'Shipment status or kind is invalid.')
    const order = state.orders.find((entry) => entry.id === shipment.orderId)
    assert(order, 'Shipment order reference is invalid.')
    unique(shipment.boxIds, `Shipment ${shipment.id} box`)
    assert(shipment.boxIds.length > 0, 'Shipment must contain a box.')
    assert(shipment.boxIds.every((id) => state.boxes.some((box) => box.id === id && box.shipmentId === shipment.id && box.orderId === order.id)), 'Shipment box reference is invalid.')
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
    assert(validIso(claim.createdAt) && validIso(claim.updatedAt), 'Claim time is invalid.')
    assert(timestamp(claim.updatedAt) >= timestamp(claim.createdAt), 'Claim updated time cannot precede creation.')
    assert(claim.history.length > 0 && claim.history[0].status === 'submitted' && claim.history.at(-1)?.status === claim.status, 'Claim history must start submitted and end at current status.')
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
    assert(timestamp(claim.history.at(-1)!.at) <= timestamp(claim.updatedAt), 'Claim history cannot end after its updated time.')
    changedStatusesAreLegal(claim.history.map((entry) => entry.status), CLAIM_TRANSITIONS, `Claim ${claim.id}`)
    if (claim.kind === 'value_floor') {
      assert(!claim.shipmentId && claim.boxId, 'Value-floor claim link is invalid.')
    } else {
      assert(claim.shipmentId && !claim.boxId, 'Shipment claim link is invalid.')
    }
    if (claim.shipmentId) assert(state.shipments.some((shipment) => shipment.id === claim.shipmentId && shipment.orderId === claim.orderId), 'Claim shipment reference is invalid.')
    if (claim.boxId) assert(state.boxes.some((box) => box.id === claim.boxId && box.orderId === claim.orderId && box.ownerId === claim.userId), 'Claim box reference is invalid.')
  }
  const openClaims = state.claims.filter((claim) => ['submitted', 'reviewing', 'approved'].includes(claim.status))
  unique(
    openClaims.map((claim) => `${claim.orderId}:${claim.kind}:${claim.kind === 'value_floor' ? claim.boxId : claim.shipmentId}`),
    'Open claim',
  )

  for (const audit of state.audits) {
    assert(ROLES.includes(audit.actorRole) && validIso(audit.at), 'Audit actor or time is invalid.')
    assert(typeof audit.requestId === 'string' && audit.requestId.length > 0, 'Audit request identity is invalid.')
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
