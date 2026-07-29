import { isOpenClaimStatus } from '../domain/claimStatus'
import { resolveOrderFulfillment } from '../domain/orderFulfillment'
import type { DemoState, Order, Shipment } from '../domain/types'
import { formatDateTime } from '../lib/format'
import { StatusBadge } from './StatusBadge'

function deliveryLabel(shipment: Shipment) {
  if (shipment.kind === 'DIGITAL') {
    return shipment.purpose === 'replacement' ? 'Digital reissue' : 'Digital delivery'
  }
  return shipment.purpose === 'replacement' ? 'Replacement shipment' : 'Original shipment'
}

export function RemedyProgress({
  state,
  order,
  compact = false,
}: {
  state: DemoState
  order: Order
  compact?: boolean
}) {
  const resolution = resolveOrderFulfillment(state, order)
  const completed = resolution.scopes.filter((scope) => scope.status === 'fulfilled').length

  return (
    <div className={`remedy-progress${compact ? ' remedy-progress-compact' : ''}`}>
      <div className="remedy-progress-heading">
        <b>{completed} of {resolution.scopes.length} original delivery groups complete</b>
        <StatusBadge value={resolution.status} />
      </div>
      {resolution.scopes.map((scope, index) => {
        const original = state.shipments.find((shipment) =>
          shipment.id === scope.originalShipmentId && shipment.purpose === 'original')
        if (!original) return null
        const claims = scope.affectedClaimIds
          .map((claimId) => state.claims.find((claim) => claim.id === claimId))
          .filter((claim) => claim !== undefined)
        const openClaims = claims.filter((claim) => isOpenClaimStatus(claim.status))
        const replacement = state.shipments.find((shipment) =>
          shipment.purpose === 'replacement' &&
          shipment.replacementForShipmentId === original.id &&
          claims.some((claim) => claim.id === shipment.sourceClaimId))
        const refundLinked = claims.find((claim) => claim.remedyState === 'refund_linked')
        const refundComplete = claims.find((claim) => claim.remedyState === 'refund_completed')
        const rma = claims.find((claim) => claim.rma)?.rma
        const completion = scope.completedBy === 'original'
          ? 'Original delivery complete'
          : scope.completedBy === 'replacement'
            ? 'Replacement delivered'
            : scope.completedBy === 'refund'
              ? 'Audited refund complete'
              : undefined

        return (
          <article className="remedy-scope" key={scope.originalShipmentId}>
            <div className="remedy-original">
              <div>
                <span>GROUP {String(index + 1).padStart(2, '0')} / IMMUTABLE ORIGINAL EVIDENCE</span>
                <h3>{deliveryLabel(original)}</h3>
                <small className="breakable-id">{original.id}</small>
              </div>
              <StatusBadge value={original.status} />
            </div>
            {original.kind === 'DIGITAL'
              ? <p>Digital delivery record · {original.boxIds.length} revealed box{original.boxIds.length === 1 ? '' : 'es'}</p>
              : (
                  <p>
                    <span>{original.carrier}</span> · <span className="breakable-id">{original.trackingNumber}</span>
                    {original.insured ? ' · insured' : ''}{original.signatureRequired ? ' · signature required' : ''}
                  </p>
                )}
            {!compact && (
              <ol className="mini-timeline">
                {original.timeline.map((entry) => (
                  <li key={entry.id}><b>{entry.label}</b><small>{formatDateTime(entry.at)}</small></li>
                ))}
              </ol>
            )}
            <div className="remedy-evidence">
              {rma && (
                <p>
                  <b>Return evidence</b>
                  <span className="breakable-id">{rma.reference}</span>
                  <span className="status-pair">
                    <StatusBadge value="rma_created" />
                    {rma.receivedAt && <StatusBadge value="rma_received" />}
                    {rma.inspectedAt && <StatusBadge value="rma_inspected" />}
                  </span>
                </p>
              )}
              {refundLinked && (
                <p>
                  <b>Refund waiting for final claim audit</b>
                  <span className="breakable-id">{refundLinked.id} · {refundLinked.linkedRefundEventId}</span>
                  <StatusBadge value="refund_linked" />
                </p>
              )}
              {refundComplete && (
                <p>
                  <b>Audited refund complete</b>
                  <span className="breakable-id">{refundComplete.id} · {refundComplete.linkedRefundEventId}</span>
                  <StatusBadge value="refund_completed" />
                </p>
              )}
              {replacement && (
                <div className="remedy-replacement">
                  <div>
                    <b>{deliveryLabel(replacement)}</b>
                    <span className="breakable-id">{replacement.id}</span>
                    {replacement.kind === 'DIGITAL'
                      ? <span>Digital reissue delivery record</span>
                      : <span><span>{replacement.carrier}</span> · <span className="breakable-id">{replacement.trackingNumber}</span></span>}
                  </div>
                  <StatusBadge value={replacement.status} />
                  <p>
                    {replacement.status === 'delivered'
                      ? 'Replacement delivered'
                      : ['failed', 'failed_delivery', 'lost', 'returned', 'cancelled'].includes(replacement.status)
                        ? 'Replacement exception · claim remains open'
                        : 'Replacement in progress'}
                  </p>
                  {!compact && (
                    <ol className="mini-timeline">
                      {replacement.timeline.map((entry) => (
                        <li key={entry.id}><b>{entry.label}</b><small>{formatDateTime(entry.at)}</small></li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
              {openClaims.length > 0 && (
                <p>
                  <b>Open claim blocker{openClaims.length === 1 ? '' : 's'}</b>
                  <span className="breakable-id">{openClaims.map((claim) => claim.id).join(', ')}</span>
                </p>
              )}
              {completion && <p><b>{completion}</b><StatusBadge value={scope.status} /></p>}
              {!completion && openClaims.length === 0 && (
                <p><b>Original delivery group is still in progress</b><StatusBadge value={scope.status} /></p>
              )}
            </div>
          </article>
        )
      })}
    </div>
  )
}
