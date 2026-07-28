import { useState } from 'react'
import { Link, Navigate } from '../lib/router'
import { useParams } from '../lib/router-core'
import { Notice } from '../components/Notice'
import { StatusBadge } from '../components/StatusBadge'
import { useAppState } from '../state/AppStateContext'

export function PaymentReturnPage() {
  const { state, services } = useAppState()
  const { paymentId = '' } = useParams()
  const [message, setMessage] = useState('')
  const payment = state.payments.find((entry) => entry.id === paymentId)
  const order = state.orders.find((entry) => entry.id === payment?.orderId)
  const user = state.users.find((entry) => entry.id === state.sessionUserId)
  if (!user) return <Navigate to="/auth" replace />
  if (!payment || !order || order.userId !== user.id) return <Navigate to="/not-found" replace />

  const confirmDelayed = () => {
    try {
      const result = services.payments.act(payment.id, 'approve')
      setMessage(result.message)
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Confirmation was blocked.')
    }
  }

  const disputed = payment.status === 'disputed'
  const captured = ['succeeded', 'partially_refunded', 'refunded', 'disputed'].includes(payment.status)
  return (
    <section className="route-page return-page">
      <div className="content narrow">
        <div className={`confirmation-core ${captured ? 'confirmed' : ''}`} aria-live="polite">
          <span className="signal-ring" aria-hidden="true" />
          <span className="eyebrow">PAYMENT RETURN / NOT PROOF</span>
          <h1>{disputed ? 'Captured payment under dispute.' : captured ? 'Payment confirmed by event.' : 'Confirming payment…'}</h1>
          {disputed && <p>This payment was captured and is now under dispute and review.</p>}
          <p>A browser redirect is never proof of payment. This screen trusts only the idempotent mock webhook/event record.</p>
          <StatusBadge value={payment.status} />
        </div>
        {message && <Notice>{message}</Notice>}
        {!captured && ['pending', 'processing'].includes(payment.status) && (
          <button className="button button-full" type="button" onClick={confirmDelayed}>Simulate delayed valid webhook arriving</button>
        )}
        <div className="panel return-proof">
          <div><span>Payment event count</span><b>{payment.events.length}</b></div>
          <div><span>Paid boxes allocated</span><b>{order.boxIds.filter((id) => state.boxes.find((box) => box.id === id)?.prizeId).length}</b></div>
          <div><span>Order state</span><StatusBadge value={order.status} /></div>
        </div>
        <Link className="button button-full" to={`/order/${order.id}`}>View order and boxes</Link>
      </div>
    </section>
  )
}
