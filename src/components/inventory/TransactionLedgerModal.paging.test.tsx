/**
 * TransactionLedgerModal.paging.test.tsx — Goal 4 part 2b (M23): a product's transaction
 * ledger shows every transaction.
 *
 * The ledger read the product's transactions in one request, which the server silently stops
 * at 1,000 rows, so a busy product's newest movements were missing. The fake server caps
 * every reply at 1,000 rows like the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen } from '@testing-library/react';
import { buildInMemoryQuery, pagedRpcReply, SERVER_ROW_CAP } from '../../test-utils/inMemoryQuery';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, failProduct: null as string | null }));

// A query whose every chained call returns itself and whose reply is a read error.
const failingQuery = (): unknown => {
  const reply = Promise.resolve({ data: null, error: { message: 'read failed' }, count: null });
  const proxy: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === 'then' ? reply.then.bind(reply) : () => proxy),
  });
  return proxy;
};

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return {
    ...actual,
    supabase: {
      from: (table: string) => (table === 'inventory_transactions' && H.failProduct
        ? failingQuery()
        : buildInMemoryQuery(H.tables[table] ?? [])),
      rpc: () => pagedRpcReply({ data: [{ product_id: 'p1', quantity_available: 7, quantity_prebooked: 2 }], error: null }),
    },
  };
});

import TransactionLedgerModal from './TransactionLedgerModal';

const TOTAL = SERVER_ROW_CAP + 5;
vi.setConfig({ testTimeout: 120_000 });
configure({ asyncUtilTimeout: 30_000 });
const pad = (i: number) => String(i).padStart(4, '0');

beforeEach(() => {
  H.failProduct = null;
  // Oldest first, the order the ledger asks the server for. Another product's row must not show.
  H.tables = {
    inventory_transactions: [
      ...Array.from({ length: TOTAL }, (_, i) => ({
        id: `t${pad(i)}`, product_id: 'p1', transaction_type: 'received', quantity: 1, notes: `Txn ${pad(i)}`,
        created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(), performed_by: i === TOTAL - 1 ? 'u1' : null,
        requires_review: false, order: null, purchase_order: null, delivery: null,
      })),
      { id: 'other', product_id: 'p2', transaction_type: 'received', quantity: 1, notes: 'Other product', created_at: '2026-01-01T00:00:00Z' },
    ],
    profile_public_view: [{ id: 'u1', full_name: 'Sam Warehouse' }],
  };
});
afterEach(cleanup);

describe('transaction ledger past the 1,000-row server cap (M23)', () => {
  it('shows all 1,005 transactions, oldest first', async () => {
    render(<TransactionLedgerModal open onClose={vi.fn()} productId="p1" productName="Roundup" />);
    // A read stopped at 1,000 rows says "1000 transactions".
    expect(await screen.findByText(`${TOTAL} transactions`)).toBeInTheDocument();
    const shown = screen.getAllByText(/^Txn \d{4}$/).map((el) => el.textContent);
    expect(shown).toEqual(Array.from({ length: TOTAL }, (_, i) => `Txn ${pad(i)}`));
    expect(screen.queryByText('Other product')).not.toBeInTheDocument();
    // The newest row, past the cap, still names who made it.
    expect(screen.getByText('Sam Warehouse')).toBeInTheDocument();
  });

  it("a failed read for the next product shows the error, not the last product's rows", async () => {
    const { rerender } = render(<TransactionLedgerModal open onClose={vi.fn()} productId="p1" productName="Roundup" />);
    expect(await screen.findByText(`${TOTAL} transactions`)).toBeInTheDocument();
    H.failProduct = 'p2';
    rerender(<TransactionLedgerModal open onClose={vi.fn()} productId="p2" productName="Other" />);
    expect(await screen.findByText(/read failed/)).toBeInTheDocument();
    expect(screen.queryByText(/^Txn \d{4}$/)).not.toBeInTheDocument();
  });
});
