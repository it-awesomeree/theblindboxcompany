import assert from 'node:assert/strict'
import { scanText } from './check-secrets.mjs'

const fixtures = [
  ['private key', ['-----BEGIN ', 'PRIVATE KEY-----'].join('')],
  ['HitPay credential', ['hitpay_', 'live_', 'x'.repeat(24)].join('')],
  ['Google OAuth token', ['ya29.', 'x'.repeat(28)].join('')],
  ['bearer credential', ['Authorization: Bearer ', 'x'.repeat(32)].join('')],
  ['assigned secret', ['CLIENT_', 'SECRET=', '"', 'x'.repeat(24), '"'].join('')],
]

for (const [expected, fixture] of fixtures) {
  assert(scanText(fixture).includes(expected), `scanner missed ${expected}`)
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
assert.deepEqual(scanText(['lockfile-integrity ', bareHitPayKey].join('')), [])
assert.deepEqual(scanText('HITPAY_API_KEY="demo-placeholder"'), [])
assert.deepEqual(scanText('CLIENT_SECRET="redacted-value"'), [])
process.stdout.write(`Accidental-secrets scanner self-test passed (${fixtures.length + 2} credential families plus a benign hash).\n`)
