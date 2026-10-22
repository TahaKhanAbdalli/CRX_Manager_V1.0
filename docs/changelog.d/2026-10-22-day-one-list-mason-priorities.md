## 2026-10-22 — day-one list: Mason's priority changes and a build order

- `docs/plans/2026-10-21-day-one-must-work-list.md`: a new build order puts everything before delivery first: quoting,
  product pricing, cost tracking, inventory (knowing what to order) and invoicing. A new section 0 adds the pricing
  plan's slices 0–6 and 8 as MUST rows, plus the existing reorder, purchase-order and booking features. Cost
  freshness (slice 7, parked) goes back to Mason as a question.
- Field-app, job and blend-ticket invoices move to CAN-WAIT (built last). All returns work, including the new
  "sitting at farm" pickup tracking, is CAN-WAIT. Two applicators on one job is a new row 11.6 (a crew covers January;
  MUST before spring). Rules that only limit sales reps are CAN-WAIT until the first regular rep.
- Statuses refreshed to `13f83434d` (landlord split billing and split-order returns live, PR #1010).
- `docs/manual/DECISION_LOG.md`: new 2026-10-22 entry recording Mason's decisions.
- Documentation only.
