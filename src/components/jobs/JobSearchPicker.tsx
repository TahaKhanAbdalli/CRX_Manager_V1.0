import { supabase } from '../../lib/db';
import RecordSearchPicker from '../ui/RecordSearchPicker';
import { excludedIdList } from '../../lib/recordSearch';
import { numberOrCustomerNameTerms } from '../../lib/customerNameSearch';
import { jobSearchLabel } from '../../lib/recordLabels';
import type { JobStatus } from '../../types';

// A fixed column list: jobs is a cost table, so screens never read a caller-built one.
export const JOB_SEARCH_SELECT = 'id, job_number, job_date, status, customer_id, customer:customers(farm_name)';

export interface JobSearchResult {
  id: string;
  job_number: string;
  job_date?: string | null;
  status: JobStatus;
  customer_id?: string;
  customer?: { farm_name?: string | null } | null;
}

interface JobSearchPickerProps<T extends JobSearchResult = JobSearchResult> {
  /** Selected job id, or '' for none. */
  value: string;
  /** Label shown for the selected job; the caller keeps it so no job list is needed. */
  selectedLabel: string;
  /** Called with the picked job (the columns in `select`), or null when cleared. */
  onSelect: (job: T | null) => void | boolean;
  /** Only jobs in these statuses, when given, as the old list loaded. Deleted jobs are never offered. */
  statuses?: readonly JobStatus[];
  /** Only this customer's jobs, when given. The caller must clear a chosen job when this changes. */
  customerId?: string | null;
  excludeIds?: readonly string[];
  placeholder?: string;
  ariaLabel?: string;
  clearLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

function jobDetails(job: JobSearchResult) {
  return <div className="text-xs text-secondary">{job.status.replace('_', ' ')}</div>;
}

/**
 * Job picker that searches the database by job number or customer name as you
 * type, so every job can be found however many there are.
 */
export default function JobSearchPicker<T extends JobSearchResult = JobSearchResult>({
  value,
  selectedLabel,
  onSelect,
  statuses,
  customerId,
  excludeIds,
  placeholder = 'Search by job # or customer...',
  ariaLabel = 'Search jobs',
  clearLabel,
  id,
  disabled,
  className,
}: JobSearchPickerProps<T>) {
  return (
    <RecordSearchPicker<T>
      value={value}
      selectedLabel={selectedLabel}
      onSelect={onSelect}
      search={async (pattern, limit) => {
        const { terms, error } = await numberOrCustomerNameTerms('job_number', pattern, customerId);
        if (error || !terms) return { data: null, error };
        let query = supabase
          .from('jobs')
          .select(JOB_SEARCH_SELECT)
          .or(terms)
          .is('deleted_at', null);
        // An empty list offers nothing, never every status.
        if (statuses) query = query.in('status', [...statuses]);
        if (customerId) query = query.eq('customer_id', customerId);
        if (excludeIds?.length) query = query.not('id', 'in', excludedIdList(excludeIds));
        return query.order('job_date', { ascending: false }).order('id').limit(limit);
      }}
      searchKey={[statuses ? `in:${statuses.join(',')}` : 'any', customerId ?? '', excludeIds?.join(',') ?? ''].join('|')}
      getLabel={jobSearchLabel}
      renderDetails={jobDetails}
      noun="jobs"
      sentryContext="job_search_picker"
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      clearLabel={clearLabel}
      id={id}
      disabled={disabled}
      className={className}
    />
  );
}
