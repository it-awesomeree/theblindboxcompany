import { DomainError } from './guards'

// Each audit evidence field is capped separately at 16 KiB of deterministic UTF-8 JSON.
export const AUDIT_EVIDENCE_MAX_BYTES = 16 * 1024

export type AuditEvidence =
  | null
  | boolean
  | number
  | string
  | AuditEvidence[]
  | { [key: string]: AuditEvidence }

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function invalid(field: string, detail: string): never {
  throw new DomainError(
    `${field} must be safe, deterministic JSON evidence: ${detail}.`,
    'AUDIT_EVIDENCE_INVALID',
  )
}

function dataDescriptor(
  value: object,
  key: PropertyKey,
  field: string,
  path: string,
) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    invalid(field, `${path} contains a hidden or computed property`)
  }
  return descriptor
}

function canonicalizeValue(
  value: unknown,
  field: string,
  path: string,
  ancestors: Set<object>,
): AuditEvidence {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(field, `${path} contains a non-finite number`)
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value !== 'object') {
    invalid(field, `${path} contains an unsupported ${typeof value} value`)
  }
  if (ancestors.has(value)) invalid(field, `${path} contains a cycle`)

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        invalid(field, `${path} uses a custom array class`)
      }
      const ownKeys = Reflect.ownKeys(value)
      if (ownKeys.some((key) => typeof key === 'symbol')) {
        invalid(field, `${path} contains a symbol property`)
      }
      const expectedKeys = new Set([
        ...Array.from({ length: value.length }, (_, index) => String(index)),
        'length',
      ])
      if (
        ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.has(key)) ||
        ownKeys.length !== expectedKeys.size
      ) {
        invalid(field, `${path} is sparse or contains extra properties`)
      }
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = dataDescriptor(value, String(index), field, `${path}[${index}]`)
        return canonicalizeValue(descriptor.value, field, `${path}[${index}]`, ancestors)
      })
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      invalid(field, `${path} uses a custom object class`)
    }
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      invalid(field, `${path} contains a symbol property`)
    }
    const keys = (ownKeys as string[]).sort()
    const canonical: { [key: string]: AuditEvidence } = {}
    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key)) invalid(field, `${path} contains the unsafe key "${key}"`)
      const descriptor = dataDescriptor(value, key, field, `${path}.${key}`)
      canonical[key] = canonicalizeValue(descriptor.value, field, `${path}.${key}`, ancestors)
    }
    return canonical
  } finally {
    ancestors.delete(value)
  }
}

function sameCanonicalValue(value: unknown, canonical: AuditEvidence): boolean {
  if (
    value === null ||
    canonical === null ||
    typeof value !== 'object' ||
    typeof canonical !== 'object'
  ) {
    return Object.is(value, canonical)
  }
  if (Array.isArray(value) || Array.isArray(canonical)) {
    return (
      Array.isArray(value) &&
      Array.isArray(canonical) &&
      value.length === canonical.length &&
      value.every((entry, index) => sameCanonicalValue(entry, canonical[index]))
    )
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return false
  const valueKeys = Object.keys(value)
  const canonicalKeys = Object.keys(canonical)
  return (
    valueKeys.length === canonicalKeys.length &&
    valueKeys.every((key, index) => key === canonicalKeys[index]) &&
    valueKeys.every((key) =>
      sameCanonicalValue((value as Record<string, unknown>)[key], canonical[key]),
    )
  )
}

export function canonicalizeAuditEvidence(value: unknown, field: string): AuditEvidence {
  const canonical = canonicalizeValue(value, field, field, new Set())
  const serialized = JSON.stringify(canonical)
  if (new TextEncoder().encode(serialized).byteLength > AUDIT_EVIDENCE_MAX_BYTES) {
    throw new DomainError(
      `${field} exceeds the ${AUDIT_EVIDENCE_MAX_BYTES}-byte audit evidence limit.`,
      'AUDIT_EVIDENCE_TOO_LARGE',
    )
  }
  return canonical
}

export function validateCanonicalAuditEvidence(value: unknown, field: string): void {
  const canonical = canonicalizeAuditEvidence(value, field)
  if (!sameCanonicalValue(value, canonical)) {
    throw new DomainError(
      `${field} must use canonical JSON values and deterministic object-key ordering.`,
      'AUDIT_EVIDENCE_NOT_CANONICAL',
    )
  }
}
