import { makeId } from './guards'
import { sameInstant } from './auditSequence'
import type {
  AuditEntry,
  Claim,
  DemoState,
  LegacyDirectPostDeliveryReplacementEvidence,
  Shipment,
} from './types'

export const LEGACY_DIRECT_REPLACEMENT_MIGRATION_ACTION =
  'migration.v8.direct_post_delivery_replacement'
export const LEGACY_DIRECT_REPLACEMENT_MIGRATION_REASON =
  'Preserved exact schema 8 direct post-delivery replacement history without inventing an RMA'

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactRecord(
  value: unknown,
  expected: Record<string, unknown>,
) {
  if (!record(value)) return false
  const expectedKeys = Object.keys(expected).sort()
  const actualKeys = Object.keys(value)
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every((key) =>
      JSON.stringify(value[key]) === JSON.stringify(expected[key]))
  )
}

export function legacyDirectReplacementMigrationId(claimId: string) {
  return `audit-migration-v9-${makeId('direct-replacement', claimId)}`
}

export function legacyDirectReplacementMigrationRequestId(claimId: string) {
  return makeId('migration-v9-direct-replacement', claimId)
}

export function legacyDirectReplacementMigrationBefore(
  evidence: LegacyDirectPostDeliveryReplacementEvidence,
) {
  return {
    originalShipmentId: evidence.originalShipmentId,
    originalStatusAtMigration: evidence.originalStatusAtMigration,
    replacementShipmentId: evidence.replacementShipmentId,
    replacementStatusAtMigration: evidence.replacementStatusAtMigration,
    schemaVersion: 8,
  }
}

export function legacyDirectReplacementMigrationAfter(
  evidence: LegacyDirectPostDeliveryReplacementEvidence,
) {
  return {
    legacyDirectPostDeliveryReplacement: evidence,
    schemaVersion: 9,
  }
}

export function matchingLegacyDirectReplacementMigrationAudit(
  state: Pick<DemoState, 'audits'>,
  claim: Claim,
  original: Shipment,
  replacement: Shipment,
): AuditEntry | undefined {
  const evidence = claim.legacyDirectPostDeliveryReplacement
  const authorization = claim.replacementAuthorization
  if (
    !evidence ||
    !authorization ||
    evidence.originalShipmentId !== original.id ||
    evidence.replacementShipmentId !== replacement.id ||
    !['delivered', 'returned'].includes(evidence.originalStatusAtMigration)
  ) {
    return undefined
  }
  const matches = state.audits.filter((audit) =>
    audit.id === legacyDirectReplacementMigrationId(claim.id) &&
    audit.outcome === 'applied' &&
    audit.actorId === 'system' &&
    audit.actorRole === 'super_admin' &&
    audit.action === LEGACY_DIRECT_REPLACEMENT_MIGRATION_ACTION &&
    audit.targetType === 'claim' &&
    audit.targetId === claim.id &&
    audit.reason === LEGACY_DIRECT_REPLACEMENT_MIGRATION_REASON &&
    sameInstant(audit.at, authorization.at) &&
    audit.requestId === legacyDirectReplacementMigrationRequestId(claim.id) &&
    audit.eventId === undefined &&
    exactRecord(
      audit.before,
      legacyDirectReplacementMigrationBefore(evidence),
    ) &&
    exactRecord(
      audit.after,
      legacyDirectReplacementMigrationAfter(evidence),
    ))
  return matches.length === 1 ? matches[0] : undefined
}

export function isGrandfatheredDirectPostDeliveryReplacement(
  state: Pick<DemoState, 'audits'>,
  claim: Claim,
  original: Shipment,
  replacement: Shipment,
) {
  return Boolean(
    claim.rma === undefined &&
    matchingLegacyDirectReplacementMigrationAudit(
      state,
      claim,
      original,
      replacement,
    ),
  )
}
