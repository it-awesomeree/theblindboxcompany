import { describe, expect, it } from 'vitest'
import { BOX_PRICE_SEN, PRIZES } from '../src/domain/constants'
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
import { deriveOrderStatusFromShipments } from '../src/domain/orderStatus'

describe('Series 001 and domain guards', () => {
  it('has exactly 10,000 fixed allocations and every value clears RM100', () => {
    expect(PRIZES.reduce((sum, prize) => sum + prize.allocation, 0)).toBe(10_000)
    expect(PRIZES.every((prize) => prize.valueSen >= BOX_PRICE_SEN)).toBe(true)
    expect(PRIZES.at(-1)?.allocation).toBe(1)
    expect(PRIZES.at(-1)?.valueSen).toBe(599_900)
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

  it('accepts fictional input and blocks likely real data', () => {
    expect(validateCheckoutRequestId('checkout_0123456789abcdef0123456789abcdef')).toBe('checkout_0123456789abcdef0123456789abcdef')
    expect(() => validateCheckoutRequestId('checkout_short')).toThrow(/identity is invalid/i)
    expect(validateDemoEmail('person@example.test')).toBe('person@example.test')
    expect(() => validateDemoEmail('person@gmail.com')).toThrow(/fictional email/i)
    expect(validateDemoAddress(DEMO_ADDRESS).line1).toContain('DEMO')
    expect(() => validateDemoAddress({ ...DEMO_ADDRESS, line1: '12 Real Street' })).toThrow(/safety/i)
  })
})
