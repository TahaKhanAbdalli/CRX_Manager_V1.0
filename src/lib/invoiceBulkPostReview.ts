/**
 * Bulk Post review (Codex Luna HIGH, 2026-10-12): the list screens' "Post Selected", "Post All",
 * the cockpit's "Post all clean" and the order page's "Post all drafts" must post only what the
 * screen loaded, as the single-invoice editors already do (src/lib/invoicePostVersion.ts).
 *
 * WHEN the posting version is read (review round 1, 2026-10-12): as soon as the screen's rows
 * load, not when Post is clicked. The version is an md5 of everything that would post: the
 * invoice row, its lines, line shares and customer shares, the customer's payment terms, and for
 * a split group every non-deleted member. The database refuses the post with
 * INVOICE_CHANGED_SINCE_REVIEW if any of it changed after that read. Reading it at click time
 * instead would fold every change made between load and click into the version.
 *
 * HOW the load binds what the screen shows (Luna round 1 HIGH): the shown rows R1 are already on
 * screen; then each targeted split group's member list M1 is read, THEN the versions V, THEN the
 * shown rows (R2) and member lists (M2) again. If R2 differs from R1 or M2 from M1, the baseline
 * is thrown away (no version is kept, Post refuses as "changed") and the screen reloads once,
 * which repeats this. Only targets the screen can actually post are bound (the caller picks
 * them), at most six version reads at a time.
 *
 * At click, reviewInvoicePostTargets refuses the whole batch early (nothing posted, screen
 * reloads) when the baseline was thrown away, a row the screen showed changed (header columns
 * and updated_at), or a split group's membership changed since M1. Every target needs a version
 * from a valid baseline: a target without one is never posted unversioned.
 *
 * What is left (documented in docs/manual/KNOWN_ISSUES.md): data the list does not display (lines,
 * shares, the customer's terms) is bound from the moment of the version read, so a change to it
 * between the rows query and that read is inside the version without being on screen unless it
 * also touched the invoice row (updated_at); and the member list is bound from M1, so a member
 * added to a split group between the rows query and M1 is inside M1, M2 and the version unless
 * the add also changed a shown member row (M1 is not compared with the loaded rows, because a
 * group may have members a screen never loads: past its row cap, or in another status).
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
  /** Split group id -> the sorted ids of its non-deleted members (M1, read before the versions). */
  groupMembers: Map<string, string[]>;
  /**
   * Invoices that changed while the baseline was being read (a shown row whose re-read R2
   * differs, or a member that joined or left between M1 and M2). Non-empty means the baseline is
   * NOT valid: it holds no versions, Post refuses as "changed" and the screen reloads.
   */
  changedIds: string[];
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

/** The current state of these invoice ids (deleted ones too), or null when the read failed. */
async function rereadRows(ids: string[]): Promise<Map<string, RereadRow> | null> {
  const current = new Map<string, RereadRow>();
  try {
    for (let start = 0; start < ids.length; start += ROW_REREAD_CHUNK) {
      const chunk = ids.slice(start, start + ROW_REREAD_CHUNK);
      const { data, error } = await supabase.from('invoices').select(REREAD_COLUMNS).in('id', chunk);
      if (error) return null;
      for (const row of (data ?? []) as RereadRow[]) current.set(row.id, row);
    }
  } catch {
    return null;
  }
  return current;
}

/** True when a shown row is gone, deleted, or no longer matches what the screen showed. */
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

/** Ids that are in one member list of a group and not the other. */
function membershipChanges(groupIds: string[], before: Map<string, string[]>, after: Map<string, string[]>): string[] {
  const changed: string[] = [];
  for (const groupId of groupIds) {
    const was = new Set(before.get(groupId) ?? []);
    const now = new Set(after.get(groupId) ?? []);
    for (const id of now) if (!was.has(id)) changed.push(id);
    for (const id of was) if (!now.has(id)) changed.push(id);
  }
  return changed;
}

/**
 * Binds the posting versions to the rows the screen shows (`shownRows`: the rows of the targets
 * the screen can post, exactly as loaded). Never rejects: a version that could not be read is
 * absent and the review refuses that target; a failed re-read keeps no version at all.
 */
export async function readInvoicePostBaseline(shownRows: InvoicePostShownRow[]): Promise<InvoicePostBaseline> {
  const noVersions = (groupMembers: Map<string, string[]>, changedIds: string[]): InvoicePostBaseline => ({
    invoiceVersions: new Map(), groupVersions: new Map(), groupMembers, changedIds,
  });
  const invoiceIds = [...new Set(shownRows.filter((row) => !row.invoice_group_id).map((row) => row.id))];
  const groupIds = [...new Set(shownRows.map((row) => row.invoice_group_id).filter((id): id is string => !!id))];
  if (shownRows.length === 0) return noVersions(new Map(), []);

  // WHY this order (Luna round 1 HIGH). The rows R1 are on screen already. M1, then V, then R2
  // and M2: any header change between R1 and R2 shows up in R2 (every header save moves
  // updated_at), and any membership change between M1 and M2 shows up in M2, so a valid V belongs
  // to exactly the header rows on screen and the member list M1. Data the list does not display
  // (lines, shares, the customer's terms) is bound from the moment of the version read, and
  // everything after that read is refused by the database (INVOICE_CHANGED_SINCE_REVIEW).
  const membersBefore = groupIds.length > 0 ? await readGroupMembers(groupIds) : new Map<string, string[]>();
  const [invoiceVersions, groupVersions] = await Promise.all([
    readEach(invoiceIds, fetchInvoicePostVersion),
    readEach(groupIds, fetchInvoiceGroupPostVersion),
  ]);
  const current = await rereadRows(shownRows.map((row) => row.id));
  const membersAfter = groupIds.length > 0 ? await readGroupMembers(groupIds) : new Map<string, string[]>();
  // Without the re-read nothing can be bound: keep no version (Post refuses as recheck_failed).
  if (!current || !membersAfter) return noVersions(membersBefore ?? new Map(), []);

  const changed = new Set(shownRows.filter((row) => differs(row, current.get(row.id))).map((row) => row.id));
  if (membersBefore) for (const id of membershipChanges(groupIds, membersBefore, membersAfter)) changed.add(id);
  if (changed.size > 0) return noVersions(membersBefore ?? new Map(), [...changed]);
  // A group whose first member read failed has no M1 to bind: no version for it.
  if (!membersBefore) groupVersions.clear();
  return { invoiceVersions, groupVersions, groupMembers: membersBefore ?? new Map(), changedIds: [] };
}

/**
 * Reads the posting baseline whenever `rows` (the screen's loaded rows) change, for the rows
 * `selectPostable` returns: only the rows of targets this screen's Post can actually post (pass a
 * module-level function so it is stable). When the baseline is not valid (something changed while
 * it was read) it calls `reload` once; if the reloaded rows are not valid either, it does not
 * reload again by itself (Post then refuses and reloads), so a busy invoice cannot loop the screen.
 * Returns a getter: given the rows a Post handler acted on, it returns that load's baseline, or
 * null when those are not the rows the baseline was read for (the review then refuses).
 */
export function useInvoicePostBaseline<T extends InvoicePostShownRow>(
  rows: T[],
  enabled: boolean,
  selectPostable: (rows: T[]) => T[],
  reload: () => unknown,
): (forRows: T[]) => Promise<InvoicePostBaseline> | null {
  const baselineRef = useRef<{ rows: T[]; promise: Promise<InvoicePostBaseline> } | null>(null);
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);
  // True right after this hook asked for a reload; the next baseline decides whether to ask again.
  const autoReloadedRef = useRef(false);
  useEffect(() => {
    if (!enabled) {
      baselineRef.current = null;
      return;
    }
    const promise = readInvoicePostBaseline(selectPostable(rows));
    const entry = { rows, promise };
    baselineRef.current = entry;
    void promise.then((result) => {
      // A newer load replaced this one (or the screen turned it off): it decides for itself.
      if (baselineRef.current !== entry) return;
      if (result.changedIds.length === 0 || autoReloadedRef.current) {
        autoReloadedRef.current = false;
        return;
      }
      autoReloadedRef.current = true;
      void reloadRef.current();
    });
  }, [rows, enabled, selectPostable]);
  return useCallback((forRows: T[]) => (
    baselineRef.current && baselineRef.current.rows === forRows ? baselineRef.current.promise : null
  ), []);
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
  // Something changed while the load bound its versions: the baseline holds none; the screen is
  // already reloading (or reloads on this refusal).
  if (baseline.changedIds.length > 0) return { ok: false, reason: 'changed', changedIds: [...baseline.changedIds] };
  const versions = new Map<string, string>();
  for (const target of targets) {
    const version = target.invoiceGroupId
      ? baseline.groupVersions.get(target.invoiceGroupId)
      : target.invoiceId ? baseline.invoiceVersions.get(target.invoiceId) : undefined;
    if (!version) return { ok: false, reason: 'recheck_failed' };
    versions.set(target.key, version);
  }

  // Step 2: re-read the rows the screen showed.
  const current = await rereadRows(shownRows.map((row) => row.id));
  if (!current) return { ok: false, reason: 'recheck_failed' };
  const changed = new Set(shownRows.filter((row) => differs(row, current.get(row.id))).map((row) => row.id));

  // Step 3: each targeted group must have exactly the members it had when the version was bound (M1).
  const groupIds = [...new Set(targets.map((t) => t.invoiceGroupId).filter((id): id is string => !!id))];
  if (groupIds.length > 0) {
    const now = await readGroupMembers(groupIds);
    if (!now) return { ok: false, reason: 'recheck_failed' };
    for (const id of membershipChanges(groupIds, baseline.groupMembers, now)) changed.add(id);
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
