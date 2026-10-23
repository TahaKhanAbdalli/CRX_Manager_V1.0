## 2026-10-23 — inactive-account role reads applied live

- Migration `20261022070000_role_reads_require_active_profile.sql` (migration-history row 974, PR #1042) was
  applied live on 2026-10-23 at 04:47 UTC (ledger version `20261023044719`) on Mason's in-chat approval, then
  merged. `get_team_board_deliveries`, `get_yesterday_delivery_recap`, `mark_inventory_row_verified` and
  `get_ar_reminder_candidates` now refuse an inactive or profile-less account.
- Live check after the apply: the four function bodies match the reviewed versions with their permissions
  unchanged, and the team board refuses a caller without an active profile while still serving an active admin.
