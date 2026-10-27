import { assertRpcResult, supabase } from './db';
import { parseLocalDate } from './dateUtils';
import type { LastChargedPrice } from '../types';

/**
 * "What did we charge this customer before?" (To-Do 0.3, pricing plan slice 3). The database
 * decides what counts as a charge (get_last_charged_prices, 20261027060000): posted, paid or overdue
 * invoice lines (not from spray-job invoices, which store line totals), and priced confirmed or
 * delivered order lines not yet on such an invoice. Admins and
 * sales reps read it (Mason, 2026-10-14), across reps; it carries no cost or margin.
 */

/** The database refuses more than this many products per call. */
export const LAST_CHARGED_MAX_PRODUCTS = 500;

interface LastChargedPriceWire {
  product_id: unknown;
  unit_price_cents: unknown;
  price_tier: unknown;
  unit_size: unknown;
  charged_on: unknown;
  source: unknown;
}

function parseRow(row: LastChargedPriceWire): LastChargedPrice {
  const cents = row.unit_price_cents;
  if (typeof cents !== 'number' || !Number.isSafeInteger(cents)) {
    throw new Error('get_last_charged_prices returned a price that is not whole cents');
  }
  const tier = row.price_tier;
  if (tier !== null && tier !== 1 && tier !== 2 && tier !== 3) {
    throw new Error('get_last_charged_prices returned an unknown tier');
  }
  if (row.source !== 'invoice' && row.source !== 'order') {
    throw new Error('get_last_charged_prices returned an unknown source');
  }
  if (typeof row.product_id !== 'string' || typeof row.charged_on !== 'string'
      || (row.unit_size !== null && typeof row.unit_size !== 'string')) {
    throw new Error('get_last_charged_prices returned a malformed row');
  }
  return {
    product_id: row.product_id,
    unit_price_cents: cents,
    price_tier: tier,
    unit_size: row.unit_size,
    charged_on: row.charged_on,
    source: row.source,
  };
}

/** The last charge to this customer for each product that has one, by product id. */
export async function fetchLastChargedPrices(
  customerId: string,
  productIds: string[],
): Promise<Map<string, LastChargedPrice>> {
  const unique = [...new Set(productIds.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows: LastChargedPrice[] = [];
  for (let start = 0; start < unique.length; start += LAST_CHARGED_MAX_PRODUCTS) {
    const { data, error } = await supabase.rpc('get_last_charged_prices', {
      p_customer_id: customerId,
      p_product_ids: unique.slice(start, start + LAST_CHARGED_MAX_PRODUCTS),
    });
    if (error) throw error;
    const result = assertRpcResult<LastChargedPriceWire[]>(data, 'get_last_charged_prices');
    if (!Array.isArray(result)) throw new Error('get_last_charged_prices did not return a list');
    rows.push(...result.map(parseRow));
  }
  return new Map(rows.map((row) => [row.product_id, row]));
}

/** "Mar 3, 2026" from a date-only value, read as a calendar date (no time-zone shift). */
export function formatChargedOn(chargedOn: string): string {
  return parseLocalDate(chargedOn).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Tier 2", or "Tier unknown" for lines sold before the tier was recorded. */
export function formatChargedTier(tier: LastChargedPrice['price_tier']): string {
  return tier === null ? 'Tier unknown' : `Tier ${tier}`;
}
