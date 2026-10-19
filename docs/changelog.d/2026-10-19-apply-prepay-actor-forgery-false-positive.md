## 2026-10-19 — apply_prepay_to_invoice actor-forgery flag closed as a false positive

- **Finding.** The `actor-forgery` sweep flagged the batch-1 wrapper `apply_prepay_to_invoice`: its
  keyless internal-batch branch hands `p_performed_by` to the private body before the wrapper's own
  `ACTOR_MISMATCH` check.
- **Verdict: not a hole.** Read live: the private body (executable only by `postgres`) binds the actor
  to `auth.uid()`, refuses any differing `p_performed_by`, role-gates the logged-in user, and never
  uses `p_performed_by` again. The only keyless caller (`_batch_apply_prepayments_impl`) passes no actor.
- **Change.** A fingerprint-bound `actor-forgery` exception in `scripts/db-invariant-sweeps/allowlist.json`
  pinned to the live wrapper, private body and `auth.uid()` definitions; the allowlist test's exception
  count goes 20 -> 21. No database change. `KNOWN_ISSUES.md` marks the item CLOSED, and the
  `migration-history.md` banner now reads LATEST LIVE EVIDENCE (CodeRabbit's deferred note on PR #958).
- **Proof.** `npm run proof:actor-allowlist` passes (589 matcher + 34 disposable-database checks); the live
  sweep re-run still reports the row, and the matcher clears it only with the live pins.
