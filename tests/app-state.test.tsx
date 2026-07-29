import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockRepository, STORAGE_KEY } from '../src/data/MockRepository'
import { AppStateProvider } from '../src/state/AppState'
import { useAppState } from '../src/state/AppStateContext'

const originalLocksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks')

afterEach(() => {
  vi.restoreAllMocks()
  if (originalLocksDescriptor) {
    Object.defineProperty(navigator, 'locks', originalLocksDescriptor)
  } else {
    Reflect.deleteProperty(navigator, 'locks')
  }
  localStorage.clear()
})

interface QueuedLockRequest {
  callback: (lock: Lock) => unknown
  name: string
  options: LockOptions
  reject: (reason?: unknown) => void
  resolve: (value: unknown) => void
  started: boolean
}

class ExclusiveLockQueue {
  private held = false
  private queue: QueuedLockRequest[] = []
  startedCallbacks = 0

  request(
    name: string,
    options: LockOptions,
    callback: (lock: Lock) => unknown,
  ) {
    return new Promise((resolve, reject) => {
      const entry: QueuedLockRequest = {
        callback,
        name,
        options,
        reject,
        resolve,
        started: false,
      }
      const abort = () => {
        if (entry.started) return
        this.queue = this.queue.filter((queued) => queued !== entry)
        reject(new DOMException('The lock request was aborted.', 'AbortError'))
      }
      if (options.signal?.aborted) {
        abort()
        return
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      this.queue.push(entry)
      window.setTimeout(() => this.pump(), 0)
    })
  }

  private pump() {
    if (this.held) return
    const entry = this.queue.shift()
    if (!entry) return
    if (entry.options.signal?.aborted) {
      entry.reject(new DOMException('The lock request was aborted.', 'AbortError'))
      this.pump()
      return
    }
    entry.started = true
    this.startedCallbacks += 1
    this.held = true
    const lock = {
      mode: entry.options.mode ?? 'exclusive',
      name: entry.name,
    } as Lock
    void Promise.resolve(entry.callback(lock))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.held = false
        this.pump()
      })
  }
}

function installLocks(value: LockManager | undefined) {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value,
  })
}

function GateProbe({ label }: { label: string }) {
  const { services, state } = useAppState()
  return (
    <>
      <output aria-label={`${label} state`}>
        {state.revision}:{state.cart[0]?.quantity ?? 0}
      </output>
      <button
        type="button"
        onClick={() => services.orders.setCartQuantity((state.cart[0]?.quantity ?? 0) + 1)}
      >
        {label} write
      </button>
    </>
  )
}

describe('browser AppState write gate', () => {
  it('shows a non-interactive safety screen and does not initialize storage without Web Locks', () => {
    localStorage.clear()
    installLocks(undefined)

    render(
      <StrictMode>
        <AppStateProvider>
          <button type="button">Unsafe commerce action</button>
        </AppStateProvider>
      </StrictMode>,
    )

    expect(screen.getByRole('heading', { name: /demo safety check stopped this tab/i }))
      .toBeVisible()
    expect(screen.getByText(/does not support the Web Lock/i)).toBeVisible()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('shows a non-interactive safety screen when browser storage exists but cannot be read', () => {
    installLocks(new ExclusiveLockQueue() as unknown as LockManager)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage access denied.', 'SecurityError')
    })

    render(
      <StrictMode>
        <AppStateProvider>
          <button type="button">Unsafe commerce action</button>
        </AppStateProvider>
      </StrictMode>,
    )

    expect(screen.getByRole('heading', { name: /demo safety check stopped this tab/i }))
      .toBeVisible()
    expect(screen.getByText(/browser storage is unavailable/i)).toBeVisible()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('keeps an immediate Web Lock rejection visible instead of later calling it waiting', async () => {
    installLocks({
      request: vi.fn(() => Promise.reject(
        new DOMException('Lock permission denied.', 'NotAllowedError'),
      )),
    } as unknown as LockManager)

    render(
      <StrictMode>
        <AppStateProvider>
          <button type="button">Unsafe commerce action</button>
        </AppStateProvider>
      </StrictMode>,
    )

    expect(await screen.findByRole('heading', { name: /demo safety check stopped this tab/i }))
      .toBeVisible()
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 80))
    })
    expect(screen.getByRole('heading', { name: /demo safety check stopped this tab/i }))
      .toBeVisible()
    expect(screen.queryByRole('heading', { name: /safely waiting/i }))
      .not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('aborts a StrictMode provider that unmounts while queued without running its callback', async () => {
    const lockQueue = new ExclusiveLockQueue()
    installLocks(lockQueue as unknown as LockManager)

    const first = render(
      <StrictMode>
        <AppStateProvider>
          <GateProbe label="First" />
        </AppStateProvider>
      </StrictMode>,
    )
    expect(await screen.findByRole('button', { name: 'First write' })).toBeVisible()

    const queued = render(
      <StrictMode>
        <AppStateProvider>
          <GateProbe label="Queued" />
        </AppStateProvider>
      </StrictMode>,
    )
    expect(await screen.findByRole('heading', { name: /safely waiting in read-only mode/i }))
      .toBeVisible()
    expect(lockQueue.startedCallbacks).toBe(1)

    queued.unmount()
    first.unmount()
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    expect(lockQueue.startedCallbacks).toBe(1)
  })

  it('queues a second provider, adopts the exact latest state, then writes without loss', async () => {
    const user = userEvent.setup()
    const lockQueue = new ExclusiveLockQueue()
    installLocks(lockQueue as unknown as LockManager)
    localStorage.clear()

    const first = render(
      <StrictMode>
        <AppStateProvider>
          <GateProbe label="First" />
        </AppStateProvider>
      </StrictMode>,
    )
    expect(await screen.findByRole('button', { name: 'First write' })).toBeVisible()

    render(
      <StrictMode>
        <AppStateProvider>
          <GateProbe label="Second" />
        </AppStateProvider>
      </StrictMode>,
    )
    expect(await screen.findByRole('heading', { name: /safely waiting in read-only mode/i }))
      .toBeVisible()
    expect(screen.queryByRole('button', { name: 'Second write' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'First write' }))
    const beforeHandoff = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(beforeHandoff).toMatchObject({ cart: [{ quantity: 2 }] })

    first.unmount()

    expect(await screen.findByRole('button', { name: 'Second write' })).toBeVisible()
    expect(screen.getByLabelText('Second state'))
      .toHaveTextContent(`${beforeHandoff.revision}:2`)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(beforeHandoff)

    await user.click(screen.getByRole('button', { name: 'Second write' }))
    const afterHandoff = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(afterHandoff).toMatchObject({
      revision: beforeHandoff.revision + 1,
      cart: [{ quantity: 3 }],
    })
    expect({
      ...afterHandoff,
      revision: beforeHandoff.revision,
      cart: beforeHandoff.cart,
    }).toEqual(beforeHandoff)
  })

  it('syncs one valid storage event in both active and waiting providers before handoff', async () => {
    const lockQueue = new ExclusiveLockQueue()
    installLocks(lockQueue as unknown as LockManager)
    const sync = vi.spyOn(MockRepository.prototype, 'syncFromStorage')

    const first = render(
      <StrictMode>
        <AppStateProvider>
          <GateProbe label="Active" />
        </AppStateProvider>
      </StrictMode>,
    )
    expect(await screen.findByRole('button', { name: 'Active write' })).toBeVisible()

    render(
      <StrictMode>
        <AppStateProvider>
          <GateProbe label="Waiting" />
        </AppStateProvider>
      </StrictMode>,
    )
    expect(await screen.findByRole('heading', { name: /safely waiting in read-only mode/i }))
      .toBeVisible()

    const external = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    external.revision += 1
    external.cart[0].quantity = 4
    const raw = JSON.stringify(external)
    sync.mockClear()
    act(() => {
      localStorage.setItem(STORAGE_KEY, raw)
      window.dispatchEvent(new StorageEvent('storage', {
        key: STORAGE_KEY,
        newValue: raw,
        storageArea: localStorage,
      }))
    })

    await waitFor(() => expect(sync).toHaveBeenCalledTimes(2))
    expect(screen.getByLabelText('Active state'))
      .toHaveTextContent(`${external.revision}:4`)
    expect(screen.queryByRole('heading', { name: /demo safety check stopped this tab/i }))
      .not.toBeInTheDocument()

    first.unmount()
    expect(await screen.findByRole('button', { name: 'Waiting write' })).toBeVisible()
    expect(screen.getByLabelText('Waiting state'))
      .toHaveTextContent(`${external.revision}:4`)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
  })

  it.each(['invalid', 'older', 'same-revision divergent'] as const)(
    'shows fail-closed warnings in both active and waiting providers for %s storage',
    async (kind) => {
      const lockQueue = new ExclusiveLockQueue()
      installLocks(lockQueue as unknown as LockManager)

      render(
        <StrictMode>
          <AppStateProvider>
            <GateProbe label="Active" />
          </AppStateProvider>
        </StrictMode>,
      )
      expect(await screen.findByRole('button', { name: 'Active write' })).toBeVisible()

      render(
        <StrictMode>
          <AppStateProvider>
            <GateProbe label="Waiting" />
          </AppStateProvider>
        </StrictMode>,
      )
      expect(await screen.findByRole('heading', { name: /safely waiting in read-only mode/i }))
        .toBeVisible()

      const current = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
      let raw: string
      if (kind === 'invalid') {
        raw = '{invalid-external-json'
      } else {
        const unsafe = structuredClone(current)
        if (kind === 'older') {
          unsafe.revision -= 1
        } else {
          unsafe.cart[0].quantity += 1
        }
        raw = JSON.stringify(unsafe)
      }

      act(() => {
        localStorage.setItem(STORAGE_KEY, raw)
        window.dispatchEvent(new StorageEvent('storage', {
          key: STORAGE_KEY,
          newValue: raw,
          storageArea: localStorage,
        }))
      })

      await waitFor(() => {
        expect(screen.getAllByRole('heading', {
          name: /demo safety check stopped this tab/i,
        })).toHaveLength(2)
      })
      expect(screen.getAllByText(/browser data became invalid, older, or conflicted/i))
        .toHaveLength(2)
      expect(screen.queryByRole('button')).not.toBeInTheDocument()
      expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
    },
  )
})
