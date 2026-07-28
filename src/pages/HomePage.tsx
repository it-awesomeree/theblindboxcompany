import { useState } from 'react'
import { useNavigate } from '../lib/router-core'
import { PRIZES } from '../domain/constants'
import type { PrizeDefinition } from '../domain/types'
import { formatMYR } from '../lib/format'
import { useAppState } from '../state/AppStateContext'
import { PrizePoolTable } from '../components/PrizePoolTable'
import { SectionHeader } from '../components/SectionHeader'
import { VaultCanvas } from '../components/VaultCanvas'

const DEMO_WEIGHTS = [14, 12, 10, 10, 9, 9, 14, 10, 6, 4, 2]
const DEMO_TOTAL = DEMO_WEIGHTS.reduce((sum, weight) => sum + weight, 0)

function boostedPrize(pull: number): PrizeDefinition {
  let cursor = (pull * 37 + 71) % DEMO_TOTAL
  for (let index = 0; index < PRIZES.length; index += 1) {
    if (cursor < DEMO_WEIGHTS[index]) return PRIZES[index]
    cursor -= DEMO_WEIGHTS[index]
  }
  return PRIZES[0]
}

const faq = [
  ['Is the Maggi thing real?', <>No. This fixture labels 100 packets as <b>RM130</b> only to test the proposed value-floor screen. The prototype ships nothing and the amount has not been verified as a current retail price.</>],
  ['So most boxes are groceries?', <>The fictional pool models <b>9,500 of every 10,000 boxes</b> as the dapur tier. That lets reviewers judge whether the proposed disclosure is clear before any legal or commercial approval.</>],
  ['Can I buy one?', <>No. Every order, payment, prize and shipment here is local fake data. The buttons test a journey; they cannot create a purchase or deliver goods.</>],
  ['How is “RM100 of value” calculated?', <>It is not verified in this prototype. The displayed amounts are <b>fixture data for review</b>. A real launch would need current evidence, a defined methodology and legal approval.</>],
  ['What if a demo box opens under RM100?', <>The fake claim form records how a proposed value-floor dispute might look. It does not promise a replacement, refund or entitlement.</>],
  ['Shipping & returns?', <>There is no shipping or returns service. Carrier names, tracking numbers, delivery times and exception states are fictional workflow examples.</>],
]

export function HomePage() {
  const { services } = useAppState()
  const navigate = useNavigate()
  const [pull, setPull] = useState(0)
  const [prize, setPrize] = useState<PrizeDefinition | null>(null)

  const openDemo = () => {
    const next = pull + 1
    setPull(next)
    setPrize(boostedPrize(next))
  }

  const buy = () => {
    services.orders.setCartQuantity(1)
    navigate('/cart')
  }

  return (
    <>
      <section className="vault-hero" aria-labelledby="hero-title">
        <VaultCanvas openSignal={pull} onActivate={openDemo} />
        <div className="vault-grain" aria-hidden="true" />
        <div className="vault-hud" aria-hidden="true">
          <span>CASE 001 / 10,000</span><span>SEAL · INTACT</span><span>DECLARED ≥ RM100</span>
        </div>
        {prize && (
          <div className="hologram" aria-live="polite">
            <div><span>BOOSTED DEMO PULL {String(pull).padStart(2, '0')}</span><span>{prize.tier}</span></div>
            <h2>{prize.name}</h2>
            <p><span>Fixture value</span><b>{formatMYR(prize.valueSen)}</b></p>
            <footer><span>Demo floor ≥ RM100</span><strong>Sample ✓</strong></footer>
          </div>
        )}
        <div className="hero-copy">
          <div className="demo-opener-label">BOOSTED DEMO OPENER · NEVER USED FOR MOCK-PURCHASED BOXES</div>
          <h1 id="hero-title">The blind box<br />that <em>always wins</em></h1>
          <p>RM100 in. Never less than RM100 out.</p>
          <div className="hero-actions">
            <button className="button" type="button" onClick={buy}>Get a demo box — RM100</button>
            <button className="button button-ghost" type="button" onClick={openDemo}>Open boosted demo</button>
          </div>
          <small>Proposed demo tagline · unverified fixture values · no charge or goods · mock-purchased boxes allocate only after a confirmed local event</small>
        </div>
      </section>

      <div className="ticker" aria-hidden="true">
        <div>
          <span>Demo floor rule ≥ RM100</span><i>✦</i><span>Fixture price: RM100</span><i>✦</i>
          <span>95% of fixture boxes are groceries</span><i>✦</i><span>Fixture odds: 1 in 10,000</span><i>✦</i>
          <span>Demo odds printed in full</span><i>✦</i><span>No real purchase</span>
        </div>
      </div>

      <section className="home-section" id="pool">
        <div className="content">
          <SectionHeader code="§01" name="The Pool" meta="11 prizes · 10,000-box case" title={<>Everything in the box.<br />Nothing hidden.</>}>
            <p>Series 001 is seeded per 10,000 boxes. Every prize, declared value, fixed quantity and exact published odds are below.</p>
          </SectionHeader>
          <PrizePoolTable />
        </div>
      </section>

      <section className="home-section floor-section" id="floor">
        <div className="content">
          <SectionHeader code="§02" name="The Floor" meta="Sample · fictional · review" />
          <div className="floor-grid">
            <div className="floor-copy">
              <h2>The RM100 floor is a concept to verify, not a live promise.</h2>
              <p>This prototype shows how a future <strong>Value Manifest</strong> could disclose the item, evidence date and calculation. Its sample prices have not been verified.</p>
              <blockquote>No real box ships and no replacement promise is made here. Commercial language needs evidence, policy and legal approval first.</blockquote>
              <p>Use this screen to review clarity and workflow only.</p>
            </div>
            <div className="manifest" aria-label="Example Value Manifest">
              <div className="manifest-stamp">Demo sample</div>
              <header><b>Value Manifest</b><span>TBBC-2026-000841</span></header>
              <p><span>SERIES</span><i /><b>001 · SEALED CASE</b></p>
              <p><span>PACKED</span><i /><b>27 JUL 2026</b></p>
              <p><span>ITEM 01 · MAGGI KARI 5-PEKET × 20</span><i /><b>RM 130.00</b></p>
              <p><span>UNIT PRICE CHECKED</span><i /><b>RM 1.30 / PEKET</b></p>
              <p><span>SOURCE</span><i /><b>FICTIONAL FIXTURE</b></p>
              <p><span>DEMO FLOOR CHECK ≥ RM100</span><i /><b className="manifest-pass">SAMPLE ✓</b></p>
              <div className="manifest-total"><span>UNVERIFIED DEMO VALUE</span><strong>RM 130.00</strong></div>
              <div className="barcode" />
              <footer><span>THE BLIND BOX COMPANY</span><span>DEMO · NOT VERIFIABLE</span></footer>
            </div>
          </div>
        </div>
      </section>

      <section className="home-section" id="how">
        <div className="content">
          <SectionHeader code="§03" name="How It Works" meta="Three fake-data steps" title="Simulate payment. Reveal once. Review the record." />
          <div className="steps-grid">
            <article><span>01</span><h3>Simulate RM100</h3><p>One fake price and no payment details, bank request or charge.</p><small>Local demo only</small></article>
            <article><span>02</span><h3>Allocate fixture data</h3><p>A confirmed local event stores one immutable fictional prize.</p><small>No real stock moves</small></article>
            <article><span>03</span><h3>Unbox — your way</h3><p>Open now or later. Your paid prize never changes on repeat or refresh.</p><small>One reveal · immutable</small></article>
          </div>
        </div>
      </section>

      <section className="home-section faq-section" id="faq">
        <div className="content">
          <SectionHeader code="§04" name="Questions" meta="Fair questions · straight answers" title="Ask the awkward ones." />
          <div className="faq-list">
            {faq.map(([question, answer], index) => (
              <details key={String(question)} open={index === 0}>
                <summary>{question}</summary><p>{answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="final-cta">
        <div className="content">
          <h2>RM100.<br />Open once.</h2>
          <p>Series 001 · public demo · no real charge.</p>
          <button className="button" type="button" onClick={buy}>Get a demo box — RM100</button>
          <strong>Demo sahaja. Tiada jualan.</strong>
        </div>
      </section>
      <div className="mobile-buy-bar">
        <span><b>Series 001</b><small>RM100 / demo box</small></span>
        <button className="button" type="button" onClick={buy}>Add box</button>
      </div>
    </>
  )
}
