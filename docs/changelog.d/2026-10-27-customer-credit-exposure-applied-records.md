## 2026-10-27 — Records: `customer_credit_exposure` applied live (row 991, PR #1138)

- `20261027030000_customer_credit_exposure` applied live 2026-10-27 09:39:45 UTC (ledger `20261027093945`) before
  PR #1138 merged as `b3da666ec`. `docs/reference/migration-history.md` row 991 now says APPLIED LIVE, with a new
  top live-ledger capture (1067 rows); `docs/reference/rpc-functions.md` drops its NOT APPLIED note.
- `docs/manual/CURRENT_STATE.md` and `KNOWN_ISSUES.md` carry the 10:05 UTC read-only ledger re-read.
- Verified live: function attributes and grants, the rollback-only chain, and 29/29 post-apply db-sweeps.
