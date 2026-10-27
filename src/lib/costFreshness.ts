/**
 * Cost freshness (To-Do 0.7, pricing plan slice 7, the small part): how old each product's cost is.
 *
 * A product's "as of" date is products.cost_updated_date (admin-only, read through
 * get_admin_cost_fields), which the governed pricing apply sets whenever the cost itself changes.
 * A cost re-entered at the same value keeps its old date. A product with no date has a cost that
 * cannot be shown to be current, so the stale-cost report always lists it.
 */
import { BUSINESS_TIMEZONE, todayInBusinessTz } from './dateUtils';

// Built once: the Products list dates every row on each render.
const businessDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** The ages an admin can pick on the stale-cost report, in days. */
export const STALE_COST_AGE_OPTIONS = [30, 90, 180, 365] as const;
export type StaleCostAgeDays = (typeof STALE_COST_AGE_OPTIONS)[number];
/** The monthly price-sheet routine re-checks costs well inside this. */
export const DEFAULT_STALE_COST_AGE_DAYS: StaleCostAgeDays = 90;

const DAY_MS = 86_400_000;

/** The Central business date (YYYY-MM-DD) a cost was last changed, or null without a usable date. */
export function costAsOfDate(costUpdatedDate: string | null | undefined): string | null {
  if (!costUpdatedDate) return null;
  // The column is a timestamptz; a bare date is already a business date (new Date would read it as UTC).
  if (/^\d{4}-\d{2}-\d{2}$/.test(costUpdatedDate)) return costUpdatedDate;
  const at = new Date(costUpdatedDate);
  if (Number.isNaN(at.getTime())) return null;
  // Assembled from parts, as todayInBusinessTz does: the locale's own layout is not relied on.
  const parts = businessDateFormat.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  return year && month && day ? `${year}-${month}-${day}` : null;
}

/** A cost_updated_date for a CSV: the Central business date, or blank without one. */
export function formatCostAsOfCSV(value: unknown): string {
  return costAsOfDate(typeof value === 'string' ? value : null) ?? '';
}

/** Whole days from a business date to today's business date; never negative; null without a date. */
export function costAgeDays(asOf: string | null, today: string = todayInBusinessTz()): number | null {
  if (!asOf) return null;
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / DAY_MS);
  return Number.isFinite(days) ? Math.max(0, days) : null;
}

/** Older than the limit, or with no date at all. */
export function isCostStale(ageDays: number | null, maxAgeDays: number): boolean {
  return ageDays === null || ageDays > maxAgeDays;
}

export interface StaleCostRow {
  [k: string]: unknown;
  id: string;
  product_name: string;
  sku: string | null;
  category: string | null;
  vendor: string | null;
  current_cost: number | null;
  cost_as_of: string | null;
  cost_age_days: number | null;
}

/** The products whose cost is stale under the limit: no date first, then oldest first, then by name. */
export function staleCostRows<T extends {
  id: string; product_name: string; sku?: string | null; category?: string | null; vendor?: string | null;
  current_cost?: number | null; cost_updated_date?: string | null;
}>(products: readonly T[], maxAgeDays: number, today: string = todayInBusinessTz()): StaleCostRow[] {
  return products
    .map((p) => {
      const asOf = costAsOfDate(p.cost_updated_date);
      return {
        id: p.id,
        product_name: p.product_name,
        sku: p.sku ?? null,
        category: p.category ?? null,
        vendor: p.vendor ?? null,
        current_cost: p.current_cost ?? null,
        cost_as_of: asOf,
        cost_age_days: costAgeDays(asOf, today),
      };
    })
    .filter((r) => isCostStale(r.cost_age_days, maxAgeDays))
    .sort((a, b) => {
      if (a.cost_age_days === null || b.cost_age_days === null) {
        if (a.cost_age_days !== b.cost_age_days) return a.cost_age_days === null ? -1 : 1;
      } else if (a.cost_age_days !== b.cost_age_days) {
        return b.cost_age_days - a.cost_age_days;
      }
      return a.product_name.localeCompare(b.product_name);
    });
}
