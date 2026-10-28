# Completed to-do items removed — 2026-10-28

Mason requested removal of completed work and clarified: "if not fully complete leave it though". Priorities and existing row numbers are preserved.

## Current evidence and limits

Read all sections against current `origin/main` at `dd07615aa`, in an isolated checkout on 2026-10-28 (America/Chicago). Open PRs #1165 and #1167 were unrelated and were not treated as shipped. Read the live Supabase migration ledger, relevant definitions, policies, constraints and aggregate data. No business data changed. Rejected metadata queries were replaced by simpler read-only queries; an empty lookup for the wrong inventory function name was replaced with the actual live implementation. Neither was counted as a passing check.

| Removed row | Evidence checked |
|---|---|
| 0.12 | Mason explicitly closed the category remap on 2026-10-25. Applied ledger name: `20260702170000_p2_1_category_two_axis_remap`. Live category normalization function remains; all 595 active products have one of the 11 intended categories, none blank. |
| 0.13 | PR #1101 merged as `e55412c9a`; its before/after real-schema proof is recorded in the PR. Ledger `20261026142537` applies `20261025090000_inventory_holds_and_retired_on_order_guards`. The live `_get_inventory_position_cost_impl_20261019` includes retired products with incoming PO quantities and excludes them from reorder alerts. |
| 0.14 | The same applied migration fixes hold creation and adds the stuck-hold detectors. PR #1101 records real-schema proof. Live Q-2026-1994 is still cancelled and active inventory holds total zero, confirming the cleanup already approved and recorded in this row. |
| 0.16 | Mason explicitly closed duplicate-vendor merging on 2026-10-25. Live non-deleted vendor names have no normalized duplicates; product/PO names use `The Andersons` and `Van Diest Supply`, not the old variants. Other vendor-data leftovers remain in 15.4. |
| 3.8 | Ledger `20260921141423` applies `20260914100100_next_invoice_number_year_chicago`. Live `next_invoice_number` extracts its year in `America/Chicago`. Read-only year-boundary calculations give 2026 at 2027-01-01 01:00 UTC and 2027 at 06:00 UTC. No sequence was advanced. The broader rehearsal remains 12.2. |
| 11.1 | Ledger `20261015135505` applies `20261014220000_rup_register_admin_only`. The live register reader begins with `require_admin()`; that helper requires an active admin. The table SELECT policy requires `is_admin()`. Other RUP and role work remains open. |

## Original rows (history)

| # | What must work | Today (evidence) | Closed by | Rank |
|---|---|---|---|---|
| 0.12 | **Product category remap**, so pickers, reports and the price sheet group products the right way | **Done (Mason, 2026-10-25: "mark the category remap and the duplicate vendors marked done").** The remap shipped in July: migration `20260702170000` (P2-1, live 2026-07-03) folded the timing categories into Herbicide plus a `use_timing` tag, and the trigger `normalize_product_category` keeps the old names from coming back. Checked live (read-only) 2026-10-25: all 595 active products sit in 11 categories (Herbicide 267, Fungicide 58, Insecticide 56, Liquid Fertilizer 55, Foliar Fertilizer 51, Adjuvant 47, Seed Treatment 18, Dry Water Soluble Fertilizer 13, Other 12, Nitrogen Stabilizer 9, Biological 9), none blank. | Closed | SHOULD |
| 0.13 | A retired product that still has an open purchase order still counts as "on order" | **Fixed** by PR #1101 (2026-10-25, migration `20261025090000`, history row 983; applied live 2026-10-26). A retired product stays in the on-order view while it has stock on an open PO, and is never flagged for reorder. 0 such products on 2026-10-25. | Done | SHOULD |
| 0.14 | Stock holds that never release (a crop-program hold; holds on dead jobs) are cleared | **Cause fixed, detector added** by PR #1101 (2026-10-25, migration `20261025090000`, history row 983, applied live 2026-10-26): the public hold path makes manual holds only, and the daily integrity check alerts on a hold stuck on a dead job (`stuck_job_hold`) or with no live planned quote (`orphan_quote_hold`); both 0 on 2026-10-25, 0 job holds exist. The old holds are cleared: on 2026-10-26 at 10:19 AM Central Mason had planned draft quote Q-2026-1994 cancelled in the app ("Yes, cancel Q-2026-1994 in the app and confirm the 9 holds are released"), and `trg_release_holds_on_quote_status` released its 9 crop-program holds (about 1,234 units); checked live read-only the same morning: quote cancelled, 0 of its 9 holds active, 0 active holds system-wide. | Done | SHOULD |
| 0.16 | Merge duplicate vendor names, so the reorder list by vendor isn't split | **Done (Mason, 2026-10-25: "mark the category remap and the duplicate vendors marked done").** Checked live (read-only) 2026-10-25: no duplicate vendor names are left across the vendors list, products and purchase orders (the July merge packet's "The Anderson's" and "Van Deist" variants are gone), so nothing to merge. Small leftovers, fixable in the app: open PO-2026-0030 has the junk vendor name "we"; Palisade EC and Water W/ D-Chlorinator have a blank vendor; vendors "Agriselect LLC" and "Sharda International" appear only on purchase orders, not in the vendors list; and none of the 11 vendors had an email address at that check (not required for 0.15, which sends only to Mason). | Closed | SHOULD |
| 3.8 | Invoice numbers take Chicago's year | **Built.** Live 2026-09-21 (migration `20260914100100`). | Done | MUST |
| 11.1 | Only admins pull the restricted-use (RUP) sales register | **Built** (PR #927, migration `20261014220000`). | Done | MUST |

## Answered questions (history)

1. **ANSWERED: approved.** **Approve the ranking rule and the MUST list** (the "How each item is ranked" section and every row marked MUST). Recommend: approve them now, so the next ten weeks work from one list. The QuickBooks and payment contingencies (items 3 and 4) are a separate yes, after they're written and rehearsed.

7. **ANSWERED: yes, the small part.** **Cost freshness (0.7), parked on 2026-10-14.** With cost tracking now a priority, un-park it? Recommend **yes, the small part**: an "as of" date on each cost and a stale-cost report, so old costs are visible. The supplier-evidence rollout stays parked, because it's mostly data entry. Without this, the margin warnings in 0.1 compare against costs that are mostly still the original setup load.

13. **ANSWERED: SHOULD, for now** (Mason, 2026-10-22: "rank 2.8 as SHOULD for now"). **Rank 2.8 (the delivered brand and its EPA number) as MUST?** The recommendation was **yes**: without it, a restricted-use generic delivered on January 1 goes into the RUP register with the generic's EPA number instead of the jug's, a wrong regulated record, which is the MUST test. If yes, it joins the "code not built" MUST count.

## Work retained

Row 6.9 remains active: the earlier owner decision covers five completed deliveries, but completion of the whole deleted-order cleanup and prevention scope was not established. All other numbered rows remain, including built features still awaiting rollout, acceptance, staging, a real-phone check or owner sign-off. In particular, implementation alone did not justify removing 0.1–0.10, 1.2/1.3, 2.6, 5.1/5.2, 6.5, 9.5/9.9, 11.9/11.10 or 13.3. Outstanding goal-level or real-path proof was not established by this pass. Supplier-evidence rollout and other deferred work remain tracked. Answered question removal changes none of the approved priorities or scope.

This is a targeted completion cleanup, not a new full staging acceptance or a refresh of unrelated billing, backup, hiring or deployment statuses. Previous dates retain their historical meaning. Reverting this documentation PR restores the old list; no app or database rollback is needed.
