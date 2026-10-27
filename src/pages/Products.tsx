import { useEffect, useRef, useState, useMemo , useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, FileUp, Download, FileText, Trash2, Eye, EyeOff, ChevronDown, FileSpreadsheet, Upload } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import EditableDataTable, { type EditableColumn } from '../components/ui/EditableDataTable';
import Badge from '../components/ui/Badge';
import BulkActionBar from '../components/ui/BulkActionBar';
import BulkDeleteConfirmModal from '../components/ui/BulkDeleteConfirmModal';
import BulkProductImport from '../components/products/BulkProductImport';
import PricingChangePreviewModal from '../components/products/PricingChangePreviewModal';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { supabase, sanitizeError, checkMutationResult } from '../lib/db';
import { runCriticalAction } from '../lib/criticalAction';
import { Sentry } from '../lib/sentry';
import { logActivity } from '../lib/activityLogger';
import { useRowSelection, createCheckboxColumn } from '../hooks/useRowSelection';
import { exportToCSV, fmtCSV } from '../lib/csvExport';
import { formatUSD as fmt } from '../lib/money';
import { downloadReportPdf, type ReportPdfColumn } from '../lib/reportPdf';
import { SkeletonTable } from '../components/ui/Skeleton';
import HelpTip from '../components/ui/HelpTip';
import PageHeader from '../components/ui/PageHeader';
import type { Product } from '../types';
import {
  applyProductPricingChangeSet,
  createPricingWorkbookExport,
  formatPricingMarginPercent,
  pricingDollarInputToCents,
  previewProductPricingChanges,
  type PricingMode,
  type PricingPreviewInputRow,
  type PricingPreviewResult,
} from '../lib/productPricing';
import {
  MAX_PRICING_WORKBOOK_FILE_BYTES,
  MAX_PRICING_WORKBOOK_ROWS,
} from '../lib/productPricingWorkbook';
import {
  generateProductPricingWorkbookWithSupplierEvidence,
  parseProductPricingWorkbookWithSupplierEvidence,
} from '../lib/productPricingSupplierEvidenceWorkbook';
import { getSupplierMarketEvidence } from '../lib/supplierPricing';
import { PRODUCT_COLUMNS, withAdminCosts } from '../lib/costFields';
import {
  DEFAULT_STALE_COST_AGE_DAYS,
  costAgeDays,
  costAsOfDate,
  formatCostAsOfCSV,
  isCostStale,
} from '../lib/costFreshness';
import { parseLocalDate, todayInBusinessTz } from '../lib/dateUtils';
import {
  fetchMarginFloors,
  formatMarginFloorPercent,
  isMarginFloorRefusal,
  formatNetMarginPercent,
  isUnderMarginFloor,
  marginFloorErrorMessage,
  parseMarginFloorPercent,
  setMarginFloors,
  type MarginFloorChange,
  type SetMarginFloorsResult,
} from '../lib/marginFloors';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';

const INLINE_PRICING_FIELDS = new Set([
  'pricing_mode',
  'current_cost',
  'tier1_margin_percent',
  'tier2_margin_percent',
  'tier3_margin_percent',
  'tier1_price',
  'tier2_price',
  'tier3_price',
]);

const INLINE_NONPRICING_FIELDS = new Set([
  'product_name',
  'category',
  'vendor',
  'is_active',
]);

// Floors live in product_margin_floors, not on the product: the list copies each one onto its row.
const MARGIN_FLOOR_FIELD = 'margin_floor_percent';
type ProductListRow = Product & { [MARGIN_FLOOR_FIELD]?: string };

function inputDecimal(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim();
}

function storedMarginPercent(value: number | null | undefined): string | null {
  return value == null ? null : formatPricingMarginPercent(value);
}

/** A tier's net margin under its price; red with "under floor" when below the product's floor. */
function NetMarginNote({ margin, floor }: { margin: number; floor: number | undefined }) {
  const under = isUnderMarginFloor(margin, floor);
  return (
    <div className={`text-[11px] ${under ? 'font-semibold text-red-700' : 'text-gray-400'}`}>
      {formatNetMarginPercent(margin, floor)}% net{under ? ` · under ${formatMarginFloorPercent(floor)}% floor` : ''}
    </div>
  );
}

export default function Products() {
  const { role, profile } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [products, setProducts] = useState<ProductListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);
  const [bulkProductImportOpen, setBulkProductImportOpen] = useState(false);
  const [deactivateModalOpen, setDeactivateModalOpen] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showSensitive, setShowSensitive] = useState(false);
  // Once per render, not per row: the "Cost as of" column dates every product against it.
  const costFreshnessToday = todayInBusinessTz();
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [pricingPreview, setPricingPreview] = useState<PricingPreviewResult | null>(null);
  const [applyingPricing, setApplyingPricing] = useState(false);
  const [workbookBusy, setWorkbookBusy] = useState(false);
  const [tableRevision, setTableRevision] = useState(0);
  const pricingWorkbookInputRef = useRef<HTMLInputElement>(null);

  const previewPricingIdem = useIdempotencyKey('preview_product_pricing_changes', profile?.id || '');
  const applyPricingIdem = useIdempotencyKey('apply_product_pricing_change_set', profile?.id || '');
  const exportPricingIdem = useIdempotencyKey('create_pricing_workbook_export', profile?.id || '');
  const marginFloorIdem = useIdempotencyKey('set_product_margin_floors', profile?.id || '');
  const [marginFloors, setMarginFloorsByProduct] = useState<Map<string, number>>(new Map());
  const [marginFloorsLoadFailed, setMarginFloorsLoadFailed] = useState(false);
  // Products whose floor this page just saved, so it is known even while the floors failed to load.
  const [marginFloorsKnownFromSave, setMarginFloorsKnownFromSave] = useState<Set<string>>(new Set());

  const canBulkAction = role === 'admin' || role === 'sales_rep';
  const isAdmin = role === 'admin';

  // Only the newest load may install rows: a role change re-runs the loader while an older
  // (possibly cost-less) load is still in flight (Luna round 2).
  const loadSeqRef = useRef(0);
  const fetchProducts = useCallback(async (reportError = true): Promise<boolean> => {
    const seq = ++loadSeqRef.current;
    // A failed load hides the rows, so an open Deactivate dialog for a hidden selection closes too.
    const failLoad = () => {
      setLoadError(true);
      setDeactivateModalOpen(false);
    };
    // Paginate so the master catalog never silently truncates as the catalog grows.
    // PostgREST caps a single response (default 1000), so we page through with .range().
    const PAGE_SIZE = 1000;
    const all: Product[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('products')
        .select(PRODUCT_COLUMNS)
        .order('product_name')
        .order('id')
        .range(from, from + PAGE_SIZE - 1);
      if (seq !== loadSeqRef.current) return false;
      if (error) {
        Sentry.captureException(error);
        // A silent reload's caller keeps the rows on screen and explains the failure itself.
        if (reportError) toast('error', 'Failed to load products. Please try again.');
        if (reportError) failLoad();
        setLoading(false);
        return false;
      }
      const batch = (data || []) as Product[];
      all.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    // Cost is admin-only (Mason, 2026-10-15).
    let prods: Product[];
    try {
      prods = await withAdminCosts('products', all, isAdmin);
    } catch (costError) {
      Sentry.captureException(costError);
      if (seq !== loadSeqRef.current) return false;
      if (reportError) toast('error', 'Failed to load products. Please try again.');
      if (reportError) failLoad();
      setLoading(false);
      return false;
    }
    // Margin floors (admin-only) only add warnings: a failed read keeps the catalog and says so.
    let floors = new Map<string, number>();
    let floorsFailed = false;
    if (isAdmin) {
      try {
        floors = await fetchMarginFloors();
      } catch (floorError) {
        Sentry.captureException(floorError, { extra: { context: 'load_product_margin_floors' } });
        floorsFailed = true;
      }
    }
    if (seq !== loadSeqRef.current) return false;
    // The floor rides on each row as typed text, so the inline editor can tell a real edit from
    // the stored value (clearing a floor included).
    setProducts(prods.map((p) => ({ ...p, [MARGIN_FLOOR_FIELD]: formatMarginFloorPercent(floors.get(p.id)) })));
    setMarginFloorsByProduct(floors);
    setMarginFloorsKnownFromSave(new Set());
    setMarginFloorsLoadFailed(floorsFailed);
    if (floorsFailed && reportError) toast('warning', 'Margin floors could not be loaded. Floor warnings are hidden until you refresh.');
    setLoadError(false);

    const cats = [...new Set(prods.map((p) => p.category).filter(Boolean))] as string[];
    const vends = [...new Set(prods.map((p) => p.vendor).filter(Boolean))] as string[];
    setCategories(cats.sort());
    setVendors(vends.sort());
    setLoading(false);
    // The rows are installed either way, but a silent reload's caller must still say the floors
    // are missing (its own warning), so a failed floor read is not reported as a clean reload.
    return !floorsFailed;
  }, [isAdmin, toast]);

  useEffect(() => {
    void fetchProducts();
  }, [fetchProducts]);

  const retryProducts = () => {
    setLoading(true);
    void fetchProducts();
  };

  const filtered = products.filter((p) => {
    if (categoryFilter && p.category !== categoryFilter) return false;
    if (vendorFilter && p.vendor !== vendorFilter) return false;
    return true;
  });

  const { selected, toggleSelect, toggleAll, clearSelection, selectedCount, selectedRows, allSelected } =
    useRowSelection({
      data: filtered,
      getId: (p) => p.id,
      isSelectable: (p) => p.is_active,
    });

  const checkboxCol = useMemo(
    () => createCheckboxColumn<Product>(selected, toggleSelect, (p) => p.id, (p) => p.is_active),
    [selected, toggleSelect]
  );

  const handleExportCSV = () => {
    const fmtMargin = (v: unknown) => v != null ? `${(Number(v) * 100).toFixed(1)}%` : '';
    const baseCols = [
      { key: 'product_name', header: 'Product Name' },
      { key: 'sku', header: 'SKU' },
      { key: 'category', header: 'Category' },
      { key: 'vendor', header: 'Vendor' },
    ];
    const showCostMargin = isAdmin && showSensitive;
    const priceCols = showCostMargin
      ? [
          { key: 'current_cost', header: 'Cost', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'cost_updated_date', header: 'Cost As Of', format: formatCostAsOfCSV },
          { key: 'tier1_price', header: 'T1 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier1_margin', header: 'T1 Margin %', format: fmtMargin },
          { key: 'tier2_price', header: 'T2 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier2_margin', header: 'T2 Margin %', format: fmtMargin },
          { key: 'tier3_price', header: 'T3 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier3_margin', header: 'T3 Margin %', format: fmtMargin },
        ]
      : [
          { key: 'tier1_price', header: 'T1 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier2_price', header: 'T2 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier3_price', header: 'T3 Price', format: (v: unknown) => fmtCSV(v as number) },
        ];
    exportToCSV(selectedRows as unknown as Record<string, unknown>[], [
      ...baseCols,
      ...priceCols,
      { key: 'is_active', header: 'Status', format: (v: unknown) => v ? 'Active' : 'Inactive' },
    ], 'products');
    toast('success', `Exported ${selectedRows.length} product(s) to CSV`);
  };

  const handleExportPDF = async () => {
    setExporting(true);
    try {
      const fmtMarginPdf = (v: unknown) => v != null ? String(v) : '';
      // Preprocess data with synthetic margin strings (reportPdf format only gets value, not row)
      const pdfData = selectedRows.map((p) => ({
        ...p,
        _t1_margin_str: p.tier1_margin != null ? `${(p.tier1_margin * 100).toFixed(1)}%` : '',
        _t2_margin_str: p.tier2_margin != null ? `${(p.tier2_margin * 100).toFixed(1)}%` : '',
        _t3_margin_str: p.tier3_margin != null ? `${(p.tier3_margin * 100).toFixed(1)}%` : '',
      }));
      const basePdfCols: ReportPdfColumn[] = [
        { header: 'Product', key: 'product_name' },
        { header: 'SKU', key: 'sku', format: (v) => String(v || '-') },
        { header: 'Category', key: 'category', format: (v) => String(v || '-') },
      ];
      const showCostMarginPdf = isAdmin && showSensitive;
      const pricePdfCols: ReportPdfColumn[] = showCostMarginPdf
        ? [
            { header: 'Cost', key: 'current_cost', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T1 Price', key: 'tier1_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T1 Margin', key: '_t1_margin_str', align: 'right', format: fmtMarginPdf },
            { header: 'T2 Price', key: 'tier2_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T2 Margin', key: '_t2_margin_str', align: 'right', format: fmtMarginPdf },
            { header: 'T3 Price', key: 'tier3_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T3 Margin', key: '_t3_margin_str', align: 'right', format: fmtMarginPdf },
          ]
        : [
            { header: 'T1 Price', key: 'tier1_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T2 Price', key: 'tier2_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T3 Price', key: 'tier3_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
          ];
      await downloadReportPdf({
        title: 'Products',
        subtitle: `${selectedRows.length} product(s) selected`,
        columns: [...basePdfCols, ...pricePdfCols, { header: 'Status', key: 'is_active', format: (v) => v ? 'Active' : 'Inactive' }],
        data: pdfData as unknown as Record<string, unknown>[],
        orientation: showCostMarginPdf ? 'landscape' : 'portrait',
      });
      toast('success', `Downloaded PDF with ${selectedRows.length} product(s)`);
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  // --- Download All (filtered) ---
  const handleDownloadAllCSV = (includeCost: boolean) => {
    const fmtMargin = (v: unknown) => v != null ? `${(Number(v) * 100).toFixed(1)}%` : '';
    const baseCols = [
      { key: 'product_name', header: 'Product Name' },
      { key: 'sku', header: 'SKU' },
      { key: 'category', header: 'Category' },
      { key: 'vendor', header: 'Vendor' },
      { key: 'container_size', header: 'Container Size' },
      { key: 'unit_size', header: 'Unit' },
    ];
    const priceCols = includeCost
      ? [
          { key: 'current_cost', header: 'Cost', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'cost_updated_date', header: 'Cost As Of', format: formatCostAsOfCSV },
          { key: 'tier1_price', header: 'T1 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier1_margin', header: 'T1 Margin %', format: fmtMargin },
          { key: 'tier2_price', header: 'T2 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier2_margin', header: 'T2 Margin %', format: fmtMargin },
          { key: 'tier3_price', header: 'T3 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier3_margin', header: 'T3 Margin %', format: fmtMargin },
        ]
      : [
          { key: 'tier1_price', header: 'Tier 1 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier2_price', header: 'Tier 2 Price', format: (v: unknown) => fmtCSV(v as number) },
          { key: 'tier3_price', header: 'Tier 3 Price', format: (v: unknown) => fmtCSV(v as number) },
        ];
    const filename = includeCost ? 'product-price-sheet-internal' : 'product-sales-sheet';
    exportToCSV(filtered as unknown as Record<string, unknown>[], [...baseCols, ...priceCols], filename);
    toast('success', `Exported ${filtered.length} product(s) to CSV`);
    setExportMenuOpen(false);
  };

  const handleDownloadAllPDF = async (includeCost: boolean) => {
    setExporting(true);
    setExportMenuOpen(false);
    try {
      const fmtMarginPdf = (v: unknown) => v != null ? String(v) : '';
      const pdfData = filtered.map((p) => ({
        ...p,
        _t1_margin_str: p.tier1_margin != null ? `${(p.tier1_margin * 100).toFixed(1)}%` : '',
        _t2_margin_str: p.tier2_margin != null ? `${(p.tier2_margin * 100).toFixed(1)}%` : '',
        _t3_margin_str: p.tier3_margin != null ? `${(p.tier3_margin * 100).toFixed(1)}%` : '',
      }));
      const basePdfCols: ReportPdfColumn[] = [
        { header: 'Product', key: 'product_name' },
        { header: 'SKU', key: 'sku', format: (v) => String(v || '-') },
        { header: 'Category', key: 'category', format: (v) => String(v || '-') },
        { header: 'Size', key: 'container_size', format: (v) => v != null ? String(v) : '-' },
        { header: 'Unit', key: 'unit_size', format: (v) => String(v || '-') },
      ];
      const pricePdfCols: ReportPdfColumn[] = includeCost
        ? [
            { header: 'Cost', key: 'current_cost', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T1 Price', key: 'tier1_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T1 Margin', key: '_t1_margin_str', align: 'right', format: fmtMarginPdf },
            { header: 'T2 Price', key: 'tier2_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T2 Margin', key: '_t2_margin_str', align: 'right', format: fmtMarginPdf },
            { header: 'T3 Price', key: 'tier3_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'T3 Margin', key: '_t3_margin_str', align: 'right', format: fmtMarginPdf },
          ]
        : [
            { header: 'Tier 1 Price', key: 'tier1_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'Tier 2 Price', key: 'tier2_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
            { header: 'Tier 3 Price', key: 'tier3_price', align: 'right', format: (v) => v != null ? fmt(Number(v)) : '-' },
          ];
      const title = includeCost ? 'Product & Pricing — Internal' : 'Product Sales Sheet';
      await downloadReportPdf({
        title,
        subtitle: `${filtered.length} active product(s) — ${new Date().toLocaleDateString()}`,
        columns: [...basePdfCols, ...pricePdfCols],
        data: pdfData as unknown as Record<string, unknown>[],
        orientation: 'landscape',
      });
      toast('success', `Downloaded ${includeCost ? 'internal' : 'sales'} price sheet PDF`);
    } catch (err) {
      toast('error', sanitizeError(err));
    }
    setExporting(false);
  };

  const handleDeactivate = async () => {
    // The selection is hidden behind a failed load, so it cannot be confirmed.
    if (loadError) return;
    const ids = selectedRows.map((p) => p.id);

    // H22: Block deactivation if any selected product has open PO lines
    const { data: openPoLines } = await supabase
      .from('purchase_order_items')
      .select('id, product_id, purchase_order:purchase_orders!inner(status)')
      .in('product_id', ids)
      .in('purchase_order.status', ['draft', 'submitted', 'partially_received'])
      .limit(1);
    if (openPoLines && openPoLines.length > 0) {
      toast('error', 'Cannot deactivate: one or more selected products have open purchase order lines. Receive or cancel those POs first.');
      setDeactivateModalOpen(false);
      return;
    }

    await runCriticalAction({
      action: async () => {
        const result = await supabase
          .from('products')
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .in('id', ids)
          .select('id');
        checkMutationResult(result, 'Deactivate products');
      },
      toast,
      setLoading: setDeactivating,
      successMessage: `Deactivated ${ids.length} product(s)`,
      sentryTag: 'deactivate_products',
      onSuccess: () => {
        clearSelection();
        fetchProducts();
        setDeactivateModalOpen(false);
      },
    });
  };

  const bulkActions = [
    { key: 'csv', label: 'Export CSV', icon: <Download className="w-4 h-4" />, onClick: handleExportCSV },
    { key: 'pdf', label: 'Download PDF', icon: <FileText className="w-4 h-4" />, onClick: handleExportPDF, loading: exporting },
    { key: 'deactivate', label: 'Deactivate', icon: <Trash2 className="w-4 h-4" />, onClick: () => setDeactivateModalOpen(true), variant: 'danger' as const },
  ];

  const categoryOptions = categories.map((c) => ({ value: c, label: c }));
  const vendorOptions = vendors.map((v) => ({ value: v, label: v }));

  /** Render the one input family selected for this row. The server computes every effect. */
  const createTierEditRender = (tierNum: 1 | 2 | 3) => {
    const marginKey = `tier${tierNum}_margin` as keyof Product & string;
    const marginPercentKey = `tier${tierNum}_margin_percent`;
    const priceKey = `tier${tierNum}_price` as keyof Product & string;

    return (
      row: Product,
      getCellValue: (colKey: string) => unknown,
      setCellValue: (colKey: string, value: unknown) => void
    ) => {
      const mode = getCellValue('pricing_mode') as PricingMode | undefined;
      if (mode === 'price_driven') {
        const price = getCellValue(priceKey);
        return (
          <input
            type="number"
            aria-label={`Tier ${tierNum} price for ${row.product_name}`}
            value={price != null ? String(price) : ''}
            min={0}
            step="0.01"
            onChange={(e) => {
              const raw = e.target.value;
              setCellValue(priceKey, raw);
            }}
            className="w-full px-2 py-1 text-sm text-right font-mono border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30"
          />
        );
      }

      if (mode === 'margin_driven') {
        const dirtyValue = getCellValue(marginPercentKey);
        const value = dirtyValue ?? storedMarginPercent(row[marginKey] as number | null) ?? '';
        return (
          <div className="flex items-center gap-1">
            <input
              type="number"
              aria-label={`Tier ${tierNum} net margin percent for ${row.product_name}`}
              value={String(value)}
              min={0}
              max={99.999999}
              step="0.1"
              onChange={(e) => setCellValue(marginPercentKey, e.target.value)}
              className="w-20 px-1 py-1 text-sm text-right font-mono border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30"
            />
            <span className="text-xs text-gray-400">%</span>
          </div>
        );
      }

      return <span className="text-xs text-amber-700">Select a pricing mode</span>;
    };
  };

  const saveMarginFloors = async (changes: Map<string, Record<string, unknown>>): Promise<boolean> => {
    if (!profile) throw new Error('Your user profile is not available. Refresh and try again.');
    const floorChanges: MarginFloorChange[] = [];
    for (const [productId, fields] of changes) {
      if (!(MARGIN_FLOOR_FIELD in fields)) continue;
      const original = products.find((product) => product.id === productId);
      if (!original) throw new Error('A Product changed while you were editing. Refresh and try again.');
      let percent: number | null;
      try {
        percent = parseMarginFloorPercent(String(fields[MARGIN_FLOOR_FIELD] ?? ''));
      } catch (err) {
        throw new Error(`${original.product_name}: ${err instanceof Error ? err.message : 'invalid margin floor'}`);
      }
      floorChanges.push({ productId, marginFloorPercent: percent });
    }
    // One key per exact request: a retry of the same save replays; a changed one is a new save.
    const scope = JSON.stringify(floorChanges);
    let result: SetMarginFloorsResult;
    try {
      result = await setMarginFloors({
        changes: floorChanges,
        reason: '',
        performedBy: profile.id,
        idempotencyKey: marginFloorIdem.getKeyFor(scope),
      });
    } catch (err) {
      if (!isMarginFloorRefusal(err)) Sentry.captureException(err, { extra: { context: 'set_product_margin_floors_inline' } });
      throw new Error(marginFloorErrorMessage(err));
    }
    marginFloorIdem.resetKeyFor(scope);
    const reloaded = await fetchProducts(false);
    if (!reloaded) {
      // Show what was saved rather than the old floors, so nobody re-enters them. Only the saved
      // products change: the rest keep whatever the failed reload left (the earlier floors if the
      // products failed, none if the floors failed, where they show "?" and stay read-only).
      const changedIds = new Set(floorChanges.map((change) => change.productId));
      const savedPercent = new Map(floorChanges.map((change) => [change.productId, change.marginFloorPercent]));
      const savedFloor = (productId: string) => {
        const percent = savedPercent.get(productId);
        return percent == null ? undefined : percent / 100;
      };
      setMarginFloorsByProduct((current) => {
        const next = new Map([...current].filter(([productId]) => !changedIds.has(productId)));
        for (const productId of changedIds) {
          const floor = savedFloor(productId);
          if (floor !== undefined) next.set(productId, floor);
        }
        return next;
      });
      setMarginFloorsKnownFromSave(changedIds);
      setProducts((rows) => rows.map((p) => (changedIds.has(p.id)
        ? { ...p, [MARGIN_FLOOR_FIELD]: formatMarginFloorPercent(savedFloor(p.id)) }
        : p)));
      toast('warning', 'Margin floors were saved, but the list could not be reloaded. Refresh this page.');
    } else if (result.changed_count === 0) {
      toast('info', 'The margin floors are unchanged.');
    } else {
      toast('success', `Updated ${result.changed_count} margin floor(s).`);
    }
    return true;
  };

  const handleBulkSave = async (changes: Map<string, Record<string, unknown>>): Promise<void | boolean> => {
    try {
      let hasPricing = false;
      let hasNonpricing = false;
      let hasFloor = false;
      for (const fields of changes.values()) {
        hasPricing ||= Object.keys(fields).some((key) => INLINE_PRICING_FIELDS.has(key));
        hasNonpricing ||= Object.keys(fields).some((key) => INLINE_NONPRICING_FIELDS.has(key));
        hasFloor ||= MARGIN_FLOOR_FIELD in fields;
      }

      if (hasFloor && (hasPricing || hasNonpricing)) {
        throw new Error('Save margin floors on their own. Cancel, change only the floors, then save again.');
      }
      if (hasFloor) {
        return await saveMarginFloors(changes);
      }

      if (hasPricing && hasNonpricing) {
        throw new Error('Save product details and pricing in separate review steps. Cancel, make one kind of change, then save again.');
      }

      if (hasPricing) {
        if (!profile) throw new Error('Your user profile is not available. Refresh and try again.');
        const pricingRows: PricingPreviewInputRow[] = [];
        for (const [productId, fields] of changes) {
          if (!Object.keys(fields).some((key) => INLINE_PRICING_FIELDS.has(key))) continue;
          const original = products.find((product) => product.id === productId);
          if (!original) throw new Error('A Product changed while you were editing. Refresh and try again.');
          const mode = fields.pricing_mode as PricingMode | undefined;
          if (mode !== 'margin_driven' && mode !== 'price_driven') {
            throw new Error(`Choose margin-driven or price-driven for ${original.product_name}.`);
          }
          const newCost = inputDecimal(fields.current_cost ?? original.current_cost);
          if (newCost === null) throw new Error(`Enter a cost for ${original.product_name}.`);
          if (mode === 'margin_driven' && pricingDollarInputToCents(newCost) === 0n) {
            throw new Error(`Margin-driven pricing requires a cost greater than $0 for ${original.product_name}. No prices were changed.`);
          }
          if (!Number.isInteger(original.pricing_version) || (original.pricing_version ?? 0) < 1) {
            throw new Error(`${original.product_name} does not have a pricing version yet. Refresh after the Phase 1a database migration is available.`);
          }

          const row: PricingPreviewInputRow = {
            product_id: original.id,
            product_name: original.product_name,
            sku: original.sku ?? '',
            row_version: original.pricing_version!,
            pricing_mode: mode,
            new_cost: newCost,
            change_reason: 'Products inline pricing edit',
          };
          if (mode === 'margin_driven') {
            for (const tier of [1, 2, 3] as const) {
              const field = `tier${tier}_margin_percent` as const;
              const stored = original[`tier${tier}_margin` as const];
              const value = inputDecimal(fields[field] ?? storedMarginPercent(stored));
              if (value === null) {
                throw new Error(`Enter all three margins for ${original.product_name}.`);
              }
              row[field] = value;
            }
          } else {
            for (const tier of [1, 2, 3] as const) {
              const field = `tier${tier}_price` as const;
              const value = inputDecimal(fields[field] ?? original[field]);
              if (value === null) {
                throw new Error(`Enter all three tier prices for ${original.product_name}.`);
              }
              row[field] = value;
            }
          }
          pricingRows.push(row);
        }

        const preview = await previewProductPricingChanges({
          source: 'products_inline',
          rows: pricingRows,
          performedBy: profile.id,
          idempotencyKey: previewPricingIdem.getKey(),
        });
        previewPricingIdem.resetKey();
        setPricingPreview(preview);
        return false;
      }

      for (const [productId, fields] of changes) {
        const nonpricingFields = Object.fromEntries(
          Object.entries(fields).filter(([key]) => INLINE_NONPRICING_FIELDS.has(key)),
        );
        const updateResult = await supabase
          .from('products')
          .update({ ...nonpricingFields, updated_at: new Date().toISOString() })
          .eq('id', productId)
          .select('id');
        checkMutationResult(updateResult, 'Update product');
      }

      toast('success', `Updated ${changes.size} product(s)`);
      if (profile) {
        logActivity({ event: 'products_bulk_updated', description: `${changes.size} product(s) updated via inline edit`, performedBy: profile.id, entityType: 'product' });
      }
      fetchProducts();
      return true;
    } catch (err: unknown) {
      toast('error', sanitizeError(err));
      throw err; // re-throw so EditableDataTable stays in edit mode
    }
  };

  const handleExportPricingWorkbook = async () => {
    if (!profile) return;
    const productIds = (selectedRows.length > 0 ? selectedRows : filtered)
      .filter((product) => product.is_active)
      .map((product) => product.id);
    if (productIds.length === 0) {
      toast('warning', 'Select at least one active Product to export.');
      return;
    }
    if (productIds.length > MAX_PRICING_WORKBOOK_ROWS) {
      toast(
        'error',
        `Pricing workbooks are limited to ${MAX_PRICING_WORKBOOK_ROWS.toLocaleString()} Products. Narrow the filters or select a smaller batch.`,
      );
      return;
    }
    setWorkbookBusy(true);
    try {
      const pricingExport = await createPricingWorkbookExport({
        productIds,
        performedBy: profile.id,
        idempotencyKey: exportPricingIdem.getKey(),
      });
      const supplierEvidence = await getSupplierMarketEvidence(productIds);
      const blob = await generateProductPricingWorkbookWithSupplierEvidence(
        pricingExport,
        supplierEvidence,
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `crx-product-pricing-${new Date().toISOString().slice(0, 10)}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(url);
      exportPricingIdem.resetKey();
      toast('success', `Exported ${productIds.length} Product pricing row(s).`);
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setWorkbookBusy(false);
    }
  };

  const handlePricingWorkbookUpload = async (file: File) => {
    if (!profile) return;
    if (file.size > MAX_PRICING_WORKBOOK_FILE_BYTES) {
      toast(
        'error',
        `Pricing workbooks must be ${MAX_PRICING_WORKBOOK_FILE_BYTES / 1024 / 1024} MB or smaller.`,
      );
      if (pricingWorkbookInputRef.current) pricingWorkbookInputRef.current.value = '';
      return;
    }
    setWorkbookBusy(true);
    try {
      const parsed = await parseProductPricingWorkbookWithSupplierEvidence(await file.arrayBuffer());
      const preview = await previewProductPricingChanges({
        source: 'pricing_worksheet',
        exportId: parsed.exportId,
        rows: parsed.rows,
        performedBy: profile.id,
        idempotencyKey: previewPricingIdem.getKey(),
      });
      previewPricingIdem.resetKey();
      setPricingPreview(preview);
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setWorkbookBusy(false);
      if (pricingWorkbookInputRef.current) pricingWorkbookInputRef.current.value = '';
    }
  };

  const handleApplyPricing = async () => {
    if (!pricingPreview || !profile) return;
    setApplyingPricing(true);
    try {
      const result = await applyProductPricingChangeSet({
        changeSetId: pricingPreview.change_set_id,
        requestFingerprint: pricingPreview.request_fingerprint,
        performedBy: profile.id,
        idempotencyKey: applyPricingIdem.getKey(),
      });
      applyPricingIdem.resetKey();
      setPricingPreview(null);
      setTableRevision((revision) => revision + 1);
      const reloaded = await fetchProducts(false);
      if (reloaded) {
        toast('success', `Applied pricing to ${result.applied_count} Product(s).`);
      } else {
        toast('warning', 'Pricing was applied, but the latest Product values could not be reloaded. Refresh this page before making another change.');
      }
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setApplyingPricing(false);
    }
  };

  const dataColumns: EditableColumn<Product>[] = [
    {
      key: 'product_name',
      header: 'Product Name',
      sortable: true,
      editable: isAdmin,
      editType: 'text',
      render: (row) => (
        <div className="max-w-xs">
          <p className="font-medium text-nav-dark truncate">{row.product_name}</p>
          {row.sku && <p className="text-xs text-gray-400">{row.sku}</p>}
        </div>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      sortable: true,
      editable: isAdmin,
      editType: 'select',
      editOptions: categoryOptions,
    },
    {
      key: 'vendor',
      header: 'Vendor',
      sortable: true,
      editable: isAdmin,
      editType: 'select',
      editOptions: vendorOptions,
    },
    ...(isAdmin && showSensitive
      ? [
          {
            key: 'current_cost',
            header: 'Cost',
            sortable: true,
            editable: true,
            editType: 'decimal' as const,
            editMin: 0,
            editStep: '0.01',
            editAriaLabel: (row: Product) => `Cost for ${row.product_name}`,
            render: (row: Product) => (
              <span className="font-mono text-sm">
                {row.current_cost != null ? `$${Number(row.current_cost).toFixed(2)}` : '-'}
              </span>
            ),
          } satisfies EditableColumn<Product>,
          {
            // When the cost last changed (To-Do 0.7); Reports > Operational > Stale Costs lists the old ones.
            key: 'cost_updated_date',
            header: 'Cost as of',
            sortable: true,
            render: (row: Product) => {
              const asOf = costAsOfDate(row.cost_updated_date);
              const stale = isCostStale(costAgeDays(asOf, costFreshnessToday), DEFAULT_STALE_COST_AGE_DAYS);
              const note = !asOf
                ? 'No cost change date is recorded for this product'
                : stale ? `No cost change in the last ${DEFAULT_STALE_COST_AGE_DAYS} days` : undefined;
              return (
                <span className={`text-sm ${stale ? 'text-amber-700' : 'text-secondary'}`} title={note}>
                  {asOf ? parseLocalDate(asOf).toLocaleDateString() : 'Unknown'}
                  {asOf && stale && <span aria-hidden="true"> (old)</span>}
                  {note && <span className="sr-only">. {note}</span>}
                </span>
              );
            },
          } satisfies EditableColumn<Product>,
          {
            key: MARGIN_FLOOR_FIELD,
            header: 'Floor %',
            // Read-only while the floors failed to load: an edit would be made against unknown values.
            editable: !marginFloorsLoadFailed,
            editRender: (row: Product, getCellValue: (colKey: string) => unknown, setCellValue: (colKey: string, value: unknown) => void) => {
              const value = getCellValue(MARGIN_FLOOR_FIELD) ?? '';
              return (
                <div className="flex items-center gap-1">
                  {/* Text, not number: a number box reports text it cannot read as "", which would clear the floor. */}
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label={`Margin floor percent for ${row.product_name}`}
                    value={String(value)}
                    placeholder="None"
                    onChange={(e) => setCellValue(MARGIN_FLOOR_FIELD, e.target.value)}
                    className="w-20 px-1 py-1 text-sm text-right font-mono border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-crx-green/30"
                  />
                  <span className="text-xs text-gray-400">%</span>
                </div>
              );
            },
            render: (row: Product) => {
              if (marginFloorsLoadFailed && !marginFloorsKnownFromSave.has(row.id)) {
                return <span className="text-xs text-amber-700" title="Margin floors could not be loaded">?</span>;
              }
              const floor = marginFloors.get(row.id);
              return (
                <span className="font-mono text-sm">{floor != null ? `${formatMarginFloorPercent(floor)}%` : '-'}</span>
              );
            },
          } satisfies EditableColumn<Product>,
        ]
      : []),
    ...(isAdmin
      ? [{
          key: 'pricing_mode',
          header: 'Pricing Mode',
          editable: true,
          editType: 'select' as const,
          editOptions: [
            { value: 'margin_driven', label: 'Margin-driven' },
            { value: 'price_driven', label: 'Price-driven' },
          ],
          editAriaLabel: (row) => `Pricing mode for ${row.product_name}`,
          render: () => <span className="text-xs text-gray-400">Choose while editing</span>,
        } satisfies EditableColumn<Product>]
      : []),
    {
      key: 'tier1_price',
      header: 'T1 Price',
      sortable: true,
      editable: isAdmin,
      editRender: isAdmin ? createTierEditRender(1) : undefined,
      render: (row) => (
        <div>
          <span className="font-mono text-sm">
            {row.tier1_price != null ? `$${Number(row.tier1_price).toFixed(2)}` : '-'}
          </span>
          {isAdmin && showSensitive && row.tier1_margin != null && (
            <NetMarginNote margin={row.tier1_margin} floor={marginFloors.get(row.id)} />
          )}
        </div>
      ),
    },
    {
      key: 'tier2_price',
      header: 'T2 Price',
      sortable: true,
      editable: isAdmin,
      editRender: isAdmin ? createTierEditRender(2) : undefined,
      render: (row) => (
        <div>
          <span className="font-mono text-sm">
            {row.tier2_price != null ? `$${Number(row.tier2_price).toFixed(2)}` : '-'}
          </span>
          {isAdmin && showSensitive && row.tier2_margin != null && (
            <NetMarginNote margin={row.tier2_margin} floor={marginFloors.get(row.id)} />
          )}
        </div>
      ),
    },
    {
      key: 'tier3_price',
      header: 'T3 Price',
      sortable: true,
      editable: isAdmin,
      editRender: isAdmin ? createTierEditRender(3) : undefined,
      render: (row) => (
        <div>
          <span className="font-mono text-sm">
            {row.tier3_price != null ? `$${Number(row.tier3_price).toFixed(2)}` : '-'}
          </span>
          {isAdmin && showSensitive && row.tier3_margin != null && (
            <NetMarginNote margin={row.tier3_margin} floor={marginFloors.get(row.id)} />
          )}
        </div>
      ),
    },
    {
      key: 'is_active',
      header: 'Status',
      editable: isAdmin,
      editType: 'toggle',
      render: (row) => (
        <Badge variant={row.is_active ? 'success' : 'default'}>
          {row.is_active ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
  ];

  const columns: EditableColumn<Product>[] = canBulkAction
    ? [checkboxCol as unknown as EditableColumn<Product>, ...dataColumns]
    : dataColumns;

  if (loading) {
    return (
      <div className="p-6">
        <SkeletonTable rows={8} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Products"
        subtitle={<HelpTip text="Your product master list. Set tier pricing (1/2/3) for customer-specific pricing, mark products as RUP for compliance tracking, and manage unit sizes. Edit inline by clicking any editable cell." />}
        actions={(
          <>
          {/* Bulk actions act on the selection, so they wait while the rows are hidden by a failed load. */}
          {canBulkAction && !loadError && (
            <BulkActionBar
              selectedCount={selectedCount}
              actions={bulkActions}
              onDeselectAll={clearSelection}
            />
          )}
          <div className="flex flex-wrap gap-2">
          {/* Download All dropdown. Exports wait while a failed load hides the rows: they would
              export the old catalog as if it were current. */}
          <div className="relative">
            <Button
              variant="secondary"
              icon={<Download className="w-4 h-4" />}
              onClick={() => setExportMenuOpen((v) => !v)}
              disabled={exporting || loadError || filtered.length === 0}
            >
              {exporting ? 'Exporting...' : 'Download'} <ChevronDown className="w-3 h-3 ml-1 inline" />
            </Button>
            {exportMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" role="presentation" onClick={() => setExportMenuOpen(false)} onKeyDown={() => setExportMenuOpen(false)} />
                <div className="absolute right-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1">
                  <p className="px-3 py-1.5 text-xs font-semibold text-secondary uppercase tracking-wide">PDF</p>
                  <button onClick={() => handleDownloadAllPDF(false)} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                    <FileText className="w-4 h-4 text-gray-400" /> Sales Sheet (prices only)
                  </button>
                  {isAdmin && (
                    <button onClick={() => handleDownloadAllPDF(true)} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                      <FileText className="w-4 h-4 text-gray-400" /> Internal (cost + margin)
                    </button>
                  )}
                  <div className="border-t border-gray-100 my-1" />
                  <p className="px-3 py-1.5 text-xs font-semibold text-secondary uppercase tracking-wide">CSV</p>
                  <button onClick={() => handleDownloadAllCSV(false)} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                    <Download className="w-4 h-4 text-gray-400" /> Sales Sheet (prices only)
                  </button>
                  {isAdmin && (
                    <button onClick={() => handleDownloadAllCSV(true)} className="w-full px-3 py-2 text-left text-sm hover:bg-gray-50 flex items-center gap-2">
                      <Download className="w-4 h-4 text-gray-400" /> Internal (cost + margin)
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          {isAdmin && (
            <>
              <Button
                variant="secondary"
                icon={<FileSpreadsheet className="w-4 h-4" />}
                onClick={handleExportPricingWorkbook}
                loading={workbookBusy}
                disabled={loadError || filtered.length === 0}
              >
                Pricing .xlsx
              </Button>
              <Button
                variant="secondary"
                icon={<Upload className="w-4 h-4" />}
                onClick={() => pricingWorkbookInputRef.current?.click()}
                disabled={workbookBusy}
              >
                Review Pricing File
              </Button>
              <input
                ref={pricingWorkbookInputRef}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handlePricingWorkbookUpload(file);
                }}
              />
              <Button
                variant="secondary"
                icon={<FileUp className="w-4 h-4" />}
                onClick={() => setBulkProductImportOpen(true)}
              >
                Import Products
              </Button>
              <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/products/new')}>
                Add Product
              </Button>
            </>
          )}
          </div>
          </>
        )}
      />

      <Card padding={false}>
        <div className="p-5">
          <EditableDataTable<ProductListRow>
            key={tableRevision}
            data={filtered}
            columns={columns}
            rowKey="id"
            searchable
            searchPlaceholder="Search products..."
            searchKeys={['product_name', 'sku', 'category', 'vendor']}
            onRowClick={(row) => navigate(`/products/${row.id}`)}
            emptyTitle="No products yet"
            emptyDescription="Add your first product to get started"
            emptyAction={
              isAdmin ? (
                <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/products/new')}>
                  Add Product
                </Button>
              ) : undefined
            }
            loading={loading}
            loadError={loadError}
            onRetry={retryProducts}
            canEdit={isAdmin}
            onSave={handleBulkSave}
            headerActions={isAdmin ? (
              <Button
                variant="secondary"
                size="sm"
                icon={showSensitive ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                onClick={() => setShowSensitive((v) => !v)}
              >
                {showSensitive ? 'Hide' : 'Margins'}
              </Button>
            ) : undefined}
            filters={
              <>
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  aria-label="Filter by category"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Categories</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <select
                  value={vendorFilter}
                  onChange={(e) => setVendorFilter(e.target.value)}
                  aria-label="Filter by vendor"
                  className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
                >
                  <option value="">All Vendors</option>
                  {vendors.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
                {canBulkAction && !loadError && filtered.length > 0 && (
                  <button
                    onClick={toggleAll}
                    className="px-3 py-2 text-xs font-medium text-secondary hover:text-nav-dark transition-colors"
                  >
                    {allSelected ? 'Deselect All' : 'Select All'}
                  </button>
                )}
              </>
            }
          />
        </div>
      </Card>

      <BulkProductImport
        open={bulkProductImportOpen}
        onClose={() => setBulkProductImportOpen(false)}
        onSuccess={() => {
          fetchProducts();
          setBulkProductImportOpen(false);
        }}
      />

      <PricingChangePreviewModal
        open={pricingPreview !== null}
        preview={pricingPreview}
        applying={applyingPricing}
        title="Review Product Pricing"
        onClose={() => {
          setPricingPreview(null);
          applyPricingIdem.resetKey();
        }}
        onApprove={() => void handleApplyPricing()}
      />

      <BulkDeleteConfirmModal
        open={deactivateModalOpen}
        onClose={() => setDeactivateModalOpen(false)}
        count={selectedCount}
        entityName="product"
        actionWord="deactivate"
        onConfirm={handleDeactivate}
        loading={deactivating}
      />
    </div>
  );
}
