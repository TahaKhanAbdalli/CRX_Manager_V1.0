## 2026-10-25 — Quote screen: quoted cost kept, today's cost beside it, one-step Convert (To-Do 1.3, 0.5; KI-12)

Screen only (`src/pages/QuoteBuilder.tsx`, new `src/components/quotes/QuoteLineCost.tsx`); no migration.

- **Quoted cost kept while editing (To-Do 1.3, pricing slice 1 remainder).** A saved line keeps the cost it
  was quoted at (`quote_items.cost_at_quote_cents`) through every recalculation, the same rule `save_quote`
  applies: the cost stays while the line keeps its id and product. A new line, or a line switched to another
  product, takes today's product cost, as the server stamps it. The kept cost is tied to the saved row it was
  recorded for, so a line switched away and back, then saved as a replacement row, keeps today's cost. Before, the first edit swapped in today's cost,
  so profit and margin jumped on screen and in the payload. One known display gap: a new line added in place of
  a deleted saved line of the same product keeps the deleted line's cost on the server (its existing
  one-per-product fallback), while the screen shows today's cost until the quote is reloaded; the server's
  figures are the ones stored. A Convert refused with `COST_BASIS_REQUIRED` (a legacy line with no recorded
  cost) now says to revise and save the quote first.
- **Cost when quoted beside today's cost (To-Do 0.5, pricing slice 5).** The admin-only Cost cell shows both,
  marked "up" when today's cost is higher and "below cost" when the line's price is under today's cost (Convert
  then needs an admin's below-cost approval). Hidden for sales reps and in Customer View; PDFs carry no cost.
- **Convert to Order in one step (KI-12).** The screen no longer saves the quote as Accepted before converting.
  `convert_quote_to_order` already accepts a `sent` or `revised` quote and marks it accepted in the same
  transaction as the order, so a failed conversion now leaves the quote as it was, and the client-side
  "revert to sent" write is gone. Unsaved edits on a sent or revised quote are saved first under its own status.
  Side effect: converting an unedited sent quote no longer runs a save, so it no longer re-prices the quote to
  today's catalog price on the way to the order. The database-side price lock (To-Do 1.2, pricing slice 2) is
  the next change.

**Proof:** `scripts/smoke/smoke-convert-sent-quote-in-one-step.sql` (new spec `convert_sent_quote_in_one_step`)
passed on the replayed real schema through `scripts/smoke/prove-quote-pricing-real-schema.mjs`: Convert from
`sent` made one order at the sent 7.50 after a reprice to 8.75 and accepted the quote; the old accepted save
re-priced to 8.75; a cost rise to 8.00 was refused without a reason and converted at 7.50 with an admin's reason,
recording the approval. QuoteBuilder tests cover the one-step convert, the untouched status after a failure, and
the kept quoted cost. **Not yet verified:** the live screen after deploy.
