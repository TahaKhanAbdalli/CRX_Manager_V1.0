## 2026-10-27 — Records: `last_charged_prices` applied live (row 994, PR #1119)

- `20261027060000_last_charged_prices` applied live 2026-10-27 16:03:49 UTC (ledger `20261027160349`) before
  PR #1119 merged as `36167c12e`, with Mason's in-session approval for its column grants.
  `docs/reference/migration-history.md` row 994 now says APPLIED LIVE.
- `docs/manual/TO_DO_LIST.md` row 0.3 now says live.
- Verified live: both `price_tier_at_sale` columns, the four functions and both triggers in the catalog; the smoke
  chain `smoke-get-last-charged-prices.sql` passed (rolled back); croprxsolutions.app's quote screen calls
  `get_last_charged_prices`.
