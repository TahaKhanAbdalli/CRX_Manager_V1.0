/**
 * The posting version check (Mason 2026-10-09, addendum 8b; migration 20261009120000).
 *
 * post_invoice and post_invoice_group take an optional trailing p_expected_version. The admin's
 * screen reads the invoice's posting version (an md5 of the invoice header, lines, line shares,
 * customer shares and the customer's payment terms, for EVERY member of a split group) and sends
 * it back with the post. Inside the posting transaction, under the row locks, the database
 * refuses with INVOICE_CHANGED_SINCE_REVIEW when anything that would post has changed since, so
 * a save that lands between the review and the post can never post unseen.
 *
 * src/types/supabase.ts is generated from live and does not yet know the two readers or the new
 * argument (regenerate it after the migration is applied). Until then these calls go through
 * supabaseUntyped, typed here by hand: the readers return one 32-character lowercase md5 text.
 */
import { assertRpcResult, supabaseUntyped } from './db';

const POST_VERSION_PATTERN = /^[0-9a-f]{32}$/;

/** The database (or the screen's own check) found the invoice changed since the screen loaded. */
export const INVOICE_CHANGED_SINCE_REVIEW_MESSAGE = 'This invoice changed since you reviewed it — it has been reloaded; check it and post again.';
/** The screens a bulk Post runs from, as the refusal message names them. */
export type BulkPostScreen = 'list' | 'tray' | 'cockpit' | 'page';
/**
 * A bulk Post (list, tray, cockpit, order page) found invoices changed since the screen loaded:
 * nothing was posted and the screen is being refreshed (src/lib/invoiceBulkPostReview.ts).
 * `names`: the invoice numbers of the changed invoices the screen showed (up to 3 are named).
 */
export const invoicesChangedSinceLoadMessage = (count: number, screen: BulkPostScreen, names: string[] = []): string => {
  const named = names.length === 0
    ? ''
    : ` (${names.slice(0, 3).join(', ')}${names.length > 3 ? `, +${names.length - 3} more` : ''})`;
  return `${count} invoice(s) changed since this ${screen} loaded${named} — nothing was posted. ` +
    `The ${screen} is being refreshed; check them and post again.`;
};
/** The posting version could not be read, so nothing is posted unchecked. */
export const POST_RECHECK_FAILED_MESSAGE = 'Could not check the saved invoice before posting. Nothing was posted — please try again.';

function assertPostVersion(version: unknown, rpcName: string): string {
  if (typeof version !== 'string' || !POST_VERSION_PATTERN.test(version)) {
    throw new Error(`${rpcName} returned an unexpected posting version`);
  }
  return version;
}

/** The posting version of one stand-alone invoice (admin only; anyone else is refused). */
export async function fetchInvoicePostVersion(invoiceId: string): Promise<string> {
  const { data, error } = await supabaseUntyped.rpc('get_invoice_post_version', {
    p_invoice_ids: [invoiceId],
  });
  if (error) throw error;
  const version = assertRpcResult<unknown>(data, 'get_invoice_post_version');
  return assertPostVersion(version, 'get_invoice_post_version');
}

/** The posting version of a whole split group: every non-deleted member (admin only). */
export async function fetchInvoiceGroupPostVersion(invoiceGroupId: string): Promise<string> {
  const { data, error } = await supabaseUntyped.rpc('get_invoice_group_post_version', {
    p_invoice_group_id: invoiceGroupId,
  });
  if (error) throw error;
  const version = assertRpcResult<unknown>(data, 'get_invoice_group_post_version');
  return assertPostVersion(version, 'get_invoice_group_post_version');
}

export interface PostReviewedInvoiceArgs {
  p_invoice_id: string;
  /** Required with a version: the database refuses a versioned post with no key. */
  p_idempotency_key: string;
  p_expected_version: string;
}

/**
 * Refuses before any RPC unless the version is a real posting version. A missing one would be
 * dropped from the JSON body, and the database would then post with no check at all.
 */
function requirePostVersion(version: unknown, rpcName: string): void {
  if (typeof version !== 'string' || !POST_VERSION_PATTERN.test(version)) {
    throw new Error(`${rpcName} needs the reviewed posting version; nothing was posted`);
  }
}

/** post_invoice with the reviewed version. post_invoice RETURNS void, so nothing to assert. */
export async function postReviewedInvoice(args: PostReviewedInvoiceArgs): Promise<void> {
  requirePostVersion(args.p_expected_version, 'post_invoice');
  await supabaseUntyped.rpc('post_invoice', { ...args }).throwOnError();
}

export interface PostReviewedInvoiceGroupArgs {
  p_invoice_group_id: string;
  /** Must be the signed-in admin: the group version is only checked for the caller's own post. */
  p_performed_by: string;
  p_idempotency_key: string;
  p_expected_version: string;
}

/** post_invoice_group with the reviewed version of every member. */
export async function postReviewedInvoiceGroup(args: PostReviewedInvoiceGroupArgs): Promise<unknown> {
  requirePostVersion(args.p_expected_version, 'post_invoice_group');
  const { data, error } = await supabaseUntyped.rpc('post_invoice_group', { ...args });
  if (error) throw error;
  return assertRpcResult<unknown>(data, 'post_invoice_group');
}
