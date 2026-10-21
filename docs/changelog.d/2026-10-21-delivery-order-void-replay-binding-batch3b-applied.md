## 2026-10-21 — replay-binding batch 3b recorded as applied live (cancel, void delivery, void order)

- **Applied:** migration `20261019235000_bind_delivery_order_void_replay_receipts_batch3b` went live
  2026-10-21 02:40:20 UTC (9:40 PM Central, 2026-10-20), ledger version `20261021024020` (authored
  name kept), through `scripts/apply-migration-file.mjs --confirm` (HTTP 201, queryHash
  `a98c18db0131d0258a59e8c837b8d139c6c90a66e7822f139920ce6445115924`) on Mason's in-chat owner
  approval for PR #967 head `ed2bd8733`, after a clean exact-SHA Sol proof and clean
  rls-security-reviewer / migration-drift-reviewer apply proofs. Read live afterwards: the three
  public wrappers (`cancel_delivery`, `void_delivery`, `void_order`) bind receipts through
  `check_idempotency_intent` and `_bind_replay_receipt_20261015`; the renamed bodies,
  `_batch_cancel_deliveries_replay_impl_20261015` and `_void_order_impl_20260714` are postgres-only;
  the commit-time guard lists 27 operations; no receipt exists for the three operations; a keyless
  `void_order` call is refused with `IDEMPOTENCY_KEY_REQUIRED`.
- **Docs:** migration-history row 957 now reads APPLIED LIVE, with a new 02:43 UTC ledger capture at
  the top (1039 rows / 1032 names, `max(version)` `20261021024020`, effective high-water
  `20261019235000`). KNOWN_ISSUES records batch 3b as bound and drops the three functions from the
  unbound table (69 functions left: 12 in batch 3, 50 and 7 in batch 4); the split-invoice void
  follow-up stays open. CURRENT_STATE names batch 3b as the newest applied migration.
- **Registry:** `.claude/schema-registry.json` brought to `migrations_high_water` `20261021024020` by
  delta, listing the new name (function bodies, grants and one trigger function only, none tracked by
  the registry). The pre-apply exemption for `_batch_cancel_deliveries_replay_impl_20261015` in
  `src/lib/rpcContracts.test.ts` is pruned, as its own comment required.
- **Sweeps:** 28 of the 29 predicates ran read-only after the apply; `quote-versions-rpc-owned` was
  declined at the tool prompt and did not run, so the capture is not complete gate evidence. 27 of
  the 28 pass. `actor-forgery` still flags two rows unrelated to batch 3b, `save_job` and
  `save_field_app_invoice` (their cost-step-2 wrappers from `20261019230000`); a read of the live
  bodies shows both refuse any `p_performed_by` other than `auth.uid()` before doing anything, so they
  look like predicate-shape false positives, but they are left visible for their own review.
- **Allowlist:** `cancel_delivery`'s `actor-forgery-fin-audit` exception is removed (the new wrapper
  writes no financial audit row and is no longer flagged there). Its `actor-forgery` exception was
  re-reviewed against the live wrapper and renamed body and re-pinned: wrapper
  `21da58c0c8f22d933ddd6938f5927194` to `ceca41e58b2d66e219b1631d3a286a7a`, plus a new pin on
  `_cancel_delivery_replay_impl_20261015` (`74e680863ab82db808c1b72bbac34748`); `auth.uid()` is
  unchanged. The allowlist tests now expect 22 actor exceptions and one contract-pinned actor
  predicate.
