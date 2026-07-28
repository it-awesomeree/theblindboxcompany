# Error log

## 2026-07-28 — Current local release candidate verification

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
- The new GitHub result is pending the next push. CI is not claimed green, and
  no deployment is claimed.

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
