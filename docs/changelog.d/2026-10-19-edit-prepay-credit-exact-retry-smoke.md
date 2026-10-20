## 2026-10-19 — Money retry binding, batch 1: `edit_prepay_credit` exact retry proven live (migration `20261016060000`)

**Why.** The batch-1 smoke chain checked an exact retry for eight of the nine bound money functions.
For `edit_prepay_credit` it checked only that a changed request is refused (CodeRabbit on PR #950),
so nothing live showed that a genuine repeat of a prepay-credit edit is recognised as a repeat.

**What changed.**
- `scripts/smoke/smoke-money-replay-binding-batch1.sql`: step 3 now repeats the first edit exactly
  (same admin, key and request) and requires the saved answer back (`idempotent: true`, same credit
  id), no second `prepay_edited` audit row, no second receipt, and no change to the credit's balance
  or the customer's prepay balance.
- Ran live 2026-10-20 00:35 UTC (2026-10-19 7:35 PM Central) through
  `node scripts/smoke/run-smoke.mjs --spec edit_prepay_credit` and the Supabase MCP: result
  `SMOKE_PASS_ROLLBACK`. A read-back afterwards found 0 `[SMOKE]` customers, credits or `smk-rpb-`
  receipts, so nothing persisted.
- `docs/manual/KNOWN_ISSUES.md` and `docs/reference/migration-history.md` row 951: the gap is closed.

**Not run.** `scripts/smoke/prove-money-replay-binding-batch1-real-schema.mjs` (the container
prover) no longer runs on current `main`: it requires `20261016060000` to be the newest migration
and stops at "the candidate must be the last migration in the replay plan" (115 vs 118). The live
run above is the proof for the new step.

**Still open.** Replay-binding batches 3–4 (KNOWN_ISSUES.md).
