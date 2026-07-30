# The Blind Box Company — public demo prototype

This repository is a **public, browser-local mock only**. It looks and behaves
like a store, but all records stay in the current browser. Real HitPay, Google
OAuth, server authentication, a server database, webhooks and shipping-provider
integration are not implemented here. They require the separate production
backend described in `docs/PRODUCTION_BACKEND.md`. This prototype must never be
used to take a real order or accept real money.

The yellow warning at the top of every page is intentional. GitHub Pages only
serves public files; it cannot safely hold payment secrets, passwords, webhook
salts, or a trusted prize allocator.

## How to prove a current release

This README does not declare any old commit, workflow run or test total to be
current. Release proof must be recreated for each release:

1. Record the exact full SHA at the tip of `main`.
2. Confirm the GitHub `verify` and `e2e` checks passed for that exact SHA.
3. Confirm one successful custom Pages deployment used that same SHA and the
   already verified build artifact.
4. Freshly check the deployed site in a real browser at desktop and mobile
   sizes, including the main customer and admin paths, readability and
   horizontal overflow.

A successful check or deployment for any other SHA is historical evidence only.
It must never be presented as proof of the current release.

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

Use the Node.js version declared by the repository and npm to match CI.

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
installs the Chromium build pinned by the lockfile and opens the same
black/gold/cyan page with `?nogl=1`, exercising the faithful static vault
fallback instead of the expensive raymarch renderer.
The preview health-check URL stays query-free, and the query appears before the
route hash. End-to-end checks include customer success, failure/retry,
open-later/refresh, sealed-box tracking and eligible claims through structured
admin resolution, protected admin operations, confirmed reset,
keyboard/runtime WebGL fallback, full commerce/admin journeys at 360, 390, 430
and 768 pixels, input sizing, important element bounds and page-level overflow.
The preview server never reuses an older running server.

`package-lock.json` is committed and generated by `npm install`; CI uses
`npm ci`. A small local hash router covers only this static demo’s routes and is
exercised by the same full browser suite.

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

The custom Pages workflow is the supported publishing path. It verifies one
exact `main` SHA, browser-tests that exact `dist` folder with lockfile-pinned
Chromium, then uploads and deploys the same folder without a second build.
Record the resulting workflow and deployment only as evidence for that SHA.
Publishing does not turn the demo into a secure shop. The app keeps
`noindex,nofollow`, copies `.nojekyll`, uses fake fixtures, and contains no
secret.

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
