## 2026-10-21 — Customer card asks the aging for its one customer

The customer card on Team Board notes read the whole company's `get_ar_aging` list and picked its
customer out. The server answers at most 1,000 rows, largest balance first, so a customer below the
top 1,000 got no row and the card showed "AR: $0.00" and no credit chip.

- `src/components/team/CustomerContextCard.tsx`: the aging call now chains
  `.eq('customer_id', customerId)`, as the customer page's Financials tab already does, and throws
  the call's `error` so a failed call is never read as a $0 balance (the card then shows nothing).
- `src/components/team/CustomerContextCard.oneCustomer.test.tsx`: a fake server that filters by
  `.eq` and then caps at 1,000 rows, like PostgREST, with 1,000 bigger customers ahead of ours. The
  card must show the real $5,678.90 balance and $250.00 credit; the old code showed $0.00 and fails.
  A second check answers a failed call with an empty list beside its error and shows the card
  stays blank rather than $0; without the new error check it shows "AR: $0.00" and fails.
- `docs/manual/KNOWN_ISSUES.md`: the row-cap fixed list names the card.

Screen-only; no database change.
