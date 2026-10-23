## 2026-10-23 - Recorded: the "new logins cannot pick their own role" migration is live

- Migration `20261022023000_handle_new_user_ignores_signup_role` (migration-history row 969, PR #1039, merged as
  `f1f6e6aa3`) was applied live 2026-10-23 03:16:52 UTC (10:16 PM Central, 2026-10-22), ledger version
  `20261023031652`, through `scripts/apply-migration-file.mjs --confirm` on Mason's in-chat `I approve`.
- Read-only live check 03:21 UTC: `handle_new_user()` has one overload, body md5 `737785431fdbfc9b6b38c1ed6f2cd0f4`
  (the postflight pin), owner `postgres`, `search_path=public, pg_temp`, and the `on_auth_user_created` trigger is
  enabled.
- Row 969, the `CURRENT_STATE.md` and `KNOWN_ISSUES.md` ledger headers, and the schema registry now reflect live.
  The `handle_new_user` entry is pruned from `MUTATOR_INVENTORY_EXEMPT` in `src/lib/rpcContracts.test.ts`, as its
  note asked once the migration applied.
