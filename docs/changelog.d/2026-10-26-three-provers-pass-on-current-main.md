## 2026-10-26 — Three container provers run and pass on current main again

**What was wrong.** Three disposable-database provers in `scripts/smoke/` stopped before proving
anything on current main, because newer migrations and smoke edits landed after they were written
(#1106 could only run two of them from old checkouts):

- `prove-money-replay-binding-batch1-real-schema.mjs` required its candidate (20261016060000) to be the
  newest migration; 32 newer ones exist.
- `prove-cost-margin-admin-only-rpc-leaks-real-schema.mjs` refused any later file that merely *named* a
  covered function, and five later files name them inside their own preflight pin lists.
- `prove-quote-customer-row-version-real-schema.mjs` (candidate 20260730235031) ran smokes that have
  since been rewritten for newer rules: `smoke-backfill-refuse-split-billing.sql` is fail-first against
  20261006200000 (CRX-LIFE-001, #885), and `smoke-save-quote-customer-row-version.sql` expects
  20261013220000's `REP_CANNOT_REASSIGN` (#907), neither of which a July database can have.

**Fix (the pattern the working provers already use).**

- Batch 1 and cost/margin: replay up to the candidate, then refuse any later file that (re)defines,
  alters, drops (including `DROP FUNCTION IF EXISTS`) or re-grants a covered function
  (`FUNCTION <name>`, as in `prove-post-binds-reviewed-invoice-version-real-schema.mjs`), or grants
  or revokes on `ALL FUNCTIONS IN SCHEMA`; SQL comments are stripped first so none can split a
  match. Batch 1 now
  covers the nine wrappers, their nine impls, the fingerprint/binder/guard helpers and
  `check_idempotency_intent`, and adds a new step 7: after every earlier step, it replays all 32 later
  migrations on top of the candidate and checks, on that current-main database, that the rebuilt
  `require_bound_replay_receipt_20261015` trigger (batches 2, 3a, 3b) still covers all nine batch-1
  operations and still refuses an unbound receipt for each one.
- Row version: the smoke files were rewritten for later rules since this prover last passed, so on
  the July catalog it now runs the rewritten ones exactly as they stood at `56321c0d0` (#450, the last
  commit that changed this prover), read from git history: the six legacy lifecycle smokes (only
  `smoke-backfill-refuse-split-billing.sql` needs its old form) and, right after the candidate, its
  three smoke matrices — the same checks as before, in the same place. The missing-default drift check
  follows unchanged (the default is then restored and verified). New on top: the prover replays every
  later migration on main (LF text, ledger rows including the parked files, live `auth.uid()`, live
  storage shape, the same parked and ledger-only files as the other provers) and runs today's three
  matrices there.
- `smoke-backfill-refuse-split-billing.sql` itself does not pass on current main: it completes a
  delivery by direct `UPDATE`, which 20261022075000 refuses (`COMPLETION_EVIDENCE_REQUIRED`). That
  chain needs its own repair (follow-up); this change does not touch it.

No smoke chain, migration or app code changed.

**Proof (each run locally on this branch, Docker):**
`MONEY_REPLAY_BINDING_BATCH1_PROOF_PASS`, `COST_MARGIN_RPC_LEAKS_PROOF_PASS`,
`ROW_VERSION_REAL_SCHEMA_RESTORE_PASS ... post_baseline_replay=through_candidate_then_128_later smoke_matrices=candidate_era_after_candidate+current_on_20261026050000...
legacy_lifecycle_smokes=6/6`.
