import { describe, expect, it } from 'vitest';
import { buildInvoicePostTargets, describeInvoicePostScope, groupVersionsFromRows } from './invoiceBatchPosting';

describe('buildInvoicePostTargets', () => {
  it('routes standalone invoices through post_invoice', () => {
    expect(buildInvoicePostTargets([
      { id: 'inv-1', invoice_number: 'INV-1', invoice_group_id: null },
    ])).toEqual([
      expect.objectContaining({
        key: 'invoice:inv-1',
        operation: 'post_invoice',
        invoiceId: 'inv-1',
        selectedIds: ['inv-1'],
      }),
    ]);
  });

  it('deduplicates selected split siblings into one atomic group action', () => {
    const targets = buildInvoicePostTargets([
      { id: 'inv-1', invoice_number: 'INV-1', invoice_group_id: 'group-1' },
      { id: 'inv-2', invoice_number: 'INV-2', invoice_group_id: 'group-1' },
      { id: 'inv-3', invoice_number: 'INV-3', invoice_group_id: null },
    ]);

    expect(targets).toHaveLength(2);
    expect(targets[0]).toEqual(expect.objectContaining({
      key: 'group:group-1',
      operation: 'post_invoice_group',
      invoiceGroupId: 'group-1',
      selectedIds: ['inv-1', 'inv-2'],
      label: 'Split group (INV-1, INV-2)',
    }));
    expect(targets[1]).toEqual(expect.objectContaining({
      operation: 'post_invoice',
      invoiceId: 'inv-3',
    }));
  });

  it('uses the group RPC even when only one visible group member is selected', () => {
    const [target] = buildInvoicePostTargets([
      { id: 'inv-1', invoice_number: 'INV-1', invoice_group_id: 'group-1' },
    ]);

    expect(target.operation).toBe('post_invoice_group');
    expect(target.invoiceId).toBeUndefined();
    expect(target.invoiceGroupId).toBe('group-1');
  });

  it('explicitly discloses that a selected split invoice posts the full server group', () => {
    const confirmation = describeInvoicePostScope([
      { id: 'inv-1', invoice_number: 'INV-1', invoice_group_id: 'group-1' },
    ]);

    expect(confirmation.message).toContain('every current invoice in that split group');
    expect(confirmation.message).toContain('outside current filters');
    expect(confirmation.message).toContain('changed since this list loaded');
    expect(confirmation.confirmLabel).toContain('full split groups');
  });
});

describe('versions posting binds (Goal 3, migration 20261022022000)', () => {
  it('a standalone target carries the version its row was loaded with', () => {
    const [target] = buildInvoicePostTargets([
      { id: 'inv-1', invoice_number: 'INV-1', invoice_group_id: null, invoice_post_version: 'v1:a' },
    ]);
    expect(target.loadedVersions).toEqual({ 'inv-1': 'v1:a' });
  });

  it('a group target carries every loaded member, selected or not, and skips deleted rows', () => {
    const loaded = [
      { id: 'inv-1', invoice_number: 'INV-1', invoice_group_id: 'group-1', invoice_post_version: 'v1:a' },
      { id: 'inv-2', invoice_number: 'INV-2', invoice_group_id: 'group-1', invoice_post_version: 'v1:b' },
      { id: 'inv-3', invoice_number: 'INV-3', invoice_group_id: 'group-1', invoice_post_version: 'v1:c', deleted_at: '2026-10-01T00:00:00Z' },
      { id: 'inv-4', invoice_number: 'INV-4', invoice_group_id: 'group-2', invoice_post_version: 'v1:d' },
    ];
    const [target] = buildInvoicePostTargets([loaded[0]], loaded);
    expect(target.loadedVersions).toEqual({ 'inv-1': 'v1:a', 'inv-2': 'v1:b' });
    expect(target.selectedIds).toEqual(['inv-1']);
  });

  it('only rows the screen loaded count, so a member added later is left for the server to refuse', () => {
    expect(groupVersionsFromRows('group-1', [
      { id: 'inv-1', invoice_group_id: 'group-1', invoice_post_version: 'v1:a' },
    ])).toEqual({ 'inv-1': 'v1:a' });
  });
});
