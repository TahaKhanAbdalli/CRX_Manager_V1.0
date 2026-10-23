## 2026-10-22 — Payment records can no longer be written directly (security fix, not yet live)

- Closed a hole where any sales rep could create fake payment records (`allocation_sets`,
  `invoice_line_allocations`, `order_line_allocations`) straight through the database API, which
  reconciliation and Payment History would read as real payments, and where an admin could edit or
  delete a payment record without reversing it. Live check 2026-10-22: no sign it was ever used.
- New migration `20261022040000_payment_allocation_tables_no_direct_writes.sql` (migration-history
  row 970) removes every direct write right from signed-in and signed-out users and drops the five
  write rules. Reading payment history is unchanged, and recording, reversing, voiding and order
  edits keep working because they run through the database functions.
- Proof: `node scripts/smoke/prove-payment-allocation-no-direct-writes-real-schema.mjs` (passes on a
  copy of the real schema). Standing guard: `src/__tests__/paymentAllocationWriteLock.test.ts`.
- The (disabled) E2E cleanup no longer tries to delete these rows and now warns when a delete is
  refused.
- Not applied live yet: needs Mason's "I approve" in the session that applies it.
