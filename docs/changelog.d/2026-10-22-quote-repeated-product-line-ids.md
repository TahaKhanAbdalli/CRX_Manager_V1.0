## 2026-10-22 — a quote with the same product on two lines can be re-saved, presented and converted

- Before: once a quote with one product on two lines (for example two fields) was saved, every later save failed
  with `QUOTE_ITEM_AMBIGUOUS_COST`, including Revise, Mark Presented and Convert to Order. The quote screen never told
  `save_quote` which saved line each row was, so the server refused rather than guess whose quote-time cost to keep.
- Now `src/pages/QuoteBuilder.tsx` remembers each saved line's id (from the load, then from the `item_ids` map each
  save returns), sends it with a `client_key` on every line, and drops it for good when a line is switched to another
  product (even if it is switched back), so the server prices that line like any unnamed line. No database change:
  live `save_quote` already supported this. One narrow case is still refused by the server's design: deleting or
  switching away a saved line of a product while adding two or more new lines of that same product in one save.
- Proof: a new QuoteBuilder test, and the rolled-back live chain
  `scripts/smoke/smoke-save-quote-repeated-product-line-ids.sql` (PASS 2026-10-22). Quotes without a repeated product
  save as before. `docs/manual/KNOWN_ISSUES.md` marks the re-save refusal fixed; the Convert-to-Order ordering issue
  in the same entry stays open.
