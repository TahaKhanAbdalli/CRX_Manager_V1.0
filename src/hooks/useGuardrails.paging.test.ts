/**
 * useGuardrails.paging.test.ts — Goal 4 part 2b (L17): the credit-limit check adds up every
 * open invoice.
 *
 * The check read the customer's open invoices in one request, which the server silently
 * stops at 1,000 rows, so a customer with more open invoices than that looked under their
 * limit. A failed read also came back as "no invoices" and passed the check. The fake
 * server below caps every reply at 1,000 rows like the real one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { buildInMemoryQuery, SERVER_ROW_CAP } from '../test-utils/inMemoryQuery';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  // Tables whose reads fail.
  failing: new Set<string>(),
}));

// A query whose every method chains and whose answer is a read error.
function failingQuery(): Record<string, unknown> {
  const q: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: 'connection reset' }, count: null });
      }
      return () => q;
    },
  });
  return q;
}

vi.mock('../lib/db', () => ({
  supabase: {
    from: (table: string) => (H.failing.has(table) ? failingQuery() : buildInMemoryQuery(H.tables[table] ?? [])),
  },
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import { useCreditLimitCheck } from './useGuardrails';

const TOTAL = SERVER_ROW_CAP + 5;
const pad = (i: number) => String(i).padStart(4, '0');

beforeEach(() => {
  H.tables = {
    customers: [{ id: 'c1', farm_name: 'Big Farm', credit_limit_cents: 100_200 }],
    // 1,005 open invoices of $1.00 each ($1,005.00). Another customer's invoice and a paid
    // one must not count.
    invoices: [
      ...Array.from({ length: TOTAL }, (_, i) => ({ id: `inv${pad(i)}`, customer_id: 'c1', status: 'posted', balance_cents: 100 })),
      { id: 'other', customer_id: 'c2', status: 'posted', balance_cents: 999_999 },
      { id: 'paid', customer_id: 'c1', status: 'paid', balance_cents: 999_999 },
    ],
  };
  H.failing = new Set();
});

describe('credit-limit check past the 1,000-row server cap (L17)', () => {
  it('counts every open invoice, so a customer over the limit only on the full balance is warned', async () => {
    const { result } = renderHook(() => useCreditLimitCheck());
    let passed: boolean | undefined;
    // $1,005.00 open + $1.00 new = $1,006.00 against a $1,002.00 limit: over by $4.00. A
    // read stopped at 1,000 invoices would see $1,001.00 and pass.
    await act(async () => { passed = await result.current.check({ customerId: 'c1', newAmountCents: 100 }); });
    expect(passed).toBe(false);
    expect(result.current.warning?.id).toBe('credit-limit');
    expect(result.current.warning?.message).toContain('$4.00 over');
  });

  it('a customer under the limit on the full balance passes', async () => {
    H.tables.customers = [{ id: 'c1', farm_name: 'Big Farm', credit_limit_cents: 200_000 }];
    const { result } = renderHook(() => useCreditLimitCheck());
    let passed: boolean | undefined;
    await act(async () => { passed = await result.current.check({ customerId: 'c1', newAmountCents: 100 }); });
    expect(passed).toBe(true);
    expect(result.current.warning).toBeNull();
  });

  it('a failed invoices read fails closed with the could-not-verify warning, never a pass', async () => {
    H.failing.add('invoices');
    const { result } = renderHook(() => useCreditLimitCheck());
    let passed: boolean | undefined;
    await act(async () => { passed = await result.current.check({ customerId: 'c1', newAmountCents: 100 }); });
    expect(passed).toBe(false);
    expect(result.current.warning?.id).toBe('credit-limit-error');
  });
});
