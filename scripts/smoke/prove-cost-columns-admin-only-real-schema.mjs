#!/usr/bin/env node
/**
 * Full-chain proof for the 20261022030000 candidate: the cost column lock on the remaining twelve
 * cost tables (Goal 1 part 3, step 3; cost and margin are admin-only, Mason 2026-10-15).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (cost
 * step 2, 20261019230000, and the purchase-order lock, 20261021141000, included), seeds one admin /
 * sales rep / driver / applicator, a customer + field, a product with a cost, a quote with an item
 * and a sent version, an order with an item, an invoice with an item, a job with chemicals (through
 * save_job), a blend ticket with a product and a commission, then runs one matrix BEFORE and AFTER
 * the candidate. Each scenario is one transaction that always rolls back; each step runs as a
 * PostgREST session (request.jwt.claims + SET LOCAL ROLE authenticated), a signed-out visitor
 * (anon), or the owner with the admin's JWT.
 *   1. Every cost column of all twelve tables, read by the rep, the admin and anon: readable BEFORE
 *      (anon only where it held table SELECT), permission denied AFTER.
 *   2. The screen column lists (src/lib/costFields.ts; quote_versions: the migration's own list)
 *      read the same rows for the rep, the admin and anon AFTER as BEFORE; `SELECT *` is refused.
 *   3. get_admin_cost_fields returns each table's seeded cost to the admin; get_quote_versions gives
 *      the admin the stored snapshot and the rep the cost-stripped one -- same before and after.
 *   4. A rep's direct INSERT/UPDATE naming a cost column is refused AFTER; the same write without
 *      the cost column touches the same rows before and after.
 *   5. anon keeps every non-cost column it had; every public view reads the same for every role
 *      before and after (view_unmigrated_products included), and no view reads a cost column or a
 *      whole locked row. Steps 1, 2 and 5 also run as the driver and the applicator; non-cost writes
 *      that return id / row_version still work, and one that returns a cost column is refused.
 *   6. save_job and save_quote (SECURITY DEFINER writers) still work for the rep and store the
 *      server-derived cost.
 *   7. Privilege diff: every (role, table, column, privilege) is unchanged except the cost columns
 *      (and the generated jobs.remaining_acres write grant); table-level DELETE/TRUNCATE/TRIGGER
 *      untouched (PUBLIC included). Preflight drift refuses: a new column on each table, either
 *      admin function missing, re-bodied, made INVOKER or re-granted, a role privilege lost or gained,
 *      a whole-row function executable by an API role, a cost or whole-row view; so does a run outside
 *      one transaction, before any change. A second apply succeeds and changes nothing.
 *   8. MUTATIONS: the candidate with the products REVOKE removed, with a non-cost column dropped
 *      from a grant list, and with a cost column added to one, each fails its own verify block.
 *
 * Run: node scripts/smoke/prove-cost-columns-admin-only-real-schema.mjs   (needs Docker)
 * Prints COST_COLUMNS_ADMIN_ONLY_PROOF_PASS on success. CRX_PROVER_VERBOSE=1 prints every step.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-cost-lock-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1' || REUSE;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261022030000_cost_columns_admin_only.sql');
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
// PR #889's data migrations rewrite live rows this disposable database does not have; they are
// recorded in the ledger (as live has them) instead of replayed.
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
]);
const LOCKED_TABLES = ['products', 'quotes', 'quote_items', 'quote_versions', 'orders', 'order_items', 'invoices', 'invoice_items', 'jobs', 'job_chemicals', 'blend_ticket_products', 'commissions'];
// A parked file that grants or revokes on, or alters, a locked table would change what this proof sees.
const TOUCHED = new RegExp(`(GRANT|REVOKE|ALTER\\s+TABLE)[^;]*\\b(public\\.)?(${LOCKED_TABLES.join('|')})\\b`, 'i');
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';

// The cost columns, written out by hand from the migration header (cross-checked against
// src/lib/costFields.ts below; quote_versions is not in that file).
const COST = {
  products: ['current_cost', 'cost_updated_date', 'tier1_margin', 'tier2_margin', 'tier3_margin', 'tier1_gross_margin', 'tier2_gross_margin', 'tier3_gross_margin'],
  quotes: ['total_cost', 'total_profit', 'total_margin_pct'],
  quote_items: ['current_cost', 'profit', 'net_margin', 'cost_at_quote_cents'],
  quote_versions: ['snapshot_data'],
  orders: ['total_cost', 'total_profit', 'total_margin_pct'],
  order_items: ['cost_per_unit', 'profit', 'net_margin', 'cost_at_time_cents'],
  invoices: ['total_cost_cents'],
  invoice_items: ['cost_cents', 'return_credit_cogs_cents'],
  jobs: ['total_cost_cents'],
  job_chemicals: ['cost_per_unit_cents'],
  blend_ticket_products: ['unit_cost_cents'],
  commissions: ['order_profit'],
};
const SCREEN = {
  products: screenColumns('PRODUCT_COLUMNS'),
  quotes: screenColumns('QUOTE_COLUMNS'),
  quote_items: screenColumns('QUOTE_ITEM_COLUMNS'),
  // No screen reads quote_versions directly (get_quote_versions does); the migration's grant list.
  quote_versions: 'id, quote_id, version_number, sent_by, sent_at, sent_method, pdf_url, notes, restore_trusted_at',
  orders: screenColumns('ORDER_COLUMNS'),
  order_items: screenColumns('ORDER_ITEM_COLUMNS'),
  invoices: screenColumns('INVOICE_COLUMNS'),
  invoice_items: screenColumns('INVOICE_ITEM_COLUMNS'),
  jobs: screenColumns('JOB_COLUMNS'),
  job_chemicals: screenColumns('JOB_CHEMICAL_COLUMNS'),
  blend_ticket_products: screenColumns('BLEND_TICKET_PRODUCT_COLUMNS'),
  commissions: screenColumns('COMMISSION_COLUMNS'),
};
// Tables anon held table-level SELECT on before the lock (the migration's own claim, proven below).
const ANON_TABLES = LOCKED_TABLES.filter((t) => !['quote_items', 'quote_versions'].includes(t));

function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psqlArgs(user = 'postgres') { return ['exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1']; }
function psql(sql, options = {}) { return docker(psqlArgs(options.user), { input: sql, allowFailure: options.allowFailure }); }
function scalar(sql) { return docker([...psqlArgs(), '-A', '-t'], { input: sql }).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''; }
function rows(sql) { return docker([...psqlArgs(), '-A', '-t', '-F', '|'], { input: sql }).stdout.trim().split(/\r?\n/).filter(Boolean); }
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
  // The candidate's preflight pins every column of every locked table, so any later file that adds
  // a column would already have to change it; a later file granting on these tables would undo it.
  for (const file of all.slice(at + 1)) {
    assert.ok(!TOUCHED.test(lf(file)), `${path.basename(file)} sorts after the candidate and grants on or alters a locked table; re-think this proof`);
  }
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!TOUCHED.test(lf(file)), `${name} now grants on or alters a locked table; replay it or re-think the skip`);
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
// FIDELITY: the hand-written cost lists match src/lib/costFields.ts and the candidate's verify list;
// the screen lists plus the cost lists are exactly each table's replayed columns.
function fidelity() {
  for (const [table, cols] of Object.entries(COST)) {
    if (table === 'quote_versions') continue;
    const m = COST_FIELDS.match(new RegExp(`\\n  ${table}: \\[([^\\]]+)\\]`));
    assert.ok(m, `COST_COLUMNS.${table} missing from costFields.ts`);
    assert.deepEqual(m[1].split(',').map((s) => s.trim().replaceAll("'", '')), cols, `cost columns of ${table} differ from costFields.ts`);
  }
  const verify = lf(CANDIDATE).split('$verify$')[1];
  const listed = [...verify.matchAll(/\('([a-z_]+)', '([a-z_0-9]+)'\)/g)].map((m) => `${m[1]}.${m[2]}`)
    .filter((x) => !['invoices.balance_cents', 'jobs.remaining_acres'].includes(x));
  assert.deepEqual(listed.sort(), Object.entries(COST).flatMap(([t, cs]) => cs.map((c) => `${t}.${c}`)).sort(), "the candidate's verify cost list differs from this proof's");
  for (const table of LOCKED_TABLES) {
    const live = scalar(`SELECT string_agg(attname, ',' ORDER BY attname) FROM pg_attribute WHERE attrelid = 'public.${table}'::regclass AND attnum > 0 AND NOT attisdropped;`);
    const ours = [...SCREEN[table].split(',').map((s) => s.trim()), ...COST[table]].sort().join(',');
    assert.equal(ours, live, `${table}: screen + cost columns are not the replayed table's columns`);
  }
  console.log(`[prover] FIDELITY: cost lists match costFields.ts and the candidate's verify block; screen + cost columns cover every replayed column of all ${LOCKED_TABLES.length} tables exactly`);
}

// ------------------------------------------------------------------------------------------------
// Fixtures (committed once; every probe rolls back).
const id = (n) => `7c400000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), REP: id('b1'), DRIVER: id('d1'), APPLICATOR: id('e1') };
const CUST = id('c1');
const FIELD = id('1e1');
const PROD = id('f1'); // current_cost 22.50 per gal, liquid
const QUOTE = id('501'); const QSEC = id('511'); const QI = id('512'); const QV = id('601');
const ORDER = id('701'); const OI = id('702');
const INV = id('301'); const INV_ITEM = id('302');
const BT = id('801'); const BTP = id('802');
const COMM = id('901');
const TODAY = "to_char(CURRENT_DATE, 'YYYY-MM-DD')";
const JOB = `(SELECT j.id FROM public.jobs j WHERE j.customer_id = '${CUST}' ORDER BY j.created_at LIMIT 1)`;
const JC = `(SELECT jc.id FROM public.job_chemicals jc WHERE jc.job_id = ${JOB} ORDER BY jc.sort_order LIMIT 1)`;

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
const jobChems = (ptCost, galCost) => j([
  { product_id: PROD, quantity: 10, unit: 'pt', rate_per_acre: 1, rate_unit: 'pt/ac', cost_per_unit_cents: ptCost, price_per_unit_cents: 400, sort_order: 0 },
  { product_id: PROD, quantity: 10, unit: 'gal', rate_per_acre: 1, rate_unit: 'gal/ac', cost_per_unit_cents: galCost, price_per_unit_cents: 3000, sort_order: 1 },
]);
const JOB_FIELDS = j([{ field_id: FIELD, acres_to_treat: 10, sort_order: 0 }]);
const saveJob = (jobId, actor, ptCost, galCost) => `public.save_job(${jobId}, jsonb_build_object('customer_id', '${CUST}', 'job_date', ${TODAY}), ${JOB_FIELDS}, ${jobChems(ptCost, galCost)}, '${actor}', NULL)->>'success'`;

function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.REP, 'sales_rep', 'Rep', 8], [U.DRIVER, 'driver', 'Driver', 6], [U.APPLICATOR, 'applicator', 'Applicator', 5]];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  // Each part is skipped when it is already there (a reused dev container), so a failed part re-runs alone.
  if (scalar(`SELECT count(*) FROM public.invoice_items WHERE id = '${INV_ITEM}';`) === '0') psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'cost-lock-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] Cost Lock ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    ${claims(U.ADMIN)}
    INSERT INTO public.customers (id, farm_name, is_active, email) VALUES ('${CUST}', '[PROVER] Cost Lock Farm', true, 'c1@example.invalid');
    INSERT INTO public.fields (id, customer_id, field_name, total_acres) VALUES ('${FIELD}', '${CUST}', '[PROVER] Field', 100);
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, tier1_margin, product_form, is_active) VALUES
      ('${PROD}', '[PROVER] Lock Chem', 'gal', 22.50, 30.00, 25, 'liquid', true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.quotes (id, quote_number, customer_id, created_by, salesman_id, status, total_price, total_cost, total_profit, total_margin_pct)
      VALUES ('${QUOTE}', 'PROVER-LOCK-Q-1', '${CUST}', '${U.REP}', '${U.REP}', 'draft', 60, 45, 15, 25);
    INSERT INTO public.quote_sections (id, quote_id, section_name, sort_order) VALUES ('${QSEC}', '${QUOTE}', 'S1', 0);
    INSERT INTO public.quote_items (id, quote_id, section_id, product_id, price_per_unit, current_cost, total_units_needed, unit_size, total_price, sort_order)
      VALUES ('${QI}', '${QUOTE}', '${QSEC}', '${PROD}', 30.00, 22.50, 2, 'gal', 60.00, 0);
    INSERT INTO public.quote_versions (id, quote_id, version_number, sent_by, snapshot_data) VALUES ('${QV}', '${QUOTE}', 1, '${U.REP}', ${j(SNAPSHOT)});
    SELECT set_config('app.crx_below_cost_operation', 'create_direct_order', true);
    INSERT INTO public.orders (id, order_number, customer_id, salesman_id, status, order_date) VALUES ('${ORDER}', 'PROVER-LOCK-ORD-1', '${CUST}', '${U.REP}', 'confirmed', CURRENT_DATE);
    INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, price_per_unit, total_units_needed, total_price, cost_per_unit)
      VALUES ('${OI}', '${ORDER}', '${PROD}', '[PROVER] Chem', 'gal', 30.00, 2, 60.00, 22.50);
    INSERT INTO public.invoices (id, invoice_number, order_id, customer_id, salesman_id, invoice_type, status, invoice_date, created_by) VALUES
      ('${INV}', 'PROVER-LOCK-SI-1', '${ORDER}', '${CUST}', '${U.REP}', 'chemical_sale', 'draft', CURRENT_DATE, '${U.ADMIN}');
    INSERT INTO public.invoice_items (id, invoice_id, product_id, description, quantity, unit_price_cents, extended_cents, cost_cents, sort_order, is_application_fee) VALUES
      ('${INV_ITEM}', '${INV}', '${PROD}', '[PROVER] Chem', 2, 3000, 6000, 2250, 0, false);
    COMMIT;`);
  // The job and its chemicals through the real writer (as the admin, so the sent cost is stored).
  if (scalar(`SELECT count(*) FROM public.jobs WHERE customer_id = '${CUST}';`) === '0') psql(`BEGIN;
    ${claims(U.ADMIN)}
    SELECT ${saveJob('NULL', U.ADMIN, 300, 2000)};
    COMMIT;`);
  if (scalar(`SELECT count(*) FROM public.commissions WHERE id = '${COMM}';`) === '0') psql(`BEGIN;
    ${claims(U.ADMIN)}
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.blend_tickets (id, ticket_number, uploaded_by, customer_id, status) VALUES ('${BT}', 'PROVER-LOCK-BT-1', '${U.REP}', '${CUST}', 'pending');
    INSERT INTO public.blend_ticket_products (id, blend_ticket_id, product_id, product_name, quantity, unit, unit_cost_cents, unit_price_cents, sequence_order)
      VALUES ('${BTP}', '${BT}', '${PROD}', '[PROVER] Chem', 2, 'gal', 2250, 3000, 0);
    INSERT INTO public.commissions (id, order_id, customer_id, recipient, recipient_user_id, split_percentage, commission_amount, order_profit, status, order_date)
      VALUES ('${COMM}', '${ORDER}', '${CUST}', '[PROVER] Rep', '${U.REP}', 100, 150, 1500, 'pending', CURRENT_DATE);
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7c400000-%';`),
    'admin:true,sales_rep:true,driver:true,applicator:true', 'the seeded roles are not what the proof needs');
  assert.equal(scalar(`SELECT (SELECT string_agg(jc.cost_per_unit_cents::text, ',' ORDER BY jc.sort_order) FROM public.job_chemicals jc WHERE jc.job_id = ${JOB}) || '|' || (SELECT total_cost_cents FROM public.jobs WHERE id = ${JOB});`), '300,2000|23000');
  assert.equal(scalar(`SELECT snapshot_data = ${j(SNAPSHOT)} FROM public.quote_versions WHERE id = '${QV}';`), 't');
  console.log('[prover] seeded admin / sales rep / driver / applicator, a customer + field, a product, a quote + item + version, an order + item, an invoice + item, a job + 2 chemicals (save_job), a blend ticket + product, a commission');
}

// ------------------------------------------------------------------------------------------------
// Probes: one transaction per scenario, always rolled back. Each step runs as a role inside its own
// sub-transaction, so a refused step leaves the scenario going. A step yields "ok|<value>" or
// "<sqlstate>|<message>".
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
DECLARE v text; n bigint;
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
  assert.equal(r.status, 0, `scenario failed to run:\n${r.stderr}\n--- SQL ---\n${text.slice(0, 4000)}`);
  const out = {};
  for (const m of r.stderr.matchAll(/RESULT\|([^|\n]+)\|([^\n]*)/g)) out[m[1]] = m[2].trimEnd();
  for (const s of steps) assert.ok(s.key in out, `step ${s.key} printed no RESULT:\n${r.stderr}`);
  return out;
}

const DENIED_TABLE = (table) => new RegExp(`^42501\\|permission denied for table ${table}$`);
const OK = /^ok\|/;
const SEES_ROWS = /^ok\|\d+\/[1-9]\d*$/;
const ANON_BEFORE = /^ok\|0(\/0)?$|^42501\|permission denied for function is_admin$/;
const ACF = (table, rowId) => `public.get_admin_cost_fields('${table}', ARRAY[${rowId}]::uuid[]) -> (${rowId})::text`;
const ROLES = [['rep', U.REP], ['admin', U.ADMIN], ['anon', 'anon'], ['driver', U.DRIVER], ['applicator', U.APPLICATOR]];
// The driver and applicator see whatever their row policies allow (possibly nothing, or a policy
// helper they may not run); the privilege change is what this proof measures for them.
const STAFF_BEFORE = /^ok\|\d+(\/\d+)?$|^42501\|permission denied for function \w+$/;
const beforeFor = (label, table, seen) => (label === 'rep' || label === 'admin' ? seen
  : label !== 'anon' ? STAFF_BEFORE : !ANON_TABLES.includes(table) ? DENIED_TABLE(table) : ANON_BEFORE);
// "<rows touched>" for a write statement.
const write = (sql) => ({ stmt: `${sql}; GET DIAGNOSTICS n = ROW_COUNT; v := n::text;` });

/**
 * Scenarios. Each step: [key, as, call|{stmt}, before, after]. before/after: a RegExp, an exact
 * string, or 'same' (after: identical to what BEFORE actually returned).
 */
function buildScenarios() {
  const s1 = [];
  for (const [label, as] of ROLES) {
    for (const [table, cols] of Object.entries(COST)) {
      for (const col of cols) {
        // The rep and admin see at least one seeded row before. anon never held SELECT on quote_items /
        // quote_versions (refused in both phases); on invoices / invoice_items anon's read already
        // failed before in the RLS policy (anon may not execute is_admin()); its column grant is
        // proven by the privilege snapshot instead.
        const before = beforeFor(label, table, SEES_ROWS);
        s1.push([`${label} reads ${table}.${col}`, as, `(SELECT count(t.${col}) || '/' || count(*) FROM public.${table} t)`, before, DENIED_TABLE(table)]);
      }
    }
  }
  const s2 = [];
  for (const [label, as] of ROLES) {
    for (const table of LOCKED_TABLES) {
      const before = beforeFor(label, table, /^ok\|[1-9]\d*$/);
      s2.push([`${label} reads the ${table} screen columns`, as, `(SELECT count(*) FROM (SELECT ${SCREEN[table]} FROM public.${table}) s)`, before, 'same']);
      s2.push([`${label} reads ${table} with *`, as, `(SELECT count(*) FROM (SELECT t.* FROM public.${table} t) s)`, before, DENIED_TABLE(table)]);
    }
  }
  const s3 = [
    ['admin products', U.ADMIN, `round((${ACF('products', `'${PROD}'`)}->>'current_cost')::numeric, 2) || ':' || (${ACF('products', `'${PROD}'`)}->>'tier1_margin')`, 'ok|22.50:25', 'same'],
    ['admin quotes', U.ADMIN, `round((${ACF('quotes', `'${QUOTE}'`)}->>'total_cost')::numeric, 2)`, 'ok|45.00', 'same'],
    ['admin quote_items', U.ADMIN, `round((${ACF('quote_items', `'${QI}'`)}->>'current_cost')::numeric, 2)`, 'ok|22.50', 'same'],
    ['admin orders', U.ADMIN, `${ACF('orders', `'${ORDER}'`)}->>'total_cost'`, OK, 'same'],
    ['admin order_items', U.ADMIN, `round((${ACF('order_items', `'${OI}'`)}->>'cost_per_unit')::numeric, 2)`, 'ok|22.50', 'same'],
    ['admin invoices', U.ADMIN, `${ACF('invoices', `'${INV}'`)}->>'total_cost_cents'`, OK, 'same'],
    ['admin invoice_items', U.ADMIN, `${ACF('invoice_items', `'${INV_ITEM}'`)}->>'cost_cents'`, 'ok|2250', 'same'],
    ['admin jobs', U.ADMIN, `${ACF('jobs', JOB)}->>'total_cost_cents'`, 'ok|23000', 'same'],
    ['admin job_chemicals', U.ADMIN, `${ACF('job_chemicals', JC)}->>'cost_per_unit_cents'`, 'ok|300', 'same'],
    ['admin blend_ticket_products', U.ADMIN, `${ACF('blend_ticket_products', `'${BTP}'`)}->>'unit_cost_cents'`, 'ok|2250', 'same'],
    ['admin commissions', U.ADMIN, `${ACF('commissions', `'${COMM}'`)}->>'order_profit'`, /^ok\|1500(\.00)?$/, 'same'],
    ['rep is refused get_admin_cost_fields', U.REP, `${ACF('products', `'${PROD}'`)}->>'current_cost'`, /^P0001\|Permission denied: requires admin role$/, 'same'],
    ['admin get_quote_versions: the stored snapshot', U.ADMIN, `(SELECT snapshot_data = ${j(SNAPSHOT)} FROM public.get_quote_versions('${QUOTE}'))`, 'ok|true', 'same'],
    ['rep get_quote_versions: the cost-free snapshot', U.REP, `(SELECT snapshot_data = ${j(SNAPSHOT_FOR_REP)} FROM public.get_quote_versions('${QUOTE}'))`, 'ok|true', 'same'],
    ['rep get_quote_versions: the row', U.REP, `(SELECT count(*) || ':' || max(version_number) FROM public.get_quote_versions('${QUOTE}'))`, 'ok|1:1', 'same'],
  ];
  const s4 = [
    // Writes that name a cost column: refused by privilege AFTER (before: whatever RLS allowed).
    ['rep UPDATE job_chemicals.cost_per_unit_cents', U.REP, write(`UPDATE public.job_chemicals SET cost_per_unit_cents = 1 WHERE id = ${JC}`), OK, DENIED_TABLE('job_chemicals')],
    ['rep INSERT job_chemicals with cost_per_unit_cents', U.REP, write(`INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, cost_per_unit_cents, price_per_unit_cents, sort_order) VALUES (${JOB}, '${PROD}', 1, 'gal', 1, 3000, 9)`), OK, DENIED_TABLE('job_chemicals')],
    ['rep UPDATE jobs.total_cost_cents', U.REP, write(`UPDATE public.jobs SET total_cost_cents = 1 WHERE id = ${JOB}`), OK, DENIED_TABLE('jobs')],
    ['rep UPDATE quotes.total_cost (own quote)', U.REP, write(`UPDATE public.quotes SET total_cost = 1 WHERE id = '${QUOTE}'`), OK, DENIED_TABLE('quotes')],
    ['rep INSERT quotes with total_cost', U.REP, write(`INSERT INTO public.quotes (quote_number, customer_id, created_by, status, total_cost) VALUES ('PROVER-Q-X', '${CUST}', '${U.REP}', 'draft', 1)`), OK, DENIED_TABLE('quotes')],
    ['rep UPDATE orders.total_cost', U.REP, write(`UPDATE public.orders SET total_cost = 1 WHERE id = '${ORDER}'`), OK, DENIED_TABLE('orders')],
    ['rep UPDATE blend_ticket_products.unit_cost_cents', U.REP, write(`UPDATE public.blend_ticket_products SET unit_cost_cents = 1 WHERE id = '${BTP}'`), OK, DENIED_TABLE('blend_ticket_products')],
    ['rep UPDATE commissions.order_profit', U.REP, write(`UPDATE public.commissions SET order_profit = 1 WHERE id = '${COMM}'`), OK, DENIED_TABLE('commissions')],
    ['rep INSERT orders with total_cost', U.REP, write(`PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true); INSERT INTO public.orders (order_number, customer_id, salesman_id, status, order_date, total_cost) VALUES ('PROVER-LOCK-ORD-X', '${CUST}', '${U.REP}', 'confirmed', CURRENT_DATE, 1)`), OK, DENIED_TABLE('orders')],
    ['admin UPDATE orders.total_cost', U.ADMIN, write(`UPDATE public.orders SET total_cost = 1 WHERE id = '${ORDER}'`), 'ok|1', DENIED_TABLE('orders')],
    ['admin UPDATE commissions.order_profit', U.ADMIN, write(`UPDATE public.commissions SET order_profit = 1 WHERE id = '${COMM}'`), 'ok|1', DENIED_TABLE('commissions')],
    ['admin UPDATE quotes.total_cost', U.ADMIN, write(`UPDATE public.quotes SET total_cost = 1 WHERE id = '${QUOTE}'`), OK, DENIED_TABLE('quotes')],
    ['admin UPDATE job_chemicals.cost_per_unit_cents', U.ADMIN, write(`UPDATE public.job_chemicals SET cost_per_unit_cents = 1 WHERE id = ${JC}`), OK, DENIED_TABLE('job_chemicals')],
    // A non-cost write that asks for a cost column back (what `.update().select('total_cost')` sends).
    ['rep UPDATE orders.notes RETURNING total_cost', U.REP, { stmt: `UPDATE public.orders SET notes = 'prover' WHERE id = '${ORDER}' RETURNING total_cost::text INTO v;` }, OK, DENIED_TABLE('orders')],
    ['admin UPDATE quotes.header_notes RETURNING total_cost', U.ADMIN, { stmt: `UPDATE public.quotes SET header_notes = 'prover' WHERE id = '${QUOTE}' RETURNING total_cost::text INTO v;` }, OK, DENIED_TABLE('quotes')],
    ['stored costs unchanged by the refused writes', 'owner', `(SELECT total_cost::text FROM public.quotes WHERE id = '${QUOTE}') || ':' || (SELECT cost_per_unit_cents FROM public.job_chemicals WHERE id = ${JC})`, OK, 'ok|45:300'],
  ];
  const s5 = [
    // The same writes without the cost column: the rows touched are the same before and after.
    ['rep UPDATE quotes.header_notes (own quote)', U.REP, write(`UPDATE public.quotes SET header_notes = 'prover' WHERE id = '${QUOTE}'`), 'ok|1', 'same'],
    ['rep INSERT quotes without cost', U.REP, write(`INSERT INTO public.quotes (quote_number, customer_id, created_by, salesman_id, status) VALUES ('PROVER-Q-Y', '${CUST}', '${U.REP}', '${U.REP}', 'draft')`), OK, 'same'],
    ['rep UPDATE job_chemicals.vendor', U.REP, write(`UPDATE public.job_chemicals SET vendor = 'prover' WHERE id = ${JC}`), OK, 'same'],
    ['rep INSERT job_chemicals without cost', U.REP, write(`INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, price_per_unit_cents, sort_order) VALUES (${JOB}, '${PROD}', 1, 'gal', 3000, 9)`), OK, 'same'],
    ['rep UPDATE jobs.notes', U.REP, write(`UPDATE public.jobs SET notes = 'prover' WHERE id = ${JOB}`), OK, 'same'],
    ['rep UPDATE orders.notes', U.REP, write(`UPDATE public.orders SET notes = 'prover' WHERE id = '${ORDER}'`), OK, 'same'],
    ['rep UPDATE blend_ticket_products.lot_number', U.REP, write(`UPDATE public.blend_ticket_products SET lot_number = 'L1' WHERE id = '${BTP}'`), OK, 'same'],
    ['rep UPDATE commissions.paid_note', U.REP, write(`UPDATE public.commissions SET paid_note = 'prover' WHERE id = '${COMM}'`), OK, 'same'],
    ['admin UPDATE quotes.header_notes', U.ADMIN, write(`UPDATE public.quotes SET header_notes = 'prover' WHERE id = '${QUOTE}'`), 'ok|1', 'same'],
    ['admin UPDATE jobs.notes', U.ADMIN, write(`UPDATE public.jobs SET notes = 'prover' WHERE id = ${JOB}`), 'ok|1', 'same'],
    ['rep INSERT orders without cost', U.REP, write(`PERFORM set_config('app.crx_below_cost_operation', 'create_direct_order', true); INSERT INTO public.orders (order_number, customer_id, salesman_id, status, order_date) VALUES ('PROVER-LOCK-ORD-Y', '${CUST}', '${U.REP}', 'confirmed', CURRENT_DATE)`), OK, 'same'],
    ['admin UPDATE orders.notes', U.ADMIN, write(`UPDATE public.orders SET notes = 'prover' WHERE id = '${ORDER}'`), 'ok|1', 'same'],
    ['admin UPDATE commissions.paid_note', U.ADMIN, write(`UPDATE public.commissions SET paid_note = 'prover' WHERE id = '${COMM}'`), 'ok|1', 'same'],
    ['admin UPDATE blend_ticket_products.lot_number', U.ADMIN, write(`UPDATE public.blend_ticket_products SET lot_number = 'L2' WHERE id = '${BTP}'`), 'ok|1', 'same'],
    // What PostgREST sends for `.update(...).select('id')` / `.select('id, row_version')`.
    ['rep UPDATE quotes.header_notes RETURNING id, row_version', U.REP, { stmt: `UPDATE public.quotes SET header_notes = 'prover' WHERE id = '${QUOTE}' RETURNING id::text || ':' || (row_version IS NOT NULL) INTO v;` }, `ok|${QUOTE}:true`, 'same'],
    ['rep UPDATE jobs.notes RETURNING id', U.REP, { stmt: `UPDATE public.jobs SET notes = 'prover' WHERE id = ${JOB} RETURNING (id IS NOT NULL)::text INTO v;` }, OK, 'same'],
    ['admin UPDATE orders.notes RETURNING id', U.ADMIN, { stmt: `UPDATE public.orders SET notes = 'prover' WHERE id = '${ORDER}' RETURNING id::text INTO v;` }, `ok|${ORDER}`, 'same'],
  ];
  const s6 = [
    ['anon reads view_unmigrated_products', 'anon', '(SELECT count(*) FROM public.view_unmigrated_products)', OK, 'same'],
    ['rep reads view_unmigrated_products', U.REP, '(SELECT count(*) FROM public.view_unmigrated_products)', OK, 'same'],
    ['admin reads view_unmigrated_products', U.ADMIN, '(SELECT count(*) FROM public.view_unmigrated_products)', OK, 'same'],
  ];
  // Every public view, read whole: "<views that fail>:<sqlstate>" for each role (same before and after).
  const VIEWS = { stmt: `DECLARE r record; bad text := ''; c bigint; BEGIN
      FOR r IN SELECT c2.relname FROM pg_class c2 WHERE c2.relnamespace = 'public'::regnamespace AND c2.relkind = 'v' ORDER BY 1 LOOP
        BEGIN EXECUTE format('SELECT count(*) FROM (SELECT * FROM public.%I LIMIT 50) s', r.relname) INTO c;
        EXCEPTION WHEN OTHERS THEN bad := bad || r.relname || ':' || SQLSTATE || ' '; END;
      END LOOP; v := (SELECT count(*) FROM pg_class c3 WHERE c3.relnamespace = 'public'::regnamespace AND c3.relkind = 'v') || ' views; failing: ' || COALESCE(NULLIF(bad, ''), 'none'); END;` };
  for (const [label, as] of ROLES) s6.push([`${label} reads every public view`, as, VIEWS, OK, 'same']);
  // No view or materialized view reads a cost column or a whole locked row (the candidate's preflight
  // refuses one; this shows the replayed schema has none, before and after).
  s6.push(['no view reads a cost column or a whole locked row', 'owner', `(SELECT count(*) FROM pg_depend d
      JOIN pg_rewrite rw ON rw.oid = d.objid JOIN pg_class v ON v.oid = rw.ev_class AND v.relkind IN ('v', 'm')
      JOIN pg_class src ON src.oid = d.refobjid AND src.relnamespace = 'public'::regnamespace
      LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
     WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass AND v.oid <> src.oid
       AND src.relname IN (${LOCKED_TABLES.map((t) => `'${t}'`).join(', ')})
       AND (d.refobjsubid = 0 OR (src.relname || '.' || a.attname) IN (${Object.entries(COST).flatMap(([t, cs]) => cs.map((c) => `'${t}.${c}'`)).join(', ')})))`, 'ok|0', 'same']);
  const JOB_STORED = (job) => `(SELECT string_agg(jc.cost_per_unit_cents::text, ',' ORDER BY jc.sort_order) FROM public.job_chemicals jc WHERE jc.job_id = ${job}) || '|' || (SELECT j2.total_cost_cents FROM public.jobs j2 WHERE j2.id = ${job})`;
  const NEWJOB = `(SELECT j.id FROM public.jobs j WHERE j.customer_id = '${CUST}' ORDER BY j.created_at DESC, j.id LIMIT 1)`;
  const NEWQ = "(SELECT q.id FROM public.quotes q WHERE q.quote_number = 'PROVER-Q-SAVE')";
  const saveQuote = (actor) => `public.save_quote(NULL, jsonb_build_object('customer_id', '${CUST}', 'quote_number', 'PROVER-Q-SAVE'),
      jsonb_build_array(jsonb_build_object('section_name', 'S', 'items', jsonb_build_array(jsonb_build_object('product_id', '${PROD}', 'price_per_unit', 30, 'total_units_needed', 2, 'unit_size', 'gal', 'calc_mode', 'units', 'current_cost', 1)))), '${actor}', NULL) ? 'quote_id'`;
  const s7 = [
    ['rep save_job: create, cost 0 sent', U.REP, saveJob('NULL', U.REP, 0, 0), 'ok|true', 'same'],
    ['stored: server-derived cost', 'owner', JOB_STORED(NEWJOB), 'ok|281,2250|25310', 'same'],
    ['rep save_job: re-save the admin job sending 999', U.REP, saveJob(JOB, U.REP, 999, 999), 'ok|true', 'same'],
    ['stored: the admin cost kept', 'owner', JOB_STORED(JOB), 'ok|300,2000|23000', 'same'],
    ['rep save_quote: create', U.REP, saveQuote(U.REP), 'ok|true', 'same'],
    ['stored: quote total_cost from the catalog', 'owner', `(SELECT total_cost::text FROM public.quotes WHERE id = ${NEWQ}) || ':' || (SELECT string_agg(current_cost::text, ',') FROM public.quote_items WHERE quote_id = ${NEWQ})`, /^ok\|[\d.]+:22\.50*$/, 'same'],
  ];
  return [
    { name: '1. cost column reads', steps: s1 },
    { name: '2. screen column reads', steps: s2 },
    { name: '3. admin cost functions', steps: s3 },
    { name: '4. cost writes', steps: s4 },
    { name: '5. non-cost writes', steps: s5 },
    { name: '6. views', steps: s6 },
    { name: '7. SECURITY DEFINER writers', steps: s7 },
  ];
}
const SCENARIOS = buildScenarios();

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
function check(phase, results, before = null) {
  const failures = [];
  const lines = [];
  for (const sc of SCENARIOS) {
    for (const step of sc.steps) {
      const label = `${sc.name} / ${step[0]}`;
      const got = results[label];
      let want = phase === 'before' ? step[3] : step[4];
      if (want === 'same') want = before[label];
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
// Privileges: every (role, table, column, privilege) and every table-level privilege.
// PUBLIC is no pg_roles row; has_*_privilege accepts it as the name 'public'.
const PRIV_ROLES = "SELECT rolname::text FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'metabase_ro') UNION ALL SELECT 'public'";
function privileges() {
  const tables = LOCKED_TABLES.map((t) => `'${t}'`).join(', ');
  const col = rows(`SELECT c.relname || '.' || a.attname || '|' || r.rolname || '|' || p.priv || '|' || has_column_privilege(r.rolname, c.oid, a.attname, p.priv)
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      CROSS JOIN (${PRIV_ROLES}) r CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${tables}) ORDER BY 1;`);
  const tbl = rows(`SELECT c.relname || '|' || r.rolname || '|' || p.priv || '|' || has_table_privilege(r.rolname, c.oid, p.priv)
      FROM pg_class c CROSS JOIN (${PRIV_ROLES}) r CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p(priv)
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN (${tables}) ORDER BY 1;`);
  const map = (list) => new Map(list.map((l) => { const [obj, role, priv, has] = l.split('|'); return [`${obj}|${role}|${priv}`, has === 'true' ? 't' : 'f']; }));
  return { col: map(col), tbl: map(tbl) };
}
const GENERATED = new Set(['jobs.remaining_acres', 'invoices.balance_cents']);
function privilegeDiff(before, after) {
  const isCost = (obj) => { const [t, c] = obj.split('.'); return (COST[t] ?? []).includes(c); };
  const lost = [];
  const unexpected = [];
  for (const [k, b] of before.col) {
    const a = after.col.get(k);
    const [obj, role, priv] = k.split('|');
    if (a === b) {
      if (isCost(obj) && ['anon', 'authenticated'].includes(role) && a === 't') unexpected.push(`${k}: still granted`);
      continue;
    }
    if (b === 't' && a === 'f' && ['anon', 'authenticated'].includes(role) && (isCost(obj) || (GENERATED.has(obj) && ['INSERT', 'UPDATE'].includes(priv)))) lost.push(k);
    else unexpected.push(`${k}: ${b} -> ${a}`);
  }
  for (const [k, b] of before.tbl) {
    const a = after.tbl.get(k);
    const [, role, priv] = k.split('|');
    if (a === b) continue;
    // Table-level SELECT/INSERT/UPDATE/REFERENCES (which imply every column) may only go away.
    if (b === 't' && a === 'f' && ['anon', 'authenticated'].includes(role) && ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'].includes(priv)) continue;
    unexpected.push(`table ${k}: ${b} -> ${a}`);
  }
  assert.deepEqual(unexpected, [], `privileges changed beyond the cost columns:\n  ${unexpected.join('\n  ')}`);
  for (const g of GENERATED) {
    const [t, c] = g.split('.');
    assert.equal(scalar(`SELECT attgenerated FROM pg_attribute WHERE attrelid = 'public.${t}'::regclass AND attname = '${c}';`), 's', `${g} is not a generated column`);
  }
  const costLost = lost.filter((k) => isCost(k.split('|')[0]));
  // Every cost column lost exactly what anon / authenticated held on it before, and nothing else.
  for (const [table, cols] of Object.entries(COST)) {
    for (const c of cols) {
      for (const role of ['anon', 'authenticated']) {
        for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
          assert.equal(after.col.get(`${table}.${c}|${role}|${priv}`), 'f', `${role} ${priv} on ${table}.${c} is still granted`);
        }
      }
    }
  }
  const held = (role, priv) => costLost.filter((k) => k.endsWith(`|${role}|${priv}`)).length;
  console.log(`[prover] PRIVILEGE DIFF: only cost columns lost privileges (authenticated SELECT ${held('authenticated', 'SELECT')}, REFERENCES ${held('authenticated', 'REFERENCES')}, INSERT ${held('authenticated', 'INSERT')}, UPDATE ${held('authenticated', 'UPDATE')}; anon SELECT ${held('anon', 'SELECT')}), plus the generated ${[...lost].filter((k) => !isCost(k.split('|')[0])).map((k) => k.split('|').slice(0, 1).concat(k.split('|')[2]).join(' ')).join(', ') || 'none'}; every other column and table privilege of every role is unchanged`);
  return lost;
}

// ------------------------------------------------------------------------------------------------
function preflightRefusesDrift() {
  stageText('cand.sql', lf(CANDIDATE));
  const cases = [
    ...LOCKED_TABLES.map((t) => [`ALTER TABLE public.${t} ADD COLUMN zz_prover_new text;`, new RegExp(`COST_LOCK_PREFLIGHT: ${t} columns are not the ones this grant list covers`)]),
    ['ALTER TABLE public.products DROP COLUMN tier3_gross_margin;', /COST_LOCK_PREFLIGHT: products columns are not the ones/],
    ['DROP FUNCTION public.get_admin_cost_fields(text, uuid[]);', /COST_LOCK_PREFLIGHT: get_admin_cost_fields\(text, uuid\[\]\) is missing/],
    ['DROP FUNCTION public.get_quote_versions(uuid);', /COST_LOCK_PREFLIGHT: get_quote_versions\(uuid\) is missing/],
    // A role lost a privilege outside a migration: the lock must not hand it back on the non-cost columns.
    ['REVOKE SELECT ON public.invoices FROM anon;', /COST_LOCK_PREFLIGHT: table privileges are not the ones[^\n]*anon SELECT invoices: held f, expected t/],
    // A role gained one: the lock was not written for it.
    ['GRANT INSERT ON public.invoices TO authenticated;', /COST_LOCK_PREFLIGHT: table privileges are not the ones[^\n]*authenticated INSERT invoices: held t, expected f/],
    ['GRANT REFERENCES (id) ON public.quote_versions TO authenticated;', /COST_LOCK_PREFLIGHT: table privileges are not the ones[^\n]*authenticated REFERENCES quote_versions: held t, expected f/],
    // A role narrowed to a few columns: "held on some column" must not let the lock widen it back.
    ['REVOKE SELECT ON public.invoices FROM authenticated; GRANT SELECT (id) ON public.invoices TO authenticated;',
      /COST_LOCK_PREFLIGHT: a role holds a privilege on only some non-cost columns[^\n]*authenticated SELECT invoices\.application_date/],
    ['REVOKE UPDATE ON public.jobs FROM authenticated; GRANT UPDATE (notes) ON public.jobs TO authenticated;',
      /COST_LOCK_PREFLIGHT: a role holds a privilege on only some non-cost columns[^\n]*authenticated UPDATE jobs\.additional_info/],
    // A PostgREST computed field (whole-row argument) the lock would break for every role.
    ["CREATE FUNCTION public.zz_prover_rowfn(p public.invoices) RETURNS int LANGUAGE sql STABLE AS 'SELECT 1'; GRANT EXECUTE ON FUNCTION public.zz_prover_rowfn(public.invoices) TO authenticated;",
      /COST_LOCK_PREFLIGHT: these API-executable functions take a whole locked row[^\n]*zz_prover_rowfn\(invoices\)/],
    ["CREATE FUNCTION public.zz_prover_rowfn(p public.order_items) RETURNS int LANGUAGE sql STABLE AS 'SELECT 1'; REVOKE ALL ON FUNCTION public.zz_prover_rowfn(public.order_items) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.zz_prover_rowfn(public.order_items) TO anon;",
      /COST_LOCK_PREFLIGHT: these API-executable functions take a whole locked row[^\n]*zz_prover_rowfn\(order_items\)/],
    // Views: a cost column, and a whole locked row.
    ['CREATE VIEW public.zz_prover_cost_view AS SELECT id, current_cost FROM public.products;', /COST_LOCK_PREFLIGHT: a view reads a cost column or a whole locked row: zz_prover_cost_view reads products\.current_cost/],
    ['CREATE VIEW public.zz_prover_row_view AS SELECT c FROM public.commissions c;', /COST_LOCK_PREFLIGHT: a view reads a cost column or a whole locked row: zz_prover_row_view reads commissions\.\*/],
    // The two admin readers: mode, grants, body.
    ['ALTER FUNCTION public.get_quote_versions(uuid) SECURITY INVOKER;', /COST_LOCK_PREFLIGHT: not the reviewed admin-checked SECURITY DEFINER bodies and grants: public\.get_quote_versions\(uuid\)/],
    ['GRANT EXECUTE ON FUNCTION public.get_admin_cost_fields(text, uuid[]) TO anon;', /COST_LOCK_PREFLIGHT: not the reviewed admin-checked SECURITY DEFINER bodies and grants: public\.get_admin_cost_fields\(text,uuid\[\]\)/],
    ['REVOKE EXECUTE ON FUNCTION public.get_quote_versions(uuid) FROM authenticated;', /COST_LOCK_PREFLIGHT: not the reviewed admin-checked SECURITY DEFINER bodies and grants: public\.get_quote_versions\(uuid\)/],
    [`DO $b$ BEGIN EXECUTE format('CREATE OR REPLACE FUNCTION public.get_admin_cost_fields(p_table text, p_ids uuid[]) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS %L', (SELECT prosrc FROM pg_proc WHERE oid = 'public.get_admin_cost_fields(text,uuid[])'::regprocedure) || E'\\n-- prover: any body edit\\n'); END $b$;`,
      /COST_LOCK_PREFLIGHT: not the reviewed admin-checked SECURITY DEFINER bodies and grants: public\.get_admin_cost_fields\(text,uuid\[\]\)/],
  ];
  for (const [setup, refusal] of cases) {
    const d = docker([...psqlArgs()], { input: `BEGIN;\n${setup}\n\\i /tmp/cand.sql\nROLLBACK;`, allowFailure: true });
    assert.notEqual(d.status, 0, `the candidate applied over: ${setup}`);
    assert.match(d.stderr, refusal, `wrong refusal for ${setup}:\n${d.stderr}`);
  }
  // Under autocommit (no single transaction) the file refuses before its first REVOKE, so nothing
  // half-applies: every table-level privilege is still exactly as it was.
  const privPre = privileges();
  const auto = docker([...psqlArgs()], { input: '\\i /tmp/cand.sql\n', allowFailure: true });
  assert.notEqual(auto.status, 0, 'the candidate ran under autocommit');
  assert.match(auto.stderr, /COST_LOCK_NOT_IN_TRANSACTION/, `wrong autocommit refusal:\n${auto.stderr}`);
  const privPost = privileges();
  assert.deepEqual([...privPost.tbl].filter(([k, v]) => privPre.tbl.get(k) !== v), [], 'the autocommit refusal changed a table privilege');
  assert.deepEqual([...privPost.col].filter(([k, v]) => privPre.col.get(k) !== v), [], 'the autocommit refusal changed a column privilege');
  console.log(`[prover] PREFLIGHT: ${cases.length} drifted states each abort the candidate (a new column on each of the ${LOCKED_TABLES.length} tables, a dropped column, either admin function missing, a lost, gained or narrowed role privilege, a whole-row function for authenticated or anon, a cost or whole-row view, an admin reader made INVOKER / opened to anon / closed to authenticated / re-bodied); under autocommit it refuses before any change`);
}

// MUTATIONS: copies of the candidate with one grant edit each must fail the candidate's own verify block.
function mutations() {
  const src = lf(CANDIDATE);
  const cases = [
    ['the products authenticated REVOKE removed', (s) => s.replace('REVOKE SELECT, REFERENCES ON public.products FROM authenticated;\n', ''),
      /COST_LOCK_VERIFY: authenticated (SELECT|REFERENCES) on products\.current_cost is still granted|COST_LOCK_VERIFY: authenticated still holds table-level SELECT on products/],
    ['the products anon REVOKE removed', (s) => s.replace('REVOKE SELECT ON public.products FROM anon;\n', ''),
      /COST_LOCK_VERIFY: anon SELECT on products\.\w+ is still granted|COST_LOCK_VERIFY: anon still holds table-level SELECT on products/],
    ['the job_chemicals write REVOKE removed', (s) => s.replace('REVOKE INSERT, UPDATE ON public.job_chemicals FROM authenticated;\n', ''),
      /COST_LOCK_VERIFY: authenticated (INSERT|UPDATE) on job_chemicals\.cost_per_unit_cents is still granted|COST_LOCK_VERIFY: authenticated still holds table-level (INSERT|UPDATE) on job_chemicals/],
    ['header_notes dropped from the quotes SELECT list', (s) => s.replace(/GRANT SELECT \(\n  id, quote_number, customer_id, created_by, tier, status, commission_split, total_price, valid_days,\n  expires_at, header_notes, /, 'GRANT SELECT (\n  id, quote_number, customer_id, created_by, tier, status, commission_split, total_price, valid_days,\n  expires_at, '),
      /COST_LOCK_VERIFY: authenticated SELECT on quotes\.header_notes is not granted/],
    ['current_cost added to the products anon list', (s) => s.replace(/(\) ON public\.products TO anon;)/, ', current_cost\n$1'),
      /COST_LOCK_VERIFY: anon SELECT on products\.current_cost is still granted/],
  ];
  for (const [label, edit, refusal] of cases) {
    const mutant = edit(src);
    assert.notEqual(mutant, src, `mutation "${label}" did not change the candidate`);
    stageText('mutant.sql', mutant);
    const d = docker([...psqlArgs()], { input: 'BEGIN;\n\\i /tmp/mutant.sql\nROLLBACK;', allowFailure: true });
    assert.notEqual(d.status, 0, `MUTATION (${label}): the mutant applied cleanly, so the verify block does not bite`);
    assert.match(d.stderr, refusal, `MUTATION (${label}): wrong refusal:\n${d.stderr}`);
  }
  // The unmutated candidate passes its verify block in the same harness (so the refusals above are the edits').
  const clean = docker([...psqlArgs()], { input: 'BEGIN;\n\\i /tmp/cand.sql\nROLLBACK;', allowFailure: true });
  assert.equal(clean.status, 0, `the unmutated candidate failed in the mutation harness:\n${clean.stderr}`);
  console.log(`[prover] MUTATION: ${cases.length} edited copies of the candidate each raise COST_LOCK_VERIFY (products REVOKE removed, anon REVOKE removed, job_chemicals write REVOKE removed, a non-cost column dropped, a cost column added); the unedited copy passes`);
}

/** Dev convenience only (REUSE): the header's ROLLBACK recipe, so a reused container is BEFORE again. */
function unapply() {
  const recipe = lf(CANDIDATE).split('-- ROLLBACK')[1].split('-- Proof:')[0].split('\n').filter((l) => l.startsWith('--   ')).map((l) => l.slice(5)).join('\n');
  psql(`BEGIN;\n${recipe}\nCOMMIT;`);
  console.log('[prover] (reuse) un-applied the candidate with its ROLLBACK recipe');
}

function main() {
  const started = Date.now();
  if (!REUSE) buildContainer();
  else if (scalar("SELECT has_table_privilege('authenticated', 'public.products', 'SELECT');") === 'f') unapply();
  fidelity();
  if (scalar(`SELECT count(*) FROM public.commissions WHERE id = '${COMM}';`) === '0') seed();

  const privBefore = privileges();
  for (const t of ANON_TABLES) assert.equal(privBefore.tbl.get(`${t}|anon|SELECT`), 't', `anon did not hold table SELECT on ${t} before the candidate`);
  for (const t of ['quote_items', 'quote_versions']) assert.equal(privBefore.tbl.get(`${t}|anon|SELECT`), 'f', `anon held table SELECT on ${t} before the candidate`);
  const before = runMatrix('before');
  check('before', before);
  preflightRefusesDrift();
  mutations();

  stageText('candidate.sql', lf(CANDIDATE));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  console.log('[prover] candidate applied');

  const after = runMatrix('after');
  check('after', after, before);
  const privAfter = privileges();
  privilegeDiff(privBefore, privAfter);

  // A second apply: the preflight still matches (no column changed), the grants are idempotent.
  const again = apply('candidate.sql');
  assert.equal(again.status, 0, `re-applying the candidate failed:\n${again.output}`);
  check('after', runMatrix('re-apply'), before);
  const privAgain = privileges();
  assert.deepEqual([...privAgain.col].filter(([k, v]) => privAfter.col.get(k) !== v), [], 'a second apply changed a column privilege');
  assert.deepEqual([...privAgain.tbl].filter(([k, v]) => privAfter.tbl.get(k) !== v), [], 'a second apply changed a table privilege');
  console.log('[prover] RE-APPLY: a second apply succeeds (the column sets still match the preflight; GRANT/REVOKE are idempotent) and every result and privilege is unchanged');

  console.log(`[prover] finished in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log('COST_COLUMNS_ADMIN_ONLY_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
