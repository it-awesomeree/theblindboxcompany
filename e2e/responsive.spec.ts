import { expect, test, type Locator, type Page } from '@playwright/test'

async function expectNoRootOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)
  expect(overflow.bodyScrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1)
}

async function expectInsideViewport(locator: Locator, page: Page) {
  const bounds = await locator.boundingBox()
  const viewport = page.viewportSize()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(-1)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual((viewport?.width ?? 0) + 1)
}

test('responsive shell preserves navigation, legal text, input sizing and important bounds', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('')
  await expect(page.getByText('DEMO PROTOTYPE')).toBeVisible()
  await expect(page.getByRole('heading', { name: /the blind box that always wins/i })).toBeVisible()
  await expect(page.getByText(/proposed demo tagline/i)).toBeVisible()
  await expectInsideViewport(page.locator('.hero-copy'), page)
  await expectInsideViewport(page.locator('.hero-actions'), page)
  await expectInsideViewport(page.locator('.nav-inner'), page)
  await expectNoRootOverflow(page)

  const width = page.viewportSize()?.width ?? 1000
  if (width <= 620) {
    await expect(page.locator('.prize-table thead')).not.toHaveCSS('display', 'none')
  }
  if (width <= 380) {
    for (const name of ['Vault', 'Cart']) {
      const bounds = await page.getByRole('link', { name: new RegExp(`^${name}`) }).boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.width).toBeGreaterThanOrEqual(44)
      expect(bounds!.height).toBeGreaterThanOrEqual(44)
    }
  }
  if (width <= 620) {
    const buyBar = page.locator('.mobile-buy-bar')
    await expect(buyBar).toBeVisible()
    const buttonHeight = await buyBar.locator('.button').evaluate((element) => element.getBoundingClientRect().height)
    expect(buttonHeight).toBeGreaterThanOrEqual(44)
    const clearance = await page.evaluate(() => {
      const legal = document.querySelector('.hero-copy > small')!.getBoundingClientRect()
      const bar = document.querySelector('.mobile-buy-bar')!.getBoundingClientRect()
      return { legalBottom: legal.bottom, barTop: bar.top }
    })
    expect(clearance.legalBottom).toBeLessThanOrEqual(clearance.barTop - 4)
  }

  await page.getByRole('link', { name: /demo sign in/i }).click()
  if (width <= 620) {
    const fontSizes = await page.locator('input, select, textarea').evaluateAll((elements) =>
      elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    )
    expect(fontSizes.length).toBeGreaterThan(0)
    expect(fontSizes.every((size) => size >= 16)).toBe(true)
  }
  await page.getByRole('button', { name: /one-click aina demo/i }).click()
  const accountLink = page.getByRole('link', { name: 'Account', exact: true })
  await expect(accountLink).toBeVisible()
  await expectInsideViewport(accountLink, page)
  await accountLink.click()
  await expect(page.getByRole('heading', { name: 'Aina Demo' })).toBeVisible()
  await expectNoRootOverflow(page)
})

test('WebGL-disabled fallback is the single keyboard opener and visibly opens', async ({ page }) => {
  await page.goto('?nogl=1#/')
  const fallback = page.getByRole('button', { name: /activate boosted demo vault opener/i })
  await expect(fallback).toBeVisible()
  await expect(fallback).toHaveAttribute('tabindex', '0')
  await expect(page.locator('canvas')).toHaveAttribute('tabindex', '-1')
  await fallback.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.hologram')).toBeVisible()
  await expect(fallback).toHaveClass(/is-open/)
  await expect(fallback).toHaveAttribute('aria-pressed', 'true')
})

test('admin mobile keeps fulfilment actions', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Mobile action retention is checked in responsive projects.')
  await page.addInitScript(() => localStorage.clear())
  await page.goto('#/auth')
  await page.getByRole('button', { name: /one-click vault admin/i }).click()
  await page.getByRole('link', { name: 'Fulfilment' }).click()
  await expect(page.getByRole('button', { name: /mark picking/i }).first()).toBeVisible()
  await page.getByRole('button', { name: /edit carrier & tracking/i }).first().click()
  await expect(page.getByLabel(/fictional tracking code/i)).toBeVisible()
  await expect(page.getByRole('button', { name: /review tracking change/i })).toBeVisible()
  await expectNoRootOverflow(page)
})

test('390px phone completes checkout, payment, order, reveal, account and admin flows', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-390', 'One representative phone runs the complete critical journey.')
  await page.addInitScript(() => localStorage.clear())
  await page.goto('')
  await page.getByRole('button', { name: /get a demo box/i }).first().click()
  await page.getByRole('button', { name: /sign in to checkout/i }).click()
  await page.getByRole('button', { name: /one-click aina demo/i }).click()
  await expectInsideViewport(page.getByRole('button', { name: /reserve & continue/i }), page)
  await expectNoRootOverflow(page)
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: /reserve & continue/i }).click()
  await expectInsideViewport(page.getByRole('button', { name: /create pending demo attempt/i }), page)
  await expectNoRootOverflow(page)
  await page.getByRole('button', { name: /create pending demo attempt/i }).click()
  await expectInsideViewport(page.getByRole('button', { name: /approve \+ valid mock webhook/i }), page)
  await expectNoRootOverflow(page)
  await page.getByRole('button', { name: /approve \+ valid mock webhook/i }).click()
  await expectInsideViewport(page.getByRole('link', { name: /view order and boxes/i }), page)
  await expectNoRootOverflow(page)
  await page.getByRole('link', { name: /view order and boxes/i }).click()
  await expectInsideViewport(page.getByRole('link', { name: /open now/i }).first(), page)
  await expectNoRootOverflow(page)
  await page.getByRole('link', { name: /open now/i }).first().click()
  await expectInsideViewport(page.getByRole('button', { name: /break demo seal/i }), page)
  await expectNoRootOverflow(page)
  await page.getByRole('button', { name: /break demo seal/i }).click()
  await expect(page.getByRole('link', { name: /continue to fulfilment/i })).toBeVisible({ timeout: 5000 })
  await expectInsideViewport(page.getByRole('link', { name: /continue to fulfilment/i }), page)
  await expectNoRootOverflow(page)
  await page.getByRole('link', { name: 'Account', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Aina Demo' })).toBeVisible()
  await expectNoRootOverflow(page)

  await page.getByRole('button', { name: /log out/i }).click()
  await page.getByRole('link', { name: /demo sign in/i }).click()
  await page.getByRole('button', { name: /one-click vault admin/i }).click()
  await page.getByRole('link', { name: 'Fulfilment' }).click()
  await expect(page.getByRole('button', { name: /mark picking/i }).first()).toBeVisible()
  await expectNoRootOverflow(page)
})
