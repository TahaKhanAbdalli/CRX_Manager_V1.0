import { useState } from 'react';
import { useLocation, useNavigationType, useParams } from 'react-router-dom';
import FieldApplicationInvoice from '../pages/FieldApplicationInvoice';

// Discard every field and confirmation when the invoice identity changes,
// including an existing invoice -> new invoice. Keep the page's async load
// ownership checks: a discarded request must not navigate or install state.
//
// On /invoices/field-app/new, the page's own address rewrites are REPLACE moves (the first
// Save writing ?created=<id>, dropping a rejected id) and keep the page, typed values and all.
// Every other arrival — the New buttons (PUSH) or Back/Forward (POP) — gets a fresh page, even
// from /new to /new, so a Save still running on the old page can never steer the new one and a
// Save on the new one can never update the invoice the old page created.
export default function FieldApplicationInvoiceRoute() {
  const { id } = useParams();
  const location = useLocation();
  const navigationType = useNavigationType();
  const [pageKey, setPageKey] = useState(location.key);
  if (navigationType !== 'REPLACE' && location.key !== pageKey) setPageKey(location.key);
  return <FieldApplicationInvoice key={id ?? `new-field-app-invoice-${pageKey}`} />;
}
