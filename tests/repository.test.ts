import { describe, expect, it, vi } from 'vitest'
import { MockRepository, STORAGE_KEY } from '../src/data/MockRepository'
import { createDemoState } from '../src/data/fixtures'
import { validateDemoState } from '../src/data/StateValidator'
import type { DemoState } from '../src/domain/types'
import { AppServices } from '../src/services/AppServices'
import { CountingStorage, FIXED_NOW, MemoryStorage } from './helpers'

class FaultStorage extends MemoryStorage {
  throwOnRead = false
  throwOnWrite = false
  failNextWrites = 0

  getItem(key: string) {
    if (this.throwOnRead) throw new Error('read blocked')
    return super.getItem(key)
  }

  setItem(key: string, value: string) {
    if (this.throwOnWrite || this.failNextWrites > 0) {
      this.failNextWrites = Math.max(0, this.failNextWrites - 1)
      throw new Error('write blocked')
    }
    super.setItem(key, value)
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

describe('MockRepository recovery and persistence', () => {
  it('recovers missing data with current schema fixtures', () => {
    const storage = new MemoryStorage()
    const repository = new MockRepository(storage)
    expect(repository.getSnapshot().schemaVersion).toBe(5)
    expect(repository.recoveryNotice).toMatch(/missing/i)
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).schemaVersion).toBe(5)
  })

  it('recovers corrupt data without throwing', () => {
    const storage = new MemoryStorage()
    storage.seed(STORAGE_KEY, '{not-json')
    const repository = new MockRepository(storage)
    expect(repository.getSnapshot().orders.length).toBeGreaterThan(0)
    expect(repository.recoveryNotice).toMatch(/recovered/i)
  })

  it('recovers an older schema version', () => {
    const storage = new MemoryStorage()
    storage.seed(STORAGE_KEY, JSON.stringify({ schemaVersion: 2, users: [] }))
    const repository = new MockRepository(storage)
    expect(repository.getSnapshot().schemaVersion).toBe(5)
    expect(repository.recoveryNotice).toMatch(/current safe version/i)
  })

  it('does not rewrite an already-valid loaded snapshot', () => {
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))

    const repository = new MockRepository(storage)

    expect(repository.getSnapshot()).toEqual(createDemoState())
    expect(storage.writes).toBe(0)
    expect(repository.recoveryNotice).toBeNull()
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

  it.each([
    ['missing', undefined],
    ['corrupt', '{not-json'],
  ])('survives a throwing initial write for %s data and keeps safe fixtures in memory', (_label, seeded) => {
    const storage = new FaultStorage()
    if (seeded) storage.seed(STORAGE_KEY, seeded)
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
    expect(repository.getSnapshot()).toEqual(createDemoState())
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual(createDemoState())
    expect(listener).toHaveBeenCalledOnce()
  })

  it('rolls back serialization failure before touching storage or listeners', () => {
    const storage = new FaultStorage()
    const repository = new MockRepository(storage)
    const before = repository.exportForTest()
    const storedBefore = storage.getItem(STORAGE_KEY)
    const listener = vi.fn()
    repository.subscribe(listener)

    expect(() => repository.update((state) => {
      state.audits[0].after = state
    })).toThrow(expect.objectContaining({ code: 'STORAGE_WRITE_FAILED' }))

    expect(repository.getSnapshot()).toEqual(before)
    expect(storage.getItem(STORAGE_KEY)).toBe(storedBefore)
    expect(listener).not.toHaveBeenCalled()

    repository.update((state) => { state.sessionUserId = 'usr-demo-customer' })
    expect(repository.getSnapshot().revision).toBe(before.revision + 1)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('updates and resets normally when storage was intentionally omitted', () => {
    const repository = new MockRepository()
    const listener = vi.fn()
    repository.subscribe(listener)

    repository.update((state) => { state.cart = [] })
    expect(repository.getSnapshot().cart).toEqual([])
    repository.reset()

    expect(repository.getSnapshot()).toEqual(createDemoState())
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

    expect(() => validateDemoState(state)).toThrow(/non-refund payment status.+zero/i)
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
    ['shipment claim before every order box reveal', () => {
      const state = servicesWithClaim('non_delivery').repository.exportForTest()
      const order = state.orders.find((entry) => entry.id === 'ord-shipped')!
      const shipment = state.shipments.find((entry) => entry.id === 'shp-shipped')!
      order.snapshot.quantity = 2
      order.snapshot.totals.itemSubtotalSen = 20_000
      order.snapshot.totals.totalSen = 21_200
      order.boxIds.push('box-shipped-02')
      state.payments.find((entry) => entry.id === 'pay-shipped')!.amountSen = 21_200
      shipment.boxIds.push('box-shipped-02')
      state.boxes.push({
        id: 'box-shipped-02',
        manifestId: 'TBBC-001-SHIPPED02',
        orderId: order.id,
        ownerId: order.userId,
        seriesId: order.snapshot.seriesId,
        number: 2,
        status: 'fulfillment_pending',
        prizeId: 'tng',
        assignedAt: '2026-07-20T01:00:00.000Z',
        shipmentId: shipment.id,
      })
      state.series[0].inventory.find((entry) => entry.prizeId === 'tng')!.assigned += 1
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
  ] as const)('recovers historically ineligible claim data: %s', (_label, makeState) => {
    const storage = new MemoryStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(makeState()))
    const repository = new MockRepository(storage)
    expect(repository.recoveryNotice).toMatch(/replaced/i)
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

  const malformedCases: Array<[string, (state: DemoState) => void]> = [
    ['missing cart', (state) => { delete (state as Partial<DemoState>).cart }],
    ['missing claims', (state) => { delete (state as Partial<DemoState>).claims }],
    ['non-integer revision', (state) => { state.revision = 1.5 }],
    ['invalid sequence counter', (state) => { state.nextSequence = 0 }],
    ['duplicate user ID', (state) => { state.users[1].id = state.users[0].id }],
    ['invalid checkout request identity', (state) => { state.orders[0].checkoutRequestId = 'unsafe' }],
    ['duplicate checkout request identity', (state) => { state.orders[1].checkoutRequestId = state.orders[0].checkoutRequestId }],
    ['unknown session user', (state) => { state.sessionUserId = 'usr-missing' }],
    ['negative assigned count', (state) => { state.series[0].inventory[0].assigned = -1 }],
    ['negative reserved count', (state) => { state.series[0].reservedBoxes = -1 }],
    ['wrong allocation total', (state) => { state.series[0].allocationTotal -= 1 }],
    ['invalid order status', (state) => {
      state.orders[0].status = 'mystery' as never
      state.orders[0].timeline.at(-1)!.status = 'mystery' as never
    }],
    ['invalid payment status', (state) => { state.payments[0].status = 'mystery' as never }],
    ['invalid box status', (state) => { state.boxes[0].status = 'mystery' as never }],
    ['missing order snapshot', (state) => { delete (state.orders[0] as Partial<DemoState['orders'][number]>).snapshot }],
    ['missing order totals', (state) => { delete (state.orders[0].snapshot as Partial<DemoState['orders'][number]['snapshot']>).totals }],
    ['missing order address', (state) => { delete (state.orders[0].snapshot as Partial<DemoState['orders'][number]['snapshot']>).address }],
    ['non-fictional order address', (state) => { state.orders[0].snapshot.address.line1 = '12 Real Street' }],
    ['non-fictional order phone', (state) => { state.orders[0].snapshot.address.phone = '010-123-4567' }],
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
    ['wrong calculated subtotal', (state) => { state.orders[0].snapshot.totals.itemSubtotalSen += 100 }],
    ['broken order user reference', (state) => { state.orders[0].userId = 'usr-missing' }],
    ['broken shipment reference', (state) => { state.boxes[0].shipmentId = 'shp-missing' }],
    ['invalid cart quantity', (state) => { state.cart[0].quantity = -1 }],
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

  it.each(malformedCases)('recovers current-schema corruption: %s', (_label, mutate) => {
    const storage = new MemoryStorage()
    const malformed = createDemoState()
    mutate(malformed)
    storage.seed(STORAGE_KEY, JSON.stringify(malformed))
    const repository = new MockRepository(storage)
    expect(repository.recoveryNotice).toMatch(/replaced/i)
    expect(repository.getSnapshot()).toEqual(createDemoState())
  })
})
