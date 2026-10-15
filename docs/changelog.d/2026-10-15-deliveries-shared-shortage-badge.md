## 2026-10-15 — Deliveries list flags deliveries that compete for the same stock

The amber "Inventory shortage" triangle on the Deliveries list used to compare each delivery with
the Main Warehouse stock on hand by itself. Two deliveries that each fit, but together needed more
than was on hand, showed no warning. The badge now sums each product's need across every active
(scheduled or in-progress) delivery on the list, and flags every delivery that needs a product
whose combined need exceeds the stock on hand (Mason, 2026-10-14, "flag shared shortages"). It does
not decide which delivery gets the stock first, and it is still a warning only: nothing is blocked,
and the database's own check at delivery completion is unchanged.

- New helper `findShortDeliveries()` in `src/lib/inventoryShortage.ts`, with unit tests.
- `src/pages/Deliveries.tsx` uses it; the column help text explains the shared count.
- A page-level test renders the real Deliveries page with two deliveries sharing one product and
  fails against the old per-delivery logic.
