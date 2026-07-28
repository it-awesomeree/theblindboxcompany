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
  if (['unfulfilled', 'picking', 'packed', 'label_created'].includes(shipment)) return from
  const target: BoxStatus = shipment === 'shipped'
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

export function validateDemoAddress(input: Address): Address {
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
  assert(/^\d{5}$/.test(clean.postcode), 'Postcode must use five demo digits.', 'INVALID_ADDRESS')
  Object.entries(clean).forEach(([key, value]) => assert(value, `${key} is required.`, 'INVALID_ADDRESS'))
  return clean
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
