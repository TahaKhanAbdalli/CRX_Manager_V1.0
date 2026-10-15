## 2026-10-15 — Quote salesperson own-name rule is live; records updated (migration `20261015200000`)

**Why.** PR #938 shipped `20261015200000_quotes_rep_own_name` with its records still reading "not
applied", "pending apply" or "in force once row 948 says APPLIED", because they were written before
the apply. It applied live at 19:34:20 UTC (ledger `20261015193420`, no B7 rename). This change
brings the records in line with the live database.

**What changed.**
- `docs/reference/migration-history.md`: new live ledger capture (2026-10-15 19:36 UTC: 1030 rows /
  1023 names, `max(version)` `20261015193420`, effective high-water `20261015200000`). Row 948 now
  reads APPLIED LIVE with its post-apply checks; the old text stays as the pre-apply record. PR #929's
  open candidate `20261015170000` now sorts below the high-water and must be re-stamped by its owner.
- `docs/manual/KNOWN_ISSUES.md`: the quote salesperson entry is RESOLVED; the deferred note (a rep who
  rolls over another rep's quote becomes `created_by` and can edit it) stays open. Ledger header updated.
- `docs/manual/CURRENT_STATE.md`: ledger header, high-water, applied list and registry lines.
- `docs/reference/rpc-functions.md`, `docs/manual/DECISION_LOG.md` and
  `docs/plans/2026-10-13-direction-and-goals.md`: the "once applied" / "pending apply" wording now
  says applied live.
- `.claude/schema-registry.json`: delta refresh only (the applied name and `migrations_high_water`
  `20261015193420`). The migration changed a function body and added a trigger, which the registry
  does not track.
- `src/lib/rpcFixtureLiveDiff.test.ts`: the live `pg_proc` name snapshot is refreshed from live on
  2026-10-15 at 19:36 UTC, after the apply (638 → 651 names; the previous snapshot dated from
  2026-10-02). The 13 new names include `guard_rep_quote_salesman_20261015`; the
  snapshot's md5 equals the live `string_agg` md5.

**Proof.** Live read-only queries, 2026-10-15 19:36 UTC: the ledger row; `rollover_quote_to_season`
`md5(prosrc)` `eb9b65e5…` (the post pin), one overload, SECURITY DEFINER, ACL unchanged;
`guard_rep_quote_salesman_20261015()` SECURITY INVOKER, EXECUTE for `postgres` only; trigger
`quotes_guard_rep_salesman_20261015` enabled. `rpcFixtureLiveDiff.test.ts` passes (18 tests). The DB
invariant sweep results are in the PR description. No SQL or live data changed.
