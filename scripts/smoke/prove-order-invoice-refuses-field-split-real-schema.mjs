#!/usr/bin/env node
/**
 * Full-chain proof for the 20261022021000 candidate: create_invoice_from_order refuses an order
 * whose lines are split across fields (ORDER_HAS_FIELD_SPLIT), after its replay lookup.
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers), then:
 *   0. FIDELITY: every body the candidate's preflight pins replayed with its live md5 of 2026-10-22 (re-read after PR #1010);
 *   1. BEFORE: the new chain fails first at its step 1 (an allocated order bills one customer), and
 *      every other registered chain covering the two order-invoice RPCs passes;
 *   2. AUTOCOMMIT: run statement by statement (psql -f, no -1) the file stops at its preflight;
 *      PREFLIGHT: a drifted body aborts the candidate before any change;
 *   3. the candidate applies and prints POSTFLIGHT_OK;
 *   4. AFTER: the new chain and every other covering chain pass and roll back;
 *   5. RACE: an allocation inserted by another connection and still uncommitted makes the invoice
 *      call wait on the line lock and then refuse; with the line lock removed the same race bills
 *      the order to one customer, so the lock is what closes it;
 *   6. RE-APPLY: refused by the preflight's own pins;
 *   7. MUTATION: with the refusal removed the chain fails at step 1, and with the refusal moved
 *      before the replay lookup it fails at step 3 (the exact retry no longer replays), and with
 *      the early live-delivery refusal removed it fails at step 6 (ORDER_HAS_FIELD_SPLIT instead).
 *
 * Run: node scripts/smoke/prove-order-invoice-refuses-field-split-real-schema.mjs   (needs Docker)
 * Prints ORDER_INVOICE_FIELD_SPLIT_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-order-invoice-field-split-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261022021000_order_invoice_refuses_field_split.sql');
// Live but not replayable here (storage.objects policies, storage.buckets settings); it must not touch what this proves.
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
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
const SMOKE = path.join(ROOT, 'scripts', 'smoke');
const FIELD_SPLIT_CHAIN = path.join(SMOKE, 'smoke-order-invoice-refuses-field-split.sql');
// Every other registered chain whose `covers` names either order-invoice wrapper.
const COVERING_CHAINS = [
  'smoke-order-invoice-type-gate.sql',
  'smoke-order-invoice-rep-own-name.sql',
  'smoke-backfill-refuse-split-billing.sql',
  'smoke-govern-invoice-order-money-lifecycle.sql',
  'smoke-money-lifecycle-idempotency-required.sql',
];
const SUPERUSER_CHAINS = new Set(['smoke-govern-invoice-order-money-lifecycle.sql']);
const IDEM = '_create_invoice_from_order_idem_impl_20260721';

const id = (n) => `7a500000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), REP: id('b1'), REP_B: id('b2'), DRIVER: id('d1'), APPLICATOR: id('e1') };

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
// Record a migration in the ledger by NAME (later preflights look names up), versioned by its own
// stamp: an older file's high-water check compares versions, so only stamps are used.
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
  // The replay plan withholds the one-shot data migrations (they rewrite live rows this
  // disposable database does not have); none of them touches the order-invoice functions.
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const at = all.indexOf(CANDIDATE);
  assert.ok(at >= 0, 'the candidate must be selected for post-baseline replay');
  assert.equal(at, all.length - 1, 'the candidate must be the last migration in the replay plan');
  const before = all.slice(0, at);
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!/invoice_from_order|split_invoices_from_order|order_item_field_allocations/i.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
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
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text);
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  const files = plan();
  let replayed = 0;
  for (const [i, file] of files.entries()) {
    const base = path.basename(file);
    if (PARKED.has(base)) continue;
    // The replay plan omits the data-only files; record each once the replay passes its stamp.
    for (const only of LEDGER_ONLY) if (only < base) ledger(path.basename(only, '.sql'));
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    // Batch 2's preflight pins live's auth.uid() body, which live had when batch 2 was applied.
    if (base === '20261016140000_bind_stock_replay_receipts_batch2.sql') installLiveAuthUid();
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    // Later preflights look their predecessors up in the ledger by name, as on live.
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

// ------------------------------------------------------------------------------------------------
// FIDELITY: the md5 pins the candidate's preflight checks, read from the candidate file itself.
// The pins were read from live (read-only pg_proc queries, 2026-10-22, after PR #1010); this checks the replay matches.
function fidelity() {
  const sql = lf(CANDIDATE).split('$preflight$')[1];
  const contracts = [...sql.matchAll(/md5\(replace\(p\.prosrc, chr\(13\), ''\)\) = '([0-9a-f]{32})'/g)].map((m) => m[1]);
  assert.equal(contracts.length, 1, 'the preflight pins the idempotency layer by contract');
  const pins = [
    [`public.${IDEM}(uuid,uuid,text,text)`, contracts[0]],
    // The dependency list: the wrapper, the billing core and both split functions.
    ...[...sql.matchAll(/\('(public\.[^']+\))', '([0-9a-f]{32})'\)/g)].map((m) => [m[1], m[2]]),
  ];
  assert.equal(pins.length, 5, 'the preflight pins five bodies');
  for (const [sig, pin] of pins) {
    assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${sig}');`), pin, `${sig} replayed with a body that differs from the live pin`);
  }
  console.log(`[prover] FIDELITY: all ${pins.length} pinned bodies match the live pins of 2026-10-22`);
}

// ------------------------------------------------------------------------------------------------
function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.REP, 'sales_rep', 'Rep', 8], [U.REP_B, 'sales_rep', 'Rep B', 7], [U.DRIVER, 'driver', 'Driver', 6], [U.APPLICATOR, 'applicator', 'Applicator', 5]];
  // Auth columns and tables the hosted project has and the image lacks, as in the other
  // real-schema provers.
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'field-split-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7a500000-%';`),
    'admin:true,sales_rep:true,sales_rep:true,driver:true,applicator:true', 'the seeded roles are not what the proof needs');
}

/** Run a chain file; `prefix` runs first in the same transaction (a mutation). */
function chain(file, prefix = '', user = 'postgres') {
  stageText('chain.sql', lf(file));
  const r = docker([...psqlArgs(user)], { input: `BEGIN;\n${prefix}\n\\i /tmp/chain.sql\nROLLBACK;\n`, allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const pass = /SMOKE_PASS_ROLLBACK/.test(out);
  const fail = /SMOKE_FAIL[^\n]*/.exec(out)?.[0] ?? (pass ? '' : (/ERROR:[^\n]*/.exec(out)?.[0] ?? out.trim().slice(-400)));
  return { pass, fail };
}
function runCovering(phase) {
  for (const name of COVERING_CHAINS) {
    // The money-lifecycle chain rebuilds legacy history only as a superuser, which the image's
    // postgres role is not.
    const r = chain(path.join(SMOKE, name), '', SUPERUSER_CHAINS.has(name) ? 'supabase_admin' : 'postgres');
    assert.ok(r.pass, `${phase}: ${name} did not pass: ${r.fail}`);
  }
  console.log(`[prover] ${phase}: all ${COVERING_CHAINS.length} other covering chains pass and roll back`);
}

function candidateBody(fn) {
  const sql = lf(CANDIDATE);
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  assert.ok(start >= 0, `${fn} is not in the candidate`);
  const a = sql.indexOf('AS $function$', start) + 'AS $function$'.length;
  return { header: sql.slice(start, a), body: sql.slice(a, sql.indexOf('$function$;', a)) };
}
function mutate(fn, find, replacement, label) {
  const { header, body } = candidateBody(fn);
  assert.equal(body.split(find).length - 1, 1, `mutation "${label}": hunk not found exactly once`);
  return `${header}${body.replace(find, replacement)}$function$;`;
}

// The hunks, as they appear in the candidate body.
const LINE_LOCK = '  PERFORM 1\n    FROM public.order_items oi\n   WHERE oi.order_id = p_order_id\n   ORDER BY oi.id\n   FOR UPDATE;\n';
const REFUSAL = "  IF EXISTS (\n    SELECT 1\n      FROM public.order_item_field_allocations oifa\n      JOIN public.order_items oi ON oi.id = oifa.order_item_id\n     WHERE oi.order_id = p_order_id\n  ) THEN\n    RAISE EXCEPTION 'ORDER_HAS_FIELD_SPLIT: this order is split across fields; bill it per field owner through create_split_invoices_from_order'\n      USING ERRCODE = 'check_violation';\n  END IF;\n";
const REPLAY_LOOKUP = '  IF p_idempotency_key IS NOT NULL THEN\n    v_existing := public.check_idempotency(';

// ------------------------------------------------------------------------------------------------
// RACE: committed fixtures (two unallocated one-line orders on a priced product), then two
// connections: B inserts an allocation and holds its transaction open; A asks for the invoice.
function raceFixtures() {
  psql(`DO $race$
DECLARE
  v_admin uuid := '${U.ADMIN}';
  v_product uuid;
  v_customer uuid;
  v_owner uuid;
  v_pricing jsonb;
  v_order uuid;
  v_i integer;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  INSERT INTO public.products (product_name, unit_size) VALUES ('[PROVER] Race Product', 'GL') RETURNING id INTO v_product;
  v_pricing := public.preview_product_pricing_changes('product_page', NULL,
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'row_version', 1, 'pricing_mode', 'price_driven',
      'new_cost', '5.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00')),
    v_admin, 'prover-race-pricing-preview');
  PERFORM public.apply_product_pricing_change_set((v_pricing->>'change_set_id')::uuid, v_pricing->>'request_fingerprint', v_admin, 'prover-race-pricing-apply');
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size) VALUES (v_product, 'Main Warehouse', 100, 0, 'GL');
  INSERT INTO public.customers (farm_name) VALUES ('[PROVER] Race Orderer') RETURNING id INTO v_customer;
  INSERT INTO public.customers (farm_name) VALUES ('[PROVER] Race Owner') RETURNING id INTO v_owner;
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres) VALUES (v_owner, '[PROVER] Race Field', 'corn', 100);
  FOR v_i IN 1..2 LOOP
    INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
    VALUES ('PROVER-RACE-' || v_i, v_customer, (now() AT TIME ZONE 'America/Chicago')::date, 'confirmed', false, NULL)
    RETURNING id INTO v_order;
    INSERT INTO public.order_items (order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product, '[PROVER] race line ' || v_i, 10, 5, 2, 20, 10, 50, 0, 2);
  END LOOP;
END
$race$;`);
  const order = (n) => scalar(`SELECT id FROM public.orders WHERE order_number = 'PROVER-RACE-${n}';`);
  const item = (n) => scalar(`SELECT oi.id FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id WHERE o.order_number = 'PROVER-RACE-${n}';`);
  return {
    field: scalar("SELECT id FROM public.fields WHERE field_name = '[PROVER] Race Field';"),
    orders: [order(1), order(2)],
    items: [item(1), item(2)],
  };
}
function raceOnce(fixtures, n, prefix) {
  const holdSeconds = 4;
  // B: insert the allocation, then hold the transaction open before committing.
  const b = spawn('docker', [...psqlArgs()], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let bOut = '';
  b.stdout.on('data', (d) => { bOut += d; });
  b.stderr.on('data', (d) => { bOut += d; });
  const bDone = new Promise((resolve) => b.on('close', resolve));
  b.stdin.end(`BEGIN;
INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres) VALUES ('${fixtures.items[n]}', '${fixtures.field}', 100);
SELECT pg_sleep(${holdSeconds});
COMMIT;
`);
  wait(1500);
  assert.equal(scalar(`SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(${holdSeconds})%' AND state = 'active' AND pid <> pg_backend_pid();`), '1', 'RACE: the allocating connection is not holding its transaction open');
  // A: ask for the single invoice while B's allocation is uncommitted.
  const started = Date.now();
  const a = docker([...psqlArgs(), '-A', '-t'], {
    input: `BEGIN;
${prefix}
SELECT set_config('request.jwt.claims', '{"sub":"${U.ADMIN}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${U.ADMIN}', true);
SELECT 'INVOICE=' || public.create_invoice_from_order('${fixtures.orders[n]}', NULL, 'chemical_sale', 'prover-race-${n}');
ROLLBACK;
`,
    allowFailure: true,
  });
  const elapsed = Date.now() - started;
  return bDone.then((code) => {
    assert.equal(code, 0, `RACE: the allocating connection failed:\n${bOut}`);
    return { out: `${a.stdout}\n${a.stderr}`, elapsed };
  });
}
async function race() {
  const fixtures = raceFixtures();
  // With the candidate as applied: A waits for B's commit on the line lock, then sees the row.
  const locked = await raceOnce(fixtures, 0, '');
  assert.match(locked.out, /ORDER_HAS_FIELD_SPLIT/, `RACE: the invoice call did not refuse the concurrently split order:\n${locked.out}`);
  assert.ok(locked.elapsed >= 2000, `RACE: the invoice call did not wait for the allocating transaction (${locked.elapsed} ms)`);
  console.log(`[prover] RACE: the invoice call waited ${locked.elapsed} ms on the line lock, then refused with ORDER_HAS_FIELD_SPLIT`);
  // MUTATION: without the line lock the same race bills the order to one customer.
  const unlocked = await raceOnce(fixtures, 1, mutate(IDEM, LINE_LOCK, '', 'line lock'));
  assert.match(unlocked.out, /INVOICE=[0-9a-f-]{36}/, `RACE MUTATION: without the line lock the race did not bill (so the race test proves nothing):\n${unlocked.out}`);
  console.log('[prover] RACE MUTATION: without the line lock the concurrently split order is billed to one customer');
  assert.equal(scalar(`SELECT count(*) FROM public.invoices WHERE order_id IN ('${fixtures.orders[0]}', '${fixtures.orders[1]}');`), '0', 'RACE: an invoice survived a rolled-back race call');
}

async function main() {
  buildContainer();
  fidelity();
  seed();

  // 1. BEFORE.
  const before = chain(FIELD_SPLIT_CHAIN);
  assert.ok(!before.pass, 'BEFORE: the field-split chain passed against the pre-fix implementation');
  assert.match(before.fail, /SMOKE_FAIL: create_invoice_from_order billed an order split across fields to one customer/, `BEFORE: wrong first failure: ${before.fail}`);
  console.log('[prover] BEFORE: the field-split chain fails first at step 1 (an allocated order billed one customer)');
  runCovering('BEFORE');

  // 2. AUTOCOMMIT and PREFLIGHT.
  stageText('candidate.sql', lf(CANDIDATE));
  const auto = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(auto.status, 0, 'AUTOCOMMIT: the candidate ran outside one transaction');
  assert.match(auto.stderr, /ORDER_INVOICE_FIELD_SPLIT_NOT_IN_TRANSACTION/, `AUTOCOMMIT: wrong refusal:\n${auto.stderr}`);
  const drift = docker([...psqlArgs()], {
    input: `BEGIN;
CREATE OR REPLACE FUNCTION public.${IDEM}(p_order_id uuid, p_salesman_id uuid DEFAULT NULL, p_invoice_type text DEFAULT 'chemical_sale', p_idempotency_key text DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN NULL; END; $$;
\\i /tmp/candidate.sql
ROLLBACK;`,
    allowFailure: true,
  });
  assert.notEqual(drift.status, 0, 'PREFLIGHT: the candidate applied over a drifted body');
  assert.match(drift.stderr, /PREFLIGHT_ORDER_INVOICE_IDEM_DRIFT/, `PREFLIGHT: wrong refusal:\n${drift.stderr}`);
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname = '${IDEM}' AND prosrc LIKE '%ORDER_HAS_FIELD_SPLIT%';`), '0', 'a refused apply left a change behind');
  console.log('[prover] AUTOCOMMIT + PREFLIGHT: outside one transaction, or over a drifted body, the candidate stops before any change');

  // 3. APPLY.
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.match(a.output, /POSTFLIGHT_OK/, `the postflight did not report OK:\n${a.output}`);
  console.log('[prover] candidate applied; POSTFLIGHT_OK');

  // 4. AFTER.
  const after = chain(FIELD_SPLIT_CHAIN);
  assert.ok(after.pass, `AFTER: the field-split chain failed: ${after.fail}`);
  console.log('[prover] AFTER: the field-split chain passes and rolls back');
  runCovering('AFTER');

  // 5. RACE.
  await race();

  // 6. RE-APPLY.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /PREFLIGHT_ORDER_INVOICE_IDEM_DRIFT/, `second apply refused for the wrong reason:\n${again.output}`);
  console.log('[prover] RE-APPLY: refused by the preflight, nothing changed');

  // 7. MUTATION: each placement is what its chain step proves.
  const removed = chain(FIELD_SPLIT_CHAIN, mutate(IDEM, REFUSAL, '', 'refusal'));
  assert.ok(!removed.pass, 'MUTATION refusal: the chain still passed without the refusal');
  assert.match(removed.fail, /SMOKE_FAIL: create_invoice_from_order billed an order split across fields to one customer/, `MUTATION refusal: wrong failure: ${removed.fail}`);
  console.log(`[prover] MUTATION: without the refusal the chain fails: ${removed.fail}`);
  const { header, body } = candidateBody(IDEM);
  assert.equal(body.split(REFUSAL).length - 1, 1, 'mutation "before replay": refusal not found exactly once');
  assert.equal(body.split(REPLAY_LOOKUP).length - 1, 1, 'mutation "before replay": replay lookup not found exactly once');
  const early = `${header}${body.replace(REFUSAL, '').replace(REPLAY_LOOKUP, `${REFUSAL}\n${REPLAY_LOOKUP}`)}$function$;`;
  const moved = chain(FIELD_SPLIT_CHAIN, early);
  assert.ok(!moved.pass, 'MUTATION before replay: the chain still passed with the refusal ahead of the replay lookup');
  assert.match(moved.fail, /SMOKE_FAIL: an exact retry of an invoice created before the split did not replay its id/, `MUTATION before replay: wrong failure: ${moved.fail}`);
  console.log(`[prover] MUTATION: with the refusal ahead of the replay lookup the chain fails: ${moved.fail}`);
  // Without the early live-delivery refusal, step 6's order reaches the field-split test instead.
  const deliveryStart = body.indexOf('  IF EXISTS (\n    SELECT 1 FROM public.deliveries d');
  assert.ok(deliveryStart >= 0, 'mutation "delivery": the live-delivery refusal is not in the body');
  const DELIVERY_REFUSAL = body.slice(deliveryStart, body.indexOf('  END IF;\n', deliveryStart) + '  END IF;\n'.length);
  const noDelivery = chain(FIELD_SPLIT_CHAIN, mutate(IDEM, DELIVERY_REFUSAL, '', 'delivery'));
  assert.ok(!noDelivery.pass, 'MUTATION delivery: the chain still passed without the live-delivery refusal');
  assert.match(noDelivery.fail, /SMOKE_FAIL: wrong live-delivery refusal: ORDER_HAS_FIELD_SPLIT/, `MUTATION delivery: wrong failure: ${noDelivery.fail}`);
  console.log(`[prover] MUTATION: without the live-delivery refusal the chain fails: ${noDelivery.fail}`);

  console.log('ORDER_INVOICE_FIELD_SPLIT_PROOF_PASS');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); });
