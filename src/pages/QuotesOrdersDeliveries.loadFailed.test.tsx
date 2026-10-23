/**
 * QuotesOrdersDeliveries.loadFailed.test.tsx — To-Do 10.5, quotes / orders /
 * deliveries / returns: a read that fails (an error, or no list at all) says
 * "could not be loaded" with Try again, never "No … found", 0% fulfilled, or a
 * $0 return with live Approve / Receive / Credit buttons; Try again shows the rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { getSeasonDates } from '../utils/season';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  functions: {} as Record<string, unknown>,
  // Table or function name -> how its reads fail.
  failing: new Map<string, 'error' | 'nodata'>(),
  // Function name -> replies the test releases later, one per call, in call order.
  pending: new Map<string, Array<Promise<unknown>>>(),
  toast: vi.fn(),
}));

// A query that ignores its filters and answers with the given rows (or a failure).
function fixedQuery(reply: { data: unknown; error: unknown; count: number | null }): Record<string, unknown> {
  const q: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(reply);
      if (prop === 'maybeSingle' || prop === 'single') {
        return () => Promise.resolve({
          data: Array.isArray(reply.data) ? (reply.data[0] ?? null) : reply.data,
          error: reply.error,
        });
      }
      return () => q;
    },
  });
  return q;
}

function replyFor(name: string, rows: unknown): { data: unknown; error: unknown; count: number | null } {
  const mode = H.failing.get(name);
  if (mode === 'error') return { data: null, error: { message: 'connection reset' }, count: null };
  if (mode === 'nodata') return { data: null, error: null, count: null };
  return { data: rows, error: null, count: Array.isArray(rows) ? rows.length : null };
}

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  const client = {
    from: (table: string) => fixedQuery(replyFor(table, H.tables[table] ?? [])),
    rpc: (name: string) => {
      const slow = H.pending.get(name)?.shift();
      if (slow) return { then: (resolve: (v: unknown) => unknown) => slow.then(resolve) };
      return fixedQuery(replyFor(name, H.functions[name] ?? []));
    },
  };
  return { ...actual, supabase: client, supabaseUntyped: client };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyLargeOrder: vi.fn(), notifyCreditLimitExceeded: vi.fn() }));
vi.mock('../lib/metrics', () => ({ trackBusinessEvent: vi.fn() }));
vi.mock('../lib/orderConfirmedEmail', () => ({ sendOrderConfirmedEmail: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../contexts/BelowCostApprovalContext', () => ({
  useBelowCostApproval: () => ({ runWithBelowCostApproval: (run: (reason: string | null) => unknown) => run(null) }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'idem', resetKey: vi.fn(), getKeyFor: () => 'idem', resetKeyFor: vi.fn() }),
}));

import Quotes from './Quotes';
import Orders from './Orders';
import Returns from './Returns';
import DeliveryRemainders from './DeliveryRemainders';
import Deliveries from './Deliveries';

const at = (path: string, node: React.ReactNode) => render(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  H.failing = new Map();
  H.functions = {};
  H.pending = new Map();
  H.tables = {};
});
afterEach(cleanup);

describe('Quotes list', () => {
  const quote = { id: 'q1', quote_number: 'Q-2026-0042', status: 'draft', customer_id: 'c1', created_at: '2026-10-01T12:00:00Z', deleted_at: null, total_price: 100, customer: { farm_name: 'Big Farm' } };

  it.each(['error', 'nodata'] as const)('a %s read says it could not be loaded, not "No quotes yet", and Try again shows the quotes', async (mode) => {
    H.failing.set('quotes', mode);
    at('/quotes', <Quotes />);
    expect(await screen.findByText('This list could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('No quotes yet')).not.toBeInTheDocument();

    H.failing.delete('quotes');
    H.tables.quotes = [quote];
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Q-2026-0042')).toBeInTheDocument();
  });

  it('a product-name read with no list says product search may miss quotes', async () => {
    H.tables.quotes = [quote];
    H.failing.set('quote_items', 'nodata');
    at('/quotes', <Quotes />);
    expect(await screen.findByText('Q-2026-0042')).toBeInTheDocument();
    expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('Product names could not be loaded'));
  });

  it('a failed booking rollover says so instead of "No open bookings."', async () => {
    H.failing.set('get_open_booking_rollover', 'error');
    at('/quotes', <Quotes />);
    fireEvent.click(await screen.findByRole('button', { name: /Open booking rollover/ }));
    expect(await screen.findByText('The booking rollover could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('No open bookings.')).not.toBeInTheDocument();

    H.failing.delete('get_open_booking_rollover');
    H.functions.get_open_booking_rollover = { success: true, bookings: [{ quote_id: 'q1', quote_number: 'Q-BOOK-1', customer_name: 'Big Farm', booked_cents: 10000, drawn_cents: 0, remaining_cents: 10000, prepay_remaining_cents: 0, prepay_earmarked_cents: 0 }] };
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Q-BOOK-1')).toBeInTheDocument();
  });

  it('an older failed rollover read that lands last does not replace the newer rows', async () => {
    let releaseFirst!: (v: unknown) => void;
    let releaseSecond!: (v: unknown) => void;
    H.pending.set('get_open_booking_rollover', [
      new Promise((r) => { releaseFirst = r; }),
      new Promise((r) => { releaseSecond = r; }),
    ]);
    at('/quotes', <Quotes />);
    const toggle = await screen.findByRole('button', { name: /Open booking rollover/ });
    fireEvent.click(toggle); // first read starts
    fireEvent.click(toggle); // close
    fireEvent.click(toggle); // reopen: a second read starts (nothing loaded yet)

    releaseSecond({ data: { success: true, bookings: [{ quote_id: 'q1', quote_number: 'Q-NEWER', customer_name: 'Big Farm', booked_cents: 100, drawn_cents: 0, remaining_cents: 100, prepay_remaining_cents: 0, prepay_earmarked_cents: 0 }] }, error: null });
    expect(await screen.findByText('Q-NEWER')).toBeInTheDocument();
    releaseFirst({ data: null, error: { message: 'connection reset' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('Q-NEWER')).toBeInTheDocument();
    expect(screen.queryByText('The booking rollover could not be loaded')).not.toBeInTheDocument();
  });

  it('a rollover reply with no bookings list counts as failed', async () => {
    H.functions.get_open_booking_rollover = { success: true };
    at('/quotes', <Quotes />);
    fireEvent.click(await screen.findByRole('button', { name: /Open booking rollover/ }));
    expect(await screen.findByText('The booking rollover could not be loaded')).toBeInTheDocument();
  });
});

describe('Orders list', () => {
  const order = () => ({ id: 'o1', order_number: 'ORD-77', status: 'confirmed', customer_id: 'c1', order_date: getSeasonDates().start, deleted_at: null, total_price: 100, is_planned: false, pricing_status: 'priced', customer: { farm_name: 'Big Farm', parent_customer_id: null } });

  it.each(['error', 'nodata'] as const)('a %s orders read says it could not be loaded, not "No orders yet"', async (mode) => {
    H.failing.set('orders', mode);
    at('/orders', <Orders />);
    expect(await screen.findByText('This list could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('No orders yet')).not.toBeInTheDocument();

    H.failing.delete('orders');
    H.tables.orders = [order()];
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('ORD-77')).toBeInTheDocument();
  });

  it.each(['order_items', 'deliveries'])('a failed %s read fails the list instead of showing zero fulfilled or no deliveries', async (table) => {
    H.tables.orders = [order()];
    H.failing.set(table, 'error');
    at('/orders', <Orders />);
    expect(await screen.findByText('This list could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('ORD-77')).not.toBeInTheDocument();
  });
  it('an invoice read with no list says invoiced is unavailable, not 0%', async () => {
    H.tables.orders = [order()];
    H.failing.set('invoices', 'nodata');
    at('/orders', <Orders />);
    expect(await screen.findByText('ORD-77')).toBeInTheDocument();
    expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('Invoiced percentages are unavailable'));
  });

  it('a failed farm-group name read fails the list instead of dropping the farm-group labels', async () => {
    H.tables.orders = [{ ...order(), customer: { farm_name: 'Big Farm', parent_customer_id: 'parent-1' } }];
    H.failing.set('customers', 'nodata');
    at('/orders', <Orders />);
    expect(await screen.findByText('This list could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('ORD-77')).not.toBeInTheDocument();
  });
});

describe('Returns', () => {
  const ret = { id: 'r1', return_number: 'RET-9', status: 'requested', reason: 'defective', customer_id: 'c1', order_id: null, requested_by: null, created_at: '2026-10-01T12:00:00Z', deleted_at: null, customer: { farm_name: 'Big Farm' }, order: null, items: [] };

  it.each(['error', 'nodata'] as const)('a %s list read says it could not be loaded, not "No returns yet"', async (mode) => {
    H.failing.set('returns', mode);
    at('/returns', <Returns />);
    expect(await screen.findByText('This list could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('No returns yet')).not.toBeInTheDocument();

    H.failing.delete('returns');
    H.tables.returns = [ret];
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('RET-9')).toBeInTheDocument();
  });

  it("a return whose lines fail to load offers Try again and no Approve over a $0 list", async () => {
    H.tables.returns = [ret];
    H.failing.set('return_items', 'error');
    at('/returns', <Returns />);
    fireEvent.click(await screen.findByText('RET-9'));
    expect(await screen.findByText("This return's lines could not be loaded")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve$/ })).not.toBeInTheDocument();

    H.failing.delete('return_items');
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('button', { name: /^Approve$/ })).toBeInTheDocument();
    expect(screen.queryByText("This return's lines could not be loaded")).not.toBeInTheDocument();
  });
});

describe('Delivery Remainders', () => {
  it.each(['error', 'nodata'] as const)('a %s read hides the 0 counts and says it could not be loaded', async (mode) => {
    H.failing.set('delivery_remainders', mode);
    at('/delivery-remainders', <DeliveryRemainders />);
    expect(await screen.findByText('This list could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('No remainders')).not.toBeInTheDocument();
    expect(screen.queryByText('Pending Items')).not.toBeInTheDocument();

    H.failing.delete('delivery_remainders');
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Pending Items')).toBeInTheDocument();
  });
});

describe('Deliveries list', () => {
  it('a read that answers with no list says it could not be loaded, not "No deliveries scheduled"', async () => {
    H.failing.set('deliveries', 'nodata');
    at('/deliveries', <Deliveries />);
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByText('No deliveries scheduled')).not.toBeInTheDocument();
  });
});
