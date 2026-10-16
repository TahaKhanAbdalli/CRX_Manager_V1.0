## 2026-10-15 — Goal 4: every active product can be found in four product lists (M1–M4)

**Why.** The Goal 4 row-limit audit (`docs/audits/2026-10-15-goal4-row-limit-inventory.md`,
PR #939) found four product lists that loaded only the first 500 active products, alphabetically,
while the live database had 595. Products from "Storen - Bulk" onward could not be picked or seen.

**What changed.**
- New `src/components/products/ProductSearchPicker.tsx`: an active-product picker that searches
  the database as you type (two letters or more, up to 20 matches), following the Invoice product
  search pattern. Results show SKU, family, package and unit so similar products can be told
  apart. The search term is quoted for PostgREST, so names with commas such as "2, 4D Ester" work.
  A failed search shows "Product search failed" instead of "no matches", and a full page of 20
  results says "keep typing" instead of hiding the rest.
- M1 Reports › Chemical History product filter, M2 Sales Reports product filter and M3 Crop
  Programs product select now use that picker. Crop Programs still copies the product's default
  rate and unit, and an existing program shows its saved product names.
- M4 Reports › Price List reads every active product page by page through the existing
  `fetchAllRows` helper, shows the product count, and the CSV exports that full list. If any page
  fails, the list is cleared, a red error explains it, and Export CSV is disabled, so a partial
  price list never looks complete. Because the pages are separate reads, the list is then checked
  against a second read of the active product ids: a repeated product, or a difference between the
  two sets of products (a product activated or deactivated before the second read ran), also shows
  the error. The reads are not one transactional snapshot: a product switched off and back on
  between them leaves the sets equal and is not detected. Only the newest load may update the
  screen.
- The picker shows and accepts only results for the text currently typed, treats a typed `%` or
  `_` literally, keeps result buttons out of the Tab order, and announces status messages.
  `ProductSearchResult` lives in `src/types/index.ts`.

**Review.** Codex Luna (4 rounds) and the compliance reviewer; every BLOCKER/HIGH fixed. Deferred,
with reason: a price edited during the sub-second read can appear at its new value beside rows
read just before (every row is still a real current price; a frozen snapshot needs a database
function, out of scope). Noted, not changed: the Price List's cost column is visible to sales reps,
as before; that belongs to the Goal 1 admin-only cost decision.

**Proof (2026-10-15, dev server against live data, read-only).** Live `SELECT count(*)` of active
products: 595; #500 is "Storen - Bulk". Price List on screen: "Active products: 595"; its CSV: 595
data rows ending at "Zorina - 2.5 Gal", the same last product as the database. "Zoom - Bulk"
(past #500) was found and selected in all three pickers, and the Chemical History and Sales Reports
requests carried its real product id. A simulated failure of the second price-list page showed the
error and disabled the export; a retry loaded all 595. Crop Programs forms were cancelled, nothing
was saved.

No migration. Out of scope (unchanged): the audit's other findings.
