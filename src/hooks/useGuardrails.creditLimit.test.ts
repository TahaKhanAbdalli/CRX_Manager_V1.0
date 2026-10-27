/**
 * useGuardrails.creditLimit.test.ts — the credit-limit check compares the customer's whole open
 * exposure with their limit and never passes on a read it could not make.
 *
 * - Goal 4 L17: the balance read stopped at the server's 1,000-row cap; a failed read came back
 *   as "no invoices" and passed.
 * - To-Do 10.5 follow-up: a failed customer read came back as "no credit limit set" and passed,
 *   and a sales rep's own invoices read only sees the invoices they created or sell, so a customer
 *   billed by another rep, or with another rep's draft, looked under the limit (Sol on #1132). The
 *   limit and exposure now come from the server's customer_credit_exposure, which reads every
 *   rep's draft, unposted, posted and overdue invoices.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

type FailMode = 'error' | 'nodata' | 'notlist' | 'throws';

const H = vi.hoisted(() => ({
  // customer_credit_exposure's answer: bigint cents, a null limit meaning "no limit".
  exposure: null as unknown,
  exposureFail: null as FailMode | null,
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  // The name read for the warning text.
  farmName: 'Big Farm' as string | null,
  nameFail: null as FailMode | null,
}));

function answer(mode: FailMode | null, ok: unknown): Promise<{ data: unknown; error: unknown }> {
  if (mode === 'throws') return Promise.reject(new Error('Failed to fetch'));
  if (mode === 'error') return Promise.resolve({ data: null, error: { message: 'connection reset' } });
  if (mode === 'nodata') return Promise.resolve({ data: null, error: null });
  if (mode === 'notlist') return Promise.resolve({ data: 'not an object', error: null });
  return Promise.resolve({ data: ok, error: null });
}

vi.mock('../lib/db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq']) chain[m] = () => chain;
  chain.maybeSingle = () => answer(H.nameFail, H.farmName === null ? null : { farm_name: H.farmName });
  const client = {
    from: () => chain,
    rpc: (name: string, args: unknown) => { H.rpcCalls.push({ name, args }); return answer(H.exposureFail, H.exposure); },
  };
  return {
    supabase: client,
    supabaseUntyped: client,
    assertRpcResult: (data: unknown, name: string) => {
      if (data === null || data === undefined) throw new Error(`${name} returned no data`);
      return data;
    },
  };
});
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import { useCreditLimitCheck } from './useGuardrails';
import { evaluateCreditLimit } from '../lib/creditLimitGuard';

beforeEach(() => {
  // $1,005.00 open on the server, every rep's invoices, against a $1,002.00 limit.
  H.exposure = { customer_id: 'c1', credit_limit_cents: 100_200, exposure_cents: 100_500 };
  H.exposureFail = null;
  H.rpcCalls = [];
  H.farmName = 'Big Farm';
  H.nameFail = null;
});

async function runHook(newAmountCents: number) {
  const { result } = renderHook(() => useCreditLimitCheck());
  let passed: boolean | undefined;
  await act(async () => { passed = await result.current.check({ customerId: 'c1', newAmountCents }); });
  return { passed, warning: result.current.warning };
}

describe('credit-limit check on the server exposure', () => {
  it('warns when the whole exposure plus the new amount is over the limit', async () => {
    // $1,005.00 open + $1.00 new = $1,006.00 against $1,002.00: over by $4.00.
    const { passed, warning } = await runHook(100);
    expect(passed).toBe(false);
    expect(warning?.id).toBe('credit-limit');
    expect(warning?.message).toBe('This will put Big Farm $4.00 over their $1,002.00 credit limit.');
    expect(H.rpcCalls).toEqual([{ name: 'customer_credit_exposure', args: { p_customer_id: 'c1' } }]);
  });

  it('counts another rep\'s draft: the server total is the whole exposure', async () => {
    // $9,000 draft held by another rep + a $2,000 order against $10,000: over by $1,000.
    H.exposure = { customer_id: 'c1', credit_limit_cents: 1_000_000, exposure_cents: 900_000 };
    const result = await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 200_000 });
    expect(result).toEqual({ status: 'over', message: expect.stringContaining('$1,000.00 over') });
  });

  it('exactly at the limit is not over', async () => {
    H.exposure = { customer_id: 'c1', credit_limit_cents: 100_001, exposure_cents: 99_999 };
    expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 2 })).toEqual({ status: 'ok' });
    expect((await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 3 })).status).toBe('over');
  });

  it('a customer under the limit passes', async () => {
    H.exposure = { customer_id: 'c1', credit_limit_cents: 200_000, exposure_cents: 100_500 };
    const { passed, warning } = await runHook(100);
    expect(passed).toBe(true);
    expect(warning).toBeNull();
  });

  it('a customer with no limit set passes (the server returns a stored 0 as null)', async () => {
    H.exposure = { customer_id: 'c1', credit_limit_cents: null, exposure_cents: 5_000_000 };
    expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 100 })).toEqual({ status: 'ok' });
  });

  it('an over-limit warning still shows when the name read fails', async () => {
    H.nameFail = 'error';
    expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 100 })).toEqual({
      status: 'over', message: 'This will put This customer $4.00 over their $1,002.00 credit limit.',
    });
  });
});

describe('"Continue Anyway" overrides an over-limit warning, never a check that could not run', () => {
  async function checkWith(result: { current: ReturnType<typeof useCreditLimitCheck> }) {
    let passed: boolean | undefined;
    await act(async () => { passed = await result.current.check({ customerId: 'c1', newAmountCents: 100 }); });
    return passed;
  }

  it('over the limit, Continue Anyway lets the next check through once', async () => {
    const { result } = renderHook(() => useCreditLimitCheck());
    expect(await checkWith(result)).toBe(false);
    act(() => result.current.dismiss());
    expect(await checkWith(result)).toBe(true);
    expect(await checkWith(result)).toBe(false);
  });

  it('a check that could not run offers no override and stays stopped', async () => {
    H.exposureFail = 'error';
    const { result } = renderHook(() => useCreditLimitCheck());
    expect(await checkWith(result)).toBe(false);
    expect(result.current.warning).toMatchObject({ id: 'credit-limit-error', dismissible: false });
    act(() => result.current.dismiss());
    expect(result.current.warning?.dismissed).toBe(false);
    expect(await checkWith(result)).toBe(false);
  });

  it('an earlier override does not carry over to a check that could not run', async () => {
    const { result } = renderHook(() => useCreditLimitCheck());
    expect(await checkWith(result)).toBe(false);
    act(() => result.current.dismiss());
    H.exposureFail = 'error';
    expect(await checkWith(result)).toBe(false);
    H.exposureFail = null;
    // The override was spent by the failed check, so over the limit stops again.
    expect(await checkWith(result)).toBe(false);
  });
});

describe('credit-limit check fails closed on every failed read', () => {
  for (const mode of ['error', 'nodata', 'notlist', 'throws'] as const) {
    it(`an exposure read that ${mode === 'notlist' ? 'answers no object' : mode} is unverified, never a pass`, async () => {
      H.exposureFail = mode;
      expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 100 })).toEqual({ status: 'unverified' });
      const { passed, warning } = await runHook(100);
      expect(passed).toBe(false);
      expect(warning?.id).toBe('credit-limit-error');
    });
  }

  for (const [label, exposure] of [['missing', undefined], ['text', '100500'], ['negative', -5], ['fractional cents', 100.5], ['unsafe', 2 ** 60]] as const) {
    it(`an exposure that is ${label} is unverified`, async () => {
      H.exposure = { customer_id: 'c1', credit_limit_cents: 100_200, exposure_cents: exposure };
      expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 100 })).toEqual({ status: 'unverified' });
    });
  }

  it('an answer with no credit limit field is unverified, never "no limit" (Sol on #1132)', async () => {
    H.exposure = { customer_id: 'c1', exposure_cents: 0 };
    expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 100 })).toEqual({ status: 'unverified' });
  });

  for (const limit of ['bad', Number.NaN, 1000.5, 0, -100, undefined]) {
    it(`a credit limit of ${String(limit)} is unverified, never "no limit"`, async () => {
      H.exposure = { customer_id: 'c1', credit_limit_cents: limit, exposure_cents: 0 };
      expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 100 })).toEqual({ status: 'unverified' });
    });
  }

  it('an amount that is not whole cents is unverified, never a pass', async () => {
    expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: Number.NaN })).toEqual({ status: 'unverified' });
    expect(await evaluateCreditLimit({ customerId: 'c1', newAmountCents: 100.25 })).toEqual({ status: 'unverified' });
    expect(H.rpcCalls).toEqual([]);
  });
});
