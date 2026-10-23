import { supabase } from '../../lib/db';
import RecordSearchPicker from '../ui/RecordSearchPicker';
import { excludedIdList } from '../../lib/recordSearch';
import { PURCHASE_ORDER_COLUMNS, withAdminCosts } from '../../lib/costFields';
import { purchaseOrderSearchLabel } from '../../lib/recordLabels';
import { formatUSD } from '../../lib/money';
import type { POStatus, PurchaseOrder } from '../../types';

interface PurchaseOrderSearchPickerProps {
  /** Selected purchase order id, or '' for none. */
  value: string;
  /** Label shown for the selected purchase order; the caller keeps it so no PO list is needed. */
  selectedLabel: string;
  /** Called with the picked purchase order (with its total for an admin), or null when cleared. */
  onSelect: (po: PurchaseOrder | null) => void | boolean;
  /** Only purchase orders in these statuses, as the old list loaded. */
  statuses: readonly POStatus[];
  /** Cost is admin-only: an admin's results carry each PO's total; nobody else's do. */
  isAdmin: boolean;
  excludeIds?: readonly string[];
  placeholder?: string;
  ariaLabel?: string;
  clearLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

function purchaseOrderDetails(po: PurchaseOrder) {
  const parts = [
    po.status.replace('_', ' '),
    po.submitted_date ?? '',
    po.total_cost != null ? formatUSD(po.total_cost) : '',
  ].filter(Boolean);
  return <div className="text-xs text-secondary">{parts.join(' · ')}</div>;
}

/**
 * Purchase order picker that searches the database by PO number or vendor as
 * you type, so every purchase order can be found however many there are.
 */
export default function PurchaseOrderSearchPicker({
  value,
  selectedLabel,
  onSelect,
  statuses,
  isAdmin,
  excludeIds,
  placeholder = 'Search by PO # or vendor...',
  ariaLabel = 'Search purchase orders',
  clearLabel = 'Clear purchase order',
  id,
  disabled,
  className,
}: PurchaseOrderSearchPickerProps) {
  return (
    <RecordSearchPicker<PurchaseOrder>
      value={value}
      selectedLabel={selectedLabel}
      onSelect={onSelect}
      search={async (pattern, limit) => {
        let query = supabase
          .from('purchase_orders')
          .select(PURCHASE_ORDER_COLUMNS)
          .or(`po_number.ilike.${pattern},vendor.ilike.${pattern}`)
          .in('status', [...statuses]);
        if (excludeIds?.length) query = query.not('id', 'in', excludedIdList(excludeIds));
        const { data, error } = await query.order('created_at', { ascending: false }).order('id').limit(limit);
        if (error) return { data: null, error };
        // A failed cost read fails the search, so an admin never picks a PO whose total is missing.
        try {
          return { data: await withAdminCosts('purchase_orders', (data || []) as PurchaseOrder[], isAdmin), error: null };
        } catch (costError) {
          return { data: null, error: costError };
        }
      }}
      searchKey={[statuses.join(','), isAdmin, excludeIds?.join(',') ?? ''].join('|')}
      getLabel={purchaseOrderSearchLabel}
      renderDetails={purchaseOrderDetails}
      noun="purchase orders"
      sentryContext="purchase_order_search_picker"
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      clearLabel={clearLabel}
      id={id}
      disabled={disabled}
      className={className}
    />
  );
}
