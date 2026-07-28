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
}

export class AuditService {
  append(state: DemoState, input: AuditInput) {
    const entry: AuditEntry = {
      id: makeId('audit', `${input.requestId}:${state.audits.length}`),
      ...structuredClone(input),
    }
    state.audits.push(entry)
    return entry
  }

  list(state: DemoState) {
    return [...state.audits].reverse()
  }
}
