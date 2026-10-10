import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFrom, mockUntypedFrom, mockUntypedRpc, mockToast, mockSentryCaptureException, authState } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockUntypedFrom: vi.fn(),
  mockUntypedRpc: vi.fn(),
  mockToast: vi.fn(),
  mockSentryCaptureException: vi.fn(),
  // Invoicing is admin-only (Mason 2026-10-09); the rep case switches this.
  authState: { role: 'admin' as 'admin' | 'sales_rep' },
}));

function buildChain(result: { data: unknown; error: unknown }): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => chain;
  for (const name of ['select', 'eq', 'is', 'not', 'in', 'order', 'limit', 'maybeSingle']) chain[name] = method;
  const promise = Promise.resolve(result);
  chain.then = promise.then.bind(promise);
  chain.catch = promise.catch.bind(promise);
  chain.finally = promise.finally.bind(promise);
  return chain;
}

/**
 * Records the column list each table was asked for.
 *
 * buildChain hands back its fixture no matter what columns the query requested, so a
 * fixture field the real `.select(...)` never asks for still shows up in the component —
 * exactly how a missing `product_form` passed every test while the live query returned
 * `undefined` for it. Assert against the requested columns, not the fixture.
 */
const selectArgs: Record<string, string[]> = {};

function recordingChain(table: string, result: { data: unknown; error: unknown }): Record<string, unknown> {
  const chain = buildChain(result);
  chain.select = (...args: unknown[]) => {
    if (typeof args[0] === 'string') (selectArgs[table] ??= []).push(args[0]);
    return chain;
  };
  return chain;
}

vi.mock('../lib/db', async () => ({
  supabase: { from: mockFrom, rpc: vi.fn() },
  supabaseUntyped: { from: mockUntypedFrom, rpc: mockUntypedRpc },
  assertRpcResult: vi.fn((value) => value),
  // The REAL error-code matching, so the INVOICE_CHANGED_SINCE_REVIEW case tests what ships.
  hasRpcCode: (await vi.importActual<typeof import('../lib/db')>('../lib/db')).hasRpcCode,
  RpcErrorCodes: (await vi.importActual<typeof import('../lib/db')>('../lib/db')).RpcErrorCodes,
  // The REAL sanitizeError, never a stub. The previous stub was typed
  // `(error: Error) => error.message`, which misrepresents the null, string and
  // plain-object inputs the real function exists to survive -- postgrest-js only
  // constructs a real Error under `.throwOnError()`, so a failing rpc resolves a
  // plain object here.
  sanitizeError: (await vi.importActual<typeof import('../lib/errorSanitizer')>(
    '../lib/errorSanitizer',
  )).sanitizeError,
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'actor-1', role: authState.role }, role: authState.role }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'idem', resetKey: vi.fn() }),
}));
vi.mock('../hooks/useGuardrails', () => ({
  useCreditLimitCheck: () => ({ check: vi.fn() }),
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: mockSentryCaptureException } }));

import FieldAppSplitInvoiceEditor from './FieldAppSplitInvoiceEditor';

beforeEach(() => {
  authState.role = 'admin';
});

// Second layer behind the admin-only route: a non-admin never gets the editor.
describe('FieldAppSplitInvoiceEditor — admin-only invoicing', () => {
  it('shows a sales rep a notice instead of the editor, with no Save or Post', async () => {
    authState.role = 'sales_rep';
    mockFrom.mockImplementation(() => buildChain({ data: { setting_value: 'true' }, error: null }));
    render(
      <MemoryRouter>
        <FieldAppSplitInvoiceEditor />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Only an admin can create or post split invoices' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save Draft/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Post$/ })).not.toBeInTheDocument();
  });
});

describe('FieldAppSplitInvoiceEditor picker loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation((table: string) => {
      if (table === 'app_settings') return buildChain({ data: { setting_value: 'true' }, error: null });
      if (table === 'fields') return buildChain({ data: [{ id: 'field-1', field_name: 'North 40' }], error: null });
      if (table === 'products') {
        return buildChain({
          data: [{
            id: '11111111-1111-4111-8111-111111111111',
            product_name: 'Exact Product',
            sku: 'SKU-EXACT',
            inventory_unit: 'gal',
            return_policy: 'returnable',
            is_full_tote_only: false,
            product_family: { name: 'Family Alpha' },
          }],
          error: null,
        });
      }
      if (table === 'application_services') return buildChain({ data: [{ id: 'service-1', name: 'Aerial application' }], error: null });
      if (table === 'jobs') return buildChain({ data: null, error: new Error('jobs unavailable') });
      return buildChain({ data: [], error: null });
    });
  });

  it('keeps successful field, Product, and service pickers usable when jobs fail', async () => {
    render(
      <MemoryRouter>
        <FieldAppSplitInvoiceEditor />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Split Billing — New' })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: 'North 40' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Source job/).querySelectorAll('option')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Chemical' }));
    expect(await screen.findByRole('option', { name: /Exact Product.*SKU-EXACT/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Service' }));
    expect(await screen.findByRole('option', { name: 'Aerial application' })).toBeInTheDocument();

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Some field application invoice pickers could not be loaded.'));
    expect(mockSentryCaptureException).toHaveBeenCalledTimes(1);
    expect(mockSentryCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: { context: 'load_field_app_split_invoice_pickers' } }),
    );
  });
});

// ── Rate unit is a picker, not free text ────────────────────────────────────
// The bug class this closes: a typed rate unit the pricing engine can't resolve.
// field_app_priced_quantity returns NULL for an unknown unit and the save RPC then
// raises FIELD_APP_UNIT_UNCONVERTIBLE, so a typo used to be a hard save failure the
// operator had no way to see coming.
const LIQUID_PRODUCT = {
  id: '11111111-1111-4111-8111-111111111111',
  product_name: 'Liquid Product',
  sku: 'SKU-LIQ',
  inventory_unit: 'Gal',
  return_policy: 'returnable',
  is_full_tote_only: false,
  product_form: 'liquid',
  product_family: { name: 'Family Alpha' },
};

const DRY_PRODUCT = {
  id: '22222222-2222-4222-8222-222222222222',
  product_name: 'Dry Product',
  sku: 'SKU-DRY',
  inventory_unit: 'Lb',
  return_policy: 'returnable',
  is_full_tote_only: false,
  product_form: 'dry',
  product_family: { name: 'Family Alpha' },
};

// Shape mirrors the live unit_conversions rows verified 2026-08-23.
const UNIT_ROWS = [
  { id: 'u-ea', unit: 'Ea', factor_oz: 1, unit_type: 'both', notes: null },
  { id: 'u-gal', unit: 'Gal', factor_oz: 128, unit_type: 'liquid', notes: null },
  { id: 'u-oz', unit: 'oz', factor_oz: 1, unit_type: 'liquid', notes: null },
  { id: 'u-lb', unit: 'Lb', factor_oz: 16, unit_type: 'dry', notes: null },
];

function mockTables(overrides: { unitError?: Error } = {}) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'app_settings') return buildChain({ data: { setting_value: 'true' }, error: null });
    if (table === 'fields') return buildChain({ data: [{ id: 'field-1', field_name: 'North 40' }], error: null });
    if (table === 'products') return recordingChain('products', { data: [LIQUID_PRODUCT, DRY_PRODUCT], error: null });
    if (table === 'application_services') return buildChain({ data: [{ id: 'service-1', name: 'Aerial application' }], error: null });
    if (table === 'jobs') return buildChain({ data: [], error: null });
    if (table === 'unit_conversions') {
      return overrides.unitError
        ? buildChain({ data: null, error: overrides.unitError })
        : buildChain({ data: UNIT_ROWS, error: null });
    }
    return buildChain({ data: [], error: null });
  });
}

/** Add one field with positive acres so validateForSave reaches the unit check. */
async function addFieldWithAcres() {
  fireEvent.change(await screen.findByLabelText(/Add a field/), { target: { value: 'field-1' } });
  fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));
  fireEvent.change(await screen.findByLabelText(/Applied acres/), { target: { value: '40' } });
}

describe('FieldAppSplitInvoiceEditor rate unit picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(selectArgs)) delete selectArgs[key];
    mockTables();
  });

  it('actually asks the database for product_form', async () => {
    render(
      <MemoryRouter>
        <FieldAppSplitInvoiceEditor />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Split Billing — New' });

    // Without this the unit filter silently degrades: product_form comes back undefined,
    // every unit stays on offer, and the clear-on-form-change guard never fires. The row
    // fixture cannot catch it because the mock returns product_form regardless.
    await waitFor(() => expect(selectArgs.products?.length).toBeGreaterThan(0));
    expect(selectArgs.products.join(' ')).toContain('product_form');
  });

  it('offers only real unit_conversions units, filtered to the selected product form', async () => {
    render(
      <MemoryRouter>
        <FieldAppSplitInvoiceEditor />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Split Billing — New' });
    fireEvent.click(screen.getByRole('button', { name: 'Chemical' }));

    const rateUnit = await screen.findByLabelText(/^Rate unit for/);
    // It is a <select>, not a text box: there is no longer any way to type a unit.
    expect(rateUnit.tagName).toBe('SELECT');

    // No product picked yet → form is unknown, so every unit stays offered.
    expect(within(rateUnit).getByRole('option', { name: 'Gal' })).toBeInTheDocument();
    expect(within(rateUnit).getByRole('option', { name: 'Lb' })).toBeInTheDocument();

    // Held once: selecting a product renders ProductOptionDetails inside the same
    // <label>, which changes the select's accessible name and breaks a re-query by name.
    const productSelect = await screen.findByRole('combobox', { name: 'Product' });

    // Liquid product → dry units drop out, 'both' units stay.
    fireEvent.change(productSelect, { target: { value: LIQUID_PRODUCT.id } });
    await waitFor(() => expect(within(screen.getByLabelText(/^Rate unit for/)).queryByRole('option', { name: 'Lb' })).toBeNull());
    const liquidSelect = screen.getByLabelText(/^Rate unit for/);
    expect(within(liquidSelect).getByRole('option', { name: 'Gal' })).toBeInTheDocument();
    expect(within(liquidSelect).getByRole('option', { name: 'oz' })).toBeInTheDocument();
    expect(within(liquidSelect).getByRole('option', { name: 'Ea' })).toBeInTheDocument();

    // Dry product → the liquid units drop out instead.
    fireEvent.change(productSelect, { target: { value: DRY_PRODUCT.id } });
    await waitFor(() => expect(within(screen.getByLabelText(/^Rate unit for/)).queryByRole('option', { name: 'Gal' })).toBeNull());
    expect(within(screen.getByLabelText(/^Rate unit for/)).getByRole('option', { name: 'Lb' })).toBeInTheDocument();
  });

  it('sends the picked unit through as rate_unit', async () => {
    render(
      <MemoryRouter>
        <FieldAppSplitInvoiceEditor />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Split Billing — New' });
    fireEvent.click(screen.getByRole('button', { name: 'Chemical' }));

    fireEvent.change(await screen.findByRole('combobox', { name: 'Product' }), { target: { value: LIQUID_PRODUCT.id } });
    const rateUnit = await screen.findByLabelText(/^Rate unit for Liquid Product$/);
    fireEvent.change(rateUnit, { target: { value: 'Gal' } });
    expect((rateUnit as HTMLSelectElement).value).toBe('Gal');
  });

  it('clears a rate unit the newly picked product form cannot offer', async () => {
    render(
      <MemoryRouter>
        <FieldAppSplitInvoiceEditor />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Split Billing — New' });
    fireEvent.click(screen.getByRole('button', { name: 'Chemical' }));

    const productSelect = await screen.findByRole('combobox', { name: 'Product' });
    fireEvent.change(productSelect, { target: { value: LIQUID_PRODUCT.id } });
    fireEvent.change(await screen.findByLabelText(/^Rate unit for/), { target: { value: 'Gal' } });
    expect((screen.getByLabelText(/^Rate unit for/) as HTMLSelectElement).value).toBe('Gal');

    // Switching to a dry product leaves 'Gal' — a liquid unit — grandfathered onto the line
    // unless it is cleared. Found by driving the real screen in a browser.
    fireEvent.change(productSelect, { target: { value: DRY_PRODUCT.id } });
    await waitFor(() => expect((screen.getByLabelText(/^Rate unit for/) as HTMLSelectElement).value).toBe(''));
    expect(within(screen.getByLabelText(/^Rate unit for/)).queryByRole('option', { name: 'Gal' })).toBeNull();
  });

  it('keeps a rate unit the newly picked product form still offers', async () => {
    render(
      <MemoryRouter>
        <FieldAppSplitInvoiceEditor />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Split Billing — New' });
    fireEvent.click(screen.getByRole('button', { name: 'Chemical' }));

    const productSelect = await screen.findByRole('combobox', { name: 'Product' });
    fireEvent.change(productSelect, { target: { value: LIQUID_PRODUCT.id } });
    // 'Ea' is a 'both'-type unit, so it survives a liquid → dry switch.
    fireEvent.change(await screen.findByLabelText(/^Rate unit for/), { target: { value: 'Ea' } });
    fireEvent.change(productSelect, { target: { value: DRY_PRODUCT.id } });

    await waitFor(() => expect(screen.getByLabelText(/^Rate unit for Dry Product$/)).toBeInTheDocument());
    expect((screen.getByLabelText(/^Rate unit for/) as HTMLSelectElement).value).toBe('Ea');
  });

  it('refuses to save a blank unit when the unit list failed to load', async () => {
    mockTables({ unitError: new Error('unit_conversions unavailable') });
    render(
      <MemoryRouter>
        <FieldAppSplitInvoiceEditor />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Split Billing — New' });
    await addFieldWithAcres();

    fireEvent.click(screen.getByRole('button', { name: 'Chemical' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Product' }), { target: { value: LIQUID_PRODUCT.id } });
    fireEvent.change(screen.getByLabelText(/Total quantity/), { target: { value: '10' } });

    // The picker could not be populated, so the rate unit is unavoidably blank.
    expect((screen.getByLabelText(/^Rate unit for/) as HTMLSelectElement).value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: /Save Draft/ }));

    // Names the real cause (a failed load) instead of blaming the operator for a
    // blank they had no way to fill.
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'Units could not be loaded, so a unit is still blank. Refresh and retry before saving.',
    ));
    expect(mockToast).not.toHaveBeenCalledWith(
      'error',
      'A chemical line needs a rate unit (e.g. oz, gal) so the price can be resolved.',
    );
  });

  it('still blocks a blank unit on a healthy list with the per-line rule', async () => {
    render(
      <MemoryRouter>
        <FieldAppSplitInvoiceEditor />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Split Billing — New' });
    await addFieldWithAcres();

    fireEvent.click(screen.getByRole('button', { name: 'Chemical' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Product' }), { target: { value: LIQUID_PRODUCT.id } });
    fireEvent.change(screen.getByLabelText(/Total quantity/), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Draft/ }));

    // blockedUnitSaveMessage returns null on a loaded, non-empty list, so validation
    // walks PAST the unit guard to the next unmet rule. Proving that is the point: a
    // guard that fired here would tell an operator to refresh a list that loaded fine.
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'Resolve the default split before saving.'));
    expect(mockToast).not.toHaveBeenCalledWith(
      'error',
      'Units could not be loaded, so a unit is still blank. Refresh and retry before saving.',
    );
    expect(mockToast).not.toHaveBeenCalledWith('error', 'Units are still loading. Try saving again in a moment.');
  });
});

// ── Posting version (addendum 8b on this editor too) ────────────────────────
// Reopening a saved split reads the group's posting version BEFORE the result card, and Post
// sends it as p_expected_version, so a re-save from another tab or admin between review and
// Post is refused by the database instead of posting unseen.
describe('FieldAppSplitInvoiceEditor — reopened draft posts the reviewed version', () => {
  const VERSION = 'a'.repeat(32);
  let events: string[] = [];
  // Every version read returns this (the reopen effect may load more than once).
  let versionResult: { data: unknown; error: unknown } = { data: VERSION, error: null };
  let postResult: { data: unknown; error: unknown } = { data: { success: true }, error: null };

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    versionResult = { data: VERSION, error: null };
    postResult = { data: { success: true }, error: null };
    mockTables();
    const pickerTables = mockFrom.getMockImplementation()!;
    mockFrom.mockImplementation((table: string) => (table === 'customers'
      ? buildChain({ data: [{ id: 'cust-1', farm_name: 'Farm One' }], error: null })
      : pickerTables(table)));
    mockUntypedFrom.mockImplementation((table: string) => {
      events.push(`from:${table}`);
      if (table === 'field_app_billing_sets') {
        return buildChain({ data: { id: 'set-1', invoice_group_id: 'grp-1', source_job_id: null }, error: null });
      }
      if (table === 'invoices') {
        return buildChain({
          data: [{ id: 'inv-1', invoice_number: 'INV-1', customer_id: 'cust-1', total_amount_cents: 0, send_disposition: 'normal', status: 'draft' }],
          error: null,
        });
      }
      return buildChain({ data: [], error: null });
    });
    mockUntypedRpc.mockImplementation((name: string) => {
      events.push(`rpc:${name}`);
      if (name === 'get_invoice_group_post_version') return Promise.resolve(versionResult);
      if (name === 'post_invoice_group') return Promise.resolve(postResult);
      return Promise.resolve({ data: null, error: null });
    });
  });

  async function openAndConfirmPost() {
    render(
      <MemoryRouter initialEntries={['/split-billing/set-1']}>
        <Routes>
          <Route path="/split-billing/:id" element={<FieldAppSplitInvoiceEditor />} />
        </Routes>
      </MemoryRouter>,
    );
    const post = await screen.findByRole('button', { name: /^Post$/ });
    await waitFor(() => expect(post).not.toBeDisabled());
    fireEvent.click(post);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Post$/ }));
  }

  it('reads the version before the result card and sends it with the post', async () => {
    await openAndConfirmPost();
    await waitFor(() => expect(mockUntypedRpc).toHaveBeenCalledWith('post_invoice_group', {
      p_invoice_group_id: 'grp-1',
      p_performed_by: 'actor-1',
      p_idempotency_key: 'idem',
      p_expected_version: VERSION,
    }));
    expect(mockUntypedRpc).toHaveBeenCalledWith('get_invoice_group_post_version', { p_invoice_group_id: 'grp-1' });
    // The version is read before the child invoices the admin reviews.
    expect(events.indexOf('rpc:get_invoice_group_post_version')).toBeLessThan(events.indexOf('from:invoices'));
  });

  it('posts nothing when the version could not be read', async () => {
    versionResult = { data: null, error: { message: 'network down' } };
    await openAndConfirmPost();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'Could not check the saved invoice before posting. Nothing was posted — please try again.',
    ));
    expect(mockUntypedRpc.mock.calls.some(([name]) => name === 'post_invoice_group')).toBe(false);
  });

  it('reloads with a clear message when the database says the group changed since review', async () => {
    postResult = {
      data: null,
      error: { code: 'P0001', message: 'INVOICE_CHANGED_SINCE_REVIEW: an invoice in this group changed after it was reviewed; reload and review it again before posting' },
    };
    await openAndConfirmPost();
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'This invoice changed since you reviewed it — it has been reloaded; check it and post again.',
    ));
    // A fresh version, then a fresh readback, for the reloaded card.
    await waitFor(() => {
      const posted = events.indexOf('rpc:post_invoice_group');
      expect(posted).toBeGreaterThan(-1);
      const versionAfter = events.indexOf('rpc:get_invoice_group_post_version', posted);
      expect(versionAfter).toBeGreaterThan(posted);
      expect(events.indexOf('from:invoices', versionAfter)).toBeGreaterThan(versionAfter);
    });
    expect(mockToast).not.toHaveBeenCalledWith('success', 'Invoice group posted.');
  });
});
