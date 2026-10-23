// Labels the order, job and purchase-order search pickers show for a picked record.
// Pages use them too, so a record read by id is labelled the same way as a pick.

/** "ORD-2026-0001 - Smith Farms". */
export function orderSearchLabel(order: { order_number: string; customer?: { farm_name?: string | null } | null }): string {
  const farm = order.customer?.farm_name;
  return farm ? `${order.order_number} - ${farm}` : order.order_number;
}

/** "JOB-0001 (2026-10-01) - Smith Farms". */
export function jobSearchLabel(job: { job_number: string; job_date?: string | null; customer?: { farm_name?: string | null } | null }): string {
  const date = job.job_date ? ` (${job.job_date})` : '';
  const farm = job.customer?.farm_name ? ` - ${job.customer.farm_name}` : '';
  return `${job.job_number}${date}${farm}`;
}

/** "PO-0001 — Acme Supply". */
export function purchaseOrderSearchLabel(po: { po_number: string; vendor?: string | null }): string {
  return po.vendor ? `${po.po_number} — ${po.vendor}` : po.po_number;
}
