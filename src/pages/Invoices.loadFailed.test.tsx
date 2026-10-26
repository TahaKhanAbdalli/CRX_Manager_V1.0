/**
 * Invoices.loadFailed.test.tsx — To-Do 10.5, the Chemical Sales invoice list: a list read that
 * fails (an error, no list, or something other than a list) says "could not be loaded" with Try
 * again. It must never show "No invoices yet", $0 summary cards, a skeleton that never ends, or
 * older rows whose Post / Void / Print / Delete still work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type Mode = 'error' | 'nodata' | 'notlist';

const H = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  // Table name -> how its reads fail ('throws' rejects instead of answering).
  failing: new Map<string, 'error' | 'nodata' | 'notlist' | 'throws'>(),
  rpc: vi.fn(),
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
      return () => q;
    },
  });
  return q;
}

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  const client = { from: (table: string) => query(table === 'invoices_postable' ? 'invoices' : table), rpc: H.rpc };
  return { ...actual, supabase: client, supabaseUntyped: client };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));

import Invoices from './Invoices';

const FAILED = 'This list could not be loaded';

const posted = {
  id: 'inv-1', invoice_number: 'CS-1001', invoice_post_version: 'v1:inv-1', invoice_type: 'chemical_sale',
  status: 'posted', season: 2027, invoice_date: '2026-10-05', created_at: '2026-10-05T15:00:00+00:00',
  customer_id: 'cust-1', customer: { farm_name: 'Test Farm' }, salesman_id: null, order_id: null,
  deleted_at: null, total_amount_cents: 10000, balance_cents: 10000, is_quick_delivery: false,
};

const open = () => render(<MemoryRouter><Invoices /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-09T12:00:00'));
  H.failing = new Map();
  H.tables = { invoices: [posted] };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Invoices list', () => {
  it.each<Mode>(['error', 'nodata', 'notlist'])(
    'a %s list read says could not be loaded with Try again, not "No invoices yet" or zero cards',
    async (mode) => {
      H.failing.set('invoices', mode);
      open();

      expect(await screen.findByText(FAILED)).toBeInTheDocument();
      expect(screen.queryByText('No invoices yet')).not.toBeInTheDocument();
      expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
      expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);

      H.failing.delete('invoices');
      fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
      expect(await screen.findByText('CS-1001')).toBeInTheDocument();
      expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
      expect(screen.getAllByText('$100.00').length).toBeGreaterThan(0);
    },
  );

  it.each(['profile_public_view', 'orders'])('a %s label lookup that throws keeps the list and says the labels failed', async (table) => {
    H.tables.invoices = [{ ...posted, salesman_id: 'rep-1', order_id: 'ord-1' }];
    H.failing.set(table, 'throws');
    open();
    expect(await screen.findByText('CS-1001')).toBeInTheDocument();
    expect(H.toast).toHaveBeenCalledWith('error', 'Some salesperson or order labels could not be loaded.');
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
  });

  it('a refresh that fails after a void drops the older rows and their bulk actions', async () => {
    open();
    expect(await screen.findByText('CS-1001')).toBeInTheDocument();

    // Tick the posted invoice and void it; the refresh after the void fails.
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(await screen.findByRole('button', { name: /^Void 1/ }));
    H.rpc.mockResolvedValue({ data: { voided: 1, results: [] }, error: null });
    H.failing.set('invoices', 'error');
    fireEvent.change(await screen.findByPlaceholderText(/reason for voiding/), { target: { value: 'Duplicate invoice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Void 1 Invoice' }));

    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(screen.queryByText('CS-1001')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Void|Print|Post|Delete) \d/ })).not.toBeInTheDocument();
  });
});
