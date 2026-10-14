## 2026-10-14 — Product tier prices held to whole cents by the database (migration `20261014150000`, NOT applied)

**Why:** Luna's review of PR #908 found that `products.current_cost` has a whole-cent CHECK
(`products_current_cost_cent_scale_chk`) but `tier1_price`, `tier2_price` and `tier3_price` only have
`>= 0` checks. PostgREST returns those prices as JSON numbers, so the browser's
`parseDollarsToCents(String(price))` cannot detect a sub-cent value with more than ~17 significant
digits.

**Change:** `supabase/migrations/20261014150000_products_tier_price_cent_scale.sql` adds
`products_tier1_price_whole_cents_chk`, `products_tier2_price_whole_cents_chk` and
`products_tier3_price_whole_cents_chk` (NULL, or finite and equal to `round(x, 2)`; named per
`docs/workflows/SAFE_DEVELOPMENT_RULES.md`, CodeRabbit on PR #910), the same predicate as the cost
constraint. Each is added only if absent, so the file is re-runnable (Codex connector on PR #910), and an
in-transaction verify block requires each constraint to be validated with exactly the expected definition
text (Luna round 2), so a same-named constraint with different logic cannot slip through. Non-destructive: no row changes, no grants, no
functions. `docs/reference/database-schema.md` names the constraints; the migration index, the
`CURRENT_STATE.md` / `KNOWN_ISSUES.md` ledger headers and `migration-history.md`'s live capture were
re-read against live (this also records that `20261013220000_reps_work_any_customer` is now applied,
ledger `20261014131450`).

**Proof (read-only, live, 2026-10-14):**
- 604 products; 0 with a sub-cent, infinite or NaN tier1/2/3 price (3/5/12 have a NULL one), so the
  constraints validate.
- The live BEFORE trigger `guard_and_version_product_pricing()` already raises
  `PRODUCT_PRICING_CENT_SCALE_INVALID` for these values, and a live `pg_proc` search found only two
  functions that assign tier prices (`apply_product_pricing_change_set`, writing `cents / 100`, and
  `calculate_prices_from_margin`, which runs before that guard). So no write that succeeds today can be
  refused by the new constraints; they add a lock that holds even when triggers are bypassed.
- The constraint expression, evaluated live: whole cents, `12.340000`, zero and NULL pass; `12.345`,
  `12.340000000000000001`, `Infinity` and `NaN` fail.

**Not verified yet:** the constraints themselves on live. A rolled-back DDL dry run was refused by the
live-data guard (it reads `CHECK (` as a function call), so the constraint creation is proven at apply
time by the migration's verify block and a post-apply read-back of `pg_constraint`.
