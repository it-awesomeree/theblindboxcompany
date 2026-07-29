import assert from 'node:assert/strict'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectDistFiles,
  scanDistDirectory,
  SECRET_PATTERNS,
  scanPublishableFiles,
  scanText,
} from './check-secrets.mjs'

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

const temporaryRoot = mkdtempSync(join(tmpdir(), 'check-secrets-'))
try {
  const dist = join(temporaryRoot, 'dist')
  const nested = join(dist, 'assets', 'nested')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(dist, 'z-last.txt'), 'safe release text')
  writeFileSync(join(dist, 'a-first.txt'), 'safe release text')
  writeFileSync(join(dist, 'assets', 'middle.txt'), 'safe release text')
  writeFileSync(join(nested, 'binary.bin'), Buffer.from([1, 0, 2]))

  assert.deepEqual(collectDistFiles(dist), [
    join(dist, 'a-first.txt'),
    join(dist, 'assets', 'middle.txt'),
    join(nested, 'binary.bin'),
    join(dist, 'z-last.txt'),
  ])
  assert.deepEqual(scanDistDirectory(dist), { findings: [], scanned: 3 })

  const fakeSecretFile = join(nested, 'constructed-secret.txt')
  writeFileSync(fakeSecretFile, ['CLIENT_', 'SECRET="', 'x'.repeat(24), '"'].join(''))
  assert.deepEqual(scanDistDirectory(dist).findings, [
    `${fakeSecretFile}: possible assigned secret`,
  ])

  const missing = join(temporaryRoot, 'missing-dist')
  assert.throws(() => collectDistFiles(missing))
  const notDirectory = join(temporaryRoot, 'dist-file')
  writeFileSync(notDirectory, 'not a directory')
  assert.throws(() => collectDistFiles(notDirectory), /must be a real directory/)

  const symlink = join(dist, 'linked-file')
  let symlinkSupported = true
  try {
    symlinkSync(join(dist, 'a-first.txt'), symlink)
  } catch (error) {
    symlinkSupported = false
    assert(
      error && typeof error === 'object' && 'code' in error,
      'symlink creation failed without an operating-system error code',
    )
  }
  if (symlinkSupported) {
    assert(lstatSync(symlink).isSymbolicLink())
    assert.throws(() => collectDistFiles(dist), /symbolic links are not allowed/)
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}

process.stdout.write(
  `Accidental-secrets scanner self-test passed (${SECRET_PATTERNS.length} declared credential patterns, dist recursion, findings, fail-closed paths and binary skipping).\n`,
)
