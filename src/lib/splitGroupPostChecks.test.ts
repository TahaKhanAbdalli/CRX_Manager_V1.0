/**
 * splitGroupPostChecks.test.ts — To-Do 10.5 follow-up.
 *
 * Posting a split group posts every invoice in it, so the RUP-license and credit-limit
 * checks run over the whole group first. Any of those reads failing used to fall through
 * to a clean-looking post confirm (the group read's error was ignored, a failed RUP read
 * looked like "no RUP products", a failed credit read looked like "over the limit" or
 * "no limit"). Each failure must now stop with a could-not-check message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type FailMode = 'error' | 'nodata' | 'notlist' | 'throws';

const H = vi.hoisted(() => ({
  group: null as unknown,
  groupFail: null as FailMode | null,
  rup: vi.fn(),
  credit: vi.fn(),
}));

function groupRead(): Promise<{ data: unknown; error: unknown }> {
  if (H.groupFail === 'throws') return Promise.reject(new Error('Failed to fetch'));
  if (H.groupFail === 'error') return Promise.resolve({ data: null, error: { message: 'connection reset' } });
  if (H.groupFail === 'nodata') return Promise.resolve({ data: null, error: null });
  if (H.groupFail === 'notlist') return Promise.resolve({ data: { id: 'inv-1' }, error: null });
  return Promise.resolve({ data: H.group, error: null });
}

vi.mock('./db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'not']) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => groupRead().then(resolve, reject);
  return { supabaseUntyped: { from: () => chain } };
});
vi.mock('./rupCompliance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rupCompliance')>()),
  checkRUPCompliance: H.rup,
}));
vi.mock('./creditLimitGuard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./creditLimitGuard')>()),
  evaluateCreditLimit: H.credit,
}));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import { checkSplitGroupBeforePost, GROUP_CHECKS_FAILED_MESSAGE } from './splitGroupPostChecks';
import { RUP_POST_CHECK_FAILED_MESSAGE, type RUPComplianceResult } from './rupCompliance';
import { CREDIT_LIMIT_UNVERIFIED_MESSAGE } from './creditLimitGuard';

const rupResult = (p: Partial<RUPComplianceResult>): RUPComplianceResult => ({
  hasRUPProducts: false, hasValidLicense: false, expiredLicense: false, missingLicense: false,
  rupProductNames: [], warnings: [], checkFailed: false, ...p,
});

beforeEach(() => {
  H.group = [
    { invoice_number: 'INV-1', customer_id: 'c1', total_amount_cents: 5000, invoice_items: [{ product_id: 'p1' }] },
    { invoice_number: 'INV-2', customer_id: 'c2', total_amount_cents: 7000, invoice_items: [{ product_id: 'p2' }] },
  ];
  H.groupFail = null;
  H.rup.mockReset().mockResolvedValue(rupResult({}));
  H.credit.mockReset().mockResolvedValue({ status: 'ok' });
});

describe('checkSplitGroupBeforePost', () => {
  for (const mode of ['error', 'nodata', 'notlist', 'throws'] as const) {
    it(`stops when the group read ${mode === 'nodata' ? 'returns nothing' : mode}`, async () => {
      H.groupFail = mode;
      expect(await checkSplitGroupBeforePost('grp-1')).toEqual({ ok: false, message: GROUP_CHECKS_FAILED_MESSAGE });
      expect(H.rup).not.toHaveBeenCalled();
    });
  }

  it('stops when the group read answers no members, since nothing would be checked', async () => {
    H.group = [];
    expect(await checkSplitGroupBeforePost('grp-1')).toEqual({ ok: false, message: GROUP_CHECKS_FAILED_MESSAGE });
  });

  it('stops when a member\'s lines came back missing, instead of reading them as no products', async () => {
    H.group = [{ invoice_number: 'INV-1', customer_id: 'c1', total_amount_cents: 5000, invoice_items: null }];
    expect(await checkSplitGroupBeforePost('grp-1')).toEqual({ ok: false, message: RUP_POST_CHECK_FAILED_MESSAGE });
    expect(H.rup).not.toHaveBeenCalled();
  });

  it('stops when a member has products but no customer to check a license for', async () => {
    H.group = [{ invoice_number: 'INV-1', customer_id: null, total_amount_cents: 5000, invoice_items: [{ product_id: 'p1' }] }];
    expect(await checkSplitGroupBeforePost('grp-1')).toEqual({ ok: false, message: RUP_POST_CHECK_FAILED_MESSAGE });
  });

  it('stops when one member\'s RUP check could not run', async () => {
    H.rup.mockResolvedValueOnce(rupResult({})).mockResolvedValueOnce(rupResult({ checkFailed: true }));
    expect(await checkSplitGroupBeforePost('grp-1')).toEqual({ ok: false, message: RUP_POST_CHECK_FAILED_MESSAGE });
  });

  it('stops when one member\'s credit limit could not be verified, instead of calling it over the limit', async () => {
    H.credit.mockResolvedValueOnce({ status: 'ok' }).mockResolvedValueOnce({ status: 'unverified' });
    expect(await checkSplitGroupBeforePost('grp-1')).toEqual({ ok: false, message: `${CREDIT_LIMIT_UNVERIFIED_MESSAGE} Nothing was posted.` });
  });

  it('stops when a check throws', async () => {
    H.credit.mockRejectedValueOnce(new Error('boom'));
    expect(await checkSplitGroupBeforePost('grp-1')).toEqual({ ok: false, message: GROUP_CHECKS_FAILED_MESSAGE });
  });

  it('opens the confirm with no warning when every check reads cleanly', async () => {
    expect(await checkSplitGroupBeforePost('grp-1')).toEqual({ ok: true, warning: null });
  });

  it('opens the confirm with the RUP and over-limit findings as a warning', async () => {
    H.rup.mockResolvedValueOnce(rupResult({ hasRUPProducts: true, missingLicense: true, rupProductNames: ['Atrazine'] }));
    H.credit.mockResolvedValueOnce({ status: 'ok' }).mockResolvedValueOnce({ status: 'over', message: 'over' });
    const result = await checkSplitGroupBeforePost('grp-1');
    expect(result.ok).toBe(true);
    const warning = result.ok ? result.warning : '';
    expect(warning).toContain('INV-1: Atrazine — NO applicator license (NON-COMPLIANT)');
    expect(warning).toContain('Over credit limit: invoice(s) INV-2.');
  });
});
