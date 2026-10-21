## 2026-10-19 — cancelling or voiding a delivery or order can no longer report success for the wrong record (replay-binding batch 3b; written, not yet applied)

When a cancel or void is retried, `cancel_delivery`, `void_delivery` and `void_order` hand back the
first attempt's saved answer matched on the retry key alone. A retry that reused a key for a
different delivery or order, or after the user edited the reason, therefore got the first answer as
success, and the new request was never carried out. Nothing was ever done twice; the harm was a false
success. `cancel_delivery` also handed back a saved answer before checking the caller's role. This
change:

- **Database** (migration `20261019235000`, not applied when written): the second cut of the money
  group. Each live body is renamed unchanged, and a same-name wrapper requires a retry key, checks
  the caller's identity and role first (same messages as before), and replays a saved answer only for
  the same person and the exact same request (the delivery or order, and the reason). Anything else
  is refused and nothing changes; an exact retry still returns the original answer. The commit-time
  guard that refuses an unbound receipt now covers these three too (27 operations). Batch cancel
  keeps cancelling each delivery with no per-delivery key: its private body now calls the renamed
  cancel body directly. `void_order`'s inner body is no longer callable by the server role (nothing
  called it), and it now cancels an order's draft invoices at zero, as `cancel_order` does, so
  voiding a fulfilled order that has a draft invoice no longer fails (see the Luna round 1 entry). The file narrows access, so it applies only on Mason's owner approval.
- **App:** Delivery detail (cancel, void) and Order detail (void) now keep one retry key per exact
  request (the record and the reason), keep it through an unclear reply so an exact retry replays the
  saved answer, and retire it only after a confirmed result. On any replay-binding refusal the screen
  retires the key and reloads the record, which is safe because the database refuses a second cancel
  or void of the same record. The "F1 deliberately not fixed" notes on these three sites are gone.
- **Proof:** `node scripts/smoke/prove-delivery-order-void-replay-binding-batch3b-real-schema.mjs`
  (`DELIVERY_ORDER_VOID_REPLAY_BINDING_BATCH3B_PROOF_PASS`, Docker) and its chain
  `scripts/smoke/smoke-delivery-order-void-replay-binding-batch3b.sql` (container only), plus
  `src/__tests__/replayBindingBatch3bCallSites.test.ts`. `smoke-draw-ledger-reversal.sql` now sends a
  retry key on its four `void_order` calls.
