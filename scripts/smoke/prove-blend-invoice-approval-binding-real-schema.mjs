#!/usr/bin/env node
/**
 * Full-chain proof for the 20261021070000 candidate (Goal 3 follow-ups to 20261020210000): a
 * blend-ticket invoice refuses a line with no product, binds the $0 approval to the exact lines it
 * was shown, and bills a grower-share override ticket's $0 "included in grower share" chemical
 * behind the same approval instead of being refused by the below-cost line guard.
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers), then:
 *   0. FIDELITY: the body the candidate replaces and the two it depends on replayed with their live
 *      md5s of 2026-10-21 (read from the candidate's own preflight);
 *   1. BEFORE: the chain fails first at its step 0 (a line with no product billed), and the
 *      covering chains pass;
 *   2. AUTOCOMMIT: run statement by statement the file stops at its preflight;
 *      PREFLIGHT: a drifted create_invoice_from_blend_ticket aborts the candidate before any change;
 *   3. the candidate applies and prints POSTFLIGHT_OK;
 *   4. AFTER: the chain and the covering chains pass and roll back;
 *   5. RE-APPLY: refused by the preflight;
 *   6. MUTATION: with each hunk removed or weakened in turn the chain fails at that step.
 *
 * Run: node scripts/smoke/prove-blend-invoice-approval-binding-real-schema.mjs   (needs Docker)
 * Prints BLEND_INVOICE_APPROVAL_BINDING_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-blend-binding-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261021070000_blend_invoice_approval_binding.sql');
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
const PRICING_CHAIN = path.join(SMOKE, 'smoke-blend-invoice-approval-binding.sql');
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
// pins were read from live (read-only pg_proc queries, 2026-10-21); this checks the replay matches.
function fidelity() {
  const sql = lf(CANDIDATE).split('$preflight$')[1];
  const all = [...sql.matchAll(/to_regprocedure\('(public\.[^']+\))'\)\), chr\(13\), ''\)\) IS DISTINCT FROM '([0-9a-f]{32})'/g)].map((m) => [m[1], m[2]]);
  assert.equal(all.length, 3, 'the preflight pins three bodies');
  for (const [sig, pin] of all) {
    assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${sig}');`), pin, `${sig} replayed with a body that differs from the live pin`);
  }
  console.log(`[prover] FIDELITY: all ${all.length} pinned bodies match the live pins of 2026-10-21`);
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

const INVOICE = 'create_invoice_from_blend_ticket';

function main() {
  buildContainer();
  fidelity();
  seed();

  // 1. BEFORE.
  const before = chain(PRICING_CHAIN);
  assert.ok(!before.pass, 'BEFORE: the chain passed before the candidate existed');
  assert.match(before.fail, /SMOKE_FAIL: a blend-ticket invoice billed a line with no product/, `BEFORE: wrong first failure: ${before.fail}`);
  console.log(`[prover] BEFORE: the chain fails first at step 0: ${before.fail}`);
  runCovering('BEFORE');

  // 2. AUTOCOMMIT and PREFLIGHT.
  stageText('candidate.sql', lf(CANDIDATE));
  const auto = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(auto.status, 0, 'AUTOCOMMIT: the candidate ran outside one transaction');
  assert.match(auto.stderr, /BLEND_INVOICE_APPROVAL_BINDING_NOT_IN_TRANSACTION/, `AUTOCOMMIT: wrong refusal:\n${auto.stderr}`);
  assert.equal(scalar(`SELECT (to_regprocedure('public.${INVOICE}(uuid,uuid,text,text)') IS NOT NULL)::text || ',' || (to_regprocedure('public.${INVOICE}(uuid,uuid,text,text,jsonb)') IS NULL)::text;`),
    'true,true', 'AUTOCOMMIT: a refused apply changed the function');
  const drift = docker([...psqlArgs()], {
    input: `BEGIN;
CREATE OR REPLACE FUNCTION public.create_invoice_from_blend_ticket(p_blend_ticket_id uuid, p_created_by uuid, p_idempotency_key text DEFAULT NULL, p_below_cost_reason text DEFAULT NULL)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN NULL; END; $$;
\\i /tmp/candidate.sql
ROLLBACK;`,
    allowFailure: true,
  });
  assert.notEqual(drift.status, 0, 'PREFLIGHT: the candidate applied over a drifted body');
  assert.match(drift.stderr, /PREFLIGHT_BLEND_INVOICE_APPROVAL_BINDING_DRIFT/, `PREFLIGHT: wrong refusal:\n${drift.stderr}`);
  console.log('[prover] AUTOCOMMIT + PREFLIGHT: outside one transaction, or over a drifted body, the candidate stops before any change');

  // 3. APPLY.
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.match(a.output, /POSTFLIGHT_OK/, `the postflight did not report OK:\n${a.output}`);
  assert.equal(scalar(`SELECT has_function_privilege('anon', 'public.${INVOICE}(uuid,uuid,text,text,jsonb)', 'EXECUTE')::text || ',' || has_function_privilege('authenticated', 'public.${INVOICE}(uuid,uuid,text,text,jsonb)', 'EXECUTE')::text || ',' || (to_regprocedure('public.${INVOICE}(uuid,uuid,text,text)') IS NULL)::text;`),
    'false,true,true', 'the re-created invoice function has the wrong grants, or the old one survived');
  console.log('[prover] candidate applied; POSTFLIGHT_OK; anon cannot run the invoice function and the 4-argument one is gone');

  // 4. AFTER.
  const after = chain(PRICING_CHAIN);
  assert.ok(after.pass, `AFTER: the chain failed: ${after.fail}`);
  console.log('[prover] AFTER: the chain passes and rolls back');
  runCovering('AFTER');

  // 5. RE-APPLY.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /PREFLIGHT_BLEND_INVOICE_APPROVAL_BINDING_DRIFT/, `second apply refused for the wrong reason:\n${again.output}`);
  console.log('[prover] RE-APPLY: refused by the preflight, nothing changed');

  // 6. MUTATION: each hunk is what its chain step proves.
  const UNMATCHED = between(INVOICE, '  -- 20261021070000: every line must be a catalog product.', '  v_quote_section_id := NULL;\n  IF v_ticket.job_id IS NOT NULL THEN\n');
  const GROWER_TERM = "                 EXISTS (SELECT 1 FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)\n                          WHERE (r.value->>'price_override_cents') IS NOT NULL\n                            AND (r.value->>'share_acres')::numeric > 0) AS in_grower_share\n";
  const KIND = "           'kind', CASE WHEN z.quoted_zero AND z.in_grower_share THEN 'quoted_zero_and_grower_share'\n                        WHEN z.quoted_zero THEN 'quoted_zero' ELSE 'grower_share' END,\n";
  const STALE_SET = between(INVOICE, "    IF ARRAY(SELECT DISTINCT lower(e.value->>'line_id')", "  ELSIF p_approved_zero_lines IS NOT NULL OR");
  const STALE_NONE = between(INVOICE, "  ELSIF p_approved_zero_lines IS NOT NULL OR", '  END IF;\n\n  IF v_customer_count > 1 THEN');
  const KEY_REQUIRED = between(INVOICE, '  -- 20261021070000: a retry key is required', '  IF p_idempotency_key IS NOT NULL THEN\n    v_existing');
  const STALE_TYPE = between(INVOICE, "    IF jsonb_typeof(p_approved_zero_lines) IS DISTINCT FROM 'array' THEN\n", "    IF ARRAY(SELECT DISTINCT lower(e.value->>'line_id')");
  const KEY = "lower(e.value->>'line_id') || ':' || lower(e.value->>'product_id') || ':' || COALESCE(e.value->>'kind', '') || ':' || COALESCE(e.value->>'cost_cents', '') || ':' || COALESCE(e.value->>'basis', '')";
  const KEY_NO_COST = "lower(e.value->>'line_id') || ':' || lower(e.value->>'product_id') || ':' || COALESCE(e.value->>'kind', '') || ':' || COALESCE(e.value->>'basis', '')";
  const KEY_NO_KIND = "lower(e.value->>'line_id') || ':' || lower(e.value->>'product_id') || ':' || COALESCE(e.value->>'cost_cents', '') || ':' || COALESCE(e.value->>'basis', '')";
  const KEY_NO_BASIS = "lower(e.value->>'line_id') || ':' || lower(e.value->>'product_id') || ':' || COALESCE(e.value->>'kind', '') || ':' || COALESCE(e.value->>'cost_cents', '')";
  const mutations = [
    ['unmatched-line refusal', [[UNMATCHED, '']],
      /SMOKE_FAIL: a blend-ticket invoice billed a line with no product/],
    // The included chemical is no longer asked about up front: the line trigger asks instead,
    // after an invoice number is drawn, and its request does not list the line for the window.
    // Not listed, the included chemical is never approved: it gets no below-cost context and the
    // line trigger refuses it (fails closed) instead of the screen asking first.
    ['grower-share line in the approval', [[GROWER_TERM, '                 false AS in_grower_share\n']],
      /SMOKE_FAIL: (the grower-share approval does not list the included chemical|the grower-share ticket was refused instead of asking for approval: BELOW_COST_CONTEXT_REQUIRED)/],
    // The window can no longer tell a $0 quoted line from a grower-share line.
    ['each $0 line says why it is $0', [[KIND, '']],
      /SMOKE_FAIL: the approval request does not list every \$0 line/],
    ['grower-share line context', [["        IF v_zero_grower THEN\n          PERFORM set_config('app.crx_below_cost_operation', 'create_invoice_from_blend_ticket', true);\n", "        IF false THEN\n          PERFORM set_config('app.crx_below_cost_operation', 'create_invoice_from_blend_ticket', true);\n"]],
      /SMOKE_FAIL: the approved grower-share invoice was refused: BELOW_COST_CONTEXT_REQUIRED/],
    ['grower-share line context reset', [["        IF v_zero_grower THEN\n          PERFORM set_config('app.crx_below_cost_operation', '', true);\n", "        IF false THEN\n          PERFORM set_config('app.crx_below_cost_operation', '', true);\n"]],
      /SMOKE_FAIL: the below-cost context was left set after the grower-share invoice/],
    ['approval bound to the shown lines', [[STALE_SET, '']],
      /SMOKE_FAIL: an approval that does not name exactly the shown \$0 lines billed \(one\)/],
    ['approval bound to each line\'s product', [[`    IF ARRAY(SELECT DISTINCT ${KEY}\n`, "    IF ARRAY(SELECT DISTINCT lower(e.value->>'line_id')\n"], [`       IS DISTINCT FROM ARRAY(SELECT DISTINCT ${KEY}\n`, "       IS DISTINCT FROM ARRAY(SELECT DISTINCT lower(e.value->>'line_id')\n"]],
      /SMOKE_FAIL: an approval that does not name exactly the shown \$0 lines billed \(product\)/],
    ['approval bound to each line\'s cost', [[`    IF ARRAY(SELECT DISTINCT ${KEY}\n`, `    IF ARRAY(SELECT DISTINCT ${KEY_NO_COST}\n`], [`       IS DISTINCT FROM ARRAY(SELECT DISTINCT ${KEY}\n`, `       IS DISTINCT FROM ARRAY(SELECT DISTINCT ${KEY_NO_COST}\n`]],
      /SMOKE_FAIL: an approval that does not name exactly the shown \$0 lines billed \(cost\)/],
    ['approval bound to each line\'s kind', [[`    IF ARRAY(SELECT DISTINCT ${KEY}\n`, `    IF ARRAY(SELECT DISTINCT ${KEY_NO_KIND}\n`], [`       IS DISTINCT FROM ARRAY(SELECT DISTINCT ${KEY}\n`, `       IS DISTINCT FROM ARRAY(SELECT DISTINCT ${KEY_NO_KIND}\n`]],
      /SMOKE_FAIL: an approval that does not name exactly the shown \$0 lines billed \(kind\)/],
    ['approval bound to each line\'s basis', [[`    IF ARRAY(SELECT DISTINCT ${KEY}\n`, `    IF ARRAY(SELECT DISTINCT ${KEY_NO_BASIS}\n`], [`       IS DISTINCT FROM ARRAY(SELECT DISTINCT ${KEY}\n`, `       IS DISTINCT FROM ARRAY(SELECT DISTINCT ${KEY_NO_BASIS}\n`]],
      /SMOKE_FAIL: an approval that does not name exactly the shown \$0 lines billed \(basis\)/],
    ['basis covers the product units', [['                      z.p_rate_unit, z.p_inventory_unit, z.p_unit_size, z.p_product_form,\n', '                      NULL, NULL, NULL, NULL,\n']],
      /SMOKE_FAIL: a grower-share approval billed after the product unit changed/],
    ['retry key required', [[KEY_REQUIRED, '']],
      /SMOKE_FAIL: a blend-ticket invoice was made with no retry key/],
    ['approval with no $0 line left', [[STALE_NONE, '']],
      /SMOKE_FAIL: an approval for \$0 lines billed a ticket that has none/],
    ['reason-only approval with no $0 line left', [["  ELSIF p_approved_zero_lines IS NOT NULL OR NULLIF(btrim(COALESCE(p_below_cost_reason, '')), '') IS NOT NULL THEN\n", '  ELSIF p_approved_zero_lines IS NOT NULL THEN\n']],
      /SMOKE_FAIL: a reason-only \$0 approval billed a ticket that has none/],
    ['grower line cost', [['          0, 0, v_unit_cost,\n', '          0, 0, 0,\n']],
      /SMOKE_FAIL: the included chemical line records no cost/],
    ['grower line catalog cost', [['        v_unit_cost := ROUND(COALESCE(v_btp.product_cost, 0) * 100)::bigint;\n', '        v_unit_cost := COALESCE(v_btp.unit_cost_cents, ROUND(COALESCE(v_btp.product_cost, 0) * 100)::bigint, 0);\n']],
      /SMOKE_FAIL: the included chemical line records no cost/],
    ['grower line cost in invoice cost', [['        v_invoice_cost := v_invoice_cost + safe_cents_qty(v_unit_cost, v_chem_qty_a_conv);\n', '']],
      /SMOKE_FAIL: the grower-share invoice cost leaves out the included chemical/],
    ['approval must be a list', [[STALE_TYPE, '']],
      /SMOKE_FAIL: wrong stale-approval refusal \(object\)/],
  ];
  for (const [label, edits, expected] of mutations) {
    const r = chain(PRICING_CHAIN, mutate(INVOICE, edits, label));
    assert.ok(!r.pass, `MUTATION ${label}: the chain still passed without the hunk`);
    assert.match(r.fail, expected, `MUTATION ${label}: wrong failure: ${r.fail}`);
    console.log(`[prover] MUTATION: without the ${label} hunk the chain fails: ${r.fail}`);
  }

  console.log('BLEND_INVOICE_APPROVAL_BINDING_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
