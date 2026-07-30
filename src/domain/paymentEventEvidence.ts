import {
  canTransitionPayment,
  makeId,
  sanitizeText,
} from './guards'
import { compareAuditMoments, sameInstant } from './auditSequence'
import {
  ACTIVE_PAYMENT_STATUSES,
  immediatePriorAcceptedPaymentStatus,
} from './paymentEligibility'
import type {
  AuditEntry,
  DemoState,
  IgnoredPaymentEventOutcome,
  Payment,
  PaymentEvent,
  PaymentEventRoute,
  PaymentStatus,
} from './types'

export const IGNORED_PAYMENT_EVENT_ACTION = 'payment.event_ignored'
export const LEGACY_IGNORED_EVENT_MIGRATION_ACTION =
  'migration.v8.ignored_payment_event'
export const LEGACY_IGNORED_EVENT_MIGRATION_REASON =
  'Preserved exact non-replayable schema 8 ignored payment event evidence'

export interface IgnoredPaymentEventEvidence {
  outcome: IgnoredPaymentEventOutcome
  priorStatus: PaymentStatus
  relatedPaymentId?: string
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
  const actualKeys = Object.keys(value)
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every((key) =>
      JSON.stringify(value[key]) === JSON.stringify(expected[key]))
  )
}

export function ignoredPaymentEventRequestId(eventId: string) {
  return makeId('req', eventId)
}

export function ignoredPaymentEventMessage(
  outcome: IgnoredPaymentEventOutcome,
) {
  return outcome === 'out_of_order'
    ? 'Out-of-order event was recorded without changing payment status.'
    : 'Conflicting success event was recorded and ignored safely.'
}

function matchingIgnoredEventBoundaryAudit(
  state: Pick<DemoState, 'audits'>,
  payment: Payment,
  event: PaymentEvent,
) {
  const matches = state.audits.filter((audit) =>
    audit.outcome === 'ignored' &&
    audit.action === IGNORED_PAYMENT_EVENT_ACTION &&
    audit.targetType === 'payment' &&
    audit.targetId === payment.id &&
    audit.reason === event.ignoredReason &&
    sameInstant(audit.at, event.processedAt) &&
    audit.requestId === event.requestId &&
    audit.eventId === event.id)
  return matches.length === 1 ? matches[0] : undefined
}

function matchingPaymentCreationAudit(
  state: Pick<DemoState, 'audits'>,
  payment: Payment,
) {
  const first = payment.events[0]
  if (!first || first.type !== 'created' || first.ignoredReason !== undefined) {
    return undefined
  }
  const matches = state.audits.filter((audit) => {
    if (
      audit.outcome !== 'applied' ||
      audit.targetType !== 'payment' ||
      audit.targetId !== payment.id ||
      !sameInstant(audit.at, payment.createdAt) ||
      audit.eventId !== undefined ||
      !record(audit.after)
    ) {
      return false
    }
    if (audit.action === 'payment.attempt_created') {
      return (
        audit.actorId === payment.userId &&
        audit.actorRole === 'customer' &&
        audit.requestId === makeId('req', `${payment.id}:attempt`) &&
        exactRecord(audit.after, {
          amountSen: payment.amountSen,
          attempt: payment.attempt,
          status: 'pending',
        })
      )
    }
    return (
      audit.action === 'payment.admin_retry' &&
      ['finance', 'admin', 'super_admin'].includes(audit.actorRole) &&
      audit.requestId === makeId('req', `${payment.id}:retry`) &&
      exactRecord(audit.after, {
        attempt: payment.attempt,
        paymentId: payment.id,
        status: 'pending',
      })
    )
  })
  return matches.length === 1 ? matches[0] : undefined
}

function matchingAcceptedPaymentEventAudit(
  state: Pick<DemoState, 'audits'>,
  payment: Payment,
  event: PaymentEvent,
) {
  const matches = state.audits.filter((audit) =>
    audit.outcome === 'applied' &&
    audit.action === `payment.${event.type}` &&
    audit.targetType === 'payment' &&
    audit.targetId === payment.id &&
    sameInstant(audit.at, event.processedAt) &&
    audit.requestId === event.requestId &&
    audit.eventId === event.id &&
    record(audit.after) &&
    audit.after.status === event.type)
  return matches.length === 1 ? matches[0] : undefined
}

function paymentStatusAuditMomentsThroughInstant(
  state: Pick<DemoState, 'audits'>,
  related: Payment,
  instant: string,
) {
  const moments: Array<{ audit: AuditEntry; status: PaymentStatus }> = []
  const first = related.events[0]
  if (!first) return undefined
  if (first.type === 'created') {
    const creation = matchingPaymentCreationAudit(state, related)
    if (
      !creation ||
      Date.parse(creation.at) > Date.parse(instant)
    ) {
      return undefined
    }
    moments.push({ audit: creation, status: 'pending' })
  }
  for (const [index, candidate] of related.events.entries()) {
    if (
      candidate.ignoredReason !== undefined ||
      (index === 0 && candidate.type === 'created') ||
      Date.parse(candidate.processedAt) > Date.parse(instant)
    ) {
      continue
    }
    const eventAudit = matchingAcceptedPaymentEventAudit(
      state,
      related,
      candidate,
    )
    if (!eventAudit) return undefined
    moments.push({ audit: eventAudit, status: candidate.type })
  }
  return moments.sort((left, right) =>
    compareAuditMoments(left.audit, right.audit))
}

function relatedPaymentEvidenceBeforeIgnoredAudit(
  state: Pick<DemoState, 'audits'>,
  related: Payment,
  boundary: AuditEntry,
) {
  const moments = paymentStatusAuditMomentsThroughInstant(
    state,
    related,
    boundary.at,
  )?.filter(({ audit }) => compareAuditMoments(audit, boundary) < 0)
  if (!moments) return undefined
  const ordered = moments
  const latest = ordered.at(-1)
  if (!latest) return undefined
  return {
    captured: ordered.some(({ status }) => status === 'succeeded'),
    status: latest.status,
  }
}

function legacyRelatedPaymentEvidenceAtInstant(
  state: Pick<DemoState, 'audits'>,
  related: Payment,
  instant: string,
  outcome: Extract<
    IgnoredPaymentEventOutcome,
    'other_payment_active' | 'other_payment_captured'
  >,
) {
  const moments = paymentStatusAuditMomentsThroughInstant(
    state,
    related,
    instant,
  )
  if (!moments?.length) return undefined
  if (outcome === 'other_payment_captured') {
    const captured = moments.find(({ status }) => status === 'succeeded')
    return captured
      ? { captured: true, status: moments.at(-1)!.status }
      : undefined
  }
  const active = moments
    .filter(({ status }) => ACTIVE_PAYMENT_STATUSES.includes(status))
    .filter(({ audit }) =>
      !moments.some((candidate) =>
        candidate.status === 'succeeded' &&
        compareAuditMoments(candidate.audit, audit) < 0))
    .at(-1)
  return active
    ? { captured: false, status: active.status }
    : undefined
}

export function inferIgnoredPaymentEventEvidence(
  state: Pick<DemoState, 'audits' | 'payments'>,
  payment: Payment,
  event: PaymentEvent,
  eventIndex: number,
): IgnoredPaymentEventEvidence | undefined {
  const priorStatus = immediatePriorAcceptedPaymentStatus(payment, eventIndex)
  if (!priorStatus || !event.ignoredReason || event.refundIntent !== undefined) {
    return undefined
  }
  const conflict = event.ignoredReason.match(
    /^Order (already captured by|has active payment) ([A-Za-z0-9_-]+)$/,
  )
  if (event.type === 'succeeded' && conflict) {
    const relatedPaymentId = conflict[2]
    const related = state.payments.filter((candidate) =>
      candidate.id === relatedPaymentId &&
      candidate.id !== payment.id &&
      candidate.orderId === payment.orderId)
    if (related.length !== 1) return undefined
    const boundary = matchingIgnoredEventBoundaryAudit(state, payment, event)
    const orderedEvidence = boundary
      ? relatedPaymentEvidenceBeforeIgnoredAudit(state, related[0], boundary)
      : legacyRelatedPaymentEvidenceAtInstant(
          state,
          related[0],
          event.processedAt,
          conflict[1] === 'already captured by'
            ? 'other_payment_captured'
            : 'other_payment_active',
        )
    // Schema 8 mock-webhook ignores had no audit boundary. They remain
    // non-replayable; exact related audit order is the only safe fallback.
    const relatedStatusAtEvent = orderedEvidence?.status
    const relatedWasCaptured = orderedEvidence?.captured ?? false
    if (
      (
        conflict[1] === 'already captured by' &&
        !relatedWasCaptured
      ) ||
      (
        conflict[1] === 'has active payment' &&
        (
          relatedWasCaptured ||
          !relatedStatusAtEvent ||
          !ACTIVE_PAYMENT_STATUSES.includes(relatedStatusAtEvent)
        )
      )
    ) {
      return undefined
    }
    return {
      outcome: conflict[1] === 'already captured by'
        ? 'other_payment_captured'
        : 'other_payment_active',
      priorStatus,
      relatedPaymentId,
    }
  }
  if (
    !canTransitionPayment(priorStatus, event.type) &&
    event.ignoredReason ===
      `Out-of-order: ${priorStatus} cannot become ${event.type}`
  ) {
    return { outcome: 'out_of_order', priorStatus }
  }
  return undefined
}

function routeMatchesType(
  route: PaymentEventRoute,
  event: PaymentEvent,
  priorStatus: PaymentStatus,
) {
  if (route === 'generic') {
    return (
      priorStatus !== 'disputed' &&
      !['disputed', 'partially_refunded', 'refunded'].includes(event.type)
    )
  }
  if (route === 'dispute') return event.type === 'disputed'
  return (
    priorStatus === 'disputed' &&
    ['succeeded', 'partially_refunded', 'refunded'].includes(event.type)
  )
}

function currentIgnoredAuditAfter(event: PaymentEvent) {
  return {
    attemptedStatus: event.type,
    ignoredInputReason: event.ignoredInputReason,
    ignoredOutcome: event.ignoredOutcome,
    ignoredReason: event.ignoredReason,
    ...(event.ignoredRelatedPaymentId
      ? { ignoredRelatedPaymentId: event.ignoredRelatedPaymentId }
      : {}),
    ignoredRoute: event.ignoredRoute,
    status: event.ignoredPriorStatus,
  }
}

export function matchingCurrentIgnoredPaymentEventAudit(
  state: Pick<DemoState, 'audits' | 'payments'>,
  payment: Payment,
  event: PaymentEvent,
): AuditEntry | undefined {
  const eventIndex = payment.events.findIndex((candidate) =>
    candidate.id === event.id)
  const inferred = inferIgnoredPaymentEventEvidence(
    state,
    payment,
    event,
    eventIndex,
  )
  if (
    !inferred ||
    event.ignoredOutcome !== inferred.outcome ||
    event.ignoredPriorStatus !== inferred.priorStatus ||
    event.ignoredRelatedPaymentId !== inferred.relatedPaymentId ||
    !event.ignoredRoute ||
    !routeMatchesType(event.ignoredRoute, event, inferred.priorStatus) ||
    typeof event.ignoredInputReason !== 'string' ||
    sanitizeText(event.ignoredInputReason, 240) !== event.ignoredInputReason ||
    event.ignoredInputReason.length === 0 ||
    (
      event.ignoredRoute !== 'generic' &&
      (
        event.source !== 'admin_reconcile' ||
        event.ignoredInputReason.length < 8
      )
    ) ||
    event.requestId !== ignoredPaymentEventRequestId(event.id)
  ) {
    return undefined
  }
  const matches = state.audits.filter((audit) =>
    audit.outcome === 'ignored' &&
    (
      event.source === 'mock_webhook'
        ? audit.actorId === 'mock-hitpay' && audit.actorRole === 'finance'
        : (
            event.source === 'admin_reconcile' &&
            ['finance', 'admin', 'super_admin'].includes(audit.actorRole)
          )
    ) &&
    audit.action === IGNORED_PAYMENT_EVENT_ACTION &&
    audit.targetType === 'payment' &&
    audit.targetId === payment.id &&
    audit.reason === event.ignoredReason &&
    sameInstant(audit.at, event.processedAt) &&
    audit.requestId === event.requestId &&
    audit.eventId === event.id &&
    exactRecord(audit.before, { status: inferred.priorStatus }) &&
    exactRecord(audit.after, currentIgnoredAuditAfter(event)))
  return matches.length === 1 ? matches[0] : undefined
}

export function legacyIgnoredPaymentEventMigrationId(eventId: string) {
  return `audit-migration-v9-${makeId('ignored-event', eventId)}`
}

export function legacyIgnoredPaymentEventMigrationRequestId(eventId: string) {
  return makeId('migration-v9-ignored-event', eventId)
}

export function matchingLegacyIgnoredPaymentEventSourceAudit(
  state: Pick<DemoState, 'audits' | 'payments'>,
  payment: Payment,
  event: PaymentEvent,
): AuditEntry | null | undefined {
  if (
    event.ignoredOutcome !== undefined ||
    event.ignoredPriorStatus !== undefined ||
    event.ignoredRelatedPaymentId !== undefined ||
    event.ignoredRoute !== undefined ||
    event.ignoredInputReason !== undefined
  ) {
    return undefined
  }
  const eventIndex = payment.events.findIndex((candidate) =>
    candidate.id === event.id)
  const evidence = inferIgnoredPaymentEventEvidence(
    state,
    payment,
    event,
    eventIndex,
  )
  if (!evidence) return undefined
  const matches = state.audits.filter((audit) =>
    audit.outcome === 'ignored' &&
    ['finance', 'admin', 'super_admin'].includes(audit.actorRole) &&
    audit.action === IGNORED_PAYMENT_EVENT_ACTION &&
    audit.targetType === 'payment' &&
    audit.targetId === payment.id &&
    audit.reason === event.ignoredReason &&
    sameInstant(audit.at, event.processedAt) &&
    audit.requestId === event.requestId &&
    audit.eventId === event.id &&
    exactRecord(audit.before, { status: evidence.priorStatus }) &&
    exactRecord(audit.after, {
      attemptedStatus: event.type,
      ignoredReason: event.ignoredReason,
      status: evidence.priorStatus,
    }))
  if (event.source === 'mock_webhook') {
    return matches.length === 0 ? null : undefined
  }
  if (event.source !== 'admin_reconcile') return undefined
  return matches.length === 1 ? matches[0] : undefined
}

function legacyIgnoredMigrationBefore(
  event: PaymentEvent,
  evidence: IgnoredPaymentEventEvidence,
) {
  return {
    eventId: event.id,
    ignoredReason: event.ignoredReason,
    paymentEventRequestId: event.requestId,
    priorStatus: evidence.priorStatus,
    source: event.source,
    type: event.type,
  }
}

function legacyIgnoredMigrationAfter(
  evidence: IgnoredPaymentEventEvidence,
) {
  return {
    legacyReplayable: false,
    outcome: evidence.outcome,
    ...(evidence.relatedPaymentId
      ? { relatedPaymentId: evidence.relatedPaymentId }
      : {}),
    schemaVersion: 9,
  }
}

export function matchingLegacyIgnoredPaymentEventMigrationAudit(
  state: Pick<DemoState, 'audits' | 'payments'>,
  payment: Payment,
  event: PaymentEvent,
): AuditEntry | undefined {
  if (
    event.ignoredOutcome !== undefined ||
    event.ignoredPriorStatus !== undefined ||
    event.ignoredRelatedPaymentId !== undefined ||
    event.ignoredRoute !== undefined ||
    event.ignoredInputReason !== undefined
  ) {
    return undefined
  }
  const eventIndex = payment.events.findIndex((candidate) =>
    candidate.id === event.id)
  const evidence = inferIgnoredPaymentEventEvidence(
    state,
    payment,
    event,
    eventIndex,
  )
  if (!evidence) return undefined
  const sourceAudit = matchingLegacyIgnoredPaymentEventSourceAudit(
    state,
    payment,
    event,
  )
  if (
    (
      event.source === 'mock_webhook' &&
      sourceAudit !== null
    ) ||
    (
      event.source === 'admin_reconcile' &&
      !sourceAudit
    )
  ) {
    return undefined
  }
  const matches = state.audits.filter((audit) =>
    audit.id === legacyIgnoredPaymentEventMigrationId(event.id) &&
    audit.outcome === 'applied' &&
    audit.actorId === 'system' &&
    audit.actorRole === 'super_admin' &&
    audit.action === LEGACY_IGNORED_EVENT_MIGRATION_ACTION &&
    audit.targetType === 'payment' &&
    audit.targetId === payment.id &&
    audit.reason === LEGACY_IGNORED_EVENT_MIGRATION_REASON &&
    sameInstant(audit.at, event.processedAt) &&
    audit.requestId === legacyIgnoredPaymentEventMigrationRequestId(event.id) &&
    audit.eventId === event.id &&
    exactRecord(audit.before, legacyIgnoredMigrationBefore(event, evidence)) &&
    exactRecord(audit.after, legacyIgnoredMigrationAfter(evidence)))
  return matches.length === 1 ? matches[0] : undefined
}

export function legacyIgnoredPaymentEventMigrationEvidence(
  state: Pick<DemoState, 'audits' | 'payments'>,
  payment: Payment,
  event: PaymentEvent,
) {
  const eventIndex = payment.events.findIndex((candidate) =>
    candidate.id === event.id)
  const evidence = inferIgnoredPaymentEventEvidence(
    state,
    payment,
    event,
    eventIndex,
  )
  return evidence
    ? {
        after: legacyIgnoredMigrationAfter(evidence),
        before: legacyIgnoredMigrationBefore(event, evidence),
        evidence,
      }
    : undefined
}
