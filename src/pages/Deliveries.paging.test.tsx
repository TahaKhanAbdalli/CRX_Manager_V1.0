/**
 * Deliveries.paging.test.tsx — Goal 4: the Deliveries list reads every delivery.
 *
 * The list used to be one request capped at 500 rows, so deliveries past the cap
 * vanished from the list, its counts and its export. The fake server below behaves
 * like PostgREST: no reply holds more than 1,000 rows, `.range()` returns that slice,
 * and a select with `{ count: 'exact' }` gets the count of every matching row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  auth: { role: 'admin', profile: { id: 'user-1', role: 'admin' }, deniedPages: [] as string[] },
  tables: {} as Record<string, Row[]>,
  // A table whose pages from this offset on fail, like a dropped connection mid-read.
  failPage: null as { table: string; from: number } | null,
  ranges: [] as Array<{ table: string; from: number; to: number }>,
  toast: vi.fn(),
  exportToCSV: vi.fn(),
}));

const SERVER_ROW_CAP = 1000;

function serverQuery(table: string): Record<string, unknown> {
  let rows = H.tables[table] ?? [];
  let countRequested = false;
  let head = false;
  let range: [number, number] | null = null;
  const b: Record<string, unknown> = {};
  const self = () => b;
  for (const m of ['eq', 'neq', 'order', 'limit', 'not', 'is', 'gte', 'lte']) b[m] = self;
  b.select = (_columns: string, options?: { count?: string; head?: boolean }) => {
    countRequested = Boolean(options?.count);
    head = Boolean(options?.head);
    return b;
  };
  b.in = (column: string, values: unknown[]) => { rows = rows.filter((r) => values.includes(r[column])); return b; };
  b.range = (from: number, to: number) => { range = [from, to]; H.ranges.push({ table, from, to }); return b; };
  const settle = () => {
    if (H.failPage?.table === table && range && range[0] >= H.failPage.from) {
      return { data: null, error: { message: 'connection reset' }, count: null };
    }
    if (head) return { data: null, error: null, count: rows.length };
    const [from, to] = range ?? [0, Infinity];
    return { data: rows.slice(from, to + 1).slice(0, SERVER_ROW_CAP), error: null, count: countRequested ? rows.length : null };
  };
  b.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve().then(settle).then(onFulfilled, onRejected);
  return b;
}

vi.mock('../lib/db', () => ({
  supabase: { from: (table: string) => serverQuery(table), rpc: vi.fn(() => Promise.resolve({ data: null, error: null })) },
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
  assertRpcResult: vi.fn((d) => d),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => H.auth }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyDeliveryCompleted: vi.fn() }));
vi.mock('../lib/csvExport', () => ({ exportToCSV: H.exportToCSV, fmtDateCSV: vi.fn() }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));
vi.mock('../components/deliveries/BatchCancelModal', () => ({ default: () => null }));
vi.mock('../components/deliveries/QuickDeliveryModal', () => ({ default: () => null }));
vi.mock('../components/deliveries/DeliveryCalendar', () => ({ default: () => null }));
vi.mock('../components/customers/CustomerDrawer', () => ({ default: () => null }));
// Drawing 1,500 real table rows takes over 30 seconds here; this test is about what the
// page loads, so the table only reports the rows it was given (the export checks each one).
vi.mock('../components/ui/DataTable', () => ({
  default: ({ data, filters }: { data: unknown[]; filters?: unknown }) => (
    <div>
      {filters as never}
      <p data-testid="table-rows">{data.length}</p>
    </div>
  ),
}));

import Deliveries from './Deliveries';
import { localToday } from '../lib/dateUtils';

const TOTAL = 1500;

function deliveries(): Row[] {
  return Array.from({ length: TOTAL }, (_, i) => ({
    id: `del-${String(i).padStart(4, '0')}`,
    delivery_number: `DEL-${String(i).padStart(4, '0')}`,
    status: 'scheduled',
    scheduled_date: localToday(),
    customer_id: 'cust-1',
    assigned_driver: null,
    customer: { farm_name: 'Big Farm', parent_customer_id: null },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  H.auth.role = 'admin';
  H.auth.profile = { id: 'user-1', role: 'admin' };
  H.failPage = null;
  H.ranges = [];
  H.tables = {
    deliveries: deliveries(),
    // The last delivery's lines exist only past the first id chunk and the first page.
    delivery_items: [
      { id: 'item-a', delivery_id: 'del-0000', product_id: 'product-1', quantity: 1 },
      { id: 'item-b', delivery_id: 'del-1499', product_id: 'product-1', quantity: 1 },
      { id: 'item-c', delivery_id: 'del-1499', product_id: 'product-1', quantity: 1 },
    ],
    customers: [{ id: 'cust-1', farm_name: 'Big Farm' }],
    profile_public_view: [],
    inventory: [{ id: 'inv-1', product_id: 'product-1', quantity_available: 100 }],
    delivery_remainders: [],
  };
});

describe('Deliveries list past the 1,000-row server cap', () => {
  it('reads every delivery, so the counts and the export include all 1,500', async () => {
    render(<MemoryRouter><Deliveries /></MemoryRouter>);

    // Every delivery is scheduled today: a read stopped at 1,000 (or the old 500) shows less.
    const card = (await screen.findByText('Scheduled Today', {}, { timeout: 15000 })).closest('div')!.parentElement!;
    expect(card).toHaveTextContent(String(TOTAL));
    expect(screen.getByTestId('table-rows')).toHaveTextContent(String(TOTAL));
    // Paged by range, with the 50-row seam overlap, rather than one capped request.
    expect(H.ranges.filter((r) => r.table === 'deliveries').slice(0, 2).map((r) => [r.from, r.to]))
      .toEqual([[0, 999], [950, 1949]]);

    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(H.exportToCSV).toHaveBeenCalledTimes(1));
    const exported = H.exportToCSV.mock.calls[0][0] as Array<{ delivery_number: string; item_count: number }>;
    // Every delivery exactly once, each with only its own lines counted.
    expect(exported).toHaveLength(TOTAL);
    expect(new Set(exported.map((d) => d.delivery_number)).size).toBe(TOTAL);
    const byNumber = new Map(exported.map((d) => [d.delivery_number, d.item_count]));
    expect(byNumber.get('DEL-1499')).toBe(2);
    expect(byNumber.get('DEL-0000')).toBe(1);
    expect(byNumber.get('DEL-0001')).toBe(0);
  }, 30000);

  it('shows an error, not the first 1,000 deliveries, when a later page fails', async () => {
    H.failPage = { table: 'deliveries', from: 1 };
    render(<MemoryRouter><Deliveries /></MemoryRouter>);

    expect(await screen.findByRole('alert', {}, { timeout: 15000 })).toHaveTextContent('Deliveries could not be loaded');
    expect(screen.queryByText('DEL-0000')).not.toBeInTheDocument();
    expect(screen.queryByText('Scheduled Today')).not.toBeInTheDocument();
    expect(H.toast).toHaveBeenCalledWith('error', 'Failed to load deliveries. Please try again.');
  }, 30000);

  it('keeps a warning on screen when the stock check fails, so no badge is not read as enough stock', async () => {
    H.failPage = { table: 'inventory', from: 0 };
    render(<MemoryRouter><Deliveries /></MemoryRouter>);

    expect(await screen.findByRole('alert', {}, { timeout: 15000 })).toHaveTextContent('Stock shortage warnings could not be checked');
    // The list itself still loaded in full.
    expect(screen.getByTestId('table-rows')).toHaveTextContent(String(TOTAL));
  }, 30000);

  it("shows a driver an error, not \"no deliveries\", when their list fails to load", async () => {
    H.auth.role = 'driver';
    H.auth.profile = { id: 'driver-1', role: 'driver' };
    H.failPage = { table: 'deliveries', from: 1 };
    render(<MemoryRouter><Deliveries /></MemoryRouter>);

    expect(await screen.findByRole('alert', {}, { timeout: 15000 })).toHaveTextContent('Your deliveries could not be loaded');
    expect(screen.queryByText('No deliveries scheduled for today.')).not.toBeInTheDocument();
  }, 30000);

  it('keeps the stock-check warning on the driver dashboard too', async () => {
    H.auth.role = 'driver';
    H.auth.profile = { id: 'driver-1', role: 'driver' };
    H.failPage = { table: 'inventory', from: 0 };
    render(<MemoryRouter><Deliveries /></MemoryRouter>);

    expect(await screen.findByRole('alert', {}, { timeout: 15000 })).toHaveTextContent('Stock shortage warnings could not be checked');
    expect(screen.getAllByText('DEL-1499').length).toBeGreaterThan(0);
  }, 30000);

  it('shows an error when the item counts cannot be read, instead of zero items', async () => {
    H.failPage = { table: 'delivery_items', from: 0 };
    render(<MemoryRouter><Deliveries /></MemoryRouter>);

    expect(await screen.findByRole('alert', {}, { timeout: 15000 })).toHaveTextContent('Deliveries could not be loaded');
    expect(screen.queryByText('DEL-0000')).not.toBeInTheDocument();
  }, 30000);
});
