import { useCallback, useEffect, useMemo, useState } from 'react';
import Card, { CardHeader } from '../ui/Card';
import { LoadFailedState } from '../ui/EmptyState';
import { formatCents } from '../../lib/money';
import { Sentry } from '../../lib/sentry';
import {
  sourceLabel,
  TIERS,
  fetchSellPriceHistory,
  sellPricePoints,
  timeFraction,
  type SellPricePoint,
  type TierKey,
} from '../../lib/sellPriceHistory';

const TIER_LABELS: Record<TierKey, string> = { tier1: 'Tier 1', tier2: 'Tier 2', tier3: 'Tier 3' };
const TIER_COLORS: Record<TierKey, string> = { tier1: '#15803d', tier2: '#2563eb', tier3: '#c2410c' };

// Chart box, in the SVG's 0..100 units: the plot sits inside these edges.
const LEFT = 5;
const RIGHT = 95;
const TOP = 10;
const BOTTOM = 90;

function formatDay(at: string): string {
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

type LoadState =
  | { status: 'loading' }
  | { status: 'failed' }
  // loadedAt ends the time axis: the last price is drawn as still in effect on that day.
  | { status: 'loaded'; points: SellPricePoint[]; loadedAt: string };

/**
 * Sell-price history (To-Do 0.4): each tier price over time on a real date axis, and every change
 * with its date, source and reason. Admin-only (Mason, 2026-10-14); the page renders it for admins
 * only and cost_history is admin-only in the database.
 */
export default function ProductSellPriceHistory({ productId, reloadToken = 0 }: { productId: string; reloadToken?: number }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetchSellPriceHistory(productId)
      .then((rows) => {
        if (!cancelled) setState({ status: 'loaded', points: sellPricePoints(rows), loadedAt: new Date().toISOString() });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
          extra: { context: 'sell_price_history' },
        });
        setState({ status: 'failed' });
      });
    return () => { cancelled = true; };
  }, [productId, reloadToken, attempt]);

  const chart = useMemo(() => {
    if (state.status !== 'loaded' || state.points.length === 0) return null;
    const { points } = state;
    const values = points.flatMap((p) => TIERS.map((t) => p.cents[t]).filter((c): c is number => c !== null));
    if (values.length === 0) return null;
    const start = points[0].at;
    // The axis runs to the day it loaded, so the last price is drawn as still in effect.
    const last = points[points.length - 1].at;
    const end = Date.parse(state.loadedAt) > Date.parse(last) ? state.loadedAt : last;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const x = (at: string) => LEFT + timeFraction(at, start, end) * (RIGHT - LEFT);
    const y = (cents: number) => (max === min ? 50 : BOTTOM - ((cents - min) / (max - min)) * (BOTTOM - TOP));
    // A step line per tier: flat until the next change, then a jump.
    const paths = TIERS.map((tier) => {
      const segments: string[] = [];
      let pen: { x: number; y: number } | null = null;
      for (const point of points) {
        const cents = point.cents[tier];
        const px = x(point.at);
        if (pen) segments.push(`L ${px} ${pen.y}`);
        if (cents === null) { pen = null; continue; }
        const py = y(cents);
        segments.push(`${pen ? 'L' : 'M'} ${px} ${py}`);
        pen = { x: px, y: py };
      }
      if (pen) segments.push(`L ${RIGHT} ${pen.y}`);
      return { tier, d: segments.join(' ') };
    });
    return { paths, start, end, min, max, x, y };
  }, [state]);

  return (
    <Card>
      <CardHeader title="Sell Price" accent="History" />
      {state.status === 'loading' && <p className="text-sm text-secondary" role="status">Loading sell price history…</p>}
      {state.status === 'failed' && <LoadFailedState title="Sell price history could not be loaded" onRetry={retry} />}
      {state.status === 'loaded' && state.points.length === 0 && (
        <p className="text-sm text-secondary">No price changes recorded since this product was created.</p>
      )}
      {state.status === 'loaded' && chart && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <svg
            role="img"
            aria-label={`Sell prices by tier from ${formatDay(chart.start)} to ${formatDay(chart.end)}`}
            viewBox="0 0 100 100"
            className="h-40 w-full overflow-visible"
            preserveAspectRatio="none"
          >
            <line x1={LEFT} x2={RIGHT} y1={BOTTOM} y2={BOTTOM} stroke="#d1d5db" strokeWidth="0.7" vectorEffect="non-scaling-stroke" />
            <line x1={LEFT} x2={LEFT} y1={TOP} y2={BOTTOM} stroke="#d1d5db" strokeWidth="0.7" vectorEffect="non-scaling-stroke" />
            {chart.paths.map(({ tier, d }) => (
              d ? <path key={tier} d={d} fill="none" stroke={TIER_COLORS[tier]} strokeWidth="2" vectorEffect="non-scaling-stroke" /> : null
            ))}
            {state.points.map((point) => TIERS.map((tier) => {
              const cents = point.cents[tier];
              if (cents === null) return null;
              return (
                <circle key={`${point.id}:${tier}`} cx={chart.x(point.at)} cy={chart.y(cents)} r="1.6" fill={TIER_COLORS[tier]}>
                  <title>{`${TIER_LABELS[tier]}: ${formatCents(cents)} from ${formatDay(point.at)}`}</title>
                </circle>
              );
            }))}
          </svg>
          <div className="mt-1 flex justify-between text-xs text-secondary tabular-nums">
            <span>{formatDay(chart.start)}</span>
            <span>{formatCents(chart.min)} – {formatCents(chart.max)}</span>
            <span>{formatDay(chart.end)}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-xs text-secondary">
            {TIERS.map((tier) => (
              <span key={tier} className="inline-flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: TIER_COLORS[tier] }} />
                {TIER_LABELS[tier]}
              </span>
            ))}
          </div>
        </div>
      )}
      {state.status === 'loaded' && state.points.length > 0 && (
        // Scrollable, so it takes keyboard focus (and says what it is) for keyboard scrolling.
        <ul className="mt-4 max-h-96 space-y-3 overflow-y-auto" tabIndex={0} aria-label="Sell price changes, newest first">
          {[...state.points].reverse().map((point) => (
            <li key={point.id} className="border-b border-gray-100 pb-3 last:border-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-nav-dark">{formatDay(point.at)}</span>
                <span className="text-xs text-secondary">{sourceLabel(point.source)}</span>
              </div>
              <dl className="mt-1 grid grid-cols-3 gap-2 text-sm tabular-nums">
                {TIERS.map((tier) => {
                  const before = point.previousCents[tier];
                  const after = point.cents[tier];
                  const moved = !point.isStartingPoint && before !== after;
                  return (
                    <div key={tier}>
                      <dt className="text-xs text-secondary">{TIER_LABELS[tier]}</dt>
                      <dd>
                        {moved && (
                          <span className="mr-1 text-red-500 line-through">
                            <span className="sr-only">was </span>{before === null ? '—' : formatCents(before)}
                          </span>
                        )}
                        <span className={moved ? 'font-medium text-crx-green' : 'text-nav-dark'}>
                          {moved && <span className="sr-only">now </span>}{after === null ? '—' : formatCents(after)}
                        </span>
                      </dd>
                    </div>
                  );
                })}
              </dl>
              {point.reason && <p className="mt-1 text-xs text-secondary">{point.reason}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
