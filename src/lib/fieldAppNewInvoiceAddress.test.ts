import { describe, expect, it } from 'vitest';
import { createdInvoiceAddressSearch, createdInvoiceIdFromAddress } from './fieldAppNewInvoiceAddress';

describe('the created invoice id in a new invoice address', () => {
  it('round-trips through the address', () => {
    const id = '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f';
    expect(createdInvoiceIdFromAddress(new URLSearchParams(createdInvoiceAddressSearch(id)))).toBe(id);
  });

  it('a missing or malformed id is no id', () => {
    expect(createdInvoiceIdFromAddress(new URLSearchParams(''))).toBeNull();
    expect(createdInvoiceIdFromAddress(new URLSearchParams('created=not-an-id'))).toBeNull();
  });
});
