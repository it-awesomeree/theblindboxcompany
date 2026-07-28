import { useRef, useState } from 'react'
import { Navigate } from '../lib/router'
import { useNavigate } from '../lib/router-core'
import { Notice } from '../components/Notice'
import { PrizePoolTable } from '../components/PrizePoolTable'
import { BOX_PRICE_SEN, POLICY_ACKNOWLEDGEMENT, SHIPPING_FEES } from '../domain/constants'
import { createCheckoutRequestId } from '../domain/guards'
import type { Address, ShippingMethod } from '../domain/types'
import { DEMO_ADDRESS } from '../data/fixtures'
import { formatMYR } from '../lib/format'
import { useAppState } from '../state/AppStateContext'

export function CheckoutPage() {
  const { state, services } = useAppState()
  const navigate = useNavigate()
  const [item] = useState(() => state.cart[0])
  const user = state.users.find((entry) => entry.id === state.sessionUserId)
  const [address, setAddress] = useState<Address>(structuredClone(DEMO_ADDRESS))
  const [shippingMethod, setShippingMethod] = useState<ShippingMethod>('standard')
  const [acknowledged, setAcknowledged] = useState(false)
  const [error, setError] = useState('')
  const [requestId] = useState(createCheckoutRequestId)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)

  if (!user) return <Navigate to="/auth" replace state={{ from: '/checkout' }} />
  if (!item) return <Navigate to="/cart" replace />

  const subtotal = BOX_PRICE_SEN * item.quantity
  const shipping = SHIPPING_FEES[shippingMethod]
  const total = subtotal + shipping
  const updateAddress = (key: keyof Address, value: string) => setAddress((current) => ({ ...current, [key]: value }))

  const submit = async () => {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setError('')
    try {
      await Promise.resolve()
      const order = services.orders.create({
        requestId,
        quantity: item.quantity,
        shippingMethod,
        address,
        acknowledged,
        displayedTotalSen: total,
      })
      submittingRef.current = false
      navigate(`/pay/${order.id}/new`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Checkout was blocked.')
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const reviewPool = () => {
    const pool = document.getElementById('checkout-pool-review')
    pool?.scrollIntoView({ block: 'start' })
    pool?.focus({ preventScroll: true })
  }

  return (
    <section className="route-page">
      <div className="content">
        <div className="page-heading">
          <div><span className="eyebrow">CUSTOMER / CHECKOUT</span><h1>Seal the demo order.</h1><p>Totals are recalculated inside the guarded service. Browser edits cannot change the amount.</p></div>
          <span className="huge-code">CHECK</span>
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        <Notice><b>Use the fictional address only.</b> To prevent accidental real data, street line 1 must contain “DEMO” and the phone must contain “demo”.</Notice>
        <div className="checkout-layout">
          <div className="checkout-main">
            <fieldset className="panel form-grid">
              <legend>01 / FAKE MALAYSIAN ADDRESS</legend>
              <label>Recipient<input value={address.recipient} onChange={(event) => updateAddress('recipient', event.target.value)} /></label>
              <label className="span-2">Street line 1<input value={address.line1} onChange={(event) => updateAddress('line1', event.target.value)} /></label>
              <label className="span-2">Street line 2<input value={address.line2} onChange={(event) => updateAddress('line2', event.target.value)} /></label>
              <label>Postcode<input inputMode="numeric" maxLength={5} value={address.postcode} onChange={(event) => updateAddress('postcode', event.target.value)} /></label>
              <label>City<input value={address.city} onChange={(event) => updateAddress('city', event.target.value)} /></label>
              <label>State<input value={address.state} onChange={(event) => updateAddress('state', event.target.value)} /></label>
              <label>Fake phone<input value={address.phone} onChange={(event) => updateAddress('phone', event.target.value)} /></label>
            </fieldset>
            <fieldset className="panel shipping-options">
              <legend>02 / SHIPPING METHOD</legend>
              {([
                ['standard', 'Tracked standard', '1–3 fictional working days', SHIPPING_FEES.standard],
                ['priority', 'Priority vault dispatch', 'Next fictional working day', SHIPPING_FEES.priority],
                ['self_collect', 'Self collect', 'Demo vault counter only', SHIPPING_FEES.self_collect],
              ] as const).map(([id, title, description, fee]) => (
                <label key={id} className={shippingMethod === id ? 'selected' : ''}>
                  <input type="radio" name="shipping" value={id} checked={shippingMethod === id} onChange={() => setShippingMethod(id)} />
                  <span><b>{title}</b><small>{description}</small></span><strong>{fee ? formatMYR(fee) : 'FREE'}</strong>
                </label>
              ))}
              <p>Bulky and digital prizes may split into separate fulfilment records. This disclosed fee never changes after payment.</p>
            </fieldset>
            <fieldset className="panel acknowledgement">
              <legend>03 / EXACT ODDS & POLICY</legend>
              <label>
                <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                <span>{POLICY_ACKNOWLEDGEMENT}</span>
              </label>
              <button className="text-button" type="button" onClick={reviewPool}>Review the exact 10,000-box table</button>
            </fieldset>
          </div>
          <aside className="panel order-summary checkout-summary">
            <div className="panel-heading"><div><span>SERVER-LIKE REVIEW</span><h2>Exact snapshot</h2></div></div>
            <dl>
              <div><dt>Series 001 × {item.quantity}</dt><dd>{formatMYR(subtotal)}</dd></div>
              <div><dt>{shippingMethod.replace('_', ' ')} shipping</dt><dd>{formatMYR(shipping)}</dd></div>
              <div><dt>Odds version</dt><dd>series-001-v1</dd></div>
              <div><dt>Policy version</dt><dd>floor-policy-v1</dd></div>
              <div className="summary-total"><dt>Demo total</dt><dd>{formatMYR(total)}</dd></div>
            </dl>
            <button className="button button-full" type="button" disabled={!acknowledged || submitting} aria-busy={submitting} onClick={submit}>
              {submitting ? 'Reserving one demo order…' : 'Reserve & continue to mock HitPay'}
            </button>
            <small>Reservation lasts 15 minutes. No money or address leaves this device.</small>
          </aside>
        </div>
        <section className="subsection checkout-pool-review" id="checkout-pool-review" tabIndex={-1} aria-labelledby="checkout-pool-title">
          <div className="subsection-heading"><div><span>04 / EXACT ODDS</span><h2 id="checkout-pool-title">Published 10,000-box pool</h2></div><small>Same frozen review table · no route change</small></div>
          <PrizePoolTable />
        </section>
      </div>
    </section>
  )
}
