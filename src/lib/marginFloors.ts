import { assertRpcResult, hasRpcCode, RpcErrorCodes, supabase } from './db';
import { sanitizeError } from './errorSanitizer';
import { fetchAllRows, pageWithList } from './pagedRead';
import type { ProductMarginFloorChange } from '../types';

/**
 * Per-product net-margin floors (To-Do 0.2; Mason, 2026-10-14: per product, no company-wide
 * default). A floor is a ratio like Product.tier1_margin, so a tier is under its floor when its net
 * margin is below it. Admin-only: margin is admin-only (Mason, 2026-10-15).
 */

/** What an admin may type: 0 to 99.99, at most two decimals. */
const FLOOR_PERCENT_PATTERN = /^\d{1,2}(\.\d{1,2})?$/;

/** Parse a typed percent ("12.5") for the database; '' clears the floor. Throws on anything else. */
export function parseMarginFloorPercent(input: string): number | null {
  const text = input.trim();
  if (text === '') return null;
  if (!FLOOR_PERCENT_PATTERN.test(text)) {
    throw new Error('A margin floor is a percent from 0 to 99.99, with at most two decimals.');
  }
  // Sent as a JSON number; the database divides by 100 exactly, so 14.3 stays 0.143.
  return Number(text);
}

/** A stored floor ratio as the percent an admin typed (0.143 -> "14.3"). */
export function formatMarginFloorPercent(floor: number | null | undefined): string {
  if (floor == null) return '';
  return String(Number((floor * 100).toFixed(2)));
}

/** True when a tier's stored net margin is below the product's floor. No floor or no margin: false. */
export function isUnderMarginFloor(margin: number | null | undefined, floor: number | null | undefined): boolean {
  if (margin == null || floor == null) return false;
  return margin < floor;
}

/**
 * A tier's net margin as a percent: one decimal normally, two when under its floor. A flagged margin
 * never rounds up to the floor (14.996% under 15% reads "14.99", not "15.00"). Compared in whole
 * hundredths because 0.15 * 100 is 15.000000000000002 in floating point.
 */
export function formatNetMarginPercent(margin: number, floor: number | null | undefined): string {
  if (floor == null || !isUnderMarginFloor(margin, floor)) return (margin * 100).toFixed(1);
  const floorHundredths = Math.round(floor * 10000);
  const hundredths = Math.min(Math.round(margin * 10000), floorHundredths - 1);
  return (hundredths / 100).toFixed(2);
}

/** Every product's floor, by product id. Products without a floor are absent. */
export async function fetchMarginFloors(): Promise<Map<string, number>> {
  const { data, error } = await fetchAllRows<{ product_id: string; margin_floor: number }>((from, to) =>
    pageWithList(supabase
      .from('product_margin_floors')
      .select('product_id, margin_floor', { count: 'exact' })
      .order('product_id')
      .range(from, to)));
  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.product_id, Number(row.margin_floor)]));
}

/** One product's floor, or null when it has none. */
export async function fetchMarginFloor(productId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('product_margin_floors')
    .select('margin_floor')
    .eq('product_id', productId)
    .maybeSingle();
  if (error) throw error;
  return data ? Number(data.margin_floor) : null;
}

export type MarginFloorHistoryEntry = ProductMarginFloorChange & { changed_by_name: string | null };

/** A product's floor history, newest first, with who made each change. */
export async function fetchMarginFloorHistory(productId: string, limit = 10): Promise<MarginFloorHistoryEntry[]> {
  const { data, error } = await supabase
    .from('product_margin_floor_changes')
    .select('id, product_id, old_margin_floor, new_margin_floor, reason, changed_by, created_at')
    .eq('product_id', productId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const changes = (data ?? []) as ProductMarginFloorChange[];
  // Names come from the public profile view; a failed lookup only leaves the names out.
  const ids = [...new Set(changes.map((c) => c.changed_by).filter((id): id is string => !!id))];
  const nameById = new Map<string, string>();
  if (ids.length > 0) {
    const { data: people } = await supabase.from('profile_public_view').select('id, full_name').in('id', ids);
    for (const person of (people ?? []) as Array<{ id: string; full_name: string | null }>) {
      if (person.full_name) nameById.set(person.id, person.full_name);
    }
  }
  return changes.map((c) => ({ ...c, changed_by_name: c.changed_by ? nameById.get(c.changed_by) ?? null : null }));
}

export interface MarginFloorChange {
  productId: string;
  /** Percent (12.5 = 12.5%), or null to clear the floor. */
  marginFloorPercent: number | null;
}

export interface SetMarginFloorsResult {
  success: true;
  status: 'saved';
  changed_count: number;
  unchanged_count: number;
}

export async function setMarginFloors(input: {
  changes: MarginFloorChange[];
  reason: string;
  performedBy: string;
  idempotencyKey: string;
}): Promise<SetMarginFloorsResult> {
  const { data, error } = await supabase.rpc('set_product_margin_floors', {
    p_items: input.changes.map((change) => ({
      product_id: change.productId,
      margin_floor_percent: change.marginFloorPercent,
    })),
    p_reason: input.reason.trim() || undefined,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  return assertRpcResult<SetMarginFloorsResult>(data, 'set_product_margin_floors');
}

// The database's refusals, each before it writes anything, in plain English. Built on use, not at
// import, so a page that never saves a floor does not depend on the error-code table.
const refusalMessages = (): ReadonlyArray<[(typeof RpcErrorCodes)[keyof typeof RpcErrorCodes], string]> => [
  [RpcErrorCodes.MARGIN_FLOOR_PERCENT_INVALID, 'A margin floor is a percent from 0 to 99.99, with at most two decimals.'],
  [RpcErrorCodes.MARGIN_FLOOR_PERCENT_REQUIRED, 'A margin floor is missing. Refresh and try again.'],
  [RpcErrorCodes.MARGIN_FLOOR_PRODUCT_NOT_FOUND, 'One of these products no longer exists. Refresh and try again.'],
  [RpcErrorCodes.MARGIN_FLOOR_PRODUCT_DUPLICATE, 'A product appears twice in this save. Refresh and try again.'],
  [RpcErrorCodes.MARGIN_FLOOR_ITEM_INVALID, 'This save was not in the expected form. Refresh and try again.'],
  [RpcErrorCodes.MARGIN_FLOOR_ITEMS_REQUIRED, 'No margin floors were changed.'],
  [RpcErrorCodes.MARGIN_FLOOR_ITEMS_TOO_MANY, 'Save at most 1,000 margin floors at a time.'],
  [RpcErrorCodes.MARGIN_FLOOR_REASON_TOO_LONG, 'Keep the reason to 500 characters.'],
];

/** True when the database refused the save outright (nothing was written; no need to report it). */
export function isMarginFloorRefusal(error: unknown): boolean {
  return refusalMessages().some(([code]) => hasRpcCode(error, code));
}

/** Plain-English message for a failed floor save. */
export function marginFloorErrorMessage(error: unknown): string {
  const refusal = refusalMessages().find(([code]) => hasRpcCode(error, code));
  return refusal ? refusal[1] : sanitizeError(error);
}
