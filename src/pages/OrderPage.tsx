import { Link, Navigate } from '../lib/router'
import { useParams } from '../lib/router-core'
import { Notice } from '../components/Notice'
import { StatusBadge } from '../components/StatusBadge'
import { neutralOrderDeliveryCode, neutralOrderDeliveryStatus } from '../domain/orderStatus'
import { sealedCustomerTimeline } from '../domain/orderTimeline'
import { boxRevealEligibility, prizeForBox } from '../domain/selectors'
import { formatDateTime, formatMYR } from '../lib/format'
import { useAppState } from '../state/AppStateContext'

export function OrderPage() {
  const { state } = useAppState()
  const { orderId = '' } = useParams()
  const user = state.users.find((entry) => entry.id === state.sessionUserId)
  if (!user) return <Navigate to="/auth" replace state={{ from: `/order/${orderId}` }} />
  const order = state.orders.find((entry) => entry.id === orderId && entry.userId === user.id)
  if (!order) return <Navigate to="/not-found" replace />
  const payments = order.paymentIds.map((id) => state.payments.find((entry) => entry.id === id)).filter(Boolean)
  const boxes = order.boxIds.map((id) => state.boxes.find((entry) => entry.id === id)).filter(Boolean)
  const shipments = state.shipments.filter((entry) => entry.orderId === order.id)
  const latestPayment = payments.at(-1)
  const claims = state.claims.filter((entry) => order.claimIds.includes(entry.id))
  const everyBoxRevealed =
    boxes.length === order.boxIds.length &&
    boxes.length > 0 &&
    boxes.every((box) => Boolean(box?.revealedAt))
  const visibleTimeline = everyBoxRevealed
    ? order.timeline
    : sealedCustomerTimeline(order)

  return (
    <section className="route-page">
      <div className="content">
        <div className="page-heading order-heading">
          <div>
            <span className="eyebrow">CUSTOMER / ORDER RECORD</span>
            <h1>{order.id.toUpperCase()}</h1>
            <p>Created {formatDateTime(order.createdAt)} · totals, address, odds and policy are frozen snapshots.</p>
          </div>
          {everyBoxRevealed && <StatusBadge value={order.status} />}
        </div>
        {order.status === 'pending_payment' && (
          <Notice tone="danger">Payment is not confirmed. No prize has been assigned. <Link to={`/pay/${order.id}/${latestPayment?.id ?? 'new'}`}>Continue mock payment</Link></Notice>
        )}
        <div className="order-record-grid">
          <div className="panel">
            <div className="panel-heading"><div><span>01 / ORDER</span><h2>Immutable review snapshot</h2></div></div>
            <dl className="detail-list">
              <div><dt>Item</dt><dd>{order.snapshot.itemName} × {order.snapshot.quantity}</dd></div>
              <div><dt>Items</dt><dd>{formatMYR(order.snapshot.totals.itemSubtotalSen)}</dd></div>
              <div><dt>Shipping</dt><dd>{order.snapshot.shippingMethod} · {formatMYR(order.snapshot.totals.shippingSen)}</dd></div>
              <div><dt>Total</dt><dd className="money">{formatMYR(order.snapshot.totals.totalSen)}</dd></div>
              <div><dt>Odds / policy</dt><dd>{order.snapshot.oddsVersion}<br />{order.snapshot.policyVersion}</dd></div>
              <div><dt>Fake address</dt><dd>{order.snapshot.address.recipient}<br />{order.snapshot.address.line1}<br />{order.snapshot.address.postcode} {order.snapshot.address.city}</dd></div>
            </dl>
          </div>
          <div className="panel">
            <div className="panel-heading"><div><span>02 / TIMELINE</span><h2>Order events</h2></div></div>
            <ol className="timeline">
              {[...visibleTimeline].reverse().map((entry) => (
                <li key={entry.id}><span /><div><StatusBadge value={entry.status} /><b>{entry.label}</b><small>{formatDateTime(entry.at)}</small></div></li>
              ))}
            </ol>
            {!everyBoxRevealed && (
              <p className="fine-print">Detailed delivery events stay combined until every box is revealed; only sanitized order and payment history is shown.</p>
            )}
          </div>
        </div>

        <section className="subsection">
          <div className="subsection-heading"><div><span>03 / BOXES</span><h2>One paid box per quantity</h2></div><small>Hidden until opened · immutable after reveal</small></div>
          <div className="box-grid">
            {boxes.map((box) => {
              if (!box) return null
              const prize = prizeForBox(state, box)
              const reveal = boxRevealEligibility(state, box)
              return (
                <article className={`box-card ${box.revealedAt ? 'revealed' : ''}`} key={box.id}>
                  <span className="box-number">BOX {String(box.number).padStart(2, '0')}</span>
                  <div className="box-icon" aria-hidden="true"><span>{box.revealedAt ? 'OPEN' : 'SEALED'}</span></div>
                  {everyBoxRevealed && <StatusBadge value={box.status} />}
                  <h3>{box.revealedAt ? prize?.name : box.prizeId ? 'Paid prize sealed' : 'Waiting for payment'}</h3>
                  <p>{box.revealedAt ? `${formatMYR(prize?.valueSen ?? 0)} · ${prize?.tier}` : 'The opener cannot choose or change this allocation.'}</p>
                  {box.prizeId && reveal.eligible && (
                    <Link className="button button-full" to={`/open/${box.id}`}>{box.revealedAt ? 'View immutable reveal' : 'Open now'}</Link>
                  )}
                  {box.prizeId && !reveal.eligible && <p className="box-hold-note">{reveal.reason}</p>}
                </article>
              )
            })}
          </div>
        </section>
        <section className="subsection">
          <div className="subsection-heading"><div><span>04 / CLAIMS</span><h2>Claim status &amp; history</h2></div></div>
          {claims.length > 0 ? (
            <div className="claim-history-grid">
              {claims.map((claim) => (
                <article className="panel claim-history-card" key={claim.id}>
                  <div className="panel-heading"><div><span>{claim.id}</span><h3>{claim.kind.replaceAll('_', ' ')}</h3></div><StatusBadge value={claim.status} /></div>
                  <p>{claim.note}</p>
                  {claim.shipmentCandidateIds
                    ? <small>Linked record: neutral order-level delivery evidence</small>
                    : everyBoxRevealed && <small>Linked record: {claim.shipmentId ?? claim.boxId}</small>}
                  {claim.status === 'resolved' && (
                    <div className="notice notice-info">
                      <b>Recorded resolution</b>
                      <p>{claim.resolutionOutcome?.replaceAll('_', ' ')} · {claim.resolutionReference}</p>
                      <small>{claim.resolutionNote}</small>
                    </div>
                  )}
                  <ol className="mini-timeline">
                    {claim.history.map((entry) => <li key={entry.id}><b>{entry.note}</b><small>{formatDateTime(entry.at)} · {entry.status}</small></li>)}
                  </ol>
                  <p className="fine-print">A claim never creates a refund automatically.</p>
                </article>
              ))}
            </div>
          ) : <div className="empty-state compact"><p>No claim has been filed for this order.</p></div>}
        </section>

        <section className="subsection">
          <div className="subsection-heading">
            <div><span>05 / FULFILMENT</span><h2>{everyBoxRevealed ? 'Split tracking' : 'Private-prize tracking'}</h2></div>
            <Link to={`/claim/new?order=${order.id}`}>Start a demo claim</Link>
          </div>
          {!everyBoxRevealed && (
            <Notice>Useful delivery progress stays visible while prize-derived carrier, fulfilment kind, flags, linked boxes, and prize clues remain private.</Notice>
          )}
          {!everyBoxRevealed ? (
            <div className="shipment-grid">
              <article className="panel shipment-card sealed-delivery-summary">
                <div className="panel-heading">
                  <div>
                    <span>ORDER DELIVERY</span>
                    <h3>Private delivery summary</h3>
                  </div>
                  <StatusBadge value={neutralOrderDeliveryStatus(order.status)} />
                </div>
                <p className="tracking-code">{neutralOrderDeliveryCode(order.id)}</p>
                <p>All delivery groups stay combined until every box in this order is revealed.</p>
              </article>
            </div>
          ) : shipments.length ? (
            <div className="shipment-grid">
              {shipments.map((shipment) => (
                <article className="panel shipment-card" key={shipment.id}>
                  <div className="panel-heading">
                    <div>
                      <span>{shipment.kind}</span>
                      <h3>{shipment.carrier}</h3>
                    </div>
                    <StatusBadge value={shipment.status} />
                  </div>
                  <p className="tracking-code">{shipment.trackingNumber}</p>
                  <div className="shipment-flags">
                    {shipment.insured && <span>INSURED</span>}{shipment.signatureRequired && <span>SIGNATURE REQUIRED</span>}<span>{shipment.boxIds.length} BOX</span>
                  </div>
                  <ol className="mini-timeline">
                    {shipment.timeline.map((entry) => (
                      <li key={entry.id}>
                        <b>{entry.label}</b>
                        <small>{formatDateTime(entry.at)}</small>
                      </li>
                    ))}
                  </ol>
                </article>
              ))}
            </div>
          ) : <div className="empty-state compact"><p>Fulfilment appears only after the valid paid event allocates boxes.</p></div>}
        </section>
      </div>
    </section>
  )
}
