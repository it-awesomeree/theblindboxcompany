import {
  assert,
  assertRole,
  getSessionUser,
  stableHash,
  sanitizeText,
  validateDemoClaimNote,
} from '../domain/guards'
import type {
  Claim,
  ClaimKind,
  ClaimStatus,
  DemoState,
} from '../domain/types'
import type { MockRepository } from '../data/MockRepository'
import { AuditService } from './AuditService'

export interface SubmitClaimInput {
  orderId: string
  kind: ClaimKind
  note: string
  shipmentId?: string
  boxId?: string
}

export type ClaimReviewAction = 'acknowledge' | 'approve' | 'reject' | 'resolve'

const OPEN_CLAIM_STATUSES: ClaimStatus[] = ['submitted', 'reviewing', 'approved']
const SHIPPED_OVERDUE_MS = 3 * 24 * 60 * 60 * 1000

function nextClaimIdentity(state: DemoState, seed: string) {
  const sequence = state.nextSequence
  state.nextSequence += 1
  const serial = sequence.toString(36).padStart(8, '0')
  const fingerprint = stableHash(`${seed}:${sequence}`).toString(36).padStart(7, '0')
  return {
    id: `clm-${serial}-${fingerprint}`,
    requestId: `req-claim-${serial}-${fingerprint}`,
  }
}

function linkKey(kind: ClaimKind, shipmentId?: string, boxId?: string) {
  return `${kind}:${kind === 'value_floor' ? boxId ?? '' : shipmentId ?? ''}`
}

export class ClaimService {
  constructor(
    private readonly repository: MockRepository,
    private readonly audit: AuditService,
    private readonly now: () => string,
  ) {}

  submit(input: SubmitClaimInput) {
    return this.repository.update((state) => {
      const user = getSessionUser(state)
      assertRole(user, ['customer'], 'submit a demo claim')
      const order = state.orders.find((entry) => entry.id === input.orderId && entry.userId === user.id)
      assert(order, 'Order not found for this fictional account.', 'ORDER_MISSING')
      const note = validateDemoClaimNote(input.note)
      const now = this.now()
      const selectedShipment = input.shipmentId
        ? state.shipments.find((shipment) => shipment.id === input.shipmentId && shipment.orderId === order.id)
        : undefined
      const selectedBox = input.boxId
        ? state.boxes.find((box) => box.id === input.boxId && box.orderId === order.id && box.ownerId === user.id)
        : undefined

      if (input.kind !== 'value_floor') {
        assert(
          order.boxIds.length > 0 &&
            order.boxIds.every((boxId) => {
              const box = state.boxes.find((entry) => entry.id === boxId)
              return Boolean(box?.revealedAt && Date.parse(box.revealedAt) <= Date.parse(now))
            }),
          'Shipment-linked claims require every box in the order to be revealed first.',
          'CLAIM_REVEAL_REQUIRED',
        )
      }

      if (input.kind === 'damage') {
        assert(input.shipmentId && selectedShipment, 'Choose the delivered shipment with the damage.', 'CLAIM_LINK_REQUIRED')
        assert(selectedShipment.status === 'delivered', 'Damage claims require a delivered shipment.', 'CLAIM_INELIGIBLE')
        assert(selectedShipment.kind !== 'DIGITAL', 'A digital fulfilment cannot have physical damage.', 'CLAIM_INELIGIBLE')
      } else if (input.kind === 'non_delivery') {
        assert(input.shipmentId && selectedShipment, 'Choose the shipment that did not arrive.', 'CLAIM_LINK_REQUIRED')
        assert(
          ['shipped', 'failed_delivery', 'lost'].includes(selectedShipment.status),
          'Non-delivery claims require a shipped, failed-delivery, or lost shipment.',
          'CLAIM_INELIGIBLE',
        )
        if (selectedShipment.status === 'shipped') {
          const hasExceptionEvidence = selectedShipment.timeline.some((entry) =>
            ['failed_delivery', 'lost'].includes(entry.status) && Date.parse(entry.at) <= Date.parse(now),
          )
          const shippedAt = [...selectedShipment.timeline].reverse().find((entry) => entry.status === 'shipped')?.at
          assert(
            hasExceptionEvidence ||
              (Boolean(shippedAt) && Date.parse(now) - Date.parse(shippedAt!) >= SHIPPED_OVERDUE_MS),
            'A shipped parcel must be at least three demo days overdue.',
            'CLAIM_NOT_OVERDUE',
          )
        }
      } else {
        assert(input.boxId && selectedBox, 'Choose the revealed box for this value-floor claim.', 'CLAIM_LINK_REQUIRED')
        assert(selectedBox.revealedAt && selectedBox.prizeId, 'Value-floor claims require a revealed box.', 'CLAIM_INELIGIBLE')
      }

      const duplicate = state.claims.find((claim) =>
        claim.orderId === order.id &&
        OPEN_CLAIM_STATUSES.includes(claim.status) &&
        linkKey(claim.kind, claim.shipmentId, claim.boxId) === linkKey(input.kind, input.shipmentId, input.boxId),
      )
      if (duplicate) return { data: duplicate, changed: false, message: 'The existing open claim was returned safely.' }

      const identity = nextClaimIdentity(state, `${order.id}:${input.kind}:${input.shipmentId ?? input.boxId ?? ''}`)
      const claim: Claim = {
        ...identity,
        orderId: order.id,
        userId: user.id,
        kind: input.kind,
        note,
        shipmentId: input.kind === 'value_floor' ? undefined : selectedShipment!.id,
        boxId: input.kind === 'value_floor' ? selectedBox!.id : undefined,
        status: 'submitted',
        createdAt: now,
        updatedAt: now,
        history: [{
          id: `${identity.id}-h-01`,
          status: 'submitted',
          note,
          actorId: user.id,
          actorRole: user.role,
          at: now,
        }],
      }
      state.claims.push(claim)
      order.claimIds.push(claim.id)
      this.audit.append(state, {
        actorId: user.id,
        actorRole: user.role,
        action: 'claim.submitted',
        targetType: 'claim',
        targetId: claim.id,
        reason: note,
        at: now,
        requestId: claim.requestId,
        after: { kind: claim.kind, status: claim.status, shipmentId: claim.shipmentId, boxId: claim.boxId },
      })
      return { data: claim, changed: true, message: 'Demo claim submitted for review.' }
    })
  }

  listMine() {
    const state = this.repository.getSnapshot()
    const user = getSessionUser(state)
    assertRole(user, ['customer'], 'view claim history')
    return state.claims.filter((claim) => claim.userId === user.id)
  }

  queue() {
    const state = this.repository.getSnapshot()
    const actor = getSessionUser(state)
    assertRole(actor, ['support', 'admin', 'super_admin'], 'view the claims queue')
    return [...state.claims].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  review(claimId: string, action: ClaimReviewAction, rawNote: string) {
    return this.repository.update((state) => {
      const actor = getSessionUser(state)
      assertRole(actor, ['support', 'admin', 'super_admin'], 'review claims')
      const claim = state.claims.find((entry) => entry.id === claimId)
      assert(claim, 'Claim was not found.', 'CLAIM_MISSING')
      const note = sanitizeText(rawNote, 500)
      assert(note.length >= 8, 'A review or resolution note of at least 8 characters is required.', 'RESOLUTION_NOTE_REQUIRED')
      const transitions: Record<ClaimReviewAction, { from: ClaimStatus[]; to: ClaimStatus }> = {
        acknowledge: { from: ['submitted'], to: 'reviewing' },
        approve: { from: ['reviewing'], to: 'approved' },
        reject: { from: ['submitted', 'reviewing'], to: 'rejected' },
        resolve: { from: ['approved'], to: 'resolved' },
      }
      const transition = transitions[action]
      assert(transition.from.includes(claim.status), `Claim cannot ${action} from ${claim.status}.`, 'INVALID_CLAIM_TRANSITION')
      const before = claim.status
      const now = this.now()
      claim.status = transition.to
      claim.updatedAt = now
      if (action === 'reject' || action === 'resolve') claim.resolutionNote = note
      claim.history.push({
        id: `${claim.id}-h-${String(claim.history.length + 1).padStart(2, '0')}`,
        status: claim.status,
        note,
        actorId: actor.id,
        actorRole: actor.role,
        at: now,
      })
      const requestId = `req-${claim.id}-${action}-${claim.history.length}`
      this.audit.append(state, {
        actorId: actor.id,
        actorRole: actor.role,
        action: `claim.${action}`,
        targetType: 'claim',
        targetId: claim.id,
        reason: note,
        at: now,
        requestId,
        before: { status: before },
        after: { status: claim.status, refundCreated: false },
      })
      return { data: claim, changed: true, message: `Claim is now ${claim.status}. No refund was created.` }
    })
  }
}
