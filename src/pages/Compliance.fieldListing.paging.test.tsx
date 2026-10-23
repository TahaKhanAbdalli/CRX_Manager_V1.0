/**
 * Compliance.fieldListing.paging.test.tsx — Goal 4 part 3: the Compliance screen reads every
 * field for the Field Listing / FSA tab and searches every customer for a license.
 *
 * The field listing was one request, which the server silently stops at 1,000 rows, so the
 * Total Fields and Total Acres cards undercounted. The license modal's customer dropdown was
 * one capped read of every customer. The fake server caps every reply at 1,000 rows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery, pagedRpcReply, SERVER_ROW_CAP } from '../test-utils/inMemoryQuery';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failing: new Set<string>(),
  customerSearches: [] as string[],
  customerFilters: [] as string[],
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

// The license customer picker searches by name (an ilike .or() the in-memory table does
// not parse): record each search and its filters, and answer with every customer row.
function customerSearch(rows: Row[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'not']) chain[m] = () => chain;
  chain.eq = (column: string) => { H.customerFilters.push(column); return chain; };
  chain.or = (expr: string) => { H.customerSearches.push(expr); return chain; };
  chain.limit = () => Promise.resolve({ data: rows, error: null });
  return chain;
}

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    ...actual,
    supabase: {
      from: (table: string) => {
        if (H.failing.has(table)) return failingQuery();
        if (table === 'customers') return customerSearch(H.tables.customers ?? []);
        return buildInMemoryQuery(H.tables[table] ?? []);
      },
      rpc: () => pagedRpcReply({ data: [], error: null }),
    },
  };
});
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: 'admin', profile: { id: 'u', full_name: 'Admin', role: 'admin', is_active: true }, user: { id: 'u' }, loading: false }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../hooks/usePageMeta', () => ({ usePageMeta: vi.fn() }));
// Drawing 1,005 real table rows is slow; the table lists only each row's name.
vi.mock('../components/ui/DataTable', () => ({
  default: ({ data }: { data: Array<{ field_name?: string }> }) => (
    <ol data-testid="table-rows">{data.map((row, i) => <li key={i}>{row.field_name ?? ''}</li>)}</ol>
  ),
}));

import Compliance from './Compliance';

const TOTAL = SERVER_ROW_CAP + 5;
vi.setConfig({ testTimeout: 60_000 });
configure({ asyncUtilTimeout: 20_000 });

const field = (i: number) => ({
  id: `f${String(i).padStart(4, '0')}`, field_name: `Field ${i}`, county: null, state: 'IL', total_acres: 10,
  crop_type: null, fsa_farm_number: null, fsa_tract_number: null, fsa_field_number: null, is_active: true,
  customer: { farm_name: 'Acme' },
});

beforeEach(() => {
  vi.clearAllMocks();
  H.failing = new Set();
  H.customerSearches = [];
  H.customerFilters = [];
  H.tables = {
    fields: Array.from({ length: TOTAL }, (_, i) => field(i)),
    customers: [{ id: 'c-old', farm_name: 'Old Farm', is_active: false }],
  };
});
afterEach(cleanup);

const statCard = (label: string) => screen.getByText(label).parentElement!;

describe('Compliance field listing past the 1,000-row server cap', () => {
  it('counts every field and every acre', async () => {
    render(<MemoryRouter><Compliance /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Field Listing/ }));

    // A read stopped at 1,000 rows shows 1,000 fields and 10,000 acres.
    await waitFor(() => expect(statCard('Total Fields')).toHaveTextContent(String(TOTAL)));
    expect(statCard('Total Acres')).toHaveTextContent((TOTAL * 10).toLocaleString());
  });

  it('a failed reload clears the earlier list and its totals', async () => {
    render(<MemoryRouter><Compliance /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Field Listing/ }));
    await waitFor(() => expect(statCard('Total Fields')).toHaveTextContent(String(TOTAL)));

    // Leave the tab and come back while the field read fails.
    H.failing.add('fields');
    fireEvent.click(screen.getByRole('button', { name: /Applicator Licenses/ }));
    fireEvent.click(screen.getByRole('button', { name: /Field Listing/ }));

    expect(await screen.findByText('Fields could not be loaded. Reload to try again.')).toBeInTheDocument();
    expect(screen.queryByText('Total Fields')).not.toBeInTheDocument();
    expect(screen.queryByText('Total Acres')).not.toBeInTheDocument();
    expect(screen.queryByTestId('table-rows')).not.toBeInTheDocument();
    expect(H.toast).toHaveBeenCalledWith('error', 'Failed to load fields');
  });
});

describe('Compliance license customer picker', () => {
  it('searches every customer, inactive included, as the old full list did', async () => {
    render(<MemoryRouter><Compliance /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Add License/ }));

    const picker = await screen.findByRole('combobox', { name: 'License customer' });
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'Old' } });
    fireEvent.click(await screen.findByRole('option', { name: /Old Farm/ }));

    expect(picker).toHaveValue('Old Farm');
    expect(H.customerSearches).toContain('farm_name.ilike."%Old%",account_number.ilike."%Old%"');
    expect(H.customerFilters).not.toContain('is_active');
  });
});
