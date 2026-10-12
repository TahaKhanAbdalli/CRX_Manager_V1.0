/**
 * Bulk Post review (Codex Luna HIGH, 2026-10-12): the list screens' "Post Selected", "Post All",
 * the cockpit's "Post all clean" and the order page's "Post all drafts" must post only what the
 * screen loaded, as the single-invoice editors already do (src/lib/invoicePostVersion.ts).
 *
 * WHEN the posting version is read (review round 1, 2026-10-12): as soon as the screen's rows
 * load, not when Post is clicked. The version is an md5 of everything that would post: the
 * invoice row, its lines, line shares and customer shares, the customer's payment terms, and for
 * a split group every non-deleted member. Read at load, it binds the post to the state the screen
 * loaded, including the parts a list never shows (a customer's terms, a line edit that leaves the
 * total alone, a group member past the row cap or added later): the database refuses the post
 * with INVOICE_CHANGED_SINCE_REVIEW if any of it changed after that read. Reading it at click
 * time instead would fold every change made between load and click into the version.
 *
 * At click, reviewInvoicePostTargets then refuses the whole batch early (nothing posted, screen
 * reloads) when a row the screen showed changed (header columns and updated_at) or a split
 * group's membership changed since the load-time read. Every load-time version must exist: a
 * target whose version could not be read is never posted unversioned.
 *
 * What is left (documented in docs/manual/KNOWN_ISSUES.md): the load-time read happens right
 * AFTER the rows query, so a change to a line, share or the customer's terms that lands in that
 * moment (well under a second) is in the version without being on the screen; the invoice row
 * itself is still compared, because the click-time re-read checks it against the shown row.
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  describePostInvoiceBlock,
  hasRpcCode,
  RpcErrorCodes,
  sanitizeError,
  supabase,
} from './db';
import {
  fetchInvoiceGroupPostVersion,
  fetchInvoicePostVersion,
  invoicesChangedSinceLoadMessage,
  POST_RECHECK_FAILED_MESSAGE,
  type BulkPostScreen,
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
  /**
   * Required (review round 1): invoices.updated_at is NOT NULL, so a row without it was loaded
   * without the column, and the review refuses it rather than silently comparing less.
   */
  updated_at: string | null;
  /** Used only to name changed invoices in the refusal message. */
  invoice_number?: string;
}

/** The posting versions read when the screen's rows loaded. */
export interface InvoicePostBaseline {
  /** Stand-alone invoice id -> its posting version. */
  invoiceVersions: Map<string, string>;
  /** Split group id -> the group's posting version (every non-deleted member). */
  groupVersions: Map<string, string>;
  /** Split group id -> the sorted ids of its non-deleted members, read after the version. */
  groupMembers: Map<string, string[]>;
}

export type InvoicePostReview =
  | { ok: true; versions: Map<string, string> }
  | { ok: false; reason: 'recheck_failed' }
  | { ok: false; reason: 'changed'; changedIds: string[] };

const MAX_VERSION_READS_IN_FLIGHT = 6;
const ROW_REREAD_CHUNK = 100;
const REREAD_COLUMNS = 'id, status, total_amount_cents, customer_id, invoice_date, invoice_group_id, updated_at, deleted_at';
const MEMBER_COLUMNS = 'id, invoice_group_id';

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

/** Runs `read` for every item, at most MAX_VERSION_READS_IN_FLIGHT at a time; a failed read is left out. */
async function readEach(items: string[], read: (id: string) => Promise<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      try {
        out.set(item, await read(item));
      } catch {
        // Left out on purpose: a target with no load-time version is refused at click.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_VERSION_READS_IN_FLIGHT, items.length) }, worker));
  return out;
}

/** The non-deleted members of these groups, by group (sorted ids), or null when the read failed. */
async function readGroupMembers(groupIds: string[]): Promise<Map<string, string[]> | null> {
  const members = new Map<string, string[]>(groupIds.map((id) => [id, []]));
  try {
    for (let start = 0; start < groupIds.length; start += ROW_REREAD_CHUNK) {
      const chunk = groupIds.slice(start, start + ROW_REREAD_CHUNK);
      const { data, error } = await supabase
        .from('invoices')
        .select(MEMBER_COLUMNS)
        .in('invoice_group_id', chunk)
        .is('deleted_at', null);
      if (error) return null;
      for (const row of (data ?? []) as { id: string; invoice_group_id: string | null }[]) {
        if (row.invoice_group_id && members.has(row.invoice_group_id)) members.get(row.invoice_group_id)!.push(row.id);
      }
    }
  } catch {
    return null;
  }
  for (const ids of members.values()) ids.sort();
  return members;
}

/**
 * Reads the posting version of every postable row's target (its own, or its split group's), and
 * then each group's member ids. Never rejects: a version that could not be read is absent, and
 * the review refuses that target.
 */
export async function readInvoicePostBaseline(postableRows: InvoicePostShownRow[]): Promise<InvoicePostBaseline> {
  const invoiceIds = [...new Set(postableRows.filter((row) => !row.invoice_group_id).map((row) => row.id))];
  const groupIds = [...new Set(postableRows.map((row) => row.invoice_group_id).filter((id): id is string => !!id))];
  const [invoiceVersions, groupVersions] = await Promise.all([
    readEach(invoiceIds, fetchInvoicePostVersion),
    readEach(groupIds, fetchInvoiceGroupPostVersion),
  ]);
  // Members AFTER the versions: a member added in between is in this list but not in the
  // version, so the database refuses that post; never the other way round.
  const groupMembers = groupIds.length > 0 ? await readGroupMembers(groupIds) : new Map<string, string[]>();
  if (!groupMembers) groupVersions.clear();
  return { invoiceVersions, groupVersions, groupMembers: groupMembers ?? new Map() };
}

/**
 * Reads the posting baseline whenever `rows` (the screen's loaded rows) change, for the rows
 * `isPostable` keeps (pass a module-level function so it is stable). Returns a getter: given the
 * rows a Post handler acted on, it returns that load's baseline, or null when those are not the
 * rows the baseline was read for (the review then refuses; nothing posts unversioned).
 */
export function useInvoicePostBaseline<T extends InvoicePostShownRow>(
  rows: T[],
  enabled: boolean,
  isPostable: (row: T) => boolean,
): (forRows: T[]) => Promise<InvoicePostBaseline> | null {
  const baselineRef = useRef<{ rows: T[]; promise: Promise<InvoicePostBaseline> } | null>(null);
  useEffect(() => {
    if (!enabled) {
      baselineRef.current = null;
      return;
    }
    baselineRef.current = { rows, promise: readInvoicePostBaseline(rows.filter(isPostable)) };
  }, [rows, enabled, isPostable]);
  return useCallback((forRows: T[]) => (
    baselineRef.current && baselineRef.current.rows === forRows ? baselineRef.current.promise : null
  ), []);
}

function differs(shown: InvoicePostShownRow, current: RereadRow | undefined): boolean {
  if (!current || current.deleted_at != null) return true;
  if (shown.updated_at == null) return true;
  if (current.updated_at !== shown.updated_at) return true;
  if (current.status !== shown.status) return true;
  if (current.total_amount_cents !== shown.total_amount_cents) return true;
  if (current.customer_id !== shown.customer_id) return true;
  if (current.invoice_date !== shown.invoice_date) return true;
  if ((current.invoice_group_id ?? null) !== (shown.invoice_group_id ?? null)) return true;
  return false;
}

/**
 * Checks that every shown row is still exactly what the screen showed and that each targeted
 * split group still has the members it had at load, and returns each target's LOAD-TIME posting
 * version (keyed by target.key) to send with its post. Nothing is posted here.
 */
export async function reviewInvoicePostTargets(
  targets: InvoicePostReviewTarget[],
  shownRows: InvoicePostShownRow[],
  baselinePromise: Promise<InvoicePostBaseline> | null,
): Promise<InvoicePostReview> {
  // Step 1: every target needs the version read when the screen loaded.
  if (!baselinePromise) return { ok: false, reason: 'recheck_failed' };
  let baseline: InvoicePostBaseline;
  try {
    baseline = await baselinePromise;
  } catch {
    return { ok: false, reason: 'recheck_failed' };
  }
  const versions = new Map<string, string>();
  for (const target of targets) {
    const version = target.invoiceGroupId
      ? baseline.groupVersions.get(target.invoiceGroupId)
      : target.invoiceId ? baseline.invoiceVersions.get(target.invoiceId) : undefined;
    if (!version) return { ok: false, reason: 'recheck_failed' };
    versions.set(target.key, version);
  }

  // Step 2: re-read the rows the screen showed.
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
  const changed = new Set(ids.filter((id) => differs(shownById.get(id)!, current.get(id))));

  // Step 3: each targeted group must have exactly the members it had when the version was read.
  const groupIds = [...new Set(targets.map((t) => t.invoiceGroupId).filter((id): id is string => !!id))];
  if (groupIds.length > 0) {
    const now = await readGroupMembers(groupIds);
    if (!now) return { ok: false, reason: 'recheck_failed' };
    for (const groupId of groupIds) {
      const before = new Set(baseline.groupMembers.get(groupId) ?? []);
      const after = new Set(now.get(groupId) ?? []);
      for (const id of after) if (!before.has(id)) changed.add(id);
      for (const id of before) if (!after.has(id)) changed.add(id);
    }
  }

  if (changed.size > 0) return { ok: false, reason: 'changed', changedIds: [...changed] };
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

/**
 * The plain-English message for a refused review (nothing was posted), naming the screen and up
 * to three of the changed invoices the screen showed.
 */
export function failedPostReviewMessage(
  review: Exclude<InvoicePostReview, { ok: true }>,
  screen: BulkPostScreen,
  shownRows: InvoicePostShownRow[] = [],
): string {
  if (review.reason !== 'changed') return POST_RECHECK_FAILED_MESSAGE;
  const numberById = new Map(shownRows.map((row) => [row.id, row.invoice_number]));
  const names = review.changedIds
    .map((id) => numberById.get(id))
    .filter((name): name is string => !!name);
  return invoicesChangedSinceLoadMessage(review.changedIds.length, screen, names);
}

/** One bulk target's database refusal (other targets in the same run may have posted). */
export const BULK_TARGET_CHANGED_MESSAGE = 'changed since this screen loaded, so it was not posted — check it and post again';

/**
 * Why one target of a bulk post failed, in plain English: the posting-version refusal names
 * only that target (sanitizeError's single-invoice wording says "nothing was posted", which is
 * wrong when other targets of the run did post), then the shared billing-gate wording.
 */
export function describeBulkPostFailure(err: unknown): string {
  if (hasRpcCode(err, RpcErrorCodes.INVOICE_CHANGED_SINCE_REVIEW)) return BULK_TARGET_CHANGED_MESSAGE;
  return describePostInvoiceBlock(err) ?? sanitizeError(err);
}
