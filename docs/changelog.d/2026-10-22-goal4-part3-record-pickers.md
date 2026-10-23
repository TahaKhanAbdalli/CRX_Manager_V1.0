## 2026-10-22 - Order, job and purchase-order pickers search the database (Goal 4, part 3, second PR)

The order, job and purchase-order pickers no longer stop at 200 or 1,000 rows. Frontend only, no migration.

**New search boxes**, built on `RecordSearchPicker` beside the customer, field and product ones:
- `OrderSearchPicker` (order number or customer name), `JobSearchPicker` (job number or customer name), `PurchaseOrderSearchPicker` (PO number or vendor).
- Each keeps its old list's status filter in the database query. Deleted orders and jobs are never offered.
- PostgREST cannot search across a join, so a customer-name search first finds up to 50 matching customers (`src/lib/customerNameSearch.ts`), then matches their orders or jobs. A broader name reaches the rest by typing more or by the record's number. A picker limited to one customer matches only that customer's name.
- Labels live in `src/lib/recordLabels.ts`, so a record read by id is labelled the same way as a pick.

**Now database searches** (old limit in brackets):
- New Delivery order (1,000; M17). A `?order=` link reads its order by id. An order that is not confirmed or partially fulfilled, is deleted, belongs to another customer, or fails to load shows why and blocks Schedule Delivery; a failed load has a Retry. Saving uses only that by-id read, and a late reply for an earlier pick is ignored.
- Blend Ticket Detail linked job (200; M34). Only the ticket's customer's jobs are offered: the save already refused another customer's job (`BLEND_JOB_CUSTOMER_MISMATCH`), which the old list still offered. Changing the customer unlinks the job and says so. The linked job's name comes from the ticket's own read.
- Split billing source job (200; M38), completed jobs only. A reopened draft reads its saved job's name by id; the saved id is sent unchanged whatever that read returns.
- New Vendor Bill link-to-PO (200; M47). An admin's results carry the PO total, and a failed cost read fails the search, so no PO is picked without its total. Picking still fills vendor and amount. A bill recovered from an unconfirmed save reads its PO's name by id.

**Now complete paged reads** (`fetchAllRows`):
- New Purchase Order product catalog (1,000; M49). A failed read clears the list, shows Retry, and blocks Save and Submit until the catalog loads; the draft on screen is kept.
- Cycle count locations (1,000; N6): the inventory locations are read whole, page by page, with no database change. A failed read clears the list, says so, and blocks Start Count.

**Still open, for later PRs:**
- Invoice Detail customer (M29) and Bulk PO Import products (M49): open PRs #1018 and #1021 edit those files.
- Label Data Quality, Product Detail choice lists (M60), bulk import name matching (M48/M49), Field Customer Assignment's dropdown, and the blend-ticket scanner (M51, needs an Edge Function deploy).
- A customer-name search looks through the first 50 matching customers (alphabetical) and does not say when more match; the record number always works.
- Cycle count locations still read every inventory row; a distinct-locations database query would be faster at very large sizes (part 4).

**Proof (2026-10-22, local preview against a disposable local Supabase stack, never live).** The stack had the production schema replayed, with 1,101 confirmed orders, 250 completed jobs, 250 submitted POs, 1,101 products and 1,100 inventory rows. The old one-request reads were run against it first, to pick records they missed.
- New Delivery: SEED-ORD-0003, which the old 1,000-row read left out, was found by number; SEED-ORD-1100 was found by customer name. A `?order=` link to a fulfilled order said "is fulfilled and cannot get a new delivery" and kept Schedule Delivery disabled.
- Blend Ticket: with the customer set to Seed Farm 0250, SEED-JOB-0001 (another customer's) was not offered and SEED-JOB-0250 (outside the old 200) was. Saving stored it, and a reload showed "SEED-JOB-0250 (2026-02-13) - Seed Farm 0250".
- Split billing: SEED-JOB-0249 (outside the old 200) was found by its customer's name and picked.
- New Vendor Bill: SEED-PO-0250 (outside the old 200) showed its $1,234.56 total; picking it filled vendor "Seed Vendor" and subtotal 1234.56.
- New Purchase Order: "Seed Product 1099" (past the old 1,000) was in the product picker.
- Cycle counts: "Zz Far Shed", missing from the old 1,000-row read, was offered.
- Failure: with the order-by-id request failing, New Delivery said "The order could not be loaded.", kept Schedule Delivery disabled, and its Retry loaded the order once the request worked.
- Failure: with the local API stopped, the order search showed "Order search failed." with Retry after the 15-second timeout. Retry found SEED-ORD-0003 once the API was back.
