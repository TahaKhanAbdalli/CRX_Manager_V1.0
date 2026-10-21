/**
 * JobsApplicatorFilter.paging.test.tsx — Goal 4 part 2b (N4): the Jobs list's Applicators
 * filter matches every job dispatched to the chosen applicator.
 *
 * The filter read the applicator's dispatches in one request, which the server silently
 * stops at 1,000 rows, so a job whose dispatch fell past the cap was filtered out. A failed
 * read was treated as "no dispatches" and the list quietly dropped every dispatched job. The
 * fake server caps every reply at 1,000 rows like the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { buildInMemoryQuery, pagedRpcReply, SERVER_ROW_CAP, type InMemoryQueryLog } from '../test-utils/inMemoryQuery';

type Row = Record<string, unknown>;

const H = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failing: new Set<string>(),
  // Every `.or(...)` the jobs query was sent.
  jobsLog: { orExpressions: [] as string[] },
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

vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return {
    ...actual,
    supabase: {
      from: (table: string) => {
        if (H.failing.has(table)) return failingQuery();
        return buildInMemoryQuery(H.tables[table] ?? [], table === 'jobs' ? (H.jobsLog as InMemoryQueryLog) : undefined);
      },
      rpc: () => pagedRpcReply({ data: [], error: null }),
    },
  };
});
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ role: 'admin', profile: { id: 'user-1', role: 'admin' } }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
// The filter pickers: one button per picker selects the applicator under test.
vi.mock('../components/jobs/MultiSelectDropdown', () => ({
  default: ({ label, onChange }: { label: string; onChange: (next: string[]) => void }) => (
    <button type="button" onClick={() => onChange(['app-1'])}>Pick {label}</button>
  ),
}));

import Jobs from './Jobs';

const TOTAL = SERVER_ROW_CAP + 5;
vi.setConfig({ testTimeout: 120_000 });
configure({ asyncUtilTimeout: 30_000 });
const pad = (i: number) => String(i).padStart(4, '0');

const job = (id: string, jobNumber: string) => ({
  id, job_number: jobNumber, status: 'scheduled', job_date: '2026-07-11', total_acres: 40, remaining_acres: 40,
  customer: { farm_name: 'Acme Acres', account_number: '1001', phone: null }, vehicle: null, job_fields: [],
  job_chemicals: [], job_tag_assignments: [], batch: null,
  job_location_dispatches: [{ applicator_id: 'app-1', crew_id: null, dispatch_status: 'dispatched' }],
  applicator_id: null, created_by: null, updated_by: null, last_printed_by: null, deleted_at: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  H.failing = new Set();
  H.jobsLog.orExpressions = [];
  H.tables = {
    // The job dispatched last (its dispatch is row 1,005, past the cap) and one that is not
    // the applicator's at all.
    jobs: [job(`job-${pad(TOTAL - 1)}`, 'JOB-LAST'), { ...job('job-other', 'JOB-OTHER'), job_location_dispatches: [] }],
    job_location_dispatches: [
      ...Array.from({ length: TOTAL }, (_, i) => ({
        id: `d${pad(i)}`, job_id: `job-${pad(i)}`, applicator_id: 'app-1', dispatch_status: 'dispatched',
      })),
      { id: 'd-other', job_id: 'job-other', applicator_id: 'app-2', dispatch_status: 'dispatched' },
      { id: 'd-done', job_id: 'job-done', applicator_id: 'app-1', dispatch_status: 'completed' },
    ],
  };
});
afterEach(cleanup);

async function filterByApplicator() {
  render(<MemoryRouter initialEntries={['/jobs']}><Jobs /></MemoryRouter>);
  // The unfiltered first load lists both jobs.
  expect(await screen.findByText('JOB-OTHER')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Pick Applicators' }));
  fireEvent.click(screen.getByRole('button', { name: /^Search/ }));
}

describe('Jobs applicator filter past the 1,000-row server cap (N4)', () => {
  it('matches the jobs of all 1,005 dispatches', async () => {
    await filterByApplicator();
    await waitFor(() => expect(H.jobsLog.orExpressions).toHaveLength(1));
    const expr = H.jobsLog.orExpressions[0];
    const idList = /id\.in\.\(([^)]*)\)$/.exec(expr)?.[1].split(',') ?? [];
    // A read stopped at 1,000 dispatches leaves out the last five jobs.
    expect(idList).toEqual(Array.from({ length: TOTAL }, (_, i) => `job-${pad(i)}`));
    expect(expr.startsWith('applicator_id.in.(app-1),')).toBe(true);
    await waitFor(() => expect(screen.queryByText('JOB-OTHER')).not.toBeInTheDocument());
    expect(screen.getByText('JOB-LAST')).toBeInTheDocument();
    expect(H.toast).not.toHaveBeenCalledWith('error', expect.anything());
  });

  it('a failed dispatch read stops the load with an error instead of a list without dispatched jobs', async () => {
    // The unfiltered first load never reads dispatches, so only the filtered search fails.
    H.failing.add('job_location_dispatches');
    const jobsReads = () => H.jobsLog.orExpressions.length;
    await filterByApplicator();
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', 'Failed to load jobs'));
    // The jobs query was never sent with an applicator match that silently left out the
    // dispatched jobs.
    expect(jobsReads()).toBe(0);
    // The unfiltered list from the first load is cleared, not left under the new filter.
    await waitFor(() => expect(screen.queryByText('JOB-OTHER')).not.toBeInTheDocument());
    expect(screen.queryByText('JOB-LAST')).not.toBeInTheDocument();
  });
});
