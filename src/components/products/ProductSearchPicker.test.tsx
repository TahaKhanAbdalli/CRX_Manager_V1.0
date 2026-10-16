import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProductSearchPicker from './ProductSearchPicker';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  or: vi.fn(),
  limit: vi.fn(),
  toast: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../../lib/db', () => ({ supabase: { from: mocks.from } }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

function product(n: number) {
  return { id: `p-${n}`, product_name: `Product ${n}`, sku: `SKU-${n}`, rate_unit: 'oz', rate_per_acre: 8 };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.limit.mockReset();
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order']) builder[m] = vi.fn(() => builder);
  builder.or = mocks.or.mockImplementation(() => builder);
  builder.limit = mocks.limit;
  mocks.from.mockReturnValue(builder);
});

function renderPicker(onSelect = vi.fn()) {
  render(<ProductSearchPicker value="" selectedLabel="" onSelect={onSelect} ariaLabel="Product" />);
  return { input: screen.getByRole('combobox', { name: 'Product' }), onSelect };
}

describe('ProductSearchPicker', () => {
  it('searches active products in the database and returns the picked product', async () => {
    mocks.limit.mockResolvedValue({ data: [product(596)], error: null });
    const { input, onSelect } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Product 596' } });
    fireEvent.click(await screen.findByRole('option', { name: /Product 596/ }));
    expect(mocks.from).toHaveBeenCalledWith('products');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-596', rate_per_acre: 8 }));
  });

  it('quotes a name with a comma so it stays one search term', async () => {
    mocks.limit.mockResolvedValue({ data: [], error: null });
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '2,4-D' } });
    await waitFor(() => expect(mocks.or).toHaveBeenCalled());
    expect(mocks.or).toHaveBeenCalledWith('product_name.ilike."%2,4-D%",sku.ilike."%2,4-D%"');
    expect(await screen.findByText('No matching active products')).toBeInTheDocument();
  });

  it('treats a typed % as a literal character, not a wildcard', async () => {
    mocks.limit.mockResolvedValue({ data: [], error: null });
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '34%' } });
    await waitFor(() => expect(mocks.or).toHaveBeenCalled());
    expect(mocks.or).toHaveBeenCalledWith('product_name.ilike."%34\\\\%%",sku.ilike."%34\\\\%%"');
  });

  it('keeps showing results when only a trailing space is typed', async () => {
    mocks.limit.mockResolvedValue({ data: [product(7)], error: null });
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Zoom' } });
    expect(await screen.findByRole('option', { name: /Product 7/ })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Zoom ' } });
    expect(screen.getByRole('option', { name: /Product 7/ })).toBeInTheDocument();
    expect(screen.queryByText('Searching...')).not.toBeInTheDocument();
  });

  it('shows a failed search as an error, not as no matches', async () => {
    mocks.limit.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Atrazine' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Product search failed');
    expect(screen.queryByText('No matching active products')).not.toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith('error', 'Failed to search Products');
  });

  it('drops the previous search results as soon as the text changes', async () => {
    mocks.limit.mockResolvedValueOnce({ data: [product(1)], error: null });
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Atrazine' } });
    expect(await screen.findByRole('option', { name: /Product 1/ })).toBeInTheDocument();
    mocks.limit.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.change(input, { target: { value: 'Zoom' } });
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByText('Searching...')).toBeInTheDocument();
  });

  it('says when results stop at the limit instead of hiding the rest', async () => {
    mocks.limit.mockResolvedValue({ data: Array.from({ length: 20 }, (_, i) => product(i)), error: null });
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Product' } });
    expect(await screen.findByText(/Showing the first 20 matches/)).toBeInTheDocument();
  });
});
