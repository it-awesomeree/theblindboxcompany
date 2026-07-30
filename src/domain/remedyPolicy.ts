import { assert } from './guards'
import {
  shipmentClaimEligibilityAtAudit,
} from './claimEligibility'
import { CLAIM_EVIDENCE_WIDENING_NOTE } from './claimStatus'
import {
  compareAuditMoments,
  earliestAudit,
  sameInstant,
  type AuditMoment,
} from './auditSequence'
import {
  RMA_CREATED_ACTION,
  matchingReplacementAuthorizationAudit,
  matchingReplacementDeliveryAudit,
  matchingRmaAudit,
} from './remedyEvidence'
import {
  matchingAppliedClaimRefundLinkAudit,
  matchingAppliedPaymentRefundAudit,
} from './refundLink'
import {
  acceptedDisputeResolutionShapeIsValid,
  acceptedRefundedSenBeforePaymentEvent,
  immediatePriorAcceptedPaymentStatus,
} from './paymentEligibility'
import type {
  Claim,
  ClaimKind,
  AuditEntry,
  DemoState,
  Order,
  Payment,
  Shipment,
} from './types'

const REMEDY_ENTITLEMENT_STATES = new Set<Claim['remedyState']>([
  'rma_created',
  'rma_received',
  'rma_inspected',
  'replacement_authorized',
  'replacement_delivered',
  'refund_linked',
  'refund_completed',
])

const GRANDFATHERED_COMPLETION_OUTCOMES = new Set<
  NonNullable<Claim['resolutionOutcome']>
>([
  'replacement_authorized',
  'refund_recorded',
])

export const REMEDY_SCOPE_CONFLICT_CODE = 'REMEDY_SCOPE_CONFLICT'
export const CLAIM_ORDER_FINANCIAL_HOLD_CODE =
  'CLAIM_ORDER_FINANCIAL_HOLD'
export const FULL_REFUND_REMEDY_CONFLICT_CODE =
  'FULL_REFUND_REMEDY_CONFLICT'
export const CLAIM_REMEDY_SCOPE_UNAVAILABLE_CODE =
  'CLAIM_REMEDY_SCOPE_UNAVAILABLE'
export const POST_DELIVERY_REPLACEMENT_REQUIRES_RETURN_CODE =
  'POST_DELIVERY_REPLACEMENT_REQUIRES_RETURN'

const CLAIM_ORDER_FINANCIAL_HOLD_STATUSES = new Set<Order['status']>([
  'cancelled',
  'refunded',
  'disputed',
])

export interface RemedyScopeConflict {
  orderId: string
  holderClaimId: string
  remedyBoxIds: string[]
}

function claimHoldsOrdinaryRemedyEntitlement(claim: Claim) {
  if (
    claim.status === 'rejected' ||
    claim.legacyUnderSettledRefund === true
  ) {
    return false
  }
  return (
    REMEDY_ENTITLEMENT_STATES.has(claim.remedyState) ||
    (
      claim.status === 'resolved' &&
      claim.resolutionOutcome !== undefined &&
      GRANDFATHERED_COMPLETION_OUTCOMES.has(claim.resolutionOutcome)
    )
  )
}

export function claimHoldsRemedyEntitlement(claim: Claim): boolean
export function claimHoldsRemedyEntitlement(
  state: Pick<DemoState, 'audits' | 'payments' | 'shipments'>,
  claim: Claim,
): boolean
export function claimHoldsRemedyEntitlement(
  stateOrClaim:
    | Claim
    | Pick<DemoState, 'audits' | 'payments' | 'shipments'>,
  possibleClaim?: Claim,
) {
  const claim = possibleClaim ?? stateOrClaim as Claim
  if (claim.legacyUnderSettledRefund !== true) {
    return claimHoldsOrdinaryRemedyEntitlement(claim)
  }
  return possibleClaim
    ? claimHasPreservedLegacyUnderSettledHistory(
        stateOrClaim as Pick<
          DemoState,
          'audits' | 'payments' | 'shipments'
        >,
        claim,
      )
    : false
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactRecord(
  value: unknown,
  expected: Record<string, unknown>,
) {
  if (!record(value)) return false
  const expectedKeys = Object.keys(expected).sort()
  return (
    JSON.stringify(Object.keys(value)) === JSON.stringify(expectedKeys) &&
    expectedKeys.every((key) =>
      JSON.stringify(value[key]) === JSON.stringify(expected[key]))
  )
}

function matchingCompletedClaimResolutionAudit(
  state: Pick<DemoState, 'audits'>,
  claim: Claim,
) {
  const history = claim.history.at(-1)
  if (
    !history ||
    history.status !== 'resolved' ||
    history.note !== claim.resolutionNote ||
    !claim.resolutionOutcome ||
    !claim.resolutionReference ||
    !claim.resolutionNote
  ) {
    return undefined
  }
  const matches = state.audits.filter((audit) =>
    audit.outcome === 'applied' &&
    ['support', 'admin', 'super_admin'].includes(audit.actorRole) &&
    audit.action === 'claim.resolve' &&
    audit.targetType === 'claim' &&
    audit.targetId === claim.id &&
    audit.reason === claim.resolutionNote &&
    sameInstant(audit.at, history.at) &&
    audit.actorId === history.actorId &&
    audit.actorRole === history.actorRole &&
    exactRecord(audit.before, { status: 'approved' }) &&
    exactRecord(audit.after, {
      linkedRefundEventId: claim.linkedRefundEventId,
      refundCreated: false,
      resolutionOutcome: claim.resolutionOutcome,
      resolutionReference: claim.resolutionReference,
      status: 'resolved',
    }))
  return matches.length === 1 ? matches[0] : undefined
}

function exactGrandfatheredCompletionAudit(
  state: Pick<DemoState, 'audits'>,
  claim: Claim,
) {
  if (
    claim.legacyTypedResolution !== true ||
    claim.legacyUnderSettledRefund === true ||
    claim.status !== 'resolved' ||
    claim.remedyState !== 'none' ||
    !claim.resolutionOutcome ||
    !GRANDFATHERED_COMPLETION_OUTCOMES.has(claim.resolutionOutcome) ||
    !claim.resolutionReference ||
    !claim.resolutionNote
  ) {
    return undefined
  }
  const history = claim.history.at(-1)
  if (!history || history.status !== 'resolved') return undefined
  const matches = state.audits.filter((entry) =>
    entry.outcome === 'applied' &&
    ['support', 'admin', 'super_admin'].includes(entry.actorRole) &&
    entry.action === 'claim.resolve' &&
    entry.targetType === 'claim' &&
    entry.targetId === claim.id &&
    entry.reason === claim.resolutionNote &&
    sameInstant(entry.at, history.at) &&
    entry.actorId === history.actorId &&
    entry.actorRole === history.actorRole &&
    exactRecord(entry.before, { status: 'approved' }) &&
    exactRecord(entry.after, {
      refundCreated: false,
      resolutionOutcome: claim.resolutionOutcome,
      resolutionReference: claim.resolutionReference,
      status: 'resolved',
    }))
  return matches.length === 1 ? matches[0] : undefined
}

function exactLinkedRefund(
  state: Pick<DemoState, 'payments'>,
  claim: Claim,
) {
  if (!claim.linkedRefundEventId) return undefined
  const matches = state.payments.flatMap((payment) =>
    payment.events
      .filter((event) => event.id === claim.linkedRefundEventId)
      .map((event) => ({ event, payment })))
  return matches.length === 1 ? matches[0] : undefined
}

function acceptedRefundedBeforeEvent(
  payment: Payment,
  eventId: string,
) {
  const eventIndex = payment.events.findIndex((event) => event.id === eventId)
  if (eventIndex < 0) return undefined
  return payment.events
    .slice(0, eventIndex)
    .reduce(
      (sum, event) =>
        sum + (event.ignoredReason ? 0 : (event.refundIntent?.amountSen ?? 0)),
      0,
    )
}

export function claimHasPreservedLegacyUnderSettledHistory(
  state: Pick<DemoState, 'audits' | 'payments' | 'shipments'>,
  claim: Claim,
) {
  if (
    claim.status !== 'resolved' ||
    claim.remedyState !== 'refund_completed' ||
    claim.resolutionOutcome !== 'refund_recorded' ||
    claim.legacyUnderSettledRefund !== true ||
    claim.legacyTypedResolution === true ||
    claim.settlementPolicy !== undefined ||
    !claim.linkedRefundEventId ||
    claim.resolutionReference !== claim.linkedRefundEventId ||
    !Number.isInteger(claim.acceptedSettlementSen) ||
    claim.acceptedSettlementSen! <= 0 ||
    claim.acceptedSettlementSen! >= claim.requiredSettlementSen
  ) {
    return false
  }
  const linked = exactLinkedRefund(state, claim)
  return Boolean(
    linked &&
    claimHasAcceptedLinkedRefundOnPayment(claim, linked.payment) &&
    matchingAppliedPaymentRefundAudit(
      state as DemoState,
      linked.payment,
      linked.event,
      claim,
    ) &&
    matchingAppliedClaimRefundLinkAudit(
      state as DemoState,
      linked.payment,
      linked.event,
      claim,
    ) &&
    matchingCompletedClaimResolutionAudit(state, claim),
  )
}

export function claimHasCompletedRemedyHistory(
  state: Pick<DemoState, 'audits' | 'payments' | 'shipments'>,
  claim: Claim,
) {
  if (
    claim.legacyTypedResolution === true ||
    claim.legacyUnderSettledRefund === true ||
    claim.status !== 'resolved'
  ) {
    return false
  }
  if (
    claim.remedyState === 'refund_completed' &&
    claim.resolutionOutcome === 'refund_recorded' &&
    claim.linkedRefundEventId !== undefined &&
    claim.resolutionReference === claim.linkedRefundEventId
  ) {
    const linked = exactLinkedRefund(state, claim)
    if (
      !linked ||
      !claimHasAcceptedLinkedRefundOnPayment(claim, linked.payment) ||
      !matchingAppliedPaymentRefundAudit(
        state as DemoState,
        linked.payment,
        linked.event,
        claim,
      ) ||
      !matchingAppliedClaimRefundLinkAudit(
        state as DemoState,
        linked.payment,
        linked.event,
        claim,
      ) ||
      !matchingCompletedClaimResolutionAudit(state, claim)
    ) {
      return false
    }
    const priorRefundedSen = acceptedRefundedBeforeEvent(
      linked.payment,
      linked.event.id,
    )
    if (priorRefundedSen === undefined) return false
    const replacement = claim.replacementShipmentId
      ? state.shipments.find((shipment) =>
          shipment.id === claim.replacementShipmentId &&
          shipment.orderId === claim.orderId &&
          shipment.sourceClaimId === claim.id &&
          shipment.purpose === 'replacement')
      : undefined
    return (
      claim.settlementPolicy === 'exact_scope'
        ? replacement === undefined &&
          claim.acceptedSettlementSen === claim.requiredSettlementSen
        : claim.settlementPolicy === 'terminal_replacement_fallback' &&
          isTerminalReplacementRefundFallback(replacement) &&
          claim.acceptedSettlementSen === terminalReplacementFallbackAmount(
            claim.requiredSettlementSen,
            linked.payment.amountSen - priorRefundedSen,
          )
    )
  }
  if (
    claim.remedyState === 'replacement_delivered' &&
    claim.resolutionOutcome === 'replacement_authorized' &&
    claim.replacementShipmentId !== undefined &&
    claim.resolutionReference === claim.replacementShipmentId
  ) {
    const replacements = state.shipments.filter((shipment) =>
      shipment.id === claim.replacementShipmentId &&
      shipment.orderId === claim.orderId &&
      shipment.sourceClaimId === claim.id &&
      shipment.purpose === 'replacement' &&
      shipment.status === 'delivered')
    if (replacements.length !== 1) return false
    const replacement = replacements[0]
    const original = state.shipments.find((shipment) =>
      shipment.id === replacement.replacementForShipmentId &&
      shipment.orderId === claim.orderId &&
      shipment.purpose === 'original')
    return Boolean(
      original &&
      matchingReplacementAuthorizationAudit(
        state as DemoState,
        claim,
        original,
        replacement,
      ) &&
      matchingReplacementDeliveryAudit(
        state as DemoState,
        claim,
        replacement,
      ),
    )
  }
  return false
}

function claimCompletedRemedyAudit(
  state: Pick<DemoState, 'audits' | 'payments' | 'shipments'>,
  claim: Claim,
) {
  if (claimHasPreservedLegacyUnderSettledHistory(state, claim)) {
    return matchingCompletedClaimResolutionAudit(state, claim)
  }
  if (!claimHasCompletedRemedyHistory(state, claim)) return undefined
  if (claim.remedyState === 'refund_completed') {
    return matchingCompletedClaimResolutionAudit(state, claim)
  }
  const replacement = claim.replacementShipmentId
    ? state.shipments.find((shipment) =>
        shipment.id === claim.replacementShipmentId &&
        shipment.orderId === claim.orderId &&
        shipment.purpose === 'replacement' &&
        shipment.sourceClaimId === claim.id)
    : undefined
  return replacement
    ? matchingReplacementDeliveryAudit(
        state as DemoState,
        claim,
        replacement,
      )
    : undefined
}

export function preservedCompletedClaimIdsForUnlinkedRefund(
  state: Pick<
    DemoState,
    'audits' | 'claims' | 'payments' | 'shipments'
  >,
  payment: Payment,
  boundary?: AuditMoment,
) {
  return [...new Set(state.claims
    .filter((claim) => claim.orderId === payment.orderId)
    .filter((claim) => {
      const completion = claimCompletedRemedyAudit(state, claim)
      return Boolean(
        completion &&
        (!boundary || compareAuditMoments(completion, boundary) <= 0),
      )
    })
    .map((claim) => claim.id))]
    .sort((left, right) => left.localeCompare(right))
}

export function matchingAppliedUnlinkedRefundAudit(
  state: Pick<
    DemoState,
    'audits' | 'claims' | 'orders' | 'payments' | 'shipments'
  >,
  payment: Payment,
  event: Payment['events'][number],
) {
  const eventIndex = payment.events.findIndex((entry) => entry.id === event.id)
  const intent = event.refundIntent
  if (
    eventIndex < 0 ||
    !intent ||
    event.ignoredReason !== undefined ||
    event.source !== 'admin_reconcile' ||
    intent.paymentId !== payment.id ||
    intent.claimId !== undefined ||
    !['partially_refunded', 'refunded'].includes(event.type)
  ) {
    return undefined
  }
  const priorStatus = immediatePriorAcceptedPaymentStatus(payment, eventIndex)
  const priorRefundedSen = acceptedRefundedSenBeforePaymentEvent(
    payment,
    eventIndex,
  )
  if (
    priorStatus === undefined ||
    priorRefundedSen === undefined
  ) {
    return undefined
  }
  const expectedRefundedSen = priorRefundedSen + intent.amountSen
  const disputeOrigin = priorStatus === 'disputed'
  if (
    disputeOrigin &&
    !acceptedDisputeResolutionShapeIsValid(state, payment, eventIndex)
  ) {
    return undefined
  }
  const matches = state.audits.filter((audit) => {
    if (
      audit.outcome !== 'applied' ||
      !['finance', 'admin', 'super_admin'].includes(audit.actorRole) ||
      audit.action !== (
        event.type === 'refunded'
          ? 'payment.refunded'
          : 'payment.partially_refunded'
      ) ||
      audit.targetType !== 'payment' ||
      audit.targetId !== payment.id ||
      audit.reason !== intent.reason ||
      !sameInstant(event.createdAt, event.processedAt) ||
      !sameInstant(audit.at, event.processedAt) ||
      audit.requestId !== event.requestId ||
      audit.eventId !== event.id ||
      !exactRecord(audit.before, {
        refundedSen: priorRefundedSen,
        status: priorStatus,
      })
    ) {
      return false
    }
    const preservedCompletedClaimIds =
      preservedCompletedClaimIdsForUnlinkedRefund(
        state,
        payment,
        audit,
      )
    return exactRecord(audit.after, {
      allocationsReturned: 0,
      amountSen: intent.amountSen,
      ...(disputeOrigin ? { orderStatus: 'refunded' } : {}),
      ...(preservedCompletedClaimIds.length > 0
        ? { preservedCompletedClaimIds }
        : {}),
      refundedSen: expectedRefundedSen,
      status: event.type,
    })
  })
  return matches.length === 1 ? matches[0] : undefined
}

export function matchingAcceptedProtectedPaymentEventAudit(
  state: Pick<
    DemoState,
    'audits' | 'claims' | 'orders' | 'payments' | 'shipments'
  >,
  payment: Payment,
  event: Payment['events'][number],
) {
  if (event.refundIntent && event.refundIntent.claimId === undefined) {
    return matchingAppliedUnlinkedRefundAudit(state, payment, event)
  }
  const eventIndex = payment.events.findIndex((entry) => entry.id === event.id)
  if (
    eventIndex <= 0 ||
    event.ignoredReason !== undefined ||
    event.source !== 'admin_reconcile'
  ) {
    return undefined
  }
  const priorStatus = immediatePriorAcceptedPaymentStatus(payment, eventIndex)
  if (event.type !== 'disputed' && priorStatus !== 'disputed') {
    return undefined
  }
  const matches = state.audits.filter((audit) =>
    audit.outcome === 'applied' &&
    ['finance', 'admin', 'super_admin'].includes(audit.actorRole) &&
    audit.action === `payment.${event.type}` &&
    audit.targetType === 'payment' &&
    audit.targetId === payment.id &&
    sameInstant(event.createdAt, event.processedAt) &&
    sameInstant(audit.at, event.processedAt) &&
    audit.requestId === event.requestId &&
    audit.eventId === event.id &&
    exactRecord(audit.before, { status: priorStatus }) &&
    record(audit.after) &&
    typeof audit.after.orderStatus === 'string' &&
    exactRecord(audit.after, {
      orderStatus: audit.after.orderStatus,
      status: event.type,
    }))
  return matches.length === 1 ? matches[0] : undefined
}

export function claimBlocksFullPaymentRefund(
  state: Pick<DemoState, 'audits' | 'payments' | 'shipments'>,
  claim: Claim,
) {
  if (
    claim.status === 'rejected' ||
    (
      claim.status === 'resolved' &&
      claim.resolutionOutcome === 'no_remedy'
    )
  ) {
    return false
  }
  if (claimHasPreservedLegacyUnderSettledHistory(state, claim)) return false
  if (claimHasCompletedRemedyHistory(state, claim)) return false
  return true
}

export function claimHasAcceptedLinkedRefundOnPayment(
  claim: Claim,
  payment: Payment,
) {
  if (
    claim.orderId !== payment.orderId ||
    claim.userId !== payment.userId ||
    claim.linkedRefundEventId === undefined ||
    !Number.isInteger(claim.acceptedSettlementSen) ||
    claim.acceptedSettlementSen! <= 0
  ) {
    return false
  }
  const acceptedClaimState =
    (
      claim.status === 'approved' &&
      claim.remedyState === 'refund_linked'
    ) ||
    (
      claim.status === 'resolved' &&
      claim.remedyState === 'refund_completed' &&
      claim.resolutionOutcome === 'refund_recorded' &&
      claim.resolutionReference === claim.linkedRefundEventId
    )
  if (!acceptedClaimState) return false
  const matches = payment.events.filter((event) =>
    event.id === claim.linkedRefundEventId)
  if (matches.length !== 1) return false
  const event = matches[0]
  return (
    event.source === 'admin_reconcile' &&
    event.ignoredReason === undefined &&
    ['partially_refunded', 'refunded'].includes(event.type) &&
    event.refundIntent?.paymentId === payment.id &&
    event.refundIntent.claimId === claim.id &&
    event.refundIntent.amountSen === claim.acceptedSettlementSen
  )
}

export function assertFullPaymentRefundCompatible(
  state: Pick<
    DemoState,
    'audits' | 'claims' | 'payments' | 'shipments'
  >,
  payment: Payment,
  completingClaimId?: string,
) {
  const blocker = state.claims.find((claim) => {
    if (
      claim.orderId !== payment.orderId ||
      claim.id === completingClaimId ||
      !claimBlocksFullPaymentRefund(state, claim)
    ) {
      return false
    }
    return (
      completingClaimId === undefined ||
      !claimHasAcceptedLinkedRefundOnPayment(claim, payment)
    )
  })
  assert(
    blocker === undefined,
    blocker
      ? `Full refund of payment ${payment.id} is blocked by claim ${blocker.id}.`
      : 'Full payment refund is compatible with claim remedies.',
    FULL_REFUND_REMEDY_CONFLICT_CODE,
  )
}

export function claimRemedyEntitlementStartedAt(
  state: Pick<DemoState, 'audits' | 'payments' | 'shipments'>,
  claim: Claim,
) {
  return claimRemedyEntitlementStartedMoment(state, claim)?.at
}

function claimRemedyEntitlementAudits(
  state: Pick<DemoState, 'audits' | 'payments' | 'shipments'>,
  claim: Claim,
) {
  if (!claimHoldsRemedyEntitlement(state, claim)) return []
  const audits: AuditEntry[] = []
  if (claim.rma) {
    const audit = matchingRmaAudit(
      state as DemoState,
      claim,
      RMA_CREATED_ACTION,
      claim.rma.createdAt,
      claim.rma.createdReason,
      'none',
      null,
      'rma_created',
      'created',
    )
    if (audit) audits.push(audit)
  }
  if (claim.replacementShipmentId) {
    const replacement = state.shipments.find((shipment) =>
      shipment.id === claim.replacementShipmentId &&
      shipment.orderId === claim.orderId &&
      shipment.purpose === 'replacement' &&
      shipment.sourceClaimId === claim.id)
    const original = replacement
      ? state.shipments.find((shipment) =>
          shipment.id === replacement.replacementForShipmentId &&
          shipment.orderId === claim.orderId &&
          shipment.purpose === 'original')
      : undefined
    const audit = replacement && original
      ? matchingReplacementAuthorizationAudit(
          state as DemoState,
          claim,
          original,
          replacement,
        )
      : undefined
    if (audit) audits.push(audit)
  }
  const linked = exactLinkedRefund(state, claim)
  if (linked) {
    const audit = matchingAppliedClaimRefundLinkAudit(
      state as DemoState,
      linked.payment,
      linked.event,
      claim,
    )
    if (audit) audits.push(audit)
  }
  const grandfathered = exactGrandfatheredCompletionAudit(state, claim)
  if (grandfathered) audits.push(grandfathered)
  return audits
}

export function claimRemedyEntitlementStartedMoment(
  state: Pick<DemoState, 'audits' | 'payments' | 'shipments'>,
  claim: Claim,
) {
  return earliestAudit(claimRemedyEntitlementAudits(state, claim))
}

export function claimHoldsRemedyEntitlementAtMoment(
  state: Pick<DemoState, 'audits' | 'payments' | 'shipments'>,
  claim: Claim,
  boundary: AuditMoment,
) {
  const started = claimRemedyEntitlementStartedMoment(state, claim)
  return Boolean(started && compareAuditMoments(started, boundary) <= 0)
}

export function claimHoldsRemedyEntitlementAt(
  state: Pick<DemoState, 'audits' | 'payments' | 'shipments'>,
  claim: Claim,
  at: string,
) {
  return claimHoldsRemedyEntitlementAtMoment(state, claim, {
    at,
    sequence: Number.MAX_SAFE_INTEGER,
  })
}

export function matchingClaimSubmissionAudit(
  state: Pick<DemoState, 'audits'>,
  claim: Claim,
) {
  const firstWidening = state.audits
    .filter((audit) =>
      audit.outcome === 'applied' &&
      audit.actorId === claim.userId &&
      audit.actorRole === 'customer' &&
      audit.action === 'claim.order_level_evidence_widened' &&
      audit.targetType === 'claim' &&
      audit.targetId === claim.id &&
      audit.reason === CLAIM_EVIDENCE_WIDENING_NOTE &&
      record(audit.before) &&
      Array.isArray(audit.before.shipmentCandidateIds))
    .sort(compareAuditMoments)[0]
  const initialShipmentCandidateIds =
    firstWidening &&
    record(firstWidening.before) &&
    Array.isArray(firstWidening.before.shipmentCandidateIds)
      ? firstWidening.before.shipmentCandidateIds
      : claim.shipmentCandidateIds
  const expectedAfter = {
    ...(claim.boxId !== undefined ? { boxId: claim.boxId } : {}),
    kind: claim.kind,
    refundCreated: false,
    ...(initialShipmentCandidateIds !== undefined
      ? { shipmentCandidateIds: initialShipmentCandidateIds }
      : {}),
    ...(claim.shipmentId !== undefined ? { shipmentId: claim.shipmentId } : {}),
    status: 'submitted',
  }
  const matches = state.audits.filter((audit) =>
    audit.outcome === 'applied' &&
    audit.actorId === claim.userId &&
    audit.actorRole === 'customer' &&
    audit.action === 'claim.submitted' &&
    audit.targetType === 'claim' &&
    audit.targetId === claim.id &&
    audit.reason === claim.note &&
    sameInstant(audit.at, claim.createdAt) &&
    audit.requestId === claim.requestId &&
    audit.before === undefined &&
    exactRecord(audit.after, expectedAfter))
  return matches.length === 1 ? matches[0] : undefined
}

export function matchingClaimWideningAuditsAt(
  state: Pick<DemoState, 'audits'>,
  claim: Claim,
  at: string,
) {
  return state.audits.filter((audit) =>
    audit.outcome === 'applied' &&
    audit.actorId === claim.userId &&
    audit.actorRole === 'customer' &&
    audit.action === 'claim.order_level_evidence_widened' &&
    audit.targetType === 'claim' &&
    audit.targetId === claim.id &&
    audit.reason === CLAIM_EVIDENCE_WIDENING_NOTE &&
    sameInstant(audit.at, at))
}

function claimEvidenceBoundary(
  state: Pick<DemoState, 'audits' | 'claims'>,
  ignoreClaimId: string | undefined,
  at: string,
) {
  if (!ignoreClaimId) {
    return { at, sequence: Number.MAX_SAFE_INTEGER }
  }
  const claim = state.claims.find((entry) => entry.id === ignoreClaimId)
  if (!claim) return { at, sequence: Number.MAX_SAFE_INTEGER }
  const boundaries = [
    ...(sameInstant(claim.createdAt, at)
      ? [matchingClaimSubmissionAudit(state, claim)]
      : []),
    ...matchingClaimWideningAuditsAt(state, claim, at),
  ].filter((audit): audit is AuditEntry => Boolean(audit))
    .sort(compareAuditMoments)
  return boundaries.at(-1) ?? {
    at,
    sequence: Number.MAX_SAFE_INTEGER,
  }
}

export function claimHoldsRemedyEntitlementAtClaimEvidence(
  state: Pick<
    DemoState,
    'audits' | 'claims' | 'payments' | 'shipments'
  >,
  claim: Claim,
  at: string,
  evidenceClaimId: string,
) {
  return claimHoldsRemedyEntitlementAtMoment(
    state,
    claim,
    claimEvidenceBoundary(state, evidenceClaimId, at),
  )
}

export function availableClaimShipmentIdsAt(
  state: Pick<
    DemoState,
    'audits' | 'claims' | 'payments' | 'shipments'
  >,
  orderId: string,
  kind: Extract<ClaimKind, 'damage' | 'non_delivery'>,
  atOrBoundary: string | AuditMoment,
  ignoreClaimId?: string,
  excludeClaimIds: readonly string[] = [],
) {
  const boundary = typeof atOrBoundary === 'string'
    ? claimEvidenceBoundary(state, ignoreClaimId, atOrBoundary)
    : atOrBoundary
  const excludedClaims = new Set(excludeClaimIds)
  return state.shipments
    .filter((shipment) =>
      shipment.orderId === orderId &&
      shipment.purpose === 'original' &&
      shipmentClaimEligibilityAtAudit(
        state as DemoState,
        shipment,
        kind,
        boundary,
      ).eligible)
    .filter((shipment) =>
      !state.claims.some((claim) =>
        claim.id !== ignoreClaimId &&
        claim.orderId === orderId &&
        (
          excludedClaims.has(claim.id) ||
          claimHoldsRemedyEntitlementAtMoment(state, claim, boundary)
        ) &&
        shipment.boxIds.some((boxId) => claim.remedyBoxIds.includes(boxId))))
    .map((shipment) => shipment.id)
    .sort((left, right) => left.localeCompare(right))
}

export function findRemedyScopeConflict(
  state: Pick<
    DemoState,
    'audits' | 'claims' | 'payments' | 'shipments'
  >,
  currentClaim: Pick<Claim, 'id' | 'orderId' | 'remedyBoxIds'>,
): RemedyScopeConflict | undefined {
  const requestedBoxIds = new Set(currentClaim.remedyBoxIds)
  for (const holder of state.claims) {
    if (
      holder.id === currentClaim.id ||
      holder.orderId !== currentClaim.orderId ||
      !claimHoldsRemedyEntitlement(state, holder)
    ) {
      continue
    }
    const overlappingBoxIds = holder.remedyBoxIds.filter((boxId) =>
      requestedBoxIds.has(boxId))
    if (overlappingBoxIds.length > 0) {
      return {
        orderId: currentClaim.orderId,
        holderClaimId: holder.id,
        remedyBoxIds: overlappingBoxIds,
      }
    }
  }
  return undefined
}

export function assertNoRemedyScopeConflict(
  state: Pick<
    DemoState,
    'audits' | 'claims' | 'payments' | 'shipments'
  >,
  currentClaim: Pick<Claim, 'id' | 'orderId' | 'remedyBoxIds'>,
) {
  const conflict = findRemedyScopeConflict(state, currentClaim)
  assert(
    conflict === undefined,
    conflict
      ? `Claim ${currentClaim.id} overlaps remedy entitlement held by claim ${conflict.holderClaimId} for box scope ${conflict.remedyBoxIds.join(', ')}.`
      : 'Claim remedy entitlement scope is available.',
    REMEDY_SCOPE_CONFLICT_CODE,
  )
}

export function assertClaimOrderAllowsTypedRemedy(
  order: Pick<Order, 'status'>,
) {
  assert(
    !CLAIM_ORDER_FINANCIAL_HOLD_STATUSES.has(order.status),
    `Typed RMA and replacement work is unavailable while the claim order is ${order.status}.`,
    CLAIM_ORDER_FINANCIAL_HOLD_CODE,
  )
}

export function canonicalOrderBoxScope(
  order: Order,
  requestedBoxIds: readonly string[],
) {
  const requested = new Set(requestedBoxIds)
  assert(
    requested.size === requestedBoxIds.length &&
      requested.size > 0 &&
      requestedBoxIds.every((boxId) => order.boxIds.includes(boxId)),
    'Remedy box scope must contain unique boxes from the claim order.',
    'CLAIM_REMEDY_SCOPE_INVALID',
  )
  return order.boxIds.filter((boxId) => requested.has(boxId))
}

export function orderBoxSettlementAllocations(order: Order) {
  assert(
    order.boxIds.length === order.snapshot.quantity && order.boxIds.length > 0,
    'Order box order is inconsistent with its money snapshot.',
    'ORDER_BOX_SNAPSHOT_INVALID',
  )
  const shippingBase = Math.floor(
    order.snapshot.totals.shippingSen / order.boxIds.length,
  )
  const shippingRemainder =
    order.snapshot.totals.shippingSen % order.boxIds.length
  return order.boxIds.map((boxId, index) => ({
    boxId,
    amountSen:
      order.snapshot.unitPriceSen +
      shippingBase +
      (index < shippingRemainder ? 1 : 0),
  }))
}

export function requiredSettlementForBoxScope(
  order: Order,
  requestedBoxIds: readonly string[],
) {
  const scope = canonicalOrderBoxScope(order, requestedBoxIds)
  const requested = new Set(scope)
  return orderBoxSettlementAllocations(order)
    .filter((allocation) => requested.has(allocation.boxId))
    .reduce((sum, allocation) => sum + allocation.amountSen, 0)
}

export function remedyBoxIdsForEvidence(
  state: DemoState,
  order: Order,
  evidence: {
    kind: ClaimKind
    boxId?: string
    shipmentId?: string
    shipmentCandidateIds?: readonly string[]
  },
) {
  if (evidence.kind === 'value_floor') {
    assert(evidence.boxId, 'Value-floor remedy scope requires one box.', 'CLAIM_REMEDY_SCOPE_INVALID')
    return canonicalOrderBoxScope(order, [evidence.boxId])
  }
  const shipmentIds = evidence.shipmentCandidateIds ?? (
    evidence.shipmentId ? [evidence.shipmentId] : []
  )
  assert(
    shipmentIds.length > 0,
    'Delivery remedy scope requires original shipment evidence.',
    'CLAIM_REMEDY_SCOPE_INVALID',
  )
  const shipments = shipmentIds.map((shipmentId) =>
    state.shipments.find((shipment) =>
      shipment.id === shipmentId &&
      shipment.orderId === order.id &&
      shipment.purpose === 'original'))
  assert(
    shipments.every(Boolean),
    'Delivery remedy scope must use original shipments from the claim order.',
    'CLAIM_REMEDY_SCOPE_INVALID',
  )
  return canonicalOrderBoxScope(
    order,
    shipments.flatMap((shipment) => shipment!.boxIds),
  )
}

export function expectedClaimRemedySnapshot(
  state: DemoState,
  claim: Pick<
    Claim,
    'orderId' | 'kind' | 'boxId' | 'shipmentId' | 'shipmentCandidateIds'
  >,
) {
  const order = state.orders.find((entry) => entry.id === claim.orderId)
  assert(order, 'Claim order was not found.', 'ORDER_MISSING')
  const remedyBoxIds = remedyBoxIdsForEvidence(state, order, claim)
  return {
    remedyBoxIds,
    requiredSettlementSen: requiredSettlementForBoxScope(order, remedyBoxIds),
  }
}

export function isTerminalReplacementRefundFallback(
  replacement: Shipment | undefined,
) {
  if (!replacement || replacement.purpose !== 'replacement') return false
  return replacement.kind === 'DIGITAL'
    ? replacement.status === 'failed'
    : ['lost', 'returned'].includes(replacement.status)
}

export function remainingPaymentBalance(payment: Payment) {
  return payment.amountSen - payment.refundedSen
}

export function terminalReplacementFallbackAmount(
  requiredSettlementSen: number,
  priorRemainingPaymentSen: number,
) {
  assert(
    Number.isInteger(requiredSettlementSen) &&
      requiredSettlementSen > 0 &&
      Number.isInteger(priorRemainingPaymentSen) &&
      priorRemainingPaymentSen > 0,
    'Terminal replacement fallback inputs must be positive integer-sen amounts.',
    'CLAIM_SETTLEMENT_AMOUNT_INVALID',
  )
  return Math.min(requiredSettlementSen, priorRemainingPaymentSen)
}
