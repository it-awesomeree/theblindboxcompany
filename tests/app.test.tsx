import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { App } from '../src/App'
import { AppServices } from '../src/services/AppServices'
import { AppStateProvider } from '../src/state/AppState'
import {
  MemoryStorage,
  FIXED_NOW,
  makeProcessingOrderTwoPhysicalShipments,
} from './helpers'
import { VaultCanvas } from '../src/components/VaultCanvas'
import { Notice } from '../src/components/Notice'
import { createDemoState, DEMO_ADDRESS } from '../src/data/fixtures'
import { STORAGE_KEY } from '../src/data/MockRepository'
import { sealedCustomerTimeline } from '../src/domain/orderTimeline'

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
      'Confirmed resolved queue replacement regression',
      { outcome: 'replacement_authorized', reference: `DEMO-${resolvedClaim.id.toUpperCase()}` },
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

  it('shows failed startup cleanup recovery in the rendered shell', () => {
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
    class FailOnceStorage extends MemoryStorage {
      fail = true
      setItem(key: string, value: string) {
        if (this.fail) {
          this.fail = false
          throw new Error('startup cleanup write failed')
        }
        super.setItem(key, value)
      }
    }
    const storage = new FailOnceStorage()
    storage.seed(STORAGE_KEY, preparedStorage.getItem(STORAGE_KEY)!)
    const services = new AppServices(storage, () => FIXED_NOW)
    window.history.replaceState({}, '', '#/')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(screen.getByText(/automatic cleanup was not saved.+nothing changed.+safe to retry or refresh/i)).toBeVisible()
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
      ['shp-digital', ['picking', 'packed', 'label_created', 'shipped']],
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
      state.boxes.find((box) => box.id === 'box-processing-02')!.revealedAt = FIXED_NOW
    })
    window.history.replaceState({}, '', '#/account')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    const revealedRecord = screen.getByText('ORD-PROCESSING').closest('article')!
    expect(within(revealedRecord).getByText(/record 1:/i)).toBeVisible()
    expect(within(revealedRecord).getByText(/record 2:/i)).toBeVisible()
    expect(within(revealedRecord).getByText('Delivered')).toBeVisible()
    expect(within(revealedRecord).getByText('Shipped')).toBeVisible()
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

  it.each(['disputed', 'refunded'] as const)(
    'hides impossible digital fulfilment controls during a %s hold while retaining physical carrier evidence',
    (hold) => {
      const services = new AppServices(new MemoryStorage(), () => FIXED_NOW)
      services.auth.oneClick('admin')
      for (const [shipmentId, path] of [
        ['shp-processing', ['packed', 'label_created', 'shipped']],
        ['shp-digital', ['picking', 'packed', 'label_created', 'shipped']],
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
      'Confirmed fictional RMA record for component display',
      { outcome: 'return_rma_created', reference: `DEMO-RMA-${claim.id.toUpperCase()}` },
    )
    window.history.replaceState({}, '', '#/admin/claims')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(screen.getByText(/structured resolution recorded/i)).toBeVisible()
    expect(screen.getByText(`DEMO-RMA-${claim.id.toUpperCase()}`, { exact: false })).toBeVisible()

    cleanup()
    services.auth.oneClick('customer')
    window.history.replaceState({}, '', '#/order/ord-delivered')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(screen.getByText(/recorded resolution/i)).toBeVisible()
    expect(screen.getByText(/return rma created/i)).toBeVisible()
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
    expect(fulfilment.querySelectorAll('.shipment-card')).toHaveLength(1)
    expect(fulfilment.querySelectorAll('.sealed-delivery-summary .status')).toHaveLength(1)

    view.unmount()
    window.history.replaceState({}, '', '#/order/ord-shipped')
    render(<AppStateProvider providedServices={services}><App /></AppStateProvider>)
    expect(screen.getByText('DEMO-P-SHIPPED')).toBeVisible()
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
    expect(screen.getByLabelText('Revealed box')).toBeVisible()
    expect(screen.getByRole('option', { name: /box 01 · revealed/i })).toHaveTextContent(/box 01 · revealed/i)
    expect(screen.queryByRole('option', { name: /box-processing-02/i })).not.toBeInTheDocument()
    expect(screen.getByLabelText(/fictional note/i)).toBeVisible()
    expect(screen.getByRole('button', { name: /submit demo claim/i })).toBeEnabled()
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
