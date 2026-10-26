## 2026-10-25 — Record migration 20261023100000 as applied live (row 982, PR #1080)

- `docs/reference/migration-history.md` row 982 is now APPLIED LIVE: ledger version `20261026030708`, name
  `20261023100000_revoke_load_recipe_into_job_app_access`, applied 10:07 PM Central before PR #1080 merged
  (`3f380d82a`), with Mason's in-chat `I approve`. The post-apply live read shows only postgres and service_role can
  execute `load_recipe_into_job`; the function body is unchanged.
- New top live capture: 1062 ledger rows / 1055 distinct names, high-water `20261023100000`.
- Row 982 now gives cost lock B's real stamp (`20261022101000`), not `20261022091000`.
- `.claude/schema-registry.json`: `migrations_high_water` moves to `20261026030708`, and the migration is added to the
  applied list.
