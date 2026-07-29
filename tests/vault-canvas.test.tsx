import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VaultCanvas } from '../src/components/VaultCanvas'

type Visibility = DocumentVisibilityState

interface NavigatorRenderHints {
  deviceMemory?: number
  connection?: {
    saveData?: boolean
  }
}

const originalHistoryState = window.history.state
const originalUrl = window.location.href

const originalDescriptors = {
  devicePixelRatio: Object.getOwnPropertyDescriptor(window, 'devicePixelRatio'),
  innerWidth: Object.getOwnPropertyDescriptor(window, 'innerWidth'),
  visibilityState: Object.getOwnPropertyDescriptor(document, 'visibilityState'),
  hardwareConcurrency: Object.getOwnPropertyDescriptor(navigator, 'hardwareConcurrency'),
  deviceMemory: Object.getOwnPropertyDescriptor(navigator, 'deviceMemory'),
  connection: Object.getOwnPropertyDescriptor(navigator, 'connection'),
  matchMedia: Object.getOwnPropertyDescriptor(window, 'matchMedia'),
  requestAnimationFrame: Object.getOwnPropertyDescriptor(window, 'requestAnimationFrame'),
  cancelAnimationFrame: Object.getOwnPropertyDescriptor(window, 'cancelAnimationFrame'),
  intersectionObserver: Object.getOwnPropertyDescriptor(window, 'IntersectionObserver'),
  clientWidth: Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'clientWidth'),
  clientHeight: Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'clientHeight'),
}

function restoreProperty(
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor)
  } else {
    Reflect.deleteProperty(target, property)
  }
}

let visibilityState: Visibility
let rafCallbacks: Map<number, FrameRequestCallback>
let nextFrameId: number
let requestAnimationFrameMock: ReturnType<typeof vi.fn>
let cancelAnimationFrameMock: ReturnType<typeof vi.fn>
let observerInstances: IntersectionObserverMock[]

class IntersectionObserverMock {
  readonly root = null
  readonly rootMargin = ''
  readonly thresholds = [0.02]
  readonly disconnect = vi.fn()
  readonly observe = vi.fn()
  readonly takeRecords = vi.fn(() => [])
  readonly unobserve = vi.fn()

  constructor(
    private readonly callback: IntersectionObserverCallback,
  ) {
    observerInstances.push(this)
  }

  trigger(isIntersecting: boolean) {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

function setEnvironment({
  reducedMotion = false,
  coarsePointer = false,
  saveData = false,
  width = 1440,
  dpr = 1,
  cores = 8,
  memory = 8,
}: {
  reducedMotion?: boolean
  coarsePointer?: boolean
  saveData?: boolean
  width?: number
  dpr?: number
  cores?: number
  memory?: number
} = {}) {
  window.matchMedia = vi.fn((query: string): MediaQueryList => ({
    matches: (
      (query === '(prefers-reduced-motion: reduce)' && reducedMotion)
      || (query === '(pointer: coarse)' && coarsePointer)
    ),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }))
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: dpr })
  Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: cores })
  Object.defineProperty(navigator as Navigator & NavigatorRenderHints, 'deviceMemory', {
    configurable: true,
    value: memory,
  })
  Object.defineProperty(navigator as Navigator & NavigatorRenderHints, 'connection', {
    configurable: true,
    value: { saveData },
  })
}

function setVisibility(next: Visibility) {
  visibilityState = next
  document.dispatchEvent(new Event('visibilitychange'))
}

function flushNextFrame(time: number) {
  const next = [...rafCallbacks.entries()][0]
  if (!next) throw new Error('Expected a pending animation frame')
  const [id, callback] = next
  rafCallbacks.delete(id)
  act(() => callback(time))
}

function makeWebGl() {
  const shaders = [{ kind: 'vertex' }, { kind: 'fragment' }]
  const program = { kind: 'program' }
  const buffer = { kind: 'buffer' }
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TRIANGLES: 8,
    createShader: vi.fn()
      .mockReturnValueOnce(shaders[0])
      .mockReturnValueOnce(shaders[1]),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    createProgram: vi.fn(() => program),
    attachShader: vi.fn(),
    detachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    useProgram: vi.fn(),
    createBuffer: vi.fn(() => buffer),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    getUniformLocation: vi.fn(() => ({})),
    viewport: vi.fn(),
    uniform2f: vi.fn(),
    uniform1f: vi.fn(),
    drawArrays: vi.fn(),
    deleteBuffer: vi.fn(),
    deleteProgram: vi.fn(),
    deleteShader: vi.fn(),
  }
  return { gl, shaders, program, buffer }
}

function renderWithWebGl(props: ComponentProps<typeof VaultCanvas> = {}) {
  const webgl = makeWebGl()
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(webgl.gl as unknown as WebGLRenderingContext)
  const view = render(<VaultCanvas {...props} />)
  const canvas = view.container.querySelector('canvas')!
  return { ...webgl, getContext, view, canvas }
}

beforeEach(() => {
  window.history.replaceState({}, '', '/#/')
  visibilityState = 'visible'
  rafCallbacks = new Map()
  nextFrameId = 1
  observerInstances = []
  requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrameId
    nextFrameId += 1
    rafCallbacks.set(id, callback)
    return id
  })
  cancelAnimationFrameMock = vi.fn((id: number) => {
    rafCallbacks.delete(id)
  })
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  })
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: requestAnimationFrameMock,
  })
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: cancelAnimationFrameMock,
  })
  window.IntersectionObserver = IntersectionObserverMock as unknown as typeof IntersectionObserver
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 200,
  })
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 100,
  })
  setEnvironment()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState(originalHistoryState, '', originalUrl)
  restoreProperty(window, 'devicePixelRatio', originalDescriptors.devicePixelRatio)
  restoreProperty(window, 'innerWidth', originalDescriptors.innerWidth)
  restoreProperty(document, 'visibilityState', originalDescriptors.visibilityState)
  restoreProperty(navigator, 'hardwareConcurrency', originalDescriptors.hardwareConcurrency)
  restoreProperty(navigator, 'deviceMemory', originalDescriptors.deviceMemory)
  restoreProperty(navigator, 'connection', originalDescriptors.connection)
  restoreProperty(window, 'matchMedia', originalDescriptors.matchMedia)
  restoreProperty(window, 'requestAnimationFrame', originalDescriptors.requestAnimationFrame)
  restoreProperty(window, 'cancelAnimationFrame', originalDescriptors.cancelAnimationFrame)
  restoreProperty(window, 'IntersectionObserver', originalDescriptors.intersectionObserver)
  restoreProperty(HTMLCanvasElement.prototype, 'clientWidth', originalDescriptors.clientWidth)
  restoreProperty(HTMLCanvasElement.prototype, 'clientHeight', originalDescriptors.clientHeight)
})

describe('VaultCanvas adaptive rendering', () => {
  it.each([
    ['static', {
      reducedMotion: true,
      coarsePointer: true,
      saveData: true,
      width: 1440,
      dpr: 1,
      cores: 8,
      memory: 8,
    }],
    ['balanced', { width: 700, dpr: 1, cores: 8, memory: 8 }],
    ['balanced', { width: 1440, dpr: 1, cores: 4, memory: 8 }],
    ['balanced', { width: 1440, dpr: 1, cores: 8, memory: 4 }],
    ['balanced', { width: 1440, dpr: 3, cores: 8, memory: 8 }],
    ['full', { width: 1440, dpr: 2, cores: 8, memory: 8 }],
  ])('selects the %s profile deterministically', (expected, environment) => {
    setEnvironment(environment)
    const { canvas } = renderWithWebGl()
    expect(canvas).toHaveAttribute('data-render-profile', expected)
  })

  it('selects balanced for a coarse pointer on an otherwise healthy desktop', () => {
    setEnvironment({ coarsePointer: true })
    const { canvas } = renderWithWebGl()
    expect(canvas).toHaveAttribute('data-render-profile', 'balanced')
  })

  it('selects balanced for save-data mode on an otherwise healthy desktop', () => {
    setEnvironment({ saveData: true })
    const { canvas } = renderWithWebGl()
    expect(canvas).toHaveAttribute('data-render-profile', 'balanced')
  })

  it.each([
    ['full', { width: 1440, dpr: 2, cores: 8, memory: 8 }, 300, 'high-performance'],
    ['balanced', { width: 700, dpr: 2, cores: 8, memory: 8 }, 200, 'low-power'],
    ['static', { reducedMotion: true, dpr: 3, cores: 8, memory: 8 }, 200, 'low-power'],
  ])('caps %s resolution and requests the matching GPU preference', (
    expected,
    environment,
    expectedWidth,
    powerPreference,
  ) => {
    setEnvironment(environment)
    const { canvas, getContext } = renderWithWebGl()

    expect(canvas).toHaveAttribute('data-render-profile', expected)
    expect(canvas.width).toBe(expectedWidth)
    expect(getContext).toHaveBeenCalledWith('webgl', expect.objectContaining({ powerPreference }))
  })

  it('never starts a reduced-motion loop and renders one deterministic setOpen and resize update', () => {
    setEnvironment({ reducedMotion: true, dpr: 2 })
    const { gl, view } = renderWithWebGl()
    expect(gl.drawArrays).toHaveBeenCalledTimes(1)
    expect(requestAnimationFrameMock).not.toHaveBeenCalled()

    view.rerender(<VaultCanvas openSignal={1} holdOpen />)
    expect(gl.drawArrays).toHaveBeenCalledTimes(2)
    expect(gl.uniform1f).toHaveBeenCalledWith(expect.anything(), 0)
    expect(requestAnimationFrameMock).not.toHaveBeenCalled()

    fireEvent(window, new Event('resize'))
    expect(gl.drawArrays).toHaveBeenCalledTimes(3)
    expect(requestAnimationFrameMock).not.toHaveBeenCalled()
  })

  it('keeps one balanced callback active while drawing at about 30fps', () => {
    setEnvironment({ width: 700 })
    const { gl } = renderWithWebGl()
    expect(gl.drawArrays).toHaveBeenCalledTimes(1)
    expect(rafCallbacks.size).toBe(1)

    flushNextFrame(16)
    expect(gl.drawArrays).toHaveBeenCalledTimes(1)
    expect(rafCallbacks.size).toBe(1)

    flushNextFrame(34)
    expect(gl.drawArrays).toHaveBeenCalledTimes(2)
    expect(rafCallbacks.size).toBe(1)

    flushNextFrame(50)
    expect(gl.drawArrays).toHaveBeenCalledTimes(2)
    expect(rafCallbacks.size).toBe(1)
  })

  it('draws setup once but does not schedule while initially hidden', () => {
    visibilityState = 'hidden'
    const { gl } = renderWithWebGl()

    expect(gl.drawArrays).toHaveBeenCalledTimes(1)
    expect(requestAnimationFrameMock).not.toHaveBeenCalled()
    expect(rafCallbacks.size).toBe(0)

    act(() => setVisibility('visible'))
    act(() => setVisibility('visible'))

    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1)
    expect(rafCallbacks.size).toBe(1)
  })

  it('cancels while hidden or offscreen and resumes with exactly one frame', () => {
    const { gl } = renderWithWebGl()
    const observer = observerInstances[0]
    expect(rafCallbacks.size).toBe(1)

    act(() => setVisibility('hidden'))
    expect(rafCallbacks.size).toBe(0)
    expect(cancelAnimationFrameMock).toHaveBeenCalledTimes(1)
    const drawsBeforeHidden = gl.drawArrays.mock.calls.length

    act(() => observer.trigger(false))
    act(() => observer.trigger(true))
    expect(rafCallbacks.size).toBe(0)

    act(() => setVisibility('visible'))
    act(() => setVisibility('visible'))
    expect(rafCallbacks.size).toBe(1)
    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(2)

    act(() => observer.trigger(false))
    expect(rafCallbacks.size).toBe(0)
    expect(cancelAnimationFrameMock).toHaveBeenCalledTimes(2)

    act(() => observer.trigger(true))
    act(() => observer.trigger(true))
    expect(rafCallbacks.size).toBe(1)
    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(3)
    expect(gl.drawArrays).toHaveBeenCalledTimes(drawsBeforeHidden)
  })

  it('cancels and disconnects on cleanup and releases each GL resource exactly once', () => {
    const { gl, shaders, program, buffer, view } = renderWithWebGl()
    const observer = observerInstances[0]
    expect(rafCallbacks.size).toBe(1)

    view.unmount()

    expect(rafCallbacks.size).toBe(0)
    expect(cancelAnimationFrameMock).toHaveBeenCalledTimes(1)
    expect(observer.disconnect).toHaveBeenCalledTimes(1)
    expect(gl.detachShader).toHaveBeenCalledTimes(2)
    expect(gl.detachShader).toHaveBeenCalledWith(program, shaders[0])
    expect(gl.detachShader).toHaveBeenCalledWith(program, shaders[1])
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1)
    expect(gl.deleteBuffer).toHaveBeenCalledWith(buffer)
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1)
    expect(gl.deleteProgram).toHaveBeenCalledWith(program)
    expect(gl.deleteShader).toHaveBeenCalledTimes(2)
  })

  it('stops and releases once on context loss while preserving fallback keyboard activation', () => {
    const activate = vi.fn()
    const { canvas, gl, view } = renderWithWebGl({
      onActivate: activate,
      label: 'Activate fallback vault',
    })
    const lost = new Event('webglcontextlost', { cancelable: true })

    fireEvent(canvas, lost)

    const fallback = screen.getByTestId('webgl-fallback')
    expect(lost.defaultPrevented).toBe(true)
    expect(rafCallbacks.size).toBe(0)
    expect(fallback).toBeVisible()
    expect(fallback).toHaveAttribute('role', 'button')
    expect(fallback).toHaveAttribute('aria-label', 'Activate fallback vault')
    fireEvent.keyDown(fallback, { key: 'Enter' })
    expect(activate).toHaveBeenCalledTimes(1)

    const drawsAfterLoss = gl.drawArrays.mock.calls.length
    view.rerender(
      <VaultCanvas
        onActivate={activate}
        label="Activate fallback vault"
        openSignal={1}
        holdOpen
      />,
    )
    fireEvent(window, new Event('resize'))
    expect(gl.drawArrays).toHaveBeenCalledTimes(drawsAfterLoss)

    view.unmount()
    expect(gl.deleteBuffer).toHaveBeenCalledTimes(1)
    expect(gl.deleteProgram).toHaveBeenCalledTimes(1)
    expect(gl.deleteShader).toHaveBeenCalledTimes(2)
  })
})
