# Error log

## 2026-07-28 — Draft PR #1 remediation

- Browser storage read or initial safe-fixture write exceptions fall back visibly to memory-only mode. Later update/reset write failures roll back without notification, keep storage active for retry, and show a friendly reset-dialog error.
- Current-schema recovery now validates nested order/address/totals data, fake markers, methods, manifests, capture agreement and claim-time historical eligibility.
- Customer claim notes require the separate word `DEMO` and reject likely email or realistic phone data; admin review notes are unchanged.
- Pages now builds once, tests that exact `dist`, uploads the same artifact and deploys only that upload. CI is pinned to Ubuntu 24.04, Node 22.22.3 and Playwright 1.62.0 Chromium.
- Reset now uses the existing black/gold styled confirmation dialog.

## 2026-07-28 — Current verification events

- Approved parent-environment `npm run verify` passed end-to-end.
- The secret-scanner self-test passed; 84 publishable files were scanned; both npm audits found 0 vulnerabilities; lint, typecheck, 5 Vitest files/160 tests, production build and `git diff --check` passed.
- Full Playwright ran all 75 project cases across 1440×900, 360×800, 390×844, 430×932 and 768×1024: 29 intended tests passed, 46 intentional desktop/mobile skips and 0 failed.
- The Playwright run included reset-dialog storage-failure containment in every viewport and full customer checkout, mock payment, order, immutable reveal, account and admin journeys at all four mobile/tablet widths.
- No GitHub CI, merge, deployment, reviewer assignment or new post-remediation personal-Chrome manual pass is claimed.

## 2026-07-28 — Resolved in final targeted polish

- Payment simulator routes now reject cross-order and cross-user payment IDs.
- Repeated legal fulfilment cycles now use repository-sequenced timeline identities, even with a fixed clock.
- Disputed captured payments now remain visibly captured and under review.
- Support user inspection is clearly read-only; admin order actions and approved-claim finance handoff are guarded and explicit.
- Stamp colours are correctly split between dark-dialog and light-paper contrast.

## 2026-07-28 — Resolved historical tooling events

- Earlier in the restricted workspace, `npm run verify` stopped when npm audit could not resolve `registry.npmjs.org` (`ENOTFOUND`). This was resolved by the approved parent-environment rerun: `npm run verify` passed end-to-end and both npm audits found 0 vulnerabilities.
- Earlier in the restricted workspace, Vite could not bind `127.0.0.1:4173` (`EPERM`) before Playwright launched. This was resolved by the approved parent-environment full Playwright run: 29 intended tests passed, 46 intentional skips and 0 failed across all five viewports.
- Before the current remediation, the browser baseline passed 26 selected tests with 49 intentional project skips across the five configured viewports; the newer full result above supersedes that baseline.
- A nested read-only review was interrupted after repeatedly printing a very large dirty diff. No code was lost.
