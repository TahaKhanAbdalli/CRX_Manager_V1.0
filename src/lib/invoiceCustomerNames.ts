/**
 * Customer names on invoice pages for sales reps (Mason 2026-10-10, decision "2:yes").
 *
 * Reps read every invoice, but the customers table's own rules still show a rep only the
 * customers assigned to them, so a `customer:customers(farm_name)` embed comes back empty for
 * anyone else's customer. get_invoice_customer_names (migration 20261009120000) returns just
 * id + farm_name for customers that a non-deleted invoice names, to an active admin or sales rep.
 *
 * Callers pass ONLY the ids whose embedded name came back empty, so an admin (who reads every
 * customer, and so never has a blank embed) keeps the existing path and never calls it. A failed
 * read is not fatal: the page keeps its 'Unknown' fallback rather than refusing to show invoices.
 *
 * src/types/supabase.ts does not know this reader until it is regenerated after the apply, so
 * the call goes through supabaseUntyped with the row shape declared here.
 */
import { assertRpcResult, supabaseUntyped } from './db';
import { Sentry } from './sentry';

/**
 * Email needs the customer's own record (customers.email), which a sales rep can read only for
 * their assigned customers. When that read comes back empty for a rep, say so instead of the
 * misleading "no email address on file".
 */
export const CUSTOMER_EMAIL_HIDDEN_MESSAGE = "You can't see this customer's email address. Ask an admin to email this invoice.";

/** One row of get_invoice_customer_names(p_customer_ids uuid[]). */
export interface InvoiceCustomerNameRow {
  id: string;
  farm_name: string | null;
}

/**
 * Farm names for the given customer ids, in ONE call (deduplicated). Returns an empty map
 * without calling when there is nothing to look up, and on any error.
 */
export async function fetchInvoiceCustomerNames(
  customerIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = [...new Set(customerIds.filter((value): value is string => Boolean(value)))];
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  try {
    const { data, error } = await supabaseUntyped.rpc('get_invoice_customer_names', {
      p_customer_ids: ids,
    });
    if (error) throw error;
    const rows = assertRpcResult<InvoiceCustomerNameRow[]>(data, 'get_invoice_customer_names');
    for (const row of rows) {
      const name = row.farm_name?.trim();
      if (row.id && name) names.set(row.id, name);
    }
  } catch (err) {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
      level: 'warning',
      extra: { context: 'get_invoice_customer_names', count: ids.length },
    });
  }
  return names;
}

type CustomerEmbed = { farm_name?: string | null } | null | undefined;

/**
 * Fill the blank `customer.farm_name` embeds on invoice-shaped rows from
 * get_invoice_customer_names (one call for the whole list). Rows that already have a name are
 * returned unchanged; with no blank embed, nothing is called.
 */
export async function fillHiddenCustomerNames<T extends { customer_id?: string | null; customer?: CustomerEmbed }>(
  rows: T[],
): Promise<T[]> {
  const missing = rows
    .filter((row) => row.customer_id && !row.customer?.farm_name?.trim())
    .map((row) => row.customer_id);
  if (missing.length === 0) return rows;
  const names = await fetchInvoiceCustomerNames(missing);
  if (names.size === 0) return rows;
  return rows.map((row) => {
    const name = row.customer_id ? names.get(row.customer_id) : undefined;
    if (!name || row.customer?.farm_name?.trim()) return row;
    return { ...row, customer: { ...(row.customer ?? {}), farm_name: name } };
  });
}
