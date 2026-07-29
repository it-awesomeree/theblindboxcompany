import {
  BOX_PRICE_SEN,
  DEMO_ADMIN_ID,
  DEMO_CUSTOMER_ID,
  POLICY_ACKNOWLEDGEMENT,
  PRIZES,
  SCHEMA_VERSION,
  SERIES_ID,
} from '../domain/constants'
import type {
  Address,
  AuditEntry,
  Box,
  DemoState,
  Order,
  Payment,
  PrizeSeries,
  Shipment,
  User,
} from '../domain/types'

export const DEMO_ADDRESS: Address = {
  recipient: 'Aina Demo',
  line1: '88 Jalan DEMO Vault',
  line2: 'Unit 001, Aras Demo',
  postcode: '50000',
  city: 'Kuala Lumpur',
  state: 'Wilayah Persekutuan',
  phone: 'demo-010-000-0000',
  country: 'MY',
}

const at = (day: number, hour = 0, minute = 0) =>
  `2026-07-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`

const users: User[] = [
  { id: DEMO_CUSTOMER_ID, name: 'Aina Demo', email: 'aina@example.test', role: 'customer', status: 'active', createdAt: at(1) },
  { id: DEMO_ADMIN_ID, name: 'Vault Admin', email: 'admin@demo.local', role: 'super_admin', status: 'active', createdAt: at(1) },
  { id: 'usr-support', name: 'Suri Support', email: 'suri@demo.local', role: 'support', status: 'active', createdAt: at(3) },
  { id: 'usr-fulfilment', name: 'Farid Fulfilment', email: 'farid@demo.local', role: 'fulfilment', status: 'active', createdAt: at(4) },
  { id: 'usr-finance', name: 'Fiona Finance', email: 'fiona@demo.local', role: 'finance', status: 'active', createdAt: at(5) },
  { id: 'usr-catalog', name: 'Cal Catalog', email: 'cal@demo.local', role: 'catalog', status: 'active', createdAt: at(6) },
  { id: 'usr-suspended', name: 'Suspended Demo', email: 'suspended@example.test', role: 'customer', status: 'suspended', createdAt: at(7) },
]

const box = (
  id: string,
  orderId: string,
  prizeId: string,
  status: Box['status'],
  day: number,
  number = 1,
  revealedAt?: string,
  shipmentId?: string,
): Box => ({
  id,
  manifestId: `TBBC-001-${id.slice(-6).toUpperCase()}`,
  orderId,
  ownerId: DEMO_CUSTOMER_ID,
  seriesId: SERIES_ID,
  number,
  status,
  prizeId,
  assignedAt: at(day, 1),
  revealedAt,
  shipmentId,
})

const boxes: Box[] = [
  box('box-unopened-01', 'ord-unopened', 'air-fryer', 'paid_unopened', 25, 1, undefined, 'shp-unopened'),
  box('box-processing-01', 'ord-processing', 'maggi', 'opened', 22, 1, at(22, 4), 'shp-processing'),
  box('box-processing-02', 'ord-processing', 'tng', 'paid_unopened', 22, 2, undefined, 'shp-digital'),
  box('box-shipped-01', 'ord-shipped', 'airpods', 'fulfillment_pending', 20, 1, at(20, 5), 'shp-shipped'),
  box('box-delivered-01', 'ord-delivered', 'water', 'fulfilled', 18, 1, at(18, 8), 'shp-delivered'),
  box('box-failed-01', 'ord-failed', 'eggs', 'on_hold', 19, 1, at(19, 5), 'shp-failed'),
  box('box-refunded-01', 'ord-refunded', 'rice', 'opened', 17, 1, at(17, 2), 'shp-refunded'),
]

const totals = (quantity: number, shippingSen = 1200) => ({
  itemSubtotalSen: BOX_PRICE_SEN * quantity,
  shippingSen,
  totalSen: BOX_PRICE_SEN * quantity + shippingSen,
})

const order = (
  id: string,
  status: Order['status'],
  boxIds: string[],
  day: number,
): Order => {
  const quantity = boxIds.length
  const paymentId = `pay-${id.slice(4)}`
  const pathByStatus: Record<Order['status'], Order['status'][]> = {
    pending_payment: ['pending_payment'],
    confirmed: ['pending_payment', 'confirmed'],
    processing: ['pending_payment', 'confirmed', 'processing'],
    partially_fulfilled: ['pending_payment', 'confirmed', 'processing', 'partially_fulfilled'],
    fulfilled: ['pending_payment', 'confirmed', 'processing', 'fulfilled'],
    closed: ['pending_payment', 'confirmed', 'processing', 'fulfilled', 'closed'],
    cancelled: ['pending_payment', 'cancelled'],
    refunded: ['pending_payment', 'confirmed', 'refunded'],
    disputed: ['pending_payment', 'confirmed', 'disputed'],
  }
  const timeByStatus: Record<Order['status'], number> = {
    pending_payment: 0,
    confirmed: 1,
    processing: 3,
    partially_fulfilled: 7,
    fulfilled: 7,
    closed: 8,
    cancelled: 1,
    refunded: 8,
    disputed: 8,
  }
  const timeline = pathByStatus[status].map((entry, index) => ({
    id: `${id}-tl-${index + 1}`,
    status: entry,
    label: entry === 'pending_payment'
      ? 'Demo order created'
      : entry === 'confirmed'
        ? 'Mock webhook confirmed payment'
        : `Order ${entry.replaceAll('_', ' ')}`,
    at: at(day, timeByStatus[entry]),
  }))
  const updatedHour: Partial<Record<Order['status'], number>> = {
    processing: id === 'ord-processing' ? 3 : id === 'ord-shipped' ? 6 : 7,
  }
  return {
    id,
    checkoutRequestId: `checkout_${day.toString(16).padStart(32, '0')}`,
    userId: DEMO_CUSTOMER_ID,
    status,
    snapshot: {
      itemName: 'Series 001 Blind Box',
      seriesId: SERIES_ID,
      quantity,
      unitPriceSen: BOX_PRICE_SEN,
      shippingMethod: 'standard',
      address: DEMO_ADDRESS,
      oddsVersion: 'series-001-v1',
      policyVersion: 'floor-policy-v1',
      acknowledgement: POLICY_ACKNOWLEDGEMENT,
      totals: totals(quantity),
    },
    paymentIds: [paymentId],
    boxIds,
    claimIds: [],
    reservationExpiresAt: at(day, 0, 15),
    createdAt: at(day, 0),
    updatedAt: at(day, updatedHour[status] ?? timeByStatus[status]),
    timeline,
  }
}

const orders: Order[] = [
  order('ord-unopened', 'confirmed', ['box-unopened-01'], 25),
  order('ord-processing', 'processing', ['box-processing-01', 'box-processing-02'], 22),
  order('ord-shipped', 'processing', ['box-shipped-01'], 20),
  order('ord-delivered', 'fulfilled', ['box-delivered-01'], 18),
  order('ord-failed', 'processing', ['box-failed-01'], 19),
  order('ord-refunded', 'refunded', ['box-refunded-01'], 17),
]

const payment = (order: Order): Payment => {
  const refunded = order.status === 'refunded'
  const capturedTime = order.timeline.find((entry) => entry.status === 'confirmed')!.at
  const updatedAt = refunded ? order.updatedAt : capturedTime
  return {
    id: order.paymentIds[0],
    orderId: order.id,
    userId: order.userId,
    attempt: 1,
    method: order.id === 'ord-processing' ? 'DUITNOW' : 'FPX',
    status: refunded ? 'refunded' : 'succeeded',
    amountSen: order.snapshot.totals.totalSen,
    refundedSen: refunded ? order.snapshot.totals.totalSen : 0,
    createdAt: order.createdAt,
    updatedAt,
    events: [
      {
        id: `evt-${order.id}-success`,
        requestId: `req-${order.id}`,
        type: 'succeeded',
        source: 'mock_webhook',
        createdAt: capturedTime,
        processedAt: capturedTime,
      },
      ...(refunded
        ? [{
            id: `evt-${order.id}-refund`,
            requestId: `req-${order.id}-refund`,
            type: 'refunded' as const,
            source: 'admin_reconcile' as const,
            createdAt: updatedAt,
            processedAt: updatedAt,
            refundIntent: {
              paymentId: order.paymentIds[0],
              amountSen: order.snapshot.totals.totalSen,
              reason: 'Seeded fictional full refund record',
            },
          }]
        : []),
    ],
  }
}

const payments = orders.map(payment)

const shipment = (
  id: string,
  orderId: string,
  boxIds: string[],
  kind: Shipment['kind'],
  status: Shipment['status'],
  day: number,
  carrier: string,
): Shipment => {
  const pathByStatus: Record<Shipment['status'], Shipment['status'][]> = {
    unfulfilled: ['unfulfilled'],
    picking: ['unfulfilled', 'picking'],
    packed: ['unfulfilled', 'picking', 'packed'],
    label_created: ['unfulfilled', 'picking', 'packed', 'label_created'],
    shipped: ['unfulfilled', 'picking', 'packed', 'label_created', 'shipped'],
    delivered: ['unfulfilled', 'picking', 'packed', 'label_created', 'shipped', 'delivered'],
    failed_delivery: ['unfulfilled', 'picking', 'packed', 'label_created', 'shipped', 'failed_delivery'],
    lost: ['unfulfilled', 'picking', 'packed', 'label_created', 'shipped', 'lost'],
    returned: ['unfulfilled', 'picking', 'packed', 'label_created', 'shipped', 'returned'],
    cancelled: ['unfulfilled', 'cancelled'],
  }
  return {
    id,
    orderId,
    boxIds,
    kind,
    status,
    carrier,
    trackingNumber: `DEMO-${id.slice(2).toUpperCase()}`,
    insured: id === 'shp-shipped',
    signatureRequired: id === 'shp-shipped',
    createdAt: at(day, 2),
    timeline: pathByStatus[status].map((entry, index) => ({
      id: `${id}-${index + 1}`,
      status: entry,
      label: entry === 'unfulfilled' ? 'Fulfilment queued' : `Shipment ${entry.replaceAll('_', ' ')}`,
      at: at(day, index + 2),
    })),
  }
}

const shipments: Shipment[] = [
  shipment('shp-unopened', 'ord-unopened', ['box-unopened-01'], 'PARCEL', 'unfulfilled', 25, 'Demo Express'),
  shipment('shp-processing', 'ord-processing', ['box-processing-01'], 'BULKY', 'picking', 22, 'Demo Bulky Freight'),
  shipment('shp-digital', 'ord-processing', ['box-processing-02'], 'DIGITAL', 'unfulfilled', 22, 'Digital Vault'),
  shipment('shp-shipped', 'ord-shipped', ['box-shipped-01'], 'PARCEL', 'shipped', 20, 'Demo Express'),
  shipment('shp-delivered', 'ord-delivered', ['box-delivered-01'], 'BULKY', 'delivered', 18, 'Demo Bulky Freight'),
  shipment('shp-failed', 'ord-failed', ['box-failed-01'], 'BULKY', 'failed_delivery', 19, 'Demo Bulky Freight'),
  shipment('shp-refunded', 'ord-refunded', ['box-refunded-01'], 'BULKY', 'cancelled', 17, 'Demo Bulky Freight'),
]

const assignedByPrize = new Map<string, number>()
boxes.forEach((entry) => {
  if (entry.prizeId) assignedByPrize.set(entry.prizeId, (assignedByPrize.get(entry.prizeId) ?? 0) + 1)
})

const series: PrizeSeries[] = [{
  id: SERIES_ID,
  name: 'Series 001',
  status: 'published',
  allocationTotal: 10_000,
  reservedBoxes: 0,
  oddsVersion: 'series-001-v1',
  policyVersion: 'floor-policy-v1',
  inventory: PRIZES.map((prize) => ({ prizeId: prize.id, assigned: assignedByPrize.get(prize.id) ?? 0 })),
  publishedPrizes: structuredClone(PRIZES),
  createdAt: at(1),
  publishedAt: at(10),
}]

const audits: AuditEntry[] = [{
  id: 'audit-seed-001',
  sequence: 1,
  outcome: 'applied',
  actorId: 'system',
  actorRole: 'super_admin',
  action: 'demo.seed',
  targetType: 'repository',
  targetId: 'local',
  reason: 'Loaded fictional public demo data',
  at: at(27),
  requestId: 'req-seed-001',
  after: { boxes: boxes.length, orders: orders.length },
}]

export function createDemoState(): DemoState {
  return structuredClone({
    schemaVersion: SCHEMA_VERSION,
    revision: 1,
    nextSequence: 1000,
    auditCount: audits.length,
    auditHeadId: audits.at(-1)!.id,
    sessionUserId: null,
    users,
    series,
    cart: [{ seriesId: SERIES_ID, quantity: 1, unitPriceSen: BOX_PRICE_SEN }],
    orders,
    payments,
    boxes,
    shipments,
    claims: [],
    audits,
  })
}
