## 2026-10-27 — Records: `quote_sent_price_lock` applied live (row 992, PR #1105)

- `20261027040000_quote_sent_price_lock` applied live 2026-10-27 12:37:25 UTC (ledger `20261027123725`) before
  PR #1105 merged as `f1503ba91`. `docs/reference/migration-history.md` row 992 now says APPLIED LIVE, with a new
  top live-ledger capture (1068 rows).
- `docs/manual/TO_DO_LIST.md` rows 0.5, 1.2 and 1.3 now say live; `KNOWN_ISSUES.md` KI-12's fix is live (Q-2026-2059
  stays Mason's call) and KI-81 stays open with the lock now live; `CURRENT_STATE.md` carries the new ledger read.
- Verified live: the price check's mode and grants, the four bodies that call it, the six re-emitted functions'
  security settings, and the new quote screen served by croprxsolutions.app.
