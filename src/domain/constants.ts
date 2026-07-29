import type {
  BoxStatus,
  OrderStatus,
  PaymentStatus,
  PrizeDefinition,
  Role,
  ShipmentStatus,
  ShippingMethod,
} from './types'
import { exactOddsLabel } from './odds'

export const SCHEMA_VERSION = 8 as const
export const SERIES_ID = 'series-001'
export const BOX_PRICE_SEN = 10_000
export const VALUE_FLOOR_SEN = 10_000
export const SERIES_ALLOCATION_TOTAL = 10_000
export const MAX_CART_QUANTITY = 10
export const RESERVATION_MINUTES = 15

export const DEMO_CUSTOMER_ID = 'usr-demo-customer'
export const DEMO_ADMIN_ID = 'usr-demo-admin'

export const ROLE_LABELS: Record<Role, string> = {
  customer: 'Customer',
  support: 'Support',
  fulfilment: 'Fulfilment',
  finance: 'Finance',
  catalog: 'Catalog',
  admin: 'Admin',
  super_admin: 'Super admin',
}

export const ADMIN_ROLES: Role[] = [
  'support',
  'fulfilment',
  'finance',
  'catalog',
  'admin',
  'super_admin',
]

export type AdminSection =
  | 'overview'
  | 'users'
  | 'orders'
  | 'payments'
  | 'inventory'
  | 'fulfilment'
  | 'claims'
  | 'audit'

export const ADMIN_SECTION_PERMISSIONS: Record<AdminSection, Role[]> = {
  overview: ['admin', 'super_admin'],
  users: ['support', 'admin', 'super_admin'],
  orders: ['admin', 'super_admin'],
  payments: ['finance', 'admin', 'super_admin'],
  inventory: ['catalog', 'admin', 'super_admin'],
  fulfilment: ['fulfilment', 'admin', 'super_admin'],
  claims: ['support', 'admin', 'super_admin'],
  audit: ['admin', 'super_admin'],
}

const withExactOdds = (
  definition: Omit<PrizeDefinition, 'odds'>,
): PrizeDefinition => ({
  ...definition,
  odds: exactOddsLabel(definition.allocation, SERIES_ALLOCATION_TOTAL),
})

export const PRIZES: PrizeDefinition[] = [
  withExactOdds({ id: 'maggi', name: 'Maggi mee × 100 peket', shortName: 'Maggi ×100', valueSen: 13_000, allocation: 2500, tier: 'Dapur', fulfilment: 'BULKY', insured: false, signatureRequired: false }),
  withExactOdds({ id: 'water', name: 'Air mineral × 100 botol', shortName: 'Water ×100', valueSen: 12_000, allocation: 2500, tier: 'Dapur', fulfilment: 'BULKY', insured: false, signatureRequired: false }),
  withExactOdds({ id: 'toilet-roll', name: 'Tisu tandas × 100 gulung', shortName: 'Toilet roll ×100', valueSen: 12_000, allocation: 1250, tier: 'Dapur', fulfilment: 'BULKY', insured: false, signatureRequired: false }),
  withExactOdds({ id: 'eggs', name: 'Telur gred A × 300 biji', shortName: 'Eggs ×300', valueSen: 15_000, allocation: 1250, tier: 'Dapur', fulfilment: 'BULKY', insured: false, signatureRequired: false }),
  withExactOdds({ id: 'rice', name: 'Beras 10kg × 4 karung', shortName: 'Rice 10kg ×4', valueSen: 14_000, allocation: 1000, tier: 'Dapur', fulfilment: 'BULKY', insured: false, signatureRequired: false }),
  withExactOdds({ id: 'tng', name: "Touch 'n Go reload — RM100 tepat", shortName: 'TNG reload RM100', valueSen: 10_000, allocation: 1000, tier: 'Dapur', fulfilment: 'DIGITAL', insured: false, signatureRequired: false }),
  withExactOdds({ id: 'air-fryer', name: 'Air fryer 5L', shortName: 'Air fryer 5L', valueSen: 29_900, allocation: 400, tier: 'Tech', fulfilment: 'PARCEL', insured: false, signatureRequired: false }),
  withExactOdds({ id: 'airpods', name: 'AirPods 4 (ANC)', shortName: 'AirPods 4 ANC', valueSen: 82_900, allocation: 80, tier: 'Tech', fulfilment: 'PARCEL', insured: true, signatureRequired: true }),
  withExactOdds({ id: 'ipad', name: 'iPad (A16, 128GB)', shortName: 'iPad A16 128GB', valueSen: 204_900, allocation: 16, tier: 'Tech', fulfilment: 'PARCEL', insured: true, signatureRequired: true }),
  withExactOdds({ id: 'iphone17', name: 'iPhone 17 (256GB)', shortName: 'iPhone 17 256GB', valueSen: 399_900, allocation: 3, tier: 'Grail', fulfilment: 'PARCEL', insured: true, signatureRequired: true }),
  withExactOdds({ id: 'iphone17pm', name: 'iPhone 17 Pro Max (256GB)', shortName: 'iPhone 17 Pro Max 256GB', valueSen: 599_900, allocation: 1, tier: 'Grail', fulfilment: 'PARCEL', insured: true, signatureRequired: true }),
]

export const SHIPPING_FEES: Record<ShippingMethod, number> = {
  standard: 1200,
  priority: 2000,
  self_collect: 0,
}

export const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  created: ['pending', 'cancelled'],
  pending: ['processing', 'succeeded', 'failed', 'cancelled', 'expired'],
  processing: ['succeeded', 'failed', 'expired'],
  succeeded: ['partially_refunded', 'refunded', 'disputed'],
  failed: [],
  cancelled: [],
  expired: [],
  partially_refunded: ['partially_refunded', 'refunded', 'disputed'],
  refunded: [],
  disputed: ['succeeded', 'partially_refunded', 'refunded'],
}

export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled', 'refunded', 'disputed'],
  processing: ['confirmed', 'partially_fulfilled', 'fulfilled', 'refunded', 'disputed'],
  partially_fulfilled: ['confirmed', 'processing', 'fulfilled', 'refunded', 'disputed'],
  fulfilled: ['processing', 'partially_fulfilled', 'closed', 'refunded', 'disputed'],
  closed: ['confirmed', 'processing', 'partially_fulfilled', 'refunded', 'disputed'],
  cancelled: [],
  refunded: [],
  disputed: ['confirmed', 'processing', 'partially_fulfilled', 'fulfilled', 'closed', 'refunded'],
}

export const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  unfulfilled: ['picking', 'issued', 'cancelled'],
  picking: ['packed', 'cancelled'],
  packed: ['label_created', 'cancelled'],
  label_created: ['shipped', 'cancelled'],
  shipped: ['delivered', 'failed_delivery', 'lost', 'returned'],
  issued: ['sent', 'cancelled'],
  sent: ['delivered', 'failed'],
  delivered: ['returned'],
  failed: [],
  failed_delivery: ['returned', 'lost'],
  lost: [],
  returned: [],
  cancelled: ['unfulfilled'],
}

export const BOX_TRANSITIONS: Record<BoxStatus, BoxStatus[]> = {
  reserved: ['paid_unopened', 'void'],
  paid_unopened: ['opened', 'fulfillment_pending', 'fulfilled', 'on_hold'],
  opened: ['fulfillment_pending', 'fulfilled', 'on_hold'],
  fulfillment_pending: ['fulfilled', 'on_hold'],
  fulfilled: ['on_hold'],
  on_hold: ['paid_unopened', 'opened', 'fulfillment_pending', 'fulfilled'],
  void: ['reserved'],
}

export const POLICY_ACKNOWLEDGEMENT =
  'I understand this is a public fake-data demo, the published Series 001 odds, the no-reroll rule, and that no money or goods will move.'
