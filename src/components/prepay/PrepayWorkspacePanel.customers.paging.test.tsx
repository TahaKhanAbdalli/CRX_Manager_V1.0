/**
 * PrepayWorkspacePanel.customers.paging.test.tsx — Goal 4 part 3: the Prepay Workspace's
 * customer dropdown lists every active customer with a prepay balance.
 *
 * The list was one request, which the server silently stops at 1,000 rows, and a failed read
 * was ignored (an empty dropdown). It stays a complete list rather than a search picker because
 * it must keep the "has a prepay balance" condition. The fake server caps replies at 1,000 rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery, SERVER_ROW_CAP } from '../../test-utils/inMemoryQuery';

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

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return {
    ...actual,
    supabase: {
      from: (table: string) => (H.failing.has(table) ? failingQuery() : buildInMemoryQuery(H.tables[table] ?? [])),
      rpc: vi.fn(),
    },
  };
});
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ role: 'admin', profile: { id: 'user-1', role: 'admin' } }) }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../hooks/useIdempotencyKey', () => ({ useIdempotencyKey: () => ({ getKey: () => 'idem', resetKey: vi.fn() }) }));

import PrepayWorkspacePanel from './PrepayWorkspacePanel';

const TOTAL = SERVER_ROW_CAP + 5;
const pad = (i: number) => String(i).padStart(4, '0');

beforeEach(() => {
  vi.clearAllMocks();
  H.failing = new Set();
  H.tables = {
    customers: [
      ...Array.from({ length: TOTAL }, (_, i) => ({ id: `c${pad(i)}`, farm_name: `Farm ${pad(i)}`, is_active: true, prepay_balance_cents: 100 })),
      { id: 'c-zero', farm_name: 'No Balance Farm', is_active: true, prepay_balance_cents: 0 },
      { id: 'c-inactive', farm_name: 'Inactive Farm', is_active: false, prepay_balance_cents: 100 },
    ],
  };
});
afterEach(cleanup);

const renderPanel = () => render(<MemoryRouter initialEntries={['/prepay?tab=workspace']}><PrepayWorkspacePanel /></MemoryRouter>);

describe('Prepay Workspace customer list', () => {
  it('lists every active customer with a prepay balance, past the 1,000-row cap', async () => {
    renderPanel();
    const select = screen.getByLabelText('Customer');
    // A read stopped at 1,000 rows ends at Farm 0999.
    await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(TOTAL + 1));
    expect(screen.getByRole('option', { name: `Farm ${pad(TOTAL - 1)}` })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'No Balance Farm' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Inactive Farm' })).not.toBeInTheDocument();
  });

  it('a failed read shows an error and disables the dropdown instead of an empty list', async () => {
    H.failing.add('customers');
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('Customers with prepay balances could not be loaded');
    expect(screen.getByLabelText('Customer')).toBeDisabled();
    expect(H.toast).toHaveBeenCalledWith('error', 'Failed to load customers with prepay balances');
  });
});
