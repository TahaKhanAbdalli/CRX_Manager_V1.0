import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRpc, mockAssertRpcResult } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockAssertRpcResult: vi.fn((data: unknown, name: string) => {
    if (data == null) throw new Error(`${name} returned no data`);
    return data;
  }),
}));

vi.mock('./db', async () => {
  const actual = await vi.importActual<typeof import('./db')>('./db');
  return {
    hasRpcCode: actual.hasRpcCode,
    RpcErrorCodes: actual.RpcErrorCodes,
    assertRpcResult: mockAssertRpcResult,
    supabase: { rpc: mockRpc, from: vi.fn() },
  };
});

import {
  formatMarginFloorPercent,
  formatNetMarginPercent,
  isUnderMarginFloor,
  marginFloorErrorMessage,
  parseMarginFloorPercent,
  setMarginFloors,
} from './marginFloors';

describe('parseMarginFloorPercent', () => {
  it('reads a percent with up to two decimals as a number, and blank as "no floor"', () => {
    expect(parseMarginFloorPercent('15')).toBe(15);
    expect(parseMarginFloorPercent(' 14.3 ')).toBe(14.3);
    expect(parseMarginFloorPercent('0')).toBe(0);
    expect(parseMarginFloorPercent('99.99')).toBe(99.99);
    expect(parseMarginFloorPercent('')).toBeNull();
    expect(parseMarginFloorPercent('   ')).toBeNull();
  });

  it('refuses 100 and up, negatives, three decimals and anything not a number', () => {
    for (const bad of ['100', '-1', '12.345', '1e1', 'abc', '15%', '.5']) {
      expect(() => parseMarginFloorPercent(bad), bad).toThrow(/0 to 99\.99/);
    }
  });
});

describe('formatMarginFloorPercent', () => {
  it('shows a stored ratio as the percent that was typed', () => {
    expect(formatMarginFloorPercent(0.143)).toBe('14.3');
    expect(formatMarginFloorPercent(0.15)).toBe('15');
    expect(formatMarginFloorPercent(0.9999)).toBe('99.99');
    expect(formatMarginFloorPercent(0)).toBe('0');
    expect(formatMarginFloorPercent(null)).toBe('');
    expect(formatMarginFloorPercent(undefined)).toBe('');
  });
});

describe('isUnderMarginFloor', () => {
  it('is true only when a margin is strictly below a set floor', () => {
    expect(isUnderMarginFloor(0.1, 0.15)).toBe(true);
    expect(isUnderMarginFloor(0.15, 0.15)).toBe(false);
    expect(isUnderMarginFloor(0.2, 0.15)).toBe(false);
    expect(isUnderMarginFloor(-0.05, 0)).toBe(true);
  });

  it('skips the check when the product has no floor or the tier has no margin', () => {
    expect(isUnderMarginFloor(0.01, null)).toBe(false);
    expect(isUnderMarginFloor(0.01, undefined)).toBe(false);
    expect(isUnderMarginFloor(null, 0.15)).toBe(false);
  });
});

describe('formatNetMarginPercent', () => {
  it('shows one decimal when not under a floor', () => {
    expect(formatNetMarginPercent(0.2, 0.15)).toBe('20.0');
    expect(formatNetMarginPercent(0.15, 0.15)).toBe('15.0');
    expect(formatNetMarginPercent(0.1234, null)).toBe('12.3');
  });

  it('shows two decimals under a floor and never rounds up to the floor', () => {
    expect(formatNetMarginPercent(0.1, 0.15)).toBe('10.00');
    expect(formatNetMarginPercent(0.14996, 0.15)).toBe('14.99');
    expect(formatNetMarginPercent(0.14994, 0.15)).toBe('14.99');
    expect(formatNetMarginPercent(0.143, 0.1435)).toBe('14.30');
    expect(formatNetMarginPercent(0.143496, 0.1435)).toBe('14.34');
    expect(formatNetMarginPercent(-0.00001, 0)).toBe('-0.01');
  });
});

describe('setMarginFloors', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockAssertRpcResult.mockClear();
  });

  it('sends percent (not a ratio) per product, the trimmed reason and the key, and checks the result', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'saved', changed_count: 2, unchanged_count: 0 }, error: null });
    const result = await setMarginFloors({
      changes: [{ productId: 'p1', marginFloorPercent: 14.3 }, { productId: 'p2', marginFloorPercent: null }],
      reason: '  supplier minimum  ',
      performedBy: 'u1',
      idempotencyKey: 'k1',
    });
    expect(mockRpc).toHaveBeenCalledWith('set_product_margin_floors', {
      p_items: [
        { product_id: 'p1', margin_floor_percent: 14.3 },
        { product_id: 'p2', margin_floor_percent: null },
      ],
      p_reason: 'supplier minimum',
      p_performed_by: 'u1',
      p_idempotency_key: 'k1',
    });
    expect(mockAssertRpcResult).toHaveBeenCalledWith(
      { status: 'saved', changed_count: 2, unchanged_count: 0 },
      'set_product_margin_floors',
    );
    expect(result.changed_count).toBe(2);
  });

  it('sends no reason when the reason is blank, and throws the database error', async () => {
    const error = { message: 'Permission denied: requires admin role' };
    mockRpc.mockResolvedValue({ data: null, error });
    await expect(setMarginFloors({ changes: [{ productId: 'p1', marginFloorPercent: 10 }], reason: ' ', performedBy: 'u1', idempotencyKey: 'k2' }))
      .rejects.toBe(error);
    expect(mockRpc.mock.calls[0][1].p_reason).toBeUndefined();
  });
});

describe('marginFloorErrorMessage', () => {
  it('explains the database refusals in plain English', () => {
    expect(marginFloorErrorMessage({ message: 'MARGIN_FLOOR_PERCENT_INVALID: a floor is 0 to 99.99 percent' }))
      .toMatch(/0 to 99\.99/);
    expect(marginFloorErrorMessage({ message: 'MARGIN_FLOOR_PRODUCT_NOT_FOUND: 7c31' })).toMatch(/no longer exists/);
    expect(marginFloorErrorMessage({ message: 'MARGIN_FLOOR_REASON_TOO_LONG: keep it short' })).toMatch(/500 characters/);
  });
});
