## 2026-10-20 — four actor-forgery flags from the cost/margin wrappers closed as false positives

- **Finding.** After migration `20261019010000` (PR #957, cost and margin admin-only) went live, the
  `actor-forgery` sweep showed four rows: a new one for `get_gross_sales_report` (on `p_group_by`) and
  three whose reviewed fingerprints no longer matched (`get_profitability_report`,
  `get_sales_summary_report`, `save_quote`). All four changed only in that migration.
- **Verdict: none is a hole.** Read live with `pg_get_functiondef`:
  - The three reports are read-only. `p_group_by` is a grouping choice (customer, product, month), not a
    person. It is flagged only because its name ends in "by" and the new admin-only wrapper passes it on
    to the renamed original body. Gross sales and profitability now require an admin
    (`require_admin()`). The sales summary blanks cost, profit and margin for non-admins. The renamed
    bodies keep their own admin-or-rep checks, and no browser role can call them.
  - `save_quote`, a money writer, got a full re-review of its current body. The only change is a step at
    the end that hides cost and margin from non-admins in the reply. The impersonation check is unchanged
    and runs first: `_begin_below_cost_money_write` refuses a missing login, any `p_performed_by` that is
    not the logged-in user, and anyone who is not an active admin or rep. The private body then checks
    the actor again, before any write.
- **Change.** `scripts/db-invariant-sweeps/allowlist.json`: one new fingerprint-bound exception
  (`get_gross_sales_report`) and three re-pinned ones. Each is pinned to the live wrapper, its private
  body, `auth.uid()` and the role helpers it calls. The digests come from the sweep's own contract query.
  The allowlist test's exception count goes from 22 to 23. That is counted after merging `main`, which
  already carries #971's `start_and_complete_delivery` entry. No database change.
- **Owner decision.** The Codex GitHub review pointed out that the `p_group_by` exceptions conflict with
  Mason's 2026-09-02 call to keep those look-alikes visible. On 2026-10-20 Mason chose to mark them as
  reviewed. `docs/manual/DECISION_LOG.md` records the reversal, and the 2026-09-02 triage audit carries a
  pointer to it.
- **Proof.**
  - **Final.** The live `actor-forgery` sweep was run read-only on 2026-10-20, after #971 merged, and
    adjudicated against this allowlist. It is PASS: 19 rows, 19 allowlisted, 0 violations.
  - **Control.** An earlier same-day capture against `main`'s allowlist before #971 left 5 rows: these four
    plus `start_and_complete_delivery`.
  - **Tests.** `allowlist-match.test.mjs` passes 656 assertions after the merge. Before the merge,
    `npm run proof:actor-allowlist` passed 627 matcher checks and 34 disposable-database checks.
