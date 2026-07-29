import { assert } from './guards'
import { isOpenClaimStatus } from './claimStatus'
import type {
  Claim,
  ClaimKind,
  DemoState,
  Order,
  Payment,
  Shipment,
} from './types'

const REMEDY_ENTITLEMENT_STATES = new Set<Claim['remedyState']>([
  'rma_created',
  'rma_received',
  'rma_inspected',
  'replacement_authorized',
  'replacement_delivered',
  'refund_linked',
  'refund_completed',
])

const GRANDFATHERED_COMPLETION_OUTCOMES = new Set<
  NonNullable<Claim['resolutionOutcome']>
>([
  'replacement_authorized',
  'refund_recorded',
])

export const REMEDY_SCOPE_CONFLICT_CODE = 'REMEDY_SCOPE_CONFLICT'
export const CLAIM_ORDER_FINANCIAL_HOLD_CODE =
  'CLAIM_ORDER_FINANCIAL_HOLD'
export const FULL_REFUND_REMEDY_CONFLICT_CODE =
  'FULL_REFUND_REMEDY_CONFLICT'

const CLAIM_ORDER_FINANCIAL_HOLD_STATUSES = new Set<Order['status']>([
  'cancelled',
  'refunded',
  'disputed',
])

export interface RemedyScopeConflict {
  orderId: string
  holderClaimId: string
  remedyBoxIds: string[]
}

export function claimHoldsRemedyEntitlement(claim: Claim) {
  if (
    claim.status === 'rejected' ||
    claim.legacyUnderSettledRefund === true
  ) {
    return false
  }
  return (
    REMEDY_ENTITLEMENT_STATES.has(claim.remedyState) ||
    (
      claim.status === 'resolved' &&
      claim.resolutionOutcome !== undefined &&
      GRANDFATHERED_COMPLETION_OUTCOMES.has(claim.resolutionOutcome)
    )
  )
}

export function claimBlocksFullPaymentRefund(claim: Claim) {
  if (
    claim.legacyUnderSettledRefund === true ||
    claim.status === 'rejected' ||
    (
      claim.status === 'resolved' &&
      claim.resolutionOutcome === 'no_remedy'
    )
  ) {
    return false
  }
  return (
    isOpenClaimStatus(claim.status) ||
    claimHoldsRemedyEntitlement(claim)
  )
}

export function claimHasAcceptedLinkedRefundOnPayment(
  claim: Claim,
  payment: Payment,
) {
  if (
    claim.orderId !== payment.orderId ||
    claim.userId !== payment.userId ||
    claim.linkedRefundEventId === undefined ||
    !Number.isInteger(claim.acceptedSettlementSen) ||
    claim.acceptedSettlementSen! <= 0
  ) {
    return false
  }
  const acceptedClaimState =
    (
      claim.status === 'approved' &&
      claim.remedyState === 'refund_linked'
    ) ||
    (
      claim.status === 'resolved' &&
      claim.remedyState === 'refund_completed' &&
      claim.resolutionOutcome === 'refund_recorded' &&
      claim.resolutionReference === claim.linkedRefundEventId
    )
  if (!acceptedClaimState) return false
  const matches = payment.events.filter((event) =>
    event.id === claim.linkedRefundEventId)
  if (matches.length !== 1) return false
  const event = matches[0]
  return (
    event.source === 'admin_reconcile' &&
    event.ignoredReason === undefined &&
    ['partially_refunded', 'refunded'].includes(event.type) &&
    event.refundIntent?.paymentId === payment.id &&
    event.refundIntent.claimId === claim.id &&
    event.refundIntent.amountSen === claim.acceptedSettlementSen
  )
}

export function assertFullPaymentRefundCompatible(
  state: Pick<DemoState, 'claims'>,
  payment: Payment,
  completingClaimId?: string,
) {
  const blocker = state.claims.find((claim) => {
    if (
      claim.orderId !== payment.orderId ||
      claim.id === completingClaimId ||
      !claimBlocksFullPaymentRefund(claim)
    ) {
      return false
    }
    return (
      completingClaimId === undefined ||
      !claimHasAcceptedLinkedRefundOnPayment(claim, payment)
    )
  })
  assert(
    blocker === undefined,
    blocker
      ? `Full refund of payment ${payment.id} is blocked by claim ${blocker.id}.`
      : 'Full payment refund is compatible with claim remedies.',
    FULL_REFUND_REMEDY_CONFLICT_CODE,
  )
}

export function findRemedyScopeConflict(
  claims: readonly Claim[],
  currentClaim: Pick<Claim, 'id' | 'orderId' | 'remedyBoxIds'>,
): RemedyScopeConflict | undefined {
  const requestedBoxIds = new Set(currentClaim.remedyBoxIds)
  for (const holder of claims) {
    if (
      holder.id === currentClaim.id ||
      holder.orderId !== currentClaim.orderId ||
      !claimHoldsRemedyEntitlement(holder)
    ) {
      continue
    }
    const overlappingBoxIds = holder.remedyBoxIds.filter((boxId) =>
      requestedBoxIds.has(boxId))
    if (overlappingBoxIds.length > 0) {
      return {
        orderId: currentClaim.orderId,
        holderClaimId: holder.id,
        remedyBoxIds: overlappingBoxIds,
      }
    }
  }
  return undefined
}

export function assertNoRemedyScopeConflict(
  claims: readonly Claim[],
  currentClaim: Pick<Claim, 'id' | 'orderId' | 'remedyBoxIds'>,
) {
  const conflict = findRemedyScopeConflict(claims, currentClaim)
  assert(
    conflict === undefined,
    conflict
      ? `Claim ${currentClaim.id} overlaps remedy entitlement held by claim ${conflict.holderClaimId} for box scope ${conflict.remedyBoxIds.join(', ')}.`
      : 'Claim remedy entitlement scope is available.',
    REMEDY_SCOPE_CONFLICT_CODE,
  )
}

export function assertClaimOrderAllowsTypedRemedy(
  order: Pick<Order, 'status'>,
) {
  assert(
    !CLAIM_ORDER_FINANCIAL_HOLD_STATUSES.has(order.status),
    `Typed RMA and replacement work is unavailable while the claim order is ${order.status}.`,
    CLAIM_ORDER_FINANCIAL_HOLD_CODE,
  )
}

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

export function terminalReplacementFallbackAmount(
  requiredSettlementSen: number,
  priorRemainingPaymentSen: number,
) {
  assert(
    Number.isInteger(requiredSettlementSen) &&
      requiredSettlementSen > 0 &&
      Number.isInteger(priorRemainingPaymentSen) &&
      priorRemainingPaymentSen > 0,
    'Terminal replacement fallback inputs must be positive integer-sen amounts.',
    'CLAIM_SETTLEMENT_AMOUNT_INVALID',
  )
  return Math.min(requiredSettlementSen, priorRemainingPaymentSen)
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
