# Error log

## 2026-07-28 — Resolved in final targeted polish

- Payment simulator routes now reject cross-order and cross-user payment IDs.
- Repeated legal fulfilment cycles now use repository-sequenced timeline identities, even with a fixed clock.
- Disputed captured payments now remain visibly captured and under review.
- Support user inspection is clearly read-only; admin order actions and approved-claim finance handoff are guarded and explicit.
- Stamp colours are correctly split between dark-dialog and light-paper contrast.

## 2026-07-28 — Known tooling events

- The sandbox could not resolve the npm audit registry because outbound DNS was restricted. Both audit commands completed successfully when rerun in the approved parent environment.
- The browser suite could not bind a local port inside the Codex sandbox (`EPERM`). The approved parent-environment rerun succeeded with 26 selected tests passed and 49 intentional project skips across the five configured viewports.
- These are approved parent-environment results only; GitHub CI has not been claimed or verified yet.
- A nested read-only review was interrupted after repeatedly printing a very large dirty diff. No code was lost.
