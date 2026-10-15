## 2026-10-15 - Goals plan: Mason's Goal 2 and Goal 3 walkthrough decisions recorded

Documentation only. No code or database changed.

Claude walked Mason through every remaining Goal 2 and Goal 3 item, checking each against the code at
`7cd781f77`: what happens today, what the plan would change, and a recommendation for each business
choice. An advisory Codex `gpt-6.1-sol` review of those decisions followed (advice, not a ship gate),
and Mason accepted all of its recommended changes. This change records the result.

- **`docs/plans/2026-10-13-direction-and-goals.md`:**
  - **Cost and margin are admin-only.** Sales reps don't see them either, even on their own invoices and
    quotes. This replaces the 2026-10-14 Goal 1 answer that reps keep cost and margin.
  - **No sales tax** is charged on anything.
  - **Commission already paid** on a returned or credited sale is deducted from the next payout.
  - **Goal 2:**
    - only an admin sets a new customer's commission split, through an admin to-do list that offers to
      apply the split to the customer's open records;
    - admins get an editor for job and order splits;
    - the own-name back doors found in the code are listed;
    - read-only scope, full customer balances and quote-split rules are recorded.
  - **Goal 3:**
    - list posting stays;
    - retries lock the form and check the first attempt; this covers the delivery page, the field stop and
      the Deliveries list;
    - a void cancels only draft or unposted invoices, and a posted invoice is credited from its original
      billed lines;
    - refunds paid outside CRX are recorded;
    - billing before delivery is removed;
    - charge lines are typed;
    - quick delivery is improved for counter sales;
    - an admin-only field-invoice credit is added;
    - ambiguous blend prices stop for staff to pick;
    - a narrow block stops CRX credits on Chem Man-billed deliveries;
    - **order and delivery split billing must work now**, covering landlords, partial deliveries and the
      "Bill Split" card.
  - **Goal 5** shrinks to "completing a delivery needs a signal", with a paper-ticket fallback.
  - **Rollout:**
    - a November–December real trial;
    - a day-one must-have list;
    - the senior developer engaged now;
    - a pilot emergency brake.
  - **Future work:**
    - automatic blend-ticket quote-line pricing;
    - split billing of field-application invoices;
    - full offline proof of delivery;
    - Chem Man features.
- **`docs/manual/DECISION_LOG.md`:** a new 2026-10-15 entry records these decisions.
