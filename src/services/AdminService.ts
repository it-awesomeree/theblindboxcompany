import { ADMIN_SECTION_PERMISSIONS, type AdminSection } from '../domain/constants'
import { isOpenClaimStatus } from '../domain/claimStatus'
import {
  assert,
  assertAdmin,
  assertRole,
  getSessionUser,
  makeId,
  sanitizeText,
  transitionOrder,
} from '../domain/guards'
import { publishedPrizesFor } from '../domain/selectors'
import { isValidPrizeDefinition } from '../domain/prizeValidation'
import type { DemoState, OrderStatus } from '../domain/types'
import type { MockRepository } from '../data/MockRepository'
import { AuditService } from './AuditService'
import { ReservationService } from './ReservationService'
import { FinancialSafetyService } from './FinancialSafetyService'

export class AdminService {
  constructor(
    private readonly repository: MockRepository,
    private readonly audit: AuditService,
    private readonly reservations: ReservationService,
    private readonly financialSafety: FinancialSafetyService,
    private readonly now: () => string,
  ) {}

  assertAccess() {
    const state = this.repository.getSnapshot()
    const actor = getSessionUser(state)
    assertAdmin(actor)
    return actor
  }

  dashboard() {
    const state = this.repository.getSnapshot()
    const actor = getSessionUser(state)
    assertRole(actor, ADMIN_SECTION_PERMISSIONS.overview, 'view dashboard data')
    const published = state.series.find((entry) => entry.status === 'published')
    const assigned = published?.inventory.reduce((sum, entry) => sum + entry.assigned, 0) ?? 0
    return {
      users: state.users.length,
      paidVolumeSen: state.payments
        .filter((payment) => payment.events.some((event) => event.type === 'succeeded' && !event.ignoredReason))
        .reduce((sum, payment) => sum + payment.amountSen, 0),
      openOrders: state.orders.filter((order) => !['closed', 'cancelled', 'refunded'].includes(order.status)).length,
      paymentExceptions: state.payments.filter((payment) => ['failed', 'expired', 'disputed'].includes(payment.status)).length,
      fulfilmentExceptions: state.shipments.filter((shipment) => ['failed_delivery', 'lost', 'returned'].includes(shipment.status)).length,
      assigned,
      remaining: (published?.allocationTotal ?? 0) - assigned - (published?.reservedBoxes ?? 0),
      reserved: published?.reservedBoxes ?? 0,
      openClaims: state.claims.filter((claim) => isOpenClaimStatus(claim.status)).length,
    }
  }

  searchUsers(query: string) {
    this.viewForRole('users')
    const needle = sanitizeText(query, 100).toLowerCase()
    return this.repository.getSnapshot().users.filter((user) =>
      !needle || `${user.name} ${user.email} ${user.role} ${user.status}`.toLowerCase().includes(needle),
    )
  }

  setUserStatus(userId: string, status: 'active' | 'suspended', reason: string) {
    return this.repository.update((state) => {
      const actor = getSessionUser(state)
      assertRole(actor, ['admin', 'super_admin'], `${status === 'active' ? 'reactivate' : 'suspend'} users`)
      const target = state.users.find((user) => user.id === userId)
      assert(target, 'Demo user was not found.', 'USER_MISSING')
      assert(
        target.role !== 'super_admin' || actor.role === 'super_admin',
        'Only a super admin can change another super admin.',
        'FORBIDDEN',
      )
      assert(!(status === 'suspended' && target.id === actor.id), 'Admins cannot suspend themselves.', 'SELF_SUSPENSION')
      const cleanReason = sanitizeText(reason, 220)
      assert(cleanReason.length >= 6, 'Give a short reason for this sensitive demo action.', 'REASON_REQUIRED')
      const before = { status: target.status }
      target.status = status
      const now = this.now()
      this.audit.append(state, {
        actorId: actor.id,
        actorRole: actor.role,
        action: status === 'active' ? 'user.reactivated' : 'user.suspended',
        targetType: 'user',
        targetId: target.id,
        reason: cleanReason,
        at: now,
        requestId: makeId('req', `${target.id}:${status}:${now}`),
        before,
        after: { status },
      })
      return target
    })
  }

  changeOrderStatus(orderId: string, status: OrderStatus, reason: string) {
    return this.repository.update((state) => {
      const actor = getSessionUser(state)
      assertRole(actor, ['admin', 'super_admin'], 'change order state')
      const order = state.orders.find((entry) => entry.id === orderId)
      assert(order, 'Order was not found.', 'ORDER_MISSING')
      const before = order.status
      const cleanReason = sanitizeText(reason, 220)
      assert(cleanReason.length >= 6, 'Give a short reason for this order change.', 'REASON_REQUIRED')
      const now = this.now()
      if (before === 'pending_payment' && status === 'cancelled') {
        const activePayment = state.payments.some((payment) =>
          order.paymentIds.includes(payment.id) && ['created', 'pending', 'processing'].includes(payment.status),
        )
        assert(!activePayment, 'Cancel or expire the active payment before cancelling this order.', 'PAYMENT_ACTIVE')
        this.reservations.release(
          state,
          order,
          now,
          makeId('req', `${order.id}:admin-cancel-reservation:${now}`),
          'Admin cancelled an unpaid order; stock reservation released once',
          { id: actor.id, role: actor.role },
        )
        this.financialSafety.stop(
          state,
          order,
          'cancelled',
          now,
          cleanReason,
          makeId('req', `${order.id}:admin-cancel:${now}`),
          { id: actor.id, role: actor.role },
        )
        return order
      }
      assert(
        before === 'fulfilled' && status === 'closed',
        'Payment and shipment services own this transition; a manual order change would create inconsistent records.',
        'SERVICE_OWNED_TRANSITION',
      )
      const relatedShipments = state.shipments.filter((shipment) => shipment.orderId === order.id)
      const openClaims = state.claims.some((claim) =>
        claim.orderId === order.id && isOpenClaimStatus(claim.status),
      )
      assert(relatedShipments.length > 0 && relatedShipments.every((shipment) => shipment.status === 'delivered'), 'All shipments must be delivered before closing.', 'FULFILMENT_INCOMPLETE')
      assert(!openClaims, 'Resolve or reject open claims before closing.', 'CLAIM_OPEN')
      order.status = transitionOrder(order.status, status)
      order.updatedAt = now
      order.timeline.push({ id: makeId('tl', `${order.id}:${status}:${now}`), status, label: cleanReason, at: now })
      this.audit.append(state, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'order.transitioned',
        targetType: 'order',
        targetId: order.id,
        reason: cleanReason,
        at: now,
        requestId: makeId('req', `${order.id}:${status}:${now}`),
        before: { status: before },
        after: { status },
      })
      return order
    })
  }

  copyPublishedToDraft() {
    return this.repository.update((state) => {
      const actor = getSessionUser(state)
      assertRole(actor, ['catalog', 'admin', 'super_admin'], 'copy a series draft')
      const existing = state.series.find((entry) => entry.status === 'draft')
      if (existing) return existing
      const published = state.series.find((entry) => entry.status === 'published')
      assert(published, 'Published Series 001 is missing.', 'SERIES_MISSING')
      const publishedPrizes = publishedPrizesFor(published)
      const now = this.now()
      const draft = {
        ...structuredClone(published),
        id: 'series-001-draft',
        name: 'Series 001 — draft copy',
        status: 'draft' as const,
        reservedBoxes: 0,
        publishedPrizes: undefined,
        inventory: publishedPrizes.map((prize) => ({ prizeId: prize.id, assigned: 0 })),
        draftPrizes: structuredClone(publishedPrizes),
        createdAt: now,
        publishedAt: undefined,
      }
      state.series.push(draft)
      this.audit.append(state, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'series.draft_copied',
        targetType: 'series',
        targetId: draft.id,
        reason: 'Editable demo copy; published Series 001 remains immutable',
        at: now,
        requestId: makeId('req', `${draft.id}:${now}`),
        after: { prizes: draft.draftPrizes.length },
      })
      return draft
    })
  }

  editDraftPrize(prizeId: string, name: string, valueSen: number) {
    return this.repository.update((state) => {
      const actor = getSessionUser(state)
      assertRole(actor, ['catalog', 'admin', 'super_admin'], 'edit a draft series')
      const draft = state.series.find((entry) => entry.status === 'draft')
      assert(draft?.draftPrizes, 'Create a draft copy before editing.', 'DRAFT_MISSING')
      const prize = draft.draftPrizes.find((entry) => entry.id === prizeId)
      assert(prize, 'Draft prize was not found.', 'PRIZE_MISSING')
      assert(Number.isInteger(valueSen) && valueSen >= 10_000, 'Every draft prize must keep the RM100 floor.', 'FLOOR_VIOLATION')
      const cleanName = sanitizeText(name, 120)
      assert(cleanName.length > 0, 'Draft prize name cannot be blank.', 'INVALID_PRIZE_NAME')
      const before = structuredClone(prize)
      prize.name = cleanName
      prize.valueSen = valueSen
      assert(isValidPrizeDefinition(prize), 'Draft prize definition is invalid.', 'INVALID_PRIZE_DEFINITION')
      const now = this.now()
      this.audit.append(state, {
        actorId: actor.id,
        actorRole: actor.role,
        action: 'series.draft_prize_edited',
        targetType: 'series',
        targetId: draft.id,
        reason: 'Catalog demo edit',
        at: now,
        requestId: makeId('req', `${draft.id}:${prizeId}:${now}`),
        before,
        after: prize,
      })
      return prize
    })
  }

  viewForRole(section: AdminSection) {
    const actor = this.assertAccess()
    assert(ADMIN_SECTION_PERMISSIONS[section].includes(actor.role), `${actor.role} cannot view ${section}.`, 'FORBIDDEN')
    return true
  }

  snapshot(): DemoState {
    const actor = getSessionUser(this.repository.getSnapshot())
    assertRole(actor, ['admin', 'super_admin'], 'read the complete admin state')
    return structuredClone(this.repository.getSnapshot())
  }
}
