/**
 * InvoiceEditors.loadFailed.test.tsx — To-Do 10.5, the invoice editors: a read the editor
 * depends on that fails (an error, or no list at all) says "could not be loaded" with Try again,
 * in place of an editable invoice whose Save would write an empty (or another invoice's) line
 * list over the real one, or a split review whose Post would bill lines nobody saw.
 */
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  functions: {} as Record<string, unknown>,
  // Table or function name -> how its reads fail. 'held' answers with the rows of the moment it
  // was asked, but only once the test calls release().
  failing: new Map<string, 'error' | 'nodata' | 'notlist' | 'held'>(),
  held: [] as Array<() => void>,
  toast: vi.fn(),
}));

const release = () => { const waiting = H.held; H.held = []; waiting.forEach((answer) => answer()); };
const releaseFirst = () => { H.held.shift()?.(); };

// A query that ignores its filters and answers with the given rows (or a failure).
function fixedQuery(reply: { data: unknown; error: unknown; count: number | null }, held = false): Record<string, unknown> {
  const q: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown) => { if (held) H.held.push(() => resolve(reply)); else resolve(reply); };
      }
      if (prop === 'maybeSingle' || prop === 'single') {
        return () => Promise.resolve({
          data: Array.isArray(reply.data) ? (reply.data[0] ?? null) : reply.data,
          // .single() on no row answers PGRST116, as PostgREST does.
          error: reply.error ?? (prop === 'single' && Array.isArray(reply.data) && reply.data.length === 0
            ? { message: 'no rows', code: 'PGRST116' } : null),
        });
      }
      return () => q;
    },
  });
  return q;
}

function replyFor(name: string, rows: unknown): { data: unknown; error: unknown; count: number | null } {
  const mode = H.failing.get(name);
  if (mode === 'held') return { data: rows, error: null, count: Array.isArray(rows) ? rows.length : null };
  if (mode === 'error') return { data: null, error: { message: 'connection reset', code: 'XX000' }, count: null };
  if (mode === 'nodata') return { data: null, error: null, count: null };
  if (mode === 'notlist') return { data: { unexpected: true }, error: null, count: null };
  return { data: rows, error: null, count: Array.isArray(rows) ? rows.length : null };
}

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  const client = {
    from: (table: string) => fixedQuery(replyFor(table, H.tables[table] ?? []), H.failing.get(table) === 'held'),
    rpc: (name: string) => fixedQuery(replyFor(name, H.functions[name] ?? []), H.failing.get(name) === 'held'),
  };
  return { ...actual, supabase: client, supabaseUntyped: client };
});
// Cost columns are admin-only reads of their own; these tests are about the invoice reads.
vi.mock('../lib/costFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/costFields')>()),
  withAdminCost: async (_table: string, row: unknown) => row,
  withAdminCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../hooks/useUnsavedChanges', () => ({ useUnsavedChanges: () => ({ state: 'unblocked' }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'idem', resetKey: vi.fn(), getKeyFor: () => 'idem', resetKeyFor: vi.fn() }),
}));
vi.mock('../components/invoices/WriteOffModal', () => ({ default: () => null }));
vi.mock('../components/invoices/InvoicePrintDialog', () => ({ default: () => null }));
vi.mock('../components/field-app/SelectLocationsModal', () => ({ default: () => null }));

import InvoiceDetail from './InvoiceDetail';
import FieldApplicationInvoiceRoute from '../components/FieldApplicationInvoiceRoute';
import FieldAppSplitInvoiceEditor from './FieldAppSplitInvoiceEditor';

const FAILED = 'This invoice could not be loaded';
const tryAgain = () => fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
const noSave = () => expect(screen.queryByRole('button', { name: /^Save$/ })).not.toBeInTheDocument();

// Exposes the router's navigate and the current path to the test.
let go: NavigateFunction;
let path = '';
function RouterProbe() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    go = navigate;
    path = pathname;
  }, [navigate, pathname]);
  return null;
}
const at = (url: string, routes: React.ReactNode) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes>{routes}</Routes>
    <RouterProbe />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  H.failing = new Map();
  H.held = [];
  H.tables = {};
  H.functions = {};
});
afterEach(cleanup);

describe('Invoice Detail', () => {
  const invoice = {
    id: 'inv1', invoice_number: 'INV-1001', invoice_type: 'chemical_sale', status: 'draft', customer_id: 'c1',
    invoice_date: '2026-10-01', due_date: null, payment_terms: 'Net 30', total_amount_cents: 5000, balance_cents: 5000,
    order_id: null, job_id: null, blend_ticket_id: null, invoice_group_id: null, field_app_billing_set_id: null,
    salesman_id: null, invoice_post_version: 'v1', customer: { farm_name: 'Big Farm' },
  };
  const line = {
    id: 'ii1', invoice_id: 'inv1', product_id: 'p1', description: 'Widget 2.5 GL', quantity: 2,
    unit_price_cents: 2500, extended_cents: 5000, sort_order: 0, product: { product_name: 'Widget 2.5 GL' },
  };
  const loaded = (inv: Row = invoice) => {
    H.tables.invoices = [inv];
    H.tables.invoices_postable = [inv];
    H.tables.invoice_items = [line];
  };
  const open = (id = 'inv1') => at(`/invoices/${id}`, <Route path="/invoices/:id" element={<InvoiceDetail routeArea="chemical" />} />);

  it.each(['error', 'nodata', 'notlist'] as const)('a %s line read says could not be loaded, not an editable invoice with no lines', async (mode) => {
    loaded();
    H.failing.set('invoice_items', mode);
    open();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    noSave();
    expect(screen.queryByText(/No line items yet/)).not.toBeInTheDocument();

    H.failing.delete('invoice_items');
    tryAgain();
    expect(await screen.findByRole('button', { name: /^Save$/ })).toBeInTheDocument();
    expect(screen.queryAllByDisplayValue('Widget 2.5 GL').length + screen.queryAllByText('Widget 2.5 GL').length).toBeGreaterThan(0);
  });

  it.each(['invoice_shares', 'write_offs'])('a %s read with no list says could not be loaded', async (table) => {
    loaded();
    H.failing.set(table, 'nodata');
    open();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    noSave();
  });

  it('a failed header read says could not be loaded, not "Invoice not found"', async () => {
    loaded();
    H.failing.set('invoices', 'error');
    open();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(H.toast).not.toHaveBeenCalledWith('error', 'Invoice not found');
    expect(path).toBe('/invoices/inv1');
  });

  it('a missing invoice still says "Invoice not found"', async () => {
    open('missing');
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', 'Invoice not found'));
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
  });

  it('a failed customer-terms read fails the load instead of reading default terms as a custom date', async () => {
    loaded({ ...invoice, payment_terms: null, due_date: '2026-10-31' });
    H.failing.set('customers', 'error');
    open();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
  });

  it('a customer-terms read with no row fails the load', async () => {
    loaded({ ...invoice, payment_terms: null, due_date: '2026-10-31' });
    H.failing.set('customers', 'nodata');
    open();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
  });

  it("an older load of the same invoice that answers late never replaces the newer one's lines", async () => {
    loaded();
    H.failing.set('invoice_items', 'held');
    open();
    // Leave and come back while the first load's line read is still out.
    await waitFor(() => expect(H.held.length).toBe(1));
    act(() => { go('/invoices/inv2'); });
    act(() => { go('/invoices/inv1'); });
    H.failing.delete('invoice_items');
    H.tables.invoice_items = [{ ...line, id: 'ii2', description: 'Gadget 1 GL', product: { product_name: 'Gadget 1 GL' } }];
    // The newest load finishes first, showing the new lines.
    expect(await screen.findByRole('button', { name: /^Save$/ })).toBeInTheDocument();
    expect(screen.queryAllByText('Gadget 1 GL').length + screen.queryAllByDisplayValue('Gadget 1 GL').length).toBeGreaterThan(0);
    // Then the first load's line read answers, with the lines of the moment it was asked.
    expect(H.held.length).toBe(1);
    await act(async () => { release(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryAllByText('Gadget 1 GL').length + screen.queryAllByDisplayValue('Gadget 1 GL').length).toBeGreaterThan(0);
    expect(screen.queryByText('Widget 2.5 GL')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Widget 2.5 GL')).not.toBeInTheDocument();
  });

  it("a Save on one invoice that finishes after the move to another never leaves the other's spinner up", async () => {
    // An invoice with an order behind it, so Save may carry its product line.
    loaded({ ...invoice, order_id: 'o1' });
    open();
    H.functions.save_invoice = 'inv1';
    H.failing.set('save_invoice', 'held');
    fireEvent.click(await screen.findByRole('button', { name: /^Save$/ }));
    // The save is out; move to another invoice whose line read is out too.
    await waitFor(() => expect(H.held.length).toBe(1));
    const other = { ...invoice, order_id: 'o1', id: 'inv2', invoice_number: 'INV-1002' };
    H.tables.invoices = [other];
    H.tables.invoices_postable = [other];
    H.failing.set('invoice_items', 'held');
    act(() => { go('/invoices/inv2'); });
    await waitFor(() => expect(H.held.length).toBe(2));
    // The save on the first invoice answers, and its reload of that invoice is asked for.
    await act(async () => { releaseFirst(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    // Then the second invoice's line read answers: the second invoice shows.
    H.failing.delete('invoice_items');
    await act(async () => { release(); });
    expect(await screen.findByRole('button', { name: /^Save$/ })).toBeInTheDocument();
    expect(screen.getAllByText('INV-1002').length).toBeGreaterThan(0);
  });

  it('a split-group read with no list says could not be loaded', async () => {
    const grouped = { ...invoice, invoice_group_id: 'g1' };
    loaded(grouped);
    // The header is read with .single() (first row); the member list gets the object back.
    H.tables.invoices_postable = { ...grouped } as unknown as Row[];
    open();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
  });

  it("opening another invoice whose lines fail never shows the first invoice's lines", async () => {
    loaded();
    open();
    expect(await screen.findByRole('button', { name: /^Save$/ })).toBeInTheDocument();

    const other = { ...invoice, id: 'inv2', invoice_number: 'INV-1002' };
    H.tables.invoices = [other];
    H.tables.invoices_postable = [other];
    H.failing.set('invoice_items', 'error');
    act(() => { go('/invoices/inv2'); });
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Widget 2.5 GL')).not.toBeInTheDocument();
    expect(screen.queryByText('Widget 2.5 GL')).not.toBeInTheDocument();
    noSave();
  });
});

describe('Field Application Invoice', () => {
  const invoice = {
    id: 'fa1', invoice_number: 'INV-2001', invoice_type: 'field_application', status: 'draft', customer_id: 'c1',
    invoice_date: '2026-10-01', due_date: null, payment_terms: 'Net 30', total_amount_cents: 12000, balance_cents: 12000,
    job_id: null, blend_ticket_id: null, invoice_group_id: null, field_app_billing_set_id: null, season: 2026,
    salesman_id: null, invoice_post_version: 'v1',
  };
  const location = {
    field_id: 'f1', invoice_id: 'fa1', map_number: 1, total_acres: 80, applied_acres: 80, sort_order: 0,
    field: { field_name: 'North 80', crop_type: 'Corn', total_acres: 80, measured_acres: null, override_acres: null, customer: { farm_name: 'Big Farm' } },
  };
  const chem = {
    id: 'ci1', invoice_id: 'fa1', product_id: 'p1', description: 'Atrazine 4L', rate_per_acre: 32, rate_unit: 'oz',
    quantity: 20, unit_size: 'gal', unit_price_cents: 600, extended_cents: 12000, sort_order: 0,
  };
  const loaded = (inv: Row = invoice) => {
    H.tables.invoices = [inv];
    H.tables.invoices_postable = [inv];
    H.tables.field_app_locations = [location];
    H.tables.invoice_items = [chem];
    H.tables.invoice_shares = [{ customer_id: 'c1', customer_name: 'Big Farm', split_percentage: 100, acres: 80, amount_cents: 12000, is_primary: true }];
    H.tables.products = [{ id: 'p1', max_label_rate: 64, max_label_rate_unit: 'oz', rei_hours: 12, phi_days: 30 }];
  };
  const open = () => at('/invoices/field-app/fa1', <Route path="/invoices/field-app/:id" element={<FieldApplicationInvoiceRoute />} />);

  it.each(['error', 'nodata', 'notlist'] as const)('a %s chemical-line read says could not be loaded, not an editable invoice with no chemicals', async (mode) => {
    loaded();
    H.failing.set('invoice_items', mode);
    open();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    noSave();

    H.failing.delete('invoice_items');
    tryAgain();
    expect(await screen.findByRole('button', { name: /^Save$/ })).toBeInTheDocument();
    expect(screen.queryByText(FAILED)).not.toBeInTheDocument();
  });

  it.each(['field_app_locations', 'invoice_shares', 'products'])('a failed %s read says could not be loaded', async (table) => {
    loaded();
    H.failing.set(table, 'error');
    open();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    noSave();
    expect(path).toBe('/invoices/field-app/fa1');
  });

  it('a failed sibling read on a split invoice says could not be loaded, with no Save to zero their discounts', async () => {
    const grouped = { ...invoice, invoice_group_id: 'g1' };
    loaded(grouped);
    // The header is read with .single() (first row); the sibling list gets the object back.
    H.tables.invoices_postable = { ...grouped } as unknown as Row[];
    open();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    noSave();
  });

  it('a failed location count on a job invoice says could not be loaded, not a jump to the quantity editor', async () => {
    loaded({ ...invoice, job_id: 'j1' });
    H.failing.set('field_app_locations', 'error');
    open();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(path).toBe('/invoices/field-app/fa1');
  });

  it('a source-job read with no row says could not be loaded', async () => {
    loaded({ ...invoice, job_id: 'j1' });
    H.tables.jobs = [];
    open();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
  });

  it('a label read that leaves out a line\'s product says could not be loaded, not "no label max"', async () => {
    loaded();
    H.tables.products = [];
    open();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    noSave();
  });

  it('a failed header read says could not be loaded and stays on the invoice', async () => {
    loaded();
    H.failing.set('invoices', 'error');
    open();
    expect(await screen.findByText(FAILED)).toBeInTheDocument();
    expect(path).toBe('/invoices/field-app/fa1');
  });
});

describe('Split billing editor', () => {
  const open = (url: string) => at(url, <>
    <Route path="/split-billing/new" element={<FieldAppSplitInvoiceEditor />} />
    <Route path="/split-billing/:id" element={<FieldAppSplitInvoiceEditor />} />
  </>);
  const child = { id: 'si1', invoice_number: 'INV-3001', customer_id: 'c1', total_amount_cents: 4000, send_disposition: 'normal', status: 'draft', invoice_group_id: 'g1', invoice_post_version: 'v1' };
  const enabled = () => {
    H.tables.app_settings = [{ setting_value: 'true' }];
    H.tables.field_app_billing_sets = [{ id: 'set1', invoice_group_id: 'g1', source_job_id: null }];
    H.tables.invoices_postable = [child];
    H.tables.customers = [{ id: 'c1', farm_name: 'Big Farm' }];
    H.tables.invoice_items = [{ id: 'li1', invoice_id: 'si1', description: 'Atrazine 4L' }];
    H.tables.invoice_line_shares = [{ invoice_item_id: 'li1', customer_id: 'c1', unit_price_cents: 4000, amount_cents: 4000 }];
  };

  it('a failed setting read says could not be loaded, not "not enabled"', async () => {
    enabled();
    H.failing.set('app_settings', 'error');
    open('/split-billing/new');
    expect(await screen.findByText('Split billing could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('Per-line split billing is not enabled')).not.toBeInTheDocument();

    H.failing.delete('app_settings');
    tryAgain();
    expect(await screen.findByText('Split Billing — New')).toBeInTheDocument();
  });

  it.each(['invoices_postable', 'invoice_items', 'invoice_line_shares'])('a reopened draft whose %s read has no list says could not be loaded, with no Post', async (table) => {
    enabled();
    H.failing.set(table, 'nodata');
    open('/split-billing/set1');
    expect(await screen.findByText('This split billing draft could not be loaded')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Post$/ })).not.toBeInTheDocument();

    H.failing.delete(table);
    tryAgain();
    expect(await screen.findByText('Split Billing — Saved Draft')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Post$/ })).toBeEnabled());
  });
});
