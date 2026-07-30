import { shipmentStatusActionEligibility } from './fulfillmentEligibility'
import { isGrandfatheredDirectPostDeliveryReplacement } from './migrationEvidence'
import { matchingReplacementAuthorizationAudit } from './remedyEvidence'
import type { DemoState, Shipment } from './types'

function authorizedReplacementForOriginal(
  state: DemoState,
  original: Shipment,
  replacement: Shipment,
) {
  if (
    replacement.purpose !== 'replacement' ||
    replacement.orderId !== original.orderId ||
    replacement.replacementForShipmentId !== original.id ||
    !replacement.sourceClaimId
  ) {
    return false
  }
  const claims = state.claims.filter((entry) =>
    entry.id === replacement.sourceClaimId &&
    entry.orderId === original.orderId &&
    entry.replacementShipmentId === replacement.id)
  return Boolean(
    claims.length === 1 &&
    matchingReplacementAuthorizationAudit(
      state,
      claims[0],
      original,
      replacement,
    ),
  )
}

export function authorizedReplacementsForOriginal(
  state: DemoState,
  original: Shipment,
) {
  return state.shipments.filter((replacement) =>
    authorizedReplacementForOriginal(state, original, replacement) &&
    replacement.boxIds.some((boxId) => original.boxIds.includes(boxId)))
}

export function deliveredShipmentConflict(
  state: Pick<DemoState, 'shipments'>,
  shipment: Shipment,
) {
  const boxIds = new Set(shipment.boxIds)
  return state.shipments.find((candidate) =>
    candidate.id !== shipment.id &&
    candidate.status === 'delivered' &&
    candidate.boxIds.some((boxId) => boxIds.has(boxId)))
}

export function shipmentDeliveryActionEligibility(
  state: DemoState,
  shipment: Shipment,
) {
  const orders = state.orders.filter((order) => order.id === shipment.orderId)
  if (orders.length !== 1) {
    return {
      eligible: false,
      reason: 'Shipment order was not found.',
      code: 'ORDER_MISSING',
    }
  }
  const generic = shipmentStatusActionEligibility(
    orders[0].status,
    shipment,
    'delivered',
  )
  if (!generic.eligible) return generic

  if (shipment.purpose === 'replacement') {
    const originals = state.shipments.filter((entry) =>
      entry.id === shipment.replacementForShipmentId &&
      entry.orderId === shipment.orderId &&
      entry.purpose === 'original')
    const deliverableClaims = state.claims.filter((claim) =>
      claim.id === shipment.sourceClaimId &&
      claim.orderId === shipment.orderId &&
      claim.status === 'approved' &&
      claim.remedyState === 'replacement_authorized' &&
      claim.replacementShipmentId === shipment.id)
    if (
      originals.length !== 1 ||
      deliverableClaims.length !== 1 ||
      !authorizedReplacementForOriginal(state, originals[0], shipment)
    ) {
      return {
        eligible: false,
        reason: 'Replacement delivery requires its approved bidirectionally linked claim.',
        code: 'REPLACEMENT_CLAIM_INVALID',
      }
    }
    if (
      isGrandfatheredDirectPostDeliveryReplacement(
        state,
        deliverableClaims[0],
        originals[0],
        shipment,
      )
    ) {
      return {
        eligible: false,
        reason: 'This migrated direct post-delivery replacement is frozen as historical evidence and cannot record a new delivery.',
        code: 'LEGACY_POST_DELIVERY_REPLACEMENT_FROZEN',
      }
    }
  } else {
    const lateOriginal = lateOriginalDeliveryEligibility(state, shipment)
    if (!lateOriginal.eligible) {
      return {
        eligible: false,
        reason: lateOriginal.reason,
        code: 'DELIVERY_ENTITLEMENT_RESERVED',
      }
    }
  }

  const conflict = deliveredShipmentConflict(state, shipment)
  if (conflict) {
    return {
      eligible: false,
      reason: `Delivery entitlement is already consumed by shipment ${conflict.id}.`,
      code: 'DELIVERY_ENTITLEMENT_CONSUMED',
    }
  }
  return generic
}

export function isActionableInTransitShipment(
  state: DemoState,
  shipment: Shipment,
) {
  if (!['shipped', 'sent'].includes(shipment.status)) return false
  return shipmentDeliveryActionEligibility(state, shipment).eligible
}

export function lateOriginalDeliveryEligibility(
  state: DemoState,
  original: Shipment,
) {
  const replacements = authorizedReplacementsForOriginal(state, original)
  if (replacements.length === 0) {
    return {
      eligible: true,
      reason: 'No authorized reissue supersedes this original delivery.',
    }
  }
  if (original.purpose !== 'original' || original.kind === 'DIGITAL') {
    return {
      eligible: false,
      reason: 'A digital or replacement delivery cannot use the late-original exception.',
    }
  }
  const blocked = replacements.find((replacement) =>
    replacement.kind === 'DIGITAL' ||
    !['lost', 'returned'].includes(replacement.status))
  if (blocked) {
    return {
      eligible: false,
      reason: `Authorized reissue ${blocked.id} is digital, active, delivered, or not terminally lost/returned.`,
    }
  }
  return {
    eligible: true,
    reason: 'Every overlapping physical reissue is currently terminally lost or returned.',
  }
}
