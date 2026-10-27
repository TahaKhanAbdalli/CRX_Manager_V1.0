import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetchLastChargedPrices: vi.fn(), captureException: vi.fn() }));

vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: mocks.captureException } }));
vi.mock('../../lib/lastChargedPrices', async () => {
  const actual = await vi.importActual<typeof import('../../lib/lastChargedPrices')>('../../lib/lastChargedPrices');
  return { ...actual, fetchLastChargedPrices: mocks.fetchLastChargedPrices };
});

import LastChargedPrices from './LastChargedPrices';

const lines = [
  { productId: 'p1', productName: 'Roundup PowerMAX' },
  { productId: 'p2', productName: 'Warrant' },
  { productId: 'p1', productName: 'Roundup PowerMAX' },
];

describe('LastChargedPrices', () => {
  beforeEach(() => {
    mocks.fetchLastChargedPrices.mockReset();
    mocks.captureException.mockReset();
  });

  it('lists each product once with its last charge, or says it was never charged', async () => {
    mocks.fetchLastChargedPrices.mockResolvedValue(new Map([
      ['p1', { product_id: 'p1', unit_price_cents: 4250, price_tier: 2, unit_size: '2.5 gal', charged_on: '2026-03-03', source: 'invoice' }],
    ]));
    render(<LastChargedPrices customerId="c1" lines={lines} />);
    const roundup = (await screen.findByText('Roundup PowerMAX')).closest('tr') as HTMLElement;
    expect(mocks.fetchLastChargedPrices).toHaveBeenCalledWith('c1', ['p1', 'p2']);
    expect(within(roundup).getByText('$42.50')).toBeInTheDocument();
    // The size the charge was made in, not the quote line's.
    expect(within(roundup).getByText('/ 2.5 gal')).toBeInTheDocument();
    expect(within(roundup).getByRole('rowheader')).toHaveTextContent('Roundup PowerMAX');
    expect(within(roundup).getByText('Tier 2')).toBeInTheDocument();
    expect(within(roundup).getByText('Mar 3, 2026')).toBeInTheDocument();
    expect(within(roundup).getByText('Invoice')).toBeInTheDocument();
    const warrant = screen.getByText('Warrant').closest('tr') as HTMLElement;
    expect(within(warrant).getByText('Never charged to this customer')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + two products
  });

  it('shows Loading, not "Never charged", for a product added after the last load', async () => {
    mocks.fetchLastChargedPrices.mockResolvedValueOnce(new Map());
    let resolveSecond!: (value: Map<string, unknown>) => void;
    mocks.fetchLastChargedPrices.mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve; }));
    const { rerender } = render(<LastChargedPrices customerId="c1" lines={[lines[1]]} />);
    expect(await screen.findByText('Never charged to this customer')).toBeInTheDocument();
    rerender(<LastChargedPrices customerId="c1" lines={lines} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading last charged prices');
    expect(screen.queryByText('Never charged to this customer')).not.toBeInTheDocument();
    resolveSecond(new Map());
    expect(await screen.findAllByText('Never charged to this customer')).toHaveLength(2);
  });

  it('shows nothing until a customer and a product are picked', () => {
    const { container, rerender } = render(<LastChargedPrices customerId="" lines={lines} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<LastChargedPrices customerId="c1" lines={[]} />);
    expect(container).toBeEmptyDOMElement();
    expect(mocks.fetchLastChargedPrices).not.toHaveBeenCalled();
  });

  it('says a failed load could not be loaded, reports it, and retries', async () => {
    mocks.fetchLastChargedPrices.mockRejectedValueOnce(new Error('network'));
    mocks.fetchLastChargedPrices.mockResolvedValueOnce(new Map());
    render(<LastChargedPrices customerId="c1" lines={lines} />);
    expect(await screen.findByText('Last charged prices could not be loaded')).toBeInTheDocument();
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findAllByText('Never charged to this customer')).toHaveLength(2);
    expect(mocks.fetchLastChargedPrices).toHaveBeenCalledTimes(2);
  });
});
