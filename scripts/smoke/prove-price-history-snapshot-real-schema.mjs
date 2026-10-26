#!/usr/bin/env node
/**
 * Full-chain proof for the 20261026140000 candidate: a dated starting snapshot of every product's
 * prices in cost_history, and product deletes that refuse instead of erasing history (To-Do 0.4,
 * pricing plan slice 4).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate, seeds an
 * admin and a sales rep, three products (one with an earlier history row, one inactive) and runs one
 * matrix BEFORE and AFTER the candidate. Each scenario is one transaction that always rolls back.
 *   1. The snapshot: exactly one per product that had NO history, its values equal the product's,
 *      changed_by empty; a product with earlier history gets none and that row is untouched; a second
 *      run of the INSERT adds nothing.
 *   2. Rules: a real change with no changed_by is refused; an unknown source is refused; deleting a
 *      product with history is refused (before: it cascaded the history away).
 *   3. Who: an admin reads the history; a sales rep and a signed-out visitor read none.
 *   4. Preflight drift refusals; a second apply is refused; the live smoke chain passes once.
 *
 * Run: node scripts/smoke/prove-price-history-snapshot-real-schema.mjs   (needs Docker)
 * Prints PRICE_HISTORY_SNAPSHOT_PROOF_PASS on success. CRX_PROVER_VERBOSE=1 prints every step.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-price-snapshot-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1' || REUSE;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261026140000_product_price_history_starting_snapshot.sql');
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
const TOUCHED = /(cost_history|_get_product_price_history|FUNCTION\s+(public\.)?"?get_product_price_history\b)/i;
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
// Probes: one transaction per scenario, always rolled back. A step yields "ok|<value>" or
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

// ------------------------------------------------------------------------------------------------
// Fixtures (committed once; every probe rolls back).
const id = (n) => `7c330000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), REP: id('b1') };
const PA = id('f1'); // has an earlier history row
const PB = id('f2'); // no history
const PC = id('f3'); // inactive, no history
const OLD_ROW = id('e1');
const q = (value) => `'${value}'`;

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.REP, 'sales_rep', 'Rep', 8]];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'price-snapshot-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};`);
  psql(`BEGIN;
    SET LOCAL session_replication_role = replica;
    ${users.map(([u, role, , minutes]) => `UPDATE public.profiles SET role = '${role}', is_active = true, created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, tier2_price, tier3_price, tier1_margin, product_form, is_active, pricing_version) VALUES
      ('${PA}', '[PROVER] A', 'gal', 20.00, 30.00, 28.50, NULL, 0.3333, 'liquid', true, 3),
      ('${PB}', '[PROVER] B', 'gal', 7.25, 12.00, 11.00, 10.00, NULL, 'liquid', true, 1),
      ('${PC}', '[PROVER] C', 'gal', 9.00, 12.00, NULL, NULL, NULL, 'liquid', false, 1);
    INSERT INTO public.cost_history (id, product_id, changed_by, change_source, change_reason, changed_at, old_cost, new_cost, old_tier1_price, new_tier1_price)
      VALUES ('${OLD_ROW}', '${PA}', '${U.ADMIN}', 'product_page', 'earlier change', now() - interval '30 days', 19.00, 20.00, 29.00, 30.00);
    COMMIT;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT count(*) FROM public.products WHERE id::text LIKE '7c330000-%';"), '3', 'products not seeded');
  console.log('[prover] seeded an admin, a sales rep, three products and one earlier history row');
}

// ------------------------------------------------------------------------------------------------
// Before the candidate a snapshot row cannot exist: changed_by is NOT NULL, and the source is not allowed.
const NO_SNAPSHOT_SOURCE = /^(23514\|.*cost_history_change_source_check|23502\|.*"changed_by")/;
const SNAP = (p) => `(SELECT count(*) || ':' || COALESCE(string_agg(COALESCE(h.new_cost::text, '-') || '/' || COALESCE(h.new_tier1_price::text, '-') || '/' || COALESCE(h.new_tier2_price::text, '-') || '/' || COALESCE(h.new_tier3_price::text, '-') || '/' || COALESCE(h.new_pricing_version::text, '-') || '/' || (h.changed_by IS NULL)::text || '/' || (h.old_cost IS NOT DISTINCT FROM h.new_cost)::text, ','), '')
  FROM public.cost_history h WHERE h.product_id = '${p}' AND h.change_source = 'starting_snapshot')`;
const SNAPSHOT_INSERT = () => lf(CANDIDATE).split('-- 3. The starting snapshot.')[1].split('-- VERIFY')[0];
const COUNT_ALL = `(SELECT count(*) FROM public.cost_history h JOIN public.products p ON p.id = h.product_id WHERE p.id::text LIKE '7c330000-%')`;

/**
 * Scenarios. Each step: [key, as, call|{stmt}, before, after]. before/after: a RegExp, an exact
 * string, or 'same'.
 */
const SCENARIOS = [
  { name: '1. the snapshot', steps: [
    ['A (has earlier history): no snapshot', 'bare', SNAP(PA), 'ok|0:', 'same'],
    ['B: one snapshot equal to the product', 'bare', SNAP(PB), 'ok|0:', 'ok|1:7.25/12.00/11.00/10.00/1/true/true'],
    ['C (inactive): one snapshot too', 'bare', SNAP(PC), 'ok|0:', 'ok|1:9.00/12.00/-/-/1/true/true'],
    ['the earlier history row is untouched', 'bare', `(SELECT change_source || '/' || change_reason || '/' || new_tier1_price FROM public.cost_history WHERE id = '${OLD_ROW}')`, 'ok|product_page/earlier change/30.00', 'same'],
    ['a second run of the snapshot INSERT adds nothing', 'bare', { stmt: `${SNAPSHOT_INSERT()} v := ${COUNT_ALL}::text;` }, NO_SNAPSHOT_SOURCE, 'ok|3'],
  ] },
  { name: '2. rules', steps: [
    ['a real change with no changed_by is refused', 'bare', { stmt: `INSERT INTO public.cost_history (product_id, changed_by, change_source) VALUES ('${PB}', NULL, 'product_page'); v := 'inserted';` }, /^23502\|.*changed_by/, /^23514\|.*cost_history_changed_by_required/],
    ['an unknown source is refused', 'bare', { stmt: `INSERT INTO public.cost_history (product_id, changed_by, change_source) VALUES ('${PB}', '${U.ADMIN}', 'made_up'); v := 'inserted';` }, /^23514\|.*cost_history_change_source_check/, 'same'],
    ['deleting a product with history', 'bare', { stmt: `DELETE FROM public.products WHERE id = '${PA}'; v := (SELECT count(*) FROM public.cost_history WHERE product_id = '${PA}')::text;` }, 'ok|0', /^23503\|.*cost_history_product_id_fkey/],
  ] },
  { name: '3. who', steps: [
    ['admin reads the history', U.ADMIN, `(SELECT count(*) FROM public.cost_history WHERE product_id = '${PB}')`, 'ok|0', 'ok|1'],
    ['a sales rep reads none', U.REP, `(SELECT count(*) FROM public.cost_history WHERE product_id = '${PA}')`, 'ok|0', 'same'],
    ['a signed-out visitor cannot read it', 'anon', `(SELECT count(*) FROM public.cost_history)`, /^42501\|permission denied for table cost_history$/, 'same'],
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

function preflightRefusesDrift(phase) {
  stageText('cand.sql', lf(CANDIDATE));
  const cases = phase === 'before' ? [
    ["ALTER TABLE public.cost_history DROP CONSTRAINT cost_history_change_source_check, ADD CONSTRAINT cost_history_change_source_check CHECK (change_source = ANY (ARRAY['legacy_frontend'::text, 'pricing_worksheet'::text, 'product_page'::text, 'products_inline'::text, 'drifted'::text]));",
      /PRICE_HISTORY_SNAPSHOT_PREFLIGHT: cost_history_change_source_check changed/],
    ['ALTER TABLE public.cost_history DROP CONSTRAINT cost_history_product_id_fkey, ADD CONSTRAINT cost_history_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);',
      /PRICE_HISTORY_SNAPSHOT_PREFLIGHT: cost_history_product_id_fkey changed/],
    ['ALTER TABLE public.cost_history ALTER COLUMN changed_by DROP NOT NULL;',
      /PRICE_HISTORY_SNAPSHOT_PREFLIGHT: cost_history.changed_by is not/],
  ] : [
    ['SELECT 1;', /PRICE_HISTORY_SNAPSHOT_PREFLIGHT: /],
  ];
  for (const [setup, refusal] of cases) {
    const d = docker([...psqlArgs()], { input: `BEGIN;\n${setup}\n\\i /tmp/cand.sql\nROLLBACK;`, allowFailure: true });
    assert.notEqual(d.status, 0, `the candidate applied over: ${setup}`);
    assert.match(d.stderr, refusal, `wrong refusal for ${setup}:\n${d.stderr}`);
  }
  console.log(`[prover] PREFLIGHT (${phase}): ${cases.length} drifted state(s) each abort the candidate${phase === 'after' ? ' (a second apply is refused)' : ''}`);
}

function main() {
  const started = Date.now();
  if (!REUSE) buildContainer();
  assert.equal(scalar("SELECT count(*) FROM public.cost_history WHERE change_source = 'starting_snapshot';"), '0', 'a reused container must be BEFORE the candidate (drop it and rebuild)');
  if (scalar("SELECT count(*) FROM public.profiles WHERE id::text LIKE '7c330000-%';") === '0') seed();

  check('before', runMatrix('before'));
  preflightRefusesDrift('before');
  const rowsBefore = scalar('SELECT count(*) FROM public.cost_history;');
  const products = scalar('SELECT count(*) FROM public.products p WHERE NOT EXISTS (SELECT 1 FROM public.cost_history h WHERE h.product_id = p.id);');

  stageText('candidate.sql', lf(CANDIDATE));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.equal(scalar('SELECT count(*) FROM public.cost_history;'), String(Number(rowsBefore) + Number(products)), 'the apply must add exactly one row per product with no history');
  console.log(`[prover] candidate applied: ${products} snapshot rows added to ${rowsBefore} existing`);

  check('after', runMatrix('after'));
  preflightRefusesDrift('after');

  stageText('smoke.sql', lf(path.join(ROOT, 'scripts', 'smoke', 'smoke-price-history-snapshot.sql')));
  const smoke = docker([...psqlArgs(), '-f', '/tmp/smoke.sql'], { allowFailure: true });
  assert.match(smoke.stderr, /SMOKE_PASS_ROLLBACK/, `the smoke chain did not pass:\n${smoke.stderr}`);
  console.log('[prover] SMOKE: smoke-price-history-snapshot.sql ends in SMOKE_PASS_ROLLBACK');

  console.log(`[prover] finished in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log('PRICE_HISTORY_SNAPSHOT_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
