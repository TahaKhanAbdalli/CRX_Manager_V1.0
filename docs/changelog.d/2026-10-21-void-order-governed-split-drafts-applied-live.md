## 2026-10-21 — void_order governed split drafts: migration 20261021030000 applied live

- `20261021030000_void_order_governed_split_draft_claims` (PR #987, merged as `05fdc3e40`) was applied
  live at 19:10:58 UTC (2:10 PM Central), ledger version `20261021191058`, through
  `scripts/apply-migration-file.mjs --confirm` under Mason's autonomous-landing rule (non-destructive).
- Post-apply read-only check: live `void_order` md5 `960b7306` and `_void_order_impl_20260714` md5
  `8ad84bdc` match the reviewed migration, one overload each; `void_order` is EXECUTE for
  `authenticated` and not `anon`.
- `docs/manual/KNOWN_ISSUES.md` now records the issue as fixed, and row 959 of
  `docs/reference/migration-history.md` records the apply.
