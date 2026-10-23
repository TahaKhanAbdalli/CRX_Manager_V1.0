import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CustomerSearchPicker from './CustomerSearchPicker';
import FieldSearchPicker from '../fields/FieldSearchPicker';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  eq: vi.fn(),
  not: vi.fn(),
  or: vi.fn(),
  limit: vi.fn(),
  toast: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../../lib/db', () => ({ supabase: { from: mocks.from } }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.limit.mockReset();
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'order']) builder[m] = vi.fn(() => builder);
  builder.eq = mocks.eq.mockImplementation(() => builder);
  builder.not = mocks.not.mockImplementation(() => builder);
  builder.or = mocks.or.mockImplementation(() => builder);
  builder.limit = mocks.limit;
  mocks.from.mockReturnValue(builder);
});

function type(input: HTMLElement, value: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
}

describe('CustomerSearchPicker', () => {
  it('finds a customer past the old 500-row list in the database and returns it', async () => {
    mocks.limit.mockResolvedValue({ data: [{ id: 'c-1150', farm_name: 'Seed Farm 1150', account_number: 'A1150' }], error: null });
    const onSelect = vi.fn();
    render(<CustomerSearchPicker value="" selectedLabel="" onSelect={onSelect} ariaLabel="Customer" />);
    type(screen.getByRole('combobox', { name: 'Customer' }), '1150');
    fireEvent.click(await screen.findByRole('option', { name: /Seed Farm 1150/ }));
    expect(mocks.from).toHaveBeenCalledWith('customers');
    expect(mocks.eq).toHaveBeenCalledWith('is_active', true);
    expect(mocks.limit).toHaveBeenCalledWith(20);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'c-1150' }));
  });

  it('quotes a farm name with a comma and parentheses so it stays one search term', async () => {
    mocks.limit.mockResolvedValue({ data: [], error: null });
    render(<CustomerSearchPicker value="" selectedLabel="" onSelect={vi.fn()} ariaLabel="Customer" />);
    type(screen.getByRole('combobox', { name: 'Customer' }), 'Smith, John (North)');
    await waitFor(() => expect(mocks.or).toHaveBeenCalled());
    expect(mocks.or).toHaveBeenCalledWith(
      'farm_name.ilike."%Smith, John (North)%",account_number.ilike."%Smith, John (North)%"',
    );
    expect(await screen.findByText('No matching active customers')).toBeInTheDocument();
  });

  it('shows a failed search as an error, never as no matches', async () => {
    mocks.limit.mockResolvedValue({ data: null, error: { message: 'boom' } });
    render(<CustomerSearchPicker value="" selectedLabel="" onSelect={vi.fn()} ariaLabel="Customer" />);
    type(screen.getByRole('combobox', { name: 'Customer' }), 'Seed');
    expect(await screen.findByRole('alert')).toHaveTextContent('Customer search failed');
    expect(screen.queryByText('No matching active customers')).not.toBeInTheDocument();
    expect(mocks.toast).toHaveBeenCalledWith('error', 'Failed to search Customers');
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('can search inactive customers too and leaves excluded ids out in the database, before the limit', async () => {
    mocks.limit.mockResolvedValue({ data: [{ id: 'other', farm_name: 'Seed Farm Other', is_active: false }], error: null });
    render(<CustomerSearchPicker value="" selectedLabel="" onSelect={vi.fn()} activeOnly={false} excludeIds={['self', 'split-1']} ariaLabel="Customer" />);
    type(screen.getByRole('combobox', { name: 'Customer' }), 'Seed');
    expect(await screen.findByRole('option', { name: /Seed Farm Other/ })).toHaveTextContent('Inactive');
    expect(mocks.not).toHaveBeenCalledWith('id', 'in', '(self,split-1)');
    expect(mocks.eq).not.toHaveBeenCalledWith('is_active', true);
  });

  it('adds no exclusion filter when there is nothing to exclude', async () => {
    mocks.limit.mockResolvedValue({ data: [], error: null });
    render(<CustomerSearchPicker value="" selectedLabel="" onSelect={vi.fn()} excludeIds={[]} ariaLabel="Customer" />);
    type(screen.getByRole('combobox', { name: 'Customer' }), 'Seed');
    await screen.findByText('No matching active customers');
    expect(mocks.not).not.toHaveBeenCalled();
  });

  it('retries the same text after a failed search', async () => {
    mocks.limit
      .mockResolvedValueOnce({ data: null, error: { message: 'offline' } })
      .mockResolvedValueOnce({ data: [{ id: 'c-1', farm_name: 'Seed Farm 1150' }], error: null });
    render(<CustomerSearchPicker value="" selectedLabel="" onSelect={vi.fn()} ariaLabel="Customer" />);
    type(screen.getByRole('combobox', { name: 'Customer' }), '1150');
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: /Seed Farm 1150/ })).toBeInTheDocument();
    expect(mocks.limit).toHaveBeenCalledTimes(2);
  });

  it('shows a search that never answers as failed, not as searching forever', async () => {
    vi.useFakeTimers();
    try {
      mocks.limit.mockReturnValue(new Promise(() => {}));
      render(<CustomerSearchPicker value="" selectedLabel="" onSelect={vi.fn()} ariaLabel="Customer" />);
      type(screen.getByRole('combobox', { name: 'Customer' }), 'Seed');
      // Step until the debounced search has actually been sent, then let the timeout run out.
      for (let i = 0; i < 40 && mocks.limit.mock.calls.length === 0; i += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      }
      expect(mocks.limit).toHaveBeenCalled();
      expect(screen.getByText('Searching...')).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(screen.getByRole('alert')).toHaveTextContent('Customer search failed');
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('finds a record whose name is a single character', async () => {
    mocks.limit.mockResolvedValue({ data: [{ id: 'c-a', farm_name: 'A' }], error: null });
    const onSelect = vi.fn();
    render(<CustomerSearchPicker value="" selectedLabel="" onSelect={onSelect} ariaLabel="Customer" />);
    type(screen.getByRole('combobox', { name: 'Customer' }), 'A');
    fireEvent.click(await screen.findByRole('option', { name: /^A$/ }));
    expect(mocks.or).toHaveBeenCalledWith('farm_name.ilike."%A%",account_number.ilike."%A%"');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'c-a' }));
  });

  it('keeps the previous label when the page refuses a pick', async () => {
    mocks.limit.mockResolvedValue({ data: [{ id: 'c-2', farm_name: 'Seed Farm 0002' }], error: null });
    render(<CustomerSearchPicker value="c-1" selectedLabel="Seed Farm 0001" onSelect={() => false} ariaLabel="Customer" />);
    const input = screen.getByRole('combobox', { name: 'Customer' });
    type(input, '0002');
    fireEvent.click(await screen.findByRole('option', { name: /Seed Farm 0002/ }));
    expect(input).toHaveValue('Seed Farm 0001');
  });

  it('tabbing through a box whose saved label is still empty keeps the selection', () => {
    // The saved customer's name has not loaded yet (or failed to), so the label is empty.
    const onSelect = vi.fn();
    render(<CustomerSearchPicker value="c-1" selectedLabel="" onSelect={onSelect} ariaLabel="Customer" />);
    const input = screen.getByRole('combobox', { name: 'Customer' });
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a saved label that arrives while the box has focus fills it, and leaving keeps the selection (Codex, #1017)', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<CustomerSearchPicker value="c-1" selectedLabel="" onSelect={onSelect} ariaLabel="Customer" />);
    const input = screen.getByRole('combobox', { name: 'Customer' });
    fireEvent.focus(input);
    // The by-id read finishes while the user is still in the box, without having typed.
    rerender(<CustomerSearchPicker value="c-1" selectedLabel="Seed Farm 0001" onSelect={onSelect} ariaLabel="Customer" />);
    expect(input).toHaveValue('Seed Farm 0001');
    fireEvent.blur(input);
    expect(onSelect).not.toHaveBeenCalled();
    expect(input).toHaveValue('Seed Farm 0001');
  });

  it('retyping the same text after a pick never flashes the old "no matches" before the search runs (CodeRabbit, #1017)', async () => {
    mocks.limit.mockResolvedValueOnce({ data: [{ id: 'c-1', farm_name: 'Seed Farm', account_number: 'A1' }], error: null });
    render(<CustomerSearchPicker value="" selectedLabel="" onSelect={vi.fn()} ariaLabel="Customer" />);
    const input = screen.getByRole('combobox', { name: 'Customer' });
    type(input, 'Seed');
    fireEvent.click(await screen.findByRole('option', { name: /Seed Farm/ }));
    mocks.limit.mockReturnValueOnce(new Promise(() => {}));
    type(input, 'Seed');
    expect(screen.queryByText('No matching active customers')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/Searching/)).toBeInTheDocument();
  });

  it('emptying the typed text and leaving the box still clears the selection', () => {
    const onSelect = vi.fn();
    render(<CustomerSearchPicker value="c-1" selectedLabel="Seed Farm 0001" onSelect={onSelect} ariaLabel="Customer" />);
    const input = screen.getByRole('combobox', { name: 'Customer' });
    type(input, '');
    fireEvent.blur(input);
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});

describe('FieldSearchPicker', () => {
  it('searches active fields, optionally one customer\'s, and shows the field\'s customer', async () => {
    mocks.limit.mockResolvedValue({
      data: [{ id: 'f-1150', field_name: 'Seed Field 1150', total_acres: 80, customer: { farm_name: 'Seed Farm 0001' } }],
      error: null,
    });
    const onSelect = vi.fn();
    render(<FieldSearchPicker value="" selectedLabel="" onSelect={onSelect} customerId="c-1" ariaLabel="Field" />);
    type(screen.getByRole('combobox', { name: 'Field' }), 'Field 1150');
    const option = await screen.findByRole('option', { name: /Seed Field 1150/ });
    expect(option).toHaveTextContent('Seed Farm 0001 · 80 ac');
    fireEvent.click(option);
    expect(mocks.from).toHaveBeenCalledWith('fields');
    expect(mocks.eq).toHaveBeenCalledWith('customer_id', 'c-1');
    expect(mocks.or).toHaveBeenCalledWith('field_name.ilike."%Field 1150%"');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'f-1150' }));
  });

  it('drops results for the previous customer as soon as the customer changes', async () => {
    mocks.limit.mockResolvedValueOnce({ data: [{ id: 'f-a', field_name: 'North A' }], error: null });
    const { rerender } = render(<FieldSearchPicker value="" selectedLabel="" onSelect={vi.fn()} customerId="c-a" ariaLabel="Field" />);
    type(screen.getByRole('combobox', { name: 'Field' }), 'North');
    expect(await screen.findByRole('option', { name: /North A/ })).toBeInTheDocument();
    mocks.limit.mockReturnValueOnce(new Promise(() => {}));
    rerender(<FieldSearchPicker value="" selectedLabel="" onSelect={vi.fn()} customerId="c-b" ariaLabel="Field" />);
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByText('Searching...')).toBeInTheDocument();
  });

  it('shows a failed field search as an error', async () => {
    mocks.limit.mockRejectedValue(new Error('network down'));
    render(<FieldSearchPicker value="" selectedLabel="" onSelect={vi.fn()} ariaLabel="Field" />);
    type(screen.getByRole('combobox', { name: 'Field' }), 'North');
    expect(await screen.findByRole('alert')).toHaveTextContent('Field search failed');
  });
});
