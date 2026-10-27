import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchSellPriceHistory: vi.fn(), captureException: vi.fn() }));

vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));
vi.mock('../../lib/sellPriceHistory', async () => {
  const actual = await vi.importActual<typeof import('../../lib/sellPriceHistory')>('../../lib/sellPriceHistory');
  return { ...actual, fetchSellPriceHistory: mocks.fetchSellPriceHistory };
});

import ProductSellPriceHistory from './ProductSellPriceHistory';

const base = {
  change_reason: null, change_note: null,
  old_tier2_price: 9.5, new_tier2_price: 9.5, old_tier3_price: null, new_tier3_price: null,
};

describe('ProductSellPriceHistory', () => {
  beforeEach(() => {
    mocks.fetchSellPriceHistory.mockReset();
    mocks.captureException.mockReset();
  });

  it('charts each tier on a date axis and lists the starting point and each change, newest first', async () => {
    mocks.fetchSellPriceHistory.mockResolvedValue([
      { ...base, id: 's', changed_at: '2026-10-01T15:00:00Z', change_source: 'starting_snapshot', change_reason: 'Prices when price history started', old_tier1_price: 10, new_tier1_price: 10 },
      { ...base, id: 'r', changed_at: '2026-10-20T15:00:00Z', change_source: 'pricing_worksheet', change_reason: 'Wells letter', old_tier1_price: 10, new_tier1_price: 11 },
    ]);
    render(<ProductSellPriceHistory productId="p1" />);
    const chart = await screen.findByRole('img', { name: /Sell prices by tier from Oct 1, 2026 to/ });
    // Tier 1 and tier 2 at both points; tier 3 has no price.
    expect(chart.querySelectorAll('circle')).toHaveLength(4);
    expect(chart.querySelectorAll('path')).toHaveLength(2);

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('Price sheet')).toBeInTheDocument();
    expect(within(items[0]).getByText('$10.00')).toHaveClass('line-through');
    expect(within(items[0]).getByText('$11.00')).toBeInTheDocument();
    expect(within(items[0]).getByText('Wells letter')).toBeInTheDocument();
    expect(within(items[1]).getByText('Starting point')).toBeInTheDocument();
    expect(within(items[1]).queryByText('$10.00')).not.toHaveClass('line-through');
  });

  it('draws the prices in effect before the first change of a product with older history', async () => {
    mocks.fetchSellPriceHistory.mockResolvedValue([
      { ...base, id: 'r', changed_at: '2026-10-20T15:00:00Z', change_source: 'product_page', old_tier1_price: 10, new_tier1_price: 11 },
    ]);
    render(<ProductSellPriceHistory productId="p1" />);
    const chart = await screen.findByRole('img', { name: /Sell prices by tier/ });
    // Tier 1's line starts at the left edge on its old price, then steps up at the change.
    const tier1 = chart.querySelector('path[stroke="#15803d"]');
    expect(tier1?.getAttribute('d')).toMatch(/^M 5 /);
    expect(screen.getByText(/^Before, then Oct 20, 2026$/)).toBeInTheDocument();
    // $10 (before) is the bottom of the range, $11 the top.
    expect(screen.getByText(/\$9\.50 – \$11\.00/)).toBeInTheDocument();
  });

  it('shows the prices of a product whose only logged change was to cost', async () => {
    mocks.fetchSellPriceHistory.mockResolvedValue([
      { ...base, id: 'c', changed_at: '2026-10-20T15:00:00Z', change_source: 'product_page', old_tier1_price: 10, new_tier1_price: 10 },
    ]);
    render(<ProductSellPriceHistory productId="p1" />);
    expect(await screen.findByRole('img', { name: /Sell prices by tier/ })).toBeInTheDocument();
    expect(screen.queryByText('No price changes recorded since this product was created.')).not.toBeInTheDocument();
  });

  it('never shows one product\'s history on another product\'s page', async () => {
    let resolveB: (rows: unknown[]) => void = () => {};
    mocks.fetchSellPriceHistory
      .mockResolvedValueOnce([
        { ...base, id: 'a', changed_at: '2026-10-20T15:00:00Z', change_source: 'product_page', change_reason: 'Product A change', old_tier1_price: 10, new_tier1_price: 11 },
      ])
      .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
    const { rerender } = render(<ProductSellPriceHistory productId="a" />);
    expect(await screen.findByText('Product A change')).toBeInTheDocument();
    rerender(<ProductSellPriceHistory productId="b" />);
    expect(screen.queryByText('Product A change')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading sell price history');
    resolveB([]);
    expect(await screen.findByText('No price changes recorded since this product was created.')).toBeInTheDocument();
  });

  it('says a failed load could not be loaded, reports it, and retries', async () => {
    mocks.fetchSellPriceHistory.mockRejectedValueOnce(new Error('network'));
    mocks.fetchSellPriceHistory.mockResolvedValueOnce([]);
    render(<ProductSellPriceHistory productId="p1" />);
    expect(await screen.findByText('Sell price history could not be loaded')).toBeInTheDocument();
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('No price changes recorded since this product was created.')).toBeInTheDocument();
  });
});
