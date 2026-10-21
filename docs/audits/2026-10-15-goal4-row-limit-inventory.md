# Goal 4, step 1: every place that stops at a row limit (2026-10-15)

This is the first step of Goal 4 in `docs/plans/2026-10-13-direction-and-goals.md`, "Complete, correct numbers at any volume." The step is to list every list, picker, report, export and integrity check that stops at a row limit before fixing any of them. Nothing was changed. The live database was only read (SELECT).

Code baseline: `origin/main` at `9b6eb8607`. Line numbers were rechecked against `origin/main` at `a07062cb2`, and the cited lines in the five app files that changed in between (Reports, Sales Reports, Crop Programs, Team Board, Delivery Detail) were updated to match.

## Summary for Mason

**What a "row limit" is.** When a screen asks the database for records, it often says "give me at most 500." The Supabase Data API, the layer the app uses to read the database, also caps every response at 1,000 rows. That is Supabase's default, and it was confirmed in the dashboard on 2026-10-16 (see "Max rows, confirmed" below). Once the business has more records than that, the extra ones are quietly left off. Nearly every screen below gives **no warning** when that happens.

**What it means for you:**

1. **Money totals will be wrong at volume, with no warning.** **28 places** add up money from a list that gets cut off, so their totals would come out too low. Examples: Payment History's "Active Payments" card (stops at 200 payments), Commission Payments (200), the Invoices and Field Invoices totals, the To Ship dollar value, every profitability tab on Reports, Sales Reports, AR and AP Aging, and the Unused Prepay and Open Credit cards. Today the business is small, so **none of these totals is wrong yet**. Live row estimates (`pg_stat_user_tables`, 2026-10-15) put every table behind them under 150 rows, except order lines (about 289), delivery lines (about 400) and products (604, counted exactly; this is what the Inventory Cost report lists). Each is below the smallest cap that applies to it. These are whole-table counts, so a filtered screen reads at most that many rows. The totals start going wrong as soon as a season's volume passes the cut-off.
2. **Some integrity checks would miss problems.** **Nine checks** read only part of the data: four on the Integrity Report (commission splits, quote holds, returns, customer balances), four on the Integrity cleanup panel (unbilled deliveries, open alerts, negative stock, stock made at delivery), and the dashboard action queue. A clean result could just mean the check never looked at the problem rows.
3. **One problem was already happening, and it is now fixed.** There are **595 active products**, but four product lists loaded only the first 500, so about 95 products were missing. PR #944 (merged 2026-10-15) fixed all four (M1–M4):
   - the product filters on Reports and Sales Reports, and Crop Programs, now search as you type;
   - the Price List now reads every product.
4. **Pickers and lists without a database search will lose records** (customers, products, fields, orders, deliveries) at 20, 50, 200, 500 or 1,000. The search-as-you-type pickers in L15 are the exception: they can find any record. There are **62 such open findings**, plus the 4 already fixed (M1–M4). Most are dropdowns that load the first N records instead of searching.
5. **Compliance records can be incomplete.** These would silently drop records past the server ceiling of 1,000, or past 500 where noted:
   - the restricted-use pesticide sales register;
   - the application logbooks (including FAA);
   - the Application Records export and the Posted Applications report (both stop at 500);
   - the applicator license register's "expired" and "expiring" counts.

**What isn't a problem.** The places listed in "Already correct" below read every row properly. Several dashboard "top 10" lists are short on purpose. These were all checked and need no fix.

**Max rows, confirmed (2026-10-16).** The database's per-request ceiling ("Max rows") is set in the Supabase dashboard and can't be read from the database itself. Mason signed in to the dashboard, and Claude read the setting on the Data API settings page. It is **1,000**, the default, and nothing was changed. So six reads that set their own limit at 2,000 or 5,000 are really capped at 1,000: Invoices, the three Field Invoices panels, and To Ship's orders and order lines. On the Invoices and Field Invoices screens, the "some may be hidden" warning can never appear. If anyone raises Max rows later, every "1,000 (server)" finding below moves to the new number, and this audit should be updated.

**Recommended next step:** fix the money totals first by computing them in the database (the fix order is at the end).

## How to read the table

- **Signal:** "Silent" means nothing on screen says records are missing. "Toast" means a pop-up that disappears. "Banner" means a message that stays on the page.
- **Severity:** **HIGH** means a wrong money total, or an integrity or compliance check that can miss a problem. **MED** means a record missing from a picker or list. **LOW** is cosmetic, or a short list that is short on purpose.
- **Cap "1,000 (server)"** means the code asks for everything, but the database ceiling cuts it at 1,000 (the confirmed Max rows setting, see above).
- **RPC** means a database function the screen calls. A function that returns a list of rows is cut at 1,000 too. Function names marked *(live)* were confirmed to return rows, or to contain the stated LIMIT, in the live database on 2026-10-15 (`pg_proc` / `pg_get_function_result`, SELECT only).
- **Found by:** "C" means Claude's sweep, "X" means Codex (`gpt-6-luna`, xhigh) in its independent hunt, and "C+X" means both found it. Claude checked every "X" finding at its file:line before adding it. The picker and LOW tables have no column; their Codex-only rows are marked "found by Codex."
- All paths are under `src/` unless they start with `supabase/`.

## Findings: HIGH

### Money totals summed from a cut-off list

| ID | Where (file:line) | What the user sees | Cap | Signal | Money affected | Found by |
|---|---|---|---|---|---|---|
| H1 | `pages/PaymentHistory.tsx:79` | Payment History list, "Active Payments" card (total `:173`, shown `:286`), and its CSV export (`:257`) | 200 newest | Silent | Yes: total collected and the count of active and voided payments | C+X |
| H2 | `pages/CommissionPayments.tsx:168` | Commission Payments list, "Unposted" and "Posted Total" cards (`:691`, `:694`) | 200 newest | Silent | Yes | C+X |
| H3 | `pages/CommissionPayments.tsx:251` | "Create payment" picker of pending commissions. Newest first, so the **oldest** unpaid commissions drop off | 500 | Silent | Yes: selected total (`:348`), per-rep unpaid count | C+X |
| H4 | `pages/Invoices.tsx:146` | Chemical Sales invoice list, "Posted" and "Outstanding" cards (`:212`, `:213`), CSV export | 2,000 asked; really 1,000 (server) | Toast at `:155`, which can't fire if the server cap is 1,000 | Yes | C+X |
| H5 | `components/field-invoices/FieldInvoicesListPanel.tsx:144` | Field Invoices "All" list, Posted Total and Outstanding cards, PDF and CSV export | 2,000 asked; really 1,000 (server) | Toast at `:153` (same problem) | Yes | C+X |
| H6 | `components/field-invoices/FieldInvoicesPostedPanel.tsx:120` | Posted field invoices: footer totals, month batches, PDF, "Unpost all" | 2,000 asked; really 1,000 (server) | Toast at `:129` (same problem) | Yes | C+X |
| H7 | `components/field-invoices/FieldInvoicesUnpostedPanel.tsx:116` | Unposted field invoices: footer totals, PDF, "Post all". Newest first, so the oldest drafts drop off and "Post all" skips them | 2,000 asked; really 1,000 (server) | Toast at `:125` (same problem) | Yes | C+X |
| H8 | `pages/ToShip.tsx:133` (orders), `:156` (lines) | To Ship board: total value still to ship (`:277`) and value by group | 2,000 orders and 5,000 lines asked; really 1,000 each (server) | Silent | Yes | C+X |
| H9 | `pages/Reports.tsx:243` | Reports, Customer Profitability tab | 1,000 (server) | Silent | Yes: revenue, profit and margin per customer | C+X |
| H10 | `pages/Reports.tsx:271` | Reports, Product Profitability tab (all order lines in range) | 1,000 (server) | Silent | Yes | C+X |
| H11 | `pages/Reports.tsx:321` | Reports, Revenue by month | 1,000 (server) | Silent | Yes | C+X |
| H12 | `pages/Reports.tsx:304` | Reports, Commissions tab: unpaid total (`:1140`) and quick-pay selection | 1,000 (server) | Silent | Yes | C+X |
| H13 | `pages/SalesReports.tsx:169`, RPC `get_sales_detail_report` *(live)* | Sales Reports, Detail tab (one row per order line): revenue, profit and quantity totals (`:192`), CSV and PDF | 1,000 (server) | Silent. The PDF footer prints the capped count as if complete | Yes | C+X |
| H14 | `pages/SalesReports.tsx:177`, RPC `get_sales_summary_report` *(live)* | Sales Reports summary tabs (by customer, product, month or rep): totals (`:199`) | 1,000 groups (server) | Silent | Yes, once there are more than 1,000 customers or products | C+X |
| H15 | `pages/AccountsReceivable.tsx:46`, RPC `get_ar_aging` *(live)*; also `pages/ARaging.tsx:99` | AR hub "Total Owed" and the AR Aging grid. Sorted by balance, so the smallest balances drop first | 1,000 customers with a balance (server) | Silent | Yes | C+X |
| H16 | `pages/AccountsReceivable.tsx:52` | AR hub "Unused Prepay" card and Net Position. Reads every prepay row, including zero-balance ones | 1,000 (server) | Silent | Yes | C+X |
| H18 | `pages/Reports.tsx:450`, RPC `get_inventory_cost_report` *(live)* | Reports, Inventory Cost total (`:1422`). The function returns one row per product | 1,000 products (server) | Silent | Yes (604 products today, so not hit yet) | C+X |
| H19 | `pages/FieldProfitability.tsx:78`, RPC `get_field_profitability` *(live)* | Field Profitability totals (`:115`) | 1,000 field-seasons (server) | Silent | Yes | C+X |
| H20 | `components/prepay/PrepaymentManagerPanel.tsx:128` | Prepay manager: "Total Prepay Credits" and "Total Unpaid Invoices" cards, Apply-All preview, CSV. The apply itself runs in the database and isn't capped | 500 customers with prepay | Silent | Yes: the preview totals | C+X |
| H21 | `pages/PurchaseOrders.tsx:97` | Purchase Orders, Outstanding Items: total value on order (`:184`) | 1,000 lines (server) | Silent | Yes (money owed to suppliers) | C+X |
| H22 | `pages/Rebates.tsx:170` | Rebates, Claims tab: pending and paid totals (`:424`) | 1,000 (server) | Silent | Yes | C+X |
| H23 | `pages/CustomerDetail.tsx:695` (orders), `:703` (lines) | Customer, Purchase History tab: "total spent" (`:2087`) | 1,000 lines for one customer (server) | Silent | Yes, only for a very large customer over several years | C |
| H24 | `components/invoices/FinanceChargePreviewModal.tsx:50`, RPC `preview_finance_charges` *(live)* | Finance charge preview. Every row is pre-selected, so customers past the cap are never charged | 1,000 overdue customers (server) | Silent | Yes (unlikely at CRX's size) | C+X |
| H37 | `pages/AccountsPayable.tsx:43`, RPC `get_ap_aging` *(live)* | AP aging grid and its totals (`:63`) | 1,000 vendors (server) | Silent | Yes (unlikely: needs more than 1,000 vendors with a balance) | X |
| H38 | `pages/AccountsReceivable.tsx:58` | AR hub "Open Credit" in Net Position: posted credit memos with unapplied balance (sum `:66`) | 1,000 (server) | Silent | Yes | X |
| H39 | `pages/Reports.tsx:361`, RPC `get_gross_sales_report` *(live)* | Reports, Gross Sales table and CSV (`:915`); each row is a money total for one group | 1,000 groups (server) | Silent | Yes: groups past the cap are missing | X |
| H40 | `pages/CustomerTransactionReview.tsx:43`, RPC `get_customer_transaction_review` *(live)* | Customer Transaction Review: total debits, credits and ending balance (`:63` to `:65`), CSV and PDF | 1,000 rows for one customer and date range (server) | Silent. The ending balance is taken from the last row returned | Yes, only for a long range on a very active customer | X |
| H43 | `pages/PaymentAllocation.tsx:161` | Allocating a check: one customer's open invoices, oldest first. Invoices past 200 can't be paid against, and the "outstanding" sum (`:536`) is low (was L16; raised after the Codex review) | 200 | Silent | Yes, only for a customer with more than 200 open invoices | C+X |

### Integrity and compliance checks that read only part of the data

| ID | Where (file:line) | What the check is | Cap | Signal | Effect | Found by |
|---|---|---|---|---|---|---|
| H25 | `lib/reconciliation.ts:876` | Integrity Report check 5, "Commission Splits." Commissions are read in no fixed order | 1,000 (server) | Silent: "entities checked" looks normal | Partial groups can report false "split isn't 100%" results, or hide real ones | C+X |
| H26 | `lib/reconciliation.ts:905` (quotes), `:909` (holds) | Check 6, "Quote-Hold Parity." Holds include inactive ones, so the table grows fast | 1,000 each (server) | Silent | False "missing hold" results, and skipped quotes | C+X |
| H27 | `lib/reconciliation.ts:1040` | Check 9, "Return-Credit Linkage" | 1,000 (server) | Silent | Credited returns past the cap are never checked | C+X |
| H28 | `lib/reconciliation.ts:1068` | Check 10, "Customer AR Consistency." Reads every invoice in no fixed order | 1,000 (server) | Silent | With 5,000 invoices, only an arbitrary 1,000 are checked | C+X |
| H29 | `components/integrity/IntegrityCleanupPanel.tsx:154` | Integrity cleanup, "Unbilled deliveries." Newest 1,000 completed deliveries only | 1,000 (server) | Silent | Older unbilled deliveries (lost revenue) never appear | C+X |
| H30 | `components/integrity/IntegrityCleanupPanel.tsx:167`; also `:146` (negative stock) and `:160` (stock made at delivery) | Integrity cleanup, open sentinel alerts and two stock checks | 1,000 (server) | Silent | Open alerts past 1,000 are hidden. The two stock checks only fail at an unusual volume of bad rows | C+X |
| H32 | `pages/Compliance.tsx:172`, RPC `get_rup_sales_register` *(live)* | Restricted-use pesticide sales register: list, compliant/warning counts (`:737` onward), CSV | 1,000 (server) | Silent | A regulatory record silently missing sales | C+X |
| H33 | `components/reports/LogbookReport.tsx:88`, `:95`, `:102`, `:114`; RPCs `get_logbook_by_customer`, `get_logbook_by_applicator`, `get_logbook_by_field`, `get_logbook_faa` *(live)* | Application logbook and FAA logbook, plus their exports | 1,000 (server) | Silent | A regulatory record missing applications. FAA over a season is most at risk | C+X |
| H34 | `pages/ApplicationRecords.tsx:86` | Application Records list and its CSV export (`:158`) | 500 newest | Silent | The compliance export is missing older records | C+X |
| H36 | `components/dashboard/ActionQueue.tsx:194`; RPC `get_dashboard_action_items` *(live)*, latest at `supabase/migrations/20261007150000_record_deliveries_billed_outside_crx.sql:281` | Dashboard action queue. Each category's "(N)" count (`:281`) tops out at 10, including unbilled deliveries and cancelled-but-posted invoices | 10 per category | Silent for the count. "+N more" covers only the 5 shown out of the 10 loaded | Billing problems past the 10th never appear, and the badge reads "(10)" | C+X |
| H41 | `pages/Reports.tsx:530` | Reports, Posted Applications report (applications already invoiced) | 500 newest | Silent | A compliance report missing older applications | X |
| H42 | `pages/Compliance.tsx:120` | Applicator license register: the expired and expiring counts (`:241`, `:242`) | 1,000 (server). Sorted by expiry, so the licenses expiring last drop off | Silent | Expiring licenses past the cap are never flagged | X |

## Findings: MED (a record missing from a picker or list)

### Were happening (595 active products, more than 500): FIXED by PR #944

These four were live when the audit started (`9b6eb8607`). PR #944 (`a07062cb2`) fixed them on 2026-10-15. They stay here as a record. The lines below are from the original baseline.

| ID | Where (file:line at `9b6eb8607`) | Picker | Cap | Now | Found by |
|---|---|---|---|---|---|
| M1 | `pages/Reports.tsx:233` | Chemical History product filter | 500 | FIXED: `ProductSearchPicker` searches as you type (`Reports.tsx:1214`) | C+X |
| M2 | `pages/SalesReports.tsx:114` | Sales Reports product filter | 500 | FIXED: `ProductSearchPicker` (`SalesReports.tsx:451`) | C+X |
| M3 | `pages/CropPrograms.tsx:121` | Crop Programs product select | 500 | FIXED: `ProductSearchPicker` (`CropPrograms.tsx:487`) | C+X |
| M4 | `pages/Reports.tsx:461` | Price List report and its CSV | 500 | FIXED: reads every product with `fetchAllRows` (`Reports.tsx:470`) | C+X |

### Lists that drop records

| ID | Where (file:line) | List | Cap | Signal | Found by |
|---|---|---|---|---|---|
| M5 | `pages/Orders.tsx:86` | Orders list (current season) | 500 | Toast at `:95` | C+X |
| M6 | `pages/Orders.tsx:111` | Order fulfillment % and product search over up to 500 orders' lines | 1,000 (server) | Silent | C |
| M7 | `pages/Quotes.tsx:266` | Quotes and bookings list (all seasons) | 500 newest | Silent | C+X |
| M8 | `pages/Quotes.tsx:285` | Product-name search on the Quotes list | 1,000 lines (server) | Silent | C |
| M9 | `pages/Deliveries.tsx:264` | Deliveries list. Newest scheduled first, so old open deliveries drop off | 500 | Silent | C+X |
| M10 | `pages/Deliveries.tsx:308`, `:367` | Delivery item counts and stock-shortage badges | 1,000 lines (server) | Silent | C+X |
| M11 | `pages/DispatchBoard.tsx:220`; RPC `get_dispatch_board_jobs` *(live)*, `supabase/migrations/20261013220000_reps_work_any_customer.sql:3553` | Dispatch board jobs | 500 newest | Silent | C+X |
| M12 | `pages/BlendTickets.tsx:79` | Blend ticket list | 500 | Silent | C+X |
| M13 | `pages/PurchaseOrders.tsx:83` | PO list. Status counts come from the loaded rows, so old open POs drop | 500 | Silent | C+X |
| M14 | `pages/DeliveryRemainders.tsx:62` | Delivery remainders. All statuses load newest first, then "pending" is filtered on screen (`:88`), so old pending remainders (product owed to a customer) disappear | 500 | Silent | C+X |
| M15 | `pages/VendorBills.tsx:40` | Vendor bills list and unpaid/overdue count cards | 1,000 (server) | Silent | C+X |
| M16 | `pages/Returns.tsx:196` | Returns list | 1,000 (server) | Silent | C+X |
| M17 | `pages/NewDelivery.tsx:117` | Open-order picker for a new delivery | 1,000 (server) | Silent | C+X |
| M18 | `components/receiving/ReceivingHubPanel.tsx:120` | Open-PO receiving board (quantities on order) | 500 POs | Silent | C+X |
| M19 | `components/receiving/ReceivingLogPanel.tsx:94`; RPC `get_receiving_log` *(live)* | Receiving log, vendor filter, CSV and PDF. The function supports paging, but the panel never asks for page 2 | 500 | Silent | C+X |
| M20 | `pages/OfficeCockpit.tsx:552`, `:562`, `:597`, `:611`, `:631` (`TILE_LIMIT = 50` at `:319`) | Office Cockpit tiles: jobs not invoiced, postable drafts ("Post all clean" acts only on the 50 loaded), upcoming jobs in the next 7 days (its "+N more" counts only the 50 loaded), expiring licenses, overdue AR, needs dispatch. The tile count tops out at 50 | 50 | Silent | C+X |
| M21 | `pages/CallLists.tsx:201` to `:235`; five `get_call_list_*` RPCs *(live)*, `supabase/migrations/20260716214423_crm_call_lists.sql:96`, `:183`, `:273`, `:407`, `:481` | Sales call lists. "Showing X of Y" (`:722`) uses the capped Y | 200 each | Silent | C+X |
| M22 | `pages/Fields.tsx:73`, `lib/fieldsGeojsonCache.ts:30`; RPC `get_fields_with_geojson` *(live)* | Fields list and every map that uses the shared field cache | 1,000 (server) | Silent | C+X |
| M23 | `components/inventory/TransactionLedgerModal.tsx:131` | One product's stock ledger, oldest first, so the newest movements drop off. The count is wrong too | 1,000 (server) | Silent | C+X |
| M24 | `pages/CycleCounts.tsx:219` | New cycle count leaves out inventory rows past 1,000 in one warehouse | 1,000 (server) | Silent | C+X |
| M25 | `pages/WatchdogExceptions.tsx:93`; RPC `get_watchdog_flags` *(live)* | Watchdog exception list and counts (worst when dismissed flags are included) | 1,000 (server) | Silent | C+X |
| M26 | `components/field-invoices/FieldInvoicesPostedPanel.tsx:146`, `FieldInvoicesUnpostedPanel.tsx:144` | Locations, crops and acres for split field invoices (also on the PDF) | 1,000 (server) | Silent: the fields are blank | C |
| M27 | `pages/CustomerDetail.tsx:1988` | "Recent Transactions, last 90 days" shows the first 50 rows. The statement is sorted oldest first, so this shows the 50 **oldest**, and the last balance shown isn't current | 50 | Silent | C+X |
| M28 | `pages/Orders.tsx:282`, `:339` | Bulk order-summary PDF and pick-list PDF drop lines when many orders are selected | 1,000 lines (server) | Silent | C |
| M54 | `pages/OfficeCockpit.tsx:635` | Office Cockpit lapsed crop-program holds still reserving stock | 1,000 (server) | Silent | X |
| M55 | `pages/InventoryPage.tsx:322` | Inventory page, active holds list | 1,000 (server) | Silent | X |
| M56 | `pages/LabelReview.tsx:211` | Label review queue (product label drafts) | 1,000 (server) | Silent | X |
| M57 | `pages/ARaging.tsx:147`, `pages/CustomerDetail.tsx:634`; RPC `get_customer_statement` *(live)* | One customer's statement for a date range (the running balance comes from the rows returned) | 1,000 rows (server) | Silent | X |
| M58 | `pages/Reports.tsx:440`, RPC `get_chemical_history` *(live)* | Chemical History report and CSV for one product | 1,000 rows (server) | Silent | X |
| M61 | `components/field-invoices/UnbilledApplicationsPanel.tsx:169` (jobs), `:177` (blend tickets) | Unbilled work backlog. The count cards show 500 with no "+" (was H31; moved after the Codex review) | 500 each | Banner at `:448` ("Showing the first 500 — open “View all” for the full list") while 500 are returned | C |
| M62 | `pages/Orders.tsx:342`, `pages/OrderDetail.tsx:410` | Pick-list PDFs read the whole inventory table to show stock available and short. Rows past the cap read as no stock | 1,000 inventory rows (server) | Silent | C+X |
| M63 | `pages/Reports.tsx:372`, RPC `get_customer_balance_listing` *(live)* | Reports, Customer Balance listing and its CSV (`:924`). The screen shows each customer's balance but sums no total (was H17; moved after the Codex review) | 1,000 customers (server) | Silent | C+X |
| M64 | `components/customers/CustomerContacts.tsx:197` | Customer interaction history. The type and outcome filters run over the 50 loaded, so "No interactions match" can appear when older matches exist (was L8) | 50 newest | Silent | C+X |
| M65 | `pages/ToShip.tsx:116` (deliveries), `:125` (purchase orders) | To Ship page, Deliveries and Inbound tabs: scheduled or in-progress deliveries, and open POs, soonest first (added after the PR's GitHub Codex review) | 500 each | Silent | C+X |
| M66 | `pages/FieldRoute.tsx:76` | My Route: every open delivery stop (a driver sees their own; admins and reps see all), shown as if complete (added after the PR's second GitHub Codex review) | 1,000 (server) | Silent | C+X |

### Pickers (dropdowns) that can't reach every record

None of these has a server search behind it, and every one is silent.

| ID | Where (file:line) | Picker | Cap |
|---|---|---|---|
| M29 | `pages/InvoiceDetail.tsx:323` | Invoice customer picker. It is also where the PDF and Email look up the customer's address and email (`:1408`), so a customer outside the 500 gets a PDF with no address and "no email on file" | 500 |
| M30 | `pages/NewOrder.tsx:177` | New order customer picker (includes inactive customers) | 1,000 (server) |
| M31 | `pages/QuoteBuilder.tsx:796`, `:797`, `:799` | Quote builder customer, product and field pickers | 1,000 (server) |
| M32 | `pages/JobDetail.tsx:1647`, `:1648`, `:1649` | Job customer, field (all fields) and product pickers | 1,000 (server) |
| M33 | `pages/BlendTicketDetail.tsx:218`, `:223`, `:228` | Blend ticket product, customer and field pickers | 1,000 (server) |
| M34 | `pages/BlendTicketDetail.tsx:240` | "Linked job" select: the newest 200 jobs across all customers | 200 |
| M35 | `pages/BlendTickets.tsx:85` | Customer picker for bulk upload and manual ticket create | 500 |
| M36 | `pages/OrderDetail.tsx:290`, `:291` | Field-split preview: the fields list and the whole field-billing-defaults table, so owners and split % can show wrong | 1,000 (server) |
| M37 | `pages/OrderDetail.tsx:791` | Bill-split share customer select | 500 |
| M38 | `pages/FieldAppSplitInvoiceEditor.tsx:286`, `:287`, `:297` | Split invoice field, product and job pickers. An existing line whose product is past the cap shows blank | 1,000, 1,000, 200 |
| M39 | `pages/Reports.tsx:586`, `pages/SalesReports.tsx:117` | Year-end single-customer select; Sales Reports customer filter | 1,000 |
| M40 | `components/reports/LogbookReport.tsx:59`, `:64`, `:68` | Logbook customer, applicator and field pickers | 500, 200, 500 |
| M41 | `pages/CustomerTransactionReview.tsx:37` | Customer select (and the name label for a deep link) | 500 |
| M42 | `pages/Deliveries.tsx:237` | Deliveries customer filter | 500 |
| M43 | `pages/FieldSetup.tsx:261` | Field setup customer pickers | 500 |
| M44 | `pages/CustomerDetail.tsx:405` | Parent-customer picker | 500 |
| M45 | `components/fields/BulkFieldImport.tsx:170` | Customer for imported fields | 500 |
| M46 | `pages/Rebates.tsx:128`, `:129`, `:130` | Rebate claim product, customer and order selects | 1,000, 1,000, 200 |
| M47 | `pages/NewVendorBill.tsx:121` | Link-to-PO select | 200 |
| M48 | Customer lists with no limit (1,000, server): `pages/ARaging.tsx:87`, `components/field-invoices/CustomerInvoiceSummaryPanel.tsx:74`, `pages/Compliance.tsx:151`, `pages/Jobs.tsx:330`, `pages/ApplicationRecords.tsx:64`, `pages/Returns.tsx:243`, `pages/InventoryPage.tsx:420`, `components/prepay/PrepaymentManagerPanel.tsx:296`, `components/field-app/SelectLocationsModal.tsx:70`, `pages/ApplicationServiceDetail.tsx:79`, `components/quotes/BulkQuoteImport.tsx:440` | Customer pickers and filters. In bulk import, customers past the cap fail to match | 1,000 (server) |
| M49 | Product lists with no limit (1,000, server): `components/blendtickets/ManualTicketCreate.tsx:292`, `components/deliveries/QuickDeliveryModal.tsx:98`, `components/orders/BulkOrderImport.tsx:390`, `components/purchase-orders/BulkPOImport.tsx:206`, `components/quotes/BulkQuoteImport.tsx:441`, `components/receiving/QuickReceivePanel.tsx:148`, `pages/BlendRecipes.tsx:138`, `pages/BrandVsGeneric.tsx:49`, `pages/InventoryPage.tsx:406`, `pages/NewPurchaseOrder.tsx:88`, `pages/SalesReports.tsx:122`, `pages/LabelDataQuality.tsx:385`, `:391` | Product pickers, imports, the category list and the label-quality report. At 595 products these are close to the line | 1,000 (server) |
| M50 | Field lists with no limit (1,000, server): `components/field-app/SelectLocationsModal.tsx:39`, `pages/Compliance.tsx:188` (total acres at `:803`), `pages/Fields.tsx:84` | Field pickers and the fields acre listing | 1,000 (server) |
| M51 | Edge Function `supabase/functions/process-blend-ticket/index.ts:1073` (products), `:1078` (customers) | Scanned blend tickets match products and customers against these lists. Anything past the cap silently fails to match | 1,000 (server) |
| M52 | `pages/Jobs.tsx:572`; RPC `get_jobs_billed_customers` *(live)* | Billed-customer column on the jobs list | 1,000 (server) |
| M53 | `supabase/migrations/20260722064814_wells_cost_basis_rollout_gate.sql:841`, RPC `get_product_cost_basis_workspace` *(live)* | Cost-basis "purchase candidates" picker (product detail, supplier pricing) | 20 newest PO lines |
| M59 | `components/prepay/PrepayWorkspacePanel.tsx:76` (found by Codex) | Prepay workspace customer picker (customers with a prepay balance) | 1,000 (server) |
| M60 | `pages/ProductDetail.tsx:425` (found by Codex) | Category, vendor and manufacturer choices, built from every product (604 rows today, inactive included) | 1,000 (server) |

## Findings: LOW (signalled, short on purpose, or unlikely to matter)

| ID | Where (file:line) | What | Cap and signal |
|---|---|---|---|
| L1 | `pages/Customers.tsx:84` | Customers list | 1,000, with an exact count and a lasting banner (`:477`). Correct as a signal; Goal 4 still wants real paging |
| L2 | `pages/Jobs.tsx:453` | Jobs list | 500, with a lasting banner (`:2010`) |
| L3 | `components/integrity/IntegrityReportPanel.tsx:127` | Discrepancy rows shown per check | 50 shown, "Showing first 50 of N" (`:137`); the count is right |
| L4 | `pages/OfficeCockpit.tsx:340` | "Delivered, not invoiced" scan | 1,000 newest, signalled at `:1414` and `:1450`; "All clear" is held back while capped. Correct |
| L5 | `pages/OfficeCockpit.tsx:573` | Chemical drafts tile | 50, banner at `:1396` |
| L6 | `pages/OfflineWorkReview.tsx:63`; RPC `get_offline_action_review_queue` *(live)* | Offline work review | 100 (max 200); shows the true "Matching total" but has no page 2 |
| L7 | `components/compliance/ExpiringLicensesCard.tsx:43` | Dashboard expiring-licenses card | 6, silent; the full list is on Compliance |
| L9 | `components/team/NotificationsPanel.tsx:39` | Bell dropdown; unread badge counted from the 20 loaded | 20, silent |
| L10 | `pages/Notifications.tsx:33`, `pages/TeamBoard.tsx:218`, `pages/TeamBoard.tsx:132`, `components/team/ActivityFeed.tsx:33` | Notifications, activity log, team notes, note feed | 200, 100, 1,000 (server), 20. The activity log says "Showing most recent 100 entries" (`:1285`); the others are silent |
| L11 | `pages/CustomerDetail.tsx:660`, `pages/ProductDetail.tsx:361`, `pages/BlendTicketDetail.tsx:848`, `pages/Deliveries.tsx:493` | Timeline, cost history, link-to-order modal, unassigned deliveries to claim | 50, 20, 50, 20; silent |
| L12 | `pages/MonthEndClose.tsx:145` | Period history | 36 months; only matters if periods are created far ahead |
| L13 | `pages/FieldSetup.tsx:203`, `components/jobs/jobFieldPicker.ts:4` | Map pins | 300; the picker says "Map shows the first 300" |
| L14 | Dashboard top-N lists, by design (all *(live)*): `financial_dashboard_summary`, `operational_dashboard_summary`, `dashboard_summary`, `get_field_dashboard`, `get_customer_prep_card`, `get_customer_purchase_summary`, `get_supplier_pricing_workspace` (50), `get_recent_lots_for_product` (50), `global_search` (5 per type) | Short lists on purpose. The headline totals in these functions are full database sums | 5 to 50 |
| L15 | Server search pickers: `components/deliveries/QuickDeliveryModal.tsx:167`, `components/field-app/FieldAppChemicalEntry.tsx:171`, `pages/PaymentAllocation.tsx:126`, `pages/InvoiceDetail.tsx:636`, `pages/PurchaseOrderDetail.tsx:917`, `components/ui/CommandPalette.tsx:251` | These show 5 to 20 results but search the database as you type, so any record can be found | Fine; this is the pattern Goal 4 wants |
| L17 | `hooks/useGuardrails.ts:45` | Credit-limit check over one customer's open invoices | 1,000 (server). Money, but only past 1,000 open invoices for one customer |
| L18 | `hooks/useOCRProcessor.ts:27`, `lib/applicatorSheetPrintData.ts:76`, import file-size guards (`BulkCustomerImport`, `BulkProductImport`, `fieldImportParser`, workbook loaders) | Background queue batch, print option, import limits | Signalled or by design |
| L19 | `pages/Vendors.tsx:71`, `pages/BlendRecipes.tsx:100`, `pages/ApplicationServices.tsx:52`, `pages/Compliance.tsx:157`, `pages/Vehicles.tsx:43` (found by Codex; Vehicles added after the PR GitHub review) | Vendor, recipe, application-service, restricted-use product and vehicle lists. On Vehicles, select-all, export and bulk delete act on the rows loaded | 1,000 (server), silent. These are small reference lists that are unlikely to reach 1,000 |
| L20 | `pages/CustomerDetail.tsx:531`, `:538`, `:553`, `:576` (one customer's quotes, orders, order lines, deliveries); `pages/CycleCounts.tsx:146`; `lib/openBookings.ts:18`; `lib/lotRpc.ts:63` (lot recall trace for one lot); `components/jobs/AppliedRecordsManager.tsx:180` (one job's applied-acres history, which also drives its Applied and Remaining figures); `components/team/RelatedNotes.tsx:48` (RPC `get_notes_for_entity` *(live)*, the notes on one order, job, customer, delivery or PO) | Reads scoped to one customer, lot, job or record, or count history (the last two were added after the PR's GitHub Codex review) | 1,000 (server), silent. Only an unusually large customer, lot, job or record would reach it |
| L21 | `pages/Deliveries.tsx:836`, `pages/TeamBoard.tsx:878`, `:1024`, `pages/SupplierPricing.tsx:1050`, `components/fields/FieldCustomerAssignment.tsx:38`, `components/layout/Sidebar.tsx:367`, plus the 3-item chip lists on Jobs and Field Dashboard | Display-only trims of rows already loaded (10, 5 or 20 items) | Short on purpose; several show "+N more" or "View all" |
| L22 | Staff and profile lists (`pages/SettingsPage.tsx:254` user management, and the `profile_public_view` role lists); Jobs setup catalogs (`pages/Jobs.tsx:332`, `:347`, `:361`, `:374`: applicators, ground crews, job batches, job tags); also unit conversions, warehouses, app settings, vehicles and vendors | **Catch-all for every unpaged read of a small staff or setup table**, listed here or not (added after the PR's GitHub Codex reviews). These tables hold tens of rows, not thousands | 1,000 (server), silent. Not a practical risk. Fix one in step 5 only if it grows |

## Already correct (checked, no fix needed)

These read every row: they keep asking for the next page until none are left.

- `lib/reconciliation.ts:713` (`fetchAllRows`), used by Integrity Report checks 1–4, 7 and 8 (`:734`, `:740`, `:773`, `:779`, `:817`, `:824`, `:939`, `:944`, `:996`, `:1001`). Each page is ordered by `id`.
- `lib/deliveryExternalBilling.ts:23`, `lib/deliveryInvoiceCoverage.ts:44`, `lib/deliverySplitBilling.ts:88`, `lib/recognizedInvoiceCustomers.ts:43` (year-end batch).
- `pages/Products.tsx:113`, `pages/FieldView.tsx:205`, `pages/DispatchBoard.tsx:311`, `:377`, `:1195`. The DispatchBoard loops at `:311` and `:377` have no sort order, so pages can overlap or skip rows if data changes mid-read. That is worth fixing during Goal 4's paging work.
- These database functions add up their numbers inside the database and return one result, so the row ceiling doesn't apply: `financial_dashboard_summary`, `operational_dashboard_summary`, `get_monthly_summary`, `get_inventory_position`, `get_inventory_forecast`, `get_detailed_statement_data`, `generate_batch_statements`, `get_batch_year_end_summaries`, `get_customer_year_end_summary`, `get_commission_history_report`, `get_ap_dashboard_summary`.
- The database integrity sweep `run_data_integrity_sweep` and the other checker functions (`check_unpriced_orders`, `run_morning_notification_checks`, `check_remainder_reminders`) have no cap. Only the screen that reads their alerts does (H30).
- Edge Functions: no `listUsers` paging, `.range()` or SQL `LIMIT` anywhere. The only exposure is M51.

## Found along the way (not row limits, not fixed here)

- `lib/notificationTriggers.ts:88` (`checkLowStockNotifications`) reads every inventory row with a reorder point in one request. But it is dead code: its only caller, `runPeriodicNotificationChecks` (`:657`), is never called outside tests. Low-stock alerts now come from the database job `run_morning_notification_checks`, which has no cap (see `Dashboard.tsx:314`). It is not a finding; deleting the dead helper is optional cleanup. (Listed as M67 in an earlier revision; removed after the PR's third GitHub Codex review.)

- `lib/documentOCR.ts:47` (`MAX_PAGES = 20`, applied at `:61`): scanning an uploaded PDF in the bulk PO, order, quote and customer imports reads only the first 20 pages. Lines and totals after page 20 are never imported, and the user isn't told (only a Sentry warning at `:88`). This is a page cap, not a row cap, so it sits outside the counts above. It still belongs in Goal 4's fixes. (Listed as H35 in the first draft; moved after the Codex review.)

- `components/integrity/IntegrityCleanupPanel.tsx:152`: the "over-received PO" check compares `quantity_received` to the **text** `'quantity_ordered'`, not to the other column. PostgREST cannot compare two columns this way, so the check almost certainly errors or returns nothing, and the section stays empty. This is a likely broken integrity check (not run to confirm).
- `components/prepay/PrepaymentManagerPanel.tsx:143`: "Total Unpaid Invoices" counts only `posted` invoices and leaves out `overdue` ones. It also runs one query per customer. *(Both fixed 2026-10-20: the per-customer queries by Goal 4 part 2a, PR #988; overdue invoices in both prepay screens by `docs/changelog.d/2026-10-20-prepay-overdue-invoices.md`.)*
- `create_invoice_from_blend_ticket` and `_save_field_app_invoice_impl_20260714` pick a quote price with `ORDER BY qi.id LIMIT 1`. If a product is on several quote lines at different prices, the choice is arbitrary. This is unconfirmed and belongs with Goal 2's blend-ticket pricing work.
- `reconcile_prepay_balances` checks only active customers, so balance drift on inactive customers is never checked.

## Suggested fix order

1. **Money totals into the database (H1–H16, H18–H24, H37–H40, H43).** Replace each on-screen sum with a database function that returns the exact total in cents, and page the list separately. Start with Payment History (H1), Commission Payments (H2, H3), Invoices and Field Invoices (H4–H7), AR (H15, H16, H38), and Reports and Sales Reports (H9–H14, H39). Goal 4's own test (5,000 invoices, more than 5,000 lines, a 200+ payment history) exercises exactly these. Where a screen also **acts** on its rows, a correct total is not enough. That covers the commission payout picker (H3), commission quick-pay (H12), the finance charge preview (H24), "Post all" and "Unpost all" (H6, H7) and check allocation (H43). For these, the action must select its targets in the database, or page through every eligible row, so nothing past the cap is skipped.
2. **Integrity and compliance checks (H25–H30, H32–H34, H36, H41, H42).** Move Integrity Report checks 5, 6, 9 and 10 onto the existing `fetchAllRows` pattern, or into the database. Page the cleanup panel, the pesticide register, the logbooks, Application Records, Posted Applications and the license register. Fix the over-received PO check and the 20-page document-scan limit alongside them.
3. **Product lists that were already short (M1–M4).** Done by PR #944: the three filters now search as you type, and the Price List reads every row. The shared `ProductSearchPicker` from that PR is the pattern for step 4.
4. **The remaining pickers and lookup lists (M29–M51, M53, M59, M60).** Search-as-you-type. Do the invoice customer picker (M29) first, because it also feeds the PDF address and email. Some rows here need a different fix:
   - the bulk imports in M48 and M49, and the Edge Function in M51, should match names in the database, not against a downloaded list;
   - the Label Data Quality report in M49 needs a full read;
   - the category, vendor and manufacturer choices (M60) should come from a database query of distinct values.
5. **List pages (M5–M28, M52, M54–M58, M61–M66).** Real paging and search. For the Jobs list's billed-customer column (M52), read the billed customers for each page of jobs, so none are cut off. Show a lasting "more records" message wherever a list is still capped.
6. **LOW items** last. Most need nothing, or just a "+ more" note.

Across all of these, the Goal 4 rule applies: a failed or partial read must never show a zero or a complete-looking total.

## Method

- Four read-only sweeps covered `src/pages`, the shared code (`src/components`, `src/lib`, `src/hooks`), queries with no limit (the server ceiling), and SQL functions plus Edge Functions. Claude then opened the code at each line cited above to confirm the cap, what the screen does with it, and whether a total is summed from it.
- Live database, SELECT only: every public function containing `LIMIT` (`pg_proc.prosrc`), every function that returns rows (`proretset`), role settings (`pg_roles.rolconfig`, which doesn't hold Max rows; the value was read from the Supabase dashboard instead), and record counts (595 active products, 151 active customers).
- Codex: an independent hunt by `gpt-6-luna` at `xhigh` on a frozen copy of `src/` and `supabase/` in a neutral folder, without seeing Claude's list. Then a second Luna pass reviewed this draft from a self-contained packet (the sandbox couldn't read files on that run). Both results are under "Codex cross-check."
- IDs are not renumbered after the review. Gaps (H17, H31, H35, L8, L16) mark items that moved, and each new row says where it came from.

## Codex cross-check

Codex was an advisor only. Every Codex finding was checked against the current code by Claude before it went in.

**Pass 1, independent hunt.** Codex found most of the same items without seeing Claude's list. Those rows are marked C+X.

- **Codex found, confirmed, and added:** H37 (AP aging), H38 (open credit memos), H39 (gross sales), H40 (transaction review), H41 (Posted Applications report), H42 (license register), the two extra stock checks in H30, M54–M60, L19, and the "Showing most recent 100 entries" message on L10.
- **Claude-only (Codex missed):** H23, M6, M8, M26, M28, M52, M53, M61 (first-draft H31), L7, L17, and the 20-page document-scan limit (first-draft H35).
- **Codex findings not added, or rated differently, with the reason:**
  - `pages/CallLists.tsx:581` (customers) is not a finding. The query is `.in('id', ids)` over a call list that is already capped at 200, so it can't reach 1,000. The real cap is M21.
  - Codex rated the Invoices and Field Invoices lists MED ("no client grand total identified"). They stay **HIGH**: `Invoices.tsx:212` and `:213`, and the Field Invoices panels, sum Posted and Outstanding totals from the capped rows.
  - Codex rated Payment History (200) and the Prepay manager (500) MED. They stay **HIGH**: `PaymentHistory.tsx:173` and `PrepaymentManagerPanel.tsx:481` sum money totals from those rows.
  - Codex rated the Integrity Report's "first 50 discrepancies" HIGH. It stays **LOW** (L3): the check reads every row, and the screen states the true count.
  - Codex rated the Office Cockpit "Delivered, not invoiced" scan and Offline Work Review HIGH. Both stay **LOW** (L4, L6). Each says on screen that it is partial, and the Cockpit holds back "All clear" while capped.
  - Codex rated the delivery item read (`Deliveries.tsx:308`, `:367`) HIGH as a missed inventory check. It stays **MED** (M10): it drives item-count and shortage badges on a list, not a record of truth.
  - Codex rated the search-as-you-type pickers (QuickDeliveryModal, FieldAppChemicalEntry, InvoiceDetail product search, PaymentAllocation customer search) MED. They stay **LOW** (L15): they query the database on each keystroke, so any record can be found.
  - Path corrections: Codex cited `src/components/FinanceChargePreviewModal.tsx`, `src/pages/QuickDeliveryModal.tsx` and `src/lib/jobFieldPicker.ts`. The real files are in `components/invoices/`, `components/deliveries/` and `components/jobs/`.

**Pass 2, review of the draft.** The first two attempts failed before Codex could read a single file. Its Windows sandbox helper refused to start a command ("helper_unknown_error: setup refresh had errors"), so those runs produced no review. The third attempt gave Codex everything inside the prompt: the draft, plus 4 lines either side of each of the 206 cited lines, so it needed no tools. Codex made 12 points:

- **Accepted and fixed:**
  1. The first-draft H31 said the unbilled-backlog banner disappears after one item is billed. That's wrong: it stays while 500 are returned. Because the banner exists, the item is now **M61** (MED).
  2. The Customer Balance listing sums no total (checked: `Reports.tsx` has no sum over `custBalanceData`). It moved from H17 to **M63**, so the money count stays at 28.
  3. The interaction history (first-draft L8) moved up to **M64**.
  4. Check allocation (first-draft L16) does sum money (`PaymentAllocation.tsx:536`). It moved up to **H43**.
  5. The integrity-check count was wrong. H30 holds three checks, so the summary now says nine.
  6. "None of these totals is wrong yet" now cites live row counts, not just the invoice count.
  7. The 20-page document-scan limit is a page cap, not a row cap. It moved to "Found along the way."
  8. The Price List (M4) needs full paging, not a search box.
  9. The "remaining pickers" group now separates out the imports, the Edge Function, the report and the choice lists.
  10. Fix step 1 now requires screens that act on their rows (payout, quick-pay, finance charges, Post/Unpost all, allocation) to select every eligible row.
  11. New finding: the pick-list PDFs read the whole inventory table (**M62**, `Orders.tsx:342`, `OrderDetail.tsx:410`; Claude's implicit-limit sweep had it too).
- **Refuted:**
  - L19 stays LOW. Vendors, recipes, application services and restricted-use products are short reference lists. None is anywhere near 1,000 rows.
  - "Some cited lines are missing from the excerpts" was about the review packet, not the code. The packet builder only grabbed the first line of each citation, so lines like `PaymentHistory.tsx:173`, `:257` and `:286`, `Invoices.tsx:155`, `:212` and `:213`, and the action-queue count were left out. Claude had already read each of those lines in the source before writing the draft.
  - The `customer_addresses` read next to M62 is filtered to the selected customers, so it isn't a finding.
