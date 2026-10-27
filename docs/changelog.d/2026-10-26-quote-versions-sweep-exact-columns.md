## 2026-10-26 — quote-versions sweep: exact readable-column set (review round 4)

- New `quote_versions:unexpected-readable-column` branch: the nine version-history columns are the whole of
  what `authenticated` may read on `quote_versions`. A column added later and granted (a cost column, say)
  now reports.
- `quote_versions:snapshot-data-readable` resolves `snapshot_data` through `pg_attribute`, so a rename or
  drop reports as a violation instead of making the predicate error.
- Deferred (Mason, 2026-10-26): `authenticated`/`anon` gaining BYPASSRLS is a database-wide role attribute,
  so it belongs in a separate global predicate rather than this table's.
- Live read-only check 2026-10-26: neither branch fires.
