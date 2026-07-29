import {
  type PropsWithChildren,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react'
import { STORAGE_KEY } from '../data/MockRepository'
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
  useEffect(() => {
    const storage = browserStorage()
    if (!storage) return
    const sync = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || event.storageArea !== storage) return
      try {
        services.repository.syncFromStorage()
      } catch {
        // Invalid, older, or unreadable external data is deliberately not adopted.
      }
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [services])
  const state = useSyncExternalStore(
    services.repository.subscribe,
    services.repository.getSnapshot,
    services.repository.getServerSnapshot,
  )
  return <AppStateContext.Provider value={{ state, services }}>{children}</AppStateContext.Provider>
}
