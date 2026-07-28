import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BOX_PRICE_SEN, DEMO_ADMIN_ID, PRIZES, type AdminSection } from '../src/domain/constants'
import type { Role } from '../src/domain/types'
import { createDemoState, DEMO_ADDRESS } from '../src/data/fixtures'
import { STORAGE_KEY } from '../src/data/MockRepository'
import { validateDemoState } from '../src/data/StateValidator'
import { AppServices } from '../src/services/AppServices'
import {
  CountingStorage,
  MemoryStorage,
  FIXED_NOW,
  makeProcessingOrderTwoPhysicalShipments,
} from './helpers'

let checkoutSequence = 0
const nextCheckoutRequestId = () => `checkout_f${(++checkoutSequence).toString(16).padStart(31, '0')}`

function checkout(services: AppServices, quantity = 1, requestId = nextCheckoutRequestId()) {
  services.auth.oneClick('customer')
  services.orders.setCartQuantity(quantity)
  return services.orders.create({
    requestId,
    quantity,
    shippingMethod: 'standard',
    address: DEMO_ADDRESS,
    acknowledged: true,
    displayedTotalSen: quantity * BOX_PRICE_SEN + 1200,
  })
}

function neutralClaimWideningScenario() {
  let now = '2026-07-28T04:00:00.000Z'
  const services = new AppServices(new MemoryStorage(), () => now)
  makeProcessingOrderTwoPhysicalShipments(services)
  services.auth.oneClick('admin')
  now = '2026-07-28T05:00:00.000Z'
  for (const status of ['packed', 'label_created', 'shipped', 'failed_delivery'] as const) {
    services.fulfilment.advance(
      'shp-processing',
      status,
      `Confirmed first neutral claim evidence ${status}`,
    )
  }
  services.auth.oneClick('customer')
  now = '2026-07-28T06:00:00.000Z'
  const first = services.claims.submit({
    orderId: 'ord-processing',
    kind: 'non_delivery',
    orderLevelDelivery: true,
    note: 'DEMO first neutral order-level delivery evidence',
  })

  const moveToReviewState = (status: 'reviewing' | 'approved') => {
    services.auth.oneClick('admin')
    now = '2026-07-28T06:30:00.000Z'
    services.claims.review(
      first.data.id,
      'acknowledge',
      'Confirmed fictional review before evidence resubmission.',
    )
    if (status === 'approved') {
      now = '2026-07-28T06:45:00.000Z'
      services.claims.review(
        first.data.id,
        'approve',
        'Confirmed fictional approval freezing claim evidence.',
      )
    }
  }

  const makeSecondShipmentEligible = () => {
    services.auth.oneClick('admin')
    now = '2026-07-28T07:00:00.000Z'
    for (const status of ['picking', 'packed', 'label_created', 'shipped', 'failed_delivery'] as const) {
      services.fulfilment.advance(
        'shp-digital',
        status,
        `Confirmed second neutral claim evidence ${status}`,
      )
    }
    services.auth.oneClick('customer')
    now = '2026-07-28T08:00:00.000Z'
  }

  const resubmit = () => services.claims.submit({
    orderId: 'ord-processing',
    kind: 'non_delivery',
    orderLevelDelivery: true,
    note: 'DEMO resubmitted after another delivery became eligible',
  })

  return {
    services,
    first,
    moveToReviewState,
    makeSecondShipmentEligible,
    resubmit,
  }
}

describe('customer, payment, allocation and admin services', () => {
  let services: AppServices

  beforeEach(() => {
    services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
  })

  it('recalculates totals and snapshots cart/order data', () => {
    const order = checkout(services, 2)
    expect(order.snapshot.totals).toEqual({
      itemSubtotalSen: 20_000,
      shippingSen: 1200,
      totalSen: 21_200,
    })
    expect(order.boxIds).toHaveLength(2)
    expect(services.repository.getSnapshot().series[0].reservedBoxes).toBe(2)
    expect(services.repository.getSnapshot().cart).toHaveLength(0)
  })

  it('rejects a tampered displayed total before creating anything', () => {
    services.auth.oneClick('customer')
    const before = services.repository.getSnapshot().orders.length
    expect(() => services.orders.create({
      requestId: nextCheckoutRequestId(),
      quantity: 1,
      shippingMethod: 'standard',
      address: DEMO_ADDRESS,
      acknowledged: true,
      displayedTotalSen: 1,
    })).toThrow(/server-like recalculation/i)
    expect(services.repository.getSnapshot().orders.length).toBe(before)
  })

  it('returns one owned order for an exact checkout replay without another write', () => {
    services.auth.oneClick('customer')
    const requestId = nextCheckoutRequestId()
    const input = {
      requestId,
      quantity: 2,
      shippingMethod: 'standard' as const,
      address: DEMO_ADDRESS,
      acknowledged: true,
      displayedTotalSen: 21_200,
    }
    const first = services.orders.create(input)
    const afterFirst = services.repository.getSnapshot()
    const evidence = {
      revision: afterFirst.revision,
      orders: afterFirst.orders.length,
      boxes: afterFirst.boxes.length,
      reserved: afterFirst.series[0].reservedBoxes,
      audits: afterFirst.audits.length,
    }
    const replay = services.orders.create(input)
    const afterReplay = services.repository.getSnapshot()
    expect(replay.id).toBe(first.id)
    expect({
      revision: afterReplay.revision,
      orders: afterReplay.orders.length,
      boxes: afterReplay.boxes.length,
      reserved: afterReplay.series[0].reservedBoxes,
      audits: afterReplay.audits.length,
    }).toEqual(evidence)
  })

  it('rejects mismatched and cross-owner checkout request reuse', () => {
    const requestId = nextCheckoutRequestId()
    const order = checkout(services, 1, requestId)
    expect(() => services.orders.create({
      requestId,
      quantity: 2,
      shippingMethod: 'standard',
      address: DEMO_ADDRESS,
      acknowledged: true,
      displayedTotalSen: 21_200,
    })).toThrow(/does not match the original intent/i)
    services.repository.update((state) => {
      state.users.push({
        id: 'usr-other-customer',
        name: 'Other Demo',
        email: 'other@example.test',
        role: 'customer',
        status: 'active',
        createdAt: FIXED_NOW,
      })
      state.sessionUserId = 'usr-other-customer'
    })
    expect(() => services.orders.create({
      requestId,
      quantity: order.snapshot.quantity,
      shippingMethod: order.snapshot.shippingMethod,
      address: order.snapshot.address,
      acknowledged: true,
      displayedTotalSen: order.snapshot.totals.totalSen,
    })).toThrow(/belongs to another fictional account/i)
  })

  it('success event allocates once, decrements remaining once and creates fulfilment', () => {
    const order = checkout(services, 2)
    const payment = services.payments.createAttempt(order.id, 'FPX')
    const assignedBefore = services.repository.getSnapshot().series[0].inventory.reduce((sum, entry) => sum + entry.assigned, 0)
    const first = services.payments.processEvent(payment.id, 'evt-success-exact', 'succeeded')
    const after = services.repository.getSnapshot()
    expect(first.changed).toBe(true)
    expect(after.orders.find((entry) => entry.id === order.id)?.status).toBe('confirmed')
    expect(after.boxes.filter((box) => order.boxIds.includes(box.id)).every((box) => box.prizeId && box.status === 'paid_unopened')).toBe(true)
    expect(after.series[0].inventory.reduce((sum, entry) => sum + entry.assigned, 0)).toBe(assignedBefore + 2)
    expect(after.shipments.some((shipment) => shipment.orderId === order.id)).toBe(true)

    const duplicate = services.payments.processEvent(payment.id, 'evt-success-exact', 'succeeded')
    const distinctRepeat = services.payments.processEvent(payment.id, 'evt-success-distinct', 'succeeded')
    const afterDuplicate = services.repository.getSnapshot()
    expect(duplicate.changed).toBe(false)
    expect(distinctRepeat.changed).toBe(false)
    expect(afterDuplicate.series[0].inventory.reduce((sum, entry) => sum + entry.assigned, 0)).toBe(assignedBefore + 2)
    expect(afterDuplicate.boxes.filter((box) => order.boxIds.includes(box.id))).toHaveLength(2)
  })

  it('makes an exact duplicate event a fully side-effect-free authorized read', () => {
    let clock = FIXED_NOW
    const storage = new CountingStorage()
    const isolated = new AppServices(storage, () => clock)
    const order = checkout(isolated)
    const payment = isolated.payments.createAttempt(order.id)
    const eventId = payment.events[0].id
    const before = structuredClone(isolated.repository.getSnapshot())
    const writesBefore = storage.writes
    let listenerCalls = 0
    const unsubscribe = isolated.repository.subscribe(() => { listenerCalls += 1 })

    clock = '2026-07-28T05:00:00.000Z'
    const duplicate = isolated.payments.processEvent(payment.id, eventId, 'created')
    unsubscribe()

    const after = isolated.repository.getSnapshot()
    expect(duplicate).toMatchObject({
      changed: false,
      message: 'Duplicate event ignored safely.',
    })
    expect(after).toEqual(before)
    expect(after.revision).toBe(before.revision)
    expect(after.audits).toEqual(before.audits)
    expect(after.payments.find((entry) => entry.id === payment.id)?.events).toEqual(
      before.payments.find((entry) => entry.id === payment.id)?.events,
    )
    expect(after.orders.find((entry) => entry.id === order.id)?.status).toBe('pending_payment')
    expect(after.series[0].reservedBoxes).toBe(before.series[0].reservedBoxes)
    expect(storage.writes).toBe(writesBefore)
    expect(listenerCalls).toBe(0)
  })

  it('rejects changed event intent, changed source, and cross-payment reuse without writes or listeners', () => {
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))
    const guarded = new AppServices(storage, () => FIXED_NOW)
    const firstOrder = checkout(guarded)
    const firstPayment = guarded.payments.createAttempt(firstOrder.id)
    const secondOrder = checkout(guarded)
    const secondPayment = guarded.payments.createAttempt(secondOrder.id)
    const eventId = firstPayment.events[0].id
    const listener = vi.fn()
    guarded.repository.subscribe(listener)

    const expectConflictWithoutChange = (operation: () => unknown) => {
      const before = structuredClone(guarded.repository.getSnapshot())
      const writesBefore = storage.writes
      listener.mockClear()
      expect(operation).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }))
      expect(guarded.repository.getSnapshot()).toEqual(before)
      expect(storage.writes).toBe(writesBefore)
      expect(listener).not.toHaveBeenCalled()
    }

    expectConflictWithoutChange(() =>
      guarded.payments.processEvent(firstPayment.id, eventId, 'succeeded'),
    )

    guarded.auth.oneClick('admin')
    expectConflictWithoutChange(() =>
      guarded.payments.processEvent(firstPayment.id, eventId, 'created', 'admin_reconcile'),
    )

    guarded.auth.oneClick('customer')
    expectConflictWithoutChange(() =>
      guarded.payments.processEvent(secondPayment.id, eventId, 'created'),
    )
  })

  it('enforces the same exact replay contract inside the cloned concurrent update path', () => {
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))
    const isolated = new AppServices(storage, () => FIXED_NOW)
    isolated.auth.oneClick('customer')
    const actual = isolated.repository.getSnapshot()
    const payment = actual.payments.find((entry) => entry.id === 'pay-unopened')!
    const event = payment.events[0]
    const stale = structuredClone(actual)
    stale.payments.find((entry) => entry.id === payment.id)!.events = []
    const snapshot = vi.spyOn(isolated.repository, 'getSnapshot')
    const listener = vi.fn()
    isolated.repository.subscribe(listener)
    const before = structuredClone(actual)
    const writesBefore = storage.writes

    snapshot.mockReturnValueOnce(stale)
    expect(isolated.payments.processEvent(payment.id, event.id, event.type, 'mock_webhook')).toMatchObject({
      changed: false,
      message: 'Duplicate event ignored safely.',
    })
    expect(isolated.repository.getSnapshot()).toEqual(before)
    expect(storage.writes).toBe(writesBefore)
    expect(listener).not.toHaveBeenCalled()

    snapshot.mockReturnValueOnce(stale)
    expect(() => isolated.payments.processEvent(payment.id, event.id, 'failed', 'mock_webhook')).toThrow(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
    )
    expect(isolated.repository.getSnapshot()).toEqual(before)
    expect(storage.writes).toBe(writesBefore)
    expect(listener).not.toHaveBeenCalled()
    snapshot.mockRestore()
  })

  it('rejects concurrent changed-source and cross-payment event reuse without side effects', () => {
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))
    const isolated = new AppServices(storage, () => FIXED_NOW)
    const listener = vi.fn()
    isolated.repository.subscribe(listener)

    isolated.auth.oneClick('admin')
    listener.mockClear()
    let actual = isolated.repository.getSnapshot()
    const originalPayment = actual.payments.find((entry) => entry.id === 'pay-unopened')!
    const originalEvent = originalPayment.events[0]
    let stale = structuredClone(actual)
    stale.payments.find((entry) => entry.id === originalPayment.id)!.events = []
    const snapshot = vi.spyOn(isolated.repository, 'getSnapshot')
    let writesBefore = storage.writes
    snapshot.mockReturnValueOnce(stale)
    expect(() => isolated.payments.processEvent(
      originalPayment.id,
      originalEvent.id,
      originalEvent.type,
      'admin_reconcile',
    )).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }))
    expect(isolated.repository.getSnapshot()).toEqual(actual)
    expect(storage.writes).toBe(writesBefore)
    expect(listener).not.toHaveBeenCalled()

    snapshot.mockRestore()
    isolated.auth.oneClick('customer')
    listener.mockClear()
    actual = isolated.repository.getSnapshot()
    const otherPayment = actual.payments.find((entry) =>
      entry.id !== originalPayment.id && entry.userId === originalPayment.userId,
    )!
    stale = structuredClone(actual)
    stale.payments.find((entry) => entry.id === originalPayment.id)!.events = []
    const crossPaymentSnapshot = vi.spyOn(isolated.repository, 'getSnapshot')
    writesBefore = storage.writes
    crossPaymentSnapshot.mockReturnValueOnce(stale)
    expect(() => isolated.payments.processEvent(
      otherPayment.id,
      originalEvent.id,
      originalEvent.type,
      'mock_webhook',
    )).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }))
    expect(isolated.repository.getSnapshot()).toEqual(actual)
    expect(storage.writes).toBe(writesBefore)
    expect(listener).not.toHaveBeenCalled()
    crossPaymentSnapshot.mockRestore()
  })

  it('authorizes duplicate events before revealing their idempotent result', () => {
    const storage = new CountingStorage()
    const guarded = new AppServices(storage, () => FIXED_NOW)
    const order = checkout(guarded)
    const payment = guarded.payments.createAttempt(order.id)
    const eventId = payment.events[0].id
    const listener = vi.fn()
    guarded.repository.subscribe(listener)

    const beforeSourceSpoof = structuredClone(guarded.repository.getSnapshot())
    let writesBefore = storage.writes
    expect(() => guarded.payments.processEvent(
      payment.id,
      eventId,
      'created',
      'admin_reconcile',
    )).toThrow(/cannot reconcile demo payments/i)
    expect(guarded.repository.getSnapshot()).toEqual(beforeSourceSpoof)
    expect(storage.writes).toBe(writesBefore)
    expect(listener).not.toHaveBeenCalled()

    guarded.repository.update((state) => {
      state.users.push({
        id: 'usr-duplicate-other',
        name: 'Duplicate Other Demo',
        email: 'duplicate.other@example.test',
        role: 'customer',
        status: 'active',
        createdAt: FIXED_NOW,
      })
      state.sessionUserId = 'usr-duplicate-other'
    })
    listener.mockClear()
    const beforeOwnershipCheck = structuredClone(guarded.repository.getSnapshot())
    writesBefore = storage.writes
    expect(() => guarded.payments.processEvent(payment.id, eventId, 'created')).toThrow(
      /belongs to another fictional user/i,
    )
    expect(guarded.repository.getSnapshot()).toEqual(beforeOwnershipCheck)
    expect(storage.writes).toBe(writesBefore)
    expect(listener).not.toHaveBeenCalled()
  })

  it('handles failure, cancellation, expiry and retry without paying the order', () => {
    const failureOrder = checkout(services)
    const failed = services.payments.createAttempt(failureOrder.id)
    services.payments.act(failed.id, 'decline')
    expect(services.repository.getSnapshot().payments.find((entry) => entry.id === failed.id)?.status).toBe('failed')
    const retry = services.payments.createAttempt(failureOrder.id)
    expect(retry.attempt).toBe(2)

    services.payments.act(retry.id, 'cancel')
    const retryAfterCancel = services.payments.createAttempt(failureOrder.id)
    services.payments.act(retryAfterCancel.id, 'expire')
    expect(services.repository.getSnapshot().payments.find((entry) => entry.id === retryAfterCancel.id)?.status).toBe('expired')
    expect(services.repository.getSnapshot().orders.find((entry) => entry.id === failureOrder.id)?.status).toBe('pending_payment')
  })

  it('releases one reservation once across distinct repeated terminal events and late old events', () => {
    const order = checkout(services, 2)
    const payment = services.payments.createAttempt(order.id)
    const reservedBefore = services.repository.getSnapshot().series[0].reservedBoxes

    const first = services.payments.processEvent(payment.id, 'evt-cancel-first', 'cancelled')
    const afterFirst = services.repository.getSnapshot()
    expect(first.changed).toBe(true)
    expect(afterFirst.series[0].reservedBoxes).toBe(reservedBefore - 2)
    expect(afterFirst.boxes.filter((box) => order.boxIds.includes(box.id)).every((box) => box.status === 'void')).toBe(true)

    const repeatedCancel = services.payments.processEvent(payment.id, 'evt-cancel-distinct', 'cancelled')
    const repeatedExpire = services.payments.processEvent(payment.id, 'evt-expire-distinct', 'expired')
    expect(repeatedCancel.changed).toBe(false)
    expect(repeatedExpire.changed).toBe(false)
    expect(services.repository.getSnapshot().series[0].reservedBoxes).toBe(reservedBefore - 2)
    expect(services.repository.getSnapshot().audits.filter((entry) => entry.action === 'order.reservation_released' && entry.targetId === order.id)).toHaveLength(1)

    const retry = services.payments.createAttempt(order.id)
    expect(retry.attempt).toBe(2)
    expect(services.repository.getSnapshot().series[0].reservedBoxes).toBe(reservedBefore)
    expect(services.repository.getSnapshot().boxes.filter((box) => order.boxIds.includes(box.id)).every((box) => box.status === 'reserved')).toBe(true)

    services.payments.processEvent(payment.id, 'evt-cancel-after-renewal', 'cancelled')
    expect(services.repository.getSnapshot().series[0].reservedBoxes).toBe(reservedBefore)
    expect(services.repository.getSnapshot().boxes.filter((box) => order.boxIds.includes(box.id)).every((box) => box.status === 'reserved')).toBe(true)
  })

  it('expires unpaid reservations from an injected clock exactly at the stored deadline', () => {
    let clock = '2026-07-28T04:00:00.000Z'
    const timed = new AppServices(new MemoryStorage(), () => clock)
    const order = checkout(timed)
    const payment = timed.payments.createAttempt(order.id)
    const reservedBefore = timed.repository.getSnapshot().series[0].reservedBoxes

    clock = '2026-07-28T04:14:59.999Z'
    expect(timed.orders.expireReservations()).toMatchObject({ changed: false, count: 0 })
    expect(timed.repository.getSnapshot().series[0].reservedBoxes).toBe(reservedBefore)

    clock = order.reservationExpiresAt
    expect(timed.orders.expireReservations()).toMatchObject({ changed: true, count: 1, orderIds: [order.id] })
    let snapshot = timed.repository.getSnapshot()
    expect(snapshot.series[0].reservedBoxes).toBe(reservedBefore - 1)
    expect(snapshot.payments.find((entry) => entry.id === payment.id)?.status).toBe('expired')
    expect(snapshot.payments.find((entry) => entry.id === payment.id)?.events.at(-1)?.source).toBe('reservation_clock')
    expect(snapshot.boxes.find((box) => order.boxIds.includes(box.id))?.status).toBe('void')

    expect(timed.orders.expireReservations()).toMatchObject({ changed: false, count: 0 })
    expect(timed.repository.getSnapshot().series[0].reservedBoxes).toBe(reservedBefore - 1)
    const lateSuccess = timed.payments.processEvent(payment.id, 'evt-success-after-deadline', 'succeeded')
    expect(lateSuccess.changed).toBe(false)
    expect(timed.repository.getSnapshot().boxes.find((box) => order.boxIds.includes(box.id))?.prizeId).toBeUndefined()

    clock = '2026-07-28T04:16:00.000Z'
    timed.payments.createAttempt(order.id)
    snapshot = timed.repository.getSnapshot()
    expect(snapshot.series[0].reservedBoxes).toBe(reservedBefore)
    expect(snapshot.boxes.find((box) => order.boxIds.includes(box.id))?.status).toBe('reserved')
    expect(snapshot.orders.find((entry) => entry.id === order.id)?.reservationExpiresAt).toBe('2026-07-28T04:31:00.000Z')
  })

  it('guards admin cancellation of unpaid orders and releases stock once', () => {
    const blockedOrder = checkout(services)
    services.payments.createAttempt(blockedOrder.id)
    services.auth.oneClick('admin')
    expect(() => services.admin.changeOrderStatus(blockedOrder.id, 'cancelled', 'Cancel with active payment')).toThrow(/active payment/i)

    services.auth.oneClick('customer')
    const cancellable = checkout(services)
    const reservedBefore = services.repository.getSnapshot().series[0].reservedBoxes
    services.auth.oneClick('admin')
    services.admin.changeOrderStatus(cancellable.id, 'cancelled', 'Confirmed unpaid admin cancellation')
    const snapshot = services.repository.getSnapshot()
    expect(snapshot.orders.find((entry) => entry.id === cancellable.id)?.status).toBe('cancelled')
    expect(snapshot.series[0].reservedBoxes).toBe(reservedBefore - 1)
    expect(snapshot.boxes.find((box) => cancellable.boxIds.includes(box.id))?.status).toBe('void')
    expect(snapshot.audits.filter((entry) => entry.action === 'order.reservation_released' && entry.targetId === cancellable.id)).toHaveLength(1)
  })

  it('records an out-of-order event without allocations', () => {
    const order = checkout(services)
    const payment = services.payments.createAttempt(order.id)
    services.payments.act(payment.id, 'decline')
    const result = services.payments.processEvent(payment.id, 'evt-late-success', 'succeeded')
    expect(result.changed).toBe(false)
    expect(result.message).toBe('Out-of-order event was recorded without changing payment status.')
    expect(services.repository.getSnapshot().boxes.find((box) => order.boxIds.includes(box.id))?.prizeId).toBeUndefined()
    expect(services.repository.getSnapshot().payments.find((entry) => entry.id === payment.id)?.events.at(-1)?.ignoredReason).toMatch(/out-of-order/i)
    expect(() => validateDemoState(services.repository.getSnapshot())).not.toThrow()
  })

  it('keeps a disputed payment unchanged when a customer tries a finance-only resolution', () => {
    services.auth.oneClick('admin')
    services.payments.dispute(
      'pay-unopened',
      'Confirmed protected customer dispute action test',
      'evt-protected-customer-dispute',
    )
    services.auth.oneClick('customer')
    const before = structuredClone(services.repository.getSnapshot())

    expect(() => services.payments.act('pay-unopened', 'approve')).toThrow(
      /protected finance review/i,
    )
    expect(services.repository.getSnapshot()).toEqual(before)
  })

  it('shares the active-attempt guard between customer retry and admin retry', () => {
    const order = checkout(services)
    const first = services.payments.createAttempt(order.id)
    services.payments.act(first.id, 'decline')
    const second = services.payments.createAttempt(order.id)
    expect(second.attempt).toBe(2)
    services.auth.oneClick('admin')
    expect(() => services.payments.adminRetry(first.id, 'Attempted conflicting admin retry')).toThrow(/active payment attempt/i)
    expect(services.repository.getSnapshot().payments.filter((payment) => payment.orderId === order.id)).toHaveLength(2)
  })

  it('defends specific old-attempt retries when another attempt is active or captured', () => {
    const order = checkout(services)
    const first = services.payments.createAttempt(order.id)
    services.payments.act(first.id, 'decline')
    const second = services.payments.createAttempt(order.id)
    let before = structuredClone(services.repository.getSnapshot())

    expect(() => services.payments.createAttempt(order.id, 'FPX', first.id)).toThrow(
      /active payment attempt/i,
    )
    expect(services.repository.getSnapshot()).toEqual(before)

    services.payments.act(second.id, 'approve')
    services.auth.oneClick('admin')
    before = structuredClone(services.repository.getSnapshot())
    expect(() => services.payments.adminRetry(
      first.id,
      'Confirmed blocked retry after another capture',
    )).toThrow(/no longer accepts payment attempts|captured payment/i)
    expect(services.repository.getSnapshot()).toEqual(before)
  })

  it('ignores a second distinct success event across attempts without duplicate side effects', () => {
    const order = checkout(services, 2)
    const first = services.payments.createAttempt(order.id)
    services.payments.act(first.id, 'decline')
    const second = services.payments.createAttempt(order.id)
    services.payments.processEvent(second.id, 'evt-attempt-two-success', 'succeeded')
    const before = structuredClone(services.repository.getSnapshot())
    const forced = services.payments.processEvent(first.id, 'evt-attempt-one-forced-success', 'succeeded')
    const after = services.repository.getSnapshot()
    expect(forced.changed).toBe(false)
    expect(after.payments.find((payment) => payment.id === first.id)?.events.at(-1)?.ignoredReason).toMatch(/already captured/i)
    expect(after.boxes.filter((box) => order.boxIds.includes(box.id))).toEqual(before.boxes.filter((box) => order.boxIds.includes(box.id)))
    expect(after.shipments.filter((shipment) => shipment.orderId === order.id)).toEqual(before.shipments.filter((shipment) => shipment.orderId === order.id))
    expect(after.series[0].inventory).toEqual(before.series[0].inventory)
    expect(after.audits).toEqual(before.audits)
    expect(after.payments.filter((payment) => payment.orderId === order.id && payment.events.some((event) => event.type === 'succeeded' && !event.ignoredReason))).toHaveLength(1)
  })

  it('opens exactly once and refresh-equivalent reads return the immutable reveal', () => {
    const order = checkout(services)
    const payment = services.payments.createAttempt(order.id)
    services.payments.act(payment.id, 'approve')
    const boxId = order.boxIds[0]
    const first = services.openBox(boxId)
    const firstPrize = first.box.prizeId
    const second = services.openBox(boxId)
    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(second.box.prizeId).toBe(firstPrize)
    expect(services.repository.getSnapshot().boxes.find((box) => box.id === boxId)?.revealedAt).toBeTruthy()
  })

  it('makes repeat reveal, duplicate open claim, and exact refund replay true storage/listener no-ops', () => {
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))
    const guarded = new AppServices(storage, () => FIXED_NOW)
    guarded.auth.oneClick('customer')
    const order = checkout(guarded)
    const payment = guarded.payments.createAttempt(order.id)
    guarded.payments.act(payment.id, 'approve')
    const boxId = order.boxIds[0]
    guarded.openBox(boxId)
    const claim = guarded.claims.submit({
      orderId: 'ord-shipped',
      kind: 'non_delivery',
      shipmentId: 'shp-shipped',
      note: 'DEMO first idempotent claim record',
    })
    guarded.auth.oneClick('admin')
    const refund = guarded.payments.refund(
      'pay-unopened',
      1000,
      'Confirmed exact refund replay intent',
      'req-exact-refund-replay',
    )
    guarded.auth.oneClick('customer')

    const listener = vi.fn()
    guarded.repository.subscribe(listener)
    const beforeReveal = structuredClone(guarded.repository.getSnapshot())
    const writesBeforeReveal = storage.writes
    const repeatedReveal = guarded.openBox(boxId)
    expect(repeatedReveal).toMatchObject({ changed: false, box: { revealedAt: expect.any(String) } })
    expect(guarded.repository.getSnapshot()).toEqual(beforeReveal)
    expect(storage.writes).toBe(writesBeforeReveal)
    expect(listener).not.toHaveBeenCalled()

    const beforeClaim = structuredClone(guarded.repository.getSnapshot())
    const writesBeforeClaim = storage.writes
    const duplicateClaim = guarded.claims.submit({
      orderId: 'ord-shipped',
      kind: 'non_delivery',
      shipmentId: 'shp-shipped',
      note: 'DEMO second note returns the open claim',
    })
    expect(duplicateClaim).toMatchObject({ changed: false, data: { id: claim.data.id } })
    expect(guarded.repository.getSnapshot()).toEqual(beforeClaim)
    expect(storage.writes).toBe(writesBeforeClaim)
    expect(listener).not.toHaveBeenCalled()

    guarded.auth.oneClick('admin')
    listener.mockClear()
    const beforeRefundReplay = structuredClone(guarded.repository.getSnapshot())
    const writesBeforeRefundReplay = storage.writes
    const refundReplay = guarded.payments.refund(
      'pay-unopened',
      1000,
      'Confirmed exact refund replay intent',
      'req-exact-refund-replay',
    )
    expect(refundReplay).toMatchObject({ changed: false, payment: { id: refund.payment.id } })
    expect(guarded.repository.getSnapshot()).toEqual(beforeRefundReplay)
    expect(storage.writes).toBe(writesBeforeRefundReplay)
    expect(listener).not.toHaveBeenCalled()

    for (const [targetPaymentId, amount, reason] of [
      ['pay-delivered', 1000, 'Confirmed exact refund replay intent'],
      ['pay-unopened', 2000, 'Confirmed exact refund replay intent'],
      ['pay-unopened', 1000, 'Confirmed changed refund replay reason'],
    ] as const) {
      expect(() => guarded.payments.refund(
        targetPaymentId,
        amount,
        reason,
        'req-exact-refund-replay',
      )).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }))
    }
    expect(guarded.repository.getSnapshot()).toEqual(beforeRefundReplay)
    expect(storage.writes).toBe(writesBeforeRefundReplay)
    expect(listener).not.toHaveBeenCalled()

    guarded.repository.update((state) => {
      state.users.push({
        id: 'usr-noop-other',
        name: 'Noop Other Demo',
        email: 'noop.other@example.test',
        role: 'customer',
        status: 'active',
        createdAt: FIXED_NOW,
      })
      state.sessionUserId = 'usr-noop-other'
    })
    listener.mockClear()
    const beforeUnauthorized = structuredClone(guarded.repository.getSnapshot())
    const writesBeforeUnauthorized = storage.writes
    expect(() => guarded.openBox(boxId)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => guarded.claims.submit({
      orderId: 'ord-shipped',
      kind: 'non_delivery',
      shipmentId: 'shp-shipped',
      note: 'DEMO unauthorized duplicate claim attempt',
    })).toThrow(expect.objectContaining({ code: 'ORDER_MISSING' }))
    expect(() => guarded.payments.refund(
      'pay-unopened',
      1000,
      'Confirmed exact refund replay intent',
      'req-exact-refund-replay',
    )).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(guarded.repository.getSnapshot()).toEqual(beforeUnauthorized)
    expect(storage.writes).toBe(writesBeforeUnauthorized)
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps reveal exactly-once and shipment state intact when one box opens before delivery and one after', () => {
    const order = checkout(services, 2)
    const payment = services.payments.createAttempt(order.id)
    services.payments.act(payment.id, 'approve')
    const [openedFirstId, openedLaterId] = order.boxIds
    const firstReveal = services.openBox(openedFirstId)
    const firstRevealAt = firstReveal.box.revealedAt
    const shipments = services.repository.getSnapshot().shipments.filter((entry) => entry.orderId === order.id)

    services.auth.oneClick('admin')
    for (const shipment of shipments) {
      for (const status of ['picking', 'packed', 'label_created', 'shipped', 'delivered'] as const) {
        services.fulfilment.advance(shipment.id, status, `Confirmed test ${status} transition`)
      }
    }
    let snapshot = services.repository.getSnapshot()
    expect(snapshot.shipments.filter((entry) => entry.orderId === order.id).every((entry) => entry.status === 'delivered')).toBe(true)
    expect(snapshot.boxes.find((box) => box.id === openedFirstId)).toMatchObject({ status: 'fulfilled', revealedAt: firstRevealAt })
    expect(snapshot.boxes.find((box) => box.id === openedLaterId)?.status).toBe('fulfilled')
    expect(snapshot.boxes.find((box) => box.id === openedLaterId)?.revealedAt).toBeUndefined()

    services.auth.oneClick('customer')
    const laterFirst = services.openBox(openedLaterId)
    const laterRepeat = services.openBox(openedLaterId)
    snapshot = services.repository.getSnapshot()
    expect(laterFirst.changed).toBe(true)
    expect(laterRepeat.changed).toBe(false)
    expect(laterRepeat.box.prizeId).toBe(laterFirst.box.prizeId)
    expect(snapshot.boxes.find((box) => box.id === openedLaterId)?.status).toBe('fulfilled')
    expect(snapshot.shipments.filter((entry) => entry.orderId === order.id).every((entry) => entry.status === 'delivered')).toBe(true)
  })

  it('puts boxes on hold for every failed, lost or returned shipment exception', () => {
    for (const exception of ['failed_delivery', 'lost', 'returned'] as const) {
      const isolated = new AppServices(new MemoryStorage(), () => FIXED_NOW)
      const order = checkout(isolated)
      const payment = isolated.payments.createAttempt(order.id)
      isolated.payments.act(payment.id, 'approve')
      const shipment = isolated.repository.getSnapshot().shipments.find((entry) => entry.orderId === order.id)!
      isolated.auth.oneClick('admin')
      for (const status of ['picking', 'packed', 'label_created', 'shipped'] as const) {
        isolated.fulfilment.advance(shipment.id, status, `Confirmed ${status} before ${exception}`)
      }
      isolated.fulfilment.advance(shipment.id, exception, `Confirmed ${exception} fixture exception`)
      const snapshot = isolated.repository.getSnapshot()
      expect(snapshot.shipments.find((entry) => entry.id === shipment.id)?.status).toBe(exception)
      expect(snapshot.boxes.find((entry) => entry.id === order.boxIds[0])?.status).toBe('on_hold')
      expect(snapshot.orders.find((entry) => entry.id === order.id)?.status).toBe('processing')
    }
  })

  it('keeps repeated legal shipment cycles collision-proof with a fixed clock', () => {
    services.auth.oneClick('admin')
    services.fulfilment.advance('shp-shipped', 'failed_delivery', 'Confirmed first fixed-clock delivery exception')
    services.fulfilment.advance('shp-shipped', 'shipped', 'Confirmed fixed-clock delivery retry')
    services.fulfilment.advance('shp-shipped', 'failed_delivery', 'Confirmed repeated fixed-clock delivery exception')

    const snapshot = services.repository.getSnapshot()
    const shipment = snapshot.shipments.find((entry) => entry.id === 'shp-shipped')!
    const order = snapshot.orders.find((entry) => entry.id === shipment.orderId)!
    expect(shipment.timeline.slice(-3).map((entry) => entry.status)).toEqual(['failed_delivery', 'shipped', 'failed_delivery'])
    expect(new Set(shipment.timeline.map((entry) => entry.id)).size).toBe(shipment.timeline.length)
    expect(new Set(order.timeline.map((entry) => entry.id)).size).toBe(order.timeline.length)
    expect(snapshot.nextSequence).toBe(1003)
    expect(() => validateDemoState(snapshot)).not.toThrow()
  })

  it('accepts failed_delivery to shipped to delivered and derives fulfilment exactly', () => {
    services.auth.oneClick('admin')
    services.fulfilment.advance('shp-failed', 'shipped', 'Confirmed redelivery after failed delivery')
    services.fulfilment.advance('shp-failed', 'delivered', 'Confirmed successful redelivery completion')

    const snapshot = services.repository.getSnapshot()
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-failed')?.timeline.slice(-3).map((entry) => entry.status)).toEqual([
      'failed_delivery',
      'shipped',
      'delivered',
    ])
    expect(snapshot.orders.find((entry) => entry.id === 'ord-failed')?.status).toBe('fulfilled')
    expect(snapshot.boxes.find((entry) => entry.id === 'box-failed-01')?.status).toBe('fulfilled')
    expect(() => validateDemoState(snapshot)).not.toThrow()
  })

  it('records a post-delivery return and reopens a fulfilled order without money or claim side effects', () => {
    services.auth.oneClick('admin')
    const before = services.repository.getSnapshot()
    const refundedBefore = before.payments.reduce((sum, payment) => sum + payment.refundedSen, 0)
    const claimsBefore = before.claims.length
    services.fulfilment.advance('shp-delivered', 'returned', 'Confirmed post-delivery return record')
    const snapshot = services.repository.getSnapshot()
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-delivered')?.status).toBe('returned')
    expect(snapshot.orders.find((entry) => entry.id === 'ord-delivered')?.status).toBe('processing')
    expect(snapshot.boxes.find((entry) => entry.id === 'box-delivered-01')?.status).toBe('on_hold')
    expect(snapshot.payments.reduce((sum, payment) => sum + payment.refundedSen, 0)).toBe(refundedBefore)
    expect(snapshot.claims).toHaveLength(claimsBefore)
    expect(() => validateDemoState(snapshot)).not.toThrow()
  })

  it('derives a mixed delivered and returned order as partially fulfilled', () => {
    services.auth.oneClick('admin')
    for (const shipmentId of ['shp-processing', 'shp-digital']) {
      const shipment = services.repository.getSnapshot().shipments.find((entry) => entry.id === shipmentId)!
      const path = shipment.status === 'picking'
        ? ['packed', 'label_created', 'shipped', 'delivered'] as const
        : ['picking', 'packed', 'label_created', 'shipped', 'delivered'] as const
      for (const status of path) {
        services.fulfilment.advance(shipmentId, status, `Confirmed mixed-order ${status}`)
      }
    }
    expect(services.repository.getSnapshot().orders.find((entry) => entry.id === 'ord-processing')?.status).toBe('fulfilled')
    services.fulfilment.advance('shp-processing', 'returned', 'Confirmed one mixed shipment returned')
    const snapshot = services.repository.getSnapshot()
    expect(snapshot.orders.find((entry) => entry.id === 'ord-processing')?.status).toBe('partially_fulfilled')
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-processing')?.status).toBe('returned')
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-digital')?.status).toBe('delivered')
    expect(() => validateDemoState(snapshot)).not.toThrow()
  })

  it('reopens a closed order for a confirmed post-delivery return', () => {
    services.auth.oneClick('admin')
    services.admin.changeOrderStatus('ord-delivered', 'closed', 'Confirmed closure before return test')
    services.fulfilment.advance('shp-delivered', 'returned', 'Confirmed return after order closure')
    const snapshot = services.repository.getSnapshot()
    expect(snapshot.orders.find((entry) => entry.id === 'ord-delivered')?.status).toBe('processing')
    expect(snapshot.orders.find((entry) => entry.id === 'ord-delivered')?.timeline.map((entry) => entry.status)).toEqual([
      'pending_payment',
      'confirmed',
      'processing',
      'fulfilled',
      'closed',
      'processing',
    ])
    expect(() => validateDemoState(snapshot)).not.toThrow()
  })

  it('full refund after reveal retains prize slot and does not reroll', () => {
    const order = checkout(services)
    const payment = services.payments.createAttempt(order.id)
    services.payments.act(payment.id, 'approve')
    const boxId = order.boxIds[0]
    const opened = services.openBox(boxId).box
    const assignedBefore = services.repository.getSnapshot().series[0].inventory.reduce((sum, entry) => sum + entry.assigned, 0)
    services.auth.oneClick('admin')
    services.payments.refund(payment.id, payment.amountSen, 'Test full refund retaining allocation', 'req-refund-once')
    const snapshot = services.repository.getSnapshot()
    expect(snapshot.orders.find((entry) => entry.id === order.id)?.status).toBe('refunded')
    expect(snapshot.boxes.find((box) => box.id === boxId)?.prizeId).toBe(opened.prizeId)
    expect(snapshot.series[0].inventory.reduce((sum, entry) => sum + entry.assigned, 0)).toBe(assignedBefore)
    const duplicate = services.payments.refund(
      payment.id,
      payment.amountSen,
      'Test full refund retaining allocation',
      'req-refund-once',
    )
    expect(duplicate.changed).toBe(false)
    services.auth.oneClick('customer')
    const retainedReveal = services.openBox(boxId)
    expect(retainedReveal.changed).toBe(false)
    expect(retainedReveal.box.prizeId).toBe(opened.prizeId)
    expect(retainedReveal.box.revealedAt).toBe(opened.revealedAt)
  })

  it('full refund atomically cancels unshipped fulfilment, holds unopened boxes and blocks reveal', () => {
    const order = checkout(services)
    const payment = services.payments.createAttempt(order.id)
    services.payments.act(payment.id, 'approve')
    const shipmentId = services.repository.getSnapshot().shipments.find((shipment) => shipment.orderId === order.id)!.id
    services.auth.oneClick('admin')
    services.payments.refund(payment.id, payment.amountSen, 'Confirmed complete refund and fulfilment stop', 'req-full-stop')
    let snapshot = services.repository.getSnapshot()
    expect(snapshot.orders.find((entry) => entry.id === order.id)?.status).toBe('refunded')
    expect(snapshot.shipments.find((entry) => entry.id === shipmentId)?.status).toBe('cancelled')
    expect(snapshot.boxes.find((box) => box.id === order.boxIds[0])?.status).toBe('on_hold')
    expect(() => services.fulfilment.advance(shipmentId, 'unfulfilled', 'Attempted invalid restart')).toThrow(/stopped|financial hold/i)
    services.auth.oneClick('customer')
    expect(() => services.openBox(order.boxIds[0])).toThrow(/financial hold/i)
    snapshot = services.repository.getSnapshot()
    expect(snapshot.boxes.find((box) => box.id === order.boxIds[0])?.revealedAt).toBeUndefined()
  })

  it('restores a dispute-stopped single picking shipment as confirmed when it resumes unfulfilled', () => {
    services.auth.oneClick('admin')
    services.fulfilment.advance('shp-unopened', 'picking', 'Confirmed picking before dispute')
    let snapshot = services.repository.getSnapshot()
    expect(snapshot.orders.find((entry) => entry.id === 'ord-unopened')?.status).toBe('processing')
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-unopened')?.status).toBe('picking')

    services.payments.dispute(
      'pay-unopened',
      'Confirmed fictional dispute stopping picking',
      'evt-single-picking-dispute',
    )
    snapshot = services.repository.getSnapshot()
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-unopened')?.status).toBe('cancelled')

    const resolved = services.payments.resolveDispute(
      'pay-unopened',
      'merchant_won',
      'Confirmed merchant win restarting fulfilment',
      'evt-single-picking-dispute-win',
    )
    snapshot = services.repository.getSnapshot()
    expect(resolved.changed).toBe(true)
    expect(snapshot.payments.find((entry) => entry.id === 'pay-unopened')?.status).toBe('succeeded')
    expect(snapshot.orders.find((entry) => entry.id === 'ord-unopened')?.status).toBe('confirmed')
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-unopened')?.status).toBe('unfulfilled')
    expect(snapshot.boxes.find((entry) => entry.id === 'box-unopened-01')?.status).toBe('paid_unopened')
    expect(() => validateDemoState(snapshot)).not.toThrow()
  })

  it('records a delivered carrier outcome during dispute without reopening the financial hold', () => {
    services.repository.update((state) => {
      state.boxes.find((box) => box.id === 'box-shipped-01')!.revealedAt = undefined
    })
    const order = services.repository.getSnapshot().orders.find((entry) => entry.id === 'ord-shipped')!
    const payment = services.repository.getSnapshot().payments.find((entry) => entry.id === 'pay-shipped')!
    const shipment = services.repository.getSnapshot().shipments.find((entry) => entry.id === 'shp-shipped')!
    services.auth.oneClick('admin')
    services.payments.dispute(payment.id, 'Confirmed fictional payment dispute hold', 'evt-dispute-hold')
    let snapshot = services.repository.getSnapshot()
    expect(snapshot.orders.find((entry) => entry.id === order.id)?.status).toBe('disputed')
    expect(snapshot.shipments.find((entry) => entry.id === shipment.id)?.status).toBe('shipped')
    expect(snapshot.boxes.find((box) => box.id === order.boxIds[0])?.status).toBe('on_hold')
    services.fulfilment.advance(shipment.id, 'delivered', 'Carrier delivered while dispute remained open')
    snapshot = services.repository.getSnapshot()
    expect(snapshot.orders.find((entry) => entry.id === order.id)?.status).toBe('disputed')
    expect(snapshot.shipments.find((entry) => entry.id === shipment.id)?.status).toBe('delivered')
    expect(snapshot.boxes.find((box) => box.id === order.boxIds[0])?.status).toBe('on_hold')
    services.payments.resolveDispute(payment.id, 'merchant_won', 'Confirmed dispute resolution restoring fulfilment', 'evt-dispute-resolved')
    snapshot = services.repository.getSnapshot()
    expect(snapshot.orders.find((entry) => entry.id === order.id)?.status).toBe('fulfilled')
    expect(snapshot.boxes.find((box) => box.id === order.boxIds[0])?.status).toBe('fulfilled')
    services.auth.oneClick('customer')
    expect(services.openBox(order.boxIds[0]).changed).toBe(true)
  })

  it.each(['delivered', 'failed_delivery', 'lost', 'returned'] as const)(
    'records legal %s carrier evidence after refund while keeping finance stopped and sealed boxes held',
    (outcome) => {
      const held = new AppServices(new MemoryStorage(), () => FIXED_NOW)
      held.repository.update((state) => {
        state.boxes.find((box) => box.id === 'box-shipped-01')!.revealedAt = undefined
      })
      held.auth.oneClick('admin')
      const payment = held.repository.getSnapshot().payments.find((entry) => entry.id === 'pay-shipped')!
      held.payments.refund(
        payment.id,
        payment.amountSen,
        `Confirmed refund before ${outcome} carrier evidence`,
        `req-refund-carrier-${outcome}`,
      )
      held.fulfilment.advance(
        'shp-shipped',
        outcome,
        `Carrier recorded ${outcome} after financial stop`,
      )
      const snapshot = held.repository.getSnapshot()
      expect(snapshot.orders.find((entry) => entry.id === 'ord-shipped')?.status).toBe('refunded')
      expect(snapshot.payments.find((entry) => entry.id === 'pay-shipped')?.status).toBe('refunded')
      expect(snapshot.shipments.find((entry) => entry.id === 'shp-shipped')?.status).toBe(outcome)
      expect(snapshot.boxes.find((entry) => entry.id === 'box-shipped-01')?.status).toBe('on_hold')
      expect(() => held.fulfilment.setTracking(
        'shp-shipped',
        'Demo Changed Carrier',
        'DEMO-CHANGED-AFTER-HOLD',
        'Attempt tracking edit after hold',
      )).toThrow(/financial hold/i)
      expect(() => validateDemoState(snapshot)).not.toThrow()
    },
  )

  it.each(['refund', 'dispute'] as const)(
    'allows failed-delivery reship and delivery evidence during a %s hold without reopening finance or boxes',
    (hold) => {
      const held = new AppServices(new MemoryStorage(), () => FIXED_NOW)
      held.repository.update((state) => {
        state.boxes.find((box) => box.id === 'box-failed-01')!.revealedAt = undefined
      })
      held.auth.oneClick('admin')
      const payment = held.repository.getSnapshot().payments.find((entry) => entry.id === 'pay-failed')!
      if (hold === 'refund') {
        held.payments.refund(
          payment.id,
          payment.amountSen,
          'Confirmed refund before failed-delivery carrier retry',
          'req-refund-failed-delivery-retry',
        )
      } else {
        held.payments.dispute(
          payment.id,
          'Confirmed dispute before failed-delivery carrier retry',
          'evt-dispute-failed-delivery-retry',
        )
      }

      const stopped = structuredClone(held.repository.getSnapshot())
      const stoppedOrder = stopped.orders.find((entry) => entry.id === 'ord-failed')!
      const stoppedPayment = stopped.payments.find((entry) => entry.id === payment.id)!
      const stoppedBoxes = stopped.boxes.filter((box) => stoppedOrder.boxIds.includes(box.id))

      held.fulfilment.advance(
        'shp-failed',
        'shipped',
        'Carrier retried the failed fictional delivery',
      )
      held.fulfilment.advance(
        'shp-failed',
        'delivered',
        'Carrier completed the retried fictional delivery',
      )

      const snapshot = held.repository.getSnapshot()
      expect(snapshot.shipments.find((entry) => entry.id === 'shp-failed')?.timeline.slice(-3).map((entry) => entry.status)).toEqual([
        'failed_delivery',
        'shipped',
        'delivered',
      ])
      expect(snapshot.orders.find((entry) => entry.id === stoppedOrder.id)).toEqual(stoppedOrder)
      expect(snapshot.payments.find((entry) => entry.id === stoppedPayment.id)).toEqual(stoppedPayment)
      expect(snapshot.boxes.filter((box) => stoppedOrder.boxIds.includes(box.id))).toEqual(stoppedBoxes)
      expect(stoppedBoxes.every((box) => box.status === 'on_hold')).toBe(true)
      expect(() => validateDemoState(snapshot)).not.toThrow()
    },
  )

  it('blocks non-carrier hold paths, cancelled restarts, tracking edits, and illegal delivered outcomes', () => {
    const held = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    held.repository.update((state) => {
      state.boxes.find((box) => box.id === 'box-failed-01')!.revealedAt = undefined
    })
    held.auth.oneClick('admin')
    const payment = held.repository.getSnapshot().payments.find((entry) => entry.id === 'pay-failed')!
    held.payments.refund(
      payment.id,
      payment.amountSen,
      'Confirmed refund before illegal carrier path checks',
      'req-refund-illegal-carrier-paths',
    )
    const before = structuredClone(held.repository.getSnapshot())

    expect(() => held.fulfilment.advance(
      'shp-failed',
      'delivered',
      'Attempted failed delivery jump',
    )).toThrow(/graph-legal physical carrier evidence/i)
    expect(() => held.fulfilment.advance(
      'shp-refunded',
      'unfulfilled',
      'Attempted cancelled restart',
    )).toThrow(/tracking, restarts, fulfilment progress/i)
    expect(() => held.fulfilment.setTracking(
      'shp-failed',
      'Demo Changed Carrier',
      'DEMO-HELD-TRACKING-CHANGE',
      'Attempted tracking change',
    )).toThrow(/financial hold/i)
    expect(held.repository.getSnapshot()).toEqual(before)

    held.fulfilment.advance('shp-failed', 'shipped', 'Carrier retried the held delivery')
    held.fulfilment.advance('shp-failed', 'delivered', 'Carrier delivered the held retry')
    const delivered = structuredClone(held.repository.getSnapshot())
    expect(() => held.fulfilment.advance(
      'shp-failed',
      'lost',
      'Attempted impossible post-delivery loss',
    )).toThrow(/graph-legal physical carrier evidence/i)
    expect(held.repository.getSnapshot()).toEqual(delivered)
  })

  it('does not treat digital fulfilment as physical carrier evidence during a financial hold', () => {
    const held = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    held.auth.oneClick('admin')
    for (const status of ['picking', 'packed', 'label_created', 'shipped'] as const) {
      held.fulfilment.advance('shp-digital', status, `Confirmed digital hold setup ${status}`)
    }
    held.payments.dispute(
      'pay-processing',
      'Confirmed dispute before digital carrier evidence attempt',
      'evt-dispute-digital-carrier-evidence',
    )
    const before = structuredClone(held.repository.getSnapshot())
    expect(() => held.fulfilment.advance(
      'shp-digital',
      'delivered',
      'Attempted digital carrier delivery evidence',
    )).toThrow(/physical carrier evidence/i)
    expect(held.repository.getSnapshot()).toEqual(before)
  })

  it('resumes only shipments stopped by that dispute and keeps earlier cancellations held', () => {
    services.auth.oneClick('admin')
    services.fulfilment.advance('shp-digital', 'cancelled', 'Cancelled earlier for an unrelated fulfilment reason')
    services.payments.dispute(
      'pay-processing',
      'Confirmed fictional dispute while another shipment was already cancelled',
      'evt-selective-dispute-hold',
    )
    let snapshot = services.repository.getSnapshot()
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-processing')?.timeline.at(-1)?.financialHold).toBe('disputed')
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-digital')?.timeline.at(-1)?.financialHold).toBeUndefined()

    services.payments.resolveDispute(
      'pay-processing',
      'merchant_won',
      'Confirmed resolution only restarts dispute-stopped work',
      'evt-selective-dispute-resolved',
    )
    snapshot = services.repository.getSnapshot()
    expect(snapshot.orders.find((entry) => entry.id === 'ord-processing')?.status).toBe('processing')
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-processing')?.status).toBe('unfulfilled')
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-digital')?.status).toBe('cancelled')
    expect(snapshot.boxes.find((entry) => entry.id === 'box-processing-02')?.status).toBe('on_hold')
  })

  it('preserves an earlier partial refund when a later dispute is resolved for the merchant', () => {
    services.auth.oneClick('admin')
    const payment = services.repository.getSnapshot().payments.find((entry) => entry.id === 'pay-unopened')!
    services.payments.refund(payment.id, 1000, 'Confirmed RM10 partial refund before dispute', 'req-partial-before-dispute')
    services.payments.dispute(payment.id, 'Confirmed later fictional payment dispute', 'evt-partial-dispute')
    services.payments.resolveDispute(
      payment.id,
      'merchant_won',
      'Confirmed merchant win while preserving earlier partial refund',
      'evt-partial-dispute-win',
    )
    const snapshot = services.repository.getSnapshot()
    expect(snapshot.payments.find((entry) => entry.id === payment.id)).toMatchObject({
      status: 'partially_refunded',
      refundedSen: 1000,
    })
    expect(snapshot.orders.find((entry) => entry.id === 'ord-unopened')?.status).toBe('confirmed')
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-unopened')?.status).toBe('unfulfilled')
  })

  it('keeps a partial refund valid while fulfilment advances to shipped', () => {
    services.auth.oneClick('admin')
    services.payments.refund(
      'pay-unopened',
      1000,
      'Confirmed partial refund before shipping',
      'req-partial-before-shipping',
    )
    for (const status of ['picking', 'packed', 'label_created', 'shipped'] as const) {
      services.fulfilment.advance('shp-unopened', status, `Confirmed partial-refund ${status}`)
    }

    const snapshot = services.repository.getSnapshot()
    expect(snapshot.payments.find((entry) => entry.id === 'pay-unopened')).toMatchObject({
      status: 'partially_refunded',
      refundedSen: 1000,
    })
    expect(snapshot.orders.find((entry) => entry.id === 'ord-unopened')?.status).toBe('processing')
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-unopened')?.status).toBe('shipped')
    expect(() => validateDemoState(snapshot)).not.toThrow()
  })

  it('continues fulfilment after an explicit dispute merchant win', () => {
    services.auth.oneClick('admin')
    services.payments.dispute(
      'pay-unopened',
      'Confirmed dispute before later merchant win',
      'evt-dispute-before-fulfilment',
    )
    services.payments.resolveDispute(
      'pay-unopened',
      'merchant_won',
      'Confirmed merchant win before fulfilment',
      'evt-dispute-win-before-fulfilment',
    )
    for (const status of ['picking', 'packed', 'label_created', 'shipped', 'delivered'] as const) {
      services.fulfilment.advance('shp-unopened', status, `Confirmed post-dispute ${status}`)
    }

    const snapshot = services.repository.getSnapshot()
    expect(snapshot.payments.find((entry) => entry.id === 'pay-unopened')?.status).toBe('succeeded')
    expect(snapshot.orders.find((entry) => entry.id === 'ord-unopened')?.status).toBe('fulfilled')
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-unopened')?.status).toBe('delivered')
    expect(() => validateDemoState(snapshot)).not.toThrow()
  })

  it('allows guarded post-close dispute and refund while preserving delivered history', () => {
    services.auth.oneClick('admin')
    services.admin.changeOrderStatus('ord-delivered', 'closed', 'Confirmed completion before late finance event')
    services.payments.dispute('pay-delivered', 'Confirmed late fictional dispute after closure', 'evt-closed-dispute')
    services.payments.resolveDispute(
      'pay-delivered',
      'merchant_won',
      'Confirmed merchant win restoring the prior closed state',
      'evt-closed-dispute-win',
    )
    let snapshot = services.repository.getSnapshot()
    expect(snapshot.orders.find((entry) => entry.id === 'ord-delivered')?.status).toBe('closed')
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-delivered')?.status).toBe('delivered')

    const payment = snapshot.payments.find((entry) => entry.id === 'pay-delivered')!
    services.payments.refund(
      payment.id,
      payment.amountSen,
      'Confirmed full refund after closed order review',
      'req-closed-full-refund',
    )
    snapshot = services.repository.getSnapshot()
    expect(snapshot.orders.find((entry) => entry.id === 'ord-delivered')?.status).toBe('refunded')
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-delivered')?.status).toBe('delivered')
    expect(snapshot.boxes.find((entry) => entry.id === 'box-delivered-01')?.revealedAt).toBeTruthy()
  })

  it('manual order transitions cannot bypass payment, box, reservation or shipment services', () => {
    const order = checkout(services)
    const payment = services.payments.createAttempt(order.id)
    services.payments.act(payment.id, 'approve')
    services.auth.oneClick('admin')
    expect(() => services.admin.changeOrderStatus(order.id, 'processing', 'Manual processing override attempt')).toThrow(/services own/i)
    expect(() => services.admin.changeOrderStatus(order.id, 'cancelled', 'Manual paid cancellation attempt')).toThrow(/services own/i)
    expect(services.repository.getSnapshot().orders.find((entry) => entry.id === order.id)?.status).toBe('confirmed')
  })

  it('validates claim eligibility, returns duplicate open claims idempotently and uses unique deterministic IDs', () => {
    services.auth.oneClick('customer')
    expect(() => services.claims.submit({
      orderId: 'ord-shipped',
      kind: 'damage',
      shipmentId: 'shp-shipped',
      note: 'DEMO shipped box damage claim',
    })).toThrow(/delivered shipment/i)
    const damage = services.claims.submit({
      orderId: 'ord-delivered',
      kind: 'damage',
      shipmentId: 'shp-delivered',
      note: 'DEMO delivered carton is damaged',
    })
    const duplicate = services.claims.submit({
      orderId: 'ord-delivered',
      kind: 'damage',
      shipmentId: 'shp-delivered',
      note: 'DEMO duplicate delivered carton report',
    })
    const valueFloor = services.claims.submit({
      orderId: 'ord-delivered',
      kind: 'value_floor',
      boxId: 'box-delivered-01',
      note: 'DEMO value-floor evidence review',
    })
    const nonDelivery = services.claims.submit({
      orderId: 'ord-shipped',
      kind: 'non_delivery',
      shipmentId: 'shp-shipped',
      note: 'DEMO shipment is overdue and missing',
    })
    expect(damage.changed).toBe(true)
    expect(duplicate).toMatchObject({ changed: false, data: { id: damage.data.id } })
    expect(new Set([damage.data.id, valueFloor.data.id, nonDelivery.data.id]).size).toBe(3)
    expect(damage.data.id).toMatch(/^clm-[a-z0-9]{8}-[a-z0-9]{7}$/)
    expect(damage.data.requestId).toMatch(/^req-claim-/)
  })

  it('stores sealed delivery claims at order level without allowing exact shipment or sealed value-floor links', () => {
    const sealed = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    sealed.repository.update((state) => {
      state.boxes.find((box) => box.id === 'box-shipped-01')!.revealedAt = undefined
      state.boxes.find((box) => box.id === 'box-delivered-01')!.revealedAt = undefined
    })
    sealed.auth.oneClick('customer')
    expect(() => sealed.claims.submit({
      orderId: 'ord-shipped',
      kind: 'non_delivery',
      shipmentId: 'shp-shipped',
      note: 'DEMO sealed exact shipment attempt',
    })).toThrow(/neutral order-level delivery evidence/i)
    const nonDelivery = sealed.claims.submit({
      orderId: 'ord-shipped',
      kind: 'non_delivery',
      orderLevelDelivery: true,
      note: 'DEMO sealed shipment is overdue and missing',
    })
    const damage = sealed.claims.submit({
      orderId: 'ord-delivered',
      kind: 'damage',
      orderLevelDelivery: true,
      note: 'DEMO sealed delivered carton is damaged',
    })
    expect(nonDelivery.changed).toBe(true)
    expect(damage.changed).toBe(true)
    expect(nonDelivery.data).not.toHaveProperty('shipmentCandidateIds')
    expect(damage.data).not.toHaveProperty('shipmentCandidateIds')
    expect(sealed.repository.getSnapshot().claims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'non_delivery',
        shipmentId: undefined,
        shipmentCandidateIds: ['shp-shipped'],
      }),
      expect.objectContaining({
        kind: 'damage',
        shipmentId: undefined,
        shipmentCandidateIds: ['shp-delivered'],
      }),
    ]))
    expect(() => sealed.claims.submit({
      orderId: 'ord-delivered',
      kind: 'value_floor',
      boxId: 'box-delivered-01',
      note: 'DEMO sealed value-floor attempt',
    })).toThrow(/revealed box/i)
    expect(() => validateDemoState(sealed.repository.getSnapshot())).not.toThrow()
  })

  it('rejects a customer return after delivery as non-delivery evidence without changing state', () => {
    services.auth.oneClick('admin')
    services.fulfilment.advance(
      'shp-delivered',
      'returned',
      'Confirmed physical return for non-delivery evidence',
    )
    services.auth.oneClick('customer')
    const before = structuredClone(services.repository.getSnapshot())

    expect(() => services.claims.submit({
      orderId: 'ord-delivered',
      kind: 'non_delivery',
      shipmentId: 'shp-delivered',
      note: 'DEMO customer return after confirmed delivery',
    })).toThrow(/customer return after delivery is not non-delivery evidence/i)
    expect(services.repository.getSnapshot()).toEqual(before)
  })

  it('accepts returned-to-sender physical evidence when no delivered event exists', () => {
    services.auth.oneClick('admin')
    services.fulfilment.advance(
      'shp-failed',
      'returned',
      'Confirmed returned-to-sender non-delivery evidence',
    )
    services.auth.oneClick('customer')
    const result = services.claims.submit({
      orderId: 'ord-failed',
      kind: 'non_delivery',
      shipmentId: 'shp-failed',
      note: 'DEMO returned-to-sender parcel never reached the customer',
    })
    expect(result).toMatchObject({
      changed: true,
      data: { kind: 'non_delivery', shipmentId: 'shp-failed' },
    })
    expect(() => validateDemoState(services.repository.getSnapshot())).not.toThrow()
  })

  it('does not treat a returned digital fulfilment as physical non-delivery evidence', () => {
    services.auth.oneClick('customer')
    services.openBox('box-processing-02')
    services.auth.oneClick('admin')
    for (const status of ['picking', 'packed', 'label_created', 'shipped', 'returned'] as const) {
      services.fulfilment.advance(
        'shp-digital',
        status,
        `Confirmed digital non-delivery guard setup ${status}`,
      )
    }
    services.auth.oneClick('customer')
    const before = structuredClone(services.repository.getSnapshot())

    expect(() => services.claims.submit({
      orderId: 'ord-processing',
      kind: 'non_delivery',
      shipmentId: 'shp-digital',
      note: 'DEMO digital fulfilment cannot be a physical non-delivery',
    })).toThrow(/digital fulfilment cannot have physical non-delivery/i)
    expect(services.repository.getSnapshot()).toEqual(before)
  })

  it('stores every eligible sealed physical shipment canonically and keeps duplicate creation harmless', () => {
    const multi = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    makeProcessingOrderTwoPhysicalShipments(multi)
    multi.auth.oneClick('admin')
    for (const [shipmentId, path] of [
      ['shp-processing', ['packed', 'label_created', 'shipped', 'failed_delivery']],
      ['shp-digital', ['picking', 'packed', 'label_created', 'shipped', 'failed_delivery']],
    ] as const) {
      for (const status of path) {
        multi.fulfilment.advance(shipmentId, status, `Confirmed canonical claim setup ${status}`)
      }
    }
    multi.repository.update((state) => {
      state.boxes.find((box) => box.id === 'box-processing-01')!.revealedAt = undefined
    })
    multi.auth.oneClick('customer')
    expect(() => multi.claims.submit({
      orderId: 'ord-processing',
      kind: 'non_delivery',
      shipmentId: 'shp-processing',
      note: 'DEMO exact sealed parcel targeting attempt',
    })).toThrow(/neutral order-level delivery evidence/i)
    const refundedBefore = multi.repository.getSnapshot().payments.reduce(
      (sum, payment) => sum + payment.refundedSen,
      0,
    )
    const first = multi.claims.submit({
      orderId: 'ord-processing',
      kind: 'non_delivery',
      orderLevelDelivery: true,
      note: 'DEMO neutral multi-shipment non-delivery evidence',
    })
    const beforeDuplicate = structuredClone(multi.repository.getSnapshot())
    const duplicate = multi.claims.submit({
      orderId: 'ord-processing',
      kind: 'non_delivery',
      orderLevelDelivery: true,
      note: 'DEMO repeated neutral multi-shipment submission',
    })
    const snapshot = multi.repository.getSnapshot()

    expect(first.data).not.toHaveProperty('shipmentCandidateIds')
    expect(duplicate).toMatchObject({ changed: false, data: { id: first.data.id } })
    expect(snapshot).toEqual(beforeDuplicate)
    expect(snapshot.claims.at(-1)).toMatchObject({
      shipmentId: undefined,
      shipmentCandidateIds: ['shp-digital', 'shp-processing'],
    })
    expect(snapshot.audits.at(-1)).toMatchObject({
      action: 'claim.submitted',
      after: {
        shipmentId: undefined,
        shipmentCandidateIds: ['shp-digital', 'shp-processing'],
        refundCreated: false,
      },
    })
    expect(multi.claims.listMine().at(-1)).not.toHaveProperty('shipmentCandidateIds')
    expect(snapshot.payments.reduce((sum, payment) => sum + payment.refundedSen, 0)).toBe(refundedBefore)
    expect(() => validateDemoState(snapshot)).not.toThrow()
  })

  it('widens reviewing neutral evidence when a new physical shipment becomes eligible', () => {
    const scenario = neutralClaimWideningScenario()
    expect(scenario.services.repository.getSnapshot().claims.at(-1)?.shipmentCandidateIds)
      .toEqual(['shp-processing'])
    scenario.moveToReviewState('reviewing')
    scenario.makeSecondShipmentEligible()

    const widened = scenario.resubmit()
    const snapshot = scenario.services.repository.getSnapshot()
    const stored = snapshot.claims.find((claim) => claim.id === scenario.first.data.id)!

    expect(widened).toMatchObject({ changed: true, data: { id: scenario.first.data.id } })
    expect(widened.data).not.toHaveProperty('shipmentCandidateIds')
    expect(widened.data).not.toHaveProperty('shipmentCandidateEvidenceAt')
    expect(stored.status).toBe('reviewing')
    expect(stored.shipmentCandidateIds).toEqual(['shp-digital', 'shp-processing'])
    expect(stored.shipmentCandidateEvidenceAt).toEqual({
      'shp-digital': '2026-07-28T08:00:00.000Z',
      'shp-processing': '2026-07-28T06:00:00.000Z',
    })
    expect(stored.history.at(-1)?.note).toBe(
      'Neutral order-level delivery evidence widened after customer resubmission.',
    )
    expect(snapshot.audits.at(-1)).toMatchObject({
      action: 'claim.order_level_evidence_widened',
      targetId: scenario.first.data.id,
      before: { shipmentCandidateIds: ['shp-processing'] },
      after: { shipmentCandidateIds: ['shp-digital', 'shp-processing'] },
    })
    expect(() => validateDemoState(snapshot)).not.toThrow()
  })

  it('returns an approved neutral claim unchanged when later evidence becomes eligible', () => {
    const scenario = neutralClaimWideningScenario()
    scenario.moveToReviewState('approved')
    scenario.makeSecondShipmentEligible()
    const before = structuredClone(scenario.services.repository.getSnapshot())

    const result = scenario.resubmit()

    expect(result).toMatchObject({
      changed: false,
      data: {
        id: scenario.first.data.id,
        status: 'approved',
      },
    })
    expect(result.data).not.toHaveProperty('shipmentCandidateIds')
    expect(result.data).not.toHaveProperty('shipmentCandidateEvidenceAt')
    expect(scenario.services.repository.getSnapshot()).toEqual(before)
  })

  it('returns an existing order-level claim when a later exact shipment scope overlaps it', () => {
    let now = FIXED_NOW
    const scoped = new AppServices(new MemoryStorage(), () => now)
    scoped.repository.update((state) => {
      state.boxes.find((box) => box.id === 'box-shipped-01')!.revealedAt = undefined
    })
    scoped.auth.oneClick('customer')
    const orderLevel = scoped.claims.submit({
      orderId: 'ord-shipped',
      kind: 'non_delivery',
      orderLevelDelivery: true,
      note: 'DEMO sealed order-level overlap evidence',
    })
    now = '2026-07-28T05:00:00.000Z'
    scoped.openBox('box-shipped-01')
    const beforeExactRetry = structuredClone(scoped.repository.getSnapshot())
    const exactRetry = scoped.claims.submit({
      orderId: 'ord-shipped',
      kind: 'non_delivery',
      shipmentId: 'shp-shipped',
      note: 'DEMO later exact scope overlaps the open claim',
    })

    expect(exactRetry).toMatchObject({ changed: false, data: { id: orderLevel.data.id } })
    expect(exactRetry.data).not.toHaveProperty('shipmentCandidateIds')
    expect(scoped.repository.getSnapshot()).toEqual(beforeExactRetry)
    expect(scoped.repository.getSnapshot().claims).toHaveLength(1)
  })

  it('requires explicit DEMO customer notes and rejects likely contact details without changing state', () => {
    services.auth.oneClick('customer')
    const submit = (note: string) => services.claims.submit({
      orderId: 'ord-shipped',
      kind: 'non_delivery',
      shipmentId: 'shp-shipped',
      note,
    })
    for (const [note, message] of [
      ['Fictional shipment is missing', /separate word DEMO/i],
      ['DEMONSTRATION shipment is missing', /separate word DEMO/i],
      ['DEMO contact me at person@example.test', /email address/i],
      ['DEMO call me on +60 12-345 6789', /phone number/i],
    ] as const) {
      const before = structuredClone(services.repository.getSnapshot())
      expect(() => submit(note)).toThrow(message)
      expect(services.repository.getSnapshot()).toEqual(before)
    }

    expect(submit('DEMO shipment is still missing after 3 demo days').changed).toBe(true)
  })

  it('runs protected claim review from acknowledge through resolve without an implicit refund', () => {
    services.auth.oneClick('customer')
    const claim = services.claims.submit({
      orderId: 'ord-shipped',
      kind: 'non_delivery',
      shipmentId: 'shp-shipped',
      note: 'DEMO overdue shipment review request',
    }).data
    const refundsBefore = services.repository.getSnapshot().payments.reduce((sum, payment) => sum + payment.refundedSen, 0)
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Support acknowledged fictional evidence')
    services.claims.review(claim.id, 'approve', 'Support approved fictional eligibility')
    services.claims.review(
      claim.id,
      'resolve',
      'Support resolved fictional replacement path',
      { outcome: 'replacement_authorized', reference: `DEMO-${claim.id.toUpperCase()}` },
    )
    const snapshot = services.repository.getSnapshot()
    const resolved = snapshot.claims.find((entry) => entry.id === claim.id)!
    expect(resolved.status).toBe('resolved')
    expect(resolved).toMatchObject({
      resolutionOutcome: 'replacement_authorized',
      resolutionReference: `DEMO-${claim.id.toUpperCase()}`,
    })
    expect(resolved.history.map((entry) => entry.status)).toEqual(['submitted', 'reviewing', 'approved', 'resolved'])
    expect(snapshot.audits.filter((entry) => entry.targetId === claim.id).map((entry) => entry.action)).toEqual([
      'claim.submitted',
      'claim.acknowledge',
      'claim.approve',
      'claim.resolve',
    ])
    expect(snapshot.payments.reduce((sum, payment) => sum + payment.refundedSen, 0)).toBe(refundsBefore)
    expect(() => services.claims.review(claim.id, 'resolve', 'Duplicate invalid resolution attempt')).toThrow(/cannot resolve/i)
  })

  it('requires structured resolution evidence and verifies refund references on the same order', () => {
    services.auth.oneClick('customer')
    const claim = services.claims.submit({
      orderId: 'ord-delivered',
      kind: 'damage',
      shipmentId: 'shp-delivered',
      note: 'DEMO delivered damage needs structured resolution',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Support acknowledged the fictional damage evidence')
    services.claims.review(claim.id, 'approve', 'Support approved the fictional damage eligibility')
    const beforeMissing = structuredClone(services.repository.getSnapshot())
    expect(() => services.claims.review(
      claim.id,
      'resolve',
      'Resolution text without structured evidence',
    )).toThrow(expect.objectContaining({ code: 'RESOLUTION_EVIDENCE_REQUIRED' }))
    expect(services.repository.getSnapshot()).toEqual(beforeMissing)
    expect(() => services.claims.review(
      claim.id,
      'resolve',
      'Replacement note is sufficiently descriptive',
      { outcome: 'replacement_authorized', reference: 'REAL-REF-001' },
    )).toThrow(/DEMO-/i)

    services.payments.refund(
      'pay-delivered',
      1000,
      'Confirmed audited refund for claim resolution',
      'req-claim-resolution-refund',
    )
    const refundEvent = services.repository.getSnapshot().payments
      .find((payment) => payment.id === 'pay-delivered')!
      .events.find((event) => event.requestId === 'req-claim-resolution-refund')!
    const result = services.claims.review(
      claim.id,
      'resolve',
      'Recorded the separate audited demo refund as resolution evidence',
      { outcome: 'refund_recorded', reference: refundEvent.id },
    )
    expect(result.data).toMatchObject({
      status: 'resolved',
      resolutionOutcome: 'refund_recorded',
      resolutionReference: refundEvent.id,
    })
    expect(services.repository.getSnapshot().audits.find((audit) => audit.eventId === refundEvent.id)).toMatchObject({
      targetId: 'pay-delivered',
      action: 'payment.partially_refunded',
    })
    expect(() => validateDemoState(services.repository.getSnapshot())).not.toThrow()
  })

  it('treats a refund request identity as global across payments', () => {
    services.auth.oneClick('admin')
    const [first, second] = services.repository.getSnapshot().payments.filter((payment) => payment.status === 'succeeded')
    const secondBefore = second.refundedSen
    services.payments.refund(first.id, 1000, 'First global request use', 'req-global-refund-once')
    expect(() => services.payments.refund(
      second.id,
      1000,
      'Replayed on another payment',
      'req-global-refund-once',
    )).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }))
    expect(services.repository.getSnapshot().payments.find((payment) => payment.id === second.id)?.refundedSen).toBe(secondBefore)
  })

  it('sanitizes and bounds refund and admin retry reasons, rejecting short reasons before writes', () => {
    services.auth.oneClick('admin')
    const beforeShortRefund = structuredClone(services.repository.getSnapshot())
    expect(() => services.payments.refund('pay-unopened', 1000, ' <b>x</b> ', 'req-short-refund')).toThrow(/at least 8 characters/i)
    expect(services.repository.getSnapshot()).toEqual(beforeShortRefund)

    const longRefundReason = `<b>Confirmed refund review</b> ${'safe words '.repeat(40)}`
    services.payments.refund('pay-unopened', 1000, longRefundReason, 'req-clean-refund')
    const refundAudit = services.repository.getSnapshot().audits.find((entry) => entry.requestId === 'req-clean-refund')!
    expect(refundAudit.reason).not.toMatch(/[<>]/)
    expect(refundAudit.reason.length).toBeLessThanOrEqual(240)
    expect(refundAudit.reason.length).toBeGreaterThanOrEqual(8)

    const order = checkout(services)
    const failed = services.payments.createAttempt(order.id)
    services.payments.act(failed.id, 'decline')
    services.auth.oneClick('admin')
    const beforeShortRetry = structuredClone(services.repository.getSnapshot())
    expect(() => services.payments.adminRetry(failed.id, 'short')).toThrow(/at least 8 characters/i)
    expect(services.repository.getSnapshot()).toEqual(beforeShortRetry)
    services.payments.adminRetry(failed.id, `<i>Confirmed admin retry</i> ${'review '.repeat(50)}`)
    const retryAudit = services.repository.getSnapshot().audits.find((entry) => entry.action === 'payment.admin_retry' && entry.before && (entry.before as { paymentId?: string }).paymentId === failed.id)!
    expect(retryAudit.reason).not.toMatch(/[<>]/)
    expect(retryAudit.reason.length).toBeLessThanOrEqual(240)
  })

  it('protects prize summaries by authentication, ownership and reveal state', () => {
    expect(() => services.payments.prizeSummary('pay-delivered')).toThrow(/sign in is required/i)
    services.auth.oneClick('customer')
    expect(services.payments.prizeSummary('pay-unopened')).toEqual([])
    expect(services.payments.prizeSummary('pay-delivered').map((prize) => prize?.id)).toEqual(['water'])
    services.repository.update((state) => {
      state.users.push({
        id: 'usr-summary-other',
        name: 'Summary Other Demo',
        email: 'summary@example.test',
        role: 'customer',
        status: 'active',
        createdAt: FIXED_NOW,
      })
      state.sessionUserId = 'usr-summary-other'
    })
    expect(() => services.payments.prizeSummary('pay-delivered')).toThrow(/another fictional user/i)
    services.auth.oneClick('admin')
    expect(services.payments.prizeSummary('pay-unopened').map((prize) => prize?.id)).toEqual(['air-fryer'])
  })

  it('creates split shipments by fulfilment kind', () => {
    const state = structuredClone(services.repository.getSnapshot())
    const order = state.orders.find((entry) => entry.id === 'ord-processing')!
    state.shipments = state.shipments.filter((entry) => entry.orderId !== order.id)
    state.boxes.filter((box) => order.boxIds.includes(box.id)).forEach((box) => { box.shipmentId = undefined })
    services.fulfilment.createForPaidOrder(state, order, FIXED_NOW)
    const kinds = state.shipments.filter((entry) => entry.orderId === order.id).map((entry) => entry.kind)
    expect(kinds.sort()).toEqual(['BULKY', 'DIGITAL'])
  })

  it('enforces admin authorization and prohibits self-suspension', () => {
    services.auth.oneClick('customer')
    expect(() => services.admin.dashboard()).toThrow(/cannot view dashboard/i)
    services.auth.oneClick('admin')
    expect(services.admin.dashboard().users).toBeGreaterThan(1)
    expect(() => services.admin.setUserStatus(DEMO_ADMIN_ID, 'suspended', 'Trying to suspend self')).toThrow(/cannot suspend themselves/i)
  })

  it('allows only a super admin to suspend or reactivate another super admin', () => {
    services.repository.update((state) => {
      state.users.find((user) => user.id === 'usr-support')!.role = 'admin'
      state.users.push(
        {
          id: 'usr-super-peer',
          name: 'Peer Super Admin',
          email: 'peer.super@demo.local',
          role: 'super_admin',
          status: 'active',
          createdAt: FIXED_NOW,
        },
        {
          id: 'usr-super-suspended',
          name: 'Suspended Super Admin',
          email: 'suspended.super@demo.local',
          role: 'super_admin',
          status: 'suspended',
          createdAt: FIXED_NOW,
        },
      )
      state.sessionUserId = 'usr-support'
    })
    const beforeBlockedChanges = structuredClone(services.repository.getSnapshot())

    expect(() => services.admin.setUserStatus(
      'usr-super-peer',
      'suspended',
      'Ordinary admin attempted suspension',
    )).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(() => services.admin.setUserStatus(
      'usr-super-suspended',
      'active',
      'Ordinary admin attempted reactivation',
    )).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(services.repository.getSnapshot()).toEqual(beforeBlockedChanges)

    services.auth.oneClick('admin')
    expect(services.admin.setUserStatus(
      'usr-super-peer',
      'suspended',
      'Super admin confirmed peer suspension',
    ).status).toBe('suspended')
    expect(services.admin.setUserStatus(
      'usr-super-peer',
      'active',
      'Super admin confirmed peer reactivation',
    ).status).toBe('active')
  })

  it('counts captured disputes and keeps paid volume gross through partial and full refunds', () => {
    services.auth.oneClick('admin')
    const capturedGrossSen = services.repository.getSnapshot().payments
      .filter((payment) => payment.events.some((event) => event.type === 'succeeded' && !event.ignoredReason))
      .reduce((sum, payment) => sum + payment.amountSen, 0)

    expect(services.admin.dashboard().paidVolumeSen).toBe(capturedGrossSen)
    services.payments.dispute(
      'pay-unopened',
      'Confirmed captured dispute volume regression',
      'evt-paid-volume-dispute',
    )
    expect(services.repository.getSnapshot().payments.find((payment) => payment.id === 'pay-unopened')?.status).toBe('disputed')
    expect(services.admin.dashboard().paidVolumeSen).toBe(capturedGrossSen)

    const refundable = services.repository.getSnapshot().payments.find((payment) => payment.id === 'pay-delivered')!
    services.payments.refund(
      refundable.id,
      1000,
      'Confirmed partial refund gross-volume regression',
      'req-paid-volume-partial',
    )
    expect(services.admin.dashboard().paidVolumeSen).toBe(capturedGrossSen)
    services.payments.refund(
      refundable.id,
      refundable.amountSen - 1000,
      'Confirmed full refund gross-volume regression',
      'req-paid-volume-full',
    )
    expect(services.admin.dashboard().paidVolumeSen).toBe(capturedGrossSen)
  })

  it('counts only submitted, reviewing, and approved claims as open dashboard work', () => {
    services.auth.oneClick('customer')
    const rejected = services.claims.submit({
      orderId: 'ord-delivered',
      kind: 'damage',
      shipmentId: 'shp-delivered',
      note: 'DEMO rejected open-claim metric check',
    }).data
    const resolved = services.claims.submit({
      orderId: 'ord-delivered',
      kind: 'value_floor',
      boxId: 'box-delivered-01',
      note: 'DEMO resolved open-claim metric check',
    }).data
    services.auth.oneClick('admin')
    expect(services.admin.dashboard().openClaims).toBe(2)

    services.claims.review(rejected.id, 'reject', 'Confirmed rejected claim is terminal')
    expect(services.admin.dashboard().openClaims).toBe(1)
    services.claims.review(resolved.id, 'acknowledge', 'Confirmed resolved metric acknowledgement')
    services.claims.review(resolved.id, 'approve', 'Confirmed resolved metric approval')
    expect(services.admin.dashboard().openClaims).toBe(1)
    services.claims.review(
      resolved.id,
      'resolve',
      'Confirmed resolved metric fictional replacement',
      { outcome: 'replacement_authorized', reference: `DEMO-${resolved.id.toUpperCase()}` },
    )
    expect(services.admin.dashboard().openClaims).toBe(0)
    expect(() => services.admin.changeOrderStatus(
      'ord-delivered',
      'closed',
      'Confirmed closure after terminal claim outcomes',
    )).not.toThrow()
  })

  it('guards fictional carrier/tracking entry and audits the confirmed change', () => {
    services.auth.oneClick('admin')
    const shipment = services.repository.getSnapshot().shipments.find((entry) => entry.id === 'shp-processing')!
    services.fulfilment.setTracking(shipment.id, 'Demo North Freight', 'DEMO-TRACK-9001', 'Confirmed tracking test update')
    const snapshot = services.repository.getSnapshot()
    expect(snapshot.shipments.find((entry) => entry.id === shipment.id)).toMatchObject({
      carrier: 'Demo North Freight',
      trackingNumber: 'DEMO-TRACK-9001',
    })
    expect(snapshot.audits.at(-1)).toMatchObject({
      action: 'shipment.tracking_updated',
      targetId: shipment.id,
      before: { carrier: 'Demo Bulky Freight' },
      after: { trackingNumber: 'DEMO-TRACK-9001' },
    })
    expect(() => services.fulfilment.setTracking('shp-digital', 'Real Courier', 'REAL-1234', 'Unsafe tracking test')).toThrow(/clearly fictional/i)
    expect(() => services.fulfilment.setTracking('shp-shipped', 'Demo Express', 'DEMO-LOCKED-1', 'Locked tracking test')).toThrow(/lock after shipment/i)
  })

  it('keeps published inventory immutable while allowing a floor-safe draft edit', () => {
    services.auth.oneClick('admin')
    const publishedBefore = structuredClone(services.repository.getSnapshot().series[0])
    services.admin.copyPublishedToDraft()
    const originalShortName = services.repository.getSnapshot().series
      .find((entry) => entry.status === 'draft')!.draftPrizes![0].shortName
    services.admin.editDraftPrize('maggi', 'Draft Maggi Demo', 14_000)
    const snapshot = services.repository.getSnapshot()
    expect(snapshot.series.find((entry) => entry.status === 'published')).toEqual(publishedBefore)
    expect(snapshot.series.find((entry) => entry.status === 'draft')?.draftPrizes?.[0].name).toBe('Draft Maggi Demo')
    expect(snapshot.series.find((entry) => entry.status === 'draft')?.draftPrizes?.[0].shortName)
      .toBe(originalShortName)
    expect(() => services.admin.editDraftPrize('maggi', 'Bad floor', 9_999)).toThrow(/RM100 floor/i)

    for (const name of ['', '   ', '\n\t']) {
      const before = structuredClone(services.repository.getSnapshot())
      expect(() => services.admin.editDraftPrize('maggi', name, 14_000)).toThrow(
        /name cannot be blank/i,
      )
      expect(services.repository.getSnapshot()).toEqual(before)
    }
  })

  it('allocates and fulfils from the frozen published snapshot after defaults change', () => {
    const defaults = structuredClone(PRIZES)
    try {
      PRIZES.forEach((prize) => {
        prize.allocation = 0
        prize.fulfilment = 'DIGITAL'
        prize.name = `Changed default ${prize.id}`
      })
      const order = checkout(services)
      const payment = services.payments.createAttempt(order.id)
      services.payments.act(payment.id, 'approve')
      const snapshot = services.repository.getSnapshot()
      const box = snapshot.boxes.find((entry) => entry.id === order.boxIds[0])!
      const frozen = snapshot.series[0].publishedPrizes!.find((prize) => prize.id === box.prizeId)!
      const shipment = snapshot.shipments.find((entry) => entry.orderId === order.id)!
      expect(frozen.name).not.toMatch(/Changed default/)
      expect(frozen.allocation).toBeGreaterThan(0)
      expect(shipment.kind).toBe(frozen.fulfilment)
    } finally {
      PRIZES.splice(0, PRIZES.length, ...defaults)
    }
  })

  it('enforces the complete role-to-section permission matrix in services', () => {
    const sections: AdminSection[] = ['overview', 'users', 'orders', 'payments', 'inventory', 'fulfilment', 'claims', 'audit']
    const expected: Record<Role, AdminSection[]> = {
      customer: [],
      support: ['users', 'claims'],
      fulfilment: ['fulfilment'],
      finance: ['payments'],
      catalog: ['inventory'],
      admin: sections,
      super_admin: sections,
    }
    const userForRole: Record<Role, string> = {
      customer: 'usr-demo-customer',
      support: 'usr-support',
      fulfilment: 'usr-fulfilment',
      finance: 'usr-finance',
      catalog: 'usr-catalog',
      admin: 'usr-demo-admin',
      super_admin: 'usr-demo-admin',
    }
    const roles: Role[] = ['customer', 'support', 'fulfilment', 'finance', 'catalog', 'admin', 'super_admin']
    for (const role of roles) {
      services.repository.update((state) => {
        const user = state.users.find((entry) => entry.id === userForRole[role])!
        user.role = role
        state.sessionUserId = user.id
      })
      for (const section of sections) {
        if (expected[role].includes(section)) expect(() => services.admin.viewForRole(section)).not.toThrow()
        else expect(() => services.admin.viewForRole(section)).toThrow()
      }
      if (!['admin', 'super_admin'].includes(role)) expect(() => services.admin.snapshot()).toThrow()
    }
  })

  it('blocks lower staff from invoking another department service action', () => {
    const pendingOrder = checkout(services)
    const switchTo = (userId: string) => services.repository.update((state) => { state.sessionUserId = userId })

    switchTo('usr-support')
    expect(() => services.admin.changeOrderStatus(
      pendingOrder.id,
      'cancelled',
      'Support attempted a combined order action',
    )).toThrow(/cannot change order state/i)

    switchTo('usr-fulfilment')
    expect(() => services.payments.refund(
      'pay-unopened',
      1000,
      'Fulfilment attempted finance action',
      'req-wrong-department-refund',
    )).toThrow(/cannot refund/i)

    switchTo('usr-finance')
    expect(() => services.fulfilment.advance(
      'shp-unopened',
      'picking',
      'Finance attempted fulfilment action',
    )).toThrow(/cannot change fulfilment/i)

    switchTo('usr-catalog')
    expect(() => services.claims.queue()).toThrow(/cannot view the claims queue/i)
  })

  it('keeps audit append-only for sensitive actions', () => {
    services.auth.oneClick('admin')
    const before = services.repository.getSnapshot().audits.length
    services.admin.setUserStatus('usr-suspended', 'active', 'Confirmed test reactivation')
    const audits = services.repository.getSnapshot().audits
    expect(audits).toHaveLength(before + 1)
    expect(audits.at(-1)).toMatchObject({
      actorId: DEMO_ADMIN_ID,
      action: 'user.reactivated',
      targetId: 'usr-suspended',
    })
  })

  it('uses all exact prize values and allocation names', () => {
    expect(PRIZES.map((prize) => prize.valueSen)).toEqual([13000, 12000, 12000, 15000, 14000, 10000, 29900, 82900, 204900, 399900, 599900])
  })
})
