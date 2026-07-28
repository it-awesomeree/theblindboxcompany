import { useMemo, useState } from 'react'
import type { PropsWithChildren } from 'react'
import { Link, NavLink, Navigate } from '../../lib/router'
import { useLocation, useSearchParams } from '../../lib/router-core'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { Notice } from '../../components/Notice'
import { StatusBadge } from '../../components/StatusBadge'
import { ADMIN_SECTION_PERMISSIONS, type AdminSection } from '../../domain/constants'
import { prizeForBox, publishedPrizesFor } from '../../domain/selectors'
import type { ClaimResolutionOutcome, ShipmentStatus } from '../../domain/types'
import type { ClaimReviewAction } from '../../services/ClaimService'
import { formatDateTime, formatMYR, titleCase } from '../../lib/format'
import { useAppState } from '../../state/AppStateContext'

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
  const openClaims = state.claims.filter((entry) => !['rejected', 'resolved'].includes(entry.status))
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
          <div className="panel-heading"><div><span>PRIORITY QUEUE</span><h2>Needs fictional attention</h2></div><b>{exceptions.length + metrics.paymentExceptions + openClaims.length}</b></div>
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
            <Link to="/admin/claims"><span>CLM</span><b>Review claims</b><small>Acknowledge, approve, reject, resolve</small></Link>
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
  const [message, setMessage] = useState('')
  const users = services.admin.searchUsers(query)
  const actor = state.users.find((entry) => entry.id === state.sessionUserId)
  const canOpenCombinedOrders = Boolean(actor && ADMIN_SECTION_PERMISSIONS.orders.includes(actor.role))
  const canMutateUsers = actor?.role === 'admin' || actor?.role === 'super_admin'

  const confirm = () => {
    if (!pending) return
    try {
      services.admin.setUserStatus(pending.id, pending.status, `Confirmed demo ${pending.status} action for workflow review`)
      setMessage(`User is now ${pending.status}.`)
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Action was blocked.')
    }
    setPending(null)
  }

  return <>
    <AdminHeading code="A01" title="Users" description="Search fictional identities and inspect account status. Only admins can suspend or reactivate." />
    {message && <Notice>{message}</Notice>}
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
                      <button className="table-action" type="button" disabled={actor?.id === user.id && user.status === 'active'} onClick={() => setPending({ id: user.id, status: user.status === 'active' ? 'suspended' : 'active' })}>
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
  const [notice, setNotice] = useState<{ text: string; tone: 'danger' | 'success' } | null>(null)
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
    } catch (caught) {
      setNotice({ text: caught instanceof Error ? caught.message : 'Order action was blocked.', tone: 'danger' })
    }
    setPending(null)
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
    <div className="filter-bar">
      {['all', 'pending_payment', 'confirmed', 'processing', 'partially_fulfilled', 'fulfilled', 'closed', 'cancelled', 'refunded', 'disputed'].map((value) => <button key={value} className={statusFilter === value ? 'active' : ''} type="button" onClick={() => setStatusFilter(value)}>{titleCase(value)}</button>)}
    </div>
    <div className="admin-record-list">
      {orders.map((order) => {
        const user = state.users.find((entry) => entry.id === order.userId)
        const payments = state.payments.filter((entry) => order.paymentIds.includes(entry.id))
        const boxes = state.boxes.filter((entry) => order.boxIds.includes(entry.id))
        const shipments = state.shipments.filter((entry) => entry.orderId === order.id)
        const claims = state.claims.filter((entry) => order.claimIds.includes(entry.id))
        return (
          <details className="admin-record" key={order.id}>
            <summary><span><b>{order.id.toUpperCase()}</b><small>{user?.name} · {formatDateTime(order.createdAt)}</small></span><span>{formatMYR(order.snapshot.totals.totalSen)}</span><StatusBadge value={order.status} /></summary>
            <div className="record-detail-grid">
              <section><h3>Snapshot</h3><dl className="detail-list compact"><div><dt>Items</dt><dd>{order.snapshot.quantity} × {formatMYR(order.snapshot.unitPriceSen)}</dd></div><div><dt>Shipping</dt><dd>{order.snapshot.shippingMethod} · {formatMYR(order.snapshot.totals.shippingSen)}</dd></div><div><dt>Address</dt><dd>{order.snapshot.address.recipient}<br />{order.snapshot.address.line1}<br />{order.snapshot.address.postcode} {order.snapshot.address.city}</dd></div><div><dt>Policies</dt><dd>{order.snapshot.oddsVersion}<br />{order.snapshot.policyVersion}</dd></div></dl></section>
              <section><h3>Payment</h3>{payments.map((payment) => <p key={payment.id}><b>{payment.id}</b><br /><StatusBadge value={payment.status} /> · attempt {payment.attempt}</p>)}</section>
              <section><h3>Boxes / prize</h3>{boxes.map((box) => { const prize = prizeForBox(state, box); return <p key={box.id}><b>{box.id}</b><br />{prize?.name ?? 'Unallocated'} · <StatusBadge value={box.status} /></p> })}</section>
              <section><h3>Fulfilment / claims</h3>{shipments.map((shipment) => <p key={shipment.id}><b>{shipment.trackingNumber}</b><br />{shipment.kind} · <StatusBadge value={shipment.status} /></p>)}{claims.map((claim) => <p key={claim.id}><b>{titleCase(claim.kind)} claim</b><br /><StatusBadge value={claim.status} /> · {claim.note}</p>)}</section>
            </div>
            {canMutateOrders && (
              <div className="record-actions">
                {order.status === 'pending_payment' && <button className="button button-danger" type="button" onClick={() => setPending({ kind: 'cancel', id: order.id })}>Cancel unpaid</button>}
                {order.status === 'fulfilled' && <button className="button" type="button" onClick={() => setPending({ kind: 'close', id: order.id })}>Close order</button>}
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
      onConfirm={perform}
      onCancel={() => setPending(null)}
    >
      {pending?.kind === 'cancel'
        ? <>This releases the unpaid reservation only if no active payment attempt remains. The service rechecks order <b>{pendingOrder?.id}</b> and writes audit evidence.</>
        : <>This closes order <b>{pendingOrder?.id}</b> only after every shipment is delivered and every claim is resolved or rejected. The service rechecks both conditions.</>}
    </ConfirmDialog>
  </></Allowed>
}

type PaymentAction = {
  kind: 'retry' | 'reconcile' | 'partial' | 'full' | 'dispute' | 'merchant_won' | 'dispute_refund'
  id: string
} | null

export function AdminPaymentsPage() {
  const { state, services } = useAppState()
  const [searchParams, setSearchParams] = useSearchParams()
  const [pending, setPending] = useState<PaymentAction>(null)
  const [message, setMessage] = useState('')
  const orderFilter = searchParams.get('order')
  const filteredPayments = orderFilter
    ? state.payments.filter((payment) => payment.orderId === orderFilter)
    : state.payments
  const pendingPayment = state.payments.find((entry) => entry.id === pending?.id)
  const pendingRemainingSen = pendingPayment
    ? pendingPayment.amountSen - pendingPayment.refundedSen
    : 0
  const pendingAmountSen = pending?.kind === 'partial'
    ? 1000
    : pending?.kind === 'full'
      ? pendingRemainingSen
      : 0
  const pendingTitle = pending?.kind === 'partial'
    ? `Confirm partial refund of ${formatMYR(pendingAmountSen)}?`
    : pending?.kind === 'full'
      ? `Confirm remaining refund of ${formatMYR(pendingAmountSen)}?`
      : `Confirm ${pending?.kind ?? ''} payment action?`
  const perform = () => {
    if (!pending) return
    try {
      let resultMessage = ''
      if (pending.kind === 'retry') services.payments.adminRetry(pending.id, 'Confirmed admin demo retry')
      if (pending.kind === 'reconcile') {
        resultMessage = services.payments.processEvent(
          pending.id,
          `evt-admin-${pending.id}-${state.revision}`,
          'succeeded',
          'admin_reconcile',
        ).message
      }
      if (pending.kind === 'dispute') {
        resultMessage = services.payments.dispute(
          pending.id,
          'Confirmed fictional dispute requiring fulfilment hold',
          `evt-dispute-${pending.id}-${state.revision}`,
        ).message
      }
      if (pending.kind === 'merchant_won') {
        resultMessage = services.payments.resolveDispute(
          pending.id,
          'merchant_won',
          'Confirmed fictional dispute resolution restoring eligible fulfilment',
          `evt-dispute-win-${pending.id}-${state.revision}`,
        ).message
      }
      if (pending.kind === 'dispute_refund') {
        resultMessage = services.payments.resolveDispute(
          pending.id,
          'refund',
          'Confirmed fictional dispute resolution with full refund',
          `evt-dispute-refund-${pending.id}-${state.revision}`,
        ).message
      }
      const payment = state.payments.find((entry) => entry.id === pending.id)
      if (pending.kind === 'partial') {
        const remaining = (payment?.amountSen ?? 0) - (payment?.refundedSen ?? 0)
        if (remaining <= 1000) throw new Error('RM10 partial refund is unavailable when RM10 or less remains.')
        resultMessage = services.payments.refund(
          pending.id,
          1000,
          'Confirmed RM10 demo partial refund',
          `req-partial-${pending.id}-${state.revision}`,
        ).message
      }
      if (pending.kind === 'full' && payment) {
        resultMessage = services.payments.refund(
          pending.id,
          payment.amountSen - payment.refundedSen,
          'Confirmed full demo refund; allocations retained',
          `req-full-${pending.id}-${state.revision}`,
        ).message
      }
      setMessage(resultMessage || `${titleCase(pending.kind)} action completed and audited.`)
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Payment action was blocked.')
    }
    setPending(null)
  }
  return <Allowed section="payments"><>
    <AdminHeading code="A03" title="Payments" description="Attempts, immutable events, idempotent reconcile/retry and refunds. Redirects are never proof." />
    {message && <Notice>{message}</Notice>}
    {orderFilter && (
      <Notice>
        Showing only payments for exact order <b>{orderFilter}</b>. An approved claim handoff does not refund automatically.
        {' '}<button className="table-action" type="button" onClick={() => {
          const next = new URLSearchParams(searchParams)
          next.delete('order')
          setSearchParams(next)
        }}>Clear order filter</button>
      </Notice>
    )}
    <div className="admin-record-list">
      {[...filteredPayments].reverse().map((payment) => {
        const remainingSen = payment.amountSen - payment.refundedSen
        return <details className="admin-record payment-record" key={payment.id}>
          <summary><span><b>{payment.id}</b><small>{payment.method ?? 'NO METHOD'} · attempt {payment.attempt}</small></span><span>{formatMYR(payment.amountSen)}<small>refunded {formatMYR(payment.refundedSen)}</small></span><StatusBadge value={payment.status} /></summary>
          <div className="record-actions">
            {['failed', 'cancelled', 'expired'].includes(payment.status) && <button className="button button-ghost" type="button" onClick={() => setPending({ kind: 'retry', id: payment.id })}>Retry attempt</button>}
            {['pending', 'processing'].includes(payment.status) && <button className="button" type="button" onClick={() => setPending({ kind: 'reconcile', id: payment.id })}>Reconcile succeeded</button>}
            {['succeeded', 'partially_refunded'].includes(payment.status) && remainingSen > 1000 && <button className="button button-ghost" type="button" onClick={() => setPending({ kind: 'partial', id: payment.id })}>Partial refund RM10</button>}
            {['succeeded', 'partially_refunded'].includes(payment.status) && remainingSen > 0 && <button className="button button-danger" type="button" onClick={() => setPending({ kind: 'full', id: payment.id })}>Refund remaining {formatMYR(remainingSen)}</button>}
            {['succeeded', 'partially_refunded'].includes(payment.status) && <button className="button button-danger" type="button" onClick={() => setPending({ kind: 'dispute', id: payment.id })}>Mark disputed</button>}
            {payment.status === 'disputed' && <button className="button" type="button" onClick={() => setPending({ kind: 'merchant_won', id: payment.id })}>Resolve: merchant won</button>}
            {payment.status === 'disputed' && <button className="button button-danger" type="button" onClick={() => setPending({ kind: 'dispute_refund', id: payment.id })}>Resolve: full refund</button>}
          </div>
          <div className="event-list">{payment.events.map((event) => <div key={event.id}><StatusBadge value={event.type} /><span><b>{event.id}</b><small>{event.source} · {formatDateTime(event.processedAt)}{event.ignoredReason ? ` · ${event.ignoredReason}` : ''}</small></span></div>)}</div>
        </details>
      })}
      {filteredPayments.length === 0 && <div className="empty-state compact"><p>No fictional payments match this exact order.</p></div>}
    </div>
    <ConfirmDialog open={Boolean(pending)} title={pendingTitle} confirmLabel="Confirm and audit" danger={['full', 'dispute', 'dispute_refund'].includes(pending?.kind ?? '')} onConfirm={perform} onCancel={() => setPending(null)}>
      {pending?.kind === 'partial' || pending?.kind === 'full'
        ? <>This records exactly <b>{formatMYR(pendingAmountSen)}</b> in local demo money. Claims never trigger this action automatically.</>
        : 'This is local demo money only. Full refunds and disputes stop eligible unshipped fulfilment. Claims never trigger this action automatically.'}
    </ConfirmDialog>
  </></Allowed>
}

export function AdminInventoryPage() {
  const { state, services } = useAppState()
  const published = state.series.find((entry) => entry.status === 'published')!
  const publishedPrizes = publishedPrizesFor(published)
  const draft = state.series.find((entry) => entry.status === 'draft')
  const [message, setMessage] = useState('')
  const [draftName, setDraftName] = useState(draft?.draftPrizes?.[0]?.name ?? publishedPrizes[0].name)
  const [draftValue, setDraftValue] = useState((draft?.draftPrizes?.[0]?.valueSen ?? publishedPrizes[0].valueSen) / 100)
  const assigned = published.inventory.reduce((sum, entry) => sum + entry.assigned, 0)

  const copy = () => {
    try {
      const result = services.admin.copyPublishedToDraft()
      setDraftName(result.draftPrizes?.[0]?.name ?? publishedPrizes[0].name)
      setMessage('Editable draft copied. Published Series 001 stayed unchanged.')
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'The draft copy was blocked. Nothing changed; please try again.')
    }
  }
  const saveDraft = () => {
    try {
      services.admin.editDraftPrize('maggi', draftName, Math.round(draftValue * 100))
      setMessage('Draft prize edited and audited. Published Series 001 stayed unchanged.')
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Draft edit was blocked.')
    }
  }
  return <Allowed section="inventory"><>
    <AdminHeading code="A04" title="Series inventory" description="Published Series 001 is read-only. Remaining counts are derived from compact assigned counters." />
    {message && <Notice>{message}</Notice>}
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
          <label>Draft Maggi name<input value={draftName} onChange={(event) => setDraftName(event.target.value)} /></label>
          <label>Draft value in RM<input type="number" min="100" step="1" value={draftValue} onChange={(event) => setDraftValue(Number(event.target.value))} /></label>
          <button className="button" type="button" onClick={saveDraft}>Save draft-only edit</button>
        </div>
      )}
    </section>
  </></Allowed>
}

const nextStatus: Partial<Record<ShipmentStatus, ShipmentStatus>> = {
  unfulfilled: 'picking',
  picking: 'packed',
  packed: 'label_created',
  label_created: 'shipped',
  shipped: 'delivered',
  failed_delivery: 'shipped',
}

type FulfilmentAction =
  | { kind: 'status'; id: string; status: ShipmentStatus }
  | { kind: 'tracking'; id: string; carrier: string; trackingNumber: string }

export function AdminFulfilmentPage() {
  const { state, services } = useAppState()
  const [pending, setPending] = useState<FulfilmentAction | null>(null)
  const [editing, setEditing] = useState<{ id: string; carrier: string; trackingNumber: string } | null>(null)
  const [message, setMessage] = useState('')
  const pendingShipment = pending?.kind === 'status'
    ? state.shipments.find((shipment) => shipment.id === pending.id)
    : undefined
  const isPostDeliveryReturn =
    pending?.kind === 'status' &&
    pending.status === 'returned' &&
    pendingShipment?.status === 'delivered'
  const perform = () => {
    if (!pending) return
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
        setMessage(postDeliveryReturn
          ? 'Post-delivery return recorded. No claim or refund was created.'
          : `Shipment moved to ${pending.status}.`)
      } else {
        services.fulfilment.setTracking(
          pending.id,
          pending.carrier,
          pending.trackingNumber,
          'Confirmed fictional carrier and tracking entry',
        )
        setMessage('Carrier and tracking were updated and audited.')
        setEditing(null)
      }
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Fulfilment action was blocked.')
    }
    setPending(null)
  }
  return <Allowed section="fulfilment"><>
    <AdminHeading code="A05" title="Fulfilment" description="Picking, packing, split shipment, carrier, tracking, delivery and exception controls remain available on mobile." />
    {message && <Notice>{message}</Notice>}
    <div className="shipment-admin-grid">
      {state.shipments.map((shipment) => {
        const next = nextStatus[shipment.status]
        return <article className="panel shipment-admin-card" key={shipment.id}>
          <div className="panel-heading"><div><span>{shipment.kind} / {shipment.id}</span><h2>{shipment.trackingNumber}</h2></div><StatusBadge value={shipment.status} /></div>
          <dl className="detail-list compact"><div><dt>Carrier</dt><dd>{shipment.carrier}</dd></div><div><dt>Boxes</dt><dd>{shipment.boxIds.join(', ')}</dd></div><div><dt>Controls</dt><dd>{shipment.insured ? 'Insured' : 'Standard'}{shipment.signatureRequired ? ' · signature required' : ''}</dd></div></dl>
          <div className="record-actions">
            {next && <button className="button" type="button" onClick={() => setPending({ kind: 'status', id: shipment.id, status: next })}>Mark {titleCase(next)}</button>}
            {['unfulfilled', 'picking', 'packed', 'label_created'].includes(shipment.status) && (
              <button className="button button-ghost" type="button" onClick={() => setEditing({ id: shipment.id, carrier: shipment.carrier, trackingNumber: shipment.trackingNumber })}>
                Edit carrier &amp; tracking
              </button>
            )}
            {shipment.status === 'shipped' && <button className="button button-danger" type="button" onClick={() => setPending({ kind: 'status', id: shipment.id, status: 'failed_delivery' })}>Delivery exception</button>}
            {shipment.status === 'shipped' && <button className="button button-danger" type="button" onClick={() => setPending({ kind: 'status', id: shipment.id, status: 'lost' })}>Mark lost</button>}
            {shipment.status === 'shipped' && <button className="button button-ghost" type="button" onClick={() => setPending({ kind: 'status', id: shipment.id, status: 'returned' })}>Mark returned</button>}
            {shipment.status === 'delivered' && <button className="button button-ghost" type="button" onClick={() => setPending({ kind: 'status', id: shipment.id, status: 'returned' })}>Record post-delivery return</button>}
          </div>
          {editing?.id === shipment.id && (
            <div className="tracking-entry-form">
              <label>Fictional carrier<input value={editing.carrier} onChange={(event) => setEditing({ ...editing, carrier: event.target.value })} /></label>
              <label>Fictional tracking code<input value={editing.trackingNumber} onChange={(event) => setEditing({ ...editing, trackingNumber: event.target.value })} /></label>
              <div className="record-actions">
                <button className="button button-ghost" type="button" onClick={() => setEditing(null)}>Cancel edit</button>
                <button className="button" type="button" onClick={() => setPending({ kind: 'tracking', ...editing })}>Review tracking change</button>
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
      onConfirm={perform}
      onCancel={() => setPending(null)}
    >
      {pending?.kind === 'tracking'
        ? <>Carrier <b>{pending.carrier}</b> and tracking <b>{pending.trackingNumber}</b> will be validated, saved and appended to audit.</>
        : isPostDeliveryReturn
          ? 'This records a returned shipment and reopens fulfilment. It does not create a claim or refund.'
          : 'This advances one guarded fictional shipment transition. The before and after states are appended to audit.'}
    </ConfirmDialog>
  </></Allowed>
}

export function AdminClaimsPage() {
  return <Allowed section="claims"><AdminClaimsContent /></Allowed>
}

function AdminClaimsContent() {
  const { services, state } = useAppState()
  const claims = services.claims.queue()
  const actor = state.users.find((entry) => entry.id === state.sessionUserId)
  const canOpenPayments = Boolean(actor && ADMIN_SECTION_PERMISSIONS.payments.includes(actor.role))
  const [pending, setPending] = useState<{ id: string; action: ClaimReviewAction } | null>(null)
  const [note, setNote] = useState('Confirmed fictional claim review with no automatic refund.')
  const [resolutionOutcome, setResolutionOutcome] = useState<ClaimResolutionOutcome>('replacement_authorized')
  const [resolutionReference, setResolutionReference] = useState('DEMO-REPLACEMENT-001')
  const [message, setMessage] = useState('')
  const openReview = (id: string, action: ClaimReviewAction) => {
    setPending({ id, action })
    if (action === 'resolve') {
      setResolutionOutcome('replacement_authorized')
      setResolutionReference(`DEMO-${id.toUpperCase()}`)
      setNote('Confirmed fictional replacement handoff with documented demo evidence.')
    }
  }
  const perform = () => {
    if (!pending) return
    try {
      const result = services.claims.review(
        pending.id,
        pending.action,
        note,
        pending.action === 'resolve'
          ? { outcome: resolutionOutcome, reference: resolutionReference }
          : undefined,
      )
      setMessage(result.message)
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Claim action was blocked.')
    }
    setPending(null)
  }
  return <>
    <AdminHeading code="A06" title="Claims queue" description="Eligibility-linked customer claims with guarded review notes. Refunds stay separate in Payments." />
    {message && <Notice>{message}</Notice>}
    <div className="admin-record-list claims-queue">
      {claims.map((claim) => (
        <details className="admin-record claim-record" open key={claim.id}>
          <summary>
            <span><b>{claim.id}</b><small>{titleCase(claim.kind)} · {claim.orderId}</small></span>
            <span>
              {claim.shipmentCandidateIds
                ? `Order-level candidates: ${claim.shipmentCandidateIds.join(', ')}`
                : claim.shipmentId ?? claim.boxId}
            </span>
            <StatusBadge value={claim.status} />
          </summary>
          <p>{claim.note}</p>
          <div className="record-actions">
            {claim.status === 'submitted' && <button className="button" type="button" onClick={() => openReview(claim.id, 'acknowledge')}>Acknowledge</button>}
            {claim.status === 'reviewing' && <button className="button" type="button" onClick={() => openReview(claim.id, 'approve')}>Approve</button>}
            {['submitted', 'reviewing'].includes(claim.status) && <button className="button button-danger" type="button" onClick={() => openReview(claim.id, 'reject')}>Reject</button>}
            {claim.status === 'approved' && <button className="button" type="button" onClick={() => openReview(claim.id, 'resolve')}>Resolve</button>}
          </div>
          {claim.status === 'approved' && (
            <div className="notice notice-info">
              <b>Approved claim finance / RMA handoff</b>
              <p>This stays open until structured remedy evidence is recorded. Approval does not refund automatically; finance must use a separate audited payment action.</p>
              {canOpenPayments
                ? <Link className="table-action table-link" to={`/admin/payments?order=${encodeURIComponent(claim.orderId)}`}>Open Payments for {claim.orderId}</Link>
                : <span className="table-readonly">Read only · finance or an admin must complete the payment review.</span>}
            </div>
          )}
          {claim.status === 'resolved' && (
            <div className="notice notice-info">
              <b>Structured resolution recorded</b>
              <p>{titleCase(claim.resolutionOutcome ?? '')} · {claim.resolutionReference}</p>
              <small>{claim.resolutionNote}</small>
            </div>
          )}
          <ol className="mini-timeline">{claim.history.map((entry) => <li key={entry.id}><b>{entry.note}</b><small>{formatDateTime(entry.at)} · {entry.actorRole} · {entry.status}</small></li>)}</ol>
          <p className="fine-print">Claim state only. No refund is created here.</p>
        </details>
      ))}
      {claims.length === 0 && <div className="empty-state compact"><p>No fictional claims are waiting.</p></div>}
    </div>
    <ConfirmDialog
      open={Boolean(pending)}
      title={`${titleCase(pending?.action ?? 'review')} this claim?`}
      confirmLabel="Confirm note & audit"
      danger={pending?.action === 'reject'}
      onConfirm={perform}
      onCancel={() => setPending(null)}
    >
      <label className="dialog-note">Required review note
        <textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      {pending?.action === 'resolve' && (
        <>
          <label className="dialog-note">Structured outcome
            <select value={resolutionOutcome} onChange={(event) => setResolutionOutcome(event.target.value as ClaimResolutionOutcome)}>
              <option value="replacement_authorized">Replacement authorized</option>
              <option value="return_rma_created">Return / RMA created</option>
              <option value="refund_recorded">Refund already recorded</option>
              <option value="no_remedy">No remedy</option>
            </select>
          </label>
          <label className="dialog-note">
            {resolutionOutcome === 'refund_recorded' ? 'Audited refund event ID' : 'Fictional DEMO- reference'}
            <input value={resolutionReference} onChange={(event) => setResolutionReference(event.target.value)} />
          </label>
        </>
      )}
      <p>This appends claim history and audit evidence. It does not issue a refund.</p>
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
