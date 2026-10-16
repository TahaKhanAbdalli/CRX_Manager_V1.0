## 2026-10-15 — money retries can no longer report success for the wrong record (replay-binding batch 1)

When an action is retried, many database functions hand back the first attempt's saved answer
matched on the retry key alone. A retry that reused a key for a different record therefore got
the first record's "done" answer, and the new record was never touched. Nothing was ever done
twice; the harm was a false success. This change:

- **Writes the system-wide inventory** into `docs/manual/KNOWN_ISSUES.md`. About 170 live functions
  replay a saved answer: about 95 are already bound to the caller and the exact request, and about
  75 are not, ranked into four batches. Gauntlet row 3.5 (commission payments) was re-verified as
  fixed live since 2026-08-11.
- **Fixes batch 1, the nine money actions** (migration `20261016060000`, not applied when written):
  `void_payment`, `delete_prepay_credit`, `edit_prepay_credit`, `apply_write_off`,
  `reverse_write_off`, `apply_prepay_to_invoice`, `create_prepay_check_splits`,
  `batch_apply_prepayments`, `batch_void_invoices`. Each live body is renamed unchanged, and a
  same-name wrapper replays a saved answer only for the same person and the exact same request; a
  different record, amount or person is refused and nothing changes. An exact retry still
  returns the original answer. Also in the same file: `reverse_write_off`, `delete_prepay_credit`
  and `edit_prepay_credit` now require an ACTIVE admin (a deactivated admin could still reverse a
  write-off); a commit-time guard refuses any receipt for the nine actions that is not bound to
  its caller; the nine now require a retry key (every screen already sends one); the file refuses to apply while a recent receipt for them exists; and the private
  batch-prepay helper is no longer callable by the server role. It narrows access, so it applies
  only on Mason's owner approval.
- **App:** the eight screens that call these functions drop a retry key refused as another request's or another person's (and keep it when the database cannot confirm an earlier outcome) so the next
  click starts fresh, and the refusal codes now show plain-English messages
  (`src/lib/errorSanitizer.ts`).
- **Proof:** `node scripts/smoke/prove-money-replay-binding-batch1-real-schema.mjs`
  (`MONEY_REPLAY_BINDING_BATCH1_PROOF_PASS`) and the rollback-only chain
  `scripts/smoke/smoke-money-replay-binding-batch1.sql` (spec `money_replay_binding_batch1`).
- **Rollback:** the migration header lists the order to undo it, removing the commit-time guard first.
