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

const mobile320RemedyJourneys = new Set([
  'post-delivery return is explicitly confirmed without a refund promise',
  'RMA creation, receipt and inspection keep the approved claim open',
  'delivered replacement resolves its claim while the failed original stays immutable',
  'failed digital delivery and digital reissue use only issue, sent, delivered or failed actions',
])

test.describe('desktop admin journeys', () => {
  test.skip(
    ({ isMobile }, testInfo) =>
      isMobile &&
      (testInfo.project.name !== 'mobile-320' || !mobile320RemedyJourneys.has(testInfo.title)),
    'Detailed admin journeys run on desktop; typed remedy regressions also run at 320px.',
  )

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

  test('RMA creation, receipt and inspection keep the approved claim open', async ({ page }) => {
    await login(page, 'customer')
    await page.goto('#/order/ord-delivered')
    await page.getByRole('link', { name: /start a demo claim/i }).click()
    await page.getByLabel(/fictional note/i).fill('DEMO delivered parcel needs typed return evidence.')
    await page.getByRole('button', { name: /submit demo claim/i }).click()

    await page.getByRole('button', { name: /log out/i }).click()
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click vault admin/i }).click()
    await page.getByRole('link', { name: 'Claims', exact: true }).click()
    const claim = page.locator('.claim-record').first()
    const claimId = (await claim.locator('summary b').first().textContent())!
    await claim.getByRole('button', { name: 'Acknowledge' }).click()
    await page.getByRole('button', { name: /confirm note & audit/i }).click()
    await claim.getByRole('button', { name: 'Approve' }).click()
    await page.getByRole('button', { name: /confirm note & audit/i }).click()

    for (const [choice, state] of [
      [/create physical return \/ rma/i, 'Rma Created'],
      [/record rma received/i, 'Rma Received'],
      [/record rma inspected/i, 'Rma Inspected'],
    ] as const) {
      await claim.getByRole('button', { name: /record typed remedy/i }).click()
      const dialog = page.getByRole('dialog', { name: new RegExp(claimId) })
      await expect(dialog.getByRole('radio', { name: choice })).toBeChecked()
      await dialog.getByRole('button', { name: /confirm typed evidence/i }).click()
      await expect(claim.getByText('Approved', { exact: true })).toBeVisible()
      await expect(claim.getByText(state, { exact: true })).toBeVisible()
    }
    await expect(claim.getByText(/rma evidence · claim remains approved/i)).toBeVisible()
    await expect(claim.getByText(/final read-only evidence/i)).toHaveCount(0)
  })

  test('delivered replacement resolves its claim while the failed original stays immutable', async ({ page }) => {
    await login(page, 'customer')
    await page.goto('#/order/ord-failed')
    await page.getByRole('link', { name: /start a demo claim/i }).click()
    await page.getByLabel('Claim type').selectOption('non_delivery')
    await page.getByLabel(/fictional note/i).fill('DEMO original failed delivery needs replacement.')
    await page.getByRole('button', { name: /submit demo claim/i }).click()

    await page.getByRole('button', { name: /log out/i }).click()
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click vault admin/i }).click()
    await page.getByRole('link', { name: 'Claims', exact: true }).click()
    const claim = page.locator('.claim-record').first()
    const claimId = (await claim.locator('summary b').first().textContent())!
    await claim.getByRole('button', { name: 'Acknowledge' }).click()
    await page.getByRole('button', { name: /confirm note & audit/i }).click()
    await claim.getByRole('button', { name: 'Approve' }).click()
    await page.getByRole('button', { name: /confirm note & audit/i }).click()
    await claim.getByRole('button', { name: /record typed remedy/i }).click()
    const remedyDialog = page.getByRole('dialog', { name: new RegExp(claimId) })
    await remedyDialog.getByRole('radio', { name: /authorize replacement shipment/i }).check()
    await remedyDialog.getByRole('button', { name: /confirm typed evidence/i }).click()
    await expect(claim.getByText('Approved', { exact: true })).toBeVisible()
    await expect(claim.getByText(/claim remains approved until delivery/i)).toBeVisible()
    await claim.getByRole('link', { name: /open linked fulfilment record/i }).click()

    const replacement = page.locator('.shipment-admin-card[data-focused="true"]')
    await expect(replacement.getByText('Replacement shipment', { exact: true })).toBeVisible()
    for (const action of [/mark picking/i, /mark packed/i, /create label/i, /mark shipped/i, /mark delivered/i]) {
      await replacement.getByRole('button', { name: action }).click()
      await page.getByRole('button', { name: /confirm scan & audit/i }).click()
    }
    await expect(replacement.getByText('Delivered', { exact: true })).toBeVisible()
    await replacement.getByRole('link', { name: claimId, exact: true }).click()
    await expect(page.locator('.claim-record[data-focused="true"]').getByText('Resolved', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: /log out/i }).click()
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click aina demo/i }).click()
    await page.goto('#/order/ord-failed')
    const originalScope = page.getByText('shp-failed').locator('xpath=ancestor::article[1]')
    await expect(originalScope.getByText('Failed Delivery', { exact: true })).toBeVisible()
    await expect(originalScope.locator('.remedy-replacement').getByText(/replacement delivered/i)).toBeVisible()
  })

  test('failed digital delivery and digital reissue use only issue, sent, delivered or failed actions', async ({ page }) => {
    await login(page, 'admin')
    await page.getByRole('link', { name: 'Fulfilment' }).click()
    const original = page.locator('.shipment-admin-card').filter({ hasText: 'DIGITAL / shp-digital' })
    for (const action of [/^issue$/i, /mark sent/i, /mark failed/i]) {
      await original.getByRole('button', { name: action }).click()
      await page.getByRole('button', { name: /confirm scan & audit/i }).click()
    }
    await expect(original.getByText('Failed', { exact: true })).toBeVisible()
    await expect(original.getByText(/carrier|tracking/i)).toHaveCount(0)

    await page.getByRole('button', { name: /log out/i }).click()
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click aina demo/i }).click()
    await page.goto('#/claim/new?order=ord-processing')
    await page.getByLabel('Claim type').selectOption('non_delivery')
    await expect(page.getByLabel('Order delivery')).toHaveValue('order-delivery')
    await page.getByLabel(/fictional note/i).fill('DEMO digital delivery failed and needs reissue.')
    await page.getByRole('button', { name: /submit demo claim/i }).click()

    await page.getByRole('button', { name: /log out/i }).click()
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click vault admin/i }).click()
    await page.getByRole('link', { name: 'Claims', exact: true }).click()
    const claim = page.locator('.claim-record').first()
    const claimId = (await claim.locator('summary b').first().textContent())!
    await claim.getByRole('button', { name: 'Acknowledge' }).click()
    await page.getByRole('button', { name: /confirm note & audit/i }).click()
    await claim.getByRole('button', { name: 'Approve' }).click()
    await page.getByRole('button', { name: /confirm note & audit/i }).click()
    await claim.getByRole('button', { name: /record typed remedy/i }).click()
    const remedyDialog = page.getByRole('dialog', { name: new RegExp(claimId) })
    await remedyDialog.getByRole('radio', { name: /authorize digital reissue/i }).check()
    await remedyDialog.getByRole('button', { name: /confirm typed evidence/i }).click()
    await claim.getByRole('link', { name: /open linked fulfilment record/i }).click()

    const reissue = page.locator('.shipment-admin-card[data-focused="true"]')
    await expect(reissue.getByText('Digital reissue', { exact: true })).toBeVisible()
    await expect(reissue.getByText(/carrier|tracking/i)).toHaveCount(0)
    await expect(reissue.getByRole('button', { name: /picking|packed|label|shipped/i })).toHaveCount(0)
    for (const action of [/^issue$/i, /mark sent/i, /mark delivered/i]) {
      await reissue.getByRole('button', { name: action }).click()
      await page.getByRole('button', { name: /confirm scan & audit/i }).click()
    }
    await expect(reissue.getByText('Delivered', { exact: true })).toBeVisible()

    const physical = page.locator('.shipment-admin-card').filter({ hasText: 'BULKY / shp-processing' })
    for (const action of [/mark packed/i, /create label/i, /mark shipped/i, /mark delivered/i]) {
      await physical.getByRole('button', { name: action }).click()
      await page.getByRole('button', { name: /confirm scan & audit/i }).click()
    }
    await page.getByRole('link', { name: 'Orders', exact: true }).click()
    const order = page.locator('.admin-record').filter({ hasText: 'ORD-PROCESSING' })
    await order.locator('summary').click()
    await expect(order.getByText(/2 of 2 original delivery groups complete/i)).toBeVisible()
    await expect(order.getByText(/replacement: delivered/i)).toBeVisible()
    await order.getByRole('button', { name: /close order/i }).click()
    const closeDialog = page.getByRole('dialog', { name: /close this fulfilled order/i })
    await expect(closeDialog).toContainText(/original delivery.+completed audited linked refund.+delivered replacement/i)
    await expect(closeDialog).toContainText(/does not require every shipment row to be delivered/i)
    await closeDialog.getByRole('button', { name: /confirm closure/i }).click()
    await expect(order.getByText('Closed', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: /log out/i }).click()
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click aina demo/i }).click()
    await page.goto('#/open/box-processing-02')
    await page.getByRole('button', { name: /break demo seal/i }).click()
    await expect(page.getByRole('link', { name: /continue to fulfilment/i })).toBeVisible({ timeout: 5000 })
    await page.getByRole('link', { name: /continue to fulfilment/i }).click()
    const digitalScope = page.getByText('shp-digital').locator('xpath=ancestor::article[1]')
    await expect(digitalScope.getByRole('heading', { name: 'Digital delivery' })).toBeVisible()
    await expect(digitalScope.getByText('Failed', { exact: true })).toBeVisible()
    await expect(digitalScope.locator('.remedy-replacement').getByText(/replacement delivered/i)).toBeVisible()
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
