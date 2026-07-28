import { useEffect } from 'react'
import type { PropsWithChildren } from 'react'
import { NavLink } from '../lib/router'
import { useLocation, useNavigate } from '../lib/router-core'
import { ADMIN_ROLES } from '../domain/constants'
import { useAppState } from '../state/AppStateContext'
import { Brand } from './Brand'
import { DemoBanner } from './DemoBanner'

export function Layout({ children }: PropsWithChildren) {
  const { state, services } = useAppState()
  const user = state.users.find((entry) => entry.id === state.sessionUserId)
  const cartCount = state.cart.reduce((sum, item) => sum + item.quantity, 0)
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const focusMain = () => {
    const main = document.getElementById('main-content')
    main?.scrollIntoView({ block: 'start' })
    main?.focus({ preventScroll: true })
  }

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    const main = document.getElementById('main-content')
    const target = main?.querySelector<HTMLElement>('h1') ?? main
    target?.setAttribute('tabindex', '-1')
    target?.focus({ preventScroll: true })
  }, [pathname])

  const logout = () => {
    services.auth.logout()
    navigate('/')
  }

  return (
    <div className="app-shell">
      <button className="skip-link" type="button" onClick={focusMain}>Skip to content</button>
      <DemoBanner />
      <header className="site-nav">
        <div className="nav-inner">
          <Brand />
          <nav className="nav-links" aria-label="Main navigation">
            <NavLink to="/">Vault</NavLink>
            <NavLink to="/cart">Cart <span className="nav-count">{cartCount}</span></NavLink>
            {user && <NavLink to="/account">Account</NavLink>}
            {user && ADMIN_ROLES.includes(user.role) && <NavLink to="/admin">Admin</NavLink>}
          </nav>
          <div className="nav-session">
            {user ? (
              <>
                <span className="nav-user"><b>{user.name}</b><small>{user.role}</small></span>
                <button type="button" className="nav-action" onClick={logout}>Log out</button>
              </>
            ) : (
              <NavLink className="nav-action" to="/auth">Demo sign in</NavLink>
            )}
          </div>
        </div>
      </header>
      {services.repository.recoveryNotice && (
        <div className="recovery-note">{services.repository.recoveryNotice}</div>
      )}
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
          <button type="button" onClick={() => services.reset()}>Reset demo data</button>
        </div>
      </footer>
    </div>
  )
}
