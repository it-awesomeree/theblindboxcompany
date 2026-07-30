import {
  type PropsWithChildren,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react'
import { STORAGE_KEY } from '../data/MockRepository'
import { DomainError } from '../domain/guards'
import { AppServices } from '../services/AppServices'
import { AppStateContext } from './AppStateContext'

export const DEMO_WRITE_LOCK_NAME = 'tbbc:demo:exclusive-write-authority:v1'

type GateState =
  | { mode: 'checking' }
  | { mode: 'waiting' }
  | { mode: 'active' }
  | { mode: 'unsupported' | 'unsafe'; message: string }

function browserStorage() {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function browserLocks() {
  try {
    return typeof navigator.locks?.request === 'function'
      ? navigator.locks
      : undefined
  } catch {
    return undefined
  }
}

function ActiveProvider({
  children,
  services,
}: PropsWithChildren<{ services: AppServices }>) {
  const state = useSyncExternalStore(
    services.repository.subscribe,
    services.repository.getSnapshot,
    services.repository.getServerSnapshot,
  )
  return <AppStateContext.Provider value={{ state, services }}>{children}</AppStateContext.Provider>
}

function SafetyScreen({ gate }: { gate: Exclude<GateState, { mode: 'active' }> }) {
  const waiting = gate.mode === 'checking' || gate.mode === 'waiting'
  const title = gate.mode === 'checking'
    ? 'Checking this demo tab'
    : gate.mode === 'waiting'
      ? 'Safely waiting in read-only mode'
      : 'Demo safety check stopped this tab'
  const message = gate.mode === 'checking'
    ? 'The demo is checking that no other tab can change the same browser data.'
    : gate.mode === 'waiting'
      ? 'Another tab is active. This tab has no shop or admin actions and will take over automatically after the active tab closes.'
      : gate.message

  return (
    <main
      className={`browser-safety-screen browser-safety-${waiting ? 'waiting' : 'warning'}`}
      role={waiting ? 'status' : 'alert'}
      aria-live={waiting ? 'polite' : 'assertive'}
    >
      <div>
        <span>{waiting ? 'SINGLE-TAB SAFETY' : 'STORAGE SAFETY WARNING'}</span>
        <h1>{title}</h1>
        <p>{message}</p>
        <small>No real order, payment, account, or message is involved.</small>
      </div>
    </main>
  )
}

function BrowserAppStateProvider({ children }: PropsWithChildren) {
  const [{ services, storage, lockManager, initialGate }] = useState(() => {
    const currentStorage = browserStorage()
    const currentLockManager = browserLocks()
    const currentServices = new AppServices(
      currentStorage,
      undefined,
      { writeAuthority: false },
    )
    const persistentStorage = currentServices.repository.hasPersistentStorage()
      ? currentStorage
      : undefined
    const unavailableGate: GateState = !persistentStorage
      ? {
          mode: 'unsupported',
          message: 'Browser storage is unavailable, so this demo cannot safely save or protect changes. Open it in current Chrome with browser storage enabled.',
        }
      : !currentLockManager
        ? {
            mode: 'unsupported',
            message: 'This browser does not support the Web Lock needed to protect demo changes. Open it in current Chrome and use one tab only.',
          }
        : { mode: 'checking' }
    return {
      storage: persistentStorage,
      lockManager: currentLockManager,
      initialGate: unavailableGate,
      services: currentServices,
    }
  })
  const [gate, setGate] = useState<GateState>(initialGate)

  useEffect(() => {
    if (!storage || !lockManager) return
    let cancelled = false
    let callbackStarted = false
    let releaseLock: (() => void) | undefined
    const abortController = new AbortController()
    queueMicrotask(() => {
      if (!cancelled) setGate({ mode: 'checking' })
    })
    const waitingTimer = window.setTimeout(() => {
      if (!cancelled && !callbackStarted) setGate({ mode: 'waiting' })
    }, 50)
    const release = () => {
      releaseLock?.()
      releaseLock = undefined
    }
    const stopForStorageWarning = (message: string) => {
      window.clearTimeout(waitingTimer)
      services.repository.revokeWriteAuthority()
      if (!cancelled) {
        setGate({
          mode: 'unsafe',
          message: `This tab stopped safely because browser data became invalid, older, or conflicted with the open demo. The unsafe external bytes were not overwritten. Close other demo tabs and reload after checking the stored demo data. Details: ${message}`,
        })
      }
      if (!abortController.signal.aborted) abortController.abort()
      release()
    }
    const syncExternalState = (event: StorageEvent) => {
      if (
        event.storageArea !== storage ||
        (event.key !== STORAGE_KEY && event.key !== null)
      ) return
      try {
        services.repository.syncFromStorage()
      } catch (caught) {
        stopForStorageWarning(
          caught instanceof Error
            ? caught.message
            : 'The external browser data could not be checked safely.',
        )
      }
    }
    window.addEventListener('storage', syncExternalState)

    const runWithLock = async () => {
      callbackStarted = true
      window.clearTimeout(waitingTimer)
      if (cancelled || abortController.signal.aborted) return

      try {
        services.repository.grantWriteAuthority()
        if (cancelled || abortController.signal.aborted) {
          services.repository.revokeWriteAuthority()
          return
        }
        try {
          services.orders.expireReservations()
        } catch (caught) {
          if (
            !(caught instanceof DomainError) ||
            caught.code !== 'CONFIRMED_RESET_REQUIRED'
          ) {
            throw caught
          }
        }

        setGate({ mode: 'active' })

        await new Promise<void>((resolve) => {
          releaseLock = resolve
          if (cancelled || abortController.signal.aborted) resolve()
        })
      } catch (caught) {
        services.repository.revokeWriteAuthority()
        if (!cancelled && !abortController.signal.aborted) {
          setGate({
            mode: 'unsafe',
            message: `This tab could not finish its protected startup checks, so no shop or admin actions were opened. ${caught instanceof Error ? caught.message : 'Reload in one Chrome tab and try again.'}`,
          })
        }
      } finally {
        services.repository.revokeWriteAuthority()
      }
    }
    const stopForLockFailure = (caught: unknown) => {
      window.clearTimeout(waitingTimer)
      if (cancelled || abortController.signal.aborted) return
      services.repository.revokeWriteAuthority()
      setGate({
        mode: 'unsafe',
        message: `Chrome could not protect this demo tab, so no shop or admin actions were opened. ${caught instanceof Error ? caught.message : 'Reload in one tab and try again.'}`,
      })
    }
    let request: Promise<unknown> | undefined
    try {
      request = lockManager.request(
        DEMO_WRITE_LOCK_NAME,
        { mode: 'exclusive', signal: abortController.signal },
        runWithLock,
      )
    } catch (caught) {
      stopForLockFailure(caught)
    }
    void request?.catch(stopForLockFailure)

    return () => {
      cancelled = true
      window.clearTimeout(waitingTimer)
      window.removeEventListener('storage', syncExternalState)
      services.repository.revokeWriteAuthority()
      if (!abortController.signal.aborted) abortController.abort()
      release()
    }
  }, [lockManager, services, storage])

  if (gate.mode !== 'active') return <SafetyScreen gate={gate} />
  return <ActiveProvider services={services}>{children}</ActiveProvider>
}

export function AppStateProvider({
  children,
  providedServices,
}: PropsWithChildren<{ providedServices?: AppServices }>) {
  if (providedServices) {
    return <ActiveProvider services={providedServices}>{children}</ActiveProvider>
  }
  return <BrowserAppStateProvider>{children}</BrowserAppStateProvider>
}
