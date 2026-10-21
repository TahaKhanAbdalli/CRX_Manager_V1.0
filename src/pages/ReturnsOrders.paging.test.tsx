/**
 * ReturnsOrders.paging.test.tsx — Goal 4 part 2b (N10): a new return offers every returnable
 * order of the chosen customer.
 *
 * The "Original Order" picker read the customer's orders in one request, which the server
 * silently stops at 1,000 rows, so a customer's oldest orders could not be picked. A failed
 * read showed an empty picker as if the customer had no orders. The fake server caps every
 * reply at 1,000 rows like the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { buildInMemoryQuery, SERVER_ROW_CAP } from '../test-utils/inMemoryQuery';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failing: new Set<string>(),
  toast: vi.fn(),
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

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    ...actual,
    supabase: {
      from: (table: string) => (H.failing.has(table) ? failingQuery() : buildInMemoryQuery(H.tables[table] ?? [])),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    },
  };
});
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'actor-1' }, role: 'admin' }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/reportPdf', () => ({ downloadReportPdf: vi.fn() }));

import Returns from './Returns';

const TOTAL = SERVER_ROW_CAP + 5;
vi.setConfig({ testTimeout: 120_000 });
configure({ asyncUtilTimeout: 30_000 });
const pad = (i: number) => String(i).padStart(4, '0');

beforeEach(() => {
  vi.clearAllMocks();
  H.failing = new Set();
  H.tables = {
    customers: [{ id: 'customer-1', farm_name: 'Big Farm', assigned_tier: null, is_active: true }],
    // Newest first, the order the picker asks the server for. A draft, a deleted order and
    // another customer's order must not be offered.
    orders: [
      ...Array.from({ length: TOTAL }, (_, i) => ({
        id: `order-${pad(i)}`, order_number: `ORD-${pad(i)}`, customer_id: 'customer-1',
        order_date: '2026-08-01', status: 'fulfilled', deleted_at: null,
      })),
      { id: 'draft', order_number: 'ORD-DRAFT', customer_id: 'customer-1', order_date: '2026-08-01', status: 'draft', deleted_at: null },
      { id: 'gone', order_number: 'ORD-GONE', customer_id: 'customer-1', order_date: '2026-08-01', status: 'fulfilled', deleted_at: '2026-09-01' },
      { id: 'other', order_number: 'ORD-OTHER', customer_id: 'customer-2', order_date: '2026-08-01', status: 'fulfilled', deleted_at: null },
    ],
  };
});
afterEach(cleanup);

async function pickCustomer() {
  render(<Returns />);
  await screen.findByText('No returns yet');
  fireEvent.click(screen.getAllByRole('button', { name: 'New Return' })[0]);
  const dialog = await screen.findByRole('dialog', { name: 'New Return / RMA' });
  const customer = within(dialog).getByLabelText('Customer');
  await waitFor(() => expect(customer.querySelectorAll('option')).toHaveLength(2));
  fireEvent.change(customer, { target: { value: 'customer-1' } });
  return within(dialog).getByLabelText('Original Order');
}

describe('new return order picker past the 1,000-row server cap (N10)', () => {
  it("offers all 1,005 of the customer's returnable orders", async () => {
    const picker = await pickCustomer();
    // "Select Order" plus every order; a read stopped at 1,000 offers 1,000.
    await waitFor(() => expect(picker.querySelectorAll('option')).toHaveLength(TOTAL + 1));
    const offered = [...picker.querySelectorAll('option')].slice(1).map((o) => o.getAttribute('value'));
    expect(offered).toEqual(Array.from({ length: TOTAL }, (_, i) => `order-${pad(i)}`));
    expect(H.toast).not.toHaveBeenCalledWith('error', expect.anything());
  });

  it('a failed read says the orders could not be loaded', async () => {
    H.failing.add('orders');
    const picker = await pickCustomer();
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', "This customer's orders could not be loaded. Pick the customer again to retry."));
    expect(picker.querySelectorAll('option')).toHaveLength(1);
  });
});
