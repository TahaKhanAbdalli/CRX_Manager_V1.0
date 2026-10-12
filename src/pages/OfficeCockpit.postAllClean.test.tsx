/**
 * OfficeCockpit.postAllClean.test.tsx — "Post all clean" posts only what the cockpit showed.
 *
 * Codex Luna HIGH (2026-10-12): the cockpit's bulk post sent post_invoice with no posting
 * version, so an invoice another admin changed after the cockpit loaded (say from $5,000.00 to
 * $7,000.00) posted at the new amount nobody reviewed. Now, after the fresh watchdog re-check,
 * the cockpit reads each still-clean invoice's posting version, re-reads the rows, refuses if
 * any row differs from what it showed, and sends the version with each post.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { mockFrom, mockRpc, mockToast, state } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  state: { rereadTotalCents: null as number | null },
}));

// The posting version the reader returns (a 32-character lowercase md5).
const POST_VERSION = '0123456789abcdef0123456789abcdef';

const SHOWN = {
  id: 'inv-1',
  invoice_number: 'FA-1001',
  invoice_date: '2026-10-05',
  status: 'draft',
  total_amount_cents: 500000,
  customer_id: 'cust-1',
  updated_at: '2026-10-05T10:00:00+00:00',
  deleted_at: null,
  job_id: null,
  invoice_group_id: null,
  pricing_pending: false,
  customer: { farm_name: 'Test Farm' },
};

/** A query chain whose result depends on the table and the selected columns. */
function query(table: string) {
  const chain: Record<string, unknown> = {};
  let columns = '';
  const self = () => chain;
  chain.select = vi.fn((cols: string) => { columns = cols; return chain; });
  for (const method of ['eq', 'neq', 'is', 'order', 'limit', 'in', 'gte', 'lte', 'lt', 'gt', 'not', 'or', 'range']) {
    chain[method] = vi.fn(self);
  }
  const result = () => {
    if (table !== 'invoices') return { data: [], error: null };
    // The cockpit's own "Ready to Post" load.
    if (columns.includes('pricing_pending')) return { data: [SHOWN], error: null };
    // The Post review's re-read of the shown rows.
    if (columns.includes('deleted_at') && columns.includes('updated_at')) {
      const total = state.rereadTotalCents ?? SHOWN.total_amount_cents;
      return { data: [{ ...SHOWN, total_amount_cents: total }], error: null };
    }
    return { data: [], error: null };
  };
  chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve().then(result).then(resolve, reject);
  return chain;
}

function rpcResult(data: unknown) {
  const result = Promise.resolve({ data, error: null });
  return Object.assign(result, { throwOnError: () => result });
}

function answerRpc(name: string) {
  switch (name) {
    case 'operational_dashboard_summary':
      return rpcResult({
        active_orders_count: 0, open_quotes_draft: 0, open_quotes_sent: 0, pending_deliveries_count: 0,
        open_pos_count: 0, inventory_available: 0, inventory_prebooked: 0, on_order_units: 0,
        on_order_po_count: 0, committed_units: 0, committed_order_count: 0,
      });
    case 'financial_dashboard_summary':
      return rpcResult({
        open_ar_balance: 0, total_profit: 0, total_prepay_unallocated: 0, po_unreceived_value: 0,
        customers_over_credit_count: 0, ar_aging_buckets: { days_61_90: 0, days_90_plus: 0 },
      });
    case 'get_program_completion':
      return rpcResult([{ completion_pct: 0 }]);
    case 'refresh_watchdog_flags':
      return rpcResult({ flagged: 0 });
    case 'get_invoice_post_version':
      return rpcResult(POST_VERSION);
    case 'post_invoice':
      return rpcResult(null);
    default:
      // get_watchdog_flags, get_job_inventory_shortfalls, get_expiring_planned_holds: none.
      return rpcResult([]);
  }
}

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' } }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  // The posting-version reader and the versioned post go through supabaseUntyped.
  const client = { from: mockFrom, rpc: mockRpc };
  return { ...actual, supabase: client, supabaseUntyped: client };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import OfficeCockpit from './OfficeCockpit';

async function clickPostAllClean() {
  render(<OfficeCockpit />);
  fireEvent.click(await screen.findByRole('button', { name: /Post all clean/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Post 1 invoice(s)' }));
}

const rpcNames = () => mockRpc.mock.calls.map(([name]) => name as string);

describe('OfficeCockpit — Post all clean checks what the cockpit showed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rereadTotalCents = null;
    mockFrom.mockImplementation(query);
    mockRpc.mockImplementation(answerRpc);
  });

  it('posts each still-clean invoice with the posting version read after the fresh watchdog check', async () => {
    await clickPostAllClean();

    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('post_invoice', {
      p_invoice_id: 'inv-1',
      p_idempotency_key: expect.any(String),
      p_expected_version: POST_VERSION,
    }));
    expect(mockRpc).toHaveBeenCalledWith('get_invoice_post_version', { p_invoice_ids: ['inv-1'] });
    // The version is read after the watchdog refresh, and before the post.
    const names = rpcNames();
    expect(names.indexOf('refresh_watchdog_flags')).toBeLessThan(names.indexOf('get_invoice_post_version'));
    expect(names.indexOf('get_invoice_post_version')).toBeLessThan(names.indexOf('post_invoice'));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Posted 1 clean invoice(s)'));
  });

  it('posts nothing when an invoice changed since the cockpit loaded, reloads and says so', async () => {
    // Another admin changes the invoice from $5,000.00 to $7,000.00 after the cockpit loaded.
    state.rereadTotalCents = 700000;
    const cockpitLoads = () =>
      mockRpc.mock.calls.filter(([name]) => name === 'operational_dashboard_summary').length;

    render(<OfficeCockpit />);
    fireEvent.click(await screen.findByRole('button', { name: /Post all clean/ }));
    const confirm = await screen.findByRole('button', { name: 'Post 1 invoice(s)' });
    const loadsAtClick = cockpitLoads();
    fireEvent.click(confirm);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      '1 invoice(s) changed since this list loaded — the list was reloaded; check them and post again.',
    ));
    expect(rpcNames()).not.toContain('post_invoice');
    expect(rpcNames()).not.toContain('post_invoice_group');
    await waitFor(() => expect(cockpitLoads()).toBeGreaterThan(loadsAtClick));
    expect(mockToast).not.toHaveBeenCalledWith('success', expect.anything());
  });
});
