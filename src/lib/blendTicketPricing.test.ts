import { describe, expect, it } from 'vitest';
import { blendQuotePriceSaveErrorMessage, blendTicketMissingPriceMessage, getBlendQuotePriceChoices } from './blendTicketPricing';

const LINE = '22222222-2222-4222-8222-222222222222';
const QI_A = '33333333-3333-4333-8333-333333333333';
const QI_B = '44444444-4444-4444-8444-444444444444';
const CODE = 'BLEND_TICKET_QUOTE_PRICE_CHOICE_REQUIRED: the quote lists a product more than once at different prices; pick the price to bill';

function choiceError(products: unknown) {
  return { message: CODE, details: JSON.stringify({ products }) };
}

describe('getBlendQuotePriceChoices', () => {
  it('reads the choices the database hands over', () => {
    expect(getBlendQuotePriceChoices(choiceError([{
      blend_ticket_product_id: LINE,
      product_id: 'p',
      product_name: 'Atrazine 4L',
      options: [{ quote_item_id: QI_A, price_cents: 700 }, { quote_item_id: QI_B, price_cents: 750 }],
    }]))).toEqual([{
      blendTicketProductId: LINE,
      productName: 'Atrazine 4L',
      options: [{ quoteItemId: QI_A, priceCents: 700 }, { quoteItemId: QI_B, priceCents: 750 }],
    }]);
  });

  it('ignores every other error, even one that mentions the token later', () => {
    expect(getBlendQuotePriceChoices({ message: 'JOB_ALREADY_INVOICED', details: '{}' })).toBeNull();
    expect(getBlendQuotePriceChoices({ message: `note: ${CODE}`, details: '{}' })).toBeNull();
    expect(getBlendQuotePriceChoices(null)).toBeNull();
  });

  it('refuses details that are not the exact shape, so the error is shown instead', () => {
    const good = { blend_ticket_product_id: LINE, product_name: 'X', options: [{ quote_item_id: QI_A, price_cents: 700 }, { quote_item_id: QI_B, price_cents: 750 }] };
    expect(getBlendQuotePriceChoices({ message: CODE })).toBeNull();
    expect(getBlendQuotePriceChoices({ message: CODE, details: 'not json' })).toBeNull();
    expect(getBlendQuotePriceChoices(choiceError([]))).toBeNull();
    expect(getBlendQuotePriceChoices(choiceError([{ ...good, blend_ticket_product_id: 'nope' }]))).toBeNull();
    expect(getBlendQuotePriceChoices(choiceError([{ ...good, options: [good.options[0]] }]))).toBeNull();
    expect(getBlendQuotePriceChoices(choiceError([{ ...good, options: [good.options[0], { quote_item_id: QI_B, price_cents: 7.5 }] }]))).toBeNull();
    expect(getBlendQuotePriceChoices(choiceError([{ ...good, options: [good.options[0], { quote_item_id: QI_B, price_cents: -1 }] }]))).toBeNull();
  });
});

describe('blendQuotePriceSaveErrorMessage', () => {
  it('turns every refusal the setter can raise into plain English', () => {
    const cases: Array<[string, RegExp]> = [
      ['BLEND_TICKET_QUOTE_PRICE_LOCKED: only an unbilled blend ticket', /already been billed or linked/],
      ['BLEND_TICKET_QUOTE_PRICE_INVALID_CHOICE: that price is not on this ticket\'s quote', /no longer on this ticket's quote/],
      ['BLEND_TICKET_PRODUCT_NOT_FOUND', /line no longer exists/],
      ['SALESMAN_SCOPE_DENIED', /belongs to another sales rep/],
      ['INSUFFICIENT_ROLE: admin or sales role required to pick a blend-ticket price', /Only an admin or a sales rep/],
      ['AUTH_REQUIRED', /sign-in could not be confirmed/],
      ['ACTOR_MISMATCH', /sign-in could not be confirmed/],
      ['BLEND_TICKET_PRODUCT_NOT_UPDATED', /price was not saved/],
    ];
    for (const [message, expected] of cases) {
      expect(blendQuotePriceSaveErrorMessage({ message })).toMatch(expected);
    }
  });

  it('leaves unknown errors to the normal handling', () => {
    expect(blendQuotePriceSaveErrorMessage({ message: 'IDEMPOTENCY_INTENT_MISMATCH' })).toBeNull();
    expect(blendQuotePriceSaveErrorMessage(null)).toBeNull();
  });
});

describe('blendTicketMissingPriceMessage', () => {
  it('names the unpriced products', () => {
    expect(blendTicketMissingPriceMessage({ message: 'BLEND_TICKET_PRICE_MISSING: product(s) have no price on the price list: A, B' }))
      .toBe('These products have no price on the Price List, so nothing was created: A, B. Add a price for them, then try again.');
  });

  it('falls back when the token arrives bare, and ignores other errors', () => {
    expect(blendTicketMissingPriceMessage({ message: 'BLEND_TICKET_PRICE_MISSING' })).toMatch(/has no price on the Price List/);
    expect(blendTicketMissingPriceMessage({ message: 'SOMETHING_ELSE' })).toBeNull();
  });
});
