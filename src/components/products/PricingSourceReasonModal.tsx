import { useState } from 'react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Modal from '../ui/Modal';

export interface PricingSourceReason {
  source: string;
  reason: string;
}

interface PricingSourceReasonModalProps {
  open: boolean;
  busy: boolean;
  /** How many products the change covers, for the heading. */
  productCount: number;
  /** A reason already typed elsewhere (the cost note), to start from. */
  initialReason?: string;
  onCancel: () => void;
  onSubmit: (value: PricingSourceReason) => void;
}

/**
 * Asks where a new price or cost came from and why, before a product-page or Products-list change is
 * previewed. The database refuses a price or cost change without both (20261027050000).
 */
export default function PricingSourceReasonModal({
  open,
  busy,
  productCount,
  initialReason = '',
  onCancel,
  onSubmit,
}: PricingSourceReasonModalProps) {
  const [source, setSource] = useState('');
  const [reason, setReason] = useState(initialReason);
  const ready = source.trim().length > 0 && reason.trim().length > 0;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      closeDisabled={busy}
      title="Where did this price come from?"
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button
            onClick={() => onSubmit({ source: source.trim(), reason: reason.trim() })}
            disabled={!ready}
            loading={busy}
          >
            Preview changes
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-secondary">
          {productCount === 1 ? 'This change' : `These changes to ${productCount} products`} will be saved in the
          price history with the source and reason below.
        </p>
        <Input
          id="pricing-change-source"
          label="Source (supplier, document, date)"
          placeholder="e.g. Helena price list, Oct 2026"
          value={source}
          maxLength={200}
          disabled={busy}
          onChange={(event) => setSource(event.target.value)}
        />
        <Input
          id="pricing-change-reason"
          label="Reason for the change"
          placeholder="e.g. Supplier raised cost"
          value={reason}
          maxLength={500}
          disabled={busy}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
    </Modal>
  );
}
