#!/usr/bin/env node
/**
 * Real-schema proof for the 20261022023000 candidate: a new login no longer picks its own role.
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers), then, with each Auth-service insert made under
 * SET SESSION AUTHORIZATION supabase_auth_admin (the role live's Auth service writes as:
 * pg_stat_statements, read-only, 2026-10-22) and rolled back:
 *   0. FIDELITY: the replayed handle_new_user body is the live one the preflight pins;
 *   1. BEFORE: a signup whose metadata says role 'admin' gets an ACTIVE ADMIN profile (the gap);
 *   2. AUTOCOMMIT: run statement by statement the file stops at its preflight, nothing changed;
 *   3. ORDERING: refused while #1018's 20261022022000 is not in the ledger; then the candidate
 *      applies and prints POSTFLIGHT_OK; owner, ACL and trigger unchanged;
 *   4. AFTER: that signup, and one with no role, get an inactive, login-banned driver named
 *      'Pending user <id>' (also when its email equals another profile's name); the new user cannot
 *      activate or promote itself; a direct postgres insert still honours its metadata role;
 *   5. ADMIN CREATE: the create-user path (Auth-service insert with the chosen role in metadata)
 *      followed by the Settings page's admin_update_profile call ends with the chosen role and name,
 *      active and unbanned, for each of the four roles the Edge Function accepts; an admin can find
 *      a pending login by email; a duplicate name is refused and leaves it inactive and banned;
 *   6. RE-APPLY: refused by the preflight;
 *   7. MUTATION: trusting supabase_auth_admin, testing current_user, or ignoring SET ROLE lets the signup be admin;
 *      the email as the placeholder name aborts a signup whose email is another profile's name.
 *
 * Run: node scripts/smoke/prove-handle-new-user-ignores-signup-role-real-schema.mjs   (needs Docker)
 * Prints HANDLE_NEW_USER_SIGNUP_ROLE_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-new-user-role-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261022023000_handle_new_user_ignores_signup_role.sql');
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
  // Later candidates (other PRs, stamped after this one) are left out: the proof covers live as it
  // stands when this file applies.
  const before = all.slice(0, at);
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!/handle_new_user|auth\.users/i.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
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


const LIVE_PIN = '7a7df4959435e28126e1c4ad14f6c26a';
const ADMIN = '7a530000-0000-4000-8000-0000000000a1';
let seq = 0;
let lastOut = '';
const newId = () => `7a530000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const meta = (role) => JSON.stringify(role ? { full_name: '[PROVER] New', role } : { full_name: '[PROVER] New' });

/** One rolled-back transaction as supabase_admin: optional prefix, an insert into auth.users made
 * as `sessionUser`, then optional `after` SQL; returns the new profile as role:is_active. */
function probe({ sessionUser, role, prefix = '', after = '', setRole = '' }) {
  const u = newId();
  const r = docker([...psqlArgs('supabase_admin'), '-A', '-t'], { allowFailure: true, input: `BEGIN;
    ${typeof prefix === 'function' ? prefix(u) : prefix}
    SET LOCAL SESSION AUTHORIZATION ${sessionUser};
    ${setRole ? `SET LOCAL ROLE ${setRole};` : ''}
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${u}', 'new-${u.slice(-4)}@example.invalid', '${meta(role)}'::jsonb);
    RESET ROLE;
    RESET SESSION AUTHORIZATION;
    ${after.replaceAll('$NEW', u)}
    SELECT 'RESULT=' || p.role || ':' || p.is_active || ':' || CASE WHEN a.banned_until IS NULL THEN 'open' ELSE 'banned' END
           || ':' || CASE WHEN p.full_name = 'Pending user ' || p.id::text THEN 'pending' WHEN p.full_name = p.email THEN 'email' WHEN p.full_name = '[PROVER] New' THEN 'meta' ELSE 'set' END
      FROM public.profiles p JOIN auth.users a ON a.id = p.id WHERE p.id = '${u}';
    ROLLBACK;` });
  const out = `${r.stdout}\n${r.stderr}`;
  lastOut = out;
  if (r.status !== 0) throw new Error(`probe failed:\n${out}`);
  return /RESULT=(\S+)/.exec(out)?.[1] ?? `(no profile)\n${out}`;
}
/** Run `sql` as a signed-in user (the Data API's role and JWT claims), inside the caller's transaction. */
const asUser = (id, sql) => `SET LOCAL ROLE authenticated;
    SELECT set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated"}', true);
    ${sql}
    RESET ROLE;`;
/** A signup as the Auth service with role admin in its metadata, then `sql` as that new user. */
function selfTry(u, sql) {
  return docker([...psqlArgs('supabase_admin')], { allowFailure: true, input: `BEGIN;
    SET LOCAL SESSION AUTHORIZATION supabase_auth_admin;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${u}', 'self-${u.slice(-2)}@example.invalid', '${meta('admin')}'::jsonb);
    RESET SESSION AUTHORIZATION;
    ${asUser(u, sql)}
    ROLLBACK;` });
}

function seedAdmin() {
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${ADMIN}', 'new-user-admin@example.invalid', '{"full_name":"[PROVER] Admin","role":"admin"}'::jsonb);`);
  assert.equal(scalar(`SELECT role || ':' || is_active FROM public.profiles WHERE id = '${ADMIN}';`), 'admin:true', 'the seeded admin is not an active admin');
}
function body() {
  const s = lf(CANDIDATE);
  const start = s.indexOf('CREATE OR REPLACE FUNCTION public.handle_new_user()');
  const end = s.indexOf('$function$;', start) + '$function$;'.length;
  assert.ok(start > 0 && end > start, 'candidate function not found');
  return s.slice(start, end);
}
const FN = "FROM pg_proc WHERE oid = 'public.handle_new_user()'::regprocedure;";

function main() {
  buildContainer();
  // 0. FIDELITY.
  assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) ${FN}`), LIVE_PIN, 'replayed handle_new_user differs from the live pin');
  assert.ok(lf(CANDIDATE).includes(`'${LIVE_PIN}'`), 'the preflight does not pin the live body');
  console.log('[prover] FIDELITY: replayed handle_new_user matches the live pin of 2026-10-22');
  // The image's auth schema predates GoTrue's banned_until column, which live has (timestamptz,
  // nullable: information_schema read 2026-10-22) and _sync_auth_access_on_profile_active writes.
  psql('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;', { user: 'supabase_admin' });
  seedAdmin();

  // 1. BEFORE.
  assert.equal(probe({ sessionUser: 'supabase_auth_admin', role: 'admin' }), 'admin:true:open:meta', 'BEFORE: the gap did not reproduce');
  console.log('[prover] BEFORE: a signup with role admin in its metadata becomes an ACTIVE ADMIN');

  // 2. AUTOCOMMIT.
  stageText('candidate.sql', lf(CANDIDATE));
  const before = scalar(`SELECT md5(prosrc) ${FN}`);
  const ac = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(ac.status, 0, 'autocommit apply did not stop');
  assert.match(`${ac.stdout}\n${ac.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit stopped for the wrong reason');
  assert.equal(scalar(`SELECT md5(prosrc) ${FN}`), before, 'autocommit changed the function');
  console.log('[prover] AUTOCOMMIT: refused by the preflight, nothing changed');

  // 3. APPLY.
  const acl = scalar(`SELECT proacl::text || ' ' || pg_get_userbyid(proowner) ${FN}`);
  const trgSql = "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'on_auth_user_created';";
  const trg = scalar(trgSql);
  // ORDERING: until #1018's 20261022022000 ledger row exists the candidate refuses, so it can
  // never strand that migration below the live high-water. #1018 is on main now and the replay
  // recorded it, so take its row out of this disposable ledger for the check and put it back.
  psql("DELETE FROM supabase_migrations.schema_migrations WHERE name = '20261022022000_post_binds_reviewed_invoice_version';");
  const early = apply('candidate.sql');
  assert.notEqual(early.status, 0, 'the candidate applied before #1018 was in the ledger');
  assert.match(early.output, /apply 20261022022000_post_binds_reviewed_invoice_version \(#1018\) first/, `refused for the wrong reason:\n${early.output}`);
  assert.equal(scalar(`SELECT md5(prosrc) ${FN}`), before, 'the refused apply changed the function');
  console.log('[prover] ORDERING: refused while #1018 (20261022022000) is not in the ledger');
  ledger('20261022022000_post_binds_reviewed_invoice_version');
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.match(a.output, /POSTFLIGHT_OK/, `no POSTFLIGHT_OK:\n${a.output}`);
  assert.equal(scalar(`SELECT proacl::text || ' ' || pg_get_userbyid(proowner) ${FN}`), acl, 'owner or ACL changed');
  assert.equal(scalar(trgSql), trg, 'the trigger changed');
  console.log('[prover] candidate applied; POSTFLIGHT_OK; owner, ACL and trigger unchanged');

  // 4. AFTER.
  assert.equal(probe({ sessionUser: 'supabase_auth_admin', role: 'admin' }), 'driver:false:banned:pending', 'AFTER: a signup with role admin was not defaulted');
  assert.equal(probe({ sessionUser: 'supabase_auth_admin', role: null }), 'driver:false:banned:pending', 'AFTER: a signup with no role was not defaulted');
  console.log('[prover] AFTER: a signup with role admin (or none) gets an inactive driver, its login banned, named "Pending user <id>"');
  // An existing profile already carries the new user's email as its name (trusted direct insert,
  // as supabase_admin): the placeholder must not collide with it (uq_profiles_full_name_ci).
  const emailTaken = (u) => `INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('7a530000-0000-4000-8000-0000000000e1', 'taken@example.invalid', '{"full_name":"new-${u.slice(-4)}@example.invalid","role":"driver"}'::jsonb);`;
  assert.equal(probe({ sessionUser: 'supabase_auth_admin', role: 'admin', prefix: emailTaken }), 'driver:false:banned:pending', 'AFTER: a signup whose email is another profile\'s name was not created');
  console.log('[prover] AFTER: a signup whose email equals an existing profile\'s name is still created (no name collision)');
  const selfUpdate = selfTry('7a530000-0000-4000-8000-0000000000f1', "UPDATE public.profiles SET is_active = true, role = 'admin' WHERE id = '7a530000-0000-4000-8000-0000000000f1';");
  assert.notEqual(selfUpdate.status, 0, 'the new user activated itself');
  assert.match(selfUpdate.stderr, /PROFILE_ROLE_LOCK/, `self-activation refused for the wrong reason: ${selfUpdate.stderr}`);
  const selfRpc = selfTry('7a530000-0000-4000-8000-0000000000f2', "SELECT public.admin_update_profile('7a530000-0000-4000-8000-0000000000f2', 'admin', NULL, NULL, true, NULL, 'prover-self');");
  assert.notEqual(selfRpc.status, 0, `the new user ran admin_update_profile on itself: ${selfRpc.stdout}`);
  console.log(`[prover] AFTER: the new user cannot activate or promote itself (UPDATE: PROFILE_ROLE_LOCK; admin_update_profile: ${selfRpc.stderr.trim().split('\n')[0].slice(0, 70)})`);
  assert.equal(probe({ sessionUser: 'postgres', role: 'entity_recipient' }), 'entity_recipient:true:open:meta', 'AFTER: a direct postgres insert lost its metadata role');
  console.log('[prover] AFTER: a direct postgres SQL insert still sets its metadata role (seeds, entity recipients)');
  assert.equal(probe({ sessionUser: 'supabase_admin', setRole: 'supabase_auth_admin', role: 'admin' }), 'driver:false:banned:pending', 'AFTER: a supabase_admin login that SET ROLE supabase_auth_admin kept its metadata role');
  // postgres is not a member of supabase_auth_admin (here and live: pg_has_role(..., 'SET') is false, 2026-10-22).
  let denied = '';
  try { probe({ sessionUser: 'postgres', setRole: 'supabase_auth_admin', role: 'admin' }); } catch (e) { denied = String(e.message); }
  assert.match(denied, /permission denied to set role "supabase_auth_admin"/, `AFTER: postgres could SET ROLE supabase_auth_admin: ${denied.slice(0, 200)}`);
  console.log('[prover] AFTER: a supabase_admin login that switches to supabase_auth_admin (SET ROLE) gets an inactive driver; postgres cannot switch to it');

  // 5. ADMIN CREATE: the Edge Function's Auth-service insert, then the Settings page's call.
  for (const role of ['admin', 'sales_rep', 'driver', 'applicator']) {
    const got = probe({ sessionUser: 'supabase_auth_admin', role,
      after: asUser(ADMIN, `SELECT public.admin_update_profile('$NEW', '${role}', '[PROVER] Hire ${role}', NULL, true, NULL, 'admin_update_profile:${ADMIN}:$NEW');`) });
    assert.equal(got, `${role}:true:open:set`, `ADMIN CREATE: role ${role} ended as ${got}`);
  }
  console.log('[prover] ADMIN CREATE: admin, sales_rep, driver and applicator each end with that role and name, active, login unblocked');
  // After a lost create-user reply Settings finds the pending login by email (under profiles RLS)
  // and tells the admin; activating it from the Edit dialog is the same admin_update_profile call.
  const recovered = probe({ sessionUser: 'supabase_auth_admin', role: 'sales_rep',
    after: asUser(ADMIN, `SELECT 'LOOKUP=' || id FROM public.profiles WHERE email = 'new-' || right('$NEW', 4) || '@example.invalid' AND NOT is_active AND full_name = 'Pending user ' || id::text;
      SELECT public.admin_update_profile('$NEW', 'sales_rep', '[PROVER] Recovered', NULL, true, NULL, 'recover:$NEW');`) });
  assert.match(lastOut, /LOOKUP=7a530000-/, `ADMIN CREATE: an admin could not find the pending login by email:\n${lastOut}`);
  assert.equal(recovered, 'sales_rep:true:open:set', `ADMIN CREATE: recovering a pending login left ${recovered}`);
  console.log('[prover] ADMIN CREATE: after a lost reply, an admin can find the pending login by email and activate it');
  const dup = probe({ sessionUser: 'supabase_auth_admin', role: 'sales_rep',
    after: asUser(ADMIN, `DO $dup$ BEGIN PERFORM public.admin_update_profile('$NEW', 'sales_rep', '[PROVER] Admin', NULL, true, NULL, 'dup:$NEW');
      EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'DUP_REFUSED %: %', SQLSTATE, SQLERRM; END $dup$;`) });
  assert.match(lastOut, /DUP_REFUSED/, `ADMIN CREATE: a duplicate name was not refused:\n${lastOut}`);
  assert.equal(dup, 'driver:false:banned:pending', `ADMIN CREATE: a refused duplicate name left ${dup}`);
  console.log(`[prover] ADMIN CREATE: a duplicate name is refused and the login stays inactive and banned (${/DUP_REFUSED[^\n]*/.exec(lastOut)[0].slice(0, 160)})`);

  // 6. RE-APPLY.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /HANDLE_NEW_USER_BASELINE_DRIFT/, `re-apply refused for the wrong reason:\n${again.output}`);
  console.log('[prover] RE-APPLY: refused by the preflight');

  // 7. MUTATION.
  const gate = "IF session_user IN ('postgres', 'supabase_admin') AND current_setting('role') = 'none' THEN";
  assert.ok(body().includes(gate), 'gate line not found');
  for (const [label, line, sessionUser, setRole] of [
    ['trusts supabase_auth_admin', "IF session_user IN ('postgres', 'supabase_admin', 'supabase_auth_admin') THEN"],
    ['tests current_user', "IF current_user IN ('postgres', 'supabase_admin') THEN"],
    ['ignores SET ROLE', "IF session_user IN ('postgres', 'supabase_admin') THEN", 'supabase_admin', 'supabase_auth_admin'],
  ]) {
    const got = probe({ sessionUser: sessionUser || 'supabase_auth_admin', setRole, role: 'admin', prefix: body().replace(gate, line) });
    assert.equal(got, 'admin:true:open:meta', `MUTATION ${label}: expected the gap to reopen, got ${got}`);
    console.log(`[prover] MUTATION: when the gate ${label}, the signup becomes an active admin again`);
  }

  const placeholder = "VALUES (NEW.id, NEW.email, 'Pending user ' || NEW.id::text, 'driver', false);";
  assert.ok(body().includes(placeholder), 'placeholder line not found');
  let collided = '';
  try {
    probe({ sessionUser: 'supabase_auth_admin', role: 'admin', prefix: (u) => body().replace(placeholder, "VALUES (NEW.id, NEW.email, NEW.email, 'driver', false);") + emailTaken(u) });
  } catch (e) { collided = String(e.message); }
  assert.match(collided, /uq_profiles_full_name_ci/, `MUTATION email-as-name: expected the name collision to abort the signup, got: ${collided.slice(0, 300)}`);
  console.log('[prover] MUTATION: with the email as the placeholder name, that signup aborts on uq_profiles_full_name_ci');

  console.log('HANDLE_NEW_USER_SIGNUP_ROLE_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
