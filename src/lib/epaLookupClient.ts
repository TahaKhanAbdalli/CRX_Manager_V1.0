import { supabase } from './db';
import { waitForEpaRequestSlot } from './epaRequestThrottle';
import type { EpaLookupResult } from '../types';

export function isEpaLookupResult(value: unknown): value is EpaLookupResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<EpaLookupResult>;
  const nullableString = (field: unknown) => field === null || typeof field === 'string';
  const canonicalSignalWord = result.signalWordCanonical === null
    || result.signalWordCanonical === 'Danger'
    || result.signalWordCanonical === 'Warning'
    || result.signalWordCanonical === 'Caution';
  const activeIngredientsValid = Array.isArray(result.activeIngredients)
    && result.activeIngredients.every((ingredient) => (
      ingredient
      && typeof ingredient === 'object'
      && typeof ingredient.name === 'string'
      && (ingredient.percent === null
        || (typeof ingredient.percent === 'number' && Number.isFinite(ingredient.percent)))
      && nullableString(ingredient.pcCode)
      && nullableString(ingredient.casNumber)
    ));
  const labelPdfsValid = Array.isArray(result.labelPdfs)
    && result.labelPdfs.every((pdf) => (
      pdf
      && typeof pdf === 'object'
      && typeof pdf.fileName === 'string'
      && nullableString(pdf.acceptedDate)
      && typeof pdf.url === 'string'
    ));
  return typeof result.found === 'boolean'
    && (result.regType === 'section3' || result.regType === 'distributor')
    && nullableString(result.eparegno)
    && nullableString(result.productname)
    && canonicalSignalWord
    && typeof result.needsManual === 'boolean'
    && nullableString(result.manufacturer)
    && (result.rupYn === null || result.rupYn === 'Yes' || result.rupYn === 'No')
    && nullableString(result.productStatus)
    && typeof result.isCancelled === 'boolean'
    && nullableString(result.latestLabelPdfUrl)
    && activeIngredientsValid
    && labelPdfsValid;
}

export async function epaFunctionErrorMessage(error: unknown): Promise<string> {
  if (error && typeof error === 'object' && 'context' in error) {
    const context = (error as { context?: unknown }).context;
    if (typeof Response !== 'undefined' && context instanceof Response) {
      try {
        const payload = await context.clone().json() as { error?: unknown };
        if (typeof payload.error === 'string' && payload.error.trim()) return payload.error;
      } catch {
        // Fall through to the SDK error message when the response is not JSON.
      }
    }
  }
  if (error && typeof error === 'object' && 'message' in error
      && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return 'EPA lookup failed. Please try again.';
}

/**
 * Looks up one EPA registration number through the epa-lookup Edge Function (admin only),
 * waiting for the shared request slot so callers can't exceed the EPA rate limit.
 * Returns null if `shouldCancel` cancelled the wait; throws an Error with a user-facing message.
 */
export async function lookupEpaRegistration(
  regNumber: string,
  shouldCancel: () => boolean = () => false,
): Promise<EpaLookupResult | null> {
  const slotReady = await waitForEpaRequestSlot(shouldCancel);
  if (!slotReady) return null;
  const { data, error } = await supabase.functions.invoke<EpaLookupResult>('epa-lookup', {
    body: { regNumber },
  });
  if (error) throw new Error(await epaFunctionErrorMessage(error));
  if (data && typeof data === 'object' && 'error' in data
      && typeof (data as { error?: unknown }).error === 'string') {
    throw new Error((data as { error: string }).error);
  }
  if (!isEpaLookupResult(data)) {
    throw new Error('EPA lookup returned an invalid response. Please try again.');
  }
  return data;
}
