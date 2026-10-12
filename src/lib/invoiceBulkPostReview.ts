/**
 * Bulk Post review (Codex Luna HIGH, 2026-10-12): the list screens' "Post Selected", "Post All",
 * the cockpit's "Post all clean" and the order page's "Post all drafts" must post only what the
 * screen showed, as the single-invoice editors already do (src/lib/invoicePostVersion.ts).
 *
 * reviewInvoicePostTargets reads every target's posting version FIRST, and only then re-reads
 * the rows the screen showed. The database posts only the state whose version was read (it
 * re-checks the version under its row locks). So a change landing between the two reads either
 * shows in the re-read rows (refused here) or changes the version (refused by the database), and
 * a post that succeeds is exactly what the screen showed. Reading the rows first would leave a
 * gap: a change after the row read but before the version read would be in the version and
 * look reviewed.
 */
import { supabase } from './db';
import {
  fetchInvoiceGroupPostVersion,
  fetchInvoicePostVersion,
  INVOICES_CHANGED_SINCE_LIST_LOADED_MESSAGE,
  POST_RECHECK_FAILED_MESSAGE,
} from './invoicePostVersion';

/** One posting action: a stand-alone invoice (invoiceId) or a whole split group (invoiceGroupId). */
export interface InvoicePostReviewTarget {
  key: string;
  invoiceId?: string;
  invoiceGroupId?: string;
}

/** An invoice row exactly as the screen showed it when the admin chose to post. */
export interface InvoicePostShownRow {
  id: string;
  status: string;
  total_amount_cents: number;
  customer_id: string;
  invoice_date: string;
  invoice_group_id?: string | null;
  /** Compared only when the screen loaded it. */
  updated_at?: string | null;
}

export type InvoicePostReview =
  | { ok: true; versions: Map<string, string> }
  | { ok: false; reason: 'recheck_failed' }
  | { ok: false; reason: 'changed'; changedIds: string[] };

const MAX_VERSION_READS_IN_FLIGHT = 6;
const ROW_REREAD_CHUNK = 100;
const REREAD_COLUMNS = 'id, status, total_amount_cents, customer_id, invoice_date, invoice_group_id, updated_at, deleted_at';

interface RereadRow {
  id: string;
  status: string;
  total_amount_cents: number;
  customer_id: string;
  invoice_date: string;
  invoice_group_id: string | null;
  updated_at: string | null;
  deleted_at: string | null;
}

function readVersion(target: InvoicePostReviewTarget): Promise<string> {
  if (target.invoiceGroupId) return fetchInvoiceGroupPostVersion(target.invoiceGroupId);
  if (target.invoiceId) return fetchInvoicePostVersion(target.invoiceId);
  return Promise.reject(new Error(`Post target ${target.key} names no invoice or group`));
}

/** Reads every target's version, at most MAX_VERSION_READS_IN_FLIGHT at a time. */
async function readAllVersions(targets: InvoicePostReviewTarget[]): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  let next = 0;
  let failed = false;
  const worker = async () => {
    // After one failure the review is refused anyway, so no further reads start.
    while (!failed && next < targets.length) {
      const target = targets[next];
      next += 1;
      try {
        versions.set(target.key, await readVersion(target));
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_VERSION_READS_IN_FLIGHT, targets.length) }, worker));
  return versions;
}

function differs(shown: InvoicePostShownRow, current: RereadRow | undefined): boolean {
  if (!current || current.deleted_at != null) return true;
  if (current.status !== shown.status) return true;
  if (current.total_amount_cents !== shown.total_amount_cents) return true;
  if (current.customer_id !== shown.customer_id) return true;
  if (current.invoice_date !== shown.invoice_date) return true;
  if ((current.invoice_group_id ?? null) !== (shown.invoice_group_id ?? null)) return true;
  if (shown.updated_at != null && current.updated_at !== shown.updated_at) return true;
  return false;
}

/**
 * Checks that every shown row is still exactly what the screen showed, and returns each
 * target's posting version (keyed by target.key) to send with its post. Nothing is posted here.
 */
export async function reviewInvoicePostTargets(
  targets: InvoicePostReviewTarget[],
  shownRows: InvoicePostShownRow[],
): Promise<InvoicePostReview> {
  // Step 1: every version first.
  let versions: Map<string, string>;
  try {
    versions = await readAllVersions(targets);
  } catch {
    return { ok: false, reason: 'recheck_failed' };
  }

  // Step 2: only now re-read the rows the screen showed.
  const shownById = new Map(shownRows.map((row) => [row.id, row]));
  const ids = [...shownById.keys()];
  const current = new Map<string, RereadRow>();
  try {
    for (let start = 0; start < ids.length; start += ROW_REREAD_CHUNK) {
      const chunk = ids.slice(start, start + ROW_REREAD_CHUNK);
      const { data, error } = await supabase.from('invoices').select(REREAD_COLUMNS).in('id', chunk);
      if (error) return { ok: false, reason: 'recheck_failed' };
      for (const row of (data ?? []) as RereadRow[]) current.set(row.id, row);
    }
  } catch {
    return { ok: false, reason: 'recheck_failed' };
  }

  // Step 3: any missing, deleted or changed row refuses the whole post.
  const changedIds = ids.filter((id) => differs(shownById.get(id)!, current.get(id)));
  if (changedIds.length > 0) return { ok: false, reason: 'changed', changedIds };
  return { ok: true, versions };
}

/**
 * The rows the screen holds for these targets: a stand-alone invoice's own row, and EVERY loaded
 * row of a split group (the group post posts them all, including members a filter hides).
 */
export function shownRowsForTargets<T extends InvoicePostShownRow>(
  targets: InvoicePostReviewTarget[],
  loadedRows: T[],
): T[] {
  const invoiceIds = new Set(targets.filter((t) => !t.invoiceGroupId && t.invoiceId).map((t) => t.invoiceId));
  const groupIds = new Set(targets.filter((t) => t.invoiceGroupId).map((t) => t.invoiceGroupId));
  return loadedRows.filter((row) =>
    invoiceIds.has(row.id) || (row.invoice_group_id != null && groupIds.has(row.invoice_group_id)));
}

/** The plain-English message for a refused review (nothing was posted). */
export function failedPostReviewMessage(review: Exclude<InvoicePostReview, { ok: true }>): string {
  return review.reason === 'changed'
    ? INVOICES_CHANGED_SINCE_LIST_LOADED_MESSAGE(review.changedIds.length)
    : POST_RECHECK_FAILED_MESSAGE;
}
