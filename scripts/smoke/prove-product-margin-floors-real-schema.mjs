#!/usr/bin/env node
/**
 * Full-chain proof for the 20261025210000 candidate: a margin floor per product (To-Do 0.2, pricing
 * plan slice 8; Mason, 2026-10-14: per product, no company-wide default).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate, checks
 * every md5 pin in the candidate's preflight against the replayed body, seeds one admin / deactivated
 * admin / sales rep / driver and three products, then runs one matrix BEFORE and AFTER the candidate.
 * Each scenario is one transaction that always rolls back; each step runs as a PostgREST session
 * (request.jwt.claims + SET LOCAL ROLE authenticated), a signed-out visitor (anon), the owner with the
 * admin's JWT, or the bare owner.
 *   1. set_product_margin_floors as an admin: set, change (14.3% stays exactly 0.143), unchanged
 *      writes nothing, clear; several products in one call; history who/what/why in order.
 *   2. Retry safety: key required; exact replay returns the first result and writes nothing; the
 *      same key with a different request is refused.
 *   3. Input refusals: out of range, three decimals, a string, a missing field, a duplicate or bad
 *      product id, an unknown product, an empty list, an actor mismatch, a too-long reason.
 *   4. Who: rep, driver and deactivated admin refused; signed-out visitor cannot execute; reps read
 *      no floors and no history; no API role writes either table; history is append-only for the
 *      owner too; deleting a product removes its floor and keeps its history.
 *   5. Grants; preflight drift refusals; a second apply is refused; MUTATION: require_admin()
 *      emptied lets a rep set a floor.
 *
 * Run: node scripts/smoke/prove-product-margin-floors-real-schema.mjs   (needs Docker)
 * Prints PRODUCT_MARGIN_FLOORS_PROOF_PASS on success. CRX_PROVER_VERBOSE=1 prints every step.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-margin-floor-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1' || REUSE;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261025210000_product_margin_floors.sql');
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
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(FUNCTION\s+(public\.)?"?(set_product_margin_floors|_product_margin_floor_changes_append_only|is_admin|require_admin|check_idempotency_intent|save_idempotency|_bind_replay_receipt_20261015|_replay_fingerprint_20261015|_cost_step2_try_uuid|update_updated_at)\b|product_margin_floor)/i;
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';

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
  for (const file of all.slice(at + 1)) {
    assert.ok(!TOUCHED.test(lf(file)), `${path.basename(file)} sorts after the candidate and touches what it relies on; re-think this proof`);
  }
  const before = all.slice(0, at);
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!TOUCHED.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
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
// FIDELITY: every md5 pin in the candidate's preflight matches the replayed body.
function fidelity() {
  const sql = lf(CANDIDATE).split('$preflight$')[1];
  const all = [...sql.matchAll(/^\s*\('(public\.[a-z_0-9]+\([^']*\))', '([0-9a-f]{32})'\)/gm)].map((m) => [m[1], m[2]]);
  assert.equal(all.length, 8, 'the preflight pins eight bodies');
  for (const [sig, pin] of all) {
    const got = scalar(`SELECT coalesce(md5(replace(prosrc, chr(13), '')), 'MISSING') FROM pg_proc WHERE oid = to_regprocedure('${sig}') UNION ALL SELECT 'MISSING' LIMIT 1;`);
    assert.equal(got, pin, `${sig} replayed with a body that differs from the live pin of 2026-10-25`);
  }
  console.log(`[prover] FIDELITY: all ${all.length} pinned bodies match the live pins of 2026-10-25`);
}

// ------------------------------------------------------------------------------------------------
// Fixtures (committed once; every probe rolls back).
const id = (n) => `7c310000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), ADMIN_OFF: id('a3'), REP: id('b1'), DRIVER: id('d1') };
const PROD = id('f1');
const PROD_B = id('f2');
const PROD_C = id('f3');
const MISSING = id('ff');
const j = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const q = (value) => `'${value}'`;

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.REP, 'sales_rep', 'Rep', 8], [U.DRIVER, 'driver', 'Driver', 6], [U.ADMIN_OFF, 'admin', 'Deactivated Admin', 3]];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'margin-floor-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};`);
  // The role is set directly too, in case handle_new_user no longer honours the metadata role.
  psql(`SET session_replication_role = replica;
    ${users.map(([u, role, , minutes]) => `UPDATE public.profiles SET role = '${role}', is_active = true, created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  // _guard_profile_role_lock lets only an admin change is_active: deactivate as the seeded admin.
  psql(`BEGIN;
    ${claims(U.ADMIN)}
    UPDATE public.profiles SET is_active = false WHERE id = '${U.ADMIN_OFF}';
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, product_form, is_active) VALUES
      ('${PROD}', '[PROVER] Floor A', 'gal', 22.50, 30.00, 'liquid', true),
      ('${PROD_B}', '[PROVER] Floor B', 'gal', 7.25, 12.00, 'liquid', true),
      ('${PROD_C}', '[PROVER] Floor C', 'gal', 9.00, 12.00, 'liquid', false);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7c310000-%';`),
    'admin:true,sales_rep:true,driver:true,admin:false', 'the seeded roles are not what the proof needs');
  console.log('[prover] seeded admin / deactivated admin / sales rep / driver and three products (one inactive)');
}

// ------------------------------------------------------------------------------------------------
// Probes: one transaction per scenario, always rolled back. Each step runs as a role inside its own
// sub-transaction, so a refused step leaves the scenario going. A step yields "ok|<value>" or
// "<sqlstate>|<message>".
function who(as) {
  if (as === 'owner') return `RESET ROLE;\n${claims(U.ADMIN)}`;
  if (as === 'bare') return `RESET ROLE;\nSELECT set_config('request.jwt.claims', '', true);\nSELECT set_config('request.jwt.claim.sub', '', true);`;
  if (as === 'anon') return `RESET ROLE;\nSELECT set_config('request.jwt.claims', '{"role":"anon"}', true);\nSELECT set_config('request.jwt.claim.sub', '', true);\nSET LOCAL ROLE anon;`;
  return `RESET ROLE;\n${claims(as)}\nSET LOCAL ROLE authenticated;`;
}
function scenario(steps, fixture = '') {
  const sql = ['BEGIN;', fixture];
  for (const s of steps) {
    const body = s.stmt ? s.stmt : `v := (${s.call})::text;`;
    // A step name may say "15%": RAISE formats % as a placeholder, so double it.
    const key = s.key.replaceAll('%', '%%');
    sql.push(who(s.as), `DO $probe$
DECLARE v text;
BEGIN
  ${body}
  RAISE NOTICE 'RESULT|${key}|ok|%', COALESCE(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'RESULT|${key}|%|%', SQLSTATE, replace(SQLERRM, chr(10), ' ');
END
$probe$;`);
  }
  sql.push('ROLLBACK;');
  const text = sql.join('\n');
  const r = docker([...psqlArgs(), '-A', '-t'], { input: text, allowFailure: true });
  assert.equal(r.status, 0, `scenario failed to run:\n${r.stderr}\n--- SQL ---\n${text}`);
  const out = {};
  for (const m of r.stderr.matchAll(/RESULT\|([^|\n]+)\|([^\n]*)/g)) out[m[1]] = m[2].trimEnd();
  for (const s of steps) assert.ok(s.key in out, `step ${s.key} printed no RESULT:\n${r.stderr}`);
  return out;
}

const DENIED = /^P0001\|Permission denied: requires admin role$/;
const MISSING_FN = /^42883\|function public\.set_product_margin_floors\(.*\) does not exist$/;
const NO_TABLE = (t) => new RegExp(`^42P01\\|relation "public\\.${t}" does not exist$`);
const NO_WRITE = (table) => new RegExp(`^42501\\|permission denied for table ${table}$`);
const NO_EXEC = /^42501\|permission denied for function set_product_margin_floors$/;

// "<changed>:<unchanged>"
const setFloors = (actor, items, reason, key, performedBy = actor) => `(SELECT (r->>'changed_count') || ':' || (r->>'unchanged_count') FROM (SELECT public.set_product_margin_floors(${typeof items === 'string' ? items : j(items)}, ${reason === null ? 'NULL' : q(reason)}, ${performedBy === null ? 'NULL' : q(performedBy)}, ${key === null ? 'NULL' : q(key)}) AS r) s)`;
const item = (product, pct) => ({ product_id: product, margin_floor_percent: pct });
// "<floor>:<set_by last two>:<reason>" or "none"
const FLOOR = (product) => `(SELECT COALESCE((SELECT f.margin_floor::text || ':' || right(COALESCE(f.set_by::text, 'none'), 2) || ':' || COALESCE(f.set_reason, '-') FROM public.product_margin_floors f WHERE f.product_id = '${product}'), 'none'))`;
// "<old>><new>:<reason>:<changed_by last two>" in the order written
const HIST = (product) => `(SELECT COALESCE(string_agg(COALESCE(h.old_margin_floor::text, '-') || '>' || COALESCE(h.new_margin_floor::text, '-')
  || ':' || COALESCE(h.reason, '-') || ':' || right(COALESCE(h.changed_by::text, 'none'), 2), ',' ORDER BY h.created_at, h.id), 'none')
  FROM public.product_margin_floor_changes h WHERE h.product_id = '${product}')`;
const COUNT = (table) => `(SELECT count(*) FROM public.${table})`;
const REASON = 'Wells letter 2026-10-20: keep 15% on this one';

/**
 * Scenarios. Each step: [key, as, call|{stmt}, before, after]. before/after: a RegExp, an exact
 * string, or 'same' (identical in both phases).
 */
const SCENARIOS = [
  { name: '1. set, change, unchanged, clear', steps: [
    ['admin sets 15% with a reason', U.ADMIN, setFloors(U.ADMIN, [item(PROD, 15)], REASON, 'k1'), MISSING_FN, 'ok|1:0'],
    ['stored: 0.15 by admin with reason', 'owner', FLOOR(PROD), NO_TABLE('product_margin_floors'), `ok|0.15:a1:${REASON}`],
    ['admin changes it to 14.3% with no reason', U.ADMIN, setFloors(U.ADMIN, [item(PROD, 14.3)], null, 'k2'), MISSING_FN, 'ok|1:0'],
    ['stored: exactly 0.143, reason cleared', 'owner', FLOOR(PROD), NO_TABLE('product_margin_floors'), 'ok|0.143:a1:-'],
    ['admin saves 14.3% again (new key)', U.ADMIN, setFloors(U.ADMIN, [item(PROD, 14.3)], null, 'k3'), MISSING_FN, 'ok|0:1'],
    ['admin sets 0% on B and clears A in one call', U.ADMIN, setFloors(U.ADMIN, [item(PROD, null), item(PROD_B, 0)], 'cleanup', 'k4'), MISSING_FN, 'ok|2:0'],
    ['stored: A has no floor', 'owner', FLOOR(PROD), NO_TABLE('product_margin_floors'), 'ok|none'],
    ['stored: B has 0', 'owner', FLOOR(PROD_B), NO_TABLE('product_margin_floors'), 'ok|0:a1:cleanup'],
    ['clearing a floor that is not set changes nothing', U.ADMIN, setFloors(U.ADMIN, [item(PROD_C, null)], null, 'k5'), MISSING_FN, 'ok|0:1'],
    ['an inactive product can have a floor', U.ADMIN, setFloors(U.ADMIN, [item(PROD_C, 99.99)], null, 'k6'), MISSING_FN, 'ok|1:0'],
    ['history: A in order', 'owner', HIST(PROD), NO_TABLE('product_margin_floor_changes'), `ok|->0.15:${REASON}:a1,0.15>0.143:-:a1,0.143>-:cleanup:a1`],
    ['history: B', 'owner', HIST(PROD_B), NO_TABLE('product_margin_floor_changes'), 'ok|->0:cleanup:a1'],
    ['history: C (the no-op clear wrote nothing)', 'owner', HIST(PROD_C), NO_TABLE('product_margin_floor_changes'), 'ok|->0.9999:-:a1'],
    ['activity feed: one row per call that changed something, no margins in it', 'owner',
      "(SELECT string_agg(description, ',' ORDER BY created_at) FROM public.activity_feed WHERE event_type = 'product_margin_floors_updated')",
      'ok|<null>', 'ok|1 product margin floor(s) updated,1 product margin floor(s) updated,2 product margin floor(s) updated,1 product margin floor(s) updated'],
  ] },
  { name: '2. retry safety', steps: [
    ['no key', U.ADMIN, setFloors(U.ADMIN, [item(PROD, 15)], null, null), MISSING_FN, /^22023\|IDEMPOTENCY_KEY_REQUIRED: /],
    ['blank key', U.ADMIN, setFloors(U.ADMIN, [item(PROD, 15)], null, '  '), MISSING_FN, /^22023\|IDEMPOTENCY_KEY_REQUIRED: /],
    ['first call', U.ADMIN, setFloors(U.ADMIN, [item(PROD, 15)], null, 'r1'), MISSING_FN, 'ok|1:0'],
    ['exact replay returns the first result', U.ADMIN, setFloors(U.ADMIN, [item(PROD, 15)], null, 'r1'), MISSING_FN, 'ok|1:0'],
    ['replay wrote no second history row', 'owner', HIST(PROD), NO_TABLE('product_margin_floor_changes'), 'ok|->0.15:-:a1'],
    ['same key, different floor, refused', U.ADMIN, setFloors(U.ADMIN, [item(PROD, 16)], null, 'r1'), MISSING_FN, /^22023\|IDEMPOTENCY_INTENT_MISMATCH/],
    ['same key, different reason, refused', U.ADMIN, setFloors(U.ADMIN, [item(PROD, 15)], 'x', 'r1'), MISSING_FN, /^22023\|IDEMPOTENCY_INTENT_MISMATCH/],
    ['still 0.15', 'owner', FLOOR(PROD), NO_TABLE('product_margin_floors'), 'ok|0.15:a1:-'],
  ] },
  { name: '3. input refusals', steps: [
    ['100%', U.ADMIN, setFloors(U.ADMIN, [item(PROD, 100)], null, 'i1'), MISSING_FN, /^22023\|MARGIN_FLOOR_PERCENT_INVALID: /],
    ['-1%', U.ADMIN, setFloors(U.ADMIN, [item(PROD, -1)], null, 'i2'), MISSING_FN, /^22023\|MARGIN_FLOOR_PERCENT_INVALID: /],
    ['three decimals', U.ADMIN, setFloors(U.ADMIN, [item(PROD, 12.345)], null, 'i3'), MISSING_FN, /^22023\|MARGIN_FLOOR_PERCENT_INVALID: /],
    ['a string', U.ADMIN, setFloors(U.ADMIN, [item(PROD, '15')], null, 'i4'), MISSING_FN, /^22023\|MARGIN_FLOOR_PERCENT_INVALID: /],
    ['missing field', U.ADMIN, setFloors(U.ADMIN, [{ product_id: PROD }], null, 'i5'), MISSING_FN, /^P0001\|MARGIN_FLOOR_PERCENT_REQUIRED: /],
    ['duplicate product (case differs)', U.ADMIN, setFloors(U.ADMIN, [item(PROD, 10), item(PROD.toUpperCase(), 11)], null, 'i6'), MISSING_FN, /^P0001\|MARGIN_FLOOR_PRODUCT_DUPLICATE: /],
    ['bad product id', U.ADMIN, setFloors(U.ADMIN, [item('nope', 10)], null, 'i7'), MISSING_FN, /^P0001\|MARGIN_FLOOR_ITEM_INVALID: each item needs a valid product_id$/],
    ['unknown product', U.ADMIN, setFloors(U.ADMIN, [item(MISSING, 10)], null, 'i8'), MISSING_FN, /^P0001\|MARGIN_FLOOR_PRODUCT_NOT_FOUND: /],
    ['empty list', U.ADMIN, setFloors(U.ADMIN, [], null, 'i9'), MISSING_FN, /^P0001\|MARGIN_FLOOR_ITEMS_REQUIRED$/],
    ['an item that is not an object', U.ADMIN, setFloors(U.ADMIN, [5], null, 'i13'), MISSING_FN, /^P0001\|MARGIN_FLOOR_ITEM_INVALID: /],
    ['not a list', U.ADMIN, setFloors(U.ADMIN, { product_id: PROD }, null, 'i10'), MISSING_FN, /^P0001\|MARGIN_FLOOR_ITEMS_REQUIRED$/],
    ['actor mismatch', U.ADMIN, setFloors(U.ADMIN, [item(PROD, 10)], null, 'i11', U.REP), MISSING_FN, /^P0001\|ACTOR_MISMATCH: /],
    ['reason over 500 characters', U.ADMIN, setFloors(U.ADMIN, [item(PROD, 10)], 'x'.repeat(501), 'i12'), MISSING_FN, /^P0001\|MARGIN_FLOOR_REASON_TOO_LONG: /],
    ['nothing was written', 'owner', `${COUNT('product_margin_floors')} || ':' || ${COUNT('product_margin_floor_changes')}`, NO_TABLE('product_margin_floors'), 'ok|0:0'],
  ] },
  { name: '4. who may read and write', steps: [
    ['admin sets A 20%', U.ADMIN, setFloors(U.ADMIN, [item(PROD, 20)], null, 'w1'), MISSING_FN, 'ok|1:0'],
    ['rep refused', U.REP, setFloors(U.REP, [item(PROD, 1)], null, 'w2'), MISSING_FN, DENIED],
    ['driver refused', U.DRIVER, setFloors(U.DRIVER, [item(PROD, 1)], null, 'w3'), MISSING_FN, DENIED],
    ['deactivated admin refused', U.ADMIN_OFF, setFloors(U.ADMIN_OFF, [item(PROD, 1)], null, 'w4'), MISSING_FN, DENIED],
    ['signed-out visitor cannot execute', 'anon', setFloors(null, [item(PROD, 1)], null, 'w5', null), MISSING_FN, NO_EXEC],
    ['admin reads floors', U.ADMIN, COUNT('product_margin_floors'), NO_TABLE('product_margin_floors'), 'ok|1'],
    ['admin reads history', U.ADMIN, COUNT('product_margin_floor_changes'), NO_TABLE('product_margin_floor_changes'), 'ok|1'],
    ['rep reads no floors', U.REP, COUNT('product_margin_floors'), NO_TABLE('product_margin_floors'), 'ok|0'],
    ['rep reads no history', U.REP, COUNT('product_margin_floor_changes'), NO_TABLE('product_margin_floor_changes'), 'ok|0'],
    ['deactivated admin reads no floors', U.ADMIN_OFF, COUNT('product_margin_floors'), NO_TABLE('product_margin_floors'), 'ok|0'],
    ['signed-out visitor reads no floors', 'anon', COUNT('product_margin_floors'), NO_TABLE('product_margin_floors'), /^42501\|permission denied for table product_margin_floors$/],
    ['admin writes a floor directly', U.ADMIN, { stmt: `INSERT INTO public.product_margin_floors (product_id, margin_floor) VALUES ('${PROD_B}', 0.5); v := 'inserted';` }, NO_TABLE('product_margin_floors'), NO_WRITE('product_margin_floors')],
    ['admin edits a floor directly', U.ADMIN, { stmt: `UPDATE public.product_margin_floors SET margin_floor = 0.01; v := 'updated';` }, NO_TABLE('product_margin_floors'), NO_WRITE('product_margin_floors')],
    ['admin writes history directly', U.ADMIN, { stmt: `INSERT INTO public.product_margin_floor_changes (product_id, new_margin_floor) VALUES ('${PROD_B}', 0.5); v := 'inserted';` }, NO_TABLE('product_margin_floor_changes'), NO_WRITE('product_margin_floor_changes')],
    ['owner edits history', 'bare', { stmt: `UPDATE public.product_margin_floor_changes SET reason = 'x'; v := 'updated';` }, NO_TABLE('product_margin_floor_changes'), /^P0001\|MARGIN_FLOOR_HISTORY_APPEND_ONLY: /],
    ['owner deletes history', 'bare', { stmt: `DELETE FROM public.product_margin_floor_changes; v := 'deleted';` }, NO_TABLE('product_margin_floor_changes'), /^P0001\|MARGIN_FLOOR_HISTORY_APPEND_ONLY: /],
    ['owner truncates history', 'bare', { stmt: `TRUNCATE public.product_margin_floor_changes; v := 'truncated';` }, NO_TABLE('product_margin_floor_changes'), /^P0001\|MARGIN_FLOOR_HISTORY_APPEND_ONLY: /],
    ['owner writes an out-of-range floor', 'bare', { stmt: `UPDATE public.product_margin_floors SET margin_floor = 1; v := 'updated';` }, NO_TABLE('product_margin_floors'), /^23514\|.*product_margin_floors_range/],
    ['owner deletes product A', 'bare', { stmt: `DELETE FROM public.products WHERE id = '${PROD}'; v := 'deleted';` }, 'ok|deleted', 'same'],
    ['its floor is gone, its history stays', 'owner', `${FLOOR(PROD)} || '|' || ${HIST(PROD)}`, NO_TABLE('product_margin_floors'), 'ok|none|->0.2:-:a1'],
  ] },
];

function runMatrix(phase) {
  const out = {};
  for (const sc of SCENARIOS) {
    const steps = sc.steps.map(([key, as, call]) => ({ key, as, ...(typeof call === 'string' ? { call } : call) }));
    const res = scenario(steps);
    for (const [key] of sc.steps) out[`${sc.name} / ${key}`] = res[key];
  }
  console.log(`[prover] ${phase}: ${Object.keys(out).length} steps run`);
  return out;
}
function check(phase, results) {
  const failures = [];
  const lines = [];
  for (const sc of SCENARIOS) {
    for (const step of sc.steps) {
      const label = `${sc.name} / ${step[0]}`;
      let want = phase === 'before' ? step[3] : step[4];
      if (want === 'same') want = step[3];
      const got = results[label];
      const ok = want instanceof RegExp ? want.test(got) : got === want;
      if (!ok) failures.push(`${label}: got "${got}", expected ${want instanceof RegExp ? want : `"${want}"`}`);
      lines.push(`  ${ok ? 'PASS' : 'FAIL'} ${label} -> ${got}`);
    }
  }
  if (process.env.CRX_PROVER_VERBOSE === '1' || failures.length) console.log(lines.join('\n'));
  assert.deepEqual(failures, [], `${phase.toUpperCase()} failed:\n  ${failures.join('\n  ')}`);
  console.log(`[prover] ${phase.toUpperCase()}: all ${lines.length} steps as expected`);
}

// ------------------------------------------------------------------------------------------------
function grants() {
  const fns = docker([...psqlArgs(), '-A', '-t', '-F', '|'], { input: `SELECT p.oid::regprocedure,
      has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      has_function_privilege('service_role', p.oid, 'EXECUTE'), p.prosecdef, array_to_string(p.proconfig, ';')
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('set_product_margin_floors', '_product_margin_floor_changes_append_only')
    ORDER BY 1;` }).stdout.trim().split(/\r?\n/).map((l) => l.split('|'));
  assert.deepEqual(fns.map((r) => r[0]).sort(), ['_product_margin_floor_changes_append_only()', 'set_product_margin_floors(jsonb,text,uuid,text)']);
  for (const [sig, anon, auth, svc, secdef, cfg] of fns) {
    if (sig.startsWith('set_')) {
      assert.deepEqual([anon, auth, svc, secdef], ['f', 't', 'f', 't'], `${sig}: only authenticated may execute, as definer`);
    } else {
      assert.deepEqual([anon, auth, svc], ['f', 'f', 'f'], `${sig} is executable by an API role`);
    }
    assert.equal(cfg, 'search_path=public, pg_temp', `${sig} must pin search_path`);
  }
  for (const t of ['product_margin_floors', 'product_margin_floor_changes']) {
    const table = scalar(`SELECT string_agg(r || ':' || p || ':' || has_table_privilege(r, 'public.${t}', p), ',' ORDER BY r, p)
      FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p;`);
    assert.equal(table, 'anon:DELETE:false,anon:INSERT:false,anon:SELECT:false,anon:TRUNCATE:false,anon:UPDATE:false,'
      + 'authenticated:DELETE:false,authenticated:INSERT:false,authenticated:SELECT:true,authenticated:TRUNCATE:false,authenticated:UPDATE:false,'
      + 'service_role:DELETE:false,service_role:INSERT:false,service_role:SELECT:false,service_role:TRUNCATE:false,service_role:UPDATE:false', `${t} grants`);
    assert.equal(scalar(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.${t}'::regclass;`), 't', `RLS on ${t}`);
  }
  console.log('[prover] GRANTS: set_product_margin_floors executable by authenticated only; the trigger function by no API role; both tables readable (RLS) by authenticated only, writable by no API role');
}

function preflightRefusesDrift(phase) {
  stageText('cand.sql', lf(CANDIDATE));
  const cases = phase === 'before' ? [
    ['CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN true; END; $$;',
      /MARGIN_FLOOR_PREFLIGHT: public\.is_admin\(\) changed since 2026-10-25/],
    ['CREATE TABLE public.product_margin_floors (id int);',
      /MARGIN_FLOOR_PREFLIGHT: an object this migration creates already exists/],
    ['CREATE FUNCTION public.set_product_margin_floors(int) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
      /MARGIN_FLOOR_PREFLIGHT: an object this migration creates already exists/],
  ] : [
    ['SELECT 1;', /MARGIN_FLOOR_PREFLIGHT: an object this migration creates already exists/],
  ];
  for (const [setup, refusal] of cases) {
    const d = docker([...psqlArgs()], { input: `BEGIN;\n${setup}\n\\i /tmp/cand.sql\nROLLBACK;`, allowFailure: true });
    assert.notEqual(d.status, 0, `the candidate applied over: ${setup}`);
    assert.match(d.stderr, refusal, `wrong refusal for ${setup}:\n${d.stderr}`);
  }
  console.log(`[prover] PREFLIGHT (${phase}): ${cases.length} drifted state(s) each abort the candidate${phase === 'after' ? ' (a second apply is refused)' : ''}`);
}

// The live smoke chain must pass whether or not every active product has a floor (Codex App P2 on
// #1102), and must leave the floors exactly as it found them.
function smokeChain() {
  stageText('smoke.sql', lf(path.join(ROOT, 'scripts', 'smoke', 'smoke-set-product-margin-floors.sql')));
  const floors = () => scalar("SELECT COALESCE(string_agg(product_id || '=' || margin_floor, ',' ORDER BY product_id), 'none') FROM public.product_margin_floors;");
  const run = (label) => {
    const before = floors();
    const r = docker([...psqlArgs(), '-f', '/tmp/smoke.sql'], { allowFailure: true });
    assert.match(r.stderr, /SMOKE_PASS_ROLLBACK/, `smoke chain (${label}) did not pass:\n${r.stderr}`);
    assert.equal(floors(), before, `smoke chain (${label}) changed the floors`);
  };
  run('no floors');
  psql(`INSERT INTO public.product_margin_floors (product_id, margin_floor, set_by, set_reason)
    SELECT id, 0.2, '${U.ADMIN}', 'prover: every active product floored' FROM public.products WHERE is_active;`);
  assert.equal(scalar('SELECT count(*) FROM public.products p WHERE p.is_active AND NOT EXISTS (SELECT 1 FROM public.product_margin_floors f WHERE f.product_id = p.id);'), '0');
  run('every active product floored');
  psql("DELETE FROM public.product_margin_floors WHERE set_reason = 'prover: every active product floored';");
  console.log('[prover] SMOKE CHAIN: passes with no floors and with every active product floored, and leaves the floors as it found them');
}

function main() {
  const started = Date.now();
  if (!REUSE) buildContainer();
  assert.equal(scalar("SELECT to_regclass('public.product_margin_floors') IS NULL;"), 't', 'a reused container must be BEFORE the candidate (drop it and rebuild)');
  fidelity();
  if (scalar("SELECT count(*) FROM public.profiles WHERE id::text LIKE '7c310000-%';") === '0') seed();

  check('before', runMatrix('before'));
  preflightRefusesDrift('before');

  stageText('candidate.sql', lf(CANDIDATE));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  console.log('[prover] candidate applied');

  check('after', runMatrix('after'));
  grants();
  preflightRefusesDrift('after');

  // MUTATION: the admin gate is what refuses a rep.
  const MUTANT_GATE = 'CREATE OR REPLACE FUNCTION public.require_admin() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN END; $$;';
  const gate = scenario([{ key: 'rep, require_admin emptied', as: U.REP, call: setFloors(U.REP, [item(PROD_B, 1)], null, 'k-mut') }], MUTANT_GATE);
  assert.equal(gate['rep, require_admin emptied'], 'ok|1:0', `MUTATION: with require_admin() emptied a rep should set a floor, got ${gate['rep, require_admin emptied']}`);
  console.log('[prover] MUTATION: require_admin() emptied lets a rep set a floor -- so the refusal comes from the admin gate');

  smokeChain();

  console.log(`[prover] finished in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log('PRODUCT_MARGIN_FLOORS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
