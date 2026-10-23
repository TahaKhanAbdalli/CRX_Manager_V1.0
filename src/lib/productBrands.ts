import { assertRpcResult, hasRpcCode, RpcErrorCodes, supabase, supabaseUntyped } from './db';
import { sanitizeError } from './errorSanitizer';
import type { BrandSignalWord, ProductBrand } from '../types';

export const PRODUCT_BRAND_COLUMNS =
  'id, product_id, brand_name, epa_registration, manufacturer, is_currently_sourced, is_rup, signal_word, row_version, created_by, updated_by, created_at, updated_at';

/**
 * Same shapes the database and the EPA lookup accept: a Section 3 number (524-475) or a distributor
 * number (100-1234-5905), each part non-zero-led and at most 6, 5 and 6 digits.
 */
export const EPA_REGISTRATION_PATTERN = /^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$/;

export interface ProductBrandInput {
  productId: string;
  /** Omit to add a new brand. */
  brandId?: string;
  /** The row_version the editor read; required when brandId is set. */
  expectedRowVersion?: number;
  brandName: string;
  epaRegistration: string;
  manufacturer: string;
  isCurrentlySourced: boolean;
  isRup: boolean | null;
  signalWord: BrandSignalWord | null;
}

export async function listProductBrands(productId: string): Promise<ProductBrand[]> {
  const { data, error } = await supabase
    .from('product_brands')
    .select(PRODUCT_BRAND_COLUMNS)
    .eq('product_id', productId)
    .order('brand_name');
  if (error) throw error;
  return (data ?? []) as ProductBrand[];
}

export async function saveProductBrand(input: ProductBrandInput, idempotencyKey: string): Promise<ProductBrand> {
  // Untyped client: the generated Args type marks the nullable parameters non-null.
  const { data, error } = await supabaseUntyped.rpc('upsert_product_brand', {
    p_product_id: input.productId,
    p_brand_id: input.brandId ?? null,
    p_expected_row_version: input.expectedRowVersion ?? null,
    p_brand_name: input.brandName.trim(),
    p_epa_registration: input.epaRegistration.trim() || null,
    p_manufacturer: input.manufacturer.trim() || null,
    p_is_currently_sourced: input.isCurrentlySourced,
    p_is_rup: input.isRup,
    p_signal_word: input.signalWord,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  return assertRpcResult<ProductBrand>(data, 'upsert_product_brand');
}

/** Plain-English message for a failed brand save. */
export function productBrandErrorMessage(error: unknown): string {
  if (hasRpcCode(error, RpcErrorCodes.BRAND_NAME_TAKEN)) return 'This product already lists a brand with that name.';
  if (hasRpcCode(error, RpcErrorCodes.BRAND_CHANGED)) return 'Someone else changed this brand. The list has been reloaded; open it again to edit.';
  if (hasRpcCode(error, RpcErrorCodes.EPA_REGISTRATION_INVALID)) return 'That is not an EPA registration number (like 524-475 or 100-1234-5905).';
  if (hasRpcCode(error, RpcErrorCodes.BRAND_NAME_REQUIRED)) return 'Enter the brand name.';
  if (hasRpcCode(error, RpcErrorCodes.BRAND_TEXT_TOO_LONG)) return 'Brand and manufacturer names are limited to 200 characters.';
  if (hasRpcCode(error, RpcErrorCodes.BRAND_NOT_FOUND) || hasRpcCode(error, RpcErrorCodes.PRODUCT_NOT_FOUND)) {
    return 'This brand or product no longer exists. Reload the page.';
  }
  if (hasRpcCode(error, RpcErrorCodes.NOT_AUTHORIZED)) return 'Only an admin can change a product’s brands.';
  if (hasRpcCode(error, RpcErrorCodes.IDEMPOTENCY_INTENT_MISMATCH)) {
    return 'This save conflicts with an earlier attempt. Close the form, reload the page and try again.';
  }
  return sanitizeError(error);
}

/**
 * Brand names written inside a product's name, e.g. "Roundup 5.4# Generic (Ag Saver 5.4, Slam 5.4) - 2.5 Gal"
 * → ["Ag Saver 5.4", "Slam 5.4"]. Only suggestions: some parentheses hold notes, not brands, so an admin
 * confirms each one (and types its EPA number) before it is saved. Names already listed are left out.
 */
export function suggestBrandNamesFromProductName(productName: string, existingNames: string[] = []): string[] {
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  const suggestions: string[] = [];
  for (const match of productName.matchAll(/\(([^()]*)\)/g)) {
    for (const part of match[1].split(/,|\//)) {
      const name = part.trim();
      const key = name.toLowerCase();
      if (name && !taken.has(key)) {
        taken.add(key);
        suggestions.push(name);
      }
    }
  }
  return suggestions;
}
