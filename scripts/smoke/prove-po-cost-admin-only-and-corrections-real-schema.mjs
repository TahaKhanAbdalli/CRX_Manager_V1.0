#!/usr/bin/env node
/**
 * Full-chain proof for the 20261021140000 candidate: purchase-order cost is admin-only, with a cost
 * history and a governed correction of a received cost (Mason, 2026-10-20, Option B).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (cost
 * step 2, 20261019230000, included), checks every md5 pin in the candidate's preflight against the
 * replayed body, seeds one admin / deactivated admin / sales rep / driver, three products (one on the
 * supplier cost-basis rollout), purchase orders with open, received and cancelled lines and their
 * inventory, then runs one matrix BEFORE and AFTER the candidate. Each scenario is one transaction
 * that always rolls back; each step runs as a PostgREST session (request.jwt.claims + SET LOCAL ROLE
 * authenticated), a signed-out visitor (anon), the owner with the admin's JWT, or the bare owner.
 *   1. save_purchase_order as a rep: a sent cost is ignored; a new line takes the catalog cost and is
 *      flagged; an existing line keeps its cost; a product switch takes the new product's cost.
 *   2. save_purchase_order as an admin: the sent cost is stored and clears the flag; a received line
 *      still refuses a cost change (RECEIVED_PO_LINE_IMMUTABLE, unchanged).
 *   3. set_purchase_order_item_costs: admin-only (rep, driver, deactivated admin refused; anon cannot
 *      execute); key required; confirm; a received supplier-cost-basis line corrected with a reason
 *      (refused without one), quantity and inventory untouched, provenance manual, total follows;
 *      exact replay; key reuse refused; cancelled PO, foreign line, negative cents, duplicate ids.
 *   4. History: who/what/why rows; reps read nothing; no API role writes; append-only for the owner.
 *   5. The flag cannot be cleared except by the function; a rep's direct table write is refused.
 *   6. Grants; preflight drift refusals; a second apply is refused; MUTATIONS: require_admin()
 *      emptied lets a rep correct cost; the rep trigger dropped lets a rep's cost through.
 *
 * Run: node scripts/smoke/prove-po-cost-admin-only-and-corrections-real-schema.mjs   (needs Docker)
 * Prints PO_COST_ADMIN_ONLY_CORRECTIONS_PROOF_PASS on success. CRX_PROVER_VERBOSE=1 prints every step.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-po-cost-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1' || REUSE;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261021140000_po_cost_admin_only_and_corrections.sql');
// Applied after the candidate's phases: the purchase-order cost column lock (Mason, 2026-10-20).
const LOCK = path.join(MIGRATIONS, '20261021141000_po_cost_columns_admin_only.sql');
// The column lists the screens read (src/lib/costFields.ts), proven readable under the lock.
const COST_FIELDS = readFileSync(path.join(ROOT, 'src', 'lib', 'costFields.ts'), 'utf8');
const screenColumns = (name) => {
  const m = COST_FIELDS.match(new RegExp(`export const ${name} = '([^']+)'`));
  assert.ok(m, `${name} not found in src/lib/costFields.ts`);
  return m[1];
};
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
const TOUCHED = /(FUNCTION\s+(public\.)?"?(save_purchase_order|set_purchase_order_item_costs|capture_purchase_order_item_cost_snapshot|_save_purchase_order_\w+_impl|_section9_save_purchase_order_serialized|_purchase_order_item_unit_cost_cents|is_admin|require_admin|check_idempotency_intent|save_idempotency|_bind_replay_receipt_20261015|_replay_fingerprint_20261015|_cost_step2_try_uuid|_supplier_cost_basis_enabled_for_product)\b|purchase_order_items|purchase_order_item_cost_changes)/i;
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
  assert.ok(all.includes(LOCK), 'the column lock must be selected for post-baseline replay');
  for (const file of all.slice(at + 1)) {
    if (file === LOCK) continue;
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
  const all = [...sql.matchAll(/^\s*\('(public\.[a-z_0-9]+\([^']*\))', '([0-9a-f]{32})'\)/gm)].map((m) => [m[1], m[2]]);
  assert.equal(all.length, 13, 'the preflight pins thirteen bodies');
  return all;
}
function fidelity() {
  const all = pins();
  for (const [sig, pin] of all) {
    const got = scalar(`SELECT coalesce(md5(replace(prosrc, chr(13), '')), 'MISSING') FROM pg_proc WHERE oid = to_regprocedure('${sig}') UNION ALL SELECT 'MISSING' LIMIT 1;`);
    assert.equal(got, pin, `${sig} replayed with a body that differs from the live pin of 2026-10-20`);
  }
  console.log(`[prover] FIDELITY: all ${all.length} pinned bodies match the live pins of 2026-10-20`);
}

// ------------------------------------------------------------------------------------------------
// Fixtures (committed once; every probe rolls back).
const id = (n) => `7c300000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), ADMIN_OFF: id('a3'), REP: id('b1'), DRIVER: id('d1') };
const PROD = id('f1'); // current_cost 22.50 per gal
const PROD_B = id('f2'); // current_cost 7.25 per gal
const PROD_Z = id('f4'); // current_cost 9.00 per gal, on the supplier cost-basis rollout
const PO1 = id('101'); const PO2 = id('102'); const PO3 = id('103');
const POI1 = id('201'); const POI2 = id('202'); const POI3 = id('203'); const POI4 = id('204');
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
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'po-cost-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    ${claims(U.ADMIN)}
    UPDATE public.profiles SET is_active = false WHERE id = '${U.ADMIN_OFF}';
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, product_form, is_active) VALUES
      ('${PROD}', '[PROVER] Chem', 'gal', 22.50, 30.00, 'liquid', true),
      ('${PROD_B}', '[PROVER] Chem B', 'gal', 7.25, 12.00, 'liquid', true),
      ('${PROD_Z}', '[PROVER] Chem Z', 'gal', 9.00, 12.00, 'liquid', true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.product_cost_basis_rollout (product_id, rollout_scope) VALUES ('${PROD_Z}', 'wells_phase2_canary');
    INSERT INTO public.purchase_orders (id, po_number, vendor, status, submitted_date, created_by) VALUES
      ('${PO1}', 'PROVER-PO-1', 'Acme', 'submitted', CURRENT_DATE - 2, '${U.ADMIN}'),
      ('${PO2}', 'PROVER-PO-2', 'Acme', 'submitted', CURRENT_DATE - 1, '${U.ADMIN}'),
      ('${PO3}', 'PROVER-PO-3', 'Beta', 'submitted', CURRENT_DATE - 1, '${U.ADMIN}');
    INSERT INTO public.purchase_order_items (id, purchase_order_id, product_id, quantity_ordered, unit_cost, quantity_received, unit_size, product_name) VALUES
      ('${POI1}', '${PO1}', '${PROD}', 5, 10.00, 0, 'gal', '[PROVER] Chem'),
      ('${POI2}', '${PO2}', '${PROD_Z}', 10, 9.50, 5, 'gal', '[PROVER] Chem Z'),
      ('${POI3}', '${PO2}', '${PROD}', 4, 20.00, 0, 'gal', '[PROVER] Chem'),
      ('${POI4}', '${PO3}', '${PROD}', 1, 5.00, 0, 'gal', '[PROVER] Chem');
    UPDATE public.purchase_orders SET total_cost = 50.00 WHERE id = '${PO1}';
    UPDATE public.purchase_orders SET total_cost = 175.00, status = 'partially_received' WHERE id = '${PO2}';
    UPDATE public.purchase_orders SET total_cost = 5.00, status = 'cancelled' WHERE id = '${PO3}';
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_on_order, quantity_prebooked, unit_size)
      VALUES ('${PROD_Z}', 'Main Warehouse', 5, 5, 0, 'gal')
      ON CONFLICT (product_id, location) DO UPDATE SET quantity_available = 5;
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7c300000-%';`),
    'admin:true,sales_rep:true,driver:true,admin:false', 'the seeded roles are not what the proof needs');
  assert.equal(scalar(`SELECT string_agg(unit_cost_cents || ':' || quantity_received::int || ':' || COALESCE(cost_provenance, '-'), ',' ORDER BY id) FROM public.purchase_order_items WHERE purchase_order_id IN ('${PO1}', '${PO2}', '${PO3}');`),
    '1000:0:-,950:5:manual,2000:0:-,500:0:-');
  assert.equal(scalar(`SELECT string_agg(status || ':' || total_cost_cents, ',' ORDER BY id) FROM public.purchase_orders WHERE id IN ('${PO1}', '${PO2}', '${PO3}');`),
    'submitted:5000,partially_received:17500,cancelled:500');
  assert.equal(scalar(`SELECT public._supplier_cost_basis_enabled_for_product('${PROD_Z}')::text || public._supplier_cost_basis_enabled_for_product('${PROD}')::text;`), 'truefalse');
  console.log('[prover] seeded admin / deactivated admin / sales rep / driver, three products (one on the cost-basis rollout), an open PO, a partly received PO and a cancelled PO');
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
const MISSING_FN = /^42883\|function public\.set_purchase_order_item_costs\(.*\) does not exist$/;
const NO_TABLE = /^42P01\|relation "public\.purchase_order_item_cost_changes" does not exist$/;
const NO_COLUMN = /^42703\|column "cost_needs_review" .*does not exist$/;
const NO_WRITE = (table) => new RegExp(`^42501\\|permission denied for table ${table}$`);

const VENDOR = '[PROVER] PO cost vendor';
const NEWPO = `(SELECT po.id FROM public.purchase_orders po WHERE po.vendor = '${VENDOR}')`;
const NEWLINE = `(SELECT poi.id FROM public.purchase_order_items poi WHERE poi.purchase_order_id = ${NEWPO})`;
// "<qty>:<cents>:<flag or - before the column exists>"
const LINE = (poi) => `(SELECT poi.quantity_ordered::int || ':' || poi.unit_cost_cents || ':' || COALESCE(to_jsonb(poi)->>'cost_needs_review', '-') FROM public.purchase_order_items poi WHERE poi.id = ${poi})`;
const TOTAL = (po) => `(SELECT po.total_cost_cents::text FROM public.purchase_orders po WHERE po.id = ${po})`;
const STORED = (poi, po) => `${LINE(poi)} || '|' || ${TOTAL(po)}`;
// "<source>:<old>><new>:<reason>:<last two characters of changed_by>" in the order written
const HIST = (poi) => `(SELECT COALESCE(string_agg(h.source || ':' || COALESCE(h.old_unit_cost_cents::text, '-') || '>' || h.new_unit_cost_cents
  || ':' || COALESCE(h.reason, '-') || ':' || right(COALESCE(h.changed_by::text, 'none'), 2), ',' ORDER BY h.created_at, h.id), 'none')
  FROM public.purchase_order_item_cost_changes h WHERE h.purchase_order_item_id = ${poi})`;
const lineJson = (product, qty, extra = '') => `jsonb_build_object('product_id', '${product}', 'unit_size', 'gal', 'quantity_ordered', ${qty}${extra})`;
const createPo = (actor, line) => `public.save_purchase_order(NULL, jsonb_build_object('vendor', '${VENDOR}', 'status', 'draft'), jsonb_build_array(${line}), '${actor}', NULL)->>'status'`;
const editPo = (po, actor, lines) => `public.save_purchase_order('${po}', jsonb_build_object('vendor', 'Acme'), jsonb_build_array(${lines.join(', ')}), '${actor}', NULL)->>'status'`;
const withId = (line, poi) => `${line} || jsonb_build_object('id', '${poi}')`;
const setCosts = (actor, po, items, reason, key) => `(SELECT (r->>'lines_changed') || ':' || (r->>'lines_confirmed') FROM (SELECT public.set_purchase_order_item_costs(${po}, ${typeof items === 'string' ? items : j(items)}, ${reason === null ? 'NULL' : q(reason)}, '${actor}', ${key === null ? 'NULL' : q(key)}) AS r) s)`;
const REASON = 'Vendor invoice 4471 says $11.00';

/**
 * Scenarios. Each step: [key, as, call|{stmt}, before, after]. before/after: a RegExp, an exact
 * string, or 'same' (identical in both phases).
 */
const SCENARIOS = [
  { name: '1. save_purchase_order as a sales rep', steps: [
    ['rep creates a PO sending unit_cost_cents 999', U.REP, createPo(U.REP, lineJson(PROD, 4, ", 'unit_cost_cents', 999")), 'ok|saved', 'same'],
    ['stored: new line', 'owner', STORED(NEWLINE, NEWPO), 'ok|4:999:-|3996', 'ok|4:2250:true|9000'],
    ['history: new line', 'owner', HIST(NEWLINE), NO_TABLE, 'ok|catalog_default:->2250:-:b1'],
    ['rep edits an admin line: qty 6, sends unit_cost_cents 1', U.REP, editPo(PO1, U.REP, [withId(lineJson(PROD, 6, ", 'unit_cost_cents', 1"), POI1)]), 'ok|saved', 'same'],
    ['stored: admin line keeps its cost', 'owner', STORED(q(POI1), q(PO1)), 'ok|6:1:-|6', 'ok|6:1000:false|6000'],
    ['history: unchanged cost writes nothing', 'owner', HIST(q(POI1)), NO_TABLE, 'ok|none'],
    ['rep switches the line to another product, no cost keys', U.REP, editPo(PO1, U.REP, [withId(lineJson(PROD_B, 6), POI1)]), 'ok|saved', 'same'],
    ['stored: switched line takes the new catalog cost, flagged', 'owner', STORED(q(POI1), q(PO1)), 'ok|6:1:-|6', 'ok|6:725:true|4350'],
    ['admin saves the line at 800', U.ADMIN, editPo(PO1, U.ADMIN, [withId(lineJson(PROD_B, 6, ", 'unit_cost_cents', 800"), POI1)]), 'ok|saved', 'same'],
    ['stored: admin cost clears the flag', 'owner', STORED(q(POI1), q(PO1)), 'ok|6:800:-|4800', 'ok|6:800:false|4800'],
    ['history: rep switch then admin edit', 'owner', HIST(q(POI1)), NO_TABLE, 'ok|catalog_default:1000>725:-:b1,edited:725>800:-:a1'],
  ] },
  { name: '2. received lines through save_purchase_order', steps: [
    ['admin changes a received line cost', U.ADMIN, editPo(PO2, U.ADMIN, [withId(lineJson(PROD_Z, 10, ", 'unit_cost_cents', 1000"), POI2), withId(lineJson(PROD, 4, ", 'unit_cost_cents', 2000"), POI3)]),
      /^P0001\|RECEIVED_PO_LINE_IMMUTABLE: /, 'same'],
    ['rep re-saves the PO with no cost keys', U.REP, editPo(PO2, U.REP, [withId(lineJson(PROD_Z, 10), POI2), withId(lineJson(PROD, 4), POI3)]), 'ok|saved', 'same'],
    ['stored: both lines unchanged', 'owner', `${LINE(q(POI2))} || ',' || ${LINE(q(POI3))} || '|' || ${TOTAL(q(PO2))}`, 'ok|10:950:-,4:2000:-|17500', 'ok|10:950:false,4:2000:false|17500'],
    // No cost oracle: before, a wrong guess was refused and the right one saved; after, a rep's sent
    // cost is stripped, so a wrong and a right guess look the same and the stored cost never moves.
    ['rep sends a wrong cost guess on the received line', U.REP, editPo(PO2, U.REP, [withId(lineJson(PROD_Z, 10, ", 'unit_cost_cents', 1"), POI2), withId(lineJson(PROD, 4), POI3)]),
      /^P0001\|RECEIVED_PO_LINE_IMMUTABLE: /, 'ok|saved'],
    ['rep sends the right cost guess on the received line', U.REP, editPo(PO2, U.REP, [withId(lineJson(PROD_Z, 10, ", 'unit_cost_cents', 950"), POI2), withId(lineJson(PROD, 4), POI3)]),
      'ok|saved', 'ok|saved'],
    ['stored: guesses changed nothing', 'owner', `${LINE(q(POI2))} || '|' || ${TOTAL(q(PO2))}`, 'ok|10:950:-|17500', 'ok|10:950:false|17500'],
  ] },
  { name: '3a. set_purchase_order_item_costs: who may call it', steps: [
    ['rep', U.REP, setCosts(U.REP, q(PO2), [{ id: POI3, unit_cost_cents: 2100 }], null, 'k-rep'), MISSING_FN, DENIED],
    ['driver', U.DRIVER, setCosts(U.DRIVER, q(PO2), [{ id: POI3, unit_cost_cents: 2100 }], null, 'k-drv'), MISSING_FN, DENIED],
    ['deactivated admin', U.ADMIN_OFF, setCosts(U.ADMIN_OFF, q(PO2), [{ id: POI3, unit_cost_cents: 2100 }], null, 'k-off'), MISSING_FN, DENIED],
    ['signed-out', 'anon', setCosts(U.ADMIN, q(PO2), [{ id: POI3, unit_cost_cents: 2100 }], null, 'k-anon'), MISSING_FN, /^42501\|permission denied for function set_purchase_order_item_costs$/],
    ['admin naming another person', U.ADMIN, setCosts(U.REP, q(PO2), [{ id: POI3, unit_cost_cents: 2100 }], null, 'k-forge'), MISSING_FN, /^P0001\|ACTOR_MISMATCH/],
    ['admin, no key', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI3, unit_cost_cents: 2100 }], null, null), MISSING_FN, /^22023\|IDEMPOTENCY_KEY_REQUIRED/],
    ['stored: nothing changed', 'owner', `${LINE(q(POI3))} || '|' || ${TOTAL(q(PO2))}`, 'ok|4:2000:-|17500', 'ok|4:2000:false|17500'],
  ] },
  { name: '3b. correcting a received cost-basis line', steps: [
    ['no reason', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI2, unit_cost_cents: 1100 }], null, 'k0'), MISSING_FN, /^P0001\|PO_COST_REASON_REQUIRED: /],
    ['blank reason', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI2, unit_cost_cents: 1100 }], '   ', 'k0b'), MISSING_FN, /^P0001\|PO_COST_REASON_REQUIRED: /],
    ['with a reason', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI2, unit_cost_cents: 1100 }], REASON, 'k1'), MISSING_FN, 'ok|1:0'],
    ['stored: cost, total', 'owner', `${LINE(q(POI2))} || '|' || ${TOTAL(q(PO2))}`, 'ok|10:950:-|17500', 'ok|10:1100:false|19000'],
    ['stored: received quantity, provenance, supplier ids, snapshot', 'owner', `(SELECT quantity_received::int || ':' || COALESCE(cost_provenance, '-') || ':' || (supplier_price_observation_id IS NULL) || ':' || COALESCE(inventory_units_per_supplier_unit_snapshot::int::text, '-') FROM public.purchase_order_items WHERE id = '${POI2}')`,
      'ok|5:manual:true:1', 'same'],
    ['inventory untouched', 'owner', `(SELECT quantity_available::int || ':' || quantity_on_order::int FROM public.inventory WHERE product_id = '${PROD_Z}')`, 'ok|5:5', 'same'],
    ['history', U.ADMIN, HIST(q(POI2)), NO_TABLE, `ok|set_by_admin:950>1100:${REASON}:a1`],
    ['activity feed carries no amount', 'owner', `(SELECT string_agg(description, ',') FROM public.activity_feed WHERE related_entity_id = '${PO2}' AND description LIKE '%unit cost%')`, 'ok|<null>', 'ok|PO PROVER-PO-2 unit cost changed'],
    ['exact replay', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI2, unit_cost_cents: 1100 }], REASON, 'k1'), MISSING_FN, 'ok|1:0'],
    ['history: replay wrote nothing', 'owner', `(SELECT count(*)::text FROM public.purchase_order_item_cost_changes WHERE purchase_order_item_id = '${POI2}')`, NO_TABLE, 'ok|1'],
    ['same key, other request', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI2, unit_cost_cents: 1200 }], REASON, 'k1'), MISSING_FN, /^22023\|IDEMPOTENCY_INTENT_MISMATCH$/],
    ['an open line needs no reason', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI3, unit_cost_cents: 2100 }], null, 'k3'), MISSING_FN, 'ok|1:0'],
    ['stored after both', 'owner', `${LINE(q(POI2))} || ',' || ${LINE(q(POI3))} || '|' || ${TOTAL(q(PO2))}`, 'ok|10:950:-,4:2000:-|17500', 'ok|10:1100:false,4:2100:false|19400'],
    ['history: open line', 'owner', HIST(q(POI3)), NO_TABLE, 'ok|set_by_admin:2000>2100:-:a1'],
    ['save_purchase_order still refuses the received line', U.ADMIN, editPo(PO2, U.ADMIN, [withId(lineJson(PROD_Z, 10, ", 'unit_cost_cents', 1300"), POI2), withId(lineJson(PROD, 4, ", 'unit_cost_cents', 2100"), POI3)]),
      /^P0001\|RECEIVED_PO_LINE_IMMUTABLE: /, 'same'],
  ] },
  { name: '3c. confirm a rep line; refusals', steps: [
    ['rep creates a PO', U.REP, createPo(U.REP, lineJson(PROD, 4)), 'ok|saved', 'same'],
    ['admin confirms the catalog cost', U.ADMIN, setCosts(U.ADMIN, NEWPO, `jsonb_build_array(jsonb_build_object('id', ${NEWLINE}, 'unit_cost_cents', 2250))`, null, 'k2'), MISSING_FN, 'ok|0:1'],
    ['stored: confirmed', 'owner', STORED(NEWLINE, NEWPO), 'ok|4:0:-|0', 'ok|4:2250:false|9000'],
    ['history: default then confirm', 'owner', HIST(NEWLINE), NO_TABLE, 'ok|catalog_default:->2250:-:b1,confirmed:2250>2250:-:a1'],
    ['same cost on a confirmed line changes nothing', U.ADMIN, setCosts(U.ADMIN, NEWPO, `jsonb_build_array(jsonb_build_object('id', ${NEWLINE}, 'unit_cost_cents', 2250))`, null, 'k2b'), MISSING_FN, 'ok|0:0'],
    ['cost-basis evidence cites the received line (fixture)', 'owner', { stmt: `SET LOCAL session_replication_role = replica;
        INSERT INTO public.product_cost_basis (product_id, basis_type, cost_cents, purchase_order_item_id, selection_source, reason)
          VALUES ('${PROD_Z}', 'actual_purchase', 950, '${POI2}', 'migration_baseline', '[PROVER] evidence');
        SET LOCAL session_replication_role = origin; v := 'cited';` }, 'ok|cited', 'same'],
    ['correcting a line that evidence cites is refused', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI2, unit_cost_cents: 1100 }], REASON, 'k-evidence'), MISSING_FN, /^P0001\|PO_COST_BASIS_EVIDENCE_IN_USE: /],
    ['stored: the cited line is unchanged', 'owner', LINE(q(POI2)), 'ok|10:950:-', 'ok|10:950:false'],
    ['cancelled PO', U.ADMIN,setCosts(U.ADMIN, q(PO3), [{ id: POI4, unit_cost_cents: 600 }], 'fix', 'k4'), MISSING_FN, /^P0001\|PO_CANCELLED: /],
    ['a line of another PO', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI1, unit_cost_cents: 600 }], 'fix', 'k5'), MISSING_FN, /^P0001\|PO_ITEM_ID_NOT_IN_PURCHASE_ORDER$/],
    ['fractional cents are refused by name', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI3, unit_cost_cents: 2100.5 }], 'fix', 'k6e'), MISSING_FN, /^22003\|PO_UNIT_COST_FRACTIONAL_CENT: /],
    ['negative cents', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI3, unit_cost_cents: -1 }], 'fix', 'k6'), MISSING_FN, /^22003\|PO_UNIT_COST_NEGATIVE: /],
    ['a null cost is refused, not read as $0', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI3, unit_cost_cents: null }], 'fix', 'k6c'), MISSING_FN, /^P0001\|PO_UNIT_COST_REQUIRED$/],
    ['a blank cost is refused, not read as $0', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI3, unit_cost_cents: '' }], 'fix', 'k6d'), MISSING_FN, /^P0001\|PO_UNIT_COST_REQUIRED$/],
    ['dollars only is refused',U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI3, unit_cost: 21 }], 'fix', 'k6b'), MISSING_FN, /^P0001\|PO_UNIT_COST_REQUIRED$/],
    ['the same line twice, differing in case', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI3, unit_cost_cents: 2100 }, { id: POI3.toUpperCase(), unit_cost_cents: 2200 }], 'fix', 'k7'), MISSING_FN, /^P0001\|PO_ITEM_ID_DUPLICATE: /],
    ['no lines', U.ADMIN, setCosts(U.ADMIN, q(PO2), [], 'fix', 'k8'), MISSING_FN, /^P0001\|PO_ITEMS_REQUIRED$/],
    ['reason over 500 characters', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI3, unit_cost_cents: 2100 }], 'x'.repeat(501), 'k9'), MISSING_FN, /^P0001\|PO_COST_REASON_TOO_LONG: /],
  ] },
  { name: '3d. the vendor-bill control', steps: [
    ['a $175.00 active vendor bill on PO 2 (fixture)', 'owner', { stmt: `SET LOCAL session_replication_role = replica;
        INSERT INTO public.vendors (id, name) VALUES ('${id('301')}', '[PROVER] bill vendor');
        INSERT INTO public.vendor_bills (vendor_id, purchase_order_id, bill_number, bill_date, due_date, subtotal_cents, total_cents)
          VALUES ('${id('301')}', '${PO2}', 'PROVER-BILL-1', CURRENT_DATE, CURRENT_DATE + 30, 17500, 17500);
        SET LOCAL session_replication_role = origin; v := 'billed';` }, 'ok|billed', 'same'],
    ['lowering the total below the bill by more than 5 percent is refused', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI3, unit_cost_cents: 1000 }], null, 'k-bill1'), MISSING_FN, /^22023\|PO_COST_BELOW_BILLED: /],
    ['stored: unchanged', 'owner', `${LINE(q(POI3))} || '|' || ${TOTAL(q(PO2))}`, 'ok|4:2000:-|17500', 'ok|4:2000:false|17500'],
    ['lowering to within 5 percent of the bill is allowed', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI3, unit_cost_cents: 1900 }], null, 'k-bill2'), MISSING_FN, 'ok|1:0'],
    ['raising the total is allowed', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI3, unit_cost_cents: 2500 }], null, 'k-bill3'), MISSING_FN, 'ok|1:0'],
    ['stored: after both', 'owner', `${LINE(q(POI3))} || '|' || ${TOTAL(q(PO2))}`, 'ok|4:2000:-|17500', 'ok|4:2500:false|19500'],
  ] },
  { name: '4. the cost history table', steps: [
    ['admin writes one row', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI3, unit_cost_cents: 2100 }], null, 'k10'), MISSING_FN, 'ok|1:0'],
    ['rep reads it', U.REP, '(SELECT count(*) FROM public.purchase_order_item_cost_changes)', NO_TABLE, 'ok|0'],
    ['driver reads it', U.DRIVER, '(SELECT count(*) FROM public.purchase_order_item_cost_changes)', NO_TABLE, 'ok|0'],
    ['admin reads it', U.ADMIN, '(SELECT count(*) FROM public.purchase_order_item_cost_changes)', NO_TABLE, 'ok|1'],
    ['signed-out reads it', 'anon', '(SELECT count(*) FROM public.purchase_order_item_cost_changes)', NO_TABLE, NO_WRITE('purchase_order_item_cost_changes')],
    ['rep inserts', U.REP, { stmt: `INSERT INTO public.purchase_order_item_cost_changes (purchase_order_id, purchase_order_item_id, new_unit_cost_cents, source) VALUES ('${PO2}', '${POI3}', 1, 'edited'); v := 'inserted';` }, NO_TABLE, NO_WRITE('purchase_order_item_cost_changes')],
    ['admin inserts', U.ADMIN, { stmt: `INSERT INTO public.purchase_order_item_cost_changes (purchase_order_id, purchase_order_item_id, new_unit_cost_cents, source) VALUES ('${PO2}', '${POI3}', 1, 'edited'); v := 'inserted';` }, NO_TABLE, NO_WRITE('purchase_order_item_cost_changes')],
    ['admin updates', U.ADMIN, { stmt: 'UPDATE public.purchase_order_item_cost_changes SET reason = \'x\'; v := \'updated\';' }, NO_TABLE, NO_WRITE('purchase_order_item_cost_changes')],
    ['admin deletes', U.ADMIN, { stmt: 'DELETE FROM public.purchase_order_item_cost_changes; v := \'deleted\';' }, NO_TABLE, NO_WRITE('purchase_order_item_cost_changes')],
    ['owner updates', 'owner', { stmt: 'UPDATE public.purchase_order_item_cost_changes SET reason = \'x\'; v := \'updated\';' }, NO_TABLE, /^P0001\|PO_COST_HISTORY_APPEND_ONLY: /],
    ['owner deletes', 'owner', { stmt: 'DELETE FROM public.purchase_order_item_cost_changes; v := \'deleted\';' }, NO_TABLE, /^P0001\|PO_COST_HISTORY_APPEND_ONLY: /],
    ['owner truncates', 'owner', { stmt: 'TRUNCATE public.purchase_order_item_cost_changes; v := \'truncated\';' }, NO_TABLE, /^P0001\|PO_COST_HISTORY_APPEND_ONLY: /],
    ['an admin change to a received line without a reason cannot be stored', 'owner', { stmt: `INSERT INTO public.purchase_order_item_cost_changes (purchase_order_id, purchase_order_item_id, new_unit_cost_cents, source, quantity_received_at_change) VALUES ('${PO2}', '${POI2}', 1, 'set_by_admin', 5); v := 'inserted';` },
      NO_TABLE, /^23514\|new row for relation "purchase_order_item_cost_changes" violates check constraint "po_item_cost_changes_received_reason"$/],
  ] },
  { name: '5. the review flag', steps: [
    ['rep creates a PO', U.REP, createPo(U.REP, lineJson(PROD, 2)), 'ok|saved', 'same'],
    ['owner (admin JWT) clears the flag directly', 'owner', { stmt: `UPDATE public.purchase_order_items SET cost_needs_review = false WHERE id = ${NEWLINE}; v := 'updated';` }, NO_COLUMN, 'ok|updated'],
    ['bare owner clears the flag directly', 'bare', { stmt: `UPDATE public.purchase_order_items SET cost_needs_review = false WHERE id = ${NEWLINE}; v := 'updated';` }, NO_COLUMN, 'ok|updated'],
    ['flag is still set', 'owner', LINE(NEWLINE), 'ok|2:0:-', 'ok|2:2250:true'],
    ['owner (admin JWT) changes only the unit', 'owner', { stmt: `UPDATE public.purchase_order_items SET unit_size = 'qt' WHERE id = ${NEWLINE}; v := 'updated';` }, 'ok|updated', 'same'],
    ['a unit change keeps the line unconfirmed, with no silent confirm', 'owner', `${LINE(NEWLINE)} || '|' || (SELECT count(*) FROM public.purchase_order_items poi JOIN public.purchase_order_item_cost_changes c ON c.purchase_order_item_id = poi.id WHERE poi.id = ${NEWLINE} AND c.source = 'confirmed')`,
      NO_TABLE, 'ok|2:2250:true|0'],
    ['rep writes the line directly', U.REP, { stmt: `UPDATE public.purchase_order_items SET unit_cost = 1 WHERE id = '${POI3}'; v := 'updated';` }, NO_WRITE('purchase_order_items'), 'same'],
    ['admin writes the line directly', U.ADMIN, { stmt: `UPDATE public.purchase_order_items SET unit_cost = 1 WHERE id = '${POI3}'; v := 'updated';` }, NO_WRITE('purchase_order_items'), 'same'],
    ['bare owner inserts a line (a migration): stored as given, not flagged', 'bare', { stmt: `INSERT INTO public.purchase_order_items (purchase_order_id, product_id, quantity_ordered, unit_cost, quantity_received, unit_size) VALUES ('${PO1}', '${PROD}', 1, 3.33, 0, 'gal'); v := 'inserted';` }, 'ok|inserted', 'same'],
    ['stored: owner line', 'owner', `(SELECT unit_cost_cents || ':' || COALESCE(to_jsonb(poi)->>'cost_needs_review', '-') FROM public.purchase_order_items poi WHERE purchase_order_id = '${PO1}' AND unit_cost_cents = 333)`, 'ok|333:-', 'ok|333:false'],
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
     AND p.proname IN ('set_purchase_order_item_costs', '_po_item_rep_cost', '_po_item_cost_change_log', '_po_item_cost_changes_append_only')
    ORDER BY 1;` }).stdout.trim().split(/\r?\n/).map((l) => l.split('|'));
  assert.deepEqual(fns.map((r) => r[0]).sort(), ['_po_item_cost_change_log()', '_po_item_cost_changes_append_only()', '_po_item_rep_cost()', 'set_purchase_order_item_costs(uuid,jsonb,text,uuid,text)']);
  for (const [sig, anon, auth, svc, , cfg] of fns) {
    if (sig.startsWith('set_')) assert.deepEqual([anon, auth, svc], ['f', 't', 'f'], `${sig}: only authenticated may execute`);
    else assert.deepEqual([anon, auth, svc], ['f', 'f', 'f'], `${sig} is executable by an API role`);
    assert.equal(cfg, 'search_path=public, pg_temp', `${sig} must pin search_path`);
  }
  const table = scalar(`SELECT string_agg(r || ':' || p || ':' || has_table_privilege(r, 'public.purchase_order_item_cost_changes', p), ',' ORDER BY r, p)
    FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p;`);
  assert.equal(table, 'anon:DELETE:false,anon:INSERT:false,anon:SELECT:false,anon:TRUNCATE:false,anon:UPDATE:false,'
    + 'authenticated:DELETE:false,authenticated:INSERT:false,authenticated:SELECT:true,authenticated:TRUNCATE:false,authenticated:UPDATE:false,'
    + 'service_role:DELETE:false,service_role:INSERT:false,service_role:SELECT:false,service_role:TRUNCATE:false,service_role:UPDATE:false');
  assert.equal(scalar("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.purchase_order_item_cost_changes'::regclass;"), 't');
  console.log('[prover] GRANTS: set_purchase_order_item_costs executable by authenticated only; the three trigger functions by no API role; the history table readable (RLS) by authenticated only, writable by no API role');
}

function preflightRefusesDrift(phase) {
  stageText('cand.sql', lf(CANDIDATE));
  const cases = phase === 'before' ? [
    ["CREATE OR REPLACE FUNCTION public._save_purchase_order_cost_input_impl(p_po_id uuid, p_po_payload jsonb, p_items jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN NULL; END; $$;",
      /PO_COST_PREFLIGHT: public\._save_purchase_order_cost_input_impl\(uuid,jsonb,jsonb,uuid,text\) changed since 2026-10-20/],
    ['CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN true; END; $$;',
      /PO_COST_PREFLIGHT: public\.is_admin\(\) changed since 2026-10-20/],
    ['CREATE TRIGGER zz_extra AFTER UPDATE ON public.purchase_order_items FOR EACH ROW EXECUTE FUNCTION public.trg_po_items_recompute_on_order();',
      /PO_COST_PREFLIGHT: the triggers on purchase_order_items changed since 2026-10-20/],
    ['CREATE TABLE public.purchase_order_item_cost_changes (id int);',
      /PO_COST_PREFLIGHT: an object this migration creates already exists/],
  ] : [
    ['SELECT 1;', /PO_COST_PREFLIGHT: /],
  ];
  for (const [setup, refusal] of cases) {
    const d = docker([...psqlArgs()], { input: `BEGIN;\n${setup}\n\\i /tmp/cand.sql\nROLLBACK;`, allowFailure: true });
    assert.notEqual(d.status, 0, `the candidate applied over: ${setup}`);
    assert.match(d.stderr, refusal, `wrong refusal for ${setup}:\n${d.stderr}`);
  }
  console.log(`[prover] PREFLIGHT (${phase}): ${cases.length} drifted state(s) each abort the candidate${phase === 'after' ? ' (a second apply is refused)' : ''}`);
}

// ------------------------------------------------------------------------------------------------
// 7. The column lock (20261021141000): no API role reads a cost column, every screen's columns still
// read, admins read cost through get_admin_cost_fields, the writers still work.
function lockPhase() {
  const COLUMN_DENIED = (table) => new RegExp(`^42501\\|permission denied for table ${table}$`);
  const POI_COLS = screenColumns('PURCHASE_ORDER_ITEM_COLUMNS');
  const PO_COLS = screenColumns('PURCHASE_ORDER_COLUMNS');
  const steps = [];
  for (const [label, as] of [['rep', U.REP], ['admin', U.ADMIN], ['signed-out', 'anon']]) {
    for (const [table, col] of [['purchase_order_items', 'unit_cost'], ['purchase_order_items', 'unit_cost_cents'], ['purchase_orders', 'total_cost'], ['purchase_orders', 'total_cost_cents']]) {
      steps.push([`${label} reads ${table}.${col}`, as, `(SELECT string_agg(${col}::text, ',') FROM public.${table})`, COLUMN_DENIED(table)]);
    }
    steps.push([`${label} reads whole line rows`, as, '(SELECT count(*) FROM (SELECT poi.* FROM public.purchase_order_items poi) s)', COLUMN_DENIED('purchase_order_items')]);
    steps.push([`${label} reads whole PO rows`, as, '(SELECT count(*) FROM (SELECT po.* FROM public.purchase_orders po) s)', COLUMN_DENIED('purchase_orders')]);
  }
  const visible = { rep: 'ok|4', admin: 'ok|4', 'signed-out': 'ok|0' };
  for (const [label, as] of [['rep', U.REP], ['admin', U.ADMIN], ['signed-out', 'anon']]) {
    steps.push([`${label} reads the line screen columns`, as, `(SELECT count(*) FROM (SELECT ${POI_COLS} FROM public.purchase_order_items) s)`, visible[label]]);
    steps.push([`${label} reads the PO screen columns`, as, `(SELECT count(*) FROM (SELECT ${PO_COLS} FROM public.purchase_orders) s)`, label === 'signed-out' ? 'ok|0' : 'ok|3']);
  }
  steps.push(
    ['admin reads line cost through get_admin_cost_fields', U.ADMIN, `public.get_admin_cost_fields('purchase_order_items', ARRAY['${POI2}']::uuid[]) -> '${POI2}' ->> 'unit_cost_cents'`, 'ok|950'],
    ['admin reads PO total through get_admin_cost_fields', U.ADMIN, `public.get_admin_cost_fields('purchase_orders', ARRAY['${PO2}']::uuid[]) -> '${PO2}' ->> 'total_cost_cents'`, 'ok|17500'],
    ['rep is refused get_admin_cost_fields', U.REP, `public.get_admin_cost_fields('purchase_order_items', ARRAY['${POI2}']::uuid[])::text`, DENIED],
    ['rep still creates a PO', U.REP, createPo(U.REP, lineJson(PROD, 4)), 'ok|saved'],
    ['stored: rep line has the catalog cost, flagged', 'owner', LINE(NEWLINE), 'ok|4:2250:true'],
    ['admin still sets a cost', U.ADMIN, setCosts(U.ADMIN, q(PO2), [{ id: POI3, unit_cost_cents: 2100 }], null, 'k-lock'), 'ok|1:0'],
  );
  const res = scenario(steps.map(([key, as, call]) => ({ key, as, call })));
  const failures = [];
  for (const [key, , , want] of steps) {
    const got = res[key];
    const ok = want instanceof RegExp ? want.test(got) : got === want;
    if (!ok) failures.push(`${key}: got "${got}", expected ${want}`);
  }
  assert.deepEqual(failures, [], `LOCKED failed:\n  ${failures.join('\n  ')}`);
  console.log(`[prover] LOCKED: all ${steps.length} steps as expected (no API role reads a cost column; every screen column list reads; admins read cost through get_admin_cost_fields; both writers work)`);

  // A second apply is harmless (grants are idempotent) and changes nothing.
  stageText('lock.sql', lf(LOCK));
  const again = apply('lock.sql');
  assert.equal(again.status, 0, `the lock failed to re-apply:\n${again.output}`);
  // A column the grant list does not know about refuses the lock (it would be left unreadable).
  const drift = docker([...psqlArgs()], { input: 'BEGIN;\nALTER TABLE public.purchase_order_items ADD COLUMN zz_new text;\n\\i /tmp/lock.sql\nROLLBACK;', allowFailure: true });
  assert.notEqual(drift.status, 0, 'the lock applied over an unknown column');
  assert.match(drift.stderr, /PO_COST_LOCK_PREFLIGHT: purchase_order_items columns are not the ones this grant list covers/);
  console.log('[prover] LOCK PREFLIGHT: re-apply is harmless; an unknown column refuses the lock');

  // MUTATION: the lock is what refuses the rep.
  const mut = scenario([{ key: 'rep reads cost, table grant restored', as: U.REP, call: `(SELECT unit_cost_cents::text FROM public.purchase_order_items WHERE id = '${POI2}')` }],
    'GRANT SELECT ON public.purchase_order_items TO authenticated;');
  assert.equal(mut['rep reads cost, table grant restored'], 'ok|950', `MUTATION: with the table grant restored a rep should read 950, got ${mut['rep reads cost, table grant restored']}`);
  console.log('[prover] MUTATION: with the table-level grant restored a rep reads the cost -- so the refusal comes from the lock');
}

function main() {
  const started = Date.now();
  if (!REUSE) buildContainer();
  assert.equal(scalar("SELECT to_regclass('public.purchase_order_item_cost_changes') IS NULL;"), 't', 'a reused container must be BEFORE the candidate (drop it and rebuild)');
  fidelity();
  if (scalar("SELECT count(*) FROM public.profiles WHERE id::text LIKE '7c300000-%';") === '0') seed();

  check('before', runMatrix('before'));
  preflightRefusesDrift('before');

  stageText('candidate.sql', lf(CANDIDATE));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  console.log('[prover] candidate applied');

  check('after', runMatrix('after'));
  grants();
  preflightRefusesDrift('after');

  // MUTATION 1: the admin gate is what refuses a rep.
  const MUTANT_GATE = 'CREATE OR REPLACE FUNCTION public.require_admin() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN END; $$;';
  const gate = scenario([{ key: 'rep, require_admin emptied', as: U.REP, call: setCosts(U.REP, q(PO2), [{ id: POI3, unit_cost_cents: 2100 }], null, 'k-mut') }], MUTANT_GATE);
  assert.equal(gate['rep, require_admin emptied'], 'ok|1:0', `MUTATION: with require_admin() emptied a rep should set cost, got ${gate['rep, require_admin emptied']}`);
  // The live save wrapper, without the cost stripping (used by mutations 2 and 3).
  const MUTANT_WRAPPER = `CREATE OR REPLACE FUNCTION public.save_purchase_order(p_po_id uuid, p_po_payload jsonb, p_items jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    BEGIN PERFORM pg_advisory_xact_lock(73492009);
      RETURN public._section9_save_purchase_order_serialized(p_po_id, p_po_payload, p_items, p_performed_by, p_idempotency_key); END; $$;`;
  // MUTATION 2: the rep trigger is what overrules a rep's cost (the wrapper's stripping removed too,
  // since it is a second layer that also drops the sent cost).
  const trig = scenario([
    { key: 'rep create, trigger dropped', as: U.REP, call: createPo(U.REP, lineJson(PROD, 4, ", 'unit_cost_cents', 999")) },
    { key: 'stored', as: 'owner', call: LINE(NEWLINE) },
  ], `DROP TRIGGER trigger_a_po_item_rep_cost ON public.purchase_order_items;\n${MUTANT_WRAPPER}`);
  assert.equal(trig.stored, 'ok|4:999:false', `MUTATION: with the rep trigger dropped a rep's 999 should be stored, got ${trig.stored}`);
  // MUTATION 3: the wrapper's cost stripping is what removes the received-line cost oracle.
  const oracle = scenario([{ key: 'rep wrong guess, old wrapper', as: U.REP, call: editPo(PO2, U.REP, [withId(lineJson(PROD_Z, 10, ", 'unit_cost_cents', 1"), POI2), withId(lineJson(PROD, 4), POI3)]) }], MUTANT_WRAPPER);
  assert.match(oracle['rep wrong guess, old wrapper'], /^P0001\|RECEIVED_PO_LINE_IMMUTABLE: /, `MUTATION: with the old wrapper a rep's wrong guess should be refused, got ${oracle['rep wrong guess, old wrapper']}`);
  console.log('[prover] MUTATION: require_admin() emptied lets a rep set cost; the rep trigger dropped lets a rep store 999; the old save wrapper refuses a wrong guess (the oracle) -- so each refusal comes from the guard it names');

  stageText('lock.sql', lf(LOCK));
  const l = apply('lock.sql');
  assert.equal(l.status, 0, `the column lock failed to apply:\n${l.output}`);
  console.log('[prover] column lock applied');
  check('after', runMatrix('locked (the after matrix, re-run)'));
  lockPhase();

  console.log(`[prover] finished in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log('PO_COST_ADMIN_ONLY_CORRECTIONS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
