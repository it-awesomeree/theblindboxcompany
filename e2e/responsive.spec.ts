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

async function computedThemeColors(page: Page) {
  return page.evaluate(() => {
    const toHex = (value: string) => {
      const channels = value.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) ?? []
      return `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
    }
    const cyanLabel = document.querySelector<HTMLElement>('.demo-opener-label')
    const goldButton = document.querySelector<HTMLElement>('.hero-actions .button')
    return {
      black: toHex(getComputedStyle(document.body).backgroundColor),
      gold: toHex(getComputedStyle(goldButton!).backgroundColor),
      cyan: toHex(getComputedStyle(cyanLabel!).color),
    }
  })
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
  expect(await computedThemeColors(page)).toEqual({
    black: '#080908',
    gold: '#e8b44c',
    cyan: '#72d9ed',
  })
  const importantSmallCopySizes = await page
    .locator('.hero-copy > small, .demo-opener-label')
    .evaluateAll((elements) =>
      elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    )
  expect(importantSmallCopySizes).toHaveLength(2)
  expect(importantSmallCopySizes.every((size) => size >= 11)).toBe(true)

  const width = page.viewportSize()?.width ?? 1000
  if (width <= 768) {
    await expect(page.locator('#pool')).toBeVisible()
    await expect(page.locator('#pool').getByRole('heading', { name: /everything in the box/i })).toBeVisible()
    await expect(page.locator('#how')).toBeVisible()
    await expect(page.locator('#how').getByRole('heading', { name: /simulate payment/i })).toBeVisible()
    await expect(page.locator('#faq')).toBeVisible()
    await expect(page.locator('#faq').getByRole('heading', { name: /ask the awkward ones/i })).toBeVisible()
    await expect(page.locator('.final-cta')).toBeVisible()
    await expect(page.locator('.final-cta').getByRole('button', { name: /get a demo box/i })).toBeVisible()
  }
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
  const fontSizes = await page.locator('input, select, textarea').evaluateAll((elements) =>
    elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  )
  expect(fontSizes.length).toBeGreaterThan(0)
  expect(fontSizes.every((size) => size >= 16)).toBe(true)
  const labelSizes = await page.locator('label').evaluateAll((elements) =>
    elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  )
  expect(labelSizes.length).toBeGreaterThan(0)
  expect(labelSizes.every((size) => size >= 12)).toBe(true)
  await page.getByRole('button', { name: /one-click aina demo/i }).click()
  const accountLink = page.getByRole('link', { name: 'Account', exact: true })
  await expect(accountLink).toBeVisible()
  await expectInsideViewport(accountLink, page)
  await accountLink.click()
  await expect(page.getByRole('heading', { name: 'Aina Demo' })).toBeVisible()
  await expectNoRootOverflow(page)

  await page.getByRole('button', { name: 'Reset demo data' }).click()
  const resetDialog = page.getByRole('dialog', { name: 'Reset all demo data?' })
  const goBackButton = resetDialog.getByRole('button', { name: 'Go back' })
  const confirmResetButton = resetDialog.getByRole('button', { name: 'Confirm demo reset' })
  await expect(resetDialog).toBeVisible()
  await expect(goBackButton).toBeVisible()
  await expect(confirmResetButton).toBeVisible()
  await expectInsideViewport(resetDialog, page)
  await expectInsideViewport(goBackButton, page)
  await expectInsideViewport(confirmResetButton, page)
  await expectNoRootOverflow(page)

  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new Error('Deterministic reset storage failure.')
    }
  })
  await confirmResetButton.click()
  const resetAlert = resetDialog.getByRole('alert')
  await expect(resetAlert).toBeVisible()
  await expect(resetAlert).toContainText(/browser storage could not save this change.+nothing changed.+try again/i)
  await expectInsideViewport(resetAlert, page)
  await expect(resetDialog).toBeVisible()
  await expect(resetDialog).toHaveAttribute('open', '')
  await expectNoRootOverflow(page)
})

test('360px cart keeps a blank quantity draft visible and restores the last committed quantity', async ({ page }) => {
  test.skip(page.viewportSize()?.width !== 360, 'This focused cart regression runs only at 360px.')
  await page.addInitScript(() => localStorage.clear())
  await page.goto('#/cart')
  const quantityInput = page.getByRole('spinbutton', { name: /quantity/i })
  const orderSummary = page.locator('.order-summary')

  await expect(quantityInput).toHaveValue('1')
  await quantityInput.fill('')

  await expect(quantityInput).toHaveValue('')
  await expect(page.getByRole('heading', { name: /your demo cart is empty/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sign in to checkout/i })).toBeVisible()
  await expect(orderSummary).toContainText('RM 100.00')
  await expectNoRootOverflow(page)

  await quantityInput.fill('2')

  await expect(quantityInput).toHaveValue('2')
  await expect(orderSummary).toContainText('RM 200.00')
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('tbbc:demo:repository:v5')!)
    return state.cart[0].quantity
  })).toBe(2)

  await quantityInput.fill('')
  await quantityInput.blur()

  await expect(quantityInput).toHaveValue('2')
  await expect(page.getByRole('heading', { name: /your demo cart is empty/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sign in to checkout/i })).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('tbbc:demo:repository:v5')!)
    return state.cart[0].quantity
  })).toBe(2)
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

test('installed Chrome exercises the live WebGL canvas opener', async ({ page }) => {
  test.skip(process.env.PLAYWRIGHT_BROWSER === 'chromium', 'Bundled Chromium intentionally tests the faithful static fallback.')
  await page.goto('')
  const canvas = page.getByRole('button', { name: /activate boosted demo vault opener/i })
  await expect(canvas).toBeVisible()
  await expect(canvas).toHaveAttribute('tabindex', '0')
  await expect(canvas).toHaveAttribute('data-webgl-renderer', 'live')
  await expect(canvas).toHaveAttribute('data-webgl-frame', '2')
  await expect(page.getByTestId('webgl-fallback')).toBeHidden()
  const liveProof = await canvas.evaluate((element: HTMLCanvasElement) => {
    const gl = element.getContext('webgl')
    return {
      width: element.width,
      height: element.height,
      version: gl?.getParameter(gl.VERSION),
      error: gl?.getError(),
      noError: gl?.NO_ERROR,
    }
  })
  expect(liveProof.width).toBeGreaterThan(0)
  expect(liveProof.height).toBeGreaterThan(0)
  expect(liveProof.version).toMatch(/WebGL/i)
  expect(liveProof.error).toBe(liveProof.noError)
  await canvas.click()
  await expect(page.locator('.hologram')).toBeVisible()
})

test('header keyboard order follows the visible desktop and mobile arrangement', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('')
  const brand = page.getByRole('banner').getByRole('link', { name: /the blind box company demo home/i })
  const mobileSession = page.locator('.nav-session-mobile .nav-action')
  const desktopSession = page.locator('.nav-session-desktop .nav-action')
  const vault = page.getByRole('link', { name: 'Vault', exact: true })
  const cart = page.getByRole('link', { name: /^Cart/ })
  const stackedMobile = (page.viewportSize()?.width ?? 1000) <= 620

  await expect(page.locator('body')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: /skip to content/i })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(brand).toBeFocused()
  await page.keyboard.press('Tab')
  if (stackedMobile) {
    await expect(mobileSession).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(vault).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(cart).toBeFocused()
    await expect(page.locator('.nav-session-desktop')).toBeHidden()
  } else {
    await expect(vault).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(cart).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(desktopSession).toBeFocused()
    await expect(page.locator('.nav-session-mobile')).toBeHidden()
  }
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

test('every mobile viewport completes checkout, payment, order, reveal, account and admin flows', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'The complete mobile journey runs at 360, 390, 430 and 768 widths.')
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
  await expect(page.getByRole('heading', { name: /vault overview/i })).toBeVisible()
  await expectNoRootOverflow(page)

  await page.getByRole('link', { name: 'Users' }).click()
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: 'Aina Demo' })).toBeVisible()
  await expectNoRootOverflow(page)

  await page.getByRole('link', { name: 'Orders', exact: true }).click()
  await page.locator('.admin-record summary').first().click()
  await expect(page.getByRole('heading', { name: 'Snapshot' })).toBeVisible()
  await expectNoRootOverflow(page)

  await page.getByRole('link', { name: 'Payments' }).click()
  await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible()
  await expect(page.locator('.payment-record').first()).toBeVisible()
  await expectNoRootOverflow(page)

  await page.getByRole('link', { name: 'Fulfilment' }).click()
  const markPicking = page.getByRole('button', { name: /mark picking/i }).first()
  await expect(markPicking).toBeVisible()
  await markPicking.click()
  await page.getByRole('button', { name: /confirm scan & audit/i }).click()
  await expect(page.getByText(/shipment moved to picking/i)).toBeVisible()
  await expectNoRootOverflow(page)
})
