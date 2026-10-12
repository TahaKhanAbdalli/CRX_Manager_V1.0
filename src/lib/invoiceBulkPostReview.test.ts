/**
 * invoiceBulkPostReview.test.ts — the bulk Post review binds every post to the posting version
 * read when the screen LOADED (review round 1, 2026-10-12), re-reads the rows the screen showed
 * and each targeted split group's members at click, and refuses on any change.
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFrom, mockRpc, mockReadInvoice, mockReadGroup, events } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockReadInvoice: vi.fn(),
  mockReadGroup: vi.fn(),
  events: [] as string[],
}));

vi.mock('./db', async () => {
  const actual = await vi.importActual<typeof import('./db')>('./db');
  return { ...actual, supabase: { from: mockFrom }, supabaseUntyped: { rpc: mockRpc } };
});
vi.mock('./invoicePostVersion', async () => {
  const actual = await vi.importActual<typeof import('./invoicePostVersion')>('./invoicePostVersion');
  return { ...actual, fetchInvoicePostVersion: mockReadInvoice, fetchInvoiceGroupPostVersion: mockReadGroup };
});

import {
  BULK_TARGET_CHANGED_MESSAGE,
  describeBulkPostFailure,
  failedPostReviewMessage,
  readInvoicePostBaseline,
  reviewInvoicePostTargets,
  shownRowsForTargets,
  useInvoicePostBaseline,
  type InvoicePostBaseline,
  type InvoicePostShownRow,
} from './invoiceBulkPostReview';
import { POST_RECHECK_FAILED_MESSAGE, postReviewedInvoice, postReviewedInvoiceGroup } from './invoicePostVersion';

const V1 = '11111111111111111111111111111111';
const V2 = '22222222222222222222222222222222';
const VG = '99999999999999999999999999999999';
const STAMP = '2026-10-05T10:00:00+00:00';

function shown(id: string, overrides: Partial<InvoicePostShownRow> = {}): InvoicePostShownRow {
  return {
    id,
    status: 'draft',
    total_amount_cents: 500000,
    customer_id: 'cust-1',
    invoice_date: '2026-10-05',
    invoice_group_id: null,
    updated_at: STAMP,
    invoice_number: `N-${id}`,
    ...overrides,
  };
}

/** What the database holds now: the shown row plus deleted_at, with overrides. */
function current(row: InvoicePostShownRow, overrides: Record<string, unknown> = {}) {
  return { deleted_at: null, ...row, invoice_group_id: row.invoice_group_id ?? null, ...overrides };
}

/**
 * from('invoices') answering from `db`: select(...).in('id', ids) returns those rows (deleted
 * ones too); select(...).in('invoice_group_id', ids).is('deleted_at', null) returns the live
 * members of those groups.
 */
function databaseHolds(db: Record<string, unknown>[], error: unknown = null) {
  mockFrom.mockImplementation((table: string) => {
    events.push(`from:${table}`);
    let column = '';
    let ids: string[] = [];
    let liveOnly = false;
    const chain = {
      select: vi.fn(() => chain),
      in: vi.fn((col: string, values: string[]) => {
        column = col;
        ids = values;
        events.push(`${col === 'id' ? 'reread' : 'members'}:${values.length}`);
        return chain;
      }),
      is: vi.fn(() => { liveOnly = true; return chain; }),
      then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
        if (error) return Promise.resolve({ data: null, error }).then(resolve, reject);
        const data = db.filter((row) => ids.includes(row[column] as string) && (!liveOnly || row.deleted_at == null));
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return chain;
  });
}

function baseline(parts: Partial<InvoicePostBaseline> = {}): Promise<InvoicePostBaseline> {
  return Promise.resolve({
    invoiceVersions: new Map(),
    groupVersions: new Map(),
    groupMembers: new Map(),
    changedIds: [],
    ...parts,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  mockReadInvoice.mockImplementation(async (id: string) => { events.push(`version:${id}`); return V1; });
  mockReadGroup.mockImplementation(async (id: string) => { events.push(`group-version:${id}`); return VG; });
});

describe('readInvoicePostBaseline (at load)', () => {
  it('reads the group members, then the versions, then re-reads the shown rows and the members', async () => {
    const rows = [shown('inv-1'), shown('inv-2', { invoice_group_id: 'grp-1' }), shown('inv-3', { invoice_group_id: 'grp-1' })];
    // inv-9 is a member the screen never loaded (past the row cap, or another status).
    databaseHolds([...rows, shown('inv-9', { invoice_group_id: 'grp-1' })].map((r) => current(r)));

    const result = await readInvoicePostBaseline(rows);

    expect(result.invoiceVersions).toEqual(new Map([['inv-1', V1]]));
    expect(result.groupVersions).toEqual(new Map([['grp-1', VG]]));
    expect(result.groupMembers).toEqual(new Map([['grp-1', ['inv-2', 'inv-3', 'inv-9']]]));
    expect(result.changedIds).toEqual([]);
    expect(mockReadInvoice).toHaveBeenCalledTimes(1);
    expect(mockReadGroup).toHaveBeenCalledTimes(1);
    // M1 before every version; the row re-read (R2) and the second member read (M2) after them.
    const lastVersion = Math.max(events.indexOf('version:inv-1'), events.indexOf('group-version:grp-1'));
    expect(events.indexOf('members:1')).toBeLessThan(Math.min(events.indexOf('version:inv-1'), events.indexOf('group-version:grp-1')));
    expect(events.indexOf('reread:3')).toBeGreaterThan(lastVersion);
    expect(events.lastIndexOf('members:1')).toBeGreaterThan(lastVersion);
  });

  it('leaves out a version that could not be read', async () => {
    mockReadInvoice.mockImplementation(async (id: string) => {
      if (id === 'inv-2') throw new Error('network');
      return V1;
    });
    const rows = [shown('inv-1'), shown('inv-2')];
    databaseHolds(rows.map((r) => current(r)));

    const result = await readInvoicePostBaseline(rows);

    expect(result.invoiceVersions).toEqual(new Map([['inv-1', V1]]));
    expect(result.changedIds).toEqual([]);
  });

  it('keeps no version at all when the rows or members cannot be re-read (refused at click as recheck_failed)', async () => {
    const rows = [shown('inv-1'), shown('inv-3', { invoice_group_id: 'grp-1' })];
    databaseHolds([], { message: 'down' });

    const result = await readInvoicePostBaseline(rows);

    expect(result.invoiceVersions.size).toBe(0);
    expect(result.groupVersions.size).toBe(0);
    expect(result.changedIds).toEqual([]);
  });

  // Codex Luna round 1 HIGH: the versions were read AFTER the rows and BEFORE the members, so a
  // change landing between the rows query and the version read was inside both the version and
  // the member baseline, and the click-time comparison matched. Now the rows and members are
  // re-read after the versions; any difference throws the baseline away.
  it('a header change between the rows the screen shows and the re-read makes the baseline invalid', async () => {
    const row = shown('inv-1');
    const db = [current(row)];
    databaseHolds(db);
    // The change lands while the version is being read: it is inside the version.
    mockReadInvoice.mockImplementation(async () => {
      db[0] = current(row, { total_amount_cents: 700000, updated_at: '2026-10-05T10:05:00+00:00' });
      return V2;
    });

    const result = await readInvoicePostBaseline([row]);

    expect(result.changedIds).toEqual(['inv-1']);
    expect(result.invoiceVersions.size).toBe(0);
    // At click the review refuses as changed without reading anything.
    mockFrom.mockClear();
    expect(await reviewInvoicePostTargets([{ key: 'k1', invoiceId: 'inv-1' }], [row], Promise.resolve(result)))
      .toEqual({ ok: false, reason: 'changed', changedIds: ['inv-1'] });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('a split member added between the two member reads makes the baseline invalid', async () => {
    const rows = [shown('inv-2', { invoice_group_id: 'grp-1' }), shown('inv-3', { invoice_group_id: 'grp-1' })];
    const db = rows.map((r) => current(r));
    databaseHolds(db);
    // The new member lands while the group version is being read: it is inside the version.
    mockReadGroup.mockImplementation(async () => {
      db.push(current(shown('inv-new', { invoice_group_id: 'grp-1' })));
      return VG;
    });

    const result = await readInvoicePostBaseline(rows);

    expect(result.changedIds).toEqual(['inv-new']);
    expect(result.groupVersions.size).toBe(0);
    expect(await reviewInvoicePostTargets([{ key: 'g', invoiceGroupId: 'grp-1' }], rows, Promise.resolve(result)))
      .toEqual({ ok: false, reason: 'changed', changedIds: ['inv-new'] });
  });

  it('reads at most 6 versions at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockReadInvoice.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return V1;
    });
    const rows = Array.from({ length: 40 }, (_, i) => shown(`inv-${i}`));
    databaseHolds(rows.map((r) => current(r)));

    const result = await readInvoicePostBaseline(rows);

    expect(result.invoiceVersions.size).toBe(40);
    expect(maxInFlight).toBe(6);
  });
});

describe('useInvoicePostBaseline', () => {
  const draftsOnly = (rows: InvoicePostShownRow[]) => rows.filter((row) => row.status === 'draft');

  it('reads once per loaded rows array, for the rows the screen can post only, and serves only those rows', async () => {
    const rows = [shown('inv-1'), shown('inv-2', { status: 'posted' }), shown('inv-3', { status: 'paid' })];
    databaseHolds(rows.map((r) => current(r)));
    const reload = vi.fn();
    const { result, rerender } = renderHook(({ r, on }) => useInvoicePostBaseline(r, on, draftsOnly, reload), {
      initialProps: { r: rows, on: true },
    });

    const promise = result.current(rows);
    expect(promise).not.toBeNull();
    expect((await promise!).invoiceVersions).toEqual(new Map([['inv-1', V1]]));
    // The posted and paid rows get no version read and are not re-read.
    expect(mockReadInvoice.mock.calls.map(([id]) => id)).toEqual(['inv-1']);
    expect(events.filter((e) => e.startsWith('reread:'))).toEqual(['reread:1']);
    expect(reload).not.toHaveBeenCalled();
    // A different rows array (another load) is never served this load's versions.
    expect(result.current([...rows])).toBeNull();

    rerender({ r: rows, on: false });
    expect(result.current(rows)).toBeNull();
  });

  it('reads nothing when disabled (a non-admin)', () => {
    const rows = [shown('inv-1')];
    const reload = vi.fn();
    const { result } = renderHook(() => useInvoicePostBaseline(rows, false, (r: InvoicePostShownRow[]) => r, reload));
    expect(result.current(rows)).toBeNull();
    expect(mockReadInvoice).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('an invalid baseline asks the screen to reload once; a second invalid one in a row does not loop', async () => {
    const row = shown('inv-1');
    const db = [current(row)];
    databaseHolds(db);
    // Every version read lands another change on the row (a busy invoice).
    let edits = 0;
    mockReadInvoice.mockImplementation(async () => {
      edits += 1;
      db[0] = current(row, { updated_at: `2026-10-05T10:0${edits}:00+00:00` });
      return V1;
    });
    const reload = vi.fn();
    const loaded = [row];
    const { result, rerender } = renderHook(({ r }) => useInvoicePostBaseline(r, true, draftsOnly, reload), {
      initialProps: { r: loaded },
    });

    expect((await result.current(loaded)!).changedIds).toEqual(['inv-1']);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    // The reload brings new rows; they change again while being bound: no second automatic reload.
    const reloaded = [{ ...row, updated_at: db[0].updated_at as string }];
    rerender({ r: reloaded });
    expect((await result.current(reloaded)!).changedIds).toEqual(['inv-1']);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('reviewInvoicePostTargets (at click)', () => {
  it('returns the LOAD-TIME versions keyed by target key, reading no version at click', async () => {
    const rows = [shown('inv-1'), shown('inv-2', { invoice_group_id: 'grp-1' }), shown('inv-3', { invoice_group_id: 'grp-1', customer_id: 'cust-2' })];
    databaseHolds(rows.map((r) => current(r)));
    // At click the database's version is V2 (a customer's terms changed since the load): the
    // review still returns the load-time V1, so the post carries V1 and the database refuses.
    mockReadInvoice.mockResolvedValue(V2);

    const review = await reviewInvoicePostTargets(
      [{ key: 'invoice:inv-1', invoiceId: 'inv-1' }, { key: 'group:grp-1', invoiceGroupId: 'grp-1' }],
      rows,
      baseline({
        invoiceVersions: new Map([['inv-1', V1]]),
        groupVersions: new Map([['grp-1', VG]]),
        groupMembers: new Map([['grp-1', ['inv-2', 'inv-3']]]),
      }),
    );

    expect(review).toEqual({ ok: true, versions: new Map([['invoice:inv-1', V1], ['group:grp-1', VG]]) });
    expect(mockReadInvoice).not.toHaveBeenCalled();
    expect(mockReadGroup).not.toHaveBeenCalled();
  });

  it('with no baseline for these rows, or a target without a load-time version, refuses before any read', async () => {
    databaseHolds([current(shown('inv-1'))]);
    expect(await reviewInvoicePostTargets([{ key: 'k1', invoiceId: 'inv-1' }], [shown('inv-1')], null))
      .toEqual({ ok: false, reason: 'recheck_failed' });
    expect(await reviewInvoicePostTargets([{ key: 'k1', invoiceId: 'inv-1' }], [shown('inv-1')], baseline()))
      .toEqual({ ok: false, reason: 'recheck_failed' });
    expect(await reviewInvoicePostTargets([{ key: 'k1', invoiceId: 'inv-1' }], [shown('inv-1')], Promise.reject(new Error('x'))))
      .toEqual({ ok: false, reason: 'recheck_failed' });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it.each([
    ['total', { total_amount_cents: 700000 }],
    ['status', { status: 'posted' }],
    ['customer', { customer_id: 'cust-9' }],
    ['invoice date', { invoice_date: '2026-11-01' }],
    ['split group', { invoice_group_id: 'grp-new' }],
    ['updated_at', { updated_at: '2026-10-05T10:05:00+00:00' }],
    ['deleted_at', { deleted_at: '2026-10-06T09:00:00+00:00' }],
  ])('refuses as changed when the %s differs from what the screen showed', async (_label, change) => {
    const row = shown('inv-1');
    databaseHolds([current(row, change)]);

    const review = await reviewInvoicePostTargets([{ key: 'k1', invoiceId: 'inv-1' }], [row], baseline({ invoiceVersions: new Map([['inv-1', V1]]) }));

    expect(review).toEqual({ ok: false, reason: 'changed', changedIds: ['inv-1'] });
  });

  it('refuses as changed when a shown row is missing now', async () => {
    const rows = [shown('inv-1'), shown('inv-2')];
    databaseHolds([current(rows[0])]);

    const review = await reviewInvoicePostTargets(
      [{ key: 'k1', invoiceId: 'inv-1' }, { key: 'k2', invoiceId: 'inv-2' }],
      rows,
      baseline({ invoiceVersions: new Map([['inv-1', V1], ['inv-2', V1]]) }),
    );

    expect(review).toEqual({ ok: false, reason: 'changed', changedIds: ['inv-2'] });
  });

  it('refuses a shown row loaded without updated_at instead of comparing less', async () => {
    const row = shown('inv-1', { updated_at: null });
    databaseHolds([current(row, { updated_at: STAMP })]);

    const review = await reviewInvoicePostTargets([{ key: 'k1', invoiceId: 'inv-1' }], [row], baseline({ invoiceVersions: new Map([['inv-1', V1]]) }));

    expect(review).toEqual({ ok: false, reason: 'changed', changedIds: ['inv-1'] });
  });

  it('refuses as changed when a split group gained or lost a member since the load', async () => {
    const rows = [shown('inv-2', { invoice_group_id: 'grp-1' }), shown('inv-3', { invoice_group_id: 'grp-1' })];
    const target = [{ key: 'g', invoiceGroupId: 'grp-1' }];
    const loaded = baseline({ groupVersions: new Map([['grp-1', VG]]), groupMembers: new Map([['grp-1', ['inv-2', 'inv-3']]]) });

    databaseHolds([...rows, shown('inv-new', { invoice_group_id: 'grp-1' })].map((r) => current(r)));
    expect(await reviewInvoicePostTargets(target, rows, loaded)).toEqual({ ok: false, reason: 'changed', changedIds: ['inv-new'] });

    // inv-3 left the group (moved or deleted elsewhere): the shown row differs and the member is gone.
    databaseHolds([current(rows[0]), current(rows[1], { deleted_at: '2026-10-06T09:00:00+00:00' })]);
    expect(await reviewInvoicePostTargets(target, rows, loaded)).toEqual({ ok: false, reason: 'changed', changedIds: ['inv-3'] });
  });

  it('a member the screen never loaded is fine while the group is unchanged (bound by the load-time version)', async () => {
    const rows = [shown('inv-2', { invoice_group_id: 'grp-1' })];
    databaseHolds([...rows, shown('inv-9', { invoice_group_id: 'grp-1' })].map((r) => current(r)));

    const review = await reviewInvoicePostTargets(
      [{ key: 'g', invoiceGroupId: 'grp-1' }],
      rows,
      baseline({ groupVersions: new Map([['grp-1', VG]]), groupMembers: new Map([['grp-1', ['inv-2', 'inv-9']]]) }),
    );

    expect(review).toEqual({ ok: true, versions: new Map([['g', VG]]) });
  });

  it('a row or member query error is recheck_failed', async () => {
    databaseHolds([], { message: 'network down' });

    const review = await reviewInvoicePostTargets([{ key: 'k1', invoiceId: 'inv-1' }], [shown('inv-1')], baseline({ invoiceVersions: new Map([['inv-1', V1]]) }));

    expect(review).toEqual({ ok: false, reason: 'recheck_failed' });
  });

  it('re-reads rows in chunks of at most 100', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => shown(`inv-${i}`));
    databaseHolds(rows.map((r) => current(r)));

    const review = await reviewInvoicePostTargets(
      rows.map((r) => ({ key: r.id, invoiceId: r.id })),
      rows,
      baseline({ invoiceVersions: new Map(rows.map((r) => [r.id, V1])) }),
    );

    expect(review.ok).toBe(true);
    expect(events.filter((e) => e.startsWith('reread:'))).toEqual(['reread:100', 'reread:50']);
  });
});

describe('shownRowsForTargets', () => {
  it('takes a stand-alone invoice row and every loaded row of a targeted group', () => {
    const loaded = [
      shown('inv-1'),
      shown('inv-2', { invoice_group_id: 'grp-1' }),
      shown('inv-3', { invoice_group_id: 'grp-1' }),
      shown('inv-4'),
      shown('inv-5', { invoice_group_id: 'grp-2' }),
    ];
    const rows = shownRowsForTargets(
      [{ key: 'a', invoiceId: 'inv-1' }, { key: 'b', invoiceGroupId: 'grp-1' }],
      loaded,
    );
    expect(rows.map((r) => r.id)).toEqual(['inv-1', 'inv-2', 'inv-3']);
  });
});

describe('failedPostReviewMessage', () => {
  it('names the screen and up to three changed invoices, or that the check could not run', () => {
    const rows = ['a', 'b', 'c', 'd'].map((id) => shown(id));
    expect(failedPostReviewMessage({ ok: false, reason: 'changed', changedIds: ['a', 'b'] }, 'page', rows))
      .toBe('2 invoice(s) changed since this page loaded (N-a, N-b) — nothing was posted. The page is being refreshed; check them and post again.');
    expect(failedPostReviewMessage({ ok: false, reason: 'changed', changedIds: ['a', 'b', 'c', 'd', 'new'] }, 'list', rows))
      .toBe('5 invoice(s) changed since this list loaded (N-a, N-b, N-c, +1 more) — nothing was posted. The list is being refreshed; check them and post again.');
    expect(failedPostReviewMessage({ ok: false, reason: 'changed', changedIds: ['new'] }, 'cockpit'))
      .toBe('1 invoice(s) changed since this cockpit loaded — nothing was posted. The cockpit is being refreshed; check them and post again.');
    expect(failedPostReviewMessage({ ok: false, reason: 'recheck_failed' }, 'tray')).toBe(POST_RECHECK_FAILED_MESSAGE);
  });
});

describe('describeBulkPostFailure', () => {
  it('says only this target was not posted when the database refuses the version', () => {
    expect(describeBulkPostFailure({ message: 'INVOICE_CHANGED_SINCE_REVIEW: invoice x' })).toBe(BULK_TARGET_CHANGED_MESSAGE);
    expect(BULK_TARGET_CHANGED_MESSAGE).not.toMatch(/nothing was posted/);
    expect(describeBulkPostFailure({ message: 'PRICING_INCOMPLETE' })).toBe('needs pricing first');
    expect(describeBulkPostFailure(new Error('post failed'))).toBe('post failed');
  });
});

describe('postReviewedInvoice / postReviewedInvoiceGroup', () => {
  it('refuse before any RPC when the version is missing or malformed (never an unversioned post)', async () => {
    for (const version of [undefined, '', 'ABC', `${V1}0`]) {
      await expect(postReviewedInvoice({ p_invoice_id: 'inv-1', p_idempotency_key: 'k', p_expected_version: version as unknown as string }))
        .rejects.toThrow(/needs the reviewed posting version/);
      await expect(postReviewedInvoiceGroup({ p_invoice_group_id: 'g', p_performed_by: 'u', p_idempotency_key: 'k', p_expected_version: version as unknown as string }))
        .rejects.toThrow(/needs the reviewed posting version/);
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
