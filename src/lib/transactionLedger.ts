import type { CustomerTransactionRow } from '../types';

/**
 * True when every row's running balance equals the sum of debit minus credit
 * over the rows before it and itself. `get_customer_transaction_review`
 * computes the balance exactly that way, over the whole date range, before the
 * rows are paged. Its rows carry no id, so a transaction added or removed while
 * the pages were being read would repeat or drop a row at a page seam; that
 * breaks this chain, so a paged read that fails the check is not a ledger to
 * total.
 */
export function isLedgerContinuous(rows: CustomerTransactionRow[]): boolean {
  let balanceCents = 0;
  for (const row of rows) {
    balanceCents += (row.debit_cents || 0) - (row.credit_cents || 0);
    if (balanceCents !== row.running_balance_cents) return false;
  }
  return true;
}

/** Same transaction row, including its running balance (the rows carry no id). */
export function isSameTransaction(a: CustomerTransactionRow, b: CustomerTransactionRow): boolean {
  return a.transaction_date === b.transaction_date
    && a.transaction_type === b.transaction_type
    && a.reference_number === b.reference_number
    && a.description === b.description
    && a.debit_cents === b.debit_cents
    && a.credit_cents === b.credit_cents
    && a.running_balance_cents === b.running_balance_cents;
}
