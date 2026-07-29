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
import {
  ACTIVE_PAYMENT_STATUSES,
  paymentAttemptCreationEligibility,
  paymentRetryEligibility,
  paymentWasCaptured,
} from '../domain/paymentEligibility'
import {
  CLAIM_REFUND_LINK_ACTION,
  claimRefundLinkedHistoryNote,
} from '../domain/refundLink'
import { refreshOrderFulfillment } from '../domain/orderFulfillment'
import { prizeForBox } from '../domain/selectors'
import type {
  DemoState,
  Order,
  Payment,
  PaymentEvent,
  PaymentMethod,
  PaymentStatus,
  Role,
} from '../domain/types'
import type { MockRepository } from '../data/MockRepository'
import { AuditService } from './AuditService'
import { FulfillmentService } from './FulfillmentService'
import { PrizeService } from './PrizeService'
import { ReservationService } from './ReservationService'
import { FinancialSafetyService } from './FinancialSafetyService'

export type MockPaymentAction = 'approve' | 'decline' | 'cancel' | 'expire' | 'delayed'

class DuplicatePaymentEvent extends Error {
  constructor(readonly payment: Payment) {
    super('Duplicate payment event')
  }
}

function storedPaymentEvent(state: DemoState, eventId: string) {
  for (const payment of state.payments) {
    const event = payment.events.find((entry) => entry.id === eventId)
    if (event) return { payment, event }
  }
  return undefined
}

function assertExactEventReplay(
  stored: { payment: Payment; event: PaymentEvent },
  paymentId: string,
  next: PaymentStatus,
  source: 'mock_webhook' | 'admin_reconcile',
) {
  assert(
    stored.payment.id === paymentId &&
      stored.event.type === next &&
      stored.event.source === source,
    'Payment event identity was already used for a different payment, type, or source.',
    'IDEMPOTENCY_CONFLICT',
  )
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

  private assertAttemptAllowed(
    state: DemoState,
    order: Order,
    retryPayment?: Payment,
  ) {
    const payments = this.paymentsForOrder(state, order)
    const eligibility = retryPayment
      ? paymentRetryEligibility(order, retryPayment, payments)
      : paymentAttemptCreationEligibility(order, payments)
    assert(eligibility.eligible, eligibility.reason, eligibility.code)
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

  private appendIgnoredAdminAudit(
    state: DemoState,
    payment: Payment,
    actor: { id: string; role: Role },
    attemptedStatus: PaymentStatus,
    ignoredReason: string,
    at: string,
    requestId: string,
    eventId: string,
  ) {
    this.audit.append(state, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'payment.event_ignored',
      targetType: 'payment',
      targetId: payment.id,
      reason: ignoredReason,
      at,
      requestId,
      eventId,
      outcome: 'ignored',
      before: { status: payment.status },
      after: { status: payment.status, attemptedStatus, ignoredReason },
    })
  }

  createAttempt(
    orderId: string,
    method: PaymentMethod = 'FPX',
    retryPaymentId?: string,
  ) {
    return this.repository.update((state) => {
      const user = getSessionUser(state)
      assertRole(user, ['customer'], 'start a demo payment')
      const now = this.now()
      this.reservations.expireDue(state, now)
      const order = state.orders.find((entry) => entry.id === orderId && entry.userId === user.id)
      assert(order, 'Demo order was not found.', 'ORDER_MISSING')
      const orderPayments = this.paymentsForOrder(state, order)
      const retryPayment = retryPaymentId
        ? orderPayments.find((entry) => entry.id === retryPaymentId)
        : undefined
      if (retryPaymentId) {
        assert(
          retryPayment,
          'The retry payment attempt does not belong to this order.',
          'PAYMENT_ORDER_MISMATCH',
        )
      }
      const previous = this.assertAttemptAllowed(state, order, retryPayment)
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
    const existingEvent = storedPaymentEvent(snapshot, eventId)
    if (existingEvent) {
      assertExactEventReplay(existingEvent, paymentId, next, source)
      return { payment: existingPayment, changed: false, message: 'Duplicate event ignored safely.' }
    }

    try {
      return this.repository.update((state) => {
        const payment = state.payments.find((entry) => entry.id === paymentId)
        assert(payment, 'Payment attempt was not found.', 'PAYMENT_MISSING')
        const caller = this.authorizeEventCaller(state, payment, source)
        const concurrentEvent = storedPaymentEvent(state, eventId)
        if (concurrentEvent) {
          assertExactEventReplay(concurrentEvent, paymentId, next, source)
          throw new DuplicatePaymentEvent(payment)
        }
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
          const otherCaptured = orderPayments.find((entry) =>
            entry.id !== payment.id && paymentWasCaptured(entry),
          )
          const otherActive = orderPayments.find((entry) =>
            entry.id !== payment.id && ACTIVE_PAYMENT_STATUSES.includes(entry.status),
          )
          if (otherCaptured || otherActive) {
            const ignoredReason = otherCaptured
              ? `Order already captured by ${otherCaptured.id}`
              : `Order has active payment ${otherActive!.id}`
            payment.updatedAt = now
            payment.events.push({
              id: eventId,
              requestId,
              type: next,
              source,
              createdAt: now,
              processedAt: now,
              ignoredReason,
            })
            if (source === 'admin_reconcile') {
              this.appendIgnoredAdminAudit(
                state,
                payment,
                caller,
                next,
                ignoredReason,
                now,
                requestId,
                eventId,
              )
            }
            return { payment, changed: false, message: 'Conflicting success event was recorded and ignored safely.' }
          }
        }
        if (!canTransitionPayment(payment.status, next)) {
          const ignoredReason = `Out-of-order: ${payment.status} cannot become ${next}`
          payment.updatedAt = now
          payment.events.push({
            id: eventId,
            requestId,
            type: next,
            source,
            createdAt: now,
            processedAt: now,
            ignoredReason,
          })
          if (source === 'admin_reconcile') {
            this.appendIgnoredAdminAudit(
              state,
              payment,
              caller,
              next,
              ignoredReason,
              now,
              requestId,
              eventId,
            )
          }
          return {
            payment,
            changed: false,
            message: 'Out-of-order event was recorded without changing payment status.',
          }
        }
        if (next === 'succeeded') {
          assert(payment.amountSen === order.snapshot.totals.totalSen, 'Payment amount failed the server-like total check.', 'AMOUNT_MISMATCH')
        }
        const before = payment.status
        const disputeRefundAmount =
          before === 'disputed' && next === 'refunded'
            ? payment.amountSen - payment.refundedSen
            : 0
        payment.status = transitionPayment(payment.status, next)
        if (before === 'disputed' && next === 'refunded') payment.refundedSen = payment.amountSen
        payment.updatedAt = now
        payment.events.push({
          id: eventId,
          requestId,
          type: next,
          source,
          createdAt: now,
          processedAt: now,
          ...(disputeRefundAmount > 0
            ? {
                refundIntent: {
                  paymentId: payment.id,
                  amountSen: disputeRefundAmount,
                  reason,
                },
              }
            : {}),
        })
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
      const order = state.orders.find((entry) => entry.id === previous.orderId)
      assert(order, 'Payment order was not found.', 'ORDER_MISSING')
      const attempts = this.assertAttemptAllowed(state, order, previous)
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

  refund(
    paymentId: string,
    amountSen: number,
    reason: string,
    requestId: string,
    claimId?: string,
  ) {
    const snapshot = this.repository.getSnapshot()
    const currentActor = getSessionUser(snapshot)
    assertRole(currentActor, ['finance', 'admin', 'super_admin'], 'refund demo payments')
    const cleanRequestId = sanitizeText(requestId, 120)
    const cleanReason = sanitizeText(reason, 240)
    const cleanClaimId = claimId === undefined ? undefined : sanitizeText(claimId, 120)
    assert(
      cleanRequestId.length >= 4 && cleanRequestId === requestId,
      'Refund request identity is invalid.',
      'INVALID_REFUND_REQUEST_ID',
    )
    assert(
      cleanClaimId === undefined ||
        (cleanClaimId.length >= 4 && cleanClaimId === claimId),
      'Refund claim identity is invalid.',
      'INVALID_REFUND_CLAIM_ID',
    )
    assert(cleanReason.length >= 8, 'Give a reason of at least 8 characters for this refund.', 'REASON_REQUIRED')
    assert(Number.isInteger(amountSen) && amountSen > 0, 'Refund must be a positive amount in sen.', 'INVALID_REFUND')
    const replayOwner = snapshot.payments.find((entry) =>
      entry.events.some((event) => event.requestId === cleanRequestId),
    )
    if (replayOwner) {
      const replayEvent = replayOwner.events.find((event) => event.requestId === cleanRequestId)!
      const exactReplay =
        replayEvent.refundIntent?.paymentId === paymentId &&
        replayEvent.refundIntent.amountSen === amountSen &&
        replayEvent.refundIntent.reason === cleanReason &&
        replayEvent.refundIntent.claimId === cleanClaimId
      assert(
        exactReplay,
        'Refund request identity was already used for different payment, amount, reason, or claim.',
        'IDEMPOTENCY_CONFLICT',
      )
      return {
        payment: replayOwner,
        changed: false,
        message: 'Exact refund replay returned the original result.',
      }
    }

    return this.repository.update((state) => {
      const actor = getSessionUser(state)
      assertRole(actor, ['finance', 'admin', 'super_admin'], 'refund demo payments')
      const payment = state.payments.find((entry) => entry.id === paymentId)
      assert(payment, 'Payment was not found.', 'PAYMENT_MISSING')
      assert(
        !state.payments.some((entry) =>
          entry.events.some((event) => event.requestId === cleanRequestId),
        ),
        'Refund request identity changed before it could be saved.',
        'IDEMPOTENCY_CONFLICT',
      )
      assert(['succeeded', 'partially_refunded'].includes(payment.status), 'Only succeeded demo payments can be refunded.', 'NOT_REFUNDABLE')
      assert(payment.refundedSen + amountSen <= payment.amountSen, 'Refund exceeds the paid demo amount.', 'REFUND_TOO_HIGH')
      const order = state.orders.find((entry) => entry.id === payment.orderId)
      assert(order, 'Payment order is missing.', 'ORDER_MISSING')
      const now = this.now()
      const eventId = makeId('evt', cleanRequestId)
      const linkedClaim = cleanClaimId === undefined
        ? undefined
        : state.claims.find((claim) => claim.id === cleanClaimId)
      if (cleanClaimId !== undefined) {
        assert(linkedClaim, 'The refund claim was not found.', 'CLAIM_MISSING')
        assert(
          linkedClaim.orderId === payment.orderId &&
            linkedClaim.userId === payment.userId &&
            order.userId === linkedClaim.userId,
          'The refund claim must belong to the same order and customer as the payment.',
          'CLAIM_PAYMENT_MISMATCH',
        )
        assert(
          linkedClaim.status === 'approved',
          'A claim must be approved before its refund can be linked.',
          'CLAIM_NOT_APPROVED',
        )
        assert(
          linkedClaim.linkedRefundEventId === undefined &&
            !state.payments.some((entry) =>
              entry.events.some((event) => event.refundIntent?.claimId === linkedClaim.id),
            ),
          'This claim is already linked to a refund event.',
          'CLAIM_REFUND_ALREADY_LINKED',
        )
        assert(
          (
            (
              linkedClaim.remedyState === 'none' &&
              linkedClaim.rma === undefined
            ) ||
            (
              linkedClaim.remedyState === 'rma_inspected' &&
              linkedClaim.rma?.status === 'inspected'
            )
          ) &&
            linkedClaim.replacementShipmentId === undefined,
          'A claim can link a refund only before another remedy or after its RMA inspection.',
          'REMEDY_CONFLICT',
        )
        assert(
          !state.claims.some((claim) =>
            claim.id !== linkedClaim.id &&
            (
              claim.linkedRefundEventId === eventId ||
              claim.resolutionReference === eventId
            ),
          ),
          'This refund event identity is already linked to another claim.',
          'REFUND_EVENT_ALREADY_LINKED',
        )
        assert(
          Date.parse(now) >= Date.parse(linkedClaim.createdAt) &&
            Date.parse(now) >= Date.parse(linkedClaim.updatedAt),
          'A linked refund event cannot be recorded before the approved claim history.',
          'REFUND_BEFORE_CLAIM',
        )
      }
      const before = { status: payment.status, refundedSen: payment.refundedSen }
      payment.refundedSen += amountSen
      const full = payment.refundedSen === payment.amountSen
      payment.status = transitionPayment(payment.status, full ? 'refunded' : 'partially_refunded')
      payment.updatedAt = now
      payment.events.push({
        id: eventId,
        requestId: cleanRequestId,
        type: payment.status,
        source: 'admin_reconcile',
        createdAt: now,
        processedAt: now,
        refundIntent: {
          paymentId: payment.id,
          amountSen,
          reason: cleanReason,
          ...(cleanClaimId !== undefined ? { claimId: cleanClaimId } : {}),
        },
      })
      if (full && order.status !== 'refunded') {
        const financialReason = sanitizeText(`${cleanReason}; prize allocation retained`, 240)
        this.financialSafety.stop(
          state,
          order,
          'refunded',
          now,
          financialReason,
          cleanRequestId,
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
        requestId: cleanRequestId,
        eventId,
        before,
        after: {
          allocationsReturned: 0,
          ...(cleanClaimId !== undefined ? { claimId: cleanClaimId } : {}),
          refundedSen: payment.refundedSen,
          status: payment.status,
        },
      })
      if (linkedClaim) {
        linkedClaim.linkedRefundEventId = eventId
        linkedClaim.remedyState = 'refund_linked'
        linkedClaim.updatedAt = now
        linkedClaim.history.push({
          id: `${linkedClaim.id}-h-${String(linkedClaim.history.length + 1).padStart(2, '0')}`,
          status: linkedClaim.status,
          note: claimRefundLinkedHistoryNote(eventId),
          actorId: actor.id,
          actorRole: actor.role,
          at: now,
        })
        this.audit.append(state, {
          actorId: actor.id,
          actorRole: actor.role,
          action: CLAIM_REFUND_LINK_ACTION,
          targetType: 'claim',
          targetId: linkedClaim.id,
          reason: cleanReason,
          at: now,
          requestId: cleanRequestId,
          eventId,
          before: { linkedRefundEventId: null, status: 'approved' },
          after: {
            linkedRefundEventId: eventId,
            paymentId: payment.id,
            status: 'approved',
          },
        })
        refreshOrderFulfillment(
          state,
          order,
          now,
          claimRefundLinkedHistoryNote(eventId),
        )
      }
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
