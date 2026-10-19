import { describe, expect, it } from 'vitest';
import type { CustomerTransactionRow } from '../types';
import { isLedgerContinuous, isSameTransaction } from './transactionLedger';

function ledger(amounts: Array<[number, number]>): CustomerTransactionRow[] {
  let balance = 0;
  return amounts.map(([debit, credit], i) => {
    balance += debit - credit;
    return {
      transaction_date: '2026-10-01',
      transaction_type: debit ? 'Invoice' : 'Payment',
      reference_number: `REF-${i}`,
      description: null,
      debit_cents: debit,
      credit_cents: credit,
      running_balance_cents: balance,
    } as CustomerTransactionRow;
  });
}

describe('isLedgerContinuous', () => {
  it('accepts a complete ledger', () => {
    expect(isLedgerContinuous(ledger([[10000, 0], [0, 2500], [5000, 0]]))).toBe(true);
    expect(isLedgerContinuous([])).toBe(true);
  });

  it('rejects a row repeated at a page seam', () => {
    const rows = ledger([[10000, 0], [0, 2500], [5000, 0]]);
    expect(isLedgerContinuous([rows[0], rows[1], rows[1], rows[2]])).toBe(false);
  });

  it('matches the same row and rejects a later balance for the same reference', () => {
    const [a] = ledger([[10000, 0]]);
    expect(isSameTransaction(a, { ...a })).toBe(true);
    expect(isSameTransaction(a, { ...a, running_balance_cents: a.running_balance_cents + 800 })).toBe(false);
  });

  it('rejects a row dropped at a page seam', () => {
    const rows = ledger([[10000, 0], [0, 2500], [5000, 0]]);
    expect(isLedgerContinuous([rows[0], rows[2]])).toBe(false);
  });
});
