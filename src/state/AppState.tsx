import {
  type PropsWithChildren,
  useMemo,
  useSyncExternalStore,
} from 'react'
import { AppServices } from '../services/AppServices'
import { AppStateContext } from './AppStateContext'

function browserStorage() {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export function AppStateProvider({ children, providedServices }: PropsWithChildren<{ providedServices?: AppServices }>) {
  const services = useMemo(() => providedServices ?? new AppServices(browserStorage()), [providedServices])
  const state = useSyncExternalStore(
    services.repository.subscribe,
    services.repository.getSnapshot,
    services.repository.getServerSnapshot,
  )
  return <AppStateContext.Provider value={{ state, services }}>{children}</AppStateContext.Provider>
}
