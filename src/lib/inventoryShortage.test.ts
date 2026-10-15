/**
 * Unit cover for the per-product need aggregation. The tier-split behaviour
 * that motivated this helper is proven end-to-end against the real page in
 * src/pages/Orders.pickListShortage.test.tsx; these cases pin the input
 * guards, which that page test cannot reach.
 */
import { describe, expect, it } from 'vitest';
import { findShortDeliveries, sumNeedByProduct } from './inventoryShortage';

describe('sumNeedByProduct', () => {
  it('adds every tier line of the same product into one need', () => {
    expect(
      sumNeedByProduct([
        { productId: 'p1', label: 'Concentrate', quantity: 6 },
        { productId: 'p1', label: 'Concentrate', quantity: 6 },
        { productId: 'p2', label: 'Surfactant', quantity: 2 },
      ])
    ).toEqual([
      { productId: 'p1', label: 'Concentrate', quantity: 12 },
      { productId: 'p2', label: 'Surfactant', quantity: 2 },
    ]);
  });

  it('keeps the order the operator sees the lines in', () => {
    const result = sumNeedByProduct([
      { productId: 'p2', label: 'Second', quantity: 1 },
      { productId: 'p1', label: 'First', quantity: 1 },
      { productId: 'p2', label: 'Second', quantity: 1 },
    ]);
    expect(result.map((need) => need.productId)).toEqual(['p2', 'p1']);
  });

  it('ignores lines that cannot represent real demand', () => {
    expect(
      sumNeedByProduct([
        { productId: '', label: 'No product', quantity: 5 },
        { productId: 'p1', label: 'Zero', quantity: 0 },
        { productId: 'p1', label: 'Negative', quantity: -3 },
        { productId: 'p1', label: 'Not a number', quantity: Number.NaN },
        { productId: 'p1', label: 'Infinite', quantity: Number.POSITIVE_INFINITY },
      ])
    ).toEqual([]);
  });

  it('does not let a skipped line strip the quantity off a real one', () => {
    expect(
      sumNeedByProduct([
        { productId: 'p1', label: 'Real', quantity: 4 },
        { productId: 'p1', label: 'Zero', quantity: 0 },
      ])
    ).toEqual([{ productId: 'p1', label: 'Real', quantity: 4 }]);
  });

  it('borrows a later label when the first line has none', () => {
    expect(
      sumNeedByProduct([
        { productId: 'p1', label: '', quantity: 1 },
        { productId: 'p1', label: 'Named later', quantity: 1 },
      ])
    ).toEqual([{ productId: 'p1', label: 'Named later', quantity: 2 }]);
  });

  it('returns nothing for no lines', () => {
    expect(sumNeedByProduct([])).toEqual([]);
  });
});

describe('findShortDeliveries', () => {
  it('flags every delivery that shares a product whose combined need exceeds stock', () => {
    // 10 on hand: each delivery fits alone (6), together they need 12.
    const short = findShortDeliveries(
      [
        { deliveryId: 'd1', productId: 'p1', quantity: 6 },
        { deliveryId: 'd2', productId: 'p1', quantity: 6 },
        { deliveryId: 'd3', productId: 'p2', quantity: 1 },
      ],
      { p1: 10, p2: 5 }
    );
    expect([...short].sort()).toEqual(['d1', 'd2']);
  });

  it('stays quiet when the combined need fits exactly', () => {
    expect(
      findShortDeliveries(
        [
          { deliveryId: 'd1', productId: 'p1', quantity: 6 },
          { deliveryId: 'd2', productId: 'p1', quantity: 4 },
        ],
        { p1: 10 }
      ).size
    ).toBe(0);
  });

  it('still flags a delivery that is short on its own', () => {
    expect([...findShortDeliveries([{ deliveryId: 'd1', productId: 'p1', quantity: 3 }], { p1: 2 })]).toEqual(['d1']);
  });

  it('treats a product with no stock row as zero on hand', () => {
    expect([...findShortDeliveries([{ deliveryId: 'd1', productId: 'p9', quantity: 1 }], {})]).toEqual(['d1']);
  });

  it('does not flag decimal needs that fit exactly despite float rounding', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point.
    expect(
      findShortDeliveries(
        [
          { deliveryId: 'd1', productId: 'p1', quantity: 0.1 },
          { deliveryId: 'd2', productId: 'p1', quantity: 0.2 },
        ],
        { p1: 0.3 }
      ).size
    ).toBe(0);
  });

  it('treats a non-finite stock value as zero so the warning still shows', () => {
    expect([...findShortDeliveries([{ deliveryId: 'd1', productId: 'p1', quantity: 1 }], { p1: Number.NaN })]).toEqual(['d1']);
  });

  it('ignores non-positive, non-finite and unlinked lines', () => {
    expect(
      findShortDeliveries(
        [
          { deliveryId: 'd1', productId: 'p1', quantity: 0 },
          { deliveryId: 'd2', productId: 'p1', quantity: -5 },
          { deliveryId: 'd3', productId: 'p1', quantity: Number.NaN },
          { deliveryId: '', productId: 'p1', quantity: 50 },
          { deliveryId: 'd4', productId: '', quantity: 50 },
        ],
        { p1: 0 }
      ).size
    ).toBe(0);
  });
});
