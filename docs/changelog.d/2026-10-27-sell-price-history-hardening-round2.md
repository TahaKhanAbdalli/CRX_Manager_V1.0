## 2026-10-27 — Sell-price history: second review round fixes (To-Do 0.4, PR #1122)

These fixes come from Luna's second review, before `20261026140000_product_price_history_starting_snapshot.sql` is applied.

- **Whole cents in the database:** the whole-cent rule on the six `cost_history` tier prices now also refuses NaN and the infinities. Both of those equal their own rounded value, so the first version let them through. Prices must sit between minus and plus ten billion dollars, which covers every `numeric(12,2)` product price.
- **Converting a price to cents:** `priceToCents` refuses any price with more than 10 dollar digits. Past that point a value delivered as a JSON number can lose a cent. A product price never has more than 10 dollar digits.
- **Order of the history:** the starting snapshot always comes first in a product's history. A price save that races the apply records its transaction start time, which can be earlier than the snapshot's.
- **E2E cleanup:** cleanup keeps a product only when the refusal names `cost_history_product_id_fkey`. Any other conflict fails the cleanup.
