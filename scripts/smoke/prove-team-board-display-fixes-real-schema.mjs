#!/usr/bin/env node
/**
 * Real-schema proof for the 20261022086000 candidate: Team Board priority sort and recap time.
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers), seeds active and inactive users plus deliveries of
 * each priority and two completed deliveries whose updated_at disagrees with completed_at, then,
 * each call made as that signed-in user (role authenticated, JWT claims) and rolled back:
 *   0. FIDELITY: the two replayed bodies are the live ones the preflight pins;
 *   1. BEFORE: the board ranks a 'low' delivery ahead of a 'normal' one, and the recap orders and
 *      times a completed delivery by its later edit (updated_at), not by completed_at;
 *   2. AUTOCOMMIT: run statement by statement the file stops at its preflight, nothing changed;
 *   3. the candidate applies and prints POSTFLIGHT_OK; owners, ACLs and search_path unchanged;
 *   4. AFTER: urgent, high, normal, low on both board lists; the recap orders and times by
 *      completed_at; who sees which rows, the counts and every other field are exactly as before;
 *      inactive and profile-less callers are still refused;
 *   5. RE-APPLY: refused by the preflight;
 *   6. MUTATION: putting back 'medium', or updated_at, brings the old order back.
 *
 * Run: node scripts/smoke/prove-team-board-display-fixes-real-schema.mjs   (needs Docker)
 * Prints TEAM_BOARD_DISPLAY_FIXES_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-team-board-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261022086000_team_board_priority_and_recap_completed_at.sql');
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
const COVERED = /get_team_board_deliveries|get_yesterday_delivery_recap/i;


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
  // Replay only what sorts before the candidate. Later migrations (#1057 lands after this one) are
  // not part of this proof; any that redefines these functions must carry its own proof.
  const before = all.slice(0, at);
  for (const later of all.slice(at + 1)) {
    if (COVERED.test(lf(later))) console.log(`[prover] NOTE: ${path.basename(later)} sorts after the candidate and touches what this proves; it is not replayed here`);
  }
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
    -- As live, and as 20261022075000 (delivery completion evidence) requires: metadata jsonb, and
    -- postgres, which owns complete_delivery, may read storage.objects.
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
const FNS = [
  ['get_team_board_deliveries()', '6d7e0afa5977a5e3b85017b30435b75d'],
  ['get_yesterday_delivery_recap()', '401fcbb6b0096a5b6b4c3c3cda8a91e6'],
];
const id = (n) => `7b0a0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const U = { ADMIN: id(1), REP: id(2), DRIVER: id(3), IN_ADMIN: id(11), NO_PROFILE: id(99) };
const CUSTOMER = id(201);
const ORDER = id(202);

function seed() {
  // Users through the direct-SQL path of handle_new_user (metadata role honoured), then one
  // deactivated. banned_until / refresh_tokens / sessions: live's auth schema has them and the
  // deactivation trigger writes them; the image's does not.
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  const users = [['ADMIN', 'admin'], ['REP', 'sales_rep'], ['DRIVER', 'driver'], ['IN_ADMIN', 'admin']];
  psql(users.map(([k, role]) => `INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES ('${U[k]}', 'team-board-${k.toLowerCase()}@example.invalid', '{"full_name":"[PROVER] ${k}","role":"${role}"}'::jsonb);`).join('\n'));
  // _guard_profile_role_lock lets only an admin change is_active: deactivate as the seeded admin.
  psql(`BEGIN;
    SELECT set_config('request.jwt.claims', '{"sub":"${U.ADMIN}","role":"authenticated"}', true);
    UPDATE public.profiles SET is_active = false WHERE id = '${U.IN_ADMIN}';
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY id) FROM public.profiles WHERE id::text LIKE '7b0a0000-%';`),
    'admin:true,sales_rep:true,driver:true,admin:false', 'seeded profiles are not as intended');

  // Business rows with triggers off (supabase_admin, replica): these functions only read them, and
  // replica mode keeps the seeded updated_at instead of the touch trigger's now().
  // Board: same (NULL) scheduled_time, so priority alone orders each list. The driver is assigned
  // only the 'normal' and 'low' ones, so a driver's list exercises the same ranking.
  // Recap: Y-EDITED was completed first (09:00) but edited at 20:00, after Y-LATE was completed
  // (15:00). Fixed times, so no assertion depends on when the proof runs.
  psql(`SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, email, is_active) VALUES ('${CUSTOMER}', '[PROVER] Farm', 'farm@example.invalid', true);
    INSERT INTO public.orders (id, order_number, customer_id, order_date, status, salesman_id)
      VALUES ('${ORDER}', 'PRV-ORD', '${CUSTOMER}', current_date, 'confirmed', '${U.REP}');
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, status, scheduled_date, assigned_driver, priority) VALUES
      ('PRV-T-LOW',    '${ORDER}', '${CUSTOMER}', '${U.ADMIN}', 'scheduled', current_date, '${U.DRIVER}', 'low'),
      ('PRV-T-NORMAL', '${ORDER}', '${CUSTOMER}', '${U.ADMIN}', 'scheduled', current_date, '${U.DRIVER}', 'normal'),
      ('PRV-T-HIGH',   '${ORDER}', '${CUSTOMER}', '${U.ADMIN}', 'scheduled', current_date, NULL, 'high'),
      ('PRV-T-URGENT', '${ORDER}', '${CUSTOMER}', '${U.ADMIN}', 'in_progress', current_date, NULL, 'urgent'),
      ('PRV-M-LOW',    '${ORDER}', '${CUSTOMER}', '${U.ADMIN}', 'scheduled', current_date + 1, '${U.DRIVER}', 'low'),
      ('PRV-M-NORMAL', '${ORDER}', '${CUSTOMER}', '${U.ADMIN}', 'scheduled', current_date + 1, '${U.DRIVER}', 'normal'),
      ('PRV-M-URGENT', '${ORDER}', '${CUSTOMER}', '${U.ADMIN}', 'scheduled', current_date + 1, NULL, 'urgent');
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, created_by, status, scheduled_date, assigned_driver, completed_at, updated_at) VALUES
      ('PRV-Y-EDITED', '${ORDER}', '${CUSTOMER}', '${U.ADMIN}', 'completed', current_date - 1, '${U.DRIVER}',
        (current_date - 1) + time '09:00', (current_date - 1) + time '20:00'),
      ('PRV-Y-LATE',   '${ORDER}', '${CUSTOMER}', '${U.ADMIN}', 'completed', current_date - 1, NULL,
        (current_date - 1) + time '15:00', (current_date - 1) + time '15:00');
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
}

/** `sql` as a signed-in user in a rolled-back transaction, after an optional `prefix` run as
 * postgres. Returns the last output line, or ERR:<message>. */
function as(user, sql, { prefix = '' } = {}) {
  const jwt = JSON.stringify({ sub: U[user], role: 'authenticated' });
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
// Delivery numbers in the order the function returned them.
const inOrder = (expr) => `COALESCE((SELECT string_agg(e->>'delivery_number', ',' ORDER BY o) FROM jsonb_array_elements(${expr}) WITH ORDINALITY AS x(e, o)), '')`;
// Everything except order and completed_at, so "nothing else changed" is checkable.
const sorted = (expr, drop = '') => `COALESCE((SELECT jsonb_agg(e${drop} ORDER BY e->>'delivery_number') FROM jsonb_array_elements(${expr}) e), '[]'::jsonb)::text`;
const CALLS = {
  board: `SELECT ${inOrder("r->'today'")} || '|' || ${inOrder("r->'tomorrow'")} FROM public.get_team_board_deliveries() r`,
  recap: `SELECT ${inOrder("r->'completed'")} || '|' || COALESCE((SELECT string_agg(to_char((e->>'completed_at')::timestamptz AT TIME ZONE current_setting('TimeZone'), 'HH24:MI'), ',' ORDER BY o) FROM jsonb_array_elements(r->'completed') WITH ORDINALITY AS x(e, o)), '') FROM public.get_yesterday_delivery_recap() r`,
  // priority_sort is the rank the fix changes ('normal' 4 -> 2); boardRanks checks it directly.
  boardRest: `SELECT md5(${sorted("r->'today'", " - 'priority_sort'")} || ${sorted("r->'tomorrow'", " - 'priority_sort'")} || (r->>'unassigned_count') || (r->>'today_total')) FROM public.get_team_board_deliveries() r`,
  boardRanks: `SELECT string_agg(DISTINCT (e->>'priority') || '=' || (e->>'priority_sort'), ',') FROM public.get_team_board_deliveries() r, jsonb_array_elements((r->'today') || (r->'tomorrow')) e`,
  recapRest: `SELECT md5(${sorted("r->'completed'", " - 'completed_at'")} || ${sorted("r->'issues'")} || (r->'summary')::text) FROM public.get_yesterday_delivery_recap() r`,
};
const OLD = {
  ADMIN: { board: 'PRV-T-URGENT,PRV-T-HIGH,PRV-T-LOW,PRV-T-NORMAL|PRV-M-URGENT,PRV-M-LOW,PRV-M-NORMAL' },
  DRIVER: { board: 'PRV-T-LOW,PRV-T-NORMAL|PRV-M-LOW,PRV-M-NORMAL' },
};
const NEW = {
  ADMIN: { board: 'PRV-T-URGENT,PRV-T-HIGH,PRV-T-NORMAL,PRV-T-LOW|PRV-M-URGENT,PRV-M-NORMAL,PRV-M-LOW' },
  DRIVER: { board: 'PRV-T-NORMAL,PRV-T-LOW|PRV-M-NORMAL,PRV-M-LOW' },
};
OLD.REP = OLD.ADMIN; NEW.REP = NEW.ADMIN;

function snapshot() {
  const out = {};
  for (const u of ['ADMIN', 'REP', 'DRIVER', 'IN_ADMIN', 'NO_PROFILE']) for (const c of Object.keys(CALLS)) out[`${u}.${c}`] = as(u, CALLS[c]);
  return out;
}
const REFUSED = /^ERR:INSUFFICIENT_ROLE: active account required$/;

function candidateBody(sigPrefix) {
  const s = lf(CANDIDATE);
  const start = s.indexOf(`CREATE OR REPLACE FUNCTION public.${sigPrefix}`);
  const end = s.indexOf('$function$;', s.indexOf('$function$', start) + 10) + '$function$;'.length;
  assert.ok(start > 0 && end > start, `candidate function ${sigPrefix} not found`);
  return s.slice(start, end);
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
  console.log('[prover] FIDELITY: the two replayed bodies match the live pins of 2026-10-23');
  seed();

  // 1. BEFORE.
  const before = snapshot();
  for (const u of ['ADMIN', 'REP', 'DRIVER']) assert.equal(before[`${u}.board`], OLD[u].board, `BEFORE: ${u} board order`);
  // Ordered by the later edit, and the edited delivery shows the edit's time, not 09:00.
  assert.equal(before['ADMIN.recap'], 'PRV-Y-LATE,PRV-Y-EDITED|15:00,20:00', 'BEFORE: recap not ordered and timed by the later edit');
  for (const u of ['IN_ADMIN', 'NO_PROFILE']) for (const c of Object.keys(CALLS)) assert.match(before[`${u}.${c}`], REFUSED, `BEFORE: ${u} ${c} not refused`);
  console.log(`[prover] BEFORE: 'low' ranks ahead of 'normal': ${before['ADMIN.board']}`);
  console.log(`[prover] BEFORE: recap follows the later edit:   ${before['ADMIN.recap']}`);

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
  const after = snapshot();
  for (const u of ['ADMIN', 'REP', 'DRIVER']) assert.equal(after[`${u}.board`], NEW[u].board, `AFTER: ${u} board order`);
  assert.equal(after['ADMIN.recap'], 'PRV-Y-EDITED,PRV-Y-LATE|09:00,15:00', 'AFTER: recap not ordered and timed by completed_at');
  assert.equal(after['REP.recap'], after['ADMIN.recap'], 'AFTER: rep recap differs from admin');
  assert.equal(after['DRIVER.recap'], 'PRV-Y-EDITED|09:00', 'AFTER: driver recap');
  assert.equal(before['ADMIN.boardRanks'], 'high=1,low=3,normal=4,urgent=0', 'BEFORE: ranks');
  assert.equal(after['ADMIN.boardRanks'], 'high=1,low=3,normal=2,urgent=0', 'AFTER: ranks');
  for (const k of Object.keys(before)) {
    if (/\.(board|recap|boardRanks)$/.test(k) && !/^(IN_ADMIN|NO_PROFILE)\./.test(k)) continue;
    assert.equal(after[k], before[k], `AFTER: ${k} changed`);
  }
  console.log(`[prover] AFTER: urgent, high, normal, low:          ${after['ADMIN.board']}`);
  console.log(`[prover] AFTER: driver sees the same ranking:      ${after['DRIVER.board']}`);
  console.log(`[prover] AFTER: recap by completed_at:             ${after['ADMIN.recap']}`);
  console.log('[prover] AFTER: rows, counts and every other field identical for admin, rep and driver; inactive and profile-less callers still refused');

  // 5. RE-APPLY.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /TEAM_BOARD_DISPLAY_BASELINE_DRIFT/, `re-apply refused for the wrong reason:\n${again.output}`);
  console.log('[prover] RE-APPLY: refused by the preflight');

  // 6. MUTATION: each fix is load-bearing.
  for (const [label, sigPrefix, call, expected, edit] of [
    ["board with 'medium' again", 'get_team_board_deliveries()', 'board', OLD.ADMIN.board, (b) => b.replaceAll("WHEN 'normal' THEN 2", "WHEN 'medium' THEN 2")],
    ['recap ordered by updated_at again', 'get_yesterday_delivery_recap()', 'recap', 'PRV-Y-LATE,PRV-Y-EDITED|15:00,09:00', (b) => b.replace('ORDER BY COALESCE(del.completed_at, del.updated_at)', 'ORDER BY del.updated_at')],
    ['recap timed by updated_at again', 'get_yesterday_delivery_recap()', 'recap', 'PRV-Y-EDITED,PRV-Y-LATE|20:00,15:00', (b) => b.replace("'completed_at', COALESCE(del.completed_at, del.updated_at)", "'completed_at', del.updated_at")],
  ]) {
    const original = candidateBody(sigPrefix);
    const mutated = edit(original);
    assert.notEqual(mutated, original, `MUTATION ${label}: the edit did not apply`);
    const got = as('ADMIN', CALLS[call], { prefix: mutated });
    if (expected instanceof RegExp) assert.match(got, expected, `MUTATION ${label}: got ${got}`);
    else assert.equal(got, expected, `MUTATION ${label}: got ${got}`);
    console.log(`[prover] MUTATION: ${label}: the old result comes back (${got})`);
  }

  console.log('TEAM_BOARD_DISPLAY_FIXES_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
