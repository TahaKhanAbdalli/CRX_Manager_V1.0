/**
 * Invoices.batchPrint.test.tsx — To-Do 10.5 follow-up: Print Selected on the Chemical Sales
 * list must not print an invoice whose customer address or shares could not be read. It used to
 * log the failed customer read and print a blank address block, and ignored a failed shares read
 * (a split invoice printed with no share breakdown).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type FailMode = 'error' | 'nodata' | 'notlist' | 'throws';

const H = vi.hoisted(() => ({
  tables: {} as Record<string, unknown>,
  failing: new Map<string, FailMode>(),
  toast: vi.fn(),
  printed: vi.fn(),
}));

function replyFor(table: string): { data: unknown; error: unknown; count: number | null } {
  const rows = H.tables[table] ?? [];
  const mode = H.failing.get(table);
  if (mode === 'error') return { data: null, error: { message: 'connection reset', code: 'XX000' }, count: null };
  if (mode === 'nodata') return { data: null, error: null, count: null };
  if (mode === 'notlist') return { data: { unexpected: true }, error: null, count: null };
  return { data: rows, error: null, count: Array.isArray(rows) ? rows.length : 1 };
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
  const client = { from: (table: string) => query(table === 'invoices_postable' ? 'invoices' : table), rpc: vi.fn() };
  return { ...actual, supabase: client, supabaseUntyped: client };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
// The real build and guards; only the PDF output is recorded instead of downloaded.
vi.mock('../lib/invoicePdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/invoicePdf')>()),
  generateBatchInvoicePdf: async (list: unknown[]) => { H.printed(list); return { doc: {}, failures: [] }; },
}));
vi.mock('../components/invoices/InvoicePrintDialog', () => ({
  default: ({ open, onPrint }: { open: boolean; onPrint: (options: Record<string, never>) => void }) =>
    (open ? <button type="button" onClick={() => onPrint({})}>Print with defaults</button> : null),
}));

import Invoices from './Invoices';

const posted = {
  id: 'inv-1', invoice_number: 'CS-1001', invoice_post_version: 'v1:inv-1', invoice_type: 'chemical_sale',
  status: 'posted', season: 2027, invoice_date: '2026-10-05', created_at: '2026-10-05T15:00:00+00:00',
  customer_id: 'cust-1', customer: { farm_name: 'Test Farm' }, salesman_id: null, order_id: null,
  deleted_at: null, total_amount_cents: 10000, balance_cents: 10000, is_quick_delivery: false,
};
const line = { id: 'it-1', invoice_id: 'inv-1', description: 'Herbicide', quantity: 1, unit_price_cents: 10000, extended_cents: 10000, sort_order: 0 };

async function printSelected() {
  render(<MemoryRouter><Invoices /></MemoryRouter>);
  expect(await screen.findByText('CS-1001')).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('checkbox')[0]);
  fireEvent.click(await screen.findByRole('button', { name: /^Print 1 Selected/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Print with defaults' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-09T12:00:00'));
  H.failing = new Map();
  H.tables = {
    invoices: [posted],
    invoice_items: [line],
    invoice_shares: [],
    customers: { billing_address: '9 Barn Rd', city: 'Town', state: 'IL', zip: '62000', account_number: 'A-9', payment_terms: 'Net 30' },
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Invoices — Print Selected', () => {
  it('prints with the customer address when every read works', async () => {
    await printSelected();
    await waitFor(() => expect(H.printed).toHaveBeenCalledTimes(1));
    expect(H.printed.mock.calls[0][0][0]).toMatchObject({ invoice_number: 'CS-1001', customer_address: '9 Barn Rd' });
  });

  const cases: Array<[string, FailMode]> = [
    ['customers', 'error'], ['customers', 'nodata'], ['customers', 'throws'],
    ['invoice_shares', 'error'], ['invoice_shares', 'nodata'], ['invoice_shares', 'notlist'], ['invoice_shares', 'throws'],
  ];
  for (const [table, mode] of cases) {
    it(`prints nothing and says so when the ${table} read ${mode === 'nodata' ? 'returns nothing' : mode}`, async () => {
      // Set after the list has loaded, so only the print's own reads fail.
      render(<MemoryRouter><Invoices /></MemoryRouter>);
      expect(await screen.findByText('CS-1001')).toBeInTheDocument();
      H.failing.set(table, mode);
      fireEvent.click(screen.getAllByRole('checkbox')[0]);
      fireEvent.click(await screen.findByRole('button', { name: /^Print 1 Selected/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Print with defaults' }));
      await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('Could not load the invoice details')));
      expect(H.printed).not.toHaveBeenCalled();
    });
  }
});
