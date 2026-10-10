// HARD guard, run on every PR (review round 1 of 20261009120000_invoicing_admin_only: the
// migration's postflight sweep only runs when that file is applied, so on its own it cannot stop
// a LATER migration from adding an unguarded invoice writer).
//
// Mason 2026-10-09: invoicing is admin-only. This test applies the postflight's rule to every
// migration from 20261009120000 on: a public function or procedure such a file creates must call
// public._require_invoicing_admin() FIRST (a DECLARE section before it may only declare: no
// initializer, no call) when its body, comments stripped,
//   - INSERTs, UPDATEs, DELETEs, MERGEs or TRUNCATEs an invoice table (ONLY and quotes included),
//   - calls a frozen _<name>_pre_admin_only_20261009 implementation,
//   - calls a pre-existing function that reaches an invoice write unguarded (REACH below), or
//   - calls another function created in these files that does any of the above,
// unless that function is internal (EXECUTE revoked from authenticated in these files and never
// re-granted, or a pre-existing internal function that is never granted) or it is on the
// reviewed allowlist below, which pins its exact body: a re-emitted body must be re-reviewed.
// Like the postflight it is a regex over the SQL text, not a parser: dynamic SQL (EXECUTE) and
// writes from other schemas are outside it.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationsDir = join(repoRoot, 'supabase', 'migrations');
const FIRST_GUARDED_MIGRATION = '20261009120000';
const md5 = (text: string) => createHash('md5').update(text, 'utf8').digest('hex');

const INVOICE_TABLES = ['invoices', 'invoice_items', 'invoice_shares', 'invoice_line_shares', 'invoice_line_share_snapshots',
  'invoice_line_allocations', 'field_app_locations', 'field_app_location_shares', 'field_app_billing_sets',
  'field_app_billing_lines', 'write_offs'];
const WRITES = new RegExp(`\\b(insert\\s+into|update|delete\\s+from|merge\\s+into|truncate(\\s+table)?)\\s+(only\\s+)?("?public"?\\s*\\.\\s*)?"?(${INVOICE_TABLES.join('|')})("|\\b)`, 'i');
const FROZEN_CALL = /\b_\w+_pre_admin_only_20261009\s*\(/;
// The postflight's guard-first rules, character for character in meaning.
const GUARD_FIRST = /^\s*(DECLARE(\s+(?![Bb][Ee][Gg][Ii][Nn]\b)\w+\s+[\w[\]. %]+;)*\s+)?BEGIN\s+PERFORM public\._require_invoicing_admin\(\);/;
const SPLIT_KEY_THEN_GUARD = /^\s*BEGIN\s+IF p_idempotency_key IS NULL OR p_idempotency_key !~ '\[\^\[:space:\]\]' THEN\s+RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order'\s+USING ERRCODE = '22023';\s+END IF;\s+PERFORM public\._require_invoicing_admin\(\);/;

// Every public function that reaches an invoice write without the guard, read from the container
// replay of live with 20261009120000 applied (2026-10-09; the postflight's writer and edge rules,
// guarded wrappers excluded). EXPOSED ones authenticated can execute; INTERNAL ones it cannot.
const REACH_EXPOSED = [
  'allocate_payment', 'apply_remaining_prepayments', 'apply_write_off', 'batch_cancel_deliveries',
  'cancel_delivery', 'cancel_order', 'complete_delivery', 'create_invoice_for_unbilled_delivery',
  'create_quick_delivery', 'delete_invoices', 'generate_finance_charges', 'issue_return_credit',
  'price_order', 'process_offline_action', 'unapply_credit_memo', 'update_order_items',
  'void_delivery', 'void_invoice', 'void_invoice_group', 'void_order',
  'void_payment',
];
const REACH_INTERNAL = [
  '_apply_credit_memo_to_invoice_pre_admin_only_20261009', '_apply_prepay_to_invoice_pre_admin_only_20261009', '_batch_apply_all_prepayments_pre_admin_only_20261009', '_batch_void_invoices_pre_admin_only_20261009',
  '_cancel_order_idem_impl_20260721', '_cancel_order_impl_20260714', '_cancel_order_provenance_wrapper_20260719', '_cancel_order_split_provenance_impl_20260719',
  '_complete_delivery_aggregate_impl', '_complete_delivery_authorized_impl', '_complete_delivery_period_preflight_impl', '_consolidate_draft_invoices_pre_admin_only_20261009',
  '_create_invoice_for_unbilled_delivery_idem_impl_20260721', '_create_invoice_for_unbilled_delivery_impl_20260718', '_create_invoice_from_blend_ticket_pre_admin_only_20261009', '_create_invoice_from_order_idem_impl_20260721',
  '_create_invoice_from_order_impl_20260718', '_create_invoice_from_order_pre_admin_only_20261009', '_create_quick_delivery_intent_impl_20260802', '_create_quick_delivery_pre_admin_only_20261009',
  '_create_split_invoices_from_order_pre_admin_only_20261009', '_create_split_invoices_from_order_provenance_impl_20260719', '_delete_invoices_split_provenance_impl_20260719', '_generate_finance_charges_idem_impl_20260721',
  '_issue_return_credit_header_only_impl_20260825', '_issue_return_credit_impl', '_issue_return_credit_intent_impl_20260812', '_post_deleted_delivery_recovery_invoice_20260719',
  '_post_invoice_customer_scope_impl', '_post_invoice_group_customer_scope_impl', '_post_invoice_group_pre_admin_only_20261009', '_post_invoice_idem_impl_20260721',
  '_post_invoice_impl_20260714', '_post_invoice_pre_admin_only_20261009', '_post_invoice_public_impl_20260718', '_price_order_below_cost_impl_20260810',
  '_reverse_credit_memo_application', '_reverse_credit_memo_application_pre_admin_only_20261009', '_reverse_credit_memo_application_status_impl_20260812', '_reverse_write_off_pre_admin_only_20261009',
  '_save_field_app_invoice_impl_20260714', '_save_field_app_invoice_pre_admin_only_20261009', '_save_field_app_split_invoice_impl', '_save_field_app_split_invoice_pre_admin_only_20261009',
  '_save_invoice_below_cost_impl_20260810', '_save_invoice_governed_split_guard_impl_20260720', '_save_invoice_intent_impl_20260802', '_save_invoice_lineage_unaware_impl_20260827',
  '_save_invoice_pre_admin_only_20261009', '_save_invoice_scoped_impl', '_save_invoice_split_provenance_impl_20260719', '_transfer_invoice_to_job_pre_admin_only_20261009',
  '_transfer_job_to_invoice_intent_impl_20260908', '_transfer_job_to_invoice_pre_admin_only_20261009', '_unapply_return_credit_guard_impl_20260826', '_unpost_invoice_pre_admin_only_20261009',
  '_update_field_app_applied_info_pre_admin_only_20261009', '_update_field_app_invoice_billing_pre_admin_only_20261009', '_update_order_items_below_cost_impl_20260810', '_update_order_items_impl',
  '_void_invoice_group_guard_impl_20260720', '_void_invoice_return_credit_guard_impl_20260826', '_void_invoice_split_provenance_impl_20260719', '_void_order_impl_20260714',
  'mark_overdue_invoices', 'snapshot_invoice_line_shares_on_post',
];

// Reviewed exceptions: exposed, reach an invoice write, deliberately not guarded. Each pins the
// md5 of its LF-normalized body, so any re-emission needs a new review here.
const ALLOWLIST: Record<string, { md5: string; reason: string }> = {
  create_quick_delivery: {
    md5: '1bf67e10cae538b5090b067aa3f665f5',
    reason: '20261009120000 1e: coerces p_skip_invoice = true for a non-admin instead of refusing; the frozen body then creates no invoice',
  },
};

type Fn = { name: string; file: string; body: string; code: string; replace: boolean };
type Violation = { name: string; file: string; why: string };

/** Comments removed left to right (a block comment inside a line comment and vice versa). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, '');
}

function functionsIn(file: string, sql: string): { fns: Fn[]; unparsed: string[] } {
  const fns: Fn[] = [];
  const unparsed: string[] = [];
  const head = /CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\s+(?:"?(\w+)"?\s*\.\s*)?"?(\w+)"?\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = head.exec(sql))) {
    if (m[3] && m[3].toLowerCase() !== 'public') continue;
    const name = m[4];
    const rest = sql.slice(m.index);
    const tag = /\bAS\s+(\$\w*\$)/i.exec(rest);
    const stop = rest.indexOf(';');
    if (!tag || (stop >= 0 && stop < tag.index)) { unparsed.push(name); continue; }
    const bodyStart = tag.index + tag[0].length;
    const bodyEnd = rest.indexOf(tag[1], bodyStart);
    if (bodyEnd < 0) { unparsed.push(name); continue; }
    const body = rest.slice(bodyStart, bodyEnd);
    fns.push({ name, file, body, code: stripComments(body), replace: Boolean(m[1]) });
    head.lastIndex = m.index + bodyEnd + tag[1].length;
  }
  return { fns, unparsed };
}

/** The rule over an ordered list of migration texts. Returns every violation. */
function scan(files: Array<{ file: string; sql: string }>, allowlist: typeof ALLOWLIST = ALLOWLIST): Violation[] {
  const violations: Violation[] = [];
  const latest = new Map<string, Fn>();
  const revoked = new Map<string, boolean>();
  for (const { file, sql: raw } of files) {
    const sql = raw.replace(/\r\n/g, '\n');
    const top = stripComments(sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '<body>'));
    if (/GRANT\s+[^;]*\bON\s+ALL\s+(FUNCTIONS|ROUTINES)\s+IN\s+SCHEMA\s+public\b[^;]*\bauthenticated\b/i.test(top)) {
      violations.push({ name: '*', file, why: 'blanket EXECUTE grant on every public function to authenticated' });
    }
    const { fns, unparsed } = functionsIn(file, sql);
    for (const name of unparsed) violations.push({ name, file, why: 'body could not be parsed (use a dollar-quoted body)' });
    // A plain CREATE starts from the default privileges (authenticated can execute); CREATE OR
    // REPLACE keeps whatever ACL the function already had.
    for (const f of fns) { latest.set(f.name, f); if (!f.replace) revoked.delete(f.name); }
    // Statement order inside one file does not matter here: a REVOKE from authenticated in the
    // same or a later file marks the name internal; a later GRANT to authenticated re-exposes it.
    for (const s of top.split(';')) {
      const rv = /REVOKE\s+[^;]*\bON\s+(FUNCTION|PROCEDURE|ROUTINE)\s+(?:public\s*\.\s*)?"?(\w+)"?\s*\([^;]*\bFROM\b([^;]*)/i.exec(s);
      if (rv && /\bauthenticated\b/i.test(rv[3])) revoked.set(rv[2], true);
      const gr = /GRANT\s+[^;]*\bON\s+(FUNCTION|PROCEDURE|ROUTINE)\s+(?:public\s*\.\s*)?"?(\w+)"?\s*\([^;]*\bTO\b([^;]*)/i.exec(s);
      if (gr && /\b(authenticated|PUBLIC)\b/i.test(gr[3])) revoked.set(gr[2], false);
    }
  }
  const reachExposed = new Set(REACH_EXPOSED);
  const reachInternal = new Set(REACH_INTERNAL);
  const guarded = (f: Fn) => GUARD_FIRST.test(f.body) || (f.name === 'create_split_invoices_from_order' && SPLIT_KEY_THEN_GUARD.test(f.body));
  const calls = (code: string, name: string) => new RegExp(`\\b${name}\\s*\\(`).test(code);
  // Writers among the scanned functions (to a fixed point): direct writes, frozen calls, calls to
  // a pre-existing unguarded reacher, or calls to another scanned writer that is not guarded.
  const writer = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of latest.values()) {
      if (writer.has(f.name)) continue;
      const reaches = WRITES.test(f.code) || FROZEN_CALL.test(f.code)
        || [...reachExposed, ...reachInternal].some((n) => n !== f.name && !latest.has(n) && calls(f.code, n))
        || [...writer].some((n) => n !== f.name && !guarded(latest.get(n) as Fn) && calls(f.code, n));
      if (reaches) { writer.add(f.name); grew = true; }
    }
  }
  for (const f of latest.values()) {
    if (!writer.has(f.name) || guarded(f)) continue;
    const internal = revoked.get(f.name) === true || (revoked.get(f.name) === undefined && f.replace && reachInternal.has(f.name));
    if (internal) continue;
    const allowed = allowlist[f.name];
    if (allowed && md5(f.body) === allowed.md5) continue;
    violations.push({ name: f.name, file: f.file, why: allowed ? `allowlisted body changed (md5 ${md5(f.body)}): re-review it` : 'reaches an invoice write without calling _require_invoicing_admin() first' });
  }
  return violations;
}

const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql') && f.slice(0, 14) >= FIRST_GUARDED_MIGRATION).sort();

describe('invoice writers stay admin-only after 20261009120000 (CI companion of its postflight sweep)', () => {
  it('scans 20261009120000 and every later migration', () => {
    expect(migrationFiles[0]).toBe('20261009120000_invoicing_admin_only.sql');
  });

  it('finds no unguarded invoice writer in any migration from 20261009120000 on', () => {
    const files = migrationFiles.map((file) => ({ file, sql: readFileSync(join(migrationsDir, file), 'utf8') }));
    expect(scan(files)).toEqual([]);
    // Not vacuous: without the allowlist the scan flags exactly the allowlisted functions.
    expect(scan(files, {}).map((v) => v.name).sort()).toEqual(Object.keys(ALLOWLIST).sort());
  });

  describe('the rule itself (each must fail when it should)', () => {
    const base = readFileSync(join(migrationsDir, '20261009120000_invoicing_admin_only.sql'), 'utf8');
    const withNext = (sql: string) => scan([{ file: '20261009120000_invoicing_admin_only.sql', sql: base }, { file: '29990101000000_probe.sql', sql }]);
    const fn = (name: string, body: string, extra = '') => `CREATE OR REPLACE FUNCTION public.${name}(p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$${body}$f$;\n${extra}`;
    const names = (v: Violation[]) => v.map((x) => x.name);

    it('accepts the guard first, and an internal (revoked) writer', () => {
      expect(withNext(fn('probe_ok', '\nBEGIN\n  PERFORM public._require_invoicing_admin();\n  DELETE FROM public.invoice_items WHERE invoice_id = p;\nEND;\n'))).toEqual([]);
      expect(withNext(fn('_probe_impl', '\nBEGIN\n  UPDATE public.invoices SET header_notes = NULL WHERE id = p;\nEND;\n',
        'REVOKE ALL ON FUNCTION public._probe_impl(uuid) FROM PUBLIC, anon, authenticated, service_role;'))).toEqual([]);
    });
    it('flags a direct write without the guard, in every spelling', () => {
      for (const write of ['DELETE FROM public.invoice_items WHERE invoice_id = p', 'UPDATE ONLY "public"."invoices" SET header_notes = NULL',
        'INSERT INTO field_app_locations (invoice_id, field_id) VALUES (p, p)', 'TRUNCATE TABLE public.write_offs',
        'MERGE INTO invoice_shares s USING (SELECT 1) x ON false WHEN NOT MATCHED THEN DO NOTHING']) {
        expect(names(withNext(fn('probe_writer', `\nBEGIN\n  ${write};\nEND;\n`))), write).toEqual(['probe_writer']);
      }
    });
    it('flags a guard that runs after the write, or after a DECLARE initializer', () => {
      expect(names(withNext(fn('probe_late', '\nBEGIN\n  DELETE FROM public.invoices WHERE id = p;\n  PERFORM public._require_invoicing_admin();\nEND;\n')))).toEqual(['probe_late']);
      expect(names(withNext(fn('probe_decl', "\nDECLARE\n  v uuid := public._save_invoice_pre_admin_only_20261009('{}'::jsonb, '[]'::jsonb, 'k');\nBEGIN\n  PERFORM public._require_invoicing_admin();\nEND;\n")))).toEqual(['probe_decl']);
      expect(names(withNext(fn('probe_nested', '\nDECLARE\n  v int;\nBEGIN\n  DELETE FROM public.invoices WHERE id = p;\n  BEGIN\n  PERFORM public._require_invoicing_admin();\n  END;\nEND;\n')))).toEqual(['probe_nested']);
    });
    it('flags a call to a frozen implementation, a pre-existing unguarded reacher, or a new internal writer', () => {
      expect(names(withNext(fn('probe_frozen', "\nBEGIN\n  PERFORM public._post_invoice_pre_admin_only_20261009(p, 'k');\nEND;\n")))).toEqual(['probe_frozen']);
      expect(names(withNext(fn('probe_impl_call', "\nBEGIN\n  PERFORM public._post_invoice_public_impl_20260718(p, NULL);\nEND;\n")))).toEqual(['probe_impl_call']);
      const internal = fn('_probe_impl2', '\nBEGIN\n  UPDATE public.invoices SET header_notes = NULL WHERE id = p;\nEND;\n',
        'REVOKE ALL ON FUNCTION public._probe_impl2(uuid) FROM PUBLIC, anon, authenticated, service_role;');
      expect(names(withNext(`${internal}\n${fn('probe_caller', '\nBEGIN\n  PERFORM public._probe_impl2(p);\nEND;\n')}`))).toEqual(['probe_caller']);
      // Calling a guarded public wrapper is fine.
      expect(withNext(fn('probe_wrapper_call', "\nBEGIN\n  PERFORM public.post_invoice(p, 'k');\nEND;\n"))).toEqual([]);
    });
    it('does not let a comment hide a write, and re-exposes a writer granted back to authenticated', () => {
      expect(names(withNext(fn('probe_comment', '\nBEGIN\n  -- a note /* that never closes\n  DELETE FROM public.invoices WHERE id = p;\n  /* x */\nEND;\n')))).toEqual(['probe_comment']);
      expect(names(withNext(fn('_probe_regrant', '\nBEGIN\n  UPDATE public.invoices SET header_notes = NULL WHERE id = p;\nEND;\n',
        'REVOKE ALL ON FUNCTION public._probe_regrant(uuid) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public._probe_regrant(uuid) TO authenticated;')))).toEqual(['_probe_regrant']);
    });
    it('re-flags an allowlisted function whose body changes, and a blanket grant', () => {
      const changed = 'CREATE OR REPLACE FUNCTION public.create_quick_delivery(p uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$\nBEGIN\n  RETURN public._create_quick_delivery_pre_admin_only_20261009(p);\nEND;\n$function$;';
      expect(names(withNext(changed))).toEqual(['create_quick_delivery']);
      expect(names(withNext('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;'))).toEqual(['*']);
      // An upkeep function re-emitted later (here price_order, unguarded) needs its own review.
      expect(names(withNext(fn('price_order', '\nBEGIN\n  UPDATE public.invoice_items SET quantity = 1 WHERE invoice_id = p;\nEND;\n')))).toEqual(['price_order']);
    });
  });
});
