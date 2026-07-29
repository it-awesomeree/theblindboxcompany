import { SCHEMA_VERSION, VALUE_FLOOR_SEN } from '../domain/constants'
import { canonicalizeAuditEvidence } from '../domain/auditEvidence'
import { assert, cloneState, DomainError } from '../domain/guards'
import { exactOddsLabel } from '../domain/odds'
import {
  expectedBoxStatusForScope,
  resolveOrderFulfillment,
} from '../domain/orderFulfillment'
import {
  expectedClaimRemedySnapshot,
  isTerminalReplacementRefundFallback,
  terminalReplacementFallbackAmount,
} from '../domain/remedyPolicy'
import type { AuditEntry, Claim, DemoState, Shipment } from '../domain/types'
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
  migratedFromVersion?: 5 | 6 | 7
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
      .reduce((sum, prior) => sum + (prior.refundIntent?.amountSen ?? 0), 0)
    return {
      amountSen: amountSen!,
      payment,
      priorRefundedSen,
    }
  }
  return undefined
}

export function migrateDemoStateV7(value: unknown): DemoState {
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
    schemaVersion: SCHEMA_VERSION,
    claims: [],
  } as DemoState
  candidate.claims = legacy.claims.map((claim) => {
    const snapshot = expectedClaimRemedySnapshot(candidate, claim)
    const refund = linkedRefundEvidence(candidate, claim)
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
  normalizeMigratedFulfillment(candidate)
  validateDemoState(candidate)
  return candidate
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
      if (record(parsed) && parsed.schemaVersion === 7) {
        try {
          return {
            state: migrateDemoStateV7(parsed),
            notice: 'Demo data was upgraded safely from version 7 to version 8.',
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
            notice: 'Demo data was upgraded safely from version 6 through version 7 to version 8.',
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
            notice: 'Demo data was upgraded safely from version 5 through version 6 and version 7 to version 8.',
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
    try {
      this.persistPendingLoadedState()
    } catch (caught) {
      if (originalMigrationRaw !== undefined) {
        const preserved = this.preserveOriginalMigrationBytes(originalMigrationRaw)
        this.recoveryNotice =
          `Demo data was upgraded in memory, but browser storage could not save the upgrade. ${
            preserved
              ? 'The original version 5 bytes were restored exactly.'
              : 'The original version 5 bytes could not be verified, so this tab remains blocked.'
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
