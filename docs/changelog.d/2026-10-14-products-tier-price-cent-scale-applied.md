## 2026-10-14 — Product tier-price whole-cent rule is live; records updated (migration `20261014150000`)

**Why.** PR #910 shipped `20261014150000_products_tier_price_cent_scale` with its records still
reading "NOT applied", because the records were written before the apply. This change brings them
in line with the live database.

**What changed.**
- `docs/reference/migration-history.md`: new live ledger capture (2026-10-14 17:28 UTC: 1026 rows /
  1019 names, `max(version)` `20261014150257`, effective high-water `20261014150000`), and row 944
  now reads APPLIED LIVE 2026-10-14 15:02:57 UTC (ledger `20261014150257`, no B7 rename), with its
  post-apply checks.
- `docs/manual/CURRENT_STATE.md` and `docs/manual/KNOWN_ISSUES.md`: ledger header and high-water
  lines now name `20261014150000` as applied.
- `docs/reference/database-schema.md`: the `products` line states the three tier-price constraints
  as live.
- `.claude/schema-registry.json`: real `--from-introspection` refresh from live read-only queries.
  The only changes are the three `products_tierN_price_whole_cents_chk` constraints (listed under
  `skipped_constraints`, since they are range checks, not value lists), the two applied names
  `20261013220000_reps_work_any_customer` and `20261014150000_products_tier_price_cent_scale`,
  `migrations_high_water` `20261014150257`, and the date. Every other section count is unchanged.
- The registry "last regenerated" markers now name this refresh: `CURRENT_STATE.md` (was 2026-10-12),
  `migration-history.md` (was 2026-10-07) and `database-schema.md` (was 2026-09-26). The schema doc's
  table count moves from 160 to 161: `delivery_external_billings` (`20261007150000`) was added after
  its last count.

**Proof.** Live read-only ledger query and introspection, 2026-10-14 17:28 UTC. No code, SQL or
live data changed.
