## 2026-10-18 — Money retry binding, batch 1: live function bodies checked (migration `20261016060000`)

**Why.** The batch-1 records said the nine money functions are bound, from the ledger row and the
post-apply postcondition read. No record showed a read of the live function source proving the
binding happens before any saved result can replay.

**What changed.**
- `docs/reference/migration-history.md`: row 951 records the 2026-10-18 11:56 UTC read-only check.
  On every keyed call, all nine live wrappers require a signed-in caller, refuse a forged
  `p_performed_by`, fingerprint the request and call `check_idempotency_intent` before any saved
  result can come back. The one keyless call left is `apply_prepay_to_invoice` inside
  `batch_apply_prepayments`, covered by the batch's own bound key.
  `_bind_replay_receipt_20261015`, the other helpers and the nine renamed bodies have no API-role
  EXECUTE; the bound-receipt trigger is live and deferred.
- `docs/manual/KNOWN_ISSUES.md`: the replay-binding entry records the same result.

**Still open.** Replay-binding batches 2–4, and a live exact-retry check for `edit_prepay_credit`.
