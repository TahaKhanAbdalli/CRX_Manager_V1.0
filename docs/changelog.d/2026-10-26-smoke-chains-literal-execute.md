## 2026-10-26 — The last three smoke chains run through the live-data guard again

**What was wrong.** Since the live-data guard learned to allow rollback-only batches (#1092, #1093),
three of the 69 live-runnable `scripts/smoke/` chains were still refused:
`cost_margin_admin_only_rpc_leaks`, `money_replay_binding_batch1` and the local-only
`save_quote_customer_row_version`. Each ran a list of SQL strings in a loop (`EXECUTE v_sql`), and the
guard, by design, only lets a rollback-only batch `EXECUTE` one literal it can read. So the post-apply
live smoke step for those two migrations could not run.

**Fix.** The chains now test exactly the same things without running text built at run time:

- `smoke-cost_margin_admin_only_rpc_leaks.sql`: each of the six cost reports runs as one literal
  `EXECUTE '…' INTO v_count`, picked by its number in a `CASE`, for every role probe (five staff roles,
  an id with no active profile, and a signed-out visitor). The report list stays as the same text, used
  only to name the report in failure messages.
- `smoke-money-replay-binding-batch1.sql` step 9b: the eight keyless calls are written out as plain
  `PERFORM public.<rpc>(…, NULL)` calls, one per `CASE` branch; the `format()` text stays only to name
  the call in failure messages.
- `smoke-save-quote-customer-row-version.sql`: the nine direct child-table probes (INSERT, UPDATE and
  DELETE on `quote_sections`, `quote_items`, `customer_addresses`) each run one literal `EXECUTE`, picked
  by table and verb in a `CASE`.

Every assertion and message is unchanged. An unlisted branch raises CASE_NOT_FOUND, which none of the
handlers accepts, so a drifted list fails rather than skipping a check.

`.claude/hooks/guards.test.mjs` no longer exempts any chain: every live-runnable chain must classify as
allowed (`kind: "rolled-back-smoke"`), and the floor rose from 66 to 69.

**Proof.**
- The guard's own verdict (`classifySql`, `isVerifiedRollbackBatch`) on each rewritten file:
  `{ block: false, kind: "rolled-back-smoke" }`, verified rollback true.
- Live, through the Supabase MCP `execute_sql`: `cost_margin_admin_only_rpc_leaks` and
  `money_replay_binding_batch1` both ended in `ERROR: P0001: SMOKE_PASS_ROLLBACK` (PASS; nothing
  persisted). `save_quote_customer_row_version` is local-only and was not run live.
- Container provers: both provers assert their candidate is the last migration, so on current main they
  stop before building (newer migrations exist). Run from a checkout of the commit that added each
  candidate (8124ae21c, 982bc0dda) with the rewritten chain copied in, both pass in full:
  `COST_MARGIN_RPC_LEAKS_PROOF_PASS` (the chain fails closed before the candidate and passes after) and
  `MONEY_REPLAY_BINDING_BATCH1_PROOF_PASS` (fails first at step 1 before the candidate, passes after,
  moves no document-number sequence, and every mutation still fails the chain).
- Save-quote chain: on a disposable database replayed through 20261023090000 (built by
  `prove-field-functions-require-field-access-real-schema.mjs` at 9ad2cb000), the old and the rewritten
  chain both end in `SMOKE_PASS_ROLLBACK`; with UPDATE or DELETE granted to `authenticated` on each child
  table in turn, both fail with the same `SMOKE_FAIL: authenticated direct child DML succeeded on <table>`.
- `node .claude/hooks/guards.test.mjs` (903 assertions), every `.claude/hooks/*.test.mjs`, and
  `npm run test:correction-guards` pass.
