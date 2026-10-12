/**
 * FieldInvoicesSeasonWindow.test.tsx — the Field Invoices tabs after the Oct 1 rollover.
 *
 * Bug (2026-10-09): every Field Invoices tab only fetched the CURRENT season, so on Oct 1
 * the prior-season unposted field invoice disappeared from the Drafts tab, its badge, its
 * footer totals and Post All (and posted-but-unpaid ones from the Posted / All tabs).
 * The rule now: an OPEN invoice (draft, unposted, posted, overdue) shows whatever season it
 * is in, labelled with its season; only CLOSED ones (paid, voided, cancelled) stay
 * season-windowed. The supabase mock applies the panels' real filters to an in-memory row
 * set, so these tests prove which rows the queries actually return.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery } from '../../test-utils/inMemoryQuery';

const { mockFrom, mockRpc, mockToast } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  // supabaseUntyped carries the posting-version readers and the versioned post.
  const client = { from: mockFrom, rpc: mockRpc };
  return { ...actual, supabase: client, supabaseUntyped: client };
});
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' }, role: 'admin', deniedPages: [] }),
}));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));

import FieldInvoicesUnpostedPanel from './FieldInvoicesUnpostedPanel';
import FieldInvoicesPostedPanel from './FieldInvoicesPostedPanel';
import FieldInvoicesListPanel from './FieldInvoicesListPanel';
import FieldInvoices from '../../pages/FieldInvoices';
import { Sentry } from '../../lib/sentry';

function fieldInvoice(overrides: Record<string, unknown>) {
  return {
    id: overrides.invoice_number,
    invoice_type: 'field_application',
    customer_id: 'cust-1',
    customer: { farm_name: 'Test Farm' },
    job: null,
    job_id: null,
    blend_ticket_id: null,
    invoice_group_id: null,
    deleted_at: null,
    updated_at: '2026-10-05T10:00:00+00:00',
    field_app_locations: [],
    invoice_items: [],
    total_acres: 10,
    total_amount_cents: 278578,
    paid_amount_cents: 0,
    prepay_applied_cents: 0,
    balance_cents: 278578,
    ...overrides,
  };
}

// "Today" is 2026-10-09, so the current season is 2027 (Oct 1 2026 – Sep 30 2027).
const ROWS = [
  fieldInvoice({ invoice_number: 'FA-OLD-UNPOSTED', status: 'unposted', season: 2026, invoice_date: '2026-08-08', created_at: '2026-08-08T15:00:00+00:00' }),
  fieldInvoice({ invoice_number: 'FA-OLD-DRAFT', status: 'draft', season: 2026, invoice_date: '2026-07-01', created_at: '2026-07-01T15:00:00+00:00', total_amount_cents: 100000, balance_cents: 100000 }),
  fieldInvoice({ invoice_number: 'FA-OLD-OVERDUE', status: 'overdue', season: 2026, invoice_date: '2026-06-01', created_at: '2026-06-01T15:00:00+00:00' }),
  fieldInvoice({ invoice_number: 'FA-OLD-PAID', status: 'paid', season: 2026, balance_cents: 0, invoice_date: '2026-06-02', created_at: '2026-06-02T15:00:00+00:00' }),
  fieldInvoice({ invoice_number: 'FA-OLD-VOIDED', status: 'voided', season: 2026, balance_cents: 0, invoice_date: '2026-06-03', created_at: '2026-06-03T15:00:00+00:00' }),
  fieldInvoice({ invoice_number: 'FA-NEW-PAID', status: 'paid', season: 2027, balance_cents: 0, invoice_date: '2026-10-02', created_at: '2026-10-02T15:00:00+00:00' }),
  fieldInvoice({ invoice_number: 'FA-NEW-DRAFT', status: 'draft', season: 2027, invoice_date: '2026-10-03', created_at: '2026-10-03T15:00:00+00:00', total_amount_cents: 50000, balance_cents: 50000 }),
];

// The posting versions the readers return (32-character lowercase md5s).
const POST_VERSION = '0123456789abcdef0123456789abcdef';
const GROUP_VERSION = 'fedcba9876543210fedcba9876543210';

function rpcResult(data: unknown, error: unknown = null) {
  const result = Promise.resolve({ data, error });
  return Object.assign(result, { throwOnError: () => (error ? Promise.reject(error) : result) });
}

/** Readers return a version; the posts succeed (a group post returns its result). */
function answerRpc(name: string) {
  if (name === 'get_invoice_post_version') return rpcResult(POST_VERSION);
  if (name === 'get_invoice_group_post_version') return rpcResult(GROUP_VERSION);
  if (name === 'post_invoice_group') return rpcResult({ posted: 2 });
  return rpcResult(null);
}

function renderInRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('Field Invoices tabs — season window after the Oct 1 rollover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T12:00:00'));
    mockFrom.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? ROWS : []));
    mockRpc.mockImplementation(() => ({
      throwOnError: () => Promise.resolve({ data: null, error: null }),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Drafts tab lists prior-season unposted invoices with their season, and the footer totals include them', async () => {
    renderInRouter(<FieldInvoicesUnpostedPanel />);

    await waitFor(() => expect(screen.getAllByText('FA-OLD-UNPOSTED').length).toBeGreaterThan(0));
    expect(screen.getAllByText('FA-OLD-DRAFT').length).toBeGreaterThan(0);
    expect(screen.getAllByText('FA-NEW-DRAFT').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Season 2026').length).toBeGreaterThan(0);
    // Footer: 3 invoices, $2,785.78 + $1,000.00 + $500.00 = $4,285.78.
    expect(screen.getByText('Invoices Displayed: 3')).toBeInTheDocument();
    expect(screen.getByText('$4,285.78')).toBeInTheDocument();
  });

  it('Post All posts only this season; prior-season invoices are listed but left out, and the confirm says so', async () => {
    mockRpc.mockImplementation(answerRpc);
    renderInRouter(<FieldInvoicesUnpostedPanel />);
    await waitFor(() => expect(screen.getAllByText('FA-OLD-UNPOSTED').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /Post All/ }));
    // post_invoice does not check the season (it does refuse a closed accounting period),
    // so Post All leaves the two Season 2026 invoices out and names them.
    expect(await screen.findByText(/2 invoice\(s\) not from this season \(Season 2026\) are NOT included/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Post 1 target(s)' }));

    await waitFor(() => expect(mockRpc.mock.calls.filter(([name]) => name === 'post_invoice')).toHaveLength(1));
    const posted = mockRpc.mock.calls
      .filter(([name]) => name === 'post_invoice')
      .map(([, args]) => (args as { p_invoice_id: string }).p_invoice_id);
    expect(posted).toEqual(['FA-NEW-DRAFT']);
    // The post carries the posting version read when the tray LOADED, with a key; Post All itself
    // reads no version. Only Post All's own targets get a version read (review round 1, MED): the
    // two Season 2026 invoices Post All leaves out get none.
    const beforePost = mockRpc.mock.calls.slice(0, mockRpc.mock.calls.findIndex(([name]) => name === 'post_invoice'));
    expect(beforePost.filter(([name]) => name === 'get_invoice_post_version').map(([, args]) => args.p_invoice_ids[0]).sort())
      .toEqual(['FA-NEW-DRAFT']);
    expect(mockRpc.mock.calls.filter(([name]) => name === 'post_invoice')[0][1]).toEqual({
      p_invoice_id: 'FA-NEW-DRAFT',
      p_idempotency_key: expect.any(String),
      p_expected_version: POST_VERSION,
    });
  });

  it('Post All posts a this-season split group with the group posting version', async () => {
    const groupA = fieldInvoice({ invoice_number: 'FA-GRP-A', status: 'unposted', season: 2027, invoice_group_id: 'grp-2', invoice_date: '2026-10-04', created_at: '2026-10-04T15:00:00+00:00' });
    const groupB = fieldInvoice({ invoice_number: 'FA-GRP-B', status: 'unposted', season: 2027, invoice_group_id: 'grp-2', customer_id: 'cust-2', invoice_date: '2026-10-04', created_at: '2026-10-04T15:00:00+00:00' });
    mockFrom.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? [groupA, groupB] : []));
    mockRpc.mockImplementation(answerRpc);
    renderInRouter(<FieldInvoicesUnpostedPanel />);
    await waitFor(() => expect(screen.getAllByText('FA-GRP-B').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /Post All/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Post 1 target(s)' }));

    await waitFor(() => expect(mockRpc.mock.calls.filter(([name]) => name === 'post_invoice_group')).toHaveLength(1));
    const beforeGroupPost = mockRpc.mock.calls.slice(0, mockRpc.mock.calls.findIndex(([name]) => name === 'post_invoice_group'));
    expect(beforeGroupPost.filter(([name]) => name === 'get_invoice_group_post_version').map(([, args]) => args))
      .toEqual([{ p_invoice_group_id: 'grp-2' }]);
    expect(mockRpc.mock.calls.filter(([name]) => name === 'post_invoice_group')[0][1]).toEqual({
      p_invoice_group_id: 'grp-2',
      p_performed_by: 'user-1',
      p_idempotency_key: expect.any(String),
      p_expected_version: GROUP_VERSION,
    });
    expect(mockRpc.mock.calls.some(([name]) => name === 'post_invoice')).toBe(false);
  });

  // Codex Luna HIGH (2026-10-12): Post All posted whatever the invoice held at click time.
  // Another admin changes FA-NEW-DRAFT from $500.00 to $700.00 after the tray loaded; at click
  // Post All re-reads the rows the tray showed, sees the change, posts nothing and reloads.
  it('Post All posts nothing when an invoice changed since the tray loaded, reloads and says so', async () => {
    let rows = ROWS;
    mockFrom.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? rows : []));
    mockRpc.mockImplementation(answerRpc);
    renderInRouter(<FieldInvoicesUnpostedPanel />);
    await waitFor(() => expect(screen.getAllByText('FA-NEW-DRAFT').length).toBeGreaterThan(0));
    await waitFor(() => expect(mockRpc.mock.calls.some(([name]) => name === 'get_invoice_post_version')).toBe(true));
    const trayLoads = () => mockFrom.mock.calls.filter(([table]) => table === 'invoices').length;

    fireEvent.click(screen.getByRole('button', { name: /Post All/ }));
    const confirm = await screen.findByRole('button', { name: 'Post 1 target(s)' });
    // The change lands after the tray loaded and bound its versions.
    rows = ROWS.map((row) => (row.id === 'FA-NEW-DRAFT'
      ? { ...row, total_amount_cents: 70000, balance_cents: 70000, updated_at: '2026-10-05T11:00:00+00:00' }
      : row));
    const loadsBeforePost = trayLoads();
    fireEvent.click(confirm);

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      '1 invoice(s) changed since this tray loaded (FA-NEW-DRAFT) — nothing was posted. The tray is being refreshed; check them and post again.',
    ));
    expect(mockRpc.mock.calls.some(([name]) => name === 'post_invoice' || name === 'post_invoice_group')).toBe(false);
    // The re-read, then the reload of the tray itself.
    await waitFor(() => expect(trayLoads()).toBeGreaterThanOrEqual(loadsBeforePost + 2));
    expect(mockToast).not.toHaveBeenCalledWith('success', expect.anything());
    // An expected outcome, not a fault: no Sentry error.
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  // Review round 1: a database refusal of one target (its version moved after the load) names
  // only that target; the other target still posts and the summary does not claim nothing posted.
  it('Post All: a group the database refuses is named alone while the other invoice posts', async () => {
    const groupA = fieldInvoice({ invoice_number: 'FA-GRP-A', status: 'unposted', season: 2027, invoice_group_id: 'grp-2', invoice_date: '2026-10-04', created_at: '2026-10-04T15:00:00+00:00' });
    const groupB = fieldInvoice({ invoice_number: 'FA-GRP-B', status: 'unposted', season: 2027, invoice_group_id: 'grp-2', customer_id: 'cust-2', invoice_date: '2026-10-04', created_at: '2026-10-04T15:00:00+00:00' });
    mockFrom.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? [groupA, groupB, ROWS[6]] : []));
    mockRpc.mockImplementation((name: string) => {
      if (name === 'post_invoice_group') return rpcResult(null, { message: 'INVOICE_CHANGED_SINCE_REVIEW: group grp-2 changed since it was reviewed' });
      return answerRpc(name);
    });
    renderInRouter(<FieldInvoicesUnpostedPanel />);
    await waitFor(() => expect(screen.getAllByText('FA-GRP-B').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /Post All/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Post 2 target(s)' }));

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith(
      'error',
      expect.stringMatching(/^Posted 1\/2 target\(s\)\. Failed: split group containing FA-GRP-[AB]: changed since this screen loaded, so it was not posted — check it and post again$/),
    ));
    expect(mockRpc.mock.calls.filter(([name]) => name === 'post_invoice').map(([, args]) => args.p_invoice_id)).toEqual(['FA-NEW-DRAFT']);
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.stringMatching(/nothing was posted/));
    // Review round 2 (LOW): the database's version refusal is an expected outcome, not a fault.
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('Post All skips a split group with a prior-season member hidden by a filter, and counts that hidden member', async () => {
    // A this-season member and a Season 2026 member of the same split group. Filtering the
    // view to the this-season member still must not post the group: post_invoice_group
    // posts every member, including the hidden Season 2026 one.
    const groupNew = fieldInvoice({ invoice_number: 'FA-GRP-NEW', status: 'unposted', season: 2027, invoice_group_id: 'grp-1', invoice_date: '2026-10-04', created_at: '2026-10-04T15:00:00+00:00' });
    const groupOld = fieldInvoice({ invoice_number: 'FA-GRP-OLD', status: 'unposted', season: 2026, invoice_group_id: 'grp-1', invoice_date: '2026-09-20', created_at: '2026-09-20T15:00:00+00:00' });
    mockFrom.mockImplementation((table: string) =>
      buildInMemoryQuery(table === 'invoices' ? [groupNew, groupOld, ROWS[6]] : []));
    mockRpc.mockImplementation(answerRpc);
    renderInRouter(<FieldInvoicesUnpostedPanel />);
    await waitFor(() => expect(screen.getAllByText('FA-GRP-OLD').length).toBeGreaterThan(0));

    // Narrow the view to this season's dates only: FA-GRP-OLD (Sep 20) is hidden.
    fireEvent.change(screen.getByLabelText('Trans. Date From'), { target: { value: '2026-10-01' } });
    await waitFor(() => expect(screen.queryByText('FA-GRP-OLD')).not.toBeInTheDocument());
    expect(screen.getAllByText('FA-GRP-NEW').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: /Post All/ }));
    expect(await screen.findByText(/1 invoice\(s\) not from this season \(Season 2026\) are NOT included, nor is any split group that has one of them as a member \(1 group\(s\)\)/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Post 1 target(s)' }));

    await waitFor(() => expect(mockRpc.mock.calls.filter(([name]) => name === 'post_invoice')).toHaveLength(1));
    expect(mockRpc.mock.calls.filter(([name]) => name === 'post_invoice')[0][1]).toMatchObject({ p_invoice_id: 'FA-NEW-DRAFT' });
    expect(mockRpc.mock.calls.filter(([name]) => name === 'post_invoice_group')).toHaveLength(0);
    // A group Post All skips gets no version read at all (review round 1, MED).
    expect(mockRpc.mock.calls.some(([name]) => name === 'get_invoice_group_post_version')).toBe(false);
  });

  it('Posted tab keeps prior-season overdue invoices but season-windows paid ones', async () => {
    renderInRouter(<FieldInvoicesPostedPanel />);

    await waitFor(() => expect(screen.getAllByText('FA-NEW-PAID').length).toBeGreaterThan(0));
    expect(screen.getAllByText('FA-OLD-OVERDUE').length).toBeGreaterThan(0);
    expect(screen.queryByText('FA-OLD-PAID')).not.toBeInTheDocument();
  });

  it('Unpost All in the default scope only touches this season; an older invoice needs its month batch chosen', async () => {
    const thisSeasonPosted = fieldInvoice({ invoice_number: 'FA-NEW-POSTED', status: 'posted', season: 2027, invoice_date: '2026-10-04', created_at: '2026-10-04T15:00:00+00:00' });
    mockFrom.mockImplementation((table: string) => buildInMemoryQuery(table === 'invoices' ? [...ROWS, thisSeasonPosted] : []));
    mockRpc.mockImplementation(() => Promise.resolve({ data: true, error: null }));
    renderInRouter(<FieldInvoicesPostedPanel />);
    await waitFor(() => expect(screen.getAllByText('FA-OLD-OVERDUE').length).toBeGreaterThan(0));

    // The prior-season month is labelled as holding only its unpaid invoices.
    expect(screen.getByRole('option', { name: /June 2026 \(1\) — unpaid only/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /October 2026 \(2\)$/ })).toBeInTheDocument();

    // Default scope: FA-OLD-OVERDUE is listed but NOT an Unpost All candidate.
    fireEvent.click(screen.getByRole('button', { name: 'Unpost All (1)' }));
    expect(await screen.findByText(/1 unpaid invoice\(s\) in view not from this season are NOT included/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unpost 1' }));
    await waitFor(() => expect(mockRpc.mock.calls.filter(([name]) => name === 'unpost_invoice')).toHaveLength(1));
    expect(mockRpc.mock.calls.filter(([name]) => name === 'unpost_invoice').map(([, args]) => (args as { p_invoice_id: string }).p_invoice_id))
      .toEqual(['FA-NEW-POSTED']);

    // Choosing the June 2026 batch is the explicit opt-in that reaches the older invoice.
    fireEvent.change(screen.getByLabelText('Posting scope'), { target: { value: '2026-06' } });
    expect(await screen.findByRole('button', { name: 'Unpost All (1)' })).toBeEnabled();
  });

  it('All Invoices tab keeps prior-season open invoices but season-windows closed ones', async () => {
    renderInRouter(<FieldInvoicesListPanel />);

    await waitFor(() => expect(screen.getAllByText(/FA-OLD-UNPOSTED/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/FA-OLD-OVERDUE/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/FA-NEW-PAID/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/FA-OLD-PAID/)).not.toBeInTheDocument();
    expect(screen.queryByText(/FA-OLD-VOIDED/)).not.toBeInTheDocument();
  });

  it('tab badges count prior-season open invoices', async () => {
    renderInRouter(<FieldInvoices />);

    // Drafts: FA-OLD-UNPOSTED + FA-OLD-DRAFT + FA-NEW-DRAFT. Posted: FA-OLD-OVERDUE + FA-NEW-PAID.
    await waitFor(() => expect(within(screen.getByRole('tab', { name: /Drafts/ })).getByText('3')).toBeInTheDocument());
    await waitFor(() => expect(within(screen.getByRole('tab', { name: /Posted/ })).getByText('2')).toBeInTheDocument());
  });
});
