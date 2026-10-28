## 2026-10-27 — Stock tables take writes only through the stock RPCs

- Mason (2026-10-26): "fix all four gaps", including "stock history never takes bypass entries".
  New migration `20261027080000_stock_tables_governed_writes_only.sql` (row 996, NOT APPLIED, stamp
  and row are placeholders from Taha's fork) removes INSERT/UPDATE/DELETE/TRUNCATE on
  `inventory_transactions` and `inventory` from PUBLIC, anon and authenticated, then gives
  authenticated UPDATE on only `reorder_point`, `min_stock_level` and `updated_at`.
- Every real stock move goes through SECURITY DEFINER RPCs and is unaffected, so every change to
  stock leaves its ledger row.
- Caller check 2026-10-27: the only app write is the Stock screen bulk edit (reorder point / min
  stock), which keeps working; every other app use is a read; no invoker function or trigger writes
  either table.
- Access change on existing tables: applies only after Mason's in-chat `I approve`.
- Proof (local Supabase replay of main `fe258c2f` + this file, synthetic data): permission matrix
  direct writes to the stock ledger and stock on hand are deny for every app role; the new "edit a reorder point" check stays allowed for admins;
  no other cell changed; the booking scenarios are unchanged.
- Not verified: the live grants (read on a local replay only); Mason re-reads live before applying.
