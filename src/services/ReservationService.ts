import { RESERVATION_MINUTES } from '../domain/constants'
import {
  assert,
  canTransitionPayment,
  makeId,
  transitionBox,
  transitionPayment,
} from '../domain/guards'
import type { Box, DemoState, Order, Role } from '../domain/types'
import { AuditService } from './AuditService'

interface ReservationActor {
  id: string
  role: Role
}

export class ReservationService {
  constructor(private readonly audit: AuditService) {}

  private boxesFor(state: DemoState, order: Order) {
    const boxes = order.boxIds.map((id) => state.boxes.find((box) => box.id === id))
    assert(boxes.every(Boolean), 'One or more reserved boxes are missing.', 'BOX_MISSING')
    return boxes as Box[]
  }

  isActive(state: DemoState, order: Order) {
    const boxes = this.boxesFor(state, order)
    return boxes.length === order.snapshot.quantity && boxes.every((box) => box.status === 'reserved' && !box.prizeId)
  }

  dueOrders(state: DemoState, at: string) {
    const timestamp = Date.parse(at)
    assert(Number.isFinite(timestamp), 'Reservation clock must be a valid ISO time.', 'INVALID_TIME')
    return state.orders.filter((order) => {
      if (order.status !== 'pending_payment' || !this.isActive(state, order)) return false
      const deadline = Date.parse(order.reservationExpiresAt)
      return Number.isFinite(deadline) && deadline <= timestamp
    })
  }

  release(
    state: DemoState,
    order: Order,
    at: string,
    requestId: string,
    reason: string,
    actor: ReservationActor,
  ) {
    const boxes = this.boxesFor(state, order)
    const active = boxes.filter((box) => box.status === 'reserved' && !box.prizeId)
    if (active.length === 0) return 0
    assert(active.length === order.snapshot.quantity, 'Reservation box count is inconsistent.', 'RESERVATION_DRIFT')
    const series = state.series.find((entry) => entry.id === order.snapshot.seriesId)
    assert(series, 'Reservation series is missing.', 'SERIES_MISSING')
    assert(series.reservedBoxes >= active.length, 'Reserved stock counter is inconsistent.', 'RESERVATION_DRIFT')
    active.forEach((box) => {
      box.status = transitionBox(box.status, 'void')
    })
    series.reservedBoxes -= active.length
    order.updatedAt = at
    order.timeline.push({
      id: makeId('tl', `${order.id}:reservation-release:${requestId}`),
      status: 'pending_payment',
      label: reason,
      at,
    })
    this.audit.append(state, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'order.reservation_released',
      targetType: 'order',
      targetId: order.id,
      reason,
      at,
      requestId,
      before: { reservedBoxes: active.length, reservationExpiresAt: order.reservationExpiresAt },
      after: { reservedBoxes: 0, boxStatus: 'void' },
    })
    return active.length
  }

  renew(state: DemoState, order: Order, at: string, requestId: string, actor: ReservationActor) {
    if (this.isActive(state, order)) return false
    const boxes = this.boxesFor(state, order)
    assert(boxes.every((box) => box.status === 'void' && !box.prizeId), 'Only a released unpaid reservation can be renewed.', 'RESERVATION_NOT_RENEWABLE')
    const series = state.series.find((entry) => entry.id === order.snapshot.seriesId)
    assert(series, 'Reservation series is missing.', 'SERIES_MISSING')
    const assigned = series.inventory.reduce((sum, counter) => sum + counter.assigned, 0)
    assert(series.allocationTotal - assigned - series.reservedBoxes >= boxes.length, 'The reservation cannot be renewed.', 'SOLD_OUT')
    boxes.forEach((box) => {
      box.status = transitionBox(box.status, 'reserved')
    })
    series.reservedBoxes += boxes.length
    order.reservationExpiresAt = new Date(Date.parse(at) + RESERVATION_MINUTES * 60_000).toISOString()
    order.updatedAt = at
    order.timeline.push({
      id: makeId('tl', `${order.id}:reservation-renew:${requestId}`),
      status: 'pending_payment',
      label: 'Unpaid stock reservation renewed for a new payment attempt',
      at,
    })
    this.audit.append(state, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'order.reservation_renewed',
      targetType: 'order',
      targetId: order.id,
      reason: 'A new guarded payment attempt renewed released demo stock',
      at,
      requestId,
      before: { reservedBoxes: 0 },
      after: { reservedBoxes: boxes.length, reservationExpiresAt: order.reservationExpiresAt },
    })
    return true
  }

  expireDue(state: DemoState, at: string) {
    const expired = this.dueOrders(state, at)
    for (const order of expired) {
      const requestId = makeId('req', `${order.id}:reservation-expired:${order.reservationExpiresAt}`)
      for (const paymentId of order.paymentIds) {
        const payment = state.payments.find((entry) => entry.id === paymentId)
        if (!payment || !canTransitionPayment(payment.status, 'expired')) continue
        const before = payment.status
        payment.status = transitionPayment(payment.status, 'expired')
        payment.updatedAt = at
        const eventId = makeId('evt', `${payment.id}:${requestId}`)
        payment.events.push({
          id: eventId,
          requestId,
          type: 'expired',
          source: 'reservation_clock',
          createdAt: at,
          processedAt: at,
        })
        this.audit.append(state, {
          actorId: 'demo-reservation-clock',
          actorRole: 'finance',
          action: 'payment.expired',
          targetType: 'payment',
          targetId: payment.id,
          reason: 'Server-like reservation deadline reached',
          at,
          requestId,
          eventId,
          before: { status: before },
          after: { status: payment.status },
        })
      }
      this.release(
        state,
        order,
        at,
        requestId,
        'Unpaid reservation expired at its stored server-like deadline',
        { id: 'demo-reservation-clock', role: 'finance' },
      )
    }
    return expired
  }
}
