import { isOpenClaimStatus } from '../domain/claimStatus'
import { resolveOrderFulfillment } from '../domain/orderFulfillment'
import type { Claim, DemoState, Order, Shipment } from '../domain/types'
import { formatDateTime, formatMYR, titleCase } from '../lib/format'
import { StatusBadge } from './StatusBadge'

function deliveryLabel(shipment: Shipment) {
  if (shipment.kind === 'DIGITAL') {
    return shipment.purpose === 'replacement' ? 'Digital reissue' : 'Digital delivery'
  }
  return shipment.purpose === 'replacement' ? 'Replacement shipment' : 'Original shipment'
}

function settlementAmountLabel(claim: Claim) {
  return `Accepted ${formatMYR(claim.acceptedSettlementSen ?? 0)} · required ${formatMYR(claim.requiredSettlementSen)}`
}

function settlementPolicyLabel(claim: Claim) {
  if (claim.legacyUnderSettledRefund) {
    return 'Preserved legacy record · no modern settlement policy'
  }
  return claim.settlementPolicy
    ? `Settlement policy: ${titleCase(claim.settlementPolicy)}`
    : 'No valid completion settlement policy'
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
        <b>{completed} of {resolution.scopes.length} box fulfilment scopes complete</b>
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
        const replacement = scope.replacementShipmentId
          ? state.shipments.find((shipment) =>
              shipment.id === scope.replacementShipmentId &&
              shipment.orderId === order.id &&
              shipment.purpose === 'replacement' &&
              scope.boxIds.every((boxId) => shipment.boxIds.includes(boxId)) &&
              claims.some((claim) => claim.id === shipment.sourceClaimId))
          : undefined
        const refundLinked = claims.find((claim) =>
          claim.remedyState === 'refund_linked' &&
          claim.legacyUnderSettledRefund !== true)
        const refundComplete = claims.find((claim) =>
          claim.remedyState === 'refund_completed' &&
          claim.legacyUnderSettledRefund !== true)
        const legacyUnderSettledRefund = claims.find((claim) =>
          claim.legacyUnderSettledRefund === true)
        const rma = claims.find((claim) => claim.rma)?.rma
        const completion = scope.completedBy === 'original'
          ? 'Original delivery complete'
          : scope.completedBy === 'replacement'
            ? 'Replacement delivered'
            : scope.completedBy === 'refund'
              ? 'Audited refund complete'
              : undefined

        return (
          <article className="remedy-scope" key={`${scope.originalShipmentId}:${scope.boxIds.join(',')}`}>
            <div className="remedy-original">
              <div>
                <span>SCOPE {String(index + 1).padStart(2, '0')} / IMMUTABLE ORIGINAL EVIDENCE</span>
                <h3>{deliveryLabel(original)}</h3>
                <small className="breakable-id">{original.id}</small>
                <small>Scope boxes: <span className="breakable-id scope-box-ids">{scope.boxIds.join(', ')}</span></small>
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
                  <span>{settlementAmountLabel(refundLinked)}</span>
                  <span>{settlementPolicyLabel(refundLinked)}</span>
                  <StatusBadge value="refund_linked" />
                </p>
              )}
              {refundComplete && (
                <p>
                  <b>Audited refund complete</b>
                  <span className="breakable-id">{refundComplete.id} · {refundComplete.linkedRefundEventId}</span>
                  <span>{settlementAmountLabel(refundComplete)}</span>
                  <span>{settlementPolicyLabel(refundComplete)}</span>
                  <StatusBadge value="refund_completed" />
                </p>
              )}
              {legacyUnderSettledRefund && (
                <p>
                  <b>Immutable legacy under-settled refund evidence</b>
                  <span>{settlementAmountLabel(legacyUnderSettledRefund)}</span>
                  <span>{settlementPolicyLabel(legacyUnderSettledRefund)}</span>
                  <span>Its exact final audit permanently owns this claim scope; the under-settled amount alone does not mark delivery fulfilled.</span>
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
                        ? refundComplete
                          ? 'Replacement exception · box fulfilment scope was settled by refund'
                          : refundLinked?.settlementPolicy === 'terminal_replacement_fallback'
                            ? 'Replacement exception · settlement is waiting for final claim audit'
                            : 'Replacement exception · claim remains open'
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
                <p><b>Box fulfilment scope is still in progress</b><StatusBadge value={scope.status} /></p>
              )}
            </div>
          </article>
        )
      })}
    </div>
  )
}
