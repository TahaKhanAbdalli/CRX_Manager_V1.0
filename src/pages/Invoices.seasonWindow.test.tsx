/**
 * Invoices.seasonWindow.test.tsx — the Chemical Sales list after the Oct 1 rollover.
 *
 * Bug (2026-10-09): the list only fetched invoices created in the CURRENT season, so on
 * Oct 1 every prior-season draft, unposted, posted-unpaid and overdue invoice vanished
 * from the list. The rule now: an OPEN invoice shows whatever season it is in (labelled
 * with its season), and only CLOSED invoices (paid / voided / cancelled) stay
 * season-windowed. The supabase mock applies the page's real filters to an in-memory
 * row set, so this proves which rows the query actually returns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery } from '../test-utils/inMemoryQuery';
import { POST_RECHECK_FAILED_MESSAGE } from '../lib/invoicePostVersion';

const { mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({ mockFrom: vi.fn(), mockRpc: vi.fn(), mockToast: vi.fn() }));

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  // supabaseUntyped carries the posting-version readers and the versioned post.
  const client = { from: mockFrom, rpc: mockRpc };
  return { ...actual, supabase: client, supabaseUntyped: client };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

import Invoices from './Invoices';
import { Sentry } from '../lib/sentry';

function invoice(overrides: Record<string, unknown>) {
  return {
    id: overrides.invoice_number,
    invoice_type: 'chemical_sale',
    customer_id: 'cust-1',
    customer: { farm_name: 'Test Farm' },
    salesman_id: null,
    order_id: null,
    deleted_at: null,
    updated_at: '2026-10-05T10:00:00+00:00',
    total_amount_cents: 10000,
    balance_cents: 10000,
    is_quick_delivery: false,
    ...overrides,
  };
}

// The posting version the readers return (a 32-character lowercase md5).
const POST_VERSION = '0123456789abcdef0123456789abcdef';

function rpcResult(data: unknown, error: unknown = null) {
  const result = Promise.resolve({ data, error });
  return Object.assign(result, { throwOnError: () => (error ? Promise.reject(error) : result) });
}

/** Readers return POST_VERSION; every other RPC (the posts) succeeds with no data. */
function answerRpc(name: string) {
  if (name === 'get_invoice_post_version' || name === 'get_invoice_group_post_version') {
    return rpcResult(POST_VERSION);
  }
  return rpcResult(null);
}

// "Today" is 2026-10-09, so the current season is 2027 (Oct 1 2026 – Sep 30 2027).
const ROWS = [
  invoice({ invoice_number: 'OLD-DRAFT', status: 'draft', season: 2026, invoice_date: '2026-05-06', created_at: '2026-05-06T15:00:00+00:00' }),
  invoice({ invoice_number: 'OLD-UNPOSTED', status: 'unposted', season: 2026, invoice_date: '2026-06-01', created_at: '2026-06-01T15:00:00+00:00' }),
  invoice({ invoice_number: 'OLD-POSTED', status: 'posted', season: 2026, invoice_date: '2026-07-01', created_at: '2026-07-01T15:00:00+00:00' }),
  invoice({ invoice_number: 'OLD-OVERDUE', status: 'overdue', season: 2026, invoice_date: '2026-04-08', created_at: '2026-08-18T15:00:00+00:00' }),
  invoice({ invoice_number: 'OLD-PAID', status: 'paid', season: 2026, balance_cents: 0, invoice_date: '2026-07-17', created_at: '2026-07-17T15:00:00+00:00' }),
  invoice({ invoice_number: 'OLD-VOIDED', status: 'voided', season: 2026, balance_cents: 0, invoice_date: '2026-07-18', created_at: '2026-07-18T15:00:00+00:00' }),
  invoice({ invoice_number: 'NEW-PAID', status: 'paid', season: 2027, balance_cents: 0, invoice_date: '2026-10-05', created_at: '2026-10-05T15:00:00+00:00' }),
  invoice({ invoice_number: 'NEW-DRAFT', status: 'draft', season: 2027, invoice_date: '2026-10-06', created_at: '2026-10-06T15:00:00+00:00' }),
  // Field invoices never belong on the Chemical Sales list, whatever their status.
  invoice({ invoice_number: 'OLD-FIELD', invoice_type: 'field_application', status: 'unposted', season: 2026, invoice_date: '2026-08-08', created_at: '2026-08-08T15:00:00+00:00' }),
];

describe('Invoices list — season window after the Oct 1 rollover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T12:00:00'));
    mockFrom.mockImplementation((table: string) =>
      buildInMemoryQuery(table === 'invoices' ? ROWS : []));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps every prior-season open invoice on the list, labelled with its season', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);

    for (const number of ['OLD-DRAFT', 'OLD-UNPOSTED', 'OLD-POSTED', 'OLD-OVERDUE', 'NEW-DRAFT', 'NEW-PAID']) {
      await waitFor(() => expect(screen.getAllByText(number).length).toBeGreaterThan(0));
    }
    // Prior-season rows carry a visible season label; current-season rows do not need one.
    expect(screen.getAllByText('Season 2026').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('Season 2027')).not.toBeInTheDocument();
  });

  it('still season-windows closed invoices and keeps field invoices off this list', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);

    await waitFor(() => expect(screen.getAllByText('NEW-PAID').length).toBeGreaterThan(0));
    expect(screen.queryByText('OLD-PAID')).not.toBeInTheDocument();
    expect(screen.queryByText('OLD-VOIDED')).not.toBeInTheDocument();
    expect(screen.queryByText('OLD-FIELD')).not.toBeInTheDocument();
  });

  it('counts prior-season drafts in the Unposted card', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);

    // OLD-DRAFT + OLD-UNPOSTED + NEW-DRAFT are all still waiting to be posted.
    const card = await screen.findByRole('button', { name: 'Show invoices ready to post' });
    await waitFor(() => expect(card).toHaveTextContent('3'));
  });

  it('counts overdue invoices in the Posted Total and Outstanding cards, and says older open invoices are included', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);

    // OLD-POSTED ($100.00) + OLD-OVERDUE ($100.00): overdue is a posted invoice past due.
    const outstanding = (await screen.findByText('unpaid balance on posted and overdue invoices')).parentElement!;
    await waitFor(() => expect(outstanding).toHaveTextContent('$200.00'));
    const postedTotal = screen.getByText(/posted invoices \(including overdue\)/).parentElement!;
    expect(postedTotal).toHaveTextContent('$200.00');
    expect(postedTotal).toHaveTextContent('2 posted invoices (including overdue)');
    expect(screen.getByText(/plus any invoice from an earlier season that is still unposted\s+or unpaid/)).toBeInTheDocument();
  });

  it('Select All picks only this season, so Select All + Post posts no prior-season draft', async () => {
    mockRpc.mockImplementation(answerRpc);
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('OLD-DRAFT').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    // Only NEW-DRAFT (this season) is postable / deletable; the Season 2026 draft,
    // unposted and posted / overdue invoices are not selected, so no Void button either.
    expect(screen.getByRole('button', { name: /Post 1 Selected/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete 1/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Void \d+ Selected/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Post 1 Selected/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/not from this season/)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post 1' }));
    await waitFor(() => expect(mockRpc.mock.calls.filter(([name]) => name === 'post_invoice')).toHaveLength(1));
    // The post carries the posting version read for that invoice when the list LOADED (every
    // postable row's version is read then: OLD-DRAFT, OLD-UNPOSTED, NEW-DRAFT), with a key.
    const beforePost = mockRpc.mock.calls.slice(0, mockRpc.mock.calls.findIndex(([name]) => name === 'post_invoice'));
    expect(beforePost.filter(([name]) => name === 'get_invoice_post_version').map(([, args]) => args.p_invoice_ids[0]).sort())
      .toEqual(['NEW-DRAFT', 'OLD-DRAFT', 'OLD-UNPOSTED']);
    expect(mockRpc.mock.calls.filter(([name]) => name === 'post_invoice')[0][1]).toEqual({
      p_invoice_id: 'NEW-DRAFT',
      p_idempotency_key: expect.any(String),
      p_expected_version: POST_VERSION,
    });
  });

  it('a ticked split invoice posts its whole group with the group posting version', async () => {
    const GROUP_VERSION = 'fedcba9876543210fedcba9876543210';
    mockFrom.mockImplementation((table: string) =>
      buildInMemoryQuery(table === 'invoices'
        ? [
          ...ROWS,
          invoice({ invoice_number: 'NEW-SPLIT-A', status: 'draft', season: 2027, invoice_group_id: 'grp-1', invoice_date: '2026-10-07', created_at: '2026-10-07T15:00:00+00:00' }),
          invoice({ invoice_number: 'NEW-SPLIT-B', status: 'draft', season: 2027, invoice_group_id: 'grp-1', customer_id: 'cust-2', invoice_date: '2026-10-07', created_at: '2026-10-07T15:00:00+00:00' }),
        ]
        : []));
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_invoice_group_post_version') return rpcResult(GROUP_VERSION);
      if (name === 'post_invoice_group') return rpcResult({ posted: 2 });
      return answerRpc(name);
    });
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('NEW-SPLIT-A').length).toBeGreaterThan(0));

    tickRow('NEW-SPLIT-A');
    fireEvent.click(screen.getByRole('button', { name: /Post 1 Selected/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post selected + full split groups' }));

    await waitFor(() => expect(mockRpc.mock.calls.filter(([name]) => name === 'post_invoice_group')).toHaveLength(1));
    // Read once when the list loaded (the reload after the post reads again).
    const beforeGroupPost = mockRpc.mock.calls.slice(0, mockRpc.mock.calls.findIndex(([name]) => name === 'post_invoice_group'));
    expect(beforeGroupPost.filter(([name]) => name === 'get_invoice_group_post_version').map(([, args]) => args))
      .toEqual([{ p_invoice_group_id: 'grp-1' }]);
    expect(mockRpc.mock.calls.filter(([name]) => name === 'post_invoice_group')[0][1]).toEqual({
      p_invoice_group_id: 'grp-1',
      p_performed_by: 'user-1',
      p_idempotency_key: expect.any(String),
      p_expected_version: GROUP_VERSION,
    });
    expect(mockRpc.mock.calls.some(([name]) => name === 'post_invoice')).toBe(false);
  });

  // Codex Luna HIGH (2026-10-12): Post Selected posted whatever the invoice held at click time.
  // Another admin changes NEW-DRAFT from $100.00 to $70.00 after this list loaded; at click the
  // list re-reads the rows it showed, sees the change, posts nothing and reloads.
  it('an invoice changed since the list loaded is not posted; the list reloads and says so', async () => {
    let rows = ROWS;
    mockFrom.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? rows : []));
    mockRpc.mockImplementation(answerRpc);
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('NEW-DRAFT').length).toBeGreaterThan(0));
    await waitFor(() => expect(mockRpc.mock.calls.filter(([name]) => name === 'get_invoice_post_version')).toHaveLength(3));
    const listLoads = () => mockFrom.mock.calls.filter(([table]) => table === 'invoices').length;

    tickRow('NEW-DRAFT');
    fireEvent.click(screen.getByRole('button', { name: /Post 1 Selected/ }));
    const dialog = await screen.findByRole('dialog');
    // The change lands after the list loaded and bound its versions.
    rows = ROWS.map((row) => (row.id === 'NEW-DRAFT'
      ? { ...row, total_amount_cents: 7000, balance_cents: 7000, updated_at: '2026-10-05T11:00:00+00:00' }
      : row));
    const loadsBeforePost = listLoads();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post 1' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      '1 invoice(s) changed since this list loaded (NEW-DRAFT) — nothing was posted. The list is being refreshed; check them and post again.',
    ));
    expect(mockRpc.mock.calls.some(([name]) => name === 'post_invoice' || name === 'post_invoice_group')).toBe(false);
    // The re-read, then the reload of the list itself.
    await waitFor(() => expect(listLoads()).toBeGreaterThanOrEqual(loadsBeforePost + 2));
    expect(mockToast).not.toHaveBeenCalledWith('success', expect.anything());
    // A concurrent edit is an expected outcome, not a fault: no Sentry error.
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // Codex Luna round 1 HIGH: the versions were read right AFTER the rows loaded, so a change
  // landing in between was inside the version AND in the click-time comparison's baseline, and
  // posted. Now the list re-reads its rows after reading the versions; here NEW-DRAFT is being
  // edited the whole time (each version read lands another save), so no load can bind it. The
  // list reloads once by itself, then Post posts nothing, says the list changed and reloads.
  it('when the rows change while the list binds its versions, the list reloads once and Post posts nothing', async () => {
    let rows = ROWS;
    let saves = 0;
    const listQueries: string[] = [];
    mockFrom.mockImplementation((table: string) => {
      const query = buildInMemoryQuery(table === 'invoices' ? rows : []);
      const select = query.select as (columns?: string, options?: { count?: string; head?: boolean }) => unknown;
      query.select = vi.fn((columns?: string, options?: { count?: string; head?: boolean }) => {
        if (table === 'invoices' && columns?.startsWith('*')) listQueries.push(columns);
        return select(columns, options);
      });
      return query;
    });
    mockRpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === 'get_invoice_post_version' && (args.p_invoice_ids as string[])[0] === 'NEW-DRAFT') {
        saves += 1;
        rows = ROWS.map((row) => (row.id === 'NEW-DRAFT'
          ? { ...row, updated_at: `2026-10-05T11:${String(saves).padStart(2, '0')}:00+00:00` }
          : row));
      }
      return answerRpc(name);
    });
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('NEW-DRAFT').length).toBeGreaterThan(0));
    // The first load could not bind NEW-DRAFT: the list reloaded once by itself, and only once.
    await waitFor(() => expect(listQueries).toHaveLength(2));
    await waitFor(() => expect(saves).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listQueries).toHaveLength(2);

    tickRow('NEW-DRAFT');
    fireEvent.click(screen.getByRole('button', { name: /Post 1 Selected/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post 1' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      '1 invoice(s) changed since this list loaded (NEW-DRAFT) — nothing was posted. The list is being refreshed; check them and post again.',
    ));
    expect(mockRpc.mock.calls.some(([name]) => name === 'post_invoice' || name === 'post_invoice_group')).toBe(false);
    await waitFor(() => expect(listQueries.length).toBeGreaterThanOrEqual(3));
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // Review round 1 (2026-10-12): the version was read at CLICK time, so a change the list never
  // shows (the customer's payment terms, a line edit that leaves the total alone) made between
  // load and click was folded into the version and posted. Now the post carries the version read
  // when the list LOADED: the database refuses it, only that invoice is named, and the retry
  // after the reload reuses the same idempotency key.
  it('a change the list does not show is refused by the database for that invoice only; the retry reuses its key', async () => {
    const LOAD_VERSION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const LATER_VERSION = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    let databaseVersion = LOAD_VERSION;
    mockRpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === 'get_invoice_post_version') return rpcResult(databaseVersion);
      if (name === 'post_invoice') {
        if (args.p_expected_version !== databaseVersion) {
          return rpcResult(null, { message: 'INVOICE_CHANGED_SINCE_REVIEW: invoice NEW-DRAFT changed since it was reviewed' });
        }
        return rpcResult(null);
      }
      return answerRpc(name);
    });
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('NEW-DRAFT').length).toBeGreaterThan(0));
    await waitFor(() => expect(mockRpc.mock.calls.filter(([name]) => name === 'get_invoice_post_version')).toHaveLength(3));

    // After the load, a rep changes the customer's terms: the header row is unchanged.
    databaseVersion = LATER_VERSION;
    tickRow('NEW-DRAFT');
    fireEvent.click(screen.getByRole('button', { name: /Post 1 Selected/ }));
    let dialog = await screen.findByRole('dialog');
    const readsBeforeClick = mockRpc.mock.calls.filter(([name]) => name === 'get_invoice_post_version').length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post 1' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      'Completed 0/1 posting action(s). Failed: NEW-DRAFT: changed since this screen loaded, so it was not posted — check it and post again',
    ));
    const posts = () => mockRpc.mock.calls.filter(([name]) => name === 'post_invoice').map(([, args]) => args);
    expect(posts()).toHaveLength(1);
    expect(posts()[0].p_expected_version).toBe(LOAD_VERSION);
    // The click itself read no version: the reload after the run read the new ones.
    expect(mockRpc.mock.calls.slice(0, mockRpc.mock.calls.findIndex(([name]) => name === 'post_invoice'))
      .filter(([name]) => name === 'get_invoice_post_version')).toHaveLength(readsBeforeClick);

    // The admin checks the reloaded list and posts again: same key, the reloaded version.
    await waitFor(() => expect(mockRpc.mock.calls.filter(([name]) => name === 'get_invoice_post_version').length).toBeGreaterThanOrEqual(readsBeforeClick + 3));
    await waitFor(() => expect(screen.getByRole('button', { name: /Post 1 Selected/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Post 1 Selected/ }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post 1' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]).toEqual({ ...posts()[0], p_expected_version: LATER_VERSION });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', expect.anything()));
  });

  it('when a posting version could not be read at load, nothing is posted and the list says so', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_invoice_post_version') return rpcResult(null, { message: 'network down' });
      return answerRpc(name);
    });
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('NEW-DRAFT').length).toBeGreaterThan(0));

    tickRow('NEW-DRAFT');
    fireEvent.click(screen.getByRole('button', { name: /Post 1 Selected/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post 1' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', POST_RECHECK_FAILED_MESSAGE));
    expect(mockRpc.mock.calls.some(([name]) => name === 'post_invoice' || name === 'post_invoice_group')).toBe(false);
  });

  it('a split-group member added after the list loaded (not on the list) stops the group post', async () => {
    let rows = [
      ...ROWS,
      invoice({ invoice_number: 'NEW-SPLIT-A', status: 'draft', season: 2027, invoice_group_id: 'grp-1', invoice_date: '2026-10-07', created_at: '2026-10-07T15:00:00+00:00' }),
    ];
    mockFrom.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? rows : []));
    mockRpc.mockImplementation(answerRpc);
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('NEW-SPLIT-A').length).toBeGreaterThan(0));
    await waitFor(() => expect(mockRpc.mock.calls.some(([name]) => name === 'get_invoice_group_post_version')).toBe(true));

    tickRow('NEW-SPLIT-A');
    fireEvent.click(screen.getByRole('button', { name: /Post 1 Selected/ }));
    const dialog = await screen.findByRole('dialog');
    // A field re-save adds a member to the group after the load.
    rows = [...rows, invoice({ invoice_number: 'NEW-SPLIT-B', status: 'draft', season: 2027, invoice_group_id: 'grp-1', customer_id: 'cust-2', invoice_date: '2026-10-07', created_at: '2026-10-07T15:00:00+00:00' })];
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post selected + full split groups' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      '1 invoice(s) changed since this list loaded — nothing was posted. The list is being refreshed; check them and post again.',
    ));
    expect(mockRpc.mock.calls.some(([name]) => name === 'post_invoice_group' || name === 'post_invoice')).toBe(false);
  });

  // Regression (2026-10-09 final review): the toggle compared HOW MANY rows were
  // selected with how many this-season rows there were, not WHICH rows. A hand-ticked
  // older row skews the count, so the button could clear when it said Select All, or
  // select when it said Deselect All.
  const toggleButton = () => screen.getByRole('button', { name: /^(Select|Deselect) All$/ });
  const tickRow = (number: string) => {
    const row = screen.getAllByText(number).map((el) => el.closest('tr')).find(Boolean)!;
    fireEvent.click(within(row).getByRole('checkbox'));
  };

  const rowCheckbox = (number: string) => {
    const row = screen.getAllByText(number).map((el) => el.closest('tr')).find(Boolean)!;
    return within(row).getByRole('checkbox');
  };
  const statusFilter = () => screen.getByRole('combobox', { name: 'Filter by status' });
  const postSucceeds = answerRpc;
  const postedIds = () =>
    mockRpc.mock.calls.filter(([name]) => name === 'post_invoice').map(([, args]) => args.p_invoice_id);

  it('with an older-season invoice ticked by hand, Select All replaces it with exactly this season in view', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('OLD-DRAFT').length).toBeGreaterThan(0));

    tickRow('OLD-DRAFT');
    // One row selected, but this season's NEW-DRAFT is not: the button must offer to
    // select, and must not clear.
    expect(toggleButton()).toHaveTextContent('Select All');
    fireEvent.click(toggleButton());

    // Select All selects exactly this season's rows in view; it does not carry the
    // hand-ticked older-season row along.
    expect(screen.getByRole('button', { name: /Post 1 Selected/ })).toBeInTheDocument();
    expect(rowCheckbox('NEW-DRAFT')).toBeChecked();
    expect(rowCheckbox('OLD-DRAFT')).not.toBeChecked();
    expect(toggleButton()).toHaveTextContent('Deselect All');
  });

  // Regression (2026-10-09 review of the id-based toggle): Select All unioned this
  // season's rows into the EXISTING selection, so a row ticked earlier and then hidden
  // by a filter was still selected, counted and posted although it was not on screen.
  it('a row ticked and then hidden by a filter is not carried into Select All + Post', async () => {
    mockRpc.mockImplementation(postSucceeds);
    mockFrom.mockImplementation((table: string) =>
      buildInMemoryQuery(table === 'invoices'
        ? [
          ...ROWS,
          invoice({ invoice_number: 'NEW-UNPOSTED', status: 'unposted', season: 2027, invoice_date: '2026-10-07', created_at: '2026-10-07T15:00:00+00:00' }),
        ]
        : []));
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('NEW-UNPOSTED').length).toBeGreaterThan(0));

    tickRow('OLD-DRAFT');
    // Unposted only: OLD-UNPOSTED (Season 2026) and NEW-UNPOSTED are in view; the
    // ticked OLD-DRAFT is hidden.
    fireEvent.change(statusFilter(), { target: { value: 'unposted' } });
    expect(screen.queryByText('OLD-DRAFT')).not.toBeInTheDocument();
    fireEvent.click(toggleButton());

    // The one this-season row in view, and nothing else.
    expect(screen.getByRole('button', { name: /Post 1 Selected/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Post 1 Selected/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post 1' }));
    await waitFor(() => expect(postedIds()).toHaveLength(1));
    expect(postedIds()).toEqual(['NEW-UNPOSTED']);
  });

  // Regression: under a filter with no selectable rows, neither the toggle nor Clear
  // selection rendered, yet the Print bulk button still acted on the hidden selection.
  it('a leftover selection under a filter with no selectable rows is cleared, so no bulk button acts on it', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('NEW-DRAFT').length).toBeGreaterThan(0));

    tickRow('NEW-DRAFT');
    expect(screen.getByRole('button', { name: /Print 1 Selected/ })).toBeInTheDocument();

    // Paid only: NEW-PAID is in view, and a paid invoice has no checkbox.
    fireEvent.change(statusFilter(), { target: { value: 'paid' } });
    expect(screen.getAllByText('NEW-PAID').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Print \d+ Selected/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /(Post|Void) \d+ Selected/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete \d+$/ })).not.toBeInTheDocument();

    // Back to every status: the hidden selection was dropped, not just hidden.
    fireEvent.change(statusFilter(), { target: { value: '' } });
    expect(rowCheckbox('NEW-DRAFT')).not.toBeChecked();
    expect(screen.queryByRole('button', { name: /Print \d+ Selected/ })).not.toBeInTheDocument();
  });

  it('a ticked row hidden by the search box is dropped too, so no bulk button acts on it', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('NEW-DRAFT').length).toBeGreaterThan(0));

    tickRow('NEW-DRAFT');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search invoices...' }), { target: { value: 'OLD-DRAFT' } });
    expect(screen.queryByText('NEW-DRAFT')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /(Post|Print) \d+ Selected/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search invoices...' }), { target: { value: '' } });
    expect(rowCheckbox('NEW-DRAFT')).not.toBeChecked();
  });

  it('offers Clear selection whenever something on screen is selected, even when Deselect All shows', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('OLD-DRAFT').length).toBeGreaterThan(0));

    tickRow('OLD-DRAFT');
    tickRow('NEW-DRAFT');
    expect(toggleButton()).toHaveTextContent('Deselect All');
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('button', { name: /(Post|Print) \d+ Selected/ })).not.toBeInTheDocument();
  });

  // Regression: "is anything selected" and the Print count used the raw selection,
  // which can hold an id the list no longer loads (deleted elsewhere, row cap shift).
  it('counts only loaded invoices: a failed post re-selecting a row the reload no longer returns drops it', async () => {
    let rows = ROWS;
    mockFrom.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? rows : []));
    mockRpc.mockImplementation((name: string) => {
      // The review passes; then NEW-DRAFT is deleted elsewhere while this batch posts, and
      // both posts fail.
      if (name !== 'post_invoice') return answerRpc(name);
      rows = ROWS.filter((row) => row.id !== 'NEW-DRAFT');
      const failed = Promise.resolve({ data: null, error: { message: 'post failed' } });
      return Object.assign(failed, { throwOnError: () => Promise.reject(new Error('post failed')) });
    });
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('NEW-DRAFT').length).toBeGreaterThan(0));

    tickRow('OLD-DRAFT');
    tickRow('NEW-DRAFT');
    fireEvent.click(screen.getByRole('button', { name: /Post 2 Selected/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Post 2' }));

    await waitFor(() => expect(postedIds()).toHaveLength(2));
    // The reload has landed: OLD-DRAFT is back on screen and NEW-DRAFT is gone.
    await waitFor(() => {
      expect(screen.getAllByText('OLD-DRAFT').length).toBeGreaterThan(0);
      expect(screen.queryByText('NEW-DRAFT')).not.toBeInTheDocument();
    });
    // Only the still-loaded failed invoice stays selected and counted.
    await waitFor(() => expect(screen.getByRole('button', { name: /Post 1 Selected/ })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Print 1 Selected/ })).toBeInTheDocument();
  });

  it('Deselect All clears everything, including a hand-ticked older-season invoice', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('OLD-DRAFT').length).toBeGreaterThan(0));

    tickRow('OLD-DRAFT');
    tickRow('NEW-DRAFT');
    expect(screen.getByRole('button', { name: /Post 2 Selected/ })).toBeInTheDocument();
    expect(toggleButton()).toHaveTextContent('Deselect All');
    fireEvent.click(toggleButton());

    expect(screen.queryByRole('button', { name: /Post \d+ Selected/ })).not.toBeInTheDocument();
    expect(toggleButton()).toHaveTextContent('Select All');
  });

  it('a partial selection offers Clear selection, which clears it', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('OLD-DRAFT').length).toBeGreaterThan(0));

    tickRow('OLD-DRAFT');
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.queryByRole('button', { name: /Post \d+ Selected/ })).not.toBeInTheDocument();
  });

  it('Select All is disabled when every selectable row in view is from an older or unknown season', async () => {
    mockFrom.mockImplementation((table: string) =>
      buildInMemoryQuery(table === 'invoices'
        ? [
          ...ROWS.filter((row) => (row as { season?: number }).season === 2026),
          invoice({ invoice_number: 'NO-SEASON', status: 'draft', season: null, invoice_date: '2026-10-07', created_at: '2026-10-07T15:00:00+00:00' }),
        ]
        : []));
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('OLD-DRAFT').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getAllByText('NO-SEASON').length).toBeGreaterThan(0));

    // The unknown-season draft is tagged like an older-season one.
    expect(screen.getAllByText('Season unknown').length).toBeGreaterThan(0);
    expect(toggleButton()).toHaveTextContent('Select All');
    expect(toggleButton()).toBeDisabled();
    fireEvent.click(toggleButton());
    expect(screen.queryByRole('button', { name: /Post \d+ Selected/ })).not.toBeInTheDocument();

    // A hand-ticked row can still be cleared with the same button.
    tickRow('NO-SEASON');
    expect(toggleButton()).toHaveTextContent('Deselect All');
    expect(toggleButton()).toBeEnabled();
    fireEvent.click(toggleButton());
    expect(screen.queryByRole('button', { name: /Post \d+ Selected/ })).not.toBeInTheDocument();
  });

  it('a prior-season draft ticked by hand is named as not from this season in the Post confirm', async () => {
    render(<MemoryRouter><Invoices /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByText('OLD-DRAFT').length).toBeGreaterThan(0));

    const row = screen.getAllByText('OLD-DRAFT').map((el) => el.closest('tr')).find(Boolean)!;
    fireEvent.click(within(row).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Post 1 Selected/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/This includes 1 invoice\(s\) not from this season \(Season 2026\)/)).toBeInTheDocument();
  });
});
