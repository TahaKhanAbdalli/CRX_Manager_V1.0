import { rpcCodeDetail, RpcErrorCodes } from './db';

/**
 * Goal 3 "Pricing" (migration 20261020210000). create_invoice_from_blend_ticket stops with
 * BLEND_TICKET_QUOTE_PRICE_CHOICE_REQUIRED when the job's quote lists a product more than once at
 * different prices, and hands the choices over as JSON in the error's `details`. Staff pick one per
 * ticket line through set_blend_ticket_product_quote_price, then bill again.
 */
export interface BlendQuotePriceOption {
  quoteItemId: string;
  /** Whole cents, exactly as the database will bill it. */
  priceCents: number;
}

export interface BlendQuotePriceChoice {
  blendTicketProductId: string;
  productName: string;
  options: BlendQuotePriceOption[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The choices carried by a BLEND_TICKET_QUOTE_PRICE_CHOICE_REQUIRED refusal, or `null` when the
 * error is anything else or its details are not the shape the database writes (the caller then
 * shows the error as usual). PostgREST errors are plain objects, so do not use instanceof Error.
 */
export function getBlendQuotePriceChoices(error: unknown): BlendQuotePriceChoice[] | null {
  if (rpcCodeDetail(error, RpcErrorCodes.BLEND_TICKET_QUOTE_PRICE_CHOICE_REQUIRED) === null) return null;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(details);
  } catch {
    return null;
  }
  const products = (parsed as { products?: unknown } | null)?.products;
  if (!Array.isArray(products) || products.length === 0) return null;

  const choices: BlendQuotePriceChoice[] = [];
  for (const raw of products) {
    const row = raw as { blend_ticket_product_id?: unknown; product_name?: unknown; options?: unknown };
    if (typeof row.blend_ticket_product_id !== 'string' || !UUID.test(row.blend_ticket_product_id)) return null;
    if (!Array.isArray(row.options) || row.options.length < 2) return null;
    const options: BlendQuotePriceOption[] = [];
    for (const rawOption of row.options) {
      const option = rawOption as { quote_item_id?: unknown; price_cents?: unknown };
      if (typeof option.quote_item_id !== 'string' || !UUID.test(option.quote_item_id)) return null;
      if (typeof option.price_cents !== 'number' || !Number.isSafeInteger(option.price_cents) || option.price_cents < 0) return null;
      options.push({ quoteItemId: option.quote_item_id, priceCents: option.price_cents });
    }
    choices.push({
      blendTicketProductId: row.blend_ticket_product_id,
      productName: typeof row.product_name === 'string' && row.product_name.trim() ? row.product_name : 'Unnamed product',
      options,
    });
  }
  return choices;
}

/**
 * Plain-English reason set_blend_ticket_product_quote_price refused a pick, or `null` for an error
 * this helper does not know (the caller then shows it as usual).
 */
export function blendQuotePriceSaveErrorMessage(error: unknown): string | null {
  if (rpcCodeDetail(error, RpcErrorCodes.BLEND_TICKET_QUOTE_PRICE_LOCKED) !== null) {
    return 'This ticket has already been billed or linked to an order, so its prices can no longer be picked.';
  }
  if (rpcCodeDetail(error, RpcErrorCodes.BLEND_TICKET_QUOTE_PRICE_INVALID_CHOICE) !== null) {
    return 'That price is no longer on this ticket\'s quote for this product. Reload the ticket and try again.';
  }
  if (rpcCodeDetail(error, RpcErrorCodes.BLEND_TICKET_PRODUCT_NOT_FOUND) !== null) {
    return 'That ticket line no longer exists. Reload the ticket and try again.';
  }
  if (rpcCodeDetail(error, RpcErrorCodes.SALESMAN_SCOPE_DENIED) !== null) {
    return 'This ticket belongs to another sales rep, so only they or an admin can pick its prices.';
  }
  if (rpcCodeDetail(error, RpcErrorCodes.INSUFFICIENT_ROLE) !== null) {
    return 'Only an admin or a sales rep can pick a ticket\'s prices.';
  }
  if (rpcCodeDetail(error, RpcErrorCodes.AUTH_REQUIRED) !== null
      || rpcCodeDetail(error, RpcErrorCodes.ACTOR_MISMATCH) !== null) {
    return 'Your sign-in could not be confirmed. Sign in again, then pick the price again.';
  }
  if (rpcCodeDetail(error, RpcErrorCodes.BLEND_TICKET_PRODUCT_NOT_UPDATED) !== null) {
    return 'The price was not saved. Reload the ticket and try again.';
  }
  return null;
}

/**
 * Plain-English reason create_invoice_from_blend_ticket refused for a reason added after Goal 3
 * pricing (migration 20261021070000), or `null` for any other error. `productNameById` names the
 * product a COST_BASIS_REQUIRED refusal points at (the database sends only its id).
 */
export function blendTicketInvoiceRefusalMessage(
  error: unknown,
  productNameById: ReadonlyMap<string, string> = new Map(),
): string | null {
  if (rpcCodeDetail(error, RpcErrorCodes.BELOW_COST_APPROVAL_STALE) !== null) {
    return 'The $0 lines on this ticket changed while the approval was open, so nothing was invoiced. Create the invoice again to see and approve the current lines.';
  }
  if (rpcCodeDetail(error, RpcErrorCodes.BLEND_TICKET_PRODUCT_UNMATCHED) !== null) {
    return 'A line on this ticket is not matched to a product, so nothing was invoiced. Match every line to a product, then try again.';
  }
  const costProductId = rpcCodeDetail(error, RpcErrorCodes.COST_BASIS_REQUIRED);
  if (costProductId !== null) {
    const name = productNameById.get(costProductId);
    return name
      ? `${name} has no cost entered, so nothing was invoiced. Enter its cost on the Price List, then try again.`
      : 'A product on this ticket has no cost entered, so nothing was invoiced. Enter its cost on the Price List, then try again.';
  }
  const centsProductId = rpcCodeDetail(error, RpcErrorCodes.COST_BASIS_CENTS_REQUIRED);
  if (centsProductId !== null) {
    const name = productNameById.get(centsProductId);
    return `${name ?? 'A product on this ticket'} has a cost that is not a whole number of cents, so nothing was invoiced. Correct its cost on the Price List, then try again.`;
  }
  return null;
}

/**
 * Plain-English reason for a blend-ticket order or invoice refused because a product has no price
 * on the price list, or `null` for any other error.
 */
export function blendTicketMissingPriceMessage(error: unknown): string | null {
  const detail = rpcCodeDetail(error, RpcErrorCodes.BLEND_TICKET_PRICE_MISSING);
  if (detail === null) return null;
  const names = detail.replace(/^product\(s\) have no price on the price list:\s*/i, '').trim();
  return names
    ? `These products have no price on the Price List, so nothing was created: ${names}. Add a price for them, then try again.`
    : 'A product on this ticket has no price on the Price List, so nothing was created. Add a price for it, then try again.';
}
