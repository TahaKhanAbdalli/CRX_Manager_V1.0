/**
 * Replay-binding batch 2 (migration 20261016140000): the screens that call the thirteen wrapped
 * stock RPCs retire a refused retry key ONLY when the refusal proves nothing committed under it
 * ('intent' = the key belongs to a different request, 'actor' = to another user). A 'receipt'
 * refusal (IDEMPOTENCY_RESULT_INVALID / IDEMPOTENCY_RECEIPT_MISSING) must keep the key: an earlier
 * attempt may have committed, and the key is the only way to replay it instead of repeating the
 * stock action. Same rule and form as batch 1 (replayBindingBatch1CallSites.test.ts).
 *
 * reconcile_negative_inventory (IntegrityCleanupPanel) is deliberately left without the reset: its
 * key is already scoped to the exact row, quantity and reason, so a binding refusal is unreachable
 * there, and its unresolved-intent guard must keep a refused scope frozen rather than mint a fresh
 * key for an absolute stock write.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// File -> number of batch-2 call sites in it.
const SITES: Record<string, number> = {
  'src/pages/InventoryPage.tsx': 3, // release_inventory_hold, manual_inventory_add, retire_inventory_item
  'src/pages/BlendTicketDetail.tsx': 2, // create_order_from_blend_ticket, create_application_record_from_blend_ticket
  'src/pages/NewOrder.tsx': 2, // create_rush_order, create_direct_order
  'src/pages/QuoteBuilder.tsx': 3, // create_planned_holds, close_quote_as_applied, close_quote_as_short
  'src/pages/Deliveries.tsx': 1, // batch_cancel_deliveries
  'src/pages/CycleCounts.tsx': 1, // reverse_completed_cycle_count
};

const INTENT_OR_ACTOR_RESET =
  /const bindingRejection = getIdempotencyBindingRejection\(\w+\);\s*\n\s*if \(bindingRejection === 'intent' \|\| bindingRejection === 'actor'\) \S*reset\S*\(/g;
// Any reset guarded by the bare helper result (truthy for 'receipt' too).
const BARE_HELPER_RESET = /if\s*\(\s*getIdempotencyBindingRejection\([^)]*\)\s*\)\s*\{?\s*\S*reset\S*\(/;

const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

describe('replay-binding batch 2 call sites keep the key on a receipt refusal', () => {
  for (const [file, count] of Object.entries(SITES)) {
    it(`${file}: ${count} site(s) retire the key only for intent or actor`, () => {
      const source = read(file);
      expect(source.match(INTENT_OR_ACTOR_RESET)?.length ?? 0).toBe(count);
      expect(BARE_HELPER_RESET.test(source)).toBe(false);
    });
  }

  // After 20261016140000 twelve of the thirteen refuse a keyless call (IDEMPOTENCY_KEY_REQUIRED);
  // the generated types still mark the key optional, so pin that every app call sends one.
  const KEYED_CALLS: Array<[string, string]> = [
    ['src/pages/InventoryPage.tsx', 'release_inventory_hold'],
    ['src/pages/InventoryPage.tsx', 'manual_inventory_add'],
    ['src/pages/InventoryPage.tsx', 'retire_inventory_item'],
    ['src/components/integrity/IntegrityCleanupPanel.tsx', 'reconcile_negative_inventory'],
    ['src/pages/BlendTicketDetail.tsx', 'create_order_from_blend_ticket'],
    ['src/pages/BlendTicketDetail.tsx', 'create_application_record_from_blend_ticket'],
    ['src/pages/NewOrder.tsx', 'create_rush_order'],
    ['src/pages/NewOrder.tsx', 'create_direct_order'],
    ['src/pages/QuoteBuilder.tsx', 'create_planned_holds'],
    ['src/pages/QuoteBuilder.tsx', 'close_quote_as_applied'],
    ['src/pages/QuoteBuilder.tsx', 'close_quote_as_short'],
    ['src/pages/Deliveries.tsx', 'batch_cancel_deliveries'],
    ['src/pages/CycleCounts.tsx', 'reverse_completed_cycle_count'],
  ];
  for (const [file, rpc] of KEYED_CALLS) {
    it(`${file}: every ${rpc} call sends p_idempotency_key`, () => {
      const source = read(file);
      // Each call's argument object runs to its closing line: '})' or, under the below-cost
      // wrapper, '}, reason)'.
      const calls = [...source.matchAll(new RegExp(`\\.rpc\\('${rpc}',([\\s\\S]*?)\\n\\s*\\}(?:, reason)?\\)`, 'g'))];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        // A real key expression, never undefined/null or an `|| undefined` fallback.
        expect(call[1]).toMatch(/p_idempotency_key:\s*\S/);
        expect(call[1]).not.toMatch(/p_idempotency_key:[^,\n]*\b(?:undefined|null)\b/);
      }
    });
  }

  // An edited retry under a key whose first attempt already created an order is refused as
  // 'intent' with that order's receipt; the order screens open it rather than let the next click,
  // with a fresh key, create a second order (Codex P1 on PR #951).
  // NewOrder runs inside runCriticalAction, so it must exit with the handled signal (a plain return
  // would add the generic success toast); BlendTicketDetail shows its own toasts and returns.
  const HANDLED_EXIT = '//[^\\n]*\\n\\s*throw new CriticalActionHandledError\\(';
  const ORDER_RECOVERY: Array<[string, string, string]> = [
    ['src/pages/NewOrder.tsx', 'create_rush_order', HANDLED_EXIT],
    ['src/pages/NewOrder.tsx', 'create_direct_order', HANDLED_EXIT],
    ['src/pages/BlendTicketDetail.tsx', 'create_order_from_blend_ticket', 'return;'],
  ];
  for (const [file, rpc, exit] of ORDER_RECOVERY) {
    it(`${file}: a ${rpc} intent refusal opens the order already created`, () => {
      const source = read(file);
      expect(source).toMatch(new RegExp(
        `const committedOrderId = getCommittedOrderIdFromMismatch\\(error, '${rpc}'\\);\\s*\\n\\s*if \\(committedOrderId\\) \\{[\\s\\S]{0,600}?navigate\\(\`/orders/\\$\\{committedOrderId\\}\`\\);\\s*\\n\\s*${exit}`,
      ));
    });
  }

  // An intent refusal means the current form differs from the order that committed, so the
  // recovery must keep the draft: clearing it would lose edits that are in no order (Sol, 2026-10-18).
  it('NewOrder: the order recovery keeps the edited form as a draft', () => {
    const source = read('src/pages/NewOrder.tsx');
    const blocks = source.match(/if \(committedOrderId\) \{[\s\S]*?throw new CriticalActionHandledError\(/g) ?? [];
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block).not.toContain('clearDraft');
      // The debounced save may not have run yet, so the recovery writes the draft before leaving
      // (CodeRabbit), from the latest form state rather than the click-time snapshot (Codex).
      expect(block).toMatch(/flushLatestDraft\(\);[\s\S]*navigate\(/);
      expect(block).not.toMatch(/flush\w*\(draftState\)/);
    }
  });

  // Each key resets exactly when its RPC's arguments change: the intent is the argument object
  // the call sends, JSON-encoded. A delimiter join let two different forms keep one key (Sol), and
  // a field the RPC never sees must not retire a key whose attempt may have committed (CodeRabbit).
  const ORDER_INTENT: Array<[string, string, string, string]> = [
    ['create_direct_order', 'directOrderArgs', 'directOrderIntentHash', 'createOrderIdem'],
    ['create_rush_order', 'rushOrderArgs', 'rushOrderIntentHash', 'rushOrderIdem'],
  ];
  for (const [rpc, args, hash, idem] of ORDER_INTENT) {
    it(`NewOrder: ${rpc} sends exactly the arguments its key's intent hashes`, () => {
      const source = read('src/pages/NewOrder.tsx');
      expect(source).toContain(`const ${hash} = JSON.stringify(${args});`);
      expect(source).toMatch(new RegExp(`useEffect\\(\\(\\) => \\{\\s*${idem}\\.resetKey\\(\\);[^}]*\\}, \\[${hash}\\]\\);`));
      expect(source).toMatch(new RegExp(`supabase\\.rpc\\('${rpc}', withBelowCostReason\\('${rpc}', \\{\\s*\\.\\.\\.${args},\\s*p_performed_by: profile\\.id,\\s*p_idempotency_key: (\\w+),\\s*\\}, belowCostReasonFor\\(\\1, reason\\)\\)`));
    });
  }

  it('the reconcile screen keeps its exact-intent key on any refusal', () => {
    const source = read('src/components/integrity/IntegrityCleanupPanel.tsx');
    expect(source).toContain('const scope = `reconcile:${row.id}:${newQuantity}:${input.reason.trim()}`;');
    expect(source).not.toMatch(/getIdempotencyBindingRejection\([^)]*\)[\s\S]{0,120}reconcileIdem\.reset/);
  });

  it('the patterns tell the two forms apart', () => {
    const good = "const bindingRejection = getIdempotencyBindingRejection(holdError);\n    if (bindingRejection === 'intent' || bindingRejection === 'actor') idem.resetKey();";
    const bad = 'if (getIdempotencyBindingRejection(error)) idem.resetKeyFor(scope);';
    expect(good.match(INTENT_OR_ACTOR_RESET)?.length).toBe(1);
    expect(BARE_HELPER_RESET.test(good)).toBe(false);
    expect(BARE_HELPER_RESET.test(bad)).toBe(true);
  });
});

// The thirteen refuse a keyless call, so a browser test that leaves the key out fails once the
// migration is live (Codex, PR #951). Every e2e call to one of them must send a key.
describe('replay-binding batch 2 e2e callers send a retry key', () => {
  const WRAPPED = [
    'release_inventory_hold', 'retire_inventory_item', 'reconcile_negative_inventory', 'manual_inventory_add',
    'create_order_from_blend_ticket', 'create_direct_order', 'create_rush_order', 'close_quote_as_applied',
    'close_quote_as_short', 'create_application_record_from_blend_ticket', 'batch_cancel_deliveries',
    'reverse_completed_cycle_count', 'create_planned_holds',
  ];
  const CALL = new RegExp(`(?:supabaseRpc|rpc)\\(\\s*page,\\s*'(${WRAPPED.join('|')})',\\s*\\{`, 'g');
  const argsOf = (source: string, open: number) => {
    let depth = 1;
    let i = open;
    while (depth > 0 && i < source.length) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    return source.slice(open, i);
  };
  const keylessCalls = (source: string) =>
    [...source.matchAll(CALL)].filter((m) => !/p_idempotency_key/.test(argsOf(source, m.index + m[0].length)));

  it('no e2e spec calls a wrapped RPC without p_idempotency_key', () => {
    const specs = readdirSync('tests/e2e').filter((f) => f.endsWith('.ts'));
    let calls = 0;
    for (const spec of specs) {
      const source = read(`tests/e2e/${spec}`);
      calls += [...source.matchAll(CALL)].length;
      expect(keylessCalls(source).map((m) => `${spec}: ${m[1]}`)).toEqual([]);
    }
    expect(calls).toBeGreaterThanOrEqual(19);
  });

  it('the check tells a keyless call from a keyed one', () => {
    expect(keylessCalls("await supabaseRpc(page, 'create_direct_order', { p_customer_id: c, p_items: [{ a: 1 }] });")).toHaveLength(1);
    expect(keylessCalls("await supabaseRpc(page, 'create_direct_order', { p_items: [{ a: 1 }], p_idempotency_key: k });")).toHaveLength(0);
  });
});
