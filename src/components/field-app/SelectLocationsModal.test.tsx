import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const toast = vi.fn();
let fieldReply: { data: unknown[] | null; error: { message: string } | null; count?: number | null } = {
  data: [], error: null, count: 0,
};
// When set, the fake server holds these rows and answers each .range(from, to) with that
// slice (at most 1,000 rows, like the real server's cap) plus the full count.
let fieldRows: unknown[] | null = null;
const rangeCalls: Array<[number, number]> = [];
const tables: string[] = [];

function chain() {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  let slice: [number, number] | null = null;
  for (const m of ['select', 'eq', 'order', 'or', 'not', 'limit']) builder[m] = vi.fn(self);
  builder.range = vi.fn((from: number, to: number) => {
    rangeCalls.push([from, to]);
    slice = [from, to];
    return builder;
  });
  builder.then = vi.fn((resolve: (v: unknown) => void) => {
    const reply = fieldRows && slice
      ? { data: fieldRows.slice(slice[0], Math.min(slice[1], slice[0] + 999) + 1), error: null, count: fieldRows.length }
      : fieldReply;
    Promise.resolve(reply).then(resolve);
    return builder;
  });
  return builder;
}

vi.mock('../../lib/db', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      tables.push(table);
      return chain();
    }),
  },
}));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('../map/CRXMap', () => ({ default: ({ children }: { children?: ReactNode }) => <div>{children}</div> }));
vi.mock('../map/FieldBoundaryLayer', () => ({ default: () => <div /> }));

import SelectLocationsModal from './SelectLocationsModal';

const field = {
  id: 'field-1',
  field_name: 'North 40',
  customer_id: 'cust-1',
  total_acres: 40,
  crop_type: 'Corn',
  customer: { farm_name: 'Smith Farm' },
  billing_defaults: [],
};

describe('SelectLocationsModal field list', () => {
  beforeEach(() => {
    toast.mockReset();
    rangeCalls.length = 0;
    tables.length = 0;
    fieldRows = null;
  });

  it('reads every field page by page and loads no customer list', async () => {
    // 1,005 fields: one capped read would stop at 1,000 and miss the last five.
    fieldRows = Array.from({ length: 1005 }, (_, i) => ({
      ...field,
      id: `field-${i + 1}`,
      field_name: `Field #${String(i + 1).padStart(4, '0')}`,
    }));
    // A stable list: the modal reloads whenever initialSelectedIds is a new array.
    const initialSelectedIds: string[] = [];
    render(<SelectLocationsModal isOpen onClose={vi.fn()} onSelect={vi.fn()} initialSelectedIds={initialSelectedIds} />);

    // Field #1,003 lives only on the second page.
    expect(await screen.findByText('Field #1003', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByText('Field #0001')).toBeInTheDocument();
    expect(rangeCalls[0]).toEqual([0, 999]);
    expect(rangeCalls.some(([from]) => from > 0)).toBe(true);
    expect(tables).not.toContain('customers');
    expect(screen.getByRole('combobox', { name: 'Filter by customer' })).toHaveAttribute('placeholder', 'All Customers');
  });

  it('a failed read after a successful one leaves no stale fields and blocks Select', async () => {
    fieldReply = { data: [field], error: null, count: 1 };
    const props = { onClose: vi.fn(), onSelect: vi.fn(), initialSelectedIds: ['field-1'] };
    const { rerender } = render(<SelectLocationsModal isOpen {...props} />);
    expect(await screen.findByText('North 40')).toBeInTheDocument();

    fieldReply = { data: null, error: { message: 'boom' }, count: null };
    rerender(<SelectLocationsModal isOpen={false} {...props} />);
    rerender(<SelectLocationsModal isOpen {...props} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Fields could not be loaded');
    expect(screen.queryByText('North 40')).not.toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith('error', 'Failed to load fields');
    await waitFor(() => expect(screen.getByRole('button', { name: /^Select/ })).toBeDisabled());
  });
});
