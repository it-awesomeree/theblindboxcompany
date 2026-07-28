import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

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
  it('deploys Pages only from a push to main with elevated rights isolated to deploy', () => {
    const workflow = read('.github/workflows/pages.yml')
    expect(workflow).not.toContain('workflow_dispatch')
    expect(workflow).toMatch(/push:\s*\n\s+branches:\s*\n\s+- main/)
    expect(workflow).toMatch(/^permissions:\s*\n\s+contents: read/m)
    const [beforeDeploy, deployJob] = workflow.split(/^ {2}deploy:/m)
    expect(beforeDeploy).not.toContain('pages: write')
    expect(beforeDeploy).not.toContain('id-token: write')
    expect(deployJob).toContain('pages: write')
    expect(deployJob).toContain('id-token: write')
    expect(workflow).toContain('chrome-e2e:')
    expect(deployJob).toContain('- chrome-e2e')
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
