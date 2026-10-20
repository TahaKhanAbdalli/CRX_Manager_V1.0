## 2026-10-20 - Cost step 2 recorded as applied live

- `20261019230000_cost_margin_admin_only_screens_step2` is recorded as APPLIED LIVE (2026-10-20 19:36:10 UTC,
  ledger `20261020193610`, carried by PR #976, merged as `2c448ce4e`) in migration-history row 956,
  `rpc-functions.md`, `CURRENT_STATE.md` and `KNOWN_ISSUES.md`, after a read-only re-check of the ledger and the
  new functions' grants.
- The step 2 records now say the four purchase-order screens are the exception to "screens read only non-cost
  columns" and to "`get_admin_cost_fields` is the only cost read after step 3" (CodeRabbit, PR #965).
- The #976 changelog now says the live apply ran before the merge (Codex, PR #976).
- `CURRENT_STATE.md`'s schema-registry note now names the two applied migrations the registry still lacks.
