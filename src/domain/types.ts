export type Role =
  | 'customer'
  | 'support'
  | 'fulfilment'
  | 'finance'
  | 'catalog'
  | 'admin'
  | 'super_admin'

export type UserStatus = 'active' | 'suspended'
export type SeriesStatus = 'draft' | 'published'
export type PaymentStatus =
  | 'created'
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'partially_refunded'
  | 'refunded'
  | 'disputed'
export type OrderStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'processing'
  | 'partially_fulfilled'
  | 'fulfilled'
  | 'closed'
  | 'cancelled'
  | 'refunded'
  | 'disputed'
export type BoxStatus =
  | 'reserved'
  | 'paid_unopened'
  | 'opened'
  | 'fulfillment_pending'
  | 'fulfilled'
  | 'on_hold'
  | 'void'
export type ShipmentStatus =
  | 'unfulfilled'
  | 'picking'
  | 'packed'
  | 'label_created'
  | 'shipped'
  | 'issued'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'failed_delivery'
  | 'lost'
  | 'returned'
  | 'cancelled'
export type FulfilmentKind = 'PARCEL' | 'BULKY' | 'DIGITAL' | 'SELF_COLLECT'
export type ShipmentPurpose = 'original' | 'replacement'
export type ShippingMethod = 'standard' | 'priority' | 'self_collect'
export type PaymentMethod = 'FPX' | 'DUITNOW' | 'CARD' | 'GRABPAY' | 'TNG'

export interface User {
  id: string
  name: string
  email: string
  role: Role
  status: UserStatus
  createdAt: string
}

export interface Address {
  recipient: string
  line1: string
  line2: string
  postcode: string
  city: string
  state: string
  phone: string
  country: 'MY'
}

export interface PrizeDefinition {
  id: string
  name: string
  shortName: string
  valueSen: number
  allocation: number
  odds: string
  tier: 'Dapur' | 'Tech' | 'Grail'
  fulfilment: FulfilmentKind
  insured: boolean
  signatureRequired: boolean
}

export interface InventoryCounter {
  prizeId: string
  assigned: number
}

export interface PrizeSeries {
  id: string
  name: string
  status: SeriesStatus
  allocationTotal: number
  reservedBoxes: number
  oddsVersion: string
  policyVersion: string
  inventory: InventoryCounter[]
  publishedPrizes?: PrizeDefinition[]
  draftPrizes?: PrizeDefinition[]
  createdAt: string
  publishedAt?: string
}

export interface CartItem {
  seriesId: string
  quantity: number
  unitPriceSen: number
}

export interface OrderTotals {
  itemSubtotalSen: number
  shippingSen: number
  totalSen: number
}

export interface OrderSnapshot {
  itemName: string
  seriesId: string
  quantity: number
  unitPriceSen: number
  valueFloorSen: number
  shippingMethod: ShippingMethod
  address: Address
  oddsVersion: string
  policyVersion: string
  acknowledgement: string
  totals: OrderTotals
}

export interface OrderTimelineEntry {
  id: string
  status: OrderStatus
  label: string
  at: string
  financialHoldPreviousStatus?: OrderStatus
}

export interface Order {
  id: string
  checkoutRequestId: string
  userId: string
  status: OrderStatus
  snapshot: OrderSnapshot
  paymentIds: string[]
  boxIds: string[]
  claimIds: string[]
  reservationExpiresAt: string
  createdAt: string
  updatedAt: string
  timeline: OrderTimelineEntry[]
}

export interface PaymentEvent {
  id: string
  requestId: string
  type: PaymentStatus
  source: 'mock_webhook' | 'admin_reconcile' | 'reservation_clock'
  createdAt: string
  processedAt: string
  ignoredReason?: string
  refundIntent?: {
    paymentId: string
    amountSen: number
    reason: string
    claimId?: string
  }
}

export interface Payment {
  id: string
  orderId: string
  userId: string
  attempt: number
  method?: PaymentMethod
  status: PaymentStatus
  amountSen: number
  refundedSen: number
  createdAt: string
  updatedAt: string
  events: PaymentEvent[]
}

export interface Box {
  id: string
  manifestId: string
  orderId: string
  ownerId: string
  seriesId: string
  number: number
  status: BoxStatus
  prizeId?: string
  assignedAt?: string
  revealedAt?: string
  shipmentId?: string
}

export interface ShipmentTimelineEntry {
  id: string
  status: ShipmentStatus
  label: string
  at: string
  financialHold?: Extract<OrderStatus, 'cancelled' | 'refunded' | 'disputed'>
}

export interface Shipment {
  id: string
  orderId: string
  boxIds: string[]
  kind: FulfilmentKind
  purpose: ShipmentPurpose
  sourceClaimId?: string
  replacementForShipmentId?: string
  legacyRecordedBoxIds?: string[]
  status: ShipmentStatus
  carrier: string
  trackingNumber: string
  insured: boolean
  signatureRequired: boolean
  createdAt: string
  timeline: ShipmentTimelineEntry[]
}

export type ClaimKind = 'damage' | 'non_delivery' | 'value_floor'
export type ClaimStatus = 'submitted' | 'reviewing' | 'approved' | 'rejected' | 'resolved'
export type ClaimResolutionOutcome =
  | 'replacement_authorized'
  | 'return_rma_created'
  | 'refund_recorded'
  | 'no_remedy'
export type RmaStatus = 'created' | 'received' | 'inspected'
export type ClaimRemedyState =
  | 'none'
  | 'refund_linked'
  | 'refund_completed'
  | 'rma_created'
  | 'rma_received'
  | 'rma_inspected'
  | 'replacement_authorized'
  | 'replacement_delivered'
  | 'no_remedy'
export type ClaimSettlementPolicy =
  | 'exact_scope'
  | 'terminal_replacement_fallback'

export interface ClaimRmaEvidence {
  reference: string
  status: RmaStatus
  createdAt: string
  createdReason: string
  receivedAt?: string
  receivedReason?: string
  inspectedAt?: string
  inspectedReason?: string
}

export interface ReplacementAuthorizationEvidence {
  at: string
  reason: string
}

export interface ClaimHistoryEntry {
  id: string
  status: ClaimStatus
  note: string
  actorId: string
  actorRole: Role
  at: string
}

export interface Claim {
  id: string
  requestId: string
  orderId: string
  userId: string
  kind: ClaimKind
  note: string
  shipmentId?: string
  shipmentCandidateIds?: string[]
  shipmentCandidateEvidenceAt?: Record<string, string>
  boxId?: string
  status: ClaimStatus
  remedyState: ClaimRemedyState
  remedyBoxIds: string[]
  requiredSettlementSen: number
  acceptedSettlementSen?: number
  settlementPolicy?: ClaimSettlementPolicy
  rma?: ClaimRmaEvidence
  replacementShipmentId?: string
  replacementAuthorization?: ReplacementAuthorizationEvidence
  legacyTypedResolution?: true
  createdAt: string
  updatedAt: string
  resolutionNote?: string
  resolutionOutcome?: ClaimResolutionOutcome
  resolutionReference?: string
  linkedRefundEventId?: string
  legacyUnderSettledRefund?: true
  history: ClaimHistoryEntry[]
}

export interface AuditEntry {
  id: string
  sequence: number
  previousId?: string
  outcome: 'applied' | 'ignored'
  actorId: string
  actorRole: Role
  action: string
  targetType: string
  targetId: string
  reason: string
  at: string
  before?: import('./auditEvidence').AuditEvidence
  after?: import('./auditEvidence').AuditEvidence
  requestId: string
  eventId?: string
}

export interface DemoState {
  schemaVersion: 8
  revision: number
  nextSequence: number
  auditCount: number
  auditHeadId: string
  sessionUserId: string | null
  users: User[]
  series: PrizeSeries[]
  cart: CartItem[]
  orders: Order[]
  payments: Payment[]
  boxes: Box[]
  shipments: Shipment[]
  claims: Claim[]
  audits: AuditEntry[]
}

export interface OperationResult<T> {
  data: T
  changed: boolean
  message: string
}
