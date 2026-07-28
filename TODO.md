# Project checklist

## Completed in the mock system

- [x] Public demo-only customer, order, payment, prize, fulfilment, claim and role flows
- [x] Server-like ownership, transition, idempotency, immutable reveal and audit guards
- [x] Final targeted payment-route, disputed-payment, admin-action and finance-handoff polish
- [x] Structured claim resolution, sealed-box tracking/claims and true no-write idempotent replays
- [x] Deterministic bundled-Chromium static renderer with local-Chrome live WebGL coverage
- [x] Fixed-clock fulfilment timeline identity regression coverage
- [x] Production boundary and operating-flow notes

## 2026-07-29 whole-branch follow-up remediation

- [x] Prevent cross-route sealed-prize state reuse and clean reveal timers
- [x] Handle malformed encoded customer routes with the friendly not-found page
- [x] Keep an existing payment method selected after route remounting
- [x] Share customer/admin payment retry and disputed-action eligibility with services
- [x] Share financial-hold fulfilment eligibility with the admin interface
- [x] Reject invalid or blank draft prize definitions in UI, service and storage
- [x] Use one open-claim definition for duplicates, validation, closing and metrics
- [x] Sanitize sealed-order history and privately widen neutral claim evidence
- [x] Correct order numbering and ignored payment-event wording
- [x] Release WebGL shaders, program and buffer after failure or unmount
- [x] Freeze approved claim evidence and validate every widening audit/history snapshot
- [x] Require pending-payment order creation history and synthesize its sealed customer row
- [x] Unbind and detach WebGL resources before deletion

## 2026-07-29 offline follow-up verification

- [x] Focused Vitest regression run — 4 files, 277/277 tests passed
- [x] `npm run secrets:test` — secret-scanner self-test passed
- [x] Earlier `npm run check:secrets` evidence — 89 publishable text files scanned
- [x] Final `npm run check:secrets` — 90 files after adding the timeline helper
- [x] `npm run lint`
- [x] `npm run typecheck`
- [x] `npm test` — 5 files, 283/283 tests passed
- [x] `npm run build`
- [x] `git diff --check`
- [x] Installed Chrome `npm run e2e` — 110 collected, 44 passed,
  66 intentional skips, 0 failed
- [x] CI-style Chromium `npm run e2e:ci` — 110 collected, 39 passed,
  71 intentional skips, 0 failed
- [x] All newly added desktop regressions executed and passed
- [x] Manual personal Chrome visual comparison at 360, 390, 430, 768 and 1440
  confirmed black/gold/cyan parity; the work tab was closed
- [x] Code-candidate commit `59c04c3315c11cb154a714c186fd25dc46d4746e`
  passed GitHub Actions CI run #10 (`30387581184`): verify job `90370635371`
  and e2e job `90370837958` both succeeded
- [x] Remote verify proved `npm ci` audited 254 packages with 0 vulnerabilities
  and `npm run verify` passed the 90-file scan, two 0-vulnerability audits,
  lint, typecheck, 283/283 tests and build

Local `npm audit` remained blocked by the restricted-network approval boundary.
The code candidate is committed and pushed on the draft branch. The PR remains
draft and unmerged, and no Pages deployment occurred. This later
documentation-only change is not claimed to have passed CI.

## Current local release candidate verification

- [x] `npm run verify` — passed end-to-end
- [x] `npm run secrets:test` — secret-scanner self-test passed
- [x] `npm run check:secrets` — 85 publishable text files scanned
- [x] `npm run audit:release` — both npm audits found 0 vulnerabilities
- [x] `npm run lint`
- [x] `npm run typecheck`
- [x] `npm test` — 5 files, 246/246 tests passed
- [x] `npm run build`
- [x] `git diff --check`
- [x] Installed Google Chrome Playwright — all 95 project cases ran across
  1440x900, 360x800, 390x844, 430x932 and 768x1024; 41 applicable tests
  passed, 54 intentional skips, 0 failed, with live WebGL at every size
- [x] Bundled Chromium Playwright — the same 95 project cases ran at the same
  five sizes; 36 applicable tests passed, 59 intentional skips, 0 failed,
  using the intentional static fallback

## Remote release follow-up

- [x] Keep the first red GitHub CI result as historical evidence: its
  `verify` and mobile work passed, but bundled desktop Chromium crashed in
  three 1440 WebGL-heavy journeys
- [x] Confirm commit `0ee805e1ce12fa7e9bdca6a7dab66dfc5ba4ebfe`
  passed GitHub Actions CI run #8 on 2026-07-28: both the `verify` and `e2e`
  jobs succeeded
- [ ] Review the release candidate and make a separate publishing decision

The draft PR remains unmerged, and no Pages deployment occurred. No reviewer
assignment or personal-profile manual browsing is claimed.
