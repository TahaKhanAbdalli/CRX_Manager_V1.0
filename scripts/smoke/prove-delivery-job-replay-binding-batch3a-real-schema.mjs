#!/usr/bin/env node
/**
 * Full-chain proof for the 20261019200000 candidate: complete_delivery and complete_job replay a
 * stored idempotency receipt only for the same person and the exact same request (batch 3a of the
 * replay-binding fix, KNOWN_ISSUES.md).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers; batches 1 and 2, 20261016060000 and 20261016140000,
 * are replayed, so the commit-time guard is in its batch-1+2 state, as on live since ledger
 * 20261019010324), then:
 *   0. FIDELITY: every body the candidate's preflight pins replayed with its pinned md5;
 *   1. BEFORE: the new chain fails first at step a (complete_delivery hands delivery A's receipt
 *      back as success for delivery B), and every covering chain that passes is recorded;
 *   2. AUTOCOMMIT: run statement by statement (psql -f, no -1) the file stops at its preflight;
 *      PREFLIGHT: a drifted complete_delivery body, an unexpired complete_job receipt, and an unknown
 *      commit-time guard list each abort the candidate before any change;
 *   3. BATCH-1-ONLY GUARD: in a rolled-back transaction, with the guard drifted back to the batch-1
 *      literal while batch 2's wrappers stay installed, the candidate refuses
 *      (PREFLIGHT_RECEIPT_GUARD_DRIFT) and changes nothing;
 *   4. APPLY (batch-1+2 state, committed): POSTFLIGHT_OK, the guard lists 9 + 13 + 2;
 *   5. AFTER: the new chain passes and rolls back (the sequences it moved are reported: completing
 *      a delivery on an order draws an invoice number, so the chain is CONTAINER ONLY), every
 *      covering chain that passed BEFORE still passes, and an unbound complete_delivery /
 *      complete_job receipt never commits;
 *   6. RE-APPLY: refused by the preflight's own pins;
 *   7. MUTATION: with each wrapper's target or payload taken out of its fingerprint, the epoch
 *      normalization removed, or the key requirement replaced by a keyless pass-through, the new
 *      chain fails at the step that proves it.
 *
 * Run: node scripts/smoke/prove-delivery-job-replay-binding-batch3a-real-schema.mjs   (needs Docker)
 * Prints DELIVERY_JOB_REPLAY_BINDING_BATCH3A_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-delivery-job-replay-batch3a-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261019200000_bind_delivery_job_replay_receipts_batch3a.sql');
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
const CHAIN = path.join(SMOKE, 'smoke-delivery-job-replay-binding-batch3a.sql');
const SPECS = path.join(SMOKE, 'smoke-specs.json');
// Every other non-container chain that completes a delivery or a job. Each must keep passing after
// the candidate if it passed before it (some need live data this database lacks; those are
// reported, not required).
const COVERING_CHAINS = [
  'smoke-offline-action-receipts.sql',
  'smoke-delivery-accounting-period-guard.sql',
  'smoke-financial-scope-and-delivery-aggregate.sql',
  'smoke-field-invoice-loop.sql',
  'smoke-return-credit-chain.sql',
];
const WRAPPED = ['complete_delivery', 'complete_job'];
const IMPLS = WRAPPED.map((n) => `_${n}_replay_impl_20261015`);
const GUARD = 'require_bound_replay_receipt_20261015';

const id = (n) => `7b630000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), ADMIN_B: id('a2'), REP: id('b1'), APPLICATOR: id('c1') };

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
  const touched = new RegExp([...WRAPPED, 'process_offline_action', 'idempotency_keys'].join('|'));
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!touched.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
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
// FIDELITY: the md5 pins the candidate's preflight checks, read from the candidate file itself.
function md5Of(name) {
  return scalar(`SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${name}';`);
}
function fidelity() {
  const sql = lf(CANDIDATE).split('$preflight$')[1];
  const pins = [...sql.matchAll(/\('([a-z_]+)', '[^']*', '[a-z]+', '([0-9a-f]{32})'\)/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(pins.map(([n]) => n).sort(), [...WRAPPED].sort(), 'the preflight pins exactly the two wrapped bodies');
  for (const fn of ['process_offline_action', 'check_idempotency_intent']) {
    const m = new RegExp(`p\\.proname = '${fn}'[\\s\\S]*?= '([0-9a-f]{32})'`).exec(sql);
    assert.ok(m, `the preflight pins ${fn}`);
    pins.push([fn, m[1]]);
  }
  for (const [name, pin] of pins) assert.equal(md5Of(name), pin, `${name} replayed with a body that differs from the live pin`);
  const helpers = [...sql.matchAll(/\('(public\.[a-z_0-9]+\([a-z,]*\))', '([0-9a-f]{32})', (true|false)\)/g)];
  assert.equal(helpers.length, 3, 'the preflight pins the three batch-1 helpers');
  for (const [, sig, pin] of helpers) {
    assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${sig}');`), pin, `${sig} replayed with a body that differs from the live pin`);
  }
  const auth = /'cdef18c69c4f4cbbced2eaf81e628b49'/.test(sql);
  assert.ok(auth, 'the preflight pins auth.uid()');
  console.log(`[prover] FIDELITY: all ${pins.length + helpers.length + 1} pinned bodies (${[...pins.map(([n]) => n), ...helpers.map((h) => h[1]), 'auth.uid()'].join(', ')}) match the pins`);
}

// ------------------------------------------------------------------------------------------------
function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.ADMIN_B, 'admin', 'Admin B', 8], [U.REP, 'sales_rep', 'Rep', 7], [U.APPLICATOR, 'applicator', 'Applicator', 6]];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'replay-batch3a-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7b630000-%';`),
    'admin:true,admin:true,sales_rep:true,applicator:true', 'the seeded roles are not what the proof needs');
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
// document-number sequence (invoice, payment, credit-memo numbers) moving leaves a visible gap on
// live, which is why this chain is CONTAINER ONLY.
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
                              AND p.proname ~ '^next_.*_number$')
                OR EXISTS (SELECT 1 FROM pg_proc p
                            WHERE p.proname ~ '^next_.*_number$'
                              AND p.prosrc ILIKE '%' || s.sequencename || '%');`,
  }).stdout.trim().split(/\r?\n/).filter(Boolean));
}

/** The guard's covered operations, in trigger order (read inside `sql`'s transaction when given). */
function guardOpsSql() {
  return `SELECT 'GUARD_OPS=' || coalesce(string_agg(m[1], ',' ORDER BY ord), '')
      FROM pg_trigger t,
           regexp_matches(pg_get_triggerdef(t.oid), '''([a-z_]+)''::text', 'g') WITH ORDINALITY AS r(m, ord)
     WHERE t.tgrelid = 'public.idempotency_keys'::regclass AND t.tgname = '${GUARD}';`;
}
function guardOps(out) {
  const m = /GUARD_OPS=([a-z_,]*)/.exec(out ?? scalar(guardOpsSql()));
  assert.ok(m, `could not read the guard's operation list: ${out}`);
  return m[1] ? m[1].split(',') : [];
}
function guardArrays() {
  const block = lf(CANDIDATE).split('$guard$')[1];
  const arr = (name) => {
    const m = new RegExp(`${name} constant text\\[\\] := ARRAY\\[([\\s\\S]*?)\\];`).exec(block);
    assert.ok(m, `the candidate's $guard$ block declares ${name}`);
    return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  };
  return { batch1: arr('v_batch1'), batch2: arr('v_batch2'), batch3a: arr('v_batch3a') };
}
function recreateGuardSql(ops) {
  return `DROP TRIGGER ${GUARD} ON public.idempotency_keys;
CREATE CONSTRAINT TRIGGER ${GUARD} AFTER INSERT OR UPDATE ON public.idempotency_keys
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.operation IN (${ops.map((o) => `'${o}'`).join(', ')}))
  EXECUTE FUNCTION public._require_bound_replay_receipt_20261015();`;
}
/** Nothing of the candidate is left behind after a refused apply. */
function assertUntouched(phase, guardBefore) {
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname IN (${IMPLS.map((n) => `'${n}'`).join(', ')});`), '0', `${phase}: a refused apply left a renamed body behind`);
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname IN (${WRAPPED.map((n) => `'${n}'`).join(', ')}) AND prosrc LIKE '%check_idempotency_intent%';`), '0', `${phase}: a refused apply left a wrapper behind`);
  const pins = [...lf(CANDIDATE).split('$preflight$')[1].matchAll(/\('([a-z_]+)', '[^']*', '[a-z]+', '([0-9a-f]{32})'\)/g)];
  for (const [, fn, pin] of pins) assert.equal(md5Of(fn), pin, `${phase}: ${fn} is no longer the pinned body`);
  assert.deepEqual(guardOps(), guardBefore, `${phase}: a refused apply changed the commit-time guard`);
}

/** Insert an unbound receipt for `op` and force the deferred guard to run now. */
function unboundReceipt(op) {
  const r = docker([...psqlArgs()], {
    input: `BEGIN;
INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
VALUES ('prover-unbound-' || gen_random_uuid(), '${op}', '{"delivery_id":"x"}'::jsonb);
SET CONSTRAINTS ALL IMMEDIATE;
SELECT 'UNBOUND_RECEIPT_ACCEPTED';
ROLLBACK;`,
    allowFailure: true,
  });
  const out = `${r.stdout}\n${r.stderr}`;
  return /UNBOUND_RECEIPT_ACCEPTED/.test(out) ? 'accepted' : (/ERROR:[^\n]*/.exec(out)?.[0] ?? out.trim().slice(-300));
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
  const { batch1, batch2, batch3a } = guardArrays();
  assert.equal(batch1.length, 9, 'the candidate lists the nine batch-1 operations');
  assert.equal(batch2.length, 13, 'the candidate lists the thirteen batch-2 operations');
  assert.deepEqual(batch3a, WRAPPED, 'the candidate adds exactly complete_delivery and complete_job');
  const guardBefore = guardOps();
  assert.deepEqual(guardBefore, [...batch1, ...batch2], 'the replayed database is not in the batch-1+2 guard state');

  // 1. BEFORE.
  const before = chain(CHAIN);
  assert.ok(!before.pass, 'BEFORE: the replay-binding chain passed on the unbound bodies');
  assert.match(before.fail, /SMOKE_FAIL: complete_delivery replayed delivery A's receipt as success for delivery B/, `BEFORE: wrong first failure: ${before.fail}`);
  console.log(`[prover] BEFORE: the chain fails first at step a: ${before.fail}`);
  const passedBefore = covering('BEFORE');

  // 2. AUTOCOMMIT and PREFLIGHT.
  stageText('candidate.sql', lf(CANDIDATE));
  const auto = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(auto.status, 0, 'AUTOCOMMIT: the candidate ran outside one transaction');
  assert.match(auto.stderr, /DELIVERY_JOB_REPLAY_BINDING_NOT_IN_TRANSACTION/, `AUTOCOMMIT: wrong refusal:\n${auto.stderr}`);
  assertUntouched('AUTOCOMMIT', guardBefore);
  const drift = docker([...psqlArgs()], {
    input: `BEGIN;
CREATE OR REPLACE FUNCTION public.complete_delivery(p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN NULL; END; $$;
\\i /tmp/candidate.sql
ROLLBACK;`,
    allowFailure: true,
  });
  assert.notEqual(drift.status, 0, 'PREFLIGHT: the candidate applied over a drifted body');
  assert.match(drift.stderr, /PREFLIGHT_DELIVERY_JOB_REPLAY_BODY_DRIFT: [^\n]*complete_delivery/, `PREFLIGHT: wrong refusal:\n${drift.stderr}`);
  assertUntouched('PREFLIGHT drift', guardBefore);
  // An unexpired receipt for one of the two operations (an old body's, unbound) blocks the apply.
  const pending = docker([...psqlArgs()], {
    input: `BEGIN;
INSERT INTO public.idempotency_keys (idempotency_key, operation, result) VALUES ('prover-pending-receipt', 'complete_job', '{"job_id":"x"}'::jsonb);
\\i /tmp/candidate.sql
ROLLBACK;`,
    allowFailure: true,
  });
  assert.notEqual(pending.status, 0, 'PREFLIGHT: the candidate applied with an unexpired complete_job receipt');
  assert.match(pending.stderr, /PREFLIGHT_UNEXPIRED_RECEIPTS/, `PREFLIGHT: wrong refusal for a pending receipt:\n${pending.stderr}`);
  assertUntouched('PREFLIGHT pending receipt', guardBefore);
  assert.equal(scalar("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = 'prover-pending-receipt';"), '0', 'PREFLIGHT: the pending receipt fixture was left behind');
  // A guard covering neither reviewed list (batch 1 plus one stray operation) is refused.
  const unknownGuard = docker([...psqlArgs()], {
    input: `BEGIN;
${recreateGuardSql([...batch1, 'void_order'])}
\\i /tmp/candidate.sql
ROLLBACK;`,
    allowFailure: true,
  });
  assert.notEqual(unknownGuard.status, 0, 'PREFLIGHT: the candidate applied over an unknown guard list');
  assert.match(unknownGuard.stderr, /PREFLIGHT_RECEIPT_GUARD_DRIFT/, `PREFLIGHT: wrong refusal for an unknown guard list:\n${unknownGuard.stderr}`);
  assertUntouched('PREFLIGHT guard drift', guardBefore);
  console.log('[prover] AUTOCOMMIT + PREFLIGHT: outside one transaction, over a drifted complete_delivery body, with an unexpired complete_job receipt, or over an unknown guard list, the candidate stops and leaves nothing behind');

  // 3. BATCH-1-ONLY GUARD (rolled back): with batch 2's wrappers installed, a guard drifted back to
  // the batch-1 literal is refused, never rebuilt without the thirteen batch-2 operations.
  const b1 = docker([...psqlArgs()], {
    input: `BEGIN;
${recreateGuardSql(batch1)}
\\i /tmp/candidate.sql
ROLLBACK;`,
    allowFailure: true,
  });
  assert.notEqual(b1.status, 0, 'BATCH-1-ONLY GUARD: the candidate applied over a batch-1-only guard');
  assert.match(b1.stderr, /PREFLIGHT_RECEIPT_GUARD_DRIFT: [^\n]*is not the batch-1\+2 trigger/, `BATCH-1-ONLY GUARD: wrong refusal:\n${b1.stderr}`);
  assertUntouched('BATCH-1-ONLY GUARD rollback', guardBefore);
  console.log('[prover] BATCH-1-ONLY GUARD: a guard drifted back to the batch-1 literal is refused (PREFLIGHT_RECEIPT_GUARD_DRIFT) and nothing changes');

  // 4. APPLY (batch-1+2 state, as on live; committed).
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.match(a.output, /POSTFLIGHT_OK/, `the postflight did not report OK:\n${a.output}`);
  assert.deepEqual(guardOps(), [...batch1, ...batch2, ...batch3a], 'APPLY: the guard does not list 9 + 13 + 2 operations in order');
  console.log(`[prover] candidate applied; POSTFLIGHT_OK; the guard lists ${batch1.length} + ${batch2.length} + ${batch3a.length} operations: ${guardOps().join(', ')}`);

  // 5. AFTER.
  const seqBefore = sequences();
  const after = chain(CHAIN);
  assert.ok(after.pass, `AFTER: the replay-binding chain failed: ${after.fail}`);
  const moved = movedSequences(seqBefore, sequences());
  const docNumbers = documentNumberSequences();
  assert.ok(docNumbers.size > 0, 'AFTER: no document-number sequence was found to check');
  const movedDoc = moved.filter((s) => docNumbers.has(s));
  const spec = JSON.parse(readFileSync(SPECS, 'utf8')).specs.delivery_job_replay_binding_batch3a;
  assert.ok(spec && spec.chain === path.basename(CHAIN), 'smoke-specs.json has no entry for the chain');
  if (movedDoc.length) {
    assert.equal(spec.container_only, true, `AFTER: the chain drew document numbers (${movedDoc.join(', ')}) but its spec is not marked container_only`);
    assert.match(spec.description, /^CONTAINER ONLY/, 'AFTER: the spec description must start with CONTAINER ONLY');
  }
  console.log(`[prover] AFTER: the chain passes and rolls back; document-number sequences moved: ${movedDoc.join(', ') || 'none'} (${docNumbers.size} checked; CONTAINER ONLY); all sequences moved: ${moved.join(', ') || 'none'}`);
  covering('AFTER', passedBefore);
  for (const op of WRAPPED) {
    const guard = unboundReceipt(op);
    assert.match(guard, /REPLAY_RECEIPT_UNBOUND/, `AFTER: an unbound ${op} receipt was not refused at commit: ${guard}`);
  }
  const autocommit = docker([...psqlArgs()], {
    input: "INSERT INTO public.idempotency_keys (idempotency_key, operation, result) VALUES ('prover-unbound-autocommit', 'complete_delivery', '{\"delivery_id\":\"x\"}'::jsonb);",
    allowFailure: true,
  });
  assert.match(autocommit.stderr, /REPLAY_RECEIPT_UNBOUND/, `AFTER: an autocommit unbound complete_delivery receipt was not refused:\n${autocommit.stderr}`);
  assert.equal(scalar("SELECT count(*) FROM public.idempotency_keys WHERE idempotency_key = 'prover-unbound-autocommit';"), '0', 'AFTER: the refused unbound receipt was committed');
  // A batch-1 and a batch-2 operation are still covered.
  assert.match(unboundReceipt('void_payment'), /REPLAY_RECEIPT_UNBOUND/, 'AFTER: the guard no longer covers a batch-1 operation');
  assert.match(unboundReceipt('release_inventory_hold'), /REPLAY_RECEIPT_UNBOUND/, 'AFTER: the guard no longer covers a batch-2 operation');
  console.log('[prover] AFTER: an unbound complete_delivery or complete_job receipt never commits (immediate check and an autocommit INSERT), and batch-1 and batch-2 operations stay covered');

  // 6. RE-APPLY.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /PREFLIGHT_DELIVERY_JOB_REPLAY_BODY_DRIFT/, `second apply refused for the wrong reason:\n${again.output}`);
  assert.deepEqual(guardOps(), [...batch1, ...batch2, ...batch3a], 'RE-APPLY: the refused second apply changed the guard');
  console.log('[prover] RE-APPLY: refused by the preflight, nothing changed');

  // 7. MUTATION: each fingerprint field, the epoch normalization and the key requirement are what
  // their chain step proves.
  const mutations = [
    ['complete_delivery target', 'complete_delivery', "    'delivery_id', p_delivery_id,\n", '',
      /SMOKE_FAIL: complete_delivery replayed delivery A's receipt as success for delivery B/],
    ['complete_delivery quantities', 'complete_delivery', "    'quantities', p_quantities,\n", '',
      /SMOKE_FAIL: complete_delivery replayed a receipt for edited quantities/],
    ['complete_delivery signer', 'complete_delivery', "    'signed_by', p_signed_by,\n", '',
      /SMOKE_FAIL: complete_delivery replayed a receipt for an edited signer/],
    ['complete_delivery epoch normalization', 'complete_delivery', 'extract(epoch FROM p_completed_at)', 'p_completed_at',
      /SMOKE_FAIL: complete_delivery refused the same completed_at instant under another session TimeZone/],
    ['complete_delivery key requirement', 'complete_delivery',
      "    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: complete_delivery requires p_idempotency_key' USING ERRCODE = '22023';\n",
      '    RETURN public._complete_delivery_replay_impl_20261015(p_delivery_id, p_signed_by, p_performed_by, p_quantities, p_issue_type, p_issue_notes, NULL, p_completed_at);\n',
      /SMOKE_FAIL: complete_delivery ran without an idempotency key/],
    ['complete_job target', 'complete_job', "    'job_id', p_job_id,\n", '',
      /SMOKE_FAIL: complete_job replayed job A's receipt as success for job B/],
    ['complete_job applied info', 'complete_job', ",\n    'applied_info', p_applied_info\n", '\n',
      /SMOKE_FAIL: complete_job replayed a receipt for edited applied info/],
  ];
  for (const [label, fn, find, replacement, expected] of mutations) {
    const r = chain(CHAIN, mutate(fn, find, replacement, label));
    assert.ok(!r.pass, `MUTATION ${label}: the chain still passed without the hunk`);
    assert.match(r.fail, expected, `MUTATION ${label}: wrong failure: ${r.fail}`);
    console.log(`[prover] MUTATION: without the ${label} hunk the chain fails: ${r.fail}`);
  }

  console.log('DELIVERY_JOB_REPLAY_BINDING_BATCH3A_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
