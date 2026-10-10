/**
 * Invoicing is admin-only (Mason 2026-10-09) — the invoice detail page.
 *
 *  - A sales rep sees every invoice READ-ONLY: no Save, Post, Unpost, Transfer, Apply Credit or
 *    editable field (Print stays), and the customer's name comes from the names-only reader
 *    get_invoice_customer_names when the customers table hides it from them.
 *  - An admin's page is unchanged (no names reader call, Save and Post shown).
 *  - Addendum 8b: Post is disabled while the form has unsaved edits; when the Post confirm
 *    opens the page reads the posting version and sends it as p_expected_version; the credit
 *    check uses the SAVED invoice; INVOICE_CHANGED_SINCE_REVIEW reloads with a clear message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

type QueryResult = { data: unknown; error: unknown };
type QueryContext = { table: string; select: string; filters: Array<[string, unknown]> };

const {
  mockFrom, mockRpc, mockToast, mockNavigate, mockCreditCheck, authState, tables,
} = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockNavigate: vi.fn(),
  mockCreditCheck: vi.fn(async () => true),
  authState: { role: 'admin' as 'admin' | 'sales_rep' },
  tables: { resolve: (_ctx: { table: string; select: string; filters: Array<[string, unknown]> }): { data: unknown; error: unknown } => ({ data: [], error: null }) },
}));

/** A PostgREST-style chain that records the select and filters, resolved lazily per query. */
function chainFor(table: string): Record<string, unknown> {
  const ctx: QueryContext = { table, select: '', filters: [] };
  const chain: Record<string, unknown> = {};
  const passthrough = ['insert', 'update', 'upsert', 'delete', 'neq', 'gt', 'gte', 'lt', 'lte',
    'like', 'ilike', 'in', 'contains', 'range', 'filter', 'not', 'or', 'and', 'match', 'order',
    'limit', 'offset', 'single', 'maybeSingle', 'returns', 'abortSignal'];
  for (const name of passthrough) chain[name] = () => chain;
  chain.select = (columns: string) => { ctx.select = columns; return chain; };
  chain.eq = (column: string, value: unknown) => { ctx.filters.push([column, value]); return chain; };
  chain.is = (column: string, value: unknown) => { ctx.filters.push([column, value]); return chain; };
  chain.then = (onFulfilled: (value: QueryResult) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(tables.resolve(ctx)).then(onFulfilled, onRejected);
  return chain;
}

/** supabase-js rpc builder: awaitable, with throwOnError() (post_invoice RETURNS void). */
function rpcResult(result: QueryResult): Record<string, unknown> {
  const promise = Promise.resolve(result);
  return {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    throwOnError: () => (result.error ? Promise.reject(result.error) : Promise.resolve(result)),
  };
}

vi.mock('../lib/db', async () => {
  // The REAL result check, error-code matching and codes, so the INVOICE_CHANGED_SINCE_REVIEW
  // and no-data cases test what ships, not a copy of it.
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  const client = { from: mockFrom, rpc: mockRpc };
  return {
    supabase: client,
    supabaseUntyped: client,
    checkMutationResult: vi.fn(),
    assertRpcResult: actual.assertRpcResult,
    sanitizeError: actual.sanitizeError,
    describePostInvoiceBlock: actual.describePostInvoiceBlock,
    RpcErrorCodes: actual.RpcErrorCodes,
    hasRpcCode: actual.hasRpcCode,
  };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: `${authState.role}-1`, role: authState.role, full_name: 'Test User' },
    role: authState.role,
  }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: (operation: string) => ({
    getKey: () => `key-${operation}`,
    resetKey: vi.fn(),
    getKeyFor: () => `key-${operation}`,
    resetKeyFor: vi.fn(),
  }),
}));
vi.mock('../hooks/useGuardrails', () => ({
  useCreditLimitCheck: () => ({ warning: null, check: mockCreditCheck, dismiss: vi.fn() }),
}));
vi.mock('../lib/rupCompliance', () => ({
  checkRUPCompliance: vi.fn(async () => ({ hasRUPProducts: false, hasValidLicense: true, missingLicense: false, rupProductNames: [] })),
  rupRegisterDisposition: vi.fn(() => ({ label: 'COMPLIANT' })),
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/invoicePdf', () => ({
  downloadInvoicePdf: vi.fn(),
  generateInvoicePdf: vi.fn(),
  deriveFieldAppAppliedAcres: vi.fn(),
  groupReturnCreditDisplayItems: vi.fn((_type: string, items: unknown[]) => items),
}));
vi.mock('../lib/emailService', () => ({
  sendEmail: vi.fn(),
  pdfToBase64: vi.fn(),
  buildEmailHtml: vi.fn(() => '<p>test</p>'),
  isInvoiceEmailSuppressed: vi.fn(() => false),
}));
vi.mock('../components/invoices/WriteOffModal', () => ({ default: () => null }));
vi.mock('../components/invoices/InvoicePrintDialog', () => ({ default: () => null }));
vi.mock('../components/watchdog/WatchdogFlagBanner', () => ({ default: () => null }));

import InvoiceDetail from './InvoiceDetail';

const VERSION_A = '0123456789abcdef0123456789abcdef';
const VERSION_B = 'fedcba9876543210fedcba9876543210';

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    invoice_number: 'INV-0001',
    invoice_type: 'chemical_sale',
    status: 'draft',
    customer_id: 'cust-1',
    customer: { farm_name: 'Admin Visible Farms' },
    invoice_group_id: null,
    order_id: null,
    job_id: null,
    blend_ticket_id: null,
    salesman_id: null,
    invoice_date: '2026-10-05',
    due_date: null,
    payment_terms: 'Net 30',
    purchase_order_ref: '',
    total_amount_cents: 5000,
    balance_cents: 5000,
    paid_amount_cents: 0,
    prepay_applied_cents: 0,
    ...overrides,
  };
}

const lineItem = {
  id: 'item-1', product_id: 'prod-1', description: 'Widget', quantity: 1, unit_price_cents: 5000,
  extended_cents: 5000, cost_cents: 3000, sort_order: 0, product: { product_name: 'Widget' },
};

/** Route each query by table and selected columns, so every read gets its own row. */
function setupTables(invoice: Record<string, unknown>, saved: Record<string, unknown> = {}) {
  let fullLoads = 0;
  tables.resolve = (ctx) => {
    if (ctx.table === 'invoices') {
      if (ctx.select.startsWith('invoice_type, job_id')) return { data: invoice, error: null };
      if (ctx.select.startsWith('*, customer')) { fullLoads += 1; return { data: invoice, error: null }; }
      if (ctx.select.includes('invoice_items(product_id)')) {
        return {
          data: { customer_id: invoice.customer_id, total_amount_cents: invoice.total_amount_cents, invoice_items: [{ product_id: 'prod-1' }], ...saved },
          error: null,
        };
      }
      return { data: [], error: null };
    }
    if (ctx.table === 'invoice_items') return { data: [lineItem], error: null };
    return { data: [], error: null };
  };
  return { fullLoads: () => fullLoads };
}

function rpcCalls(name: string) {
  return mockRpc.mock.calls.filter(([rpcName]) => rpcName === name);
}

function renderAt(path: string, element = <InvoiceDetail routeArea="chemical" />) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/invoices/:id" element={element} />
        <Route path="/invoices" element={<p>Invoice list</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.role = 'admin';
  mockFrom.mockImplementation((table: string) => chainFor(table));
  mockRpc.mockImplementation((name: string) => {
    if (name === 'get_invoice_post_version' || name === 'get_invoice_group_post_version') {
      return rpcResult({ data: VERSION_A, error: null });
    }
    if (name === 'post_invoice_group') return rpcResult({ data: { posted: 2 }, error: null });
    return rpcResult({ data: null, error: null });
  });
});

describe('InvoiceDetail — a sales rep sees invoices read-only', () => {
  it('shows a draft invoice with no Save, Post, Transfer or editable field, and fills the hidden customer name', async () => {
    authState.role = 'sales_rep';
    setupTables(invoiceRow({
      customer_id: 'cust-other',
      customer: null, // RLS hides another rep's customer from the embed
      invoice_type: 'chemical_sale',
    }));
    mockRpc.mockImplementation((name: string) => rpcResult(name === 'get_invoice_customer_names'
      ? { data: [{ id: 'cust-other', farm_name: 'Other Rep Farms' }], error: null }
      : { data: null, error: null }));

    renderAt('/invoices/inv-1');
    expect(await screen.findByText('Other Rep Farms')).toBeInTheDocument();
    expect(rpcCalls('get_invoice_customer_names')).toEqual([
      ['get_invoice_customer_names', { p_customer_ids: ['cust-other'] }],
    ]);

    expect(screen.getByText(/Read-only — only an admin can change, post or unpost invoices/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Post$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add Product/ })).toBeNull();
    expect(screen.queryByPlaceholderText('Customer PO #')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Payment Terms' })).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.getByRole('button', { name: /Print/ })).toBeInTheDocument();
    // A rep never reads the posting version (the database refuses them).
    expect(rpcCalls('get_invoice_post_version')).toHaveLength(0);
  });

  it('shows a posted invoice with no Unpost, Apply Credit, Void, Record Payment or Write Off', async () => {
    authState.role = 'sales_rep';
    setupTables(invoiceRow({ status: 'posted', balance_cents: 5000 }));

    renderAt('/invoices/inv-1');
    expect((await screen.findAllByText('INV-0001')).length).toBeGreaterThan(0);
    for (const name of [/Unpost/, /Apply Credit/, /^Void$/, /Record Payment/, /Write Off/]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.getByRole('button', { name: /Print/ })).toBeInTheDocument();
  });

  it('keeps a sales rep on a draft split child, read-only, instead of the admin-only Split Billing editor', async () => {
    authState.role = 'sales_rep';
    setupTables(invoiceRow({
      invoice_type: 'field_application', job_id: 'job-1', field_app_billing_set_id: 'set-1',
    }));
    render(
      <MemoryRouter initialEntries={['/field-invoices/inv-1']}>
        <Routes>
          <Route path="/field-invoices/:id" element={<InvoiceDetail routeArea="field" />} />
        </Routes>
      </MemoryRouter>,
    );
    expect((await screen.findAllByText('INV-0001')).length).toBeGreaterThan(0);
    expect(mockNavigate).not.toHaveBeenCalledWith('/split-billing/set-1', expect.anything());
    expect(screen.queryByRole('button', { name: /^Post$/ })).toBeNull();
  });

  it('does not bounce the per-acre editor\'s read-only split-child handoff back to it', async () => {
    authState.role = 'sales_rep';
    setupTables(invoiceRow({
      invoice_type: 'field_application', job_id: null, blend_ticket_id: null, field_app_billing_set_id: 'set-1',
    }));
    render(
      <MemoryRouter initialEntries={[{ pathname: '/field-invoices/inv-1', state: { splitChildReadOnly: true } }]}>
        <Routes>
          <Route path="/field-invoices/:id" element={<InvoiceDetail routeArea="field" />} />
        </Routes>
      </MemoryRouter>,
    );
    expect((await screen.findAllByText('INV-0001')).length).toBeGreaterThan(0);
    expect(mockNavigate).not.toHaveBeenCalledWith('/invoices/field-app/inv-1', expect.anything());
  });

  it('sends a sales rep away from a new invoice (the Misc Charge entry)', async () => {
    authState.role = 'sales_rep';
    renderAt('/invoices/new?type=misc_charge');
    expect(await screen.findByText('Invoice list')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull();
  });
});

describe('InvoiceDetail — an admin keeps the editor', () => {
  it('shows Save, Post and the editable fields and never calls the names reader', async () => {
    setupTables(invoiceRow());
    renderAt('/invoices/inv-1');
    // The admin's customer picker shows the embedded name.
    expect(await screen.findByDisplayValue('Admin Visible Farms')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^Post$/ })).toBeEnabled();
    expect(screen.getByPlaceholderText('Customer PO #')).toBeInTheDocument();
    expect(screen.queryByText(/Read-only — only an admin/)).toBeNull();
    expect(rpcCalls('get_invoice_customer_names')).toHaveLength(0);
  });

  it('calls the names reader once, for exactly the blank embed, when the embed comes back empty', async () => {
    // Can fail: a page that skipped the reader for admins, or sent other ids, fails here.
    setupTables(invoiceRow({ customer_id: 'cust-blank', customer: null }));
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_invoice_customer_names') {
        return rpcResult({ data: [{ id: 'cust-blank', farm_name: 'Blank Embed Farms' }], error: null });
      }
      if (name === 'get_invoice_post_version') return rpcResult({ data: VERSION_A, error: null });
      return rpcResult({ data: null, error: null });
    });
    renderAt('/invoices/inv-1');
    await waitFor(() => expect(rpcCalls('get_invoice_customer_names')).toEqual([
      ['get_invoice_customer_names', { p_customer_ids: ['cust-blank'] }],
    ]));
  });
});

describe('InvoiceDetail — Post binds the reviewed, saved invoice (addendum 8b)', () => {
  it('disables Post while the form has unsaved edits, with the reason shown', async () => {
    setupTables(invoiceRow());
    renderAt('/invoices/inv-1');
    const post = await screen.findByRole('button', { name: /^Post$/ });
    expect(post).toBeEnabled();

    fireEvent.change(screen.getByPlaceholderText('Customer PO #'), { target: { value: 'PO-77' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Post$/ })).toBeDisabled());
    expect(screen.getByText('Save your changes before posting. Post bills the saved invoice, not unsaved edits.')).toBeInTheDocument();

    // Typing the original value back is not an unsaved edit.
    fireEvent.change(screen.getByPlaceholderText('Customer PO #'), { target: { value: '' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Post$/ })).toBeEnabled());
  });

  it('sends the posting version read when the confirm opens, and checks credit on the SAVED total', async () => {
    // The saved total differs from the line shown on screen: the credit check must use the
    // saved invoice post_invoice will post, not the copy on screen.
    setupTables(invoiceRow(), { total_amount_cents: 7300 });
    renderAt('/invoices/inv-1');
    fireEvent.click(await screen.findByRole('button', { name: /^Post$/ }));

    const dialog = await screen.findByRole('dialog');
    expect(rpcCalls('get_invoice_post_version')).toEqual([
      ['get_invoice_post_version', { p_invoice_ids: ['inv-1'] }], // at load
      ['get_invoice_post_version', { p_invoice_ids: ['inv-1'] }], // when the confirm opened
    ]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post Invoice' }));

    await waitFor(() => expect(rpcCalls('post_invoice')).toHaveLength(1));
    expect(rpcCalls('post_invoice')[0][1]).toEqual({
      p_invoice_id: 'inv-1',
      p_idempotency_key: 'key-post_invoice',
      p_expected_version: VERSION_A,
    });
    expect(mockCreditCheck).toHaveBeenCalledWith({ customerId: 'cust-1', newAmountCents: 7300 });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Invoice posted'));
  });

  it('sends the whole split group\'s version on post_invoice_group', async () => {
    setupTables(invoiceRow({ invoice_group_id: 'grp-1' }));
    renderAt('/invoices/inv-1');
    fireEvent.click(await screen.findByRole('button', { name: /^Post$/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post Invoice' }));

    await waitFor(() => expect(rpcCalls('post_invoice_group')).toHaveLength(1));
    expect(rpcCalls('get_invoice_group_post_version')[0][1]).toEqual({ p_invoice_group_id: 'grp-1' });
    expect(rpcCalls('post_invoice_group')[0][1]).toEqual({
      p_invoice_group_id: 'grp-1',
      p_performed_by: 'admin-1',
      p_idempotency_key: 'key-post_invoice',
      p_expected_version: VERSION_A,
    });
    expect(rpcCalls('post_invoice')).toHaveLength(0);
  });

  it('reloads with a clear message when the database refuses with INVOICE_CHANGED_SINCE_REVIEW', async () => {
    const tracker = setupTables(invoiceRow());
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_invoice_post_version') return rpcResult({ data: VERSION_A, error: null });
      if (name === 'post_invoice') {
        return rpcResult({
          data: null,
          error: { code: 'P0001', message: 'INVOICE_CHANGED_SINCE_REVIEW: the invoice changed after it was reviewed; reload and review it again before posting' },
        });
      }
      return rpcResult({ data: null, error: null });
    });
    renderAt('/invoices/inv-1');
    fireEvent.click(await screen.findByRole('button', { name: /^Post$/ }));
    const dialog = await screen.findByRole('dialog');
    const loadsBeforePost = tracker.fullLoads();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post Invoice' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'This invoice changed since you reviewed it — it has been reloaded; check it and post again.',
    ));
    await waitFor(() => expect(tracker.fullLoads()).toBe(loadsBeforePost + 1));
    expect(mockToast).not.toHaveBeenCalledWith('success', 'Invoice posted');
  });

  it('reloads instead of opening the confirm when the invoice changed after the screen loaded', async () => {
    const tracker = setupTables(invoiceRow());
    let versionReads = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_invoice_post_version') {
        versionReads += 1;
        return rpcResult({ data: versionReads === 1 ? VERSION_A : VERSION_B, error: null });
      }
      return rpcResult({ data: null, error: null });
    });
    renderAt('/invoices/inv-1');
    const loadsAfterOpen = await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Post$/ })).toBeEnabled();
      return tracker.fullLoads();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Post$/ }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'This invoice changed since you reviewed it — it has been reloaded; check it and post again.',
    ));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(tracker.fullLoads()).toBe(loadsAfterOpen + 1));
    expect(rpcCalls('post_invoice')).toHaveLength(0);
  });

  it('says the check failed (not that the invoice changed) when the version could not be read at load', async () => {
    const tracker = setupTables(invoiceRow());
    let versionReads = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_invoice_post_version') {
        versionReads += 1;
        return rpcResult(versionReads === 1
          ? { data: null, error: { message: 'network down' } }
          : { data: VERSION_A, error: null });
      }
      return rpcResult({ data: null, error: null });
    });
    renderAt('/invoices/inv-1');
    const loadsAfterOpen = await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Post$/ })).toBeEnabled();
      return tracker.fullLoads();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Post$/ }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'Could not check the saved invoice before posting. Nothing was posted — please try again.',
    ));
    expect(mockToast).not.toHaveBeenCalledWith(
      'error',
      'This invoice changed since you reviewed it — it has been reloaded; check it and post again.',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    // Reloaded, which takes a fresh baseline.
    await waitFor(() => expect(tracker.fullLoads()).toBe(loadsAfterOpen + 1));
    expect(rpcCalls('post_invoice')).toHaveLength(0);
  });
});
