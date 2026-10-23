import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import OrderSearchPicker from './OrderSearchPicker';
import JobSearchPicker from '../jobs/JobSearchPicker';
import PurchaseOrderSearchPicker from '../purchase-orders/PurchaseOrderSearchPicker';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  toast: vi.fn(),
  captureException: vi.fn(),
  withAdminCosts: vi.fn(),
}));

vi.mock('../../lib/db', () => ({ supabase: { from: mocks.from } }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../../lib/costFields', () => ({
  PURCHASE_ORDER_COLUMNS: 'id, po_number, vendor, status',
  withAdminCosts: mocks.withAdminCosts,
}));

type Call = [string, ...unknown[]];
// Each table's query records its calls; `limit` resolves the table's next result.
let calls: Record<string, Call[]>;
let results: Record<string, Array<{ data: unknown; error: unknown }>>;

beforeEach(() => {
  vi.clearAllMocks();
  calls = {};
  results = {};
  mocks.from.mockImplementation((table: string) => {
    const log = (calls[table] ??= []);
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'or', 'eq', 'in', 'is', 'not', 'order']) {
      builder[m] = (...args: unknown[]) => { log.push([m, ...args]); return builder; };
    }
    builder.limit = (n: number) => {
      log.push(['limit', n]);
      return Promise.resolve(results[table]?.shift() ?? { data: [], error: null });
    };
    return builder;
  });
  mocks.withAdminCosts.mockImplementation(async (_t: string, rows: unknown[], isAdmin: boolean) =>
    isAdmin ? rows.map((r) => ({ ...(r as object), total_cost: 1234.5 })) : rows);
});

function type(name: string, value: string) {
  const input = screen.getByRole('combobox', { name });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
}

describe('OrderSearchPicker', () => {
  it('finds an order past the old 1,000-row list by customer name, in the old statuses only', async () => {
    results.customers = [{ data: [{ id: 'c-7' }, { id: 'c-8' }], error: null }];
    results.orders = [{ data: [{ id: 'o-1099', order_number: 'SEED-ORD-1099', customer_id: 'c-7', status: 'confirmed', customer: { farm_name: 'Seed Farm, North' } }], error: null }];
    const onSelect = vi.fn();
    render(<OrderSearchPicker value="" selectedLabel="" onSelect={onSelect} statuses={['confirmed', 'partially_fulfilled']} customerId="c-7" ariaLabel="Order" />);
    type('Order', 'Farm, North');
    fireEvent.click(await screen.findByRole('option', { name: /SEED-ORD-1099 - Seed Farm, North/ }));
    expect(calls.customers).toContainEqual(['or', 'farm_name.ilike."%Farm, North%"']);
    expect(calls.orders).toEqual(expect.arrayContaining([
      ['or', 'order_number.ilike."%Farm, North%",customer_id.in.(c-7,c-8)'],
      ['in', 'status', ['confirmed', 'partially_fulfilled']],
      ['is', 'deleted_at', null],
      ['eq', 'customer_id', 'c-7'],
      ['limit', 20],
    ]));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'o-1099' }));
  });

  it('searches by order number alone when no customer name matches', async () => {
    results.orders = [{ data: [], error: null }];
    render(<OrderSearchPicker value="" selectedLabel="" onSelect={vi.fn()} statuses={['confirmed']} ariaLabel="Order" />);
    type('Order', 'ORD-12');
    expect(await screen.findByText('No matching orders')).toBeInTheDocument();
    expect(calls.orders).toContainEqual(['or', 'order_number.ilike."%ORD-12%"']);
  });

  it('shows a failed customer-name lookup as a failed search with Retry, never as no matches', async () => {
    results.customers = [{ data: null, error: { message: 'down' } }, { data: [], error: null }];
    results.orders = [{ data: [{ id: 'o-1', order_number: 'ORD-1', customer_id: 'c', status: 'confirmed' }], error: null }];
    render(<OrderSearchPicker value="" selectedLabel="" onSelect={vi.fn()} statuses={['confirmed']} ariaLabel="Order" />);
    type('Order', 'ORD-1');
    expect(await screen.findByText('Order search failed.')).toBeInTheDocument();
    expect(calls.orders).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: /ORD-1/ })).toBeInTheDocument();
  });
});

describe('JobSearchPicker', () => {
  it('keeps the status filter and never offers a deleted job', async () => {
    results.jobs = [{ data: [{ id: 'j-250', job_number: 'SEED-JOB-0250', job_date: '2026-02-13', status: 'completed', customer: { farm_name: 'Seed Farm 0250' } }], error: null }];
    const onSelect = vi.fn();
    render(<JobSearchPicker value="" selectedLabel="" onSelect={onSelect} statuses={['completed']} ariaLabel="Source job" />);
    type('Source job', '0250');
    fireEvent.click(await screen.findByRole('option', { name: /SEED-JOB-0250 \(2026-02-13\) - Seed Farm 0250/ }));
    expect(calls.jobs).toEqual(expect.arrayContaining([
      ['in', 'status', ['completed']],
      ['is', 'deleted_at', null],
    ]));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'j-250' }));
  });

  it("offers only the given customer's jobs and searches again when the customer changes", async () => {
    results.jobs = [{ data: [], error: null }, { data: [], error: null }];
    const { rerender } = render(<JobSearchPicker value="" selectedLabel="" onSelect={vi.fn()} customerId="c-250" ariaLabel="Link to Job" />);
    type('Link to Job', 'SEED-JOB');
    expect(await screen.findByText('No matching jobs')).toBeInTheDocument();
    expect(calls.jobs).toContainEqual(['eq', 'customer_id', 'c-250']);
    rerender(<JobSearchPicker value="" selectedLabel="" onSelect={vi.fn()} customerId="c-1" ariaLabel="Link to Job" />);
    await screen.findByText('No matching jobs');
    await vi.waitFor(() => expect(calls.jobs).toContainEqual(['eq', 'customer_id', 'c-1']));
  });

  it('offers every status when none is given', async () => {
    results.jobs = [{ data: [], error: null }];
    render(<JobSearchPicker value="" selectedLabel="" onSelect={vi.fn()} ariaLabel="Link to Job" />);
    type('Link to Job', 'JOB');
    expect(await screen.findByText('No matching jobs')).toBeInTheDocument();
    expect(calls.jobs.some((c) => c[0] === 'in')).toBe(false);
  });
});

describe('PurchaseOrderSearchPicker', () => {
  it('searches PO number and vendor in the old statuses and gives an admin the PO total', async () => {
    results.purchase_orders = [{ data: [{ id: 'po-250', po_number: 'SEED-PO-0250', vendor: 'Seed Vendor', status: 'submitted' }], error: null }];
    const onSelect = vi.fn();
    render(<PurchaseOrderSearchPicker value="" selectedLabel="" onSelect={onSelect} statuses={['submitted', 'partially_received', 'fully_received']} isAdmin ariaLabel="PO" />);
    type('PO', 'PO-0250');
    fireEvent.click(await screen.findByRole('option', { name: /SEED-PO-0250 — Seed Vendor.*\$1,234\.50/ }));
    expect(calls.purchase_orders).toEqual(expect.arrayContaining([
      ['or', 'po_number.ilike."%PO-0250%",vendor.ilike."%PO-0250%"'],
      ['in', 'status', ['submitted', 'partially_received', 'fully_received']],
    ]));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'po-250', total_cost: 1234.5 }));
  });

  it('fails the search when an admin cost read fails, so no PO is picked without its total', async () => {
    results.purchase_orders = [{ data: [{ id: 'po-1', po_number: 'PO-1', vendor: 'V', status: 'submitted' }], error: null }];
    mocks.withAdminCosts.mockRejectedValueOnce(new Error('cost read failed'));
    render(<PurchaseOrderSearchPicker value="" selectedLabel="" onSelect={vi.fn()} statuses={['submitted']} isAdmin ariaLabel="PO" />);
    type('PO', 'PO-1');
    expect(await screen.findByText('Purchase order search failed.')).toBeInTheDocument();
    expect(screen.queryByRole('option')).toBeNull();
  });
});
