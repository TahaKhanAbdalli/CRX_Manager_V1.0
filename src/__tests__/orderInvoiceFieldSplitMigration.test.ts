/**
 * Migration 20261022021000: create_invoice_from_order refuses an order split across fields
 * (ORDER_HAS_FIELD_SPLIT), inside its idempotency layer and AFTER the replay lookup, so an exact
 * retry of an invoice created before the split still returns its id. The order's lines are locked
 * before the test, so no allocation can commit between the test and the invoice insert.
 *
 * Static contract over the file; the behaviour proof is
 * scripts/smoke/prove-order-invoice-refuses-field-split-real-schema.mjs (container, with a
 * two-connection race and placement mutations).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sanitizeError } from '../lib/errorSanitizer';

const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const md5 = (text: string) => createHash('md5').update(text).digest('hex');

const MIGRATION = 'supabase/migrations/20261022021000_order_invoice_refuses_field_split.sql';
const sql = read(MIGRATION);
const header = sql.slice(
  sql.indexOf('CREATE OR REPLACE FUNCTION public._create_invoice_from_order_idem_impl_20260721('),
  sql.indexOf('AS $function$') + 'AS $function$'.length,
);
const body = sql.slice(sql.indexOf('AS $function$') + 'AS $function$'.length, sql.indexOf('$function$;'));
const preflight = sql.split('$preflight$')[1];
const postflight = sql.split('$postflight$')[1];

const at = (needle: string) => {
  const i = body.indexOf(needle);
  expect(i, `not in the body: ${needle}`).toBeGreaterThan(-1);
  expect(body.indexOf(needle, i + 1), `more than once in the body: ${needle}`).toBe(-1);
  return i;
};

describe('20261022021000 order invoice refuses a field split', () => {
  it('replaces exactly one function, keeping its signature, definer mode and search_path, with no grant change', () => {
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(header).toContain('p_order_id uuid,\n  p_salesman_id uuid DEFAULT NULL,\n  p_invoice_type text DEFAULT \'chemical_sale\',\n  p_idempotency_key text DEFAULT NULL\n)');
    expect(header).toContain('RETURNS uuid\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = public, pg_temp');
    expect(sql).not.toMatch(/^\s*(GRANT|REVOKE|ALTER|DROP|DELETE|UPDATE|INSERT|TRUNCATE)\b/im);
  });

  it('refuses after the replay lookup and the terminal-order test, and before the billing core and the saved key', () => {
    const replayReturn = at("RETURN NULLIF(v_existing->'response'->>'invoice_id', '')::uuid;");
    const terminal = at("RAISE EXCEPTION 'ORDER_INVOICE_TERMINAL:");
    const delivery = at("RAISE EXCEPTION 'Cannot create an order-level invoice for order % — it has % active delivery(ies);");
    const lineLock = at('  PERFORM 1\n    FROM public.order_items oi\n   WHERE oi.order_id = p_order_id\n   ORDER BY oi.id\n   FOR UPDATE;');
    const test = at('FROM public.order_item_field_allocations oifa\n      JOIN public.order_items oi ON oi.id = oifa.order_item_id\n     WHERE oi.order_id = p_order_id');
    const refusal = at("RAISE EXCEPTION 'ORDER_HAS_FIELD_SPLIT: this order is split across fields; bill it per field owner through create_split_invoices_from_order'\n      USING ERRCODE = 'check_violation';");
    const core = at('v_invoice_id := public._create_invoice_from_order_impl_20260718(');
    const save = at('PERFORM public.save_idempotency(');
    expect(replayReturn).toBeLessThan(terminal);
    expect(terminal).toBeLessThan(delivery);
    expect(delivery).toBeLessThan(lineLock);
    expect(lineLock).toBeLessThan(test);
    expect(test).toBeLessThan(refusal);
    expect(refusal).toBeLessThan(core);
    expect(core).toBeLessThan(save);
  });

  it('is the live body plus only the field-split hunk, matching the preflight and postflight pins', () => {
    const hunkStart = at('  -- Field split (20261022021000)');
    const hunkEnd = at('  v_invoice_id := public._create_invoice_from_order_impl_20260718(');
    const original = body.slice(0, hunkStart) + body.slice(hunkEnd);
    expect(preflight).toContain(`md5(replace(p.prosrc, chr(13), '')) = '${md5(original)}'`);
    expect(md5(original)).toBe('3d393fb8639dbcb2aa38574ca9679eee');
    expect(postflight).toContain(`md5(replace(p.prosrc, chr(13), '')) = '${md5(body)}'`);
  });

  it('raises the billing core\'s own live-delivery refusal before the line lock, word for word', () => {
    // The core (pinned by the preflight) refuses any order with a delivery that is not cancelled or
    // voided; raising it first keeps the line lock from waiting on complete_delivery.
    const core = read('supabase/migrations/20260827041400_align_return_credit_order_invoice_gates.sql');
    const words = "'Cannot create an order-level invoice for order % — it has % active delivery(ies); invoices are created per delivery on completion. Cancel/void those deliveries first to bill the whole order manually.'";
    expect(core).toContain(`RAISE EXCEPTION ${words}, v_order.order_number, v_delivery_count;`);
    expect(core).toContain("FROM deliveries\n   WHERE order_id = p_order_id\n     AND status NOT IN ('cancelled', 'voided');");
    expect(body).toContain(`RAISE EXCEPTION ${words},`);
    expect(body.match(/d\.order_id = p_order_id AND d\.status NOT IN \('cancelled', 'voided'\)/g)).toHaveLength(2);
  });

  it('keeps the layer private and pins what the placement relies on', () => {
    for (const block of [preflight, postflight]) {
      expect(block).toContain("IS NOT DISTINCT FROM ARRAY['postgres']::text[]");
      for (const sig of [
        "('public.create_invoice_from_order(uuid,uuid,text,text)', 'c97b2be8bee9dd8baaaab92bc24b92e7')",
        "('public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)', '454e04c4e199549a4f5be9975e397e17')",
        "('public.create_split_invoices_from_order(uuid,uuid,text,text)', '0f1e36e8536fc56f08fcf6071ea76da8')",
        "('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)', 'ccde51261dd8c5270b6dbd24f28981bd')",
      ]) expect(block).toContain(sig);
    }
    // The race argument's three supports: the allocation foreign key, the allocation trigger
    // (with its body), and the order-line foreign key.
    expect(preflight).toContain("pg_get_constraintdef(c.oid) = 'FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE'");
    expect(preflight).toContain("pg_get_constraintdef(c.oid) = 'FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE'");
    expect(preflight).toContain("AND t.tgenabled = 'O'");
    expect(preflight).toContain("IS DISTINCT FROM '90a83898c13b7273d6e895691c619b88'");
    expect(postflight).toContain("RAISE NOTICE 'POSTFLIGHT_OK:");
  });

  it('registers its rollback chain as container-only with its prover', () => {
    const specs = JSON.parse(read('scripts/smoke/smoke-specs.json')) as { specs: Record<string, { chain: string; container_only?: boolean; container_prover?: string; covers: string[] }> };
    const spec = specs.specs.order_invoice_refuses_field_split;
    expect(spec.chain).toBe('smoke-order-invoice-refuses-field-split.sql');
    expect(spec.container_only).toBe(true);
    expect(spec.container_prover).toBe('prove-order-invoice-refuses-field-split-real-schema.mjs');
    expect(spec.covers).toEqual(expect.arrayContaining(['create_invoice_from_order', 'create_split_invoices_from_order']));
  });

  it('shows the refusal on the Order page in plain words', () => {
    // OrderDetail's Create Invoice runs through runCriticalAction, which toasts sanitizeError(err).
    const page = read('src/pages/OrderDetail.tsx');
    const start = page.indexOf('const handleCreateInvoice = async () => {');
    const end = page.indexOf('sentryTag:', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = page.slice(start, end);
    expect(handler).toContain('await runCriticalAction({');
    const call = handler.indexOf("supabase.rpc('create_invoice_from_order', {");
    expect(call).toBeGreaterThan(-1);
    // The refusal is thrown to runCriticalAction, not swallowed.
    expect(handler.indexOf('if (error) throw error;', call)).toBeGreaterThan(call);
    expect(read('src/lib/criticalAction.ts')).toContain("toast('error', sanitizeError(err));");
    const shown = sanitizeError('ORDER_HAS_FIELD_SPLIT: this order is split across fields; bill it per field owner through create_split_invoices_from_order');
    expect(shown).toContain('Nothing was billed');
    expect(shown).not.toMatch(/ORDER_HAS_FIELD_SPLIT|create_split_invoices_from_order/);
  });
});
