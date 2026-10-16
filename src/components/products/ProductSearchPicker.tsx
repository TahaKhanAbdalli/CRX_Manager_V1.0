import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { useToast } from '../ui/Toast';
import { ProductOptionDetails } from './ProductOptionPresentation';
import type { ProductSearchResult } from '../../types';

const PRODUCT_SEARCH_SELECT =
  'id, product_name, sku, unit_size, packaging_variant, container_size, container_unit, inventory_unit, return_policy, is_full_tote_only, rate_unit, rate_per_acre, product_family:product_families(name)';
export const PRODUCT_SEARCH_LIMIT = 20;
const MIN_QUERY_LENGTH = 2;

/**
 * Quote a search term for a PostgREST `or=(...)` filter. Product names such as
 * "2,4-D" contain commas and parentheses, which would otherwise end the filter
 * early. Typed `%`, `_` and `\` are first escaped for ILIKE (so "100%" matches
 * literally), then `\` and `"` are escaped for the PostgREST quotes.
 */
function productSearchPattern(q: string): string {
  const likeEscaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  const quoted = likeEscaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"%${quoted}%"`;
}

interface ProductSearchPickerProps {
  /** Selected product id, or '' for none. */
  value: string;
  /** Name shown for the selected product; the caller keeps it so a product is labelled without a list. */
  selectedLabel: string;
  /** Called with the picked product, or null when the selection is cleared. */
  onSelect: (product: ProductSearchResult | null) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}

/**
 * Active-product picker that searches the database as you type (the Invoice
 * product search pattern), so every active product can be found however many
 * there are. A failed search says so instead of looking like "no matches".
 */
export default function ProductSearchPicker({
  value,
  selectedLabel,
  onSelect,
  placeholder = 'Search products...',
  ariaLabel = 'Search products',
  className = '',
}: ProductSearchPickerProps) {
  const { toast } = useToast();
  const listId = `${useId()}-product-results`;
  const [query, setQuery] = useState(selectedLabel);
  const [isOpen, setIsOpen] = useState(false);
  const [results, setResults] = useState<ProductSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  // The text the shown results (or failure) belong to; until it matches, the list says "Searching...".
  const [searchedTerm, setSearchedTerm] = useState('');
  const requestRef = useRef(0);
  const failureToastShownRef = useRef(false);

  useEffect(() => {
    setQuery(selectedLabel);
  }, [selectedLabel, value]);

  const searchProducts = useCallback(async (q: string) => {
    const requestId = ++requestRef.current;
    if (q.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setSearching(false);
      setSearchFailed(false);
      return;
    }
    setSearching(true);
    try {
      const pattern = productSearchPattern(q);
      const { data, error } = await supabase
        .from('products')
        .select(PRODUCT_SEARCH_SELECT)
        .eq('is_active', true)
        .or(`product_name.ilike.${pattern},sku.ilike.${pattern}`)
        .order('product_name')
        .limit(PRODUCT_SEARCH_LIMIT);
      if (requestId !== requestRef.current) return;
      if (error) throw error;
      setResults((data || []) as unknown as ProductSearchResult[]);
      setSearchFailed(false);
      setSearchedTerm(q);
      failureToastShownRef.current = false;
    } catch (error) {
      if (requestId !== requestRef.current) return;
      Sentry.captureException(error, { extra: { context: 'product_search_picker' } });
      // One toast per run of failures; the inline alert covers each later keystroke.
      if (!failureToastShownRef.current) toast('error', 'Failed to search Products');
      failureToastShownRef.current = true;
      setResults([]);
      setSearchFailed(true);
      setSearchedTerm(q);
    } finally {
      if (requestId === requestRef.current) setSearching(false);
    }
  }, [toast]);

  // Only search while the text differs from the selected product's name.
  const term = isOpen && query !== selectedLabel ? query.trim() : '';
  useEffect(() => {
    const t = setTimeout(() => searchProducts(term), 200);
    return () => clearTimeout(t);
  }, [term, searchProducts]);

  const select = (product: ProductSearchResult) => {
    requestRef.current += 1;
    onSelect(product);
    setQuery(product.product_name);
    setResults([]);
    setIsOpen(false);
  };

  const clear = () => {
    requestRef.current += 1;
    setQuery('');
    setResults([]);
    setIsOpen(false);
    if (value) onSelect(null);
  };

  const handleBlur = () => {
    if (!query.trim()) {
      clear();
      return;
    }
    setQuery(selectedLabel);
    setIsOpen(false);
  };

  const showList = isOpen && term.length >= MIN_QUERY_LENGTH;
  // Results count only for the text now in the box; earlier results are never shown or pickable.
  const resultsCurrent = !searching && term === searchedTerm;
  const options = resultsCurrent && !searchFailed ? results : [];

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIsOpen(true);
      setHighlightedIndex((i) => Math.max(0, Math.min(i + 1, options.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter') {
      if (!showList || !options[highlightedIndex]) return;
      event.preventDefault();
      select(options[highlightedIndex]);
    } else if (event.key === 'Escape') {
      setQuery(selectedLabel);
      setIsOpen(false);
    }
  };

  return (
    <div className={`relative ${className}`.trim()}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input
          type="text"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={showList}
          aria-controls={showList && options.length > 0 ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={showList && options[highlightedIndex] ? `${listId}-option-${highlightedIndex}` : undefined}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setIsOpen(true); setHighlightedIndex(0); }}
          onFocus={() => setIsOpen(true)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="w-full pl-9 pr-9 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
        />
        {value && (
          <button
            type="button"
            aria-label="Clear product"
            onMouseDown={(e) => e.preventDefault()}
            onClick={clear}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      {showList && (
        <div className="absolute z-30 w-full min-w-[280px] mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-72 overflow-y-auto">
          {/* Status messages sit outside the listbox, which holds only options. */}
          {!resultsCurrent ? (
            <div role="status" aria-live="polite" className="px-3 py-2 text-sm text-secondary">Searching...</div>
          ) : searchFailed ? (
            <div role="alert" className="px-3 py-2 text-sm text-red-600">Product search failed. Edit the search text to try again.</div>
          ) : options.length === 0 ? (
            <div role="status" aria-live="polite" className="px-3 py-2 text-sm text-secondary">No matching active products</div>
          ) : (
            <>
              <div id={listId} role="listbox" aria-label={ariaLabel}>
              {options.map((product, index) => (
                <button
                  id={`${listId}-option-${index}`}
                  key={product.id}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={product.id === value}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => select(product)}
                  className={`w-full text-left px-3 py-2 ${index === highlightedIndex ? 'bg-gray-50' : 'hover:bg-gray-50'}`}
                >
                  <div className="text-sm font-medium text-nav-dark">{product.product_name}</div>
                  <ProductOptionDetails product={product} />
                </button>
              ))}
              </div>
              {options.length === PRODUCT_SEARCH_LIMIT && (
                <div role="status" className="px-3 py-2 text-xs text-secondary border-t border-gray-100">
                  Showing the first {PRODUCT_SEARCH_LIMIT} matches. Keep typing to narrow the list.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
