/**
 * customerStatement.paging.test.ts — Goal 4 part 2b (M57): fetchCustomerStatement reads every
 * row of a statement, and refuses a read whose running balance does not add up.
 *
 * This module is new in part 2b (the screens called get_customer_statement in one request,
 * which the server silently stops at 1,000 rows), so these tests have no old-code version;
 * ARagingStatement.paging.test.tsx proves the same behaviour through the AR Aging screen,
 * where it does fail on the old code. The fake server caps every reply at 1,000 rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pagedRpcReply, SERVER_ROW_CAP } from '../test-utils/inMemoryQuery';
import type { CustomerStatementRow } from '../types';

const H = vi.hoisted(() => ({
  rows: [] as CustomerStatementRow[],
  // When set, answers every request instead of the plain capped server.
  rpc: null as null | ((name: string, args: unknown) => unknown),
  calls: [] as Array<[string, unknown]>,
}));

vi.mock('./db', async () => {
  const actual = await vi.importActual<typeof import('./db')>('./db');
  return {
    ...actual,
    supabase: {
      rpc: (name: string, args: unknown) => {
        H.calls.push([name, args]);
        return H.rpc ? H.rpc(name, args) : pagedRpcReply({ data: H.rows, error: null });
      },
    },
  };
});

import { fetchCustomerStatement, isStatementContinuous, STATEMENT_CHANGED_WHILE_LOADING } from './customerStatement';

const TOTAL = SERVER_ROW_CAP + 205;
const pad = (i: number) => String(i).padStart(4, '0');

// $1.00 per row, running balance correct throughout.
const statement = (count: number): CustomerStatementRow[] => Array.from({ length: count }, (_, i) => ({
  transaction_date: '2026-09-01', transaction_type: 'invoice', reference_number: `INV-${pad(i)}`,
  description: `Row ${pad(i)}`, amount_cents: 100, running_balance: 100 * (i + 1),
}));

beforeEach(() => {
  H.rows = [];
  H.rpc = null;
  H.calls = [];
});

describe('fetchCustomerStatement past the 1,000-row server cap (M57)', () => {
  it('returns all 1,205 rows in the function order', async () => {
    H.rows = statement(TOTAL);
    const { data, error } = await fetchCustomerStatement('c1', '2026-01-01', '2026-12-31');
    expect(error).toBeNull();
    expect(data).toHaveLength(TOTAL);
    expect(data!.map((r) => r.reference_number)).toEqual(H.rows.map((r) => r.reference_number));
    expect(data![TOTAL - 1].running_balance).toBe(100 * TOTAL);
    expect(H.calls.every(([name, args]) => name === 'get_customer_statement'
      && JSON.stringify(args) === JSON.stringify({ p_customer_id: 'c1', p_start_date: '2026-01-01', p_end_date: '2026-12-31' }))).toBe(true);
  });

  it('a running-balance chain broken on both attempts is an error, never a statement', async () => {
    // Row 1,100 is missing: a row dropped at a page seam breaks the chain after it.
    H.rows = statement(TOTAL).filter((_, i) => i !== 1100);
    expect(isStatementContinuous(H.rows)).toBe(false);
    const { data, error } = await fetchCustomerStatement('c1', '2026-01-01', '2026-12-31');
    expect(data).toBeNull();
    expect(error?.message).toBe(STATEMENT_CHANGED_WHILE_LOADING);
  });

  it("a multi-page read whose last row is not the server's current last row is an error", async () => {
    // The pages add up, but the server's last row has since changed (a row was added at
    // the end while the pages were read).
    H.rows = statement(TOTAL);
    const later = statement(TOTAL + 1);
    type Ranged = { range: (from: number, to: number) => unknown };
    H.rpc = () => {
      const reply = pagedRpcReply({ data: H.rows, error: null });
      const range = (reply as Ranged).range;
      // The one-row tail request sees the server as it is now.
      reply.range = (from: number, to: number) => (from === to
        ? (pagedRpcReply({ data: later, error: null }) as Ranged).range(from, to)
        : range(from, to));
      return reply;
    };
    const { data, error } = await fetchCustomerStatement('c1', '2026-01-01', '2026-12-31');
    expect(data).toBeNull();
    expect(error?.message).toBe(STATEMENT_CHANGED_WHILE_LOADING);
  });

  it('a failed read returns its error', async () => {
    H.rpc = () => pagedRpcReply({ data: null, error: { message: 'connection reset' } });
    const { data, error } = await fetchCustomerStatement('c1', '2026-01-01', '2026-12-31');
    expect(data).toBeNull();
    expect(error?.message).toBe('connection reset');
  });

  it('a page with neither rows nor an error is an error, never an empty statement', async () => {
    // The silent-denial shape assertRpcResult guards against; the paging helper would
    // otherwise read the null page as "no rows".
    H.rpc = () => pagedRpcReply({ data: null, error: null });
    const { data, error } = await fetchCustomerStatement('c1', '2026-01-01', '2026-12-31');
    expect(data).toBeNull();
    expect(error?.message).toMatch(/get_customer_statement returned no data/);
  });

  it("an empty answer to the last-row check is returned as an error, not thrown", async () => {
    H.rows = statement(TOTAL);
    type Ranged = { range: (from: number, to: number) => unknown };
    H.rpc = () => {
      const reply = pagedRpcReply({ data: H.rows, error: null });
      const range = (reply as Ranged).range;
      // Only the one-row tail request comes back with neither rows nor an error.
      reply.range = (from: number, to: number) => (from === to
        ? (pagedRpcReply({ data: null, error: null }) as Ranged).range(from, to)
        : range(from, to));
      return reply;
    };
    const { data, error } = await fetchCustomerStatement('c1', '2026-01-01', '2026-12-31');
    expect(data).toBeNull();
    expect(error?.message).toMatch(/get_customer_statement returned no data/);
  });
});
