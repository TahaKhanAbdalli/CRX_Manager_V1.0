## 2026-10-15 — Phase 3 return-policy smoke chain repaired (fixture rot, not a product bug)

**Why.** The registered chain `scripts/smoke/smoke-supplier-pricing-phase3-return-policy.sql`
(spec `supplier_pricing_phase3_return_policy`) failed on `main` in a disposable real-schema
container. Three later, deliberate rules had overtaken its fixtures:
- products are born pricing-free and an order line needs a positive cost basis
  (`COST_BASIS_REQUIRED`);
- a return needs delivered quantity from completed delivery history behind each line
  (`RETURN_SOURCE_NOT_DELIVERED` in `create_return`, `RETURN_SOURCE_DELIVERY_NOT_COMPLETED` in
  `receive_return`);
- since `20260812130145` each public return wrapper is an intent-binding shell that delegates to
  `_<name>_intent_impl_20260812`, which holds the `assert_phase3_return_policy` call, so the
  chain's static "wrapper names the assertion" check looked in the wrong body.

**What changed.**
- The chain prices its four products through `preview_product_pricing_changes` +
  `apply_product_pricing_change_set` (and re-checks that pricing left their Phase 3 return
  metadata untouched), seeds each delivered product's warehouse row once, and delivers each
  returned order line through the real `complete_delivery` via a rollback-only `pg_temp` helper
  that checks the line ends fully delivered. Those order lines now start undelivered.
- The static check now follows the delegation and requires both links: the public wrapper calls
  its `_intent_impl_20260812`, and that body calls `assert_phase3_return_policy`.
- `receive_return` reports `restocked_quantity` as `2.00`; the check compares it as a number
  (still exactly 2) instead of as the text `'2'`.
- No assertion was removed or loosened. The behavioural refusals (no-return create and re-credit,
  governed metadata, forced late failures) are unchanged.
- New `scripts/smoke/prove-supplier-pricing-phase3-return-policy-real-schema.mjs`: replays the
  current schema in a network-disabled container and proves the chain passes, plus two controls
  (without the pricing setup it stops at `COST_BASIS_REQUIRED`; without the deliveries at
  `RETURN_SOURCE_NOT_DELIVERED`).

**Proof.** The new prover, 2026-10-15, on merge commit `42e663b20` (base `9b6eb8607`): replayed
111 post-baseline migrations through `20261015130000` (the parked customer-document file skipped,
the two withheld spring data migrations recorded in the ledger only), both controls failed at the
expected code, and the chain reached
`PHASE3_UNRELATED_CREDIT_MEMO_UNAPPLY_PASS` and `SMOKE_PASS_ROLLBACK` with no `[SMOKE]` row left.
Not run against the live database.

**Found, not fixed here.** The companion `prove-supplier-pricing-phase3-return-policy-concurrency.mjs`
no longer reaches its chain: its own migration replay stops at
`20260810010308_active_team_note_assignment_actor` with a `notify_team_note_assignment` preflight
drift. Recorded in `docs/manual/KNOWN_ISSUES.md`.
