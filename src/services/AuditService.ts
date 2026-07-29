import { canonicalizeAuditEvidence } from '../domain/auditEvidence'
import { makeId } from '../domain/guards'
import type { AuditEntry, DemoState, Role } from '../domain/types'

export interface AuditInput {
  actorId: string
  actorRole: Role
  action: string
  targetType: string
  targetId: string
  reason: string
  at: string
  before?: unknown
  after?: unknown
  requestId: string
  eventId?: string
  outcome?: AuditEntry['outcome']
}

export class AuditService {
  append(state: DemoState, input: AuditInput) {
    const before = Object.prototype.hasOwnProperty.call(input, 'before')
      ? canonicalizeAuditEvidence(input.before, 'Audit before evidence')
      : undefined
    const after = Object.prototype.hasOwnProperty.call(input, 'after')
      ? canonicalizeAuditEvidence(input.after, 'Audit after evidence')
      : undefined
    const { outcome = 'applied' } = input
    const entry: AuditEntry = {
      id: makeId('audit', `${input.requestId}:${state.auditCount}`),
      sequence: state.auditCount + 1,
      ...(state.auditHeadId ? { previousId: state.auditHeadId } : {}),
      outcome,
      actorId: input.actorId,
      actorRole: input.actorRole,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      at: input.at,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
      requestId: input.requestId,
      ...(input.eventId !== undefined ? { eventId: input.eventId } : {}),
    }
    state.audits.push(entry)
    state.auditCount = entry.sequence
    state.auditHeadId = entry.id
    return entry
  }

  list(state: DemoState) {
    return [...state.audits].reverse()
  }
}
