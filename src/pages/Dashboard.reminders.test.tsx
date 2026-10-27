/**
 * Dashboard.reminders.test.tsx — only an admin's dashboard load runs the remainder reminders.
 *
 * check_remainder_reminders raises INSUFFICIENT_ROLE for anyone but an admin (it also runs
 * nightly via the check-remainder-reminders cron), so a sales rep's dashboard used to report
 * a Sentry error and log a failed notification on every load (Sentry CRX-MANAGER-1C).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const H = vi.hoisted(() => ({
  auth: { role: 'admin' as 'admin' | 'sales_rep' | null },
  rpcCalls: [] as string[],
  captureException: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../lib/db', () => {
  const read = () => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is']) b[m] = () => b;
    b.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve({ count: 0, error: null }).then(onFulfilled);
    return b;
  };
  return {
    supabase: {
      from: read,
      rpc: (name: string) => {
        H.rpcCalls.push(name);
        return Promise.resolve({ data: {}, error: null });
      },
    },
    assertRpcResult: <T,>(data: T) => data,
  };
});
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => H.auth }));
// A stable toast, like the real provider's, so the load callback is recreated only by its real deps.
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: H.captureException } }));
vi.mock('../components/dashboard/ActionQueue', () => ({ default: () => null }));
vi.mock('../components/dashboard/DailyBrief', () => ({ default: () => null }));
vi.mock('../components/compliance/ExpiringLicensesCard', () => ({ default: () => null }));

import Dashboard from './Dashboard';

const load = async () => {
  render(<MemoryRouter><Dashboard /></MemoryRouter>);
  // The quote-hold release is the last call of every load, for every role.
  await waitFor(() => expect(H.rpcCalls).toContain('release_expired_quote_holds'));
};

describe('Dashboard remainder reminders', () => {
  beforeEach(() => {
    H.rpcCalls.length = 0;
    H.captureException.mockClear();
  });
  afterEach(cleanup);

  it('a sales rep load does not call the admin-only reminder check', async () => {
    H.auth.role = 'sales_rep';
    await load();
    expect(H.rpcCalls).not.toContain('check_remainder_reminders');
    expect(H.rpcCalls).not.toContain('log_failed_notification');
    expect(H.captureException).not.toHaveBeenCalled();
  });

  it('an admin load still runs the reminder check', async () => {
    H.auth.role = 'admin';
    await load();
    expect(H.rpcCalls.filter((n) => n === 'check_remainder_reminders')).toHaveLength(1);
  });

  it('runs the reminder check once the role resolves to admin after loading', async () => {
    H.auth.role = null;
    const { rerender } = render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await waitFor(() => expect(H.rpcCalls).toContain('release_expired_quote_holds'));
    expect(H.rpcCalls).not.toContain('check_remainder_reminders');

    H.auth.role = 'admin';
    rerender(<MemoryRouter><Dashboard /></MemoryRouter>);
    await waitFor(() => expect(H.rpcCalls).toContain('check_remainder_reminders'));
    // Let any second load settle before counting.
    await waitFor(() => expect(H.rpcCalls.filter((n) => n === 'release_expired_quote_holds')).toHaveLength(2));
    expect(H.rpcCalls.filter((n) => n === 'check_remainder_reminders')).toHaveLength(1);
  });
});
