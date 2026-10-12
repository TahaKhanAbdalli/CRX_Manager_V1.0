/**
 * OrderDetail.test.tsx — Tests for the order detail page
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const {
  mockFrom, mockRpc, mockToast, mockNavigate,
  mockLogActivity, mockNotifyOrderStatusChange, mockSanitizeError,
} = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn().mockImplementation(() => Promise.resolve({ data: null, error: null })),
  mockToast: vi.fn(),
  mockNavigate: vi.fn(),
  mockLogActivity: vi.fn(),
  mockNotifyOrderStatusChange: vi.fn(),
  mockSanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
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

function buildPendingChain(): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  const methods = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) self[m] = method;
  const promise = new Promise(() => {});
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

/**
 * Like buildChain, but the result depends on the columns passed to select(), so one table can
 * answer the page's own load and the Post review's re-read differently.
 */
function buildSelectAwareChain(resultFor: (columns: string) => { data: unknown; error: unknown }): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  let columns = '';
  const method = (..._args: unknown[]) => self;
  const methods = ['insert', 'update', 'upsert', 'delete', 'eq', 'neq',
    'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains',
    'containedBy', 'range', 'filter', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'single', 'maybeSingle', 'csv',
    'rollback', 'returns', 'textSearch', 'overlaps', 'abortSignal'];
  for (const m of methods) self[m] = method;
  self.select = (cols?: string) => { columns = cols ?? '*'; return self; };
  self.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve().then(() => resultFor(columns)).then(resolve, reject);
  return self;
}

// The posting versions the readers return (32-character lowercase md5s).
const POST_VERSION = '0123456789abcdef0123456789abcdef';
const GROUP_VERSION = 'fedcba9876543210fedcba9876543210';
/** The columns the Post review re-reads the shown invoices with. */
const isReviewReread = (columns: string) => columns.includes('deleted_at') && columns.includes('total_amount_cents');

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  // The posting-version readers and the versioned post go through supabaseUntyped.
  supabaseUntyped: { from: mockFrom, rpc: mockRpc },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((d) => d),
  describePostInvoiceBlock: vi.fn(() => null),
  sanitizeError: mockSanitizeError,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));

vi.mock('../lib/activityLogger', () => ({ logActivity: mockLogActivity }));
vi.mock('../lib/notificationTriggers', () => ({ notifyOrderStatusChange: mockNotifyOrderStatusChange }));
vi.mock('../lib/emailService', () => ({
  sendEmail: vi.fn(),
  buildEmailHtml: vi.fn(() => '<p>test</p>'),
}));
vi.mock('../lib/dateUtils', () => ({
  parseLocalDate: vi.fn((d: string) => new Date(d)),
}));
vi.mock('../components/team/QuickTaskModal', () => ({ default: () => null }));
vi.mock('../components/team/RelatedNotes', () => ({ default: () => null }));

import OrderDetail from './OrderDetail';

function renderOrderDetail(id = 'ord-123') {
  return render(
    <MemoryRouter initialEntries={[`/orders/${id}`]}>
      <Routes>
        <Route path="/orders/:id" element={<OrderDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OrderDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation(() => buildChain({ data: [], error: null }));
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));
  });

  it('shows loading skeleton while fetching', () => {
    mockFrom.mockImplementation(() => buildPendingChain());
    renderOrderDetail();
    const skeletons = document.querySelectorAll('.animate-pulse');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows order not found for invalid ID', async () => {
    mockFrom.mockImplementation(() => buildChain({ data: null, error: null }));
    renderOrderDetail('bad-id');
    await waitFor(() => {
      expect(screen.getByText('Order not found')).toBeInTheDocument();
    });
  });

  it('renders order detail when data loads', async () => {
    const orderData = {
      id: 'ord-123',
      order_number: 'ORD-0099',
      status: 'confirmed',
      customer_id: 'cust-1',
      order_date: '2026-03-15',
      total_cents: 50000,
      total_cost: 30000,
      total_price: 50000,
      total_profit: 20000,
      total_margin_pct: 40.0,
      order_name: 'Spring Order',
      notes: '',
      created_at: '2026-03-15T00:00:00Z',
      delivery_priority: 'normal',
      po_number: null,
    };

    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') {
        return buildChain({ data: orderData, error: null });
      }
      return buildChain({ data: [], error: null });
    });

    renderOrderDetail();
    await waitFor(() => {
      const matches = screen.getAllByText('ORD-0099');
      expect(matches.length).toBeGreaterThan(0);
    });
  });

  it('keeps Create Invoice available when the only linked invoice is a posted return credit', async () => {
    const orderData = {
      id: 'ord-123', order_number: 'ORD-0099', status: 'confirmed', customer_id: 'cust-1',
      order_date: '2026-03-15', total_cents: 50000, total_cost: 30000, total_price: 50000,
      total_profit: 20000, total_margin_pct: 40.0, order_name: 'Spring Order', notes: '',
      created_at: '2026-03-15T00:00:00Z', delivery_priority: 'normal', po_number: null,
    };
    const returnCredit = {
      id: 'credit-1', order_id: 'ord-123', invoice_number: 'CM-0001',
      invoice_type: 'credit_memo', status: 'posted', deleted_at: null,
      total_amount_cents: -15000, paid_amount_cents: 0, prepay_applied_cents: 0,
      balance_cents: -15000, write_off_cents: 0,
    };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') return buildChain({ data: orderData, error: null });
      if (table === 'invoices') return buildChain({ data: [returnCredit], error: null });
      return buildChain({ data: [], error: null });
    });

    renderOrderDetail();

    expect(await screen.findByRole('button', { name: 'Create Invoice' })).toBeInTheDocument();
  });

  it('#67: shows a plain Cancel Order action on a confirmed order, not the old dead-option Change Status dropdown', async () => {
    const orderData = {
      id: 'ord-123', order_number: 'ORD-0099', status: 'confirmed', customer_id: 'cust-1',
      order_date: '2026-03-15', total_cents: 50000, total_cost: 30000, total_price: 50000,
      total_profit: 20000, total_margin_pct: 40.0, order_name: 'Spring Order', notes: '',
      created_at: '2026-03-15T00:00:00Z', delivery_priority: 'normal', po_number: null,
    };
    mockFrom.mockImplementation((table: string) =>
      table === 'orders' ? buildChain({ data: orderData, error: null }) : buildChain({ data: [], error: null }),
    );
    renderOrderDetail();
    // The only manual status transition the handler allows is → cancelled, so #67
    // replaced the dropdown (whose fulfilled/partially_fulfilled options always
    // errored) with one honest Cancel Order action.
    await waitFor(() => expect(screen.getByText('Cancel Order')).toBeInTheDocument());
    expect(screen.queryByText('Change Status')).not.toBeInTheDocument();
  });

  it('refreshes without duplicate side effects when cancellation returns no new-success marker', async () => {
    let orderReads = 0;
    const orderData = {
      id: 'ord-123', order_number: 'ORD-0099', status: 'confirmed', customer_id: 'cust-1',
      order_date: '2026-03-15', total_cents: 50000, total_cost: 30000, total_price: 50000,
      total_profit: 20000, total_margin_pct: 40.0, order_name: 'Spring Order', notes: '',
      created_at: '2026-03-15T00:00:00Z', delivery_priority: 'normal', po_number: null,
    };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') {
        orderReads += 1;
        return buildChain({ data: orderData, error: null });
      }
      return buildChain({ data: [], error: null });
    });
    mockRpc.mockImplementation((rpcName: string) => Promise.resolve(
      rpcName === 'cancel_order'
        ? {
            data: {
              mode: 'full_cancel',
              status: 'cancelled',
              holds_released: 0,
              commissions_cancelled: 0,
              draft_invoices_cancelled: 0,
              posted_invoices_flagged: 0,
              paid_commissions_flagged: 0,
            },
            error: null,
          }
        : { data: null, error: null },
    ));

    renderOrderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel Order' }));
    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel Order' });
    fireEvent.click(cancelButtons[cancelButtons.length - 1]);

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('cancel_order', {
      p_order_id: 'ord-123',
      p_performed_by: 'user-1',
      p_idempotency_key: 'test-idem-key',
    }));
    await waitFor(() => {
      expect(orderReads).toBeGreaterThanOrEqual(2);
      expect(mockLogActivity).not.toHaveBeenCalled();
      expect(mockNotifyOrderStatusChange).not.toHaveBeenCalled();
    });
  });

  it('labels a partially fulfilled order as Cancel Remaining Quantity and explains the short-close behavior', async () => {
    const orderData = {
      id: 'ord-123', order_number: 'ORD-0099', status: 'partially_fulfilled', customer_id: 'cust-1',
      order_date: '2026-03-15', total_cents: 50000, total_cost: 30000, total_price: 50000,
      total_profit: 20000, total_margin_pct: 40.0, order_name: 'Spring Order', notes: '',
      created_at: '2026-03-15T00:00:00Z', delivery_priority: 'normal', po_number: null,
    };
    mockFrom.mockImplementation((table: string) =>
      table === 'orders' ? buildChain({ data: orderData, error: null }) : buildChain({ data: [], error: null }),
    );
    mockRpc.mockImplementation((rpcName: string) => Promise.resolve(
      rpcName === 'cancel_order'
        ? {
            data: {
              success: true,
              mode: 'remainder_closed',
              status: 'fulfilled',
              released_quantity: 6,
              holds_released: 0,
              commissions_cancelled: 0,
              commissions_recomputed: 1,
              draft_invoices_cancelled: 0,
              posted_invoices_flagged: 0,
              paid_commissions_flagged: 0,
            },
            error: null,
          }
        : { data: null, error: null },
    ));

    renderOrderDetail();
    const cancelRemaining = await screen.findByRole('button', { name: 'Cancel Remaining Quantity' });
    fireEvent.click(cancelRemaining);

    expect(await screen.findByRole('heading', { name: 'Cancel Remaining Quantity' })).toBeInTheDocument();
    expect(screen.getByText(/Completed deliveries and their invoices stay intact/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Remaining' }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('cancel_order', {
      p_order_id: 'ord-123',
      p_performed_by: 'user-1',
      p_idempotency_key: 'test-idem-key',
    }));
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        'success',
        expect.stringContaining('Remaining quantity cancelled; delivered quantity kept as fulfilled.'),
      );
      expect(mockLogActivity).not.toHaveBeenCalled();
      expect(mockNotifyOrderStatusChange).not.toHaveBeenCalled();
    });
  });

  it('posts split draft invoices through one atomic group RPC', async () => {
    const orderData = {
      id: 'ord-123', order_number: 'ORD-0099', status: 'confirmed', customer_id: 'cust-1',
      order_date: '2026-03-15', total_cents: 50000, total_cost: 30000, total_price: 50000,
      total_profit: 20000, total_margin_pct: 40, order_name: 'Spring Order', notes: '',
      created_at: '2026-03-15T00:00:00Z', delivery_priority: 'normal', po_number: null,
    };
    const splitDrafts = [
      {
        id: 'inv-1', invoice_number: 'INV-1', invoice_group_id: 'group-1',
        status: 'draft', invoice_type: 'chemical_sale', invoice_date: '2026-03-15',
        due_date: null, total_amount_cents: 25000, balance_cents: 25000,
      },
      {
        id: 'inv-2', invoice_number: 'INV-2', invoice_group_id: 'group-1',
        status: 'draft', invoice_type: 'chemical_sale', invoice_date: '2026-03-15',
        due_date: null, total_amount_cents: 25000, balance_cents: 25000,
      },
    ];
    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') return buildChain({ data: orderData, error: null });
      if (table === 'invoices') return buildChain({ data: splitDrafts, error: null });
      return buildChain({ data: [], error: null });
    });
    mockRpc.mockImplementation((name: string) => Promise.resolve(
      name === 'get_invoice_group_post_version'
        ? { data: GROUP_VERSION, error: null }
        : { data: { posted_invoice_ids: ['inv-1', 'inv-2'], member_count: 2 }, error: null },
    ));

    renderOrderDetail();
    const postButton = await screen.findByRole('button', { name: /post all drafts/i });
    fireEvent.click(postButton);

    // One group post, carrying the version read for the whole group, with a key.
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('post_invoice_group', {
      p_invoice_group_id: 'group-1',
      p_performed_by: 'user-1',
      p_idempotency_key: expect.any(String),
      p_expected_version: GROUP_VERSION,
    }));
    expect(mockRpc).toHaveBeenCalledWith('get_invoice_group_post_version', { p_invoice_group_id: 'group-1' });
    expect(mockRpc.mock.calls.filter(([name]) => name === 'post_invoice_group')).toHaveLength(1);
    expect(mockRpc.mock.calls.some(([name]) => name === 'post_invoice')).toBe(false);
  });

  it('posts a stand-alone draft with its posting version', async () => {
    const orderData = {
      id: 'ord-123', order_number: 'ORD-0099', status: 'confirmed', customer_id: 'cust-1',
      order_date: '2026-03-15', total_cents: 50000, total_cost: 30000, total_price: 50000,
      total_profit: 20000, total_margin_pct: 40, order_name: 'Spring Order', notes: '',
      created_at: '2026-03-15T00:00:00Z', delivery_priority: 'normal', po_number: null,
    };
    const drafts = [{
      id: 'inv-1', invoice_number: 'INV-1', invoice_group_id: null, customer_id: 'cust-1',
      status: 'draft', invoice_type: 'chemical_sale', invoice_date: '2026-03-15',
      due_date: null, total_amount_cents: 25000, balance_cents: 25000, deleted_at: null,
      updated_at: '2026-03-15T10:00:00+00:00',
    }];
    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') return buildChain({ data: orderData, error: null });
      if (table === 'invoices') return buildChain({ data: drafts, error: null });
      return buildChain({ data: [], error: null });
    });
    mockRpc.mockImplementation((name: string) => {
      const result = Promise.resolve(name === 'get_invoice_post_version'
        ? { data: POST_VERSION, error: null }
        : { data: null, error: null });
      return Object.assign(result, { throwOnError: () => result });
    });

    renderOrderDetail();
    fireEvent.click(await screen.findByRole('button', { name: /post all drafts/i }));

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('post_invoice', {
      p_invoice_id: 'inv-1',
      p_idempotency_key: expect.any(String),
      p_expected_version: POST_VERSION,
    }));
    expect(mockRpc).toHaveBeenCalledWith('get_invoice_post_version', { p_invoice_ids: ['inv-1'] });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Posted 1 invoice(s).'));
  });

  // Codex Luna HIGH (2026-10-12): "Post all drafts" posted whatever the invoice held at click
  // time. Another admin changes INV-1 from $250.00 to $700.00 after the order page loaded; the
  // page re-reads the drafts after reading the posting versions, sees the change, posts nothing
  // and reloads the order.
  it('posts nothing when a draft changed since the page loaded, reloads and says so', async () => {
    const orderData = {
      id: 'ord-123', order_number: 'ORD-0099', status: 'confirmed', customer_id: 'cust-1',
      order_date: '2026-03-15', total_cents: 50000, total_cost: 30000, total_price: 50000,
      total_profit: 20000, total_margin_pct: 40, order_name: 'Spring Order', notes: '',
      created_at: '2026-03-15T00:00:00Z', delivery_priority: 'normal', po_number: null,
    };
    const shown = {
      id: 'inv-1', invoice_number: 'INV-1', invoice_group_id: null, customer_id: 'cust-1',
      status: 'draft', invoice_type: 'chemical_sale', invoice_date: '2026-03-15',
      due_date: null, total_amount_cents: 25000, balance_cents: 25000, deleted_at: null,
      updated_at: '2026-03-15T10:00:00+00:00',
    };
    const changed = { ...shown, total_amount_cents: 70000, balance_cents: 70000, updated_at: '2026-03-15T11:00:00+00:00' };
    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') return buildChain({ data: orderData, error: null });
      if (table === 'invoices') {
        return buildSelectAwareChain((columns) => ({ data: isReviewReread(columns) ? [changed] : [shown], error: null }));
      }
      return buildChain({ data: [], error: null });
    });
    mockRpc.mockImplementation((name: string) => {
      const result = Promise.resolve(name === 'get_invoice_post_version'
        ? { data: POST_VERSION, error: null }
        : { data: null, error: null });
      return Object.assign(result, { throwOnError: () => result });
    });

    renderOrderDetail();
    const postButton = await screen.findByRole('button', { name: /post all drafts/i });
    const orderLoads = () => mockFrom.mock.calls.filter(([table]) => table === 'orders').length;
    const loadsAtClick = orderLoads();
    fireEvent.click(postButton);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      '1 invoice(s) changed since this list loaded — the list was reloaded; check them and post again.',
    ));
    expect(mockRpc.mock.calls.some(([name]) => name === 'post_invoice' || name === 'post_invoice_group')).toBe(false);
    await waitFor(() => expect(orderLoads()).toBeGreaterThan(loadsAtClick));
    expect(mockToast).not.toHaveBeenCalledWith('success', expect.anything());
  });

  it('sanitizes an internal contention token when posting draft invoices', async () => {
    const orderData = {
      id: 'ord-123', order_number: 'ORD-0099', status: 'confirmed', customer_id: 'cust-1',
      order_date: '2026-03-15', total_cents: 50000, total_cost: 30000, total_price: 50000,
      total_profit: 20000, total_margin_pct: 40, order_name: 'Spring Order', notes: '',
      created_at: '2026-03-15T00:00:00Z', delivery_priority: 'normal', po_number: null,
    };
    const splitDrafts = [{
      id: 'inv-1', invoice_number: 'INV-1', invoice_group_id: 'group-1',
      status: 'draft', invoice_type: 'chemical_sale', invoice_date: '2026-03-15',
      due_date: null, total_amount_cents: 25000, balance_cents: 25000,
    }];
    mockFrom.mockImplementation((table: string) => {
      if (table === 'orders') return buildChain({ data: orderData, error: null });
      if (table === 'invoices') return buildChain({ data: splitDrafts, error: null });
      return buildChain({ data: [], error: null });
    });
    const contention = { message: 'RETURN_CREDIT_SOURCE_CONCURRENT' };
    // The review passes (the group's version is read); the group post itself is refused.
    mockRpc.mockImplementation((name: string) => Promise.resolve(
      name === 'get_invoice_group_post_version'
        ? { data: GROUP_VERSION, error: null }
        : { data: null, error: contention },
    ));

    renderOrderDetail();
    fireEvent.click(await screen.findByRole('button', { name: /post all drafts/i }));

    await waitFor(() => expect(mockSanitizeError).toHaveBeenCalledWith(contention));
    expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Wait a moment and try again'),
    );
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.stringContaining('RETURN_CREDIT_SOURCE_CONCURRENT'));
  });
});
