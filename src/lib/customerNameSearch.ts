import { supabase } from './db';
import { excludedIdList } from './recordSearch';

// How many matching customers a by-name search of orders or jobs looks through.
// A broader name ("Farm") reaches the rest by typing more or by the record's number.
const CUSTOMER_NAME_MATCH_LIMIT = 50;

/**
 * `.or()` terms that match a record by its own number or its customer's farm name.
 * PostgREST cannot OR across a join, so the matching customers are looked up
 * first and the record is matched on `customer_id`. `pattern` comes from
 * `ilikeOrPattern`. Inactive customers count: their orders and jobs still exist.
 */
export async function numberOrCustomerNameTerms(
  numberColumn: string,
  pattern: string,
  /** The page's own customer, when the search is limited to one: only that name is matched. */
  customerId?: string | null,
): Promise<{ terms: string | null; error: unknown }> {
  let query = supabase
    .from('customers')
    .select('id')
    .or(`farm_name.ilike.${pattern}`);
  if (customerId) query = query.eq('id', customerId);
  const { data, error } = await query
    .order('farm_name')
    .order('id')
    .limit(CUSTOMER_NAME_MATCH_LIMIT);
  if (error) return { terms: null, error };
  const ids = ((data || []) as { id: string }[]).map((c) => c.id);
  const terms = [`${numberColumn}.ilike.${pattern}`];
  if (ids.length) terms.push(`customer_id.in.${excludedIdList(ids)}`);
  return { terms: terms.join(','), error: null };
}
