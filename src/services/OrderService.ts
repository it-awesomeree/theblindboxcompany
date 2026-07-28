import {
  BOX_PRICE_SEN,
  MAX_CART_QUANTITY,
  POLICY_ACKNOWLEDGEMENT,
  RESERVATION_MINUTES,
  SERIES_ID,
  SHIPPING_FEES,
} from '../domain/constants'
import {
  assert,
  assertRole,
  getSessionUser,
  makeId,
  validateCheckoutRequestId,
  validateDemoAddress,
} from '../domain/guards'
import type {
  Address,
  DemoState,
  Order,
  ShippingMethod,
  User,
} from '../domain/types'
import type { MockRepository } from '../data/MockRepository'
import { AuditService } from './AuditService'
import { ReservationService } from './ReservationService'

export interface CheckoutInput {
  requestId: string
  quantity: number
  shippingMethod: ShippingMethod
  address: Address
  acknowledged: boolean
  displayedTotalSen?: number
}

export class OrderService {
  constructor(
    private readonly repository: MockRepository,
    private readonly audit: AuditService,
    private readonly reservations: ReservationService,
    private readonly now: () => string,
  ) {}

  expireReservations() {
    const at = this.now()
    const due = this.reservations.dueOrders(this.repository.getSnapshot(), at)
    if (due.length === 0) {
      return { changed: false, count: 0, orderIds: [] as string[] }
    }
    return this.repository.update((state) => {
      const expired = this.reservations.expireDue(state, at)
      return { changed: expired.length > 0, count: expired.length, orderIds: expired.map((order) => order.id) }
    })
  }

  setCartQuantity(quantity: number) {
    assert(Number.isInteger(quantity) && quantity >= 0 && quantity <= MAX_CART_QUANTITY, 'Choose 0 to 10 demo boxes.', 'INVALID_QUANTITY')
    this.repository.update((state) => {
      state.cart = quantity === 0 ? [] : [{ seriesId: SERIES_ID, quantity, unitPriceSen: BOX_PRICE_SEN }]
    })
  }

  private replayFor(
    state: DemoState,
    user: User,
    input: CheckoutInput,
    address: Address,
  ) {
    const existing = state.orders.find((order) => order.checkoutRequestId === input.requestId)
    if (!existing) return undefined
    assert(
      existing.userId === user.id,
      'This checkout request identity belongs to another fictional account.',
      'CHECKOUT_REQUEST_CONFLICT',
    )
    const exactReplay =
      existing.snapshot.quantity === input.quantity &&
      existing.snapshot.shippingMethod === input.shippingMethod &&
      JSON.stringify(existing.snapshot.address) === JSON.stringify(address) &&
      existing.snapshot.acknowledgement === POLICY_ACKNOWLEDGEMENT &&
      (input.displayedTotalSen === undefined ||
        input.displayedTotalSen === existing.snapshot.totals.totalSen)
    assert(
      exactReplay,
      'Checkout request replay does not match the original intent.',
      'CHECKOUT_REQUEST_MISMATCH',
    )
    return existing
  }

  create(input: CheckoutInput): Order {
    const requestId = validateCheckoutRequestId(input.requestId)
    assert(Number.isInteger(input.quantity) && input.quantity > 0 && input.quantity <= MAX_CART_QUANTITY, 'Choose 1 to 10 demo boxes.', 'INVALID_QUANTITY')
    assert(input.acknowledged, 'Please accept the published demo odds and policy.', 'ACK_REQUIRED')
    assert(input.shippingMethod in SHIPPING_FEES, 'Choose a valid demo shipping method.', 'INVALID_SHIPPING')
    const address = validateDemoAddress(input.address)
    const current = this.repository.getSnapshot()
    const currentUser = getSessionUser(current)
    assertRole(currentUser, ['customer'], 'place a demo order')
    const replay = this.replayFor(current, currentUser, { ...input, requestId }, address)
    if (replay) return replay

    return this.repository.update((state) => {
      const user = getSessionUser(state)
      assertRole(user, ['customer'], 'place a demo order')
      const concurrentReplay = this.replayFor(state, user, { ...input, requestId }, address)
      if (concurrentReplay) return concurrentReplay
      const now = this.now()
      this.reservations.expireDue(state, now)
      const series = state.series.find((entry) => entry.id === SERIES_ID && entry.status === 'published')
      assert(series, 'Published Series 001 is unavailable.', 'SERIES_MISSING')
      const assigned = series.inventory.reduce((sum, counter) => sum + counter.assigned, 0)
      assert(series.allocationTotal - assigned - series.reservedBoxes >= input.quantity, 'Not enough demo boxes remain.', 'SOLD_OUT')
      const shippingSen = SHIPPING_FEES[input.shippingMethod]
      const totals = {
        itemSubtotalSen: BOX_PRICE_SEN * input.quantity,
        shippingSen,
        totalSen: BOX_PRICE_SEN * input.quantity + shippingSen,
      }
      if (input.displayedTotalSen !== undefined) {
        assert(input.displayedTotalSen === totals.totalSen, 'Displayed total did not match the server-like recalculation.', 'TOTAL_TAMPERED')
      }
      const seed = `${user.id}:${requestId}`
      const orderId = makeId('ord', seed)
      const reservationExpiresAt = new Date(new Date(now).getTime() + RESERVATION_MINUTES * 60_000).toISOString()
      const boxIds = Array.from({ length: input.quantity }, (_, index) => makeId('box', `${seed}:${index + 1}`))
      const order: Order = {
        id: orderId,
        checkoutRequestId: requestId,
        userId: user.id,
        status: 'pending_payment',
        snapshot: {
          itemName: 'Series 001 Blind Box',
          seriesId: SERIES_ID,
          quantity: input.quantity,
          unitPriceSen: BOX_PRICE_SEN,
          shippingMethod: input.shippingMethod,
          address,
          oddsVersion: series.oddsVersion,
          policyVersion: series.policyVersion,
          acknowledgement: POLICY_ACKNOWLEDGEMENT,
          totals,
        },
        paymentIds: [],
        boxIds,
        claimIds: [],
        reservationExpiresAt,
        createdAt: now,
        updatedAt: now,
        timeline: [{ id: makeId('tl', `${orderId}:created`), status: 'pending_payment', label: 'Demo order and stock reservation created', at: now }],
      }
      state.orders.push(order)
      state.boxes.push(...boxIds.map((id, index) => ({
        id,
        manifestId: `TBBC-001-${id.slice(-7).toUpperCase()}`,
        orderId,
        ownerId: user.id,
        seriesId: SERIES_ID,
        number: index + 1,
        status: 'reserved' as const,
      })))
      series.reservedBoxes += input.quantity
      state.cart = []
      this.audit.append(state, {
        actorId: user.id,
        actorRole: user.role,
        action: 'order.created',
        targetType: 'order',
        targetId: order.id,
        reason: 'Customer accepted demo odds and policy',
        at: now,
        requestId,
        after: { totals, quantity: input.quantity, reservationExpiresAt },
      })
      return order
    })
  }

  listMine() {
    const state = this.repository.getSnapshot()
    const user = getSessionUser(state)
    assertRole(user, ['customer'], 'view customer orders')
    return state.orders.filter((order) => order.userId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  findOwned(orderId: string) {
    const state = this.repository.getSnapshot()
    const user = getSessionUser(state)
    assertRole(user, ['customer'], 'view this order')
    const order = state.orders.find((entry) => entry.id === orderId)
    assert(order && order.userId === user.id, 'Order not found for this fictional account.', 'ORDER_MISSING')
    return order
  }

}
