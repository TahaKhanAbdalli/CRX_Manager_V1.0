## 2026-10-26 — Margin floors are live (To-Do 0.2)

PR #1102 merged as `08ac06507` at 22:11 UTC (5:11 PM Central). Its migration
`20261025210000_product_margin_floors` was applied live first, at 21:44 UTC (ledger version
`20261026214418`), with Mason's chat-reply approval: the apply guard reads the history table's
`BEFORE TRUNCATE` trigger (which refuses a TRUNCATE) as destructive.

- Live catalog checked after the apply: both tables have RLS on, the save function is admin-only
  and callable only by signed-in users, the three triggers exist, and no floors are set.
- croprxsolutions.app serves the new build: the product page's Margin Floor card loads with its
  corrected text, and the Products list has its "Floor %" column.
- `docs/reference/migration-history.md` row 984 and To-Do 0.2 now record the apply.
- Still open: floors on the live products (Mason's live data change), and the live rolled-back smoke
  chain, whose `execute_sql` call the session's permission layer declined (Mason deferred it).
