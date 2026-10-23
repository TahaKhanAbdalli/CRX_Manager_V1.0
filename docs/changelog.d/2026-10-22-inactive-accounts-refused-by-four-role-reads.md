## 2026-10-22 — an inactive account is refused by four more database functions

- Migration `20261022070000_role_reads_require_active_profile.sql` (migration-history row 974): four functions
  read the caller's role without checking that the account is active, so a deactivated user (or a new, not yet
  activated one) whose login token had not expired yet kept that role there. Now each refuses an inactive or
  missing profile:
  - `get_team_board_deliveries` and `get_yesterday_delivery_recap` (the Team Board and yesterday's recap): an
    inactive admin or sales rep saw every delivery; now the call is refused.
  - `mark_inventory_row_verified` (Integrity Cleanup → phantom inventory rows): an inactive admin, or a caller with
    no profile at all, could clear a row's flag; now only an active admin can, and a saved result for a retry key is
    returned only after that check (before, any signed-in user who knew the key got it).
  - `get_ar_reminder_candidates` (AR Aging → Send AR Reminders): an inactive admin could read the overdue-customer
    list; it also no longer trusts a `user_role` JWT claim (nothing sets one today).
- Not changed: what active admins, sales reps, drivers and applicators see or can do; grants and owners.
- A live survey on 2026-10-22 found no other function with this gap: the rest either check `is_active` or gate
  through `is_admin()`/`is_sales_rep()`/`require_admin()`/`require_admin_or_sales_rep()` first.
- Proof: `node scripts/smoke/prove-role-reads-require-active-profile-real-schema.mjs` (Docker).
