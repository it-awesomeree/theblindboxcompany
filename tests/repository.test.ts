import { describe, expect, it, vi } from 'vitest'
import { MockRepository, STORAGE_KEY } from '../src/data/MockRepository'
import { createDemoState } from '../src/data/fixtures'
import { validateDemoState } from '../src/data/StateValidator'
import {
  AUDIT_EVIDENCE_MAX_BYTES,
  canonicalizeAuditEvidence,
} from '../src/domain/auditEvidence'
import { CLAIM_EVIDENCE_WIDENING_NOTE } from '../src/domain/claimStatus'
import {
  BOX_PRICE_SEN,
  MAX_CART_QUANTITY,
  VALUE_FLOOR_SEN,
} from '../src/domain/constants'
import { exactOddsLabel } from '../src/domain/odds'
import type { DemoState } from '../src/domain/types'
import { AppServices } from '../src/services/AppServices'
import {
  CountingStorage,
  FIXED_NOW,
  MemoryStorage,
  makeProcessingOrderTwoPhysicalShipments,
} from './helpers'

class FaultStorage extends MemoryStorage {
  throwOnRead = false
  throwOnWrite = false
  failNextWrites = 0
  writeAttempts = 0
  successfulWrites = 0

  getItem(key: string) {
    if (this.throwOnRead) throw new Error('read blocked')
    return super.getItem(key)
  }

  setItem(key: string, value: string) {
    this.writeAttempts += 1
    if (this.throwOnWrite || this.failNextWrites > 0) {
      this.failNextWrites = Math.max(0, this.failNextWrites - 1)
      throw new Error('write blocked')
    }
    super.setItem(key, value)
    this.successfulWrites += 1
  }
}

class MutateThenFailOnceStorage extends MemoryStorage {
  failAfterNextWrite = false

  setItem(key: string, value: string) {
    super.setItem(key, value)
    if (this.failAfterNextWrite) {
      this.failAfterNextWrite = false
      throw new Error('write failed after mutation')
    }
  }
}

function servicesWithClaim(
  kind: 'damage' | 'non_delivery' | 'value_floor',
  now: () => string = () => FIXED_NOW,
) {
  const services = new AppServices(new MemoryStorage(), now)
  services.auth.oneClick('customer')
  if (kind === 'damage') {
    services.claims.submit({
      orderId: 'ord-delivered',
      kind,
      shipmentId: 'shp-delivered',
      note: 'DEMO delivered physical damage evidence',
    })
  } else if (kind === 'non_delivery') {
    services.claims.submit({
      orderId: 'ord-shipped',
      kind,
      shipmentId: 'shp-shipped',
      note: 'DEMO overdue non-delivery evidence',
    })
  } else {
    services.claims.submit({
      orderId: 'ord-delivered',
      kind,
      boxId: 'box-delivered-01',
      note: 'DEMO revealed value-floor evidence',
    })
  }
  return services
}

function stateWithSealedMultiShipmentClaim() {
  const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
  makeProcessingOrderTwoPhysicalShipments(services)
  services.auth.oneClick('admin')
  for (const [shipmentId, path] of [
    ['shp-processing', ['packed', 'label_created', 'shipped', 'failed_delivery']],
    ['shp-digital', ['picking', 'packed', 'label_created', 'shipped', 'failed_delivery']],
  ] as const) {
    for (const status of path) {
      services.fulfilment.advance(shipmentId, status, `Confirmed candidate validation setup ${status}`)
    }
  }
  services.repository.update((state) => {
    state.boxes.find((box) => box.id === 'box-processing-01')!.revealedAt = undefined
  })
  services.auth.oneClick('customer')
  services.claims.submit({
    orderId: 'ord-processing',
    kind: 'non_delivery',
    orderLevelDelivery: true,
    note: 'DEMO canonical order-level candidate validation',
  })
  return services.repository.exportForTest()
}

function stateWithWidenedSealedClaim() {
  let now = '2026-07-28T04:00:00.000Z'
  const services = new AppServices(new MemoryStorage(), () => now)
  makeProcessingOrderTwoPhysicalShipments(services)
  services.auth.oneClick('admin')
  now = '2026-07-28T05:00:00.000Z'
  for (const status of ['packed', 'label_created', 'shipped', 'failed_delivery'] as const) {
    services.fulfilment.advance('shp-processing', status, `Confirmed persisted first evidence ${status}`)
  }
  services.auth.oneClick('customer')
  now = '2026-07-28T06:00:00.000Z'
  services.claims.submit({
    orderId: 'ord-processing',
    kind: 'non_delivery',
    orderLevelDelivery: true,
    note: 'DEMO persisted first neutral evidence',
  })
  services.auth.oneClick('admin')
  now = '2026-07-28T07:00:00.000Z'
  for (const status of ['picking', 'packed', 'label_created', 'shipped', 'failed_delivery'] as const) {
    services.fulfilment.advance('shp-digital', status, `Confirmed persisted second evidence ${status}`)
  }
  services.auth.oneClick('customer')
  now = '2026-07-28T08:00:00.000Z'
  services.claims.submit({
    orderId: 'ord-processing',
    kind: 'non_delivery',
    orderLevelDelivery: true,
    note: 'DEMO persisted widened neutral evidence',
  })
  return services.repository.exportForTest()
}

function auditBusinessFields(audit: DemoState['audits'][number]) {
  const businessFields = structuredClone(audit) as Partial<DemoState['audits'][number]>
  delete businessFields.sequence
  delete businessFields.previousId
  delete businessFields.outcome
  return businessFields
}

function toVersion5(state: DemoState = createDemoState()) {
  const businessState = structuredClone(state) as Partial<DemoState>
  const audits = state.audits.map(auditBusinessFields)
  for (const order of businessState.orders ?? []) {
    delete (order.snapshot as Partial<typeof order.snapshot>).valueFloorSen
  }
  for (const series of businessState.series ?? []) {
    for (const prize of [
      ...(series.publishedPrizes ?? []),
      ...(series.draftPrizes ?? []),
    ]) {
      prize.odds = prize.id === 'iphone17'
        ? '1 in 3,333'
        : `legacy odds ${prize.allocation}`
    }
  }
  delete businessState.auditCount
  delete businessState.auditHeadId
  delete businessState.audits
  return {
    ...businessState,
    schemaVersion: 5 as const,
    audits,
  }
}

function ordersWithoutValueFloor(orders: DemoState['orders']) {
  return structuredClone(orders).map((order) => {
    delete (order.snapshot as Partial<typeof order.snapshot>).valueFloorSen
    return order
  })
}

function seriesWithoutOdds(series: DemoState['series']) {
  const copy = structuredClone(series)
  for (const entry of copy) {
    for (const prize of [
      ...(entry.publishedPrizes ?? []),
      ...(entry.draftPrizes ?? []),
    ]) {
      delete (prize as Partial<typeof prize>).odds
    }
  }
  return copy
}

function stateWithTwoAudits() {
  const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
  services.auth.oneClick('customer')
  services.openBox('box-unopened-01')
  return services.repository.exportForTest()
}

function stateWithLinkedRefundClaim(resolved = false) {
  const services = servicesWithClaim('damage')
  const claim = services.repository.getSnapshot().claims[0]
  services.auth.oneClick('admin')
  services.claims.review(claim.id, 'acknowledge', 'Acknowledged linked validator evidence')
  services.claims.review(claim.id, 'approve', 'Approved linked validator evidence')
  services.payments.refund(
    'pay-delivered',
    1000,
    'Confirmed linked validator refund',
    'req-linked-validator-refund',
    claim.id,
  )
  if (resolved) {
    const linked = services.repository.getSnapshot().claims[0].linkedRefundEventId!
    services.claims.review(
      claim.id,
      'resolve',
      'Resolved with the exact linked and audited refund event',
      { outcome: 'refund_recorded', reference: linked },
    )
  }
  return services.repository.exportForTest()
}

describe('MockRepository recovery and persistence', () => {
  it('accepts both approved intermediate and resolved bidirectional claim-refund links', () => {
    expect(() => validateDemoState(stateWithLinkedRefundClaim())).not.toThrow()
    expect(() => validateDemoState(stateWithLinkedRefundClaim(true))).not.toThrow()
  })

  it.each([
    ['missing claim reverse link', (state: DemoState) => {
      delete state.claims[0].linkedRefundEventId
    }],
    ['wrong refund-event claim ID', (state: DemoState) => {
      const event = state.payments.find((payment) => payment.id === 'pay-delivered')!
        .events.find((entry) => entry.requestId === 'req-linked-validator-refund')!
      event.refundIntent!.claimId = 'clm-wrong-link-owner'
    }],
    ['refund event before claim creation', (state: DemoState) => {
      const event = state.payments.find((payment) => payment.id === 'pay-delivered')!
        .events.find((entry) => entry.requestId === 'req-linked-validator-refund')!
      event.createdAt = '2026-07-28T03:59:59.000Z'
      event.processedAt = event.createdAt
    }],
    ['missing matching payment refund audit', (state: DemoState) => {
      const audit = state.audits.find((entry) =>
        entry.action === 'payment.partially_refunded' &&
        entry.requestId === 'req-linked-validator-refund')!
      audit.eventId = 'evt-missing-payment-refund-audit'
    }],
    ['ignored linked refund event', (state: DemoState) => {
      const event = state.payments.find((payment) => payment.id === 'pay-delivered')!
        .events.find((entry) => entry.requestId === 'req-linked-validator-refund')!
      event.ignoredReason = 'Tampered into an ignored event'
    }],
    ['tampered claim-link audit evidence', (state: DemoState) => {
      const audit = state.audits.find((entry) =>
        entry.action === 'claim.refund_linked')!
      const after = audit.after as Record<string, unknown>
      after.paymentId = 'pay-wrong-audit'
    }],
    ['one refund event reused across two claims', (state: DemoState) => {
      const original = state.claims[0]
      const reused = structuredClone(original)
      reused.id = 'clm-reused-refund-event'
      reused.requestId = 'req-clm-reused-refund-event'
      reused.kind = 'value_floor'
      reused.note = 'DEMO second claim reusing one refund event'
      delete reused.shipmentId
      reused.boxId = 'box-delivered-01'
      reused.history = reused.history.map((entry, index) => ({
        ...entry,
        id: `${reused.id}-h-${String(index + 1).padStart(2, '0')}`,
        ...(index === 0 ? { note: reused.note } : {}),
      }))
      state.claims.push(reused)
      state.orders.find((order) => order.id === reused.orderId)!.claimIds.push(reused.id)
    }],
  ] as Array<[string, (state: DemoState) => void]>)(
    'rejects linked refund corruption: %s',
    (_label, mutate) => {
      const state = stateWithLinkedRefundClaim()
      mutate(state)
      expect(() => validateDemoState(state)).toThrow()
    },
  )

  it.each([
    ['mismatched resolution reference', (state: DemoState) => {
      state.claims[0].resolutionReference = 'evt-ord-delivered-success'
    }],
    ['non-refund resolution carrying a refund link', (state: DemoState) => {
      const claim = state.claims[0]
      claim.resolutionOutcome = 'replacement_authorized'
      claim.resolutionReference = `DEMO-${claim.id.toUpperCase()}`
      claim.resolutionNote = 'Descriptive replacement must not retain a refund link'
    }],
    ['resolved refund with its reverse link removed', (state: DemoState) => {
      delete state.claims[0].linkedRefundEventId
    }],
  ] as Array<[string, (state: DemoState) => void]>)(
    'rejects refund resolution corruption: %s',
    (_label, mutate) => {
      const state = stateWithLinkedRefundClaim(true)
      mutate(state)
      expect(() => validateDemoState(state)).toThrow()
    },
  )

  it('recovers missing data with current schema fixtures', () => {
    const storage = new MemoryStorage()
    const repository = new MockRepository(storage)
    expect(repository.getSnapshot().schemaVersion).toBe(6)
    expect(repository.recoveryNotice).toMatch(/missing/i)
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).schemaVersion).toBe(6)
  })

  it('keeps corrupt bytes untouched and requires an explicit confirmed reset', () => {
    const storage = new MemoryStorage()
    const raw = '{not-json'
    storage.seed(STORAGE_KEY, raw)
    const repository = new MockRepository(storage)
    expect(repository.getSnapshot().orders.length).toBeGreaterThan(0)
    expect(repository.recoveryNotice).toMatch(/exact original browser bytes.+memory only.+not saved.+explicit confirmed reset/i)
    expect(storage.getItem(STORAGE_KEY)).toBe(raw)
    expect(() => repository.update((state) => {
      state.cart = []
    })).toThrow(expect.objectContaining({ code: 'CONFIRMED_RESET_REQUIRED' }))
  })

  it('keeps an unsupported older schema untouched instead of silently replacing it', () => {
    const storage = new MemoryStorage()
    const raw = '{ "schemaVersion": 2, "revision": 14, "users": [] }'
    storage.seed(STORAGE_KEY, raw)
    const repository = new MockRepository(storage)
    expect(repository.getSnapshot().schemaVersion).toBe(6)
    expect(repository.recoveryNotice).toMatch(/unsupported old version 2.+left unchanged.+explicit confirmed reset/i)
    expect(storage.getItem(STORAGE_KEY)).toBe(raw)
  })

  it.each([
    {
      label: 'empty invalid storage',
      raw: '',
      expectedRevision: 2,
      notice: /damaged.+exact original browser bytes.+memory only.+not saved.+explicit confirmed reset/i,
    },
    {
      label: 'corrupt JSON',
      raw: '{ "schemaVersion": 6, broken',
      expectedRevision: 2,
      notice: /damaged.+exact original browser bytes.+memory only.+not saved.+explicit confirmed reset/i,
    },
    {
      label: 'invalid current schema',
      raw: (() => {
        const invalid = createDemoState() as Partial<DemoState>
        invalid.revision = 41
        delete invalid.cart
        return JSON.stringify(invalid)
      })(),
      expectedRevision: 42,
      notice: /version 6.+failed the safety checks.+exact original browser bytes.+explicit confirmed reset/i,
    },
    {
      label: 'future schema',
      raw: '{ "schemaVersion": 99, "revision": 87, "opaque": "KEEP EXACTLY" }',
      expectedRevision: 88,
      notice: /newer unsupported version 99.+not silently downgraded.+exact original browser bytes.+explicit confirmed reset/i,
    },
  ])(
    'protects $label bytes, blocks ordinary updates, and resets monotonically only after confirmation',
    ({ raw, expectedRevision, notice }) => {
      const storage = new CountingStorage()
      storage.seed(STORAGE_KEY, raw)
      const repository = new MockRepository(storage)
      const published = repository.getSnapshot()
      const mutator = vi.fn((state: DemoState) => {
        state.sessionUserId = 'usr-demo-customer'
      })
      const listener = vi.fn()
      repository.subscribe(listener)

      expect(storage.getItem(STORAGE_KEY)).toBe(raw)
      expect(storage.writes).toBe(0)
      expect(repository.recoveryNotice).toMatch(notice)
      expect(() => repository.update(mutator)).toThrow(
        expect.objectContaining({ code: 'CONFIRMED_RESET_REQUIRED' }),
      )
      expect(mutator).not.toHaveBeenCalled()
      expect(repository.getSnapshot()).toBe(published)
      expect(storage.getItem(STORAGE_KEY)).toBe(raw)
      expect(storage.writes).toBe(0)
      expect(listener).not.toHaveBeenCalled()

      repository.reset()

      expect(repository.getSnapshot()).toMatchObject({
        schemaVersion: 6,
        revision: expectedRevision,
        sessionUserId: null,
        cart: [{ quantity: 1 }],
      })
      expect(() => validateDemoState(repository.getSnapshot())).not.toThrow()
      expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual(repository.getSnapshot())
      expect(storage.writes).toBe(1)
      expect(repository.recoveryNotice).toBeNull()
      expect(listener).toHaveBeenCalledOnce()
    },
  )

  it('rejects authority-disabled updates and resets before mutators, storage, or listeners', () => {
    const storage = new CountingStorage()
    const raw = JSON.stringify(createDemoState())
    storage.seed(STORAGE_KEY, raw)
    const repository = new MockRepository(storage, { writeAuthority: false })
    const published = repository.getSnapshot()
    const mutator = vi.fn((state: DemoState) => {
      state.sessionUserId = 'usr-demo-customer'
    })
    const listener = vi.fn()
    repository.subscribe(listener)

    expect(repository.hasWriteAuthority()).toBe(false)
    expect(() => repository.update(mutator)).toThrow(
      expect.objectContaining({ code: 'WRITE_AUTHORITY_REQUIRED' }),
    )
    expect(() => repository.reset()).toThrow(
      expect.objectContaining({ code: 'WRITE_AUTHORITY_REQUIRED' }),
    )
    expect(mutator).not.toHaveBeenCalled()
    expect(repository.getSnapshot()).toBe(published)
    expect(storage.getItem(STORAGE_KEY)).toBe(raw)
    expect(storage.writes).toBe(0)
    expect(listener).not.toHaveBeenCalled()

    repository.grantWriteAuthority()
    expect(repository.hasWriteAuthority()).toBe(true)
    repository.revokeWriteAuthority()
    expect(repository.hasWriteAuthority()).toBe(false)
  })

  it('does not initialize missing storage until disabled authority is granted', () => {
    const storage = new CountingStorage()
    const repository = new MockRepository(storage, { writeAuthority: false })

    expect(repository.hasWriteAuthority()).toBe(false)
    expect(storage.getItem(STORAGE_KEY)).toBeNull()
    expect(storage.writes).toBe(0)

    repository.grantWriteAuthority()

    expect(repository.hasWriteAuthority()).toBe(true)
    expect(storage.writes).toBe(1)
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual(repository.getSnapshot())
  })

  it('lets a second disabled repository adopt first-tab initialization before taking authority', () => {
    const storage = new CountingStorage()
    const first = new MockRepository(storage, { writeAuthority: false })
    const waiting = new MockRepository(storage, { writeAuthority: false })

    first.grantWriteAuthority()
    first.revokeWriteAuthority()
    expect(storage.writes).toBe(1)

    expect(waiting.syncFromStorage()).toBe(false)
    expect(() => waiting.grantWriteAuthority()).not.toThrow()
    expect(waiting.hasWriteAuthority()).toBe(true)
    expect(storage.writes).toBe(1)
    expect(waiting.getSnapshot()).toEqual(first.getSnapshot())
  })

  it('does not rewrite an already-valid loaded snapshot', () => {
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))

    const repository = new MockRepository(storage)

    expect(repository.getSnapshot()).toEqual(createDemoState())
    expect(storage.writes).toBe(0)
    expect(repository.recoveryNotice).toBeNull()
  })

  it('defers a valid version 5 migration write until authority is granted', () => {
    const legacy = toVersion5(createDemoState())
    legacy.revision = 19
    const raw = JSON.stringify(legacy)
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, raw)

    const repository = new MockRepository(storage, { writeAuthority: false })

    expect(repository.getSnapshot()).toMatchObject({ schemaVersion: 6, revision: 19 })
    expect(storage.getItem(STORAGE_KEY)).toBe(raw)
    expect(storage.writes).toBe(0)

    repository.grantWriteAuthority()

    expect(repository.hasWriteAuthority()).toBe(true)
    expect(storage.writes).toBe(1)
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual(repository.getSnapshot())
  })

  it('restores exact version 5 bytes when a deferred migration write mutates then fails', () => {
    const legacy = toVersion5(createDemoState())
    legacy.revision = 23
    const raw = JSON.stringify(legacy)
    const storage = new MutateThenFailOnceStorage()
    storage.seed(STORAGE_KEY, raw)
    const repository = new MockRepository(storage, { writeAuthority: false })
    storage.failAfterNextWrite = true

    expect(() => repository.grantWriteAuthority()).toThrow(
      expect.objectContaining({ code: 'STORAGE_WRITE_FAILED' }),
    )

    expect(repository.hasWriteAuthority()).toBe(false)
    expect(storage.getItem(STORAGE_KEY)).toBe(raw)
    expect(repository.recoveryNotice).toMatch(/original version 5 bytes were restored exactly/i)
  })

  it('migrates valid custom version 5 business data once and then loads version 6 without writes', () => {
    const customServices = servicesWithClaim('damage')
    customServices.auth.oneClick('admin')
    customServices.admin.copyPublishedToDraft()
    const custom = customServices.repository.exportForTest()
    custom.revision = 42
    custom.sessionUserId = 'usr-demo-customer'
    custom.cart[0].quantity = 3
    custom.audits[0].reason = 'Loaded preserved custom fictional demo records'
    const legacy = toVersion5(custom)
    const raw = JSON.stringify(legacy)
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, raw)

    const migrated = new MockRepository(storage)
    const snapshot = migrated.getSnapshot()

    expect(snapshot.schemaVersion).toBe(6)
    expect(snapshot.revision).toBe(legacy.revision)
    expect(snapshot.users).toEqual(legacy.users)
    expect(ordersWithoutValueFloor(snapshot.orders)).toEqual(legacy.orders)
    expect(snapshot.orders.every((order) =>
      order.snapshot.valueFloorSen === VALUE_FLOOR_SEN)).toBe(true)
    expect(seriesWithoutOdds(snapshot.series)).toEqual(seriesWithoutOdds(legacy.series!))
    for (const series of snapshot.series) {
      for (const prize of [
        ...(series.publishedPrizes ?? []),
        ...(series.draftPrizes ?? []),
      ]) {
        expect(prize.odds).toBe(exactOddsLabel(prize.allocation, series.allocationTotal))
      }
      expect((series.publishedPrizes ?? series.draftPrizes)
        ?.find((prize) => prize.id === 'iphone17')?.odds).toBe('3 in 10,000')
    }
    expect(legacy.series?.every((series) =>
      (series.publishedPrizes ?? series.draftPrizes)
        ?.find((prize) => prize.id === 'iphone17')?.odds === '1 in 3,333'))
      .toBe(true)
    expect(snapshot.payments).toEqual(legacy.payments)
    expect(snapshot.boxes).toEqual(legacy.boxes)
    expect(snapshot.shipments).toEqual(legacy.shipments)
    expect(snapshot.claims).toEqual(legacy.claims)
    expect(snapshot.cart).toEqual(legacy.cart)
    expect(snapshot.audits.map(auditBusinessFields)).toEqual(legacy.audits)
    expect(snapshot.claims).toHaveLength(1)
    expect(snapshot.audits.map((audit) => audit.sequence)).toEqual(
      snapshot.audits.map((_, index) => index + 1),
    )
    expect(snapshot.audits.every((audit) => audit.outcome === 'applied')).toBe(true)
    expect(snapshot.audits.slice(1).every((audit, index) =>
      audit.previousId === snapshot.audits[index].id)).toBe(true)
    expect(snapshot.auditCount).toBe(snapshot.audits.length)
    expect(snapshot.auditHeadId).toBe(snapshot.audits.at(-1)?.id)
    expect(storage.writes).toBe(1)
    expect(migrated.recoveryNotice).toMatch(/upgraded safely from version 5 to version 6/i)

    const persistedAfterMigration = storage.getItem(STORAGE_KEY)
    const loadedAgain = new MockRepository(storage)
    expect(storage.writes).toBe(1)
    expect(storage.getItem(STORAGE_KEY)).toBe(persistedAfterMigration)
    expect(loadedAgain.getSnapshot()).toEqual(snapshot)
    expect(loadedAgain.recoveryNotice).toBeNull()
  })

  it('migrates valid version 5 business data with empty audit history using one deterministic anchor', () => {
    const custom = createDemoState()
    custom.revision = 73
    custom.sessionUserId = 'usr-demo-customer'
    custom.cart[0].quantity = 4
    const legacy = toVersion5(custom)
    legacy.audits = []
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(legacy))

    const repository = new MockRepository(storage)
    const snapshot = repository.getSnapshot()

    expect(snapshot).toMatchObject({
      schemaVersion: 6,
      revision: 73,
      sessionUserId: 'usr-demo-customer',
      cart: [{ quantity: 4 }],
      auditCount: 1,
      auditHeadId: 'audit-migration-v5-empty-anchor',
    })
    expect(snapshot.users).toEqual(legacy.users)
    expect(ordersWithoutValueFloor(snapshot.orders)).toEqual(legacy.orders)
    expect(snapshot.orders.every((order) =>
      order.snapshot.valueFloorSen === VALUE_FLOOR_SEN)).toBe(true)
    expect(seriesWithoutOdds(snapshot.series)).toEqual(seriesWithoutOdds(legacy.series!))
    expect(snapshot.payments).toEqual(legacy.payments)
    expect(snapshot.boxes).toEqual(legacy.boxes)
    expect(snapshot.shipments).toEqual(legacy.shipments)
    expect(snapshot.claims).toEqual(legacy.claims)
    expect(snapshot.audits).toEqual([{
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
    }])
    expect(storage.writes).toBe(1)
    expect(() => validateDemoState(snapshot)).not.toThrow()

    const persisted = storage.getItem(STORAGE_KEY)
    const loadedAgain = new MockRepository(storage)
    expect(storage.writes).toBe(1)
    expect(storage.getItem(STORAGE_KEY)).toBe(persisted)
    expect(loadedAgain.getSnapshot()).toEqual(snapshot)
  })

  it('keeps original version 5 bytes when migration persistence fails and continues with frozen version 6 memory', () => {
    const custom = createDemoState()
    custom.revision = 17
    custom.cart[0].quantity = 2
    const raw = JSON.stringify(toVersion5(custom))
    const storage = new FaultStorage()
    storage.seed(STORAGE_KEY, raw)
    storage.failNextWrites = 1

    const repository = new MockRepository(storage)

    expect(repository.getSnapshot()).toMatchObject({
      schemaVersion: 6,
      revision: 17,
      cart: [{ quantity: 2 }],
    })
    expect(Object.isFrozen(repository.getSnapshot().orders[0].snapshot.address)).toBe(true)
    expect(storage.getItem(STORAGE_KEY)).toBe(raw)
    expect(storage.successfulWrites).toBe(0)
    expect(repository.recoveryNotice).toMatch(
      /could not save the upgrade.+original version 5 data was left unchanged.+memory only/i,
    )

    repository.update((state) => { state.sessionUserId = 'usr-demo-customer' })
    expect(repository.getSnapshot().sessionUserId).toBe('usr-demo-customer')
    expect(storage.getItem(STORAGE_KEY)).toBe(raw)
  })

  it('blocks a stale writer before its mutator and lets it sync once before succeeding', () => {
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))
    const writerA = new MockRepository(storage)
    const writerB = new MockRepository(storage)
    const staleIdentity = writerB.getSnapshot()
    const mutator = vi.fn((state: DemoState) => {
      state.sessionUserId = 'usr-demo-admin'
    })
    const listener = vi.fn()
    writerB.subscribe(listener)

    writerA.update((state) => { state.sessionUserId = 'usr-demo-customer' })
    const persistedA = storage.getItem(STORAGE_KEY)
    const exactA = structuredClone(writerA.getSnapshot())

    expect(() => writerB.update(mutator)).toThrow(
      expect.objectContaining({ code: 'STATE_CONFLICT' }),
    )
    expect(mutator).not.toHaveBeenCalled()
    expect(writerB.getSnapshot()).toBe(staleIdentity)
    expect(writerB.getSnapshot().revision).toBe(1)
    expect(storage.getItem(STORAGE_KEY)).toBe(persistedA)
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual(exactA)
    expect(listener).not.toHaveBeenCalled()

    expect(writerB.syncFromStorage()).toBe(true)
    expect(writerB.getSnapshot()).toEqual(exactA)
    expect(writerB.getSnapshot()).not.toBe(staleIdentity)
    expect(listener).toHaveBeenCalledOnce()
    expect(writerB.syncFromStorage()).toBe(false)
    expect(listener).toHaveBeenCalledOnce()

    writerB.update(mutator)
    expect(mutator).toHaveBeenCalledOnce()
    expect(writerB.getSnapshot()).toMatchObject({
      revision: exactA.revision + 1,
      sessionUserId: 'usr-demo-admin',
    })
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual(writerB.getSnapshot())
  })

  it('lets a stale authorized repository reset above storage and a current repository sync it', () => {
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))
    const current = new MockRepository(storage)
    const staleResetter = new MockRepository(storage)
    const currentListener = vi.fn()
    current.subscribe(currentListener)

    current.update((state) => {
      state.sessionUserId = 'usr-demo-customer'
      state.cart[0].quantity = 4
    })
    expect(current.getSnapshot().revision).toBe(2)
    expect(staleResetter.getSnapshot().revision).toBe(1)

    staleResetter.reset()

    expect(staleResetter.getSnapshot()).toMatchObject({
      revision: 3,
      sessionUserId: null,
      cart: [{ quantity: 1 }],
    })
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual(staleResetter.getSnapshot())

    expect(current.syncFromStorage()).toBe(true)
    expect(current.getSnapshot()).toEqual(staleResetter.getSnapshot())
    expect(currentListener).toHaveBeenCalledTimes(2)

    current.update((state) => {
      state.sessionUserId = 'usr-demo-admin'
    })
    expect(current.getSnapshot()).toMatchObject({
      revision: 4,
      sessionUserId: 'usr-demo-admin',
      cart: [{ quantity: 1 }],
    })
  })

  it('rejects older and invalid storage during sync without changing the published snapshot', () => {
    const storage = new MemoryStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))
    const repository = new MockRepository(storage)
    repository.update((state) => { state.sessionUserId = 'usr-demo-customer' })
    const published = repository.getSnapshot()
    const listener = vi.fn()
    repository.subscribe(listener)

    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))
    expect(() => repository.syncFromStorage()).toThrow(
      expect.objectContaining({ code: 'STATE_SYNC_REJECTED' }),
    )
    expect(repository.getSnapshot()).toBe(published)
    expect(listener).not.toHaveBeenCalled()

    storage.seed(STORAGE_KEY, '{invalid-json')
    expect(() => repository.syncFromStorage()).toThrow(
      expect.objectContaining({ code: 'STORED_STATE_INVALID' }),
    )
    expect(repository.getSnapshot()).toBe(published)
    expect(listener).not.toHaveBeenCalled()
  })

  it('publishes recursively frozen stable snapshots that cannot mutate state or storage', () => {
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))
    const repository = new MockRepository(storage)
    const snapshot = repository.getSnapshot()
    const storedBefore = storage.getItem(STORAGE_KEY)
    const revisionBefore = snapshot.revision
    const auditsBefore = structuredClone(snapshot.audits)

    expect(repository.getSnapshot()).toBe(snapshot)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.orders[0].snapshot.address)).toBe(true)
    expect(() => {
      snapshot.orders[0].snapshot.address.city = 'Changed outside repository'
    }).toThrow(TypeError)
    expect(() => {
      snapshot.audits.push(structuredClone(snapshot.audits[0]))
    }).toThrow(TypeError)

    expect(repository.getSnapshot()).toBe(snapshot)
    expect(repository.getSnapshot().orders[0].snapshot.address.city).toBe('Kuala Lumpur')
    expect(repository.getSnapshot().revision).toBe(revisionBefore)
    expect(repository.getSnapshot().audits).toEqual(auditsBefore)
    expect(storage.getItem(STORAGE_KEY)).toBe(storedBefore)
    expect(storage.writes).toBe(0)
  })

  it.each([
    ['edit', (state: DemoState) => {
      state.audits[0].reason = 'Edited old audit evidence'
    }],
    ['delete', (state: DemoState) => {
      state.audits.shift()
      state.auditCount = state.audits.length
      state.auditHeadId = state.audits.at(-1)!.id
    }],
    ['reorder', (state: DemoState) => {
      const first = state.audits[0]
      state.audits[0] = state.audits[1]
      state.audits[1] = first
    }],
    ['replace', (state: DemoState) => {
      state.audits[0] = {
        ...state.audits[0],
        requestId: 'replacement-request-id',
      }
    }],
    ['recount inconsistently', (state: DemoState) => {
      state.auditCount += 1
    }],
  ] as const)('rejects an audit-history %s atomically before publication', (_label, mutate) => {
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(stateWithTwoAudits()))
    const repository = new MockRepository(storage)
    const published = repository.getSnapshot()
    const storedBefore = storage.getItem(STORAGE_KEY)
    const listener = vi.fn()
    repository.subscribe(listener)

    expect(() => repository.update((state) => {
      state.cart = []
      mutate(state)
    })).toThrow(expect.objectContaining({ code: 'AUDIT_HISTORY_MUTATED' }))

    expect(repository.getSnapshot()).toBe(published)
    expect(repository.getSnapshot().revision).toBe(published.revision)
    expect(repository.getSnapshot().cart).toEqual(published.cart)
    expect(storage.getItem(STORAGE_KEY)).toBe(storedBefore)
    expect(storage.writes).toBe(0)
    expect(listener).not.toHaveBeenCalled()
  })

  it('persists updates and resets to deterministic fixtures', () => {
    const storage = new MemoryStorage()
    const repository = new MockRepository(storage)
    repository.update((state) => { state.cart = [] })
    expect(new MockRepository(storage).getSnapshot().cart).toHaveLength(0)
    repository.reset()
    expect(repository.getSnapshot().cart[0].quantity).toBe(1)
  })

  it('survives a throwing storage read and starts in visible memory-only mode', () => {
    const storage = new FaultStorage()
    storage.throwOnRead = true
    const repository = new MockRepository(storage)
    expect(repository.getSnapshot()).toEqual(createDemoState())
    expect(repository.recoveryNotice).toMatch(/could not be read.+memory only/i)
    const listener = vi.fn()
    repository.subscribe(listener)
    repository.update((state) => { state.sessionUserId = 'usr-demo-customer' })
    expect(repository.getSnapshot().sessionUserId).toBe('usr-demo-customer')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('survives a throwing initial write for missing data and keeps safe fixtures in memory', () => {
    const storage = new FaultStorage()
    storage.throwOnWrite = true
    const repository = new MockRepository(storage)
    expect(repository.getSnapshot()).toEqual(createDemoState())
    expect(repository.recoveryNotice).toMatch(/could not save it.+memory only/i)
    const listener = vi.fn()
    repository.subscribe(listener)
    repository.update((state) => { state.sessionUserId = 'usr-demo-customer' })
    expect(repository.getSnapshot().sessionUserId).toBe('usr-demo-customer')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('rolls back a failed update write and keeps storage active for a successful retry', () => {
    const storage = new FaultStorage()
    const repository = new MockRepository(storage)
    const before = repository.exportForTest()
    const storedBefore = storage.getItem(STORAGE_KEY)
    const listener = vi.fn()
    repository.subscribe(listener)
    storage.failNextWrites = 1

    let failure: unknown
    try {
      repository.update((state) => { state.sessionUserId = 'usr-demo-customer' })
    } catch (caught) {
      failure = caught
    }

    expect(failure).toMatchObject({
      name: 'DomainError',
      code: 'STORAGE_WRITE_FAILED',
      message: expect.stringMatching(/nothing changed.+try again/i),
    })
    expect(repository.getSnapshot()).toEqual(before)
    expect(repository.getSnapshot().revision).toBe(before.revision)
    expect(storage.getItem(STORAGE_KEY)).toBe(storedBefore)
    expect(listener).not.toHaveBeenCalled()
    expect(repository.recoveryNotice).not.toMatch(/continuing in memory/i)

    repository.update((state) => { state.sessionUserId = 'usr-demo-customer' })
    expect(repository.getSnapshot().sessionUserId).toBe('usr-demo-customer')
    expect(repository.getSnapshot().revision).toBe(before.revision + 1)
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual(repository.getSnapshot())
    expect(listener).toHaveBeenCalledOnce()
  })

  it('restores exact browser bytes when an update write mutates storage and then throws', () => {
    const storage = new MutateThenFailOnceStorage()
    const raw = JSON.stringify(createDemoState())
    storage.seed(STORAGE_KEY, raw)
    const repository = new MockRepository(storage)
    const published = repository.getSnapshot()
    const listener = vi.fn()
    repository.subscribe(listener)
    storage.failAfterNextWrite = true

    expect(() => repository.update((state) => {
      state.sessionUserId = 'usr-demo-customer'
    })).toThrow(expect.objectContaining({
      code: 'STORAGE_WRITE_FAILED',
      message: expect.stringMatching(/previous browser data was restored exactly.+nothing changed/i),
    }))

    expect(repository.getSnapshot()).toBe(published)
    expect(storage.getItem(STORAGE_KEY)).toBe(raw)
    expect(repository.hasWriteAuthority()).toBe(true)
    expect(listener).not.toHaveBeenCalled()

    repository.update((state) => {
      state.sessionUserId = 'usr-demo-customer'
    })
    expect(repository.getSnapshot()).toMatchObject({
      revision: published.revision + 1,
      sessionUserId: 'usr-demo-customer',
    })
  })

  it('leaves reservation expiry to the guarded action and keeps a failed action retryable', () => {
    const preparedStorage = new MemoryStorage()
    const prepared = new AppServices(preparedStorage, () => '2026-07-28T03:00:00.000Z')
    prepared.auth.oneClick('customer')
    prepared.orders.setCartQuantity(1)
    const dueOrder = prepared.orders.create({
      requestId: 'checkout_0000000000000000000000000000d001',
      quantity: 1,
      shippingMethod: 'standard',
      address: createDemoState().orders[0].snapshot.address,
      acknowledged: true,
      displayedTotalSen: 11_200,
    })
    const storedBefore = preparedStorage.getItem(STORAGE_KEY)!
    const stateBefore = JSON.parse(storedBefore) as DemoState
    const storage = new FaultStorage()
    storage.seed(STORAGE_KEY, storedBefore)
    storage.failNextWrites = 1

    const services = new AppServices(storage, () => FIXED_NOW)
    const listener = vi.fn()
    services.repository.subscribe(listener)

    expect(services.repository.getSnapshot()).toEqual(stateBefore)
    expect(services.repository.getSnapshot().revision).toBe(stateBefore.revision)
    expect(storage.getItem(STORAGE_KEY)).toBe(storedBefore)
    expect(storage.writeAttempts).toBe(0)
    expect(storage.successfulWrites).toBe(0)
    expect(listener).not.toHaveBeenCalled()
    expect(services.repository.recoveryNotice).toBeNull()
    expect(services.repository.getSnapshot().orders.find((order) => order.id === dueOrder.id)?.status)
      .toBe('pending_payment')

    expect(() => services.orders.expireReservations()).toThrow(
      expect.objectContaining({ code: 'STORAGE_WRITE_FAILED' }),
    )
    expect(services.repository.getSnapshot()).toEqual(stateBefore)
    expect(storage.getItem(STORAGE_KEY)).toBe(storedBefore)
    expect(storage.writeAttempts).toBe(1)
    expect(storage.successfulWrites).toBe(0)
    expect(listener).not.toHaveBeenCalled()

    const retried = services.orders.expireReservations()
    expect(retried).toMatchObject({ changed: true, count: 1, orderIds: [dueOrder.id] })
    expect(services.repository.getSnapshot().revision).toBe(stateBefore.revision + 1)
    expect(services.repository.getSnapshot().boxes.find((box) => box.orderId === dueOrder.id)?.status).toBe('void')
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual(services.repository.getSnapshot())
    expect(storage.writeAttempts).toBe(2)
    expect(storage.successfulWrites).toBe(1)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('defers invalid clocks and clock failures until a guarded action needs time', () => {
    const invalidClock = new AppServices(new MemoryStorage(), () => 'not-an-iso-time')
    expect(() => invalidClock.orders.expireReservations()).toThrow(
      expect.objectContaining({ code: 'INVALID_TIME' }),
    )
    const unexpected = new Error('unexpected clock failure')
    const throwingClock = new AppServices(new MemoryStorage(), () => { throw unexpected })
    expect(() => throwingClock.orders.expireReservations()).toThrow(unexpected)
  })

  it('rolls back a failed reset write and keeps storage active for a successful retry', () => {
    const storage = new FaultStorage()
    const repository = new MockRepository(storage)
    repository.update((state) => { state.cart = [] })
    const before = repository.exportForTest()
    const storedBefore = storage.getItem(STORAGE_KEY)
    const listener = vi.fn()
    repository.subscribe(listener)
    storage.failNextWrites = 1

    let failure: unknown
    try {
      repository.reset()
    } catch (caught) {
      failure = caught
    }

    expect(failure).toMatchObject({ code: 'STORAGE_WRITE_FAILED' })
    expect(repository.getSnapshot()).toEqual(before)
    expect(repository.getSnapshot().revision).toBe(before.revision)
    expect(storage.getItem(STORAGE_KEY)).toBe(storedBefore)
    expect(listener).not.toHaveBeenCalled()

    repository.reset()
    expect(repository.getSnapshot()).toEqual({
      ...createDemoState(),
      revision: before.revision + 1,
    })
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual(repository.getSnapshot())
    expect(listener).toHaveBeenCalledOnce()
  })

  it('restores exact browser bytes when a reset write mutates storage and then throws', () => {
    const storage = new MutateThenFailOnceStorage()
    const repository = new MockRepository(storage)
    repository.update((state) => {
      state.cart[0].quantity = 4
    })
    const published = repository.getSnapshot()
    const raw = storage.getItem(STORAGE_KEY)
    const listener = vi.fn()
    repository.subscribe(listener)
    storage.failAfterNextWrite = true

    expect(() => repository.reset()).toThrow(
      expect.objectContaining({ code: 'STORAGE_WRITE_FAILED' }),
    )

    expect(repository.getSnapshot()).toBe(published)
    expect(storage.getItem(STORAGE_KEY)).toBe(raw)
    expect(repository.hasWriteAuthority()).toBe(true)
    expect(listener).not.toHaveBeenCalled()

    repository.reset()
    expect(repository.getSnapshot()).toMatchObject({
      revision: published.revision + 1,
      cart: [{ quantity: 1 }],
    })
  })

  it('rolls back cyclic tampering with an old audit before touching storage or listeners', () => {
    const storage = new FaultStorage()
    const repository = new MockRepository(storage)
    const before = repository.exportForTest()
    const storedBefore = storage.getItem(STORAGE_KEY)
    const listener = vi.fn()
    repository.subscribe(listener)

    expect(() => repository.update((state) => {
      state.audits[0].after = state as never
    })).toThrow(expect.objectContaining({ code: 'AUDIT_HISTORY_MUTATED' }))

    expect(repository.getSnapshot()).toEqual(before)
    expect(storage.getItem(STORAGE_KEY)).toBe(storedBefore)
    expect(listener).not.toHaveBeenCalled()

    repository.update((state) => { state.sessionUserId = 'usr-demo-customer' })
    expect(repository.getSnapshot().revision).toBe(before.revision + 1)
    expect(listener).toHaveBeenCalledOnce()
  })

  it.each([
    ['non-canonical object keys', (state: DemoState) => {
      state.audits[0].after = JSON.parse('{"z":1,"a":2}')
    }],
    ['dangerous object keys', (state: DemoState) => {
      state.audits[0].after = JSON.parse('{"__proto__":"unsafe"}')
    }],
    ['oversized evidence', (state: DemoState) => {
      state.audits[0].after = 'x'.repeat(AUDIT_EVIDENCE_MAX_BYTES + 1)
    }],
  ] as const)('rejects persisted %s and uses an unsaved memory-only fixture', (_label, tamper) => {
    const state = createDemoState()
    tamper(state)
    expect(() => validateDemoState(state)).toThrow(/audit/i)

    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(state))
    const repository = new MockRepository(storage)

    expect(repository.getSnapshot()).toEqual(createDemoState())
    expect(repository.recoveryNotice).toMatch(
      /exact original browser bytes.+left unchanged.+memory only.+not saved.+explicit confirmed reset/i,
    )
    expect(storage.writes).toBe(0)
    expect(storage.getItem(STORAGE_KEY)).toBe(JSON.stringify(state))
  })

  it('updates and resets normally when storage was intentionally omitted', () => {
    const repository = new MockRepository()
    const listener = vi.fn()
    repository.subscribe(listener)

    repository.update((state) => { state.cart = [] })
    expect(repository.getSnapshot().cart).toEqual([])
    repository.reset()

    expect(repository.getSnapshot()).toEqual({
      ...createDemoState(),
      revision: 3,
    })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('keeps session state atomic when validation rejects a draft', () => {
    const storage = new FaultStorage()
    const repository = new MockRepository(storage)
    const before = repository.exportForTest()
    const listener = vi.fn()
    repository.subscribe(listener)

    expect(() => repository.update((state) => { state.sessionUserId = 'usr-missing' })).toThrow(/session user/i)
    expect(repository.getSnapshot()).toEqual(before)
    expect(listener).not.toHaveBeenCalled()
  })

  it('uses the deterministic tracking convention for shipped fixtures', () => {
    const repository = new MockRepository(new MemoryStorage())
    const shipment = repository.getSnapshot().shipments.find((entry) => entry.id === 'shp-shipped')
    expect(shipment?.trackingNumber).toBe('DEMO-P-SHIPPED')
  })

  it('keeps seeded paid boxes, timelines, shipments and order fulfilment coherent', () => {
    const state = createDemoState()
    expect(() => validateDemoState(state)).not.toThrow()
    expect(state.boxes.filter((box) => box.prizeId).every((box) => box.shipmentId)).toBe(true)
    expect(state.boxes.find((box) => box.id === 'box-failed-01')?.status).toBe('on_hold')
    expect(state.orders.find((order) => order.id === 'ord-shipped')?.status).toBe('processing')
    expect(state.shipments.every((shipment) => shipment.timeline.at(-1)?.status === shipment.status)).toBe(true)
  })

  it.each([
    ['missing audit collection contents', (state: DemoState) => {
      state.audits = []
      state.auditCount = 0
      state.auditHeadId = ''
    }],
    ['truncated audit collection', (state: DemoState) => {
      state.audits.pop()
    }],
    ['wrong audit count', (state: DemoState) => {
      state.auditCount += 1
    }],
    ['wrong audit head', (state: DemoState) => {
      state.auditHeadId = 'audit-not-the-head'
    }],
    ['noncontiguous audit sequence', (state: DemoState) => {
      state.audits[1].sequence += 1
    }],
    ['missing audit previous link', (state: DemoState) => {
      delete state.audits[1].previousId
    }],
    ['invalid audit outcome', (state: DemoState) => {
      state.audits[1].outcome = 'unknown' as never
    }],
    ['malformed normalized audit fields', (state: DemoState) => {
      const audit = state.audits[1]
      audit.actorId = ' actor '
      audit.action = ''
      audit.targetType = '<payment>'
      audit.targetId = 'target'.repeat(30)
      audit.reason = ' reason with extra space '
      audit.requestId = ''
      audit.eventId = '<event>'
    }],
  ] as const)('rejects %s and uses an unsaved memory-only fixture', (_label, mutate) => {
    const malformed = stateWithTwoAudits()
    mutate(malformed)
    expect(() => validateDemoState(malformed)).toThrow()

    const storage = new MemoryStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(malformed))
    const repository = new MockRepository(storage)
    expect(repository.recoveryNotice).toMatch(
      /exact original browser bytes.+left unchanged.+memory only.+not saved.+explicit confirmed reset/i,
    )
    expect(repository.getSnapshot()).toEqual(createDemoState())
  })

  it('rejects an order timeline whose creation row is not pending payment', () => {
    const state = createDemoState()
    state.orders.find((order) => order.id === 'ord-processing')!.timeline[0].status =
      'confirmed'

    expect(() => validateDemoState(state)).toThrow(/begin at pending payment/i)
  })

  it('rejects duplicate normalized user emails even when user IDs differ', () => {
    const state = createDemoState()
    state.users[1].email = state.users[0].email

    expect(() => validateDemoState(state)).toThrow(/user emails must be globally unique/i)
  })

  it.each([0, 1.5, MAX_CART_QUANTITY + 1])(
    'rejects persisted order quantity outside the integer 1 through maximum range: %s',
    (quantity) => {
      const state = createDemoState()
      state.orders[0].snapshot.quantity = quantity

      expect(() => validateDemoState(state)).toThrow(/order quantity is invalid/i)
    },
  )

  it('accepts a persisted order quantity exactly at the maximum', () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    services.orders.setCartQuantity(MAX_CART_QUANTITY)
    const order = services.orders.create({
      requestId: 'checkout_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      quantity: MAX_CART_QUANTITY,
      shippingMethod: 'standard',
      address: createDemoState().orders[0].snapshot.address,
      acknowledged: true,
      displayedTotalSen: MAX_CART_QUANTITY * BOX_PRICE_SEN + 1200,
    })

    expect(order.snapshot.quantity).toBe(MAX_CART_QUANTITY)
    expect(() => validateDemoState(services.repository.getSnapshot())).not.toThrow()
  })

  it('accepts a different positive historical value-floor snapshot', () => {
    const state = createDemoState()
    state.orders[0].snapshot.valueFloorSen = 12_500

    expect(() => validateDemoState(state)).not.toThrow()
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 12_500.5],
    ['unsafe and too large', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('rejects a %s order value-floor snapshot', (_label, valueFloorSen) => {
    const state = createDemoState()
    state.orders[0].snapshot.valueFloorSen = valueFloorSen

    expect(() => validateDemoState(state)).toThrow(
      /positive bounded safe integer-sen amount/i,
    )
  })

  it.each(['oddsVersion', 'policyVersion'] as const)(
    'rejects an order snapshot whose %s does not match its published series',
    (versionKey) => {
      const state = createDemoState()
      state.orders[0].snapshot[versionKey] = 'tampered-version'

      expect(() => validateDemoState(state)).toThrow(/snapshot versions must match its published series/i)
    },
  )

  it.each(['reserved', 'paid_unopened', 'void'] as const)(
    'rejects a revealed box that remains %s',
    (status) => {
      const state = createDemoState()
      const box = state.boxes.find((entry) => entry.id === 'box-unopened-01')!
      box.revealedAt = '2026-07-25T02:00:00.000Z'
      box.status = status

      expect(() => validateDemoState(state)).toThrow(/revealed box cannot remain/i)
    },
  )

  it('rejects opened status without a reveal time', () => {
    const state = createDemoState()
    state.boxes.find((entry) => entry.id === 'box-processing-01')!.revealedAt = undefined

    expect(() => validateDemoState(state)).toThrow(/opened box requires a reveal time/i)
  })

  it.each([
    ['box-shipped-01', 'fulfillment_pending'],
    ['box-delivered-01', 'fulfilled'],
    ['box-failed-01', 'on_hold'],
  ] as const)('preserves %s as a revealed box in its later valid %s state', (boxId, status) => {
    const state = createDemoState()
    expect(state.boxes.find((box) => box.id === boxId)).toMatchObject({
      status,
      revealedAt: expect.any(String),
    })
    expect(() => validateDemoState(state)).not.toThrow()
  })

  it('rejects a split order labelled processing after one shipment is delivered', () => {
    const state = createDemoState()
    const order = state.orders.find((entry) => entry.id === 'ord-processing')!
    const shipment = state.shipments.find((entry) => entry.id === 'shp-processing')!
    const box = state.boxes.find((entry) => entry.id === 'box-processing-01')!
    for (const [index, status] of ['packed', 'label_created', 'shipped', 'delivered'].entries()) {
      shipment.timeline.push({
        id: `split-status-${index}`,
        status: status as typeof shipment.status,
        label: `Split shipment ${status}`,
        at: `2026-07-22T0${index + 4}:00:00.000Z`,
      })
    }
    shipment.status = 'delivered'
    box.status = 'fulfilled'
    order.updatedAt = '2026-07-22T07:00:00.000Z'

    expect(() => validateDemoState(state)).toThrow(/status must be partially_fulfilled/i)
  })

  it('rejects an illegal accepted payment event jump', () => {
    const state = createDemoState()
    const payment = state.payments.find((entry) => entry.id === 'pay-unopened')!
    payment.events.push({
      id: 'evt-illegal-accepted-jump',
      requestId: 'req-illegal-accepted-jump',
      type: 'pending',
      source: 'admin_reconcile',
      createdAt: payment.updatedAt,
      processedAt: payment.updatedAt,
    })

    expect(() => validateDemoState(state)).toThrow(/illegal accepted succeeded to pending jump/i)
  })

  it('rejects a payment current status that disagrees with accepted history', () => {
    const state = createDemoState()
    state.payments.find((entry) => entry.id === 'pay-unopened')!.status = 'processing'

    expect(() => validateDemoState(state)).toThrow(/current status does not match/i)
  })

  it('rejects refund money that disagrees with a non-refund payment status', () => {
    const state = createDemoState()
    state.payments.find((entry) => entry.id === 'pay-unopened')!.refundedSen = 1000

    expect(() => validateDemoState(state)).toThrow(/refund intents|non-refund payment status.+zero/i)
  })

  it('rejects an active attempt beside a captured payment', () => {
    const state = createDemoState()
    const order = state.orders.find((entry) => entry.id === 'ord-unopened')!
    const createdAt = order.updatedAt
    const active: DemoState['payments'][number] = {
      id: 'pay-unopened-active',
      orderId: order.id,
      userId: order.userId,
      attempt: 2,
      method: 'FPX',
      status: 'pending',
      amountSen: order.snapshot.totals.totalSen,
      refundedSen: 0,
      createdAt,
      updatedAt: createdAt,
      events: [{
        id: 'evt-unopened-active-created',
        requestId: 'req-unopened-active-created',
        type: 'created',
        source: 'mock_webhook',
        createdAt,
        processedAt: createdAt,
      }],
    }
    state.payments.push(active)
    order.paymentIds.push(active.id)

    expect(() => validateDemoState(state)).toThrow(/active payment attempt cannot coexist/i)
  })

  it('rejects a normal fulfilment order whose captured payment overlay is disputed', () => {
    const state = createDemoState()
    const payment = state.payments.find((entry) => entry.id === 'pay-unopened')!
    payment.status = 'disputed'
    payment.events.push({
      id: 'evt-unopened-overlay-dispute',
      requestId: 'req-unopened-overlay-dispute',
      type: 'disputed',
      source: 'admin_reconcile',
      createdAt: payment.updatedAt,
      processedAt: payment.updatedAt,
    })

    expect(() => validateDemoState(state)).toThrow(/normal paid order needs one settled captured payment/i)
  })

  it.each([
    ['damage before physical delivery', () => {
      const state = servicesWithClaim('damage').repository.exportForTest()
      state.shipments.find((entry) => entry.id === 'shp-delivered')!.timeline.at(-1)!.at = '2026-07-29T07:00:00.000Z'
      return state
    }],
    ['damage for digital fulfilment', () => {
      const state = servicesWithClaim('damage').repository.exportForTest()
      state.shipments.find((entry) => entry.id === 'shp-delivered')!.kind = 'DIGITAL'
      return state
    }],
    ['non-delivery before shipped evidence', () => {
      const state = servicesWithClaim('non_delivery').repository.exportForTest()
      const claim = state.claims[0]
      claim.createdAt = '2026-07-20T05:30:00.000Z'
      claim.updatedAt = claim.createdAt
      claim.history[0].at = claim.createdAt
      return state
    }],
    ['shipped-only non-delivery before three demo days', () => {
      const state = servicesWithClaim('non_delivery').repository.exportForTest()
      const shipment = state.shipments.find((entry) => entry.id === 'shp-shipped')!
      shipment.createdAt = '2026-07-27T02:00:00.000Z'
      shipment.timeline.forEach((entry, index) => {
        entry.at = `2026-07-27T0${index + 2}:00:00.000Z`
      })
      return state
    }],
    ['value-floor claim before reveal', () => {
      const state = servicesWithClaim('value_floor').repository.exportForTest()
      state.boxes.find((entry) => entry.id === 'box-delivered-01')!.revealedAt = '2026-07-29T08:00:00.000Z'
      return state
    }],
    ['customer claim note without DEMO', () => {
      const state = servicesWithClaim('damage').repository.exportForTest()
      state.claims[0].note = 'Fictional damage without marker'
      state.claims[0].history[0].note = state.claims[0].note
      return state
    }],
    ['customer claim note with an email', () => {
      const state = servicesWithClaim('damage').repository.exportForTest()
      state.claims[0].note = 'DEMO contact person@example.test about damage'
      state.claims[0].history[0].note = state.claims[0].note
      return state
    }],
    ['customer claim note with a realistic phone', () => {
      const state = servicesWithClaim('damage').repository.exportForTest()
      state.claims[0].note = 'DEMO call +60 12-345 6789 about damage'
      state.claims[0].history[0].note = state.claims[0].note
      return state
    }],
  ] as const)('protects historically ineligible claim data bytes: %s', (_label, makeState) => {
    const storage = new MemoryStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(makeState()))
    const repository = new MockRepository(storage)
    expect(repository.recoveryNotice).toMatch(
      /exact original browser bytes.+left unchanged.+memory only.+not saved.+explicit confirmed reset/i,
    )
    expect(repository.getSnapshot()).toEqual(createDemoState())
  })

  it('keeps a valid damage claim after a later legitimate return', () => {
    let now = FIXED_NOW
    const services = servicesWithClaim('damage', () => now)
    now = '2026-07-29T04:00:00.000Z'
    services.auth.oneClick('admin')
    expect(() => services.fulfilment.advance(
      'shp-delivered',
      'returned',
      'DEMO later return after valid damage claim',
    )).not.toThrow()
    expect(() => validateDemoState(services.repository.getSnapshot())).not.toThrow()
  })

  it('keeps a valid non-delivery claim after a later legitimate delivery', () => {
    let now = FIXED_NOW
    const services = servicesWithClaim('non_delivery', () => now)
    now = '2026-07-29T04:00:00.000Z'
    services.auth.oneClick('admin')
    expect(() => services.fulfilment.advance(
      'shp-shipped',
      'delivered',
      'DEMO later delivery after valid non-delivery claim',
    )).not.toThrow()
    expect(() => validateDemoState(services.repository.getSnapshot())).not.toThrow()
  })

  it('accepts failed-delivery evidence that existed by claim creation', () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    services.claims.submit({
      orderId: 'ord-failed',
      kind: 'non_delivery',
      shipmentId: 'shp-failed',
      note: 'DEMO failed delivery evidence at claim time',
    })
    expect(() => validateDemoState(services.repository.getSnapshot())).not.toThrow()
  })

  it('accepts lost evidence that existed by claim creation', () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('admin')
    services.fulfilment.advance('shp-failed', 'lost', 'DEMO lost shipment evidence setup')
    services.auth.oneClick('customer')
    services.claims.submit({
      orderId: 'ord-failed',
      kind: 'non_delivery',
      shipmentId: 'shp-failed',
      note: 'DEMO lost shipment evidence at claim time',
    })
    expect(() => validateDemoState(services.repository.getSnapshot())).not.toThrow()
  })

  it('accepts a fresh reship when failed-delivery evidence already existed', () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('admin')
    services.fulfilment.advance('shp-failed', 'shipped', 'DEMO reship after failed delivery evidence')
    services.auth.oneClick('customer')
    expect(() => services.claims.submit({
      orderId: 'ord-failed',
      kind: 'non_delivery',
      shipmentId: 'shp-failed',
      note: 'DEMO failed delivery evidence before reship',
    })).not.toThrow()
    expect(() => validateDemoState(services.repository.getSnapshot())).not.toThrow()
  })

  it('does not use a later returned status as claim-time non-delivery evidence', () => {
    const state = servicesWithClaim('non_delivery').repository.exportForTest()
    const claim = state.claims[0]
    claim.createdAt = '2026-07-20T05:30:00.000Z'
    claim.updatedAt = claim.createdAt
    claim.history[0].at = claim.createdAt
    const shipment = state.shipments.find((entry) => entry.id === 'shp-shipped')!
    shipment.status = 'returned'
    shipment.timeline.push({
      id: 'shp-shipped-later-return',
      status: 'returned',
      label: 'Returned after the historical claim time',
      at: FIXED_NOW,
    })
    state.boxes.find((entry) => entry.id === 'box-shipped-01')!.status = 'on_hold'

    expect(() => validateDemoState(state)).toThrow(/non-delivery claim requires eligible evidence at claim creation/i)
  })

  it('rejects persisted non-delivery claims for a customer return after delivery', () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('admin')
    services.fulfilment.advance(
      'shp-delivered',
      'returned',
      'Confirmed post-delivery customer return persistence setup',
    )
    const state = services.repository.exportForTest()
    const order = state.orders.find((entry) => entry.id === 'ord-delivered')!
    const claim: DemoState['claims'][number] = {
      id: 'clm-post-delivery-return',
      requestId: 'req-clm-post-delivery-return',
      orderId: order.id,
      userId: order.userId,
      kind: 'non_delivery',
      note: 'DEMO post-delivery customer return is not non-delivery',
      shipmentId: 'shp-delivered',
      status: 'submitted',
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      history: [{
        id: 'clm-post-delivery-return-h-01',
        status: 'submitted',
        note: 'DEMO post-delivery customer return is not non-delivery',
        actorId: order.userId,
        actorRole: 'customer',
        at: FIXED_NOW,
      }],
    }
    state.claims.push(claim)
    order.claimIds.push(claim.id)

    expect(() => validateDemoState(state)).toThrow(
      /non-delivery claim requires eligible evidence at claim creation/i,
    )
  })

  it.each([
    ['no evidence scope', (claim: DemoState['claims'][number]) => {
      delete claim.shipmentCandidateIds
    }],
    ['an empty candidate set', (claim: DemoState['claims'][number]) => {
      claim.shipmentCandidateIds = []
    }],
    ['duplicate candidates', (claim: DemoState['claims'][number]) => {
      claim.shipmentCandidateIds = ['shp-digital', 'shp-digital']
    }],
    ['noncanonical candidate order', (claim: DemoState['claims'][number]) => {
      claim.shipmentCandidateIds = [...claim.shipmentCandidateIds!].reverse()
    }],
    ['an eligible-set subset', (claim: DemoState['claims'][number]) => {
      claim.shipmentCandidateIds = ['shp-digital']
    }],
    ['a candidate from another order', (claim: DemoState['claims'][number]) => {
      claim.shipmentCandidateIds = ['shp-delivered']
    }],
    ['both exact and order-level shipment links', (claim: DemoState['claims'][number]) => {
      claim.shipmentId = 'shp-digital'
    }],
    ['an exact shipment while a box was sealed', (claim: DemoState['claims'][number]) => {
      delete claim.shipmentCandidateIds
      claim.shipmentId = 'shp-processing'
    }],
  ] as const)('rejects order-level claim corruption with %s', (_label, mutate) => {
    const state = stateWithSealedMultiShipmentClaim()
    mutate(state.claims[0])
    expect(() => validateDemoState(state)).toThrow()
  })

  it.each([
    ['blank name', (state: DemoState) => {
      state.series.find((entry) => entry.status === 'draft')!.draftPrizes![0].name = '   '
    }],
    ['blank independent short name', (state: DemoState) => {
      state.series.find((entry) => entry.status === 'draft')!.draftPrizes![0].shortName = '\t'
    }],
    ['blank odds', (state: DemoState) => {
      state.series.find((entry) => entry.status === 'draft')!.draftPrizes![0].odds = ''
    }],
    ['odds drift from allocation truth', (state: DemoState) => {
      state.series.find((entry) => entry.status === 'draft')!.draftPrizes![0].odds = '1 in 4'
    }],
    ['invalid tier', (state: DemoState) => {
      state.series.find((entry) => entry.status === 'draft')!.draftPrizes![0].tier = 'Ultra' as never
    }],
    ['invalid allocation', (state: DemoState) => {
      state.series.find((entry) => entry.status === 'draft')!.draftPrizes![0].allocation = 0
    }],
    ['invalid insurance flag', (state: DemoState) => {
      state.series.find((entry) => entry.status === 'draft')!.draftPrizes![0].insured = 'yes' as never
    }],
  ] as const)('protects corrupted persisted draft prize bytes: %s', (_label, mutate) => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('admin')
    services.admin.copyPublishedToDraft()
    const malformed = services.repository.exportForTest()
    mutate(malformed)
    const storage = new MemoryStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(malformed))

    const repository = new MockRepository(storage)

    expect(repository.recoveryNotice).toMatch(
      /exact original browser bytes.+left unchanged.+memory only.+not saved.+explicit confirmed reset/i,
    )
    expect(repository.getSnapshot()).toEqual(createDemoState())
  })

  it('protects persisted published odds that drift from allocation truth', () => {
    const malformed = createDemoState()
    malformed.series[0].publishedPrizes!
      .find((prize) => prize.id === 'iphone17')!.odds = '1 in 3,333'
    const storage = new MemoryStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(malformed))

    const repository = new MockRepository(storage)

    expect(repository.recoveryNotice).toMatch(
      /exact original browser bytes.+left unchanged.+memory only.+not saved.+explicit confirmed reset/i,
    )
    expect(repository.getSnapshot().series[0].publishedPrizes!
      .find((prize) => prize.id === 'iphone17')?.odds).toBe('3 in 10,000')
  })

  it.each([
    ['missing evidence key', (state: DemoState) => {
      delete state.claims[0].shipmentCandidateEvidenceAt!['shp-digital']
    }],
    ['evidence before claim creation', (state: DemoState) => {
      state.claims[0].shipmentCandidateEvidenceAt!['shp-digital'] =
        '2026-07-28T05:00:00.000Z'
    }],
    ['missing widening audit', (state: DemoState) => {
      state.audits = state.audits.filter((audit) =>
        audit.action !== 'claim.order_level_evidence_widened')
    }],
    ['all candidate evidence moved after creation', (state: DemoState) => {
      state.claims[0].shipmentCandidateEvidenceAt!['shp-processing'] =
        '2026-07-28T08:00:00.000Z'
      const wideningAudit = state.audits.find((audit) =>
        audit.action === 'claim.order_level_evidence_widened')!
      wideningAudit.before = { shipmentCandidateIds: [] }
    }],
    ['missing widening history', (state: DemoState) => {
      state.claims[0].history = state.claims[0].history.filter((entry) =>
        entry.note !== CLAIM_EVIDENCE_WIDENING_NOTE)
    }],
    ['altered widening history', (state: DemoState) => {
      state.claims[0].history.find((entry) =>
        entry.note === CLAIM_EVIDENCE_WIDENING_NOTE)!.note =
          'Altered neutral evidence history'
    }],
    ['candidate not included by canonical evidence snapshots', (state: DemoState) => {
      state.claims[0].shipmentCandidateIds!.push('shp-shipped')
      state.claims[0].shipmentCandidateIds!.sort((left, right) => left.localeCompare(right))
      state.claims[0].shipmentCandidateEvidenceAt!['shp-shipped'] =
        '2026-07-28T08:00:00.000Z'
    }],
  ] as const)('rejects widened order-level claim corruption with %s', (_label, mutate) => {
    const state = stateWithWidenedSealedClaim()
    mutate(state)
    expect(() => validateDemoState(state)).toThrow()
  })

  it('rejects mapped evidence widened after a claim was approved', () => {
    const state = stateWithWidenedSealedClaim()
    const claim = state.claims[0]
    claim.history = claim.history.filter((entry) =>
      entry.note !== CLAIM_EVIDENCE_WIDENING_NOTE)
    state.audits = state.audits.filter((audit) =>
      audit.action !== 'claim.order_level_evidence_widened')
    state.audits.forEach((audit, index) => {
      audit.sequence = index + 1
      audit.previousId = index === 0 ? undefined : state.audits[index - 1].id
    })
    state.auditCount = state.audits.length
    state.auditHeadId = state.audits.at(-1)!.id
    claim.shipmentCandidateEvidenceAt!['shp-digital'] =
      '2026-07-28T11:00:00.000Z'
    claim.status = 'approved'
    claim.updatedAt = '2026-07-28T11:00:00.000Z'
    claim.history.push(
      {
        id: `${claim.id}-h-reviewing-corrupt`,
        status: 'reviewing',
        note: 'Confirmed fictional review before approval.',
        actorId: 'usr-demo-admin',
        actorRole: 'super_admin',
        at: '2026-07-28T09:00:00.000Z',
      },
      {
        id: `${claim.id}-h-approved-corrupt`,
        status: 'approved',
        note: 'Confirmed fictional approval freezing evidence.',
        actorId: 'usr-demo-admin',
        actorRole: 'super_admin',
        at: '2026-07-28T10:00:00.000Z',
      },
      {
        id: `${claim.id}-h-widened-after-approval-corrupt`,
        status: 'approved',
        note: CLAIM_EVIDENCE_WIDENING_NOTE,
        actorId: claim.userId,
        actorRole: 'customer',
        at: '2026-07-28T11:00:00.000Z',
      },
    )
    state.audits.push({
      id: 'audit-approved-evidence-freeze-corrupt',
      sequence: state.auditCount + 1,
      previousId: state.auditHeadId,
      outcome: 'applied',
      actorId: claim.userId,
      actorRole: 'customer',
      action: 'claim.order_level_evidence_widened',
      targetType: 'claim',
      targetId: claim.id,
      reason: CLAIM_EVIDENCE_WIDENING_NOTE,
      at: '2026-07-28T11:00:00.000Z',
      requestId: 'req-approved-evidence-freeze-corrupt',
      before: { shipmentCandidateIds: ['shp-processing'] },
      after: canonicalizeAuditEvidence({
        refundCreated: false,
        shipmentCandidateEvidenceAt: claim.shipmentCandidateEvidenceAt!,
        shipmentCandidateIds: ['shp-digital', 'shp-processing'],
      }, 'Test audit after evidence'),
    })
    state.auditCount += 1
    state.auditHeadId = 'audit-approved-evidence-freeze-corrupt'

    expect(() => validateDemoState(state)).toThrow(/unchanged-status customer history/i)
  })

  const malformedCases: Array<[string, (state: DemoState) => void]> = [
    ['missing cart', (state) => { delete (state as Partial<DemoState>).cart }],
    ['missing claims', (state) => { delete (state as Partial<DemoState>).claims }],
    ['non-integer revision', (state) => { state.revision = 1.5 }],
    ['invalid sequence counter', (state) => { state.nextSequence = 0 }],
    ['duplicate user ID', (state) => { state.users[1].id = state.users[0].id }],
    ['real user email', (state) => { state.users[0].email = 'person@gmail.com' }],
    ['non-fictional user name', (state) => { state.users[0].name = 'Aina Person' }],
    ['unsafe user name', (state) => { state.users[0].name = '<script>Demo</script>' }],
    ['invalid checkout request identity', (state) => { state.orders[0].checkoutRequestId = 'unsafe' }],
    ['duplicate checkout request identity', (state) => { state.orders[1].checkoutRequestId = state.orders[0].checkoutRequestId }],
    ['unknown session user', (state) => { state.sessionUserId = 'usr-missing' }],
    ['negative assigned count', (state) => { state.series[0].inventory[0].assigned = -1 }],
    ['negative reserved count', (state) => { state.series[0].reservedBoxes = -1 }],
    ['wrong allocation total', (state) => { state.series[0].allocationTotal -= 1 }],
    ['published allocation other than exactly 10,000', (state) => {
      state.series[0].allocationTotal += 1
      state.series[0].publishedPrizes![0].allocation += 1
    }],
    ['invalid order status', (state) => {
      state.orders[0].status = 'mystery' as never
      state.orders[0].timeline.at(-1)!.status = 'mystery' as never
    }],
    ['invalid payment status', (state) => { state.payments[0].status = 'mystery' as never }],
    ['invalid box status', (state) => { state.boxes[0].status = 'mystery' as never }],
    ['missing order snapshot', (state) => { delete (state.orders[0] as Partial<DemoState['orders'][number]>).snapshot }],
    ['missing order totals', (state) => { delete (state.orders[0].snapshot as Partial<DemoState['orders'][number]['snapshot']>).totals }],
    ['missing order address', (state) => { delete (state.orders[0].snapshot as Partial<DemoState['orders'][number]['snapshot']>).address }],
    ['missing order value-floor snapshot', (state) => {
      delete (state.orders[0].snapshot as Partial<DemoState['orders'][number]['snapshot']>)
        .valueFloorSen
    }],
    ['zero order value-floor snapshot', (state) => {
      state.orders[0].snapshot.valueFloorSen = 0
    }],
    ['fractional order value-floor snapshot', (state) => {
      state.orders[0].snapshot.valueFloorSen = VALUE_FLOOR_SEN + 0.5
    }],
    ['published prize odds drift', (state) => {
      state.series[0].publishedPrizes![0].odds = '1 in 4'
    }],
    ['non-fictional order address', (state) => { state.orders[0].snapshot.address.line1 = '12 Real Street' }],
    ['non-fictional order phone', (state) => { state.orders[0].snapshot.address.phone = '010-123-4567' }],
    ['unnormalized order address', (state) => { state.orders[0].snapshot.address.city = '  Kuala Lumpur  ' }],
    ['invalid order acknowledgement', (state) => { state.orders[0].snapshot.acknowledgement = 'Accepted' }],
    ['invalid shipping method', (state) => { state.orders[0].snapshot.shippingMethod = 'teleport' as never }],
    ['invalid payment method', (state) => { state.payments[0].method = 'CASH' as never }],
    ['duplicate manifest ID', (state) => { state.boxes[1].manifestId = state.boxes[0].manifestId }],
    ['capture event with uncaptured status', (state) => { state.payments[0].status = 'failed' }],
    ['captured status without accepted capture', (state) => { state.payments[0].events[0].ignoredReason = 'rejected test event' }],
    ['empty payment event ignored reason', (state) => { state.payments[0].events[0].ignoredReason = '' }],
    ['numeric payment event ignored reason', (state) => {
      const payment = state.payments[0]
      payment.events.push({
        id: 'evt-corrupt-numeric-ignored-reason',
        requestId: 'req-corrupt-numeric-ignored-reason',
        type: 'pending',
        source: 'admin_reconcile',
        createdAt: payment.updatedAt,
        processedAt: payment.updatedAt,
        ignoredReason: 1 as unknown as string,
      })
    }],
    ['object payment event ignored reason', (state) => {
      const payment = state.payments[0]
      payment.events.push({
        id: 'evt-corrupt-object-ignored-reason',
        requestId: 'req-corrupt-object-ignored-reason',
        type: 'pending',
        source: 'admin_reconcile',
        createdAt: payment.updatedAt,
        processedAt: payment.updatedAt,
        ignoredReason: { reason: 'ignored' } as unknown as string,
      })
    }],
    ['refund intent with wrong payment', (state) => {
      state.payments.find((payment) => payment.id === 'pay-refunded')!
        .events.find((event) => event.type === 'refunded')!
        .refundIntent!.paymentId = 'pay-unopened'
    }],
    ['refund amount unexplained by intent', (state) => {
      state.payments.find((payment) => payment.id === 'pay-refunded')!
        .events.find((event) => event.type === 'refunded')!
        .refundIntent!.amountSen -= 1
    }],
    ['coherent lower unit price, subtotal, total, and linked payment amount', (state) => {
      const order = state.orders.find((entry) => entry.id === 'ord-unopened')!
      const payment = state.payments.find((entry) => entry.id === 'pay-unopened')!
      order.snapshot.unitPriceSen = 9000
      order.snapshot.totals.itemSubtotalSen = 9000 * order.snapshot.quantity
      order.snapshot.totals.totalSen =
        order.snapshot.totals.itemSubtotalSen + order.snapshot.totals.shippingSen
      payment.amountSen = order.snapshot.totals.totalSen
    }],
    ['altered shipping, total, and linked payment amount', (state) => {
      const order = state.orders.find((entry) => entry.id === 'ord-unopened')!
      const payment = state.payments.find((entry) => entry.id === 'pay-unopened')!
      order.snapshot.totals.shippingSen = 100
      order.snapshot.totals.totalSen =
        order.snapshot.totals.itemSubtotalSen + order.snapshot.totals.shippingSen
      payment.amountSen = order.snapshot.totals.totalSen
    }],
    ['wrong calculated subtotal', (state) => { state.orders[0].snapshot.totals.itemSubtotalSen += 100 }],
    ['broken order user reference', (state) => { state.orders[0].userId = 'usr-missing' }],
    ['broken shipment reference', (state) => { state.boxes[0].shipmentId = 'shp-missing' }],
    ['shipment kind mismatched with its linked prize', (state) => {
      state.shipments.find((entry) => entry.id === 'shp-unopened')!.kind = 'BULKY'
    }],
    ['shipment kind mismatched with a coherent self-collect order edit', (state) => {
      const order = state.orders.find((entry) => entry.id === 'ord-unopened')!
      const payment = state.payments.find((entry) => entry.id === 'pay-unopened')!
      order.snapshot.shippingMethod = 'self_collect'
      order.snapshot.totals.shippingSen = 0
      order.snapshot.totals.totalSen = order.snapshot.totals.itemSubtotalSen
      payment.amountSen = order.snapshot.totals.totalSen
    }],
    ['shipment insurance below linked prize requirements', (state) => {
      state.shipments.find((entry) => entry.id === 'shp-shipped')!.insured = false
    }],
    ['shipment signature below linked prize requirements', (state) => {
      state.shipments.find((entry) => entry.id === 'shp-shipped')!.signatureRequired = false
    }],
    ['shipment carrier that is not clearly fictional', (state) => {
      state.shipments.find((entry) => entry.id === 'shp-unopened')!.carrier = 'DHL'
    }],
    ['shipment tracking without a DEMO code', (state) => {
      state.shipments.find((entry) => entry.id === 'shp-unopened')!.trackingNumber = 'REAL-TRACKING-001'
    }],
    ['invalid cart quantity', (state) => { state.cart[0].quantity = -1 }],
    ['altered fixed cart price', (state) => { state.cart[0].unitPriceSen -= 100 }],
    ['order updated before creation', (state) => { state.orders[0].updatedAt = '2026-07-24T23:59:00.000Z' }],
    ['order timeline out of sequence', (state) => { state.orders[0].timeline[1].at = '2026-07-24T23:59:00.000Z' }],
    ['payment event before payment creation', (state) => {
      state.payments[0].events[0].createdAt = '2026-07-24T23:59:00.000Z'
      state.payments[0].events[0].processedAt = '2026-07-24T23:59:00.000Z'
    }],
    ['box allocation before capture', (state) => { state.boxes[0].assignedAt = '2026-07-25T00:30:00.000Z' }],
    ['box reveal before assignment', (state) => { state.boxes.find((box) => box.id === 'box-delivered-01')!.revealedAt = '2026-07-18T00:30:00.000Z' }],
    ['shipment before paid allocation', (state) => {
      const shipment = state.shipments.find((entry) => entry.id === 'shp-unopened')!
      shipment.createdAt = '2026-07-25T00:30:00.000Z'
      shipment.timeline[0].at = shipment.createdAt
    }],
    ['shipment timeline out of sequence', (state) => {
      const shipment = state.shipments.find((entry) => entry.id === 'shp-shipped')!
      shipment.timeline.at(-1)!.at = '2026-07-20T02:30:00.000Z'
    }],
    ['claim history out of sequence', (state) => {
      const order = state.orders.find((entry) => entry.id === 'ord-delivered')!
      const claim: DemoState['claims'][number] = {
        id: 'clm-history-corrupt',
        requestId: 'req-clm-history-corrupt',
        orderId: order.id,
        userId: order.userId,
        kind: 'damage',
        note: 'DEMO chronology claim',
        shipmentId: 'shp-delivered',
        status: 'reviewing',
        createdAt: '2026-07-28T01:00:00.000Z',
        updatedAt: '2026-07-28T02:00:00.000Z',
        history: [
          {
            id: 'clm-history-corrupt-1',
            status: 'submitted',
            note: 'DEMO chronology claim',
            actorId: order.userId,
            actorRole: 'customer',
            at: '2026-07-28T01:00:00.000Z',
          },
          {
            id: 'clm-history-corrupt-2',
            status: 'reviewing',
            note: 'Reviewed before submission',
            actorId: 'usr-support',
            actorRole: 'support',
            at: '2026-07-28T00:30:00.000Z',
          },
        ],
      }
      state.claims.push(claim)
      order.claimIds.push(claim.id)
    }],
    ['invalid claim kind', (state) => {
      const order = state.orders.find((entry) => entry.id === 'ord-delivered')!
      const claim = {
        id: 'clm-corrupt',
        requestId: 'req-clm-corrupt',
        orderId: order.id,
        userId: order.userId,
        kind: 'mystery',
        note: 'Corrupt claim fixture',
        shipmentId: 'shp-delivered',
        status: 'submitted',
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:00.000Z',
        history: [{
          id: 'clm-corrupt-h-01',
          status: 'submitted',
          note: 'Corrupt claim fixture',
          actorId: order.userId,
          actorRole: 'customer',
          at: '2026-07-28T00:00:00.000Z',
        }],
      } as unknown as DemoState['claims'][number]
      state.claims.push(claim)
      order.claimIds.push(claim.id)
    }],
  ]

  it.each(malformedCases)('protects current-schema corruption bytes: %s', (_label, mutate) => {
    const storage = new MemoryStorage()
    const malformed = createDemoState()
    mutate(malformed)
    storage.seed(STORAGE_KEY, JSON.stringify(malformed))
    const repository = new MockRepository(storage)
    expect(repository.recoveryNotice).toMatch(
      /exact original browser bytes.+left unchanged.+memory only.+not saved.+explicit confirmed reset/i,
    )
    expect(repository.getSnapshot()).toEqual(createDemoState())
  })

  it.each([
    ['missing resolution outcome', (claim: DemoState['claims'][number]) => {
      claim.resolutionOutcome = undefined
    }],
    ['invalid resolution outcome', (claim: DemoState['claims'][number]) => {
      claim.resolutionOutcome = 'cash_sent' as never
    }],
    ['non-fictional resolution reference', (claim: DemoState['claims'][number]) => {
      claim.resolutionReference = 'REAL-REPLACEMENT-001'
    }],
    ['short non-refund resolution note', (claim: DemoState['claims'][number]) => {
      claim.resolutionNote = 'Too short'
    }],
    ['unverified refund resolution reference', (claim: DemoState['claims'][number]) => {
      claim.resolutionOutcome = 'refund_recorded'
      claim.resolutionReference = 'evt-ord-refunded-refund'
    }],
  ] as const)('protects current-schema claim resolution corruption bytes: %s', (_label, mutate) => {
    const services = servicesWithClaim('damage')
    const claim = services.repository.getSnapshot().claims[0]
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Confirmed resolution corruption acknowledgement')
    services.claims.review(claim.id, 'approve', 'Confirmed resolution corruption approval')
    services.claims.review(
      claim.id,
      'resolve',
      'Confirmed sufficiently descriptive fictional replacement resolution',
      { outcome: 'replacement_authorized', reference: `DEMO-${claim.id.toUpperCase()}` },
    )
    const malformed = services.repository.exportForTest()
    mutate(malformed.claims[0])
    const storage = new MemoryStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(malformed))
    const repository = new MockRepository(storage)
    expect(repository.recoveryNotice).toMatch(
      /exact original browser bytes.+left unchanged.+memory only.+not saved.+explicit confirmed reset/i,
    )
    expect(repository.getSnapshot()).toEqual(createDemoState())
  })
})
