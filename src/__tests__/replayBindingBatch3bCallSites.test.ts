/**
 * Replay-binding batch 3b (migration 20261019235000): cancel_delivery, void_delivery and void_order
 * replay a saved result only for the same person and the exact same request (the record and the
 * reason). Each screen therefore keys its retry per (record, reason): an edited reason gets its own
 * key, an exact retry reuses the first one, and the key is retired only after a confirmed result.
 *
 * On ANY replay-binding refusal ('intent', 'actor' or 'receipt') the screen retires the key and
 * reloads, as batch 3a does for completions: none of the three can repeat (the next try runs under
 * a fresh key and the body refuses a delivery already cancelled or voided, or an order no longer
 * fulfilled), so a retired key can never reverse the same record twice.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

// [file, rpc, key hook, scope variable, reason expression, reload call]
const SITES: Array<[string, string, string, string, string, string]> = [
  ['src/pages/DeliveryDetail.tsx', 'cancel_delivery', 'cancelIdem', 'cancelScope', "cancelReason.trim() || 'Cancelled'", 'fetchDelivery'],
  ['src/pages/DeliveryDetail.tsx', 'void_delivery', 'voidIdem', 'voidScope', 'voidReason.trim()', 'fetchDelivery'],
  ['src/pages/OrderDetail.tsx', 'void_order', 'voidOrderIdem', 'voidScope', "voidReason.trim() || 'Voided by admin'", 'fetchOrder'],
];

/** The handler body that sends `rpc`, from the reason line to the next handler. */
function handlerFor(source: string, rpc: string): string {
  const call = source.indexOf(`.rpc('${rpc}', {`);
  expect(call, `${rpc} call not found`).toBeGreaterThan(-1);
  const start = source.lastIndexOf('const reason = ', call);
  expect(start, `${rpc}: the reason is not read once before the call`).toBeGreaterThan(-1);
  const end = source.indexOf('\n  };', call);
  expect(end, `${rpc}: handler end not found`).toBeGreaterThan(-1);
  return source.slice(start, end);
}

describe('replay-binding batch 3b call sites key each retry to the exact request', () => {
  for (const [file, rpc, hook, scope, reasonExpr, reload] of SITES) {
    describe(`${file}: ${rpc}`, () => {
      const handler = handlerFor(read(file), rpc);

      it('reads the reason once and keys the retry by (record, reason)', () => {
        expect(handler.startsWith(`const reason = ${reasonExpr};`)).toBe(true);
        expect(handler).toMatch(new RegExp(`const ${scope} = JSON\\.stringify\\(\\[(?:id!|order\\.id), reason\\]\\);`));
        expect(handler).toContain(`p_idempotency_key: idemKey,`);
        expect(handler).toMatch(new RegExp(`const idemKey = ${hook}\\.getKeyFor\\(${scope}\\);`));
        // The reason sent is the one the scope was built from, and the record is the scoped one.
        expect(handler).toMatch(/p_(?:cancel_)?reason: reason,/);
        expect(handler).not.toMatch(new RegExp(`${hook}\\.(?:getKey|resetKey)\\(\\)`));
      });

      it('retires the key only after the verified reply', () => {
        const assertAt = handler.indexOf(`'${rpc}');`);
        const resetAt = handler.indexOf(`${hook}.resetKeyFor(${scope});`, assertAt);
        expect(assertAt).toBeGreaterThan(-1);
        expect(handler.slice(Math.max(0, assertAt - 400), assertAt)).toContain('assertRpcResult');
        expect(resetAt).toBeGreaterThan(assertAt);
      });

      it('retires the key and reloads on any binding refusal', () => {
        expect(handler).toMatch(new RegExp(
          `if \\(getIdempotencyBindingRejection\\((?:err|error)\\)\\) \\{\\n\\s*${hook}\\.resetKeyFor\\(${scope}\\);\\n\\s*${reload}\\(\\);\\n\\s*\\}`,
        ));
        expect(handler).not.toMatch(/bindingRejection === 'intent' \|\| bindingRejection === 'actor'/);
      });

      it('an empty reply cannot strand the button: the call and its check sit in try, loading resets in finally', () => {
        const tryAt = handler.indexOf('try {');
        const callAt = handler.indexOf(`.rpc('${rpc}', {`);
        const assertAt = handler.indexOf(`'${rpc}');`);
        const catchAt = handler.indexOf('} catch (', assertAt);
        expect(tryAt).toBeGreaterThan(-1);
        expect(callAt).toBeGreaterThan(tryAt);
        // No block closes between that try and the call, so the call is inside it (not after an
        // earlier, unrelated try).
        expect(handler.slice(tryAt + 'try {'.length, callAt)).not.toMatch(/\n\s*\}/);
        // The catch found is the first one after the call, and it closes that same try.
        expect(handler.indexOf('} catch (', callAt)).toBe(catchAt);
        expect(catchAt).toBeGreaterThan(assertAt);
        expect(handler.slice(catchAt)).toMatch(/\} finally \{\n\s*set(?:Cancelling|Voiding)\(false\);\n\s*\}$/);
      });
    });
  }

  it('the void-order button no longer retires a key on open (each request has its own key)', () => {
    expect(read('src/pages/OrderDetail.tsx')).not.toContain('voidOrderIdem.resetKey();');
  });
});

// The migration's wrappers must fingerprint exactly what the screens vary, so an edited reason or a
// different record is refused (or keyed apart) rather than replayed.
describe('replay-binding batch 3b migration binds the record and the reason', () => {
  const sql = read('supabase/migrations/20261019235000_bind_delivery_order_void_replay_receipts_batch3b.sql');

  for (const [name, idField, reasonField, reasonArg] of [
    ['cancel_delivery', "'delivery_id', p_delivery_id", "'cancel_reason', p_cancel_reason", 'p_cancel_reason'],
    ['void_delivery', "'delivery_id', p_delivery_id", "'reason', p_reason", 'p_reason'],
    ['void_order', "'order_id', p_order_id", "'reason', p_reason", 'p_reason'],
  ] as const) {
    it(`${name}: requires a key, checks the role first, and fingerprints actor, record and reason`, () => {
      const start = sql.indexOf(`CREATE FUNCTION public.${name}(`);
      expect(start).toBeGreaterThan(-1);
      const body = sql.slice(start, sql.indexOf('$function$;', start));
      expect(body).toContain(`IDEMPOTENCY_KEY_REQUIRED: ${name} requires p_idempotency_key`);
      expect(body).toContain("'actor_id', v_actor");
      expect(body).toContain(idField);
      expect(body).toContain(reasonField);
      expect(body).toContain(reasonArg);
      // The role check sits before the intent check, so no stored result is returned before it.
      const role = Math.max(body.indexOf('Not authorized to cancel deliveries'), body.indexOf('is_admin()'));
      expect(role).toBeGreaterThan(-1);
      expect(role).toBeLessThan(body.indexOf('check_idempotency_intent('));
      expect(body.indexOf(`_${name}_replay_impl_20261015(`)).toBeGreaterThan(body.indexOf('check_idempotency_intent('));
      expect(body).toContain(`_bind_replay_receipt_20261015(p_idempotency_key, '${name}', v_fingerprint)`);
    });
  }

  it('void_order zeroes a draft only when no money is recorded on the row it writes, else refuses', () => {
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION public._void_order_impl_20260714(');
    expect(start).toBeGreaterThan(-1);
    const body = sql.slice(start, sql.indexOf('$function$;', start));
    // The zero-money condition sits in the UPDATE's own WHERE (evaluated on the row being written,
    // so a concurrent write that records money is seen), never only in an earlier read.
    const update = body.slice(body.indexOf('      UPDATE public.invoices\n        SET status = \'cancelled\','));
    const statement = update.slice(0, update.indexOf(';\n') + 1);
    expect(statement).toContain('paid_amount_cents = 0,');
    for (const field of ['paid_amount_cents', 'prepay_applied_cents', 'write_off_cents', 'credit_applied_cents']) {
      expect(statement).toContain(`AND COALESCE(${field}, 0) = 0`);
    }
    expect(update.slice(statement.length)).toMatch(
      /^\n\s+IF NOT FOUND THEN\n\s+RAISE EXCEPTION 'ORDER_VOID_DRAFT_HAS_APPLIED_MONEY:/
    );
    expect(body).not.toContain('COALESCE(v_invoice.paid_amount_cents');
  });

  it('batch cancel keeps cancelling keyless through the renamed body, not the keyed wrapper', () => {
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION public._batch_cancel_deliveries_replay_impl_20261015(');
    expect(start).toBeGreaterThan(-1);
    const body = sql.slice(start, sql.indexOf('$function$;', start));
    expect(body).toContain('v_result := _cancel_delivery_replay_impl_20261015(p_delivery_id := v_del.id, p_cancel_reason := p_cancel_reason, p_performed_by := v_actor);');
    expect(body).not.toMatch(/(^|[^_a-z])cancel_delivery\s*\(/);
  });
});
