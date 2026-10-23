/**
 * PrepayPanels.loadFailed.test.tsx — To-Do 10.5: the Prepay panels say a failed read could
 * not be loaded, with Try again, and never leave one customer's credits under another.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery } from '../../test-utils/inMemoryQuery';

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
vi.mock('../../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../../hooks/useIdempotencyKey', () => ({ useIdempotencyKey: () => ({ getKey: () => 'idem', resetKey: vi.fn() }) }));

import PrepayWorkspacePanel from './PrepayWorkspacePanel';
import PrepaymentManagerPanel from './PrepaymentManagerPanel';

const credit = (id: string, customerId: string, ref: string) => ({
  id, customer_id: customerId, original_amount_cents: 5000, balance_cents: 5000, reference_number: ref,
  bucket_label: null, notes: null, payment_method: 'check', source_type: 'check', created_at: '2026-10-01',
});

beforeEach(() => {
  vi.clearAllMocks();
  H.failing = new Set();
  H.tables = {
    customers: [
      { id: 'c1', farm_name: 'Alpha Farm', is_active: true, prepay_balance_cents: 5000 },
      { id: 'c2', farm_name: 'Bravo Farm', is_active: true, prepay_balance_cents: 5000 },
    ],
    invoices: [],
    prepay_credits: [credit('k1', 'c1', 'CHK-ALPHA'), credit('k2', 'c2', 'CHK-BRAVO')],
  };
});
afterEach(cleanup);

describe('Prepay Workspace', () => {
  it('Try again reloads a customer list that failed', async () => {
    H.failing.add('customers');
    render(<MemoryRouter><PrepayWorkspacePanel /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Customers with prepay balances could not be loaded');

    H.failing.delete('customers');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('option', { name: 'Alpha Farm' })).toBeInTheDocument();
    expect(screen.getByLabelText('Customer')).not.toBeDisabled();
  });
});

describe('Prepay Manager', () => {
  it('a failed list offers Try again, which shows the customers', async () => {
    H.failing.add('customers');
    render(<MemoryRouter><PrepaymentManagerPanel /></MemoryRouter>);
    expect(await screen.findByText('Prepayments could not be loaded')).toBeInTheDocument();

    H.failing.delete('customers');
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByRole('button', { name: /Alpha Farm/ })).toBeInTheDocument();
  });

  it('a malformed bucket-label setting says the labels could not be loaded, without crashing', async () => {
    H.tables.app_settings = [{ setting_key: 'prepay_bucket_labels', setting_value: '{not json' }];
    render(<MemoryRouter><PrepaymentManagerPanel /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /New Check/ }));
    expect(await screen.findByText(/Bucket labels could not be loaded/)).toBeInTheDocument();

    H.tables.app_settings = [{ setting_key: 'prepay_bucket_labels', setting_value: '["Fall","Spring"]' }];
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('option', { name: 'Spring' })).toBeInTheDocument();
    expect(screen.queryByText(/Bucket labels could not be loaded/)).not.toBeInTheDocument();
  });

  it("a failed credits read never leaves the previous customer's credits on screen", async () => {
    render(<MemoryRouter><PrepaymentManagerPanel /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Alpha Farm/ }));
    expect(await screen.findByText('CHK-ALPHA')).toBeInTheDocument();

    H.failing.add('prepay_credits');
    fireEvent.click(screen.getByRole('button', { name: /Bravo Farm/ }));
    expect(await screen.findByText("This customer's credits could not be loaded")).toBeInTheDocument();
    expect(screen.queryByText('CHK-ALPHA')).not.toBeInTheDocument();
    expect(screen.queryByText('No prepay credit records found for this customer')).not.toBeInTheDocument();

    H.failing.delete('prepay_credits');
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('CHK-BRAVO')).toBeInTheDocument();
  });
});
