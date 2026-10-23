## 2026-10-21 — blend-ticket invoices: the four LOW leftovers of the approval binding (migration 20261022020000, not applied)

`create_invoice_from_blend_ticket` is replaced in place (same arguments, grants and security) with the
live body (from 20261021070000, PR #995) plus four small changes from that PR's Sol round 5 and review
notes:

- **Stored quantity.** A product line stores its quantity rounded to 4 places, but its amount and its
  share of the invoice cost were worked out from the unrounded quantity, so on a fractional quantity they
  could differ by a few cents from quantity x price. The per-unit line now prices and costs from the
  stored quantity, as `save_invoice` already does when a line is saved again. The "included in grower
  share" line stays $0 (its customer charge is the per-acre share line, from acres and the override
  price, unchanged); only its cost in the invoice total now uses the stored quantity. Whole-number and
  4-place quantities bill exactly as before. A positive quantity so small it would store as 0 (below
  0.00005) is refused (`BLEND_INVOICE_QUANTITY_ROUNDS_TO_ZERO`) instead of billing a 0-quantity line
  (found by the Sol review), before any invoice number is drawn (Codex App review).
- **$0 line cost.** An approved $0 quoted line now records the catalog cost the approval window showed
  (and `below_cost_approvals` records), not the ticket line's editable cost copy; the grower-share line
  already did. Other lines keep their cost source. Margin reporting only (the price is $0 either way).
- **Preflight pins.** The tier-price helper (called but never pinned), the quote-pick helper (only checked
  to exist) and `safe_cents_qty` are now pinned by body md5, with the line trigger and share helper;
  the line trigger must also be attached to `invoice_items` exactly as live defines it (before insert or
  update of the money columns) and enabled.
- **Dead check removed.** The `IF p_idempotency_key IS NOT NULL` tests around the replay lookup and the
  receipt could never be false once the key became required; removed, behaviour unchanged.
- Proof: `scripts/smoke/prove-blend-invoice-binding-lows-real-schema.mjs` (Docker, real schema) with the
  new chain `scripts/smoke/smoke-blend-invoice-binding-lows.sql` (CONTAINER ONLY) and the 20261021070000
  and own-name chains as covering chains.
- Docs: `docs/manual/KNOWN_ISSUES.md` corrects the 20261021070000 entry ("not yet applied when written" →
  applied live 2026-10-21 20:41 UTC) and records these four findings as fixed by this migration.
