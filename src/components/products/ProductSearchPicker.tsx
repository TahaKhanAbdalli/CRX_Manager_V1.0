import { supabase } from '../../lib/db';
import RecordSearchPicker, { RECORD_SEARCH_LIMIT } from '../ui/RecordSearchPicker';
import { ProductOptionDetails } from './ProductOptionPresentation';
import type { ProductSearchResult } from '../../types';

export const PRODUCT_SEARCH_SELECT =
  'id, product_name, sku, unit_size, packaging_variant, container_size, container_unit, inventory_unit, return_policy, is_full_tote_only, rate_unit, rate_per_acre, product_form, product_family:product_families(name)';
export const PRODUCT_SEARCH_LIMIT = RECORD_SEARCH_LIMIT;

interface ProductSearchPickerProps<T extends ProductSearchResult = ProductSearchResult> {
  /** Selected product id, or '' for none. */
  value: string;
  /** Name shown for the selected product; the caller keeps it so a product is labelled without a list. */
  selectedLabel: string;
  /** Called with the picked product, or null when the selection is cleared. */
  onSelect: (product: T | null) => void | boolean;
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Active-product picker that searches the database as you type (the Invoice
 * product search pattern), so every active product can be found however many
 * there are. A failed search says so instead of looking like "no matches".
 */
export default function ProductSearchPicker<T extends ProductSearchResult = ProductSearchResult>({
  value,
  selectedLabel,
  onSelect,
  placeholder = 'Search products...',
  ariaLabel = 'Search products',
  id,
  disabled,
  className,
}: ProductSearchPickerProps<T>) {
  return (
    <RecordSearchPicker<T>
      value={value}
      selectedLabel={selectedLabel}
      onSelect={onSelect}
      search={(pattern, limit) => supabase
        .from('products')
        .select(PRODUCT_SEARCH_SELECT)
        .eq('is_active', true)
        .or(`product_name.ilike.${pattern},sku.ilike.${pattern}`)
        .order('product_name')
        .order('id')
        .limit(limit)}
      getLabel={(product) => product.product_name}
      renderDetails={(product) => <ProductOptionDetails product={product} />}
      noun="products"
      emptyMessage="No matching active products"
      sentryContext="product_search_picker"
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      id={id}
      disabled={disabled}
      className={className}
    />
  );
}
