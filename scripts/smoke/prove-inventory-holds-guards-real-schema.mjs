#!/usr/bin/env node
/**
 * Full-chain proof for the 20261025090000 candidate (To-Do rows 0.13, 0.14 and the holds half of
 * 6.9): a retired product with an open purchase order stays in get_inventory_position(), the
 * public create_inventory_hold() makes manual holds only, run_data_integrity_sweep() reports stuck
 * job holds and orphaned program holds, and deleting a product with holds is refused instead of
 * wiping them.
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate, checks
 * the candidate's md5 pins against the replayed bodies, seeds one active admin, then runs the live
 * smoke chain scripts/smoke/smoke-inventory-holds-guards.sql:
 *   BEFORE the candidate it must FAIL at step (a) (the retired product is missing);
 *   AFTER it must end in SMOKE_PASS_ROLLBACK, with steps (a)-(d) all passing.
 * Also: each pre-candidate behaviour on its own (a crop_program hold is accepted, the sweep has no
 * new keys, a product delete cascades its holds), the preflight refuses a second apply, and the
 * grants and definer settings of the three replaced functions are unchanged.
 *
 * Run: node scripts/smoke/prove-inventory-holds-guards-real-schema.mjs   (needs Docker)
 * Prints INVENTORY_HOLDS_GUARDS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Always a fresh, network-disabled container this run creates.
const NAME = `crx-holds-guards-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261025090000_inventory_holds_and_retired_on_order_guards.sql');
const CHAIN = path.join(ROOT, 'scripts', 'smoke', 'smoke-inventory-holds-guards.sql');
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
// A later or parked file that (re)defines anything the candidate changes.
const TOUCHED = /(FUNCTION\s+(public\.)?"?(_get_inventory_position_cost_impl_20261019|get_inventory_position|create_inventory_hold|run_data_integrity_sweep)\b|inventory_holds_product_id_fkey|integrity_alerts_alert_type_check)/i;
const PINS = {
  'public._get_inventory_position_cost_impl_20261019()': 'd05f13e24acd32425bb76b4114b60859',
  'public.create_inventory_hold(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)': '38957fa369e6575d980af8dbbad29d30',
  'public.run_data_integrity_sweep()': '635e708a5b9c2ec3c9d9310d8348ddf0',
};
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
const ADMIN = '7c730000-0000-4000-8000-0000000000a1';

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
  const before = all.slice(0, at);
  for (const file of all.slice(at + 1)) {
    assert.ok(!TOUCHED.test(lf(file)), `${path.basename(file)} sorts after the candidate and touches what it changes; re-think this proof`);
  }
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!TOUCHED.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
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
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb);
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  const files = plan();
  let replayed = 0;
  for (const [i, file] of files.entries()) {
    const base = path.basename(file);
    if (PARKED.has(base)) continue;
    for (const only of LEDGER_ONLY) if (only < base) ledger(path.basename(only, '.sql'));
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate`);
}

// FIDELITY: the candidate pins each body it replaces, and the replayed bodies match those pins.
function fidelity() {
  const preflight = lf(CANDIDATE).split('$preflight$')[1];
  for (const [sig, pin] of Object.entries(PINS)) {
    assert.ok(preflight.includes(`'${pin}'`), `the candidate preflight must pin ${sig}`);
    assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${sig}'::regprocedure;`), pin,
      `${sig} replayed with a body that differs from the live pin of 2026-10-25`);
  }
  console.log('[prover] FIDELITY: the three replayed bodies match the live md5 pins of 2026-10-25');
}

function seed() {
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES ('${ADMIN}', 'holds-guards-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb);`);
  // The role is set directly too (past _guard_profile_role_lock), in case handle_new_user no longer
  // honours the metadata role.
  psql(`SET session_replication_role = replica;
    UPDATE public.profiles SET role = 'admin', is_active = true WHERE id = '${ADMIN}';
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT string_agg(role || ':' || is_active, ',') FROM public.profiles WHERE role = 'admin' AND is_active;"),
    'admin:true', 'the proof needs exactly one active admin');
  console.log('[prover] seeded one active admin');
}

// Runs the live smoke chain; returns the error text it ended with.
function runChain() {
  stageText('chain.sql', lf(CHAIN));
  const r = docker([...psqlArgs(), '-f', '/tmp/chain.sql'], { allowFailure: true });
  assert.notEqual(r.status, 0, 'the smoke chain must always end in an error');
  return r.stderr;
}

// One rolled-back probe as the owner or the admin; prints "RESULT|ok|<value>" or "RESULT|<sqlstate>|<message>".
function probe(body) {
  const r = docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
DO $probe$
DECLARE v text; p uuid;
BEGIN
  ${body}
  RAISE NOTICE 'RESULT|ok|%', COALESCE(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'RESULT|%|%', SQLSTATE, replace(SQLERRM, chr(10), ' ');
END
$probe$;
ROLLBACK;`, allowFailure: true });
  assert.equal(r.status, 0, `probe failed to run:\n${r.stderr}`);
  const m = /RESULT\|([^\n]*)/.exec(r.stderr);
  assert.ok(m, `probe printed no RESULT:\n${r.stderr}`);
  return m[1].trimEnd();
}
const CROP_HOLD = `INSERT INTO public.products (product_name, is_active) VALUES ('[PROVER] crop', true) RETURNING id INTO p;
  EXECUTE 'SET LOCAL ROLE authenticated';
  v := public.create_inventory_hold(p, NULL, 1, 'crop_program', NULL, 'x', '${ADMIN}', true, 'r', 'k-crop') ->> 'hold_id';
  EXECUTE 'RESET ROLE';
  v := (SELECT hold_type || ':' || (source_id IS NULL)::text FROM public.inventory_holds WHERE id = v::uuid);`;
const SWEEP_KEYS = `PERFORM set_config('request.jwt.claims', '', true); PERFORM set_config('request.jwt.claim.sub', '', true);
  v := (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(public.run_data_integrity_sweep()) k);`;
const DELETE_CASCADE = `INSERT INTO public.products (product_name, is_active) VALUES ('[PROVER] del', true) RETURNING id INTO p;
  INSERT INTO public.inventory_holds (product_id, quantity, hold_type, source_id, created_by, is_active) VALUES (p, 1, 'job', gen_random_uuid(), '${ADMIN}', true);
  DELETE FROM public.products WHERE id = p;
  v := (SELECT count(*)::text FROM public.inventory_holds WHERE product_id = p);`;
const SWEEP_BASE = 'new_booking_overdraws,new_negative_inventory,new_negative_invoice_balance,new_stale_quote_holds,success';

function before() {
  const err = runChain();
  assert.match(err, /SMOKE_FAIL: \(a\) the retired product with an open PO line is missing from get_inventory_position/,
    `BEFORE: the chain should fail at (a), got:\n${err}`);
  assert.equal(probe(CROP_HOLD), 'ok|crop_program:true', 'BEFORE: the public path should accept a crop_program hold with no source');
  assert.equal(probe(SWEEP_KEYS), `ok|${SWEEP_BASE}`, 'BEFORE: the sweep should not have the new checks');
  assert.equal(probe(DELETE_CASCADE), 'ok|0', 'BEFORE: deleting a product should cascade its holds');
  console.log('[prover] BEFORE: the chain fails at (a); a sourceless crop_program hold is accepted; the sweep lacks the new checks; a product delete wipes its holds');
}

function after() {
  const err = runChain();
  assert.match(err, /SMOKE_PASS_ROLLBACK/, `AFTER: the chain should pass, got:\n${err}`);
  assert.doesNotMatch(err, /SMOKE_FAIL/);
  assert.match(probe(CROP_HOLD), /^P0001\|HOLD_TYPE_NOT_ALLOWED: create_inventory_hold creates manual holds only \(got crop_program\)$/);
  assert.equal(probe(SWEEP_KEYS), `ok|${SWEEP_BASE.replace('new_stale_quote_holds', 'new_orphan_quote_holds,new_stale_quote_holds,new_stuck_job_holds')}`);
  assert.match(probe(DELETE_CASCADE), /^23503\|.*inventory_holds_product_id_fkey/);
  console.log('[prover] AFTER: the chain passes (a)-(d) and ends in SMOKE_PASS_ROLLBACK; a crop_program hold is refused; the sweep has the two new checks; a product delete is refused');
}

function security() {
  const rows = docker([...psqlArgs(), '-A', '-t', '-F', '|'], { input: `SELECT p.oid::regprocedure::text,
      has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      has_function_privilege('service_role', p.oid, 'EXECUTE'), p.prosecdef, array_to_string(p.proconfig, ';'), pg_get_userbyid(p.proowner)
    FROM pg_proc p WHERE p.oid IN ('public._get_inventory_position_cost_impl_20261019()'::regprocedure,
      'public.create_inventory_hold(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)'::regprocedure,
      'public.run_data_integrity_sweep()'::regprocedure, 'public.get_inventory_position()'::regprocedure) ORDER BY 1;` }).stdout.trim().split(/\r?\n/);
  assert.deepEqual(rows, [
    '_get_inventory_position_cost_impl_20261019()|f|f|f|t|search_path=public, pg_temp|postgres',
    'create_inventory_hold(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)|f|t|t|t|search_path=public, pg_temp|postgres',
    'get_inventory_position()|f|t|t|t|search_path=public, pg_temp|postgres',
    'run_data_integrity_sweep()|f|f|t|t|search_path=public, pg_temp|postgres',
  ]);
  console.log('[prover] SECURITY: owners, EXECUTE grants, SECURITY DEFINER and search_path unchanged');
}

function secondApplyRefused() {
  stageText('again.sql', lf(CANDIDATE));
  const r = apply('again.sql');
  assert.notEqual(r.status, 0, 'the candidate applied twice');
  assert.match(r.output, /INVENTORY_HOLDS_GUARDS_PREFLIGHT: public\._get_inventory_position_cost_impl_20261019\(\) changed since 2026-10-25/);
  console.log('[prover] PREFLIGHT: a second apply is refused');
}

function main() {
  const started = Date.now();
  buildContainer();
  fidelity();
  seed();
  before();
  stageText('candidate.sql', lf(CANDIDATE));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  console.log('[prover] candidate applied');
  after();
  security();
  secondApplyRefused();
  console.log(`[prover] finished in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log('INVENTORY_HOLDS_GUARDS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
