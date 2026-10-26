## 2026-10-26 — Sell-price history on the product page (To-Do 0.4, pricing plan slice 4)

Admins can now see how a product's sell prices moved over time. Mason, 2026-10-14: "only admin can see
the price history".

- **Product page** (admins only): a "Sell Price History" card charts tier 1, 2 and 3 prices on a real
  date axis (flat until a change, then a step), and lists every price change, newest first, with the
  date, where it came from (price sheet, product page, Products list) and the reason. A failed load
  says so, with Try again.
- **Supplier price chart:** its points are now placed by date, so a long gap shows as a gap, with the
  first and last date under the chart. They used to be evenly spaced.
- **Cost History card:** unchanged. It leaves the starting rows out, since they record no change.
- **Database** (`20261026140000_product_price_history_starting_snapshot.sql`):
  - A dated starting snapshot for each product with no history (578 of 604), recording its cost and
    tier prices on the day this applies, so "what was the price then?" has an answer. Products that
    already have history start at their first change; a product added later starts at its first
    logged change, and until then the card says no price changes were recorded since it was created.
    It adds about 578 rows and changes no existing row; a re-run adds nothing.
  - The snapshot row names no person, because no one made it. Every real change must still name who
    made it, and the database enforces that.
  - Deleting a product with history is now refused instead of silently erasing that history. The
    app has no product delete, and 602 of 604 products were already undeletable for other reasons.
- **Not in this change:** history for per-acre price changes and a required reason on every change
  are part of To-Do 0.1 (the price sheet's safety work), which another session is building.
- **Proof:**
  - `node scripts/smoke/prove-price-history-snapshot-real-schema.mjs` runs the migration on a
    disposable copy of the production schema. It covers the snapshot values, the refused re-run,
    the unattributed-change and unknown-source refusals, the refused product delete, who can read
    history, and preflight drift, and it runs the live smoke chain once.
  - The live self-undoing chain `smoke-price-history-snapshot.sql` runs after the apply.
