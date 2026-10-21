/**
 * reconciliation.paging.test.ts — Goal 4 part 2: integrity checks 5, 6, 9 and 10 read every row.
 *
 * Each of these checks read its table in one request, which the server silently stops at
 * 1,000 rows. A problem past row 1,000 was never seen (the check passed), and check 6 also
 * reported a false problem when a quote's hold fell past the cap. The fake server here caps
 * every reply at 1,000 rows like the real one, so these tests fail against the old checks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInMemoryQuery, SERVER_ROW_CAP } from '../test-utils/inMemoryQuery';

type Row = Record<string, unknown>;
const H = vi.hoisted(() => ({ tables: {} as Record<string, Row[]> }));

vi.mock('./db', () => ({
  supabase: { from: (table: string) => buildInMemoryQuery(H.tables[table] ?? []) },
}));

import { runReconciliationChecks } from './reconciliation';

const TOTAL = SERVER_ROW_CAP + 10;
const pad = (i: number) => String(i).padStart(4, '0');
const many = (make: (i: number) => Row): Row[] => Array.from({ length: TOTAL }, (_, i) => make(i));
const LAST = TOTAL - 1;

beforeEach(() => {
  H.tables = {};
});

async function check(name: string) {
  const report = await runReconciliationChecks();
  const found = report.checks.find((c) => c.name === name);
  if (!found) throw new Error(`no check named ${name}`);
  return found;
}

describe('integrity checks past the 1,000-row server cap', () => {
  it('check 5 (commission splits) sees a bad split past row 1,000', async () => {
    H.tables.commissions = many((i) => ({
      id: `cm${pad(i)}`, order_id: `o${pad(i)}`, job_id: null, invoice_id: null, status: 'pending',
      order_number: `ORD-${pad(i)}`, split_percentage: i === LAST ? 50 : 100,
    }));
    const result = await check('Commission Splits');
    expect(result.entitiesChecked).toBe(TOTAL);
    expect(result.discrepancies.map((d) => d.entity)).toEqual([`ORD-${pad(LAST)}`]);
  });

  it('check 6 (quote-hold parity) reads every quote and every hold', async () => {
    H.tables.quotes = many((i) => ({ id: `q${pad(i)}`, quote_number: `Q-${pad(i)}`, is_planned: true, status: 'sent', deleted_at: null }));
    // Every quote but the last has an active hold; the holds are read past row 1,000 too,
    // so no quote is reported missing a hold it has.
    H.tables.inventory_holds = many((i) => ({ id: `h${pad(i)}`, source_id: `q${pad(i)}`, is_active: i !== LAST }));
    const result = await check('Quote-Hold Parity');
    expect(result.entitiesChecked).toBe(TOTAL);
    expect(result.discrepancies.map((d) => d.entityId)).toEqual([`q${pad(LAST)}`]);
  });

  it('check 9 (return-credit linkage) sees an unlinked credited return past row 1,000', async () => {
    H.tables.returns = many((i) => ({
      id: `r${pad(i)}`, return_number: `RET-${pad(i)}`, status: 'credited', deleted_at: null,
      credit_invoice_id: i === LAST ? null : `cm${pad(i)}`,
    }));
    const result = await check('Return-Credit Linkage');
    expect(result.entitiesChecked).toBe(TOTAL);
    expect(result.discrepancies.map((d) => d.entity)).toEqual([`RET-${pad(LAST)}`]);
  });

  it('check 10 (customer AR consistency) sees a missing balance past row 1,000', async () => {
    H.tables.invoices = many((i) => ({
      id: `inv${pad(i)}`, invoice_number: `INV-${pad(i)}`, customer_id: 'c1', status: 'posted', deleted_at: null,
      balance_cents: i === LAST ? null : 0,
    }));
    const result = await check('Customer AR Consistency');
    expect(result.entitiesChecked).toBe(TOTAL);
    expect(result.discrepancies.map((d) => d.entity)).toEqual([`INV-${pad(LAST)}`]);
  });
});
