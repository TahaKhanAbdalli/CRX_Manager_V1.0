## 2026-10-21 — actor-forgery sweep: save_purchase_order exception re-reviewed and re-pinned

- The 2026-10-21 live db-invariant sweep run failed one predicate: `actor-forgery` flagged
  `save_purchase_order` because its reviewed exception in
  `scripts/db-invariant-sweeps/allowlist.json` pinned the old wrapper digest (`83373a60…`).
  Migration `20261021140000` (PR #980, purchase-order cost admin-only) had replaced the wrapper's
  body when it was applied live.
- Re-reviewed against live `pg_get_functiondef`: the live wrapper matches the migration, and the
  one new step only strips `unit_cost` / `unit_cost_cents` from a non-admin's items. It does not
  touch `p_performed_by`, which still goes unchanged to the owner-only
  `_section9_save_purchase_order_serialized` (digest unchanged). That body binds `auth.uid()`,
  refuses a forged or NULL actor with `ACTOR_MISMATCH` before any write, then requires admin or
  sales rep. Grants are unchanged: `authenticated` and `service_role`, no `anon`. Still safe.
- The exception is re-dated 2026-10-21, re-justified, and its wrapper digest re-pinned to the
  live value `f98e0839…`, re-measured with the sweep's own contract expression. The other four
  pins are unchanged, and the exception count stays the same.
- Proof: `allowlist-match.test.mjs` (633 assertions) and `npm run proof:actor-allowlist` pass.
  The live `actor-forgery` packet, captured read-only through Supabase MCP and adjudicated with
  `run-sweeps.mjs --only actor-forgery --adjudicate`, gives PASS (21 of 21 rows allowlisted).
  The same packet against the old allowlist gives FAIL on `save_purchase_order` only.
