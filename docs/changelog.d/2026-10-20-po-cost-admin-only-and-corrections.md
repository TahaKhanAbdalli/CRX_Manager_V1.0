## 2026-10-20 - Purchase-order cost becomes admin-only, with a cost history and governed corrections

Mason chose "Option B" for the purchase-order cost project (KNOWN_ISSUES, the top-priority follow-up
from PR #965). Migration `20261021140000_po_cost_admin_only_and_corrections` (NOT applied; it must be
applied before this PR merges, because the screens read its new column and history table) and the
four purchase-order screens.

- **Reps no longer set purchase cost.** A trigger on every purchase-order line gives a line that a
  signed-in non-admin adds (or switches to another product) the product's catalog cost and flags it
  `cost_needs_review`; any cost a rep sends is overruled, and an existing line keeps its cost.
- **Admins correct or confirm cost, received lines included.** New admin-only
  `set_purchase_order_item_costs` changes only the line cost and the PO total, never inventory, a
  receiving record or the product's catalog cost. A received line needs a reason. Saving a flagged
  line at the same cost confirms it. Before this, a received cost could only be fixed by reversing
  the receipt, which took the stock back out of inventory.
- **Cost history.** Every cost change (and every confirm) is written to the admin-only, append-only
  `purchase_order_item_cost_changes`: who, when, old and new cost, quantity received, and why.
- **Screens.** Purchase order list, new purchase order, purchase order detail and PDF import show
  cost only to admins (the `costFields.test.ts` exemption for these four screens is removed). The
  detail page gains a Cost History card, Unconfirmed badges and a unit-cost window ("Correct Unit Cost", or "Confirm / Correct Cost" when a rep line waits)
  with a reason box; the list gains a "Costs to confirm" filter for admins.
- **Not changed:** inventory value and margins already use the catalog cost, not purchase-order cost
  (live read 2026-10-20), so a correction moves no inventory value. Catalog cost still changes only
  through the pricing workbook (Mason, 2026-10-20).
- Review fixes: only a real cost change (logged) or the confirm button clears "unconfirmed" — an
  admin's unit or product edit that keeps the cost leaves it flagged; a fractional cent is refused
  by name (`PO_UNIT_COST_FRACTIONAL_CENT`); the Cost History card says "Loading" or "Could not
  load" instead of claiming no changes after a pending or failed load.
- Sol fixes (2026-10-21): a rep's cost sent on a received line is now stripped before the
  received-line check, so a rep cannot guess a received cost by watching which guess saves; the
  admin correction locks a PO's lines before the PO, the same order receiving and cost-basis use.
  A correction that would leave active vendor bills more than 5% over the lowered PO total is
  refused (`PO_COST_BELOW_BILLED`), matching the bill-creation control.
- **Column lock (Mason, 2026-10-20, "Add the lock now"):** migration `20261021141000` stops every
  Data API caller, admins included, from reading purchase-order line cost and PO totals directly;
  admins read them through the admin-only `get_admin_cost_fields`. No screen changed: none reads those
  columns. Sol and the Codex PR review had blocked the project on this gap.
- Proof: `node scripts/smoke/prove-po-cost-admin-only-and-corrections-real-schema.mjs`
  (PO_COST_ADMIN_ONLY_CORRECTIONS_PROOF_PASS).
