## 2026-10-26 — Cost lock post-apply live smoke passes (row 977, PR #1089)

**What changed.** The live smoke chains owed after migration `20261022101000_cost_columns_admin_only` (applied
2026-10-25, row 977) ran once PR #1092 let rollback-only batches through the live-data guard. Documentation only:
`migration-history.md` row 977 records the result.

**Proof.** Run on 2026-10-26 around 9:50 AM Central from main `355ca249a`, each chain as one rollback-only batch
through Supabase MCP `execute_sql` on project `rhyzpcqhnizqbxphqdkr`. All three ended in `SMOKE_PASS_ROLLBACK`, so
nothing persisted:

- `smoke-post-binds-reviewed-invoice-version.sql`: posting still demands the loaded invoice version; the old
  no-version signatures are gone; an admin's version from `invoices_postable` matches the posting helper; a real
  standalone draft posted with a stale version is refused (`INVOICE_CHANGED_SINCE_LOADED`) and keeps its status;
  grants unchanged.
- `smoke-invoices-postable-view.sql`: the view is `security_invoker`, carries every invoices column except
  `total_cost_cents`, is SELECT-only for `authenticated` and `service_role` and closed to `anon`/PUBLIC; the
  version function is SECURITY DEFINER for `authenticated` only.
- `smoke-cost_margin_admin_only_rpc_leaks.sql` (the #1106 literal-EXECUTE version): an active admin runs all six
  cost reports; an active sales rep, driver, applicator, commission recipient, an id with no active profile and a
  signed-out visitor are refused; sales detail and summary give the rep the admin's rows with every cost, profit
  and margin value blank; inventory position gives the rep no `current_cost`.

A follow-up read-only count found 10 live standalone drafts (so the stale-version refusal ran on real data, not
skipped), 14 live invoices, and no function named `invoice_post_version`.

**Still owed.** Mason's rep sign-in check on the live site; the KI-02 server-function audit.
