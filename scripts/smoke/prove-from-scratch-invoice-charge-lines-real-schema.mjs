#!/usr/bin/env node
/**
 * Full-chain proof for the 20261021050000 candidate: Goal 3 "Invoices made from scratch"
 * (docs/plans/2026-10-13-direction-and-goals.md, done-test "Caps and orderless invoices"; Mason,
 * 2026-10-14 decision 6e and 2026-10-15). A misc_charge or chemical_sale invoice with no order and
 * no delivery behind it carries no product lines, only typed charge lines.
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate, checks
 * the candidate's md5 pin against the replayed writer body, seeds an admin, a sales rep, a customer
 * with a field, two products, a confirmed order with a completed delivery, and then runs one matrix
 * BEFORE and AFTER the candidate. Each scenario is one transaction that always rolls back; each step
 * runs as a PostgREST session (request.jwt.claims + SET LOCAL ROLE authenticated) or as the owner.
 *
 * REFUSED after the candidate (each also shown to have been accepted, or impossible to tell apart,
 * before it):
 *   R1 save_invoice: a new misc_charge with a product line (admin and rep).
 *   R2 save_invoice: an edit of a from-scratch misc_charge that adds a product line; lines unchanged.
 *   R3 save_invoice: an edit of a from-scratch chemical_sale that keeps its product line.
 *   R4 save_invoice: a from-scratch line with no charge type.
 *   R5 post_invoice / batch_post_invoices / post_invoice_group-free single post: posting a
 *      from-scratch misc_charge and a from-scratch chemical_sale that already hold a product line
 *      (seeded with the new trigger switched off, as an import or older writer would leave them).
 *   R6 direct table writes: an invoice_items insert of a product line on a from-scratch invoice (as
 *      the owner, so RLS is not what refuses), moving a product line onto one, and clearing the
 *      order_id of an order-backed draft that holds a product line.
 *   R7 the charge-line shape: quantity 2, an unknown type, a product on a charge line, a zero amount.
 * STILL ALLOWED after the candidate:
 *   A1 a from-scratch misc_charge with charge lines saves (admin and rep) and posts; the type,
 *      quantity 1, cost 0 and total are stored as sent, and an admin's sent cost is stored as 0.
 *   A2 a from-scratch chemical_sale edited to charge lines saves and posts.
 *   A3 an order-backed chemical_sale with a product line saves and posts.
 *   A4 a direct field-application invoice made by save_field_app_invoice keeps its chemical line,
 *      and posts.
 *   A5 field-application invoices shaped like a blend-ticket invoice and a job invoice (no order, a
 *      chemical product line) save through save_invoice and post.
 *   A6 a return credit memo (credit_memo) with a negative product line is stored.
 *   A7 a finance-charge shaped misc_charge (one untyped line, no product) is stored and posts.
 *   A8 cancelling a from-scratch invoice that holds a product line still works.
 * MUTATION: with the invoice_items trigger dropped, R6's direct insert succeeds, so the trigger is
 *   what refuses it.
 *
 * Run: node scripts/smoke/prove-from-scratch-invoice-charge-lines-real-schema.mjs   (needs Docker)
 * Prints FROM_SCRATCH_CHARGE_LINES_PROOF_PASS on success. CRX_PROVER_VERBOSE=1 prints every step.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-from-scratch-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1' || REUSE;
const VERBOSE = process.env.CRX_PROVER_VERBOSE === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261021050000_from_scratch_invoices_charge_lines_only.sql');
const WRITER = 'public._save_invoice_lineage_unaware_impl_20260827(jsonb,jsonb,text)';
const WRITER_MD5 = 'e3fc9bd9c1da4b2eb8082e91781e4915';
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
const TOUCHED = /(FUNCTION\s+(public\.)?"?(save_invoice|_save_invoice_\w+|post_invoice|_post_invoice_\w+|batch_post_invoices|_refuse_from_scratch_invoice_product_lines)\b)|charge_type/i;
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
  // Each ledger-only stem is ledgered once: when the replay reaches it or passes it, or at the end.
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

// FIDELITY: the writer the candidate replaces replays with the body live carried on 2026-10-20.
function fidelity() {
  assert.ok(lf(CANDIDATE).includes(`'${WRITER_MD5}'`), 'the candidate preflight pins a different writer md5');
  const got = scalar(`SELECT coalesce(md5(replace(prosrc, chr(13), '')), 'MISSING') FROM pg_proc WHERE oid = to_regprocedure('${WRITER}') UNION ALL SELECT 'MISSING' LIMIT 1;`);
  assert.equal(got, WRITER_MD5, `${WRITER} replayed with a body that differs from the live pin of 2026-10-20`);
  console.log('[prover] FIDELITY: the replayed save_invoice writer matches the live md5 read on 2026-10-20');
}

// ------------------------------------------------------------------------------------------------
// Fixtures (committed once; every probe rolls back).
const id = (n) => `7d300000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), REP: id('b1') };
const CUST = id('c1');
const FIELD = id('1e1');
const PROD = id('f1'); // liquid, $30.00 / gal, cost 22.50
const ORDER = id('701'); const OI = id('702');
const OINV = id('711'); const OINV_ITEM = id('712'); // order-backed chemical_sale draft
const DINV = id('721'); // draft that A3/R6 detach-the-order use
const TODAY = "to_char(CURRENT_DATE, 'YYYY-MM-DD')";
const j = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

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
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'from-scratch-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    ${claims(U.ADMIN)}
    INSERT INTO public.customers (id, farm_name, is_active, email) VALUES ('${CUST}', '[PROVER] Scratch Farm', true, 'c1@example.invalid');
    INSERT INTO public.fields (id, customer_id, field_name, total_acres) VALUES ('${FIELD}', '${CUST}', '[PROVER] Field', 100);
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, product_form, is_active) VALUES
      ('${PROD}', '[PROVER] Chem', 'gal', 22.50, 30.00, 'liquid', true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    SELECT set_config('app.crx_below_cost_operation', 'create_direct_order', true);
    INSERT INTO public.orders (id, order_number, customer_id, status, order_date) VALUES ('${ORDER}', 'PROVER-ORD-1', '${CUST}', 'confirmed', CURRENT_DATE);
    INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, price_per_unit, total_units_needed, total_price, cost_per_unit)
      VALUES ('${OI}', '${ORDER}', '${PROD}', '[PROVER] Chem', 'gal', 30.00, 2, 60.00, 22.50);
    INSERT INTO public.invoices (id, invoice_number, order_id, customer_id, invoice_type, status, invoice_date, created_by, salesman_id) VALUES
      ('${OINV}', 'PROVER-OI-1', '${ORDER}', '${CUST}', 'chemical_sale', 'draft', CURRENT_DATE, '${U.ADMIN}', '${U.ADMIN}');
    INSERT INTO public.invoice_items (id, invoice_id, order_item_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order) VALUES
      ('${OINV_ITEM}', '${OINV}', '${OI}', '${PROD}', '[PROVER] Chem', 2, 3000, 6000, 2250, 0);
    UPDATE public.invoices SET total_amount_cents = 6000 WHERE id = '${OINV}';
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7d300000-%';`), 'admin:true,sales_rep:true');
  console.log('[prover] seeded an admin, a sales rep, one customer + field, one product, one confirmed order with an order-backed draft invoice');
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
  return out;
}

// --- payload builders -----------------------------------------------------------------------------
const header = (extra = {}) => ({ customer_id: CUST, invoice_type: 'misc_charge', status: 'draft', invoice_date: null, ...extra });
const productLine = { product_id: PROD, description: '[PROVER] Chem', quantity: 2, unit_price_cents: 3000, extended_cents: 6000, cost_cents: 2250 };
const freight = { charge_type: 'freight', description: 'Freight to farm', quantity: 1, unit_price_cents: 2500, extended_cents: 2500, cost_cents: 0 };
const service = { charge_type: 'service', description: 'Soil sampling', quantity: 1, unit_price_cents: 4050, extended_cents: 4050, cost_cents: 0 };
const untyped = { description: 'Something', quantity: 1, unit_price_cents: 1000, extended_cents: 1000, cost_cents: 0 };
const save = (inv, items, key) => `public.save_invoice(${j(inv)} || jsonb_build_object('invoice_date', ${TODAY}), ${j(items)}, '${key}')`;
// The id of the invoice the last step created, kept in a session setting so later steps can use it.
const KEEP_ID = (call) => `v := (${call})::text; PERFORM set_config('prover.inv', v, true);`;
const INV = "current_setting('prover.inv')::uuid";
const post = (key, inv = INV) => `public.post_invoice(${inv}, '${key}')`;
const LINES = (inv = INV) => `(SELECT string_agg(coalesce(ii.charge_type, '-') || ':' || coalesce(ii.product_id::text, '-') || ':' || trim_scale(ii.quantity)::text || ':' || ii.unit_price_cents || ':' || ii.extended_cents || ':' || ii.cost_cents, ',' ORDER BY ii.sort_order) FROM public.invoice_items ii WHERE ii.invoice_id = ${inv})`;
const HEAD = (inv = INV) => `(SELECT i.invoice_type || ':' || i.status || ':' || i.total_amount_cents || ':' || coalesce(i.total_cost_cents, 0) FROM public.invoices i WHERE i.id = ${inv})`;

// A from-scratch invoice that already holds a product line, as an import or an older writer could
// have left it. Seeded as the owner with the candidate's item trigger switched off (before the
// candidate there is no trigger to switch off).
const legacy = (n, type) => `
DO $seed$ BEGIN
  IF to_regclass('public.invoice_items') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_refuse_from_scratch_invoice_product_lines') THEN
    EXECUTE 'ALTER TABLE public.invoice_items DISABLE TRIGGER trg_refuse_from_scratch_invoice_product_lines';
  END IF;
END $seed$;
INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, created_by, salesman_id, total_amount_cents)
  VALUES ('${id(n)}', 'PROVER-LEG-${n}', '${CUST}', '${type}', 'draft', CURRENT_DATE, '${U.ADMIN}', '${U.ADMIN}', 6000);
INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order)
  VALUES ('${id(n)}', '${PROD}', '[PROVER] Chem', 2, 3000, 6000, 2250, 0);
DO $seed$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_refuse_from_scratch_invoice_product_lines') THEN
    EXECUTE 'ALTER TABLE public.invoice_items ENABLE TRIGGER trg_refuse_from_scratch_invoice_product_lines';
  END IF;
END $seed$;`;
const LEG_MISC = id('801'); const LEG_CHEM = id('802');

// Field-application invoices shaped like a blend-ticket invoice and a job invoice: no order, a
// chemical product line, the shape create_invoice_from_blend_ticket / transfer_job_to_invoice
// leave (both store invoice_type = 'field_application').
const FIELD_BT = id('811'); const FIELD_JOB = id('812');
const fieldInvoices = `
INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, created_by, salesman_id, total_amount_cents) VALUES
  ('${FIELD_BT}', 'PROVER-FBT', '${CUST}', 'field_application', 'draft', CURRENT_DATE, '${U.ADMIN}', '${U.ADMIN}', 6000),
  ('${FIELD_JOB}', 'PROVER-FJOB', '${CUST}', 'field_application', 'draft', CURRENT_DATE, '${U.ADMIN}', '${U.ADMIN}', 6000);
INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order, rate_per_acre, acres, rate_unit) VALUES
  ('${FIELD_BT}', '${PROD}', '[PROVER] Chem', 2, 3000, 6000, 2250, 0, 0.2, 10, 'gal/ac'),
  ('${FIELD_JOB}', '${PROD}', '[PROVER] Chem', 2, 3000, 6000, 2250, 0, 0.2, 10, 'gal/ac');
-- transfer_job_to_invoice leaves a job invoice unposted.
UPDATE public.invoices SET status = 'unposted' WHERE id = '${FIELD_JOB}';`;
const fieldEdit = (inv) => save({ id: inv, customer_id: CUST, invoice_type: 'field_application', status: undefined, salesman_id: U.ADMIN },
  [{ product_id: PROD, description: '[PROVER] Chem', quantity: 2, unit_price_cents: 3100, extended_cents: 6200, cost_cents: 2250, rate_per_acre: 0.2, acres: 10, rate_unit: 'gal/ac' }], `fe-${inv.slice(-3)}`);

function runMatrix(label) {
  const r = {};
  const add = (out) => Object.assign(r, out);
  const misc = header({ salesman_id: U.ADMIN });
  const repMisc = header({ salesman_id: U.REP });

  // R1 / R4 / A1 (admin), A1 (rep)
  add(scenario([
    { key: 'R1 admin new misc_charge + product line', as: U.ADMIN, call: save(misc, [productLine], 'r1a') },
  ]));
  add(scenario([
    { key: 'R1 rep new misc_charge + product line', as: U.REP, call: save(repMisc, [productLine], 'r1r') },
  ]));
  add(scenario([
    { key: 'R4 new misc_charge + untyped line', as: U.ADMIN, call: save(misc, [untyped], 'r4') },
  ]));
  add(scenario([
    { key: 'A1 admin new misc_charge, charge lines', as: U.ADMIN, stmt: KEEP_ID(save(misc, [{ ...freight, cost_cents: 999 }, service], 'a1a')) },
    { key: 'A1 admin stored lines', as: 'owner', call: LINES() },
    { key: 'A1 admin stored header', as: 'owner', call: HEAD() },
    { key: 'R2 admin edit adds a product line', as: U.ADMIN, call: `public.save_invoice(${j(misc)} || jsonb_build_object('id', ${INV}, 'invoice_date', ${TODAY}), ${j([freight, productLine])}, 'r2')` },
    { key: 'R2 lines unchanged', as: 'owner', call: LINES() },
    { key: 'A1 admin post', as: U.ADMIN, stmt: `PERFORM ${post('a1p')}; v := 'posted';` },
    { key: 'A1 admin posted header', as: 'owner', call: HEAD() },
  ]));
  add(scenario([
    { key: 'A1 rep new misc_charge, charge lines', as: U.REP, stmt: KEEP_ID(save(repMisc, [freight, service], 'a1r')) },
    { key: 'A1 rep stored lines', as: 'owner', call: LINES() },
    { key: 'A1 rep post', as: U.REP, stmt: `PERFORM ${post('a1rp')}; v := 'posted';` },
    { key: 'A1 rep posted header', as: 'owner', call: HEAD() },
  ]));

  // R3 / A2: a from-scratch chemical_sale (no order). save_invoice cannot create one (it requires
  // an order or blend ticket), so it is seeded the way an import would leave it.
  add(scenario([
    { key: 'R3 edit from-scratch chemical_sale keeping its product line', as: U.ADMIN, stmt: `v := (public.save_invoice(${j(header({ invoice_type: 'chemical_sale', salesman_id: U.ADMIN }))} || jsonb_build_object('id', '${LEG_CHEM}', 'invoice_date', ${TODAY}), ${j([productLine])}, 'r3'))::text;` },
  ], legacy('802', 'chemical_sale')));
  add(scenario([
    { key: 'A2 edit from-scratch chemical_sale to charge lines', as: U.ADMIN, stmt: `v := (public.save_invoice(${j(header({ invoice_type: 'chemical_sale', salesman_id: U.ADMIN }))} || jsonb_build_object('id', '${LEG_CHEM}', 'invoice_date', ${TODAY}), ${j([freight])}, 'a2'))::text;` },
    { key: 'A2 stored lines', as: 'owner', call: LINES(`'${LEG_CHEM}'::uuid`) },
    { key: 'A2 post', as: U.ADMIN, stmt: `PERFORM ${post('a2p', `'${LEG_CHEM}'::uuid`)}; v := 'posted';` },
    { key: 'A2 posted header', as: 'owner', call: HEAD(`'${LEG_CHEM}'::uuid`) },
  ], legacy('802', 'chemical_sale')));

  // R5: posting a from-scratch invoice that holds a product line.
  add(scenario([{ key: 'R5 post_invoice misc_charge with product line', as: U.ADMIN, stmt: `PERFORM ${post('r5a', `'${LEG_MISC}'::uuid`)}; v := 'posted';` }], legacy('801', 'misc_charge')));
  add(scenario([{ key: 'R5 post_invoice chemical_sale with product line', as: U.ADMIN, stmt: `PERFORM ${post('r5b', `'${LEG_CHEM}'::uuid`)}; v := 'posted';` }], legacy('802', 'chemical_sale')));
  add(scenario([{ key: 'R5 batch_post_invoices with product line', as: U.ADMIN, call: `public.batch_post_invoices(ARRAY['${LEG_MISC}'::uuid], 'r5c')` }], legacy('801', 'misc_charge')));
  add(scenario([{ key: 'R5 status after batch', as: 'owner', stmt: `BEGIN PERFORM public.batch_post_invoices(ARRAY['${LEG_MISC}'::uuid], 'r5d'); EXCEPTION WHEN OTHERS THEN NULL; END; v := (SELECT status FROM public.invoices WHERE id = '${LEG_MISC}');` }], legacy('801', 'misc_charge')));

  // R6: direct table writes, as the owner so RLS is not what refuses.
  add(scenario([
    { key: 'R6 owner inserts a product line on a from-scratch invoice', as: 'owner', stmt: `
      INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, created_by) VALUES ('${id('901')}', 'PROVER-D-1', '${CUST}', 'misc_charge', 'draft', CURRENT_DATE, '${U.ADMIN}');
      INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents) VALUES ('${id('901')}', '${PROD}', 'x', 1, 3000, 3000, 0);
      v := 'inserted';` },
  ]));
  add(scenario([
    { key: 'R6 owner moves a product line onto a from-scratch invoice', as: 'owner', stmt: `
      INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, created_by) VALUES ('${id('902')}', 'PROVER-D-2', '${CUST}', 'misc_charge', 'draft', CURRENT_DATE, '${U.ADMIN}');
      UPDATE public.invoice_items SET invoice_id = '${id('902')}' WHERE id = '${OINV_ITEM}';
      v := 'moved';` },
  ]));
  add(scenario([
    { key: 'R6 owner clears the order of an order-backed draft with a product line', as: 'owner', stmt: `
      SET LOCAL app.admin_override = 'true';
      UPDATE public.invoices SET order_id = NULL WHERE id = '${OINV}';
      v := 'detached';` },
  ]));

  // R7: the charge-line shape (only meaningful once the column exists).
  if (label !== 'before') {
    for (const [k, line] of [
      ['R7 charge line quantity 2', { ...freight, quantity: 2, extended_cents: 5000 }],
      ['R7 charge line unknown type', { ...freight, charge_type: 'tax' }],
      ['R7 charge line zero amount', { ...freight, unit_price_cents: 0, extended_cents: 0 }],
      ['R7 charge line blank description', { ...freight, description: '   ' }],
      ['R7 charge line tab/newline description', { ...freight, description: '\t\n' }],
    ]) add(scenario([{ key: k, as: U.ADMIN, call: save(misc, [line], `r7-${k.length}`) }]));
    // R9: an untyped product-less line from a writer other than save_invoice is typed 'other', so the
    // shape check refuses a quantity-times-price sale written that way.
    add(scenario([{ key: 'R9 owner inserts an untyped 10 x $50 line', as: 'owner', stmt: `
      INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, created_by) VALUES ('${id('907')}', 'PROVER-U-1', '${CUST}', 'misc_charge', 'draft', CURRENT_DATE, '${U.ADMIN}');
      INSERT INTO public.invoice_items (invoice_id, description, quantity, unit_price_cents, extended_cents, cost_cents) VALUES ('${id('907')}', 'Roundup 2.5 gal', 10, 5000, 50000, 0);
      v := 'inserted';` }]));
    // R10: an untyped line written while the invoice was soft-deleted (not typed then) blocks the restore.
    add(scenario([{ key: 'R10 restore over an untyped line', as: 'owner', stmt: `
      INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, created_by, deleted_at) VALUES ('${id('908')}', 'PROVER-U-2', '${CUST}', 'misc_charge', 'draft', CURRENT_DATE, '${U.ADMIN}', now());
      INSERT INTO public.invoice_items (invoice_id, description, quantity, unit_price_cents, extended_cents, cost_cents) VALUES ('${id('908')}', 'x', 10, 5000, 50000, 0);
      UPDATE public.invoices SET deleted_at = NULL WHERE id = '${id('908')}';
      v := 'restored';` }]));
    // R8: a from-scratch invoice that is already posted and then overdue is still covered.
    add(scenario([{ key: 'R8 product line on an overdue from-scratch invoice', as: 'owner', stmt: `
      INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, created_by, salesman_id) VALUES ('${id('906')}', 'PROVER-OD-1', '${CUST}', 'misc_charge', 'draft', CURRENT_DATE, '${U.ADMIN}', '${U.ADMIN}');
      SET LOCAL app.admin_override = 'true';
      UPDATE public.invoices SET status = 'posted', posted_at = now(), posted_by = '${U.ADMIN}' WHERE id = '${id('906')}';
      UPDATE public.invoices SET status = 'overdue' WHERE id = '${id('906')}';
      INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents) VALUES ('${id('906')}', '${PROD}', 'x', 1, 3000, 3000, 0);
      v := 'inserted';` }]));
    add(scenario([{ key: 'R7 charge type on a product line (order invoice)', as: U.ADMIN, stmt: `v := (public.save_invoice(jsonb_build_object('id', '${OINV}', 'customer_id', '${CUST}', 'invoice_type', 'chemical_sale', 'salesman_id', '${U.ADMIN}', 'invoice_date', ${TODAY}), ${j([{ id: OINV_ITEM, order_item_id: OI, ...productLine, charge_type: 'freight' }])}, 'r7p'))::text;` }]));
  }

  // A3: the order-backed chemical_sale with a product line still saves and posts.
  add(scenario([
    { key: 'A3 order-backed edit keeps its product line', as: U.ADMIN, stmt: `v := (public.save_invoice(jsonb_build_object('id', '${OINV}', 'customer_id', '${CUST}', 'invoice_type', 'chemical_sale', 'salesman_id', '${U.ADMIN}', 'invoice_date', ${TODAY}), ${j([{ id: OINV_ITEM, order_item_id: OI, ...productLine }])}, 'a3'))::text;` },
    { key: 'A3 order-backed stored lines', as: 'owner', call: LINES(`'${OINV}'::uuid`) },
    { key: 'A3 order-backed post', as: U.ADMIN, stmt: `PERFORM ${post('a3p', `'${OINV}'::uuid`)}; v := 'posted';` },
  ]));

  // A4: a direct field-app invoice through save_field_app_invoice keeps its chemical line, and posts.
  add(scenario([
    { key: 'A4 save_field_app_invoice with a chemical', as: U.ADMIN, stmt: `v := (public.save_field_app_invoice(NULL, jsonb_build_object('invoice_date', ${TODAY}, 'salesman_id', '${U.ADMIN}'), ${j([{ field_id: FIELD, applied_acres: 10 }])}, ${j([{ product_id: PROD, description: '[PROVER] Chem', rate_per_acre: 0.2, rate_unit: 'gal/ac', unit_size: 'gal', sort_order: 0 }])}, '${U.ADMIN}', NULL, 'a4'))::text;
      PERFORM set_config('prover.inv', (SELECT i.id::text FROM public.invoices i WHERE i.customer_id = '${CUST}' AND i.invoice_type = 'field_application' ORDER BY i.created_at DESC LIMIT 1), true);` },
    { key: 'A4 field-app product lines', as: 'owner', call: `(SELECT count(*) FROM public.invoice_items ii WHERE ii.invoice_id = ${INV} AND ii.product_id = '${PROD}')` },
    { key: 'A4 field-app post', as: U.ADMIN, stmt: `PERFORM ${post('a4p')}; v := 'posted';` },
    { key: 'A4 field-app posted header', as: 'owner', call: `(SELECT i.invoice_type || ':' || i.status FROM public.invoices i WHERE i.id = ${INV})` },
  ]));

  // A5: blend-ticket and job shaped field invoices save through save_invoice and post.
  add(scenario([
    { key: 'A5 blend-ticket shaped field invoice save', as: U.ADMIN, call: fieldEdit(FIELD_BT) },
    { key: 'A5 blend-ticket shaped lines', as: 'owner', call: LINES(`'${FIELD_BT}'::uuid`) },
    { key: 'A5 blend-ticket shaped post', as: U.ADMIN, stmt: `PERFORM ${post('a5bp', `'${FIELD_BT}'::uuid`)}; v := 'posted';` },
    { key: 'A5 job shaped field invoice save', as: U.ADMIN, call: fieldEdit(FIELD_JOB) },
    { key: 'A5 job shaped post', as: U.ADMIN, stmt: `PERFORM ${post('a5jp', `'${FIELD_JOB}'::uuid`)}; v := 'posted';` },
    { key: 'A5 posted headers', as: 'owner', call: `(SELECT string_agg(i.invoice_number || ':' || i.status, ',' ORDER BY i.invoice_number) FROM public.invoices i WHERE i.id IN ('${FIELD_BT}', '${FIELD_JOB}'))` },
  ], fieldInvoices));

  // A6: a return credit memo with a negative product line (the shape issue_return_credit stores).
  add(scenario([
    { key: 'A6 credit memo with a negative product line', as: 'owner', stmt: `
      INSERT INTO public.invoices (id, invoice_number, order_id, customer_id, invoice_type, status, invoice_date, created_by, total_amount_cents, posted_at, posted_by)
        VALUES ('${id('903')}', 'PROVER-CM-1', '${ORDER}', '${CUST}', 'credit_memo', 'posted', CURRENT_DATE, '${U.ADMIN}', -3000, now(), '${U.ADMIN}');
      INSERT INTO public.invoice_items (invoice_id, order_item_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order)
        VALUES ('${id('903')}', '${OI}', '${PROD}', 'Return credit', -1, 3000, -3000, 0, 0);
      v := (SELECT count(*) FROM public.invoice_items WHERE invoice_id = '${id('903')}' AND product_id IS NOT NULL)::text;` },
  ]));

  // A7: a finance-charge shaped misc_charge (one untyped line, no product) is stored and posts.
  add(scenario([
    { key: 'A7 finance-charge shaped invoice stored', as: 'owner', stmt: `
      INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, created_by, salesman_id, total_amount_cents)
        VALUES ('${id('904')}', 'PROVER-FC-1', '${CUST}', 'misc_charge', 'draft', CURRENT_DATE, '${U.ADMIN}', '${U.ADMIN}', 1234);
      INSERT INTO public.invoice_items (invoice_id, description, quantity, unit_price_cents, extended_cents, cost_cents, is_application_fee, sort_order)
        VALUES ('${id('904')}', 'Finance Charge - 18% annual rate on overdue balance', 1, 1234, 1234, 0, false, 1);
      UPDATE public.invoices SET status = 'unposted' WHERE id = '${id('904')}';
      v := 'stored:' || coalesce((SELECT to_jsonb(ii)->>'charge_type' FROM public.invoice_items ii WHERE ii.invoice_id = '${id('904')}'), '-');` },
    { key: 'A7 finance-charge shaped post', as: U.ADMIN, stmt: `PERFORM ${post('a7p', `'${id('904')}'::uuid`)}; v := 'posted';` },
  ]));

  // A8: a from-scratch invoice holding a product line can still be cancelled.
  add(scenario([
    { key: 'A8 cancel a from-scratch invoice with a product line', as: 'owner', stmt: `SET LOCAL app.admin_override = 'true'; UPDATE public.invoices SET status = 'cancelled' WHERE id = '${LEG_MISC}'; v := (SELECT status FROM public.invoices WHERE id = '${LEG_MISC}');` },
  ], legacy('801', 'misc_charge')));

  if (VERBOSE) for (const [k, v] of Object.entries(r)) console.log(`  [${label}] ${k} -> ${v}`);
  return r;
}

const REFUSED_PRODUCT = /^23514\|FROM_SCRATCH_INVOICE_PRODUCT_LINE_REFUSED: /;
const REFUSED_TYPE = /^23514\|FROM_SCRATCH_INVOICE_CHARGE_TYPE_REQUIRED: /;
const SHAPE = /^23514\|new row for relation "invoice_items" violates check constraint "invoice_items_charge_(line_shape_chk|type_check)"/;
const OK = (v) => new RegExp(`^ok\\|${v}$`);
const OK_ANY = /^ok\|/;

// Refused before AND after by older guards (the candidate's triggers back them up).
const ALREADY_REFUSED = [
  ['R6 owner moves a product line onto a from-scratch invoice', /^P0001\|INVOICE_ITEM_LINEAGE_IMMUTABLE: /],
  ['R6 owner clears the order of an order-backed draft with a product line', /^23514\|INVOICE_ORDER_IMMUTABLE: /],
];
// After the candidate: [key, expected].
const AFTER = [
  ['R1 admin new misc_charge + product line', REFUSED_PRODUCT],
  ['R1 rep new misc_charge + product line', REFUSED_PRODUCT],
  ['R4 new misc_charge + untyped line', REFUSED_TYPE],
  ['A1 admin new misc_charge, charge lines', OK_ANY],
  ['A1 admin stored lines', OK('freight:-:1:2500:2500:0,service:-:1:4050:4050:0')],
  ['A1 admin stored header', OK('misc_charge:draft:6550:0')],
  ['R2 admin edit adds a product line', REFUSED_PRODUCT],
  ['R2 lines unchanged', OK('freight:-:1:2500:2500:0,service:-:1:4050:4050:0')],
  ['A1 admin post', OK('posted')],
  ['A1 admin posted header', OK('misc_charge:posted:6550:0')],
  ['A1 rep new misc_charge, charge lines', OK_ANY],
  ['A1 rep stored lines', OK('freight:-:1:2500:2500:0,service:-:1:4050:4050:0')],
  ['A1 rep post', OK('posted')],
  ['A1 rep posted header', OK('misc_charge:posted:6550:0')],
  ['R3 edit from-scratch chemical_sale keeping its product line', REFUSED_PRODUCT],
  ['A2 edit from-scratch chemical_sale to charge lines', OK_ANY],
  ['A2 stored lines', OK('freight:-:1:2500:2500:0')],
  ['A2 post', OK('posted')],
  ['A2 posted header', OK('chemical_sale:posted:2500:0')],
  ['R5 post_invoice misc_charge with product line', REFUSED_PRODUCT],
  ['R5 post_invoice chemical_sale with product line', REFUSED_PRODUCT],
  ['R5 batch_post_invoices with product line', /^ok\|.*FROM_SCRATCH_INVOICE_PRODUCT_LINE_REFUSED|^23514\|FROM_SCRATCH_INVOICE_PRODUCT_LINE_REFUSED/],
  ['R5 status after batch', OK('draft')],
  ['R6 owner inserts a product line on a from-scratch invoice', REFUSED_PRODUCT],
  ...ALREADY_REFUSED.map(([k, re]) => [k, new RegExp(`${re.source}|${REFUSED_PRODUCT.source}`)]),
  ['R7 charge line quantity 2', SHAPE],
  ['R7 charge line unknown type', SHAPE],
  ['R7 charge line zero amount', SHAPE],
  ['R7 charge type on a product line (order invoice)', SHAPE],
  ['R7 charge line blank description', SHAPE],
  ['R7 charge line tab/newline description', SHAPE],
  ['R8 product line on an overdue from-scratch invoice', REFUSED_PRODUCT],
  ['R9 owner inserts an untyped 10 x $50 line', SHAPE],
  ['R10 restore over an untyped line', REFUSED_TYPE],
  ['A3 order-backed edit keeps its product line', OK(OINV)],
  ['A3 order-backed stored lines', OK(`-:${PROD}:2:3000:6000:2250`)],
  ['A3 order-backed post', OK('posted')],
  ['A4 save_field_app_invoice with a chemical', OK_ANY],
  ['A4 field-app product lines', OK('1')],
  ['A4 field-app post', OK('posted')],
  ['A4 field-app posted header', OK('field_application:posted')],
  ['A5 blend-ticket shaped field invoice save', OK(FIELD_BT)],
  ['A5 blend-ticket shaped lines', OK(`-:${PROD}:2:3100:6200:2250`)],
  ['A5 blend-ticket shaped post', OK('posted')],
  ['A5 job shaped field invoice save', OK(FIELD_JOB)],
  ['A5 job shaped post', OK('posted')],
  ['A5 posted headers', OK('PROVER-FBT:posted,PROVER-FJOB:posted')],
  ['A6 credit memo with a negative product line', OK('1')],
  ['A7 finance-charge shaped invoice stored', OK('stored:other')],
  ['A7 finance-charge shaped post', OK('posted')],
  ['A8 cancel a from-scratch invoice with a product line', OK('cancelled')],
];
// Before the candidate, the from-scratch product refusals did not exist.
const BEFORE_ACCEPTED = [
  'R1 admin new misc_charge + product line',
  'R1 rep new misc_charge + product line',
  'R4 new misc_charge + untyped line',
  'R2 admin edit adds a product line',
  'R3 edit from-scratch chemical_sale keeping its product line',
  'R5 post_invoice misc_charge with product line',
  'R5 post_invoice chemical_sale with product line',
  'R6 owner inserts a product line on a from-scratch invoice',
];

function check(label, got) {
  const lines = [];
  let failed = 0;
  if (label === 'before') {
    for (const key of BEFORE_ACCEPTED) {
      const ok = OK_ANY.test(got[key]);
      if (!ok) failed += 1;
      lines.push(`  ${ok ? 'PASS' : 'FAIL'} [before] ${key} accepted -> ${got[key]}`);
    }
    for (const [key, want] of ALREADY_REFUSED) {
      const ok = want.test(got[key]);
      if (!ok) failed += 1;
      lines.push(`  ${ok ? 'PASS' : 'FAIL'} [before] ${key} already refused -> ${got[key]}`);
    }
  } else {
    for (const [key, want] of AFTER) {
      const ok = want.test(got[key] ?? '<missing>');
      if (!ok) failed += 1;
      lines.push(`  ${ok ? 'PASS' : 'FAIL'} ${key} -> ${got[key]}`);
    }
  }
  console.log(`[prover] ${label}:\n${lines.join('\n')}`);
  assert.equal(failed, 0, `${failed} ${label} check(s) failed`);
}

// The candidate's preflight DO block, for EXECUTE inside a probe.
const PREFLIGHT_EXEC = `$q$DO $p$${lf(CANDIDATE).split('$preflight$')[1]}$p$$q$`;

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
// Wait until the first connection is inside its pg_sleep, so it already holds its row lock when the
// second statement starts (a fixed pause can lose to a slow docker exec on a loaded host).
async function holdingSleep() {
  for (let i = 0; i < 100; i += 1) {
    if (scalar("SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state = 'active' AND query LIKE '%pg_sleep(4)%';") !== '0') return;
    await new Promise((r) => { setTimeout(r, 100); });
  }
  throw new Error('the first race connection never reached its pg_sleep');
}

// RACES (two real connections, committed data, cleaned up after): a product-line insert and the
// restore of a soft-deleted from-scratch draft, in both orders. The second statement waits on the
// first transaction's row lock and then refuses. MUTATION: without the line trigger's FOR SHARE
// lock, the restore does not wait, and both commit.
async function races() {
  const AS = `SELECT set_config('request.jwt.claims', '{"sub":"${U.ADMIN}","role":"authenticated"}', false);`;
  const draft = (n) => `INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, created_by, salesman_id, deleted_at)
    VALUES ('${id(n)}', 'PROVER-RACE-${n}', '${CUST}', 'misc_charge', 'draft', CURRENT_DATE, '${U.ADMIN}', '${U.ADMIN}', now());`;
  const line = (n) => `INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents) VALUES ('${id(n)}', '${PROD}', 'x', 1, 3000, 3000, 0);`;
  const restore = (n) => `UPDATE public.invoices SET deleted_at = NULL WHERE id = '${id(n)}';`;
  const state = (n) => scalar(`SELECT (SELECT deleted_at IS NULL FROM public.invoices WHERE id = '${id(n)}')::text || ':' || (SELECT count(*) FROM public.invoice_items WHERE invoice_id = '${id(n)}');`);
  const cleanup = (ns) => psql(`${AS} SET app.admin_override = 'true';
    ALTER TABLE public.invoice_items DISABLE TRIGGER USER; DELETE FROM public.invoice_items WHERE invoice_id IN (${ns.map((n) => `'${id(n)}'`).join(',')});
    ALTER TABLE public.invoice_items ENABLE TRIGGER USER;
    ALTER TABLE public.invoices DISABLE TRIGGER USER; DELETE FROM public.invoices WHERE id IN (${ns.map((n) => `'${id(n)}'`).join(',')});
    ALTER TABLE public.invoices ENABLE TRIGGER USER;`);
  const fn = lf(CANDIDATE).split('CREATE FUNCTION public._refuse_from_scratch_invoice_product_lines()')[1].split('$function$;')[0];
  const recreate = (body) => psql(`CREATE OR REPLACE FUNCTION public._refuse_from_scratch_invoice_product_lines()${body}$function$;`);
  let first;
  let second;
  let firstDone;
  // Every committed fixture is removed and the real function restored, whichever step fails.
  try {
    psql(`${AS} ${draft('a01')} ${draft('a02')} ${draft('a03')}`);

    // Line first, restore second.
    first = psqlAsync(`${AS} BEGIN; ${line('a01')} SELECT pg_sleep(4); COMMIT;`);
    await holdingSleep();
    second = await psqlAsync(`${AS} ${restore('a01')}`);
    firstDone = await first;
    assert.equal(firstDone.status, 0, `race 1 line insert failed:\n${firstDone.out}`);
    assert.match(second.out, /FROM_SCRATCH_INVOICE_PRODUCT_LINE_REFUSED/, `race 1 restore was not refused:\n${second.out}`);
    assert.equal(state('a01'), 'false:1');

    // Restore first, line second.
    first = psqlAsync(`${AS} BEGIN; ${restore('a02')} SELECT pg_sleep(4); COMMIT;`);
    await holdingSleep();
    second = await psqlAsync(`${AS} ${line('a02')}`);
    firstDone = await first;
    assert.equal(firstDone.status, 0, `race 2 restore failed:\n${firstDone.out}`);
    assert.match(second.out, /FROM_SCRATCH_INVOICE_PRODUCT_LINE_REFUSED/, `race 2 line insert was not refused:\n${second.out}`);
    assert.equal(state('a02'), 'true:0');
    console.log('[prover] RACES: a product line and a restore in two connections, in both orders, never leave an active from-scratch invoice with a product line');

    // MUTATION: drop the FOR SHARE lock; the line-first race now lets both commit.
    const unlocked = fn.replace(/\n\s*PERFORM 1 FROM public\.invoices WHERE id = v_invoice_id FOR SHARE;/, '');
    assert.notEqual(unlocked, fn, 'mutation did not remove the FOR SHARE lock');
    recreate(unlocked);
    first = psqlAsync(`${AS} BEGIN; ${line('a03')} SELECT pg_sleep(4); COMMIT;`);
    await holdingSleep();
    second = await psqlAsync(`${AS} ${restore('a03')}`);
    firstDone = await first;
    assert.equal(firstDone.status, 0);
    assert.doesNotMatch(second.out, /FROM_SCRATCH_INVOICE_PRODUCT_LINE_REFUSED/, `MUTATION: without the lock the restore should slip through:\n${second.out}`);
    assert.equal(state('a03'), 'true:1');
  } finally {
    try { recreate(fn); } finally { cleanup(['a01', 'a02', 'a03']); }
  }
  assert.equal(scalar("SELECT position('FOR SHARE' in prosrc) > 0 FROM pg_proc WHERE oid = 'public._refuse_from_scratch_invoice_product_lines()'::regprocedure;"), 't');
  console.log('[prover] MUTATION: without the FOR SHARE lock the same race leaves a restored from-scratch invoice holding a product line, so the lock is what closes it');

  // Clearing a typed charge's charge_type while the soft-deleted invoice is restored (Codex
  // connector P2): both orders refuse; with charge_type dropped from the line trigger, both commit.
  const charge = (n) => `INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, charge_type) VALUES ('${id(n)}', NULL, 'Freight', 1, 2500, 2500, 0, 'freight');`;
  const untype = (n) => `UPDATE public.invoice_items SET charge_type = NULL WHERE invoice_id = '${id(n)}';`;
  const untyped = (n) => scalar(`SELECT (SELECT deleted_at IS NULL FROM public.invoices WHERE id = '${id(n)}')::text || ':' || (SELECT count(*) FROM public.invoice_items WHERE invoice_id = '${id(n)}' AND charge_type IS NULL);`);
  try {
    psql(`${AS} ${draft('a04')} ${draft('a05')} ${draft('a06')} ${charge('a04')} ${charge('a05')} ${charge('a06')}`);
    first = psqlAsync(`${AS} BEGIN; ${untype('a04')} SELECT pg_sleep(4); COMMIT;`);
    await holdingSleep();
    second = await psqlAsync(`${AS} ${restore('a04')}`);
    firstDone = await first;
    assert.equal(firstDone.status, 0, `race 3 untype failed:\n${firstDone.out}`);
    assert.match(second.out, /FROM_SCRATCH_INVOICE_CHARGE_TYPE_REQUIRED/, `race 3 restore was not refused:\n${second.out}`);
    assert.equal(untyped('a04'), 'false:1');

    first = psqlAsync(`${AS} BEGIN; ${restore('a05')} SELECT pg_sleep(4); COMMIT;`);
    await holdingSleep();
    second = await psqlAsync(`${AS} ${untype('a05')}`);
    firstDone = await first;
    assert.equal(firstDone.status, 0, `race 4 restore failed:\n${firstDone.out}`);
    assert.match(second.out, /FROM_SCRATCH_INVOICE_CHARGE_TYPE_REQUIRED/, `race 4 untype was not refused:\n${second.out}`);
    assert.equal(untyped('a05'), 'true:0');
    console.log('[prover] RACES: clearing a charge type and a restore in two connections, in both orders, never leave an active from-scratch invoice with an untyped line');

    const TRG = 'CREATE TRIGGER trg_refuse_from_scratch_invoice_product_lines\n  AFTER INSERT OR UPDATE OF product_id, invoice_id, charge_type ON public.invoice_items';
    assert.ok(lf(CANDIDATE).includes(TRG), 'the candidate no longer lists charge_type on the line trigger');
    psql(`DROP TRIGGER trg_refuse_from_scratch_invoice_product_lines ON public.invoice_items;
      CREATE TRIGGER trg_refuse_from_scratch_invoice_product_lines AFTER INSERT OR UPDATE OF product_id, invoice_id ON public.invoice_items
      FOR EACH ROW EXECUTE FUNCTION public._refuse_from_scratch_invoice_product_lines();`);
    first = psqlAsync(`${AS} BEGIN; ${untype('a06')} SELECT pg_sleep(4); COMMIT;`);
    await holdingSleep();
    second = await psqlAsync(`${AS} ${restore('a06')}`);
    firstDone = await first;
    assert.equal(firstDone.status, 0);
    assert.doesNotMatch(second.out, /FROM_SCRATCH_INVOICE_CHARGE_TYPE_REQUIRED/, `MUTATION: without charge_type on the trigger the restore should slip through:\n${second.out}`);
    assert.equal(untyped('a06'), 'true:1');
    console.log('[prover] MUTATION: without charge_type on the line trigger the same race leaves a restored from-scratch invoice holding an untyped line, so listing it is what closes it');
  } finally {
    try {
      psql(`DROP TRIGGER IF EXISTS trg_refuse_from_scratch_invoice_product_lines ON public.invoice_items;
        CREATE TRIGGER trg_refuse_from_scratch_invoice_product_lines AFTER INSERT OR UPDATE OF product_id, invoice_id, charge_type ON public.invoice_items
        FOR EACH ROW EXECUTE FUNCTION public._refuse_from_scratch_invoice_product_lines();`);
    } finally { cleanup(['a04', 'a05', 'a06']); }
  }
}

async function main() {
  const started = Date.now();
  if (!REUSE) buildContainer();
  if (scalar("SELECT to_regproc('public._refuse_from_scratch_invoice_product_lines') IS NULL;") === 't') {
    fidelity();
    if (scalar("SELECT count(*) FROM public.profiles WHERE id::text LIKE '7d300000-%';") === '0') seed();
    check('before', runMatrix('before'));
    // The preflight refuses to apply over an existing from-scratch invoice with a product line.
    const dirty = scenario([{ key: 'preflight over a from-scratch product line', as: 'owner', stmt: `EXECUTE ${PREFLIGHT_EXEC}; v := 'applied';` }], legacy('801', 'misc_charge'));
    assert.match(dirty['preflight over a from-scratch product line'], /^P0001\|PREFLIGHT: an active invoice with no order or delivery already holds a product line/);
    console.log('[prover] PREFLIGHT: the apply is refused while an active from-scratch invoice holds a product line');
    stageText('candidate.sql', lf(CANDIDATE));
    const a = apply('candidate.sql');
    assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
    console.log('[prover] candidate applied');
  }
  check('after', runMatrix('after'));

  // Grants: the trigger function is reachable by no API role; the writer keeps owner-only EXECUTE.
  for (const fn of ['public._refuse_from_scratch_invoice_product_lines()', 'public._type_from_scratch_invoice_charge_lines()']) {
    assert.equal(scalar(`SELECT string_agg(r, ',' ORDER BY r) FROM unnest(ARRAY['anon','authenticated','service_role']) r WHERE has_function_privilege(r, '${fn}', 'EXECUTE');`), '', `${fn} is executable by an API role`);
  }
  assert.equal(scalar(`SELECT string_agg(r, ',' ORDER BY r) FROM unnest(ARRAY['anon','authenticated','service_role']) r WHERE has_function_privilege(r, '${WRITER}', 'EXECUTE');`), '');
  console.log('[prover] GRANTS: no API role can execute the trigger function or the writer');

  // Preflight: a drifted writer refuses the apply.
  const drift = scenario([{ key: 'preflight on a drifted writer', as: 'owner', stmt: `
    CREATE OR REPLACE FUNCTION ${WRITER.replace('(jsonb,jsonb,text)', '(p_invoice jsonb, p_items jsonb DEFAULT \'[]\'::jsonb, p_idempotency_key text DEFAULT NULL::text)')} RETURNS uuid LANGUAGE plpgsql AS $x$ BEGIN RETURN NULL; END $x$;
    EXECUTE ${PREFLIGHT_EXEC};
    v := 'applied';` }]);
  assert.match(drift['preflight on a drifted writer'], /^P0001\|PREFLIGHT: _save_invoice_lineage_unaware_impl_20260827 body drifted/);
  console.log('[prover] PREFLIGHT: a drifted writer body refuses the apply');

  await races();

  // MUTATION: without the item trigger the owner's direct insert goes through.
  const mutated = scenario([{ key: 'R6 without the trigger', as: 'owner', stmt: `
    DROP TRIGGER trg_refuse_from_scratch_invoice_product_lines ON public.invoice_items;
    INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, created_by) VALUES ('${id('905')}', 'PROVER-M-1', '${CUST}', 'misc_charge', 'draft', CURRENT_DATE, '${U.ADMIN}');
    INSERT INTO public.invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents) VALUES ('${id('905')}', '${PROD}', 'x', 1, 3000, 3000, 0);
    v := 'inserted';` }]);
  assert.equal(mutated['R6 without the trigger'], 'ok|inserted');
  console.log('[prover] MUTATION: with the invoice_items trigger dropped the direct product-line insert succeeds, so the trigger is what refuses it');

  console.log(`[prover] finished in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log('FROM_SCRATCH_CHARGE_LINES_PROOF_PASS');
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
