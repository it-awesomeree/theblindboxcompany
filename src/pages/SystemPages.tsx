import { Link } from '../lib/router'
import { useLocation } from '../lib/router-core'

export function UnauthorizedPage() {
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from
  return <section className="route-page"><div className="content narrow"><div className="error-panel"><span className="eyebrow">403 / SERVICE ROLE CHECK</span><h1>Admin access blocked.</h1><p>This is not just hidden navigation. The service rejected the current fictional role{from ? ` for ${from}` : ''}.</p><Link className="button" to="/auth">Choose demo identity</Link></div></div></section>
}

export function NotFoundPage() {
  return <section className="route-page"><div className="content narrow"><div className="error-panel"><span className="eyebrow">404 / RECORD NOT FOUND</span><h1>Nothing is sealed here.</h1><p>The route or fictional record does not exist.</p><Link className="button" to="/">Return to vault</Link></div></div></section>
}
