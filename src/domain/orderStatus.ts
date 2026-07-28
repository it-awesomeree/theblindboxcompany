import type { OrderStatus, ShipmentStatus } from './types'

export type ShipmentDerivedOrderStatus = Extract<
  OrderStatus,
  'confirmed' | 'processing' | 'partially_fulfilled' | 'fulfilled'
>

export function deriveOrderStatusFromShipments(
  statuses: readonly ShipmentStatus[],
): ShipmentDerivedOrderStatus {
  if (statuses.length === 0 || statuses.every((status) => status === 'unfulfilled')) {
    return 'confirmed'
  }
  const delivered = statuses.filter((status) => status === 'delivered').length
  if (delivered === statuses.length) return 'fulfilled'
  if (delivered > 0) return 'partially_fulfilled'
  return 'processing'
}
