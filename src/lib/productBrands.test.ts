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
    supabaseUntyped: { rpc: mockRpc },
    assertRpcResult: mockAssertRpcResult,
    supabase: { from: vi.fn() },
  };
});

import {
  EPA_REGISTRATION_PATTERN,
  productBrandErrorMessage,
  saveProductBrand,
  suggestBrandNamesFromProductName,
} from './productBrands';

describe('suggestBrandNamesFromProductName', () => {
  it('reads the brand list inside the parentheses', () => {
    expect(suggestBrandNamesFromProductName('Roundup 5.4# Generic (Ag Saver 5.4, Slam 5.4) - 2.5 Gal'))
      .toEqual(['Ag Saver 5.4', 'Slam 5.4']);
    expect(suggestBrandNamesFromProductName('Gen Liberty: Higher Quality (Interline, Inflame) - 2.5 Gal'))
      .toEqual(['Interline', 'Inflame']);
  });

  it('leaves out names already listed, ignoring case, and duplicates', () => {
    expect(suggestBrandNamesFromProductName('Gen Stinger: (Bite, CleanSlate, bite) - 2.5 Gal', ['cleanslate']))
      .toEqual(['Bite']);
  });

  it('suggests nothing for a name without parentheses', () => {
    expect(suggestBrandNamesFromProductName('Callisto - 1 Gal')).toEqual([]);
  });
});

describe('EPA_REGISTRATION_PATTERN', () => {
  it('accepts registration and distributor numbers and refuses anything else', () => {
    expect(EPA_REGISTRATION_PATTERN.test('524-475')).toBe(true);
    expect(EPA_REGISTRATION_PATTERN.test('100-1234-5905')).toBe(true);
    expect(EPA_REGISTRATION_PATTERN.test('524')).toBe(false);
    expect(EPA_REGISTRATION_PATTERN.test('524-475 ')).toBe(false);
    expect(EPA_REGISTRATION_PATTERN.test('EPA 524-475')).toBe(false);
  });

  it('matches the EPA lookup: no zero-led part, at most 6, 5 and 6 digits', () => {
    expect(EPA_REGISTRATION_PATTERN.test('123456-12345-123456')).toBe(true);
    expect(EPA_REGISTRATION_PATTERN.test('0-1')).toBe(false);
    expect(EPA_REGISTRATION_PATTERN.test('524-0475')).toBe(false);
    expect(EPA_REGISTRATION_PATTERN.test('1234567-1')).toBe(false);
    expect(EPA_REGISTRATION_PATTERN.test('524-123456')).toBe(false);
    expect(EPA_REGISTRATION_PATTERN.test('524-475-1234567')).toBe(false);
  });
});

describe('saveProductBrand', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockAssertRpcResult.mockClear();
  });

  it('sends a new brand with blanks as NULL and the retry key', async () => {
    mockRpc.mockResolvedValue({ data: { id: 'b1', brand_name: 'Slam 5.4' }, error: null });
    await saveProductBrand({
      productId: 'p1',
      brandName: '  Slam 5.4 ',
      epaRegistration: ' ',
      manufacturer: '',
      isCurrentlySourced: true,
      isRup: null,
      signalWord: null,
    }, 'key-1');
    expect(mockRpc).toHaveBeenCalledWith('upsert_product_brand', {
      p_product_id: 'p1',
      p_brand_id: null,
      p_expected_row_version: null,
      p_brand_name: 'Slam 5.4',
      p_epa_registration: null,
      p_manufacturer: null,
      p_is_currently_sourced: true,
      p_is_rup: null,
      p_signal_word: null,
      p_idempotency_key: 'key-1',
    });
    expect(mockAssertRpcResult).toHaveBeenCalledWith({ id: 'b1', brand_name: 'Slam 5.4' }, 'upsert_product_brand');
  });

  it('sends an edit with the version it read', async () => {
    mockRpc.mockResolvedValue({ data: { id: 'b1' }, error: null });
    await saveProductBrand({
      productId: 'p1',
      brandId: 'b1',
      expectedRowVersion: 3,
      brandName: 'Slam 5.4',
      epaRegistration: '524-475',
      manufacturer: 'Bayer',
      isCurrentlySourced: false,
      isRup: false,
      signalWord: 'Caution',
    }, 'key-2');
    expect(mockRpc.mock.calls[0][1]).toMatchObject({
      p_brand_id: 'b1',
      p_expected_row_version: 3,
      p_epa_registration: '524-475',
      p_manufacturer: 'Bayer',
      p_is_currently_sourced: false,
      p_is_rup: false,
      p_signal_word: 'Caution',
    });
  });

  it('throws the database error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'BRAND_NAME_TAKEN: x' } });
    await expect(saveProductBrand({
      productId: 'p1', brandName: 'x', epaRegistration: '', manufacturer: '',
      isCurrentlySourced: true, isRup: null, signalWord: null,
    }, 'k')).rejects.toMatchObject({ message: 'BRAND_NAME_TAKEN: x' });
  });
});

describe('productBrandErrorMessage', () => {
  it('turns the database refusals into plain English', () => {
    expect(productBrandErrorMessage({ message: 'BRAND_NAME_TAKEN: this product already lists a brand named Slam' }))
      .toBe('This product already lists a brand with that name.');
    expect(productBrandErrorMessage({ message: 'BRAND_CHANGED: someone else changed this brand' }))
      .toBe('Someone else changed this brand. The list has been reloaded; open it again to edit.');
    expect(productBrandErrorMessage({ message: 'BRAND_NAME_TAKENX: not our token' }))
      .not.toBe('This product already lists a brand with that name.');
    expect(productBrandErrorMessage({ message: 'NOT_AUTHORIZED: only an admin' }))
      .toBe('Only an admin can change a product’s brands.');
  });
});
