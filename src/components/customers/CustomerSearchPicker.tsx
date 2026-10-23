import { supabase } from '../../lib/db';
import RecordSearchPicker from '../ui/RecordSearchPicker';
import { excludedIdList } from '../../lib/recordSearch';

export const CUSTOMER_SEARCH_SELECT = 'id, farm_name, account_number, city, state, is_active';

export interface CustomerSearchResult {
  id: string;
  farm_name: string;
  account_number?: string | null;
  city?: string | null;
  state?: string | null;
  is_active?: boolean;
}

interface CustomerSearchPickerProps<T extends CustomerSearchResult = CustomerSearchResult> {
  /** Selected customer id, or '' for none. */
  value: string;
  /** Farm name shown for the selected customer; the caller keeps it so no customer list is needed. */
  selectedLabel: string;
  /** Called with the picked customer (the columns in `select`), or null when cleared. */
  onSelect: (customer: T | null) => void | boolean;
  /** Columns to read; include CUSTOMER_SEARCH_SELECT's columns when a caller needs more. */
  select?: string;
  /** Search only active customers (the default), as the old pickers loaded. */
  activeOnly?: boolean;
  excludeIds?: readonly string[];
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

function customerDetails(customer: CustomerSearchResult) {
  const place = [customer.city, customer.state].filter(Boolean).join(', ');
  const parts = [customer.account_number ? `#${customer.account_number}` : '', place, customer.is_active === false ? 'Inactive' : '']
    .filter(Boolean);
  return parts.length ? <div className="text-xs text-secondary">{parts.join(' · ')}</div> : null;
}

/**
 * Customer picker that searches the database by farm name or account number
 * as you type, so every customer can be found however many there are.
 */
export default function CustomerSearchPicker<T extends CustomerSearchResult = CustomerSearchResult>({
  value,
  selectedLabel,
  onSelect,
  select = CUSTOMER_SEARCH_SELECT,
  activeOnly = true,
  excludeIds,
  placeholder = 'Search customers...',
  ariaLabel = 'Search customers',
  id,
  disabled,
  className,
}: CustomerSearchPickerProps<T>) {
  return (
    <RecordSearchPicker<T>
      value={value}
      selectedLabel={selectedLabel}
      onSelect={onSelect}
      search={(pattern, limit) => {
        let query = supabase
          .from('customers')
          .select(select)
          .or(`farm_name.ilike.${pattern},account_number.ilike.${pattern}`);
        if (activeOnly) query = query.eq('is_active', true);
        if (excludeIds?.length) query = query.not('id', 'in', excludedIdList(excludeIds));
        return query.order('farm_name').order('id').limit(limit);
      }}
      searchKey={[activeOnly, select, excludeIds?.join(',') ?? ''].join('|')}
      getLabel={(customer) => customer.farm_name}
      renderDetails={customerDetails}
      noun="customers"
      emptyMessage={activeOnly ? 'No matching active customers' : undefined}
      sentryContext="customer_search_picker"
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      id={id}
      disabled={disabled}
      className={className}
    />
  );
}
