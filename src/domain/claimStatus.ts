import type { ClaimStatus } from './types'

export const OPEN_CLAIM_STATUSES: readonly ClaimStatus[] = [
  'submitted',
  'reviewing',
  'approved',
]

export const CLAIM_EVIDENCE_WIDENING_STATUSES: readonly ClaimStatus[] = [
  'submitted',
  'reviewing',
]

export const CLAIM_EVIDENCE_WIDENING_NOTE =
  'Neutral order-level delivery evidence widened after customer resubmission.'

export function isOpenClaimStatus(status: ClaimStatus) {
  return OPEN_CLAIM_STATUSES.includes(status)
}

export function canWidenClaimEvidence(status: ClaimStatus) {
  return CLAIM_EVIDENCE_WIDENING_STATUSES.includes(status)
}
