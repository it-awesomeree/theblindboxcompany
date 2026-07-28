import { MockRepository, type StorageLike } from '../data/MockRepository'
import { assert, assertRole, DomainError, getSessionUser, makeId } from '../domain/guards'
import { AuditService } from './AuditService'
import { AdminService } from './AdminService'
import { FulfillmentService } from './FulfillmentService'
import { MockAuthGateway } from './MockAuthGateway'
import { MockPaymentGateway } from './MockPaymentGateway'
import { OrderService } from './OrderService'
import { PrizeService } from './PrizeService'
import { ReservationService } from './ReservationService'
import { FinancialSafetyService } from './FinancialSafetyService'
import { ClaimService } from './ClaimService'

export class AppServices {
  readonly repository: MockRepository
  readonly audit: AuditService
  readonly auth: MockAuthGateway
  private readonly reservations: ReservationService
  private readonly financialSafety: FinancialSafetyService
  readonly orders: OrderService
  readonly prizes: PrizeService
  readonly fulfilment: FulfillmentService
  readonly payments: MockPaymentGateway
  readonly admin: AdminService
  readonly claims: ClaimService

  constructor(storage?: StorageLike, private readonly now: () => string = () => new Date().toISOString()) {
    this.repository = new MockRepository(storage)
    this.audit = new AuditService()
    this.reservations = new ReservationService(this.audit)
    this.financialSafety = new FinancialSafetyService(this.audit)
    this.prizes = new PrizeService()
    this.auth = new MockAuthGateway(this.repository, this.audit)
    this.orders = new OrderService(this.repository, this.audit, this.reservations, now)
    this.fulfilment = new FulfillmentService(this.repository, this.audit, now)
    this.payments = new MockPaymentGateway(this.repository, this.audit, this.prizes, this.fulfilment, this.reservations, this.financialSafety, now)
    this.claims = new ClaimService(this.repository, this.audit, now)
    this.admin = new AdminService(this.repository, this.audit, this.reservations, this.financialSafety, now)
    this.openBox = this.openBox.bind(this)
    try {
      this.orders.expireReservations()
    } catch (caught) {
      if (!(caught instanceof DomainError) || caught.code !== 'STORAGE_WRITE_FAILED') throw caught
      const cleanupNotice =
        'Automatic cleanup was not saved. Nothing changed, and it is safe to retry or refresh.'
      this.repository.recoveryNotice = [this.repository.recoveryNotice, cleanupNotice]
        .filter(Boolean)
        .join(' ')
    }
  }

  openBox(boxId: string) {
    const snapshot = this.repository.getSnapshot()
    const currentUser = getSessionUser(snapshot)
    assertRole(currentUser, ['customer'], 'open a paid demo box')
    const currentBox = snapshot.boxes.find((box) => box.id === boxId)
    assert(currentBox, 'Box was not found.', 'BOX_MISSING')
    assert(currentBox.ownerId === currentUser.id, 'This box belongs to another fictional user.', 'FORBIDDEN')
    assert(currentBox.prizeId, 'Prize allocation is still waiting for confirmed payment.', 'NOT_ALLOCATED')
    if (currentBox.revealedAt) return { box: currentBox, changed: false }

    return this.repository.update((state) => {
      const user = getSessionUser(state)
      assertRole(user, ['customer'], 'open a paid demo box')
      const now = this.now()
      const beforeStatus = state.boxes.find((box) => box.id === boxId)?.status
      const result = this.prizes.openOwnedBox(state, boxId, user.id, now)
      assert(result.changed, 'The box reveal changed before it could be saved.', 'IDEMPOTENCY_CONFLICT')
      this.audit.append(state, {
        actorId: user.id,
        actorRole: user.role,
        action: 'box.revealed',
        targetType: 'box',
        targetId: boxId,
        reason: 'Owner opened the paid demo box once',
        at: now,
        requestId: makeId('req', `${boxId}:open`),
        before: { status: beforeStatus },
        after: { status: result.box.status, prizeId: result.box.prizeId, revealedAt: result.box.revealedAt },
      })
      return result
    })
  }

  reset() {
    this.repository.reset()
  }
}
