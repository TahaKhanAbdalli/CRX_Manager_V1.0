import { supabase } from '../../lib/db';
import RecordSearchPicker from '../ui/RecordSearchPicker';
import { excludedIdList } from '../../lib/recordSearch';

export const FIELD_SEARCH_SELECT =
  'id, field_name, customer_id, total_acres, county, state, customer:customers!fields_customer_id_fkey(farm_name)';

export interface FieldSearchResult {
  id: string;
  field_name: string;
  customer_id?: string;
  total_acres?: number | null;
  county?: string | null;
  state?: string | null;
  customer?: { farm_name?: string | null } | null;
}

interface FieldSearchPickerProps<T extends FieldSearchResult = FieldSearchResult> {
  /** Selected field id, or '' for none. */
  value: string;
  /** Field name shown for the selected field; the caller keeps it so no field list is needed. */
  selectedLabel: string;
  /** Called with the picked field (the columns in `select`), or null when cleared. */
  onSelect: (field: T | null) => void | boolean;
  /** Columns to read; include FIELD_SEARCH_SELECT's columns when a caller needs more. */
  select?: string;
  /** Only this customer's fields, when given. The caller must clear a chosen field when this changes. */
  customerId?: string | null;
  /** Search only active fields (the default). */
  activeOnly?: boolean;
  excludeIds?: readonly string[];
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

function fieldDetails(field: FieldSearchResult) {
  const parts = [
    field.customer?.farm_name ?? '',
    field.total_acres != null ? `${field.total_acres} ac` : '',
    [field.county, field.state].filter(Boolean).join(', '),
  ].filter(Boolean);
  return parts.length ? <div className="text-xs text-secondary">{parts.join(' · ')}</div> : null;
}

/**
 * Field picker that searches the database by field name as you type, so every
 * field can be found however many there are.
 */
export default function FieldSearchPicker<T extends FieldSearchResult = FieldSearchResult>({
  value,
  selectedLabel,
  onSelect,
  select = FIELD_SEARCH_SELECT,
  customerId,
  activeOnly = true,
  excludeIds,
  placeholder = 'Search fields...',
  ariaLabel = 'Search fields',
  id,
  disabled,
  className,
}: FieldSearchPickerProps<T>) {
  return (
    <RecordSearchPicker<T>
      value={value}
      selectedLabel={selectedLabel}
      onSelect={onSelect}
      search={(pattern, limit) => {
        let query = supabase
          .from('fields')
          .select(select)
          .or(`field_name.ilike.${pattern}`);
        if (activeOnly) query = query.eq('is_active', true);
        if (excludeIds?.length) query = query.not('id', 'in', excludedIdList(excludeIds));
        if (customerId) query = query.eq('customer_id', customerId);
        return query.order('field_name').order('id').limit(limit);
      }}
      searchKey={[activeOnly, customerId ?? '', select, excludeIds?.join(',') ?? ''].join('|')}
      getLabel={(field) => field.field_name}
      renderDetails={fieldDetails}
      noun="fields"
      emptyMessage={activeOnly ? 'No matching active fields' : undefined}
      sentryContext="field_search_picker"
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      id={id}
      disabled={disabled}
      className={className}
    />
  );
}
