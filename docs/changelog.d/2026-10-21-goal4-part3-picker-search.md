## 2026-10-21 - Pickers search the database or read every record (Goal 4, part 3, first PR)

Customer, field and product pickers no longer stop at 500 or 1,000 rows; the order, job and purchase-order pickers listed under "Deferred" below still do until the second part-3 PR. Frontend only, no migration.

**New shared search box.** `src/components/ui/RecordSearchPicker.tsx` searches the database as you type: one character or more, the first 20 matches, a "keep typing" note on a full page. Thin versions sit beside it: `CustomerSearchPicker` (farm name or account number), `FieldSearchPicker` (field name, optionally one customer's fields) and the existing `ProductSearchPicker` from #944, now built on the same box.
- A failed search shows a red "… search failed" with a Retry button, never "no matches". A search with no reply in 15 seconds counts as failed.
- The search term is quoted for PostgREST (`src/lib/recordSearch.ts`), so commas, brackets, quotes, backslashes, `%` and `_` are searched literally (the old `.or()` comma trap). A typed `*` still acts as a wildcard, as PostgREST defines it.
- Records a page must not offer (the customer itself as its own parent, customers already in a split, fields already added) are left out in the database query, before the 20-row limit.
- Results belong to the conditions they were searched under. Changing customer or filter drops them and searches again.
- A page may refuse a pick; the box then keeps the previous name. An empty box says "Type to search"; one character is enough, so a record named "A" can be found.

**Now database searches** (old limit in brackets):
- Customer Detail parent customer (500).
- Field Setup owner and "add customer to billing split" (500).
- Order Detail bill-split customer (500).
- Application Service rate-override customer (1,000).
- Select Locations customer filter (1,000).
- New Order customer (1,000). The `?customer_id=` link and a restored draft load their customer by id. A failed or missing load blocks pricing and saving instead of pricing at tier 1.
- Quote Builder customer (1,000) and section field (1,000). Fields are limited to the quote's customer, and choosing another customer clears a field that belongs to someone else. A quote's saved customer and fields load by id, and a missing one blocks saving.
- Blend Ticket Detail customer (1,000). A ticket whose saved customer cannot be loaded blocks saving and billing.
- AR Aging statement customer, Field Invoices customer summary, Compliance license customer, Prepay "New Check" customer (each 1,000).
- Split billing field and chemical-line product (1,000 each).

**Now complete paged reads** (`fetchAllRows`). These lists are used whole, not just for picking:
- Job Detail customers, fields and products: names on sheets and notifications, billable acres, label guardrails, unit conversions.
- New Order, Quote Builder and Order Detail product catalogs: tier pricing, admin cost overlay, catalog search.
- Blend Ticket Detail products and fields, manual blend ticket products.
- Bulk Field Import customers, Select Locations fields.
- Jobs customer filter (multi-select).
- Inventory products and customers.
- Prepay Workspace customers with a prepay balance.
- Quick Delivery, Quick Receive, Blend Recipes, Brand vs Generic (products and mappings).
- Compliance field listing (its Total Fields and Total Acres cards).

A failed complete read clears the list (never a short or previous list), says so on screen, and blocks the actions that depend on it.

**Deferred to the second part-3 PR:**
- the order, job and purchase-order pickers (New Delivery orders M17, Blend Ticket linked job M34, split-billing jobs M38, vendor bill link-to-PO M47);
- cycle-count locations (N6), the manual blend ticket customer list (read in full by Blend Tickets), and Field Customer Assignment's own dropdown.
- Bulk import name matching (M48/M49), Label Data Quality and Product Detail's choice lists (M60).

Not in this PR, because other sessions own those files: the Invoice Detail customer picker (M29) and the purchase-order screens. The blend-ticket scanner (M51) needs an Edge Function deploy.

**Late replies (CodeRabbit review 3).** A late reply never overwrites newer data:
- Customer Invoice Summary ignores a report for a customer no longer chosen, and an older report for the same customer.
- Inventory keeps only the newest product and customer list reads.
- Quote Builder refuses a customer, tier or section field change while saved lines exist and products are still loading, since repricing then would convert units at a factor of 1. With no lines, a pick or a `?customer_id=` link still works.

**CodeRabbit review 5.**
- Opening a saved quote never clears a section's field. Only a customer change during the field's load clears it.
- Quick Receive offers no product until its catalog has loaded, and a failed load closes an open picker.
- Search boxes use 16px text on phones, so iOS does not zoom in on focus.

**Known limits, for part 4:**
- Complete paged reads still grow with the table. They are correct at any size, but slow at very large sizes.
- More than 20 records with identical names and no account number or SKU to tell them apart cannot all be reached.
- `%term%` search speed at large volume may need a trigram index.

**Review.** The plan was reviewed by Codex Sol (advisory, two rounds, 26 + 3 findings) before building. Its changes:
- exclusions moved into the database query;
- results tied to their search conditions;
- a field is cleared when its customer changes;
- no tier-1 fallback;
- the timeout and Retry;
- stronger proof.

**Proof (2026-10-21, local preview against a disposable local Supabase stack, never live).** The stack had the production schema replayed (baseline plus 123 migrations) and was seeded with:
- 1,206 customers, including names with a comma, brackets, `%`, `_`, a quote and a backslash;
- 1,201 fields and 1,101 products;
- customers on tiers 2 and 3, and a product priced $10 / $9 / $8.

Results:
- **Past the old limit.** Every converted search box found a record past its old limit, e.g. "Seed Farm 1150", "Seed Farm 1199", "Seed Field 1199", "Zz 2,4-D Seed Amine".
- **Literal searches.** Each special-character search returned exactly its one farm; "100%" did not match "Seed Farm 1000".
- **New Order.** Opened with `?customer_id=` for Seed Farm 1150 (tier 2), with "Seed Product 1099" at $9.00 × 2. The saved order (ORD-2026-0001) stored that customer and $9.00 / $18.00.
- **Quote Builder.** Picking Seed Farm 1199 set Tier 3. Another customer's field was not offered, and switching customer cleared the field and set Tier 2.
- **Counts.** Compliance showed 1,201 fields (database 1,201). Job Detail offered all 1,206 customers.
- **Failure.** With the local API stopped, the New Order search showed "Customer search failed." and Retry found the customer once the API was back. A rejected query (found on the new-customer page, fixed) also showed the error.
- **Sales rep login.** The customer search worked, and the product catalog requests carried no cost columns.
