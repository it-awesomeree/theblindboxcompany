import { VALUE_FLOOR_SEN } from './constants'
import { sanitizeText } from './guards'
import { exactOddsLabel } from './odds'
import type { FulfilmentKind, PrizeDefinition } from './types'

const TIERS = new Set<PrizeDefinition['tier']>(['Dapur', 'Tech', 'Grail'])
const FULFILMENT_KINDS = new Set<FulfilmentKind>([
  'PARCEL',
  'BULKY',
  'DIGITAL',
  'SELF_COLLECT',
])

function normalizedText(value: unknown, max: number) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === sanitizeText(value, max)
  )
}

export function isValidPrizeDefinition(
  value: unknown,
  allocationTotal: number,
): value is PrizeDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prize = value as PrizeDefinition
  let derivedOdds: string
  try {
    derivedOdds = exactOddsLabel(prize.allocation, allocationTotal)
  } catch {
    return false
  }
  return (
    typeof prize.id === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(prize.id) &&
    normalizedText(prize.name, 120) &&
    normalizedText(prize.shortName, 80) &&
    normalizedText(prize.odds, 40) &&
    prize.odds === derivedOdds &&
    Number.isInteger(prize.valueSen) &&
    prize.valueSen >= VALUE_FLOOR_SEN &&
    Number.isInteger(prize.allocation) &&
    prize.allocation >= 1 &&
    TIERS.has(prize.tier) &&
    FULFILMENT_KINDS.has(prize.fulfilment) &&
    typeof prize.insured === 'boolean' &&
    typeof prize.signatureRequired === 'boolean' &&
    (!prize.signatureRequired || prize.insured)
  )
}
