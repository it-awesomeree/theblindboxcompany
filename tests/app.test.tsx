import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../src/App'
import { AppServices } from '../src/services/AppServices'
import { AppStateProvider } from '../src/state/AppState'
import { MemoryStorage, FIXED_NOW } from './helpers'
import { VaultCanvas } from '../src/components/VaultCanvas'
import { DEMO_ADDRESS } from '../src/data/fixtures'

function renderApp(storage = new MemoryStorage()) {
  window.history.replaceState({}, '', '#/')
  const services = new AppServices(storage, () => FIXED_NOW)
  render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
  return services
}

describe('app components', () => {
  it('shows a visible demo warning and preserves the approved homepage tagline', () => {
    renderApp()
    expect(screen.getByText('DEMO PROTOTYPE')).toBeVisible()
    expect(screen.getByRole('heading', { name: /the blind box that always wins/i })).toBeVisible()
    expect(screen.getByText(/proposed demo tagline/i)).toBeVisible()
    expect(screen.getByText(/boosted demo opener/i)).toBeVisible()
  })

  it('one-click customer access persists in app state', async () => {
    const user = userEvent.setup()
    const services = renderApp()
    await user.click(screen.getByRole('link', { name: /demo sign in/i }))
    await user.click(screen.getByRole('button', { name: /one-click aina demo/i }))
    expect(services.auth.currentUser()?.role).toBe('customer')
    expect(await screen.findByRole('heading', { name: 'Aina Demo' })).toBeVisible()
  })

  it('shows constructor storage fallback while keeping its memory-only demo session usable', async () => {
    const user = userEvent.setup()
    const storage = new MemoryStorage()
    storage.setItem = (key, value) => {
      void key
      void value
      throw new Error('browser quota failure')
    }
    const services = new AppServices(storage, () => FIXED_NOW)
    window.history.replaceState({}, '', '#/auth')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    await user.click(screen.getByRole('button', { name: /one-click aina demo/i }))

    expect(services.auth.currentUser()?.role).toBe('customer')
    expect(await screen.findByText(/could not save it.+continuing in memory only/i)).toBeVisible()
    expect(await screen.findByRole('heading', { name: 'Aina Demo' })).toBeVisible()
  })

  it('requires styled confirmation before resetting demo data', async () => {
    const user = userEvent.setup()
    const services = renderApp()
    services.auth.oneClick('customer')
    services.orders.setCartQuantity(3)

    await user.click(screen.getByRole('button', { name: /reset demo data/i }))
    const dialog = screen.getByRole('dialog', { name: /reset all demo data/i })
    expect(dialog).toBeVisible()
    expect(dialog).toHaveTextContent(/restores the safe starting fixtures/i)
    expect(services.repository.getSnapshot().sessionUserId).toBe('usr-demo-customer')

    await user.click(within(dialog).getByRole('button', { name: /go back/i }))
    expect(screen.queryByRole('dialog', { name: /reset all demo data/i })).not.toBeInTheDocument()
    expect(services.repository.getSnapshot().cart[0].quantity).toBe(3)

    await user.click(screen.getByRole('button', { name: /reset demo data/i }))
    await user.click(screen.getByRole('button', { name: /confirm demo reset/i }))
    expect(services.repository.getSnapshot()).toEqual(expect.objectContaining({
      sessionUserId: null,
      cart: [expect.objectContaining({ quantity: 1 })],
    }))
  })

  it('keeps reset confirmation open and reports an atomic storage failure before retrying', async () => {
    const user = userEvent.setup()
    const storage = new MemoryStorage()
    const services = renderApp(storage)
    services.auth.oneClick('customer')
    services.orders.setCartQuantity(3)
    const before = services.repository.exportForTest()
    const storedBefore = storage.getItem('tbbc:demo:repository:v5')
    const originalSetItem = storage.setItem.bind(storage)
    let failNextWrite = true
    storage.setItem = (key, value) => {
      if (failNextWrite) {
        failNextWrite = false
        throw new Error('browser quota failure')
      }
      originalSetItem(key, value)
    }

    await user.click(screen.getByRole('button', { name: /reset demo data/i }))
    const dialog = screen.getByRole('dialog', { name: /reset all demo data/i })
    await user.click(within(dialog).getByRole('button', { name: /confirm demo reset/i }))

    expect(dialog).toBeVisible()
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/nothing changed.+try again/i)
    expect(services.repository.getSnapshot()).toEqual(before)
    expect(storage.getItem('tbbc:demo:repository:v5')).toBe(storedBefore)

    await user.click(within(dialog).getByRole('button', { name: /confirm demo reset/i }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /reset all demo data/i })).not.toBeInTheDocument()
    })
    expect(services.repository.getSnapshot()).toEqual(expect.objectContaining({
      sessionUserId: null,
      cart: [expect.objectContaining({ quantity: 1 })],
    }))
  })

  it('service-protects direct admin navigation for a customer', async () => {
    const services = renderApp()
    services.auth.oneClick('customer')
    window.location.hash = '#/admin'
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(await screen.findByRole('heading', { name: /admin access blocked/i })).toBeVisible()
  })

  it('redirects a support role to its first allowed section and hides other departments', async () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.repository.update((state) => { state.sessionUserId = 'usr-support' })
    window.history.replaceState({}, '', '#/admin')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(await screen.findByRole('heading', { name: 'Users' })).toBeVisible()
    const adminNavigation = screen.getByRole('navigation', { name: /admin navigation/i })
    expect(adminNavigation).toHaveTextContent('Users')
    expect(adminNavigation).toHaveTextContent('Claims')
    expect(adminNavigation).not.toHaveTextContent('Overview')
    expect(adminNavigation).not.toHaveTextContent('Orders')
    expect(adminNavigation).not.toHaveTextContent('Payments')
    expect(adminNavigation).not.toHaveTextContent('Fulfilment')
    expect(screen.getAllByText('Read only').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reactivate' })).not.toBeInTheDocument()
  })

  it('keeps direct Payments access blocked for support', async () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.repository.update((state) => { state.sessionUserId = 'usr-support' })
    window.history.replaceState({}, '', '#/admin/payments')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(await screen.findByRole('heading', { name: /admin access blocked/i })).toBeVisible()
  })

  it('keeps the priority queue total equal to its visible links and counts only open claims', () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    const activeClaim = services.claims.submit({
      orderId: 'ord-shipped',
      kind: 'non_delivery',
      shipmentId: 'shp-shipped',
      note: 'DEMO active priority queue claim',
    }).data
    const rejectedClaim = services.claims.submit({
      orderId: 'ord-failed',
      kind: 'non_delivery',
      shipmentId: 'shp-failed',
      note: 'DEMO rejected priority queue claim',
    }).data
    const resolvedClaim = services.claims.submit({
      orderId: 'ord-delivered',
      kind: 'damage',
      shipmentId: 'shp-delivered',
      note: 'DEMO resolved priority queue claim',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(rejectedClaim.id, 'reject', 'Confirmed rejected queue regression')
    services.claims.review(resolvedClaim.id, 'acknowledge', 'Confirmed resolved queue acknowledgement')
    services.claims.review(resolvedClaim.id, 'approve', 'Confirmed resolved queue approval')
    services.claims.review(resolvedClaim.id, 'resolve', 'Confirmed resolved queue regression')
    window.history.replaceState({}, '', '#/admin')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const priorityQueue = screen.getByRole('heading', { name: /needs fictional attention/i }).closest('section')!
    const visibleQueueLinks = within(priorityQueue).getAllByRole('link')
    expect(within(priorityQueue).getByText(String(visibleQueueLinks.length), { selector: '.panel-heading > b' })).toBeVisible()
    expect(within(priorityQueue).getByText(activeClaim.id)).toBeVisible()
    expect(within(priorityQueue).queryByText(rejectedClaim.id)).not.toBeInTheDocument()
    expect(within(priorityQueue).queryByText(resolvedClaim.id)).not.toBeInTheDocument()
  })

  it('makes the WebGL fallback the only keyboard/click target and reflects opening', async () => {
    window.history.replaceState({}, '', '?nogl=1#/')
    const activate = vi.fn()
    const view = render(<VaultCanvas onActivate={activate} label="Activate fallback vault" />)
    const fallback = await screen.findByTestId('webgl-fallback')
    expect(fallback).toHaveAttribute('tabindex', '0')
    expect(document.querySelector('canvas')).toHaveAttribute('tabindex', '-1')
    fireEvent.keyDown(fallback, { key: 'Enter' })
    fireEvent.click(fallback)
    expect(activate).toHaveBeenCalledTimes(2)
    view.rerender(<VaultCanvas onActivate={activate} label="Activate fallback vault" openSignal={1} holdOpen />)
    expect(fallback).toHaveClass('is-open')
    expect(fallback).toHaveAttribute('aria-pressed', 'true')
  })

  it('hides opening controls after a full refund while keeping an honest hold explanation', async () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('admin')
    const payment = services.repository.getSnapshot().payments.find((entry) => entry.orderId === 'ord-unopened')!
    services.payments.refund(payment.id, payment.amountSen, 'Confirmed UI hold regression refund', 'req-ui-hold')
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/open/box-unopened-01')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(await screen.findByRole('heading', { name: /opening is paused/i })).toBeVisible()
    expect(screen.queryByRole('button', { name: /break demo seal/i })).not.toBeInTheDocument()
    expect(screen.getByText(/cannot first reveal after cancellation/i)).toBeVisible()
  })

  it('keeps an already revealed immutable result viewable after its full refund', async () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/open/box-refunded-01')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(await screen.findByRole('heading', { name: /beras 10kg/i })).toBeVisible()
    expect(screen.getByText(/value manifest \/ immutable record/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: /break demo seal/i })).not.toBeInTheDocument()
  })

  it('shows only legal provider actions after a payment becomes processing', async () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    const order = services.orders.create({
      requestId: 'checkout_0000000000000000000000000000a001',
      quantity: 1,
      shippingMethod: 'standard',
      address: DEMO_ADDRESS,
      acknowledged: true,
      displayedTotalSen: 11_200,
    })
    const payment = services.payments.createAttempt(order.id)
    services.payments.act(payment.id, 'delayed')
    window.history.replaceState({}, '', `#/pay/${order.id}/${payment.id}`)
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(await screen.findByRole('button', { name: /approve \+ valid mock webhook/i })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Expire' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delayed pending/i })).not.toBeInTheDocument()
  })

  it('rejects cross-order payment route tampering for the signed-in customer', async () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/pay/ord-unopened/pay-delivered')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(await screen.findByRole('heading', { name: /nothing is sealed here/i })).toBeVisible()
  })

  it('rejects a valid payment route owned by another customer', async () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.repository.update((state) => {
      state.users.push({
        id: 'usr-route-other',
        name: 'Route Other',
        email: 'route.other@example.test',
        role: 'customer',
        status: 'active',
        createdAt: FIXED_NOW,
      })
      state.sessionUserId = 'usr-route-other'
    })
    services.orders.setCartQuantity(1)
    const otherOrder = services.orders.create({
      requestId: 'checkout_0000000000000000000000000000a002',
      quantity: 1,
      shippingMethod: 'standard',
      address: { ...DEMO_ADDRESS, recipient: 'Route Other' },
      acknowledged: true,
      displayedTotalSen: 11_200,
    })
    const otherPayment = services.payments.createAttempt(otherOrder.id)
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', `#/pay/${otherOrder.id}/${otherPayment.id}`)
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(await screen.findByRole('heading', { name: /nothing is sealed here/i })).toBeVisible()
  })

  it('shows a captured disputed payment honestly in Account', () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('admin')
    services.payments.dispute('pay-unopened', 'Confirmed account dispute display test', 'evt-account-dispute')
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/account')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const record = screen.getByText('ORD-UNOPENED').closest('article')!
    expect(within(record).getAllByText('Disputed')).toHaveLength(2)
    expect(within(record).getByText(/captured · under dispute/i)).toBeVisible()
    expect(within(record).queryByText('Not confirmed')).not.toBeInTheDocument()
  })

  it('separates a captured dispute from pending payment on the return page', () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('admin')
    services.payments.dispute('pay-unopened', 'Confirmed return-page dispute display test', 'evt-return-dispute')
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/payment-return/pay-unopened')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(screen.getByRole('heading', { name: /captured payment under dispute/i })).toBeVisible()
    expect(screen.getByText(/was captured and is now under dispute and review/i)).toBeVisible()
    expect(screen.getByText(/browser redirect is never proof/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: /delayed valid webhook/i })).not.toBeInTheDocument()
  })

  it('shows guarded order cancellation and closure controls and completes a valid closure', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    services.orders.setCartQuantity(1)
    const unpaid = services.orders.create({
      requestId: 'checkout_0000000000000000000000000000a003',
      quantity: 1,
      shippingMethod: 'standard',
      address: DEMO_ADDRESS,
      acknowledged: true,
      displayedTotalSen: 11_200,
    })
    services.auth.oneClick('admin')
    window.history.replaceState({}, '', '#/admin/orders')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const unpaidRecord = screen.getByText(unpaid.id.toUpperCase()).closest('details')!
    await user.click(unpaidRecord.querySelector('summary')!)
    expect(within(unpaidRecord).getByRole('button', { name: 'Cancel unpaid' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Disputed' })).toBeVisible()

    const fulfilledRecord = screen.getByText('ORD-DELIVERED').closest('details')!
    await user.click(fulfilledRecord.querySelector('summary')!)
    const close = within(fulfilledRecord).getByRole('button', { name: 'Close order' })
    expect(close).toBeVisible()
    await user.click(close)
    expect(screen.getByRole('dialog', { name: /close this fulfilled order/i })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Confirm closure' }))
    expect(await screen.findByText(/fulfilled order closed and audit evidence saved/i)).toBeVisible()
    expect(services.repository.getSnapshot().orders.find((order) => order.id === 'ord-delivered')?.status).toBe('closed')
    expect(services.repository.getSnapshot().audits.at(-1)?.action).toBe('order.transitioned')
  })

  it('lets the cancellation service block an active payment attempt from Admin Orders', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    services.orders.setCartQuantity(1)
    const order = services.orders.create({
      requestId: 'checkout_0000000000000000000000000000a004',
      quantity: 1,
      shippingMethod: 'standard',
      address: DEMO_ADDRESS,
      acknowledged: true,
      displayedTotalSen: 11_200,
    })
    services.payments.createAttempt(order.id)
    services.auth.oneClick('admin')
    window.history.replaceState({}, '', '#/admin/orders')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const record = screen.getByText(order.id.toUpperCase()).closest('details')!
    await user.click(record.querySelector('summary')!)
    await user.click(within(record).getByRole('button', { name: 'Cancel unpaid' }))
    await user.click(screen.getByRole('button', { name: 'Confirm cancellation' }))
    expect(await screen.findByText(/cancel or expire the active payment/i)).toBeVisible()
    expect(services.repository.getSnapshot().orders.find((entry) => entry.id === order.id)?.status).toBe('pending_payment')
  })

  it('hands an approved claim to an exact-order Payments filter without refunding', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    const claim = services.claims.submit({
      orderId: 'ord-shipped',
      kind: 'non_delivery',
      shipmentId: 'shp-shipped',
      note: 'DEMO overdue shipment finance handoff',
    }).data
    const refundedBefore = services.repository.getSnapshot().payments.find((payment) => payment.id === 'pay-shipped')!.refundedSen
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Confirmed finance handoff acknowledgement')
    services.claims.review(claim.id, 'approve', 'Confirmed finance handoff approval review')
    window.history.replaceState({}, '', '#/admin/claims')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const record = screen.getByText(claim.id).closest('details')!
    expect(within(record).getByText(/does not refund automatically/i)).toBeVisible()
    await user.click(within(record).getByRole('link', { name: /open payments for ord-shipped/i }))
    expect(await screen.findByRole('heading', { name: 'Payments' })).toBeVisible()
    expect(screen.getByText(/showing only payments for exact order/i)).toHaveTextContent('ord-shipped')
    expect(screen.getByText('pay-shipped')).toBeVisible()
    expect(screen.queryByText('pay-unopened')).not.toBeInTheDocument()
    expect(services.repository.getSnapshot().payments.find((payment) => payment.id === 'pay-shipped')?.refundedSen).toBe(refundedBefore)

    await user.click(screen.getByRole('button', { name: 'Clear order filter' }))
    expect(await screen.findByText('pay-unopened')).toBeVisible()
  })

  it('guards checkout double-submit in flight and creates only one order', async () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    services.orders.setCartQuantity(1)
    const before = services.repository.getSnapshot().orders.length
    const create = vi.spyOn(services.orders, 'create')
    window.history.replaceState({}, '', '#/checkout')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    fireEvent.click(screen.getByRole('checkbox'))
    const submit = screen.getByRole('button', { name: /reserve & continue/i })
    fireEvent.click(submit)
    expect(submit).toBeDisabled()
    expect(submit).toHaveAttribute('aria-busy', 'true')
    fireEvent.click(submit)
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(services.repository.getSnapshot().orders).toHaveLength(before + 1)
  })

  it('keeps sealed-order fulfilment private and reveals it only after every box opens', () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/order/ord-unopened')
    const view = render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(screen.getByText(/fulfilment details stay private until every box/i)).toBeVisible()
    expect(screen.queryByText('DEMO-P-UNOPENED')).not.toBeInTheDocument()
    expect(screen.queryByText('Demo Express')).not.toBeInTheDocument()
    expect(screen.queryByText('PARCEL')).not.toBeInTheDocument()
    expect(screen.queryByText(/signature required/i)).not.toBeInTheDocument()

    view.unmount()
    window.history.replaceState({}, '', '#/order/ord-shipped')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(screen.getByText('DEMO-P-SHIPPED')).toBeVisible()
    expect(screen.getByText('Demo Express')).toBeVisible()
    expect(screen.getByText(/signature required/i)).toBeVisible()
  })

  it('keeps mixed-order shipment claim clues sealed while allowing revealed-box value-floor claims', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/claim/new?order=ord-processing')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    expect(screen.getByText(/shipment-linked claim details unlock after all boxes in this order are opened/i)).toBeVisible()
    expect(screen.queryByLabelText('Relevant shipment')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Fictional note')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /submit demo claim/i })).not.toBeInTheDocument()
    for (const shipmentClue of [
      'shp-processing',
      'shp-digital',
      'picking',
      'unfulfilled',
      'BULKY',
      'DIGITAL',
      'Demo Bulky Freight',
      'Digital Vault',
      'DEMO-P-PROCESSING',
      'DEMO-P-DIGITAL',
      'delivered physical goods',
      'shipped/failed/lost',
    ]) {
      expect(screen.queryByText(shipmentClue, { exact: false })).not.toBeInTheDocument()
    }

    await user.selectOptions(screen.getByLabelText('Claim type'), 'non_delivery')
    expect(screen.queryByLabelText('Relevant shipment')).not.toBeInTheDocument()
    expect(screen.getByText(/shipment-linked claim details unlock after all boxes/i)).toBeVisible()

    await user.selectOptions(screen.getByLabelText('Claim type'), 'value_floor')
    expect(screen.getByLabelText('Revealed box')).toBeVisible()
    expect(screen.getByRole('option', { name: /box-processing-01 · opened/i })).toBeVisible()
    expect(screen.queryByRole('option', { name: /box-processing-02/i })).not.toBeInTheDocument()
    expect(screen.getByLabelText(/fictional note/i)).toBeVisible()
    expect(screen.getByRole('button', { name: /submit demo claim/i })).toBeEnabled()
  })

  it('shows duplicate and out-of-order reconciliation results instead of a false completion', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    services.orders.setCartQuantity(1)
    const order = services.orders.create({
      requestId: 'checkout_0000000000000000000000000000a005',
      quantity: 1,
      shippingMethod: 'standard',
      address: DEMO_ADDRESS,
      acknowledged: true,
      displayedTotalSen: 11_200,
    })
    const payment = services.payments.createAttempt(order.id)
    const processEvent = vi.spyOn(services.payments, 'processEvent')
      .mockReturnValueOnce({
        payment,
        changed: false,
        message: 'Duplicate event ignored safely.',
      })
      .mockReturnValueOnce({
        payment,
        changed: false,
        message: 'Out-of-order event recorded but did not change anything.',
      })
    services.auth.oneClick('admin')
    window.history.replaceState({}, '', '#/admin/payments')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const record = screen.getByText(payment.id).closest('details')!
    await user.click(record.querySelector('summary')!)
    await user.click(within(record).getByRole('button', { name: /reconcile succeeded/i }))
    await user.click(screen.getByRole('button', { name: /confirm and audit/i }))
    expect(await screen.findByText('Duplicate event ignored safely.')).toBeVisible()
    expect(screen.queryByText(/reconcile action completed and audited/i)).not.toBeInTheDocument()

    await user.click(within(record).getByRole('button', { name: /reconcile succeeded/i }))
    await user.click(screen.getByRole('button', { name: /confirm and audit/i }))
    expect(await screen.findByText('Out-of-order event recorded but did not change anything.')).toBeVisible()
    expect(screen.queryByText(/reconcile action completed and audited/i)).not.toBeInTheDocument()
    expect(processEvent).toHaveBeenCalledTimes(2)
  })

  it('never offers RM10 partial when only RM10 remains and names the exact remaining refund', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('admin')
    const payment = services.repository.getSnapshot().payments.find((entry) => entry.id === 'pay-unopened')!
    services.payments.refund(
      payment.id,
      payment.amountSen - 1000,
      'Confirmed near-complete refund setup',
      'req-near-complete-refund',
    )
    window.history.replaceState({}, '', '#/admin/payments')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const record = screen.getByText('pay-unopened').closest('details')!
    expect(within(record).queryByRole('button', { name: /partial refund rm10/i })).not.toBeInTheDocument()
    const remaining = within(record).getByRole('button', { name: /refund remaining rm\s*10\.00/i })
    await user.click(remaining)
    expect(screen.getByRole('dialog', { name: /remaining refund of rm\s*10\.00/i })).toBeVisible()
    expect(screen.getByRole('dialog')).toHaveTextContent(/records exactly rm\s*10\.00/i)
  })

  it('uses on-page focus actions without corrupting the hash and marks the active route', async () => {
    const user = userEvent.setup()
    const services = renderApp()
    const originalHash = window.location.hash
    expect(screen.getByRole('link', { name: /^Vault$/ })).toHaveAttribute('aria-current', 'page')
    await user.click(screen.getByRole('button', { name: /skip to content/i }))
    expect(window.location.hash).toBe(originalHash)
    expect(document.activeElement).toBe(document.getElementById('main-content'))

    services.auth.oneClick('customer')
    services.orders.setCartQuantity(1)
    window.location.hash = '#/checkout'
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    const poolButton = await screen.findByRole('button', { name: /review the exact 10,000-box table/i })
    const checkoutHash = window.location.hash
    await user.click(poolButton)
    expect(window.location.hash).toBe(checkoutHash)
    expect(document.activeElement).toBe(document.getElementById('checkout-pool-review'))

    const scroll = vi.spyOn(window, 'scrollTo')
    await user.click(screen.getByRole('link', { name: /^Cart\b/ }))
    const cartHeading = await screen.findByRole('heading', { name: /demo cargo list/i })
    await waitFor(() => expect(document.activeElement).toBe(cartHeading))
    expect(scroll).toHaveBeenCalled()
    expect(screen.getByRole('link', { name: /^Cart\b/ })).toHaveAttribute('aria-current', 'page')
  })
})
