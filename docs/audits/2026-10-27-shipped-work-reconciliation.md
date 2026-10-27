# Shipped-work reconciliation — 2026-10-27

## Scope and evidence

Read-only comparison of all **68 merged PRs** returned by `gh pr list --state merged --search "merged:2026-10-25..2026-10-27" --limit 150`, against `origin/main` / `HEAD` `fe258c2fe85376cdbc6bc34518d65a0cbd379586`. GitHub's query dates are UTC; every returned merge is also on October 25–27 in America/Chicago. The query was below its 150-result cap. Open PRs are excluded.

This is a shipment-to-document reconciliation, not a rerun of all 68 PRs' product tests. Merge metadata, affected source and existing proof records were compared for closure candidates. Live apply claims below were checked against Supabase project `rhyzpcqhnizqbxphqdkr` using read-only `list_migrations`. A ledger entry proves apply history; it does not independently prove current UI behavior or a later-unmodified function body. Historical browser/test observations are attributed to their PR, not presented as observations made in this audit.

## Changes to the working lists

- Updated To-Do 0.1, 0.2, 0.3, 0.6, 0.7, 0.15, 0.16, 9.9 and 11.3. Removed obsolete October 23 aggregate counts and the false headline that pricing/quote locking had not started; retained the January proof requirements.
- Closed KI-15 only: current `src/pages/Reports.tsx` calls `get_profitability_report` for the three profitability groupings (PR #1134). Archived the original entry and closure evidence.
- Narrowed KI-30: completed vendor-name/category work is not pending, but business-data cleanup remains.
- Closed KI-47's batch-wide E2E-marker sub-item after independent review checked the current per-write classifier: every INSERT row needs its own literal marker, UPDATE/DELETE their own top-level WHERE predicate. Other KI-47 risks remain. Narrowed KI-52's read-side false positives and KI-72's PO PDF status.
- Receipt names (9.9) are escaped in `src/lib/deliveryReceiptEmail.ts`; delivery completion/resend and Field Mode use the shared builder (PR #1085).
- Did not close 1.10: comma-safe database searches (#1085) are different from CSV parsing.
- Did not close 3.6: #1099 explains hidden rep invoice totals; it does not grant full-customer balance visibility.
- Did not close KI-16: #1079 fixes selling-price rounding, not converted chemical cost.
- Did not close KI-84 or the different return-policy concurrency prover: #1110 repairs three specifically named provers.
- Did not close field assignment-expiry, cost-function exposure audit, invoice quantity/void/split gaps, deferred smoke checks, staging, recovery, bookkeeper approval or staff drills.

## Live ledger observed

| Authored purpose | Live name | Ledger version |
|---|---|---|
| bulk po fingerprint ignores cost | `20261022100000_bulk_po_fingerprint_ignores_cost` | `20261025182356` |
| cost columns admin only | `20261022101000_cost_columns_admin_only` | `20261025223447` |
| field functions require field access | `20261023090000_field_functions_require_field_access` | `20261026021016` |
| revoke load recipe into job app access | `20261023100000_revoke_load_recipe_into_job_app_access` | `20261026030708` |
| inventory holds and retired on order guards | `20261025090000_inventory_holds_and_retired_on_order_guards` | `20261026142537` |
| product margin floors | `20261025210000_product_margin_floors` | `20261026214418` |
| field tables follow field access | `20261026050000_field_tables_follow_field_access` | `20261027020546` |
| product price history starting snapshot | `20261026140000_product_price_history_starting_snapshot` | `20261027044721` |
| customer credit exposure | `20261027030000_customer_credit_exposure` | `20261027093945` |
| quote sent price lock | `20261027040000_quote_sent_price_lock` | `20261027123725` |
| price sheet warnings and approval | `20261027050000_price_sheet_warnings_and_approval` | `20261027144628` |
| last charged prices | `20261027060000_last_charged_prices` | `20261027160349` |

The last-charged-price shipped file is `supabase/migrations/20261027045000_last_charged_prices.sql`; its live name remains `20261027060000_last_charged_prices`. Match purpose and reviewed record, not numeric filename ordering alone.

The PO enum migration `20261027070000_email_type_purchase_order` was **not in this ledger**. No migration, service deployment, live-data cleanup or floor-value change was performed by this audit.

## Other sessions and overlap

Open #1148 carries overlapping records for 0.1/0.6/0.7. Open #1153 carries overlapping last-charged-price records. Open #1154 is now limited to the registry rebuild and related cost-field/type classifications; it no longer edits the working lists. None of those open PRs is shipped evidence. Only the overlapping working-list records in #1148/#1153 need reconciliation with this update before landing. PR #1147 merged during this audit; its PO-email snapshot/retry fixes are included, with the email deployment still pending. Open #1151 contains a dashboard reminder fix, #1152 hold-latch narrowing and #1149 organization-address support. Those open PRs are not credited as completed here. This audit does not edit or close another session's PR.

## Every merged PR and its disposition

The title records what shipped; the disposition records whether that shipment closes an existing working-list item. Supporting source/proof records are on the linked PRs.

| PR | Shipped work | Documentation disposition |
|---|---|---|
| [#1058](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1058) | fix(po-import): an admin re-importing a rep's vendor invoice gets already_imported (migration 20261022100000, row 978, not applied) | Bulk-PO fingerprint retry fix applied; import/search/stock work not generally closed. |
| [#1065](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1065) | fix(security): field functions require field access (row 11.4 part A, migration 20261023090000) | 11.4 part A applied; parts B/C distinguished. |
| [#1070](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1070) | docs(migrations): record 20261022086000 as applied live (row 979, PR #1066) | Team-board migration record; not all team-board visibility/assignment work. |
| [#1078](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1078) | fix(quotes): a stated 0-dollar tier-2/3 price stays 0 on quotes (#1060 follow-up) | Explicit zero quote tiers preserved; general quote integer-cent math remains open. |
| [#1079](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1079) | fix(jobs): never bill a chemical price rounded during unit conversion | Chemical selling-price conversion fixed; KI-16 converted-cost rounding remains. |
| [#1080](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1080) | feat(security): remove app access to the unused load_recipe_into_job RPC (migration 20261023100000, not applied) | Unused load_recipe_into_job app access removed and apply confirmed. |
| [#1083](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1083) | fix(guards): ordinary native apply_patch edits no longer read as shell commands | Native patch routing repaired; outside-repository boundary still enforced. |
| [#1084](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1084) | fix(guards): close three harness safety holes and cut guard noise (harness cleanup PR 1) | Guard safety/noise fixes; KI-45 known frames fixed but provenance residual/open #1152 retained. |
| [#1085](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1085) | fix: four readability-report defects (receipt email escaping, comma searches, invoice PDF line read, delivery route key) | 9.9 escaped receipt names closed; comma search/PDF/route fixes noted; CSV 1.10 remains distinct. |
| [#1086](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1086) | fix(purchasing-inventory-receiving): a failed load says it could not be loaded (To-Do 10.5, third money PR) | 10.5 purchasing/inventory/receiving batch already recorded. |
| [#1087](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1087) | fix(deps): patch undici, fast-uri and serialize-javascript so the CI security audit passes | Dependency audit repair; no product completion row. |
| [#1088](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1088) | feat(guards): Sol refuses a head that does not contain origin/main | Review-base gate change; later merge-base policy handled by #1136. |
| [#1089](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1089) | fix(security): cost, profit and margin columns admin-only on the remaining cost tables (Goal 1 step 3; migration 20261022101000, not applied) | 11.3 table locks applied; indirect function audit remains. |
| [#1090](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1090) | chore(cleanup): drop loadSheetPdf from the audit prompt and regenerate deno.lock | Dead load-sheet audit reference/lock cleanup; not broader print backlog. |
| [#1091](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1091) | docs(migrations): record 20261022100000 as applied live (row 978, PR #1058) | Bulk-PO reimport apply verified; not spreadsheet CSV parsing 1.10. |
| [#1092](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1092) | fix(guards): live smoke runs work again — allow verified rollback-only batches | Verified rollback-only SQL allowed; not permission for persistent live writes. |
| [#1093](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1093) | fix(guards): judge the [E2E] fake-data tag per write, from its own WHERE (#1084 follow-up) | KI-47 batch-wide exemption sub-item closed; all INSERT/UPDATE/DELETE exceptions are per write. Other KI-47 risks remain. |
| [#1094](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1094) | docs(migrations): record 20261022101000 cost lock as applied live (row 977, PR #1089) | Cost-lock apply verified; 11.3 status corrected. |
| [#1095](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1095) | fix(invoices): refuse empty-line invoice PDFs on the list, email and batch paths (B3 follow-up) | Empty-line PDF failure fixed; no closure of unrelated PDF layout KI-39. |
| [#1096](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1096) | docs(migrations): record 20261023090000 field functions as applied live (row 980, PR #1065) | 11.4 part A apply already recorded. |
| [#1097](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1097) | docs(migrations): record 20261023100000 as applied live (row 982, PR #1080) | Unused recipe RPC revoke applied; function-audit remainder remains. |
| [#1098](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1098) | feat(memory-backup): back up the memory archive; move agent-memory traps into gotchas | Agent-memory backup expanded; not database restore/PITR/staging. |
| [#1099](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1099) | fix(orders): reps no longer see $0.00 invoiced/paid on orders billed by the office | Rep order totals now disclose hidden invoices; does not deliver full-customer balance scope 3.6. |
| [#1100](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1100) | docs(todo): close rows 0.12 and 0.16; record live evidence for 0.8 and 0.10 | 0.12/0.16 already closed; KI-30 now consistent. |
| [#1101](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1101) | feat(inventory): retired products stay on order; stuck holds refused and reported; product deletes keep holds (To-Do 0.13, 0.14, 6.9) | 0.13/0.14/6.9 protections applied; existing business cleanup remains scoped. |
| [#1102](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1102) | feat(pricing): margin floor per product (To-Do 0.2, migration 20261025210000) | 0.2 schema applied; live floor values and deferred smoke remain. |
| [#1103](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1103) | fix(security): field tables follow field access (row 11.4 part B, migration 20261026050000, not applied) | 11.4 part B applied; assignment-expiry and opposite-route gaps remain. |
| [#1104](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1104) | fix(invoices): the invoice editors say a failed load could not be loaded (To-Do 10.5, fourth money PR) | 10.5 invoice-editor batch already recorded. |
| [#1105](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1105) | feat(quotes): a sent quote keeps the prices the customer saw (To-Do 1.2, 1.3, 0.5) | 1.2/1.3/0.5 already updated; KI-81/KI-82 remain. |
| [#1106](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1106) | test(smoke): the last three smoke chains EXECUTE only literals, so the live-data guard allows them | Smoke SQL guard compatibility; does not establish every pending smoke passed. |
| [#1110](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1110) | test(smoke): three container provers run and pass on current main again | Three named provers repaired; KI-84 and different return-policy prover remain open. |
| [#1111](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1111) | docs: record migration 983 (inventory holds guards) applied live; refresh schema registry | 0.13/0.14/6.9 apply already recorded; live ledger reconfirmed. |
| [#1112](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1112) | fix(build): upload source maps to the real Sentry org (crop-rx-solutions) | Sentry source-map destination fixed; not Edge Function alerting KI-38. |
| [#1113](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1113) | docs(migrations): record cost-lock post-apply live smoke PASS (row 977, PR #1089) | Cost-lock post-apply proof recorded; 11.3 table-lock status corrected. |
| [#1114](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1114) | feat(purchasing): purchase order PDF and emailed PO copy (To-Do 0.15) | 0.15 PDF merged; enum apply and service deploy remain open; #1147 fixes merged. |
| [#1115](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1115) | fix(invoices, orders): invoice lists and Order Detail say a failed load could not be loaded (To-Do 10.5, fifth money PR) | 10.5 invoice lists/order detail batch already recorded; partial row retained. |
| [#1116](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1116) | docs(manual): Convert to Order hold gap also hits December pre-bookings (KI-12, To-Do 1.3) | KI-12 explanatory record; cause fixed by #1105, real orphan quote still pending. |
| [#1117](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1117) | chore(agents): lean AGENTS.md + code-health ratchet (size, complexity, unused code) | Shared guidance/code-health changes; broad hygiene backlog remains. |
| [#1118](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1118) | chore(deps): bump lucide-react to 1.61.0 and typescript-eslint to 8.72.0 (replaces #1107) | Icon/lint dependencies upgraded; no business row closed. |
| [#1119](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1119) | feat(pricing): last charged price per customer on the quote screen (To-Do 0.3, migration 20261027045000) | 0.3 merged and applied; authored filename/live name distinction recorded. |
| [#1120](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1120) | chore(deps): bump jsdom to 30.0.0 (re-delivers #1108) | jsdom upgrade; not a to-do business feature. |
| [#1121](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1121) | chore(deps): upgrade Vite to 8 with @vitejs/plugin-react 6 (re-delivers #1109) | Vite/plugin upgrade; not a to-do business feature. |
| [#1122](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1122) | feat(products): admin-only sell-price history with a dated starting point (To-Do 0.4) | 0.4 already recorded; live ledger reconfirmed. |
| [#1123](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1123) | chore(code-health): drop 21 grandfathered unused exports | Unused exports removed; broader engineering hygiene remains. |
| [#1124](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1124) | fix(pwa): stop the service worker fetching Google Fonts (CSP blocked them) | Font/CSP request fix; not the remaining offline-recovery work. |
| [#1125](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1125) | feat(coderabbit): one review per PR — narrow fixes for a minor-only review keep it | Review-process change; no product completion row. |
| [#1126](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1126) | chore(deps): upgrade Vitest to 5 so jsdom 30.1.x works; unpin jsdom | Test dependency upgrade; no user-facing completion claim. |
| [#1127](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1127) | docs(plans): quoting flexibility brainstorm from 2026 sheet quotes | Unranked quoting brainstorm retained; not an implemented feature. |
| [#1129](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1129) | docs(pricing): record margin floors live (row 984, To-Do 0.2) + registry refresh | 0.2 already live; updated cross-reference to 0.1. |
| [#1130](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1130) | fix(sweeps): quote-versions read-path check matches the cost-column lock | Predicate follows cost-column view; not all cost-function audit work. |
| [#1131](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1131) | feat(pricing): the price sheet is safe to use (To-Do 0.1, migration 20261027050000) | 0.1 merged and apply verified; floors/rollout proofs retained. |
| [#1132](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1132) | fix(invoices): RUP, credit-limit and invoice-PDF checks stop when they cannot read their data (To-Do 10.5, sixth money PR) | 10.5 batch already recorded; 10.6–10.9 retained. |
| [#1133](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1133) | feat(pricing): cost as-of date and stale-cost report (To-Do 0.7) | 0.7 small approved scope built; supplier-evidence rollout remains parked. |
| [#1134](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1134) | feat(reports): profitability tabs use cost at time of sale (To-Do 0.6) | 0.6 built; KI-15 removed from open list and archived. |
| [#1135](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1135) | docs(field-access): record row 11.4 part B applied live (row 985, PR #1103) | 11.4 part B already recorded; part C remains. |
| [#1136](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1136) | feat(guards): merge gates accept a pull request that is behind main | Merge-policy tooling; not product functionality. |
| [#1137](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1137) | docs(known-issues): KI-84 split-billing backfill smoke chain fails on current main | KI-84 remains open; no repair claimed. |
| [#1138](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1138) | feat(credit): read-only customer_credit_exposure RPC for #1132 (migration 20261027030000, not applied) | Credit-exposure support applied; not server-side posting-limit enforcement. |
| [#1139](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1139) | docs(pricing): record sell-price history live (row 989, To-Do 0.4, PR #1122) | 0.4 already records shipped history; retained. |
| [#1140](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1140) | docs(ledger): record the 2026-10-27 08:26 UTC live migration capture | Historical ledger capture; replaced only relevant stale status claims. |
| [#1141](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1141) | docs(records): customer_credit_exposure applied live (row 991, PR #1138) | Credit-exposure apply verified; 10.6/10.7 remain open. |
| [#1142](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1142) | docs(todo): record PR #1132 in row 10.5 | 10.5 sixth money batch already recorded; broader row remains partial. |
| [#1143](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1143) | fix(guards): the live-database guard lets reads through (guard cleanup item 2) | KI-52 read-side false-positive claim narrowed; executable-write protections remain. |
| [#1144](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1144) | docs(records): quote_sent_price_lock applied live (row 992, PR #1105) | Confirms 1.2/1.3/0.5 apply; already recorded. |
| [#1145](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1145) | chore(guards): unwire three dead or duplicate project hooks (guard cleanup item 4) | Hook cleanup; delivery gates retained; no product row closed. |
| [#1146](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1146) | docs(known-issues): note two quote-lock follow-ups (KI-82, KI-83) | New KI-82/KI-83 remain open. |
| [#1147](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1147) | fix(purchasing): PO copy email checks PO number and order date; retry key ignores a receipt | Merged during reconciliation; 0.15/KI-72 still need enum apply and send-email deployment. |
| [#1150](https://github.com/masonwells1/CRX_Manager_V1.0/pull/1150) | chore(agents): run compliance-reviewer on Sonnet (effort stays high) | Agent reviewer configuration; no product completion row closed. |

## Verification and rollback

Validate document drift and whitespace, inspect the rendered Markdown tables/links, and use the normal protected PR checks. No app code or business data is changed. Revert this documentation commit through a PR if a record is wrong; keep the original proof trail in the archive. Newer shipments after the recorded SHA need their own reconciliation.
