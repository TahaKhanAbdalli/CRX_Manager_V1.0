import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ release: null as null | ((result: unknown) => void) }));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'user-1' } }) }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

vi.mock('../../lib/db', () => {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order']) builder[m] = () => builder;
  // The catalog read waits until the test releases it.
  builder.range = () => new Promise((resolve) => { mocks.release = resolve; });
  return { supabase: { from: () => builder, rpc: vi.fn() }, assertRpcResult: vi.fn((value) => value) };
});

import QuickReceivePanel from './QuickReceivePanel';

describe('QuickReceivePanel catalog load (CodeRabbit, #1017)', () => {
  it('offers no product until the catalog loads, and a failed load leaves adding blocked with an alert', async () => {
    render(<MemoryRouter><QuickReceivePanel /></MemoryRouter>);

    const loading = screen.getAllByRole('button', { name: 'Loading products...' });
    expect(loading).toHaveLength(2);
    loading.forEach((button) => expect(button).toBeDisabled());

    await act(async () => { mocks.release?.({ data: null, error: { message: 'catalog down' }, count: null }); });

    expect(await screen.findByRole('alert')).toHaveTextContent('Products could not be loaded');
    expect(screen.getByRole('button', { name: 'Add Product' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add First Product' })).toBeDisabled();
  });
});
