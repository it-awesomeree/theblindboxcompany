import type { StorageLike } from '../src/data/MockRepository'

export class MemoryStorage implements StorageLike {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  seed(key: string, value: string) { this.values.set(key, value) }
}

export class CountingStorage extends MemoryStorage {
  writes = 0

  setItem(key: string, value: string) {
    this.writes += 1
    super.setItem(key, value)
  }
}

export const FIXED_NOW = '2026-07-28T04:00:00.000Z'
