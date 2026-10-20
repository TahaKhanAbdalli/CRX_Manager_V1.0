/**
 * Cost and margin are ADMIN-ONLY (Mason, 2026-10-15; Goal 1 part 3).
 *
 * Step 3 revokes the cost columns below from the API roles, admins included, so a screen
 * must never read a cost table with `select('*')`: it lists the columns it may read (the
 * constants below are every column EXCEPT cost) and an admin screen adds cost through
 * `get_admin_cost_fields`, which refuses anyone who is not an active admin.
 *
 * costFields.test.ts keeps these lists in step with the live schema snapshot and refuses a
 * wildcard read of any of these tables anywhere in src/.
 */
import { assertRpcResult, supabase } from './db';

/** The cost, profit and margin columns of each table; only get_admin_cost_fields returns them. */
export const COST_COLUMNS = {
  products: ['current_cost', 'cost_updated_date', 'tier1_margin', 'tier2_margin', 'tier3_margin', 'tier1_gross_margin', 'tier2_gross_margin', 'tier3_gross_margin'],
  quotes: ['total_cost', 'total_profit', 'total_margin_pct'],
  quote_items: ['current_cost', 'profit', 'net_margin', 'cost_at_quote_cents'],
  orders: ['total_cost', 'total_profit', 'total_margin_pct'],
  order_items: ['cost_per_unit', 'profit', 'net_margin', 'cost_at_time_cents'],
  invoices: ['total_cost_cents'],
  invoice_items: ['cost_cents', 'return_credit_cogs_cents'],
  jobs: ['total_cost_cents'],
  job_chemicals: ['cost_per_unit_cents'],
  purchase_orders: ['total_cost', 'total_cost_cents'],
  purchase_order_items: ['unit_cost', 'unit_cost_cents'],
  blend_ticket_products: ['unit_cost_cents'],
  commissions: ['order_profit'],
} as const;

export type CostTable = keyof typeof COST_COLUMNS;

// Every non-cost column, in table order (live information_schema, 2026-10-19).
export const PRODUCT_COLUMNS = 'id, product_name, sku, category, vendor, manufacturer, container_size, unit_size, tier1_price, tier2_price, tier3_price, tier1_price_per_acre, tier2_price_per_acre, tier3_price_per_acre, suggested_rate, rate_per_acre, rate_unit, notes, is_active, created_at, updated_at, epa_registration, product_form, inventory_unit, container_unit, container_type, is_rup, signal_word, internal_notes, rei_hours, phi_days, max_label_rate, max_label_rate_unit, use_timing, pricing_version, quoting_notes, product_family_id, return_policy, packaging_variant, is_full_tote_only' as const;
export const QUOTE_COLUMNS = 'id, quote_number, customer_id, created_by, tier, status, commission_split, total_price, valid_days, expires_at, header_notes, footer_notes, created_at, updated_at, sent_at, is_planned, season, salesman_id, deleted_at, pdf_template_id, pdf_columns_override, row_version' as const;
export const QUOTE_ITEM_COLUMNS = 'id, quote_id, section_id, product_id, sort_order, notes, price_per_unit, suggested_rate, actual_rate, rate_unit, oz_per_acre, price_per_acre, acres, total_units_needed, unit_size, total_price, calc_mode, price_unit, price_override' as const;
export const ORDER_COLUMNS = 'id, order_number, quote_id, customer_id, status, commission_split, total_price, order_date, notes, created_at, updated_at, season, salesman_id, deleted_at, order_name, customer_po_number, is_planned, program_notes, booking_draw, pricing_status, pricing_reminder_sent_at, pricing_escalation_sent_at, needs_split_billing' as const;
export const ORDER_ITEM_COLUMNS = 'id, order_id, product_id, quote_item_id, section_name, product_name, price_per_unit, actual_rate, rate_unit, acres, total_units_needed, unit_size, total_price, quantity_delivered, quantity_remaining, sort_order, notes, pricing_pending, suggested_price' as const;
export const INVOICE_COLUMNS = 'id, invoice_number, order_id, blend_ticket_id, customer_id, invoice_type, status, season, salesman_id, created_by, total_amount_cents, paid_amount_cents, prepay_applied_cents, posted_by, posted_at, voided_by, voided_at, void_reason, invoice_date, due_date, purchase_order_ref, header_notes, footer_notes, parent_invoice_id, deleted_at, created_at, updated_at, crop_type, field_names, total_acres, applicator_name, vehicle_name, application_date, job_id, is_quick_delivery, write_off_cents, invoice_group_id, application_service_id, delivery_id, wind_direction, temperature_text, pricing_pending, payment_terms, internal_notes, discount_earned_cents, discount_date, start_temp_f, start_wind_mph, start_wind_direction, start_humidity_pct, start_weather_time, start_weather_source, end_temp_f, end_wind_mph, end_wind_direction, end_humidity_pct, end_weather_time, end_weather_source, weather_manual_override, diluent_rate_gpa, credit_applied_cents, balance_cents, send_disposition, field_app_billing_set_id' as const;
export const INVOICE_ITEM_COLUMNS = 'id, invoice_id, order_item_id, product_id, description, quantity, unit_price_cents, extended_cents, sort_order, rate_per_acre, acres, unit_size, notes, created_at, updated_at, rate_unit, total_applied, total_applied_unit, total_applied_gl_lb, gl_lb_unit, epa_registration, product_form, is_application_fee, tote_number, quoted_price_cents, price_source, warehouse, vendor, billing_line_id, return_credit_source_item_id' as const;
export const JOB_COLUMNS = 'id, job_number, customer_id, status, job_date, scheduled_time, applicator_id, vehicle_id, recipe_id, notes, tags, batch_id, season, total_acres, total_price_cents, invoice_id, created_by, deleted_at, created_at, updated_at, priority, estimated_hours, quote_id, quote_section_id, application_service_id, call_date, date_proposed, time_proposed, schedule_date, date_expires, consultant_id, loader_comment, additional_info, internal_memo, applied_acres, updated_by, printed_at, remaining_acres, ground_crew_id, batch_ref, last_printed_by, carrier_rate_gpa, loader_tank_capacity, commission_split' as const;
export const JOB_CHEMICAL_COLUMNS = 'id, job_id, product_id, quantity, unit, rate_per_acre, rate_unit, price_per_unit_cents, sort_order, diluent_rate, rei_hours, phi_days, warehouse, vendor, customer_supplied, driver' as const;
export const PURCHASE_ORDER_COLUMNS = 'id, po_number, vendor, status, submitted_date, expected_delivery_date, notes, created_by, created_at, updated_at, cancelled_at, cancelled_by, cancel_reason' as const;
export const PURCHASE_ORDER_ITEM_COLUMNS = 'id, purchase_order_id, product_id, quantity_ordered, quantity_received, unit_size, notes, product_name, product_supplier_link_id, supplier_price_observation_id, inventory_units_per_supplier_unit_snapshot, cost_provenance, cost_snapshot_at, inventory_unit_snapshot' as const;
export const BLEND_TICKET_PRODUCT_COLUMNS = 'id, blend_ticket_id, product_id, product_name, quantity, unit, lot_number, sequence_order, confidence_score, manually_corrected, created_at, rate_per_acre, rate_per_acre_unit, unit_price_cents' as const;
export const COMMISSION_COLUMNS = 'id, order_id, customer_id, recipient, split_percentage, commission_amount, order_date, status, created_at, paid_date, paid_note, recipient_user_id, season, deleted_at, order_number, customer_name, job_id, invoice_id, cancelled_at, cancelled_amount_cents' as const;

/** The non-cost column list of each cost table, for the drift test. */
export const SAFE_COLUMNS: Record<CostTable, string> = {
  products: PRODUCT_COLUMNS,
  quotes: QUOTE_COLUMNS,
  quote_items: QUOTE_ITEM_COLUMNS,
  orders: ORDER_COLUMNS,
  order_items: ORDER_ITEM_COLUMNS,
  invoices: INVOICE_COLUMNS,
  invoice_items: INVOICE_ITEM_COLUMNS,
  jobs: JOB_COLUMNS,
  job_chemicals: JOB_CHEMICAL_COLUMNS,
  purchase_orders: PURCHASE_ORDER_COLUMNS,
  purchase_order_items: PURCHASE_ORDER_ITEM_COLUMNS,
  blend_ticket_products: BLEND_TICKET_PRODUCT_COLUMNS,
  commissions: COMMISSION_COLUMNS,
};

/** The server refuses more than 5000 ids per call. */
const COST_ID_CHUNK = 1000;

export type CostFieldMap = Map<string, Record<string, unknown>>;
type CostFieldsById = Record<string, Record<string, unknown>>;

/**
 * Cost fields for the given rows, keyed by row id. Admins only: the server refuses anyone
 * else, so callers must not call this for a non-admin (use the role from useAuth()).
 */
export async function fetchAdminCostFields(table: CostTable, ids: readonly (string | null | undefined)[]): Promise<CostFieldMap> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const out: CostFieldMap = new Map();
  for (let i = 0; i < unique.length; i += COST_ID_CHUNK) {
    const chunk = unique.slice(i, i + COST_ID_CHUNK);
    const { data, error } = await supabase.rpc('get_admin_cost_fields', { p_table: table, p_ids: chunk });
    if (error) throw error;
    const byId = assertRpcResult<CostFieldsById>(data, 'get_admin_cost_fields');
    for (const [id, fields] of Object.entries(byId)) out.set(id, fields);
  }
  return out;
}

/** Copy each row's cost fields onto it (rows the map does not cover are returned unchanged). */
export function applyCostFields<T extends { id: string }>(rows: readonly T[], costs: CostFieldMap): T[] {
  return rows.map((row) => {
    const fields = costs.get(row.id);
    return fields ? { ...row, ...fields } : row;
  });
}

/**
 * For an admin, `rows` with their cost fields added; for anyone else, `rows` unchanged (their
 * cost fields stay absent, which every screen treats as "not shown").
 */
export async function withAdminCosts<T extends { id: string }>(table: CostTable, rows: readonly T[], isAdmin: boolean): Promise<T[]> {
  if (!isAdmin || rows.length === 0) return [...rows];
  return applyCostFields(rows, await fetchAdminCostFields(table, rows.map((r) => r.id)));
}

/** withAdminCosts for a single row (or null). */
export async function withAdminCost<T extends { id: string }>(table: CostTable, row: T | null, isAdmin: boolean): Promise<T | null> {
  if (!row) return row;
  const [merged] = await withAdminCosts(table, [row], isAdmin);
  return merged;
}

/**
 * For an admin, add the cost fields of a nested object (e.g. each quote item's `product`):
 * `key` names the nested object, `table` its cost table.
 */
export async function withAdminNestedCosts<T, K extends keyof T>(
  table: CostTable,
  rows: readonly T[],
  key: K,
  isAdmin: boolean,
): Promise<T[]> {
  if (!isAdmin || rows.length === 0) return [...rows];
  const nestedId = (row: T): string | null => {
    const nested = row[key] as unknown;
    return nested && typeof nested === 'object' && typeof (nested as { id?: unknown }).id === 'string'
      ? (nested as { id: string }).id
      : null;
  };
  const costs = await fetchAdminCostFields(table, rows.map(nestedId));
  return rows.map((row) => {
    const id = nestedId(row);
    const fields = id ? costs.get(id) : undefined;
    return fields ? { ...row, [key]: { ...(row[key] as object), ...fields } } : row;
  });
}
