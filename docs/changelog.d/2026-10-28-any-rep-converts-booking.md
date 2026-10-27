## 2026-10-28 — Any sales rep can convert another rep's booking; the commission stays with the booking's rep

- Mason, 2026-10-27: "any rep converts another rep's booking, and the commission stays with the
  booking's salesperson". New migration `20261027080400_any_rep_converts_booking.sql` (row 1000,
  NOT APPLIED, placeholder stamp/row) removes the two `NOT_QUOTE_OWNER` checks from
  `_convert_quote_to_order_below_cost_impl_20260810`, so Convert matches Partial Order
  (`draw_down_quote`, any rep since 2026-08-16). The rest of the body is byte-identical to
  `20261027040000` (#1105).
- Commission: no code change. The order and its commissions take the booking's own commission
  split, never the person converting.
- Unchanged: drivers, switched-off reps and signed-out callers are still refused
  (`INSUFFICIENT_ROLE`, `AUTH_REQUIRED`), and so is a forged actor (`ACTOR_MISMATCH`); the
  stale-write, replay and sent-price checks; editing, re-sending and rewinding a booking stay
  owner-only. No screen change: Convert was never hidden from other reps.
- Permission change: applies only after Mason's in-chat `I approve`.
- Proof (local replay of main `51d212fa`, synthetic data): before the change, permission matrix
  "convert the demo booking" for Rep 2 (not the owner) was deny; after, allow, and no other cell
  moved. New booking scenario: Rep 2 converts Rep 1's booking that carries a 100% Rep 1 split; the
  order is created, the booking is accepted, every commission row goes to Rep 1 and none to Rep 2,
  and Rep 2's attempt to edit the booking is still refused (`NOT_QUOTE_OWNER`). The other booking
  scenarios give the same results as main. Static test:
  `src/lib/anyRepConvertsBookingMigration.test.ts`.
- Follow-up for the next live sweep: re-pin the `convert_quote_to_order` actor-forgery entry in
  `scripts/db-invariant-sweeps/allowlist.json` (its pin predates #1105; `p_performed_by` handling is
  unchanged).
- Not verified: live body md5 (local replay only).
