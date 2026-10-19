#!/usr/bin/env node
/**
 * Full-chain proof for the 20261019010000 candidate: database functions stop handing product
 * cost, profit and margin to non-admins (Goal 1 part 3, step 1; Mason 2026-10-15).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate,
 * checks that every body the candidate replaces or renames matches its live md5 of 2026-10-18,
 * seeds one priced product with stock and one order, then runs one matrix of calls BEFORE and
 * AFTER the candidate as each role (a signed-in browser session through PostgREST, or a
 * signed-out visitor). Every call is one transaction that always rolls back.
 *   1. Cost reports (gross sales, inventory cost, field profitability, profitability, bottom-line
 *      P&L): BEFORE a sales rep reads them (and a signed-out visitor runs the P&L); AFTER only an
 *      active admin does, everyone else is refused by require_admin().
 *   2. Sales detail / summary: same rows for a rep before and after, but AFTER every cost, profit
 *      and margin value is NULL for the rep while an admin still gets them.
 *   3. get_inventory_position: same rows; AFTER no row carries current_cost for a rep.
 *   4. save_quote (impl stubbed inside the probe): AFTER the rep's reply has no cost keys.
 *   5. Below-cost refusal: BEFORE the rep's error message carries locked_unit_cost_cents; AFTER
 *      it does not, while the admin's still does.
 *   6. The preflight refuses a drifted body; re-applying the candidate changes no result.
 *   7. MUTATION: with require_admin() emptied, a rep reads the gross sales report again, so the
 *      refusal really is the admin gate.
 *
 * Run: node scripts/smoke/prove-cost-margin-admin-only-rpc-leaks-real-schema.mjs   (needs Docker)
 * Prints COST_MARGIN_RPC_LEAKS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-cost-rpc-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1' || REUSE;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261019010000_cost_margin_admin_only_rpc_leaks.sql');
const CHAIN = path.join(ROOT, 'scripts', 'smoke', 'smoke-cost_margin_admin_only_rpc_leaks.sql');
// Live but not replayable here (storage.objects policies, storage.buckets settings); they must not
// touch what this proves.
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
const TOUCHED = /get_gross_sales_report|get_inventory_cost_report|get_field_profitability|get_profitability_report|get_bottom_line_pnl|get_sales_detail_report|get_sales_summary_report|get_inventory_position|save_quote\(|_enforce_below_cost_line|dashboard_summary\(|_save_quote_below_cost_impl_20260810/;
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';

const id = (n) => `7c100000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = {
  ADMIN: id('a1'), ADMIN_OFF: id('a3'), REP: id('b1'), REP_OFF: id('b3'),
  DRIVER: id('d1'), APPLICATOR: id('e1'), ENTITY: id('f9'),
};
const CUST = id('c1');
const PROD = id('f1');
const ORDER = id('0d1');
const ORDER_ITEM = id('0e1');

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
  // Live's auth.uid() goes in before the replay: 20261016140000 (replay batch 2) refuses to apply
  // unless auth.uid() is live's reviewed body.
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  const files = plan();
  let replayed = 0;
  for (const [i, file] of files.entries()) {
    const base = path.basename(file);
    if (PARKED.has(base)) continue;
    for (const only of LEDGER_ONLY) if (only < base) ledger(path.basename(only, '.sql'));
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

// ------------------------------------------------------------------------------------------------
// FIDELITY: every md5 pin in the candidate's preflight matches the replayed body.
function fidelity() {
  const sql = lf(CANDIDATE).split('$preflight$')[1];
  const renamed = [...sql.matchAll(/\('(public\.[a-z_]+\([^']*\))', '[a-z_]+', '([0-9a-f]{32})'\)/g)].map((m) => [m[1], m[2]]);
  assert.equal(renamed.length, 9, 'the preflight pins the nine renamed bodies');
  const replaced = [
    ['public._enforce_below_cost_line()', /_enforce_below_cost_line\(\)'\)\)\s*NOT IN \('([0-9a-f]{32})'/],
    ['public.save_quote(uuid,jsonb,jsonb,uuid,text)', /save_quote\(uuid,jsonb,jsonb,uuid,text\)'\)\)\s*NOT IN \('([0-9a-f]{32})'/],
    ['public.is_admin()', /is_admin\(\)'\)\) IS DISTINCT FROM '([0-9a-f]{32})'/],
    ['public.require_admin()', /require_admin\(\)'\)\) IS DISTINCT FROM '([0-9a-f]{32})'/],
    ['public._save_quote_below_cost_impl_20260810(uuid,jsonb,jsonb,uuid,text)', /_save_quote_below_cost_impl_20260810\(uuid,jsonb,jsonb,uuid,text\)'\)\)\s*IS DISTINCT FROM '([0-9a-f]{32})'/],
  ].map(([sig, re]) => { const m = re.exec(sql); assert.ok(m, `the preflight pins ${sig}`); return [sig, m[1]]; });
  for (const [sig, pin] of [...renamed, ...replaced]) {
    assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${sig}');`), pin,
      `${sig} replayed with a body that differs from the live pin`);
  }
  console.log(`[prover] FIDELITY: all ${renamed.length + replaced.length} pinned bodies match the live pins of 2026-10-18`);
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
      ${users.map(([u, role, label]) => `('${u}', 'cost-rpc-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    ${claims(U.ADMIN)}
    UPDATE public.profiles SET is_active = false WHERE id IN ('${U.REP_OFF}', '${U.ADMIN_OFF}');
    UPDATE public.profiles SET role = 'entity_recipient' WHERE id = '${U.ENTITY}';
    INSERT INTO public.customers (id, farm_name, is_active, email) VALUES ('${CUST}', '[PROVER] Cost Farm', true, 'c1@example.invalid');
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, product_form, is_active)
      VALUES ('${PROD}', '[PROVER] Costed Product', 'GL', 6.00, 10.00, 'liquid', true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.inventory (product_id, quantity_available, unit_size) VALUES ('${PROD}', 50, 'GL');
    SELECT set_config('app.crx_below_cost_operation', 'create_direct_order', true);
    INSERT INTO public.orders (id, order_number, customer_id, status, order_date, salesman_id)
      VALUES ('${ORDER}', 'PROVER-ORD-1', '${CUST}', 'confirmed', CURRENT_DATE, '${U.REP}');
    INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, price_per_unit, total_units_needed, total_price, cost_per_unit)
      VALUES ('${ORDER_ITEM}', '${ORDER}', '${PROD}', '[PROVER] Costed Product', 'GL', 10.00, 2, 20.00, 6.00);
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7c100000-%';`),
    'admin:true,sales_rep:true,sales_rep:false,driver:true,applicator:true,entity_recipient:true,admin:false', 'the seeded roles are not what the proof needs');
  assert.equal(scalar(`SELECT cost_at_time_cents || ':' || profit FROM public.order_items WHERE id = '${ORDER_ITEM}';`), '600:8.00', 'the order line did not snapshot cost 6.00 / profit 8.00');
}

// ------------------------------------------------------------------------------------------------
// Probes.
/**
 * Run `call` (an expression) or `stmt` (PL/pgSQL statements) as `uid` ('anon' for a signed-out
 * visitor), after `fixture` (owner), in one rolled-back transaction. ok|<value> or <sqlstate>|<message>.
 * `owner: true` keeps the owner role but sets the caller's JWT (a trigger reached from an RPC).
 */
function attempt(uid, { call, stmt, fixture = '', owner = false }) {
  const who = owner ? claims(uid) : asUser(uid);
  const body = stmt ? `${stmt}\n  v := 'done';` : `v := (${call})::text;`;
  const sql = `BEGIN;
${fixture}
RESET ROLE;
${who}
DO $probe$
DECLARE v text;
BEGIN
  ${body}
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

const GROSS = { call: "(SELECT count(*) || ':' || coalesce(sum(total_cost), 0) FROM public.get_gross_sales_report('2000-01-01', '2100-01-01', 'product'))" };
const INV_COST = { call: `(SELECT count(*) || ':' || coalesce(max(unit_cost), 0) FROM public.get_inventory_cost_report() WHERE product_id = '${PROD}')` };
const FIELD_PROFIT = { call: '(SELECT count(*) FROM public.get_field_profitability(NULL))' };
const PROFIT = { call: "(SELECT count(*) || ':' || coalesce(sum(total_cost), 0) FROM public.get_profitability_report('product'))" };
const PNL = { call: "(SELECT count(*) FROM public.get_bottom_line_pnl('2000-01-01', '2100-01-01'))" };
const DASH = { call: 'jsonb_typeof(public.dashboard_summary())' };
const DETAIL = { call: "(SELECT count(*) || ':' || count(cost) || ':' || count(profit) || ':' || count(margin_pct) || ':' || coalesce(sum(total_price), 0) FROM public.get_sales_detail_report())" };
const SUMMARY = { call: "(SELECT count(*) || ':' || count(total_cost) || ':' || count(total_profit) || ':' || count(margin_pct) || ':' || coalesce(sum(total_revenue), 0) FROM public.get_sales_summary_report())" };
const POSITION = { call: `(SELECT jsonb_array_length(x) || ':' || (SELECT count(*) FROM jsonb_array_elements(x) e WHERE e ? 'current_cost') || ':' || coalesce((SELECT e->>'product_name' FROM jsonb_array_elements(x) e WHERE e->>'product_id' = '${PROD}'), '-') FROM (SELECT public.get_inventory_position() AS x) s)` };
// save_quote with its impl stubbed (owner, inside the rolled-back probe) to the reply shape the real
// impl builds (20260812115236: status, quote_id, ..., server_totals {total_price, total_cost,
// total_profit, total_margin_pct}); the same object is what a replay returns. Reports
// "<top-level keys>|<server_totals keys>".
const STUB_QUOTE_IMPL = `CREATE OR REPLACE FUNCTION public._save_quote_below_cost_impl_20260810(p_quote_id uuid, p_quote_payload jsonb, p_sections jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
  RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('status', 'saved', 'quote_id', 'q1',
    'server_totals', jsonb_build_object('total_price', 10, 'total_cost', 6, 'total_profit', 4, 'total_margin_pct', 40)) $$;`;
const quote = (uid) => ({
  call: `(SELECT (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(r) k) || '|' || (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(r->'server_totals') k)
          FROM (SELECT public.save_quote(NULL, '{}'::jsonb, '[]'::jsonb, '${uid}'::uuid, NULL) AS r) s)`,
  fixture: STUB_QUOTE_IMPL,
});
const QUOTE_FULL = /^ok\|quote_id,server_totals,status\|total_cost,total_margin_pct,total_price,total_profit$/;
// A one-cent price on the seeded order line, as update_order_items would write it.
const BELOW = {
  owner: true,
  stmt: `PERFORM set_config('app.crx_below_cost_operation', 'update_order_items', true);
  UPDATE public.order_items SET price_per_unit = 0.01, total_price = 0.02 WHERE id = '${ORDER_ITEM}';`,
};

const DENIED = /^P0001\|Permission denied: requires admin role$/;
const IMPL_DENIED = /^P0001\|Access denied: .*role required$/;
const NO_FN = (fn) => new RegExp(`^42501\\|permission denied for function ${fn}$`);
const WITH_COST = /^P0001\|BELOW_COST_ADMIN_REQUIRED:.*"locked_unit_cost_cents": 600/;
const WITHOUT_COST = /^P0001\|BELOW_COST_ADMIN_REQUIRED:(?!.*locked_unit_cost_cents).*"unit_price_cents": 1/;

/** [label, uid, probe, before, after]; 'same' means identical before and after. */
const CASES = [
  ['admin: gross sales', U.ADMIN, GROSS, /^ok\|1:12\.00$/, 'same'],
  ['rep: gross sales', U.REP, GROSS, /^ok\|1:12\.00$/, DENIED],
  ['deactivated admin: gross sales', U.ADMIN_OFF, GROSS, IMPL_DENIED, DENIED],
  ['driver: gross sales', U.DRIVER, GROSS, IMPL_DENIED, DENIED],
  ['signed-out: gross sales', 'anon', GROSS, NO_FN('get_gross_sales_report'), 'same'],

  ['admin: inventory cost', U.ADMIN, INV_COST, /^ok\|1:6\.00$/, 'same'],
  ['rep: inventory cost', U.REP, INV_COST, /^ok\|1:6\.00$/, DENIED],
  ['applicator: inventory cost', U.APPLICATOR, INV_COST, IMPL_DENIED, DENIED],

  ['admin: field profitability', U.ADMIN, FIELD_PROFIT, /^ok\|0$/, 'same'],
  ['rep: field profitability', U.REP, FIELD_PROFIT, /^ok\|0$/, DENIED],
  ['driver: field profitability', U.DRIVER, FIELD_PROFIT, /^P0001\|INSUFFICIENT_ROLE$/, DENIED],

  ['admin: profitability', U.ADMIN, PROFIT, /^ok\|1:12\.00$/, 'same'],
  ['rep: profitability', U.REP, PROFIT, /^ok\|1:12\.00$/, DENIED],

  ['admin: bottom-line P&L', U.ADMIN, PNL, /^ok\|[1-9]\d*$/, 'same'],
  ['rep: bottom-line P&L', U.REP, PNL, /^ok\|[1-9]\d*$/, DENIED],
  ['driver: bottom-line P&L', U.DRIVER, PNL, /^ok\|[1-9]\d*$/, DENIED],
  ['entity recipient: bottom-line P&L', U.ENTITY, PNL, /^ok\|[1-9]\d*$/, DENIED],
  // Before: anon could EXECUTE the report, and RLS stopped it at is_admin(). After: no EXECUTE at all.
  ['signed-out: bottom-line P&L', 'anon', PNL, /^42501\|permission denied for function is_admin$/, NO_FN('get_bottom_line_pnl')],

  ['admin: dashboard summary', U.ADMIN, DASH, /^ok\|object$/, 'same'],
  ['rep: dashboard summary', U.REP, DASH, /^ok\|object$/, DENIED],
  ['driver: dashboard summary', U.DRIVER, DASH, /^ok\|object$/, DENIED],
  ['applicator: dashboard summary', U.APPLICATOR, DASH, /^ok\|object$/, DENIED],
  ['deactivated admin: dashboard summary', U.ADMIN_OFF, DASH, /^ok\|object$/, DENIED],
  ['signed-out: dashboard summary', 'anon', DASH, NO_FN('dashboard_summary'), 'same'],

  ['admin: sales detail', U.ADMIN, DETAIL, /^ok\|1:1:1:1:20\.00$/, 'same'],
  ['rep: sales detail', U.REP, DETAIL, /^ok\|1:1:1:1:20\.00$/, /^ok\|1:0:0:0:20\.00$/],
  ['driver: sales detail', U.DRIVER, DETAIL, IMPL_DENIED, 'same'],
  ['admin: sales summary', U.ADMIN, SUMMARY, /^ok\|1:1:1:1:20\.00$/, 'same'],
  ['rep: sales summary', U.REP, SUMMARY, /^ok\|1:1:1:1:20\.00$/, /^ok\|1:0:0:0:20\.00$/],

  ['admin: inventory position', U.ADMIN, POSITION, /^ok\|(\d+):\1:\[PROVER\] Costed Product$/, 'same'],
  ['rep: inventory position', U.REP, POSITION, /^ok\|([1-9]\d*):\1:\[PROVER\] Costed Product$/, /^ok\|[1-9]\d*:0:\[PROVER\] Costed Product$/],
  ['driver: inventory position', U.DRIVER, POSITION, /^P0001\|/, 'same'],

  ['admin: save_quote reply', U.ADMIN, quote(U.ADMIN), QUOTE_FULL, 'same'],
  ['rep: save_quote reply', U.REP, quote(U.REP), QUOTE_FULL, /^ok\|quote_id,server_totals,status\|total_price$/],

  ['rep: one-cent price', U.REP, BELOW, WITH_COST, WITHOUT_COST],
  ['driver: one-cent price', U.DRIVER, BELOW, WITH_COST, WITHOUT_COST],
  ['admin without a reason: one-cent price', U.ADMIN, BELOW, /^P0001\|BELOW_COST_REASON_REQUIRED:.*"locked_unit_cost_cents": 600/, 'same'],
  ['deactivated admin: one-cent price', U.ADMIN_OFF, BELOW, WITH_COST, WITHOUT_COST],
];

function runMatrix(phase) {
  const out = {};
  for (const [label, uid, probe] of CASES) out[label] = attempt(uid, probe);
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
  for (const [setup, refusal] of [
    ['CREATE OR REPLACE FUNCTION public.get_inventory_cost_report() RETURNS TABLE(product_id uuid, product_name text, sku text, category text, vendor text, quantity_available numeric, quantity_prebooked numeric, net_available numeric, unit_cost numeric, total_cost_value numeric, reorder_point numeric, below_reorder boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN; END; $$;',
      /COST_ADMIN_ONLY_PREFLIGHT: public\.get_inventory_cost_report\(\) is missing or drifted/],
    ['CREATE FUNCTION public._get_inventory_cost_report_cost_impl_20261019() RETURNS TABLE(product_id uuid) LANGUAGE sql AS $$ SELECT NULL::uuid $$;',
      /COST_ADMIN_ONLY_PREFLIGHT: public\._get_inventory_cost_report_cost_impl_20261019 exists but is not the pinned body/],
    ['CREATE FUNCTION public.get_bottom_line_pnl(p_x int) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
      /COST_ADMIN_ONLY_PREFLIGHT: expected exactly one public\.get_bottom_line_pnl overload/],
    ['CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN true; END; $$;',
      /COST_ADMIN_ONLY_PREFLIGHT: public\.is_admin\(\) is missing or drifted/],
  ]) {
    const d = docker([...psqlArgs()], { input: `BEGIN;\n${setup}\n\\i /tmp/cand.sql\nROLLBACK;`, allowFailure: true });
    assert.notEqual(d.status, 0, `the candidate applied over: ${setup}`);
    assert.match(d.stderr, refusal, `wrong refusal for ${setup}:\n${d.stderr}`);
  }
  console.log('[prover] PREFLIGHT: a drifted report body, a stale impl of the renamed name, an extra overload and a drifted is_admin() each abort the candidate');
}

function main() {
  if (!REUSE) buildContainer();
  else assert.equal(scalar("SELECT count(*) FROM pg_proc WHERE proname LIKE '%_cost_impl_20261019';"), '0',
    'the reused container already has the candidate applied (it is in the AFTER state); rebuild it');
  fidelity();
  if (scalar("SELECT count(*) FROM public.profiles WHERE id::text LIKE '7c100000-%';") === '0') seed();

  const before = runMatrix('before');
  check('before', before);
  preflightRefusesDrift();

  stageText('chain.sql', lf(CHAIN));
  const chainBefore = docker([...psqlArgs(), '-f', '/tmp/chain.sql'], { allowFailure: true });
  assert.match(chainBefore.stderr, /SMOKE_FAIL: public\.get_gross_sales_report\(date,date,text\) is not SECURITY DEFINER/,
    `the live chain should fail before the candidate:\n${chainBefore.stderr}`);
  console.log('[prover] LIVE CHAIN: fails closed before the candidate');

  stageText('candidate.sql', lf(CANDIDATE));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  console.log('[prover] candidate applied');

  const after = runMatrix('after');
  check('after', after, before);

  // The live chain, run here first: it must fail closed before the candidate and pass after it.
  stageText('chain.sql', lf(CHAIN));
  const chainAfter = docker([...psqlArgs(), '-f', '/tmp/chain.sql'], { allowFailure: true });
  assert.match(chainAfter.stderr, /SMOKE_PASS_ROLLBACK/, `the live chain did not pass after the candidate:\n${chainAfter.stderr}`);
  console.log('[prover] LIVE CHAIN: smoke-cost_margin_admin_only_rpc_leaks.sql passes after the candidate');

  const again = apply('candidate.sql');
  assert.equal(again.status, 0, `re-applying the candidate failed:\n${again.output}`);
  check('after', runMatrix('re-apply'), before);
  console.log('[prover] RE-APPLY: the candidate re-applies cleanly and every result is unchanged');

  const mutant = attempt(U.REP, {
    ...GROSS,
    fixture: 'CREATE OR REPLACE FUNCTION public.require_admin() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN END; $$;',
  });
  assert.match(mutant, /^ok\|1:12\.00$/, `MUTATION: with require_admin() emptied the rep should read gross sales, got ${mutant}`);
  console.log('[prover] MUTATION: with require_admin() emptied the rep reads gross sales again, so the refusal is the admin gate');

  console.log('COST_MARGIN_RPC_LEAKS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
