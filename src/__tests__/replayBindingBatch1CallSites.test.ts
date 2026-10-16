/**
 * Replay-binding batch 1 (migration 20261016060000): the eight screens that call the nine wrapped
 * money RPCs retire a refused retry key ONLY when the refusal proves nothing committed under it
 * ('intent' = the key belongs to a different request, 'actor' = to another user). A 'receipt'
 * refusal (IDEMPOTENCY_RESULT_INVALID / IDEMPOTENCY_RECEIPT_MISSING) must keep the key: an earlier
 * attempt may have committed, and the key is the only way to replay it instead of repeating the
 * money action.
 *
 * The repo-wide reset-order guard only sees that a reset sits near getIdempotencyBindingRejection;
 * it cannot tell `if (getIdempotencyBindingRejection(error)) resetKey()` (wrong: also retires on
 * 'receipt') from the intent/actor form. This test pins the form at every batch-1 call site.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// File -> number of batch-1 call sites in it.
const SITES: Record<string, number> = {
  'src/pages/PaymentHistory.tsx': 1,
  'src/components/prepay/PrepaymentManagerPanel.tsx': 3,
  'src/components/invoices/WriteOffModal.tsx': 1,
  'src/pages/InvoiceDetail.tsx': 1,
  'src/components/prepay/PrepayWorkspacePanel.tsx': 1,
  'src/pages/Invoices.tsx': 1,
};

const INTENT_OR_ACTOR_RESET =
  /const bindingRejection = getIdempotencyBindingRejection\(error\);\s*\n\s*if \(bindingRejection === 'intent' \|\| bindingRejection === 'actor'\) \S*reset\S*\(/g;
// Any reset guarded by the bare helper result (truthy for 'receipt' too).
const BARE_HELPER_RESET = /if\s*\(\s*getIdempotencyBindingRejection\([^)]*\)\s*\)\s*\{?\s*\S*reset\S*\(/;

describe('replay-binding batch 1 call sites keep the key on a receipt refusal', () => {
  for (const [file, count] of Object.entries(SITES)) {
    it(`${file}: ${count} site(s) retire the key only for intent or actor`, () => {
      const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      expect(source.match(INTENT_OR_ACTOR_RESET)?.length ?? 0).toBe(count);
      expect(BARE_HELPER_RESET.test(source)).toBe(false);
    });
  }

  it('the patterns tell the two forms apart', () => {
    const good = "const bindingRejection = getIdempotencyBindingRejection(error);\n    if (bindingRejection === 'intent' || bindingRejection === 'actor') idem.resetKey();";
    const bad = 'if (getIdempotencyBindingRejection(error)) idem.resetKey();';
    expect(good.match(INTENT_OR_ACTOR_RESET)?.length).toBe(1);
    expect(BARE_HELPER_RESET.test(good)).toBe(false);
    expect(BARE_HELPER_RESET.test(bad)).toBe(true);
  });
});
