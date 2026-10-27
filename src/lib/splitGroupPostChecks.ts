import { supabaseUntyped } from './db';
import { checkRUPCompliance, rupRegisterDisposition, RUP_POST_CHECK_FAILED_MESSAGE } from './rupCompliance';
import { CREDIT_LIMIT_UNVERIFIED_MESSAGE, evaluateCreditLimit } from './creditLimitGuard';
import { Sentry } from './sentry';

// The group read (or a check) failed, so neither the RUP nor the credit check ran.
export const GROUP_CHECKS_FAILED_MESSAGE = 'The license and credit checks could not be run, so nothing was posted. Try again.';

export type SplitGroupPostCheck =
  | { ok: true; warning: string | null }
  /** A check could not run: show `message` and do not open the post confirm. */
  | { ok: false; message: string };

type GroupMember = {
  invoice_number: string;
  customer_id: string | null;
  total_amount_cents: number | null;
  invoice_items: { product_id: string | null }[] | null;
};

// A member's check could not run.
export const GROUP_CHECK_FAILED = Symbol('check failed');

/** The parts of a split-group member the RUP check reads. */
export type GroupMemberRupInput = Pick<GroupMember, 'invoice_number' | 'customer_id' | 'invoice_items'>;

/**
 * The member's RUP finding for the post warning, null when there is none, GROUP_CHECK_FAILED when
 * the check could not run. Shared by the Split Billing editor and Invoice Detail's grouped Post.
 */
export async function groupMemberRupFinding(inv: GroupMemberRupInput): Promise<string | null | typeof GROUP_CHECK_FAILED> {
  // A member's lines that came back missing are unread, not "no products".
  if (!Array.isArray(inv.invoice_items)) return GROUP_CHECK_FAILED;
  const pids = inv.invoice_items.map((x) => x.product_id).filter((p): p is string => Boolean(p));
  if (pids.length === 0) return null;
  // Products with no customer to check a license for is not a pass.
  if (!inv.customer_id) return GROUP_CHECK_FAILED;
  const res = await checkRUPCompliance(inv.customer_id, pids);
  if (res.checkFailed) return GROUP_CHECK_FAILED;
  if (!res.hasRUPProducts || res.hasValidLicense) return null;
  const disp = rupRegisterDisposition(res);
  return `${inv.invoice_number}: ${res.rupProductNames.join(', ')} — ${res.missingLicense ? 'NO applicator license' : 'EXPIRED license'} (${disp.label})`;
}

/** The member's invoice number when it puts its customer over the limit, null when it does not. */
async function creditFinding(inv: GroupMember): Promise<string | null | typeof GROUP_CHECK_FAILED> {
  if (!inv.customer_id || Number(inv.total_amount_cents ?? 0) <= 0) return null;
  const credit = await evaluateCreditLimit({ customerId: inv.customer_id, newAmountCents: Number(inv.total_amount_cents) });
  if (credit.status === 'unverified') return GROUP_CHECK_FAILED;
  return credit.status === 'over' ? inv.invoice_number : null;
}

function groupWarning(rupParts: string[], creditParts: string[]): string | null {
  const bits: string[] = [];
  if (rupParts.length > 0) bits.push(`Restricted-use products without a valid license — ${rupParts.join('; ')}. These will be recorded in the RUP sales register.`);
  if (creditParts.length > 0) bits.push(`Over credit limit: invoice(s) ${creditParts.join(', ')}.`);
  return bits.length > 0 ? `Posting this group posts every invoice in it. ${bits.join(' ')}` : null;
}

/**
 * Codex round-8 P2: mirror the normal invoice post flow's guardrails BEFORE confirming the post.
 * post_invoice_group posts EVERY co-owner child, so the credit-limit + RUP-license advisories must
 * cover the WHOLE group. A finding is a warning on the confirm, never a gate (parity with
 * InvoiceDetail). A check that could not run (To-Do 10.5 follow-up) is `ok: false`: it used to
 * fall through to a clean-looking confirm.
 */
export async function checkSplitGroupBeforePost(invoiceGroupId: string | null): Promise<SplitGroupPostCheck> {
  try {
    const { data: grp, error: grpError } = await supabaseUntyped
      .from('invoices')
      .select('id, invoice_number, customer_id, total_amount_cents, invoice_items(product_id)')
      .eq('invoice_group_id', invoiceGroupId)
      .is('deleted_at', null)
      .not('invoice_group_id', 'is', null);
    // A loaded group always has members, so an empty answer means nothing was checked.
    if (grpError || !Array.isArray(grp) || grp.length === 0) return { ok: false, message: GROUP_CHECKS_FAILED_MESSAGE };
    const rupParts: string[] = [];
    const creditParts: string[] = [];
    for (const inv of grp as GroupMember[]) {
      const rup = await groupMemberRupFinding(inv);
      if (rup === GROUP_CHECK_FAILED) return { ok: false, message: RUP_POST_CHECK_FAILED_MESSAGE };
      if (rup) rupParts.push(rup);
      const credit = await creditFinding(inv);
      if (credit === GROUP_CHECK_FAILED) return { ok: false, message: `${CREDIT_LIMIT_UNVERIFIED_MESSAGE} Nothing was posted.` };
      if (credit) creditParts.push(credit);
    }
    return { ok: true, warning: groupWarning(rupParts, creditParts) };
  } catch (err) {
    // A check that threw never ran, so it stops rather than opening a clean-looking confirm.
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'split_post_guardrails' } });
    return { ok: false, message: GROUP_CHECKS_FAILED_MESSAGE };
  }
}
