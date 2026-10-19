import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const {
  mockFrom,
  mockToast,
  mockCheckMutationResult,
  selectedTicket,
} = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockToast: vi.fn(),
  mockCheckMutationResult: vi.fn(),
  selectedTicket: {
    id: 'ticket-1',
    ticket_number: 'BT-DELETE-1',
    status: 'completed',
    review_status: 'approved',
    order_link_status: 'unlinked',
    payment_status: 'unbilled',
    ocr_confidence_score: 100,
    customer: null,
    driver_name: null,
    uploaded_by: null,
    reviewed_by: null,
    salesman_id: null,
  },
}));

type QueryChain = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<{ data: unknown; error: unknown }>;

// Like the real server: any single request returns at most this many rows.
const SERVER_ROW_CAP = 1000;

function buildChain(result: { data: unknown; error: unknown }): QueryChain {
  const self: Record<string, unknown> = {};
  let limitN: number | null = null;
  for (const method of [
    'select', 'update', 'eq', 'is', 'in', 'order',
  ]) {
    self[method] = vi.fn(() => self);
  }
  // .limit(n) caps the response at n rows, as the server does.
  self.limit = vi.fn((n: number) => {
    limitN = n;
    return self;
  });
  const capped = (rows: unknown[]) => rows.slice(0, Math.min(SERVER_ROW_CAP, limitN ?? Infinity));
  // The list reads page by page with .range(from, to); serve each page as a slice
  // of the rows, so any number of page requests ends on an empty page.
  self.range = vi.fn((from: number, to: number) => Promise.resolve(
    Array.isArray(result.data)
      ? { data: capped(result.data.slice(from, to + 1)), error: result.error }
      : result,
  ));
  // An unpaged read (awaited without .range) is cut off at the server row cap,
  // so a single-request read cannot pass for a full one.
  self.then = (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => Promise.resolve(
    Array.isArray(result.data) ? { data: capped(result.data), error: result.error } : result,
  ).then(onFulfilled, onRejected);
  return self as QueryChain;
}

/** The blend_tickets table: list reads page through the rows; an update goes to `mutation`. */
function ticketTable(rows: unknown[], mutation: QueryChain): QueryChain {
  const table = buildChain({ data: rows, error: null });
  table.update = vi.fn(() => mutation);
  return table;
}

vi.mock('../lib/db', () => ({
  supabase: { from: mockFrom, rpc: vi.fn() },
  checkMutationResult: mockCheckMutationResult,
  assertRpcResult: vi.fn((data) => data),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: 'admin', profile: { id: 'admin-1' } }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock('../hooks/useOCRProcessor', () => ({
  useOCRProcessor: () => ({ isProcessing: false, processedCount: 0 }),
}));

vi.mock('../hooks/useOCRThresholds', () => ({
  useOCRThresholds: () => ({ needs_review: 70 }),
}));

vi.mock('../hooks/usePageMeta', () => ({ usePageMeta: () => {} }));
vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: () => ({ getKey: () => 'idem-1', resetKey: vi.fn() }),
}));
vi.mock('../hooks/useRowSelection', () => ({
  useRowSelection: () => ({
    selected: new Set(['ticket-1']),
    toggleSelect: vi.fn(),
    toggleAll: vi.fn(),
    clearSelection: vi.fn(),
    selectedCount: 1,
    selectedRows: [selectedTicket],
    allSelected: true,
  }),
  createCheckboxColumn: () => ({ key: 'select', header: '' }),
}));

vi.mock('../components/ui/PageHeader', () => ({
  default: ({ actions }: { actions?: ReactNode }) => <div>{actions}</div>,
}));
vi.mock('../components/ui/DataTable', () => ({
  default: ({ data }: { data: unknown[] }) => <div>ticket table: {data.length} rows</div>,
}));
vi.mock('../components/ui/BulkDeleteConfirmModal', () => ({
  default: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => open
    ? <button onClick={onConfirm}>Confirm bulk delete</button>
    : null,
}));
vi.mock('../components/blendtickets/BulkTicketUpload', () => ({ BulkTicketUpload: () => null }));
vi.mock('../components/blendtickets/ManualTicketCreate', () => ({
  ManualTicketCreate: ({ customers }: { customers: unknown[] }) => <div>manual create: {customers.length} customers</div>,
}));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/errorSanitizer', () => ({
  sanitizeError: (error: unknown) => error instanceof Error ? error.message : 'Request failed',
}));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import { BlendTickets } from './BlendTickets';

function renderPage() {
  return render(<MemoryRouter><BlendTickets /></MemoryRouter>);
}

describe('BlendTickets bulk-delete downstream guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses deletion with a friendly message when a selected ticket has an application record', async () => {
    const customerLoad = buildChain({ data: [], error: null });
    const applicationRecordLookup = buildChain({ data: [{ source_id: 'ticket-1' }], error: null });
    const deleteMutation = buildChain({ data: [{ id: 'ticket-1' }], error: null });
    const tickets = ticketTable([selectedTicket], deleteMutation);
    mockFrom.mockImplementation((table: string) => {
      if (table === 'customers') return customerLoad;
      if (table === 'application_records') return applicationRecordLookup;
      if (table === 'blend_tickets') return tickets;
      return buildChain({ data: [], error: null });
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Tickets' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm bulk delete' }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        'error',
        'Reverse the application records linked to the selected blend tickets before deleting them.',
      );
    });
    expect(applicationRecordLookup.select).toHaveBeenCalledWith('source_id');
    expect(applicationRecordLookup.eq).toHaveBeenCalledWith('source_type', 'blend_ticket');
    expect(applicationRecordLookup.in).toHaveBeenCalledWith('source_id', ['ticket-1']);
    expect(applicationRecordLookup.limit).toHaveBeenCalledWith(1);
    expect(tickets.update).not.toHaveBeenCalled();
  });

  it('continues to the soft delete when no selected ticket has an application record', async () => {
    const customerLoad = buildChain({ data: [], error: null });
    const applicationRecordLookup = buildChain({ data: [], error: null });
    const deleteMutation = buildChain({ data: [{ id: 'ticket-1' }], error: null });
    const tickets = ticketTable([selectedTicket], deleteMutation);
    mockFrom.mockImplementation((table: string) => {
      if (table === 'customers') return customerLoad;
      if (table === 'application_records') return applicationRecordLookup;
      if (table === 'blend_tickets') return tickets;
      return buildChain({ data: [], error: null });
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Tickets' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm bulk delete' }));

    await waitFor(() => {
      expect(tickets.update).toHaveBeenCalledWith({ deleted_at: expect.any(String) });
      expect(mockToast).toHaveBeenCalledWith('success', 'Deleted 1 ticket(s)');
    });
    expect(mockCheckMutationResult).toHaveBeenCalledWith(
      { data: [{ id: 'ticket-1' }], error: null },
      'Delete blend tickets',
    );
  });
});

/** The read began at row 0 and requested a later page that reaches rows 1,000-1,499. */
function expectReadPastServerCap(calls: unknown[][]) {
  expect(calls[0]).toEqual([0, SERVER_ROW_CAP - 1]);
  expect(calls.length).toBeGreaterThanOrEqual(2);
  const [from, to] = calls[1] as [number, number];
  expect(from).toBeGreaterThan(0);
  expect(from).toBeLessThanOrEqual(SERVER_ROW_CAP);
  expect(to).toBeGreaterThanOrEqual(1499);
}

describe('BlendTickets list reads every row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads all 1,500 tickets and 1,500 active customers, past the 1,000-row server cap', async () => {
    const manyTickets = Array.from({ length: 1500 }, (_, i) => ({
      ...selectedTicket,
      id: `ticket-${i}`,
      ticket_number: `BT-${i}`,
    }));
    const manyCustomers = Array.from({ length: 1500 }, (_, i) => ({ id: `customer-${i}`, farm_name: `Farm ${i}` }));
    const tickets = ticketTable(manyTickets, buildChain({ data: [], error: null }));
    const customers = buildChain({ data: manyCustomers, error: null });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'blend_tickets') return tickets;
      if (table === 'customers') return customers;
      return buildChain({ data: [], error: null });
    });

    renderPage();

    expect(await screen.findByText('ticket table: 1500 rows')).toBeInTheDocument();
    // The first page stops at the server cap, so the read must ask again for rows
    // past row 1,000 (exact later ranges are pagedRead's business: seam overlap).
    expectReadPastServerCap(tickets.range.mock.calls);
    expect(tickets.order).toHaveBeenCalledWith('id');
    expect(tickets.limit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Create Manual/ }));
    expect(await screen.findByText('manual create: 1500 customers')).toBeInTheDocument();
    // The customer read pages too: an unpaged or .limit(500) read would stop at
    // 1,000 or 500 rows in this mock, exactly as the server does.
    expectReadPastServerCap(customers.range.mock.calls);
    expect(customers.limit).not.toHaveBeenCalled();
    expect(customers.order).toHaveBeenCalledWith('farm_name');
    expect(customers.order).toHaveBeenCalledWith('id');
    expect(mockToast).not.toHaveBeenCalled();
  }, 30000);
});
