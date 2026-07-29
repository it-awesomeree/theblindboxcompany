import { assert } from './guards'
import type {
  Claim,
  ClaimKind,
  DemoState,
  Order,
  Payment,
  Shipment,
} from './types'

export function canonicalOrderBoxScope(
  order: Order,
  requestedBoxIds: readonly string[],
) {
  const requested = new Set(requestedBoxIds)
  assert(
    requested.size === requestedBoxIds.length &&
      requested.size > 0 &&
      requestedBoxIds.every((boxId) => order.boxIds.includes(boxId)),
    'Remedy box scope must contain unique boxes from the claim order.',
    'CLAIM_REMEDY_SCOPE_INVALID',
  )
  return order.boxIds.filter((boxId) => requested.has(boxId))
}

export function orderBoxSettlementAllocations(order: Order) {
  assert(
    order.boxIds.length === order.snapshot.quantity && order.boxIds.length > 0,
    'Order box order is inconsistent with its money snapshot.',
    'ORDER_BOX_SNAPSHOT_INVALID',
  )
  const shippingBase = Math.floor(
    order.snapshot.totals.shippingSen / order.boxIds.length,
  )
  const shippingRemainder =
    order.snapshot.totals.shippingSen % order.boxIds.length
  return order.boxIds.map((boxId, index) => ({
    boxId,
    amountSen:
      order.snapshot.unitPriceSen +
      shippingBase +
      (index < shippingRemainder ? 1 : 0),
  }))
}

export function requiredSettlementForBoxScope(
  order: Order,
  requestedBoxIds: readonly string[],
) {
  const scope = canonicalOrderBoxScope(order, requestedBoxIds)
  const requested = new Set(scope)
  return orderBoxSettlementAllocations(order)
    .filter((allocation) => requested.has(allocation.boxId))
    .reduce((sum, allocation) => sum + allocation.amountSen, 0)
}

export function remedyBoxIdsForEvidence(
  state: DemoState,
  order: Order,
  evidence: {
    kind: ClaimKind
    boxId?: string
    shipmentId?: string
    shipmentCandidateIds?: readonly string[]
  },
) {
  if (evidence.kind === 'value_floor') {
    assert(evidence.boxId, 'Value-floor remedy scope requires one box.', 'CLAIM_REMEDY_SCOPE_INVALID')
    return canonicalOrderBoxScope(order, [evidence.boxId])
  }
  const shipmentIds = evidence.shipmentCandidateIds ?? (
    evidence.shipmentId ? [evidence.shipmentId] : []
  )
  assert(
    shipmentIds.length > 0,
    'Delivery remedy scope requires original shipment evidence.',
    'CLAIM_REMEDY_SCOPE_INVALID',
  )
  const shipments = shipmentIds.map((shipmentId) =>
    state.shipments.find((shipment) =>
      shipment.id === shipmentId &&
      shipment.orderId === order.id &&
      shipment.purpose === 'original'))
  assert(
    shipments.every(Boolean),
    'Delivery remedy scope must use original shipments from the claim order.',
    'CLAIM_REMEDY_SCOPE_INVALID',
  )
  return canonicalOrderBoxScope(
    order,
    shipments.flatMap((shipment) => shipment!.boxIds),
  )
}

export function expectedClaimRemedySnapshot(
  state: DemoState,
  claim: Pick<
    Claim,
    'orderId' | 'kind' | 'boxId' | 'shipmentId' | 'shipmentCandidateIds'
  >,
) {
  const order = state.orders.find((entry) => entry.id === claim.orderId)
  assert(order, 'Claim order was not found.', 'ORDER_MISSING')
  const remedyBoxIds = remedyBoxIdsForEvidence(state, order, claim)
  return {
    remedyBoxIds,
    requiredSettlementSen: requiredSettlementForBoxScope(order, remedyBoxIds),
  }
}

export function isTerminalReplacementRefundFallback(
  replacement: Shipment | undefined,
) {
  if (!replacement || replacement.purpose !== 'replacement') return false
  return replacement.kind === 'DIGITAL'
    ? replacement.status === 'failed'
    : ['lost', 'returned'].includes(replacement.status)
}

export function remainingPaymentBalance(payment: Payment) {
  return payment.amountSen - payment.refundedSen
}

export function deliveredShipmentConflict(
  state: DemoState,
  shipment: Shipment,
) {
  const boxIds = new Set(shipment.boxIds)
  return state.shipments.find((candidate) =>
    candidate.id !== shipment.id &&
    candidate.status === 'delivered' &&
    candidate.boxIds.some((boxId) => boxIds.has(boxId)))
}
