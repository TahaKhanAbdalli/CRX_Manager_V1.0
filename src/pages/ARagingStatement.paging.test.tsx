/**
 * ARagingStatement.paging.test.tsx — Goal 4 part 2b (M57): the AR Aging screen's Customer
 * Statement shows every row of a long statement, and an error rather than a statement whose
 * running balance does not add up.
 *
 * The screen called get_customer_statement in one request, which the server silently stops
 * at 1,000 rows: a longer statement lost its last rows and showed the wrong ending balance.
 * The fake server below caps every function reply at 1,000 rows like the real one, so these
 * tests fail against the old screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery, pagedRpcReply, SERVER_ROW_CAP } from '../test-utils/inMemoryQuery';
import type { CustomerStatementRow } from '../types';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  functions: {} as Record<string, unknown>,
  toast: vi.fn(),
  customerSearches: [] as string[],
  customerFilters: [] as string[],
}));

// The statement's customer picker searches by name (an ilike .or() the in-memory
// table does not parse): record each search and answer with every customer row.
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
      from: (table: string) => (table === 'customers'
        ? customerSearch(H.tables.customers ?? [])
        : buildInMemoryQuery(H.tables[table] ?? [])),
      rpc: (name: string) => pagedRpcReply({ data: H.functions[name] ?? [], error: null }),
    },
  };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin', full_name: 'Admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
// Drawing 1,205 real table rows is slow; the table lists only each row's reference.
vi.mock('../components/ui/DataTable', () => ({
  default: ({ data }: { data: Array<{ reference_number?: string }> }) => (
    <ol data-testid="table-rows">{data.map((row, i) => <li key={i}>{row.reference_number ?? ''}</li>)}</ol>
  ),
}));

import ARaging from './ARaging';

const TOTAL = SERVER_ROW_CAP + 205;
vi.setConfig({ testTimeout: 120_000 });
configure({ asyncUtilTimeout: 30_000 });
const pad = (i: number) => String(i).padStart(4, '0');

// $1.00 per row, running balance correct throughout.
const statement = (count: number): CustomerStatementRow[] => Array.from({ length: count }, (_, i) => ({
  transaction_date: '2026-09-01', transaction_type: 'invoice', reference_number: `INV-${pad(i)}`,
  description: `Row ${pad(i)}`, amount_cents: 100, running_balance: 100 * (i + 1),
}));

beforeEach(() => {
  vi.clearAllMocks();
  H.tables = { customers: [{ id: 'c1', farm_name: 'Big Farm' }] };
  H.functions = {};
  H.customerSearches = [];
  H.customerFilters = [];
});
afterEach(cleanup);

async function loadStatement() {
  render(<MemoryRouter><ARaging /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: 'Customer Statement' }));
  const picker = await screen.findByRole('combobox', { name: 'Statement customer' });
  fireEvent.focus(picker);
  fireEvent.change(picker, { target: { value: 'Big' } });
  fireEvent.click(await screen.findByRole('option', { name: /Big Farm/ }));
  fireEvent.click(screen.getByRole('button', { name: /Load Transactions/ }));
}

describe('AR Aging statement customer picker (Goal 4 part 3)', () => {
  it('searches every customer, inactive included, instead of loading a capped list', async () => {
    H.functions.get_customer_statement = statement(3);
    await loadStatement();

    await waitFor(() => expect(screen.getByText('Ending Balance').parentElement!).toHaveTextContent('$3.00'));
    expect(H.customerSearches).toContain('farm_name.ilike."%Big%",account_number.ilike."%Big%"');
    // The old list read every customer, so the search keeps inactive ones too.
    expect(H.customerFilters).not.toContain('is_active');
    expect(screen.getByRole('combobox', { name: 'Statement customer' })).toHaveValue('Big Farm');
  });
});

describe('AR Aging customer statement past the 1,000-row server cap (M57)', () => {
  it('shows all 1,205 rows in order and the true ending balance', async () => {
    H.functions.get_customer_statement = statement(TOTAL);
    await loadStatement();

    // A read stopped at 1,000 rows ends at $1,000.00.
    await waitFor(() => expect(screen.getByText('Ending Balance').parentElement!).toHaveTextContent('$1,205.00'));
    const tables = screen.getAllByTestId('table-rows');
    const shown = [...tables[tables.length - 1].querySelectorAll('li')].map((li) => li.textContent);
    expect(shown).toEqual(statement(TOTAL).map((r) => r.reference_number));
    expect(H.toast).not.toHaveBeenCalledWith('error', expect.anything());
  });

  it('a statement whose running balance does not add up is an error, not a statement', async () => {
    // Row 1,100 missing on every read: the chain breaks after it.
    H.functions.get_customer_statement = statement(TOTAL).filter((_, i) => i !== 1100);
    await loadStatement();

    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', 'Failed to load customer statement'));
    expect(screen.queryByText('Ending Balance')).not.toBeInTheDocument();
  });
});
