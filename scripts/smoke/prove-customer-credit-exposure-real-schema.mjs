#!/usr/bin/env node
/**
 * Real-schema proof for the 20261027030000 candidate: customer_credit_exposure(p_customer_id), a
 * read-only total of a customer's open invoices in bigint cents for PR #1132's credit check, which
 * must count every rep's drafts even though invoice RLS hides them from the calling rep.
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers), seeds an admin, two sales reps, a driver and an
 * inactive sales rep, then:
 *   0. FIDELITY: the replayed require_admin_or_sales_rep() is the live body the preflight pins;
 *   1. BEFORE: the chain smoke-customer-credit-exposure.sql fails (the function does not exist);
 *   2. the candidate applies and prints POSTFLIGHT_OK; it is STABLE SECURITY DEFINER with
 *      search_path public, pg_temp, executable by authenticated and service_role, not by anon;
 *   3. AFTER: the chain passes and rolls back (rep B counts rep A's draft; admin and rep A agree;
 *      no limit -> null; unknown customer -> CUSTOMER_NOT_FOUND; driver, no profile and the
 *      inactive rep refused);
 *   4. BROWSER ROLES: with a committed draft owned by rep A, rep B signed in (role authenticated,
 *      row security on) sees 0 of the customer's invoices through the table but 900000 cents of
 *      exposure through the function, and anon is refused EXECUTE;
 *   5. RE-APPLY: refused by the preflight;
 *   6. MUTATION: with the function switched to SECURITY INVOKER rep B's browser-role exposure drops
 *      to 0, so step 4 really tests the cross-rep read.
 *
 * Run: node scripts/smoke/prove-customer-credit-exposure-real-schema.mjs   (needs Docker)
 * Prints CUSTOMER_CREDIT_EXPOSURE_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-credit-exposure-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261027030000_customer_credit_exposure.sql');
const CHAIN = path.join(ROOT, 'scripts', 'smoke', 'smoke-customer-credit-exposure.sql');
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
const COVERED = /customer_credit_exposure|require_admin_or_sales_rep|invoices_select/i;
// The live body of 2026-10-26 (md5 of prosrc without CR), as the preflight pins it.
const GATE = ['require_admin_or_sales_rep()', '958c994aeabcb9f53b6cef316019a219'];
const FN = 'public.customer_credit_exposure(uuid)';

const id = (n) => `7a570000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const U = { ADMIN: id(1), REP_A: id(2), REP_B: id(3), DRIVER: id(4), IN_REP: id(5) };
const CUSTOMER = id(101);
const DRAFT = id(201);

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
function seed() {
  // Users through the direct-SQL path of handle_new_user, then roles set and one rep deactivated.
  const users = [['ADMIN', 'admin'], ['REP_A', 'sales_rep'], ['REP_B', 'sales_rep'], ['DRIVER', 'driver'], ['IN_REP', 'sales_rep']];
  psql(users.map(([k, role]) => `INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES ('${U[k]}', 'credit-exposure-${k.toLowerCase().replace('_', '-')}@example.invalid', '{"full_name":"[PROVER] ${k}","role":"${role}"}'::jsonb);`).join('\n'));
  psql(`SET session_replication_role = replica;
    ${users.map(([k, role]) => `UPDATE public.profiles SET role = '${role}', is_active = ${k !== 'IN_REP'} WHERE id = '${U[k]}';`).join('\n    ')}
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY id) FROM public.profiles WHERE id::text LIKE '7a570000-%';`),
    'admin:true,sales_rep:true,sales_rep:true,driver:true,sales_rep:false', 'seeded profiles are not as intended');
}
function as(user, sql) {
  const jwt = JSON.stringify({ sub: user, role: 'authenticated' });
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;
    SET LOCAL ROLE ${user === 'anon' ? 'anon' : 'authenticated'};
    SELECT set_config('request.jwt.claims', '${user === 'anon' ? '{"role":"anon"}' : jwt}', true);
    SELECT 'OUT=' || COALESCE((${sql})::text, '<null>');
    ROLLBACK;` });
  if (r.status !== 0) {
    const m = /ERROR:\s+([^\n]*)/.exec(r.stderr);
    return `ERR:${m ? m[1].trim() : r.stderr.trim()}`;
  }
  return /OUT=(.*)/.exec(r.stdout)?.[1] ?? `(no output) ${r.stdout}`;
}
function chainPasses() {
  const r = apply('chain.sql');
  return { pass: /(?:^|\n)(?:psql:[^:\n]+:\d+:\s+)?ERROR:\s+SMOKE_PASS_ROLLBACK\b/.test(r.output), output: r.output };
}
function attrs() {
  return scalar(`SELECT p.prosecdef::text || '|' || p.provolatile::text || '|' || array_to_string(p.proconfig, ';') || '|' || p.prorettype::regtype::text
      || '|' || has_function_privilege('anon', '${FN}', 'EXECUTE')::text
      || '|' || has_function_privilege('authenticated', '${FN}', 'EXECUTE')::text
      || '|' || has_function_privilege('service_role', '${FN}', 'EXECUTE')::text
      || '|' || has_function_privilege('metabase_ro', '${FN}', 'EXECUTE')::text
    FROM pg_proc p WHERE p.oid = '${FN}'::regprocedure;`);
}

function main() {
  buildContainer();
  // 0. FIDELITY.
  assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.${GATE[0]}'::regprocedure;`), GATE[1], `replayed ${GATE[0]} differs from the live pin`);
  assert.ok(lf(CANDIDATE).includes(`'${GATE[1]}'`), `the preflight does not pin ${GATE[0]}`);
  console.log(`[prover] FIDELITY: replayed ${GATE[0]} matches the live body the preflight pins`);
  seed();
  stageText('chain.sql', lf(CHAIN));
  stageText('candidate.sql', lf(CANDIDATE));

  // 1. BEFORE.
  let c = chainPasses();
  assert.equal(c.pass, false, 'the chain passed before the candidate');
  assert.match(c.output, /function public\.customer_credit_exposure\(uuid\) does not exist/, `the chain failed for the wrong reason before the candidate:\n${c.output}`);
  console.log('[prover] BEFORE: the chain fails, customer_credit_exposure(uuid) does not exist');

  // 2. APPLY.
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.match(a.output, /POSTFLIGHT_OK customer_credit_exposure/, `no POSTFLIGHT_OK:\n${a.output}`);
  assert.equal(attrs(), 'true|s|search_path=public, pg_temp|jsonb|false|true|true|false', 'function attributes or grants are wrong');
  console.log(`[prover] candidate applied; POSTFLIGHT_OK; definer|stable|config|returns|anon|authenticated|service_role|metabase_ro = ${attrs()}`);

  // 3. AFTER.
  c = chainPasses();
  assert.equal(c.pass, true, `the chain failed after the candidate:\n${c.output}`);
  console.log('[prover] AFTER: smoke-customer-credit-exposure.sql reached SMOKE_PASS_ROLLBACK (inactive rep probed too)');

  // 4. BROWSER ROLES on a committed draft owned by rep A.
  psql(`BEGIN;
    SELECT set_config('request.jwt.claims', '{"sub":"${U.ADMIN}","role":"authenticated"}', true);
    INSERT INTO public.customers (id, farm_name, credit_limit_cents) VALUES ('${CUSTOMER}', '[PROVER] Credit Exposure', 1000000);
    INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, salesman_id)
    VALUES ('${DRAFT}', '[PROVER]-CX-DRAFT', '${CUSTOMER}', 'chemical_sale', 'draft', current_date, current_date + 30, 900000, '${U.REP_A}', '${U.REP_A}');
    COMMIT;`);
  const exposure = `public.customer_credit_exposure('${CUSTOMER}') ->> 'exposure_cents'`;
  const seen = `(SELECT count(*) FROM public.invoices WHERE customer_id = '${CUSTOMER}')`;
  const probes = [
    ['rep A sees its draft through RLS', U.REP_A, seen, '1'],
    ['rep B sees no invoice through RLS', U.REP_B, seen, '0'],
    ['rep B exposure counts rep A draft', U.REP_B, exposure, '900000'],
    ['admin exposure', U.ADMIN, exposure, '900000'],
    ['driver refused', U.DRIVER, exposure, 'ERR:Permission denied: requires admin or sales_rep role'],
    ['inactive rep refused', U.IN_REP, exposure, 'ERR:Permission denied: requires admin or sales_rep role'],
    ['anon refused EXECUTE', 'anon', exposure, 'ERR:permission denied for function customer_credit_exposure'],
  ];
  for (const [label, user, sql, expect] of probes) {
    const got = as(user, sql);
    assert.equal(got, expect, `BROWSER ROLES: ${label}`);
    console.log(`[prover] BROWSER ROLES: ${label}: ${got}`);
  }

  // 5. RE-APPLY.
  const re = apply('candidate.sql');
  assert.notEqual(re.status, 0, 're-apply was not refused');
  assert.match(re.output, /CREDIT_EXPOSURE_PREFLIGHT: public\.customer_credit_exposure already exists/, `re-apply refused for the wrong reason:\n${re.output}`);
  console.log('[prover] RE-APPLY: refused by the preflight');

  // 6. MUTATION: an invoker-rights function lets RLS hide rep A's draft from rep B.
  psql(`ALTER FUNCTION ${FN} SECURITY INVOKER;`);
  // (The chain itself runs as the table owner, whom RLS does not filter, so only a browser-role
  // probe can show this; step 4 is that probe.)
  assert.equal(as(U.REP_B, exposure), '0', 'MUTATION: invoker rights did not hide the draft');
  psql(`ALTER FUNCTION ${FN} SECURITY DEFINER;`);
  assert.equal(as(U.REP_B, exposure), '900000', 'MUTATION: restoring definer rights did not restore the count');
  console.log('[prover] MUTATION: as SECURITY INVOKER rep B gets exposure 0 (RLS hides the draft), so step 4 really tests the cross-rep read');

  console.log('CUSTOMER_CREDIT_EXPOSURE_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
