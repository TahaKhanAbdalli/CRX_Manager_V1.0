/**
 * MoneyScreens.paging.test.tsx — Goal 4 part 2: the AR, AP and prepay screens read every row.
 *
 * The server silently stops every reply at 1,000 rows, a table's or a function's. These
 * screens each made one request (or capped it lower: prepay customers at 500, a check's
 * open invoices at 200), so their totals and the actions built on them stopped short with
 * no warning. The fake server below caps every reply at 1,000 like the real one
 * (buildInMemoryQuery for tables, pagedRpcReply for functions), so each test here fails
 * against the old screen and passes against the paged one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery, pagedRpcReply, SERVER_ROW_CAP } from '../test-utils/inMemoryQuery';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  functions: {} as Record<string, unknown>,
  // A table whose reads should come from a hand-made reply (a search box's `.or()` filter).
  custom: {} as Record<string, unknown>,
  rpcCalls: [] as Array<[string, unknown]>,
  toast: vi.fn(),
}));

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    ...actual,
    supabase: {
      from: (table: string) => (table in H.custom
        ? H.custom[table]
        : buildInMemoryQuery(H.tables[table] ?? [])),
      rpc: (name: string, args: unknown) => {
        H.rpcCalls.push([name, args]);
        return pagedRpcReply({ data: H.functions[name] ?? [], error: null });
      },
    },
  };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));

import ARaging from './ARaging';
import AccountsReceivable from './AccountsReceivable';
import AccountsPayable from './AccountsPayable';
import FieldProfitability from './FieldProfitability';
import PaymentAllocation from './PaymentAllocation';
import FinanceChargePreviewModal from '../components/invoices/FinanceChargePreviewModal';
import PrepaymentManagerPanel from '../components/prepay/PrepaymentManagerPanel';
import PrepayWorkspacePanel from '../components/prepay/PrepayWorkspacePanel';

// Past the server cap, so one read cannot hold them all.
const TOTAL = SERVER_ROW_CAP + 10;
// Drawing over 1,000 rows is slow when the whole suite runs at once, and CI's coverage run
// is several times slower again.
vi.setConfig({ testTimeout: 120_000 });
// findBy / waitFor give up after 1 s by default; allow for the same slowdown.
configure({ asyncUtilTimeout: 30_000 });
const pad = (i: number) => String(i).padStart(4, '0');
const many = <T,>(make: (i: number) => T): T[] => Array.from({ length: TOTAL }, (_, i) => make(i));

beforeEach(() => {
  vi.clearAllMocks();
  H.tables = {};
  H.functions = {};
  H.custom = {};
  H.rpcCalls = [];
});
afterEach(cleanup);

const renderAt = (ui: React.ReactElement, path = '/') => render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);
// The card or block holding a label, for reading the figure next to it.
const blockOf = (label: string | RegExp) => screen.getAllByText(label)[0].parentElement!;

const agingRow = (i: number) => ({
  customer_id: `c${pad(i)}`, farm_name: `Farm ${pad(i)}`, current_amount: 10, days_30: 0, days_60: 0, days_90: 0,
  over_90: 0, total_outstanding: 10, prepay_balance_cents: 0, open_credit_cents: 0,
});

describe('money screens past the 1,000-row server cap', () => {
  it('AR Aging totals every customer (H15)', async () => {
    H.functions.get_ar_aging = many(agingRow);
    renderAt(<ARaging />);
    // 1,010 customers at $10.00: a read stopped at 1,000 would show $10,000.00.
    await waitFor(() => expect(blockOf('Total Outstanding')).toHaveTextContent('$10,100.00'));
  });

  it('the AR summary strip counts every customer, prepay credit and credit memo (H15, H16, H38)', async () => {
    H.functions.get_ar_aging = many(agingRow);
    H.tables.prepay_credits = many((i) => ({ id: `pc${pad(i)}`, balance_cents: 100 }));
    H.tables.invoices = many((i) => ({
      id: `cm${pad(i)}`, invoice_type: 'credit_memo', status: 'posted', balance_cents: -100, deleted_at: null,
    }));
    renderAt(<AccountsReceivable />);
    await waitFor(() => expect(blockOf('Total Owed')).toHaveTextContent('$10,100.00'));
    expect(blockOf('Unused Prepay')).toHaveTextContent('$1,010.00');
    expect(blockOf('Credit Memos')).toHaveTextContent('$1,010.00');
  });

  it('AP Aging totals every vendor (H37)', async () => {
    H.functions.get_ap_dashboard_summary = { total_owed_cents: 0, due_this_week_cents: 0, due_this_month_cents: 0, overdue_cents: 0, open_bill_count: 0 };
    H.functions.get_ap_aging = many((i) => ({
      vendor_id: `v${pad(i)}`, vendor_name: `Vendor ${pad(i)}`, current_amount: 1000, days_1_30: 0, days_31_60: 0,
      days_61_90: 0, over_90: 0, total_outstanding: 1000, bill_count: 1,
    }));
    renderAt(<AccountsPayable />);
    await waitFor(() => expect(blockOf('Totals')).toHaveTextContent('$10,100.00'));
  });

  it('Field Profitability totals every field (H19)', async () => {
    H.functions.get_field_profitability = many((i) => ({
      field_id: `f${pad(i)}`, field_name: `Field ${pad(i)}`, customer_id: 'c1', customer_name: 'Big Farm', season: '2027',
      total_acres_applied: 1, revenue_cents: 1000, cost_cents: 0, margin_cents: 1000, margin_per_acre_cents: 1000,
    }));
    renderAt(<FieldProfitability />);
    await waitFor(() => expect(screen.getByText('Totals').closest('tr')!).toHaveTextContent('$10,100.00'));
  });

  it('the finance-charge preview lists, and Generate All charges, every customer (H24)', async () => {
    H.functions.preview_finance_charges = many((i) => ({
      customer_id: `c${pad(i)}`, customer_name: `Farm ${pad(i)}`, account_number: null, overdue_balance_cents: 10000,
      charge_rate: 1.5, grace_days: 0, days_overdue: 40, charge_amount_cents: 150, finance_charge_enabled: true, open_credit_cents: 0,
    }));
    H.functions.generate_finance_charges = { charges_generated: TOTAL, details: [] };
    render(<FinanceChargePreviewModal open onClose={vi.fn()} asOfDate="2026-10-20" onSuccess={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: `Generate All (${TOTAL})` }));
    await waitFor(() => expect(H.rpcCalls.some(([name]) => name === 'generate_finance_charges')).toBe(true));
    const [, args] = H.rpcCalls.find(([name]) => name === 'generate_finance_charges')!;
    expect((args as { p_customer_ids: string[] }).p_customer_ids).toHaveLength(TOTAL);
  });

  it('a check can be applied to every open invoice, not the first 200 (H43)', async () => {
    const search: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'or', 'order', 'limit']) search[m] = () => search;
    search.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [{ id: 'c1', farm_name: 'Big Farm', account_number: null, prepay_balance_cents: 0 }], error: null }).then(resolve);
    H.custom.customers = search;
    H.tables.invoices = many((i) => ({
      id: `inv${pad(i)}`, invoice_number: `INV-${pad(i)}`, invoice_date: '2026-10-01', created_at: '2026-10-01T12:00:00Z',
      due_date: null, invoice_type: 'chemical_sale', customer_id: 'c1', status: 'posted', deleted_at: null,
      total_amount_cents: 100, balance_cents: 100,
    }));
    renderAt(<PaymentAllocation />, '/payments');

    fireEvent.change(await screen.findByPlaceholderText(/search by name/i), { target: { value: 'Big' } });
    fireEvent.click(await screen.findByRole('button', { name: /Big Farm/ }));
    expect(await screen.findByText(`(${TOTAL} invoices, $1,010.00 outstanding)`, {}, { timeout: 60000 })).toBeInTheDocument();

    // A $1,010.00 check auto-allocates across every invoice, the oldest past row 1,000 included:
    // capped at 200 invoices, $810.00 of it would have had nowhere to go.
    // The Check Amount box is the first "0.00" field; each invoice row has one after it.
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[0], { target: { value: '1010.00' } });
    fireEvent.click(screen.getByRole('button', { name: /Auto-Allocate/ }));
    await waitFor(() => expect(screen.getByText('Allocated:').parentElement!).toHaveTextContent('$1,010.00'));
  });

  it('a check cannot be applied while the open invoices failed to load (it would all go to prepay)', async () => {
    const search: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'or', 'order', 'limit']) search[m] = () => search;
    search.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: [{ id: 'c1', farm_name: 'Big Farm', account_number: null, prepay_balance_cents: 0 }], error: null }).then(resolve);
    H.custom.customers = search;
    const failing: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'gt', 'is', 'order', 'range']) failing[m] = () => failing;
    failing.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: { message: 'connection reset' }, count: null }).then(resolve);
    H.custom.invoices = failing;
    renderAt(<PaymentAllocation />, '/payments');

    fireEvent.change(await screen.findByPlaceholderText(/search by name/i), { target: { value: 'Big' } });
    fireEvent.click(await screen.findByRole('button', { name: /Big Farm/ }));
    expect(await screen.findByText(/Open invoices could not be loaded/)).toBeInTheDocument();
    fireEvent.change(screen.getAllByPlaceholderText('0.00')[0], { target: { value: '500.00' } });
    expect(screen.getByRole('button', { name: /Apply Payment/ })).toBeDisabled();
  });

  it('the Prepayment Manager lists every prepay customer and all their unpaid invoices (H20)', async () => {
    H.tables.customers = many((i) => ({ id: `c${pad(i)}`, farm_name: `Farm ${pad(i)}`, prepay_balance_cents: 100, is_active: true }));
    H.tables.invoices = many((i) => ({ id: `inv${pad(i)}`, customer_id: `c${pad(i)}`, status: 'posted', balance_cents: 100, deleted_at: null }));
    renderAt(<PrepaymentManagerPanel />);
    // Was the first 500 customers, each with its own unchecked invoice read.
    await waitFor(() => expect(screen.getByText(`${TOTAL} customer(s) with prepay balances`)).toBeInTheDocument());
    expect(blockOf('Total Prepay Credits').parentElement!).toHaveTextContent('$1,010.00');
    expect(screen.getByText(`${TOTAL} invoice(s)`)).toBeInTheDocument();
  });

  it("the prepay workspace's Apply step lists every unpaid invoice (N9)", async () => {
    H.custom.customers = buildInMemoryQuery([{ id: 'c1', farm_name: 'Big Farm', prepay_balance_cents: 100, is_active: true }]);
    H.tables.prepay_credits = [{ id: 'pc1', customer_id: 'c1', reference_number: '1001', bucket_label: null, original_amount_cents: 100, balance_cents: 100, created_at: '2026-10-01T12:00:00Z' }];
    H.tables.invoices = many((i) => ({
      id: `inv${pad(i)}`, invoice_number: `INV-${pad(i)}`, customer_id: 'c1', status: 'posted', deleted_at: null,
      total_amount_cents: 100, balance_cents: 100, due_date: '2026-11-01', created_at: '2026-10-01T12:00:00Z',
    }));
    renderAt(<PrepayWorkspacePanel />, '/?customer=c1');
    // The unpaid-invoice badge sums every invoice: 1,010 at $1.00.
    await waitFor(() => expect(screen.getByText('Unpaid Invoices').parentElement!).toHaveTextContent('$1,010.00'));
  });
});
