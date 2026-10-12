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
 * shown rows (R2) and member lists (M2) again. M1 must hold only members the screen LOADED (round
 * 2: a member added between R1 and M1, or one past the row cap, on another order or in a status
 * the screen does not load, is "changed"). Each target is bound on its own (round 2): a target
 * whose rows differ between R1 and R2, or whose group's M1 differs from M2 or holds an unloaded
 * member, loses its version (Post refuses it as "changed"); every other target keeps its version.
 * When anything changed, the screen reloads once, which repeats this. Only targets the screen can
 * actually post are bound (the caller picks them), at most six version reads at a time.
 *
 * At click, reviewInvoicePostTargets refuses the whole batch early (nothing posted, screen
 * reloads) when a SELECTED target changed while the baseline was read, a row the screen showed
 * changed since (header columns and updated_at), or a split group's membership changed since M1.
 * Every target needs a version from the baseline: a target without one is never posted unversioned.
 *
 * What is left (documented in docs/manual/KNOWN_ISSUES.md): data the list does not display (lines,
 * shares, the customer's terms) is bound from the moment of the version read, so a change to it
 * between the rows query and that read is inside the version without being on screen unless it
 * also touched the invoice row (updated_at).
 */
import { useCallback, useEffect, useRef } from 'react';
import { ExpectedActionRefusal } from './criticalAction';
import {
  describePostInvoiceBlock,
  hasRpcCode,
  RpcErrorCodes,
  sanitizeError,
  supabase,
} from './db';
import { Sentry } from './sentry';
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
  /** A loaded row that is soft-deleted (the order page keeps them) is never a loaded group member. */
  deleted_at?: string | null;
}

/** The posting versions read when the screen's rows loaded. */
export interface InvoicePostBaseline {
  /** Stand-alone invoice id -> its posting version (absent when it changed while being read). */
  invoiceVersions: Map<string, string>;
  /** Split group id -> the group's posting version, every non-deleted member (absent when changed). */
  groupVersions: Map<string, string>;
  /** Split group id -> the sorted ids of its non-deleted members (M1, read before the versions). */
  groupMembers: Map<string, string[]>;
  /** Stand-alone invoices whose row changed while the baseline was read (no version kept). */
  changedInvoiceIds: string[];
  /**
   * Split group id -> the invoices that made it change while the baseline was read: a shown
   * member row that differs in R2, a member that joined or left between M1 and M2, or a member
   * in M1 the screen never loaded. Such a group keeps no version.
   */
  changedGroups: Map<string, string[]>;
  /** Every changed invoice above. Non-empty: the screen reloads once by itself. */
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

/** Ids that are in one member list and not the other. */
function memberDifference(before: string[], after: string[]): string[] {
  const was = new Set(before);
  const now = new Set(after);
  return [...after.filter((id) => !was.has(id)), ...before.filter((id) => !now.has(id))];
}

/** Ids that are in one member list of a group and not the other, over these groups. */
function membershipChanges(groupIds: string[], before: Map<string, string[]>, after: Map<string, string[]>): string[] {
  return groupIds.flatMap((groupId) => memberDifference(before.get(groupId) ?? [], after.get(groupId) ?? []));
}

/**
 * Binds the posting versions to the rows the screen shows. `postableRows`: the rows of the targets
 * the screen can post, exactly as loaded. `loadedRows`: EVERY row the screen loaded (any status),
 * so a split group's members can be checked against what the screen actually holds. Never rejects:
 * a version that could not be read is absent and the review refuses that target; a failed re-read
 * keeps no version at all.
 */
export async function readInvoicePostBaseline(
  postableRows: InvoicePostShownRow[],
  loadedRows: InvoicePostShownRow[] = postableRows,
): Promise<InvoicePostBaseline> {
  const noVersions = (groupMembers: Map<string, string[]>): InvoicePostBaseline => ({
    invoiceVersions: new Map(), groupVersions: new Map(), groupMembers,
    changedInvoiceIds: [], changedGroups: new Map(), changedIds: [],
  });
  const invoiceIds = [...new Set(postableRows.filter((row) => !row.invoice_group_id).map((row) => row.id))];
  const groupIds = [...new Set(postableRows.map((row) => row.invoice_group_id).filter((id): id is string => !!id))];
  if (invoiceIds.length === 0 && groupIds.length === 0) return noVersions(new Map());

  // The rows bound: each stand-alone postable row, and every live loaded row of a targeted group
  // (the group post posts every member, whatever its status on this screen).
  const targetedGroups = new Set(groupIds);
  const boundById = new Map<string, InvoicePostShownRow>();
  for (const row of postableRows) boundById.set(row.id, row);
  for (const row of loadedRows) {
    if (row.deleted_at == null && row.invoice_group_id && targetedGroups.has(row.invoice_group_id) && !boundById.has(row.id)) {
      boundById.set(row.id, row);
    }
  }
  const boundRows = [...boundById.values()];
  const loadedMembers = new Map<string, Set<string>>(groupIds.map((id) => [id, new Set<string>()]));
  for (const row of boundRows) if (row.invoice_group_id) loadedMembers.get(row.invoice_group_id)?.add(row.id);

  // WHY this order (Luna round 1 HIGH). The rows R1 are on screen already. M1, then V, then R2
  // and M2: any header change between R1 and R2 shows up in R2 (every header save moves
  // updated_at), any membership change between M1 and M2 shows up in M2, and a member added
  // between R1 and M1 is in M1 but not among the loaded rows (round 2), so a version kept here
  // belongs to exactly the header rows on screen and the members the screen loaded. Data the list
  // does not display (lines, shares, the customer's terms) is bound from the moment of the version
  // read, and everything after that read is refused by the database (INVOICE_CHANGED_SINCE_REVIEW).
  const membersBefore = groupIds.length > 0 ? await readGroupMembers(groupIds) : new Map<string, string[]>();
  const [invoiceVersions, groupVersions] = await Promise.all([
    readEach(invoiceIds, fetchInvoicePostVersion),
    readEach(groupIds, fetchInvoiceGroupPostVersion),
  ]);
  const current = await rereadRows(boundRows.map((row) => row.id));
  const membersAfter = groupIds.length > 0 ? await readGroupMembers(groupIds) : new Map<string, string[]>();
  // Without the re-read nothing can be bound: keep no version (Post refuses as recheck_failed).
  if (!current || !membersAfter) return noVersions(membersBefore ?? new Map());

  // Each target on its own (round 2): one changed row drops only its own target's version.
  const changedInvoiceIds = new Set<string>();
  const changedGroups = new Map<string, Set<string>>();
  const markGroup = (groupId: string, invoiceId: string) => {
    const ids = changedGroups.get(groupId) ?? new Set<string>();
    ids.add(invoiceId);
    changedGroups.set(groupId, ids);
  };
  for (const row of boundRows) {
    if (!differs(row, current.get(row.id))) continue;
    if (row.invoice_group_id) markGroup(row.invoice_group_id, row.id);
    else changedInvoiceIds.add(row.id);
  }
  if (membersBefore) {
    for (const groupId of groupIds) {
      const before = membersBefore.get(groupId) ?? [];
      for (const id of memberDifference(before, membersAfter.get(groupId) ?? [])) markGroup(groupId, id);
      // A member the screen never loaded (added after the rows query, past the row cap, on
      // another order, or in a status this screen does not load) would post unseen.
      const loaded = loadedMembers.get(groupId)!;
      for (const id of before) if (!loaded.has(id)) markGroup(groupId, id);
    }
  } else {
    // A group whose first member read failed has no M1 to bind: no version for it.
    groupVersions.clear();
  }
  for (const id of changedInvoiceIds) invoiceVersions.delete(id);
  for (const groupId of changedGroups.keys()) groupVersions.delete(groupId);

  const changedIds = new Set(changedInvoiceIds);
  for (const ids of changedGroups.values()) for (const id of ids) changedIds.add(id);
  return {
    invoiceVersions,
    groupVersions,
    groupMembers: membersBefore ?? new Map(),
    changedInvoiceIds: [...changedInvoiceIds],
    changedGroups: new Map([...changedGroups].map(([groupId, ids]) => [groupId, [...ids]])),
    changedIds: [...changedIds],
  };
}

/**
 * Reads the posting baseline whenever `rows` (the screen's loaded rows) change, for the rows
 * `selectPostable` returns: only the rows of targets this screen's Post can actually post (pass a
 * module-level function so it is stable). When something changed while the baseline was read it
 * calls `reload` once; if the reloaded rows changed again, it does not reload again by itself (Post
 * then refuses the changed targets and reloads), so a busy invoice cannot loop the screen. A
 * baseline that a newer load replaced, or that finishes after the screen closed, never reloads.
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
    const promise = readInvoicePostBaseline(selectPostable(rows), rows);
    const entry = { rows, promise };
    baselineRef.current = entry;
    // Set when a newer load replaces this one or the screen unmounts: this entry then never reloads.
    let cancelled = false;
    void promise.then((result) => {
      // A newer load replaced this one (or the screen turned it off or closed): it decides for itself.
      if (cancelled || baselineRef.current !== entry) return;
      if (result.changedIds.length === 0 || autoReloadedRef.current) {
        autoReloadedRef.current = false;
        return;
      }
      autoReloadedRef.current = true;
      void reloadRef.current();
    });
    return () => {
      cancelled = true;
    };
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
  // A target that changed while the load bound its versions has none; the screen is already
  // reloading (or reloads on this refusal). A change to a target that was not asked for is not
  // a reason to refuse these (round 2).
  const changedAtLoad = new Set<string>();
  const changedStandalone = new Set(baseline.changedInvoiceIds);
  for (const target of targets) {
    if (target.invoiceGroupId) {
      for (const id of baseline.changedGroups.get(target.invoiceGroupId) ?? []) changedAtLoad.add(id);
    } else if (target.invoiceId && changedStandalone.has(target.invoiceId)) {
      changedAtLoad.add(target.invoiceId);
    }
  }
  if (changedAtLoad.size > 0) return { ok: false, reason: 'changed', changedIds: [...changedAtLoad] };
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

/** One bulk target that did not post, and whether the database refused it as changed since load. */
export interface BulkPostFailure {
  message: string;
  refusedAsChanged: boolean;
}

/** `label: why`, marking the database's posting-version refusal (an expected outcome). */
export function bulkPostFailure(label: string, err: unknown): BulkPostFailure {
  return {
    message: `${label}: ${describeBulkPostFailure(err)}`,
    refusedAsChanged: hasRpcCode(err, RpcErrorCodes.INVOICE_CHANGED_SINCE_REVIEW),
  };
}

/**
 * The error a bulk post throws when some targets did not post (Luna round 1 LOW, all four bulk
 * screens). The toast shows `summarize(every failure)`, exactly as before. Sentry gets only the
 * real faults, `summarize(the failures that are not version refusals)`: a target the database
 * refused because it changed since the screen loaded is a normal business outcome, not a fault.
 * `alsoReport`: report even with no such failure (the cockpit's "held back" outcome).
 * Returned as an ExpectedActionRefusal so runCriticalAction shows it without reporting it again.
 */
export function bulkPostOutcomeError(
  failures: BulkPostFailure[],
  summarize: (failureMessages: string[]) => string,
  sentryTag: string,
  alsoReport = false,
): ExpectedActionRefusal {
  const faults = failures.filter((failure) => !failure.refusedAsChanged).map((failure) => failure.message);
  if (faults.length > 0 || alsoReport) {
    Sentry.captureException(new Error(summarize(faults)), { tags: { source: 'critical_action', action: sentryTag } });
  }
  return new ExpectedActionRefusal(sanitizeError(summarize(failures.map((failure) => failure.message))));
}
