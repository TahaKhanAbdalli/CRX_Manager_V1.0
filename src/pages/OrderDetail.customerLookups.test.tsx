/**
 * OrderDetail.customerLookups.test.tsx — the Bill Split customer dropdown and the
 * Field / Acre Split owner names must load from the real `customers` columns.
 *
 * Regression (2026-10-13, ORD-2026-0567): both queries filtered customers on
 * `deleted_at`, a column that table does not have, so PostgREST answered 400 (42703),
 * the dropdown was empty, the owner names showed "Unknown", and nothing was reported.
 * The customers mock below answers the same 42703 for any filter on a column the live
 * table lacks, so a reintroduced bad filter fails these tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { mockFrom, mockRpc, mockToast, mockCaptureException } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockCaptureException: vi.fn(),
}));

// The live customers columns, from the schema registry (regenerated from the live database), so
// this follows schema refreshes. It has is_active and no deleted_at.
const registry = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude', 'schema-registry.json'), 'utf8',
)) as { columns?: Record<string, string[] | undefined> };
const registryCustomerColumns = registry.columns?.customers;
if (!registryCustomerColumns?.length) {
  throw new Error('schema-registry.json has no customers columns; regenerate the registry');
}
const CUSTOMER_COLUMNS = new Set(registryCustomerColumns);
// Methods whose first argument is a column name.
const FILTER_METHODS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'not', 'order', 'filter']);

/** Every column a recorded call names: filter columns, match keys, select list, or()/and() terms. */
function columnsNamed([m, args]: [string, unknown[]]): string[] {
  if (FILTER_METHODS.has(m) && typeof args[0] === 'string') return [args[0]];
  if (m === 'match' && args[0] && typeof args[0] === 'object') return Object.keys(args[0]);
  if (m === 'select' && typeof args[0] === 'string') {
    return args[0].split(',').map((c) => c.trim()).filter((c) => c && c !== '*' && /^[a-z_]+$/.test(c));
  }
  if ((m === 'or' || m === 'and') && typeof args[0] === 'string') return args[0].split(',').map((t) => t.split('.')[0].trim());
  return [];
}
const CHAIN_METHODS = ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq',
  'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains', 'containedBy', 'range',
  'filter', 'not', 'or', 'and', 'match', 'order', 'limit', 'offset', 'single', 'maybeSingle'];

type Row = Record<string, unknown>;
type Result = { data: unknown; error: unknown };

/** Chain that records its calls; `resolve` turns them into a result when awaited. */
function buildChain(resolve: (ops: [string, unknown[]][]) => Result): Record<string, unknown> {
  const ops: [string, unknown[]][] = [];
  const self: Record<string, unknown> = {};
  for (const m of CHAIN_METHODS) self[m] = (...args: unknown[]) => { ops.push([m, args]); return self; };
  self.then = (onOk: (r: Result) => unknown, onErr?: (e: unknown) => unknown) =>
    Promise.resolve().then(() => resolve(ops)).then(onOk, onErr);
  return self;
}

const rowsChain = (data: unknown) => buildChain(() => ({ data, error: null }));

/** Every customers query's recorded calls, in order (reset per test). */
let customerCalls: [string, unknown[]][][] = [];

/** Mimics PostgREST on customers: unknown column → 42703; eq and in filters applied. */
function customersChain(rows: Row[], seen: [string, unknown[]][][] = customerCalls) {
  return buildChain((ops) => {
    seen.push(ops);
    for (const op of ops) {
      const bad = columnsNamed(op).find((c) => !CUSTOMER_COLUMNS.has(c));
      if (bad) return { data: null, error: { code: '42703', message: `column customers.${bad} does not exist` } };
    }
    let out = rows;
    for (const [m, args] of ops) {
      if (m === 'eq') out = out.filter((r) => r[args[0] as string] === args[1]);
      if (m === 'in') out = out.filter((r) => (args[1] as unknown[]).includes(r[args[0] as string]));
    }
    const single = ops.some(([m]) => m === 'maybeSingle' || m === 'single');
    return { data: single ? out[0] ?? null : out, error: null };
  });
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  checkMutationResult: vi.fn(),
  assertRpcResult: vi.fn((d) => d),
  describePostInvoiceBlock: vi.fn(() => null),
  sanitizeError: vi.fn((e: unknown) => (e as Error)?.message || 'Error'),
  hasRpcCode: vi.fn(() => false),
  RpcErrorCodes: {},
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: mockCaptureException } }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'test-idem-key', resetKey: vi.fn() }),
}));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyOrderStatusChange: vi.fn() }));
vi.mock('../components/team/QuickTaskModal', () => ({ default: () => null }));
vi.mock('../components/team/RelatedNotes', () => ({ default: () => null }));

import OrderDetail from './OrderDetail';

const ORDER = {
  id: 'ord-1', order_number: 'ORD-0567', status: 'confirmed', customer_id: 'cust-1',
  order_date: '2026-03-15', total_cost: 300, total_price: 1000, total_profit: 700,
  total_margin_pct: 70, order_name: 'Spring', notes: '', created_at: '2026-03-15T00:00:00Z',
  delivery_priority: 'normal', po_number: null, quote_id: null, booking_draw: false,
};
const CUSTOMERS: Row[] = [
  { id: 'cust-1', farm_name: 'Order Farm', is_active: true },
  { id: 'cust-2', farm_name: 'Active Partner Farm', is_active: true },
  { id: 'cust-3', farm_name: 'Retired Owner Farm', is_active: false },
];

function mockTables(overrides: Record<string, () => unknown> = {}) {
  mockFrom.mockImplementation((table: string) => {
    if (overrides[table]) return overrides[table]();
    switch (table) {
      case 'orders': return buildChain((ops) => ({
        data: ops.some(([m]) => m === 'maybeSingle') ? ORDER : [], error: null,
      }));
      case 'customers': return customersChain(CUSTOMERS);
      case 'order_items': return rowsChain([{
        id: 'item-1', order_id: 'ord-1', product_id: 'p-1', product_name: 'Herbicide X',
        quantity: 10, unit_price: 100, total_price: 1000, unit_cost: 30, total_cost: 300,
        section_name: null, pricing_pending: false,
      }]);
      case 'order_item_field_allocations': return rowsChain([
        { id: 'a-1', order_item_id: 'item-1', field_id: 'f-1', acres: 60, created_at: '2026-03-15T00:00:00Z' },
        { id: 'a-2', order_item_id: 'item-1', field_id: 'f-2', acres: 40, created_at: '2026-03-15T00:00:00Z' },
      ]);
      case 'fields': return rowsChain([
        { id: 'f-1', field_name: 'North 80', total_acres: 80, customer_id: 'cust-2' },
        { id: 'f-2', field_name: 'South 40', total_acres: 40, customer_id: 'cust-3' },
      ]);
      default: return rowsChain([]);
    }
  });
}

function renderOrder() {
  return render(
    <MemoryRouter initialEntries={['/orders/ord-1']}>
      <Routes><Route path="/orders/:id" element={<OrderDetail />} /></Routes>
    </MemoryRouter>,
  );
}

describe('OrderDetail customer lookups', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    customerCalls = [];
    mockRpc.mockImplementation(() => Promise.resolve({ data: null, error: null }));
    mockTables();
  });

  it('lists active customers in the Bill Split dropdown', async () => {
    renderOrder();
    fireEvent.click(await screen.findByRole('button', { name: /Add Split/ }));
    const dropdown = (await screen.findByText('Select customer...')).closest('select') as HTMLSelectElement;
    await waitFor(() => expect(within(dropdown).getByRole('option', { name: 'Active Partner Farm' })).toBeInTheDocument());
    expect(within(dropdown).getByRole('option', { name: 'Order Farm' })).toBeInTheDocument();
    expect(within(dropdown).queryByRole('option', { name: 'Retired Owner Farm' })).not.toBeInTheDocument();
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.anything());
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('names every field owner in the projected split, including an inactive owner', async () => {
    renderOrder();
    expect(await screen.findByText('Active Partner Farm')).toBeInTheDocument();
    expect(screen.getByText('Retired Owner Farm')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    expect(mockCaptureException).not.toHaveBeenCalled();
    // Only the customers the preview can show are fetched, so no row cap can drop one.
    const nameLookup = customerCalls.find((ops) => ops.some(([m]) => m === 'in'));
    const inArgs = nameLookup?.find(([m]) => m === 'in')?.[1];
    expect(inArgs?.[0]).toBe('id');
    expect([...(inArgs?.[1] as string[])].sort()).toEqual(['cust-1', 'cust-2', 'cust-3']);
  });

  it('reports a failed owner-name load', async () => {
    mockTables({ customers: () => buildChain((ops) => (ops.some(([m]) => m === 'in')
      ? { data: null, error: { code: '500', message: 'names down' } }
      : { data: CUSTOMERS[0], error: null })) });
    renderOrder();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Failed to load field split details. Please refresh.'));
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'names down' }),
      { tags: { source: 'fetch', action: 'load_field_split_lookups_for_order' } },
    );
  });

  it('reports a failed Bill Split customer load instead of opening an empty dropdown', async () => {
    renderOrder();
    const addSplit = await screen.findByRole('button', { name: /Add Split/ });
    mockTables({ customers: () => buildChain(() => ({ data: null, error: { code: '500', message: 'boom' } })) });
    fireEvent.click(addSplit);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Failed to load customers. Please try again.'));
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'boom' }),
      { tags: { source: 'fetch', action: 'load_customers_for_bill_split' } },
    );
    expect(screen.queryByText('Select customer...')).not.toBeInTheDocument();
  });

  it('reports a failed field-split lookup load', async () => {
    mockTables({ fields: () => buildChain(() => ({ data: null, error: { code: '500', message: 'fields down' } })) });
    renderOrder();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Failed to load field split details. Please refresh.'));
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'fields down' }),
      { tags: { source: 'fetch', action: 'load_field_split_lookups_for_order' } },
    );
    // The card says the load failed rather than claiming no fields exist.
    expect(await screen.findByText(/Field details failed to load/)).toBeInTheDocument();
    expect(screen.queryByText(/No active fields are set up yet/)).not.toBeInTheDocument();
  });

  it('the fake customers table refuses a column the live table lacks, however it is named', async () => {
    const probes: ((c: Record<string, (...a: unknown[]) => unknown>) => unknown)[] = [
      (c) => c.is('deleted_at', null),
      (c) => c.filter('deleted_at', 'is', null),
      (c) => c.match({ deleted_at: null }),
      (c) => c.or('deleted_at.is.null,is_active.eq.true'),
      (c) => c.and('deleted_at.is.null,is_active.eq.true'),
      (c) => c.order('deleted_at'),
    ];
    for (const probe of probes) {
      const chain = customersChain(CUSTOMERS, []) as Record<string, (...a: unknown[]) => unknown>;
      const res = await (probe((chain.select as (s: string) => typeof chain)('id, farm_name')) as Promise<Result>);
      expect(res.error).toMatchObject({ code: '42703' });
    }
    const badSelect = customersChain(CUSTOMERS, []) as Record<string, (...a: unknown[]) => unknown>;
    expect((await (badSelect.select('id, deleted_at') as Promise<Result>)).error).toMatchObject({ code: '42703' });
  });
});
