import type {
  AuditEntry,
  Claim,
  ClaimRemedyState,
  DemoState,
  Shipment,
  ShipmentStatus,
} from './types'
import { sameInstant } from './auditSequence'
import { makeId } from './guards'

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
  const matches = state.audits.filter((audit) =>
    audit.outcome === 'applied' &&
    roles.includes(audit.actorRole) &&
    audit.action === action &&
    audit.targetType === 'claim' &&
    audit.targetId === claim.id &&
    audit.reason === reason &&
    sameInstant(audit.at, at) &&
    exactRecord(audit.before, before) &&
    exactRecord(audit.after, after),
  )
  return matches.length === 1 ? matches[0] : undefined
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

export function matchingRmaReceivedAudit(
  state: DemoState,
  claim: Claim,
  original: Shipment,
) {
  const receivedAt = claim.rma?.receivedAt
  const receivedReason = claim.rma?.receivedReason
  if (!receivedAt || !receivedReason) return undefined
  const matches = state.audits.filter((audit) => {
    if (
      audit.outcome !== 'applied' ||
      !['support', 'admin', 'super_admin'].includes(audit.actorRole) ||
      audit.action !== RMA_RECEIVED_ACTION ||
      audit.targetType !== 'claim' ||
      audit.targetId !== claim.id ||
      audit.reason !== receivedReason ||
      !sameInstant(audit.at, receivedAt) ||
      !record(audit.before)
    ) {
      return false
    }
    const originalShipmentStatus = audit.before.originalShipmentStatus
    return (
      (originalShipmentStatus === 'delivered' ||
        originalShipmentStatus === 'returned') &&
      exactRecord(audit.before, {
        originalShipmentId: original.id,
        originalShipmentStatus,
        remedyState: 'rma_created',
        rmaStatus: 'created',
      }) &&
      exactRecord(audit.after, {
        originalShipmentId: original.id,
        originalShipmentStatus: 'returned',
        remedyState: 'rma_received',
        rmaReference: claim.rma?.reference,
        rmaStatus: 'received',
      })
    )
  })
  return matches.length === 1 ? matches[0] : undefined
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

function matchingFinancialStopShipmentIds(
  state: DemoState,
  audit: AuditEntry,
  financialHold: NonNullable<Shipment['timeline'][number]['financialHold']>,
  label: string,
  at: string,
) {
  if (
    !record(audit.before) ||
    !Array.isArray(audit.before.shipments)
  ) {
    return []
  }
  const beforeShipments = audit.before.shipments
  return state.shipments
    .filter((candidate) => {
      if (candidate.orderId !== audit.targetId) return false
      const beforeShipment = beforeShipments.find((value) =>
        record(value) && value.id === candidate.id)
      if (!record(beforeShipment) || typeof beforeShipment.status !== 'string') {
        return false
      }
      return candidate.timeline.some((candidateEntry, candidateIndex) =>
        candidateIndex > 0 &&
        candidateEntry.id === makeId(
          'stl',
          `${candidate.id}:financial-stop:${audit.requestId}`,
        ) &&
        candidateEntry.status === 'cancelled' &&
        candidateEntry.financialHold === financialHold &&
        candidateEntry.label === label &&
        sameInstant(candidateEntry.at, at) &&
        candidate.timeline[candidateIndex - 1]?.status === beforeShipment.status)
    })
    .map((candidate) => candidate.id)
    .sort((left, right) => left.localeCompare(right))
}

function matchingDisputeResumeShipmentIds(
  state: DemoState,
  audit: AuditEntry,
  label: string,
  at: string,
) {
  return state.shipments
    .filter((candidate) =>
      candidate.orderId === audit.targetId &&
      candidate.timeline.some((candidateEntry, candidateIndex) =>
        candidateIndex > 0 &&
        candidateEntry.id === makeId(
          'stl',
          `${candidate.id}:dispute-resolved:${audit.requestId}`,
        ) &&
        candidateEntry.status === 'unfulfilled' &&
        candidateEntry.label === label &&
        sameInstant(candidateEntry.at, at) &&
        candidate.timeline[candidateIndex - 1]?.status === 'cancelled' &&
        candidate.timeline[candidateIndex - 1]?.financialHold === 'disputed'))
    .map((candidate) => candidate.id)
    .sort((left, right) => left.localeCompare(right))
}

function matchingTransitionOccurrenceAudit(
  shipment: Shipment,
  index: number,
  matches: AuditEntry[],
  sameOccurrence: (
    entry: Shipment['timeline'][number],
    previous: Shipment['timeline'][number],
  ) => boolean,
) {
  const occurrenceIndexes = shipment.timeline.flatMap((candidate, candidateIndex) =>
    candidateIndex > 0 &&
    sameOccurrence(candidate, shipment.timeline[candidateIndex - 1])
      ? [candidateIndex]
      : [])
  const ordinal = occurrenceIndexes.indexOf(index)
  const orderedMatches = [...matches].sort((left, right) =>
    left.sequence - right.sequence)
  return (
    ordinal >= 0 &&
    orderedMatches.length === occurrenceIndexes.length
  )
    ? orderedMatches[ordinal]
    : undefined
}

export function matchingShipmentTransitionAudit(
  state: DemoState,
  shipment: Shipment,
  index: number,
): AuditEntry | undefined {
  const entry = shipment.timeline[index]
  const previous = shipment.timeline[index - 1]
  if (!entry || !previous) return undefined
  if (entry.status === 'cancelled' && entry.financialHold) {
    const matches = state.audits.filter((audit) =>
      audit.outcome === 'applied' &&
      ['finance', 'admin', 'super_admin'].includes(audit.actorRole) &&
      audit.action === `order.financial_hold_${entry.financialHold}` &&
      audit.targetType === 'order' &&
      audit.targetId === shipment.orderId &&
      audit.reason === entry.label &&
      sameInstant(audit.at, entry.at) &&
      entry.id === makeId(
        'stl',
        `${shipment.id}:financial-stop:${audit.requestId}`,
      ) &&
      record(audit.before) &&
      Array.isArray(audit.before.shipments) &&
      audit.before.shipments.some((value) =>
        record(value) &&
        value.id === shipment.id &&
        value.status === previous.status) &&
      record(audit.after) &&
      Array.isArray(audit.after.stoppedShipmentIds) &&
      JSON.stringify(audit.after.stoppedShipmentIds) ===
        JSON.stringify(matchingFinancialStopShipmentIds(
          state,
          audit,
          entry.financialHold!,
          entry.label,
          entry.at,
        )),
    )
    return matches.length === 1 ? matches[0] : undefined
  }
  if (
    previous.status === 'cancelled' &&
    previous.financialHold === 'disputed' &&
    entry.status === 'unfulfilled'
  ) {
    const matches = state.audits.filter((audit) =>
      audit.outcome === 'applied' &&
      ['finance', 'admin', 'super_admin'].includes(audit.actorRole) &&
      audit.action === 'order.dispute_resolved' &&
      audit.targetType === 'order' &&
      audit.targetId === shipment.orderId &&
      audit.reason === entry.label &&
      sameInstant(audit.at, entry.at) &&
      entry.id === makeId(
        'stl',
        `${shipment.id}:dispute-resolved:${audit.requestId}`,
      ) &&
      exactRecord(audit.before, { status: 'disputed' }) &&
      record(audit.after) &&
      typeof audit.after.status === 'string' &&
      Array.isArray(audit.after.resumedShipmentIds) &&
      exactRecord(audit.after, {
        resumedShipmentIds: matchingDisputeResumeShipmentIds(
          state,
          audit,
          entry.label,
          entry.at,
        ),
        status: audit.after.status,
      }),
    )
    return matches.length === 1 ? matches[0] : undefined
  }
  if (
    shipment.purpose === 'original' &&
    previous.status === 'delivered' &&
    entry.status === 'returned'
  ) {
    const matches = state.claims
      .map((claim) => matchingRmaReceivedAudit(state, claim, shipment))
      .filter((audit): audit is AuditEntry =>
        Boolean(
          audit &&
          audit.reason === entry.label &&
          sameInstant(audit.at, entry.at),
        ))
    if (matches.length === 1) return matches[0]
  }
  const matches = state.audits.filter((audit) =>
    audit.outcome === 'applied' &&
    ['fulfilment', 'admin', 'super_admin'].includes(audit.actorRole) &&
    audit.action === 'shipment.transitioned' &&
    audit.targetType === 'shipment' &&
    audit.targetId === shipment.id &&
    audit.reason === entry.label &&
    sameInstant(audit.at, entry.at) &&
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
  return matchingTransitionOccurrenceAudit(
    shipment,
    index,
    matches,
    (candidate, candidatePrevious) =>
      candidate.status === entry.status &&
      candidate.label === entry.label &&
      sameInstant(candidate.at, entry.at) &&
      candidatePrevious.status === previous.status,
  )
}

export function matchingReplacementTransitionAudit(
  state: DemoState,
  shipment: Shipment,
  index: number,
) {
  return matchingShipmentTransitionAudit(state, shipment, index)
}

export function replacementTerminalStatus(status: ShipmentStatus) {
  return ['failed', 'lost', 'returned'].includes(status)
}
