import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('./db', () => ({
  supabase: { rpc: (...args: unknown[]) => rpc(...args) },
  assertRpcResult: (data: unknown) => data,
}));

import { INVOICE_POST_VERSION_MISSING_MESSAGE, WITHHELD_POST_VERSION, postInvoiceTarget, requireGroupVersions, requirePostVersion } from './invoicePostVersion';
import { buildInvoicePostTargets } from './invoiceBatchPosting';

beforeEach(() => {
  rpc.mockReset();
});

describe('requirePostVersion / requireGroupVersions', () => {
  it('refuses to post when no version was read', () => {
    expect(() => requirePostVersion(undefined)).toThrow(INVOICE_POST_VERSION_MISSING_MESSAGE);
    expect(() => requirePostVersion('  ')).toThrow(INVOICE_POST_VERSION_MISSING_MESSAGE);
    expect(requirePostVersion('v1:a')).toBe('v1:a');
    expect(() => requireGroupVersions({})).toThrow(INVOICE_POST_VERSION_MISSING_MESSAGE);
    expect(() => requireGroupVersions({ a: 'v1:a', b: undefined })).toThrow(INVOICE_POST_VERSION_MISSING_MESSAGE);
    expect(requireGroupVersions({ a: 'v1:a', b: 'v1:b' })).toEqual({ a: 'v1:a', b: 'v1:b' });
  });

  it('lets the server explain a version withheld from the caller (another salesperson\'s invoice)', () => {
    expect(requirePostVersion(null)).toBe(WITHHELD_POST_VERSION);
    expect(requireGroupVersions({ a: 'v1:a', b: null })).toEqual({ a: 'v1:a', b: WITHHELD_POST_VERSION });
    expect(WITHHELD_POST_VERSION).not.toMatch(/^v1:[0-9a-f]{64}$/);
  });
});

describe('postInvoiceTarget', () => {
  it('sends a standalone invoice with its loaded version', async () => {
    rpc.mockReturnValue({ throwOnError: () => Promise.resolve({ data: null, error: null }) });
    const [target] = buildInvoicePostTargets([{ id: 'inv-1', invoice_number: 'INV-1', invoice_post_version: 'v1:a' }]);
    await postInvoiceTarget(target, 'user-1', 'key-1');
    expect(rpc).toHaveBeenCalledWith('post_invoice', { p_invoice_id: 'inv-1', p_expected_version: 'v1:a', p_idempotency_key: 'key-1' });
  });

  it('sends a split group with every loaded member version', async () => {
    rpc.mockResolvedValue({ data: { posted_invoice_ids: ['inv-1', 'inv-2'] }, error: null });
    const rows = [
      { id: 'inv-1', invoice_number: 'INV-1', invoice_group_id: 'g', invoice_post_version: 'v1:a' },
      { id: 'inv-2', invoice_number: 'INV-2', invoice_group_id: 'g', invoice_post_version: 'v1:b' },
    ];
    const [target] = buildInvoicePostTargets([rows[1]], rows);
    await postInvoiceTarget(target, 'user-1', 'key-2');
    expect(rpc).toHaveBeenCalledWith('post_invoice_group', {
      p_invoice_group_id: 'g',
      p_performed_by: 'user-1',
      p_expected_versions: { 'inv-1': 'v1:a', 'inv-2': 'v1:b' },
      p_idempotency_key: 'key-2',
    });
  });

  it('posts nothing when a row was read without a version', async () => {
    const [target] = buildInvoicePostTargets([{ id: 'inv-1', invoice_number: 'INV-1' }]);
    await expect(postInvoiceTarget(target, 'user-1', 'key-3')).rejects.toThrow(INVOICE_POST_VERSION_MISSING_MESSAGE);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('sends a withheld version to the server, which refuses with the own-name reason', async () => {
    rpc.mockReturnValue({ throwOnError: () => Promise.reject(new Error('INVOICE_SCOPE_DENIED')) });
    const [target] = buildInvoicePostTargets([{ id: 'inv-1', invoice_number: 'INV-1', invoice_post_version: null }]);
    await expect(postInvoiceTarget(target, 'user-1', 'key-4')).rejects.toThrow('INVOICE_SCOPE_DENIED');
    expect(rpc).toHaveBeenCalledWith('post_invoice', { p_invoice_id: 'inv-1', p_expected_version: WITHHELD_POST_VERSION, p_idempotency_key: 'key-4' });
  });
});

describe('the posting version carries no cost (migration 20261022022000)', () => {
  // The version is a SHA-256 a rep can read, over rows whose other fields the rep can also read, so a
  // single cost value inside it could be guessed. Every cost column registered for a table the
  // hash reads must be left out of it, and the other tables it reads must have no cost columns.
  it('excludes every registered cost column of the tables it hashes', async () => {
    const { readFileSync } = await import('node:fs');
    const { COST_COLUMNS } = await import('./costFields');
    const sql = readFileSync('supabase/migrations/20261022022000_post_binds_reviewed_invoice_version.sql', 'utf8');
    expect(sql).toContain("to_jsonb(i) - 'total_cost_cents'");
    expect(sql).toContain("to_jsonb(ii) - ARRAY['cost_cents', 'return_credit_cogs_cents']");
    expect([...COST_COLUMNS.invoices]).toEqual(['total_cost_cents']);
    expect([...COST_COLUMNS.invoice_items].sort()).toEqual(['cost_cents', 'return_credit_cogs_cents']);
    for (const table of ['invoice_shares', 'invoice_line_shares', 'invoice_line_allocations', 'field_app_locations', 'customers']) {
      expect(Object.keys(COST_COLUMNS)).not.toContain(table);
    }
  });
});
