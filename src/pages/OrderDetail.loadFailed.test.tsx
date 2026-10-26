/**
 * OrderDetail.loadFailed.test.tsx — To-Do 10.5, Order Detail: a read the page depends on that
 * fails (an error, no list, or not a list) says "could not be loaded" with Try again. It must not
 * show $0 invoiced or re-offer Create Invoice for an order whose invoices could not be read, and a
 * failed order read must not say "Order not found".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';

type Mode = 'error' | 'nodata' | 'notlist';

const H = vi.hoisted(() => ({
  tables: {} as Record<string, unknown>,
  // 'throws' rejects instead of answering.
  failing: new Map<string, 'error' | 'nodata' | 'notlist' | 'throws'>(),
  // One stable toast: fetchOrder depends on it, so a new function per render
  // would re-run the load effect on every render.
  toast: vi.fn(),
}));

function reply(table: string): { data: unknown; error: unknown } {
  const mode = H.failing.get(table);
  if (mode === 'error') return { data: null, error: { message: 'connection reset', code: 'XX000' } };
  if (mode === 'nodata') return { data: null, error: null };
  if (mode === 'notlist') return { data: { unexpected: true }, error: null };
  return { data: H.tables[table] ?? [], error: null };
}

// A query that ignores its filters and answers with the table's rows (or its failure).
function query(table: string): Record<string, unknown> {
  const q: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          (H.failing.get(table) === 'throws' ? reject(new Error('socket hang up')) : resolve(reply(table)));
      }
      if (prop === 'maybeSingle' || prop === 'single') {
        return () => {
          const r = reply(table);
          return Promise.resolve({ data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error });
        };
      }
      return () => q;
    },
  });
  return q;
}

vi.mock('../lib/db', () => ({
  supabase: {
    from: (table: string) => query(table === 'invoices_postable' ? 'invoices' : table),
    rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
  },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((d) => d),
  describePostInvoiceBlock: vi.fn(() => null),
  hasRpcCode: vi.fn(() => false),
  RpcErrorCodes: {},
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyOrderStatusChange: vi.fn() }));
vi.mock('../lib/dateUtils', () => ({ parseLocalDate: vi.fn((d: string) => new Date(d)) }));
vi.mock('../components/team/QuickTaskModal', () => ({ default: () => null }));
vi.mock('../components/team/RelatedNotes', () => ({ default: () => null }));
// Cost columns are admin-only reads of their own; these tests are about the order reads.
vi.mock('../lib/costFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/costFields')>()),
  withAdminCost: async (_table: string, row: unknown) => row,
  withAdminCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
}));

import OrderDetail from './OrderDetail';

const FAILED = 'This order could not be loaded';

// A confirmed, unbilled order: Create Invoice shows for it only while no active invoice covers it.
const order = {
  id: 'ord-1', order_number: 'ORD-0042', status: 'confirmed', customer_id: 'cust-1',
  order_date: '2026-10-01', total_price: 500, order_name: 'Fall Order', notes: '',
  created_at: '2026-10-01T00:00:00Z', delivery_priority: 'normal',
};
const item = {
  id: 'oi-1', order_id: 'ord-1', product_id: 'p1', quantity: 2, unit_price: 250, total_price: 500,
  section_name: 'General', product: { product_name: 'Widget 2.5 GL' },
};
const invoice = {
  id: 'inv-1', order_id: 'ord-1', invoice_number: 'CS-0042', invoice_type: 'chemical_sale',
  status: 'posted', deleted_at: null, total_amount_cents: 50000, paid_amount_cents: 0,
  prepay_applied_cents: 0, balance_cents: 50000, write_off_cents: 0, invoice_group_id: null,
};

const open = () => render(
  <MemoryRouter initialEntries={['/orders/ord-1']}>
    <Routes>
      <Route path="/orders/:id" element={<OrderDetail />} />
    </Routes>
  </MemoryRouter>,
);
const tryAgain = () => fireEvent.click(screen.getByRole('button', { name: /Try again/ }));

beforeEach(() => {
  vi.clearAllMocks();
  H.failing = new Map();
  H.tables = { orders: [order], customers: [{ id: 'cust-1', farm_name: 'Big Farm' }], order_items: [item] };
});
afterEach(cleanup);

describe('Order Detail', () => {
  it('an unbilled order still offers Create Invoice (the control for the cases below)', async () => {
    open();
    expect(await screen.findByRole('button', { name: /Create Invoice/ })).toBeInTheDocument();
  });

  it.each<Mode>(['error', 'nodata', 'notlist'])(
    'a %s linked-invoices read says could not be loaded, not zero dollars invoiced or Create Invoice',
    async (mode) => {
      H.tables.invoices = [invoice];
      H.failing.set('invoices', mode);
      open();
      expect(await screen.findByText(FAILED)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Create Invoice/ })).not.toBeInTheDocument();
      expect(screen.queryByText('Total Invoiced')).not.toBeInTheDocument();
      expect(screen.queryByText('$0.00')).not.toBeInTheDocument();

      // Try again re-reads; the invoice that exists now hides Create Invoice.
      H.failing.delete('invoices');
      tryAgain();
      expect((await screen.findAllByText('CS-0042')).length).toBeGreaterThan(0);
      expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Create Invoice/ })).not.toBeInTheDocument();
    },
  );

  it.each<[string, Mode]>([
    ['order_items', 'error'], ['order_items', 'nodata'], ['order_items', 'notlist'],
    ['deliveries', 'error'], ['deliveries', 'nodata'],
    ['order_shares', 'error'], ['order_shares', 'nodata'],
  ])('a %s read that answers with %s says could not be loaded', async (table, mode) => {
    H.failing.set(table, mode);
    open();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create Invoice/ })).not.toBeInTheDocument();
    H.failing.delete(table);
    tryAgain();
    expect(await screen.findByRole('button', { name: /Create Invoice/ })).toBeInTheDocument();
  });

  it.each<Mode>(['error', 'nodata'])('a %s customer read says could not be loaded, not an order with no customer', async (mode) => {
    H.failing.set('customers', mode);
    open();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create Invoice/ })).not.toBeInTheDocument();
  });

  it.each(['throws', 'notlist'] as const)('a driver-name lookup that %s leaves the order on screen (names are display only)', async (mode) => {
    H.tables.deliveries = [{ id: 'd1', order_id: 'ord-1', delivery_number: 'DEL-0042', status: 'scheduled', scheduled_date: '2026-10-02', assigned_driver: 'drv-1' }];
    H.failing.set('profile_public_view', mode);
    open();
    // A scheduled delivery hides Create Invoice by design, so the order's own number and its
    // delivery are what show it loaded.
    expect((await screen.findAllByText('DEL-0042')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('ORD-0042').length).toBeGreaterThan(0);
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
  });

  it('a failed order read says could not be loaded, not "Order not found"', async () => {
    H.failing.set('orders', 'error');
    open();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(screen.queryByText('Order not found')).not.toBeInTheDocument();
  });

  it('moving from a real order to a missing one says "Order not found", not the previous order', async () => {
    let go: (to: string) => void = () => {};
    function Probe() {
      const navigate = useNavigate();
      useEffect(() => { go = navigate; }, [navigate]);
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/orders/ord-1']}>
        <Routes>
          <Route path="/orders/:id" element={<OrderDetail />} />
        </Routes>
        <Probe />
      </MemoryRouter>,
    );
    expect((await screen.findAllByText('ORD-0042')).length).toBeGreaterThan(0);
    H.tables.orders = [];
    act(() => { go('/orders/missing'); });
    expect(await screen.findByText('Order not found')).toBeInTheDocument();
    expect(screen.queryByText('ORD-0042')).not.toBeInTheDocument();
  });

  it.each(['order_item_field_allocations', 'fields', 'field_billing_defaults'])(
    'a %s read with no list reports the field split details as not loaded',
    async (table) => {
      H.failing.set(table, 'nodata');
      open();
      await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', 'Failed to load field split details. Please refresh.'));
    },
  );

  it('a missing order still says "Order not found"', async () => {
    H.tables.orders = [];
    open();
    expect(await screen.findByText('Order not found')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(FAILED)).not.toBeInTheDocument());
  });
});
