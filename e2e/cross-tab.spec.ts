import { expect, test, type Page } from '@playwright/test'

test('one active tab hands exact persisted demo state to the next waiting tab', async ({
  context,
  page: page1,
  isMobile,
}) => {
  test.skip(isMobile, 'Cross-tab write authority is exercised once on desktop.')
  let page2: Page | undefined

  try {
    await page1.addInitScript(() => localStorage.clear())
    await page1.goto('#/auth')
    await expect(page1.getByRole('heading', { name: /enter the demo vault/i })).toBeVisible()

    page2 = await context.newPage()
    await page2.addInitScript(() => {
      const trackedWindow = window as typeof window & {
        __tbbcStorageEvents?: Array<string | null>
      }
      trackedWindow.__tbbcStorageEvents = []
      window.addEventListener('storage', (event) => {
        if (event.key === 'tbbc:demo:repository:v5') {
          trackedWindow.__tbbcStorageEvents!.push(event.newValue)
        }
      })
    })
    await page2.goto('#/cart')
    await expect(page2.getByRole('heading', { name: /safely waiting in read-only mode/i }))
      .toBeVisible()
    await expect(page2.locator('button, a, input, select, textarea')).toHaveCount(0)

    await page1.getByRole('button', { name: /one-click aina demo/i }).click()
    await page1.getByRole('link', { name: /^Cart/ }).click()
    const page1Quantity = page1.getByRole('spinbutton', { name: /quantity/i })
    await page1Quantity.fill('2')
    await expect(page1Quantity).toHaveValue('2')
    await expect.poll(() => page1.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('tbbc:demo:repository:v5')!)
      return state.cart[0].quantity
    })).toBe(2)

    const beforeHandoff = await page1.evaluate(() =>
      JSON.parse(localStorage.getItem('tbbc:demo:repository:v5')!),
    )
    expect(beforeHandoff.sessionUserId).toBe('usr-demo-customer')
    expect(beforeHandoff.cart[0].quantity).toBe(2)
    await expect.poll(() => page2!.evaluate(() => {
      const trackedWindow = window as typeof window & {
        __tbbcStorageEvents?: Array<string | null>
      }
      return trackedWindow.__tbbcStorageEvents?.at(-1)
    })).toBe(JSON.stringify(beforeHandoff))

    await page1.close()

    await expect(page2.getByRole('heading', { name: /demo cargo list/i })).toBeVisible()
    await expect(page2.getByRole('link', { name: 'Account', exact: true })).toBeVisible()
    const page2Quantity = page2.getByRole('spinbutton', { name: /quantity/i })
    await expect(page2Quantity).toHaveValue('2')
    expect(await page2.evaluate(() =>
      JSON.parse(localStorage.getItem('tbbc:demo:repository:v5')!),
    )).toEqual(beforeHandoff)

    await page2Quantity.fill('3')
    await expect(page2Quantity).toHaveValue('3')
    await expect.poll(() => page2!.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('tbbc:demo:repository:v5')!)
      return state.cart[0].quantity
    })).toBe(3)

    const afterHandoff = await page2.evaluate(() =>
      JSON.parse(localStorage.getItem('tbbc:demo:repository:v5')!),
    )
    expect(afterHandoff.revision).toBe(beforeHandoff.revision + 1)
    expect(afterHandoff.sessionUserId).toBe(beforeHandoff.sessionUserId)
    const normalizedAfter = structuredClone(afterHandoff)
    normalizedAfter.revision = beforeHandoff.revision
    normalizedAfter.cart = beforeHandoff.cart
    expect(normalizedAfter).toEqual(beforeHandoff)
  } finally {
    if (page2 && !page2.isClosed()) await page2.close()
    if (!page1.isClosed()) await page1.close()
  }
})

test('an invalid external storage event visibly stops both active and waiting tabs', async ({
  context,
  page: page1,
  isMobile,
}) => {
  test.skip(isMobile, 'Cross-tab storage failure handling is exercised once on desktop.')
  let page2: Page | undefined

  try {
    await page1.addInitScript(() => localStorage.clear())
    await page1.goto('#/auth')
    await expect(page1.getByRole('heading', { name: /enter the demo vault/i })).toBeVisible()

    page2 = await context.newPage()
    await page2.goto('#/cart')
    await expect(page2.getByRole('heading', { name: /safely waiting in read-only mode/i }))
      .toBeVisible()

    await page1.evaluate(() => {
      localStorage.setItem('tbbc:demo:repository:v5', '{invalid-external-json')
    })

    await expect(page2.getByRole('heading', { name: /demo safety check stopped this tab/i }))
      .toBeVisible()
    await expect(page1.getByRole('heading', { name: /enter the demo vault/i }))
      .toBeVisible()

    await page1.evaluate(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'tbbc:demo:repository:v5',
        newValue: '{invalid-external-json',
        storageArea: localStorage,
      }))
    })

    await expect(page1.getByRole('heading', { name: /demo safety check stopped this tab/i }))
      .toBeVisible()
    await expect(page1.getByText(/browser data became invalid, older, or conflicted/i))
      .toBeVisible()
    await expect(page1.locator('button, a, input, select, textarea')).toHaveCount(0)
    await expect(page2.locator('button, a, input, select, textarea')).toHaveCount(0)
  } finally {
    if (page2 && !page2.isClosed()) await page2.close()
    if (!page1.isClosed()) await page1.close()
  }
})

test('a browser without Web Locks shows a non-interactive safety screen', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'Web Locks feature detection is exercised once on desktop.')
  await page.addInitScript(() => {
    localStorage.clear()
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    })
  })
  await page.goto('#/auth')

  await expect(page.getByRole('heading', { name: /demo safety check stopped this tab/i }))
    .toBeVisible()
  await expect(page.getByText(/does not support the Web Lock/i)).toBeVisible()
  await expect(page.locator('button, a, input, select, textarea')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('tbbc:demo:repository:v5')))
    .toBeNull()
})
