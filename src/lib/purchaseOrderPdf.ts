/**
 * purchaseOrderPdf.ts — the purchase order CRX sends to a vendor (To-Do 0.15).
 *
 * Shows unit costs, so only admins build it (purchase cost is admin-only,
 * Mason 2026-10-18). Line totals and the order total are whole cents, from the
 * same helpers the purchase order page uses, so the PDF matches the screen.
 */
// jsPDF and autoTable are dynamically imported inside each function
// to keep them out of the main bundle (~500KB each)
import { CRX_GREEN, CHARCOAL, GRAY, LIGHT_BG, RED, TABLE_HEADER_BG, type JsPDFWithAutoTable } from './pdfTheme';
import {
  COMPANY_CITY,
  COMPANY_LEGAL_NAME,
  COMPANY_PHONE,
  COMPANY_TAGLINE_HEADER,
  COMPANY_WEBSITE,
} from './companyInfo';
import { formatCents } from './money';
import { parseLocalDate } from './dateUtils';
import { purchaseOrderLineTotalCents, purchaseOrderUnitCostCents } from './purchaseOrderMoney';
import { purchaseOrderStatusBanner } from './purchaseOrderFingerprint';

export { purchaseOrderStatusBanner };

export interface PdfPurchaseOrderLine {
  product_name: string;
  epa_registration?: string | null;
  unit_size?: string | null;
  quantity_ordered: number;
  /** Unit cost in dollars, as the admin cost read returns it; null or 0 when not set yet. */
  unit_cost: number | null;
  /** The cost is the catalog default and an admin has not confirmed it yet. */
  cost_needs_review?: boolean;
  notes?: string | null;
}

export interface PdfPurchaseOrderVendor {
  name: string;
  contact_name?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
}

export interface PdfPurchaseOrderData {
  po_number: string;
  status: string;
  submitted_date: string | null;
  expected_delivery_date: string | null;
  notes: string | null;
  vendor: PdfPurchaseOrderVendor;
  lines: PdfPurchaseOrderLine[];
}

export interface PurchaseOrderPdfRow {
  product: string;
  quantity: string;
  unitCost: string;
  lineTotal: string;
  lineTotalCents: number;
}

const formatQuantity = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });

const formatDate = (date: string | null) => (date ? parseLocalDate(date).toLocaleDateString('en-US') : '-');

/**
 * The table rows and the order total in whole cents. Pure, so it is unit-tested.
 * A line with no cost yet prints "TBD" and is left out of the total; an unconfirmed
 * cost is starred. A vendor must never read either as a firm price (the email path
 * refuses both; a downloaded PDF can still be printed or forwarded).
 */
export function buildPurchaseOrderPdfRows(lines: readonly PdfPurchaseOrderLine[]): {
  rows: PurchaseOrderPdfRow[];
  totalCents: number;
  hasUnpriced: boolean;
  hasUnconfirmed: boolean;
} {
  let totalCents = 0;
  let hasUnpriced = false;
  let hasUnconfirmed = false;
  const rows = lines.map((line) => {
    const product = [line.product_name, line.epa_registration ? `EPA Reg. ${line.epa_registration}` : '', line.notes ?? '']
      .filter(Boolean)
      .join('\n');
    const quantity = `${formatQuantity(line.quantity_ordered)}${line.unit_size ? ` ${line.unit_size}` : ''}`;
    if (!line.unit_cost || line.unit_cost <= 0) {
      hasUnpriced = true;
      return { product, quantity, unitCost: 'TBD', lineTotal: 'TBD', lineTotalCents: 0 };
    }
    const lineTotalCents = purchaseOrderLineTotalCents(line.quantity_ordered, line.unit_cost);
    totalCents += lineTotalCents;
    const star = line.cost_needs_review ? ' *' : '';
    if (star) hasUnconfirmed = true;
    return {
      product,
      quantity,
      unitCost: `${formatCents(purchaseOrderUnitCostCents(line.unit_cost))}${star}`,
      lineTotal: `${formatCents(lineTotalCents)}${star}`,
      lineTotalCents,
    };
  });
  return { rows, totalCents, hasUnpriced, hasUnconfirmed };
}

export function purchaseOrderPdfFilename(poNumber: string): string {
  return `Purchase-Order-${poNumber}.pdf`;
}

export async function generatePurchaseOrderPdf(data: PdfPurchaseOrderData): Promise<JsPDFWithAutoTable> {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) as unknown as JsPDFWithAutoTable;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;

  // ─── Header bar ───────────────────────────────────────────
  doc.setFillColor(...CRX_GREEN);
  doc.rect(0, 0, pageW, 70, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(255, 255, 255);
  doc.text('CROP RX SOLUTIONS', margin, 35);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(COMPANY_TAGLINE_HEADER, margin, 53);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text('PURCHASE ORDER', pageW - margin, 30, { align: 'right' });
  doc.setFontSize(14);
  doc.text(data.po_number, pageW - margin, 50, { align: 'right' });

  let y = 90;

  const banner = purchaseOrderStatusBanner(data.status);
  if (banner) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.setTextColor(...RED);
    doc.text(banner, pageW / 2, y, { align: 'center' });
    y += 18;
  }

  // ─── Vendor / buyer / dates ───────────────────────────────
  // Nothing here is cut short: a vendor reading a clipped email or street address
  // would take it for the real one. Long text wraps and the box grows to fit.
  const innerW = pageW - margin * 2;
  const blocks = [
    {
      x: margin + 12,
      width: innerW * 0.46 - 20,
      title: 'VENDOR',
      heading: data.vendor.name,
      lines: [
        data.vendor.contact_name ? `Attn: ${data.vendor.contact_name}` : '',
        ...(data.vendor.address ? data.vendor.address.split(/\r?\n/) : []),
        data.vendor.phone ?? '',
        data.vendor.email ?? '',
      ],
    },
    {
      x: margin + 12 + innerW * 0.46,
      width: innerW * 0.29 - 20,
      title: 'BUYER',
      heading: COMPANY_LEGAL_NAME,
      lines: [COMPANY_CITY, COMPANY_PHONE, COMPANY_WEBSITE],
    },
    {
      x: margin + 12 + innerW * 0.75,
      width: innerW * 0.25 - 20,
      title: 'ORDER DATE',
      heading: formatDate(data.submitted_date),
      lines: ['Requested delivery:', formatDate(data.expected_delivery_date)],
    },
  ].map((block) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    const headingLines = doc.splitTextToSize(block.heading, block.width) as string[];
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    const detailLines = block.lines
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => doc.splitTextToSize(line, block.width) as string[]);
    return { ...block, headingLines, detailLines };
  });
  const blockHeight = (b: (typeof blocks)[number]) => 31 + (b.headingLines.length - 1) * 13 + 14 + b.detailLines.length * 12;
  const boxH = Math.max(...blocks.map(blockHeight));

  doc.setFillColor(...LIGHT_BG);
  doc.roundedRect(margin, y, innerW, boxH, 4, 4, 'F');
  for (const block of blocks) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(...GRAY);
    doc.text(block.title, block.x, y + 16);
    doc.setFontSize(11);
    doc.setTextColor(...CHARCOAL);
    block.headingLines.forEach((line, i) => doc.text(line, block.x, y + 31 + i * 13));
    const detailTop = y + 31 + (block.headingLines.length - 1) * 13 + 14;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    block.detailLines.forEach((line, i) => doc.text(line, block.x, detailTop + i * 12));
  }

  y += boxH + 20;

  // ─── Line items ───────────────────────────────────────────
  const { rows, totalCents, hasUnpriced, hasUnconfirmed } = buildPurchaseOrderPdfRows(data.lines);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin, bottom: 50 },
    head: [['Product', 'Quantity', 'Unit Cost', 'Line Total']],
    body: rows.map((row) => [row.product, row.quantity, row.unitCost, row.lineTotal]),
    foot: [['', '', 'Order Total', formatCents(totalCents)]],
    showFoot: 'lastPage',
    theme: 'plain',
    // A product's EPA number and note stay on the same page as its figures.
    rowPageBreak: 'avoid',
    styles: { fontSize: 9, cellPadding: 6, textColor: CHARCOAL, valign: 'top' },
    headStyles: { fillColor: TABLE_HEADER_BG, textColor: CHARCOAL, fontStyle: 'bold' },
    footStyles: { fillColor: LIGHT_BG, textColor: CHARCOAL, fontStyle: 'bold', fontSize: 10 },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { cellWidth: 95 },
      2: { cellWidth: 85, halign: 'right' },
      3: { cellWidth: 90, halign: 'right' },
    },
    didParseCell: (hookData) => {
      // The money columns' headers and the total line up with their figures.
      if ((hookData.section === 'head' || hookData.section === 'foot') && hookData.column.index >= 2) {
        hookData.cell.styles.halign = 'right';
      }
    },
  });

  y = doc.lastAutoTable.finalY + 16;
  const bottom = pageH - 50;

  // ─── Cost footnotes ───────────────────────────────────────
  const footnotes = [
    hasUnpriced ? 'TBD: price not yet set. The order total leaves these lines out.' : '',
    hasUnconfirmed ? '* Price not yet confirmed by Crop RX Solutions.' : '',
  ].filter(Boolean);
  if (footnotes.length > 0) {
    if (y + footnotes.length * 12 > bottom) {
      doc.addPage();
      y = 50;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...RED);
    footnotes.forEach((note, i) => doc.text(note, margin, y + i * 12));
    y += footnotes.length * 12;
  }
  y += 8;

  // ─── Notes (wrapped, and carried onto new pages as needed) ─
  if (data.notes?.trim()) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    let noteLines = doc.splitTextToSize(data.notes.trim(), innerW) as string[];
    if (y + 26 > bottom) {
      doc.addPage();
      y = 50;
    }
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...CHARCOAL);
    doc.text('NOTES', margin, y);
    y += 14;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...GRAY);
    while (noteLines.length > 0) {
      const fits = Math.max(1, Math.floor((bottom - y) / 12) + 1);
      noteLines.slice(0, fits).forEach((line, i) => doc.text(line, margin, y + i * 12));
      noteLines = noteLines.slice(fits);
      if (noteLines.length > 0) {
        doc.addPage();
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(...GRAY);
        y = 50;
      }
    }
  }

  // ─── Footer on every page ─────────────────────────────────
  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page);
    const footerY = pageH - 30;
    doc.setDrawColor(200, 200, 200);
    doc.line(margin, footerY - 10, pageW - margin, footerY - 10);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(160, 160, 160);
    doc.text(
      `${COMPANY_LEGAL_NAME}  •  ${COMPANY_PHONE}  •  Please reference ${data.po_number} on your invoice and packing slip.`,
      margin,
      footerY,
    );
    doc.text(`Page ${page} of ${pageCount}`, pageW - margin, footerY, { align: 'right' });
  }

  return doc;
}

export async function downloadPurchaseOrderPdf(data: PdfPurchaseOrderData): Promise<void> {
  const doc = await generatePurchaseOrderPdf(data);
  doc.save(purchaseOrderPdfFilename(data.po_number));
}
