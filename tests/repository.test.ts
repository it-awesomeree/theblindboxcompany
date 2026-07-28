import { describe, expect, it } from 'vitest'
import { MockRepository, STORAGE_KEY } from '../src/data/MockRepository'
import { createDemoState } from '../src/data/fixtures'
import { validateDemoState } from '../src/data/StateValidator'
import type { DemoState } from '../src/domain/types'
import { MemoryStorage } from './helpers'

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

  it('persists updates and resets to deterministic fixtures', () => {
    const storage = new MemoryStorage()
    const repository = new MockRepository(storage)
    repository.update((state) => { state.cart = [] })
    expect(new MockRepository(storage).getSnapshot().cart).toHaveLength(0)
    repository.reset()
    expect(repository.getSnapshot().cart[0].quantity).toBe(1)
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
