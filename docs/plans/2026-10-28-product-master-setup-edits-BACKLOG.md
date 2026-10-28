# Product Master – Product Setup Edit List

**Status:** BACKLOG, not started. Mason, 2026-10-28: "log all issues, we wont start the work yet, put the file in repo for future work." This list does not authorize building anything. Each item, or group of items, gets its own plan and pull request. Items marked 💲 touch pricing or money, and need the money-path review when built.

**Where it came from:** items 1–2 are Mason's own, from using the product setup screen. Items 3–43 come from a read-only code review of the Products list (`src/pages/Products.tsx`), the product page (`src/pages/ProductDetail.tsx`), bulk import (`src/components/products/`) and the shared dropdown (`src/components/ui/Combobox.tsx`), checked against `main` at `5b0246530`. Re-check each item against current code before building it; line numbers drift.

**Suggested order when work starts:** first the small bugs that affect daily use (2, 9, 3, 4, 5–8), then Use Timing (1 and 32), then the 💲 gaps (16, 17, 20), then everything else.

## 1. Use Timing (Product Information section)

- **1a. Multi-select.** A product can be used at more than one timing, so you should be able to pick several.
  - Today the field holds one value. Allowing several means a database change (a migration), plus updates to bulk import and the pricing workbook export, which also read this field.
- **1b. New options:** Post-Emerge Corn, Post-Emerge Soybeans, Pre-Emerge.
  - Options today (Herbicide): Post-Emergence, Pre-Emerge Corn, Pre-Emerge Soybean, Volunteer Corn, Range/Pasture/Turf. Foliar Fertilizer shows only "Foliar".
  - To settle at build time: keep the generic "Post-Emergence", or replace it with the two crop-specific ones? Products already saved with the old value would need moving over.
- **1c. Bug: the dropdown won't scroll**, so the lower options can't be reached or clicked. May partly be caused by item 2.

## 2. Bug: dropdown boxes show only the current choice

- When a box already has a value, clicking it shows only that value, not the full list. This affects Category, Vendor, Manufacturer, Use Timing and others.
- Cause (confirmed in `src/components/ui/Combobox.tsx`): the list is narrowed by whatever text is already in the box, and the saved value counts as typed text.
- Fix: show every option on click, and narrow the list only once the user starts typing. This is a shared component, so the fix also reaches the same kind of box on other pages (good, but those pages need checking too).

---

## Found by the review agent (2026-10-28)

The agent read the code only and did not click through the app. ✅ = I re-checked it in the code myself. ❓ = needs a hands-on test to confirm. 💲 = touches pricing or money. Size: S = small, M = medium, DB = needs a database change.

### Bugs
- **3. 💲 ✅ Pricing mode resets every time you open a product (S).** Prices and margins are always saved together, so the page can't tell which mode was used, shows "Choose a mode", and locks the boxes. The list page has the same problem.
- **4. 💲 ❓ Typing in Net Margin % may get scrambled (S).** For example, typing "25" may come out as 2.05%. The box reformats itself after each keystroke.
- **5. ✅ The list's Active/Inactive switch skips the open-PO check (S).** The Deactivate button blocks products with open POs; the inline switch doesn't.
- **6. ✅ If the open-PO check fails, deactivation goes ahead anyway (S).**
- **7. ✅ Sales reps see a Deactivate button that always fails (S).** Only admins are allowed to change products.
- **8. 💲 The customer Sales Sheet can include inactive products (S),** even though its title says "active".
- **9. Clicking a dropdown again after picking doesn't reopen it (S).** Tabbing away also leaves the list open. Fix alongside item 2.
- **10. Bulk import rejects common spellings ("Liquid", "jug") and doesn't say which row failed or why (S).**
- **11. Bulk import can silently skip rows and map some columns to the wrong field (S).** Example: a "unit" column.
- **12. Bulk import allows container size 0; the product page doesn't (S).**
- **13. The Container Unit box can show blank while a value is saved (S).**
- **14. Changing Product Form wipes the inventory and container units but not the rate unit (S).**
- **15. Small validation gaps (S):** a name of only spaces passes; Rate Per Acre can be negative; REI/PHI "12.5" quietly becomes 12; blank fields are saved as empty text instead of blank.

### Gaps
- **16. 💲 ✅ "Unit" can't be set on the product page, but job and crop-program price math uses it (M).** Products created in the app have none. "Unit" and "Inventory Unit" also overlap, which is confusing.
- **17. 💲 Changing a priced, stocked product's inventory unit gives no warning (M).** Prices don't rescale, and the cost basis quietly resets.
- **18. Return policy, full-tote-only, packaging variant and product family can't be set in the app (DB).** 581 products show "Return: unknown".
- **19. Nothing catches duplicate products (S as a warning).** Re-importing a CSV doubles the catalog.
- **20. 💲 ✅ After creating a product you land back on the list (S),** and it's already sellable before it has a price (M if we add a "needs pricing" step).
- **21. Only the name is required; there's no "incomplete setup" flag or filter (S).**
- **22. The product's EPA number isn't format-checked (S),** though the brand form's is. About half of stored EPA numbers are already known to be wrong.
- **23. Max label rate can't be seen or edited on the product page (S).** Suggested Rate, Rate Per Acre and max label rate overlap with no explanation.
- **24. Category, Vendor and Manufacturer are free text, so typos create new groups (S warning / DB managed lists).**
- **25. The list has no Active/Inactive filter (S).** Search skips EPA and manufacturer, and there are no RUP, signal word or unit columns.
- **26. Inactive products can't be selected, so there's no bulk Reactivate (S).**
- **27. Deactivating only checks open POs (M).** It ignores open quotes, orders, stock on hand, crop programs and scheduled jobs.
- **28. No way to bulk-update details of existing products (M).** Fixes go one product page at a time.
- **29. Bulk import can't set RUP, signal word, REI/PHI or notes, and there's no template file (S).**
- **30. The history says only "Product updated", not what changed or who changed it (M).**
- **31. ❓ Fixing a product's REI/PHI or EPA number may not update open jobs or invoices (M).**
- **32. Changing category leaves a hidden old Use Timing value behind (S).** Fold into item 1.
- **33. New units, container types or product forms (e.g. seed, "each") need a database change (DB).**

### Enhancements
- **34. 💲 One way to change cost instead of four, and ask for the reason once (S–M).**
- **35. 💲 A pick list for the price-change "source" instead of retyping it each time (S).**
- **36. 💲 Warn when tier prices are out of order (S).** For example, Tier 2 above Tier 1.
- **37. A "Duplicate product" button for the same chemical in another size (S–M).**
- **38. EPA lookup could fill in a new product's blank fields (S–M).**
- **39. List edit mode turns all ~600 rows into edit boxes at once (M),** with no unsaved-changes warning and a poor phone layout.
- **40. Exports should include EPA, RUP, signal word, REI/PHI and units (S).**
- **41. 💲 Clear up the "Gross Margin vs Net Margin" wording (S).**
- **42. Hide or reword the "Phase 2 release gate" text on the Cost Basis card (S).**
- **43. Show reorder point and stock on hand on the product page (S–M).**
