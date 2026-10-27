import { describe, expect, it } from 'vitest';
import { priceToCents, sellPricePoints, sourceLabel, timeFraction, type SellPriceHistoryRow } from './sellPriceHistory';

const row = (over: Partial<SellPriceHistoryRow>): SellPriceHistoryRow => ({
  id: 'h1', changed_at: '2026-10-26T15:00:00Z', change_source: 'product_page', change_reason: null, change_note: null,
  old_tier1_price: 10, new_tier1_price: 10, old_tier2_price: 9.5, new_tier2_price: 9.5,
  old_tier3_price: null, new_tier3_price: null, ...over,
});

describe('priceToCents', () => {
  it('reads whole-cent dollar prices exactly and refuses anything else', () => {
    expect(priceToCents(42.5)).toBe(4250);
    expect(priceToCents('19.99')).toBe(1999);
    expect(priceToCents(0.07)).toBe(7);
    expect(priceToCents(100)).toBe(10000);
    expect(priceToCents(null)).toBeNull();
    expect(() => priceToCents(1.005)).toThrow(/whole cents/);
    expect(() => priceToCents('abc')).toThrow(/whole cents/);
    // Beyond what an integer holds exactly: refused, never shown rounded.
    expect(() => priceToCents('90071992547409.93')).toThrow(/too large/);
    expect(priceToCents('9999999999.99')).toBe(999999999999);
  });
});

describe('sellPricePoints', () => {
  it('keeps the starting point and every tier price change, and drops cost-only rows', () => {
    const points = sellPricePoints([
      row({ id: 'start', change_source: 'starting_snapshot', change_reason: 'Prices when price history started' }),
      row({ id: 'cost-only', change_source: 'pricing_worksheet' }),
      row({ id: 'raise', change_source: 'pricing_worksheet', old_tier1_price: 10, new_tier1_price: 11, change_reason: 'Wells letter' }),
    ]);
    expect(points.map((p) => p.id)).toEqual(['start', 'raise']);
    expect(points[0]).toMatchObject({ isStartingPoint: true, cents: { tier1: 1000, tier2: 950, tier3: null } });
    expect(points[1]).toMatchObject({ isStartingPoint: false, previousCents: { tier1: 1000 }, cents: { tier1: 1100 }, reason: 'Wells letter' });
  });

  it('puts the starting snapshot first even when a change carries an earlier timestamp', () => {
    const points = sellPricePoints([
      row({ id: 'raced', change_source: 'product_page', changed_at: '2026-10-27T03:00:00Z', old_tier1_price: 10, new_tier1_price: 11 }),
      row({ id: 'start', change_source: 'starting_snapshot', changed_at: '2026-10-27T03:00:01Z' }),
    ]);
    expect(points.map((p) => p.id)).toEqual(['start', 'raced']);
  });

  it('falls back to the note when a row has no reason', () => {
    const [point] = sellPricePoints([row({ old_tier1_price: 9, change_note: 'Products list pricing update' })]);
    expect(point.reason).toBe('Products list pricing update');
  });
});

describe('timeFraction', () => {
  it('places an instant by time between the axis ends', () => {
    expect(timeFraction('2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-31T00:00:00Z')).toBe(0);
    expect(timeFraction('2026-07-16T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-31T00:00:00Z')).toBeCloseTo(0.5);
    expect(timeFraction('2026-07-31T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-31T00:00:00Z')).toBe(1);
    expect(timeFraction('2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')).toBe(0.5);
  });
});

describe('sourceLabel', () => {
  it('names each source, and anything unknown as another change', () => {
    expect(sourceLabel('starting_snapshot')).toBe('Starting point');
    expect(sourceLabel('pricing_worksheet')).toBe('Price sheet');
    expect(sourceLabel('something_new')).toBe('Other change');
  });
});
