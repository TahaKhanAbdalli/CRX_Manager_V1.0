/**
 * DeliveryDetail.completion.test.tsx — Goal 5 completion paths on the REAL DeliveryDetail page
 * (migration 20261022075000). The server contract these tests lean on: an exact retry with the same
 * key and identical args replays the saved result before any status or evidence check.
 *
 * Covered here:
 *   - "Record without proof" is offered to an admin only (hidden for a sales rep and for a driver);
 *   - a no-proof completion sends no customer receipt email;
 *   - a failed signature upload still sends the completion, under the key whose path was uploaded;
 *   - SIGNATURE_IMAGE_MISSING retires the key, so the next tap is a fresh attempt;
 *   - a lost reply on a delivery that turns out completed is resent IDENTICALLY (same key, same
 *     args) and then runs the normal success path (receipt email included).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const SIGNATURE_DATA_URL = `data:image/png;base64,iVBORw0KGgo${'A'.repeat(669)}`;

const { auth, mockFrom, mockRpc, mockToast, mockSendEmail, mockUpload, route, tables } = vi.hoisted(() => ({
  auth: { role: 'admin', profile: { id: 'user-1', role: 'admin' }, deniedPages: [] as string[] },
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockToast: vi.fn(),
  mockSendEmail: vi.fn(),
  mockUpload: vi.fn(),
  route: { id: 'del-1' },
  tables: { data: {} as Record<string, unknown[]> },
}));

function buildChain(table: string): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  const method = (..._args: unknown[]) => self;
  for (const m of [
    'select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte',
    'lt', 'lte', 'like', 'ilike', 'is', 'in', 'not', 'or', 'and', 'match',
    'order', 'limit', 'offset', 'returns', 'abortSignal', 'range',
  ]) self[m] = method;
  // Read the table when the query resolves, so a test can change it between calls.
  const rows = () => tables.data[table] ?? [];
  self.single = () => Promise.resolve({ data: rows()[0] ?? null, error: null });
  self.maybeSingle = () => Promise.resolve({ data: rows()[0] ?? null, error: null });
  self.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
    Promise.resolve({ data: rows(), error: null, count: rows().length }).then(ok, bad);
  return self;
}

vi.mock('../lib/db', () => ({
  supabase: {
    from: mockFrom,
    rpc: mockRpc,
    storage: {
      from: () => ({
        createSignedUrl: () => Promise.resolve({ data: null, error: null }),
        upload: mockUpload,
        getPublicUrl: () => ({ data: { publicUrl: '' } }),
      }),
    },
  },
  supabaseUntyped: { from: mockFrom },
  sanitizeError: (e: unknown) => (e as Error)?.message || 'Error',
  checkMutationResult: vi.fn(),
  assertRpcResult: (d: unknown, op: string) => {
    if (d === null || d === undefined) throw new Error(`${op} returned no result`);
    return d;
  },
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ logActivity: vi.fn() }));
vi.mock('../lib/notificationTriggers', () => ({
  notifyDeliveryRemainder: vi.fn(), notifyDeliveryCompleted: vi.fn(),
}));
vi.mock('../lib/connectivity', () => ({ hasSignal: () => Promise.resolve(true), NO_SIGNAL_MESSAGE: 'no signal' }));
vi.mock('../lib/deliveryPdf', () => ({ downloadDeliveryPdf: vi.fn() }));
vi.mock('../lib/emailService', () => ({ sendEmail: mockSendEmail, buildEmailHtml: () => '<p></p>' }));
vi.mock('../lib/rupCompliance', () => ({ checkRUPCompliance: () => Promise.resolve({ compliant: true, warnings: [] }) }));
vi.mock('../lib/deliverySplitBilling', () => ({
  fetchSplitBillingOrderIds: () => Promise.resolve({ data: new Set(), error: null }), SPLIT_BILLING_BLOCK_REASON: '',
}));
vi.mock('../lib/imageCompression', () => ({ compressImage: vi.fn() }));
vi.mock('../components/deliveries/StartDeliveryModal', () => ({ default: () => null }));
vi.mock('../components/team/QuickTaskModal', () => ({ default: () => null }));
vi.mock('../components/team/RelatedNotes', () => ({ default: () => null }));
vi.mock('../components/ui/SignatureCanvas', () => ({
  default: ({ onSignatureChange }: { onSignatureChange: (value: string | null) => void }) => (
    <button type="button" onClick={() => onSignatureChange(SIGNATURE_DATA_URL)}>Sign here</button>
  ),
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: route.id }), useNavigate: () => vi.fn() };
});

import DeliveryDetail from './DeliveryDetail';
import { signatureImagePathFor } from '../lib/deliveryEvidence';

const OPEN_DELIVERY = {
  id: 'del-1',
  delivery_number: 'DEL-1',
  status: 'in_progress',
  scheduled_date: '2026-10-21',
  delivery_date: '2026-10-21',
  customer_id: 'cust-1',
  order_id: null,
  assigned_driver: 'user-1',
  created_by: 'user-1',
  signature_url: null,
  signed_by: null,
};

const COMPLETE_RESULT = { success: true, delivery_id: 'del-1' };

function setRole(role: 'admin' | 'sales_rep' | 'driver') {
  auth.role = role;
  auth.profile = { id: 'user-1', role };
}

beforeEach(() => {
  vi.clearAllMocks();
  route.id = 'del-1';
  setRole('admin');
  mockUpload.mockResolvedValue({ data: { path: 'x' }, error: null });
  mockSendEmail.mockResolvedValue({ success: true });
  tables.data = {
    deliveries: [{ ...OPEN_DELIVERY }],
    delivery_items: [{ id: 'item-1', delivery_id: 'del-1', product_id: 'prod-1', quantity: 2, product: { product_name: 'Test Chem' } }],
    delivery_photos: [],
    delivery_remainders: [],
    customers: [{ id: 'cust-1', farm_name: 'Test Farm', email: 'farmer@example.test', contact_name: 'Pat' }],
    profile_public_view: [],
    inventory: [],
  };
  mockFrom.mockImplementation((table: string) => buildChain(table));
});

async function renderPage() {
  render(<MemoryRouter><DeliveryDetail /></MemoryRouter>);
  await screen.findByText('DEL-1', undefined, { timeout: 3000 }).catch(() => undefined);
}

function completeRpcCalls() {
  return mockRpc.mock.calls.filter(([name]) => name === 'complete_delivery');
}

/** Clicks the page's Complete button, then the confirm box's Complete button. */
async function completeAndConfirm() {
  const [pageButton] = await screen.findAllByRole('button', { name: /^Complete Delivery$/ });
  fireEvent.click(pageButton);
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^Complete Delivery$/ }).length).toBeGreaterThan(1));
  const buttons = screen.getAllByRole('button', { name: /^Complete Delivery$/ });
  fireEvent.click(buttons[buttons.length - 1]);
}

async function signAndFillSigner() {
  fireEvent.click(await screen.findByRole('button', { name: 'Sign here' }));
  fireEvent.change(screen.getByLabelText(/Signed By/i), { target: { value: 'Pat Farmer' } });
}

describe('Record without proof is admin-only on screen', () => {
  it('shows the option to an admin', async () => {
    await renderPage();
    expect(await screen.findByLabelText(/Record without proof/i)).toBeInTheDocument();
  });

  it('hides the option from a sales rep', async () => {
    setRole('sales_rep');
    await renderPage();
    await screen.findByRole('button', { name: /^Complete Delivery$/ });
    expect(screen.queryByLabelText(/Record without proof/i)).not.toBeInTheDocument();
  });

  it('hides the option from the assigned driver', async () => {
    setRole('driver');
    await renderPage();
    await screen.findByText(/DEL-1/);
    await waitFor(() => expect(mockFrom).toHaveBeenCalledWith('delivery_items'));
    expect(screen.queryByText(/Record without proof/i)).not.toBeInTheDocument();
  });
});

describe('completion paths', () => {
  it('sends no customer receipt email after a no-proof completion, and sends its date', async () => {
    mockRpc.mockResolvedValue({ data: COMPLETE_RESULT, error: null });
    await renderPage();
    fireEvent.click(await screen.findByLabelText(/Record without proof/i));
    fireEvent.change(screen.getByLabelText(/Why is there no proof/i), { target: { value: 'Customer confirmed by phone that all arrived' } });
    expect(screen.getByLabelText(/^Delivered on$/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Delivered on$/), { target: { value: '2026-10-01' } });
    await completeAndConfirm();

    await waitFor(() => expect(completeRpcCalls()).toHaveLength(1));
    const params = completeRpcCalls()[0][1];
    expect(params.p_evidence).toBe('no_proof');
    expect(params.p_completed_at).toBe('2026-10-01T17:00:00.000Z');
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', expect.stringMatching(/Delivery completed/)));
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('still sends the completion after a failed signature upload, under the key whose path it tried', async () => {
    mockUpload.mockResolvedValue({ data: null, error: { message: 'Failed to fetch' } });
    mockRpc.mockResolvedValue({ data: COMPLETE_RESULT, error: null });
    await renderPage();
    await signAndFillSigner();
    await completeAndConfirm();

    await waitFor(() => expect(completeRpcCalls()).toHaveLength(1));
    const params = completeRpcCalls()[0][1];
    const expectedPath = await signatureImagePathFor('del-1', params.p_idempotency_key);
    expect(mockUpload).toHaveBeenCalledWith(expectedPath, expect.anything(), expect.anything());
    expect(params.p_evidence).toBe('signature');
    expect(params.p_evidence_ref).toBe(expectedPath);
  });

  it('mints a new key on the next tap after SIGNATURE_IMAGE_MISSING', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'SIGNATURE_IMAGE_MISSING: no signature image saved for this attempt' } });
    await renderPage();
    await signAndFillSigner();
    await completeAndConfirm();
    await waitFor(() => expect(completeRpcCalls()).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Complete Delivery$/ })[0]).not.toBeDisabled());

    mockRpc.mockResolvedValueOnce({ data: COMPLETE_RESULT, error: null });
    await completeAndConfirm();
    await waitFor(() => expect(completeRpcCalls()).toHaveLength(2));
    const [first, second] = completeRpcCalls().map(([, params]) => params);
    expect(second.p_idempotency_key).not.toBe(first.p_idempotency_key);
    expect(second.p_evidence_ref).toBe(await signatureImagePathFor('del-1', second.p_idempotency_key));
  });

  it('replays a lost reply identically when the delivery turns out completed, then runs the success path', async () => {
    mockRpc
      .mockImplementationOnce(() => {
        // The server committed, but the reply never arrived.
        tables.data.deliveries = [{ ...OPEN_DELIVERY, status: 'completed' }];
        return Promise.resolve({ data: null, error: { code: '', message: 'TypeError: Failed to fetch' } });
      })
      .mockResolvedValueOnce({ data: COMPLETE_RESULT, error: null });
    await renderPage();
    await signAndFillSigner();
    await completeAndConfirm();

    await waitFor(() => expect(completeRpcCalls()).toHaveLength(2));
    const [first, replay] = completeRpcCalls().map(([, params]) => params);
    expect(replay).toEqual(first);
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', expect.stringMatching(/Delivery completed/)));
    await waitFor(() => expect(mockSendEmail).toHaveBeenCalledTimes(1));
    expect(mockToast).not.toHaveBeenCalledWith('error', expect.anything());
  });

  it('says the delivery is completed and no receipt was sent when the identical replay also fails', async () => {
    mockRpc
      .mockImplementationOnce(() => {
        tables.data.deliveries = [{ ...OPEN_DELIVERY, status: 'completed' }];
        return Promise.resolve({ data: null, error: { code: '', message: 'TypeError: Failed to fetch' } });
      })
      .mockResolvedValueOnce({ data: null, error: { code: '', message: 'TypeError: Failed to fetch' } });
    await renderPage();
    await signAndFillSigner();
    await completeAndConfirm();

    await waitFor(() => expect(completeRpcCalls()).toHaveLength(2));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('error', expect.stringMatching(/an earlier attempt went through\). No receipt was emailed from here; use Email Confirmation/)));
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});
