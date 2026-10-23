#!/usr/bin/env node
/**
 * Full-chain proof for the 20261021150000 candidate: split billing can bill a field owner who is
 * not the order's customer, and only through the governed split path (guard_invoice_terminal_order).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers), then:
 *   0. FIDELITY: every body the candidate's preflight pins replayed with its live md5 of 2026-10-21;
 *   1. BEFORE: the new chain fails first at its step 1 (a two-owner split is refused), and every
 *      other registered chain covering the order-invoice and split-group paths passes;
 *   2. AUTOCOMMIT: run statement by statement (psql -f, no -1) the file stops at its preflight;
 *      PREFLIGHT: a drifted body aborts the candidate before any change;
 *   3. the candidate applies and prints POSTFLIGHT_OK;
 *   4. AFTER: the new chain (create, replay, post and void a four-customer split; refusals at the
 *      exception's limits and of the unchanged rule) and every other covering chain pass and roll back;
 *   5. RE-APPLY: refused by the preflight's own pins;
 *   6. MUTATION: each load-bearing condition, removed in turn, fails its own chain step: the owner
 *      test widened to any allocation (the unresolved-owner refusal), the provenance branch off
 *      (posting the group), the group requirement dropped (the ungrouped-in-claim refusal) and the
 *      billing-default exclusion dropped (the excluded-owner refusal). The creation-claim test is
 *      defence in depth: require_split_invoice_creation_claim refuses every unclaimed grouped
 *      insert on a split order first, so no chain step can isolate it.
 *
 * Run: node scripts/smoke/prove-split-invoice-cross-customer-lineage-real-schema.mjs   (needs Docker)
 * Prints SPLIT_INVOICE_LINEAGE_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-split-invoice-lineage-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261021150000_split_invoice_cross_customer_lineage.sql');
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
const LINEAGE_CHAIN = path.join(SMOKE, 'smoke-split-invoice-cross-customer-lineage.sql');
// Every other registered chain whose `covers` names guard_invoice_terminal_order or an order-invoice
// wrapper (each writes order invoices through the guard). (smoke-unpost-invoice-group.sql is left
// out: it stops at GROUP_POST_REQUIRED in a disposable database before this candidate is applied.)
const COVERING_CHAINS = [
  'smoke-order-invoice-type-gate.sql',
  'smoke-order-invoice-rep-own-name.sql',
  'smoke-backfill-refuse-split-billing.sql',
  'smoke-govern-invoice-order-money-lifecycle.sql',
  'smoke-money-lifecycle-idempotency-required.sql',
  // void_order: governed split drafts are cancelled through this guard (20261021030000).
  // (smoke-draw-ledger-reversal.sql, the other void_order chain, needs an existing live product and
  // stops at SMOKE_SETUP in a disposable database.)
  'smoke-void-order-governed-split-drafts.sql',
];
const SUPERUSER_CHAINS = new Set(['smoke-govern-invoice-order-money-lifecycle.sql']);
const GUARD = 'guard_invoice_terminal_order';

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
  // Only 20261021155000 (split-payer returns, which builds on this guard) may follow it.
  assert.deepEqual(all.slice(at + 1).map((f) => path.basename(f)),
    all.length - 1 === at ? [] : ['20261021155000_split_payer_return_credit.sql'],
    'the candidate must be the last migration in the replay plan, or followed only by 20261021155000');
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
// The pins were read from live (read-only pg_proc queries, 2026-10-21); this checks the replay matches.
function fidelity() {
  const sql = lf(CANDIDATE).split('$preflight$')[1];
  const contracts = [...sql.matchAll(/md5\(replace\(p\.prosrc, chr\(13\), ''\)\) = '([0-9a-f]{32})'/g)].map((m) => m[1]);
  assert.equal(contracts.length, 1, 'the preflight pins the guard by contract');
  const pins = [
    [`public.${GUARD}()`, contracts[0]],
    // The dependency list: the split creation-claim and provenance-identity guards, both split functions.
    ...[...sql.matchAll(/\('(public\.[^']+\))', '([0-9a-f]{32})'\)/g)].map((m) => [m[1], m[2]]),
  ];
  assert.equal(pins.length, 5, 'the preflight pins five bodies');
  for (const [sig, pin] of pins) {
    assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${sig}');`), pin, `${sig} replayed with a body that differs from the live pin`);
  }
  console.log(`[prover] FIDELITY: all ${pins.length} pinned bodies match the live pins of 2026-10-21`);
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
// Owner test widened to "any allocation on the order": the split's owner resolution stops mattering.
const OWNER_TEST = '           AND (\n             EXISTS (\n               SELECT 1 FROM public.field_billing_defaults fbd\n';
const OWNER_TEST_WIDENED = '           AND (true OR\n             EXISTS (\n               SELECT 1 FROM public.field_billing_defaults fbd\n';
// Provenance branch disabled: a governed split invoice could no longer be updated after creation.
const PROVENANCE_BRANCH = '      v_governed_split_customer := v_split_identity_kept AND EXISTS (\n';
const PROVENANCE_BRANCH_OFF = '      v_governed_split_customer := v_split_identity_kept AND false AND EXISTS (\n';
// Group requirement dropped: an ungrouped invoice inside a split claim could name an owner.
const GROUP_REQUIRED = '  IF NEW.customer_id IS DISTINCT FROM v_order_customer_id AND NEW.invoice_group_id IS NOT NULL THEN\n';
const GROUP_DROPPED = '  IF NEW.customer_id IS DISTINCT FROM v_order_customer_id THEN\n';
// Fallback narrowed away: a field owner would be admitted even when its billing defaults exclude it.
const OWNER_FALLBACK = '               NOT EXISTS (SELECT 1 FROM public.field_billing_defaults fbd WHERE fbd.field_id = oifa.field_id)\n               AND EXISTS (\n';
const OWNER_FALLBACK_OFF = '               EXISTS (\n';

async function main() {
  buildContainer();
  fidelity();
  seed();

  // 1. BEFORE.
  const before = chain(LINEAGE_CHAIN);
  assert.ok(!before.pass, 'BEFORE: the lineage chain passed against the pre-fix guard');
  assert.match(before.fail, /SMOKE_FAIL: a split onto another customer's field was refused: INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID/, `BEFORE: wrong first failure: ${before.fail}`);
  console.log('[prover] BEFORE: the lineage chain fails first at step 1 (the cross-customer split is refused by the lineage rule)');
  runCovering('BEFORE');

  // 2. AUTOCOMMIT and PREFLIGHT.
  stageText('candidate.sql', lf(CANDIDATE));
  const auto = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(auto.status, 0, 'AUTOCOMMIT: the candidate ran outside one transaction');
  assert.match(auto.stderr, /SPLIT_INVOICE_LINEAGE_NOT_IN_TRANSACTION/, `AUTOCOMMIT: wrong refusal:\n${auto.stderr}`);
  const drift = docker([...psqlArgs()], {
    input: `BEGIN;
CREATE OR REPLACE FUNCTION public.${GUARD}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN NEW; END; $$;
\\i /tmp/candidate.sql
ROLLBACK;`,
    allowFailure: true,
  });
  assert.notEqual(drift.status, 0, 'PREFLIGHT: the candidate applied over a drifted body');
  assert.match(drift.stderr, /PREFLIGHT_INVOICE_LINEAGE_GUARD_DRIFT/, `PREFLIGHT: wrong refusal:\n${drift.stderr}`);
  console.log('[prover] AUTOCOMMIT + PREFLIGHT: outside one transaction, or over a drifted body, the candidate stops before any change');

  // 3. APPLY.
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.match(a.output, /POSTFLIGHT_OK/, `the postflight did not report OK:\n${a.output}`);
  console.log('[prover] candidate applied; POSTFLIGHT_OK');

  // 4. AFTER.
  const after = chain(LINEAGE_CHAIN);
  assert.ok(after.pass, `AFTER: the lineage chain failed: ${after.fail}`);
  console.log('[prover] AFTER: the lineage chain passes and rolls back (four-customer split created, replayed, posted, voided; four refusals at the exception\'s limits, three unchanged-rule refusals)');
  runCovering('AFTER');

  // 5. RE-APPLY.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /PREFLIGHT_INVOICE_LINEAGE_GUARD_DRIFT/, `second apply refused for the wrong reason:\n${again.output}`);
  console.log('[prover] RE-APPLY: refused by the preflight, nothing changed');

  // 6. MUTATION: each hunk is what its chain step proves.
  const mutations = [
    ['owner test widened to any allocation', OWNER_TEST, OWNER_TEST_WIDENED,
      /SMOKE_FAIL: a claimed split invoice billed a customer the split does not bill/],
    ['provenance branch off', PROVENANCE_BRANCH, PROVENANCE_BRANCH_OFF,
      /SMOKE_FAIL: posting the cross-customer split group was refused: INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID/],
    ['group requirement dropped', GROUP_REQUIRED, GROUP_DROPPED,
      /SMOKE_FAIL: an ungrouped invoice inside a split claim billed another customer/],
    ['billing-default exclusion dropped', OWNER_FALLBACK, OWNER_FALLBACK_OFF,
      /SMOKE_FAIL: a claimed split invoice billed a field owner its billing defaults exclude/],
  ];
  for (const [label, find, replacement, expected] of mutations) {
    const r = chain(LINEAGE_CHAIN, mutate(GUARD, find, replacement, label));
    assert.ok(!r.pass, `MUTATION ${label}: the chain still passed`);
    assert.match(r.fail, expected, `MUTATION ${label}: wrong failure: ${r.fail}`);
    console.log(`[prover] MUTATION: with the ${label} the chain fails: ${r.fail}`);
  }

  console.log('SPLIT_INVOICE_LINEAGE_PROOF_PASS');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); });
