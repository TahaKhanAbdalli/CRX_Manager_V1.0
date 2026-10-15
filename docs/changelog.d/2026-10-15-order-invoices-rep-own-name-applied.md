## 2026-10-15 — Order invoices own-name rule is live; records updated (migration `20261014210000`)

**Why.** PR #928 shipped `20261014210000_order_invoices_rep_own_name` with its records still
reading "not applied" or "in force once applied", because they were written before the apply. This
change brings them in line with the live database.

**What changed.**
- `docs/reference/migration-history.md`: new live ledger capture (2026-10-15 12:32 UTC: 1027 rows /
  1020 names, `max(version)` `20261015080515`, effective high-water `20261014210000`), and row 945
  now reads APPLIED LIVE 2026-10-15 08:05:15 UTC (ledger `20261015080515`, no B7 rename), with its
  post-apply checks.
- `docs/manual/KNOWN_ISSUES.md`: the order-invoice salesperson half is RESOLVED; the order and
  blend-ticket salesperson follow-up stays OPEN. Ledger header updated.
- `docs/manual/CURRENT_STATE.md`: ledger header, high-water and registry lines name `20261014210000`
  as applied.
- `docs/reference/rpc-functions.md`, `docs/manual/DECISION_LOG.md` and
  `docs/plans/2026-10-13-direction-and-goals.md`: "once applied" wording now says applied live.
- `.claude/schema-registry.json`: delta refresh only (the applied name and `migrations_high_water`
  `20261015080515`). The migration changed only function bodies, and the ledger shows no other apply
  since the 2026-10-14 full refresh, so no table, column or constraint section changes.

**Proof.** Live read-only queries, 2026-10-15 12:32 UTC: the ledger row, and `md5(prosrc)` of
`create_invoice_from_order` (`c97b2be8…`), `create_split_invoices_from_order` (`0f1e36e8…`) and
`_complete_delivery_authorized_impl` (`35737fb8…`) equal the migration's postflight pins, with ACLs
unchanged and one overload each. No code, SQL or live data changed.
