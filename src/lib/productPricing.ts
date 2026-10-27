import type { Json } from '../types/supabase';
import type { ProductCostBasisSelectionSource, ProductCostBasisType } from '../types';
import { assertRpcResult, supabase } from './db';

export type PricingSource = 'pricing_worksheet' | 'product_page' | 'products_inline';
export type PricingMode = 'margin_driven' | 'price_driven';
export type PricingRowStatus = 'ready' | 'conflict' | 'invalid' | 'unchanged';
export type PricingChangeSetStatus =
  | 'previewed'
  | 'invalid'
  | 'no_changes'
  | 'applied'
  | 'expired';
export type ProductCostBasisSource = Exclude<
  ProductCostBasisSelectionSource,
  'migration_baseline'
>;

export interface CostBasisPreviewMetadata {
  basis_type?: ProductCostBasisType;
  basis_reason?: string;
  basis_source?: ProductCostBasisSource;
  basis_selection?: boolean;
  supplier_price_observation_id?: string;
  purchase_order_item_id?: string;
}

const MAX_PRICING_CENTS = 9_223_372_036_854_775_807n;
const PRICING_DOLLAR_INPUT = /^([0-9]+)(?:\.([0-9]{1,2}))?$/;

/**
 * Convert a browser-entered dollar string to cents without passing through a
 * JavaScript Number. Null means the value is not accepted by the database
 * pricing boundary (including values outside PostgreSQL bigint cents).
 */
export function pricingDollarInputToCents(value: string): bigint | null {
  const match = PRICING_DOLLAR_INPUT.exec(value.trim());
  if (!match) return null;
  const wholeDollars = match[1].replace(/^0+(?=\d)/, '');
  if (wholeDollars.length > 17) return null;
  const cents = (BigInt(wholeDollars) * 100n) + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return cents <= MAX_PRICING_CENTS ? cents : null;
}

export function formatPricingMarginPercent(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Pricing margin must be a finite number.');
  return (value * 100).toFixed(8).replace(/\.?0+$/, '');
}

export function assertPricingPreviewRowsSafe(
  rows: ReadonlyArray<{
    pricing_mode: PricingMode | '';
    new_cost: string;
    product_name?: string;
  }>,
): void {
  for (const row of rows) {
    if (row.pricing_mode !== 'margin_driven') continue;
    const costCents = pricingDollarInputToCents(row.new_cost);
    const submittedZero = costCents === 0n
      || /^[+-]?0+(?:\.0+)?(?:e[+-]?\d+)?$/i.test(row.new_cost.trim());
    if (submittedZero) {
      const productName = row.product_name?.trim() || 'this Product';
      throw new Error(
        `Margin-driven pricing requires a cost greater than $0 for ${productName}. No prices were changed.`,
      );
    }
  }
}

export interface PricingWorkbookExportRow {
  product_id: string;
  sku: string | null;
  product_name: string;
  category: string | null;
  container_size: string | null;
  unit_size: string | null;
  inventory_unit: string | null;
  identity_fingerprint: string;
  row_token: string;
  row_version: number;
  current_cost: string | null;
  current_tier1_margin_percent: string | null;
  current_tier1_price: string | null;
  current_tier2_margin_percent: string | null;
  current_tier2_price: string | null;
  current_tier3_margin_percent: string | null;
  current_tier3_price: string | null;
  suggested_rate?: string | null;
  rate_per_acre?: string | null;
  rate_unit?: string | null;
  use_timing?: string | null;
  internal_notes?: string | null;
  quoting_notes?: string | null;
}

export interface PricingWorkbookExport {
  export_id: string;
  format_version?: string;
  manifest_fingerprint: string;
  expires_at: string;
  rows: PricingWorkbookExportRow[];
}

export interface PricingPreviewInputRow extends CostBasisPreviewMetadata {
  product_id: string;
  product_name?: string;
  sku?: string;
  row_version: number | string;
  pricing_mode: PricingMode;
  new_cost: string;
  tier1_margin_percent?: string;
  tier1_price?: string;
  tier2_margin_percent?: string;
  tier2_price?: string;
  tier3_margin_percent?: string;
  tier3_price?: string;
  change_reason?: string;
  /** Where the new number came from (supplier, document, date). Required with any price or cost change. */
  price_source?: string;
}

export interface PricingSnapshot {
  cost: string | null;
  cost_cents: bigint | null;
  tier1_margin_percent: string | null;
  tier1_margin: number | null;
  tier1_price: string | null;
  tier1_price_cents: bigint | null;
  tier2_margin_percent: string | null;
  tier2_margin: number | null;
  tier2_price: string | null;
  tier2_price_cents: bigint | null;
  tier3_margin_percent: string | null;
  tier3_margin: number | null;
  tier3_price: string | null;
  tier3_price_cents: bigint | null;
  tier1_price_per_acre_cents?: bigint | null;
  tier2_price_per_acre_cents?: bigint | null;
  tier3_price_per_acre_cents?: bigint | null;
}

export interface PricingWorksheetPreviewRow extends CostBasisPreviewMetadata {
  product_id: string;
  sku: string;
  product_name: string;
  category: string;
  container_size: string;
  unit_size: string;
  inventory_unit: string;
  identity_fingerprint: string;
  row_token: string;
  row_version: string;
  current_cost: string;
  current_tier1_margin_percent: string;
  current_tier1_price: string;
  current_tier2_margin_percent: string;
  current_tier2_price: string;
  current_tier3_margin_percent: string;
  current_tier3_price: string;
  pricing_mode: PricingMode | '';
  new_cost: string;
  tier1_margin_percent: string;
  tier1_price: string;
  tier2_margin_percent: string;
  tier2_price: string;
  tier3_margin_percent: string;
  tier3_price: string;
  change_reason: string;
  price_source: string;
  suggested_rate?: string;
  rate_per_acre?: string;
  rate_unit?: string;
  use_timing?: string;
  internal_notes?: string;
  quoting_notes?: string;
  has_formula: boolean;
  formula_cells: string[];
}

export interface PricingEffect extends PricingSnapshot {
  product_id: string;
  product_name?: string;
  sku?: string;
  before?: PricingSnapshot;
  pricing_mode?: PricingMode;
  tier1_gross_margin?: number | null;
  tier2_gross_margin?: number | null;
  tier3_gross_margin?: number | null;
  pricing_changed?: boolean;
  product_info_changes?: Record<string, { before: unknown; after: unknown }>;
}

export interface PricingPreviewRow {
  sequence: number;
  product_id: string | null;
  submitted_row: Record<string, unknown>;
  row_status: PricingRowStatus;
  error_code: string | null;
  effect: PricingEffect | null;
}

export interface PricingPreviewResult {
  change_set_id: string;
  request_fingerprint: string;
  source: PricingSource;
  status: PricingChangeSetStatus;
  expires_at: string;
  submitted_row_count: number;
  ready_count: number;
  unchanged_count: number;
  conflict_count: number;
  invalid_count: number;
  apply_allowed: boolean;
  basis_change_count?: number;
  pricing_change_count?: number;
  product_info_change_count?: number;
  rows: PricingPreviewRow[];
  /** Products whose new cost or prices need an acknowledgement before apply (20261027050000). */
  warnings: PricingWarning[];
}

export type PricingWarningCode =
  | 'COST_MOVE_OVER_10_PERCENT'
  | 'PRICE_MOVE_OVER_10_PERCENT'
  | 'PRICE_BELOW_COST'
  | 'MARGIN_UNDER_FLOOR'
  | 'OPEN_SENT_QUOTE';

export interface PricingWarningTier {
  tier: 1 | 2 | 3;
  before_cents: bigint | null;
  after_cents: bigint | null;
  /** Net margin of the new price, a ratio like 0.15; null when the price is $0 or blank. */
  margin: number | null;
}

export interface PricingWarning {
  product_id: string;
  warning_codes: PricingWarningCode[];
  details: {
    cost_before_cents: bigint | null;
    cost_after_cents: bigint | null;
    margin_floor: number | null;
    tiers: PricingWarningTier[];
    open_quote_count: number;
    open_quote_numbers: string[];
  };
}

/** One per warned product: exactly its warning codes and why they are acceptable (1-500 characters). */
export interface PricingAcknowledgement {
  product_id: string;
  warning_codes: PricingWarningCode[];
  reason: string;
}

/** The uploaded price sheet a workbook approval names. */
export interface PricingSourceFile {
  name: string;
  sha256: string;
}

export interface AppliedPricingRow extends PricingEffect {
  pricing_version: number;
}

export interface ApplyPricingResult {
  change_set_id: string;
  status: 'applied';
  applied_count: number;
  rows: AppliedPricingRow[];
  cost_basis_rows?: AppliedCostBasisRow[];
}

export interface AppliedCostBasisRow {
  id: string;
  product_id: string;
  basis_type: ProductCostBasisType;
  cost_cents: bigint;
  supplier_price_observation_id: string | null;
  purchase_order_item_id: string | null;
  selection_source: ProductCostBasisSource;
  reason: string;
  selected_at: string;
}

export interface CreatePricingWorkbookExportInput {
  productIds?: string[] | null;
  performedBy: string;
  idempotencyKey: string;
}

interface PricingPreviewInputBase {
  performedBy: string;
  idempotencyKey: string;
}

export type PreviewPricingChangesInput =
  | (PricingPreviewInputBase & {
      source: 'pricing_worksheet';
      exportId: string;
      rows: PricingWorksheetPreviewRow[];
    })
  | (PricingPreviewInputBase & {
      source: 'product_page' | 'products_inline';
      exportId?: never;
      rows: PricingPreviewInputRow[];
    });

export interface ApplyPricingChangeSetInput {
  changeSetId: string;
  requestFingerprint: string;
  performedBy: string;
  idempotencyKey: string;
}

export interface ApprovePricingChangeSetInput {
  changeSetId: string;
  requestFingerprint: string;
  acknowledgements: PricingAcknowledgement[];
  /** Required for a workbook change set; null for the product page and Products list. */
  sourceFile: PricingSourceFile | null;
  performedBy: string;
  idempotencyKey: string;
}

type PricingCentsField =
  | 'cost_cents'
  | 'tier1_price_cents'
  | 'tier2_price_cents'
  | 'tier3_price_cents'
  | 'tier1_price_per_acre_cents'
  | 'tier2_price_per_acre_cents'
  | 'tier3_price_per_acre_cents';

type PricingSnapshotWire = Omit<PricingSnapshot, PricingCentsField> & {
  cost_cents: unknown;
  tier1_price_cents: unknown;
  tier2_price_cents: unknown;
  tier3_price_cents: unknown;
  tier1_price_per_acre_cents?: unknown;
  tier2_price_per_acre_cents?: unknown;
  tier3_price_per_acre_cents?: unknown;
};

type PricingEffectWire = PricingSnapshotWire
  & Omit<PricingEffect, keyof PricingSnapshot | 'before'>
  & { before?: PricingSnapshotWire };

type PricingWarningWire = Omit<PricingWarning, 'details'> & {
  details: Omit<PricingWarning['details'], 'cost_before_cents' | 'cost_after_cents' | 'tiers'> & {
    cost_before_cents: unknown;
    cost_after_cents: unknown;
    tiers: Array<Omit<PricingWarningTier, 'before_cents' | 'after_cents'> & { before_cents: unknown; after_cents: unknown }>;
  };
};

type PricingPreviewResultWire = Omit<PricingPreviewResult, 'rows' | 'warnings'> & {
  rows: Array<Omit<PricingPreviewRow, 'effect'> & { effect: PricingEffectWire | null }>;
  warnings?: PricingWarningWire[];
};

type ApplyPricingResultWire = Omit<ApplyPricingResult, 'rows' | 'cost_basis_rows'> & {
  rows: Array<PricingEffectWire & Pick<AppliedPricingRow, 'pricing_version'>>;
  cost_basis_rows?: Array<Omit<AppliedCostBasisRow, 'cost_cents'> & { cost_cents: unknown }>;
};

function exactDollarCents(value: string | null, field: string): bigint | null {
  if (value === null) return null;
  const cents = pricingDollarInputToCents(value);
  if (cents === null) throw new Error(`Pricing RPC returned an invalid ${field} value.`);
  return cents;
}

export function exactIntegerCents(value: unknown, field: string): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`Pricing RPC returned an unsafe ${field} value.`);
}

export function requiredExactIntegerCents(value: unknown, field: string): bigint {
  const cents = exactIntegerCents(value, field);
  if (cents === null) throw new Error(`Pricing RPC returned a missing ${field} value.`);
  return cents;
}

function normalizePricingSnapshot(snapshot: PricingSnapshotWire): PricingSnapshot {
  return {
    ...snapshot,
    cost_cents: exactDollarCents(snapshot.cost, 'cost'),
    tier1_price_cents: exactDollarCents(snapshot.tier1_price, 'tier 1 price'),
    tier2_price_cents: exactDollarCents(snapshot.tier2_price, 'tier 2 price'),
    tier3_price_cents: exactDollarCents(snapshot.tier3_price, 'tier 3 price'),
    tier1_price_per_acre_cents: exactIntegerCents(
      snapshot.tier1_price_per_acre_cents,
      'tier 1 per-acre cents',
    ),
    tier2_price_per_acre_cents: exactIntegerCents(
      snapshot.tier2_price_per_acre_cents,
      'tier 2 per-acre cents',
    ),
    tier3_price_per_acre_cents: exactIntegerCents(
      snapshot.tier3_price_per_acre_cents,
      'tier 3 per-acre cents',
    ),
  };
}

function normalizePricingEffect(effect: PricingEffectWire): PricingEffect {
  return {
    ...effect,
    ...normalizePricingSnapshot(effect),
    before: effect.before ? normalizePricingSnapshot(effect.before) : undefined,
  } as PricingEffect;
}

function normalizePricingWarning(warning: PricingWarningWire): PricingWarning {
  const { details } = warning;
  return {
    ...warning,
    details: {
      ...details,
      cost_before_cents: exactIntegerCents(details.cost_before_cents, 'warning cost before cents'),
      cost_after_cents: exactIntegerCents(details.cost_after_cents, 'warning cost after cents'),
      margin_floor: details.margin_floor == null ? null : Number(details.margin_floor),
      tiers: details.tiers.map((tier) => ({
        ...tier,
        before_cents: exactIntegerCents(tier.before_cents, `warning tier ${tier.tier} before cents`),
        after_cents: exactIntegerCents(tier.after_cents, `warning tier ${tier.tier} after cents`),
        margin: tier.margin == null ? null : Number(tier.margin),
      })),
    },
  };
}

function normalizePricingPreviewResult(result: PricingPreviewResultWire): PricingPreviewResult {
  return {
    ...result,
    rows: result.rows.map((row) => ({
      ...row,
      effect: row.effect ? normalizePricingEffect(row.effect) : null,
    })),
    warnings: (result.warnings ?? []).map(normalizePricingWarning),
  };
}

function normalizeApplyPricingResult(result: ApplyPricingResultWire): ApplyPricingResult {
  return {
    ...result,
    rows: result.rows.map((row) => ({
      ...normalizePricingEffect(row),
      pricing_version: row.pricing_version,
    })),
    cost_basis_rows: result.cost_basis_rows?.map((row) => ({
      ...row,
      cost_cents: requiredExactIntegerCents(row.cost_cents, 'cost basis cents'),
    })),
  };
}

export function costBasisRows(
  rows: ReadonlyArray<PricingPreviewInputRow | PricingWorksheetPreviewRow>,
  source: PricingSource,
): Array<PricingPreviewInputRow | PricingWorksheetPreviewRow> {
  const defaultReason = source === 'pricing_worksheet'
    ? 'Pricing worksheet update'
    : source === 'products_inline'
      ? 'Products list pricing update'
      : 'Product pricing update';
  return rows.map((row) => ({
    ...row,
    basis_type: row.basis_type ?? 'manual_override',
    basis_reason: row.basis_reason?.trim() || row.change_reason?.trim() || defaultReason,
    basis_source: row.basis_source ?? source,
    basis_selection: row.basis_selection ?? false,
  }));
}

export async function createPricingWorkbookExport(
  input: CreatePricingWorkbookExportInput,
): Promise<PricingWorkbookExport> {
  const { data, error } = await supabase.rpc('create_pricing_workbook_export', {
    p_product_ids: input.productIds ?? undefined,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  return assertRpcResult<PricingWorkbookExport>(data, 'create_pricing_workbook_export');
}

export async function previewProductPricingChanges(
  input: PreviewPricingChangesInput,
): Promise<PricingPreviewResult> {
  // Defense in depth for the staged rollout: legacy direct Product saves remain
  // temporarily compatible, so block the one input that could compute zero sell
  // prices before any frontend path reaches the RPC. The live database guard
  // independently enforces the same rule server-side.
  assertPricingPreviewRowsSafe(input.rows);
  const rows = costBasisRows(input.rows, input.source);
  const { data, error } = await supabase.rpc('preview_product_cost_basis_changes', {
    p_source: input.source,
    p_export_id: input.source === 'pricing_worksheet' ? input.exportId : undefined,
    p_rows: rows as unknown as Json,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  const result = assertRpcResult<PricingPreviewResultWire>(data, 'preview_product_cost_basis_changes');
  return normalizePricingPreviewResult(result);
}

/** Plain-English label for each warning the database can raise on a pricing preview. */
export const PRICING_WARNING_LABELS: Record<PricingWarningCode, string> = {
  COST_MOVE_OVER_10_PERCENT: 'Cost moves more than 10%',
  PRICE_MOVE_OVER_10_PERCENT: 'A price moves more than 10%',
  PRICE_BELOW_COST: 'A price is below cost',
  MARGIN_UNDER_FLOOR: 'A margin is under the product\'s floor',
  OPEN_SENT_QUOTE: 'An open sent quote will re-price on its next save',
};

/** The database's limit on an acknowledgement reason (approve_pricing_change_set). */
export const PRICING_ACK_REASON_MAX = 500;

/** The acknowledgements the database needs, or null while any warned product still lacks a valid reason. */
export function pricingAcknowledgements(
  warnings: PricingWarning[],
  reasons: Record<string, string>,
): PricingAcknowledgement[] | null {
  const acknowledgements: PricingAcknowledgement[] = [];
  for (const warning of warnings) {
    const reason = (reasons[warning.product_id] ?? '').trim();
    if (reason.length === 0 || reason.length > PRICING_ACK_REASON_MAX) return null;
    acknowledgements.push({ product_id: warning.product_id, warning_codes: warning.warning_codes, reason });
  }
  return acknowledgements;
}

/** Lower-case hex SHA-256 of an uploaded file, the fingerprint a workbook approval records. */
export async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Records the admin's sign-off on a preview: every warning acknowledged with a reason. Apply requires it. */
export async function approvePricingChangeSet(input: ApprovePricingChangeSetInput): Promise<void> {
  const { data, error } = await supabase.rpc('approve_pricing_change_set', {
    p_change_set_id: input.changeSetId,
    p_request_fingerprint: input.requestFingerprint,
    p_acknowledgements: input.acknowledgements.map((ack) => ({
      product_id: ack.product_id,
      warning_codes: ack.warning_codes,
      reason: ack.reason.trim(),
    })) as unknown as Json,
    p_source_file: (input.sourceFile ?? undefined) as unknown as Json | undefined,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  assertRpcResult<{ status: 'approved' }>(data, 'approve_pricing_change_set');
}

export async function applyProductPricingChangeSet(
  input: ApplyPricingChangeSetInput,
): Promise<ApplyPricingResult> {
  const { data, error } = await supabase.rpc('apply_product_cost_basis_change_set', {
    p_change_set_id: input.changeSetId,
    p_request_fingerprint: input.requestFingerprint,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  const result = assertRpcResult<ApplyPricingResultWire>(data, 'apply_product_cost_basis_change_set');
  return normalizeApplyPricingResult(result);
}
