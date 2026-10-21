import { useEffect, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { formatCents } from '../../lib/money';
import type { BlendQuotePriceChoice } from '../../lib/blendTicketPricing';

interface QuotePriceChoiceModalProps {
  /** The lines the invoice stopped on; `null` closes the modal. */
  choices: BlendQuotePriceChoice[] | null;
  saving: boolean;
  onClose: () => void;
  /** Called with blend-ticket line id -> chosen quote item id, one entry per line. */
  onConfirm: (picks: Record<string, string>) => void;
}

/**
 * Goal 3 "Pricing": the job's quote lists a product more than once at different prices, so the
 * blend-ticket invoice stopped. Staff pick which quoted price to bill for each such line.
 */
export default function QuotePriceChoiceModal({ choices, saving, onClose, onConfirm }: QuotePriceChoiceModalProps) {
  const [picks, setPicks] = useState<Record<string, string>>({});

  // A new set of choices starts with nothing picked: never carry a pick across tickets or attempts.
  useEffect(() => {
    setPicks({});
  }, [choices]);

  const allPicked = Boolean(choices && choices.every((choice) => picks[choice.blendTicketProductId]));

  return (
    <Modal
      open={choices !== null}
      onClose={onClose}
      closeDisabled={saving}
      title="Pick the quoted price"
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => onConfirm(picks)} disabled={!allPicked} loading={saving}>
            Save price{choices && choices.length > 1 ? 's' : ''}
          </Button>
        </div>
      )}
    >
      <p className="text-sm text-secondary mb-4">
        The job&apos;s quote lists {choices && choices.length > 1 ? 'these products' : 'this product'} more than once
        at different prices. Pick the price this ticket should bill. Nothing has been invoiced yet; after you save,
        click Create Invoice again.
      </p>
      <div className="space-y-4">
        {choices?.map((choice) => (
          <fieldset key={choice.blendTicketProductId} className="border border-gray-200 rounded-lg p-3">
            <legend className="text-sm font-semibold text-nav-dark px-1">{choice.productName}</legend>
            <div className="space-y-2">
              {choice.options.map((option) => (
                <label key={option.quoteItemId} className="flex items-center gap-2 text-sm cursor-pointer min-h-[44px]">
                  <input
                    type="radio"
                    name={`quote-price-${choice.blendTicketProductId}`}
                    value={option.quoteItemId}
                    checked={picks[choice.blendTicketProductId] === option.quoteItemId}
                    onChange={() => setPicks((previous) => ({ ...previous, [choice.blendTicketProductId]: option.quoteItemId }))}
                    disabled={saving}
                  />
                  <span>{formatCents(option.priceCents)} per unit</span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
    </Modal>
  );
}
