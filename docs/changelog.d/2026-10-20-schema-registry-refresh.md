## 2026-10-20 — schema registry brought current with the two migrations applied on 2026-10-20

- **Why.** The session-staleness check reported `.claude/schema-registry.json` as behind: two applied
  migrations were missing from its applied-name list. They were
  `20261019220000_start_and_complete_delivery` (ledger `20261020022222`) and
  `20261019230000_cost_margin_admin_only_screens_step2` (ledger `20261020193610`).
- **Change.** The registry was regenerated with `scripts/regenerate-schema-registry.mjs --from-introspection <queries.json>` (the Q1–Q6 results; see the script header).
  `migrations_high_water` moves from `20261019205246` to `20261020193610`, and the two names are added.
  `_meta.generated_at` moves from 2026-10-15 to 2026-10-20. Nothing else in the registry changed. `docs/manual/CURRENT_STATE.md`'s "Schema registry" bullet now says
  the registry is current.
- **Proof.** The live ledger was re-read read-only: 1038 rows, newest `20261020193610`. Read-only md5 hashes
  of the live sequences, generated columns, all 346 CHECK constraints, the per-table column lists and the
  applied names matched the regeneration input exactly. After the refresh, `session-staleness.mjs` no longer
  reports the registry as behind. No database change.
