import { cloneState } from '../domain/guards'
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
  readonly recoveryNotice: string | null

  constructor(private readonly storage?: StorageLike) {
    const loaded = this.load()
    this.state = loaded.state
    this.recoveryNotice = loaded.notice
    this.persist()
  }

  private load(): { state: DemoState; notice: string | null } {
    if (!this.storage) return { state: createDemoState(), notice: null }
    try {
      const raw = this.storage.getItem(STORAGE_KEY)
      if (!raw) return { state: createDemoState(), notice: 'Demo data was missing, so a fresh safe copy was loaded.' }
      const parsed: unknown = JSON.parse(raw)
      if (!isDemoState(parsed)) {
        return { state: createDemoState(), notice: 'Old or incomplete demo data was replaced with the current safe version.' }
      }
      return { state: parsed, notice: null }
    } catch {
      return { state: createDemoState(), notice: 'Damaged demo data was recovered automatically.' }
    }
  }

  private persist() {
    this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state))
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
    this.state = draft
    this.persist()
    this.listeners.forEach((listener) => listener())
    return result
  }

  reset() {
    this.state = createDemoState()
    this.persist()
    this.listeners.forEach((listener) => listener())
  }

  exportForTest() {
    return cloneState(this.state)
  }
}
