#!/usr/bin/env node
/**
 * Full-chain proof for the 20261019220000 candidate: start_and_complete_delivery starts a scheduled
 * delivery and completes it in ONE transaction, on the chosen America/Chicago business date, with a
 * required retry key bound to the caller and the exact request (KNOWN_ISSUES.md, "the Deliveries
 * list can leave a scheduled delivery In Progress if signal drops between its two steps").
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers), then:
 *   1. BEFORE: the chain fails (the function does not exist); the covering delivery chains that
 *      pass are recorded;
 *   2. APPLY: the candidate applies in one transaction; the function is SECURITY DEFINER with
 *      search_path public, pg_temp, executable by authenticated and by neither anon nor PUBLIC;
 *      confirm_delivery and complete_delivery are byte-identical to before;
 *   3. AFTER: the chain passes and rolls back (it draws an invoice number, so it is CONTAINER
 *      ONLY), and every covering chain that passed BEFORE still passes;
 *   4. MUTATION: with the start step, the key requirement, the future-date refusal, the past-date
 *      midday stamp or the target in the fingerprint removed, the chain fails at the step that
 *      proves it.
 *
 * Run: node scripts/smoke/prove-start-and-complete-delivery-real-schema.mjs   (needs Docker)
 * Prints START_AND_COMPLETE_DELIVERY_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-start-complete-delivery-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261019220000_start_and_complete_delivery.sql');
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
const CHAIN = path.join(SMOKE, 'smoke-start-and-complete-delivery.sql');
const SPECS = path.join(SMOKE, 'smoke-specs.json');
// Every other non-container chain that completes a delivery or a job. Each must keep passing after
// the candidate if it passed before it (some need live data this database lacks; those are
// reported, not required).
const COVERING_CHAINS = [
  'smoke-delivery-job-replay-binding-batch3a.sql',
  'smoke-offline-action-receipts.sql',
  'smoke-delivery-accounting-period-guard.sql',
  'smoke-financial-scope-and-delivery-aggregate.sql',
  'smoke-field-invoice-loop.sql',
  'smoke-return-credit-chain.sql',
];
const TOUCHED = ['start_and_complete_delivery', 'confirm_delivery', 'complete_delivery'];

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
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text);
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;`, { user: 'supabase_admin' });
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
      ${users.map(([u, role, label]) => `('${u}', 'start-complete-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
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
    else if (required?.has(name)) assert.fail(`${phase}: ${name} passed before the candidate and fails after it: ${r.fail}`);
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
const FN = 'public.start_and_complete_delivery(uuid,text,date,uuid,jsonb,text,text,text)';
function bodyMd5(sig) {
  return scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${sig}');`);
}
const UNCHANGED = [
  'public.confirm_delivery(uuid,uuid,text)',
  'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz)',
];

/** The candidate's CREATE with one hunk replaced, for a mutation run before the chain. */
function mutate(find, replacement, label) {
  const sql = lf(CANDIDATE);
  const start = sql.indexOf('CREATE FUNCTION public.start_and_complete_delivery(');
  const end = sql.indexOf('$function$;', start) + '$function$;'.length;
  const fn = sql.slice(start, end);
  assert.equal(fn.split(find).length - 1, 1, `mutation "${label}": hunk not found exactly once`);
  return fn.replace(find, replacement).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
}

function main() {
  buildContainer();
  seed();

  const before = chain(CHAIN);
  assert.ok(!before.pass, 'BEFORE: the chain passed without the candidate');
  assert.match(before.fail, /start_and_complete_delivery\([^)]*\) does not exist/, `BEFORE: wrong first failure: ${before.fail}`);
  console.log(`[prover] BEFORE: the chain fails first: ${before.fail}`);
  const passedBefore = covering('BEFORE');
  const md5Before = UNCHANGED.map(bodyMd5);

  stageText('candidate.sql', lf(CANDIDATE));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.equal(scalar(`SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('${FN}');`), 't', 'APPLY: not SECURITY DEFINER');
  assert.equal(scalar(`SELECT array_to_string(proconfig, ';') FROM pg_proc WHERE oid = to_regprocedure('${FN}');`), 'search_path=public, pg_temp', 'APPLY: wrong search_path');
  for (const [role, want] of [['authenticated', 't'], ['anon', 'f'], ['service_role', 'f'], ['public', 'f']]) {
    const got = role === 'public'
      ? scalar(`SELECT coalesce(bool_or(a.grantee = 0), false) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = to_regprocedure('${FN}') AND a.privilege_type = 'EXECUTE';`)
      : scalar(`SELECT has_function_privilege('${role}', '${FN}', 'EXECUTE');`);
    assert.equal(got, want, `APPLY: EXECUTE for ${role} is ${got}, expected ${want}`);
  }
  assert.deepEqual(UNCHANGED.map(bodyMd5), md5Before, 'APPLY: confirm_delivery or complete_delivery changed');
  console.log('[prover] APPLY: SECURITY DEFINER, search_path public, pg_temp; EXECUTE authenticated only (not anon, service_role or PUBLIC); confirm_delivery and complete_delivery unchanged');

  const seqBefore = sequences();
  const after = chain(CHAIN);
  assert.ok(after.pass, `AFTER: the chain failed: ${after.fail}`);
  const movedDoc = movedSequences(seqBefore, sequences()).filter((s) => documentNumberSequences().has(s));
  const spec = JSON.parse(readFileSync(SPECS, 'utf8')).specs.start_and_complete_delivery;
  assert.ok(spec && spec.chain === path.basename(CHAIN), 'smoke-specs.json has no entry for the chain');
  if (movedDoc.length) assert.equal(spec.container_only, true, `AFTER: the chain drew document numbers (${movedDoc.join(', ')}) but its spec is not container_only`);
  console.log(`[prover] AFTER: the chain passes and rolls back; document-number sequences moved: ${movedDoc.join(', ') || 'none'} (CONTAINER ONLY)`);
  covering('AFTER', passedBefore);

  const mutations = [
    ['start step', '    PERFORM public.confirm_delivery(p_delivery_id, v_actor, NULL);\n', '',
      /SMOKE_FAIL: delivery 1 has 0 start activity rows|Delivery must be in_progress|in_progress|SMOKE_FAIL: start_and_complete_delivery did not start/],
    ['key requirement', "    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: start_and_complete_delivery requires p_idempotency_key' USING ERRCODE = '22023';\n", '    NULL;\n',
      // Without the first check a keyless call reaches the start step; a later key check refuses it.
      /SMOKE_FAIL: keyless refusal was IDEMPOTENCY_KEY_REQUIRED(?!: start_and_complete_delivery)/],
    ['future-date refusal', '  IF p_delivered_on > v_today THEN', '  IF false THEN',
      /SMOKE_FAIL: a future date ran|future-date refusal was/],
    ['past-date midday stamp', "    v_completed_at := (p_delivered_on + time '17:00') AT TIME ZONE 'UTC';\n", '    NULL;\n',
      /SMOKE_FAIL: delivery 2 \(yesterday\)/],
    ['past-date bound', "  IF p_delivered_on < (v_today - interval '1 year')::date THEN", '  IF false THEN',
      /SMOKE_FAIL: a date more than a year back ran/],
    ['replay before the one-year bound', "  -- complete_delivery's own test, run BEFORE the receipt lookup",
      "  IF p_delivered_on < (v_today - interval '1 year')::date THEN RAISE EXCEPTION 'DELIVERED_ON_TOO_OLD: early'; END IF;\n  -- complete_delivery's own test, run BEFORE the receipt lookup",
      /SMOKE_FAIL: an exact retry of an aged-out date was refused: DELIVERED_ON_TOO_OLD/],
    ['authorization before replay', '  IF v_actor_role IS NULL OR NOT (', '  IF false AND NOT (',
      /SMOKE_FAIL: a deactivated account replayed its completion/],
    ['target in the fingerprint', "    'delivery_id', p_delivery_id,\n", '',
      /SMOKE_FAIL: delivery 1's key replayed as success for delivery 2/],
  ];
  for (const [label, find, replacement, expected] of mutations) {
    const r = chain(CHAIN, mutate(find, replacement, label));
    assert.ok(!r.pass, `MUTATION ${label}: the chain still passed without the hunk`);
    assert.match(r.fail, expected, `MUTATION ${label}: wrong failure: ${r.fail}`);
    console.log(`[prover] MUTATION: without the ${label} the chain fails: ${r.fail}`);
  }

  console.log('START_AND_COMPLETE_DELIVERY_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
