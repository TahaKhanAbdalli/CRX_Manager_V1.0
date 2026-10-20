/**
 * SalesReports.paging.test.tsx — Goal 4: the sales report reads every line.
 *
 * get_sales_detail_report returns one row per order line, and the server silently cuts
 * a function's rows off at 1,000, so the report's totals used to stop there. The fake
 * server below behaves like PostgREST: no reply holds more than 1,000 rows, `.range()`
 * returns that slice, and `{ count: 'exact' }` gets the count of every row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  auth: { role: 'sales_rep' as 'admin' | 'sales_rep' },
  tables: {} as Record<string, Row[]>,
  functions: {} as Record<string, Row[]>,
  failPage: null as { source: string; from: number } | null,
  // While set, report-function reads wait for it, like a slow network.
  hold: null as Promise<void> | null,
  // The columns each read sorted on, by table or function.
  orders: {} as Record<string, string[]>,
  toast: vi.fn(),
}));

const SERVER_ROW_CAP = 1000;

function serverRead(source: string, all: Row[]): Record<string, unknown> {
  let countRequested = false;
  let range: [number, number] | null = null;
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ['eq', 'limit', 'not', 'in']) b[m] = self;
  const sorted: string[] = [];
  H.orders[source] = sorted;
  b.order = (column: string) => { sorted.push(column); return b; };
  b.select = (_columns: string, options?: { count?: string }) => { countRequested = Boolean(options?.count); return b; };
  b.range = (from: number, to: number) => { range = [from, to]; return b; };
  const settle = () => {
    if (H.failPage?.source === source && range && range[0] >= H.failPage.from) {
      return { data: null, error: { message: 'connection reset' }, count: null };
    }
    const [from, to] = range ?? [0, Infinity];
    return { data: all.slice(from, to + 1).slice(0, SERVER_ROW_CAP), error: null, count: countRequested ? all.length : null };
  };
  b.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    (source.startsWith('get_') && H.hold ? H.hold : Promise.resolve()).then(settle).then(onFulfilled, onRejected);
  return b;
}

vi.mock('../lib/db', () => ({
  supabase: {
    from: (table: string) => serverRead(table, H.tables[table] ?? []),
    rpc: (name: string, _args: unknown, options?: { count?: string }) => {
      const read = serverRead(name, H.functions[name] ?? []);
      return (read.select as (c: string, o?: { count?: string }) => unknown)('*', options);
    },
  },
  assertRpcResult: <T,>(data: T) => data,
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => H.auth }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../components/products/ProductSearchPicker', () => ({ default: () => null }));
vi.mock('../lib/csvExport', () => ({ exportToCSV: vi.fn(), fmtCSV: vi.fn(), fmtDateCSV: vi.fn() }));
// Drawing 1,500 real table rows is slow; the table only reports the rows it was given.
vi.mock('../components/ui/DataTable', () => ({
  default: ({ data }: { data: unknown[] }) => <p data-testid="table-rows">{data.length}</p>,
}));

import SalesReports from './SalesReports';

const TOTAL = 1500;

const line = (i: number): Row => ({
  order_date: '2026-10-01', order_number: `ORD-${i}`, customer_name: 'Big Farm', customer_id: 'c1',
  product_name: 'Roundup', product_id: 'p1', sku: 'R1', category: 'Herbicide', quantity: 1, unit: 'GL',
  unit_price: 10, total_price: 10, cost: null, profit: null, margin_pct: null, sales_rep_name: 'Rep', invoice_number: null, season: 2027,
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  H.failPage = null;
  H.hold = null;
  H.orders = {};
  H.tables = {
    // 1,500 active customers: the customer filter used to list only the first 1,000.
    customers: Array.from({ length: TOTAL }, (_, i) => ({ id: `c${i}`, farm_name: `Farm ${String(i).padStart(4, '0')}` })),
    profile_public_view: [],
    products: [{ id: 'p1', category: 'Herbicide' }],
  };
  H.functions = { get_sales_detail_report: Array.from({ length: TOTAL }, (_, i) => line(i)) };
});
afterEach(() => { cleanup(); });

const card = (label: string) => screen.getByText(label).parentElement!;

describe('Sales Reports past the 1,000-row server cap', () => {
  it('totals all 1,500 order lines, not the first 1,000', async () => {
    render(<MemoryRouter><SalesReports /></MemoryRouter>);

    await waitFor(() => expect(screen.getByTestId('table-rows')).toHaveTextContent(String(TOTAL)));
    // 1,500 lines at $10.00: a read stopped at 1,000 would show $10,000.00 and 1,000 orders.
    expect(card('Total Revenue')).toHaveTextContent('$15,000');
    expect(card('Orders')).toHaveTextContent('1,500');
  });

  it('sorts the paged report on every column it returns, so pages cannot shift between calls', async () => {
    render(<MemoryRouter><SalesReports /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('table-rows')).toHaveTextContent(String(TOTAL)));

    const sortedOn = H.orders.get_sales_detail_report;
    expect(sortedOn.slice(0, 3)).toEqual(['order_date', 'customer_name', 'product_name']);
    expect([...sortedOn].sort()).toEqual(Object.keys(line(0)).sort());
  });

  it('cannot export while a report is still loading', async () => {
    let release = () => {};
    H.hold = new Promise<void>((r) => { release = r; });
    render(<MemoryRouter><SalesReports /></MemoryRouter>);

    await waitFor(() => expect(screen.getByRole('button', { name: 'CSV' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'PDF' })).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByRole('button', { name: 'CSV' })).toBeEnabled());
    expect(screen.getByTestId('table-rows')).toHaveTextContent(String(TOTAL));
  });

  it('shows an error and no totals, not the first 1,000 lines, when a later page fails', async () => {
    H.failPage = { source: 'get_sales_detail_report', from: 1 };
    render(<MemoryRouter><SalesReports /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded completely');
    expect(screen.queryByText('Total Revenue')).not.toBeInTheDocument();
    expect(screen.queryByTestId('table-rows')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CSV' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'PDF' })).toBeDisabled();
  });
});
