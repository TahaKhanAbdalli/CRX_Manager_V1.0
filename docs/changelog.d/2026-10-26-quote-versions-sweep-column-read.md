## 2026-10-26 — quote-versions-rpc-owned sweep matches the cost-column lock

- Cause: since `20261022101000_cost_columns_admin_only` (PR #1089) went live, `authenticated` reads
  `quote_versions` through a column-level grant on every column except `snapshot_data`; the table-wide
  SELECT is gone on purpose. The predicate's `quote_versions:read-path-regressed` branch still required
  table-wide SELECT, so every full sweep reported one false violation and blocked DB-touching PRs.
- Fix: that branch now checks column-level read access: `has_any_column_privilege(..., 'SELECT')` plus
  each of the nine version-history columns the migration grants (resolved through `pg_attribute`, so a
  dropped column reports instead of erroring). It keeps the `qversions_select` check, now also requiring
  the policy to be permissive and to apply to `authenticated`, and it requires `get_quote_versions(uuid)`
  to exist, stay SECURITY DEFINER and stay callable by `authenticated`, since version history reads its
  snapshot through that routine.
- New branches: `quote_versions:snapshot-data-readable` fires if `authenticated` or `anon` can read
  `snapshot_data` directly (a table-wide re-grant included); `quote_versions:anon-read` fires if `anon`
  can read any column or call `get_quote_versions(uuid)`.
- Not pinned: the `qversions_select` row condition (`USING` clause), same as before this change.
- The guard's predicate fingerprint in `.claude/hooks/live-testdata-lib.mjs` was regenerated, and
  `src/lib/quoteVersionWriteBoundary.test.ts` pins both branches. No migration.
