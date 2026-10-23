import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  countLeftAtSitePhotos, countOrdinaryPhotos, countPaperTicketPhotos, hasLeftAtSitePhoto, hasPaperTicketPhoto,
  isValidNoProofReason, LEFT_AT_SITE_PHOTO_CAPTION, NO_PROOF_SIGNER, noProofReasonLength, normalizeNoProofReason,
  PAPER_TICKET_PHOTO_CAPTION,
} from './paperTicket';
import {
  completionRefusalCode, fetchReceiptRecipientWithin, isNetworkFailure, isSignatureDataUrl, isSignatureImageMissing, latestEvidencePhoto,
  mergePhotosById, signatureImagePathFor,
} from './deliveryEvidence';
import { sanitizeError } from './errorSanitizer';
import { supabase } from './db';

// The captions and the signature path must match complete_delivery's evidence check
// (migration 20261022075000) exactly, or every photo or signature completion is refused.
describe('Goal 5 completion evidence', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('uses the exact captions and the per-attempt signature path the server recomputes', async () => {
    expect(PAPER_TICKET_PHOTO_CAPTION).toBe('Signed paper delivery ticket');
    expect(LEFT_AT_SITE_PHOTO_CAPTION).toBe('Left at site — drop location');
    // left(encode(sha256(convert_to('abc', 'UTF8')), 'hex'), 32) in PostgreSQL.
    expect(await signatureImagePathFor('d-1', 'abc')).toBe('signatures/d-1/ba7816bf8f01cfea414140de5dae2223.png');
    expect(await signatureImagePathFor('d-1', 'abc:complete')).not.toBe(await signatureImagePathFor('d-1', 'abc'));
  });

  it('sends the newest saved photo with the caption', () => {
    const photos = [
      { id: 'a', caption: PAPER_TICKET_PHOTO_CAPTION }, { id: 'b', caption: null }, { id: 'c', caption: PAPER_TICKET_PHOTO_CAPTION },
    ];
    expect(latestEvidencePhoto(photos, PAPER_TICKET_PHOTO_CAPTION)?.id).toBe('c');
    expect(latestEvidencePhoto(photos, LEFT_AT_SITE_PHOTO_CAPTION)).toBeUndefined();
  });

  it('picks the newest photo by upload time, not list position', () => {
    const photos = [
      { id: 'new', caption: PAPER_TICKET_PHOTO_CAPTION, uploaded_at: '2026-10-21T15:00:00.000Z' },
      { id: 'old', caption: PAPER_TICKET_PHOTO_CAPTION, uploaded_at: '2026-10-21T14:00:00.000Z' },
    ];
    expect(latestEvidencePhoto(photos, PAPER_TICKET_PHOTO_CAPTION)?.id).toBe('new');
  });

  it('merges loaded photos with ones added meanwhile, by id', () => {
    const loaded = [{ id: 'a', caption: 'x' }, { id: 'b', caption: 'x' }];
    const local = [{ id: 'b', caption: 'x' }, { id: 'c', caption: 'x' }];
    expect(mergePhotosById(loaded, local).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('counts evidence photos apart from the 10 ordinary photos', () => {
    const photos = [
      { caption: null }, { caption: 'Pallet by the shed' },
      { caption: PAPER_TICKET_PHOTO_CAPTION }, { caption: LEFT_AT_SITE_PHOTO_CAPTION }, { caption: LEFT_AT_SITE_PHOTO_CAPTION },
    ];
    expect(countOrdinaryPhotos(photos)).toBe(2);
    expect(countPaperTicketPhotos(photos)).toBe(1);
    expect(countLeftAtSitePhotos(photos)).toBe(2);
    expect(hasPaperTicketPhoto(photos)).toBe(true);
    expect(hasLeftAtSitePhoto([{ caption: PAPER_TICKET_PHOTO_CAPTION }])).toBe(false);
  });

  it('refuses an empty or malformed signature before anything is sent', () => {
    expect(isSignatureDataUrl(null)).toBe(false);
    expect(isSignatureDataUrl('')).toBe(false);
    expect(isSignatureDataUrl('data:image/png;base64,')).toBe(false);
    expect(isSignatureDataUrl('data:image/jpeg;base64,iVBORw0KGgo=')).toBe(false);
    expect(isSignatureDataUrl('data:image/png;base64,iVBOR w0KGgo=')).toBe(false);
    // Just the 8-byte PNG header is not a drawn signature (the server wants at least 500 bytes).
    expect(isSignatureDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(false);
    expect(isSignatureDataUrl(`data:image/png;base64,iVBORw0KGgo${'A'.repeat(669)}`)).toBe(true);
    // The size counts decoded bytes, not characters: 668 characters with '==' padding are 499 bytes.
    expect(isSignatureDataUrl(`data:image/png;base64,iVBORw0KGgo${'A'.repeat(655)}==`)).toBe(false);
    expect(isSignatureDataUrl(`data:image/png;base64,iVBORw0KGgo${'A'.repeat(656)}=`)).toBe(true);
    // Labelled PNG but not PNG bytes.
    expect(isSignatureDataUrl('data:image/png;base64,AAAAAAAAAAAA')).toBe(false);
  });

  it('explains each server refusal in plain English and says this attempt changed nothing', () => {
    for (const code of [
      'SIGNATURE_IMAGE_MISSING', 'PAPER_TICKET_PHOTO_MISSING', 'LEFT_AT_SITE_PHOTO_MISSING', 'LEFT_AT_SITE_SIGNER_MISMATCH',
      'COMPLETION_EVIDENCE_INVALID', 'COMPLETION_EVIDENCE_LOCKED', 'COMPLETION_EVIDENCE_NOT_RECORDED',
      'NO_PROOF_ADMIN_ONLY', 'NO_PROOF_REASON_REQUIRED', 'NO_PROOF_SIGNER_MISMATCH',
    ]) {
      const message = sanitizeError({ code: '23514', message: `${code}: detail` });
      expect(message).toMatch(/^This attempt made no change \(no stock or invoice change\)/);
      expect(message).not.toContain(code);
    }
    // These can follow a lost reply whose earlier attempt did complete: say so.
    for (const code of ['COMPLETION_EVIDENCE_INVALID', 'COMPLETION_EVIDENCE_LOCKED', 'COMPLETION_EVIDENCE_NOT_RECORDED']) {
      expect(sanitizeError({ message: `${code}: detail` })).toMatch(/may already be completed by an earlier attempt/);
    }
    // COMPLETION_EVIDENCE_INVALID is generic now: it no longer assumes a signature or ticket.
    expect(sanitizeError({ message: 'COMPLETION_EVIDENCE_INVALID: x' })).not.toMatch(/signed ticket/);
    // An old app may be retrying a completion that already went through: never claim nothing happened.
    const outdated = sanitizeError({ code: '22023', message: 'COMPLETION_EVIDENCE_REQUIRED: detail' });
    expect(outdated).toMatch(/check whether it is already completed/);
    expect(outdated).not.toMatch(/nothing was saved/i);
  });

  it('recognizes the refusal that retires a signature key', () => {
    expect(isSignatureImageMissing({ message: 'SIGNATURE_IMAGE_MISSING: no image' })).toBe(true);
    expect(isSignatureImageMissing({ message: 'PAPER_TICKET_PHOTO_MISSING: x' })).toBe(false);
    expect(isSignatureImageMissing(new Error('network down'))).toBe(false);
    expect(completionRefusalCode({ message: 'NO_PROOF_ADMIN_ONLY: x' })).toBe('NO_PROOF_ADMIN_ONLY');
  });

  it('tells a lost connection apart from a storage refusal', () => {
    expect(isNetworkFailure(new Error('The signature could not be saved: Failed to fetch'))).toBe(true);
    expect(isNetworkFailure(new TypeError('NetworkError when attempting to fetch resource.'))).toBe(true);
    expect(isNetworkFailure(new Error('The signature could not be saved: new row violates row-level security policy'))).toBe(false);
  });

  it('words refusals that can follow a lost reply without assuming nothing happened', () => {
    expect(sanitizeError({ message: 'NO_PROOF_ADMIN_ONLY: x' })).toMatch(/may already be completed by an earlier attempt/);
    expect(sanitizeError({ message: 'SIGNATURE_IMAGE_MISSING: x' })).toMatch(/then try again$/);
  });

  it('gives up on the receipt lookup after the timeout instead of holding the completion', async () => {
    vi.useFakeTimers();
    const client = supabase as unknown as { rpc: (...args: unknown[]) => unknown };
    vi.spyOn(client, 'rpc').mockReturnValue(new Promise(() => { /* never answers */ }));
    const pending = fetchReceiptRecipientWithin('d-1', 5000);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBeNull();
  });
});

// The server measures the reason after btrim(regexp_replace(reason, '[[:space:]]+', ' ', 'g')).
describe('no-proof reason', () => {
  it('uses the exact signer text the server requires (em dash)', () => {
    expect(NO_PROOF_SIGNER).toBe('No proof — recorded by office');
  });

  it('collapses every whitespace run to one space and trims the ends', () => {
    expect(normalizeNoProofReason('  Customer\t\tcalled\n\nto confirm  ')).toBe('Customer called to confirm');
    expect(normalizeNoProofReason('\t\t\t')).toBe('');
    expect(normalizeNoProofReason('\n\r\n')).toBe('');
    expect(normalizeNoProofReason('a \t\n\v\f\r b')).toBe('a b');
    // [[:space:]] in the database's UTF-8 locale also matches Unicode spaces.
    expect(normalizeNoProofReason(' called　 back\u0085')).toBe('called back');
  });

  it('accepts 10 to 500 characters after collapsing, counting characters not UTF-16 units', () => {
    expect(isValidNoProofReason('')).toBe(false);
    expect(isValidNoProofReason(' '.repeat(40))).toBe(false);
    expect(isValidNoProofReason('123456789')).toBe(false);
    expect(isValidNoProofReason('  1234 \n\n 56789 ')).toBe(true); // "1234 56789" = 10
    expect(isValidNoProofReason('x'.repeat(500))).toBe(true);
    expect(isValidNoProofReason('x'.repeat(501))).toBe(false);
    expect(noProofReasonLength('\u{1F69C}'.repeat(3))).toBe(3);
    expect(isValidNoProofReason('\u{1F69C}'.repeat(500))).toBe(true);
  });
});
