import {
  assert,
  makeId,
  transitionBox,
  transitionOrder,
  transitionShipmentForKind,
} from '../domain/guards'
import type { DemoState, Order, OrderStatus, Role, ShipmentStatus } from '../domain/types'
import {
  refreshOrderFulfillment,
  resolveOrderFulfillment,
} from '../domain/orderFulfillment'
import { AuditService } from './AuditService'

const PHYSICAL_UNSHIPPED: ShipmentStatus[] = [
  'unfulfilled',
  'picking',
  'packed',
  'label_created',
]
const DIGITAL_UNSENT: ShipmentStatus[] = ['unfulfilled', 'issued']

interface FinancialActor {
  id: string
  role: Role
}

export class FinancialSafetyService {
  constructor(private readonly audit: AuditService) {}

  stop(
    state: DemoState,
    order: Order,
    status: Extract<OrderStatus, 'cancelled' | 'refunded' | 'disputed'>,
    at: string,
    reason: string,
    requestId: string,
    actor: FinancialActor,
  ) {
    const before = {
      orderStatus: order.status,
      shipments: state.shipments
        .filter((shipment) => shipment.orderId === order.id)
        .map((shipment) => ({ id: shipment.id, status: shipment.status })),
    }
    for (const shipment of state.shipments.filter((entry) => entry.orderId === order.id)) {
      const stoppable = shipment.kind === 'DIGITAL'
        ? DIGITAL_UNSENT.includes(shipment.status)
        : PHYSICAL_UNSHIPPED.includes(shipment.status)
      if (!stoppable) continue
      shipment.status = transitionShipmentForKind(
        shipment.kind,
        shipment.status,
        'cancelled',
      )
      shipment.timeline.push({
        id: makeId('stl', `${shipment.id}:financial-stop:${requestId}`),
        status: 'cancelled',
        label: reason,
        at,
        financialHold: status,
      })
    }
    for (const boxId of order.boxIds) {
      const box = state.boxes.find((entry) => entry.id === boxId)
      if (!box?.prizeId || box.revealedAt || box.status === 'on_hold') continue
      box.status = transitionBox(box.status, 'on_hold')
    }
    if (order.status !== status) order.status = transitionOrder(order.status, status)
    order.updatedAt = at
    order.timeline.push({
      id: makeId('tl', `${order.id}:financial-stop:${requestId}`),
      status,
      label: reason,
      at,
      financialHoldPreviousStatus: before.orderStatus,
    })
    this.audit.append(state, {
      actorId: actor.id,
      actorRole: actor.role,
      action: `order.financial_hold_${status}`,
      targetType: 'order',
      targetId: order.id,
      reason,
      at,
      requestId,
      before,
      after: {
        orderStatus: order.status,
        stoppedShipmentIds: state.shipments
          .filter((shipment) => shipment.orderId === order.id && shipment.status === 'cancelled')
          .map((shipment) => shipment.id),
        heldBoxIds: state.boxes
          .filter((box) => order.boxIds.includes(box.id) && box.status === 'on_hold')
          .map((box) => box.id),
      },
    })
  }

  resumeDispute(
    state: DemoState,
    order: Order,
    at: string,
    reason: string,
    requestId: string,
    actor: FinancialActor,
  ) {
    assert(order.status === 'disputed', 'Only a disputed order can resume.', 'ORDER_NOT_DISPUTED')
    for (const shipment of state.shipments.filter((entry) =>
      entry.orderId === order.id &&
      entry.status === 'cancelled' &&
      entry.timeline.at(-1)?.financialHold === 'disputed',
    )) {
      shipment.status = transitionShipmentForKind(
        shipment.kind,
        shipment.status,
        'unfulfilled',
      )
      shipment.timeline.push({
        id: makeId('stl', `${shipment.id}:dispute-resolved:${requestId}`),
        status: 'unfulfilled',
        label: reason,
        at,
      })
    }
    const previous = order.timeline.at(-1)?.financialHoldPreviousStatus
    const resolution = resolveOrderFulfillment(state, order)
    const restored: OrderStatus = previous === 'closed' && resolution.status === 'fulfilled'
      ? 'closed'
      : resolution.status
    order.status = transitionOrder(order.status, restored)
    refreshOrderFulfillment(state, order, at, reason)
    this.audit.append(state, {
      actorId: actor.id,
      actorRole: actor.role,
      action: 'order.dispute_resolved',
      targetType: 'order',
      targetId: order.id,
      reason,
      at,
      requestId,
      before: { status: 'disputed' },
      after: { status: restored },
    })
  }
}
