## 2026-10-25 - Recorded: a bulk re-import is "already imported" whatever its costs (row 978 live)

- Migration `20261022100000_bulk_po_fingerprint_ignores_cost` (migration-history row 978, PR #1058, merged as
  `d68758028`) was applied live 2026-10-25 18:23:56 UTC (1:23 PM Central), ledger version `20261025182356`,
  before the merge, through `scripts/apply-migration-file.mjs` with every gate passed.
- Read-only live check after the apply: `_save_purchase_order_ascii_identity_impl` is SECURITY DEFINER with
  `search_path=public, pg_temp`, leaves cost out of the content fingerprint, and is not executable by `anon` or
  `authenticated`; `purchase_order_import_intents` holds 0 claims. The full ledger is 1059 rows; the effective
  ordering high-water is `20261022100000`.
- Not run: the live smoke chains, because the live-data guard now refuses application RPC calls in rollback-only
  smoke batches. The Docker real-schema proof passed 34/34.
- Row 978, a new live capture in `migration-history.md`, the `CURRENT_STATE.md` ledger header, the
  `rpc-functions.md` note and the schema registry's applied names and high-water now reflect live.
