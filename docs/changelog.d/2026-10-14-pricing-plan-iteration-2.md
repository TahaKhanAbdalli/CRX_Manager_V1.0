## 2026-10-14 - Pricing plan, iteration 2: three sessions' findings merged and three owner decisions recorded

Documentation only. No code or database changed, and nothing is built.

Mason asked the sessions looking at pricing ("CRX pricing updates and history" and "Missing pricing and cost
tracking features") to compare notes and produce one document to build from. The existing draft plan on
PR #905 became that document instead of a second plan being written.

- **`docs/plans/2026-10-13-pricing-history-cost-tracking-and-quote-pricing-PLAN.md`:**
  - records Mason's 2026-10-14 answers (revised quotes keep locked prices, with an "update to today's
    prices" option per line and for the whole quote, and a rewind to the last version sent; reps see
    last-charged prices while price history stays admin-only; prices keep coming in through the full Excel
    workbook, with no automatic PDF reading for now, and inline price edits stay for one-off fixes);
  - adds section 7: why the app looks like it "went backwards" (data starvation, not removed features), and
    eleven findings with live read-only evidence, including the Convert path confirmed from live function
    bodies, the need for a database-enforced lock, tier changes erasing negotiated prices, the missing
    starting snapshot, unlogged per-acre changes and the optional reason;
  - updates slices 2-4 and the open questions to match, and records a third read of PRs #397 and #350;
  - adds section 8, a `gpt-6-sol` high review of the Excel workbook method that Mason asked for. Of its 30
    findings, the ones checked as already handled (formula rejection, all-or-nothing apply, blank-mode
    refusal, before/after preview, version conflicts) are separated from the real gaps (export follows the
    page filter, no outlier warnings, tier fallback not shown, no per-row source, no approval receipt). It also
    adds a draft monthly routine, a "workbook hardening" slice 0 and two open questions.
- **`docs/manual/DECISION_LOG.md`:** one 2026-10-14 entry for the three decisions.

Checked: live read-only queries and live function definitions on 2026-10-13/14. A claim from one session that
the New Order cost path is open was refuted against the live `zz_crx_below_cost_order_items` trigger.

Not exercised: every behavior above was read from code or live function text, not run.
