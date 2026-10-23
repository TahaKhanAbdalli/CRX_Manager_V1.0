/**
 * Goal 5 paper fallback (Mason, 2026-10-15): with no signal at the customer, the
 * driver gets a paper delivery ticket signed on site. Back in signal, the driver
 * completes the delivery in the app with a photo of that signed ticket in place
 * of the on-screen signature. The app never captures a signature after the fact.
 *
 * The ticket photo is an ordinary delivery photo carrying this caption, so it is
 * stored, protected and shown exactly like every other delivery photo.
 *
 * Since migration 20261022075000 the server enforces it: complete_delivery takes
 * p_evidence and refuses a paper_ticket completion without a ticket photo on the
 * delivery (and a signature completion without its saved image); see deliveryEvidence.ts.
 */
import { todayInBusinessTz } from './dateUtils';

export const PAPER_TICKET_PHOTO_CAPTION = 'Signed paper delivery ticket';
// The field stop's "No one present — left at site" path needs a photo of the drop location
// instead (left_at_site). Both captions must match complete_delivery's evidence check exactly.
export const LEFT_AT_SITE_PHOTO_CAPTION = 'Left at site — drop location';
const EVIDENCE_PHOTO_CAPTIONS: ReadonlySet<string> = new Set([PAPER_TICKET_PHOTO_CAPTION, LEFT_AT_SITE_PHOTO_CAPTION]);

// Admin-only "Record without proof" (no_proof): there is no customer signature or photo, so the
// "Signed by" field never names a customer. complete_delivery requires exactly this text
// (NO_PROOF_SIGNER_MISMATCH otherwise) and a written reason of 10 to 500 characters.
export const NO_PROOF_SIGNER = 'No proof — recorded by office';
export const NO_PROOF_REASON_MIN_CHARS = 10;
export const NO_PROOF_REASON_MAX_CHARS = 500;

// The reason as the server stores and measures it: btrim(regexp_replace(reason, '[[:space:]]+', ' ', 'g')).
// Every run of whitespace becomes one space, then the ends are trimmed. In the database's UTF-8 locale
// [[:space:]] also matches Unicode spaces (e.g. U+2003, U+3000), so every Unicode White_Space
// character collapses here too. The server counts characters (code points), not UTF-16 units, so
// emoji count once here too.
export function normalizeNoProofReason(reason: string): string {
  return reason.replace(/\p{White_Space}+/gu, ' ').replace(/^ | $/g, '');
}

export function noProofReasonLength(reason: string): number {
  return [...normalizeNoProofReason(reason)].length;
}

export function isValidNoProofReason(reason: string): boolean {
  const length = noProofReasonLength(reason);
  return length >= NO_PROOF_REASON_MIN_CHARS && length <= NO_PROOF_REASON_MAX_CHARS;
}

// A paper-ticket delivery is completed later, once back in signal, so the driver
// records the day it really happened. That day becomes the delivery and invoice date.
// The ticket date is required on the paper path and can never be in the future.
// "Today" is the business day in America/Chicago, the day the server dates the delivery.
// A real calendar date (2026-02-31 is refused), today or earlier in Chicago.
export function isValidDeliveredOn(deliveredOn: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(deliveredOn);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const isRealDate =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return isRealDate && deliveredOn <= todayInBusinessTz();
}

export function isValidPaperDeliveredOn(deliveredOn: string): boolean {
  return isValidDeliveredOn(deliveredOn);
}

// The server takes the delivery and invoice date from the completion time in
// America/Chicago. 17:00 UTC is midday in Chicago (12:00 CDT, 11:00 CST), so the
// chosen YYYY-MM-DD lands on that same Chicago day whatever time zone the phone is set to.
export function completedAtForDeliveredOn(deliveredOn: string): string {
  return `${deliveredOn}T17:00:00.000Z`;
}

export function paperDeliveredAt(deliveredOn: string): string | undefined {
  if (!deliveredOn || deliveredOn === todayInBusinessTz()) return undefined;
  return completedAtForDeliveredOn(deliveredOn);
}

// The completion time sent under one retry key: worked out on the key's first send and
// reused by every retry of that key. Since 20261019200000, complete_delivery replays a
// saved result only for the exact same request, p_completed_at included. A "today"
// completion sends none, but after midnight "today" is a past date that would send one,
// so recomputing on a retry across midnight would turn the replay into a refusal.
export function completedAtForKey(
  sent: Map<string, string | undefined>,
  key: string,
  compute: () => string | undefined,
): string | undefined {
  if (!sent.has(key)) sent.set(key, compute());
  return sent.get(key);
}

// Ticket and drop-location photos do not count toward the 10-photo limit, so a delivery that
// already has 10 ordinary photos can still be completed on either photo path.
export const MAX_ORDINARY_DELIVERY_PHOTOS = 10;

export function countOrdinaryPhotos(photos: ReadonlyArray<{ caption?: string | null }>): number {
  return photos.filter((photo) => !photo.caption || !EVIDENCE_PHOTO_CAPTIONS.has(photo.caption)).length;
}

// Ticket photos are bounded on their own: a front and a back is enough.
export const MAX_PAPER_TICKET_PHOTOS = 2;

export function countPaperTicketPhotos(photos: ReadonlyArray<{ caption?: string | null }>): number {
  return photos.filter((photo) => photo.caption === PAPER_TICKET_PHOTO_CAPTION).length;
}

export function hasPaperTicketPhoto(photos: ReadonlyArray<{ caption?: string | null }>): boolean {
  return photos.some((photo) => photo.caption === PAPER_TICKET_PHOTO_CAPTION);
}

// A drop-location photo is bounded the same way as a ticket photo.
export const MAX_LEFT_AT_SITE_PHOTOS = 2;

export function countLeftAtSitePhotos(photos: ReadonlyArray<{ caption?: string | null }>): number {
  return photos.filter((photo) => photo.caption === LEFT_AT_SITE_PHOTO_CAPTION).length;
}

export function hasLeftAtSitePhoto(photos: ReadonlyArray<{ caption?: string | null }>): boolean {
  return photos.some((photo) => photo.caption === LEFT_AT_SITE_PHOTO_CAPTION);
}
