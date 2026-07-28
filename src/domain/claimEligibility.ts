import type { Box, ClaimKind, Shipment, ShipmentStatus } from './types'

export const SHIPPED_OVERDUE_MS = 3 * 24 * 60 * 60 * 1000

export interface ClaimEligibility {
  eligible: boolean
  reason: string
}

function time(value: string) {
  return Date.parse(value)
}

export function historicalShipmentStatus(shipment: Shipment, at: string): ShipmentStatus | undefined {
  return shipment.timeline
    .filter((entry) => time(entry.at) <= time(at))
    .at(-1)?.status
}

export function shipmentClaimEligibility(
  shipment: Shipment,
  kind: Extract<ClaimKind, 'damage' | 'non_delivery'>,
  at: string,
): ClaimEligibility {
  const events = shipment.timeline.filter((entry) => time(entry.at) <= time(at))
  const status = historicalShipmentStatus(shipment, at)

  if (kind === 'damage') {
    if (shipment.kind === 'DIGITAL') {
      return { eligible: false, reason: 'A digital fulfilment cannot have physical damage.' }
    }
    return status === 'delivered'
      ? { eligible: true, reason: 'This physical delivery can be used for a damage claim.' }
      : { eligible: false, reason: 'Damage claims require a delivered shipment.' }
  }

  if (shipment.kind === 'DIGITAL') {
    return { eligible: false, reason: 'A digital fulfilment cannot have physical non-delivery.' }
  }
  if (events.some((entry) => entry.status === 'delivered')) {
    return {
      eligible: false,
      reason: 'A customer return after delivery is not non-delivery evidence.',
    }
  }
  if (!status || !['shipped', 'failed_delivery', 'lost', 'returned'].includes(status)) {
    return {
      eligible: false,
      reason: 'Non-delivery claims require a shipped, failed-delivery, lost, or returned shipment.',
    }
  }
  const hasExceptionEvidence = events.some((entry) =>
    ['failed_delivery', 'lost', 'returned'].includes(entry.status),
  )
  if (status !== 'shipped' || hasExceptionEvidence) {
    return { eligible: true, reason: 'This delivery record contains non-delivery evidence.' }
  }
  const shippedAt = events.filter((entry) => entry.status === 'shipped').at(-1)?.at
  if (!shippedAt || !Number.isFinite(time(at)) || time(at) - time(shippedAt) < SHIPPED_OVERDUE_MS) {
    return { eligible: false, reason: 'A shipped parcel must be at least three demo days overdue.' }
  }
  return { eligible: true, reason: 'This shipped delivery record is at least three demo days overdue.' }
}

export function valueFloorClaimEligibility(box: Box | undefined, at: string): ClaimEligibility {
  if (!box?.revealedAt || !box.prizeId || time(box.revealedAt) > time(at)) {
    return { eligible: false, reason: 'Value-floor claims require a revealed box.' }
  }
  return { eligible: true, reason: 'This revealed box can be used for a value-floor claim.' }
}
