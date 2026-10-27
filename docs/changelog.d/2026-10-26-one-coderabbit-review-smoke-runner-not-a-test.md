## 2026-10-26 - Smoke runner and verdict code always get a fresh CodeRabbit review (#1125, Codex App P2)

The minor-follow-up rule's test-file exception under `scripts/smoke/` now covers only the
business-chain tests themselves (`smoke-*.sql`, `prove-*.mjs`). `run-smoke.mjs`,
`interpret-result.mjs`, and the seed and setup files are excluded again, so a fix that edits them
no longer keeps an earlier CodeRabbit review.
