import { useEffect, useRef, useState } from 'react'
import { Link, Navigate } from '../lib/router'
import { useParams } from '../lib/router-core'
import { Notice } from '../components/Notice'
import { VaultCanvas } from '../components/VaultCanvas'
import { boxRevealEligibility, prizeForBox } from '../domain/selectors'
import { formatMYR } from '../lib/format'
import { useAppState } from '../state/AppStateContext'

export function OpenBoxPage() {
  const { state, services } = useAppState()
  const { boxId = '' } = useParams()
  const user = state.users.find((entry) => entry.id === state.sessionUserId)
  const box = state.boxes.find((entry) => entry.id === boxId)
  const order = state.orders.find((entry) => entry.id === box?.orderId)
  const [openSignal, setOpenSignal] = useState(box?.revealedAt ? 1 : 0)
  const [showResult, setShowResult] = useState(Boolean(box?.revealedAt))
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const resultHeadingRef = useRef<HTMLHeadingElement>(null)
  const revealStartedRef = useRef(false)
  const revealTimeoutRef = useRef<number | null>(null)
  const prize = box?.revealedAt ? prizeForBox(state, box) : undefined
  const reveal = boxRevealEligibility(state, box)
  const hasRevealedResult = Boolean(showResult && box?.revealedAt && prize)

  useEffect(() => {
    if (!hasRevealedResult || !prize || !revealStartedRef.current) return
    revealStartedRef.current = false
    setAnnouncement(`Box revealed. Result: ${prize.name}.`)
    resultHeadingRef.current?.focus({ preventScroll: true })
  }, [hasRevealedResult, prize])

  useEffect(() => () => {
    if (revealTimeoutRef.current !== null) {
      window.clearTimeout(revealTimeoutRef.current)
      revealTimeoutRef.current = null
    }
  }, [])

  if (!user) return <Navigate to="/auth" replace />
  if (!box || !order || box.ownerId !== user.id) return <Navigate to="/not-found" replace />

  const open = () => {
    if (opening || hasRevealedResult) return
    try {
      services.openBox(box.id)
      revealStartedRef.current = true
      setOpening(true)
      setOpenSignal((value) => value + 1)
      revealTimeoutRef.current = window.setTimeout(() => {
        revealTimeoutRef.current = null
        setShowResult(true)
        setOpening(false)
      }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 120 : 1700)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Opening was blocked.')
    }
  }

  return (
    <section className="reveal-page">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
      <div className="reveal-stage">
        <VaultCanvas openSignal={openSignal} holdOpen={hasRevealedResult || opening} onActivate={!hasRevealedResult && reveal.eligible ? open : undefined} label="Open this paid box once" />
        <div className="vault-grain" aria-hidden="true" />
        <div className="reveal-topline"><span>PAID BOX / {box.id.toUpperCase()}</span><span>OWNER CHECK · PASS</span></div>
        {!hasRevealedResult && reveal.eligible ? (
          <div className="reveal-control">
            <span className="eyebrow">PRIZE PREASSIGNED · ANIMATION CANNOT CHANGE IT</span>
            <h1>{opening ? 'Vault seal releasing…' : 'Open exactly once.'}</h1>
            <p>Refresh or repeat always returns the same hidden service-layer allocation.</p>
            <button className="button" type="button" onClick={open} disabled={opening}>{opening ? 'Opening…' : 'Break demo seal'}</button>
            {error && <Notice tone="danger">{error}</Notice>}
          </div>
        ) : hasRevealedResult && prize ? (
          <div className="reveal-result" role="region" aria-labelledby="reveal-result-title">
            <div className="result-code"><span>{prize.tier} TIER</span><span>DEMO FLOOR · SAMPLE ✓</span></div>
            <h1 id="reveal-result-title" ref={resultHeadingRef} tabIndex={-1}>{prize.name}</h1>
            <div className="result-value"><span>Unverified fixture value</span><strong>{formatMYR(prize.valueSen)}</strong></div>
            <div className="result-identifiers"><span>Unique box <b>{box.id}</b></span><span>Manifest <b>{box.manifestId}</b></span></div>
            <Link className="button" to={`/order/${order.id}`}>Continue to fulfilment</Link>
          </div>
        ) : (
          <div className="reveal-control reveal-hold">
            <span className="eyebrow">FINANCIAL / FULFILMENT HOLD</span>
            <h1>Opening is paused.</h1>
            <p>{reveal.reason}</p>
            <Notice tone="danger">An unopened result cannot first reveal after cancellation, full refund, or dispute. Already revealed results stay viewable.</Notice>
            <Link className="button button-ghost" to={`/order/${order.id}`}>Return to order</Link>
          </div>
        )}
      </div>
      {hasRevealedResult && prize && (
        <div className="content reveal-manifest">
          <div className="manifest">
            <div className="manifest-stamp">Demo sample</div>
            <header><b>Value Manifest</b><span>{box.manifestId}</span></header>
            <p><span>SERIES</span><i /><b>001 · PAID ALLOCATION</b></p>
            <p><span>PRIZE</span><i /><b>{prize.shortName.toUpperCase()}</b></p>
            <p><span>TIER</span><i /><b>{prize.tier.toUpperCase()}</b></p>
            <p><span>FULFILMENT</span><i /><b>{prize.fulfilment}</b></p>
            <p><span>DEMO FLOOR ≥ RM100</span><i /><b className="manifest-pass">SAMPLE ✓</b></p>
            <div className="manifest-total"><span>UNVERIFIED DEMO VALUE</span><strong>{formatMYR(prize.valueSen)}</strong></div>
            <div className="barcode" />
            <footer><span>THE BLIND BOX COMPANY</span><span>{box.id.toUpperCase()}</span></footer>
          </div>
          <div>
            <span className="eyebrow">VALUE MANIFEST / IMMUTABLE RECORD</span>
            <h2>Your prize is locked.</h2>
            <p>The browser animation did not choose this. The mock webhook allocated it before opening, using remaining fixed Series 001 counts. Refunds never reroll it or return its slot.</p>
            <Link className="button button-ghost" to="/account">View all boxes</Link>
          </div>
        </div>
      )}
    </section>
  )
}
