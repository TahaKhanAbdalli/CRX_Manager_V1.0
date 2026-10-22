#!/usr/bin/env node
/**
 * Full-chain proof for the 20261021200000 candidate: Goal 3 "Post uses what was saved and reviewed"
 * (docs/plans/2026-10-13-direction-and-goals.md, done-test "Posting"; docs/manual/KNOWN_ISSUES.md
 * "OPEN 2026-10-09"). post_invoice, post_invoice_group and batch_post_invoices take the version of the
 * invoice the screen loaded (the invoice_post_version computed field) and refuse, inside the posting
 * transaction, when the saved invoice changed since then.
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate, seeds
 * two admins, a sales rep, a driver and a customer, and runs the matrix BEFORE (the bug: a save by a
 * second user just before Post is posted unseen) and AFTER the candidate. Each scenario is one
 * transaction that always rolls back; each step runs as a PostgREST session (request.jwt.claims +
 * SET LOCAL ROLE authenticated) or as the owner.
 *
 * AFTER the candidate:
 *   P1 a fresh version posts; P2 a second tab's save (same user) and P3 a second user's save between
 *   load and Post are refused, nothing posts, and a reload then posts the new amounts; P4 a change of
 *   the customer's payment terms, P5 a direct line write and P5b a share write are refused;
 *   P6 retries: the same key and version replay without a second post, the same key with another
 *   version is refused; P7 a missing version and the old signatures are refused; P8 the version is
 *   NULL for a driver, carries no cost, and the helpers are not callable by API roles;
 *   P9 rep own-name scope still holds.
 *   G1 a split group posts with every member's version; G2 a missing member, an extra id, a changed
 *   member, a sibling added after load and an empty map are refused; G3 replay binding; G4 a single
 *   post of a member still needs the group; G5 rep scope; G6 a rep posts their own group; G7 a
 *   group-level field location added after load is refused.
 *   B1 a batch posts the unchanged row and reports the changed row as that row's failure.
 *   C1 a line write made while posting (a trigger standing in for a racing writer) rolls the post back.
 * RACES (two real connections, committed data): a save_invoice by a second user held open while
 *   Post runs, a raw line update held open while Post runs, and a Post held open while a save runs.
 * MUTATIONS: without the line lock, the raw line update race posts and the line changes under a
 *   posted invoice; without the post-check, C1 posts.
 *
 * Run: node scripts/smoke/prove-post-binds-reviewed-invoice-version-real-schema.mjs   (needs Docker)
 * Prints POST_BINDS_REVIEWED_VERSION_PROOF_PASS on success. CRX_PROVER_VERBOSE=1 prints every step.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-post-version-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1' || REUSE;
const VERBOSE = process.env.CRX_PROVER_VERBOSE === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261021200000_post_binds_reviewed_invoice_version.sql');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
]);
// A later or parked file that (re)defines anything the candidate replaces or relies on.
const TOUCHED = /FUNCTION\s+(public\.)?"?(post_invoice|post_invoice_group|batch_post_invoices|_post_invoice_\w+|_post_invoice_group_\w+|invoice_post_version|_invoice_post_\w+)\b/i;
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
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text);
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  const files = plan();
  let replayed = 0;
  const ledgered = new Set();
  const ledgerOnce = (only) => {
    if (ledgered.has(only)) return;
    ledger(path.basename(only, '.sql'));
    ledgered.add(only);
  };
  for (const [i, file] of files.entries()) {
    const base = path.basename(file);
    if (PARKED.has(base)) continue;
    for (const only of LEDGER_ONLY) if (only <= base) ledgerOnce(only);
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  for (const only of LEDGER_ONLY) ledgerOnce(only);
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

// ------------------------------------------------------------------------------------------------
// Fixtures (committed once; every probe rolls back).
const id = (n) => `7d400000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), ADMIN2: id('a2'), REP: id('b1'), DRIVER: id('d1') };
const CUST = id('c1');
const TODAY = "to_char(CURRENT_DATE, 'YYYY-MM-DD')";
const j = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.ADMIN2, 'admin', 'Admin Two', 8], [U.REP, 'sales_rep', 'Rep', 7], [U.DRIVER, 'driver', 'Driver', 6]];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'post-version-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    ${claims(U.ADMIN)}
    INSERT INTO public.customers (id, farm_name, is_active, email, payment_terms) VALUES ('${CUST}', '[PROVER] Version Farm', true, 'c1@example.invalid', 'Net 30');
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7d400000-%';`), 'admin:true,admin:true,sales_rep:true,driver:true');
  console.log('[prover] seeded two admins, a sales rep, a driver and one customer');
}

// ------------------------------------------------------------------------------------------------
// Probes: one transaction per scenario, always rolled back. A step yields "ok|<value>" or
// "<sqlstate>|<message>".
function who(as) {
  if (as === 'owner') return `RESET ROLE;\n${claims(U.ADMIN)}`;
  return `RESET ROLE;\n${claims(as)}\nSET LOCAL ROLE authenticated;`;
}
function scenario(steps, fixture = '') {
  const sql = ['BEGIN;', fixture];
  for (const s of steps) {
    const body = s.stmt ? s.stmt : `v := (${s.call})::text;`;
    sql.push(who(s.as), `DO $probe$
DECLARE v text;
BEGIN
  ${body}
  RAISE NOTICE 'RESULT|${s.key}|ok|%', COALESCE(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'RESULT|${s.key}|%|%', SQLSTATE, replace(SQLERRM, chr(10), ' ');
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
  if (VERBOSE) for (const s of steps) console.log(`    ${s.key} -> ${out[s.key]}`);
  return out;
}

// --- payload builders -----------------------------------------------------------------------------
const header = (salesman, extra = {}) => ({ customer_id: CUST, invoice_type: 'misc_charge', status: 'draft', salesman_id: salesman, ...extra });
const freight = (cents) => ({ charge_type: 'freight', description: 'Freight to farm', quantity: 1, unit_price_cents: cents, extended_cents: cents, cost_cents: 0 });
const save = (salesman, cents, key) => `public.save_invoice(${j(header(salesman))} || jsonb_build_object('invoice_date', ${TODAY}), ${j([freight(cents)])}, '${key}')`;
const edit = (salesman, cents, key, inv = INV) => `public.save_invoice(${j(header(salesman))} || jsonb_build_object('id', ${inv}, 'invoice_date', ${TODAY}), ${j([freight(cents)])}, '${key}')`;
// The id of the invoice the last step created, and versions read by a step, kept in session settings.
const KEEP_ID = (call) => `v := (${call})::text; PERFORM set_config('prover.inv', v, true);`;
const INV = "current_setting('prover.inv')::uuid";
const READ_VERSION = (slot = 'v', inv = INV) => `v := (SELECT public.invoice_post_version(i) FROM public.invoices i WHERE i.id = ${inv}); PERFORM set_config('prover.${slot}', coalesce(v, ''), true);`;
const VER = (slot = 'v') => `current_setting('prover.${slot}')`;
const post = (key, slot = 'v', inv = INV) => `PERFORM public.post_invoice(${inv}, ${VER(slot)}, '${key}'); v := 'posted';`;
const STATE = (inv = INV) => `(SELECT i.status || ':' || i.total_amount_cents FROM public.invoices i WHERE i.id = ${inv})`;
const POSTS = (inv = INV) => `(SELECT count(*) FROM public.financial_audit_log f WHERE f.entity_id = ${inv} AND f.operation_type = 'invoice_posted')`;

// A split group of two misc_charge drafts (G-A and G-B) owned by a given salesperson, seeded as the
// owner with the invoice triggers off (split creation claims are not what this proof is about).
const G = id('9a0'); const GA = id('9a1'); const GB = id('9a2'); const GC = id('9a3');
const group = (salesman = U.ADMIN) => `
ALTER TABLE public.invoices DISABLE TRIGGER USER;
INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, created_by, salesman_id, invoice_group_id, total_amount_cents) VALUES
  ('${GA}', 'PROVER-G-A', '${CUST}', 'misc_charge', 'draft', CURRENT_DATE, '${salesman}', '${salesman}', '${G}', 1000),
  ('${GB}', 'PROVER-G-B', '${CUST}', 'misc_charge', 'draft', CURRENT_DATE, '${salesman}', '${salesman}', '${G}', 2000);
ALTER TABLE public.invoices ENABLE TRIGGER USER;
INSERT INTO public.invoice_items (invoice_id, charge_type, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order) VALUES
  ('${GA}', 'freight', 'Freight A', 1, 1000, 1000, 0, 0),
  ('${GB}', 'freight', 'Freight B', 1, 2000, 2000, 0, 0);`;
const READ_MAP = (slot = 'map') => `v := (SELECT jsonb_object_agg(i.id, public.invoice_post_version(i))::text FROM public.invoices i WHERE i.invoice_group_id = '${G}' AND i.deleted_at IS NULL); PERFORM set_config('prover.${slot}', v, true);`;
const MAP = (slot = 'map') => `current_setting('prover.${slot}')::jsonb`;
const postGroup = (key, as, map = MAP()) => `v := (public.post_invoice_group('${G}', '${as}', ${map}, '${key}'))::text;`;
const GSTATE = `(SELECT string_agg(i.invoice_number || ':' || i.status, ',' ORDER BY i.invoice_number) FROM public.invoices i WHERE i.invoice_group_id = '${G}')`;

function runBefore() {
  const r = {};
  // B0 (the bug): the rep loads the invoice, a second user saves a new amount, the rep's Post posts it.
  Object.assign(r, scenario([
    { key: 'B0 rep creates $25.00', as: U.REP, stmt: KEEP_ID(save(U.REP, 2500, 'b0s')) },
    { key: 'B0 second user saves $99.00', as: U.ADMIN2, call: edit(U.REP, 9900, 'b0e') },
    { key: 'B0 rep posts (old signature)', as: U.REP, stmt: `PERFORM public.post_invoice(${INV}, 'b0p'); v := 'posted';` },
    { key: 'B0 state', as: 'owner', call: STATE() },
  ]));
  const lines = [
    ['B0 rep posts (old signature)', /^ok\|posted$/],
    ['B0 state', /^ok\|posted:9900$/],
  ].map(([k, want]) => {
    const ok = want.test(r[k]);
    return { ok, line: `  ${ok ? 'PASS' : 'FAIL'} [before] ${k} -> ${r[k]}` };
  });
  console.log(`[prover] before (the bug: a second user's save is posted unseen):\n${lines.map((l) => l.line).join('\n')}`);
  assert.ok(lines.every((l) => l.ok), 'the before matrix did not show the bug');
}

const CHANGED = /^P0001\|INVOICE_CHANGED_SINCE_LOADED: /;
function runAfter() {
  const r = {};
  const add = (out) => Object.assign(r, out);

  add(scenario([
    { key: 'P1 admin creates', as: U.ADMIN, stmt: KEEP_ID(save(U.ADMIN, 2500, 'p1s')) },
    { key: 'P1 admin reads version', as: U.ADMIN, stmt: READ_VERSION() },
    { key: 'P1 version equals the owner-side hash', as: 'owner', call: `(public._invoice_post_version(${INV}) = ${VER()})` },
    { key: 'P1 admin posts', as: U.ADMIN, stmt: post('p1p') },
    { key: 'P1 state', as: 'owner', call: STATE() },
    { key: 'P1 posting changed the version', as: 'owner', call: `(public._invoice_post_version(${INV}) <> ${VER()})` },
  ]));

  add(scenario([
    { key: 'P2 admin creates', as: U.ADMIN, stmt: KEEP_ID(save(U.ADMIN, 2500, 'p2s')) },
    { key: 'P2 tab 1 reads version', as: U.ADMIN, stmt: READ_VERSION() },
    { key: 'P2 tab 2 saves $31.00', as: U.ADMIN, call: edit(U.ADMIN, 3100, 'p2e') },
    { key: 'P2 tab 1 posts', as: U.ADMIN, stmt: post('p2p') },
    { key: 'P2 state after refusal', as: 'owner', call: STATE() },
    { key: 'P2 tab 1 reloads', as: U.ADMIN, stmt: READ_VERSION('v2') },
    { key: 'P2 tab 1 posts after reload', as: U.ADMIN, stmt: post('p2p2', 'v2') },
    { key: 'P2 state', as: 'owner', call: STATE() },
  ]));

  add(scenario([
    { key: 'P3 rep creates', as: U.REP, stmt: KEEP_ID(save(U.REP, 2500, 'p3s')) },
    { key: 'P3 rep reads version', as: U.REP, stmt: READ_VERSION() },
    { key: 'P3 second user saves $99.00', as: U.ADMIN2, call: edit(U.REP, 9900, 'p3e') },
    { key: 'P3 rep posts', as: U.REP, stmt: post('p3p') },
    { key: 'P3 state after refusal', as: 'owner', call: STATE() },
    { key: 'P3 nothing was posted', as: 'owner', call: POSTS() },
    { key: 'P3 rep reloads', as: U.REP, stmt: READ_VERSION('v2') },
    { key: 'P3 rep posts after reload', as: U.REP, stmt: post('p3p2', 'v2') },
    { key: 'P3 state', as: 'owner', call: STATE() },
  ]));

  add(scenario([
    { key: 'P4 admin creates', as: U.ADMIN, stmt: KEEP_ID(save(U.ADMIN, 2500, 'p4s')) },
    { key: 'P4 admin reads version', as: U.ADMIN, stmt: READ_VERSION() },
    { key: 'P4 customer terms change', as: 'owner', stmt: `UPDATE public.customers SET payment_terms = 'Net 60' WHERE id = '${CUST}'; v := 'changed';` },
    { key: 'P4 admin posts', as: U.ADMIN, stmt: post('p4p') },
  ]));

  add(scenario([
    { key: 'P5 admin creates', as: U.ADMIN, stmt: KEEP_ID(save(U.ADMIN, 2500, 'p5s')) },
    { key: 'P5 admin reads version', as: U.ADMIN, stmt: READ_VERSION() },
    { key: 'P5 direct line write', as: 'owner', stmt: `UPDATE public.invoice_items SET description = 'Freight (edited)' WHERE invoice_id = ${INV}; v := 'changed';` },
    { key: 'P5 admin posts', as: U.ADMIN, stmt: post('p5p') },
  ]));

  add(scenario([
    { key: 'P5b admin creates', as: U.ADMIN, stmt: KEEP_ID(save(U.ADMIN, 2500, 'p5bs')) },
    { key: 'P5b admin reads version', as: U.ADMIN, stmt: READ_VERSION() },
    { key: 'P5b share added', as: 'owner', stmt: `INSERT INTO public.invoice_shares (invoice_id, customer_id, customer_name, split_percentage, amount_cents, is_primary, sort_order) VALUES (${INV}, '${CUST}', '[PROVER] Version Farm', 100, 2500, true, 0); v := 'changed';` },
    { key: 'P5b admin posts', as: U.ADMIN, stmt: post('p5bp') },
  ]));

  add(scenario([
    { key: 'P6 admin creates', as: U.ADMIN, stmt: KEEP_ID(save(U.ADMIN, 2500, 'p6s')) },
    { key: 'P6 admin reads version', as: U.ADMIN, stmt: READ_VERSION() },
    { key: 'P6 first post', as: U.ADMIN, stmt: post('p6k') },
    { key: 'P6 retry, same key and version', as: U.ADMIN, stmt: post('p6k') },
    { key: 'P6 posted once', as: 'owner', call: POSTS() },
    { key: 'P6 same key, another version', as: U.ADMIN, stmt: `PERFORM public.post_invoice(${INV}, 'v1:other', 'p6k'); v := 'posted';` },
    { key: 'P6 same key, another actor', as: U.ADMIN2, stmt: post('p6k') },
    { key: 'P6 new key after posting', as: U.ADMIN, stmt: post('p6k2') },
  ]));

  add(scenario([
    { key: 'P7 admin creates', as: U.ADMIN, stmt: KEEP_ID(save(U.ADMIN, 2500, 'p7s')) },
    { key: 'P7 blank version', as: U.ADMIN, stmt: `PERFORM public.post_invoice(${INV}, '  ', 'p7a'); v := 'posted';` },
    { key: 'P7 null version', as: U.ADMIN, stmt: `PERFORM public.post_invoice(${INV}, NULL, 'p7b'); v := 'posted';` },
    { key: 'P7 no key', as: U.ADMIN, stmt: `PERFORM public.post_invoice(${INV}, 'v1:x', NULL); v := 'posted';` },
    { key: 'P7 old post_invoice signature', as: U.ADMIN, stmt: `PERFORM public.post_invoice(p_invoice_id => ${INV}, p_idempotency_key => 'p7c'); v := 'posted';` },
    { key: 'P7 old post_invoice_group signature', as: U.ADMIN, stmt: `PERFORM public.post_invoice_group(p_invoice_group_id => '${G}'::uuid, p_performed_by => '${U.ADMIN}'::uuid, p_idempotency_key => 'p7d'); v := 'posted';` },
    { key: 'P7 old batch signature', as: U.ADMIN, stmt: `PERFORM public.batch_post_invoices(ARRAY[${INV}], 'p7e'); v := 'posted';` },
    { key: 'P7 state', as: 'owner', call: STATE() },
  ]));

  add(scenario([
    { key: 'P8 rep creates', as: U.REP, stmt: KEEP_ID(save(U.REP, 2500, 'p8s')) },
    { key: 'P8 rep reads a version', as: U.REP, call: `(SELECT public.invoice_post_version(i) ~ '^v1:[0-9a-f]{64}$' FROM public.invoices i WHERE i.id = ${INV})` },
    { key: 'P8 driver reads the version', as: U.DRIVER, call: `public.invoice_post_version((SELECT i FROM public.invoices i WHERE i.id = ${INV}))` },
    { key: 'P8 cost values are not in the version', as: 'owner', stmt: `
      PERFORM set_config('prover.c0', public._invoice_post_version(${INV}), true);
      ALTER TABLE public.invoice_items DISABLE TRIGGER USER; ALTER TABLE public.invoice_items DROP CONSTRAINT IF EXISTS invoice_items_charge_line_shape_chk;
      ALTER TABLE public.invoices DISABLE TRIGGER USER;
      UPDATE public.invoice_items SET cost_cents = 777, return_credit_cogs_cents = -5 WHERE invoice_id = ${INV};
      UPDATE public.invoices SET total_cost_cents = 777 WHERE id = ${INV};
      v := (SELECT count(*) FROM public.invoice_items WHERE invoice_id = ${INV} AND cost_cents = 777)::text || ':' ||
           ((SELECT updated_at FROM public.invoices WHERE id = ${INV}) IS NOT NULL)::text || ':' ||
           (public._invoice_post_version(${INV}) = current_setting('prover.c0'))::text;` },
    { key: 'P8 authenticated calls _invoice_post_version', as: U.ADMIN, call: `public._invoice_post_version(${INV})` },
    { key: 'P8 authenticated calls _invoice_post_content_version', as: U.ADMIN, call: `public._invoice_post_content_version(${INV})` },
  ]));

  add(scenario([
    { key: 'P9 admin creates', as: U.ADMIN, stmt: KEEP_ID(save(U.ADMIN, 2500, 'p9s')) },
    { key: 'P9 version read as the owner (the rep cannot read it)', as: 'owner', stmt: READ_VERSION() },
    { key: "P9 rep posts an admin invoice", as: U.REP, stmt: post('p9p') },
    // Called as an RPC with a made-up row, the field answers only for an invoice the caller may post.
    { key: 'P9 rep asks for an admin invoice version with a made-up row', as: U.REP, call: `public.invoice_post_version(jsonb_populate_record(NULL::public.invoices, jsonb_build_object('id', ${INV})))` },
    { key: 'P9 admin asks with a made-up row', as: U.ADMIN, call: `(public.invoice_post_version(jsonb_populate_record(NULL::public.invoices, jsonb_build_object('id', ${INV}))) ~ '^v1:')` },
  ]));
  add(scenario([
    { key: 'G8 admin reads the group', as: U.ADMIN, stmt: READ_MAP() },
    { key: 'G8 posts with upper-case invoice ids', as: U.ADMIN, stmt: postGroup('g8', U.ADMIN, `(SELECT jsonb_object_agg(upper(e.key), e.value) FROM jsonb_each(${MAP()}) e)`) },
  ], group()));

  // Groups.
  add(scenario([
    { key: 'G1 admin reads the group', as: U.ADMIN, stmt: READ_MAP() },
    { key: 'G1 admin posts the group', as: U.ADMIN, stmt: postGroup('g1', U.ADMIN) },
    { key: 'G1 state', as: 'owner', call: GSTATE },
    { key: 'G3 retry, same key and map', as: U.ADMIN, stmt: postGroup('g1', U.ADMIN) },
    { key: 'G3 posted once', as: 'owner', call: `(SELECT count(*) FROM public.financial_audit_log f WHERE f.entity_id IN ('${GA}', '${GB}') AND f.operation_type = 'invoice_posted')` },
    { key: 'G3 same key, another map', as: U.ADMIN, stmt: postGroup('g1', U.ADMIN, `${MAP()} || jsonb_build_object('${GA}', 'v1:other')`) },
  ], group()));
  add(scenario([
    { key: 'G2 admin reads the group', as: U.ADMIN, stmt: READ_MAP() },
    { key: 'G2 a member missing from the map', as: U.ADMIN, stmt: postGroup('g2a', U.ADMIN, `${MAP()} - '${GB}'`) },
    { key: 'G2 an extra id in the map', as: U.ADMIN, stmt: postGroup('g2b', U.ADMIN, `${MAP()} || jsonb_build_object('${GC}', 'v1:x')`) },
    { key: 'G2 empty map', as: U.ADMIN, stmt: postGroup('g2c', U.ADMIN, "'{}'::jsonb") },
    { key: 'G2 not an object', as: U.ADMIN, stmt: postGroup('g2d', U.ADMIN, "'[]'::jsonb") },
    { key: 'G2 member B edited after load', as: 'owner', stmt: `UPDATE public.invoice_items SET description = 'Freight B (edited)' WHERE invoice_id = '${GB}'; v := 'changed';` },
    { key: 'G2 post after member edit', as: U.ADMIN, stmt: postGroup('g2e', U.ADMIN) },
    { key: 'G2 state', as: 'owner', call: GSTATE },
    { key: 'G4 single post of a member', as: U.ADMIN, stmt: `v := (SELECT public.invoice_post_version(i) FROM public.invoices i WHERE i.id = '${GA}'); PERFORM public.post_invoice('${GA}', v, 'g4'); v := 'posted';` },
  ], group()));
  add(scenario([
    { key: 'G2s admin reads the group', as: U.ADMIN, stmt: READ_MAP() },
    { key: 'G2s sibling added after load', as: 'owner', stmt: `
      ALTER TABLE public.invoices DISABLE TRIGGER USER;
      INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, created_by, salesman_id, invoice_group_id, total_amount_cents)
        VALUES ('${GC}', 'PROVER-G-C', '${CUST}', 'misc_charge', 'draft', CURRENT_DATE, '${U.ADMIN}', '${U.ADMIN}', '${G}', 0);
      ALTER TABLE public.invoices ENABLE TRIGGER USER; v := 'added';` },
    { key: 'G2s post after sibling added', as: U.ADMIN, stmt: postGroup('g2s', U.ADMIN) },
    { key: 'G2s state', as: 'owner', call: GSTATE },
  ], group()));
  // A split field invoice's locations are keyed by the group (invoice_id NULL); they are part of
  // every member's version.
  add(scenario([
    { key: 'G7 admin reads the group', as: U.ADMIN, stmt: READ_MAP() },
    { key: 'G7 group-level location added', as: 'owner', stmt: `
      INSERT INTO public.fields (id, customer_id, field_name, total_acres) VALUES ('${id('9f1')}', '${CUST}', '[PROVER] Field', 100);
      INSERT INTO public.field_app_locations (invoice_id, invoice_group_id, field_id, applied_acres, sort_order) VALUES (NULL, '${G}', '${id('9f1')}', 40, 0);
      v := 'added';` },
    { key: 'G7 post after location added', as: U.ADMIN, stmt: postGroup('g7', U.ADMIN) },
  ], group()));
  add(scenario([
    { key: 'G5 group read as the owner (the rep cannot read it)', as: 'owner', stmt: READ_MAP() },
    { key: "G5 rep posts an admin group", as: U.REP, stmt: postGroup('g5', U.REP) },
    { key: 'G5 performed_by is not the caller', as: U.ADMIN, stmt: postGroup('g5b', U.ADMIN2) },
  ], group()));
  add(scenario([
    { key: 'G6 rep reads own group', as: U.REP, stmt: READ_MAP() },
    { key: 'G6 rep posts own group', as: U.REP, stmt: postGroup('g6', U.REP) },
    { key: 'G6 state', as: 'owner', call: GSTATE },
  ], group(U.REP)));

  // Batch.
  add(scenario([
    { key: 'B1 admin creates X', as: U.ADMIN, stmt: `v := (${save(U.ADMIN, 1100, 'b1x')})::text; PERFORM set_config('prover.x', v, true);` },
    { key: 'B1 admin creates Y', as: U.ADMIN, stmt: `v := (${save(U.ADMIN, 2200, 'b1y')})::text; PERFORM set_config('prover.y', v, true);` },
    { key: 'B1 admin reads both', as: U.ADMIN, stmt: `
      PERFORM set_config('prover.vx', (SELECT public.invoice_post_version(i) FROM public.invoices i WHERE i.id = current_setting('prover.x')::uuid), true);
      PERFORM set_config('prover.vy', (SELECT public.invoice_post_version(i) FROM public.invoices i WHERE i.id = current_setting('prover.y')::uuid), true);
      v := 'read';` },
    { key: 'B1 second user saves Y', as: U.ADMIN2, call: edit(U.ADMIN, 2300, 'b1e', "current_setting('prover.y')::uuid") },
    { key: 'B1 batch', as: U.ADMIN, call: `public.batch_post_invoices(jsonb_build_array(
        jsonb_build_object('invoice_id', current_setting('prover.x'), 'expected_version', current_setting('prover.vx')),
        jsonb_build_object('invoice_id', current_setting('prover.y'), 'expected_version', current_setting('prover.vy'))), 'b1')` },
    { key: 'B1 states', as: 'owner', call: `${STATE("current_setting('prover.x')::uuid")} || ',' || ${STATE("current_setting('prover.y')::uuid")}` },
    { key: 'B1 batch without versions', as: U.ADMIN, call: `public.batch_post_invoices(jsonb_build_array(jsonb_build_object('expected_version', 'v1:x')), 'b1b')` },
    { key: 'B1 batch same invoice twice', as: U.ADMIN, call: `public.batch_post_invoices(jsonb_build_array(
        jsonb_build_object('invoice_id', current_setting('prover.y'), 'expected_version', 'v1:x'),
        jsonb_build_object('invoice_id', upper(current_setting('prover.y')), 'expected_version', 'v1:x')), 'b1c')` },
  ]));

  // C1: a line write that happens while posting (a trigger stands in for a racing writer).
  const racingLine = `
    CREATE FUNCTION pg_temp.prover_racing_line() RETURNS trigger LANGUAGE plpgsql AS $t$
    BEGIN UPDATE public.invoice_items SET description = description || ' (raced)' WHERE invoice_id = NEW.id; RETURN NEW; END $t$;
    CREATE TRIGGER zz_prover_racing_line AFTER UPDATE OF status ON public.invoices
      FOR EACH ROW WHEN (NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted') EXECUTE FUNCTION pg_temp.prover_racing_line();`;
  add(scenario([
    { key: 'C1 admin creates', as: U.ADMIN, stmt: KEEP_ID(save(U.ADMIN, 2500, 'c1s')) },
    { key: 'C1 admin reads version', as: U.ADMIN, stmt: READ_VERSION() },
    { key: 'C1 admin posts while a line changes', as: U.ADMIN, stmt: post('c1p') },
    { key: 'C1 state', as: 'owner', call: STATE() },
  ], racingLine));
  add(scenario([
    { key: 'C1g admin reads the group', as: U.ADMIN, stmt: READ_MAP() },
    { key: 'C1g admin posts while a line changes', as: U.ADMIN, stmt: postGroup('c1g', U.ADMIN) },
    { key: 'C1g state', as: 'owner', call: GSTATE },
  ], `${group()}\n${racingLine}`));
  return r;
}

const AFTER = [
  ['P1 admin reads version', /^ok\|v1:[0-9a-f]{64}$/],
  ['P1 version equals the owner-side hash', /^ok\|true$/],
  ['P1 admin posts', /^ok\|posted$/],
  ['P1 state', /^ok\|posted:2500$/],
  ['P1 posting changed the version', /^ok\|true$/],
  ['P2 tab 2 saves $31.00', /^ok\|/],
  ['P2 tab 1 posts', CHANGED],
  ['P2 state after refusal', /^ok\|draft:3100$/],
  ['P2 tab 1 posts after reload', /^ok\|posted$/],
  ['P2 state', /^ok\|posted:3100$/],
  ['P3 second user saves $99.00', /^ok\|/],
  ['P3 rep posts', CHANGED],
  ['P3 state after refusal', /^ok\|draft:9900$/],
  ['P3 nothing was posted', /^ok\|0$/],
  ['P3 rep posts after reload', /^ok\|posted$/],
  ['P3 state', /^ok\|posted:9900$/],
  ['P4 admin posts', CHANGED],
  ['P5 admin posts', CHANGED],
  ['P5b share added', /^ok\|changed$/],
  ['P5b admin posts', CHANGED],
  ['P6 first post', /^ok\|posted$/],
  ['P6 retry, same key and version', /^ok\|posted$/],
  ['P6 posted once', /^ok\|1$/],
  ['P6 same key, another version', /^P0001\|IDEMPOTENCY_ARGUMENT_MISMATCH: /],
  ['P6 same key, another actor', /^P0001\|IDEMPOTENCY_ARGUMENT_MISMATCH: /],
  ['P6 new key after posting', CHANGED],
  ['P7 blank version', /^22023\|INVOICE_VERSION_REQUIRED: /],
  ['P7 null version', /^22023\|INVOICE_VERSION_REQUIRED: /],
  ['P7 no key', /^22023\|IDEMPOTENCY_KEY_REQUIRED: /],
  ['P7 old post_invoice signature', /^42883\|/],
  ['P7 old post_invoice_group signature', /^42883\|/],
  ['P7 old batch signature', /^42883\|/],
  ['P7 state', /^ok\|draft:2500$/],
  ['P8 rep reads a version', /^ok\|true$/],
  ['P8 driver reads the version', /^ok\|<null>$/],
  ['P8 cost values are not in the version', /^ok\|1:true:true$/],
  ['P8 authenticated calls _invoice_post_version', /^42501\|/],
  ['P8 authenticated calls _invoice_post_content_version', /^42501\|/],
  ["P9 rep posts an admin invoice", /^P0001\|INVOICE_SCOPE_DENIED/],
  ['P9 rep asks for an admin invoice version with a made-up row', /^ok\|<null>$/],
  ['P9 admin asks with a made-up row', /^ok\|true$/],
  ['G8 posts with upper-case invoice ids', /^ok\|\{.*"member_count": 2/],
  ['G1 admin reads the group', /^ok\|\{.*v1:/],
  ['G1 admin posts the group', /^ok\|\{.*"member_count": 2/],
  ['G1 state', /^ok\|PROVER-G-A:posted,PROVER-G-B:posted$/],
  ['G3 retry, same key and map', /^ok\|\{.*"member_count": 2/],
  ['G3 posted once', /^ok\|2$/],
  ['G3 same key, another map', /^P0001\|IDEMPOTENCY_ARGUMENT_MISMATCH: /],
  ['G2 a member missing from the map', CHANGED],
  ['G2 an extra id in the map', CHANGED],
  ['G2 empty map', /^22023\|INVOICE_VERSION_REQUIRED: /],
  ['G2 not an object', /^22023\|INVOICE_VERSION_REQUIRED: /],
  ['G2 post after member edit', /^P0001\|INVOICE_CHANGED_SINCE_LOADED: invoice PROVER-G-B /],
  ['G2 state', /^ok\|PROVER-G-A:draft,PROVER-G-B:draft$/],
  ['G4 single post of a member', /^P0001\|GROUP_POST_REQUIRED/],
  ['G2s post after sibling added', CHANGED],
  ['G2s state', /^ok\|PROVER-G-A:draft,PROVER-G-B:draft,PROVER-G-C:draft$/],
  ['G7 group-level location added', /^ok\|added$/],
  ['G7 post after location added', /^P0001\|INVOICE_CHANGED_SINCE_LOADED: invoice PROVER-G-A /],
  ["G5 rep posts an admin group", /^P0001\|INVOICE_SCOPE_DENIED/],
  ['G5 performed_by is not the caller', /^P0001\|ACTOR_MISMATCH/],
  ['G6 rep posts own group', /^ok\|\{.*"member_count": 2/],
  ['G6 state', /^ok\|PROVER-G-A:posted,PROVER-G-B:posted$/],
  ['B1 batch', /^ok\|\{.*"count": 1.*"failed": \[\{.*INVOICE_CHANGED_SINCE_LOADED/],
  ['B1 states', /^ok\|posted:1100,draft:2300$/],
  ['B1 batch without versions', /^22023\|INVOICE_VERSION_REQUIRED: /],
  ['B1 batch same invoice twice', /^22023\|INVOICE_VERSION_REQUIRED: batch_post_invoices was sent the same invoice twice/],
  // trg_refuse_posted_invoice_child_write refuses the write first; the post-check is the second
  // line of defense (MUTATION 2 proves it on its own).
  ['C1 admin posts while a line changes', /^23514\|INVOICE_POSTED_LOCKED: this invoice was posted/],
  ['C1 state', /^ok\|draft:2500$/],
  ['C1g admin posts while a line changes', /^23514\|INVOICE_POSTED_LOCKED: this invoice was posted/],
  ['C1g state', /^ok\|PROVER-G-A:draft,PROVER-G-B:draft$/],
];

function check(got) {
  const lines = [];
  let failed = 0;
  for (const [key, want] of AFTER) {
    const ok = want.test(got[key] ?? '<missing>');
    if (!ok) failed += 1;
    lines.push(`  ${ok ? 'PASS' : 'FAIL'} ${key} -> ${got[key]}`);
  }
  console.log(`[prover] after:\n${lines.join('\n')}`);
  assert.equal(failed, 0, `${failed} after check(s) failed`);
}

// One psql session running in the background (a second database connection).
function psqlAsync(sql) {
  return new Promise((resolve) => {
    const child = spawn('docker', [...psqlArgs(), '-A', '-t'], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (status) => resolve({ status, out }));
    child.stdin.end(sql);
  });
}
// Wait until the first connection is inside its pg_sleep, so it already holds its locks.
async function holdingSleep() {
  for (let i = 0; i < 100; i += 1) {
    if (scalar("SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state = 'active' AND query LIKE '%pg_sleep(4)%';") !== '0') return;
    await new Promise((r) => { setTimeout(r, 100); });
  }
  throw new Error('the first race connection never reached its pg_sleep');
}

const POST_INVOICE_SQL = (() => {
  const text = lf(CANDIDATE);
  const start = text.indexOf('CREATE FUNCTION public.post_invoice(\n');
  const end = text.indexOf('$fn$;', start) + '$fn$;'.length;
  assert.ok(start > 0 && end > start, 'could not find post_invoice in the candidate');
  return text.slice(start, end).replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
})();

// RACES (two real connections, committed data).
async function races() {
  const as = (uid) => `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', false);`;
  const created = () => scalar(`${as(U.REP)} SELECT public.save_invoice(${j(header(U.REP))} || jsonb_build_object('invoice_date', ${TODAY}), ${j([freight(2500)])}, 'race-${Math.random().toString(36).slice(2)}');`);
  const version = (inv) => scalar(`SELECT public._invoice_post_version('${inv}');`);
  const state = (inv) => scalar(`SELECT status || ':' || total_amount_cents || ':' || (SELECT string_agg(description, ',') FROM public.invoice_items WHERE invoice_id = '${inv}') FROM public.invoices WHERE id = '${inv}';`);
  // Keys carry the invoice id, so a re-run on a kept container never replays an earlier run.
  const postSql = (inv, ver, key) => `${as(U.REP)} SELECT public.post_invoice('${inv}', '${ver}', '${key}-${inv}');`;
  const editSql = (inv, cents, key) => `${as(U.ADMIN2)} SELECT public.save_invoice(${j(header(U.REP))} || jsonb_build_object('id', '${inv}', 'invoice_date', ${TODAY}), ${j([freight(cents)])}, '${key}-${inv}');`;

  // R1: a second user's save is in flight when the rep presses Post. Post waits for it, then refuses.
  let inv = created(); let ver = version(inv);
  let first = psqlAsync(`BEGIN; ${editSql(inv, 9900, 'r1e')} SELECT pg_sleep(4); COMMIT;`);
  await holdingSleep();
  let second = await psqlAsync(postSql(inv, ver, 'r1p'));
  let firstDone = await first;
  assert.equal(firstDone.status, 0, `race 1 save failed:\n${firstDone.out}`);
  assert.match(second.out, /INVOICE_CHANGED_SINCE_LOADED/, `race 1 post was not refused:\n${second.out}`);
  assert.equal(state(inv), 'draft:9900:Freight to farm');
  console.log('[prover] RACE 1: a second user\'s save held open while Post runs: Post waits, then refuses; nothing posted');

  // R2: a raw line update is in flight when Post runs. Post waits on the line lock, then refuses.
  inv = created(); ver = version(inv);
  first = psqlAsync(`BEGIN; UPDATE public.invoice_items SET description = 'Freight (raced)' WHERE invoice_id = '${inv}'; SELECT pg_sleep(4); COMMIT;`);
  await holdingSleep();
  second = await psqlAsync(postSql(inv, ver, 'r2p'));
  firstDone = await first;
  assert.equal(firstDone.status, 0, `race 2 line update failed:\n${firstDone.out}`);
  assert.match(second.out, /INVOICE_CHANGED_SINCE_LOADED/, `race 2 post was not refused:\n${second.out}`);
  assert.equal(state(inv), 'draft:2500:Freight (raced)');
  console.log('[prover] RACE 2: a direct line update held open while Post runs: Post waits on the line lock, then refuses');

  // R3: Post is in flight when a second user saves. The save waits for the post, then changes
  // nothing (save_invoice leaves a posted invoice's amounts alone; today it still returns the id,
  // which is existing behavior), and what posted is what was reviewed.
  inv = created(); ver = version(inv);
  first = psqlAsync(`BEGIN; ${postSql(inv, ver, 'r3p')} SELECT pg_sleep(4); COMMIT;`);
  await holdingSleep();
  second = await psqlAsync(editSql(inv, 9900, 'r3e'));
  firstDone = await first;
  assert.equal(firstDone.status, 0, `race 3 post failed:\n${firstDone.out}`);
  assert.equal(state(inv), 'posted:2500:Freight to farm', `race 3: the save after the post changed the posted invoice:\n${second.out}`);
  console.log(`[prover] RACE 3: Post held open while a second user saves: the save waits and changes nothing (save ${second.status === 0 ? 'returned ok' : 'was refused'}); $25.00 posted as reviewed`);

  // COST: a cost-only edit made in its own transaction (as a real edit is) bumps updated_at through
  // the real trigger, so it still changes the version and a pending Post is refused; only the cost
  // VALUE is left out of the hash. (updated_at is now(), the transaction start, so this must be a
  // separate transaction from the one that created the invoice.)
  inv = created(); ver = version(inv);
  psql(`BEGIN; SET LOCAL app.admin_override = 'true'; UPDATE public.invoices SET total_cost_cents = 778 WHERE id = '${inv}'; COMMIT;`);
  assert.notEqual(version(inv), ver, 'a committed cost-only edit did not change the version');
  second = await psqlAsync(postSql(inv, ver, 'rcost'));
  assert.match(second.out, /INVOICE_CHANGED_SINCE_LOADED/, `a post after a cost-only edit was not refused:\n${second.out}`);
  console.log('[prover] COST: a committed cost-only edit changes the version through the real updated_at trigger, so a pending Post is refused');

  // R4: a group post is in flight when a direct write adds a group-keyed field location (invoice_id
  // NULL, so no row lock can stop it). trg_serialize_invoice_group_writes makes it wait for the
  // post's group lock, so it cannot land between the post's last check and its commit.
  // MUTATION 3: without that trigger the write does not wait.
  const sfx = Math.random().toString(16).slice(2, 6).padEnd(4, '0');
  const gid = (n) => `7d4f${sfx}-0000-4000-8000-${n.padStart(12, '0')}`;
  const seedGroup = (g) => psql(`BEGIN;
    ALTER TABLE public.invoices DISABLE TRIGGER USER;
    INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, created_by, salesman_id, invoice_group_id, total_amount_cents) VALUES
      ('${gid(g + '1')}', 'PROVER-RG-${sfx}-${g}1', '${CUST}', 'misc_charge', 'draft', CURRENT_DATE, '${U.ADMIN}', '${U.ADMIN}', '${gid(g)}', 1000),
      ('${gid(g + '2')}', 'PROVER-RG-${sfx}-${g}2', '${CUST}', 'misc_charge', 'draft', CURRENT_DATE, '${U.ADMIN}', '${U.ADMIN}', '${gid(g)}', 2000);
    ALTER TABLE public.invoices ENABLE TRIGGER USER;
    INSERT INTO public.invoice_items (invoice_id, charge_type, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order) VALUES
      ('${gid(g + '1')}', 'freight', 'Freight A', 1, 1000, 1000, 0, 0), ('${gid(g + '2')}', 'freight', 'Freight B', 1, 2000, 2000, 0, 0);
    COMMIT;`);
  psql(`INSERT INTO public.fields (id, customer_id, field_name, total_acres) VALUES ('${gid('f')}', '${CUST}', '[PROVER] Race Field', 100);`);
  const groupRace = async (g) => {
    seedGroup(g);
    const map = scalar(`SELECT jsonb_object_agg(id, public._invoice_post_version(id)) FROM public.invoices WHERE invoice_group_id = '${gid(g)}';`);
    const post = psqlAsync(`${as(U.ADMIN)} BEGIN; SELECT public.post_invoice_group('${gid(g)}', '${U.ADMIN}', '${map}'::jsonb, 'r4-${sfx}-${g}'); SELECT pg_sleep(4); COMMIT;`);
    await holdingSleep();
    const started = Date.now();
    const write = await psqlAsync(`INSERT INTO public.field_app_locations (invoice_id, invoice_group_id, field_id, applied_acres, sort_order) VALUES (NULL, '${gid(g)}', '${gid('f')}', 40, 0);`);
    const waited = Date.now() - started;
    const postDone = await post;
    assert.equal(postDone.status, 0, `race 4 group post failed:\n${postDone.out}`);
    return { waited, write };
  };
  const r4 = await groupRace('a');
  assert.ok(r4.waited >= 2000, `race 4: the group-keyed location write did not wait for the group post (${r4.waited} ms)`);
  // Once the post commits the group is posted, so the write that waited is refused.
  assert.match(r4.write.out, /INVOICE_POSTED_LOCKED/, `race 4: the waiting location write landed on the posted group:\n${r4.write.out}`);
  assert.equal(scalar(`SELECT count(*) FROM public.field_app_locations WHERE invoice_group_id = '${gid('a')}';`), '0');
  console.log(`[prover] RACE 4: a direct group-keyed location write during a group post waits for it (${r4.waited} ms), then is refused because the group is now posted (INVOICE_POSTED_LOCKED)`);
  psql('DROP TRIGGER trg_serialize_invoice_group_writes ON public.field_app_locations;');
  try {
    const unguarded = await groupRace('b');
    assert.ok(unguarded.waited < 1500, `MUTATION 3: without the trigger the write should not wait (${unguarded.waited} ms)`);
    assert.doesNotMatch(unguarded.write.out, /ERROR/, `MUTATION 3: without the trigger the write should land:\n${unguarded.write.out}`);
    console.log(`[prover] MUTATION 3: without trg_serialize_invoice_group_writes the same write does not wait (${unguarded.waited} ms) and lands in the group mid-post, so the trigger is what serializes it`);
  } finally {
    psql(`CREATE TRIGGER trg_serialize_invoice_group_writes BEFORE INSERT OR UPDATE OR DELETE ON public.field_app_locations
      FOR EACH ROW EXECUTE FUNCTION public._serialize_invoice_group_writes();`);
  }

  // R5: an UPDATE of a group member or a DELETE of a group location already holds that row's lock
  // when the trigger runs, while a group post holds the group lock and waits for the row. The
  // trigger refuses such a write at once (INVOICE_GROUP_BUSY), so the post goes ahead instead of
  // the two deadlocking. MUTATION 4: a trigger that waits instead deadlocks.
  const posted = (g) => scalar(`SELECT string_agg(status, ',' ORDER BY id) FROM public.invoices WHERE invoice_group_id = '${gid(g)}';`);
  const heldWriteRace = async (g, lockSql, writeSql) => {
    const map = scalar(`SELECT jsonb_object_agg(id, public._invoice_post_version(id)) FROM public.invoices WHERE invoice_group_id = '${gid(g)}';`);
    const write = psqlAsync(`BEGIN; ${lockSql} SELECT pg_sleep(4); ${writeSql} COMMIT;`);
    await holdingSleep();
    const post = await psqlAsync(`${as(U.ADMIN)} SELECT public.post_invoice_group('${gid(g)}', '${U.ADMIN}', '${map}'::jsonb, 'r5-${sfx}-${g}');`);
    return { write: await write, post };
  };
  const memberUpdate = (g) => [
    `SELECT 1 FROM public.invoices WHERE id = '${gid(g + '1')}' FOR UPDATE;`,
    `UPDATE public.invoices SET deleted_at = NULL WHERE id = '${gid(g + '1')}';`];
  seedGroup('c');
  let r5 = await heldWriteRace('c', ...memberUpdate('c'));
  assert.match(r5.write.out, /INVOICE_GROUP_BUSY/, `race 5 member update was not refused:\n${r5.write.out}`);
  assert.doesNotMatch(r5.post.out, /ERROR/, `race 5 group post failed:\n${r5.post.out}`);
  assert.equal(posted('c'), 'posted,posted');
  seedGroup('d');
  const loc = scalar(`INSERT INTO public.field_app_locations (invoice_id, invoice_group_id, field_id, applied_acres, sort_order) VALUES (NULL, '${gid('d')}', '${gid('f')}', 40, 0) RETURNING id;`);
  r5 = await heldWriteRace('d', `SELECT 1 FROM public.field_app_locations WHERE id = '${loc}' FOR UPDATE;`,
    `DELETE FROM public.field_app_locations WHERE id = '${loc}';`);
  assert.match(r5.write.out, /INVOICE_GROUP_BUSY/, `race 5 location delete was not refused:\n${r5.write.out}`);
  assert.doesNotMatch(r5.post.out, /ERROR/, `race 5 group post (location) failed:\n${r5.post.out}`);
  assert.equal(posted('d'), 'posted,posted');
  assert.equal(scalar(`SELECT count(*) FROM public.field_app_locations WHERE id = '${loc}';`), '1');
  console.log('[prover] RACE 5: a member update or a group-location delete that already holds its row when a group post starts is refused at once (INVOICE_GROUP_BUSY); the post goes ahead, no deadlock');
  const SERIALIZE_SQL = (() => {
    const text = lf(CANDIDATE);
    const start = text.indexOf('CREATE FUNCTION public._serialize_invoice_group_writes()');
    const end = text.indexOf('$fn$;', start) + '$fn$;'.length;
    assert.ok(start > 0 && end > start, 'could not find _serialize_invoice_group_writes in the candidate');
    return text.slice(start, end).replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
  })();
  try {
    const waiting = SERIALIZE_SQL.replace(/IF TG_OP = 'INSERT' THEN[\s\S]*?END IF;/, 'PERFORM pg_advisory_xact_lock(hashtextextended(v_group::text, 0));');
    assert.notEqual(waiting, SERIALIZE_SQL, 'MUTATION 4 did not change the trigger');
    psql(waiting);
    seedGroup('e');
    r5 = await heldWriteRace('e', ...memberUpdate('e'));
    assert.match(r5.write.out + r5.post.out, /deadlock detected/, `MUTATION 4: a waiting trigger should deadlock:\n${r5.write.out}\n${r5.post.out}`);
    console.log('[prover] MUTATION 4: with a trigger that waits instead, the same race deadlocks, so the fail-fast refusal is what prevents it');
  } finally {
    psql(SERIALIZE_SQL);
  }

  // R6: a direct write to a line or a billing share that starts while Post holds its locks waits
  // for the post, then is refused because the invoice is now posted (INVOICE_POSTED_LOCKED), so
  // nothing changes under a posted invoice. A cost-only line update stays allowed.
  // MUTATION 5: without trg_refuse_posted_invoice_child_write the waiting line update lands.
  const heldPostRace = async (inv, key, writeSql) => {
    const ver = version(inv);
    const post = psqlAsync(`BEGIN; ${postSql(inv, ver, key)} SELECT pg_sleep(4); COMMIT;`);
    await holdingSleep();
    const write = await psqlAsync(writeSql);
    const postDone = await post;
    assert.equal(postDone.status, 0, `${key}: the post failed:\n${postDone.out}`);
    return write;
  };
  inv = created();
  let w = await heldPostRace(inv, 'r6u', `UPDATE public.invoice_items SET description = 'Freight (after post)' WHERE invoice_id = '${inv}';`);
  assert.match(w.out, /INVOICE_POSTED_LOCKED/, `race 6 line update was not refused:\n${w.out}`);
  assert.equal(state(inv), 'posted:2500:Freight to farm');
  inv = created();
  w = await heldPostRace(inv, 'r6i', `INSERT INTO public.invoice_items (invoice_id, charge_type, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order) VALUES ('${inv}', 'freight', 'Extra freight', 1, 700, 700, 0, 9);`);
  assert.match(w.out, /INVOICE_POSTED_LOCKED/, `race 6 line insert was not refused:\n${w.out}`);
  assert.equal(state(inv), 'posted:2500:Freight to farm');
  inv = created();
  w = await heldPostRace(inv, 'r6s', `INSERT INTO public.invoice_shares (invoice_id, customer_id, customer_name, split_percentage, amount_cents) VALUES ('${inv}', '${CUST}', 'Prover', 100, 2500);`);
  assert.match(w.out, /INVOICE_POSTED_LOCKED/, `race 6 share insert was not refused:\n${w.out}`);
  assert.equal(scalar(`SELECT count(*) FROM public.invoice_shares WHERE invoice_id = '${inv}';`), '0');
  // A share MOVED onto an invoice that is being posted (the post never held it) is refused at once.
  const other = created();
  const movedShare = scalar(`INSERT INTO public.invoice_shares (invoice_id, customer_id, customer_name, split_percentage, amount_cents) VALUES ('${other}', '${CUST}', 'Prover', 100, 2500) RETURNING id;`);
  const target = created();
  const startedMove = Date.now();
  w = await heldPostRace(target, 'r6v', `UPDATE public.invoice_shares SET invoice_id = '${target}' WHERE id = '${movedShare}';`);
  assert.match(w.out, /INVOICE_GROUP_BUSY/, `race 6 share move onto a posting invoice was not refused:\n${w.out}`);
  assert.ok(Date.now() - startedMove < 6000 + 2000, 'race 6 share move should not wait for the post');
  assert.equal(scalar(`SELECT invoice_id FROM public.invoice_shares WHERE id = '${movedShare}';`), other);
  // A charge line must keep cost 0 (invoice_items_charge_line_shape_chk), so the allowed-column
  // path is shown with tote_number, which is on the same allowed list as the cost columns.
  psql(`UPDATE public.invoice_items SET tote_number = 'T-77' WHERE invoice_id = '${inv}';`);
  assert.equal(scalar(`SELECT tote_number FROM public.invoice_items WHERE invoice_id = '${inv}';`), 'T-77', 'an allowed-column update on a posted invoice was refused');
  console.log('[prover] RACE 6: a direct line update, line insert or billing-share insert started while Post holds its locks waits, then is refused (INVOICE_POSTED_LOCKED); a share moved onto the posting invoice is refused at once (INVOICE_GROUP_BUSY); an allowed-column (tote number) update on the posted invoice still works');
  psql('DROP TRIGGER trg_refuse_posted_invoice_child_write ON public.invoice_items;');
  try {
    inv = created();
    w = await heldPostRace(inv, 'r6m', `UPDATE public.invoice_items SET description = 'Freight (after post)' WHERE invoice_id = '${inv}';`);
    assert.doesNotMatch(w.out, /ERROR/, `MUTATION 5: without the trigger the waiting update should land:\n${w.out}`);
    assert.equal(state(inv), 'posted:2500:Freight (after post)');
    console.log('[prover] MUTATION 5: without trg_refuse_posted_invoice_child_write the waiting line update lands on the posted invoice, so the trigger is what refuses it');
  } finally {
    psql(`CREATE TRIGGER trg_refuse_posted_invoice_child_write BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_items
      FOR EACH ROW EXECUTE FUNCTION public._refuse_posted_invoice_child_write();`);
  }

  // R7: a draft inserted into a split group while the group post holds the group lock waits, then
  // is refused because the group is now posted, so no unreviewed member joins a posted group.
  seedGroup('7');
  const r7map = scalar(`SELECT jsonb_object_agg(id, public._invoice_post_version(id)) FROM public.invoices WHERE invoice_group_id = '${gid('7')}';`);
  const r7post = psqlAsync(`${as(U.ADMIN)} BEGIN; SELECT public.post_invoice_group('${gid('7')}', '${U.ADMIN}', '${r7map}'::jsonb, 'r7-${sfx}'); SELECT pg_sleep(4); COMMIT;`);
  await holdingSleep();
  const r7write = await psqlAsync(`INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, created_by, salesman_id, invoice_group_id, total_amount_cents) VALUES
      ('${gid('73')}', 'PROVER-RG-${sfx}-73', '${CUST}', 'misc_charge', 'draft', CURRENT_DATE, '${U.ADMIN}', '${U.ADMIN}', '${gid('7')}', 500);`);
  const r7done = await r7post;
  assert.equal(r7done.status, 0, `race 7 group post failed:\n${r7done.out}`);
  assert.match(r7write.out, /INVOICE_POSTED_LOCKED/, `race 7: a draft joined the posted group:\n${r7write.out}`);
  assert.equal(posted('7'), 'posted,posted');
  console.log('[prover] RACE 7: a draft inserted into a split group during its post waits, then is refused because the group is now posted (INVOICE_POSTED_LOCKED)');

  // MUTATION 1: without the line lock, race 2 posts and the line changes under a posted invoice.
  try {
    psql(POST_INVOICE_SQL.replace(/\n\s*PERFORM 1 FROM public\.invoice_items WHERE invoice_id = p_invoice_id ORDER BY id FOR UPDATE;/, ''));
    assert.ok(!scalar("SELECT prosrc FROM pg_proc WHERE oid = 'public.post_invoice(uuid,text,text)'::regprocedure;").includes('FROM public.invoice_items WHERE invoice_id = p_invoice_id ORDER BY id FOR UPDATE'), 'mutation 1 did not remove the line lock');
    inv = created(); ver = version(inv);
    first = psqlAsync(`BEGIN; UPDATE public.invoice_items SET description = 'Freight (raced)' WHERE invoice_id = '${inv}'; SELECT pg_sleep(4); COMMIT;`);
    await holdingSleep();
    second = await psqlAsync(postSql(inv, ver, 'm1p'));
    firstDone = await first;
    assert.equal(firstDone.status, 0);
    assert.doesNotMatch(second.out, /INVOICE_CHANGED_SINCE_LOADED/, `MUTATION 1: without the line lock the post should slip through:\n${second.out}`);
    assert.equal(state(inv), 'posted:2500:Freight (raced)');
    console.log('[prover] MUTATION 1: without the line lock the same race posts and the line changes under the posted invoice, so the lock is what closes it');

    // MUTATION 2: trg_refuse_posted_invoice_child_write now refuses C1's write first, so it is
    // dropped here. With the post-check alone C1 is still refused; without it as well, C1 posts.
    psql('DROP TRIGGER trg_refuse_posted_invoice_child_write ON public.invoice_items;');
    const m2a = scenario([
      { key: 'M2a admin creates', as: U.ADMIN, stmt: KEEP_ID(save(U.ADMIN, 2500, 'm2as')) },
      { key: 'M2a admin reads version', as: U.ADMIN, stmt: READ_VERSION() },
      { key: 'M2a admin posts while a line changes', as: U.ADMIN, stmt: post('m2ap') },
    ], `CREATE FUNCTION pg_temp.prover_racing_line() RETURNS trigger LANGUAGE plpgsql AS $t$
    BEGIN UPDATE public.invoice_items SET description = description || ' (raced)' WHERE invoice_id = NEW.id; RETURN NEW; END $t$;
    CREATE TRIGGER zz_prover_racing_line AFTER UPDATE OF status ON public.invoices
      FOR EACH ROW WHEN (NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted') EXECUTE FUNCTION pg_temp.prover_racing_line();`);
    assert.match(m2a['M2a admin posts while a line changes'], /^P0001\|INVOICE_CHANGED_SINCE_LOADED: invoice .* was changed while it was being posted/, `the post-check alone did not refuse C1: ${m2a['M2a admin posts while a line changes']}`);
    psql(POST_INVOICE_SQL.replace(/\n\s*-- A line write that does not lock[\s\S]*?END IF;\n/, '\n'));
    const m2 = scenario([
      { key: 'M2 admin creates', as: U.ADMIN, stmt: KEEP_ID(save(U.ADMIN, 2500, 'm2s')) },
      { key: 'M2 admin reads version', as: U.ADMIN, stmt: READ_VERSION() },
      { key: 'M2 admin posts while a line changes', as: U.ADMIN, stmt: post('m2p') },
    ], `CREATE FUNCTION pg_temp.prover_racing_line() RETURNS trigger LANGUAGE plpgsql AS $t$
    BEGIN UPDATE public.invoice_items SET description = description || ' (raced)' WHERE invoice_id = NEW.id; RETURN NEW; END $t$;
    CREATE TRIGGER zz_prover_racing_line AFTER UPDATE OF status ON public.invoices
      FOR EACH ROW WHEN (NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted') EXECUTE FUNCTION pg_temp.prover_racing_line();`);
    assert.equal(m2['M2 admin posts while a line changes'], 'ok|posted', 'MUTATION 2: without the post-check the post should go through');
    console.log('[prover] MUTATION 2: without the post-check a line written while posting is posted, so the post-check is what refuses it');
  } finally {
    psql(POST_INVOICE_SQL);
    psql(`DROP TRIGGER IF EXISTS trg_refuse_posted_invoice_child_write ON public.invoice_items;
      CREATE TRIGGER trg_refuse_posted_invoice_child_write BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_items
      FOR EACH ROW EXECUTE FUNCTION public._refuse_posted_invoice_child_write();`);
  }
  assert.equal(scalar("SELECT md5(prosrc) = md5(prosrc) AND position('while it was being posted' in prosrc) > 0 AND position('invoice_items WHERE invoice_id = p_invoice_id ORDER BY id FOR UPDATE' in prosrc) > 0 FROM pg_proc WHERE oid = 'public.post_invoice(uuid,text,text)'::regprocedure;"), 't');
}

async function main() {
  const started = Date.now();
  if (!REUSE) buildContainer();
  if (scalar("SELECT count(*) FROM public.profiles WHERE id::text LIKE '7d400000-%';") === '0') seed();
  if (scalar("SELECT to_regproc('public.invoice_post_version') IS NULL;") === 't') {
    runBefore();
    // The preflight pins every body it replaces or relies on.
    const PREFLIGHT_EXEC = `$q$DO $p$${lf(CANDIDATE).split('$preflight$')[1]}$p$$q$`;
    const drift = scenario([{ key: 'preflight on a drifted body', as: 'owner', stmt: `
      CREATE OR REPLACE FUNCTION public._post_invoice_idem_impl_20260721(p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text) RETURNS void LANGUAGE plpgsql AS $x$ BEGIN RETURN; END $x$;
      EXECUTE ${PREFLIGHT_EXEC}; v := 'applied';` }]);
    assert.match(drift['preflight on a drifted body'], /^P0001\|PREFLIGHT: public\._post_invoice_idem_impl_20260721\(uuid,text\) body drifted/);
    console.log('[prover] PREFLIGHT: a drifted posting body refuses the apply');
    stageText('candidate.sql', lf(CANDIDATE));
    const a = apply('candidate.sql');
    assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
    console.log('[prover] candidate applied');
  }
  check(runAfter());

  for (const fn of ['public._invoice_post_version(uuid)', 'public._invoice_post_content_version(uuid)']) {
    assert.equal(scalar(`SELECT string_agg(r, ',' ORDER BY r) FROM unnest(ARRAY['anon','authenticated']) r WHERE has_function_privilege(r, '${fn}', 'EXECUTE');`), '', `${fn} is executable by an API role`);
  }
  for (const fn of ['public.post_invoice(uuid,text,text)', 'public.post_invoice_group(uuid,uuid,jsonb,text)', 'public.batch_post_invoices(jsonb,text)', 'public.invoice_post_version(public.invoices)']) {
    assert.equal(scalar(`SELECT string_agg(r, ',' ORDER BY r) FROM unnest(ARRAY['anon','authenticated']) r WHERE has_function_privilege(r, '${fn}', 'EXECUTE');`), 'authenticated', `${fn} grants are wrong`);
    assert.equal(scalar(`SELECT p.prosecdef AND p.proconfig::text LIKE '%search_path=public, pg_temp%' FROM pg_proc p WHERE p.oid = '${fn}'::regprocedure;`), 't', `${fn} is not SECURITY DEFINER with search_path`);
  }
  console.log('[prover] GRANTS: authenticated (not anon) runs the posting functions and the computed field; no API role runs the hash helpers');

  await races();

  console.log(`[prover] finished in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log('POST_BINDS_REVIEWED_VERSION_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
