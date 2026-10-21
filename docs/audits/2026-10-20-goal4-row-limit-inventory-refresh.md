# Goal 4, step 1 refreshed: what still stops at a row limit (2026-10-20)

This refreshes `docs/audits/2026-10-15-goal4-row-limit-inventory.md` after Goal 4 part 1 (PRs #959, #970, #981). It keeps that audit's IDs (H = money or integrity/compliance, M = a missing record, L = low or by design), marks each one fixed or still open on `origin/main` at `875a36fe4`, and adds the places the first audit missed (N1–N13). The original audit is still the reference for each item's description; this page gives the current status and line numbers. Read-only: nothing was changed, and the live database was only read (SELECT).

## Summary for Mason

**Where things stand.** Part 1 fixed the main list pages, Reports and Sales Reports. Every place below still reads at most a set number of records, and at most 1,000 when no number is given, because the server stops every reply there. None of them warns on screen except where noted.

1. **18 of the 40 high-risk items are fixed, 22 are still open.** The open ones are:
   - **Field Invoices (H5–H7).** Its three panels still stop at 1,000, and "Post all" / "Unpost all" act only on the invoices loaded.
   - **AR, AP and prepay (H15, H16, H19, H20, H23, H24, H37, H38, H43, and new N1).** These include the AR aging totals, the finance-charge run (customers past the limit would never be charged), check allocation (only a customer's first 200 open invoices can be paid against), and the aging card on a customer's own page.
   - **Integrity checks (H25–H30) and compliance records (H32, H33, H42),** including the restricted-use register and the application logbooks.
   - **The dashboard action queue (H36),** whose counts top out at 10.
2. **One limit is already being hit today: Notifications.** Four staff accounts each have 1,000 to 1,400 unread notifications. The Notifications page shows only the newest 200, and the bell's unread badge counts only the 20 it loads (L9, L10-1). Nothing is lost, because older notifications are still in the database. But staff can't see them, and the unread counts are wrong. Every other table is still under its limit (largest business tables on 2026-10-20: 604 products, 400 delivery lines, 289 order lines, 154 customers).
3. **Pickers: none has become a search box yet**, apart from the product pickers PR #944 changed. About 60 dropdowns still load a fixed list (500, 1,000, or 200) and filter it on screen. The shared `SearchableSelect` box used on New Order, Quote Builder, Job Detail and Blend Ticket Detail looks like a search, but it only searches the records it already loaded.
4. **No new limits were added since 2026-10-15.** All new code reads every row. The 13 new items (N1–N13) were already there and were missed the first time.
5. **Server-side limits are unchanged.** The live database's functions still cap the call lists at 200, the dispatch board at 500, the dashboard queue at the number asked for (10), cost-basis purchase candidates at 20, and the dashboard top-N lists by design.

**Recommended next step:** build **part 2**, a screen-only fix with no database change that finishes the high-risk items the same way part 1 did (plan below).

## Status of the 2026-10-15 items

### HIGH: fixed (18)

H1, H2, H3, H4, H8, H9, H10, H11, H12, H13, H14, H18, H21, H22, H34, H39, H40, H41. Each now reads through `src/lib/pagedRead.ts`. The three that act on their rows now cover every eligible row: the commission payout picker (H3) and commission quick-pay (H12). Except for H34 and H41, which have no money total, their totals are still added up in the browser, from the complete set. Moving them into the database is item (d).

### HIGH: still open (22)

| ID | Where now (file:line) | Cap | Note |
|---|---|---|---|
| H5 | `components/field-invoices/FieldInvoicesListPanel.tsx:145` | asks 2,000, gets 1,000 (server) | The warning toast at `:155` can't fire |
| H6 | `components/field-invoices/FieldInvoicesPostedPanel.tsx:121` | 1,000 (server) | "Unpost all" (`:434`) acts only on loaded rows |
| H7 | `components/field-invoices/FieldInvoicesUnpostedPanel.tsx:117` | 1,000 (server), newest first | "Post all" (`:395`) skips the oldest drafts |
| H15 | `pages/AccountsReceivable.tsx:46`, `pages/ARaging.tsx:99` (`get_ar_aging`, one call) | 1,000 (server) | Smallest balances drop first |
| H16 | `pages/AccountsReceivable.tsx:52` | 1,000 (server) | Unused Prepay card |
| H19 | `pages/FieldProfitability.tsx:78` (`get_field_profitability`, one call) | 1,000 (server) | |
| H20 | `components/prepay/PrepaymentManagerPanel.tsx:129` | 500 customers | The apply runs in the database; the preview, totals and CSV are capped |
| H23 | `pages/CustomerDetail.tsx:713`, `:721` | 1,000 (server) | One customer's purchase history total |
| H24 | `components/invoices/FinanceChargePreviewModal.tsx:50` (`preview_finance_charges`) | 1,000 (server) | "Generate" charges only the previewed customers (`:110`) |
| H25 | `lib/reconciliation.ts:857` | 1,000 (server) | Integrity check 5; checks 1–4, 7 and 8 already read every row |
| H26 | `lib/reconciliation.ts:885`, `:889` | 1,000 each (server) | Check 6 |
| H27 | `lib/reconciliation.ts:1020` | 1,000 (server) | Check 9 |
| H28 | `lib/reconciliation.ts:1048` | 1,000 (server) | Check 10 |
| H29 | `components/integrity/IntegrityCleanupPanel.tsx:152` | 1,000 (server), newest first | Unbilled deliveries |
| H30 | `components/integrity/IntegrityCleanupPanel.tsx:144`, `:157`, `:165` | 1,000 each (server) | Negative stock, stock made at delivery, open alerts |
| H32 | `pages/Compliance.tsx:172` (`get_rup_sales_register`, one call) | 1,000 (server) | Restricted-use register |
| H33 | `components/reports/LogbookReport.tsx:88`, `:95`, `:102`, `:114` (four logbook functions) | 1,000 each (server) | |
| H36 | `components/dashboard/ActionQueue.tsx:194` (`get_dashboard_action_items`, `p_limit: 10`) | 10 per category | Needs the function to return a true count (a database change) |
| H37 | `pages/AccountsPayable.tsx:43` (`get_ap_aging`, one call) | 1,000 (server) | |
| H38 | `pages/AccountsReceivable.tsx:58` | 1,000 (server) | Open credit memos |
| H42 | `pages/Compliance.tsx:117` | 1,000 (server) | Expired and expiring license counts |
| H43 | `pages/PaymentAllocation.tsx:161` | 200 | A check can only be applied to a customer's first 200 open invoices |

### MED: fixed

M1–M4 (PR #944), M5–M10, M12–M16, M28, M35, M39, M41, M42, M46, M58, M63, M65; also the Application Records and Returns customer lists in M48, and the Sales Reports category list in M49. The Orders pick-list in M62 is fixed too; the Order Detail one (`pages/OrderDetail.tsx:444`) is still open.

### MED: still open, by kind

All silent unless noted. Line numbers are current.

**Main lists and list-like panels**
- M11 Dispatch board jobs: 500 (`pages/DispatchBoard.tsx:221`, and the function `get_dispatch_board_jobs`).
- M18 Receiving hub: 500 (`components/receiving/ReceivingHubPanel.tsx:120`).
- M19 Receiving log: 500, never asks for page 2 (`components/receiving/ReceivingLogPanel.tsx:92`).
- M21 Call lists: 200 each (the five `get_call_list_*` functions).
- M22 Fields list and the shared field map cache: 1,000 (`pages/Fields.tsx:73`, `lib/fieldsGeojsonCache.ts:30`).
- M25 Watchdog exceptions (`pages/WatchdogExceptions.tsx:93`).
- M55 Inventory active holds (`pages/InventoryPage.tsx:333`).
- M56 Label review queue (`pages/LabelReview.tsx:210`).
- M61 Unbilled work backlog: 500 jobs and 500 blend tickets, with a banner (`components/field-invoices/UnbilledApplicationsPanel.tsx:169`, `:177`).
- M66 My Route stops (`pages/FieldRoute.tsx:76`).

**Lookups feeding a page**
- M20 Office Cockpit tiles: 50 each (`pages/OfficeCockpit.tsx:552`, `:562`, `:587`, `:597`, `:611`, `:631`). "Post all clean" acts only on the 50 loaded.
- M26 Field Invoices split locations (`FieldInvoicesPostedPanel.tsx:146`, `FieldInvoicesUnpostedPanel.tsx:144`).
- M36 Order Detail field-split reads (`pages/OrderDetail.tsx:315`, `:316`).
- M52 Jobs billed-customer column (`pages/Jobs.tsx:573`).
- M54 Cockpit lapsed crop-program holds (`pages/OfficeCockpit.tsx:635`).
- M60 Product Detail category, vendor and manufacturer choices (`pages/ProductDetail.tsx:439`).
- M62 Order Detail pick-list stock (`pages/OrderDetail.tsx:444`).

**Pickers (dropdowns that load a list instead of searching)**
- M17 New Delivery open orders (`pages/NewDelivery.tsx:117`).
- M29 Invoice customer picker, which also feeds the PDF address and email: 500 (`pages/InvoiceDetail.tsx:324`; PDF and email lookups `:1352`, `:1443`).
- M30 New Order customers (`pages/NewOrder.tsx:212`).
- M31 Quote Builder customers, products and fields (`pages/QuoteBuilder.tsx:803`, `:804`, `:806`).
- M32 Job Detail customers, fields and products (`pages/JobDetail.tsx:1653`–`:1655`).
- M33, M34 Blend Ticket Detail products, customers and fields (`pages/BlendTicketDetail.tsx:219`–`:232`); linked job, 200 (`:242`).
- M37 Order Detail bill-split customer: 500 (`pages/OrderDetail.tsx:825`).
- M38 Split invoice editor fields, products, and jobs (200) (`pages/FieldAppSplitInvoiceEditor.tsx:286`, `:287`, `:297`).
- M40 Logbook customers 500, applicators 200, fields 500 (`components/reports/LogbookReport.tsx:59`, `:64`, `:68`).
- M43 Field Setup customers: 500 (`pages/FieldSetup.tsx:261`).
- M44 Parent customer: 500 (`pages/CustomerDetail.tsx:408`).
- M45 Bulk field import customer: 500 (`components/fields/BulkFieldImport.tsx:170`).
- M47 Vendor bill link-to-PO: 200 (`pages/NewVendorBill.tsx:123`).
- M48 customer lists still open:
  - `pages/ARaging.tsx:86`
  - `components/field-invoices/CustomerInvoiceSummaryPanel.tsx:73`
  - `pages/Compliance.tsx:151`
  - `pages/Jobs.tsx:331`
  - `pages/InventoryPage.tsx:430`
  - `components/prepay/PrepaymentManagerPanel.tsx:308`
  - `components/field-app/SelectLocationsModal.tsx:69`
  - `pages/ApplicationServiceDetail.tsx:79`
  - `components/quotes/BulkQuoteImport.tsx:442`
- M49 product lists still open:
  - `components/blendtickets/ManualTicketCreate.tsx:292`
  - `components/deliveries/QuickDeliveryModal.tsx:99`
  - `components/orders/BulkOrderImport.tsx:392`
  - `components/purchase-orders/BulkPOImport.tsx:205`
  - `components/quotes/BulkQuoteImport.tsx:443`
  - `components/receiving/QuickReceivePanel.tsx:150`
  - `pages/BlendRecipes.tsx:138`
  - `pages/BrandVsGeneric.tsx:54`
  - `pages/InventoryPage.tsx:415`
  - `pages/NewPurchaseOrder.tsx:87`
  - `pages/LabelDataQuality.tsx:384`, `:390`
- M50 field lists: `components/field-app/SelectLocationsModal.tsx:38`, `pages/Compliance.tsx:187` (total acres), `pages/Fields.tsx:84`.
- M51 Edge Function `process-blend-ticket` matches against products and customers (`supabase/functions/process-blend-ticket/index.ts:1072`, `:1077`).
- M53 Cost-basis purchase candidates: 20 (database function).
- M59 Prepay workspace customer (`components/prepay/PrepayWorkspacePanel.tsx:77`).

**Scoped to one record**
- M23 One product's stock ledger (`components/inventory/TransactionLedgerModal.tsx:131`).
- M24 New cycle count, one warehouse (`pages/CycleCounts.tsx:220`).
- M27 Customer "Recent Transactions": the 50 oldest (`pages/CustomerDetail.tsx:2006`).
- M57 One customer's statement: `pages/ARaging.tsx:147`, `:383`, `pages/CustomerDetail.tsx:652`. The second ARaging call is newly noted.
- M64 Customer interaction history: 50 (`components/customers/CustomerContacts.tsx:197`).

### LOW

Unchanged from 2026-10-15 except:
- **Vendors (L19-1) is fixed.**
- **Notifications (L9, L10-1) is now already over its limit.** It belongs with the list pages, not LOW (see Summary point 2).

The rest are short on purpose, already signalled, or scoped to one small record:
- L1 Customers (1,000, banner) and L2 Jobs (500, banner) are list pages for part 3.
- L3–L7, L11–L15, L18, L21 and L22 need no fix.
- L17 and L20 are per-record reads.

## New items (missed on 2026-10-15)

| ID | Where (file:line) | What | Cap | Money / check? |
|---|---|---|---|---|
| N1 | `pages/CustomerDetail.tsx:645` | The Financials tab reads the whole company's AR aging (`get_ar_aging`) and picks this customer out. A small-balance customer past row 1,000 shows no aging on their own page | 1,000 (server) | **Money** |
| N2 | `pages/NewOrder.tsx:213` | New Order product picker | 1,000 (server); 595 active products today | |
| N3 | `pages/OrderDetail.tsx:356` | Order edit product picker | 1,000 (server) | |
| N4 | `pages/Jobs.tsx:469` | Jobs list applicator filter reads dispatches unpaged; read errors are ignored | 1,000 (server) | |
| N5 | `pages/Jobs.tsx:490` | Jobs list customer filter reads field shares unpaged; read errors are ignored | 1,000 (server) | |
| N6 | `pages/CycleCounts.tsx:189` | New cycle count location choices read from the whole inventory table | 1,000 (server) | |
| N7 | `pages/DispatchBoard.tsx:460` | Field boundaries for the dispatch map (`get_fields_geojson_by_ids`) | 1,000 (server) | |
| N8 | `pages/FieldView.tsx:304` | Same function, one applicator's fields | 1,000 (server) | |
| N9 | `components/prepay/PrepayWorkspacePanel.tsx:96`, `:102` | One customer's prepay buckets and open invoices for the Apply step | 1,000 per customer | **Money** (unlikely to hit) |
| N10 | `pages/Returns.tsx:332` | "Pick an order" for a new return, one customer | 1,000 per customer | |
| N11 | `pages/JobDetail.tsx:1701` | License check reads the whole license table; licenses past the limit would read as missing | 1,000 (server); small table | Compliance |
| N12 | `pages/BrandVsGeneric.tsx:56` | Brand-to-generic mapping list | 1,000 (server) | |
| N13 | Per-record reads on Delivery Detail, Field Stop, Quote Builder, Invoice Detail, Order Detail and the Prepay manager (`PrepaymentManagerPanel.tsx:141`, part of H20) | One record's lines, photos, notes and similar | 1,000 per record | L20 class |

**Not a row limit, noted.** `pages/OrderDetail.tsx:327` sends every customer id from the M36 reads in one `.in()` list, which could make the request too long at volume. Migration `20261015130000` line 608 takes a `customer_application_rates` row with `LIMIT 1` and no `ORDER BY`, so the pick is arbitrary if two rates exist. Both are outside Goal 4.

The 2026-10-15 audit's other "Found along the way" items are not row limits, and this plan doesn't fix them. Each is still listed there:
- the likely broken over-received PO check, which belongs with the Part 2 integrity work if it is confirmed;
- the Prepay manager's unpaid total leaving out overdue invoices (fixed 2026-10-20 in both prepay screens: `docs/changelog.d/2026-10-20-prepay-overdue-invoices.md`);
- `reconcile_prepay_balances` skipping inactive customers;
- the blend-ticket quote price chosen with `LIMIT 1`, which belongs to Goal 3's blend-ticket pricing.

The 20-page document-scan limit is the exception: it is scheduled in Part 2.

## Plan for the rest of Goal 4

Plain-English terms: **paging** means asking for records one batch at a time until none are left, which is what part 1 did. **Server-side paging** means the screen asks the database for just one screenful at a time, plus a total count, instead of loading everything.

**Part 2 (next): finish the high-risk reads, screen-only, no database change.** Use the part 1 helper (`fetchAllRows`, with an exact count and a fixed sort order) on:
- Field Invoices H5–H7 and M26, so "Post all" and "Unpost all" reach every invoice;
- AR and prepay H15, H16, H20, H23, H38, H43, N1, N9, plus the report functions H19, H24 and H37 (paged like part 1's report functions);
- integrity checks H25–H30;
- compliance H32, H33 and H42, plus the logbook pickers M40;
- Notifications (L10-1), with the bell badge (L9) counting unread notifications in the database instead of the 20 it loads;
- the lookups and per-record reads that are simple full reads:
  - M23, M24, M36, M54, M57, M62, N4, N5, N7, N8, N10, N11 and L17;
  - from N13: `PrepaymentManagerPanel.tsx:141` (part of H20's money total) and `DeliveryDetail.tsx:601` (scheduled quantities);
  - M27 and M64, which must show the newest rows, not the oldest;
- the 20-page document-scan limit (`lib/documentOCR.ts:47`, applied at `:61`; the 2026-10-15 audit, "Found along the way").
  - It hits bulk customer, order, quote and PO imports from PDF.
  - Either read every page, or stop and tell the user plainly that pages after 20 were not imported. A Sentry warning alone isn't enough.
  - Proof: a test with a 21-page document, plus the message seen on screen.

Done when each reads past a 1,000-row fake in tests, and a live check with a 10-row page matches the database count, as in part 1. Size: likely two PRs (money and checks first, then the lookups). H36 (dashboard counts) needs the function to return a true count, so it moves to part 4.

**Part 3, item (b): pickers become search boxes.**
- Add a database search picker for each kind of record still chosen from a fixed list, beside the existing `ProductSearchPicker`. Each asks the database as you type and loads a saved choice by id:
  - customers;
  - fields;
  - orders (M17, open orders for a new delivery);
  - jobs (M34, M38);
  - purchase orders (M47).
- New cycle count locations (N6) come from a database query of distinct locations, not a picker.
- Proof for each kind: a search finds a record past the old cap.
- Swap them into the open pickers, invoice customer (M29) first, since it feeds the PDF address and email. That covers M17, M29–M34, M37, M38, M43–M45, M47, the picker entries in M48, M49 and M50, M59, N2, N3 and N6.
- Screens that use the whole list are not pickers, and a search box would leave them capped. They keep a full paged read (`fetchAllRows`) or move into a database report instead:
  - Label Data Quality (M49, coverage and batch checks);
  - Brand vs Generic (M49 and N12, the mapping viewer);
  - the Compliance acre total (M50);
  - Product Detail's choice lists (M60), which should come from a database query of distinct values.
- Bulk imports (in M48 and M49) should match names in the database.
- The blend-ticket scanner (M51) is an Edge Function. Changing it needs a deploy, which needs Mason's OK at that time.

Done when a search finds a record past the old limit on every picker. Probably two PRs.

**Part 4, item (c): real server-side paging for the big lists.**
- Customers, Jobs, Invoices, Orders, Deliveries, Quotes, Notifications, Dispatch Board, Receiving, Call Lists, Fields and Watchdog get one screenful at a time with a database search and an exact total.
- How "next page" works must be designed before building, because the Goal 4 test requires no missed or repeated rows while records are added and edited. A fixed sort (date plus id) is not enough on its own:
  - counting rows to skip ("offset") shifts when a row is added or deleted;
  - continuing after the last row seen ("keyset") can skip a row whose date is edited to fall behind that point.
- The design must say how each case is handled. For example:
  - page on a value that never changes once set (creation time plus id);
  - re-check the exact total and reload when it moves, as part 1 does;
  - tell the user the list changed instead of showing a silently wrong page.
- This replaces part 1's "load everything" approach before history grows, and removes part 1's per-page counting cost (KNOWN_ISSUES "Deferred").
- It likely needs new database search functions, which are non-destructive migrations, and the dashboard queue count (H36).
- **Totals and exports come first.** Once a screen loads one page, its totals and exports would cover only that page. So a list is switched to one-screenful paging only in the same change that does both of these:
  - its money totals and counts come from the database, which brings item (d) forward for that page;
  - its CSV and PDF exports read the full filtered result.

  This applies, for example, to Invoices (Posted and Outstanding cards, CSV and PDF) and Deliveries (exports). Every action that works on "all" rows selects its targets in the database.
- Also in part 4:
  - the Office Cockpit tiles (M20), including "Post all clean", which acts on every eligible draft;
  - the Jobs billed-customer column (M52), read per page;
  - cost-basis purchase candidates (M53): `get_product_cost_basis_workspace` returns only the newest 20, and the price-history screen can choose only from those. It needs a database search or paging of candidates (a function change), not the generic picker;
  - the remaining list-like screens: M11, M18, M19, M21, M22, M25, M55, M56, M61 and M66, Customers (L1), Jobs (L2), and Team Board notes (L10-3).

**Then (d) and (e)** as the plan says: database money totals for the remaining screens (part 1's fixed pages still add up in the browser from the full set), then the workload test.

**Deliberately not scheduled.** These stay as they are, with the reason:
- The per-record reads in N13, L20 and L19 (one record's lines, photos and notes, or small reference lists). Each holds tens of rows today.
  - Two N13 reads are not deferred and are fixed in Part 2: `PrepaymentManagerPanel.tsx:141` feeds H20's unpaid-invoice money total, and `DeliveryDetail.tsx:601` feeds the "already scheduled elsewhere" quantities.
- The staff and setup tables in L22.
- The by-design LOW items (L3–L7, L11–L15, L18, L21).

Proof required to keep these deferred: the live table-size check in this audit (`pg_stat_user_tables`), re-run at each part's live check. Any table behind these items that reaches 500 rows is pulled into the next part.
