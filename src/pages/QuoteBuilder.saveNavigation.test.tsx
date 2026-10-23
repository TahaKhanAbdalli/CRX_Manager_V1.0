/**
 * QuoteBuilder.saveNavigation.test.tsx — first Save Draft of a NEW quote.
 *
 * Bug (seen live 2026-10-22): after a successful first Save Draft the page called
 * setIsDirty(false) and navigate('/quotes/<id>') back-to-back. The router still held the
 * block check from the last committed render (dirty = true), so it blocked the move and
 * showed a false "Unsaved Changes" prompt. Choosing Stay left the rep on /quotes/new
 * holding a quote that was already saved. Same bug class as FieldApplicationInvoice
 * (2026-10-09, see FieldApplicationInvoice.saveNavigation.test.tsx).
 *
 * QuoteBuilder.test.tsx mocks useUnsavedChanges away, so it cannot see this. This file
 * uses the REAL data router (as App.tsx does), the REAL useUnsavedChanges hook and the
 * REAL UnsavedChangesModal. Only the database, auth, toast and side-effect libraries are
 * mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, Outlet, RouterProvider, createMemoryRouter, useParams } from 'react-router';

// In Vitest, 'react-router-dom' (the page's useNavigate) and 'react-router' (the hook's
// useBlocker) can resolve to two separate module copies with two separate router
// contexts. Point the page's import at the same copy the hook and this test use.
vi.mock('react-router-dom', async () => vi.importActual('react-router'));

const { mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock('../lib/db', async () => {
  const { assertRpcResult } = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    supabase: { from: mockFrom, rpc: mockRpc },
    supabaseUntyped: { from: mockFrom, rpc: mockRpc },
    checkMutationResult: vi.fn(),
    assertRpcResult,
    hasRpcCode: () => false,
    RpcErrorCodes: {},
    rpcAuthErrorMessage: () => null,
    sanitizeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  };
});
// Fixtures already carry cost; the admin cost read passes rows through.
vi.mock('../lib/costFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/costFields')>()),
  withAdminCost: async (_table: string, row: unknown) => row,
  withAdminCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
  withAdminNestedCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Test Admin' }, role: 'admin' }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureMessage: vi.fn(), captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({ notifyLargeOrder: vi.fn(), notifyCreditLimitExceeded: vi.fn() }));
vi.mock('../lib/metrics', () => ({ trackBusinessEvent: vi.fn() }));
vi.mock('../lib/orderConfirmedEmail', () => ({ sendOrderConfirmedEmail: vi.fn() }));
vi.mock('../lib/quotePdf', () => ({ downloadQuotePdf: vi.fn(), generateQuotePdf: vi.fn() }));
vi.mock('../lib/emailService', () => ({ sendEmail: vi.fn(), pdfToBase64: vi.fn(), buildEmailHtml: vi.fn(() => '') }));
vi.mock('../lib/rupCompliance', () => ({
  checkRUPCompliance: vi.fn().mockResolvedValue({ compliant: true, warnings: [], rupProductNames: [] }),
}));
vi.mock('../components/ui/CommissionSplitEditor', () => ({ default: () => null }));

import QuoteBuilder from './QuoteBuilder';

const SAVED_ID = '5c1d9e2a-7b3f-4a6e-8d0c-1f2e3a4b5c6d';
// The customer's default commission split fills the quote's split, as for a real rep.
const customer = {
  id: 'customer-1', farm_name: 'North Farm', assigned_tier: 1, is_active: true,
  default_commission_split: { splits: [{ recipient: 'Test Admin', percentage: 100 }] },
};
const product = {
  id: 'product-1', product_name: 'Alpha Chem', is_active: true, current_cost: 6, tier1_price: 10,
  unit_size: 'gal', inventory_unit: 'gal',
};

/** A Supabase-like query chain: every filter returns itself, awaiting it answers `data`. */
function chain(data: unknown) {
  const self: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'or', 'gte', 'lte', 'order', 'limit', 'range', 'ilike']) {
    self[m] = () => self;
  }
  self.single = () => Promise.resolve({ data: null, error: null });
  self.maybeSingle = () => Promise.resolve({ data: null, error: null });
  const promise = Promise.resolve({ data, error: null });
  self.then = promise.then.bind(promise);
  return self;
}

function SavedQuotePage() {
  const { id } = useParams();
  return <p>Saved quote page {id}</p>;
}

/** /quotes/new runs the real page; /quotes/:id is stubbed; a nav link sits above both. */
function renderNewQuote() {
  const router = createMemoryRouter(
    [{
      element: <><Link to="/quotes">Quotes list</Link><Outlet /></>,
      children: [
        { path: '/quotes', element: <p>Quotes list page</p> },
        { path: '/quotes/new', element: <QuoteBuilder /> },
        { path: '/quotes/:id', element: <SavedQuotePage /> },
      ],
    }],
    { initialEntries: ['/quotes/new'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

/** Pick a customer and one product with 2 units: a quote Save Draft will accept. */
async function fillInNewQuote() {
  const customerBox = await screen.findByRole('combobox', { name: 'Customer' });
  fireEvent.change(customerBox, { target: { value: 'North' } });
  fireEvent.click(await screen.findByRole('option', { name: /North Farm/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add one' }));
  fireEvent.click(await screen.findByRole('button', { name: /Select Product/ }));
  const picker = await screen.findByPlaceholderText('Search by name, SKU, category, or vendor...');
  fireEvent.click(within(picker.closest('[role="dialog"]') as HTMLElement).getByText('Alpha Chem'));
  fireEvent.change(await screen.findByLabelText('Units needed'), { target: { value: '2' } });
}

describe('QuoteBuilder — leaving a new quote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation((table: string) => chain(
      table === 'customers' ? [customer] : table === 'products' ? [product] : [],
    ));
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { status: 'saved', quote_id: SAVED_ID, row_version: 1, item_ids: {} }, error: null }
      : name === 'generate_quote_number'
        // A new quote starts tracking edits only once its number has loaded.
        ? { data: 'Q-2026-0001', error: null }
        : { data: null, error: null }));
  });

  it('first Save Draft moves to the saved quote with no Unsaved Changes prompt', async () => {
    const router = renderNewQuote();
    await fillInNewQuote();

    fireEvent.click(screen.getByText('Save Draft'));

    expect(await screen.findByText(`Saved quote page ${SAVED_ID}`)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/quotes/${SAVED_ID}`);
    expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
    expect(mockToast).toHaveBeenCalledWith('success', 'Quote saved as draft');
    expect(mockToast).not.toHaveBeenCalledWith('warning', expect.anything());
    expect(mockRpc.mock.calls.filter(([name]) => name === 'save_quote')).toHaveLength(1);
  });

  it('locks the quote while the first save runs, so no edit can be left out of it', async () => {
    let releaseSave!: () => void;
    mockRpc.mockImplementation((name: string) => (name === 'save_quote'
      ? new Promise((resolve) => {
        releaseSave = () => resolve({ data: { status: 'saved', quote_id: SAVED_ID, row_version: 1, item_ids: {} }, error: null });
      })
      : Promise.resolve(name === 'generate_quote_number' ? { data: 'Q-2026-0001', error: null } : { data: null, error: null })));
    const router = renderNewQuote();
    await fillInNewQuote();

    fireEvent.click(screen.getByText('Save Draft'));
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('save_quote', expect.anything()));
    // The page leaves for the saved quote once the save lands, so an edit made now would
    // be lost: every field, including Planned Program, is locked until then.
    expect(screen.getByPlaceholderText(/Notes visible at the top of the quote/)).toBeDisabled();
    expect(screen.getByLabelText('Units needed')).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Customer' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Planned Program/ })).toBeDisabled();
    releaseSave();

    expect(await screen.findByText(`Saved quote page ${SAVED_ID}`)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/quotes/${SAVED_ID}`);
    expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
  });

  it('still opens the saved planned quote when its hold creation cannot be confirmed', async () => {
    mockRpc.mockImplementation((name: string) => Promise.resolve(name === 'save_quote'
      ? { data: { status: 'saved', quote_id: SAVED_ID, row_version: 1, item_ids: {} }, error: null }
      : name === 'generate_quote_number'
        ? { data: 'Q-2026-0001', error: null }
        // create_planned_holds answering nothing at all is the silent-denial reply assertRpcResult rejects.
        : { data: null, error: null }));
    const router = renderNewQuote();
    await fillInNewQuote();
    fireEvent.click(screen.getByRole('checkbox', { name: /Planned Program/ }));

    fireEvent.click(screen.getByText('Save Draft'));

    // Staying on /quotes/new with a locked form would strand the rep beside an already-saved quote.
    expect(await screen.findByText(`Saved quote page ${SAVED_ID}`)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/quotes/${SAVED_ID}`);
    expect(mockRpc).toHaveBeenCalledWith('create_planned_holds', expect.anything());
    expect(mockToast).toHaveBeenCalledWith('error', expect.stringContaining('inventory holds could not be confirmed'));
  });

  it('marks the quote unsaved when the rep ticks Planned Program', async () => {
    const router = renderNewQuote();
    await screen.findByRole('combobox', { name: 'Customer' });
    // Let the new quote finish loading so edits are tracked from here on.
    await waitFor(() => expect(mockRpc.mock.calls.some(([name]) => name === 'generate_quote_number')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));

    fireEvent.click(screen.getByRole('checkbox', { name: /Planned Program/ }));
    fireEvent.click(screen.getByText('Quotes list'));

    expect(await screen.findByText('Unsaved Changes')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/quotes/new');
  });

  it('still prompts when the rep leaves a new quote with real unsaved edits', async () => {
    const router = renderNewQuote();
    await fillInNewQuote();

    fireEvent.click(screen.getByText('Quotes list'));

    expect(await screen.findByText('Unsaved Changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));
    await waitFor(() => expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/quotes/new');
    expect(mockRpc).not.toHaveBeenCalledWith('save_quote', expect.anything());
  });
});
