import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BelowCostApprovalModal from './BelowCostApprovalModal';
import type { BelowCostApprovalDetail } from '../../lib/belowCostApproval';

const base: BelowCostApprovalDetail = {
  operation: 'create_invoice_from_blend_ticket',
  entity_type: 'blend_ticket',
  entity_id: 'tk-1',
  line_id: 'l1',
  product_id: 'p1',
  product_name: 'Atrazine 4L',
  unit_price_cents: 0,
  locked_unit_cost_cents: 500,
  zero_line_product_names: [],
  zero_lines: [],
};

function renderWith(detail: BelowCostApprovalDetail) {
  render(<BelowCostApprovalModal open detail={detail} onCancel={vi.fn()} onConfirm={vi.fn()} />);
  return screen.getByRole('dialog', { name: 'Approve below-cost price' });
}

describe('BelowCostApprovalModal — blend-ticket $0 lines (20261021070000)', () => {
  it('does not call a grower-share chemical free of charge', () => {
    const dialog = renderWith({
      ...base,
      zero_line_product_names: ['Atrazine 4L'],
      zero_lines: [{ line_id: 'l1', product_id: 'p1', product_name: 'Atrazine 4L', kind: 'grower_share', cost_cents: 500, basis: 'b1' }],
    });
    expect(within(dialog).getByText(/included in a grower-share per-acre price/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/free of charge/)).not.toBeInTheDocument();
  });

  it('says why each line is $0 when quoted and grower-share lines are mixed', () => {
    const dialog = renderWith({
      ...base,
      zero_line_product_names: ['Atrazine 4L', 'Roundup'],
      zero_lines: [
        { line_id: 'l1', product_id: 'p1', product_name: 'Atrazine 4L', kind: 'quoted_zero', cost_cents: 500, basis: 'b1' },
        { line_id: 'l2', product_id: 'p2', product_name: 'Roundup', kind: 'grower_share', cost_cents: 700, basis: 'b2' },
      ],
    });
    expect(within(dialog).getByText(/quoted at \$0, or included in a grower-share per-acre price/)).toBeInTheDocument();
    expect(within(dialog).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Atrazine 4L — cost $5.00 per unit',
      'Roundup — cost $7.00 per unit (included in a grower-share per-acre price)',
    ]);
  });

  it('keeps the free-of-charge wording for a $0 quoted line', () => {
    const dialog = renderWith({
      ...base,
      zero_line_product_names: ['Atrazine 4L'],
      zero_lines: [{ line_id: 'l1', product_id: 'p1', product_name: 'Atrazine 4L', kind: 'quoted_zero', cost_cents: 500, basis: 'b1' }],
    });
    expect(within(dialog).getByText(/billed free of charge/)).toBeInTheDocument();
  });

  it('gives both reasons for a line quoted at $0 on one share and in a grower-share price on another', () => {
    const dialog = renderWith({
      ...base,
      zero_line_product_names: ['Atrazine 4L'],
      zero_lines: [{ line_id: 'l1', product_id: 'p1', product_name: 'Atrazine 4L', kind: 'quoted_zero_and_grower_share', cost_cents: 500, basis: 'b1' }],
    });
    expect(within(dialog).getByText(/quoted at \$0 on one share and included in a grower-share per-acre price on another/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/^It is included in a grower-share per-acre price/)).not.toBeInTheDocument();
  });

  it('notes both reasons on a mixed line in the list', () => {
    const dialog = renderWith({
      ...base,
      zero_line_product_names: ['Atrazine 4L', 'Roundup'],
      zero_lines: [
        { line_id: 'l1', product_id: 'p1', product_name: 'Atrazine 4L', kind: 'quoted_zero_and_grower_share', cost_cents: 500, basis: 'b1' },
        { line_id: 'l2', product_id: 'p2', product_name: 'Roundup', kind: 'grower_share', cost_cents: 700, basis: 'b2' },
      ],
    });
    expect(within(dialog).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Atrazine 4L — cost $5.00 per unit (quoted at $0 on one share, included in a grower-share per-acre price on another)',
      'Roundup — cost $7.00 per unit (included in a grower-share per-acre price)',
    ]);
  });
});
