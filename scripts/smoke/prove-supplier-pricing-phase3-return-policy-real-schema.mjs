#!/usr/bin/env node
/**
 * Container proof for the registered chain smoke-supplier-pricing-phase3-return-policy.sql on the
 * CURRENT schema (no candidate migration).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration (the same skips as the
 * other real-schema provers), seeds one active admin and one active sales rep, then:
 *   1. CONTROLS: each fixture repair is load-bearing. With the governed-pricing setup removed the
 *      chain stops at its first order line with COST_BASIS_REQUIRED (products are born
 *      pricing-free); with the delivery helper emptied it stops at the first return with
 *      RETURN_SOURCE_NOT_DELIVERED (a return needs delivered quantity behind it);
 *   2. PASS: the chain as committed reaches PHASE3_UNRELATED_CREDIT_MEMO_UNAPPLY_PASS and its
 *      terminal SMOKE_PASS_ROLLBACK, and leaves no [SMOKE] row behind.
 *
 * The companion prove-supplier-pricing-phase3-return-policy-concurrency.mjs proves the Phase 3
 * concurrency contract; this file proves only the rollback matrix chain.
 *
 * Run: node scripts/smoke/prove-supplier-pricing-phase3-return-policy-real-schema.mjs   (needs Docker)
 * Prints PHASE3_RETURN_POLICY_CHAIN_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-phase3-chain-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
// Live but not replayable here (storage.objects policies); it does not touch returns or pricing.
const PARKED = new Set(['20260914100700_customer_document_bytes_server_only.sql']);
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
const CHAIN = path.join(ROOT, 'scripts', 'smoke', 'smoke-supplier-pricing-phase3-return-policy.sql');
// The chain's governed-pricing setup, removed whole for the CONTROL run.
const PRICING_START = '  FOREACH v_priced IN ARRAY ARRAY[v_unknown,v_returnable,v_blocked,v_other] LOOP\n';
const PRICING_END = '  END LOOP;\n';
// The first statement of the chain's delivery helper; an early RETURN before it empties the helper.
const DELIVERY_FIRST = '      SELECT oi.*,o.customer_id INTO v_oi FROM public.order_items oi';

const id = (n) => `7a500000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), REP: id('b1') };

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
  // disposable database does not have); none of them touches returns or product pricing.
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  assert.ok(all.length > 0, 'the post-baseline replay plan is empty');
  // A ledger-only row stands in for a real file: it must still exist and still be withheld.
  for (const name of LEDGER_ONLY) {
    assert.ok(existsSync(path.join(MIGRATIONS, name)), `${name} is gone or renamed (re-check the LEDGER_ONLY list)`);
    assert.ok(!all.some((f) => path.basename(f) === name), `${name} is now in the replay plan (replay it instead)`);
  }
  for (const name of PARKED) {
    const file = all.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!/return_items|public\.returns\b|_return\(|return_credit|credit_memo|product_pricing|current_cost/.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
  }
  return all;
}
let started = false;  // cleanup removes only the container this run created
function buildContainer() {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  started = true;
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
  const recorded = new Set();  // ledger-only stems already written
  for (const [i, file] of files.entries()) {
    const base = path.basename(file);
    if (PARKED.has(base)) continue;
    // The replay plan omits the data-only files; record each once the replay passes its stamp.
    for (const only of LEDGER_ONLY) {
      if (only < base && !recorded.has(only)) { ledger(path.basename(only, '.sql')); recorded.add(only); }
    }
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    // Later preflights look their predecessors up in the ledger by name, as on live.
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
  console.log(`[prover] replayed ${replayed} post-baseline migrations, through ${path.basename(files.at(-1))} (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

// ------------------------------------------------------------------------------------------------
function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.REP, 'sales_rep', 'Rep', 8]];
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'phase3-chain-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7a500000-%';`),
    'admin:true,sales_rep:true', 'the seeded roles are not what the chain needs');
}

/** Run chain text in one transaction that is rolled back whatever the chain does. */
function chain(text) {
  stageText('chain.sql', text);
  const r = docker([...psqlArgs()], { input: 'BEGIN;\n\\i /tmp/chain.sql\nROLLBACK;\n', allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  // ON_ERROR_STOP: the run's one error must be the chain's own terminal marker, nothing else.
  const errors = out.split(/\r?\n/).filter((l) => /\bERROR:/.test(l));
  const pass = r.status !== 0 && errors.length === 1 && /ERROR:\s+SMOKE_PASS_ROLLBACK\s*$/.test(errors[0]);
  const fail = /SMOKE_FAIL[^\n]*/.exec(out)?.[0] ?? (pass ? '' : (/ERROR:[^\n]*/.exec(out)?.[0] ?? out.trim().slice(-400)));
  return { pass, fail, out };
}
function withoutPricingSetup(text) {
  assert.equal(text.split(PRICING_START).length - 1, 1, 'the chain\'s governed-pricing loop was not found exactly once');
  const start = text.indexOf(PRICING_START);
  const end = text.indexOf(PRICING_END, start) + PRICING_END.length;
  assert.ok(end > start + PRICING_START.length, 'the governed-pricing loop has no END LOOP');
  return text.slice(0, start) + text.slice(end);
}
function withoutDeliveries(text) {
  assert.equal(text.split(DELIVERY_FIRST).length - 1, 1, 'the chain\'s delivery helper was not found exactly once');
  return text.replace(DELIVERY_FIRST, `      RETURN;\n${DELIVERY_FIRST}`);
}
const leftovers = () => scalar("SELECT (SELECT count(*) FROM public.products WHERE product_name LIKE '[SMOKE]%') + (SELECT count(*) FROM public.customers WHERE farm_name LIKE '[SMOKE]%');");

function main() {
  buildContainer();
  seed();
  const text = lf(CHAIN);

  // 1. CONTROLS: the fixture the chain had before its repair, one missing piece at a time.
  for (const [label, mutated, expected] of [
    ['the governed-pricing setup', withoutPricingSetup(text), /COST_BASIS_REQUIRED/],
    ['completed deliveries', withoutDeliveries(text), /RETURN_SOURCE_NOT_DELIVERED/],
  ]) {
    const control = chain(mutated);
    assert.ok(!control.pass, `CONTROL: the chain passed without ${label}`);
    assert.match(control.fail, expected, `CONTROL: without ${label}, wrong first failure: ${control.fail}`);
    console.log(`[prover] CONTROL: without ${label} the chain stops at: ${control.fail}`);
  }

  // 2. PASS.
  const run = chain(text);
  assert.ok(run.pass, `PASS: the chain failed: ${run.fail}`);
  assert.match(run.out, /PHASE3_UNRELATED_CREDIT_MEMO_UNAPPLY_PASS/, 'PASS: the unrelated credit-memo unapply step did not report');
  assert.equal(leftovers(), '0', 'PASS: the chain left [SMOKE] rows behind');
  console.log('[prover] PASS: the chain reaches PHASE3_UNRELATED_CREDIT_MEMO_UNAPPLY_PASS and SMOKE_PASS_ROLLBACK, nothing left behind');

  console.log('PHASE3_RETURN_POLICY_CHAIN_PROOF_PASS');
}

try { main(); }
finally {
  if (started && !KEEP) {
    const r = docker(['rm', '-f', NAME], { allowFailure: true });
    if (r.status !== 0) {
      console.error(`could not remove container ${NAME}: ${(r.stderr || r.stdout).trim()}`);
      process.exitCode = 1;
    }
  }
}
