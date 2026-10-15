# Pricing history, cost tracking and quote pricing — next section of work

**Status: PLAN FINISHED 2026-10-14. NOT STARTED.** Every open question in section 5 has Mason's answer
(2026-10-14), and supplier-cost rollout and Early Bird are parked for a later, separate plan. Mason,
2026-10-14: "I don't want to start work I want to finish the plan and goal." Building starts only when Mason
says so in chat. Earlier (2026-10-13): "I dont want to start building anything but want to leave top of list
on to do this is next section of work."

**Decided so far** (all in `docs/manual/DECISION_LOG.md`):
- A sent quote's prices stay locked until the quote is accepted or expires (Mason, 2026-10-13).
- **A revised quote keeps its locked prices**, with an option to **update to today's prices** when the
  situation calls for it (Mason, 2026-10-14: "sent quotes should keep its locked prices unless updated in the
  revised version, but give option to update to todays prices aswell. depends on the situation"). Offer it
  **both per line and for the whole quote**, plus a **rewind** to see the last version quoted to the customer
  (Mason, 2026-10-14: "offer both options, and offer a rewind to see the last version quoted to customer").
- **Who sees what** (Mason, 2026-10-14). Sales reps see the last price we charged a customer ("yes they
  should see the last price we charged this customer"). **Price history stays admin-only** ("only admin can
  see the price hisotry"), which keeps the 2026-07-20 admin-only rule for cost history.
- **Price changes keep coming in through the downloadable/uploadable Excel workbook, as one full sheet.** No
  automatic reading of supplier PDFs for now (Mason, 2026-10-14). Prices arrive as supplier PDFs, emails and
  texts, "usually monthly but sometimes randomly in middle of month". His reason: the workbook gives control,
  visibility and accountability, and lets several agents review the numbers before anything is applied.
  Automatic reading "we can build this in future"; if it is, it only drafts a workbook for review and never
  changes prices. Each change downloads the entire sheet ("might aswell download entire sheet so is simple and
  that is all current pricing"). Inline price editing stays for one-off fixes ("keep inline edits for one-off
  fixes"). Mason asked for a Sol review of the workbook method (section 8).
- **Answers to the remaining open questions** (Mason, 2026-10-14, each picked from a recommended set):
  - **"Locked" means prices only.** Staff may still revise a sent quote's products, quantities and notes; its
    prices stay as sent unless someone picks "update to today's prices". There is no admin unlock that skips
    the re-send.
  - **A revision that changes any price must be re-sent** before it can become an order or be partly drawn;
    the order then uses the newly sent prices.
  - **Planned bookings and partly drawn quotes stay locked until staff close them**, since they never
    auto-expire.
  - **Expiry:** editing a sent quote no longer moves its expiry date; only a re-send sets a new one. After
    expiry a quote never re-prices on its own: it must be updated to today's prices and re-sent.
  - **If cost rises above a locked price before Convert:** honor the promised price, but Convert needs an
    admin's below-cost approval with a reason, recorded for review.
  - **Workbook warnings:** flag a price that moves more than 10% up or down, any price below cost, and any
    margin under the product's floor. A flagged row applies only after a ticked acknowledgement with a
    reason.
  - **Sales reps never see cost or margin.** Admins see both the quote-time cost and today's cost beside
    each quote line.
  - **Margin targets and floors are set per product,** with no company-wide default.
  - **Supplier-quote cost rollout and Early Bird committed prices are parked** for a later, separate plan.
  - **Field jobs from a never-sent planned quote stay as today:** they may be scheduled and billed at the
    draft's price. The sent-price rule applies once a quote has been sent.

**Iteration 2 (2026-10-14).** Merged the findings of three sessions ("CRX pricing updates and history",
"Missing pricing and cost tracking features" and the branch-cleanup session that wrote this draft), with a Codex
`gpt-6-luna` xhigh second opinion. The new material is in section 7; sections 4 and 5 are updated to match.
Section 8 adds a `gpt-6-sol` high review of the Excel workbook method, at Mason's request, with its findings
checked against source and the live database.

**Where this came from.** The 2026-10-13 GitHub branch cleanup ran two read-only reviews of all 185 old
branches for work worth reusing, led by Mason's question about "pricing history lookup and cost tracking on
products for quoting". The first review's report is summarized below; the branches that carry reusable
work are kept (see "Reusable work").

## 1. What the app already has (checked 2026-10-13)

| Capability | Where | State |
|---|---|---|
| Product cost and three tier sell prices, changed through a preview-then-apply path | Products page, "Pricing .xlsx" workbook; RPCs `preview_product_cost_basis_changes`, `apply_product_cost_basis_change_set` | Live. Used once (4 rows, 2026-08-18). |
| Cost change log | `cost_history` table, admin-only | Live, 33 rows (counted live 2026-10-13). It also stores tier sell-price changes (`old_tier1_price` … `new_tier3_price`), but no screen shows those. |
| Price-history chart on the product page | `src/components/products/ProductPriceHistory.tsx`, admin-only | Live. Shows supplier quotes, the chosen cost and purchase-order paid cost. Cost only, no sell prices. Per the salvage review the points are evenly spaced rather than placed by date, and most purchase-order points show "supplier unknown". |
| Supplier Pricing page and supplier evidence | `src/lib/supplierPricing.ts`, Supplier Pricing page | Live. Run once (Wells pilot, 10 products, 2026-07-21). The "use supplier evidence as the cost basis" switch is off; per the 2026-09-02 TODO check, 602 of 604 product costs are still the original setup load. |
| Cost frozen when a quote is saved | `quote_items.cost_at_quote_cents` | Live. |
| Order and invoice cost locked by the database | trigger `zz_crx_below_cost_order_items` overwrites any browser-sent cost with the locked product cost | Live; the trigger was confirmed enabled 2026-10-13. A claim that "the database accepts any cost sent from New Order" is wrong. |
| Quote SELL price frozen | — | **Not built.** Per two independent reviews on 2026-10-13 (read from `save_quote`'s live body, not exercised), every save, including Convert to Order, re-prices each line without a manual override to today's tier price. This is what Mason's 2026-10-13 decision changes. |

## 2. What is missing

1. **Sell-price lock on sent quotes** (decided; design open, see section 5).
2. **The quote screen's half of quote-time cost.** The database already keeps each line's quote-time cost
   and accepts line ids, but the screen never sends a line's id. So a quote holding the same product twice
   can't be saved again (recorded in `docs/manual/KNOWN_ISSUES.md` by the cleanup change). An existing quote
   first shows its frozen cost (the loader copies `quote_items.current_cost`, `QuoteBuilder.tsx` about lines
   1022-1061), but the first edit flips it to today's product cost when `recalcItem` runs (about lines
   1337-1406), so the margin jumps. The fix must keep the loaded frozen cost through recalculation.
3. **"What did we charge this customer before?"** inside the quote screen: the last **charged** price per
   customer and product, with date and tier, from the latest order and invoice lines. Reps see this (Mason,
   2026-10-14); an unaccepted quote is not a charged price, so it stays out of the rep view. For admins, a
   "last quoted" price must come from the latest sent `quote_versions.snapshot_data`, not `quote_items`,
   which holds the current, possibly re-priced line.
4. **Sell-price history on the product page**, and a real date axis on the existing chart.
5. **Cost freshness.** An "as of" date on cost, a stale-cost report, and wider use of supplier evidence.
6. **Per-product margin targets** and a below-the-floor warning.
7. **Named or seasonal price lists** ("Early Bird").
8. **Profitability reports on cost at time of sale.** The server report `get_profitability_report` is live
   but no screen calls it; the Reports page computes from stored order profit.

## 3. Reusable work (kept branches and recoverable documents)

Every pointer below was confirmed to exist on 2026-10-13. The branches are kept on GitHub until this plan
is built or the work is consciously dropped (Mason, 2026-10-13: "keep all of the branches you have in
question"). Each is also restorable from its closed PR page.

- **PR #397, `codex/pr389-coderabbit-fixes`** (the largest quote-pricing branch):
  - quote line identity and quote-time cost on screen: commits `dec5d3378`, `8e147f40d`, `b3d2bba0d`,
    `81240c6f3` (`src/pages/QuoteBuilder.tsx`, `src/lib/quoteCalc.ts` and tests);
  - Convert to Order without marking the quote accepted first: `dc4ad87fd`
    (`quoteConversionAtomicity.test.ts`). Warning: as written it breaks "Book as Order" from a draft, so
    the status handling must be redone;
  - profitability reports on the as-of-sale report: `d03a60fc9` (`src/pages/Reports.tsx`,
    `Reports.profitability.test.tsx`);
  - below-cost database tests (`scripts/smoke/smoke-below-cost-admin-wall.sql`,
    `scripts/smoke/smoke-below-cost-quote-lifecycle.sql`), written against August function signatures.
- **PR #350, `claude/pricing-audit-strategy-jym8rr`.** An earlier version of the line-identity screen code
  that installs the `item_ids` the database returns, plus August pricing notes. Its owner decisions are
  recorded by the cleanup change.
- **Deleted designs in main's history:**
  - Early Bird / seasonal price lists:
    `git show 842bcfccf:docs/plans/2026-02-23-price-list-versioning-design.md` (marked "future project").
    It has a business design and four open questions; its database plan must be redone under today's rules
    (money in whole cents, row-level security in the same migration).
  - Supplier pricing, price history and variants plan (rev 5):
    `git show a16925315^:docs/plans/2026-07-16-supplier-pricing-and-variants-plan.md`.
    - §3 and §5a hold the rule "show replacement cost, last paid and recent average beside each quote
      line", and note that about 80% of sales are quoted before any purchase order exists.
    - §6–§9 hold Mason's 2026-07-16/17/20 supplier-pricing decisions: no AI or automatic reading of
      supplier PDFs; imports never change sell prices; never merge the 163 variant products. These are not
      yet in `DECISION_LOG.md`, and the wording needs Mason's confirmation, because the plan says
      "parked" where other docs say "permanently retired".

**Not reusable (checked, so nobody re-litigates):** #397's three pricing migrations, which are identical to
live `20260812115235/6/7`; #397's draw-down owner restriction, which contradicts Mason's 2026-08-16 "any
rep" decision; the old `BelowCostConfirmModal` / `belowCostRpc.ts`, replaced on main; and the parked "New
Order cost" migration, made redundant by the live trigger.

**Third look at #397 and #350 (2026-10-14, read-only, `git show` against main 395bdcd9a).** #350 is fully
contained in #397. Neither branch locks quote sell prices, adds sell-price history, price lists or dated
prices, or makes the server compute order cost, so slices 2 and 4 are new work. The QuoteBuilder pieces above
must be rebuilt by hand, because main has changed `QuoteBuilder.tsx`, `NewOrder.tsx` and `Reports.tsx` since
the branch point. Two smaller #397 pieces are not in this plan's scope and are recorded only so they are not
lost: `20260814041419_fresh_below_cost_reason` (an old below-cost approval note can be reused as the reason;
approval still needs an active admin) and `20260814063000_quote_sections_rpc_owned` (drops the
`qsections_insert/update/delete` policies, which live still has).

## 4. Build path (finished; not started)

Small slices, each its own change. Building starts only when Mason says so; slices 7 and 9 are parked.

0. **Workbook hardening** (section 8, from the Sol review; can run alongside slices 1-2). It must include
   slice 4's per-acre history (or disable workbook edits to `rate_per_acre` and `rate_unit` until slice 4
   lands), because otherwise a rate-only workbook edit would satisfy "source and reason stored with history"
   while writing no history; its proof includes a rate-only edit. A "Download full
   price sheet" action that always exports every active product; outlier warnings for a move of more than 10%
   up or down and for a margin under the product's floor (slice 8; a product with no floor set skips only that
   check), added beside the existing below-cost warning (Mason, 2026-10-14); a required acknowledgement of every warning,
   **enforced by the apply RPC** (the preview stores the exact warning set and apply refuses a change set
   without a matching acknowledgement, so a stale or bypassed screen cannot skip it); the effective price per
   tier after fallback; required source and reason columns for changed rows, stored with history; and the
   uploaded file plus an approval receipt kept with the change set. Proof: a rolled-back database smoke test
   and a local run with fixture products, including one deliberate tenfold typo that must be flagged and
   refused until acknowledged. There is no staging database (`TODO.md`), so any apply on live products is a
   production change and needs Mason's explicit approval in the current conversation first.
1. **Quote line identity and quote-time cost on screen.** Rebuild by hand from #397's commits (main's
   QuoteBuilder has moved on). Do the money math in `src/lib/money.ts`. Re-picking the same product keeps the
   line's frozen cost; swapping to a different product starts fresh. Proof: save a quote with one product in
   two sections, edit it and save it again.
2. **Sell-price lock** (Mason's 2026-10-13 and 2026-10-14 decisions). Freeze each line's sell price when the
   quote is sent, the same way cost is frozen, and stop Convert to Order from re-pricing. Depends on slice 1.
   - Enforce it in the database, not only on screen: `save_quote` today checks only status *changes*, so a
     same-status save of a sent or accepted quote is accepted by the server (section 7, finding 2).
   - **Every route from a quote to something billable uses the sent prices** (Codex on PR #923, 2026-10-14).
     Start the slice by listing every such route; known so far are Convert, `draw_down_quote`, and
     `create_job_from_quote_section` (it accepts `revised` quotes and copies the live
     `quote_items.price_per_unit` into `job_chemicals`, which `transfer_job_to_invoice` later bills). Each
     route gets the re-send gate and a price-changing-revision proof.
     **Exception (Mason, 2026-10-14):** a field job may still be scheduled from a planned quote that was never
     sent, and billed at that draft's price, as today (`QuoteBuilder.tsx` allows scheduling a draft). The
     sent-price rule applies once a quote has been sent.
   - **Mason's lock rules (2026-10-14):** the lock covers prices only; staff can still revise products,
     quantities and notes. Planned bookings and partly drawn quotes stay locked until staff close them.
     Editing a sent quote no longer moves its expiry date (today every save resets it; see section 5); only a
     re-send sets a new date, and an expired quote must be updated to today's prices and re-sent, never
     re-priced on its own. If cost rises above a locked price, Convert honors the price but needs an admin's
     below-cost approval with a reason. Manual price overrides made before sending are part of the locked
     line and carry through unchanged. A below-cost approval made before sending stays on record, but it
     does not authorize a larger loss: when Convert or a draw-down finds the price below the cost at that
     moment, it needs a fresh, signed-in admin approval (the earlier reason may be reused as its text)
     (Codex on PR #926).
   - **Build details from review (Codex on PR #926):**
     - Expired quotes: `auto_expire_quotes()` sets `expired`, which `_enforce_quote_status_transition()` and
       `save_quote()` treat as final. "Update and re-send" therefore needs a renew route (a database
       transition from `expired` to `revised`, or a renew-as-copy), with an expired-to-sent proof.
     - Field jobs from a never-sent planned quote (the exception above): `transfer_job_to_invoice` takes no
       approval reason, so once cost rises above the draft price, `_enforce_below_cost_line` refuses the
       invoice line. At invoicing, `transfer_job_to_invoice` rechecks cost at that moment and needs a fresh
       admin approval with a reason whenever the line is below cost, for jobs from sent and never-sent quotes
       alike, with a cost-rise proof. An approval given at scheduling does not cover a later rise.
     - Changing the customer: a sent snapshot records its customer, and `save_quote` overwrites
       `quotes.customer_id` on a revision. A revision that changes the customer must be re-sent before it is
       billed, even if the prices match. The price authority compares customer as well as prices, with a
       customer-change proof.
   - A revision keeps the locked prices. Add an **"Update to today's prices"** action on a revised quote, both
     per line and for the whole quote, that shows each line's locked price beside today's price and applies
     only what the user picks.
   - **Price authority after a price change (CodeRabbit on PR #923).** A revision that changes any line's
     price (this update action, a manual price edit or a tier change) must be re-sent before Convert, and
     Convert then uses that newly sent version's prices. The customer is never billed a price they were not
     sent, and an update is never silently ignored. Revise-then-convert without a re-send (below) applies only
     to revisions that leave every price unchanged. The proof covers update-then-convert, refused until
     re-sent and then billed at the new prices.
   - **Rewind:** the quote screen already has Version History (`src/pages/QuoteBuilder.tsx`, about line 3604:
     "Every time you send or revise, a snapshot is saved. You can compare versions side-by-side or restore an
     older version"), backed by `quote_versions` and `restore_quote_version`. Build on it: make "the version
     last sent to the customer" one click away. Under the lock, a restored version must keep its own prices;
     today the next save re-prices restored lines to the catalog (from source).
   - Changing a quote's tier must not silently erase negotiated line prices (section 7, finding 3).
   - Codex's suggested shape (section 7, finding 10): the sent version is the price authority; Convert
     builds the order from that exact version.
   - A revised quote can be converted without being re-sent (`QuoteBuilder.tsx`, about line 597; the status
     map allows `revised` to `accepted`). That stays allowed only when every price is unchanged; Convert then
     builds from the current revision's products and quantities, taking the locked prices from the sent
     version. The proof includes revise-then-convert.
   - Structural edits on a revision break that matching: a newly added product has no price in the sent
     version, and `create_quote_version` snapshots `product_id` and price but not `quote_item_id`, so two
     lines of the same product cannot be told apart. Preferred fix: version snapshots carry `quote_item_id`,
     and Convert matches lines by it. Until they do, the conversion RPC refuses (and asks for a re-send)
     unless the current lines and the sent lines pair up one-to-one by product: the same number of lines,
     every sent line used exactly once, and no product on more than one line. That rules out any added,
     removed or swapped product and any duplicate, including duplicates already present when the quote was
     sent. The proof covers an added line, a removed line, a product
     swapped on an existing line, a duplicate added in the revision, and a quote sent with two differently
     priced lines of the same product followed by a quantity-only revision.
   - Line IDs are not stable today, so ID matching has a prerequisite (Codex on PRs #917 and #923, checked
     2026-10-14).
     - **Ordinary saves:** `_save_quote_below_cost_impl_20260810` keeps a line's `id` only when the save
       sends it, but the quote screen's save payload (`src/pages/QuoteBuilder.tsx`, about lines 1742-1764)
       sends neither `id` nor `client_key` and does not install the returned `item_ids`. So the screen's saves
       do not keep line identity, and a quote with two lines of the same product at different recorded costs
       is refused with `QUOTE_ITEM_AMBIGUOUS_COST`. Before ID matching, slice 2 must make the screen send each
       line's ID and install the returned IDs, with a proof that a duplicate-product quote saves cleanly.
     - **Rewinds:** `_restore_quote_version_owner_impl` deletes the quote's sections, which cascades to the
       lines, and re-inserts them without `id`, so every restored line gets a new ID. Under ID matching,
       rewinding to the sent version and then converting would be refused even though nothing changed.
       Restore must keep the snapshot's line IDs or record an old-to-new ID map that Convert uses.
     - **Older versions:** snapshots saved before slice 2 carry no line IDs (Codex on PR #923). Two kinds:
       - **Untrusted** (`restore_trusted_at` is null, from before the
         `20260826220000_quote_version_restore_trust_boundary` migration): the live restore refuses them with
         `QUOTE_VERSION_LEGACY_UNTRUSTED` before any matching runs, so they cannot be rewound at all; that
         quote must be re-sent. All 3 live versions were in this state on 2026-10-14.
       - **Trusted but without line IDs:** not backfilled. Restoring and converting one falls back to the
         one-to-one pairing by product above, which fails closed, so any duplicate product or other mismatch
         requires a re-send.
     - **Proof:** rewind-then-convert with and without a later quantity edit, a trusted pre-slice-2 version
       with and without a duplicate product, and an untrusted version that is refused and re-sent.
   - **Also required in slice 2** (Codex on PR #923, confirmed live 2026-10-14):
     - Partial draw-downs: `_draw_down_quote_below_cost_impl_20260810` accepts `revised` quotes and prices
       the new order from the current lines. The same re-send gate must apply there, with a proof that a
       price-changing revision cannot be partly drawn until it is re-sent.
     - Rewind stays unavailable for a booking that has ever been partly drawn:
       `_restore_quote_version_owner_impl` raises `QUOTE_RESTORE_BLOCKED_BY_DRAW`, an accepted invariant in
       `KNOWN_ISSUES.md`, even after the drawn orders are cancelled or voided. Slice 2 keeps this rule; replacing it
       would need its own design and proof, covering cancelled and voided draws.
   - Partly drawn quotes: `draw_down_quote` relies on stable `quote_item_id` provenance and the
     `units_current` / `units_settled` split so a price change never re-bills delivered product
     (`20260816120000_draw_down_split_order_lines_by_price_tier.sql`; invariant in `KNOWN_ISSUES.md`). The
     lock must be built in PostgreSQL and its proof must include a partial draw followed by a revision, not
     only a normal Convert.
3. **"Last charged" panel in the quote screen**, visible to sales reps (Mason, 2026-10-14). It needs a
   database read function, not a table read from the screen: `invoice_items_select` lets a rep see only
   invoices they created or are the salesperson on, so a customer last billed by another rep would show
   blank or wrong. The function deliberately returns, across reps, only the customer, product, unit price,
   tier and date. It must define what counts as a charge (posted, paid or overdue invoice lines; not draft,
   unposted or voided ones; how credits and returns are treated; whether an uninvoiced order line counts),
   and its proof covers those statuses and a rep reading another rep's customer. The tier at the time of
   sale is not stored on `orders`, `order_items` or `invoice_items`, and `customers.assigned_tier` can
   change, so new charges need a stored tier snapshot and older rows show the tier as unknown. Coordinate with the planned
   "reps see all invoices" change (`DECISION_LOG.md`, 2026-10-13).
4. **Sell-price history on the product page**, admin-only (Mason, 2026-10-14). A read function over
   the tier columns `cost_history` already stores; a real date axis on the chart; deleting a product refuses
   rather than erasing history. Add in the same slice:
   - a one-time **dated starting snapshot** of every product's current cost and tier prices, because 578 of
     604 products have no history row, so "what was the price on date X" has no answer before their first
     change (section 7, finding 4);
   - history for per-acre price changes, which today change the price but write no row (finding 5). A
     `cost_history` row alone is not enough, because its old and new per-unit prices can be identical while
     the per-acre price moved: store the old and new `rate_per_acre` and `rate_unit`, or the old and new
     per-acre prices in whole cents;
   - a required reason on each price change instead of the generic default (finding 6).
5. **Cost evidence beside each quote line** (admin only, hidden in Customer View and on PDFs). Show both the
   quote-time cost and today's cost side by side, so a locked quote that has lost margin is visible (Mason,
   2026-10-14). Sales reps never see cost or margin.
6. **Profitability reports on cost at time of sale** (independent; can go first). Copy #397's three report
   fetchers and its test. The numbers will change, because lines on deleted or cancelled orders drop out.
7. **Cost freshness. PARKED for a later, separate plan (Mason, 2026-10-14).** Widen supplier-evidence cost selection beyond the 10 pilot products and map the
   remaining purchase-order vendor names. Mostly data entry. Roll it out product by product (or vendor by
   vendor) through the `product_cost_basis_rollout` list, adding a product only once it has current
   supplier evidence. The global `supplier_cost_basis_enabled` setting switches it on for every product
   at once (`supabase/migrations/20260722064814_wells_cost_basis_rollout_gate.sql`), so it is the last
   step, after the rollout is complete. Both are live changes and need Mason's yes. This overlaps the
   TODO deadline item "test the pricing/repricing path before sales season".
8. **Margin targets and floor,** set per product with no company-wide default (Mason, 2026-10-14). The
   floor feeds slice 0's low-margin warning; a product without one skips only that warning.
9. **Early Bird price lists. PARKED for a later, separate plan (Mason, 2026-10-14).** From the deleted
   design; only after slice 2.

## 5. Open questions: all answered 2026-10-14

Every question below now has Mason's answer (2026-10-14), shown in **bold** after it and recorded in "Decided
so far" at the top and in `docs/manual/DECISION_LOG.md`. The questions stay for the record.

From Mason's sell-price-lock decision. Facts found by the second salvage pass, read from code and not
exercised:
- `main` today lets a sent quote be edited, which makes it `revised`. The status trigger, `save_quote`'s
  status rules and `docs/workflows/QUOTE_TO_DELIVERY.md` (about lines 28-66) all permit it.
- Convert to Order saves the quote again first (`src/pages/QuoteBuilder.tsx`, about lines 3053-3055), so a
  rebuilt Convert fix must not re-price a sent quote on the way to the order.

Questions:
- Does "locked" mean prices only, or no edits at all once a quote is sent? **Prices only.**
- When does "sent" start the lock? **Every send:** each sent version becomes the price authority, since a
  price-changing revision must be re-sent.
- Can an admin unlock a sent quote, and should that be recorded? **No unlock that skips the re-send.** Prices
  change only through "update to today's prices" in a revision, which is then re-sent.
- **Expiry already runs automatically, but not for every quote.** Checked live 2026-10-13: the cron job
  `auto-expire-quotes` (daily at 06:05 UTC) runs `auto_expire_quotes()`. It sets `sent` and `revised` quotes
  whose `expires_at` is before the current date to `expired` and releases their stock holds. It deliberately
  skips planned quotes (`is_planned`) and quotes with any partial draw-down, which staff close by hand. So
  under the lock decision, a planned or partly drawn quote would stay price-locked until someone closes it.
  - Should those quotes stay locked indefinitely, or does the lock need its own end? **Locked until staff
    close them.**
  - **Every save resets the expiry date** (read from code 2026-10-14, not exercised). The quote screen
    sends `expires_at` = the moment of the save plus `valid_days` on every save
    (`src/pages/QuoteBuilder.tsx`, about lines 1719-1722), and `save_quote` overwrites the stored date
    with it (`supabase/migrations/20260812115236_quote_items_cost_at_quote_snapshot.sql`, about lines
    907-908; the live `save_quote` wrapper from `20260812115237` calls that body). So editing or revising
    a sent quote today pushes its expiry, and with it any price lock, further out. **Change it: editing a
    sent quote keeps its expiry date; only a re-send sets a new one.**
  - Does a separate 30-day stale rule matter here? The review mentioned one. **None of the answers depend
    on it.** The slice 2 build confirms from source whether such a rule exists and, if it does, makes it
    follow the rules above.
  - After expiry, does the quote re-price on its next save, or must it be re-sent? **It must be updated to
    today's prices and re-sent; it never re-prices on its own.**
- What if cost rises above a locked price before conversion? The below-cost check uses today's cost, so
  converting a locked quote could be refused. **Honor the locked price; Convert needs an admin's below-cost
  approval with a reason, recorded for review.**
- ~~**What about a revision?**~~ **Answered 2026-10-14:** a revision keeps the locked prices, with an
  "update to today's prices" option, offered both per line and for the whole quote, plus a rewind to the
  version last quoted to the customer.
- What about manual price overrides and below-cost approvals on a locked line? **They are part of the locked
  line and carry through unchanged** (follows from "prices only").
- The cost side. Should quote-time cost also stay locked for the margin shown, given that the below-cost
  check today uses today's cost (a line can look profitable on screen and still be refused)? **Admins see
  both the quote-time cost and today's cost side by side; the Convert check uses today's cost with the admin
  approval above.**

Carried from the salvage review:
- ~~**(b) Visibility.**~~ **Answered 2026-10-14:** sales reps see the last price charged to a customer; price
  history (sell and cost) is admin-only.
- ~~**Other ways to change a price (section 8).**~~ **Answered 2026-10-14:** keep inline editing on the
  Products page and the product page's pricing card for one-off fixes (Mason: "keep inline edits for one-off
  fixes"). Slice 0's required source and reason should apply to them too.
- ~~**Outlier band.**~~ **Answered 2026-10-14:** flag a move of more than 10% up or down, any price below
  cost, and any margin under the product's floor; a flagged row applies only after a ticked acknowledgement
  with a reason.
- ~~**Price intake cadence.**~~ **Answered 2026-10-14:** download the entire sheet each time, monthly or
  mid-month. The export is valid for 7 days and a preview for 2 hours, so each change starts from a fresh
  export.
- ~~**(c) Which cost the quote screen shows.**~~ **Answered 2026-10-14:** both, side by side, for admins
  only. Sales reps never see cost or margin.
- ~~**(d) Supplier quotes.**~~ **Parked 2026-10-14** with slice 7, for a later, separate plan: who supplies
  fresh supplier quotes, the rollout order, and when to flip the global switch.
- ~~**(e) Margin targets.**~~ **Answered 2026-10-14:** one per product, no company-wide default.
- ~~**(f) Early Bird.**~~ **Parked 2026-10-14** with slice 9, for a later, separate plan, including what
  happens when a committed price is below today's cost.

## 6. Not verified yet

- No old branch code was run in a browser. Every screen behavior above is read from code and live function
  text.
- The quote re-pricing behavior was read from code by two reviews, not exercised.
- Live counts other than `cost_history` (33) and `quote_items` (20) come from the review agents' read-only
  queries.
- Iteration 2's live facts (section 7) come from read-only queries and live function definitions on
  2026-10-13/14; none of the behavior was exercised.

## 7. Iteration 2 findings (2026-10-14)

Evidence is live and read-only unless marked "from source". Nothing was built or changed.

**Why it looks like the app "went backwards".** Mason, 2026-10-13: "i am missing alot of pricing features and
historical cost tracking etc i thought we had at one point". Nothing pricing-related was dropped from the
database. The only feature removed is the old PDF/CSV `BulkPricingImport` with OCR (PR #163, 2026-07-18), by
Mason's July decision. The screens look empty because almost nothing feeds them:
- the last purchase order in CRX is dated 2026-06-10 (194 lines with a cost, 88 products), so the chart's
  "received PO cost" line stops in June;
- `supplier_price_observations` has 10 rows, all from 2026-07-21 (the Wells pilot);
- `cost_history` has 33 rows, only 2 since 2026-07-19;
- the price-history chart and cost history are admin-only.

**Findings**
1. **The Convert path is confirmed from live function bodies.** Accept runs `saveQuote('accepted')`; the
   live `save_quote` wrapper calls `_save_quote_below_cost_impl_20260810`, which re-prices every line without a
   `price_override` from the live tier price; the live `_convert_quote_to_order_owner_impl` then copies
   `qi.price_per_unit` into `order_items`. A price change between send and accept therefore reaches the order.
   The one exception is the already-accepted recovery path, which skips the save. Exposure today is nil: 4
   quotes live, none sent and waiting.
2. **The lock must live in the database.** `_save_quote_below_cost_impl_20260810` checks only status
   transitions, so a same-status save of a `sent` or `accepted` quote passes the server (owner or admin). The
   screen blocks it only through `canEdit = ['draft', 'revised']` (`src/pages/QuoteBuilder.tsx`, about line
   587).
3. **A tier change erases negotiated prices.** `recalcAllForTier` sets every line's `price_override` to null
   (`src/pages/QuoteBuilder.tsx`, about lines 1412-1417; from source). Related: `save_quote` never checks the
   quote's tier against `customers.assigned_tier` (`TODO.md`).
4. **History has no starting point for most products.** 578 of 604 products have no `cost_history` row, so
   history begins only at a product's first change.
5. **Per-acre price changes are not logged.** The live `write_product_pricing_history` trigger tests cost,
   tier margins, tier prices and gross margins only. A rate or unit change still moves the per-acre price and
   bumps `pricing_version` (`20260722091359_supplier_pricing_workbook_v2_product_info.sql`, about lines
   1002-1005 and 1047-1049; from source).
6. **The reason is effectively optional.** `costBasisRows` in `src/lib/productPricing.ts` fills a generic
   default ("Products list pricing update" and similar) when the reason is blank. Live: 1 of the 3 governed
   changes carries a generic reason.
7. **Deleting a product erases its history.** Live `cost_history.product_id` is `ON DELETE CASCADE`. Slice 4
   already covers this.
8. **No history gaps were found in the governed path.** Live `require_governed_product_pricing` rejects any
   cost, margin or tier-price write that is not marked by the governed RPC, and the history trigger writes a
   row for every marked change. The one product whose `cost_updated_date` is newer than its last history row
   is 0.13 seconds of clock difference on a seed product. History before 2026-07-18 was written by the old
   screen (`change_source = 'legacy_frontend'`, 30 rows), not by the trigger.
9. **Order cost is already server-owned (confirms section 3).** Live trigger `zz_crx_below_cost_order_items`
   (BEFORE INSERT, or UPDATE OF `product_id`, `price_per_unit`, `total_units_needed`; enabled) sets
   `cost_per_unit` and `cost_at_time_cents` from the locked product cost for `create_direct_order`,
   `bulk_import_order`, `update_order_items` and `price_order`. The parked
   `scripts/.staging-migrations/20260813010000_wave_a_order_cost_authority_and_finiteness.sql` is not needed for
   cost. Its NaN/Infinity checks were not re-checked here.
10. **Codex's suggested lock design** (advisory, `gpt-6-luna` xhigh): the sent version is the price authority;
    Convert builds the order from that exact version without re-pricing; re-sending sends the same version; a
    revision is a new editable version with a line-by-line price comparison and an explicit choice to apply
    today's prices; the database enforces all of it. Codex listed these edge cases: a tier change, a customer
    change, draw-downs (drawn quantities keep their prices), Convert, and re-send.
11. **Related, outside this plan.** Inventory is valued at today's `current_cost` times quantity, with no
    per-receipt cost (`docs/plans/2026-07-16-inventory-costing-plan.md`, parked). `issue_return_credit`
    reverses revenue but not cost of goods (known open item).

## 8. The Excel workbook method: Sol review (2026-10-14)

Mason asked for a Sol review of "how to update pricing" with the workbook. Advisory run: `gpt-6-sol` at
`high`, read-only, given this plan, the live facts and the workbook code (`src/lib/productPricingWorkbook.ts`,
`src/lib/productPricingSupplierEvidenceWorkbook.ts`, `src/pages/Products.tsx`, and the v2 export/preview/apply
SQL). It returned 30 findings. Each one below was checked against source and the live database; Sol's
"cannot verify" items were resolved where possible.

**Verdict.** The full-sheet workbook is a sound operating method for about 595 active products, three tiers and
one or two admins. It already proves which product and version each row belongs to. It cannot tell whether a
valid-looking number is wrong: a case price typed as a jug price, a 30-gallon quote on the 2.5-gallon row, or
$900 typed for $90. The method needs a tighter review step and a few small product changes, listed below.

**Already handled (checked):**
- **Formulas are rejected.** The upload marks any formula cell (`productPricingWorkbook.ts`, about lines
  680-697), and the live `preview_product_pricing_changes`, which the v2 preview calls, refuses any
  `pricing_worksheet` row with a formula.
- **Apply is all-or-nothing.** The live `apply_product_cost_basis_change_set` and
  `apply_product_pricing_change_set` have no exception handler, so any failure rolls back every row, the
  cost-basis rows and the history rows together.
- **A blank pricing mode cannot silently drop an edit.** The preview raises
  `WORKBOOK_BLANK_MODE_CHANGED_VALUES` ("Pricing values changed, but no pricing mode was selected for this
  row").
- **The preview already shows before and after.** `PricingChangePreviewModal.tsx` shows ready, unchanged,
  conflict and invalid counts, and for each row old and new cost, all three tier prices, margins and per-acre
  prices.
- **Concurrent edits are caught.** Row versions make a stale row a conflict rather than an overwrite.

**Real gaps (checked):**
1. **"Entire sheet" is not guaranteed.** The export takes the selected rows, or else every row passing the
   current Products-page filters (`Products.tsx`, about lines 517-521). A forgotten filter exports 40 products
   instead of 595. Fix: a separate "Download full price sheet" action that always exports every active product.
2. **No warning on suspicious jumps.** The preview already warns "this price is below cost"
   (`PricingChangePreviewModal.tsx`, about lines 190-231), but nothing flags a price that moved by more than
   a set percentage or a margin outside a normal band, and no warning has to be acknowledged. Fix: add the
   jump and margin warnings, and require acknowledgement of every warning, enforced by the apply RPC.
3. **Tier fallback is not shown.** A blank tier 2 or 3 price falls back to tier 1, and the preview shows the
   blank rather than the price those customers will actually pay. Fix: show the effective price per tier.
4. **No source per row.** The sheet has `change_reason` but no supplier, document date or effective date, and
   the reason defaults to a generic text when blank (section 7, finding 6). Fix: required source and reason
   columns for every changed row, stored with the history row.
5. **No record of what was reviewed and approved.** History records who applied and when, but not the
   reviewed file or the agents' exception reports. Fix: keep the uploaded file and an approval receipt with
   the change set.
6. **Product details ride along.** The v2 sheet also edits product information such as `rate_unit`, which
   changes per-acre pricing without a price-history row (section 7, finding 5).
7. **Units are the biggest human risk.** A supplier price per case entered as the CRX per-jug cost passes
   every check. The sheet shows supplier evidence and units only where supplier links exist (10 products
   today).

**Conflicts with other parts of this plan:**
- **The quote lock must come first (Sol's only BLOCKER).** Under today's code a mid-month workbook change
  re-prices every sent quote on its next save and on Convert (section 7, finding 1). **Rollout gate
  (CodeRabbit on PR #926):** slice 0 may be built alongside slices 1-2, but it is not switched on for live price
  changes until slice 2 is live and slice 8 has given products their margin floors (otherwise every product
  would skip the low-margin warning; Codex on PR #926). Until then the current workbook keeps working as today, and before applying a
  price change an admin checks the Quotes list for open sent or revised quotes that contain a changed product
  and handles them by hand, because those quotes will re-price.
- **Other ways to change a price still exist.** Inline editing on the Products page and the product page's
  pricing card change prices without the workbook's review. Mason keeps them for one-off fixes (2026-10-14).
- **Stale costs.** 600 of 602 cost bases are still the original load, so margins in the sheet are measured
  against old costs until supplier evidence is refreshed (slice 7 and the TODO deadline item).

**How a reviewing agent should work** (Sol's advice). The agent gets read-only copies of the final workbook,
each supplier PDF, email or text behind a changed row, and a changes-only report. For every changed row it
checks: supplier and document date, product and package, quoted unit and the conversion to the CRX unit, old
and new cost, pricing mode, all three resulting tier prices (with fallback), margin and per-acre result. It
returns a list of discrepancies with their sources, and never edits numbers or approves. A second agent can
recheck the arithmetic independently. Mason or an admin resolves every exception against the original
supplier message.

**Monthly / mid-month routine** (confirmed by Mason as written, 2026-10-14; it becomes the working checklist
once slice 0 is live, which waits for slices 2 and 8, as described in the rollout gate above):
1. Save the supplier message (PDF, email or text) and note its effective date.
2. Download a fresh full price sheet. Keep the original download unedited as the dated "before" record.
3. In a working copy, find the products the supplier changed, check the package and unit, enter the new
   cost or prices, the pricing mode, the source and the reason.
4. Have one or more agents review the changed rows against the supplier messages and return discrepancies
   only. Fix them.
5. Upload with "Review Pricing File". Approve only if the counts match what you changed, nothing is in
   conflict or invalid, and every warning is explained.
6. After applying, open two or three changed products and confirm the live prices. If the sheet or preview
   expired, or another admin changed a product, start again from a fresh download.
