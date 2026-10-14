## 2026-10-14 - Pricing plan follow-up: two review fixes deferred from PR #905

Documentation only. No code or database changed, and nothing is built.

PR #905 merged with two valid Codex review notes deferred so its approved, Sol-reviewed head could land:

- **`docs/plans/2026-10-13-pricing-history-cost-tracking-and-quote-pricing-PLAN.md`:** slice 2 now prefers
  version snapshots that carry `quote_item_id` so Convert can match lines exactly. Until then, the conversion
  RPC refuses and asks for a re-send unless current and sent lines pair up one-to-one by product, because
  `create_quote_version` snapshots `product_id` and price but not `quote_item_id`. The proof covers added,
  removed and swapped products, a duplicate added in the revision, and duplicates already present when sent.
- **`TODO.md`:** the landlord split-billing line now points to the `KNOWN_ISSUES.md` entry that PR #901
  added ("Splitting an order's bill to a landlord always fails") as well as the 2026-10-13
  `DECISION_LOG.md` entry. It also says the trigger refuses order-linked splits, not every split: the live
  `guard_invoice_terminal_order()` returns before its customer check when an invoice has no `order_id`.
