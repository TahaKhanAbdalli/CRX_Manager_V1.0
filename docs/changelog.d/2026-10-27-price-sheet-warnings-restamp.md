## 2026-10-27 — Price sheet warnings migration restamped to 20261027050000 (To-Do 0.1, PR #1131)

- The not-yet-applied migration `20261026230000_price_sheet_warnings_and_approval.sql` is now `20261027050000_price_sheet_warnings_and_approval.sql`, migration-history row 993 (row 990 retired; row 992 belongs to #1105), so it sorts after #1138's `20261027030000` (applied live 2026-10-27) and #1105's claimed `20261027040000`. CRX Coordinator sequencing; the SQL itself is unchanged.
- Checked that #1105's migration replaces none of the live function bodies this migration's preflight pins.
- The real-schema proof (`scripts/smoke/prove-price-sheet-warnings-real-schema.mjs`) was re-run on the restamped file with every migration now on main applied first.
