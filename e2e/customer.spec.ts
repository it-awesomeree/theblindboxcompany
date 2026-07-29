import { expect, test, type Page } from '@playwright/test'

async function clearAndOpen(page: Page) {
  await page.goto('')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
}

async function reachPaymentSelection(page: Page) {
  await clearAndOpen(page)
  await page.getByRole('button', { name: /get a demo box/i }).first().click()
  await page.getByRole('button', { name: /sign in to checkout/i }).click()
  await page.getByRole('button', { name: /one-click aina demo/i }).click()
  await expect(page.getByRole('heading', { name: /seal the demo order/i })).toBeVisible()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: /reserve & continue/i }).click()
}

async function reachCheckout(page: Page) {
  await reachPaymentSelection(page)
  await page.getByRole('button', { name: /create pending demo attempt/i }).click()
}

const mobile320RemedyTag = '@mobile320-remedy'

test.describe('desktop customer journeys', () => {
  test.beforeEach(({ isMobile }, testInfo) => {
    test.skip(
      isMobile &&
        (testInfo.project.name !== 'mobile-320' || !testInfo.tags.includes(mobile320RemedyTag)),
      'Detailed customer journeys run on desktop; the audited refund regression also runs at 320px.',
    )
  })

  test('safe customer titles and h1 focus survive browser history', async ({ page }) => {
    await clearAndOpen(page)
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click aina demo/i }).click()

    const accountHeading = page.getByRole('heading', { level: 1, name: 'Aina Demo' })
    await expect(accountHeading).toBeFocused()
    await expect(page).toHaveTitle('Account | The Blind Box Company | Demo / No Real Charge')
    expect(await page.title()).not.toMatch(/Aina Demo|aina@example\.test/)

    await page.getByRole('link', { name: /^Cart\b/ }).click()
    const cartHeading = page.getByRole('heading', { level: 1, name: /demo cargo list/i })
    await expect(cartHeading).toBeFocused()
    await expect(page).toHaveTitle('Cart | The Blind Box Company | Demo / No Real Charge')

    await page.goBack()
    await expect(accountHeading).toBeFocused()
    await expect(page).toHaveTitle('Account | The Blind Box Company | Demo / No Real Charge')

    await page.goForward()
    await expect(cartHeading).toBeFocused()
    await expect(page).toHaveTitle('Cart | The Blind Box Company | Demo / No Real Charge')

    await page.goto('#/pay/ord-unopened/new')
    const paymentHeading = page.getByRole('heading', { level: 1, name: /mock hitpay payment/i })
    await expect(paymentHeading).toBeFocused()
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await expect(page).toHaveTitle('Mock Payment | The Blind Box Company | Demo / No Real Charge')
    expect(await page.title()).not.toMatch(/ord-unopened|Aina Demo|aina@example\.test/)
  })

  test('successful mock checkout, valid event and immutable reveal', async ({ page }) => {
    await reachCheckout(page)
    await page.getByRole('button', { name: /approve \+ valid mock webhook/i }).click()
    await expect(page.getByRole('heading', { name: /payment confirmed by event/i })).toBeVisible()
    await page.getByRole('link', { name: /view order and boxes/i }).click()
    await expect(page.getByText(/detailed delivery events stay combined until every box is revealed/i)).toBeVisible()
    await expect(page.getByText(/idempotent mock webhook confirmed payment/i)).toHaveCount(0)
    const openNow = page.getByRole('link', { name: /open now/i }).first()
    await expect(openNow).toBeVisible()
    await openNow.click()
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

  test('CARD stays selected after the new payment route becomes an attempt route', async ({ page }) => {
    await reachPaymentSelection(page)
    const card = page.getByRole('radio', { name: /^card/i })
    await card.check()
    await page.getByRole('button', { name: /create pending demo attempt/i }).click()

    await expect(page.getByText('ATTEMPT 1')).toBeVisible()
    await expect(page.getByRole('radio', { name: /^card/i })).toBeChecked()
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
    await expect(page.getByText('DEMO-SHIPPED')).toBeVisible()
    await expect(page.getByText(/signature required/i)).toBeVisible()
    await page.getByRole('link', { name: /start a demo claim/i }).click()
    await expect(page.getByRole('heading', { name: /start a fake claim/i })).toBeVisible()
  })

  test('sealed order does not expose prize-derived fulfilment details', async ({ page }) => {
    await clearAndOpen(page)
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click aina demo/i }).click()
    await page.goto('#/order/ord-unopened')
    await expect(page.getByText(/useful delivery progress stays visible/i)).toBeVisible()
    const fulfilment = page.getByRole('heading', { name: /private-prize tracking/i }).locator('xpath=ancestor::section[1]')
    await expect(fulfilment.locator('.shipment-card')).toHaveCount(1)
    await expect(fulfilment.locator('.sealed-delivery-summary .status')).toHaveCount(1)
    await expect(page.getByText('DEMO-DELIVERY-ORD-UNOPENED')).toBeVisible()
    await expect(page.getByText(/delivery record 01/i)).toHaveCount(0)
    await expect(page.getByText('DEMO-P-UNOPENED')).toHaveCount(0)
    await expect(page.getByText('Demo Express')).toHaveCount(0)
    await expect(page.getByText('PARCEL', { exact: true })).toHaveCount(0)
    await expect(page.getByText(/signature required/i)).toHaveCount(0)
    await expect(page.getByText('shp-unopened', { exact: false })).toHaveCount(0)
    const timeline = page.getByRole('heading', { name: /order events/i })
      .locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " panel ")][1]')
    await expect(timeline.getByText('Demo order created')).toBeVisible()
    await expect(timeline.getByText('Mock payment confirmed')).toBeVisible()
    await expect(timeline.getByText(/mock webhook confirmed payment/i)).toHaveCount(0)
  })

  test('route changes never carry a reveal or manifest into another sealed box', async ({ page }) => {
    await clearAndOpen(page)
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click aina demo/i }).click()

    await page.goto('#/open/box-refunded-01')
    await expect(page.getByRole('heading', { name: /beras 10kg/i })).toBeVisible()
    await expect(page.getByText(/value manifest \/ immutable record/i)).toBeVisible()

    await page.goto('#/open/box-unopened-01')
    await expect(page.getByRole('button', { name: /break demo seal/i })).toBeVisible()
    await expect(page.getByRole('heading', { name: /beras 10kg/i })).toHaveCount(0)
    await expect(page.getByText(/value manifest \/ immutable record/i)).toHaveCount(0)

    await page.getByRole('button', { name: /break demo seal/i }).click()
    await page.goto('#/open/box-processing-02')
    await page.waitForTimeout(1900)

    await expect(page.getByText(/paid box \/ box-processing-02/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /break demo seal/i })).toBeVisible()
    await expect(page.getByText(/air fryer 5l/i)).toHaveCount(0)
    await expect(page.getByText(/tng reload rm100/i)).toHaveCount(0)
    await expect(page.getByText(/value manifest \/ immutable record/i)).toHaveCount(0)
  })

  test('sealed shipped and delivered orders create eligible neutral claims that survive reload', async ({ page }) => {
    await clearAndOpen(page)
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click aina demo/i }).click()
    await page.evaluate(() => {
      const key = 'tbbc:demo:repository:v5'
      const state = JSON.parse(localStorage.getItem(key)!)
      delete state.boxes.find((box: { id: string }) => box.id === 'box-shipped-01').revealedAt
      delete state.boxes.find((box: { id: string }) => box.id === 'box-delivered-01').revealedAt
      localStorage.setItem(key, JSON.stringify(state))
    })
    await page.reload()

    await page.goto('#/order/ord-shipped')
    await expect(page.getByText('DEMO-DELIVERY-ORD-SHIPPED')).toBeVisible()
    await expect(page.getByText(/delivery record 01/i)).toHaveCount(0)
    await expect(page.getByText('DEMO-P-SHIPPED')).toHaveCount(0)
    await expect(page.getByText('Demo Express')).toHaveCount(0)
    await expect(page.getByText('PARCEL', { exact: true })).toHaveCount(0)
    await expect(page.getByText(/signature required/i)).toHaveCount(0)
    await expect(page.getByText('box-shipped-01', { exact: false })).toHaveCount(0)
    await expect(page.getByText(/airpods/i)).toHaveCount(0)
    await page.getByRole('link', { name: /start a demo claim/i }).click()
    await page.getByLabel('Claim type').selectOption('non_delivery')
    const shippedDelivery = page.getByLabel('Order delivery')
    await expect(shippedDelivery.locator('option', { hasText: /order delivery · eligible neutral record/i })).toHaveCount(1)
    await expect(shippedDelivery).toHaveValue('order-delivery')
    await expect(page.getByText('shp-shipped', { exact: false })).toHaveCount(0)
    await page.getByLabel(/fictional note/i).fill('DEMO: Sealed shipped record is overdue and missing.')
    await page.getByRole('button', { name: /submit demo claim/i }).click()
    await page.reload()
    await expect(page.getByRole('paragraph').filter({ hasText: /sealed shipped record is overdue and missing/i })).toBeVisible()
    await expect(page.getByText('DEMO-DELIVERY-ORD-SHIPPED')).toBeVisible()

    await page.goto('#/claim/new?order=ord-delivered')
    const deliveredDelivery = page.getByLabel('Order delivery')
    await expect(deliveredDelivery.locator('option', { hasText: /order delivery · eligible neutral record/i })).toHaveCount(1)
    await expect(deliveredDelivery).toHaveValue('order-delivery')
    await page.getByLabel(/fictional note/i).fill('DEMO: Sealed delivered carton has physical damage.')
    await page.getByRole('button', { name: /submit demo claim/i }).click()
    await page.reload()
    await expect(page.getByRole('paragraph').filter({ hasText: /sealed delivered carton has physical damage/i })).toBeVisible()
    await expect(page.getByText(/paid prize sealed/i)).toBeVisible()
  })

  test('mixed split order keeps sealed prize-derived shipment clues private', async ({ page }) => {
    await clearAndOpen(page)
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click aina demo/i }).click()
    await page.evaluate(() => {
      const key = 'tbbc:demo:repository:v5'
      const state = JSON.parse(localStorage.getItem(key)!)
      const shipment = state.shipments.find((entry: { id: string }) => entry.id === 'shp-processing')
      for (const [index, status] of ['packed', 'label_created', 'shipped', 'delivered'].entries()) {
        shipment.timeline.push({
          id: `privacy-partial-${index}`,
          status,
          label: `Digital and bulky split clue ${status}`,
          at: `2026-07-22T0${index + 4}:00:00.000Z`,
        })
      }
      shipment.status = 'delivered'
      state.boxes.find((entry: { id: string }) => entry.id === 'box-processing-01').status = 'fulfilled'
      const order = state.orders.find((entry: { id: string }) => entry.id === 'ord-processing')
      order.status = 'partially_fulfilled'
      order.updatedAt = '2026-07-22T07:00:00.000Z'
      order.timeline.push({
        id: 'privacy-partial-order',
        status: 'partially_fulfilled',
        label: 'Digital and bulky split delivery clue must stay private',
        at: order.updatedAt,
      })
      localStorage.setItem(key, JSON.stringify(state))
    })
    await page.reload()
    await page.goto('#/order/ord-processing')
    const fulfilment = page.getByRole('heading', { name: /private-prize tracking/i }).locator('xpath=ancestor::section[1]')
    await expect(fulfilment.locator('.shipment-card')).toHaveCount(1)
    await expect(fulfilment.locator('.sealed-delivery-summary .status')).toHaveCount(1)
    await expect(page.getByText('DEMO-DELIVERY-ORD-PROCESSING')).toBeVisible()
    await expect(fulfilment.getByText('Delivery In Progress')).toBeVisible()
    await expect(page.getByText('Partially Fulfilled')).toHaveCount(0)
    await expect(page.getByText(/digital and bulky split delivery clue/i)).toHaveCount(0)
    await expect(page.getByText('Fulfillment Pending')).toHaveCount(0)
    await expect(page.getByText('Fulfilled')).toHaveCount(0)
    await expect(page.getByText(/delivery record 01|delivery record 02/i)).toHaveCount(0)
    for (const clue of [
      'shp-processing',
      'shp-digital',
      'Demo Bulky Freight',
      'Digital Vault',
      'BULKY',
      'DIGITAL',
      'box-processing-01',
      'box-processing-02',
      'TNG reload RM100',
      'DEMO-P-DIGITAL',
      'DEMO-P-PROCESSING',
    ]) {
      await expect(page.getByText(clue, { exact: false })).toHaveCount(0)
    }
    await expect(page.getByText(/signature required/i)).toHaveCount(0)

    await page.getByRole('link', { name: 'Account', exact: true }).click()
    const accountOrder = page.getByText('ORD-PROCESSING').locator('xpath=ancestor::article[1]')
    await expect(accountOrder.locator('.sealed-delivery-summary')).toHaveCount(1)
    await expect(accountOrder.getByText('DEMO-DELIVERY-ORD-PROCESSING')).toBeVisible()
    await expect(accountOrder.getByText('Delivery In Progress')).toBeVisible()
    await expect(accountOrder.getByText('Partially Fulfilled')).toHaveCount(0)
    await expect(accountOrder.getByText(/record 1:|record 2:/i)).toHaveCount(0)
    await expect(accountOrder.getByText(/maggi|tng reload/i)).toHaveCount(0)
  })

  test('claim-linked exact-scope refund requires exact Payments action and separate Claims finalization', {
    tag: mobile320RemedyTag,
  }, async ({ page }) => {
    await clearAndOpen(page)
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click aina demo/i }).click()
    await page.goto('#/order/ord-shipped')
    await page.getByRole('link', { name: /start a demo claim/i }).click()
    await page.getByLabel('Claim type').selectOption('non_delivery')
    await expect(page.getByLabel(/delivery record/i)).toHaveValue('delivery-record-1')
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
    const claimId = (await claim.locator('summary b').first().textContent())!
    await claim.getByRole('button', { name: /record typed remedy/i }).click()
    const remedyDialog = page.getByRole('dialog', { name: new RegExp(claimId) })
    await expect(remedyDialog.getByRole('group', { name: /choose one exact remedy action/i })).toBeVisible()
    await expect(remedyDialog.getByRole('radio', { name: /open exact claim-scope settlement/i })).toBeChecked()
    await remedyDialog.getByRole('button', { name: /open exact payment/i }).click()

    const payment = page.locator('.payment-record').filter({ hasText: 'pay-shipped' })
    await payment.locator('summary').click()
    await expect(page.getByText(/unrelated payment actions are hidden; leave or clear this claim workflow/i)).toBeVisible()
    await expect(payment.getByRole('button', { name: /unlinked partial refund/i })).toHaveCount(0)
    await expect(payment.getByRole('button', { name: /unlinked refund remaining/i })).toHaveCount(0)
    await expect(payment.getByRole('button', { name: /mark disputed/i })).toHaveCount(0)
    const linkedRefund = payment.getByRole('button', { name: new RegExp(`linked claim ${claimId}.+exact claim-scope settlement rm\\s*112\\.00`, 'i') })
    await expect(linkedRefund).toBeVisible()
    await expect(payment.getByRole('button', { name: /linked claim.+partial/i })).toHaveCount(0)
    await linkedRefund.click()
    const refundDialog = page.getByRole('dialog', { name: new RegExp(`exact claim-scope settlement of rm\\s*112\\.00 for claim ${claimId}`, 'i') })
    await expect(refundDialog).toContainText('pay-shipped')
    await expect(refundDialog).toContainText(/rm\s*112\.00/i)
    await refundDialog.getByRole('button', { name: /confirm exact settlement & audit/i }).click()
    await expect(payment.getByText(new RegExp(`linked claim ${claimId}`, 'i')).first()).toBeVisible()
    await page.getByRole('link', { name: 'Back to claim', exact: true }).click()

    const focusedClaim = page.locator('.claim-record[data-focused="true"]')
    await expect(focusedClaim).toContainText(claimId)
    await expect(focusedClaim.getByText('Approved', { exact: true })).toBeVisible()
    await expect(focusedClaim.getByText(/refund linked.+final claims audit still required/i)).toBeVisible()
    await focusedClaim.getByRole('button', { name: /record typed remedy/i }).click()
    const finalDialog = page.getByRole('dialog', { name: new RegExp(claimId) })
    await expect(finalDialog.getByRole('radio', { name: /finalize exact audited refund link/i })).toBeChecked()
    await finalDialog.getByRole('button', { name: /confirm typed evidence/i }).click()
    await expect(focusedClaim.getByText('Resolved', { exact: true })).toBeVisible()
    await expect(focusedClaim.getByText(/audited refund complete/i)).toBeVisible()

    await page.getByRole('button', { name: /log out/i }).click()
    await page.getByRole('link', { name: /demo sign in/i }).click()
    await page.getByRole('button', { name: /one-click aina demo/i }).click()
    await page.goto('#/order/ord-shipped')
    await expect(page.getByText(/audited refund complete/i).first()).toBeVisible()
  })
})
