#!/usr/bin/env node
/**
 * Real-schema proof for the 20261022070000 candidate: four role reads require an active profile.
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers), seeds active and inactive users plus a few
 * deliveries, a flagged inventory row and an overdue invoice, then, each call made as that signed-in
 * user (role authenticated, JWT claims) and rolled back:
 *   0. FIDELITY: the four replayed bodies are the live ones the preflight pins;
 *   1. BEFORE: an inactive admin or sales rep sees every delivery on the team board and yesterday's
 *      recap, clears an inventory flag, and reads the overdue-customer list; a caller with no
 *      profile clears the flag; an active sales rep reads a cached inventory result by retry key;
 *      an inactive rep with a forged-looking `user_role: admin` claim reads the overdue list; the
 *      container chain smoke-role-reads-require-active-profile.sql fails;
 *   2. AUTOCOMMIT: run statement by statement the file stops at its preflight, nothing changed;
 *   3. the candidate applies and prints POSTFLIGHT_OK; owners and ACLs unchanged;
 *   4. AFTER: every one of those calls is refused; active admin, sales rep and driver get exactly
 *      what they got before; the chain passes and rolls back;
 *   5. RE-APPLY: refused by the preflight;
 *   6. MUTATION: dropping the `is_active` filter, or the NULL-safe test, reopens the gap.
 *
 * Run: node scripts/smoke/prove-role-reads-require-active-profile-real-schema.mjs   (needs Docker)
 * Prints ROLE_READS_ACTIVE_PROFILE_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-role-active-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261022070000_role_reads_require_active_profile.sql');
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
const COVERED = /get_team_board_deliveries|get_yesterday_delivery_recap|mark_inventory_row_verified|get_ar_reminder_candidates/i;


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


// ------------------------------------------------------------------------------------------------
// Fixture and probes.
const FNS = [
  ['get_team_board_deliveries()', '3f22992ef2e0b1c5e4ff18c2a0d399cd'],
  ['get_yesterday_delivery_recap()', 'a7a6c334f7706982f4f674a267284313'],
  ['mark_inventory_row_verified(uuid,uuid,text)', '38e4d8834f3d6530cfe3bde85557b3c8'],
  ['get_ar_reminder_candidates()', 'aef0983aff530c6f9e54d690bf4e47c1'],
];
const id = (n) => `7a540000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const U = {
  ADMIN: id(1), REP: id(2), DRIVER: id(3),
  IN_ADMIN: id(11), IN_REP: id(12), IN_DRIVER: id(13),
  NO_PROFILE: id(99),
};
const CUSTOMER = id(201);
const ORDER = id(202);
const PRODUCT = id(203);
const INVENTORY = id(204);
// Already verified: a caller who passes the gate gets 'already_verified' with no activity_feed row
// (whose performed_by must be a real user, which a profile-less caller is not).
const INVENTORY_DONE = id(205);
const PRODUCT_DONE = id(206);
const CACHED_KEY = 'prover-role-active-cached';

function seed() {
  // Users through the direct-SQL path of handle_new_user (metadata role honoured), then three of
  // them deactivated. banned_until: live's auth.users has it and the deactivation trigger writes it.
  // Deactivation (_sync_auth_access_on_profile_active) also clears the user's refresh tokens and
  // sessions; the image's auth schema lacks those tables, which live has.
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  const users = [['ADMIN', 'admin'], ['REP', 'sales_rep'], ['DRIVER', 'driver'], ['IN_ADMIN', 'admin'], ['IN_REP', 'sales_rep'], ['IN_DRIVER', 'driver']];
  psql(users.map(([k, role]) => `INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES ('${U[k]}', 'role-active-${k.toLowerCase()}@example.invalid', '{"full_name":"[PROVER] ${k}","role":"${role}"}'::jsonb);`).join('\n'));
  // _guard_profile_role_lock lets only an admin change is_active: deactivate as the seeded admin.
  psql(`BEGIN;
    SELECT set_config('request.jwt.claims', '{"sub":"${U.ADMIN}","role":"authenticated"}', true);
    UPDATE public.profiles SET is_active = false WHERE id IN ('${U.IN_ADMIN}', '${U.IN_REP}', '${U.IN_DRIVER}');
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY id) FROM public.profiles WHERE id::text LIKE '7a540000-%';`),
    'admin:true,sales_rep:true,driver:true,admin:false,sales_rep:false,driver:false', 'seeded profiles are not as intended');

  // Business rows with triggers off (supabase_admin, replica): these functions only read them.
  psql(`SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, email, is_active) VALUES ('${CUSTOMER}', '[PROVER] Farm', 'farm@example.invalid', true);
    INSERT INTO public.orders (id, order_number, customer_id, order_date, status, salesman_id)
      VALUES ('${ORDER}', 'PRV-ORD', '${CUSTOMER}', current_date, 'confirmed', '${U.REP}');
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, status, scheduled_date, assigned_driver) VALUES
      ('PRV-T1', '${ORDER}', '${CUSTOMER}', '${U.ADMIN}', 'scheduled', current_date, '${U.DRIVER}'),
      ('PRV-T2', '${ORDER}', '${CUSTOMER}', '${U.ADMIN}', 'scheduled', current_date, NULL),
      ('PRV-Y1', '${ORDER}', '${CUSTOMER}', '${U.ADMIN}', 'completed', current_date - 1, '${U.DRIVER}'),
      ('PRV-Y2', '${ORDER}', '${CUSTOMER}', '${U.ADMIN}', 'completed', current_date - 1, NULL);
    INSERT INTO public.products (id, product_name, is_active) VALUES ('${PRODUCT}', '[PROVER] Product', true), ('${PRODUCT_DONE}', '[PROVER] Product verified', true);
    INSERT INTO public.inventory (id, product_id, location, quantity_available, manufactured_at_delivery)
      VALUES ('${INVENTORY}', '${PRODUCT}', 'Main Warehouse', 5, true),
             ('${INVENTORY_DONE}', '${PRODUCT_DONE}', 'Main Warehouse', 5, false);
    INSERT INTO public.invoices (invoice_number, customer_id, created_by, invoice_type, status, total_amount_cents, invoice_date, due_date, posted_at)
      VALUES ('PRV-INV-OLD', '${CUSTOMER}', '${U.ADMIN}', 'chemical_sale', 'posted', 12345, current_date - 90, current_date - 60, now() - interval '90 days');
    INSERT INTO public.idempotency_keys (idempotency_key, operation, result, expires_at)
      VALUES ('${CACHED_KEY}', 'mark_inventory_row_verified', '{"inventory_id":"${INVENTORY}","cleared":true,"reason":"seeded-cache"}', now() + interval '1 day');
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
}

/** `sql` as a signed-in user in a rolled-back transaction, after an optional `prefix` run as
 * postgres. Returns the last output line, or ERR:<message>. */
function as(user, sql, { prefix = '', claims = {} } = {}) {
  const jwt = JSON.stringify({ sub: U[user], role: 'authenticated', ...claims });
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;
    ${prefix}
    SET LOCAL ROLE authenticated;
    SELECT set_config('request.jwt.claims', '${jwt}', true);
    SELECT 'OUT=' || COALESCE((${sql})::text, '<null>');
    ROLLBACK;` });
  if (r.status !== 0) {
    const m = /ERROR:\s+([^\n]*)/.exec(r.stderr);
    return `ERR:${m ? m[1].trim() : r.stderr.trim()}`;
  }
  return /OUT=(.*)/.exec(r.stdout)?.[1] ?? `(no output) ${r.stdout}`;
}
const CALLS = {
  board: `SELECT COALESCE((SELECT string_agg(e->>'delivery_number', ',' ORDER BY e->>'delivery_number') FROM jsonb_array_elements(r->'today') e), '') || '|' || (r->>'today_total') FROM public.get_team_board_deliveries() r`,
  recap: `SELECT COALESCE((SELECT string_agg(e->>'delivery_number', ',' ORDER BY e->>'delivery_number') FROM jsonb_array_elements(r->'completed') e), '') || '|' || (r->'summary'->>'total_completed') FROM public.get_yesterday_delivery_recap() r`,
  verify: `SELECT public.mark_inventory_row_verified('${INVENTORY}', NULL, NULL)->>'reason'`,
  verifyDone: `SELECT public.mark_inventory_row_verified('${INVENTORY_DONE}', NULL, NULL)->>'reason'`,
  verifyCached: `SELECT public.mark_inventory_row_verified('${INVENTORY}', NULL, '${CACHED_KEY}')->>'reason'`,
  ar: `SELECT COALESCE((SELECT string_agg(e->>'farm_name', ',') FROM jsonb_array_elements(public.get_ar_reminder_candidates()) e), '')`,
};
const ADMIN_CLAIM = { user_role: 'admin' };
const ALL_DELIVERIES = { board: 'PRV-T1,PRV-T2|2', recap: 'PRV-Y1,PRV-Y2|2' };
const OWN_DELIVERIES = { board: 'PRV-T1|1', recap: 'PRV-Y1|1' };

/** Everything the active users get; must be identical before and after. */
function activeSnapshot() {
  const out = {};
  for (const u of ['ADMIN', 'REP', 'DRIVER']) for (const c of ['board', 'recap', 'verify', 'ar']) out[`${u}.${c}`] = as(u, CALLS[c]);
  return out;
}
/** The calls the candidate closes. */
const GAPS = [
  ['IN_ADMIN', 'board'], ['IN_REP', 'board'], ['IN_DRIVER', 'board'], ['NO_PROFILE', 'board'],
  ['IN_ADMIN', 'recap'], ['IN_REP', 'recap'], ['IN_DRIVER', 'recap'], ['NO_PROFILE', 'recap'],
  ['IN_ADMIN', 'verify'], ['NO_PROFILE', 'verifyDone'], ['REP', 'verifyCached'], ['IN_REP', 'verifyCached'],
  ['IN_ADMIN', 'ar'], ['IN_REP', 'ar', ADMIN_CLAIM], ['DRIVER', 'ar', ADMIN_CLAIM],
];
const REFUSAL = {
  board: /INSUFFICIENT_ROLE: active account required/, recap: /INSUFFICIENT_ROLE: active account required/,
  verify: /INSUFFICIENT_ROLE: admin required/, verifyDone: /INSUFFICIENT_ROLE: admin required/, verifyCached: /INSUFFICIENT_ROLE: admin required/,
  ar: /permission denied: admin role required/,
};

function candidateBody(sigPrefix) {
  const s = lf(CANDIDATE);
  const start = s.indexOf(`CREATE OR REPLACE FUNCTION public.${sigPrefix}`);
  const end = s.indexOf('$function$;', s.indexOf('$function$', start) + 10) + '$function$;'.length;
  assert.ok(start > 0 && end > start, `candidate function ${sigPrefix} not found`);
  return s.slice(start, end);
}
const CHAIN = path.join(ROOT, 'scripts', 'smoke', 'smoke-role-reads-require-active-profile.sql');
/** Run the container chain in a rolled-back transaction: PASS only on SMOKE_PASS_ROLLBACK. */
function chain() {
  stageText('chain.sql', lf(CHAIN));
  const r = docker([...psqlArgs()], { input: 'BEGIN;\n\\i /tmp/chain.sql\nROLLBACK;\n', allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  return { pass: /SMOKE_PASS_ROLLBACK/.test(out), fail: /ERROR:\s+([^\n]*)/.exec(out)?.[1] ?? out.trim() };
}
const md5Of = (sig) => scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = 'public.${sig}'::regprocedure;`);
const aclOf = (sig) => scalar(`SELECT proacl::text || ' ' || pg_get_userbyid(proowner) || ' ' || array_to_string(proconfig, ';') FROM pg_proc WHERE oid = 'public.${sig}'::regprocedure;`);

function main() {
  buildContainer();
  // 0. FIDELITY.
  for (const [sig, pin] of FNS) {
    assert.equal(md5Of(sig), pin, `replayed ${sig} differs from the live pin`);
    assert.ok(lf(CANDIDATE).includes(`'${pin}'`), `the preflight does not pin ${sig}`);
  }
  console.log('[prover] FIDELITY: the four replayed bodies match the live pins of 2026-10-22');
  seed();

  // 1. BEFORE.
  const before = activeSnapshot();
  assert.equal(before['ADMIN.board'], ALL_DELIVERIES.board); assert.equal(before['REP.board'], ALL_DELIVERIES.board);
  assert.equal(before['DRIVER.board'], OWN_DELIVERIES.board);
  assert.equal(before['ADMIN.recap'], ALL_DELIVERIES.recap); assert.equal(before['DRIVER.recap'], OWN_DELIVERIES.recap);
  assert.equal(before['ADMIN.verify'], 'verified_by_admin'); assert.match(before['REP.verify'], REFUSAL.verify);
  assert.equal(before['ADMIN.ar'], '[PROVER] Farm'); assert.match(before['REP.ar'], REFUSAL.ar); assert.match(before['DRIVER.ar'], REFUSAL.ar);
  const gapBefore = {};
  for (const [u, c, claims] of GAPS) {
    const got = as(u, CALLS[c], { claims });
    gapBefore[`${u}.${c}`] = got;
    assert.doesNotMatch(got, /^ERR:/, `BEFORE: ${u} ${c}${claims ? ' (user_role claim)' : ''} was already refused: ${got}`);
  }
  assert.equal(gapBefore['IN_ADMIN.board'], ALL_DELIVERIES.board, 'BEFORE: the inactive admin did not see every delivery');
  assert.equal(gapBefore['IN_REP.recap'], ALL_DELIVERIES.recap, 'BEFORE: the inactive rep did not see every recap delivery');
  assert.equal(gapBefore['IN_ADMIN.verify'], 'verified_by_admin');
  assert.equal(gapBefore['NO_PROFILE.verifyDone'], 'already_verified');
  assert.equal(gapBefore['REP.verifyCached'], 'seeded-cache');
  assert.equal(gapBefore['IN_ADMIN.ar'], '[PROVER] Farm'); assert.equal(gapBefore['IN_REP.ar'], '[PROVER] Farm');
  console.log(`[prover] BEFORE: active users as expected; ${GAPS.length} calls by inactive, profile-less or non-admin callers return data:`);
  for (const [k, v] of Object.entries(gapBefore)) console.log(`[prover]   ${k.padEnd(22)} -> ${v}`);
  const chainBefore = chain();
  assert.ok(!chainBefore.pass, 'BEFORE: the smoke chain passed without the candidate');
  assert.match(chainBefore.fail, /SMOKE_FAIL: a\. an inactive or profile-less caller was not refused/, `BEFORE: the chain failed at the wrong step: ${chainBefore.fail}`);
  console.log(`[prover] BEFORE: the smoke chain fails first: ${chainBefore.fail.slice(0, 120)}`);

  // 2. AUTOCOMMIT.
  stageText('candidate.sql', lf(CANDIDATE));
  const pre = FNS.map(([sig]) => md5Of(sig)).join(',');
  const ac = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(ac.status, 0, 'autocommit apply did not stop');
  assert.match(`${ac.stdout}\n${ac.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit stopped for the wrong reason');
  assert.equal(FNS.map(([sig]) => md5Of(sig)).join(','), pre, 'autocommit changed a function');
  console.log('[prover] AUTOCOMMIT: refused by the preflight, nothing changed');

  // 3. APPLY.
  const acls = FNS.map(([sig]) => aclOf(sig));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.match(a.output, /POSTFLIGHT_OK/, `no POSTFLIGHT_OK:\n${a.output}`);
  assert.deepEqual(FNS.map(([sig]) => aclOf(sig)), acls, 'an owner, ACL or search_path changed');
  console.log(`[prover] candidate applied; POSTFLIGHT_OK; owners, ACLs and search_path unchanged (${acls[0]})`);

  // 4. AFTER.
  for (const [u, c, claims] of GAPS) {
    const got = as(u, CALLS[c], { claims });
    assert.match(got, REFUSAL[c], `AFTER: ${u} ${c}${claims ? ' (user_role claim)' : ''} was not refused: ${got}`);
    console.log(`[prover] AFTER: ${`${u}.${c}${claims ? '+claim' : ''}`.padEnd(22)} -> ${got}`);
  }
  assert.deepEqual(activeSnapshot(), before, 'AFTER: an active user got something different');
  console.log('[prover] AFTER: active admin, sales rep and driver get exactly what they got before');
  const chainAfter = chain();
  assert.ok(chainAfter.pass, `AFTER: the smoke chain failed: ${chainAfter.fail}`);
  console.log('[prover] AFTER: the smoke chain passes and rolls back (SMOKE_PASS_ROLLBACK)');

  // 5. RE-APPLY.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /ROLE_READS_BASELINE_DRIFT/, `re-apply refused for the wrong reason:\n${again.output}`);
  console.log('[prover] RE-APPLY: refused by the preflight');

  // 6. MUTATION: each guard is load-bearing.
  const ACTIVE = ' AND is_active = true;';
  for (const [label, sigPrefix, user, call, claims, edit] of [
    ['board without is_active', 'get_team_board_deliveries()', 'IN_ADMIN', 'board', undefined, (b) => b.replace(ACTIVE, ';')],
    ['recap without is_active', 'get_yesterday_delivery_recap()', 'IN_ADMIN', 'recap', undefined, (b) => b.replace(ACTIVE, ';')],
    ['verify without is_active', 'mark_inventory_row_verified(', 'IN_ADMIN', 'verify', undefined, (b) => b.replace(ACTIVE, ';')],
    ['verify with != instead of IS DISTINCT FROM', 'mark_inventory_row_verified(', 'NO_PROFILE', 'verifyDone', undefined, (b) => b.replace("v_role IS DISTINCT FROM 'admin'", "v_role != 'admin'")],
    ['verify with the cache read first', 'mark_inventory_row_verified(', 'REP', 'verifyCached', undefined, (b) => {
      const cache = /\n {2}-- The cached result[^\n]*\n {2}IF p_idempotency_key IS NOT NULL THEN[\s\S]*?\n {2}END IF;\n/.exec(b)[0];
      return b.replace(cache, '\n').replace('BEGIN\n', `BEGIN\n${cache}`);
    }],
    ['ar without is_active', 'get_ar_reminder_candidates()', 'IN_ADMIN', 'ar', undefined, (b) => b.replace(ACTIVE, ';')],
  ]) {
    const original = candidateBody(sigPrefix);
    const mutated = edit(original);
    assert.notEqual(mutated, original, `MUTATION ${label}: the edit did not apply`);
    const got = as(user, CALLS[call], { claims, prefix: mutated });
    assert.doesNotMatch(got, /^ERR:/, `MUTATION ${label}: expected the gap to reopen, got ${got}`);
    console.log(`[prover] MUTATION: ${label}: ${user} ${call} returns data again (${got})`);
  }

  console.log('ROLE_READS_ACTIVE_PROFILE_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
