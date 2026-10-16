#!/usr/bin/env node
/**
 * Full-chain proof for the 20261016060000 candidate: nine money RPCs replay a stored idempotency
 * receipt only for the same person and the exact same request (batch 1 of the replay-binding fix,
 * KNOWN_ISSUES.md; follow-up of PR #933).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers), then:
 *   0. FIDELITY: every body the candidate's preflight pins replayed with its live md5 of 2026-10-15;
 *   1. BEFORE: the new chain fails first at its step 1 (void_payment hands payment 1's receipt back
 *      as success for payment 2), and every covering chain that passes is recorded;
 *   2. AUTOCOMMIT: run statement by statement (psql -f, no -1) the file stops at its preflight;
 *      PREFLIGHT: a drifted void_payment aborts the candidate before any change;
 *   3. the candidate applies and prints POSTFLIGHT_OK;
 *   4. AFTER: the new chain passes and rolls back, consumes no sequence value (so it is safe to run
 *      rollback-only against live), and every covering chain that passed BEFORE still passes;
 *   5. RE-APPLY: refused by the preflight's own pins;
 *   6. MUTATION: with each wrapper's target or payload taken out of its fingerprint, or with the
 *      receipt binder broken, the new chain fails at the step that proves it.
 *
 * Run: node scripts/smoke/prove-money-replay-binding-batch1-real-schema.mjs   (needs Docker)
 * Prints MONEY_REPLAY_BINDING_BATCH1_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-money-replay-batch1-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261016060000_bind_money_replay_receipts_batch1.sql');
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
const CHAIN = path.join(SMOKE, 'smoke-money-replay-binding-batch1.sql');
// Every other non-container chain that calls one of the nine RPCs. Each must keep passing after
// the candidate if it passed before it (some need live data this database lacks; those are
// reported, not required).
const COVERING_CHAINS = [
  'smoke-void_payment_prepay_reversal.sql',
  'smoke-void-invoice-blocks-applied-payments.sql',
  'smoke-prepay-payment-inactive-actor-gate.sql',
  'smoke-batch-prepay-admin-gate.sql',
  'smoke-gauntlet-money-workflows.sql',
];
const WRAPPED = [
  'void_payment', 'delete_prepay_credit', 'edit_prepay_credit', 'apply_write_off', 'reverse_write_off',
  'apply_prepay_to_invoice', 'create_prepay_check_splits', 'batch_apply_prepayments', 'batch_void_invoices',
];

const id = (n) => `7b600000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), ADMIN_B: id('a2'), REP: id('b1') };

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
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const at = all.indexOf(CANDIDATE);
  assert.ok(at >= 0, 'the candidate must be selected for post-baseline replay');
  assert.equal(at, all.length - 1, 'the candidate must be the last migration in the replay plan');
  const before = all.slice(0, at);
  const touched = new RegExp(WRAPPED.join('|'));
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!touched.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
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
// FIDELITY: the md5 pins the candidate's preflight checks, read from the candidate file itself.
function fidelity() {
  const sql = lf(CANDIDATE).split('$preflight$')[1];
  const pins = [...sql.matchAll(/\('([a-z_]+)', '[^']*', '[a-z]+', '([0-9a-f]{32})'\)/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(pins.map(([n]) => n).sort(), [...WRAPPED].sort(), 'the preflight pins exactly the nine wrapped bodies');
  const intent = /p\.proname = 'check_idempotency_intent'[\s\S]*?= '([0-9a-f]{32})'/.exec(sql);
  assert.ok(intent, 'the preflight pins check_idempotency_intent');
  pins.push(['check_idempotency_intent', intent[1]]);
  for (const [name, pin] of pins) {
    assert.equal(scalar(`SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${name}';`),
      pin, `${name} replayed with a body that differs from the live pin`);
  }
  console.log(`[prover] FIDELITY: all ${pins.length} pinned bodies match the live pins of 2026-10-15`);
}

// ------------------------------------------------------------------------------------------------
function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.ADMIN_B, 'admin', 'Admin B', 8], [U.REP, 'sales_rep', 'Rep', 7]];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'replay-batch1-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7b600000-%';`),
    'admin:true,admin:true,sales_rep:true', 'the seeded roles are not what the proof needs');
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
function covering(phase, required) {
  const passed = new Set();
  for (const name of COVERING_CHAINS) {
    const r = chain(path.join(SMOKE, name));
    if (r.pass) passed.add(name);
    else if (required?.has(name)) assert.fail(`${phase}: ${name} passed before the candidate and fails after it: ${r.fail}`);
    else console.log(`[prover] ${phase}: ${name} does not pass in this database (not required): ${r.fail}`);
  }
  console.log(`[prover] ${phase}: ${passed.size}/${COVERING_CHAINS.length} covering chains pass and roll back: ${[...passed].join(', ')}`);
  return passed;
}
function sequences() {
  const rows = docker([...psqlArgs(), '-A', '-t', '-F', '|'], {
    input: "SELECT schemaname || '.' || sequencename, COALESCE(last_value::text, 'null') FROM pg_sequences ORDER BY 1;",
  }).stdout.trim().split(/\r?\n/).filter(Boolean);
  return new Map(rows.map((r) => r.split('|')));
}
// A rollback does not return sequence values. Surrogate row-id sequences moving is harmless; a
// document-number sequence (invoice, payment, credit-memo numbers) moving would leave a visible gap
// on live, so the chain must never move one.
function movedSequences(before, after) {
  return [...after.keys()].filter((k) => after.get(k) !== before.get(k));
}
function documentNumberSequences() {
  return new Set(docker([...psqlArgs(), '-A', '-t'], {
    input: `SELECT DISTINCT s.schemaname || '.' || s.sequencename
              FROM pg_sequences s
             WHERE s.sequencename ~ '(number|_no|_num)'
                OR EXISTS (SELECT 1 FROM pg_proc p
                            WHERE p.prosrc ILIKE '%nextval(%' || s.sequencename || '%'
                              AND p.proname ~ '^next_.*_number$');`,
  }).stdout.trim().split(/\r?\n/).filter(Boolean));
}

/** A deactivated admin asks reverse_write_off to reverse a write-off that does not exist. */
function deactivatedAdminReverse(prefix = '') {
  const r = docker([...psqlArgs()], {
    input: `BEGIN;
${prefix}
SELECT set_config('request.jwt.claims', json_build_object('sub', '${U.ADMIN}', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', '${U.ADMIN}', true);
UPDATE public.profiles SET is_active = false WHERE id = '${U.ADMIN_B}';
SELECT set_config('request.jwt.claims', json_build_object('sub', '${U.ADMIN_B}', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', '${U.ADMIN_B}', true);
SELECT public.reverse_write_off(gen_random_uuid(), 'prover reason', NULL, 'prover-deactivated-' || gen_random_uuid());
ROLLBACK;`,
    allowFailure: true,
  });
  return /ERROR:[^\n]*/.exec(`${r.stdout}\n${r.stderr}`)?.[0] ?? 'no error';
}
/** Insert an unbound receipt for a wrapped operation and force the deferred guard to run now. */
function unboundReceipt(prefix = '') {
  const r = docker([...psqlArgs()], {
    input: `BEGIN;
${prefix}
INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
VALUES ('prover-unbound-' || gen_random_uuid(), 'apply_write_off', '{"id":"x"}'::jsonb);
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'UNBOUND_RECEIPT_ACCEPTED';
ROLLBACK;`,
    allowFailure: true,
  });
  const out = `${r.stdout}\n${r.stderr}`;
  return /UNBOUND_RECEIPT_ACCEPTED/.test(out) ? 'accepted' : (/ERROR:[^\n]*/.exec(out)?.[0] ?? out.trim().slice(-300));
}

/**
 * An unbound receipt queued by the owner, then COMMITted while the session role is authenticated
 * (as after a browser RPC returns). On PostgreSQL 17 the deferred guard runs under that role, which
 * row-level security blinds to idempotency_keys, so only a SECURITY DEFINER guard can see the row.
 */
function unboundReceiptCommittedAsAuthenticated(prefix = '') {
  const key = `prover-unbound-as-authenticated-${Date.now()}`;
  const r = docker([...psqlArgs()], {
    input: `${prefix}
BEGIN;
INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
VALUES ('${key}', 'apply_write_off', '{"id":"x"}'::jsonb);
SELECT set_config('request.jwt.claims', json_build_object('sub', '${U.ADMIN}', 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;
COMMIT;`,
    allowFailure: true,
  });
  const committed = scalar(`SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = '${key}';`);
  psql(`DELETE FROM public.idempotency_keys WHERE idempotency_key = '${key}';`);
  return { refused: /REPLAY_RECEIPT_UNBOUND/.test(`${r.stdout}\n${r.stderr}`), committed };
}

function candidateBody(fn) {
  const sql = lf(CANDIDATE);
  const start = sql.search(new RegExp(`CREATE FUNCTION public\\.${fn}\\(`));
  assert.ok(start >= 0, `${fn} is not created by the candidate`);
  const tag = /AS (\$[a-z_]*\$)/.exec(sql.slice(start))[1];
  const a = sql.indexOf(`AS ${tag}`, start) + `AS ${tag}`.length;
  const header = sql.slice(start, a).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
  return { header, body: sql.slice(a, sql.indexOf(`${tag};`, a)), tag };
}
function mutate(fn, find, replacement, label) {
  const { header, body, tag } = candidateBody(fn);
  assert.equal(body.split(find).length - 1, 1, `mutation "${label}": hunk not found exactly once`);
  return `${header}${body.replace(find, replacement)}${tag};`;
}

function main() {
  buildContainer();
  fidelity();
  seed();

  // 1. BEFORE.
  const before = chain(CHAIN);
  assert.ok(!before.pass, 'BEFORE: the replay-binding chain passed on the unbound bodies');
  assert.match(before.fail, /SMOKE_FAIL: void_payment replayed another payment's receipt as success for payment 2/, `BEFORE: wrong first failure: ${before.fail}`);
  console.log(`[prover] BEFORE: the chain fails first at step 1: ${before.fail}`);
  const passedBefore = covering('BEFORE');
  // reverse_write_off's own role test is NULL for a deactivated admin, so today it lets the call
  // through to the write-off lookup.
  const beforeGate = deactivatedAdminReverse();
  assert.match(beforeGate, /Write-off not found/, `BEFORE: a deactivated admin was stopped before the lookup: ${beforeGate}`);
  console.log(`[prover] BEFORE: a deactivated admin gets past reverse_write_off's role test: ${beforeGate}`);

  // 2. AUTOCOMMIT and PREFLIGHT.
  stageText('candidate.sql', lf(CANDIDATE));
  const auto = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(auto.status, 0, 'AUTOCOMMIT: the candidate ran outside one transaction');
  assert.match(auto.stderr, /MONEY_REPLAY_BINDING_NOT_IN_TRANSACTION/, `AUTOCOMMIT: wrong refusal:\n${auto.stderr}`);
  const drift = docker([...psqlArgs()], {
    input: `BEGIN;
CREATE OR REPLACE FUNCTION public.void_payment(p_allocation_set_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN NULL; END; $$;
\\i /tmp/candidate.sql
ROLLBACK;`,
    allowFailure: true,
  });
  assert.notEqual(drift.status, 0, 'PREFLIGHT: the candidate applied over a drifted body');
  assert.match(drift.stderr, /PREFLIGHT_MONEY_REPLAY_BODY_DRIFT: [^\n]*void_payment/, `PREFLIGHT: wrong refusal:\n${drift.stderr}`);
  assert.equal(scalar("SELECT count(*) FROM pg_proc WHERE proname LIKE '%_replay_impl_20261015' OR proname LIKE '%replay%20261015';"), '0', 'a refused apply left a change behind');
  // An unexpired receipt for one of the nine operations (an old body's, unbound) blocks the apply.
  const pending = docker([...psqlArgs()], {
    input: `BEGIN;
INSERT INTO public.idempotency_keys (idempotency_key, operation, result) VALUES ('prover-pending-receipt', 'void_payment', to_jsonb(gen_random_uuid()));
\\i /tmp/candidate.sql
ROLLBACK;`,
    allowFailure: true,
  });
  assert.notEqual(pending.status, 0, 'PREFLIGHT: the candidate applied with an unexpired receipt for a wrapped operation');
  assert.match(pending.stderr, /PREFLIGHT_UNEXPIRED_RECEIPTS/, `PREFLIGHT: wrong refusal for a pending receipt:\n${pending.stderr}`);
  console.log('[prover] AUTOCOMMIT + PREFLIGHT: outside one transaction, over a drifted body, or with an unexpired receipt for a wrapped operation, the candidate stops before any change');

  // 3. APPLY.
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.match(a.output, /POSTFLIGHT_OK/, `the postflight did not report OK:\n${a.output}`);
  console.log('[prover] candidate applied; POSTFLIGHT_OK');

  // 4. AFTER.
  const seqBefore = sequences();
  const after = chain(CHAIN);
  assert.ok(after.pass, `AFTER: the replay-binding chain failed: ${after.fail}`);
  const moved = movedSequences(seqBefore, sequences());
  const docNumbers = documentNumberSequences();
  assert.ok(docNumbers.size > 0, 'AFTER: no document-number sequence was found to check');
  const movedDoc = moved.filter((s) => docNumbers.has(s));
  assert.deepEqual(movedDoc, [], `AFTER: the chain consumed a document-number sequence value, so it is not safe to run against live: ${movedDoc.join(', ')}`);
  console.log(`[prover] AFTER: the chain passes, rolls back, and moves no document-number sequence (${docNumbers.size} checked; surrogate id sequences moved: ${moved.join(', ') || 'none'})`);
  covering('AFTER', passedBefore);
  const afterGate = deactivatedAdminReverse();
  assert.match(afterGate, /Admin access required to reverse write-offs/, `AFTER: a deactivated admin was not refused: ${afterGate}`);
  const guard = unboundReceipt();
  assert.match(guard, /REPLAY_RECEIPT_UNBOUND/, `AFTER: an unbound receipt for a wrapped operation was not refused at commit: ${guard}`);
  const autocommit = docker([...psqlArgs()], {
    input: "INSERT INTO public.idempotency_keys (idempotency_key, operation, result) VALUES ('prover-unbound-autocommit', 'apply_write_off', '{\"id\":\"x\"}'::jsonb);",
    allowFailure: true,
  });
  assert.match(autocommit.stderr, /REPLAY_RECEIPT_UNBOUND/, `AFTER: an autocommit unbound receipt was not refused:\n${autocommit.stderr}`);
  assert.equal(scalar("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = 'prover-unbound-autocommit';"), '0', 'AFTER: the refused unbound receipt was committed');
  // An UPDATE that strips the binding from a bound receipt is refused at commit too.
  const stripped = docker([...psqlArgs()], {
    input: `BEGIN;
INSERT INTO public.idempotency_keys (idempotency_key, operation, result, request_actor_id, request_fingerprint)
VALUES ('prover-strip-binding', 'apply_write_off', '{"id":"x"}'::jsonb, '${U.ADMIN}', repeat('a', 64));
SET CONSTRAINTS ALL IMMEDIATE;
UPDATE public.idempotency_keys SET request_actor_id = NULL WHERE idempotency_key = 'prover-strip-binding';
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'STRIPPED_RECEIPT_ACCEPTED';
ROLLBACK;`,
    allowFailure: true,
  });
  const strippedOut = `${stripped.stdout}\n${stripped.stderr}`;
  assert.ok(!/STRIPPED_RECEIPT_ACCEPTED/.test(strippedOut) && /REPLAY_RECEIPT_UNBOUND/.test(strippedOut),
    `AFTER: an UPDATE that stripped a receipt's binding was not refused:\n${strippedOut.slice(-400)}`);
  // At a COMMIT made under the authenticated role (the guard runs with that role on PostgreSQL 17).
  const asAuth = unboundReceiptCommittedAsAuthenticated();
  assert.ok(asAuth.refused && asAuth.committed === '0',
    `AFTER: an unbound receipt committed under the authenticated role was not refused: ${JSON.stringify(asAuth)}`);
  // The same, left to the real COMMIT (no SET CONSTRAINTS): the deferred guard fires there and the
  // whole transaction, receipt included, is rolled back.
  const strippedAtCommit = docker([...psqlArgs()], {
    input: `BEGIN;
INSERT INTO public.idempotency_keys (idempotency_key, operation, result, request_actor_id, request_fingerprint)
VALUES ('prover-strip-binding-at-commit', 'apply_write_off', '{"id":"x"}'::jsonb, '${U.ADMIN}', repeat('a', 64));
UPDATE public.idempotency_keys SET request_actor_id = NULL WHERE idempotency_key = 'prover-strip-binding-at-commit';
COMMIT;`,
    allowFailure: true,
  });
  assert.match(`${strippedAtCommit.stdout}\n${strippedAtCommit.stderr}`, /REPLAY_RECEIPT_UNBOUND/,
    `AFTER: COMMIT of a stripped receipt was not refused:\n${strippedAtCommit.stderr}`);
  assert.equal(scalar("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = 'prover-strip-binding-at-commit';"), '0',
    'AFTER: the stripped receipt was committed');
  console.log('[prover] AFTER: a deactivated admin is refused by reverse_write_off, and an unbound receipt for a wrapped operation never commits (inserted, or stripped by an UPDATE, checked both immediately and at a real COMMIT)');

  // 5. RE-APPLY.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /PREFLIGHT_MONEY_REPLAY_BODY_DRIFT/, `second apply refused for the wrong reason:\n${again.output}`);
  console.log('[prover] RE-APPLY: refused by the preflight, nothing changed');

  // 6. MUTATION: each fingerprint field and the binder are what their chain step proves.
  const mutations = [
    ['void_payment target', 'void_payment', "    'allocation_set_id', p_allocation_set_id,\n", '',
      /SMOKE_FAIL: void_payment replayed another payment's receipt/],
    ['void_payment reason', 'void_payment', ",\n    'reason', p_reason\n", '\n',
      /SMOKE_FAIL: void_payment replayed a receipt for a changed reason/],
    ['delete_prepay_credit target', 'delete_prepay_credit', "    'credit_id', p_credit_id,\n", '',
      /SMOKE_FAIL: delete_prepay_credit replayed another credit's receipt/],
    ['edit_prepay_credit new balance', 'edit_prepay_credit', "    'new_balance_cents', p_new_balance_cents,\n", '',
      /SMOKE_FAIL: edit_prepay_credit replayed a receipt for a different balance/],
    ['apply_write_off target', 'apply_write_off', "    'invoice_id', p_invoice_id,\n", '',
      /SMOKE_FAIL: apply_write_off replayed invoice 2's write-off/],
    ['reverse_write_off target', 'reverse_write_off', "    'write_off_id', p_write_off_id,\n", '',
      /SMOKE_FAIL: reverse_write_off replayed write-off 1's reversal/],
    ['apply_prepay_to_invoice target', 'apply_prepay_to_invoice', "    'invoice_id', p_invoice_id,\n", '',
      /SMOKE_FAIL: apply_prepay_to_invoice replayed invoice 4's application/],
    ['create_prepay_check_splits reference', 'create_prepay_check_splits', "    'reference_number', p_reference_number,\n", '',
      /SMOKE_FAIL: create_prepay_check_splits replayed check 1's credits/],
    ['batch_apply_prepayments allocations', 'batch_apply_prepayments', ",\n    'allocations', p_allocations\n", '\n',
      /SMOKE_FAIL: batch_apply_prepayments replayed batch 1's applications/],
    ['batch_void_invoices invoice set', 'batch_void_invoices',
      "    'invoice_ids', to_jsonb(ARRAY(SELECT DISTINCT u.id FROM unnest(p_invoice_ids) AS u(id) ORDER BY u.id)),\n", '',
      /SMOKE_FAIL: batch_void_invoices replayed batch 1's count/],
    // The set-normalization: hashing the ids in the order sent refuses the same set reordered.
    ['batch_void_invoices set normalization', 'batch_void_invoices',
      'to_jsonb(ARRAY(SELECT DISTINCT u.id FROM unnest(p_invoice_ids) AS u(id) ORDER BY u.id))', 'to_jsonb(p_invoice_ids)',
      /SMOKE_FAIL: wrong batch_void_invoices refusal: IDEMPOTENCY_INTENT_MISMATCH|ERROR:  IDEMPOTENCY_INTENT_MISMATCH/],
    // The key requirement, and the batch marker that lets only the batch path call apply_prepay
    // without a key.
    ['apply_write_off key requirement', 'apply_write_off',
      "    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: apply_write_off requires p_idempotency_key' USING ERRCODE = '22023';\n",
      "    RETURN public._apply_write_off_replay_impl_20261015(p_invoice_id, p_amount_cents, p_reason, p_performed_by, NULL);\n",
      /SMOKE_FAIL: apply_write_off ran without an idempotency key/],
    ['batch prepay marker', 'batch_apply_prepayments',
      "  PERFORM set_config('crx.batch_apply_prepayments_internal', '1', true);\n", '',
      /IDEMPOTENCY_KEY_REQUIRED: apply_prepay_to_invoice requires p_idempotency_key/],
    // The binder: a receipt left unbound is a legacy receipt, so even the exact retry is refused.
    ['receipt binder stamp', '_bind_replay_receipt_20261015',
      '     SET request_actor_id = v_actor,\n         request_fingerprint = p_fingerprint\n',
      '     SET request_actor_id = NULL,\n         request_fingerprint = NULL\n',
      /IDEMPOTENCY_INTENT_MISMATCH/],
    // The binder's actor: stamping someone else's id makes the author's own exact retry refused.
    ['receipt binder actor', '_bind_replay_receipt_20261015',
      '     SET request_actor_id = v_actor,\n', "     SET request_actor_id = '00000000-0000-0000-0000-000000000000'::uuid,\n",
      /IDEMPOTENCY_ACTOR_MISMATCH/],
  ];
  for (const [label, fn, find, replacement, expected] of mutations) {
    const r = chain(CHAIN, mutate(fn, find, replacement, label));
    assert.ok(!r.pass, `MUTATION ${label}: the chain still passed without the hunk`);
    assert.match(r.fail, expected, `MUTATION ${label}: wrong failure: ${r.fail}`);
    console.log(`[prover] MUTATION: without the ${label} hunk the chain fails: ${r.fail}`);
  }

  // The active-admin gate and the commit-time guard, each removed in turn.
  const noGate = deactivatedAdminReverse(mutate('reverse_write_off',
    "  IF NOT public.is_admin() THEN\n    RAISE EXCEPTION 'Admin access required to reverse write-offs';\n  END IF;\n", '', 'reverse_write_off admin gate'));
  assert.match(noGate, /Write-off not found/, `MUTATION reverse_write_off admin gate: a deactivated admin was still refused: ${noGate}`);
  console.log(`[prover] MUTATION: without the reverse_write_off admin gate a deactivated admin gets through: ${noGate}`);
  const noGuard = unboundReceipt(mutate('_require_bound_replay_receipt_20261015',
    "    RAISE EXCEPTION 'REPLAY_RECEIPT_UNBOUND'\n", "    RAISE NOTICE 'REPLAY_RECEIPT_UNBOUND'\n", 'commit-time guard'));
  assert.equal(noGuard, 'accepted', `MUTATION commit-time guard: the unbound receipt was still refused: ${noGuard}`);
  console.log('[prover] MUTATION: without the commit-time guard an unbound receipt is accepted');
  // Without SECURITY DEFINER the guard is blind under the authenticated role at COMMIT. The
  // mutation is committed (as a function replace) and restored right after.
  const guardDef = candidateBody('_require_bound_replay_receipt_20261015');
  const invoker = `${guardDef.header.replace('SECURITY DEFINER\n', '')}${guardDef.body}${guardDef.tag};`;
  assert.notEqual(invoker, `${guardDef.header}${guardDef.body}${guardDef.tag};`, 'MUTATION guard SECURITY DEFINER: hunk not found');
  const blind = unboundReceiptCommittedAsAuthenticated(invoker);
  psql(`${guardDef.header}${guardDef.body}${guardDef.tag};`);
  assert.ok(!blind.refused && blind.committed === '1',
    `MUTATION guard SECURITY DEFINER: an invoker guard still refused the receipt: ${JSON.stringify(blind)}`);
  console.log('[prover] MUTATION: without SECURITY DEFINER the guard lets an unbound receipt commit under the authenticated role');

  console.log('MONEY_REPLAY_BINDING_BATCH1_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
