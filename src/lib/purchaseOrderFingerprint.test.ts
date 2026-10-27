import { describe, expect, it } from 'vitest';
import { purchaseOrderPdfFingerprint } from './purchaseOrderFingerprint';

describe('purchaseOrderPdfFingerprint', () => {
  const header = {
    po_number: 'PO-2026-0040',
    vendor: 'Spinner Ag',
    status: 'submitted',
    submitted_date: '2026-10-27',
    expected_delivery_date: '2026-11-03',
    notes: 'Call ahead',
  };
  const lines = [
    { id: 'l-2', product_id: 'p-2', product: { product_name: 'Atrazine 4L', epa_registration: '100-497' }, quantity_ordered: 2, unit_cost: 19.99, unit_size: 'gal', notes: null },
    { id: 'l-1', product_id: 'p-1', product_name: 'Custom blend', product: null, quantity_ordered: 1, unit_cost: 5, unit_size: 'lb', notes: 'rush' },
  ];
  const base = purchaseOrderPdfFingerprint(header, lines);

  it('keeps the retry key when a receipt only moves the status to partly received', () => {
    // Same printed PDF, so a lost send retried after a receipt replays, never emails twice.
    expect(purchaseOrderPdfFingerprint({ ...header, status: 'partially_received' }, lines)).toBe(base);
    expect(purchaseOrderPdfFingerprint(header, [...lines].reverse())).toBe(base);
  });

  it('changes when anything the PDF prints changes, the status banner included', () => {
    for (const changed of [
      { ...header, status: 'draft' },
      { ...header, status: 'cancelled' },
      { ...header, po_number: 'PO-2026-0041' },
      { ...header, vendor: 'Hydrite' },
      { ...header, submitted_date: '2026-10-26' },
      { ...header, expected_delivery_date: null },
      { ...header, notes: null },
    ]) {
      expect(purchaseOrderPdfFingerprint(changed, lines)).not.toBe(base);
    }
    expect(purchaseOrderPdfFingerprint(header, [lines[0], { ...lines[1], unit_cost: 5.01 }])).not.toBe(base);
    expect(purchaseOrderPdfFingerprint(header, [lines[0]])).not.toBe(base);
  });
});
