## 2026-10-14 — Reps work with any customer: live record, and four repaired smoke chains

**Live record.** `20261013220000_reps_work_any_customer` applied 2026-10-14 13:14:50 UTC (ledger version
`20261014131450`) on Mason's in-chat owner-approval reply; PR #907 merged as `395bdcd9a` at 13:16 UTC
(its squash title still says "not applied"); the `customer-document-files` Edge Function was redeployed as
v2 at 13:54 UTC on his yes. Read-only re-check 14:16 UTC: 1025 ledger rows / 1018 names, trigger
`customers_guard_rep_edit_20261013` enabled, function v2 ACTIVE. Updated: `docs/reference/migration-history.md`
(new live capture, row 943 APPLIED), `docs/manual/CURRENT_STATE.md`, `docs/manual/KNOWN_ISSUES.md` (deploy
follow-up resolved), and `docs/manual/ARCHITECTURE.md`. This PR had also brought `.claude/schema-registry.json` to live by delta
(CodeRabbit: high-water and applied-name list were still at `20261012234633`); PR #921 then regenerated the
whole registry from live at 17:28 UTC, so this PR now carries main's copy unchanged. Still owed: a signed-in
rep click-through on the live site (goals doc, Goal 2).

**Smoke chains.** After the apply, the live run of the new `reps_work_any_customer` chain passed, but three
older chains this change edited stopped AFTER every step it touches, on fixtures that rotted under earlier
rules. Fixed (chain files only; no app or database change):
- `smoke-financial-scope-and-delivery-aggregate.sql`: created its product with `current_cost`, which
  `require_governed_product_pricing` refuses on INSERT (`PRODUCT_PRICING_GOVERNED_PATH_REQUIRED`, since
  2026-07-18). Now creates a pricing-free shell and prices it through `preview_product_pricing_changes` /
  `apply_product_pricing_change_set`, the pattern of `smoke-order-invoice-type-gate.sql`.
- `smoke-per-line-split-billing.sql`: its cost-less product hit `_enforce_below_cost_line`
  (`COST_BASIS_REQUIRED`) before the split guards ran. Same governed pricing (cost 5.00, the same price
  across all three tiers); the line still uses its manual override price.
- `smoke-adversarial-money-inventory-closeout.sql`: its source-text check expected `save_purchase_order`
  to call the ASCII-identity impl directly. Since `20260726190515` it takes the PO advisory lock and calls
  `_section9_save_purchase_order_serialized`, which owns the bulk vendor checks and calls the identity impl.
  The check now follows that chain (verified against the live bodies 2026-10-14). Past it, the chain billed
  a draft PO, which `create_vendor_bill` refuses (`PO_NOT_BILLABLE`, same migration); it now submits the PO
  through `submit_purchase_order` first, as the app does.
- `smoke-save-quote-customer-row-version.sql` (not run live after the apply): its cost-less product hit
  `_snapshot_quote_item_cost` (`COST_BASIS_REQUIRED`, since 2026-08-12). Same governed pricing (cost 5.00,
  tier price 7.00); the server-math check now expects the governed values (2 units: 14.00 price, 10.00
  cost, 4.00 profit) instead of zeros, still proving the forged client 999s never land. The non-office
  refusal now reads `INSUFFICIENT_ROLE` (`_begin_below_cost_money_write`, `20260812115237`, runs before the
  impl's older message; same refusal, verified against the live bodies).

**Proof so far.** All four repaired chains and `reps_work_any_customer` end in `SMOKE_PASS_ROLLBACK` in a
disposable PostgreSQL 17 container built from the production baseline plus every migration through
`20261013220000` (`CRX_PROVER_BUILD_ONLY=1 CRX_PROVER_KEEP_CONTAINER=1 node
scripts/smoke/prove-reps-work-any-customer-real-schema.mjs`, then the candidate applied and each chain run
with `psql -f`); before these edits each stopped at the step described above. The quote chain also runs in
`scripts/smoke/prove-quote-customer-row-version-real-schema.mjs` on the July 2026 catalog; it now clears
the pricing and role steps there too (the non-office check accepts that catalog's older message), but that
prover was already failing on `main` for two unrelated reasons (`smoke-backfill-refuse-split-billing.sql`'s
CRX-LIFE-001 step, and the quote chain's 2026-10-13 customer-rule asserts, which a July catalog cannot
meet); it is left for a separate fix.

**Live re-run.** On Mason's REAL-DATA-OK (given in chat for that run only; the marker was removed after it),
all four repaired chains returned `SMOKE_PASS_ROLLBACK` on live at about 15:00 UTC, as written at revision
`0472e7254`; a read-only check afterwards found no leftover `[SMOKE]` rows and the split-billing flag
unchanged (details on the PR). The quote chain's money asserts were made NULL-safe afterwards (`336198c9e`),
and that version was not re-run live; it was re-run at head `8a30f2986` in the disposable container and
returned `SMOKE_PASS_ROLLBACK`. The other three chains are unchanged since the live run.
