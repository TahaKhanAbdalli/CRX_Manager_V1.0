/**
 * invoiceBulkPostReview.test.ts — the bulk Post review reads every posting version FIRST, then
 * re-reads the rows the screen showed, and refuses on any change (Codex Luna HIGH, 2026-10-12).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFrom, mockReadInvoice, mockReadGroup, events } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockReadInvoice: vi.fn(),
  mockReadGroup: vi.fn(),
  events: [] as string[],
}));

vi.mock('./db', () => ({ supabase: { from: mockFrom } }));
vi.mock('./invoicePostVersion', async () => {
  const actual = await vi.importActual<typeof import('./invoicePostVersion')>('./invoicePostVersion');
  return { ...actual, fetchInvoicePostVersion: mockReadInvoice, fetchInvoiceGroupPostVersion: mockReadGroup };
});

import {
  failedPostReviewMessage,
  reviewInvoicePostTargets,
  shownRowsForTargets,
  type InvoicePostShownRow,
} from './invoiceBulkPostReview';
import { POST_RECHECK_FAILED_MESSAGE } from './invoicePostVersion';

const V1 = '11111111111111111111111111111111';
const VG = '99999999999999999999999999999999';

function shown(id: string, overrides: Partial<InvoicePostShownRow> = {}): InvoicePostShownRow {
  return {
    id,
    status: 'draft',
    total_amount_cents: 500000,
    customer_id: 'cust-1',
    invoice_date: '2026-10-05',
    invoice_group_id: null,
    ...overrides,
  };
}

/** What the database holds now: the shown row plus deleted_at / updated_at, with overrides. */
function current(row: InvoicePostShownRow, overrides: Record<string, unknown> = {}) {
  return { updated_at: '2026-10-05T10:00:00+00:00', deleted_at: null, ...row, invoice_group_id: row.invoice_group_id ?? null, ...overrides };
}

/** A from('invoices').select(...).in('id', chunk) chain answering from `rows`. */
function rereadReturns(rows: Record<string, unknown>[], error: unknown = null) {
  mockFrom.mockImplementation((table: string) => {
    events.push(`from:${table}`);
    const chain = {
      select: vi.fn(() => chain),
      in: vi.fn((_column: string, ids: string[]) => {
        events.push(`reread:${ids.length}`);
        return Promise.resolve(error ? { data: null, error } : { data: rows.filter((r) => ids.includes(r.id as string)), error: null });
      }),
    };
    return chain;
  });
}

describe('reviewInvoicePostTargets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    events.length = 0;
    mockReadInvoice.mockImplementation(async (id: string) => { events.push(`version:${id}`); return V1; });
    mockReadGroup.mockImplementation(async (id: string) => { events.push(`group-version:${id}`); return VG; });
  });

  it('reads every version before re-reading any row, and keys the versions by target key', async () => {
    const rows = [shown('inv-1'), shown('inv-2', { invoice_group_id: 'grp-1' }), shown('inv-3', { invoice_group_id: 'grp-1', customer_id: 'cust-2' })];
    rereadReturns(rows.map((r) => current(r)));

    const review = await reviewInvoicePostTargets(
      [{ key: 'invoice:inv-1', invoiceId: 'inv-1' }, { key: 'group:grp-1', invoiceGroupId: 'grp-1' }],
      rows,
    );

    expect(review).toEqual({ ok: true, versions: new Map([['invoice:inv-1', V1], ['group:grp-1', VG]]) });
    expect(mockReadInvoice).toHaveBeenCalledWith('inv-1');
    expect(mockReadGroup).toHaveBeenCalledWith('grp-1');
    const firstRowRead = events.findIndex((e) => e.startsWith('from:'));
    const lastVersionRead = Math.max(events.lastIndexOf('version:inv-1'), events.lastIndexOf('group-version:grp-1'));
    expect(firstRowRead).toBeGreaterThan(lastVersionRead);
    expect(mockFrom).toHaveBeenCalledWith('invoices');
  });

  it('refuses as changed when a total differs from what the screen showed', async () => {
    const row = shown('inv-1', { total_amount_cents: 500000 });
    rereadReturns([current(row, { total_amount_cents: 700000 })]);

    const review = await reviewInvoicePostTargets([{ key: 'k1', invoiceId: 'inv-1' }], [row]);

    expect(review).toEqual({ ok: false, reason: 'changed', changedIds: ['inv-1'] });
  });

  it.each([
    ['status', { status: 'posted' }],
    ['customer', { customer_id: 'cust-9' }],
    ['invoice date', { invoice_date: '2026-11-01' }],
    ['split group', { invoice_group_id: 'grp-new' }],
  ])('refuses as changed when the %s differs', async (_label, change) => {
    const row = shown('inv-1');
    rereadReturns([current(row, change)]);

    const review = await reviewInvoicePostTargets([{ key: 'k1', invoiceId: 'inv-1' }], [row]);

    expect(review).toEqual({ ok: false, reason: 'changed', changedIds: ['inv-1'] });
  });

  it('refuses as changed when a shown row is missing now', async () => {
    const rows = [shown('inv-1'), shown('inv-2')];
    rereadReturns([current(rows[0])]);

    const review = await reviewInvoicePostTargets(
      [{ key: 'k1', invoiceId: 'inv-1' }, { key: 'k2', invoiceId: 'inv-2' }],
      rows,
    );

    expect(review).toEqual({ ok: false, reason: 'changed', changedIds: ['inv-2'] });
  });

  it('refuses as changed when a shown row was deleted', async () => {
    const row = shown('inv-1');
    rereadReturns([current(row, { deleted_at: '2026-10-06T09:00:00+00:00' })]);

    const review = await reviewInvoicePostTargets([{ key: 'k1', invoiceId: 'inv-1' }], [row]);

    expect(review).toEqual({ ok: false, reason: 'changed', changedIds: ['inv-1'] });
  });

  it('compares updated_at only when the screen loaded it', async () => {
    const withStamp = shown('inv-1', { updated_at: '2026-10-05T10:00:00+00:00' });
    rereadReturns([current(withStamp, { updated_at: '2026-10-05T10:05:00+00:00' })]);
    expect(await reviewInvoicePostTargets([{ key: 'k1', invoiceId: 'inv-1' }], [withStamp]))
      .toEqual({ ok: false, reason: 'changed', changedIds: ['inv-1'] });

    const withoutStamp = shown('inv-1');
    rereadReturns([current(withoutStamp, { updated_at: '2026-10-05T10:05:00+00:00' })]);
    expect(await reviewInvoicePostTargets([{ key: 'k1', invoiceId: 'inv-1' }], [withoutStamp]))
      .toEqual({ ok: true, versions: new Map([['k1', V1]]) });
  });

  it('a version read failure is recheck_failed, with no row read', async () => {
    mockReadInvoice.mockRejectedValueOnce(new Error('INVOICING_ADMIN_ONLY'));
    rereadReturns([current(shown('inv-1'))]);

    const review = await reviewInvoicePostTargets([{ key: 'k1', invoiceId: 'inv-1' }], [shown('inv-1')]);

    expect(review).toEqual({ ok: false, reason: 'recheck_failed' });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('a row query error is recheck_failed', async () => {
    rereadReturns([], { message: 'network down' });

    const review = await reviewInvoicePostTargets([{ key: 'k1', invoiceId: 'inv-1' }], [shown('inv-1')]);

    expect(review).toEqual({ ok: false, reason: 'recheck_failed' });
  });

  it('reads at most 6 versions at a time and re-reads rows in chunks of at most 100', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockReadInvoice.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return V1;
    });
    const rows = Array.from({ length: 150 }, (_, i) => shown(`inv-${i}`));
    rereadReturns(rows.map((r) => current(r)));

    const review = await reviewInvoicePostTargets(rows.map((r) => ({ key: r.id, invoiceId: r.id })), rows);

    expect(review.ok).toBe(true);
    expect(mockReadInvoice).toHaveBeenCalledTimes(150);
    expect(maxInFlight).toBe(6);
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
  it('names how many invoices changed, or that the check could not run', () => {
    expect(failedPostReviewMessage({ ok: false, reason: 'changed', changedIds: ['a', 'b'] }))
      .toBe('2 invoice(s) changed since this list loaded — the list was reloaded; check them and post again.');
    expect(failedPostReviewMessage({ ok: false, reason: 'recheck_failed' })).toBe(POST_RECHECK_FAILED_MESSAGE);
  });
});
