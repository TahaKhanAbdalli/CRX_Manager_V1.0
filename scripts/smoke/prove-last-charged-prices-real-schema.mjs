#!/usr/bin/env node
/**
 * Full-chain proof for the 20261027060000 candidate: "What did we charge this customer before?"
 * (To-Do 0.3, pricing plan slice 3; Mason, 2026-10-14: reps see the last price charged).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate, checks
 * the candidate's md5 pin against the replayed body, seeds an admin / deactivated admin / sales rep /
 * driver, two customers and their quotes, orders and invoices, then runs one matrix BEFORE and AFTER
 * the candidate. Each scenario is one transaction that always rolls back; each step runs as a
 * PostgREST session (request.jwt.claims + SET LOCAL ROLE authenticated), a signed-out visitor (anon),
 * the owner with the admin's JWT, or the bare owner.
 *   1. What counts: posted/paid/overdue invoice lines and priced confirmed/delivered order lines not
 *      on such an invoice count; draft, unposted, cancelled, voided and deleted invoices, credit memos,
 *      cancelled and needs-pricing orders, return credits and application fees do not; the latest
 *      date wins and a same-date tie prefers the invoice; another customer's charges never show.
 *   2. Who: admin and rep read it (the rep across reps); driver and deactivated admin are refused; a
 *      signed-out visitor cannot execute it; a missing customer, an empty list and a too-long list.
 *   3. The tier stamp: a new order line takes its quote's tier, else its order customer's; a new
 *      invoice line takes its order line's tier, else its invoice customer's; a sent tier is kept; a
 *      later change to the customer's tier does not move a stamped line.
 *      An invoice line saved without its order link takes the customer's tier, and restoring the
 *      link (what the invoice editor's save does) re-takes the order line's tier.
 *   4. The split-invoice content claim of every seeded invoice is byte-identical before and after
 *      the candidate, so stored claims keep matching and split invoices keep posting.
 *   5. Grants; the new columns carry the table's read grant and no write grant; preflight drift refusals; a second
 *      apply is refused; MUTATION: require_admin_or_sales_rep() emptied lets a driver read.
 *
 * Run: node scripts/smoke/prove-last-charged-prices-real-schema.mjs   (needs Docker)
 * Prints LAST_CHARGED_PRICES_PROOF_PASS on success. CRX_PROVER_VERBOSE=1 prints every step.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-last-charged-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1' || REUSE;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261027060000_last_charged_prices.sql');
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
const TOUCHED = /(FUNCTION\s+(public\.)?"?(get_last_charged_prices|_stamp_price_tier_at_sale_20261026|_order_line_price_tier_20261026|_invoice_line_order_tier_20261026|require_admin_or_sales_rep|_split_invoice_content_claim)\b|price_tier_at_sale)/i;
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
// FIDELITY: the candidate's one md5 pin matches the replayed body.
function fidelity() {
  const sql = lf(CANDIDATE).split('$preflight$')[1];
  const pins = [...sql.matchAll(/IS DISTINCT FROM '([0-9a-f]{32})'/g)].map((m) => m[1]);
  const sigs = ['public.require_admin_or_sales_rep()', 'public._split_invoice_content_claim(uuid)'];
  assert.equal(pins.length, sigs.length, 'the preflight pins two bodies, in this order');
  for (const [i, sig] of sigs.entries()) {
    const got = scalar(`SELECT coalesce(md5(replace(prosrc, chr(13), '')), 'MISSING') FROM pg_proc WHERE oid = to_regprocedure('${sig}') UNION ALL SELECT 'MISSING' LIMIT 1;`);
    assert.equal(got, pins[i], `${sig} replayed with a body that differs from the live pin of 2026-10-26`);
  }
  console.log('[prover] FIDELITY: both pinned bodies match the live pins of 2026-10-26');
}

// Every seeded invoice's split-invoice content claim, as stored claims would hold it.
function contentClaims() {
  return scalar(`SELECT md5(string_agg(i.id::text || '=' || public._split_invoice_content_claim(i.id)::text, ',' ORDER BY i.id))
    FROM public.invoices i WHERE i.id::text LIKE '7c320000-%';`);
}

// ------------------------------------------------------------------------------------------------
// Fixtures (committed once; every probe rolls back).
const id = (n) => `7c320000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), ADMIN_OFF: id('a3'), REP: id('b1'), DRIVER: id('d1') };
const CA = id('c1'); // tier 2
const CB = id('c2'); // tier 3
const P = Object.fromEntries(['1', '2', '3', '4', '5', '6', '7', '8'].map((n) => [`P${n}`, id(`f${n}`)]));
const QA = id('91'); const QS = id('92'); const QI = id('93');
const MISSING = id('ff');
const q = (value) => `'${value}'`;
const arr = (ids) => `ARRAY[${ids.map(q).join(', ')}]::uuid[]`;

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}

// [order key, customer, status, order_date, deleted, pricing_status, quote]
const ORDERS = [
  ['o2', CA, 'confirmed', '2026-04-01', false, 'priced', null],
  ['o3', CA, 'cancelled', '2026-08-01', false, 'priced', null],
  ['o4', CA, 'confirmed', '2026-08-01', false, 'needs_pricing', null],
  ['o5', CA, 'fulfilled', '2026-01-10', false, 'priced', null],
  ['o6', CA, 'partially_fulfilled', '2026-07-01', false, 'priced', null],
  ['o7', CA, 'confirmed', '2026-08-15', true, 'priced', null],
  ['o8', CA, 'voided', '2026-08-20', false, 'priced', null],
  ['o9', CA, 'confirmed', '2026-09-01', false, 'priced', QA],
];
// [line key, order key, product, price dollars, units]
const ORDER_LINES = [
  ['l2', 'o2', 'P1', '41.00', 10],
  ['l3', 'o3', 'P3', '99.00', 10],
  ['l4', 'o4', 'P3', '98.00', 10],
  ['l5', 'o5', 'P3', '30.00', 10],
  ['l6', 'o6', 'P6', '50.00', 10],
  ['l7', 'o7', 'P2', '97.00', 10],
  ['l8', 'o8', 'P2', '96.00', 10],
];
// [invoice key, customer, status, type, invoice_date, deleted, voided, order key]
const INVOICES = [
  ['i1', CA, 'posted', 'chemical_sale', '2026-03-01', false, false],
  ['i2', CA, 'paid', 'chemical_sale', '2026-02-01', false, false],
  ['i3', CA, 'draft', 'chemical_sale', '2026-05-01', false, false, 'o2'],
  ['ie', CA, 'draft', 'chemical_sale', '2026-05-02', false, false, 'o5'],
  ['i4', CA, 'voided', 'chemical_sale', '2026-06-01', false, true],
  ['i5', CA, 'cancelled', 'chemical_sale', '2026-06-02', false, false],
  ['i6', CA, 'overdue', 'chemical_sale', '2026-01-20', false, false],
  ['i7', CA, 'posted', 'chemical_sale', '2026-07-01', false, false],
  ['i8', CA, 'posted', 'chemical_sale', '2026-06-03', true, false],
  ['i9', CA, 'unposted', 'field_application', '2026-06-04', false, false],
  ['ib', CB, 'posted', 'chemical_sale', '2026-09-01', false, false],
  ['ic', CA, 'posted', 'misc_charge', '2026-09-02', false, false],
  ['id', CA, 'posted', 'chemical_sale', '2026-09-03', false, false],
  // A posted invoice made from a spray job: its line is quantity 1 at the line total, never counted.
  ['ij', CA, 'posted', 'field_application', '2026-08-01', false, false, null, 'job'],
  // A posted field-application invoice with no job (the field-app editor's per-unit lines) counts.
  ['ik', CA, 'posted', 'field_application', '2026-08-02', false, false],
  // A split-billing child made from a spray job: it carries the job AND a billing set, and its lines
  // are per-unit (_save_field_app_split_invoice_impl), so it counts.
  ['il', CA, 'posted', 'field_application', '2026-08-03', false, false, null, 'job+set'],
];
// [invoice key, product, unit cents, quantity, order line key, extra columns]
const INVOICE_LINES = [
  ['i1', 'P1', 4000, 5, null, ''],
  ['i2', 'P2', 2000, 5, null, ''],
  ['i3', 'P2', 2500, 5, null, ''],
  ['i4', 'P2', 2600, 5, null, ''],
  ['i5', 'P2', 2700, 5, null, ''],
  ['i6', 'P3', 3100, 5, 'l5', ''],
  ['i7', 'P6', 5100, 5, null, ''],
  ['i8', 'P2', 2800, 5, null, ''],
  ['i9', 'P2', 2900, 5, null, ''],
  ['ib', 'P1', 9999, 5, null, ''],
  ['ic', 'P5', 7000, 5, null, ''],
  ['id', 'P5', 7100, 1, null, 'is_application_fee=true'],
  ['id', 'P7', 7200, -1, null, 'return'],
  ['ij', 'P2', 20000, 1, null, ''],
  ['ik', 'P3', 3300, 5, null, ''],
  ['il', 'P8', 4400, 5, null, ''],
];
// Fixture keys ('o2', 'i7', 'l5') spelled as hex inside the uuid.
const hex = (key) => Buffer.from(key).toString('hex');
const oid = (key) => id(`0${hex(key)}`);
const iid = (key) => id(`1${hex(key)}`);
const lid = (key) => id(`2${hex(key)}`);

function seedUsers() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.REP, 'sales_rep', 'Rep', 8], [U.DRIVER, 'driver', 'Driver', 6], [U.ADMIN_OFF, 'admin', 'Deactivated Admin', 3]];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'last-charged-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};`);
  psql(`SET session_replication_role = replica;
    ${users.map(([u, role, , minutes]) => `UPDATE public.profiles SET role = '${role}', is_active = true, created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    ${claims(U.ADMIN)}
    UPDATE public.profiles SET is_active = false WHERE id = '${U.ADMIN_OFF}';
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7c320000-%';`),
    'admin:true,sales_rep:true,driver:true,admin:false', 'the seeded roles are not what the proof needs');
}

function seedFixture() {
  // The fixture rows are written with triggers off: this proof is about what the read counts, not
  // how each row was made. Section 3 inserts its rows with every trigger on.
  const product = (key) => `('${P[key]}', '[PROVER] ${key}', 'gal', 10.00, 60.00, 'liquid', true)`;
  // One transaction (psql -1 semantics via BEGIN/COMMIT), so a failed seed leaves nothing behind.
  psql(`BEGIN;
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, product_form, is_active) VALUES
      ${Object.keys(P).map(product).join(',\n      ')};
    INSERT INTO public.customers (id, farm_name, assigned_tier) VALUES
      ('${CA}', '[PROVER] Farm A', 2), ('${CB}', '[PROVER] Farm B', 3);
    INSERT INTO public.quotes (id, quote_number, customer_id, created_by, tier, status) VALUES
      ('${QA}', 'Q-PROVER-1', '${CA}', '${U.ADMIN}', 1, 'accepted');
    INSERT INTO public.quote_sections (id, quote_id, section_name) VALUES ('${QS}', '${QA}', 'Main');
    INSERT INTO public.quote_items (id, quote_id, section_id, product_id, price_per_unit) VALUES ('${QI}', '${QA}', '${QS}', '${P.P4}', 55.00);
    INSERT INTO public.orders (id, order_number, customer_id, status, order_date, deleted_at, pricing_status, quote_id) VALUES
      ${ORDERS.map(([k, c, s, d, del, ps, quote]) => `('${oid(k)}', 'ORD-PROVER-${k}', '${c}', '${s}', '${d}', ${del ? 'now()' : 'NULL'}, '${ps}', ${quote ? q(quote) : 'NULL'})`).join(',\n      ')};
    INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, total_units_needed, total_price) VALUES
      ${ORDER_LINES.map(([k, o, p, price, units]) => `('${lid(k)}', '${oid(o)}', '${P[p]}', '[PROVER] ${p}', ${price}, ${units}, ${price} * ${units})`).join(',\n      ')};
    INSERT INTO public.invoices (id, invoice_number, customer_id, status, invoice_type, invoice_date, deleted_at, voided_at, posted_at, created_by, order_id, job_id, field_app_billing_set_id) VALUES
      ${INVOICES.map(([k, c, s, t, d, del, voided, order, job = '']) => `('${iid(k)}', 'INV-PROVER-${k}', '${c}', '${s}', '${t}', '${d}', ${del ? 'now()' : 'NULL'}, ${voided ? 'now()' : 'NULL'}, ${['posted', 'paid', 'overdue', 'voided'].includes(s) ? 'now()' : 'NULL'}, '${U.ADMIN}', ${order ? q(oid(order)) : 'NULL'}, ${job ? q(id(`3${hex(k)}`)) : 'NULL'}, ${job.includes('set') ? q(id(`4${hex(k)}`)) : 'NULL'})`).join(',\n      ')};
    INSERT INTO public.invoice_items (invoice_id, product_id, description, unit_price_cents, quantity, extended_cents, order_item_id, is_application_fee, return_credit_source_item_id, return_credit_cogs_cents, cost_cents) VALUES
      ${INVOICE_LINES.map(([k, p, cents, qty, line, extra]) => `('${iid(k)}', '${P[p]}', '[PROVER] ${p}', ${cents}, ${qty}, ${cents * qty}, ${line ? q(lid(line)) : 'NULL'}, ${extra === 'is_application_fee=true'}, ${extra === 'return' ? q(lid('l2')) : 'NULL'}, ${extra === 'return' ? '0' : 'NULL'}, 0)`).join(',\n      ')};
    COMMIT;`, { user: 'supabase_admin' });
  assert.equal(scalar(`SELECT count(*) FROM public.invoice_items WHERE invoice_id::text LIKE '7c320000-%';`), String(INVOICE_LINES.length), 'invoice lines not seeded');
  console.log(`[prover] seeded four users, two customers, a quote, ${ORDERS.length} orders, ${INVOICES.length} invoices and their lines`);
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

const MISSING_FN = /^42883\|function public\.get_last_charged_prices\(.*\) does not exist$/;
const NO_COLUMN = /^42703\|column (?:"price_tier_at_sale" .*|ii\.price_tier_at_sale )does not exist$/;
const DENIED = /^P0001\|Permission denied: requires admin or sales_rep role$/;
const NO_EXEC = /^42501\|permission denied for function get_last_charged_prices$/;
const short = (uuid) => Object.entries(P).find(([, v]) => v === uuid)?.[0] ?? uuid;

// "P1:4100:2:2026-04-01:order;P2:..." in product order, or "[]".
const LAST = (customer, products) => `(SELECT COALESCE(string_agg(
    (SELECT k FROM (VALUES ${Object.entries(P).map(([k, v]) => `('${k}', '${v}'::uuid)`).join(', ')}) AS m(k, u) WHERE m.u = (e->>'product_id')::uuid)
    || ':' || (e->>'unit_price_cents') || ':' || COALESCE(e->>'price_tier', '-') || ':' || (e->>'charged_on') || ':' || (e->>'source'),
    ';' ORDER BY (e->>'product_id')), '[]')
  FROM jsonb_array_elements(public.get_last_charged_prices(${customer === null ? 'NULL' : q(customer)}, ${products})) AS e)`;
const ALL = arr(Object.values(P));
// Fixture edits made with the user triggers off. Each scenario rolls back, which turns them back on;
// re-enabling inside the transaction would meet pending deferred trigger events. Fixtures only feed
// scenarios whose steps read, so nothing after them needs the triggers.
const TRIGGERS_OFF = 'ALTER TABLE public.order_items DISABLE TRIGGER USER; ALTER TABLE public.invoice_items DISABLE TRIGGER USER;';
// Tiers (and one unit size) stamped onto the fixture lines after the candidate.
const STAMP_ROWS = `
  UPDATE public.order_items SET price_tier_at_sale = 2, unit_size = '2.5 gal' WHERE id = '${lid('l2')}';
  UPDATE public.invoice_items SET price_tier_at_sale = 3 WHERE invoice_id = '${iid('i7')}';`;
const STAMP = `${TRIGGERS_OFF}${STAMP_ROWS}`;
// The unit size of one product's last charge, or "none".
const UNIT = (customer, product) => `(SELECT COALESCE(e->>'unit_size', '-') FROM jsonb_array_elements(public.get_last_charged_prices('${customer}', ARRAY['${product}']::uuid[])) AS e UNION ALL SELECT 'none' LIMIT 1)`;
// Later $0 lines: a no-charge invoice line (P6) and a $0 order line (P2), both newer than the real charge.
const ZERO_LINES = `${STAMP}
  INSERT INTO public.invoice_items (invoice_id, product_id, description, unit_price_cents, quantity, extended_cents, cost_cents)
    VALUES ('${iid('id')}', '${P.P6}', '[PROVER] P6 no charge', 0, 5, 0, 0);
  INSERT INTO public.order_items (order_id, product_id, product_name, price_per_unit, total_units_needed, total_price)
    VALUES ('${oid('o9')}', '${P.P2}', '[PROVER] P2 free', 0, 5, 0);`;
const EXPECTED_A = 'P1:4100:2:2026-04-01:order;P2:2000:-:2026-02-01:invoice;P3:3300:-:2026-08-02:invoice;P6:5100:3:2026-07-01:invoice;P8:4400:-:2026-08-03:invoice';

// Section 3 rows, written with every trigger on (as the owner, the way the RPCs write them).
const TIER = (table, where) => `(SELECT COALESCE(string_agg(COALESCE(price_tier_at_sale::text, '-'), ',' ORDER BY id), 'none') FROM public.${table} WHERE ${where})`;
const NEW_OL = (key, order, product, quoteItem = null) => ({ stmt: `INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, total_units_needed, total_price, quote_item_id)
  VALUES ('${lid(key)}', '${oid(order)}', '${P[product]}', '[PROVER] ${product}', 60.00, 1, 60.00, ${quoteItem ? q(quoteItem) : 'NULL'}); v := (SELECT COALESCE(price_tier_at_sale::text, '-') FROM public.order_items WHERE id = '${lid(key)}');` });
const NEW_IL = (key, invoice, product, orderLine = null, tier = null) => ({ stmt: `INSERT INTO public.invoice_items (id, invoice_id, product_id, description, unit_price_cents, quantity, extended_cents, order_item_id${tier ? ', price_tier_at_sale' : ''})
  VALUES ('${iid(key)}', '${iid(invoice)}', '${P[product]}', '[PROVER] ${product}', 6000, 1, 6000, ${orderLine ? q(lid(orderLine)) : 'NULL'}${tier ? `, ${tier}` : ''}); v := (SELECT COALESCE(price_tier_at_sale::text, '-') FROM public.invoice_items WHERE id = '${iid(key)}');` });

/**
 * Scenarios. Each step: [key, as, call|{stmt}, before, after]. before/after: a RegExp, an exact
 * string, or 'same' (identical in both phases). A scenario's fixture runs after the candidate only.
 */
const SCENARIOS = [
  { name: '1. what counts', afterFixture: STAMP, steps: [
    ['admin: the latest charge per product for Farm A', U.ADMIN, LAST(CA, ALL), MISSING_FN, `ok|${EXPECTED_A}`],
    ['Farm B sees only its own invoice', U.ADMIN, LAST(CB, ALL), MISSING_FN, 'ok|P1:9999:-:2026-09-01:invoice'],
    ['P4 is only on a quote: nothing', U.ADMIN, LAST(CA, arr([P.P4])), MISSING_FN, 'ok|[]'],
    ['P5 misc-charge invoice and application fee: nothing', U.ADMIN, LAST(CA, arr([P.P5])), MISSING_FN, 'ok|[]'],
    ['P7 return credit: nothing', U.ADMIN, LAST(CA, arr([P.P7])), MISSING_FN, 'ok|[]'],
    ['a duplicate and a null in the list are harmless', U.ADMIN, LAST(CA, `ARRAY['${P.P2}', '${P.P2}', NULL]::uuid[]`), MISSING_FN, 'ok|P2:2000:-:2026-02-01:invoice'],
  ] },
  { name: '1b. invoicing the order line moves P1 to the invoice', afterFixture: `${STAMP}
    INSERT INTO public.invoice_items (invoice_id, product_id, description, unit_price_cents, quantity, extended_cents, order_item_id, price_tier_at_sale)
      VALUES ('${iid('i1')}', '${P.P1}', '[PROVER] P1 billed', 4150, 1, 4150, '${lid('l2')}', 1);`, steps: [
    // The order line (2026-04-01) drops out; of the two P1 lines on the 2026-03-01 invoice the later wins.
    ['an invoiced order line no longer counts; its invoice line does', U.ADMIN, LAST(CA, arr([P.P1])), MISSING_FN, 'ok|P1:4150:1:2026-03-01:invoice'],
  ] },
  { name: '1c. unit size and $0 lines', afterFixture: ZERO_LINES, steps: [
    ['the charge carries the unit size it was sold in', U.ADMIN, UNIT(CA, P.P1), MISSING_FN, 'ok|2.5 gal'],
    ['a later $0 invoice line and $0 order line are not charges', U.ADMIN, LAST(CA, arr([P.P2, P.P6])), MISSING_FN, 'ok|P2:2000:-:2026-02-01:invoice;P6:5100:3:2026-07-01:invoice'],
  ] },
  { name: '1d. a split payer\'s invoice is not this customer\'s charge', afterFixture: `${STAMP}
    INSERT INTO public.invoice_items (invoice_id, product_id, description, unit_price_cents, quantity, extended_cents, order_item_id, cost_cents)
      VALUES ('${iid('ib')}', '${P.P1}', '[PROVER] P1 billed to Farm B', 4100, 1, 4100, '${lid('l2')}', 0);`, steps: [
    // Step names go into SQL string literals: no apostrophes.
    ['Farm A keeps its order line when an invoice to Farm B bills it', U.ADMIN, LAST(CA, arr([P.P1])), MISSING_FN, 'ok|P1:4100:2:2026-04-01:order'],
  ] },
  { name: '2. who', afterFixture: STAMP, steps: [
    ['sales rep reads it across reps', U.REP, LAST(CA, ALL), MISSING_FN, `ok|${EXPECTED_A}`],
    ['rep cannot read those invoice lines directly', U.REP, '(SELECT count(*) FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id WHERE i.customer_id = \'' + CA + '\')', 'ok|0', 'same'],
    ['driver is refused', U.DRIVER, LAST(CA, ALL), MISSING_FN, DENIED],
    ['deactivated admin is refused', U.ADMIN_OFF, LAST(CA, ALL), MISSING_FN, DENIED],
    ['no sign-in is refused', 'bare', LAST(CA, ALL), MISSING_FN, /^P0001\|AUTH_REQUIRED$/],
    ['signed-out visitor cannot execute it', 'anon', LAST(CA, ALL), MISSING_FN, NO_EXEC],
    ['unknown customer', U.ADMIN, LAST(MISSING, ALL), MISSING_FN, /^P0001\|CUSTOMER_NOT_FOUND$/],
    ['no customer', U.ADMIN, LAST(null, ALL), MISSING_FN, /^P0001\|CUSTOMER_NOT_FOUND$/],
    ['empty list', U.ADMIN, LAST(CA, 'ARRAY[]::uuid[]'), MISSING_FN, 'ok|[]'],
    ['501 products are refused', U.ADMIN, LAST(CA, '(SELECT array_agg(gen_random_uuid()) FROM generate_series(1, 501))'), MISSING_FN, /^P0001\|LAST_CHARGED_TOO_MANY_PRODUCTS: /],
    // The column has the table's read grant; row-level security still limits the rows (a rep sees no
    // invoice lines of invoices that are not theirs, as above).
    ['rep reads the new column under row-level security', U.REP, `(SELECT count(*) || ':' || count(ii.price_tier_at_sale) FROM public.invoice_items ii WHERE ii.invoice_id = '${iid('i7')}')`, NO_COLUMN, 'ok|0:0'],
    ['admin reads the new column', U.ADMIN, `(SELECT string_agg(COALESCE(ii.price_tier_at_sale::text, '-'), ',') FROM public.invoice_items ii WHERE ii.invoice_id = '${iid('i7')}')`, NO_COLUMN, 'ok|3'],
  ] },
  { name: '3. the tier stamp', steps: [
    ['order line from the quote takes the quote tier (1)', 'owner', NEW_OL('n1', 'o9', 'P4', QI), NO_COLUMN, 'ok|1'],
    // A product added to a quote's order later has no quote line and is priced at the customer tier.
    ['order line added to a quote order without a quote line takes the customer tier (2)', 'owner', NEW_OL('n2', 'o9', 'P1'), NO_COLUMN, 'ok|2'],
    ['order line with no quote takes the customer tier (2)', 'owner', NEW_OL('n3', 'o2', 'P2'), NO_COLUMN, 'ok|2'],
    ['Farm A moves to tier 3', 'owner', { stmt: `UPDATE public.customers SET assigned_tier = 3 WHERE id = '${CA}'; v := 'moved';` }, 'ok|moved', 'same'],
    ['stamped order lines keep their tier', 'owner', TIER('order_items', `id IN ('${lid('n1')}', '${lid('n2')}', '${lid('n3')}')`), NO_COLUMN, 'ok|1,2,2'],
    ['invoice line for an order line takes its tier (2)', 'owner', NEW_IL('n4', 'i3', 'P2', 'n3'), /^23503\|.*invoice_items_order_item_id_fkey/, 'ok|2'], // before: line n3 was never written
    // l5 predates the column and has no quote: its tier at sale is unknown, never today's tier (3).
    ['invoice line for an older, unquoted order line stays unknown', 'owner', NEW_IL('n5', 'ie', 'P3', 'l5'), NO_COLUMN, 'ok|-'],
    ['invoice line with no order line takes the invoice customer tier (3)', 'owner', NEW_IL('n6', 'i3', 'P6'), NO_COLUMN, 'ok|3'],
    // A quote-priced line with no order line (how a blend-ticket invoice bills a quote price): the
    // quote tier cannot be traced, so it stays unknown rather than claim the customer tier.
    ['a quote-priced line with no order line stays unknown', 'owner', { stmt: `INSERT INTO public.invoice_items (id, invoice_id, product_id, description, unit_price_cents, quantity, extended_cents, price_source)
  VALUES ('${iid('nq')}', '${iid('i3')}', '${P.P6}', '[PROVER] P6 quoted', 6000, 1, 6000, 'quoted'); v := (SELECT COALESCE(price_tier_at_sale::text, '-') FROM public.invoice_items WHERE id = '${iid('nq')}');` }, NO_COLUMN, 'ok|-'],
    // The database always decides: a tier the writer sends (1, or an impossible 4) is replaced.
    ['a tier the writer sends is replaced by the real one (3)', 'owner', NEW_IL('n7', 'i3', 'P6', null, 1), NO_COLUMN, 'ok|3'],
    ['even an impossible sent tier is replaced (3)', 'owner', NEW_IL('n8', 'i3', 'P6', null, 4), NO_COLUMN, 'ok|3'],
    ['an out-of-range tier written directly is refused', 'owner', { stmt: `UPDATE public.invoice_items SET price_tier_at_sale = 4 WHERE id = '${iid('n6')}'; v := 'updated';` }, NO_COLUMN, /^23514\|.*invoice_items_price_tier_at_sale_range/],
    // The invoice editor's save: the line is re-inserted without its order link (customer tier, 3),
    // then the link is restored by an UPDATE, which re-takes the order line's tier (n3: 2).
    ['a line saved without its order link takes the customer tier (3)', 'owner', NEW_IL('n9', 'i3', 'P2'), NO_COLUMN, 'ok|3'],
    ['restoring the order link re-takes the order line tier (2)', 'owner', { stmt: `UPDATE public.invoice_items SET order_item_id = '${lid('n3')}' WHERE id = '${iid('n9')}'; v := (SELECT COALESCE(price_tier_at_sale::text, '-') FROM public.invoice_items WHERE id = '${iid('n9')}');` }, /^(42703|23503)\|/, 'ok|2'], // before: n3 and n9 were never written
    ['older lines stay unknown', 'owner', TIER('order_items', `id = '${lid('l5')}'`), NO_COLUMN, 'ok|-'],
  ] },
];

function runMatrix(phase) {
  const out = {};
  for (const sc of SCENARIOS) {
    const steps = sc.steps.map(([key, as, call]) => ({ key, as, ...(typeof call === 'string' ? { call } : call) }));
    const res = scenario(steps, phase === 'after' ? (sc.afterFixture ?? '') : '');
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
     AND p.proname IN ('get_last_charged_prices', '_stamp_price_tier_at_sale_20261026', '_order_line_price_tier_20261026', '_invoice_line_order_tier_20261026')
    ORDER BY 1;` }).stdout.trim().split(/\r?\n/).map((l) => l.split('|'));
  assert.deepEqual(fns.map((r) => r[0]).sort(), ['_invoice_line_order_tier_20261026(uuid)', '_order_line_price_tier_20261026(uuid,uuid)', '_stamp_price_tier_at_sale_20261026()', 'get_last_charged_prices(uuid,uuid[])']);
  for (const [sig, anon, auth, svc, secdef, cfg] of fns) {
    if (sig.startsWith('get_')) {
      assert.deepEqual([anon, auth, svc, secdef], ['f', 't', 'f', 't'], `${sig}: only authenticated may execute, as definer`);
    } else {
      assert.deepEqual([anon, auth, svc], ['f', 'f', 'f'], `${sig} is executable by an API role`);
    }
    assert.equal(cfg, 'search_path=public, pg_temp', `${sig} must pin search_path`);
  }
  const cols = scalar(`SELECT string_agg(t || ':' || r || ':' || p || ':' || has_column_privilege(r, 'public.' || t, 'price_tier_at_sale', p), ',' ORDER BY t, r, p)
    FROM unnest(ARRAY['order_items', 'invoice_items']) t, unnest(ARRAY['anon', 'authenticated']) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) p;`);
  assert.equal(cols, 'invoice_items:anon:INSERT:false,invoice_items:anon:SELECT:true,invoice_items:anon:UPDATE:false,'
    + 'invoice_items:authenticated:INSERT:false,invoice_items:authenticated:SELECT:true,invoice_items:authenticated:UPDATE:false,'
    + 'order_items:anon:INSERT:false,order_items:anon:SELECT:true,order_items:anon:UPDATE:false,'
    + 'order_items:authenticated:INSERT:false,order_items:authenticated:SELECT:true,order_items:authenticated:UPDATE:false',
  `price_tier_at_sale must carry the read grant only: ${cols}`);
  console.log('[prover] GRANTS: get_last_charged_prices executable by authenticated only, as definer; the helpers by no API role; price_tier_at_sale readable (row-level security still applies), writable by no browser role');
}

function preflightRefusesDrift(phase) {
  stageText('cand.sql', lf(CANDIDATE));
  const cases = phase === 'before' ? [
    ['CREATE OR REPLACE FUNCTION public.require_admin_or_sales_rep() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN END; $$;',
      /LAST_CHARGED_PREFLIGHT: require_admin_or_sales_rep\(\) changed since 2026-10-26/],
    ['ALTER TABLE public.invoice_items ADD COLUMN price_tier_at_sale int;',
      /LAST_CHARGED_PREFLIGHT: an object this migration creates already exists/],
    ['CREATE FUNCTION public.get_last_charged_prices(int) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
      /LAST_CHARGED_PREFLIGHT: an object this migration creates already exists/],
  ] : [
    // The re-emitted claim body no longer matches its pin, which refuses first.
    ['SELECT 1;', /LAST_CHARGED_PREFLIGHT: (an object this migration creates already exists|_split_invoice_content_claim\(uuid\) changed since)/],
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
  assert.equal(scalar("SELECT to_regprocedure('public.get_last_charged_prices(uuid,uuid[])') IS NULL;"), 't', 'a reused container must be BEFORE the candidate (drop it and rebuild)');
  fidelity();
  if (scalar("SELECT count(*) FROM public.profiles WHERE id::text LIKE '7c320000-%';") === '0') seedUsers();
  if (scalar("SELECT count(*) FROM public.customers WHERE id::text LIKE '7c320000-%';") === '0') seedFixture();

  check('before', runMatrix('before'));
  preflightRefusesDrift('before');
  const claimsBefore = contentClaims();

  stageText('candidate.sql', lf(CANDIDATE));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  console.log('[prover] candidate applied');

  // A stored claim must equal a fresh one at post time, so the claims must not move.
  assert.equal(contentClaims(), claimsBefore, 'split-invoice content claims changed: stored claims would stop matching at post');
  // MUTATION: the live body (no exclusion), put back inside a rolled-back transaction, moves them.
  const body = lf(CANDIDATE).split('CREATE OR REPLACE FUNCTION public._split_invoice_content_claim')[1].split('$function$;')[0];
  assert.ok(body.includes("'price_tier_at_sale']::text[]"), 'the claim exclusion is missing from the candidate');
  const mutant = `CREATE OR REPLACE FUNCTION public._split_invoice_content_claim${body.replace(", 'price_tier_at_sale']::text[]", ']::text[]')}$function$;`;
  const moved = docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;\n${mutant}\nSELECT md5(string_agg(i.id::text || '=' || public._split_invoice_content_claim(i.id)::text, ',' ORDER BY i.id)) FROM public.invoices i WHERE i.id::text LIKE '7c320000-%';\nROLLBACK;` }).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  assert.notEqual(moved, claimsBefore, 'MUTATION: without the exclusion the claims should have changed');
  console.log('[prover] CLAIMS: split-invoice content claims are byte-identical before and after; without the exclusion they change (mutation)');

  check('after', runMatrix('after'));
  grants();
  preflightRefusesDrift('after');

  // The post-apply smoke chain runs here first, so the live run is not its first run.
  stageText('smoke.sql', lf(path.join(ROOT, 'scripts', 'smoke', 'smoke-get-last-charged-prices.sql')));
  const smoke = docker([...psqlArgs(), '-f', '/tmp/smoke.sql'], { allowFailure: true });
  assert.match(smoke.stderr, /SMOKE_PASS_ROLLBACK/, `the smoke chain did not pass:\n${smoke.stderr}`);
  console.log('[prover] SMOKE: smoke-get-last-charged-prices.sql ends in SMOKE_PASS_ROLLBACK');

  // MUTATION: the role gate is what refuses a driver.
  const MUTANT_GATE = 'CREATE OR REPLACE FUNCTION public.require_admin_or_sales_rep() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN END; $$;';
  const gate = scenario([{ key: 'driver, gate emptied', as: U.DRIVER, call: LAST(CB, ALL) }], MUTANT_GATE);
  assert.equal(gate['driver, gate emptied'], 'ok|P1:9999:-:2026-09-01:invoice', `MUTATION: with the gate emptied a driver should read, got ${gate['driver, gate emptied']}`);
  console.log('[prover] MUTATION: require_admin_or_sales_rep() emptied lets a driver read -- so the refusal comes from the role gate');

  console.log(`[prover] finished in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log('LAST_CHARGED_PRICES_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
