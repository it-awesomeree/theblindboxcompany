import { useState } from 'react'
import { Navigate } from '../lib/router'
import { useNavigate, useSearchParams } from '../lib/router-core'
import { Notice } from '../components/Notice'
import type { ClaimKind } from '../domain/types'
import { formatMYR } from '../lib/format'
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
  const [linkedToken, setLinkedToken] = useState('')
  const [error, setError] = useState('')
  if (!user) return <Navigate to="/auth" replace />
  if (!order) return <Navigate to="/not-found" replace />

  const formattedValueFloor = formatMYR(order.snapshot.valueFloorSen)
  const orderBoxes = state.boxes.filter((box) => box.orderId === order.id)
  const everyBoxRevealed =
    order.boxIds.length > 0 &&
    order.boxIds.every((boxId) => Boolean(orderBoxes.find((box) => box.id === boxId)?.revealedAt))
  const eligible = services.claims.eligibleLinks(order.id, kind)
  const options = kind === 'value_floor'
    ? eligible.boxes.map((box, index) => ({
        token: `box-record-${index + 1}`,
        id: box.id,
        label: `Box ${String(box.number).padStart(2, '0')} · revealed · suspected-issue review`,
      }))
    : everyBoxRevealed
      ? eligible.shipments.map((shipment, index) => ({
          token: `delivery-record-${index + 1}`,
          id: shipment.id,
          label: `${shipment.id} · ${shipment.status.replaceAll('_', ' ')} · ${shipment.carrier}`,
        }))
      : eligible.orderLevelEligible
        ? [{
            token: 'order-delivery',
            id: undefined,
            label: 'Order delivery · eligible neutral record',
          }]
        : []
  const selectedToken = options.some((entry) => entry.token === linkedToken)
    ? linkedToken
    : options[0]?.token ?? ''
  const selectedId = options.find((entry) => entry.token === selectedToken)?.id ?? ''

  const submit = () => {
    setError('')
    try {
      services.claims.submit({
        orderId: order.id,
        kind,
        note,
        shipmentId: kind !== 'value_floor' && everyBoxRevealed ? selectedId : undefined,
        orderLevelDelivery: kind !== 'value_floor' && !everyBoxRevealed,
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
        <Notice>
          This creates a local workflow record only. The note must include the separate word <b>DEMO</b>.
          Do not enter a real email, phone, address, incident, photo, or delivery detail.
        </Notice>
        {error && <Notice tone="danger">{error}</Notice>}
        <form className="panel form-grid" onSubmit={(event) => { event.preventDefault(); submit() }}>
          <label>Claim type
            <select value={kind} onChange={(event) => { setKind(event.target.value as ClaimKind); setLinkedToken('') }}>
              <option value="damage">Damage</option>
              <option value="non_delivery">Non-delivery</option>
              <option value="value_floor">Suspected {formattedValueFloor} value-floor issue</option>
            </select>
          </label>
          <label>{kind === 'value_floor' ? 'Revealed box' : everyBoxRevealed ? 'Delivery record' : 'Order delivery'}
            <select value={selectedToken} onChange={(event) => setLinkedToken(event.target.value)} required>
              {options.length === 0 && <option value="">No eligible record</option>}
              {options.map((entry) => (
                <option key={entry.token} value={entry.token}>{entry.label}</option>
              ))}
            </select>
          </label>
          {!everyBoxRevealed && kind !== 'value_floor' && (
            <Notice>
              Sealed prizes stay private. This single order-level option records eligible physical delivery or failed/overdue digital evidence internally without exposing separate delivery details.
            </Notice>
          )}
          <label>Fictional note (must include DEMO; no email or phone)
            <textarea rows={5} value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          <button className="button" type="submit" disabled={!selectedToken}>Submit demo claim</button>
        </form>
        <p className="fine-print">
          Damage needs delivered physical evidence. Non-delivery can use an overdue, failed, lost, or returned-to-sender delivery, but never a customer return after delivery. A suspected value-floor issue can only be reviewed after that exact box is revealed. The stored suspected-review threshold for this order is {formattedValueFloor}; eligibility for review does not mean its declared prize is actually below that threshold.
        </p>
      </div>
    </section>
  )
}
