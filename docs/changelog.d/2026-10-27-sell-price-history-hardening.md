## 2026-10-27 — Sell-price history hardening before apply (To-Do 0.4, PR #1122)

Fixes from the first Luna review round and the migration-drift and compliance reviewers, all made
before `20261026140000_product_price_history_starting_snapshot.sql` is applied.

- **Database:**
  - A starting-snapshot row must name no person and record no change: old equals new on every value. A real change can never be written as a snapshot.
  - The six tier-price columns of `cost_history` are held to whole cents. Live 2026-10-26: all 33 rows already were.
  - `products` is locked before `cost_history`, so the apply cannot deadlock with a pricing save.
  - The postflight now compares every snapshot value with its product.
- **Sell Price History card:**
  - A product with older history shows the prices before its first logged change as a "Before" band.
  - A product whose only logged change was to cost still shows its prices.
  - Switching products never flashes the previous product's history.
  - Dates are in Central time.
  - The was/now prices have higher contrast, and the price range is labelled.
  - Error reports never carry a price to Sentry.
- **E2E cleanup:** a refused batch delete falls back to one product at a time, so only the products with price history are kept. Any other failure now fails the cleanup instead of passing silently.
- **Proof:** `prove-price-history-snapshot-real-schema.mjs` passes on a fresh container (14 steps before and after the apply), including the two snapshot refusals and the sub-cent refusal.
