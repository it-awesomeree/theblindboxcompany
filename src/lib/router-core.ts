import { createContext, useContext, useMemo } from 'react'

export interface DemoLocation {
  pathname: string
  search: string
  state: unknown
}

export interface NavigateOptions {
  replace?: boolean
  state?: unknown
}

export interface RouterValue {
  location: DemoLocation
  navigate: (to: string, options?: NavigateOptions) => void
}

export const RouterContext = createContext<RouterValue | null>(null)
export const ParamsContext = createContext<Record<string, string>>({})
export const ROUTE_STATE_KEY = 'tbbcRouteState'

export function readLocation(): DemoLocation {
  const raw = window.location.hash.slice(1) || '/'
  const url = new URL(raw, 'https://demo.invalid')
  return {
    pathname: url.pathname || '/',
    search: url.search,
    state: window.history.state?.[ROUTE_STATE_KEY] ?? null,
  }
}

function useRouter() {
  const value = useContext(RouterContext)
  if (!value) throw new Error('Demo router is missing.')
  return value
}

export function useLocation() {
  return useRouter().location
}

export function useNavigate() {
  return useRouter().navigate
}

export function useParams<T extends Record<string, string | undefined> = Record<string, string>>() {
  return useContext(ParamsContext) as T
}

export function useSearchParams() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useMemo(() => new URLSearchParams(location.search), [location.search])
  const setParams = (next: URLSearchParams | Record<string, string>) => {
    const search = next instanceof URLSearchParams ? next : new URLSearchParams(next)
    const suffix = search.toString()
    navigate(`${location.pathname}${suffix ? `?${suffix}` : ''}`)
  }
  return [params, setParams] as const
}
