/**
 * Goal 5 completion evidence (migration 20261022075000). Every delivery completion tells the
 * server how the customer confirmed it (p_evidence) and exactly which artifact proves it
 * (p_evidence_ref), and the server refuses unless that artifact is saved:
 *   signature     the on-screen signature image, uploaded BEFORE the completion call to a path the
 *                 server recomputes from the call's own retry key (signatureImagePathFor), by the
 *                 caller. No storage rule lets that file be replaced or deleted afterwards.
 *   paper_ticket  the delivery_photos row of the signed ticket the screen shows as saved;
 *   left_at_site  the delivery_photos row of the drop-location photo (field stop, no one present);
 *   no_proof      admin only: no customer proof; the reference is the admin's written reason and
 *                 the signer is NO_PROOF_SIGNER (see paperTicket.ts).
 * A refused completion changes no delivery, stock or invoice.
 */
import { supabase, assertRpcResult, checkMutationResult } from './db';
import { compressImage } from './imageCompression';
import { Sentry } from './sentry';
import { normalizeNoProofReason } from './paperTicket';
import type { DeliveryEvidencePhoto, ReceiptRecipient } from '../types';

/**
 * The only signature path complete_delivery accepts for this retry key:
 * signatures/<delivery id>/<first 32 hex of sha256(key)>.png. The Deliveries list calls
 * start_and_complete_delivery, which completes under `<key>:complete`, so it hashes that string.
 */
export async function signatureImagePathFor(deliveryId: string, completionKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(completionKey));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `signatures/${deliveryId}/${hex.slice(0, 32)}.png`;
}

/** A short digest of the drawn signature, so a re-drawn signature makes a new retry key (and file). */
export async function signatureDigest(signatureDataUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signatureDataUrl));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/**
 * True only for a non-empty PNG data URL, the shape SignatureCanvas produces. Anything else
 * (empty, truncated, another type) is refused before any upload or server call, because the
 * server would refuse an empty image anyway and the driver should re-sign now, not later.
 */
export function isSignatureDataUrl(signatureDataUrl: string | null | undefined): signatureDataUrl is string {
  if (!signatureDataUrl) return false;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(signatureDataUrl);
  if (!match || match[1].length % 4 !== 0) return false;
  // At least 500 decoded bytes, as the server requires (padding '=' carries no bytes): a drawn
  // signature is always larger than that.
  const padding = match[1].endsWith('==') ? 2 : match[1].endsWith('=') ? 1 : 0;
  if ((match[1].length / 4) * 3 - padding < MIN_SIGNATURE_BYTES) return false;
  // The bytes must start with the PNG file signature, not just carry a PNG label.
  return match[1].startsWith(PNG_SIGNATURE_BASE64);
}

/** The 8-byte PNG file signature (89 50 4E 47 0D 0A 1A 0A) as the first 11 base64 characters; the 11th
 * also carries the top 2 bits of the IHDR chunk length, which are always 0. */
const PNG_SIGNATURE_BASE64 = 'iVBORw0KGgo';
/** The server's minimum signature size, in bytes. */
const MIN_SIGNATURE_BYTES = 500;

export const INVALID_SIGNATURE_MESSAGE =
  'The signature could not be read. Nothing was sent; clear the signature box and have the customer sign again.';

function isAlreadyExists(error: { message?: string; statusCode?: string | number; status?: number }): boolean {
  return String(error.statusCode ?? error.status ?? '') === '409' || /already exists|duplicate/i.test(error.message ?? '');
}

/**
 * Uploads the on-screen signature (a PNG data URL) to its per-attempt path; throws when it is not
 * saved. The file is never overwritten: a retry of the same key finds it already there, which counts
 * as saved (it is the same attempt's image).
 *
 * A throw does NOT mean the delivery is not completed: after a lost reply the earlier attempt may
 * already have completed it, and storage then refuses the re-upload. Callers still send the
 * completion with the same key; the server replays that completion or refuses SIGNATURE_IMAGE_MISSING.
 */
export async function uploadSignatureImage(path: string, signatureDataUrl: string): Promise<void> {
  if (!isSignatureDataUrl(signatureDataUrl)) throw new Error('The signature image is empty or unreadable.');
  const base64Data = signatureDataUrl.split(',')[1] ?? '';
  const byteCharacters = atob(base64Data);
  const byteArray = new Uint8Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) byteArray[i] = byteCharacters.charCodeAt(i);
  const blob = new Blob([byteArray], { type: 'image/png' });
  // Storage reports failures through the returned error, not a throw.
  const { error } = await supabase.storage
    .from('delivery-signatures')
    .upload(path, blob, { upsert: false, contentType: 'image/png' });
  if (error && !isAlreadyExists(error as { message?: string; statusCode?: string | number; status?: number })) {
    throw new Error(`The signature could not be saved: ${error.message}`);
  }
}

/** The leading token of a server refusal (e.g. SIGNATURE_IMAGE_MISSING), or null. */
export function completionRefusalCode(error: unknown): string | null {
  const message = typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message?: unknown }).message ?? '')
    : typeof error === 'string' ? error : '';
  return /^([A-Z][A-Z0-9_]{3,})\b/.exec(message)?.[1] ?? null;
}

/** The server found no image at this attempt's signature path: this key can never complete, so retire it. */
export function isSignatureImageMissing(error: unknown): boolean {
  return completionRefusalCode(error) === 'SIGNATURE_IMAGE_MISSING';
}

/**
 * The newest photo with this caption, as the screen shows it: the one sent as the evidence.
 * Picked by uploaded_at; photos without one (or with the same time) keep their list order.
 */
export function latestEvidencePhoto<T extends { id: string; caption?: string | null; uploaded_at?: string | null }>(
  photos: ReadonlyArray<T>,
  caption: string,
): T | undefined {
  let latest: T | undefined;
  let latestTime = Number.NaN;
  for (const photo of photos) {
    if (photo.caption !== caption) continue;
    const time = photo.uploaded_at ? Date.parse(photo.uploaded_at) : Number.NaN;
    if (!latest || Number.isNaN(time) || Number.isNaN(latestTime) || time >= latestTime) {
      latest = photo;
      latestTime = time;
    }
  }
  return latest;
}

/** Merges two photo lists by id (later entries replace earlier ones with the same id). */
export function mergePhotosById<T extends { id: string }>(first: ReadonlyArray<T>, second: ReadonlyArray<T>): T[] {
  const byId = new Map<string, T>();
  for (const photo of [...first, ...second]) byId.set(photo.id, photo);
  return [...byId.values()];
}

/** Saves one evidence photo (file + delivery_photos row) for the Deliveries list's dialog; throws on failure. */
export async function uploadEvidencePhoto(
  deliveryId: string,
  rawFile: File,
  uploadedBy: string,
  caption: string,
): Promise<DeliveryEvidencePhoto> {
  const file = await compressImage(rawFile);
  const ext = file.name.split('.').pop() || 'jpg';
  // The server accepts only a file in this delivery's own folder.
  const storagePath = `delivery-photos/${deliveryId}/${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const { error: uploadErr } = await supabase.storage
    .from('delivery-photos')
    .upload(storagePath, file, { contentType: file.type, cacheControl: '0' });
  if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`);
  // Place it after the delivery's existing photos, as the detail page does. The order is display
  // only, so a failed count still saves the photo (at the front).
  const { count, error: countErr } = await supabase
    .from('delivery_photos')
    .select('id', { count: 'exact', head: true })
    .eq('delivery_id', deliveryId);
  if (countErr) Sentry.captureException(countErr, { level: 'warning', extra: { context: 'Count delivery photos for sort order', deliveryId } });
  const { data: urlData } = supabase.storage.from('delivery-photos').getPublicUrl(storagePath);
  const result = await supabase.from('delivery_photos').insert({
    delivery_id: deliveryId,
    storage_path: storagePath,
    image_url: urlData.publicUrl,
    uploaded_by: uploadedBy,
    file_size: file.size,
    sort_order: count ?? 0,
    caption,
  }).select('id, storage_path, image_url, caption, uploaded_at');
  checkMutationResult(result, 'Insert delivery photo');
  const row = (result.data || [])[0] as DeliveryEvidencePhoto | undefined;
  if (!row) throw new Error('The photo was uploaded but not recorded. Please try again.');
  return row;
}

/**
 * The customer's receipt email, read through get_delivery_receipt_recipient while the delivery is
 * open: an assigned driver may not see the customer row itself (customers_select hides a stop
 * scheduled before yesterday), which used to skip the receipt. Returns null when it cannot be read.
 */
export async function fetchReceiptRecipient(deliveryId: string): Promise<ReceiptRecipient | null> {
  const { data, error } = await supabase.rpc('get_delivery_receipt_recipient', { p_delivery_id: deliveryId });
  if (error || !data) {
    if (error) Sentry.captureException(error, { level: 'warning', extra: { context: 'Receipt recipient lookup failed', deliveryId } });
    return null;
  }
  const row = assertRpcResult<{ email?: unknown; contact_name?: unknown; farm_name?: unknown }>(data, 'get_delivery_receipt_recipient');
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
  return { email: text(row.email), contactName: text(row.contact_name), farmName: text(row.farm_name) };
}

export const RECEIPT_LOOKUP_TIMEOUT_MS = 5000;

/**
 * fetchReceiptRecipient, but never holds up a completion: resolves null after `timeoutMs`
 * (or on any failure). The completion runs either way; only the receipt is skipped.
 */
export async function fetchReceiptRecipientWithin(deliveryId: string, timeoutMs = RECEIPT_LOOKUP_TIMEOUT_MS): Promise<ReceiptRecipient | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    return await Promise.race([fetchReceiptRecipient(deliveryId).catch(() => null), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A failure that looks like no connection (the request may never have reached storage or the server). */
export function isNetworkFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message?: unknown }).message ?? '')
    : String(error ?? '');
  return /failed to fetch|networkerror|network request failed|load failed|timed? ?out|offline/i.test(message);
}

// Shown when the delivery turned out completed after a failed reply, but the identical replay of this
// attempt also failed, so this screen could not run the receipt and follow-ups itself.
export const COMPLETED_BY_EARLIER_ATTEMPT_MESSAGE =
  'This delivery is completed (an earlier attempt went through). No receipt was emailed from here; use Email Confirmation.';

/**
 * What a failed completion call left behind, read from the server:
 *   replayed               the delivery is completed and the IDENTICAL call (same key, same inputs)
 *                          returned the saved result: run the normal success path with `result`;
 *   completed_not_replayed it is completed, but the identical replay failed too;
 *   open                   still scheduled or in progress: nothing changed;
 *   closed                 cancelled, voided or another final status, or completed while this key
 *                          was retired (it can never replay);
 *   unknown                the status could not be read.
 */
export type FailedCompletionOutcome =
  | { kind: 'replayed'; result: unknown }
  | { kind: 'completed_not_replayed' }
  | { kind: 'open' }
  | { kind: 'closed' }
  | { kind: 'unknown' };

/**
 * After a completion call failed or its reply was lost, read the delivery's status. If it is completed
 * and this attempt's key is still held (no binding refusal, no SIGNATURE_IMAGE_MISSING), the server may
 * have committed THIS attempt: `resend` must send the identical call with the same key, and the server
 * replays the saved result before any status or evidence check. Never resend with different inputs.
 */
export async function reconcileFailedCompletion(opts: {
  deliveryId: string;
  keyHeld: boolean;
  resend: () => Promise<unknown>;
  context: string;
}): Promise<FailedCompletionOutcome> {
  const { data, error } = await supabase.from('deliveries').select('status').eq('id', opts.deliveryId).maybeSingle();
  if (error) {
    Sentry.captureException(error, { level: 'warning', extra: { context: `${opts.context}: status check after a failed completion`, deliveryId: opts.deliveryId } });
    return { kind: 'unknown' };
  }
  const status = (data as { status?: string } | null)?.status;
  if (!status) return { kind: 'unknown' };
  if (status === 'scheduled' || status === 'in_progress') return { kind: 'open' };
  if (status !== 'completed') return { kind: 'closed' };
  // A retired key can never replay: show the delivery as it is now (the refusal already said why).
  if (!opts.keyHeld) return { kind: 'closed' };
  try {
    return { kind: 'replayed', result: await opts.resend() };
  } catch (replayError) {
    Sentry.captureException(replayError, { level: 'warning', extra: { context: `${opts.context}: identical replay after a lost reply failed`, deliveryId: opts.deliveryId } });
    return { kind: 'completed_not_replayed' };
  }
}

/**
 * The no-proof reason as the server stored it (completion_evidence_ref), for the activity log. Falls
 * back to the typed reason normalized the server's way when it cannot be read.
 */
export async function storedNoProofReason(deliveryId: string, typedReason: string): Promise<string> {
  const { data, error } = await supabase.from('deliveries').select('completion_evidence_ref').eq('id', deliveryId).maybeSingle();
  if (error) Sentry.captureException(error, { level: 'warning', extra: { context: 'Read the stored no-proof reason for the activity log', deliveryId } });
  const stored = (data as { completion_evidence_ref?: string | null } | null)?.completion_evidence_ref;
  return stored && stored.trim() ? stored : normalizeNoProofReason(typedReason);
}
