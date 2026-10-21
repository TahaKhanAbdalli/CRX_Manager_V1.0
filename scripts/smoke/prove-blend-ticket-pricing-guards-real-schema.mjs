#!/usr/bin/env node
/**
 * Full-chain proof for the 20261020210000 candidate (Goal 3 "Pricing"): an order made from a blend
 * ticket never prices a product at $0 because a tier price is missing, a blend-ticket invoice never
 * bills an unpriced product at $0, and a quote that lists a product twice at different prices stops
 * the blend invoice until staff pick the price.
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers), then:
 *   0. FIDELITY: the two bodies the candidate replaces, and the order wrapper, replayed with their
 *      live md5s of 2026-10-20 (read from the candidate's own preflight);
 *   1. BEFORE: the new chain fails first at its step 1 (an order line priced at $0), and the
 *      covering chains pass;
 *   2. AUTOCOMMIT: run statement by statement the file stops at its preflight;
 *      PREFLIGHT: a drifted create_invoice_from_blend_ticket aborts the candidate before any change;
 *   3. the candidate applies and prints POSTFLIGHT_OK;
 *   4. AFTER: the new chain and the covering chains pass and roll back;
 *   5. RE-APPLY: refused by the preflight;
 *   6. MUTATION: with each hunk removed or weakened in turn the new chain fails at that step.
 *
 * Run: node scripts/smoke/prove-blend-ticket-pricing-guards-real-schema.mjs   (needs Docker)
 * Prints BLEND_TICKET_PRICING_GUARDS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-blend-pricing-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261020210000_blend_ticket_pricing_guards.sql');
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
const PRICING_CHAIN = path.join(SMOKE, 'smoke-blend-ticket-pricing-guards.sql');
// The other chains that bill or convert blend tickets in this disposable database. (The registered
// fractional-cents chain needs real catalog products, and the gauntlet chain needs live customers,
// so neither can run here; see prove-orders-blend-tickets-rep-own-name-real-schema.mjs.)
const COVERING_CHAINS = ['smoke-orders-blend-tickets-rep-own-name.sql'];

const id = (n) => `7a510000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), REP: id('b1'), REP_B: id('b2') };

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
  assert.equal(at, all.length - 1, 'the candidate must be the last migration in the replay plan');
  const before = all.slice(0, at);
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!/create_invoice_from_blend_ticket|create_order_from_blend_ticket|blend_ticket_products|quote_items|tier1_price/i.test(lf(file)),`${name} now touches what this proof covers; replay it or re-think the skip`);
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

// FIDELITY: every md5 the candidate's preflight pins, read from the candidate file itself. The
// pins were read from live (read-only pg_proc queries, 2026-10-20); this checks the replay matches.
function fidelity() {
  const sql = lf(CANDIDATE).split('$preflight$')[1];
  const contract = [...sql.matchAll(/md5\(replace\(p\.prosrc, chr\(13\), ''\)\) = '([0-9a-f]{32})'/g)].map((m) => m[1]);
  assert.equal(contract.length, 2, 'the preflight pins both replaced bodies by contract');
  const all = [
    ['public.create_invoice_from_blend_ticket(uuid,uuid,text)', contract[0]],
    ['public._create_order_from_blend_ticket_replay_impl_20261015(uuid,text,date,text,uuid,text)', contract[1]],
    ...[...sql.matchAll(/\('(public\.[^']+\))', '([0-9a-f]{32})'\)/g)].map((m) => [m[1], m[2]]),
  ];
  assert.equal(all.length, 10, 'the preflight pins ten bodies');
  for (const [sig, pin] of all) {
    assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${sig}');`), pin, `${sig} replayed with a body that differs from the live pin`);
  }
  console.log(`[prover] FIDELITY: all ${all.length} pinned bodies match the live pins of 2026-10-20`);
}

function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.REP, 'sales_rep', 'Rep', 8], [U.REP_B, 'sales_rep', 'Rep B', 7]];
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'blend-pricing-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7a510000-%';`),
    'admin:true,sales_rep:true,sales_rep:true', 'the seeded roles are not what the proof needs');
}

/** Run a chain file; `prefix` runs first in the same transaction (a mutation). */
function chain(file, prefix = '') {
  stageText('chain.sql', lf(file));
  const r = docker([...psqlArgs()], { input: `BEGIN;\n${prefix}\n\\i /tmp/chain.sql\nROLLBACK;\n`, allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const pass = /SMOKE_PASS_ROLLBACK/.test(out);
  const fail = /SMOKE_FAIL[^\n]*/.exec(out)?.[0] ?? (pass ? '' : (/ERROR:[^\n]*/.exec(out)?.[0] ?? out.trim().slice(-400)));
  return { pass, fail };
}
function runCovering(phase) {
  for (const name of COVERING_CHAINS) {
    const r = chain(path.join(SMOKE, name));
    assert.ok(r.pass, `${phase}: ${name} did not pass: ${r.fail}`);
  }
  console.log(`[prover] ${phase}: all ${COVERING_CHAINS.length} covering chains pass and roll back`);
}

const ORDER = '_create_order_from_blend_ticket_replay_impl_20261015';
const INVOICE = 'create_invoice_from_blend_ticket';
const SETTER = 'set_blend_ticket_product_quote_price';
const GUARD_FN = '_guard_blend_ticket_price_pick_20261020';
function candidateBody(fn) {
  const sql = lf(CANDIDATE);
  const start = sql.search(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`));
  assert.ok(start >= 0, `${fn} is not in the candidate`);
  const a = sql.indexOf('AS $function$', start) + 'AS $function$'.length;
  const header = sql.slice(start, a).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
  return { header, body: sql.slice(a, sql.indexOf('$function$;', a)) };
}
function mutate(fn, edits, label) {
  const { header, body } = candidateBody(fn);
  let out = body;
  for (const [find, replacement] of edits) {
    assert.equal(out.split(find).length - 1, 1, `mutation "${label}": hunk not found exactly once: ${find.slice(0, 80)}`);
    out = out.replace(find, () => replacement);
  }
  return `${header}${out}$function$;`;
}
function between(fn, startText, endText) {
  const { body } = candidateBody(fn);
  const a = body.indexOf(startText);
  const b = body.indexOf(endText, a);
  assert.ok(a >= 0 && b > a, `${fn}: could not cut from "${startText}" to "${endText}"`);
  return body.slice(a, b);
}

function main() {
  buildContainer();
  fidelity();
  seed();

  // 1. BEFORE.
  const before = chain(PRICING_CHAIN);
  assert.ok(!before.pass, 'BEFORE: the pricing chain passed before the candidate existed');
  // Before the candidate the order body prices the line at $0, which the below-cost line guard
  // refuses: the order cannot be made at all instead of using the tier-1 price.
  assert.match(before.fail, /SMOKE_FAIL: the tier-1 fallback order was refused: BELOW_COST_CONTEXT_REQUIRED:.*"unit_price_cents": 0/, `BEFORE: wrong first failure: ${before.fail}`);
  console.log(`[prover] BEFORE: the pricing chain fails first at step 1: ${before.fail}`);
  runCovering('BEFORE');

  // 2. AUTOCOMMIT and PREFLIGHT.
  stageText('candidate.sql', lf(CANDIDATE));
  const auto = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(auto.status, 0, 'AUTOCOMMIT: the candidate ran outside one transaction');
  assert.match(auto.stderr, /BLEND_TICKET_PRICING_NOT_IN_TRANSACTION/, `AUTOCOMMIT: wrong refusal:\n${auto.stderr}`);
  const drift = docker([...psqlArgs()], {
    input: `BEGIN;
CREATE OR REPLACE FUNCTION public.create_invoice_from_blend_ticket(p_blend_ticket_id uuid, p_created_by uuid, p_idempotency_key text DEFAULT NULL)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN NULL; END; $$;
\\i /tmp/candidate.sql
ROLLBACK;`,
    allowFailure: true,
  });
  assert.notEqual(drift.status, 0, 'PREFLIGHT: the candidate applied over a drifted body');
  assert.match(drift.stderr, /PREFLIGHT_BLEND_TICKET_INVOICE_DRIFT/, `PREFLIGHT: wrong refusal:\n${drift.stderr}`);
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname IN ('${SETTER}', '_blend_tier_price_cents_20261020');`), '0', 'a refused apply left a change behind');
  console.log('[prover] AUTOCOMMIT + PREFLIGHT: outside one transaction, or over a drifted body, the candidate stops before any change');

  // 3. APPLY.
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.match(a.output, /POSTFLIGHT_OK/, `the postflight did not report OK:\n${a.output}`);
  assert.equal(scalar(`SELECT has_function_privilege('anon', 'public.${SETTER}(uuid,uuid,uuid,text)', 'EXECUTE')::text || ',' || has_function_privilege('authenticated', 'public._blend_tier_price_cents_20261020(integer,numeric,numeric,numeric)', 'EXECUTE')::text;`),
    'false,false', 'anon can run the setter, or authenticated can run the private helper');
  assert.equal(scalar(`SELECT has_function_privilege('anon', 'public.${INVOICE}(uuid,uuid,text,text)', 'EXECUTE')::text || ',' || has_function_privilege('authenticated', 'public.${INVOICE}(uuid,uuid,text,text)', 'EXECUTE')::text || ',' || (to_regprocedure('public.${INVOICE}(uuid,uuid,text)') IS NULL)::text;`),
    'false,true,true', 'the re-created invoice function has the wrong grants, or the old one survived');
  console.log('[prover] candidate applied; POSTFLIGHT_OK; anon cannot run the setter and only postgres runs the helper');

  // 4. AFTER.
  const after = chain(PRICING_CHAIN);
  assert.ok(after.pass, `AFTER: the pricing chain failed: ${after.fail}`);
  console.log('[prover] AFTER: the pricing chain passes and rolls back');
  runCovering('AFTER');

  // 5. RE-APPLY.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /PREFLIGHT_BLEND_TICKET_INVOICE_DRIFT/, `second apply refused for the wrong reason:\n${again.output}`);
  console.log('[prover] RE-APPLY: refused by the preflight, nothing changed');

  // 6. MUTATION: each hunk is what its chain step proves.
  const ORDER_PRECHECK = between(ORDER, '  -- Goal 3 pricing (20261020210000): an order line is never priced', '  -- CHANGED: Removed total_paid');
  const ORDER_LINE = between(ORDER, '        -- Goal 3 pricing: the tier price, else the tier-1 price', '        v_cost := COALESCE(v_db_product.current_cost, 0);');
  const INVOICE_CHOICE = between(INVOICE, '  -- (1) The job\'s quote lists a product more than once', '  -- (2) A product billed at its tier price');
  const INVOICE_PRECHECK = between(INVOICE, '  -- (2) A product billed at its tier price', '  -- (3) A product the job');
  const INVOICE_ZERO_PRECHECK = between(INVOICE, '  -- (3) A product the job', '  IF v_customer_count > 1 THEN');
  const ZERO_ADMIN_TEST = between(INVOICE, '      IF NOT public.is_admin() THEN\n        -- Cost is admin-only', '      IF NULLIF(btrim(COALESCE(p_below_cost_reason');
  const INVOICE_LINE = between(INVOICE, '            -- Goal 3 pricing: the tier price, else the tier-1 price', '          ELSE\n            v_unit_price := 0;');
  const PICK_VALID_CALL = '        IF public._blend_quote_pick_valid_20261020(\n             v_quote_section_id, v_ticket.customer_id, v_btp.product_id, v_btp.unit_price_cents) THEN\n';
  const OLD_ORDER_LINE = '        v_price := CASE v_tier\n          WHEN 1 THEN COALESCE(v_db_product.tier1_price, 0)\n          WHEN 2 THEN COALESCE(v_db_product.tier2_price, 0)\n          WHEN 3 THEN COALESCE(v_db_product.tier3_price, 0)\n          ELSE COALESCE(v_db_product.tier1_price, 0)\n        END;\n';
  const OLD_INVOICE_LINE = '            v_unit_price := CASE v_customer_tier\n              WHEN 1 THEN COALESCE(ROUND(v_btp.tier1_price * 100), 0)\n              WHEN 2 THEN COALESCE(ROUND(v_btp.tier2_price * 100), ROUND(v_btp.tier1_price * 100), 0)\n              WHEN 3 THEN COALESCE(ROUND(v_btp.tier3_price * 100), ROUND(v_btp.tier1_price * 100), 0)\n              ELSE COALESCE(ROUND(v_btp.tier1_price * 100), 0)\n            END;\n';
  const mutations = [
    ['order tier-1 fallback (old line pricing, no pre-check)', ORDER, [[ORDER_PRECHECK, ''], [ORDER_LINE, OLD_ORDER_LINE]],
      /SMOKE_FAIL: the tier-1 fallback order was refused: BELOW_COST_CONTEXT_REQUIRED:.*"unit_price_cents": 0/],
    // Without the refusal the unpriced line is priced $0 and some later guard (or nothing) stops
    // it with the wrong reason; the chain demands the named BLEND_TICKET_PRICE_MISSING refusal.
    ['order refusal (no pre-check, line refusal kept to the tier rule only)', ORDER,
      [[ORDER_PRECHECK, ''], ["        IF v_price IS NULL THEN\n          RAISE EXCEPTION 'BLEND_TICKET_PRICE_MISSING: product(s) have no price on the price list: %', v_product.product_name;\n        END IF;\n", "        v_price := COALESCE(v_price, 0);\n"]],
      /SMOKE_FAIL: (an order was made from a blend ticket with an unpriced product|wrong unpriced-order refusal)/],
    ['invoice missing-price refusal (old line pricing, no pre-check)', INVOICE, [[INVOICE_PRECHECK, ''], [INVOICE_LINE, OLD_INVOICE_LINE]],
      /SMOKE_FAIL: (a blend-ticket invoice billed an unpriced product|wrong unpriced-invoice refusal)/],
    ['invoice duplicate-quote-line choice', INVOICE, [[INVOICE_CHOICE, '']],
      /SMOKE_FAIL: a blend-ticket invoice picked one of two quoted prices without asking/],
    // Billing honours any stored value again, as before: the stale pick bills the old price.
    ['invoice valid-pick test', INVOICE, [[PICK_VALID_CALL, '        IF v_btp.unit_price_cents IS NOT NULL THEN\n']],
      /SMOKE_FAIL: a stale pick billed 700 \(quoted\) after the job changed/],
    // The quote lookup skips $0 lines again (the rule before Mason's 2026-10-20 answer): the $0
    // quoted line bills its tier price instead of $0.
    ['invoice $0 quote price counts', INVOICE,
      [["             AND qi.product_id = v_btp.product_id\n             AND qi.price_per_unit >= 0 AND qi.price_per_unit < 'Infinity'::numeric AND qi.price_per_unit = ROUND(qi.price_per_unit, 2)\n           ORDER BY qi.id LIMIT 1;\n",
        "             AND qi.product_id = v_btp.product_id\n             AND qi.price_per_unit > 0 AND qi.price_per_unit < 'Infinity'::numeric AND qi.price_per_unit = ROUND(qi.price_per_unit, 2)\n           ORDER BY qi.id LIMIT 1;\n"]],
      /SMOKE_FAIL: the \$0 quoted lines did not bill at \$0 as quoted/],
    // Without the up-front check the line trigger still refuses, but only after an invoice number
    // and rows exist, and the screen is handed the invoice line instead of the ticket line.
    ['invoice $0 approval pre-check', INVOICE, [[INVOICE_ZERO_PRECHECK, '']],
      /SMOKE_FAIL: the \$0 approval request handed to the screen is wrong/],
    ['invoice $0 pre-check admin test', INVOICE, [[ZERO_ADMIN_TEST, '']],
      /SMOKE_FAIL: (wrong rep \$0 refusal|a sales rep billed a \$0 quoted line)/],
    // Without the below-cost context the $0 line is refused even with an admin's reason.
    ['invoice $0 line below-cost context', INVOICE,
      [["          PERFORM set_config('app.crx_below_cost_operation', 'create_invoice_from_blend_ticket', true);\n", '']],
      /BELOW_COST_CONTEXT_REQUIRED/],
    ['invoice $0 line context reset', INVOICE,
      [["        IF v_zero_quoted THEN\n          PERFORM set_config('app.crx_below_cost_operation', '', true);\n          PERFORM set_config('app.crx_below_cost_reason', '', true);\n        END IF;\n", '']],
      /SMOKE_FAIL: the below-cost context was left set after the invoice/],
    // The approval window lists only the first $0 line again.
    ['invoice lists every $0 line', INVOICE,
      [["        'zero_lines', (SELECT jsonb_agg(e.value - 'cost_cents' ORDER BY e.ord)\n                         FROM jsonb_array_elements(v_zero_lines) WITH ORDINALITY AS e(value, ord)));\n",
        "        'zero_lines', jsonb_build_array((v_zero_lines -> 0) - 'cost_cents'));\n"]],
      /SMOKE_FAIL: the approval request does not list every \$0 line/],
    // The listed lines would carry the admin-only cost to a sales rep.
    ['invoice $0 list hides the cost', INVOICE,
      [["        'zero_lines', (SELECT jsonb_agg(e.value - 'cost_cents' ORDER BY e.ord)\n", "        'zero_lines', (SELECT jsonb_agg(e.value ORDER BY e.ord)\n"]],
      /SMOKE_FAIL: (wrong rep \$0 refusal|the approval request does not list every \$0 line)/],
    ['invoice job-own-quote test', INVOICE,
      [['          AND q.id = (SELECT j.quote_id FROM jobs j WHERE j.id = v_ticket.job_id)) THEN\n', ') THEN\n']],
      /SMOKE_FAIL: a section of another quote priced the invoice line at 550 \(quoted\)/],
    ['setter job-own-quote test', SETTER,
      [['     WHERE j.id = v_ticket.job_id\n       AND qs.quote_id = j.quote_id;\n', '     WHERE j.id = v_ticket.job_id;\n']],
      /SMOKE_FAIL: a price from a quote other than the job's own quote was accepted as the pick/],
    ['setter accepts a $0 quote price', SETTER,
      [['     OR NOT (v_quote_item.price_per_unit >= 0\n', '     OR NOT (v_quote_item.price_per_unit > 0\n']],
      /BLEND_TICKET_QUOTE_PRICE_INVALID_CHOICE/],
    // The setter tests the product twice (its own line and the shared valid-pick rule); remove both.
    // The automatic lookup trusts any section the job names again: the other customer's quote
    // either asks for a pick (two prices) or bills its price.
    ['invoice quote-customer test', INVOICE,
      [["  IF v_quote_section_id IS NOT NULL AND NOT EXISTS (\n       SELECT 1 FROM quote_sections qs JOIN quotes q ON q.id = qs.quote_id\n", "  IF false AND NOT EXISTS (\n       SELECT 1 FROM quote_sections qs JOIN quotes q ON q.id = qs.quote_id\n"]],
      /SMOKE_FAIL: (a ticket whose job names another customer's quote was refused|another customer's quote priced this customer's invoice line)/],
    ['setter same-product test', SETTER, [['     OR v_quote_item.product_id IS DISTINCT FROM v_line.product_id\n', ''],
      ['     OR NOT public._blend_quote_pick_valid_20261020(\n              v_section, v_ticket.customer_id, v_line.product_id, (v_quote_item.price_per_unit * 100)::bigint) THEN\n', ' THEN\n']],
      /SMOKE_FAIL: a quote line for another product was accepted as the pick/],
    ['setter same-customer test', SETTER,
      [['     OR NOT public._blend_quote_pick_valid_20261020(\n              v_section, v_ticket.customer_id, v_line.product_id, (v_quote_item.price_per_unit * 100)::bigint) THEN\n', ' THEN\n']],
      /SMOKE_FAIL: a price from another customer's quote was accepted as the pick/],
    ['pick cleared on a product change', GUARD_FN,
      [["  IF TG_OP = 'UPDATE'\n     AND (NEW.product_id IS DISTINCT FROM OLD.product_id\n", "  IF false\n     AND (NEW.product_id IS DISTINCT FROM OLD.product_id\n"]],
      /SMOKE_FAIL: changing a line's product kept its old pick/],
    ['price-pick column guard owner test', GUARD_FN, [["     AND current_user = 'postgres' THEN\n", ' THEN\n']],
      /SMOKE_FAIL: a ticket line price was written directly through the Data API/],
    ['price-pick column guard', GUARD_FN, [["  IF COALESCE(current_setting('app.crx_blend_quote_price_pick', true), '') = '1'\n     AND current_user = 'postgres' THEN\n", '  IF true THEN\n']],
      /SMOKE_FAIL: a ticket line price was written directly, skipping the pick checks/],
    ['setter own-name test', SETTER, [["  IF NOT public.is_admin()\n     AND v_ticket.salesman_id IS NOT NULL\n     AND v_ticket.salesman_id IS DISTINCT FROM v_actor THEN\n    RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';\n  END IF;\n", '']],
      /SMOKE_FAIL: a sales rep picked a price on another rep's ticket/],
    ['setter billed-ticket lock', SETTER, [["  IF v_ticket.payment_status IS DISTINCT FROM 'unbilled' OR v_ticket.order_link_status = 'linked' THEN", "  IF false THEN"]],
      /SMOKE_FAIL: wrong billed-ticket refusal|SMOKE_FAIL: a price was picked on a billed ticket/],
    ['setter replay binding', SETTER, [["  v_replay := public.check_idempotency_intent(\n    p_idempotency_key, 'set_blend_ticket_product_quote_price', v_actor, v_fingerprint);\n",
      "  v_replay := (SELECT jsonb_build_object('found', true, 'result', public.check_idempotency(p_idempotency_key, 'set_blend_ticket_product_quote_price')) WHERE public.check_idempotency(p_idempotency_key, 'set_blend_ticket_product_quote_price') IS NOT NULL);\n"]],
      /SMOKE_FAIL: a reused pick key stored a different price|SMOKE_FAIL: wrong reused-key refusal/],
  ];
  for (const [label, fn, edits, expected] of mutations) {
    const r = chain(PRICING_CHAIN, mutate(fn, edits, label));
    assert.ok(!r.pass, `MUTATION ${label}: the chain still passed without the hunk`);
    assert.match(r.fail, expected, `MUTATION ${label}: wrong failure: ${r.fail}`);
    console.log(`[prover] MUTATION: without the ${label} hunk the chain fails: ${r.fail}`);
  }

  console.log('BLEND_TICKET_PRICING_GUARDS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
