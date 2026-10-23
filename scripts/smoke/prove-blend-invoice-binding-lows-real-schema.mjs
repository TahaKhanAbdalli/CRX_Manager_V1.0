#!/usr/bin/env node
/**
 * Full-chain proof for the 20261022020000 candidate (the four LOW leftovers of 20261021070000): a
 * blend-ticket invoice prices and costs each line from the quantity it stores, an approved $0
 * quoted line records the catalog cost the approval showed, the tier-price, quote-pick and cents
 * helpers are pinned by the preflight, and the dead retry-key test is gone without changing the
 * replay.
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers), then:
 *   0. FIDELITY: the body the candidate replaces and the five it depends on replayed with their
 *      live md5s of 2026-10-22 (read from the candidate's own preflight);
 *   1. BEFORE: the chain fails first at its step 1 (the per-unit amount from the unrounded
 *      quantity), and the covering chains pass;
 *   2. AUTOCOMMIT: run statement by statement the file stops at its preflight;
 *      PREFLIGHT: a drifted create_invoice_from_blend_ticket, or a drifted tier-price, quote-pick
 *      or cents helper, aborts the candidate before any change;
 *   3. the candidate applies and prints POSTFLIGHT_OK; grants unchanged;
 *   4. AFTER: the chain and the covering chains pass and roll back; the body has no dead key test;
 *   5. RE-APPLY: refused by the preflight;
 *   6. MUTATION: with each hunk removed in turn the chain fails at that step.
 *
 * Run: node scripts/smoke/prove-blend-invoice-binding-lows-real-schema.mjs   (needs Docker)
 * Prints BLEND_INVOICE_BINDING_LOWS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-blend-lows-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261022020000_blend_invoice_binding_lows.sql');
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
const LOWS_CHAIN = path.join(SMOKE, 'smoke-blend-invoice-binding-lows.sql');
// The other chains that bill or convert blend tickets in this disposable database: the
// 20261021070000 chain (every approval-binding rule) and the own-name chain.
const COVERING_CHAINS = ['smoke-blend-invoice-approval-binding.sql', 'smoke-orders-blend-tickets-rep-own-name.sql'];

const id = (n) => `7a520000-0000-4000-8000-${n.padStart(12, '0')}`;
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
    assert.ok(!/create_invoice_from_blend_ticket|create_order_from_blend_ticket|blend_ticket_products|quote_items|tier1_price/i.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
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
// pins were read from live (read-only pg_proc queries, 2026-10-22); this checks the replay matches.
const PIN_RE = /to_regprocedure\('(public\.[^']+\))'\)\), chr\(13\), ''\)\) IS DISTINCT FROM '([0-9a-f]{32})'/g;
function pins() { return [...lf(CANDIDATE).split('$preflight$')[1].matchAll(PIN_RE)].map((m) => [m[1], m[2]]); }
function fidelity() {
  const all = pins();
  assert.equal(all.length, 6, 'the preflight pins six bodies');
  for (const [sig, pin] of all) {
    assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${sig}');`), pin, `${sig} replayed with a body that differs from the live pin`);
  }
  console.log(`[prover] FIDELITY: all ${all.length} pinned bodies match the live pins of 2026-10-22`);
}

function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.REP, 'sales_rep', 'Rep', 8], [U.REP_B, 'sales_rep', 'Rep B', 7]];
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'blend-lows-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7a520000-%';`),
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

function candidateBody(fn) {
  const sql = lf(CANDIDATE);
  const start = sql.search(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`));
  assert.ok(start >= 0, `${fn} is not in the candidate`);
  const a = sql.indexOf('AS $function$', start) + 'AS $function$'.length;
  const header = sql.slice(start, a);
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
// A one-space change to a function's body (its header and grants unchanged): a drifted copy.
function drift(sig) {
  return `DO $drift$ BEGIN EXECUTE replace(pg_get_functiondef('${sig}'::regprocedure), 'AS $function$', 'AS $function$ '); END $drift$;`;
}

const INVOICE = 'create_invoice_from_blend_ticket';
const INVOICE_SIG = `public.${INVOICE}(uuid,uuid,text,text,jsonb)`;
const PREVIOUS = path.join(MIGRATIONS, '20261021070000_blend_invoice_approval_binding.sql');

// NOTHING ELSE CHANGED: rebuild the expected body from the 20261021070000 body (its live md5 is
// the candidate's own preflight pin) with only the intended edits (the four LOW fixes and the zero-quantity refusal), each matched exactly once,
// and require the candidate body to equal it byte for byte.
function expectedBody() {
  const sql = lf(PREVIOUS);
  const start = sql.indexOf(`CREATE FUNCTION public.${INVOICE}(`);
  const a = sql.indexOf('AS $function$', start) + 'AS $function$'.length;
  let body = sql.slice(a, sql.indexOf('$function$;', a));
  assert.equal(pins()[0][1], createHash('md5').update(body).digest('hex'), 'the 20261021070000 body is not the body the candidate pins');
  const once = (find, replacement) => {
    assert.equal(body.split(find).length - 1, 1, `expected-body edit not found exactly once: ${find.slice(0, 80)}`);
    body = body.replace(find, () => replacement);
  };
  // Change 4: drop each "IF p_idempotency_key IS NOT NULL THEN ... END IF;" wrapper, two spaces
  // less indent inside, one comment line(s) above.
  const unwrap = (from, to, comment) => {
    const i = body.indexOf(from);
    const j = body.indexOf(to, i) + to.length;
    assert.ok(i >= 0 && j > i && body.indexOf(from, i + 1) < 0, `expected-body block not unique: ${from.slice(0, 60)}`);
    const lines = body.slice(i, j).split('\n').slice(1, -2).map((l) => (l === '' ? l : l.replace(/^ {2}/, '')));
    body = body.slice(0, i) + comment + lines.join('\n') + '\n' + body.slice(j);
  };
  unwrap('  IF p_idempotency_key IS NOT NULL THEN\n    v_existing := public.check_idempotency(\n', '      RETURN v_existing;\n    END IF;\n  END IF;\n',
    '  -- 20261022020000: the key is required just above, so the replay lookup always runs (the\n'
    + '  -- "IF p_idempotency_key IS NOT NULL" test that wrapped it could never be false).\n');
  unwrap('  IF p_idempotency_key IS NOT NULL THEN\n    PERFORM public.save_idempotency(\n', '      v_result\n    );\n  END IF;\n',
    '  -- 20261022020000: the key is required, so the receipt is always saved (no dead NULL test).\n');
  // Change 1.
  once('      IF v_chem_qty_a > 0 THEN\n', '      -- 20261022020000: a line stores its quantity rounded to 4 places. Price it, cost it and\n'
    + '      -- add it to the invoice totals from that same stored quantity (as save_invoice does when\n'
    + '      -- a line is saved again), so quantity x price is the line amount and the totals match the\n'
    + '      -- lines. Before, the amount and cost used the unrounded quantity and could differ by cents.\n'
    + '      v_chem_qty_a_conv := ROUND(v_chem_qty_a_conv, 4);\n      v_chem_qty_b_conv := ROUND(v_chem_qty_b_conv, 4);\n'
    + '\n'
    + '      IF v_chem_qty_a > 0 THEN\n');
  // Zero-quantity refusal (Sol and Codex App reviews), ahead of any invoice number.
  once("  v_chem_qty_b_conv     numeric;\n", "  v_chem_qty_b_conv     numeric;\n  v_zero_qty_line       record;\n");
  once("  IF v_customer_count > 1 THEN\n", "  -- 20261022020000: each line stores its quantity rounded to 4 places (below). A positive\n  -- quantity below 0.00005 would store as 0 and bill a 0-quantity, $0 line while the ticket is\n  -- marked billed, so refuse it here, before any invoice number is drawn (a drawn number is never\n  -- given back) and the office corrects the rate or acres. The quantity is worked out as the\n  -- billing loop below does: per customer, rate x share acres, split by grower-share override,\n  -- converted to the pricing unit.\n  SELECT COALESCE(p.product_name, btp.product_name) AS product_name, btp.id\n    INTO v_zero_qty_line\n    FROM blend_ticket_products btp\n    LEFT JOIN products p ON p.id = btp.product_id\n   CROSS JOIN (SELECT DISTINCT (c.value->>'customer_id')::uuid AS customer_id\n                 FROM jsonb_array_elements(v_customers) AS c(value)) cust\n   CROSS JOIN LATERAL (\n     SELECT COALESCE(SUM(COALESCE(btp.rate_per_acre, 0) * (r.value->>'share_acres')::numeric)\n                       FILTER (WHERE (r.value->>'price_override_cents') IS NOT NULL), 0) AS qty_a,\n            COALESCE(SUM(COALESCE(btp.rate_per_acre, 0) * (r.value->>'share_acres')::numeric)\n                       FILTER (WHERE (r.value->>'price_override_cents') IS NULL), 0) AS qty_b\n       FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)\n      WHERE (r.value->>'customer_id')::uuid = cust.customer_id) q\n   CROSS JOIN LATERAL (\n     SELECT normalize_rate_unit(COALESCE(NULLIF(btrim(btp.rate_per_acre_unit), ''), p.rate_unit)) AS rate_unit,\n            normalize_rate_unit(COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size)) AS inv_unit) u\n   WHERE btp.blend_ticket_id = p_blend_ticket_id\n     AND ((q.qty_a > 0 AND ROUND(CASE WHEN btp.product_id IS NOT NULL\n                                THEN field_app_priced_quantity(q.qty_a, u.rate_unit, u.inv_unit, p.product_form)\n                                ELSE q.qty_a END, 4) <= 0)\n       OR (q.qty_b > 0 AND ROUND(CASE WHEN btp.product_id IS NOT NULL\n                                THEN field_app_priced_quantity(q.qty_b, u.rate_unit, u.inv_unit, p.product_form)\n                                ELSE q.qty_b END, 4) <= 0))\n   ORDER BY btp.sequence_order, btp.id\n   LIMIT 1;\n  IF FOUND THEN\n    RAISE EXCEPTION 'BLEND_INVOICE_QUANTITY_ROUNDS_TO_ZERO: % (blend ticket line %) bills less than 0.0001 per line; correct the rate or acres', v_zero_qty_line.product_name, v_zero_qty_line.id USING ERRCODE = '22023';\n  END IF;\n\n  IF v_customer_count > 1 THEN\n");
  // Change 2.
  once("        IF v_zero_quoted THEN\n          PERFORM set_config('app.crx_below_cost_operation', 'create_invoice_from_blend_ticket', true);\n",
    '        IF v_zero_quoted THEN\n'
    + '          -- 20261022020000: an approved $0 line records the catalog cost (locked above) that the\n'
    + "          -- approval window showed and below_cost_approvals records, not the ticket line's\n"
    + '          -- editable cost copy, as the included-in-grower-share line already does.\n'
    + '          v_unit_cost := ROUND(COALESCE(v_btp.product_cost, 0) * 100)::bigint;\n'
    + "          PERFORM set_config('app.crx_below_cost_operation', 'create_invoice_from_blend_ticket', true);\n");
  return body;
}

function main() {
  assert.equal(candidateBody(INVOICE).body, expectedBody(), 'the candidate body is not the 20261021070000 body plus exactly the intended edits');
  console.log('[prover] BODY: the candidate body is the 20261021070000 body plus exactly the intended edits (byte for byte)');
  buildContainer();
  fidelity();
  seed();

  // 1. BEFORE.
  const before = chain(LOWS_CHAIN);
  assert.ok(!before.pass, 'BEFORE: the chain passed before the candidate existed');
  assert.match(before.fail, /SMOKE_FAIL: the per-unit line amount is not its stored quantity x price \(172844\): line 172838/, `BEFORE: wrong first failure: ${before.fail}`);
  console.log(`[prover] BEFORE: the chain fails first at step 1: ${before.fail}`);
  runCovering('BEFORE');
  const liveMd5 = scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${INVOICE_SIG}'::regprocedure;`);

  // 2. AUTOCOMMIT and PREFLIGHT.
  stageText('candidate.sql', lf(CANDIDATE));
  const auto = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(auto.status, 0, 'AUTOCOMMIT: the candidate ran outside one transaction');
  assert.match(auto.stderr, /BLEND_INVOICE_BINDING_LOWS_NOT_IN_TRANSACTION/, `AUTOCOMMIT: wrong refusal:\n${auto.stderr}`);
  assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${INVOICE_SIG}'::regprocedure;`), liveMd5, 'AUTOCOMMIT: a refused apply changed the function');
  const drifted = [
    [INVOICE_SIG, /PREFLIGHT_BLEND_INVOICE_BINDING_LOWS_DRIFT/],
    ...pins().slice(1).map(([sig]) => [sig, /PREFLIGHT_BLEND_INVOICE_BINDING_LOWS_DEPENDENCY_DRIFT/]),
  ];
  assert.equal(drifted.length, 6, 'every pinned body gets a drift test');
  for (const [sig, expected] of drifted) {
    const r = docker([...psqlArgs()], { input: `BEGIN;\n${drift(sig)}\n\\i /tmp/candidate.sql\nROLLBACK;`, allowFailure: true });
    assert.notEqual(r.status, 0, `PREFLIGHT: the candidate applied over a drifted ${sig}`);
    assert.match(r.stderr, expected, `PREFLIGHT: wrong refusal for a drifted ${sig}:\n${r.stderr}`);
  }
  // The line trigger disabled (its body unchanged): the candidate refuses too.
  const off = docker([...psqlArgs()], { input: 'BEGIN;\nALTER TABLE public.invoice_items DISABLE TRIGGER zz_crx_below_cost_invoice_items;\n\\i /tmp/candidate.sql\nROLLBACK;', allowFailure: true });
  assert.notEqual(off.status, 0, 'PREFLIGHT: the candidate applied with the below-cost line trigger disabled');
  assert.match(off.stderr, /PREFLIGHT_BLEND_INVOICE_BINDING_LOWS_TRIGGER_DRIFT/, `PREFLIGHT: wrong refusal for a disabled line trigger:\n${off.stderr}`);
  // The same trigger name and function re-created to fire on UPDATE only (inserts would skip the
  // below-cost wall): the candidate refuses too.
  const updOnly = docker([...psqlArgs()], {
    input: 'BEGIN;\nDROP TRIGGER zz_crx_below_cost_invoice_items ON public.invoice_items;\n'
      + 'CREATE TRIGGER zz_crx_below_cost_invoice_items BEFORE UPDATE ON public.invoice_items FOR EACH ROW EXECUTE FUNCTION public._enforce_below_cost_line();\n'
      + '\\i /tmp/candidate.sql\nROLLBACK;',
    allowFailure: true,
  });
  assert.notEqual(updOnly.status, 0, 'PREFLIGHT: the candidate applied with the line trigger firing on UPDATE only');
  assert.match(updOnly.stderr, /PREFLIGHT_BLEND_INVOICE_BINDING_LOWS_TRIGGER_DRIFT/, `PREFLIGHT: wrong refusal for an UPDATE-only line trigger:\n${updOnly.stderr}`);
  // Enabled ALWAYS still counts as enabled.
  const always = docker([...psqlArgs()], { input: 'BEGIN;\nALTER TABLE public.invoice_items ENABLE ALWAYS TRIGGER zz_crx_below_cost_invoice_items;\n\\i /tmp/candidate.sql\nROLLBACK;', allowFailure: true });
  assert.equal(always.status, 0, `PREFLIGHT: the candidate refused a line trigger enabled ALWAYS:\n${always.stderr}`);
  assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = '${INVOICE_SIG}'::regprocedure;`), liveMd5, 'PREFLIGHT: a refused apply changed the function');
  console.log(`[prover] AUTOCOMMIT + PREFLIGHT: outside one transaction, over any of ${drifted.length} drifted bodies (the invoice function, the line trigger, the share, quote-pick, tier-price and cents helpers), or with the line trigger disabled or firing on UPDATE only, the candidate stops before any change (a trigger enabled ALWAYS is accepted)`);

  // 3. APPLY.
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.match(a.output, /POSTFLIGHT_OK/, `the postflight did not report OK:\n${a.output}`);
  assert.equal(scalar(`SELECT has_function_privilege('anon', '${INVOICE_SIG}', 'EXECUTE')::text || ',' || has_function_privilege('authenticated', '${INVOICE_SIG}', 'EXECUTE')::text || ',' || (SELECT count(*) FROM pg_proc WHERE proname = '${INVOICE}')::text;`),
    'false,true,1', 'the replaced invoice function has the wrong grants, or there is more than one');
  console.log('[prover] candidate applied; POSTFLIGHT_OK; anon cannot run the invoice function, authenticated can, one overload');

  // 4. AFTER.
  const after = chain(LOWS_CHAIN);
  assert.ok(after.pass, `AFTER: the chain failed: ${after.fail}`);
  console.log('[prover] AFTER: the chain passes and rolls back');
  runCovering('AFTER');
  assert.ok(!/^\s*IF p_idempotency_key IS NOT NULL THEN/m.test(candidateBody(INVOICE).body), 'a dead retry-key test survived in the candidate');
  assert.equal(scalar(`SELECT (prosrc ~ '(^|\\n)\\s*IF p_idempotency_key IS NOT NULL THEN')::text || ',' || (prosrc ~ 'IDEMPOTENCY_KEY_REQUIRED')::text FROM pg_proc WHERE oid = '${INVOICE_SIG}'::regprocedure;`),
    'false,true', 'the applied body still has a dead retry-key test, or lost the required-key refusal');
  console.log('[prover] AFTER: the applied body has no dead "IF p_idempotency_key IS NOT NULL" test');

  // 5. RE-APPLY.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /PREFLIGHT_BLEND_INVOICE_BINDING_LOWS_DRIFT/, `second apply refused for the wrong reason:\n${again.output}`);
  console.log('[prover] RE-APPLY: refused by the preflight, nothing changed');

  // 6. MUTATION: each hunk is what its chain step proves. (The dead-test removal changes no
  // behaviour, so it has no failing mutation; instead the replay lookup and the receipt it used to
  // wrap are each removed, to prove the chain's replay step exercises them.)
  const ROUND_A = '      v_chem_qty_a_conv := ROUND(v_chem_qty_a_conv, 4);\n';
  const ROUND_B = '      v_chem_qty_b_conv := ROUND(v_chem_qty_b_conv, 4);\n';
  const ZERO_COST = '          v_unit_cost := ROUND(COALESCE(v_btp.product_cost, 0) * 100)::bigint;\n          PERFORM set_config(';
  const mutations = [
    ['stored quantity (both branches)', [[ROUND_A + ROUND_B, '']],
      /SMOKE_FAIL: the per-unit line amount is not its stored quantity x price \(172844\): line 172838/],
    ['stored quantity (per-unit)', [[ROUND_B, '']],
      /SMOKE_FAIL: the per-unit line amount is not its stored quantity x price/],
    ['stored quantity (grower share)', [[ROUND_A, '']],
      /SMOKE_FAIL: the included chemical's cost in the invoice is not its stored quantity x cost \(111114\): 111110/],
    ['zero-quantity refusal', [["   LIMIT 1;\n  IF FOUND THEN\n    RAISE EXCEPTION 'BLEND_INVOICE_QUANTITY_ROUNDS_TO_ZERO", "   LIMIT 1;\n  IF false THEN\n    RAISE EXCEPTION 'BLEND_INVOICE_QUANTITY_ROUNDS_TO_ZERO"]],
      /SMOKE_FAIL: a quantity that rounds to 0 at 4 places was billed/],
    ['$0 line catalog cost', [[ZERO_COST, '          PERFORM set_config(']],
      /SMOKE_FAIL: the approved \$0 line records the ticket's cost copy, not the approved catalog cost/],
    ['replay lookup', [['  IF v_existing IS NOT NULL THEN\n    -- The receipt is keyed', '  IF false THEN\n    -- The receipt is keyed']],
      /SMOKE_FAIL: the same key did not replay the same invoices/],
    ['receipt save', [["  PERFORM public.save_idempotency(\n    p_idempotency_key,\n    'create_invoice_from_blend_ticket',\n    v_result\n  );\n", '']],
      /SMOKE_FAIL: the same key did not replay the same invoices/],
  ];
  for (const [label, edits, expected] of mutations) {
    const r = chain(LOWS_CHAIN, mutate(INVOICE, edits, label));
    assert.ok(!r.pass, `MUTATION ${label}: the chain still passed without the hunk`);
    assert.match(r.fail, expected, `MUTATION ${label}: wrong failure: ${r.fail}`);
    console.log(`[prover] MUTATION: without the ${label} hunk the chain fails: ${r.fail}`);
  }

  console.log('BLEND_INVOICE_BINDING_LOWS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
