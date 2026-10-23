/**
 * Posting binds the invoice version a screen loaded (Goal 3, migration 20261022022000).
 *
 * `invoice_post_version` (INVOICE_POST_VERSION_COLUMNS in costFields.ts) is a computed field on
 * `invoices`: select it in the SAME query as the
 * invoice row the screen shows, so the version and the row come from one database snapshot. Read
 * the lines after it, never before, so a save landing in between makes the post refuse rather
 * than slip through. post_invoice takes that version and post_invoice_group takes one per member
 * the screen loaded; both refuse INVOICE_CHANGED_SINCE_LOADED when the saved invoice changed, or
 * a member was added to or removed from the group, since.
 */
import { supabase, assertRpcResult } from './db';
import type { InvoicePostTarget } from './invoiceBatchPosting';

export const INVOICE_POST_VERSION_MISSING_MESSAGE =
  'This screen could not read the invoice version it needs to post. Reload the page, then post again.';

/**
 * Sent for a row that loaded with a NULL version. The computed field withholds the version from a
 * sales rep for an invoice under another salesperson's name, so Post goes to the server, which
 * refuses INVOICE_SCOPE_DENIED ("only invoices under your own name") before it compares versions,
 * instead of telling the rep to reload forever. It never equals a real version, so it never posts.
 */
export const WITHHELD_POST_VERSION = 'withheld';

/**
 * The version a screen loaded; WITHHELD_POST_VERSION when the row loaded without one (the server
 * then says why); or, when no version was read at all, an error the posting UI shows instead.
 */
export function requirePostVersion(version: string | null | undefined): string {
  if (version === null) return WITHHELD_POST_VERSION;
  if (!version || !version.trim()) throw new Error(INVOICE_POST_VERSION_MISSING_MESSAGE);
  return version;
}

/** Every version in a loaded map (see requirePostVersion), or the "reload" error when none loaded. */
export function requireGroupVersions(loaded: Record<string, string | null | undefined>): Record<string, string> {
  const entries = Object.entries(loaded);
  if (entries.length === 0) throw new Error(INVOICE_POST_VERSION_MISSING_MESSAGE);
  return Object.fromEntries(entries.map(([invoiceId, version]) => [invoiceId, requirePostVersion(version)]));
}

/** Post one list target (a standalone invoice or a whole split group) with the versions it was loaded with. */
export async function postInvoiceTarget(
  target: InvoicePostTarget,
  performedBy: string,
  idempotencyKey: string,
): Promise<void> {
  if (target.operation === 'post_invoice_group') {
    const { data, error } = await supabase.rpc('post_invoice_group', {
      p_invoice_group_id: target.invoiceGroupId!,
      p_performed_by: performedBy,
      p_expected_versions: requireGroupVersions(target.loadedVersions),
      p_idempotency_key: idempotencyKey,
    });
    if (error) throw error;
    assertRpcResult(data, 'post_invoice_group');
    return;
  }
  // post_invoice RETURNS void — .throwOnError(), no result to assert.
  await supabase.rpc('post_invoice', {
    p_invoice_id: target.invoiceId!,
    p_expected_version: requirePostVersion(target.loadedVersions[target.invoiceId!]),
    p_idempotency_key: idempotencyKey,
  }).throwOnError();
}
