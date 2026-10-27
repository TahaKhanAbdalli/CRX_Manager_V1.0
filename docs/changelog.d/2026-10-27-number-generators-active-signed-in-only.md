## 2026-10-27 — Quote and order numbers only for active admins, sales reps and server functions

- Mason (2026-10-26, 2026-10-27): only the people who quote and order take numbers; drivers do not.
  New migration `20261027080100_number_generators_active_signed_in_only.sql` (row 997, NOT APPLIED,
  placeholder stamp/row) revokes EXECUTE on `generate_quote_number()` / `generate_order_number()`
  from PUBLIC and anon, revokes anon's grants on both number sequences, and requires a direct call to
  come from an active account (`PROFILE_INACTIVE`) that is an admin or sales rep
  (`NUMBER_ROLE_REQUIRED`).
- Caller check 2026-10-27 (main `fe258c2f`): the only app callers, Quote Builder
  (`generate_quote_number`) and Blend Ticket Detail (`generate_order_number`), are admin and
  sales-rep pages and keep working; the 8 server functions that number quotes/orders are SECURITY
  DEFINER and skip the checks. Number format unchanged (still the UTC year; the Chicago-year fix is
  separate).
- `global_search` is not changed: it already returns nothing to an inactive account.
- Access change: applies only after Mason's in-chat `I approve`.
- Proof (local replay of main `fe258c2f`, synthetic data): the permission matrix's number checks are
  allow for admin and both reps and deny for the logged-out, driver and inactive roles; no other
  cell changed; booking scenarios (draw-down numbers its order inside a SECURITY DEFINER function)
  unchanged.
- Not verified: live attributes and md5 pins (local replay only).
