import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import { Sentry } from '../../lib/sentry';
import { useToast } from './Toast';
import { useLatestRef } from '../../hooks/useLatestRef';
import { ilikeOrPattern } from '../../lib/recordSearch';

const RECORD_SEARCH_LIMIT = 20;
// A search with no reply by then is shown as failed (with Retry) instead of "Searching..." forever.
const RECORD_SEARCH_TIMEOUT_MS = 15_000;
// One character is enough: a record named "A" must be reachable (Codex review, #1017).
// A broad one-letter search still returns only the first 20, with the "keep typing" note.
const MIN_QUERY_LENGTH = 1;

export interface RecordSearchPickerProps<T extends { id: string }> {
  /** Selected record id, or '' for none. */
  value: string;
  /** Name shown for the selected record; the caller keeps it so a record is labelled without a list. */
  selectedLabel: string;
  /**
   * Called with the picked record, or null when the selection is cleared.
   * Return `false` to refuse it; the box then keeps the previous label.
   */
  onSelect: (record: T | null) => void | boolean;
  /**
   * Runs one database search. `pattern` is already quoted for `.or()` (see
   * `ilikeOrPattern`); the query must end with `.limit(limit)`. Exclusions
   * belong in the query, not after the limit, so 20 eligible records come back.
   */
  search: (pattern: string, limit: number) => PromiseLike<{ data: unknown; error: unknown }>;
  /**
   * Everything the search depends on besides the typed text (active-only,
   * customer, exclusions...). A change drops the shown results and searches
   * again, so a record matching the old conditions can never be picked.
   */
  searchKey?: string;
  getLabel: (record: T) => string;
  renderDetails?: (record: T) => ReactNode;
  /** Plural noun for messages, e.g. "products" -> "Product search failed", "No matching products". */
  noun: string;
  /** Overrides the "No matching ..." line, e.g. "No matching active products". */
  emptyMessage?: string;
  sentryContext: string;
  placeholder?: string;
  ariaLabel: string;
  clearLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function singular(noun: string): string {
  return noun.endsWith('s') ? noun.slice(0, -1) : noun;
}

/**
 * A picker that searches the database as you type, so every record can be
 * found however many there are (Goal 4: pickers never stop at a row limit).
 * It loads nothing up front; the caller passes the selected record's label.
 * A failed search says so instead of looking like "no matches".
 */
export default function RecordSearchPicker<T extends { id: string }>({
  value,
  selectedLabel,
  onSelect,
  search,
  searchKey = '',
  getLabel,
  renderDetails,
  noun,
  emptyMessage,
  sentryContext,
  placeholder,
  ariaLabel,
  clearLabel,
  id,
  disabled = false,
  className = '',
}: RecordSearchPickerProps<T>) {
  const { toast } = useToast();
  const listId = `${useId()}-record-results`;
  const [query, setQuery] = useState(selectedLabel);
  const [isOpen, setIsOpen] = useState(false);
  const [results, setResults] = useState<T[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [retryCount, setRetryCount] = useState(0);
  // The conditions + text the shown results (or failure) belong to; until they match, the list says "Searching...".
  const [searchedFor, setSearchedFor] = useState('');
  const requestRef = useRef(0);
  const failureToastShownRef = useRef(false);
  // The search callback is usually an inline arrow; keep the latest without re-running the effect.
  const searchRef = useLatestRef(search);
  // True once the user has typed since the box last took the selected record's name. Only typed
  // text may clear a choice; an untouched box follows a late label instead (Codex review, #1017).
  const editedRef = useRef(false);

  // Follow the parent's label while the box is closed or untouched, so a late label never
  // overwrites typing but still fills a box the user has not typed in.
  useEffect(() => {
    if (!isOpen || !editedRef.current) setQuery(selectedLabel);
  }, [selectedLabel, value, isOpen]);

  // A reply that lands after the box is disabled or gone must not touch it.
  useEffect(() => {
    if (disabled) requestRef.current += 1;
  }, [disabled]);
  useEffect(() => () => { requestRef.current += 1; }, []);

  const runSearch = useCallback(async (q: string, key: string) => {
    const requestId = ++requestRef.current;
    if (q.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setSearching(false);
      setSearchFailed(false);
      return;
    }
    setSearching(true);
    const searched = `${key}\u0000${q}`;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Record search timed out after ${RECORD_SEARCH_TIMEOUT_MS} ms`)), RECORD_SEARCH_TIMEOUT_MS);
      });
      const { data, error } = await Promise.race([
        Promise.resolve(searchRef.current(ilikeOrPattern(q), RECORD_SEARCH_LIMIT)),
        timedOut,
      ]).finally(() => clearTimeout(timer));
      if (requestId !== requestRef.current) return;
      if (error) throw error;
      setResults((data || []) as T[]);
      setSearchFailed(false);
      setSearchedFor(searched);
      failureToastShownRef.current = false;
    } catch (error) {
      if (requestId !== requestRef.current) return;
      Sentry.captureException(error, { extra: { context: sentryContext } });
      // One toast per run of failures; the inline alert covers each later keystroke.
      if (!failureToastShownRef.current) toast('error', `Failed to search ${capitalize(noun)}`);
      failureToastShownRef.current = true;
      setResults([]);
      setSearchFailed(true);
      setSearchedFor(searched);
    } finally {
      if (requestId === requestRef.current) setSearching(false);
    }
  }, [toast, noun, sentryContext, searchRef]);

  // Only search while the text differs from the selected record's name.
  const term = isOpen && !disabled && query !== selectedLabel ? query.trim() : '';
  useEffect(() => {
    const t = setTimeout(() => runSearch(term, searchKey), 200);
    return () => clearTimeout(t);
  }, [term, searchKey, retryCount, runSearch]);

  const select = (record: T) => {
    requestRef.current += 1;
    editedRef.current = false;
    setResults([]);
    // Forget the old search too, or retyping the same text shows its stale "no matches" or failure.
    setSearchedFor('');
    setSearchFailed(false);
    setIsOpen(false);
    if (onSelect(record) === false) {
      setQuery(selectedLabel);
      return;
    }
    setQuery(getLabel(record));
  };

  const clear = () => {
    requestRef.current += 1;
    editedRef.current = false;
    setResults([]);
    // Forget the old search too, or retyping the same text shows its stale "no matches" or failure.
    setSearchedFor('');
    setSearchFailed(false);
    setIsOpen(false);
    if (value && onSelect(null) === false) {
      setQuery(selectedLabel);
      return;
    }
    setQuery('');
  };

  const retry = () => {
    setSearchedFor('');
    setRetryCount((n) => n + 1);
  };

  const handleBlur = () => {
    // Only text the user emptied clears the choice; a label still loading (or that failed
    // to load, or that arrived while the box had focus) must not drop the saved record.
    if (editedRef.current && !query.trim()) {
      clear();
      return;
    }
    editedRef.current = false;
    setQuery(selectedLabel);
    setIsOpen(false);
  };

  const showList = isOpen && !disabled && term.length >= MIN_QUERY_LENGTH;
  // The box is open but there is nothing to search yet (empty or one character).
  const showHint = isOpen && !disabled && !showList && query !== selectedLabel;
  // Results count only for the conditions and text now in effect; earlier results are never shown or pickable.
  const resultsCurrent = !searching && `${searchKey}\u0000${term}` === searchedFor;
  const options = resultsCurrent && !searchFailed ? results : [];

  // A shorter result list must not leave the highlight past its end.
  useEffect(() => {
    setHighlightedIndex((i) => Math.min(i, Math.max(options.length - 1, 0)));
  }, [options.length]);

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
      editedRef.current = false;
      setQuery(selectedLabel);
      setIsOpen(false);
    }
  };

  return (
    <div className={`relative ${className}`.trim()}>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input
          id={id}
          type="text"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={showList}
          aria-controls={showList && options.length > 0 ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={showList && options[highlightedIndex] ? `${listId}-option-${highlightedIndex}` : undefined}
          value={query}
          disabled={disabled}
          onChange={(e) => { editedRef.current = true; setQuery(e.target.value); setIsOpen(true); setHighlightedIndex(0); }}
          onFocus={(e) => { setIsOpen(true); e.currentTarget.select(); }}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? `Search ${noun}...`}
          className="w-full pl-9 pr-9 py-2 text-base md:text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50 disabled:text-gray-500"
        />
        {value && !disabled && (
          <button
            type="button"
            aria-label={clearLabel ?? `Clear ${singular(noun)}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={clear}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      {showHint && (
        <div role="status" aria-live="polite" className="absolute z-30 w-full min-w-[280px] mt-1 bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-sm text-secondary">
          Type to search
        </div>
      )}
      {showList && (
        <div className="absolute z-30 w-full min-w-[280px] mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-72 overflow-y-auto">
          {/* Status messages sit outside the listbox, which holds only options. */}
          {!resultsCurrent ? (
            <div role="status" aria-live="polite" className="px-3 py-2 text-sm text-secondary">Searching...</div>
          ) : searchFailed ? (
            <div role="alert" className="px-3 py-2 text-sm text-red-600 flex items-center justify-between gap-2">
              <span>{capitalize(singular(noun))} search failed.</span>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={retry}
                className="text-sm font-medium text-red-700 underline hover:text-red-800"
              >
                Retry
              </button>
            </div>
          ) : options.length === 0 ? (
            <div role="status" aria-live="polite" className="px-3 py-2 text-sm text-secondary">{emptyMessage ?? `No matching ${noun}`}</div>
          ) : (
            <>
              <div id={listId} role="listbox" aria-label={ariaLabel}>
              {options.map((record, index) => (
                <button
                  id={`${listId}-option-${index}`}
                  key={record.id}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={record.id === value}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => select(record)}
                  className={`w-full text-left px-3 py-2 ${index === highlightedIndex ? 'bg-gray-50' : 'hover:bg-gray-50'}`}
                >
                  <div className="text-sm font-medium text-nav-dark">{getLabel(record)}</div>
                  {renderDetails?.(record)}
                </button>
              ))}
              </div>
              {results.length === RECORD_SEARCH_LIMIT && (
                <div role="status" className="px-3 py-2 text-xs text-secondary border-t border-gray-100">
                  Showing the first {RECORD_SEARCH_LIMIT} matches. Keep typing to narrow the list.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
