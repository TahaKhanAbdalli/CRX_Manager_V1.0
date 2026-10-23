/**
 * DeliveryDetail.loadFailed.test.tsx — To-Do 10.5: a delivery whose reads fail says
 * "could not be loaded" with Try again. It never shows the delivery with no lines
 * (whose Edit could save over the real ones), hides its invoices (and offers
 * "Create Invoice" for a billed delivery), or reads "Delivery not found".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { auth, mockFrom, mockRpc, mockToast, route, tables, failing } = vi.hoisted(() => ({
  auth: { role: 'admin', profile: { id: 'user-1', role: 'admin' }, deniedPages: [] as string[] },
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  route: { id: 'del-1' },
  tables: { data: {} as Record<string, unknown[]> },
  // Table name -> how its reads fail.
  failing: new Map<string, 'error' | 'nodata'>(),
}));

function buildChain(table: string): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  for (const m of [
    'select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte',
    'lt', 'lte', 'like', 'ilike', 'is', 'in', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'returns', 'abortSignal', 'range',
  ]) self[m] = method;
  // Read the table when the query resolves, so a test can change it between calls.
  const reply = (single: boolean) => {
    const mode = failing.get(table);
    if (mode === 'error') return { data: null, error: { message: 'connection reset' }, count: null };
    if (mode === 'nodata') return { data: null, error: null, count: null };
    const rows = tables.data[table] ?? [];
    return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null, count: rows.length };
  };
  self.single = () => Promise.resolve(reply(true));
  self.maybeSingle = () => Promise.resolve(reply(true));
  self.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(reply(false)).then(ok, bad);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: {
    from: mockFrom,
    rpc: mockRpc,
    storage: {
      from: () => ({
        createSignedUrl: () => Promise.resolve({ data: null, error: null }),
        upload: vi.fn(),
        getPublicUrl: () => ({ data: { publicUrl: '' } }),
      }),
    },
  },
  supabaseUntyped: { from: mockFrom },
  sanitizeError: (e: unknown) => (e as Error)?.message || 'Error',
  checkMutationResult: vi.fn(),
  assertRpcResult: (d: unknown, op: string) => {
    if (d === null || d === undefined) throw new Error(`${op} returned no result`);
    return d;
  },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({
  notifyDeliveryRemainder: vi.fn(), notifyDeliveryCompleted: vi.fn(),
}));
vi.mock('../lib/connectivity', () => ({ hasSignal: () => Promise.resolve(true), NO_SIGNAL_MESSAGE: 'no signal' }));
vi.mock('../lib/deliveryPdf', () => ({ downloadDeliveryPdf: vi.fn() }));
vi.mock('../lib/emailService', () => ({ sendEmail: vi.fn(), buildEmailHtml: () => '<p></p>' }));
vi.mock('../lib/rupCompliance', () => ({ checkRUPCompliance: () => Promise.resolve({ compliant: true, warnings: [] }) }));
vi.mock('../lib/deliverySplitBilling', () => ({
  fetchSplitBillingOrderIds: () => Promise.resolve({ data: new Set(), error: null }), SPLIT_BILLING_BLOCK_REASON: '',
}));
vi.mock('../lib/imageCompression', () => ({ compressImage: vi.fn() }));
vi.mock('../components/deliveries/StartDeliveryModal', () => ({ default: () => null }));
vi.mock('../components/team/QuickTaskModal', () => ({ default: () => null }));
vi.mock('../components/team/RelatedNotes', () => ({ default: () => null }));
vi.mock('../components/ui/SignatureCanvas', () => ({ default: () => null }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: route.id }), useNavigate: () => vi.fn() };
});

import DeliveryDetail from './DeliveryDetail';

const COMPLETED_DELIVERY = {
  id: 'del-1',
  delivery_number: 'DEL-1',
  status: 'completed',
  scheduled_date: '2026-10-21',
  delivery_date: '2026-10-21',
  customer_id: 'cust-1',
  order_id: 'ord-1',
  assigned_driver: 'user-1',
  created_by: 'user-1',
  signature_url: null,
  signed_by: 'Pat',
};

beforeEach(() => {
  vi.clearAllMocks();
  failing.clear();
  route.id = 'del-1';
  mockRpc.mockResolvedValue({ data: null, error: null });
  tables.data = {
    deliveries: [{ ...COMPLETED_DELIVERY }],
    delivery_items: [{ id: 'item-1', delivery_id: 'del-1', order_item_id: 'oi-1', product_id: 'prod-1', quantity: 2, product: { product_name: 'Test Chem' } }],
    delivery_photos: [],
    delivery_remainders: [],
    customers: [{ id: 'cust-1', farm_name: 'Test Farm' }],
    profile_public_view: [],
    inventory: [],
    order_items: [{ id: 'oi-1', total_units_needed: 2, quantity_delivered: 2, quantity_remaining: 0 }],
    orders: [{ id: 'ord-1', order_number: 'ORD-1', quote_id: null }],
    invoices: [{ id: 'inv-1', invoice_number: 'INV-BILLED', invoice_date: '2026-10-21', status: 'posted', total_amount_cents: 500, order_id: 'ord-1', delivery_id: 'del-1', invoice_type: 'chemical', deleted_at: null }],
    delivery_external_billings: [],
  };
  mockFrom.mockImplementation((table: string) => buildChain(table));
});

const renderPage = () => render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);

describe('Delivery Detail load failures', () => {
  it('a failure on one delivery does not follow the page to the next delivery', async () => {
    failing.set('delivery_items', 'error');
    const view = renderPage();
    expect(await screen.findByText('This delivery could not be loaded')).toBeInTheDocument();

    failing.clear();
    tables.data.deliveries = [{ ...COMPLETED_DELIVERY, id: 'del-2', delivery_number: 'DEL-2' }];
    route.id = 'del-2';
    view.rerender(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
    expect((await screen.findAllByText('DEL-2')).length).toBeGreaterThan(0);
    expect(screen.queryByText('This delivery could not be loaded')).not.toBeInTheDocument();
  });

  it.each([
    ['deliveries', 'error'],
    ['delivery_items', 'error'],
    ['delivery_items', 'nodata'],
    ['invoices', 'error'],
    ['invoices', 'nodata'],
    ['delivery_remainders', 'error'],
    ['orders', 'error'],
  ] as const)('a failed %s read (%s) says the delivery could not be loaded, and Try again shows it', async (table, mode) => {
    failing.set(table, mode);
    renderPage();

    expect(await screen.findByText('This delivery could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('Delivery not found')).not.toBeInTheDocument();
    expect(screen.queryByText('DEL-1')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create Invoice/ })).not.toBeInTheDocument();

    failing.clear();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect((await screen.findAllByText('DEL-1')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('INV-BILLED').length).toBeGreaterThan(0);
    expect(screen.queryByText('This delivery could not be loaded')).not.toBeInTheDocument();
  });
});
