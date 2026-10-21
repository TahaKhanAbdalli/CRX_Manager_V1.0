import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import Modal from './Modal';
import Button from './Button';
import { formatCents } from '../../lib/money';
import type { BelowCostApprovalDetail } from '../../lib/belowCostApproval';

interface Props {
  open: boolean;
  detail: BelowCostApprovalDetail | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

export default function BelowCostApprovalModal({ open, detail, onCancel, onConfirm }: Props) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);

  const trimmedReason = reason.trim();
  const price = detail?.unit_price_cents;
  const cost = detail?.locked_unit_cost_cents;
  const hasMoney = price != null && cost != null;
  const zeroLines = detail?.zero_line_product_names ?? [];
  const shortfall = hasMoney ? cost - price : null;
  // A blend-ticket chemical on a grower-share field is billed inside that field's per-acre price,
  // so its own line is $0 without being free (20261021070000).
  const zeroLineDetails = detail?.zero_lines ?? [];
  // A line can be both: quoted at $0 on one share and inside a grower-share price on another.
  const isMixed = (kind: string | null) => kind === 'quoted_zero_and_grower_share';
  const isGrowerShare = (kind: string | null) => kind?.includes('grower_share') ?? false;
  const anyGrowerShare = zeroLineDetails.some((line) => isGrowerShare(line.kind));
  const allGrowerShare = zeroLineDetails.length > 0 && zeroLineDetails.every((line) => line.kind === 'grower_share');
  const lineNote = (kind: string | null) => (isMixed(kind)
    ? ' (quoted at $0 on one share, included in a grower-share per-acre price on another)'
    : isGrowerShare(kind) ? ' (included in a grower-share per-acre price)' : '');
  const listedLines = zeroLineDetails.length === zeroLines.length && zeroLineDetails.length > 0
    ? zeroLineDetails.map((line, index) => ({
        name: line.product_name ?? zeroLines[index],
        // Each approved line's own cost per unit (admins only; the database never sends it to a rep).
        note: `${line.cost_cents != null ? ` — cost ${formatCents(line.cost_cents)} per unit` : ''}${lineNote(line.kind)}`,
      }))
    : zeroLines.map((name) => ({ name, note: '' }));

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Approve below-cost price"
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onCancel} className="min-h-11 w-full sm:w-auto">Cancel</Button>
          <Button
            variant="danger"
            icon={<AlertTriangle className="h-4 w-4" />}
            onClick={() => onConfirm(trimmedReason)}
            disabled={!trimmedReason}
            className="min-h-11 w-full sm:w-auto"
          >
            Approve and Retry
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <div>
              <p className="font-medium">{detail?.product_name || 'This product'} is priced below its locked cost.</p>
              {price === 0 && (
                <p className="mt-1">
                  {allGrowerShare
                    ? 'It is included in a grower-share per-acre price, so its own line is billed at $0.'
                    : zeroLineDetails.length === 1 && isMixed(zeroLineDetails[0].kind)
                      ? 'It is quoted at $0 on one share and included in a grower-share per-acre price on another, so it is billed at $0 on both.'
                    : anyGrowerShare
                      ? 'Each line below is billed at $0: quoted at $0, or included in a grower-share per-acre price.'
                      : 'It is priced at $0, so it will be billed free of charge.'}
                </p>
              )}
              {listedLines.length > 1 && (
                <div className="mt-2">
                  <p className="font-medium">Your approval covers every product below, each billed at $0:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {listedLines.map((line, index) => <li key={`${index}-${line.name}`}>{line.name}{line.note}</li>)}
                  </ul>
                </div>
              )}
              {hasMoney && shortfall !== null && (
                <p className="mt-1 tabular-nums">
                  Price {formatCents(price)} · Cost {formatCents(cost)} · Shortfall {formatCents(shortfall)} per unit
                </p>
              )}
              <p className="mt-2">
                The database reported this line first. Approving applies your reason to{' '}
                <span className="font-medium">every below-cost line in this save</span>, not only the one shown —
                review the other line prices before approving if you are unsure.
              </p>
            </div>
          </div>
        </div>
        <div>
          <label htmlFor="below-cost-approval-reason" className="mb-1 block text-sm font-medium text-nav-dark">
            Approval reason (required)
          </label>
          <textarea
            id="below-cost-approval-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            placeholder="Example: approved price match for this customer"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green/20"
          />
        </div>
      </div>
    </Modal>
  );
}
