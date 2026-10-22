import { purchaseOrderCentsToDollars } from './purchaseOrderMoney';
import { isWholeCentDollarInput, parseDollarsToCents } from './parseCents';

export interface PurchaseOrderEditableLine {
  id: string;
  product_id: string;
  product_name: string;
  unit_size: string;
  quantity_ordered: string;
  unit_cost: string;
  quantity_received: number;
}

/**
 * `includeCost: false` (a non-admin; purchase cost is admin-only, Mason 2026-10-20) sends no
 * cost at all: save_purchase_order keeps each existing line's stored cost and the server gives a
 * new or switched line the product's catalog cost, flagged for an admin to confirm or correct.
 */
export function buildPurchaseOrderEditItemsPayload(
  items: PurchaseOrderEditableLine[],
  { includeCost }: { includeCost: boolean },
) {
  return items.map((item) => {
    const quantityOrdered = Number.parseFloat(item.quantity_ordered);
    if (!Number.isFinite(quantityOrdered)) {
      throw new Error(`Invalid quantity ordered for purchase order line ${item.id}`);
    }
    const line = {
      id: item.id,
      product_id: item.product_id,
      product_name: item.product_name,
      unit_size: item.unit_size || null,
      quantity_ordered: quantityOrdered,
      quantity_received: item.quantity_received || 0,
    };
    if (!includeCost) return line;
    // Exact whole cents from the typed text: blank or more than two decimals is refused, never
    // sent as $0 or rounded (the screen checks first and explains; this is the backstop).
    const text = item.unit_cost.trim();
    if (!isWholeCentDollarInput(text)) {
      throw new Error(`Invalid unit cost for purchase order line ${item.id}`);
    }
    const unitCostCents = parseDollarsToCents(text);
    if (unitCostCents === null || !Number.isSafeInteger(unitCostCents)) {
      throw new Error(`Invalid unit cost for purchase order line ${item.id}`);
    }
    return {
      ...line,
      unit_cost: purchaseOrderCentsToDollars(unitCostCents),
      unit_cost_cents: unitCostCents,
    };
  });
}
