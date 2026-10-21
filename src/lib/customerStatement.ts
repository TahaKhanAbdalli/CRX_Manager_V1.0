import { supabase, assertRpcResult } from './db';
import { fetchAllRows, PAGE_SIZE } from './pagedRead';
import type { CustomerStatementRow } from '../types';

export const STATEMENT_CHANGED_WHILE_LOADING = 'The statement changed while it was loading. Try again.';

/**
 * True when every row's running balance equals the sum of the amounts up to
 * and including it. `get_customer_statement` computes the balance exactly that
 * way, in its own fixed order (date, source, source row id; the opening-balance
 * row first), before the rows are paged. Its rows carry no id, so a
 * transaction added or removed while the pages were read would repeat or drop
 * a row at a page seam; that breaks this chain.
 */
export function isStatementContinuous(rows: ReadonlyArray<Pick<CustomerStatementRow, 'amount_cents' | 'running_balance'>>): boolean {
  let balanceCents = 0;
  for (const row of rows) {
    balanceCents += Number(row.amount_cents) || 0;
    if (balanceCents !== Number(row.running_balance)) return false;
  }
  return true;
}

function sameStatementRow(a: CustomerStatementRow, b: CustomerStatementRow): boolean {
  return a.transaction_date === b.transaction_date
    && a.transaction_type === b.transaction_type
    && a.reference_number === b.reference_number
    && a.description === b.description
    && a.amount_cents === b.amount_cents
    && a.running_balance === b.running_balance;
}

/**
 * Read every row of one customer's statement. One request stopped at the
 * server's 1,000-row cap, which cut a long statement (and its closing balance)
 * short with no warning (Goal 4 M57). Pages follow the function's own order,
 * the same way Customer Transaction Review reads its report: each read is
 * checked with the running-balance chain, and a read longer than one page
 * must also end on the server's current last row. A read that fails either
 * check is tried once more, then reported as an error, never as a statement.
 */
// A reply with neither rows nor an error is the silent-denial shape
// assertRpcResult guards against. It is returned as this error: the paging
// helper would read it as "no rows" (an empty statement), and assertRpcResult
// would throw past this module's error result.
const NO_DATA = { message: 'get_customer_statement returned no data' };

export async function fetchCustomerStatement(
  customerId: string,
  startDate: string,
  endDate: string,
): Promise<{ data: CustomerStatementRow[] | null; error: { message: string } | null }> {
  const args = { p_customer_id: customerId, p_start_date: startDate, p_end_date: endDate };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await fetchAllRows<CustomerStatementRow>(async (from, to) => {
      const page = await supabase
        .rpc('get_customer_statement', args, { count: 'exact' })
        .range(from, to);
      if (!page.error && (page.data === null || page.data === undefined)) return { data: null, error: NO_DATA, count: null };
      return page;
    });
    if (result.error) return { data: null, error: result.error };
    const rows = assertRpcResult<CustomerStatementRow[]>(result.data, 'get_customer_statement');
    if (!isStatementContinuous(rows)) continue;
    // A multi-page read could keep a row deleted after its page was read and
    // stop before the real last row with the chain intact: the server's
    // current last row must be ours.
    if (rows.length > PAGE_SIZE) {
      const tail = await supabase
        .rpc('get_customer_statement', args, { count: 'exact' })
        .range(rows.length - 1, rows.length - 1);
      if (tail.error) return { data: null, error: tail.error };
      if (tail.data === null || tail.data === undefined) return { data: null, error: NO_DATA };
      const tailRows = assertRpcResult<CustomerStatementRow[]>(tail.data, 'get_customer_statement');
      if (tail.count !== rows.length || tailRows.length !== 1 || !sameStatementRow(tailRows[0], rows[rows.length - 1])) continue;
    }
    return { data: rows, error: null };
  }
  return { data: null, error: { message: STATEMENT_CHANGED_WHILE_LOADING } };
}
