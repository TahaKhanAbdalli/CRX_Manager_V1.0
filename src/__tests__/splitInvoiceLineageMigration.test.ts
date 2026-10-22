/**
 * Migration 20261021150000: guard_invoice_terminal_order admits a governed split invoice that names
 * a field owner other than the order's customer: inside create_split_invoices_from_order's claim,
 * for a customer the order's field split bills, or afterwards under its own provenance row. Every
 * other order invoice for another customer is still INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID.
 *
 * Static contract over the file; the behaviour proof is
 * scripts/smoke/prove-split-invoice-cross-customer-lineage-real-schema.mjs (container: a four-customer
 * split created, replayed, posted and voided, seven refusals, four mutations).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const md5 = (text: string) => createHash('md5').update(text).digest('hex');

const sql = read('supabase/migrations/20261021150000_split_invoice_cross_customer_lineage.sql');
const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.guard_invoice_terminal_order()');
const header = sql.slice(start, sql.indexOf('AS $function$', start) + 'AS $function$'.length);
const body = sql.slice(sql.indexOf('AS $function$', start) + 'AS $function$'.length, sql.indexOf('$function$;', start));
const preflight = sql.split('$preflight$')[1];
const postflight = sql.split('$postflight$')[1];

const LINEAGE_RAISE = "    RAISE EXCEPTION 'INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID: invoice and order customer must match';\n";

describe('20261021150000 split invoice cross-customer lineage', () => {
  it('replaces only the guard, keeping it a SECURITY DEFINER trigger function, with no grant or row change', () => {
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(header).toBe('CREATE OR REPLACE FUNCTION public.guard_invoice_terminal_order()\nRETURNS trigger\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = public, pg_temp\nAS $function$');
    expect(sql).not.toMatch(/^\s*(GRANT|REVOKE|ALTER|DROP|DELETE|UPDATE|INSERT|TRUNCATE)\b/im);
  });

  it('still raises the lineage error for every customer mismatch the split exception does not admit', () => {
    expect(body.split(LINEAGE_RAISE)).toHaveLength(2);
    expect(body).toContain('  IF NEW.customer_id IS DISTINCT FROM v_order_customer_id AND NOT v_governed_split_customer THEN\n' + LINEAGE_RAISE);
    // The exception is considered only for a grouped (split) invoice.
    expect(body).toContain('  IF NEW.customer_id IS DISTINCT FROM v_order_customer_id AND NEW.invoice_group_id IS NOT NULL THEN\n');
  });

  it('admits an UPDATE only under the invoice\'s own provenance, with its customer and group unchanged', () => {
    expect(body).toContain('      v_split_identity_kept := NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id\n        AND NEW.invoice_group_id IS NOT DISTINCT FROM OLD.invoice_group_id;');
    expect(body).toMatch(/v_governed_split_customer := v_split_identity_kept AND EXISTS \(\n\s+SELECT 1\n\s+FROM public\.split_invoice_provenance p\n\s+WHERE p\.invoice_id = NEW\.id\n\s+AND p\.order_id = NEW\.order_id\n\s+AND p\.customer_id = NEW\.customer_id\n\s+AND p\.invoice_group_id = NEW\.invoice_group_id/);
  });

  it('admits creation only inside the split claim, for a customer the split resolves as the split implementation does', () => {
    expect(body).toMatch(/FROM public\.split_invoice_creation_claims claim\n\s+WHERE claim\.transaction_id = pg_current_xact_id\(\)\n\s+AND claim\.order_id = NEW\.order_id\n\s+\) AND EXISTS \(/);
    // Billing-default customers of an allocated field, or the field's own customer when it has none.
    expect(body).toContain('SELECT 1 FROM public.field_billing_defaults fbd\n                WHERE fbd.field_id = oifa.field_id\n                  AND fbd.customer_id = NEW.customer_id');
    expect(body).toContain('NOT EXISTS (SELECT 1 FROM public.field_billing_defaults fbd WHERE fbd.field_id = oifa.field_id)');
    expect(body).toContain('WHERE f.id = oifa.field_id\n                    AND f.customer_id = NEW.customer_id');
    expect(body).toContain('WHERE oi.order_id = NEW.order_id');
  });

  it('is the live body plus only the two marked hunks, matching the preflight and postflight pins', () => {
    const decl = '  -- Governed split (20261021150000): see the lineage test below.\n  v_split_identity_kept boolean := false;\n  v_governed_split_customer boolean := false;\n';
    const hunkStart = body.indexOf('  -- Governed split (20261021150000): a split invoice');
    const hunkEnd = body.indexOf(LINEAGE_RAISE) + LINEAGE_RAISE.length + '  END IF;\n'.length;
    expect(body.split(decl)).toHaveLength(2);
    expect(hunkStart).toBeGreaterThan(-1);
    const original = body.replace(decl, '').slice(0, hunkStart - decl.length)
      + "  IF NEW.customer_id IS DISTINCT FROM v_order_customer_id THEN\n" + LINEAGE_RAISE + '  END IF;\n'
      + body.replace(decl, '').slice(hunkEnd - decl.length);
    expect(md5(original)).toBe('d2ce62f92956ccd651f570a94ce3f1dc');
    expect(preflight).toContain("md5(replace(p.prosrc, chr(13), '')) = 'd2ce62f92956ccd651f570a94ce3f1dc'");
    expect(postflight).toContain(`md5(replace(p.prosrc, chr(13), '')) = '${md5(body)}'`);
  });

  it('pins what the exception relies on', () => {
    for (const block of [preflight, postflight]) {
      expect(block).toContain("IS NOT DISTINCT FROM ARRAY['postgres']::text[]");
      expect(block).toContain("pg_get_triggerdef(t.oid) = 'CREATE TRIGGER trg_guard_invoice_terminal_order BEFORE INSERT OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_invoice_terminal_order()'");
      // The exception leans on these two firing on every INSERT, and every UPDATE and DELETE.
      expect(block).toContain("pg_get_triggerdef(t.oid) = 'CREATE TRIGGER require_split_invoice_creation_claim BEFORE INSERT ON public.invoices FOR EACH ROW EXECUTE FUNCTION require_split_invoice_creation_claim()'");
      expect(block).toContain("pg_get_triggerdef(t.oid) = 'CREATE TRIGGER guard_split_invoice_provenance_identity BEFORE DELETE OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_split_invoice_provenance_identity()'");
      for (const pin of [
        "('public.require_split_invoice_creation_claim()', 'e73daae16c5ff5432644060f2b34f925')",
        "('public.guard_split_invoice_provenance_identity()', '639875d6641556c78c25d633c67821f1')",
        "('public.create_split_invoices_from_order(uuid,uuid,text,text)', '0f1e36e8536fc56f08fcf6071ea76da8')",
        "('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)', 'f671f1a3f5406cff52aedd8a5fb40b31')",
      ]) expect(block).toContain(pin);
    }
    // No Data API role can manufacture a claim or a provenance row.
    expect(preflight).toContain("unnest(ARRAY['public.split_invoice_creation_claims', 'public.split_invoice_provenance'])");
    expect(preflight).toContain("unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])");
    expect(preflight).toContain('AND NOT c.relrowsecurity');
  });

  it('registers its rollback chain as container-only with its prover', () => {
    const specs = JSON.parse(read('scripts/smoke/smoke-specs.json')) as { specs: Record<string, { chain: string; container_only?: boolean; container_prover?: string; covers: string[] }> };
    const spec = specs.specs.split_invoice_cross_customer_lineage;
    expect(spec.chain).toBe('smoke-split-invoice-cross-customer-lineage.sql');
    expect(spec.container_only).toBe(true);
    expect(spec.container_prover).toBe('prove-split-invoice-cross-customer-lineage-real-schema.mjs');
    expect(spec.covers).toEqual(expect.arrayContaining(['guard_invoice_terminal_order', 'create_split_invoices_from_order', 'post_invoice_group', 'void_invoice_group', 'create_invoice_from_order']));
  });
});
