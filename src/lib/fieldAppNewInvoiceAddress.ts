/**
 * The address of a new field-application invoice, /invoices/field-app/new, carries
 * created=<invoice id> once the first Save's create has answered (same page, typed values
 * kept), so a refresh or Back of that address opens the created invoice instead of offering
 * an empty form whose Save would create a second one (CodeRabbit, PR #893).
 *
 * A plain /invoices/field-app/new has no id and is always a new invoice. A reply lost before
 * the create answered leaves no id here; that case is a known gap (see
 * docs/changelog.d/2026-10-09-invoice-screen-safety.md).
 */
export const CREATED_INVOICE_PARAM = 'created';

// Any UUID layout (any version), so a valid id is never mistaken for "no id".
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The created invoice's id from the address, or null when absent or not an invoice id. */
export function createdInvoiceIdFromAddress(searchParams: URLSearchParams): string | null {
  const value = searchParams.get(CREATED_INVOICE_PARAM);
  return value && UUID_PATTERN.test(value) ? value : null;
}

/** The query string of a new invoice's address once its create has answered. */
export function createdInvoiceAddressSearch(createdId: string): string {
  return `?${new URLSearchParams({ [CREATED_INVOICE_PARAM]: createdId }).toString()}`;
}
