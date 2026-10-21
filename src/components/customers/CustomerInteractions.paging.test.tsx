/**
 * CustomerInteractions.paging.test.tsx — Goal 4 part 2b (M64): a customer's interaction
 * history lists every interaction, newest first, and says so when it cannot be loaded.
 *
 * The history read only the latest 50 interactions (and one request stops at the server's
 * 1,000-row cap anyway), so the type and outcome filters never saw older ones. A failed read
 * showed "No interactions match these filters." as if there were none. The fake server caps
 * every reply at 1,000 rows like the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import { buildInMemoryQuery, SERVER_ROW_CAP } from '../../test-utils/inMemoryQuery';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failing: new Set<string>(),
  toast: vi.fn(),
}));

// A query whose every method chains and whose answer is a read error.
function failingQuery(): Record<string, unknown> {
  const q: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: 'connection reset' }, count: null });
      }
      return () => q;
    },
  });
  return q;
}

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return {
    ...actual,
    supabase: {
      from: (table: string) => (H.failing.has(table) ? failingQuery() : buildInMemoryQuery(H.tables[table] ?? [])),
      rpc: vi.fn(async () => ({ data: null, error: null })),
    },
  };
});
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));

import { CustomerInteractionsHistory } from './CustomerContacts';

const TOTAL = SERVER_ROW_CAP + 5;
vi.setConfig({ testTimeout: 120_000 });
configure({ asyncUtilTimeout: 30_000 });
const pad = (i: number) => String(i).padStart(4, '0');

beforeEach(() => {
  vi.clearAllMocks();
  H.failing = new Set();
  // Newest first, the order the screen asks the server for; one minute apart.
  H.tables = {
    customer_interactions: Array.from({ length: TOTAL }, (_, i) => ({
      id: `ci${pad(i)}`, customer_id: 'c1', contact_id: 'contact-1', owner_user_id: 'u1',
      interaction_type: 'call', direction: 'outbound', outcome: 'connected', summary: `Interaction ${pad(i)}`,
      occurred_at: new Date(Date.UTC(2026, 9, 1) - i * 60_000).toISOString(),
    })),
    customer_contacts: [{ id: 'contact-1', customer_id: 'c1', name: 'Pat Primary' }],
    profile_public_view: [{ id: 'u1', full_name: 'Sam Rep' }],
  };
});
afterEach(cleanup);

describe('interaction history past the 1,000-row server cap (M64)', () => {
  it('lists all 1,005 interactions, newest first', async () => {
    render(<CustomerInteractionsHistory customerId="c1" />);
    // The oldest, past both the old 50 limit and the server cap, is listed.
    expect(await screen.findByText(`Interaction ${pad(TOTAL - 1)}`)).toBeInTheDocument();
    const shown = screen.getAllByText(/^Interaction \d{4}$/).map((el) => el.textContent);
    expect(shown).toEqual(Array.from({ length: TOTAL }, (_, i) => `Interaction ${pad(i)}`));
    // The contact and the owner's name still resolve.
    expect(screen.getAllByText(/Pat Primary · Sam Rep/)).toHaveLength(TOTAL);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a failed read says the history could not be loaded, not that there are none', async () => {
    H.failing.add('customer_interactions');
    render(<CustomerInteractionsHistory customerId="c1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Interaction history could not be loaded');
    expect(screen.queryByText('No interactions match these filters.')).not.toBeInTheDocument();
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', 'Failed to load interactions'));
  });
});
