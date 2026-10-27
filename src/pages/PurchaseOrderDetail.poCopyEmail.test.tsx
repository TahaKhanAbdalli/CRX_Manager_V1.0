import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PurchaseOrderDetail from './PurchaseOrderDetail';

// To-Do 0.15: an admin downloads a purchase order PDF, or emails a copy of it to the
// company ordering address (never the vendor) for placing the order on the vendor's portal.

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  toast: vi.fn(),
  resetKey: vi.fn(),
  role: 'admin',
  sendEmail: vi.fn(),
  downloadPurchaseOrderPdf: vi.fn(),
  generatePurchaseOrderPdf: vi.fn(),
  logActivity: vi.fn(),
}));

const basePo = {
  id: 'po-1',
  po_number: 'PO-2026-0040',
  vendor: 'Spinner Ag',
  status: 'submitted',
  submitted_date: '2026-10-20',
  expected_delivery_date: null,
  notes: null,
  created_at: '2026-10-20T00:00:00Z',
  updated_at: '2026-10-20T00:00:00Z',
};
const baseItems = [
  {
    id: 'line-1',
    purchase_order_id: 'po-1',
    product_id: 'product-1',
    product: { id: 'product-1', product_name: 'Atrazine 4L', epa_registration: '100-497' },
    quantity_ordered: 3,
    quantity_received: 0,
    unit_cost: 19.99,
    unit_size: 'gal',
    notes: null,
    cost_needs_review: false,
  },
];
let po: typeof basePo = basePo;
let vendors: Array<{ id: string; name: string; email: string | null }> = [];

function query(data: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'in', 'ilike', 'limit', 'range', 'is']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(() => Promise.resolve({ data, error: null }));
  builder.then = (resolve: (value: unknown) => void) =>
    Promise.resolve({ data, error: null }).then(resolve);
  return builder;
}

vi.mock('../lib/db', async () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc },
  sanitizeError: (await vi.importActual<typeof import('../lib/errorSanitizer')>(
    '../lib/errorSanitizer',
  )).sanitizeError,
  assertRpcResult: (value: unknown) => value,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ role: mocks.role, profile: { id: 'admin-1', full_name: 'Admin' } }),
}));

vi.mock('../components/ui/Toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock('../hooks/useIdempotencyKey', () => ({
  useIdempotencyKey: (operation: string) => ({
    getKey: () => `idem:${operation}`,
    resetKey: () => mocks.resetKey(operation),
    getKeyFor: (scope: string) => `idem:${operation}:${scope}`,
    resetKeyFor: (scope: string) => mocks.resetKey(`${operation}:${scope}`),
  }),
}));

vi.mock('../lib/emailService', async () => ({
  ...(await vi.importActual<typeof import('../lib/emailService')>('../lib/emailService')),
  sendEmail: mocks.sendEmail,
  pdfToBase64: () => 'UERG',
}));

vi.mock('../lib/purchaseOrderPdf', async () => ({
  ...(await vi.importActual<typeof import('../lib/purchaseOrderPdf')>('../lib/purchaseOrderPdf')),
  downloadPurchaseOrderPdf: mocks.downloadPurchaseOrderPdf,
  generatePurchaseOrderPdf: mocks.generatePurchaseOrderPdf,
}));

vi.mock('../lib/activityLogger', () => ({ logActivity: mocks.logActivity }));
vi.mock('../lib/notificationTriggers', () => ({
  notifyDamagedReceiving: vi.fn(),
  notifyOverReceive: vi.fn(),
}));

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/purchase-orders/po-1']}>
      <Routes>
        <Route path="/purchase-orders/:id" element={<PurchaseOrderDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PurchaseOrderDetail purchase order PDF and emailed copy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = 'admin';
    po = basePo;
    vendors = [{ id: 'v-1', name: 'spinner ag', email: null }];
    mocks.from.mockImplementation((table: string) => {
      if (table === 'purchase_orders') return query(po);
      if (table === 'purchase_order_items') return query(baseItems);
      if (table === 'vendors') return query(vendors);
      return query([]);
    });
    // Admin cost read: no extra fields, so the lines keep the costs above.
    mocks.rpc.mockResolvedValue({ data: {}, error: null });
    mocks.generatePurchaseOrderPdf.mockResolvedValue({});
    mocks.sendEmail.mockResolvedValue({ success: true, email_log_id: 'log-1' });
  });

  it('downloads the PDF with the vendor record filling the vendor block', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /download pdf/i }));
    await waitFor(() => expect(mocks.downloadPurchaseOrderPdf).toHaveBeenCalledTimes(1));
    expect(mocks.downloadPurchaseOrderPdf.mock.calls[0][0]).toMatchObject({
      po_number: 'PO-2026-0040',
      vendor: { name: 'spinner ag', email: null },
      lines: [{ product_name: 'Atrazine 4L', epa_registration: '100-497', quantity_ordered: 3, unit_cost: 19.99 }],
    });
  });

  it('confirms, then emails the copy to the company ordering address even though the vendor has no email', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /email po copy/i }));
    expect(await screen.findByText(/to mason@croprxsolutions\.com.*Nothing is sent to the vendor/)).toBeInTheDocument();
    expect(mocks.sendEmail).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /send email/i }));
    await waitFor(() => expect(mocks.sendEmail).toHaveBeenCalledTimes(1));
    const payload = mocks.sendEmail.mock.calls[0][0];
    expect(payload).toMatchObject({
      to: 'mason@croprxsolutions.com',
      email_type: 'purchase_order',
      resource_type: 'purchase_order',
      resource_id: 'po-1',
      idempotency_key: 'idem:email_purchase_order',
      attachments: [{ filename: 'Purchase-Order-PO-2026-0040.pdf', content: 'UERG' }],
      purchase_order_snapshot: {
        vendor: 'Spinner Ag',
        expected_delivery_date: null,
        notes: null,
        lines: [{
          id: 'line-1',
          product_id: 'product-1',
          product_name: 'Atrazine 4L',
          epa_registration: '100-497',
          unit_size: 'gal',
          notes: null,
          quantity_ordered: 3,
          unit_cost: 19.99,
        }],
      },
    });
    expect(payload.customer_id).toBeUndefined();
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('success', 'Purchase order copy emailed to mason@croprxsolutions.com'));
    expect(mocks.resetKey).toHaveBeenCalledWith('email_purchase_order');
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.objectContaining({ event: 'purchase_order_emailed', entityId: 'po-1' }));
  });

  it('keeps the idempotency key when the send fails, so a retry replays it', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('The purchase order changed after its PDF was built. Reload it and send again'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /email po copy/i }));
    fireEvent.click(await screen.findByRole('button', { name: /send email/i }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('changed after its PDF was built'),
    ));
    expect(mocks.resetKey).not.toHaveBeenCalledWith('email_purchase_order');
  });

  it('refuses an unconfirmed cost before anything is built or sent', async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'purchase_orders') return query(po);
      if (table === 'purchase_order_items') return query([{ ...baseItems[0], cost_needs_review: true }]);
      if (table === 'vendors') return query(vendors);
      return query([]);
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /email po copy/i }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('warning', expect.stringMatching(/Confirm the unit cost/)));
    expect(screen.queryByRole('button', { name: /send email/i })).not.toBeInTheDocument();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('refuses to email when the lines changed since the page loaded', async () => {
    let reads = 0;
    mocks.from.mockImplementation((table: string) => {
      if (table === 'purchase_orders') return query(po);
      if (table === 'purchase_order_items') {
        reads += 1;
        return query(reads === 1 ? baseItems : [{ ...baseItems[0], unit_cost: 21.5 }]);
      }
      if (table === 'vendors') return query(vendors);
      return query([]);
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /email po copy/i }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('warning', expect.stringMatching(/changed since the page loaded/)));
    expect(screen.queryByRole('button', { name: /send email/i })).not.toBeInTheDocument();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('offers only the PDF on a draft, and neither button to a sales rep', async () => {
    po = { ...basePo, status: 'draft' };
    const { unmount } = render(
      <MemoryRouter initialEntries={['/purchase-orders/po-1']}>
        <Routes>
          <Route path="/purchase-orders/:id" element={<PurchaseOrderDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('button', { name: /download pdf/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /email po copy/i })).not.toBeInTheDocument();
    unmount();

    mocks.role = 'sales_rep';
    po = basePo;
    renderPage();
    expect(await screen.findByRole('button', { name: /receive items/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download pdf/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /email po copy/i })).not.toBeInTheDocument();
  });
});
