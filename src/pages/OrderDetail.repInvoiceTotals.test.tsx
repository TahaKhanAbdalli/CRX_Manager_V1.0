/**
 * Non-admins only see invoices they created or are the salesman on (invoices RLS),
 * so the order's AR strip must never show a bare $0.00 that reads as "unbilled /
 * unpaid" when the office has in fact billed and collected it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { mockFrom, mockRole, mockToast } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRole: { current: 'admin' as string },
  // One stable toast: fetchOrder depends on it, so a new function per render
  // would re-run the load effect on every render.
  mockToast: vi.fn(),
}));

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) self[m] = method;
  const promise = Promise.resolve(result);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: {
    from: (table: string) => mockFrom(table === 'invoices_postable' ? 'invoices' : table),
    rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
  },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((d) => d),
  describePostInvoiceBlock: vi.fn(() => null),
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', role: mockRole.current, full_name: 'Test User' },
    role: mockRole.current,
  }),
}));

vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyOrderStatusChange: vi.fn() }));
vi.mock('../lib/emailService', () => ({ sendEmail: vi.fn(), buildEmailHtml: vi.fn(() => '') }));
vi.mock('../lib/dateUtils', () => ({ parseLocalDate: vi.fn((d: string) => new Date(d)) }));
vi.mock('../components/team/QuickTaskModal', () => ({ default: () => null }));
vi.mock('../components/team/RelatedNotes', () => ({ default: () => null }));

import OrderDetail from './OrderDetail';

const orderData = {
  id: 'ord-123', order_number: 'ORD-0099', status: 'fulfilled', customer_id: 'cust-1',
  order_date: '2026-03-15', total_price: 500, order_name: 'Spring Order', notes: '',
  created_at: '2026-03-15T00:00:00Z', delivery_priority: 'normal',
};
const paidInvoice = {
  id: 'inv-1', order_id: 'ord-123', invoice_number: 'CS-0001', invoice_type: 'standard',
  status: 'paid', deleted_at: null, total_amount_cents: 50000, paid_amount_cents: 50000,
  prepay_applied_cents: 0, balance_cents: 0, write_off_cents: 0,
};

function renderWith(role: string, invoices: unknown[]) {
  mockRole.current = role;
  mockFrom.mockImplementation((table: string) => {
    if (table === 'orders') return buildChain({ data: orderData, error: null });
    if (table === 'invoices') return buildChain({ data: invoices, error: null });
    return buildChain({ data: [], error: null });
  });
  return render(
    <MemoryRouter initialEntries={['/orders/ord-123']}>
      <Routes>
        <Route path="/orders/:id" element={<OrderDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OrderDetail AR strip for non-admins', () => {
  beforeEach(() => vi.clearAllMocks());

  it('admin sees the full totals with no visibility note', async () => {
    renderWith('admin', [paidInvoice]);
    expect(await screen.findByText('Total Invoiced')).toBeInTheDocument();
    expect(screen.getAllByText('$500.00').length).toBeGreaterThan(0);
    expect(screen.queryByText(/can't view any invoices/)).not.toBeInTheDocument();
    expect(screen.queryByText(/include only the invoices you created/)).not.toBeInTheDocument();
  });

  it('a rep who can see no invoices gets an office note instead of $0.00 tiles', async () => {
    renderWith('sales_rep', []);
    expect(await screen.findByText(/You can't view any invoices for this order. Ask the office whether it has been billed or paid./)).toBeInTheDocument();
    expect(screen.queryByText('Total Invoiced')).not.toBeInTheDocument();
    expect(screen.queryByText('Amount Paid')).not.toBeInTheDocument();
    expect(screen.queryByText('Balance Due')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Record Payment/ })).toBeInTheDocument();
  });

  it('a rep who can see some invoices gets the totals plus a partial-view note', async () => {
    renderWith('sales_rep', [paidInvoice]);
    expect(await screen.findByText('Total Invoiced')).toBeInTheDocument();
    expect(screen.getByText(/include only the invoices you created or are the salesman on/)).toBeInTheDocument();
    expect(screen.queryByText(/can't view any invoices/)).not.toBeInTheDocument();
  });
});
