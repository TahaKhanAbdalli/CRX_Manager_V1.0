/**
 * Invoicing is admin-only (Mason 2026-10-09) — the Field Invoices tabs.
 *
 * A sales rep sees every field invoice, read-only: the Drafts tray has no Post All and no
 * Manual Invoice; the Posted tab has no Unpost All; the All tab has no Manual Invoice. Print,
 * Old Print and the report stay. Farm names the customers table hides from the rep come from
 * the names-only reader get_invoice_customer_names, one call per list. An admin keeps every
 * control and never calls the reader.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery } from '../../test-utils/inMemoryQuery';

const { mockFrom, mockRpc, mockToast, authState } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  authState: { role: 'admin' as 'admin' | 'sales_rep' },
}));

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  const client = { from: mockFrom, rpc: mockRpc };
  return { ...actual, supabase: client, supabaseUntyped: client };
});
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: authState.role }, role: authState.role, deniedPages: [] }),
}));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

import FieldInvoicesUnpostedPanel from './FieldInvoicesUnpostedPanel';
import FieldInvoicesPostedPanel from './FieldInvoicesPostedPanel';
import FieldInvoicesListPanel from './FieldInvoicesListPanel';

function fieldInvoice(overrides: Record<string, unknown>) {
  return {
    id: overrides.invoice_number,
    invoice_type: 'field_application',
    customer_id: 'cust-own',
    customer: { farm_name: 'Own Farm' },
    job: null,
    job_id: 'job-1',
    blend_ticket_id: null,
    invoice_group_id: null,
    deleted_at: null,
    // invoices.updated_at is NOT NULL; the Post All baseline compares it.
    updated_at: '2026-10-03T15:00:00+00:00',
    field_app_locations: [],
    invoice_items: [],
    total_acres: 10,
    total_amount_cents: 50000,
    paid_amount_cents: 0,
    prepay_applied_cents: 0,
    balance_cents: 50000,
    season: 2027,
    invoice_date: '2026-10-03',
    created_at: '2026-10-03T15:00:00+00:00',
    ...overrides,
  };
}

const ROWS = [
  fieldInvoice({ invoice_number: 'FA-DRAFT-OWN', status: 'draft' }),
  // Another rep's customer: RLS leaves the embed empty for this rep.
  fieldInvoice({ invoice_number: 'FA-DRAFT-OTHER', status: 'draft', customer_id: 'cust-hidden', customer: null }),
  fieldInvoice({ invoice_number: 'FA-POSTED-OTHER', status: 'posted', customer_id: 'cust-hidden', customer: null }),
];

function namesCalls() {
  return mockRpc.mock.calls.filter(([name]) => name === 'get_invoice_customer_names');
}

function renderInRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('Field Invoices tabs — admin-only invoicing', () => {
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

  it('Drafts tray: a sales rep sees the invoices and names, but no Post All or Manual Invoice', async () => {
    authState.role = 'sales_rep';
    renderInRouter(<FieldInvoicesUnpostedPanel />);

    expect((await screen.findAllByText('Hidden Rep Farms')).length).toBeGreaterThan(0);
    expect(namesCalls()).toEqual([['get_invoice_customer_names', { p_customer_ids: ['cust-hidden'] }]]);
    expect(screen.queryByRole('button', { name: 'Post All' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View FA-DRAFT-OTHER' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print All' })).toBeInTheDocument();
  });

  it("Drafts tray: a sales rep's Email on another rep's customer says the email is hidden, not missing", async () => {
    authState.role = 'sales_rep';
    renderInRouter(<FieldInvoicesUnpostedPanel />);

    // The rep's View action uses the eye icon, not the edit pencil.
    const view = await screen.findByRole('button', { name: 'View FA-DRAFT-OTHER' });
    expect(view.querySelector('.lucide-eye')).not.toBeNull();
    expect(view.querySelector('.lucide-pencil')).toBeNull();

    // customers RLS hides the row from this rep, so the email read comes back empty.
    fireEvent.click(screen.getByRole('button', { name: 'Email FA-DRAFT-OTHER' }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      "You can't see this customer's email address. Ask an admin to email this invoice.",
    ));
    expect(mockToast).not.toHaveBeenCalledWith('error', 'Customer does not have an email address on file');
  });

  it('Drafts tray: an admin keeps Post All and Manual Invoice, with no names reader call', async () => {
    const adminRows = [fieldInvoice({ invoice_number: 'FA-DRAFT-OWN', status: 'draft' })];
    mockFrom.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? adminRows : []));
    renderInRouter(<FieldInvoicesUnpostedPanel />);

    expect(await screen.findByRole('button', { name: 'Post All' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit FA-DRAFT-OWN' })).toBeInTheDocument();
    expect(namesCalls()).toHaveLength(0);
  });

  it('Posted tab: a sales rep sees the invoice and name, but no Unpost All', async () => {
    authState.role = 'sales_rep';
    renderInRouter(<FieldInvoicesPostedPanel />);

    expect((await screen.findAllByText('Hidden Rep Farms')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Unpost All/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Only an admin can unpost invoices/)).toBeInTheDocument();
  });

  it('Posted tab: an admin keeps Unpost All', async () => {
    renderInRouter(<FieldInvoicesPostedPanel />);
    expect(await screen.findByRole('button', { name: /Unpost All/ })).toBeInTheDocument();
  });

  it('All tab: a sales rep gets no Manual Invoice menu and sees the hidden names', async () => {
    authState.role = 'sales_rep';
    renderInRouter(<FieldInvoicesListPanel />);

    await waitFor(() => expect(screen.getAllByText('Hidden Rep Farms').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
    expect(namesCalls()).toHaveLength(1);
  });
});
