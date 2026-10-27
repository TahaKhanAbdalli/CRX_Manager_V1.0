import { supabase } from './db';
import { fetchAllRows, pageWithList } from './pagedRead';
import type { CostHistory } from '../types';

/**
 * Sell-price history for one product (To-Do 0.4, pricing plan slice 4). Read from cost_history,
 * which already logs every tier price change and is admin-only (Mason, 2026-10-14: "only admin can
 * see the price history"). 20261026140000 gave every product with no history a dated starting
 * snapshot; a product with history starts at its first change's old prices, and one created later
 * at its creation (its first logged change records the prices it started with).
 */

// change_source is text as the database returns it; sourceLabel() names the known values.
export type SellPriceHistoryRow = Pick<CostHistory,
  'id' | 'changed_at' | 'change_reason' | 'change_note'
  | 'old_tier1_price' | 'new_tier1_price' | 'old_tier2_price' | 'new_tier2_price'
  | 'old_tier3_price' | 'new_tier3_price'> & { change_source: string };

/** Every history row for the product, oldest first. */
export async function fetchSellPriceHistory(productId: string): Promise<SellPriceHistoryRow[]> {
  const { data, error } = await fetchAllRows<SellPriceHistoryRow>((from, to) =>
    pageWithList(supabase
      .from('cost_history')
      .select('id, changed_at, change_source, change_reason, change_note, old_tier1_price, new_tier1_price, old_tier2_price, new_tier2_price, old_tier3_price, new_tier3_price', { count: 'exact' })
      .eq('product_id', productId)
      .order('changed_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)));
  if (error) throw error;
  return data ?? [];
}

/**
 * A stored dollar price (numeric, whole cents) as integer cents, read from its decimal text so no
 * binary-float arithmetic touches it. null stays null; anything that is not whole cents throws.
 */
export function priceToCents(value: number | string | null): number | null {
  if (value === null) return null;
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  // The messages never carry the price itself: errors reach Sentry, and prices are admin-only.
  if (!match) throw new Error('price history holds a price that is not whole cents');
  // The value can arrive as a JSON number, exact only to about 15 digits; product prices are
  // numeric(12,2) (at most 10 dollar digits), so anything longer is refused, never shown rounded.
  if (match[2].replace(/^0+(?=\d)/, '').length > 10) throw new Error('price history holds a price too large to show exactly');
  const cents = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'));
  return match[1] === '-' ? -cents : cents;
}

export type TierKey = 'tier1' | 'tier2' | 'tier3';
export const TIERS: TierKey[] = ['tier1', 'tier2', 'tier3'];

export interface SellPricePoint {
  id: string;
  at: string;
  /** The tier prices in effect after this row, in cents (null = no price set for that tier). */
  cents: Record<TierKey, number | null>;
  /** The tier prices before this row, in cents (null = none). */
  previousCents: Record<TierKey, number | null>;
  isStartingPoint: boolean;
  source: SellPriceHistoryRow['change_source'];
  reason: string | null;
}

/**
 * The rows that set or change a sell price, oldest first: the earliest row (a starting snapshot or
 * the first logged change), then every row whose tier prices differ from before. Later cost-only
 * changes (tier prices unchanged) are left out: this is the sell-price history, and cost has its own card.
 */
export function sellPricePoints(rows: SellPriceHistoryRow[]): SellPricePoint[] {
  const points: SellPricePoint[] = [];
  // A snapshot is where the record starts, so it goes first even if a price save racing the
  // migration got an earlier timestamp (a transaction's now() is when it began).
  const ordered = [
    ...rows.filter((r) => r.change_source === 'starting_snapshot'),
    ...rows.filter((r) => r.change_source !== 'starting_snapshot'),
  ];
  for (const [index, row] of ordered.entries()) {
    const cents = {
      tier1: priceToCents(row.new_tier1_price),
      tier2: priceToCents(row.new_tier2_price),
      tier3: priceToCents(row.new_tier3_price),
    };
    const previousCents = {
      tier1: priceToCents(row.old_tier1_price),
      tier2: priceToCents(row.old_tier2_price),
      tier3: priceToCents(row.old_tier3_price),
    };
    const isStartingPoint = row.change_source === 'starting_snapshot';
    const changed = TIERS.some((tier) => cents[tier] !== previousCents[tier]);
    // The earliest row always counts, even a cost-only one: it is where the record starts.
    if (index > 0 && !isStartingPoint && !changed) continue;
    points.push({
      id: row.id,
      at: row.changed_at,
      cents,
      previousCents,
      isStartingPoint,
      source: row.change_source,
      reason: row.change_reason ?? row.change_note,
    });
  }
  return points;
}

/** Where an instant falls on a time axis from `start` to `end`, as 0..1 (0.5 when they are equal). */
export function timeFraction(at: string, start: string, end: string): number {
  const t = Date.parse(at);
  const t0 = Date.parse(start);
  const t1 = Date.parse(end);
  if (!(t1 > t0)) return 0.5;
  return Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
}

const CHANGE_SOURCE_LABELS: Record<CostHistory['change_source'], string> = {
  starting_snapshot: 'Starting point',
  pricing_worksheet: 'Price sheet',
  product_page: 'Product page',
  products_inline: 'Products list',
  legacy_frontend: 'Earlier screen',
};

/** Where a history row came from, in plain words. */
export function sourceLabel(source: string): string {
  return (CHANGE_SOURCE_LABELS as Record<string, string>)[source] ?? 'Other change';
}
