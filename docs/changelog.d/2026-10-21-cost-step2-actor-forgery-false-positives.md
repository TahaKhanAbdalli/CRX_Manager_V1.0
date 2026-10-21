## 2026-10-20 — two actor-forgery flags from the cost/margin step-2 wrappers closed as false positives; three stale exceptions removed

- **Finding.** After migration `20261019230000` (cost/margin step 2, PR #956, ledger `20261020193610`) went
  live, the `actor-forgery` sweep flagged two new rows: `save_job` and `save_field_app_invoice`, both on
  `p_performed_by`. Three older exceptions (`create_application_record_from_blend_ticket`,
  `create_direct_order`, `create_rush_order`) also had fingerprints that no longer matched live.
- **Verdict: no hole.** Read live with `pg_get_functiondef` on 2026-10-20 (Central):
  - Both new public wrappers start with `IF auth.uid() IS NULL OR p_performed_by IS DISTINCT FROM auth.uid()
    THEN RAISE ACTOR_MISMATCH`, so a missing login, a blank user or a different user is refused before
    anything else runs. The scanner does not credit that combined one-line refusal, so the hand-off to the
    private body looked unguarded.
  - The private bodies (`_save_job_cost_step2_impl`, `_save_field_app_invoice_cost_step2_impl`) can only be
    called by `postgres`. Each binds the user from `auth.uid()`, refuses a mismatch, and requires an active
    admin or sales rep before any write. That role check is a direct `profiles` lookup inside the pinned
    body, not a call to a helper such as `is_sales_rep()`. `save_job` writes `created_by` from
    `p_performed_by`, which the wrapper has already forced to equal the logged-in user. The field invoice
    body passes the bound user, not the parameter, to the next step.
  - The three stale entries belong to functions rebuilt by the replay-binding batches. Their new wrappers
    refuse a forged user up front, and the live sweep no longer flags them, so the exceptions authorized
    nothing and described bodies that no longer exist.
- **Change.** `scripts/db-invariant-sweeps/allowlist.json`: two new fingerprint-bound exceptions (wrapper,
  private body, `auth.uid()`, `is_admin()`; digests read live with the sweep's own contract expression)
  and three removed. `allowlist-match.test.mjs`: exception count 22 → 21, plus checks that both new
  exceptions are present and the three removed ones stay gone. No database change.
- **Proof.**
  - Full live sweep, read-only, 2026-10-21 (Central), run fresh after migration `20261020210000` went
    live: all 29 predicates captured and `--adjudicate` (no `--only`) returned `complete: true`, every
    predicate PASS (`actor-forgery`: 21 rows, 21 allowlisted, 0 violations; `quote-versions-rpc-owned`:
    0 rows). One Supabase connector declines the quote-versions query without showing a prompt, so it
    ran byte-exact through the second read-only Supabase connector with Mason present.
  - Control: the same captured `actor-forgery` packet against `main`'s allowlist leaves exactly
    `save_field_app_invoice` and `save_job`.
  - `node --test scripts/db-invariant-sweeps/*.test.mjs`: 6 of 6 files pass.
  - Luna review round 1: one HIGH (asked for an `is_sales_rep()` pin) refuted — neither private body
    calls it; the role check is the inline `profiles` lookup inside the pinned body, now stated in both
    justifications. The MED (no presence check) and LOW (UTC date) were fixed.
  - Luna review round 2: HIGH accepted. The field-invoice exception now also pins the inner writer
    `_save_field_app_invoice_impl_20260714` and the `is_sales_rep()` helper it calls. That writer
    re-binds the user from `auth.uid()`, refuses a mismatch, requires admin or sales rep, and refuses a
    non-admin who names another salesperson. The `actor-forgery` predicate was re-run live with the new
    pin list: still 21 rows, 21 allowlisted.
  - Luna review round 3: one MED fixed — the test now asserts each new exception pins exactly the
    contracts its justification relies on.
