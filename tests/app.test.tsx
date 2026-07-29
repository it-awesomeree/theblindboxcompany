import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { App } from '../src/App'
import { ConfirmDialog } from '../src/components/ConfirmDialog'
import { AppServices } from '../src/services/AppServices'
import { AppStateProvider } from '../src/state/AppState'
import {
  MemoryStorage,
  FIXED_NOW,
  makeProcessingOrderSingleGroupedPhysicalShipment,
  makeProcessingOrderTwoPhysicalShipments,
} from './helpers'
import { VaultCanvas } from '../src/components/VaultCanvas'
import { Notice } from '../src/components/Notice'
import { createDemoState, DEMO_ADDRESS } from '../src/data/fixtures'
import { migrateDemoStateV7, STORAGE_KEY } from '../src/data/MockRepository'
import { validateDemoState } from '../src/data/StateValidator'
import { resolveOrderFulfillment } from '../src/domain/orderFulfillment'
import type { DemoState } from '../src/domain/types'
import { sealedCustomerTimeline } from '../src/domain/orderTimeline'

function renderApp(storage = new MemoryStorage()) {
  window.history.replaceState({}, '', '#/')
  const services = new AppServices(storage, () => FIXED_NOW)
  render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
  return services
}

function makeApprovedCrossKindRemedyConflict(services: AppServices) {
  services.auth.oneClick('customer')
  const holder = services.claims.submit({
    orderId: 'ord-delivered',
    kind: 'value_floor',
    boxId: 'box-delivered-01',
    note: 'DEMO value-floor holder for overlapping remedy UI',
  }).data
  const conflicting = services.claims.submit({
    orderId: 'ord-delivered',
    kind: 'damage',
    shipmentId: 'shp-delivered',
    note: 'DEMO cross-kind damage claim for overlapping remedy UI',
  }).data
  services.auth.oneClick('admin')
  for (const claim of [holder, conflicting]) {
    services.claims.review(
      claim.id,
      'acknowledge',
      `Confirmed overlap acknowledgement for ${claim.id}`,
    )
    services.claims.review(
      claim.id,
      'approve',
      `Confirmed overlap approval for ${claim.id}`,
    )
  }
  services.claims.createRma(
    holder.id,
    `DEMO-RMA-${holder.id.toUpperCase()}`,
    'Confirmed holder RMA creation evidence',
  )
  return { conflicting, holder }
}

describe('app components', () => {
  it('shows a visible demo warning and preserves the approved homepage tagline', () => {
    renderApp()
    expect(screen.getByText('DEMO PROTOTYPE')).toBeVisible()
    expect(screen.getByRole('heading', { name: /the blind box that always wins/i })).toBeVisible()
    expect(screen.getByText(/proposed demo tagline/i)).toBeVisible()
    expect(screen.getByText(/boosted demo opener/i)).toBeVisible()
  })

  it('renders allocation-derived exact odds without the rounded legacy label', () => {
    renderApp()

    expect(screen.getByRole('cell', { name: '3 in 10,000' })).toBeVisible()
    expect(screen.getAllByRole('cell', { name: '2,500 in 10,000' })).toHaveLength(2)
    expect(screen.queryByText('1 in 3,333')).not.toBeInTheDocument()
  })

  it('announces danger notices assertively while info and success stay polite', () => {
    render(
      <>
        <Notice tone="danger">Urgent demo problem</Notice>
        <Notice>Helpful demo information</Notice>
        <Notice tone="success">Demo action saved</Notice>
      </>,
    )
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive')
    const statuses = screen.getAllByRole('status')
    expect(statuses).toHaveLength(2)
    expect(statuses.every((status) => status.getAttribute('aria-live') === 'polite')).toBe(true)
  })

  it('one-click customer access persists in app state', async () => {
    const user = userEvent.setup()
    const services = renderApp()
    await user.click(document.querySelector<HTMLAnchorElement>('.nav-session-desktop .nav-action')!)
    await user.click(screen.getByRole('button', { name: /one-click aina demo/i }))
    expect(services.auth.currentUser()?.role).toBe('customer')
    expect(await screen.findByRole('heading', { name: 'Aina Demo' })).toBeVisible()
  })

  it.each([
    ['#/', 'Home', /the blind box that always wins/i],
    ['#/auth', 'Auth', /enter the demo vault/i],
    ['#/cart', 'Cart', /demo cargo list/i],
    ['#/checkout', 'Checkout', /seal the demo order/i],
    ['#/pay/ord-unopened/new', 'Mock Payment', /mock hitpay payment/i],
    ['#/pay/ord-unopened/pay-unopened', 'Mock Payment', /mock hitpay payment/i],
    ['#/payment-return/pay-unopened', 'Payment Return', /payment confirmed by event/i],
    ['#/order/ord-unopened', 'Order', /ord-unopened/i],
    ['#/open/box-unopened-01', 'Open Box', /open exactly once/i],
    ['#/account?name=Aina%20Demo&email=aina%40example.test&address=1%20DEMO%20Vault%20Street', 'Account', /aina demo/i],
    ['#/claim/new?order=ord-shipped', 'Claim', /start a fake claim/i],
    ['#/unauthorized', 'Unauthorized', /admin access blocked/i],
    ['#/not-found', 'Not Found', /nothing is sealed here/i],
    ['#/order/%E0%A4%A?user=Aina%20Demo', 'Not Found', /nothing is sealed here/i],
  ])('uses one h1, safe title metadata and initial focus for %s', async (route, label, headingName) => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', route)
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const heading = screen.getByRole('heading', { level: 1, name: headingName })
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(heading).toBeVisible()
    await waitFor(() => {
      expect(document.title).toBe(`${label} | The Blind Box Company | Demo / No Real Charge`)
      expect(document.activeElement).toBe(heading)
    })
    for (const unsafeValue of [
      'ord-unopened',
      'pay-unopened',
      'box-unopened-01',
      'Aina Demo',
      'aina@example.test',
      '1 DEMO Vault Street',
    ]) {
      expect(document.title).not.toContain(unsafeValue)
    }
  })

  it.each([
    ['/admin', 'Admin Overview'],
    ['/admin/users', 'Admin Users'],
    ['/admin/orders', 'Admin Orders'],
    ['/admin/payments', 'Admin Payments'],
    ['/admin/inventory', 'Admin Inventory'],
    ['/admin/fulfilment', 'Admin Fulfilment'],
    ['/admin/claims', 'Admin Claims'],
    ['/admin/audit', 'Admin Audit'],
  ])('gives %s one h1 and its own fixed admin title', async (route, label) => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('admin')
    window.history.replaceState({}, '', `#${route}?user=usr-admin&email=admin%40demo.local`)
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const heading = screen.getByRole('heading', { level: 1 })
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(heading).toBeVisible()
    await waitFor(() => {
      expect(document.title).toBe(`${label} | The Blind Box Company | Demo / No Real Charge`)
      expect(document.activeElement).toBe(heading)
    })
    expect(document.title).not.toMatch(/usr-admin|admin@demo\.local|Vault Admin/)
    const navigation = screen.getByRole('navigation', { name: /main navigation/i })
    expect(within(navigation).getByRole('link', { name: 'Admin' })).toBeVisible()
    expect(within(navigation).queryByRole('link', { name: 'Account' })).not.toBeInTheDocument()
  })

  it('keeps anonymous navigation unchanged and shows only the customer account destination after sign-in', async () => {
    const user = userEvent.setup()
    renderApp()
    const navigation = screen.getByRole('navigation', { name: /main navigation/i })
    expect(within(navigation).queryByRole('link', { name: 'Account' })).not.toBeInTheDocument()
    expect(within(navigation).queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /demo sign in/i }).length).toBeGreaterThan(0)

    await user.click(document.querySelector<HTMLAnchorElement>('.nav-session-desktop .nav-action')!)
    await user.click(screen.getByRole('button', { name: /one-click aina demo/i }))

    expect(within(navigation).getByRole('link', { name: 'Account' })).toBeVisible()
    expect(within(navigation).queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument()
  })

  it('restores safe titles and h1 focus on browser back and forward', async () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/account?email=aina%40example.test')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const accountHeading = screen.getByRole('heading', { level: 1, name: 'Aina Demo' })
    await waitFor(() => {
      expect(document.title).toBe('Account | The Blind Box Company | Demo / No Real Charge')
      expect(document.activeElement).toBe(accountHeading)
    })

    act(() => {
      window.history.pushState({}, '', '#/cart?order=ord-unopened')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    const cartHeading = await screen.findByRole('heading', { level: 1, name: /demo cargo list/i })
    await waitFor(() => {
      expect(document.title).toBe('Cart | The Blind Box Company | Demo / No Real Charge')
      expect(document.activeElement).toBe(cartHeading)
    })

    act(() => window.history.back())
    await waitFor(() => {
      expect(window.location.hash).toBe('#/account?email=aina%40example.test')
      expect(document.title).toBe('Account | The Blind Box Company | Demo / No Real Charge')
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { level: 1, name: 'Aina Demo' }),
      )
    })

    act(() => window.history.forward())
    await waitFor(() => {
      expect(window.location.hash).toBe('#/cart?order=ord-unopened')
      expect(document.title).toBe('Cart | The Blind Box Company | Demo / No Real Charge')
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { level: 1, name: /demo cargo list/i }),
      )
    })
    expect(document.title).not.toMatch(/aina@example\.test|ord-unopened/)
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

  it('keeps the cart visible for a blank quantity draft, commits 2, and restores 2 on blank blur', async () => {
    const user = userEvent.setup()
    const storage = new MemoryStorage()
    const services = new AppServices(storage, () => FIXED_NOW)
    const setCartQuantity = vi.spyOn(services.orders, 'setCartQuantity')
    window.history.replaceState({}, '', '#/cart')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const quantityInput = screen.getByRole('spinbutton', { name: /quantity/i })
    const storedQuantityOne = storage.getItem(STORAGE_KEY)

    await user.clear(quantityInput)

    expect(quantityInput).toHaveValue(null)
    expect(screen.queryByRole('heading', { name: /your demo cart is empty/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign in to checkout/i })).toBeVisible()
    expect(screen.getByText(/current subtotal/i).closest('div')).toHaveTextContent('RM 100.00')
    expect(setCartQuantity).not.toHaveBeenCalled()
    expect(services.repository.getSnapshot().cart[0].quantity).toBe(1)
    expect(storage.getItem(STORAGE_KEY)).toBe(storedQuantityOne)

    await user.type(quantityInput, '2')

    expect(quantityInput).toHaveValue(2)
    expect(setCartQuantity).toHaveBeenCalledTimes(1)
    expect(setCartQuantity).toHaveBeenLastCalledWith(2)
    expect(services.repository.getSnapshot().cart[0].quantity).toBe(2)
    expect(screen.getByText(/current subtotal/i).closest('div')).toHaveTextContent('RM 200.00')
    const storedQuantityTwo = storage.getItem(STORAGE_KEY)

    await user.clear(quantityInput)
    fireEvent.blur(quantityInput)

    expect(quantityInput).toHaveValue(2)
    expect(setCartQuantity).toHaveBeenCalledTimes(1)
    expect(services.repository.getSnapshot().cart[0].quantity).toBe(2)
    expect(storage.getItem(STORAGE_KEY)).toBe(storedQuantityTwo)
    expect(screen.queryByRole('heading', { name: /your demo cart is empty/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign in to checkout/i })).toBeVisible()
  })

  it.each(['1.5', '-1', '11'])('restores invalid quantity draft %s without changing storage', (invalidDraft) => {
    const storage = new MemoryStorage()
    const services = new AppServices(storage, () => FIXED_NOW)
    services.orders.setCartQuantity(2)
    const setCartQuantity = vi.spyOn(services.orders, 'setCartQuantity')
    const storedQuantityTwo = storage.getItem(STORAGE_KEY)
    window.history.replaceState({}, '', '#/cart')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const quantityInput = screen.getByRole('spinbutton', { name: /quantity/i })

    fireEvent.change(quantityInput, { target: { value: invalidDraft } })
    fireEvent.blur(quantityInput)

    expect(quantityInput).toHaveValue(2)
    expect(setCartQuantity).not.toHaveBeenCalled()
    expect(services.repository.getSnapshot().cart[0].quantity).toBe(2)
    expect(storage.getItem(STORAGE_KEY)).toBe(storedQuantityTwo)
  })

  it('keeps the step buttons synchronized and reserves cart removal for Remove', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.orders.setCartQuantity(2)
    const setCartQuantity = vi.spyOn(services.orders, 'setCartQuantity')
    window.history.replaceState({}, '', '#/cart')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const quantityInput = screen.getByRole('spinbutton', { name: /quantity/i })

    await user.clear(quantityInput)
    await user.click(screen.getByRole('button', { name: /decrease quantity/i }))

    expect(quantityInput).toHaveValue(1)
    expect(setCartQuantity).toHaveBeenCalledTimes(1)
    expect(setCartQuantity).toHaveBeenLastCalledWith(1)
    expect(services.repository.getSnapshot().cart[0].quantity).toBe(1)
    expect(screen.queryByRole('heading', { name: /your demo cart is empty/i })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /decrease quantity/i }))

    expect(quantityInput).toHaveValue(1)
    expect(setCartQuantity).toHaveBeenCalledTimes(1)
    expect(services.repository.getSnapshot().cart[0].quantity).toBe(1)

    await user.clear(quantityInput)
    await user.click(screen.getByRole('button', { name: /increase quantity/i }))

    expect(quantityInput).toHaveValue(2)
    expect(setCartQuantity).toHaveBeenCalledTimes(2)
    expect(setCartQuantity).toHaveBeenLastCalledWith(2)
    expect(services.repository.getSnapshot().cart[0].quantity).toBe(2)

    await user.click(screen.getByRole('button', { name: /remove from cart/i }))

    expect(setCartQuantity).toHaveBeenCalledTimes(3)
    expect(setCartQuantity).toHaveBeenLastCalledWith(0)
    expect(screen.getByRole('heading', { name: /your demo cart is empty/i })).toBeVisible()
  })

  it('requires styled confirmation before resetting demo data', async () => {
    const user = userEvent.setup()
    const services = renderApp()
    services.auth.oneClick('customer')
    services.orders.setCartQuantity(3)

    await user.click(screen.getByRole('button', { name: /reset demo data/i }))
    const dialog = screen.getByRole('dialog', { name: /reset all demo data/i })
    expect(dialog).toBeVisible()
    expect(dialog).toHaveTextContent(
      /replaces this browser’s fictional demo data.+restores the safe starting fixtures/i,
    )
    expect(dialog).not.toHaveTextContent(/this tab’s fictional session changes/i)
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
    window.history.replaceState({}, '', '#/account')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(await screen.findByRole('heading', { name: 'Users' })).toBeVisible()
    expect(window.location.hash).toBe('#/admin/users')
    const mainNavigation = screen.getByRole('navigation', { name: /main navigation/i })
    expect(within(mainNavigation).getByRole('link', { name: 'Admin' })).toBeVisible()
    expect(within(mainNavigation).queryByRole('link', { name: 'Account' })).not.toBeInTheDocument()
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
    services.claims.review(
      resolvedClaim.id,
      'resolve',
      'Confirmed resolved queue no-remedy regression',
      { outcome: 'no_remedy', reference: `DEMO-${resolvedClaim.id.toUpperCase()}` },
    )
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

  it('focuses and announces the homepage demo result after the opener changes state', async () => {
    const user = userEvent.setup()
    renderApp()
    await user.click(screen.getByRole('button', { name: /open boosted demo/i }))

    const result = screen.getByRole('region', { name: /maggi mee/i })
    const heading = within(result).getByRole('heading', { name: /maggi mee/i })
    expect(document.activeElement).toBe(heading)
    expect(screen.getByText(/boosted demo result 1: maggi mee/i)).toHaveAttribute('role', 'status')
  })

  it('focuses and announces a paid box result after the reveal animation', () => {
    vi.useFakeTimers()
    try {
      const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
      services.auth.oneClick('customer')
      window.history.replaceState({}, '', '#/open/box-unopened-01')
      render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
      fireEvent.click(screen.getByRole('button', { name: /break demo seal/i }))
      act(() => {
        vi.advanceTimersByTime(1700)
      })

      const result = screen.getByRole('region', { name: /air fryer 5l/i })
      expect(document.activeElement).toBe(within(result).getByRole('heading', { name: /air fryer 5l/i }))
      expect(screen.getByText(/box revealed. result: air fryer 5l/i)).toHaveAttribute('role', 'status')
      expect(screen.queryByRole('button', { name: /break demo seal/i })).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('remounts the customer route before switching a revealed box to a sealed box', async () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/open/box-refunded-01')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(screen.getByRole('heading', { name: /beras 10kg/i })).toBeVisible()
    expect(screen.getByText(/value manifest \/ immutable record/i)).toBeVisible()

    act(() => {
      window.location.hash = '#/open/box-unopened-01'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    expect(await screen.findByRole('button', { name: /break demo seal/i })).toBeVisible()
    expect(screen.queryByRole('heading', { name: /beras 10kg/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/value manifest \/ immutable record/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/air fryer 5l/i)).not.toBeInTheDocument()
  })

  it('clears the reveal timer before switching to another sealed box', () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
    try {
      const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
      services.auth.oneClick('customer')
      window.history.replaceState({}, '', '#/open/box-unopened-01')
      render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
      fireEvent.click(screen.getByRole('button', { name: /break demo seal/i }))
      const revealTimerIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 1700)
      expect(revealTimerIndex).toBeGreaterThanOrEqual(0)
      const revealTimer = setTimeoutSpy.mock.results[revealTimerIndex].value

      act(() => {
        window.location.hash = '#/open/box-processing-02'
        window.dispatchEvent(new HashChangeEvent('hashchange'))
      })
      expect(clearTimeoutSpy).toHaveBeenCalledWith(revealTimer)
      act(() => {
        vi.advanceTimersByTime(1700)
      })

      expect(screen.getByText(/paid box \/ box-processing-02/i)).toBeVisible()
      expect(screen.getByRole('button', { name: /break demo seal/i })).toBeVisible()
      expect(screen.queryByText(/air fryer 5l/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/tng reload rm100/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/value manifest \/ immutable record/i)).not.toBeInTheDocument()
    } finally {
      setTimeoutSpy.mockRestore()
      clearTimeoutSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it.each([
    '#/open/%E0%A4%A',
    '#/order/%E0%A4%A',
    '#/payment-return/%E0%A4%A',
    '#/pay/%E0%A4%A/new',
    '#/pay/ord-unopened/%E0%A4%A',
  ])('shows friendly not-found for malformed encoded route %s', (route) => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', route)
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(screen.getByRole('heading', { name: /nothing is sealed here/i })).toBeVisible()
  })

  it('keeps a non-FPX method selected after new payment navigation remounts', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    const order = services.orders.create({
      requestId: 'checkout_0000000000000000000000000000b001',
      quantity: 1,
      shippingMethod: 'standard',
      address: DEMO_ADDRESS,
      acknowledged: true,
      displayedTotalSen: 11_200,
    })
    window.history.replaceState({}, '', `#/pay/${order.id}/new`)
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const card = screen.getByRole('radio', { name: /card no card number/i })
    const newAttemptHeading = screen.getByRole('heading', { level: 1, name: /mock hitpay payment/i })
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    await waitFor(() => expect(document.activeElement).toBe(newAttemptHeading))
    await user.click(card)
    expect(document.activeElement).toBe(card)
    await user.click(screen.getByRole('button', { name: /create pending demo attempt/i }))

    const selectedCard = await screen.findByRole('radio', { name: /card no card number/i })
    const existingAttemptHeading = screen.getByRole('heading', { level: 1, name: /mock hitpay payment/i })
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    await waitFor(() => expect(document.activeElement).toBe(existingAttemptHeading))
    expect(selectedCard).toBeChecked()
    expect(selectedCard).toBeDisabled()
    expect(services.repository.getSnapshot().payments.at(-1)?.method).toBe('CARD')
  })

  it('shows a disputed customer payment as finance-only with no provider actions', () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('admin')
    services.payments.dispute(
      'pay-unopened',
      'Confirmed customer disputed-payment terminal display',
      'evt-customer-dispute-terminal',
    )
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/pay/ord-unopened/pay-unopened')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    expect(screen.getByText(/under dispute.+protected finance review.+cannot be retried/i)).toBeVisible()
    for (const action of [
      /approve \+ valid mock webhook/i,
      /delayed pending return/i,
      /^decline$/i,
      /^cancel$/i,
      /^expire$/i,
      /retry attempt/i,
    ]) {
      expect(screen.queryByRole('button', { name: action })).not.toBeInTheDocument()
    }
    expect(screen.getByRole('link', { name: /view order/i })).toBeVisible()
  })

  it('switches a running WebGL canvas to the visible fallback after context loss', () => {
    window.history.replaceState({}, '', '/#/')
    const shaders = [{ kind: 'vertex' }, { kind: 'fragment' }]
    const program = { kind: 'program' }
    const buffer = { kind: 'buffer' }
    const bindBuffer = vi.fn()
    const useProgram = vi.fn()
    const detachShader = vi.fn()
    const deleteBuffer = vi.fn()
    const deleteProgram = vi.fn()
    const deleteShader = vi.fn()
    const gl = {
      VERTEX_SHADER: 1,
      FRAGMENT_SHADER: 2,
      COMPILE_STATUS: 3,
      LINK_STATUS: 4,
      ARRAY_BUFFER: 5,
      STATIC_DRAW: 6,
      FLOAT: 7,
      TRIANGLES: 8,
      createShader: vi.fn()
        .mockReturnValueOnce(shaders[0])
        .mockReturnValueOnce(shaders[1]),
      shaderSource: () => {},
      compileShader: () => {},
      getShaderParameter: () => true,
      createProgram: () => program,
      attachShader: () => {},
      detachShader,
      linkProgram: () => {},
      getProgramParameter: () => true,
      useProgram,
      createBuffer: () => buffer,
      bindBuffer,
      bufferData: () => {},
      getAttribLocation: () => 0,
      enableVertexAttribArray: () => {},
      vertexAttribPointer: () => {},
      getUniformLocation: () => ({}),
      viewport: () => {},
      uniform2f: () => {},
      uniform1f: () => {},
      drawArrays: () => {},
      deleteBuffer,
      deleteProgram,
      deleteShader,
    }
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(gl as unknown as WebGLRenderingContext)
    render(<VaultCanvas onActivate={() => {}} label="Live demo vault" />)
    const canvas = screen.getByRole('button', { name: 'Live demo vault' })
    const fallback = screen.getByTestId('webgl-fallback')
    expect(canvas).toBeVisible()
    expect(fallback).not.toBeVisible()

    const lost = new Event('webglcontextlost', { cancelable: true })
    fireEvent(canvas, lost)
    expect(lost.defaultPrevented).toBe(true)
    expect(canvas).not.toBeVisible()
    expect(fallback).toBeVisible()
    expect(fallback).toHaveAttribute('role', 'button')
    expect(fallback).toHaveAttribute('aria-label', 'Live demo vault')
    expect(bindBuffer).toHaveBeenLastCalledWith(gl.ARRAY_BUFFER, null)
    expect(useProgram).toHaveBeenLastCalledWith(null)
    expect(detachShader).toHaveBeenCalledWith(program, shaders[0])
    expect(detachShader).toHaveBeenCalledWith(program, shaders[1])
    expect(deleteBuffer).toHaveBeenCalledWith(buffer)
    expect(deleteProgram).toHaveBeenCalledWith(program)
    expect(deleteShader).toHaveBeenCalledWith(shaders[0])
    expect(deleteShader).toHaveBeenCalledWith(shaders[1])
    context.mockRestore()
  })

  it('deletes WebGL shaders, program, and buffer on setup failure and unmount', () => {
    window.history.replaceState({}, '', '/#/')
    const shaders = [{ kind: 'vertex' }, { kind: 'fragment' }]
    const program = { kind: 'program' }
    const buffer = { kind: 'buffer' }
    const attachShader = vi.fn()
    const detachShader = vi.fn()
    const useProgram = vi.fn()
    const bindBuffer = vi.fn()
    const deleteShader = vi.fn()
    const deleteProgram = vi.fn()
    const deleteBuffer = vi.fn()
    const gl = {
      VERTEX_SHADER: 1,
      FRAGMENT_SHADER: 2,
      COMPILE_STATUS: 3,
      LINK_STATUS: 4,
      ARRAY_BUFFER: 5,
      STATIC_DRAW: 6,
      FLOAT: 7,
      TRIANGLES: 8,
      createShader: vi.fn()
        .mockReturnValueOnce(shaders[0])
        .mockReturnValueOnce(shaders[1]),
      shaderSource: () => {},
      compileShader: () => {},
      getShaderParameter: () => true,
      createProgram: () => program,
      attachShader,
      detachShader,
      linkProgram: () => {},
      getProgramParameter: () => true,
      useProgram,
      createBuffer: () => buffer,
      bindBuffer,
      bufferData: () => {},
      getAttribLocation: () => -1,
      enableVertexAttribArray: () => {},
      vertexAttribPointer: () => {},
      getUniformLocation: () => ({}),
      viewport: () => {},
      uniform2f: () => {},
      uniform1f: () => {},
      drawArrays: () => {},
      deleteBuffer,
      deleteProgram,
      deleteShader,
    }
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(gl as unknown as WebGLRenderingContext)
    const failed = render(<VaultCanvas />)
    expect(screen.getByTestId('webgl-fallback')).toBeVisible()
    expect(bindBuffer).toHaveBeenLastCalledWith(gl.ARRAY_BUFFER, null)
    expect(useProgram).toHaveBeenLastCalledWith(null)
    expect(detachShader).toHaveBeenCalledWith(program, shaders[0])
    expect(detachShader).toHaveBeenCalledWith(program, shaders[1])
    expect(deleteBuffer).toHaveBeenCalledWith(buffer)
    expect(deleteProgram).toHaveBeenCalledWith(program)
    expect(deleteShader).toHaveBeenCalledWith(shaders[0])
    expect(deleteShader).toHaveBeenCalledWith(shaders[1])
    failed.unmount()

    deleteBuffer.mockClear()
    deleteProgram.mockClear()
    deleteShader.mockClear()
    attachShader.mockClear()
    detachShader.mockClear()
    useProgram.mockClear()
    bindBuffer.mockClear()
    gl.createShader.mockReset()
      .mockReturnValueOnce(shaders[0])
      .mockReturnValueOnce(shaders[1])
    gl.getAttribLocation = () => 0
    const live = render(<VaultCanvas />)
    expect(screen.getByTestId('webgl-fallback')).not.toBeVisible()
    live.unmount()
    expect(bindBuffer).toHaveBeenLastCalledWith(gl.ARRAY_BUFFER, null)
    expect(useProgram).toHaveBeenLastCalledWith(null)
    expect(detachShader).toHaveBeenCalledWith(program, shaders[0])
    expect(detachShader).toHaveBeenCalledWith(program, shaders[1])
    expect(deleteBuffer).toHaveBeenCalledWith(buffer)
    expect(deleteProgram).toHaveBeenCalledWith(program)
    expect(deleteShader).toHaveBeenCalledTimes(2)
    context.mockRestore()
  })

  it('does not expire reservations or show false cleanup wording while the shell starts', () => {
    const preparedStorage = new MemoryStorage()
    const prepared = new AppServices(preparedStorage, () => '2026-07-28T03:00:00.000Z')
    prepared.auth.oneClick('customer')
    prepared.orders.setCartQuantity(1)
    prepared.orders.create({
      requestId: 'checkout_0000000000000000000000000000e001',
      quantity: 1,
      shippingMethod: 'standard',
      address: DEMO_ADDRESS,
      acknowledged: true,
      displayedTotalSen: 11_200,
    })
    const storedBefore = preparedStorage.getItem(STORAGE_KEY)!
    const storage = new MemoryStorage()
    storage.seed(STORAGE_KEY, storedBefore)
    const services = new AppServices(storage, () => FIXED_NOW)
    window.history.replaceState({}, '', '#/')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    expect(screen.queryByText(/automatic cleanup/i)).not.toBeInTheDocument()
    expect(services.repository.recoveryNotice).toBeNull()
    expect(storage.getItem(STORAGE_KEY)).toBe(storedBefore)
    expect(services.repository.getSnapshot().orders.at(-1)?.status).toBe('pending_payment')
  })

  it('shows friendly errors for guarded home, cart, logout, and draft-copy handlers', async () => {
    const user = userEvent.setup()

    const homeServices = renderApp()
    vi.spyOn(homeServices.orders, 'setCartQuantity').mockImplementation(() => {
      throw new Error('Home cart save failed safely.')
    })
    await user.click(screen.getAllByRole('button', { name: /get a demo box/i })[0])
    expect(screen.getByText('Home cart save failed safely.')).toBeVisible()
    cleanup()

    const cartServices = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    vi.spyOn(cartServices.orders, 'setCartQuantity').mockImplementation(() => {
      throw new Error('Cart quantity save failed safely.')
    })
    window.history.replaceState({}, '', '#/cart')
    render(<AppStateProvider providedServices={cartServices}><App /></AppStateProvider>)
    await user.click(screen.getByRole('button', { name: /increase quantity/i }))
    expect(screen.getByText('Cart quantity save failed safely.')).toBeVisible()
    fireEvent.change(screen.getByRole('spinbutton', { name: /quantity/i }), { target: { value: '2' } })
    await user.click(screen.getByRole('button', { name: /remove from cart/i }))
    expect(cartServices.orders.setCartQuantity).toHaveBeenCalledTimes(3)
    cleanup()

    const logoutServices = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    logoutServices.auth.oneClick('customer')
    vi.spyOn(logoutServices.auth, 'logout').mockImplementation(() => {
      throw new Error('Logout save failed safely.')
    })
    window.history.replaceState({}, '', '#/account')
    render(<AppStateProvider providedServices={logoutServices}><App /></AppStateProvider>)
    await user.click(document.querySelector<HTMLButtonElement>('.nav-session-desktop .nav-action')!)
    expect(screen.getByRole('alert')).toHaveTextContent('Logout save failed safely.')
    expect(logoutServices.auth.currentUser()?.role).toBe('customer')
    cleanup()

    const inventoryServices = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    inventoryServices.auth.oneClick('admin')
    vi.spyOn(inventoryServices.admin, 'copyPublishedToDraft').mockImplementation(() => {
      throw new Error('Draft copy save failed safely.')
    })
    window.history.replaceState({}, '', '#/admin/inventory')
    render(<AppStateProvider providedServices={inventoryServices}><App /></AppStateProvider>)
    await user.click(screen.getByRole('button', { name: /copy published series to draft/i }))
    expect(screen.getByText('Draft copy save failed safely.')).toBeVisible()
  })

  it('blocks a blank draft prize name in the inventory form before saving', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('admin')
    services.admin.copyPublishedToDraft()
    const before = structuredClone(services.repository.getSnapshot())
    window.history.replaceState({}, '', '#/admin/inventory')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    await user.clear(screen.getByLabelText(/draft maggi name/i))

    expect(screen.getByText(/prize name cannot be blank/i)).toBeVisible()
    expect(screen.getByRole('button', { name: /save draft-only edit/i })).toBeDisabled()
    expect(services.repository.getSnapshot()).toEqual(before)
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
        name: 'Route Other Demo',
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
      address: { ...DEMO_ADDRESS, recipient: 'Route Other Demo' },
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
    expect(record.querySelectorAll('.sealed-delivery-summary .status')).toHaveLength(1)
    expect(within(record).getByText(/captured · under dispute/i)).toBeVisible()
    expect(within(record).queryByText('Not confirmed')).not.toBeInTheDocument()
  })

  it('keeps mixed Account fulfilment order-level until every box is revealed and counts in-transit orders', () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('admin')
    for (const [shipmentId, path] of [
      ['shp-processing', ['packed', 'label_created', 'shipped']],
      ['shp-digital', ['issued', 'sent']],
    ] as const) {
      for (const status of path) {
        services.fulfilment.advance(shipmentId, status, `Confirmed Account privacy ${status}`)
      }
    }
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/account')
    let view = render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const transitMetric = screen.getByText('IN TRANSIT').closest('article')!
    expect(within(transitMetric).getByText('2')).toBeVisible()
    const record = screen.getByText('ORD-PROCESSING').closest('article')!
    const sealedSummary = record.querySelector<HTMLElement>('.sealed-delivery-summary')!
    expect(within(sealedSummary).getByText('DEMO-DELIVERY-ORD-PROCESSING')).toBeVisible()
    expect(within(sealedSummary).getAllByText('Delivery In Progress')).toHaveLength(1)
    expect(within(record).queryByText(/record 1:|record 2:/i)).not.toBeInTheDocument()
    expect(within(record).queryByText(/maggi|tng reload/i)).not.toBeInTheDocument()
    expect(record.querySelectorAll('.sealed-delivery-summary')).toHaveLength(1)

    view.unmount()
    services.auth.oneClick('admin')
    services.fulfilment.advance(
      'shp-processing',
      'delivered',
      'Digital and bulky split delivery clue must stay private',
    )
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/order/ord-processing')
    view = render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const privateFulfilment = screen.getByRole('heading', { name: /private-prize tracking/i }).closest('section')!
    expect(within(privateFulfilment).getByText('Delivery In Progress')).toBeVisible()
    expect(screen.queryByText('Partially Fulfilled')).not.toBeInTheDocument()
    expect(screen.queryByText(/digital and bulky split delivery clue/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Fulfillment Pending')).not.toBeInTheDocument()
    expect(screen.queryByText('Fulfilled')).not.toBeInTheDocument()
    expect(screen.getByText(/detailed delivery events stay combined/i)).toBeVisible()
    expect(privateFulfilment.querySelectorAll('.sealed-delivery-summary .status')).toHaveLength(1)

    view.unmount()
    services.repository.update((state) => {
      state.boxes.find((box) => box.id === 'box-processing-02')!.revealedAt = '2026-07-28T05:00:00.000Z'
    })
    window.history.replaceState({}, '', '#/account')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const revealedRecord = screen.getByText('ORD-PROCESSING').closest('article')!
    expect(within(revealedRecord).getByText(/1 of 2 box fulfilment scopes complete/i)).toBeVisible()
    expect(within(revealedRecord).getByRole('heading', { name: 'Original shipment' })).toBeVisible()
    expect(within(revealedRecord).getByRole('heading', { name: 'Digital delivery' })).toBeVisible()
    expect(within(revealedRecord).getByText('Delivered')).toBeVisible()
    expect(within(revealedRecord).getByText('Sent')).toBeVisible()
    expect(within(revealedRecord).getByText('Sent')).toBeVisible()
    expect(within(revealedRecord).getByText(/maggi/i)).toBeVisible()
    expect(within(revealedRecord).getByText(/tng reload/i)).toBeVisible()
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

  it('replaces a delayed-webhook unchanged info status with a sole assertive error notice', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    const order = services.orders.create({
      requestId: 'checkout_0000000000000000000000000000e001',
      quantity: 1,
      shippingMethod: 'standard',
      address: DEMO_ADDRESS,
      acknowledged: true,
      displayedTotalSen: 11_200,
    })
    const payment = services.payments.createAttempt(order.id)
    const processingPayment = services.payments.act(payment.id, 'delayed').payment
    vi.spyOn(services.payments, 'act')
      .mockReturnValueOnce({
        payment: processingPayment,
        changed: false,
        message: 'Delayed webhook accepted for announcement testing.',
      })
      .mockImplementationOnce(() => {
        throw new Error('Delayed webhook was blocked safely.')
      })
    window.history.replaceState({}, '', `#/payment-return/${payment.id}`)
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const confirm = screen.getByRole('button', { name: /simulate delayed valid webhook arriving/i })
    await user.click(confirm)
    const unchangedNotice = await within(screen.getByRole('main')).findByRole('status')
    expect(unchangedNotice).toHaveTextContent('Delayed webhook accepted for announcement testing.')
    expect(unchangedNotice).toHaveClass('notice-info')
    expect(unchangedNotice).toHaveAttribute('aria-live', 'polite')

    await user.click(confirm)
    const errorNotice = await screen.findByRole('alert')
    expect(errorNotice).toHaveTextContent('Delayed webhook was blocked safely.')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(within(screen.getByRole('main')).queryByRole('status')).not.toBeInTheDocument()
  })

  it.each([
    ['failed', /payment failed/i],
    ['cancelled', /payment cancelled/i],
    ['expired', /payment expired/i],
    ['partially_refunded', /payment partially refunded/i],
    ['refunded', /payment refunded/i],
    ['disputed', /captured payment under dispute/i],
  ] as const)('uses a truthful %s payment-return heading', (status, heading) => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    let paymentId = 'pay-unopened'
    if (['failed', 'cancelled', 'expired'].includes(status)) {
      const order = services.orders.create({
        requestId: `checkout_0000000000000000000000000000f00${status === 'failed' ? 1 : status === 'cancelled' ? 2 : 3}`,
        quantity: 1,
        shippingMethod: 'standard',
        address: DEMO_ADDRESS,
        acknowledged: true,
        displayedTotalSen: 11_200,
      })
      const payment = services.payments.createAttempt(order.id)
      services.payments.act(payment.id, status === 'failed' ? 'decline' : status === 'cancelled' ? 'cancel' : 'expire')
      paymentId = payment.id
    } else if (status === 'partially_refunded') {
      services.auth.oneClick('admin')
      services.payments.refund('pay-unopened', 1000, 'Confirmed return heading partial refund', 'req-return-heading-partial')
      services.auth.oneClick('customer')
    } else if (status === 'refunded') {
      paymentId = 'pay-refunded'
    } else {
      services.auth.oneClick('admin')
      services.payments.dispute('pay-unopened', 'Confirmed return heading dispute', 'evt-return-heading-dispute')
      services.auth.oneClick('customer')
    }
    window.history.replaceState({}, '', `#/payment-return/${paymentId}`)
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(screen.getByRole('heading', { name: heading })).toBeVisible()
  })

  it('never offers a guaranteed-failing retry for refunded or disputed payment records', () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/pay/ord-refunded/pay-refunded')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(screen.getByText(/fully refunded.+terminal.+cannot be retried/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: /retry attempt/i })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /view order/i })).toBeVisible()
  })

  it('shows retry only for a genuinely retryable lone failed attempt across customer and admin', () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    const createOrder = (requestId: string) => services.orders.create({
      requestId,
      quantity: 1,
      shippingMethod: 'standard',
      address: DEMO_ADDRESS,
      acknowledged: true,
      displayedTotalSen: 11_200,
    })

    const activeOrder = createOrder('checkout_0000000000000000000000000000b011')
    const activeOld = services.payments.createAttempt(activeOrder.id)
    services.payments.act(activeOld.id, 'decline')
    services.payments.createAttempt(activeOrder.id)

    const capturedOrder = createOrder('checkout_0000000000000000000000000000b012')
    const capturedOld = services.payments.createAttempt(capturedOrder.id)
    services.payments.act(capturedOld.id, 'decline')
    const capturedCurrent = services.payments.createAttempt(capturedOrder.id)
    services.payments.act(capturedCurrent.id, 'approve')

    const loneOrder = createOrder('checkout_0000000000000000000000000000b013')
    const loneFailed = services.payments.createAttempt(loneOrder.id)
    services.payments.act(loneFailed.id, 'decline')

    for (const [orderId, paymentId, retryVisible] of [
      [activeOrder.id, activeOld.id, false],
      [capturedOrder.id, capturedOld.id, false],
      [loneOrder.id, loneFailed.id, true],
    ] as const) {
      window.history.replaceState({}, '', `#/pay/${orderId}/${paymentId}`)
      render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
      const retry = screen.queryByRole('button', { name: /create idempotent retry attempt/i })
      if (retryVisible) expect(retry).toBeVisible()
      else expect(retry).not.toBeInTheDocument()
      cleanup()
    }

    services.auth.oneClick('admin')
    window.history.replaceState({}, '', '#/admin/payments')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    for (const [paymentId, retryVisible] of [
      [activeOld.id, false],
      [capturedOld.id, false],
      [loneFailed.id, true],
    ] as const) {
      const record = screen.getByText(paymentId, { selector: 'summary b' }).closest('details')!
      const retry = within(record).queryByRole('button', { name: /retry attempt/i })
      if (retryVisible) expect(retry).toBeInTheDocument()
      else expect(retry).not.toBeInTheDocument()
    }
  })

  it('names the order status filter and reflects each pressed toggle', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('admin')
    window.history.replaceState({}, '', '#/admin/orders')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const group = screen.getByRole('group', { name: /order status filter/i })
    const all = within(group).getByRole('button', { name: 'All' })
    const disputed = within(group).getByRole('button', { name: 'Disputed' })
    expect(all).toHaveAttribute('aria-pressed', 'true')
    expect(disputed).toHaveAttribute('aria-pressed', 'false')
    expect(within(group).getAllByRole('button').every((button) => button.hasAttribute('aria-pressed'))).toBe(true)

    await user.click(disputed)
    expect(all).toHaveAttribute('aria-pressed', 'false')
    expect(disputed).toHaveAttribute('aria-pressed', 'true')
    expect(disputed).toHaveClass('active')
  })

  it('announces a completed order action politely and clears it before the next blocked action', async () => {
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
    services.payments.createAttempt(unpaid.id)
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
    expect(await within(screen.getByRole('main')).findByRole('status')).toHaveTextContent(/fulfilled order closed and audit evidence saved/i)
    expect(services.repository.getSnapshot().orders.find((order) => order.id === 'ord-delivered')?.status).toBe('closed')
    expect(services.repository.getSnapshot().audits.at(-1)?.action).toBe('order.transitioned')

    await user.click(within(unpaidRecord).getByRole('button', { name: 'Cancel unpaid' }))
    expect(within(screen.getByRole('main')).queryByRole('status')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirm cancellation' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/cancel or expire the active payment/i)
    expect(within(screen.getByRole('main')).queryByRole('status')).not.toBeInTheDocument()
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
    expect(await screen.findByRole('alert')).toHaveTextContent(/cancel or expire the active payment/i)
    expect(within(screen.getByRole('main')).queryByRole('status')).not.toBeInTheDocument()
    expect(services.repository.getSnapshot().orders.find((entry) => entry.id === order.id)?.status).toBe('pending_payment')
  })

  it('limits an approved cross-kind conflict to no-remedy while its entitlement holder keeps progressing', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    const { conflicting, holder } = makeApprovedCrossKindRemedyConflict(services)
    window.history.replaceState({}, '', '#/admin/claims')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const conflictingRecord = screen
      .getByText(conflicting.id, { selector: 'summary b' })
      .closest('details')!
    const conflictNotice = within(conflictingRecord)
      .getByText(/overlapping remedy boxes:/i)
      .closest<HTMLElement>('.notice')!
    expect(conflictNotice).toHaveTextContent(holder.id)
    expect(conflictNotice).toHaveTextContent('box-delivered-01')
    expect(within(conflictNotice).getByRole('link', {
      name: new RegExp(`claim ${holder.id}`, 'i'),
    })).toBeVisible()

    await user.click(within(conflictingRecord).getByRole('button', {
      name: /record typed remedy/i,
    }))
    const conflictingDialog = screen.getByRole('dialog', {
      name: new RegExp(conflicting.id),
    })
    expect(within(conflictingDialog).getAllByRole('radio')).toHaveLength(1)
    expect(within(conflictingDialog).getByRole('radio', {
      name: /close explicitly with no remedy/i,
    })).toBeChecked()
    expect(within(conflictingDialog).queryByRole('radio', {
      name: /rma|refund|replacement|reissue/i,
    })).not.toBeInTheDocument()
    await user.click(within(conflictingDialog).getByRole('button', {
      name: /go back/i,
    }))

    const holderRecord = screen
      .getByText(holder.id, { selector: 'summary b' })
      .closest('details')!
    await user.click(within(holderRecord).getByRole('button', {
      name: /record typed remedy/i,
    }))
    const holderDialog = screen.getByRole('dialog', {
      name: new RegExp(holder.id),
    })
    expect(within(holderDialog).getByRole('radio', {
      name: /record rma received/i,
    })).toBeChecked()
    await user.click(within(holderDialog).getByRole('button', {
      name: /confirm typed evidence/i,
    }))
    expect(services.repository.getSnapshot().claims
      .find((claim) => claim.id === holder.id)).toMatchObject({
        remedyState: 'rma_received',
        status: 'approved',
      })
  })

  it('shows a scope-holder conflict and hides linked settlement on a direct claim-payment URL', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    const { conflicting, holder } = makeApprovedCrossKindRemedyConflict(services)
    window.history.replaceState(
      {},
      '',
      `#/admin/payments?order=ord-delivered&claim=${encodeURIComponent(conflicting.id)}`,
    )
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const paymentRecord = screen
      .getByText('pay-delivered', { selector: 'summary b' })
      .closest('details')!
    await user.click(paymentRecord.querySelector('summary')!)
    const unavailable = within(paymentRecord)
      .getByText('Linked refund unavailable on this payment')
      .closest('.notice')!
    expect(unavailable).toHaveTextContent(holder.id)
    expect(unavailable).toHaveTextContent('box-delivered-01')
    expect(within(paymentRecord).queryByRole('button', {
      name: new RegExp(`linked claim ${conflicting.id}`, 'i'),
    })).not.toBeInTheDocument()
  })

  it('keeps partial goodwill and dispute marking but hides generic full-refund controls for a blocking claim', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    const claim = services.claims.submit({
      orderId: 'ord-processing',
      kind: 'value_floor',
      boxId: 'box-processing-01',
      note: 'DEMO open claim blocks generic full payment refunds',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(
      claim.id,
      'acknowledge',
      'Confirmed generic refund blocker acknowledgement',
    )
    services.claims.review(
      claim.id,
      'approve',
      'Confirmed generic refund blocker approval',
    )
    window.history.replaceState({}, '', '#/admin/payments?order=ord-processing')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const paymentRecord = screen
      .getByText('pay-processing', { selector: 'summary b' })
      .closest('details')!
    await user.click(paymentRecord.querySelector('summary')!)
    const blockerNotice = within(paymentRecord)
      .getByText('Full payment refund is coordinated through claim remedies')
      .closest<HTMLElement>('.notice')!
    expect(within(blockerNotice).getByRole('link', {
      name: new RegExp(`claim ${claim.id}`, 'i'),
    })).toBeVisible()
    expect(blockerNotice).toHaveTextContent(
      /eligible rm10 partial goodwill and dispute marking remain separate/i,
    )
    expect(within(paymentRecord).getByRole('button', {
      name: /unlinked partial refund rm10/i,
    })).toBeVisible()
    expect(within(paymentRecord).getByRole('button', {
      name: /mark disputed/i,
    })).toBeVisible()
    expect(within(paymentRecord).queryByRole('button', {
      name: /unlinked refund remaining/i,
    })).not.toBeInTheDocument()

    await user.click(within(paymentRecord).getByRole('button', {
      name: /mark disputed/i,
    }))
    const disputeDialog = screen.getByRole('dialog', {
      name: /confirm dispute payment action/i,
    })
    await user.click(within(disputeDialog).getByRole('button', {
      name: /confirm and audit/i,
    }))
    expect(await within(paymentRecord).findByRole('button', {
      name: /resolve: merchant won/i,
    })).toBeVisible()
    expect(within(paymentRecord).queryByRole('button', {
      name: /resolve: full refund/i,
    })).not.toBeInTheDocument()

    cleanup()
    window.history.replaceState(
      {},
      '',
      `#/admin/claims?claim=${encodeURIComponent(claim.id)}`,
    )
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const claimRecord = screen
      .getByText(claim.id, { selector: 'summary b' })
      .closest('details')!
    expect(claimRecord).toHaveTextContent(
      /order ord-processing is disputed.+only close explicitly with no remedy/i,
    )
    await user.click(within(claimRecord).getByRole('button', {
      name: /record typed remedy/i,
    }))
    const heldDialog = screen.getByRole('dialog', {
      name: new RegExp(claim.id),
    })
    expect(within(heldDialog).getAllByRole('radio')).toHaveLength(1)
    expect(within(heldDialog).getByRole('radio', {
      name: /close explicitly with no remedy/i,
    })).toBeChecked()
  })

  it.each(['rejected', 'no-remedy'] as const)(
    'keeps generic full refund available for a %s claim',
    async (terminalClaimState) => {
      const user = userEvent.setup()
      const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
      services.auth.oneClick('customer')
      const claim = services.claims.submit({
        orderId: 'ord-delivered',
        kind: 'damage',
        shipmentId: 'shp-delivered',
        note: `DEMO ${terminalClaimState} claim allows generic full refund`,
      }).data
      services.auth.oneClick('admin')
      if (terminalClaimState === 'rejected') {
        services.claims.review(
          claim.id,
          'reject',
          'Confirmed rejected claim safe full-refund exception',
        )
      } else {
        services.claims.review(
          claim.id,
          'acknowledge',
          'Confirmed no-remedy acknowledgement',
        )
        services.claims.review(
          claim.id,
          'approve',
          'Confirmed no-remedy approval',
        )
        services.claims.review(
          claim.id,
          'resolve',
          'Confirmed explicit no-remedy resolution',
          {
            outcome: 'no_remedy',
            reference: `DEMO-NO-${claim.id.toUpperCase()}`,
          },
        )
      }
      window.history.replaceState({}, '', '#/admin/payments?order=ord-delivered')
      render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

      const paymentRecord = screen
        .getByText('pay-delivered', { selector: 'summary b' })
        .closest('details')!
      await user.click(paymentRecord.querySelector('summary')!)
      expect(within(paymentRecord).getByRole('button', {
        name: /unlinked refund remaining rm\s*112\.00/i,
      })).toBeVisible()
      expect(within(paymentRecord).queryByText(
        'Full payment refund is coordinated through claim remedies',
      )).not.toBeInTheDocument()
    },
  )

  it('records an exact full claim-linked refund, then finalizes the exact event separately', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    const claim = services.claims.submit({
      orderId: 'ord-shipped',
      kind: 'non_delivery',
      shipmentId: 'shp-shipped',
      note: 'DEMO overdue shipment finance handoff',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Confirmed finance handoff acknowledgement')
    services.claims.review(claim.id, 'approve', 'Confirmed finance handoff approval review')
    window.history.replaceState({}, '', '#/admin/claims')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const record = screen.getByText(claim.id).closest('details')!
    expect(within(record).getByText(/does not refund automatically/i)).toBeVisible()
    await user.click(within(record).getByRole('button', { name: /record typed remedy/i }))
    const remedyDialog = screen.getByRole('dialog', { name: new RegExp(claim.id) })
    expect(within(remedyDialog).getByRole('group', { name: /choose one exact remedy action/i })).toBeVisible()
    expect(within(remedyDialog).getByRole('radio', { name: /open exact claim-scope settlement/i })).toBeChecked()
    await user.click(within(remedyDialog).getByRole('button', { name: /open exact payment/i }))
    expect(await screen.findByRole('heading', { name: 'Payments' })).toBeVisible()
    expect(screen.getByText(/showing only payments for exact order/i)).toHaveTextContent('ord-shipped')
    expect(screen.getByText('pay-shipped')).toBeVisible()
    expect(screen.queryByText('pay-unopened')).not.toBeInTheDocument()
    const paymentRecord = screen.getByText('pay-shipped').closest('details')!
    await user.click(paymentRecord.querySelector('summary')!)
    expect(screen.getByText(/unrelated payment actions are hidden; leave or clear this claim workflow/i)).toBeVisible()
    expect(within(paymentRecord).queryByRole('button', { name: /unlinked partial refund/i })).not.toBeInTheDocument()
    expect(within(paymentRecord).queryByRole('button', { name: /unlinked refund remaining/i })).not.toBeInTheDocument()
    expect(within(paymentRecord).queryByRole('button', { name: /mark disputed/i })).not.toBeInTheDocument()
    const linkedRefund = within(paymentRecord).getByRole('button', {
      name: new RegExp(`linked claim ${claim.id}.+exact claim-scope settlement rm\\s*112\\.00`, 'i'),
    })
    expect(within(paymentRecord).queryByRole('button', { name: /linked claim.+partial/i })).not.toBeInTheDocument()
    await user.click(linkedRefund)
    const refundDialog = screen.getByRole('dialog', { name: new RegExp(`exact claim-scope settlement of rm\\s*112\\.00 for claim ${claim.id}`, 'i') })
    expect(refundDialog).toHaveTextContent(claim.id)
    expect(refundDialog).toHaveTextContent('pay-shipped')
    expect(refundDialog).toHaveTextContent(/rm\s*112\.00/i)
    await user.click(within(refundDialog).getByRole('button', { name: /confirm exact settlement & audit/i }))

    const linkedState = services.repository.getSnapshot()
    const linkedClaim = linkedState.claims.find((entry) => entry.id === claim.id)!
    const linkedPayment = linkedState.payments.find((entry) => entry.id === 'pay-shipped')!
    expect(linkedPayment.refundedSen).toBe(linkedPayment.amountSen)
    expect(linkedClaim.status).toBe('approved')
    expect(linkedClaim.remedyState).toBe('refund_linked')
    expect(linkedClaim.acceptedSettlementSen).toBe(11_200)
    expect(linkedClaim.settlementPolicy).toBe('exact_scope')
    expect(linkedClaim.linkedRefundEventId).toBeTruthy()
    expect(within(paymentRecord).getByText(new RegExp(`linked claim ${claim.id}`, 'i'))).toBeVisible()

    cleanup()
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/order/ord-shipped')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(screen.getByText(/refund waiting for final claim audit/i)).toBeVisible()
    expect(screen.queryByText(/audited refund complete/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Refunded', { exact: true })).not.toBeInTheDocument()
    expect(screen.getAllByText('Refund Linked', { exact: true }).length).toBeGreaterThan(0)

    cleanup()
    services.auth.oneClick('admin')
    window.history.replaceState({}, '', `#/admin/claims?claim=${encodeURIComponent(claim.id)}`)
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const focusedClaim = screen.getByText(claim.id).closest('details')!
    expect(focusedClaim).toHaveAttribute('data-focused', 'true')
    expect(focusedClaim).toHaveTextContent(
      /existing linked refund may still be finalized through its exact final audit/i,
    )
    expect(focusedClaim).toHaveTextContent(
      /linked-refund final audit remains available/i,
    )
    expect(focusedClaim).not.toHaveTextContent(
      /claim with no started remedy may only close explicitly/i,
    )
    await user.click(within(focusedClaim).getByRole('button', { name: /record typed remedy/i }))
    const finalDialog = screen.getByRole('dialog', { name: new RegExp(claim.id) })
    expect(within(finalDialog).getByRole('radio', { name: /finalize exact audited refund link/i })).toBeChecked()
    expect(finalDialog).toHaveTextContent(linkedClaim.linkedRefundEventId!)
    await user.click(within(finalDialog).getByRole('button', { name: /confirm typed evidence/i }))
    const finalized = services.repository.getSnapshot().claims.find((entry) => entry.id === claim.id)!
    expect(finalized.status).toBe('resolved')
    expect(finalized.remedyState).toBe('refund_completed')
    expect(finalized.resolutionReference).toBe(linkedClaim.linkedRefundEventId)

    cleanup()
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/order/ord-shipped')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(screen.getAllByText(/audited refund complete/i).length).toBeGreaterThan(0)
  })

  it('settles exactly one RM106 value-floor remedy scope against an RM212 payment', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    const claim = services.claims.submit({
      orderId: 'ord-processing',
      kind: 'value_floor',
      boxId: 'box-processing-01',
      note: 'DEMO one-box value-floor exact-scope settlement evidence',
    }).data
    expect(claim.remedyBoxIds).toEqual(['box-processing-01'])
    expect(claim.requiredSettlementSen).toBe(10_600)

    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Confirmed exact-scope acknowledgement')
    services.claims.review(claim.id, 'approve', 'Confirmed exact-scope approval')
    window.history.replaceState({}, '', `#/admin/claims?claim=${encodeURIComponent(claim.id)}`)
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const claimRecord = screen.getByText(claim.id, { selector: 'summary b' }).closest('details')!
    expect(claimRecord).toHaveTextContent(/remedy box scopebox-processing-01/i)
    expect(claimRecord).toHaveTextContent(/required settlementrm\s*106\.00/i)
    await user.click(within(claimRecord).getByRole('button', { name: /record typed remedy/i }))
    const remedyDialog = screen.getByRole('dialog', { name: new RegExp(claim.id) })
    expect(within(remedyDialog).getByRole('radio', {
      name: /open exact claim-scope settlement in payments/i,
    })).toBeChecked()
    expect(remedyDialog).toHaveTextContent(/exact required settlement of rm\s*106\.00/i)
    expect(remedyDialog).toHaveTextContent('box-processing-01')
    await user.click(within(remedyDialog).getByRole('button', { name: /open exact payment/i }))

    const paymentRecord = screen.getByText('pay-processing', { selector: 'summary b' }).closest('details')!
    await user.click(paymentRecord.querySelector('summary')!)
    const settle = within(paymentRecord).getByRole('button', {
      name: new RegExp(`linked claim ${claim.id}.+exact claim-scope settlement rm\\s*106\\.00`, 'i'),
    })
    await user.click(settle)
    const refundDialog = screen.getByRole('dialog', {
      name: new RegExp(`exact claim-scope settlement of rm\\s*106\\.00 for claim ${claim.id}`, 'i'),
    })
    expect(refundDialog).toHaveTextContent(claim.id)
    expect(refundDialog).toHaveTextContent('pay-processing')
    expect(refundDialog).toHaveTextContent(/remedy box scopebox-processing-01/i)
    expect(refundDialog).toHaveTextContent(/required claim settlementrm\s*106\.00/i)
    expect(refundDialog).toHaveTextContent(/remaining payment balancerm\s*212\.00/i)
    expect(refundDialog).toHaveTextContent(/amount to refundrm\s*106\.00/i)
    expect(refundDialog).toHaveTextContent(/may leave a separate remaining balance/i)
    await user.click(within(refundDialog).getByRole('button', {
      name: /confirm exact settlement & audit/i,
    }))

    const linkedState = services.repository.getSnapshot()
    const linkedPayment = linkedState.payments.find((entry) => entry.id === 'pay-processing')!
    const linkedClaim = linkedState.claims.find((entry) => entry.id === claim.id)!
    const linkedEvent = linkedPayment.events.find((entry) =>
      entry.refundIntent?.claimId === claim.id)!
    expect(linkedPayment).toMatchObject({
      amountSen: 21_200,
      refundedSen: 10_600,
      status: 'partially_refunded',
    })
    expect(linkedEvent.refundIntent?.amountSen).toBe(10_600)
    expect(linkedClaim).toMatchObject({
      acceptedSettlementSen: 10_600,
      remedyBoxIds: ['box-processing-01'],
      remedyState: 'refund_linked',
      settlementPolicy: 'exact_scope',
      status: 'approved',
    })

    cleanup()
    window.history.replaceState({}, '', `#/admin/claims?claim=${encodeURIComponent(claim.id)}`)
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const focusedClaim = screen.getByText(claim.id, { selector: 'summary b' }).closest('details')!
    await user.click(within(focusedClaim).getByRole('button', { name: /record typed remedy/i }))
    await user.click(within(screen.getByRole('dialog', { name: new RegExp(claim.id) }))
      .getByRole('button', { name: /confirm typed evidence/i }))

    const finalizedState = services.repository.getSnapshot()
    const finalizedClaim = finalizedState.claims.find((entry) => entry.id === claim.id)!
    const fulfillment = resolveOrderFulfillment(finalizedState, 'ord-processing')
    const settledScope = fulfillment.scopes.find((scope) =>
      scope.boxIds.includes('box-processing-01'))!
    const untouchedScope = fulfillment.scopes.find((scope) =>
      scope.boxIds.includes('box-processing-02'))!
    expect(finalizedClaim).toMatchObject({
      remedyState: 'refund_completed',
      settlementPolicy: 'exact_scope',
      status: 'resolved',
    })
    expect(settledScope).toMatchObject({ completedBy: 'refund', status: 'fulfilled' })
    expect(untouchedScope.status).toBe('confirmed')
    expect(fulfillment.status).toBe('partially_fulfilled')

    cleanup()
    services.auth.oneClick('customer')
    services.openBox('box-processing-02')
    window.history.replaceState({}, '', '#/order/ord-processing')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const completedEvidence = screen.getAllByText('Audited refund complete')
      .map((element) => element.closest('p'))
      .find((element) => element?.textContent?.includes('Accepted'))!
    expect(completedEvidence).toHaveTextContent(/accepted rm\s*106\.00.+required rm\s*106\.00/i)
    expect(completedEvidence).toHaveTextContent(/settlement policy: exact scope/i)
    expect(screen.getByText(/1 of 2 box fulfilment scopes complete/i)).toBeVisible()
  })

  it('caps a failed digital one-box terminal fallback at RM106 on an RM212 payment', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    services.openBox('box-processing-02')
    const claim = services.claims.submit({
      orderId: 'ord-processing',
      kind: 'value_floor',
      boxId: 'box-processing-02',
      note: 'DEMO digital one-box capped terminal fallback UI',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(
      claim.id,
      'acknowledge',
      'Confirmed digital fallback acknowledgement',
    )
    services.claims.review(
      claim.id,
      'approve',
      'Confirmed digital fallback approval',
    )
    const replacement = services.claims.authorizeReplacement(
      claim.id,
      'Confirmed digital reissue before capped fallback',
    ).data
    for (const status of ['issued', 'sent', 'failed'] as const) {
      services.fulfilment.advance(
        replacement.id,
        status,
        `Confirmed digital replacement ${status}`,
      )
    }
    window.history.replaceState(
      {},
      '',
      `#/admin/claims?claim=${encodeURIComponent(claim.id)}`,
    )
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const claimRecord = screen
      .getByText(claim.id, { selector: 'summary b' })
      .closest('details')!
    expect(claimRecord).toHaveTextContent(
      /capped terminal replacement fallback available/i,
    )
    expect(claimRecord).toHaveTextContent(
      /smaller of required settlement rm\s*106\.00 and one selected payment's remaining balance/i,
    )
    await user.click(within(claimRecord).getByRole('button', {
      name: /record typed remedy/i,
    }))
    const remedyDialog = screen.getByRole('dialog', {
      name: new RegExp(`capped terminal replacement fallback.+${claim.id}`, 'i'),
    })
    expect(within(remedyDialog).getByRole('radio', {
      name: /open capped terminal replacement fallback in payments/i,
    })).toBeChecked()
    expect(remedyDialog).toHaveTextContent(
      /smaller of required settlement rm\s*106\.00 and the selected payment’s remaining balance/i,
    )
    await user.click(within(remedyDialog).getByRole('button', {
      name: /open exact payment/i,
    }))

    const paymentRecord = screen
      .getByText('pay-processing', { selector: 'summary b' })
      .closest('details')!
    await user.click(paymentRecord.querySelector('summary')!)
    const fallback = within(paymentRecord).getByRole('button', {
      name: new RegExp(
        `linked claim ${claim.id}.+capped terminal replacement fallback rm\\s*106\\.00`,
        'i',
      ),
    })
    expect(within(paymentRecord).queryByRole('button', {
      name: new RegExp(
        `linked claim ${claim.id}.+terminal replacement fallback rm\\s*212\\.00`,
        'i',
      ),
    })).not.toBeInTheDocument()
    await user.click(fallback)
    const fallbackDialog = screen.getByRole('dialog', {
      name: new RegExp(
        `capped terminal replacement fallback of rm\\s*106\\.00 for claim ${claim.id}`,
        'i',
      ),
    })
    expect(fallbackDialog).toHaveTextContent(/required claim settlementrm\s*106\.00/i)
    expect(fallbackDialog).toHaveTextContent(/remaining payment balancerm\s*212\.00/i)
    expect(fallbackDialog).toHaveTextContent(/amount to refundrm\s*106\.00/i)
    expect(fallbackDialog).toHaveTextContent(
      /smaller of the required claim settlement and the remaining payment balance: rm\s*106\.00/i,
    )
  })

  it('offers a lost physical replacement fallback for the capped post-partial remaining balance', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    const claim = services.claims.submit({
      orderId: 'ord-failed',
      kind: 'non_delivery',
      shipmentId: 'shp-failed',
      note: 'DEMO lost replacement terminal fallback evidence',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Confirmed fallback acknowledgement')
    services.claims.review(claim.id, 'approve', 'Confirmed fallback approval')
    const replacement = services.claims.authorizeReplacement(
      claim.id,
      'Confirmed physical replacement before terminal fallback',
    ).data
    services.payments.refund(
      'pay-failed',
      1000,
      'Confirmed prior unlinked partial refund',
      'req-prior-unlinked-partial-fallback',
    )
    window.history.replaceState({}, '', `#/admin/claims?claim=${encodeURIComponent(claim.id)}`)
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const claimRecord = screen.getByText(claim.id, { selector: 'summary b' }).closest('details')!
    expect(claimRecord).toHaveTextContent(/replacement in progress · refund fallback unavailable/i)
    expect(claimRecord).toHaveTextContent(/only if this exact replacement is lost or returned/i)
    expect(within(claimRecord).queryByRole('button', { name: /record typed remedy/i }))
      .not.toBeInTheDocument()

    for (const status of ['picking', 'packed', 'label_created', 'shipped', 'failed_delivery'] as const) {
      services.fulfilment.advance(
        replacement.id,
        status,
        `Confirmed terminal fallback replacement ${status}`,
      )
    }
    await waitFor(() => {
      expect(claimRecord).toHaveTextContent(/physical replacement is failed delivery/i)
      expect(claimRecord).toHaveTextContent(/only lost or returned is eligible/i)
      expect(within(claimRecord).queryByRole('button', { name: /record typed remedy/i }))
        .not.toBeInTheDocument()
    })
    services.fulfilment.advance(
      replacement.id,
      'lost',
      'Confirmed terminal fallback replacement lost',
    )

    await waitFor(() => {
      expect(claimRecord).toHaveTextContent(/terminal replacement fallback available/i)
      expect(within(claimRecord).getByRole('button', { name: /record typed remedy/i })).toBeVisible()
    })
    await user.click(within(claimRecord).getByRole('button', { name: /record typed remedy/i }))
    const remedyDialog = screen.getByRole('dialog', { name: new RegExp(claim.id) })
    expect(within(remedyDialog).getByRole('radio', {
      name: /open capped terminal replacement fallback in payments/i,
    })).toBeChecked()
    expect(remedyDialog).toHaveTextContent(
      /smaller of required settlement rm\s*112\.00 and the selected payment’s remaining balance/i,
    )
    await user.click(within(remedyDialog).getByRole('button', { name: /open exact payment/i }))

    const paymentRecord = screen.getByText('pay-failed', { selector: 'summary b' }).closest('details')!
    await user.click(paymentRecord.querySelector('summary')!)
    const fallback = within(paymentRecord).getByRole('button', {
      name: new RegExp(`linked claim ${claim.id}.+terminal replacement fallback rm\\s*102\\.00`, 'i'),
    })
    await user.click(fallback)
    const fallbackDialog = screen.getByRole('dialog', {
      name: new RegExp(`capped terminal replacement fallback of rm\\s*102\\.00 for claim ${claim.id}`, 'i'),
    })
    expect(fallbackDialog).toHaveTextContent(claim.id)
    expect(fallbackDialog).toHaveTextContent('pay-failed')
    expect(fallbackDialog).toHaveTextContent(/required claim settlementrm\s*112\.00/i)
    expect(fallbackDialog).toHaveTextContent(/remaining payment balancerm\s*102\.00/i)
    expect(fallbackDialog).toHaveTextContent(/settlement policyterminal replacement fallback/i)
    expect(fallbackDialog).toHaveTextContent(/amount to refundrm\s*102\.00/i)
    expect(fallbackDialog).toHaveTextContent(
      /smaller of the required claim settlement and the remaining payment balance: rm\s*102\.00/i,
    )
    await user.click(within(fallbackDialog).getByRole('button', {
      name: /confirm capped terminal fallback & audit/i,
    }))

    const snapshot = services.repository.getSnapshot()
    const payment = snapshot.payments.find((entry) => entry.id === 'pay-failed')!
    const linkedClaim = snapshot.claims.find((entry) => entry.id === claim.id)!
    const linkedEvent = payment.events.find((entry) =>
      entry.refundIntent?.claimId === claim.id)!
    expect(payment).toMatchObject({
      amountSen: 11_200,
      refundedSen: 11_200,
      status: 'refunded',
    })
    expect(linkedEvent.refundIntent?.amountSen).toBe(10_200)
    expect(linkedClaim).toMatchObject({
      acceptedSettlementSen: 10_200,
      remedyState: 'refund_linked',
      settlementPolicy: 'terminal_replacement_fallback',
      status: 'approved',
    })

    cleanup()
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/order/ord-failed')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const waitingScope = screen.getByText('box-failed-01', { selector: '.scope-box-ids' })
      .closest('article')!
    expect(within(waitingScope).getByText(replacement.id, { exact: true })).toBeVisible()
    expect(waitingScope).toHaveTextContent(/replacement exception · settlement is waiting for final claim audit/i)
    expect(waitingScope).not.toHaveTextContent(/replacement exception · claim remains open/i)

    cleanup()
    services.auth.oneClick('admin')
    services.claims.review(
      claim.id,
      'resolve',
      'Confirmed terminal fallback final claim audit',
      { outcome: 'refund_recorded', reference: linkedEvent.id },
    )
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/order/ord-failed')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const settledScope = screen.getByText('box-failed-01', { selector: '.scope-box-ids' })
      .closest('article')!
    expect(within(settledScope).getByText(replacement.id, { exact: true })).toBeVisible()
    expect(settledScope).toHaveTextContent(/replacement exception · box fulfilment scope was settled by refund/i)
    expect(settledScope).not.toHaveTextContent(/replacement exception · claim remains open/i)
  })

  it('keeps grouped two-box scope cards keyed and limits replacement/refund evidence to the exact box', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    makeProcessingOrderSingleGroupedPhysicalShipment(services)
    services.auth.oneClick('customer')
    services.openBox('box-processing-02')
    const claim = services.claims.submit({
      orderId: 'ord-processing',
      kind: 'value_floor',
      boxId: 'box-processing-01',
      note: 'DEMO grouped shipment exact-box evidence',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Confirmed grouped-scope acknowledgement')
    services.claims.review(claim.id, 'approve', 'Confirmed grouped-scope approval')
    const replacement = services.claims.authorizeReplacement(
      claim.id,
      'Confirmed grouped-scope exact replacement',
    ).data
    for (const status of ['picking', 'packed', 'label_created', 'shipped', 'lost'] as const) {
      services.fulfilment.advance(
        replacement.id,
        status,
        `Confirmed grouped-scope replacement ${status}`,
      )
    }
    const payment = services.repository.getSnapshot().payments
      .find((entry) => entry.id === 'pay-processing')!
    services.payments.refund(
      payment.id,
      claim.requiredSettlementSen,
      'Confirmed grouped-scope terminal fallback',
      'req-grouped-scope-terminal-fallback',
      claim.id,
    )

    const consoleError = vi.spyOn(console, 'error')
    try {
      services.auth.oneClick('customer')
      window.history.replaceState({}, '', '#/order/ord-processing')
      render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

      expect(document.querySelectorAll('.remedy-scope')).toHaveLength(2)
      const affectedScope = screen.getByText('box-processing-01', { selector: '.scope-box-ids' })
        .closest('article')!
      const siblingScope = screen.getByText('box-processing-02', { selector: '.scope-box-ids' })
        .closest('article')!
      expect(within(affectedScope).getByText(replacement.id, { exact: true })).toBeVisible()
      expect(affectedScope).toHaveTextContent(/refund waiting for final claim audit/i)
      expect(affectedScope).toHaveTextContent(/settlement is waiting for final claim audit/i)
      expect(within(siblingScope).queryByText(replacement.id, { exact: true })).not.toBeInTheDocument()
      expect(siblingScope).not.toHaveTextContent(/refund waiting for final claim audit/i)
      expect(siblingScope).not.toHaveTextContent(/replacement exception/i)

      cleanup()
      services.auth.oneClick('admin')
      window.history.replaceState({}, '', '#/admin/orders')
      render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
      const orderRecord = screen.getByText('ORD-PROCESSING').closest('details')!
      await user.click(orderRecord.querySelector('summary')!)
      const adminAffectedScope = within(orderRecord)
        .getByText('box-processing-01', { selector: '.scope-box-ids' })
        .closest('article')!
      const adminSiblingScope = within(orderRecord)
        .getByText('box-processing-02', { selector: '.scope-box-ids' })
        .closest('article')!
      expect(adminAffectedScope).toHaveTextContent(replacement.id)
      expect(adminAffectedScope).toHaveTextContent(/refund: waiting final audit/i)
      expect(adminSiblingScope).not.toHaveTextContent(replacement.id)
      expect(adminSiblingScope).toHaveTextContent(/refund: not used/i)

      const consoleMessages = consoleError.mock.calls
        .flatMap((call) => call.map((value) => String(value)))
        .join(' ')
      expect(consoleMessages).not.toMatch(/same key|unique ["']key["'] prop/i)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('shows an insufficient exact-scope balance as read-only with no linked action', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    const claim = services.claims.submit({
      orderId: 'ord-processing',
      kind: 'value_floor',
      boxId: 'box-processing-01',
      note: 'DEMO insufficient exact-scope payment balance evidence',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Confirmed insufficient-balance acknowledgement')
    services.claims.review(claim.id, 'approve', 'Confirmed insufficient-balance approval')
    services.payments.refund(
      'pay-processing',
      11_000,
      'Confirmed unlinked refund leaving insufficient balance',
      'req-insufficient-claim-scope-balance',
    )
    window.history.replaceState(
      {},
      '',
      `#/admin/payments?order=ord-processing&claim=${encodeURIComponent(claim.id)}`,
    )
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const paymentRecord = screen.getByText('pay-processing', { selector: 'summary b' }).closest('details')!
    await user.click(paymentRecord.querySelector('summary')!)
    expect(paymentRecord).toHaveTextContent(
      /remaining payment balance rm\s*102\.00 is below the exact claim-scope settlement of rm\s*106\.00/i,
    )
    expect(within(paymentRecord).queryByRole('button', {
      name: /linked claim.+exact claim-scope settlement/i,
    })).not.toBeInTheDocument()
  })

  it('hides unrelated payment actions for an invalid claim workflow until it is cleared', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('admin')
    window.history.replaceState({}, '', '#/admin/payments?claim=claim-does-not-exist')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/exact claim claim-does-not-exist was not found/i)
    expect(alert).toHaveTextContent(/unrelated payment actions are hidden/i)
    expect(screen.queryByRole('button', { name: /unlinked partial refund/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /unlinked refund remaining/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /mark disputed/i })).not.toBeInTheDocument()

    await user.click(within(alert).getByRole('button', { name: /clear claim workflow/i }))
    const paymentRecord = await screen.findByText('pay-unopened', { selector: 'summary b' })
      .then((element) => element.closest('details')!)
    await user.click(paymentRecord.querySelector('summary')!)
    expect(within(paymentRecord).getByRole('button', { name: /unlinked partial refund rm10/i })).toBeVisible()
    expect(within(paymentRecord).getByRole('button', { name: /mark disputed/i })).toBeVisible()
  })

  it('renders migrated legacy under-settled evidence without claiming remedy completion', async () => {
    const user = userEvent.setup()
    const sourceServices = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    makeProcessingOrderSingleGroupedPhysicalShipment(sourceServices)
    sourceServices.auth.oneClick('customer')
    sourceServices.openBox('box-processing-02')
    const claim = sourceServices.claims.submit({
      orderId: 'ord-processing',
      kind: 'value_floor',
      boxId: 'box-processing-01',
      note: 'DEMO legacy under-settled customer rendering evidence',
    }).data
    sourceServices.auth.oneClick('admin')
    sourceServices.claims.review(claim.id, 'acknowledge', 'Confirmed legacy UI acknowledgement')
    sourceServices.claims.review(claim.id, 'approve', 'Confirmed legacy UI approval')
    sourceServices.payments.refund(
      'pay-processing',
      claim.requiredSettlementSen,
      'Confirmed exact refund before version downgrade',
      'req-legacy-ui-under-settled',
      claim.id,
    )
    const linkedEventId = sourceServices.repository.getSnapshot().claims
      .find((entry) => entry.id === claim.id)!.linkedRefundEventId!

    const legacy = structuredClone(sourceServices.repository.exportForTest()) as unknown as Omit<
      DemoState,
      'schemaVersion' | 'claims'
    > & {
      schemaVersion: number
      claims: Array<Partial<DemoState['claims'][number]>>
    }
    legacy.schemaVersion = 7
    for (const legacyClaim of legacy.claims) {
      delete legacyClaim.remedyBoxIds
      delete legacyClaim.requiredSettlementSen
      delete legacyClaim.acceptedSettlementSen
      delete legacyClaim.settlementPolicy
      delete legacyClaim.legacyUnderSettledRefund
    }
    const payment = legacy.payments.find((entry) => entry.id === 'pay-processing')!
    payment.events.find((entry) => entry.id === linkedEventId)!.refundIntent!.amountSen = 1000
    payment.refundedSen = 1000
    const paymentAudit = legacy.audits.find((audit) =>
      audit.eventId === linkedEventId && audit.targetType === 'payment')!
    ;(paymentAudit.after as Record<string, unknown>).refundedSen = 1000

    const migrated = migrateDemoStateV7(legacy)
    expect(() => validateDemoState(migrated)).not.toThrow()
    expect(migrated.claims[0]).toMatchObject({
      acceptedSettlementSen: 1000,
      legacyUnderSettledRefund: true,
      requiredSettlementSen: 10_600,
    })
    const storage = new MemoryStorage()
    storage.seed(STORAGE_KEY, JSON.stringify(migrated))
    const services = new AppServices(storage, () => FIXED_NOW)
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/order/ord-processing')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const legacyEvidence = screen.getByText(
      'Immutable legacy under-settled refund evidence',
    ).closest('p')!
    expect(legacyEvidence).toHaveTextContent(/accepted rm\s*10\.00.+required rm\s*106\.00/i)
    expect(legacyEvidence).toHaveTextContent(/does not complete this delivery\/remedy scope/i)
    expect(legacyEvidence).toHaveTextContent(/no valid completion settlement policy/i)
    expect(screen.queryByText(/audited refund complete/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Refund Linked', { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByText(/waiting for final claim audit|final claim audit pending/i))
      .not.toBeInTheDocument()
    const orderTruth = screen.getByText(
      'Legacy refund record is read-only and incomplete',
    ).closest('.notice')!
    expect(orderTruth).toHaveTextContent(/immutable under-settled evidence/i)
    expect(orderTruth).toHaveTextContent(/does not complete the remedy scope/i)
    expect(orderTruth).toHaveTextContent(/no final audit is available/i)
    expect(screen.getByText(/0 of 2 box fulfilment scopes complete/i)).toBeVisible()

    cleanup()
    window.history.replaceState({}, '', '#/account')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const accountOrder = screen.getByRole('heading', {
      level: 3,
      name: 'ORD-PROCESSING',
    }).closest('article')!
    expect(within(accountOrder).queryByText('Refund Linked', { exact: true }))
      .not.toBeInTheDocument()
    expect(within(accountOrder).queryByText(
      /waiting for final claim audit|final claim audit pending/i,
    )).not.toBeInTheDocument()
    const accountTruth = within(accountOrder).getByText(
      'Legacy refund record is read-only and incomplete',
    ).closest('.notice')!
    expect(accountTruth).toHaveTextContent(/immutable under-settled evidence/i)
    expect(accountTruth).toHaveTextContent(/accepted rm\s*10\.00.+required rm\s*106\.00/i)
    expect(accountTruth).toHaveTextContent(/does not complete the remedy scope/i)
    expect(accountTruth).toHaveTextContent(/no final audit is available/i)

    cleanup()
    services.auth.oneClick('admin')
    window.history.replaceState({}, '', '#/admin/payments?order=ord-processing')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const paymentRecord = screen
      .getByText('pay-processing', { selector: 'summary b' })
      .closest('details')!
    await user.click(paymentRecord.querySelector('summary')!)
    expect(within(paymentRecord).getByRole('button', {
      name: /unlinked refund remaining rm\s*202\.00/i,
    })).toBeVisible()
    expect(within(paymentRecord).queryByText(
      'Full payment refund is coordinated through claim remedies',
    )).not.toBeInTheDocument()

    cleanup()
    window.history.replaceState({}, '', '#/admin/orders')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const adminOrder = screen
      .getByText('ORD-PROCESSING', { selector: 'summary b' })
      .closest('details')!
    await user.click(adminOrder.querySelector('summary')!)
    expect(within(adminOrder).getByText(
      'Legacy under-settled · scope incomplete',
    )).toBeVisible()
    expect(within(adminOrder).queryByText('Refund Linked', { exact: true }))
      .not.toBeInTheDocument()

    cleanup()
    services.auth.oneClick('admin')
    services.payments.refund(
      'pay-processing',
      20_200,
      'Confirmed later full refund without rewriting immutable legacy evidence',
      'req-legacy-ui-later-full-refund',
    )
    expect(services.repository.getSnapshot().orders
      .find((entry) => entry.id === claim.orderId)?.status).toBe('refunded')
    window.history.replaceState({}, '', `#/admin/claims?claim=${encodeURIComponent(claim.id)}`)
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const legacyRecord = screen.getByText(claim.id, { selector: 'summary b' }).closest('details')!
    expect(legacyRecord).toHaveTextContent(/approved legacy claim · immutable evidence cannot finalize/i)
    expect(legacyRecord).toHaveTextContent(/no final audit is available/i)
    expect(within(legacyRecord).queryByText(
      'Financial hold limits typed remedy work',
    )).not.toBeInTheDocument()
    expect(legacyRecord).not.toHaveTextContent(
      /existing linked refund may still be finalized|linked-refund final audit remains available|final claims audit still required/i,
    )
    expect(within(legacyRecord).queryByRole('button', { name: /record typed remedy/i })).not.toBeInTheDocument()
    expect(within(legacyRecord).queryByRole('radio', { name: /finalize exact audited refund link/i })).not.toBeInTheDocument()
  })

  it.each(['disputed', 'refunded'] as const)(
    'hides impossible digital fulfilment controls during a %s hold while retaining physical carrier evidence',
    (hold) => {
      const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
      services.auth.oneClick('admin')
      for (const [shipmentId, path] of [
        ['shp-processing', ['packed', 'label_created', 'shipped']],
        ['shp-digital', ['issued', 'sent']],
      ] as const) {
        for (const status of path) {
          services.fulfilment.advance(
            shipmentId,
            status,
            `Confirmed held fulfilment UI setup ${status}`,
          )
        }
      }
      const payment = services.repository.getSnapshot().payments
        .find((entry) => entry.id === 'pay-processing')!
      if (hold === 'disputed') {
        services.payments.dispute(
          payment.id,
          'Confirmed digital action visibility dispute hold',
          'evt-digital-action-visibility-dispute',
        )
      } else {
        services.payments.refund(
          payment.id,
          payment.amountSen,
          'Confirmed digital action visibility refund hold',
          'req-digital-action-visibility-refund',
        )
      }
      window.history.replaceState({}, '', '#/admin/fulfilment')
      render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

      const physical = screen.getByText('BULKY / shp-processing').closest('article')!
      expect(within(physical).getByRole('button', { name: /mark delivered/i })).toBeVisible()
      expect(within(physical).getByRole('button', { name: /delivery exception/i })).toBeVisible()
      expect(within(physical).getByRole('button', { name: /mark lost/i })).toBeVisible()
      expect(within(physical).getByRole('button', { name: /mark returned/i })).toBeVisible()
      expect(within(physical).queryByRole('button', { name: /edit carrier/i })).not.toBeInTheDocument()

      const digital = screen.getByText('DIGITAL / shp-digital').closest('article')!
      expect(within(digital).queryAllByRole('button')).toHaveLength(0)
    },
  )

  it('shows structured claim resolution evidence to admin and customer', () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    const claim = services.claims.submit({
      orderId: 'ord-delivered',
      kind: 'damage',
      shipmentId: 'shp-delivered',
      note: 'DEMO structured resolution display claim',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Confirmed display claim acknowledgement')
    services.claims.review(claim.id, 'approve', 'Confirmed display claim approval')
    services.claims.review(
      claim.id,
      'resolve',
      'Confirmed fictional no-remedy record for component display',
      { outcome: 'no_remedy', reference: `DEMO-NO-${claim.id.toUpperCase()}` },
    )
    window.history.replaceState({}, '', '#/admin/claims')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(screen.getByText(/structured resolution recorded/i)).toBeVisible()
    expect(screen.getByText(`DEMO-NO-${claim.id.toUpperCase()}`, { exact: false })).toBeVisible()

    cleanup()
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/order/ord-delivered')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(screen.getByText(/recorded resolution/i)).toBeVisible()
    expect(screen.getAllByText(/no remedy/i).length).toBeGreaterThan(0)
  })

  it('records created, received and inspected RMA evidence while the claim stays approved', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    const claim = services.claims.submit({
      orderId: 'ord-delivered',
      kind: 'damage',
      shipmentId: 'shp-delivered',
      note: 'DEMO delivered item needs a typed return review',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Confirmed RMA acknowledgement evidence')
    services.claims.review(claim.id, 'approve', 'Confirmed RMA approval evidence')
    window.history.replaceState({}, '', `#/admin/claims?claim=${encodeURIComponent(claim.id)}`)
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const record = screen.getByText(claim.id).closest('details')!
    for (const [choice, expectedState] of [
      [/create physical return \/ rma/i, 'rma_created'],
      [/record rma received/i, 'rma_received'],
      [/record rma inspected/i, 'rma_inspected'],
    ] as const) {
      await user.click(within(record).getByRole('button', { name: /record typed remedy/i }))
      const dialog = screen.getByRole('dialog', { name: new RegExp(claim.id) })
      expect(within(dialog).getByRole('group', { name: /choose one exact remedy action/i })).toBeVisible()
      expect(within(dialog).getByRole('radio', { name: choice })).toBeChecked()
      await user.click(within(dialog).getByRole('button', { name: /confirm typed evidence/i }))
      const current = services.repository.getSnapshot().claims.find((entry) => entry.id === claim.id)!
      expect(current.status).toBe('approved')
      expect(current.remedyState).toBe(expectedState)
    }

    const inspected = services.repository.getSnapshot().claims.find((entry) => entry.id === claim.id)!
    expect(inspected.rma?.status).toBe('inspected')
    expect(within(record).getByText(/rma evidence · claim remains approved/i)).toBeVisible()
    expect(within(record).getAllByText('Approved').length).toBeGreaterThan(0)
    expect(within(record).queryByText(/final read-only evidence/i)).not.toBeInTheDocument()
  })

  it('delivers a replacement beneath an unchanged failed original', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    const claim = services.claims.submit({
      orderId: 'ord-failed',
      kind: 'non_delivery',
      shipmentId: 'shp-failed',
      note: 'DEMO original delivery failed and needs replacement',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Confirmed failed original acknowledgement')
    services.claims.review(claim.id, 'approve', 'Confirmed failed original approval')
    window.history.replaceState({}, '', `#/admin/claims?claim=${encodeURIComponent(claim.id)}`)
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const claimRecord = screen.getByText(claim.id).closest('details')!
    await user.click(within(claimRecord).getByRole('button', { name: /record typed remedy/i }))
    const dialog = screen.getByRole('dialog', { name: new RegExp(claim.id) })
    await user.click(within(dialog).getByRole('radio', { name: /authorize replacement shipment/i }))
    await user.click(within(dialog).getByRole('button', { name: /confirm typed evidence/i }))
    let snapshot = services.repository.getSnapshot()
    let currentClaim = snapshot.claims.find((entry) => entry.id === claim.id)!
    expect(currentClaim.status).toBe('approved')
    expect(currentClaim.remedyState).toBe('replacement_authorized')
    const replacementId = currentClaim.replacementShipmentId!
    for (const status of ['picking', 'packed', 'label_created', 'shipped', 'delivered'] as const) {
      services.fulfilment.advance(replacementId, status, `Confirmed replacement delivery ${status}`)
    }
    snapshot = services.repository.getSnapshot()
    currentClaim = snapshot.claims.find((entry) => entry.id === claim.id)!
    expect(snapshot.shipments.find((shipment) => shipment.id === 'shp-failed')?.status).toBe('failed_delivery')
    expect(currentClaim.status).toBe('resolved')
    expect(currentClaim.remedyState).toBe('replacement_delivered')

    cleanup()
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/order/ord-failed')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const scope = screen.getByText('shp-failed').closest<HTMLElement>('.remedy-scope')!
    expect(within(scope).getByText('Failed Delivery')).toBeVisible()
    expect(within(scope).getByText(replacementId)).toBeVisible()
    expect(within(scope).getAllByText(/replacement delivered/i).length).toBeGreaterThan(0)
    expect(scope.querySelector('.remedy-replacement')).toBeTruthy()
  })

  it('uses only digital controls for a failed digital original and its delivered reissue', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('admin')
    for (const status of ['issued', 'sent', 'failed'] as const) {
      services.fulfilment.advance('shp-digital', status, `Confirmed digital original ${status}`)
    }
    services.auth.oneClick('customer')
    const claim = services.claims.submit({
      orderId: 'ord-processing',
      kind: 'non_delivery',
      orderLevelDelivery: true,
      note: 'DEMO digital delivery failed and needs reissue',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Confirmed digital failure acknowledgement')
    services.claims.review(claim.id, 'approve', 'Confirmed digital failure approval')
    const replacement = services.claims.authorizeReplacement(
      claim.id,
      'Confirmed exact digital reissue authorization',
    ).data
    window.history.replaceState({}, '', `#/admin/fulfilment?claim=${encodeURIComponent(claim.id)}&shipment=${encodeURIComponent(replacement.id)}`)
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const original = screen.getByText('DIGITAL / shp-digital').closest<HTMLElement>('article')!
    const reissue = screen.getByText(`DIGITAL / ${replacement.id}`).closest<HTMLElement>('article')!
    expect(within(original).getByText('Digital delivery', { exact: true })).toBeVisible()
    expect(within(original).queryByText(/carrier|tracking/i)).not.toBeInTheDocument()
    expect(within(original).queryAllByRole('button')).toHaveLength(0)
    expect(within(reissue).getByText('Digital reissue', { exact: true })).toBeVisible()
    expect(within(reissue).queryByText(/carrier|tracking/i)).not.toBeInTheDocument()
    expect(within(reissue).getByRole('button', { name: /^issue$/i })).toBeVisible()
    expect(within(reissue).queryByRole('button', { name: /picking|packed|label|shipped/i })).not.toBeInTheDocument()

    for (const [button, status] of [
      [/^issue$/i, 'issued'],
      [/mark sent/i, 'sent'],
      [/mark delivered/i, 'delivered'],
    ] as const) {
      await user.click(within(reissue).getByRole('button', { name: button }))
      await user.click(screen.getByRole('button', { name: /confirm scan & audit/i }))
      expect(services.repository.getSnapshot().shipments.find((entry) => entry.id === replacement.id)?.status).toBe(status)
    }
    expect(services.repository.getSnapshot().claims.find((entry) => entry.id === claim.id)?.remedyState).toBe('replacement_delivered')

    services.repository.update((state) => {
      state.boxes.find((box) => box.id === 'box-processing-02')!.revealedAt = '2026-07-28T05:00:00.000Z'
    })
    cleanup()
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/order/ord-processing')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const digitalScope = screen.getByText('shp-digital').closest<HTMLElement>('.remedy-scope')!
    expect(within(digitalScope).getByRole('heading', { name: 'Digital delivery' })).toBeVisible()
    expect(within(digitalScope).getByText('Failed')).toBeVisible()
    expect(within(digitalScope).getByText(replacement.id)).toBeVisible()
    expect(within(digitalScope).getAllByText(/replacement delivered/i).length).toBeGreaterThan(0)
  })

  it('closes a mixed order after original delivery and delivered reissue complete both original scopes', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('admin')
    for (const status of ['packed', 'label_created', 'shipped', 'delivered'] as const) {
      services.fulfilment.advance('shp-processing', status, `Confirmed mixed physical ${status}`)
    }
    for (const status of ['issued', 'sent', 'failed'] as const) {
      services.fulfilment.advance('shp-digital', status, `Confirmed mixed digital ${status}`)
    }
    services.auth.oneClick('customer')
    const claim = services.claims.submit({
      orderId: 'ord-processing',
      kind: 'non_delivery',
      orderLevelDelivery: true,
      note: 'DEMO mixed original group digital failure',
    }).data
    services.auth.oneClick('admin')
    services.claims.review(claim.id, 'acknowledge', 'Confirmed mixed scope acknowledgement')
    services.claims.review(claim.id, 'approve', 'Confirmed mixed scope approval')
    const replacement = services.claims.authorizeReplacement(claim.id, 'Confirmed mixed scope digital reissue').data
    for (const status of ['issued', 'sent', 'delivered'] as const) {
      services.fulfilment.advance(replacement.id, status, `Confirmed mixed reissue ${status}`)
    }
    expect(services.repository.getSnapshot().orders.find((order) => order.id === 'ord-processing')?.status).toBe('fulfilled')

    window.history.replaceState({}, '', '#/admin/orders')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const record = screen.getByText('ORD-PROCESSING').closest('details')!
    await user.click(record.querySelector('summary')!)
    expect(within(record).getByText(/2 of 2 box fulfilment scopes complete/i)).toBeVisible()
    expect(within(record).getByText(/replacement: delivered/i)).toBeVisible()
    await user.click(within(record).getByRole('button', { name: /close order/i }))
    const dialog = screen.getByRole('dialog', { name: /close this fulfilled order/i })
    expect(dialog).toHaveTextContent(/original delivery.+completed audited linked refund.+delivered replacement/i)
    expect(dialog).toHaveTextContent(/does not require every shipment row to be delivered/i)
    await user.click(within(dialog).getByRole('button', { name: /confirm closure/i }))
    expect(services.repository.getSnapshot().orders.find((order) => order.id === 'ord-processing')?.status).toBe('closed')
  })

  it('records a post-delivery return without creating a claim or refund', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('admin')
    const before = services.repository.getSnapshot()
    const claimCount = before.claims.length
    const refundedSen = before.payments.reduce((sum, payment) => sum + payment.refundedSen, 0)
    window.history.replaceState({}, '', '#/admin/fulfilment')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const delivered = screen.getByText('BULKY / shp-delivered').closest('article')!
    await user.click(within(delivered).getByRole('button', { name: /record post-delivery return/i }))
    const dialog = screen.getByRole('dialog', { name: /record this post-delivery return/i })
    expect(dialog).toHaveTextContent(/does not create a claim or refund/i)
    await user.click(within(dialog).getByRole('button', { name: /confirm return record & audit/i }))
    const after = services.repository.getSnapshot()
    expect(after.claims).toHaveLength(claimCount)
    expect(after.payments.reduce((sum, payment) => sum + payment.refundedSen, 0)).toBe(refundedSen)
    expect(after.shipments.find((shipment) => shipment.id === 'shp-delivered')?.status).toBe('returned')
  })

  it('keeps failed confirms open with an alert, blocks duplicates, and restores exact opener focus', async () => {
    const user = userEvent.setup()
    let release: (() => void) | undefined
    const confirm = vi.fn()
      .mockRejectedValueOnce(new Error('Exact dialog action failed safely.'))
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        release = resolve
      }))

    function DialogHarness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open exact action</button>
          <ConfirmDialog
            open={open}
            title="Confirm exact action?"
            confirmLabel="Confirm exact action"
            onConfirm={confirm}
            onCancel={() => setOpen(false)}
          >
            Exact accessible action copy.
          </ConfirmDialog>
        </>
      )
    }

    render(<DialogHarness />)
    const opener = screen.getByRole('button', { name: /open exact action/i })
    await user.click(opener)
    let dialog = screen.getByRole('dialog', { name: /confirm exact action/i })
    await user.click(within(dialog).getByRole('button', { name: 'Confirm exact action' }))
    expect(dialog).toBeVisible()
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Exact dialog action failed safely.')

    await user.click(within(dialog).getByRole('button', { name: /go back/i }))
    await waitFor(() => expect(opener).toHaveFocus())
    await user.click(opener)
    dialog = screen.getByRole('dialog', { name: /confirm exact action/i })
    const submit = within(dialog).getByRole('button', { name: 'Confirm exact action' })
    fireEvent.click(submit)
    fireEvent.click(submit)
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(dialog).toHaveAttribute('aria-busy', 'true')
    expect(submit).toBeDisabled()
    act(() => release?.())
    await waitFor(() => expect(dialog).toHaveAttribute('aria-busy', 'false'))

    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    await waitFor(() => expect(opener).toHaveFocus())
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

  it('shows neutral sealed-order tracking and reveals prize-derived details only after every box opens', () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/order/ord-unopened')
    const view = render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(screen.getByText(/useful delivery progress stays visible/i)).toBeVisible()
    expect(screen.getByText('DEMO-DELIVERY-ORD-UNOPENED')).toBeVisible()
    expect(screen.queryByText('DEMO-P-UNOPENED')).not.toBeInTheDocument()
    expect(screen.queryByText(/delivery record 01/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Demo Express')).not.toBeInTheDocument()
    expect(screen.queryByText('PARCEL', { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByText(/signature required/i)).not.toBeInTheDocument()
    expect(screen.queryByText('shp-unopened', { exact: false })).not.toBeInTheDocument()
    const fulfilment = screen.getByRole('heading', { name: /private-prize tracking/i }).closest('section')!
    expect(screen.getByText('All fulfilment details stay combined until every box in this order is revealed.')).toBeVisible()
    expect(fulfilment.querySelectorAll('.shipment-card')).toHaveLength(1)
    expect(fulfilment.querySelectorAll('.sealed-delivery-summary .status')).toHaveLength(1)

    view.unmount()
    window.history.replaceState({}, '', '#/order/ord-shipped')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(screen.getByRole('heading', { name: 'Box fulfilment scopes & remedies' })).toBeVisible()
    expect(screen.getByText('DEMO-SHIPPED')).toBeVisible()
    expect(screen.getByText('Demo Express')).toBeVisible()
    expect(screen.getByText(/signature required/i)).toBeVisible()
  })

  it('shows only sanitized creation and payment history for a sealed order with sequential section numbers', () => {
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/order/ord-processing')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const timeline = screen.getByRole('heading', { name: /order events/i })
      .closest<HTMLElement>('.panel')!
    expect(within(timeline).getByText('Demo order created')).toBeVisible()
    expect(within(timeline).getByText('Mock payment confirmed')).toBeVisible()
    expect(within(timeline).queryByText('Order processing')).not.toBeInTheDocument()
    expect(within(timeline).getByText(/only sanitized order and payment history is shown/i)).toBeVisible()
    expect(screen.getByText('03 / BOXES')).toBeVisible()
    expect(screen.getByText('04 / CLAIMS')).toBeVisible()
    expect(screen.getByText('05 / FULFILMENT')).toBeVisible()

    const unsafeOrder = structuredClone(
      createDemoState().orders.find((order) => order.id === 'ord-processing')!,
    )
    unsafeOrder.timeline[0].status = 'processing'
    unsafeOrder.timeline[0].label = 'Unsafe stored creation detail'
    expect(sealedCustomerTimeline(unsafeOrder)[0]).toEqual({
      id: unsafeOrder.timeline[0].id,
      status: 'pending_payment',
      label: 'Demo order created',
      at: unsafeOrder.timeline[0].at,
    })
  })

  it('keeps mixed-order shipment claim clues sealed while allowing revealed-box value-floor claims', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/claim/new?order=ord-processing')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    expect(screen.getByText(/sealed prizes stay private/i)).toBeVisible()
    expect(screen.getByLabelText('Order delivery')).toBeVisible()
    expect(screen.getByLabelText('Order delivery')).toHaveValue('')
    expect(screen.getByLabelText(/fictional note/i)).toBeVisible()
    expect(screen.getByRole('button', { name: /submit demo claim/i })).toBeDisabled()
    for (const shipmentClue of [
      'shp-processing',
      'shp-digital',
      'BULKY',
      'DIGITAL',
      'Demo Bulky Freight',
      'Digital Vault',
      'DEMO-P-PROCESSING',
      'DEMO-P-DIGITAL',
      'box-processing-02',
    ]) {
      expect(screen.queryByText(shipmentClue, { exact: false })).not.toBeInTheDocument()
    }

    await user.selectOptions(screen.getByLabelText('Claim type'), 'non_delivery')
    expect(screen.getByLabelText('Order delivery')).toHaveValue('')
    expect(screen.getByText(/sealed prizes stay private/i)).toBeVisible()

    await user.selectOptions(screen.getByLabelText('Claim type'), 'value_floor')
    const revealedBox = screen.getByLabelText('Revealed box')
    expect(revealedBox).toBeVisible()
    expect(within(revealedBox).getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /box 01 · revealed · suspected-issue review/i }))
      .toBeVisible()
    expect(screen.queryByRole('option', { name: /box-processing-02/i })).not.toBeInTheDocument()
    expect(screen.getByText(
      /stored suspected-review threshold for this order is RM\s*100\.00.+eligibility for review does not mean its declared prize is actually below that threshold/i,
    )).toBeVisible()
    expect(screen.getByLabelText(/fictional note/i)).toBeVisible()
    expect(screen.getByRole('button', { name: /submit demo claim/i })).toBeEnabled()
  })

  it('uses a valid RM125 historical floor across claim and order review views', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.repository.update((state) => {
      state.orders.find((order) => order.id === 'ord-delivered')!
        .snapshot.valueFloorSen = 12_500
    })
    expect(() => validateDemoState(services.repository.getSnapshot())).not.toThrow()
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/claim/new?order=ord-delivered')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    await user.selectOptions(screen.getByLabelText('Claim type'), 'value_floor')
    const claimMain = within(screen.getByRole('main'))
    expect(claimMain.getByRole('option', {
      name: /suspected RM\s*125\.00 value-floor issue/i,
    })).toBeVisible()
    expect(claimMain.getByText(
      /stored suspected-review threshold for this order is RM\s*125\.00/i,
    )).toBeVisible()
    expect(claimMain.queryByText(/RM\s*100(?:\.00)?/i)).not.toBeInTheDocument()

    cleanup()
    window.history.replaceState({}, '', '#/order/ord-delivered')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const floorRow = screen.getByText('Value-floor review snapshot').closest('div')
    expect(floorRow).toHaveTextContent(/RM\s*125\.00/)
    expect(floorRow).toHaveTextContent(/suspected-issue threshold only, not a breach finding/i)
    expect(floorRow).not.toHaveTextContent(/RM\s*100(?:\.00)?/i)
    expect(screen.getByText(/declared fixture value.+not a finding of a value-floor breach/i))
      .toBeVisible()
  })

  it('maps a sealed eligible delivery record through a neutral claim option', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    services.repository.update((state) => {
      state.boxes.find((box) => box.id === 'box-shipped-01')!.revealedAt = undefined
    })
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/claim/new?order=ord-shipped')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    await user.selectOptions(screen.getByLabelText('Claim type'), 'non_delivery')
    const delivery = screen.getByLabelText('Order delivery')
    expect(delivery).toHaveValue('order-delivery')
    expect(screen.getByRole('option', { name: /order delivery · eligible neutral record/i })).toBeVisible()
    expect(screen.queryByText('shp-shipped', { exact: false })).not.toBeInTheDocument()
    expect(screen.queryByText('Demo Express')).not.toBeInTheDocument()
    expect(screen.queryByText('PARCEL', { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByText(/signature required/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /submit demo claim/i })).toBeEnabled()
  })

  it('shows one sealed option for two eligible physical shipments without leaking or mistargeting either split', async () => {
    const user = userEvent.setup()
    const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
    makeProcessingOrderTwoPhysicalShipments(services)
    services.auth.oneClick('admin')
    for (const [shipmentId, path] of [
      ['shp-processing', ['packed', 'label_created', 'shipped', 'failed_delivery']],
      ['shp-digital', ['picking', 'packed', 'label_created', 'shipped', 'failed_delivery']],
    ] as const) {
      for (const status of path) {
        services.fulfilment.advance(shipmentId, status, `Confirmed multi-link privacy ${status}`)
      }
    }
    services.repository.update((state) => {
      state.boxes.find((box) => box.id === 'box-processing-01')!.revealedAt = undefined
    })
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/claim/new?order=ord-processing')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    await user.selectOptions(screen.getByLabelText('Claim type'), 'non_delivery')
    const delivery = screen.getByLabelText('Order delivery')
    expect(within(delivery).getAllByRole('option')).toHaveLength(1)
    expect(delivery).toHaveValue('order-delivery')
    expect(screen.queryByText(/shp-processing|shp-digital/i)).not.toBeInTheDocument()
    await user.clear(screen.getByLabelText(/fictional note/i))
    await user.type(screen.getByLabelText(/fictional note/i), 'DEMO: One neutral order delivery option is missing.')
    const refundedBefore = services.repository.getSnapshot().payments.reduce(
      (sum, payment) => sum + payment.refundedSen,
      0,
    )
    await user.click(screen.getByRole('button', { name: /submit demo claim/i }))

    const submitted = services.repository.getSnapshot().claims.at(-1)!
    expect(submitted.orderId).toBe('ord-processing')
    expect(submitted.shipmentId).toBeUndefined()
    expect(submitted.shipmentCandidateIds).toEqual(['shp-digital', 'shp-processing'])
    expect(services.claims.listMine().at(-1)).not.toHaveProperty('shipmentCandidateIds')
    expect(screen.queryByText(/shp-processing|shp-digital|demo bulky freight|demo express/i)).not.toBeInTheDocument()
    expect(services.repository.getSnapshot().payments.reduce(
      (sum, payment) => sum + payment.refundedSen,
      0,
    )).toBe(refundedBefore)

    cleanup()
    services.auth.oneClick('admin')
    window.history.replaceState({}, '', '#/admin/claims')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(screen.getByText(
      'Order-level candidates: shp-digital, shp-processing',
      { exact: true },
    )).toBeVisible()
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
        message: 'Out-of-order event was recorded without changing payment status.',
      })
    services.auth.oneClick('admin')
    window.history.replaceState({}, '', '#/admin/payments')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)

    const record = screen.getByText(payment.id).closest('details')!
    await user.click(record.querySelector('summary')!)
    await user.click(within(record).getByRole('button', { name: /reconcile succeeded/i }))
    await user.click(screen.getByRole('button', { name: /confirm and audit/i }))
    const duplicateNotice = await screen.findByText('Duplicate event ignored safely.')
    expect(duplicateNotice).toBeVisible()
    expect(duplicateNotice).toHaveClass('notice-info')
    expect(duplicateNotice).not.toHaveClass('notice-success')
    expect(duplicateNotice).toHaveAttribute('role', 'status')
    expect(duplicateNotice).toHaveAttribute('aria-live', 'polite')
    expect(screen.queryByText(/reconcile action completed and audited/i)).not.toBeInTheDocument()

    await user.click(within(record).getByRole('button', { name: /reconcile succeeded/i }))
    await user.click(screen.getByRole('button', { name: /confirm and audit/i }))
    const outOfOrderNotice = await screen.findByText('Out-of-order event was recorded without changing payment status.')
    expect(outOfOrderNotice).toBeVisible()
    expect(outOfOrderNotice).toHaveClass('notice-info')
    expect(outOfOrderNotice).not.toHaveClass('notice-success')
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
