import {
  type LegacyDemoStateV8,
} from '../../src/data/MockRepository'
import { createDemoState } from '../../src/data/fixtures'
import {
  makeId,
  stableHash,
  transitionOrder,
  transitionPayment,
  transitionShipmentForKind,
} from '../../src/domain/guards'
import {
  refreshOrderFulfillment,
  resolveOrderFulfillment,
} from '../../src/domain/orderFulfillment'
import {
  REPLACEMENT_AUTHORIZED_ACTION,
  REPLACEMENT_DELIVERED_ACTION,
  RMA_CREATED_ACTION,
  RMA_INSPECTED_ACTION,
  RMA_RECEIVED_ACTION,
} from '../../src/domain/remedyEvidence'
import type {
  Claim,
  ClaimRemedyState,
  DemoState,
  RmaStatus,
  Shipment,
  ShipmentStatus,
} from '../../src/domain/types'
import { AuditService } from '../../src/services/AuditService'

// Frozen from the exact c3c8c28 writer. The current fixture data differs from
// that commit only by v9 seed audits, so this restores the old one-audit seed
// before applying the old writer's exact claim/RMA/replacement mutations.
export const PREVIOUS_WRITER_CLAIM_ID = 'clm-000000rs-1t0d9ep'
export const PREVIOUS_WRITER_RMA_REFERENCE = 'DEMO-RMA-HEAD-RECEIVED'
export const PREVIOUS_WRITER_DIRECT_REASON =
  'Confirmed authentic direct post-delivery replacement'

const audit = new AuditService()
const customerId = 'usr-demo-customer'
const adminId = 'usr-demo-admin'

function asCurrent(state: LegacyDemoStateV8) {
  return state as unknown as DemoState
}

function appendHistory(
  claim: Claim,
  status: Claim['status'],
  note: string,
  at: string,
) {
  claim.history.push({
    id: `${claim.id}-h-${String(claim.history.length + 1).padStart(2, '0')}`,
    status,
    note,
    actorId: adminId,
    actorRole: 'super_admin',
    at,
  })
}

export function previousWriterApprovedDamageState(): LegacyDemoStateV8 {
  const current = createDemoState()
  const state = structuredClone(current) as unknown as LegacyDemoStateV8
  state.schemaVersion = 8
  state.revision = 6
  state.nextSequence = 1000
  state.sessionUserId = adminId
  state.audits = [structuredClone(current.audits[0])]
  state.auditCount = 1
  state.auditHeadId = state.audits[0].id
  state.claims = []

  const order = state.orders.find((entry) => entry.id === 'ord-delivered')!
  const box = state.boxes.find((entry) => entry.id === 'box-delivered-01')!
  order.claimIds = []

  const createdAt = '2026-07-28T04:00:00.000Z'
  const claimSequence = state.nextSequence
  state.nextSequence += 1
  const serial = claimSequence.toString(36).padStart(8, '0')
  const fingerprint = stableHash(
    `ord-delivered:damage:shp-delivered:${claimSequence}`,
  ).toString(36).padStart(7, '0')
  const claim: Claim = {
    id: `clm-${serial}-${fingerprint}`,
    requestId: `req-claim-${serial}-${fingerprint}`,
    orderId: order.id,
    userId: customerId,
    kind: 'damage',
    note: 'DEMO authentic previous writer delivered damage evidence',
    shipmentId: 'shp-delivered',
    status: 'submitted',
    remedyState: 'none',
    remedyBoxIds: [box.id],
    requiredSettlementSen: 11_200,
    createdAt,
    updatedAt: createdAt,
    history: [{
      id: `${PREVIOUS_WRITER_CLAIM_ID}-h-01`,
      status: 'submitted',
      note: 'DEMO authentic previous writer delivered damage evidence',
      actorId: customerId,
      actorRole: 'customer',
      at: createdAt,
    }],
  }
  if (
    claim.id !== PREVIOUS_WRITER_CLAIM_ID ||
    claim.requestId !== 'req-claim-000000rs-1t0d9ep'
  ) {
    throw new Error('Frozen c3c8c28 claim identity drifted.')
  }
  state.claims.push(claim)
  order.claimIds.push(claim.id)
  refreshOrderFulfillment(
    asCurrent(state),
    order,
    createdAt,
    'Demo claim submitted for review',
  )
  audit.append(asCurrent(state), {
    actorId: customerId,
    actorRole: 'customer',
    action: 'claim.submitted',
    targetType: 'claim',
    targetId: claim.id,
    reason: claim.note,
    at: createdAt,
    requestId: claim.requestId,
    after: {
      kind: 'damage',
      refundCreated: false,
      shipmentId: 'shp-delivered',
      status: 'submitted',
    },
  })

  const acknowledgedAt = '2026-07-28T04:00:01.000Z'
  const acknowledged = 'Confirmed authentic previous writer acknowledgement'
  claim.status = 'reviewing'
  claim.updatedAt = acknowledgedAt
  appendHistory(claim, 'reviewing', acknowledged, acknowledgedAt)
  refreshOrderFulfillment(
    asCurrent(state),
    order,
    acknowledgedAt,
    acknowledged,
  )
  audit.append(asCurrent(state), {
    actorId: adminId,
    actorRole: 'super_admin',
    action: 'claim.acknowledge',
    targetType: 'claim',
    targetId: claim.id,
    reason: acknowledged,
    at: acknowledgedAt,
    requestId: `req-${claim.id}-acknowledge-2`,
    before: { status: 'submitted' },
    after: { refundCreated: false, status: 'reviewing' },
  })

  const approvedAt = '2026-07-28T04:00:02.000Z'
  const approved = 'Confirmed authentic previous writer approval'
  claim.status = 'approved'
  claim.updatedAt = approvedAt
  appendHistory(claim, 'approved', approved, approvedAt)
  refreshOrderFulfillment(
    asCurrent(state),
    order,
    approvedAt,
    approved,
  )
  audit.append(asCurrent(state), {
    actorId: adminId,
    actorRole: 'super_admin',
    action: 'claim.approve',
    targetType: 'claim',
    targetId: claim.id,
    reason: approved,
    at: approvedAt,
    requestId: `req-${claim.id}-approve-3`,
    before: { status: 'reviewing' },
    after: { refundCreated: false, status: 'approved' },
  })
  box.status = 'on_hold'
  return state
}

function previousWriterRmaStep(
  state: LegacyDemoStateV8,
  step: RmaStatus,
  at: string,
  reason: string,
) {
  const claim = state.claims.find((entry) =>
    entry.id === PREVIOUS_WRITER_CLAIM_ID)!
  const order = state.orders.find((entry) => entry.id === claim.orderId)!
  let action: string
  let beforeState: ClaimRemedyState
  let beforeStatus: RmaStatus | null
  let afterState: ClaimRemedyState
  if (step === 'created') {
    claim.rma = {
      reference: PREVIOUS_WRITER_RMA_REFERENCE,
      status: 'created',
      createdAt: at,
      createdReason: reason,
    }
    action = RMA_CREATED_ACTION
    beforeState = 'none'
    beforeStatus = null
    afterState = 'rma_created'
  } else if (step === 'received') {
    claim.rma!.receivedAt = at
    claim.rma!.receivedReason = reason
    claim.rma!.status = 'received'
    action = RMA_RECEIVED_ACTION
    beforeState = 'rma_created'
    beforeStatus = 'created'
    afterState = 'rma_received'
  } else {
    claim.rma!.inspectedAt = at
    claim.rma!.inspectedReason = reason
    claim.rma!.status = 'inspected'
    action = RMA_INSPECTED_ACTION
    beforeState = 'rma_received'
    beforeStatus = 'received'
    afterState = 'rma_inspected'
  }
  claim.remedyState = afterState
  claim.updatedAt = at
  appendHistory(claim, 'approved', reason, at)
  refreshOrderFulfillment(asCurrent(state), order, at, reason)
  audit.append(asCurrent(state), {
    actorId: adminId,
    actorRole: 'super_admin',
    action,
    targetType: 'claim',
    targetId: claim.id,
    reason,
    at,
    requestId: makeId('req', `${claim.id}:rma:${step}:${at}`),
    before: { remedyState: beforeState, rmaStatus: beforeStatus },
    after: {
      remedyState: afterState,
      rmaReference: PREVIOUS_WRITER_RMA_REFERENCE,
      rmaStatus: step,
    },
  })
  state.revision += 1
}

function previousWriterAdvance(
  state: LegacyDemoStateV8,
  shipment: Shipment,
  next: ShipmentStatus,
  at: string,
  reason: string,
) {
  const order = state.orders.find((entry) => entry.id === shipment.orderId)!
  const before = shipment.status
  shipment.status = transitionShipmentForKind(shipment.kind, before, next)
  const sequence = state.nextSequence
  state.nextSequence += 1
  shipment.timeline.push({
    id: makeId('stl', `${shipment.id}:${next}:${at}:${sequence}`),
    status: next,
    label: reason,
    at,
  })
  let deliveredClaim: Claim | undefined
  if (shipment.purpose === 'replacement' && next === 'delivered') {
    const claim = state.claims.find((entry) =>
      entry.id === shipment.sourceClaimId)!
    claim.status = 'resolved'
    claim.remedyState = 'replacement_delivered'
    claim.resolutionOutcome = 'replacement_authorized'
    claim.resolutionReference = shipment.id
    claim.resolutionNote = reason
    claim.updatedAt = at
    appendHistory(claim, 'resolved', reason, at)
    deliveredClaim = claim
  }
  refreshOrderFulfillment(asCurrent(state), order, at, reason)
  audit.append(asCurrent(state), {
    actorId: adminId,
    actorRole: 'super_admin',
    action: 'shipment.transitioned',
    targetType: 'shipment',
    targetId: shipment.id,
    reason,
    at,
    requestId: makeId(
      'req',
      `${shipment.id}:${next}:${at}:${sequence}`,
    ),
    before: { status: before },
    after: {
      financialHoldPreserved: false,
      orderStatus: order.status,
      status: next,
    },
  })
  if (deliveredClaim) {
    audit.append(asCurrent(state), {
      actorId: adminId,
      actorRole: 'super_admin',
      action: REPLACEMENT_DELIVERED_ACTION,
      targetType: 'claim',
      targetId: deliveredClaim.id,
      reason,
      at,
      requestId: makeId(
        'req',
        `${deliveredClaim.id}:replacement-delivered:${at}:${sequence}`,
      ),
      before: {
        remedyState: 'replacement_authorized',
        status: 'approved',
      },
      after: {
        remedyState: 'replacement_delivered',
        replacementShipmentId: shipment.id,
        resolutionOutcome: 'replacement_authorized',
        resolutionReference: shipment.id,
        status: 'resolved',
      },
    })
  }
  state.revision += 1
}

export function previousWriterRmaState(
  status: Extract<RmaStatus, 'received' | 'inspected'>,
  originalReturnedBeforeReceipt = false,
) {
  const state = previousWriterApprovedDamageState()
  previousWriterRmaStep(
    state,
    'created',
    '2026-07-28T04:00:03.000Z',
    'Confirmed authentic previous writer RMA creation',
  )
  let receiptAt = '2026-07-28T04:00:04.000Z'
  if (originalReturnedBeforeReceipt) {
    const original = state.shipments.find((entry) =>
      entry.id === 'shp-delivered')!
    previousWriterAdvance(
      state,
      original,
      'returned',
      receiptAt,
      'Confirmed authentic original return before old receipt',
    )
    receiptAt = '2026-07-28T04:00:05.000Z'
  }
  previousWriterRmaStep(
    state,
    'received',
    receiptAt,
    'Confirmed authentic previous writer RMA receipt',
  )
  if (status === 'inspected') {
    previousWriterRmaStep(
      state,
      'inspected',
      new Date(Date.parse(receiptAt) + 1000).toISOString(),
      'Confirmed authentic previous writer RMA inspection',
    )
  }
  return state
}

function previousWriterAuthorizeReplacement(
  state: LegacyDemoStateV8,
  at: string,
) {
  const claim = state.claims.find((entry) =>
    entry.id === PREVIOUS_WRITER_CLAIM_ID)!
  const original = state.shipments.find((entry) =>
    entry.id === 'shp-delivered')!
  const order = state.orders.find((entry) => entry.id === claim.orderId)!
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
    createdAt: at,
    timeline: [{
      id: makeId('stl', `${shipmentId}:authorized`),
      status: 'unfulfilled',
      label: PREVIOUS_WRITER_DIRECT_REASON,
      at,
    }],
  }
  const beforeState = claim.remedyState
  state.shipments.push(replacement)
  claim.remedyState = 'replacement_authorized'
  claim.replacementShipmentId = replacement.id
  claim.replacementAuthorization = {
    at,
    reason: PREVIOUS_WRITER_DIRECT_REASON,
  }
  claim.updatedAt = at
  appendHistory(claim, 'approved', PREVIOUS_WRITER_DIRECT_REASON, at)
  refreshOrderFulfillment(
    asCurrent(state),
    order,
    at,
    PREVIOUS_WRITER_DIRECT_REASON,
  )
  audit.append(asCurrent(state), {
    actorId: adminId,
    actorRole: 'super_admin',
    action: REPLACEMENT_AUTHORIZED_ACTION,
    targetType: 'claim',
    targetId: claim.id,
    reason: PREVIOUS_WRITER_DIRECT_REASON,
    at,
    requestId: makeId('req', `${claim.id}:replacement:${at}`),
    before: {
      originalShipmentId: original.id,
      remedyState: beforeState,
    },
    after: {
      remedyState: 'replacement_authorized',
      replacementShipmentId: replacement.id,
    },
  })
  state.revision += 1
  return replacement
}

export type PreviousWriterReplacementVariant =
  | 'authorized'
  | 'dispute_resumed'
  | 'dispute_resumed_repeated'
  | 'in_transit'
  | 'terminal'
  | 'inspected_rma'

function previousWriterDisputeStopAndResume(
  state: LegacyDemoStateV8,
  replacement: Shipment,
  cycle: 'first' | 'second' = 'first',
) {
  const order = state.orders.find((entry) =>
    entry.id === replacement.orderId)!
  const payment = state.payments.find((entry) =>
    entry.id === 'pay-delivered')!
  const actor = state.users.find((entry) => entry.id === adminId)!

  const disputedAt = '2026-07-28T04:00:04.000Z'
  const disputeEventId = cycle === 'first'
    ? 'evt-old-direct-dispute'
    : 'evt-old-direct-dispute-repeated'
  const disputeRequestId = makeId('req', disputeEventId)
  const disputeReason =
    'Confirmed authentic old direct replacement dispute'
  const beforePaymentStatus = payment.status
  payment.status = transitionPayment(payment.status, 'disputed')
  payment.updatedAt = disputedAt
  payment.events.push({
    id: disputeEventId,
    requestId: disputeRequestId,
    type: 'disputed',
    source: 'admin_reconcile',
    createdAt: disputedAt,
    processedAt: disputedAt,
  })

  const beforeStop = {
    orderStatus: order.status,
    shipments: state.shipments
      .filter((shipment) => shipment.orderId === order.id)
      .map((shipment) => ({ id: shipment.id, status: shipment.status })),
  }
  replacement.status = transitionShipmentForKind(
    replacement.kind,
    replacement.status,
    'cancelled',
  )
  replacement.timeline.push({
    id: makeId(
      'stl',
      `${replacement.id}:financial-stop:${disputeRequestId}`,
    ),
    status: 'cancelled',
    label: disputeReason,
    at: disputedAt,
    financialHold: 'disputed',
  })
  order.status = transitionOrder(order.status, 'disputed')
  order.updatedAt = disputedAt
  order.timeline.push({
    id: makeId('tl', `${order.id}:financial-stop:${disputeRequestId}`),
    status: 'disputed',
    label: disputeReason,
    at: disputedAt,
    financialHoldPreviousStatus: beforeStop.orderStatus,
  })
  audit.append(asCurrent(state), {
    actorId: actor.id,
    actorRole: actor.role,
    action: 'order.financial_hold_disputed',
    targetType: 'order',
    targetId: order.id,
    reason: disputeReason,
    at: disputedAt,
    requestId: disputeRequestId,
    before: beforeStop,
    after: {
      orderStatus: order.status,
      stoppedShipmentIds: state.shipments
        .filter((shipment) =>
          shipment.orderId === order.id &&
          shipment.status === 'cancelled')
        .map((shipment) => shipment.id),
      heldBoxIds: state.boxes
        .filter((box) =>
          order.boxIds.includes(box.id) &&
          box.status === 'on_hold')
        .map((box) => box.id),
    },
  })
  audit.append(asCurrent(state), {
    actorId: actor.id,
    actorRole: actor.role,
    action: 'payment.disputed',
    targetType: 'payment',
    targetId: payment.id,
    reason: disputeReason,
    at: disputedAt,
    requestId: disputeRequestId,
    eventId: disputeEventId,
    before: { status: beforePaymentStatus },
    after: { status: 'disputed', orderStatus: order.status },
  })
  state.revision += 1

  const resumedAt = disputedAt
  const resumeEventId = cycle === 'first'
    ? 'evt-old-direct-win'
    : 'evt-old-direct-win-repeated'
  const resumeRequestId = makeId('req', resumeEventId)
  const resumeReason =
    'Confirmed authentic old direct replacement merchant won'
  payment.status = transitionPayment(payment.status, 'succeeded')
  payment.updatedAt = resumedAt
  payment.events.push({
    id: resumeEventId,
    requestId: resumeRequestId,
    type: 'succeeded',
    source: 'admin_reconcile',
    createdAt: resumedAt,
    processedAt: resumedAt,
  })
  replacement.status = transitionShipmentForKind(
    replacement.kind,
    replacement.status,
    'unfulfilled',
  )
  replacement.timeline.push({
    id: makeId(
      'stl',
      `${replacement.id}:dispute-resolved:${resumeRequestId}`,
    ),
    status: 'unfulfilled',
    label: resumeReason,
    at: resumedAt,
  })
  const previousStatus =
    order.timeline.at(-1)?.financialHoldPreviousStatus
  const resolution = resolveOrderFulfillment(asCurrent(state), order)
  const restored = (
    previousStatus === 'closed' &&
    resolution.status === 'fulfilled'
  )
    ? 'closed'
    : resolution.status
  order.status = transitionOrder(order.status, restored)
  refreshOrderFulfillment(
    asCurrent(state),
    order,
    resumedAt,
    resumeReason,
  )
  audit.append(asCurrent(state), {
    actorId: actor.id,
    actorRole: actor.role,
    action: 'order.dispute_resolved',
    targetType: 'order',
    targetId: order.id,
    reason: resumeReason,
    at: resumedAt,
    requestId: resumeRequestId,
    before: { status: 'disputed' },
    // Frozen c3c8c28 shape: the richer resumedShipmentIds field did not exist.
    after: { status: restored },
  })
  audit.append(asCurrent(state), {
    actorId: actor.id,
    actorRole: actor.role,
    action: 'payment.succeeded',
    targetType: 'payment',
    targetId: payment.id,
    reason: resumeReason,
    at: resumedAt,
    requestId: resumeRequestId,
    eventId: resumeEventId,
    before: { status: 'disputed' },
    after: { status: 'succeeded', orderStatus: order.status },
  })
  state.revision += 1
}

export function previousWriterReplacementState(
  variant: PreviousWriterReplacementVariant,
) {
  const state = variant === 'inspected_rma'
    ? previousWriterRmaState('inspected')
    : previousWriterApprovedDamageState()
  const claim = state.claims.find((entry) =>
    entry.id === PREVIOUS_WRITER_CLAIM_ID)!
  const authorizationAt = new Date(
    Date.parse(claim.updatedAt) + 1000,
  ).toISOString()
  const replacement = previousWriterAuthorizeReplacement(
    state,
    authorizationAt,
  )
  if (
    variant === 'dispute_resumed' ||
    variant === 'dispute_resumed_repeated'
  ) {
    previousWriterDisputeStopAndResume(state, replacement)
    if (variant === 'dispute_resumed_repeated') {
      previousWriterDisputeStopAndResume(state, replacement, 'second')
    }
    return state
  }
  if (variant === 'authorized' || variant === 'inspected_rma') return state
  const path: ShipmentStatus[] = [
    'picking',
    'packed',
    'label_created',
    'shipped',
  ]
  if (variant === 'terminal') path.push('returned')
  path.forEach((status, index) => {
    previousWriterAdvance(
      state,
      replacement,
      status,
      new Date(
        Date.parse(authorizationAt) + (index + 1) * 1000,
      ).toISOString(),
      `Confirmed authentic previous writer replacement ${status}`,
    )
  })
  return state
}

// This shape is deliberately impossible under the frozen c3c8c28 reader:
// both the original and replacement effectively deliver the same box. It is
// kept only as corrupt-input coverage for the v8 migration fail-closed gate.
export function handEditedPreviousWriterDualDeliveryState() {
  const state = previousWriterReplacementState('in_transit')
  const claim = state.claims.find((entry) =>
    entry.id === PREVIOUS_WRITER_CLAIM_ID)!
  const replacement = state.shipments.find((entry) =>
    entry.id === claim.replacementShipmentId)!
  previousWriterAdvance(
    state,
    replacement,
    'delivered',
    new Date(
      Date.parse(replacement.timeline.at(-1)!.at) + 1000,
    ).toISOString(),
    'Hand-edited impossible previous-writer replacement delivery',
  )
  return state
}
