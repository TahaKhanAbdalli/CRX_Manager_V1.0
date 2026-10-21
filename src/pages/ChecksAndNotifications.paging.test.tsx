/**
 * ChecksAndNotifications.paging.test.tsx — Goal 4 part 2: the integrity cleanup panel,
 * the compliance records and the notifications read every row.
 *
 * Each read here was one request, which the server silently stops at 1,000 rows (the
 * logbook pickers stopped lower, at 500 customers / fields and 200 applicators). Rows past
 * the cap were never shown or counted. Notifications already pass the cap live: four staff
 * accounts held 1,029-1,381 unread on 2026-10-20, while the page showed the newest 200 and
 * the bell counted the unread among the 20 it loads. The fake server below caps every reply
 * at 1,000 like the real one, so each test fails against the old screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery, pagedRpcReply, SERVER_ROW_CAP } from '../test-utils/inMemoryQuery';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  functions: {} as Record<string, Row[]>,
  toast: vi.fn(),
  // The signed-in person; a test may swap it to model another account signing in.
  profile: { id: 'user-1', role: 'admin', full_name: 'Admin', is_active: true },
  // While set, table reads wait for it, like a slow network.
  hold: null as Promise<void> | null,
}));

// Delay a query's answer until H.hold (if set when the read is awaited) settles.
function heldQuery(query: Record<string, unknown>): Record<string, unknown> {
  const answer = query.then as (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => unknown;
  query.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    (H.hold ?? Promise.resolve()).then(() => answer(resolve, reject));
  return query;
}

// Tables a test fills are served by the capped in-memory server; any other table
// (lookups these screens make on the side) answers with no rows.
function emptyQuery(): Record<string, unknown> {
  const q: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: 0 });
      return () => q;
    },
  });
  return q;
}

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  const client = {
    from: (table: string) => (table in H.tables ? heldQuery(buildInMemoryQuery(H.tables[table])) : emptyQuery()),
    rpc: (name: string) => pagedRpcReply({ data: H.functions[name] ?? [], error: null }),
  };
  return { ...actual, supabase: client, supabaseUntyped: client };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: H.profile, role: 'admin', deniedPages: [] }),
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../hooks/useRealtimeSubscription', () => ({ useRealtimeNotifications: () => undefined }));
// Drawing 1,010 real table rows is slow; the table only reports the rows it was given.
vi.mock('../components/ui/DataTable', () => ({
  default: ({ data }: { data: unknown[] }) => <p data-testid="table-rows">{data.length}</p>,
}));
// The logbook's date controls: pick one fixed range as soon as the report mounts.
vi.mock('../components/reports/ReportShell', async () => {
  const { useEffect } = await import('react');
  function ReportShellStub({ onDateChange, extraControls, children }: {
    onDateChange: (s: string, e: string) => void; extraControls?: React.ReactNode; children: React.ReactNode;
  }) {
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { onDateChange('2026-01-01', '2026-12-31'); }, []);
    return <div>{extraControls}{children}</div>;
  }
  return { default: ReportShellStub };
});

import IntegrityCleanupPanel from '../components/integrity/IntegrityCleanupPanel';
import Compliance from './Compliance';
import LogbookReport from '../components/reports/LogbookReport';
import Notifications from './Notifications';
import NotificationsPanel from '../components/team/NotificationsPanel';

const TOTAL = SERVER_ROW_CAP + 10;
// Drawing over 1,000 rows is slow when the whole suite runs at once, and CI's coverage run
// is several times slower again.
vi.setConfig({ testTimeout: 120_000 });
// findBy / waitFor give up after 1 s by default; allow for the same slowdown.
configure({ asyncUtilTimeout: 30_000 });
const pad = (i: number) => String(i).padStart(4, '0');
const many = (make: (i: number) => Row): Row[] => Array.from({ length: TOTAL }, (_, i) => make(i));

beforeEach(() => {
  vi.clearAllMocks();
  H.tables = {};
  H.functions = {};
  H.hold = null;
  H.profile = { id: 'user-1', role: 'admin', full_name: 'Admin', is_active: true };
});
afterEach(cleanup);

const renderAt = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('integrity cleanup past the 1,000-row server cap (H29, H30)', () => {
  it('lists every negative-stock row, unbilled delivery, made-at-delivery row and open alert', async () => {
    H.tables.inventory = many((i) => ({
      id: `inv${pad(i)}`, product_id: `p${pad(i)}`, location: 'Main', quantity_available: -1, quantity_prebooked: 0,
      quantity_on_order: 0, manufactured_at_delivery: true, updated_at: '2026-10-01T12:00:00Z', product: { product_name: 'Roundup' },
    }));
    H.tables.deliveries = many((i) => ({
      id: `d${pad(i)}`, delivery_number: `DEL-${pad(i)}`, order_id: `o${pad(i)}`, status: 'completed',
      completed_at: '2026-10-01T12:00:00Z', customer: { farm_name: 'Big Farm' }, items: [{ id: `di${pad(i)}` }],
    }));
    H.tables.integrity_alerts = many((i) => ({
      id: `a${pad(i)}`, alert_type: 'negative_inventory', entity_table: 'inventory', entity_id: `inv${pad(i)}`,
      details: {}, detected_at: '2026-10-01T12:00:00Z', resolved_at: null,
    }));
    renderAt(<IntegrityCleanupPanel />);

    expect(await screen.findByText(`(${TOTAL} open)`)).toBeInTheDocument();
    // Negative stock, unbilled deliveries and stock made at delivery: 1,010 rows each.
    await waitFor(() => expect(screen.getAllByText(`(${TOTAL} rows)`)).toHaveLength(3));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('finds an over-received PO line past row 1,000 (the old column-to-text filter never matched)', async () => {
    // Every line received in full except the last, received one over. The old query
    // compared quantity_received with the TEXT "quantity_ordered": live it was refused
    // every time, so the section always showed 0 rows.
    H.tables.purchase_order_items = many((i) => ({
      id: `poi${pad(i)}`, product_name: `Product ${pad(i)}`, quantity_ordered: 5,
      quantity_received: i === TOTAL - 1 ? 6 : 5, purchase_order: { po_number: 'PO-1' },
    }));
    renderAt(<IntegrityCleanupPanel />);

    const heading = await screen.findByText('Over-received PO items');
    await waitFor(() => expect(heading.parentElement!).toHaveTextContent('(1 rows)'));
    expect(screen.getByText(`Product ${pad(TOTAL - 1)}`)).toBeInTheDocument();
  });
});

describe('compliance past the 1,000-row server cap', () => {
  it('counts every expired license (H42)', async () => {
    H.tables.applicator_licenses = many((i) => ({
      id: `l${pad(i)}`, customer_id: 'c1', profile_id: null, license_number: `L-${pad(i)}`, license_type: 'private',
      expiry_date: '2020-01-01', customer: { farm_name: 'Big Farm' },
    }));
    renderAt(<Compliance />);
    expect(await screen.findByText(`${TOTAL} Expired Licenses`)).toBeInTheDocument();
  });

  it('lists every restricted-use sale in the register (H32)', async () => {
    H.functions.get_rup_sales_register = many((i) => ({
      id: `rup${pad(i)}`, sale_date: '2026-10-01', buyer_name: `Farm ${pad(i)}`, product_name: 'Atrazine',
      compliance_status: 'compliant', total_cents: 100,
    }));
    renderAt(<Compliance />);
    fireEvent.click(await screen.findByRole('button', { name: /RUP Sales Register/ }));
    await waitFor(() => expect(screen.getByText('Total Records').parentElement!).toHaveTextContent(String(TOTAL)));
    expect(screen.getByTestId('table-rows')).toHaveTextContent(String(TOTAL));
  });
});

describe('logbooks past the 1,000-row server cap (H33, M40)', () => {
  it('offers every customer and lists every application record', async () => {
    H.tables.customers = many((i) => ({ id: `c${pad(i)}`, farm_name: `Farm ${pad(i)}` }));
    H.functions.get_logbook_by_customer = many((i) => ({
      record_id: `ar${pad(i)}`, record_number: `AR-${pad(i)}`, application_date: '2026-06-01', application_time: null,
      customer_name: 'Farm 1009', product_data: [],
    }));
    renderAt(<LogbookReport />);

    const picker = await screen.findByRole('combobox', { name: 'Select customer' });
    // Was the first 500 customers; the last customer is now a choice.
    await waitFor(() => expect(picker.querySelectorAll('option')).toHaveLength(TOTAL + 1));
    fireEvent.change(picker, { target: { value: `c${pad(TOTAL - 1)}` } });
    await waitFor(() => expect(screen.getByTestId('table-rows')).toHaveTextContent(String(TOTAL)));
  });

  it('offers every field and every applicator', async () => {
    H.tables.fields = many((i) => ({ id: `f${pad(i)}`, field_name: `Field ${pad(i)}`, is_active: true, customer: { farm_name: 'Big Farm' } }));
    H.tables.profile_public_view = many((i) => ({ id: `u${pad(i)}`, full_name: `Staff ${pad(i)}`, role: 'applicator', is_active: true }));
    renderAt(<LogbookReport />);

    fireEvent.click(await screen.findByRole('button', { name: /Field/ }));
    const fieldPicker = await screen.findByRole('combobox', { name: 'Select field' });
    await waitFor(() => expect(fieldPicker.querySelectorAll('option')).toHaveLength(TOTAL + 1));

    fireEvent.click(screen.getByRole('button', { name: /Applicator/ }));
    const applicatorPicker = await screen.findByRole('combobox', { name: 'Select applicator' });
    // Was the first 200.
    await waitFor(() => expect(applicatorPicker.querySelectorAll('option')).toHaveLength(TOTAL + 1));
  });
});

describe('notifications past the 1,000-row server cap (L9, L10-1)', () => {
  const notification = (i: number): Row => ({
    id: `n${pad(i)}`, user_id: 'user-1', notification_type: 'mention', title: `Note ${pad(i)}`, message: 'Hello',
    related_entity_type: null, related_entity_id: null, is_read: false,
    created_at: new Date(Date.UTC(2026, 9, 1) + (TOTAL - i) * 60000).toISOString(),
  });

  it('the Notifications page lists every notification, not the newest 200', async () => {
    H.tables.notifications = many(notification);
    renderAt(<Notifications />);
    // The oldest one, past both the old 200 limit and the server cap, is listed.
    expect(await screen.findByText(`Note ${pad(TOTAL - 1)}`)).toBeInTheDocument();
    expect(screen.getAllByText(/^Note \d{4}$/)).toHaveLength(TOTAL);
  });

  it('the bell counts every unread notification in the database, not the unread among the 20 it loads', async () => {
    H.tables.notifications = many(notification);
    renderAt(<NotificationsPanel />);
    fireEvent.click(await screen.findByTitle('Notifications'));
    expect(await screen.findByText(`${TOTAL.toLocaleString()} unread`)).toBeInTheDocument();
    // The dropdown still shows only the newest 20.
    expect(screen.getAllByText(/^Note \d{4}$/)).toHaveLength(20);
  });

  it("another person signing in clears the last person's notifications at once, before their own read lands", async () => {
    H.tables.notifications = [notification(0), notification(1)];
    const view = render(<MemoryRouter><NotificationsPanel /></MemoryRouter>);
    fireEvent.click(await screen.findByTitle('Notifications'));
    expect(await screen.findByText('Note 0000')).toBeInTheDocument();

    // user-2's reads are slow; user-1's list must not stay up, clickable, meanwhile.
    let release = () => {};
    H.hold = new Promise<void>((r) => { release = r; });
    H.profile = { id: 'user-2', role: 'admin', full_name: 'Second', is_active: true };
    view.rerender(<MemoryRouter><NotificationsPanel /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByText('Note 0000')).not.toBeInTheDocument());

    release();
    // user-2 has none of user-1's notifications.
    expect(await screen.findByText('No notifications')).toBeInTheDocument();
  });
});
