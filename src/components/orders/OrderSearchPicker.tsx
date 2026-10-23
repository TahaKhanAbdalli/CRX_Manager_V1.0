import { supabase } from '../../lib/db';
import RecordSearchPicker from '../ui/RecordSearchPicker';
import { excludedIdList } from '../../lib/recordSearch';
import { numberOrCustomerNameTerms } from '../../lib/customerNameSearch';
import { orderSearchLabel } from '../../lib/recordLabels';
import type { OrderStatus } from '../../types';

// A fixed column list: orders is a cost table, so screens never read a caller-built one.
export const ORDER_SEARCH_SELECT = 'id, order_number, customer_id, status, order_date, customer:customers(farm_name)';

export interface OrderSearchResult {
  id: string;
  order_number: string;
  customer_id: string;
  status: OrderStatus;
  order_date?: string | null;
  customer?: { farm_name?: string | null } | null;
}

interface OrderSearchPickerProps<T extends OrderSearchResult = OrderSearchResult> {
  /** Selected order id, or '' for none. */
  value: string;
  /** Label shown for the selected order; the caller keeps it so no order list is needed. */
  selectedLabel: string;
  /** Called with the picked order (the columns in `select`), or null when cleared. */
  onSelect: (order: T | null) => void | boolean;
  /** Only orders in these statuses, as the old list loaded. */
  statuses: readonly OrderStatus[];
  /** Only this customer's orders, when given. */
  customerId?: string | null;
  excludeIds?: readonly string[];
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

function orderDetails(order: OrderSearchResult) {
  const parts = [order.status.replace('_', ' '), order.order_date ?? ''].filter(Boolean);
  return <div className="text-xs text-secondary">{parts.join(' · ')}</div>;
}

/**
 * Order picker that searches the database by order number or customer name as
 * you type, so every open order can be found however many there are.
 */
export default function OrderSearchPicker<T extends OrderSearchResult = OrderSearchResult>({
  value,
  selectedLabel,
  onSelect,
  statuses,
  customerId,
  excludeIds,
  placeholder = 'Search by order # or customer...',
  ariaLabel = 'Search orders',
  id,
  disabled,
  className,
}: OrderSearchPickerProps<T>) {
  return (
    <RecordSearchPicker<T>
      value={value}
      selectedLabel={selectedLabel}
      onSelect={onSelect}
      search={async (pattern, limit) => {
        const { terms, error } = await numberOrCustomerNameTerms('order_number', pattern, customerId);
        if (error || !terms) return { data: null, error };
        let query = supabase
          .from('orders')
          .select(ORDER_SEARCH_SELECT)
          .or(terms)
          .in('status', [...statuses])
          .is('deleted_at', null);
        if (customerId) query = query.eq('customer_id', customerId);
        if (excludeIds?.length) query = query.not('id', 'in', excludedIdList(excludeIds));
        return query.order('order_date', { ascending: false }).order('id').limit(limit);
      }}
      searchKey={[statuses.join(','), customerId ?? '', excludeIds?.join(',') ?? ''].join('|')}
      getLabel={orderSearchLabel}
      renderDetails={orderDetails}
      noun="orders"
      sentryContext="order_search_picker"
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      id={id}
      disabled={disabled}
      className={className}
    />
  );
}
