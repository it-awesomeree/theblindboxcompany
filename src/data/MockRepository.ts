import { cloneState, DomainError } from '../domain/guards'
import type { DemoState } from '../domain/types'
import { createDemoState } from './fixtures'
import { isDemoState, validateDemoState } from './StateValidator'

export const STORAGE_KEY = 'tbbc:demo:repository:v5'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export class MockRepository {
  private state: DemoState
  private listeners = new Set<() => void>()
  private activeStorage?: StorageLike
  recoveryNotice: string | null = null

  constructor(storage?: StorageLike) {
    this.activeStorage = storage
    const loaded = this.load()
    this.state = loaded.state
    this.recoveryNotice = loaded.notice
    if (loaded.needsPersist && this.activeStorage) {
      try {
        this.persistCandidate(this.state)
      } catch {
        this.activeStorage = undefined
        this.recoveryNotice = `${loaded.notice ?? 'Safe demo data was loaded.'} Browser storage could not save it, so this tab is continuing in memory only.`
      }
    }
  }

  private load(): { state: DemoState; notice: string | null; needsPersist: boolean } {
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
      if (!isDemoState(parsed)) {
        return {
          state: createDemoState(),
          notice: 'Old or incomplete demo data was replaced with the current safe version.',
          needsPersist: true,
        }
      }
      return { state: parsed, notice: null, needsPersist: false }
    } catch {
      return {
        state: createDemoState(),
        notice: 'Damaged demo data was recovered automatically.',
        needsPersist: true,
      }
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

  update<T>(mutator: (draft: DemoState) => T): T {
    const draft = cloneState(this.state)
    const result = mutator(draft)
    draft.revision += 1
    validateDemoState(draft)
    this.persistCandidate(draft)
    this.state = draft
    this.listeners.forEach((listener) => listener())
    return result
  }

  reset() {
    const candidate = createDemoState()
    validateDemoState(candidate)
    this.persistCandidate(candidate)
    this.state = candidate
    this.listeners.forEach((listener) => listener())
  }

  exportForTest() {
    return cloneState(this.state)
  }
}
