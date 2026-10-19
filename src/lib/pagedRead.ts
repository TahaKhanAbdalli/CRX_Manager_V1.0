import { chunkIds } from './dispatchDisplay';

// `count` is the server's exact row count for the query, present when the
// caller selects with `{ count: 'exact' }` (see fetchAllRows).
type PageResult<T> = { data: T[] | null; error: { message: string } | null; count?: number | null };
type ReadResult<T> = { data: T[] | null; error: { message: string } | null };

export const PAGE_SIZE = 1000;
// Rows re-read at each page seam when every row has an id (see fetchAllRows).
const SEAM_OVERLAP = 50;
// Whole reads tried before a list that keeps changing is reported as an error.
const MAX_READ_ATTEMPTS = 3;

export const LIST_CHANGED_WHILE_LOADING = 'The list changed while it was loading. Reload to try again.';

/**
 * Read every row of a query, page by page. One request is silently cut off at
 * the PostgREST row cap, so a list or a ledger recompute over a single read
 * hides rows without saying so. Each page must be ordered on a unique column
 * (add `.order('id')` as the last sort key); the loop advances by the rows
 * actually returned, so a server cap below the requested page size still reads
 * everything. Any failed page returns the error, never a partial list.
 *
 * Pages are separate requests, so the rows can move between them:
 * - a row inserted ahead of the read position pushes the seam row onto the
 *   next page as well; rows with an `id` are kept once, so it is never shown
 *   or counted twice;
 * - a row deleted ahead of the read position pulls the seam row back onto the
 *   page already read, where a plain offset read would skip it. When every row
 *   has an `id`, each page after the first starts SEAM_OVERLAP rows early, so
 *   up to that many deletions between two pages still miss nothing.
 * Rows without an `id` (an RPC's computed rows) are read without the overlap.
 *
 * The overlap cannot cover every change: a record whose sort key is edited
 * can jump into the part already read, and a burst of inserts can make a page
 * hold only rows already seen. So when the query selects with
 * `{ count: 'exact' }`, the read is checked against the server's count from its
 * last request; a mismatch means the list changed mid-read, and the whole read
 * is repeated, up to MAX_READ_ATTEMPTS, before failing with
 * LIST_CHANGED_WHILE_LOADING rather than returning a list that is wrong.
 * `src/lib/pagedReadCallSites.test.ts` requires the count on every list read.
 */
export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<ReadResult<T>> {
  for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt += 1) {
    const result = await readOnce(fetchPage);
    if (result.error) return { data: null, error: result.error };
    if (result.serverCount === null || result.serverCount === result.rows.length) {
      return { data: result.rows, error: null };
    }
  }
  return { data: null, error: { message: LIST_CHANGED_WHILE_LOADING } };
}

async function readOnce<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<{ rows: T[]; serverCount: number | null; error: { message: string } | null }> {
  const rows: T[] = [];
  let serverCount: number | null = null;
  // Rows this pass may read before it stops as "changed while loading": a list
  // that keeps growing as fast as it is read would otherwise never finish.
  let rowLimit = Infinity;
  const seenIds = new Set<unknown>();
  for (let from = 0; ;) {
    const { data, error, count } = await fetchPage(from, from + PAGE_SIZE - 1);
    if (error) return { rows, serverCount, error };
    if (typeof count === 'number') {
      if (serverCount === null) rowLimit = count * 2 + PAGE_SIZE;
      serverCount = count;
    }
    if (rows.length > rowLimit) return { rows, serverCount: -1, error: null };
    const page = data ?? [];
    if (page.length === 0) break;
    let newRows = 0;
    let everyRowHasId = true;
    for (const row of page) {
      const id = rowId(row);
      if (id === undefined) {
        everyRowHasId = false;
      } else {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
      }
      rows.push(row);
      newRows += 1;
    }
    // Only the overlap came back: the read has reached the end (or, after a
    // burst of inserts, only looks like it has; the count check catches that).
    if (newRows === 0) break;
    from += everyRowHasId && page.length > SEAM_OVERLAP ? page.length - SEAM_OVERLAP : page.length;
    // A range starting at or past the server's count can be refused outright
    // (PostgREST PGRST103 / 416), so stop here rather than ask for it.
    if (serverCount !== null && from >= serverCount) break;
  }
  return { rows, serverCount, error: null };
}

function rowId(row: unknown): unknown {
  if (row === null || typeof row !== 'object' || !('id' in row)) return undefined;
  const id = (row as { id: unknown }).id;
  return id === null ? undefined : id;
}

/**
 * Read every row matching a list of ids. The ids are sent in chunks so a long
 * list never overflows the request URL, and each chunk is paged with
 * fetchAllRows so a chunk whose rows pass the row cap is still read in full.
 */
export async function fetchAllRowsForIds<T, Id>(
  ids: Id[],
  fetchPage: (idChunk: Id[], from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<ReadResult<T>> {
  const rows: T[] = [];
  for (const idChunk of chunkIds([...new Set(ids)])) {
    const result = await fetchAllRows<T>((from, to) => fetchPage(idChunk, from, to));
    if (result.error) return result;
    // A loop, not push(...rows): one chunk can hold more rows than a call may
    // take as arguments.
    for (const row of result.data ?? []) rows.push(row);
  }
  return { data: rows, error: null };
}
