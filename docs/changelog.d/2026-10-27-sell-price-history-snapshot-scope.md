## 2026-10-27 — Sell-price history: snapshot also covers cost-only histories (To-Do 0.4, PR #1122)

Fix from the third Luna review round, made before `20261026140000_product_price_history_starting_snapshot.sql` is applied.

- **Which products get a starting snapshot:** every product whose history records no sell price, not only products with no history at all.
  - Live on 2026-10-26, 9 products had only cost-only rows from older writers, with no tier prices. 8 of those are priced, and their cards would have shown no prices.
  - About 587 rows are added (was 578). A re-run still adds nothing, because a product that already has a snapshot is skipped.
- **Postflight and live smoke:** both check the new rule. A snapshot may sit only on a product whose history recorded no sell price before it, and a product may have at most one snapshot.
- **Smoke note:** the smoke chain now explains how to read a price save that raced the apply.
- **Proof:** a cost-only product was added to `prove-price-history-snapshot-real-schema.mjs`. It gets its snapshot.
