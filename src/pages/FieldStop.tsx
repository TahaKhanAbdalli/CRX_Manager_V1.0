/**
 * Field Mode — per-stop runner ("/my-route/:id").
 *
 * The guided, one-thing-per-screen flow for a single delivery stop. ADDITIVE:
 * reuses the existing delivery RPCs/components; never edits DeliveryDetail.tsx.
 *
 * Flow: status-driven entry (scheduled → Arrive; in_progress → Verify) →
 * Verify items (full/short) → Signature → Review & Complete (optional photo)
 * → Done. Completion mirrors DeliveryDetail.handleComplete exactly (same
 * rpcParams, signature upload, notifications, customer email, invoice surfacing).
 * Completing needs a signal (Goal 5, Mason 2026-10-15): nothing is queued offline,
 * and a signed paper ticket photo can stand in for the on-screen signature. See
 * docs/roadmap/field-mode-build-plan.md.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, MapPin, PlayCircle, WifiOff, Minus, Plus, AlertTriangle, ChevronRight,
  Camera, PenLine, CheckCircle2, ClipboardCheck, FileText,
} from 'lucide-react';
import SignatureCanvas from '../components/ui/SignatureCanvas';
import { supabase, assertRpcResult, sanitizeError, checkMutationResult } from '../lib/db';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/ui/Toast';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useLatestRef } from '../hooks/useLatestRef';
import { digestIntentPayload, getIdempotencyBindingRejection } from '../lib/idempotency';
import { hasSignal, NO_SIGNAL_MESSAGE } from '../lib/connectivity';
import { countOrdinaryPhotos, countPaperTicketPhotos, countLeftAtSitePhotos, hasPaperTicketPhoto, hasLeftAtSitePhoto, MAX_ORDINARY_DELIVERY_PHOTOS, MAX_PAPER_TICKET_PHOTOS, MAX_LEFT_AT_SITE_PHOTOS, PAPER_TICKET_PHOTO_CAPTION, LEFT_AT_SITE_PHOTO_CAPTION, isValidPaperDeliveredOn, paperDeliveredAt, completedAtForKey } from '../lib/paperTicket';
import { COMPLETED_BY_EARLIER_ATTEMPT_MESSAGE, fetchReceiptRecipient, fetchReceiptRecipientWithin, INVALID_SIGNATURE_MESSAGE, isNetworkFailure, isSignatureDataUrl, isSignatureImageMissing, latestEvidencePhoto, reconcileFailedCompletion, signatureDigest, signatureImagePathFor, uploadSignatureImage } from '../lib/deliveryEvidence';
import type { DeliveryCompletionEvidence, ReceiptRecipient } from '../types';
import { compressImage } from '../lib/imageCompression';
import { todayInBusinessTz } from '../lib/dateUtils';
import { logActivity } from '../lib/activityLogger';
import { notifyDeliveryCompleted, notifyDeliveryRemainder } from '../lib/notificationTriggers';
import { RECEIPT_NO_EMAIL_MESSAGE, RECEIPT_NO_EMAIL_ON_FILE_MESSAGE, RECEIPT_NOT_SENT_MESSAGE, sendDeliveryCompletionEmail } from '../lib/deliveryCompletionEmail';
import { Sentry } from '../lib/sentry';
import PrivatePhoto from '../components/ui/PrivatePhoto';
import { deliveryPhotoPath } from '../lib/privatePhotos';

interface StopItem {
  id: string;
  quantity: number;
  product_id: string | null;
  product: { product_name: string | null } | null;
}

interface StopPhoto {
  id: string;
  storage_path: string | null;
  image_url: string;
  caption: string | null;
  uploaded_at?: string | null;
}

interface StopDelivery {
  id: string;
  delivery_number: string | null;
  status: string;
  updated_at: string | null;
  customer_id: string;
  order_id: string | null;
  created_by: string | null;
  delivery_address_id: string | null;
  delivery_notes: string | null;
  assigned_driver: string | null;
  customer: { farm_name: string | null; email: string | null; contact_name: string | null } | null;
}

type Step = 'arrive' | 'verify' | 'sign' | 'review' | 'done';
const STEP_ORDER: Step[] = ['arrive', 'verify', 'sign', 'review', 'done'];

export default function FieldStop() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile } = useAuth();
  const { toast } = useToast();
  const isOnline = useOnlineStatus();
  const confirmIdem = useIdempotencyKey('confirm_delivery', profile?.id || '');
  const completeIdem = useIdempotencyKey('complete_delivery', profile?.id || '');
  // Retry key -> the p_completed_at its first send carried (see completedAtForKey).
  const sentCompletedAt = useRef(new Map<string, string | undefined>());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const paperTicketInputRef = useRef<HTMLInputElement>(null);
  const leftAtSiteInputRef = useRef<HTMLInputElement>(null);
  // Latest stop id the route is showing — older in-flight fetches bail (H3 stale guard).
  const activeStopIdRef = useRef<string | undefined>(undefined);

  const [delivery, setDelivery] = useState<StopDelivery | null>(null);
  const [items, setItems] = useState<StopItem[]>([]);
  const [itemsError, setItemsError] = useState(false);
  const [photos, setPhotos] = useState<StopPhoto[]>([]);
  const [deliveryQtys, setDeliveryQtys] = useState<Record<string, number>>({});
  const [addressLine, setAddressLine] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [step, setStep] = useState<Step>('arrive');
  const [signedBy, setSignedBy] = useState('');
  const [noOnePresent, setNoOnePresent] = useState(false);
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  // Goal 5 paper fallback: a photo of the signed paper ticket replaces the on-screen signature.
  const [usePaperTicket, setUsePaperTicket] = useState(false);
  const [paperDeliveredOn, setPaperDeliveredOn] = useState(todayInBusinessTz());
  // Stop-to-stop navigation reuses this page; never carry paper mode onto the next stop.
  // Also drop the previous stop's photos, so a failed load for this stop shows none
  // (fails closed) instead of letting the last stop's ticket photo pass the check.
  useEffect(() => {
    setUsePaperTicket(false); setNoOnePresent(false); setSignedBy(''); setSignatureDataUrl(null);
    setPaperDeliveredOn(todayInBusinessTz()); setPhotos([]);
  }, [id]);
  const [emailOnComplete, setEmailOnComplete] = useState(true);
  // The receipt address when the customer row is hidden from this driver (see fetchReceiptRecipient).
  const [receiptRecipient, setReceiptRecipient] = useState<ReceiptRecipient | null>(null);
  const [autoInvoiceNumber, setAutoInvoiceNumber] = useState<string | null>(null);

  // Every photo-list read and local add takes a number; only the newest read may replace the list,
  // so a slow older read can never drop a photo added (or keep one removed) after it started.
  const photoSeqRef = useRef(0);
  const fetchPhotos = useCallback(async () => {
    if (!id) return;
    const seq = ++photoSeqRef.current;
    const { data, error } = await supabase
      .from('delivery_photos')
      .select('id, storage_path, image_url, caption, uploaded_at')
      .eq('delivery_id', id)
      .order('sort_order');
    if (activeStopIdRef.current !== id) return; // stale guard (H3)
    if (seq !== photoSeqRef.current) return; // a newer read or local add superseded this one
    if (error) {
      // Keep what is on screen. Clearing it would hide a paper-ticket photo that is
      // already saved and block completion until the stop is reopened.
      Sentry.captureException(error, { extra: { context: 'Field Mode photo list refresh failed' } });
      return;
    }
    setPhotos((data || []) as StopPhoto[]);
  }, [id]);

  const fetchStop = useCallback(async () => {
    if (!id) return;
    // Stale-route guard (H3): on rapid stop-to-stop navigation an older in-flight
    // fetch must not overwrite the current stop's delivery/items/address/photos —
    // handleComplete submits against the live route id plus this component state.
    const isStale = () => activeStopIdRef.current !== id;
    setLoading(true);
    const { data, error } = await supabase
      .from('deliveries')
      .select('id, delivery_number, status, updated_at, customer_id, order_id, created_by, delivery_address_id, delivery_notes, assigned_driver, customer:customers(farm_name, email, contact_name)')
      .eq('id', id)
      .maybeSingle();

    if (isStale()) return;
    if (error || !data) {
      if (error) Sentry.captureException(error, { tags: { source: 'fetch', page: 'field-stop' } });
      toast('error', 'Could not load this stop');
      navigate('/my-route');
      return;
    }

    const del = data as unknown as StopDelivery;
    setDelivery(del);
    setReceiptRecipient(null);
    // Only an open stop sends a receipt on completion.
    if (!del.customer?.email && (del.status === 'scheduled' || del.status === 'in_progress')) {
      void fetchReceiptRecipient(del.id).then((recipient) => { if (!isStale()) setReceiptRecipient(recipient); });
    }
    if (del.status === 'scheduled') setStep('arrive');
    else if (del.status === 'in_progress') setStep('verify');
    else {
      toast('info', `This stop is ${del.status} — opening full detail`);
      navigate(`/deliveries/${del.id}`);
      return;
    }

    const { data: itemData, error: itemErr } = await supabase
      .from('delivery_items')
      .select('id, quantity, product_id, product:products(product_name)')
      .eq('delivery_id', id);
    if (isStale()) return;
    // Don't let a failed items query masquerade as "No items on this delivery".
    setItemsError(!!itemErr);
    if (itemErr) {
      Sentry.captureException(itemErr, { tags: { source: 'fetch', page: 'field-stop-items' } });
      toast('error', 'Could not load delivery items — refresh before completing');
    }
    const loaded = ((itemData || []) as unknown as StopItem[]);
    setItems(loaded);
    const initQtys: Record<string, number> = {};
    loaded.forEach((it) => { initQtys[it.id] = it.quantity; });
    setDeliveryQtys(initQtys);

    if (del.delivery_address_id) {
      const { data: addr } = await supabase
        .from('customer_addresses')
        .select('address_line, city, state, zip')
        .eq('id', del.delivery_address_id)
        .maybeSingle();
      if (isStale()) return;
      if (addr) {
        const a = addr as { address_line?: string | null; city?: string | null; state?: string | null; zip?: string | null };
        setAddressLine([a.address_line, a.city, a.state, a.zip].filter(Boolean).join(', '));
      }
    }
    await fetchPhotos();
    setLoading(false);
  }, [id, navigate, toast, fetchPhotos]);

  useEffect(() => { activeStopIdRef.current = id; fetchStop(); }, [id, fetchStop]);

  // After a successful Arrive, re-read deliveries.updated_at so an offline
  // completion snapshots the POST-arrive value. confirm_delivery bumps
  // updated_at; without this refresh, offlineSync would flag the driver's OWN
  // Arrive as a conflicting external edit and silently drop the queued
  // completion on reconnect.
  const syncAfterArrive = async () => {
    const { data: refreshed, error } = await supabase
      .from('deliveries').select('updated_at').eq('id', id!).maybeSingle();
    const ua = (refreshed as { updated_at?: string | null } | null)?.updated_at ?? null;
    if (error || !ua) {
      // Couldn't confirm the post-Arrive updated_at. Don't leave a STALE
      // (pre-Arrive) timestamp on the row — an offline completion would then
      // snapshot it and self-conflict on replay. Reload fully instead.
      if (error) Sentry.captureException(error, { tags: { source: 'fetch', page: 'field-stop-arrive-resync' } });
      await fetchStop();
      return;
    }
    setDelivery((prev) => (prev ? { ...prev, status: 'in_progress', updated_at: ua } : prev));
    setStep('verify');
  };

  // ── Arrive (confirm_delivery: scheduled → in_progress) ──────────────────
  const handleArrive = async () => {
    if (!delivery || !profile || !id) return;
    // Stale-route guard (H3): never act on a delivery from a different stop than
    // the route currently shows (rapid stop-to-stop switch mid-load).
    if (delivery.id !== id) { toast('error', 'This stop just changed — please retry'); return; }
    // confirm_delivery is never queued offline (complete_delivery needs an
    // in_progress stop and a queued confirm has no replay caller).
    if (!isOnline) {
      toast('error', 'Connect to the internet to start this stop');
      return;
    }
    setConfirming(true);
    try {
      const { data, error } = await supabase.rpc('confirm_delivery', {
        p_delivery_id: id,
        p_idempotency_key: confirmIdem.getKey(),
      });
      if (error) throw error;
      assertRpcResult(data, 'confirm_delivery');
      confirmIdem.resetKey();
      toast('success', 'Delivery started');
      await syncAfterArrive();
    } catch (err: unknown) {
      const msg = sanitizeError(err);
      // Stale screen: stop was already started elsewhere — re-read + resume at Verify.
      if (/in_progress|already/i.test(msg)) await syncAfterArrive();
      else toast('error', msg);
    }
    setConfirming(false);
  };

  const updateQty = (itemId: string, qty: number, max: number) => {
    setDeliveryQtys((prev) => ({ ...prev, [itemId]: Math.max(0, Math.min(qty, max)) }));
  };

  const isPartial = items.some((it) => (deliveryQtys[it.id] ?? it.quantity) < it.quantity);
  // What complete_delivery checks before it completes (migration 20261022075000).
  const completionEvidence: DeliveryCompletionEvidence = noOnePresent ? 'left_at_site' : usePaperTicket ? 'paper_ticket' : 'signature';
  const receiptEmail = delivery?.customer?.email || receiptRecipient?.email || null;
  // The proof the chosen path needs is in place (the server checks it again).
  const evidenceReady = completionEvidence === 'left_at_site'
    ? hasLeftAtSitePhoto(photos)
    : completionEvidence === 'paper_ticket'
      ? hasPaperTicketPhoto(photos) && isValidPaperDeliveredOn(paperDeliveredOn)
      : !!signatureDataUrl;
  // What the driver can still edit while the signal check runs; compared after the check.
  const completionInputs = JSON.stringify([signedBy, deliveryQtys, usePaperTicket, noOnePresent, paperDeliveredOn, signatureDataUrl, emailOnComplete]);
  const completionInputsRef = useLatestRef(completionInputs);
  const hasAnyQty = items.some((it) => (deliveryQtys[it.id] ?? it.quantity) > 0);

  // ── Photo upload (copied/adapted from DeliveryDetail.handlePhotoUpload) ──
  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>, caption?: string) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !profile || !id) return;
    if (!caption && countOrdinaryPhotos(photos) + files.length > MAX_ORDINARY_DELIVERY_PHOTOS) {
      toast('error', 'Maximum 10 photos per delivery');
      return;
    }
    if (caption === PAPER_TICKET_PHOTO_CAPTION && countPaperTicketPhotos(photos) + files.length > MAX_PAPER_TICKET_PHOTOS) {
      toast('error', 'Maximum 2 ticket photos per delivery');
      return;
    }
    if (caption === LEFT_AT_SITE_PHOTO_CAPTION && countLeftAtSitePhotos(photos) + files.length > MAX_LEFT_AT_SITE_PHOTOS) {
      toast('error', 'Maximum 2 drop-location photos per delivery');
      return;
    }
    setUploadingPhoto(true);
    let uploadCount = 0;
    for (const rawFile of Array.from(files)) {
      try {
        const file = await compressImage(rawFile);
        const ext = file.name.split('.').pop() || 'jpg';
        const storagePath = `delivery-photos/${id}/${Date.now()}_${uploadCount}.${ext}`;
        const { error: uploadErr } = await supabase.storage
          .from('delivery-photos')
          .upload(storagePath, file, { contentType: file.type, cacheControl: '0' });
        if (uploadErr) {
          toast('error', `Upload failed: ${uploadErr.message}`);
          continue;
        }
        const { data: urlData } = supabase.storage.from('delivery-photos').getPublicUrl(storagePath);
        const photoResult = await supabase.from('delivery_photos').insert({
          delivery_id: id,
          storage_path: storagePath,
          image_url: urlData.publicUrl,
          uploaded_by: profile.id,
          file_size: file.size,
          sort_order: photos.length + uploadCount,
          ...(caption ? { caption } : {}),
        }).select();
        if (photoResult.error) {
          toast('error', `Photo saved to storage but DB record failed: ${photoResult.error.message}`);
          continue;
        }
        checkMutationResult(photoResult, 'Insert delivery photo');
        // Show the saved row now, so the list does not depend on the refresh read below.
        const inserted = (photoResult.data || []) as StopPhoto[];
        if (activeStopIdRef.current === id) {
          photoSeqRef.current++; // an older in-flight read must not replace the list without this photo
          setPhotos((prev) => [...prev, ...inserted.filter((row) => !prev.some((p) => p.id === row.id))]);
        }
        uploadCount++;
      } catch (err) {
        Sentry.captureException(err, { tags: { source: 'critical_action', action: 'upload_delivery_photo' } });
        toast('error', 'Photo upload failed. Please try again.');
      }
    }
    if (uploadCount > 0) {
      toast('success', `${uploadCount} photo${uploadCount > 1 ? 's' : ''} uploaded`);
      await fetchPhotos();
    }
    setUploadingPhoto(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (paperTicketInputRef.current) paperTicketInputRef.current.value = '';
    if (leftAtSiteInputRef.current) leftAtSiteInputRef.current.value = '';
  };

  // ── Complete (mirrors DeliveryDetail.handleComplete) ────────────────────
  const requestComplete = () => {
    if (!signedBy.trim()) { toast('error', 'Enter who signed for the delivery'); return; }
    if (!hasAnyQty) { toast('error', 'At least one item must have a quantity above zero'); return; }
    if (usePaperTicket && !hasPaperTicketPhoto(photos)) { toast('error', 'Take a photo of the signed paper ticket before completing'); return; }
    if (usePaperTicket && !isValidPaperDeliveredOn(paperDeliveredOn)) { toast('error', 'Enter the delivery date from the paper ticket (today or earlier)'); return; }
    if (completionEvidence === 'left_at_site' && !hasLeftAtSitePhoto(photos)) { toast('error', 'Take a photo of where the delivery was left before completing'); return; }
    if (completionEvidence === 'signature' && !signatureDataUrl) { toast('error', 'Have the customer sign on screen, or use a paper ticket'); return; }
    if (completionEvidence === 'signature' && !isSignatureDataUrl(signatureDataUrl)) { toast('error', INVALID_SIGNATURE_MESSAGE); return; }
    void handleComplete();
  };

  // Claimed synchronously before the first await, so a second tap can never start a second attempt.
  const submitClaimRef = useRef(false);
  const handleComplete = async () => {
    if (submitClaimRef.current) return;
    submitClaimRef.current = true;
    try {
      await runComplete();
    } catch (error: unknown) {
      // Only a follow-up after a confirmed completion can land here (the call itself is handled).
      Sentry.captureException(error, { level: 'warning', extra: { context: 'Field Mode completion follow-up failed after the delivery completed' } });
    } finally {
      submitClaimRef.current = false;
      setCompleting(false);
    }
  };

  const runComplete = async () => {
    if (!delivery || !profile || !id) return;
    // Stale-route guard (H3): a fast stop-to-stop switch must never complete the
    // WRONG stop — the route id is fresh but component state could still lag.
    if (delivery.id !== id) { toast('error', 'This stop just changed — please retry'); return; }
    if (completionEvidence === 'signature' && !isSignatureDataUrl(signatureDataUrl)) { toast('error', INVALID_SIGNATURE_MESSAGE); return; }
    setCompleting(true);

    const quantitiesJson = isPartial
      ? Object.fromEntries(items.map((it) => [it.id, deliveryQtys[it.id] ?? it.quantity]))
      : null;
    const evidencePhoto = completionEvidence === 'paper_ticket'
      ? latestEvidencePhoto(photos, PAPER_TICKET_PHOTO_CAPTION)
      : completionEvidence === 'left_at_site' ? latestEvidencePhoto(photos, LEFT_AT_SITE_PHOTO_CAPTION) : undefined;
    const intentParams = {
      p_delivery_id: id,
      p_signed_by: signedBy,
      p_performed_by: profile.id,
      ...(quantitiesJson ? { p_quantities: quantitiesJson } : {}),
      ...(usePaperTicket && paperDeliveredAt(paperDeliveredOn) ? { p_completed_at: paperDeliveredAt(paperDeliveredOn) } : {}),
      p_evidence: completionEvidence,
      // The exact photo the screen shows as saved (the signature's reference comes from the key).
      ...(evidencePhoto ? { p_evidence_ref: evidencePhoto.id } : {}),
    };
    // check_idempotency replays by key and operation only: bind the key to this exact
    // payload (stop, signer, quantities, ticket date) so an edited retry, or another
    // stop, mints a fresh key. complete_delivery refuses an already-completed delivery.
    // Fingerprint the date the driver chose, not the completion time derived from it:
    // "today" sends no p_completed_at but becomes a past date after midnight, and an
    // exact retry across midnight must keep its key to replay the saved result.
    // complete_delivery replays on the key alone, so the scope uses the collision-resistant
    // SHA-256 digest (digestIntentPayload), never the 64-bit FNV fingerprint (see idempotency.ts).
    const completeScope = `complete:${await digestIntentPayload({
      ...intentParams,
      p_completed_at: undefined,
      delivered_on: usePaperTicket ? paperDeliveredOn : null,
      // A re-drawn signature is a new attempt: new key, new signature file.
      signature_digest: completionEvidence === 'signature' && signatureDataUrl ? await signatureDigest(signatureDataUrl) : null,
    })}`;
    const idemKey = completeIdem.getKeyFor(completeScope);
    // The server accepts only the image at the path it derives from this key; a retry of the key reuses it.
    const signaturePath = completionEvidence === 'signature' ? await signatureImagePathFor(id, idemKey) : undefined;
    const rpcParams = { ...intentParams, ...(signaturePath ? { p_evidence_ref: signaturePath } : {}), p_idempotency_key: idemKey };

    // Goal 5: completing a delivery needs a signal. Nothing is queued to sync later;
    // without a reachable server the stop stays exactly as it was.
    if (!(await hasSignal())) {
      toast('error', NO_SIGNAL_MESSAGE);
      return;
    }
    // The receipt address is read while the stop is still open (a driver may not see the customer),
    // after the signal check and for at most a few seconds, so it never holds up the completion.
    const recipient = emailOnComplete && !delivery.customer?.email
      ? (receiptRecipient ?? await fetchReceiptRecipientWithin(id))
      : null;
    // The checks above can take a few seconds; re-check the stop did not change meanwhile.
    // These checks gate only the DISPATCH: once the call is sent, its result is always reconciled.
    const stillSameAttempt = () => {
      if (activeStopIdRef.current !== id) { toast('error', 'This stop just changed — please retry'); return false; }
      if (completionInputsRef.current !== completionInputs) {
        toast('error', 'Details changed while checking for signal. The delivery was not completed; check them and tap Complete Delivery again.');
        return false;
      }
      return true;
    };
    if (!stillSameAttempt()) return;
    // The server completes only once this attempt's signature image is saved, so it goes up first.
    // A failed upload does not stop the call: after a lost reply the earlier attempt may already have
    // completed the stop (storage then refuses the re-upload). The same key replays that completion,
    // or the server refuses SIGNATURE_IMAGE_MISSING and nothing changes.
    let signatureUploadError: unknown = null;
    if (signaturePath && signatureDataUrl) {
      try {
        await uploadSignatureImage(signaturePath, signatureDataUrl);
      } catch (sigErr) {
        signatureUploadError = sigErr;
        Sentry.captureException(sigErr instanceof Error ? sigErr : new Error(String(sigErr)), { level: 'warning', extra: { context: 'Field Mode signature upload before completion failed; sending the completion anyway' } });
      }
      if (!stillSameAttempt()) return;
    }

    // Sends this attempt exactly: the same inputs and key every time (a lost-reply replay included).
    // Retires the key on a confirmed result, a binding refusal, or SIGNATURE_IMAGE_MISSING (this key's
    // image is not saved and never will be under it, so the next tap is a fresh attempt).
    const sendCompletion = async (): Promise<unknown> => {
      // Work out the completion time on the first send, after the signal and route checks: if midnight
      // passed during them, a ticket dated "today" is now a past date and must carry its own timestamp.
      const { data, error: rpcError } = await supabase.rpc('complete_delivery', {
        ...rpcParams,
        // A retry of this key resends the first send's value (completedAtForKey).
        p_completed_at: completedAtForKey(sentCompletedAt.current, rpcParams.p_idempotency_key, () => (
          usePaperTicket ? paperDeliveredAt(paperDeliveredOn) : undefined)),
      });
      try {
        if (rpcError) throw rpcError;
        assertRpcResult(data, 'complete_delivery');
      } catch (error: unknown) {
        if (getIdempotencyBindingRejection(error) || isSignatureImageMissing(error)) {
          completeIdem.resetKeyFor(completeScope);
        }
        throw error;
      }
      completeIdem.resetKeyFor(completeScope);
      return data;
    };
    // An error toast for a stop the driver has already left names it.
    const forThisStop = (message: string) => (activeStopIdRef.current === id ? message : `Delivery ${delivery.delivery_number}: ${message}`);

    // The success path: toasts, activity, notifications and the receipt. Also run after a lost reply
    // whose identical replay returned the saved result.
    const finishCompleted = async (result: unknown) => {
      // The signature image went up before the call; the server recorded signature_url itself.
      const autoInvoice = result as { auto_invoice?: { invoice_number?: string } } | null;
      const invoiceNum = autoInvoice?.auto_invoice?.invoice_number || null;
      // Only the stop still on screen shows the Done step; the follow-ups below run regardless.
      const stillOnStop = activeStopIdRef.current === id;
      if (invoiceNum && stillOnStop) setAutoInvoiceNumber(invoiceNum);
      toast('success', invoiceNum
        ? `Delivery completed${isPartial ? ' (partial)' : ''}. Draft invoice ${invoiceNum} created.`
        : `Delivery completed${isPartial ? ' (partial)' : ''}`);

      logActivity({
        event: 'delivery_completed',
        description: `Delivery ${delivery.delivery_number} completed${isPartial ? ' (partial)' : ''}${completionEvidence === 'paper_ticket' ? ' (signed paper ticket photo)' : completionEvidence === 'left_at_site' ? ' (no one present; drop-location photo)' : ' (on-screen signature)'}${invoiceNum ? ` — draft invoice ${invoiceNum}` : ''} via Field Mode`,
        performedBy: profile.id,
        entityType: 'delivery',
        entityId: delivery.id,
        customerId: delivery.customer_id,
      });

      if (isPartial) {
        const remainderItems = items
          .map((it) => ({ product: it.product?.product_name || 'Unknown', ordered: it.quantity, delivered: deliveryQtys[it.id] ?? it.quantity }))
          .filter((r) => r.delivered < r.ordered);
        if (remainderItems.length > 0) {
          await notifyDeliveryRemainder(delivery.id, delivery.delivery_number || '', delivery.order_id || '', remainderItems, delivery.created_by || '');
        }
      }

      await notifyDeliveryCompleted(delivery.id, delivery.delivery_number || '', delivery.customer?.farm_name || recipient?.farmName || receiptRecipient?.farmName || 'Unknown', delivery.assigned_driver, delivery.order_id, isPartial);

      // Same opt-in as an on-screen signature. The customer keeps the signed paper ticket; a
      // guaranteed email needs a server-side receipt queue (open in the Goal 5 plan).
      const sendTo = delivery.customer?.email || recipient?.email || receiptRecipient?.email || null;
      if (emailOnComplete && sendTo) {
        const emailItems = items
          .map((it) => ({ name: it.product?.product_name || 'Product', qty: isPartial ? (deliveryQtys[it.id] ?? it.quantity) : it.quantity }))
          .filter((r) => r.qty > 0);
        const receiptSent = await sendDeliveryCompletionEmail({
          customerEmail: sendTo,
          contactName: delivery.customer?.contact_name ?? recipient?.contactName ?? receiptRecipient?.contactName ?? null,
          deliveryNumber: delivery.delivery_number || '',
          deliveryId: delivery.id,
          customerId: delivery.customer_id,
          items: emailItems,
          isPartial,
          signedBy,
          ...(usePaperTicket && isValidPaperDeliveredOn(paperDeliveredOn) ? { deliveredOn: paperDeliveredOn } : {}),
        });
        if (!receiptSent) toast('warning', RECEIPT_NOT_SENT_MESSAGE);
      } else if (emailOnComplete) {
        // The receipt was wanted but no address could be read here (on any proof path). A visible
        // customer with no email has none on file; otherwise the office may still have one.
        toast('warning', delivery.customer ? RECEIPT_NO_EMAIL_ON_FILE_MESSAGE : RECEIPT_NO_EMAIL_MESSAGE);
      }

      if (stillOnStop) setStep('done');
    };

    let result: unknown;
    try {
      result = await sendCompletion();
    } catch (error: unknown) {
      // Any replay-binding refusal (another request's or person's key, or a receipt that can never be
      // used) or SIGNATURE_IMAGE_MISSING retired the key in sendCompletion; nothing ran for THIS
      // request. Otherwise the key is still held: the reply may have been lost after a commit.
      const keyHeld = !getIdempotencyBindingRejection(error) && !isSignatureImageMissing(error);
      Sentry.captureException(error, { tags: { source: 'critical_action', action: 'complete_delivery' } });
      // Reconcile with the server for THIS stop. Completed with the key still held: resend the
      // identical call, which replays the saved result, and run the normal success path.
      const outcome = await reconcileFailedCompletion({ deliveryId: id, keyHeld, resend: sendCompletion, context: 'Field Mode' });
      if (outcome.kind === 'replayed') {
        await finishCompleted(outcome.result);
        return;
      }
      if (outcome.kind === 'completed_not_replayed') {
        toast('error', forThisStop(COMPLETED_BY_EARLIER_ATTEMPT_MESSAGE));
      } else {
        toast('error', forThisStop(sanitizeError(error)));
        // The upload had already failed for a reason other than the signal: say what it was.
        if (isSignatureImageMissing(error) && signatureUploadError && !isNetworkFailure(signatureUploadError)) {
          toast('error', forThisStop(sanitizeError(signatureUploadError)));
        }
      }
      if (activeStopIdRef.current !== id) return;
      // A completion that already committed must show as completed, not as a stale form. Only the
      // status was read: a full reload would reset the driver's edited quantities, which a retry would
      // then send as full. Still open: refresh the photos (a refused photo may be gone).
      if (outcome.kind === 'completed_not_replayed' || outcome.kind === 'closed') await fetchStop(); // opens the completed delivery
      else if (outcome.kind === 'open') await fetchPhotos();
      return;
    }
    await finishCompleted(result);
  };

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-6">
        <div className="h-8 w-32 bg-gray-100 rounded animate-pulse mb-4" />
        <div className="h-40 bg-gray-100 rounded-xl animate-pulse" />
      </div>
    );
  }
  if (!delivery) return null;

  const farmName = delivery.customer?.farm_name || 'Unknown customer';
  const shortCount = items.filter((it) => (deliveryQtys[it.id] ?? it.quantity) < it.quantity).length;

  return (
    <div className="max-w-2xl mx-auto px-4 py-4">
      <button
        type="button"
        onClick={() => navigate('/my-route')}
        className="flex items-center gap-1 text-sm text-gray-500 mb-3 hover:text-gray-700"
      >
        <ArrowLeft className="w-4 h-4" /> My Route
      </button>

      <h1 className="text-lg font-bold text-gray-900">{farmName}</h1>
      {delivery.delivery_number && <p className="text-xs text-gray-500 mb-3">{delivery.delivery_number}</p>}

      {/* Step progress */}
      <div className="flex gap-1 mb-4">
        {STEP_ORDER.map((s, i) => {
          const active = STEP_ORDER.indexOf(step) >= i;
          return <span key={s} className={`flex-1 h-1.5 rounded-full ${active ? 'bg-crx-green' : 'bg-gray-200'}`} />;
        })}
      </div>

      {step === 'arrive' && (
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          {addressLine && (
            <p className="flex items-start gap-2 text-sm text-gray-700 mb-3">
              <MapPin className="w-4 h-4 mt-0.5 text-gray-400 shrink-0" /> {addressLine}
            </p>
          )}
          {delivery.delivery_notes && (
            <div className="bg-amber-50 text-amber-900 text-sm rounded-lg px-3 py-2 mb-4">{delivery.delivery_notes}</div>
          )}
          {!isOnline && (
            <p className="flex items-center gap-2 text-sm text-amber-700 mb-3">
              <WifiOff className="w-4 h-4" /> You're offline — connect to start this stop.
            </p>
          )}
          <button
            type="button"
            onClick={handleArrive}
            disabled={confirming || !isOnline}
            className="w-full flex items-center justify-center gap-2 bg-crx-green text-white font-semibold rounded-xl py-4 text-lg active:scale-[0.99] disabled:opacity-50"
          >
            <PlayCircle className="w-6 h-6" />
            {confirming ? 'Starting…' : "I'm Here — Start Delivery"}
          </button>
        </div>
      )}

      {step === 'verify' && (
        <div>
          <p className="text-xs text-gray-500 mb-2">Confirm what's being delivered</p>
          <ul className="space-y-2">
            {items.map((it) => {
              const delivered = deliveryQtys[it.id] ?? it.quantity;
              const short = delivered < it.quantity;
              return (
                <li key={it.id} className="bg-white border border-gray-200 rounded-xl p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 truncate">{it.product?.product_name || 'Product'}</p>
                      <p className="text-xs text-gray-500">Ordered {it.quantity}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button type="button" aria-label="Decrease quantity" onClick={() => updateQty(it.id, delivered - 1, it.quantity)} className="w-9 h-9 rounded-lg border border-gray-300 flex items-center justify-center active:scale-95"><Minus className="w-4 h-4" /></button>
                      <input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        min={0}
                        max={it.quantity}
                        value={delivered}
                        onChange={(e) => updateQty(it.id, parseFloat(e.target.value) || 0, it.quantity)}
                        aria-label={`Delivered quantity for ${it.product?.product_name || 'item'}`}
                        className="w-16 text-center font-semibold tabular-nums border border-gray-300 rounded-lg py-1.5"
                      />
                      <button type="button" aria-label="Increase quantity" onClick={() => updateQty(it.id, delivered + 1, it.quantity)} className="w-9 h-9 rounded-lg border border-gray-300 flex items-center justify-center active:scale-95"><Plus className="w-4 h-4" /></button>
                    </div>
                  </div>
                  {short && (
                    <span className="inline-flex items-center gap-1 mt-2 text-xs bg-amber-50 text-amber-800 px-2 py-0.5 rounded-md">
                      <AlertTriangle className="w-3 h-3" /> {it.quantity - delivered} short → remainder
                    </span>
                  )}
                </li>
              );
            })}
            {items.length === 0 && (
              <li className="text-sm text-center py-6">
                {itemsError
                  ? <span className="text-amber-700">Could not load items — refresh before completing.</span>
                  : <span className="text-gray-500">No items on this delivery.</span>}
              </li>
            )}
          </ul>
          <button type="button" disabled={!hasAnyQty} onClick={() => setStep('sign')} className="w-full mt-4 flex items-center justify-center gap-2 bg-crx-green text-white font-semibold rounded-xl py-4 text-lg active:scale-[0.99] disabled:opacity-50">
            {isPartial ? 'Continue with Partial' : 'All Full — Continue'}
            <ChevronRight className="w-5 h-5" />
          </button>
          {!hasAnyQty && <p className="text-xs text-amber-700 mt-2 text-center">At least one item needs a quantity above zero.</p>}
        </div>
      )}

      {step === 'sign' && (
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <label className="flex items-center gap-2 text-sm text-gray-700 mb-4">
            <input
              type="checkbox"
              checked={noOnePresent}
              onChange={(e) => {
                const checked = e.target.checked;
                setNoOnePresent(checked);
                setSignedBy(checked ? 'No one present — left at site' : '');
                if (checked) { setSignatureDataUrl(null); setUsePaperTicket(false); }
              }}
              className="w-4 h-4"
            />
            No one present — left at site
          </label>
          {!noOnePresent && (
            <label className="flex items-center gap-2 text-sm text-gray-700 mb-4">
              <input
                type="checkbox"
                checked={usePaperTicket}
                onChange={(e) => {
                  setUsePaperTicket(e.target.checked);
                  if (e.target.checked) setSignatureDataUrl(null);
                }}
                className="w-4 h-4"
              />
              Customer signed a paper ticket (no signal at the site)
            </label>
          )}
          <label htmlFor="signed-by" className="block text-sm font-medium text-gray-700 mb-1">Signed by (name)</label>
          <input
            id="signed-by"
            type="text"
            value={signedBy}
            onChange={(e) => setSignedBy(e.target.value)}
            placeholder="Who received the delivery?"
            disabled={noOnePresent}
            className={`w-full border border-gray-300 rounded-lg px-3 py-2 mb-4 ${noOnePresent ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''}`}
            autoComplete="off"
          />
          {usePaperTicket && !noOnePresent ? (
            <div className="border border-gray-200 rounded-lg p-3 space-y-2">
              <input ref={paperTicketInputRef} type="file" accept="image/*" capture="environment" onChange={(e) => handlePhotoUpload(e, PAPER_TICKET_PHOTO_CAPTION)} className="hidden" />
              {hasPaperTicketPhoto(photos) ? (
                <p className="flex items-center gap-2 text-sm text-green-700"><CheckCircle2 className="w-4 h-4 shrink-0" /> Photo of the signed ticket saved</p>
              ) : (
                <p className="text-sm text-amber-700">Take a photo of the signed paper ticket. It replaces the on-screen signature.</p>
              )}
                  <div>
                    <label htmlFor="paper-delivered-on" className="block text-sm font-medium text-gray-700 mb-1">Delivered on (date on the ticket)</label>
                    <input
                      id="paper-delivered-on"
                      type="date"
                      value={paperDeliveredOn}
                      max={todayInBusinessTz()}
                      onChange={(e) => setPaperDeliveredOn(e.target.value)}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2"
                    />
                  </div>
              <button type="button" disabled={uploadingPhoto || !isOnline || countPaperTicketPhotos(photos) >= MAX_PAPER_TICKET_PHOTOS} onClick={() => paperTicketInputRef.current?.click()} className="w-full flex items-center justify-center gap-2 border border-gray-300 text-gray-700 font-medium rounded-xl py-3 active:scale-[0.99] disabled:opacity-50">
                <Camera className="w-5 h-5" /> {uploadingPhoto ? 'Uploading…' : 'Take Photo of Signed Ticket'}
              </button>
            </div>
          ) : (
            <div className={noOnePresent ? 'pointer-events-none opacity-50' : ''} aria-disabled={noOnePresent}>
              <SignatureCanvas key={noOnePresent ? 'signature-skipped' : 'signature-capture'} onSignatureChange={setSignatureDataUrl} label="Customer signs with their finger" height={160} disabled={noOnePresent} />
            </div>
          )}
          {noOnePresent && (
            <div className="border border-gray-200 rounded-lg p-3 space-y-2 mt-3">
              <input ref={leftAtSiteInputRef} type="file" accept="image/*" capture="environment" onChange={(e) => handlePhotoUpload(e, LEFT_AT_SITE_PHOTO_CAPTION)} className="hidden" />
              {hasLeftAtSitePhoto(photos) ? (
                <p className="flex items-center gap-2 text-sm text-green-700"><CheckCircle2 className="w-4 h-4 shrink-0" /> Photo of the drop location saved</p>
              ) : (
                <p className="text-sm text-amber-700">Signature skipped because no one was present. Take a photo of where you left the delivery.</p>
              )}
              <button type="button" disabled={uploadingPhoto || !isOnline || countLeftAtSitePhotos(photos) >= MAX_LEFT_AT_SITE_PHOTOS} onClick={() => leftAtSiteInputRef.current?.click()} className="w-full flex items-center justify-center gap-2 border border-gray-300 text-gray-700 font-medium rounded-xl py-3 active:scale-[0.99] disabled:opacity-50">
                <Camera className="w-5 h-5" /> {uploadingPhoto ? 'Uploading…' : 'Take Photo of Drop Location'}
              </button>
            </div>
          )}
          <button type="button" disabled={!signedBy.trim() || !evidenceReady} onClick={() => setStep('review')} className="w-full mt-4 flex items-center justify-center gap-2 bg-crx-green text-white font-semibold rounded-xl py-4 text-lg active:scale-[0.99] disabled:opacity-50">
            <PenLine className="w-5 h-5" /> Continue to Review
          </button>
          {!signedBy.trim() && <p className="text-xs text-amber-700 mt-2 text-center">Enter who signed or choose no one present to continue.</p>}
          {signedBy.trim() && usePaperTicket && !hasPaperTicketPhoto(photos) && <p className="text-xs text-amber-700 mt-2 text-center">Take the photo of the signed ticket to continue.</p>}
          {signedBy.trim() && usePaperTicket && !isValidPaperDeliveredOn(paperDeliveredOn) && <p className="text-xs text-amber-700 mt-2 text-center">Enter the delivery date from the paper ticket (today or earlier) to continue.</p>}
          {signedBy.trim() && completionEvidence === 'signature' && !signatureDataUrl && <p className="text-xs text-amber-700 mt-2 text-center">Have the customer sign above to continue.</p>}
          {noOnePresent && !hasLeftAtSitePhoto(photos) && <p className="text-xs text-amber-700 mt-2 text-center">Take the drop-location photo to continue.</p>}
        </div>
      )}

      {step === 'review' && (
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <section className="mb-4">
            <h2 className="text-sm font-medium text-gray-700 mb-2">Add photo (optional)</h2>
            <input ref={fileInputRef} type="file" accept="image/*" capture="environment" multiple onChange={handlePhotoUpload} className="hidden" />
            {photos.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {photos.map((p) => (
                  <PrivatePhoto key={p.id} bucket="delivery-photos" path={deliveryPhotoPath(p)} alt={p.caption || 'Delivery photo'} className="w-20 h-20 object-cover rounded-lg border border-gray-200" />
                ))}
              </div>
            )}
            {isOnline ? (
              <button type="button" disabled={uploadingPhoto || countOrdinaryPhotos(photos) >= MAX_ORDINARY_DELIVERY_PHOTOS} onClick={() => fileInputRef.current?.click()} className="w-full flex items-center justify-center gap-2 border border-gray-300 text-gray-700 font-medium rounded-xl py-3 active:scale-[0.99] disabled:opacity-50">
                <Camera className="w-5 h-5" /> {uploadingPhoto ? 'Uploading…' : 'Take Photo'}
              </button>
            ) : (
              <p className="flex items-center gap-2 text-sm text-amber-700"><WifiOff className="w-4 h-4" /> Photos can only be uploaded while online — reconnect to add photos.</p>
            )}
          </section>
          <dl className="text-sm space-y-1.5 mb-4">
            <div className="flex justify-between"><dt className="text-gray-500">Delivery</dt><dd className="font-medium">{isPartial ? `Partial — ${shortCount} short` : 'Full delivery'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Signed by</dt><dd className="font-medium">{signedBy || '—'}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">Photos</dt><dd className="font-medium">{photos.length}</dd></div>
          </dl>

          {receiptEmail && (
            <label className="flex items-center gap-2 text-sm text-gray-700 mb-4">
              <input type="checkbox" checked={emailOnComplete} onChange={(e) => setEmailOnComplete(e.target.checked)} className="w-4 h-4" />
              Email a receipt to the customer
            </label>
          )}

          {!isOnline && (
            <div className="bg-amber-50 text-amber-800 text-xs rounded-lg px-3 py-2 mb-4">
              No signal. A delivery can only be completed with signal; <strong>nothing is saved offline</strong>. If the customer is signing now, go back and use a paper ticket, then complete here once you have signal.
            </div>
          )}

          <p className="text-sm text-gray-600 mb-3">Inventory will be deducted and a draft invoice created.</p>

          <button type="button" disabled={completing} onClick={requestComplete} className="w-full flex items-center justify-center gap-2 bg-crx-green text-white font-semibold rounded-xl py-4 text-lg active:scale-[0.99] disabled:opacity-50">
            <ClipboardCheck className="w-6 h-6" /> {completing ? 'Completing…' : 'Complete Delivery'}
          </button>
        </div>
      )}

      {step === 'done' && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 text-center">
          <CheckCircle2 className="w-14 h-14 text-green-600 mx-auto mb-3" />
          <p className="text-lg font-semibold text-gray-900">Delivery complete</p>
          <p className="text-sm text-gray-500 mt-1">Signed by {signedBy}</p>
          {autoInvoiceNumber && (
            <p className="inline-flex items-center gap-1 text-sm text-gray-700 mt-3">
              <FileText className="w-4 h-4 text-gray-400" /> Draft invoice {autoInvoiceNumber} created
            </p>
          )}
          <button type="button" onClick={() => navigate('/my-route')} className="w-full mt-5 flex items-center justify-center gap-2 border border-crx-green text-crx-green font-semibold rounded-xl py-3 active:scale-[0.99]">
            Next Stop <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      )}

    </div>
  );
}
