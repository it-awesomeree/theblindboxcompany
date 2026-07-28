import { useState } from 'react'
import { useLocation, useNavigate } from '../lib/router-core'
import { Notice } from '../components/Notice'
import { useAppState } from '../state/AppStateContext'

export function AuthPage() {
  const { services } = useAppState()
  const navigate = useNavigate()
  const location = useLocation()
  const [email, setEmail] = useState('new.customer@example.test')
  const [name, setName] = useState('New Demo Customer')
  const [error, setError] = useState('')
  const destination = (location.state as { from?: string } | null)?.from ?? '/account'

  const run = (action: () => unknown, to = destination) => {
    try {
      action()
      navigate(to)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Demo access failed.')
    }
  }

  return (
    <section className="route-page auth-page">
      <div className="content narrow">
        <span className="eyebrow">MOCK AUTH GATEWAY</span>
        <h1>Enter the demo vault.</h1>
        <Notice tone="danger"><b>Do not enter a real email or password.</b> This prototype has no password field and only accepts fictional demo domains.</Notice>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="auth-fast-grid">
          <button className="action-tile" type="button" onClick={() => run(() => services.auth.oneClick('customer'))}>
            <span>01 / CUSTOMER</span><b>One-click Aina Demo</b><small>Shop, pay, open and track fictional orders.</small>
          </button>
          <button className="action-tile" type="button" onClick={() => run(() => services.auth.oneClick('admin'), '/admin')}>
            <span>02 / SUPER ADMIN</span><b>One-click Vault Admin</b><small>Protected queues, inventory, fulfilment and audit.</small>
          </button>
          <button className="action-tile" type="button" onClick={() => run(() => services.auth.mockGoogle())}>
            <span>03 / MOCK GOOGLE</span><b>Continue with mock Google</b><small>No Google request is sent. No token is created.</small>
          </button>
        </div>
        <form className="panel form-grid" onSubmit={(event) => { event.preventDefault(); run(() => services.auth.emailAccess(email, name)) }}>
          <div className="panel-heading">
            <div><span>04 / FAKE EMAIL</span><h2>Password-free demo access</h2></div>
            <small>Nothing is sent</small>
          </div>
          <label>Fictional display name (include Demo)<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" /></label>
          <label>Fictional email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="off" aria-describedby="email-help" /></label>
          <small id="email-help">Allowed: example.com, example.test or demo.local only.</small>
          <button className="button" type="submit">Create / sign in — no password</button>
        </form>
      </div>
    </section>
  )
}
