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
- Smoke chain: `scripts/smoke/smoke-save-quote-customer-row-version.sql` used to expect a
  non-owner rep's conversion to be refused (`NOT_QUOTE_OWNER`), which would fail once this applies.
  It now proves the new rule instead: the non-owner rep's Convert creates the order and accepts the
  booking, the order carries the booking's own commission split with no salesperson set, and the one
  commission row goes to the booking's rep. That step runs in a subtransaction that is rolled back
  on purpose, so the booking, its token and the later checks are untouched. Editing, versioning and
  restoring by a non-owner are still refused, and a non-office role still gets `INSUFFICIENT_ROLE`
  on Convert. The companion `prove-quote-customer-row-version-concurrency.mjs` text checks follow
  the new wording. The real-schema prover (`prove-quote-customer-row-version-real-schema.mjs`)
  replays every migration, including this one, and runs the chain (local disposable replay, no
  live access: `ROW_VERSION_REAL_SCHEMA_RESTORE_PASS` with this migration applied last). The step
  first gives the booking a 100% split to its own rep, because the chain's earlier restore leaves
  none.
- Sweep fingerprints (KNOWN_ISSUES KI-85): four sweep pins had gone stale when the sent-quote price
  lock (#1105) rewrote their functions; an independent review of the live bodies found the actor
  binding, role gates and quote-version trust route intact, so they are re-pinned from live:
  the `save_quote` and `convert_quote_to_order` actor-forgery dependency digests in
  `scripts/db-invariant-sweeps/allowlist.json`, and the two quote-version body pins in the
  `quote-versions-rpc-owned` predicate and `src/lib/quoteVersionWriteBoundary.test.ts` (the old
  applied migration `20260826220000` keeps its own pin copies untouched). The `convert_quote_to_order`
  exception keeps one reviewed entry for today's live body and gains a second, separately reviewed
  entry for this migration's body, whose digest was captured by applying the migration in a
  disposable PostgreSQL copy of live (which first reproduced every live digest). Its wording says
  that after this migration every active rep may convert while the acting user stays bound to the
  signed-in caller. No matcher, other exemption or permission code changed. The live-data guard's
  list of known sweep files (`.claude/hooks/live-testdata-lib.mjs`) gets one new fingerprint, for the
  edited `quote-versions-rpc-owned.sql` only (Mason approved that single edit in the normal prompt);
  no guard logic or other fingerprint changed. Proof: the 29 live read-only sweeps adjudicate clean
  (`ok: true`, `complete: true`), every db-invariant-sweeps test passes, and in a disposable
  PostgreSQL copy of live each changed grant, search path, actor-mismatch or role-gate edit made the
  exemption stop matching. Limit: that copy differs from live on three unrelated functions, so its
  own sweep still shows three unrelated rows.
- Not verified: live body md5 of the candidate (local replay only).
