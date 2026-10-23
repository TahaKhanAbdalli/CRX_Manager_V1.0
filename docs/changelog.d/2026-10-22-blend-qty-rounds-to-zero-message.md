## 2026-10-22 — plain-English message when a blend-ticket line would bill almost nothing

- Creating an invoice from a blend ticket can now be refused with `BLEND_INVOICE_QUANTITY_ROUNDS_TO_ZERO` (migration
  `20261022020000`, PR #1020): one product's quantity on a customer's invoice would round to 0 at 4 decimal places.
- The Blend Ticket screen showed that refusal as raw database text. It now names the product and says nothing was
  invoiced and to check that product's rate and the field acres (`blendTicketInvoiceRefusalMessage`).
- Screen text only; no database change.
