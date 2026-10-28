# Product data model refresh: weight per gallon first, then active ingredients

**Status: PLAN, 2026-10-28. NOT STARTED.** Mason, in chat, 2026-10-28, asked to refresh the August plan against today's code ("Yes, refresh it"). He then approved the recommended answers to the four questions in section 2 ("Yes, go with them"). Building starts only when Mason says so. To-Do row 2.9 (`docs/manual/TO_DO_LIST.md`).

**What this refreshes.** WP-1 (ingredients) and WP-2 (density, net weight, scale weight) of the August product data model: `docs/plans/2026-08-19-product-data-model-BUILD-PLAN.md` (authoritative design), with reasoning in `2026-08-18-product-data-model-MASTER-RECORD.md` and `2026-08-18-product-data-model-PRD.md`. Those documents keep the reasoning and the parts not listed here. **Where this file differs from them, this file wins.** WP-3 (brands) was already replaced by `docs/plans/2026-10-22-product-brands-step1-PLAN.md`. WP-0, WP-4 and WP-5 are unchanged except where section 4 says so.

**Code facts** were read from `main` at `c4889c386` on 2026-10-28 by a read-only review, and the load-bearing ones were re-checked by hand. Live row counts were not checked: every August count ("604 products", "11 blank forms", "ingredient_map 0 rows") needs re-confirming before the build. Re-check each fact before building.

**Words used below.**
- *Density* means a liquid's weight per gallon (lb/gal).
- *Net weight* is a dry package's weight.
- A *migration* is a reviewed database change.
- An *RPC* is a saved database operation that the app asks the database to run.

## 1. What the owner wants (Mason, 2026-10-28)

1. **Compare brands with the same chemistry.** Store each product's active ingredients and how strong they are, so products with the same actives can be compared.
2. **Know the weight when mixing.** Store pounds per gallon (and the net weight of dry products), so a blend ticket knows how much weight to add when a blend is scaled.
3. **Feed the generic-vs-brand mapping.** Brand step 1 is partly live: the `product_brands` table and the Brands section on the product page.

## 2. Owner decisions (Mason, 2026-10-28, "Yes, go with them")

| # | Question | Decision |
|---|---|---|
| Q1 | Priority | One To-Do row (2.9). **Density (WP-2) is built first**, ranked SHOULD, after the before-delivery tier. It moves up only if Mason says weight-based blending is needed for the 2027-01-01 pilot. |
| Q2 | Where the crew sees a weight | On the **job's loader worksheet and the blend ticket**, where the scale is used. The product-page readout alone does not meet goal 2. |
| Q3 | Brand-specific values | **One density and one ingredient list per generic** (its spec). Brand-level values wait until blend tickets record which brand was used. |
| Q4 | The comparison | **Admin-only, product against product** (for example Halex GT against the generics). It starts with **cost per lb of active**. "Per acre" is added after the rate correction (August Phase 2) ships. It doesn't compare brands under one generic, because cost stays one figure on the generic (DECISION_LOG 2026-10-22). |

**Engineering calls made on Mason's behalf (2026-10-28, from the recommended answers):**
- **Q5, proof.** The non-admin refusals are proven in the PostgreSQL Docker harness plus the live smoke-chain pattern (`scripts/smoke/prove-product-brands.mjs`). Mason's own admin session proves the app path. No deactivated test sales-rep login is reactivated.
- **Q6, data entry.** Density arrives through the reviewed workbook route (D-Z), because EPA has no density data. Chemistry starts from the EPA lookup for products with a valid EPA number (WP-4), with fast manual entry for the rest.

## 3. Build order: density first

**Why it can go first.** The scale-weight math needs none of WP-1. It needs only:
- `product_form`;
- the unit;
- density or net weight;
- the existing gallon/pound factors (`src/lib/chemCalculator.ts:381-444`, SQL `convert_to_gl_lb`).

No weight or blend code reads ingredients. The dependency actually runs the other way: a liquid whose EPA concentration is "% by weight" needs density before "lb of active per gallon" can be computed. So density first also unblocks goal 1.

**What changes to ship WP-2 before WP-1:**
1. **WP-2 creates its own concurrency counter and audit table.** The preferred design is a new one-to-one table beside `products` (like `product_brands`), not new `products` columns. A new table's lock-down counts as a routine grant under the migration access rules, while new grants or revokes on `products` are Mason-gated (section 4, item 2). Final choice at build time.
2. **Defer `commit_product_attribute_proposal`** (the queue-based density commit) until after WP-1's queue changes. WP-2 first ships a direct admin RPC.
3. **Move the B-11 proof to WP-1.** That proof is "a % w/w product converts to lb/gal via its density".
4. **Move `formulation_type`, `safener` and `nickname` to a later package.**
5. **WP-0's `product_form` classification is a real prerequisite.** `products.product_form` is nullable, and the weight math branches on liquid vs dry. Every product must be classified first.

**New order:** WP-0 (hygiene, including `product_form` and EPA format) → **WP-2 (density + weight on the loader worksheet and blend ticket)** → WP-1 (ingredients + fast entry + admin comparison) → WP-4 (EPA auto-seed) → WP-5 (copy-from-sibling). The ledger `docs/loops/product-data-model-ledger.md` still shows the August order. Update it when the build starts; its folder isn't covered by the documentation-only exemption.

## 4. Corrections to the August plan

Each item gives where it is in the August build plan (`BUILD-PLAN`), today's evidence, and what the build must now do.

1. **New `products` columns need read grants too** (R-3, PRD 1.17).
   - Since 2026-10-25, `products` is column-carved for reads as well as writes (`20261022101000_cost_columns_admin_only.sql`; `docs/reference/gotchas.md`).
   - A test enforces it (`src/lib/costFields.test.ts`): each new column needs `SELECT` and `REFERENCES` for `authenticated`, and an entry in `PRODUCT_COLUMNS` (`src/lib/costFields.ts:34`).
   - As written, the August plan would make density unreadable by the app. This doesn't apply if density goes in a new table (section 3, item 1).
2. **The apply gates have changed** (WP-1/WP-2 gates, D-U).
   - The autonomous-landing rule (2026-09-26) applies routine migrations without an in-chat ask.
   - The migration access rules (`.claude/hooks/migration-access-lib.mjs`) still class these as Mason-gated:
     - any GRANT/REVOKE on an object the migration didn't create (such as `products` columns);
     - any policy change on an existing table (such as `product_label_drafts`).
   - Apply through `scripts/apply-migration-file.mjs`, before merge; the MCP `apply_migration` path is dead. Follow `.claude/commands/ship.md` for the coordinator stamp, the history row and the post-apply `npm run db-sweeps`.
3. **Retry safety follows the current pattern** (D-E, "p_idempotency_key on every mutating RPC").
   - Copy `20261022086500_product_brands.sql:162-269` exactly. It refuses a NULL key and fingerprints the request with `_replay_fingerprint_20261015`. It looks up replays with `check_idempotency_intent` and binds the receipt with `_bind_replay_receipt_20261015`. The file also carries the `idempotency-body-check: exempt` header.
   - The August key-only pattern (KI-10) is not acceptable. WP-1's re-emission of `commit_label_draft` must be brought up to this pattern too.
4. **Who can write** (D-J).
   - New tables follow the `product_brands` lock-down (`20261022086500:115-125`):
     - no direct write for any role;
     - read via `is_active_profile()`;
     - writes only through admin-checked `SECURITY DEFINER` RPCs that check authorization before the replay lookup.
   - Admin-write RLS policies are not the mechanism.
5. **Remove the brand-proposal parts from WP-1** (`BUILD-PLAN` lines ~254-266, ~795-820).
   - This means `brand_proposal`, `proposed_brand_name` and `commit_brand_proposal`.
   - `product_brands` already has its single writer, `upsert_product_brand`, with a per-row `row_version`. Typed brands are reviewed from delivery capture (step-1 plan §9). A second writer would collide.
   - Also, `approved` (line ~810) is not a legal queue status.
6. **The concurrency counter covers chemistry and density only** (D-E). Brand edits use `product_brands.row_version` and don't touch `products`.
7. **The brand density slot has no owner** (WP-2 lines ~383-389; line ~1427).
   - `product_brands` has no density column, and the step-1 plan deferred brand density.
   - No blend ticket, job or loader sheet records a brand today: `blend_ticket_products` has only `lot_number`.
   - WP-2 ships spec plus measured density only (consistent with Q3).
8. **Registration status and label belong to an EPA number, not the generic** (WP-1's `epa_product_status`, `epa_is_cancelled`, `label_url` and `label_accepted_date` on `products`).
   - A generic now has several EPA numbers, one per `product_brands` row.
   - Store these per EPA number: on the brand row, or in a small per-registration table.
   - D-Z must say which EPA number counts for a branded generic.
9. **Format-check `products.epa_registration` in WP-0** (the same check the brand form has, `20261022086500:178-181`). Otherwise a wrong but non-blank number routes a product to an auto-seed that fails. See backlog item 22 (`2026-10-28-product-master-setup-edits-BACKLOG.md`).
10. **Weight must reach the mixing screens** (WP-2 lines ~333-338).
    - WP-2's scope now includes the loader worksheet and the blend ticket (Q2).
    - The blend and loading math lives in:
      - `src/lib/loaderWorksheet.ts`;
      - `src/lib/masterMixSummaryData.ts`;
      - `src/lib/blendMathValidator.ts` (today it marks mixed liquid/dry totals "unchecked" for lack of a density);
      - `BlendTicketDetail.tsx` and `ManualTicketCreate.tsx`;
      - `src/lib/recipeHelpers.ts`.
    - None of these reads a weight today. A missing density refuses with the product named (R-6).
11. **The target dates are replaced** (D-V, D-Y; the ≈2026-09-18 comparison target). The order now follows To-Do row 2.9 and section 3.
12. **The cost comparison is admin-only** (August Phase 3, "your cost and the customer price").
    - `current_cost` is read-revoked for non-admins (DECISION_LOG 2026-10-15, 2026-10-28).
    - The comparison shows cost per lb of active to admins only (Q4).
13. **Chemistry and density get their own audit table** ("follows the `cost_history` precedent"). It is readable by every active user (D-J). `cost_history` is now admin-only and is never written to by this work.
14. **Proof uses the harness, not the browser test suite** (R-2 and the proof-account prerequisite). The Playwright job is disabled (`.github/workflows/ci.yml`, `if: false`). Proof follows Q5.
15. **Reviews and gates follow today's `ship.md`** (§1 blockers and reviewer names).
    - Builder `gpt-6-sol` at xhigh for database work.
    - Iterating reviews `gpt-6-luna` at xhigh.
    - Final gate `gpt-6-sol` at high, exact-SHA, last.
    - CodeRabbit only if the PR touches money or cost; editing `ProductDetail.tsx` may trip the money-path check.
    - Keep R-12 (fresh backup before apply) as a plan-specific extra.
    - The "Opus 5 checkpoint" is gone.
16. **Stale line references.**
    - `ProductDetail.tsx:436` → `:415-420`.
    - PRD 1.13's `src/types/index.ts:130-131` → `:136-137`.
    - PRD 1.15's `Products.tsx:862` → `:1147`.
    - The ingredient section goes next to the Brands section (`ProductDetail.tsx:1432`).
17. **The EPA preview on `ProductDetail.tsx:909` calls `create_label_draft` with no purpose.** It is a second caller, beside `LabelReview` and `bulk_create_label_drafts`. Its drafts will default to `manual`; WP-1 decides whether to tag them `epa`.
18. **`product_label_drafts` still has its August direct admin write policies** (`20260629210000:70-115`). Changing them is Mason-gated (item 2).

## 5. New risks and gaps

1. **Name the RPCs.** Name WP-1's editor write RPC and WP-2's density RPC.
   - WP-1's editor resolves or creates rows in the shared `active_ingredients` list, so the duplicate-ingredient race (D-AA) exists in WP-1 itself.
   - Prove D-AA through the WP-1 editor RPC.
2. **Product forms beyond liquid and dry.** `product_form` allows only `liquid`/`dry`. Seed, biologicals and "each" items have no path (backlog item 33). WP-0 decides how they are handled; the weight math refuses them.
3. **Net weight overlaps existing fields.**
   - For dry products whose inventory or container unit is already a weight, the weight is derivable today. Net weight is needed only for package units (bag, each).
   - WP-2 must reconcile `net_weight_*` with `container_size`, `container_unit` and `unit_size` (backlog items 13, 14, 16), so two pack weights can't disagree.
4. **"Per acre" needs trusted rates.** The August Phase 2 rate correction is unbuilt. Cost per lb of active, with no rate, needs only WP-1, cost and (for % w/w liquids) density.
5. **Generics multiply entry by pack size.** One chemistry is entered on each pack-size row.
   - `ProductBrandsSection` already has "copy from another size".
   - WP-1 should pull that pattern forward from WP-5 for chemistry and density, or the fast-entry goal (D-N) is lost.
6. **Retiring `ingredient_map` deletes data.** It also duplicates the brand-to-generic link that `product_brands` now holds. Retiring it is a destructive change: it needs Mason's explicit approval at the time, and is not part of this plan.
7. **Cancelled registrations now apply per brand** (D-T). A cancelled brand EPA number should warn at the delivery brand pick (step-1 PR B), not only on the quote. Neither plan covers this yet.
8. **Another route changes EPA data.** `LabelDataQuality.tsx` writes `products.epa_registration` and `signal_word` directly. List it as a route that changes the EPA number; the `source_epa_registration` design already covers it.
9. **The product page's save uses `pricing_version` as its compare-and-set** (`ProductDetail.tsx:419`). Any new direct-write field inherits that, not `product_data_version`. That is acceptable but should be stated.

## 6. Prerequisites from the Product Master backlog

Fix these before or with WP-0 (`docs/plans/2026-10-28-product-master-setup-edits-BACKLOG.md`):
- **14:** changing Product Form wipes units unevenly;
- **16:** the hidden "Unit" field;
- **22:** EPA numbers aren't format-checked;
- **33:** no product forms beyond liquid and dry.

Bad product setup breaks the weight math.
