/**
 * Reports.paging.test.tsx — Goal 4: report lists read every row.
 *
 * Commissions, posted applications and the report functions (customer balance here)
 * used to be one request, which the server silently cuts off at 1,000 rows (posted
 * applications at 500). The fake server below behaves like PostgREST: no reply holds
 * more than 1,000 rows, `.range()` returns that slice, and `{ count: 'exact' }` gets
 * the count of every matching row. Tables and report functions are paged the same way.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  auth: {
    role: 'admin' as 'admin' | 'sales_rep',
    profile: { id: 'admin-1', role: 'admin' as 'admin' | 'sales_rep' },
    deniedPages: [] as string[],
  },
  tables: {} as Record<string, Row[]>,
  functions: {} as Record<string, Row[]>,
  // A table or function whose pages from this offset on fail, like a dropped connection.
  failPage: null as { source: string; from: number } | null,
  reads: [] as string[],
  // The columns each read sorted on, by table or function.
  orders: {} as Record<string, string[]>,
  toast: vi.fn(),
  exportToCSV: vi.fn(),
  // Every report-function call's name and arguments, in order.
  rpcCalls: [] as { name: string; args: Record<string, unknown> | undefined }[],
}));

const SERVER_ROW_CAP = 1000;

function serverRead(source: string, all: () => Row[]): Record<string, unknown> {
  let rows = all();
  let countRequested = false;
  let range: [number, number] | null = null;
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ['eq', 'neq', 'limit', 'not', 'is', 'gte', 'lte']) b[m] = self;
  const sorted: string[] = [];
  H.orders[source] = sorted;
  b.order = (column: string) => { sorted.push(column); return b; };
  b.select = (_columns: string, options?: { count?: string }) => { countRequested = Boolean(options?.count); return b; };
  b.in = (column: string, values: unknown[]) => {
    if (column !== 'status') rows = rows.filter((r) => values.includes(r[column]));
    return b;
  };
  b.range = (from: number, to: number) => { range = [from, to]; H.reads.push(source); return b; };
  const settle = () => {
    if (H.failPage?.source === source && range && range[0] >= H.failPage.from) {
      return { data: null, error: { message: 'connection reset' }, count: null };
    }
    const [from, to] = range ?? [0, Infinity];
    return { data: rows.slice(from, to + 1).slice(0, SERVER_ROW_CAP), error: null, count: countRequested ? rows.length : null };
  };
  b.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve().then(settle).then(onFulfilled, onRejected);
  return b;
}

vi.mock('../lib/db', () => ({
  supabase: {
    from: (table: string) => serverRead(table, () => H.tables[table] ?? []),
    rpc: (name: string, args: Record<string, unknown> | undefined, options?: { count?: string }) => {
      // Cost fields come back as one object keyed by id (none here), not as rows.
      if (name === 'get_admin_cost_fields') return Promise.resolve({ data: {}, error: null });
      H.rpcCalls.push({ name, args });
      // The profitability report answers per grouping: H.functions['get_profitability_report:customer'].
      const source = name === 'get_profitability_report' ? `${name}:${String(args?.p_group_by)}` : name;
      const read = serverRead(source, () => H.functions[source] ?? []);
      return (read.select as (c: string, o?: { count?: string }) => unknown)('*', options);
    },
  },
  assertRpcResult: <T,>(data: T) => {
    if (data == null) throw new Error('RPC returned no data');
    return data;
  },
  sanitizeError: (error: unknown) => String(error),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => H.auth }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/csvExport', () => ({
  exportToCSV: H.exportToCSV,
  fmtCSV: vi.fn(),
  fmtDateCSV: vi.fn(),
  fmtDateOnlyCSV: vi.fn(),
}));
vi.mock('../lib/yearEndSummaryPdf', () => ({ downloadYearEndSummaryPdf: vi.fn(), downloadBatchYearEndSummaries: vi.fn() }));
vi.mock('../components/reports/LogbookReport', () => ({ default: () => <div>Logbook</div> }));
vi.mock('../components/reports/YearEndSummaryDialog', () => ({ default: () => null }));
// Drawing thousands of real table rows is slow; each table only reports the rows it was given.
vi.mock('../components/ui/DataTable', () => ({
  default: ({ data, emptyTitle }: { data: unknown[]; emptyTitle?: string }) => (
    <p data-testid={`rows:${emptyTitle}`} data-last={JSON.stringify(data[data.length - 1] ?? null)}>{data.length}</p>
  ),
}));

import Reports from './Reports';

const TOTAL = 1500;
const many = (make: (i: number) => Row): Row[] => Array.from({ length: TOTAL }, (_, i) => make(i));

const openTab = async (category: string, tab: string) => {
  render(<MemoryRouter><Reports /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: category }));
  fireEvent.click(await screen.findByRole('button', { name: tab }));
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  H.auth.role = 'admin';
  H.auth.profile = { id: 'admin-1', role: 'admin' };
  H.failPage = null;
  H.reads = [];
  H.orders = {};
  H.tables = {};
  H.functions = {};
  H.rpcCalls = [];
});
afterEach(() => { cleanup(); });

describe('Reports past the 1,000-row server cap', () => {
  it('sums the unpaid commission total over all 1,500 commissions, not the first 1,000', async () => {
    H.tables.commissions = many((i) => ({
      id: `commission-${String(i).padStart(4, '0')}`,
      status: 'pending',
      commission_amount: '1.00',
      order_date: '2026-09-01',
      recipient: 'Alex',
      customer_name: 'Big Farm',
    }));
    await openTab('Profitability', 'Commissions');

    await waitFor(() => expect(screen.getByTestId('rows:No commissions')).toHaveTextContent(String(TOTAL)));
    expect(screen.getByText(/Unpaid commissions:/).parentElement).toHaveTextContent('$1,500');
  });

  it('lists every customer balance row the report function returns', async () => {
    H.functions.get_customer_balance_listing = many((i) => ({
      customer_id: `customer-${i}`,
      farm_name: `Farm ${i}`,
      total_invoiced: 100,
      total_paid: 0,
      prepay_applied: 0,
      outstanding_balance: 100,
      open_credit: 0,
      invoice_count: 1,
      oldest_unpaid_date: '2026-09-01',
    }));
    await openTab('Financial', 'Customer Balance');

    await waitFor(() => expect(screen.getByTestId('rows:No outstanding balances')).toHaveTextContent(String(TOTAL)));
    // Pages are separate calls: the function's order, then its unique customer id.
    expect(H.orders.get_customer_balance_listing).toEqual(['outstanding_balance', 'customer_id']);
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    expect(H.exportToCSV).toHaveBeenCalledTimes(1);
    const exported = H.exportToCSV.mock.calls[0][0] as Row[];
    expect(exported).toHaveLength(TOTAL);
    expect(new Set(exported.map((r) => r.customer_id)).size).toBe(TOTAL);
  });

  it('lists every posted application (this list used to stop at 500), with applicator names', async () => {
    H.tables.application_records = many((i) => ({
      id: `app-${String(i).padStart(4, '0')}`,
      record_number: `APP-${i}`,
      application_date: '2026-09-01',
      customer: { farm_name: 'Big Farm' },
      field: { field_name: 'North 40' },
      applicator_id: i === TOTAL - 1 ? 'applicator-1' : null,
      applicator_name: null,
      invoice_id: `invoice-${i}`,
    }));
    H.tables.profile_public_view = [{ id: 'applicator-1', full_name: 'Pat Sprayer' }];
    await openTab('Operational', 'Posted Applications');

    const table = screen.getByTestId('rows:No posted applications');
    await waitFor(() => expect(table).toHaveTextContent(String(TOTAL)));
    // The last record, only on the second page, carries its applicator's name.
    const last = JSON.parse(table.getAttribute('data-last') ?? 'null') as Row;
    expect(last).toMatchObject({ record_number: `APP-${TOTAL - 1}`, applicator_name: 'Pat Sprayer' });
  });

  it('reads profit by customer, product and month from the server report (To-Do 0.6), every group', async () => {
    const group = (key: string, revenue: number) => ({
      group_key: key, total_revenue: revenue, total_cost: revenue / 2, total_profit: revenue / 2,
      margin_pct: 50, order_count: 2, units_sold: 10,
    });
    H.functions['get_profitability_report:customer'] = many((i) => group(`Farm ${String(i).padStart(4, '0')}`, i + 1));
    H.functions['get_profitability_report:product'] = [group('Product A', 900), group('Product B', 1200)];
    H.functions['get_profitability_report:month'] = [group('2026-08', 2100), group('2026-09', 900)];
    render(<MemoryRouter><Reports /></MemoryRouter>);

    // By Customer opens first: every one of the 1,500 groups, highest revenue first.
    const customers = await screen.findByTestId('rows:No customer data');
    await waitFor(() => expect(customers).toHaveTextContent(String(TOTAL)));
    expect(JSON.parse(customers.getAttribute('data-last') ?? 'null')).toMatchObject({ farm_name: 'Farm 0000', total_revenue: 1, total_profit: 0.5, margin_pct: 50, order_count: 2 });
    expect(H.orders['get_profitability_report:customer']).toEqual(['group_key']);
    expect(H.rpcCalls.filter((c) => c.name === 'get_profitability_report').map((c) => c.args)).toContainEqual(
      { p_group_by: 'customer', p_start_date: undefined, p_end_date: undefined });
    // No order or order-line table is added up in the browser any more.
    expect(H.reads).not.toContain('orders');
    expect(H.reads).not.toContain('order_items');

    fireEvent.change(screen.getByText('Start Date').parentElement!.querySelector('input')!, { target: { value: '2026-08-01' } });
    await waitFor(() => expect(H.rpcCalls.map((c) => c.args)).toContainEqual(
      { p_group_by: 'customer', p_start_date: '2026-08-01', p_end_date: undefined }));

    fireEvent.click(screen.getByRole('button', { name: 'By Product' }));
    const products = await screen.findByTestId('rows:No product data');
    await waitFor(() => expect(products).toHaveTextContent('2'));
    expect(JSON.parse(products.getAttribute('data-last') ?? 'null')).toMatchObject({ product_name: 'Product A', units_sold: 10 });

    fireEvent.click(screen.getByRole('button', { name: 'Revenue Summary' }));
    const months = await screen.findByTestId('rows:No revenue data');
    await waitFor(() => expect(months).toHaveTextContent('2'));
    // Newest month first: the last row is August.
    expect(JSON.parse(months.getAttribute('data-last') ?? 'null')).toEqual({ month: '2026-08', revenue: 2100, profit: 1050, orders: 2 });
    expect(H.rpcCalls.map((c) => c.args?.p_group_by)).toEqual(expect.arrayContaining(['customer', 'product', 'month']));
  });

  it('shows an error, not part of the profit report, when a later page of it fails', async () => {
    H.functions['get_profitability_report:customer'] = many((i) => ({ group_key: `Farm ${i}`, total_revenue: 1 }));
    H.failPage = { source: 'get_profitability_report:customer', from: 1 };
    render(<MemoryRouter><Reports /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded completely');
    expect(screen.queryByTestId('rows:No customer data')).not.toBeInTheDocument();
    expect(H.toast).toHaveBeenCalledWith('error', 'Failed to load customer profitability.');
  });

  it('shows an error and blocks export, not the first 1,000 rows, when a later page fails', async () => {
    H.functions.get_customer_balance_listing = many((i) => ({ customer_id: `customer-${i}`, farm_name: `Farm ${i}` }));
    H.failPage = { source: 'get_customer_balance_listing', from: 1 };
    await openTab('Financial', 'Customer Balance');

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded completely');
    expect(screen.queryByTestId('rows:No outstanding balances')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export CSV/ })).toBeDisabled();
  });

  it('reads the Year-End customer list once, even when there are no active customers', async () => {
    H.tables.customers = [];
    render(<MemoryRouter><Reports /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Year-End Summaries' }));

    await waitFor(() => expect(H.reads.filter((s) => s === 'customers')).toHaveLength(1));
    // An empty result leaves the list length at 0, so the effect has nothing new to run on.
    await new Promise((r) => setTimeout(r, 200));
    expect(H.reads.filter((s) => s === 'customers')).toHaveLength(1);
  });

  it('shows a dash, not $0, for unpaid commissions when the commission list fails', async () => {
    H.tables.commissions = many((i) => ({ id: `commission-${i}`, status: 'pending', commission_amount: '1.00', order_date: '2026-09-01' }));
    H.failPage = { source: 'commissions', from: 1 };
    await openTab('Profitability', 'Commissions');

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded completely');
    expect(screen.getByText(/Unpaid commissions:/).parentElement).toHaveTextContent('—');
    expect(screen.queryByTestId('rows:No commissions')).not.toBeInTheDocument();
  });
});
