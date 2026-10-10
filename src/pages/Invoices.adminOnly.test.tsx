/**
 * Invoicing is admin-only (Mason 2026-10-09) — the Chemical Sales invoice list.
 *
 * A sales rep sees every invoice, read-only: no selection checkboxes (they only feed the bulk
 * Post / Void / Delete / Print), no Select All, no Misc Charge. The customers table still hides
 * other reps' customers from them, so the list fills those farm names from the names-only
 * reader get_invoice_customer_names in ONE call. An admin's list is unchanged and never calls it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery } from '../test-utils/inMemoryQuery';

const { mockFrom, mockRpc, mockToast, authState } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  authState: { role: 'admin' as 'admin' | 'sales_rep' },
}));

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  const client = { from: mockFrom, rpc: mockRpc };
  return { ...actual, supabase: client, supabaseUntyped: client };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: authState.role }, role: authState.role, deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

import Invoices from './Invoices';

function invoice(overrides: Record<string, unknown>) {
  return {
    id: overrides.invoice_number,
    invoice_type: 'chemical_sale',
    customer_id: 'cust-own',
    customer: { farm_name: 'Own Farm' },
    salesman_id: null,
    order_id: null,
    deleted_at: null,
    total_amount_cents: 10000,
    balance_cents: 10000,
    is_quick_delivery: false,
    season: 2027,
    invoice_date: '2026-10-06',
    created_at: '2026-10-06T15:00:00+00:00',
    ...overrides,
  };
}

const ROWS = [
  invoice({ invoice_number: 'INV-OWN', status: 'draft' }),
  // Another rep's customer: RLS leaves the embed empty for this rep.
  invoice({ invoice_number: 'INV-OTHER', status: 'posted', customer_id: 'cust-hidden', customer: null }),
];

function namesCalls() {
  return mockRpc.mock.calls.filter(([name]) => name === 'get_invoice_customer_names');
}

describe('Invoices list — admin-only invoicing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T12:00:00'));
    authState.role = 'admin';
    mockFrom.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? ROWS : []));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'get_invoice_customer_names'
      ? { data: [{ id: 'cust-hidden', farm_name: 'Hidden Rep Farms' }], error: null }
      : { data: null, error: null }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a sales rep every invoice read-only, with the hidden customer name from the reader', async () => {
    authState.role = 'sales_rep';
    render(<MemoryRouter><Invoices /></MemoryRouter>);

    expect(await screen.findByText('Hidden Rep Farms')).toBeInTheDocument();
    expect(screen.getAllByText('INV-OWN').length).toBeGreaterThan(0);
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    expect(namesCalls()).toEqual([['get_invoice_customer_names', { p_customer_ids: ['cust-hidden'] }]]);

    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Select All' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Misc Charge' })).not.toBeInTheDocument();
    // Read-only exports stay.
    expect(screen.getByRole('button', { name: /Export CSV/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download PDF/ })).toBeInTheDocument();
  });

  it("keeps an admin's selection and Misc Charge, and never calls the names reader", async () => {
    const adminRows = [invoice({ invoice_number: 'INV-OWN', status: 'draft' }), invoice({ invoice_number: 'INV-B', status: 'posted' })];
    mockFrom.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? adminRows : []));
    render(<MemoryRouter><Invoices /></MemoryRouter>);

    await waitFor(() => expect(screen.getAllByText('INV-B').length).toBeGreaterThan(0));
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Select All' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Misc Charge' })).toBeInTheDocument();
    expect(namesCalls()).toHaveLength(0);
  });
});
