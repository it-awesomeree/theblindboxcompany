import {
  assert,
  assertRole,
  getSessionUser,
  isClearlyFictionalCarrier,
  isValidDemoTracking,
  makeId,
  sanitizeText,
  transitionShipmentForKind,
} from '../domain/guards'
import {
  shipmentStatusActionEligibility,
  shipmentTrackingActionEligibility,
} from '../domain/fulfillmentEligibility'
import { prizeForBox } from '../domain/selectors'
import { refreshOrderFulfillment } from '../domain/orderFulfillment'
import { REPLACEMENT_DELIVERED_ACTION } from '../domain/remedyEvidence'
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
    if (state.shipments.some((shipment) =>
      shipment.orderId === order.id && shipment.purpose === 'original')) {
      return state.shipments.filter((shipment) =>
        shipment.orderId === order.id && shipment.purpose === 'original')
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
        purpose: 'original',
        status: 'unfulfilled',
        carrier: carrierFor(kind),
        trackingNumber: `DEMO-${shipmentId.slice(4).toUpperCase()}`,
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
      const eligibility = shipmentStatusActionEligibility(order.status, shipment, next)
      assert(eligibility.eligible, eligibility.reason, eligibility.code)
      const financiallyStopped = ['cancelled', 'refunded', 'disputed'].includes(order.status)
      const cleanReason = sanitizeText(reason, 220)
      assert(cleanReason.length >= 6, 'Give a short reason for this shipment change.', 'REASON_REQUIRED')
      const before = shipment.status
      shipment.status = transitionShipmentForKind(shipment.kind, shipment.status, next)
      const now = this.now()
      const sequence = state.nextSequence
      state.nextSequence += 1
      shipment.timeline.push({
        id: makeId('stl', `${shipment.id}:${next}:${now}:${sequence}`),
        status: next,
        label: cleanReason,
        at: now,
      })
      let deliveredClaim: DemoState['claims'][number] | undefined
      if (shipment.purpose === 'replacement' && next === 'delivered') {
        const claim = state.claims.find((entry) => entry.id === shipment.sourceClaimId)
        assert(
          claim &&
            claim.status === 'approved' &&
            claim.remedyState === 'replacement_authorized' &&
            claim.replacementShipmentId === shipment.id,
          'Replacement delivery requires its approved bidirectionally linked claim.',
          'REPLACEMENT_CLAIM_INVALID',
        )
        claim.status = 'resolved'
        claim.remedyState = 'replacement_delivered'
        claim.resolutionOutcome = 'replacement_authorized'
        claim.resolutionReference = shipment.id
        claim.resolutionNote = cleanReason
        claim.updatedAt = now
        claim.history.push({
          id: `${claim.id}-h-${String(claim.history.length + 1).padStart(2, '0')}`,
          status: 'resolved',
          note: cleanReason,
          actorId: actor.id,
          actorRole: actor.role,
          at: now,
        })
        deliveredClaim = claim
      }
      if (!financiallyStopped) {
        refreshOrderFulfillment(state, order, now, cleanReason)
      }
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
        after: {
          status: next,
          orderStatus: order.status,
          financialHoldPreserved: financiallyStopped,
        },
      })
      if (deliveredClaim) {
        this.audit.append(state, {
          actorId: actor.id,
          actorRole: actor.role,
          action: REPLACEMENT_DELIVERED_ACTION,
          targetType: 'claim',
          targetId: deliveredClaim.id,
          reason: cleanReason,
          at: now,
          requestId: makeId('req', `${deliveredClaim.id}:replacement-delivered:${now}:${sequence}`),
          before: {
            remedyState: 'replacement_authorized',
            status: 'approved',
          },
          after: {
            remedyState: 'replacement_delivered',
            replacementShipmentId: shipment.id,
            resolutionOutcome: 'replacement_authorized',
            resolutionReference: shipment.id,
            status: 'resolved',
          },
        })
      }
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
      assert(order, 'Shipment order was not found.', 'ORDER_MISSING')
      const eligibility = shipmentTrackingActionEligibility(order.status, shipment)
      assert(eligibility.eligible, eligibility.reason, eligibility.code)
      const cleanCarrier = sanitizeText(carrier, 70)
      const cleanTracking = sanitizeText(trackingNumber, 48).toUpperCase()
      const cleanReason = sanitizeText(reason, 220)
      assert(
        isClearlyFictionalCarrier(cleanCarrier),
        'Use a clearly fictional carrier containing Demo, Digital Vault, or Vault Counter.',
        'DEMO_DATA_ONLY',
      )
      assert(isValidDemoTracking(cleanTracking), 'Tracking must be a fictional DEMO- code.', 'DEMO_DATA_ONLY')
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
