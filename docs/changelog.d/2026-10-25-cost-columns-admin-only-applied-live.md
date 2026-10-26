## 2026-10-25 — Cost lock applied live (Goal 1 step 3, PR #1089)

**What changed.** Migration `20261022101000_cost_columns_admin_only` (row 977) was applied live on
2026-10-25 at 22:34:47 UTC (5:34 PM Central) on Mason's in-chat approval, before PR #1089 merged as
`e2f095d9c`; ledger version `20261025223447`. Signed-in users (`authenticated`) and signed-out visitors
(`anon`) can no longer read or write cost, profit or margin columns on the 12 remaining cost tables;
admins read cost through `get_admin_cost_fields` and quote history through `get_quote_versions`. The old
whole-row `invoice_post_version(public.invoices)` is dropped; screens read the version from `invoices_postable`.

**Proof.** Read-only `execute_sql` after the apply: 0 of the 30 cost, profit and margin columns readable by
`authenticated` or `anon`, `service_role` unchanged, `products.id` still readable, `invoices_postable`
readable by `authenticated`, `invoice_post_version` gone; ledger 1060 rows / 1053 names, high-water
`20261022101000`. The schema registry was regenerated from live (only the high-water and the new name changed,
as expected for a grants-only migration).

**Docs.** `migration-history.md` row 977 and live capture, `CURRENT_STATE.md`, `KNOWN_ISSUES.md` KI-02 (now the
server-function audit only, MED) and KI-74, `gotchas.md`, `rpc-functions.md` and the goals doc record the apply.
CodeRabbit's three deferred items from PR #1089 are handled here or listed in KI-02: the goals-doc role wording and
apply order are fixed; the proof script's repeated ledger-only inserts and JSON whole-row serializers join the KI-02
follow-up.

**Still owed.** The live smoke chains wait for PR #1092 (the live-data guard fix); Mason's rep sign-in check on
the live site; the KI-02 server-function audit.
