import { useState } from 'react'
import { Link, Navigate } from '../lib/router'
import { useParams } from '../lib/router-core'
import { Notice } from '../components/Notice'
import { StatusBadge } from '../components/StatusBadge'
import { useAppState } from '../state/AppStateContext'

type ActionNotice = { text: string; tone: 'info' | 'success' | 'danger' } | null

export function PaymentReturnPage() {
  const { state, services } = useAppState()
  const { paymentId = '' } = useParams()
  const [notice, setNotice] = useState<ActionNotice>(null)
  const payment = state.payments.find((entry) => entry.id === paymentId)
  const order = state.orders.find((entry) => entry.id === payment?.orderId)
  const user = state.users.find((entry) => entry.id === state.sessionUserId)
  if (!user) return <Navigate to="/auth" replace />
  if (!payment || !order || order.userId !== user.id) return <Navigate to="/not-found" replace />

  const confirmDelayed = () => {
    setNotice(null)
    try {
      const result = services.payments.act(payment.id, 'approve')
      setNotice({ text: result.message, tone: result.changed ? 'success' : 'info' })
    } catch (caught) {
      setNotice({ text: caught instanceof Error ? caught.message : 'Confirmation was blocked.', tone: 'danger' })
    }
  }

  const headings: Record<typeof payment.status, string> = {
    created: 'Payment attempt created.',
    pending: 'Confirming payment…',
    processing: 'Confirming payment…',
    succeeded: 'Payment confirmed by event.',
    failed: 'Payment failed.',
    cancelled: 'Payment cancelled.',
    expired: 'Payment expired.',
    partially_refunded: 'Payment partially refunded.',
    refunded: 'Payment refunded.',
    disputed: 'Captured payment under dispute.',
  }
  const explanations: Partial<Record<typeof payment.status, string>> = {
    failed: 'The provider-style attempt failed and did not confirm this order.',
    cancelled: 'The provider-style attempt was cancelled and did not confirm this order.',
    expired: 'The provider-style attempt expired and did not confirm this order.',
    partially_refunded: 'This payment was captured and now has a recorded partial demo refund.',
    refunded: 'This payment was captured and then fully refunded in the demo ledger.',
    disputed: 'This payment was captured and is now under dispute and review.',
  }
  const captured = ['succeeded', 'partially_refunded', 'refunded', 'disputed'].includes(payment.status)
  return (
    <section className="route-page return-page">
      <div className="content narrow">
        <div className={`confirmation-core ${captured ? 'confirmed' : ''}`} aria-live="polite">
          <span className="signal-ring" aria-hidden="true" />
          <span className="eyebrow">PAYMENT RETURN / NOT PROOF</span>
          <h1>{headings[payment.status]}</h1>
          {explanations[payment.status] && <p>{explanations[payment.status]}</p>}
          <p>A browser redirect is never proof of payment. This screen trusts only the idempotent mock webhook/event record.</p>
          <StatusBadge value={payment.status} />
        </div>
        {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
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
