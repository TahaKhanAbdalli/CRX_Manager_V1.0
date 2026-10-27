// =============================================================================
// Purchase order copy email gate (To-Do 0.15)
//
// Pure decision logic for send-email's 'purchase_order' type, kept free of
// Deno and Supabase imports so the app's Vitest suite tests it directly
// (src/lib/purchaseOrderEmailGate.test.ts). The edge function does the reads;
// this decides. A PO carries purchase costs, so the caller has already limited
// the type to admins.
//
// The copy is never sent to a vendor. Mason places each order himself through
// the supplier's portal, so the PO PDF goes to the company ordering address
// only (Mason, 2026-10-26: "...so they can be sent to mason@croprxsolutions.com").
// Keep in step with COMPANY_ORDERING_EMAIL in src/lib/companyInfo.ts.
// =============================================================================

export const PO_COPY_RECIPIENT = "mason@croprxsolutions.com";

export const PO_EMAILABLE_STATUSES = ["submitted", "partially_received"];

export interface PoGateOrder {
  id: string;
  status: string;
  vendor: string | null;
  expected_delivery_date: string | null;
  notes: string | null;
}

export interface PoGateLine {
  id: string;
  product_id: string;
  quantity_ordered: number | string;
  unit_cost: number | string | null;
  cost_needs_review: boolean | null;
  unit_size: string | null;
  notes: string | null;
  product_name: string | null;
  product: { product_name: string | null; epa_registration: string | null } | null;
}

/** One line as the attached PDF printed it. */
export interface PoGateSnapshotLine {
  id: string;
  product_id: string;
  product_name: string;
  epa_registration: string | null;
  unit_size: string | null;
  notes: string | null;
  quantity_ordered: number;
  unit_cost: number;
}

/** What the attached PDF printed, sent by the app alongside the PDF. */
export interface PoGateSnapshot {
  vendor: string | null;
  expected_delivery_date: string | null;
  notes: string | null;
  lines: PoGateSnapshotLine[];
}

export type PoGateResult = { ok: true } | { ok: false; status: number; error: string };

const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";

/** The snapshot the app sent, or null when it is missing or malformed. */
export function parsePurchaseOrderSnapshot(value: unknown): PoGateSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const { vendor, expected_delivery_date, notes, lines } = value as Record<string, unknown>;
  if (!nullableString(vendor) || !nullableString(expected_delivery_date) || !nullableString(notes)) return null;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const parsed: PoGateSnapshot["lines"] = [];
  for (const entry of lines) {
    if (!entry || typeof entry !== "object") return null;
    const { id, product_id, product_name, epa_registration, unit_size, notes: lineNotes, quantity_ordered, unit_cost } =
      entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof product_id !== "string" || typeof product_name !== "string") return null;
    if (!nullableString(epa_registration) || !nullableString(unit_size) || !nullableString(lineNotes)) return null;
    if (typeof quantity_ordered !== "number" || typeof unit_cost !== "number") return null;
    if (!Number.isFinite(quantity_ordered) || !Number.isFinite(unit_cost)) return null;
    parsed.push({ id, product_id, product_name, epa_registration, unit_size, notes: lineNotes, quantity_ordered, unit_cost });
  }
  return { vendor, expected_delivery_date, notes, lines: parsed };
}

/** True when the PDF shows the PO as it is today: same header details and the same lines. */
function snapshotMatches(order: PoGateOrder, lines: readonly PoGateLine[], snapshot: PoGateSnapshot): boolean {
  if (
    order.vendor !== snapshot.vendor ||
    order.expected_delivery_date !== snapshot.expected_delivery_date ||
    order.notes !== snapshot.notes
  ) return false;
  if (lines.length !== snapshot.lines.length) return false;
  const byId = new Map(snapshot.lines.map((line) => [line.id, line]));
  if (byId.size !== snapshot.lines.length) return false;
  return lines.every((line) => {
    const printed = byId.get(line.id);
    // The PDF names a line by its product's name, else the line's stored name.
    const productName = line.product?.product_name || line.product_name || "Unknown";
    return printed !== undefined &&
      line.product_id === printed.product_id &&
      productName === printed.product_name &&
      (line.product?.epa_registration ?? null) === printed.epa_registration &&
      line.unit_size === printed.unit_size &&
      line.notes === printed.notes &&
      Number(line.quantity_ordered) === printed.quantity_ordered &&
      Number(line.unit_cost) === printed.unit_cost;
  });
}

/**
 * Decides whether this PO copy may be sent to `requestedTo`. The recipient is never
 * trusted: it must be the company ordering address. The attached PDF is built by
 * the app, so the app also sends what it printed (vendor name, requested date, notes
 * and each line's product, name, EPA number, unit size, note, quantity and cost),
 * and the send is refused unless that is the PO today: an order is never placed
 * from a copy with yesterday's details. Not covered, by design: the attachment bytes
 * themselves (the server trusts the admin's app to render the snapshot, as for every
 * emailed PDF here; only an admin can send, and only to the ordering inbox), the
 * vendor record's contact block (orders go through the portal, not that address),
 * and a change in the milliseconds between the final read and the send.
 */
export function decidePurchaseOrderEmail(
  order: PoGateOrder | null,
  lines: readonly PoGateLine[],
  requestedTo: string,
  snapshot: PoGateSnapshot,
): PoGateResult {
  if (requestedTo.trim().toLowerCase() !== PO_COPY_RECIPIENT) {
    return { ok: false, status: 403, error: "A purchase order copy can only be sent to the company ordering address" };
  }
  if (!order) return { ok: false, status: 404, error: "Purchase order not found" };
  if (!PO_EMAILABLE_STATUSES.includes(order.status)) {
    return {
      ok: false,
      status: 409,
      error: "Only a submitted or partly received purchase order can be emailed",
    };
  }
  if (lines.length === 0) {
    return { ok: false, status: 409, error: "This purchase order has no lines to send" };
  }
  const unconfirmed = lines.some((line) => {
    const cost = Number(line.unit_cost);
    return line.cost_needs_review === true || !Number.isFinite(cost) || cost <= 0;
  });
  if (unconfirmed) {
    return {
      ok: false,
      status: 409,
      error: "Every line needs a confirmed unit cost before the purchase order is emailed",
    };
  }
  if (!snapshotMatches(order, lines, snapshot)) {
    return {
      ok: false,
      status: 409,
      error: "The purchase order changed after its PDF was built. Reload it and send again",
    };
  }
  return { ok: true };
}
