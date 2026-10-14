## 2026-10-13 — Order page: Bill Split customer list and field-split owner names load again

**Why.** Found while click-testing PR #906 (React 19) against live data on ORD-2026-0567: two
customer lookups on the order page filtered `customers` on `deleted_at`, a column that table does
not have (customers are retired with `is_active`). The database refused both queries (HTTP 400,
`42703 column customers.deleted_at does not exist`), so the Bill Split "Add Split" customer dropdown
opened empty and the Field / Acre Split projected-split preview would show every owner as
"Unknown". Neither failure was reported — no toast, no Sentry.

**What changed** (`src/pages/OrderDetail.tsx`).
- Bill Split dropdown: lists active customers (`is_active = true`, the house pattern for customer
  pickers). If the load fails it reports to Sentry (`load_customers_for_bill_split`), shows an error
  toast, and does not open an empty editor.
- Field / Acre Split owner names: the name lookup now fetches exactly the customers the preview can
  show (this order's customer plus the field owners, `id in (…)`) with no active filter, so a field
  owned by an inactive customer still shows that customer's name and no row cap can drop one. The
  fields, field owner splits and customer names are now error-checked: each failure goes to Sentry
  (`load_field_split_lookups_for_order`), one toast is shown, and the card says the field details
  failed to load instead of "No active fields are set up yet."
- A sweep of every `.is('deleted_at', …)` / `.not('deleted_at', …)` in `src` against the live
  columns found no other table filtered on a column it lacks.

**Proof.**
- Live read-only `information_schema`: `customers` has `is_active` and no `deleted_at`; 154 customers,
  151 active.
- New `src/pages/OrderDetail.customerLookups.test.tsx` (6 tests). Its customers mock reads the live
  column list from `.claude/schema-registry.json` and answers 42703, like PostgREST, when any filter,
  `match`, `or`, `and` or `select` names a column the table lacks (one test pins that). The 5 page tests all
  fail against the old page and pass against the fix.
- Luna (Codex) round 1: 1 LOW (the mock ignored `and()` filters), fixed with a test.
- Compliance review: 0 BLOCKER / 0 HIGH; both MEDs (row cap on the name lookup, contradictory "no
  fields" hint) and the cheap LOWs fixed. Left as is: the dropdown's existing 500-row limit (151
  active customers today) and no loading state on "Add Split".
- Local dev app against live Supabase, ORD-2026-0567: the name lookup now asks for 4 customer ids and
  returns HTTP 200 (was 400 for all customers);
  "Add Split" opens a dropdown of 151 customers (the live active count) from an HTTP 200 request; no
  console errors. Nothing was saved. No live order uses field allocations yet, so the owner-name
  preview itself was proven by the tests, not on screen.
