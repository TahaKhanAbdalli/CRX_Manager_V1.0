import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import Card, { CardHeader } from '../ui/Card';
import Input from '../ui/Input';
import Modal from '../ui/Modal';
import Select from '../ui/Select';
import ProductSearchPicker from './ProductSearchPicker';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useLatestRef } from '../../hooks/useLatestRef';
import { logActivity } from '../../lib/activityLogger';
import { hasRpcCode, RpcErrorCodes } from '../../lib/db';
import { lookupEpaRegistration } from '../../lib/epaLookupClient';
import {
  EPA_REGISTRATION_PATTERN,
  listProductBrands,
  productBrandErrorMessage,
  saveProductBrand,
  suggestBrandNamesFromProductName,
  type ProductBrandInput,
} from '../../lib/productBrands';
import { sanitizeError } from '../../lib/errorSanitizer';
import { Sentry } from '../../lib/sentry';
import type { BrandSignalWord, EpaLookupResult, ProductBrand } from '../../types';

const NAME_MAX_LENGTH = 200;

interface ProductBrandsSectionProps {
  productId: string;
  /** The product's saved name (brand suggestions and the activity log use it). */
  productName: string;
  isAdmin: boolean;
  /** The signed-in user's profile id; only needed for admin edits. */
  userId: string | null;
}

interface BrandDraft {
  brandId?: string;
  expectedRowVersion?: number;
  brandName: string;
  epaRegistration: string;
  manufacturer: string;
  isCurrentlySourced: boolean;
  isRup: '' | 'yes' | 'no';
  signalWord: '' | BrandSignalWord;
}

const emptyDraft = (brandName = ''): BrandDraft => ({
  brandName,
  epaRegistration: '',
  manufacturer: '',
  isCurrentlySourced: true,
  isRup: '',
  signalWord: '',
});

function draftFromBrand(brand: ProductBrand): BrandDraft {
  return {
    brandId: brand.id,
    expectedRowVersion: brand.row_version,
    brandName: brand.brand_name,
    epaRegistration: brand.epa_registration ?? '',
    manufacturer: brand.manufacturer ?? '',
    isCurrentlySourced: brand.is_currently_sourced,
    isRup: brand.is_rup === null ? '' : brand.is_rup ? 'yes' : 'no',
    signalWord: brand.signal_word ?? '',
  };
}

function inputFromDraft(productId: string, draft: BrandDraft): ProductBrandInput {
  return {
    productId,
    brandId: draft.brandId,
    expectedRowVersion: draft.expectedRowVersion,
    brandName: draft.brandName,
    epaRegistration: draft.epaRegistration,
    manufacturer: draft.manufacturer,
    isCurrentlySourced: draft.isCurrentlySourced,
    isRup: draft.isRup === '' ? null : draft.isRup === 'yes',
    signalWord: draft.signalWord === '' ? null : draft.signalWord,
  };
}

function saveScope(input: ProductBrandInput): string {
  return `save:${JSON.stringify(input)}`;
}

function inputFromBrand(productId: string, brand: ProductBrand): ProductBrandInput {
  return {
    productId,
    brandName: brand.brand_name,
    epaRegistration: brand.epa_registration ?? '',
    manufacturer: brand.manufacturer ?? '',
    isCurrentlySourced: brand.is_currently_sourced,
    isRup: brand.is_rup,
    signalWord: brand.signal_word,
  };
}

function rupLabel(isRup: boolean | null): string {
  if (isRup === null) return 'Not confirmed';
  return isRup ? 'Yes' : 'No';
}

/**
 * The real brands that can fill this product, each with its own EPA registration. Quotes, prices and
 * cost stay on the product; the brand that actually ships is recorded on the delivery (step 1, PR B).
 */
// Refusals the server makes before writing anything: after one of these the save certainly did not
// happen, so the admin may correct the form. Anything else (a lost reply, a timeout) is uncertain.
function isClearRefusal(err: unknown): boolean {
  return [
    RpcErrorCodes.BRAND_NAME_TAKEN,
    RpcErrorCodes.BRAND_NAME_REQUIRED,
    RpcErrorCodes.BRAND_TEXT_TOO_LONG,
    RpcErrorCodes.EPA_REGISTRATION_INVALID,
    RpcErrorCodes.NOT_AUTHORIZED,
    RpcErrorCodes.PRODUCT_NOT_FOUND,
    RpcErrorCodes.IDEMPOTENCY_INTENT_MISMATCH,
  ].some((code) => hasRpcCode(err, code));
}

export default function ProductBrandsSection({ productId, productName, isAdmin, userId }: ProductBrandsSectionProps) {
  const { toast } = useToast();
  const [brands, setBrands] = useState<ProductBrand[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [draft, setDraft] = useState<BrandDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A new brand whose save failed without a clear refusal may have been created anyway (the reply
  // was lost). Its form stays locked as sent: Save retries that exact request, which the server
  // replays instead of creating it twice; an edited resubmit would be a new request and a second brand.
  const [createUncertain, setCreateUncertain] = useState(false);
  const [epaResult, setEpaResult] = useState<EpaLookupResult | null>(null);
  const [epaResultNumber, setEpaResultNumber] = useState('');
  const [epaLookupLoading, setEpaLookupLoading] = useState(false);
  // Each lookup gets a number; a reply for an older lookup (the admin retyped the number, or closed
  // and reopened the form) is dropped, so one registration's details never land on another brand.
  const lookupSeq = useRef(0);
  const draftRef = useLatestRef(draft);

  const [copyOpen, setCopyOpen] = useState(false);
  const [copySource, setCopySource] = useState<{ id: string; name: string } | null>(null);
  const [copyCandidates, setCopyCandidates] = useState<ProductBrand[]>([]);
  const [copySelected, setCopySelected] = useState<Set<string>>(new Set());
  const [copyLoading, setCopyLoading] = useState(false);
  // A failed read of the source is shown as a failure with a retry, never as "no brands to copy".
  const [copyLoadError, setCopyLoadError] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  // Same idea for the copy source: if the admin picks product A then B, A's late reply is dropped so
  // B's label never sits over A's brands.
  const copySourceSeq = useRef(0);

  // One retry key per exact request: a changed form is a new request, and an unchanged retry after a
  // lost reply replays the saved result instead of saving twice. Each copied brand is its own request.
  const { getKeyFor, resetKeyFor } = useIdempotencyKey('upsert_product_brand', userId ?? '');
  // A copied brand whose save failed keeps its key, so a retry replays a save that did land. Once a
  // reload lists that brand here, the copy is settled: retire the key, so copying the same source
  // brand again later (after the copy was renamed, say) is a new request, not a replay of the old one.
  const unsettledCopies = useRef(new Map<string, string>());
  useEffect(() => {
    const present = new Set(brands.map((brand) => brand.brand_name.toLowerCase()));
    const stillUnsettled = new Map<string, string>();
    for (const [scope, name] of unsettledCopies.current) {
      if (present.has(name)) resetKeyFor(scope);
      else stillUnsettled.set(scope, name);
    }
    unsettledCopies.current = stillUnsettled;
  }, [brands, resetKeyFor]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    listProductBrands(productId)
      .then((rows) => { if (active) setBrands(rows); })
      .catch((err: unknown) => {
        if (!active) return;
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'list_product_brands' } });
        setLoadError(sanitizeError(err));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [productId, reloadToken]);

  const suggestions = useMemo(
    () => suggestBrandNamesFromProductName(productName, brands.map((brand) => brand.brand_name)),
    [productName, brands],
  );

  const openDraft = (next: BrandDraft) => {
    lookupSeq.current += 1;
    setCreateUncertain(false);
    setDraft(next);
    setDraftError(null);
    setEpaResult(null);
    setEpaLookupLoading(false);
  };

  const closeDraft = () => {
    if (saving) return;
    lookupSeq.current += 1;
    // Closing settles an unclear create: Add waits for the reload, which shows whether it was saved.
    // Retire its key, so the same values entered later are a new request, not a replay of that save.
    // If that save is still landing when the reload reads, the name index refuses a second brand of
    // the same name (BRAND_NAME_TAKEN); a changed name was always a new request with its own key.
    if (createUncertain && draft) resetKeyFor(saveScope(inputFromDraft(productId, draft)));
    setCreateUncertain(false);
    setDraft(null);
  };

  const updateDraft = (patch: Partial<BrandDraft>) => {
    if (saving || createUncertain) return;
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const handleLookup = async () => {
    if (!draft || saving || createUncertain) return;
    const regNumber = draft.epaRegistration.trim();
    if (!EPA_REGISTRATION_PATTERN.test(regNumber)) {
      setDraftError('Enter an EPA registration number (like 524-475) to look it up.');
      return;
    }
    setDraftError(null);
    const seq = ++lookupSeq.current;
    const isStale = () => seq !== lookupSeq.current
      || (draftRef.current?.epaRegistration.trim() ?? '') !== regNumber;
    setEpaLookupLoading(true);
    setEpaResult(null);
    try {
      const result = await lookupEpaRegistration(regNumber, isStale);
      if (!result || isStale()) return;
      setEpaResult(result);
      setEpaResultNumber(regNumber);
      if (!result.found) toast('warning', `EPA did not find registration ${regNumber}.`);
    } catch (err) {
      if (isStale()) return;
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { source: 'edge_function', action: 'epa_lookup' },
      });
      toast('error', err instanceof Error ? err.message : 'EPA lookup failed. Please try again.');
    } finally {
      if (seq === lookupSeq.current) setEpaLookupLoading(false);
    }
  };

  const epaResultMatchesDraft = epaResult !== null && draft !== null
    && epaResultNumber === draft.epaRegistration.trim();

  const applyEpaDetails = () => {
    if (!epaResult?.found || !epaResultMatchesDraft) return;
    // Only fill what EPA actually reports; a blank from EPA never erases what the admin entered.
    const patch: Partial<BrandDraft> = {};
    if (epaResult.signalWordCanonical) patch.signalWord = epaResult.signalWordCanonical;
    if (epaResult.rupYn === 'Yes') patch.isRup = 'yes';
    if (epaResult.rupYn === 'No') patch.isRup = 'no';
    if (epaResult.manufacturer && !draft?.manufacturer.trim()) patch.manufacturer = epaResult.manufacturer.slice(0, NAME_MAX_LENGTH);
    updateDraft(patch);
  };

  const handleSave = async () => {
    if (!draft) return;
    if (!userId) {
      setDraftError('Your account is still loading. Try again in a moment.');
      return;
    }
    if (!draft.brandName.trim()) {
      setDraftError('Enter the brand name.');
      return;
    }
    const epa = draft.epaRegistration.trim();
    if (epa && !EPA_REGISTRATION_PATTERN.test(epa)) {
      setDraftError('That is not an EPA registration number (like 524-475 or 100-1234-5905).');
      return;
    }
    const input = inputFromDraft(productId, draft);
    const scope = saveScope(input);
    setSaving(true);
    setDraftError(null);
    try {
      const saved = await saveProductBrand(input, getKeyFor(scope));
      resetKeyFor(scope);
      logActivity({
        event: draft.brandId ? 'product_brand_updated' : 'product_brand_added',
        description: `Brand ${saved.brand_name} ${draft.brandId ? 'updated' : 'added'} on ${productName}`,
        performedBy: userId,
        entityType: 'product',
        entityId: productId,
      });
      toast('success', draft.brandId ? 'Brand updated.' : 'Brand added.');
      setCreateUncertain(false);
      setDraft(null);
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'upsert_product_brand' } });
      // An edit needs no lock: a changed resubmit after a lost-but-committed edit fails BRAND_CHANGED.
      if (!draft.brandId && !isClearRefusal(err)) setCreateUncertain(true);
      if (hasRpcCode(err, RpcErrorCodes.BRAND_CHANGED)) {
        // The form holds a version that is no longer current; close it so the next edit starts fresh.
        toast('error', productBrandErrorMessage(err));
        setDraft(null);
      } else {
        setDraftError(productBrandErrorMessage(err));
      }
    } finally {
      setSaving(false);
      // Reload after every attempt: a reply lost after the save committed must not leave a stale list.
      // Marked loading at once, so new creates stay off until the reload shows what was saved.
      setLoading(true);
      setReloadToken((token) => token + 1);
    }
  };

  const loadCopySource = useCallback(async (source: { id: string; name: string } | null) => {
    const seq = ++copySourceSeq.current;
    setCopySource(source);
    setCopyCandidates([]);
    setCopySelected(new Set());
    setCopyLoadError(null);
    if (!source) {
      setCopyLoading(false);
      return;
    }
    setCopyLoading(true);
    try {
      const rows = await listProductBrands(source.id);
      if (seq !== copySourceSeq.current) return;
      setCopyCandidates(rows);
      // Brands the source no longer buys are listed but not pre-ticked.
      setCopySelected(new Set(rows.filter((brand) => brand.is_currently_sourced).map((brand) => brand.id)));
    } catch (err) {
      if (seq !== copySourceSeq.current) return;
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'list_product_brands_copy' } });
      setCopyLoadError(sanitizeError(err));
    } finally {
      if (seq === copySourceSeq.current) setCopyLoading(false);
    }
  }, []);

  // Copying is only safe against this product's own list: until it has loaded (or after it failed),
  // a brand already here would look copyable, be refused as a duplicate, and stop the copy part-way.
  // New creates wait for it too: after a save whose reply was lost, closing the form clears its lock,
  // and a changed name saved before the reload showed the first brand would add a second one.
  // Candidates are filtered against the current list on every render, so a list that loads or
  // reloads after the source was picked still drops the brands this product already has.
  const brandsReady = !loading && loadError === null;
  const copyableCandidates = useMemo(() => {
    const taken = new Set(brands.map((brand) => brand.brand_name.toLowerCase()));
    return copyCandidates.filter((brand) => !taken.has(brand.brand_name.toLowerCase()));
  }, [brands, copyCandidates]);
  const copyChosen = copyableCandidates.filter((brand) => copySelected.has(brand.id));

  const handleCopy = async () => {
    if (!userId) {
      toast('error', 'Your account is still loading. Try again in a moment.');
      return;
    }
    if (!brandsReady || !copySource) return;
    const source = copySource;
    const chosen = copyChosen;
    const copiedIds = new Set<string>();
    let attempt: { scope: string; name: string } | null = null;
    setCopying(true);
    try {
      // The dialog shows the source as it was read; a brand edited or retired there since would be
      // copied with its old details. Re-read the source and stop if any chosen brand changed.
      const current = new Map((await listProductBrands(source.id)).map((brand) => [brand.id, brand.row_version]));
      if (chosen.some((brand) => current.get(brand.id) !== brand.row_version)) {
        toast('error', `Brands on ${source.name} changed since they were listed. Check the list and copy again.`);
        void loadCopySource(source);
        return;
      }
      for (const brand of chosen) {
        const scope = `copy:${productId}:${brand.id}`;
        attempt = { scope, name: brand.brand_name.toLowerCase() };
        await saveProductBrand(inputFromBrand(productId, brand), getKeyFor(scope));
        resetKeyFor(scope);
        attempt = null;
        copiedIds.add(brand.id);
      }
      toast('success', `Copied ${copiedIds.size} brand${copiedIds.size === 1 ? '' : 's'}.`);
      setCopyOpen(false);
    } catch (err) {
      if (attempt) unsettledCopies.current.set(attempt.scope, attempt.name);
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'copy_product_brands' } });
      toast('error', `Copied ${copiedIds.size} of ${chosen.length}. ${productBrandErrorMessage(err)}`);
    } finally {
      if (copiedIds.size > 0) {
        logActivity({
          event: 'product_brands_copied',
          description: `${copiedIds.size} brand${copiedIds.size === 1 ? '' : 's'} copied to ${productName} from ${copySource?.name ?? 'another product'}`,
          performedBy: userId,
          entityType: 'product',
          entityId: productId,
        });
        // A retry after a partial failure offers only the brands still to copy.
        setCopyCandidates((current) => current.filter((brand) => !copiedIds.has(brand.id)));
        setCopySelected((current) => new Set([...current].filter((id) => !copiedIds.has(id))));
      }
      setCopying(false);
      setReloadToken((token) => token + 1);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Brands"
        action={isAdmin ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={!brandsReady} onClick={() => { setCopyOpen(true); void loadCopySource(null); }}>
              Copy from another product
            </Button>
            <Button size="sm" icon={<Plus className="h-4 w-4" aria-hidden="true" />} showChevron={false} disabled={!brandsReady} onClick={() => openDraft(emptyDraft())}>
              Add brand
            </Button>
          </div>
        ) : undefined}
      />
      <p className="mb-3 text-sm text-secondary">
        The real brands that can be delivered for this product, each with its own EPA number. Quotes, prices and cost stay on this product.
      </p>

      {isAdmin && suggestions.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-secondary">Named in the product name:</span>
          {suggestions.map((name) => (
            <Button
              key={name}
              size="sm"
              variant="ghost"
              icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
              disabled={!brandsReady}
              onClick={() => openDraft(emptyDraft(name.slice(0, NAME_MAX_LENGTH)))}
            >
              {name}
            </Button>
          ))}
        </div>
      )}

      {loading && brands.length === 0 ? (
        <p className="text-sm text-secondary">Loading brands…</p>
      ) : loadError ? (
        <div className="flex items-center gap-3 text-sm text-red-600" role="alert">
          <span>Couldn’t load brands: {loadError}</span>
          <Button size="sm" variant="secondary" onClick={() => setReloadToken((token) => token + 1)}>Try again</Button>
        </div>
      ) : brands.length === 0 ? (
        <p className="text-sm text-secondary">No brands listed yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Brands of this product</caption>
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-secondary">
                <th scope="col" className="py-2 pr-3">Brand</th>
                <th scope="col" className="py-2 pr-3">EPA Reg. No.</th>
                <th scope="col" className="py-2 pr-3">Manufacturer</th>
                <th scope="col" className="py-2 pr-3">Restricted use</th>
                <th scope="col" className="py-2 pr-3">Signal word</th>
                <th scope="col" className="py-2 pr-3">Status</th>
                {isAdmin && <th scope="col" className="py-2"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {brands.map((brand) => (
                <tr key={brand.id} className="border-b last:border-0">
                  <td className="py-2 pr-3 font-medium text-nav-dark">{brand.brand_name}</td>
                  <td className="py-2 pr-3">{brand.epa_registration ?? <span className="text-secondary">None</span>}</td>
                  <td className="py-2 pr-3">{brand.manufacturer ?? '—'}</td>
                  <td className="py-2 pr-3">{rupLabel(brand.is_rup)}</td>
                  <td className="py-2 pr-3">{brand.signal_word ?? '—'}</td>
                  <td className="py-2 pr-3">
                    <Badge variant={brand.is_currently_sourced ? 'success' : 'default'} size="sm">
                      {brand.is_currently_sourced ? 'Sourced' : 'Not sourced'}
                    </Badge>
                  </td>
                  {isAdmin && (
                    <td className="py-2 text-right">
                      <Button size="sm" variant="ghost" onClick={() => openDraft(draftFromBrand(brand))}>Edit</Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={draft !== null}
        onClose={closeDraft}
        closeDisabled={saving}
        title={draft?.brandId ? 'Edit brand' : 'Add brand'}
        footer={(
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={closeDraft} disabled={saving}>Cancel</Button>
            <Button onClick={() => void handleSave()} loading={saving}>Save brand</Button>
          </div>
        )}
      >
        {draft && (
          // The save sends the form as it was when Save was pressed, so the whole form (lookup and
          // apply included) is locked until it answers: an edit made mid-save would otherwise be
          // dropped on success, or become a second create after a lost reply.
          <fieldset disabled={saving || createUncertain} className="min-w-0 space-y-3">
            {createUncertain && (
              <p className="text-sm text-amber-700" role="status">
                This brand may already have been saved. Save again to finish the same save (it will not be added twice), or Cancel and check the list.
              </p>
            )}
            <Input
              id="brand-name"
              label="Brand name"
              value={draft.brandName}
              maxLength={NAME_MAX_LENGTH}
              onChange={(event) => updateDraft({ brandName: event.target.value })}
            />
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input
                  id="brand-epa-registration"
                  label="EPA Reg. No."
                  value={draft.epaRegistration}
                  placeholder="e.g. 524-475"
                  onChange={(event) => { updateDraft({ epaRegistration: event.target.value }); setEpaResult(null); }}
                />
              </div>
              <Button
                variant="secondary"
                icon={<Search className="h-4 w-4" aria-hidden="true" />}
                onClick={() => void handleLookup()}
                loading={epaLookupLoading}
              >
                Look up
              </Button>
            </div>
            <div aria-live="polite">
              {epaResult && epaResultMatchesDraft && (
                <div className="rounded-lg border bg-gray-50 p-3 text-sm">
                  {epaResult.found ? (
                    <>
                      <p><strong>EPA has:</strong> {epaResult.productname ?? 'No product name'}{epaResult.manufacturer ? ` — ${epaResult.manufacturer}` : ''}</p>
                      <p>Signal word: {epaResult.signalWordCanonical ?? 'None'} · Restricted use: {epaResult.rupYn ?? 'Not provided'}</p>
                      {epaResult.isCancelled && <p className="text-amber-700">EPA lists this registration as cancelled.</p>}
                      <Button size="sm" variant="secondary" className="mt-2" onClick={applyEpaDetails}>
                        Use EPA’s signal word and restricted-use status (and manufacturer, if blank)
                      </Button>
                    </>
                  ) : (
                    <p>EPA did not find this registration number.</p>
                  )}
                </div>
              )}
            </div>
            <Input
              id="brand-manufacturer"
              label="Manufacturer"
              value={draft.manufacturer}
              maxLength={NAME_MAX_LENGTH}
              onChange={(event) => updateDraft({ manufacturer: event.target.value })}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Select
                id="brand-is-rup"
                label="Restricted use (RUP)"
                value={draft.isRup}
                onChange={(event) => updateDraft({ isRup: event.target.value as BrandDraft['isRup'] })}
                options={[
                  { value: '', label: 'Not confirmed' },
                  { value: 'yes', label: 'Yes' },
                  { value: 'no', label: 'No' },
                ]}
              />
              <Select
                id="brand-signal-word"
                label="Signal word"
                value={draft.signalWord}
                onChange={(event) => updateDraft({ signalWord: event.target.value as BrandDraft['signalWord'] })}
                options={[
                  { value: '', label: 'None' },
                  { value: 'Danger', label: 'Danger' },
                  { value: 'Warning', label: 'Warning' },
                  { value: 'Caution', label: 'Caution' },
                ]}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.isCurrentlySourced}
                onChange={(event) => updateDraft({ isCurrentlySourced: event.target.checked })}
              />
              Currently sourced (switch off when we stop buying this brand; it stays on old records)
            </label>
            {draftError && <p className="text-sm text-red-600" role="alert">{draftError}</p>}
          </fieldset>
        )}
      </Modal>

      <Modal
        open={copyOpen}
        onClose={() => { if (!copying) setCopyOpen(false); }}
        closeDisabled={copying}
        title="Copy brands from another product"
        footer={(
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCopyOpen(false)} disabled={copying}>Cancel</Button>
            <Button onClick={() => void handleCopy()} loading={copying} disabled={copyChosen.length === 0 || !brandsReady}>
              Copy {copyChosen.length} brand{copyChosen.length === 1 ? '' : 's'}
            </Button>
          </div>
        )}
      >
        <div className="space-y-3">
          <p className="text-sm text-secondary">
            Pick another product, such as another size of this one, to copy its brands, EPA numbers and details.
          </p>
          <ProductSearchPicker
            value={copySource?.id ?? ''}
            selectedLabel={copySource?.name ?? ''}
            ariaLabel="Product to copy brands from"
            // A copy works from the ticks taken when it started, so nothing here may change mid-copy.
            disabled={copying}
            onSelect={(picked) => { void loadCopySource(picked ? { id: picked.id, name: picked.product_name } : null); }}
          />
          {loadError ? (
            <p className="text-sm text-red-600" role="alert">
              Couldn’t load this product’s own brands, so copying is paused. Close this and use Try again.
            </p>
          ) : loading ? (
            <p className="text-sm text-secondary">Checking this product’s brands…</p>
          ) : null}
          {copyLoading ? (
            <p className="text-sm text-secondary">Loading brands…</p>
          ) : copyLoadError && copySource ? (
            <div className="flex items-center gap-3 text-sm text-red-600" role="alert">
              <span>Couldn’t load {copySource.name}’s brands: {copyLoadError}</span>
              <Button size="sm" variant="secondary" disabled={copying} onClick={() => void loadCopySource(copySource)}>Try again</Button>
            </div>
          ) : copySource && copyableCandidates.length === 0 ? (
            <p className="text-sm text-secondary">That product has no brands this one doesn’t already list.</p>
          ) : (
            <ul className="space-y-1">
              {copyableCandidates.map((brand) => (
                <li key={brand.id}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={copySelected.has(brand.id)}
                      disabled={copying}
                      onChange={(event) => {
                        setCopySelected((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(brand.id);
                          else next.delete(brand.id);
                          return next;
                        });
                      }}
                    />
                    {brand.brand_name} — {brand.epa_registration ?? 'no EPA number'}
                    {!brand.is_currently_sourced && <span className="text-secondary">(not sourced)</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>
    </Card>
  );
}
