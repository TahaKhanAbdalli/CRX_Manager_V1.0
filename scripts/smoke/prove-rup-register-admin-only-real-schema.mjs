#!/usr/bin/env node
/**
 * Full-chain proof for the 20261014220000 candidate: the RUP sales register is admin-only
 * (Goal 1, docs/plans/2026-10-13-direction-and-goals.md).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate,
 * checks that the function body and policy the candidate replaces match their live md5 of
 * 2026-10-14, seeds one register row, then runs one matrix of calls BEFORE and AFTER the
 * candidate, as `authenticated` (a signed-in browser session through PostgREST) or `anon`
 * (a signed-out visitor). Every call is one transaction that always rolls back.
 *   1. BEFORE: every signed-in profile, of any role and even deactivated, pulls the register
 *      through get_rup_sales_register; admins and sales reps read the table directly.
 *   2. AFTER: only an active admin pulls it, through the function or the table. A deactivated admin, a sales rep,
 *      deactivated rep, driver, applicator and commission-recipient profile are refused by the
 *      function ('Permission denied: requires admin role') and see 0 rows in the table; a
 *      signed-out visitor is refused both.
 *   3. UNCHANGED: a sales rep still runs the register writer (invoice posting).
 *   4. The preflight refuses a drifted body; re-applying the candidate is harmless.
 *   5. MUTATION: with require_admin() emptied, a driver pulls the register again, so the
 *      refusal really comes from the admin gate.
 *
 * Run: node scripts/smoke/prove-rup-register-admin-only-real-schema.mjs   (needs Docker)
 * Prints RUP_REGISTER_ADMIN_ONLY_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-rup-register-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1' || REUSE;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261014220000_rup_register_admin_only.sql');
// Live but not replayable here (storage.objects policies); it does not touch the register.
const PARKED = new Set(['20260914100700_customer_document_bytes_server_only.sql']);
// PR #889's data migrations rewrite live rows this disposable database does not have; they are
// recorded in the ledger (as live has them) instead of replayed.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
]);
// Later migrations check that their predecessor is in the ledger; record each replayed file from
// this stamp on, as live has them.
const LEDGER_FROM = '20261007';
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
// Live pins read 2026-10-14, immediately before the candidate was written.
const REGISTER_FN = 'public.get_rup_sales_register(date,date,uuid,uuid,text,boolean)';
const LIVE_REGISTER_SRC_MD5 = 'e7c680dd7aef368f9b2e9bc926328d47';
const LIVE_SELECT_POLICY_MD5 = 'd382425513fedb4d62d8adba408cea49';
const LIVE_REQUIRE_ADMIN_MD5 = '83dbda095d67a37031d5cd093a605a78';
const LIVE_IS_ADMIN_MD5 = 'f76bf61116c3bd52bd9c6ea125079b73';

const id = (n) => `7a400000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = {
  ADMIN: id('a1'), ADMIN_OFF: id('a3'), REP: id('b1'), REP_OFF: id('b3'),
  DRIVER: id('d1'), APPLICATOR: id('e1'), ENTITY: id('f9'),
};
const CUST = id('c1');
const PROD = id('f1');
const REG_ROW = id('9001');

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
  // Replay only what sorts before the candidate; later migrations are not part of its proof.
  const before = all.slice(0, at);
  const later = all.slice(at + 1).map((f) => path.basename(f));
  for (const name of later) {
    assert.ok(!/rup_sales|get_rup_sales_register/i.test(lf(path.join(MIGRATIONS, name))), `${name} sorts after the candidate and touches the register; re-think this proof`);
  }
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!/rup_sales|require_admin|is_admin/i.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
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
    if (base >= LEDGER_FROM) ledger(stem);
    replayed += 1;
  }
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

// ------------------------------------------------------------------------------------------------
// FIDELITY: what the candidate replaces matches live.
function fidelity() {
  assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${REGISTER_FN}');`), LIVE_REGISTER_SRC_MD5,
    'get_rup_sales_register replayed with a body that differs from live');
  assert.equal(scalar(`SELECT md5(cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'rup_sales_records' AND policyname = 'rup_sales_select';`),
    LIVE_SELECT_POLICY_MD5, 'rup_sales_select replayed with a policy that differs from live');
  assert.equal(scalar(`SELECT prosecdef::text || ':' || pg_get_userbyid(proowner) FROM pg_proc WHERE oid = to_regprocedure('${REGISTER_FN}');`), 'true:postgres',
    'get_rup_sales_register is not SECURITY DEFINER owned by postgres, as live');
  // The gate's behavior comes from these helpers; prove the disposable copies are live's.
  for (const [sig, pin] of [['public.require_admin()', LIVE_REQUIRE_ADMIN_MD5], ['public.is_admin()', LIVE_IS_ADMIN_MD5]]) {
    assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${sig}');`), pin, `${sig} replayed with a body that differs from live`);
  }
  console.log('[prover] FIDELITY: the register function body and rup_sales_select match the live pins of 2026-10-14');
}

// ------------------------------------------------------------------------------------------------
// Seed (committed once; every probe rolls back).
function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function asUser(uid) { return uid === 'anon' ? 'SET LOCAL ROLE anon;' : `${claims(uid)}\nSET LOCAL ROLE authenticated;`; }
function seed() {
  const users = [
    [U.ADMIN, 'admin', 'Admin', 9], [U.REP, 'sales_rep', 'Rep', 8], [U.REP_OFF, 'sales_rep', 'Deactivated Rep', 7], [U.ADMIN_OFF, 'admin', 'Deactivated Admin', 3],
    [U.DRIVER, 'driver', 'Driver', 6], [U.APPLICATOR, 'applicator', 'Applicator', 5], [U.ENTITY, 'driver', 'Commission Entity', 4],
  ];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'rup-reg-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    ${claims(U.ADMIN)}
    UPDATE public.profiles SET is_active = false WHERE id IN ('${U.REP_OFF}', '${U.ADMIN_OFF}');
    UPDATE public.profiles SET role = 'entity_recipient' WHERE id = '${U.ENTITY}';
    INSERT INTO public.customers (id, farm_name, is_active, email) VALUES ('${CUST}', '[PROVER] RUP Buyer Farm', true, 'c1@example.invalid');
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, product_form, epa_registration, is_rup)
      VALUES ('${PROD}', '[PROVER] RUP Product', 'GL', 6.00, 10.00, 'liquid', 'PROVER-EPA-RUP', true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.rup_sales_records (id, customer_id, product_id, sale_date, product_name, epa_registration, quantity, unit,
        unit_price_cents, total_cents, buyer_name, buyer_certification_number, compliance_status, season)
      VALUES ('${REG_ROW}', '${CUST}', '${PROD}', (now() AT TIME ZONE 'America/Chicago')::date, '[PROVER] RUP Product', 'PROVER-EPA-RUP', 2, 'GL',
        1000, 2000, '[PROVER] RUP Buyer Farm', 'PROVER-LIC-1', 'compliant', 2027);
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7a400000-%';`),
    'admin:true,sales_rep:true,sales_rep:false,driver:true,applicator:true,entity_recipient:true,admin:false', 'the seeded roles are not what the proof needs');
  assert.equal(scalar('SELECT count(*) FROM public.rup_sales_records;'), '1', 'the register row was not seeded');
}

// ------------------------------------------------------------------------------------------------
// Probes.
/**
 * Run `call` as `uid` ('anon' for a signed-out visitor) after `fixture` (owner), in one rolled-back
 * transaction. ok|<value> or <sqlstate>|<message>.
 */
function attempt(uid, call, { fixture = '' } = {}) {
  const sql = `BEGIN;
${fixture}
RESET ROLE;
${asUser(uid)}
DO $probe$
DECLARE v text;
BEGIN
  v := (${call})::text;
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

const REGISTER = "(SELECT count(*) || ':' || coalesce(string_agg(buyer_certification_number, ','), '') FROM public.get_rup_sales_register(NULL, NULL, NULL, NULL, NULL, false))";
const TABLE = '(SELECT count(*) FROM public.rup_sales_records)';
// The writer posting calls; an unknown invoice returns 0 without writing.
const WRITER = `public.generate_rup_sales_records('${id('ffff')}'::uuid, 'prover-rup-writer')`;
const PULLED = /^ok\|1:PROVER-LIC-1$/;
const REFUSED = /^P0001\|Permission denied: requires admin role$/;
const NO_FN = /^42501\|permission denied for function get_rup_sales_register$/;

/** [label, uid, call, before, after]; 'same' means the result must be identical before and after. */
const CASES = [
  ['admin pulls the register', U.ADMIN, REGISTER, PULLED, 'same'],
  ['rep pulls the register', U.REP, REGISTER, PULLED, REFUSED],
  ['deactivated rep pulls the register', U.REP_OFF, REGISTER, PULLED, REFUSED],
  ['deactivated admin pulls the register', U.ADMIN_OFF, REGISTER, PULLED, REFUSED],
  ['driver pulls the register', U.DRIVER, REGISTER, PULLED, REFUSED],
  ['applicator pulls the register', U.APPLICATOR, REGISTER, PULLED, REFUSED],
  ['commission-recipient profile pulls the register', U.ENTITY, REGISTER, PULLED, REFUSED],
  ['signed-out visitor pulls the register', 'anon', REGISTER, NO_FN, 'same'],

  ['admin reads the table', U.ADMIN, TABLE, /^ok\|1$/, 'same'],
  ['rep reads the table', U.REP, TABLE, /^ok\|1$/, /^ok\|0$/],
  ['deactivated rep reads the table', U.REP_OFF, TABLE, /^ok\|0$/, 'same'],
  ['deactivated admin reads the table', U.ADMIN_OFF, TABLE, /^ok\|0$/, 'same'],
  ['driver reads the table', U.DRIVER, TABLE, /^ok\|0$/, 'same'],
  ['applicator reads the table', U.APPLICATOR, TABLE, /^ok\|0$/, 'same'],
  ['commission-recipient profile reads the table', U.ENTITY, TABLE, /^ok\|0$/, 'same'],
  ['signed-out visitor reads the table', 'anon', TABLE, /^ok\|0$/, /^42501\|permission denied for table rup_sales_records$/],

  ['rep runs the register writer', U.REP, WRITER, /^ok\|0$/, 'same'],
  ['admin runs the register writer', U.ADMIN, WRITER, /^ok\|0$/, 'same'],
];

function runMatrix(phase) {
  const out = {};
  for (const [label, uid, call] of CASES) out[label] = attempt(uid, call);
  console.log(`[prover] ${phase}: ${CASES.length} cases run`);
  return out;
}
function check(phase, results, baseline = null) {
  const failures = [];
  for (const [label, , , before, after] of CASES) {
    const want = phase === 'before' ? before : after;
    const got = results[label];
    if (want === 'same') {
      if (got !== baseline[label]) failures.push(`${label}: changed from "${baseline[label]}" to "${got}"`);
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
CREATE OR REPLACE FUNCTION public.get_rup_sales_register(p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_product_id uuid DEFAULT NULL::uuid, p_customer_id uuid DEFAULT NULL::uuid, p_compliance_status text DEFAULT NULL::text, p_include_voided boolean DEFAULT false)
  RETURNS TABLE(id uuid, sale_date date, invoice_id uuid, customer_id uuid, buyer_name text, product_name text, epa_registration text, quantity numeric, unit text, unit_price_cents bigint, total_cents bigint, buyer_certification_number text, buyer_certification_type text, buyer_certification_expiry date, signal_word text, compliance_status text, compliance_notes text, season integer, voided_at timestamp with time zone, voided_by uuid, void_reason text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN; END; $$;
\\i /tmp/cand.sql
ROLLBACK;`,
    allowFailure: true,
  });
  assert.notEqual(r.status, 0, 'the candidate applied over a drifted body');
  assert.match(r.stderr, /RUP_REGISTER_PREFLIGHT: get_rup_sales_register drifted/, `wrong refusal:\n${r.stderr}`);
  console.log('[prover] PREFLIGHT: a drifted body aborts the candidate before any change');

  // A drifted read policy, and row-level security switched off: each must abort the file.
  for (const [setup, refusal] of [
    ["ALTER POLICY rup_sales_select ON public.rup_sales_records USING ((SELECT public.is_admin()) AND season > 2000);", /RUP_REGISTER_PREFLIGHT: policy rup_sales_select is missing or drifted/],
    ['ALTER TABLE public.rup_sales_records DISABLE ROW LEVEL SECURITY;', /RUP_REGISTER_VERIFY: row-level security is not enabled/],
  ]) {
    const d = docker([...psqlArgs()], { input: `BEGIN;\n${setup}\n\\i /tmp/cand.sql\nROLLBACK;`, allowFailure: true });
    assert.notEqual(d.status, 0, `the candidate applied over: ${setup}`);
    assert.match(d.stderr, refusal, `wrong refusal for ${setup}:\n${d.stderr}`);
  }
  console.log('[prover] PREFLIGHT/VERIFY: a drifted read policy and disabled row-level security each abort the candidate');
}

function main() {
  if (!REUSE) buildContainer();
  else assert.equal(scalar(`SELECT position('require_admin' IN prosrc) FROM pg_proc WHERE oid = to_regprocedure('${REGISTER_FN}');`), '0',
    'the reused container already has the candidate applied (it is in the AFTER state); rebuild it');
  fidelity();
  if (scalar("SELECT count(*) FROM public.profiles WHERE id::text LIKE '7a400000-%';") === '0') seed();

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
  assert.equal(again.status, 0, `re-applying the candidate failed:\n${again.output}`);
  check('after', runMatrix('re-apply'), before);
  console.log('[prover] RE-APPLY: the candidate re-applies cleanly and every result is unchanged');

  const mutant = attempt(U.DRIVER, REGISTER, {
    fixture: 'CREATE OR REPLACE FUNCTION public.require_admin() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN END; $$;',
  });
  assert.match(mutant, PULLED, `MUTATION: with require_admin() emptied the driver should pull the register, got ${mutant}`);
  console.log('[prover] MUTATION: with require_admin() emptied the driver pulls the register, so the refusal is the admin gate');

  console.log('RUP_REGISTER_ADMIN_ONLY_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
