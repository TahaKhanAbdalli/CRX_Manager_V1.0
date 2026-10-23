## 2026-10-23 — Quotes keep a stated $0 tier-2/3 price (#1060 follow-up, Task A)

- Mason (2026-10-23, #1060 landing session): "Keep the $0". When a product's tier-2 or tier-3 price
  is a stated $0, a quote for a customer on that tier now prices the line at $0. Only a MISSING
  (blank) tier price falls back to the tier-1 price. Jobs already worked this way
  (`getStatedTierPriceCents`, the #1060 `job_chemicals` trigger).
- The server already did this: `save_quote` (`_save_quote_below_cost_impl_20260810`),
  `create_quote_from_template` and `rollover_quote_to_season` all use
  `COALESCE(tierN_price, tier1_price, 0)` (live read 2026-10-23), so a $0 tier price was saved as $0
  while the quote screen showed the tier-1 price until the save. Only the screen changes; no
  migration.
- `src/lib/quoteCalc.ts`: new `getQuoteTierPrice`, used by `recalcItem`, `catalogPricePerAcre` and the
  Quote Builder's price lookup (product pick, tier change, price reset, picker list). `getTierPrice`
  (which also treats $0 as missing) is unchanged and still used by Invoice Detail's add-product; orders,
  invoices and quick deliveries keep their own lookups, not changed here.
- Live read 2026-10-23: no product has a $0 tier-2 or tier-3 price today (5 have a blank tier 2), so
  no existing quote changes.
- Declined by Mason (2026-10-23), recorded only: re-checking existing job lines when a product's tier
  price is later removed or a customer's tier changes. Rare; a line is re-checked when it is edited.
