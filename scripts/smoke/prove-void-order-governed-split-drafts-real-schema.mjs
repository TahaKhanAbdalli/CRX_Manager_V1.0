#!/usr/bin/env node
/**
 * Full-chain proof for the 20261021030000 candidate: void_order voids a fulfilled order whose draft
 * invoices are GOVERNED split drafts (split_invoice_provenance rows), claiming them the way
 * cancel_order does (KNOWN_ISSUES.md, the open follow-up from replay-binding batch 3b).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers; batch 3b is replayed), then:
 *   0. FIDELITY: every body the candidate's preflight pins replayed with its pinned md5;
 *   1. BEFORE: the new chain fails first at step a (void_order's draft-cancel UPDATE is refused with
 *      SPLIT_INVOICE_PROVENANCE_IMMUTABLE), and every covering chain that passes is recorded;
 *   2. AUTOCOMMIT: run statement by statement (psql -f, no -1) the file stops at its preflight;
 *      PREFLIGHT: a drifted void_order body, a drifted claims CHECK, or a disabled provenance guard
 *      each abort the candidate before any change;
 *   3. APPLY (committed): POSTFLIGHT_OK; void_order keeps its grants;
 *   4. AFTER: the new chain passes and rolls back (the sequences it moved are reported: completing a
 *      delivery draws invoice numbers, so the chain is CONTAINER ONLY), and every covering chain that
 *      passed BEFORE still passes (batch 3b's chain among them);
 *   5. RE-APPLY: refused by the preflight's own pins;
 *   6. MUTATION: with the claim write, the claim operation, the provenance refresh, the refresh check,
 *      or the claim delete taken out of void_order, the new chain fails at the step that proves it.
 *
 * Run: node scripts/smoke/prove-void-order-governed-split-drafts-real-schema.mjs   (needs Docker)
 * Prints VOID_ORDER_GOVERNED_SPLIT_DRAFTS_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-void-order-split-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261021030000_void_order_governed_split_draft_claims.sql');
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
const CHAIN = path.join(SMOKE, 'smoke-void-order-governed-split-drafts.sql');
const SPECS = path.join(SMOKE, 'smoke-specs.json');
// Every other chain that voids or cancels an order or a governed split invoice. Each must keep
// passing after the candidate if it passed before it (some need live data this database lacks;
// those are reported, not required).
const COVERING_CHAINS = [
  'smoke-delivery-order-void-replay-binding-batch3b.sql',
  'smoke-draw-ledger-reversal.sql',
  'smoke-remaining-money-inventory-hardening.sql',
  'smoke-order-invoice-rep-own-name.sql',
  'smoke-return-credit-chain.sql',
];
// What the plan's PARKED check treats as covered by this proof.
const WRAPPED = ['void_order', 'split_invoice_provenance', 'split_invoice_mutation_claims'];
const BATCH_CANCEL = '_void_order_replay_impl_20261015';
const VOID_ORDER_INNER = '_void_order_impl_20260714';
// The preflight's pinned bodies (name, md5), read back from the candidate in fidelity().
const PINNED = ['void_order', '_void_order_replay_impl_20261015', '_void_order_impl_20260714',
  'guard_split_invoice_provenance_identity', '_split_invoice_content_claim'];
const CLAIMS_CHECK = 'split_invoice_mutation_claims_operation_check';

const id = (n) => `7b650000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), ADMIN_B: id('a2'), REP: id('b1'), REP_B: id('b2'), APPLICATOR: id('c1') };

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
  const touched = new RegExp([...WRAPPED, BATCH_CANCEL, VOID_ORDER_INNER].join("|"));
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
function preflightPins() {
  const block = lf(CANDIDATE).split('$preflight$')[1];
  return [...block.matchAll(/\('([a-z_0-9]+)', '(?:[^']|'')*', '([0-9a-f]{32})', /g)].map((m) => [m[1], m[2]]);
}
function fidelity() {
  const pins = preflightPins();
  assert.deepEqual(pins.map(([n]) => n).sort(), [...PINNED].sort(), 'the preflight pins exactly the reviewed bodies');
  for (const [name, pin] of pins) assert.equal(md5Of(name), pin, `${name} replayed with a body that differs from the live pin`);
  console.log(`[prover] FIDELITY: all ${pins.length} pinned bodies (${pins.map(([n]) => n).join(', ')}) match the pins`);
}

// ------------------------------------------------------------------------------------------------
function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.ADMIN_B, 'admin', 'Admin B', 8], [U.REP, 'sales_rep', 'Rep', 7],
    [U.REP_B, 'sales_rep', 'Rep B', 6], [U.APPLICATOR, 'applicator', 'Applicator', 5]];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'void-order-split-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7b650000-%';`),
    'admin:true,admin:true,sales_rep:true,sales_rep:true,applicator:true', 'the seeded roles are not what the proof needs');
}

/** Run a chain file; `prefix` runs first in the same transaction (a mutation). */
function chain(file, prefix = '', user = 'postgres') {
  stageText('chain.sql', lf(file));
  const r = docker([...psqlArgs(user)], { input: `BEGIN;\n${prefix}\n\\i /tmp/chain.sql\nROLLBACK;\n`, allowFailure: true });
  const out = `${r.stdout}\n${r.stderr}`;
  const pass = /SMOKE_PASS_ROLLBACK/.test(out);
  const fail = /SMOKE_FAIL[^\n]*/.exec(out)?.[0] ?? (pass ? '' : (/ERROR:[^\n]*/.exec(out)?.[0] ?? out.trim().slice(-400)));
  const info = /SMOKE_INFO[^\n]*/.exec(out)?.[0] ?? '';
  return { pass, fail, info };
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
function movedSequences(before, after) {
  return [...after.keys()].filter((k) => after.get(k) !== before.get(k));
}
function documentNumberSequences() {
  return new Set(docker([...psqlArgs(), '-A', '-t'], {
    input: `SELECT DISTINCT s.schemaname || '.' || s.sequencename
              FROM pg_sequences s
             WHERE s.sequencename ~ '(number|_no|_num)'
                OR EXISTS (SELECT 1 FROM pg_proc p
                            WHERE p.proname ~ '^next_.*_number$'
                              AND p.prosrc ILIKE '%' || s.sequencename || '%');`,
  }).stdout.trim().split(/\r?\n/).filter(Boolean));
}

function voidOrderAcl() {
  return scalar(`SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END, ',' ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END)
    FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname = 'void_order' AND a.privilege_type = 'EXECUTE';`);
}
/** Nothing of the candidate is left behind after a refused apply. */
function assertUntouched(phase) {
  for (const [fn, pin] of preflightPins()) assert.equal(md5Of(fn), pin, `${phase}: ${fn} is no longer the pinned body`);
  assert.equal(voidOrderAcl(), 'authenticated,postgres,service_role', `${phase}: void_order's grants changed`);
}

function candidateBody(fn) {
  const sql = lf(CANDIDATE);
  const start = sql.search(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION public\\.${fn}\\(`));
  assert.ok(start >= 0, `${fn} is not created by the candidate`);
  const tag = /AS (\$[a-z_]*\$)/.exec(sql.slice(start))[1];
  const a = sql.indexOf(`AS ${tag}`, start) + `AS ${tag}`.length;
  const header = sql.slice(start, a).replace(/^CREATE (?:OR REPLACE )?FUNCTION/, 'CREATE OR REPLACE FUNCTION');
  return { header, body: sql.slice(a, sql.indexOf(`${tag};`, a)), tag };
}
function mutate(fn, find, replacement, label) {
  const { header, body, tag } = candidateBody(fn);
  assert.equal(body.split(find).length - 1, 1, `mutation "${label}": hunk not found exactly once`);
  return `${header}${body.replace(find, replacement)}${tag};`;
}

/** Run the candidate inside a rolled-back transaction after `prefix`; it must refuse with `expected`. */
function refusedAfter(label, prefix, expected) {
  const r = docker([...psqlArgs()], { input: `BEGIN;\n${prefix}\n\\i /tmp/candidate.sql\nROLLBACK;`, allowFailure: true });
  assert.notEqual(r.status, 0, `${label}: the candidate applied`);
  assert.match(r.stderr, expected, `${label}: wrong refusal:\n${r.stderr}`);
  assertUntouched(label);
}

function main() {
  buildContainer();
  fidelity();
  seed();

  // 1. BEFORE.
  const before = chain(CHAIN);
  assert.ok(!before.pass, 'BEFORE: the governed-split void chain passed on the unfixed void_order');
  assert.match(before.fail, /SMOKE_FAIL: void_order could not void a fulfilled order with governed split drafts: SPLIT_INVOICE_PROVENANCE_IMMUTABLE/, `BEFORE: wrong first failure: ${before.fail}`);
  console.log(`[prover] BEFORE: ${before.info}`);
  console.log(`[prover] BEFORE: the chain fails first at step a: ${before.fail}`);
  const passedBefore = covering('BEFORE');

  // 2. AUTOCOMMIT and PREFLIGHT.
  stageText('candidate.sql', lf(CANDIDATE));
  const auto = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(auto.status, 0, 'AUTOCOMMIT: the candidate ran outside one transaction');
  assert.match(auto.stderr, /VOID_ORDER_SPLIT_CLAIMS_NOT_IN_TRANSACTION/, `AUTOCOMMIT: wrong refusal:\n${auto.stderr}`);
  assertUntouched('AUTOCOMMIT');
  refusedAfter('PREFLIGHT void_order drift',
    `${candidateBody('void_order').header}\nBEGIN RETURN NULL; END;\n$function$;`,
    /PREFLIGHT_VOID_ORDER_SPLIT_BODY_DRIFT: [^\n]*void_order/);
  refusedAfter('PREFLIGHT claims CHECK drift',
    `ALTER TABLE public.split_invoice_mutation_claims DROP CONSTRAINT ${CLAIMS_CHECK};
     ALTER TABLE public.split_invoice_mutation_claims ADD CONSTRAINT ${CLAIMS_CHECK} CHECK (operation = ANY (ARRAY['save_invoice'::text, 'delete_invoices'::text, 'void_invoice'::text]));`,
    /PREFLIGHT_SPLIT_CLAIMS_DRIFT/);
  refusedAfter('PREFLIGHT guard disabled',
    'ALTER TABLE public.invoices DISABLE TRIGGER guard_split_invoice_provenance_identity;',
    /PREFLIGHT_SPLIT_GUARD_DRIFT/);
  console.log('[prover] AUTOCOMMIT + PREFLIGHT: outside one transaction, over a drifted void_order body, over a drifted claims CHECK, or with the provenance guard disabled, the candidate stops and leaves nothing behind');

  // 3. APPLY (committed).
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.match(a.output, /POSTFLIGHT_OK/, `the postflight did not report OK:\n${a.output}`);
  assert.equal(voidOrderAcl(), 'authenticated,postgres,service_role', 'APPLY: void_order\'s grants changed');
  for (const api of ['anon', 'authenticated', 'service_role']) {
    for (const fn of ['_void_order_replay_impl_20261015', '_void_order_impl_20260714', '_split_invoice_content_claim']) {
      assert.equal(scalar(`SELECT has_function_privilege('${api}', (SELECT p.oid FROM pg_proc p WHERE p.proname = '${fn}'), 'EXECUTE');`), 'f', `APPLY: ${api} can run ${fn}`);
    }
  }
  // The inner body is the live pin plus only the draft-cancel status and not-deleted lines (CodeRabbit on #967).
  const STATUS_LINE = "      WHERE id = v_invoice.id\n        AND status = 'draft'\n        AND deleted_at IS NULL\n        AND COALESCE(paid_amount_cents, 0) = 0\n";
  const sqlE = (text) => `E'${text.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\n/g, '\\n')}'`;
  assert.equal(md5Of(VOID_ORDER_INNER), '8ad84bdc6a0f8b814575f61a4f615293', `APPLY: ${VOID_ORDER_INNER} is not the reviewed new body`);
  assert.equal(scalar(`SELECT (length(prosrc) - length(replace(prosrc, ${sqlE(STATUS_LINE)}, ''))) / length(${sqlE(STATUS_LINE)}) FROM pg_proc WHERE proname = '${VOID_ORDER_INNER}';`), '1',
    `APPLY: ${VOID_ORDER_INNER} does not carry the status and not-deleted lines on its draft-cancel UPDATE exactly once`);
  assert.equal(scalar(`SELECT md5(replace(replace(prosrc, chr(13), ''), ${sqlE(STATUS_LINE)}, ${sqlE("      WHERE id = v_invoice.id\n        AND COALESCE(paid_amount_cents, 0) = 0\n")})) FROM pg_proc WHERE proname = '${VOID_ORDER_INNER}';`),
    'a2dd87f5ebfffe7a7a328acce66ee528', `APPLY: ${VOID_ORDER_INNER} differs from its live pin by more than the status and not-deleted lines`);
  console.log('[prover] candidate applied; POSTFLIGHT_OK; void_order keeps EXECUTE for authenticated and service_role only; no API role can run the inner bodies; the inner body is its live pin plus only the draft-cancel status and not-deleted lines');

  // 4. AFTER.
  const seqBefore = sequences();
  const after = chain(CHAIN);
  assert.ok(after.pass, `AFTER: the governed-split void chain failed: ${after.fail}`);
  const moved = movedSequences(seqBefore, sequences());
  const docNumbers = documentNumberSequences();
  assert.ok(docNumbers.size > 0, 'AFTER: no document-number sequence was found to check');
  const movedDoc = moved.filter((s) => docNumbers.has(s));
  const spec = JSON.parse(readFileSync(SPECS, 'utf8')).specs.void_order_governed_split_drafts;
  assert.ok(spec && spec.chain === path.basename(CHAIN), 'smoke-specs.json has no entry for the chain');
  if (movedDoc.length) {
    assert.equal(spec.container_only, true, `AFTER: the chain drew document numbers (${movedDoc.join(', ')}) but its spec is not marked container_only`);
    assert.match(spec.description, /^CONTAINER ONLY/, 'AFTER: the spec description must start with CONTAINER ONLY');
  }
  console.log(`[prover] AFTER: ${after.info}`);
  console.log(`[prover] AFTER: the chain passes and rolls back; document-number sequences moved: ${movedDoc.join(', ') || 'none'} (${docNumbers.size} checked; CONTAINER ONLY); all sequences moved: ${moved.join(', ') || 'none'}`);
  covering('AFTER', passedBefore);
  assert.equal(scalar('SELECT count(*) FROM public.split_invoice_mutation_claims;'), '0', 'AFTER: a claim row survived a rolled-back chain');

  // 5. RE-APPLY.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /PREFLIGHT_VOID_ORDER_SPLIT_BODY_DRIFT: [^\n]*void_order/, `second apply refused for the wrong reason:\n${again.output}`);
  console.log('[prover] RE-APPLY: refused by the preflight, nothing changed');

  // 6. MUTATION: each part of the new void_order is what its chain step proves.
  const claimWrite = "    INSERT INTO public.split_invoice_mutation_claims (transaction_id, invoice_id, operation)\n    SELECT pg_current_xact_id(), governed.invoice_id, 'cancel_order'\n      FROM unnest(v_governed_ids) AS governed(invoice_id);\n";
  const refresh = /    UPDATE public\.split_invoice_provenance p\n[\s\S]*?       AND i\.status = 'cancelled';\n/.exec(candidateBody('void_order').body)?.[0];
  assert.ok(refresh, 'the provenance refresh hunk was not found');
  const check = /    IF EXISTS \(\n      SELECT 1\n        FROM unnest\(v_governed_ids\)[\s\S]*?SPLIT_INVOICE_VOID_ORDER_PROVENANCE_REFRESH_FAILED';\n    END IF;\n/.exec(candidateBody('void_order').body)?.[0];
  assert.ok(check, 'the refresh check hunk was not found');
  const claimDelete = /    DELETE FROM public\.split_invoice_mutation_claims claim\n[\s\S]*?SPLIT_INVOICE_VOID_ORDER_CLAIM_LOST';\n    END IF;\n/.exec(candidateBody('void_order').body)?.[0];
  assert.ok(claimDelete, 'the claim delete hunk was not found');
  const mutations = [
    ['claim write', claimWrite, '',
      /SMOKE_FAIL: void_order could not void a fulfilled order with governed split drafts: SPLIT_INVOICE_PROVENANCE_IMMUTABLE/],
    ['claim operation', "governed.invoice_id, 'cancel_order'\n", "governed.invoice_id, 'void_invoice'\n",
      /SMOKE_FAIL: void_order could not void a fulfilled order with governed split drafts: SPLIT_INVOICE_PROVENANCE_IMMUTABLE/],
    ['provenance refresh', refresh, '',
      /SMOKE_FAIL: void_order could not void a fulfilled order with governed split drafts: SPLIT_INVOICE_VOID_ORDER_PROVENANCE_REFRESH_FAILED/],
    ['provenance refresh and its check', refresh + '\n' + check, '\n',
      /SMOKE_FAIL: the provenance of order 1's cancelled drafts was not refreshed/],
    ['claim delete', claimDelete, '',
      /SMOKE_FAIL: void_order left \d+ split_invoice_mutation_claims rows in the transaction/],
  ];
  for (const [label, find, replacement, expected] of mutations) {
    const r = chain(CHAIN, mutate('void_order', find, replacement, label));
    assert.ok(!r.pass, `MUTATION ${label}: the chain still passed without the hunk`);
    assert.match(r.fail, expected, `MUTATION ${label}: wrong failure: ${r.fail}`);
    console.log(`[prover] MUTATION: without the ${label} the chain fails: ${r.fail}`);
  }

  console.log('VOID_ORDER_GOVERNED_SPLIT_DRAFTS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
