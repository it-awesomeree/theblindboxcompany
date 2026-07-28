import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

function jobSection(workflow: string, job: string) {
  const marker = `  ${job}:\n`
  const start = workflow.indexOf(marker)
  if (start < 0) throw new Error(`Workflow job ${job} is missing.`)
  const remaining = workflow.slice(start + marker.length)
  const nextJob = remaining.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m)
  return nextJob < 0 ? remaining : remaining.slice(0, nextJob)
}

function channel(hex: string) {
  return Number.parseInt(hex, 16) / 255
}

function luminance(hex: string) {
  const components = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map(channel)
  return components.reduce((sum, value, index) => {
    const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    return sum + linear * [0.2126, 0.7152, 0.0722][index]
  }, 0)
}

describe('release and responsive safety configuration', () => {
  it('builds Pages once, browser-tests that exact dist, then uploads and deploys the same artifact', () => {
    const workflow = read('.github/workflows/pages.yml')
    expect(workflow).not.toContain('workflow_dispatch')
    expect(workflow).toMatch(/push:\s*\n\s+branches:\s*\n\s+- main/)
    expect(workflow).toMatch(/^permissions:\s*\n\s+contents: read/m)
    const [beforeDeploy, deployJob] = workflow.split(/^ {2}deploy:/m)
    expect(beforeDeploy).not.toContain('pages: write')
    expect(beforeDeploy).not.toContain('id-token: write')
    expect(deployJob).toContain('pages: write')
    expect(deployJob).toContain('id-token: write')
    expect(workflow).toContain('build-test-upload:')
    expect(workflow).not.toContain('chrome-e2e:')
    expect(workflow.match(/npm run verify/g)).toHaveLength(1)
    expect(workflow).not.toContain('npm run build')
    expect(workflow).toContain('npm run e2e:dist')
    expect(workflow.indexOf('npm run verify')).toBeLessThan(workflow.indexOf('npm run e2e:dist'))
    expect(workflow.indexOf('npm run e2e:dist')).toBeLessThan(workflow.indexOf('actions/upload-pages-artifact'))
    expect(workflow).toMatch(/upload-pages-artifact@[^\n]+[\s\S]*?path: dist/)
    expect(deployJob).toContain('needs: build-test-upload')
  })

  it('keeps the root error boundary outside provider construction', () => {
    const main = read('src/main.tsx')
    expect(main).toMatch(/<ErrorBoundary>\s*<AppStateProvider>[\s\S]*?<\/AppStateProvider>\s*<\/ErrorBoundary>/)
  })

  it('pins the runner, Node and Playwright package while keeping local Chrome separate from CI Chromium', () => {
    const ci = read('.github/workflows/ci.yml')
    const pages = read('.github/workflows/pages.yml')
    const workflows = `${ci}\n${pages}`
    const packageJson = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>
      devDependencies: Record<string, string>
      engines: { node: string }
      packageManager: string
    }
    const packageLock = JSON.parse(read('package-lock.json')) as {
      packages: Record<string, {
        devDependencies?: Record<string, string>
        engines?: { node?: string }
      }>
    }
    const config = read('playwright.config.ts')
    const runners = [...workflows.matchAll(/runs-on:\s*([^\s]+)/g)]
    const nodeVersions = [...workflows.matchAll(/node-version:\s*([^\s]+)/g)]
    const expectedTimeouts = [
      [ci, 'verify', 10],
      [ci, 'e2e', 20],
      [pages, 'build-test-upload', 25],
      [pages, 'deploy', 5],
    ] as const

    expect(workflows).not.toContain('ubuntu-latest')
    expect(runners.length).toBeGreaterThan(0)
    expect(runners.every((match) => match[1] === 'ubuntu-24.04')).toBe(true)
    expect(nodeVersions.length).toBeGreaterThan(0)
    expect(nodeVersions.every((match) => match[1] === '22.22.3')).toBe(true)
    expect(packageJson.engines).toEqual({ node: '22.22.3' })
    expect(packageJson.packageManager).toBe('npm@10.9.8')
    expect(packageLock.packages[''].engines).toEqual({ node: '22.22.3' })
    expect(workflows.match(/^\s+timeout-minutes:\s+\d+$/gm)).toHaveLength(expectedTimeouts.length)
    for (const [workflow, job, timeout] of expectedTimeouts) {
      expect(jobSection(workflow, job)).toMatch(
        new RegExp(`^ {4}timeout-minutes: ${timeout}$`, 'm'),
      )
    }
    expect(workflows).not.toMatch(/\bnpx playwright\b/)
    expect(workflows).not.toContain('install --with-deps chrome')
    expect(workflows).toContain('./node_modules/.bin/playwright install --with-deps chromium')
    expect(packageJson.devDependencies['@playwright/test']).toBe('1.62.0')
    expect(packageLock.packages[''].devDependencies?.['@playwright/test']).toBe('1.62.0')
    expect(packageJson.scripts.e2e).toBe('playwright test')
    expect(packageJson.scripts['e2e:ci']).toContain('PLAYWRIGHT_BROWSER=chromium')
    expect(packageJson.scripts['e2e:dist']).toContain('PLAYWRIGHT_EXISTING_DIST=1')
    expect(config).toContain("process.env.PLAYWRIGHT_EXISTING_DIST === '1'")
    expect(config).toContain("process.env.PLAYWRIGHT_BROWSER === 'chromium'")
    expect(config).toContain("channel: 'chrome'")
    expect(config).toContain("const previewURL = 'http://127.0.0.1:4173/theblindboxcompany/'")
    expect(config).toContain("const browserBaseURL = useBundledChromium ? `${previewURL}?nogl=1` : previewURL")
    expect(config).toContain('baseURL: browserBaseURL')
    expect(config).toContain('url: previewURL')
    expect(config).toContain('./node_modules/.bin/vite preview --host 127.0.0.1 --port 4173')
    expect(config).not.toContain('npm exec vite preview')
    expect(config).not.toMatch(/webServer:[\s\S]*?url:\s*[^,\n]*nogl/)
    expect(config).toContain('reuseExistingServer: false')
  })

  it('disables checkout credential persistence without changing pinned actions', () => {
    const workflows = readdirSync(resolve(process.cwd(), '.github/workflows'))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => read(`.github/workflows/${name}`))
      .join('\n')
    const checkouts = workflows.split('\n').flatMap((line, index, lines) =>
      line.includes('uses: actions/checkout@')
        ? [{ line, following: lines.slice(index + 1, index + 4).join('\n') }]
        : [],
    )

    expect(checkouts.length).toBeGreaterThan(0)
    for (const checkout of checkouts) {
      expect(checkout.line).toContain('actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4')
      expect(checkout.following).toMatch(/with:\s*\n\s+persist-credentials:\s*false/)
    }
  })

  it('pins every official GitHub Action and rejects mutable major-version tags', () => {
    const workflows = readdirSync(resolve(process.cwd(), '.github/workflows'))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => read(`.github/workflows/${name}`))
      .join('\n')
    const expected = {
      'actions/checkout': { sha: '11d5960a326750d5838078e36cf38b85af677262', version: 'v4' },
      'actions/setup-node': { sha: '49933ea5288caeca8642d1e84afbd3f7d6820020', version: 'v4' },
      'actions/upload-artifact': { sha: 'ea165f8d65b6e75b540449e92b4886f43607fa02', version: 'v4' },
      'actions/upload-pages-artifact': { sha: '56afc609e74202658d3ffba0e8f6dda462b719fa', version: 'v3' },
      'actions/deploy-pages': { sha: 'd6db90164ac5ed86f2b6aed7e0febac5b3c0c03e', version: 'v4' },
    } as const
    const references = [...workflows.matchAll(
      /uses:\s*(actions\/(?:checkout|setup-node|upload-artifact|upload-pages-artifact|deploy-pages))@([^\s#]+)(?:\s+#\s*(v\d+))?/g,
    )]

    expect(workflows).not.toMatch(
      /uses:\s*actions\/(?:checkout|setup-node|upload-artifact|upload-pages-artifact|deploy-pages)@v\d+\b/,
    )
    expect(references.length).toBeGreaterThan(0)
    for (const [, action, reference, versionComment] of references) {
      const pin = expected[action as keyof typeof expected]
      expect(reference).toBe(pin.sha)
      expect(versionComment).toBe(pin.version)
    }
    for (const action of Object.keys(expected) as Array<keyof typeof expected>) {
      expect(references.some(([, referencedAction]) => referencedAction === action)).toBe(true)
    }
  })

  it('keeps responsive table headers available, scoped stamp contrast readable and nav/brand targets large', () => {
    const styles = read('src/styles.css')
    expect(styles).not.toMatch(/\.prize-table thead\s*\{\s*display:\s*none/)
    expect(styles).not.toMatch(/\.admin-table thead\s*\{\s*display:\s*none/)
    expect(styles).toMatch(/:root\s*\{[\s\S]*?--room-2:\s*#0e100f;[\s\S]*?--stamp:\s*#d1452e;/)
    expect(styles).toMatch(/:root\s*\{[\s\S]*?--stamp-dark-surface-text:\s*#d94e37;/)
    expect(styles).toMatch(/\.manifest-stamp\s*\{[\s\S]*?border:\s*3px solid #8f2417;[\s\S]*?color:\s*#8f2417;[\s\S]*?opacity:\s*1;/)
    const paperForeground = luminance('#8f2417')
    const paperBackground = luminance('#efe7d6')
    const paperContrast = (Math.max(paperForeground, paperBackground) + 0.05) / (Math.min(paperForeground, paperBackground) + 0.05)
    expect(paperContrast).toBeGreaterThanOrEqual(4.5)
    const dialogForeground = luminance('#d94e37')
    const dialogBackground = luminance('#0e100f')
    const dialogContrast = (Math.max(dialogForeground, dialogBackground) + 0.05) / (Math.min(dialogForeground, dialogBackground) + 0.05)
    expect(dialogContrast).toBeGreaterThanOrEqual(4.5)
    expect(styles).toMatch(/\.confirm-dialog\s*\{[\s\S]*?background:\s*var\(--room-2\);/)
    expect(styles).toMatch(/\.dialog-code\s*\{\s*color:\s*var\(--stamp-dark-surface-text\);/)
    expect(styles).toMatch(/@media \(max-width: 380px\)[\s\S]*?\.nav-links a\s*\{[\s\S]*?min-width:\s*44px;/)
    expect(styles).toMatch(/\.nav-links a,[\s\S]*?min-height:\s*44px;/)
    expect(styles).toMatch(/\.brand\s*\{[\s\S]*?position:\s*relative;/)
    expect(styles).toMatch(/\.brand::before\s*\{[\s\S]*?width:\s*max\(100%, 44px\);[\s\S]*?height:\s*max\(100%, 44px\);/)
    expect(styles).toMatch(/\.brand-seal\s*\{[\s\S]*?width:\s*29px;[\s\S]*?height:\s*29px;/)
    expect(styles).toMatch(/@media \(max-width: 620px\)[\s\S]*?\.brand-seal\s*\{[\s\S]*?width:\s*26px;[\s\S]*?height:\s*26px;/)
  })
})
