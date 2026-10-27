import { formatUSD } from '../../lib/money';

// Display-only: both costs and the price arrive as dollars with at most two decimals, so they are
// compared as whole cents.
const toCents = (dollars: number) => Math.round(dollars * 100);

interface QuoteLineCostProps {
  /** The cost the line's profit and margin use: its quote-time cost once saved. */
  quotedCost: number;
  /** The product's cost today; null when the line is not yet quoted or the product list carries no cost. */
  todayCost: number | null;
  pricePerUnit: number;
}

/**
 * Admin-only cost cell for a quote line (To-Do 0.5): the cost when quoted beside today's cost, so
 * a sent quote whose price is locked shows when it has lost margin. Callers render it only where
 * cost is visible (never in Customer View, for sales reps, or on PDFs).
 */
export function QuoteLineCost({ quotedCost, todayCost, pricePerUnit }: QuoteLineCostProps) {
  const rose = todayCost != null && toCents(todayCost) > toCents(quotedCost);
  const belowCostToday = todayCost != null && toCents(todayCost) > 0 && toCents(pricePerUnit) < toCents(todayCost);
  let todayClass = 'text-gray-400';
  let todayFlag: string | null = null;
  let todayNote: string | undefined;
  if (belowCostToday) {
    todayClass = 'text-red-600 font-semibold';
    todayFlag = 'below cost';
    todayNote = 'The price is below today\'s cost. Converting needs an admin\'s below-cost approval.';
  } else if (rose) {
    todayClass = 'text-amber-600';
    todayFlag = 'up';
    todayNote = 'Cost has gone up since this line was quoted.';
  }
  return (
    <div className="leading-tight">
      <div>{formatUSD(quotedCost)}</div>
      {todayCost != null && (
        <div className={`text-xs whitespace-nowrap ${todayClass}`} title={todayNote}>
          today {formatUSD(todayCost)}{todayFlag ? ` · ${todayFlag}` : ''}
        </div>
      )}
    </div>
  );
}
