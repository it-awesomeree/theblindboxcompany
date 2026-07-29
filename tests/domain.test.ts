import { describe, expect, it } from 'vitest'
import {
  PRIZES,
  SERIES_ALLOCATION_TOTAL,
  VALUE_FLOOR_SEN,
} from '../src/domain/constants'
import {
  canTransitionOrder,
  canTransitionBox,
  canTransitionPayment,
  canTransitionShipment,
  transitionBox,
  transitionBoxForReveal,
  transitionBoxForShipment,
  validateCheckoutRequestId,
  validateDemoAddress,
  validateDemoEmail,
} from '../src/domain/guards'
import { formatMYR } from '../src/lib/format'
import { DEMO_ADDRESS } from '../src/data/fixtures'
import { deriveOrderStatusFromShipments, neutralOrderDeliveryStatus } from '../src/domain/orderStatus'
import {
  canWidenClaimEvidence,
  isOpenClaimStatus,
  OPEN_CLAIM_STATUSES,
} from '../src/domain/claimStatus'
import {
  shipmentStatusActionEligibility,
  shipmentTrackingActionEligibility,
} from '../src/domain/fulfillmentEligibility'
import { createDemoState } from '../src/data/fixtures'
import { exactOddsLabel } from '../src/domain/odds'
import { valueFloorClaimEligibility } from '../src/domain/claimEligibility'
import { sealedCustomerTimeline } from '../src/domain/orderTimeline'

describe('Series 001 and domain guards', () => {
  it('has exactly 10,000 fixed allocations and every value clears RM100', () => {
    expect(PRIZES.reduce((sum, prize) => sum + prize.allocation, 0))
      .toBe(SERIES_ALLOCATION_TOTAL)
    expect(PRIZES.every((prize) => prize.valueSen >= VALUE_FLOOR_SEN)).toBe(true)
    expect(PRIZES.at(-1)?.allocation).toBe(1)
    expect(PRIZES.at(-1)?.valueSen).toBe(599_900)
  })

  it('derives exact canonical odds without rounding away the numerator', () => {
    expect(exactOddsLabel(3, 10_000)).toBe('3 in 10,000')
    expect(exactOddsLabel(2500, 10_000)).toBe('2,500 in 10,000')
    expect(PRIZES.find((prize) => prize.id === 'iphone17')?.odds).toBe('3 in 10,000')
    expect(PRIZES.every((prize) =>
      prize.odds === exactOddsLabel(prize.allocation, SERIES_ALLOCATION_TOTAL)))
      .toBe(true)
    expect(() => exactOddsLabel(0, 10_000)).toThrow(/positive integer/i)
    expect(() => exactOddsLabel(1.5, 10_000)).toThrow(/positive integer/i)
    expect(() => exactOddsLabel(1, -1)).toThrow(/positive integer/i)
    expect(() => exactOddsLabel(10_001, 10_000)).toThrow(/cannot exceed/i)
  })

  it('rejects sealed boxes and describes revealed eligibility as suspected-issue review only', () => {
    const state = createDemoState()
    const sealed = state.boxes.find((box) => box.id === 'box-unopened-01')
    const revealed = state.boxes.find((box) => box.id === 'box-delivered-01')

    expect(valueFloorClaimEligibility(sealed, '2026-07-29T00:00:00.000Z'))
      .toEqual({
        eligible: false,
        reason: 'Review of a suspected value-floor issue requires a revealed box.',
      })
    expect(valueFloorClaimEligibility(revealed, '2026-07-29T00:00:00.000Z'))
      .toEqual({
        eligible: true,
        reason: 'This revealed box is eligible for review of a suspected value-floor issue.',
      })
    expect(valueFloorClaimEligibility(revealed, '2026-07-18T07:59:59.999Z').eligible)
      .toBe(false)
  })

  it('shows one neutral resolution after a sealed dispute without mutating or leaking stored reasons', () => {
    const order = structuredClone(
      createDemoState().orders.find((entry) => entry.id === 'ord-unopened')!,
    )
    order.status = 'confirmed'
    order.timeline.push(
      {
        id: 'tl-secret-progress',
        status: 'processing',
        label: 'Air fryer PARCEL via Demo Express for box-unopened-01',
        at: '2026-07-28T01:00:00.000Z',
      },
      {
        id: 'tl-secret-hold',
        status: 'disputed',
        label: 'Admin reason with physical and digital split secrets',
        at: '2026-07-28T02:00:00.000Z',
        financialHoldPreviousStatus: 'processing',
      },
      {
        id: 'tl-secret-resolved',
        status: 'confirmed',
        label: 'Merchant won because Air fryer ships by Demo Express',
        at: '2026-07-28T03:00:00.000Z',
      },
      {
        id: 'tl-secret-after',
        status: 'processing',
        label: 'Shipment restarted for box-unopened-01',
        at: '2026-07-28T04:00:00.000Z',
      },
    )
    const stored = structuredClone(order.timeline)

    const visible = sealedCustomerTimeline(order)

    expect(visible.map(({ id, status, at, label }) => ({ id, status, at, label })))
      .toEqual([
        {
          id: order.timeline[0].id,
          status: 'pending_payment',
          at: order.timeline[0].at,
          label: 'Demo order created',
        },
        {
          id: order.timeline[1].id,
          status: 'confirmed',
          at: order.timeline[1].at,
          label: 'Mock payment confirmed',
        },
        {
          id: 'tl-secret-hold',
          status: 'disputed',
          at: '2026-07-28T02:00:00.000Z',
          label: 'Demo order placed on disputed financial hold',
        },
        {
          id: 'tl-secret-resolved',
          status: 'confirmed',
          at: '2026-07-28T03:00:00.000Z',
          label: 'Demo financial hold resolved',
        },
      ])
    expect(JSON.stringify(visible)).not.toMatch(
      /Air fryer|PARCEL|Demo Express|box-unopened|physical|digital|merchant won/i,
    )
    expect(order.timeline).toEqual(stored)
  })

  it('formats integer sen as MYR', () => {
    expect(formatMYR(10_000)).toContain('100.00')
    expect(formatMYR(599_900)).toContain('5,999.00')
  })

  it('allows only guarded payment, order and shipment transitions', () => {
    expect(canTransitionPayment('pending', 'succeeded')).toBe(true)
    expect(canTransitionPayment('cancelled', 'cancelled')).toBe(false)
    expect(canTransitionPayment('refunded', 'pending')).toBe(false)
    expect(canTransitionPayment('processing', 'cancelled')).toBe(false)
    expect(canTransitionPayment('processing', 'expired')).toBe(true)
    expect(canTransitionOrder('pending_payment', 'confirmed')).toBe(true)
    expect(canTransitionOrder('fulfilled', 'processing')).toBe(true)
    expect(canTransitionOrder('closed', 'partially_fulfilled')).toBe(true)
    expect(canTransitionOrder('refunded', 'processing')).toBe(false)
    expect(canTransitionShipment('packed', 'label_created')).toBe(true)
    expect(canTransitionShipment('delivered', 'picking')).toBe(false)
  })

  it('guards box transitions while keeping reveal and shipment independent', () => {
    expect(canTransitionBox('reserved', 'paid_unopened')).toBe(true)
    expect(canTransitionBox('fulfilled', 'opened')).toBe(false)
    expect(transitionBox('void', 'reserved')).toBe('reserved')
    expect(transitionBoxForReveal('paid_unopened')).toBe('opened')
    expect(transitionBoxForReveal('fulfillment_pending')).toBe('fulfillment_pending')
    expect(transitionBoxForReveal('fulfilled')).toBe('fulfilled')
    expect(transitionBoxForShipment('opened', 'shipped')).toBe('fulfillment_pending')
    expect(transitionBoxForShipment('paid_unopened', 'delivered')).toBe('fulfilled')
    expect(() => transitionBoxForReveal('reserved')).toThrow(/cannot be revealed/i)
    expect(() => transitionBoxForReveal('on_hold')).toThrow(/cannot be revealed/i)
    expect(() => transitionBox('fulfilled', 'paid_unopened')).toThrow(/cannot move/i)
  })

  it('derives one exact ordinary order status from all related shipments', () => {
    expect(deriveOrderStatusFromShipments(['unfulfilled', 'unfulfilled'])).toBe('confirmed')
    expect(deriveOrderStatusFromShipments(['picking', 'unfulfilled'])).toBe('processing')
    expect(deriveOrderStatusFromShipments(['failed_delivery'])).toBe('processing')
    expect(deriveOrderStatusFromShipments(['returned'])).toBe('processing')
    expect(deriveOrderStatusFromShipments(['delivered', 'unfulfilled'])).toBe('partially_fulfilled')
    expect(deriveOrderStatusFromShipments(['delivered', 'returned'])).toBe('partially_fulfilled')
    expect(deriveOrderStatusFromShipments(['delivered', 'delivered'])).toBe('fulfilled')
  })

  it('keeps split-sensitive order progress neutral until customer details unlock', () => {
    expect(neutralOrderDeliveryStatus('confirmed')).toBe('delivery_preparing')
    expect(neutralOrderDeliveryStatus('processing')).toBe('delivery_in_progress')
    expect(neutralOrderDeliveryStatus('partially_fulfilled')).toBe('delivery_in_progress')
    expect(neutralOrderDeliveryStatus('fulfilled')).toBe('delivery_complete')
    expect(neutralOrderDeliveryStatus('disputed')).toBe('disputed')
  })

  it('uses one exact open-claim definition', () => {
    expect(OPEN_CLAIM_STATUSES).toEqual(['submitted', 'reviewing', 'approved'])
    expect(isOpenClaimStatus('submitted')).toBe(true)
    expect(isOpenClaimStatus('reviewing')).toBe(true)
    expect(isOpenClaimStatus('approved')).toBe(true)
    expect(isOpenClaimStatus('rejected')).toBe(false)
    expect(isOpenClaimStatus('resolved')).toBe(false)
    expect(canWidenClaimEvidence('submitted')).toBe(true)
    expect(canWidenClaimEvidence('reviewing')).toBe(true)
    expect(canWidenClaimEvidence('approved')).toBe(false)
  })

  it('hides all digital fulfilment actions on financial hold but keeps legal physical evidence', () => {
    const state = createDemoState()
    const digital = state.shipments.find((shipment) => shipment.id === 'shp-digital')!
    digital.status = 'shipped'
    const physical = state.shipments.find((shipment) => shipment.id === 'shp-shipped')!

    for (const hold of ['cancelled', 'refunded', 'disputed'] as const) {
      expect(shipmentStatusActionEligibility(hold, digital, 'delivered').eligible).toBe(false)
      expect(shipmentTrackingActionEligibility(hold, digital).eligible).toBe(false)
    }
    expect(shipmentStatusActionEligibility('disputed', physical, 'delivered').eligible).toBe(true)
    expect(shipmentStatusActionEligibility('refunded', physical, 'failed_delivery').eligible).toBe(true)
    expect(shipmentTrackingActionEligibility('disputed', physical).eligible).toBe(false)
  })

  it('accepts fictional input and blocks likely real data', () => {
    expect(validateCheckoutRequestId('checkout_0123456789abcdef0123456789abcdef')).toBe('checkout_0123456789abcdef0123456789abcdef')
    expect(() => validateCheckoutRequestId('checkout_short')).toThrow(/identity is invalid/i)
    expect(validateDemoEmail('person@example.test')).toBe('person@example.test')
    expect(() => validateDemoEmail('person@gmail.com')).toThrow(/fictional email/i)
    expect(validateDemoAddress(DEMO_ADDRESS).line1).toContain('DEMO')
    expect(() => validateDemoAddress({ ...DEMO_ADDRESS, line1: '12 Real Street' })).toThrow(/safety/i)
  })
})
