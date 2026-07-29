import { SCHEMA_VERSION } from '../domain/constants'
import { canonicalizeAuditEvidence } from '../domain/auditEvidence'
import { cloneState, DomainError } from '../domain/guards'
import type { AuditEntry, DemoState } from '../domain/types'
import { createDemoState } from './fixtures'
import { isDemoState, validateDemoState } from './StateValidator'

// Deliberately unchanged so existing version 5 browser data can be migrated in place.
export const STORAGE_KEY = 'tbbc:demo:repository:v5'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

type LegacyAuditEntryV5 = Omit<AuditEntry, 'sequence' | 'previousId' | 'outcome'>
type LegacyDemoStateV5 = Omit<
  DemoState,
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

export function migrateDemoStateV5(value: unknown): DemoState {
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
  const candidate = {
    ...legacy,
    schemaVersion: SCHEMA_VERSION,
    auditCount: audits.length,
    auditHeadId: audits.at(-1)?.id ?? '',
    audits,
  } as DemoState
  validateDemoState(candidate)
  return candidate
}

export class MockRepository {
  private state: DemoState
  private listeners = new Set<() => void>()
  private activeStorage?: StorageLike
  recoveryNotice: string | null = null

  constructor(storage?: StorageLike) {
    this.activeStorage = storage
    const loaded = this.load()
    this.state = deepFreeze(loaded.state)
    this.recoveryNotice = loaded.notice
    if (loaded.needsPersist && this.activeStorage) {
      try {
        this.persistCandidate(this.state)
      } catch {
        const preserved = loaded.migratedFromRaw
          ? this.preserveOriginalMigrationBytes(loaded.migratedFromRaw)
          : false
        this.activeStorage = undefined
        this.recoveryNotice = loaded.migratedFromRaw
          ? `${loaded.notice ?? 'Demo data was upgraded in memory.'} Browser storage could not save the upgrade. ${
              preserved
                ? 'The original version 5 data was left unchanged, and this tab is continuing safely in memory only.'
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
    if (!raw) {
      return {
        state: createDemoState(),
        notice: 'Demo data was missing, so a fresh safe copy was loaded.',
        needsPersist: true,
      }
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (isDemoState(parsed)) {
        return { state: parsed, notice: null, needsPersist: false }
      }
      if (record(parsed) && parsed.schemaVersion === 5) {
        try {
          return {
            state: migrateDemoStateV5(parsed),
            notice: 'Demo data was upgraded safely from version 5 to version 6.',
            needsPersist: true,
            migratedFromRaw: raw,
          }
        } catch {
          // Invalid version 5 data follows the same safe fixture recovery path below.
        }
      }
      return {
        state: createDemoState(),
        notice: 'Old or incomplete demo data was replaced with the current safe version.',
        needsPersist: true,
      }
    } catch {
      return {
        state: createDemoState(),
        notice: 'Damaged demo data was recovered automatically.',
        needsPersist: true,
      }
    }
  }

  private preserveOriginalMigrationBytes(originalRaw: string) {
    if (!this.activeStorage) return false
    try {
      if (this.activeStorage.getItem(STORAGE_KEY) !== originalRaw) {
        this.activeStorage.setItem(STORAGE_KEY, originalRaw)
      }
      return this.activeStorage.getItem(STORAGE_KEY) === originalRaw
    } catch {
      return false
    }
  }

  private persistCandidate(candidate: DemoState) {
    if (!this.activeStorage) return
    try {
      const serialized = JSON.stringify(candidate)
      if (typeof serialized !== 'string') throw new Error('Demo state did not serialize.')
      this.activeStorage.setItem(STORAGE_KEY, serialized)
    } catch {
      throw new DomainError(
        'Browser storage could not save this change. Nothing changed; please try again.',
        'STORAGE_WRITE_FAILED',
      )
    }
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
    if (!raw) {
      throw new DomainError(
        'Stored demo data is missing. Nothing changed; refresh to recover safely.',
        'STORED_STATE_INVALID',
      )
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
      return false
    }
    this.state = deepFreeze(stored)
    this.listeners.forEach((listener) => listener())
    return true
  }

  reset() {
    this.assertCurrentStoredStateMatchesSnapshot()
    const candidate = createDemoState()
    validateDemoState(candidate)
    this.persistCandidate(candidate)
    this.state = deepFreeze(candidate)
    this.listeners.forEach((listener) => listener())
  }

  exportForTest() {
    return cloneState(this.state)
  }
}
