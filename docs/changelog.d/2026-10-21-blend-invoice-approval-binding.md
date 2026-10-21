## 2026-10-21 — blend-ticket invoices: unmatched lines, grower-share tickets and a bound $0 approval

The three follow-ups reported when Goal 3 blend-ticket pricing shipped (PR #982), in one migration,
`20261021070000_blend_invoice_approval_binding` (not applied when written):

- A ticket line that is not matched to a catalog product is refused with
  `BLEND_TICKET_PRODUCT_UNMATCHED` before anything is written. It used to bill $0 with no approval.
- A grower-share override ticket (a field billed a flat price per acre that includes the chemicals)
  can be invoiced. Its $0 "included in grower share" chemical line takes the same admin below-cost
  approval as a $0 quoted line and is recorded in `below_cost_approvals`. Before, the below-cost
  guard refused that line, so the ticket could not be invoiced at all. (Every product still needs a
  positive whole-cent cost on the Price List; otherwise the invoice is refused, as before.) The
  approval window says which lines are inside a grower-share price instead of "free of charge",
  and gives both reasons for a line quoted at $0 on one share and inside a grower-share price on
  another. Blend invoices are now dated with the Chicago business day, not the UTC date, and a
  ticket with no season files its invoice in the season of that same Chicago date.
- The $0 approval is bound to the lines it showed. The screen sends back the approved lines
  (`p_approved_zero_lines`), each with why it is $0, its cost, and a fingerprint of its rate, the
  product's units and the fields' acres and per-acre prices, as shown; if any of those changed in
  between (for example a field's per-acre price set to $0, or a product switched from gallons to
  ounces), nothing is invoiced and staff see
  "The $0 lines on this ticket changed while the approval was open". The same refusal applies when
  a $0 line got a real price in between and no line is $0 any more.
- The job's quote prices and the ticket's product costs are held still while the invoice is made,
  so an edit cannot change a price or cost between the approval check and billing.
- An "included in grower share" chemical line now records the chemical's catalog cost (the cost the
  approval showed), and the invoice's cost includes it, so the invoice margin is not overstated.
- A retry key is now required (`IDEMPOTENCY_KEY_REQUIRED`), so a lost reply can always be replayed
  instead of being refused as already billed. The screen always sends one.
- The Blend Ticket screen explains these refusals, and a product with no cost entered
  (`COST_BASIS_REQUIRED`) or a cost that is not whole cents (`COST_BASIS_CENTS_REQUIRED`), in plain
  English, naming the product when it can.
- The ticket's lines are locked while it is invoiced, and only an approved $0 line gets the
  approval, so a line edited mid-invoice fails closed.
- Deploy order: the migration is applied right before the merge; until the new screen loads, a $0
  approval from the old screen is refused (it fails closed). 0 unbilled tickets were affected on
  2026-10-21.

Live state when written: 0 grower-share overrides, 0 "included in grower share" lines ever, 0 blend
lines without a product. Proof: `node scripts/smoke/prove-blend-invoice-approval-binding-real-schema.mjs`
(BLEND_INVOICE_APPROVAL_BINDING_PROOF_PASS, 18 mutations). Docs: migration-history row 961,
`docs/reference/rpc-functions.md`, `docs/manual/KNOWN_ISSUES.md`.
