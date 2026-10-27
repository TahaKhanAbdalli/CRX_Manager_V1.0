## 2026-10-25 — A sent quote keeps the prices the customer saw (To-Do 1.2; migration 20261027040000, not applied)

Mason's decisions of 2026-10-13/14 (pricing plan slice 2,
`docs/plans/2026-10-13-pricing-history-cost-tracking-and-quote-pricing-PLAN.md`). Before this, every
`save_quote` re-priced each line without a manual price to today's tier price, so a price change between
send and accept reached the order.

**Database (`supabase/migrations/20261027040000_quote_sent_price_lock.sql`, not applied yet):**
- New `_assert_quote_prices_as_sent(uuid)` (invoker rights, executable by no API role). The version last sent
  to the customer is the price authority: it refuses with `QUOTE_RESEND_REQUIRED` when the customer changed or
  a line is not a sent line for the same product at the same price. A quote never sent passes (a draft keeps
  its own prices). A last version from before the protected send workflow is refused. Versions written before
  this change carry no line ids; for them lines pair one to one by product and fail closed.
- `save_quote`: once a quote has been sent, a line the save names by its saved id keeps its stored price on
  every save; only a manual price or the line's new `use_todays_price` flag changes it. A new line, or one
  matched only by product, takes today's price (and the check then asks for a re-send). Editing a sent quote
  keeps its expiry. Turning a quote into `accepted` must pass the check (a quote already accepted can still be
  saved). The reply now carries `item_prices` (client key to stored price), so the screen holds what the
  database holds.
- Every send (`create_quote_version`) records each line's id and manual price and each section's field, and
  sets the expiry to the Chicago business date plus the quote's valid days.
- Rewind (`restore_quote_version`) puts back the version's customer and tier, its lines under their own ids
  with their manual prices, and each section's field when it still belongs to the customer, so a rewound quote
  matches the version as sent.
- Convert to Order, Partial Order (`draw_down_quote`) and Schedule Job (`create_job_from_quote_section`) run the
  check before writing anything. Convert skips it only where it returns an existing order (an accepted quote
  with an order, or a drawn booking), so a quote reopened after its order was cancelled is checked again. If
  cost has risen above a locked price, Convert keeps the price and still needs an admin's below-cost approval
  with a reason (unchanged; proven).

**Quote screen (`src/pages/QuoteBuilder.tsx`):** a sent quote's saved lines keep their price through edits, tier
and customer changes. Each line offers "Use today $X" when today's price differs, and the revised-quote banner
offers "Use today's prices" for the whole quote. A line whose price was not sent shows "Sent at $X" or "New
since V1", the banner says a re-send is needed, and "Rewind to V1" restores the version last sent in one
confirmed step. After each save the screen keeps each line at the price the database stored, and a "use
today's price" choice applies once. The "changed since sent" warning matches lines by id, as the database
does (`src/lib/quotePriceLock.ts`), including a line added and saved since the page loaded (its id comes from
the save's reply). The emailed PDF shows the expiry that send stored, not one worked out from the creation date. If a save
stores a different price than the screen shows (the catalog changed after the page loaded), the screen asks
for a reload; an action chained to that save (Mark Presented, email, convert) stops, and later ones wait for
the reload. A brand-new quote has no saved page to reload, so its first save instead warns and opens the saved
quote, which shows the stored prices (the reload could not load it, and the next save would have created a
second quote; CodeRabbit, PR #1105). Refusals show the server's plain-English instruction, on the quote and on
the Quotes list. A tier or customer change no longer erases manual (negotiated) prices on any quote (plan
section 7, finding 3).

**Rollout impact (live read 2026-10-25):** no quote is sent or revised today. Q-2026-2059 (accepted with no
order, last version from before the protected send workflow) would need a re-send before it could be
converted; what to do with it stays Mason's call (KI-12).

**Not covered (follow-ups):** the blend-ticket invoice and field-application invoice paths read a quote line's
current price directly (`create_invoice_from_blend_ticket`, `_save_field_app_invoice_impl_20260714`,
`resolve_field_app_chemical_price`); they need the same rule (KNOWN_ISSUES KI-81).

**Docs:** To-Do 1.2, `docs/workflows/QUOTE_TO_DELIVERY.md` (sent-price lock rule), KNOWN_ISSUES KI-81,
`docs/reference/migration-history.md` row 992.
