## 2026-10-25 — To-Do rows 0.12 and 0.16 closed; live evidence for 0.8 and 0.10

**What changed.** `docs/manual/TO_DO_LIST.md` only. Mason closed row 0.12 (product category remap) and row 0.16
(merge duplicate vendor names) in chat on 2026-10-25: "mark the category remap and the duplicate vendors marked
done". Read-only live checks the same day back both: the category remap already shipped in July (migration
`20260702170000`), and all 595 active products sit in 11 categories with none blank; no duplicate vendor names
remain across vendors, products and purchase orders.

**Evidence recorded.** Row 0.8: 0 of 595 active products have a reorder point, so "Need Reordering" shows only
negative stock until Mason sets them after the stock count (15.2). Row 0.10: the "booked" figure (59,149 units)
equals exactly what open orders still owe; 14 March 2026 orders hold about 56,600 of those units and are to be
reviewed in 15.2. Row 0.16 also lists the small vendor leftovers (junk vendor "we" on open PO-2026-0030, two
products with a blank vendor, no vendor email addresses).

**Not changed.** No data, code or migration. Rows 0.13, 0.14 and 6.9 are being fixed in a separate PR.
