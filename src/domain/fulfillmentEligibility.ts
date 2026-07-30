import { canTransitionShipmentForKind } from './guards'
import type { OrderStatus, Shipment, ShipmentStatus } from './types'

const FINANCIAL_HOLD_STATUSES: readonly OrderStatus[] = [
  'cancelled',
  'refunded',
  'disputed',
]

const TRACKING_EDITABLE_STATUSES: readonly ShipmentStatus[] = [
  'unfulfilled',
  'picking',
  'packed',
  'label_created',
]

const FINANCIAL_HOLD_CARRIER_EDGES: Partial<
  Record<ShipmentStatus, readonly ShipmentStatus[]>
> = {
  failed_delivery: ['lost', 'returned'],
  shipped: ['delivered', 'failed_delivery', 'lost', 'returned'],
  delivered: ['returned'],
}

export interface FulfillmentActionEligibility {
  eligible: boolean
  reason: string
  code: string
}

export function shipmentStatusActionEligibility(
  orderStatus: OrderStatus,
  shipment: Shipment,
  next: ShipmentStatus,
): FulfillmentActionEligibility {
  const financiallyStopped = FINANCIAL_HOLD_STATUSES.includes(orderStatus)
  if (financiallyStopped) {
    const carrierEvidenceAllowed =
      ['refunded', 'disputed'].includes(orderStatus) &&
      shipment.kind !== 'DIGITAL' &&
      shipment.purpose === 'original' &&
      Boolean(FINANCIAL_HOLD_CARRIER_EDGES[shipment.status]?.includes(next))
    return carrierEvidenceAllowed
      ? {
          eligible: true,
          reason: 'This graph-legal physical carrier evidence can be recorded without reopening finance.',
          code: 'CARRIER_EVIDENCE_ALLOWED',
        }
      : {
          eligible: false,
          reason: `Financial hold: the ${orderStatus} order can only record a graph-legal physical carrier evidence step for an original shipment already in carrier transit; replacement shipments, tracking, restarts, fulfilment progress, and financial state remain locked until the hold is explicitly cleared.`,
          code: 'FINANCIAL_HOLD',
        }
  }
  return canTransitionShipmentForKind(shipment.kind, shipment.status, next)
    ? {
        eligible: true,
        reason: 'This shipment transition is graph-legal.',
        code: 'SHIPMENT_TRANSITION_ALLOWED',
      }
    : {
        eligible: false,
        reason: `Shipment cannot move from ${shipment.status} to ${next}.`,
        code: 'INVALID_TRANSITION',
      }
}

export function shipmentTrackingActionEligibility(
  orderStatus: OrderStatus,
  shipment: Shipment,
): FulfillmentActionEligibility {
  if (shipment.kind === 'DIGITAL') {
    return {
      eligible: false,
      reason: 'Digital fulfilment never uses editable carrier tracking.',
      code: 'DIGITAL_TRACKING_FORBIDDEN',
    }
  }
  if (FINANCIAL_HOLD_STATUSES.includes(orderStatus)) {
    return {
      eligible: false,
      reason: 'Tracking cannot change while the order is on financial hold.',
      code: 'FINANCIAL_HOLD',
    }
  }
  if (!TRACKING_EDITABLE_STATUSES.includes(shipment.status)) {
    return {
      eligible: false,
      reason: 'Carrier and tracking lock after shipment.',
      code: 'TRACKING_LOCKED',
    }
  }
  return {
    eligible: true,
    reason: 'Carrier and tracking can be edited before shipment.',
    code: 'TRACKING_EDIT_ALLOWED',
  }
}
