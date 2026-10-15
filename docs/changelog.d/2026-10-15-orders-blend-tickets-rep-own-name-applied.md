## 2026-10-15 — Orders and blend-tickets own-name rule is live; records updated (migrations `20261015130000` and `20261014220000`)

**Why.** PR #933 shipped `20261015130000_orders_blend_tickets_rep_own_name` with its records still
reading "not applied" or "in force once row 947 says APPLIED", because they were written before the
apply. PR #927's `20261014220000_rup_register_admin_only` was in the same state (row 946). This
change brings both in line with the live database.

**What changed.**
- `docs/reference/migration-history.md`: new live ledger capture (2026-10-15 17:28 UTC: 1029 rows /
  1022 names, `max(version)` `20261015163041`, effective high-water `20261015130000`). Row 947 now
  reads APPLIED LIVE 2026-10-15 16:30:41 UTC (ledger `20261015163041`) and row 946 APPLIED LIVE
  13:55:05 UTC (ledger `20261015135505`), each with its post-apply checks and no B7 rename.
- `docs/manual/KNOWN_ISSUES.md`: the order and blend-ticket salesperson entry is RESOLVED; quote
  salesperson stays OPEN for Mason's call. Ledger header updated.
- `docs/manual/CURRENT_STATE.md`: ledger header, high-water, applied list and registry lines name both
  migrations as applied.
- `docs/reference/rpc-functions.md` and `docs/plans/2026-10-13-direction-and-goals.md`: "once applied"
  wording now says applied live.
- `.claude/schema-registry.json`: delta refresh only (the two applied names and
  `migrations_high_water` `20261015163041`). The migrations changed function bodies, grants, one RLS
  policy and two triggers, none of which the registry tracks, so no table, column or constraint
  section changes.

**Proof.** Live read-only queries, 2026-10-15 17:28 UTC: both ledger rows;
`create_invoice_from_blend_ticket` `md5(prosrc)` `7be2aeab…` (the post pin), one overload, ACL
unchanged; `guard_rep_salesman_20261015()` SECURITY INVOKER, EXECUTE for `postgres` only; triggers
`orders_guard_rep_salesman_20261015` and `blend_tickets_guard_rep_salesman_20261015` enabled;
`get_rup_sales_register` `md5(prosrc)` `01a56f57…` (as PR #927's apply comment records), one
overload, anon cannot execute; `rup_sales_select` is `is_admin()`. No code, SQL or live data changed.
