// Static shape checks for 20261009120000_invoicing_admin_only (Mason 2026-10-09: invoicing is
// admin-only; sales reps read every invoice; posting can bind to the reviewed version).
// Supporting evidence only: the real proof is
// scripts/smoke/prove-invoicing-admin-only-real-schema.mjs, which applies the file to the replayed
// production schema and runs every path as real users.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationsDir = join(repoRoot, 'supabase', 'migrations');
const rawSql = readFileSync(join(migrationsDir, '20261009120000_invoicing_admin_only.sql'), 'utf8');
const sql = rawSql.replace(/\r\n/g, '\n');
const read = (file: string) => readFileSync(join(repoRoot, file), 'utf8').replace(/\r\n/g, '\n');
const md5 = (text: string) => createHash('md5').update(text, 'utf8').digest('hex');

// The wrapped RPCs: identity signature, pg_get_function_arguments and result read live
// 2026-10-09, and md5(replace(prosrc, chr(13), '')) of the live body that is renamed away.
const WRAPPED: Array<{ name: string; ident: string; ret: string; md5: string; shape: 'guard' | 'key_then_guard' | 'coerce'; version?: boolean }> = [
  { name: 'save_invoice', ident: 'jsonb,jsonb,text', ret: 'uuid', md5: 'cb932dc51a680442affde5aeba2eaee3', shape: 'guard' },
  { name: 'save_field_app_invoice', ident: 'uuid,jsonb,jsonb,jsonb,uuid,uuid,text', ret: 'jsonb', md5: '8700762576625bd06a833845d57ddbb6', shape: 'guard' },
  { name: 'save_field_app_split_invoice', ident: 'uuid,uuid,jsonb,jsonb,jsonb,uuid,uuid,text', ret: 'jsonb', md5: '82003fe2895aa1d7c7810559f4fb771a', shape: 'guard' },
  { name: 'create_invoice_from_order', ident: 'uuid,uuid,text,text', ret: 'uuid', md5: 'a1a91643bd8866823ae359f7e0ec290e', shape: 'guard' },
  { name: 'create_split_invoices_from_order', ident: 'uuid,uuid,text,text', ret: 'uuid[]', md5: '398030fbb64006b4750e7e89a61b6cb9', shape: 'key_then_guard' },
  { name: 'create_invoice_from_blend_ticket', ident: 'uuid,uuid,text', ret: 'jsonb', md5: 'c520a7301f88f3e96ed7bbc33101c4ef', shape: 'guard' },
  { name: 'transfer_job_to_invoice', ident: 'uuid,uuid,text', ret: 'jsonb', md5: 'b083dd371b091d7b70bb4cdc015c9bc8', shape: 'guard' },
  { name: 'transfer_invoice_to_job', ident: 'uuid,uuid,text', ret: 'jsonb', md5: '7394bd0343c19e98bf746576a56bf6e4', shape: 'guard' },
  { name: 'consolidate_draft_invoices', ident: 'uuid,uuid,text', ret: 'jsonb', md5: '0c8394691ef461ba780fd4ba0e770c51', shape: 'guard' },
  { name: 'update_field_app_applied_info', ident: 'uuid[],text,text,text,uuid,text,numeric,numeric,text,numeric,time without time zone,text,numeric,numeric,text,numeric,time without time zone,text,boolean,boolean,numeric,boolean', ret: 'jsonb', md5: 'e6d5f41411e96cd4453d2209c846645d', shape: 'guard' },
  { name: 'update_field_app_invoice_billing', ident: 'uuid[],text,text,text,date,text,text,jsonb,uuid,text', ret: 'jsonb', md5: '34695e4be9724bf46dc5e962f8f0e478', shape: 'guard' },
  { name: 'post_invoice', ident: 'uuid,text', ret: 'void', md5: '6a5e3ab75bc63936f23eab85383ff6ad', shape: 'guard', version: true },
  { name: 'post_invoice_group', ident: 'uuid,uuid,text', ret: 'jsonb', md5: 'd9e36f0dfb055e3cc68c18793e70dbfc', shape: 'guard', version: true },
  { name: 'batch_post_invoices', ident: 'uuid[],text', ret: 'jsonb', md5: '482bd8cd15728ffc51f83900eaf89b3c', shape: 'guard', version: true },
  { name: 'unpost_invoice', ident: 'uuid,uuid,text', ret: 'jsonb', md5: '161f18c3ccd6126a6fb683c5160f82dc', shape: 'guard' },
  { name: 'unpost_invoice_group', ident: 'uuid,uuid,text', ret: 'jsonb', md5: 'dc476e07621c4c7dc86595442ed1a9f0', shape: 'guard' },
  { name: 'batch_void_invoices', ident: 'uuid[],text,uuid,text', ret: 'integer', md5: '32fa9718f29e18c8eff4539e36ac84b3', shape: 'guard' },
  { name: 'apply_credit_memo_to_invoice', ident: 'uuid,uuid,bigint,uuid,text', ret: 'uuid', md5: 'bcc242c8715aaed81b9455fbc905237f', shape: 'guard' },
  { name: 'reverse_credit_memo_application', ident: 'uuid,text,uuid,text', ret: 'jsonb', md5: '38cea043fc7dae4e65bc8593c95bddfb', shape: 'guard' },
  { name: 'apply_prepay_to_invoice', ident: 'uuid,uuid,bigint,uuid,text', ret: 'uuid', md5: 'c9377dab8f2534a03af2c27a6e1d510c', shape: 'guard' },
  { name: 'batch_apply_all_prepayments', ident: 'uuid,text', ret: 'jsonb', md5: '1d76228210c474da37c9a3cd91b97b7d', shape: 'guard' },
  // Review round 1: its own role test lets a caller with no active profile through.
  { name: 'reverse_write_off', ident: 'uuid,text,uuid,text', ret: 'jsonb', md5: '70ef11ccad193eb6ef5ee88dcba6f8cd', shape: 'guard' },
  { name: 'create_quick_delivery', ident: 'uuid,jsonb,uuid,date,text,uuid,text,boolean', ret: 'jsonb', md5: '69c1d569fb2e9eb913502d59e41a76fe', shape: 'coerce' },
];
const GUARD = 'PERFORM public._require_invoicing_admin();';

/** The single `CREATE [OR REPLACE] FUNCTION public.<name>(... $function$;` statement. */
function statement(source: string, head: string): string {
  const start = source.indexOf(head);
  expect(start, `${head} must be defined`).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(head, start + 1), `${head} must be defined once`).toBe(-1);
  const end = source.indexOf('$function$;', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + '$function$;'.length);
}
function body(stmt: string): string {
  return stmt.slice(stmt.indexOf('$function$') + '$function$'.length, stmt.lastIndexOf('$function$'));
}
/** The dollar-quoted body of the first `FUNCTION <name>(` definition in a migration file. */
function priorBody(file: string, head: string): string {
  const src = read(file);
  const start = src.indexOf(head);
  expect(start, `${head} in ${file}`).toBeGreaterThanOrEqual(0);
  const tag = /AS\s+(\$[A-Za-z_]*\$)/.exec(src.slice(start));
  expect(tag).not.toBeNull();
  const bodyStart = start + (tag?.index ?? 0) + (tag?.[0].length ?? 0);
  return src.slice(bodyStart, src.indexOf(tag?.[1] ?? '', bodyStart));
}
/** SQL with function bodies and DO blocks removed: only the file's own top-level statements. */
function topLevel(source: string): string {
  return source.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, '<body>').split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
}

describe('invoicing admin-only migration (20261009120000)', () => {
  it('is authored with LF line endings and says it is not applied', () => {
    expect(rawSql.includes('\r')).toBe(false);
    expect(sql.slice(0, 200)).toContain('STATUS: NOT APPLIED');
  });

  it('runs as one transaction, after PR #889, and reloads PostgREST', () => {
    expect(sql).toContain('CREATE TEMP TABLE crx_invoicing_admin_only_tx ON COMMIT DROP');
    expect(sql).toContain('CRX_INVOICING_ADMIN_ONLY_NOT_IN_TRANSACTION');
    expect(sql).toContain('PREFLIGHT_PR889_NOT_APPLIED');
    for (const stem of ['20261007150000_record_deliveries_billed_outside_crx', '20261007150050_lock_soft_deleted_orders',
      '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man', '20261007150200_release_reservations_of_deleted_spring_orders']) {
      expect(sql).toContain(`'${stem}'`);
    }
    expect(sql.trimEnd().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true);
    expect(sql).toContain("RAISE NOTICE 'POSTFLIGHT_OK: invoicing is admin-only'");
  });

  it('changes no data rows (no top-level INSERT, UPDATE, DELETE or TRUNCATE)', () => {
    expect(topLevel(sql)).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE\s+(TABLE\s+)?public\.)/i);
  });

  it('pins every renamed RPC in the preflight: one overload, body md5, signature, result, owner and ACL', () => {
    const preflight = sql.slice(sql.indexOf('DO $preflight$'), sql.indexOf('$preflight$;'));
    for (const w of WRAPPED) {
      expect(preflight).toMatch(new RegExp(`\\('${w.name}', '${w.ident.replace(/[[\]()]/g, '\\$&')}', '[^']*(''[^']*)*', '${w.ret.replace(/[[\]]/g, '\\$&')}', '${w.md5}'\\)`));
    }
    expect(preflight).toContain("p.proname = r.name) <> 1");
    expect(preflight).toContain("pg_get_function_arguments(p.oid) = r.args");
    expect(preflight).toContain("md5(replace(p.prosrc, chr(13), '')) = r.md5");
    expect(preflight).toContain("NOT has_function_privilege('anon', p.oid, 'EXECUTE')");
  });

  it('renames each RPC to a frozen implementation closed to every API role', () => {
    for (const w of WRAPPED) {
      const impl = `_${w.name}_pre_admin_only_20261009`;
      expect(sql).toContain(`ALTER FUNCTION public.${w.name}(${w.ident}) RENAME TO ${impl};`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${impl}(${w.ident}) FROM PUBLIC, anon, authenticated, service_role;`);
    }
  });

  it('puts the guard (or the split key check, then the guard) first in every wrapper and calls the frozen body by name', () => {
    for (const w of WRAPPED) {
      const stmt = statement(sql, `CREATE FUNCTION public.${w.name}(`);
      const code = body(stmt);
      expect(stmt).toContain('SECURITY DEFINER');
      expect(stmt).toContain('SET search_path = public, pg_temp');
      expect(stmt).toContain(`RETURNS ${w.ret}\n`);
      if (w.shape === 'guard') {
        // A DECLARE section may only declare (no initializer, no call): nothing runs before the guard.
        expect(code).toMatch(/^\s*(DECLARE(\s+(?![Bb][Ee][Gg][Ii][Nn]\b)\w+\s+[\w[\]. %]+;)*\s+)?BEGIN\s+PERFORM public\._require_invoicing_admin\(\);/);
      } else if (w.shape === 'key_then_guard') {
        expect(code).toMatch(/^\s*BEGIN\s+IF p_idempotency_key IS NULL OR p_idempotency_key !~ '\[\^\[:space:\]\]' THEN\s+RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order'\s+USING ERRCODE = '22023';\s+END IF;\s+PERFORM public\._require_invoicing_admin\(\);/);
      } else {
        expect(code).not.toContain(GUARD);
        expect(code).toContain('p_skip_invoice => CASE WHEN public.is_admin() THEN p_skip_invoice ELSE true END');
      }
      const call = code.slice(code.indexOf(`public._${w.name}_pre_admin_only_20261009(`));
      const args = /^\(([\s\S]*?)\n {2}\)/.exec(call.slice(call.indexOf('(')))?.[1] ?? '';
      const passed = args.split(',').map((a) => a.trim().split(' => ')[0]);
      const declared = stmt.slice(stmt.indexOf('(') + 1, stmt.indexOf(')\n RETURNS')).split(/,\s*(?=p_)/).map((a) => a.trim().split(' ')[0])
        .filter((a) => a !== 'p_expected_version');
      expect(passed, `${w.name} must pass every argument by name`).toEqual(declared);
      if (w.version) expect(stmt).toMatch(/, p_expected_version text DEFAULT NULL::text\)\n RETURNS/);
      else expect(stmt).not.toContain('p_expected_version');
    }
  });

  it('builds the guard helper fail-closed: EXISTS on an ACTIVE admin, 42501, internal only', () => {
    const helper = body(statement(sql, 'CREATE FUNCTION public._require_invoicing_admin('));
    expect(helper).toMatch(/IF NOT EXISTS \(\s+SELECT 1\s+FROM public\.profiles\s+WHERE id = auth\.uid\(\)\s+AND role = 'admin'\s+AND is_active = true\s+\) THEN/);
    expect(helper).toContain("RAISE EXCEPTION 'INVOICING_ADMIN_ONLY: ");
    expect(helper).toContain("USING ERRCODE = '42501'");
    expect(helper).not.toMatch(/<>\s*'admin'/);
    expect(sql).toContain('REVOKE ALL ON FUNCTION public._require_invoicing_admin() FROM PUBLIC, anon, authenticated, service_role;');
  });

  it('makes every new function SECURITY DEFINER with a pinned search_path', () => {
    const heads = [...sql.matchAll(/CREATE (OR REPLACE )?FUNCTION public\.(\w+)\(/g)].map((m) => m[0]);
    expect(heads.length).toBe(WRAPPED.length + 4 + 2);
    for (const head of heads) {
      const stmt = statement(sql, head);
      expect(stmt, head).toContain(' SECURITY DEFINER\n');
      expect(stmt, head).toContain(' SET search_path = public, pg_temp');
    }
  });

  it('re-emits complete_delivery\'s implementation with only the admin-only auto-invoice hunk', () => {
    const prior = priorBody('supabase/migrations/20260827041300_align_return_credit_delivery_surfaces.sql', 'FUNCTION public._complete_delivery_authorized_impl(');
    expect(md5(prior)).toBe('f8de9f000e40f7bfd8f792012f04fee0');
    const next = body(statement(sql, 'CREATE OR REPLACE FUNCTION public._complete_delivery_authorized_impl('));
    const elsif = "      ELSIF v_actor_role = 'admin' THEN\n      v_auto_invoice_number := next_invoice_number('chemical_sale');";
    expect(next.split(elsif).length - 1).toBe(1);
    const skipStart = next.indexOf("      ELSE\n        -- Invoicing is admin-only (Mason 2026-10-09)");
    const skipEnd = next.indexOf("      END IF;\n    END IF;\n  END IF;\n\n  -- U9: short-stock WARN emit");
    expect(skipStart).toBeGreaterThan(next.indexOf(elsif));
    expect(skipEnd).toBeGreaterThan(skipStart);
    const skip = next.slice(skipStart, skipEnd);
    expect(skip).toContain("'delivery_invoice_pending_admin'");
    expect(skip).toContain("'delivery_needs_invoice', 'delivery', p_delivery_id");
    expect(skip).toContain("FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true");
    expect(skip).not.toMatch(/next_invoice_number|INSERT INTO invoices|INSERT INTO invoice_items/);
    // Undo the two hunks: what is left is byte-identical to the live body.
    const undone = (next.slice(0, skipStart) + next.slice(skipEnd))
      .replace(elsif, "      ELSE\n      v_auto_invoice_number := next_invoice_number('chemical_sale');");
    expect(undone).toBe(prior);
  });

  it('re-emits complete_job with only the admin-only auto-draft gate, its skip text and the admin notification', () => {
    const prior = priorBody('supabase/migrations/20260722012359_auto_draft_skipped_activity_row.sql', 'FUNCTION public.complete_job(');
    expect(md5(prior)).toBe('4e4c38e3e8be66e2d24c434bb54c0521');
    const next = body(statement(sql, 'CREATE OR REPLACE FUNCTION public.complete_job('));
    // Q4/Q5 (admins are notified): one notification per active admin when a non-admin's
    // completion skips the draft, exactly as the delivery path does.
    const notify = `        INSERT INTO notifications (
          user_id, title, message, notification_type,
          related_entity_type, related_entity_id
        )
        SELECT p.id,
               'Job needs an invoice',
               'Job ' || v_job.job_number || ' was completed by a non-admin. Invoicing is admin-only, so no draft invoice was created — open the job and bill it.',
               'job_needs_invoice', 'job', p_job_id
          FROM profiles p
         WHERE p.role = 'admin' AND p.is_active = true;
`;
    expect(next.split(notify).length - 1).toBe(1);
    expect(next.indexOf(notify)).toBeGreaterThan(next.indexOf("invoice skipped (invoicing is admin-only). '"));
    const undone = next
      .replace(notify, '')
      .replace('      IF is_admin() THEN\n        SELECT i.id INTO v_existing_invoice', '      IF (is_admin() OR is_sales_rep()) THEN\n        SELECT i.id INTO v_existing_invoice')
      .replace("completed by a non-admin — automatic draft '\n            || 'invoice skipped (invoicing is admin-only). '",
        "completed by an applicator — automatic draft '\n            || 'invoice skipped (auto-draft only runs for office completions). '");
    expect(undone).not.toBe(next);
    expect(undone).toBe(prior);
  });

  it('checks the posting version under the implementation\'s locks, and only for a call that will really post', () => {
    const single = body(statement(sql, 'CREATE FUNCTION public.post_invoice('));
    // Review round 1: the key lock (the one check_idempotency holds to the end of the
    // transaction) comes BEFORE the receipt lookup, so a same-key duplicate waits and replays;
    // a supplied version without a key is refused, never silently ignored.
    const order = ["RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: post_invoice'",
      "PERFORM pg_advisory_xact_lock(hashtextextended('crx:idempotency:' || p_idempotency_key, 0));",
      "v_cached := public.check_idempotency(p_idempotency_key, 'post_invoice');",
      'IF v_cached IS NULL THEN',
      'PERFORM 1 FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;',
      'IF public._invoice_review_fingerprint(ARRAY[p_invoice_id]) IS DISTINCT FROM p_expected_version THEN',
      'public._post_invoice_pre_admin_only_20261009('].map((s) => single.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(single).not.toContain("'post_invoice:'");
    const group = body(statement(sql, 'CREATE FUNCTION public.post_invoice_group('));
    expect(group.indexOf('hashtextextended(p_invoice_group_id::text, 0)')).toBeLessThan(group.indexOf('FOR UPDATE'));
    expect(group.indexOf('FOR UPDATE')).toBeLessThan(group.indexOf('_invoice_review_fingerprint(v_member_ids)'));
    const batch = body(statement(sql, 'CREATE FUNCTION public.batch_post_invoices('));
    expect(batch.indexOf("RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: batch_post_invoices'")).toBeGreaterThan(-1);
    expect(batch.indexOf("RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: batch_post_invoices'")).toBeLessThan(batch.indexOf("'crx:idempotency:batch_post_invoices:'"));
    expect(batch.indexOf("'crx:idempotency:batch_post_invoices:'")).toBeLessThan(batch.indexOf("'crx:idempotency:' || p_idempotency_key"));
    expect(batch.indexOf('FOR UPDATE')).toBeLessThan(batch.indexOf('_invoice_review_fingerprint(p_invoice_ids)'));
    for (const b of [single, group, batch]) expect(b).toContain("RAISE EXCEPTION 'INVOICE_CHANGED_SINCE_REVIEW: ");
    const fingerprint = statement(sql, 'CREATE FUNCTION public._invoice_review_fingerprint(');
    for (const table of ['invoice_items', 'invoice_line_shares', 'invoice_shares']) expect(fingerprint).toContain(`FROM public.${table} `);
    expect(fingerprint).toContain('SET "TimeZone" = \'UTC\'');
  });

  it('keeps every invoice write policy admin-only and adds sales reps to the read policies only', () => {
    for (const [table, policy] of [['invoices', 'invoices_insert'], ['invoice_items', 'invoice_items_insert'], ['invoice_shares', 'invoice_shares_insert'], ['invoice_line_allocations', 'invoice_line_alloc_insert']]) {
      expect(sql).toMatch(new RegExp(`CREATE POLICY ${policy} ON public\\.${table}\\n  FOR INSERT TO \\w+\\n  WITH CHECK \\(public\\.is_admin\\(\\)\\);`));
    }
    // Review round 1: field_app_locations / field_app_location_shares write policies were
    // is_admin() OR is_sales_rep() on ANY invoice; now admin-only (and their grants are revoked).
    for (const table of ['field_app_locations', 'field_app_location_shares']) {
      expect(sql).toContain(`CREATE POLICY ${table}_insert ON public.${table}\n  FOR INSERT TO public\n  WITH CHECK (public.is_admin());`);
      expect(sql).toContain(`CREATE POLICY ${table}_update ON public.${table}\n  FOR UPDATE TO public\n  USING (public.is_admin())\n  WITH CHECK (public.is_admin());`);
      expect(sql).toContain(`CREATE POLICY ${table}_delete ON public.${table}\n  FOR DELETE TO public\n  USING (public.is_admin());`);
    }
    const created = [...sql.matchAll(/CREATE POLICY (\w+) ON public\.(\w+)\n {2}FOR (\w+)/g)].map((m) => `${m[2]}.${m[1]}.${m[3]}`);
    expect(created.sort()).toEqual([
      'field_app_billing_lines.field_app_billing_lines_select.SELECT',
      'field_app_billing_sets.field_app_billing_sets_select.SELECT',
      'field_app_location_shares.field_app_location_shares_delete.DELETE', 'field_app_location_shares.field_app_location_shares_insert.INSERT',
      'field_app_location_shares.field_app_location_shares_update.UPDATE',
      'field_app_locations.field_app_locations_delete.DELETE', 'field_app_locations.field_app_locations_insert.INSERT',
      'field_app_locations.field_app_locations_update.UPDATE',
      'invoice_items.invoice_items_insert.INSERT', 'invoice_items.invoice_items_select.SELECT',
      'invoice_line_allocations.invoice_line_alloc_insert.INSERT', 'invoice_line_share_snapshots.invoice_line_share_snapshots_select.SELECT',
      'invoice_line_shares.invoice_line_shares_select.SELECT', 'invoice_shares.invoice_shares_insert.INSERT', 'invoice_shares.invoice_shares_select.SELECT',
      'invoices.invoices_insert.INSERT', 'invoices.invoices_select.SELECT', 'write_offs.write_offs_select_sales_rep.SELECT',
    ]);
    // Every created write policy is admin-only; no created policy mentions is_sales_rep() outside a USING read.
    for (const m of sql.matchAll(/CREATE POLICY \w+ ON public\.\w+\n {2}FOR (INSERT|UPDATE|DELETE) TO \w+\n([\s\S]*?);\n/g)) {
      expect(m[2]).not.toContain('is_sales_rep');
    }
    for (const m of sql.matchAll(/CREATE POLICY \w+_select(?:_sales_rep)? ON public\.\w+\n {2}FOR SELECT TO \w+\n {2}USING \(([\s\S]*?)\);\n/g)) {
      expect(m[1]).toContain('public.is_sales_rep()');
    }
    // Review round 2: every new read policy applies TO authenticated (anon cannot execute
    // is_sales_rep(), so TO public would turn anon's empty read into a permission error), and a
    // rep reads a split billing set or line only through a non-deleted invoice that uses it.
    expect([...sql.matchAll(/CREATE POLICY \w+_select(?:_sales_rep)? ON public\.\w+\n {2}FOR SELECT TO (\w+)/g)].map((m) => m[1]))
      .toEqual(Array(8).fill('authenticated'));
    for (const t of ['field_app_billing_sets', 'field_app_billing_lines']) {
      const policy = sql.slice(sql.indexOf(`CREATE POLICY ${t}_select ON public.${t}`), sql.indexOf('));\n', sql.indexOf(`CREATE POLICY ${t}_select ON public.${t}`)));
      expect(policy).toContain('USING (public.is_admin() OR EXISTS (');
      expect(policy).toContain('AND i.deleted_at IS NULL\n       AND (public.is_sales_rep() OR i.created_by');
    }
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.invoice_shares, public.invoice_line_allocations FROM authenticated, anon, PUBLIC;');
    expect(sql).toContain('REVOKE TRUNCATE ON public.invoice_line_shares, public.invoice_line_share_snapshots FROM authenticated;');
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.field_app_locations, public.field_app_location_shares, public.write_offs FROM authenticated, anon, PUBLIC;');
    expect(sql).toContain('REVOKE TRUNCATE ON public.field_app_billing_sets, public.field_app_billing_lines FROM authenticated;');
    const postflight = sql.slice(sql.indexOf('DO $postflight$'), sql.indexOf('$postflight$;'));
    for (const t of ['field_app_locations', 'field_app_location_shares', 'write_offs']) {
      expect(postflight).toContain(`OR has_table_privilege('authenticated', 'public.${t}', 'INSERT, UPDATE, DELETE, TRUNCATE')`);
      expect(postflight).toContain(`OR NOT has_table_privilege('authenticated', 'public.${t}', 'SELECT')`);
    }
  });

  it('refuses the apply from its postflight when anything authenticated can run reaches an invoice write unguarded', () => {
    const postflight = sql.slice(sql.indexOf('DO $postflight$'), sql.indexOf('$postflight$;'));
    expect(postflight).toContain('WITH RECURSIVE fn AS (');
    expect(postflight).toContain("has_function_privilege('authenticated', f.oid, 'EXECUTE')");
    expect(postflight).toContain('POSTFLIGHT_UNGUARDED_INVOICE_WRITER');
    // cancel_delivery stays on the upkeep allowlist (Mason 2026-10-09) - not wrapped.
    expect(postflight).toContain("('cancel_delivery(uuid,text,uuid,text)', '8528b344f86c7e1aa735e386ea39f2eb')");
    expect(sql).not.toMatch(/RENAME TO _cancel_delivery/);
    // reverse_write_off is wrapped now, so it is no longer on the pinned already-admin-only list.
    expect(postflight).not.toContain("('reverse_write_off(uuid,text,uuid,text)'");
    // The writer rule covers every invoice table and every write spelling, functions and procedures.
    for (const t of ['invoices', 'invoice_items', 'invoice_shares', 'invoice_line_shares', 'invoice_line_share_snapshots', 'invoice_line_allocations',
      'field_app_locations', 'field_app_location_shares', 'field_app_billing_sets', 'field_app_billing_lines', 'write_offs']) {
      expect(postflight).toMatch(new RegExp(`[(|]${t}[|)]`));
    }
    expect(postflight).toContain('merge\\s+into|truncate(\\s+table)?)\\s+(only\\s+)?("?public"?\\s*\\.\\s*)?"?(');
    expect(postflight).toContain("p.prokind IN ('f', 'p')");
    // The key-then-guard form is accepted for the split wrapper only.
    expect(postflight).toContain("AND NOT (f.proname = 'create_split_invoices_from_order'");
    // Review round 2: an exception handler disqualifies a guard-first body; dynamic SQL naming an
    // invoice table counts as a write; a trigger writing an invoice table from a table
    // authenticated can write refuses the apply; the posting version readers' owner and EXECUTE
    // list are pinned; invoices / invoice_items stay without API write grants.
    expect(postflight).toContain("AND (f.body ~* '\\mexception\\s+when\\M' OR (true");
    expect(postflight).toContain("OR (body ~* '\\mexecute\\M'");
    expect(postflight).toContain('POSTFLIGHT_INVOICE_TRIGGER');
    expect(postflight).toContain('must not catch exceptions');
    expect(postflight.split("AND p.proowner = 'postgres'::regrole").length - 1).toBe(2);
    for (const t of ['invoices', 'invoice_items']) {
      for (const role of ['authenticated', 'anon']) expect(postflight).toContain(`has_table_privilege('${role}', 'public.${t}', 'INSERT, UPDATE, DELETE, TRUNCATE')`);
    }
    // The smoke chain's step 8 is the same query, byte for byte.
    const query = sql.slice(sql.indexOf('  WITH RECURSIVE fn AS ('), sql.indexOf('  IF v_unclassified IS NOT NULL THEN'));
    expect(query.length).toBeGreaterThan(1000);
    expect(read('scripts/smoke/smoke-invoicing-admin-only.sql')).toContain(query);
  });

  it('registers its container-only smoke chain and real-schema prover', () => {
    const specs = JSON.parse(read('scripts/smoke/smoke-specs.json')).specs as Record<string, { chain: string; container_only?: boolean; container_prover?: string; covers?: string[] }>;
    const spec = Object.values(specs).find((s) => s.chain === 'smoke-invoicing-admin-only.sql');
    expect(spec?.container_only).toBe(true);
    expect(spec?.container_prover).toBe('prove-invoicing-admin-only-real-schema.mjs');
    for (const w of WRAPPED) expect(spec?.covers ?? []).toContain(w.name);
  });
});
