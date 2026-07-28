# Project checklist

## Completed in the mock system

- [x] Public demo-only customer, order, payment, prize, fulfilment, claim and role flows
- [x] Server-like ownership, transition, idempotency, immutable reveal and audit guards
- [x] Final targeted payment-route, disputed-payment, admin-action and finance-handoff polish
- [x] Structured claim resolution, sealed-box tracking/claims and true no-write idempotent replays
- [x] Deterministic bundled-Chromium static renderer with local-Chrome live WebGL coverage
- [x] Fixed-clock fulfilment timeline identity regression coverage
- [x] Production boundary and operating-flow notes

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
- [ ] Confirm the new GitHub result after the next push; the current local
  release candidate must not be described as remotely green before that result
- [ ] Review the release candidate and make a separate publishing decision

No merge, deployment, reviewer assignment or personal-profile manual browsing
is claimed.
