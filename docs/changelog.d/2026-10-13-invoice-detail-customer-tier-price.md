## 2026-10-13 — A product added on the invoice screen is priced at the customer's tier

**Why.** A types reviewer on the reps-work-any-customer change noticed that the invoice editor
(`src/pages/InvoiceDetail.tsx`) loaded its customer list without the `assigned_tier` column, while
Add Product priced the new line with `cust?.assigned_tier || 1`. The `as Customer[]` cast hid the
missing column, so every product added there got the tier-1 price for every customer, for admins and
reps alike.

**Not display-only.** The live `save_invoice` chain (seven layers) and the six triggers on
`invoice_items` never read a tier price or `assigned_tier`; the server stores the price the screen
sends. So the tier-1 price was what got saved and billed unless someone typed over it.

**Live impact on 2026-10-13 (read-only).** 150 active customers are tier 1, one is tier 3, none are
tier 2, and the tier-3 customer has no invoices yet. Tier prices rise with tier in the current price
list, so the bug would have under-charged, and it had not yet affected a saved invoice.

**What changed.**
- `src/pages/InvoiceDetail.tsx`: the customer-list query also selects `assigned_tier`, and
  `addProduct` prices through the shared `getTierPrice` (`src/lib/quoteCalc.ts`), the same rule the
  quote and order screens use. Its tier-1 fallback matters now that tier 2/3 is reachable: the old
  inline code returned a missing tier-2/3 price as $0, and 4 active products have no tier-2 price
  and 8 no tier-3 price (compliance review).
- `src/pages/InvoiceDetail.test.tsx`: a tier-2 and a tier-3 customer each add a product and Save,
  and the price sent to `save_invoice` must be that tier's price; a tier-3 customer adding a product
  with no tier-3 price must get the tier-1 price, not $0. The test's customer mock returns only the
  columns the page asked for, so removing `assigned_tier` from the query turns it red (verified
  against the unfixed code: a tier-3 line was saved at the tier-1 price).

- PR #908 review round (CodeRabbit, Codex connector): the picker list holds only active customers,
  capped at 500, and may not have loaded when Add Product is clicked. A customer missing from it is
  now read by id (`select('assigned_tier')`). If that read fails, the product is refused with an
  error instead of being priced at tier 1. The price and cost are converted to cents with the exact
  `parseDollarsToCents` instead of `Math.round(x * 100)`, and a sub-cent value is refused. Live has
  none: 0 of 595 active products have a sub-cent price or cost.
- Luna round 3: only one by-id lookup runs at a time. A second click cannot add a duplicate line,
  and Save is disabled until the line is added. An answer that arrives after the invoice's customer
  was switched is dropped with an error, so the old customer's tier never prices the new customer's
  line.
- PR #908 review round 2 (CodeRabbit, Codex connector): the page is reused across
  `/invoices/:id`, so switching invoices now releases the lookup lock. Each lookup carries a token,
  so a lookup from the previous invoice that settles late cannot release the lock a newer lookup
  holds.
- PR #908 review round 3 (Codex connector): closing the Add Product picker while the lookup is
  pending cancels the add, so its late answer neither adds the product nor closes a reopened
  picker. Declined: treating an explicit $0 tier-2/3 price as a real price. The shared
  `getTierPrice` used by Quote Builder and New Order falls back to tier 1 on 0, the invoice keeps
  that rule, and no product has a $0 tier price (0 of 604, 2026-10-14).
- Merged current main (reps-work-any-customer #907): the customer-list query keeps that PR's
  email, billing-address and account-number columns and adds `assigned_tier`.

**Known, not fixed here (pre-existing, found in review).** The Email button and the invoice PDF
read `email` and the billing-address and account-number columns from the list query, which used
to omit them; reps-work-any-customer (#907, merged in above) added them. Lines added before a customer is picked keep their price when the customer changes; re-pricing them could
overwrite a hand-typed price, so that is left as a business decision.

**Visible change.** Admins and reps now see the customer's tier price, not the tier-1 price, when they
add a product to an invoice on this screen. Tier-1 customers (all but one today) see no change.
