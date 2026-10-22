import { describe, expect, it } from 'vitest';
import { buildPurchaseOrderEditItemsPayload } from './purchaseOrderEditPayload';

describe('buildPurchaseOrderEditItemsPayload', () => {
  it('preserves a received UUID and sends the exact sibling UUID selected for an unreceived line', () => {
    const payload = buildPurchaseOrderEditItemsPayload([
      {
        id: 'received-line',
        product_id: 'product-sibling-a',
        product_name: 'Same Name',
        unit_size: '2.5 GL',
        quantity_ordered: '10',
        unit_cost: '100',
        quantity_received: 4,
      },
      {
        id: 'editable-line',
        product_id: 'product-sibling-b',
        product_name: 'Same Name',
        unit_size: '30 GL',
        quantity_ordered: '2',
        unit_cost: '900.25',
        quantity_received: 0,
      },
    ], { includeCost: true });

    expect(payload.map(({ id, product_id, quantity_received }) => ({
      id,
      product_id,
      quantity_received,
    }))).toEqual([
      {
        id: 'received-line',
        product_id: 'product-sibling-a',
        quantity_received: 4,
      },
      {
        id: 'editable-line',
        product_id: 'product-sibling-b',
        quantity_received: 0,
      },
    ]);
  });

  it('rejects an invalid ordered quantity before building the RPC payload', () => {
    expect(() => buildPurchaseOrderEditItemsPayload([{
      id: 'invalid-line',
      product_id: 'product-id',
      product_name: 'Product',
      unit_size: 'Gal',
      quantity_ordered: '',
      unit_cost: '10',
      quantity_received: 0,
    }], { includeCost: true })).toThrow('Invalid quantity ordered for purchase order line invalid-line');
  });

  it.each(['', '  ', '10.005', '-1', '1e2', '$5'])('refuses unit cost %j instead of sending $0 or rounding', (cost) => {
    expect(() => buildPurchaseOrderEditItemsPayload([{
      id: 'cost-line',
      product_id: 'product-id',
      product_name: 'Product',
      unit_size: 'Gal',
      quantity_ordered: '1',
      unit_cost: cost,
      quantity_received: 0,
    }], { includeCost: true })).toThrow('Invalid unit cost for purchase order line cost-line');
  });

  it('sends exact cents for a two-decimal cost, and no cost at all for a non-admin', () => {
    const line = {
      id: 'cost-line', product_id: 'product-id', product_name: 'Product', unit_size: 'Gal',
      quantity_ordered: '1', unit_cost: '0.29', quantity_received: 0,
    };
    expect(buildPurchaseOrderEditItemsPayload([line], { includeCost: true })[0]).toMatchObject({ unit_cost: 0.29, unit_cost_cents: 29 });
    expect(buildPurchaseOrderEditItemsPayload([{ ...line, unit_cost: '' }], { includeCost: false })[0]).not.toHaveProperty('unit_cost_cents');
  });
});
