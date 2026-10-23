/**
 * Contract for 20261021155000_split_payer_return_credit: a field owner billed through a split can
 * return its billed share and receive its own return credit, and no payer can return another payer's
 * share. The container proof (scripts/smoke/prove-split-payer-return-credit-real-schema.mjs) runs the
 * behaviour; this pins the file's shape: each replaced body is its pinned predecessor plus only hunks
 * marked "Split-payer return", the pins match the bodies, and the new objects stay private.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const MIGRATION = read('supabase/migrations/20261021155000_split_payer_return_credit.sql');
const RETURNS_SOURCE = read('supabase/migrations/20260723193312_product_families_return_policy_foundation.sql');
const LINEAGE_SOURCE = read('supabase/migrations/20261021150000_split_invoice_cross_customer_lineage.sql');
const MONO_SOURCE = read('supabase/migrations/20260719044912_trust_only_post_revoke_split_provenance.sql');
const SPLIT_SOURCE = read('supabase/migrations/20260827041400_align_return_credit_order_invoice_gates.sql');

function body(sql: string, header: string): string {
  const at = sql.indexOf(header);
  expect(at, `${header} is missing`).toBeGreaterThanOrEqual(0);
  const start = sql.indexOf('$function$', at) + '$function$'.length;
  return sql.slice(start, sql.indexOf('$function$', start));
}

// Changed regions of `after` relative to `before` (a line LCS), each as its lines; changes at most
// two unchanged lines apart are one region (an unchanged `FOR UPDATE;` inside a rewritten query).
function changedHunks(before: string, after: string): string[][] {
  const a = before.split('\n');
  const b = after.split('\n');
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const hunks: string[][] = [];
  // Unchanged lines since the last change; null before the first change.
  const state: { unchanged: string[] | null } = { unchanged: null };
  const change = (line: string) => {
    if (state.unchanged !== null && state.unchanged.length <= 2) {
      hunks[hunks.length - 1].push(...state.unchanged.map((u) => ` ${u}`), line);
    } else {
      hunks.push([line]);
    }
    state.unchanged = [];
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      state.unchanged?.push(a[i]);
      i += 1; j += 1;
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      change(`+${b[j]}`); j += 1;
    } else {
      change(`-${a[i]}`); i += 1;
    }
  }
  return hunks;
}

const FUNCTIONS = [
  { name: '_create_return_intent_impl_20260812', source: RETURNS_SOURCE, sourceHeader: 'CREATE OR REPLACE FUNCTION public.create_return(', pre: '80b3f9fd43c3ab3e56eae2935c525dcd', hunks: 4 },
  { name: '_receive_return_intent_impl_20260812', source: RETURNS_SOURCE, sourceHeader: 'CREATE OR REPLACE FUNCTION public.receive_return(', pre: 'c43084461f30b9305bd0bb19f6605d89', hunks: 5 },
  { name: '_issue_return_credit_intent_impl_20260812', source: RETURNS_SOURCE, sourceHeader: 'CREATE OR REPLACE FUNCTION public.issue_return_credit(', pre: '1e9647da071aa1a53f3add5e38515da8', hunks: 5 },
  { name: 'guard_invoice_terminal_order', source: LINEAGE_SOURCE, sourceHeader: 'CREATE OR REPLACE FUNCTION public.guard_invoice_terminal_order()', pre: '3ce8e2202d902ed90ba3370dfc829e47', hunks: 2 },
  { name: 'guard_mono_invoice_split_billing_post', source: MONO_SOURCE, sourceHeader: 'CREATE OR REPLACE FUNCTION public.guard_mono_invoice_split_billing_post()', pre: 'e643f573e529a7117c10ff1e8b89fad0', hunks: 1 },
  { name: '_create_split_invoices_from_order_provenance_impl_20260719', source: SPLIT_SOURCE, sourceHeader: 'CREATE OR REPLACE FUNCTION public._create_split_invoices_from_order_provenance_impl_20260719(', pre: 'f671f1a3f5406cff52aedd8a5fb40b31', hunks: 2 },
];

describe('20261021155000 split-payer return credit', () => {
  for (const fn of FUNCTIONS) {
    it(`${fn.name}: the predecessor matches its pin and every change is a marked hunk`, () => {
      const before = body(fn.source, fn.sourceHeader);
      expect(md5(before)).toBe(fn.pre);
      const after = body(MIGRATION, `CREATE OR REPLACE FUNCTION public.${fn.name}(`);
      const hunks = changedHunks(before, after);
      expect(hunks).toHaveLength(fn.hunks);
      for (const hunk of hunks) {
        expect(hunk.some((line) => line.startsWith('+') && line.includes('Split-payer return')), hunk.join('\n')).toBe(true);
      }
      // The preflight pins the predecessor; the postflight pins this body.
      const preflight = MIGRATION.split('$preflight$')[1];
      const postflight = MIGRATION.split('$postflight$')[1];
      expect(preflight).toContain(`'${fn.pre}'`);
      expect(postflight).toContain(`'${md5(after)}'`);
    });
  }

  it('keeps every refusal of the old return path and the old guard', () => {
    const create = body(MIGRATION, 'CREATE OR REPLACE FUNCTION public._create_return_intent_impl_20260812(');
    expect(create).toContain("RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS_DELIVERED'");
    expect(create).toContain("THEN RAISE EXCEPTION 'RETURN_ORDER_CUSTOMER_MISMATCH'");
    const guard = body(MIGRATION, 'CREATE OR REPLACE FUNCTION public.guard_invoice_terminal_order()');
    expect(guard).toContain("RAISE EXCEPTION 'INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID: invoice and order customer must match'");
    // The credit-memo exception reads only the private claim and the return's own link.
    expect(guard).toContain('FROM public.return_credit_customer_claims claim');
    expect(guard).toContain('AND claim.customer_id = NEW.customer_id');
    expect(guard).toContain('WHERE r.credit_invoice_id = NEW.id');
  });

  it('keeps the claims table and the share helpers out of reach of every Data API role', () => {
    expect(MIGRATION).toContain('ALTER TABLE public.return_credit_customer_claims ENABLE ROW LEVEL SECURITY;');
    expect(MIGRATION).toMatch(/CREATE POLICY return_credit_customer_claims_deny_all\s+ON public\.return_credit_customer_claims\s+FOR ALL TO PUBLIC\s+USING \(false\)\s+WITH CHECK \(false\);/);
    expect(MIGRATION).toContain('REVOKE ALL ON TABLE public.return_credit_customer_claims FROM PUBLIC, anon, authenticated, service_role;');
    expect(MIGRATION).toContain('REVOKE ALL ON FUNCTION public._return_customer_is_split_payer(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;');
    expect(MIGRATION).toContain('REVOKE ALL ON FUNCTION public._return_customer_line_share(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;');
    // The only grants are the two read-only lookups for the Returns screen, never to anon.
    expect(MIGRATION.match(/^GRANT .*$/gm)).toEqual([
      'GRANT EXECUTE ON FUNCTION public.get_split_payer_return_orders(uuid) TO authenticated, service_role;',
      'GRANT EXECUTE ON FUNCTION public.get_return_line_allowances(uuid, uuid) TO authenticated, service_role;',
    ]);
    for (const lookup of ['get_split_payer_return_orders', 'get_return_line_allowances']) {
      const at = MIGRATION.indexOf(`CREATE FUNCTION public.${lookup}(`);
      const fn = MIGRATION.slice(at, MIGRATION.indexOf('$function$;', at));
      expect(fn).toContain('STABLE');
      expect(fn).toContain('SECURITY DEFINER');
      expect(fn).toContain("role IN ('admin', 'sales_rep')");
      expect(fn).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    }
    // Both helpers are plain STABLE functions with a fixed search_path; neither is SECURITY DEFINER.
    for (const helper of ['_return_customer_is_split_payer', '_return_customer_line_share']) {
      const at = MIGRATION.indexOf(`CREATE FUNCTION public.${helper}(`);
      const header = MIGRATION.slice(at, MIGRATION.indexOf('$function$', at));
      expect(header).toContain('STABLE');
      expect(header).toContain('SET search_path = public, pg_temp');
      expect(header).not.toContain('SECURITY DEFINER');
    }
  });

  it('prices a split share in exact numeric cents, with no floating point', () => {
    expect(MIGRATION).not.toMatch(/::(float|double precision|real)\b/i);
    // What is left of the payer's billed cents for the cumulative quantity, never below zero.
    expect(MIGRATION).toContain('round(v_share.billed_cents * (v_share.other_returned_qty + v_qty) / v_share.billed_qty)::bigint\n        - v_share.other_returned_cents);');
  });

  it('refuses a stored split price that no longer matches, at receipt and at credit (Codex App P2 on #1010)', () => {
    // An earlier return cancelled after a later one was priced leaves the later price stale; the
    // re-check reprices with create_return's own formula and refuses on any difference.
    for (const fn of ['_receive_return_intent_impl_20260812', '_issue_return_credit_intent_impl_20260812']) {
      const fnBody = body(MIGRATION, `CREATE OR REPLACE FUNCTION public.${fn}(`);
      expect(fnBody).toContain("THEN RAISE EXCEPTION 'RETURN_SPLIT_SHARE_REPRICED'; END IF;");
      expect(fnBody).toMatch(/ri\.extended_cents IS DISTINCT FROM greatest\(0,\s+round\(s\.billed_cents \* \(s\.other_returned_qty \+ ri\.quantity\) \/ NULLIF\(s\.billed_qty, 0\)\)::bigint\s+- s\.other_returned_cents\)/);
      // Under the per-order-line credit locks.
      expect(fnBody.indexOf('RETURN_SPLIT_SHARE_REPRICED')).toBeGreaterThan(fnBody.indexOf('pg_advisory_xact_lock(hashtextextended(v_lock_order_item_id::text, 361))'));
    }
  });

  it('bills a split line with no unit as ea, so its return can be credited, and refuses a unit mismatch up front (Sol on #1010)', () => {
    const split = body(MIGRATION, 'CREATE OR REPLACE FUNCTION public._create_split_invoices_from_order_provenance_impl_20260719(');
    expect(split).toContain("COALESCE(v_item.unit_size, 'ea'));");
    expect(split).not.toContain('v_item.cust_acres, v_item.unit_size);');
    // The billing split is frozen before Pass 1 reads it field by field (Codex App P1): the
    // allocated fields' rows first, then the defaults table, the same order save_field writes them.
    const freeze = split.indexOf('LOCK TABLE public.field_billing_defaults IN SHARE MODE;');
    expect(freeze).toBeGreaterThan(split.indexOf('    FOR SHARE;'));
    expect(freeze).toBeLessThan(split.indexOf('-- PASS 1: compute every'));
    const create = body(MIGRATION, 'CREATE OR REPLACE FUNCTION public._create_return_intent_impl_20260812(');
    const unitCheck = create.indexOf("THEN RAISE EXCEPTION 'RETURN_CREDIT_UNIT_MISMATCH'");
    expect(unitCheck).toBeGreaterThan(create.indexOf('IF v_share.share_mode THEN'));
    expect(unitCheck).toBeLessThan(create.indexOf("RAISE EXCEPTION 'RETURN_SPLIT_SHARE_NOT_BILLED'"));
    expect(create).toContain("AND ii.unit_size IS DISTINCT FROM coalesce(v_order_item.unit_size, 'ea')");
  });

  it('stores the split payer\'s billed rate as the return unit price, and re-checks it (Codex App P2 on #1010)', () => {
    const create = body(MIGRATION, 'CREATE OR REPLACE FUNCTION public._create_return_intent_impl_20260812(');
    // Only a caller who may read every active invoice billing the returner may store it (Codex App P1).
    expect(create).toContain("THEN RAISE EXCEPTION 'RETURN_SPLIT_INVOICE_NOT_VISIBLE'");
    expect(create.indexOf('RETURN_SPLIT_INVOICE_NOT_VISIBLE')).toBeLessThan(create.indexOf('v_unit_price := round(v_share.billed_cents'));
    expect(create).toContain('v_unit_price := round(v_share.billed_cents / v_share.billed_qty)::bigint;');
    expect(create).toContain('v_unit_price,  -- Split-payer return (20261021155000): priced above');
    for (const fn of ['_receive_return_intent_impl_20260812', '_issue_return_credit_intent_impl_20260812']) {
      const fnBody = body(MIGRATION, `CREATE OR REPLACE FUNCTION public.${fn}(`);
      expect(fnBody).toContain('OR ri.unit_price_cents IS DISTINCT FROM round(s.billed_cents / NULLIF(s.billed_qty, 0))::bigint');
      expect(fnBody).toContain('AND (ri.unit_price_cents IS DISTINCT FROM round(oi.price_per_unit * 100)::bigint');
    }
  });

  it('quotes what is left of a split share, not a per-unit average (Codex App P2 on #1010)', () => {
    const at = MIGRATION.indexOf('CREATE FUNCTION public.get_return_line_allowances(');
    const fn = MIGRATION.slice(at, MIGRATION.indexOf('$function$;', at));
    expect(fn).toContain('RETURNS TABLE (order_item_id uuid, share_mode boolean, returnable_qty numeric, share_left_qty numeric, share_left_cents bigint)');
    expect(fn).toContain('CASE WHEN s.share_mode THEN greatest(0, s.billed_cents - s.other_returned_cents)::bigint END');
    expect(fn).not.toContain('unit_credit_cents');
  });

  it('is registered as a container-only chain with its prover', () => {
    const specs = JSON.parse(read('scripts/smoke/smoke-specs.json')).specs as Record<string, {
      chain: string; container_only?: boolean; container_prover?: string; covers: string[];
    }>;
    const spec = specs.split_payer_return_credit;
    expect(spec.chain).toBe('smoke-split-payer-return-credit.sql');
    expect(spec.container_only).toBe(true);
    expect(spec.container_prover).toBe('prove-split-payer-return-credit-real-schema.mjs');
    expect(spec.covers).toEqual(expect.arrayContaining(['create_return', 'receive_return', 'issue_return_credit', 'guard_invoice_terminal_order']));
    const chain = read('scripts/smoke/smoke-split-payer-return-credit.sql');
    expect(chain).toContain("RAISE EXCEPTION 'SMOKE_FAIL: a split payer''s return was refused: %', v_err;");
    expect(chain).toContain("RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';");
  });
});
