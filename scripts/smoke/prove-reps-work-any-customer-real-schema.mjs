#!/usr/bin/env node
/**
 * Full-chain proof for the 20261013220000 candidate: sales reps work with ANY customer
 * (Mason, 2026-10-13).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate
 * (the same skips as the other real-schema provers), checks that every function body and policy
 * the candidate replaces matches its live md5 of 2026-10-13, then, as the `authenticated` role
 * exactly like a browser session through PostgREST, runs one matrix of calls BEFORE and AFTER the
 * candidate. Every call is one transaction that always rolls back.
 *   1. BEFORE: a rep is refused (or sees nothing) for customers not assigned to them.
 *   2. AFTER: the same rep saves, posts (single and group), split-bills, resolves splits, reads
 *      statements, year-end and purchase summaries, lists balances, edits the customer, its
 *      contacts, documents, facts, interactions and external identities, for ANY customer.
 *   3. STILL REFUSED after: a rep naming another salesperson (SALESMAN_SCOPE_DENIED), a rep
 *      reassigning a customer (REP_CANNOT_REASSIGN, through save_customer and the direct table),
 *      a rep changing the commission split of a customer not assigned to them
 *      (COMMISSION_SPLIT_ADMIN_OR_ASSIGNED_REP); drivers, applicators and deactivated reps see and
 *      do exactly what they did before.
 *   4. ADMINS UNCHANGED: every admin case gives the identical (normalized) result before and after.
 *   5. The preflight refuses a drifted body, and the candidate refuses to apply twice.
 *   6. MUTATION: with the guard trigger dropped, the direct-table reassignment succeeds, so step 3's
 *      refusal really comes from the trigger.
 *
 * Run: node scripts/smoke/prove-reps-work-any-customer-real-schema.mjs   (needs Docker)
 * Prints REPS_ANY_CUSTOMER_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-reps-any-customer-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1' || REUSE;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261013220000_reps_work_any_customer.sql');
// Live but not replayable here (storage.objects policies); it must not touch what this proves.
const PARKED = new Set(['20260914100700_customer_document_bytes_server_only.sql']);
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

const id = (n) => `7a300000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = {
  ADMIN: id('a1'), REP: id('b1'), REP_B: id('b2'), REP_OFF: id('b3'),
  DRIVER: id('d1'), APPLICATOR: id('e1'),
};
const C1 = id('c1'); // Rep's farm
const C2 = id('c2'); // Rep's second farm (the split partner)
const C3 = id('c3'); // Rep B's farm
const C4 = id('c4'); // no assigned rep
const PROD = id('f1');
const F_SHARED = id('1002');
const SVC = id('7001');
const SPLIT_JOB = id('4003');
const DOC3 = id('d003');
const SEASON = "extract(year FROM (now() AT TIME ZONE 'America/Chicago'))::int";
const TODAY = "(now() AT TIME ZONE 'America/Chicago')::date";

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
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!/customers|invoice|customer_documents_rep|assigned_sales_rep/i.test(lf(file).replace(/customer_documents_storage_path_shape_check/g, '')),
      `${name} now touches what this proof covers; replay it or re-think the skip`);
  }
  return before;
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
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text);
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  const files = plan();
  let replayed = 0;
  for (const [i, file] of files.entries()) {
    const base = path.basename(file);
    const stem = path.basename(file, '.sql');
    if (PARKED.has(base)) continue;
    // The replay plan may omit the data-only files; record each once the replay passes its stamp.
    for (const only of LEDGER_ONLY) if (only < base) ledger(path.basename(only, '.sql'));
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    replayed += 1;
  }
  // The candidate's preflight requires its predecessor in the ledger, as on live.
  ledger('20261010120000_cap_delivery_invoice_at_delivered');
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

// ------------------------------------------------------------------------------------------------
// FIDELITY: the pins the candidate's preflight checks, read from the candidate file itself.
function candidatePins() {
  const sql = lf(CANDIDATE);
  const fns = [...sql.matchAll(/\('(public\.[^']+\))', '([0-9a-f]{32})'\)/g)].map((m) => [m[1], m[2]]);
  const pols = [...sql.matchAll(/\('([a-z_]+)', '([a-z_]+)', '([0-9a-f]{32})'\)/g)].map((m) => [m[1], m[2], m[3]]);
  assert.equal(fns.length, 20, 'the candidate pins 20 function bodies');
  assert.equal(pols.length, 20, 'the candidate pins 20 policies');
  return { fns, pols };
}
function fidelity() {
  const { fns, pols } = candidatePins();
  for (const [sig, pin] of fns) {
    assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${sig}');`), pin, `${sig} replayed with a body that differs from live`);
  }
  for (const [t, p, pin] of pols) {
    assert.equal(scalar(`SELECT md5(cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')) FROM pg_policies WHERE schemaname = 'public' AND tablename = '${t}' AND policyname = '${p}';`), pin, `${t}.${p} replayed with a policy that differs from live`);
  }
  console.log(`[prover] FIDELITY: ${fns.length} function bodies and ${pols.length} policies match the live pins of 2026-10-13`);
}

// ------------------------------------------------------------------------------------------------
// Seed (committed once; every probe rolls back).
function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function asUser(uid) { return `${claims(uid)}\nSET LOCAL ROLE authenticated;`; }
function seed() {
  const users = [
    [U.ADMIN, 'admin', 'Admin', 9], [U.REP, 'sales_rep', 'Rep', 8], [U.REP_B, 'sales_rep', 'Rep B', 7],
    [U.REP_OFF, 'sales_rep', 'Deactivated Rep', 6], [U.DRIVER, 'driver', 'Driver', 5], [U.APPLICATOR, 'applicator', 'Applicator', 4],
  ];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'reps-any-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    ${claims(U.ADMIN)}
    UPDATE public.profiles SET is_active = false WHERE id = '${U.REP_OFF}';
    INSERT INTO public.customers (id, farm_name, assigned_sales_rep, is_active, email) VALUES
      ('${C1}', '[PROVER] Rep Farm', '${U.REP}', true, 'c1@example.invalid'),
      ('${C2}', '[PROVER] Rep Farm Two', '${U.REP}', true, 'c2@example.invalid'),
      ('${C3}', '[PROVER] Rep B Farm', '${U.REP_B}', true, 'c3@example.invalid'),
      ('${C4}', '[PROVER] No Rep Farm', NULL, true, 'c4@example.invalid');
    UPDATE public.customers
       SET default_commission_split = jsonb_build_object('splits', jsonb_build_array(jsonb_build_object('recipient_user_id', assigned_sales_rep::text, 'percentage', 100)))
     WHERE id IN ('${C1}', '${C3}');
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, product_form, epa_registration)
      VALUES ('${PROD}', '[PROVER] Product', 'GL', 6.00, 10.00, 'liquid', 'PROVER-EPA-1');
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.fields (id, customer_id, field_name, crop_type, total_acres) VALUES
      ('${F_SHARED}', '${C1}', '[PROVER] Shared Field', 'corn', 100);
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES
      ('${F_SHARED}', '${C1}', 50, true), ('${F_SHARED}', '${C2}', 50, false);
    INSERT INTO public.application_services (id, name, is_active) VALUES ('${SVC}', '[PROVER] Service', true);
    INSERT INTO public.app_settings (setting_key, setting_value) VALUES ('per_line_split_billing_enabled', 'true')
      ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value;
    INSERT INTO public.customer_documents (id, customer_id, document_type, storage_path, filename, mime_type, size_bytes, uploaded_by, source)
      VALUES ('${DOC3}', '${C3}', 'other', '${C3}/${DOC3}.pdf', 'prover.pdf', 'application/pdf', 10, '${U.ADMIN}', 'rep');
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7a300000-%';`),
    'admin:true,sales_rep:true,sales_rep:true,sales_rep:false,driver:true,applicator:true', 'the seeded roles are not what the proof needs');
}

// ------------------------------------------------------------------------------------------------
// Probes.
/**
 * Run `call` as `uid` after `fixture` (owner), in one rolled-back transaction. `pre` is PL/pgSQL run
 * as `uid` first, inside the same exception block (each statement sees what the previous one wrote).
 * ok|<value> or <sqlstate>|<message>.
 */
function attempt(uid, call, { fixture = '', statement = false, pre = '' } = {}) {
  const sql = `BEGIN;
${fixture}
RESET ROLE;
${asUser(uid)}
DO $probe$
DECLARE v text; n bigint;
BEGIN
  ${pre}
  ${statement ? `${call}; GET DIAGNOSTICS n = ROW_COUNT; v := n::text;` : `v := (${call})::text;`}
  RAISE NOTICE 'RESULT|ok|%', COALESCE(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'RESULT|%|%', SQLSTATE, SQLERRM;
END
$probe$;
ROLLBACK;
`;
  const r = docker([...psqlArgs(), '-A', '-t'], { input: sql, allowFailure: true });
  assert.equal(r.status, 0, `probe failed to run:\n${r.stderr}\n--- SQL ---\n${sql}`);
  const m = /RESULT\|([^\n]*)/.exec(r.stderr);
  assert.ok(m, `probe printed no RESULT:\n${r.stderr}`);
  return m[1].trimEnd();
}
function normalize(text) {
  return text
    .replace(/\b(?!7a300000-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    .replace(/\b[A-Z]{2,4}-\d{4}-\d{4,6}\b/g, '<num>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:\d{2})?|Z)?/g, '<ts>');
}

const misc = (customer, label, extra = '') => `public.save_invoice(jsonb_build_object('customer_id', '${customer}', 'invoice_type', 'misc_charge', 'status', 'draft',
    'invoice_date', ${TODAY}, 'header_notes', '[PROVER] ${label}'${extra}),
    jsonb_build_array(jsonb_build_object('description', '[PROVER] fee ${label}', 'quantity', 1, 'unit_price_cents', 1500, 'extended_cents', 1500)),
    'prover-rac-misc-${label}')`;
const adminDraft = (customer, label, extra = '') => `${claims(U.ADMIN)}
  SELECT set_config('prover.inv', (${misc(customer, `adm-${label}`, extra)})::text, true);`;
const adminPosted = (customer, label, extra = '') => `${adminDraft(customer, label, extra)}
  SELECT public.post_invoice(current_setting('prover.inv')::uuid, 'prover-rac-post-${label}') IS NULL;`;
const splitJob = `INSERT INTO public.jobs (id, job_number, customer_id, status, job_date, total_acres, created_by)
    VALUES ('${SPLIT_JOB}', 'PROVER-RAC-SPLITJOB', '${C1}', 'completed', ${TODAY}, 100, '${U.ADMIN}');
  INSERT INTO public.job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES ('${SPLIT_JOB}', '${F_SHARED}', 100, 0);`;
const splitCall = (uid, key, salesman = null) => `public.save_field_app_split_invoice(NULL, '${SPLIT_JOB}', jsonb_build_object('invoice_date', (${TODAY})::text${salesman ? `, 'salesman_id', '${salesman}'` : ''}),
    jsonb_build_array(jsonb_build_object('field_id', '${F_SHARED}', 'applied_acres', 100)),
    jsonb_build_array(jsonb_build_object('line_kind', 'service', 'application_service_id', '${SVC}', 'description', '[PROVER] Svc', 'source_acres', 100, 'manual_override', true, 'source_unit_price_cents', 100)),
    '${uid}', NULL, '${key}')`;
const adminGroup = `${splitJob}
  ${claims(U.ADMIN)}
  SELECT set_config('prover.group', (${splitCall(U.ADMIN, 'prover-rac-fas-admin')})->>'invoice_group_id', true);`;
// The same group with Rep B named as its salesperson by the admin.
const adminGroupForRepB = `${splitJob}
  ${claims(U.ADMIN)}
  SELECT set_config('prover.group', (${splitCall(U.ADMIN, 'prover-rac-fas-admin-b', U.REP_B)})->>'invoice_group_id', true);`;
// A SECURITY DEFINER stand-in for the server's prepay functions (created inside the rolled-back probe).
const serverPrepayFn = `CREATE FUNCTION public.prover_rac_bump_prepay(p_customer uuid) RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
    AS $fn$ UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 100 WHERE id = p_customer RETURNING prepay_balance_cents $fn$;
  GRANT EXECUTE ON FUNCTION public.prover_rac_bump_prepay(uuid) TO authenticated;`;
const customerPayload = (customer, extra) => `jsonb_build_object('farm_name', (SELECT farm_name FROM public.customers WHERE id = '${customer}'),
    'assigned_sales_rep', (SELECT assigned_sales_rep FROM public.customers WHERE id = '${customer}'),
    'row_version_expected', (SELECT row_version FROM public.customers WHERE id = '${customer}'),
    'phone', '555-0100') || ${extra}`;
const saveCustomer = (uid, customer, extra = "'{}'::jsonb", key = 'k') => `public.save_customer('${customer}', ${customerPayload(customer, extra)}, '[]'::jsonb, '${uid}', 'prover-rac-sc-${key}')->>'customer_id'`;
const splitTo = (uid) => `jsonb_build_object('default_commission_split', jsonb_build_object('splits', jsonb_build_array(jsonb_build_object('recipient_user_id', '${uid}', 'percentage', 100))))`;
const visible = (tbl, where = '') => `(SELECT count(*) FROM public.${tbl} WHERE customer_id IN ('${C1}', '${C2}', '${C3}', '${C4}') ${where})`;
const PROVER_CUSTOMERS = `(SELECT string_agg(farm_name, ',' ORDER BY farm_name) FROM public.customers WHERE id::text LIKE '7a300000-%')`;
const balances = `(SELECT string_agg(farm_name, ',' ORDER BY farm_name) FROM public.get_customer_balance_listing(${TODAY}) WHERE farm_name LIKE '[PROVER]%')`;
const balanceFixture = `${adminPosted(C4, 'bal4', `, 'salesman_id', '${U.REP}'`)}
  ${adminPosted(C3, 'bal3')}`;
const factCall = (customer) => `(public.log_customer_fact(p_customer_id => '${customer}', p_category => 'agronomy', p_fact_key => 'prover_key',
    p_value_text => '[PROVER] fact', p_value_json => NULL, p_confidence => NULL, p_expires_at => NULL, p_save_verified => false,
    p_idempotency_key => 'prover-rac-fact-${customer.slice(-2)}')) IS NOT NULL`;
const interactionCall = (customer) => `(public.log_customer_interaction('${customer}', 'call', 'outbound', now(), '[PROVER] call', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    'prover-rac-int-${customer.slice(-2)}')) IS NOT NULL`;
const rows = (fn) => `(SELECT count(*) FROM (SELECT ${fn}) x)`;

const DENIED_ROW = /^42501\|new row violates row-level security policy/;
const RLS_HIDDEN = /^ok\|0$/;
const OK = /^ok\|/;
/**
 * [label, uid, call, opts, before, after]. before/after are regexes; the string 'same' means the
 * normalized result must be identical before and after (the admin and other-role cases).
 */
const CASES = [
  // Reading customers.
  ['rep sees customers', U.REP, PROVER_CUSTOMERS, {}, /^ok\|\[PROVER\] Rep Farm,\[PROVER\] Rep Farm Two$/, /^ok\|\[PROVER\] No Rep Farm,\[PROVER\] Rep B Farm,\[PROVER\] Rep Farm,\[PROVER\] Rep Farm Two$/],
  ['admin sees customers', U.ADMIN, PROVER_CUSTOMERS, {}, 'same', 'same'],
  ['driver sees customers', U.DRIVER, PROVER_CUSTOMERS, {}, /^ok\|<null>$/, 'same'],
  ['applicator sees customers', U.APPLICATOR, PROVER_CUSTOMERS, {}, /^ok\|<null>$/, 'same'],
  ['deactivated rep sees customers', U.REP_OFF, PROVER_CUSTOMERS, {}, /^ok\|<null>$/, 'same'],

  // Invoicing.
  ['rep saves invoice for unassigned customer', U.REP, `(SELECT status || ':' || salesman_id FROM public.invoices WHERE id = current_setting('prover.mine')::uuid)`,
    { pre: `PERFORM set_config('prover.mine', (${misc(C4, 'rep4', `, 'salesman_id', '${U.REP}'`)})::text, true);` }, /CUSTOMER_SCOPE_DENIED/, new RegExp(`^ok\\|draft:${U.REP}$`)],
  ['rep saves invoice for another rep\'s customer', U.REP, `${misc(C3, 'rep3')} IS NOT NULL`, {}, /CUSTOMER_SCOPE_DENIED/, /^ok\|true$/],
  // Another salesperson's existing invoice: refused after. Before, it was refused on another rep's
  // customer and ALLOWED on the rep's own customer (the assigned-customer rule was the only gate).
  ['rep posts another rep\'s draft on that rep\'s customer', U.REP, `public.post_invoice(current_setting('prover.inv')::uuid, 'prover-rac-xpost') IS NULL`, { fixture: adminDraft(C3, 'x3', `, 'salesman_id', '${U.REP_B}'`) }, /CUSTOMER_SCOPE_DENIED/, /INVOICE_SCOPE_DENIED/],
  ['rep posts another rep\'s draft on the rep\'s own customer', U.REP, `public.post_invoice(current_setting('prover.inv')::uuid, 'prover-rac-xpost1') IS NULL`, { fixture: adminDraft(C1, 'x1', `, 'salesman_id', '${U.REP_B}'`) }, /^ok\|/, /INVOICE_SCOPE_DENIED/],
  ['rep edits another rep\'s draft', U.REP, `public.save_invoice(jsonb_build_object('id', current_setting('prover.inv'), 'customer_id', '${C4}', 'invoice_type', 'misc_charge', 'status', 'draft', 'invoice_date', ${TODAY}, 'salesman_id', '${U.REP}', 'header_notes', '[PROVER] takeover'), jsonb_build_array(jsonb_build_object('description', '[PROVER] fee', 'quantity', 1, 'unit_price_cents', 1500, 'extended_cents', 1500)), 'prover-rac-takeover') IS NOT NULL`, { fixture: adminDraft(C4, 'x4', `, 'salesman_id', '${U.REP_B}'`) }, /CUSTOMER_SCOPE_DENIED/, /INVOICE_SCOPE_DENIED/],
  // The rep created it, but it now names another salesperson (an admin moved it): not the rep's to post.
  ['rep posts an invoice they created that now names another salesperson', U.REP, `public.post_invoice(current_setting('prover.inv')::uuid, 'prover-rac-moved') IS NULL`,
    { fixture: `${adminDraft(C4, 'moved', `, 'salesman_id', '${U.REP_B}'`)}
  UPDATE public.invoices SET created_by = '${U.REP}' WHERE id = current_setting('prover.inv')::uuid;` }, /CUSTOMER_SCOPE_DENIED/, /INVOICE_SCOPE_DENIED/],
  // Codex P1 on #907 / Luna r4: a rep's invoice is always saved under the rep's own name, so "No
  // Salesman" neither blanks an existing invoice nor leaves a new one unattributed.
  ['rep saves an invoice that names them with No Salesman', U.REP, `(SELECT salesman_id FROM public.invoices WHERE id = current_setting('prover.inv')::uuid)`,
    { fixture: adminDraft(C4, 'blank', `, 'salesman_id', '${U.REP}'`), pre: `PERFORM public.save_invoice(jsonb_build_object('id', current_setting('prover.inv'), 'customer_id', '${C4}', 'invoice_type', 'misc_charge', 'status', 'draft', 'invoice_date', ${TODAY}, 'salesman_id', NULL, 'header_notes', '[PROVER] blank'), jsonb_build_array(jsonb_build_object('description', '[PROVER] fee', 'quantity', 1, 'unit_price_cents', 1500, 'extended_cents', 1500)), 'prover-rac-blank');` },
    /CUSTOMER_SCOPE_DENIED/, new RegExp(`^ok\\|${U.REP}$`)],
  ['rep saves a new invoice with No Salesman', U.REP, `(SELECT salesman_id FROM public.invoices WHERE id = current_setting('prover.mine')::uuid)`,
    { pre: `PERFORM set_config('prover.mine', (${misc(C4, 'nosales', `, 'salesman_id', NULL`)})::text, true);` }, /CUSTOMER_SCOPE_DENIED/, new RegExp(`^ok\\|${U.REP}$`)],
  ['rep re-saves an invoice that names them', U.REP, `public.save_invoice(jsonb_build_object('id', current_setting('prover.inv'), 'customer_id', '${C4}', 'invoice_type', 'misc_charge', 'status', 'draft', 'invoice_date', ${TODAY}, 'salesman_id', '${U.REP}', 'header_notes', '[PROVER] keep'), jsonb_build_array(jsonb_build_object('description', '[PROVER] fee', 'quantity', 1, 'unit_price_cents', 1500, 'extended_cents', 1500)), 'prover-rac-keep') IS NOT NULL`, { fixture: adminDraft(C4, 'keep', `, 'salesman_id', '${U.REP}'`) }, /CUSTOMER_SCOPE_DENIED/, /^ok\|true$/],
  ['rep names another salesperson', U.REP, `${misc(C1, 'repname', `, 'salesman_id', '${U.REP_B}'`)} IS NOT NULL`, {}, /SALESMAN_SCOPE_DENIED/, /SALESMAN_SCOPE_DENIED/],
  ['rep posts admin draft for unassigned customer', U.REP, `(SELECT status FROM public.invoices WHERE id = current_setting('prover.inv')::uuid)`,
    { fixture: adminDraft(C4, 'p4', `, 'salesman_id', '${U.REP}'`), pre: `PERFORM public.post_invoice(current_setting('prover.inv')::uuid, 'prover-rac-reppost');` },
    /CUSTOMER_SCOPE_DENIED/, /^ok\|posted$/],
  ['rep saves and posts own invoice for another rep\'s customer', U.REP, `(SELECT status || ':' || salesman_id FROM public.invoices WHERE id = current_setting('prover.mine')::uuid)`,
    { pre: `PERFORM set_config('prover.mine', (${misc(C3, 'own3', `, 'salesman_id', '${U.REP}'`)})::text, true);
  PERFORM public.post_invoice(current_setting('prover.mine')::uuid, 'prover-rac-ownpost');` },
    /CUSTOMER_SCOPE_DENIED/, new RegExp(`^ok\\|posted:${U.REP}$`)],
  ['admin saves and posts for unassigned customer', U.ADMIN, `(SELECT status FROM public.invoices WHERE id = current_setting('prover.inv')::uuid)`, { fixture: adminPosted(C4, 'a4') }, 'same', 'same'],
  ['driver saves invoice', U.DRIVER, `${misc(C1, 'drv')} IS NOT NULL`, {}, /INSUFFICIENT_ROLE/, 'same'],
  ['deactivated rep saves invoice', U.REP_OFF, `${misc(C1, 'off')} IS NOT NULL`, {}, /INSUFFICIENT_ROLE/, 'same'],
  ['rep B posts an invoice group of rep\'s customers named for rep B', U.REP_B, `public.post_invoice_group(current_setting('prover.group')::uuid, '${U.REP_B}', 'prover-rac-gp-b') IS NOT NULL`, { fixture: adminGroupForRepB }, /CUSTOMER_SCOPE_DENIED/, /^ok\|true$/],
  ['rep B posts an admin\'s invoice group', U.REP_B, `public.post_invoice_group(current_setting('prover.group')::uuid, '${U.REP_B}', 'prover-rac-gp-b2') IS NOT NULL`, { fixture: adminGroup }, /CUSTOMER_SCOPE_DENIED/, /INVOICE_SCOPE_DENIED/],
  ['admin posts invoice group', U.ADMIN, `public.post_invoice_group(current_setting('prover.group')::uuid, '${U.ADMIN}', 'prover-rac-gp-a') IS NOT NULL`, { fixture: adminGroup }, 'same', 'same'],
  ['rep B split-bills rep\'s customers', U.REP_B, `(${splitCall(U.REP_B, 'prover-rac-fas-b')})->>'invoice_group_id' IS NOT NULL`, { fixture: splitJob }, /SPLIT_(CUSTOMER|JOB)_NOT_ASSIGNED/, /^ok\|true$/],
  ['admin split-bills', U.ADMIN, `(${splitCall(U.ADMIN, 'prover-rac-fas-a')})->>'invoice_group_id' IS NOT NULL`, { fixture: splitJob }, 'same', 'same'],
  ['rep B resolves a split of rep\'s field', U.REP_B, `jsonb_array_length(public.resolve_line_split_vector(ARRAY['${F_SHARED}']::uuid[], NULL, jsonb_build_object('${F_SHARED}', 100)))`, {}, /RESOLVER_NOT_AUTHORIZED/, /^ok\|2$/],
  ['driver resolves a split', U.DRIVER, `jsonb_array_length(public.resolve_line_split_vector(ARRAY['${F_SHARED}']::uuid[], NULL, jsonb_build_object('${F_SHARED}', 100)))`, {}, /Not authorized/, 'same'],

  // Reports.
  ['rep reads statement of unassigned customer', U.REP, rows(`public.get_customer_statement('${C4}')`), { fixture: adminPosted(C4, 'st4') }, /CUSTOMER_SCOPE_DENIED/, /^ok\|[1-9]/],
  ['admin reads statement', U.ADMIN, rows(`public.get_customer_statement('${C4}')`), { fixture: adminPosted(C4, 'st4a') }, 'same', 'same'],
  ['driver reads statement', U.DRIVER, rows(`public.get_customer_statement('${C4}')`), {}, /INSUFFICIENT_ROLE/, 'same'],
  ['rep reads year-end of another rep\'s customer', U.REP, `public.get_customer_year_end_summary('${C3}', ${SEASON}) IS NOT NULL`, {}, /CUSTOMER_SCOPE_DENIED/, /^ok\|true$/],
  ['rep reads prep card of unassigned customer', U.REP, `public.get_customer_prep_card('${C4}') IS NOT NULL`, {}, /PURCHASE_INTELLIGENCE_ACCESS_DENIED/, /^ok\|true$/],
  ['rep reads lapsed products of unassigned customer', U.REP, `public.get_customer_lapsed_products('${C4}') IS NOT NULL`, {}, /PURCHASE_INTELLIGENCE_ACCESS_DENIED/, /^ok\|true$/],
  ['rep reads purchase summary of unassigned customer', U.REP, `public.get_customer_purchase_summary('${C4}', ${SEASON}::text) IS NOT NULL`, {}, /PURCHASE_INTELLIGENCE_ACCESS_DENIED/, /^ok\|true$/],
  ['rep lists balances (own invoices only)', U.REP, balances, { fixture: balanceFixture }, /^ok\|<null>$/, /^ok\|\[PROVER\] No Rep Farm$/],
  ['admin lists balances', U.ADMIN, balances, { fixture: balanceFixture }, 'same', 'same'],

  // Editing customers.
  ['rep edits another rep\'s customer', U.REP, saveCustomer(U.REP, C3), {}, /NOT_CUSTOMER_OWNER/, new RegExp(`^ok\\|${C3}$`)],
  ['rep edits own customer', U.REP, saveCustomer(U.REP, C1), {}, new RegExp(`^ok\\|${C1}$`), 'same'],
  ['rep reassigns via save_customer', U.REP, saveCustomer(U.REP, C4, `jsonb_build_object('assigned_sales_rep', '${U.REP}')`), {}, /NOT_CUSTOMER_OWNER/, /REP_CANNOT_REASSIGN/],
  // A page loaded before an admin reassigned the customer sends the OLD rep and row version back: it
  // must get the reload prompt, not read as a reassignment.
  ['rep saves from a stale page after a reassignment', U.REP, saveCustomer(U.REP, C3, `jsonb_build_object('assigned_sales_rep', '${U.REP}', 'row_version_expected', (SELECT row_version - 1 FROM public.customers WHERE id = '${C3}'))`), {}, /NOT_CUSTOMER_OWNER/, /CUSTOMER_STALE_WRITE/],
  ['rep changes another rep\'s commission split via save_customer', U.REP, saveCustomer(U.REP, C3, splitTo(U.REP)), {}, /NOT_CUSTOMER_OWNER/, /COMMISSION_SPLIT_ADMIN_OR_ASSIGNED_REP/],
  ['rep re-saves another rep\'s unchanged split', U.REP, saveCustomer(U.REP, C3, `jsonb_build_object('default_commission_split', (SELECT default_commission_split FROM public.customers WHERE id = '${C3}'))`), {}, /NOT_CUSTOMER_OWNER/, new RegExp(`^ok\\|${C3}$`)],
  ['rep changes own commission split', U.REP, saveCustomer(U.REP, C1, splitTo(U.REP_B)), {}, new RegExp(`^ok\\|${C1}$`), 'same'],
  ['admin reassigns and re-splits via save_customer', U.ADMIN, saveCustomer(U.ADMIN, C4, `jsonb_build_object('assigned_sales_rep', '${U.REP}') || ${splitTo(U.REP)}`), {}, 'same', 'same'],
  ['rep direct-updates notes of another rep\'s customer', U.REP, `UPDATE public.customers SET notes = '[PROVER] note' WHERE id = '${C3}'`, { statement: true }, RLS_HIDDEN, /^ok\|1$/],
  ['rep direct-reassigns unassigned customer', U.REP, `UPDATE public.customers SET assigned_sales_rep = '${U.REP}' WHERE id = '${C4}'`, { statement: true }, RLS_HIDDEN, /REP_CANNOT_REASSIGN/],
  ['rep direct-reassigns own customer away', U.REP, `UPDATE public.customers SET assigned_sales_rep = '${U.REP_B}' WHERE id = '${C1}'`, { statement: true }, DENIED_ROW, /REP_CANNOT_REASSIGN/],
  ['rep direct-changes another rep\'s split', U.REP, `UPDATE public.customers SET default_commission_split = jsonb_build_object('splits', jsonb_build_array(jsonb_build_object('recipient_user_id', '${U.REP}', 'percentage', 100))) WHERE id = '${C3}'`, { statement: true }, RLS_HIDDEN, /COMMISSION_SPLIT_ADMIN_OR_ASSIGNED_REP/],
  ['rep direct-changes own split', U.REP, `UPDATE public.customers SET default_commission_split = jsonb_build_object('splits', jsonb_build_array(jsonb_build_object('recipient_user_id', '${U.REP_B}', 'percentage', 100))) WHERE id = '${C1}'`, { statement: true }, /^ok\|1$/, 'same'],
  ['admin direct-reassigns', U.ADMIN, `UPDATE public.customers SET assigned_sales_rep = '${U.REP_B}' WHERE id = '${C4}'`, { statement: true }, 'same', 'same'],
  ['rep deactivates a customer with an open invoice', U.REP, `UPDATE public.customers SET is_active = false WHERE id = '${C3}'`, { statement: true, fixture: adminPosted(C3, 'open3') }, RLS_HIDDEN, /CUSTOMER_HAS_OPEN_INVOICES/],
  ['rep deactivates own customer with an open invoice', U.REP, `UPDATE public.customers SET is_active = false WHERE id = '${C1}'`, { statement: true, fixture: adminPosted(C1, 'open1') }, /^ok\|1$/, /CUSTOMER_HAS_OPEN_INVOICES/],
  ['rep deactivates a customer with no open invoice', U.REP, `UPDATE public.customers SET is_active = false WHERE id = '${C4}'`, { statement: true }, RLS_HIDDEN, /^ok\|1$/],
  ['admin deactivates a customer with an open invoice', U.ADMIN, `UPDATE public.customers SET is_active = false WHERE id = '${C3}'`, { statement: true, fixture: adminPosted(C3, 'open3a') }, 'same', 'same'],
  ['rep edits a prepay balance directly', U.REP, `UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 100 WHERE id = '${C1}'`, { statement: true }, /^ok\|1$/, /PREPAY_BALANCE_SERVER_ONLY/],
  ['rep changes a prepay balance through a server function', U.REP, `public.prover_rac_bump_prepay('${C1}')`, { fixture: serverPrepayFn }, /^ok\|100$/, 'same'],
  ['admin edits a prepay balance directly', U.ADMIN, `UPDATE public.customers SET prepay_balance_cents = prepay_balance_cents + 100 WHERE id = '${C4}'`, { statement: true }, 'same', 'same'],
  ['rep clears an unset split on another rep\'s customer', U.REP, `UPDATE public.customers SET default_commission_split = 'null'::jsonb WHERE id = '${C4}'`, { statement: true }, RLS_HIDDEN, /^ok\|1$/],
  ['rep inserts a customer with a prepay balance', U.REP, `INSERT INTO public.customers (farm_name, assigned_sales_rep, prepay_balance_cents) VALUES ('[PROVER] New Farm', '${U.REP}', 100000)`, { statement: true }, /^ok\|1$/, /PREPAY_BALANCE_SERVER_ONLY/],
  ['rep inserts a customer with no prepay balance', U.REP, `INSERT INTO public.customers (farm_name, assigned_sales_rep) VALUES ('[PROVER] New Farm 2', '${U.REP}')`, { statement: true }, /^ok\|1$/, 'same'],
  ['driver direct-updates a customer', U.DRIVER, `UPDATE public.customers SET notes = 'x' WHERE id = '${C1}'`, { statement: true }, RLS_HIDDEN, 'same'],

  // Customer-related records.
  ['rep adds contact to unassigned customer', U.REP, `INSERT INTO public.customer_contacts (customer_id, name) VALUES ('${C4}', '[PROVER] Contact')`, { statement: true }, DENIED_ROW, /^ok\|1$/],
  // No role holds INSERT on customer_addresses (save_customer writes addresses); unchanged.
  ['rep inserts an address directly', U.REP, `INSERT INTO public.customer_addresses (customer_id, label, address_line) VALUES ('${C3}', '[PROVER]', '1 Road')`, { statement: true }, /^42501\|permission denied for table customer_addresses$/, 'same'],
  ['rep saves an address on another rep\'s customer', U.REP, `(SELECT count(*) FROM public.customer_addresses WHERE customer_id = '${C3}')`,
    { pre: `PERFORM public.save_customer('${C3}', ${customerPayload(C3, "'{}'::jsonb")}, jsonb_build_array(jsonb_build_object('label', '[PROVER] Yard', 'address_line', '1 Road', 'is_default', true)), '${U.REP}', 'prover-rac-addr');` },
    /NOT_CUSTOMER_OWNER/, /^ok\|1$/],
  ['rep sees another rep\'s documents', U.REP, visible('customer_documents'), {}, /^ok\|0$/, /^ok\|1$/],
  ['rep removes another rep\'s document', U.REP, `public.soft_delete_customer_document('${DOC3}', '${C3}', 'prover-rac-doc') IS NOT NULL`, {}, /CUSTOMER_DOCUMENT_NOT_FOUND/, /^ok\|true$/],
  ['rep logs a fact on unassigned customer', U.REP, factCall(C4), {}, /FACT_ACCESS_DENIED/, /^ok\|true$/],
  ['rep logs an interaction on unassigned customer', U.REP, interactionCall(C4), {}, /INTERACTION_ACCESS_DENIED/, /^ok\|true$/],
  ['rep links an external id to unassigned customer', U.REP, `INSERT INTO public.external_identities (customer_id, provider, external_id) VALUES ('${C4}', 'prover', 'x-1')`, { statement: true }, DENIED_ROW, /^ok\|1$/],
  ['driver sees documents', U.DRIVER, visible('customer_documents'), {}, /^ok\|0$/, 'same'],
];

function runMatrix(phase) {
  const out = {};
  for (const [label, uid, call, opts] of CASES) out[label] = attempt(uid, call, opts);
  console.log(`[prover] ${phase}: ${CASES.length} cases run`);
  return out;
}
function check(phase, results, baseline = null) {
  const failures = [];
  for (const [label, , , , before, after] of CASES) {
    const want = phase === 'before' ? before : after;
    const got = results[label];
    if (want === 'same') {
      if (phase === 'before') continue;
      const ref = baseline[label];
      if (normalize(got) !== normalize(ref)) failures.push(`${label}: changed from "${ref}" to "${got}"`);
      if (before !== 'same' && !before.test(ref)) failures.push(`${label}: before was "${ref}"`);
    } else if (!want.test(got)) {
      failures.push(`${label}: got "${got}", expected ${want}`);
    }
  }
  assert.deepEqual(failures, [], `${phase.toUpperCase()} failed:\n  ${failures.join('\n  ')}`);
  console.log(`[prover] ${phase.toUpperCase()}: all ${CASES.length} cases as expected`);
}

function preflightRefusesDrift() {
  stageText('cand.sql', lf(CANDIDATE));
  const r = docker([...psqlArgs()], {
    input: `BEGIN;
CREATE OR REPLACE FUNCTION public.get_customer_prep_card(p_customer_id uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
\\i /tmp/cand.sql
ROLLBACK;`,
    allowFailure: true,
  });
  assert.notEqual(r.status, 0, 'the candidate applied over a drifted body');
  assert.match(r.stderr, /REPS_ANY_CUSTOMER_PREFLIGHT: public\.get_customer_prep_card\(uuid\) drifted/, `wrong refusal:\n${r.stderr}`);
  console.log('[prover] PREFLIGHT: a drifted body aborts the candidate before any change');
}

function main() {
  if (process.env.CRX_PROVER_BUILD_ONLY === '1') {
    assert.ok(KEEP, 'CRX_PROVER_BUILD_ONLY needs CRX_PROVER_KEEP_CONTAINER=1');
  }
  if (!REUSE) buildContainer();
  else assert.equal(scalar("SELECT count(*) FROM pg_trigger WHERE tgname = 'customers_guard_rep_edit_20261013';"), '0',
    'the reused container already has the candidate applied (it is in the AFTER state); rebuild it');
  fidelity();
  if (scalar("SELECT count(*) FROM public.profiles WHERE id::text LIKE '7a300000-%';") === '0') seed();
  if (process.env.CRX_PROVER_BUILD_ONLY === '1') {
    // Dev aid: stop at the BEFORE state (seeded, candidate not applied) so other chains can be run
    // against the same real schema before and after applying the candidate by hand.
    console.log(`[prover] BUILD ONLY: ${NAME} kept in the BEFORE state; the proof did not run`);
    return;
  }

  const before = runMatrix('before');
  check('before', before);
  preflightRefusesDrift();

  stageText('candidate.sql', lf(CANDIDATE));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  console.log('[prover] candidate applied');

  const after = runMatrix('after');
  check('after', after, before);

  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /REPS_ANY_CUSTOMER_PREFLIGHT/, `second apply refused for the wrong reason:\n${again.output}`);
  console.log('[prover] RE-APPLY: refused by the preflight, nothing changed');

  const mutant = attempt(U.REP, `UPDATE public.customers SET assigned_sales_rep = '${U.REP}' WHERE id = '${C4}'`,
    { statement: true, fixture: 'DROP TRIGGER customers_guard_rep_edit_20261013 ON public.customers;' });
  assert.equal(mutant, 'ok|1', `MUTATION: without the guard trigger the rep's reassignment should succeed, got ${mutant}`);
  console.log('[prover] MUTATION: without customers_guard_rep_edit_20261013 the reassignment goes through, so the refusal is the trigger');

  console.log('REPS_ANY_CUSTOMER_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
