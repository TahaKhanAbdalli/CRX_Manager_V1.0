## 2026-10-22 — Bulk PO import refuses a unit cost past two decimals instead of rounding it

**What changed.** When OCR reads a unit cost like `$10.006` off a vendor document, the admin's
review table in **Import POs from Documents** (`src/components/purchase-orders/BulkPOImport.tsx`)
now marks that cost box red with "Enter an amount with no more than two decimal places.", leaves the
PO out of the **Import N POs** count, and refuses to import it until the admin types an exact cost.
Before, the browser silently rounded it to whole cents (`$10.01`) and saved that. This follows Mason's
money rule: more than two decimals is refused, never rounded. It closes the deferred Luna finding
from PR #980; the rounding behavior itself predates #980.

**Unchanged.** A sales rep's import still sends no cost at all (purchase cost is admin-only since
#980), so a rep can import the same document and the line arrives flagged for an admin to confirm.
The PO detail cost editor already refused sub-cent input; no database change.

**Proof.** `src/components/purchase-orders/BulkPOImport.test.tsx` now proves an OCR cost of `3.334`
blocks the import (button reads **Import 0 POs**, input `aria-invalid`, no `save_purchase_order`
call), then saves `3.33` / `333` cents after the admin corrects it; a second test proves a rep's
import of the same document still goes through. The old test that asserted rounding was replaced.

**Review fixes (same PR).** The check now uses the shared `isWholeCentPurchaseOrderCost` rule (the
New PO screen's) and also checks the text the admin typed, so `10.0000000000000001` is refused rather
than silently becoming `10`. The red error shows only on lines that are saved (matched, quantity above
zero), is linked to the box for screen readers, and the line and PO totals show a dash instead of a
rounded figure while a cost is invalid. **Known gap, not fixed here:** the `process-document` Edge
Function turns OCR text into a number with `parseFloat`, so a cost with more than about 15 significant
digits is shortened on the server before the browser sees it; closing that needs an Edge Function
deploy.

**Luna round 2 fixes.** A cleared cost box is now treated as missing ("Enter a unit cost (type 0 for no
cost).") instead of silently becoming $0.00, so clearing a refused OCR cost can no longer import the
line at zero; an explicit `0` still imports. The PO total in the review header shows a dash whenever any
line's cost is invalid, because it sums every line.

**Luna round 3 fixes.** Picking the product for a line no longer replaces a cost the admin typed (an
explicit `0`, or a cleared box still to fill) with the catalog cost; only an untouched OCR line without a
cost takes the catalog cost, as before. A negative cost now says "Unit cost cannot be negative." instead
of the decimal-places message.

**Codex GitHub App fixes.** A typed cost is saved and totalled from its exact text, never through a
binary float. `save_purchase_order` receives dollars beside cents and refuses a pair that disagree, so a
typed amount whose dollar number cannot carry its exact cents (from about $90 billion up, such as
`90071992547409.91`) is refused on the line ("This unit cost is too large to save exactly.") instead of
failing at save. The table footer's PO Total now shows a dash like the header while any cost is invalid.
