import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  decidePurchaseOrderEmail,
  parsePurchaseOrderSnapshot,
  PO_COPY_RECIPIENT,
  type PoGateLine,
  type PoGateOrder,
  type PoGateSnapshot,
} from '../../supabase/functions/_shared/purchaseOrderEmailGate';

const order: PoGateOrder = { id: 'po-1', status: 'submitted', vendor: 'Spinner Ag', expected_delivery_date: '2026-11-03', notes: 'Call ahead' };
// PostgREST returns numeric columns as numbers; strings are tolerated too.
const dbLine = (id: string, productId: string, quantity: number | string, cost: number | string | null, extra: Partial<PoGateLine> = {}): PoGateLine => ({
  id,
  product_id: productId,
  quantity_ordered: quantity,
  unit_cost: cost,
  cost_needs_review: false,
  unit_size: 'gal',
  notes: null,
  product_name: `stored ${productId}`,
  product: { product_name: `Product ${productId}`, epa_registration: `EPA-${productId}` },
  ...extra,
});
const printedLine = (id: string, productId: string, quantity: number, cost: number) => ({
  id,
  product_id: productId,
  product_name: `Product ${productId}`,
  epa_registration: `EPA-${productId}`,
  unit_size: 'gal',
  notes: null,
  quantity_ordered: quantity,
  unit_cost: cost,
});
const lines: PoGateLine[] = [dbLine('l-1', 'p-1', 3, 12.5), dbLine('l-2', 'p-2', '2.5', '3.00')];
const snapshot: PoGateSnapshot = {
  vendor: 'Spinner Ag',
  expected_delivery_date: '2026-11-03',
  notes: 'Call ahead',
  lines: [printedLine('l-2', 'p-2', 2.5, 3), printedLine('l-1', 'p-1', 3, 12.5)],
};
const to = PO_COPY_RECIPIENT;

describe('purchase order copy email gate', () => {
  it('allows the company ordering address, ignoring case and spaces', () => {
    expect(decidePurchaseOrderEmail(order, lines, ' Mason@CropRxSolutions.com ', snapshot)).toEqual({ ok: true });
  });

  it('refuses any other recipient, including a vendor', () => {
    for (const other of ['orders@spinner.example', 'someone@croprxsolutions.com', '']) {
      expect(decidePurchaseOrderEmail(order, lines, other, snapshot)).toMatchObject({ ok: false, status: 403 });
    }
  });

  it('refuses draft, cancelled and fully received POs, and a missing PO', () => {
    for (const status of ['draft', 'cancelled', 'fully_received']) {
      expect(decidePurchaseOrderEmail({ ...order, status }, lines, to, snapshot)).toMatchObject({ ok: false, status: 409 });
    }
    expect(decidePurchaseOrderEmail({ ...order, status: 'partially_received' }, lines, to, snapshot).ok).toBe(true);
    expect(decidePurchaseOrderEmail(null, lines, to, snapshot)).toMatchObject({ ok: false, status: 404 });
  });

  it('refuses a PO with no lines, a zero cost, or a cost still awaiting confirmation', () => {
    const one: PoGateSnapshot = { ...snapshot, lines: [printedLine('l-1', 'p-1', 1, 9)] };
    expect(decidePurchaseOrderEmail(order, [], to, one)).toMatchObject({ ok: false, status: 409 });
    for (const line of [
      dbLine('l-1', 'p-1', 1, 0),
      dbLine('l-1', 'p-1', 1, null),
      dbLine('l-1', 'p-1', 1, 9, { cost_needs_review: true }),
    ]) {
      expect(decidePurchaseOrderEmail(order, [line], to, one)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/confirmed unit cost/) });
    }
  });

  it('refuses when the PDF no longer shows the PO as it is', () => {
    const changed = { ok: false, status: 409, error: expect.stringMatching(/changed after its PDF was built/) };
    const [a, b] = snapshot.lines;
    const variants: PoGateSnapshot[] = [
      { ...snapshot, lines: [a, { ...b, unit_cost: 12.49 }] },
      { ...snapshot, lines: [a, { ...b, quantity_ordered: 2 }] },
      { ...snapshot, lines: [a, { ...b, product_id: 'p-9' }] },
      { ...snapshot, lines: [a, { ...b, product_name: 'Old name' }] },
      { ...snapshot, lines: [a, { ...b, epa_registration: '100-1' }] },
      { ...snapshot, lines: [a, { ...b, unit_size: 'lb' }] },
      { ...snapshot, lines: [a, { ...b, notes: 'rush' }] },
      { ...snapshot, lines: [a] },
      { ...snapshot, lines: [a, b, printedLine('l-3', 'p-3', 1, 1)] },
      { ...snapshot, lines: [a, a] },
      { ...snapshot, expected_delivery_date: '2026-11-04' },
      { ...snapshot, notes: null },
      { ...snapshot, vendor: 'Hydrite' },
    ];
    for (const variant of variants) {
      expect(decidePurchaseOrderEmail(order, lines, to, variant)).toMatchObject(changed);
    }
  });

  it('names a line by its stored name when the product has none, as the PDF does', () => {
    const noProduct = [dbLine('l-1', 'p-1', 3, 12.5, { product: null, product_name: 'Custom blend' }), lines[1]];
    const printed = { ...snapshot, lines: [{ ...printedLine('l-1', 'p-1', 3, 12.5), product_name: 'Custom blend', epa_registration: null }, snapshot.lines[0]] };
    expect(decidePurchaseOrderEmail(order, noProduct, to, printed)).toEqual({ ok: true });
  });

  it('parses only a well-formed snapshot', () => {
    expect(parsePurchaseOrderSnapshot(snapshot)).toEqual(snapshot);
    const line = snapshot.lines[0];
    for (const bad of [
      undefined, null, 'x', [],
      { ...snapshot, lines: [] },
      { ...snapshot, vendor: 3 },
      { ...snapshot, lines: [{ ...line, quantity_ordered: '3' }] },
      { ...snapshot, lines: [{ ...line, product_id: undefined }] },
      { ...snapshot, lines: [{ ...line, unit_cost: Number.NaN }] },
    ]) {
      expect(parsePurchaseOrderSnapshot(bad)).toBeNull();
    }
  });
});

// CRLF-normalized so Windows checkouts match the LF snippets below.
const source = readFileSync('supabase/functions/send-email/index.ts', 'utf8').replace(/\r\n/g, '\n');

describe('send-email purchase order wiring', () => {
  it('limits purchase_order emails to admins', () => {
    expect(source).toContain('admin: ALL_EMAIL_TYPES,');
    expect(source).toContain('sales_rep: CUSTOMER_EMAIL_TYPES,');
    expect(source).toContain('driver: new Set(["delivery_completed"]),');
    const customerTypes = source.slice(source.indexOf('const CUSTOMER_EMAIL_TYPES'), source.indexOf(']);', source.indexOf('const CUSTOMER_EMAIL_TYPES')));
    expect(customerTypes).not.toContain('purchase_order');
  });

  it('checks the PO copy before the write-ahead log and again before the provider call', () => {
    const firstGate = source.indexOf('const poGate = await checkPurchaseOrderEmail(adminClient, resource_id, to, poSnapshot);');
    const logInsert = source.indexOf('.from("email_log")\n        .insert(');
    const finalGate = source.indexOf('const finalPoGate = await checkPurchaseOrderEmail(adminClient, resource_id, to, poSnapshot);');
    const outbound = source.indexOf('await fetch("https://api.resend.com/emails"');
    expect(firstGate).toBeGreaterThan(-1);
    expect(logInsert).toBeGreaterThan(firstGate);
    expect(finalGate).toBeGreaterThan(logInsert);
    expect(outbound).toBeGreaterThan(finalGate);
    expect(source).toContain('.select("id, status, vendor, expected_delivery_date, notes")');
    expect(source).toContain('.select("id, product_id, quantity_ordered, unit_cost, cost_needs_review, unit_size, notes, product_name, product:products(product_name, epa_registration)")');
  });

  it('skips the customer lookup only for a PO copy, which carries no customer_id and must carry its snapshot', () => {
    expect(source).toContain('Purchase order emails must not carry a customer_id');
    expect(source).toContain("Purchase order emails require resource_type='purchase_order' and resource_id");
    expect(source).toContain('Purchase order emails require purchase_order_snapshot');
    expect(source).toContain('} else if (!customer_id) {');
  });
});
