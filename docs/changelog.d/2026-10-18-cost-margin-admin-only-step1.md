## 2026-10-18 — Cost and margin admin-only, step 1: database functions stop handing cost to non-admins (migration `20261019010000`, not applied)

**Why.** Mason decided on 2026-10-15 that product cost and margin are admin-only (Goal 1 part 3). A read-only live
inventory found database functions giving cost, profit or margin to sales reps and others. Worst case: a below-cost
refusal put the exact product cost in its error message, so a rep could type a one-cent price and read it.

**What changed.**
- `supabase/migrations/20261019010000_cost_margin_admin_only_rpc_leaks.sql`: the below-cost refusal carries cost only for
  admins; five cost reports (gross sales, inventory cost, field profitability, profitability, bottom-line P&L) are
  admin-only, as is `dashboard_summary` (it gave every signed-in account company-wide profit and margin); the sales reports send NULL cost/profit/margin to non-admins; inventory position drops `current_cost` for
  non-admins; `save_quote`'s reply drops the cost totals for non-admins; anon loses `get_chemical_history`.
- Screens: Reports hides profit by customer, product and month, P&L, Gross Sales and Inventory Cost from non-admins (a rep keeps their own commissions, without order profit, and their Price List never asks for cost); Sales Reports shows cost columns, the Total
  Profit card and cost export columns only to admins and never prints a missing value as $0; `/field-profitability` is
  admin-only.
- Proof: `scripts/smoke/prove-cost-margin-admin-only-rpc-leaks-real-schema.mjs` (disposable copy of the production
  schema, 38 role cases before and after) and the read-only live chain `smoke-cost_margin_admin_only_rpc_leaks.sql`.
- Docs: `migration-history.md` row 953, `rpc-functions.md`, `pages-routes.md`, `KNOWN_ISSUES.md` (new OPEN entry with the
  remaining steps).

**Not yet.** Table columns stay readable until step 3 (after step 2 moves the screens off whole-row reads). Purchase-order
cost waits on Mason's decision.
