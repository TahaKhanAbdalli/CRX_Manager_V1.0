## 2026-10-20 - Blend-ticket pricing guards (Goal 3 "Pricing", migration 20261020210000)

**What.**
- **Order from a blend ticket never prices a product at $0 for a missing tier price.** The order
  body (`_create_order_from_blend_ticket_replay_impl_20261015`) used `COALESCE(tierN_price, 0)`
  with no tier-1 fallback. Today that $0 line is then refused by the below-cost line guard (every
  order line needs a cost), so staff got a confusing `BELOW_COST_CONTEXT_REQUIRED` error and no
  order. It now uses the customer's tier price when it is above zero, otherwise the tier-1 price,
  and refuses with `BLEND_TICKET_PRICE_MISSING` (naming the products) before any row is written
  when neither exists.
- **Blend-ticket invoice stops on an ambiguous quote.** When the job's quote lists the same product
  more than once at different prices, `create_invoice_from_blend_ticket` raises
  `BLEND_TICKET_QUOTE_PRICE_CHOICE_REQUIRED` with the choices (JSON in the error detail) before any
  invoice number is drawn. The Blend Ticket screen opens a "Pick the quoted price" window; the pick
  is saved by the new `set_blend_ticket_product_quote_price` (admin or sales rep, own-name rule,
  the quote must belong to the ticket's customer, key required and bound to the caller) onto
  `blend_ticket_products.unit_price_cents`, and the invoice then bills it as `quoted`.
  Same-price duplicates bill as before.
- **A pick cannot go stale or be forged.** Billing counts a stored pick only while it still matches
  a usable price on the current job's quote, for the line's current product, on the ticket
  customer's quote (`_blend_quote_pick_valid_20261020`); otherwise it asks again or tier-prices the
  line. A new column guard (trigger `blend_ticket_products_price_pick_guard_20261020`) refuses any
  direct write of that column except through the setter (`BLEND_TICKET_PRICE_PICK_REQUIRED`; the
  setter's flag counts only inside a definer function, so a forged flag is not enough), and
  clears a line's pick when its product changes or it moves to another ticket.
- A job pointed at another customer's quote, a deleted quote, or a section of a quote other than
  the job's own quote supplies no quoted price or pick (the automatic lookup used to trust any
  section the job named); the line bills its tier price.
- The same invoice refuses a tier-priced product with no usable price instead of billing $0, and
  counts only usable quote prices (zero or above, finite, whole cents).
- **A product the quote lists at $0 bills at $0, flagged and approved first** (Mason, 2026-10-20:
  "$0 of $0 but flag it in system and alert before save"). A $0 line is below cost, so it goes
  through the existing below-cost wall: before any invoice number is drawn the invoice asks
  (`BELOW_COST_REASON_REQUIRED`, or `BELOW_COST_ADMIN_REQUIRED` for a sales rep, whose message never
  carries the cost), the screen opens the "Approve below-cost price" window ("priced at $0, so it
  will be billed free of charge") listing every product that will bill at $0 (Mason: "list every
$0 line"; the error detail's `zero_lines`, never carrying cost), and the admin's one reason travels in the new
  `p_below_cost_reason` argument. The line trigger records each $0 line in `below_cost_approvals`
  (operation `create_invoice_from_blend_ticket`, now allowed by its CHECK). A $0 option is also
  offered in the pick window. Before, the $0 line was refused (`BELOW_COST_CONTEXT_REQUIRED`) and no
  invoice could be made. `create_invoice_from_blend_ticket` is re-created with that one extra
  trailing argument and the same grants.
- Shared rule: private helper `_blend_tier_price_cents_20261020` (tier price, else tier 1, whole
  cents, never rounds; executable only by postgres).
- Screen: each confirmed pick retires its retry key; a multi-pick that fails part-way reloads and
  says which saved; the setter's refusals read in plain English.

**Why.** Goal 3 "Pricing" in `docs/plans/2026-10-13-direction-and-goals.md`; Mason 2026-10-15:
exact quoted-line matching is future work, "so Goal 3 adds a small guard: when the quote lists that
product more than once, the blend invoice stops and staff pick the price".

**Proof.** `node scripts/smoke/prove-blend-ticket-pricing-guards-real-schema.mjs` (Docker,
production schema baseline plus every post-baseline migration): the new chain
`smoke-blend-ticket-pricing-guards.sql` fails first before the change (the order is refused because
its line was priced at $0), passes after it, and fails at the matching step with each guard removed.
Screen tests: `src/pages/BlendTicketDetail.test.tsx`, `src/lib/blendTicketPricing.test.ts`.

**Not changed.** The order wrapper and its replay binding, `save_blend_ticket`, the below-cost line
guard itself, every policy and every grant on an existing object. Automatic exact-line matching stays future work.
