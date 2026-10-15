## 2026-10-15 — Orders and blend tickets: a sales rep records only their own name as salesperson

**What changed (migration `20261015130000_orders_blend_tickets_rep_own_name`, not yet applied when
written).** The rest of Goal 2's "own-name everywhere" after the order-invoice fix (`20261014210000`).
- New trigger function `guard_rep_salesman_20261015` (runs with the caller's rights, callable by no
  API role) on `orders` and `blend_tickets`, BEFORE INSERT OR UPDATE OF `salesman_id`. For an
  active sales rep who is not an admin: a new order or ticket names the rep or no one; a salesperson
  changes only from blank to the rep (another rep's name is never replaced or cleared, not even with
  the rep's own). Refused with `SALESMAN_SCOPE_DENIED`, the code the invoice paths already use. An
  update that leaves the salesperson alone is never refused, so every server function that updates
  another rep's order or ticket for other reasons keeps working. Admins are unrestricted.
- `create_invoice_from_blend_ticket` refuses a rep billing a ticket that names someone else, after
  locking the ticket and before the replay lookup or any invoice number. A replayed result is returned only when every invoice in it belongs to that ticket and was created by the caller (otherwise `IDEMPOTENCY_INTENT_MISMATCH`), because the replay lookup matches on the key alone. `create_order_from_blend_ticket`
  is not edited: it copies the ticket's salesperson onto the new order, so the trigger refuses a rep
  converting another rep's ticket.

**Why.** Mason, 2026-10-15: "do the docs follow up and then lets work on remaining items"; the open
item was `KNOWN_ISSUES.md` "Order and blend-ticket salesperson". A rep could insert an order naming
another rep straight through the Data API (`orders_insert` has no salesperson test), set any blend
ticket's salesperson (`blend_tickets_office_update`), and bill another rep's ticket under that
rep's name, which grants that rep read access to the invoices.

**No screen changes behavior.** Read live 2026-10-15: no screen writes either column, every order
RPC except `create_order_from_blend_ticket` inserts it as NULL, all live orders have it NULL, and no
blend tickets exist.

**Also.** `smoke-order-invoice-rep-own-name.sql` now has an admin, not the rep, move order 2 onto
the rep (a rep can no longer take over another rep's order). `KNOWN_ISSUES.md` corrects "where
commissions read it": commissions do not read either column. Quote salesperson is left open for
Mason's call (season rollover copies it).

**Proof.** `node scripts/smoke/prove-orders-blend-tickets-rep-own-name-real-schema.mjs` builds the
production schema in a network-disabled container, checks the pinned bodies against the live md5s
read 2026-10-15, shows the new chain `smoke-orders-blend-tickets-rep-own-name.sql` failing first
before the change and passing after, runs three other chains before and after (two more that touch
these tables cannot run there: one already fails on main at its own fixture, one needs live
data), refuses an autocommit,
drifted or repeated apply, and proves each hunk with a mutation (nine; one moves the billing test below the replay lookup, and three remove the replay binding or one of its two tests). Live chains are not run:
they draw customer-visible order and invoice numbers.
