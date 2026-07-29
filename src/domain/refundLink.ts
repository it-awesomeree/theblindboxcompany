import type {
  AuditEntry,
  Claim,
  DemoState,
  Payment,
  PaymentEvent,
} from './types'

export const CLAIM_REFUND_LINK_ACTION = 'claim.refund_linked'

export function claimRefundLinkedHistoryNote(eventId: string) {
  return `Approved claim linked to accepted refund event ${eventId}.`
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
}

function expectedRefundAction(event: PaymentEvent) {
  return event.type === 'refunded'
    ? 'payment.refunded'
    : 'payment.partially_refunded'
}

export function matchingAppliedPaymentRefundAudit(
  state: DemoState,
  payment: Payment,
  event: PaymentEvent,
  claim: Claim,
): AuditEntry | undefined {
  const intent = event.refundIntent
  if (!intent) return undefined
  const eventIndex = payment.events.findIndex((entry) => entry.id === event.id)
  if (eventIndex < 0) return undefined
  const priorEvents = payment.events.slice(0, eventIndex)
  const priorAccepted = priorEvents.filter((entry) => !entry.ignoredReason)
  const priorRefundedSen = priorEvents.reduce(
    (sum, entry) => sum + (entry.refundIntent?.amountSen ?? 0),
    0,
  )
  const priorStatus = priorAccepted.at(-1)?.type
  return state.audits.find((audit) => {
    const before = audit.before
    const after = audit.after
    return (
      audit.outcome === 'applied' &&
      ['finance', 'admin', 'super_admin'].includes(audit.actorRole) &&
      event.ignoredReason === undefined &&
      event.source === 'admin_reconcile' &&
      ['partially_refunded', 'refunded'].includes(event.type) &&
      intent.paymentId === payment.id &&
      intent.claimId === claim.id &&
      audit.action === expectedRefundAction(event) &&
      audit.targetType === 'payment' &&
      audit.targetId === payment.id &&
      audit.reason === intent.reason &&
      audit.at === event.processedAt &&
      audit.requestId === event.requestId &&
      audit.eventId === event.id &&
      record(before) &&
      hasExactKeys(before, ['refundedSen', 'status']) &&
      before.status === priorStatus &&
      before.refundedSen === priorRefundedSen &&
      record(after) &&
      hasExactKeys(after, ['allocationsReturned', 'claimId', 'refundedSen', 'status']) &&
      after.status === event.type &&
      after.refundedSen === priorRefundedSen + intent.amountSen &&
      after.allocationsReturned === 0 &&
      after.claimId === claim.id
    )
  })
}

export function matchingAppliedClaimRefundLinkAudit(
  state: DemoState,
  payment: Payment,
  event: PaymentEvent,
  claim: Claim,
): AuditEntry | undefined {
  const intent = event.refundIntent
  if (!intent) return undefined
  return state.audits.find((audit) => {
    const before = audit.before
    const after = audit.after
    return (
      audit.outcome === 'applied' &&
      ['finance', 'admin', 'super_admin'].includes(audit.actorRole) &&
      audit.action === CLAIM_REFUND_LINK_ACTION &&
      audit.targetType === 'claim' &&
      audit.targetId === claim.id &&
      audit.reason === intent.reason &&
      audit.at === event.processedAt &&
      audit.requestId === event.requestId &&
      audit.eventId === event.id &&
      record(before) &&
      hasExactKeys(before, ['linkedRefundEventId', 'status']) &&
      before.linkedRefundEventId === null &&
      before.status === 'approved' &&
      record(after) &&
      hasExactKeys(after, ['linkedRefundEventId', 'paymentId', 'status']) &&
      after.linkedRefundEventId === event.id &&
      after.paymentId === payment.id &&
      after.status === 'approved'
    )
  })
}
