import { describe, expect, it } from 'vitest';
import { buildPurchaseOrderEmailPayload, purchaseOrderEmailBlocker } from './emailService';
import { COMPANY_ORDERING_EMAIL } from './companyInfo';
import { PO_COPY_RECIPIENT } from '../../supabase/functions/_shared/purchaseOrderEmailGate';

const goodLines = [{ unit_cost: 12, cost_needs_review: false }];

describe('purchaseOrderEmailBlocker', () => {
  it('lets a submitted or partly received PO with confirmed costs through', () => {
    expect(purchaseOrderEmailBlocker({ status: 'submitted', lines: goodLines })).toBeNull();
    expect(purchaseOrderEmailBlocker({ status: 'partially_received', lines: goodLines })).toBeNull();
  });

  it('refuses the wrong status (pointing to the PDF), no lines, and unconfirmed or zero costs', () => {
    expect(purchaseOrderEmailBlocker({ status: 'draft', lines: goodLines })).toMatch(/submitted.*Download the PDF/);
    expect(purchaseOrderEmailBlocker({ status: 'submitted', lines: [] })).toMatch(/no lines/);
    expect(purchaseOrderEmailBlocker({ status: 'submitted', lines: [{ unit_cost: 0 }] })).toMatch(/Confirm the unit cost/);
    expect(purchaseOrderEmailBlocker({ status: 'submitted', lines: [{ unit_cost: 5, cost_needs_review: true }] })).toMatch(/Confirm the unit cost/);
  });
});

describe('buildPurchaseOrderEmailPayload', () => {
  const snapshot = {
    po_number: 'PO-2026-0040',
    vendor: 'Spinner Ag',
    submitted_date: '2026-10-27',
    expected_delivery_date: '2026-11-03',
    notes: null,
    lines: [{ id: 'l-1', product_id: 'p-1', product_name: 'Atrazine 4L', epa_registration: null, unit_size: 'gal', notes: null, quantity_ordered: 3, unit_cost: 19.99 }],
  };
  const input = {
    vendorName: 'Spinner <Ag>',
    purchaseOrderId: 'po-1',
    poNumber: 'PO-2026-0040',
    expectedDeliveryDate: '11/3/2026',
    attachmentBase64: 'QUJD',
    attachmentFilename: 'Purchase-Order-PO-2026-0040.pdf',
    idempotencyKey: 'key-1',
    snapshot,
  };

  it('sends the copy to the company ordering address, never a vendor, with no customer', () => {
    const payload = buildPurchaseOrderEmailPayload(input);
    expect(payload).toMatchObject({
      to: COMPANY_ORDERING_EMAIL,
      subject: 'PO copy PO-2026-0040 - Spinner <Ag>',
      email_type: 'purchase_order',
      resource_type: 'purchase_order',
      resource_id: 'po-1',
      idempotency_key: 'key-1',
      attachments: [{ filename: 'Purchase-Order-PO-2026-0040.pdf', content: 'QUJD' }],
      purchase_order_snapshot: snapshot,
    });
    expect(payload.customer_id).toBeUndefined();
    expect(payload.html).toContain('Vendor: Spinner &lt;Ag&gt;');
    expect(payload.html).toContain('Requested delivery: 11/3/2026');
  });

  it('uses the same ordering address the edge function accepts', () => {
    expect(COMPANY_ORDERING_EMAIL.toLowerCase()).toBe(PO_COPY_RECIPIENT);
  });
});
