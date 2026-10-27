import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));

vi.mock('./db', async () => {
  const actual = await vi.importActual<typeof import('./db')>('./db');
  return { assertRpcResult: actual.assertRpcResult, supabase: { rpc: mockRpc } };
});

import {
  LAST_CHARGED_MAX_PRODUCTS,
  fetchLastChargedPrices,
  formatChargedOn,
  formatChargedTier,
} from './lastChargedPrices';

const row = {
  product_id: 'p1', unit_price_cents: 4250, price_tier: 2, unit_size: '2.5 gal', charged_on: '2026-03-03', source: 'invoice',
};

describe('fetchLastChargedPrices', () => {
  beforeEach(() => mockRpc.mockReset());

  it('asks once per distinct product and returns the charges by product', async () => {
    mockRpc.mockResolvedValue({ data: [row, { ...row, product_id: 'p2', price_tier: null, source: 'order' }], error: null });
    const byProduct = await fetchLastChargedPrices('c1', ['p1', 'p2', 'p1', '']);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('get_last_charged_prices', { p_customer_id: 'c1', p_product_ids: ['p1', 'p2'] });
    expect(byProduct.get('p1')).toEqual(row);
    expect(byProduct.get('p2')?.price_tier).toBeNull();
    expect(byProduct.get('p2')?.source).toBe('order');
  });

  it('makes no call when the quote has no products', async () => {
    expect((await fetchLastChargedPrices('c1', [])).size).toBe(0);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('splits a long product list into calls the database accepts', async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    const ids = Array.from({ length: LAST_CHARGED_MAX_PRODUCTS + 1 }, (_, i) => `p${i}`);
    await fetchLastChargedPrices('c1', ids);
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc.mock.calls[0][1].p_product_ids).toHaveLength(LAST_CHARGED_MAX_PRODUCTS);
    expect(mockRpc.mock.calls[1][1].p_product_ids).toEqual([`p${LAST_CHARGED_MAX_PRODUCTS}`]);
  });

  it('throws the database error', async () => {
    const error = new Error('Permission denied: requires admin or sales_rep role');
    mockRpc.mockResolvedValue({ data: null, error });
    await expect(fetchLastChargedPrices('c1', ['p1'])).rejects.toBe(error);
  });

  it('refuses a price that is not whole cents, an unknown tier or an unknown source', async () => {
    for (const bad of [{ unit_price_cents: 42.5 }, { unit_price_cents: '4250' }, { price_tier: 4 }, { source: 'quote' }, { unit_size: 5 }]) {
      mockRpc.mockResolvedValue({ data: [{ ...row, ...bad }], error: null });
      await expect(fetchLastChargedPrices('c1', ['p1'])).rejects.toThrow(/get_last_charged_prices/);
    }
  });
});

describe('formatting', () => {
  it('shows the charge date as a calendar date and the tier, or that it is unknown', () => {
    expect(formatChargedOn('2026-03-03')).toBe('Mar 3, 2026');
    expect(formatChargedOn('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatChargedTier(3)).toBe('Tier 3');
    expect(formatChargedTier(null)).toBe('Tier unknown');
  });
});
