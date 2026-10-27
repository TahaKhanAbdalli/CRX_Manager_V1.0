#!/usr/bin/env node
/**
 * Real-schema proof for the quote pricing work (pricing plan slices 1, 2 and 5; To-Do 1.2, 1.3, 0.5).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate
 * 20261027040000_quote_sent_price_lock (the same skips as the other real-schema provers), seeds an
 * admin, two sales reps, a driver, a product with a cost and a sent quote, then runs each rolled-back
 * chain as ONE statement (a chain passes only when it ends in its own SMOKE_PASS_ROLLBACK error):
 *   - smoke-convert-sent-quote-in-one-step.sql: Convert straight from a sent quote creates exactly
 *     one order at the sent price and marks the quote accepted in the same call (KI-12); an accepted
 *     save keeps the sent price (the lock); a cost rise above the sent price needs an admin's reason
 *     and is recorded as a below-cost approval.
 *   - smoke-quote-sent-price-lock.sql: the lock itself (To-Do 1.2), every case in its header.
 * Steps:
 *   1. BEFORE: both chains fail at their first lock step (the accepted save re-prices; V1 records no
 *      line id), and every regression chain below ends with its listed outcome.
 *   2. AUTOCOMMIT: run statement by statement (psql -f, no -1) the candidate stops at its preflight.
 *   3. MUTATIONS: the candidate with one safeguard removed (and its postflight dropped so the chain,
 *      not the postflight, has to notice) is applied inside a transaction that never commits; the
 *      lock chain fails at that safeguard's own step.
 *   4. The candidate applies and prints POSTFLIGHT_OK; a second apply is refused by its preflight.
 *   5. AFTER: both chains pass, and every regression chain ends with that same listed outcome.
 *
 * Run: node scripts/smoke/prove-quote-pricing-real-schema.mjs   (needs Docker)
 * Prints QUOTE_PRICING_PROOF_PASS on success. CRX_PROVER_KEEP_CONTAINER=1 keeps the container.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-quote-pricing-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const SMOKE = path.join(ROOT, 'scripts', 'smoke');
const CANDIDATE = path.join(MIGRATIONS, '20261027040000_quote_sent_price_lock.sql');
const CHAINS = {
  'smoke-convert-sent-quote-in-one-step.sql': 'SMOKE_FAIL: (5) an accepted save re-priced the sent quote',
  'smoke-quote-sent-price-lock.sql': 'SMOKE_FAIL: (V1) snapshot lacks the line id',
};
// Existing chains over the functions the candidate re-emits, each with the outcome (as outcome()
// masks it) it must have both BEFORE and AFTER the candidate, so a chain that stops running cannot
// hide behind an unchanged failure.
const REGRESSION = {
  'smoke-save-quote-repeated-product-line-ids.sql': 'PASS',
  'smoke-quote-version-restore-trust.sql': 'PASS',
  'smoke-quote-version-write-boundary.sql': 'PASS',
  'smoke-draw-down-quote-intent-binding.sql': 'PASS',
  'smoke-save-quote-drawn-guard.sql': 'PASS',
  'smoke-job_from_quote_activity_feed_fix.sql': 'PASS',
  'smoke-save-quote-customer-row-version.sql': 'PASS',
  // Its fixture product has no cost, so the later cost-basis rule refuses its re-convert before
  // and after the candidate alike (a fixture gap older than this work).
  'smoke-revert-quote-escape-hatch.sql': 'ERROR:  COST_BASIS_REQUIRED:<uuid>',
  'smoke-quotes-rep-own-name.sql': 'PASS',
};
// Each safeguard removed in turn, and the lock chain step that must notice.
const MUTATIONS = [
  ['convert gate', `  ) THEN
    PERFORM public._assert_quote_prices_as_sent(p_quote_id);
  END IF;

  v_result := public._convert_quote_to_order_owner_impl(`, `  ) THEN
    NULL;
  END IF;

  v_result := public._convert_quote_to_order_owner_impl(`,
    'SMOKE_FAIL: (B) Convert of an un-re-sent price change was ALLOWED'],
  ['convert skip only for a returned order', `  IF NOT (
    EXISTS (SELECT 1 FROM public.quote_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0)
    OR EXISTS (SELECT 1 FROM public.job_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0)
    OR ((SELECT q.status FROM public.quotes q WHERE q.id = p_quote_id) = 'accepted'
        AND EXISTS (SELECT 1 FROM public.orders WHERE quote_id = p_quote_id))
  ) THEN`, '  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE quote_id = p_quote_id) THEN',
    'SMOKE_FAIL: (O) a reopened quote converted an un-re-sent price'],
  ['price carry only for a named line', '         AND v_reuse_item_id::text = v_payload_item_id\n', '',
    "SMOKE_FAIL: (N) an id-less line did not take today's price"],
  ['rewind restores the customer', `    customer_id = COALESCE(
      (SELECT c.id FROM customers c WHERE c.id = NULLIF(v_snapshot->'quote'->>'customer_id', '')::uuid),
      customer_id),
`, '', 'SMOKE_FAIL: (E) rewind did not restore the sent customer'],
  ['draw gate', `  PERFORM public._assert_quote_prices_as_sent(p_quote_id);

  PERFORM public._begin_below_cost_money_write(`, '  PERFORM public._begin_below_cost_money_write(',
    'SMOKE_FAIL: (B) Partial Order of an un-re-sent price change was ALLOWED'],
  ['accepted-save gate', `  IF v_status = 'accepted' AND v_old_status IS DISTINCT FROM 'accepted' THEN
    PERFORM public._assert_quote_prices_as_sent(v_quote_id);
  END IF;
`, '', 'SMOKE_FAIL: (B) accepting an un-re-sent price change was ALLOWED'],
  ['job gate', `  -- planned draft that was never sent may still be scheduled at its own prices (Mason, 2026-10-14).
  PERFORM public._assert_quote_prices_as_sent(p_quote_id);`, '  -- planned draft that was never sent may still be scheduled at its own prices (Mason, 2026-10-14).',
    'SMOKE_FAIL: (G) scheduling a job from an un-re-sent price change was ALLOWED'],
  ['price carry', '(v_carry_prices->>(qi.id::text))::numeric, ', '', 'SMOKE_FAIL: (A) save reply did not report the stored price: {"_k1": 8.75}'],
  ['expiry kept on edit', 'expires_at = CASE WHEN v_price_locked THEN expires_at\n      ELSE', 'expires_at = CASE WHEN false THEN expires_at\n      ELSE',
    'SMOKE_FAIL: (A) revision re-priced to 7.50 or moved the expiry'],
  ['snapshot line id', "                'quote_item_id', qi.id,\n", '', 'SMOKE_FAIL: (V1) snapshot lacks the line id'],
  ['restore keeps the line id', "          THEN (v_item->>'quote_item_id')::uuid\n", "          THEN gen_random_uuid()\n",
    'SMOKE_FAIL: (C) rewind did not restore the sent line'],
  ['customer check', "  IF (v_snapshot->'quote'->>'customer_id') IS DISTINCT FROM v_customer_id::text THEN", '  IF false THEN',
    'SMOKE_FAIL: (E) Convert after a customer change was ALLOWED'],
  ['id-less pairing', `       OR EXISTS (SELECT 1 FROM quote_items WHERE quote_id = p_quote_id GROUP BY product_id HAVING count(*) > 1)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_sent_items) AS i(item)
                  GROUP BY i.item->>'product_id' HAVING count(*) > 1) THEN`, ' THEN',
    'SMOKE_FAIL: (I) an id-less version with a repeated product converted'],
  ['untrusted version', '  IF v_trusted_at IS NULL THEN', '  IF false THEN', 'SMOKE_FAIL: (J) an untrusted version converted'],
];
const USERS = {
  ADMIN: '7c500000-0000-4000-8000-0000000000a1',
  REP: '7c500000-0000-4000-8000-0000000000b1',
  OTHER_REP: '7c500000-0000-4000-8000-0000000000b2',
  DRIVER: '7c500000-0000-4000-8000-0000000000d1',
};
// Live but not replayable here (storage.objects policies, storage.buckets settings); none touches quotes.
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
const QUOTE_TOUCH = /\b(quote|quotes|quote_items|quote_versions)\b/i;
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
  for (const name of PARKED) {
    const file = all.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!QUOTE_TOUCH.test(lf(file)), `${name} now touches quotes; replay it or re-think the skip`);
  }
  const at = all.indexOf(CANDIDATE);
  assert.ok(at >= 0, 'the candidate must be selected for post-baseline replay');
  // A later file that re-emits one of the candidate's functions would undo it.
  for (const file of all.slice(at + 1)) {
    assert.ok(!/_save_quote_below_cost_impl_20260810|_create_quote_version_owner_impl|_restore_quote_version_owner_impl|_convert_quote_to_order_below_cost_impl_20260810|_draw_down_quote_intent_impl_20260819|create_job_from_quote_section/.test(lf(file)),
      `${path.basename(file)} sorts after the candidate and touches a function it re-emits; re-think this proof`);
  }
  return all.slice(0, at);
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
  let replayed = 0;
  for (const [i, file] of plan().entries()) {
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
  console.log(`[prover] replayed ${replayed} post-baseline migrations (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}
function seed() {
  // handle_new_user takes the role and name from the metadata only for a direct postgres session.
  const users = [[USERS.ADMIN, 'admin', 'Admin', 9], [USERS.REP, 'sales_rep', 'Rep', 8],
    [USERS.OTHER_REP, 'sales_rep', 'Other Rep', 7], [USERS.DRIVER, 'driver', 'Driver', 6]];
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    ${users.map(([u, role, label]) => `('${u}', 'quote-pricing-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] Quote Pricing ${label}","role":"${role}"}'::jsonb)`).join(',\n    ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}`);
  assert.equal(scalar(`SELECT string_agg(role || ',' || is_active, ';' ORDER BY created_at) FROM public.profiles;`),
    'admin,true;sales_rep,true;sales_rep,true;driver,true', 'the seeded profiles are not the expected active users');
  // A product with a cost and a sent quote of it, for the chains that look for existing data.
  psql(`BEGIN;
    SELECT set_config('request.jwt.claims', json_build_object('sub', '${USERS.ADMIN}', 'role', 'authenticated')::text, true);
    SELECT set_config('request.jwt.claim.sub', '${USERS.ADMIN}', true);
    INSERT INTO public.customers (farm_name, is_active) VALUES ('[PROVER] Quote Pricing Farm', true);
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (product_name, unit_size, current_cost, tier1_price, tier1_margin, product_form, is_active)
      VALUES ('[PROVER] Quote Pricing Chem', 'gal', 5.00, 6.25, 20, 'liquid', true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    DO $seed$
    DECLARE v_res jsonb;
    BEGIN
      v_res := public.save_quote(NULL, jsonb_build_object(
          'quote_number', 'PROVER-QP-1', 'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb,
          'customer_id', (SELECT id FROM public.customers WHERE farm_name = '[PROVER] Quote Pricing Farm')),
        jsonb_build_array(jsonb_build_object('section_name', 'S1', 'sort_order', 0, 'items', jsonb_build_array(
          jsonb_build_object('product_id', (SELECT id FROM public.products WHERE product_name = '[PROVER] Quote Pricing Chem'),
            'sort_order', 0, 'calc_mode', 'units_direct', 'total_units_needed', 2, 'unit_size', 'gal')))),
        '${USERS.ADMIN}', 'prover-qp-seed-save');
      PERFORM public.create_quote_version((v_res->>'quote_id')::uuid, '${USERS.ADMIN}', 'presented',
        'prover-qp-seed-present', (v_res->>'row_version')::bigint);
    END
    $seed$;
    COMMIT;`);
  assert.equal(scalar("SELECT status FROM public.quotes WHERE quote_number = 'PROVER-QP-1';"), 'sent', 'the seeded quote is not sent');
}

// One rolled-back chain, optionally after the (possibly mutated) candidate inside the same
// never-committed transaction. Returns the first error line psql printed.
function runChain(file, prefix = '') {
  const name = `chain-${path.basename(file)}`;
  stageText(name, `${prefix}${lf(path.join(SMOKE, file))}`);
  const r = docker([...psqlArgs(), '-f', `/tmp/${name}`], { allowFailure: true });
  const output = `${r.stdout}\n${r.stderr}`;
  return output.split(/\r?\n/).find((line) => /ERROR:/.test(line)) ?? `NO ERROR (exit ${r.status}):\n${output.trim()}`;
}
// Comparable outcome of a regression chain: PASS, or its error with ids and random suffixes masked.
function outcome(line) {
  if (line.includes('SMOKE_PASS_ROLLBACK')) return 'PASS';
  return line.replace(/^psql:[^:]+:\d+: /, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\b[0-9a-f]{8}\b/g, '<suffix>');
}
function withoutPostflight(text) {
  const at = text.indexOf('DO $postflight$');
  assert.ok(at > 0, 'the candidate has no postflight block');
  return text.slice(0, at);
}

try {
  buildContainer();
  seed();
  const candidate = lf(CANDIDATE);

  // 1. BEFORE: both new chains fail at their first lock step; every regression chain ends as listed.
  for (const [chain, expected] of Object.entries(CHAINS)) {
    const line = runChain(chain);
    assert.ok(line.includes(expected), `BEFORE: ${chain} should fail with "${expected}", got: ${line}`);
    console.log(`[prover] BEFORE ${chain}: fails as expected (${expected})`);
  }
  for (const [chain, expected] of Object.entries(REGRESSION)) {
    const result = outcome(runChain(chain));
    assert.equal(result, expected, `BEFORE: ${chain} should end "${expected}", got "${result}"`);
    console.log(`[prover] BEFORE ${chain}: ${result}`);
  }

  // 2. AUTOCOMMIT: statement by statement, the preflight stops the file before any change.
  stageText('candidate.sql', candidate);
  const auto = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.match(`${auto.stdout}\n${auto.stderr}`, /QUOTE_SENT_PRICE_LOCK_NOT_IN_TRANSACTION/, 'autocommit run was not refused');
  assert.equal(scalar("SELECT count(*) FROM pg_proc WHERE proname = '_assert_quote_prices_as_sent';"), '0', 'autocommit run changed the database');
  console.log('[prover] AUTOCOMMIT: refused at the preflight, nothing changed');

  // 3. MUTATIONS: each safeguard removed, inside a transaction that never commits.
  const mutationBase = withoutPostflight(candidate);
  for (const [label, find, replace, expected] of MUTATIONS) {
    assert.equal(mutationBase.split(find).length - 1, 1, `mutation "${label}": anchor not found exactly once`);
    const mutated = mutationBase.replace(find, () => replace);
    const line = runChain('smoke-quote-sent-price-lock.sql', `BEGIN;\n${mutated}\n`);
    assert.ok(line.includes(expected), `mutation "${label}" was not caught by its step (${expected}); got: ${line}`);
    console.log(`[prover] MUTATION ${label}: caught (${expected})`);
  }
  assert.equal(scalar("SELECT count(*) FROM pg_proc WHERE proname = '_assert_quote_prices_as_sent';"), '0', 'a mutation run committed');

  // 4. The candidate applies; a second apply is refused by its own preflight.
  const applied = apply('candidate.sql');
  assert.equal(applied.status, 0, `the candidate failed to apply:\n${applied.output}`);
  assert.match(applied.output, /POSTFLIGHT_OK quote sent-price lock installed/, 'no POSTFLIGHT_OK');
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'a second apply succeeded');
  assert.match(again.output, /PREFLIGHT_/, `a second apply failed outside the preflight:\n${again.output}`);
  console.log('[prover] APPLY: POSTFLIGHT_OK; re-apply refused by the preflight');

  // 5. AFTER: both chains pass, every regression chain ends as listed, as it did before.
  for (const chain of Object.keys(CHAINS)) {
    const line = runChain(chain);
    assert.ok(line.includes('SMOKE_PASS_ROLLBACK'), `AFTER: ${chain} did not pass: ${line}`);
    console.log(`[prover] AFTER ${chain}: ${line.replace(/^.*ERROR:\s*/, '')}`);
  }
  for (const [chain, expected] of Object.entries(REGRESSION)) {
    const result = outcome(runChain(chain));
    assert.equal(result, expected, `AFTER: ${chain} changed from "${expected}" to "${result}"`);
    console.log(`[prover] AFTER ${chain}: unchanged (${result})`);
  }
  console.log('QUOTE_PRICING_PROOF_PASS');
} finally {
  if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true });
  else console.log(`[prover] kept container ${NAME}`);
}
