import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Save } from 'lucide-react';
import Button from '../ui/Button';
import Card, { CardHeader } from '../ui/Card';
import Input from '../ui/Input';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import {
  fetchMarginFloor,
  fetchMarginFloorHistory,
  formatMarginFloorPercent,
  formatNetMarginPercent,
  isMarginFloorRefusal,
  isUnderMarginFloor,
  marginFloorErrorMessage,
  parseMarginFloorPercent,
  setMarginFloors,
} from '../../lib/marginFloors';
import { Sentry } from '../../lib/sentry';
import type { MarginFloorHistoryEntry } from '../../lib/marginFloors';

interface ProductMarginFloorCardProps {
  productId: string;
  /** The saved net margins (ratios) of tiers 1-3, to show which are under the floor. */
  tierMargins: [number | null | undefined, number | null | undefined, number | null | undefined];
  /** The signed-in admin's profile id. */
  userId: string;
  /** Told whether the floor has an unsaved edit, so the page can warn before it is left. */
  onDirtyChange?: (dirty: boolean) => void;
}

function floorLabel(floor: number | null): string {
  return floor == null ? 'none' : `${formatMarginFloorPercent(floor)}%`;
}

/**
 * The product's net-margin floor (To-Do 0.2). Admin-only: the page renders it for admins only, and
 * the database refuses everyone else. The price sheet does not read floors yet: its low-margin warning is
 * To-Do 0.1, and the card's text says so until then.
 */
export default function ProductMarginFloorCard({ productId, tierMargins, userId, onDirtyChange }: ProductMarginFloorCardProps) {
  const { toast } = useToast();
  const { getKeyFor, resetKeyFor } = useIdempotencyKey('set_product_margin_floors', userId);
  const [floor, setFloor] = useState<number | null>(null);
  const [history, setHistory] = useState<MarginFloorHistoryEntry[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [draft, setDraft] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  // The page keys this card by product, so a new product gets a new card. A load or save still in
  // flight when this card goes away must not report into the next product's page.
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);
  // Only the newest load may install values.
  const loadSeqRef = useRef(0);
  const load = useCallback(async (): Promise<boolean> => {
    const seq = ++loadSeqRef.current;
    try {
      const [current, changes] = await Promise.all([fetchMarginFloor(productId), fetchMarginFloorHistory(productId)]);
      if (seq !== loadSeqRef.current || !activeRef.current) return false;
      setFloor(current);
      setHistory(changes);
      setDraft(formatMarginFloorPercent(current));
      setLoadState('loaded');
      return true;
    } catch (err) {
      if (seq !== loadSeqRef.current || !activeRef.current) return false;
      Sentry.captureException(err, { extra: { context: 'load_product_margin_floor', productId } });
      setLoadState('failed');
      return false;
    }
  }, [productId]);

  useEffect(() => {
    setLoadState('loading');
    void load();
  }, [load]);

  const handleSave = async () => {
    let percent: number | null;
    try {
      percent = parseMarginFloorPercent(draft);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Enter a valid margin floor.');
      return;
    }
    // One key per exact request: a retry of the same save replays; a changed one is a new save.
    const scope = JSON.stringify([productId, percent, reason.trim()]);
    setSaving(true);
    try {
      const result = await setMarginFloors({
        changes: [{ productId, marginFloorPercent: percent }],
        reason,
        performedBy: userId,
        idempotencyKey: getKeyFor(scope),
      });
      resetKeyFor(scope);
      // The page moved to another product while this save ran: say nothing about it there.
      if (!activeRef.current) return;
      setReason('');
      const reloaded = await load();
      if (!reloaded) {
        toast('warning', 'The floor was saved, but it could not be reloaded. Refresh this page.');
      } else if (result.changed_count === 0) {
        toast('info', 'The margin floor is unchanged.');
      } else {
        toast('success', percent === null ? 'Margin floor cleared.' : `Margin floor set to ${formatMarginFloorPercent(percent / 100)}%.`);
      }
    } catch (err) {
      if (!isMarginFloorRefusal(err)) Sentry.captureException(err, { extra: { context: 'set_product_margin_floor', productId } });
      if (activeRef.current) toast('error', marginFloorErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const underTiers = tierMargins
    .map((margin, i) => ({ tier: i + 1, margin }))
    .filter(({ margin }) => isUnderMarginFloor(margin, floor));
  // Compare values, not text: "15.00" is the saved 15% floor. Text that does not parse counts as a
  // change, so Save explains what is wrong with it.
  const draftValue = (() => {
    try {
      const percent = parseMarginFloorPercent(draft);
      return percent === null ? '' : String(percent);
    } catch {
      return null;
    }
  })();
  const dirty = loadState === 'loaded' && draftValue !== formatMarginFloorPercent(floor);
  // A saved floor reloads into the draft, so dirty clears itself after a save. A card that goes away
  // (another product, or the page closing) leaves nothing unsaved behind it.
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(false); }, [onDirtyChange]);

  return (
    <Card>
      <CardHeader title="Margin" accent="Floor" />
      {loadState === 'loading' && <p className="text-sm text-secondary">Loading the margin floor…</p>}
      {loadState === 'failed' && (
        <div className="space-y-2">
          <p className="text-sm text-red-700" role="alert">The margin floor could not be loaded.</p>
          <Button variant="secondary" size="sm" showChevron={false} onClick={() => { setLoadState('loading'); void load(); }}>
            Try again
          </Button>
        </div>
      )}
      {loadState === 'loaded' && (
        <div className="space-y-3">
          <p className="text-xs text-gray-600">
            The lowest net margin (profit % of price) this product should sell at. Tiers below it are flagged here and
            on the Products list. The price sheet does not check floors yet, so a below-floor price can still be
            applied there without a warning. Leave it blank for no floor. The floor saves on its own with Save floor,
            not with Save Changes.
          </p>
          {underTiers.length > 0 && (
            <div className="flex items-start gap-2 p-2 rounded-lg border border-amber-300 bg-amber-50 text-xs text-amber-900" role="status">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>
                {underTiers.map(({ tier, margin }) => `Tier ${tier} is at ${formatNetMarginPercent(margin as number, floor)}%`).join('; ')}
                {` — under the ${floorLabel(floor)} floor.`}
              </span>
            </div>
          )}
          {/* Locked while a save and its reload run, so nothing typed meanwhile is replaced. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              id="product-margin-floor"
              disabled={saving}
              label="Floor (net margin %)"
              // Text, not number: a number box reports text it cannot read as "", which would clear the floor.
              type="text"
              inputMode="decimal"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="No floor"
            />
            <Input
              id="product-margin-floor-reason"
              label="Reason (optional)"
              disabled={saving}
              value={reason}
              maxLength={500}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g., Supplier program minimum"
            />
          </div>
          <div className="flex justify-end">
            <Button size="sm" icon={<Save className="w-3 h-3" />} showChevron={false} onClick={handleSave} loading={saving} disabled={!dirty}>
              Save floor
            </Button>
          </div>
          {history.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-secondary mb-1">Recent changes</h4>
              <ul className="text-xs text-gray-600 space-y-1">
                {history.map((change) => (
                  <li key={change.id}>
                    {new Date(change.created_at).toLocaleDateString('en-US', { timeZone: 'America/Chicago' })}:{' '}
                    {floorLabel(change.old_margin_floor)} → {floorLabel(change.new_margin_floor)}
                    {change.changed_by_name ? ` by ${change.changed_by_name}` : ''}
                    {change.reason ? ` (${change.reason})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
