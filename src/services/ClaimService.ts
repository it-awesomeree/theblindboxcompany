import {
  assert,
  assertRole,
  getSessionUser,
  makeId,
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
import { matchingAppliedPaymentRefundAudit } from '../domain/refundLink'
import { refreshOrderFulfillment } from '../domain/orderFulfillment'
import {
  remedyBoxIdsForEvidence,
  requiredSettlementForBoxScope,
} from '../domain/remedyPolicy'
import {
  REPLACEMENT_AUTHORIZED_ACTION,
  RMA_CREATED_ACTION,
  RMA_INSPECTED_ACTION,
  RMA_RECEIVED_ACTION,
} from '../domain/remedyEvidence'
import type {
  Claim,
  ClaimKind,
  ClaimRemedyState,
  ClaimResolutionOutcome,
  ClaimStatus,
  DemoState,
  RmaStatus,
  Shipment,
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

const DEMO_REMEDY_REFERENCE = /^DEMO-[A-Z0-9][A-Z0-9-]{2,96}$/

function remedyReference(value: string) {
  const reference = sanitizeText(value, 100).toUpperCase()
  assert(
    reference === value && DEMO_REMEDY_REFERENCE.test(reference),
    'Use an obvious fictional DEMO- remedy reference.',
    'DEMO_DATA_ONLY',
  )
  return reference
}

function remedyReason(value: string) {
  const reason = sanitizeText(value, 500)
  assert(reason.length >= 8, 'A remedy reason of at least 8 characters is required.', 'REASON_REQUIRED')
  return reason
}

function originalForClaim(state: DemoState, claim: Claim): Shipment | undefined {
  const shipmentId =
    claim.shipmentId ??
    (claim.shipmentCandidateIds?.length === 1 ? claim.shipmentCandidateIds[0] : undefined) ??
    (claim.boxId
      ? state.boxes.find((box) => box.id === claim.boxId && box.orderId === claim.orderId)?.shipmentId
      : undefined)
  return state.shipments.find((shipment) =>
    shipment.id === shipmentId &&
    shipment.orderId === claim.orderId &&
    shipment.purpose === 'original',
  )
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
        duplicate.remedyBoxIds = remedyBoxIdsForEvidence(state, order, {
          kind: duplicate.kind,
          shipmentCandidateIds: duplicate.shipmentCandidateIds,
        })
        duplicate.requiredSettlementSen = requiredSettlementForBoxScope(
          order,
          duplicate.remedyBoxIds,
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
        refreshOrderFulfillment(state, order, now, CLAIM_EVIDENCE_WIDENING_NOTE)
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
      const remedyBoxIds = remedyBoxIdsForEvidence(state, order, {
        kind: input.kind,
        boxId: input.kind === 'value_floor' ? selectedBox!.id : undefined,
        shipmentId: input.kind === 'value_floor' ? undefined : selectedShipment?.id,
        shipmentCandidateIds,
      })
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
        remedyState: 'none',
        remedyBoxIds,
        requiredSettlementSen: requiredSettlementForBoxScope(order, remedyBoxIds),
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
      refreshOrderFulfillment(state, order, now, 'Demo claim submitted for review')
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
    const outcomes: ClaimResolutionOutcome[] = ['refund_recorded', 'no_remedy']
    if (
      resolution.outcome === 'replacement_authorized' ||
      resolution.outcome === 'return_rma_created'
    ) {
      assert(
        claim.linkedRefundEventId === undefined,
        'A claim linked to a refund event must use the refund-recorded resolution.',
        'RESOLUTION_REFUND_LINK_MISMATCH',
      )
      assert(
        false,
        'Replacement authorization and RMA creation must use their guarded typed APIs.',
        'TYPED_REMEDY_REQUIRED',
      )
    }
    assert(outcomes.includes(resolution.outcome), 'Choose a valid resolution outcome.', 'RESOLUTION_OUTCOME_INVALID')
    const reference = sanitizeText(resolution.reference, 100)
    assert(reference.length >= 4, 'Enter the fictional resolution reference.', 'RESOLUTION_REFERENCE_REQUIRED')
    if (resolution.outcome === 'refund_recorded') {
      assert(
        claim.legacyUnderSettledRefund !== true,
        'Legacy under-settled refund evidence cannot complete a current remedy.',
        'CLAIM_SETTLEMENT_MISMATCH',
      )
      assert(
        claim.linkedRefundEventId && reference === claim.linkedRefundEventId,
        'Refund resolution must use the exact refund event already linked to this claim.',
        'RESOLUTION_REFUND_LINK_MISMATCH',
      )
      const payment = state.payments.find((entry) =>
        entry.orderId === claim.orderId &&
        entry.userId === claim.userId &&
        entry.events.some((event) =>
          event.id === reference &&
          !event.ignoredReason &&
          event.source === 'admin_reconcile' &&
          event.refundIntent?.paymentId === entry.id &&
          event.refundIntent.claimId === claim.id &&
          ['partially_refunded', 'refunded'].includes(event.type),
        ),
      )
      const event = payment?.events.find((entry) => entry.id === reference)
      const audited = Boolean(
        payment &&
        event &&
        Date.parse(event.createdAt) >= Date.parse(claim.createdAt) &&
        Date.parse(event.processedAt) >= Date.parse(claim.createdAt) &&
        matchingAppliedPaymentRefundAudit(state, payment, event, claim),
      )
      assert(
        audited,
        'Refund resolution must reference this claim’s accepted and audited linked refund event.',
        'RESOLUTION_REFUND_MISSING',
      )
      assert(
        claim.remedyState === 'refund_linked',
        'Refund resolution requires the claim refund remedy link.',
        'RESOLUTION_REFUND_LINK_MISMATCH',
      )
    } else {
      assert(
        claim.linkedRefundEventId === undefined,
        'A claim linked to a refund event must use the refund-recorded resolution.',
        'RESOLUTION_REFUND_LINK_MISMATCH',
      )
      assert(
        /^DEMO-[A-Z0-9][A-Z0-9-]{2,96}$/.test(reference),
        'Replacement, RMA, and no-remedy references must be clearly fictional DEMO- codes.',
        'DEMO_DATA_ONLY',
      )
      assert(note.length >= 16, 'Describe the fictional resolution in at least 16 characters.', 'RESOLUTION_NOTE_REQUIRED')
      assert(
        claim.replacementShipmentId === undefined &&
          claim.rma === undefined &&
          claim.remedyState === 'none',
        'A selected RMA path must finish through its linked refund or delivered replacement.',
        'REMEDY_INCOMPLETE',
      )
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
        claim.remedyState = structured.outcome === 'refund_recorded'
          ? 'refund_completed'
          : 'no_remedy'
      }
      claim.history.push({
        id: `${claim.id}-h-${String(claim.history.length + 1).padStart(2, '0')}`,
        status: claim.status,
        note,
        actorId: actor.id,
        actorRole: actor.role,
        at: now,
      })
      const order = state.orders.find((entry) => entry.id === claim.orderId)
      assert(order, 'Claim order was not found.', 'ORDER_MISSING')
      refreshOrderFulfillment(state, order, now, note)
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
          ...(claim.linkedRefundEventId !== undefined
            ? { linkedRefundEventId: claim.linkedRefundEventId }
            : {}),
          status: claim.status,
        },
      })
      return { data: claim, changed: true, message: `Claim is now ${claim.status}. No refund was created.` }
    })
  }

  private rmaReplay(
    claimId: string,
    reference: string,
    reason: string,
    step: RmaStatus,
  ) {
    const state = this.repository.getSnapshot()
    const actor = getSessionUser(state)
    assertRole(actor, ['support', 'admin', 'super_admin'], 'record RMA evidence')
    const claim = state.claims.find((entry) => entry.id === claimId)
    assert(claim, 'Claim was not found.', 'CLAIM_MISSING')
    const rma = claim.rma
    if (!rma) return undefined
    const stored = step === 'created'
      ? { reference: rma.reference, reason: rma.createdReason }
      : step === 'received' && rma.receivedAt
        ? { reference: rma.reference, reason: rma.receivedReason }
        : step === 'inspected' && rma.inspectedAt
          ? { reference: rma.reference, reason: rma.inspectedReason }
          : undefined
    if (!stored) return undefined
    assert(
      stored.reference === reference && stored.reason === reason,
      `The ${step} RMA step was already recorded with different evidence.`,
      'IDEMPOTENCY_CONFLICT',
    )
    return {
      data: claim,
      changed: false,
      message: `Exact RMA ${step} replay returned the original result.`,
    }
  }

  private recordRmaStep(
    claimId: string,
    rawReference: string,
    rawReason: string,
    step: RmaStatus,
  ) {
    const reference = remedyReference(rawReference)
    const reason = remedyReason(rawReason)
    const replay = this.rmaReplay(claimId, reference, reason, step)
    if (replay) return replay

    return this.repository.update((state) => {
      const actor = getSessionUser(state)
      assertRole(actor, ['support', 'admin', 'super_admin'], 'record RMA evidence')
      const claim = state.claims.find((entry) => entry.id === claimId)
      assert(claim, 'Claim was not found.', 'CLAIM_MISSING')
      assert(claim.status === 'approved', 'RMA evidence requires an approved claim.', 'CLAIM_NOT_APPROVED')
      assert(claim.linkedRefundEventId === undefined, 'A refund-linked claim cannot start an RMA path.', 'REMEDY_CONFLICT')
      const now = this.now()
      assert(
        Date.parse(now) >= Date.parse(claim.updatedAt),
        'RMA evidence cannot precede the claim history.',
        'RMA_CHRONOLOGY_INVALID',
      )
      let action: string
      let beforeState: ClaimRemedyState
      let beforeStatus: RmaStatus | null
      let afterState: ClaimRemedyState
      if (step === 'created') {
        const original = originalForClaim(state, claim)
        assert(
          original &&
            original.kind !== 'DIGITAL' &&
            original.timeline.some((entry) =>
              entry.status === 'delivered' &&
              Date.parse(entry.at) <= Date.parse(claim.createdAt)),
          'RMA creation requires physical delivery evidence that existed when the claim was submitted.',
          'RMA_PHYSICAL_DELIVERY_REQUIRED',
        )
        assert(
          claim.remedyState === 'none' && claim.rma === undefined,
          'This claim already selected a remedy path.',
          'REMEDY_CONFLICT',
        )
        assert(
          !state.claims.some((entry) => entry.id !== claim.id && entry.rma?.reference === reference),
          'That RMA reference is already in use.',
          'RMA_REFERENCE_REUSED',
        )
        claim.rma = {
          reference,
          status: 'created',
          createdAt: now,
          createdReason: reason,
        }
        action = RMA_CREATED_ACTION
        beforeState = 'none'
        beforeStatus = null
        afterState = 'rma_created'
      } else {
        assert(claim.rma?.reference === reference, 'RMA reference does not match this claim.', 'RMA_REFERENCE_MISMATCH')
        if (step === 'received') {
          assert(
            claim.remedyState === 'rma_created' && claim.rma.status === 'created',
            'RMA receipt must follow RMA creation.',
            'RMA_ORDER_INVALID',
          )
          claim.rma.receivedAt = now
          claim.rma.receivedReason = reason
          claim.rma.status = 'received'
          action = RMA_RECEIVED_ACTION
          beforeState = 'rma_created'
          beforeStatus = 'created'
          afterState = 'rma_received'
        } else {
          assert(
            claim.remedyState === 'rma_received' && claim.rma.status === 'received',
            'RMA inspection must follow recorded receipt.',
            'RMA_ORDER_INVALID',
          )
          claim.rma.inspectedAt = now
          claim.rma.inspectedReason = reason
          claim.rma.status = 'inspected'
          action = RMA_INSPECTED_ACTION
          beforeState = 'rma_received'
          beforeStatus = 'received'
          afterState = 'rma_inspected'
        }
      }
      claim.remedyState = afterState
      claim.updatedAt = now
      claim.history.push({
        id: `${claim.id}-h-${String(claim.history.length + 1).padStart(2, '0')}`,
        status: claim.status,
        note: reason,
        actorId: actor.id,
        actorRole: actor.role,
        at: now,
      })
      const order = state.orders.find((entry) => entry.id === claim.orderId)
      assert(order, 'Claim order was not found.', 'ORDER_MISSING')
      refreshOrderFulfillment(state, order, now, reason)
      this.audit.append(state, {
        actorId: actor.id,
        actorRole: actor.role,
        action,
        targetType: 'claim',
        targetId: claim.id,
        reason,
        at: now,
        requestId: makeId('req', `${claim.id}:rma:${step}:${now}`),
        before: { remedyState: beforeState, rmaStatus: beforeStatus },
        after: {
          remedyState: afterState,
          rmaReference: reference,
          rmaStatus: step,
        },
      })
      return {
        data: claim,
        changed: true,
        message: `RMA ${step} evidence was recorded without resolving the claim.`,
      }
    })
  }

  createRma(claimId: string, reference: string, reason: string) {
    return this.recordRmaStep(claimId, reference, reason, 'created')
  }

  recordRmaReceived(claimId: string, reference: string, reason: string) {
    return this.recordRmaStep(claimId, reference, reason, 'received')
  }

  recordRmaInspected(claimId: string, reference: string, reason: string) {
    return this.recordRmaStep(claimId, reference, reason, 'inspected')
  }

  authorizeReplacement(claimId: string, rawReason: string) {
    const reason = remedyReason(rawReason)
    const snapshot = this.repository.getSnapshot()
    const currentActor = getSessionUser(snapshot)
    assertRole(currentActor, ['fulfilment', 'admin', 'super_admin'], 'authorize a replacement')
    const existing = snapshot.claims.find((entry) => entry.id === claimId)
    assert(existing, 'Claim was not found.', 'CLAIM_MISSING')
    if (existing.replacementShipmentId) {
      assert(
        existing.replacementAuthorization?.reason === reason,
        'This claim already authorized a replacement with different evidence.',
        'IDEMPOTENCY_CONFLICT',
      )
      const shipment = snapshot.shipments.find((entry) => entry.id === existing.replacementShipmentId)
      assert(shipment, 'Authorized replacement shipment is missing.', 'REPLACEMENT_LINK_INVALID')
      return {
        data: shipment,
        changed: false,
        message: 'Exact replacement authorization replay returned the original shipment.',
      }
    }

    return this.repository.update((state) => {
      const actor = getSessionUser(state)
      assertRole(actor, ['fulfilment', 'admin', 'super_admin'], 'authorize a replacement')
      const claim = state.claims.find((entry) => entry.id === claimId)
      assert(claim, 'Claim was not found.', 'CLAIM_MISSING')
      assert(claim.status === 'approved', 'Replacement requires an approved claim.', 'CLAIM_NOT_APPROVED')
      assert(claim.linkedRefundEventId === undefined, 'A refund-linked claim cannot authorize a replacement.', 'REMEDY_CONFLICT')
      assert(
        claim.remedyState === 'none' || claim.remedyState === 'rma_inspected',
        'A selected RMA path must be inspected before replacement authorization.',
        'RMA_INSPECTION_REQUIRED',
      )
      assert(
        !claim.shipmentCandidateIds || claim.shipmentCandidateIds.length === 1,
        'Replacement authorization requires one exact original shipment scope.',
        'REPLACEMENT_SCOPE_AMBIGUOUS',
      )
      const original = originalForClaim(state, claim)
      assert(original, 'Replacement original shipment scope was not found.', 'REPLACEMENT_ORIGINAL_MISSING')
      assert(
        !state.shipments.some((shipment) =>
          shipment.purpose === 'replacement' &&
          shipment.sourceClaimId === claim.id),
        'A replacement shipment already uses this claim.',
        'REPLACEMENT_REUSED',
      )
      const now = this.now()
      assert(
        Date.parse(now) >= Date.parse(claim.updatedAt) &&
          Date.parse(now) >= Date.parse(original.createdAt),
        'Replacement authorization cannot precede the claim, approval, or original shipment.',
        'REPLACEMENT_CHRONOLOGY_INVALID',
      )
      const shipmentId = makeId('shp', `${claim.id}:replacement`)
      const replacement: Shipment = {
        id: shipmentId,
        orderId: original.orderId,
        boxIds: [...claim.remedyBoxIds],
        kind: original.kind,
        purpose: 'replacement',
        sourceClaimId: claim.id,
        replacementForShipmentId: original.id,
        status: 'unfulfilled',
        carrier: original.carrier,
        trackingNumber: `DEMO-${shipmentId.slice(4).toUpperCase()}`,
        insured: original.insured,
        signatureRequired: original.signatureRequired,
        createdAt: now,
        timeline: [{
          id: makeId('stl', `${shipmentId}:authorized`),
          status: 'unfulfilled',
          label: reason,
          at: now,
        }],
      }
      assert(
        !state.shipments.some((shipment) =>
          shipment.id === replacement.id ||
          shipment.trackingNumber === replacement.trackingNumber),
        'Replacement shipment identity is already in use.',
        'REPLACEMENT_REUSED',
      )
      const beforeState = claim.remedyState
      state.shipments.push(replacement)
      claim.remedyState = 'replacement_authorized'
      claim.replacementShipmentId = replacement.id
      claim.replacementAuthorization = { at: now, reason }
      claim.updatedAt = now
      claim.history.push({
        id: `${claim.id}-h-${String(claim.history.length + 1).padStart(2, '0')}`,
        status: claim.status,
        note: reason,
        actorId: actor.id,
        actorRole: actor.role,
        at: now,
      })
      const order = state.orders.find((entry) => entry.id === claim.orderId)
      assert(order, 'Claim order was not found.', 'ORDER_MISSING')
      refreshOrderFulfillment(state, order, now, reason)
      this.audit.append(state, {
        actorId: actor.id,
        actorRole: actor.role,
        action: REPLACEMENT_AUTHORIZED_ACTION,
        targetType: 'claim',
        targetId: claim.id,
        reason,
        at: now,
        requestId: makeId('req', `${claim.id}:replacement:${now}`),
        before: {
          originalShipmentId: original.id,
          remedyState: beforeState,
        },
        after: {
          remedyState: 'replacement_authorized',
          replacementShipmentId: replacement.id,
        },
      })
      return {
        data: replacement,
        changed: true,
        message: 'Replacement shipment was authorized; the claim remains incomplete until delivery.',
      }
    })
  }
}
