/**
 * IntegrityCleanup.sentinel-alerts.test.tsx — the new "Data-integrity alerts"
 * section that surfaces the daily sentinel's findings (integrity_alerts) in
 * plain English on the admin Integrity Cleanup page.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const ALERT = {
  id: 'alert-1',
  alert_type: 'negative_invoice_balance',
  entity_table: 'invoices',
  entity_id: 'inv-1',
  details: { invoice_number: 'INV-100', status: 'posted', balance_cents: -500 },
  detected_at: '2026-07-06T12:00:00Z',
};
// The rows the sentinel query returns; a test may swap them before rendering.
let alertRows: unknown[] = [ALERT];

vi.mock('../lib/db', () => {
  function chainable(resolveWith: unknown) {
    const builder: Record<string, unknown> = {};
    const self = () => builder;
    for (const m of [
      'select', 'insert', 'update', 'delete',
      'eq', 'neq', 'gt', 'lt', 'is', 'in', 'or', 'not', 'order', 'limit', 'range', 'single',
    ]) {
      builder[m] = vi.fn(self);
    }
    builder.then = vi.fn((resolve: (v: unknown) => void) => {
      Promise.resolve(resolveWith).then(resolve);
      return builder;
    });
    return builder;
  }
  return {
    // Business-cleanup queries all resolve empty; only the sentinel query has a row.
    supabase: { from: vi.fn(() => chainable({ data: [], error: null })) },
    supabaseUntyped: { from: vi.fn(() => chainable({ data: alertRows, error: null })) },
    assertRpcResult: vi.fn((d: unknown) => d),
    checkMutationResult: vi.fn(),
  };
});

vi.mock('../lib/sentry', () => ({
  Sentry: { captureException: vi.fn(), addBreadcrumb: vi.fn() },
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' } }),
}));

import IntegrityCleanupPanel from '../components/integrity/IntegrityCleanupPanel';

describe('IntegrityCleanup — data-integrity sentinel alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    alertRows = [ALERT];
  });

  // To-Do 0.14 (20261025090000): the two stuck-hold alerts read in plain English.
  const holdAlert = (n: number, alert_type: string, details: Record<string, unknown>) => ({
    id: `hold-alert-${n}`, alert_type, entity_table: 'inventory_holds', entity_id: `hold-${n}`,
    details: { product_id: 'prod-1', quantity: 5, ...details }, detected_at: '2026-10-25T12:00:00Z',
  });

  it.each([
    ['stuck_job_hold', { job_id: 'job-aaaa1111', job_missing: true, job_deleted: false, job_status: null }, 'Stuck job hold', 'Job job-aaaa is missing, but a hold of 5 is still active'],
    ['stuck_job_hold', { job_id: 'job-bbbb2222', job_missing: false, job_deleted: true, job_status: 'scheduled' }, 'Stuck job hold', 'Job job-bbbb is deleted, but a hold of 5 is still active'],
    ['stuck_job_hold', { job_id: 'job-cccc3333', job_missing: false, job_deleted: false, job_status: 'completed' }, 'Stuck job hold', 'Job job-cccc is completed, but a hold of 5 is still active'],
    ['stuck_job_hold', { job_id: null, job_missing: true, job_deleted: false, job_status: null }, 'Stuck job hold', 'No job is linked, but a hold of 5 is still active'],
    ['orphan_quote_hold', { quote_id: null, quote_missing: true, quote_deleted: false, is_planned: null, quote_status: null }, 'Orphaned program hold', 'No quote is linked, but a program hold of 5 is still active'],
    ['orphan_quote_hold', { quote_id: 'quot-dddd4444', quote_missing: true, quote_deleted: false, is_planned: null, quote_status: null }, 'Orphaned program hold', 'Quote quot-ddd is missing, but a program hold of 5 is still active'],
    ['orphan_quote_hold', { quote_id: 'quot-eeee5555', quote_missing: false, quote_deleted: true, is_planned: true, quote_status: 'draft' }, 'Orphaned program hold', 'Quote quot-eee is deleted, but a program hold of 5 is still active'],
    ['orphan_quote_hold', { quote_id: 'quot-ffff6666', quote_missing: false, quote_deleted: false, is_planned: false, quote_status: 'draft' }, 'Orphaned program hold', 'Quote quot-fff is no longer planned, but a program hold of 5 is still active'],
    ['orphan_quote_hold', { quote_id: 'quot-gggg7777', quote_missing: false, quote_deleted: false, is_planned: true, quote_status: 'accepted' }, 'Orphaned program hold', 'Quote quot-ggg is accepted, but a program hold of 5 is still active'],
  ])('describes a %s alert (%#)', async (alertType, details, title, detail) => {
    alertRows = [holdAlert(1, alertType, details)];
    render(<IntegrityCleanupPanel />);
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.getByText(detail)).toBeTruthy();
  });

  it('surfaces open integrity alerts in plain English with a resolve action', async () => {
    render(<IntegrityCleanupPanel />);
    await screen.findByText('Data-integrity alerts');
    expect(await screen.findByText('Negative invoice balance')).toBeTruthy();
    // details rendered as "Invoice INV-100 — balance $-5.00 (posted)"
    expect(screen.getByText(/INV-100/)).toBeTruthy();
    expect(screen.getByText('Mark resolved')).toBeTruthy();
  });
});
