/**
 * buildInvoicePdfDataFromRow.test.ts — #33 (money-lens MED #2)
 *
 * The list pages (Field-app Unposted / Posted / combined) print/email invoices via
 * buildInvoicePdfDataFromRow with a lightweight list row that does NOT carry the
 * invoice's billing fields (Discount Earned, payment terms, PO ref, due date,
 * header/footer notes). Before the fix those arrived undefined → 0 → the PDF's
 * Discount Earned block and the Terms line were silently skipped when printing a
 * field invoice FROM THE LIST.
 *
 * The fix re-fetches those columns by invoice id inside the builder, so every caller
 * is covered in one place — BUT a caller that DID supply a field (the in-editor print
 * of live, unsaved form values) keeps full control. These tests pin both directions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted supabase mock ───────────────────────────────────────────────────
const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));

vi.mock('./db', () => ({
  supabase: { from: mockFrom },
}));

const { mockCapture } = vi.hoisted(() => ({ mockCapture: vi.fn() }));
vi.mock('./sentry', () => ({ Sentry: { captureException: mockCapture } }));

import {
  buildInvoicePdfDataFromRow,
  buildBatchInvoicePdfData,
  batchInvoicePrintToast,
  InvoiceLinesUnavailableError,
  type InvoicePdfData,
} from './invoicePdf';

// One saved line, so the line-read guard sees a normal invoice.
const ONE_LINE = { description: 'Herbicide', quantity: 1, unit_price_cents: 100000, extended_cents: 100000 };

// The DB rows each table returns for the invoice under test.
interface PerTable {
  customers?: Record<string, unknown> | null;
  invoice_items?: Array<Record<string, unknown>> | null;
  invoice_items_error?: { message: string } | null;
  invoice_shares?: Array<Record<string, unknown>>;
  invoices?: Record<string, unknown> | null; // the #33 billing re-fetch
}

function installFromMock(per: PerTable) {
  mockFrom.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    // customers + invoices terminate on .maybeSingle(); items/shares on .order()/await.
    chain.maybeSingle = vi.fn().mockResolvedValue({
      data: table === 'customers' ? per.customers ?? null
        : table === 'invoices' ? per.invoices ?? null
        : null,
      error: null,
    });
    const arrayData =
      table === 'invoice_items' ? (per.invoice_items === undefined ? [] : per.invoice_items)
      : table === 'invoice_shares' ? per.invoice_shares ?? []
      : [];
    chain.order = vi.fn().mockResolvedValue({
      data: arrayData,
      error: table === 'invoice_items' ? per.invoice_items_error ?? null : null,
    });
    // invoice_shares is awaited directly after .eq(...) (no .order()); make the chain
    // thenable so `await supabase.from('invoice_shares').select(...).eq(...)` resolves.
    chain.then = (resolve: (v: { data: unknown; error: unknown }) => void) =>
      resolve({ data: arrayData, error: null });
    return chain;
  });
}

// A minimal list row exactly like toPdfRow() produces — note it carries NO
// discount/terms/PO/due/notes fields (the list never had them).
function listRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    invoice_number: 'INV-1001',
    invoice_date: '2026-06-01',
    invoice_type: 'field_application',
    status: 'posted',
    customer_id: 'cust-1',
    customer_name: 'Farm A',
    total_amount_cents: 100000,
    total_cost_cents: 60000,
    paid_amount_cents: 0,
    prepay_applied_cents: 0,
    write_off_cents: 0,
    balance_cents: 100000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildInvoicePdfDataFromRow — #33 list-print re-fetch', () => {
  it('re-fetches Discount Earned + Terms (+ PO/due/notes) when the list row omits them', async () => {
    // The invoice HAS a saved discount + terms + PO + due + notes in the DB; the list
    // row (which never carries these) leaves them undefined. The builder must surface
    // the DB values so the PDF prints the discount line + Terms.
    installFromMock({
      customers: { billing_address: '1 Rd', city: 'Town', state: 'IL', zip: '60000', account_number: 'A1', payment_terms: 'Customer default terms' },
      invoice_items: [ONE_LINE],
      invoice_shares: [],
      invoices: {
        discount_earned_cents: 2500,
        discount_date: '2026-06-10',
        payment_terms: 'Net 15',
        purchase_order_ref: 'PO-555',
        header_notes: 'Header from DB',
        footer_notes: 'Footer from DB',
        due_date: '2026-06-30',
      },
    });

    const data = await buildInvoicePdfDataFromRow(listRow());

    expect(data.discount_earned_cents).toBe(2500);     // would have been 0 before the fix
    expect(data.payment_terms).toBe('Net 15');         // invoice override wins over customer default
    expect(data.purchase_order_ref).toBe('PO-555');
    expect(data.due_date).toBe('2026-06-30');
    expect(data.header_notes).toBe('Header from DB');
    expect(data.footer_notes).toBe('Footer from DB');
  });

  it('falls back to the customer default Terms when the invoice has no payment_terms', async () => {
    installFromMock({
      customers: { payment_terms: 'Customer default terms' },
      invoice_items: [ONE_LINE],
      invoice_shares: [],
      invoices: { discount_earned_cents: 0, payment_terms: null, purchase_order_ref: null, due_date: null, header_notes: null, footer_notes: null },
    });

    const data = await buildInvoicePdfDataFromRow(listRow());
    expect(data.payment_terms).toBe('Customer default terms');
    expect(data.discount_earned_cents).toBe(0); // no line printed
  });

  it('a caller-supplied value WINS over the DB re-fetch (in-editor live-form print)', async () => {
    // The editor passes LIVE form values (even a freshly-typed discount not yet saved).
    // Those must win over whatever is currently persisted.
    installFromMock({
      customers: { payment_terms: 'Customer default terms' },
      invoice_items: [ONE_LINE],
      invoice_shares: [],
      invoices: {
        discount_earned_cents: 2500, // stale persisted value
        payment_terms: 'Net 15',
        purchase_order_ref: 'PO-OLD',
        due_date: '2026-06-30',
        header_notes: 'old header',
        footer_notes: 'old footer',
      },
    });

    const data = await buildInvoicePdfDataFromRow(
      listRow({
        discount_earned_cents: 9900, // live form value
        payment_terms: 'Net 45',
        purchase_order_ref: 'PO-NEW',
        due_date: '2026-07-15',
        header_notes: 'new header',
        footer_notes: 'new footer',
      }),
    );

    expect(data.discount_earned_cents).toBe(9900);
    expect(data.payment_terms).toBe('Net 45');
    expect(data.purchase_order_ref).toBe('PO-NEW');
    expect(data.due_date).toBe('2026-07-15');
    expect(data.header_notes).toBe('new header');
    expect(data.footer_notes).toBe('new footer');
  });

  it('a caller that explicitly clears a field (null) keeps it cleared (does not resurface the DB value)', async () => {
    // The editor passes `poRef || null`; an intentional clear must NOT be undone by
    // the re-fetch (null is "provided", only undefined triggers the fallback).
    installFromMock({
      customers: { payment_terms: null },
      invoice_items: [ONE_LINE],
      invoice_shares: [],
      invoices: { discount_earned_cents: 2500, payment_terms: 'Net 15', purchase_order_ref: 'PO-OLD' },
    });

    const data = await buildInvoicePdfDataFromRow(
      listRow({ discount_earned_cents: 0, payment_terms: null, purchase_order_ref: null }),
    );

    expect(data.discount_earned_cents).toBe(0);
    expect(data.payment_terms).toBeUndefined(); // cleared, no customer default either
    expect(data.purchase_order_ref).toBeUndefined();
  });
});

describe('buildInvoicePdfDataFromRow — B3 line-read guard', () => {
  it('refuses the PDF when the invoice_items read fails', async () => {
    installFromMock({ invoice_items: null, invoice_items_error: { message: 'network' } });
    await expect(buildInvoicePdfDataFromRow(listRow())).rejects.toBeInstanceOf(InvoiceLinesUnavailableError);
  });

  it('refuses the PDF when the read returns no lines under a non-zero total', async () => {
    installFromMock({ invoice_items: [] });
    await expect(buildInvoicePdfDataFromRow(listRow())).rejects.toThrow('Could not load the invoice lines');
  });

  it('refuses a credit (negative total) with no lines too', async () => {
    installFromMock({ invoice_items: [] });
    await expect(buildInvoicePdfDataFromRow(listRow({ total_amount_cents: -5000 }))).rejects.toBeInstanceOf(InvoiceLinesUnavailableError);
  });

  it('still prints a $0 invoice that has no lines', async () => {
    installFromMock({ invoice_items: [] });
    const data = await buildInvoicePdfDataFromRow(listRow({ total_amount_cents: 0, balance_cents: 0 }));
    expect(data.items).toEqual([]);
  });

  it('prints a normal invoice with its lines', async () => {
    installFromMock({ invoice_items: [ONE_LINE] });
    const data = await buildInvoicePdfDataFromRow(listRow());
    expect(data.items).toHaveLength(1);
  });
});

describe('buildBatchInvoicePdfData — skip and name a bad invoice', () => {
  const ok = (n: string) => ({ invoice_number: n } as InvoicePdfData);

  it('skips the invoice whose lines failed, names it, and keeps the others in order', async () => {
    const rows = [{ invoice_number: 'INV-1' }, { invoice_number: 'INV-2' }, { invoice_number: 'INV-3' }];
    const { list, skipped } = await buildBatchInvoicePdfData(rows, async (r) => {
      if (r.invoice_number === 'INV-2') throw new InvoiceLinesUnavailableError();
      return ok(r.invoice_number);
    });
    expect(list.map((d) => d.invoice_number)).toEqual(['INV-1', 'INV-3']);
    expect(skipped).toEqual(['INV-2']);
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it('fails the batch, naming every invoice, when all of them were skipped', async () => {
    const rows = [{ invoice_number: 'INV-1' }, { invoice_number: 'INV-2' }];
    await expect(buildBatchInvoicePdfData(rows, async () => { throw new InvoiceLinesUnavailableError(); }))
      .rejects.toThrow('INV-1, INV-2');
  });

  it('builds at most 5 invoices at a time and keeps the selection order', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ invoice_number: `INV-${i}` }));
    let running = 0;
    let peak = 0;
    const { list } = await buildBatchInvoicePdfData(rows, async (r) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((res) => setTimeout(res, 1));
      running -= 1;
      return ok(r.invoice_number);
    });
    expect(peak).toBeLessThanOrEqual(5);
    expect(list.map((d) => d.invoice_number)).toEqual(rows.map((r) => r.invoice_number));
  });

  it('any other error still fails the whole batch', async () => {
    await expect(buildBatchInvoicePdfData([{ invoice_number: 'INV-1' }], async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('the finished-batch toast names the skipped invoices', () => {
    expect(batchInvoicePrintToast(2, [])).toEqual({ type: 'success', message: 'Printed 2 invoice(s)' });
    const warn = batchInvoicePrintToast(1, ['INV-2']);
    expect(warn.type).toBe('warning');
    expect(warn.message).toContain('Skipped INV-2');
  });

  it('the toast names PDFs that failed to build and shortens a long list', () => {
    const failed = batchInvoicePrintToast(3, [], ['INV-9']);
    expect(failed.type).toBe('warning');
    expect(failed.message).toContain('Printed 3 invoice(s).');
    expect(failed.message).toContain('Could not make the PDF for INV-9');
    const many = Array.from({ length: 8 }, (_, i) => `INV-${i}`);
    expect(batchInvoicePrintToast(0, many).message).toContain('INV-0, INV-1, INV-2, INV-3, INV-4 and 3 more');
  });
});
