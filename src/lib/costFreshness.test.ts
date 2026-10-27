import { describe, expect, it } from 'vitest';
import { costAgeDays, costAsOfDate, isCostStale, staleCostRows } from './costFreshness';

describe('cost freshness', () => {
  it('dates a cost by the Central business day it changed, not the UTC day', () => {
    // 03:30 UTC on Oct 2 is still Oct 1 in Chicago.
    expect(costAsOfDate('2026-10-02T03:30:00Z')).toBe('2026-10-01');
    expect(costAsOfDate('2026-10-02T15:00:00+00:00')).toBe('2026-10-02');
    expect(costAsOfDate('2026-07-28')).toBe('2026-07-28');
    expect(costAsOfDate(null)).toBeNull();
    expect(costAsOfDate('not a date')).toBeNull();
  });

  it('counts whole days to today, never negative', () => {
    expect(costAgeDays('2026-10-01', '2026-10-26')).toBe(25);
    expect(costAgeDays('2026-10-26', '2026-10-26')).toBe(0);
    expect(costAgeDays('2026-10-27', '2026-10-26')).toBe(0);
    // Across the spring-forward change: still whole days.
    expect(costAgeDays('2026-03-07', '2026-03-09')).toBe(2);
    expect(costAgeDays(null, '2026-10-26')).toBeNull();
  });

  it('calls a cost stale past the limit, or with no date', () => {
    expect(isCostStale(90, 90)).toBe(false);
    expect(isCostStale(91, 90)).toBe(true);
    expect(isCostStale(null, 365)).toBe(true);
  });

  it('lists stale products with no date first, then oldest first', () => {
    const rows = staleCostRows([
      { id: '1', product_name: 'Fresh', current_cost: 10, cost_updated_date: '2026-10-20T15:00:00Z' },
      { id: '2', product_name: 'Old', current_cost: 12, cost_updated_date: '2026-01-05T15:00:00Z' },
      { id: '3', product_name: 'Older', current_cost: 9, cost_updated_date: '2025-11-01T15:00:00Z' },
      { id: '4', product_name: 'No date', current_cost: 5, cost_updated_date: null },
      { id: '5', product_name: 'Edge', current_cost: 7, cost_updated_date: '2026-07-28T15:00:00Z' },
    ], 90, '2026-10-26');
    expect(rows.map((r) => [r.product_name, r.cost_age_days])).toEqual([
      ['No date', null],
      ['Older', 359],
      ['Old', 294],
    ]);
    expect(rows[1]).toMatchObject({ id: '3', current_cost: 9, cost_as_of: '2025-11-01', sku: null, vendor: null });
  });
});
