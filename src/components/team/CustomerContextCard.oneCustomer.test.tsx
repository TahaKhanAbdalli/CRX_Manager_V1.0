/**
 * CustomerContextCard.oneCustomer.test.tsx — the customer card asks the aging for this customer's
 * row only, so a customer past the server's 1,000-row cap still shows their real balance.
 *
 * The card used to read the whole company's aging (largest balance first) and pick this customer
 * out. The server answers at most 1,000 rows, so a customer below the top 1,000 got no row and the
 * card showed "AR: $0.00". The fake server below behaves like PostgREST: it applies any `.eq`
 * filter first, then cuts the answer to 1,000 rows. 1,000 bigger customers sit ahead of ours.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const SERVER_ROW_CAP = 1000;
const OUR_CUSTOMER = 'customer-1001';

const H = vi.hoisted(() => ({
  agingRows: [] as Array<Record<string, unknown>>,
  agingError: null as { message: string } | null,
}));

// A plain query chain that answers with its rows: the customer for `customers`, nothing else.
const reply = (rows: unknown) => {
  const chain: object = new Proxy({}, {
    get: (_target, prop) => (prop === 'then'
      ? (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows, error: null, count: 0 }).then(resolve, reject)
      : () => chain),
  });
  return chain;
};

// get_ar_aging as PostgREST serves it: `.eq` filters are applied, then the reply is capped.
const agingReply = () => {
  const filters: Array<[string, unknown]> = [];
  const builder = {
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return builder;
    },
    then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
      // A failed call answers an empty list beside its error, so only the card's own error check
      // (not the empty-data guard after it) can keep the card from reading the failure as $0.
      const answer = H.agingError
        ? { data: [], error: H.agingError }
        : {
          data: H.agingRows
            .filter((row) => filters.every(([column, value]) => row[column] === value))
            .slice(0, SERVER_ROW_CAP),
          error: null,
        };
      return Promise.resolve(answer).then(resolve, reject);
    },
  };
  return builder;
};

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return {
    ...actual,
    supabase: {
      from: (table: string) => reply(table === 'customers'
        ? { farm_name: 'Small Farm', assigned_tier: 1, credit_limit_cents: 0 }
        : []),
      rpc: () => agingReply(),
    },
  };
});

import CustomerContextCard from './CustomerContextCard';

beforeEach(() => {
  H.agingError = null;
  // 1,000 customers with bigger balances, then ours as the 1,001st row.
  H.agingRows = Array.from({ length: SERVER_ROW_CAP }, (_, i) => ({
    customer_id: `customer-${i + 1}`,
    total_outstanding: 100000 - i,
    open_credit_cents: 0,
  }));
  H.agingRows.push({ customer_id: OUR_CUSTOMER, total_outstanding: 5678.9, open_credit_cents: 25000 });
});

afterEach(() => {
  cleanup();
});

describe('Customer card for a customer past the first 1,000 aging rows', () => {
  it('shows their real AR balance and credit, not $0', async () => {
    render(<CustomerContextCard customerId={OUR_CUSTOMER} />);
    expect(await screen.findByText(/AR: \$5,678\.90/)).toBeInTheDocument();
    expect(screen.getByText(/Credit: \$250\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/AR: \$0\.00/)).not.toBeInTheDocument();
  });

  it('shows no balance at all when the aging call fails, rather than $0', async () => {
    H.agingError = { message: 'permission denied for function get_ar_aging' };
    // Another customer: the card remembers each customer it has already shown.
    render(<CustomerContextCard customerId="customer-never-loaded" />);
    // The loading spinner goes away and the card shows nothing.
    await vi.waitFor(() => expect(screen.queryByText(/Loading context/)).not.toBeInTheDocument());
    expect(screen.queryByText(/AR:/)).not.toBeInTheDocument();
  });
});
