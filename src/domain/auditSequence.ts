import type { AuditEntry } from './types'

export interface AuditMoment {
  at: string
  sequence: number
}

export function sameInstant(left: string, right: string) {
  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  return (
    Number.isFinite(leftTime) &&
    Number.isFinite(rightTime) &&
    leftTime === rightTime
  )
}

export function compareAuditMoments(
  left: AuditMoment,
  right: AuditMoment,
) {
  const instantDifference = Date.parse(left.at) - Date.parse(right.at)
  return instantDifference === 0
    ? left.sequence - right.sequence
    : instantDifference
}

export function auditAtOrBefore(
  audit: Pick<AuditEntry, 'at' | 'sequence'>,
  boundary: AuditMoment,
) {
  return compareAuditMoments(audit, boundary) <= 0
}

export function earliestAudit(
  audits: readonly AuditEntry[],
) {
  return [...audits].sort(compareAuditMoments)[0]
}
