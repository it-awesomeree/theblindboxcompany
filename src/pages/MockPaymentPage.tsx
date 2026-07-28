import { useState } from 'react'
import { Link, Navigate } from '../lib/router'
import { useNavigate, useParams } from '../lib/router-core'
import { Notice } from '../components/Notice'
import { StatusBadge } from '../components/StatusBadge'
import {
  canCustomerSubmitPaymentStatus,
  paymentRetryEligibility,
} from '../domain/paymentEligibility'
import type { PaymentMethod } from '../domain/types'
import { formatMYR } from '../lib/format'
import { useAppState } from '../state/AppStateContext'

const methods: Array<[PaymentMethod, string, string]> = [
  ['FPX', 'FPX Online Banking', 'No bank login or account fields'],
  ['DUITNOW', 'DuitNow QR', 'No QR sends money'],
  ['CARD', 'Card', 'No card number, CVV or expiry fields'],
  ['GRABPAY', 'GrabPay', 'No wallet connection'],
  ['TNG', "Touch 'n Go eWallet", 'No wallet connection'],
]

export function MockPaymentPage() {
  const { state, services } = useAppState()
  const { orderId = '', paymentId = 'new' } = useParams()
  const navigate = useNavigate()
  const user = state.users.find((entry) => entry.id === state.sessionUserId)
  const order = state.orders.find((entry) => entry.id === orderId)
  const payment = paymentId === 'new'
    ? undefined
    : state.payments.find((entry) => entry.id === paymentId)
  const [method, setMethod] = useState<PaymentMethod>(() => payment?.method ?? 'FPX')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  if (!user) return <Navigate to="/auth" replace state={{ from: `/pay/${orderId}/${paymentId}` }} />
  if (!order || order.userId !== user.id) return <Navigate to="/not-found" replace />
  if (paymentId !== 'new' && (!payment || payment.orderId !== order.id || payment.userId !== user.id)) {
    return <Navigate to="/not-found" replace />
  }

  const create = () => {
    try {
      const created = services.payments.createAttempt(order.id, method)
      navigate(`/pay/${order.id}/${created.id}`, { replace: true })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Payment attempt was blocked.')
    }
  }

  const act = (action: 'approve' | 'decline' | 'cancel' | 'expire' | 'delayed') => {
    if (!payment) return
    try {
      const result = services.payments.act(payment.id, action)
      setMessage(result.message)
      if (action === 'approve' || action === 'delayed') navigate(`/payment-return/${payment.id}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Mock payment action was blocked.')
    }
  }

  const retry = () => {
    if (!payment) return
    try {
      const created = services.payments.createAttempt(order.id, method, payment.id)
      navigate(`/pay/${order.id}/${created.id}`, { replace: true })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Retry was blocked.')
    }
  }
  const actions = payment ? [
    { action: 'approve' as const, status: 'succeeded' as const, label: 'Approve + valid mock webhook', primary: true },
    { action: 'delayed' as const, status: 'processing' as const, label: 'Delayed pending return' },
    { action: 'decline' as const, status: 'failed' as const, label: 'Decline' },
    { action: 'cancel' as const, status: 'cancelled' as const, label: 'Cancel' },
    { action: 'expire' as const, status: 'expired' as const, label: 'Expire' },
  ].filter((item) => canCustomerSubmitPaymentStatus(payment, item.status)) : []
  const orderPayments = order.paymentIds
    .map((id) => state.payments.find((entry) => entry.id === id))
    .filter((entry) => entry !== undefined)
  const canRetry = Boolean(
    payment && paymentRetryEligibility(order, payment, orderPayments).eligible,
  )
  const terminalMessage = payment && ({
    failed: 'This demo attempt failed. The order may retry only while it remains unpaid and has no active or captured attempt.',
    cancelled: 'This demo attempt was cancelled. The order may retry only while it remains unpaid and has no active or captured attempt.',
    expired: 'This demo attempt expired. The order may retry only while it remains unpaid and has no active or captured attempt.',
    partially_refunded: 'This captured payment is partially refunded. Payment retry is not legal; review the held financial record on the order.',
    refunded: 'This captured payment was fully refunded. It is terminal and cannot be retried.',
    disputed: 'This captured payment is under dispute. It is held for protected finance review and cannot be retried.',
  } as Partial<Record<typeof payment.status, string>>)[payment.status]

  return (
    <section className="route-page payment-page">
      <div className="content narrow">
        <div className="no-money-banner"><b>DEMO · NO REAL CHARGE</b><span>This is a hosted-checkout-style simulator. Never enter payment information.</span></div>
        <div className="mock-provider-bar"><span className="mock-hitpay">HITPAY / MOCK</span><span>ORDER {order.id.toUpperCase()}</span></div>
        {error && <Notice tone="danger">{error}</Notice>}
        {message && <Notice tone="success">{message}</Notice>}
        <div className="payment-amount"><span>Demo amount</span><strong>{formatMYR(order.snapshot.totals.totalSen)}</strong><small>MYR · cannot be edited</small></div>
        <fieldset className="payment-methods">
          <legend>Select a mock payment path</legend>
          {methods.map(([id, title, description]) => (
            <label key={id} className={method === id ? 'selected' : ''}>
              <input type="radio" name="method" checked={method === id} onChange={() => setMethod(id)} disabled={Boolean(payment)} />
              <span className="method-code">{id}</span><span><b>{title}</b><small>{description}</small></span>
            </label>
          ))}
        </fieldset>
        {!payment ? (
          <button className="button button-full" type="button" onClick={create}>Create pending demo attempt</button>
        ) : (
          <div className="payment-console">
            <div className="panel-heading"><div><span>ATTEMPT {payment.attempt}</span><h2>Choose a simulated provider result</h2></div><StatusBadge value={payment.status} /></div>
            {actions.length > 0 ? (
              <div className="payment-actions">
                {actions.map((item) => (
                  <button className={item.primary ? 'button' : 'button button-ghost'} type="button" key={item.action} onClick={() => act(item.action)}>
                    {item.label}
                  </button>
                ))}
              </div>
            ) : payment.status === 'succeeded' ? (
              <Link className="button button-full" to={`/payment-return/${payment.id}`}>Continue to return page</Link>
            ) : (
              <>
                {terminalMessage && <Notice>{terminalMessage}</Notice>}
                <div className="payment-actions">
                  {canRetry && <button className="button" type="button" onClick={retry}>Create idempotent retry attempt</button>}
                  <Link className="button button-ghost" to={`/order/${order.id}`}>View order</Link>
                </div>
              </>
            )}
            <p className="fine-print">Only legal actions are shown for this state. A processing attempt cannot be cancelled here. Repeating an event ID or sending a late success cannot allocate twice.</p>
          </div>
        )}
        <Link className="back-link" to={`/order/${order.id}`}>← Back to demo order</Link>
      </div>
    </section>
  )
}
