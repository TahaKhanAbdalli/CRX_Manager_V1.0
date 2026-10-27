/**
 * purchaseOrderFingerprint.ts — what the PO PDF prints, without jsPDF (To-Do 0.15).
 *
 * Kept apart from purchaseOrderPdf.ts so the purchase order page can import it
 * statically while the PDF builder stays a dynamically loaded chunk.
 */

/** A banner for a PO that is not a live order, so a vendor never mistakes it for one. */
export function purchaseOrderStatusBanner(status: string): string | null {
  if (status === 'draft') return 'DRAFT - NOT YET SUBMITTED';
  if (status === 'cancelled') return 'CANCELLED - DO NOT FILL';
  return null;
}

/**
 * Everything the PO record prints on the PDF, so a changed PO is a new email (not a replay
 * of the old one) and an admin never confirms one version and sends another. The vendor's
 * contact block (read from the vendors table) is not covered; orders go through the
 * supplier's portal, not that address. The status counts only through its banner: a
 * submitted and a partly received PO print the same PDF, so a receipt between a lost send
 * and its retry keeps the retry key.
 */
export function purchaseOrderPdfFingerprint(
  header: {
    po_number: string;
    vendor: string;
    status: string;
    submitted_date: string | null;
    expected_delivery_date: string | null;
    notes?: string | null;
  } | null,
  lines: ReadonlyArray<{
    id: string;
    product_id: string;
    product_name?: string | null;
    product?: { product_name?: string | null; epa_registration?: string | null } | null;
    quantity_ordered: number;
    unit_cost?: number | null;
    cost_needs_review?: boolean | null;
    unit_size?: string | null;
    notes?: string | null;
  }>,
): string {
  return JSON.stringify([
    header && [
      header.po_number, header.vendor, purchaseOrderStatusBanner(header.status), header.submitted_date,
      header.expected_delivery_date, header.notes,
    ],
    lines
      .map((line) => [
        line.id, line.product_id, line.product?.product_name ?? line.product_name, line.product?.epa_registration,
        line.quantity_ordered, line.unit_cost ?? null, !!line.cost_needs_review, line.unit_size, line.notes,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}
