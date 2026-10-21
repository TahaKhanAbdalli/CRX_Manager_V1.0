/**
 * CustomerContextCard.businessDate.test.tsx — the customer card asks for the aging on Chicago's
 * date, the same day the Accounts Receivable pages ask for.
 *
 * The card used to ask get_ar_aging for `new Date().toISOString().slice(0, 10)`, a UTC date. From
 * about 7pm Central UTC is already tomorrow, so the card's AR balance was tomorrow's. The clock
 * below is pinned to 8:30pm Central, and the computer's own timezone to UTC, so a card reading
 * either clock asks for the wrong day here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({
  rpcCalls: [] as Array<[string, unknown]>,
}));

// Every query chain answers with its rows: the customer for `customers`, the aging row for the
// function, nothing for the rest.
const reply = (rows: unknown) => {
  const chain: object = new Proxy({}, {
    get: (_target, prop) => (prop === 'then'
      ? (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null, count: 0 }).then(resolve, reject)
      : () => chain),
  });
  return chain;
};

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return {
    ...actual,
    supabase: {
      from: (table: string) => reply(table === 'customers'
        ? { farm_name: 'Big Farm', assigned_tier: 2, credit_limit_cents: 0 }
        : []),
      rpc: (name: string, args: unknown) => {
        H.rpcCalls.push([name, args]);
        return reply([{ customer_id: 'card-customer', total_outstanding: 1234.5, open_credit_cents: 0 }]);
      },
    },
  };
});

import CustomerContextCard from './CustomerContextCard';

const originalTz = process.env.TZ;

beforeEach(() => {
  H.rpcCalls = [];
  // A computer set to UTC (as CI is, or a viewer's laptop could be).
  process.env.TZ = 'UTC';
  vi.useFakeTimers({ toFake: ['Date'] });
  // 8:30pm Central (CDT, UTC-5) on Tuesday 2026-10-20 is 01:30 UTC on Wednesday 2026-10-21.
  vi.setSystemTime(new Date('2026-10-21T01:30:00Z'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // Assigning undefined would set the string "undefined", not unset it.
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('Customer card in the evening, Central time', () => {
  it("asks for the aging on Chicago's date, not tomorrow's", async () => {
    render(<CustomerContextCard customerId="card-customer" />);
    // The card shows the aging row it was given, so the call has finished.
    expect(await screen.findByText(/AR: \$1,234\.50/)).toBeInTheDocument();
    expect(H.rpcCalls).toEqual([['get_ar_aging', { p_as_of_date: '2026-10-20' }]]);
  });
});
