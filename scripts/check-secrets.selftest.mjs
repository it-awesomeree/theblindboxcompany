import assert from 'node:assert/strict'
import { SECRET_PATTERNS, scanPublishableFiles, scanText } from './check-secrets.mjs'

const fixtures = [
  ['private key', ['-----BEGIN ', 'PRIVATE KEY-----'].join('')],
  ['AWS access key', ['AKIA', 'A'.repeat(16)].join('')],
  ['GitHub token', ['ghp_', 'G'.repeat(30)].join('')],
  ['Stripe live key', ['sk_', 'live_', 'S'.repeat(16)].join('')],
  ['HitPay credential', ['hitpay_', 'live_', 'x'.repeat(24)].join('')],
  ['Google OAuth token', ['ya29.', 'x'.repeat(28)].join('')],
  ['bearer credential', ['Authorization: Bearer ', 'x'.repeat(32)].join('')],
  ['assigned secret', ['CLIENT_', 'SECRET=', '"', 'x'.repeat(24), '"'].join('')],
]

const exercisedPatterns = new Set()
for (const [expected, fixture] of fixtures) {
  assert(scanText(fixture).includes(expected), `scanner missed ${expected}`)
  exercisedPatterns.add(expected)
}
const bareHitPayKey = ['ab'.repeat(16), 'cd'.repeat(16)].join('')
assert(
  scanText(['X-BUSINESS-API-KEY: ', bareHitPayKey].join('')).includes('HitPay X-BUSINESS-API-KEY'),
  'scanner missed a raw HitPay header',
)
assert(
  scanText(['headers = { "X-BUSINESS-API-KEY": "', bareHitPayKey, '" }'].join('')).includes('HitPay X-BUSINESS-API-KEY'),
  'scanner missed a HitPay object property',
)
exercisedPatterns.add('HitPay X-BUSINESS-API-KEY')
assert.deepEqual(
  [...exercisedPatterns].sort(),
  SECRET_PATTERNS.map((pattern) => pattern.name).sort(),
  'self-test must exercise every declared credential pattern',
)
assert.deepEqual(scanText(['lockfile-integrity ', bareHitPayKey].join('')), [])
assert.deepEqual(scanText('HITPAY_API_KEY="demo-placeholder"'), [])
assert.deepEqual(scanText('CLIENT_SECRET="redacted-value"'), [])

const unreadable = new Error('simulated read failure')
unreadable.code = 'EACCES'
assert.deepEqual(
  scanPublishableFiles(['docs/unreadable-release-note.md'], () => {
    throw unreadable
  }),
  {
    findings: ['docs/unreadable-release-note.md: could not read publishable file (EACCES)'],
    scanned: 0,
  },
)
assert.deepEqual(
  scanPublishableFiles(['public/binary-reference.png'], () => Buffer.from([1, 0, 2])),
  { findings: [], scanned: 0 },
)
process.stdout.write(
  `Accidental-secrets scanner self-test passed (${SECRET_PATTERNS.length} declared credential patterns, two HitPay header syntaxes, a benign hash, fail-closed reads and binary skipping).\n`,
)
