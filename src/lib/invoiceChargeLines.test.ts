import { describe, expect, it } from 'vitest';
import { CHARGE_TYPE_OPTIONS, chargeTypeLabel, fromScratchLinesProblem, isFromScratchInvoice } from './invoiceChargeLines';

describe('isFromScratchInvoice', () => {
  it('is a misc_charge or chemical_sale with no order and no delivery', () => {
    expect(isFromScratchInvoice({ invoice_type: 'misc_charge' })).toBe(true);
    expect(isFromScratchInvoice({ invoice_type: 'chemical_sale', order_id: null, delivery_id: null })).toBe(true);
  });

  it('is never an order- or delivery-backed invoice, a field invoice or a credit memo', () => {
    expect(isFromScratchInvoice({ invoice_type: 'chemical_sale', order_id: 'o1' })).toBe(false);
    expect(isFromScratchInvoice({ invoice_type: 'misc_charge', delivery_id: 'd1' })).toBe(false);
    expect(isFromScratchInvoice({ invoice_type: 'field_application' })).toBe(false);
    expect(isFromScratchInvoice({ invoice_type: 'credit_memo' })).toBe(false);
  });
});

describe('fromScratchLinesProblem', () => {
  const charge = { product_id: null, charge_type: 'freight' as const, description: 'Freight', quantity: 1, unit_price_cents: 2500 };

  it('passes typed charges with a description and an amount', () => {
    expect(fromScratchLinesProblem([charge, { ...charge, charge_type: 'other' }])).toBeNull();
    expect(fromScratchLinesProblem([])).toBeNull();
  });

  it('refuses a product line, an untyped line, a blank description and a $0 amount', () => {
    expect(fromScratchLinesProblem([{ ...charge, product_id: 'p1', charge_type: null }])).toMatch(/cannot carry products/);
    expect(fromScratchLinesProblem([{ ...charge, charge_type: null }])).toBe('Pick a charge type for every line.');
    expect(fromScratchLinesProblem([{ ...charge, description: '  ' }])).toBe('Add a description to every charge.');
    expect(fromScratchLinesProblem([{ ...charge, unit_price_cents: 0 }])).toBe('Every charge needs an amount above $0.00.');
    expect(fromScratchLinesProblem([{ ...charge, quantity: 2 }])).toMatch(/one amount/);
  });
});

describe('charge types', () => {
  it('are exactly the four the database accepts (invoice_items_charge_type_check)', () => {
    expect(CHARGE_TYPE_OPTIONS.map((o) => o.value)).toEqual(['freight', 'application_fee', 'service', 'other']);
    expect(chargeTypeLabel('application_fee')).toBe('Application fee');
    expect(chargeTypeLabel(null)).toBe('');
  });
});
