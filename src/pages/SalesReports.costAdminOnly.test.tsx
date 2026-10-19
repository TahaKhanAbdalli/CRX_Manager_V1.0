import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Cost and margin are admin-only (Mason, 2026-10-15). Since 20261019010000 the
// sales reports send cost/profit/margin as NULL to non-admins; this pins that the
// screen then shows those columns only to admins and never prints a fake $0.

const H = vi.hoisted(() => ({
  auth: { role: 'admin' as 'admin' | 'sales_rep' },
  detailRow: null as Record<string, unknown> | null,
  summaryRow: null as Record<string, unknown> | null,
  toast: vi.fn(),
  holdNextRpc: null as Promise<void> | null,
  failNextRpc: false,
}));

type QueryBuilder = {
  select: () => QueryBuilder;
  eq: () => QueryBuilder;
  order: () => QueryBuilder;
  limit: () => QueryBuilder;
  in: () => QueryBuilder;
  not: () => QueryBuilder;
  then: (resolve: (value: unknown) => unknown) => unknown;
};

vi.mock('../lib/db', () => ({
  supabase: {
    from: () => {
      const builder: QueryBuilder = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        in: () => builder,
        not: () => builder,
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return builder;
    },
    rpc: (name: string) => {
      // Snapshot the rows at call time, so a held (slow) request returns what was current then.
      const result = {
        data: name === 'get_sales_detail_report' ? [H.detailRow]
          : name === 'get_sales_summary_report' ? [H.summaryRow]
            : [],
        error: null,
      };
      if (H.failNextRpc) {
        H.failNextRpc = false;
        return Promise.resolve({ data: null, error: { message: 'network down' } });
      }
      const hold = H.holdNextRpc;
      H.holdNextRpc = null;
      return hold ? hold.then(() => result) : Promise.resolve(result);
    },
  },
  assertRpcResult: <T,>(data: T) => data,
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => H.auth }));
// A stable toast, as in the app, so a refetch happens only when a real dependency (like the role) changes.
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
vi.mock('../components/products/ProductSearchPicker', () => ({ default: () => null }));
vi.mock('../lib/csvExport', () => ({ exportToCSV: vi.fn(), fmtCSV: vi.fn(), fmtDateCSV: vi.fn() }));
// Keep the real whole-cent fmtCurrency; only the PDF download is stubbed.
vi.mock('../lib/reportPdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/reportPdf')>()),
  downloadReportPdf: vi.fn(),
}));

import SalesReports from './SalesReports';
import { exportToCSV } from '../lib/csvExport';
import { downloadReportPdf } from '../lib/reportPdf';

const row = (cost: number | null, profit: number | null, margin: number | null) => ({
  order_date: '2026-10-01', order_number: 'ORD-1', customer_name: 'Prairie View Farms', customer_id: 'c1',
  product_name: 'Roundup', product_id: 'p1', sku: 'R1', category: 'Herbicide', quantity: 2, unit: 'GL',
  unit_price: 10, total_price: 20, cost, profit, margin_pct: margin, sales_rep_name: 'Rep', invoice_number: null, season: 2027,
});

// The server sends NULL cost/profit/margin to non-admins (20261019010000).
const summaryRow = (admin: boolean) => ({
  group_key: 'Roundup', group_id: 'p1', total_quantity: 2, total_revenue: 20,
  total_cost: admin ? 12 : null, total_profit: admin ? 8 : null, margin_pct: admin ? 40 : null, order_count: 1, line_count: 1,
});
const SENSITIVE = new Set(['Cost', 'Profit', 'Margin', 'Margin %']);
const sensitiveHeaders = (headers: string[]) => headers.map((header) => header.trim()).filter((header) => SENSITIVE.has(header));

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  H.detailRow = null;
  H.summaryRow = null;
  H.holdNextRpc = null;
  H.failNextRpc = false;
});
afterEach(() => { cleanup(); });

describe('SalesReports cost columns', () => {
  it.each([
    { role: 'sales_rep' as const, showsCost: false, table: [], csv: [], pdf: [] },
    { role: 'admin' as const, showsCost: true, table: ['Cost', 'Profit', 'Margin'], csv: ['Cost', 'Profit', 'Margin %'], pdf: ['Profit', 'Margin'] },
  ])('summary table, CSV and PDF follow role visibility ($role)', async ({ role, showsCost, table, csv, pdf }) => {
    H.auth.role = role;
    H.summaryRow = summaryRow(showsCost);
    render(<MemoryRouter initialEntries={['/?tab=by_product']}><SalesReports /></MemoryRouter>);

    expect(await screen.findByText('Roundup')).toBeInTheDocument();
    expect(sensitiveHeaders(screen.getAllByRole('columnheader').map((h) => h.textContent || ''))).toEqual(table);

    fireEvent.click(screen.getByRole('button', { name: 'CSV' }));
    await waitFor(() => expect(exportToCSV).toHaveBeenCalled());
    const csvColumns = vi.mocked(exportToCSV).mock.calls[0][1] as Array<{ header: string }>;
    expect(sensitiveHeaders(csvColumns.map((c) => c.header))).toEqual(csv);

    fireEvent.click(screen.getByRole('button', { name: 'PDF' }));
    await waitFor(() => expect(downloadReportPdf).toHaveBeenCalled());
    const pdfColumns = (vi.mocked(downloadReportPdf).mock.calls[0][0] as { columns: Array<{ header: string }> }).columns;
    expect(sensitiveHeaders(pdfColumns.map((c) => c.header))).toEqual(pdf);
  });

  it('shows a sales rep revenue but no cost, profit or margin column or card', async () => {
    H.auth.role = 'sales_rep';
    H.detailRow = row(null, null, null);
    render(<MemoryRouter><SalesReports /></MemoryRouter>);

    expect(await screen.findByText('Prairie View Farms')).toBeInTheDocument();
    expect(screen.getByText('Total Revenue')).toBeInTheDocument();
    expect(screen.queryByText('Total Profit')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^Cost/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^Profit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^Margin/ })).not.toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  it('refetches when a rep is promoted mid-page and never shows the rep-shaped rows as admin cost', async () => {
    H.auth.role = 'sales_rep';
    H.detailRow = row(null, null, null);
    const view = render(<MemoryRouter><SalesReports /></MemoryRouter>);
    expect(await screen.findByText('Prairie View Farms')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^Cost/ })).not.toBeInTheDocument();

    // Promoted while the page stays open: the server now returns real cost for this session.
    H.auth.role = 'admin';
    H.detailRow = row(12, 8, 40);
    view.rerender(<MemoryRouter><SalesReports /></MemoryRouter>);
    expect(await screen.findByText('40%')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^Cost/ })).toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  it('ignores a slow rep-era response that lands after the admin refetch', async () => {
    H.auth.role = 'sales_rep';
    H.detailRow = row(null, null, null);
    let releaseRepRequest: () => void = () => {};
    H.holdNextRpc = new Promise<void>((resolve) => { releaseRepRequest = resolve; });
    const view = render(<MemoryRouter><SalesReports /></MemoryRouter>);

    H.auth.role = 'admin';
    H.detailRow = row(12, 8, 40);
    view.rerender(<MemoryRouter><SalesReports /></MemoryRouter>);
    expect(await screen.findByText('40%')).toBeInTheDocument();

    releaseRepRequest();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^Cost/ })).toBeInTheDocument();
  });

  it('keeps cost hidden on a tab whose cached rows were fetched before the promotion', async () => {
    // As a rep, load the detail rows (no cost).
    H.auth.role = 'sales_rep';
    H.detailRow = row(null, null, null);
    const view = render(<MemoryRouter><SalesReports /></MemoryRouter>);
    expect(await screen.findByText('Prairie View Farms')).toBeInTheDocument();

    // Move to By Product, get promoted there, and receive admin-shaped summary rows.
    H.summaryRow = summaryRow(false);
    fireEvent.click(screen.getByRole('button', { name: 'By Product' }));
    expect(await screen.findByText('Roundup')).toBeInTheDocument();
    H.auth.role = 'admin';
    H.summaryRow = summaryRow(true);
    view.rerender(<MemoryRouter><SalesReports /></MemoryRouter>);
    expect(await screen.findByRole('columnheader', { name: /^Cost/ })).toBeInTheDocument();

    // Back to Sales Detail, whose admin refetch fails: the cached rep rows must not be
    // shown under admin cost columns (their NULL profit would read as $0).
    H.failNextRpc = true;
    fireEvent.click(screen.getByRole('button', { name: 'Sales Detail' }));
    expect(await screen.findByText('Prairie View Farms')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^Cost/ })).not.toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  it('still shows an admin the cost, profit and margin columns', async () => {
    H.auth.role = 'admin';
    H.detailRow = row(12, 8, 40);
    render(<MemoryRouter><SalesReports /></MemoryRouter>);

    expect(await screen.findByText('Prairie View Farms')).toBeInTheDocument();
    expect(screen.getByText('Total Profit')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^Cost/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^Margin/ })).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
  });
});
