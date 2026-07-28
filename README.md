# The Blind Box Company — public demo prototype

This repository is a **fake-data review prototype**. It looks and behaves like a
store, but it is not connected to a bank, HitPay, Google, email, a database,
shipping company, or a real admin system. It must never be used to take a real
order.

The yellow warning at the top of every page is intentional. GitHub Pages only
serves public files; it cannot safely hold payment secrets, passwords, webhook
salts, or a trusted prize allocator.

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

`npm run verify` performs the scanner self-test, full publishable-source
accidental-secrets scan (including legacy and lockfile), zero-high dependency
audit, lint, type check, unit tests and production build. `npm run verify:all`
adds the complete Playwright matrix. Local `npm run e2e` uses installed Google
Chrome and keeps the animated WebGL vault active. CI installs the Chromium
build pinned by the exact Playwright 1.62.0 lockfile dependency and opens the
same black/gold/cyan page with `?nogl=1`, exercising the faithful static vault
fallback instead of the expensive raymarch renderer. The preview health-check
URL stays query-free, and the query appears before the route hash. End-to-end
checks include customer success, failure/retry, open-later/refresh, sealed-box
tracking and eligible claims through structured admin resolution, protected
admin operations, confirmed reset, keyboard/runtime WebGL fallback, full
commerce/admin journeys at 360, 390, 430 and 768 pixels, input sizing,
important element bounds and page-level overflow. The preview server never
reuses an older running server.

The current local release candidate was verified on 2026-07-28:

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

The first GitHub CI result remains a historical red result: `verify` and mobile
passed, but bundled desktop Chromium crashed in three 1440 WebGL-heavy
journeys. The local release candidate now contains and passes the deterministic
static-renderer repair, but the new GitHub result is pending the next push. No
merge, deployment, reviewer assignment or personal-profile manual browsing is
claimed.

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

The Pages workflow can deploy from `main` only after one verified build is
browser-tested from that exact `dist` folder with lockfile-pinned Chromium. That
same folder is then uploaded and deployed; there is no second Pages browser job
or rebuild. This does not turn the demo into a secure shop. The app keeps
`noindex,nofollow`, copies `.nojekyll`, uses fake fixtures, and contains no
secret.

**PRODUCTION LAUNCH: STOP.** Before any real commercial launch, use the separate backend described in
`docs/PRODUCTION_BACKEND.md`, obtain Malaysian legal/compliance advice, verify
all prize/value claims, register production HitPay webhooks, and complete
security, PDPA, fulfilment, refund and monitoring readiness.
