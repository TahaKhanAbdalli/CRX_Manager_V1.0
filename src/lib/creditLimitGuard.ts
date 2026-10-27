import { assertRpcResult, supabase, supabaseUntyped } from './db';
import { formatCents } from './money';
import { Sentry } from './sentry';
import type { CustomerCreditExposure } from '../types';

export interface CreditLimitParams {
  customerId: string;
  newAmountCents: number;
}

export type CreditLimitResult =
  | { status: 'ok' }
  | { status: 'over'; message: string }
  /** A read failed: the limit is unknown, never a pass. */
  | { status: 'unverified' };

export const CREDIT_LIMIT_UNVERIFIED_MESSAGE =
  'Could not verify credit limit. Please refresh and try again before completing this transaction.';

/**
 * The customer's credit limit and whole open exposure in cents, from customer_credit_exposure
 * (draft, unposted, posted and overdue invoices, not deleted, no negative balances). The server
 * reads every rep's invoices: a sales rep's own read only sees the invoices they created or sell,
 * so a draft or invoice held by another rep made the customer look under the limit (Sol on #1132).
 * Throws when the answer is not a whole-cent amount.
 */
async function creditExposure(customerId: string): Promise<{ limitCents: number | null; exposureCents: number }> {
  // Not in the generated database types yet (added by #1138).
  const { data, error } = await supabaseUntyped.rpc('customer_credit_exposure', { p_customer_id: customerId });
  if (error) throw error;
  const result = assertRpcResult<Partial<CustomerCreditExposure>>(data, 'customer_credit_exposure');
  const exposureCents = result.exposure_cents;
  if (typeof exposureCents !== 'number' || !Number.isSafeInteger(exposureCents) || exposureCents < 0) {
    throw new Error('customer_credit_exposure returned no usable exposure.');
  }
  // Only an explicit null is "no limit" (the server returns a stored 0 or negative limit as null);
  // a missing field is an answer nobody can trust. Anything else must be positive whole cents.
  if (!('credit_limit_cents' in result)) throw new Error('customer_credit_exposure returned no credit limit field.');
  const limitCents = result.credit_limit_cents;
  if (limitCents !== null && (typeof limitCents !== 'number' || !Number.isSafeInteger(limitCents) || limitCents <= 0)) {
    throw new Error('customer_credit_exposure returned a credit limit that is not whole cents.');
  }
  return { limitCents, exposureCents };
}

/** The customer's name for the warning. The warning still shows if this read fails. */
async function customerName(customerId: string): Promise<string> {
  const { data } = await supabase.from('customers').select('farm_name').eq('id', customerId).maybeSingle()
    .then((r) => r, () => ({ data: null }));
  return data?.farm_name || 'This customer';
}

/**
 * Whether a new amount keeps the customer within their credit limit. A read that fails, or
 * answers with no usable limit or exposure, is `unverified` — the old code read a failed customer
 * read as "no limit set" and passed.
 */
export async function evaluateCreditLimit({ customerId, newAmountCents }: CreditLimitParams): Promise<CreditLimitResult> {
  // An amount that is not whole cents cannot be compared to the limit, so it is never a pass.
  if (!Number.isSafeInteger(newAmountCents)) return { status: 'unverified' };
  if (!customerId || newAmountCents <= 0) return { status: 'ok' };

  try {
    const { limitCents, exposureCents } = await creditExposure(customerId);
    if (limitCents === null) return { status: 'ok' };

    const overBy = exposureCents + newAmountCents - limitCents;
    if (overBy > 0) {
      const name = await customerName(customerId);
      return {
        status: 'over',
        message: `This will put ${name} ${formatCents(overBy)} over their ${formatCents(limitCents)} credit limit.`,
      };
    }
    return { status: 'ok' };
  } catch (error) {
    Sentry.captureException(error, { tags: { guardrail: 'credit_limit' } });
    return { status: 'unverified' };
  }
}
