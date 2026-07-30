import {
  ADMIN_ROLES,
  BOX_TRANSITIONS,
  ORDER_TRANSITIONS,
  PAYMENT_TRANSITIONS,
  SHIPMENT_TRANSITIONS,
} from './constants'
import type {
  Address,
  BoxStatus,
  DemoState,
  OrderStatus,
  PaymentStatus,
  Role,
  FulfilmentKind,
  ShipmentStatus,
  User,
} from './types'

export class DomainError extends Error {
  constructor(message: string, public readonly code = 'DOMAIN_ERROR') {
    super(message)
    this.name = 'DomainError'
  }
}

export function assert(condition: unknown, message: string, code?: string): asserts condition {
  if (!condition) throw new DomainError(message, code)
}

export function assertRole(user: User | undefined, allowed: Role[], action: string): asserts user is User {
  assert(user, 'Sign in is required.', 'AUTH_REQUIRED')
  assert(user.status === 'active', 'This demo user is suspended.', 'USER_SUSPENDED')
  assert(allowed.includes(user.role), `${user.role} cannot ${action}.`, 'FORBIDDEN')
}

export function assertAdmin(user: User | undefined, action = 'open admin tools'): asserts user is User {
  assertRole(user, ADMIN_ROLES, action)
}

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus) {
  return PAYMENT_TRANSITIONS[from].includes(to)
}

export function canTransitionOrder(from: OrderStatus, to: OrderStatus) {
  return ORDER_TRANSITIONS[from].includes(to)
}

export function canTransitionShipment(from: ShipmentStatus, to: ShipmentStatus) {
  return SHIPMENT_TRANSITIONS[from].includes(to)
}

export function canTransitionShipmentForKind(
  kind: FulfilmentKind,
  from: ShipmentStatus,
  to: ShipmentStatus,
) {
  if (kind === 'DIGITAL') {
    return (
      (from === 'unfulfilled' && (to === 'issued' || to === 'cancelled')) ||
      (from === 'issued' && (to === 'sent' || to === 'cancelled')) ||
      (from === 'sent' && (to === 'delivered' || to === 'failed')) ||
      (from === 'cancelled' && to === 'unfulfilled')
    )
  }
  return (
    (from === 'unfulfilled' && (to === 'picking' || to === 'cancelled')) ||
    (from === 'picking' && (to === 'packed' || to === 'cancelled')) ||
    (from === 'packed' && (to === 'label_created' || to === 'cancelled')) ||
    (from === 'label_created' && (to === 'shipped' || to === 'cancelled')) ||
    (from === 'shipped' && ['delivered', 'failed_delivery', 'lost', 'returned'].includes(to)) ||
    (from === 'delivered' && to === 'returned') ||
    (from === 'failed_delivery' && ['returned', 'lost'].includes(to)) ||
    (from === 'cancelled' && to === 'unfulfilled')
  )
}

export function canTransitionBox(from: BoxStatus, to: BoxStatus) {
  return BOX_TRANSITIONS[from].includes(to)
}

export function transitionPayment(from: PaymentStatus, to: PaymentStatus) {
  assert(canTransitionPayment(from, to), `Payment cannot move from ${from} to ${to}.`, 'INVALID_TRANSITION')
  return to
}

export function transitionOrder(from: OrderStatus, to: OrderStatus) {
  assert(canTransitionOrder(from, to), `Order cannot move from ${from} to ${to}.`, 'INVALID_TRANSITION')
  return to
}

export function transitionShipment(from: ShipmentStatus, to: ShipmentStatus) {
  assert(canTransitionShipment(from, to), `Shipment cannot move from ${from} to ${to}.`, 'INVALID_TRANSITION')
  return to
}

export function transitionShipmentForKind(
  kind: FulfilmentKind,
  from: ShipmentStatus,
  to: ShipmentStatus,
) {
  assert(
    canTransitionShipmentForKind(kind, from, to),
    `${kind} shipment cannot move from ${from} to ${to}.`,
    'INVALID_TRANSITION',
  )
  return to
}

export function transitionBox(from: BoxStatus, to: BoxStatus) {
  assert(canTransitionBox(from, to), `Box cannot move from ${from} to ${to}.`, 'INVALID_TRANSITION')
  return to
}

export function transitionBoxForReveal(from: BoxStatus) {
  assert(
    ['paid_unopened', 'opened', 'fulfillment_pending', 'fulfilled'].includes(from),
    `A box in ${from} cannot be revealed.`,
    'INVALID_BOX_STATE',
  )
  return from === 'paid_unopened' ? transitionBox(from, 'opened') : from
}

export function transitionBoxForShipment(from: BoxStatus, shipment: ShipmentStatus) {
  if (['unfulfilled', 'picking', 'packed', 'label_created', 'issued'].includes(shipment)) return from
  const target: BoxStatus = ['shipped', 'sent'].includes(shipment)
    ? 'fulfillment_pending'
    : shipment === 'delivered'
      ? 'fulfilled'
      : 'on_hold'
  return from === target ? from : transitionBox(from, target)
}

export function sanitizeText(value: string, max = 180) {
  return value.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export const CHECKOUT_REQUEST_ID_PATTERN = /^checkout_[a-f0-9]{32}$/
export const DEMO_TRACKING_PATTERN = /^DEMO-[A-Z0-9][A-Z0-9-]{2,42}$/

export function isClearlyFictionalCarrier(value: unknown) {
  return typeof value === 'string' &&
    value === sanitizeText(value, 70) &&
    value.length >= 3 &&
    /demo|digital vault|vault counter/i.test(value)
}

export function isValidDemoTracking(value: unknown) {
  return typeof value === 'string' &&
    value === sanitizeText(value, 48).toUpperCase() &&
    DEMO_TRACKING_PATTERN.test(value)
}

export function validateCheckoutRequestId(value: unknown) {
  assert(
    typeof value === 'string' && CHECKOUT_REQUEST_ID_PATTERN.test(value),
    'Checkout request identity is invalid.',
    'INVALID_CHECKOUT_REQUEST_ID',
  )
  return value
}

export function createCheckoutRequestId() {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return `checkout_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function validateDemoEmail(value: string) {
  const email = sanitizeText(value.toLowerCase(), 120)
  assert(
    /^[a-z0-9._%+-]+@(example\.com|example\.test|demo\.local)$/.test(email),
    'Use a fictional email ending in example.com, example.test, or demo.local.',
    'DEMO_DATA_ONLY',
  )
  return email
}

export function validateDemoUserName(value: string) {
  const name = sanitizeText(value, 70)
  assert(name.length >= 2, 'A fictional display name is required.', 'INVALID_NAME')
  assert(
    /\b(demo|admin|support|fulfilment|finance|catalog)\b/i.test(name),
    'Use an obviously fictional display name containing Demo or a demo staff role.',
    'DEMO_DATA_ONLY',
  )
  assert(
    !/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(name),
    'Do not use an email address as a fictional display name.',
    'DEMO_DATA_ONLY',
  )
  const phoneLike = name.match(/\+?\d[\d\s().-]{6,}\d/g) ?? []
  assert(
    phoneLike.every((candidate) => candidate.replace(/\D/g, '').length < 8),
    'Do not use a realistic phone number as a fictional display name.',
    'DEMO_DATA_ONLY',
  )
  return name
}

export function validateDemoAddress(input: Address): Address {
  assert(input?.country === 'MY', 'Demo addresses must use Malaysia.', 'INVALID_ADDRESS')
  const clean: Address = {
    recipient: sanitizeText(input.recipient, 70),
    line1: sanitizeText(input.line1, 100),
    line2: sanitizeText(input.line2, 100),
    postcode: sanitizeText(input.postcode, 5),
    city: sanitizeText(input.city, 50),
    state: sanitizeText(input.state, 50),
    phone: sanitizeText(input.phone, 30),
    country: 'MY',
  }
  assert(
    clean.line1.toUpperCase().includes('DEMO') && clean.phone.toLowerCase().includes('demo'),
    'For safety, the fake street must contain DEMO and the fake phone must contain demo.',
    'DEMO_DATA_ONLY',
  )
  assert(
    validateDemoUserName(clean.recipient) === clean.recipient,
    'Address recipient must remain an obviously fictional display name.',
    'DEMO_DATA_ONLY',
  )
  assert(/^\d{5}$/.test(clean.postcode), 'Postcode must use five demo digits.', 'INVALID_ADDRESS')
  Object.entries(clean).forEach(([key, value]) => assert(value, `${key} is required.`, 'INVALID_ADDRESS'))
  assert(
    !Object.values(clean).some((value) => /[<>]/.test(value)),
    'Demo address text contains unsafe characters.',
    'INVALID_ADDRESS',
  )
  return clean
}

export function validateDemoClaimNote(value: string) {
  const note = sanitizeText(value, 500)
  assert(note.length >= 8, 'Add a short fictional note (at least 8 characters).', 'INVALID_NOTE')
  assert(/\bDEMO\b/i.test(note), 'Customer claim notes must include the separate word DEMO.', 'DEMO_DATA_ONLY')
  assert(
    !/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(note),
    'Do not enter an email address in a demo claim note.',
    'DEMO_DATA_ONLY',
  )
  const phoneLike = note.match(/\+?\d[\d\s().-]{6,}\d/g) ?? []
  assert(
    phoneLike.every((candidate) => candidate.replace(/\D/g, '').length < 8),
    'Do not enter a realistic phone number in a demo claim note.',
    'DEMO_DATA_ONLY',
  )
  return note
}

export function getSessionUser(state: DemoState) {
  return state.users.find((user) => user.id === state.sessionUserId)
}

export function cloneState(state: DemoState): DemoState {
  return structuredClone(state)
}

export function stableHash(input: string) {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function makeId(prefix: string, seed: string) {
  return `${prefix}-${stableHash(seed).toString(36).padStart(7, '0')}`
}

export function isoNow() {
  return new Date().toISOString()
}
