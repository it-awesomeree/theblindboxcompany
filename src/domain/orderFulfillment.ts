import { assert, makeId, transitionOrder } from './guards'
import { isOpenClaimStatus } from './claimStatus'
import type {
  BoxStatus,
  Claim,
  DemoState,
  Order,
  OrderStatus,
  Shipment,
} from './types'

export type FulfillmentScopeStatus = 'confirmed' | 'processing' | 'fulfilled'
export type FulfillmentCompletionKind = 'original' | 'refund' | 'replacement'

export interface FulfillmentScopeResolution {
  originalShipmentId: string
  boxIds: string[]
  status: FulfillmentScopeStatus
  completedBy?: FulfillmentCompletionKind
  affectedClaimIds: string[]
  replacementShipmentId?: string
}

export interface OrderFulfillmentResolution {
  orderId: string
  scopes: FulfillmentScopeResolution[]
  status: Extract<
    OrderStatus,
    'confirmed' | 'processing' | 'partially_fulfilled' | 'fulfilled'
  >
}

function claimAffectsBox(claim: Claim, original: Shipment, boxId: string) {
  return (
    claim.orderId === original.orderId &&
    original.boxIds.includes(boxId) &&
    claim.remedyBoxIds.includes(boxId)
  )
}

function completedRefund(claim: Claim) {
  return (
    claim.status === 'resolved' &&
    claim.remedyState === 'refund_completed' &&
    claim.resolutionOutcome === 'refund_recorded' &&
    claim.linkedRefundEventId !== undefined &&
    claim.resolutionReference === claim.linkedRefundEventId &&
    claim.acceptedSettlementSen !== undefined &&
    claim.settlementPolicy !== undefined &&
    claim.legacyUnderSettledRefund !== true
  )
}

function completedReplacement(
  state: DemoState,
  claim: Claim,
  original: Shipment,
  boxId: string,
) {
  if (
    claim.status !== 'resolved' ||
    claim.remedyState !== 'replacement_delivered' ||
    claim.resolutionOutcome !== 'replacement_authorized' ||
    !claim.replacementShipmentId ||
    claim.resolutionReference !== claim.replacementShipmentId
  ) {
    return undefined
  }
  return state.shipments.find((shipment) =>
    shipment.id === claim.replacementShipmentId &&
    shipment.purpose === 'replacement' &&
    shipment.sourceClaimId === claim.id &&
    shipment.replacementForShipmentId === original.id &&
    shipment.boxIds.includes(boxId) &&
    shipment.status === 'delivered',
  )
}

function scopeStatus(
  state: DemoState,
  original: Shipment,
  boxId: string,
  affectedClaims: Claim[],
): FulfillmentScopeResolution {
  const openClaims = affectedClaims.filter((claim) => isOpenClaimStatus(claim.status))
  const refundClaim = affectedClaims.find(completedRefund)
  const replacement = affectedClaims
    .map((claim) => completedReplacement(state, claim, original, boxId))
    .find(Boolean)
  const complete = openClaims.length === 0 && (
    original.status === 'delivered' ||
    Boolean(refundClaim) ||
    Boolean(replacement)
  )
  const replacementInProgress = affectedClaims
    .map((claim) => claim.replacementShipmentId)
    .filter(Boolean)
    .map((shipmentId) => state.shipments.find((shipment) => shipment.id === shipmentId))
    .find((shipment) => shipment?.boxIds.includes(boxId))
  const untouched =
    original.status === 'unfulfilled' &&
    affectedClaims.length === 0 &&
    !replacementInProgress

  return {
    originalShipmentId: original.id,
    boxIds: [boxId],
    status: complete ? 'fulfilled' : untouched ? 'confirmed' : 'processing',
    ...(complete
      ? {
          completedBy: original.status === 'delivered'
            ? 'original' as const
            : replacement
              ? 'replacement' as const
              : 'refund' as const,
        }
      : {}),
    affectedClaimIds: affectedClaims.map((claim) => claim.id),
    ...(replacementInProgress ? { replacementShipmentId: replacementInProgress.id } : {}),
  }
}

export function deriveOrderStatusFromScopeStatuses(
  statuses: readonly FulfillmentScopeStatus[],
): OrderFulfillmentResolution['status'] {
  if (statuses.length === 0 || statuses.every((status) => status === 'confirmed')) {
    return 'confirmed'
  }
  const fulfilled = statuses.filter((status) => status === 'fulfilled').length
  if (fulfilled === statuses.length) return 'fulfilled'
  if (fulfilled > 0) return 'partially_fulfilled'
  return 'processing'
}

export function resolveOrderFulfillment(
  state: DemoState,
  orderOrId: Order | string,
): OrderFulfillmentResolution {
  const order = typeof orderOrId === 'string'
    ? state.orders.find((entry) => entry.id === orderOrId)
    : orderOrId
  assert(order, 'Order was not found for fulfilment resolution.', 'ORDER_MISSING')
  const originals = state.shipments.filter((shipment) =>
    shipment.orderId === order.id && shipment.purpose === 'original')
  const scopes = originals.flatMap((original) =>
    original.boxIds.map((boxId) =>
      scopeStatus(
        state,
        original,
        boxId,
        state.claims.filter((claim) => claimAffectsBox(claim, original, boxId)),
      )))
  return {
    orderId: order.id,
    scopes,
    status: deriveOrderStatusFromScopeStatuses(scopes.map((scope) => scope.status)),
  }
}

export function expectedBoxStatusForScope(
  state: DemoState,
  scope: FulfillmentScopeResolution,
  current: BoxStatus,
  revealed: boolean,
) {
  if (scope.status === 'fulfilled') return 'fulfilled'
  const original = state.shipments.find((shipment) =>
    shipment.id === scope.originalShipmentId && shipment.purpose === 'original')
  const replacement = scope.replacementShipmentId
    ? state.shipments.find((shipment) => shipment.id === scope.replacementShipmentId)
    : undefined
  if (
    scope.affectedClaimIds.some((claimId) => {
      const claim = state.claims.find((entry) => entry.id === claimId)
      return claim && isOpenClaimStatus(claim.status)
    }) ||
    ['cancelled', 'failed', 'failed_delivery', 'lost', 'returned'].includes(original?.status ?? '') ||
    ['cancelled', 'failed', 'failed_delivery', 'lost', 'returned'].includes(replacement?.status ?? '')
  ) {
    if (
      replacement &&
      !['unfulfilled', 'cancelled', 'failed', 'failed_delivery', 'lost', 'returned'].includes(replacement.status)
    ) {
      return 'fulfillment_pending'
    }
    return 'on_hold'
  }
  if (
    ['shipped', 'sent'].includes(original?.status ?? '') ||
    (
      replacement &&
      !['unfulfilled', 'cancelled', 'failed', 'failed_delivery', 'lost', 'returned'].includes(replacement.status)
    )
  ) {
    return 'fulfillment_pending'
  }
  if (current === 'reserved' || current === 'void') return current
  return revealed ? 'opened' : 'paid_unopened'
}

export function refreshOrderFulfillment(
  state: DemoState,
  order: Order,
  at: string,
  label: string,
) {
  const resolution = resolveOrderFulfillment(state, order)
  if (['cancelled', 'refunded', 'disputed'].includes(order.status)) return resolution

  for (const scope of resolution.scopes) {
    for (const boxId of scope.boxIds) {
      const box = state.boxes.find((entry) => entry.id === boxId)
      if (!box) continue
      box.status = expectedBoxStatusForScope(
        state,
        scope,
        box.status,
        Boolean(box.revealedAt),
      )
    }
  }

  const target: OrderStatus =
    order.status === 'closed' && resolution.status === 'fulfilled'
      ? 'closed'
      : resolution.status
  if (order.status !== target) {
    order.status = transitionOrder(order.status, target)
  }
  order.updatedAt = at
  const sequence = state.nextSequence
  state.nextSequence += 1
  order.timeline.push({
    id: makeId('tl', `${order.id}:fulfilment-refresh:${at}:${sequence}`),
    status: order.status,
    label,
    at,
  })
  return resolution
}
