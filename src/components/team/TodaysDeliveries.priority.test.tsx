import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * Renders the real Team Board delivery list with one delivery of each priority the database allows
 * (deliveries_priority_check: low, normal, high, urgent). The border-colour map used to key on
 * 'medium', which deliveries cannot have, so every 'normal' delivery was drawn grey like 'low'.
 */

const { mockRpc } = vi.hoisted(() => ({ mockRpc: vi.fn() }));

vi.mock('../../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../../lib/db')>('../../lib/db');
  return { ...actual, supabase: { rpc: mockRpc } };
});
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), Link: ({ children }: { children: unknown }) => children }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import TodaysDeliveries from './TodaysDeliveries';

const delivery = (priority: string) => ({
  id: `d-${priority}`,
  delivery_number: `PRV-${priority.toUpperCase()}`,
  status: 'scheduled',
  priority,
  scheduled_date: '2026-10-23',
  scheduled_time: null,
  delivery_address: null,
  delivery_notes: null,
  customer_name: 'Prover Farm',
  driver_name: 'Driver',
  assigned_driver: 'u-1',
  item_count: 1,
});

describe('TodaysDeliveries priority colours', () => {
  it('draws each allowed delivery priority in its own colour, normal included', async () => {
    mockRpc.mockResolvedValue({
      data: {
        today: ['urgent', 'high', 'normal', 'low'].map(delivery),
        tomorrow: [],
        unassigned_count: 0,
        today_total: 4,
      },
      error: null,
    });
    render(<TodaysDeliveries />);

    const card = async (priority: string) =>
      (await screen.findByText(`PRV-${priority.toUpperCase()}`)).closest('button') as HTMLButtonElement;
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('get_team_board_deliveries'));
    expect((await card('urgent')).className).toContain('border-l-red-500');
    expect((await card('high')).className).toContain('border-l-amber-500');
    expect((await card('normal')).className).toContain('border-l-blue-500');
    expect((await card('low')).className).toContain('border-l-gray-300');
  });
});
