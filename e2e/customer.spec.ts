import { expect, test, type Page } from '@playwright/test'

async function clearAndOpen(page: Page) {
  await page.goto('')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
}

async function reachCheckout(page: Page) {
  await clearAndOpen(page)
  await page.getByRole('button', { name: /get a demo box/i }).first().click()
  await page.getByRole('button', { name: /sign in to checkout/i }).click()
  await page.getByRole('button', { name: /one-click aina demo/i }).click()
  await expect(page.getByRole('heading', { name: /seal the demo order/i })).toBeVisible()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: /reserve & continue/i }).click()
  await page.getByRole('button', { name: /create pending demo attempt/i }).click()
}

test.describe('desktop customer journeys', () => {
  test.skip(({ isMobile }) => isMobile, 'Detailed journeys run once in installed Chrome.')

  test('successful mock checkout, valid event and immutable reveal', async ({ page }) => {
    await reachCheckout(page)
    await page.getByRole('button', { name: /approve \+ valid mock webhook/i }).click()
    await expect(page.getByRole('heading', { name: /payment confirmed by event/i })).toBeVisible()
    await page.getByRole('link', { name: /view order and boxes/i }).click()
    await expect(page.getByText(/idempotent mock webhook confirmed payment/i)).toBeVisible()
    await page.getByRole('link', { name: /open now/i }).first().click()
    await page.getByRole('button', { name: /break demo seal/i }).click()
    await expect(page.getByRole('link', { name: /continue to fulfilment/i })).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(/value manifest \/ immutable record/i)).toBeVisible()
  })

  test('failure then safe retry creates attempt two', async ({ page }) => {
    await reachCheckout(page)
    await page.getByRole('button', { name: 'Decline' }).click()
    await expect(page.getByText('Failed', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /create idempotent retry/i }).click()
    await expect(page.getByText('ATTEMPT 2')).toBeVisible()
    await page.getByRole('button', { name: /approve \+ valid mock webhook/i }).click()
    await expect(page.getByRole('heading', { name: /payment confirmed by event/i })).toBeVisible()
  })

  test('open later and refresh returns the same reveal', async ({ page }) => {
    await clearAndOpen(page)
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click aina demo/i }).click()
    await page.getByRole('link', { name: /open next box/i }).click()
    await page.getByRole('button', { name: /break demo seal/i }).click()
    const manifest = page.locator('.result-identifiers b').nth(1)
    await expect(manifest).toBeVisible({ timeout: 5000 })
    const manifestId = await manifest.textContent()
    await page.reload()
    const reloadedManifest = page.locator('.result-identifiers b').nth(1)
    await expect(reloadedManifest).toHaveText(manifestId ?? '')
    await expect(reloadedManifest).toBeVisible()
    await expect(page.getByRole('button', { name: /break demo seal/i })).toHaveCount(0)
  })

  test('customer sees shipped tracking and can open claim entry', async ({ page }) => {
    await clearAndOpen(page)
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click aina demo/i }).click()
    await page.goto('#/order/ord-shipped')
    await expect(page.getByText('DEMO-P-SHIPPED')).toBeVisible()
    await expect(page.getByText(/signature required/i)).toBeVisible()
    await page.getByRole('link', { name: /start a demo claim/i }).click()
    await expect(page.getByRole('heading', { name: /start a fake claim/i })).toBeVisible()
  })

  test('sealed order does not expose prize-derived fulfilment details', async ({ page }) => {
    await clearAndOpen(page)
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click aina demo/i }).click()
    await page.goto('#/order/ord-unopened')
    await expect(page.getByText(/fulfilment details stay private until every box/i)).toBeVisible()
    await expect(page.getByText('DEMO-P-UNOPENED')).toHaveCount(0)
    await expect(page.getByText('Demo Express')).toHaveCount(0)
    await expect(page.getByText('PARCEL', { exact: true })).toHaveCount(0)
    await expect(page.getByText(/signature required/i)).toHaveCount(0)
  })

  test('eligible claim moves through protected admin review without an automatic refund', async ({ page }) => {
    await clearAndOpen(page)
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click aina demo/i }).click()
    await page.goto('#/order/ord-shipped')
    await page.getByRole('link', { name: /start a demo claim/i }).click()
    await page.getByLabel('Claim type').selectOption('non_delivery')
    await expect(page.getByLabel(/relevant shipment/i)).toHaveValue('shp-shipped')
    await page.getByLabel(/fictional note/i).fill('DEMO: Shipment is overdue and missing.')
    await page.getByRole('button', { name: /submit demo claim/i }).click()
    await expect(page.getByRole('heading', { name: /claim status & history/i })).toBeVisible()
    await expect(page.locator('.claim-history-card').getByRole('paragraph').filter({ hasText: /shipment is overdue and missing/i })).toBeVisible()

    await page.getByRole('button', { name: /log out/i }).click()
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click vault admin/i }).click()
    await page.getByRole('link', { name: 'Claims', exact: true }).click()
    const claim = page.locator('.claim-record').first()
    await claim.getByRole('button', { name: 'Acknowledge' }).click()
    await page.getByRole('button', { name: /confirm note & audit/i }).click()
    await expect(claim.getByText('Reviewing', { exact: true })).toBeVisible()
    await claim.getByRole('button', { name: 'Approve' }).click()
    await page.getByRole('button', { name: /confirm note & audit/i }).click()
    await expect(claim.getByText('Approved', { exact: true })).toBeVisible()
    await claim.getByRole('button', { name: 'Resolve' }).click()
    await page.getByRole('button', { name: /confirm note & audit/i }).click()
    await expect(claim.getByText('Resolved', { exact: true })).toBeVisible()
    await expect(claim.getByText(/no refund is created here/i)).toBeVisible()
  })
})
