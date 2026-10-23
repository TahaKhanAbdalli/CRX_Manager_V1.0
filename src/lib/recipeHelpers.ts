/**
 * recipeHelpers — pure, framework-free helpers for loading/saving blend recipes
 * from the JobDetail Chemicals/Charges tab (field-app parity #2).
 *
 * Why client-side load (not the destructive load_recipe_into_job RPC):
 *   The server RPC DELETEs ALL job_chemicals first, requires the job to be saved,
 *   and forces a refetch — so it wipes unsaved edits and can't run on a brand-new
 *   job. The ChemMan flow is "drop these products into the editor, keep editing,
 *   then Save". Mapping a recipe into the in-memory chem rows keeps every line
 *   editable, lets the user choose REPLACE or ADD, never touches unrelated job
 *   data, and works on a new (unsaved) job. The job is persisted on the next Save
 *   like any other chemical edit.
 *
 * These functions are pure so the round-trip (save a recipe → load it back →
 * products/rates/units match) is unit-tested without mounting the page.
 */

import type { BlendRecipeItem, Product } from '../types';
import { getStatedTierPriceCents } from './quoteCalc';
import { priceTextInLineUnit } from './chemCalculator';

/** localStorage key for the per-browser "last used recipe" shortcut. */
const LAST_RECIPE_KEY = 'crx-last-recipe-id';

/** The fields a recipe load needs to produce a JobDetail ChemRow. ChemRow is a
 *  superset of this shape, so the page spreads the result onto a fresh row. */
export interface RecipeChemRowSeed {
  product_id: string;
  product_name: string;
  quantity: string;
  unit: string;
  rate_per_acre: string;
  rate_unit: string;
  cost_per_unit_cents: string;
  price_per_unit_cents: string;
  diluent_rate: string;
  rei_hours: string;
  phi_days: string;
  warehouse: string;
  vendor: string;
  /** 'rate' so a later acreage change re-derives quantity = rate × acres. */
  driver: 'rate' | 'qty';
}

/** The minimal chem-row shape needed to build a save_blend_recipe p_items entry. */
export interface RecipeItemSource {
  product_id: string;
  product_name: string;
  quantity: string;
  unit: string;
  rate_per_acre: string;
  price_per_unit_cents: string;
}

/** One p_items element for the save_blend_recipe RPC. */
export interface RecipeItemPayload {
  product_id: string;
  product_name: string;
  quantity: number;
  unit: string;
  rate_per_acre: number | null;
  price_per_unit_cents: number;
  notes: string | null;
}

/**
 * Map a saved recipe item (+ its current product, + the customer's tier) into a
 * chem-row seed for the job editor.
 *
 * Pricing intent ("preserve sensible pricing"): a recipe price OVERRIDES the tier
 * default when set; otherwise fall back to the customer's tier price so a loaded
 * line is never silently $0 (the old server RPC hard-set price 0). Cost, vendor,
 * REI/PHI come from the live product; rate/qty/unit come from the recipe.
 */
export function recipeItemToChemRowSeed(
  item: BlendRecipeItem,
  product: Product | undefined,
  tier: 1 | 2 | 3,
): RecipeChemRowSeed {
  const recipePrice = item.price_per_unit_cents ?? 0;
  // Blank when neither the recipe nor the product states a price: the job's save check then asks
  // for one instead of billing the line at $0. A missing tier-2/3 price falls back to tier 1; a
  // stated $0 is kept.
  // Unit of the recipe item wins; fall back to the product's pack unit.
  const unit = item.unit || product?.unit_size || '';
  // The catalog price is per the product's stock unit, so it is put in the line's unit (blank when
  // it cannot be).
  let price = recipePrice > 0 ? recipePrice.toString() : '';
  if (recipePrice <= 0 && product) {
    price = priceTextInLineUnit(product.unit_size, unit, getStatedTierPriceCents(product, tier));
  }

  const costCents = product?.current_cost != null ? Math.round(product.current_cost * 100) : 0;
  // rate_unit isn't stored on the recipe item — pull the product's default.
  const rateUnit = product?.rate_unit || '';

  return {
    product_id: item.product_id,
    product_name: item.product_name || product?.product_name || '',
    quantity: item.quantity != null ? item.quantity.toString() : '0',
    unit,
    rate_per_acre: item.rate_per_acre != null ? item.rate_per_acre.toString() : '',
    rate_unit: rateUnit,
    cost_per_unit_cents: costCents.toString(),
    price_per_unit_cents: price,
    diluent_rate: '',
    rei_hours: product?.rei_hours != null ? product.rei_hours.toString() : '',
    phi_days: product?.phi_days != null ? product.phi_days.toString() : '',
    warehouse: '',
    vendor: product?.vendor || '',
    driver: 'rate',
  };
}

/**
 * Map a job chem row into a save_blend_recipe p_items entry (the reverse of the
 * load). Only rows with a product are recipe-worthy. Numbers are parsed from the
 * string-backed grid; price is carried so the round-trip preserves it.
 */
export function chemRowToRecipeItem(row: RecipeItemSource): RecipeItemPayload | null {
  if (!row.product_id) return null;
  return {
    product_id: row.product_id,
    product_name: row.product_name || '',
    quantity: parseFloat(row.quantity) || 0,
    unit: row.unit || 'gal',
    rate_per_acre: row.rate_per_acre.trim() !== '' ? parseFloat(row.rate_per_acre) : null,
    price_per_unit_cents: parseInt(row.price_per_unit_cents, 10) || 0,
    notes: null,
  };
}

/** Build the full p_items array for save_blend_recipe, dropping product-less rows. */
export function chemRowsToRecipeItems(rows: RecipeItemSource[]): RecipeItemPayload[] {
  return rows
    .map(chemRowToRecipeItem)
    .filter((p): p is RecipeItemPayload => p !== null);
}

/** Persist the last recipe loaded into a job (per-browser shortcut). */
export function setLastRecipeId(id: string): void {
  try {
    localStorage.setItem(LAST_RECIPE_KEY, id);
  } catch {
    // ignore storage errors (private mode / quota)
  }
}

/** Read the last recipe loaded into a job, or null if none / unavailable. */
export function getLastRecipeId(): string | null {
  try {
    return localStorage.getItem(LAST_RECIPE_KEY);
  } catch {
    return null;
  }
}
