# The Blind Box Company — public demo prototype

This repository is a **fake-data review prototype**. It looks and behaves like a
store, but it is not connected to a bank, HitPay, Google, email, a database,
shipping company, or a real admin system. It must never be used to take a real
order or accept real money.

The yellow warning at the top of every page is intentional. GitHub Pages only
serves public files; it cannot safely hold payment secrets, passwords, webhook
salts, or a trusted prize allocator.

## Current release status — verified 2026-07-29

- `404ba06033117fa6130dad1075cf12019a99ccd4` is the verified application
  release commit and remains contained in `main`.
- This documentation-only follow-up records the release evidence and does not
  change the application.
- PR #1 is closed and GitHub reports `merged=true`.
- Main CI run `30415550591` completed successfully; its `verify` and `e2e`
  jobs both passed.
- Pages workflow run `30415550658` completed successfully; its
  `build-test-upload` and `deploy` jobs both passed.
- Local verification passed 283/283 tests and found 0 vulnerabilities.
- The live site,
  <https://it-awesomeree.github.io/theblindboxcompany/>, was checked in the
  owner's personal Chrome at 1440×900, 360×800, 390×844, 430×932 and 768×1024.
  No horizontal overflow was found, and the WebGL canvas was visible at every
  size.
- Live customer sign-in, cart, checkout, mock HitPay, payment, order,
  open/reload persistence, and admin dashboard/payment views were verified.
  The created fake record was reset and the test tab was closed.

This release remains a **public, browser-local fake-data demo**. It has no real
HitPay, Google or server backend and must not accept real orders or money.

## What the owner can review

- The original black-and-gold 2050 vault, full prize table, RM100 Value Manifest,
  opener animation, reflection, containment ring and WebGL fallback.
- Customer journey: cart → demo sign-in → checkout → fake HitPay page → payment
  return → paid boxes → open now/later → account → tracking → claims.
- Payment outcomes: approve, decline, cancel, expire, delayed confirmation and
  retry. No payment fields exist and no money can move.
- Admin journey: dashboard, users, orders, payment events/refunds, immutable
  published inventory, editable draft copy, split fulfilment and audit.
- Responsive layouts at 360×800, 390×844, 430×932, 768×1024 and 1440×900.

The root `Reset demo data` control asks for a styled confirmation before it
returns everything to the fictional starting state. Browser storage is
schema-versioned and recovers safely if required collections, counters,
identities or links are damaged. If the initial browser read or safe-fixture
write fails, a visible notice explains that the tab is using memory only. A
startup reservation-cleanup write failure leaves storage active, changes
nothing, and shows that refresh or an explicit retry is safe. A
later update or reset write failure is rejected atomically: the visible and
stored state stay unchanged, a friendly error is shown, and the same storage
remains available for retry.

This is a **single-tab/local simulation**. `localStorage` is not a database,
cannot lock records across people or devices, and cannot provide production
concurrency. One-click admin access and browser-visible prize data are deliberate
demo conveniences, not backend-grade security.

## One-click fictional identities

- **Aina Demo** — customer (`aina@example.test`)
- **Vault Admin** — super admin (`admin@demo.local`)

The fake-email form deliberately has no password field. It accepts only
`example.com`, `example.test`, or `demo.local`. The fake address form blocks
likely real input by requiring `DEMO` in street line 1 and `demo` in the phone.
Customer claim notes must contain the separate word `DEMO` and reject likely
email addresses or realistic phone numbers. Admin review notes remain normal
internal demo notes.

## Run on a computer

Use Node.js 22.22.3 and npm to match CI.

```bash
npm ci
npm run dev
```

Open the local address printed by Vite. The production-style GitHub Pages base
is `/theblindboxcompany/`, while screen routes use a `#` so direct refreshes
work on static hosting.

## Checks

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run e2e
npm run audit:release
npm run verify
npm run verify:all
```

`npm run verify` runs the scanner self-test, then checks all files that Git
could publish for accidental secrets (including legacy files and the lockfile).
It then runs the dependency, code and unit checks, makes one production build,
and checks that exact finished `dist` folder for accidental secrets. The Pages
job uses the same already checked `dist` folder for browser tests and upload; it
does not rebuild it.
`npm run verify:all` adds the complete Playwright matrix. Local `npm run e2e`
uses installed Google Chrome and keeps the animated WebGL vault active. CI
installs the Chromium build pinned by the exact Playwright 1.62.0 lockfile
dependency and opens the same black/gold/cyan page with `?nogl=1`, exercising
the faithful static vault fallback instead of the expensive raymarch renderer.
The preview health-check URL stays query-free, and the query appears before the
route hash. End-to-end checks include customer success, failure/retry,
open-later/refresh, sealed-box tracking and eligible claims through structured
admin resolution, protected admin operations, confirmed reset,
keyboard/runtime WebGL fallback, full commerce/admin journeys at 360, 390, 430
and 768 pixels, input sizing, important element bounds and page-level overflow.
The preview server never reuses an older running server.

Historical pre-merge local verification from 2026-07-28:

- `npm run verify` passed end-to-end. The secret-scanner self-test passed, 85
  publishable text files were scanned, both npm audits found 0 vulnerabilities,
  and lint, typecheck, all 5 Vitest files (246/246 tests) and the production
  build passed.
- `git diff --check` passed.
- Installed Google Chrome Playwright ran all 95 project cases across 1440×900,
  360×800, 390×844, 430×932 and 768×1024: 41 applicable tests passed, 54
  intentional project skips and 0 failed. Live WebGL was verified at every size.
- Bundled Chromium ran the same 95 project cases at the same five sizes: 36
  applicable tests passed, 59 intentional project skips and 0 failed. This run
  used the intentional static vault fallback.

The whole-branch follow-up remediation was verified locally and offline on
2026-07-29:

- Customer routes now remount by the full hash-route identity, malformed
  encoded route values fail safely, sealed boxes cannot reuse a prior reveal,
  and reveal timers are cleaned up.
- Payment and fulfilment buttons now use the same eligibility rules as their
  services. Disputes remain finance-only, retries consider every attempt for
  the order, and digital fulfilment stays locked during financial holds.
- Draft prizes receive strong UI, service and stored-state validation. Open
  claim status has one definition, and sealed order-level claim evidence can
  widen internally without exposing shipment identities only while submitted
  or reviewing. Approved claim evidence is frozen.
- Sealed customers receive a sanitized order/payment timeline, while prize and
  detailed delivery information remain private. Stored order history must begin
  at pending payment. WebGL cleanup unbinds and detaches before deleting its
  shaders, program and buffer.
- The focused regression run passed 277/277 tests. The full 5-file Vitest run
  passed 283/283 tests. The earlier follow-up scan covered 89 files; after the
  lint-clean timeline helper was added, the final scanner self-test and
  90-file publishable-source scan passed. Lint, typecheck, production build and
  `git diff --check` also passed.
- Installed Chrome `npm run e2e` collected all 110 project cases: 44 passed,
  66 intentional project skips and 0 failed. CI-style bundled Chromium
  `npm run e2e:ci` also collected all 110: 39 passed, 71 intentional project
  skips and 0 failed. Every newly added desktop regression executed and passed.
- A manual personal-Chrome comparison at 360, 390, 430, 768 and 1440 pixels
  confirmed black/gold/cyan parity, and the work tab was closed.
- Code-candidate commit `59c04c3315c11cb154a714c186fd25dc46d4746e`
  passed GitHub Actions CI run #10, run ID `30387581184`. Verify job
  `90370635371` succeeded and e2e job `90370837958` succeeded.
- The verify logs prove `npm ci` audited 254 packages with 0 vulnerabilities.
  `npm run verify` passed the 90-file secret scan, both audit commands with 0
  vulnerabilities, lint, typecheck, all 283/283 tests and the production build.
  The e2e job also passed.
- Historical checkpoint note: direct local `npm audit` network access was
  blocked, although the recorded local and remote release audits passed. This
  pre-merge checkpoint is superseded by the successful merge and deployment
  recorded in the current release status above.

The first GitHub CI result is preserved as a historical red result: `verify`
and mobile
passed, but bundled desktop Chromium crashed in three 1440 WebGL-heavy
journeys. The local release candidate now contains and passes the deterministic
static-renderer repair. Commit `0ee805e1ce12fa7e9bdca6a7dab66dfc5ba4ebfe`
passed GitHub Actions CI run #8 on 2026-07-28: both the `verify` and `e2e` jobs
succeeded. This is pre-merge evidence and is superseded by the current release
status above; no reviewer assignment or manual browsing was claimed for that
historical CI run.

`package-lock.json` is committed and generated by `npm install`; CI uses
`npm ci`. React Router was removed because the live audit database currently
marks every published compatible version high severity. A small local hash
router now covers only this static demo’s routes and is exercised by the same
full browser suite.

## Important folders

- `src/domain` — money/state models, exact Series 001 definitions and guards.
- `src/data` — deterministic fictional fixtures and versioned local repository.
- `src/services` — mock auth/payment, order, prize, fulfilment, claims, admin
  and audit rules. Admin protection lives here, not only in the menu.
- `src/pages` and `src/components` — responsive customer/admin interface.
- `tests` and `e2e` — unit, component and browser coverage.
- `docs/FLOWS.md` — simple map of what each demo journey does.
- `docs/PRODUCTION_BACKEND.md` — the separate real-backend plan and security
  boundary.
- `legacy/v3-static-baseline` — frozen, byte-for-byte v3 static page and preview.

The older root/public preview PNG copies are historical visual references only.
The current page does not reference them and Vite does not publish the old
public folder.

## Publishing

The Pages workflow deployed the verified `main` build in run `30415550658`.
It browser-tested the exact `dist` folder with lockfile-pinned Chromium, then
uploaded and deployed that same folder without a second build. This does not
turn the demo into a secure shop. The app keeps `noindex,nofollow`, copies
`.nojekyll`, uses fake fixtures, and contains no secret.

The production build now adds a strict Content Security Policy (CSP) meta tag
and a `no-referrer` meta tag to the published HTML. They are not in the source
`index.html`, so they do not interfere with the local development connection.
The meta CSP is only an extra safety layer for this demo.

GitHub Pages cannot add the custom response headers that a real shop needs.
This demo therefore cannot provide response-header CSP,
`X-Content-Type-Options`, `Permissions-Policy`, or dependable protection
against another site framing it. Browsers ignore `frame-ancestors` in a meta
CSP, and `X-Frame-Options` cannot be set with a meta tag. HSTS is supplied by
the GitHub Pages platform when HTTPS enforcement is enabled; it is not supplied
by this app. A real production host or proxy must control and test all security
response headers.

**PRODUCTION LAUNCH: STOP.** Before any real commercial launch, use the separate backend described in
`docs/PRODUCTION_BACKEND.md`, obtain Malaysian legal/compliance advice, verify
all prize/value claims, register production HitPay webhooks, and complete
security, PDPA, fulfilment, refund and monitoring readiness.
