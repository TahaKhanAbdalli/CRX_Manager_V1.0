import { useCallback, useEffect, useMemo, useState } from 'react';
import { History } from 'lucide-react';
import Card, { CardHeader } from '../ui/Card';
import { LoadFailedState } from '../ui/EmptyState';
import { formatCents } from '../../lib/money';
import { Sentry } from '../../lib/sentry';
import { fetchLastChargedPrices, formatChargedOn, formatChargedTier } from '../../lib/lastChargedPrices';
import type { LastChargedPrice } from '../../types';

export interface LastChargedLine {
  productId: string;
  productName: string;
}

// A result remembers the product list it was loaded for, so a changed list shows "Loading" at once
// instead of the old result (where a newly added product would read "Never charged" for a moment).
type LoadState =
  | { status: 'loading' }
  | { status: 'failed'; productKey: string }
  | { status: 'loaded'; productKey: string; byProduct: Map<string, LastChargedPrice> };

/**
 * "What did we charge this customer before?" (To-Do 0.3): for each product on the quote, the last
 * price charged to this customer, with its tier and date. Shown to admins and sales reps, never in
 * Customer View or on the PDF. Read-only: it never changes a quote price.
 */
export default function LastChargedPrices({ customerId, lines }: { customerId: string; lines: LastChargedLine[] }) {
  // One row per product, in quote order; a product on two lines has one last charge.
  const products = useMemo(() => {
    const seen = new Map<string, LastChargedLine>();
    for (const line of lines) {
      if (line.productId && !seen.has(line.productId)) seen.set(line.productId, line);
    }
    return [...seen.values()];
  }, [lines]);
  const productKey = products.map((p) => p.productId).join(',');
  const [loadState, setState] = useState<LoadState>({ status: 'loading' });
  const state: LoadState = loadState.status !== 'loading' && loadState.productKey !== productKey
    ? { status: 'loading' }
    : loadState;
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!customerId || productKey === '') return;
    let cancelled = false;
    setState({ status: 'loading' });
    fetchLastChargedPrices(customerId, productKey.split(','))
      .then((byProduct) => { if (!cancelled) setState({ status: 'loaded', productKey, byProduct }); })
      .catch((error: unknown) => {
        if (cancelled) return;
        Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
          extra: { context: 'get_last_charged_prices' },
        });
        setState({ status: 'failed', productKey });
      });
    return () => { cancelled = true; };
  }, [customerId, productKey, attempt]);

  if (!customerId || products.length === 0) return null;

  return (
    <Card>
      <CardHeader title="Last" accent="Charged" />
      <p className="text-xs text-secondary mb-3 flex items-center gap-1">
        <History className="w-3.5 h-3.5" aria-hidden="true" />
        The last price this customer was charged for each product: from posted, paid or overdue
        invoices, or from confirmed or delivered orders not yet invoiced. For reference only; it does
        not change this quote.
      </p>
      {state.status === 'loading' && (
        <p className="text-sm text-secondary" role="status">Loading last charged prices…</p>
      )}
      {state.status === 'failed' && (
        <LoadFailedState title="Last charged prices could not be loaded" onRetry={retry} />
      )}
      {state.status === 'loaded' && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Last price charged to this customer for each product on this quote</caption>
            <thead>
              <tr className="text-left text-xs text-secondary uppercase tracking-wide border-b border-gray-200">
                <th scope="col" className="py-2 pr-3 font-medium">Product</th>
                <th scope="col" className="py-2 pr-3 font-medium text-right">Last charged</th>
                <th scope="col" className="py-2 pr-3 font-medium">Tier</th>
                <th scope="col" className="py-2 pr-3 font-medium">Date</th>
                <th scope="col" className="py-2 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => {
                const charge = state.byProduct.get(product.productId);
                return (
                  <tr key={product.productId} className="border-b border-gray-100 last:border-0">
                    <th scope="row" className="py-2 pr-3 text-left font-normal text-nav-dark">{product.productName}</th>
                    {charge ? (
                      <>
                        <td className="py-2 pr-3 text-right">
                          <span className="font-mono">{formatCents(charge.unit_price_cents)}</span>
                          {/* The size that line was sold in: the price is per this unit. */}
                          {charge.unit_size && <span className="text-secondary"> / {charge.unit_size}</span>}
                        </td>
                        <td className="py-2 pr-3">{formatChargedTier(charge.price_tier)}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{formatChargedOn(charge.charged_on)}</td>
                        <td className="py-2">{charge.source === 'invoice' ? 'Invoice' : 'Order'}</td>
                      </>
                    ) : (
                      <td className="py-2 text-secondary" colSpan={4}>Never charged to this customer</td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
