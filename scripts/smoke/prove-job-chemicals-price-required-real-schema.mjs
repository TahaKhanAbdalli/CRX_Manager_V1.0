#!/usr/bin/env node
/**
 * Real-schema proof for the 20261022087000 candidate: a trigger on job_chemicals refuses a billable
 * chemical line priced 0 whose product states no price for the job customer's tier (PR #1060).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers), seeds an admin, a sales rep, a driver, a tier-3 and
 * a tier-1 customer and five products (no price, priced, stated $0, tier-3 only, tier-1 only), then,
 * each write made as that signed-in user and rolled back:
 *   0. FIDELITY: job_chemicals carries only the three live triggers; the candidate's function and
 *      trigger do not exist yet;
 *   1. BEFORE: an unpriced line at 0 saves through save_job (admin and rep, alone or next to a
 *      priced line, a tier-3-only product for a tier-1 customer), a direct INSERT of one succeeds,
 *      and so does an UPDATE of an existing one; the kept saves succeed; one unpriced save is
 *      committed under a retry key;
 *   2. AUTOCOMMIT: run statement by statement the file stops at its preflight, nothing changed;
 *   3. the candidate applies and prints POSTFLIGHT_OK;
 *   4. AFTER: every gap write is refused with CHEM_PRICE_REQUIRED; a typed price, customer
 *      supplied, quantity 0, a stated $0, a priced product typed at 0, and a tier-1 fallback still
 *      save; a driver still gets INSUFFICIENT_ROLE; the pre-change keyed save replays; a different
 *      payload under its key is still refused;
 *   5. RE-APPLY: refused by the preflight;
 *   6. MUTATION: dropping the tier-1 fallback, reading tier 2 from tier 3, the check, the
 *      customer-supplied exemption or the quantity-0 exemption each changes an outcome.
 *
 * Run: node scripts/smoke/prove-job-chemicals-price-required-real-schema.mjs   (needs Docker)
 * Prints JOB_CHEMICALS_PRICE_REQUIRED_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-job-chem-price-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261022087000_job_chemicals_refuse_unpriced_zero_price_line.sql');
// Live but not replayable here (storage.objects policies, storage.buckets settings); it must not touch what this proves.
const PARKED = new Set([
  '20260914100700_customer_document_bytes_server_only.sql',
  '20261015230000_staff_photo_storage_access.sql',
  '20261016030000_staff_photo_buckets_private.sql',
  // Needs storage.objects.metadata and a delivery-signatures bucket this container's storage stub lacks.
  '20261022075000_delivery_completion_evidence.sql',
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
const COVERED = /save_job|job_chemicals/i;


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
  // Later migrations (queued after this one) are not replayed: the proof runs on the schema this
  // candidate applies to.
  const before = all.slice(0, at);
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!COVERED.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
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
// Fixture and probes.
const LIVE_TRIGGERS = 'trg_sync_job_holds_del,trg_sync_job_holds_ins,trg_sync_job_holds_upd';
const id = (n) => `7a560000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const U = { ADMIN: id(1), REP: id(2), DRIVER: id(3) };
const CUST3 = id(201); // tier 3
const CUST1 = id(202); // tier 1
const CUST2 = id(203); // tier 2
const FIELD3 = id(211);
const FIELD1 = id(212);
const FIELD2 = id(213);
const P = {
  UNPRICED: id(301), // no price at any tier
  PRICED: id(302), // tier1 $10, tier3 $7
  FREE: id(303), // tier1 stated $0
  TIER3_ONLY: id(304), // tier3 $5, no tier-1 price
  T1_ONLY: id(305), // tier1 $10, no tier-3 price
  TIER2_ONLY: id(306), // tier2 $9, no tier-1 price
};
const TODAY = 'current_date';

function seed() {
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;`, { user: 'supabase_admin' });
  psql([['ADMIN', 'admin'], ['REP', 'sales_rep'], ['DRIVER', 'driver']].map(([k, role]) => `INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES ('${U[k]}', 'price-required-${k.toLowerCase()}@example.invalid', '{"full_name":"[PROVER] ${k}","role":"${role}"}'::jsonb);`).join('\n'));
  psql(`SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, is_active, assigned_tier) VALUES
      ('${CUST3}', '[PROVER] Tier 3 Farm', true, 3), ('${CUST1}', '[PROVER] Tier 1 Farm', true, 1),
      ('${CUST2}', '[PROVER] Tier 2 Farm', true, 2);
    INSERT INTO public.fields (id, customer_id, field_name, total_acres) VALUES
      ('${FIELD3}', '${CUST3}', '[PROVER] Field 3', 100), ('${FIELD1}', '${CUST1}', '[PROVER] Field 1', 100),
      ('${FIELD2}', '${CUST2}', '[PROVER] Field 2', 100);
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, tier2_price, tier3_price, product_form, is_active) VALUES
      ('${P.UNPRICED}', '[PROVER] Unpriced', 'gal', 5, NULL, NULL, NULL, 'liquid', true),
      ('${P.PRICED}', '[PROVER] Priced', 'gal', 5, 10, 9, 7, 'liquid', true),
      ('${P.FREE}', '[PROVER] Free', 'gal', 5, 0, NULL, NULL, 'liquid', true),
      ('${P.TIER3_ONLY}', '[PROVER] Tier3 only', 'gal', 5, NULL, NULL, 5, 'liquid', true),
      ('${P.T1_ONLY}', '[PROVER] Tier1 only', 'gal', 5, 10, NULL, NULL, 'liquid', true),
      ('${P.TIER2_ONLY}', '[PROVER] Tier2 only', 'gal', 5, NULL, 9, NULL, 'liquid', true);
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
}

const j = (v) => `'${JSON.stringify(v)}'::jsonb`;
function line(product, { price = 0, qty = 10, supplied = false } = {}) {
  return { product_id: product, quantity: qty, unit: 'gal', rate_per_acre: qty / 10, rate_unit: 'gal/ac', cost_per_unit_cents: 500, price_per_unit_cents: price, customer_supplied: supplied, sort_order: 0 };
}
function save(cust, chems, key = null) {
  const field = cust === CUST3 ? FIELD3 : cust === CUST2 ? FIELD2 : FIELD1;
  return `public.save_job(NULL, jsonb_build_object('customer_id', '${cust}', 'job_date', ${TODAY}), ${j([{ field_id: field, acres_to_treat: 10, sort_order: 0 }])}, ${j(chems)}, auth.uid(), ${key ? `'${key}'` : 'NULL'})->>'success'`;
}
// Direct writes on the job the keyed save commits (staff hold INSERT/UPDATE policies on job_chemicals).
const KEYED_JOB = `(SELECT jc.job_id FROM public.job_chemicals jc WHERE jc.product_id = '${P.UNPRICED}' LIMIT 1)`;
// A STMT: probe runs as its own statement and reports ok when it does not raise.
const DIRECT_INSERT = `STMT:INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, price_per_unit_cents, sort_order)
  SELECT ${KEYED_JOB}, '${P.UNPRICED}', 5, 'gal', 0, 99`;
const DIRECT_UPDATE = `STMT:UPDATE public.job_chemicals SET quantity = 5 WHERE product_id = '${P.UNPRICED}'`;
// Un-tick customer supplied on a committed unpriced line at 0 (seeded supplied by the keyed save's job).
const DIRECT_UNTICK = `STMT:INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, price_per_unit_cents, customer_supplied, sort_order)
  SELECT ${KEYED_JOB}, '${P.UNPRICED}', 5, 'gal', 0, true, 97;
  UPDATE public.job_chemicals SET customer_supplied = false WHERE sort_order = 97`;
const DIRECT_INSERT_SUPPLIED =`STMT:INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, price_per_unit_cents, customer_supplied, sort_order)
  SELECT ${KEYED_JOB}, '${P.UNPRICED}', 5, 'gal', 0, true, 98`;

/** `sql` as a signed-in user, rolled back unless `commit`. Returns the last value or ERR:<message>. */
function as(user, sql, { prefix = '', commit = false } = {}) {
  const jwt = JSON.stringify({ sub: U[user], role: 'authenticated' });
  const r = docker([...psqlArgs(), '-A', '-t'], { allowFailure: true, input: `BEGIN;
    ${prefix}
    SET LOCAL ROLE authenticated;
    SELECT set_config('request.jwt.claims', '${jwt}', true);
    ${sql.startsWith('STMT:') ? `${sql.slice(5)};\n    SELECT 'OUT=ok';` : `SELECT 'OUT=' || COALESCE((${sql})::text, '<null>');`}
    ${commit ? 'COMMIT' : 'ROLLBACK'};` });
  if (r.status !== 0) {
    const m = /ERROR:\s+([^\n]*)/.exec(r.stderr);
    return `ERR:${m ? m[1].trim() : r.stderr.trim()}`;
  }
  return /OUT=(.*)/.exec(r.stdout)?.[1] ?? `(no output) ${r.stdout}`;
}

const REFUSED = /CHEM_PRICE_REQUIRED: \[PROVER\] (Unpriced|Tier3 only|Tier2 only) has no price for this customer's tier/;
/** Writes the candidate must refuse (all succeed before it). [user, label, sql, result before] */
const GAPS = [
  ['ADMIN', 'save_job: unpriced at 0, tier 3', save(CUST3, [line(P.UNPRICED)]), 'true'],
  ['REP', 'save_job: unpriced at 0, tier 3 (rep)', save(CUST3, [line(P.UNPRICED)]), 'true'],
  ['ADMIN', 'save_job: unpriced at 0 next to a priced line', save(CUST3, [line(P.PRICED, { price: 700 }), line(P.UNPRICED)]), 'true'],
  ['ADMIN', 'save_job: tier-3-only product, tier-1 customer', save(CUST1, [line(P.TIER3_ONLY)]), 'true'],
  ['ADMIN', 'direct INSERT of an unpriced line at 0', DIRECT_INSERT, 'ok'],
  ['ADMIN', 'direct UPDATE of an unpriced line at 0', DIRECT_UPDATE, 'ok'],
  ['REP', 'direct INSERT of an unpriced line at 0 (rep)', DIRECT_INSERT, 'ok'],
  ['ADMIN', 'un-tick customer supplied on an unpriced line at 0', DIRECT_UNTICK, 'ok'],
  ['ADMIN', 'save_job: tier-2-only product, tier-3 customer', save(CUST3, [line(P.TIER2_ONLY)]), 'true'],
];
/** Writes that must keep working, with the same result before and after. */
const KEPT = [
  ['ADMIN', 'unpriced with a typed price', save(CUST3, [line(P.UNPRICED, { price: 500 })])],
  ['ADMIN', 'unpriced, customer supplied', save(CUST3, [line(P.UNPRICED, { supplied: true })])],
  ['ADMIN', 'unpriced, quantity 0', save(CUST3, [{ ...line(P.UNPRICED, { qty: 0 }), rate_per_acre: null }])],
  ['ADMIN', 'stated $0 product at 0', save(CUST3, [line(P.FREE)])],
  ['ADMIN', 'priced product typed at 0', save(CUST3, [line(P.PRICED)])],
  ['ADMIN', 'tier-3-only product at 0, tier-3 customer', save(CUST3, [line(P.TIER3_ONLY)])],
  ['ADMIN', 'tier-1-only product at 0, tier-3 customer', save(CUST3, [line(P.T1_ONLY)])],
  ['ADMIN', 'tier-2-only product at 0, tier-2 customer', save(CUST2, [line(P.TIER2_ONLY)])],
  ['REP', 'priced product at its price (rep)', save(CUST3, [line(P.PRICED, { price: 700 })])],
  ['ADMIN', 'direct INSERT, customer supplied', DIRECT_INSERT_SUPPLIED],
];
const REPLAY_KEY = 'prover-price-required-replay';
const FN = '_job_chemical_price_required()';

function candidateFunction() {
  const s = lf(CANDIDATE);
  const start = s.indexOf('CREATE FUNCTION public._job_chemical_price_required(');
  const end = s.indexOf('$function$;', s.indexOf('$function$', start) + 10) + '$function$;'.length;
  assert.ok(start > 0 && end > start, 'candidate trigger function not found');
  return s.slice(start, end).replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
}
const triggers = () => scalar("SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.job_chemicals'::regclass AND NOT tgisinternal;");

function main() {
  buildContainer();
  // 0. FIDELITY.
  assert.equal(triggers(), LIVE_TRIGGERS, 'the replayed job_chemicals triggers differ from live');
  assert.equal(scalar("SELECT to_regproc('public._job_chemical_price_required') IS NULL;"), 't', 'the trigger function already exists');
  console.log(`[prover] FIDELITY: job_chemicals carries the three live triggers (${LIVE_TRIGGERS}); the candidate's do not exist`);
  seed();

  // 1. BEFORE. The keyed save is committed first: the direct writes use its job.
  assert.equal(as('ADMIN', save(CUST3, [line(P.UNPRICED)], REPLAY_KEY), { commit: true }), 'true', 'BEFORE: the keyed save failed');
  const kept = {};
  for (const [u, label, sql] of KEPT) {
    kept[label] = as(u, sql);
    assert.ok(kept[label] === 'true' || kept[label] === 'ok', `BEFORE: ${label} did not save: ${kept[label]}`);
  }
  for (const [u, label, sql, ok] of GAPS) {
    const got = as(u, sql);
    assert.equal(got, ok, `BEFORE: ${label} was already refused: ${got}`);
    console.log(`[prover] BEFORE: ${label.padEnd(50)} -> succeeds (${got})`);
  }
  console.log(`[prover] BEFORE: ${KEPT.length} other writes succeed; an unpriced line at 0 is committed under key ${REPLAY_KEY}`);

  // 2. AUTOCOMMIT.
  stageText('candidate.sql', lf(CANDIDATE));
  const ac = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(ac.status, 0, 'autocommit apply did not stop');
  assert.match(`${ac.stdout}\n${ac.stderr}`, /PREFLIGHT_FAIL: run this file as one transaction/, 'autocommit stopped for the wrong reason');
  assert.equal(triggers(), LIVE_TRIGGERS, 'autocommit added a trigger');
  console.log('[prover] AUTOCOMMIT: refused by the preflight, nothing changed');

  // 3. APPLY.
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.match(a.output, /POSTFLIGHT_OK/, `no POSTFLIGHT_OK:\n${a.output}`);
  assert.equal(scalar(`SELECT proacl::text FROM pg_proc WHERE oid = 'public.${FN}'::regprocedure;`), '{postgres=X/postgres}', 'an API role can execute the trigger function');
  console.log('[prover] candidate applied; POSTFLIGHT_OK; no API role can execute the trigger function');

  // 4. AFTER.
  for (const [u, label, sql] of GAPS) {
    const got = as(u, sql);
    assert.match(got, REFUSED, `AFTER: ${label} was not refused: ${got}`);
    console.log(`[prover] AFTER: ${label.padEnd(50)} -> ${got.slice(0, 80)}`);
  }
  for (const [u, label, sql] of KEPT) {
    assert.equal(as(u, sql), kept[label], `AFTER: ${label} changed`);
  }
  console.log(`[prover] AFTER: the ${KEPT.length} other writes still succeed`);
  const driver = as('DRIVER', save(CUST1, [line(P.TIER3_ONLY)]));
  assert.match(driver, /INSUFFICIENT_ROLE/, `AFTER: a driver got past the role gate: ${driver}`);
  console.log(`[prover] AFTER: a driver still gets the save's role refusal (${driver.slice(0, 60)})`);
  const replay = as('ADMIN', save(CUST3, [line(P.UNPRICED)], REPLAY_KEY));
  assert.equal(replay, 'true', `AFTER: the replay of the pre-change save was refused: ${replay}`);
  const otherPayload = as('ADMIN', save(CUST3, [line(P.UNPRICED, { qty: 20 })], REPLAY_KEY));
  assert.match(otherPayload, /^ERR:/, `AFTER: a different payload under the spent key was accepted: ${otherPayload}`);
  console.log(`[prover] AFTER: the pre-change save's replay is answered (true); a different payload under its key is still refused (${otherPayload.slice(0, 60)})`);

  // 5. RE-APPLY.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /JOB_CHEMICAL_PRICE_REQUIRED_EXISTS/, `re-apply refused for the wrong reason:\n${again.output}`);
  console.log('[prover] RE-APPLY: refused by the preflight');

  // 6. MUTATION: each part of the check is load-bearing.
  const fn = candidateFunction();
  for (const [label, edit, user, sql, expect] of [
    ['no tier-1 fallback', (b) => b.replace(/,\n\s+p\.tier1_price\)/, ')'), 'ADMIN', save(CUST3, [line(P.T1_ONLY)]), 'refuse'],
    ['tier 2 reads the tier-3 price', (b) => b.replace('WHEN 2 THEN p.tier2_price', 'WHEN 2 THEN p.tier3_price'), 'ADMIN', save(CUST2, [line(P.TIER2_ONLY)]), 'refuse'],
    ['check removed', (b) => b.replace('IF FOUND AND v_stated IS NULL THEN', 'IF false THEN'), 'ADMIN', save(CUST3, [line(P.UNPRICED)]), 'save'],
    ['customer-supplied exemption removed', (b) => b.replace('IF COALESCE(NEW.customer_supplied, false)\n     OR ', 'IF '), 'ADMIN', save(CUST3, [line(P.UNPRICED, { supplied: true })]), 'refuse'],
    ['quantity-0 exemption removed', (b) => b.replace('OR COALESCE(NEW.quantity, 0) = 0\n     ', ''), 'ADMIN', save(CUST3, [{ ...line(P.UNPRICED, { qty: 0 }), rate_per_acre: null }]), 'refuse'],
  ]) {
    const mutated = edit(fn);
    assert.notEqual(mutated, fn, `MUTATION ${label}: the edit did not apply`);
    const got = as(user, sql, { prefix: mutated });
    if (expect === 'save') assert.equal(got, 'true', `MUTATION ${label}: expected the gap to reopen, got ${got}`);
    else assert.match(got, /CHEM_PRICE_REQUIRED/, `MUTATION ${label}: expected a wrong refusal, got ${got}`);
    console.log(`[prover] MUTATION: ${label}: ${got.slice(0, 80)}`);
  }

  console.log('JOB_CHEMICALS_PRICE_REQUIRED_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
