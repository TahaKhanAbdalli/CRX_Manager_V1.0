# Generic products and real brands, step 1: record which brand shipped

**Status: PLAN, 2026-10-22. NOT STARTED.** Mason asked for this plan in chat on 2026-10-22: "Refresh the
August brand design against today's code, write the step 1 build plan (brand list with EPA numbers, pick
the brand at delivery, print it on paperwork), and add it to the To-Do list. Go with your recommendations on
cost and who picks the brand." Building starts only when Mason says so. It is To-Do list row 2.8
(`docs/manual/TO_DO_LIST.md`).

**Source design.** This is the brand part (WP-3) of the August product data model, refreshed against
`main` at `6ff53669a` on 2026-10-22: `docs/plans/2026-08-18-product-data-model-MASTER-RECORD.md`
(T-6, T-7, D-13, D-14, B-16, B-17, C-29), `docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md`
(WP-3, D-H, D-I, D-K, D-S) and `docs/plans/2026-08-18-product-data-model-PRD.md` (1.9a). Those
documents keep the reasoning. Where this plan differs from them, section 9 says so and why.

**Code facts** were read from `main` on 2026-10-22, with file and line, and an independent read-only review
checked every citation and the design against the code the same day (35 findings, all applied below).
The Codex GitHub App's reviews of PR #1037 added eleven more, also applied. Re-check each fact before
building; delivery code changes often. Review comments on PR #1037 after its last commit are answered on
the PR and carried to PR B, which must read that PR's resolved threads before it starts. Further
build-level detail belongs to the build PRs' own reviews,
not to this plan.

**Words used below.** A *migration* is a reviewed change to the database. A *database function* is a
saved operation the app asks the database to run (for example "complete this delivery"); the rules inside
it can't be skipped by the screen. A *snapshot* is a copy saved at the time, so later edits elsewhere don't
change it. The *RUP register* is the restricted-use pesticide sales record kept for regulators
(`rup_sales_records`, shown on the Compliance page). *Retry-safe* means a repeated tap or a lost
connection can't save something twice.

---

## 1. The problem, in Mason's words

> "we have 'Generic roundup 5.4#' as a product to quote off of but can get 15 different actual brands that
> might get delivered to customer depending on pricing etc. how do we manage pricing based off of generic
> roundup, genricl glufosinate, etc but when deliver we log the actual EPA number of chemical from 2x
> different brands at times" (2026-10-22)

> "I will sell or quote early season as just 5.4# glyphosate or LV6 ester 24d, then we might deliver Lima 6
> brand lv6 or low vol ester, etc etc depending on what we source so we need to track the actual individual
> epa number on them." (2026-08-18, B-17)

**Live today** (read-only count by Claude, 2026-10-22): 604 products (595 active). About 95 are
generic-style names such as `Gen Liberty: (Interline, Inflame) - 2.5 Gal` or `Roundup 5.4# Generic (Ag Saver
5.4, Slam 5.4)`. 76 names carry their list of acceptable brands inside the name, where nothing can read it.
Only 287 of 604 products have any EPA number, and each product has one at most. `product_families` has 0
rows, and no brand table exists.

**What the paperwork does today:**
- The **delivery receipt** (PDF and the completion email) shows no EPA number (`src/lib/deliveryPdf.ts:15-21`,
  `:120-142`; `src/lib/deliveryCompletionEmail.ts:61-67`).
- **Invoices made from a delivery never store an EPA number** on their lines. The automatic invoice at
  completion copies product, quantity, prices, cost, size and tote, but not `epa_registration`
  (`supabase/migrations/20261014210000_order_invoices_rep_own_name.sql:817-854`); so do the unbilled-delivery
  recovery path (`20260827041200_exclude_return_credits_from_delivery_invoice_gate.sql:699-717`), quick
  delivery (`20260914100500_commission_dates_follow_chicago_business_day.sql:2247-2249`), landlord split
  invoices (`20261021155000…:1739-1748`) and whole-order invoices (`20260827041400…:167`). The invoice PDF
  then falls back to the product's own number (`src/lib/invoicePdf.ts:75`, `:311`), which for a generic is
  blank or not the jug's number.
- The **customer statement** prints only the stored invoice-line number, with no fallback
  (`20260803221244_fix_statement_balance_disclosure.sql:424`, `src/lib/statementPdf.ts:571`, `:628`), so
  every delivery invoice prints a blank EPA column there today, branded or not.
- The **RUP register** is filled when an invoice is posted, from the product's own EPA number
  (`20260707040000_generate_rup_sales_records_role_gate.sql:83`, inserted at `:126`). For a generic RUP
  product (paraquat, atrazine and the like) it records the generic's number, not the delivered brand's. It
  also keeps only one record per product per invoice (`:111-116`; index `idx_rup_sales_records_active` in
  `20260630173050…:73-75`). This is the most important regulated record in step 1.
- The **year-end summary** groups by the product's own EPA number
  (`20261013220000_reps_work_any_customer.sql:2149`, `:2164`).

## 2. What step 1 delivers

1. **Quoting, pricing, orders and invoice amounts do not change.** They stay on the generic product
   ("Roundup 5.4# Generic"). Brands never carry a price. (August T-6.)
2. **One cost stays on the generic product** (Mason, 2026-10-22, accepting the recommendation). Brands do
   not carry their own cost in step 1. Per-brand cost can come with step 2, once stock is counted by brand.
3. **Each product can list its acceptable brands.** Each brand has a name, its own EPA registration number,
   an optional manufacturer, and a "currently sourced" switch. Only admins add, edit or retire brands (August
   D-S). A brand no longer bought is switched off, never deleted, so old records keep pointing at it. Brands
   sit on each product row, and product rows are pack sizes ("- 2.5 Gal", "- Bulk"), so a brand sold in two
   sizes is entered on each; the Brands section offers "copy brands from another size of this product".
4. **Whoever loads the truck picks the brand, and it is required** (Mason, 2026-10-22, accepting the
   recommendation) for every delivered line whose product has at least one brand on its list (switched on or
   off). The app has no warehouse role (`src/types/index.ts:6`: admin, sales_rep, driver, applicator), so
   "whoever loads" means the assigned driver, or an admin or rep doing it for them: the same people who may
   complete the delivery. A line may name more than one brand, each with its amount (30 gal Slam + 15 gal Ag
   Saver), in the line's own unit, and the amounts must add up to what was delivered.
5. **An unlisted brand never stops the truck.** The person picking types the brand name and the EPA number
   from the jug's label. The delivery uses exactly what was typed, and the entry goes to an admin to check
   and, if right, add to the product's list (August D-K and D-S, applied at delivery instead of at receiving).
6. **The brand and its EPA number are saved onto the delivery as they were that day** (PRD 1.9a-iii).
   Fixing a brand's EPA number later never changes an old delivery. A wrong pick on a completed delivery can
   be corrected only by an admin, with a reason, and the correction is logged (section 4, item 6).
7. **Paperwork prints the real brands**: the delivery receipt (PDF and email), every invoice made from a
   delivery or from the order it delivered, the customer statement, and the RUP register for those invoices.
   A product with no brands prints its own EPA number, and from step 1 that number is also stored on delivery
   invoice lines, so the statement stops printing a blank.
8. **Lot and tote numbers stay optional and untouched** (August T-7, PRD 1.9a-iv).

**Not in step 1** (step 2 or later):
- picking the brand at receiving, counting stock by brand, and refusing a brand that isn't in stock;
- brand-specific density and scale weight; per-brand cost;
- the year-end summary by brand;
- brand on field-application, job and blend-ticket invoices. Those still record the generic's EPA number in
  the RUP register (Mason, 2026-10-22: those invoices are built last). Until then, an RUP generic applied on
  a field application needs its brand noted by hand;
- the ingredient tables and the comparison tool (August WP-1, WP-2, WP-4, WP-5).

## 3. How it works day to day

**Admin, once per product.** On the product page, a new **Brands** section lists the acceptable brands. An
admin adds one by typing the brand name and its EPA number. The app runs the existing EPA lookup
(`supabase/functions/epa-lookup`, admin-only, already used by `src/pages/ProductDetail.tsx`) and shows the
product name EPA has on file for that number, so a typo shows up before saving. For the 76 products that
already list brands in their name, the section suggests those names; the admin still types each EPA number
and saves each one (August D-H: a name read from text is a suggestion, never saved unreviewed).

**Loading the truck.** On the delivery page (`src/pages/DeliveryDetail.tsx`, both its office layout and its
phone layout for drivers) and on the driver's route stop (`src/pages/FieldStop.tsx`), each line whose product
has brands shows a **Brand** picker: the product's currently sourced brands, plus **Other brand…** (type name
and EPA number). One brand covers the whole line by default; **Split** adds a second brand with an amount.
Picks can be saved any time before the delivery is completed, so the driver can do it at the shed as the
jugs go on.

**At the farm.**
- A line delivered short with **one brand**: the brand's amount follows the delivered amount by itself (same
  brand, smaller amount, so nothing is guessed). A line delivered at zero has its brand rows removed.
- A line delivered short and **split across brands**: the completion screen asks how much of each brand went
  off the truck, pre-filled with what was loaded, and sends those amounts with the completion in one step.
- A line with **no brand picked yet**: the completion screen asks for it right there; the jugs are on the
  truck, so the driver can read the label.
- Completion is refused only when a listed-brand line still has no brand, or a split doesn't add up, with a
  message naming the line. A stock shortage still never blocks (To-Do 2.6).

**From the Deliveries list.** The one-click **Mark Delivered** (admin and rep) completes in full. If any
line still needs a brand, it is refused with "Pick the brand on the delivery page first", naming the line.

**Office, afterwards.** The delivery's invoice lines carry each line's EPA numbers. Brands typed at a
delivery wait on a **Brands to review** list (a tab on the Products page, also shown on each product's Brands
section). An admin either adds the brand to the list or dismisses it; neither changes what the delivery
saved. If a typed EPA number was wrong, the admin corrects the delivery (section 4, item 6). A draft invoice
carrying a typed, unreviewed brand shows a warning: "Brand typed at delivery, not yet checked".

## 4. What changes in the database

**In plain English:** two new lists (brands per product; brands per delivered line), a handful of new
operations to fill them, one new check when a delivery is completed, and the EPA number copied onto invoice
lines and into the RUP register. No price, cost, quantity or invoice total changes anywhere.

Rules every piece follows (AGENTS.md hard rules): new tables ship with Row Level Security (the database's
own who-may-see-what rules) and policies in the same migration; nobody writes the new tables directly, only
through database functions; each function takes `p_idempotency_key` and uses the current retry pattern that
binds the key to the person and the request (`check_idempotency_intent` with a request fingerprint and
`_bind_replay_receipt`, as in `20261019220000_start_and_complete_delivery.sql:167-217`), so it doesn't add
to the open retry gap in To-Do 2.3; functions that run with elevated rights set
`search_path = public, pg_temp` and get deliberate grants. Money stays in whole cents.

1. **`product_brands`** (PR A): `product_id`, `brand_name`, `epa_registration`, `manufacturer` (optional),
   `is_currently_sourced`, a per-row version for safe edits, audit columns, `updated_at`. Unique brand name
   per product (ignoring case), and unique `(product_id, id)` so other tables can bind a brand to its own
   product. Everyone signed in may read. **`upsert_product_brand`** (admin only) adds or edits a brand;
   retiring means switching `is_currently_sourced` off. The pattern to copy is `product_supplier_links` and
   `upsert_product_supplier_link` (`20260718230000_supplier_price_evidence_phase1b.sql:102`, `:1054`;
   client `src/lib/supplierPricing.ts:428-448`).
2. **`delivery_item_brands`** (PR B): one row per brand on a delivery line. `delivery_item_id`,
   `delivery_id` and `product_id` (both copies tied to the line by the database, so they can't disagree with
   it), `brand_id` (blank for a typed, unlisted brand), `brand_name_snapshot`, `epa_registration_snapshot`,
   `quantity` (above zero, in the line's unit), who entered it and when, and a review state for typed entries.
   A composite foreign key binds `(product_id, brand_id)` to `product_brands(product_id, id)`, so a Roundup
   line can never carry a Liberty brand (August WP-3, blocker 4). Rows are deleted with their line. Read
   access follows the delivery's own read rules. **Every line uses rows here, even a single brand**; there is
   no brand column on `delivery_items`. This is a new table, so the existing lock on `delivery_items`
   (trigger `enforce_delivery_items_parent_lock`, function body
   `20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql:770-811`) does not apply to it.
3. **`set_delivery_brands(p_delivery_id, p_lines jsonb, p_idempotency_key)`** (PR B): admin, rep or the
   assigned driver (the completion rule, `20260716173342_authorize_delivery_before_replay.sql:80-84`), only
   while the delivery is `scheduled` or `in_progress`. It locks the delivery, replaces the brand rows of each
   named line in one step, checks each listed brand belongs to the line's product, takes the name and EPA
   number from the brand row (or from the typed entry), and requires the amounts to add up to the line's
   loaded quantity.
4. **The completion rule** (PR B), **inside `_complete_delivery_authorized_impl`** (latest body
   `20261014210000_order_invoices_rep_own_name.sql:422`), placed right after the loop that writes
   `quantity_delivered` (`:587`) and before the tote copy (`:628`) and invoice creation. It can't be a trigger
   on the delivery's status: the status is set to `completed` at `:572-576`, *before* the delivered amounts
   are written, so a trigger there would check stale amounts and let everything through. Every completion
   path already runs through this one function: `complete_delivery`
   (`20261019200000_bind_delivery_job_replay_receipts_batch3a.sql:338`), `start_and_complete_delivery`
   (`20261019220000…:99`, which calls `complete_delivery` at `:201`) and the replay of older queued offline
   completions (`20260714203709_offline_action_target_lock.sql:162-172`, whose per-action error catch keeps
   working because the check runs immediately, not at commit). The rule:
   - every line delivered above zero whose product has any brand rows must have brand rows, or the completion
     is refused (`BRAND_REQUIRED`, naming the line);
   - a single-brand line's amount is set to the delivered amount; a line delivered at zero loses its brand
     rows;
   - a split line must add up to the delivered amount (`BRAND_SPLIT_MISMATCH`). **The split amounts for a
     short delivery travel with the completion in one call**, as a reserved `_brands` entry inside the
     existing `p_quantities` object (today keyed by line id with the delivered amount as the value, read at
     `:539-540` and `:582-583`). The builder first confirms how every layer of the completion chain parses and
     fingerprints that object; if a reserved entry can't be added safely, a new public wrapper is added instead,
     with the screens merged before the old one is retired (code first, as August WP-3 required for
     receiving). Either way no existing input changes meaning, so nothing breaks while the database is ahead
     of the screens, and a retried or abandoned completion can't leave a stale split behind.
   - **An on/off switch** (`app_settings` key `delivery_brand_required`, off by default, flipped by an admin
     on the settings screen) turns on the refusals. With it off, completion records whatever brands were
     picked and refuses nothing. A branded product's line completed with no brand picked in that time gets no
     EPA number on its invoice line, never the generic's own number. Its draft invoice warns "brand not
     recorded". Before the switch goes on, an admin works through a short report of those deliveries and
     records each brand with the admin correction (item 6), which also fills the invoice line. This lets the
     migration go live before the screens (the normal order in
     `.claude/commands/ship.md`) without refusing every completion of a branded product in between. It is
     switched on once the pickers are live and proven, and scheduled deliveries still open then simply get
     the picker.
5. **EPA number onto invoice lines** (PR B).
   **Which brands belong to an invoice line.** This rule is used here, by the RUP register (item 7) and by the
   correction (item 6). One order line can be filled by several deliveries, each with its own brands, and
   the completion flow bills each delivery on its own invoice with its own `invoices.delivery_id`
   (`20261014210000…:717-722`, `:817-834`). So:
   - **an invoice with a `delivery_id`** takes brands only from that delivery: the brand rows of that
     delivery's line for the same order line (`delivery_items.delivery_id = invoices.delivery_id` and the
     same `order_item_id`). It never picks up a sibling delivery's brands;
   - **an invoice with no `delivery_id`** (a whole-order invoice or a landlord split invoice) adds up the
     brand rows of every completed, not-voided delivery of that order line.

   One step at completion, modeled on the tote-number copy that already runs on every completion
   (`20261014210000…:606-628`), fills `invoice_items.epa_registration` on the open draft lines of that
   delivery's own invoice: the delivered brands' numbers (two joined, such as
   `524-475; 34704-890`, for a split line), or the product's own number when the product has no brands. This
   covers the automatic invoice, a quick delivery's draft (whose lines exist before completion), and the
   partial-delivery trim. The unbilled recovery path, the landlord split creator
   (`_create_split_invoices_from_order_provenance_impl_20260719`, `20261021155000…:1739-1748`) and the
   whole-order invoice (`_create_invoice_from_order_impl_20260718`, `20260827041400…:167`) set the same value
   when they insert lines, using the rule above. The split creator must do it at
   insert time, because split lines can't be changed afterwards outside an invoice save
   (`guard_split_invoice_provenance_items`, `20260719044912…:330-361`); each owner's share shows all the
   brands delivered on that line. **No invoice amount, quantity or cost changes**, no column is added to
   `invoice_items`, and the invoice cap triggers don't watch this column
   (`20261010120000_cap_delivery_invoice_at_delivered.sql`).
6. **`correct_delivery_brands`** (PR B, admin only, reason required, logged): changes the brands on a
   completed delivery, whatever state its invoices are in. It never unposts an invoice: `unpost_invoice`
   accepts only `posted` and `overdue` and refuses any invoice with money applied
   (`20260625130000_unpost_invoice.sql:151-170`), so "unpost first" can't work for a paid or part-paid one.
   What it changes depends on the invoice's status (`invoices.status`: draft, unposted, posted, paid,
   overdue, voided, cancelled):
   - `draft` or `unposted`: it re-copies the invoice lines' EPA numbers;
   - `posted`, `overdue` or `paid`: the invoice stays exactly as issued (the customer's copy doesn't
     silently change). To make that true for the brand names as well as the EPA number, a correction never
     overwrites brand rows on a completed delivery. It marks the old rows superseded (`superseded_at`,
     `superseded_by`, reason) and adds new ones. Screens and new paperwork read the current rows. A reprint
     of an issued invoice reads the rows that were current when it was posted, so its brand names still
     match its stored EPA number. If such an invoice is later unposted and posted again, posting re-copies
     each line's EPA number from the brand rows current at that moment, so the new issue and its reprint
     agree; the proof runs correction → unpost → repost. Before completion, `set_delivery_brands` may still replace rows outright,
     since nothing has been issued yet. In the same step, it rebuilds **all** of that invoice's RUP records
     at once. A register record can combine several lines (item 7) and carries no line identity, so voiding
     only "the corrected line's" record would lose a sibling line's quantity and cents. Instead, every active
     record for the invoice is voided with the correction's reason (`voided_at`, `voided_by`, `void_reason`,
     the same voided-row handling the register already uses, PARKED-006). Then the whole invoice's records
     are regenerated by the rules in item 7, in one transaction. The
     correction log names the invoice, so a reprint question can be answered;
   - `voided` or `cancelled`: only the delivery is corrected; such an invoice has no active RUP records.
   **`review_typed_brand`** (admin only) adds a typed brand to the product's list (and links the delivery row
   to it, without changing its snapshot) or dismisses it.
7. **RUP register** (PR B): `generate_rup_sales_records` writes one record per delivered brand, with that
   brand's EPA number and amount, when the posted line has brand rows under the rule in item 5. That rule
   matters most here: a delivery invoice uses only its own delivery's brands, so two invoices for one order
   line never both report the same brand amounts. Rules:
   - **records are added up before they are written, not skipped.** Today the duplicate check keeps only the
     first record per (invoice, product) and silently drops the rest. A known case is two lines of the same
     product on one invoice, which a split-invoice screen refuses for exactly that reason
     (`20261013220000_reps_work_any_customer.sql:863-876`). With brands, two lines can also share a product
     and a delivered EPA number. So the function first adds up every line's per-brand quantity and cents by
     (invoice, product, EPA number, unit price), then writes one record per group. The duplicate check and
     its active-record index use that same group, with a blank EPA number counting as equal to another
     blank (`NULLS NOT DISTINCT`, or an equivalent normalized key), so a repeated run can't add a second
     record for a product with no EPA number; the duplicate-generation proof includes that case. Grouping by unit price keeps each record's unit price exact
     in whole cents. This applies to every line, branded or not, so it also closes today's duplicate-line
     gap; that is a deliberate behavior change, and the proof covers it. The unpost, void and re-post
     handling (PARKED-006, `:108-116`) is re-proved with the new grouping;
   - quantities are the delivered brand amounts, because the register records what physically went to the
     customer. If the invoice line's quantity was changed so it no longer matches the delivered amounts, the
     records use the invoice line's quantity divided across brands in the delivered proportion, with any
     remainder on the last brand, and the draft invoice shows a warning before posting;
   - the line's cents are divided the same way in exact whole cents, with the remainder on the last brand, so
     the records add up to the line's `extended_cents` exactly;
   - lines with no brand rows under that rule behave exactly as today.
8. **Editing a scheduled delivery** (PR B): the screen always sends the lines, even for a date or driver
   change (`src/pages/DeliveryDetail.tsx:688-696`), and `edit_delivery` deletes and re-creates every line
   (`20260611211058_idempotency_operation_scope_sweep.sql:1534`, `:1573-1586`). So `edit_delivery` is changed
   to keep the brand rows of every line whose order line, product and quantity didn't change, and to drop
   them only for changed lines, which the screen then flags for a new pick. Cancelled and voided deliveries
   keep their brand rows as history until `update_order_items` removes those deliveries' lines (its public
   function is `20260812115237_enforce_below_cost_admin_approval.sql:682`, which wraps the body at
   `20260617123503…:127-130`); the brand rows go with them, which is acceptable because nothing was delivered.
   Restoring a cancelled delivery (`restore_cancelled_delivery`, no screen calls it today) brings its picks
   back with it, still editable. Follow-up deliveries start with no brands, like any new delivery.

## 5. What changes on screen and on paper

- **Product page** (`src/pages/ProductDetail.tsx`): the Brands section (admin edits; everyone else reads),
  with the EPA lookup, name suggestions and copy-from-another-size.
- **Products page**: the "Brands to review" tab.
- **Delivery page** (both layouts) and **the driver's stop**: the brand picker, and the delivered-split
  question at completion. The edit screen flags lines whose pick was dropped.
- **Deliveries list** (`src/pages/Deliveries.tsx:480-540`): the plain refusal message on Mark Delivered.
- **Quick delivery** (`src/components/deliveries/QuickDeliveryModal.tsx`): no picker in step 1. A quick
  delivery is completed on its delivery page like any other, where the picker is.
- **Delivery receipt PDF** (`src/lib/deliveryPdf.ts`) and **every completion email**: under each line, each
  brand with its EPA number and amount. There are three email builders today:
  - `src/lib/deliveryCompletionEmail.ts`, sent from `src/pages/FieldStop.tsx:443`;
  - the delivery page's own completion email, built inline in `src/pages/DeliveryDetail.tsx`
    (`sendEmail` at `:1259`);
  - its resend button (`handleResendEmail`, `:1295`, sent at `:1348`).

  PR B moves all three onto the one helper, so the brand lines can't be missed on any of them. The proof
  covers both the first send and a resend.
- **Invoice PDF** (`src/lib/invoicePdf.ts`): the EPA column already prints `invoice_items.epa_registration`
  first; the brand names print under the line. **Invoice editing** (`src/pages/InvoiceDetail.tsx`) today
  clears a line's EPA number when the line is added or changed (`:818`, `:855`); it is changed to keep the
  stored number on a line made from a delivery, and it shows the typed-brand warning.
- **Admin settings**: the `delivery_brand_required` switch.
- **Statement and Compliance page**: no code change; they show the stored numbers and per-brand records.

## 6. Risks and how each is handled

| Risk | Handling |
|---|---|
| A wrong brand is picked (human error). Step 1 doesn't count stock by brand, so it can't catch a brand that isn't in the shed. | The picker offers only the product's currently sourced brands; every pick records who and when; an admin can correct it with a reason; step 2 adds the stock check. |
| A driver types a wrong EPA number for an unlisted brand. The EPA lookup is admin-only, so it isn't checked on the spot. | Typed brands go to the review list and the draft invoice warns before posting; the admin correction fixes the delivery. |
| A driver at the farm can't finish because a brand is missing. | The picker is on the completion screen and an unlisted brand can be typed in; completion is refused only with a message naming the line. |
| The database change goes live before the screens and every branded completion is refused. | The `delivery_brand_required` switch is off until the screens are live and proven. |
| An older completion queued offline replays after the switch is on and is refused. | Only for a listed-brand line; the office picks the brand on the delivery page and completes. New completions already need a signal (`src/pages/FieldStop.tsx:356`). |
| The RUP register drops a brand or a line, or its cents don't add up. | Lines are added up by invoice, product, EPA number and unit price before writing, instead of skipped; exact-cents division with the remainder on the last brand; both proven (section 8). |
| A wrong brand is found after the invoice is paid, when it can no longer be unposted. | The admin correction never unposts. It voids and rewrites that invoice's RUP records with the reason, and leaves the issued invoice as it was. |
| Writing invoice lines collides with the invoice-line locking work in flight on 2026-10-22 (branches `claude/cost-lock-on-postable-20261022` and `claude/invoice-version-by-id-20261022`). | Only a draft line's existing `epa_registration` is written, before posting. Re-check against whatever invoice locking is live when this is built, and land after it. |
| Changing the completion, invoice-creation and RUP functions, which sit on money paths. | No amount changes, but PR B gets the money review rules: a CodeRabbit full review plus the final Sol review. |
| A field-application, job or blend-ticket invoice for an RUP generic still records the generic's EPA number. | Known and stated (section 2, "Not in step 1"); noted by hand until those invoices are built. |

## 7. Built as two pull requests, each with its own migration

1. **PR A, brand list**: `product_brands`, `upsert_product_brand`, the Brands section with the EPA lookup,
   name suggestions and copy-from-another-size. Low risk; nothing reads it yet. Once it is live, Mason (or an
   agent preparing a list for him to check) can start entering brands for the 95 generics while PR B is built.
2. **PR B, delivery capture and paperwork**: everything else in sections 4 and 5. Its migration lands with
   the switch off; the switch goes on after the screens are live and proven.

## 8. Proof that step 1 works

Run on the staging system once it exists (To-Do 13.7); until then on a local copy of the database, plus a
look-only check on live after landing.

- An admin adds a brand and the EPA lookup shows its registered name; a rep and a driver are refused.
- A generic with one brand, switch on: completing without a pick is refused naming the line; after picking,
  the receipt (PDF and email) shows the brand and EPA number, the draft invoice line holds the number, and the
  invoice PDF and statement print it. Same for a **quick delivery completed in full**.
- A 30/15 split: both brands, numbers and amounts on the receipt. Delivered 40 instead of 45: the split sent
  with the completion is saved; amounts that don't add to 40 are refused; a line delivered at zero keeps no
  brand rows.
- The completion check sees the final delivered amounts (the case a status trigger would have missed).
- Switch off: the same completions succeed and record whatever was picked. A branded line completed with
  no pick gets no EPA number on its invoice line (never the generic's), its draft invoice warns, it appears
  on the report, and the admin correction fills it.
- Correcting one line of a posted invoice whose RUP record it shares with an unchanged line: after the
  rebuild, the unchanged line's quantity and cents are still in the register.
- An unlisted brand typed at delivery completes, shows on the review list, the draft invoice warns, and "Add
  to list" leaves the delivery's saved name and number unchanged.
- Changing a brand's EPA number afterwards leaves the old delivery and invoice unchanged. The admin correction
  changes the delivery, with its reason logged, for an invoice in each status:
  - draft: the invoice line's number changes;
  - posted, overdue and paid: the invoice is untouched, the old RUP records are voided with the reason, and
    corrected records are written. Reprinting that invoice still shows the original brand names and number.
- A product with no brands delivers, invoices and prints as before, except that its own EPA number now
  appears on the statement.
- A Roundup line refuses a Liberty brand; a driver not assigned to the delivery is refused; the same save
  repeated with the same retry key changes nothing, and the same key with a different request is refused.
- Changing only the date of a scheduled delivery keeps its picks; changing a line's quantity drops that line's
  pick only.
- Landlord split invoices and a whole-order invoice carry the delivered brands' numbers.
- One order line delivered in two trips with different brands, each trip billed on its own invoice: each
  invoice line and its RUP records show only that trip's brands and amounts.
- Posting an invoice for a split RUP line writes two RUP records with the right numbers, amounts and cents
  that add up exactly. Two lines of the same product and EPA number on one invoice produce one record with
  both lines' quantity and cents. Unposting, voiding and re-posting behaves as before.
- The new tables' grants and policies are checked directly (who can read, nobody can write), since an admin
  session can't reveal a missing grant (August C-25).

## 9. Where this differs from the August plan, and why

1. **Delivery first; receiving waits for step 2** (Mason, 2026-10-22, asking for step 1 to be "pick the brand
   at delivery, print it on paperwork"). The EPA number that matters on a regulated record is the one on what
   was delivered. August made receiving the required capture point (PRD 1.9a-i, D-13); that comes back in
   step 2 with stock by brand.
2. **No brand stock count, so no "brand not in stock" refusal** (August WP-3, P1). It needs receiving capture
   first. The risk is in section 6.
3. **One shape for every line.** August put a single-brand pair of columns on `delivery_items` plus
   allocation rows for splits, kept mutually exclusive. Rows for every line remove that rule and the chance of
   two disagreeing answers.
4. **Brand amounts stay matched to the line without a separate guard on `delivery_items`.** August required a
   check on every change to a line's quantity (blocker S-03), because four functions could move it. Today a
   line's quantity changes only in `edit_delivery` (while scheduled, handled in section 4, item 8) and its
   delivered amount only in completion (where the rule runs); cancel and void change neither. The builder
   re-checks this list before building.
5. **No unit conversion.** Brand amounts are in the line's own unit; August converted to a single unit.
6. **An unlisted brand at delivery carries its EPA number.** August D-K typed a name at receiving only.
7. **The typed entries are the review list.** No `product_label_drafts`-shaped queue (August D-I); the WP-1
   tables it depends on don't exist.
8. **Fewer brand columns.** `label_url`, `density_value` and `sourcing_tier` (August WP-3, C-43) wait for the
   steps that use them.
9. **No `product_data_version` counter** (August D-E belongs to WP-1). Each brand row has its own version.
10. **Who picks.** August assumed a crew role at the dock. There is none; the assigned driver, an admin or a
    rep picks.
11. **The August list of delivery functions is out of date.** It named four. Today: create
    (`20260518010000…:31`), quick delivery (`_create_quick_delivery_intent_impl_20260802`,
    `20260914100500…:2058`), edit, start (`confirm_delivery`, `20260430240000_field_app_workflow_phase12.sql:32`),
    complete, start-and-complete (PR #964), cancel, batch cancel, void, restore, follow-up
    (`20260526151856_execute_full_codebase_ultra_review.sql:1101`) and `update_order_items`.
12. **The August package order no longer holds for WP-3.** The loop ledger
    (`docs/loops/product-data-model-ledger.md`) says WP-1 to WP-5 apply in order. A banner on the August build
    plan now says WP-3 is replaced by this plan; the ledger itself is updated the next time that loop runs.

## 10. Size and order

About a day for PR A and several days for PR B, plus review rounds. To-Do row 2.8 sits in build-order tier 2
(delivering and billing). Mason's data entry runs in parallel: roughly 95 generics with two to four brands
each, entered once per pack size, so likely 300 or more brand rows, each with its EPA number.
