import {
  type AnchorHTMLAttributes,
  type PropsWithChildren,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  ParamsContext,
  readLocation,
  ROUTE_STATE_KEY,
  RouterContext,
  type NavigateOptions,
  useLocation,
  useNavigate,
} from './router-core'

export function HashRouter({ children }: PropsWithChildren) {
  const [location, setLocation] = useState(readLocation)
  useEffect(() => {
    const sync = () => setLocation(readLocation())
    window.addEventListener('hashchange', sync)
    window.addEventListener('popstate', sync)
    return () => {
      window.removeEventListener('hashchange', sync)
      window.removeEventListener('popstate', sync)
    }
  }, [])
  const navigate = useCallback((to: string, options: NavigateOptions = {}) => {
    const method = options.replace ? 'replaceState' : 'pushState'
    window.history[method](
      { ...(window.history.state ?? {}), [ROUTE_STATE_KEY]: options.state ?? null },
      '',
      `#${to.startsWith('/') ? to : `/${to}`}`,
    )
    setLocation(readLocation())
  }, [])
  const value = useMemo(() => ({ location, navigate }), [location, navigate])
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}

export function ParamsProvider({ params, children }: PropsWithChildren<{ params: Record<string, string> }>) {
  return <ParamsContext.Provider value={params}>{children}</ParamsContext.Provider>
}

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string
  replace?: boolean
  state?: unknown
}

export function Link({ to, replace, state, onClick, ...props }: LinkProps) {
  const navigate = useNavigate()
  return (
    <a
      href={`#${to}`}
      {...props}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        navigate(to, { replace, state })
      }}
    />
  )
}

export function NavLink({ to, end = false, className, ...props }: LinkProps & { end?: boolean }) {
  const { pathname } = useLocation()
  const active = end ? pathname === to : pathname === to || pathname.startsWith(`${to}/`)
  const combined = [typeof className === 'string' ? className : '', active ? 'active' : ''].filter(Boolean).join(' ')
  return <Link to={to} {...props} className={combined || undefined} aria-current={active ? 'page' : undefined} />
}

export function Navigate({ to, replace = false, state }: { to: string; replace?: boolean; state?: unknown }) {
  const navigate = useNavigate()
  useEffect(() => navigate(to, { replace, state }), [navigate, replace, state, to])
  return null
}
