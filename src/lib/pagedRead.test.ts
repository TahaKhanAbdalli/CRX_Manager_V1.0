import { describe, expect, it } from 'vitest';
import { fetchAllRows, fetchAllRowsForIds, LIST_CHANGED_WHILE_LOADING } from './pagedRead';

type Row = { id: string };

const ids = (n: number, prefix = 'r') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${String(i).padStart(5, '0')}` }));

/** A server stand-in: `before(call)` may change the table before each request; every response carries the exact count. */
function server(initial: Row[], before: (call: number, rows: Row[]) => Row[] = (_c, r) => r) {
  let rows = initial;
  let call = 0;
  const ranges: Array<[number, number]> = [];
  return {
    ranges,
    rows: () => rows,
    page: async (from: number, to: number) => {
      call += 1;
      rows = before(call, rows);
      ranges.push([from, to]);
      // Like a strict server: a range starting at or past the end of a non-empty
      // list is refused (PGRST103), and never more than 1,000 rows come back.
      if (from > 0 && from >= rows.length) {
        return { data: null, error: { message: 'Requested range not satisfiable' }, count: null };
      }
      return { data: rows.slice(from, Math.min(to, from + 999) + 1), error: null, count: rows.length };
    },
  };
}

describe('fetchAllRows', () => {
  it('reads every row past the 1,000-row cap', async () => {
    const all = Array.from({ length: 2500 }, (_, i) => i);
    const result = await fetchAllRows(async (from, to) => ({ data: all.slice(from, to + 1), error: null }));
    expect(result.data).toEqual(all);
  });

  it('keeps every original row once when an insert between pages shifts the seam row', async () => {
    const original = ids(1001);
    const s = server(original, (call, rows) => (call === 2 ? [{ id: 'new' }, ...rows] : rows));
    const result = await fetchAllRows<Row>(s.page);
    const got = (result.data ?? []).map((r) => r.id);
    expect(new Set(got).size).toBe(got.length);
    // Every row present at the end of the read is in the result, exactly once.
    expect(new Set(got)).toEqual(new Set(s.rows().map((r) => r.id)));
  });

  it('misses nothing when rows are deleted ahead of the read between pages', async () => {
    // Three already-read rows are deleted after page one.
    const s = server(ids(2500), (call, rows) => (call === 2 ? rows.filter((_, i) => i < 10 || i >= 13) : rows));
    const result = await fetchAllRows<Row>(s.page);
    expect(new Set((result.data ?? []).map((r) => r.id))).toEqual(new Set(s.rows().map((r) => r.id)));
  });

  it('re-reads when a row moves into the part already read (a sort-key edit)', async () => {
    // Row r01500 is edited after page one so it sorts first; offsets never revisit it.
    const s = server(ids(2000), (call, rows) => {
      if (call !== 2) return rows;
      const moved = rows.find((r) => r.id === 'r01500')!;
      return [moved, ...rows.filter((r) => r !== moved)];
    });
    const result = await fetchAllRows<Row>(s.page);
    expect(result.error).toBeNull();
    expect(new Set((result.data ?? []).map((r) => r.id))).toEqual(new Set(s.rows().map((r) => r.id)));
    // The first pass came up one short of the count, so the read was repeated.
    expect(s.ranges.filter(([from]) => from === 0).length).toBeGreaterThan(1);
  });

  it('re-reads when a burst of inserts makes a page hold only rows already seen', async () => {
    const s = server(ids(2000), (call, rows) => (call === 2 ? [...ids(950, 'n'), ...rows] : rows));
    const result = await fetchAllRows<Row>(s.page);
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(2950);
  });

  it('fails instead of returning a wrong list when the list never settles', async () => {
    let n = 0;
    const s = server(ids(1500), (_call, rows) => [{ id: `churn-${n++}` }, ...rows]);
    const result = await fetchAllRows<Row>(s.page);
    expect(result).toEqual({ data: null, error: { message: LIST_CHANGED_WHILE_LOADING } });
  });

  it('gives up on a list that grows as fast as it is read', async () => {
    let n = 0;
    // An import appends 1,000 rows before every request.
    const s = server(ids(1000), (_call, rows) => [...rows, ...Array.from({ length: 1000 }, () => ({ id: `grow-${n++}` }))]);
    const result = await fetchAllRows<Row>(s.page);
    expect(result).toEqual({ data: null, error: { message: LIST_CHANGED_WHILE_LOADING } });
    expect(s.ranges.length).toBeLessThan(100);
  });

  it('never asks for a range starting at the end of a small or exact-multiple list', async () => {
    for (const size of [1, 34, 50, 1000, 2000]) {
      const s = server(ids(size));
      const result = await fetchAllRows<Row>(s.page);
      expect(result.error, `size ${size}`).toBeNull();
      expect(result.data, `size ${size}`).toHaveLength(size);
      expect(s.ranges.every(([from]) => from === 0 || from < size), `size ${size}`).toBe(true);
    }
  });

  it('stops after the overlap-only page at the end', async () => {
    const s = server(ids(1500));
    const result = await fetchAllRows<Row>(s.page);
    expect(result.data).toHaveLength(1500);
    expect(s.ranges).toEqual([[0, 999], [950, 1949], [1450, 2449]]);
  });

  it('keeps rows without an id as they are', async () => {
    const pages = [[{ n: 1 }, { n: 1 }], []];
    let call = 0;
    const result = await fetchAllRows(async () => ({ data: pages[call++], error: null }));
    expect(result.data).toEqual([{ n: 1 }, { n: 1 }]);
  });

  it('returns the error instead of a partial list', async () => {
    let call = 0;
    const result = await fetchAllRows(async () => (call++ === 0
      ? { data: ids(1000), error: null, count: 1500 }
      : { data: null, error: { message: 'boom' } }));
    expect(result).toEqual({ data: null, error: { message: 'boom' } });
  });
});

describe('fetchAllRowsForIds', () => {
  it('sends ids in chunks of 200 and reads a chunk whose rows pass the row cap', async () => {
    const parentIds = Array.from({ length: 450 }, (_, i) => `id-${i}`);
    const chunkSizes: number[] = [];
    // Each id owns 6 rows, so a 200-id chunk holds 1,200 rows: more than one page.
    const result = await fetchAllRowsForIds(parentIds, async (chunk, from, to) => {
      if (from === 0) chunkSizes.push(chunk.length);
      const rows = chunk.flatMap((id) => [1, 2, 3, 4, 5, 6].map((n) => ({ id: `${id}:${n}` })));
      return { data: rows.slice(from, to + 1), error: null, count: rows.length };
    });
    expect(chunkSizes).toEqual([200, 200, 50]);
    expect(result.data).toHaveLength(450 * 6);
    expect(new Set((result.data ?? []).map((r) => r.id)).size).toBe(450 * 6);
  });

  it('reads a repeated id once', async () => {
    const seen: string[][] = [];
    await fetchAllRowsForIds(['a', 'b', 'a'], async (chunk) => {
      seen.push(chunk);
      return { data: [], error: null };
    });
    expect(seen).toEqual([['a', 'b']]);
  });

  it('returns the error instead of the chunks read so far', async () => {
    const parentIds = Array.from({ length: 300 }, (_, i) => i);
    let call = 0;
    const result = await fetchAllRowsForIds(parentIds, async (chunk, from) => {
      call += 1;
      if (call > 2) return { data: null, error: { message: 'boom' } };
      return { data: from === 0 ? chunk.slice(0, 1) : [], error: null };
    });
    expect(result).toEqual({ data: null, error: { message: 'boom' } });
  });

  it('makes no request for an empty id list', async () => {
    let calls = 0;
    const result = await fetchAllRowsForIds([], async () => {
      calls += 1;
      return { data: [], error: null };
    });
    expect(calls).toBe(0);
    expect(result).toEqual({ data: [], error: null });
  });
});
