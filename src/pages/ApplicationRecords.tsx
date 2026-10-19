import { useEffect, useState , useCallback, useRef } from 'react';


import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import DataTable, { type Column } from '../components/ui/DataTable';
import SplitHeading from '../components/ui/SplitHeading';
import Button from '../components/ui/Button';
import { useToast } from '../components/ui/Toast';
import { supabase } from '../lib/db';
import { fetchAllRows, fetchAllRowsForIds } from '../lib/pagedRead';
import { useAuth } from '../contexts/AuthContext';
import LotsEditorModal from '../components/LotsEditorModal';
import { exportToCSV, fmtDateCSV } from '../lib/csvExport';
import { Sentry } from '../lib/sentry';
import { Download } from 'lucide-react';
import { computeSeason, seasonStartDate, seasonEndDate, getSeasonDates } from '../utils/season';
import { formatLocalDate, parseLocalDate } from '../lib/dateUtils';
import type { ApplicationRecord } from '../types';

type AppRecordRow = ApplicationRecord & {
  customer_name: string;
  applicator_name: string;
  field_name: string;
  vehicle_name: string;
  product_count: number;
};

// Crop season = October 1 to September 30
function getPresetDates(preset: string): { start: string; end: string } {
  const now = new Date();

  switch (preset) {
    case 'this_season':
      return getSeasonDates(now);
    case 'last_season': {
      const s = computeSeason(now) - 1;
      return { start: seasonStartDate(s), end: seasonEndDate(s) };
    }
    case 'last30': {
      const d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return { start: formatLocalDate(d), end: formatLocalDate(now) };
    }
    default:
      return { start: '', end: '' };
  }
}

export default function ApplicationRecords() {
  const { toast } = useToast();
  const { role } = useAuth();
  // Lot capture is a write action gated to admin/sales (the RPC is admin/sales only);
  // applicators can view records but not edit lots.
  const canEditLots = role === 'admin' || role === 'sales_rep';
  const [lotsRecord, setLotsRecord] = useState<AppRecordRow | null>(null);
  const [records, setRecords] = useState<AppRecordRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [customers, setCustomers] = useState<{ id: string; farm_name: string }[]>([]);

  const fetchCustomers = useCallback(async () => {
    const { data, error } = await fetchAllRows<{ id: string; farm_name: string }>((from, to) =>
      supabase
        .from('customers')
        .select('id, farm_name', { count: 'exact' })
        .eq('is_active', true)
        .order('farm_name')
        .order('id')
        .range(from, to),
    );
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_application_record_customers' } });
      toast('error', 'Failed to load the customer filter list');
    }
    setCustomers((data || []) as { id: string; farm_name: string }[]);
  }, [toast]);

  // A long "All" read can finish after a narrower filter's; only the latest
  // request may set the list.
  const fetchSeq = useRef(0);
  const fetchRecords = useCallback(async () => {
    const seq = ++fetchSeq.current;
    setLoading(true);
    // PR-07 follow-up: dropped applicator FK embed; resolve via profile_public_view.
    // U10 (2026-07-06): prefer the applicator_name snapshot column (as-of-application,
    // immune to later profile edits) and only fall back to the profiles join for old
    // rows where it's NULL. `select('*', ...)` below already includes the snapshot cols.
    const { data, error } = await fetchAllRows<Record<string, unknown>>((from, to) => {
      let query = supabase
        .from('application_records')
        .select(`
          *,
          customer:customers(farm_name),
          field:fields(field_name),
          vehicle:vehicles(vehicle_name)
        `, { count: 'exact' });

      if (startDate) query = query.gte('application_date', startDate);
      if (endDate) query = query.lte('application_date', endDate);
      if (customerFilter) query = query.eq('customer_id', customerFilter);

      return query
        .order('application_date', { ascending: false })
        .order('id')
        .range(from, to);
    });

    if (seq !== fetchSeq.current) return;
    if (error) {
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_application_records' } });
      toast('error', 'Failed to load application records');
      setLoading(false);
      return;
    }

    const typedRows = (data || []) as Array<Record<string, unknown> & {
      customer?: { farm_name?: string };
      field?: { field_name?: string };
      vehicle?: { vehicle_name?: string };
      applicator_id?: string | null;
      applicator_name?: string | null;
    }>;

    // U10 snapshot columns (applicator_name/applicator_license_number) are filled for NEW
    // records; old rows have them NULL and still need the profiles-join fallback below.
    const applicatorIds = [...new Set(
      typedRows
        .filter((r) => !r.applicator_name)
        .map((r) => r.applicator_id)
        .filter(Boolean) as string[]
    )];
    const applicatorMap: Record<string, string> = {};
    if (applicatorIds.length > 0) {
      // A failed name lookup stays non-fatal: names fall back to '-'.
      const { data: applicators } = await fetchAllRowsForIds<{ id: string | null; full_name: string | null }, string>(
        applicatorIds,
        (idChunk, from, to) =>
          supabase
            .from('profile_public_view')
            .select('id, full_name', { count: 'exact' })
            .in('id', idChunk)
            .order('id')
            .range(from, to),
      );
      (applicators || []).forEach((a: { id: string | null; full_name: string | null }) => { if (a.id) applicatorMap[a.id] = a.full_name || '-'; });
    }
    if (seq !== fetchSeq.current) return;

    const rows: AppRecordRow[] = typedRows.map((r) => ({
      ...r,
      customer_name: r.customer?.farm_name || 'Unknown',
      applicator_name: r.applicator_name || (r.applicator_id ? applicatorMap[r.applicator_id] || '-' : '-'),
      field_name: r.field?.field_name || '-',
      vehicle_name: r.vehicle?.vehicle_name || '-',
      product_count: Array.isArray(r.product_data) ? r.product_data.length : 0,
    })) as AppRecordRow[];
    setRecords(rows);
    setLoading(false);
  }, [startDate, endDate, customerFilter, toast]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  useEffect(() => {
    fetchRecords();
  }, [startDate, endDate, customerFilter, fetchRecords]);

  const applyPreset = (preset: string) => {
    if (preset === 'all') {
      setStartDate('');
      setEndDate('');
    } else {
      const { start, end } = getPresetDates(preset);
      setStartDate(start);
      setEndDate(end);
    }
  };

  const handleExport = () => {
    exportToCSV(
      records as unknown as Record<string, unknown>[],
      [
        { key: 'record_number', header: 'Record #' },
        { key: 'application_date', header: 'Date', format: fmtDateCSV },
        { key: 'customer_name', header: 'Customer' },
        { key: 'field_name', header: 'Field' },
        { key: 'applicator_name', header: 'Applicator' },
        { key: 'total_acres', header: 'Acres' },
        { key: 'product_count', header: 'Products' },
        { key: 'vehicle_name', header: 'Vehicle' },
        { key: 'source_type', header: 'Source' },
      ],
      'application_records'
    );
    toast('success', 'Application records exported');
  };

  const columns: Column<AppRecordRow>[] = [
    {
      key: 'record_number',
      header: 'Record #',
      sortable: true,
      render: (r) => <span className="font-medium text-nav-dark font-mono text-xs">{r.record_number}</span>,
    },
    {
      key: 'application_date',
      header: 'Date',
      sortable: true,
      render: (r) => parseLocalDate(r.application_date).toLocaleDateString(),
    },
    {
      key: 'customer_name',
      header: 'Customer',
      sortable: true,
      render: (r) => <span className="font-medium">{r.customer_name}</span>,
    },
    {
      key: 'field_name',
      header: 'Field',
      sortable: true,
    },
    {
      key: 'applicator_name',
      header: 'Applicator',
      sortable: true,
    },
    {
      key: 'total_acres',
      header: 'Acres',
      sortable: true,
      render: (r) => r.total_acres?.toLocaleString() || '-',
    },
    {
      key: 'product_count',
      header: 'Products',
      sortable: true,
      render: (r) => (
        <Badge variant={r.product_count > 0 ? 'info' : 'default'}>
          {r.product_count} product{r.product_count !== 1 ? 's' : ''}
        </Badge>
      ),
    },
    {
      key: 'vehicle_name',
      header: 'Vehicle',
      sortable: true,
    },
    {
      key: 'source_type',
      header: 'Source',
      sortable: true,
      render: (r) => (
        <Badge variant={r.source_type === 'job' ? 'success' : 'warning'}>
          {r.source_type === 'job' ? 'Job' : 'Blend Ticket'}
        </Badge>
      ),
    },
  ];

  // Lot capture LANDS TOGETHER with migration 20260622170000 (SOW hard gate): this branch is
  // never merged/deployed until the migration is live, so the button only reaches users once the
  // table + RPCs exist. Defense-in-depth if that gate is ever bypassed: the modal's load catch
  // (loadError) shows a friendly "couldn't load" message and disables Save — no crash, no data loss.
  if (canEditLots) {
    columns.push({
      key: 'lots_action',
      header: '',
      render: (r) => (
        <Button
          variant="secondary"
          size="sm"
          showChevron={false}
          onClick={() => setLotsRecord(r)}
        >
          Lots
        </Button>
      ),
    });
  }

  return (
    <div className="space-y-6">
      <SplitHeading title="Application" accent="Records" />

      {/* Filters */}
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">Start Date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-secondary mb-1">Customer</label>
            <select
              value={customerFilter}
              onChange={(e) => setCustomerFilter(e.target.value)}
              aria-label="Filter by customer"
              className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
            >
              <option value="">All Customers</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.farm_name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-1.5">
            {[
              { key: 'all', label: 'All Time' },
              { key: 'this_season', label: 'This Season' },
              { key: 'last_season', label: 'Last Season' },
              { key: 'last30', label: 'Last 30 Days' },
            ].map((preset) => (
              <button
                key={preset.key}
                onClick={() => applyPreset(preset.key)}
                className="px-3 py-2 text-xs font-medium rounded-lg border border-gray-200 hover:bg-crx-green-tint hover:border-crx-green hover:text-crx-green transition-colors"
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="ml-auto">
            <Button
              variant="secondary"
              size="sm"
              icon={<Download className="w-4 h-4" />}
              showChevron={false}
              onClick={handleExport}
            >
              Export CSV
            </Button>
          </div>
        </div>
      </Card>

      <Card padding={false}>
        <div className="p-5">
          <DataTable
            data={records as unknown as Record<string, unknown>[]}
            columns={columns as unknown as Column<Record<string, unknown>>[]}
            searchable
            searchPlaceholder="Search records..."
            searchKeys={['record_number', 'customer_name', 'field_name', 'applicator_name']}
            emptyTitle="No application records"
            emptyDescription="Application records are created from completed jobs or approved blend tickets."
            loading={loading}
          />
        </div>
      </Card>

      <LotsEditorModal
        open={!!lotsRecord}
        record={lotsRecord}
        onClose={() => setLotsRecord(null)}
      />
    </div>
  );
}
