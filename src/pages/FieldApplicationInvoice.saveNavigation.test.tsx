/**
 * FieldApplicationInvoice.saveNavigation.test.tsx — first Save of a NEW field-app invoice.
 *
 * Bug (2026-10-09): after a successful first Save the page called setDirty(false) and
 * navigate() back-to-back. The router still held the block check from the last
 * committed render (dirty = true), so it blocked the move and showed a false
 * "Unsaved Changes" prompt. Choosing Stay left the user on /invoices/field-app/new, and
 * a second Save sent p_invoice_id = null again, creating a SECOND invoice.
 *
 * Follow-up (CodeRabbit, PR #893): the id of the invoice that first Save created must
 * survive a page refresh. It is written into the address (/new?created=<id>); a refresh
 * opens the created invoice (whatever its status), and pressing New there starts a genuinely
 * new one. A refresh BEFORE the create answered is a plain new page (known gap: see
 * docs/changelog.d/2026-10-09-invoice-screen-safety.md).
 *
 * Unlike FieldApplicationInvoice.test.tsx, this file uses the REAL router (a data router,
 * as App.tsx does), the REAL route wrapper and the REAL useUnsavedChanges hook, because
 * the bug lives in how those interact. Only the database, auth and toast are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';

// In Vitest, 'react-router-dom' (the page's useNavigate) and 'react-router' (the hook's
// useBlocker) can resolve to two separate module copies with two separate router
// contexts. The app bundle has one copy. Point the page's import at the same copy the
// hook and this test use, so the page runs inside ONE data router as it does in the app.
vi.mock('react-router-dom', async () => vi.importActual('react-router'));

const { mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
  assertRpcResult: <T,>(data: T) => data,
  checkMutationResult: () => {},
  sanitizeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  RpcErrorCodes: {
    ZERO_APPLIED_ACRES: 'ZERO_APPLIED_ACRES',
    ACTOR_MISMATCH: 'ACTOR_MISMATCH',
    INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED: 'INVOICE_SEASON_DATE_CHANGE_NOT_ALLOWED',
    INVOICE_FILED_SEASON_CHANGE_NOT_ALLOWED: 'INVOICE_FILED_SEASON_CHANGE_NOT_ALLOWED',
  },
  hasRpcCode: () => false,
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

import FieldApplicationInvoiceRoute from '../components/FieldApplicationInvoiceRoute';

const CREATED_ID = '3f2b8c1e-5d4a-4b6f-9a1c-2e7d8f9a0b1c';
const SECOND_ID = '7a9d2e4f-1b3c-4d5e-8f6a-0b1c2d3e4f5a';
const NEW_PATH = '/invoices/field-app/new';

/** Invoices the page's "is this my new draft?" check can read, by id. */
const invoiceRows = new Map<string, Record<string, unknown>>();
let invoiceCheckError: { message: string } | null = null;
/** When true, the check never answers (a slow network), so the page is still checking. */
let invoiceCheckHangs = false;
/** When true, the check waits until the test calls releaseInvoiceCheck(). */
let invoiceCheckHeld = false;
let releaseInvoiceCheck: () => void = () => {};

function ownNewDraft(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, invoice_number: null, invoice_type: 'field_application', status: 'draft', created_by: 'user-1',
    deleted_at: null, ...overrides,
  };
}

function emptyChain() {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'gte', 'lte', 'order', 'limit', 'update', 'insert', 'delete']) {
    chain[m] = vi.fn(() => chain);
  }
  const result = { data: [], error: null };
  chain.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
  chain.then = (resolve: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

/** The billing step's customer lookup: fails, or leaves out the saved invoice. */
let customerMapError: { message: string } | null = null;
let customerMapDrops = false;
let customerMapBlank = false;

/**
 * Like emptyChain, but maybeSingle answers the created-id check with the row for the filtered
 * id, and the billing step's customer lookup (.in('id', ids)) answers one customer per id.
 */
function invoicesChain() {
  const chain = emptyChain();
  let idFilter: string | null = null;
  let inIds: string[] = [];
  let columns: string | null = null;
  chain.select = vi.fn((cols: string) => { columns = cols; return chain; });
  chain.eq = vi.fn((column: string, value: string) => {
    if (column === 'id') idFilter = value;
    return chain;
  });
  chain.in = vi.fn((column: string, values: string[]) => {
    if (column === 'id') inIds = values;
    return chain;
  });
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(columns === 'id, customer_id'
    ? (customerMapError
      ? { data: null, error: customerMapError }
      : { data: customerMapDrops ? [] : inIds.map((id) => ({ id, customer_id: customerMapBlank ? null : 'customer-1' })), error: null })
    : { data: [], error: null }).then(resolve);
  const answer = () => (invoiceCheckError
    ? { data: null, error: invoiceCheckError }
    : { data: (idFilter && invoiceRows.get(idFilter)) || null, error: null });
  chain.maybeSingle = vi.fn(() => {
    if (invoiceCheckHangs) return new Promise(() => {});
    if (invoiceCheckHeld) return new Promise((resolve) => { releaseInvoiceCheck = () => resolve(answer()); });
    return Promise.resolve(answer());
  });
  return chain;
}

function SavedInvoicePage() {
  const { id } = useParams();
  return <p>Saved invoice page {id}</p>;
}

/** The app's routes for this page: /new through the real wrapper, /:id stubbed. */
async function renderAt(entry = NEW_PATH) {
  const router = createMemoryRouter(
    [
      { path: NEW_PATH, element: <FieldApplicationInvoiceRoute /> },
      { path: '/invoices/field-app/:id', element: <SavedInvoicePage /> },
    ],
    { initialEntries: [entry] },
  );
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  return router;
}

/** Billing details fail on the FIRST attempt only: the invoice is created, the form stays dirty. */
function mockSaveWithFirstBillingFailure(invoiceId: string) {
  let billingAttempts = 0;
  mockRpc.mockImplementation((name: string) => {
    if (name === 'save_field_app_invoice') {
      return Promise.resolve({ data: { invoice_ids: [invoiceId], invoice_group_id: null }, error: null });
    }
    if (name === 'update_field_app_invoice_billing') {
      billingAttempts += 1;
      return Promise.resolve(billingAttempts === 1
        ? { data: null, error: { message: 'network blip' } }
        : { data: { success: true }, error: null });
    }
    return Promise.resolve({ data: { success: true }, error: null });
  });
}

/** One value from the router's current address (?created=…). */
function addressParam(router: { state: { location: { search: string } } }, name: string) {
  return new URLSearchParams(router.state.location.search).get(name);
}

function saveKey(call: number) {
  return (saveCalls()[call][1] as { p_idempotency_key: string }).p_idempotency_key;
}

function saveCalls() {
  return mockRpc.mock.calls.filter(([name]) => name === 'save_field_app_invoice');
}

function savedInvoiceId(call: number) {
  return (saveCalls()[call][1] as { p_invoice_id: string | null }).p_invoice_id;
}

const headerNotes = () => screen.getByPlaceholderText('Printed at top of invoice') as HTMLInputElement;

/** Make the form dirty the way a user does: type into a field. */
function editHeaderNotes(value: string) {
  fireEvent.change(headerNotes(), { target: { value } });
}

/** First Save creates the invoice, billing fails, the leave-page prompt appears, the user stays. */
async function createWithPartialFailureAndStay() {
  editHeaderNotes('Spray north field');
  fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
  fireEvent.click(await screen.findByRole('button', { name: 'Stay' }));
  await waitFor(() => expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument());
}

describe('FieldApplicationInvoice — first Save of a new invoice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoiceRows.clear();
    invoiceCheckError = null;
    invoiceCheckHangs = false;
    invoiceCheckHeld = false;
    customerMapError = null;
    customerMapDrops = false;
    customerMapBlank = false;
    mockFrom.mockImplementation((table: string) => (table === 'invoices' ? invoicesChain() : emptyChain()));
  });

  it('navigates to the saved invoice with no false "Unsaved Changes" prompt', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_field_app_invoice') {
        return Promise.resolve({ data: { invoice_ids: [CREATED_ID], invoice_group_id: null }, error: null });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });
    const router = await renderAt();

    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/invoices/field-app/${CREATED_ID}`));
    expect(await screen.findByText(`Saved invoice page ${CREATED_ID}`)).toBeInTheDocument();
    expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('success', 'Invoice created');
    expect(saveCalls()).toHaveLength(1);
  });

  it('a second Save after the invoice was created updates that invoice instead of creating another', async () => {
    mockSaveWithFirstBillingFailure(CREATED_ID);
    const router = await renderAt();

    await createWithPartialFailureAndStay();
    expect(saveCalls()).toHaveLength(1);
    expect(savedInvoiceId(0)).toBeNull();
    expect(router.state.location.pathname).toBe(NEW_PATH);

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(saveCalls()).toHaveLength(2));
    // The repeat Save targets the invoice the first Save created — never a new one.
    expect(savedInvoiceId(1)).toBe(CREATED_ID);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/invoices/field-app/${CREATED_ID}`));
    expect(mockToast).toHaveBeenCalledWith('success', 'Invoice saved');
  });

  it('the first Save writes the created invoice into the address and keeps the typed values', async () => {
    mockSaveWithFirstBillingFailure(CREATED_ID);
    const router = await renderAt();

    await createWithPartialFailureAndStay();

    expect(router.state.location.pathname).toBe(NEW_PATH);
    expect(addressParam(router, 'created')).toBe(CREATED_ID);
    // Same page: nothing typed was thrown away.
    expect(headerNotes().value).toBe('Spray north field');
  });

  it('the first Save keys its create on this page alone', async () => {
    mockSaveWithFirstBillingFailure(CREATED_ID);
    await renderAt();
    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    expect(saveKey(0)).toMatch(/^save_field_app_invoice:/);
  });

  it('a billing retry keeps its key; with changed values the current values follow under a new key', async () => {
    // The billing RPC answers a repeated key with its first result without applying anything,
    // so a changed retry under the old key would report success with the old values (Codex
    // Sol, PR #893).
    let billingAttempts = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_field_app_invoice') {
        return Promise.resolve({ data: { invoice_ids: [CREATED_ID], invoice_group_id: null }, error: null });
      }
      if (name === 'update_field_app_invoice_billing') {
        billingAttempts += 1;
        return Promise.resolve(billingAttempts <= 2
          ? { data: null, error: { message: 'network blip' } }
          : { data: { success: true }, error: null });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });
    await renderAt();
    await createWithPartialFailureAndStay();
    const billingKeys = () => mockRpc.mock.calls
      .filter(([n]) => n === 'update_field_app_invoice_billing')
      .map(([, args]) => (args as { p_idempotency_key: string }).p_idempotency_key);

    // Same values again: the same key, so a first attempt that did land is not applied twice.
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(billingKeys()).toHaveLength(2));
    expect(billingKeys()[1]).toBe(billingKeys()[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument());

    // Changed values: the unanswered key first (only one write per key can commit, so an older
    // write still running cannot land after this one), then the current values under a new key.
    editHeaderNotes('Spray south field instead');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(billingKeys()).toHaveLength(4));
    expect(billingKeys()[2]).toBe(billingKeys()[0]);
    expect(billingKeys()[3]).not.toBe(billingKeys()[0]);
    const billingCalls = mockRpc.mock.calls.filter(([n]) => n === 'update_field_app_invoice_billing');
    const lastBilling = billingCalls[billingCalls.length - 1][1] as { p_header_notes: string };
    expect(lastBilling.p_header_notes).toBe('Spray south field instead');
  });

  it('the address never carries a draft tag: a refresh before the create answered is a plain new page', async () => {
    let finishCreate: (v: unknown) => void = () => {};
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_field_app_invoice') return new Promise((resolve) => { finishCreate = resolve; });
      return Promise.resolve({ data: { success: true }, error: null });
    });
    const router = await renderAt();
    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    expect(router.state.location.search).toBe('');
    await act(async () => {
      finishCreate({ data: { invoice_ids: [CREATED_ID], invoice_group_id: null }, error: null });
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/invoices/field-app/${CREATED_ID}`));
  });

  it('a create retried with changed values after no answer writes the current values onto the invoice it returns', async () => {
    // The first create may have landed with its reply lost. The retry keeps the key (a new one
    // could create a second invoice), so its answer can be that invoice with the OLD values; the
    // page then writes the current values over it (Luna, PR #893).
    let createCalls = 0;
    mockRpc.mockImplementation((name: string, args: { p_invoice_id: string | null }) => {
      if (name === 'save_field_app_invoice') {
        createCalls += 1;
        if (createCalls === 1) return Promise.resolve({ data: null, error: { message: 'Failed to fetch' } });
        return Promise.resolve({ data: { invoice_ids: [args.p_invoice_id ?? CREATED_ID], invoice_group_id: null }, error: null });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });
    const router = await renderAt();
    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('Save failed')));

    editHeaderNotes('Spray south field instead');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveCalls()).toHaveLength(3));
    expect(savedInvoiceId(1)).toBeNull();
    expect(saveKey(1)).toBe(saveKey(0));
    expect(savedInvoiceId(2)).toBe(CREATED_ID);
    expect(saveKey(2)).not.toBe(saveKey(0));
    expect((saveCalls()[2][1] as { p_invoice: { header_notes: string } }).p_invoice.header_notes).toBe('Spray south field instead');
    await waitFor(() => expect(router.state.location.pathname).toBe(`/invoices/field-app/${CREATED_ID}`));
  });

  it('values A, then B, then A again, all under one unanswered key: the last retry still writes A', async () => {
    // B may be what committed under the key, so matching the FIRST attempt's values proves
    // nothing (Luna, PR #893).
    let saves = 0;
    mockRpc.mockImplementation((name: string, args: { p_invoice_id: string | null }) => {
      if (name === 'save_field_app_invoice') {
        saves += 1;
        if (saves <= 2) return Promise.resolve({ data: null, error: { message: 'Failed to fetch' } });
        return Promise.resolve({ data: { invoice_ids: [args.p_invoice_id ?? CREATED_ID], invoice_group_id: null }, error: null });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });
    await renderAt();
    const saveOnce = async (calls: number) => {
      fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
      await waitFor(() => expect(saveCalls().length).toBeGreaterThanOrEqual(calls));
      await waitFor(() => expect(screen.getByRole('button', { name: /^Save$/i })).not.toBeDisabled());
    };
    editHeaderNotes('A');
    await saveOnce(1);
    editHeaderNotes('B');
    await saveOnce(2);
    editHeaderNotes('A');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveCalls()).toHaveLength(4));
    expect(saveKey(2)).toBe(saveKey(0));
    expect(savedInvoiceId(3)).toBe(CREATED_ID);
    expect((saveCalls()[3][1] as { p_invoice: { header_notes: string } }).p_invoice.header_notes).toBe('A');
  });

  it('billing values A, then B, then A again under one unanswered key: the last retry still writes A', async () => {
    // B may be what committed under the billing key (Luna, PR #893).
    let billingAttempts = 0;
    mockRpc.mockImplementation((name: string, args: { p_invoice_id: string | null }) => {
      if (name === 'save_field_app_invoice') {
        return Promise.resolve({ data: { invoice_ids: [args.p_invoice_id ?? CREATED_ID], invoice_group_id: null }, error: null });
      }
      if (name === 'update_field_app_invoice_billing') {
        billingAttempts += 1;
        return Promise.resolve(billingAttempts <= 2
          ? { data: null, error: { message: 'network blip' } }
          : { data: { success: true }, error: null });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });
    await renderAt();
    await createWithPartialFailureAndStay();
    const billingCalls = () => mockRpc.mock.calls.filter(([n]) => n === 'update_field_app_invoice_billing')
      .map(([, args]) => args as { p_idempotency_key: string; p_header_notes: string });

    editHeaderNotes('Spray south field instead');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(billingCalls()).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Save$/i })).not.toBeDisabled());

    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(billingCalls()).toHaveLength(4));
    expect(billingCalls()[2].p_idempotency_key).toBe(billingCalls()[0].p_idempotency_key);
    expect(billingCalls()[3].p_idempotency_key).not.toBe(billingCalls()[0].p_idempotency_key);
    expect(billingCalls()[3].p_header_notes).toBe('Spray north field');
  });

  it('a create the server refused, retried with changed values, is saved once with no follow-up write', async () => {
    // A refusal (an error with a code, e.g. a closed accounting period) rolled back and stored
    // nothing under the key, so the retry is a fresh save, not a replay: a follow-up would save
    // everything twice and log a false extra update (Codex review, PR #893).
    let createCalls = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_field_app_invoice') {
        createCalls += 1;
        if (createCalls === 1) return Promise.resolve({ data: null, error: { message: 'Accounting period is closed', code: 'P0001' } });
        return Promise.resolve({ data: { invoice_ids: [CREATED_ID], invoice_group_id: null }, error: null });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });
    await renderAt();
    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('Save failed')));
    editHeaderNotes('Spray south field instead');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Invoice created'));
    expect(saveCalls()).toHaveLength(2);
  });

  it('a create retried with the same values after no answer is sent once more with the same key, and nothing else', async () => {
    let createCalls = 0;
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_field_app_invoice') {
        createCalls += 1;
        if (createCalls === 1) return Promise.resolve({ data: null, error: { message: 'Failed to fetch' } });
        return Promise.resolve({ data: { invoice_ids: [CREATED_ID], invoice_group_id: null }, error: null });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });
    await renderAt();
    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('Save failed')));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Invoice created'));
    expect(saveCalls()).toHaveLength(2);
    expect(saveKey(1)).toBe(saveKey(0));
  });

  it('an update retried with changed values after no answer keeps its key, then writes the current values', async () => {
    // The newer values must be applied rather than answered with the first attempt's stored
    // result (Luna, PR #893), but only once that attempt has finished: a new key straight away
    // would let a still-running older update land after it (CodeRabbit, PR #893).
    let saves = 0;
    mockRpc.mockImplementation((name: string, args: { p_invoice_id: string | null }) => {
      if (name === 'save_field_app_invoice') {
        saves += 1;
        if (saves === 2 || saves === 3) return Promise.resolve({ data: null, error: { message: 'Failed to fetch' } });
        return Promise.resolve({ data: { invoice_ids: [args.p_invoice_id ?? CREATED_ID], invoice_group_id: null }, error: null });
      }
      if (name === 'update_field_app_invoice_billing') return Promise.resolve({ data: null, error: { message: 'network blip' } });
      return Promise.resolve({ data: { success: true }, error: null });
    });
    await renderAt();
    await createWithPartialFailureAndStay();

    // Update #1: no answer. Update #2, same values: same key.
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveCalls()).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Save$/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveCalls()).toHaveLength(3));
    expect(saveKey(2)).toBe(saveKey(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Save$/i })).not.toBeDisabled());

    // Changed values: the unanswered key first, then the current values under a new key.
    editHeaderNotes('Spray south field instead');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveCalls()).toHaveLength(5));
    expect(savedInvoiceId(3)).toBe(CREATED_ID);
    expect(saveKey(3)).toBe(saveKey(1));
    expect(savedInvoiceId(4)).toBe(CREATED_ID);
    expect(saveKey(4)).not.toBe(saveKey(1));
    expect((saveCalls()[4][1] as { p_invoice: { header_notes: string } }).p_invoice.header_notes).toBe('Spray south field instead');
  });

  it('two Save clicks before the page re-renders send one create', async () => {
    mockSaveWithFirstBillingFailure(CREATED_ID);
    await renderAt();
    editHeaderNotes('Spray north field');
    const save = screen.getByRole('button', { name: /^Save$/i });
    await act(async () => {
      save.click();
      save.click();
    });
    await waitFor(() => expect(mockRpc.mock.calls.some(([n]) => n === 'update_field_app_invoice_billing')).toBe(true));
    expect(saveCalls()).toHaveLength(1);
  });

  it.each([
    ['cannot be read', true],
    ['comes back without one of the saved invoices', 'drop'],
    ['come back with no customer on a saved invoice', 'blank'],
  ])('when the saved invoices\' customers %s, billing details are not written and the user is told', async (_label, mode) => {
    // Unresolved customers would be sent a zero Discount Earned while the save reports success
    // (Codex Sol 6.1, PR #893; a blank customer: Luna, PR #893).
    customerMapError = mode === true ? { message: 'network blip' } : null;
    customerMapDrops = mode === 'drop';
    customerMapBlank = mode === 'blank';
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_field_app_invoice') {
        return Promise.resolve({ data: { invoice_ids: [CREATED_ID], invoice_group_id: null }, error: null });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });
    const router = await renderAt();
    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('billing details (PO / terms / due date / notes / discount) did NOT persist')));
    expect(mockRpc.mock.calls.some(([n]) => n === 'update_field_app_invoice_billing')).toBe(false);
    // The form is still unsaved, so leaving asks first.
    expect(await screen.findByText('Unsaved Changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    expect(router.state.location.pathname).toBe(NEW_PATH);
    expect(addressParam(router, 'created')).toBe(CREATED_ID);
  });

  it('New starts a new page: its create uses a different key', async () => {
    const created = [CREATED_ID, SECOND_ID];
    mockRpc.mockImplementation((name: string, args: { p_invoice_id: string | null }) => {
      if (name === 'save_field_app_invoice') {
        return Promise.resolve({ data: { invoice_ids: [args.p_invoice_id ?? created.shift()], invoice_group_id: null }, error: null });
      }
      if (name === 'update_field_app_invoice_billing') return Promise.resolve({ data: null, error: { message: 'network blip' } });
      return Promise.resolve({ data: { success: true }, error: null });
    });
    const router = await renderAt();
    await createWithPartialFailureAndStay();

    await act(async () => {
      await router.navigate(NEW_PATH);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(headerNotes().value).toBe(''));
    await createWithPartialFailureAndStay();

    expect(savedInvoiceId(1)).toBeNull();
    expect(saveKey(0)).not.toBe(saveKey(1));
  });

  it('a refresh of that address opens the created invoice instead of a blank new form', async () => {
    invoiceRows.set(CREATED_ID, ownNewDraft(CREATED_ID));
    // A browser refresh starts the app again at the address the first Save wrote.
    const router = await renderAt(`${NEW_PATH}?created=${CREATED_ID}`);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/invoices/field-app/${CREATED_ID}`));
    expect(await screen.findByText(`Saved invoice page ${CREATED_ID}`)).toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('info', expect.stringContaining('already created this invoice'));
    expect(saveCalls()).toHaveLength(0);
  });

  it('an address whose created id is not an invoice id stays a new invoice', async () => {
    mockSaveWithFirstBillingFailure(CREATED_ID);
    const router = await renderAt(`${NEW_PATH}?created=..%2F..%2Fadmin`);

    expect(router.state.location.pathname).toBe(NEW_PATH);
    expect(mockToast).not.toHaveBeenCalledWith('info', expect.anything());
    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    expect(savedInvoiceId(0)).toBeNull();
  });

  it.each([
    ['no such invoice', null],
    ['an invoice someone else created', { created_by: 'user-2' }],
    ['a different kind of invoice', { invoice_type: 'chemical_sale' }],
    ['this user\'s invoice that has since been deleted', { deleted_at: new Date().toISOString() }],
  ])('an address naming %s never quietly becomes a new invoice: Save waits until the user starts one', async (_label, overrides) => {
    // A missing or unusable result is not proof that nothing was created (Codex Sol 6.1, PR #893).
    if (overrides) invoiceRows.set(CREATED_ID, ownNewDraft(CREATED_ID, overrides));
    mockSaveWithFirstBillingFailure(SECOND_ID);
    const router = await renderAt(`${NEW_PATH}?created=${CREATED_ID}`);

    expect(await screen.findByRole('button', { name: 'Start a new invoice instead' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(NEW_PATH);
    expect(addressParam(router, 'created')).toBe(CREATED_ID);
    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(mockToast).toHaveBeenCalledWith('info', expect.stringContaining('Start a new invoice instead'));
    expect(saveCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Start a new invoice instead' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
    expect(headerNotes().value).toBe('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    expect(savedInvoiceId(0)).toBeNull();
  });

  it('the deleted case names the invoice', async () => {
    invoiceRows.set(CREATED_ID, ownNewDraft(CREATED_ID, { invoice_number: 'FA-3001', deleted_at: new Date().toISOString() }));
    await renderAt(`${NEW_PATH}?created=${CREATED_ID}`);
    expect(await screen.findByText(/created invoice FA-3001, and it has since been deleted/)).toBeInTheDocument();
  });

  it.each([
    ['posted', 'posted'],
    ['cancelled (returned to scheduling)', 'cancelled'],
  ])('a refresh after this user\'s invoice was %s opens it instead of offering a new one', async (_label, status) => {
    // Posting it is proof the create happened; treating it as "not mine" let a second invoice be
    // created for the same application (Codex Sol 6.1, PR #893).
    invoiceRows.set(CREATED_ID, ownNewDraft(CREATED_ID, { status }));
    const router = await renderAt(`${NEW_PATH}?created=${CREATED_ID}`);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/invoices/field-app/${CREATED_ID}`));
    expect(saveCalls()).toHaveLength(0);
  });

  it('a draft this user created days ago still opens: a late refresh must never lead to a duplicate', async () => {
    invoiceRows.set(CREATED_ID, ownNewDraft(CREATED_ID, {
      status: 'unposted', created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    }));
    const router = await renderAt(`${NEW_PATH}?created=${CREATED_ID}`);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/invoices/field-app/${CREATED_ID}`));
  });

  it('typing while the check runs: opening the created invoice asks first, and after Stay the page never saves over it', async () => {
    // The form here was not loaded from that invoice, and an update replaces its lines, so a
    // partly re-typed form must not be saved onto it (Codex Sol, PR #893). Save waits and the
    // notice links to the invoice.
    invoiceCheckHeld = true;
    invoiceRows.set(CREATED_ID, ownNewDraft(CREATED_ID, { invoice_number: 'FA-2001' }));
    mockSaveWithFirstBillingFailure(SECOND_ID);
    const router = await renderAt(`${NEW_PATH}?created=${CREATED_ID}`);

    editHeaderNotes('Re-entered notes');
    await act(async () => { releaseInvoiceCheck(); });
    fireEvent.click(await screen.findByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe(NEW_PATH);
    expect(headerNotes().value).toBe('Re-entered notes');
    expect(screen.getByRole('link', { name: 'FA-2001' })).toHaveAttribute('href', `/invoices/field-app/${CREATED_ID}`);

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(mockToast).toHaveBeenCalledWith('info', expect.stringContaining('already created this invoice. Open it'));
    expect(saveCalls()).toHaveLength(0);
  });

  it('typing while the check runs: an id this page cannot open keeps the typed values, and Save waits for "Start a new invoice instead"', async () => {
    invoiceCheckHeld = true;
    invoiceRows.set(CREATED_ID, ownNewDraft(CREATED_ID, { created_by: 'user-2' }));
    mockSaveWithFirstBillingFailure(SECOND_ID);
    const router = await renderAt(`${NEW_PATH}?created=${CREATED_ID}`);

    editHeaderNotes('My own new invoice');
    await act(async () => { releaseInvoiceCheck(); });
    expect(await screen.findByRole('button', { name: 'Start a new invoice instead' })).toBeInTheDocument();
    expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
    expect(headerNotes().value).toBe('My own new invoice');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(saveCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Start a new invoice instead' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    expect(savedInvoiceId(0)).toBeNull();
    // The new invoice's own id goes into the address, on the same page.
    await waitFor(() => expect(addressParam(router, 'created')).toBe(SECOND_ID));
    expect(headerNotes().value).toBe('My own new invoice');
  });

  it('if the check cannot run, the page stays put and Save refuses: no duplicate and no unchecked invoice', async () => {
    invoiceCheckError = { message: 'network down' };
    mockSaveWithFirstBillingFailure(SECOND_ID);
    const router = await renderAt(`${NEW_PATH}?created=${CREATED_ID}`);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('Could not check')));
    expect(router.state.location.pathname).toBe(NEW_PATH);
    expect(addressParam(router, 'created')).toBe(CREATED_ID);
    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(mockToast).toHaveBeenCalledWith('info', expect.stringContaining('nothing was saved'));
    expect(saveCalls()).toHaveLength(0);
  });

  it('Save refuses while the check is still running', async () => {
    invoiceCheckHangs = true;
    mockSaveWithFirstBillingFailure(SECOND_ID);
    await renderAt(`${NEW_PATH}?created=${CREATED_ID}`);

    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    expect(mockToast).toHaveBeenCalledWith('info', expect.stringContaining('One moment'));
    expect(saveCalls()).toHaveLength(0);
  });

  it('accepts an invoice id of any UUID version', async () => {
    const v7Id = '01927a3b-4c5d-7e6f-8a9b-0c1d2e3f4a5b';
    invoiceRows.set(v7Id, ownNewDraft(v7Id));
    const router = await renderAt(`${NEW_PATH}?created=${v7Id}`);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/invoices/field-app/${v7Id}`));
  });

  it('New pressed while the first Save is still creating the invoice gives a fresh page the old Save cannot steer', async () => {
    let finishCreate: (v: unknown) => void = () => {};
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_field_app_invoice') {
        return new Promise((resolve) => { finishCreate = resolve; });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });
    const router = await renderAt();
    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveCalls()).toHaveLength(1));

    // Still on plain /new (no id in the address yet): New is pressed and the user leaves.
    await act(async () => {
      await router.navigate(NEW_PATH);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(headerNotes().value).toBe(''));
    await act(async () => {
      finishCreate({ data: { invoice_ids: [CREATED_ID], invoice_group_id: null }, error: null });
    });

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Invoice created'));
    expect(router.state.location.pathname).toBe(NEW_PATH);
    expect(router.state.location.search).toBe('');
    expect(headerNotes().value).toBe('');
  });

  it('a Save still running when the user presses New does not pull them back to the old invoice', async () => {
    // The invoice is created and its id written into the address; the billing step is
    // still running when the user presses New and leaves the dirty form.
    let finishBilling: (v: unknown) => void = () => {};
    mockRpc.mockImplementation((name: string) => {
      if (name === 'save_field_app_invoice') {
        return Promise.resolve({ data: { invoice_ids: [CREATED_ID], invoice_group_id: null }, error: null });
      }
      if (name === 'update_field_app_invoice_billing') {
        return new Promise((resolve) => { finishBilling = resolve; });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });
    const router = await renderAt();
    editHeaderNotes('Spray north field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(addressParam(router, 'created')).toBe(CREATED_ID));
    await waitFor(() => expect(mockRpc.mock.calls.some(([n]) => n === 'update_field_app_invoice_billing')).toBe(true));

    await act(async () => {
      await router.navigate(NEW_PATH);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    await act(async () => {
      finishBilling({ data: { success: true }, error: null });
    });

    // The old page's Save finished its writes but left the user on the new, blank page.
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', 'Invoice created'));
    expect(router.state.location.pathname).toBe(NEW_PATH);
    expect(router.state.location.search).toBe('');
    expect(headerNotes().value).toBe('');
  });

  it('Back from a second new invoice to the first one opens the first, never saving onto the second', async () => {
    // Two drafts in one tab, each created by a first Save whose billing step failed.
    const created = [CREATED_ID, SECOND_ID];
    mockRpc.mockImplementation((name: string, args: { p_invoice_id: string | null }) => {
      if (name === 'save_field_app_invoice') {
        const invoiceId = args.p_invoice_id ?? created.shift();
        return Promise.resolve({ data: { invoice_ids: [invoiceId], invoice_group_id: null }, error: null });
      }
      if (name === 'update_field_app_invoice_billing') {
        return Promise.resolve({ data: null, error: { message: 'network blip' } });
      }
      return Promise.resolve({ data: { success: true }, error: null });
    });
    invoiceRows.set(CREATED_ID, ownNewDraft(CREATED_ID));
    invoiceRows.set(SECOND_ID, ownNewDraft(SECOND_ID));
    const router = await renderAt();

    await createWithPartialFailureAndStay();
    expect(addressParam(router, 'created')).toBe(CREATED_ID);
    await act(async () => {
      await router.navigate(NEW_PATH);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(headerNotes().value).toBe(''));
    await createWithPartialFailureAndStay();
    expect(addressParam(router, 'created')).toBe(SECOND_ID);
    expect(savedInvoiceId(1)).toBeNull();

    await act(async () => {
      await router.navigate(-1);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/invoices/field-app/${CREATED_ID}`));
    expect(saveCalls()).toHaveLength(2);
  });

  it('going to the plain /new address from /new?created=<id> starts a genuinely new invoice', async () => {
    mockSaveWithFirstBillingFailure(CREATED_ID);
    const router = await renderAt();
    await createWithPartialFailureAndStay();

    // What the New buttons do (top bar, Field Invoices list): navigate to the plain /new
    // address. This page has no New button of its own.
    await act(async () => {
      await router.navigate(NEW_PATH);
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));

    // A fresh page: nothing typed carried over, and Save creates a new invoice.
    await waitFor(() => expect(headerNotes().value).toBe(''));
    editHeaderNotes('Spray south field');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveCalls()).toHaveLength(2));
    expect(savedInvoiceId(1)).toBeNull();
  });
});
