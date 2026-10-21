/**
 * OrderDetail.invoiceSplitGate.test.tsx — Goal 4 part 2b (Sol HIGH): Create Invoice must
 * follow the order's real field split.
 *
 * An order whose lines are split across fields is billed per field owner
 * (create_split_invoices_from_order). The page chose the billing RPC from the allocations
 * it had loaded, so a failed (or stale) allocation read left the list empty and sent an
 * allocated order down the single-invoice path: one invoice to the order's customer for
 * every owner's share. create_invoice_from_order does not check allocations itself.
 *
 * This drives the real page and clicks Create Invoice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const { mockFrom, mockRpc, mockToast, tables } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn((_name: string, _args?: unknown) => Promise.resolve({ data: 'inv-new', error: null })),
  mockToast: vi.fn(),
  tables: {
    lists: {} as Record<string, unknown[]>,
    singles: {} as Record<string, unknown>,
    failing: new Set<string>(),
    // Answers for the order's allocations, one per read, in order; the last repeats.
    allocReads: [] as Array<{ rows: unknown[] } | { error: string }>,
    allocCalls: 0,
  },
}));

function buildChain(answer: { data: unknown; error: { message: string } | null; count: number | null }, single: unknown): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  for (const m of [
    'select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte',
    'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains', 'containedBy', 'range',
    'filter', 'not', 'or', 'and', 'match', 'order', 'limit', 'offset',
    'csv', 'returns', 'textSearch', 'overlaps', 'abortSignal',
  ]) self[m] = method;
  const settle = (data: unknown) => {
    const promise = Promise.resolve({ data, error: null });
    return { then: promise.then.bind(promise), catch: promise.catch.bind(promise), finally: promise.finally.bind(promise) };
  };
  self.single = () => settle(single);
  self.maybeSingle = () => settle(single);
  const promise = Promise.resolve(answer);
  self.then = promise.then.bind(promise);
  self.catch = promise.catch.bind(promise);
  self.finally = promise.finally.bind(promise);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((d) => d),
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
  hasRpcCode: vi.fn(() => false),
  RpcErrorCodes: {},
  describePostInvoiceBlock: vi.fn(() => null),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyOrderStatusChange: vi.fn() }));
vi.mock('../lib/emailService', () => ({ sendEmail: vi.fn(), buildEmailHtml: vi.fn(() => '<p>test</p>') }));
vi.mock('../components/team/QuickTaskModal', () => ({ default: () => null }));
vi.mock('../components/team/RelatedNotes', () => ({ default: () => null }));

import OrderDetail from './OrderDetail';

const ORDER = {
  id: 'ord-split', order_number: 'ORD-SPLIT', status: 'confirmed', customer_id: 'cust-1',
  order_date: '2026-10-01', total_cents: 0, total_cost: 0, total_price: 0,
  total_profit: 0, total_margin_pct: 0, order_name: null, notes: null,
  program_notes: null, created_at: '2026-10-01T00:00:00Z',
  delivery_priority: 'normal', po_number: null, quote_id: null,
};
const LINE = {
  id: 'line-1', order_id: 'ord-split', product_id: 'product-1', product_name: 'Split Product', unit_size: 'gal',
  total_units_needed: 10, quantity_delivered: 0, quantity_remaining: 10,
  price_per_unit: 10, total_price: 100, pricing_pending: false, section_name: null,
};
const ALLOCATION = { id: 'alloc-1', order_item_id: 'line-1', field_id: 'field-1', acres: 40, created_at: '2026-10-01T00:00:00Z', order_items: { order_id: 'ord-split' } };

function answerFor(table: string) {
  if (table === 'order_item_field_allocations') {
    const reads = tables.allocReads;
    const next = reads[Math.min(tables.allocCalls, reads.length - 1)] ?? { rows: [] };
    tables.allocCalls += 1;
    if ('error' in next) return { data: null, error: { message: next.error }, count: null };
    return { data: next.rows, error: null, count: next.rows.length };
  }
  if (tables.failing.has(table)) return { data: null, error: { message: 'connection reset' }, count: null };
  const list = (tables.lists[table] ?? []) as unknown[];
  return { data: list, error: null, count: list.length };
}

const invoiceRpcCalls = () => mockRpc.mock.calls
  .map((call) => call[0])
  .filter((name) => name === 'create_invoice_from_order' || name === 'create_split_invoices_from_order');

async function clickCreateInvoice() {
  mockFrom.mockImplementation((table: string) => buildChain(answerFor(table), tables.singles[table] ?? null));
  render(
    <MemoryRouter initialEntries={['/orders/ord-split']}>
      <Routes>
        <Route path="/orders/:id" element={<OrderDetail />} />
        <Route path="/invoices/:id" element={<div>Invoice page</div>} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /^Create Invoice/i }));
}

describe('OrderDetail Create Invoice follows the real field split', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tables.lists = { order_items: [LINE] };
    tables.singles = { orders: ORDER, customers: { id: 'cust-1', farm_name: 'Order Farm', contact_name: null, phone: null, billing_address: null } };
    tables.failing = new Set();
    tables.allocReads = [];
    tables.allocCalls = 0;
  });

  it('a failed allocation read blocks the invoice instead of billing one customer for the whole order', async () => {
    tables.allocReads = [{ error: 'connection reset' }];
    await clickCreateInvoice();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/field split details failed to load/i)));
    expect(invoiceRpcCalls()).toEqual([]);
  });

  it('an allocation the page did not load (added elsewhere, or a stale read) blocks the invoice', async () => {
    // The page loads no allocations; the check just before billing finds one.
    tables.allocReads = [{ rows: [] }, { rows: [ALLOCATION] }];
    await clickCreateInvoice();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/field split changed since this page loaded/i)));
    expect(invoiceRpcCalls()).toEqual([]);
  });

  it('an order with no field split still gets its single invoice', async () => {
    tables.allocReads = [{ rows: [] }];
    await clickCreateInvoice();
    await waitFor(() => expect(invoiceRpcCalls()).toEqual(['create_invoice_from_order']));
  });
});
