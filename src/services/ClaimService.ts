import {
  assert,
  assertRole,
  getSessionUser,
  stableHash,
  sanitizeText,
  validateDemoClaimNote,
} from '../domain/guards'
import {
  shipmentClaimEligibility,
  valueFloorClaimEligibility,
} from '../domain/claimEligibility'
import {
  canWidenClaimEvidence,
  CLAIM_EVIDENCE_WIDENING_NOTE,
  isOpenClaimStatus,
} from '../domain/claimStatus'
import type {
  Claim,
  ClaimKind,
  ClaimResolutionOutcome,
  ClaimStatus,
  DemoState,
} from '../domain/types'
import type { MockRepository } from '../data/MockRepository'
import { formatMYR } from '../lib/format'
import { AuditService } from './AuditService'

export interface SubmitClaimInput {
  orderId: string
  kind: ClaimKind
  note: string
  shipmentId?: string
  orderLevelDelivery?: boolean
  boxId?: string
}

export type ClaimReviewAction = 'acknowledge' | 'approve' | 'reject' | 'resolve'

export interface ClaimResolutionInput {
  outcome: ClaimResolutionOutcome
  reference: string
}

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

function everyOrderBoxRevealedAt(state: DemoState, orderId: string, at: string) {
  const order = state.orders.find((entry) => entry.id === orderId)
  return Boolean(
    order?.boxIds.length &&
    order.boxIds.every((boxId) => {
      const box = state.boxes.find((entry) => entry.id === boxId && entry.orderId === order.id)
      return Boolean(box?.revealedAt && Date.parse(box.revealedAt) <= Date.parse(at))
    }),
  )
}

function eligibleShipmentIds(
  state: DemoState,
  orderId: string,
  kind: Extract<ClaimKind, 'damage' | 'non_delivery'>,
  at: string,
) {
  return state.shipments
    .filter((shipment) =>
      shipment.orderId === orderId &&
      shipmentClaimEligibility(shipment, kind, at).eligible,
    )
    .map((shipment) => shipment.id)
    .sort((left, right) => left.localeCompare(right))
}

function openClaimMatches(
  claim: Claim,
  kind: ClaimKind,
  shipmentId: string | undefined,
  boxId: string | undefined,
  shipmentCandidateIds: string[] | undefined,
) {
  if (claim.kind !== kind || !isOpenClaimStatus(claim.status)) return false
  if (kind === 'value_floor') return claim.boxId === boxId
  if (shipmentCandidateIds) {
    return Boolean(
      claim.shipmentCandidateIds ||
      (claim.shipmentId && shipmentCandidateIds.includes(claim.shipmentId)),
    )
  }
  return Boolean(
    claim.shipmentId === shipmentId ||
    (shipmentId && claim.shipmentCandidateIds?.includes(shipmentId)),
  )
}

function customerClaimReceipt(claim: Claim) {
  const receipt = structuredClone(claim)
  delete receipt.shipmentCandidateIds
  delete receipt.shipmentCandidateEvidenceAt
  return receipt
}

export class ClaimService {
  constructor(
    private readonly repository: MockRepository,
    private readonly audit: AuditService,
    private readonly now: () => string,
  ) {}

  private prepareSubmission(state: DemoState, input: SubmitClaimInput, now: string) {
    const user = getSessionUser(state)
    assertRole(user, ['customer'], 'submit a demo claim')
    const order = state.orders.find((entry) => entry.id === input.orderId && entry.userId === user.id)
    assert(order, 'Order not found for this fictional account.', 'ORDER_MISSING')
    const note = validateDemoClaimNote(input.note)
    const selectedShipment = input.shipmentId
      ? state.shipments.find((shipment) => shipment.id === input.shipmentId && shipment.orderId === order.id)
      : undefined
    const selectedBox = input.boxId
      ? state.boxes.find((box) => box.id === input.boxId && box.orderId === order.id && box.ownerId === user.id)
      : undefined
    const orderLevelDelivery = input.orderLevelDelivery === true
    const selectedLinkCount =
      Number(Boolean(input.shipmentId)) +
      Number(Boolean(input.boxId)) +
      Number(orderLevelDelivery)
    assert(selectedLinkCount === 1, 'Choose exactly one valid claim evidence scope.', 'CLAIM_LINK_REQUIRED')
    const everyBoxRevealed = everyOrderBoxRevealedAt(state, order.id, now)
    let shipmentCandidateIds: string[] | undefined

    if (input.kind === 'damage' || input.kind === 'non_delivery') {
      assert(
        !input.boxId,
        'Delivery claims cannot link a suspected value-floor issue box.',
        'CLAIM_LINK_INVALID',
      )
      if (everyBoxRevealed) {
        assert(
          input.shipmentId && selectedShipment && !orderLevelDelivery,
          input.kind === 'damage'
            ? 'Choose the delivered shipment with the damage.'
            : 'Choose the shipment that did not arrive.',
          'CLAIM_LINK_REQUIRED',
        )
        const eligibility = shipmentClaimEligibility(selectedShipment, input.kind, now)
        assert(
          eligibility.eligible,
          eligibility.reason,
          input.kind === 'non_delivery' && eligibility.reason.includes('three demo days')
            ? 'CLAIM_NOT_OVERDUE'
            : 'CLAIM_INELIGIBLE',
        )
      } else {
        assert(
          orderLevelDelivery && !input.shipmentId,
          'While any box is sealed, use the neutral order-level delivery evidence.',
          'CLAIM_ORDER_LEVEL_REQUIRED',
        )
        shipmentCandidateIds = eligibleShipmentIds(state, order.id, input.kind, now)
        assert(
          shipmentCandidateIds.length > 0,
          input.kind === 'damage'
            ? 'No delivered physical order evidence is eligible for damage.'
            : 'No physical order evidence is currently eligible for non-delivery.',
          'CLAIM_INELIGIBLE',
        )
      }
    } else {
      assert(
        input.boxId && selectedBox && !input.shipmentId && !orderLevelDelivery,
        'Choose the revealed box for suspected value-floor issue review.',
        'CLAIM_LINK_REQUIRED',
      )
      const eligibility = valueFloorClaimEligibility(selectedBox, now)
      assert(eligibility.eligible, eligibility.reason, 'CLAIM_INELIGIBLE')
    }

    const duplicate = state.claims.find((claim) =>
      claim.orderId === order.id &&
      openClaimMatches(
        claim,
        input.kind,
        selectedShipment?.id,
        selectedBox?.id,
        shipmentCandidateIds,
      ),
    )
    return {
      user,
      order,
      note,
      selectedShipment,
      selectedBox,
      shipmentCandidateIds,
      duplicate,
    }
  }

  submit(input: SubmitClaimInput) {
    const now = this.now()
    const prepared = this.prepareSubmission(this.repository.getSnapshot(), input, now)
    const newCandidateIds = prepared.shipmentCandidateIds ?? []
    const existingCandidateIds = prepared.duplicate?.shipmentCandidateIds ?? []
    const shouldWidenOrderLevelClaim = Boolean(
      prepared.duplicate?.shipmentCandidateIds &&
      prepared.shipmentCandidateIds &&
      canWidenClaimEvidence(prepared.duplicate.status) &&
      newCandidateIds.some((shipmentId) => !existingCandidateIds.includes(shipmentId)),
    )
    if (prepared.duplicate && !shouldWidenOrderLevelClaim) {
      return {
        data: customerClaimReceipt(prepared.duplicate),
        changed: false,
        message: 'The existing open claim was returned safely.',
      }
    }

    return this.repository.update((state) => {
      const {
        user,
        order,
        note,
        selectedShipment,
        selectedBox,
        shipmentCandidateIds,
        duplicate,
      } = this.prepareSubmission(state, input, now)
      if (duplicate) {
        assert(
          duplicate.shipmentCandidateIds &&
            shipmentCandidateIds &&
            canWidenClaimEvidence(duplicate.status),
          'The claim request changed before it could be saved.',
          'IDEMPOTENCY_CONFLICT',
        )
        const additions = shipmentCandidateIds.filter((shipmentId) =>
          !duplicate.shipmentCandidateIds!.includes(shipmentId),
        )
        assert(
          additions.length > 0,
          'The claim request changed before it could be saved.',
          'IDEMPOTENCY_CONFLICT',
        )
        const beforeCandidateIds = [...duplicate.shipmentCandidateIds]
        const evidenceAt = {
          ...Object.fromEntries(
            duplicate.shipmentCandidateIds.map((shipmentId) => [
              shipmentId,
              duplicate.shipmentCandidateEvidenceAt?.[shipmentId] ?? duplicate.createdAt,
            ]),
          ),
        }
        additions.forEach((shipmentId) => {
          evidenceAt[shipmentId] = now
        })
        duplicate.shipmentCandidateIds = [
          ...new Set([...duplicate.shipmentCandidateIds, ...additions]),
        ].sort((left, right) => left.localeCompare(right))
        duplicate.shipmentCandidateEvidenceAt = Object.fromEntries(
          duplicate.shipmentCandidateIds.map((shipmentId) => [
            shipmentId,
            evidenceAt[shipmentId],
          ]),
        )
        duplicate.updatedAt = now
        duplicate.history.push({
          id: `${duplicate.id}-h-${String(duplicate.history.length + 1).padStart(2, '0')}`,
          status: duplicate.status,
          note: CLAIM_EVIDENCE_WIDENING_NOTE,
          actorId: user.id,
          actorRole: user.role,
          at: now,
        })
        this.audit.append(state, {
          actorId: user.id,
          actorRole: user.role,
          action: 'claim.order_level_evidence_widened',
          targetType: 'claim',
          targetId: duplicate.id,
          reason: CLAIM_EVIDENCE_WIDENING_NOTE,
          at: now,
          requestId: `req-${duplicate.id}-evidence-${duplicate.history.length}`,
          before: { shipmentCandidateIds: beforeCandidateIds },
          after: {
            refundCreated: false,
            shipmentCandidateEvidenceAt: duplicate.shipmentCandidateEvidenceAt!,
            shipmentCandidateIds: duplicate.shipmentCandidateIds,
          },
        })
        return {
          data: customerClaimReceipt(duplicate),
          changed: true,
          message: 'The existing open claim was widened with newly eligible neutral delivery evidence.',
        }
      }

      const evidenceSeed =
        selectedBox?.id ??
        selectedShipment?.id ??
        shipmentCandidateIds?.join(',') ??
        ''
      const identity = nextClaimIdentity(state, `${order.id}:${input.kind}:${evidenceSeed}`)
      const claim: Claim = {
        ...identity,
        orderId: order.id,
        userId: user.id,
        kind: input.kind,
        note,
        shipmentId: input.kind === 'value_floor' ? undefined : selectedShipment?.id,
        shipmentCandidateIds,
        shipmentCandidateEvidenceAt: shipmentCandidateIds
          ? Object.fromEntries(shipmentCandidateIds.map((shipmentId) => [shipmentId, now]))
          : undefined,
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
        after: {
          ...(claim.boxId !== undefined ? { boxId: claim.boxId } : {}),
          kind: claim.kind,
          refundCreated: false,
          ...(claim.shipmentCandidateIds !== undefined
            ? { shipmentCandidateIds: claim.shipmentCandidateIds }
            : {}),
          ...(claim.shipmentId !== undefined ? { shipmentId: claim.shipmentId } : {}),
          status: claim.status,
        },
      })
      return {
        data: customerClaimReceipt(claim),
        changed: true,
        message: input.kind === 'value_floor'
          ? `Suspected ${formatMYR(order.snapshot.valueFloorSen)} value-floor issue submitted for review; this is only a review threshold and eligibility does not establish a breach.`
          : 'Demo claim submitted for review.',
      }
    })
  }

  listMine() {
    const state = this.repository.getSnapshot()
    const user = getSessionUser(state)
    assertRole(user, ['customer'], 'view claim history')
    return state.claims
      .filter((claim) => claim.userId === user.id)
      .map(customerClaimReceipt)
  }

  eligibleLinks(orderId: string, kind: ClaimKind) {
    const state = this.repository.getSnapshot()
    const user = getSessionUser(state)
    assertRole(user, ['customer'], 'view demo claim eligibility')
    const order = state.orders.find((entry) => entry.id === orderId && entry.userId === user.id)
    assert(order, 'Order not found for this fictional account.', 'ORDER_MISSING')
    const now = this.now()
    if (kind === 'value_floor') {
      return {
        boxes: state.boxes.filter((box) =>
          box.orderId === order.id &&
          box.ownerId === user.id &&
          valueFloorClaimEligibility(box, now).eligible,
        ),
        shipments: [],
        orderLevelEligible: false,
      }
    }
    const everyBoxRevealed = everyOrderBoxRevealedAt(state, order.id, now)
    if (!everyBoxRevealed) {
      return {
        boxes: [],
        shipments: [],
        orderLevelEligible: eligibleShipmentIds(state, order.id, kind, now).length > 0,
      }
    }
    return {
      boxes: [],
      shipments: state.shipments.filter((shipment) =>
        shipment.orderId === order.id &&
        shipmentClaimEligibility(shipment, kind, now).eligible,
      ),
      orderLevelEligible: false,
    }
  }

  queue() {
    const state = this.repository.getSnapshot()
    const actor = getSessionUser(state)
    assertRole(actor, ['support', 'admin', 'super_admin'], 'view the claims queue')
    return [...state.claims].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  private validateResolution(
    state: DemoState,
    claim: Claim,
    note: string,
    resolution?: ClaimResolutionInput,
  ) {
    assert(resolution, 'Choose a structured resolution outcome and reference.', 'RESOLUTION_EVIDENCE_REQUIRED')
    const outcomes: ClaimResolutionOutcome[] = [
      'replacement_authorized',
      'return_rma_created',
      'refund_recorded',
      'no_remedy',
    ]
    assert(outcomes.includes(resolution.outcome), 'Choose a valid resolution outcome.', 'RESOLUTION_OUTCOME_INVALID')
    const reference = sanitizeText(resolution.reference, 100)
    assert(reference.length >= 4, 'Enter the fictional resolution reference.', 'RESOLUTION_REFERENCE_REQUIRED')
    if (resolution.outcome === 'refund_recorded') {
      const payment = state.payments.find((entry) =>
        entry.orderId === claim.orderId &&
        entry.events.some((event) =>
          event.id === reference &&
          !event.ignoredReason &&
          Boolean(event.refundIntent) &&
          ['partially_refunded', 'refunded'].includes(event.type),
        ),
      )
      const event = payment?.events.find((entry) => entry.id === reference)
      const audited = Boolean(payment && event && state.audits.some((audit) =>
        audit.targetType === 'payment' &&
        audit.targetId === payment.id &&
        audit.eventId === event.id &&
        ['payment.partially_refunded', 'payment.refunded'].includes(audit.action),
      ))
      assert(audited, 'Refund resolution must reference an existing audited refund event for this order.', 'RESOLUTION_REFUND_MISSING')
    } else {
      assert(
        /^DEMO-[A-Z0-9][A-Z0-9-]{2,96}$/.test(reference),
        'Replacement, RMA, and no-remedy references must be clearly fictional DEMO- codes.',
        'DEMO_DATA_ONLY',
      )
      assert(note.length >= 16, 'Describe the fictional resolution in at least 16 characters.', 'RESOLUTION_NOTE_REQUIRED')
    }
    return { outcome: resolution.outcome, reference }
  }

  review(
    claimId: string,
    action: ClaimReviewAction,
    rawNote: string,
    resolution?: ClaimResolutionInput,
  ) {
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
      const structured = action === 'resolve'
        ? this.validateResolution(state, claim, note, resolution)
        : undefined
      claim.status = transition.to
      claim.updatedAt = now
      if (action === 'reject' || action === 'resolve') claim.resolutionNote = note
      if (structured) {
        claim.resolutionOutcome = structured.outcome
        claim.resolutionReference = structured.reference
      }
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
        after: {
          refundCreated: false,
          ...(claim.resolutionOutcome !== undefined
            ? { resolutionOutcome: claim.resolutionOutcome }
            : {}),
          ...(claim.resolutionReference !== undefined
            ? { resolutionReference: claim.resolutionReference }
            : {}),
          status: claim.status,
        },
      })
      return { data: claim, changed: true, message: `Claim is now ${claim.status}. No refund was created.` }
    })
  }
}
