## 2026-10-20 - Goal 3: invoices made from scratch carry charge lines only

- An invoice with no order and no delivery behind it (a `misc_charge` or `chemical_sale` from the
  New Invoice page) can no longer carry product lines (Mason, 2026-10-14 decision 6e and
  2026-10-15). Product is sold through an order and a delivery; a counter sale uses a quick
  delivery.
- Migration `20261021050000_from_scratch_invoices_charge_lines_only` (not applied yet): new column
  `invoice_items.charge_type` (freight, application fee, service, other) with a shape check (no
  product, quantity 1, no cost, a positive amount); two triggers refuse a product line on such an
  invoice on every write path and at posting (`FROM_SCRATCH_INVOICE_PRODUCT_LINE_REFUSED`); the
  `save_invoice` writer stores the charge type and refuses an untyped line on such an invoice; a
  line from any other writer (today only finance charges) is typed "other" automatically, and the
  shape check then refuses anything that is not a single charge.
- The New Invoice page shows **Add Charge** (type, description, amount) instead of Add Product on
  such an invoice and explains why. A new invoice on that page now always opens as a locked Misc
  Charge (a bare `/invoices/new` used to open as a Chemical Sale that `save_invoice` refuses
  without an order, so it could never be saved; Codex connector P2 on PR #983). Order-backed, field-application, blend-ticket and job invoices
  and return credit memos are unchanged.
- Proof: `scripts/smoke/prove-from-scratch-invoice-charge-lines-real-schema.mjs` builds the
  production schema baseline plus every migration in a throwaway database and checks every refusal
  and every still-allowed case of the Goal 3 done-test, before and after the migration.
- Not in this change: the quick-delivery improvements (quantities below 1 unit, "completed now").
- The line trigger also runs when a line's charge type changes, so clearing a type on a deleted
  invoice while someone restores it cannot leave an active invoice with an untyped line (Codex
  connector P2 on PR #983; the real-schema proof races it in both orders and shows the gap reopens
  without the fix).
- Restamped 2026-10-21 from 20261020150000 to 20261021050000: PR #982's blend-ticket migration
  (20261020210000) was applied first, and the ordering guard refuses a file below the live authored
  high-water. Content unchanged.
- A new charge line starts with no type (and no quantity box), and the page refuses to save until
  staff pick one, so a charge is never filed as freight by default (Codex connector P2 on PR #983).
- A charge line's description must contain a real character: a description of only tabs or
  newlines is refused, not just one of spaces (Codex connector P2 on PR #983).
- A negative amount typed into an invoice line's price is refused with a message, instead of being
  silently flipped to a positive charge (Sol, PR #983).
