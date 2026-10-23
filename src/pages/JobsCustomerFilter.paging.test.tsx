/**
 * JobsCustomerFilter.paging.test.tsx — Goal 4 part 3: the Jobs list's Customers filter offers
 * every active customer.
 *
 * The filter's customer list was one request, which the server silently stops at 1,000 rows,
 * so a customer past the cap could not be chosen; a failed read was ignored and the filter
 * just said "No customers". The fake server caps every reply at 1,000 rows like the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery, pagedRpcReply, SERVER_ROW_CAP } from '../test-utils/inMemoryQuery';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failing: new Set<string>(),
  toast: vi.fn(),
}));

// A query whose every method chains and whose answer is a read error.
function failingQuery(): Record<string, unknown> {
  const q: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: 'connection reset' }, count: null });
      }
      return () => q;
    },
  });
  return q;
}

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    ...actual,
    supabase: {
      from: (table: string) => (H.failing.has(table) ? failingQuery() : buildInMemoryQuery(H.tables[table] ?? [])),
      rpc: () => pagedRpcReply({ data: [], error: null }),
    },
  };
});
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ role: 'admin', profile: { id: 'user-1', role: 'admin' } }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
// Each filter picker shows how many options it was given, its last option, and its empty text.
vi.mock('../components/jobs/MultiSelectDropdown', () => ({
  default: ({ label, options, emptyText }: { label: string; options: Array<{ label: string }>; emptyText?: string }) => (
    <div data-testid={`picker-${label}`}>
      <span>{options.length} options</span>
      <span>last: {options[options.length - 1]?.label ?? ''}</span>
      {options.length === 0 && <span>{emptyText}</span>}
    </div>
  ),
}));

import Jobs from './Jobs';

const TOTAL = SERVER_ROW_CAP + 5;
vi.setConfig({ testTimeout: 60_000 });
configure({ asyncUtilTimeout: 20_000 });
const pad = (i: number) => String(i).padStart(4, '0');

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  H.failing = new Set();
  H.tables = {
    customers: [
      ...Array.from({ length: TOTAL }, (_, i) => ({ id: `c${pad(i)}`, farm_name: `Farm ${pad(i)}`, is_active: true })),
      { id: 'c-inactive', farm_name: 'Zz Inactive Farm', is_active: false },
    ],
  };
});
afterEach(cleanup);

describe('Jobs customer filter past the 1,000-row server cap', () => {
  it('offers all 1,005 active customers and no inactive one', async () => {
    render(<MemoryRouter initialEntries={['/jobs']}><Jobs /></MemoryRouter>);
    const picker = await screen.findByTestId('picker-Customers');
    // A read stopped at 1,000 rows offers 1,000 customers and ends at Farm 0999.
    await waitFor(() => expect(picker).toHaveTextContent(`${TOTAL} options`));
    expect(picker).toHaveTextContent(`last: Farm ${pad(TOTAL - 1)}`);
    expect(H.toast).not.toHaveBeenCalledWith('error', 'Failed to load customers for the filter');
  });

  it('a failed read says so instead of an empty "No customers" list', async () => {
    H.failing.add('customers');
    render(<MemoryRouter initialEntries={['/jobs']}><Jobs /></MemoryRouter>);
    const picker = await screen.findByTestId('picker-Customers');
    await waitFor(() => expect(picker).toHaveTextContent('Customers could not be loaded. Reload to try again.'));
    expect(picker).toHaveTextContent('0 options');
    expect(H.toast).toHaveBeenCalledWith('error', 'Failed to load customers for the filter');
  });
});
