import { SCHEMA_VERSION, VALUE_FLOOR_SEN } from '../domain/constants'
import { canonicalizeAuditEvidence } from '../domain/auditEvidence'
import { sameInstant } from '../domain/auditSequence'
import {
  assert,
  cloneState,
  DomainError,
  makeId,
} from '../domain/guards'
import {
  LEGACY_DIRECT_REPLACEMENT_MIGRATION_ACTION,
  LEGACY_DIRECT_REPLACEMENT_MIGRATION_REASON,
  legacyDirectReplacementMigrationAfter,
  legacyDirectReplacementMigrationBefore,
  legacyDirectReplacementMigrationId,
  legacyDirectReplacementMigrationRequestId,
} from '../domain/migrationEvidence'
import { exactOddsLabel } from '../domain/odds'
import {
  expectedBoxStatusForScope,
  resolveOrderFulfillment,
} from '../domain/orderFulfillment'
import {
  acceptedDisputeResolutionShapeIsValid,
  immediatePriorAcceptedPaymentStatus,
} from '../domain/paymentEligibility'
import {
  LEGACY_IGNORED_EVENT_MIGRATION_ACTION,
  LEGACY_IGNORED_EVENT_MIGRATION_REASON,
  ignoredPaymentEventRequestId,
  legacyIgnoredPaymentEventMigrationEvidence,
  legacyIgnoredPaymentEventMigrationId,
  legacyIgnoredPaymentEventMigrationRequestId,
  matchingLegacyIgnoredPaymentEventSourceAudit,
} from '../domain/paymentEventEvidence'
import {
  expectedClaimRemedySnapshot,
  isTerminalReplacementRefundFallback,
  matchingAppliedUnlinkedRefundAudit,
  preservedCompletedClaimIdsForUnlinkedRefund,
  terminalReplacementFallbackAmount,
} from '../domain/remedyPolicy'
import {
  matchingReplacementAuthorizationAudit,
  matchingReplacementDeliveryAudit,
  matchingShipmentTransitionAudit,
  RMA_RECEIVED_ACTION,
} from '../domain/remedyEvidence'
import type {
  AuditEntry,
  Claim,
  DemoState,
  LegacyDirectPostDeliveryReplacementEvidence,
  Shipment,
} from '../domain/types'
import { createDemoState } from './fixtures'
import { isDemoState, validateDemoState } from './StateValidator'

// Deliberately unchanged so existing version 5 browser data can be migrated in place.
export const STORAGE_KEY = 'tbbc:demo:repository:v5'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

type LegacyClaimV7 = Omit<
  Claim,
  | 'remedyBoxIds'
  | 'requiredSettlementSen'
  | 'acceptedSettlementSen'
  | 'settlementPolicy'
  | 'legacyUnderSettledRefund'
>
type LegacyDemoStateV7 = Omit<
  DemoState,
  'schemaVersion' | 'claims'
> & {
  schemaVersion: 7
  claims: LegacyClaimV7[]
}
export type LegacyDemoStateV8 = Omit<DemoState, 'schemaVersion'> & {
  schemaVersion: 8
}
type LegacyShipmentV6 = Omit<
  Shipment,
  'purpose' | 'sourceClaimId' | 'replacementForShipmentId'
>
type LegacyClaimV6 = Omit<
  LegacyClaimV7,
  | 'remedyState'
  | 'rma'
  | 'replacementShipmentId'
  | 'replacementAuthorization'
  | 'legacyTypedResolution'
>
type LegacyDemoStateV6 = Omit<
  LegacyDemoStateV7,
  'schemaVersion' | 'shipments' | 'claims'
> & {
  schemaVersion: 6
  shipments: LegacyShipmentV6[]
  claims: LegacyClaimV6[]
}
type LegacyAuditEntryV5 = Omit<AuditEntry, 'sequence' | 'previousId' | 'outcome'>
type LegacyDemoStateV5 = Omit<
  LegacyDemoStateV6,
  'schemaVersion' | 'auditCount' | 'auditHeadId' | 'audits'
> & {
  schemaVersion: 5
  audits: LegacyAuditEntryV5[]
}

interface LoadedState {
  state: DemoState
  notice: string | null
  needsPersist: boolean
  migratedFromRaw?: string
  migratedFromVersion?: 5 | 6 | 7 | 8
  protectedRaw?: string
  requiresConfirmedReset?: boolean
  storageWasMissing?: boolean
}

export interface MockRepositoryOptions {
  writeAuthority?: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key])
  }
  return Object.freeze(value)
}

function sameStoredValue(
  left: unknown,
  right: unknown,
  seen = new WeakMap<object, object>(),
): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false
  const priorMatch = seen.get(left)
  if (priorMatch) return priorMatch === right
  seen.set(left, right)
  const leftKeys = Reflect.ownKeys(left)
  const rightKeys = Reflect.ownKeys(right)
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    return false
  }
  return leftKeys.every((key) => {
    const leftDescriptor = Object.getOwnPropertyDescriptor(left, key)
    const rightDescriptor = Object.getOwnPropertyDescriptor(right, key)
    return Boolean(
      leftDescriptor &&
        rightDescriptor &&
        'value' in leftDescriptor &&
        'value' in rightDescriptor &&
        sameStoredValue(leftDescriptor.value, rightDescriptor.value, seen),
    )
  })
}

function migrationAuditAnchor(): AuditEntry {
  return {
    id: 'audit-migration-v5-empty-anchor',
    sequence: 1,
    outcome: 'applied',
    actorId: 'system',
    actorRole: 'super_admin',
    action: 'migration.v5.audit_anchor',
    targetType: 'demo_state',
    targetId: 'state-v5',
    reason: 'Created a deterministic audit anchor while upgrading empty version 5 history',
    at: '1970-01-01T00:00:00.000Z',
    before: { auditCount: 0, schemaVersion: 5 },
    after: { auditCount: 1, schemaVersion: 6 },
    requestId: 'migration-v5-empty-audit-anchor',
  }
}

function migrateDemoStateV5ToV6(value: unknown): LegacyDemoStateV6 {
  if (!record(value) || value.schemaVersion !== 5 || !Array.isArray(value.audits)) {
    throw new DomainError('Stored data is not a version 5 demo state.', 'MIGRATION_SOURCE_INVALID')
  }
  const legacy = structuredClone(value) as LegacyDemoStateV5
  const audits: AuditEntry[] = legacy.audits.length === 0
    ? [migrationAuditAnchor()]
    : legacy.audits.map((audit, index) => ({
        ...audit,
        sequence: index + 1,
        ...(index > 0 ? { previousId: legacy.audits[index - 1].id } : {}),
        outcome: 'applied',
        ...(Object.prototype.hasOwnProperty.call(audit, 'before')
          ? { before: canonicalizeAuditEvidence(audit.before, `Version 5 audit ${index + 1} before evidence`) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(audit, 'after')
          ? { after: canonicalizeAuditEvidence(audit.after, `Version 5 audit ${index + 1} after evidence`) }
          : {}),
      }))
  const series = legacy.series.map((entry) => ({
    ...entry,
    ...(entry.publishedPrizes
      ? {
          publishedPrizes: entry.publishedPrizes.map((prize) => ({
            ...prize,
            odds: exactOddsLabel(prize.allocation, entry.allocationTotal),
          })),
        }
      : {}),
    ...(entry.draftPrizes
      ? {
          draftPrizes: entry.draftPrizes.map((prize) => ({
            ...prize,
            odds: exactOddsLabel(prize.allocation, entry.allocationTotal),
          })),
        }
      : {}),
  }))
  const orders = legacy.orders.map((order) => ({
    ...order,
    snapshot: {
      ...order.snapshot,
      valueFloorSen: VALUE_FLOOR_SEN,
    },
  }))
  return {
    ...legacy,
    series,
    orders,
    schemaVersion: 6,
    auditCount: audits.length,
    auditHeadId: audits.at(-1)?.id ?? '',
    audits,
  } as LegacyDemoStateV6
}

function migrateDigitalShipmentV6(shipment: LegacyShipmentV6): Shipment {
  let terminal: 'delivered' | 'failed' | 'cancelled' | undefined
  const timeline: Shipment['timeline'] = []
  const finalEntry = shipment.timeline.at(-1)
  const financiallyCancelled =
    finalEntry?.status === 'cancelled' && Boolean(finalEntry.financialHold)

  const appendMissingDigitalStep = (
    entry: LegacyShipmentV6['timeline'][number],
    status: 'issued' | 'sent',
  ) => {
    timeline.push({
      ...entry,
      id: `${entry.id}-migration-${status}`,
      status,
      label: `${entry.label} — migrated digital ${status} evidence`,
      financialHold: undefined,
    })
  }

  shipment.timeline.forEach((entry, index) => {
    let status: Shipment['status']
    if (terminal) {
      status = terminal
    } else if (financiallyCancelled) {
      if (index === shipment.timeline.length - 1) {
        status = 'cancelled'
        terminal = 'cancelled'
      } else if (entry.status === 'unfulfilled') {
        status = 'unfulfilled'
      } else {
        status = 'issued'
      }
    } else if (entry.status === 'unfulfilled') {
      status = 'unfulfilled'
    } else if (['picking', 'packed'].includes(entry.status)) {
      status = 'issued'
    } else if (['label_created', 'shipped'].includes(entry.status)) {
      status = 'sent'
    } else if (entry.status === 'delivered') {
      status = 'delivered'
      terminal = 'delivered'
    } else if (entry.status === 'returned' && shipment.timeline
      .slice(0, index)
      .some((prior) => prior.status === 'delivered')) {
      status = 'delivered'
      terminal = 'delivered'
    } else if (entry.status === 'cancelled') {
      status = 'cancelled'
      terminal = 'cancelled'
    } else {
      status = 'failed'
      terminal = 'failed'
    }
    if (['sent', 'delivered', 'failed'].includes(status)) {
      if (timeline.at(-1)?.status === 'unfulfilled') {
        appendMissingDigitalStep(entry, 'issued')
      }
      if (
        ['delivered', 'failed'].includes(status) &&
        timeline.at(-1)?.status === 'issued'
      ) {
        appendMissingDigitalStep(entry, 'sent')
      }
    }
    timeline.push({ ...entry, status })
  })
  return {
    ...shipment,
    purpose: 'original',
    status: timeline.at(-1)?.status ?? 'unfulfilled',
    carrier: 'Digital Vault',
    trackingNumber: `DEMO-${shipment.id.slice(4).toUpperCase()}`,
    timeline,
  }
}

function migratePhysicalShipmentV6(shipment: LegacyShipmentV6): Shipment {
  let exception: Extract<Shipment['status'], 'failed_delivery' | 'lost' | 'returned'> | undefined
  const timeline = shipment.timeline.map((entry) => {
    if (['failed_delivery', 'lost', 'returned'].includes(entry.status)) {
      exception = entry.status as typeof exception
      return { ...entry }
    }
    if (exception && (entry.status === 'shipped' || entry.status === 'delivered')) {
      return { ...entry, status: exception }
    }
    return { ...entry }
  })
  return {
    ...shipment,
    purpose: 'original',
    status: timeline.at(-1)?.status ?? shipment.status,
    timeline,
  }
}

function normalizeMigratedFulfillment(candidate: DemoState) {
  for (const order of candidate.orders) {
    if (
      order.status === 'pending_payment' ||
      ['cancelled', 'refunded', 'disputed'].includes(order.status)
    ) {
      continue
    }
    const resolution = resolveOrderFulfillment(candidate, order)
    const target = order.status === 'closed' && resolution.status === 'fulfilled'
      ? 'closed'
      : resolution.status
    order.status = target
    if (order.timeline.length > 0) order.timeline.at(-1)!.status = target
    for (const scope of resolution.scopes) {
      for (const boxId of scope.boxIds) {
        const box = candidate.boxes.find((entry) => entry.id === boxId)
        if (!box) continue
        box.status = expectedBoxStatusForScope(
          candidate,
          scope,
          box.status,
          Boolean(box.revealedAt),
        )
      }
    }
  }
}

function migrateDemoStateV6ToV7(value: unknown): LegacyDemoStateV7 {
  if (
    !record(value) ||
    value.schemaVersion !== 6 ||
    !Array.isArray(value.shipments) ||
    !Array.isArray(value.claims)
  ) {
    throw new DomainError('Stored data is not a version 6 demo state.', 'MIGRATION_SOURCE_INVALID')
  }
  const legacy = structuredClone(value) as LegacyDemoStateV6
  const shipments: Shipment[] = legacy.shipments.map((shipment) =>
    shipment.kind === 'DIGITAL'
      ? migrateDigitalShipmentV6(shipment)
      : migratePhysicalShipmentV6(shipment))
  const claims: LegacyClaimV7[] = legacy.claims.map((claim) => ({
    ...claim,
    remedyState:
      claim.status === 'resolved' && claim.resolutionOutcome === 'refund_recorded'
        ? 'refund_completed'
        : claim.linkedRefundEventId
          ? 'refund_linked'
          : claim.status === 'resolved' && claim.resolutionOutcome === 'no_remedy'
            ? 'no_remedy'
            : 'none',
    ...(
      claim.status === 'resolved' &&
      (
        claim.resolutionOutcome === 'replacement_authorized' ||
        claim.resolutionOutcome === 'return_rma_created'
      )
        ? { legacyTypedResolution: true as const }
        : {}
    ),
  }))
  const candidate = {
    ...legacy,
    schemaVersion: 7 as const,
    shipments,
    claims,
  } as LegacyDemoStateV7
  return candidate
}

function linkedRefundEvidence(
  state: DemoState,
  claim: LegacyClaimV7,
) {
  if (!claim.linkedRefundEventId) return undefined
  for (const payment of state.payments) {
    const eventIndex = payment.events.findIndex((event) =>
      event.id === claim.linkedRefundEventId)
    if (eventIndex < 0) continue
    const event = payment.events[eventIndex]
    const amountSen = event.refundIntent?.amountSen
    if (
      event.refundIntent?.claimId !== claim.id ||
      !Number.isInteger(amountSen) ||
      amountSen! <= 0
    ) {
      return undefined
    }
    const priorRefundedSen = payment.events
      .slice(0, eventIndex)
      .reduce(
        (sum, prior) =>
          sum + (
            prior.ignoredReason
              ? 0
              : (prior.refundIntent?.amountSen ?? 0)
          ),
        0,
      )
    return {
      amountSen: amountSen!,
      payment,
      priorRefundedSen,
    }
  }
  return undefined
}

function appendVersion9MigrationAudit(
  state: DemoState,
  input: Omit<
    AuditEntry,
    'id' | 'sequence' | 'previousId' | 'before' | 'after'
  > & {
    idSeed: string
    before?: unknown
    after?: unknown
  },
) {
  const hasBefore = Object.prototype.hasOwnProperty.call(input, 'before')
  const hasAfter = Object.prototype.hasOwnProperty.call(input, 'after')
  const {
    idSeed,
    before,
    after,
    ...audit
  } = input
  const id = `audit-migration-v9-${idSeed}`
  assert(
    !state.audits.some((entry) => entry.id === id),
    `Synthetic migration audit identity ${id} collides with stored history.`,
    'MIGRATION_ID_COLLISION',
  )
  const entry: AuditEntry = {
    id,
    sequence: state.auditCount + 1,
    ...(state.auditHeadId ? { previousId: state.auditHeadId } : {}),
    ...audit,
    ...(hasBefore
      ? {
          before: canonicalizeAuditEvidence(
            before,
            `Migration audit ${id} before evidence`,
          ),
        }
      : {}),
    ...(hasAfter
      ? {
          after: canonicalizeAuditEvidence(
            after,
            `Migration audit ${id} after evidence`,
          ),
        }
      : {}),
  }
  state.audits.push(entry)
  state.auditCount = entry.sequence
  state.auditHeadId = entry.id
  return entry
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

function originalForMigratedClaim(
  state: LegacyDemoStateV8,
  claim: Claim,
) {
  const originalId =
    claim.shipmentId ??
    (
      claim.shipmentCandidateIds?.length === 1
        ? claim.shipmentCandidateIds[0]
        : undefined
    ) ??
    (
      claim.boxId
        ? state.boxes.find((box) =>
            box.id === claim.boxId &&
            box.orderId === claim.orderId)?.shipmentId
        : undefined
    )
  const matches = state.shipments.filter((shipment) =>
    shipment.id === originalId &&
    shipment.orderId === claim.orderId &&
    shipment.purpose === 'original')
  return matches.length === 1 ? matches[0] : undefined
}

function allTimelineIds(state: LegacyDemoStateV8 | DemoState) {
  return state.shipments.flatMap((shipment) =>
    shipment.timeline.map((entry) => entry.id))
}

export function version9RmaReturnedTimelineId(
  claimId: string,
  originalShipmentId: string,
) {
  return `stl-migration-v9-${makeId(
    'rma-returned',
    `${claimId}:${originalShipmentId}`,
  )}`
}

export function version9RmaReceiptAuditId(claimId: string) {
  return `audit-migration-v9-${makeId('rma-receipt', claimId)}`
}

interface Version8RmaReceiptPlan {
  claimId: string
  originalShipmentId: string
  originalStatusBeforeReceipt: 'delivered' | 'returned'
  insertReturnedTimeline: boolean
  oldAudit: AuditEntry
}

interface Version8DirectReplacementPlan {
  claimId: string
  evidence: LegacyDirectPostDeliveryReplacementEvidence
}

interface Version8IgnoredEventPlan {
  paymentId: string
  eventId: string
  before: Record<string, unknown>
  after: Record<string, unknown>
}

interface Version8MigrationPlan {
  rmaReceipts: Version8RmaReceiptPlan[]
  directReplacements: Version8DirectReplacementPlan[]
  ignoredEvents: Version8IgnoredEventPlan[]
}

function preflightVersion8RmaReceipts(
  state: LegacyDemoStateV8,
) {
  const plans: Version8RmaReceiptPlan[] = []
  const timelineIds = allTimelineIds(state)
  for (const claim of state.claims) {
    if (!claim.rma || claim.rma.status === 'created') continue
    const original = originalForMigratedClaim(state, claim)
    const receivedAt = claim.rma.receivedAt
    const receivedReason = claim.rma.receivedReason
    assert(
      original &&
        original.kind !== 'DIGITAL' &&
        receivedAt &&
        receivedReason &&
        claim.rma.reference &&
        claim.history.some((entry) =>
          entry.status === 'approved' &&
          entry.at === receivedAt &&
          entry.note === receivedReason),
      'Legacy RMA receipt is missing its exact physical original, time, reason, or immutable claim history.',
      'MIGRATION_SOURCE_INVALID',
    )
    const oldAudits = state.audits.filter((audit) =>
      audit.outcome === 'applied' &&
      ['support', 'admin', 'super_admin'].includes(audit.actorRole) &&
      audit.action === RMA_RECEIVED_ACTION &&
      audit.targetType === 'claim' &&
      audit.targetId === claim.id &&
      audit.reason === receivedReason &&
      sameInstant(audit.at, receivedAt) &&
      audit.requestId === makeId(
        'req',
        `${claim.id}:rma:received:${receivedAt}`,
      ) &&
      audit.eventId === undefined &&
      exactRecord(audit.before, {
        remedyState: 'rma_created',
        rmaStatus: 'created',
      }) &&
      exactRecord(audit.after, {
        remedyState: 'rma_received',
        rmaReference: claim.rma!.reference,
        rmaStatus: 'received',
      }))
    assert(
      oldAudits.length === 1 &&
        claim.history.some((entry) =>
          entry.status === 'approved' &&
          entry.at === receivedAt &&
          entry.note === receivedReason &&
          entry.actorId === oldAudits[0].actorId &&
          entry.actorRole === oldAudits[0].actorRole),
      'Legacy RMA receipt audit is malformed or ambiguous.',
      'MIGRATION_SOURCE_INVALID',
    )
    const entriesAtReceipt = original.timeline.filter((entry) =>
      Date.parse(entry.at) <= Date.parse(receivedAt))
    const originalStatusBeforeReceipt = entriesAtReceipt.at(-1)?.status
    const originalIndexAtReceipt = original.timeline.reduce(
      (lastIndex, entry, index) =>
        Date.parse(entry.at) <= Date.parse(receivedAt)
          ? index
          : lastIndex,
      -1,
    )
    assert(
      (
        originalStatusBeforeReceipt === 'delivered' ||
        originalStatusBeforeReceipt === 'returned'
      ) &&
        original.timeline.some((entry) =>
          entry.status === 'delivered' &&
          Date.parse(entry.at) <= Date.parse(claim.createdAt)) &&
        original.timeline.every((entry, index) =>
          index === 0 ||
          Date.parse(entry.at) >= Date.parse(original.timeline[index - 1].at)),
      'Legacy RMA receipt original history is malformed or does not prove delivery before the claim and receipt.',
      'MIGRATION_SOURCE_INVALID',
    )
    if (originalStatusBeforeReceipt === 'returned') {
      assert(
        originalIndexAtReceipt > 0 &&
          matchingShipmentTransitionAudit(
            state as unknown as DemoState,
            original,
            originalIndexAtReceipt,
          ),
        'Legacy original returned before RMA receipt is missing its exact source transition audit.',
        'MIGRATION_SOURCE_INVALID',
      )
    }
    const insertReturnedTimeline =
      originalStatusBeforeReceipt === 'delivered'
    const timelineId = version9RmaReturnedTimelineId(claim.id, original.id)
    if (insertReturnedTimeline) {
      assert(
        !timelineIds.includes(timelineId),
        `Synthetic migration timeline identity ${timelineId} collides with stored history.`,
        'MIGRATION_ID_COLLISION',
      )
    }
    assert(
      !state.audits.some((audit) =>
        audit.id === version9RmaReceiptAuditId(claim.id)),
      `Synthetic migration audit identity ${version9RmaReceiptAuditId(claim.id)} collides with stored history.`,
      'MIGRATION_ID_COLLISION',
    )
    plans.push({
      claimId: claim.id,
      originalShipmentId: original.id,
      originalStatusBeforeReceipt,
      insertReturnedTimeline,
      oldAudit: oldAudits[0],
    })
  }
  return plans
}

function matchingVersion8ReplacementTransitionAudit(
  state: LegacyDemoStateV8,
  shipment: Shipment,
  index: number,
) {
  const entry = shipment.timeline[index]
  const previous = shipment.timeline[index - 1]
  if (!entry || !previous) return undefined

  const financialStop = entry.status === 'cancelled' && Boolean(entry.financialHold)
  const disputeResume =
    previous.status === 'cancelled' &&
    previous.financialHold === 'disputed' &&
    entry.status === 'unfulfilled'
  let matches: AuditEntry[]
  if (financialStop && entry.financialHold) {
    matches = state.audits.filter((audit) =>
      audit.outcome === 'applied' &&
      ['finance', 'admin', 'super_admin'].includes(audit.actorRole) &&
      audit.action === `order.financial_hold_${entry.financialHold}` &&
      audit.targetType === 'order' &&
      audit.targetId === shipment.orderId &&
      audit.reason === entry.label &&
      audit.at === entry.at &&
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
      audit.after.stoppedShipmentIds.includes(shipment.id))
  } else if (disputeResume) {
    matches = state.audits.filter((audit) =>
      audit.outcome === 'applied' &&
      ['finance', 'admin', 'super_admin'].includes(audit.actorRole) &&
      audit.action === 'order.dispute_resolved' &&
      audit.targetType === 'order' &&
      audit.targetId === shipment.orderId &&
      audit.reason === entry.label &&
      audit.at === entry.at &&
      entry.id === makeId(
        'stl',
        `${shipment.id}:dispute-resolved:${audit.requestId}`,
      ) &&
      exactRecord(audit.before, { status: 'disputed' }) &&
      record(audit.after) &&
      typeof audit.after.status === 'string' &&
      exactRecord(audit.after, { status: audit.after.status }))
  } else {
    matches = state.audits.filter((audit) =>
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
      }))
  }
  if (!financialStop && !disputeResume) {
    const requestId = entry.id.startsWith('stl-')
      ? `req-${entry.id.slice('stl-'.length)}`
      : ''
    matches = matches.filter((audit) => audit.requestId === requestId)
  }
  return matches.length === 1 ? matches[0] : undefined
}

function preflightVersion8DirectReplacements(
  state: LegacyDemoStateV8,
) {
  const plans: Version8DirectReplacementPlan[] = []
  for (const replacement of state.shipments.filter((shipment) =>
    shipment.purpose === 'replacement')) {
    const claims = state.claims.filter((claim) =>
      claim.id === replacement.sourceClaimId &&
      claim.replacementShipmentId === replacement.id)
    const originals = state.shipments.filter((shipment) =>
      shipment.id === replacement.replacementForShipmentId &&
      shipment.purpose === 'original' &&
      shipment.orderId === replacement.orderId)
    if (claims.length !== 1 || originals.length !== 1) continue
    const claim = claims[0]
    const original = originals[0]
    const authorization = claim.replacementAuthorization
    const deliveredBeforeAuthorization = Boolean(
      authorization &&
        original.timeline.some((entry) =>
          entry.status === 'delivered' &&
          Date.parse(entry.at) <= Date.parse(authorization.at)),
    )
    if (!deliveredBeforeAuthorization || claim.rma !== undefined) continue
    const authorizationAudit = matchingReplacementAuthorizationAudit(
      state as unknown as DemoState,
      claim,
      original,
      replacement,
    )
    assert(
      authorization &&
        authorizationAudit &&
        authorizationAudit.requestId === makeId(
          'req',
          `${claim.id}:replacement:${authorization.at}`,
        ) &&
        authorizationAudit.eventId === undefined &&
        ['delivered', 'returned'].includes(original.status) &&
        replacement.timeline.every((_, index) =>
          index === 0 ||
          Boolean(matchingVersion8ReplacementTransitionAudit(
            state,
            replacement,
            index,
          ))) &&
        claim.history.some((entry) =>
          entry.status === (
            replacement.status === 'delivered' ? 'approved' : claim.status
          ) &&
          entry.at === authorization.at &&
          entry.note === authorization.reason &&
          entry.actorId === authorizationAudit.actorId &&
          entry.actorRole === authorizationAudit.actorRole),
      'Legacy direct post-delivery replacement authorization is malformed or ambiguous.',
      'MIGRATION_SOURCE_INVALID',
    )
    if (replacement.status === 'delivered') {
      assert(
        claim.status === 'resolved' &&
          claim.remedyState === 'replacement_delivered' &&
          claim.resolutionOutcome === 'replacement_authorized' &&
          claim.resolutionReference === replacement.id &&
          matchingReplacementDeliveryAudit(
            state as unknown as DemoState,
            claim,
            replacement,
          ),
        'Legacy delivered direct replacement is missing its exact completion evidence.',
        'MIGRATION_SOURCE_INVALID',
      )
    } else {
      assert(
        claim.status === 'approved' &&
          claim.remedyState === 'replacement_authorized' &&
          claim.resolutionOutcome === undefined &&
          claim.resolutionReference === undefined,
        'Legacy incomplete direct replacement has an ambiguous claim outcome.',
        'MIGRATION_SOURCE_INVALID',
      )
    }
    const evidence: LegacyDirectPostDeliveryReplacementEvidence = {
      originalShipmentId: original.id,
      originalStatusAtMigration: original.status as 'delivered' | 'returned',
      replacementShipmentId: replacement.id,
      replacementStatusAtMigration: replacement.status,
    }
    assert(
      !state.audits.some((audit) =>
        audit.id === legacyDirectReplacementMigrationId(claim.id)),
      `Synthetic migration audit identity ${legacyDirectReplacementMigrationId(claim.id)} collides with stored history.`,
      'MIGRATION_ID_COLLISION',
    )
    plans.push({ claimId: claim.id, evidence })
  }
  return plans
}

function preflightVersion8IgnoredEvents(
  state: LegacyDemoStateV8,
) {
  const plans: Version8IgnoredEventPlan[] = []
  for (const payment of state.payments) {
    for (const event of payment.events) {
      if (event.ignoredReason === undefined) continue
      assert(
        event.ignoredOutcome === undefined &&
          event.ignoredPriorStatus === undefined &&
          event.ignoredRelatedPaymentId === undefined &&
          event.ignoredRoute === undefined &&
          event.ignoredInputReason === undefined &&
          event.refundIntent === undefined &&
          ['mock_webhook', 'admin_reconcile'].includes(event.source) &&
          event.requestId === ignoredPaymentEventRequestId(event.id),
        'Legacy ignored payment event contains forged current-schema evidence.',
        'MIGRATION_SOURCE_INVALID',
      )
      const migration = legacyIgnoredPaymentEventMigrationEvidence(
        state,
        payment,
        event,
      )
      assert(
        migration,
        'Legacy ignored payment event outcome is malformed or ambiguous.',
        'MIGRATION_SOURCE_INVALID',
      )
      const oldSourceAudit = matchingLegacyIgnoredPaymentEventSourceAudit(
        state,
        payment,
        event,
      )
      assert(
        (
          event.source === 'admin_reconcile' &&
          Boolean(oldSourceAudit)
        ) ||
          (
            event.source === 'mock_webhook' &&
            oldSourceAudit === null
          ),
        event.source === 'admin_reconcile'
          ? 'Legacy ignored admin event is missing its exact old-writer audit.'
          : 'Legacy ignored mock webhook event has forged admin-only audit evidence.',
        'MIGRATION_SOURCE_INVALID',
      )
      assert(
        !state.audits.some((audit) =>
          audit.id === legacyIgnoredPaymentEventMigrationId(event.id)),
        `Synthetic migration audit identity ${legacyIgnoredPaymentEventMigrationId(event.id)} collides with stored history.`,
        'MIGRATION_ID_COLLISION',
      )
      plans.push({
        paymentId: payment.id,
        eventId: event.id,
        before: migration.before,
        after: migration.after,
      })
    }
  }
  return plans
}

function assertVersion8EffectiveDeliveryUniqueness(
  state: LegacyDemoStateV8,
) {
  const deliveredBoxIds = state.shipments
    .filter((shipment) => shipment.status === 'delivered')
    .flatMap((shipment) => shipment.boxIds)
  assert(
    new Set(deliveredBoxIds).size === deliveredBoxIds.length,
    'Version 8 source duplicates an effectively delivered shipment box and could not have passed the previous reader.',
    'MIGRATION_SOURCE_INVALID',
  )
}

function preflightVersion8Migration(
  state: LegacyDemoStateV8,
): Version8MigrationPlan {
  // Frozen c3c8c28 reader invariant: no two currently delivered shipments
  // could persist the same box. Migration must not manufacture an exception.
  assertVersion8EffectiveDeliveryUniqueness(state)
  assert(
    state.claims.every((claim) =>
      !Object.prototype.hasOwnProperty.call(
        claim,
        'legacyDirectPostDeliveryReplacement',
      )) &&
      state.audits.every((audit) =>
        ![
          LEGACY_DIRECT_REPLACEMENT_MIGRATION_ACTION,
          LEGACY_IGNORED_EVENT_MIGRATION_ACTION,
        ].includes(audit.action)),
    'Version 8 source contains forged migration-only markers or audits.',
    'MIGRATION_SOURCE_INVALID',
  )
  preflightVersion8DisputeResolutionHistory(state)
  const plan = {
    rmaReceipts: preflightVersion8RmaReceipts(state),
    directReplacements: preflightVersion8DirectReplacements(state),
    ignoredEvents: preflightVersion8IgnoredEvents(state),
  }
  const syntheticAuditIds = [
    ...plan.rmaReceipts.map((entry) =>
      version9RmaReceiptAuditId(entry.claimId)),
    ...plan.directReplacements.map((entry) =>
      legacyDirectReplacementMigrationId(entry.claimId)),
    ...plan.ignoredEvents.map((entry) =>
      legacyIgnoredPaymentEventMigrationId(entry.eventId)),
  ]
  assert(
    new Set(syntheticAuditIds).size === syntheticAuditIds.length,
    'Two version 8 records would generate the same synthetic migration audit identity.',
    'MIGRATION_ID_COLLISION',
  )
  const syntheticTimelineIds = plan.rmaReceipts
    .filter((entry) => entry.insertReturnedTimeline)
    .map((entry) =>
      version9RmaReturnedTimelineId(
        entry.claimId,
        entry.originalShipmentId,
      ))
  assert(
    new Set(syntheticTimelineIds).size === syntheticTimelineIds.length,
    'Two version 8 RMA receipts would generate the same synthetic return timeline identity.',
    'MIGRATION_ID_COLLISION',
  )
  return plan
}

function applyVersion8RmaReceiptPlans(
  state: DemoState,
  plans: Version8RmaReceiptPlan[],
) {
  for (const plan of plans) {
    const claim = state.claims.find((entry) => entry.id === plan.claimId)!
    const original = state.shipments.find((entry) =>
      entry.id === plan.originalShipmentId)!
    if (plan.insertReturnedTimeline) {
      const receivedAt = claim.rma!.receivedAt!
      const insertAt = original.timeline.findIndex((entry) =>
        Date.parse(entry.at) > Date.parse(receivedAt))
      const timeline = {
        id: version9RmaReturnedTimelineId(claim.id, original.id),
        status: 'returned' as const,
        label: claim.rma!.receivedReason!,
        at: receivedAt,
      }
      if (insertAt < 0) {
        original.timeline.push(timeline)
      } else {
        original.timeline.splice(insertAt, 0, timeline)
      }
      original.status = original.timeline.at(-1)!.status
    }
    appendVersion9MigrationAudit(state, {
      idSeed: makeId('rma-receipt', claim.id),
      outcome: 'applied',
      actorId: plan.oldAudit.actorId,
      actorRole: plan.oldAudit.actorRole,
      action: RMA_RECEIVED_ACTION,
      targetType: 'claim',
      targetId: claim.id,
      reason: claim.rma!.receivedReason!,
      at: claim.rma!.receivedAt!,
      requestId: makeId('migration-v9-rma-receipt', claim.id),
      before: {
        originalShipmentId: original.id,
        originalShipmentStatus: plan.originalStatusBeforeReceipt,
        remedyState: 'rma_created',
        rmaStatus: 'created',
      },
      after: {
        originalShipmentId: original.id,
        originalShipmentStatus: 'returned',
        remedyState: 'rma_received',
        rmaReference: claim.rma!.reference,
        rmaStatus: 'received',
      },
    })
  }
}

function applyVersion8DirectReplacementPlans(
  state: DemoState,
  plans: Version8DirectReplacementPlan[],
) {
  for (const plan of plans) {
    const claim = state.claims.find((entry) => entry.id === plan.claimId)!
    claim.legacyDirectPostDeliveryReplacement = plan.evidence
    appendVersion9MigrationAudit(state, {
      idSeed: legacyDirectReplacementMigrationId(claim.id)
        .slice('audit-migration-v9-'.length),
      outcome: 'applied',
      actorId: 'system',
      actorRole: 'super_admin',
      action: LEGACY_DIRECT_REPLACEMENT_MIGRATION_ACTION,
      targetType: 'claim',
      targetId: claim.id,
      reason: LEGACY_DIRECT_REPLACEMENT_MIGRATION_REASON,
      at: claim.replacementAuthorization!.at,
      requestId: legacyDirectReplacementMigrationRequestId(claim.id),
      before: legacyDirectReplacementMigrationBefore(plan.evidence),
      after: legacyDirectReplacementMigrationAfter(plan.evidence),
    })
  }
}

function applyVersion8IgnoredEventPlans(
  state: DemoState,
  plans: Version8IgnoredEventPlan[],
) {
  for (const plan of plans) {
    const payment = state.payments.find((entry) =>
      entry.id === plan.paymentId)!
    const event = payment.events.find((entry) => entry.id === plan.eventId)!
    appendVersion9MigrationAudit(state, {
      idSeed: legacyIgnoredPaymentEventMigrationId(event.id)
        .slice('audit-migration-v9-'.length),
      outcome: 'applied',
      actorId: 'system',
      actorRole: 'super_admin',
      action: LEGACY_IGNORED_EVENT_MIGRATION_ACTION,
      targetType: 'payment',
      targetId: payment.id,
      reason: LEGACY_IGNORED_EVENT_MIGRATION_REASON,
      at: event.processedAt,
      requestId: legacyIgnoredPaymentEventMigrationRequestId(event.id),
      eventId: event.id,
      before: plan.before,
      after: plan.after,
    })
  }
}

function appendVersion9MissingShipmentTransitionAudits(state: DemoState) {
  for (const shipment of state.shipments) {
    for (let index = 1; index < shipment.timeline.length; index += 1) {
      if (matchingShipmentTransitionAudit(state, shipment, index)) continue
      const timeline = shipment.timeline[index]
      const previous = shipment.timeline[index - 1]
      if (timeline.status === 'cancelled' && timeline.financialHold) {
        const sourceAudit = matchingVersion8ReplacementTransitionAudit(
          state as unknown as LegacyDemoStateV8,
          shipment,
          index,
        )
        assert(
          sourceAudit,
          'Version 8 financial-stop history is missing its exact source audit.',
          'MIGRATION_SOURCE_INVALID',
        )
        const stopped = state.shipments.flatMap((candidate) =>
          candidate.orderId === shipment.orderId
            ? candidate.timeline.flatMap((entry, candidateIndex) =>
                candidateIndex > 0 &&
                entry.id === makeId(
                  'stl',
                  `${candidate.id}:financial-stop:${sourceAudit.requestId}`,
                ) &&
                entry.status === 'cancelled' &&
                entry.financialHold === timeline.financialHold &&
                entry.label === timeline.label &&
                sameInstant(entry.at, timeline.at)
                  ? [{
                      id: candidate.id,
                      status: candidate.timeline[candidateIndex - 1].status,
                    }]
                  : [])
            : [])
          .sort((left, right) => left.id.localeCompare(right.id))
        appendVersion9MigrationAudit(state, {
          idSeed: `${shipment.orderId}-${index}-financial-stop`,
          outcome: 'applied',
          actorId: 'system',
          actorRole: 'super_admin',
          action: `order.financial_hold_${timeline.financialHold}`,
          targetType: 'order',
          targetId: shipment.orderId,
          reason: timeline.label,
          at: timeline.at,
          before: {
            shipments: stopped,
          },
          after: {
            stoppedShipmentIds: stopped.map((entry) => entry.id),
          },
          requestId: sourceAudit.requestId,
        })
      } else if (
        previous.status === 'cancelled' &&
        previous.financialHold === 'disputed' &&
        timeline.status === 'unfulfilled'
      ) {
        const sourceAudit = matchingVersion8ReplacementTransitionAudit(
          state as unknown as LegacyDemoStateV8,
          shipment,
          index,
        )
        assert(
          sourceAudit,
          'Version 8 dispute-resume history is missing its exact source audit.',
          'MIGRATION_SOURCE_INVALID',
        )
        const resumedShipmentIds = state.shipments
          .filter((candidate) =>
            candidate.orderId === shipment.orderId &&
            candidate.timeline.some((entry, candidateIndex) =>
              candidateIndex > 0 &&
              entry.id === makeId(
                'stl',
                `${candidate.id}:dispute-resolved:${sourceAudit.requestId}`,
              ) &&
              entry.status === 'unfulfilled' &&
              entry.label === timeline.label &&
              sameInstant(entry.at, timeline.at) &&
              candidate.timeline[candidateIndex - 1]?.status === 'cancelled' &&
              candidate.timeline[candidateIndex - 1]?.financialHold ===
                'disputed'))
          .map((candidate) => candidate.id)
          .sort((left, right) => left.localeCompare(right))
        appendVersion9MigrationAudit(state, {
          idSeed: `${shipment.orderId}-${index}-dispute-resume`,
          outcome: 'applied',
          actorId: 'system',
          actorRole: 'super_admin',
          action: 'order.dispute_resolved',
          targetType: 'order',
          targetId: shipment.orderId,
          reason: timeline.label,
          at: timeline.at,
          before: { status: 'disputed' },
          after: {
            resumedShipmentIds,
            status: record(sourceAudit.after) &&
              typeof sourceAudit.after.status === 'string'
              ? sourceAudit.after.status
              : 'confirmed',
          },
          requestId: sourceAudit.requestId,
        })
      } else {
        const orderStatus = state.orders.find((order) =>
          order.id === shipment.orderId)?.status ?? 'confirmed'
        appendVersion9MigrationAudit(state, {
          idSeed: `${shipment.id}-${index}-transition`,
          outcome: 'applied',
          actorId: 'system',
          actorRole: 'super_admin',
          action: 'shipment.transitioned',
          targetType: 'shipment',
          targetId: shipment.id,
          reason: timeline.label,
          at: timeline.at,
          before: { status: previous.status },
          after: {
            financialHoldPreserved: [
              'cancelled',
              'refunded',
              'disputed',
            ].includes(orderStatus),
            orderStatus,
            status: timeline.status,
          },
          requestId: `migration-v9-${shipment.id}-${index}-transition`,
        })
      }
    }
  }
}

function appendVersion9MissingUnlinkedRefundAudits(state: DemoState) {
  for (const payment of state.payments) {
    for (const [eventIndex, event] of payment.events.entries()) {
      const intent = event.refundIntent
      if (
        !intent ||
        intent.claimId !== undefined ||
        event.ignoredReason !== undefined ||
        matchingAppliedUnlinkedRefundAudit(state, payment, event)
      ) {
        continue
      }
      const priorAccepted = payment.events
        .slice(0, eventIndex)
        .filter((entry) => entry.ignoredReason === undefined)
      const priorStatus = priorAccepted.at(-1)?.type
      const priorRefundedSen = priorAccepted.reduce(
        (sum, entry) => sum + (entry.refundIntent?.amountSen ?? 0),
        0,
      )
      assert(
        priorStatus &&
          ['partially_refunded', 'refunded'].includes(event.type),
        'Legacy unlinked refund history is incomplete.',
        'MIGRATION_SOURCE_INVALID',
      )
      const boundary = {
        at: event.processedAt,
        sequence: state.auditCount + 1,
      }
      const preservedCompletedClaimIds =
        preservedCompletedClaimIdsForUnlinkedRefund(
          state,
          payment,
          boundary,
        )
      const disputeOrigin = priorStatus === 'disputed'
      appendVersion9MigrationAudit(state, {
        idSeed: `${payment.id}-${event.id}-refund`,
        outcome: 'applied',
        actorId: 'system',
        actorRole: 'super_admin',
        action: event.type === 'refunded'
          ? 'payment.refunded'
          : 'payment.partially_refunded',
        targetType: 'payment',
        targetId: payment.id,
        reason: intent.reason,
        at: event.processedAt,
        before: {
          refundedSen: priorRefundedSen,
          status: priorStatus,
        },
        after: {
          allocationsReturned: 0,
          amountSen: intent.amountSen,
          ...(disputeOrigin ? { orderStatus: 'refunded' } : {}),
          ...(preservedCompletedClaimIds.length > 0
            ? { preservedCompletedClaimIds }
            : {}),
          refundedSen: priorRefundedSen + intent.amountSen,
          status: event.type,
        },
        requestId: event.requestId,
        eventId: event.id,
      })
    }
  }
}

function preflightVersion8DisputeResolutionHistory(
  state: LegacyDemoStateV8,
) {
  for (const payment of state.payments) {
    assert(
      Array.isArray(payment.events),
      'Legacy payment event history is incomplete.',
      'MIGRATION_SOURCE_INVALID',
    )
    for (const [eventIndex, event] of payment.events.entries()) {
      if (
        event.ignoredReason === undefined &&
        immediatePriorAcceptedPaymentStatus(payment, eventIndex) ===
          'disputed'
      ) {
        assert(
          acceptedDisputeResolutionShapeIsValid(
            state as unknown as DemoState,
            payment,
            eventIndex,
          ),
          'Legacy dispute resolution history is malformed or ambiguous.',
          'MIGRATION_SOURCE_INVALID',
        )
      }
    }
  }
}

export function migrateDemoStateV7ToV8(value: unknown): LegacyDemoStateV8 {
  if (
    !record(value) ||
    value.schemaVersion !== 7 ||
    !Array.isArray(value.shipments) ||
    !Array.isArray(value.claims)
  ) {
    throw new DomainError('Stored data is not a version 7 demo state.', 'MIGRATION_SOURCE_INVALID')
  }
  const legacy = structuredClone(value) as LegacyDemoStateV7
  const candidate = {
    ...legacy,
    schemaVersion: 8 as const,
    claims: [],
  } as LegacyDemoStateV8
  const candidateForRules = candidate as unknown as DemoState
  candidate.claims = legacy.claims.map((claim) => {
    const snapshot = expectedClaimRemedySnapshot(candidateForRules, claim)
    const refund = linkedRefundEvidence(candidateForRules, claim)
    const replacement = claim.replacementShipmentId
      ? candidate.shipments.find((shipment) =>
          shipment.id === claim.replacementShipmentId &&
          shipment.sourceClaimId === claim.id)
      : undefined
    const terminalFallback =
      refund &&
      isTerminalReplacementRefundFallback(replacement) &&
      refund.amountSen === terminalReplacementFallbackAmount(
        snapshot.requiredSettlementSen,
        refund.payment.amountSen - refund.priorRefundedSen,
      )
    const exactScope = refund?.amountSen === snapshot.requiredSettlementSen
    const legacyUnderSettledRefund = Boolean(
      refund &&
        refund.amountSen < snapshot.requiredSettlementSen &&
        !exactScope &&
        !terminalFallback,
    )
    assert(
      !refund ||
        exactScope ||
        terminalFallback ||
        legacyUnderSettledRefund,
      'Legacy claim refund exceeds its required nonterminal settlement.',
      'MIGRATION_SOURCE_INVALID',
    )
    return {
      ...claim,
      ...snapshot,
      ...(refund ? { acceptedSettlementSen: refund.amountSen } : {}),
      ...(exactScope ? { settlementPolicy: 'exact_scope' as const } : {}),
      ...(terminalFallback
        ? { settlementPolicy: 'terminal_replacement_fallback' as const }
        : {}),
      ...(legacyUnderSettledRefund
        ? { legacyUnderSettledRefund: true as const }
        : {}),
    }
  })
  candidate.shipments = legacy.shipments.map((shipment) => {
    if (shipment.purpose !== 'replacement') return shipment
    const claim = candidate.claims.find((entry) =>
      entry.id === shipment.sourceClaimId &&
      entry.replacementShipmentId === shipment.id)
    const original = candidate.shipments.find((entry) =>
      entry.id === shipment.replacementForShipmentId &&
      entry.purpose === 'original')
    if (
      !claim ||
      !original ||
      JSON.stringify(shipment.boxIds) === JSON.stringify(claim.remedyBoxIds)
    ) {
      return shipment
    }
    assert(
      JSON.stringify(shipment.boxIds) === JSON.stringify(original.boxIds) &&
        claim.remedyBoxIds.every((boxId) => shipment.boxIds.includes(boxId)),
      'Legacy replacement scope is not the exact old original scope.',
      'MIGRATION_SOURCE_INVALID',
    )
    return {
      ...shipment,
      boxIds: [...claim.remedyBoxIds],
      legacyRecordedBoxIds: [...shipment.boxIds],
    }
  })
  normalizeMigratedFulfillment(candidateForRules)
  return candidate
}

export function migrateDemoStateV8(value: unknown): DemoState {
  if (
    !record(value) ||
    value.schemaVersion !== 8 ||
    !Array.isArray(value.orders) ||
    !Array.isArray(value.payments) ||
    !Array.isArray(value.shipments) ||
    !Array.isArray(value.claims) ||
    !Array.isArray(value.audits)
  ) {
    throw new DomainError('Stored data is not a version 8 demo state.', 'MIGRATION_SOURCE_INVALID')
  }
  const legacy = structuredClone(value) as LegacyDemoStateV8
  const migrationPlan = preflightVersion8Migration(legacy)
  const candidate = {
    ...legacy,
    schemaVersion: SCHEMA_VERSION,
  } as DemoState
  applyVersion8RmaReceiptPlans(candidate, migrationPlan.rmaReceipts)
  applyVersion8DirectReplacementPlans(
    candidate,
    migrationPlan.directReplacements,
  )
  applyVersion8IgnoredEventPlans(candidate, migrationPlan.ignoredEvents)
  appendVersion9MissingShipmentTransitionAudits(candidate)
  appendVersion9MissingUnlinkedRefundAudits(candidate)
  validateDemoState(candidate)
  return candidate
}

export function migrateDemoStateV7(value: unknown): DemoState {
  return migrateDemoStateV8(migrateDemoStateV7ToV8(value))
}

export function migrateDemoStateV6(value: unknown): DemoState {
  return migrateDemoStateV7(migrateDemoStateV6ToV7(value))
}

export function migrateDemoStateV5(value: unknown): DemoState {
  return migrateDemoStateV6(migrateDemoStateV5ToV6(value))
}

export class MockRepository {
  private state: DemoState
  private listeners = new Set<() => void>()
  private activeStorage?: StorageLike
  private writeAuthority: boolean
  private requiresConfirmedReset = false
  private protectedRaw?: string
  private pendingPersist = false
  private migratedFromRaw?: string
  private migratedFromVersion?: 5 | 6 | 7 | 8
  private storageWasMissing = false
  recoveryNotice: string | null = null

  constructor(storage?: StorageLike, options: MockRepositoryOptions = {}) {
    this.activeStorage = storage
    this.writeAuthority = options.writeAuthority ?? true
    const loaded = this.load()
    this.state = deepFreeze(loaded.state)
    this.recoveryNotice = loaded.notice
    this.requiresConfirmedReset = loaded.requiresConfirmedReset ?? false
    this.protectedRaw = loaded.protectedRaw
    this.pendingPersist = loaded.needsPersist
    this.migratedFromRaw = loaded.migratedFromRaw
    this.migratedFromVersion = loaded.migratedFromVersion
    this.storageWasMissing = loaded.storageWasMissing ?? false
    if (this.pendingPersist && this.activeStorage && this.writeAuthority) {
      try {
        this.persistPendingLoadedState()
      } catch {
        const preserved = loaded.migratedFromRaw
          ? this.preserveOriginalMigrationBytes(loaded.migratedFromRaw)
          : false
        this.activeStorage = undefined
        this.pendingPersist = false
        this.migratedFromRaw = undefined
        this.migratedFromVersion = undefined
        this.storageWasMissing = false
        this.recoveryNotice = loaded.migratedFromRaw
          ? `${loaded.notice ?? 'Demo data was upgraded in memory.'} Browser storage could not save the upgrade. ${
              preserved
                ? `The original version ${loaded.migratedFromVersion ?? 5} data was left unchanged, and this tab is continuing safely in memory only.`
                : 'This tab is continuing safely in memory only.'
            }`
          : `${loaded.notice ?? 'Safe demo data was loaded.'} Browser storage could not save it, so this tab is continuing in memory only.`
      }
    }
  }

  private load(): LoadedState {
    if (!this.activeStorage) return { state: createDemoState(), notice: null, needsPersist: false }
    let raw: string | null
    try {
      raw = this.activeStorage.getItem(STORAGE_KEY)
    } catch {
      this.activeStorage = undefined
      return {
        state: createDemoState(),
        notice: 'Browser storage could not be read. Safe demo data was recovered and this tab is continuing in memory only.',
        needsPersist: false,
      }
    }
    if (raw === null) {
      return {
        state: createDemoState(),
        notice: 'Demo data was missing, so a fresh safe copy was loaded.',
        needsPersist: true,
        storageWasMissing: true,
      }
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (isDemoState(parsed)) {
        return { state: parsed, notice: null, needsPersist: false }
      }
      if (record(parsed) && parsed.schemaVersion === 8) {
        try {
          return {
            state: migrateDemoStateV8(parsed),
            notice: 'Demo data was upgraded safely from version 8 to version 9.',
            needsPersist: true,
            migratedFromRaw: raw,
            migratedFromVersion: 8,
          }
        } catch {
          return this.protectedRecovery(
            raw,
            'Stored version 8 demo data failed the migration safety checks.',
          )
        }
      }
      if (record(parsed) && parsed.schemaVersion === 7) {
        try {
          return {
            state: migrateDemoStateV7(parsed),
            notice: 'Demo data was upgraded safely from version 7 through version 8 to version 9.',
            needsPersist: true,
            migratedFromRaw: raw,
            migratedFromVersion: 7,
          }
        } catch {
          return this.protectedRecovery(
            raw,
            'Stored version 7 demo data failed the migration safety checks.',
          )
        }
      }
      if (record(parsed) && parsed.schemaVersion === 6) {
        try {
          return {
            state: migrateDemoStateV6(parsed),
            notice: 'Demo data was upgraded safely from version 6 through version 7 and version 8 to version 9.',
            needsPersist: true,
            migratedFromRaw: raw,
            migratedFromVersion: 6,
          }
        } catch {
          // Invalid version 6 data follows the same safe fixture recovery path below.
        }
      }
      if (record(parsed) && parsed.schemaVersion === 5) {
        try {
          return {
            state: migrateDemoStateV5(parsed),
            notice: 'Demo data was upgraded safely from version 5 through version 6, version 7, and version 8 to version 9.',
            needsPersist: true,
            migratedFromRaw: raw,
            migratedFromVersion: 5,
          }
        } catch {
          return this.protectedRecovery(
            raw,
            'Stored version 5 demo data failed the migration safety checks.',
          )
        }
      }
      if (record(parsed) && typeof parsed.schemaVersion === 'number') {
        const version = parsed.schemaVersion
        if (version > SCHEMA_VERSION) {
          return this.protectedRecovery(
            raw,
            `Stored demo data uses newer unsupported version ${version}. It was not silently downgraded.`,
          )
        }
        if (version === SCHEMA_VERSION) {
          return this.protectedRecovery(
            raw,
            `Stored version ${SCHEMA_VERSION} demo data failed the safety checks.`,
          )
        }
        return this.protectedRecovery(
          raw,
          `Stored demo data uses unsupported old version ${version}.`,
        )
      }
      return this.protectedRecovery(raw, 'Stored demo data is incomplete or has no supported schema version.')
    } catch {
      return this.protectedRecovery(raw, 'Stored demo data is damaged and cannot be read.')
    }
  }

  private protectedRecovery(raw: string, reason: string): LoadedState {
    return {
      state: createDemoState(),
      notice: `${reason} The exact original browser bytes were left unchanged. Safe fixtures are shown in memory only and are not saved. An explicit confirmed Reset demo data action is required before the stored bytes can be replaced.`,
      needsPersist: false,
      protectedRaw: raw,
      requiresConfirmedReset: true,
    }
  }

  private restoreStoredBytes(originalRaw: string | null) {
    if (!this.activeStorage) return false
    try {
      if (this.activeStorage.getItem(STORAGE_KEY) !== originalRaw) {
        if (originalRaw === null) {
          this.activeStorage.removeItem(STORAGE_KEY)
        } else {
          this.activeStorage.setItem(STORAGE_KEY, originalRaw)
        }
      }
      return this.activeStorage.getItem(STORAGE_KEY) === originalRaw
    } catch {
      return false
    }
  }

  private preserveOriginalMigrationBytes(originalRaw: string) {
    return this.restoreStoredBytes(originalRaw)
  }

  private persistCandidate(candidate: DemoState) {
    if (!this.activeStorage) return
    let originalRaw: string | null
    try {
      originalRaw = this.activeStorage.getItem(STORAGE_KEY)
    } catch {
      throw new DomainError(
        'Browser storage could not be checked before saving. Nothing changed; please try again.',
        'STORAGE_READ_FAILED',
      )
    }
    try {
      const serialized = JSON.stringify(candidate)
      if (typeof serialized !== 'string') throw new Error('Demo state did not serialize.')
      this.activeStorage.setItem(STORAGE_KEY, serialized)
      if (this.activeStorage.getItem(STORAGE_KEY) !== serialized) {
        throw new Error('Browser storage did not preserve the exact saved bytes.')
      }
    } catch {
      if (!this.restoreStoredBytes(originalRaw)) {
        this.writeAuthority = false
        throw new DomainError(
          'Browser storage could not save or safely restore the previous data. This writer is blocked; reload before making another change.',
          'STORAGE_WRITE_UNCERTAIN',
        )
      }
      throw new DomainError(
        'Browser storage could not save this change. The previous browser data was restored exactly, so nothing changed; please try again.',
        'STORAGE_WRITE_FAILED',
      )
    }
  }

  private persistPendingLoadedState() {
    if (!this.activeStorage || !this.pendingPersist) return
    let currentRaw: string | null
    try {
      currentRaw = this.activeStorage.getItem(STORAGE_KEY)
    } catch {
      throw new DomainError(
        'Browser storage could not be re-read safely. Nothing changed; please try again.',
        'STORAGE_READ_FAILED',
      )
    }
    if (this.migratedFromRaw !== undefined && currentRaw !== this.migratedFromRaw) {
      throw new DomainError(
        'Demo data changed before the safe upgrade could be saved. Nothing changed; please try again.',
        'STATE_CONFLICT',
      )
    }
    if (this.storageWasMissing && currentRaw !== null) {
      throw new DomainError(
        'Demo data appeared in another tab before this tab became active. Nothing changed; please try again.',
        'STATE_CONFLICT',
      )
    }
    this.persistCandidate(this.state)
    this.pendingPersist = false
    this.migratedFromRaw = undefined
    this.migratedFromVersion = undefined
    this.storageWasMissing = false
  }

  private assertWriteAuthority() {
    if (!this.writeAuthority) {
      throw new DomainError(
        'This tab does not have write authority. Wait until it becomes the active demo tab before changing data.',
        'WRITE_AUTHORITY_REQUIRED',
      )
    }
  }

  private assertOrdinaryUpdatesAllowed() {
    if (this.requiresConfirmedReset) {
      throw new DomainError(
        'Stored demo data is protected and memory-only. Confirm Reset demo data before making any other change.',
        'CONFIRMED_RESET_REQUIRED',
      )
    }
  }

  grantWriteAuthority() {
    if (this.writeAuthority) return
    this.syncFromStorage()
    const originalMigrationRaw = this.migratedFromRaw
    const originalMigrationVersion = this.migratedFromVersion
    try {
      this.persistPendingLoadedState()
    } catch (caught) {
      if (originalMigrationRaw !== undefined) {
        const preserved = this.preserveOriginalMigrationBytes(originalMigrationRaw)
        this.recoveryNotice =
          `Demo data was upgraded in memory, but browser storage could not save the upgrade. ${
            preserved
              ? `The original version ${originalMigrationVersion ?? 5} bytes were restored exactly.`
              : `The original version ${originalMigrationVersion ?? 5} bytes could not be verified, so this tab remains blocked.`
          }`
      }
      throw caught
    }
    this.writeAuthority = true
  }

  revokeWriteAuthority() {
    this.writeAuthority = false
  }

  hasWriteAuthority() {
    return this.writeAuthority
  }

  hasPersistentStorage() {
    return Boolean(this.activeStorage)
  }

  getSnapshot = () => this.state

  getServerSnapshot = () => this.state

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private readCurrentStoredState(): DemoState | undefined {
    if (!this.activeStorage) return undefined
    let raw: string | null
    try {
      raw = this.activeStorage.getItem(STORAGE_KEY)
    } catch {
      throw new DomainError(
        'Browser storage could not be re-read safely. Nothing changed; please try again.',
        'STORAGE_READ_FAILED',
      )
    }
    if (raw === null && this.storageWasMissing) return undefined
    if (raw === null) {
      throw new DomainError(
        'Stored demo data is missing. Nothing changed; refresh to recover safely.',
        'STORED_STATE_INVALID',
      )
    }
    if (this.requiresConfirmedReset && raw === this.protectedRaw) return undefined
    if (this.pendingPersist && this.migratedFromRaw !== undefined && raw === this.migratedFromRaw) {
      return undefined
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isDemoState(parsed)) throw new Error('Stored state is invalid.')
      return parsed
    } catch {
      throw new DomainError(
        'Stored demo data is invalid. Nothing changed; refresh to recover safely.',
        'STORED_STATE_INVALID',
      )
    }
  }

  private assertCurrentStoredStateMatchesSnapshot() {
    const stored = this.readCurrentStoredState()
    if (
      stored &&
      (
        stored.revision !== this.state.revision ||
        JSON.stringify(stored) !== JSON.stringify(this.state)
      )
    ) {
      throw new DomainError(
        'Demo data changed in another tab. Sync or refresh before trying again.',
        'STATE_CONFLICT',
      )
    }
  }

  private assertAuditHistoryAppendOnly(draft: DemoState) {
    const existing = this.state.audits
    const reject = () => {
      throw new DomainError(
        'Existing audit history cannot be edited, removed, reordered, replaced, or rechained.',
        'AUDIT_HISTORY_MUTATED',
      )
    }
    if (draft.audits.length < existing.length) reject()
    for (let index = 0; index < existing.length; index += 1) {
      if (!sameStoredValue(draft.audits[index], existing[index])) reject()
    }
    for (let index = existing.length; index < draft.audits.length; index += 1) {
      const audit = draft.audits[index]
      if (
        !audit ||
        audit.sequence !== index + 1 ||
        audit.previousId !== draft.audits[index - 1]?.id
      ) {
        reject()
      }
    }
    if (
      draft.auditCount !== draft.audits.length ||
      draft.auditHeadId !== draft.audits.at(-1)?.id
    ) {
      reject()
    }
  }

  update<T>(mutator: (draft: DemoState) => T): T {
    this.assertWriteAuthority()
    this.assertOrdinaryUpdatesAllowed()
    this.assertCurrentStoredStateMatchesSnapshot()
    const draft = cloneState(this.state)
    const result = mutator(draft)
    this.assertAuditHistoryAppendOnly(draft)
    draft.revision += 1
    validateDemoState(draft)
    this.persistCandidate(draft)
    this.state = deepFreeze(draft)
    this.listeners.forEach((listener) => listener())
    return result
  }

  syncFromStorage() {
    const stored = this.readCurrentStoredState()
    if (!stored) return false
    if (stored.revision < this.state.revision) {
      throw new DomainError(
        'Stored demo data is older than this tab, so it was not adopted.',
        'STATE_SYNC_REJECTED',
      )
    }
    if (stored.revision === this.state.revision) {
      if (JSON.stringify(stored) !== JSON.stringify(this.state)) {
        throw new DomainError(
          'Stored demo data changed without a newer revision, so it was not adopted.',
          'STATE_SYNC_REJECTED',
        )
      }
      this.clearRecoveryState()
      return false
    }
    this.state = deepFreeze(stored)
    this.clearRecoveryState()
    this.listeners.forEach((listener) => listener())
    return true
  }

  private clearRecoveryState() {
    this.requiresConfirmedReset = false
    this.protectedRaw = undefined
    this.pendingPersist = false
    this.migratedFromRaw = undefined
    this.migratedFromVersion = undefined
    this.storageWasMissing = false
    this.recoveryNotice = null
  }

  private readStoredRevisionForReset() {
    if (!this.activeStorage) return undefined
    let raw: string | null
    try {
      raw = this.activeStorage.getItem(STORAGE_KEY)
    } catch {
      throw new DomainError(
        'Browser storage could not be re-read safely. Nothing changed; please try again.',
        'STORAGE_READ_FAILED',
      )
    }
    if (raw === null) return undefined
    try {
      const parsed: unknown = JSON.parse(raw)
      if (
        record(parsed) &&
        Number.isSafeInteger(parsed.revision) &&
        (parsed.revision as number) >= 0
      ) {
        return parsed.revision as number
      }
    } catch {
      // Corrupt bytes have no revision that can be derived safely.
    }
    return undefined
  }

  reset() {
    this.assertWriteAuthority()
    const storedRevision = this.readStoredRevisionForReset()
    const nextRevision = Math.max(this.state.revision, storedRevision ?? 0) + 1
    if (!Number.isSafeInteger(nextRevision)) {
      throw new DomainError(
        'Stored demo data has no safe next revision. Nothing changed.',
        'STORED_REVISION_INVALID',
      )
    }
    const candidate = createDemoState()
    candidate.revision = nextRevision
    validateDemoState(candidate)
    this.persistCandidate(candidate)
    this.state = deepFreeze(candidate)
    this.clearRecoveryState()
    this.listeners.forEach((listener) => listener())
  }

  exportForTest() {
    return cloneState(this.state)
  }
}
