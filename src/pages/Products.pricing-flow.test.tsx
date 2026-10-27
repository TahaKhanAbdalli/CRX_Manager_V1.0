import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockApplyPricing,
  mockApprovePricing,
  mockExportPricing,
  mockParsePricing,
  mockPreviewPricing,
  mockProducts,
  mockProductUpdate,
  mockToast,
  pricingWorkbookFileLimit,
  pricingWorkbookRowLimit,
} = vi.hoisted(() => ({
  mockApplyPricing: vi.fn(),
  mockApprovePricing: vi.fn(),
  mockExportPricing: vi.fn(),
  mockParsePricing: vi.fn(),
  mockPreviewPricing: vi.fn(),
  mockProducts: [] as Array<Record<string, unknown>>,
  mockProductUpdate: vi.fn(),
  mockToast: vi.fn(),
  pricingWorkbookFileLimit: 10 * 1024 * 1024,
  pricingWorkbookRowLimit: 1,
}));

const product = {
  id: '11111111-1111-4111-8111-111111111111',
  product_name: 'Inline Pricing Product',
  sku: 'INLINE-001',
  category: 'Herbicide',
  vendor: 'Test Supplier',
  current_cost: 50,
  tier1_margin: 0.2,
  tier2_margin: 0.15,
  tier3_margin: 0.1,
  tier1_price: 62.5,
  tier2_price: 58.82,
  tier3_price: 55.56,
  tier1_price_per_acre: null,
  tier2_price_per_acre: null,
  tier3_price_per_acre: null,
  pricing_version: 7,
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function chainable(resolveWith: unknown) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  for (const method of [
    'select', 'insert', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'like', 'ilike', 'is', 'in', 'or', 'not', 'match', 'order', 'limit', 'range',
    'single', 'maybeSingle', 'csv', 'explain',
  ]) {
    builder[method] = vi.fn(self);
  }
  builder.update = mockProductUpdate.mockImplementation(self);
  builder.then = vi.fn((resolve: (value: unknown) => void) => {
    Promise.resolve(resolveWith).then(resolve);
  });
  return builder;
}

vi.mock('../lib/db', () => ({
  supabase: {
    from: vi.fn(() => chainable({ data: mockProducts, error: null })),
  },
  sanitizeError: (error: unknown) => error instanceof Error ? error.message : String(error),
  checkMutationResult: vi.fn(),
}));

vi.mock('../lib/productPricing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/productPricing')>();
  return {
    ...actual,
    previewProductPricingChanges: mockPreviewPricing,
    approvePricingChangeSet: mockApprovePricing,
    applyProductPricingChangeSet: mockApplyPricing,
    createPricingWorkbookExport: mockExportPricing,
  };
});

vi.mock('../lib/productPricingSupplierEvidenceWorkbook', () => ({
  generateProductPricingWorkbookWithSupplierEvidence: vi.fn(),
  parseProductPricingWorkbookWithSupplierEvidence: mockParsePricing,
}));

vi.mock('../lib/productPricingWorkbook', () => ({
  generateProductPricingWorkbook: vi.fn(),
  MAX_PRICING_WORKBOOK_FILE_BYTES: pricingWorkbookFileLimit,
  MAX_PRICING_WORKBOOK_ROWS: pricingWorkbookRowLimit,
  parseProductPricingWorkbook: mockParsePricing,
}));

vi.mock('../components/ui/EditableDataTable', () => ({
  default: ({ data, onSave, filters }: {
    data: typeof product[];
    onSave: (changes: Map<string, Record<string, unknown>>) => Promise<void | boolean>;
    filters?: ReactNode;
  }) => (
    <>
      {filters}
      <button
        disabled={data.length === 0}
        onClick={() => void onSave(new Map([[
          data[0].id,
          {
            pricing_mode: 'margin_driven',
            current_cost: '90071992547409.91',
            tier1_margin_percent: '20',
            tier2_margin_percent: '15',
            tier3_margin_percent: '10',
          },
        ]]))}
      >
        Test inline pricing save
      </button>
    </>
  ),
}));

vi.mock('../components/products/BulkProductImport', () => ({ default: () => null }));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

// Admin cost comes from get_admin_cost_fields; the fixtures already carry it, so pass rows through.
vi.mock('../lib/costFields', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/costFields')>()),
  withAdminCosts: async (_table: string, rows: readonly unknown[]) => [...rows],
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    role: 'admin',
    profile: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', full_name: 'Test Admin' },
  }),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));

import Products from './Products';

/** The preview beforeEach installs, read back without counting as a call. */
async function inlinePreview(): Promise<Record<string, unknown>> {
  const value = await (mockPreviewPricing as unknown as () => Promise<Record<string, unknown>>)();
  mockPreviewPricing.mockClear();
  return value;
}

describe('Products governed inline pricing flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProducts.splice(0, mockProducts.length, product);
    mockPreviewPricing.mockResolvedValue({
      change_set_id: '22222222-2222-4222-8222-222222222222',
      request_fingerprint: 'inline-fingerprint',
      source: 'products_inline',
      status: 'previewed',
      expires_at: '2026-07-16T23:00:00Z',
      submitted_row_count: 1,
      ready_count: 1,
      unchanged_count: 0,
      conflict_count: 0,
      invalid_count: 0,
      apply_allowed: true,
      rows: [{
        sequence: 1,
        product_id: product.id,
        submitted_row: { product_name: product.product_name, sku: product.sku },
        row_status: 'ready',
        error_code: null,
        effect: {
          product_id: product.id,
          product_name: product.product_name,
          sku: product.sku,
          pricing_mode: 'margin_driven',
          before: {
            cost: '50.00', cost_cents: 5000,
            tier1_margin_percent: '20', tier1_margin: 0.2, tier1_price: '62.50', tier1_price_cents: 6250,
            tier2_margin_percent: '15', tier2_margin: 0.15, tier2_price: '58.82', tier2_price_cents: 5882,
            tier3_margin_percent: '10', tier3_margin: 0.1, tier3_price: '55.56', tier3_price_cents: 5556,
          },
          cost: '55.00', cost_cents: 5500,
          tier1_margin_percent: '20', tier1_margin: 0.2, tier1_price: '68.75', tier1_price_cents: 6875,
          tier2_margin_percent: '15', tier2_margin: 0.15, tier2_price: '64.71', tier2_price_cents: 6471,
          tier3_margin_percent: '10', tier3_margin: 0.1, tier3_price: '61.11', tier3_price_cents: 6111,
        },
      }],
      warnings: [],
    });
    mockApprovePricing.mockResolvedValue(undefined);
    mockApplyPricing.mockResolvedValue({
      change_set_id: '22222222-2222-4222-8222-222222222222',
      status: 'applied',
      applied_count: 1,
      rows: [],
    });
  });

  it('previews and applies inline pricing without a direct products update', async () => {
    render(<Products />);
    const saveButton = await screen.findByRole('button', { name: 'Test inline pricing save' });
    await waitFor(() => expect(saveButton).toBeEnabled());
    fireEvent.click(saveButton);

    // The source and reason are asked first; nothing is previewed until both are given.
    const preview = await screen.findByRole('button', { name: 'Preview changes' });
    expect(preview).toBeDisabled();
    expect(mockPreviewPricing).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Source (supplier, document, date)'), { target: { value: 'Helena list Oct 2026' } });
    fireEvent.change(screen.getByLabelText('Reason for the change'), { target: { value: 'Supplier raised cost' } });
    fireEvent.click(preview);

    await waitFor(() => expect(mockPreviewPricing).toHaveBeenCalledWith(expect.objectContaining({
      source: 'products_inline',
      performedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      idempotencyKey: expect.any(String),
      rows: [{
        product_id: product.id,
        product_name: product.product_name,
        sku: product.sku,
        row_version: 7,
        pricing_mode: 'margin_driven',
        new_cost: '90071992547409.91',
        tier1_margin_percent: '20',
        tier2_margin_percent: '15',
        tier3_margin_percent: '10',
        change_reason: 'Supplier raised cost',
        price_source: 'Helena list Oct 2026',
      }],
    })));

    expect(await screen.findByText(product.product_name)).toBeTruthy();
    expect(screen.getByText('$50.00')).toBeTruthy();
    expect(screen.getByText('$55.00')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply approved changes' }));

    // Approved first (no warnings, no file for an inline edit), then applied.
    await waitFor(() => expect(mockApprovePricing).toHaveBeenCalledWith({
      changeSetId: '22222222-2222-4222-8222-222222222222',
      requestFingerprint: 'inline-fingerprint',
      acknowledgements: [],
      sourceFile: null,
      performedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      idempotencyKey: expect.any(String),
    }));
    await waitFor(() => expect(mockApplyPricing).toHaveBeenCalledWith(expect.objectContaining({
      changeSetId: '22222222-2222-4222-8222-222222222222',
      requestFingerprint: 'inline-fingerprint',
      performedBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      idempotencyKey: expect.any(String),
    })));
    expect(mockApprovePricing.mock.invocationCallOrder[0]).toBeLessThan(mockApplyPricing.mock.invocationCallOrder[0]);
    expect(mockProductUpdate).not.toHaveBeenCalled();
  });

  it('keeps apply locked until every warning has a reason, then sends exactly those acknowledgements', async () => {
    mockPreviewPricing.mockResolvedValue({
      ...(await inlinePreview()),
      warnings: [{
        product_id: product.id,
        warning_codes: ['COST_MOVE_OVER_10_PERCENT', 'OPEN_SENT_QUOTE'],
        details: {
          cost_before_cents: 5000n, cost_after_cents: 5500n, margin_floor: null, tiers: [],
          open_quote_count: 1, open_quote_numbers: ['Q-1001'],
        },
      }],
    });
    render(<Products />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test inline pricing save' }));
    fireEvent.change(await screen.findByLabelText('Source (supplier, document, date)'), { target: { value: 'Helena list' } });
    fireEvent.change(screen.getByLabelText('Reason for the change'), { target: { value: 'Cost up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));

    const apply = await screen.findByRole('button', { name: 'Apply approved changes' });
    expect(screen.getByText('Cost moves more than 10%')).toBeTruthy();
    expect(screen.getByText(/1 quote \(Q-1001\)/)).toBeTruthy();
    expect(apply).toBeDisabled();
    fireEvent.change(screen.getByLabelText(`Reason for ${product.product_name}`), { target: { value: '  ' } });
    expect(apply).toBeDisabled();
    fireEvent.change(screen.getByLabelText(`Reason for ${product.product_name}`), { target: { value: ' Supplier letter, quote re-sent ' } });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);

    await waitFor(() => expect(mockApprovePricing).toHaveBeenCalledWith(expect.objectContaining({
      acknowledgements: [{
        product_id: product.id,
        warning_codes: ['COST_MOVE_OVER_10_PERCENT', 'OPEN_SENT_QUOTE'],
        reason: 'Supplier letter, quote re-sent',
      }],
    })));
    await waitFor(() => expect(mockApplyPricing).toHaveBeenCalled());
  });

  it('retries a failed preview with the same key, but a changed reason gets a new one', async () => {
    mockPreviewPricing.mockRejectedValueOnce(new Error('network timeout')).mockRejectedValueOnce(new Error('network timeout'));
    render(<Products />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test inline pricing save' }));
    fireEvent.change(await screen.findByLabelText('Source (supplier, document, date)'), { target: { value: 'Helena list' } });
    fireEvent.change(screen.getByLabelText('Reason for the change'), { target: { value: 'Cost up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    await waitFor(() => expect(mockPreviewPricing).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview changes' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    await waitFor(() => expect(mockPreviewPricing).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview changes' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Reason for the change'), { target: { value: 'Cost up 10%' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    await waitFor(() => expect(mockPreviewPricing).toHaveBeenCalledTimes(3));

    const keys = mockPreviewPricing.mock.calls.map(([args]) => (args as { idempotencyKey: string }).idempotencyKey);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('retries an apply whose answer was lost with the same approval and apply keys', async () => {
    // The first apply committed but its answer never arrived; the retry must replay both steps.
    mockApplyPricing.mockRejectedValueOnce(new Error('network timeout'));
    render(<Products />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test inline pricing save' }));
    fireEvent.change(await screen.findByLabelText('Source (supplier, document, date)'), { target: { value: 'Helena list' } });
    fireEvent.change(screen.getByLabelText('Reason for the change'), { target: { value: 'Cost up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    const apply = await screen.findByRole('button', { name: 'Apply approved changes' });
    fireEvent.click(apply);
    await waitFor(() => expect(mockApplyPricing).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply approved changes' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Apply approved changes' }));
    await waitFor(() => expect(mockApplyPricing).toHaveBeenCalledTimes(2));

    const approveKeys = mockApprovePricing.mock.calls.map(([args]) => (args as { idempotencyKey: string }).idempotencyKey);
    const applyKeys = mockApplyPricing.mock.calls.map(([args]) => (args as { idempotencyKey: string }).idempotencyKey);
    expect(approveKeys).toHaveLength(2);
    expect(approveKeys[1]).toBe(approveKeys[0]);
    expect(applyKeys[1]).toBe(applyKeys[0]);
  });

  it('does not apply when the approval is refused, and says why', async () => {
    mockApprovePricing.mockRejectedValue(new Error('PRICING_WARNINGS_CHANGED: preview it again'));
    render(<Products />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test inline pricing save' }));
    fireEvent.change(await screen.findByLabelText('Source (supplier, document, date)'), { target: { value: 'Helena list' } });
    fireEvent.change(screen.getByLabelText('Reason for the change'), { target: { value: 'Cost up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview changes' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply approved changes' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', 'PRICING_WARNINGS_CHANGED: preview it again'));
    expect(mockApplyPricing).not.toHaveBeenCalled();
  });

  it('names the uploaded price sheet (file name and SHA-256) in a workbook approval', async () => {
    mockParsePricing.mockResolvedValue({ exportId: 'export-1', rows: [] });
    mockPreviewPricing.mockResolvedValue({ ...(await inlinePreview()), source: 'pricing_worksheet' });
    const { container } = render(<Products />);
    await screen.findByRole('button', { name: 'Review Pricing File' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"][accept^=".xlsx"]')!;
    const file = new File(['abc'], 'october-prices.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Apply approved changes' }));

    await waitFor(() => expect(mockApprovePricing).toHaveBeenCalledWith(expect.objectContaining({
      sourceFile: {
        name: 'october-prices.xlsx',
        sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      },
    })));
  });

  it('exports the full price sheet: every active product, never an inactive one', async () => {
    mockExportPricing.mockRejectedValue(new Error('stop after the request'));
    mockProducts.push({ ...product, id: '44444444-4444-4444-8444-444444444444', product_name: 'Retired', is_active: false });
    render(<Products />);
    const full = await screen.findByRole('button', { name: 'Full price sheet' });
    await waitFor(() => expect(full).toBeEnabled());
    fireEvent.click(full);

    await waitFor(() => expect(mockExportPricing).toHaveBeenCalledWith(expect.objectContaining({
      productIds: [product.id],
    })));
  });

  it('gives each exported product list its own export key, and a retry of the same list the same key', async () => {
    // The full price sheet is another list, so it gets its own key the same way; the one-row test
    // ceiling keeps this to two one-product lists.
    mockExportPricing.mockRejectedValue(new Error('stop after the request'));
    const fungicideId = '55555555-5555-4555-8555-555555555555';
    mockProducts.push({ ...product, id: fungicideId, product_name: 'Fungicide Product', category: 'Fungicide' });
    render(<Products />);
    const categoryFilter = await screen.findByLabelText('Filter by category');
    const exportButton = screen.getByRole('button', { name: 'Pricing .xlsx' });
    fireEvent.change(categoryFilter, { target: { value: 'Herbicide' } });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);
    await waitFor(() => expect(mockExportPricing).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);
    await waitFor(() => expect(mockExportPricing).toHaveBeenCalledTimes(2));
    fireEvent.change(categoryFilter, { target: { value: 'Fungicide' } });
    await waitFor(() => expect(exportButton).toBeEnabled());
    fireEvent.click(exportButton);
    await waitFor(() => expect(mockExportPricing).toHaveBeenCalledTimes(3));

    const [first, retry, other] = mockExportPricing.mock.calls.map(([args]) => args);
    expect(first.productIds).toEqual([product.id]);
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(other.productIds).toEqual([fungicideId]);
    expect(other.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('rejects an oversized pricing workbook before reading or parsing the file', async () => {
    const { container } = render(<Products />);
    await screen.findByRole('button', { name: 'Review Pricing File' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"][accept^=".xlsx"]')!;
    const arrayBuffer = vi.fn();
    const file = new File(['small test payload'], 'oversized.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    Object.defineProperty(file, 'size', { value: pricingWorkbookFileLimit + 1 });
    Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'Pricing workbooks must be 10 MB or smaller.',
    ));
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(mockParsePricing).not.toHaveBeenCalled();
    expect(mockPreviewPricing).not.toHaveBeenCalled();
  });

  it('rejects an export that would exceed the workbook import row limit', async () => {
    mockProducts.push({
      ...product,
      id: '33333333-3333-4333-8333-333333333333',
      product_name: 'Second Inline Pricing Product',
      sku: 'INLINE-002',
    });
    render(<Products />);
    const exportButton = await screen.findByRole('button', { name: 'Pricing .xlsx' });
    await waitFor(() => expect(exportButton).toBeEnabled());

    // The production ceiling is 5,000. This test uses a one-row ceiling and two
    // fixtures to prove the guard without manufacturing 5,001 rows.
    fireEvent.click(exportButton);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'Pricing workbooks are limited to 1 Products. Narrow the filters or select a smaller batch.',
    ));
  });
});
