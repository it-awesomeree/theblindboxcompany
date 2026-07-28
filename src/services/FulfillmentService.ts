import {
  assert,
  assertRole,
  getSessionUser,
  makeId,
  sanitizeText,
  transitionOrder,
  transitionBoxForShipment,
  transitionShipment,
} from '../domain/guards'
import { prizeForBox } from '../domain/selectors'
import type { DemoState, FulfilmentKind, Order, Shipment, ShipmentStatus } from '../domain/types'
import type { MockRepository } from '../data/MockRepository'
import { AuditService } from './AuditService'

const carrierFor = (kind: FulfilmentKind) => {
  if (kind === 'DIGITAL') return 'Digital Vault'
  if (kind === 'BULKY') return 'Demo Bulky Freight'
  if (kind === 'SELF_COLLECT') return 'Vault Counter'
  return 'Demo Express'
}

export class FulfillmentService {
  constructor(
    private readonly repository: MockRepository,
    private readonly audit: AuditService,
    private readonly now: () => string,
  ) {}

  createForPaidOrder(state: DemoState, order: Order, at: string) {
    if (state.shipments.some((shipment) => shipment.orderId === order.id)) {
      return state.shipments.filter((shipment) => shipment.orderId === order.id)
    }
    const grouped = new Map<FulfilmentKind, string[]>()
    for (const boxId of order.boxIds) {
      const box = state.boxes.find((entry) => entry.id === boxId)
      const prize = prizeForBox(state, box)
      assert(box && prize, 'Paid box allocation is incomplete.', 'ALLOCATION_MISSING')
      const kind: FulfilmentKind = order.snapshot.shippingMethod === 'self_collect' ? 'SELF_COLLECT' : prize.fulfilment
      grouped.set(kind, [...(grouped.get(kind) ?? []), boxId])
    }
    const shipments: Shipment[] = []
    let index = 0
    for (const [kind, boxIds] of grouped) {
      index += 1
      const shipmentId = makeId('shp', `${order.id}:${kind}:${index}`)
      const shipmentPrizes = boxIds.map((id) => prizeForBox(state, state.boxes.find((box) => box.id === id))!)
      const shipment: Shipment = {
        id: shipmentId,
        orderId: order.id,
        boxIds,
        kind,
        status: 'unfulfilled',
        carrier: carrierFor(kind),
        trackingNumber: `DEMO-${shipmentId.slice(-8).toUpperCase()}`,
        insured: shipmentPrizes.some((prize) => prize.insured),
        signatureRequired: shipmentPrizes.some((prize) => prize.signatureRequired),
        createdAt: at,
        timeline: [{ id: makeId('stl', `${shipmentId}:queued`), status: 'unfulfilled', label: `${kind} fulfilment queued`, at }],
      }
      state.shipments.push(shipment)
      boxIds.forEach((id) => {
        const box = state.boxes.find((entry) => entry.id === id)
        if (box) box.shipmentId = shipmentId
      })
      shipments.push(shipment)
    }
    return shipments
  }

  advance(shipmentId: string, next: ShipmentStatus, reason: string) {
    return this.repository.update((state) => {
      const actor = getSessionUser(state)
      assertRole(actor, ['fulfilment', 'admin', 'super_admin'], 'change fulfilment')
      const shipment = state.shipments.find((entry) => entry.id === shipmentId)
      assert(shipment, 'Shipment was not found.', 'SHIPMENT_MISSING')
      const order = state.orders.find((entry) => entry.id === shipment.orderId)
      assert(order, 'Shipment order was not found.', 'ORDER_MISSING')
      assert(
        !['cancelled', 'refunded', 'disputed'].includes(order.status),
        `Fulfilment is stopped while the order is ${order.status}.`,
        'FINANCIAL_HOLD',
      )
      const cleanReason = sanitizeText(reason, 220)
      assert(cleanReason.length >= 6, 'Give a short reason for this shipment change.', 'REASON_REQUIRED')
      const before = shipment.status
      shipment.status = transitionShipment(shipment.status, next)
      const now = this.now()
      const sequence = state.nextSequence
      state.nextSequence += 1
      shipment.timeline.push({
        id: makeId('stl', `${shipment.id}:${next}:${now}:${sequence}`),
        status: next,
        label: cleanReason,
        at: now,
      })
      for (const boxId of shipment.boxIds) {
        const box = state.boxes.find((entry) => entry.id === boxId)
        if (!box) continue
        box.status = transitionBoxForShipment(box.status, next)
      }
      const related = state.shipments.filter((entry) => entry.orderId === order.id)
      const delivered = related.filter((entry) => entry.status === 'delivered').length
      const advanced = related.some((entry) => entry.status !== 'unfulfilled')
      const derived = delivered === related.length && related.length > 0
        ? 'fulfilled'
        : delivered > 0
          ? 'partially_fulfilled'
          : advanced
            ? 'processing'
            : 'confirmed'
      if (order.status !== derived) {
        order.status = transitionOrder(order.status, derived)
      }
      order.updatedAt = now
      order.timeline.push({
        id: makeId('tl', `${order.id}:${shipment.id}:${next}:${now}:${sequence}`),
        status: order.status,
        label: cleanReason,
        at: now,
      })
      this.audit.append(state, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'shipment.transitioned',
        targetType: 'shipment',
        targetId: shipment.id,
        reason: cleanReason,
        at: now,
        requestId: makeId('req', `${shipment.id}:${next}:${now}:${sequence}`),
        before: { status: before },
        after: { status: next },
      })
      return shipment
    })
  }

  setTracking(shipmentId: string, carrier: string, trackingNumber: string, reason: string) {
    return this.repository.update((state) => {
      const actor = getSessionUser(state)
      assertRole(actor, ['fulfilment', 'admin', 'super_admin'], 'edit carrier and tracking')
      const shipment = state.shipments.find((entry) => entry.id === shipmentId)
      assert(shipment, 'Shipment was not found.', 'SHIPMENT_MISSING')
      const order = state.orders.find((entry) => entry.id === shipment.orderId)
      assert(
        order && !['cancelled', 'refunded', 'disputed'].includes(order.status),
        'Tracking cannot change while the order is on financial hold.',
        'FINANCIAL_HOLD',
      )
      assert(
        ['unfulfilled', 'picking', 'packed', 'label_created'].includes(shipment.status),
        'Carrier and tracking lock after shipment.',
        'TRACKING_LOCKED',
      )
      const cleanCarrier = sanitizeText(carrier, 70)
      const cleanTracking = sanitizeText(trackingNumber, 48).toUpperCase()
      const cleanReason = sanitizeText(reason, 220)
      assert(cleanCarrier.length >= 3, 'Enter a fictional carrier name.', 'INVALID_CARRIER')
      assert(
        /demo|digital vault|vault counter/i.test(cleanCarrier),
        'Use a clearly fictional carrier containing Demo, Digital Vault, or Vault Counter.',
        'DEMO_DATA_ONLY',
      )
      assert(/^DEMO-[A-Z0-9][A-Z0-9-]{2,42}$/.test(cleanTracking), 'Tracking must be a fictional DEMO- code.', 'DEMO_DATA_ONLY')
      assert(cleanReason.length >= 6, 'Give a short reason for the tracking change.', 'REASON_REQUIRED')
      assert(
        !state.shipments.some((entry) => entry.id !== shipment.id && entry.trackingNumber === cleanTracking),
        'That fictional tracking code is already in use.',
        'TRACKING_DUPLICATE',
      )
      assert(
        shipment.carrier !== cleanCarrier || shipment.trackingNumber !== cleanTracking,
        'Carrier and tracking are unchanged.',
        'NO_CHANGE',
      )
      const before = { carrier: shipment.carrier, trackingNumber: shipment.trackingNumber }
      shipment.carrier = cleanCarrier
      shipment.trackingNumber = cleanTracking
      const now = this.now()
      this.audit.append(state, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'shipment.tracking_updated',
        targetType: 'shipment',
        targetId: shipment.id,
        reason: cleanReason,
        at: now,
        requestId: makeId('req', `${shipment.id}:tracking:${now}`),
        before,
        after: { carrier: shipment.carrier, trackingNumber: shipment.trackingNumber },
      })
      return shipment
    })
  }
}
