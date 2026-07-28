import { expect, test, type Page } from '@playwright/test'

async function login(page: Page, kind: 'customer' | 'admin') {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('#/auth')
  await page.getByRole('button', { name: kind === 'admin' ? /one-click vault admin/i : /one-click aina demo/i }).click()
}

async function markPaymentDisputed(page: Page, paymentId: string) {
  const payment = page.locator('.payment-record').filter({ hasText: paymentId })
  await payment.locator('summary').click()
  await payment.getByRole('button', { name: /mark disputed/i }).click()
  const dialog = page.getByRole('dialog', { name: /confirm dispute payment action/i })
  await dialog.getByRole('button', { name: /confirm and audit/i }).click()
  await expect(payment.locator('summary').getByText('Disputed', { exact: true })).toBeVisible()
}

test.describe('desktop admin journeys', () => {
  test.skip(({ isMobile }) => isMobile, 'Detailed admin journeys run once in installed Chrome.')

  test('direct customer access is rejected by service gate', async ({ page }) => {
    await login(page, 'customer')
    await page.goto('#/admin')
    await expect(page.getByRole('heading', { name: /admin access blocked/i })).toBeVisible()
    await expect(page.getByText(/service rejected/i)).toBeVisible()
  })

  test('admin user, order, payment and fulfilment work areas', async ({ page }) => {
    await login(page, 'admin')
    await expect(page.getByRole('heading', { name: /vault overview/i })).toBeVisible()

    await page.getByRole('link', { name: 'Users' }).click()
    await page.getByPlaceholder(/name, fake email/i).fill('Suspended Demo')
    await page.getByRole('button', { name: 'Reactivate' }).click()
    await page.getByRole('button', { name: /confirm reactivation/i }).click()
    await expect(page.getByText(/user is now active/i)).toBeVisible()

    await page.getByRole('link', { name: 'Orders', exact: true }).click()
    await page.locator('.admin-record summary').first().click()
    await expect(page.getByRole('heading', { name: 'Snapshot' })).toBeVisible()
    await expect(page.getByRole('heading', { name: /boxes \/ prize/i })).toBeVisible()

    await page.getByRole('link', { name: 'Payments' }).click()
    await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible()
    await expect(page.locator('.payment-record')).toHaveCount(6)

    await page.getByRole('link', { name: 'Fulfilment' }).click()
    const nextButton = page.getByRole('button', { name: /mark picking/i }).first()
    await nextButton.click()
    await page.getByRole('button', { name: /confirm scan & audit/i }).click()
    await expect(page.getByText(/shipment moved to picking/i)).toBeVisible()
  })

  test('user order drill-down, order filters and guarded tracking entry', async ({ page }) => {
    await login(page, 'admin')
    await page.getByRole('link', { name: 'Users' }).click()
    const ainaRow = page.getByRole('row').filter({ hasText: 'Aina Demo' })
    await ainaRow.getByRole('link', { name: /view 6 orders/i }).click()
    await expect(page.getByText(/showing orders for/i)).toContainText('Aina Demo')
    await expect(page.locator('.admin-record')).toHaveCount(6)

    await page.getByPlaceholder(/order, user, payment or tracking/i).fill('DEMO-P-SHIPPED')
    await expect(page.locator('.admin-record')).toHaveCount(1)
    await expect(page.locator('.admin-record summary')).toContainText('ORD-SHIPPED')
    await page.getByRole('button', { name: /clear filters/i }).click()
    await expect(page.locator('.admin-record')).toHaveCount(6)

    await page.getByRole('link', { name: 'Fulfilment' }).click()
    const shipment = page.locator('.shipment-admin-card').filter({ hasText: 'shp-processing' })
    await shipment.getByRole('button', { name: /edit carrier & tracking/i }).click()
    await shipment.getByLabel(/fictional tracking code/i).fill('DEMO-UPDATED-001')
    await shipment.getByRole('button', { name: /review tracking change/i }).click()
    await page.getByRole('button', { name: /confirm tracking & audit/i }).click()
    await expect(page.getByText(/carrier and tracking were updated and audited/i)).toBeVisible()
    await expect(shipment.getByRole('heading', { name: 'DEMO-UPDATED-001' })).toBeVisible()

    await page.getByRole('link', { name: 'Audit' }).click()
    await expect(page.getByText('shipment.tracking_updated', { exact: true })).toBeVisible()
  })

  test('reset restores deterministic fixtures', async ({ page }) => {
    await login(page, 'admin')
    await page.getByRole('link', { name: 'Inventory' }).click()
    await page.getByRole('button', { name: /copy published series to draft/i }).click()
    await expect(page.getByText(/editable draft copied/i)).toBeVisible()
    await page.getByRole('button', { name: /reset demo data/i }).click()
    const dialog = page.getByRole('dialog', { name: /reset all demo data/i })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: /confirm demo reset/i }).click()
    await page.goto('#/auth')
    await page.getByRole('button', { name: /one-click vault admin/i }).click()
    await page.getByRole('link', { name: 'Inventory' }).click()
    await expect(page.getByRole('button', { name: /copy published series to draft/i })).toBeVisible()
  })

  test('post-delivery return is explicitly confirmed without a refund promise', async ({ page }) => {
    await login(page, 'admin')
    await page.getByRole('link', { name: 'Fulfilment' }).click()
    const delivered = page.locator('.shipment-admin-card').filter({ hasText: 'shp-delivered' })
    await delivered.getByRole('button', { name: /record post-delivery return/i }).click()
    const dialog = page.getByRole('dialog', { name: /record this post-delivery return/i })
    await expect(dialog).toContainText(/does not create a claim or refund/i)
    await dialog.getByRole('button', { name: /confirm return record & audit/i }).click()
    await expect(page.getByText(/no claim or refund was created/i)).toBeVisible()
  })

  test('disputes hide held digital actions, retain physical evidence, and stay finance-only for customers', async ({ page }) => {
    await login(page, 'admin')
    await page.getByRole('link', { name: 'Payments', exact: true }).click()
    await markPaymentDisputed(page, 'pay-processing')
    await markPaymentDisputed(page, 'pay-shipped')

    await page.getByRole('link', { name: 'Fulfilment' }).click()
    const digital = page.locator('.shipment-admin-card').filter({ hasText: 'shp-digital' })
    await expect(digital.getByText('Cancelled', { exact: true })).toBeVisible()
    await expect(digital.locator('.record-actions button')).toHaveCount(0)

    const physical = page.locator('.shipment-admin-card').filter({ hasText: 'shp-shipped' })
    await expect(physical.getByText('Shipped', { exact: true })).toBeVisible()
    await expect(physical.getByRole('button', { name: /mark delivered/i })).toBeVisible()
    await expect(physical.getByRole('button', { name: /delivery exception/i })).toBeVisible()
    await expect(physical.getByRole('button', { name: /edit carrier & tracking/i })).toHaveCount(0)

    await page.getByRole('button', { name: /log out/i }).click()
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click aina demo/i }).click()
    await page.goto('#/pay/ord-processing/pay-processing')

    await expect(page.getByText(/under dispute.+protected finance review/i)).toBeVisible()
    for (const action of [
      /approve \+ valid mock webhook/i,
      /^decline$/i,
      /^cancel$/i,
      /^expire$/i,
      /retry attempt/i,
    ]) {
      await expect(page.getByRole('button', { name: action })).toHaveCount(0)
    }
  })
})
