/**
 * FieldInvoices.paging.test.tsx — Goal 4 part 2: the Field Invoices tabs read every invoice.
 *
 * The server silently stops every reply at 1,000 rows. The three panels used to ask for
 * 2,000 in one request, so past 1,000 invoices the totals stopped there, "Post All" skipped
 * the oldest drafts and "Unpost All" missed posted invoices, with no warning (the 2,000
 * warning toast could never fire). The fake server here (buildInMemoryQuery) caps every
 * reply at 1,000 rows like the real one, so these tests fail against the old panels.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery, SERVER_ROW_CAP } from '../../test-utils/inMemoryQuery';

const { mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return { ...actual, supabase: { from: mockFrom, rpc: mockRpc } };
});
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
// The phone layout draws a second copy of every row; these tests read the desktop table
// and footer, so skip it (drawing 1,010 rows twice ran past the timeout under CI coverage).
vi.mock('../ui/MobileCardList', () => ({ default: ({ desktop }: { desktop: React.ReactNode }) => <>{desktop}</> }));

import FieldInvoicesUnpostedPanel from './FieldInvoicesUnpostedPanel';
import FieldInvoicesPostedPanel from './FieldInvoicesPostedPanel';
import FieldInvoicesListPanel from './FieldInvoicesListPanel';

// Past the server cap, so a single read cannot hold them all.
const TOTAL = SERVER_ROW_CAP + 10;
// Drawing and posting over 1,000 invoices is slow when the whole suite runs at once, and
// CI's coverage run is several times slower again (one test took 31 s there).
vi.setConfig({ testTimeout: 120_000 });
// findBy / waitFor give up after 1 s by default; allow for the same slowdown.
configure({ asyncUtilTimeout: 30_000 });

function fieldInvoice(i: number, status: string) {
  const n = String(i).padStart(4, '0');
  return {
    id: `fa-${status}-${n}`,
    invoice_number: `FA-${n}`,
    invoice_type: 'field_application',
    status,
    season: 2027,
    invoice_date: '2026-10-05',
    created_at: '2026-10-05T15:00:00+00:00',
    customer_id: 'cust-1',
    customer: { farm_name: 'Test Farm' },
    job: null,
    job_id: null,
    blend_ticket_id: null,
    invoice_group_id: null,
    deleted_at: null,
    field_app_locations: [],
    invoice_items: [],
    total_acres: 1,
    total_amount_cents: 1000,
    paid_amount_cents: 0,
    prepay_applied_cents: 0,
    balance_cents: 1000,
  };
}

let rows: ReturnType<typeof fieldInvoice>[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  // "Today" is in season 2027, so every invoice below is this season's.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-09T12:00:00'));
  mockFrom.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? rows : []));
  mockRpc.mockImplementation(() => {
    const result = Promise.resolve({ data: { ok: true }, error: null });
    return Object.assign(result, { throwOnError: () => result });
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const renderInRouter = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('Field Invoices past the 1,000-row server cap', () => {
  it('Unposted: lists and totals every draft, and Post All posts every one', async () => {
    rows = Array.from({ length: TOTAL }, (_, i) => fieldInvoice(i, 'draft'));
    renderInRouter(<FieldInvoicesUnpostedPanel />);

    expect(await screen.findByText(`Invoices Displayed: ${TOTAL}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Post All/ }));
    fireEvent.click(await screen.findByRole('button', { name: `Post ${TOTAL} invoice(s)` }));

    await waitFor(() => expect(mockRpc.mock.calls.filter(([name]) => name === 'post_invoice')).toHaveLength(TOTAL));
    // The oldest draft, past the first 1,000, is posted too.
    const posted = new Set(mockRpc.mock.calls.filter(([name]) => name === 'post_invoice').map(([, a]) => (a as { p_invoice_id: string }).p_invoice_id));
    expect(posted.has(`fa-draft-${String(TOTAL - 1).padStart(4, '0')}`)).toBe(true);
  });

  it('Posted: lists every posted invoice, and Unpost All counts every one', async () => {
    rows = Array.from({ length: TOTAL }, (_, i) => fieldInvoice(i, 'posted'));
    renderInRouter(<FieldInvoicesPostedPanel />);

    expect(await screen.findByText(`Invoices Displayed: ${TOTAL}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Unpost All (${TOTAL})` })).toBeInTheDocument();
  });

  it('All tab: the Unposted card counts every draft', async () => {
    rows = Array.from({ length: TOTAL }, (_, i) => fieldInvoice(i, 'draft'));
    renderInRouter(<FieldInvoicesListPanel />);

    await waitFor(() => expect(screen.getByText(String(TOTAL))).toBeInTheDocument());
  });

  it('a failed page shows an error, never a short list or Post All', async () => {
    rows = Array.from({ length: TOTAL }, (_, i) => fieldInvoice(i, 'draft'));
    // The second page fails, like a dropped connection.
    mockFrom.mockImplementation((table: string) => {
      const query = buildInMemoryQuery(table === 'invoices' ? rows : []);
      const range = query.range as (from: number, to: number) => unknown;
      query.range = (from: number, to: number) => {
        if (from > 0) return Promise.resolve({ data: null, error: { message: 'connection reset' }, count: null });
        return range(from, to);
      };
      return query;
    });
    renderInRouter(<FieldInvoicesUnpostedPanel />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Unposted field invoices could not be loaded');
    expect(screen.queryByRole('button', { name: /Post All/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Invoices Displayed/)).not.toBeInTheDocument();
  });
});
