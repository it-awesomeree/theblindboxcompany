# Error log

## 2026-07-29 — Release status verified

- `404ba06033117fa6130dad1075cf12019a99ccd4` is the verified application
  release commit and remains contained in `main`.
- This documentation-only follow-up records the release evidence and does not
  change the application.
- PR #1 is closed and GitHub reports `merged=true`.
- Main CI run `30415550591` completed successfully with passing `verify` and
  `e2e` jobs.
- Pages run `30415550658` completed successfully with passing
  `build-test-upload` and `deploy` jobs.
- Local verification passed 283/283 tests and found 0 vulnerabilities.
- The live site,
  <https://it-awesomeree.github.io/theblindboxcompany/>, was checked in the
  owner's personal Chrome at 1440×900, 360×800, 390×844, 430×932 and 768×1024.
  It had no horizontal overflow, and its WebGL canvas was visible at every size.
- Live customer sign-in, cart, checkout, mock HitPay, payment, order,
  open/reload persistence, and admin dashboard/payment views were verified.
  The created fake record was reset and the test tab was closed.

This is a public browser-local fake-data demo, not a real HitPay, Google or
server backend. It must not accept real orders or money.

## 2026-07-29 — Whole-branch follow-up resolved locally

- Full customer route identity now remounts parameter/query-bound state.
  Malformed encoded routes show not-found, and reveal timers cannot carry a
  result into another sealed box.
- Customer/admin payment controls and services share all-attempt retry rules.
  Disputed payments show a terminal finance-only explanation and reject
  customer provider actions without changing state.
- Financial-hold fulfilment actions now come from one rule used by both the
  admin interface and service: impossible digital actions are hidden and
  rejected, while permitted physical carrier evidence remains available.
- Blank or invalid draft prizes are rejected atomically by the screen, service
  and stored-state validator without forcing the short name to equal the name.
- Open claims use one status definition. A repeated sealed neutral order-level
  claim can privately add newly eligible shipment evidence with matching
  history, audit and corruption validation only while submitted or reviewing.
  Approved claim evidence is frozen.
- Sealed customers now see sanitized creation/payment history, section numbering
  is sequential, and order creation history must begin at pending payment.
  Ignored out-of-order payment wording is accurate.
- WebGL cleanup unbinds the buffer/current program and detaches attached shaders
  before deleting resources on setup failure, context loss and unmount.
- Focused regression tests passed 277/277. The final full run passed all 5
  Vitest files and 283/283 tests. The earlier known scan covered 89 files; the
  final scanner self-test and 90-file scan passed after the timeline helper was
  added. Lint, typecheck, production build and `git diff --check` passed.
- Installed Chrome `npm run e2e` collected 110 tests: 44 passed, 66 intentional
  skips and 0 failed. CI-style Chromium `npm run e2e:ci` collected 110 tests:
  39 passed, 71 intentional skips and 0 failed. All newly added desktop
  regressions executed and passed.
- Manual personal Chrome comparison at 360, 390, 430, 768 and 1440 confirmed
  black/gold/cyan parity, and the work tab was closed.
- Code-candidate commit `59c04c3315c11cb154a714c186fd25dc46d4746e`
  passed GitHub Actions CI run #10, run ID `30387581184`: verify job
  `90370635371` and e2e job `90370837958` both succeeded.
- Verify logs prove `npm ci` audited 254 packages with 0 vulnerabilities and
  `npm run verify` passed the 90-file secret scan, two audit commands with 0
  vulnerabilities, lint, typecheck, 283/283 tests and build. The e2e job passed.
- Historical checkpoint note: direct local `npm audit` network access was
  blocked, although the recorded local and remote release audits passed. This
  pre-merge checkpoint is superseded by the verified release status above.

## 2026-07-28 — Historical local release candidate verification

- `npm run verify` passed end-to-end.
- The secret-scanner self-test passed and 85 publishable text files were
  scanned.
- Both npm audits found 0 vulnerabilities.
- Lint, typecheck, 5 Vitest files with 246/246 tests, the production build and
  `git diff --check` passed.
- Installed Google Chrome Playwright ran all 95 cases across 1440×900, 360×800,
  390×844, 430×932 and 768×1024: 41 applicable tests passed, 54 intentional
  skips and 0 failed. Live WebGL was verified at every size.
- Bundled Chromium ran the same 95 cases at the same five sizes: 36 applicable
  tests passed, 59 intentional skips and 0 failed using the intentional static
  fallback.
- No merge, deployment, reviewer assignment or personal-profile manual
  browsing is claimed.

## 2026-07-28 — Historical first GitHub CI result

- `verify` passed.
- Bundled desktop Chromium crashed in three 1440 WebGL-heavy journeys.
- Mobile passed.
- The current local release candidate now passes bundled Chromium with the
  faithful static black/gold fallback while installed local Chrome retains live
  WebGL.
- Commit `0ee805e1ce12fa7e9bdca6a7dab66dfc5ba4ebfe` passed GitHub Actions CI run
  #8 on 2026-07-28: both the `verify` and `e2e` jobs succeeded.
- This pre-merge evidence is superseded by the verified 2026-07-29 merge and
  deployment status above.

## 2026-07-28 — Release repair resolved locally

- Startup reservation-cleanup storage failure is contained without changing
  memory, stored bytes, revision or listeners; storage stays active for an
  explicit retry.
- Duplicate claims, repeat reveals and exact refund replays now return without a
  repository write. Refund request IDs are global and conflicting intent is
  rejected.
- Sealed customers can use generic tracking and eligible damage/non-delivery
  claims without prize leakage. Value-floor claims still require that exact box
  to be revealed.
- Claim resolution now records a finite outcome and fictional reference.
  `refund_recorded` must point to a real same-order audited refund; no claim
  action issues a refund.
- Fixed price, shipping, quantity, published-version, unique-email and
  reveal-state validation rejects internally coherent tampering.
- A returned physical shipment is accepted as non-delivery exception evidence;
  a returned digital fulfilment is not.
- The full current automated evidence is recorded above.

## 2026-07-28 — Draft PR #1 remediation

- Browser storage read or initial safe-fixture write exceptions fall back visibly to memory-only mode. Later update/reset write failures roll back without notification, keep storage active for retry, and show a friendly reset-dialog error.
- Current-schema recovery now validates nested order/address/totals data, fake markers, methods, manifests, capture agreement and claim-time historical eligibility.
- Customer claim notes require the separate word `DEMO` and reject likely email or realistic phone data; admin review notes are unchanged.
- Pages now builds once, tests that exact `dist`, uploads the same artifact and deploys only that upload. CI is pinned to Ubuntu 24.04, Node 22.22.3 and Playwright 1.62.0 Chromium.
- Reset now uses the existing black/gold styled confirmation dialog.

## 2026-07-28 — Resolved in final targeted polish

- Payment simulator routes now reject cross-order and cross-user payment IDs.
- Repeated legal fulfilment cycles now use repository-sequenced timeline identities, even with a fixed clock.
- Disputed captured payments now remain visibly captured and under review.
- Support user inspection is clearly read-only; admin order actions and approved-claim finance handoff are guarded and explicit.
- Stamp colours are correctly split between dark-dialog and light-paper contrast.
