import { supabase } from './db';
import { localToday } from './dateUtils';

export interface RUPComplianceResult {
  hasRUPProducts: boolean;
  hasValidLicense: boolean;
  expiredLicense: boolean;
  missingLicense: boolean;
  rupProductNames: string[];
  warnings: string[];
  /** A read failed, so nothing is known: never read this as "no RUP products" or "licensed". */
  checkFailed: boolean;
}

// Shown as the warning on New Order, Quote Builder and the delivery screens, which run the check
// when the customer or products change: a reload runs it again.
export const RUP_CHECK_FAILED_MESSAGE =
  'The restricted-use (RUP) license check could not be run. Reload the page to check again.';

/** Shown when a post stops because its RUP check could not run. */
export const RUP_POST_CHECK_FAILED_MESSAGE =
  'The restricted-use (RUP) license check could not be run, so nothing was posted. Try again.';

/**
 * Check if any products in the list are RUP (Restricted Use Pesticide)
 * and whether the customer has a valid applicator license.
 *
 * Returns warnings — does NOT block the transaction. A read that fails, throws, or
 * answers with no list returns `checkFailed` with RUP_CHECK_FAILED_MESSAGE, never a
 * pass; the invoice post paths refuse to open the post confirm on it.
 */
export async function checkRUPCompliance(
  customerId: string,
  productIds: string[]
): Promise<RUPComplianceResult> {
  const result: RUPComplianceResult = {
    hasRUPProducts: false,
    hasValidLicense: false,
    expiredLicense: false,
    missingLicense: false,
    rupProductNames: [],
    warnings: [],
    checkFailed: false,
  };

  if (!productIds.length) return result;

  const failed = (): RUPComplianceResult => ({ ...result, checkFailed: true, warnings: [RUP_CHECK_FAILED_MESSAGE] });

  try {
    // 1. Check which products are RUP
    const { data: rupProducts, error: rupError } = await supabase
      .from('products')
      .select('id, product_name')
      .in('id', productIds)
      .eq('is_rup', true);

    if (rupError || !Array.isArray(rupProducts)) return failed();

    if (!rupProducts.length) return result;

    result.hasRUPProducts = true;
    result.rupProductNames = rupProducts.map((p) => p.product_name);

    // 2. Check customer's applicator license
    // (was `.is('deleted_at', null)` — that column never existed on applicator_licenses,
    // so this query 400'd and the check silently degraded to the generic warning.
    // Live-verified + fixed 2026-06-10 alongside migration 20260610185741.)
    const today = localToday();
    const { data: licenses, error: licenseError } = await supabase
      .from('applicator_licenses')
      .select('id, expiry_date')
      .eq('customer_id', customerId)
      .eq('is_active', true);

    if (licenseError || !Array.isArray(licenses)) return failed();

    if (!licenses.length) {
      result.missingLicense = true;
      result.warnings.push(
        `RUP products (${result.rupProductNames.join(', ')}) require a valid applicator license. No license on file for this customer.`
      );
      return result;
    }

    // Check if any license is currently valid
    const validLicense = licenses.find((l) => l.expiry_date >= today);
    if (validLicense) {
      result.hasValidLicense = true;
      return result;
    }

    // All licenses are expired
    result.expiredLicense = true;
    result.warnings.push(
      `RUP products (${result.rupProductNames.join(', ')}) require a valid applicator license. Customer's license is expired.`
    );

    return result;
  } catch {
    // A thrown read (a dropped connection) is a failed check too, so no caller sees a rejection.
    return failed();
  }
}

export type RUPRegisterDisposition = {
  /** compliance_status generate_rup_sales_records will record for this sale. */
  status: 'non_compliant' | 'warning' | null;
  /** user-facing label matching that status (null = nothing to record). */
  label: 'NON-COMPLIANT' | 'WARNING' | null;
};

/**
 * Classify what the RUP sales register will record, MATCHING the server semantics
 * in generate_rup_sales_records (migration 20260610185741):
 *   - missing license -> non_compliant  (label NON-COMPLIANT)
 *   - expired license -> warning        (label WARNING — flagged, NOT non-compliant)
 *   - valid / no RUP   -> nothing to record
 * Keep this in lockstep with that SQL CASE so the point-of-sale warning never
 * overstates the recorded disposition (#6, 2026-06-13 overlapping-sessions recovery).
 * A `checkFailed` result has no disposition: callers stop before asking for one.
 */
export function rupRegisterDisposition(res: RUPComplianceResult): RUPRegisterDisposition {
  if (res.checkFailed || !res.hasRUPProducts || res.hasValidLicense) return { status: null, label: null };
  if (res.missingLicense) return { status: 'non_compliant', label: 'NON-COMPLIANT' };
  return { status: 'warning', label: 'WARNING' };
}
