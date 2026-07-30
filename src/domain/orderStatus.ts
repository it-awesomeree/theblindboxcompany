import type { OrderStatus, ShipmentStatus } from './types'
import {
  deriveOrderStatusFromScopeStatuses,
  type FulfillmentScopeStatus,
} from './orderFulfillment'

export type ShipmentDerivedOrderStatus = Extract<
  OrderStatus,
  'confirmed' | 'processing' | 'partially_fulfilled' | 'fulfilled'
>

export function deriveOrderStatusFromShipments(
  statuses: readonly ShipmentStatus[],
): ShipmentDerivedOrderStatus {
  const scopes: FulfillmentScopeStatus[] = statuses.map((status) =>
    status === 'unfulfilled'
      ? 'confirmed'
      : status === 'delivered'
        ? 'fulfilled'
        : 'processing')
  return deriveOrderStatusFromScopeStatuses(scopes)
}

export function neutralOrderDeliveryCode(orderId: string) {
  return `DEMO-DELIVERY-${orderId.toUpperCase()}`
}

export function neutralOrderDeliveryStatus(status: OrderStatus) {
  if (status === 'pending_payment') return 'payment_pending'
  if (status === 'confirmed') return 'delivery_preparing'
  if (['processing', 'partially_fulfilled'].includes(status)) return 'delivery_in_progress'
  if (['fulfilled', 'closed'].includes(status)) return 'delivery_complete'
  return status
}
