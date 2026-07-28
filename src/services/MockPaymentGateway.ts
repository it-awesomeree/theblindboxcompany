import {
  assert,
  assertRole,
  canTransitionPayment,
  getSessionUser,
  makeId,
  transitionOrder,
  transitionPayment,
  sanitizeText,
} from '../domain/guards'
import { prizeForBox } from '../domain/selectors'
import type { DemoState, Order, Payment, PaymentMethod, PaymentStatus } from '../domain/types'
import type { MockRepository } from '../data/MockRepository'
import { AuditService } from './AuditService'
import { FulfillmentService } from './FulfillmentService'
import { PrizeService } from './PrizeService'
import { ReservationService } from './ReservationService'
import { FinancialSafetyService } from './FinancialSafetyService'

export type MockPaymentAction = 'approve' | 'decline' | 'cancel' | 'expire' | 'delayed'

const ACTIVE_PAYMENT_STATUSES: PaymentStatus[] = ['created', 'pending', 'processing']

function wasCaptured(payment: Payment) {
  return payment.events.some((event) => event.type === 'succeeded' && !event.ignoredReason)
}

class DuplicatePaymentEvent extends Error {
  constructor(readonly payment: Payment) {
    super('Duplicate payment event')
  }
}

export class MockPaymentGateway {
  constructor(
    private readonly repository: MockRepository,
    private readonly audit: AuditService,
    private readonly prizes: PrizeService,
    private readonly fulfilment: FulfillmentService,
    private readonly reservations: ReservationService,
    private readonly financialSafety: FinancialSafetyService,
    private readonly now: () => string,
  ) {}

  private paymentsForOrder(state: DemoState, order: Order) {
    return order.paymentIds
      .map((id) => state.payments.find((entry) => entry.id === id))
      .filter(Boolean) as Payment[]
  }

  private assertAttemptAllowed(state: DemoState, order: Order) {
    const payments = this.paymentsForOrder(state, order)
    assert(
      !payments.some((payment) => ACTIVE_PAYMENT_STATUSES.includes(payment.status)),
      'An active payment attempt already exists for this order.',
      'PAYMENT_ACTIVE',
    )
    assert(!payments.some(wasCaptured), 'This order already has a captured payment.', 'ORDER_ALREADY_PAID')
    return payments
  }

  private authorizeEventCaller(
    state: DemoState,
    payment: Payment,
    source: 'mock_webhook' | 'admin_reconcile',
  ) {
    const caller = getSessionUser(state)
    if (source === 'admin_reconcile') {
      assertRole(caller, ['finance', 'admin', 'super_admin'], 'reconcile demo payments')
    } else {
      assertRole(caller, ['customer'], 'operate a hosted demo payment')
      assert(caller.id === payment.userId, 'This demo payment belongs to another fictional user.', 'FORBIDDEN')
    }
    return caller
  }

  createAttempt(orderId: string, method: PaymentMethod = 'FPX') {
    return this.repository.update((state) => {
      const user = getSessionUser(state)
      assertRole(user, ['customer'], 'start a demo payment')
      const now = this.now()
      this.reservations.expireDue(state, now)
      const order = state.orders.find((entry) => entry.id === orderId && entry.userId === user.id)
      assert(order, 'Demo order was not found.', 'ORDER_MISSING')
      assert(order.status === 'pending_payment', 'This order no longer accepts payment attempts.', 'ORDER_NOT_PAYABLE')
      const previous = this.assertAttemptAllowed(state, order)
      if (!this.reservations.isActive(state, order)) {
        this.reservations.renew(
          state,
          order,
          now,
          makeId('req', `${order.id}:customer-renew:${now}`),
          { id: user.id, role: user.role },
        )
      }
      const attempt = Math.max(0, ...previous.map((entry) => entry.attempt)) + 1
      const id = makeId('pay', `${order.id}:${attempt}:${now}`)
      const payment: Payment = {
        id,
        orderId: order.id,
        userId: user.id,
        attempt,
        method,
        status: 'pending',
        amountSen: order.snapshot.totals.totalSen,
        refundedSen: 0,
        createdAt: now,
        updatedAt: now,
        events: [{
          id: makeId('evt', `${id}:created`),
          requestId: makeId('req', `${id}:created`),
          type: 'created',
          source: 'mock_webhook',
          createdAt: now,
          processedAt: now,
        }],
      }
      state.payments.push(payment)
      order.paymentIds.push(id)
      order.updatedAt = now
      this.audit.append(state, {
        actorId: user.id,
        actorRole: user.role,
        action: 'payment.attempt_created',
        targetType: 'payment',
        targetId: id,
        reason: `Demo ${method} hosted-checkout attempt`,
        at: now,
        requestId: makeId('req', `${id}:attempt`),
        after: { amountSen: payment.amountSen, attempt, status: payment.status },
      })
      return payment
    })
  }

  processEvent(
    paymentId: string,
    eventId: string,
    next: PaymentStatus,
    source: 'mock_webhook' | 'admin_reconcile' = 'mock_webhook',
    rawReason = 'Processed one idempotent demo payment event',
  ) {
    const snapshot = this.repository.getSnapshot()
    const existingPayment = snapshot.payments.find((entry) => entry.id === paymentId)
    assert(existingPayment, 'Payment attempt was not found.', 'PAYMENT_MISSING')
    this.authorizeEventCaller(snapshot, existingPayment, source)
    const existingDuplicate = snapshot.payments.some((entry) =>
      entry.events.some((event) => event.id === eventId),
    )
    if (existingDuplicate) {
      return { payment: existingPayment, changed: false, message: 'Duplicate event ignored safely.' }
    }

    try {
      return this.repository.update((state) => {
        const payment = state.payments.find((entry) => entry.id === paymentId)
        assert(payment, 'Payment attempt was not found.', 'PAYMENT_MISSING')
        const caller = this.authorizeEventCaller(state, payment, source)
        const duplicate = state.payments.some((entry) =>
          entry.events.some((event) => event.id === eventId),
        )
        if (duplicate) throw new DuplicatePaymentEvent(payment)
        const now = this.now()
        this.reservations.expireDue(state, now)
        const requestId = makeId('req', eventId)
        const order = state.orders.find((entry) => entry.id === payment.orderId)
        assert(order, 'Payment order is missing.', 'ORDER_MISSING')
        const reason = sanitizeText(rawReason, 240)
        const sensitive = next === 'disputed' || payment.status === 'disputed'
        if (sensitive) {
          assert(source === 'admin_reconcile', 'Dispute changes require protected finance review.', 'FORBIDDEN')
          assert(reason.length >= 8, 'A dispute resolution reason is required.', 'REASON_REQUIRED')
        }
        assert(
          (next !== 'partially_refunded' || payment.status === 'disputed') &&
          (next !== 'refunded' || payment.status === 'disputed'),
          'Use the guarded refund workflow for refund events.',
          'REFUND_GUARD_REQUIRED',
        )
        if (next === 'succeeded') {
          const orderPayments = this.paymentsForOrder(state, order)
          const otherCaptured = orderPayments.find((entry) => entry.id !== payment.id && wasCaptured(entry))
          const otherActive = orderPayments.find((entry) =>
            entry.id !== payment.id && ACTIVE_PAYMENT_STATUSES.includes(entry.status),
          )
          if (otherCaptured || otherActive) {
            payment.updatedAt = now
            payment.events.push({
              id: eventId,
              requestId,
              type: next,
              source,
              createdAt: now,
              processedAt: now,
              ignoredReason: otherCaptured
                ? `Order already captured by ${otherCaptured.id}`
                : `Order has active payment ${otherActive!.id}`,
            })
            return { payment, changed: false, message: 'Conflicting success event was recorded and ignored safely.' }
          }
        }
        if (!canTransitionPayment(payment.status, next)) {
          payment.updatedAt = now
          payment.events.push({
            id: eventId,
            requestId,
            type: next,
            source,
            createdAt: now,
            processedAt: now,
            ignoredReason: `Out-of-order: ${payment.status} cannot become ${next}`,
          })
          return { payment, changed: false, message: 'Out-of-order event recorded but did not change anything.' }
        }
        if (next === 'succeeded') {
          assert(payment.amountSen === order.snapshot.totals.totalSen, 'Payment amount failed the server-like total check.', 'AMOUNT_MISMATCH')
        }
        const before = payment.status
        payment.status = transitionPayment(payment.status, next)
        if (before === 'disputed' && next === 'refunded') payment.refundedSen = payment.amountSen
        payment.updatedAt = now
        payment.events.push({ id: eventId, requestId, type: next, source, createdAt: now, processedAt: now })
        if (next === 'succeeded') {
          if (before === 'disputed') {
            this.financialSafety.resumeDispute(
              state,
              order,
              now,
              reason,
              requestId,
              { id: caller.id, role: caller.role },
            )
          } else {
            assert(order.status === 'pending_payment' || order.status === 'confirmed', 'Paid event does not match order state.', 'ORDER_STATE_MISMATCH')
          }
          if (before !== 'disputed' && order.status === 'pending_payment') {
            assert(this.reservations.isActive(state, order), 'The unpaid stock reservation is no longer active.', 'RESERVATION_EXPIRED')
            order.status = transitionOrder(order.status, 'confirmed')
            this.prizes.allocatePaidBoxes(state, order, now)
            this.fulfilment.createForPaidOrder(state, order, now)
            order.timeline.push({ id: makeId('tl', `${order.id}:paid`), status: 'confirmed', label: 'Idempotent mock webhook confirmed payment', at: now })
          }
        } else if (before === 'disputed' && next === 'partially_refunded') {
          this.financialSafety.resumeDispute(
            state,
            order,
            now,
            reason,
            requestId,
            { id: caller.id, role: caller.role },
          )
        } else if (next === 'disputed') {
          this.financialSafety.stop(
            state,
            order,
            'disputed',
            now,
            reason,
            requestId,
            { id: caller.id, role: caller.role },
          )
        } else if (before === 'disputed' && next === 'refunded') {
          this.financialSafety.stop(
            state,
            order,
            'refunded',
            now,
            reason,
            requestId,
            { id: caller.id, role: caller.role },
          )
        } else if ((next === 'cancelled' || next === 'expired') && order.status === 'pending_payment') {
          const anotherActive = this.paymentsForOrder(state, order).some((entry) =>
            entry.id !== payment.id && ACTIVE_PAYMENT_STATUSES.includes(entry.status),
          )
          if (!anotherActive) {
            this.reservations.release(
              state,
              order,
              now,
              requestId,
              `Payment ${next}; unpaid stock reservation released once`,
              source === 'mock_webhook'
                ? { id: 'mock-hitpay', role: 'finance' }
                : { id: caller.id, role: caller.role },
            )
          }
        }
        order.updatedAt = now
        this.audit.append(state, {
          actorId: source === 'mock_webhook' ? 'mock-hitpay' : state.sessionUserId ?? 'system',
          actorRole: source === 'mock_webhook' ? 'finance' : getSessionUser(state)?.role ?? 'finance',
          action: `payment.${next}`,
          targetType: 'payment',
          targetId: payment.id,
          reason,
          at: now,
          requestId,
          eventId,
          before: { status: before },
          after: { status: next, orderStatus: order.status },
        })
        return { payment, changed: before !== next, message: `Payment is now ${next}.` }
      })
    } catch (caught) {
      if (caught instanceof DuplicatePaymentEvent) {
        return { payment: caught.payment, changed: false, message: 'Duplicate event ignored safely.' }
      }
      throw caught
    }
  }

  adminRetry(paymentId: string, reason: string) {
    return this.repository.update((state) => {
      const actor = getSessionUser(state)
      assertRole(actor, ['finance', 'admin', 'super_admin'], 'retry demo payments')
      const cleanReason = sanitizeText(reason, 240)
      assert(cleanReason.length >= 8, 'Give a reason of at least 8 characters for this retry.', 'REASON_REQUIRED')
      const now = this.now()
      this.reservations.expireDue(state, now)
      const previous = state.payments.find((entry) => entry.id === paymentId)
      assert(previous, 'Payment attempt was not found.', 'PAYMENT_MISSING')
      assert(['failed', 'cancelled', 'expired'].includes(previous.status), 'Only terminal failed demo attempts can be retried.', 'PAYMENT_ACTIVE')
      const order = state.orders.find((entry) => entry.id === previous.orderId)
      assert(order?.status === 'pending_payment', 'Order is not payable.', 'ORDER_NOT_PAYABLE')
      const attempts = this.assertAttemptAllowed(state, order)
      if (!this.reservations.isActive(state, order)) {
        this.reservations.renew(
          state,
          order,
          now,
          makeId('req', `${order.id}:admin-renew:${now}`),
          { id: actor.id, role: actor.role },
        )
      }
      const attempt = Math.max(0, ...attempts.map((entry) => entry.attempt)) + 1
      const id = makeId('pay', `${order.id}:admin-retry:${attempt}:${now}`)
      const retry: Payment = {
        id,
        orderId: order.id,
        userId: order.userId,
        attempt,
        method: previous.method,
        status: 'pending',
        amountSen: order.snapshot.totals.totalSen,
        refundedSen: 0,
        createdAt: now,
        updatedAt: now,
        events: [{
          id: makeId('evt', `${id}:created`),
          requestId: makeId('req', `${id}:created`),
          type: 'created',
          source: 'admin_reconcile',
          createdAt: now,
          processedAt: now,
        }],
      }
      state.payments.push(retry)
      order.paymentIds.push(id)
      this.audit.append(state, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'payment.admin_retry',
        targetType: 'payment',
        targetId: id,
        reason: cleanReason,
        at: now,
        requestId: makeId('req', `${id}:retry`),
        before: { paymentId: previous.id, status: previous.status },
        after: { paymentId: id, status: retry.status, attempt },
      })
      return retry
    })
  }

  dispute(paymentId: string, reason: string, eventId: string) {
    return this.processEvent(paymentId, eventId, 'disputed', 'admin_reconcile', reason)
  }

  resolveDispute(paymentId: string, outcome: 'merchant_won' | 'refund', reason: string, eventId: string) {
    const payment = this.repository.getSnapshot().payments.find((entry) => entry.id === paymentId)
    assert(payment, 'Payment attempt was not found.', 'PAYMENT_MISSING')
    const wonStatus: PaymentStatus = payment.refundedSen > 0 ? 'partially_refunded' : 'succeeded'
    return this.processEvent(
      paymentId,
      eventId,
      outcome === 'merchant_won' ? wonStatus : 'refunded',
      'admin_reconcile',
      reason,
    )
  }

  act(paymentId: string, action: MockPaymentAction) {
    const payment = this.repository.getSnapshot().payments.find((entry) => entry.id === paymentId)
    assert(payment, 'Payment attempt was not found.', 'PAYMENT_MISSING')
    const mapping: Record<MockPaymentAction, PaymentStatus> = {
      approve: 'succeeded',
      decline: 'failed',
      cancel: 'cancelled',
      expire: 'expired',
      delayed: 'processing',
    }
    return this.processEvent(paymentId, makeId('evt', `${paymentId}:${action}:${payment.events.length}`), mapping[action])
  }

  refund(paymentId: string, amountSen: number, reason: string, requestId: string) {
    return this.repository.update((state) => {
      const actor = getSessionUser(state)
      assertRole(actor, ['finance', 'admin', 'super_admin'], 'refund demo payments')
      const payment = state.payments.find((entry) => entry.id === paymentId)
      assert(payment, 'Payment was not found.', 'PAYMENT_MISSING')
      const existing = state.payments.some((entry) => entry.events.some((event) => event.requestId === requestId))
      if (existing) return { payment, changed: false, message: 'Duplicate refund request ignored safely.' }
      const cleanReason = sanitizeText(reason, 240)
      assert(cleanReason.length >= 8, 'Give a reason of at least 8 characters for this refund.', 'REASON_REQUIRED')
      assert(['succeeded', 'partially_refunded'].includes(payment.status), 'Only succeeded demo payments can be refunded.', 'NOT_REFUNDABLE')
      assert(Number.isInteger(amountSen) && amountSen > 0, 'Refund must be a positive amount in sen.', 'INVALID_REFUND')
      assert(payment.refundedSen + amountSen <= payment.amountSen, 'Refund exceeds the paid demo amount.', 'REFUND_TOO_HIGH')
      const before = { status: payment.status, refundedSen: payment.refundedSen }
      payment.refundedSen += amountSen
      const full = payment.refundedSen === payment.amountSen
      payment.status = transitionPayment(payment.status, full ? 'refunded' : 'partially_refunded')
      const now = this.now()
      payment.updatedAt = now
      payment.events.push({
        id: makeId('evt', requestId),
        requestId,
        type: payment.status,
        source: 'admin_reconcile',
        createdAt: now,
        processedAt: now,
      })
      const order = state.orders.find((entry) => entry.id === payment.orderId)
      if (order && full && order.status !== 'refunded') {
        const financialReason = sanitizeText(`${cleanReason}; prize allocation retained`, 240)
        this.financialSafety.stop(
          state,
          order,
          'refunded',
          now,
          financialReason,
          requestId,
          { id: actor.id, role: actor.role },
        )
      }
      this.audit.append(state, {
        actorId: actor.id,
        actorRole: actor.role,
        action: full ? 'payment.refunded' : 'payment.partially_refunded',
        targetType: 'payment',
        targetId: payment.id,
        reason: cleanReason,
        at: now,
        requestId,
        before,
        after: { status: payment.status, refundedSen: payment.refundedSen, allocationsReturned: 0 },
      })
      return { payment, changed: true, message: full ? 'Full demo refund recorded.' : 'Partial demo refund recorded.' }
    })
  }

  prizeSummary(paymentId: string) {
    const state = this.repository.getSnapshot()
    const caller = getSessionUser(state)
    assertRole(caller, ['customer', 'admin', 'super_admin'], 'view prize summaries')
    const payment = state.payments.find((entry) => entry.id === paymentId)
    assert(payment, 'Payment attempt was not found.', 'PAYMENT_MISSING')
    const order = state.orders.find((entry) => entry.id === payment?.orderId)
    assert(order, 'Payment order is missing.', 'ORDER_MISSING')
    if (caller.role === 'customer') {
      assert(payment.userId === caller.id && order.userId === caller.id, 'This prize summary belongs to another fictional user.', 'FORBIDDEN')
    }
    return order.boxIds
      .map((id) => state.boxes.find((box) => box.id === id))
      .filter((box) => caller.role !== 'customer' || Boolean(box?.revealedAt))
      .map((box) => prizeForBox(state, box))
      .filter(Boolean)
  }
}
