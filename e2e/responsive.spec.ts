import { expect, test, type Locator, type Page } from '@playwright/test'

const denseInterfaceSelector = [
  '.demo-banner',
  '.nav-links a',
  '.nav-action',
  '.button',
  '.demo-opener-label',
  '.section-code',
  '.tier',
  '.eyebrow',
  '.panel-heading span',
  '.panel-heading > small',
  '.status',
  '.dialog-code',
  '.admin-bar span',
  '.admin-bar b',
  '.admin-nav a',
  '.table-action',
  '.filter-bar button',
  '.admin-record > summary small',
  '.record-detail-grid h3',
  '.inventory-summary span',
].join(', ')

const actualControlSelector = [
  'button',
  'a.button',
  '.nav-links a',
  '.nav-action',
  '.admin-nav a',
  '.admin-shortcuts a',
  '.queue-list > a',
  '.table-action',
  '.subsection-heading > a',
  'summary',
].join(', ')

interface VisibleMetric {
  element: string
  value: number
}

async function visibleMetrics(
  page: Page,
  selector: string,
  property: 'fontSize' | 'height',
): Promise<VisibleMetric[]> {
  return page.locator(selector).evaluateAll((elements, measuredProperty) =>
    elements.flatMap((element) => {
      const htmlElement = element as HTMLElement
      const style = getComputedStyle(htmlElement)
      const bounds = htmlElement.getBoundingClientRect()
      const intentionallyHidden = htmlElement.matches('.sr-only')
        || htmlElement.closest('.sr-only') !== null
        || htmlElement.matches('.skip-link:not(:focus)')
        || htmlElement.matches('.quantity-control label > span')
      const visible = !intentionallyHidden
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.opacity !== '0'
        && bounds.width > 0
        && bounds.height > 0
      if (!visible) return []
      return [{
        element: `${htmlElement.tagName.toLowerCase()}${htmlElement.className ? `.${String(htmlElement.className).trim().replace(/\s+/g, '.')}` : ''}`,
        value: measuredProperty === 'fontSize'
          ? Number.parseFloat(style.fontSize)
          : bounds.height,
      }]
    }), property)
}

async function expectVisibleFloor(
  page: Page,
  selector: string,
  property: 'fontSize' | 'height',
  floor: number,
) {
  const metrics = await visibleMetrics(page, selector, property)
  expect(metrics.length, `Expected visible elements for ${selector}`).toBeGreaterThan(0)
  expect(
    metrics.filter(({ value }) => value + 0.01 < floor),
    `Expected every visible ${selector} ${property} to be at least ${floor}px`,
  ).toEqual([])
}

async function expectResponsiveInterfaceFloors(page: Page) {
  await expectVisibleFloor(page, denseInterfaceSelector, 'fontSize', 11)
  await expectVisibleFloor(page, actualControlSelector, 'height', 44)
}

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

test('responsive shell preserves navigation, legal text, input sizing and important bounds', async ({ page, isMobile }) => {
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
  const legalText = page.locator('.hero-copy > small')
  const importantSmallCopySizes = await page
    .locator('.hero-copy > small, .demo-opener-label')
    .evaluateAll((elements) =>
      elements.map((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    )
  expect(importantSmallCopySizes).toHaveLength(2)
  expect(importantSmallCopySizes.every((size) => size >= 11)).toBe(true)

  const width = page.viewportSize()?.width ?? 1000
  if (width <= 820) {
    await expectResponsiveInterfaceFloors(page)
  }
  if (isMobile) {
    await expect(page.locator('canvas')).toHaveAttribute('data-render-profile', 'balanced')
  }
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
    await legalText.evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
    await expect(legalText).toBeInViewport()
    const [legalBottom, barTop] = await Promise.all([
      legalText.evaluate((element) => element.getBoundingClientRect().bottom),
      buyBar.evaluate((element) => element.getBoundingClientRect().top),
    ])
    const clearance = { legalBottom, barTop }
    expect(clearance.legalBottom).toBeLessThanOrEqual(clearance.barTop - 4)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  }

  await page.getByRole('link', { name: /demo sign in/i }).click()
  if (width <= 820) {
    await expectVisibleFloor(page, 'input, select, textarea', 'fontSize', 16)
    await expectVisibleFloor(page, 'label', 'fontSize', 12)
    await expectResponsiveInterfaceFloors(page)
  }
  await page.getByRole('button', { name: /one-click aina demo/i }).click()
  const accountLink = page.getByRole('link', { name: 'Account', exact: true })
  await expect(accountLink).toBeVisible()
  await expectInsideViewport(accountLink, page)
  await accountLink.click()
  await expect(page.getByRole('heading', { name: 'Aina Demo' })).toBeVisible()
  await expectNoRootOverflow(page)
  if (width <= 820) {
    await expectResponsiveInterfaceFloors(page)
  }

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
  if (width <= 820) {
    await expectResponsiveInterfaceFloors(page)
  }

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
  const quantityLabel = page.locator('.quantity-control label > span')
  const orderSummary = page.locator('.order-summary')

  await expect(quantityLabel).toHaveCount(1)
  expect(await visibleMetrics(page, '.quantity-control label > span', 'fontSize')).toEqual([])
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

  const routeHeading = page.locator('main h1')
  await expect(routeHeading).toHaveCount(1)
  await expect(routeHeading).toBeFocused()
  await page.locator('body').evaluate((body) => {
    body.tabIndex = -1
    body.focus()
  })
  await expect(page.locator('body')).toBeFocused()
  await page.keyboard.press('Tab')
  const skipToContent = page.getByRole('button', { name: /skip to content/i })
  await expect(skipToContent).toBeFocused()
  await page.locator('body').evaluate((body) => body.removeAttribute('tabindex'))
  await expect(page.locator('body')).not.toHaveAttribute('tabindex')
  await expect(skipToContent).toBeFocused()
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
  await expectVisibleFloor(page, 'input, select, textarea', 'fontSize', 16)
  await expectVisibleFloor(page, 'label', 'fontSize', 12)
  await expectResponsiveInterfaceFloors(page)
})

test('320px typed remedy dialog stays scrollable, labelled, and restores its opener', async ({ page }) => {
  test.skip(page.viewportSize()?.width !== 320, 'This exact dialog overflow regression runs at 320px.')
  await page.addInitScript(() => localStorage.clear())
  await page.goto('#/auth')
  await page.getByRole('button', { name: /one-click aina demo/i }).click()
  await page.goto('#/order/ord-delivered')
  await expectVisibleFloor(page, '.remedy-original span', 'fontSize', 11)
  await expectVisibleFloor(page, '.remedy-original small', 'fontSize', 11)
  await page.getByRole('link', { name: /start a demo claim/i }).click()
  await page.getByLabel(/fictional note/i).fill('DEMO mobile typed remedy dialog evidence.')
  await page.getByRole('button', { name: /submit demo claim/i }).click()
  await page.getByRole('button', { name: /log out/i }).click()
  await page.getByRole('link', { name: /demo sign in/i }).click()
  await page.getByRole('button', { name: /one-click vault admin/i }).click()
  await page.getByRole('link', { name: 'Claims', exact: true }).click()
  const claim = page.locator('.claim-record').first()
  await claim.getByRole('button', { name: 'Acknowledge' }).click()
  await page.getByRole('button', { name: /confirm note & audit/i }).click()
  await claim.getByRole('button', { name: 'Approve' }).click()
  await page.getByRole('button', { name: /confirm note & audit/i }).click()

  const opener = claim.getByRole('button', { name: /record typed remedy/i })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: /record typed remedy for exact claim/i })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-busy', 'false')
  await expect(dialog.getByRole('group', { name: /choose one exact remedy action/i })).toBeVisible()
  await expect(dialog.getByLabel(/required review note/i)).toBeVisible()
  await expectInsideViewport(dialog, page)
  await expectInsideViewport(dialog.getByRole('button', { name: /go back/i }), page)
  await expectInsideViewport(dialog.getByRole('button', { name: /confirm typed evidence/i }), page)
  await expectNoRootOverflow(page)
  await expectResponsiveInterfaceFloors(page)
  const dialogMetrics = await dialog.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    viewportHeight: window.innerHeight,
  }))
  expect(dialogMetrics.clientHeight).toBeLessThanOrEqual(dialogMetrics.viewportHeight - 14)
  expect(dialogMetrics.scrollHeight).toBeGreaterThanOrEqual(dialogMetrics.clientHeight)

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener).toBeFocused()
})

test('66px and 104px sticky site headers keep admin navigation below them after scrolling', async ({ page }) => {
  const width = page.viewportSize()?.width
  test.skip(
    width !== 320 && width !== 390 && width !== 768,
    'This overlap regression covers narrow mobile and tablet header heights.',
  )
  await page.addInitScript(() => localStorage.clear())
  await page.goto('#/auth')
  await page.getByRole('button', { name: /one-click vault admin/i }).click()
  await page.getByRole('link', { name: 'Inventory' }).click()
  await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible()

  await page.evaluate(() => window.scrollTo({ top: 900, behavior: 'instant' }))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)

  const rectangles = await page.evaluate(() => {
    const site = document.querySelector<HTMLElement>('.site-nav')!.getBoundingClientRect()
    const admin = document.querySelector<HTMLElement>('.admin-nav')!.getBoundingClientRect()
    return {
      site: { top: site.top, bottom: site.bottom, height: site.height },
      admin: { top: admin.top, bottom: admin.bottom, height: admin.height },
    }
  })
  expect(rectangles.site.height).toBe(width === 768 ? 66 : 104)
  expect(rectangles.admin.top).toBeGreaterThanOrEqual(rectangles.site.bottom - 1)
  expect(rectangles.admin.height).toBeGreaterThanOrEqual(44)

  await page.getByRole('link', { name: 'Payments' }).click()
  await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Admin navigation' })).toBeVisible()
  await expectNoRootOverflow(page)
})

test('every mobile viewport completes checkout, payment, order, reveal, account and admin flows', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'The complete mobile journey runs at 320, 360, 390, 430 and 768 widths.')
  await page.addInitScript(() => localStorage.clear())
  await page.goto('')
  await page.getByRole('button', { name: /get a demo box/i }).first().click()
  await page.getByRole('button', { name: /sign in to checkout/i }).click()
  await page.getByRole('button', { name: /one-click aina demo/i }).click()
  const checkoutPrimaryLabelSpans = page.locator('label > span:not(.sr-only)')
  const checkoutLabelHelpers = page.locator('label small')
  await expect(checkoutPrimaryLabelSpans).toHaveCount(4)
  await expect(checkoutLabelHelpers).toHaveCount(3)
  await expectVisibleFloor(page, 'label > span:not(.sr-only)', 'fontSize', 12)
  await expectVisibleFloor(page, 'label small', 'fontSize', 11)
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
