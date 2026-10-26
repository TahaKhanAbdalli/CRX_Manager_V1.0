/**
 * InvoiceLists.loadFailed.test.tsx — To-Do 10.5, the invoice lists: a list read that fails (an
 * error, no list, or something other than a list) says "could not be loaded" with Try again. It
 * must never show "No … invoices", "all caught up", $0 totals, a skeleton that never ends, or
 * older rows whose Post / Create Invoice buttons still work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type Mode = 'error' | 'nodata' | 'notlist';

const H = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  // Table name -> how its reads fail ('throws' rejects instead of answering).
  failing: new Map<string, 'error' | 'nodata' | 'notlist' | 'throws'>(),
  toast: vi.fn(),
}));

function replyFor(table: string): { data: unknown; error: unknown; count: number | null } {
  const rows = H.tables[table] ?? [];
  const mode = H.failing.get(table);
  if (mode === 'error') return { data: null, error: { message: 'connection reset', code: 'XX000' }, count: null };
  if (mode === 'nodata') return { data: null, error: null, count: null };
  if (mode === 'notlist') return { data: { unexpected: true }, error: null, count: null };
  return { data: rows, error: null, count: rows.length };
}

// A query that ignores its filters and answers with the table's rows (or its failure).
function query(table: string): Record<string, unknown> {
  const reply = replyFor(table);
  const throws = H.failing.get(table) === 'throws';
  const q: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          (throws ? reject(new Error('socket hang up')) : resolve(reply));
      }
      if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve({ data: null, error: null });
      return () => q;
    },
  });
  return q;
}

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  // The version-bearing reads use the invoices_postable view: same rows as invoices here.
  const client = {
    from: (table: string) => query(table === 'invoices_postable' ? 'invoices' : table),
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
  };
  return { ...actual, supabase: client, supabaseUntyped: client };
});
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../ui/MobileCardList', () => ({ default: ({ desktop }: { desktop: React.ReactNode }) => <>{desktop}</> }));
vi.mock('../../lib/invoiceSummaryPdf', () => ({ downloadCustomerInvoiceSummaryPdf: vi.fn() }));

import FieldInvoicesListPanel from './FieldInvoicesListPanel';
import FieldInvoicesPostedPanel from './FieldInvoicesPostedPanel';
import FieldInvoicesUnpostedPanel from './FieldInvoicesUnpostedPanel';
import CustomerInvoiceSummaryPanel from './CustomerInvoiceSummaryPanel';
import UnbilledApplicationsPanel from './UnbilledApplicationsPanel';

const MODES: Mode[] = ['error', 'nodata', 'notlist'];
const renderIn = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);
const tryAgain = () => fireEvent.click(screen.getByRole('button', { name: /Try again/ }));

function fieldInvoice(n: string, status: string) {
  return {
    id: `fa-${n}`, invoice_post_version: `v1:fa-${n}`, invoice_number: `FA-${n}`, invoice_type: 'field_application',
    status, season: 2027, invoice_date: '2026-10-05', created_at: '2026-10-05T15:00:00+00:00', customer_id: 'cust-1',
    customer: { farm_name: 'Test Farm' }, job: null, job_id: null, blend_ticket_id: null, invoice_group_id: null,
    deleted_at: null, field_app_locations: [], invoice_items: [], total_acres: 1, total_amount_cents: 1000,
    paid_amount_cents: 0, prepay_applied_cents: 0, balance_cents: 1000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // "Today" is in season 2027, so every invoice below is this season's.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-09T12:00:00'));
  H.failing = new Map();
  H.tables = {};
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Field Invoices panels', () => {
  const panels = [
    ['All Invoices', () => <FieldInvoicesListPanel />, 'Field invoices could not be loaded', 'draft'],
    ['Posted', () => <FieldInvoicesPostedPanel />, 'Posted field invoices could not be loaded', 'posted'],
    ['Unposted', () => <FieldInvoicesUnpostedPanel />, 'Unposted field invoices could not be loaded', 'draft'],
  ] as const;

  for (const [name, panel, failedTitle, status] of panels) {
    it.each(MODES)(`${name}: a %s read says could not be loaded with Try again, not an empty list`, async (mode) => {
      H.tables.invoices = [fieldInvoice('0001', status)];
      H.failing.set('invoices', mode);
      renderIn(panel());

      expect(await screen.findByText(failedTitle)).toBeInTheDocument();
      expect(screen.queryByText(/No .*field invoices/i)).not.toBeInTheDocument();
      expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Post All|Unpost All/ })).not.toBeInTheDocument();

      H.failing.delete('invoices');
      tryAgain();
      expect((await screen.findAllByText('FA-0001')).length).toBeGreaterThan(0);
      expect(screen.queryByText(failedTitle)).not.toBeInTheDocument();
    });
  }

  for (const [name, panel, failedTitle] of panels) {
    it(`${name}: a read that throws says could not be loaded, not a skeleton for good`, async () => {
      H.failing.set('invoices', 'throws');
      renderIn(panel());
      expect(await screen.findByText(failedTitle)).toBeInTheDocument();
    });
  }

  it.each([
    ['Posted', () => <FieldInvoicesPostedPanel />, 'Posted field invoices could not be loaded', 'posted'],
    ['Unposted', () => <FieldInvoicesUnpostedPanel />, 'Unposted field invoices could not be loaded', 'draft'],
  ] as const)('%s: a split invoice whose locations read throws fails the load', async (_name, panel, failedTitle, status) => {
    H.tables.invoices = [{ ...fieldInvoice('0003', status), invoice_group_id: 'grp-1' }];
    H.failing.set('field_app_locations', 'throws');
    renderIn(panel());
    expect(await screen.findByText(failedTitle)).toBeInTheDocument();
  });

  it('Posted: a split invoice whose locations read comes back with no list fails the load', async () => {
    H.tables.invoices = [{ ...fieldInvoice('0002', 'posted'), invoice_group_id: 'grp-1' }];
    H.failing.set('field_app_locations', 'nodata');
    renderIn(<FieldInvoicesPostedPanel />);
    expect(await screen.findByText('Posted field invoices could not be loaded')).toBeInTheDocument();
  });
});

describe('Customer Invoice Summary', () => {
  const customer = { id: 'cust-a', farm_name: 'Alpha Farm', account_number: null, city: null, state: null, is_active: true };
  const summaryRow = {
    id: 'inv-a', invoice_number: 'INV-ALPHA', invoice_type: 'chemical_sale', status: 'unposted', invoice_date: '2026-10-01',
    total_amount_cents: 1000, paid_amount_cents: 0, prepay_applied_cents: 0, write_off_cents: 0,
    discount_earned_cents: 0, balance_cents: 1000,
  };
  const viewReport = async () => {
    const box = screen.getByRole('combobox', { name: 'Summary customer' });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Alpha' } });
    fireEvent.click(await screen.findByRole('option', { name: /Alpha Farm/ }));
    fireEvent.click(screen.getByRole('button', { name: 'View Report' }));
  };

  it.each(MODES)('a %s read says could not be loaded, not "No unposted" or a $0 balance', async (mode) => {
    H.tables.customers = [customer];
    H.tables.invoices = [summaryRow];
    H.failing.set('invoices', mode);
    renderIn(<CustomerInvoiceSummaryPanel />);
    await viewReport();

    expect(await screen.findByText('The invoice summary could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText(/No unposted/)).not.toBeInTheDocument();
    expect(screen.queryByText('Combined Balance')).not.toBeInTheDocument();

    H.failing.delete('invoices');
    tryAgain();
    expect(await screen.findByText('INV-ALPHA')).toBeInTheDocument();
  });

  it('a failed refresh drops the older summary instead of keeping it on screen', async () => {
    H.tables.customers = [customer];
    H.tables.invoices = [summaryRow];
    renderIn(<CustomerInvoiceSummaryPanel />);
    await viewReport();
    expect(await screen.findByText('INV-ALPHA')).toBeInTheDocument();

    H.failing.set('invoices', 'error');
    fireEvent.click(screen.getByRole('button', { name: 'View Report' }));
    expect(await screen.findByText('The invoice summary could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('INV-ALPHA')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Print/ })).not.toBeInTheDocument();
  });
});

describe('Unbilled Applications', () => {
  const job = {
    id: 'job-1', job_number: 'J-1001', job_date: '2026-10-01', total_acres: 80, total_price_cents: 125000,
    customer: { farm_name: 'Safe Farms' },
  };

  it.each(MODES)('a %s read says could not be loaded, not "all caught up"', async (mode) => {
    H.tables.jobs = [job];
    H.failing.set('jobs', mode);
    renderIn(<UnbilledApplicationsPanel />);

    expect(await screen.findByText('Unbilled applications could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText(/all caught up/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create Invoice' })).not.toBeInTheDocument();

    H.failing.delete('jobs');
    tryAgain();
    expect(await screen.findByText('J-1001')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Invoice' })).toBeEnabled();
  });

  it('a failed Refresh drops the older rows and their Create Invoice buttons', async () => {
    H.tables.jobs = [job];
    renderIn(<UnbilledApplicationsPanel />);
    expect(await screen.findByText('J-1001')).toBeInTheDocument();

    H.failing.set('blend_tickets', 'error');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Unbilled applications could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('J-1001')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create Invoice' })).not.toBeInTheDocument();
  });
});
