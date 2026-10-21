import type { InvoiceChargeType, InvoiceType } from '../types';

/**
 * Charge lines on invoices made from scratch (Goal 3; Mason, 2026-10-14 decision 6e and
 * 2026-10-15). An invoice with no order and no delivery behind it carries no product lines,
 * only typed charge lines: a type, a description and a dollar amount, with no product, cost or
 * tax. PostgreSQL enforces the same rule (migration 20261021050000); this module only keeps the
 * screen in step with it.
 */
export const CHARGE_TYPE_OPTIONS: ReadonlyArray<{ value: InvoiceChargeType; label: string }> = [
  { value: 'freight', label: 'Freight' },
  { value: 'application_fee', label: 'Application fee' },
  { value: 'service', label: 'Service' },
  { value: 'other', label: 'Other' },
];

export function chargeTypeLabel(type: InvoiceChargeType | null | undefined): string {
  return CHARGE_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? '';
}

/** A misc_charge or chemical_sale invoice with no order and no delivery behind it. */
export function isFromScratchInvoice(invoice: {
  invoice_type?: InvoiceType | null;
  order_id?: string | null;
  delivery_id?: string | null;
}): boolean {
  return (invoice.invoice_type === 'misc_charge' || invoice.invoice_type === 'chemical_sale')
    && !invoice.order_id
    && !invoice.delivery_id;
}

interface ChargeLineCheck {
  product_id: string | null;
  charge_type?: InvoiceChargeType | null;
  description: string;
  quantity: number;
  unit_price_cents: number;
}

/**
 * Why a from-scratch invoice's lines cannot be saved yet, or null when they can. Mirrors the
 * database refusals so staff see a plain message instead of a server error.
 */
export function fromScratchLinesProblem(lines: ChargeLineCheck[]): string | null {
  if (lines.some((line) => line.product_id)) {
    return 'An invoice with no order or delivery cannot carry products. Remove the product lines; sell product through an order or a quick delivery.';
  }
  if (lines.some((line) => !line.charge_type)) {
    return 'Pick a charge type for every line.';
  }
  if (lines.some((line) => !line.description.trim())) {
    return 'Add a description to every charge.';
  }
  if (lines.some((line) => !(line.unit_price_cents > 0))) {
    return 'Every charge needs an amount above $0.00.';
  }
  if (lines.some((line) => line.quantity !== 1)) {
    return 'A charge is one amount: set its type again to reset it to a single charge.';
  }
  return null;
}
