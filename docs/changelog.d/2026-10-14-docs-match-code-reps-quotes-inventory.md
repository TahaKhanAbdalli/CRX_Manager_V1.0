## 2026-10-14 — docs match the code: sales reps, quote conversion, order edits, purchase orders, inventory math

The docs cleanup (#915, #916) listed places where a rule page and the code disagreed and left them
for Mason. His decision (2026-10-14, "update the docs to match the code"): the docs follow the code.
Each statement below was re-checked against the latest migration or source file before editing.
No code or database changed.

- **Sales reps work with any customer** (migration `20261013220000`): `README.md` role table,
  `docs/reference/rpc-functions.md` (save_invoice, statements, year-end summaries, split resolver,
  customer facts), `docs/reference/qa-testing.md` (customers, quotes, orders, fields) and the
  customer rows of `docs/reference/database-schema.md` (copied from `RLS_SECURITY_GUIDE.md`).
  Reps read every quote but edit only their own (`NOT_QUOTE_OWNER`); only an admin reassigns a
  customer.
- **Quote to order:** `convert_quote_to_order()` converts a `sent`, `revised` or `accepted` quote
  and marks it `accepted`; inventory holds exist only while a planned quote is draft/sent/revised
  (`docs/workflows/QUOTE_TO_DELIVERY.md`).
- **Order line edits:** `update_order_items()` is admin or sales rep.
- **Purchase orders:** reps create, edit, submit, cancel and receive; only admins delete
  (`qa-testing.md`). Drivers and applicators have no Dashboard access.
- **Inventory math** (`docs/workflows/INVENTORY_RULES.md`): low stock, on order and delivered
  this season now show the formulas `get_inventory_position()` uses; the order-creation warnings
  are described as computing net position from the stored `inventory.quantity_on_order` column;
  the `booked`, `prebooked`, `released` and `transferred` ledger types say what really writes them.
- Smaller code-matching fixes in `QUOTE_TO_DELIVERY.md`: `confirm_delivery()` does no stock check,
  and an empty tier 2/3 price falls back to tier 1 on field-application invoices.
