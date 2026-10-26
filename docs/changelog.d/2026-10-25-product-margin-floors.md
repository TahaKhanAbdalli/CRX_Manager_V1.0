## 2026-10-25 — Margin floor per product (To-Do 0.2, pricing plan slice 8)

Each product can now carry its own net-margin floor: the lowest margin, (price − cost) ÷ price, it should
sell at. Mason, 2026-10-14: floors are set per product, with no company-wide default. A product with no
floor skips only the low-margin warning. The price sheet's warnings (To-Do 0.1, the next PR) read these
floors.

- **Database** (`20261025210000_product_margin_floors.sql`):
  - New admin-read-only table `product_margin_floors` (one row per product that has a floor).
  - New append-only history `product_margin_floor_changes`: who, when, old and new floor, and why.
  - New admin-only function `set_product_margin_floors`, which sets, changes or clears floors for one
    or many products, with a required retry key. No API role can write either table directly.
  - Nothing existing changes: no price, cost, quote or order is touched.
- **Product page** (admins): a "Margin Floor" card under Pricing & Margins. You type a percent and an
  optional reason. It flags any tier already under the floor and lists recent floor changes.
- **Products list** (admins, with costs shown): a "Floor %" column you can edit inline. The net margin
  under each tier price turns red with "under N% floor" when it is below the floor.
- **Proof:**
  - `node scripts/smoke/prove-product-margin-floors-real-schema.mjs` runs the migration on a
    disposable copy of the production schema and covers admin, rep, driver, deactivated admin and a
    signed-out visitor, plus the retry key, input refusals, append-only history, grants, preflight
    drift and a mutation.
  - The live self-undoing chain `smoke-set-product-margin-floors.sql` runs after the apply.
- **Not done here:** setting floors on live products is a live data change that only Mason makes (or
  approves). The price sheet's warnings are To-Do 0.1.
