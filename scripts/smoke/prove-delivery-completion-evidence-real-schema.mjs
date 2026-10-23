#!/usr/bin/env node
/**
 * Full-chain proof for the 20261022075000 candidate (Goal 5 completion evidence): complete_delivery and
 * start_and_complete_delivery take p_evidence (signature | paper_ticket | left_at_site), refuse with
 * nothing changed unless that proof is saved, and record it in deliveries.completion_evidence; a
 * trigger closes the direct-table route to 'completed'; get_delivery_receipt_recipient lets an
 * assigned driver read the receipt email of a customer row hidden from them.
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers), then:
 *   1. BEFORE: the chain fails (complete_delivery has no p_evidence); the covering chains that pass
 *      are recorded;
 *   2. APPLY: the candidate applies in one transaction; the renamed body is unchanged; grants are as
 *      live's; a second apply is refused by the preflight;
 *   3. AFTER: the chain passes and rolls back (CONTAINER ONLY: it draws invoice numbers); every
 *      covering chain that passed BEFORE either still passes or stops ONLY at the new
 *      COMPLETION_EVIDENCE_REQUIRED (they complete deliveries the pre-candidate way);
 *   4. MUTATION: with the signature check, the photo-folder check, the left-at-site caption, the
 *      trigger or the receipt reader's driver check removed, the chain fails at the step that proves it.
 *
 * Run: node scripts/smoke/prove-delivery-completion-evidence-real-schema.mjs   (needs Docker)
 * Prints DELIVERY_COMPLETION_EVIDENCE_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-delivery-evidence-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261022075000_delivery_completion_evidence.sql');
// Live but not replayable here (storage.objects policies, storage.buckets settings); it must not touch what this proves.
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
// PR #889's data migrations rewrite live rows this disposable database does not have; they are
// recorded in the ledger (as live has them) instead of replayed.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
]);
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
const SMOKE = path.join(ROOT, 'scripts', 'smoke');
const CHAIN = path.join(SMOKE, 'smoke-delivery-completion-evidence.sql');
const SPECS = path.join(SMOKE, 'smoke-specs.json');
// Every other non-container chain that completes a delivery or a job. Each must keep passing after
// the candidate if it passed before it (some need live data this database lacks; those are
// reported, not required).
const COVERING_CHAINS = [
  'smoke-start-and-complete-delivery.sql',
  'smoke-delivery-job-replay-binding-batch3a.sql',
  'smoke-offline-action-receipts.sql',
  'smoke-delivery-accounting-period-guard.sql',
  'smoke-financial-scope-and-delivery-aggregate.sql',
  'smoke-field-invoice-loop.sql',
  'smoke-return-credit-chain.sql',
];
const TOUCHED = ['start_and_complete_delivery', 'complete_delivery', 'completion_evidence', 'delivery_signatures_scoped'];

const id = (n) => `7b640000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), ADMIN_B: id('a2'), REP: id('b1'), APPLICATOR: id('c1') };

// ------------------------------------------------------------------------------------------------
// Container plumbing (the shared real-schema harness).
function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psqlArgs(user = 'postgres') { return ['exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1']; }
function psql(sql, options = {}) { return docker(psqlArgs(options.user), { input: sql, allowFailure: options.allowFailure }); }
function scalar(sql) { return docker([...psqlArgs(), '-A', '-t'], { input: sql }).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''; }
function lf(file) { return readFileSync(file, 'utf8').replaceAll('\r\n', '\n'); }
function stageText(name, text) {
  const staged = path.join(tmpdir(), `${NAME}-${name}`);
  writeFileSync(staged, text, 'utf8');
  try { docker(['cp', staged, `${NAME}:/tmp/${name}`]); } finally {
    try { unlinkSync(staged); } catch (e) { if (e.code !== 'ENOENT') console.error(`could not remove ${staged}: ${e.message}`); }
  }
}
function apply(name) {
  const r = docker([...psqlArgs(), '-1', '-f', `/tmp/${name}`], { allowFailure: true });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function ready() {
  for (let i = 0; i < 120; i += 1) {
    if (docker(['exec', NAME, 'pg_isready', '-U', 'postgres'], { allowFailure: true }).status === 0) return;
    wait(500);
  }
  throw new Error('disposable PostgreSQL did not become ready');
}
// Record a migration in the ledger by NAME (later preflights look names up), versioned by its own
// stamp: an older file's high-water check compares versions, so only stamps are used.
function ledger(stem) {
  psql(`INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
    SELECT '${stem.slice(0, 14)}', '${stem}', ARRAY[]::text[]
     WHERE NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '${stem}')
    ON CONFLICT (version) DO NOTHING;`);
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${stem}';`), '1', `${stem} is not in the ledger`);
}
function restoreLiveCrLfCloseRemainder() {
  const source = lf(path.join(MIGRATIONS, '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql'));
  const needle = 'CREATE FUNCTION public._close_undelivered_order_remainder_20260718(';
  assert.equal(source.split(needle).length - 1, 1, 'close-remainder definition is ambiguous');
  const start = source.indexOf(needle);
  const tag = /\$([A-Za-z_]*)\$/.exec(source.slice(start));
  const bodyStart = start + tag.index + tag[0].length;
  const bodyEnd = source.indexOf(tag[0], bodyStart);
  const body = source.slice(bodyStart, bodyEnd).replace(/\n/g, '\r\n');
  assert.equal(body.length, 15910, 'close-remainder live CRLF body length drifted');
  psql(`CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(p_order_id uuid, p_actor uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $live_crlf_close$${body}$live_crlf_close$;`);
}
function plan() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const at = all.indexOf(CANDIDATE);
  assert.ok(at >= 0, 'the candidate must be selected for post-baseline replay');
  assert.equal(at, all.length - 1, 'the candidate must be the last migration in the replay plan');
  const before = all.slice(0, at);
  const touched = new RegExp(TOUCHED.join('|'));
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!touched.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
  }
  return before;
}
function installLiveAuthUid() {
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
}
function buildContainer() {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  ready();
  wait(1500);
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(schema.stderr.toString());
  psql('\\i /tmp/20260727174805_extensions.sql'); psql(schema.stdout.toString());
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, UNIQUE (bucket_id, name));
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
    -- As live (read 2026-10-21): postgres, which owns complete_delivery, may read storage.objects.
    GRANT USAGE ON SCHEMA storage TO postgres;
    GRANT ALL ON storage.objects, storage.buckets TO postgres;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  const files = plan();
  let replayed = 0;
  for (const [i, file] of files.entries()) {
    const base = path.basename(file);
    if (PARKED.has(base)) continue;
    for (const only of LEDGER_ONLY) if (only < base) ledger(path.basename(only, '.sql'));
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.ADMIN_B, 'admin', 'Admin B', 8], [U.REP, 'sales_rep', 'Rep', 7], [U.APPLICATOR, 'applicator', 'Applicator', 6]];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'delivery-evidence-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7b640000-%';`),
    'admin:true,admin:true,sales_rep:true,applicator:true', 'the seeded roles are not what the proof needs');
}

/** Run a chain file; `prefix` runs first in the same transaction (a mutation). */
function chain(file, prefix = '', user = 'postgres') {
  stageText('chain.sql', lf(file));
  const r = docker([...psqlArgs(user)], { input: `BEGIN;\n${prefix}\n\\i /tmp/chain.sql\nROLLBACK;\n`, allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const pass = /SMOKE_PASS_ROLLBACK/.test(out);
  const fail = /SMOKE_FAIL[^\n]*/.exec(out)?.[0] ?? (pass ? '' : (/ERROR:[^\n]*/.exec(out)?.[0] ?? out.trim().slice(-400)));
  return { pass, fail };
}
function covering(phase, required) {
  const passed = new Set();
  for (const name of COVERING_CHAINS) {
    const r = chain(path.join(SMOKE, name));
    if (r.pass) passed.add(name);
    else if (required?.has(name)) {
      // Written before this candidate, these chains complete deliveries with no evidence; after it, the
      // only acceptable failure is the new refusal (any other failure is a regression).
      // The offline chain replays a queued completion with no evidence through process_offline_action,
      // which now sends it to office review (needs_review, nothing committed) instead of completing it.
      const offlineToReview = name === 'smoke-offline-action-receipts.sql'
        && /"status": "needs_review"/.test(r.fail) && /"operation": "complete_delivery"/.test(r.fail);
      if (!offlineToReview) assert.match(r.fail, /COMPLETION_EVIDENCE_REQUIRED/, `${phase}: ${name} passed before the candidate and now fails for another reason: ${r.fail}`);
      console.log(`[prover] ${phase}: ${name} now stops at the evidence requirement (expected): ${r.fail}`);
    }
    else console.log(`[prover] ${phase}: ${name} does not pass in this database (not required): ${r.fail}`);
  }
  console.log(`[prover] ${phase}: ${passed.size}/${COVERING_CHAINS.length} covering chains pass and roll back: ${[...passed].join(', ')}`);
  return passed;
}
function sequences() {
  const rows = docker([...psqlArgs(), '-A', '-t', '-F', '|'], {
    input: "SELECT schemaname || '.' || sequencename, COALESCE(last_value::text, 'null') FROM pg_sequences ORDER BY 1;",
  }).stdout.trim().split(/\r?\n/).filter(Boolean);
  return new Map(rows.map((r) => r.split('|')));
}
// A rollback does not return sequence values. Surrogate row-id sequences moving is harmless; a
// document-number sequence (invoice, payment, credit-memo numbers) moving leaves a visible gap on
// live, which is why this chain is CONTAINER ONLY.
function movedSequences(before, after) {
  return [...after.keys()].filter((k) => after.get(k) !== before.get(k));
}
function documentNumberSequences() {
  return new Set(docker([...psqlArgs(), '-A', '-t'], {
    input: `SELECT DISTINCT s.schemaname || '.' || s.sequencename
              FROM pg_sequences s
             WHERE s.sequencename ~ '(number|_no|_num)'
                OR EXISTS (SELECT 1 FROM pg_proc p
                            WHERE p.prosrc ILIKE '%nextval(%' || s.sequencename || '%'
                              AND p.proname ~ '^next_.*_number$')
                OR EXISTS (SELECT 1 FROM pg_proc p
                            WHERE p.proname ~ '^next_.*_number$'
                              AND p.prosrc ILIKE '%' || s.sequencename || '%');`,
  }).stdout.trim().split(/\r?\n/).filter(Boolean));
}


// ------------------------------------------------------------------------------------------------
const RENAMED = 'public._complete_delivery_replay_impl_20261015(uuid,text,uuid,jsonb,text,text,text,timestamptz)';
function bodyMd5(sig) {
  return scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${sig}');`);
}
function acl(sig) {
  return scalar(`SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, ',' ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = to_regprocedure('${sig}') AND a.privilege_type = 'EXECUTE';`);
}

/** The candidate function holding one hunk, with the hunk replaced, as CREATE OR REPLACE (a mutation run before the chain). */
function mutate(find, replacement, label) {
  const sql = lf(CANDIDATE);
  assert.equal(sql.split(find).length - 1, 1, `mutation "${label}": hunk not found exactly once`);
  const at = sql.indexOf(find);
  const start = sql.lastIndexOf('CREATE FUNCTION public.', at);
  const end = sql.indexOf('$function$;', at) + '$function$;'.length;
  assert.ok(start >= 0 && end > at, `mutation "${label}": hunk is not inside one function`);
  return sql.slice(start, end).replace(find, replacement).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
}

// Real completions through the OLD functions, committed before the candidate is applied (the
// migration-boundary case: an old app whose reply was lost retries after the apply).
const LEGACY_BEFORE = `
DO $legacy$
DECLARE
  v_admin uuid; v_customer uuid; v_product uuid; v_pricing jsonb; v_order uuid; v_oi uuid; v_id uuid;
  v_del uuid[] := ARRAY[]::uuid[]; v_i int; v_res jsonb; v_res2 jsonb;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at, id LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  INSERT INTO public.customers (farm_name, account_number) VALUES ('[PROVER] Legacy Farm', '[PROVER]-LEGACY') RETURNING id INTO v_customer;
  INSERT INTO public.products (product_name, unit_size, epa_registration, product_form)
  VALUES ('[PROVER] Legacy Product', 'GL', '[PROVER]-EPA-LEGACY', 'liquid') RETURNING id INTO v_product;
  v_pricing := public.preview_product_pricing_changes('product_page', NULL,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'row_version', 1, 'pricing_mode', 'price_driven',
      'new_cost', '6.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00')),
    v_admin, 'prover-legacy-pricing-preview');
  PERFORM public.apply_product_pricing_change_set((v_pricing->>'change_set_id')::uuid, v_pricing->>'request_fingerprint', v_admin, 'prover-legacy-pricing-apply');
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size) VALUES (v_product, 'Main Warehouse', 50, 0, 'GL');
  INSERT INTO public.orders (order_number, customer_id, status, booking_draw) VALUES ('[PROVER] LEGACY', v_customer, 'confirmed', false) RETURNING id INTO v_order;
  FOR v_i IN 1..2 LOOP
    INSERT INTO public.order_items (order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product, '[PROVER] line ' || v_i, 10, 6, 2, 20, 8, 40, 0, 2) RETURNING id INTO v_oi;
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, scheduled_date, status, created_by)
    VALUES ('[PROVER] LEGACY-' || v_i, v_order, v_customer, CURRENT_DATE, 'scheduled', v_admin) RETURNING id INTO v_id;
    v_del := v_del || v_id;
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
    VALUES (v_id, v_oi, v_product, 2, 0, 'GL');
  END LOOP;
  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_del[1];
  v_res := public.complete_delivery(v_del[1], '[PROVER] Legacy', v_admin, NULL, NULL, NULL, 'prover-legacy-cd', NULL);
  v_res2 := public.start_and_complete_delivery(v_del[2], '[PROVER] Legacy', (now() AT TIME ZONE 'America/Chicago')::date, v_admin, NULL, NULL, NULL, 'prover-legacy-sacd');
  CREATE TABLE public._prover_legacy (k text PRIMARY KEY, delivery_id uuid, result jsonb, product_id uuid);
  INSERT INTO public._prover_legacy VALUES ('prover-legacy-cd', v_del[1], v_res, v_product), ('prover-legacy-sacd', v_del[2], v_res2, v_product);
  RAISE NOTICE 'LEGACY_COMPLETED';
END
$legacy$;`;
const LEGACY_AFTER = `
DO $replay$
DECLARE
  v_admin uuid; v_row record; v_res jsonb; v_stock numeric; v_stock_after numeric; v_err text; v_product uuid;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at, id LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SELECT product_id INTO v_product FROM public._prover_legacy LIMIT 1;
  SELECT quantity_available INTO v_stock FROM public.inventory WHERE product_id = v_product;
  SELECT * INTO v_row FROM public._prover_legacy WHERE k = 'prover-legacy-cd';
  v_res := public.complete_delivery(v_row.delivery_id, '[PROVER] Legacy', v_admin, NULL, NULL, NULL, 'prover-legacy-cd', NULL);
  IF v_res IS DISTINCT FROM v_row.result THEN RAISE EXCEPTION 'LEGACY_FAIL: complete_delivery replay % <> %', v_res, v_row.result; END IF;
  SELECT * INTO v_row FROM public._prover_legacy WHERE k = 'prover-legacy-sacd';
  v_res := public.start_and_complete_delivery(v_row.delivery_id, '[PROVER] Legacy', (now() AT TIME ZONE 'America/Chicago')::date, v_admin, NULL, NULL, NULL, 'prover-legacy-sacd');
  IF v_res IS DISTINCT FROM v_row.result THEN RAISE EXCEPTION 'LEGACY_FAIL: start_and_complete_delivery replay % <> %', v_res, v_row.result; END IF;
  SELECT quantity_available INTO v_stock_after FROM public.inventory WHERE product_id = v_product;
  IF v_stock_after IS DISTINCT FROM v_stock THEN RAISE EXCEPTION 'LEGACY_FAIL: a replay moved stock (% -> %)', v_stock, v_stock_after; END IF;
  -- The same old-shape call under a fresh key never completes anything.
  BEGIN
    PERFORM public.complete_delivery(v_row.delivery_id, '[PROVER] Legacy', v_admin, NULL, NULL, NULL, 'prover-legacy-fresh', NULL);
    RAISE EXCEPTION 'LEGACY_FAIL: a fresh no-evidence call was not refused';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err NOT LIKE 'COMPLETION_EVIDENCE_REQUIRED%' THEN RAISE EXCEPTION 'LEGACY_FAIL: fresh call: %', v_err; END IF;
  END;
  RAISE NOTICE 'LEGACY_REPLAY_PASS';
END
$replay$;`;

// Committed fixtures for the two-session tests (after the candidate is applied): four in_progress
// deliveries; the second, third and fourth each have a saved, non-empty ticket photo.
const CONC_SETUP = `
DO $conc$
DECLARE
  v_admin uuid; v_customer uuid; v_product uuid; v_order uuid; v_oi uuid; v_id uuid; v_i int; v_photo uuid;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at, id LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SELECT product_id INTO v_product FROM public._prover_legacy LIMIT 1;
  SELECT customer_id INTO v_customer FROM public.deliveries WHERE id = (SELECT delivery_id FROM public._prover_legacy LIMIT 1);
  INSERT INTO public.orders (order_number, customer_id, status, booking_draw) VALUES ('[PROVER] CONC', v_customer, 'confirmed', false) RETURNING id INTO v_order;
  CREATE TABLE public._prover_conc (k text PRIMARY KEY, id uuid);
  FOR v_i IN 1..4 LOOP
    INSERT INTO public.order_items (order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product, '[PROVER] conc ' || v_i, 10, 6, 2, 20, 8, 40, 0, 2) RETURNING id INTO v_oi;
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, scheduled_date, status, created_by)
    VALUES ('[PROVER] CONC-' || v_i, v_order, v_customer, CURRENT_DATE, 'scheduled', v_admin) RETURNING id INTO v_id;
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
    VALUES (v_id, v_oi, v_product, 2, 0, 'GL');
    UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_id;
    INSERT INTO public._prover_conc VALUES ('delivery' || v_i, v_id);
  END LOOP;
  SELECT id INTO v_id FROM public._prover_conc WHERE k = 'delivery2';
  INSERT INTO storage.objects (bucket_id, name, owner_id, metadata)
  VALUES ('delivery-photos', 'delivery-photos/' || v_id || '/conc.jpg', v_admin::text, '{"size": 1024, "mimetype": "image/jpeg"}'::jsonb);
  INSERT INTO public.delivery_photos (delivery_id, storage_path, image_url, uploaded_by, caption, sort_order)
  VALUES (v_id, 'delivery-photos/' || v_id || '/conc.jpg', 'x', v_admin, 'Signed paper delivery ticket', 0) RETURNING id INTO v_photo;
  INSERT INTO public._prover_conc VALUES ('photo', v_photo);
  FOR v_i IN 3..4 LOOP
    SELECT id INTO v_id FROM public._prover_conc WHERE k = 'delivery' || v_i;
    INSERT INTO storage.objects (bucket_id, name, owner_id, metadata)
    VALUES ('delivery-photos', 'delivery-photos/' || v_id || '/ticket.jpg', v_admin::text, '{"size": 1024, "mimetype": "image/jpeg"}'::jsonb);
    INSERT INTO public.delivery_photos (delivery_id, storage_path, image_url, uploaded_by, caption, sort_order)
    VALUES (v_id, 'delivery-photos/' || v_id || '/ticket.jpg', 'x', v_admin, 'Signed paper delivery ticket', 0) RETURNING id INTO v_photo;
    INSERT INTO public._prover_conc VALUES ('photo' || v_i, v_photo);
  END LOOP;
END
$conc$;`;

// As live (read 2026-10-22): storage.objects has row security on; postgres bypasses it; an
// authenticated caller may DELETE, and only an admin's delivery-photos rows pass the permissive
// rules (delivery_photos_delete; SELECT trimmed to the admin arm). The candidate's restrictive
// policies are already on the table.
const STORAGE_RLS = `
ALTER ROLE postgres BYPASSRLS;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT SELECT, DELETE ON storage.objects TO authenticated;
-- An earlier replayed migration may already have made these two; pin them to live's definitions.
DROP POLICY IF EXISTS delivery_photos_delete ON storage.objects;
DROP POLICY IF EXISTS staff_photos_delivery_select ON storage.objects;
CREATE POLICY delivery_photos_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'delivery-photos' AND public.is_admin());
CREATE POLICY staff_photos_delivery_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'delivery-photos' AND public.is_admin());`;

/**
 * Session A runs `body` in a transaction it holds open for 4 s (ending with `finish`); 1.5 s in,
 * session B runs `other`. Returns how long B waited and B's output. Session A's output goes to a
 * file (wait() blocks the event loop, so a pipe or exitCode would never be read): A must have
 * reached its sleep before B starts and must end with no error, or the race proves nothing.
 */
function race(prefix, body, finish, other) {
  const log = path.join(tmpdir(), `${NAME}-race-${Date.now()}.log`);
  const fd = openSync(log, 'w');
  spawn('docker', [...psqlArgs(), '-A', '-t', '-c', 'BEGIN', '-c', `${prefix} ${body}`, '-c', "SELECT 'A_HOLDING'",
    '-c', 'SELECT pg_sleep(4)', '-c', finish, '-c', "SELECT 'A_DONE'"], { stdio: ['ignore', fd, fd] });
  closeSync(fd);
  wait(1500);
  const holding = readFileSync(log, 'utf8');
  assert.ok(/A_HOLDING/.test(holding) && !/ERROR/.test(holding), `race: session A did not reach its lock-holding sleep: ${holding}`);
  const started = Date.now();
  const b = docker([...psqlArgs()], { input: other, allowFailure: true });
  const waited = Date.now() - started;
  for (let i = 0; i < 50 && !/A_DONE/.test(readFileSync(log, 'utf8')); i += 1) wait(200);
  const a = readFileSync(log, 'utf8');
  unlinkSync(log);
  assert.ok(/A_DONE/.test(a) && !/ERROR/.test(a), `race: session A did not finish cleanly: ${a}`);
  return { waited, output: `${b.stdout}\n${b.stderr}` };
}
function concurrency() {
  psql(CONC_SETUP);
  const conc = (k) => scalar(`SELECT id FROM public._prover_conc WHERE k = '${k}';`);
  const admin2 = scalar("SELECT id FROM public.profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at DESC, id LIMIT 1;");
  const claims = (u) => `SELECT set_config('request.jwt.claims', json_build_object('sub', '${u}', 'role', 'authenticated')::text, true), set_config('request.jwt.claim.sub', '${u}', true);`;
  const noProof = (key) => `SELECT public.complete_delivery('${conc('delivery1')}', 'No proof — recorded by office', '${admin2}', NULL, NULL, NULL, '${key}', NULL, 'no_proof', 'Concurrent demotion test reason');`;
  const demote = `UPDATE public.profiles SET role = 'sales_rep' WHERE id = '${admin2}';`;
  const restore = `UPDATE public.profiles SET role = 'admin' WHERE id = '${admin2}';`;
  const unlocked = mutate(" WHERE id = v_actor AND is_active = true FOR SHARE;\n  IF v_actor_role IS NULL OR NOT (\n    v_actor_role IN ('admin', 'sales_rep')\n    OR (v_actor_role = 'driver' AND v_actor = v_assigned_driver)\n  ) THEN\n    RAISE EXCEPTION 'Not authorized to complete this delivery';\n  END IF;\n\n  IF p_evidence IS NULL THEN\n    -- Legacy replay only: exactly the 20261019200000",
    " WHERE id = v_actor AND is_active = true;\n  IF v_actor_role IS NULL OR NOT (\n    v_actor_role IN ('admin', 'sales_rep')\n    OR (v_actor_role = 'driver' AND v_actor = v_assigned_driver)\n  ) THEN\n    RAISE EXCEPTION 'Not authorized to complete this delivery';\n  END IF;\n\n  IF p_evidence IS NULL THEN\n    -- Legacy replay only: exactly the 20261019200000", 'profile FOR SHARE');

  // Mutation first (rolled back): without FOR SHARE the demotion does not wait.
  let r = race(unlocked, claims(admin2) + noProof('prover-conc-np-mut'), 'ROLLBACK', demote);
  psql(restore);
  assert.ok(r.waited < 1000, `CONCURRENCY mutation: without FOR SHARE the demotion still waited ${r.waited} ms`);
  r = race('', claims(admin2) + noProof('prover-conc-np'), 'COMMIT', demote);
  assert.ok(r.waited >= 1500, `CONCURRENCY: a demotion did not wait for the admin's no-proof completion (${r.waited} ms)`);
  assert.equal(scalar(`SELECT status || ':' || completion_evidence || ':' || completion_no_proof_by FROM public.deliveries WHERE id = '${conc('delivery1')}';`),
    `completed:no_proof:${admin2}`, 'CONCURRENCY: the no-proof completion did not commit');
  psql(restore);
  console.log(`[prover] CONCURRENCY: a demotion waits for the admin's no-proof completion to commit (${r.waited} ms; without FOR SHARE it did not wait)`);

  const admin1 = scalar("SELECT id FROM public.profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at, id LIMIT 1;");
  const paper = (key) => `SELECT public.complete_delivery('${conc('delivery2')}', '[PROVER] Signer', '${admin1}', NULL, NULL, NULL, '${key}', NULL, 'paper_ticket', '${conc('photo')}');`;
  const recaption = `UPDATE public.delivery_photos SET caption = 'Not a ticket' WHERE id = '${conc('photo')}';`;
  const noRowLock = mutate("      SELECT * INTO v_photo FROM public.delivery_photos WHERE id = v_photo_id FOR UPDATE;",
    "      SELECT * INTO v_photo FROM public.delivery_photos WHERE id = v_photo_id;", 'photo FOR UPDATE');
  r = race(noRowLock, claims(admin1) + paper('prover-conc-photo-mut'), 'ROLLBACK', `BEGIN; ${recaption} ROLLBACK;`);
  assert.ok(r.waited < 1000 && !/ERROR/.test(r.output), `CONCURRENCY mutation: without the photo row lock the re-caption still waited or failed (${r.waited} ms): ${r.output}`);
  r = race('', claims(admin1) + paper('prover-conc-photo'), 'COMMIT', recaption);
  assert.ok(r.waited >= 1500, `CONCURRENCY: a re-caption did not wait for the completion that accepted the photo (${r.waited} ms)`);
  assert.match(r.output, /COMPLETION_EVIDENCE_LOCKED/, `CONCURRENCY: the re-caption after the completion was not refused: ${r.output}`);
  assert.equal(scalar(`SELECT caption FROM public.delivery_photos WHERE id = '${conc('photo')}';`), 'Signed paper delivery ticket', 'CONCURRENCY: the accepted photo changed');
  console.log(`[prover] CONCURRENCY: a re-caption of the accepted photo waits for the completion (${r.waited} ms), then is refused; without the row lock it did not wait`);

  // An admin's storage delete of the ticket file racing the completion that accepts it. Live, the
  // delete runs as authenticated under the storage rules, whose restrictive arm calls the helper.
  psql(STORAGE_RLS, { user: 'supabase_admin' });
  const file = (n) => scalar(`SELECT storage_path FROM public.delivery_photos WHERE id = '${conc(`photo${n}`)}';`);
  const [file3, file4] = [file(3), file(4)];
  const asAdmin = `SET LOCAL ROLE authenticated; ${claims(admin1)}`;
  const del = (name) => `DELETE FROM storage.objects WHERE bucket_id = 'delivery-photos' AND name = '${name}' RETURNING 'DELETED ' || name;`;
  const paperFor = (n, key) => `SELECT public.complete_delivery('${conc(`delivery${n}`)}', '[PROVER] Signer', '${admin1}', NULL, NULL, NULL, '${key}', NULL, 'paper_ticket', '${conc(`photo${n}`)}');`;
  const noFolderLock = mutate("    PERFORM 1 FROM public.deliveries WHERE id = v_folder::uuid FOR SHARE;\n", "    NULL;\n", 'storage helper folder lock');
  const objects = (name) => scalar(`SELECT count(*) FROM storage.objects WHERE bucket_id = 'delivery-photos' AND name = '${name}';`);
  const stateOf = (n) => scalar(`SELECT status || ':' || COALESCE(completion_evidence, '-') FROM public.deliveries WHERE id = '${conc(`delivery${n}`)}';`);

  // Completion first. Mutation (all rolled back): without the folder lock the delete does not wait and removes the file.
  r = race('', claims(admin1) + paperFor(3, 'prover-conc-del-mut'), 'ROLLBACK', `BEGIN; ${noFolderLock} ${asAdmin} ${del(file3)} ROLLBACK;`);
  assert.ok(r.waited < 1000 && /DELETED /.test(r.output), `CONCURRENCY mutation: without the folder lock the delete still waited or removed nothing (${r.waited} ms): ${r.output}`);
  r = race('', claims(admin1) + paperFor(3, 'prover-conc-del'), 'COMMIT', `BEGIN; ${asAdmin} ${del(file3)} COMMIT;`);
  assert.ok(r.waited >= 1500, `CONCURRENCY: an admin's delete of the ticket file did not wait for the completion (${r.waited} ms)`);
  assert.ok(!/DELETED |ERROR/.test(r.output), `CONCURRENCY: the delete after the completion removed the accepted file or failed: ${r.output}`);
  assert.equal(objects(file3), '1', 'CONCURRENCY: the accepted ticket file is gone');
  assert.equal(stateOf(3), 'completed:paper_ticket', 'CONCURRENCY: the ticket completion did not commit');
  console.log(`[prover] CONCURRENCY: an admin's delete of the ticket file waits for the completion (${r.waited} ms), then removes nothing; without the folder lock it did not wait and removed it`);

  // Delete first. Mutation (all rolled back): without the folder lock the completion does not wait and accepts the file being deleted.
  r = race(noFolderLock, `${asAdmin} ${del(file4)}`, 'ROLLBACK', `BEGIN; ${claims(admin1)} ${paperFor(4, 'prover-conc-del2-mut')} ROLLBACK;`);
  assert.ok(r.waited < 1000 && !/ERROR/.test(r.output), `CONCURRENCY mutation: without the folder lock the completion still waited or was refused (${r.waited} ms): ${r.output}`);
  // One transaction, so the caller's claims (set transaction-locally) still hold when the completion runs.
  r = race('', `${asAdmin} ${del(file4)}`, 'COMMIT', `BEGIN; ${claims(admin1)} ${paperFor(4, 'prover-conc-del2')} COMMIT;`);
  assert.ok(r.waited >= 1500, `CONCURRENCY: the completion did not wait for an admin's delete in progress (${r.waited} ms)`);
  assert.match(r.output, /PAPER_TICKET_PHOTO_MISSING/, `CONCURRENCY: the completion after the delete was not refused: ${r.output}`);
  assert.equal(objects(file4), '0', 'CONCURRENCY: the delete did not commit');
  assert.equal(stateOf(4), 'in_progress:-', 'CONCURRENCY: the refused completion changed the delivery');
  console.log(`[prover] CONCURRENCY: a completion waits for an admin's delete of its ticket file (${r.waited} ms), then is refused; without the folder lock it did not wait`);
}

function main() {
  buildContainer();
  seed();

  const before = chain(CHAIN);
  assert.ok(!before.pass, 'BEFORE: the chain passed without the candidate');
  // The chain's first call to something the candidate adds: the receipt reader, or complete_delivery with evidence.
  assert.match(before.fail, /(?:get_delivery_receipt_recipient|complete_delivery)\([^)]*\) does not exist/, `BEFORE: wrong first failure: ${before.fail}`);
  console.log(`[prover] BEFORE: the chain fails first: ${before.fail}`);
  const passedBefore = covering('BEFORE');
  const renamedBefore = bodyMd5(RENAMED);
  const legacy = docker([...psqlArgs()], { input: LEGACY_BEFORE, allowFailure: true });
  assert.match(`${legacy.stdout}\n${legacy.stderr}`, /LEGACY_COMPLETED/, `BEFORE: the old functions did not complete the legacy deliveries: ${legacy.stderr}`);
  console.log('[prover] BEFORE: one delivery completed with the old complete_delivery and one with the old start_and_complete_delivery (committed, keys saved)');

  stageText('candidate.sql', lf(CANDIDATE));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.equal(bodyMd5(RENAMED), renamedBefore, 'APPLY: the renamed completion body changed');
  assert.equal(acl('public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz,text,text)'), 'authenticated,postgres,service_role', 'APPLY: complete_delivery EXECUTE drifted');
  assert.equal(acl('public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text,text,text)'), 'authenticated,postgres', 'APPLY: start_and_complete_delivery EXECUTE drifted');
  assert.equal(acl('public.get_delivery_receipt_recipient(uuid)'), 'authenticated,postgres', 'APPLY: get_delivery_receipt_recipient EXECUTE drifted');
  assert.equal(scalar("SELECT count(*) FROM pg_proc WHERE proname IN ('complete_delivery', 'start_and_complete_delivery') AND pronamespace = 'public'::regnamespace;"), '2', 'APPLY: an old overload survived');
  stageText('again.sql', lf(CANDIDATE));
  const again = apply('again.sql');
  assert.notEqual(again.status, 0, 'APPLY: a second apply was not refused');
  assert.match(again.output, /PREFLIGHT_DELIVERY_COMPLETION_EVIDENCE_(?:DRIFT|ALREADY_APPLIED)/, `APPLY: second apply refused for the wrong reason: ${again.output}`);
  console.log('[prover] APPLY: renamed body unchanged; grants as live; one overload each; a second apply is refused by the preflight');

  const replay = docker([...psqlArgs()], { input: `BEGIN;\n${LEGACY_AFTER}\nROLLBACK;\n`, allowFailure: true });
  assert.match(`${replay.stdout}\n${replay.stderr}`, /LEGACY_REPLAY_PASS/, `AFTER: the legacy replay failed: ${replay.stderr}`);
  console.log('[prover] AFTER: exact retries of both old completions (no evidence) replay their saved results and move no stock; a fresh no-evidence call is refused');

  const after = chain(CHAIN);
  assert.ok(after.pass, `AFTER: the chain failed: ${after.fail}`);
  const spec = JSON.parse(readFileSync(SPECS, 'utf8')).specs.delivery_completion_evidence;
  assert.ok(spec && spec.chain === path.basename(CHAIN) && spec.container_only === true, 'smoke-specs.json has no container-only entry for the chain');
  console.log('[prover] AFTER: the chain passes and rolls back (CONTAINER ONLY)');
  covering('AFTER', passedBefore);

  const mutations = [
    ['signature uploader check', "                         AND o.owner_id = v_actor::text\n", "",
      /SMOKE_FAIL: a signature image uploaded by someone else was accepted/],
    ['signature path derived from the key', "      || left(encode(sha256(convert_to(p_idempotency_key, 'UTF8')), 'hex'), 32) || '.png';\n    IF p_evidence_ref IS DISTINCT FROM v_signature_path\n",
      "      || left(encode(sha256(convert_to(p_idempotency_key, 'UTF8')), 'hex'), 32) || '.png';\n    v_signature_path := p_evidence_ref;\n    IF p_evidence_ref IS DISTINCT FROM v_signature_path\n",
      /SMOKE_FAIL: a signature image of another attempt was accepted/],
    ['non-empty signature image', "                         AND (o.metadata ->> 'size')::bigint >= 500) THEN",
      "                         AND true) THEN", /SMOKE_FAIL: a\. an empty signature image was accepted/],
    ['photo delivery check', "       OR v_photo.delivery_id IS DISTINCT FROM p_delivery_id\n", "",
      /SMOKE_FAIL: b\. another delivery's ticket photo was accepted/],
    ['own-folder check', "       OR split_part(v_photo.storage_path, '/', 2) <> p_delivery_id::text\n", "",
      /SMOKE_FAIL: b\. a ticket photo from another delivery's folder was accepted/],
    ['non-empty photo', "                         AND (o.metadata ->> 'size')::bigint >= 1000) THEN",
      "                         AND true) THEN", /SMOKE_FAIL: b\. an empty ticket photo was accepted/],
    ['left-at-site caption', "      ELSE 'Left at site — drop location'", "      ELSE 'Signed paper delivery ticket'",
      /SMOKE_FAIL: c\. left-at-site completion with a ticket photo was accepted/],
    ['left-at-site signer', "    IF p_evidence = 'left_at_site' AND p_signed_by IS DISTINCT FROM 'No one present — left at site' THEN",
      "    IF false THEN", /SMOKE_FAIL: c\. left-at-site completion with a named signer was accepted/],
    ['status before evidence', "  IF v_status IS DISTINCT FROM 'in_progress' THEN", "  IF false THEN",
      /SMOKE_FAIL: e\. expected the in_progress status refusal/],
    ['direct-table trigger', "  v_marked := COALESCE(current_setting('crx.delivery_completion_evidence', true), '') = NEW.id::text;",
      "  v_marked := true;", /SMOKE_FAIL: g\. a direct UPDATE completed a delivery/],
    // The completion body leaves app.admin_override on for the rest of its transaction; trusting it
    // would let a later statement in the same transaction complete a delivery directly.
    ['marker-only trigger (no admin-override exemption)', "  v_marked := COALESCE(current_setting('crx.delivery_completion_evidence', true), '') = NEW.id::text;",
      "  v_marked := COALESCE(current_setting('crx.delivery_completion_evidence', true), '') = NEW.id::text OR public._is_admin_override();",
      /SMOKE_FAIL: g\. a direct UPDATE completed a delivery/],
    ['signature_url lock', "     OR NEW.signature_url IS DISTINCT FROM OLD.signature_url\n", "",
      /SMOKE_FAIL: g\. a completed delivery's signature_url was rewritten directly/],
    ['signed_by lock', "\n     OR NEW.signed_by IS DISTINCT FROM OLD.signed_by THEN",
      "\n     THEN", /SMOKE_FAIL: g\. a completed delivery's signed_by was rewritten directly/],
    ['photo image type', "                         AND COALESCE(o.metadata ->> 'mimetype', '') LIKE 'image/%'\n", "",
      /SMOKE_FAIL: b\. a non-image ticket file was accepted/],
    ['PNG signature content type', "                         AND o.metadata ->> 'mimetype' = 'image/png'\n", "",
      /SMOKE_FAIL: a\. a non-PNG signature file was accepted/],
    ['receipt window for drivers', "AND v_status IN ('scheduled', 'in_progress'))", ")",
      /SMOKE_FAIL: h\. the driver read the receipt email of a completed delivery/],
    ['receipt reader authorization', "    OR (v_actor_role = 'driver' AND v_actor = v_assigned_driver AND v_status IN ('scheduled', 'in_progress'))\n",
      "    OR (v_actor_role = 'driver' AND v_status IN ('scheduled', 'in_progress'))\n", /SMOKE_FAIL: h\. another driver read the receipt email/],
    ['no-proof admin check', "      RAISE EXCEPTION 'NO_PROOF_ADMIN_ONLY: only an admin can record a delivery without proof' USING ERRCODE = '42501';\n    END IF;\n    v_reason :=",
      "      NULL;\n    END IF;\n    v_reason :=", /SMOKE_FAIL: i\. a sales rep recorded a delivery without proof/],
    ['no-proof reason length', "    IF char_length(v_reason) NOT BETWEEN 10 AND 500 THEN", "    IF false THEN",
      // Without the wrapper's check the table CHECK still refuses the short reason (second layer).
      /SMOKE_FAIL: i\. (?:a 9-character reason was accepted|short: expected NO_PROOF_REASON_REQUIRED, got new row [^\n]*deliveries_no_proof_record_check)/],
    ['no-proof whitespace collapse', "    v_reason := btrim(regexp_replace(p_evidence_ref, '[[:space:]]+', ' ', 'g'));", "    v_reason := p_evidence_ref;",
      /SMOKE_FAIL: i\. a whitespace-only reason was accepted/],
    ['no-proof signer', "    IF char_length(v_reason) NOT BETWEEN 10 AND 500 THEN\n      RAISE EXCEPTION 'NO_PROOF_REASON_REQUIRED: write why this delivery is recorded without proof (10 to 500 characters)' USING ERRCODE = '22023';\n    END IF;\n    IF p_signed_by IS DISTINCT FROM 'No proof — recorded by office' THEN",
      "    IF char_length(v_reason) NOT BETWEEN 10 AND 500 THEN\n      RAISE EXCEPTION 'NO_PROOF_REASON_REQUIRED: write why this delivery is recorded without proof (10 to 500 characters)' USING ERRCODE = '22023';\n    END IF;\n    IF false THEN",
      /SMOKE_FAIL: i\. a no-proof completion naming a customer as signer was accepted/],
    ['no-proof recorder', "         completion_no_proof_by = CASE WHEN p_evidence = 'no_proof' THEN v_actor END,",
      "         completion_no_proof_by = CASE WHEN p_evidence = 'no_proof' THEN (SELECT id FROM public.profiles WHERE role = 'admin' AND id <> v_actor ORDER BY id LIMIT 1) END,",
      /SMOKE_FAIL: i\. no-proof record wrong/],
    ['freeze once recorded', "  IF OLD.completion_evidence IS NOT NULL\n     AND (NEW.completion_evidence IS DISTINCT FROM OLD.completion_evidence",
      "  IF false\n     AND (NEW.completion_evidence IS DISTINCT FROM OLD.completion_evidence",
      /SMOKE_FAIL: i\. a recorded no-proof reason was rewritten under the marker/],
    ['accepted photo row protection', "     AND (TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD) THEN", "     AND false THEN",
      /SMOKE_FAIL: i\. an accepted ticket photo row was changed/],
    ['storage helper', "  IF p_bucket_id IS DISTINCT FROM 'delivery-photos' THEN\n    RETURN false;", "  IF true THEN\n    RETURN false;",
      /SMOKE_FAIL: i\. the storage helper marked the wrong objects/],
  ];
  for (const [label, find, replacement, expected] of mutations) {
    const r = chain(CHAIN, mutate(find, replacement, label));
    assert.ok(!r.pass, `MUTATION ${label}: the chain still passed without the hunk`);
    assert.match(r.fail, expected, `MUTATION ${label}: wrong failure: ${r.fail}`);
    console.log(`[prover] MUTATION: without the ${label} the chain fails: ${r.fail}`);
  }

  concurrency();

  console.log('DELIVERY_COMPLETION_EVIDENCE_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
