import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BOX_PRICE_SEN,
  DEMO_ADMIN_ID,
  PRIZES,
  VALUE_FLOOR_SEN,
  type AdminSection,
} from '../src/domain/constants'
import { AUDIT_EVIDENCE_MAX_BYTES } from '../src/domain/auditEvidence'
import { exactOddsLabel } from '../src/domain/odds'
import { sealedCustomerTimeline } from '../src/domain/orderTimeline'
import type { Role } from '../src/domain/types'
import { createDemoState, DEMO_ADDRESS } from '../src/data/fixtures'
import { STORAGE_KEY } from '../src/data/MockRepository'
import { validateDemoState } from '../src/data/StateValidator'
import { AppServices } from '../src/services/AppServices'
import {
  CountingStorage,
  MemoryStorage,
  FIXED_NOW,
  makeProcessingOrderSingleGroupedPhysicalShipment,
  makeProcessingOrderTwoPhysicalShipments,
} from './helpers'

let checkoutSequence = 0
const nextCheckoutRequestId = () => `checkout_f${(++checkoutSequence).toString(16).padStart(31, '0')}`

class FailNextWriteStorage extends MemoryStorage {
  failNextWrite = false

  setItem(key: string, value: string) {
    if (this.failNextWrite) {
      this.failNextWrite = false
      throw new Error('write blocked for atomic service test')
    }
    super.setItem(key, value)
  }
}

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

function approveClaim(services: AppServices, claimId: string) {
  services.auth.oneClick('admin')
  services.claims.review(
    claimId,
    'acknowledge',
    'Confirmed exact remedy test acknowledgement',
  )
  services.claims.review(
    claimId,
    'approve',
    'Confirmed exact remedy test approval',
  )
}

function overlappingCrossKindClaims() {
  const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
  services.auth.oneClick('customer')
  const damage = services.claims.submit({
    orderId: 'ord-delivered',
    kind: 'damage',
    shipmentId: 'shp-delivered',
    note: 'DEMO overlapping delivered physical damage complaint',
  }).data
  const valueFloor = services.claims.submit({
    orderId: 'ord-delivered',
    kind: 'value_floor',
    boxId: 'box-delivered-01',
    note: 'DEMO overlapping revealed value-floor complaint',
  }).data
  return { services, damage, valueFloor }
}

function physicalReplacementScenario(
  status:
    | 'unfulfilled'
    | 'picking'
    | 'packed'
    | 'label_created'
    | 'shipped'
    | 'failed_delivery'
    | 'lost'
    | 'returned'
    | 'cancelled'
    | 'delivered',
  storage: MemoryStorage = new MemoryStorage(),
) {
  const isolated = new AppServices(storage, () => FIXED_NOW)
  isolated.auth.oneClick('customer')
  const claim = isolated.claims.submit({
    orderId: 'ord-failed',
    kind: 'non_delivery',
    shipmentId: 'shp-failed',
    note: `DEMO physical replacement ${status} fallback evidence`,
  }).data
  approveClaim(isolated, claim.id)
  const replacement = isolated.claims.authorizeReplacement(
    claim.id,
    `Confirmed physical replacement ${status} authorization`,
  ).data
  const paths = {
    unfulfilled: [],
    picking: ['picking'],
    packed: ['picking', 'packed'],
    label_created: ['picking', 'packed', 'label_created'],
    shipped: ['picking', 'packed', 'label_created', 'shipped'],
    failed_delivery: ['picking', 'packed', 'label_created', 'shipped', 'failed_delivery'],
    lost: ['picking', 'packed', 'label_created', 'shipped', 'lost'],
    returned: ['picking', 'packed', 'label_created', 'shipped', 'returned'],
    cancelled: ['cancelled'],
    delivered: ['picking', 'packed', 'label_created', 'shipped', 'delivered'],
  } as const
  for (const next of paths[status]) {
    isolated.fulfilment.advance(
      replacement.id,
      next,
      `Confirmed physical replacement ${status} ${next}`,
    )
  }
  return { services: isolated, claim, replacement }
}

function failedDigitalReplacementScenario() {
  const isolated = new AppServices(new MemoryStorage(), () => FIXED_NOW)
  isolated.auth.oneClick('customer')
  isolated.openBox('box-processing-02')
  isolated.auth.oneClick('admin')
  for (const next of ['issued', 'sent', 'failed'] as const) {
    isolated.fulfilment.advance(
      'shp-digital',
      next,
      `Confirmed digital fallback original ${next}`,
    )
  }
  isolated.auth.oneClick('customer')
  const claim = isolated.claims.submit({
    orderId: 'ord-processing',
    kind: 'non_delivery',
    shipmentId: 'shp-digital',
    note: 'DEMO failed digital replacement refund fallback evidence',
  }).data
  approveClaim(isolated, claim.id)
  const replacement = isolated.claims.authorizeReplacement(
    claim.id,
    'Confirmed failed digital replacement authorization',
  ).data
  for (const next of ['issued', 'sent', 'failed'] as const) {
    isolated.fulfilment.advance(
      replacement.id,
      next,
      `Confirmed digital fallback replacement ${next}`,
    )
  }
  return { services: isolated, claim, replacement }
}

function digitalReissueScenario() {
  let now = FIXED_NOW
  const isolated = new AppServices(new MemoryStorage(), () => now)
  isolated.auth.oneClick('customer')
  isolated.openBox('box-processing-02')
  isolated.auth.oneClick('admin')
  isolated.fulfilment.advance(
    'shp-digital',
    'issued',
    'Confirmed overdue digital original issued',
  )
  isolated.fulfilment.advance(
    'shp-digital',
    'sent',
    'Confirmed overdue digital original sent',
  )
  now = '2026-08-01T04:00:00.000Z'
  isolated.auth.oneClick('customer')
  const claim = isolated.claims.submit({
    orderId: 'ord-processing',
    kind: 'non_delivery',
    shipmentId: 'shp-digital',
    note: 'DEMO overdue digital original reissue entitlement evidence',
  }).data
  approveClaim(isolated, claim.id)
  const replacement = isolated.claims.authorizeReplacement(
    claim.id,
    'Confirmed overdue digital reissue authorization',
  ).data
  isolated.fulfilment.advance(
    replacement.id,
    'issued',
    'Confirmed overdue digital reissue issued',
  )
  isolated.fulfilment.advance(
    replacement.id,
    'sent',
    'Confirmed overdue digital reissue sent',
  )
  now = '2026-08-01T05:00:00.000Z'
  return { services: isolated, claim, replacement }
}

const INVALID_AUDIT_EVIDENCE_CASES: Array<[string, () => unknown, string]> = [
  ['supplied undefined', (): unknown => undefined, 'AUDIT_EVIDENCE_INVALID'],
  ['bigint', (): unknown => 1n, 'AUDIT_EVIDENCE_INVALID'],
  ['function', (): unknown => () => 'unsupported', 'AUDIT_EVIDENCE_INVALID'],
  ['symbol', (): unknown => Symbol('unsupported'), 'AUDIT_EVIDENCE_INVALID'],
  ['cycle', (): unknown => {
    const evidence: Record<string, unknown> = {}
    evidence.self = evidence
    return evidence
  }, 'AUDIT_EVIDENCE_INVALID'],
  ['non-finite number', (): unknown => Number.POSITIVE_INFINITY, 'AUDIT_EVIDENCE_INVALID'],
  ['sparse array', (): unknown => Array(2), 'AUDIT_EVIDENCE_INVALID'],
  [
    'custom class',
    (): unknown => new (class Evidence { value = 1 })(),
    'AUDIT_EVIDENCE_INVALID',
  ],
  [
    'dangerous key',
    (): unknown => JSON.parse('{"constructor":"unsafe"}'),
    'AUDIT_EVIDENCE_INVALID',
  ],
  [
    'oversized value',
    (): unknown => 'x'.repeat(AUDIT_EVIDENCE_MAX_BYTES + 1),
    'AUDIT_EVIDENCE_TOO_LARGE',
  ],
]

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
    expect(order.snapshot.valueFloorSen).toBe(VALUE_FLOOR_SEN)
    expect(createDemoState().orders.every((fixtureOrder) =>
      fixtureOrder.snapshot.valueFloorSen === VALUE_FLOOR_SEN)).toBe(true)
    expect(order.boxIds).toHaveLength(2)
    expect(services.repository.getSnapshot().series[0].reservedBoxes).toBe(2)
    expect(services.repository.getSnapshot().cart).toHaveLength(0)
  })

  it('persists the checkout value-floor snapshot as integer sen', () => {
    const storage = new MemoryStorage()
    const isolated = new AppServices(storage, () => FIXED_NOW)
    const order = checkout(isolated)
    const persisted = JSON.parse(storage.getItem(STORAGE_KEY)!) as {
      orders: Array<{ id: string; snapshot: { valueFloorSen: number } }>
    }

    expect(persisted.orders.find((entry) => entry.id === order.id)?.snapshot.valueFloorSen)
      .toBe(VALUE_FLOOR_SEN)
  })

  it('stores deterministic, cloned, JSON-round-trip-safe audit evidence', () => {
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))
    const isolated = new AppServices(storage, () => FIXED_NOW)
    const before = {
      z: 'last',
      nested: { z: 2, a: 1 },
      a: 'first',
    }
    const after: unknown[] = [-0, null, true, { z: 'last', a: 'first' }]

    isolated.repository.update((state) => {
      isolated.audit.append(state, {
        actorId: 'system',
        actorRole: 'super_admin',
        action: 'audit.evidence_test',
        targetType: 'demo_state',
        targetId: 'evidence-test',
        reason: 'Confirmed deterministic fictional evidence',
        at: FIXED_NOW,
        before,
        after,
        requestId: 'audit-evidence-accepted',
      })
    })

    const stored = isolated.repository.getSnapshot().audits.at(-1)!
    before.a = 'changed after append'
    after[3] = { changed: 'outside stored evidence' }

    expect(Object.keys(stored.before as object)).toEqual(['a', 'nested', 'z'])
    expect(Object.keys((stored.before as Record<string, unknown>).nested as object)).toEqual([
      'a',
      'z',
    ])
    expect(stored.before).toEqual({
      a: 'first',
      nested: { a: 1, z: 2 },
      z: 'last',
    })
    expect(stored.after).toEqual([0, null, true, { a: 'first', z: 'last' }])
    expect(JSON.parse(JSON.stringify(stored.before))).toEqual(stored.before)
    expect(JSON.parse(JSON.stringify(stored.after))).toEqual(stored.after)
    expect(storage.writes).toBe(1)
    expect(() => validateDemoState(isolated.repository.getSnapshot())).not.toThrow()
  })

  it.each(INVALID_AUDIT_EVIDENCE_CASES)(
    'rejects %s audit evidence with a fully atomic failed write',
    (
    _label,
    evidence,
    code,
  ) => {
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))
    const isolated = new AppServices(storage, () => FIXED_NOW)
    const published = isolated.repository.getSnapshot()
    const storedBefore = storage.getItem(STORAGE_KEY)
    const listener = vi.fn()
    isolated.repository.subscribe(listener)

    expect(() => isolated.repository.update((state) => {
      state.cart = []
      isolated.audit.append(state, {
        actorId: 'system',
        actorRole: 'super_admin',
        action: 'audit.evidence_rejected',
        targetType: 'demo_state',
        targetId: 'evidence-test',
        reason: 'Confirmed rejected fictional evidence',
        at: FIXED_NOW,
        before: evidence(),
        requestId: 'audit-evidence-rejected',
      })
    })).toThrow(expect.objectContaining({ code }))

    expect(isolated.repository.getSnapshot()).toBe(published)
    expect(isolated.repository.getSnapshot().revision).toBe(published.revision)
    expect(isolated.repository.getSnapshot().audits).toEqual(published.audits)
    expect(storage.getItem(STORAGE_KEY)).toBe(storedBefore)
    expect(storage.writes).toBe(0)
    expect(listener).not.toHaveBeenCalled()
    },
  )

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

  it('audits a stored ignored admin payment event and keeps its exact replay write-free', () => {
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))
    const isolated = new AppServices(storage, () => FIXED_NOW)
    isolated.auth.oneClick('admin')
    const eventId = 'evt-admin-out-of-order-ignored'
    const before = isolated.repository.getSnapshot()
    const writesBefore = storage.writes

    const ignored = isolated.payments.processEvent(
      'pay-unopened',
      eventId,
      'failed',
      'admin_reconcile',
      'Confirmed fictional out-of-order finance event',
    )
    const afterIgnored = isolated.repository.getSnapshot()
    const event = afterIgnored.payments
      .find((payment) => payment.id === 'pay-unopened')!
      .events.find((entry) => entry.id === eventId)
    const audit = afterIgnored.audits.find((entry) => entry.eventId === eventId)

    expect(ignored).toMatchObject({ changed: false })
    expect(event).toMatchObject({
      type: 'failed',
      source: 'admin_reconcile',
      ignoredReason: expect.stringMatching(/out-of-order/i),
    })
    expect(audit).toMatchObject({
      outcome: 'ignored',
      action: 'payment.event_ignored',
      targetType: 'payment',
      targetId: 'pay-unopened',
      requestId: event?.requestId,
      eventId,
      before: { status: 'succeeded' },
      after: {
        status: 'succeeded',
        attemptedStatus: 'failed',
        ignoredReason: event?.ignoredReason,
      },
    })
    expect(afterIgnored.auditCount).toBe(before.auditCount + 1)
    expect(afterIgnored.auditHeadId).toBe(audit?.id)
    expect(afterIgnored.revision).toBe(before.revision + 1)
    expect(storage.writes).toBe(writesBefore + 1)
    expect(() => validateDemoState(afterIgnored)).not.toThrow()

    const writesAfterIgnored = storage.writes
    const revisionAfterIgnored = afterIgnored.revision
    const auditsAfterIgnored = structuredClone(afterIgnored.audits)
    const duplicate = isolated.payments.processEvent(
      'pay-unopened',
      eventId,
      'failed',
      'admin_reconcile',
      'Confirmed fictional out-of-order finance event',
    )

    expect(duplicate).toMatchObject({
      changed: false,
      message: 'Duplicate event ignored safely.',
    })
    expect(isolated.repository.getSnapshot()).toBe(afterIgnored)
    expect(isolated.repository.getSnapshot().revision).toBe(revisionAfterIgnored)
    expect(isolated.repository.getSnapshot().audits).toEqual(auditsAfterIgnored)
    expect(storage.writes).toBe(writesAfterIgnored)
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

  it('blocks failed-original redelivery cycles without rewriting immutable evidence', () => {
    services.auth.oneClick('admin')
    services.fulfilment.advance('shp-shipped', 'failed_delivery', 'Confirmed first fixed-clock delivery exception')
    const beforeBlockedRetry = structuredClone(services.repository.getSnapshot())
    expect(() => services.fulfilment.advance(
      'shp-shipped',
      'shipped',
      'Confirmed forbidden fixed-clock original retry',
    )).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }))

    const snapshot = services.repository.getSnapshot()
    const shipment = snapshot.shipments.find((entry) => entry.id === 'shp-shipped')!
    const order = snapshot.orders.find((entry) => entry.id === shipment.orderId)!
    expect(snapshot).toEqual(beforeBlockedRetry)
    expect(shipment.timeline.at(-1)?.status).toBe('failed_delivery')
    expect(new Set(shipment.timeline.map((entry) => entry.id)).size).toBe(shipment.timeline.length)
    expect(new Set(order.timeline.map((entry) => entry.id)).size).toBe(order.timeline.length)
    expect(() => validateDemoState(snapshot)).not.toThrow()
  })

  it('delivers a separately linked replacement without changing the failed original', () => {
    services.auth.oneClick('customer')
    const claim = services.claims.submit({
      orderId: 'ord-failed',
      kind: 'non_delivery',
      shipmentId: 'shp-failed',
      note: 'DEMO failed original needs a separate replacement',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Confirmed replacement review acknowledgement')
    services.claims.review(claim.id, 'approve', 'Confirmed replacement review approval')
    expect(() => services.claims.createRma(
      claim.id,
      'DEMO-RMA-NOT-DELIVERED',
      'Attempted RMA for an undelivered original',
    )).toThrow(expect.objectContaining({ code: 'RMA_PHYSICAL_DELIVERY_REQUIRED' }))
    const replacement = services.claims.authorizeReplacement(
      claim.id,
      'Confirmed exact-scope replacement authorization',
    ).data
    for (const status of ['picking', 'packed', 'label_created', 'shipped', 'delivered'] as const) {
      services.fulfilment.advance(
        replacement.id,
        status,
        `Confirmed replacement ${status} evidence`,
      )
    }

    const snapshot = services.repository.getSnapshot()
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-failed')?.status).toBe('failed_delivery')
    expect(snapshot.shipments.find((entry) => entry.id === replacement.id)).toMatchObject({
      purpose: 'replacement',
      sourceClaimId: claim.id,
      replacementForShipmentId: 'shp-failed',
      status: 'delivered',
    })
    expect(snapshot.claims.find((entry) => entry.id === claim.id)).toMatchObject({
      status: 'resolved',
      remedyState: 'replacement_delivered',
      replacementShipmentId: replacement.id,
      resolutionReference: replacement.id,
    })
    expect(snapshot.orders.find((entry) => entry.id === 'ord-failed')?.status).toBe('fulfilled')
    expect(snapshot.boxes.find((entry) => entry.id === 'box-failed-01')).toMatchObject({
      status: 'fulfilled',
      shipmentId: 'shp-failed',
    })
    expect(() => validateDemoState(snapshot)).not.toThrow()
  })

  it('preserves a replacement through a dispute stop and resumes it before delivery', () => {
    const isolated = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    isolated.auth.oneClick('customer')
    const claim = isolated.claims.submit({
      orderId: 'ord-failed',
      kind: 'non_delivery',
      shipmentId: 'shp-failed',
      note: 'DEMO disputed replacement keeps immutable original evidence',
    }).data
    isolated.auth.oneClick('admin')
    isolated.claims.review(claim.id, 'acknowledge', 'Confirmed disputed replacement acknowledgement')
    isolated.claims.review(claim.id, 'approve', 'Confirmed disputed replacement approval')
    const replacement = isolated.claims.authorizeReplacement(
      claim.id,
      'Confirmed disputed replacement authorization',
    ).data

    isolated.payments.dispute(
      'pay-failed',
      'Confirmed replacement financial dispute stop',
      'evt-replacement-dispute-stop',
    )
    expect(isolated.repository.getSnapshot().shipments
      .find((entry) => entry.id === replacement.id)?.status).toBe('cancelled')
    expect(isolated.repository.getSnapshot().orders
      .find((entry) => entry.id === 'ord-failed')?.status).toBe('disputed')

    isolated.payments.resolveDispute(
      'pay-failed',
      'merchant_won',
      'Confirmed replacement financial dispute resume',
      'evt-replacement-dispute-resume',
    )
    expect(isolated.repository.getSnapshot().shipments
      .find((entry) => entry.id === replacement.id)?.status).toBe('unfulfilled')
    for (const status of ['picking', 'packed', 'label_created', 'shipped', 'delivered'] as const) {
      isolated.fulfilment.advance(
        replacement.id,
        status,
        `Confirmed resumed replacement ${status}`,
      )
    }
    const snapshot = isolated.repository.getSnapshot()
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-failed')?.status)
      .toBe('failed_delivery')
    expect(snapshot.claims.find((entry) => entry.id === claim.id)).toMatchObject({
      status: 'resolved',
      remedyState: 'replacement_delivered',
    })
    expect(snapshot.orders.find((entry) => entry.id === 'ord-failed')?.status)
      .toBe('fulfilled')
    expect(() => validateDemoState(snapshot)).not.toThrow()
  })

  it('records ordered RMA evidence with role guards, exact replay, and inspected completion', () => {
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))
    let rmaNow = FIXED_NOW
    const isolated = new AppServices(storage, () => rmaNow)
    isolated.auth.oneClick('customer')
    const claim = isolated.claims.submit({
      orderId: 'ord-delivered',
      kind: 'damage',
      shipmentId: 'shp-delivered',
      note: 'DEMO damaged physical delivery needs an RMA inspection',
    }).data
    isolated.auth.oneClick('admin')
    isolated.claims.review(claim.id, 'acknowledge', 'Confirmed RMA review acknowledgement')
    isolated.claims.review(claim.id, 'approve', 'Confirmed RMA review approval')
    rmaNow = '2026-07-28T05:00:00.000Z'
    isolated.fulfilment.advance(
      'shp-delivered',
      'returned',
      'Confirmed customer return after delivered damage evidence',
    )

    isolated.repository.update((state) => { state.sessionUserId = 'usr-fulfilment' })
    const beforeForbidden = structuredClone(isolated.repository.getSnapshot())
    expect(() => isolated.claims.createRma(
      claim.id,
      'DEMO-RMA-ORDERED-01',
      'Confirmed ordered RMA creation evidence',
    )).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
    expect(isolated.repository.getSnapshot()).toEqual(beforeForbidden)

    isolated.repository.update((state) => { state.sessionUserId = 'usr-support' })
    const created = isolated.claims.createRma(
      claim.id,
      'DEMO-RMA-ORDERED-01',
      'Confirmed ordered RMA creation evidence',
    )
    expect(created).toMatchObject({
      changed: true,
      data: { status: 'approved', remedyState: 'rma_created' },
    })
    const writesBeforeReplay = storage.writes
    expect(isolated.claims.createRma(
      claim.id,
      'DEMO-RMA-ORDERED-01',
      'Confirmed ordered RMA creation evidence',
    ).changed).toBe(false)
    expect(storage.writes).toBe(writesBeforeReplay)
    expect(() => isolated.claims.createRma(
      claim.id,
      'DEMO-RMA-ORDERED-01',
      'Conflicting RMA creation evidence',
    )).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }))
    expect(() => isolated.claims.recordRmaInspected(
      claim.id,
      'DEMO-RMA-ORDERED-01',
      'Attempted inspection before receipt evidence',
    )).toThrow(expect.objectContaining({ code: 'RMA_ORDER_INVALID' }))
    expect(() => isolated.claims.review(
      claim.id,
      'resolve',
      'Attempted premature RMA no-remedy completion',
      { outcome: 'no_remedy', reference: 'DEMO-NO-PREMATURE-RMA' },
    )).toThrow(expect.objectContaining({ code: 'REMEDY_INCOMPLETE' }))

    expect(isolated.claims.recordRmaReceived(
      claim.id,
      'DEMO-RMA-ORDERED-01',
      'Confirmed ordered RMA receipt evidence',
    )).toMatchObject({
      changed: true,
      data: { status: 'approved', remedyState: 'rma_received' },
    })
    expect(isolated.claims.recordRmaReceived(
      claim.id,
      'DEMO-RMA-ORDERED-01',
      'Confirmed ordered RMA receipt evidence',
    ).changed).toBe(false)
    expect(isolated.claims.recordRmaInspected(
      claim.id,
      'DEMO-RMA-ORDERED-01',
      'Confirmed ordered RMA inspection evidence',
    )).toMatchObject({
      changed: true,
      data: { status: 'approved', remedyState: 'rma_inspected' },
    })
    expect(isolated.claims.recordRmaInspected(
      claim.id,
      'DEMO-RMA-ORDERED-01',
      'Confirmed ordered RMA inspection evidence',
    ).changed).toBe(false)
    expect(() => isolated.claims.review(
      claim.id,
      'resolve',
      'Attempted inspected RMA completion without refund or replacement',
      { outcome: 'no_remedy', reference: 'DEMO-RMA-MISSING-OUTCOME' },
    )).toThrow(expect.objectContaining({ code: 'REMEDY_INCOMPLETE' }))
    isolated.repository.update((state) => { state.sessionUserId = 'usr-demo-admin' })
    isolated.payments.refund(
      'pay-delivered',
      claim.requiredSettlementSen,
      'Confirmed inspected RMA linked refund',
      'req-inspected-rma-linked-refund',
      claim.id,
    )
    const linkedRefundEventId = isolated.repository.getSnapshot().claims
      .find((entry) => entry.id === claim.id)!.linkedRefundEventId!
    const completed = isolated.claims.review(
      claim.id,
      'resolve',
      'Confirmed inspected RMA linked refund completion',
      { outcome: 'refund_recorded', reference: linkedRefundEventId },
    )
    expect(completed.data).toMatchObject({
      status: 'resolved',
      remedyState: 'refund_completed',
      rma: { status: 'inspected' },
      resolutionReference: linkedRefundEventId,
    })
    expect(isolated.repository.getSnapshot().shipments
      .find((entry) => entry.id === 'shp-delivered')?.status).toBe('returned')
    expect(isolated.repository.getSnapshot().orders
      .find((entry) => entry.id === 'ord-delivered')?.status).toBe('refunded')
    expect(() => validateDemoState(isolated.repository.getSnapshot())).not.toThrow()
  })

  it('completes a post-delivery return through one replacement after RMA inspection', () => {
    let rmaNow = FIXED_NOW
    const isolated = new AppServices(new MemoryStorage(), () => rmaNow)
    isolated.auth.oneClick('customer')
    const claim = isolated.claims.submit({
      orderId: 'ord-delivered',
      kind: 'damage',
      shipmentId: 'shp-delivered',
      note: 'DEMO returned damaged delivery uses inspected RMA replacement path',
    }).data
    isolated.auth.oneClick('admin')
    isolated.claims.review(claim.id, 'acknowledge', 'Confirmed inspected replacement acknowledgement')
    isolated.claims.review(claim.id, 'approve', 'Confirmed inspected replacement approval')
    rmaNow = '2026-07-28T05:00:00.000Z'
    isolated.fulfilment.advance(
      'shp-delivered',
      'returned',
      'Confirmed returned original before inspected replacement',
    )
    isolated.repository.update((state) => { state.sessionUserId = 'usr-support' })
    isolated.claims.createRma(claim.id, 'DEMO-RMA-REPLACE-01', 'Confirmed replacement RMA creation')
    isolated.claims.recordRmaReceived(claim.id, 'DEMO-RMA-REPLACE-01', 'Confirmed replacement RMA receipt')
    isolated.claims.recordRmaInspected(claim.id, 'DEMO-RMA-REPLACE-01', 'Confirmed replacement RMA inspection')
    expect(() => isolated.claims.authorizeReplacement(
      claim.id,
      'Confirmed inspected replacement authorization',
    )).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))

    isolated.repository.update((state) => { state.sessionUserId = 'usr-fulfilment' })
    const authorized = isolated.claims.authorizeReplacement(
      claim.id,
      'Confirmed inspected replacement authorization',
    )
    expect(authorized).toMatchObject({
      changed: true,
      data: {
        purpose: 'replacement',
        sourceClaimId: claim.id,
        replacementForShipmentId: 'shp-delivered',
        status: 'unfulfilled',
      },
    })
    expect(isolated.repository.getSnapshot().claims.find((entry) => entry.id === claim.id))
      .toMatchObject({ status: 'approved', remedyState: 'replacement_authorized' })
    const beforeReplay = structuredClone(isolated.repository.getSnapshot())
    expect(isolated.claims.authorizeReplacement(
      claim.id,
      'Confirmed inspected replacement authorization',
    )).toMatchObject({ changed: false, data: { id: authorized.data.id } })
    expect(isolated.repository.getSnapshot()).toEqual(beforeReplay)
    expect(() => isolated.claims.authorizeReplacement(
      claim.id,
      'Conflicting inspected replacement authorization',
    )).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }))
    for (const status of ['picking', 'packed', 'label_created', 'shipped', 'delivered'] as const) {
      isolated.fulfilment.advance(
        authorized.data.id,
        status,
        `Confirmed inspected RMA replacement ${status}`,
      )
    }
    const completed = isolated.repository.getSnapshot()
    expect(completed.shipments.find((entry) => entry.id === 'shp-delivered')?.status)
      .toBe('returned')
    expect(completed.claims.find((entry) => entry.id === claim.id)).toMatchObject({
      status: 'resolved',
      remedyState: 'replacement_delivered',
      replacementShipmentId: authorized.data.id,
      resolutionReference: authorized.data.id,
    })
    expect(completed.orders.find((entry) => entry.id === 'ord-delivered')?.status)
      .toBe('fulfilled')
    expect(() => validateDemoState(completed)).not.toThrow()
  })

  it('uses the digital issued-sent path for a replacement and never mutates its failed original', () => {
    services.auth.oneClick('customer')
    services.openBox('box-processing-02')
    services.auth.oneClick('admin')
    services.fulfilment.advance('shp-digital', 'issued', 'Confirmed original digital issue evidence')
    services.fulfilment.advance('shp-digital', 'sent', 'Confirmed original digital send evidence')
    services.fulfilment.advance('shp-digital', 'failed', 'Confirmed original digital failure evidence')
    services.auth.oneClick('customer')
    expect(() => services.claims.submit({
      orderId: 'ord-processing',
      kind: 'damage',
      shipmentId: 'shp-digital',
      note: 'DEMO digital delivery cannot have physical damage',
    })).toThrow(/digital fulfilment cannot have physical damage/i)
    const claim = services.claims.submit({
      orderId: 'ord-processing',
      kind: 'non_delivery',
      shipmentId: 'shp-digital',
      note: 'DEMO failed digital original needs a digital replacement',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Confirmed digital replacement acknowledgement')
    services.claims.review(claim.id, 'approve', 'Confirmed digital replacement approval')
    expect(() => services.claims.createRma(
      claim.id,
      'DEMO-RMA-DIGITAL-FORBIDDEN',
      'Attempted RMA for a failed digital original',
    )).toThrow(expect.objectContaining({ code: 'RMA_PHYSICAL_DELIVERY_REQUIRED' }))
    const replacement = services.claims.authorizeReplacement(
      claim.id,
      'Confirmed digital replacement authorization',
    ).data
    expect(replacement).toMatchObject({
      kind: 'DIGITAL',
      purpose: 'replacement',
      boxIds: ['box-processing-02'],
      insured: false,
      signatureRequired: false,
    })
    expect(() => services.fulfilment.setTracking(
      replacement.id,
      'Digital Vault',
      'DEMO-DIGITAL-REPLACEMENT-EDIT',
      'Attempted digital replacement tracking edit',
    )).toThrow(expect.objectContaining({ code: 'DIGITAL_TRACKING_FORBIDDEN' }))
    services.fulfilment.advance(replacement.id, 'issued', 'Confirmed replacement digital issued')
    services.fulfilment.advance(replacement.id, 'sent', 'Confirmed replacement digital sent')
    expect(services.repository.getSnapshot().claims.find((entry) => entry.id === claim.id))
      .toMatchObject({ status: 'approved', remedyState: 'replacement_authorized' })
    services.fulfilment.advance(replacement.id, 'delivered', 'Confirmed replacement digital delivered')

    const snapshot = services.repository.getSnapshot()
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-digital')).toMatchObject({
      purpose: 'original',
      status: 'failed',
    })
    expect(snapshot.shipments.find((entry) => entry.id === replacement.id)?.timeline
      .map((entry) => entry.status)).toEqual(['unfulfilled', 'issued', 'sent', 'delivered'])
    expect(snapshot.claims.find((entry) => entry.id === claim.id)).toMatchObject({
      status: 'resolved',
      remedyState: 'replacement_delivered',
      resolutionReference: replacement.id,
    })
    expect(snapshot.orders.find((entry) => entry.id === 'ord-processing')?.status)
      .toBe('partially_fulfilled')
    expect(snapshot.boxes.find((entry) => entry.id === 'box-processing-02')).toMatchObject({
      status: 'fulfilled',
      shipmentId: 'shp-digital',
    })
    expect(() => validateDemoState(snapshot)).not.toThrow()
  })

  it('completes a failed original scope only after its exact linked refund resolves', () => {
    services.auth.oneClick('customer')
    const claim = services.claims.submit({
      orderId: 'ord-failed',
      kind: 'non_delivery',
      shipmentId: 'shp-failed',
      note: 'DEMO failed original uses exact linked refund completion',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Confirmed failed-scope refund acknowledgement')
    services.claims.review(claim.id, 'approve', 'Confirmed failed-scope refund approval')
    services.payments.refund(
      'pay-failed',
      claim.requiredSettlementSen,
      'Confirmed exact failed-scope linked refund',
      'req-failed-scope-linked-refund',
      claim.id,
    )
    let snapshot = services.repository.getSnapshot()
    const linked = snapshot.claims.find((entry) => entry.id === claim.id)!.linkedRefundEventId!
    expect(snapshot.orders.find((entry) => entry.id === 'ord-failed')?.status).toBe('refunded')
    expect(snapshot.claims.find((entry) => entry.id === claim.id)).toMatchObject({
      status: 'approved',
      remedyState: 'refund_linked',
    })

    services.claims.review(
      claim.id,
      'resolve',
      'Confirmed exact failed-scope refund completion',
      { outcome: 'refund_recorded', reference: linked },
    )
    snapshot = services.repository.getSnapshot()
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-failed')?.status)
      .toBe('failed_delivery')
    expect(snapshot.claims.find((entry) => entry.id === claim.id)).toMatchObject({
      status: 'resolved',
      remedyState: 'refund_completed',
      resolutionReference: linked,
    })
    expect(snapshot.orders.find((entry) => entry.id === 'ord-failed')?.status).toBe('refunded')
    expect(snapshot.boxes.find((entry) => entry.id === 'box-failed-01')).toMatchObject({
      status: 'on_hold',
      shipmentId: 'shp-failed',
    })
    expect(() => services.admin.changeOrderStatus(
      'ord-failed',
      'closed',
      'Confirmed close after exact failed-scope remedy',
    )).toThrow()
    expect(() => validateDemoState(services.repository.getSnapshot())).not.toThrow()
  })

  it('rolls back failed RMA and replacement writes and permits safe retries', () => {
    const storage = new FailNextWriteStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))
    let rmaNow = FIXED_NOW
    const isolated = new AppServices(storage, () => rmaNow)
    isolated.auth.oneClick('customer')
    const claim = isolated.claims.submit({
      orderId: 'ord-delivered',
      kind: 'damage',
      shipmentId: 'shp-delivered',
      note: 'DEMO atomic remedy storage failure claim',
    }).data
    isolated.auth.oneClick('admin')
    isolated.claims.review(claim.id, 'acknowledge', 'Confirmed atomic remedy acknowledgement')
    isolated.claims.review(claim.id, 'approve', 'Confirmed atomic remedy approval')
    rmaNow = '2026-07-28T05:00:00.000Z'
    isolated.fulfilment.advance(
      'shp-delivered',
      'returned',
      'Confirmed atomic post-delivery return evidence',
    )
    const beforeRma = structuredClone(isolated.repository.getSnapshot())
    const rawBeforeRma = storage.getItem(STORAGE_KEY)
    storage.failNextWrite = true
    expect(() => isolated.claims.createRma(
      claim.id,
      'DEMO-RMA-ATOMIC-01',
      'Confirmed atomic RMA creation evidence',
    )).toThrow(expect.objectContaining({ code: 'STORAGE_WRITE_FAILED' }))
    expect(isolated.repository.getSnapshot()).toEqual(beforeRma)
    expect(storage.getItem(STORAGE_KEY)).toBe(rawBeforeRma)

    isolated.claims.createRma(
      claim.id,
      'DEMO-RMA-ATOMIC-01',
      'Confirmed atomic RMA creation evidence',
    )
    isolated.claims.recordRmaReceived(
      claim.id,
      'DEMO-RMA-ATOMIC-01',
      'Confirmed atomic RMA receipt evidence',
    )
    isolated.claims.recordRmaInspected(
      claim.id,
      'DEMO-RMA-ATOMIC-01',
      'Confirmed atomic RMA inspection evidence',
    )
    const beforeReplacement = structuredClone(isolated.repository.getSnapshot())
    const rawBeforeReplacement = storage.getItem(STORAGE_KEY)
    storage.failNextWrite = true
    expect(() => isolated.claims.authorizeReplacement(
      claim.id,
      'Confirmed atomic replacement authorization',
    )).toThrow(expect.objectContaining({ code: 'STORAGE_WRITE_FAILED' }))
    expect(isolated.repository.getSnapshot()).toEqual(beforeReplacement)
    expect(storage.getItem(STORAGE_KEY)).toBe(rawBeforeReplacement)
    expect(isolated.claims.authorizeReplacement(
      claim.id,
      'Confirmed atomic replacement authorization',
    )).toMatchObject({ changed: true, data: { purpose: 'replacement' } })
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
    for (const status of ['packed', 'label_created', 'shipped', 'delivered'] as const) {
      services.fulfilment.advance('shp-processing', status, `Confirmed mixed physical ${status}`)
    }
    expect(services.repository.getSnapshot().orders
      .find((entry) => entry.id === 'ord-processing')?.status).toBe('partially_fulfilled')
    expect(() => services.admin.changeOrderStatus(
      'ord-processing',
      'closed',
      'Attempted close before digital scope completion',
    )).toThrow()
    for (const status of ['issued', 'sent', 'delivered'] as const) {
      services.fulfilment.advance('shp-digital', status, `Confirmed mixed digital ${status}`)
    }
    expect(services.repository.getSnapshot().orders.find((entry) => entry.id === 'ord-processing')?.status).toBe('fulfilled')
    services.admin.changeOrderStatus(
      'ord-processing',
      'closed',
      'Confirmed close after both original scopes completed',
    )
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
      'Confirmed merchant win for Air fryer PARCEL via Demo Express, physical not digital, box-unopened-01',
      'evt-single-picking-dispute-win',
    )
    snapshot = services.repository.getSnapshot()
    expect(resolved.changed).toBe(true)
    expect(snapshot.payments.find((entry) => entry.id === 'pay-unopened')?.status).toBe('succeeded')
    expect(snapshot.orders.find((entry) => entry.id === 'ord-unopened')?.status).toBe('confirmed')
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-unopened')?.status).toBe('unfulfilled')
    expect(snapshot.boxes.find((entry) => entry.id === 'box-unopened-01')?.status).toBe('paid_unopened')
    const storedTimeline = structuredClone(
      snapshot.orders.find((entry) => entry.id === 'ord-unopened')!.timeline,
    )
    const visibleTimeline = sealedCustomerTimeline(
      snapshot.orders.find((entry) => entry.id === 'ord-unopened')!,
    )
    expect(visibleTimeline.map((entry) => entry.label)).toEqual([
      'Demo order created',
      'Mock payment confirmed',
      'Demo order placed on disputed financial hold',
      'Demo financial hold resolved',
    ])
    expect(JSON.stringify(visibleTimeline)).not.toMatch(
      /Air fryer|PARCEL|Demo Express|physical|digital|box-unopened|merchant win/i,
    )
    expect(snapshot.orders.find((entry) => entry.id === 'ord-unopened')!.timeline)
      .toEqual(storedTimeline)
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
    'blocks rewriting a failed original during a %s hold without changing finance or boxes',
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

      expect(() => held.fulfilment.advance(
        'shp-failed',
        'shipped',
        'Attempted rewrite of the failed fictional original',
      )).toThrow(/graph-legal physical carrier evidence/i)

      const snapshot = held.repository.getSnapshot()
      expect(snapshot.shipments.find((entry) => entry.id === 'shp-failed')?.status).toBe('failed_delivery')
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

    expect(() => held.fulfilment.advance(
      'shp-failed',
      'shipped',
      'Attempted held original redelivery rewrite',
    )).toThrow(/graph-legal physical carrier evidence/i)
    expect(held.repository.getSnapshot()).toEqual(before)
  })

  it('does not treat digital fulfilment as physical carrier evidence during a financial hold', () => {
    const held = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    held.auth.oneClick('admin')
    for (const status of ['issued', 'sent'] as const) {
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
    makeProcessingOrderTwoPhysicalShipments(services)
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
    expect(valueFloor.message).toMatch(
      /suspected RM\s*100\.00 value-floor issue.+review threshold.+eligibility does not establish a breach/i,
    )
    expect(new Set([damage.data.id, valueFloor.data.id, nonDelivery.data.id]).size).toBe(3)
    expect(damage.data.id).toMatch(/^clm-[a-z0-9]{8}-[a-z0-9]{7}$/)
    expect(damage.data.requestId).toMatch(/^req-claim-/)
  })

  it('uses the order historical floor in the cautious value-floor submission message', () => {
    services.repository.update((state) => {
      state.orders.find((order) => order.id === 'ord-delivered')!
        .snapshot.valueFloorSen = 12_500
    })
    services.auth.oneClick('customer')

    const result = services.claims.submit({
      orderId: 'ord-delivered',
      kind: 'value_floor',
      boxId: 'box-delivered-01',
      note: 'DEMO historical value-floor evidence review',
    })

    expect(result.message).toMatch(
      /suspected RM\s*125\.00 value-floor issue.+only a review threshold.+does not establish a breach/i,
    )
    expect(result.message).not.toMatch(/RM\s*100(?:\.00)?/i)
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

  it('accepts digital failed as non-delivery without using any physical status', () => {
    services.auth.oneClick('customer')
    services.openBox('box-processing-02')
    services.auth.oneClick('admin')
    for (const status of ['issued', 'sent', 'failed'] as const) {
      services.fulfilment.advance(
        'shp-digital',
        status,
        `Confirmed digital non-delivery guard setup ${status}`,
      )
    }
    services.auth.oneClick('customer')
    const result = services.claims.submit({
      orderId: 'ord-processing',
      kind: 'non_delivery',
      shipmentId: 'shp-digital',
      note: 'DEMO failed digital fulfilment did not arrive',
    })
    expect(result).toMatchObject({
      changed: true,
      data: { kind: 'non_delivery', shipmentId: 'shp-digital' },
    })
    expect(services.repository.getSnapshot().shipments
      .find((entry) => entry.id === 'shp-digital')?.timeline
      .map((entry) => entry.status)).toEqual(['unfulfilled', 'issued', 'sent', 'failed'])
  })

  it('makes a sent digital original non-delivery eligible only after three demo days', () => {
    let digitalNow = FIXED_NOW
    const isolated = new AppServices(new MemoryStorage(), () => digitalNow)
    isolated.auth.oneClick('customer')
    isolated.openBox('box-processing-02')
    isolated.auth.oneClick('admin')
    isolated.fulfilment.advance('shp-digital', 'issued', 'Confirmed overdue digital issue evidence')
    isolated.fulfilment.advance('shp-digital', 'sent', 'Confirmed overdue digital send evidence')
    isolated.auth.oneClick('customer')
    digitalNow = '2026-07-31T03:59:59.000Z'
    expect(() => isolated.claims.submit({
      orderId: 'ord-processing',
      kind: 'non_delivery',
      shipmentId: 'shp-digital',
      note: 'DEMO digital delivery is not yet three days overdue',
    })).toThrow(expect.objectContaining({ code: 'CLAIM_NOT_OVERDUE' }))

    digitalNow = '2026-07-31T04:00:00.000Z'
    expect(isolated.claims.submit({
      orderId: 'ord-processing',
      kind: 'non_delivery',
      shipmentId: 'shp-digital',
      note: 'DEMO digital delivery is now three days overdue',
    })).toMatchObject({
      changed: true,
      data: {
        kind: 'non_delivery',
        shipmentId: 'shp-digital',
      },
    })
    expect(() => validateDemoState(isolated.repository.getSnapshot())).not.toThrow()
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
        shipmentCandidateIds: ['shp-digital', 'shp-processing'],
        refundCreated: false,
      },
    })
    expect(snapshot.audits.at(-1)?.after).not.toHaveProperty('shipmentId')
    expect(multi.claims.listMine().at(-1)).not.toHaveProperty('shipmentCandidateIds')
    expect(snapshot.payments.reduce((sum, payment) => sum + payment.refundedSen, 0)).toBe(refundedBefore)
    expect(() => validateDemoState(snapshot)).not.toThrow()
  })

  it('widens reviewing neutral evidence when a new physical shipment becomes eligible', () => {
    const scenario = neutralClaimWideningScenario()
    expect(scenario.services.repository.getSnapshot().claims.at(-1)?.shipmentCandidateIds)
      .toEqual(['shp-processing'])
    expect(scenario.services.repository.getSnapshot().claims.at(-1)).toMatchObject({
      remedyBoxIds: ['box-processing-01'],
      requiredSettlementSen: 10_600,
    })
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
    expect(stored).toMatchObject({
      remedyBoxIds: ['box-processing-01', 'box-processing-02'],
      requiredSettlementSen: 21_200,
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

  it('keeps an unresolved order-level scope on hold and blocks opening it', () => {
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
    const beforeOpen = structuredClone(scoped.repository.getSnapshot())
    expect(() => scoped.openBox('box-shipped-01')).toThrow(/financial hold/i)
    expect(scoped.repository.getSnapshot()).toEqual(beforeOpen)
    expect(scoped.repository.getSnapshot().claims[0].id).toBe(orderLevel.data.id)
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
      'Support resolved a sound fictional no-remedy path',
      { outcome: 'no_remedy', reference: `DEMO-${claim.id.toUpperCase()}` },
    )
    const snapshot = services.repository.getSnapshot()
    const resolved = snapshot.claims.find((entry) => entry.id === claim.id)!
    expect(resolved.status).toBe('resolved')
    expect(resolved).toMatchObject({
      resolutionOutcome: 'no_remedy',
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
    )).toThrow(expect.objectContaining({ code: 'TYPED_REMEDY_REQUIRED' }))

    services.payments.refund(
      'pay-delivered',
      claim.requiredSettlementSen,
      'Confirmed audited refund for claim resolution',
      'req-claim-resolution-refund',
      claim.id,
    )
    const refundEvent = services.repository.getSnapshot().payments
      .find((payment) => payment.id === 'pay-delivered')!
      .events.find((event) => event.requestId === 'req-claim-resolution-refund')!
    const beforeWrongResolution = structuredClone(services.repository.getSnapshot())
    expect(() => services.claims.review(
      claim.id,
      'resolve',
      'Attempted mismatched refund resolution reference',
      { outcome: 'refund_recorded', reference: 'evt-ord-delivered-success' },
    )).toThrow(expect.objectContaining({ code: 'RESOLUTION_REFUND_LINK_MISMATCH' }))
    expect(() => services.claims.review(
      claim.id,
      'resolve',
      'Attempted replacement after linking an exact refund event',
      { outcome: 'replacement_authorized', reference: `DEMO-${claim.id.toUpperCase()}` },
    )).toThrow(expect.objectContaining({ code: 'RESOLUTION_REFUND_LINK_MISMATCH' }))
    expect(services.repository.getSnapshot()).toEqual(beforeWrongResolution)
    const result = services.claims.review(
      claim.id,
      'resolve',
      'Recorded the separate audited demo refund as resolution evidence',
      { outcome: 'refund_recorded', reference: refundEvent.id },
    )
    expect(result.data).toMatchObject({
      linkedRefundEventId: refundEvent.id,
      status: 'resolved',
      resolutionOutcome: 'refund_recorded',
      resolutionReference: refundEvent.id,
    })
    expect(refundEvent.refundIntent?.claimId).toBe(claim.id)
    expect(services.repository.getSnapshot().audits.find((audit) => audit.eventId === refundEvent.id)).toMatchObject({
      targetId: 'pay-delivered',
      action: 'payment.refunded',
    })
    expect(services.repository.getSnapshot().audits.find((audit) =>
      audit.eventId === refundEvent.id && audit.targetId === claim.id)).toMatchObject({
        action: 'claim.refund_linked',
        outcome: 'applied',
      })
    expect(() => validateDemoState(services.repository.getSnapshot())).not.toThrow()
  })

  it('makes an exact linked-refund replay a no-op and treats claimId as part of identity', () => {
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))
    const isolated = new AppServices(storage, () => FIXED_NOW)
    isolated.auth.oneClick('customer')
    const claim = isolated.claims.submit({
      orderId: 'ord-delivered',
      kind: 'damage',
      shipmentId: 'shp-delivered',
      note: 'DEMO linked refund replay evidence',
    }).data
    isolated.auth.oneClick('admin')
    isolated.claims.review(claim.id, 'acknowledge', 'Acknowledged linked refund replay evidence')
    isolated.claims.review(claim.id, 'approve', 'Approved linked refund replay evidence')
    const first = isolated.payments.refund(
      'pay-delivered',
      claim.requiredSettlementSen,
      'Confirmed exact claim-linked refund replay',
      'req-linked-refund-replay',
      claim.id,
    )
    const beforeReplay = structuredClone(isolated.repository.getSnapshot())
    const writesBeforeReplay = storage.writes

    const replay = isolated.payments.refund(
      'pay-delivered',
      claim.requiredSettlementSen,
      'Confirmed exact claim-linked refund replay',
      'req-linked-refund-replay',
      claim.id,
    )
    expect(replay).toMatchObject({
      changed: false,
      payment: { id: first.payment.id },
    })
    expect(isolated.repository.getSnapshot()).toEqual(beforeReplay)
    expect(storage.writes).toBe(writesBeforeReplay)

    expect(() => isolated.payments.refund(
      'pay-delivered',
      claim.requiredSettlementSen,
      'Confirmed exact claim-linked refund replay',
      'req-linked-refund-replay',
      `${claim.id}-changed`,
    )).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }))
    expect(isolated.repository.getSnapshot()).toEqual(beforeReplay)
    expect(storage.writes).toBe(writesBeforeReplay)
  })

  it('keeps goodwill refunds unlinked and blocks them from resolving an approved claim', () => {
    services.auth.oneClick('customer')
    const claim = services.claims.submit({
      orderId: 'ord-delivered',
      kind: 'damage',
      shipmentId: 'shp-delivered',
      note: 'DEMO goodwill refund must not resolve this claim',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Acknowledged goodwill separation evidence')
    services.claims.review(claim.id, 'approve', 'Approved goodwill separation evidence')
    services.payments.refund(
      'pay-delivered',
      claim.requiredSettlementSen,
      'Confirmed unlinked goodwill refund',
      'req-unlinked-goodwill-refund',
    )
    const event = services.repository.getSnapshot().payments
      .find((payment) => payment.id === 'pay-delivered')!
      .events.find((entry) => entry.requestId === 'req-unlinked-goodwill-refund')!
    expect(event.refundIntent?.claimId).toBeUndefined()
    expect(services.repository.getSnapshot().claims
      .find((entry) => entry.id === claim.id)?.linkedRefundEventId).toBeUndefined()
    const beforeResolution = structuredClone(services.repository.getSnapshot())

    expect(() => services.claims.review(
      claim.id,
      'resolve',
      'Attempted to resolve from unrelated goodwill refund',
      { outcome: 'refund_recorded', reference: event.id },
    )).toThrow(expect.objectContaining({ code: 'RESOLUTION_REFUND_LINK_MISMATCH' }))
    expect(services.repository.getSnapshot()).toEqual(beforeResolution)
  })

  it('keeps dispute-origin refunds unlinked and valid', () => {
    services.auth.oneClick('admin')
    services.payments.dispute(
      'pay-unopened',
      'Confirmed dispute before unlinked dispute refund',
      'evt-unlinked-dispute',
    )
    services.payments.resolveDispute(
      'pay-unopened',
      'refund',
      'Confirmed dispute-origin full refund',
      'evt-unlinked-dispute-refund',
    )
    const event = services.repository.getSnapshot().payments
      .find((payment) => payment.id === 'pay-unopened')!
      .events.find((entry) => entry.id === 'evt-unlinked-dispute-refund')!

    expect(event.refundIntent).toMatchObject({
      paymentId: 'pay-unopened',
      reason: 'Confirmed dispute-origin full refund',
    })
    expect(event.refundIntent?.claimId).toBeUndefined()
    expect(() => validateDemoState(services.repository.getSnapshot())).not.toThrow()
  })

  it('blocks missing and cross-order claim links atomically', () => {
    services.auth.oneClick('customer')
    const claim = services.claims.submit({
      orderId: 'ord-delivered',
      kind: 'damage',
      shipmentId: 'shp-delivered',
      note: 'DEMO cross-order refund link evidence',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Acknowledged cross-order refund evidence')
    services.claims.review(claim.id, 'approve', 'Approved cross-order refund evidence')
    const before = structuredClone(services.repository.getSnapshot())

    expect(() => services.payments.refund(
      'pay-unopened',
      1000,
      'Attempted cross-order linked refund',
      'req-cross-order-linked-refund',
      claim.id,
    )).toThrow(expect.objectContaining({ code: 'CLAIM_PAYMENT_MISMATCH' }))
    expect(() => services.payments.refund(
      'pay-delivered',
      claim.requiredSettlementSen,
      'Attempted missing claim-linked refund',
      'req-missing-claim-linked-refund',
      'clm-missing-refund-link',
    )).toThrow(expect.objectContaining({ code: 'CLAIM_MISSING' }))
    expect(services.repository.getSnapshot()).toEqual(before)
  })

  it.each(['submitted', 'reviewing', 'rejected', 'resolved'] as const)(
    'blocks a %s claim from being linked to a refund without any partial write',
    (status) => {
      const isolated = new AppServices(new MemoryStorage(), () => FIXED_NOW)
      isolated.auth.oneClick('customer')
      const claim = isolated.claims.submit({
        orderId: 'ord-delivered',
        kind: 'damage',
        shipmentId: 'shp-delivered',
        note: `DEMO ${status} claim cannot create a refund link`,
      }).data
      isolated.auth.oneClick('admin')
      if (status === 'reviewing') {
        isolated.claims.review(claim.id, 'acknowledge', 'Acknowledged non-approved link evidence')
      } else if (status === 'rejected') {
        isolated.claims.review(claim.id, 'reject', 'Rejected non-approved link evidence')
      } else if (status === 'resolved') {
        isolated.claims.review(claim.id, 'acknowledge', 'Acknowledged resolved link evidence')
        isolated.claims.review(claim.id, 'approve', 'Approved resolved link evidence')
        isolated.claims.review(
          claim.id,
          'resolve',
          'Resolved through a sufficiently descriptive no-remedy path',
          { outcome: 'no_remedy', reference: `DEMO-${claim.id.toUpperCase()}` },
        )
      }
      const before = structuredClone(isolated.repository.getSnapshot())

      expect(() => isolated.payments.refund(
        'pay-delivered',
        1000,
        `Attempted ${status} claim-linked refund`,
        `req-${status}-claim-linked-refund`,
        claim.id,
      )).toThrow(expect.objectContaining({ code: 'CLAIM_NOT_APPROVED' }))
      expect(isolated.repository.getSnapshot()).toEqual(before)
    },
  )

  it('blocks a second refund event for the same approved claim atomically', () => {
    services.auth.oneClick('customer')
    const claim = services.claims.submit({
      orderId: 'ord-delivered',
      kind: 'damage',
      shipmentId: 'shp-delivered',
      note: 'DEMO one refund event per approved claim',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Acknowledged single linked event evidence')
    services.claims.review(claim.id, 'approve', 'Approved single linked event evidence')
    services.payments.refund(
      'pay-delivered',
      claim.requiredSettlementSen,
      'Confirmed first claim-linked refund',
      'req-first-claim-linked-refund',
      claim.id,
    )
    const beforeSecond = structuredClone(services.repository.getSnapshot())

    expect(() => services.payments.refund(
      'pay-delivered',
      claim.requiredSettlementSen,
      'Attempted second claim-linked refund',
      'req-second-claim-linked-refund',
      claim.id,
    )).toThrow(expect.objectContaining({ code: 'CLAIM_REFUND_ALREADY_LINKED' }))
    expect(services.repository.getSnapshot()).toEqual(beforeSecond)
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
      'Confirmed resolved metric fictional no-remedy path',
      { outcome: 'no_remedy', reference: `DEMO-${resolved.id.toUpperCase()}` },
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
    expect(() => services.fulfilment.setTracking('shp-digital', 'Real Courier', 'REAL-1234', 'Unsafe tracking test')).toThrow(/digital fulfilment never uses editable/i)
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
    const edited = snapshot.series.find((entry) => entry.status === 'draft')!.draftPrizes![0]
    expect(edited.odds).toBe(exactOddsLabel(
      edited.allocation,
      snapshot.series.find((entry) => entry.status === 'draft')!.allocationTotal,
    ))
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

  it('returns an isolated mutable admin snapshot instead of the live frozen repository object', () => {
    const storage = new CountingStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))
    const isolated = new AppServices(storage, () => FIXED_NOW)
    isolated.auth.oneClick('admin')
    const live = isolated.repository.getSnapshot()
    const storedBefore = storage.getItem(STORAGE_KEY)
    const clone = isolated.admin.snapshot()

    expect(clone).toEqual(live)
    expect(clone).not.toBe(live)
    expect(clone.orders[0]).not.toBe(live.orders[0])
    clone.orders[0].snapshot.address.city = 'Changed only in admin export'
    clone.audits[0].reason = 'Changed only in admin export'
    clone.audits.splice(0, 1)

    expect(isolated.repository.getSnapshot()).toBe(live)
    expect(live.orders[0].snapshot.address.city).toBe('Kuala Lumpur')
    expect(live.audits[0].reason).toBe('Loaded fictional public demo data')
    expect(live.auditCount).toBe(live.audits.length)
    expect(storage.getItem(STORAGE_KEY)).toBe(storedBefore)
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

  it('allows overlapping cross-kind complaint records before either holds a remedy entitlement', () => {
    const { services: isolated, damage, valueFloor } = overlappingCrossKindClaims()
    const snapshot = isolated.repository.getSnapshot()

    expect(snapshot.claims.filter((claim) =>
      [damage.id, valueFloor.id].includes(claim.id))).toHaveLength(2)
    expect(damage.remedyBoxIds).toEqual(['box-delivered-01'])
    expect(valueFloor.remedyBoxIds).toEqual(damage.remedyBoxIds)
    expect([damage.remedyState, valueFloor.remedyState]).toEqual(['none', 'none'])
    expect(() => validateDemoState(snapshot)).not.toThrow()
  })

  it.each([
    ['damage', 'value_floor'],
    ['value_floor', 'damage'],
  ] as const)(
    'blocks a second overlapping cross-kind replacement when %s is authorized before %s',
    (firstKind, secondKind) => {
      const { services: isolated, damage, valueFloor } = overlappingCrossKindClaims()
      const claims = { damage, value_floor: valueFloor }
      approveClaim(isolated, claims[firstKind].id)
      approveClaim(isolated, claims[secondKind].id)
      const replacement = isolated.claims.authorizeReplacement(
        claims[firstKind].id,
        `Confirmed ${firstKind} overlapping replacement authorization`,
      ).data
      const beforeConflict = structuredClone(isolated.repository.getSnapshot())

      expect(() => isolated.claims.authorizeReplacement(
        claims[secondKind].id,
        `Attempted ${secondKind} overlapping replacement authorization`,
      )).toThrow(expect.objectContaining({ code: 'REMEDY_SCOPE_CONFLICT' }))
      expect(isolated.repository.getSnapshot()).toEqual(beforeConflict)
      expect(beforeConflict.shipments.filter((shipment) =>
        shipment.purpose === 'replacement')).toEqual([
        expect.objectContaining({
          id: replacement.id,
          sourceClaimId: claims[firstKind].id,
          boxIds: ['box-delivered-01'],
        }),
      ])
    },
  )

  it('blocks an overlapping claim refund after another claim authorizes a replacement', () => {
    const { services: isolated, damage, valueFloor } = overlappingCrossKindClaims()
    approveClaim(isolated, damage.id)
    approveClaim(isolated, valueFloor.id)
    isolated.claims.authorizeReplacement(
      damage.id,
      'Confirmed damage replacement before overlapping claim refund',
    )
    const beforeConflict = structuredClone(isolated.repository.getSnapshot())

    expect(() => isolated.payments.refund(
      'pay-delivered',
      valueFloor.requiredSettlementSen,
      'Attempted overlapping value-floor claim refund',
      'req-overlap-replacement-then-refund',
      valueFloor.id,
    )).toThrow(expect.objectContaining({ code: 'REMEDY_SCOPE_CONFLICT' }))
    expect(isolated.repository.getSnapshot()).toEqual(beforeConflict)
  })

  it('blocks an overlapping replacement after another claim links a refund', () => {
    const { services: isolated, damage, valueFloor } = overlappingCrossKindClaims()
    approveClaim(isolated, damage.id)
    approveClaim(isolated, valueFloor.id)
    isolated.payments.refund(
      'pay-delivered',
      damage.requiredSettlementSen,
      'Confirmed damage claim refund before overlapping replacement',
      'req-overlap-refund-then-replacement',
      damage.id,
    )
    const beforeConflict = structuredClone(isolated.repository.getSnapshot())

    expect(() => isolated.claims.authorizeReplacement(
      valueFloor.id,
      'Attempted value-floor replacement after overlapping claim refund',
    )).toThrow(expect.objectContaining({ code: 'REMEDY_SCOPE_CONFLICT' }))
    expect(isolated.repository.getSnapshot()).toEqual(beforeConflict)
  })

  it('snapshots disjoint value-floor sibling scopes and resolves only the delivered replacement box', () => {
    const isolated = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    makeProcessingOrderSingleGroupedPhysicalShipment(isolated)
    isolated.auth.oneClick('customer')
    isolated.openBox('box-processing-02')
    const first = isolated.claims.submit({
      orderId: 'ord-processing',
      kind: 'value_floor',
      boxId: 'box-processing-01',
      note: 'DEMO first grouped sibling value-floor evidence',
    }).data
    const second = isolated.claims.submit({
      orderId: 'ord-processing',
      kind: 'value_floor',
      boxId: 'box-processing-02',
      note: 'DEMO second grouped sibling value-floor evidence',
    }).data

    expect(first).toMatchObject({
      remedyBoxIds: ['box-processing-01'],
      requiredSettlementSen: 10_600,
    })
    expect(second).toMatchObject({
      remedyBoxIds: ['box-processing-02'],
      requiredSettlementSen: 10_600,
    })
    expect(first.requiredSettlementSen + second.requiredSettlementSen).toBe(21_200)

    approveClaim(isolated, first.id)
    approveClaim(isolated, second.id)
    const firstReplacement = isolated.claims.authorizeReplacement(
      first.id,
      'Confirmed first disjoint sibling replacement',
    ).data
    const secondReplacement = isolated.claims.authorizeReplacement(
      second.id,
      'Confirmed second disjoint sibling replacement',
    ).data
    expect(firstReplacement.boxIds).toEqual(['box-processing-01'])
    expect(secondReplacement.boxIds).toEqual(['box-processing-02'])
    for (const next of ['picking', 'packed', 'label_created', 'shipped', 'delivered'] as const) {
      isolated.fulfilment.advance(
        firstReplacement.id,
        next,
        `Confirmed first sibling replacement ${next}`,
      )
    }

    const snapshot = isolated.repository.getSnapshot()
    expect(snapshot.shipments.find((entry) => entry.id === 'shp-processing')?.boxIds)
      .toEqual(['box-processing-01', 'box-processing-02'])
    expect(snapshot.boxes.find((entry) => entry.id === 'box-processing-01')?.status)
      .toBe('fulfilled')
    expect(snapshot.boxes.find((entry) => entry.id === 'box-processing-02')?.status)
      .toBe('on_hold')
    expect(snapshot.orders.find((entry) => entry.id === 'ord-processing')?.status)
      .toBe('partially_fulfilled')
    expect(snapshot.claims.find((entry) => entry.id === second.id)).toMatchObject({
      status: 'approved',
      remedyState: 'replacement_authorized',
    })
    expect(() => validateDemoState(snapshot)).not.toThrow()
  })

  it('snapshots an exact grouped delivery claim as the full original shipment box scope', () => {
    const isolated = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    makeProcessingOrderSingleGroupedPhysicalShipment(isolated)
    isolated.auth.oneClick('customer')
    isolated.openBox('box-processing-02')
    isolated.auth.oneClick('admin')
    for (const next of ['packed', 'label_created', 'shipped', 'failed_delivery'] as const) {
      isolated.fulfilment.advance(
        'shp-processing',
        next,
        `Confirmed grouped delivery evidence ${next}`,
      )
    }
    isolated.auth.oneClick('customer')
    const claim = isolated.claims.submit({
      orderId: 'ord-processing',
      kind: 'non_delivery',
      shipmentId: 'shp-processing',
      note: 'DEMO grouped delivery exact original scope evidence',
    }).data

    expect(claim.remedyBoxIds).toEqual([
      'box-processing-01',
      'box-processing-02',
    ])
    expect(claim.requiredSettlementSen).toBe(21_200)
    approveClaim(isolated, claim.id)
    const replacement = isolated.claims.authorizeReplacement(
      claim.id,
      'Confirmed grouped delivery exact replacement',
    ).data
    expect(replacement.boxIds).toEqual(claim.remedyBoxIds)
    expect(replacement).toMatchObject({
      kind: 'BULKY',
      insured: false,
      signatureRequired: false,
      replacementForShipmentId: 'shp-processing',
    })
  })

  it('preserves grouped original insurance and signature flags on a one-box value-floor replacement', () => {
    const isolated = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    makeProcessingOrderSingleGroupedPhysicalShipment(isolated)
    isolated.repository.update((state) => {
      const first = state.boxes.find((entry) => entry.id === 'box-processing-01')!
      const second = state.boxes.find((entry) => entry.id === 'box-processing-02')!
      const inventory = state.series[0].inventory
      inventory.find((entry) => entry.prizeId === first.prizeId)!.assigned -= 1
      inventory.find((entry) => entry.prizeId === second.prizeId)!.assigned -= 1
      first.prizeId = 'airpods'
      second.prizeId = 'air-fryer'
      inventory.find((entry) => entry.prizeId === first.prizeId)!.assigned += 1
      inventory.find((entry) => entry.prizeId === second.prizeId)!.assigned += 1
      const original = state.shipments.find((entry) => entry.id === 'shp-processing')!
      original.kind = 'PARCEL'
      original.carrier = 'Demo Express'
      original.insured = true
      original.signatureRequired = true
    })
    isolated.auth.oneClick('customer')
    isolated.openBox('box-processing-02')
    const claim = isolated.claims.submit({
      orderId: 'ord-processing',
      kind: 'value_floor',
      boxId: 'box-processing-02',
      note: 'DEMO one-box replacement preserves grouped original flags',
    }).data
    approveClaim(isolated, claim.id)

    const replacement = isolated.claims.authorizeReplacement(
      claim.id,
      'Confirmed one-box grouped flag preservation',
    ).data

    expect(replacement).toMatchObject({
      boxIds: ['box-processing-02'],
      kind: 'PARCEL',
      insured: true,
      signatureRequired: true,
      replacementForShipmentId: 'shp-processing',
    })
    expect(() => validateDemoState(isolated.repository.getSnapshot())).not.toThrow()
  })

  it('keeps ordinary partial refunds ledger-only and rejects under-settled claim links atomically', () => {
    const isolated = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    makeProcessingOrderSingleGroupedPhysicalShipment(isolated)
    isolated.auth.oneClick('customer')
    isolated.openBox('box-processing-02')
    const claim = isolated.claims.submit({
      orderId: 'ord-processing',
      kind: 'value_floor',
      boxId: 'box-processing-01',
      note: 'DEMO exact settlement and ledger separation evidence',
    }).data
    approveClaim(isolated, claim.id)
    isolated.payments.refund(
      'pay-processing',
      1000,
      'Confirmed ordinary ledger-only partial refund',
      'req-ledger-only-partial',
    )
    expect(isolated.repository.getSnapshot().claims.find((entry) => entry.id === claim.id))
      .toMatchObject({ status: 'approved', remedyState: 'none' })

    for (const amountSen of [1, 1000]) {
      const before = structuredClone(isolated.repository.getSnapshot())
      expect(() => isolated.payments.refund(
        'pay-processing',
        amountSen,
        `Attempted under-settled claim link ${amountSen}`,
        `req-under-settled-${amountSen}`,
        claim.id,
      )).toThrow(expect.objectContaining({ code: 'CLAIM_SETTLEMENT_MISMATCH' }))
      expect(isolated.repository.getSnapshot()).toEqual(before)
    }

    isolated.payments.refund(
      'pay-processing',
      claim.requiredSettlementSen,
      'Confirmed exact snapshotted claim settlement',
      'req-exact-scope-settlement',
      claim.id,
    )
    let snapshot = isolated.repository.getSnapshot()
    const linked = snapshot.claims.find((entry) => entry.id === claim.id)!
    expect(linked).toMatchObject({
      status: 'approved',
      remedyState: 'refund_linked',
      acceptedSettlementSen: 10_600,
      settlementPolicy: 'exact_scope',
    })
    expect(snapshot.payments.find((entry) => entry.id === 'pay-processing')).toMatchObject({
      refundedSen: 11_600,
      status: 'partially_refunded',
    })
    isolated.claims.review(
      claim.id,
      'resolve',
      'Confirmed exact scoped settlement completion',
      { outcome: 'refund_recorded', reference: linked.linkedRefundEventId! },
    )
    snapshot = isolated.repository.getSnapshot()
    expect(snapshot.boxes.find((entry) => entry.id === 'box-processing-01')?.status)
      .toBe('fulfilled')
    expect(snapshot.boxes.find((entry) => entry.id === 'box-processing-02')?.status)
      .toBe('opened')
    expect(snapshot.orders.find((entry) => entry.id === 'ord-processing')?.status)
      .toBe('partially_fulfilled')
  })

  it.each(['lost', 'returned'] as const)(
    'allows a terminal physical %s replacement to fall back to the full remaining payment refund',
    (status) => {
      const scenario = physicalReplacementScenario(status)
      const { services: isolated, claim, replacement } = scenario
      if (status === 'returned') {
        isolated.payments.refund(
          'pay-failed',
          1000,
          'Confirmed prior ordinary partial before returned fallback',
          'req-returned-fallback-prior-partial',
        )
      }
      const payment = isolated.repository.getSnapshot().payments
        .find((entry) => entry.id === 'pay-failed')!
      const remainingSen = payment.amountSen - payment.refundedSen
      const result = isolated.payments.refund(
        payment.id,
        remainingSen,
        `Confirmed terminal physical ${status} replacement fallback`,
        `req-physical-${status}-fallback`,
        claim.id,
      )
      const snapshot = isolated.repository.getSnapshot()
      const storedClaim = snapshot.claims.find((entry) => entry.id === claim.id)!

      expect(result.changed).toBe(true)
      expect(snapshot.shipments.find((entry) => entry.id === replacement.id)?.status)
        .toBe(status)
      expect(storedClaim).toMatchObject({
        status: 'approved',
        remedyState: 'refund_linked',
        replacementShipmentId: replacement.id,
        acceptedSettlementSen: remainingSen,
        settlementPolicy: 'terminal_replacement_fallback',
      })
      expect(snapshot.shipments.find((entry) => entry.id === 'shp-failed')?.status)
        .toBe('failed_delivery')
      expect(() => validateDemoState(snapshot)).not.toThrow()
    },
  )

  it('uses full remaining balance for failed digital replacement fallback with exact replay and conflict guards', () => {
    const scenario = failedDigitalReplacementScenario()
    const { services: isolated, claim, replacement } = scenario
    const beforeRefund = isolated.repository.getSnapshot()
    const payment = beforeRefund.payments.find((entry) => entry.id === 'pay-processing')!
    expect(claim.requiredSettlementSen).toBe(10_600)
    expect(payment.amountSen).toBe(21_200)
    expect(() => isolated.payments.refund(
      payment.id,
      claim.requiredSettlementSen,
      'Attempted scoped amount for terminal digital fallback',
      'req-digital-fallback-under',
      claim.id,
    )).toThrow(expect.objectContaining({ code: 'CLAIM_SETTLEMENT_MISMATCH' }))

    const first = isolated.payments.refund(
      payment.id,
      payment.amountSen,
      'Confirmed terminal digital replacement full fallback',
      'req-digital-fallback-exact',
      claim.id,
    )
    const afterFirst = structuredClone(isolated.repository.getSnapshot())
    const replay = isolated.payments.refund(
      payment.id,
      payment.amountSen,
      'Confirmed terminal digital replacement full fallback',
      'req-digital-fallback-exact',
      claim.id,
    )
    expect(replay).toMatchObject({ changed: false, payment: { id: first.payment.id } })
    expect(isolated.repository.getSnapshot()).toEqual(afterFirst)
    expect(afterFirst.claims.find((entry) => entry.id === claim.id)).toMatchObject({
      status: 'approved',
      remedyState: 'refund_linked',
      acceptedSettlementSen: 21_200,
      settlementPolicy: 'terminal_replacement_fallback',
      replacementShipmentId: replacement.id,
    })
    for (const [amountSen, reason, changedClaimId] of [
      [21_199, 'Confirmed terminal digital replacement full fallback', claim.id],
      [21_200, 'Changed terminal digital replacement fallback reason', claim.id],
      [21_200, 'Confirmed terminal digital replacement full fallback', `${claim.id}-other`],
    ] as const) {
      expect(() => isolated.payments.refund(
        payment.id,
        amountSen,
        reason,
        'req-digital-fallback-exact',
        changedClaimId,
      )).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }))
    }
    const eventId = afterFirst.claims.find((entry) => entry.id === claim.id)!
      .linkedRefundEventId!
    isolated.claims.review(
      claim.id,
      'resolve',
      'Confirmed terminal digital fallback audited completion',
      { outcome: 'refund_recorded', reference: eventId },
    )
    expect(isolated.repository.getSnapshot().claims.find((entry) => entry.id === claim.id))
      .toMatchObject({
        status: 'resolved',
        remedyState: 'refund_completed',
        resolutionReference: eventId,
      })
  })

  it.each([
    'unfulfilled',
    'picking',
    'packed',
    'label_created',
    'shipped',
    'failed_delivery',
    'cancelled',
    'delivered',
  ] as const)(
    'rejects replacement refund fallback from %s without changing stored evidence',
    (status) => {
      const scenario = physicalReplacementScenario(status)
      const { services: isolated, claim } = scenario
      const payment = isolated.repository.getSnapshot().payments
        .find((entry) => entry.id === 'pay-failed')!
      const before = structuredClone(isolated.repository.getSnapshot())
      expect(() => isolated.payments.refund(
        payment.id,
        payment.amountSen - payment.refundedSen,
        `Attempted invalid physical ${status} replacement fallback`,
        `req-invalid-${status}-fallback`,
        claim.id,
      )).toThrow()
      expect(isolated.repository.getSnapshot()).toEqual(before)
    },
  )

  it('rolls back a terminal replacement fallback when storage persistence fails and retries safely', () => {
    const storage = new FailNextWriteStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(createDemoState()))
    const scenario = physicalReplacementScenario('lost', storage)
    const { services: isolated, claim } = scenario
    const payment = isolated.repository.getSnapshot().payments
      .find((entry) => entry.id === 'pay-failed')!
    const before = structuredClone(isolated.repository.getSnapshot())
    const rawBefore = storage.getItem(STORAGE_KEY)
    storage.failNextWrite = true

    expect(() => isolated.payments.refund(
      payment.id,
      payment.amountSen,
      'Confirmed storage rollback terminal fallback',
      'req-terminal-fallback-storage',
      claim.id,
    )).toThrow(expect.objectContaining({ code: 'STORAGE_WRITE_FAILED' }))
    expect(isolated.repository.getSnapshot()).toEqual(before)
    expect(storage.getItem(STORAGE_KEY)).toBe(rawBefore)

    expect(isolated.payments.refund(
      payment.id,
      payment.amountSen,
      'Confirmed storage rollback terminal fallback',
      'req-terminal-fallback-storage',
      claim.id,
    ).changed).toBe(true)
  })

  it.each(['unfulfilled', 'issued'] as const)(
    'cancels and safely requeues disputed unsent digital work from %s',
    (status) => {
      const isolated = new AppServices(new MemoryStorage(), () => FIXED_NOW)
      isolated.auth.oneClick('admin')
      if (status === 'issued') {
        isolated.fulfilment.advance(
          'shp-digital',
          'issued',
          'Confirmed disputed digital issue before stop',
        )
      }
      isolated.payments.dispute(
        'pay-processing',
        `Confirmed disputed digital ${status} stop`,
        `evt-digital-${status}-stop`,
      )
      let snapshot = isolated.repository.getSnapshot()
      const stopped = snapshot.shipments.find((entry) => entry.id === 'shp-digital')!
      expect(stopped.status).toBe('cancelled')
      expect(stopped.timeline.at(-1)).toMatchObject({
        status: 'cancelled',
        financialHold: 'disputed',
      })
      expect(snapshot.shipments.some((entry) =>
        entry.orderId === 'ord-processing' &&
        (
          (entry.kind === 'DIGITAL' && ['unfulfilled', 'issued'].includes(entry.status)) ||
          (entry.kind !== 'DIGITAL' &&
            ['unfulfilled', 'picking', 'packed', 'label_created'].includes(entry.status))
        ))).toBe(false)

      isolated.payments.resolveDispute(
        'pay-processing',
        'merchant_won',
        `Confirmed disputed digital ${status} resume`,
        `evt-digital-${status}-resume`,
      )
      snapshot = isolated.repository.getSnapshot()
      expect(snapshot.shipments.find((entry) => entry.id === 'shp-digital')?.status)
        .toBe('unfulfilled')
      expect(() => validateDemoState(snapshot)).not.toThrow()
    },
  )

  it.each([
    ['unfulfilled', 'cancelled'],
    ['issued', 'cancelled'],
    ['sent', 'sent'],
    ['delivered', 'delivered'],
    ['failed', 'failed'],
  ] as const)(
    'keeps permanent refund digital evidence auditable from %s as %s',
    (starting, expected) => {
      const isolated = new AppServices(new MemoryStorage(), () => FIXED_NOW)
      isolated.auth.oneClick('admin')
      const path = starting === 'unfulfilled'
        ? []
        : starting === 'issued'
          ? ['issued'] as const
          : starting === 'sent'
            ? ['issued', 'sent'] as const
            : starting === 'delivered'
              ? ['issued', 'sent', 'delivered'] as const
              : ['issued', 'sent', 'failed'] as const
      for (const next of path) {
        isolated.fulfilment.advance(
          'shp-digital',
          next,
          `Confirmed permanent refund digital ${next}`,
        )
      }
      isolated.payments.refund(
        'pay-processing',
        21_200,
        `Confirmed permanent refund from digital ${starting}`,
        `req-permanent-digital-${starting}`,
      )
      const snapshot = isolated.repository.getSnapshot()
      expect(snapshot.shipments.find((entry) => entry.id === 'shp-digital')?.status)
        .toBe(expected)
      expect(snapshot.orders.find((entry) => entry.id === 'ord-processing')?.status)
        .toBe('refunded')
      if (expected === 'cancelled') {
        const before = structuredClone(snapshot)
        expect(() => isolated.fulfilment.advance(
          'shp-digital',
          'unfulfilled',
          'Attempted independent worker restart after permanent refund',
        )).toThrow(expect.objectContaining({ code: 'FINANCIAL_HOLD' }))
        expect(isolated.repository.getSnapshot()).toEqual(before)
      }
      expect(() => validateDemoState(snapshot)).not.toThrow()
    },
  )

  it.each(['replacement_first', 'original_first'] as const)(
    'enforces one digital delivery entitlement when %s reaches delivery',
    (direction) => {
      const scenario = digitalReissueScenario()
      const { services: isolated, replacement } = scenario
      const firstShipmentId = direction === 'replacement_first'
        ? replacement.id
        : 'shp-digital'
      const secondShipmentId = direction === 'replacement_first'
        ? 'shp-digital'
        : replacement.id
      isolated.fulfilment.advance(
        firstShipmentId,
        'delivered',
        `Confirmed ${direction} entitlement winner`,
      )
      const before = structuredClone(isolated.repository.getSnapshot())
      expect(() => isolated.fulfilment.advance(
        secondShipmentId,
        'delivered',
        `Attempted ${direction} duplicate entitlement delivery`,
      )).toThrow(expect.objectContaining({ code: 'DELIVERY_ENTITLEMENT_CONSUMED' }))
      expect(isolated.repository.getSnapshot()).toEqual(before)
      expect(before.shipments.find((entry) => entry.id === firstShipmentId)?.status)
        .toBe('delivered')
      expect(before.shipments.find((entry) => entry.id === secondShipmentId)?.status)
        .toBe('sent')
    },
  )

  it('uses all exact prize values and allocation names', () => {
    expect(PRIZES.map((prize) => prize.valueSen)).toEqual([13000, 12000, 12000, 15000, 14000, 10000, 29900, 82900, 204900, 399900, 599900])
  })
})
