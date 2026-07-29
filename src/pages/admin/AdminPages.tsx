import { useEffect, useMemo, useRef, useState } from 'react'
import type { PropsWithChildren } from 'react'
import { Link, NavLink, Navigate } from '../../lib/router'
import { useLocation, useNavigate, useSearchParams } from '../../lib/router-core'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Notice } from '../../components/Notice'
import { StatusBadge } from '../../components/StatusBadge'
import { ADMIN_SECTION_PERMISSIONS, type AdminSection } from '../../domain/constants'
import { isOpenClaimStatus } from '../../domain/claimStatus'
import {
  shipmentStatusActionEligibility,
  shipmentTrackingActionEligibility,
} from '../../domain/fulfillmentEligibility'
import { paymentRetryEligibility } from '../../domain/paymentEligibility'
import { resolveOrderFulfillment } from '../../domain/orderFulfillment'
import {
  claimBlocksFullPaymentRefund,
  findRemedyScopeConflict,
  isTerminalReplacementRefundFallback,
  remainingPaymentBalance,
  terminalReplacementFallbackAmount,
} from '../../domain/remedyPolicy'
import { prizeForBox, publishedPrizesFor } from '../../domain/selectors'
import type {
  Claim,
  ClaimSettlementPolicy,
  DemoState,
  Payment,
  Shipment,
  ShipmentStatus,
} from '../../domain/types'
import type { ClaimReviewAction } from '../../services/ClaimService'
import { formatDateTime, formatMYR, titleCase } from '../../lib/format'
import { useAppState } from '../../state/AppStateContext'

type ActionNotice = { text: string; tone: 'info' | 'success' | 'danger' } | null

function actionError(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback
}

function claimScopeLabel(claim: Claim) {
  if (claim.shipmentCandidateIds?.length) {
    return `Order-level candidates: ${claim.shipmentCandidateIds.join(', ')}`
  }
  if (claim.shipmentId) return `original shipment ${claim.shipmentId}`
  if (claim.boxId) return `box ${claim.boxId}`
  return `order ${claim.orderId}`
}

function shipmentWorkLabel(shipment: Shipment) {
  if (shipment.kind === 'DIGITAL') {
    return shipment.purpose === 'replacement' ? 'Digital reissue' : 'Digital delivery'
  }
  return shipment.purpose === 'replacement' ? 'Replacement shipment' : 'Original shipment'
}

type ClaimRefundUiPolicy = {
  amountSen: number
  eligible: boolean
  exactMatch: boolean
  policy?: ClaimSettlementPolicy
  reason: string
  remainingSen: number
}

function exactReplacementForClaim(state: DemoState, claim: Claim) {
  if (!claim.replacementShipmentId) return undefined
  return state.shipments.find((shipment) =>
    shipment.id === claim.replacementShipmentId &&
    shipment.orderId === claim.orderId &&
    shipment.sourceClaimId === claim.id &&
    shipment.purpose === 'replacement')
}

function deriveClaimRefundUiPolicy(
  state: DemoState,
  claim: Claim | undefined,
  payment: Payment | undefined,
): ClaimRefundUiPolicy {
  const remainingSen = payment ? remainingPaymentBalance(payment) : 0
  if (!claim || !payment) {
    return {
      amountSen: 0,
      eligible: false,
      exactMatch: false,
      reason: 'Exact linked payment or claim was not found.',
      remainingSen,
    }
  }
  const order = state.orders.find((entry) => entry.id === claim.orderId)
  const exactMatch = Boolean(
    order &&
    claim.orderId === payment.orderId &&
    claim.userId === payment.userId &&
    order.userId === claim.userId &&
    order.claimIds.includes(claim.id) &&
    order.paymentIds.includes(payment.id),
  )
  if (!exactMatch) {
    return {
      amountSen: 0,
      eligible: false,
      exactMatch: false,
      reason: `Payment ${payment.id} does not match the exact order and customer for claim ${claim.id}.`,
      remainingSen,
    }
  }
  if (claim.status !== 'approved') {
    return {
      amountSen: 0,
      eligible: false,
      exactMatch,
      reason: `Claim ${claim.id} is ${claim.status}; a linked refund requires an approved claim.`,
      remainingSen,
    }
  }
  if (claim.linkedRefundEventId) {
    return {
      amountSen: 0,
      eligible: false,
      exactMatch,
      reason: `Claim ${claim.id} is already linked to refund event ${claim.linkedRefundEventId}.`,
      remainingSen,
    }
  }
  const conflict = findRemedyScopeConflict(state.claims, claim)
  if (conflict) {
    return {
      amountSen: 0,
      eligible: false,
      exactMatch,
      reason: `Claim ${claim.id} cannot use a linked refund because claim ${conflict.holderClaimId} holds overlapping remedy entitlement for boxes ${conflict.remedyBoxIds.join(', ')}.`,
      remainingSen,
    }
  }

  const replacement = exactReplacementForClaim(state, claim)
  const terminalFallback = isTerminalReplacementRefundFallback(replacement)
  const ordinaryRefundPath =
    claim.replacementShipmentId === undefined &&
    (
      (claim.remedyState === 'none' && claim.rma === undefined) ||
      (claim.remedyState === 'rma_inspected' && claim.rma?.status === 'inspected')
    )
  if (!ordinaryRefundPath && !terminalFallback) {
    const reason = claim.replacementShipmentId
      ? replacement?.kind === 'DIGITAL'
        ? `Digital replacement ${replacement.id} is ${titleCase(replacement.status)}. Terminal replacement fallback is available only after it has failed.`
        : replacement
          ? `Physical replacement ${replacement.id} is ${titleCase(replacement.status)}. Terminal replacement fallback is available only when it is lost or returned; failed delivery is not eligible.`
          : `The exact replacement linked to claim ${claim.id} was not found.`
      : `Claim ${claim.id} is not on an ordinary refund path.`
    return {
      amountSen: 0,
      eligible: false,
      exactMatch,
      reason,
      remainingSen,
    }
  }

  const policy: ClaimSettlementPolicy = terminalFallback
    ? 'terminal_replacement_fallback'
    : 'exact_scope'
  const amountSen = terminalFallback
    ? remainingSen > 0
      ? terminalReplacementFallbackAmount(
          claim.requiredSettlementSen,
          remainingSen,
        )
      : 0
    : claim.requiredSettlementSen
  if (!['succeeded', 'partially_refunded'].includes(payment.status)) {
    return {
      amountSen,
      eligible: false,
      exactMatch,
      policy,
      reason: `Payment ${payment.id} is ${titleCase(payment.status)} and cannot accept a linked refund.`,
      remainingSen,
    }
  }
  if (remainingSen <= 0) {
    return {
      amountSen,
      eligible: false,
      exactMatch,
      policy,
      reason: `Payment ${payment.id} has no remaining refundable balance.`,
      remainingSen,
    }
  }
  if (!terminalFallback && remainingSen < amountSen) {
    return {
      amountSen,
      eligible: false,
      exactMatch,
      policy,
      reason: `Remaining payment balance ${formatMYR(remainingSen)} is below the exact claim-scope settlement of ${formatMYR(amountSen)} required by claim ${claim.id}.`,
      remainingSen,
    }
  }
  return {
    amountSen,
    eligible: true,
    exactMatch,
    policy,
    reason: terminalFallback
      ? `Capped terminal replacement fallback will refund ${formatMYR(amountSen)}, the smaller of claim ${claim.id}'s required settlement and payment ${payment.id}'s remaining balance.`
      : `Exact claim-scope settlement is available on payment ${payment.id}.`,
    remainingSen,
  }
}

function Allowed({ section, children }: { section: AdminSection; children: React.ReactNode }) {
  const { services } = useAppState()
  try {
    services.admin.viewForRole(section)
    return children
  } catch {
    return <Navigate to="/unauthorized" replace />
  }
}

export function AdminLayout({ children }: PropsWithChildren) {
  const { state } = useAppState()
  const actor = state.users.find((entry) => entry.id === state.sessionUserId)
  const location = useLocation()
  const sections: Array<{ id: AdminSection; label: string; to: string; end?: boolean }> = [
    { id: 'overview', label: 'Overview', to: '/admin', end: true },
    { id: 'users', label: 'Users', to: '/admin/users' },
    { id: 'orders', label: 'Orders', to: '/admin/orders' },
    { id: 'payments', label: 'Payments', to: '/admin/payments' },
    { id: 'inventory', label: 'Inventory', to: '/admin/inventory' },
    { id: 'fulfilment', label: 'Fulfilment', to: '/admin/fulfilment' },
    { id: 'claims', label: 'Claims', to: '/admin/claims' },
    { id: 'audit', label: 'Audit', to: '/admin/audit' },
  ]
  const visibleSections = sections.filter((section) => actor && ADMIN_SECTION_PERMISSIONS[section.id].includes(actor.role))
  if (location.pathname === '/admin' && actor && !ADMIN_SECTION_PERMISSIONS.overview.includes(actor.role)) {
    return <Navigate to={visibleSections[0]?.to ?? '/unauthorized'} replace />
  }
  return (
    <section className="admin-shell">
      <div className="admin-bar">
        <div><span>TBBC / CONTROL DECK</span><b>PUBLIC DEMO ADMIN</b></div>
        <div><span>ACTOR</span><b>{actor?.name} · {actor?.role}</b></div>
      </div>
      <div className="admin-layout">
        <aside className="admin-nav">
          <nav aria-label="Admin navigation">
            {visibleSections.map((section) => <NavLink end={section.end} to={section.to} key={section.id}>{section.label}</NavLink>)}
          </nav>
          <p>Every change is fictional, confirmed where sensitive, role-checked in a service, and appended to audit.</p>
        </aside>
        <div className="admin-main">{children}</div>
      </div>
    </section>
  )
}

function AdminHeading({ code, title, description }: { code: string; title: string; description: string }) {
  return <div className="admin-heading"><div><span>{code}</span><h1>{title}</h1><p>{description}</p></div><span className="huge-code">{code}</span></div>
}

export function AdminDashboardPage() {
  return <Allowed section="overview"><AdminDashboardContent /></Allowed>
}

function AdminDashboardContent() {
  const { services, state } = useAppState()
  const metrics = services.admin.dashboard()
  const exceptions = state.shipments.filter((entry) => ['failed_delivery', 'lost', 'returned'].includes(entry.status))
  const openClaims = state.claims.filter((entry) => isOpenClaimStatus(entry.status))
  return (
    <>
      <AdminHeading code="A00" title="Vault overview" description="Current fictional operations snapshot. Nothing here controls a real store." />
      <div className="metric-grid">
        <article><span>PAID DEMO VOLUME</span><b>{formatMYR(metrics.paidVolumeSen)}</b><small>not real revenue</small></article>
        <article><span>OPEN ORDERS</span><b>{metrics.openOrders}</b><small>across fixture + new journeys</small></article>
        <article><span>REMAINING BOXES</span><b>{metrics.remaining.toLocaleString()}</b><small>{metrics.reserved} reserved · {metrics.assigned} assigned</small></article>
        <article><span>EXCEPTIONS</span><b>{metrics.paymentExceptions + metrics.fulfilmentExceptions}</b><small>payment + fulfilment queue</small></article>
      </div>
      <div className="admin-dashboard-grid">
        <section className="panel">
          <div className="panel-heading"><div><span>PRIORITY QUEUE</span><h2>Needs fictional attention</h2></div><b>{exceptions.length + metrics.paymentExceptions + metrics.openClaims}</b></div>
          <div className="queue-list">
            {exceptions.map((shipment) => <Link key={shipment.id} to="/admin/fulfilment"><StatusBadge value={shipment.status} /><span><b>{shipment.trackingNumber}</b><small>{shipment.kind} · {shipment.orderId}</small></span><i>→</i></Link>)}
            {state.payments.filter((entry) => ['failed', 'expired', 'disputed'].includes(entry.status)).map((payment) => <Link key={payment.id} to="/admin/payments"><StatusBadge value={payment.status} /><span><b>{payment.id}</b><small>{formatMYR(payment.amountSen)} · attempt {payment.attempt}</small></span><i>→</i></Link>)}
            {openClaims.map((claim) => <Link key={claim.id} to="/admin/claims"><StatusBadge value={claim.status} /><span><b>{claim.id}</b><small>{titleCase(claim.kind)} · no automatic refund</small></span><i>→</i></Link>)}
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading"><div><span>OPERATIONS</span><h2>Protected work areas</h2></div></div>
          <div className="admin-shortcuts">
            <Link to="/admin/orders"><span>ORD</span><b>Inspect orders</b><small>Payment, boxes, address, claims</small></Link>
            <Link to="/admin/payments"><span>PAY</span><b>Reconcile payments</b><small>Events, retries, refunds</small></Link>
            <Link to="/admin/fulfilment"><span>FUL</span><b>Move shipments</b><small>Pack, label, ship, exception</small></Link>
            <Link to="/admin/claims"><span>CLM</span><b>Review claims</b><small>Acknowledge, approve, reject, typed remedy</small></Link>
            <Link to="/admin/audit"><span>AUD</span><b>Read audit</b><small>Append-only before and after</small></Link>
          </div>
        </section>
      </div>
    </>
  )
}

export function AdminUsersPage() {
  return <Allowed section="users"><AdminUsersContent /></Allowed>
}

function AdminUsersContent() {
  const { state, services } = useAppState()
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<{ id: string; status: 'active' | 'suspended' } | null>(null)
  const [notice, setNotice] = useState<ActionNotice>(null)
  const users = services.admin.searchUsers(query)
  const actor = state.users.find((entry) => entry.id === state.sessionUserId)
  const canOpenCombinedOrders = Boolean(actor && ADMIN_SECTION_PERMISSIONS.orders.includes(actor.role))
  const canMutateUsers = actor?.role === 'admin' || actor?.role === 'super_admin'

  const confirm = () => {
    if (!pending) return
    setNotice(null)
    try {
      services.admin.setUserStatus(pending.id, pending.status, `Confirmed demo ${pending.status} action for workflow review`)
      setNotice({ text: `User is now ${pending.status}.`, tone: 'success' })
    } catch (caught) {
      setNotice({ text: caught instanceof Error ? caught.message : 'Action was blocked.', tone: 'danger' })
    }
    setPending(null)
  }
  const openAction = (action: NonNullable<typeof pending>) => {
    setNotice(null)
    setPending(action)
  }

  return <>
    <AdminHeading code="A01" title="Users" description="Search fictional identities and inspect account status. Only admins can suspend or reactivate." />
    {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
    <label className="search-field"><span>SEARCH</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, fake email, role or status" /></label>
    <div className="responsive-table admin-table-wrap">
      <table className="data-table admin-table">
        <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Orders</th><th>Created</th><th>Action</th></tr></thead>
        <tbody>{users.map((user) => {
          const orderCount = state.orders.filter((order) => order.userId === user.id).length
          return (
            <tr key={user.id}>
              <td data-label="User"><b>{user.name}</b><small>{user.email}<br />{user.id}</small></td>
              <td data-label="Role">{titleCase(user.role)}</td>
              <td data-label="Status"><StatusBadge value={user.status} /></td>
              <td data-label="Orders">
                {canOpenCombinedOrders
                  ? (
                      <Link className="table-action table-link" to={`/admin/orders?user=${encodeURIComponent(user.id)}`}>
                        View {orderCount} order{orderCount === 1 ? '' : 's'}
                      </Link>
                    )
                  : <span>{orderCount} linked</span>}
              </td>
              <td data-label="Created">{formatDateTime(user.createdAt)}</td>
              <td data-label="Action">
                {canMutateUsers
                  ? (
                      <button className="table-action" type="button" disabled={actor?.id === user.id && user.status === 'active'} onClick={() => openAction({ id: user.id, status: user.status === 'active' ? 'suspended' : 'active' })}>
                        {user.status === 'active' ? 'Suspend' : 'Reactivate'}
                      </button>
                    )
                  : <span className="table-readonly">Read only</span>}
              </td>
            </tr>
          )
        })}</tbody>
      </table>
    </div>
    <ConfirmDialog open={Boolean(pending)} title={pending?.status === 'suspended' ? 'Suspend this fictional user?' : 'Reactivate this fictional user?'} confirmLabel={pending?.status === 'suspended' ? 'Confirm suspension' : 'Confirm reactivation'} danger={pending?.status === 'suspended'} onConfirm={confirm} onCancel={() => setPending(null)}>
      This changes local demo access and writes an audit record. It cannot affect a real person.
    </ConfirmDialog>
  </>
}

type OrderAction = { kind: 'cancel' | 'close'; id: string } | null

export function AdminOrdersPage() {
  const { state, services } = useAppState()
  const [searchParams, setSearchParams] = useSearchParams()
  const [statusFilter, setStatusFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<OrderAction>(null)
  const [notice, setNotice] = useState<ActionNotice>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const userFilter = searchParams.get('user') ?? 'all'
  const selectedUser = state.users.find((user) => user.id === userFilter)
  const actor = state.users.find((entry) => entry.id === state.sessionUserId)
  const canMutateOrders = actor?.role === 'admin' || actor?.role === 'super_admin'
  const pendingOrder = state.orders.find((order) => order.id === pending?.id)
  const orders = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return state.orders.filter((order) => {
      if (statusFilter !== 'all' && order.status !== statusFilter) return false
      if (userFilter !== 'all' && order.userId !== userFilter) return false
      if (!needle) return true
      const user = state.users.find((entry) => entry.id === order.userId)
      const paymentText = state.payments
        .filter((payment) => order.paymentIds.includes(payment.id))
        .map((payment) => `${payment.id} ${payment.status}`)
        .join(' ')
      const shipmentText = state.shipments
        .filter((shipment) => shipment.orderId === order.id)
        .map((shipment) => `${shipment.id} ${shipment.carrier} ${shipment.trackingNumber} ${shipment.status}`)
        .join(' ')
      return `${order.id} ${order.status} ${user?.name ?? ''} ${user?.email ?? ''} ${paymentText} ${shipmentText}`
        .toLowerCase()
        .includes(needle)
    })
  }, [query, state, statusFilter, userFilter])
  const setUserFilter = (userId: string) => {
    const next = new URLSearchParams(searchParams)
    if (userId === 'all') next.delete('user')
    else next.set('user', userId)
    setSearchParams(next)
  }
  const clearFilters = () => {
    setQuery('')
    setStatusFilter('all')
    setSearchParams({})
  }
  const perform = () => {
    if (!pending) return
    setNotice(null)
    setDialogError(null)
    try {
      if (pending.kind === 'cancel') {
        services.admin.changeOrderStatus(
          pending.id,
          'cancelled',
          'Confirmed demo cancellation after reviewing unpaid order and payment attempts',
        )
        setNotice({ text: 'Unpaid order cancelled, reservation released, and audit evidence saved.', tone: 'success' })
      } else {
        services.admin.changeOrderStatus(
          pending.id,
          'closed',
          'Confirmed demo closure after reviewing delivered fulfilment and claims',
        )
        setNotice({ text: 'Fulfilled order closed and audit evidence saved.', tone: 'success' })
      }
      setPending(null)
    } catch (caught) {
      setDialogError(actionError(caught, 'Order action was blocked.'))
    }
  }
  const openAction = (action: NonNullable<OrderAction>) => {
    setNotice(null)
    setDialogError(null)
    setPending(action)
  }
  return <Allowed section="orders"><>
    <AdminHeading code="A02" title="Orders" description="Frozen totals and address snapshots, payments, boxes, hidden allocations, timelines, fulfilment and claims." />
    {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
    {selectedUser && <Notice>Showing orders for <b>{selectedUser.name}</b> ({selectedUser.email}).</Notice>}
    <div className="admin-filters">
      <label className="search-field"><span>SEARCH ORDERS</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Order, user, payment or tracking" /></label>
      <label><span>USER</span><select value={userFilter} onChange={(event) => setUserFilter(event.target.value)}>
        <option value="all">All users</option>
        {state.users.map((user) => <option key={user.id} value={user.id}>{user.name} · {user.email}</option>)}
      </select></label>
      <button className="button button-ghost" type="button" onClick={clearFilters}>Clear filters</button>
    </div>
    <div className="filter-bar" role="group" aria-label="Order status filter">
      {['all', 'pending_payment', 'confirmed', 'processing', 'partially_fulfilled', 'fulfilled', 'closed', 'cancelled', 'refunded', 'disputed'].map((value) => <button key={value} className={statusFilter === value ? 'active' : ''} type="button" aria-pressed={statusFilter === value} onClick={() => setStatusFilter(value)}>{titleCase(value)}</button>)}
    </div>
    <div className="admin-record-list">
      {orders.map((order) => {
        const user = state.users.find((entry) => entry.id === order.userId)
        const payments = state.payments.filter((entry) => order.paymentIds.includes(entry.id))
        const boxes = state.boxes.filter((entry) => order.boxIds.includes(entry.id))
        const shipments = state.shipments.filter((entry) => entry.orderId === order.id)
        const claims = state.claims.filter((entry) => order.claimIds.includes(entry.id))
        const fulfilment = resolveOrderFulfillment(state, order)
        const completedScopes = fulfilment.scopes.filter((scope) => scope.status === 'fulfilled').length
        return (
          <details className="admin-record" key={order.id}>
            <summary><span><b>{order.id.toUpperCase()}</b><small>{user?.name} · {formatDateTime(order.createdAt)}</small></span><span>{formatMYR(order.snapshot.totals.totalSen)}</span><StatusBadge value={order.status} /></summary>
            <div className="record-detail-grid">
              <section><h3>Snapshot</h3><dl className="detail-list compact"><div><dt>Items</dt><dd>{order.snapshot.quantity} × {formatMYR(order.snapshot.unitPriceSen)}</dd></div><div><dt>Shipping</dt><dd>{order.snapshot.shippingMethod} · {formatMYR(order.snapshot.totals.shippingSen)}</dd></div><div><dt>Address</dt><dd>{order.snapshot.address.recipient}<br />{order.snapshot.address.line1}<br />{order.snapshot.address.postcode} {order.snapshot.address.city}</dd></div><div><dt>Policies</dt><dd>{order.snapshot.oddsVersion}<br />{order.snapshot.policyVersion}</dd></div></dl></section>
              <section><h3>Payment</h3>{payments.map((payment) => <p key={payment.id}><b>{payment.id}</b><br /><StatusBadge value={payment.status} /> · attempt {payment.attempt}</p>)}</section>
              <section><h3>Boxes / prize</h3>{boxes.map((box) => { const prize = prizeForBox(state, box); return <p key={box.id}><b>{box.id}</b><br />{prize?.name ?? 'Unallocated'} · <StatusBadge value={box.status} /></p> })}</section>
              <section>
                <h3>Box fulfilment scopes</h3>
                <p><b>{completedScopes} of {fulfilment.scopes.length} box fulfilment scopes complete</b><br /><StatusBadge value={fulfilment.status} /></p>
                <div className="order-scope-list">
                  {fulfilment.scopes.map((scope, index) => {
                    const original = shipments.find((shipment) => shipment.id === scope.originalShipmentId)
                    const scopeClaims = scope.affectedClaimIds
                      .map((claimId) => claims.find((claim) => claim.id === claimId))
                      .filter((claim) => claim !== undefined)
                    const openClaims = scopeClaims.filter((claim) => isOpenClaimStatus(claim.status))
                    const replacement = scope.replacementShipmentId
                      ? shipments.find((shipment) =>
                          shipment.id === scope.replacementShipmentId &&
                          shipment.orderId === order.id &&
                          shipment.purpose === 'replacement' &&
                          scope.boxIds.every((boxId) => shipment.boxIds.includes(boxId)))
                      : undefined
                    const refund = scopeClaims.find((claim) =>
                      claim.legacyUnderSettledRefund !== true &&
                      ['refund_linked', 'refund_completed'].includes(claim.remedyState))
                    const legacyRefund = scopeClaims.find((claim) =>
                      claim.legacyUnderSettledRefund === true)
                    const blocker = openClaims.length > 0
                      ? `Open claim: ${openClaims.map((claim) => claim.id).join(', ')}`
                      : scope.status !== 'fulfilled'
                        ? 'Waiting for original delivery or a completed audited remedy'
                        : 'No blocker'
                    return (
                      <article className="order-scope" key={`${scope.originalShipmentId}:${scope.boxIds.join(',')}`}>
                        <b>Scope {index + 1} · <span className="breakable-id">{scope.originalShipmentId}</span></b>
                        <small>Scope boxes: <span className="breakable-id scope-box-ids">{scope.boxIds.join(', ')}</span></small>
                        <small>Original: {original?.status ?? 'missing'}{scope.completedBy === 'original' ? ' · complete' : ''}</small>
                        <small>Replacement: {replacement ? `${replacement.status} · ${replacement.id}` : 'not used'}{scope.completedBy === 'replacement' ? ' · complete' : ''}</small>
                        <small>Refund: {refund?.remedyState === 'refund_completed'
                          ? `audited complete · ${refund.id}`
                          : refund?.remedyState === 'refund_linked'
                            ? `waiting final audit · ${refund.id}`
                            : 'not used'}</small>
                        {legacyRefund && <small>Legacy refund evidence: immutable under-settled record · not complete · {legacyRefund.id}</small>}
                        <small className={openClaims.length ? 'scope-blocker' : ''}>Blocker: {blocker}</small>
                      </article>
                    )
                  })}
                </div>
                {claims.map((claim) => (
                  <p key={claim.id}>
                    <b>{titleCase(claim.kind)} claim · {claim.id}</b><br />
                    <StatusBadge value={claim.status} /> · {claim.legacyUnderSettledRefund
                      ? <span className="table-readonly">Legacy under-settled · scope incomplete</span>
                      : <StatusBadge value={claim.remedyState} />}
                  </p>
                ))}
              </section>
            </div>
            {canMutateOrders && (
              <div className="record-actions">
                {order.status === 'pending_payment' && <button className="button button-danger" type="button" onClick={() => openAction({ kind: 'cancel', id: order.id })}>Cancel unpaid</button>}
                {order.status === 'fulfilled' && <button className="button" type="button" onClick={() => openAction({ kind: 'close', id: order.id })}>Close order</button>}
              </div>
            )}
            <ol className="mini-timeline">{order.timeline.map((entry) => <li key={entry.id}><b>{entry.label}</b><small>{formatDateTime(entry.at)} · {titleCase(entry.status)}</small></li>)}</ol>
          </details>
        )
      })}
      {orders.length === 0 && <div className="empty-state compact"><p>No fictional orders match these filters.</p></div>}
    </div>
    <ConfirmDialog
      open={Boolean(pending)}
      title={pending?.kind === 'cancel' ? 'Cancel this unpaid order?' : 'Close this fulfilled order?'}
      confirmLabel={pending?.kind === 'cancel' ? 'Confirm cancellation' : 'Confirm closure'}
      danger={pending?.kind === 'cancel'}
      error={dialogError}
      onConfirm={perform}
      onCancel={() => {
        setDialogError(null)
        setPending(null)
      }}
    >
      {pending?.kind === 'cancel'
        ? <>This releases the unpaid reservation only if no active payment attempt remains. The service rechecks order <b>{pendingOrder?.id}</b> and writes audit evidence.</>
        : <>This closes order <b>{pendingOrder?.id}</b> only when each box fulfilment scope has one complete path: its original delivery, a completed audited linked refund, or its delivered replacement. No open claim may remain. The service rechecks those exact scopes; it does not require every shipment row to be delivered.</>}
    </ConfirmDialog>
  </></Allowed>
}

type PaymentAction = {
  kind: 'retry' | 'reconcile' | 'partial' | 'full' | 'claim_refund' | 'dispute' | 'merchant_won' | 'dispute_refund'
  id: string
  claimId?: string
} | null

export function AdminPaymentsPage() {
  const { state, services } = useAppState()
  const [searchParams, setSearchParams] = useSearchParams()
  const [pending, setPending] = useState<PaymentAction>(null)
  const [notice, setNotice] = useState<ActionNotice>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const orderFilter = searchParams.get('order')
  const claimWorkflowActive = searchParams.has('claim')
  const claimFilter = searchParams.get('claim')
  const selectedClaim = claimWorkflowActive && claimFilter
    ? state.claims.find((claim) => claim.id === claimFilter)
    : undefined
  const selectedClaimOrder = selectedClaim
    ? state.orders.find((order) => order.id === selectedClaim.orderId)
    : undefined
  const selectedClaimConflict = selectedClaim
    ? findRemedyScopeConflict(state.claims, selectedClaim)
    : undefined
  const claimSelectionError = claimWorkflowActive
    ? !claimFilter
      ? 'The claim workflow filter is empty.'
      : !selectedClaim
      ? `Exact claim ${claimFilter} was not found.`
      : selectedClaim.status !== 'approved'
        ? `Claim ${selectedClaim.id} is ${selectedClaim.status}; a linked refund requires an approved claim.`
        : orderFilter && selectedClaim.orderId !== orderFilter
          ? `Claim ${selectedClaim.id} belongs to ${selectedClaim.orderId}, not exact order ${orderFilter}.`
          : !selectedClaimOrder ||
              selectedClaimOrder.userId !== selectedClaim.userId ||
              !selectedClaimOrder.claimIds.includes(selectedClaim.id)
            ? `Claim ${selectedClaim.id} does not match a valid exact order and customer.`
            : null
    : null
  const effectiveOrderFilter = orderFilter ?? selectedClaim?.orderId
  const filteredPayments = claimWorkflowActive && !selectedClaim
    ? []
    : effectiveOrderFilter
      ? state.payments.filter((payment) => payment.orderId === effectiveOrderFilter)
      : state.payments
  const pendingPayment = state.payments.find((entry) => entry.id === pending?.id)
  const pendingClaim = pending?.claimId
    ? state.claims.find((claim) => claim.id === pending.claimId)
    : undefined
  const pendingRemainingSen = pendingPayment
    ? remainingPaymentBalance(pendingPayment)
    : 0
  const pendingClaimRefundPolicy = pending?.kind === 'claim_refund'
    ? deriveClaimRefundUiPolicy(state, pendingClaim, pendingPayment)
    : undefined
  const pendingAmountSen = pending?.kind === 'partial'
    ? 1000
    : pending?.kind === 'full'
      ? pendingRemainingSen
      : pending?.kind === 'claim_refund'
        ? pendingClaimRefundPolicy?.amountSen ?? 0
      : 0
  const pendingTitle = pending?.kind === 'partial'
    ? `Confirm partial refund of ${formatMYR(pendingAmountSen)}?`
    : pending?.kind === 'full'
      ? `Confirm remaining refund of ${formatMYR(pendingAmountSen)}?`
      : pending?.kind === 'claim_refund'
        ? pendingClaimRefundPolicy?.policy === 'terminal_replacement_fallback'
          ? `Capped terminal replacement fallback of ${formatMYR(pendingAmountSen)} for claim ${pending.claimId}?`
          : `Exact claim-scope settlement of ${formatMYR(pendingAmountSen)} for claim ${pending.claimId}?`
      : `Confirm ${pending?.kind ?? ''} payment action?`
  const perform = () => {
    if (!pending) return
    setNotice(null)
    setDialogError(null)
    try {
      let result: { changed: boolean; message: string } | null = null
      if (pending.kind === 'retry') {
        services.payments.adminRetry(pending.id, 'Confirmed admin demo retry')
      }
      if (pending.kind === 'reconcile') {
        result = services.payments.processEvent(
          pending.id,
          `evt-admin-${pending.id}-${state.revision}`,
          'succeeded',
          'admin_reconcile',
        )
      }
      if (pending.kind === 'dispute') {
        result = services.payments.dispute(
          pending.id,
          'Confirmed fictional dispute requiring fulfilment hold',
          `evt-dispute-${pending.id}-${state.revision}`,
        )
      }
      if (pending.kind === 'merchant_won') {
        result = services.payments.resolveDispute(
          pending.id,
          'merchant_won',
          'Confirmed fictional dispute resolution restoring eligible fulfilment',
          `evt-dispute-win-${pending.id}-${state.revision}`,
        )
      }
      if (pending.kind === 'dispute_refund') {
        result = services.payments.resolveDispute(
          pending.id,
          'refund',
          'Confirmed fictional dispute resolution with full refund',
          `evt-dispute-refund-${pending.id}-${state.revision}`,
        )
      }
      const payment = state.payments.find((entry) => entry.id === pending.id)
      if (pending.kind === 'partial') {
        const remaining = (payment?.amountSen ?? 0) - (payment?.refundedSen ?? 0)
        if (remaining <= 1000) throw new Error('RM10 partial refund is unavailable when RM10 or less remains.')
        result = services.payments.refund(
          pending.id,
          1000,
          'Confirmed RM10 demo partial refund',
          `req-partial-${pending.id}-${state.revision}`,
        )
      }
      if (pending.kind === 'full') {
        if (!payment) throw new Error('Payment attempt was not found.')
        result = services.payments.refund(
          pending.id,
          payment.amountSen - payment.refundedSen,
          'Confirmed full demo refund; allocations retained',
          `req-full-${pending.id}-${state.revision}`,
        )
      }
      if (pending.kind === 'claim_refund') {
        const currentState = services.repository.getSnapshot()
        const currentPayment = currentState.payments.find((entry) => entry.id === pending.id)
        const currentClaim = pending.claimId
          ? currentState.claims.find((claim) => claim.id === pending.claimId)
          : undefined
        const currentPolicy = deriveClaimRefundUiPolicy(
          currentState,
          currentClaim,
          currentPayment,
        )
        if (!currentPolicy.eligible || !currentClaim || !currentPayment) {
          throw new Error(currentPolicy.reason)
        }
        if (
          !pendingClaimRefundPolicy?.eligible ||
          currentPolicy.policy !== pendingClaimRefundPolicy.policy ||
          currentPolicy.amountSen !== pendingClaimRefundPolicy.amountSen ||
          currentPolicy.remainingSen !== pendingClaimRefundPolicy.remainingSen
        ) {
          throw new Error('The claim or payment balance changed. Review the updated settlement before confirming.')
        }
        const reason = currentPolicy.policy === 'terminal_replacement_fallback'
          ? `Confirmed terminal replacement fallback for claim ${currentClaim.id}`
          : `Confirmed exact claim-scope settlement for claim ${currentClaim.id}`
        result = services.payments.refund(
          currentPayment.id,
          currentPolicy.amountSen,
          reason,
          `req-claim-refund-${currentClaim.id}-${currentPayment.id}`,
          currentClaim.id,
        )
      }
      setNotice(result
        ? { text: result.message, tone: result.changed ? 'success' : 'info' }
        : { text: `${titleCase(pending.kind)} action completed and audited.`, tone: 'success' })
      setPending(null)
    } catch (caught) {
      setDialogError(actionError(caught, 'Payment action was blocked.'))
    }
  }
  const openAction = (action: NonNullable<PaymentAction>) => {
    setNotice(null)
    setDialogError(null)
    setPending(action)
  }
  const clearClaimWorkflow = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('claim')
    setSearchParams(next)
  }
  return <Allowed section="payments"><>
    <AdminHeading code="A03" title="Payments" description="Attempts, immutable events, idempotent reconcile/retry and refunds. Redirects are never proof." />
    {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
    {claimWorkflowActive && claimSelectionError && (
      <Notice tone="danger">
        {claimSelectionError} No linked refund action is available. Unrelated payment actions are hidden while this claim workflow is active.
        {' '}<button className="table-action" type="button" onClick={clearClaimWorkflow}>Clear claim workflow</button>
      </Notice>
    )}
    {selectedClaim && !claimSelectionError && (
      <Notice>
        Exact claim <b>{selectedClaim.id}</b> is approved for order <b>{selectedClaim.orderId}</b>.
        {' '}{selectedClaimConflict
          ? <>Linked settlement is blocked because <Link className="table-action table-link breakable-id" to={`/admin/claims?claim=${encodeURIComponent(selectedClaimConflict.holderClaimId)}`}>claim {selectedClaimConflict.holderClaimId}</Link> holds overlapping remedy entitlement for boxes <b className="breakable-id">{selectedClaimConflict.remedyBoxIds.join(', ')}</b>.</>
          : isTerminalReplacementRefundFallback(exactReplacementForClaim(state, selectedClaim))
            ? <>Its terminal replacement fallback is capped at the smaller of required settlement <b>{formatMYR(selectedClaim.requiredSettlementSen)}</b> and the selected payment&apos;s remaining balance.</>
            : selectedClaim.replacementShipmentId
              ? <>Its replacement is not terminal-fallback eligible. The matching payment stays read only.</>
              : <>Its exact claim-scope settlement is <b>{formatMYR(selectedClaim.requiredSettlementSen)}</b> for remedy box{selectedClaim.remedyBoxIds.length === 1 ? '' : 'es'} <b className="breakable-id">{selectedClaim.remedyBoxIds.join(', ')}</b>.</>}
        {' '}{selectedClaimConflict
          ? <>Return to Claims to close this selected claim explicitly with no remedy.</>
          : <>Claims must be finalized separately after an accepted audited event is recorded.</>}
        {' '}Unrelated payment actions are hidden; leave or clear this claim workflow to use them.
        {' '}<button className="table-action" type="button" onClick={clearClaimWorkflow}>Clear claim workflow</button>
        {' '}<Link className="table-action table-link" to={`/admin/claims?claim=${encodeURIComponent(selectedClaim.id)}`}>Back to claim</Link>
      </Notice>
    )}
    {orderFilter && (
      <Notice>
        Showing only payments for exact order <b>{orderFilter}</b>.
        {' '}<button className="table-action" type="button" onClick={() => {
          const next = new URLSearchParams(searchParams)
          next.delete('order')
          setSearchParams(next)
        }}>Clear order filter</button>
      </Notice>
    )}
    <div className="admin-record-list">
      {[...filteredPayments].reverse().map((payment) => {
        const remainingSen = remainingPaymentBalance(payment)
        const order = state.orders.find((entry) => entry.id === payment.orderId)
        const orderPayments = order
          ? order.paymentIds
              .map((id) => state.payments.find((entry) => entry.id === id))
              .filter((entry) => entry !== undefined)
          : []
        const canRetry = Boolean(
          order && paymentRetryEligibility(order, payment, orderPayments).eligible,
        )
        const linkedRefundPolicy = selectedClaim && !claimSelectionError
          ? deriveClaimRefundUiPolicy(state, selectedClaim, payment)
          : undefined
        const fullRefundBlocker = state.claims.find((claim) =>
          claim.orderId === payment.orderId &&
          claimBlocksFullPaymentRefund(claim))
        const linkedClaimIds = [...new Set(payment.events
          .map((event) => event.refundIntent?.claimId)
          .filter((claimId) => claimId !== undefined))]
        return <details className="admin-record payment-record" key={payment.id}>
          <summary><span><b>{payment.id}</b><small>{payment.method ?? 'NO METHOD'} · attempt {payment.attempt}</small></span><span>{formatMYR(payment.amountSen)}<small>refunded {formatMYR(payment.refundedSen)}</small></span><StatusBadge value={payment.status} /></summary>
          {linkedClaimIds.length > 0 && (
            <div className="linked-records">
              <b>Linked claim{linkedClaimIds.length === 1 ? '' : 's'}</b>
              {linkedClaimIds.map((claimId) => (
                <Link className="table-action table-link breakable-id" key={claimId} to={`/admin/claims?claim=${encodeURIComponent(claimId)}`}>{claimId} · Back to claim</Link>
              ))}
            </div>
          )}
          {linkedRefundPolicy?.exactMatch && !linkedRefundPolicy.eligible && (
            <div className="notice notice-info">
              <b>Linked refund unavailable on this payment</b>
              <p>{linkedRefundPolicy.reason}</p>
              <small>Remaining payment balance: {formatMYR(linkedRefundPolicy.remainingSen)}</small>
            </div>
          )}
          {!claimWorkflowActive && fullRefundBlocker && (
            <div className="notice notice-info">
              <b>Full payment refund is coordinated through claim remedies</b>
              <p>
                <Link className="table-action table-link breakable-id" to={`/admin/claims?claim=${encodeURIComponent(fullRefundBlocker.id)}`}>Claim {fullRefundBlocker.id}</Link>
                {' '}blocks a generic full refund for this payment. Use the claim remedy workflow for any full settlement. Eligible RM10 partial goodwill and dispute marking remain separate.
              </p>
            </div>
          )}
          <div className="record-actions">
            {linkedRefundPolicy?.eligible && selectedClaim && (
              <button className="button" type="button" onClick={() => openAction({ kind: 'claim_refund', id: payment.id, claimId: selectedClaim.id })}>
                {linkedRefundPolicy.policy === 'terminal_replacement_fallback'
                  ? `Linked claim ${selectedClaim.id}: capped terminal replacement fallback ${formatMYR(linkedRefundPolicy.amountSen)}`
                  : `Linked claim ${selectedClaim.id}: exact claim-scope settlement ${formatMYR(linkedRefundPolicy.amountSen)}`}
              </button>
            )}
            {!claimWorkflowActive && <>
              {canRetry && <button className="button button-ghost" type="button" onClick={() => openAction({ kind: 'retry', id: payment.id })}>Retry attempt</button>}
              {['pending', 'processing'].includes(payment.status) && <button className="button" type="button" onClick={() => openAction({ kind: 'reconcile', id: payment.id })}>Reconcile succeeded</button>}
              {['succeeded', 'partially_refunded'].includes(payment.status) && remainingSen > 1000 && <button className="button button-ghost" type="button" onClick={() => openAction({ kind: 'partial', id: payment.id })}>Unlinked partial refund RM10</button>}
              {!fullRefundBlocker && ['succeeded', 'partially_refunded'].includes(payment.status) && remainingSen > 0 && <button className="button button-danger" type="button" onClick={() => openAction({ kind: 'full', id: payment.id })}>Unlinked refund remaining {formatMYR(remainingSen)}</button>}
              {['succeeded', 'partially_refunded'].includes(payment.status) && <button className="button button-danger" type="button" onClick={() => openAction({ kind: 'dispute', id: payment.id })}>Mark disputed</button>}
              {payment.status === 'disputed' && <button className="button" type="button" onClick={() => openAction({ kind: 'merchant_won', id: payment.id })}>Resolve: merchant won</button>}
              {payment.status === 'disputed' && !fullRefundBlocker && <button className="button button-danger" type="button" onClick={() => openAction({ kind: 'dispute_refund', id: payment.id })}>Resolve: full refund</button>}
            </>}
          </div>
          <div className="event-list">{payment.events.map((event) => <div key={event.id}><StatusBadge value={event.type} /><span><b>{event.id}</b><small>{event.source} · {formatDateTime(event.processedAt)}{event.ignoredReason ? ` · ${event.ignoredReason}` : ''}</small>{event.refundIntent?.claimId && <Link className="table-action table-link breakable-id" to={`/admin/claims?claim=${encodeURIComponent(event.refundIntent.claimId)}`}>Linked claim {event.refundIntent.claimId} · Back to claim</Link>}</span></div>)}</div>
        </details>
      })}
      {filteredPayments.length === 0 && <div className="empty-state compact"><p>No fictional payments match this exact order and claim selection.</p></div>}
    </div>
    <ConfirmDialog
      open={Boolean(pending)}
      title={pendingTitle}
      confirmLabel={pending?.kind === 'claim_refund'
        ? pendingClaimRefundPolicy?.policy === 'terminal_replacement_fallback'
          ? 'Confirm capped terminal fallback & audit'
          : 'Confirm exact settlement & audit'
        : 'Confirm and audit'}
      danger={['full', 'claim_refund', 'dispute', 'dispute_refund'].includes(pending?.kind ?? '')}
      error={dialogError}
      onConfirm={perform}
      onCancel={() => {
        setDialogError(null)
        setPending(null)
      }}
    >
      {pending?.kind === 'claim_refund'
        ? pendingClaimRefundPolicy?.eligible
          ? (
              <>
                <p>Exact claim <b>{pendingClaim?.id}</b> will link to exact payment <b>{pendingPayment?.id}</b>.</p>
                <dl className="detail-list compact">
                  <div><dt>Remedy box scope</dt><dd className="breakable-id">{pendingClaim?.remedyBoxIds.join(', ')}</dd></div>
                  <div><dt>Required claim settlement</dt><dd>{formatMYR(pendingClaim?.requiredSettlementSen ?? 0)}</dd></div>
                  <div><dt>Remaining payment balance</dt><dd>{formatMYR(pendingClaimRefundPolicy.remainingSen)}</dd></div>
                  <div><dt>Settlement policy</dt><dd>{titleCase(pendingClaimRefundPolicy.policy ?? '')}</dd></div>
                  <div><dt>Amount to refund</dt><dd><b>{formatMYR(pendingClaimRefundPolicy.amountSen)}</b></dd></div>
                </dl>
                <p>{pendingClaimRefundPolicy.policy === 'terminal_replacement_fallback'
                  ? `This capped terminal replacement fallback uses the smaller of the required claim settlement and the remaining payment balance: ${formatMYR(pendingClaimRefundPolicy.amountSen)}.`
                  : 'This is the exact claim-scope settlement. It may leave a separate remaining balance on the payment.'} Claims still requires a separate final audit action.</p>
              </>
            )
          : <p>This linked refund is no longer available. {pendingClaimRefundPolicy?.reason}</p>
        : pending?.kind === 'partial' || pending?.kind === 'full'
          ? <>This records exactly <b>{formatMYR(pendingAmountSen)}</b> as an unlinked local demo refund. It does not finalize a claim.</>
        : 'This is local demo money only. Full refunds and disputes stop eligible unshipped fulfilment. Claims never trigger this action automatically.'}
    </ConfirmDialog>
  </></Allowed>
}

export function AdminInventoryPage() {
  const { state, services } = useAppState()
  const published = state.series.find((entry) => entry.status === 'published')!
  const publishedPrizes = publishedPrizesFor(published)
  const draft = state.series.find((entry) => entry.status === 'draft')
  const [notice, setNotice] = useState<ActionNotice>(null)
  const [draftName, setDraftName] = useState(draft?.draftPrizes?.[0]?.name ?? publishedPrizes[0].name)
  const [draftValue, setDraftValue] = useState((draft?.draftPrizes?.[0]?.valueSen ?? publishedPrizes[0].valueSen) / 100)
  const assigned = published.inventory.reduce((sum, entry) => sum + entry.assigned, 0)
  const draftNameValid = draftName.trim().length > 0

  const copy = () => {
    setNotice(null)
    try {
      const result = services.admin.copyPublishedToDraft()
      setDraftName(result.draftPrizes?.[0]?.name ?? publishedPrizes[0].name)
      setNotice({ text: 'Editable draft copied. Published Series 001 stayed unchanged.', tone: 'success' })
    } catch (caught) {
      setNotice({ text: caught instanceof Error ? caught.message : 'The draft copy was blocked. Nothing changed; please try again.', tone: 'danger' })
    }
  }
  const saveDraft = () => {
    setNotice(null)
    try {
      services.admin.editDraftPrize('maggi', draftName, Math.round(draftValue * 100))
      setNotice({ text: 'Draft prize edited and audited. Published Series 001 stayed unchanged.', tone: 'success' })
    } catch (caught) {
      setNotice({ text: caught instanceof Error ? caught.message : 'Draft edit was blocked.', tone: 'danger' })
    }
  }
  return <Allowed section="inventory"><>
    <AdminHeading code="A04" title="Series inventory" description="Published Series 001 is read-only. Remaining counts are derived from compact assigned counters." />
    {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
    <div className="inventory-summary">
      <article><span>TOTAL</span><b>10,000</b></article><article><span>REMAINING</span><b>{(published.allocationTotal - assigned - published.reservedBoxes).toLocaleString()}</b></article><article><span>RESERVED</span><b>{published.reservedBoxes}</b></article><article><span>ASSIGNED</span><b>{assigned}</b></article>
    </div>
    <div className="responsive-table admin-table-wrap">
      <table className="data-table admin-table">
        <thead><tr><th>Published prize</th><th>Value</th><th>Allocation</th><th>Remaining</th><th>Reserved</th><th>Assigned</th></tr></thead>
        <tbody>{publishedPrizes.map((prize) => {
          const counter = published.inventory.find((entry) => entry.prizeId === prize.id)!
          return <tr key={prize.id}><td data-label="Prize"><b>{prize.name}</b><small>{prize.tier} · {prize.fulfilment}</small></td><td data-label="Value" className="money">{formatMYR(prize.valueSen)}</td><td data-label="Allocation">{prize.allocation.toLocaleString()}</td><td data-label="Remaining">{(prize.allocation - counter.assigned).toLocaleString()}</td><td data-label="Reserved">—</td><td data-label="Assigned">{counter.assigned}</td></tr>
        })}</tbody>
      </table>
    </div>
    <section className="panel draft-panel">
      <div className="panel-heading"><div><span>DRAFT WORKSPACE</span><h2>{draft ? draft.name : 'No draft copy'}</h2></div><StatusBadge value={draft ? 'draft' : 'published'} /></div>
      {!draft ? <button className="button" type="button" onClick={copy}>Copy published series to draft</button> : (
        <div className="form-grid">
          <label>Draft Maggi name<input required value={draftName} onChange={(event) => setDraftName(event.target.value)} />{!draftNameValid && <small>Prize name cannot be blank.</small>}</label>
          <label>Draft value in RM<input type="number" min="100" step="1" value={draftValue} onChange={(event) => setDraftValue(Number(event.target.value))} /></label>
          <button className="button" type="button" disabled={!draftNameValid} onClick={saveDraft}>Save draft-only edit</button>
        </div>
      )}
    </section>
  </></Allowed>
}

type FulfilmentAction =
  | { kind: 'status'; id: string; status: ShipmentStatus }
  | { kind: 'tracking'; id: string; carrier: string; trackingNumber: string }

const physicalFulfilmentActions: Array<{ status: ShipmentStatus; label: string }> = [
  { status: 'picking', label: 'Mark picking' },
  { status: 'packed', label: 'Mark packed' },
  { status: 'label_created', label: 'Create label' },
  { status: 'shipped', label: 'Mark shipped' },
  { status: 'delivered', label: 'Mark delivered' },
  { status: 'failed_delivery', label: 'Delivery exception' },
  { status: 'lost', label: 'Mark lost' },
  { status: 'returned', label: 'Mark returned' },
]

const digitalFulfilmentActions: Array<{ status: ShipmentStatus; label: string }> = [
  { status: 'issued', label: 'Issue' },
  { status: 'sent', label: 'Mark sent' },
  { status: 'delivered', label: 'Mark delivered' },
  { status: 'failed', label: 'Mark failed' },
]

export function AdminFulfilmentPage() {
  const { state, services } = useAppState()
  const [searchParams] = useSearchParams()
  const [pending, setPending] = useState<FulfilmentAction | null>(null)
  const [editing, setEditing] = useState<{ id: string; carrier: string; trackingNumber: string } | null>(null)
  const [notice, setNotice] = useState<ActionNotice>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const focusedRecordRef = useRef<HTMLElement | null>(null)
  const claimFocus = searchParams.get('claim')
  const shipmentFocus = searchParams.get('shipment')
  const actor = state.users.find((entry) => entry.id === state.sessionUserId)
  const canOpenClaims = Boolean(actor && ADMIN_SECTION_PERMISSIONS.claims.includes(actor.role))
  const focusedClaim = claimFocus
    ? state.claims.find((claim) => claim.id === claimFocus)
    : undefined
  const pendingShipment = pending?.kind === 'status'
    ? state.shipments.find((shipment) => shipment.id === pending.id)
    : undefined
  const isPostDeliveryReturn =
    pending?.kind === 'status' &&
    pending.status === 'returned' &&
    pendingShipment?.status === 'delivered'

  useEffect(() => {
    const record = focusedRecordRef.current
    if (!record) return
    record.scrollIntoView({ block: 'center' })
    record.focus({ preventScroll: true })
  }, [claimFocus, shipmentFocus])

  const perform = () => {
    if (!pending) return
    setNotice(null)
    setDialogError(null)
    try {
      if (pending.kind === 'status') {
        const postDeliveryReturn =
          pending.status === 'returned' &&
          state.shipments.find((shipment) => shipment.id === pending.id)?.status === 'delivered'
        services.fulfilment.advance(
          pending.id,
          pending.status,
          postDeliveryReturn
            ? 'Confirmed post-delivery return record; no claim or refund created'
            : `Confirmed demo ${pending.status.replaceAll('_', ' ')} scan`,
        )
        setNotice({
          text: postDeliveryReturn
            ? 'Post-delivery return recorded. No claim or refund was created.'
            : `Shipment moved to ${pending.status}.`,
          tone: 'success',
        })
      } else {
        services.fulfilment.setTracking(
          pending.id,
          pending.carrier,
          pending.trackingNumber,
          'Confirmed fictional carrier and tracking entry',
        )
        setNotice({ text: 'Carrier and tracking were updated and audited.', tone: 'success' })
        setEditing(null)
      }
      setPending(null)
    } catch (caught) {
      setDialogError(actionError(caught, 'Fulfilment action was blocked.'))
    }
  }
  const openAction = (action: FulfilmentAction) => {
    setNotice(null)
    setDialogError(null)
    setPending(action)
  }
  const openTrackingEdit = (shipment: { id: string; carrier: string; trackingNumber: string }) => {
    setNotice(null)
    setEditing(shipment)
  }
  return <Allowed section="fulfilment"><>
    <AdminHeading code="A05" title="Fulfilment" description="Original and replacement physical shipments use carrier scans. Digital delivery and reissue use only digital actions." />
    {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
    {claimFocus && !focusedClaim && <Notice tone="danger">Exact source claim <b>{claimFocus}</b> was not found.</Notice>}
    <div className="shipment-admin-grid">
      {state.shipments.map((shipment) => {
        const order = state.orders.find((entry) => entry.id === shipment.orderId)
        const canMoveTo = (status: ShipmentStatus) => Boolean(
          order && shipmentStatusActionEligibility(order.status, shipment, status).eligible,
        )
        const canEditTracking = Boolean(
          order && shipmentTrackingActionEligibility(order.status, shipment).eligible,
        )
        const focused = shipmentFocus
          ? shipment.id === shipmentFocus
          : shipment.sourceClaimId === claimFocus ||
            Boolean(
              focusedClaim &&
              shipment.purpose === 'original' &&
              (
                focusedClaim.shipmentId === shipment.id ||
                focusedClaim.shipmentCandidateIds?.includes(shipment.id)
              ),
            )
        const sourceClaim = shipment.sourceClaimId
          ? state.claims.find((claim) => claim.id === shipment.sourceClaimId)
          : undefined
        const original = shipment.replacementForShipmentId
          ? state.shipments.find((entry) => entry.id === shipment.replacementForShipmentId)
          : undefined
        const actions = shipment.kind === 'DIGITAL'
          ? digitalFulfilmentActions
          : physicalFulfilmentActions
        return <article
          className={`panel shipment-admin-card${focused ? ' focused-record' : ''}`}
          data-focused={focused || undefined}
          key={shipment.id}
          ref={(element) => {
            if (focused) focusedRecordRef.current = element
          }}
          tabIndex={focused ? -1 : undefined}
        >
          <div className="panel-heading">
            <div>
              <span>{shipmentWorkLabel(shipment)}</span>
              <small className="admin-record-id breakable-id">{shipment.kind} / {shipment.id}</small>
              <h2>{shipment.kind === 'DIGITAL' ? (shipment.purpose === 'replacement' ? 'Digital reissue record' : 'Digital delivery record') : shipment.trackingNumber}</h2>
            </div>
            <StatusBadge value={shipment.status} />
          </div>
          <dl className="detail-list compact">
            {shipment.kind !== 'DIGITAL' && <div><dt>Carrier</dt><dd>{shipment.carrier}</dd></div>}
            {shipment.kind !== 'DIGITAL' && <div><dt>Tracking</dt><dd className="breakable-id">{shipment.trackingNumber}</dd></div>}
            <div><dt>Boxes</dt><dd className="breakable-id">{shipment.boxIds.join(', ')}</dd></div>
            {shipment.kind !== 'DIGITAL' && <div><dt>Controls</dt><dd>{shipment.insured ? 'Insured' : 'Standard'}{shipment.signatureRequired ? ' · signature required' : ''}</dd></div>}
            {sourceClaim && (
              <div>
                <dt>Source claim</dt>
                <dd>
                  {canOpenClaims
                    ? <Link className="table-action table-link breakable-id" to={`/admin/claims?claim=${encodeURIComponent(sourceClaim.id)}`}>{sourceClaim.id}</Link>
                    : <span className="breakable-id">{sourceClaim.id} · Claims access required</span>}
                </dd>
              </div>
            )}
            {original && (
              <div>
                <dt>Original</dt>
                <dd><Link className="table-action table-link breakable-id" to={`/admin/fulfilment?shipment=${encodeURIComponent(original.id)}${sourceClaim ? `&claim=${encodeURIComponent(sourceClaim.id)}` : ''}`}>{original.id}</Link></dd>
              </div>
            )}
          </dl>
          <div className="record-actions">
            {actions.filter((action) => canMoveTo(action.status)).map((action) => (
              <button
                className={['failed', 'failed_delivery', 'lost'].includes(action.status) ? 'button button-danger' : action.status === 'returned' ? 'button button-ghost' : 'button'}
                key={action.status}
                type="button"
                onClick={() => openAction({ kind: 'status', id: shipment.id, status: action.status })}
              >
                {shipment.status === 'delivered' && action.status === 'returned'
                  ? 'Record post-delivery return'
                  : action.label}
              </button>
            ))}
            {canEditTracking && (
              <button className="button button-ghost" type="button" onClick={() => openTrackingEdit({ id: shipment.id, carrier: shipment.carrier, trackingNumber: shipment.trackingNumber })}>
                Edit carrier &amp; tracking
              </button>
            )}
          </div>
          {editing?.id === shipment.id && (
            <div className="tracking-entry-form">
              <label>Fictional carrier<input value={editing.carrier} onChange={(event) => setEditing({ ...editing, carrier: event.target.value })} /></label>
              <label>Fictional tracking code<input value={editing.trackingNumber} onChange={(event) => setEditing({ ...editing, trackingNumber: event.target.value })} /></label>
              <div className="record-actions">
                <button className="button button-ghost" type="button" onClick={() => setEditing(null)}>Cancel edit</button>
                <button className="button" type="button" onClick={() => openAction({ kind: 'tracking', ...editing })}>Review tracking change</button>
              </div>
              <small>Safety rule: the carrier must be visibly fictional and the code must start with DEMO-.</small>
            </div>
          )}
          <ol className="mini-timeline">{shipment.timeline.map((entry) => <li key={entry.id}><b>{entry.label}</b><small>{formatDateTime(entry.at)}</small></li>)}</ol>
        </article>
      })}
    </div>
    <ConfirmDialog
      open={Boolean(pending)}
      title={pending?.kind === 'tracking'
        ? 'Save this carrier and tracking entry?'
        : isPostDeliveryReturn
          ? 'Record this post-delivery return?'
          : `Move shipment to ${pending?.kind === 'status' ? titleCase(pending.status) : ''}?`}
      confirmLabel={pending?.kind === 'tracking'
        ? 'Confirm tracking & audit'
        : isPostDeliveryReturn
          ? 'Confirm return record & audit'
          : 'Confirm scan & audit'}
      danger={pending?.kind === 'status' && pending.status === 'failed_delivery'}
      error={dialogError}
      onConfirm={perform}
      onCancel={() => {
        setDialogError(null)
        setPending(null)
      }}
    >
      {pending?.kind === 'tracking'
        ? <>Carrier <b>{pending.carrier}</b> and tracking <b>{pending.trackingNumber}</b> will be validated, saved and appended to audit.</>
        : isPostDeliveryReturn
          ? <>This records exact {shipmentWorkLabel(pendingShipment!)} <b>{pendingShipment?.id}</b> as returned and reopens its original group. It does not create a claim or refund.</>
          : <>This moves exact {pendingShipment ? shipmentWorkLabel(pendingShipment) : 'fulfilment record'} <b>{pendingShipment?.id}</b> to <b>{pending?.kind === 'status' ? titleCase(pending.status) : ''}</b>. The guarded before and after states are appended to audit.</>}
    </ConfirmDialog>
  </></Allowed>
}

export function AdminClaimsPage() {
  return <Allowed section="claims"><AdminClaimsContent /></Allowed>
}

type ClaimReviewDialogAction = Exclude<ClaimReviewAction, 'resolve'>
type ClaimRemedyAction =
  | 'rma_create'
  | 'rma_received'
  | 'rma_inspected'
  | 'refund'
  | 'replacement'
  | 'finalize_refund'
  | 'no_remedy'
type ClaimDialog =
  | { kind: 'review'; id: string; action: ClaimReviewDialogAction }
  | { kind: 'remedy'; id: string }

function AdminClaimsContent() {
  const { services, state } = useAppState()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const claims = services.claims.queue()
  const actor = state.users.find((entry) => entry.id === state.sessionUserId)
  const canOpenPayments = Boolean(actor && ADMIN_SECTION_PERMISSIONS.payments.includes(actor.role))
  const canAuthorizeReplacement = actor?.role === 'admin' || actor?.role === 'super_admin'
  const focusedClaimId = searchParams.get('claim')
  const focusedClaimRef = useRef<HTMLElement | null>(null)
  const [pending, setPending] = useState<ClaimDialog | null>(null)
  const [note, setNote] = useState('Confirmed fictional claim review with no automatic refund.')
  const [remedyAction, setRemedyAction] = useState<ClaimRemedyAction>('rma_create')
  const [remedyReference, setRemedyReference] = useState('DEMO-RMA-001')
  const [notice, setNotice] = useState<ActionNotice>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const pendingClaim = state.claims.find((claim) => claim.id === pending?.id)

  const originalForClaim = (claim: Claim) => {
    const shipmentId =
      claim.shipmentId ??
      (claim.shipmentCandidateIds?.length === 1 ? claim.shipmentCandidateIds[0] : undefined) ??
      (claim.boxId
        ? state.boxes.find((box) => box.id === claim.boxId && box.orderId === claim.orderId)?.shipmentId
        : undefined)
    return state.shipments.find((shipment) =>
      shipment.id === shipmentId &&
      shipment.orderId === claim.orderId &&
      shipment.purpose === 'original')
  }
  const replacementForClaim = (claim: Claim) =>
    exactReplacementForClaim(state, claim)
  const claimOrderOnFinancialHold = (claim: Claim) => {
    const order = state.orders.find((entry) => entry.id === claim.orderId)
    return Boolean(
      order &&
      ['cancelled', 'refunded', 'disputed'].includes(order.status),
    )
  }

  const remedyOptions = (claim: Claim): Array<{ value: ClaimRemedyAction; label: string }> => {
    if (claim.status !== 'approved') return []
    if (claim.legacyUnderSettledRefund) return []
    const original = originalForClaim(claim)
    const replacement = replacementForClaim(claim)
    if (claim.remedyState === 'refund_linked' && claim.linkedRefundEventId) {
      return [{ value: 'finalize_refund', label: 'Finalize exact audited refund link' }]
    }
    if (claimOrderOnFinancialHold(claim)) {
      return claim.remedyState === 'none'
        ? [{ value: 'no_remedy', label: 'Close explicitly with no remedy' }]
        : []
    }
    if (claim.remedyState === 'rma_created') {
      return [{ value: 'rma_received', label: 'Record RMA received' }]
    }
    if (claim.remedyState === 'rma_received') {
      return [{ value: 'rma_inspected', label: 'Record RMA inspected' }]
    }
    if (
      claim.remedyState === 'replacement_authorized' &&
      isTerminalReplacementRefundFallback(replacement)
    ) {
      return canOpenPayments
        ? [{ value: 'refund', label: 'Open capped terminal replacement fallback in Payments' }]
        : []
    }
    if (!['none', 'rma_inspected'].includes(claim.remedyState)) return []
    const conflict = findRemedyScopeConflict(state.claims, claim)
    if (conflict) {
      return claim.remedyState === 'none'
        ? [{ value: 'no_remedy', label: 'Close explicitly with no remedy' }]
        : []
    }
    const options: Array<{ value: ClaimRemedyAction; label: string }> = []
    const deliveredBeforeClaim = original?.kind !== 'DIGITAL' &&
      original?.timeline.some((entry) =>
        entry.status === 'delivered' &&
        Date.parse(entry.at) <= Date.parse(claim.createdAt))
    if (claim.remedyState === 'none' && deliveredBeforeClaim) {
      options.push({ value: 'rma_create', label: 'Create physical return / RMA' })
    }
    if (canOpenPayments) options.push({ value: 'refund', label: 'Open exact claim-scope settlement in Payments' })
    if (canAuthorizeReplacement && original && (!claim.shipmentCandidateIds || claim.shipmentCandidateIds.length === 1)) {
      options.push({
        value: 'replacement',
        label: original.kind === 'DIGITAL' ? 'Authorize digital reissue' : 'Authorize replacement shipment',
      })
    }
    if (claim.remedyState === 'none') options.push({ value: 'no_remedy', label: 'Close explicitly with no remedy' })
    return options
  }

  useEffect(() => {
    const record = focusedClaimRef.current
    if (!record) return
    record.scrollIntoView({ block: 'center' })
    record.focus({ preventScroll: true })
  }, [focusedClaimId])

  const openReview = (id: string, action: ClaimReviewDialogAction) => {
    setNotice(null)
    setDialogError(null)
    setPending({ kind: 'review', id, action })
    setNote(`Confirmed fictional ${action} review for exact claim ${id}.`)
  }
  const openRemedy = (claim: Claim) => {
    const options = remedyOptions(claim)
    if (!options[0]) return
    setNotice(null)
    setDialogError(null)
    setPending({ kind: 'remedy', id: claim.id })
    setRemedyAction(options[0].value)
    setRemedyReference(claim.rma?.reference ?? `DEMO-RMA-${claim.id.toUpperCase()}`)
    setNote(`Confirmed fictional remedy evidence for exact claim ${claim.id}.`)
  }
  const perform = () => {
    if (!pending || !pendingClaim) return
    setNotice(null)
    setDialogError(null)
    try {
      if (pending.kind === 'review') {
        const result = services.claims.review(pending.id, pending.action, note)
        setNotice({ text: result.message, tone: 'success' })
        setPending(null)
        return
      }
      if (remedyAction === 'refund') {
        setPending(null)
        navigate(`/admin/payments?order=${encodeURIComponent(pendingClaim.orderId)}&claim=${encodeURIComponent(pendingClaim.id)}`)
        return
      }
      let result: { changed: boolean; message: string }
      if (remedyAction === 'rma_create') {
        result = services.claims.createRma(pendingClaim.id, remedyReference, note)
      } else if (remedyAction === 'rma_received') {
        result = services.claims.recordRmaReceived(pendingClaim.id, remedyReference, note)
      } else if (remedyAction === 'rma_inspected') {
        result = services.claims.recordRmaInspected(pendingClaim.id, remedyReference, note)
      } else if (remedyAction === 'replacement') {
        result = services.claims.authorizeReplacement(pendingClaim.id, note)
      } else if (remedyAction === 'finalize_refund') {
        if (!pendingClaim.linkedRefundEventId) throw new Error('The exact linked refund event is missing.')
        result = services.claims.review(
          pendingClaim.id,
          'resolve',
          note,
          { outcome: 'refund_recorded', reference: pendingClaim.linkedRefundEventId },
        )
      } else {
        result = services.claims.review(
          pendingClaim.id,
          'resolve',
          note,
          { outcome: 'no_remedy', reference: `DEMO-NO-REMEDY-${pendingClaim.id.toUpperCase()}` },
        )
      }
      setNotice({ text: result.message, tone: result.changed ? 'success' : 'info' })
      setPending(null)
    } catch (caught) {
      setDialogError(actionError(caught, 'Claim action was blocked.'))
    }
  }
  const pendingOptions = pendingClaim ? remedyOptions(pendingClaim) : []

  return <>
    <AdminHeading code="A06" title="Claims queue" description="Acknowledge, approve or reject first, then record one typed RMA, exact linked refund, replacement or explicit no-remedy path." />
    {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
    {focusedClaimId && !state.claims.some((claim) => claim.id === focusedClaimId) && <Notice tone="danger">Exact claim <b>{focusedClaimId}</b> was not found.</Notice>}
    <div className="admin-record-list claims-queue">
      {claims.map((claim) => {
        const focused = claim.id === focusedClaimId
        const original = originalForClaim(claim)
        const replacement = replacementForClaim(claim)
        const terminalFallbackEligible =
          isTerminalReplacementRefundFallback(replacement)
        const entitlementConflict = findRemedyScopeConflict(state.claims, claim)
        const claimOrder = state.orders.find((entry) => entry.id === claim.orderId)
        const orderFinancialHold = claimOrderOnFinancialHold(claim)
        const options = remedyOptions(claim)
        return (
        <details
          className={`admin-record claim-record${focused ? ' focused-record' : ''}`}
          data-focused={focused || undefined}
          key={claim.id}
          open
          ref={(element) => {
            if (focused) focusedClaimRef.current = element
          }}
          tabIndex={focused ? -1 : undefined}
        >
          <summary>
            <span><b>{claim.id}</b><small>{titleCase(claim.kind)} · {claim.orderId}</small></span>
            <span className="breakable-id">{claimScopeLabel(claim)}</span>
            <span className="status-pair">
              {claim.legacyUnderSettledRefund
                ? <span className="table-readonly">Legacy under-settled · scope incomplete</span>
                : <><StatusBadge value={claim.status} />{claim.remedyState !== 'none' && <StatusBadge value={claim.remedyState} />}</>}
            </span>
          </summary>
          <p>{claim.note}</p>
          <dl className="detail-list compact">
            <div><dt>Remedy box scope</dt><dd className="breakable-id">{claim.remedyBoxIds.join(', ')}</dd></div>
            <div><dt>Required settlement</dt><dd>{formatMYR(claim.requiredSettlementSen)}</dd></div>
            {claim.acceptedSettlementSen !== undefined && <div><dt>Accepted settlement</dt><dd>{formatMYR(claim.acceptedSettlementSen)}</dd></div>}
            <div>
              <dt>Settlement policy</dt>
              <dd>{claim.settlementPolicy
                ? titleCase(claim.settlementPolicy)
                : claim.legacyUnderSettledRefund
                  ? 'Legacy under-settled evidence · no completion policy'
                  : 'Not recorded'}</dd>
            </div>
            <div>
              <dt>Terminal fallback</dt>
              <dd>{replacement
                ? terminalFallbackEligible
                  ? `Available · capped at the smaller of required settlement ${formatMYR(claim.requiredSettlementSen)} and one selected payment's remaining balance · ${shipmentWorkLabel(replacement)} is ${titleCase(replacement.status)}`
                  : replacement.kind === 'DIGITAL'
                    ? `Unavailable while digital reissue is ${titleCase(replacement.status)}; only Failed is eligible`
                    : `Unavailable while physical replacement is ${titleCase(replacement.status)}; only Lost or Returned is eligible`
                : 'Not applicable · no replacement authorized'}</dd>
            </div>
          </dl>
          <div className="record-actions">
            {claim.status === 'submitted' && <button className="button" type="button" onClick={() => openReview(claim.id, 'acknowledge')}>Acknowledge</button>}
            {claim.status === 'reviewing' && <button className="button" type="button" onClick={() => openReview(claim.id, 'approve')}>Approve</button>}
            {['submitted', 'reviewing'].includes(claim.status) && <button className="button button-danger" type="button" onClick={() => openReview(claim.id, 'reject')}>Reject</button>}
            {options.length > 0 && <button className="button" type="button" onClick={() => openRemedy(claim)}>Record typed remedy</button>}
          </div>
          {claim.status === 'approved' && claim.remedyState === 'none' && entitlementConflict && (
            <div className="notice notice-info">
              <b>
                Overlapping remedy entitlement is held by{' '}
                <Link className="table-action table-link breakable-id" to={`/admin/claims?claim=${encodeURIComponent(entitlementConflict.holderClaimId)}`}>claim {entitlementConflict.holderClaimId}</Link>
              </b>
              <p>Overlapping remedy boxes: <span className="breakable-id">{entitlementConflict.remedyBoxIds.join(', ')}</span>. This claim cannot start a second RMA, refund, or replacement; only explicit no-remedy closure remains. The holder claim can continue its own remedy.</p>
            </div>
          )}
          {claim.status === 'approved' && orderFinancialHold && !claim.legacyUnderSettledRefund && (
            <div className="notice notice-info">
              <b>Financial hold limits typed remedy work</b>
              <p>
                Order <span className="breakable-id">{claim.orderId}</span> is {claimOrder?.status}.{' '}
                {claim.remedyState === 'refund_linked'
                  ? 'The existing linked refund may still be finalized through its exact final audit, but no RMA or replacement work can start.'
                  : claim.remedyState === 'none'
                    ? 'This approved claim may only close explicitly with no remedy while the hold remains.'
                    : 'Existing RMA or replacement evidence remains read-only until the financial hold is explicitly cleared.'}
              </p>
            </div>
          )}
          {claim.status === 'approved' && (
            <div className="notice notice-info">
              <b>{claim.legacyUnderSettledRefund
                ? 'Approved legacy claim · immutable evidence cannot finalize'
                : entitlementConflict && claim.remedyState === 'none'
                  ? 'Approved claim · only explicit no-remedy closure remains'
                  : orderFinancialHold
                    ? claim.remedyState === 'refund_linked'
                      ? 'Approved claim · linked-refund final audit remains available'
                      : 'Approved claim · financial hold limits typed remedies'
                    : 'Approved claim · typed remedy remains open'}</b>
              <p>Exact scope: <span className="breakable-id">{claimScopeLabel(claim)}</span>. {claim.legacyUnderSettledRefund
                ? 'The under-settled refund record is evidence only. It cannot complete this scope, and no final audit is available.'
                : entitlementConflict && claim.remedyState === 'none'
                  ? 'Another claim already owns the overlapping remedy entitlement. Approval does not create a second remedy.'
                  : orderFinancialHold
                    ? claim.remedyState === 'refund_linked'
                      ? 'The existing linked refund can still complete through its exact audited event; the financial hold blocks starting RMA or replacement work.'
                      : 'This order cannot start or advance typed RMA or replacement work while its financial hold remains.'
                    : 'Approval does not refund automatically. RMA evidence and replacement authorization do not resolve this claim. A replacement resolves only when its shipment is delivered; a refund requires a separate accepted event and final claim audit.'}</p>
              {!canOpenPayments && claim.remedyState !== 'refund_linked' && <span className="table-readonly">Payments is restricted to finance, admin and super admin.</span>}
            </div>
          )}
          {claim.rma && (
            <div className="notice notice-info">
              <b>RMA evidence · claim remains {claim.status}</b>
              <p><span className="breakable-id">{claim.rma.reference}</span> · <StatusBadge value={`rma_${claim.rma.status}`} /></p>
              <small>Created {formatDateTime(claim.rma.createdAt)}{claim.rma.receivedAt ? ` · received ${formatDateTime(claim.rma.receivedAt)}` : ''}{claim.rma.inspectedAt ? ` · inspected ${formatDateTime(claim.rma.inspectedAt)}` : ''}</small>
            </div>
          )}
          {claim.linkedRefundEventId && (
            <div className="notice notice-info">
              <b>{claim.legacyUnderSettledRefund
                ? 'Immutable legacy under-settled refund evidence'
                : claim.remedyState === 'refund_completed'
                  ? 'Audited refund complete'
                  : 'Refund linked · final Claims audit still required'}</b>
              <p className="breakable-id">{claim.linkedRefundEventId}</p>
              <p>Accepted <b>{formatMYR(claim.acceptedSettlementSen ?? 0)}</b> · required <b>{formatMYR(claim.requiredSettlementSen)}</b>.</p>
              {claim.legacyUnderSettledRefund && <p>This immutable record does not complete the delivery/remedy scope.</p>}
              {canOpenPayments && <Link className="table-action table-link" to={`/admin/payments?order=${encodeURIComponent(claim.orderId)}&claim=${encodeURIComponent(claim.id)}`}>Open linked payment record</Link>}
            </div>
          )}
          {replacement && (
            <div className="notice notice-info">
              <b>{shipmentWorkLabel(replacement)} · {replacement.status === 'delivered'
                ? 'delivered and final'
                : terminalFallbackEligible
                  ? 'capped terminal replacement fallback available'
                  : 'replacement in progress · refund fallback unavailable'}</b>
              <p className="breakable-id">{replacement.id} · original {original?.id}</p>
              {terminalFallbackEligible
                ? <p>Payments may now record a capped terminal replacement fallback using the smaller of required settlement <b>{formatMYR(claim.requiredSettlementSen)}</b> and one selected payment&apos;s remaining balance. The claim still needs a separate final audit.</p>
                : <p>{replacement.kind === 'DIGITAL'
                  ? 'Digital fallback becomes available only if this exact reissue fails.'
                  : 'Physical fallback becomes available only if this exact replacement is lost or returned. Failed delivery is not eligible.'}</p>}
              <Link className="table-action table-link" to={`/admin/fulfilment?claim=${encodeURIComponent(claim.id)}&shipment=${encodeURIComponent(replacement.id)}`}>Open linked fulfilment record</Link>
            </div>
          )}
          {['rejected', 'resolved'].includes(claim.status) && (
            <div className="notice notice-info">
              <b>{claim.legacyUnderSettledRefund
                ? 'Immutable legacy resolution record · not remedy completion'
                : 'Final read-only evidence · structured resolution recorded'}</b>
              <p>{titleCase(claim.resolutionOutcome ?? claim.status)} · <span className="breakable-id">{claim.resolutionReference ?? claim.id}</span></p>
              <small>{claim.resolutionNote ?? claim.history.at(-1)?.note}{claim.legacyUnderSettledRefund ? ' This does not complete the delivery/remedy scope.' : ''}</small>
            </div>
          )}
          <ol className="mini-timeline">{claim.history.map((entry) => <li key={entry.id}><b>{entry.note}</b><small>{formatDateTime(entry.at)} · {entry.actorRole} · {entry.status}</small></li>)}</ol>
          <p className="fine-print">Typed evidence only. Claims does not issue money; Payments records the exact refund event separately.</p>
        </details>
      )})}
      {claims.length === 0 && <div className="empty-state compact"><p>No fictional claims are waiting.</p></div>}
    </div>
    <ConfirmDialog
      open={Boolean(pending)}
      title={pending?.kind === 'review'
        ? `${titleCase(pending.action)} exact claim ${pending.id}?`
        : pendingClaim &&
            remedyAction === 'refund' &&
            isTerminalReplacementRefundFallback(replacementForClaim(pendingClaim))
          ? `Record capped terminal replacement fallback for exact claim ${pendingClaim.id}?`
          : `Record typed remedy for exact claim ${pendingClaim?.id}?`}
      confirmLabel={pending?.kind === 'review' ? 'Confirm note & audit' : remedyAction === 'refund' ? 'Open exact payment' : 'Confirm typed evidence'}
      danger={(pending?.kind === 'review' && pending.action === 'reject') || remedyAction === 'no_remedy'}
      error={dialogError}
      onConfirm={perform}
      onCancel={() => {
        setDialogError(null)
        setPending(null)
      }}
    >
      <label className="dialog-note">Required review note
        <textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      {pendingClaim && (
        <p>Exact claim <b>{pendingClaim.id}</b> covers <b className="breakable-id">{claimScopeLabel(pendingClaim)}</b>.</p>
      )}
      {pending?.kind === 'remedy' && (
        <>
          <fieldset className="remedy-choice">
            <legend>Choose one exact remedy action</legend>
            {pendingOptions.map((option) => (
              <label key={option.value}>
                <input type="radio" name="claim-remedy" value={option.value} checked={remedyAction === option.value} onChange={() => setRemedyAction(option.value)} />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
          {['rma_create', 'rma_received', 'rma_inspected'].includes(remedyAction) && (
            <label className="dialog-note">Exact fictional RMA reference
              <input value={remedyReference} onChange={(event) => setRemedyReference(event.target.value)} />
            </label>
          )}
          {remedyAction === 'finalize_refund' && <p>Finalization must use exact linked event <b className="breakable-id">{pendingClaim?.linkedRefundEventId}</b>.</p>}
          {remedyAction === 'refund' && (
            <p>{pendingClaim && isTerminalReplacementRefundFallback(replacementForClaim(pendingClaim))
              ? `Payments will offer a capped terminal replacement fallback using the smaller of required settlement ${formatMYR(pendingClaim.requiredSettlementSen)} and the selected payment’s remaining balance.`
              : `Payments will offer the exact required settlement of ${formatMYR(pendingClaim?.requiredSettlementSen ?? 0)} for remedy box${pendingClaim?.remedyBoxIds.length === 1 ? '' : 'es'} ${pendingClaim?.remedyBoxIds.join(', ')}.`} Returning here for a separate final audit is still required.</p>
          )}
        </>
      )}
      {pending?.kind === 'review' && <p>This appends exact claim history and audit evidence. It does not issue a refund.</p>}
    </ConfirmDialog>
  </>
}

export function AdminAuditPage() {
  const { state } = useAppState()
  return <Allowed section="audit"><>
    <AdminHeading code="A07" title="Append-only audit" description="Actor, role, action, target, reason, UTC time, request/event identity and before-after evidence." />
    <div className="audit-list">
      {[...state.audits].reverse().map((entry) => (
        <article className="audit-entry" key={entry.id}>
          <div><span>{entry.action}</span><b>{entry.targetType} / {entry.targetId}</b><small>{formatDateTime(entry.at)} · {entry.at}</small></div>
          <div><span>ACTOR</span><b>{entry.actorId}</b><small>{entry.actorRole}</small></div>
          <div><span>REASON</span><b>{entry.reason}</b><small>{entry.requestId}{entry.eventId ? ` · ${entry.eventId}` : ''}</small></div>
          {(entry.before !== undefined || entry.after !== undefined) && <details><summary>Before / after</summary><pre>{JSON.stringify({ before: entry.before, after: entry.after }, null, 2)}</pre></details>}
        </article>
      ))}
    </div>
  </></Allowed>
}
