/**
 * ARPayments.loadFailed.test.tsx — To-Do 10.5, A/R and payments screens: a read that fails
 * (an error, or no list at all) says "could not be loaded" with Try again, never
 * "No … found", zero totals, or the previous item's rows; Try again shows the list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery, pagedRpcReply } from '../test-utils/inMemoryQuery';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  functions: {} as Record<string, unknown>,
  // Table or function name -> how its next reads fail.
  failing: new Map<string, 'error' | 'nodata'>(),
  searchTables: new Set<string>(),
  // Function name -> a reply the test releases later (a slow read).
  pending: new Map<string, Promise<unknown>>(),
  toast: vi.fn(),
}));

// A query that ignores its filters and answers with the given rows.
function fixedQuery(rows: Row[]): Record<string, unknown> {
  const q: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null, count: rows.length });
      return () => q;
    },
  });
  return q;
}

// A query whose every method chains and whose answer is a failed read.
function failingQuery(mode: 'error' | 'nodata'): Record<string, unknown> {
  const reply = mode === 'error'
    ? { data: null, error: { message: 'connection reset' }, count: null }
    : { data: null, error: null, count: null };
  const q: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(reply);
      return () => q;
    },
  });
  return q;
}

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    ...actual,
    supabase: {
      from: (table: string) => {
        const mode = H.failing.get(table);
        if (mode) return failingQuery(mode);
        // The payment screen's name search: answer with every row of the table.
        if (H.searchTables.has(table)) return fixedQuery(H.tables[table] ?? []);
        return buildInMemoryQuery(H.tables[table] ?? []);
      },
      rpc: (name: string) => {
        const mode = H.failing.get(name);
        if (mode) return failingQuery(mode);
        const slow = H.pending.get(name);
        return pagedRpcReply(slow ?? { data: H.functions[name] ?? [], error: null });
      },
    },
  };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({ useIdempotencyKey: () => ({ getKey: () => 'idem', resetKey: vi.fn() }) }));

import ARaging from './ARaging';
import PaymentHistory from './PaymentHistory';
import AccountsReceivable from './AccountsReceivable';
import CustomerTransactionReview from './CustomerTransactionReview';
import PaymentAllocation from './PaymentAllocation';

const at = (path: string, node: React.ReactNode) => render(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  H.failing = new Map();
  H.searchTables = new Set();
  H.pending = new Map();
  H.functions = {};
  H.tables = {
    customers: [
      { id: 'c1', farm_name: 'Big Farm', account_number: 'A1', is_active: true, prepay_balance_cents: 0 },
      { id: 'c2', farm_name: 'Small Farm', account_number: 'A2', is_active: true, prepay_balance_cents: 0 },
    ],
  };
});
afterEach(cleanup);

describe('AR Aging season comparison', () => {
  it('a failed comparison says so with Try again, and Try again shows the rows', async () => {
    H.failing.set('get_season_comparison', 'error');
    at('/ar-aging', <ARaging />);
    fireEvent.click(await screen.findByRole('button', { name: 'Season Comparison' }));

    expect(await screen.findByText('This list could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('No comparison data')).not.toBeInTheDocument();

    H.failing.delete('get_season_comparison');
    H.functions.get_season_comparison = [{ metric: 'Gallons Sold', season_a_val: 100, season_b_val: 50, change_pct: 100 }];
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Gallons Sold')).toBeInTheDocument();
  });

  it('a failed aging read offers Try again in place of the totals, which then load', async () => {
    H.failing.set('get_ar_aging', 'error');
    at('/ar-aging', <ARaging />);
    expect(await screen.findByText('AR aging could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('Total Outstanding')).not.toBeInTheDocument();

    H.failing.delete('get_ar_aging');
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Total Outstanding')).toBeInTheDocument();
  });
});

describe('Payment History', () => {
  const payment = { id: 'p1', customer_id: 'c1', total_payment_cents: 12345, total_allocated_cents: 12345, payment_method: 'check', check_number: 'CHK-77', reference_number: null, payment_date: '2026-10-01', season: 2027, is_active: true, notes: null, created_at: '2026-10-01T12:00:00Z', customers: { farm_name: 'Big Farm' } };

  it('a failed list read hides the totals and offers Try again instead of "No payments yet"', async () => {
    H.failing.set('allocation_sets', 'error');
    at('/payment-history', <PaymentHistory />);

    expect(await screen.findByText('This list could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('No payments yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Active Payments')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export CSV/ })).toBeDisabled();

    H.failing.delete('allocation_sets');
    H.tables.allocation_sets = [payment];
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('CHK-77')).toBeInTheDocument();
    expect(screen.getByText('Active Payments')).toBeInTheDocument();
  });

  it("a failed allocations read never shows the previously opened payment's invoices", async () => {
    H.tables.allocation_sets = [payment, { ...payment, id: 'p2', check_number: 'CHK-88', created_at: '2026-09-01T12:00:00Z' }];
    H.tables.invoice_line_allocations = [{ id: 'a1', allocation_set_id: 'p1', invoice_id: 'i1', amount_cents: 12345, split_percentage: 100, bill_to_customer_id: 'c1', created_at: '2026-10-01', invoices: { invoice_number: 'INV-FIRST' }, customers: { farm_name: 'Big Farm' } }];
    at('/payment-history', <PaymentHistory />);

    const [first, second] = await screen.findAllByRole('button', { name: /\d+\/\d+\/\d+/ });
    fireEvent.click(first);
    expect(await screen.findByText('INV-FIRST')).toBeInTheDocument();

    H.failing.set('invoice_line_allocations', 'error');
    fireEvent.click(second);
    expect(await screen.findByText("This payment's allocations could not be loaded")).toBeInTheDocument();
    expect(screen.queryByText('INV-FIRST')).not.toBeInTheDocument();
    expect(screen.queryByText('No invoice allocations for this payment')).not.toBeInTheDocument();
  });
});

describe('A/R Workspace money summary', () => {
  it('a failed summary read says so, and Try again shows the totals', async () => {
    H.failing.set('prepay_credits', 'error');
    at('/accounts-receivable?tab=ledger', <AccountsReceivable />);

    expect(await screen.findByText('The money summary could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('Total Owed')).not.toBeInTheDocument();

    H.failing.delete('prepay_credits');
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Total Owed')).toBeInTheDocument();
    expect(screen.queryByText('The money summary could not be loaded')).not.toBeInTheDocument();
  });
});

describe('Customer Transactions', () => {
  it('a failed customer list says so with Try again instead of an empty dropdown', async () => {
    H.failing.set('customers', 'error');
    at('/customer-transactions', <CustomerTransactionReview />);

    expect(await screen.findByText(/The customer list could not be loaded/)).toBeInTheDocument();

    H.failing.delete('customers');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('option', { name: 'Big Farm' })).toBeInTheDocument();
    expect(screen.queryByText(/The customer list could not be loaded/)).not.toBeInTheDocument();
  });
});

describe('Customer Transactions totals', () => {
  const ledger = [{ transaction_date: '2026-10-01', transaction_type: 'invoice', reference_number: 'INV-A', description: 'Big Farm invoice', debit_cents: 4321, credit_cents: 0, running_balance_cents: 4321 }];

  async function loadBigFarm() {
    H.functions.get_customer_transaction_review = ledger;
    at('/customer-transactions?customer=c1', <CustomerTransactionReview />);
    await screen.findByRole('option', { name: 'Small Farm' });
    fireEvent.click(screen.getByRole('button', { name: 'Last 90d' }));
    expect(await screen.findByText('INV-A')).toBeInTheDocument();
    expect(screen.getByText('Total Debits').parentElement!).toHaveTextContent('$43.21');
  }

  it("never shows the previous customer's totals while the next customer loads", async () => {
    await loadBigFarm();
    let release!: (v: unknown) => void;
    H.pending.set('get_customer_transaction_review', new Promise((r) => { release = r; }));
    fireEvent.change(screen.getByLabelText('Select customer'), { target: { value: 'c2' } });

    expect(screen.queryByText('Total Debits')).not.toBeInTheDocument();
    expect(screen.queryByText('INV-A')).not.toBeInTheDocument();
    release({ data: [], error: null });
    expect(await screen.findByText('No transactions')).toBeInTheDocument();
  });

  it('clearing the customer clears the rows and a failed state, with no Try again that cannot work', async () => {
    H.failing.set('get_customer_transaction_review', 'error');
    at('/customer-transactions?customer=c1', <CustomerTransactionReview />);
    await screen.findByRole('option', { name: 'Small Farm' });
    fireEvent.click(screen.getByRole('button', { name: 'Last 90d' }));
    expect(await screen.findByText('This list could not be loaded')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Select customer'), { target: { value: '' } });
    expect(screen.queryByText('This list could not be loaded')).not.toBeInTheDocument();
    expect(screen.getByText('Select a customer and date range')).toBeInTheDocument();
  });
});

describe('a paged read that answers with no list', () => {
  it('Payment History shows the failed state, not "No payments yet"', async () => {
    H.failing.set('allocation_sets', 'nodata');
    at('/payment-history', <PaymentHistory />);
    expect(await screen.findByText('This list could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('No payments yet')).not.toBeInTheDocument();
  });

  it('A/R Aging shows the failed state, not zero totals', async () => {
    H.failing.set('get_ar_aging', 'nodata');
    at('/ar-aging', <ARaging />);
    expect(await screen.findByText('AR aging could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('Total Outstanding')).not.toBeInTheDocument();
  });

  it('the A/R Workspace summary says it could not be loaded', async () => {
    H.failing.set('prepay_credits', 'nodata');
    at('/accounts-receivable?tab=ledger', <AccountsReceivable />);
    expect(await screen.findByText('The money summary could not be loaded')).toBeInTheDocument();
  });
});

describe('Customer Transactions cleared mid-read', () => {
  it('clearing the customer while a read runs leaves no spinner and no rows when it lands', async () => {
    let release!: (v: unknown) => void;
    H.pending.set('get_customer_transaction_review', new Promise((r) => { release = r; }));
    at('/customer-transactions?customer=c1', <CustomerTransactionReview />);
    await screen.findByRole('option', { name: 'Small Farm' });
    fireEvent.click(screen.getByRole('button', { name: 'Last 90d' }));

    fireEvent.change(screen.getByLabelText('Select customer'), { target: { value: '' } });
    release({ data: [{ transaction_date: '2026-10-01', transaction_type: 'invoice', reference_number: 'INV-LATE', description: null, debit_cents: 100, credit_cents: 0, running_balance_cents: 100 }], error: null });
    expect(await screen.findByText('Select a customer and date range')).toBeInTheDocument();
    expect(screen.queryByText('INV-LATE')).not.toBeInTheDocument();
  });
});

describe('Payment History after a failed refresh', () => {
  it('a direct allocations read that answers with no list shows the failed state', async () => {
    H.tables.allocation_sets = [{ id: 'p1', customer_id: 'c1', total_payment_cents: 100, total_allocated_cents: 100, payment_method: 'check', check_number: 'CHK-1', reference_number: null, payment_date: '2026-10-01', season: 2027, is_active: true, notes: null, created_at: '2026-10-01T12:00:00Z', customers: { farm_name: 'Big Farm' } }];
    H.failing.set('invoice_line_allocations', 'nodata');
    at('/payment-history', <PaymentHistory />);
    fireEvent.click(await screen.findByRole('button', { name: /\d+\/\d+\/\d+/ }));
    expect(await screen.findByText("This payment's allocations could not be loaded")).toBeInTheDocument();
  });

  it('closes an open void confirmation when the list read fails', async () => {
    H.tables.allocation_sets = [{ id: 'p1', customer_id: 'c1', total_payment_cents: 100, total_allocated_cents: 100, payment_method: 'check', check_number: 'CHK-1', reference_number: null, payment_date: '2026-10-01', season: 2027, is_active: true, notes: null, created_at: '2026-10-01T12:00:00Z', customers: { farm_name: 'Big Farm' } }];
    at('/payment-history', <PaymentHistory />);
    fireEvent.click(await screen.findByRole('button', { name: /^Void$/ }));
    expect(await screen.findByRole('heading', { name: 'Void Payment' })).toBeInTheDocument();

    H.failing.set('allocation_sets', 'error');
    fireEvent.click(screen.getByRole('button', { name: /Refresh/, hidden: true }));
    expect(await screen.findByText('This list could not be loaded')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Void Payment' })).not.toBeInTheDocument();
  });

  it("closes the open payment's allocations when the list read fails", async () => {
    H.tables.allocation_sets = [{ id: 'p1', customer_id: 'c1', total_payment_cents: 100, total_allocated_cents: 100, payment_method: 'check', check_number: 'CHK-1', reference_number: null, payment_date: '2026-10-01', season: 2027, is_active: true, notes: null, created_at: '2026-10-01T12:00:00Z', customers: { farm_name: 'Big Farm' } }];
    H.tables.invoice_line_allocations = [{ id: 'a1', allocation_set_id: 'p1', invoice_id: 'i1', amount_cents: 100, split_percentage: 100, bill_to_customer_id: 'c1', created_at: '2026-10-01', invoices: { invoice_number: 'INV-OPENED' }, customers: { farm_name: 'Big Farm' } }];
    at('/payment-history', <PaymentHistory />);
    fireEvent.click(await screen.findByRole('button', { name: /\d+\/\d+\/\d+/ }));
    expect(await screen.findByText('INV-OPENED')).toBeInTheDocument();

    H.failing.set('allocation_sets', 'error');
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(await screen.findByText('This list could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('INV-OPENED')).not.toBeInTheDocument();
    expect(screen.queryByText('Invoice Allocations')).not.toBeInTheDocument();
  });
});

describe('Record Payments customer search', () => {
  beforeEach(() => { H.searchTables.add('customers'); });

  it('a failed search says it failed, not "No customers found", and Try again searches again', async () => {
    H.failing.set('customers', 'error');
    at('/payments', <PaymentAllocation />);
    fireEvent.change(screen.getByPlaceholderText('Search by name or account #...'), { target: { value: 'Big' } });

    expect(await screen.findByText(/Customer search failed/)).toBeInTheDocument();
    expect(screen.queryByText('No customers found')).not.toBeInTheDocument();

    H.failing.delete('customers');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /Big Farm/ })).toBeInTheDocument();
  });

  it('failed open invoices offer Try again, which loads them', async () => {
    H.failing.set('invoices', 'error');
    at('/payments', <PaymentAllocation />);
    fireEvent.change(screen.getByPlaceholderText('Search by name or account #...'), { target: { value: 'Big' } });
    fireEvent.click(await screen.findByRole('button', { name: /Big Farm/ }));

    expect(await screen.findByText(/Open invoices could not be loaded/)).toBeInTheDocument();

    H.failing.delete('invoices');
    H.tables.invoices = [{ id: 'i1', customer_id: 'c1', invoice_number: 'INV-OPEN', invoice_date: '2026-09-01', due_date: null, invoice_type: 'chemical', total_amount_cents: 5000, balance_cents: 5000, status: 'posted', deleted_at: null, created_at: '2026-09-01' }];
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('INV-OPEN')).toBeInTheDocument();
  });
});
