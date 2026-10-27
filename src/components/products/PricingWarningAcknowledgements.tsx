import { AlertTriangle } from 'lucide-react';
import {
  PRICING_ACK_REASON_MAX,
  PRICING_WARNING_LABELS,
  type PricingPreviewRow,
  type PricingWarning,
} from '../../lib/productPricing';

interface PricingWarningAcknowledgementsProps {
  warnings: PricingWarning[];
  rows: PricingPreviewRow[];
  reasons: Record<string, string>;
  disabled: boolean;
  onReasonChange: (productId: string, reason: string) => void;
}

function centsToDollars(cents: bigint | null): string {
  if (cents === null) return '—';
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? '-' : ''}$${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

function productName(warning: PricingWarning, rows: PricingPreviewRow[]): string {
  const row = rows.find((candidate) => candidate.product_id === warning.product_id);
  const name = row?.effect?.product_name ?? row?.submitted_row.product_name;
  return typeof name === 'string' && name.trim() ? name : warning.product_id;
}

function WarningDetail({ warning }: { warning: PricingWarning }) {
  const { details } = warning;
  const costMoved = details.cost_before_cents !== details.cost_after_cents;
  return (
    <ul className="mt-2 space-y-1 text-xs text-amber-900">
      {warning.warning_codes.map((code) => (
        <li key={code}>
          <span className="font-semibold">{PRICING_WARNING_LABELS[code]}</span>
          {code === 'COST_MOVE_OVER_10_PERCENT' && costMoved
            && `: ${centsToDollars(details.cost_before_cents)} → ${centsToDollars(details.cost_after_cents)}`}
          {code === 'MARGIN_UNDER_FLOOR' && details.margin_floor !== null
            && `: floor ${Number((details.margin_floor * 100).toFixed(2))}%`}
          {code === 'OPEN_SENT_QUOTE'
            && `: ${details.open_quote_count} quote${details.open_quote_count === 1 ? '' : 's'}`
            + (details.open_quote_numbers.length > 0 ? ` (${details.open_quote_numbers.join(', ')})` : '')}
        </li>
      ))}
    </ul>
  );
}

/** Every warned product, with the reason the admin must give before the change set can be approved. */
export default function PricingWarningAcknowledgements({
  warnings,
  rows,
  reasons,
  disabled,
  onReasonChange,
}: PricingWarningAcknowledgementsProps) {
  if (warnings.length === 0) return null;
  return (
    <section aria-label="Warnings to acknowledge" className="rounded-xl border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
        <div>
          <div className="text-sm font-semibold text-amber-900">
            {warnings.length} product{warnings.length === 1 ? ' needs' : 's need'} a reason before applying
          </div>
          <p className="mt-0.5 text-xs text-amber-900">
            Say why each warning is acceptable. The reason is saved with the approval.
          </p>
        </div>
      </div>
      <ol className="mt-3 space-y-3">
        {warnings.map((warning) => {
          const name = productName(warning, rows);
          const reason = reasons[warning.product_id] ?? '';
          const inputId = `pricing-ack-${warning.product_id}`;
          return (
            <li key={warning.product_id} className="rounded-lg border border-amber-200 bg-white p-3">
              <div className="text-sm font-semibold text-nav-dark">{name}</div>
              <WarningDetail warning={warning} />
              <label htmlFor={inputId} className="mt-2 block text-xs font-medium text-secondary">
                Why is this acceptable?
              </label>
              <textarea
                id={inputId}
                aria-label={`Reason for ${name}`}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                rows={2}
                maxLength={PRICING_ACK_REASON_MAX}
                value={reason}
                disabled={disabled}
                onChange={(event) => onReasonChange(warning.product_id, event.target.value)}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}
