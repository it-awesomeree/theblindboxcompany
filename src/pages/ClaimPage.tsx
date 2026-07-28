import { useState } from 'react'
import { Navigate } from '../lib/router'
import { useNavigate, useSearchParams } from '../lib/router-core'
import { Notice } from '../components/Notice'
import type { ClaimKind } from '../domain/types'
import { useAppState } from '../state/AppStateContext'

export function ClaimPage() {
  const { state, services } = useAppState()
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const orderId = search.get('order') ?? ''
  const user = state.users.find((entry) => entry.id === state.sessionUserId)
  const order = state.orders.find((entry) => entry.id === orderId && entry.userId === user?.id)
  const [kind, setKind] = useState<ClaimKind>('damage')
  const [note, setNote] = useState('DEMO: Outer carton is dented for workflow testing.')
  const [linkedId, setLinkedId] = useState('')
  const [error, setError] = useState('')
  if (!user) return <Navigate to="/auth" replace />
  if (!order) return <Navigate to="/not-found" replace />
  const orderBoxes = state.boxes.filter((box) => box.orderId === order.id)
  const everyBoxRevealed =
    order.boxIds.length > 0 &&
    order.boxIds.every((boxId) => Boolean(orderBoxes.find((box) => box.id === boxId)?.revealedAt))
  const shipmentClaimsLocked = kind !== 'value_floor' && !everyBoxRevealed
  const eligibleShipments = everyBoxRevealed
    ? state.shipments.filter((shipment) => {
        if (shipment.orderId !== order.id) return false
        if (kind === 'damage') return shipment.status === 'delivered' && shipment.kind !== 'DIGITAL'
        if (kind === 'non_delivery') return ['shipped', 'failed_delivery', 'lost'].includes(shipment.status)
        return false
      })
    : []
  const eligibleBoxes = orderBoxes.filter((box) => Boolean(box.revealedAt))
  const options = kind === 'value_floor' ? eligibleBoxes : eligibleShipments
  const selectedId = options.some((entry) => entry.id === linkedId) ? linkedId : options[0]?.id ?? ''

  const submit = () => {
    try {
      services.claims.submit({
        orderId: order.id,
        kind,
        note,
        shipmentId: kind === 'value_floor' ? undefined : selectedId,
        boxId: kind === 'value_floor' ? selectedId : undefined,
      })
      navigate(`/order/${order.id}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Claim was blocked.')
    }
  }

  return (
    <section className="route-page">
      <div className="content narrow">
        <span className="eyebrow">CUSTOMER / CLAIM ENTRY</span>
        <h1>Start a fake claim.</h1>
        <Notice>This creates a local workflow record only. Do not enter a real address, phone, incident, photo, or delivery detail.</Notice>
        {error && <Notice tone="danger">{error}</Notice>}
        <form className="panel form-grid" onSubmit={(event) => { event.preventDefault(); submit() }}>
          <label>Claim type
            <select value={kind} onChange={(event) => { setKind(event.target.value as ClaimKind); setLinkedId('') }}>
              <option value="damage">Damage</option>
              <option value="non_delivery">Non-delivery</option>
              <option value="value_floor">Value below RM100 floor</option>
            </select>
          </label>
          {shipmentClaimsLocked ? (
            <Notice>
              Shipment-linked claim details unlock after all boxes in this order are opened. Until then, shipment information stays private.
            </Notice>
          ) : (
            <>
              <label>{kind === 'value_floor' ? 'Revealed box' : 'Relevant shipment'}
                <select value={selectedId} onChange={(event) => setLinkedId(event.target.value)} required>
                  {options.length === 0 && <option value="">No eligible record</option>}
                  {options.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.id}{'status' in entry ? ` · ${entry.status}` : ' · revealed'}
                    </option>
                  ))}
                </select>
              </label>
              <label>Fictional note
                <textarea rows={5} value={note} onChange={(event) => setNote(event.target.value)} />
              </label>
              <button className="button" type="submit" disabled={!selectedId}>Submit demo claim</button>
            </>
          )}
        </form>
        <p className="fine-print">
          {everyBoxRevealed
            ? 'Damage needs delivered physical goods. Non-delivery needs a shipped/failed/lost overdue-like record. Value-floor review needs an already revealed box.'
            : 'Value-floor review is available only for an individually revealed box.'}
        </p>
      </div>
    </section>
  )
}
