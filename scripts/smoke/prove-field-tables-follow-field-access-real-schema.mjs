#!/usr/bin/env node
/**
 * Real-schema proof for the 20261023110000 candidate: field tables follow field access
 * (To-Do row 11.4, part B).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (part A,
 * 20261023090000, included; the same skips as the other real-schema provers), seeds office staff,
 * applicators reached by every route (per-field dispatch on two split jobs that share both fields,
 * whole-job, ground crew), a driver, an entity_recipient profile and an inactive applicator, ten
 * fields with one row in every field table each, and the dispatches that do and do not reach them,
 * then, each read or write made as that signed-in user (role authenticated, JWT claims, row
 * security on) and rolled back:
 *   0. FIDELITY: the four replayed bodies, _can_see_field, the eight SELECT policies and the three
 *      field_polygons write policies are the live ones the preflight pins, and each body loses or
 *      gains only the marked code lines;
 *   1. BEFORE: every active applicator reads every field through fields, field_polygons, crop
 *      history, obstacles, field-application locations and their shares, and adds, rewrites and
 *      deletes any field's boundary parts; every active profile (drivers, the entity_recipient)
 *      reads every billing split and spray-record field; the split-job assignee reads each job's
 *      other field through job_fields, the job map, the Dispatch Board and both billed-customer
 *      lookups; every active applicator gets the billed customers of a job with no whole-job
 *      applicator; the container chain smoke-field-tables-follow-field-access.sql fails;
 *   2. AUTOCOMMIT: run statement by statement the file stops at its preflight, nothing changed;
 *   3. the candidate applies and prints POSTFLIGHT_OK; function attributes, _can_see_field and every
 *      other policy unchanged; _can_see_job_field executable by authenticated, not anon;
 *   4. AFTER: each caller reads only the fields of their own current assignments by every route,
 *      and on each job only that job's assigned fields (never one they were sent to on another
 *      job); everyone else none; locations, shares and boundary-part writes are office-only; active
 *      admin and sales rep get exactly what they got before; the chain passes and rolls back;
 *   5. RE-APPLY: refused by the preflight;
 *   6. MUTATION: putting back any one old policy or dropping any one new check reopens its gap.
 *
 * Run: node scripts/smoke/prove-field-tables-follow-field-access-real-schema.mjs   (needs Docker)
 * Prints FIELD_TABLES_FIELD_ACCESS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-field-tables-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261023110000_field_tables_follow_field_access.sql');
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
const COVERED = /fields_select|field_crop_history_select|field_obstacles_select|field_app_locations_select|field_app_location_shares_select|fbd_select|arf_select|job_fields_select_location_dispatchee|get_job_fields_with_geojson|get_dispatch_board_jobs|get_jobs?_billed_customers|_can_see_field/i;


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
    assert.ok(!COVERED.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
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
  // storage.objects carries metadata and a (bucket_id, name) key, and postgres may read it, as live
  // has them: 20261022075000 (replayed before the candidate) checks that shape in its preflight.
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, UNIQUE (bucket_id, name));
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
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




// ------------------------------------------------------------------------------------------------
// Fixture and probes.
// The live bodies and policies of 2026-10-25 (Central) (md5 of prosrc without CR), as the preflight pins them.
const FNS = [
  ['get_job_fields_with_geojson(uuid)', 'c42bf2515ec81fd9727da08757f5d790'],
  ['get_dispatch_board_jobs(uuid,text,date,date)', '7a042e4597ff5cbf4910aec4d75ee11a'],
  ['get_job_billed_customers(uuid)', '84690ba2dd6708c962d117d9be5930f0'],
  ['get_jobs_billed_customers(uuid[])', '258d9f5722a43de1b388931c99b22ee5'],
];
const CAN_SEE_FIELD_MD5 = '0b7f544337f93adc79163cafe581222c';
const POLICIES = [
  ['fields', 'fields_select', '(is_admin() OR is_sales_rep() OR is_applicator())'],
  ['field_crop_history', 'field_crop_history_select', '(is_admin() OR is_sales_rep() OR is_applicator())'],
  ['field_obstacles', 'field_obstacles_select', '(is_admin() OR is_sales_rep() OR is_applicator())'],
  ['field_app_locations', 'field_app_locations_select', '(is_admin() OR is_sales_rep() OR is_applicator())'],
  ['field_app_location_shares', 'field_app_location_shares_select', '(is_admin() OR is_sales_rep() OR is_applicator())'],
  ['field_billing_defaults', 'fbd_select', '( SELECT is_active_profile() AS is_active_profile)'],
  ['application_record_fields', 'arf_select', '(EXISTS ( SELECT 1\n   FROM profiles p\n  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.is_active = true))))'],
  ['job_fields', 'job_fields_select_location_dispatchee', '_is_dispatched_to_me(job_id)'],
];
// field_polygons' write policies: [name, command, USING, WITH CHECK] as live has them.
const POLYGONS_IN_FIELDS = '(field_id IN ( SELECT fields.id\n   FROM fields))';
const POLYGON_WRITES = [
  ['field_polygons_insert', 'INSERT', null, POLYGONS_IN_FIELDS],
  ['field_polygons_update', 'UPDATE', POLYGONS_IN_FIELDS, null],
  ['field_polygons_delete', 'DELETE', POLYGONS_IN_FIELDS, null],
];
const id = (n) => `7a560000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const U = {
  ADMIN: id(1), REP: id(2),
  // Per-field dispatches: F1 of split job J1 (F1+F2), F2 of split job J9 (F1+F2), so F1 and F2
  // are both "its" fields but each on one job only; cancelled F2 on J1, expired F6, recent F8,
  // deleted-job F4.
  APP_A: id(3),
  APP_W: id(4), // whole-job applicator of J2 (F3+F10) and of the deleted J3 (F4)
  APP_C: id(5), // member of an active crew (F5) and an inactive crew (F9)
  DRIVER: id(6), ENTITY: id(7),
  IN_APP: id(8), // inactive applicator with an open dispatch (F7)
  APP_X: id(9), // active applicator assigned nothing
  NO_PROFILE: id(99), // a signed-in JWT with no profile row
};
const C = { P: id(101), C: id(102), O: id(103) };
const NUMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const JOBS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const F = Object.fromEntries(NUMS.map((n) => [`F${n}`, id(200 + n)]));
const J = Object.fromEntries(JOBS.map((n) => [`J${n}`, id(300 + n)]));
const JF = Object.fromEntries([...NUMS, 11, 12].map((n) => [`JF${n}`, id(400 + n)]));
const LOC = Object.fromEntries(NUMS.map((n) => [`L${n}`, id(700 + n)]));
const CREW = { ON: id(501), OFF: id(502) };
const RECORD = id(601);
// Billing defaults: F1 is split between the parent and child farms, F2 and F3 bill the other farm.
const FBD = { F1: [['P', 60, true], ['C', 40, false]], F2: [['O', 100, true]], F3: [['O', 100, true]] };

function seed() {
  // Users through the direct-SQL path of handle_new_user (metadata role honoured), then one
  // deactivated, exactly as the part A prover seeds them.
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  const users = [['ADMIN', 'admin'], ['REP', 'sales_rep'], ['APP_A', 'applicator'], ['APP_W', 'applicator'], ['APP_C', 'applicator'],
    ['DRIVER', 'driver'], ['ENTITY', 'entity_recipient'], ['IN_APP', 'applicator'], ['APP_X', 'applicator']];
  psql(users.map(([k, role]) => `INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES ('${U[k]}', 'field-tables-${k.toLowerCase().replace('_', '-')}@example.invalid', '{"full_name":"[PROVER] ${k}","role":"${role}"}'::jsonb);`).join('\n'));
  psql(`SET session_replication_role = replica;
    ${users.map(([k, role]) => `UPDATE public.profiles SET role = '${role}', is_active = true WHERE id = '${U[k]}';`).join('\n    ')}
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    SELECT set_config('request.jwt.claims', '{"sub":"${U.ADMIN}","role":"authenticated"}', true);
    UPDATE public.profiles SET is_active = false WHERE id = '${U.IN_APP}';
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY id) FROM public.profiles WHERE id::text LIKE '7a560000-%';`),
    'admin:true,sales_rep:true,applicator:true,applicator:true,applicator:true,driver:true,entity_recipient:true,applicator:false,applicator:true',
    'seeded profiles are not as intended');

  // Business rows with triggers off (supabase_admin, replica). One child row of every field table
  // per field, so each probe can name exactly which fields a caller reaches.
  const jf = [['JF1', 'J1', 'F1'], ['JF2', 'J1', 'F2'], ['JF3', 'J2', 'F3'], ['JF4', 'J3', 'F4'], ['JF5', 'J4', 'F5'], ['JF6', 'J5', 'F6'],
    ['JF7', 'J6', 'F7'], ['JF8', 'J7', 'F8'], ['JF9', 'J8', 'F9'], ['JF10', 'J2', 'F10'], ['JF11', 'J9', 'F1'], ['JF12', 'J9', 'F2']];
  const fbd = NUMS.flatMap((n) => (FBD[`F${n}`] ?? [['P', 100, true]]).map(([c, pct, primary]) => `('${F[`F${n}`]}', '${C[c]}', ${pct}, ${primary}, ${c === 'P' ? 1500 : 'NULL'})`));
  psql(`SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, account_number, is_active, parent_customer_id) VALUES
      ('${C.P}', '[PROVER] Parent Farm', 'PRV-P', true, NULL),
      ('${C.C}', '[PROVER] Child Farm',  'PRV-C', true, '${C.P}'),
      ('${C.O}', '[PROVER] Other Farm',  'PRV-O', true, NULL);
    INSERT INTO public.fields (id, customer_id, field_name, total_acres, is_active) VALUES
      ${NUMS.map((n) => `('${F[`F${n}`]}', '${n === 3 ? C.O : C.P}', '[PROVER] F${n}', 10, true)`).join(',\n      ')};
    INSERT INTO public.field_polygons (field_id, polygon_geojson, label, sort_order) VALUES
      ${NUMS.map((n) => `('${F[`F${n}`]}', '{"type":"Polygon","coordinates":[]}', 'A', 1)`).join(', ')};
    INSERT INTO public.field_crop_history (field_id, season, crop_type) VALUES
      ${NUMS.map((n) => `('${F[`F${n}`]}', 2026, 'corn')`).join(', ')};
    INSERT INTO public.field_obstacles (field_id, kind, point_geojson) VALUES
      ${NUMS.map((n) => `('${F[`F${n}`]}', 'other', '{"type":"Point","coordinates":[0,0]}')`).join(', ')};
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary, price_override_cents) VALUES
      ${fbd.join(', ')};
    INSERT INTO public.application_records (id, record_number, source_type, source_id, customer_id, application_date)
      VALUES ('${RECORD}', 'PRV-AR', 'job', '${J.J1}', '${C.P}', current_date);
    INSERT INTO public.application_record_fields (application_record_id, field_id, acres) VALUES
      ${NUMS.map((n) => `('${RECORD}', '${F[`F${n}`]}', 10)`).join(', ')};
    INSERT INTO public.field_app_locations (id, job_id, field_id, total_acres) VALUES
      ${NUMS.map((n) => `('${LOC[`L${n}`]}', '${J.J1}', '${F[`F${n}`]}', 10)`).join(', ')};
    INSERT INTO public.field_app_location_shares (location_id, customer_id, split_pct, acres, amount_cents) VALUES
      ${NUMS.map((n) => `('${LOC[`L${n}`]}', '${C.P}', 100, 10, 2500)`).join(', ')};
    INSERT INTO public.jobs (id, job_number, customer_id, job_date, status, applicator_id, deleted_at) VALUES
      ('${J.J1}', 'PRV-J1', '${C.P}', current_date, 'scheduled', NULL, NULL),
      ('${J.J2}', 'PRV-J2', '${C.O}', current_date, 'scheduled', '${U.APP_W}', NULL),
      ('${J.J3}', 'PRV-J3', '${C.P}', current_date, 'scheduled', '${U.APP_W}', now()),
      ('${J.J4}', 'PRV-J4', '${C.P}', current_date, 'scheduled', NULL, NULL),
      ('${J.J5}', 'PRV-J5', '${C.P}', current_date - 10, 'completed', NULL, NULL),
      ('${J.J6}', 'PRV-J6', '${C.P}', current_date, 'scheduled', NULL, NULL),
      ('${J.J7}', 'PRV-J7', '${C.P}', current_date - 2, 'completed', NULL, NULL),
      ('${J.J8}', 'PRV-J8', '${C.P}', current_date, 'scheduled', NULL, NULL),
      ('${J.J9}', 'PRV-J9', '${C.P}', current_date, 'scheduled', NULL, NULL);
    INSERT INTO public.job_fields (id, job_id, field_id, acres_to_treat, sort_order) VALUES
      ${jf.map(([a, b, c], i) => `('${JF[a]}', '${J[b]}', '${F[c]}', 10, ${i})`).join(',\n      ')};
    INSERT INTO public.ground_crews (id, name, is_active) VALUES ('${CREW.ON}', '[PROVER] Crew on', true), ('${CREW.OFF}', '[PROVER] Crew off', false);
    INSERT INTO public.ground_crew_members (crew_id, name, profile_id, is_active) VALUES
      ('${CREW.ON}', '[PROVER] C', '${U.APP_C}', true), ('${CREW.OFF}', '[PROVER] C', '${U.APP_C}', true);
    INSERT INTO public.job_location_dispatches (job_field_id, job_id, applicator_id, crew_id, dispatch_status, updated_at) VALUES
      ('${JF.JF1}', '${J.J1}', '${U.APP_A}', NULL, 'dispatched', now()),
      ('${JF.JF2}', '${J.J1}', '${U.APP_A}', NULL, 'cancelled', now()),
      ('${JF.JF4}', '${J.J3}', '${U.APP_A}', NULL, 'dispatched', now()),
      ('${JF.JF5}', '${J.J4}', NULL, '${CREW.ON}', 'dispatched', now()),
      ('${JF.JF6}', '${J.J5}', '${U.APP_A}', NULL, 'completed', now() - interval '8 days'),
      ('${JF.JF7}', '${J.J6}', '${U.IN_APP}', NULL, 'dispatched', now()),
      ('${JF.JF8}', '${J.J7}', '${U.APP_A}', NULL, 'completed', now() - interval '2 days'),
      ('${JF.JF9}', '${J.J8}', NULL, '${CREW.OFF}', 'dispatched', now()),
      ('${JF.JF12}', '${J.J9}', '${U.APP_A}', NULL, 'dispatched', now());
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
}

/** `sql` as a signed-in user in a rolled-back transaction, after an optional `prefix` run as
 * postgres. A read is wrapped as a scalar subquery; a write (`dml`, a data-modifying statement
 * with RETURNING) is counted at top level. Returns the last output line, or ERR:<message>. */
function as(user, sql, { prefix = '', dml = false } = {}) {
  const jwt = JSON.stringify({ sub: U[user], role: 'authenticated' });
  const probe = dml ? `WITH d AS (${sql}) SELECT 'OUT=' || count(*) FROM d;` : `SELECT 'OUT=' || COALESCE((${sql})::text, '<null>');`;
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;
    ${prefix}
    SET LOCAL ROLE authenticated;
    SELECT set_config('request.jwt.claims', '${jwt}', true);
    ${probe}
    ROLLBACK;` });
  if (r.status !== 0) {
    const m = /ERROR:\s+([^\n]*)/.exec(r.stderr);
    return `ERR:${m ? m[1].trim() : r.stderr.trim()}`;
  }
  return /OUT=(.*)/.exec(r.stdout)?.[1] ?? `(no output) ${r.stdout}`;
}
// v(n, o, i, loc): field label, sort order, field id, its field_app_locations id.
const FIELD_VALUES = NUMS.map((n) => `('F${n}', ${n}, '${F[`F${n}`]}'::uuid, '${LOC[`L${n}`]}'::uuid)`).join(',');
const JOB_VALUES = JOBS.map((n) => `('J${n}', ${n}, '${J[`J${n}`]}'::uuid)`).join(',');
const ALL_JOBS = `ARRAY[${Object.values(J).map((v) => `'${v}'`).join(',')}]::uuid[]`;
const JOB_LABEL = `CASE ${Object.entries(J).map(([k, v]) => `WHEN x.job_id = '${v}' THEN '${k}'`).join(' ')} END`;
const CUST_LABEL = `CASE ${Object.entries(C).map(([k, v]) => `WHEN x.customer_id = '${v}' THEN '${k}'`).join(' ')} END`;
/** The labels of the fields for which `exists` (a correlated FROM ... WHERE on v.i / v.loc) finds a row. */
const seen = (exists) => `SELECT COALESCE(string_agg(v.n, ',' ORDER BY v.o), '') FROM (VALUES ${FIELD_VALUES}) v(n, o, i, loc) WHERE EXISTS (SELECT 1 FROM ${exists})`;
/** The job:field labels of the (job_id, field_id) pairs `pairs` returns. */
const seenPairs = (pairs) => `SELECT COALESCE(string_agg(jv.n || ':' || fv.n, ',' ORDER BY jv.o, fv.o), '') FROM (${pairs}) x
  JOIN (VALUES ${JOB_VALUES}) jv(n, o, i) ON jv.i = x.job_id JOIN (VALUES ${FIELD_VALUES}) fv(n, o, i, loc) ON fv.i = x.field_id`;
const billed = (jobKey) => `SELECT COALESCE(string_agg(l, ',' ORDER BY l), '') FROM (SELECT ${CUST_LABEL} AS l FROM public.get_job_billed_customers('${J[jobKey]}') x) s`;
const NEW_POLYGON = `('${F.F1}', '{"type":"Polygon","coordinates":[]}', 'B', 2)`;
const CALLS = {
  // Tables, read directly as the Data API would.
  fields: seen('public.fields x WHERE x.id = v.i'),
  polygons: seen('public.field_polygons x WHERE x.field_id = v.i'),
  crop: seen('public.field_crop_history x WHERE x.field_id = v.i'),
  obstacles: seen('public.field_obstacles x WHERE x.field_id = v.i'),
  appLocations: seen('public.field_app_locations x WHERE x.field_id = v.i'),
  appShares: seen('public.field_app_location_shares x WHERE x.location_id = v.loc'),
  fbd: seen('public.field_billing_defaults x WHERE x.field_id = v.i'),
  arf: seen('public.application_record_fields x WHERE x.field_id = v.i'),
  jobFields: seenPairs('SELECT DISTINCT job_id, field_id FROM public.job_fields'),
  // Writes to F1's boundary parts (counted; RETURNING needs the row to stay readable).
  polyInsert: `INSERT INTO public.field_polygons (field_id, polygon_geojson, label, sort_order) VALUES ${NEW_POLYGON} RETURNING 1`,
  polyUpdate: `UPDATE public.field_polygons SET label = 'X' WHERE field_id = '${F.F1}' RETURNING 1`,
  polyDelete: `DELETE FROM public.field_polygons WHERE field_id = '${F.F1}' RETURNING 1`,
  // Functions.
  jobMap: seenPairs(`SELECT DISTINCT jj.job_id, x.id AS field_id FROM unnest(${ALL_JOBS}) jj(job_id) CROSS JOIN LATERAL public.get_job_fields_with_geojson(jj.job_id) x`),
  // The board as the caller would open it for themself (office: for APP_A).
  board: (self) => seenPairs(`SELECT DISTINCT (b ->> 'id')::uuid AS job_id, (e ->> 'field_id')::uuid AS field_id
    FROM public.get_dispatch_board_jobs('${self}') b CROSS JOIN LATERAL jsonb_array_elements(b -> 'job_fields') e`),
  billedJ1: billed('J1'),
  billedJ3: billed('J3'),
  billedAll: `SELECT COALESCE(string_agg(l, ',' ORDER BY l), '') FROM (SELECT ${JOB_LABEL} || ':' || ${CUST_LABEL} AS l FROM public.get_jobs_billed_customers(${ALL_JOBS}) x) s`,
};
const DML_CALLS = new Set(['polyInsert', 'polyUpdate', 'polyDelete']);
const call = (user, c) => (c === 'board' ? CALLS.board(user === 'ADMIN' || user === 'REP' ? U.APP_A : U[user]) : CALLS[c]);
const run = (user, c, prefix = '') => as(user, call(user, c), { prefix, dml: DML_CALLS.has(c) });
const TABLE_CALLS = ['fields', 'polygons', 'crop', 'obstacles', 'appLocations', 'appShares', 'fbd', 'arf'];
const ALL_CALLS = [...TABLE_CALLS, 'jobFields', 'polyInsert', 'polyUpdate', 'polyDelete', 'jobMap', 'board', 'billedJ1', 'billedJ3', 'billedAll'];
const OFFICE = ['ADMIN', 'REP'];
const FIELD_ROLES = ['APP_A', 'APP_W', 'APP_C', 'DRIVER', 'ENTITY', 'IN_APP', 'APP_X', 'NO_PROFILE'];
const ALL_FIELDS = NUMS.map((n) => `F${n}`).join(',');
const NOT_AUTH = 'ERR:Not authorized to view this job\'s billed customers';
const POLY_REFUSED = 'ERR:new row violates row-level security policy for table "field_polygons"';
const none = Object.fromEntries(ALL_CALLS.map((c) => [c, '']));
const row = (o) => ({ ...none, polyInsert: POLY_REFUSED, polyUpdate: '0', polyDelete: '0', billedJ1: NOT_AUTH, billedJ3: NOT_AUTH, ...o });
const tables = (v, extra = {}) => ({ ...Object.fromEntries(TABLE_CALLS.map((c) => [c, v])), ...extra });
const WRITES_OPEN = { polyInsert: '1', polyUpdate: '1', polyDelete: '1' };
// BEFORE: every active applicator reads every field through the tables and writes any field's
// boundary parts; every active profile reads the billing splits and spray-record fields; the
// split-job assignee APP_A reads each split job's other field through job_fields, the job map, the
// board and both billed-customer lookups; and every active applicator gets J1's billed customers,
// because J1 has no whole-job applicator and the gate's NOT (... NULL ...) never refused.
const BEFORE = {
  APP_A: row({ ...tables(ALL_FIELDS), ...WRITES_OPEN, jobFields: 'J1:F1,J1:F2,J3:F4,J7:F8,J9:F1,J9:F2', jobMap: 'J1:F1,J1:F2,J3:F4,J7:F8,J9:F1,J9:F2',
    board: 'J1:F1,J1:F2,J9:F1,J9:F2', billedJ1: 'C,O,P', billedJ3: 'P', billedAll: 'J1:C,J1:O,J1:P,J3:P,J7:P,J9:C,J9:O,J9:P' }),
  APP_W: row({ ...tables(ALL_FIELDS), ...WRITES_OPEN, jobFields: 'J2:F3,J2:F10,J3:F4', jobMap: 'J2:F3,J2:F10,J3:F4', board: 'J2:F3,J2:F10',
    billedJ1: 'C,O,P', billedJ3: 'P', billedAll: 'J2:O,J2:P,J3:P' }),
  APP_C: row({ ...tables(ALL_FIELDS), ...WRITES_OPEN, jobFields: 'J4:F5', jobMap: 'J4:F5', billedJ1: 'C,O,P', billedAll: 'J4:P' }),
  DRIVER: row({ fbd: ALL_FIELDS, arf: ALL_FIELDS }),
  ENTITY: row({ fbd: ALL_FIELDS, arf: ALL_FIELDS }),
  IN_APP: row({}),
  APP_X: row({ ...tables(ALL_FIELDS), ...WRITES_OPEN, billedJ1: 'C,O,P' }),
  NO_PROFILE: row({}),
};
// AFTER: each caller reads only the fields of their own current assignments, by every route, and
// on each job only that job's assigned fields; field-application locations and shares and every
// boundary-part write are office-only.
const AFTER = {
  APP_A: row({ ...tables('F1,F2,F8', { appLocations: '', appShares: '' }), jobFields: 'J1:F1,J7:F8,J9:F2', jobMap: 'J1:F1,J7:F8,J9:F2',
    board: 'J1:F1,J9:F2', billedJ1: 'C,P', billedJ3: '', billedAll: 'J1:C,J1:P,J7:P,J9:O' }),
  // job_fields_select (the whole-job leg) still shows the deleted J3's row until part C.
  APP_W: row({ ...tables('F3,F10', { appLocations: '', appShares: '' }), jobFields: 'J2:F3,J2:F10,J3:F4', jobMap: 'J2:F3,J2:F10', board: 'J2:F3,J2:F10',
    billedJ3: '', billedAll: 'J2:O,J2:P' }),
  APP_C: row({ ...tables('F5', { appLocations: '', appShares: '' }), jobFields: 'J4:F5', jobMap: 'J4:F5', billedAll: 'J4:P' }),
  DRIVER: row({}), ENTITY: row({}), IN_APP: row({}), APP_X: row({}), NO_PROFILE: row({}),
};

/** Everything office staff get; must be identical before and after. */
function officeSnapshot() {
  const out = {};
  for (const u of OFFICE) for (const c of ALL_CALLS) out[`${u}.${c}`] = run(u, c);
  return out;
}
function rolesSnapshot() {
  const out = {};
  for (const u of FIELD_ROLES) out[u] = Object.fromEntries(ALL_CALLS.map((c) => [c, run(u, c)]));
  return out;
}
const CHAIN = path.join(ROOT, 'scripts', 'smoke', 'smoke-field-tables-follow-field-access.sql');
/** Run the container chain in a rolled-back transaction: PASS only on SMOKE_PASS_ROLLBACK. */
function chain() {
  stageText('chain.sql', lf(CHAIN));
  const r = docker([...psqlArgs()], { input: 'BEGIN;\n\\i /tmp/chain.sql\nROLLBACK;\n', allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  return { pass: /SMOKE_PASS_ROLLBACK/.test(out), fail: /ERROR:\s+([^\n]*)/.exec(out)?.[1] ?? out.trim() };
}
const md5Of = (sig) => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.${sig}'::regprocedure;`);
const srcOf = (sig) => docker([...psqlArgs(), '-A', '-t'], { input: `SELECT replace(prosrc, chr(13), '') FROM pg_proc WHERE oid = 'public.${sig}'::regprocedure;` }).stdout.replaceAll('\r\n', '\n');
const attrsOf = (sig) => scalar(`SELECT proacl::text || ' ' || pg_get_userbyid(proowner) || ' ' || array_to_string(proconfig, ';') || ' ' || provolatile::text || ' ' || prorettype::regtype::text || ' ' || prosecdef::text FROM pg_proc WHERE oid = 'public.${sig}'::regprocedure;`);
const policyRow = (tbl, pol) => `SET search_path = public, pg_temp; SELECT %s FROM pg_policies WHERE schemaname = 'public' AND tablename = '${tbl}' AND policyname = '${pol}';`;
const policyOf = (tbl, pol) => scalar(policyRow(tbl, pol).replace('%s', "cmd || ' ' || roles::text || ' ' || permissive || ' ' || md5(coalesce(qual, '')) || ' ' || md5(coalesce(with_check, ''))"));
const textOf = (tbl, pol, col) => docker([...psqlArgs(), '-A', '-t'], { input: policyRow(tbl, pol).replace('%s', `coalesce(${col}, '<null>')`) }).stdout.replaceAll('\r\n', '\n').replace(/\n$/, '');
const qualOf = (tbl, pol) => textOf(tbl, pol, 'qual');
const TOUCHED = [...POLICIES.map(([, p]) => p), ...POLYGON_WRITES.map(([p]) => p)];
const otherPolicies = () => scalar(`SELECT md5(string_agg(tablename || '.' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), '|' ORDER BY tablename, policyname)) FROM pg_policies WHERE schemaname = 'public' AND NOT (policyname = ANY (ARRAY[${TOUCHED.map((p) => `'${p}'`).join(',')}]));`);

function candidateFunction(header) {
  const s = lf(CANDIDATE);
  const start = s.indexOf(header);
  assert.ok(start > 0, `candidate function ${header} not found`);
  const end = s.indexOf('$function$;', s.indexOf('$function$', start) + 10) + '$function$;'.length;
  return s.slice(start, end);
}
/** The body of a candidate function, as prosrc will hold it. */
const candidateBody = (header) => { const f = candidateFunction(header); return f.slice(f.indexOf('$function$') + '$function$'.length, f.lastIndexOf('$function$')); };
/** Lines removed from / added to a body (order-preserving multiset diff by line). */
function lineDiff(before, after) {
  const a = before.split('\n'); const b = after.split('\n');
  const left = [...a]; const added = [];
  for (const line of b) { const at = left.indexOf(line); if (at >= 0) left.splice(at, 1); else added.push(line); }
  return { removed: left, added };
}
const HEADERS = {
  'get_job_fields_with_geojson(uuid)': 'CREATE OR REPLACE FUNCTION public.get_job_fields_with_geojson(',
  'get_dispatch_board_jobs(uuid,text,date,date)': 'CREATE OR REPLACE FUNCTION public.get_dispatch_board_jobs(',
  'get_job_billed_customers(uuid)': 'CREATE OR REPLACE FUNCTION public.get_job_billed_customers(',
  'get_jobs_billed_customers(uuid[])': 'CREATE OR REPLACE FUNCTION public.get_jobs_billed_customers(',
};
// The only code (non-comment) lines each body may lose or gain.
const CODE_DIFF = {
  'get_job_fields_with_geojson(uuid)': { removed: [], added: ['    AND public._can_see_job_field(jf.job_id, f.id)'] },
  'get_dispatch_board_jobs(uuid,text,date,date)': { removed: [], added: ['              AND public._can_see_job_field(jf.job_id, jf.field_id)'] },
  'get_job_billed_customers(uuid)': {
    removed: ['  IF NOT (', '  ) THEN', '    WHERE NOT EXISTS (SELECT 1 FROM job_field_ids)'],
    added: ['  IF (', '  ) IS NOT TRUE THEN', '      AND public._can_see_job_field(p_job_id, jf.field_id)', '    WHERE NOT EXISTS (',
      '        SELECT 1 FROM job_fields jf WHERE jf.job_id = p_job_id AND jf.field_id IS NOT NULL', '      )'],
  },
  'get_jobs_billed_customers(uuid[])': {
    removed: ['    WHERE NOT EXISTS (SELECT 1 FROM job_field_ids jfi WHERE jfi.job_id = vj.job_id)'],
    added: ['    WHERE public._can_see_job_field(vj.job_id, jf.field_id)', '    WHERE NOT EXISTS (',
      '            SELECT 1 FROM job_fields jf WHERE jf.job_id = vj.job_id AND jf.field_id IS NOT NULL', '          )'],
  },
};
const isComment = (line) => line.trim() === '' || line.trim().startsWith('--');

function main() {
  buildContainer();
  // 0. FIDELITY: the replayed state is the live state the preflight pins.
  for (const [sig, pin] of FNS) {
    assert.equal(md5Of(sig), pin, `replayed ${sig} differs from the live pin`);
    assert.ok(lf(CANDIDATE).includes(`'${pin}'`), `the preflight does not pin ${sig}`);
  }
  assert.equal(md5Of('_can_see_field(uuid)'), CAN_SEE_FIELD_MD5, "replayed _can_see_field is not part A's live body");
  for (const [tbl, pol, qual] of POLICIES) assert.equal(qualOf(tbl, pol), qual, `replayed ${pol} on ${tbl} differs from live`);
  for (const [pol, , qual, check] of POLYGON_WRITES) {
    assert.equal(qualOf('field_polygons', pol), qual ?? '<null>', `replayed ${pol} USING differs from live`);
    assert.equal(textOf('field_polygons', pol, 'with_check'), check ?? '<null>', `replayed ${pol} WITH CHECK differs from live`);
  }
  // Only the marked lines change in each body.
  for (const [sig] of FNS) {
    const d = lineDiff(srcOf(sig).replace(/\n$/, ''), candidateBody(HEADERS[sig]));
    assert.deepEqual({ removed: d.removed.filter((l) => !isComment(l)), added: d.added.filter((l) => !isComment(l)) }, CODE_DIFF[sig], `${sig}: unexpected code change`);
  }
  console.log(`[prover] FIDELITY: the ${FNS.length} replayed bodies, _can_see_field, the ${POLICIES.length} SELECT and ${POLYGON_WRITES.length} polygon write policies match live; only the marked code lines change`);
  seed();

  // 1. BEFORE.
  const before = officeSnapshot();
  for (const u of OFFICE) {
    for (const c of TABLE_CALLS) assert.equal(before[`${u}.${c}`], ALL_FIELDS, `BEFORE: ${u} ${c}`);
    for (const c of ['polyInsert', 'polyUpdate', 'polyDelete']) assert.equal(before[`${u}.${c}`], '1', `BEFORE: ${u} ${c}`);
    assert.equal(before[`${u}.board`], 'J1:F1,J1:F2,J9:F1,J9:F2', `BEFORE: ${u} board`);
    assert.equal(before[`${u}.billedJ1`], 'C,O,P', `BEFORE: ${u} billedJ1`);
    assert.equal(before[`${u}.billedJ3`], 'P', `BEFORE: ${u} billedJ3`);
  }
  const rolesBefore = rolesSnapshot();
  for (const u of FIELD_ROLES) assert.deepEqual(rolesBefore[u], BEFORE[u], `BEFORE: ${u}`);
  for (const u of FIELD_ROLES) console.log(`[prover] BEFORE: ${u.padEnd(10)} fields=[${rolesBefore[u].fields}] fbd=[${rolesBefore[u].fbd}] polygon writes=${rolesBefore[u].polyInsert}/${rolesBefore[u].polyUpdate}/${rolesBefore[u].polyDelete} job_fields=[${rolesBefore[u].jobFields}] billedJ1=${rolesBefore[u].billedJ1}`);
  const chainBefore = chain();
  assert.ok(!chainBefore.pass, 'BEFORE: the smoke chain passed without the candidate');
  assert.match(chainBefore.fail, /SMOKE_FAIL: a\./, `BEFORE: the chain failed at the wrong step: ${chainBefore.fail}`);
  console.log(`[prover] BEFORE: the smoke chain fails first: ${chainBefore.fail.slice(0, 120)}`);

  // 2. AUTOCOMMIT.
  stageText('candidate.sql', lf(CANDIDATE));
  const state = () => FNS.map(([sig]) => md5Of(sig)).join(',') + POLICIES.map(([t, p]) => policyOf(t, p)).join(',')
    + POLYGON_WRITES.map(([p]) => policyOf('field_polygons', p)).join(',') + scalar("SELECT to_regprocedure('public._can_see_job_field(uuid,uuid)') IS NULL;");
  const pre = state();
  const ac = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(ac.status, 0, 'autocommit apply did not stop');
  assert.match(`${ac.stdout}\n${ac.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit stopped for the wrong reason');
  assert.equal(state(), pre, 'autocommit changed something');
  console.log('[prover] AUTOCOMMIT: refused by the preflight, nothing changed');

  // 3. APPLY.
  const attrs = FNS.map(([sig]) => attrsOf(sig));
  const helperAttrs = attrsOf('_can_see_field(uuid)');
  const others = otherPolicies();
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.match(a.output, /POSTFLIGHT_OK/, `no POSTFLIGHT_OK:\n${a.output}`);
  assert.deepEqual(FNS.map(([sig]) => attrsOf(sig)), attrs, 'an owner, ACL, search_path, volatility, return type or security mode changed');
  assert.equal(attrsOf('_can_see_field(uuid)') + md5Of('_can_see_field(uuid)'), helperAttrs + CAN_SEE_FIELD_MD5, '_can_see_field changed');
  assert.equal(scalar("SELECT has_function_privilege('anon', 'public._can_see_job_field(uuid,uuid)', 'EXECUTE')::text || has_function_privilege('authenticated', 'public._can_see_job_field(uuid,uuid)', 'EXECUTE')::text;"), 'falsetrue', '_can_see_job_field grants');
  assert.equal(otherPolicies(), others, 'a policy outside the eleven changed');
  for (const [tbl, pol] of [...POLICIES, ...POLYGON_WRITES.map(([p]) => ['field_polygons', p])]) {
    console.log(`[prover]   ${pol}: USING ${qualOf(tbl, pol).replace(/\s+/g, ' ')} | WITH CHECK ${textOf(tbl, pol, 'with_check').replace(/\s+/g, ' ')}`);
  }
  console.log(`[prover] candidate applied; POSTFLIGHT_OK; function attributes, _can_see_field and every other policy unchanged; _can_see_job_field authenticated-only`);

  // 4. AFTER.
  const rolesAfter = rolesSnapshot();
  for (const u of FIELD_ROLES) {
    assert.deepEqual(rolesAfter[u], AFTER[u], `AFTER: ${u}`);
    const r = rolesAfter[u];
    console.log(`[prover] AFTER:  ${u.padEnd(10)} fields=[${r.fields}] fbd=[${r.fbd}] locations=[${r.appLocations}] polygon writes=${r.polyInsert === POLY_REFUSED ? 'refused' : r.polyInsert}/${r.polyUpdate}/${r.polyDelete} job_fields=[${r.jobFields}] map=[${r.jobMap}] board=[${r.board}] billedJ1=${r.billedJ1} billedJ3=${r.billedJ3} billedAll=[${r.billedAll}]`);
  }
  assert.deepEqual(officeSnapshot(), before, 'AFTER: an office user got something different');
  console.log('[prover] AFTER: active admin and sales rep get exactly what they got before (reads and boundary-part writes)');
  const chainAfter = chain();
  assert.ok(chainAfter.pass, `AFTER: the smoke chain failed: ${chainAfter.fail}`);
  console.log('[prover] AFTER: the smoke chain passes and rolls back (SMOKE_PASS_ROLLBACK)');

  // 5. RE-APPLY.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /FIELD_TABLES_BASELINE_DRIFT/, `re-apply refused for the wrong reason:\n${again.output}`);
  console.log('[prover] RE-APPLY: refused by the preflight');

  // 6. MUTATION: putting back any one old rule, or dropping any one new check, reopens its gap.
  const fn = (sig, from, to) => () => candidateFunction(HEADERS[sig]).replace(from, to);
  const pol = (tbl, p) => () => `ALTER POLICY ${p} ON public.${tbl} USING (${POLICIES.find(([, x]) => x === p)[2]});`;
  const HELPER = 'CREATE FUNCTION public._can_see_job_field(';
  const helper = (from, to) => () => candidateFunction(HELPER).replace(HELPER, 'CREATE OR REPLACE FUNCTION public._can_see_job_field(').replace(from, to);
  const PER_FIELD_PAIRS = 'J1:F1,J1:F2,J7:F8,J9:F1,J9:F2';
  for (const [label, prefix, user, c, expect] of [
    ['fields_select as live', pol('fields', 'fields_select'), 'APP_X', 'fields', ALL_FIELDS],
    ['field_crop_history_select as live', pol('field_crop_history', 'field_crop_history_select'), 'APP_A', 'crop', ALL_FIELDS],
    ['field_obstacles_select as live', pol('field_obstacles', 'field_obstacles_select'), 'APP_A', 'obstacles', ALL_FIELDS],
    ['field_app_locations_select as live', pol('field_app_locations', 'field_app_locations_select'), 'APP_A', 'appLocations', ALL_FIELDS],
    ['field_app_location_shares_select as live', pol('field_app_location_shares', 'field_app_location_shares_select'), 'APP_A', 'appShares', ALL_FIELDS],
    ['fbd_select as live', pol('field_billing_defaults', 'fbd_select'), 'DRIVER', 'fbd', ALL_FIELDS],
    ['arf_select as live', pol('application_record_fields', 'arf_select'), 'DRIVER', 'arf', ALL_FIELDS],
    ['field_polygons_select through fields_select as live', pol('fields', 'fields_select'), 'APP_A', 'polygons', ALL_FIELDS],
    ['field_polygons_insert as live', () => `ALTER POLICY field_polygons_insert ON public.field_polygons WITH CHECK ${POLYGONS_IN_FIELDS};`, 'APP_A', 'polyInsert', '1'],
    ['field_polygons_update as live', () => `ALTER POLICY field_polygons_update ON public.field_polygons USING ${POLYGONS_IN_FIELDS};`, 'APP_A', 'polyUpdate', '1'],
    ['field_polygons_delete as live', () => `ALTER POLICY field_polygons_delete ON public.field_polygons USING ${POLYGONS_IN_FIELDS};`, 'APP_A', 'polyDelete', '1'],
    ['job_fields_select_location_dispatchee as live', pol('job_fields', 'job_fields_select_location_dispatchee'), 'APP_A', 'jobFields', 'J1:F1,J1:F2,J3:F4,J7:F8,J9:F1,J9:F2'],
    ['job_fields_select_location_dispatchee per field, not per job', () => 'ALTER POLICY job_fields_select_location_dispatchee ON public.job_fields USING (_is_dispatched_to_me(job_id) AND public._can_see_field(field_id));', 'APP_A', 'jobFields', PER_FIELD_PAIRS],
    ['get_job_fields_with_geojson without the field check', fn('get_job_fields_with_geojson(uuid)', '    AND public._can_see_job_field(jf.job_id, f.id)\n', ''), 'APP_A', 'jobMap', 'J1:F1,J1:F2,J3:F4,J7:F8,J9:F1,J9:F2'],
    ['get_job_fields_with_geojson per field, not per job', fn('get_job_fields_with_geojson(uuid)', 'public._can_see_job_field(jf.job_id, f.id)', 'public._can_see_field(f.id)'), 'APP_A', 'jobMap', PER_FIELD_PAIRS],
    ['get_dispatch_board_jobs without the field check', fn('get_dispatch_board_jobs(uuid,text,date,date)', '              AND public._can_see_job_field(jf.job_id, jf.field_id)\n', ''), 'APP_A', 'board', 'J1:F1,J1:F2,J9:F1,J9:F2'],
    ['get_job_billed_customers without the field check', fn('get_job_billed_customers(uuid)', '      AND public._can_see_job_field(p_job_id, jf.field_id)\n', ''), 'APP_A', 'billedJ1', 'C,O,P'],
    ['get_job_billed_customers per field, not per job', fn('get_job_billed_customers(uuid)', 'public._can_see_job_field(p_job_id, jf.field_id)', 'public._can_see_field(jf.field_id)'), 'APP_A', 'billedJ1', 'C,O,P'],
    // With the old NOT (...) gate an unassigned applicator passes again (the field filter then
    // leaves it nothing, so the reopened gap shows as an empty answer instead of a refusal).
    ['get_job_billed_customers gate as NOT (...)', () => fn('get_job_billed_customers(uuid)', '  IF (\n    is_admin()', '  IF NOT (\n    is_admin()')()
      .replace('  ) IS NOT TRUE THEN\n', '  ) THEN\n'), 'APP_X', 'billedJ1', ''],
    // The fallback asks whether the job has fields: asking about visible ones gives a deleted
    // job's whole-job applicator a primary-only list instead of nothing.
    ['get_job_billed_customers fallback on visible fields', fn('get_job_billed_customers(uuid)',
      '    WHERE NOT EXISTS (\n        SELECT 1 FROM job_fields jf WHERE jf.job_id = p_job_id AND jf.field_id IS NOT NULL\n      )\n',
      '    WHERE NOT EXISTS (SELECT 1 FROM job_field_ids)\n'), 'APP_W', 'billedJ3', 'P'],
    ['get_jobs_billed_customers without the field check', fn('get_jobs_billed_customers(uuid[])', '    WHERE public._can_see_job_field(vj.job_id, jf.field_id)\n', ''), 'APP_A', 'billedAll', 'J1:C,J1:O,J1:P,J3:P,J7:P,J9:C,J9:O,J9:P'],
    ['get_jobs_billed_customers fallback on visible fields', fn('get_jobs_billed_customers(uuid[])',
      '    WHERE NOT EXISTS (\n            SELECT 1 FROM job_fields jf WHERE jf.job_id = vj.job_id AND jf.field_id IS NOT NULL\n          )\n',
      '    WHERE NOT EXISTS (SELECT 1 FROM job_field_ids jfi WHERE jfi.job_id = vj.job_id)\n'), 'APP_W', 'billedAll', 'J2:O,J2:P,J3:P'],
    ['_can_see_job_field dispatch leg not tied to the job', helper('           WHERE d.job_id = p_job_id\n             AND jf.field_id = p_field_id\n', '           WHERE jf.field_id = p_field_id\n'), 'APP_A', 'jobMap', PER_FIELD_PAIRS],
    ['_can_see_job_field dispatch leg without the deleted-job test', helper('             AND jf.field_id = p_field_id\n             AND j.deleted_at IS NULL\n             AND (\n', '             AND jf.field_id = p_field_id\n             AND (\n'), 'APP_A', 'jobMap', 'J1:F1,J3:F4,J7:F8,J9:F2'],
    ['_can_see_job_field dispatch leg without the status window', helper("               d.dispatch_status = 'dispatched'\n               OR (d.dispatch_status = 'completed' AND d.updated_at >= now() - interval '7 days')\n", '               true\n'), 'APP_A', 'billedAll', 'J1:C,J1:O,J1:P,J7:P,J9:O'],
    ['_can_see_job_field whole-job leg without the deleted-job test', helper('             AND j.applicator_id = (SELECT auth.uid())\n             AND j.deleted_at IS NULL))', '             AND j.applicator_id = (SELECT auth.uid())))'), 'APP_W', 'jobMap', 'J2:F3,J2:F10,J3:F4'],
  ]) {
    const sql = prefix();
    assert.ok(sql.length > 0 && !lf(CANDIDATE).includes(sql), `MUTATION ${label}: the edit did not apply`);
    const got = run(user, c, sql);
    assert.equal(got, expect, `MUTATION ${label}: expected ${expect}, got ${got}`);
    console.log(`[prover] MUTATION: ${label}: ${user} ${c} -> ${got}`);
  }
  // The helper's active-profile test, called directly: the inactive applicator's open dispatch.
  const inactive = `SELECT public._can_see_job_field('${J.J6}', '${F.F7}')`;
  assert.equal(as('IN_APP', inactive), 'false', 'the inactive applicator passes _can_see_job_field');
  const noActive = helper('  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.is_active)\n  AND (', '  SELECT (')();
  assert.equal(as('IN_APP', inactive, { prefix: noActive }), 'true', 'MUTATION _can_see_job_field without the active-profile test');
  console.log('[prover] MUTATION: _can_see_job_field without the active-profile test: IN_APP sees its open dispatch again');

  console.log('FIELD_TABLES_FIELD_ACCESS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
