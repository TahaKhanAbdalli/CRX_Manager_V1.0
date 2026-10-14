## 2026-10-13 - Pricing history, cost tracking and quote pricing set as the next section of work (plan only); two owner decisions recorded

Documentation only. No code or database changed, and nothing is built.

Mason asked for an adversarial review of the old GitHub branches for work worth reusing, with his example
"pricing history lookup and cost tracking on products for quoting". He then asked to put this at the top
of the to-do list as the next section of work, iterated before anything is built.

- **`TODO.md`:** a new "Next section of work" block at the top.
  - It says to plan and iterate first, not build.
  - It names the kept branches that hold reusable work (PRs #397, #350 and #892).
  - It notes that the 2026-10-13 direction-and-goals plan (PR #904) does not list pricing among its goals.
  - It adds a dated item: fix the UTC-year numbering for quotes, orders and rebate claims before
    2026-12-31.
  - It adds a line for the landlord split-billing fix.
- **New draft plan:** `docs/plans/2026-10-13-pricing-history-cost-tracking-and-quote-pricing-PLAN.md`. It
  covers:
  - what the app already has, with the checks behind it;
  - what is missing;
  - the reusable work, with the exact commits and the deleted designs' recovery commands;
  - a draft build path;
  - the open questions, including those raised by the quote-lock decision.
- **`docs/manual/DECISION_LOG.md`:** two of Mason's 2026-10-13 decisions, both recorded as not built yet:
  - a sent quote's prices stay locked until it is accepted or expires;
  - an order's bill can be split to a landlord. The live invoice trigger refuses that today.

Checked:
- the commits and deleted documents the plan points to exist;
- live read-only counts were taken for `cost_history` (33 rows) and `quote_items` (20);
- the order-cost trigger was confirmed enabled;
- the landlord refusal was read from the live trigger function.

Not exercised: the quote re-pricing and landlord behaviors were read from code, not run.
