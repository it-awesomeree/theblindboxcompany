import { useEffect, useRef, useState } from 'react'
import type { PropsWithChildren } from 'react'
import { NavLink } from '../lib/router'
import { useLocation, useNavigate } from '../lib/router-core'
import { titleForRoute } from '../lib/route-metadata'
import { ADMIN_ROLES } from '../domain/constants'
import { useAppState } from '../state/AppStateContext'
import { Brand } from './Brand'
import { ConfirmDialog } from './ConfirmDialog'
import { DemoBanner } from './DemoBanner'

function SessionControls({
  className,
  user,
  onLogout,
}: {
  className: string
  user: ReturnType<typeof useAppState>['state']['users'][number] | undefined
  onLogout: () => void
}) {
  return (
    <div className={`nav-session ${className}`}>
      {user ? (
        <>
          <span className="nav-user"><b>{user.name}</b><small>{user.role}</small></span>
          <button type="button" className="nav-action" onClick={onLogout}>Log out</button>
        </>
      ) : (
        <NavLink className="nav-action" to="/auth">Demo sign in</NavLink>
      )}
    </div>
  )
}

export function Layout({ children }: PropsWithChildren) {
  const { state, services } = useAppState()
  const user = state.users.find((entry) => entry.id === state.sessionUserId)
  const cartCount = state.cart.reduce((sum, item) => sum + item.quantity, 0)
  const navigate = useNavigate()
  const { pathname, search } = useLocation()
  const previousPathname = useRef<string | null>(null)
  const [resetPending, setResetPending] = useState(false)
  const [resetError, setResetError] = useState('')
  const [sessionError, setSessionError] = useState('')

  const focusMain = () => {
    const main = document.getElementById('main-content')
    main?.scrollIntoView({ block: 'start' })
    main?.focus({ preventScroll: true })
  }

  useEffect(() => {
    document.title = titleForRoute(pathname)
  }, [pathname, search])

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    if (previousPathname.current === pathname) return
    previousPathname.current = pathname
    const main = document.getElementById('main-content')
    const target = main?.querySelector<HTMLElement>('h1') ?? main
    target?.setAttribute('tabindex', '-1')
    target?.focus({ preventScroll: true })
  }, [pathname])

  const logout = () => {
    setSessionError('')
    try {
      services.auth.logout()
      navigate('/')
    } catch (caught) {
      setSessionError(caught instanceof Error ? caught.message : 'Log out was not saved. Nothing changed; please try again.')
    }
  }

  const reset = () => {
    setResetError('')
    try {
      services.reset()
      setResetPending(false)
      navigate('/')
    } catch (caught) {
      setResetError(caught instanceof Error ? caught.message : 'Demo data could not be reset. Nothing changed; please try again.')
    }
  }

  const closeReset = () => {
    setResetError('')
    setResetPending(false)
  }

  return (
    <div className="app-shell">
      <button className="skip-link" type="button" onClick={focusMain}>Skip to content</button>
      <DemoBanner />
      <header className="site-nav">
        <div className="nav-inner">
          <Brand />
          <SessionControls className="nav-session-mobile" user={user} onLogout={logout} />
          <nav className="nav-links" aria-label="Main navigation">
            <NavLink to="/">Vault</NavLink>
            <NavLink to="/cart">Cart <span className="nav-count">{cartCount}</span></NavLink>
            {user?.role === 'customer' && <NavLink to="/account">Account</NavLink>}
            {user && ADMIN_ROLES.includes(user.role) && <NavLink to="/admin">Admin</NavLink>}
          </nav>
          <SessionControls className="nav-session-desktop" user={user} onLogout={logout} />
        </div>
      </header>
      {services.repository.recoveryNotice && (
        <div className="recovery-note">{services.repository.recoveryNotice}</div>
      )}
      {sessionError && <div className="recovery-note" role="alert">{sessionError}</div>}
      <main id="main-content" tabIndex={-1}>{children}</main>
      <footer className="site-footer">
        <div className="content footer-grid">
          <div>
            <Brand />
            <p>RM100 in. Never less than RM100 out.</p>
          </div>
          <div>
            <b>PUBLIC FAKE-DATA PROTOTYPE</b>
            <p>Single-tab, browser-local simulation only. No products, money, accounts, or messages leave this browser.</p>
          </div>
          <div>
            <b>GitHub Pages is not a backend</b>
            <p>Payment and prize controls shown here are simulations for review, not production security.</p>
          </div>
        </div>
        <div className="content footer-legal">
          <span>© 2026 The Blind Box Company — concept prototype; trademark status not claimed.</span>
          <button type="button" onClick={() => {
            setResetError('')
            setResetPending(true)
          }}>Reset demo data</button>
        </div>
      </footer>
      <ConfirmDialog
        open={resetPending}
        title="Reset all demo data?"
        confirmLabel="Confirm demo reset"
        danger
        onConfirm={reset}
        onCancel={closeReset}
      >
        <p>This removes this tab’s fictional session changes and restores the safe starting fixtures. No real account, order, payment, or shipment is affected.</p>
        {resetError && <div className="notice notice-danger" role="alert">{resetError}</div>}
      </ConfirmDialog>
    </div>
  )
}
