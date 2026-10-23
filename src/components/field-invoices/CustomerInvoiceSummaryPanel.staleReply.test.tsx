import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn(), toast: vi.fn(), captureException: vi.fn() }));

vi.mock('../../lib/db', () => ({ supabase: { from: mocks.from } }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../../lib/invoiceSummaryPdf', () => ({ downloadCustomerInvoiceSummaryPdf: vi.fn() }));

import CustomerInvoiceSummaryPanel from './CustomerInvoiceSummaryPanel';

const customers = [
  { id: 'cust-a', farm_name: 'Alpha Farm', account_number: null, city: null, state: null, is_active: true },
  { id: 'cust-b', farm_name: 'Beta Farm', account_number: null, city: null, state: null, is_active: true },
];

function invoice(id: string, number: string) {
  return {
    id, invoice_number: number, invoice_type: 'chemical_sale', status: 'unposted', invoice_date: '2026-10-01',
    total_amount_cents: 1000, paid_amount_cents: 0, prepay_applied_cents: 0, write_off_cents: 0,
    discount_earned_cents: 0, balance_cents: 1000,
  };
}

// Each invoices read waits until the test releases it, so replies can arrive in any order.
let releases: Array<(rows: unknown[]) => void>;

function chain(result: Promise<{ data: unknown; error: unknown }>) {
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'is', 'or', 'not', 'order', 'limit']) self[m] = () => self;
  self.then = (...args: Parameters<Promise<unknown>['then']>) => result.then(...args);
  return self;
}

beforeEach(() => {
  vi.clearAllMocks();
  releases = [];
  mocks.from.mockImplementation((table: string) => {
    if (table === 'customers') return chain(Promise.resolve({ data: customers, error: null }));
    return chain(new Promise((resolve) => { releases.push((rows) => resolve({ data: rows, error: null })); }));
  });
});

async function pick(name: string) {
  const box = screen.getByRole('combobox', { name: 'Summary customer' });
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value: 'Farm' } });
  fireEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
}

describe('CustomerInvoiceSummaryPanel', () => {
  it('never shows a late reply for the previous customer under the newly chosen one', async () => {
    render(<MemoryRouter><CustomerInvoiceSummaryPanel /></MemoryRouter>);

    await pick('Alpha Farm');
    fireEvent.click(screen.getByRole('button', { name: 'View Report' }));
    expect(releases).toHaveLength(1);

    // The user switches to Beta before Alpha's invoices arrive.
    await pick('Beta Farm');
    await act(async () => { releases[0]([invoice('inv-a', 'INV-ALPHA')]); });
    expect(screen.queryByText('INV-ALPHA')).toBeNull();

    // Beta's own report still loads.
    fireEvent.click(screen.getByRole('button', { name: 'View Report' }));
    await act(async () => { releases[1]([invoice('inv-b', 'INV-BETA')]); });
    expect(await screen.findByText('INV-BETA')).toBeInTheDocument();
  });

  it('keeps only the newest of two reports for the same customer', async () => {
    render(<MemoryRouter><CustomerInvoiceSummaryPanel /></MemoryRouter>);
    await pick('Alpha Farm');
    fireEvent.click(screen.getByRole('button', { name: 'View Report' }));
    fireEvent.click(screen.getByRole('button', { name: 'View Report' }));
    await act(async () => { releases[1]([invoice('inv-new', 'INV-NEW')]); });
    await act(async () => { releases[0]([invoice('inv-old', 'INV-OLD')]); });
    expect(await screen.findByText('INV-NEW')).toBeInTheDocument();
    expect(screen.queryByText('INV-OLD')).toBeNull();
  });
});
