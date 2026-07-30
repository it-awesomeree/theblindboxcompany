import { Link, Navigate } from '../lib/router'
import { RemedyProgress } from '../components/RemedyProgress'
import { StatusBadge } from '../components/StatusBadge'
import { neutralOrderDeliveryCode, neutralOrderDeliveryStatus } from '../domain/orderStatus'
import { boxRevealEligibility, prizeForBox } from '../domain/selectors'
import { isActionableInTransitShipment } from '../domain/shipmentPolicy'
import { formatDateTime, formatMYR } from '../lib/format'
import { useAppState } from '../state/AppStateContext'

export function AccountPage() {
  const { state } = useAppState()
  const user = state.users.find((entry) => entry.id === state.sessionUserId)
  if (!user) return <Navigate to="/auth" replace state={{ from: '/account' }} />
  if (user.role !== 'customer') return <Navigate to="/admin" replace />
  const orders = state.orders.filter((entry) => entry.userId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const boxes = state.boxes.filter((entry) => entry.ownerId === user.id)
  const unopened = boxes.filter((box) => box.prizeId && !box.revealedAt && boxRevealEligibility(state, box).eligible)
  const held = boxes.filter((box) => box.prizeId && !box.revealedAt && !boxRevealEligibility(state, box).eligible)
  const ordersInTransit = orders.filter((order) =>
    state.shipments.some((shipment) =>
      shipment.orderId === order.id &&
      isActionableInTransitShipment(state, shipment)),
  )

  return (
    <section className="route-page">
      <div className="content">
        <div className="page-heading">
          <div><span className="eyebrow">CUSTOMER / ACCOUNT</span><h1>{user.name}</h1><p>{user.email} · fictional local demo identity</p></div>
          <span className="huge-code">VAULT ID</span>
        </div>
        <div className="metric-grid customer-metrics">
          <article><span>ORDERS</span><b>{orders.length}</b><small>all local demo records</small></article>
          <article><span>UNOPENED</span><b>{unopened.length}</b><small>{held.length} separately on hold</small></article>
          <article><span>OPENED</span><b>{boxes.filter((box) => box.revealedAt).length}</b><small>immutable reveals</small></article>
          <article><span>IN TRANSIT</span><b>{ordersInTransit.length}</b><small>fictional orders</small></article>
        </div>
        {unopened.length > 0 && (
          <section className="attention-strip">
            <div><span>SEALED PAID BOXES</span><h2>{unopened.length} prize{unopened.length === 1 ? '' : 's'} waiting in your vault.</h2></div>
            <Link className="button" to={`/open/${unopened[0].id}`}>Open next box</Link>
          </section>
        )}
        <section className="subsection">
          <div className="subsection-heading"><div><span>01 / HISTORY</span><h2>Orders, payment & fulfilment</h2></div><Link to="/cart">Buy another demo box</Link></div>
          <div className="account-orders">
            {orders.map((order) => {
              const payment = state.payments.find((entry) => order.paymentIds.includes(entry.id) && ['succeeded', 'partially_refunded', 'refunded', 'disputed'].includes(entry.status))
              const orderBoxes = order.boxIds.map((id) => state.boxes.find((box) => box.id === id)).filter(Boolean)
              const shipments = state.shipments.filter((entry) => entry.orderId === order.id)
              const claims = state.claims.filter((entry) => order.claimIds.includes(entry.id))
              const refundAwaitingFinalAudit = claims.some((claim) =>
                claim.remedyState === 'refund_linked' &&
                claim.legacyUnderSettledRefund !== true)
              const legacyUnderSettledClaims = claims.filter((claim) =>
                claim.legacyUnderSettledRefund === true)
              const everyBoxRevealed =
                orderBoxes.length === order.boxIds.length &&
                orderBoxes.length > 0 &&
                orderBoxes.every((box) => Boolean(box?.revealedAt))
              return (
                <article className="panel account-order" key={order.id}>
                  <header>
                    <div><span>{formatDateTime(order.createdAt)}</span><h3>{order.id.toUpperCase()}</h3></div>
                    {everyBoxRevealed && <StatusBadge value={refundAwaitingFinalAudit ? 'refund_linked' : order.status} />}
                  </header>
                  <div className="account-order-grid">
                    <div>
                      <span>PAYMENT</span>
                      {payment
                        ? (
                            <>
                              <StatusBadge value={refundAwaitingFinalAudit ? 'refund_linked' : payment.status} />
                              {refundAwaitingFinalAudit && <small>Refund recorded · final claim audit pending</small>}
                              {payment.status === 'disputed' && <small>Captured · under dispute</small>}
                            </>
                          )
                        : <small>Not confirmed</small>}
                    </div>
                    <div><span>BOXES</span><b>{orderBoxes.length} total · {orderBoxes.filter((box) => box?.revealedAt).length} opened</b></div>
                    <div className="account-fulfilment">
                      <span>FULFILMENT</span>
                      {everyBoxRevealed
                        ? shipments.length > 0
                          ? <RemedyProgress state={state} order={order} compact />
                          : <small>Not queued</small>
                        : (
                          <div className="sealed-delivery-summary">
                            <b className="tracking-code">{neutralOrderDeliveryCode(order.id)}</b>
                            <StatusBadge value={neutralOrderDeliveryStatus(order.status)} />
                          </div>
                        )}
                    </div>
                    <div><span>TOTAL</span><b>{formatMYR(order.snapshot.totals.totalSen)}</b></div>
                  </div>
                  {everyBoxRevealed && (
                    <div className="account-prizes">
                      {orderBoxes.map((box) => {
                        const prize = prizeForBox(state, box)
                        return <span key={box!.id}>{prize?.shortName} · {box!.manifestId}</span>
                      })}
                    </div>
                  )}
                  {everyBoxRevealed && legacyUnderSettledClaims.map((claim) => (
                    <div className="notice notice-info" key={claim.id}>
                      <b>Preserved legacy refund history is read-only</b>
                      <p>The final audited legacy resolution accepted <b>{formatMYR(claim.acceptedSettlementSen ?? 0)}</b> against required <b>{formatMYR(claim.requiredSettlementSen)}</b>. It permanently owns this claim scope; the under-settled amount alone does not mark delivery fulfilled.</p>
                    </div>
                  ))}
                  <Link className="button button-ghost" to={`/order/${order.id}`}>View full record</Link>
                </article>
              )
            })}
          </div>
        </section>
      </div>
    </section>
  )
}
