## 2026-10-22 — blend-ticket invoice LOW fixes applied live (migration 20261022020000, PR #1020)

`20261022020000_blend_invoice_binding_lows` went live at 15:59 UTC (10:59 AM Central; ledger version
`20261022155943`) and PR #1020 merged as `a5c7fa851` at 16:01 UTC. Mason applied the reviewed file
himself in the Supabase SQL editor, in one transaction with its ledger row, because he chose to skip
the CodeRabbit review the migration landing gate requires for money PRs; Sol was clean on the merged
head, CI green and both apply-proof reviewers clean. A read-only check confirmed the live function is
the reviewed body (md5 `a6f5c6e7…`) with unchanged security and grants.

- `docs/reference/migration-history.md` row 966 is marked APPLIED, with a new live capture at the top.
- `docs/manual/KNOWN_ISSUES.md` records the four LOW fixes (and the zero-quantity refusal) as live.
- `.claude/schema-registry.json` regenerated from live introspection (high-water `20261022155943`;
  adds the #1010 and #1020 migration names and #1010's `return_credit_customer_claims` table).
- After PR #1006 landed, row 967 (`20261022021000`, ledger `20261022163441`) is marked APPLIED too, and the
  registry was regenerated again from live through it (high-water `20261022163441`, name list only).
- `src/lib/rpcContracts.test.ts` drops the `guard_invoice_terminal_order` exemption: its migration
  `20261021150000` is now in the applied snapshot, so the guard is no longer discovered.
- Follow-up: the blend ticket screen has no plain-English message for the new
  `BLEND_INVOICE_QUANTITY_ROUNDS_TO_ZERO` refusal yet, so staff see the database text (PR #1034).
