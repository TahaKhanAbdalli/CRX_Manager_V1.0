#!/usr/bin/env node
/**
 * Full-chain proof for the 20261022040000 candidate: the payment-allocation tables (allocation_sets,
 * invoice_line_allocations, order_line_allocations) can no longer be written through the Data API.
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate, checks
 * that the replayed writer functions match their live md5 of 2026-10-22, seeds an admin, a sales rep,
 * a deactivated rep and a driver, a customer, posted invoices, an order line with an allocation row,
 * then runs one matrix BEFORE and AFTER the candidate. Every case is one transaction that always rolls
 * back, run as a PostgREST session (request.jwt.claims + SET LOCAL ROLE authenticated) or as a
 * signed-out visitor (anon).
 *   1. Direct writes: BEFORE a sales rep (and an admin) can INSERT a fake allocation set and fake
 *      invoice / order line allocations, and an admin can UPDATE and DELETE an allocation set. AFTER
 *      every one of those is refused for every role (42501), and anon is refused before and after.
 *   2. Reads: admin and rep read the same rows before and after; driver and anon read none.
 *   3. Every function that writes the tables still works for a signed-in user AFTER:
 *      allocate_payment (admin and rep) writes a set and its line allocation; void_payment reverses
 *      it; void_invoice deletes a voided payment's line allocation and re-totals its set
 *      (_void_invoice_split_provenance_impl_20260719); update_order_items removing a line deletes its
 *      order line allocation (_update_order_items_impl).
 *   4. The postflight's grant/policy picture; a second apply changes nothing; the preflight refuses a
 *      SECURITY INVOKER writer; MUTATION: with the INSERT grant and policy restored the rep's fake
 *      allocation goes through again, so the refusal really is this migration.
 *
 * Run: node scripts/smoke/prove-payment-allocation-no-direct-writes-real-schema.mjs   (needs Docker)
 * Prints PAYMENT_ALLOCATION_NO_DIRECT_WRITES_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-alloc-lock-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1' || REUSE;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261022040000_payment_allocation_tables_no_direct_writes.sql');
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
]);
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
]);
const TOUCHED = /allocation_sets|invoice_line_allocations|order_line_allocations/i;
// Live md5 (CR-insensitive) of the writers and the gates they and the policies call, read 2026-10-22.
const LIVE_PINS = [
  ['public.allocate_payment(uuid,bigint,text,text,text,date,text,jsonb,uuid,text)', '6a945a2510d8e788d4e6f03c0c6d7563'],
  ['public._void_payment_replay_impl_20261015(uuid,text,uuid,text)', '70fd746c15f4a6629680a724f3588967'],
  ['public._void_invoice_split_provenance_impl_20260719(uuid,text,text)', 'd5ac51bf7ae432e9c8360bc75247c087'],
  ['public._update_order_items_impl(uuid,jsonb,uuid,text)', '2afd69c4cff15b37212a4b1293fa6532'],
  ['public.void_payment(uuid,text,uuid,text)', '0119ddcf823508edbfa25314c8978aed'],
  ['public.void_invoice(uuid,text,text)', '2b1be1b706614f9a909581b0493d679f'],
  ['public.update_order_items(uuid,jsonb,uuid,text)', 'e35fce6708edee32fb1876fa60d7da4b'],
  ['public.unpost_invoice(uuid,uuid,text)', '161f18c3ccd6126a6fb683c5160f82dc'],
  ['public.is_admin()', 'f76bf61116c3bd52bd9c6ea125079b73'],
  ['public.is_sales_rep()', 'fcb3133010fe3f4f56e3be31f709d102'],
];
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';

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
    assert.ok(!TOUCHED.test(lf(file)), `${path.basename(file)} sorts after the candidate and touches the allocation tables; re-think this proof`);
  }
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!TOUCHED.test(lf(file)), `${name} now touches the allocation tables; replay it or re-think the skip`);
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
// FIDELITY: the replayed writers and gates are live's bodies, and the starting ACL / policies are live's.
function fidelity() {
  for (const [sig, pin] of LIVE_PINS) {
    const got = scalar(`SELECT coalesce((SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${sig}')), 'MISSING');`);
    assert.equal(got, pin, `${sig} replayed with a body that differs from the live pin of 2026-10-22`);
  }
  for (const t of TABLES) {
    assert.equal(scalar(`SELECT string_agg(a, ',' ORDER BY a) FROM unnest((SELECT relacl FROM pg_class WHERE oid = 'public.${t}'::regclass)::text[]) a;`), LIVE_ACL,
      `${t} replayed with an ACL that is not live's`);
    assert.equal(scalar(`SELECT string_agg(format('%s:%s:%s:%s:%s:%s', polname, polcmd::text, polpermissive, polroles::regrole[]::text,
        coalesce(pg_get_expr(polqual, polrelid), ''), coalesce(pg_get_expr(polwithcheck, polrelid), '')), ';' ORDER BY polname)
        FROM pg_policy WHERE polrelid = 'public.${t}'::regclass;`), LIVE_POLICIES[t],
      `${t} replayed with policies that are not live's (name, command, permissive, roles, USING, WITH CHECK)`);
    assert.equal(scalar(`SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.${t}'::regclass AND attacl IS NOT NULL;`), '0',
      `${t} replayed with a column ACL (live has none)`);
  }
  console.log(`[prover] FIDELITY: all ${LIVE_PINS.length} pinned bodies, the three ACLs and the policies match live (2026-10-22)`);
}
const TABLES = ['allocation_sets', 'invoice_line_allocations', 'order_line_allocations'];
// Live relacl of each of the three tables (sorted), read 2026-10-22.
const LIVE_ACL = 'anon=rm/postgres,authenticated=arwdDxtm/postgres,metabase_ro=r/postgres,postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres';
// Live policies, read 2026-10-22: name:command:permissive:roles:USING:WITH CHECK ({-} = PUBLIC).
const LIVE_POLICIES = {
  allocation_sets: 'allocation_sets_admin_delete:d:t:{authenticated}:is_admin():;allocation_sets_insert:a:t:{-}::(is_admin() OR is_sales_rep());'
    + 'allocation_sets_select:r:t:{-}:(is_admin() OR is_sales_rep()):;allocation_sets_update:w:t:{-}:is_admin():',
  invoice_line_allocations: 'invoice_line_alloc_insert:a:t:{-}::(is_admin() OR is_sales_rep());invoice_line_alloc_select:r:t:{-}:(is_admin() OR is_sales_rep()):',
  order_line_allocations: 'order_line_alloc_insert:a:t:{-}::(is_admin() OR is_sales_rep());order_line_alloc_select:r:t:{-}:(is_admin() OR is_sales_rep()):',
};
const SELECT_POLICY = (t) => LIVE_POLICIES[t].split(';').find((p) => p.split(':')[1] === 'r');

// ------------------------------------------------------------------------------------------------
// Fixtures (committed once; every probe rolls back).
const id = (n) => `7c710000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), REP: id('b1'), REP_OFF: id('b3'), DRIVER: id('d1') };
const CUST = id('c1');
const INV_PAY = id('101'); // posted, 1,000.00 open: paid through allocate_payment
const INV_VOID = id('102'); // posted, 500.00: voided while it carries a non-payment line allocation
const PROD = id('f1');
const ORDER = id('301');
const ITEM_KEEP = id('311');
const ITEM_DROP = id('312'); // carries the order line allocation
const SET_ORDER = id('401'); // entity_type order, holds the order line allocation
const SET_INV = id('402'); // entity_type invoice, for INV_VOID

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function asUser(uid) { return uid === 'anon' ? 'SET LOCAL ROLE anon;' : `${claims(uid)}\nSET LOCAL ROLE authenticated;`; }
function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin'], [U.REP, 'sales_rep', 'Rep'], [U.REP_OFF, 'sales_rep', 'Deactivated Rep'], [U.DRIVER, 'driver', 'Driver']];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'alloc-lock-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${claims(U.ADMIN)}
    UPDATE public.profiles SET is_active = false WHERE id = '${U.REP_OFF}';
    INSERT INTO public.customers (id, farm_name, is_active) VALUES ('${CUST}', '[PROVER] Alloc Farm', true);
    INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by) VALUES
      ('${INV_PAY}', 'PROVER-ALLOC-1', '${CUST}', 'misc_charge', 'draft', CURRENT_DATE, CURRENT_DATE + 30, 100000, '${U.ADMIN}'),
      ('${INV_VOID}', 'PROVER-ALLOC-2', '${CUST}', 'misc_charge', 'draft', CURRENT_DATE, CURRENT_DATE + 30, 50000, '${U.ADMIN}');
    UPDATE public.invoices SET status = 'posted', posted_by = '${U.ADMIN}', posted_at = now() WHERE id IN ('${INV_PAY}', '${INV_VOID}');
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, product_form, is_active)
      VALUES ('${PROD}', '[PROVER] Chem', 'GL', 6.00, 10.00, 'liquid', true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.inventory (product_id, quantity_available, unit_size) VALUES ('${PROD}', 50, 'GL');
    SELECT set_config('app.crx_below_cost_operation', 'create_direct_order', true);
    INSERT INTO public.orders (id, order_number, customer_id, status, order_date, salesman_id)
      VALUES ('${ORDER}', 'PROVER-ALLOC-ORD', '${CUST}', 'confirmed', CURRENT_DATE, '${U.REP}');
    INSERT INTO public.order_items (id, order_id, product_id, product_name, unit_size, price_per_unit, total_units_needed, total_price, cost_per_unit) VALUES
      ('${ITEM_KEEP}', '${ORDER}', '${PROD}', '[PROVER] Chem', 'GL', 10.00, 2, 20.00, 6.00),
      ('${ITEM_DROP}', '${ORDER}', '${PROD}', '[PROVER] Chem', 'GL', 10.00, 3, 30.00, 6.00);
    INSERT INTO public.allocation_sets (id, entity_type, entity_id, customer_id, created_by) VALUES
      ('${SET_ORDER}', 'order', '${ORDER}', '${CUST}', '${U.ADMIN}'),
      ('${SET_INV}', 'invoice', '${INV_VOID}', '${CUST}', '${U.ADMIN}');
    INSERT INTO public.order_line_allocations (allocation_set_id, order_item_id, bill_to_customer_id, split_percentage, amount_cents)
      VALUES ('${SET_ORDER}', '${ITEM_DROP}', '${CUST}', 100, 3000);
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY id) FROM public.profiles WHERE id::text LIKE '7c710000-%';`),
    'admin:true,sales_rep:true,sales_rep:false,driver:true', 'the seeded roles are not what the proof needs');
  assert.equal(scalar(`SELECT string_agg(status || ':' || balance_cents, ',' ORDER BY id) FROM public.invoices WHERE id::text LIKE '7c710000-%';`),
    'posted:100000,posted:50000', 'the seeded invoices are not posted and open');
}

// ------------------------------------------------------------------------------------------------
// Probes.
/**
 * Run `stmt` (PL/pgSQL statements that may set v) as `uid` ('anon' for a signed-out visitor), after
 * `fixture` (owner), in one rolled-back transaction. Returns ok|<v> or <sqlstate>|<message>.
 */
function attempt(uid, { stmt, fixture = '' }) {
  const sql = `BEGIN;
${fixture}
RESET ROLE;
${asUser(uid)}
DO $probe$
DECLARE v text; n bigint; r jsonb;
BEGIN
  ${stmt}
  RAISE NOTICE 'RESULT|ok|%', COALESCE(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'RESULT|%|%', SQLSTATE, SQLERRM;
END
$probe$;
ROLLBACK;
`;
  const res = docker([...psqlArgs(), '-A', '-t'], { input: sql, allowFailure: true });
  assert.equal(res.status, 0, `probe failed to run:\n${res.stderr}\n--- SQL ---\n${sql}`);
  const m = /RESULT\|([^\n]*)/.exec(res.stderr);
  assert.ok(m, `probe printed no RESULT:\n${res.stderr}`);
  return m[1].trimEnd();
}

// An owner-written line allocation, so a probe has a row to UPDATE / DELETE.
const FIX_ILA = `INSERT INTO public.invoice_line_allocations (id, allocation_set_id, invoice_id, bill_to_customer_id, split_percentage, amount_cents)
  VALUES ('${id('501')}', '${SET_INV}', '${INV_VOID}', '${CUST}', 100, 5000);
UPDATE public.allocation_sets SET total_allocated_cents = 5000 WHERE id = '${SET_INV}';`;
const rows = (sql) => `${sql};\n  GET DIAGNOSTICS n = ROW_COUNT;\n  v := n::text;`;

// Direct Data API writes, as PostgREST would send them.
const FAKE_SET = { stmt: rows(`INSERT INTO public.allocation_sets (entity_type, entity_id, customer_id, total_payment_cents, total_allocated_cents, payment_method, payment_date)
    VALUES ('payment', '${CUST}', '${CUST}', 100000, 100000, 'check', CURRENT_DATE)`) };
const FAKE_ILA = { stmt: rows(`INSERT INTO public.invoice_line_allocations (allocation_set_id, invoice_id, bill_to_customer_id, split_percentage, amount_cents)
    VALUES ('${SET_INV}', '${INV_PAY}', '${CUST}', 100, 100000)`) };
const FAKE_OLA = { stmt: rows(`INSERT INTO public.order_line_allocations (allocation_set_id, order_item_id, bill_to_customer_id, split_percentage, amount_cents)
    VALUES ('${SET_ORDER}', '${ITEM_KEEP}', '${CUST}', 100, 2000)`) };
const EDIT_SET = { stmt: rows(`UPDATE public.allocation_sets SET total_allocated_cents = 1 WHERE id = '${SET_INV}'`) };
const DROP_SET = { stmt: rows(`DELETE FROM public.allocation_sets WHERE id = '${SET_INV}'`) };
const EDIT_ILA = { fixture: FIX_ILA, stmt: rows(`UPDATE public.invoice_line_allocations SET amount_cents = 1 WHERE id = '${id('501')}'`) };
const DROP_ILA = { fixture: FIX_ILA, stmt: rows(`DELETE FROM public.invoice_line_allocations WHERE id = '${id('501')}'`) };
const EDIT_OLA = { stmt: rows(`UPDATE public.order_line_allocations SET amount_cents = 1 WHERE order_item_id = '${ITEM_DROP}'`) };
const DROP_OLA = { stmt: rows(`DELETE FROM public.order_line_allocations WHERE order_item_id = '${ITEM_DROP}'`) };
// Reads: rows visible in each table.
const READ = { fixture: FIX_ILA, stmt: `v := (SELECT count(*) FROM public.allocation_sets) || ':' || (SELECT count(*) FROM public.invoice_line_allocations)
    || ':' || (SELECT count(*) FROM public.order_line_allocations);` };

// The four functions that write the tables, called as a signed-in user.
const payment = (uid) => `r := public.allocate_payment('${CUST}', 30000, 'check', 'PROVER-REF', NULL, CURRENT_DATE, 'prover',
    jsonb_build_array(jsonb_build_object('invoice_id', '${INV_PAY}', 'amount_cents', 30000)), '${uid}', 'prover-pay-${uid.slice(-2)}');`;
// A rep cannot read an invoice another user created, so the check reads the reply and the allocation rows.
const PAY = (uid) => ({ stmt: `${payment(uid)}
  v := (r->>'total_allocated_cents') || ':' || (r->>'invoices_paid') || ':' || (SELECT count(*) FROM public.invoice_line_allocations
    WHERE allocation_set_id = (r->>'allocation_set_id')::uuid AND invoice_id = '${INV_PAY}' AND amount_cents = 30000);` });
const UNPAY = (uid) => ({ stmt: `${payment(uid)}
  PERFORM public.void_payment((r->>'allocation_set_id')::uuid, 'prover unapply', '${uid}', 'prover-unpay-${uid.slice(-2)}');
  v := (SELECT is_active::text FROM public.allocation_sets WHERE id = (r->>'allocation_set_id')::uuid) || ':' || (SELECT paid_amount_cents FROM public.invoices WHERE id = '${INV_PAY}');` });
const VOID = { fixture: FIX_ILA, stmt: `PERFORM public.void_invoice('${INV_VOID}', 'prover void', 'prover-void-1');
  v := (SELECT status FROM public.invoices WHERE id = '${INV_VOID}') || ':' || (SELECT count(*) FROM public.invoice_line_allocations WHERE invoice_id = '${INV_VOID}')
    || ':' || (SELECT total_allocated_cents FROM public.allocation_sets WHERE id = '${SET_INV}');` };
const EDIT_ORDER = (uid) => ({ stmt: `r := public.update_order_items('${ORDER}', '[{"id":"${ITEM_KEEP}","product_id":"${PROD}","product_name":"[PROVER] Chem","unit_size":"GL","price_per_unit":10,"total_units_needed":2,"cost_per_unit":6}]'::jsonb, '${uid}', 'prover-uoi-${uid.slice(-2)}');
  v := (r->>'status') || ':' || (SELECT count(*) FROM public.order_items WHERE order_id = '${ORDER}') || ':' || (SELECT count(*) FROM public.order_line_allocations);` });

const FORGED_PAY = { stmt: `r := public.allocate_payment('${CUST}', 30000, 'check', 'PROVER-REF', NULL, CURRENT_DATE, 'prover',
    jsonb_build_array(jsonb_build_object('invoice_id', '${INV_PAY}', 'amount_cents', 30000)), '${U.ADMIN}', 'prover-pay-forged');
  v := (r->>'total_allocated_cents') || ':' || (SELECT created_by::text FROM public.allocation_sets WHERE id = (r->>'allocation_set_id')::uuid);` };
const RLS = (t) => new RegExp(`^42501\\|new row violates row-level security policy for table "${t}"$`);
const NO_TABLE = (t) => new RegExp(`^42501\\|permission denied for table ${t}$`);
const OK = (n) => new RegExp(`^ok\\|${n}$`);

/** [label, uid, probe, before, after]; 'same' means identical before and after. */
const CASES = [
  // 1. Direct writes.
  ['rep: fake payment set', U.REP, FAKE_SET, OK(1), NO_TABLE('allocation_sets')],
  ['rep: fake invoice line allocation', U.REP, FAKE_ILA, OK(1), NO_TABLE('invoice_line_allocations')],
  ['rep: fake order line allocation', U.REP, FAKE_OLA, OK(1), NO_TABLE('order_line_allocations')],
  ['rep: edit a payment set', U.REP, EDIT_SET, OK(0), NO_TABLE('allocation_sets')],
  ['rep: delete a payment set', U.REP, DROP_SET, OK(0), NO_TABLE('allocation_sets')],
  ['admin: fake payment set', U.ADMIN, FAKE_SET, OK(1), NO_TABLE('allocation_sets')],
  ['admin: fake invoice line allocation', U.ADMIN, FAKE_ILA, OK(1), NO_TABLE('invoice_line_allocations')],
  ['admin: fake order line allocation', U.ADMIN, FAKE_OLA, OK(1), NO_TABLE('order_line_allocations')],
  ['admin: edit a payment set', U.ADMIN, EDIT_SET, OK(1), NO_TABLE('allocation_sets')],
  ['admin: delete a payment set', U.ADMIN, DROP_SET, OK(1), NO_TABLE('allocation_sets')],
  ['admin: edit a line allocation', U.ADMIN, EDIT_ILA, OK(0), NO_TABLE('invoice_line_allocations')],
  ['admin: delete a line allocation', U.ADMIN, DROP_ILA, OK(0), NO_TABLE('invoice_line_allocations')],
  ['admin: edit an order line allocation', U.ADMIN, EDIT_OLA, OK(0), NO_TABLE('order_line_allocations')],
  ['admin: delete an order line allocation', U.ADMIN, DROP_OLA, OK(0), NO_TABLE('order_line_allocations')],
  ['deactivated rep: fake invoice line allocation', U.REP_OFF, FAKE_ILA, RLS('invoice_line_allocations'), NO_TABLE('invoice_line_allocations')],
  ['driver: fake invoice line allocation', U.DRIVER, FAKE_ILA, RLS('invoice_line_allocations'), NO_TABLE('invoice_line_allocations')],
  ['driver: fake payment set', U.DRIVER, FAKE_SET, RLS('allocation_sets'), NO_TABLE('allocation_sets')],
  ['signed-out: fake invoice line allocation', 'anon', FAKE_ILA, NO_TABLE('invoice_line_allocations'), 'same'],
  ['signed-out: fake payment set', 'anon', FAKE_SET, NO_TABLE('allocation_sets'), 'same'],
  // 2. Reads.
  ['admin: reads', U.ADMIN, READ, OK('2:1:1'), 'same'],
  ['rep: reads', U.REP, READ, OK('2:1:1'), 'same'],
  ['driver: reads', U.DRIVER, READ, OK('0:0:0'), 'same'],
  ['deactivated rep: reads', U.REP_OFF, READ, OK('0:0:0'), 'same'],
  ['signed-out: reads', 'anon', READ, /^42501\|permission denied for function is_admin$/, 'same'],
  // 3. The functions that write the tables.
  ['admin: allocate_payment', U.ADMIN, PAY(U.ADMIN), OK('30000:1:1'), 'same'],
  ['rep: allocate_payment', U.REP, PAY(U.REP), OK('30000:1:1'), 'same'],
  ['admin: void_payment', U.ADMIN, UNPAY(U.ADMIN), OK('false:0'), 'same'],
  ['admin: void_invoice', U.ADMIN, VOID, OK('voided:0:0'), 'same'],
  ['admin: update_order_items drops an allocated line', U.ADMIN, EDIT_ORDER(U.ADMIN), OK('updated:1:0'), 'same'],
  ['rep: update_order_items drops an allocated line', U.REP, EDIT_ORDER(U.REP), OK('updated:1:0'), 'same'],
  // The functions' own actor gates are not changed here; a rep naming the admin as actor gets the
  // same answer before and after.
  ['rep naming the admin: allocate_payment', U.REP, FORGED_PAY, /^P0001\|p_performed_by does not match authenticated user$/, 'same'],
];

function runMatrix(phase) {
  const out = {};
  for (const [label, uid, probe] of CASES) out[label] = attempt(uid, probe);
  if (process.env.CRX_PROVER_VERBOSE === '1') for (const [k, v] of Object.entries(out)) console.log(`  ${phase} ${k}: ${v}`);
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

// ------------------------------------------------------------------------------------------------
// Grants and policies after the candidate.
function postflightPicture() {
  for (const t of TABLES) {
    assert.equal(scalar(`SELECT string_agg(a, ',' ORDER BY a) FROM unnest((SELECT relacl FROM pg_class WHERE oid = 'public.${t}'::regclass)::text[]) a;`),
      'anon=r/postgres,authenticated=r/postgres,metabase_ro=r/postgres,postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres', `${t}: unexpected ACL after the candidate`);
    assert.equal(scalar(`SELECT string_agg(format('%s:%s:%s:%s:%s:%s', polname, polcmd::text, polpermissive, polroles::regrole[]::text,
        coalesce(pg_get_expr(polqual, polrelid), ''), coalesce(pg_get_expr(polwithcheck, polrelid), '')), ';' ORDER BY polname)
        FROM pg_policy WHERE polrelid = 'public.${t}'::regclass;`),
      SELECT_POLICY(t), `${t}: policies after the candidate are not just the unchanged live SELECT policy`);
    assert.equal(scalar(`SELECT count(*) FROM pg_attribute a WHERE a.attrelid = 'public.${t}'::regclass AND a.attacl IS NOT NULL;`), '0', `${t}: has a column ACL`);
  }
  console.log('[prover] POSTFLIGHT: anon and authenticated hold only SELECT; service_role and metabase_ro unchanged; only the SELECT policies remain');
}

function preflightRefuses() {
  stageText('cand.sql', lf(CANDIDATE));
  for (const [setup, refusal, user] of [
    // A SECURITY INVOKER writer would break once the API roles lose their write grants.
    [`CREATE FUNCTION public.prover_invoker_writer(p uuid) RETURNS void LANGUAGE sql SET search_path = public, pg_temp
       AS $$ DELETE FROM public.order_line_allocations WHERE order_item_id = p $$;`,
     /ALLOCATION_WRITE_LOCK_PREFLIGHT: these functions may write or lock .*public\.prover_invoker_writer\(p uuid\)/],
    // An invoker function in another schema that only row-locks (FOR UPDATE needs UPDATE privilege).
    [`CREATE SCHEMA prover_x; CREATE FUNCTION prover_x.locker(p uuid) RETURNS void LANGUAGE plpgsql
       AS $$ BEGIN PERFORM 1 FROM public.allocation_sets WHERE id = p FOR UPDATE; END $$;`,
     /ALLOCATION_WRITE_LOCK_PREFLIGHT: these functions may write or lock .*prover_x\.locker\(p uuid\)/],
    // A definer writer without a fixed search_path.
    [`CREATE FUNCTION public.prover_loose_writer(p uuid) RETURNS void LANGUAGE sql SECURITY DEFINER
       AS $$ DELETE FROM order_line_allocations WHERE order_item_id = p $$;`,
     /ALLOCATION_WRITE_LOCK_PREFLIGHT: these functions may write or lock .*public\.prover_loose_writer\(p uuid\)/],
    // FORCEd row security would refuse the definer writers once the write policies are gone.
    ['ALTER TABLE public.allocation_sets FORCE ROW LEVEL SECURITY;',
     /ALLOCATION_WRITE_LOCK_PREFLIGHT: allocation_sets must have row security on, not forced/],
    // A new, well-formed writer the migration was not reviewed for.
    [`CREATE FUNCTION public.prover_new_writer(p uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
       AS $$ UPDATE allocation_sets SET notes = 'x' WHERE id = p $$;`,
     /ALLOCATION_WRITE_LOCK_PREFLIGHT: the writers of the allocation tables are not the four .*prover_new_writer/],
    // ...also one in another schema that writes with MERGE.
    [`CREATE SCHEMA prover_y; CREATE FUNCTION prover_y.merger(p uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
       AS $$ MERGE INTO ONLY public.allocation_sets s USING (SELECT p AS id) x ON s.id = x.id WHEN MATCHED THEN UPDATE SET notes = 'x' $$;`,
     /ALLOCATION_WRITE_LOCK_PREFLIGHT: the writers of the allocation tables are not the four .*prover_y\.merger/],
    // ...and one that quotes the schema and table names.
    [`CREATE FUNCTION public.prover_quoted_writer(p uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
       AS $$ DELETE FROM "public"."allocation_sets" WHERE id = p $$;`,
     /ALLOCATION_WRITE_LOCK_PREFLIGHT: the writers of the allocation tables are not the four .*prover_quoted_writer/],
    ['ALTER TABLE public.invoice_line_allocations DISABLE ROW LEVEL SECURITY;',
     /ALLOCATION_WRITE_LOCK_PREFLIGHT: invoice_line_allocations must have row security on/],
    // Role attributes need the platform superuser; the change still rolls back with the probe.
    ['ALTER ROLE postgres NOBYPASSRLS;', /ALLOCATION_WRITE_LOCK_PREFLIGHT: postgres lacks BYPASSRLS/, 'supabase_admin'],
  ]) {
    const d = docker([...psqlArgs(user)], { input: `BEGIN;\n${setup}\n\\i /tmp/cand.sql\nROLLBACK;`, allowFailure: true });
    assert.notEqual(d.status, 0, `the candidate applied over: ${setup}`);
    assert.match(d.stderr, refusal, `wrong refusal for ${setup}:\n${d.stderr}`);
  }
  console.log('[prover] PREFLIGHT: an invoker writer, an invoker row-locker in another schema, a definer writer without search_path, forced RLS, an unreviewed writer and RLS off each abort the candidate');
}

// A column-level write grant held BEFORE the candidate (live has none) is cleared by the table-level
// REVOKE, as PostgreSQL's REVOKE does ("the corresponding column privileges (if any) are automatically
// revoked on each column of the table, as well"), rather than surviving or aborting the apply.
function columnGrantCleared() {
  stageText('cand.sql', lf(CANDIDATE));
  const d = docker([...psqlArgs(), '-A', '-t'], {
    input: `BEGIN;
GRANT INSERT (amount_cents), UPDATE (amount_cents) ON public.invoice_line_allocations TO authenticated;
GRANT UPDATE (notes) ON public.allocation_sets TO authenticated;
SELECT 'PRE|' || has_any_column_privilege('authenticated', 'public.invoice_line_allocations', 'INSERT')::text;
\\i /tmp/cand.sql
SELECT 'POST|' || (has_any_column_privilege('authenticated', 'public.invoice_line_allocations', 'INSERT')
  OR has_any_column_privilege('authenticated', 'public.invoice_line_allocations', 'UPDATE')
  OR has_any_column_privilege('authenticated', 'public.allocation_sets', 'UPDATE'))::text;
ROLLBACK;`,
    allowFailure: true,
  });
  assert.equal(d.status, 0, `the candidate did not apply over pre-existing column grants:\n${d.stderr}`);
  assert.match(d.stdout, /PRE\|true/, 'the column grant was not in place before the candidate');
  assert.match(d.stdout, /POST\|false/, `a column write grant survived the candidate:\n${d.stdout}`);
  console.log('[prover] COLUMN GRANTS: column-level write grants held before the candidate are cleared by it');
}

function verifyRefuses() {
  // The verify block catches a write grant that survives (here: one a column grant re-adds).
  stageText('cand.sql', lf(CANDIDATE));
  const body = lf(CANDIDATE).split('DO $verify$')[1];
  stageText('verify.sql', `DO $verify$${body}`);
  const d = docker([...psqlArgs()], { input: 'BEGIN;\nGRANT UPDATE (notes) ON public.allocation_sets TO authenticated;\n\\i /tmp/verify.sql\nROLLBACK;', allowFailure: true });
  assert.notEqual(d.status, 0, 'the verify block passed with a column UPDATE grant');
  assert.match(d.stderr, /ALLOCATION_WRITE_LOCK_VERIFY: authenticated still holds (UPDATE on|a column write privilege on) allocation_sets/, d.stderr);
  console.log('[prover] VERIFY: a surviving column write grant fails the postflight');
}

function main() {
  if (!REUSE || scalar("SELECT count(*) FROM pg_class WHERE relname = 'allocation_sets';") === '0') buildContainer();
  else assert.equal(scalar("SELECT count(*) FROM pg_policy WHERE polname = 'invoice_line_alloc_insert';"), '1',
    'the reused container already has the candidate applied (it is in the AFTER state); rebuild it');
  fidelity();
  if (scalar("SELECT count(*) FROM public.profiles WHERE id::text LIKE '7c710000-%';") === '0') seed();

  const before = runMatrix('before');
  check('before', before);
  preflightRefuses();
  columnGrantCleared();

  stageText('candidate.sql', lf(CANDIDATE));
  // Applied the way the apply script does: one transaction, so a failed verify rolls everything back.
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  console.log('[prover] candidate applied');
  postflightPicture();

  const after = runMatrix('after');
  check('after', after, before);
  verifyRefuses();

  const again = apply('candidate.sql');
  assert.equal(again.status, 0, `re-applying the candidate failed:\n${again.output}`);
  postflightPicture();
  check('after', runMatrix('re-apply'), before);
  console.log('[prover] RE-APPLY: the candidate re-applies cleanly and every result is unchanged');

  // MUTATION: put back the INSERT grant and policy the candidate removed; the rep's fake line
  // allocation goes through again, so the AFTER refusal is this migration and nothing else.
  const mutant = attempt(U.REP, {
    ...FAKE_ILA,
    fixture: `GRANT INSERT ON public.invoice_line_allocations TO authenticated;
CREATE POLICY invoice_line_alloc_insert ON public.invoice_line_allocations FOR INSERT WITH CHECK (is_admin() OR is_sales_rep());`,
  });
  assert.match(mutant, OK(1), `MUTATION: with the grant and policy restored the rep should insert again, got ${mutant}`);
  const grantOnly = attempt(U.REP, { ...FAKE_ILA, fixture: 'GRANT INSERT ON public.invoice_line_allocations TO authenticated;' });
  assert.match(grantOnly, RLS('invoice_line_allocations'), `MUTATION: with only the grant restored row security should still refuse, got ${grantOnly}`);
  console.log('[prover] MUTATION: restoring the grant and policy re-opens the fake allocation; the grant alone is still stopped by row security (two independent locks)');

  console.log('PAYMENT_ALLOCATION_NO_DIRECT_WRITES_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
