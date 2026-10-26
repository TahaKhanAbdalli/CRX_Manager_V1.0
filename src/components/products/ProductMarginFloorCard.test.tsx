import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  fetchMarginFloor: vi.fn(),
  fetchMarginFloorHistory: vi.fn(),
  setMarginFloors: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../../lib/marginFloors', async () => {
  const actual = await vi.importActual<typeof import('../../lib/marginFloors')>('../../lib/marginFloors');
  return {
    ...actual,
    fetchMarginFloor: mocks.fetchMarginFloor,
    fetchMarginFloorHistory: mocks.fetchMarginFloorHistory,
    setMarginFloors: mocks.setMarginFloors,
  };
});

import ProductMarginFloorCard from './ProductMarginFloorCard';

const change = {
  id: 'h1', product_id: 'p1', old_margin_floor: null, new_margin_floor: 0.15, reason: 'Program minimum',
  changed_by: 'u1', created_at: '2026-10-25T18:00:00Z', changed_by_name: 'Mason Wells',
};

describe('ProductMarginFloorCard', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.fetchMarginFloor.mockResolvedValue(0.15);
    mocks.fetchMarginFloorHistory.mockResolvedValue([change]);
  });

  it('shows the floor, flags each tier under it, and lists recent changes', async () => {
    render(<ProductMarginFloorCard productId="p1" tierMargins={[0.2, 0.1, null]} userId="u1" />);
    expect(await screen.findByLabelText('Floor (net margin %)')).toHaveValue('15');
    expect(screen.getByRole('status')).toHaveTextContent('Tier 2 is at 10.00% — under the 15% floor.');
    expect(screen.getByRole('status')).not.toHaveTextContent('Tier 1');
    expect(screen.getByText(/none → 15% by Mason Wells \(Program minimum\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save floor/i })).toBeDisabled();
  });

  it('says the price sheet does not check floors yet (its warning is To-Do 0.1)', async () => {
    render(<ProductMarginFloorCard productId="p1" tierMargins={[0.2, 0.1, null]} userId="u1" />);
    expect(await screen.findByText(/price sheet does not check floors yet/)).toBeInTheDocument();
    expect(screen.queryByText(/price sheet warns/)).not.toBeInTheDocument();
  });

  it('never shows a tier just under the floor rounded up to the floor', async () => {
    render(<ProductMarginFloorCard productId="p1" tierMargins={[0.2, 0.14996, null]} userId="u1" />);
    expect(await screen.findByRole('status')).toHaveTextContent('Tier 2 is at 14.99% — under the 15% floor.');
  });

  it('flags nothing when the product has no floor', async () => {
    mocks.fetchMarginFloor.mockResolvedValue(null);
    mocks.fetchMarginFloorHistory.mockResolvedValue([]);
    render(<ProductMarginFloorCard productId="p1" tierMargins={[-0.5, 0.01, 0]} userId="u1" />);
    expect(await screen.findByLabelText('Floor (net margin %)')).toHaveValue('');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('saves a new floor with its reason, then reloads', async () => {
    mocks.setMarginFloors.mockResolvedValue({ success: true, status: 'saved', changed_count: 1, unchanged_count: 0 });
    render(<ProductMarginFloorCard productId="p1" tierMargins={[0.2, 0.2, 0.2]} userId="u1" />);
    fireEvent.change(await screen.findByLabelText('Floor (net margin %)'), { target: { value: '14.3' } });
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'Wells letter' } });
    fireEvent.click(screen.getByRole('button', { name: /save floor/i }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('success', 'Margin floor set to 14.3%.'));
    const call = mocks.setMarginFloors.mock.calls[0][0];
    expect(call.changes).toEqual([{ productId: 'p1', marginFloorPercent: 14.3 }]);
    expect(call.reason).toBe('Wells letter');
    expect(call.performedBy).toBe('u1');
    expect(call.idempotencyKey).toMatch(/^set_product_margin_floors:u1:/);
    expect(mocks.fetchMarginFloor).toHaveBeenCalledTimes(2);
  });

  it('clears the floor when the box is emptied', async () => {
    mocks.setMarginFloors.mockResolvedValue({ success: true, status: 'saved', changed_count: 1, unchanged_count: 0 });
    render(<ProductMarginFloorCard productId="p1" tierMargins={[0.2, 0.2, 0.2]} userId="u1" />);
    fireEvent.change(await screen.findByLabelText('Floor (net margin %)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /save floor/i }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('success', 'Margin floor cleared.'));
    expect(mocks.setMarginFloors.mock.calls[0][0].changes).toEqual([{ productId: 'p1', marginFloorPercent: null }]);
  });

  it('refuses an invalid floor before calling the database', async () => {
    render(<ProductMarginFloorCard productId="p1" tierMargins={[0.2, 0.2, 0.2]} userId="u1" />);
    fireEvent.change(await screen.findByLabelText('Floor (net margin %)'), { target: { value: '12.345' } });
    fireEvent.click(screen.getByRole('button', { name: /save floor/i }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('error', expect.stringMatching(/0 to 99\.99/)));
    expect(mocks.setMarginFloors).not.toHaveBeenCalled();
  });

  it('retries a failed save with the same key, and a changed save with a new one', async () => {
    mocks.setMarginFloors.mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('network down'));
    render(<ProductMarginFloorCard productId="p1" tierMargins={[0.2, 0.2, 0.2]} userId="u1" />);
    const input = await screen.findByLabelText('Floor (net margin %)');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: /save floor/i }));
    await waitFor(() => expect(mocks.setMarginFloors).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /save floor/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /save floor/i }));
    await waitFor(() => expect(mocks.setMarginFloors).toHaveBeenCalledTimes(2));
    expect(mocks.setMarginFloors.mock.calls[1][0].idempotencyKey).toBe(mocks.setMarginFloors.mock.calls[0][0].idempotencyKey);
    await waitFor(() => expect(screen.getByRole('button', { name: /save floor/i })).not.toBeDisabled());
    fireEvent.change(input, { target: { value: '11' } });
    mocks.setMarginFloors.mockResolvedValue({ success: true, status: 'saved', changed_count: 1, unchanged_count: 0 });
    fireEvent.click(screen.getByRole('button', { name: /save floor/i }));
    await waitFor(() => expect(mocks.setMarginFloors).toHaveBeenCalledTimes(3));
    expect(mocks.setMarginFloors.mock.calls[2][0].idempotencyKey).not.toBe(mocks.setMarginFloors.mock.calls[0][0].idempotencyKey);
  });

  it('tells the page about an unsaved floor edit, and that it is gone after a save or unmount', async () => {
    const onDirtyChange = vi.fn();
    mocks.setMarginFloors.mockResolvedValue({ success: true, status: 'saved', changed_count: 1, unchanged_count: 0 });
    const { unmount } = render(
      <ProductMarginFloorCard productId="p1" tierMargins={[0.2, 0.2, 0.2]} userId="u1" onDirtyChange={onDirtyChange} />,
    );
    const input = await screen.findByLabelText('Floor (net margin %)');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    fireEvent.change(input, { target: { value: '16' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    // The save reloads 16% into the box, so nothing is unsaved any more.
    mocks.fetchMarginFloor.mockResolvedValue(0.16);
    fireEvent.click(screen.getByRole('button', { name: /save floor/i }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('success', 'Margin floor set to 16%.'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    fireEvent.change(input, { target: { value: '17' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('treats the same value written differently as unchanged', async () => {
    render(<ProductMarginFloorCard productId="p1" tierMargins={[0.2, 0.2, 0.2]} userId="u1" />);
    fireEvent.change(await screen.findByLabelText('Floor (net margin %)'), { target: { value: '15.00' } });
    expect(screen.getByRole('button', { name: /save floor/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Floor (net margin %)'), { target: { value: '15.5' } });
    expect(screen.getByRole('button', { name: /save floor/i })).not.toBeDisabled();
  });

  it('a save that finishes after moving to another product leaves that product alone', async () => {
    let finishSave: (value: unknown) => void = () => {};
    mocks.setMarginFloors.mockReturnValue(new Promise((resolve) => { finishSave = resolve; }));
    // Keyed by product, as ProductDetail renders it.
    const { rerender } = render(<ProductMarginFloorCard key="p1" productId="p1" tierMargins={[0.2, 0.2, 0.2]} userId="u1" />);
    fireEvent.change(await screen.findByLabelText('Floor (net margin %)'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /save floor/i }));
    await waitFor(() => expect(mocks.setMarginFloors).toHaveBeenCalledTimes(1));

    mocks.fetchMarginFloor.mockImplementation(async (productId: string) => (productId === 'p1' ? 0.2 : null));
    mocks.fetchMarginFloorHistory.mockResolvedValue([]);
    rerender(<ProductMarginFloorCard key="p2" productId="p2" tierMargins={[0.2, 0.2, 0.2]} userId="u1" />);
    expect(await screen.findByLabelText('Floor (net margin %)')).toHaveValue('');

    finishSave({ success: true, status: 'saved', changed_count: 1, unchanged_count: 0 });
    await waitFor(() => expect(screen.getByRole('button', { name: /save floor/i })).toBeDisabled());
    expect(screen.getByLabelText('Floor (net margin %)')).toHaveValue('');
    expect(mocks.fetchMarginFloor.mock.calls.filter(([productId]) => productId === 'p1')).toHaveLength(1);
    expect(mocks.toast).not.toHaveBeenCalledWith('success', expect.anything());
  });

  it('a save that fails after moving to another product shows no error there, and the new card is not busy', async () => {
    let failSave: (reason: unknown) => void = () => {};
    mocks.setMarginFloors.mockReturnValue(new Promise((_resolve, reject) => { failSave = reject; }));
    const { rerender } = render(<ProductMarginFloorCard key="p1" productId="p1" tierMargins={[0.2, 0.2, 0.2]} userId="u1" />);
    fireEvent.change(await screen.findByLabelText('Floor (net margin %)'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /save floor/i }));
    await waitFor(() => expect(mocks.setMarginFloors).toHaveBeenCalledTimes(1));

    mocks.fetchMarginFloor.mockResolvedValue(null);
    mocks.fetchMarginFloorHistory.mockResolvedValue([]);
    rerender(<ProductMarginFloorCard key="p2" productId="p2" tierMargins={[0.2, 0.2, 0.2]} userId="u1" />);
    const input = await screen.findByLabelText('Floor (net margin %)');
    expect(input).toHaveValue('');
    fireEvent.change(input, { target: { value: '12' } });
    expect(screen.getByRole('button', { name: /save floor/i })).not.toBeDisabled();

    failSave(new Error('network down'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('locks the floor and reason while a save runs, so nothing typed meanwhile is lost', async () => {
    let finishSave: (value: unknown) => void = () => {};
    mocks.setMarginFloors.mockReturnValue(new Promise((resolve) => { finishSave = resolve; }));
    render(<ProductMarginFloorCard productId="p1" tierMargins={[0.2, 0.2, 0.2]} userId="u1" />);
    fireEvent.change(await screen.findByLabelText('Floor (net margin %)'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /save floor/i }));
    await waitFor(() => expect(screen.getByLabelText('Floor (net margin %)')).toBeDisabled());
    expect(screen.getByLabelText('Reason (optional)')).toBeDisabled();
    mocks.fetchMarginFloor.mockResolvedValue(0.2);
    finishSave({ success: true, status: 'saved', changed_count: 1, unchanged_count: 0 });
    await waitFor(() => expect(screen.getByLabelText('Floor (net margin %)')).not.toBeDisabled());
    expect(screen.getByLabelText('Floor (net margin %)')).toHaveValue('20');
    expect(screen.getByLabelText('Reason (optional)')).not.toBeDisabled();
  });

  it('says so when the floor cannot be loaded, and offers a retry', async () => {
    mocks.fetchMarginFloor.mockRejectedValueOnce(new Error('offline'));
    render(<ProductMarginFloorCard productId="p1" tierMargins={[0.2, 0.2, 0.2]} userId="u1" />);
    expect(await screen.findByText('The margin floor could not be loaded.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByLabelText('Floor (net margin %)')).toHaveValue('15');
  });
});
