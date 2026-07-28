import { describe, expect, it, vi } from 'vitest'
import { MockRepository, STORAGE_KEY } from '../src/data/MockRepository'
import { createDemoState } from '../src/data/fixtures'
import { validateDemoState } from '../src/data/StateValidator'
import { CLAIM_EVIDENCE_WIDENING_NOTE } from '../src/domain/claimStatus'
import { BOX_PRICE_SEN, MAX_CART_QUANTITY } from '../src/domain/constants'
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

  it('keeps failed startup reservation cleanup atomic, visible, and retryable on the same storage', () => {
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
    expect(storage.writeAttempts).toBe(1)
    expect(storage.successfulWrites).toBe(0)
    expect(listener).not.toHaveBeenCalled()
    expect(services.repository.recoveryNotice).toMatch(
      /automatic cleanup was not saved.+nothing changed.+safe to retry or refresh/i,
    )

    const retried = services.orders.expireReservations()
    expect(retried).toMatchObject({ changed: true, count: 1, orderIds: [dueOrder.id] })
    expect(services.repository.getSnapshot().revision).toBe(stateBefore.revision + 1)
    expect(services.repository.getSnapshot().boxes.find((box) => box.orderId === dueOrder.id)?.status).toBe('void')
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual(services.repository.getSnapshot())
    expect(storage.writeAttempts).toBe(2)
    expect(storage.successfulWrites).toBe(1)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('rethrows invalid clocks and unexpected startup failures', () => {
    expect(() => new AppServices(new MemoryStorage(), () => 'not-an-iso-time')).toThrow(
      expect.objectContaining({ code: 'INVALID_TIME' }),
    )
    const unexpected = new Error('unexpected clock failure')
    expect(() => new AppServices(new MemoryStorage(), () => { throw unexpected })).toThrow(unexpected)
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
    ['invalid tier', (state: DemoState) => {
      state.series.find((entry) => entry.status === 'draft')!.draftPrizes![0].tier = 'Ultra' as never
    }],
    ['invalid allocation', (state: DemoState) => {
      state.series.find((entry) => entry.status === 'draft')!.draftPrizes![0].allocation = 0
    }],
    ['invalid insurance flag', (state: DemoState) => {
      state.series.find((entry) => entry.status === 'draft')!.draftPrizes![0].insured = 'yes' as never
    }],
  ] as const)('recovers corrupted persisted draft prize definition: %s', (_label, mutate) => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('admin')
    services.admin.copyPublishedToDraft()
    const malformed = services.repository.exportForTest()
    mutate(malformed)
    const storage = new MemoryStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(malformed))

    const repository = new MockRepository(storage)

    expect(repository.recoveryNotice).toMatch(/replaced/i)
    expect(repository.getSnapshot()).toEqual(createDemoState())
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
      actorId: claim.userId,
      actorRole: 'customer',
      action: 'claim.order_level_evidence_widened',
      targetType: 'claim',
      targetId: claim.id,
      reason: CLAIM_EVIDENCE_WIDENING_NOTE,
      at: '2026-07-28T11:00:00.000Z',
      requestId: 'req-approved-evidence-freeze-corrupt',
      before: { shipmentCandidateIds: ['shp-processing'] },
      after: {
        shipmentCandidateIds: ['shp-digital', 'shp-processing'],
        shipmentCandidateEvidenceAt: claim.shipmentCandidateEvidenceAt,
        refundCreated: false,
      },
    })

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

  it.each(malformedCases)('recovers current-schema corruption: %s', (_label, mutate) => {
    const storage = new MemoryStorage()
    const malformed = createDemoState()
    mutate(malformed)
    storage.seed(STORAGE_KEY, JSON.stringify(malformed))
    const repository = new MockRepository(storage)
    expect(repository.recoveryNotice).toMatch(/replaced/i)
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
  ] as const)('recovers current-schema claim resolution corruption: %s', (_label, mutate) => {
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
    expect(repository.recoveryNotice).toMatch(/replaced/i)
    expect(repository.getSnapshot()).toEqual(createDemoState())
  })
})
