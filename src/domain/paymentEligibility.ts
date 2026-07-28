import { canTransitionPayment } from './guards'
import type { Order, Payment, PaymentStatus } from './types'

export const ACTIVE_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'created',
  'pending',
  'processing',
]

export const RETRYABLE_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'failed',
  'cancelled',
  'expired',
]

export interface PaymentEligibility {
  eligible: boolean
  reason: string
  code: string
}

export function paymentWasCaptured(payment: Payment) {
  return payment.events.some((event) => event.type === 'succeeded' && !event.ignoredReason)
}

export function paymentAttemptCreationEligibility(
  order: Order,
  orderPayments: readonly Payment[],
): PaymentEligibility {
  if (order.status !== 'pending_payment') {
    return {
      eligible: false,
      reason: 'This order no longer accepts payment attempts.',
      code: 'ORDER_NOT_PAYABLE',
    }
  }
  if (orderPayments.some((payment) => ACTIVE_PAYMENT_STATUSES.includes(payment.status))) {
    return {
      eligible: false,
      reason: 'An active payment attempt already exists for this order.',
      code: 'PAYMENT_ACTIVE',
    }
  }
  if (orderPayments.some(paymentWasCaptured)) {
    return {
      eligible: false,
      reason: 'This order already has a captured payment.',
      code: 'ORDER_ALREADY_PAID',
    }
  }
  return {
    eligible: true,
    reason: 'This unpaid order can create one payment attempt.',
    code: 'PAYMENT_ATTEMPT_ALLOWED',
  }
}

export function paymentRetryEligibility(
  order: Order,
  payment: Payment,
  orderPayments: readonly Payment[],
): PaymentEligibility {
  if (
    payment.orderId !== order.id ||
    !orderPayments.some((entry) => entry.id === payment.id)
  ) {
    return {
      eligible: false,
      reason: 'This payment attempt does not belong to the order.',
      code: 'PAYMENT_ORDER_MISMATCH',
    }
  }
  if (!RETRYABLE_PAYMENT_STATUSES.includes(payment.status)) {
    return {
      eligible: false,
      reason: 'Only failed, cancelled, or expired payment attempts can be retried.',
      code: 'PAYMENT_NOT_RETRYABLE',
    }
  }
  return paymentAttemptCreationEligibility(order, orderPayments)
}

export function canCustomerSubmitPaymentStatus(
  payment: Payment,
  next: PaymentStatus,
) {
  return payment.status !== 'disputed' && canTransitionPayment(payment.status, next)
}
