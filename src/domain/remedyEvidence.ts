import type {
  AuditEntry,
  Claim,
  ClaimRemedyState,
  DemoState,
  Shipment,
  ShipmentStatus,
} from './types'

export const RMA_CREATED_ACTION = 'claim.rma_created'
export const RMA_RECEIVED_ACTION = 'claim.rma_received'
export const RMA_INSPECTED_ACTION = 'claim.rma_inspected'
export const REPLACEMENT_AUTHORIZED_ACTION = 'claim.replacement_authorized'
export const REPLACEMENT_DELIVERED_ACTION = 'claim.replacement_delivered'

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactRecord(
  value: unknown,
  expected: Record<string, unknown>,
) {
  if (!record(value)) return false
  const keys = Object.keys(expected).sort()
  const actualKeys = Object.keys(value)
  return (
    actualKeys.length === keys.length &&
    actualKeys.every((key, index) => key === keys[index]) &&
    keys.every((key) => JSON.stringify(value[key]) === JSON.stringify(expected[key]))
  )
}

function matchingClaimAudit(
  state: DemoState,
  claim: Claim,
  action: string,
  at: string,
  reason: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  roles: string[],
) {
  return state.audits.find((audit) =>
    audit.outcome === 'applied' &&
    roles.includes(audit.actorRole) &&
    audit.action === action &&
    audit.targetType === 'claim' &&
    audit.targetId === claim.id &&
    audit.reason === reason &&
    audit.at === at &&
    exactRecord(audit.before, before) &&
    exactRecord(audit.after, after),
  )
}

export function matchingRmaAudit(
  state: DemoState,
  claim: Claim,
  action: typeof RMA_CREATED_ACTION | typeof RMA_RECEIVED_ACTION | typeof RMA_INSPECTED_ACTION,
  at: string,
  reason: string,
  beforeState: ClaimRemedyState,
  beforeStatus: string | null,
  afterState: ClaimRemedyState,
  afterStatus: string,
) {
  return matchingClaimAudit(
    state,
    claim,
    action,
    at,
    reason,
    { remedyState: beforeState, rmaStatus: beforeStatus },
    {
      remedyState: afterState,
      rmaReference: claim.rma?.reference,
      rmaStatus: afterStatus,
    },
    ['support', 'admin', 'super_admin'],
  )
}

export function matchingReplacementAuthorizationAudit(
  state: DemoState,
  claim: Claim,
  original: Shipment,
  replacement: Shipment,
) {
  const evidence = claim.replacementAuthorization
  if (!evidence) return undefined
  const beforeState = claim.rma ? 'rma_inspected' : 'none'
  return matchingClaimAudit(
    state,
    claim,
    REPLACEMENT_AUTHORIZED_ACTION,
    evidence.at,
    evidence.reason,
    {
      originalShipmentId: original.id,
      remedyState: beforeState,
    },
    {
      remedyState: 'replacement_authorized',
      replacementShipmentId: replacement.id,
    },
    ['fulfilment', 'admin', 'super_admin'],
  )
}

export function matchingReplacementDeliveryAudit(
  state: DemoState,
  claim: Claim,
  replacement: Shipment,
) {
  const history = claim.history.at(-1)
  if (!history || history.status !== 'resolved') return undefined
  return matchingClaimAudit(
    state,
    claim,
    REPLACEMENT_DELIVERED_ACTION,
    history.at,
    history.note,
    {
      remedyState: 'replacement_authorized',
      status: 'approved',
    },
    {
      remedyState: 'replacement_delivered',
      replacementShipmentId: replacement.id,
      resolutionOutcome: 'replacement_authorized',
      resolutionReference: replacement.id,
      status: 'resolved',
    },
    ['fulfilment', 'admin', 'super_admin'],
  )
}

export function matchingReplacementTransitionAudit(
  state: DemoState,
  shipment: Shipment,
  index: number,
): AuditEntry | undefined {
  const entry = shipment.timeline[index]
  const previous = shipment.timeline[index - 1]
  if (!entry || !previous) return undefined
  if (entry.status === 'cancelled' && entry.financialHold) {
    return state.audits.find((audit) =>
      audit.outcome === 'applied' &&
      ['finance', 'admin', 'super_admin'].includes(audit.actorRole) &&
      audit.action === `order.financial_hold_${entry.financialHold}` &&
      audit.targetType === 'order' &&
      audit.targetId === shipment.orderId &&
      audit.reason === entry.label &&
      audit.at === entry.at &&
      record(audit.before) &&
      Array.isArray(audit.before.shipments) &&
      audit.before.shipments.some((value) =>
        record(value) &&
        value.id === shipment.id &&
        value.status === previous.status) &&
      record(audit.after) &&
      Array.isArray(audit.after.stoppedShipmentIds) &&
      audit.after.stoppedShipmentIds.includes(shipment.id),
    )
  }
  if (
    previous.status === 'cancelled' &&
    previous.financialHold === 'disputed' &&
    entry.status === 'unfulfilled'
  ) {
    return state.audits.find((audit) =>
      audit.outcome === 'applied' &&
      ['finance', 'admin', 'super_admin'].includes(audit.actorRole) &&
      audit.action === 'order.dispute_resolved' &&
      audit.targetType === 'order' &&
      audit.targetId === shipment.orderId &&
      audit.reason === entry.label &&
      audit.at === entry.at &&
      exactRecord(audit.before, { status: 'disputed' }) &&
      record(audit.after) &&
      typeof audit.after.status === 'string' &&
      exactRecord(audit.after, { status: audit.after.status }),
    )
  }
  return state.audits.find((audit) =>
    audit.outcome === 'applied' &&
    ['fulfilment', 'admin', 'super_admin'].includes(audit.actorRole) &&
    audit.action === 'shipment.transitioned' &&
    audit.targetType === 'shipment' &&
    audit.targetId === shipment.id &&
    audit.reason === entry.label &&
    audit.at === entry.at &&
    exactRecord(audit.before, { status: previous.status }) &&
    record(audit.after) &&
    typeof audit.after.orderStatus === 'string' &&
    typeof audit.after.financialHoldPreserved === 'boolean' &&
    [
      'confirmed',
      'processing',
      'partially_fulfilled',
      'fulfilled',
      'closed',
      'cancelled',
      'refunded',
      'disputed',
    ].includes(audit.after.orderStatus) &&
    exactRecord(audit.after, {
      financialHoldPreserved: audit.after.financialHoldPreserved,
      orderStatus: audit.after.orderStatus,
      status: entry.status,
    }),
  )
}

export function replacementTerminalStatus(status: ShipmentStatus) {
  return ['failed', 'failed_delivery', 'lost', 'returned'].includes(status)
}
