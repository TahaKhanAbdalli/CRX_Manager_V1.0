import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDoc = {
  internal: { pageSize: { getWidth: () => 612, getHeight: () => 792 } },
  setFillColor: vi.fn(),
  rect: vi.fn(),
  setFont: vi.fn(),
  setFontSize: vi.fn(),
  setTextColor: vi.fn(),
  text: vi.fn(),
  setDrawColor: vi.fn(),
  line: vi.fn(),
  roundedRect: vi.fn(),
  splitTextToSize: vi.fn((text: string) => [text]),
  addPage: vi.fn(),
  getNumberOfPages: vi.fn(() => 2),
  setPage: vi.fn(),
  save: vi.fn(),
  lastAutoTable: { finalY: 300 },
};

vi.mock('jspdf', () => {
  function JsPDFMock() {
    return mockDoc;
  }
  return { default: JsPDFMock };
});

const autoTableMock = vi.fn((doc: { lastAutoTable: { finalY: number } }, opts: { startY?: number }) => {
  doc.lastAutoTable = { finalY: (opts.startY || 0) + 100 };
});
vi.mock('jspdf-autotable', () => ({ default: (...args: Parameters<typeof autoTableMock>) => autoTableMock(...args) }));

import {
  buildPurchaseOrderPdfRows,
  downloadPurchaseOrderPdf,
  generatePurchaseOrderPdf,
  purchaseOrderStatusBanner,
  type PdfPurchaseOrderData,
} from './purchaseOrderPdf';

function makeData(overrides: Partial<PdfPurchaseOrderData> = {}): PdfPurchaseOrderData {
  return {
    po_number: 'PO-2026-0040',
    status: 'submitted',
    submitted_date: '2026-10-20',
    expected_delivery_date: '2026-11-03',
    notes: 'Deliver to the north shed.',
    vendor: { name: 'Spinner Ag', contact_name: 'Pat', phone: '555-0100', email: 'orders@spinner.example', address: '1 Main St\nTown, IL' },
    lines: [
      { product_name: 'Atrazine 4L', epa_registration: '100-497', unit_size: '2.5 gal', quantity_ordered: 3, unit_cost: 19.99 },
      { product_name: 'Surfactant', unit_size: 'gal', quantity_ordered: 2.5, unit_cost: 10.01, notes: 'Rush' },
    ],
    ...overrides,
  };
}

const textCalls = () => mockDoc.text.mock.calls.map((c) => (Array.isArray(c[0]) ? c[0].join('\n') : String(c[0])));

describe('buildPurchaseOrderPdfRows', () => {
  it('totals whole cents the same way the purchase order page does', () => {
    const { rows, totalCents } = buildPurchaseOrderPdfRows(makeData().lines);
    // 3 x $19.99 = $59.97; 2.5 x $10.01 = $25.025 -> $25.03 (half up, as purchaseOrderLineTotalCents)
    expect(rows.map((r) => r.lineTotalCents)).toEqual([5997, 2503]);
    expect(totalCents).toBe(8500);
    expect(rows[0]).toMatchObject({ quantity: '3 2.5 gal', unitCost: '$19.99', lineTotal: '$59.97' });
    expect(rows[0].product).toBe('Atrazine 4L\nEPA Reg. 100-497');
    expect(rows[1].product).toBe('Surfactant\nRush');
  });

  it('prints TBD for a line with no cost (left out of the total) and stars an unconfirmed cost', () => {
    const result = buildPurchaseOrderPdfRows([
      { product_name: 'A', quantity_ordered: 2, unit_cost: null },
      { product_name: 'B', quantity_ordered: 2, unit_cost: 0 },
      { product_name: 'C', quantity_ordered: 2, unit_cost: 5, cost_needs_review: true },
      { product_name: 'D', quantity_ordered: 1, unit_cost: 1 },
    ]);
    expect(result.rows.map((r) => [r.unitCost, r.lineTotal])).toEqual([
      ['TBD', 'TBD'],
      ['TBD', 'TBD'],
      ['$5.00 *', '$10.00 *'],
      ['$1.00', '$1.00'],
    ]);
    expect(result.totalCents).toBe(1100);
    expect(result).toMatchObject({ hasUnpriced: true, hasUnconfirmed: true });
    expect(buildPurchaseOrderPdfRows(makeData().lines)).toMatchObject({ hasUnpriced: false, hasUnconfirmed: false });
  });

  it('never drifts on float-unfriendly costs', () => {
    const { totalCents } = buildPurchaseOrderPdfRows([
      { product_name: 'A', quantity_ordered: 3, unit_cost: 0.1 },
      { product_name: 'B', quantity_ordered: 7, unit_cost: 0.07 },
    ]);
    expect(totalCents).toBe(30 + 49);
  });
});

describe('purchaseOrderStatusBanner', () => {
  it('marks drafts and cancelled POs, and leaves live orders alone', () => {
    expect(purchaseOrderStatusBanner('draft')).toMatch(/DRAFT/);
    expect(purchaseOrderStatusBanner('cancelled')).toMatch(/CANCELLED/);
    expect(purchaseOrderStatusBanner('submitted')).toBeNull();
    expect(purchaseOrderStatusBanner('partially_received')).toBeNull();
  });
});

describe('generatePurchaseOrderPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prints the PO number, vendor, total and notes, with a footer on every page', async () => {
    await generatePurchaseOrderPdf(makeData());
    const texts = textCalls();
    expect(texts).toContain('PURCHASE ORDER');
    expect(texts).toContain('PO-2026-0040');
    expect(texts).toContain('Spinner Ag');
    expect(texts).toContain('Attn: Pat');
    expect(texts).toContain('Deliver to the north shed.');
    expect(texts.filter((t) => t.startsWith('Page '))).toEqual(['Page 1 of 2', 'Page 2 of 2']);

    const opts = autoTableMock.mock.calls[0][1] as unknown as { body: string[][]; foot: string[][] };
    expect(opts.body).toHaveLength(2);
    expect(opts.foot[0]).toEqual(['', '', 'Order Total', '$85.00']);
  });

  it('wraps long vendor details instead of cutting them, and adds the cost footnotes', async () => {
    mockDoc.splitTextToSize.mockImplementation((text: string) => (text.length > 20 ? [text.slice(0, 20), text.slice(20)] : [text]));
    await generatePurchaseOrderPdf(makeData({
      vendor: { name: 'Spinner Ag', email: 'purchasing.orders@helenaagri-enterprises.example' },
      lines: [{ product_name: 'A', quantity_ordered: 1, unit_cost: null }, { product_name: 'B', quantity_ordered: 1, unit_cost: 2, cost_needs_review: true }],
    }));
    mockDoc.splitTextToSize.mockImplementation((text: string) => [text]);
    const texts = textCalls();
    expect(texts).toContain('purchasing.orders@he');
    expect(texts).toContain('lenaagri-enterprises.example');
    expect(texts).toContain('TBD: price not yet set. The order total leaves these lines out.');
    expect(texts).toContain('* Price not yet confirmed by Crop RX Solutions.');
  });

  it('marks a draft so a vendor never fills it', async () => {
    await generatePurchaseOrderPdf(makeData({ status: 'draft' }));
    expect(textCalls()).toContain('DRAFT - NOT YET SUBMITTED');
  });

  it('works for a vendor that is not in the vendors list (name only)', async () => {
    await generatePurchaseOrderPdf(makeData({ vendor: { name: 'we' }, notes: null }));
    expect(textCalls()).toContain('we');
    expect(textCalls()).not.toContain('NOTES');
  });

  it('saves under the PO number', async () => {
    await downloadPurchaseOrderPdf(makeData());
    expect(mockDoc.save).toHaveBeenCalledWith('Purchase-Order-PO-2026-0040.pdf');
  });
});
