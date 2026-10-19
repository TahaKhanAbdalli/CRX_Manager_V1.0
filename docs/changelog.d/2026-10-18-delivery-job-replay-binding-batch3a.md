## 2026-10-18 — delivery and job completions can no longer report success for the wrong record (replay-binding batch 3a)

When a completion is retried, `complete_delivery` and `complete_job` hand back the first attempt's
saved answer matched on the retry key alone. A retry that reused a key for a different delivery or
job, or after a driver edited quantities or the signer, therefore got the first answer as success,
and the new request was never carried out (no stock moved, no invoice draft). Nothing was ever done
twice; the harm was a false success. This change:

- **Splits the money group** (KNOWN_ISSUES.md, the table's batch 3) into smaller PRs and fixes the
  first cut, the two field completions that move money and stock (migration `20261019200000`, not
  applied when written). Each live body is renamed unchanged, and a same-name wrapper replays a saved
  answer only for the same person and the exact same request (delivery or job, quantities, signer,
  issue type and notes, completion time, applied info). Anything else is refused and nothing
  changes. An exact retry still returns the original answer, and the offline queue replays a
  saved action as before (one whose delivery or job changed since it was saved still goes to office
  review first, before this check). Both now require a retry key (every screen and the offline queue already send one). The
  commit-time guard that refuses an unbound receipt now covers both; it applies only over the live
  batch 1 + stock batch (PR #951) guard. The file narrows access, so it applied only on Mason's owner approval: applied live 2026-10-19
  20:52:46 UTC (ledger `20261019205246`), after which a read-only check found both wrappers, both renamed
  bodies (unchanged md5s) and the 24-operation guard live.
- **App:** the five completion screens (Deliveries, Delivery detail, Field stop, Field view, Job
  detail) drop a retry key on any replay-binding refusal (another request's or person's key, or a
  receipt that can never be used), which is safe because the database refuses a second completion
  of the same delivery or job. Each screen then reloads the delivery or job (closing its completion
  modal or form where it has one), so a completion an earlier attempt already saved shows at once
  instead of a stale form. The three delivery screens resend the completion time a retry key first carried, so a retry across midnight still replays instead of being refused. Job detail now shows the plain-English refusal
  instead of "Failed to complete job". The nine browser-test calls to `complete_delivery` now send
  a key.
- **Proof:** `node scripts/smoke/prove-delivery-job-replay-binding-batch3a-real-schema.mjs`
  (`DELIVERY_JOB_REPLAY_BINDING_BATCH3A_PROOF_PASS`, Docker) and its chain
  `scripts/smoke/smoke-delivery-job-replay-binding-batch3a.sql`, which is CONTAINER ONLY: a delivery
  completion draws a customer-visible invoice number that a rollback does not return, so the chain
  never runs against live (after the apply, live proof is a read-only check of the deployed bodies);
  `src/__tests__/replayBindingBatch3aCallSites.test.ts` pins the screen and browser-test call sites.
  `smoke-delivery-accounting-period-guard.sql` now accepts either refusal for another person's
  retry key.
- **After the apply:** the DB invariant sweeps ran read-only (28 of 29; `quote-versions-rpc-owned` was declined).
  `complete_delivery`'s actor-forgery exception is re-pinned to the batch-3a wrapper
  (`scripts/db-invariant-sweeps/allowlist.json`), and `complete_job`'s is retired because its wrapper no longer
  trips the check. Five actor-forgery flags remain from earlier changes, not this one (`save_quote`,
  `get_profitability_report`, `get_sales_summary_report` and `get_gross_sales_report` after `20261019010000`,
  and `apply_prepay_to_invoice` after `20261016060000`), each awaiting its own review. The registry
  records `20261019010000` and `20261019200000` as applied (high-water `20261019205246`), which retires
  the `_enforce_below_cost_line` inventory exemption in `src/lib/rpcContracts.test.ts`.
- **Rollback:** the migration header lists the order to undo it, narrowing the commit-time guard
  first.
