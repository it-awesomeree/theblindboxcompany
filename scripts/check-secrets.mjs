import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const SECRET_PATTERNS = [
  { name: 'private key', value: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'AWS access key', value: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', value: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/ },
  { name: 'Stripe live key', value: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { name: 'Google OAuth token', value: /\bya29\.[A-Za-z0-9_-]{20,}\b/ },
  { name: 'bearer credential', value: /\b(?:authorization\s*:\s*)?bearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/i },
  { name: 'HitPay credential', value: /\bhitpay_(?:live|prod|api|secret|salt)_[A-Za-z0-9_-]{16,}\b/i },
  {
    name: 'HitPay X-BUSINESS-API-KEY',
    value: /(?:^|[\s,{])["']?X-BUSINESS-API-KEY["']?\s*:\s*["']?[a-f0-9]{64}["']?(?=$|[\s,}])/im,
  },
  {
    name: 'assigned secret',
    value: /\b(?:HITPAY_[A-Z0-9_]*(?:KEY|SECRET|SALT)|OAUTH_[A-Z0-9_]*(?:TOKEN|SECRET)|[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|CLIENT_SECRET|WEBHOOK_SECRET|WEBHOOK_SALT|PRIVATE_KEY|PASSWORD))\s*=\s*(?!["']?(?:demo|example|test|redacted|placeholder|change_me|none|null|undefined))(?:"[^"\n]{8,}"|'[^'\n]{8,}'|[A-Za-z0-9._~+/-]{16,}={0,2})/i,
  },
]

export function scanText(body) {
  return SECRET_PATTERNS.filter((pattern) => pattern.value.test(body)).map((pattern) => pattern.name)
}

function publishableFiles() {
  return execFileSync('git', [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    ':!:node_modules/**',
    ':!:dist/**',
    ':!:coverage/**',
    ':!:playwright-report/**',
    ':!:test-results/**',
  ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
}

function readFailureCode(error) {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? ` (${error.code})`
    : ''
}

export function scanPublishableFiles(files, readFile = readFileSync) {
  const findings = []
  let scanned = 0
  for (const file of files) {
    let body
    try {
      const bytes = readFile(file)
      if (bytes.includes(0)) continue
      body = bytes.toString('utf8')
    } catch (error) {
      findings.push(`${file}: could not read publishable file${readFailureCode(error)}`)
      continue
    }
    scanned += 1
    for (const name of scanText(body)) findings.push(`${file}: possible ${name}`)
  }
  return { findings, scanned }
}

function main() {
  const { findings, scanned } = scanPublishableFiles(publishableFiles())
  if (findings.length) {
    process.stderr.write(`Accidental-secrets check failed:\n${findings.join('\n')}\n`)
    process.exit(1)
  }
  process.stdout.write(`Accidental-secrets check passed (${scanned} publishable text files scanned, including legacy and lockfile).\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
