#!/usr/bin/env node
/**
 * Full-chain proof for the 20261019230000 candidate: the screens get what they need so step 3 can
 * revoke the cost columns (Goal 1 part 3, step 2; cost and margin are admin-only, Mason 2026-10-15;
 * purchase orders Option A, Mason 2026-10-18).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate
 * (step 1, 20261019010000, included), checks every md5 pin in the candidate's preflight against the
 * replayed body (get_chemical_history comes from the baseline, which carries its live body), seeds
 * one admin / deactivated admin / sales rep / driver / applicator, products, POs, invoices, a quote
 * version and an order, then runs one matrix BEFORE and AFTER the candidate. Each scenario is one
 * transaction that always rolls back; each step runs as a PostgREST session (request.jwt.claims +
 * SET LOCAL ROLE authenticated), a signed-out visitor (anon), or the owner.
 *   1. get_admin_cost_fields: admin reads cost for six tables and every allow-listed table runs;
 *      deactivated admin, rep, driver, applicator refused; anon cannot execute; unknown table and
 *      more than 5000 ids refused.
 *   2. get_quote_versions: a rep gets every cost/profit/margin value NULL (keys kept); admin gets
 *      the stored snapshot; driver refused.
 *   3. save_job: a rep's chemical cost is server-derived (281 per pt, 2250 per gal from 22.50/gal),
 *      the job total follows; an admin's sent cost is stored; a rep re-save keeps the admin's cost.
 *   4. save_purchase_order is NOT changed (Mason, 2026-10-20, option 1): a rep's cost is stored as
 *      sent, before and after.
 *   6. match_quick_receive_items: no unit_cost for a rep; is_no_return for everyone.
 *   7. get_chemical_history: a rep sees no purchase price; driver gets no rows.
 *   8. The private save_field_app_invoice / save_invoice rewrite helpers, called as the owner.
 *   9. Grants; 10. preflight drift refusals and a clean re-apply; 11. MUTATION: require_admin()
 *      emptied lets a rep read get_admin_cost_fields.
 *
 * Run: node scripts/smoke/prove-cost-margin-admin-only-screens-step2-real-schema.mjs   (needs Docker)
 * Prints COST_MARGIN_SCREENS_STEP2_PROOF_PASS on success. CRX_PROVER_VERBOSE=1 prints every step.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-cost-step2-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1' || REUSE;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261019230000_cost_margin_admin_only_screens_step2.sql');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
]);
// A later or parked file that (re)defines, renames or re-grants anything the candidate replaces or relies on.
const TOUCHED = /FUNCTION\s+(public\.)?"?(save_job|save_field_app_invoice|save_invoice|save_purchase_order|get_chemical_history|match_quick_receive_items|get_admin_cost_fields|get_quote_versions|set_purchase_order_item_costs|_cost_step2_\w+|_\w+_cost_step2_impl|_save_purchase_order_atomic_number_impl|_save_field_app_invoice_impl_20260714|_save_invoice_lineage_unaware_impl_20260827|field_app_priced_quantity|is_admin|is_sales_rep|require_admin)\b/i;
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
function pins() {
  const sql = lf(CANDIDATE).split('$preflight$')[1];
  const renamed = [...sql.matchAll(/\('(public\.[a-z_]+\([^']*\))', '([a-z_]+)', '([0-9a-f]{32})'\)/g)].map((m) => [m[1], m[3]]);
  const relied = [...sql.matchAll(/^\s*\('(public\.[a-z_0-9]+\([^']*\))', '([0-9a-f]{32})'\)/gm)].map((m) => [m[1], m[2]]);
  assert.equal(renamed.length, 5, 'the preflight pins the five renamed bodies');
  assert.equal(relied.length, 6, 'the preflight pins the six bodies the rewrites rely on');
  return [...renamed, ...relied];
}
function fidelity() {
  const all = pins();
  for (const [sig, pin] of all) {
    const got = scalar(`SELECT coalesce(md5(replace(prosrc, chr(13), '')), 'MISSING') FROM pg_proc WHERE oid = to_regprocedure('${sig}') UNION ALL SELECT 'MISSING' LIMIT 1;`);
    assert.equal(got, pin, `${sig} replayed with a body that differs from the live pin of 2026-10-19`);
  }
  // get_chemical_history comes from the 2026-07-27 production baseline (no post-baseline migration
  // defines it). Its live definition read on 2026-10-19 must be what the baseline installed.
  assert.equal(scalar(`SELECT p.prosecdef || ':' || l.lanname || ':' || p.provolatile::text || ':' || array_to_string(p.proconfig, ';') FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'public.get_chemical_history(uuid,date,date)'::regprocedure;`),
    'false:plpgsql:s:search_path=public', 'get_chemical_history is not the live SECURITY INVOKER / plpgsql / STABLE / search_path=public body');
  console.log(`[prover] FIDELITY: all ${all.length} pinned bodies match the live pins of 2026-10-19 (get_chemical_history included: the baseline carries the live body, so no pin was relaxed)`);
}

// ------------------------------------------------------------------------------------------------
// Fixtures (committed once; every probe rolls back).
const id = (n) => `7c200000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), ADMIN_OFF: id('a3'), REP: id('b1'), DRIVER: id('d1'), APPLICATOR: id('e1') };
const CUST = id('c1');
const FIELD = id('1e1');
const PROD = id('f1'); // current_cost 22.50 per gal, liquid
const PROD_B = id('f2'); // current_cost 7.25 per gal
const PROD_C = id('f3'); // current_cost 8.00 per gal (PO3 only)
const PO1 = id('101'); const PO2 = id('102'); const PO3 = id('103');
const POI1 = id('201'); const POI2 = id('202'); const POI3 = id('203'); const POI4 = id('204');
const FI = id('301'); const SI = id('302');
const FI_CHEM = id('401'); const FI_FEE = id('402'); const SI_ITEM = id('403');
const QUOTE = id('501'); const QSEC = id('511'); const QI = id('512'); const QV = id('601');
const ORDER = id('701'); const OI = id('702');
const TODAY = "to_char(CURRENT_DATE, 'YYYY-MM-DD')";

const SNAPSHOT = {
  quote: { quote_number: 'PROVER-Q-1', total_price: 100, total_cost: 60, total_profit: 40, total_margin_pct: 40 },
  sections: [{ name: 'S1', items: [{ product_name: '[PROVER] Chem', quantity: 2, unit_price: 30, current_cost: 22.5, profit: 7.5, net_margin: 25 }] }],
  totals: { totalCost: 60, totalPrice: 100 },
};
// Written out by hand (not derived by code): every cost/profit/margin value NULL, keys kept.
const SNAPSHOT_FOR_REP = {
  quote: { quote_number: 'PROVER-Q-1', total_price: 100, total_cost: null, total_profit: null, total_margin_pct: null },
  sections: [{ name: 'S1', items: [{ product_name: '[PROVER] Chem', quantity: 2, unit_price: 30, current_cost: null, profit: null, net_margin: null }] }],
  totals: { totalCost: null, totalPrice: 100 },
};
const j = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function seed() {
  const users = [
    [U.ADMIN, 'admin', 'Admin', 9], [U.REP, 'sales_rep', 'Rep', 8], [U.DRIVER, 'driver', 'Driver', 6],
    [U.APPLICATOR, 'applicator', 'Applicator', 5], [U.ADMIN_OFF, 'admin', 'Deactivated Admin', 3],
  ];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'cost-step2-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    ${claims(U.ADMIN)}
    UPDATE public.profiles SET is_active = false WHERE id = '${U.ADMIN_OFF}';
    INSERT INTO public.customers (id, farm_name, is_active, email) VALUES ('${CUST}', '[PROVER] Cost Farm', true, 'c1@example.invalid');
    INSERT INTO public.fields (id, customer_id, field_name, total_acres) VALUES ('${FIELD}', '${CUST}', '[PROVER] Field', 100);
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, product_form, is_active) VALUES
      ('${PROD}', '[PROVER] Chem', 'gal', 22.50, 30.00, 'liquid', true),
      ('${PROD_B}', '[PROVER] Chem B', 'gal', 7.25, 12.00, 'liquid', true),
      ('${PROD_C}', '[PROVER] Chem C', 'gal', 8.00, 12.00, 'liquid', true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.purchase_orders (id, po_number, vendor, status, submitted_date, created_by) VALUES
      ('${PO1}', 'PROVER-PO-1', 'Acme', 'submitted', CURRENT_DATE - 2, '${U.ADMIN}'),
      ('${PO2}', 'PROVER-PO-2', 'Acme', 'submitted', CURRENT_DATE - 1, '${U.ADMIN}'),
      ('${PO3}', 'PROVER-PO-3', 'Beta', 'submitted', CURRENT_DATE - 1, '${U.ADMIN}');
    INSERT INTO public.purchase_order_items (id, purchase_order_id, product_id, quantity_ordered, unit_cost, quantity_received, unit_size, product_name) VALUES
      ('${POI1}', '${PO1}', '${PROD}', 5, 10.00, 0, 'gal', '[PROVER] Chem'),
      ('${POI2}', '${PO2}', '${PROD}', 5, 12.00, 0, 'gal', '[PROVER] Chem'),
      ('${POI3}', '${PO3}', '${PROD_C}', 5, 0, 0, 'gal', '[PROVER] Chem C'),
      ('${POI4}', '${PO3}', '${PROD_C}', 5, 8.00, 0, 'gal', '[PROVER] Chem C');
    UPDATE public.purchase_orders SET total_cost = 40.00 WHERE id = '${PO3}';
    INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, created_by) VALUES
      ('${FI}', 'PROVER-FI-1', '${CUST}', 'field_application', 'draft', CURRENT_DATE, '${U.ADMIN}'),
      ('${SI}', 'PROVER-SI-1', '${CUST}', 'chemical_sale', 'draft', CURRENT_DATE, '${U.ADMIN}');
    INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order, is_application_fee) VALUES
      ('${FI_CHEM}', '${FI}', '${PROD}', '[PROVER] Chem', 10, 3000, 30000, 1999, 0, false),
      ('${FI_FEE}', '${FI}', NULL, 'Application fee', 10, 1500, 15000, 5000, 1, true),
      ('${SI_ITEM}', '${SI}', '${PROD}', '[PROVER] Chem', 2, 3000, 6000, 1111, 0, false);
    INSERT INTO public.quotes (id, quote_number, customer_id, created_by, status, total_price, total_cost, total_profit, total_margin_pct)
      VALUES ('${QUOTE}', 'PROVER-Q-1', '${CUST}', '${U.ADMIN}', 'draft', 100, 60, 40, 40);
    INSERT INTO public.quote_sections (id, quote_id, section_name, sort_order) VALUES ('${QSEC}', '${QUOTE}', 'S1', 0);
    INSERT INTO public.quote_items (id, quote_id, section_id, product_id, price_per_unit, current_cost, total_units_needed, unit_size, total_price, sort_order)
      VALUES ('${QI}', '${QUOTE}', '${QSEC}', '${PROD}', 30.00, 22.50, 2, 'gal', 60.00, 0);
    INSERT INTO public.quote_versions (id, quote_id, version_number, sent_by, snapshot_data) VALUES ('${QV}', '${QUOTE}', 1, '${U.ADMIN}', ${j(SNAPSHOT)});
    SELECT set_config('app.crx_below_cost_operation', 'create_direct_order', true);
    INSERT INTO public.orders (id, order_number, customer_id, status, order_date) VALUES ('${ORDER}', 'PROVER-ORD-1', '${CUST}', 'confirmed', CURRENT_DATE);
    INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, price_per_unit, total_units_needed, total_price, cost_per_unit)
      VALUES ('${OI}', '${ORDER}', '${PROD}', '[PROVER] Chem', 'gal', 30.00, 2, 60.00, 22.50);
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7c200000-%';`),
    'admin:true,sales_rep:true,driver:true,applicator:true,admin:false', 'the seeded roles are not what the proof needs');
  assert.equal(scalar(`SELECT string_agg(unit_cost_cents::text, ',' ORDER BY id) FROM public.purchase_order_items WHERE purchase_order_id IN ('${PO1}', '${PO2}', '${PO3}');`), '1000,1200,0,800');
  assert.equal(scalar(`SELECT string_agg(cost_cents::text, ',' ORDER BY id) FROM public.invoice_items WHERE invoice_id IN ('${FI}', '${SI}');`), '1999,5000,1111');
  assert.equal(scalar(`SELECT current_cost FROM public.quote_items WHERE id = '${QI}';`), '22.50');
  assert.equal(scalar(`SELECT snapshot_data = ${j(SNAPSHOT)} FROM public.quote_versions WHERE id = '${QV}';`), 't');
  console.log('[prover] seeded admin / deactivated admin / sales rep / driver / applicator, one customer + field, three products, three POs, two invoices, one quote version, one order');
}

// ------------------------------------------------------------------------------------------------
// Probes: one transaction per scenario, always rolled back. Each step runs as a role (a signed-in
// PostgREST session: request.jwt.claims + SET LOCAL ROLE authenticated; 'anon'; or 'owner', the
// migration owner with the admin's JWT) inside its own sub-transaction, so a refused step leaves the
// scenario going. A step yields "ok|<value>" or "<sqlstate>|<message>".
function who(as) {
  if (as === 'owner') return `RESET ROLE;\n${claims(U.ADMIN)}`;
  if (as === 'anon') return `RESET ROLE;\nSELECT set_config('request.jwt.claims', '{"role":"anon"}', true);\nSELECT set_config('request.jwt.claim.sub', '', true);\nSET LOCAL ROLE anon;`;
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
  return out;
}

const DENIED = /^P0001\|Permission denied: requires admin role$/;
const NO_FN = (fn) => new RegExp(`^42501\\|permission denied for function ${fn}$`);
const MISSING_FN = /^42883\|function public\.\w+\(.*\) does not exist$/;
const ACF = (table, ids) => `public.get_admin_cost_fields('${table}', ARRAY[${ids.map((x) => `'${x}'`).join(', ')}]::uuid[])`;
const JOB = `(SELECT j.id FROM public.jobs j WHERE j.customer_id = '${CUST}')`;
const JOB_STORED = `(SELECT string_agg(jc.cost_per_unit_cents::text, ',' ORDER BY jc.sort_order) FROM public.job_chemicals jc WHERE jc.job_id = ${JOB}) || '|' || (SELECT j.total_cost_cents FROM public.jobs j WHERE j.id = ${JOB})`;
const jobChems = (ptCost, galCost) => j([
  { product_id: PROD, quantity: 10, unit: 'pt', rate_per_acre: 1, rate_unit: 'pt/ac', cost_per_unit_cents: ptCost, price_per_unit_cents: 400, sort_order: 0 },
  { product_id: PROD, quantity: 10, unit: 'gal', rate_per_acre: 1, rate_unit: 'gal/ac', cost_per_unit_cents: galCost, price_per_unit_cents: 3000, sort_order: 1 },
]);
const JOB_FIELDS = j([{ field_id: FIELD, acres_to_treat: 10, sort_order: 0 }]);
const saveJob = (jobId, actor, ptCost, galCost) => `public.save_job(${jobId}, jsonb_build_object('customer_id', '${CUST}', 'job_date', ${TODAY}), ${JOB_FIELDS}, ${jobChems(ptCost, galCost)}, '${actor}', NULL)->>'success'`;

const PO_VENDOR = '[PROVER] Vendor S4';
const PONEW = `(SELECT po.id FROM public.purchase_orders po WHERE po.vendor = '${PO_VENDOR}')`;
const PONEW_LINE = `(SELECT poi.id FROM public.purchase_order_items poi WHERE poi.purchase_order_id = ${PONEW})`;
const PO_STORED = `(SELECT poi.quantity_ordered::int || ':' || poi.unit_cost_cents FROM public.purchase_order_items poi WHERE poi.purchase_order_id = ${PONEW}) || '|' || (SELECT po.total_cost_cents FROM public.purchase_orders po WHERE po.id = ${PONEW})`;
// "<reply keys>|<does the reply mention cost anywhere>"
const poReply = (call) => `(SELECT (SELECT string_agg(k, ',' ORDER BY k) FROM jsonb_object_keys(r) k) || '|' || (r::text ~* 'cost') FROM (SELECT ${call} AS r) s)`;
const savePo = (poId, actor, line) => `public.save_purchase_order(${poId}, jsonb_build_object('vendor', '${PO_VENDOR}', 'status', 'draft'), jsonb_build_array(${line}), '${actor}', NULL)`;
const poLine = (extra) => `jsonb_build_object('product_id', '${PROD_C}', 'unit_size', 'gal'${extra})`;


// "<reply mentions unit_cost>|<is_no_return per allocation>|<unit_cost per allocation>"
const MATCH = `(SELECT (r::text LIKE '%unit_cost%') || '|' || (SELECT string_agg(COALESCE(a->>'is_no_return', '-'), ',' ORDER BY o) FROM jsonb_array_elements(r->0->'allocations') WITH ORDINALITY x(a, o))
  || '|' || (SELECT string_agg(COALESCE(a->>'unit_cost', '-'), ',' ORDER BY o) FROM jsonb_array_elements(r->0->'allocations') WITH ORDINALITY x(a, o))
  FROM (SELECT public.match_quick_receive_items(${j([{ product_id: PROD, quantity: 10 }])}, NULL) AS r) s)`;

// "<type>:<rows>:<rows with unit_price>:<rows with total_amount>:<max unit_price>" per type
const HISTORY = `(SELECT COALESCE(string_agg(t || ':' || n || ':' || np || ':' || nt || ':' || mp, ',' ORDER BY t), 'no rows') FROM (
  SELECT transaction_type t, count(*) n, count(unit_price) np, count(total_amount) nt, COALESCE(max(unit_price)::text, 'null') mp
    FROM public.get_chemical_history('${PROD}', '2000-01-01', '2100-01-01') GROUP BY 1) s)`;

const costList = (call, field) => `(SELECT string_agg(e->>'${field}', ',' ORDER BY o) FROM jsonb_array_elements(${call}) WITH ORDINALITY x(e, o))`;
const FIELD_APP_HELPER = (inv) => costList(`public._cost_step2_field_app_chemicals(${inv}, ${j([
  { product_id: PROD, sort_order: 0 }, { product_id: PROD_B, sort_order: 1 }, { product_name: 'Custom mix', sort_order: 2 },
])})`, 'cost_cents');
const INVOICE_HELPER_SALE = costList(`public._cost_step2_invoice_items(${j({ id: SI })}, ${j([{ product_id: PROD, sort_order: 0, quantity: 2, description: '[PROVER] Chem' }])})`, 'cost_cents');
const INVOICE_HELPER_FIELD = costList(`public._cost_step2_invoice_items(${j({ id: FI })}, ${j([
  { id: FI_CHEM, product_id: PROD, sort_order: 0, quantity: 10, description: '[PROVER] Chem' },
  { is_application_fee: true, description: 'Application fee', sort_order: 1, quantity: 20 },
  { product_id: PROD_B, sort_order: 2, quantity: 1, description: '[PROVER] Chem B' },
  { description: 'Misc', sort_order: 3, quantity: 1 },
])})`, 'cost_cents');

const ALL_TABLES = ['products', 'quotes', 'quote_items', 'orders', 'order_items', 'invoices', 'invoice_items', 'jobs', 'job_chemicals', 'purchase_orders', 'purchase_order_items', 'blend_ticket_products', 'commissions'];

/**
 * Scenarios. Each step: [key, as, call|{stmt}, before, after]. before/after: a RegExp, an exact
 * string, or null (not run in that phase: the function does not exist yet). 'same' = identical in
 * both phases.
 */
const SCENARIOS = [
  { name: '1. get_admin_cost_fields', steps: [
    ['admin products', U.ADMIN, `round((${ACF('products', [PROD])}->'${PROD}'->>'current_cost')::numeric, 2)`, MISSING_FN, 'ok|22.50'],
    ['admin quote_items', U.ADMIN, `round((${ACF('quote_items', [QI])}->'${QI}'->>'current_cost')::numeric, 2)`, MISSING_FN, 'ok|22.50'],
    ['admin quotes', U.ADMIN, `round((${ACF('quotes', [QUOTE])}->'${QUOTE}'->>'total_cost')::numeric, 2)`, MISSING_FN, 'ok|60.00'],
    ['admin order_items', U.ADMIN, `round((${ACF('order_items', [OI])}->'${OI}'->>'cost_per_unit')::numeric, 2)`, MISSING_FN, 'ok|22.50'],
    ['admin invoice_items', U.ADMIN, `(SELECT (r->'${FI_CHEM}'->>'cost_cents') || ',' || (r->'${SI_ITEM}'->>'cost_cents') FROM (SELECT ${ACF('invoice_items', [FI_CHEM, SI_ITEM])} AS r) s)`, MISSING_FN, 'ok|1999,1111'],
    ['admin purchase_order_items', U.ADMIN, `(SELECT (r->'${POI1}'->>'unit_cost_cents') || ',' || (r->'${POI2}'->>'unit_cost_cents') FROM (SELECT ${ACF('purchase_order_items', [POI1, POI2])} AS r) s)`, MISSING_FN, 'ok|1000,1200'],
    ['admin every allow-listed table runs', U.ADMIN, { stmt: `DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY[${ALL_TABLES.map((t) => `'${t}'`).join(', ')}] LOOP
        IF public.get_admin_cost_fields(t, ARRAY[gen_random_uuid()]) <> '{}'::jsonb THEN RAISE EXCEPTION 'non-empty for %', t; END IF; END LOOP; v := '${ALL_TABLES.length} tables'; END;` }, MISSING_FN, `ok|${ALL_TABLES.length} tables`],
    ['admin empty ids', U.ADMIN, `public.get_admin_cost_fields('products', ARRAY[]::uuid[])`, MISSING_FN, 'ok|{}'],
    ['admin 5000 ids', U.ADMIN, `public.get_admin_cost_fields('products', ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 5000)))`, MISSING_FN, 'ok|{}'],
    ['admin 5001 ids', U.ADMIN, `public.get_admin_cost_fields('products', ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 5001)))`, MISSING_FN, /^P0001\|COST_FIELDS_TOO_MANY_IDS: /],
    ['admin unknown table', U.ADMIN, `public.get_admin_cost_fields('profiles', ARRAY['${U.ADMIN}']::uuid[])`, MISSING_FN, /^P0001\|COST_FIELDS_UNKNOWN_TABLE: profiles$/],
    ['deactivated admin', U.ADMIN_OFF, ACF('products', [PROD]), MISSING_FN, DENIED],
    ['sales rep', U.REP, ACF('products', [PROD]), MISSING_FN, DENIED],
    ['driver', U.DRIVER, ACF('products', [PROD]), MISSING_FN, DENIED],
    ['applicator', U.APPLICATOR, ACF('products', [PROD]), MISSING_FN, DENIED],
    ['signed-out', 'anon', ACF('products', [PROD]), MISSING_FN, NO_FN('get_admin_cost_fields')],
  ] },
  { name: '2. get_quote_versions', steps: [
    ['rep snapshot is the cost-free one', U.REP, `(SELECT snapshot_data = ${j(SNAPSHOT_FOR_REP)} FROM public.get_quote_versions('${QUOTE}'))`, MISSING_FN, 'ok|true'],
    ['rep row', U.REP, `(SELECT count(*) || ':' || max(version_number) || ':' || (max(id::text) = '${QV}') FROM public.get_quote_versions('${QUOTE}'))`, MISSING_FN, 'ok|1:1:true'],
    ['admin snapshot is the stored one', U.ADMIN, `(SELECT snapshot_data = ${j(SNAPSHOT)} FROM public.get_quote_versions('${QUOTE}'))`, MISSING_FN, 'ok|true'],
    ['driver', U.DRIVER, `(SELECT count(*) FROM public.get_quote_versions('${QUOTE}'))`, MISSING_FN, /^42501\|INSUFFICIENT_ROLE$/],
    ['deactivated admin', U.ADMIN_OFF, `(SELECT count(*) FROM public.get_quote_versions('${QUOTE}'))`, MISSING_FN, /^42501\|INSUFFICIENT_ROLE$/],
    ['signed-out', 'anon', `(SELECT count(*) FROM public.get_quote_versions('${QUOTE}'))`, MISSING_FN, NO_FN('get_quote_versions')],
  ] },
  { name: '3. save_job', steps: [
    ['rep creates with cost 0 (pt + gal lines)', U.REP, saveJob('NULL', U.REP, 0, 0), 'ok|true', 'same'],
    ['stored after rep create', 'owner', JOB_STORED, 'ok|0,0|0', 'ok|281,2250|25310'],
    ['admin sets 300 / 2000', U.ADMIN, saveJob(JOB, U.ADMIN, 300, 2000), 'ok|true', 'same'],
    ['stored after admin save', 'owner', JOB_STORED, 'ok|300,2000|23000', 'same'],
    ['rep re-saves with cost 0', U.REP, saveJob(JOB, U.REP, 0, 0), 'ok|true', 'same'],
    ['stored after rep re-save', 'owner', JOB_STORED, 'ok|0,0|0', 'ok|300,2000|23000'],
    ['rep re-saves sending 999 / 999', U.REP, saveJob(JOB, U.REP, 999, 999), 'ok|true', 'same'],
    ['stored after rep 999', 'owner', JOB_STORED, 'ok|999,999|19980', 'ok|300,2000|23000'],
  ] },
  { name: '3b. save_job: admin create keeps the sent cost', steps: [
    ['admin creates with 123 / 4567', U.ADMIN, saveJob('NULL', U.ADMIN, 123, 4567), 'ok|true', 'same'],
    ['stored', 'owner', JOB_STORED, 'ok|123,4567|46900', 'same'],
  ] },
  { name: '4. save_purchase_order is unchanged (purchase orders are not part of step 2)', steps: [
    ['rep creates with unit_cost_cents 999', U.REP, poReply(savePo('NULL', U.REP, poLine(", 'quantity_ordered', 4, 'unit_cost_cents', 999"))), /^ok\|/, 'same'],
    ['stored after rep create', 'owner', PO_STORED, 'ok|4:999|3996', 'same'],
    ['rep edit sends unit_cost_cents 1500', U.REP, poReply(savePo(PONEW, U.REP, `${poLine(", 'quantity_ordered', 6, 'unit_cost_cents', 1500")} || jsonb_build_object('id', ${PONEW_LINE})`)), /^ok\|/, 'same'],
    ['stored after rep edit', 'owner', PO_STORED, 'ok|6:1500|9000', 'same'],
  ] },
  { name: '6. match_quick_receive_items', steps: [
    ['rep', U.REP, MATCH, 'ok|true|-,-|10.00,12.00', 'ok|false|true,false|-,-'],
    ['admin', U.ADMIN, MATCH, 'ok|true|-,-|10.00,12.00', 'ok|true|true,false|10.00,12.00'],
    ['driver', U.DRIVER, MATCH, /^P0001\|Not authorized$/, 'same'],
  ] },
  { name: '7. get_chemical_history', steps: [
    ['rep', U.REP, HISTORY, 'ok|Purchase:2:2:2:12.00,Sale:1:1:1:30.00', 'ok|Purchase:2:0:0:null,Sale:1:1:1:30.00'],
    ['admin', U.ADMIN, HISTORY, 'ok|Purchase:2:2:2:12.00,Sale:1:1:1:30.00', 'same'],
    ['driver', U.DRIVER, HISTORY, 'ok|no rows', 'same'],
    ['applicator', U.APPLICATOR, HISTORY, 'ok|no rows', 'same'],
    ['deactivated admin', U.ADMIN_OFF, HISTORY, 'ok|no rows', 'same'],
  ] },
  { name: '8. private rewrite helpers', steps: [
    ['field-app chemicals, existing field invoice', 'owner', FIELD_APP_HELPER(`'${FI}'::uuid`), MISSING_FN, 'ok|1999,725,0'],
    ['field-app chemicals, new invoice', 'owner', FIELD_APP_HELPER('NULL::uuid'), MISSING_FN, 'ok|2250,725,0'],
    // Sol 2026-10-20: a compact (no hyphens) or braced product id is still recognised, as the writer's ::uuid cast does.
    ['field-app chemicals, compact and braced product ids', 'owner', costList(`public._cost_step2_field_app_chemicals(NULL::uuid, ${j([
      { product_id: PROD.replace(/-/g, ''), sort_order: 0 }, { product_id: `{${PROD_B.toUpperCase()}}`, sort_order: 1 },
    ])})`, 'cost_cents'), MISSING_FN, 'ok|2250,725'],
    ['invoice items, sale invoice', 'owner', INVOICE_HELPER_SALE, MISSING_FN, 'ok|2250'],
    ['invoice items, field invoice', 'owner', INVOICE_HELPER_FIELD, MISSING_FN, 'ok|1999,10000,725,0'],
    ['rep calls the field-app helper', U.REP, FIELD_APP_HELPER('NULL::uuid'), MISSING_FN, NO_FN('_cost_step2_field_app_chemicals')],
    ['rep calls the invoice helper', U.REP, INVOICE_HELPER_SALE, MISSING_FN, NO_FN('_cost_step2_invoice_items')],
  ] },
];

function normalize(phase, step) {
  const [, , , before, after] = step;
  return phase === 'before' ? before : after;
}
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
function check(phase, results, baseline = null) {
  const failures = [];
  const lines = [];
  for (const sc of SCENARIOS) {
    for (const step of sc.steps) {
      const label = `${sc.name} / ${step[0]}`;
      let want = normalize(phase === 'before' ? 'before' : 'after', step);
      if (want === 'same') want = step[3];
      const got = results[label];
      const ok = want instanceof RegExp ? want.test(got) : got === want;
      if (!ok) failures.push(`${label}: got "${got}", expected ${want instanceof RegExp ? want : `"${want}"`}`);
      if (baseline && baseline[label] !== got) failures.push(`${label}: changed on re-apply from "${baseline[label]}" to "${got}"`);
      lines.push(`  ${ok ? 'PASS' : 'FAIL'} ${label} -> ${got}`);
    }
  }
  if (process.env.CRX_PROVER_VERBOSE === '1' || failures.length) console.log(lines.join('\n'));
  assert.deepEqual(failures, [], `${phase.toUpperCase()} failed:\n  ${failures.join('\n  ')}`);
  console.log(`[prover] ${phase.toUpperCase()}: all ${lines.length} steps as expected`);
}

// ------------------------------------------------------------------------------------------------
function grants() {
  const rows = docker([...psqlArgs(), '-A', '-t', '-F', '|'], { input: `SELECT p.oid::regprocedure,
      has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      has_function_privilege('service_role', p.oid, 'EXECUTE'), p.prosecdef
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND (p.proname LIKE '\\_%\\_cost\\_step2\\_impl' OR p.proname LIKE '\\_cost\\_step2\\_%'
          OR p.proname IN ('save_job', 'save_field_app_invoice', 'save_invoice', 'get_chemical_history',
                           'match_quick_receive_items', 'get_quote_versions', 'get_admin_cost_fields'))
    ORDER BY 1;` }).stdout.trim().split(/\r?\n/).map((l) => l.split('|'));
  const priv = rows.filter(([sig]) => sig.startsWith('_'));
  const pub = rows.filter(([sig]) => !sig.startsWith('_'));
  assert.equal(priv.length, 11, `expected 5 renamed impls + 6 helpers, got:\n${priv.map((r) => r[0]).join('\n')}`);
  for (const [sig, anon, auth, svc] of priv) assert.deepEqual([anon, auth, svc], ['f', 'f', 'f'], `${sig} is executable by an API role`);
  assert.equal(pub.length, 7, `expected seven public functions, got:\n${pub.map((r) => r[0]).join('\n')}`);
  for (const [sig, anon, auth, , secdef] of pub) assert.deepEqual([anon, auth, secdef], ['f', 't', 't'], `${sig}: anon must not, authenticated must execute, and it must be SECURITY DEFINER`);
  console.log(`[prover] GRANTS: ${priv.length} private impls/helpers executable by no API role (anon, authenticated, service_role); ${pub.length} public functions executable by authenticated, not anon`);
}

function preflightRefusesDrift(phase) {
  stageText('cand.sql', lf(CANDIDATE));
  const cases = phase === 'before' ? [
    ["CREATE OR REPLACE FUNCTION public.get_chemical_history(p_product_id uuid, p_start_date date, p_end_date date) RETURNS TABLE(transaction_date text, transaction_type text, reference_number text, customer_name text, quantity numeric, unit text, unit_price numeric, total_amount numeric, notes text) LANGUAGE plpgsql STABLE SET search_path TO 'public' AS $$ BEGIN RETURN; END; $$;",
      /COST_STEP2_PREFLIGHT: public\.get_chemical_history\(uuid,date,date\) is missing or drifted from its 2026-10-19 body/],
    ['CREATE OR REPLACE FUNCTION public.is_sales_rep() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN true; END; $$;',
      /COST_STEP2_PREFLIGHT: public\.is_sales_rep\(\) is missing or drifted/],
    ['CREATE FUNCTION public.save_job(p_x int) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
      /COST_STEP2_PREFLIGHT: expected exactly one public\.save_job overload/],
  ] : [
    ['CREATE OR REPLACE FUNCTION public._get_chemical_history_cost_step2_impl(p_product_id uuid, p_start_date date, p_end_date date) RETURNS TABLE(transaction_date text, transaction_type text, reference_number text, customer_name text, quantity numeric, unit text, unit_price numeric, total_amount numeric, notes text) LANGUAGE plpgsql STABLE AS $$ BEGIN RETURN; END; $$;',
      /COST_STEP2_PREFLIGHT: public\._get_chemical_history_cost_step2_impl exists but is not the pinned body/],
    ['CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN true; END; $$;',
      /COST_STEP2_PREFLIGHT: public\.is_admin\(\) is missing or drifted/],
  ];
  for (const [setup, refusal] of cases) {
    const d = docker([...psqlArgs()], { input: `BEGIN;\n${setup}\n\\i /tmp/cand.sql\nROLLBACK;`, allowFailure: true });
    assert.notEqual(d.status, 0, `the candidate applied over: ${setup}`);
    assert.match(d.stderr, refusal, `wrong refusal for ${setup}:\n${d.stderr}`);
  }
  console.log(`[prover] PREFLIGHT (${phase}): ${cases.length} drifted states each abort the candidate`);
}

/** Dev convenience only (REUSE): the header's ROLLBACK recipe, so a reused container is BEFORE again. */
function unapply() {
  psql(`BEGIN;
    DROP FUNCTION IF EXISTS public.get_admin_cost_fields(text, uuid[]);
    DROP FUNCTION IF EXISTS public.get_quote_versions(uuid);
    DROP FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text);
    ALTER FUNCTION public._save_job_cost_step2_impl(uuid, jsonb, jsonb, jsonb, uuid, text) RENAME TO save_job;
    DROP FUNCTION public.save_field_app_invoice(uuid, jsonb, jsonb, jsonb, uuid, uuid, text);
    ALTER FUNCTION public._save_field_app_invoice_cost_step2_impl(uuid, jsonb, jsonb, jsonb, uuid, uuid, text) RENAME TO save_field_app_invoice;
    DROP FUNCTION public.save_invoice(jsonb, jsonb, text);
    ALTER FUNCTION public._save_invoice_cost_step2_impl(jsonb, jsonb, text) RENAME TO save_invoice;
    DROP FUNCTION public.get_chemical_history(uuid, date, date);
    ALTER FUNCTION public._get_chemical_history_cost_step2_impl(uuid, date, date) RENAME TO get_chemical_history;
    DROP FUNCTION public.match_quick_receive_items(jsonb, text);
    ALTER FUNCTION public._match_quick_receive_items_cost_step2_impl(jsonb, text) RENAME TO match_quick_receive_items;
    GRANT EXECUTE ON FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text), public.save_field_app_invoice(uuid, jsonb, jsonb, jsonb, uuid, uuid, text),
      public.save_invoice(jsonb, jsonb, text), public.get_chemical_history(uuid, date, date),
      public.match_quick_receive_items(jsonb, text) TO authenticated, service_role;
    DROP FUNCTION public._cost_step2_job_chemicals(uuid, jsonb), public._cost_step2_field_app_chemicals(uuid, jsonb), public._cost_step2_invoice_items(jsonb, jsonb),
      public._cost_step2_snapshot_without_cost(jsonb), public._cost_step2_product_cost_cents(uuid), public._cost_step2_try_uuid(text);
    COMMIT;`);
  console.log('[prover] (reuse) un-applied the candidate with its ROLLBACK recipe');
}

function main() {
  const started = Date.now();
  if (!REUSE) buildContainer();
  else if (scalar("SELECT to_regproc('public._save_job_cost_step2_impl') IS NOT NULL;") === 't') unapply();
  fidelity();
  if (scalar("SELECT count(*) FROM public.profiles WHERE id::text LIKE '7c200000-%';") === '0') seed();

  const before = runMatrix('before');
  check('before', before);
  preflightRefusesDrift('before');

  stageText('candidate.sql', lf(CANDIDATE));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  console.log('[prover] candidate applied');

  const after = runMatrix('after');
  check('after', after);
  grants();
  preflightRefusesDrift('after');

  const again = apply('candidate.sql');
  assert.equal(again.status, 0, `re-applying the candidate failed:\n${again.output}`);
  check('after', runMatrix('re-apply'), after);
  grants();
  console.log('[prover] RE-APPLY: the candidate re-applies on top of itself and every result is unchanged');

  const MUTANT = 'CREATE OR REPLACE FUNCTION public.require_admin() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN END; $$;';
  const mutant = scenario([
    { key: 'rep, gate intact', as: U.REP, call: `${ACF('products', [PROD])}->'${PROD}'->>'current_cost'` },
  ]);
  assert.match(mutant['rep, gate intact'], DENIED);
  const mutated = scenario([
    { key: 'rep, require_admin emptied', as: U.REP, call: `${ACF('products', [PROD])}->'${PROD}'->>'current_cost'` },
  ], MUTANT);
  assert.equal(mutated['rep, require_admin emptied'], 'ok|22.50', `MUTATION: with require_admin() emptied the rep should read cost, got ${mutated['rep, require_admin emptied']}`);
  console.log('[prover] MUTATION: with require_admin() emptied a sales rep reads get_admin_cost_fields (22.50), so the refusal is the admin gate');

  console.log(`[prover] finished in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log('COST_MARGIN_SCREENS_STEP2_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
