#!/usr/bin/env node
/**
 * Full-chain proof for the 20261015130000 candidate: a sales rep records only themselves (or no one)
 * as salesperson on orders and blend tickets, changes one only from blank to themselves, and bills
 * or converts a blend ticket only when it is theirs or unassigned; admins are unrestricted (Mason,
 * 2026-10-06, narrowed 2026-10-13).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers), then:
 *   0. FIDELITY: every body the candidate's preflight pins replayed with its live md5 of 2026-10-15;
 *   1. BEFORE: the new chain fails first at its step 1 (a rep creates an order under another rep's
 *      name), and every other covering chain passes;
 *   2. AUTOCOMMIT: run statement by statement (psql -f, no -1) the file stops at its preflight;
 *      PREFLIGHT: a drifted create_invoice_from_blend_ticket aborts the candidate before any change;
 *   3. the candidate applies and prints POSTFLIGHT_OK;
 *   4. AFTER: the new chain and every other covering chain pass and roll back;
 *   5. RE-APPLY: refused by the preflight's own pins;
 *   6. MUTATION: with each hunk removed or weakened in turn (the guard's INSERT test, its "another
 *      name is never replaced" UPDATE test, its "unchanged is never refused" test, its admin
 *      pass-through, and the blend-ticket billing test) the new chain fails at that step.
 *
 * Run: node scripts/smoke/prove-orders-blend-tickets-rep-own-name-real-schema.mjs   (needs Docker)
 * Prints ORDERS_BLEND_TICKETS_OWN_NAME_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-rep-salesman-own-name-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261015130000_orders_blend_tickets_rep_own_name.sql');
// Live but not replayable here (storage.objects policies); it must not touch what this proves.
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
const SMOKE = path.join(ROOT, 'scripts', 'smoke');
const OWN_NAME_CHAIN = path.join(SMOKE, 'smoke-orders-blend-tickets-rep-own-name.sql');
// Every other non-container chain that writes orders or blend tickets as a sales rep, or covers the
// order-invoice path the guard now sits under. (smoke-blend-ticket-fractional-cents.sql, the
// registered chain for create_order_from_blend_ticket, needs real catalog products and has its own
// container prover. smoke-supplier-pricing-phase3-return-policy.sql, whose rep inserts orders under
// their own name, already fails on main before this candidate, at its own fixture (COST_BASIS_REQUIRED:
// its product has no cost basis), so it cannot cover anything here; the new chain's step 2 covers
// that path. smoke-gauntlet-core-blend-guards.sql, which edits blend tickets, stops at its own setup
// here: it needs existing live customers, products and an unbatched commission, which this
// disposable database does not have.)
const COVERING_CHAINS = [
  'smoke-order-invoice-rep-own-name.sql',
  'smoke-order-invoice-type-gate.sql',
  'smoke-financial-scope-and-delivery-aggregate.sql',
];
const SUPERUSER_CHAINS = new Set([]);

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
  // disposable database does not have); none of them touches the order-invoice wrappers.
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
    assert.ok(!/blend_ticket|salesman_id/i.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
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
    // The replay plan omits the data-only files; record each once the replay passes its stamp.
    for (const only of LEDGER_ONLY) if (only < base) ledger(path.basename(only, '.sql'));
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
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
}

// ------------------------------------------------------------------------------------------------
// FIDELITY: the md5 pins the candidate's preflight checks, read from the candidate file itself.
// The pins were read from live (read-only pg_proc queries, 2026-10-14); this checks the replay matches.
function fidelity() {
  const sql = lf(CANDIDATE).split('$preflight$')[1];
  const contract = /md5\(replace\(p\.prosrc, chr\(13\), ''\)\) = '([0-9a-f]{32})'/.exec(sql);
  assert.ok(contract, 'the preflight pins create_invoice_from_blend_ticket by contract');
  const pins = [
    ['public.create_invoice_from_blend_ticket(uuid,uuid,text)', contract[1]],
    ...[...sql.matchAll(/\('(public\.[^']+\))', '([0-9a-f]{32})'\)/g)].map((m) => [m[1], m[2]]),
  ];
  assert.equal(pins.length, 3, 'the preflight pins three bodies');
  for (const [sig, pin] of pins) {
    assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${sig}');`), pin, `${sig} replayed with a body that differs from the live pin`);
  }
  console.log(`[prover] FIDELITY: all ${pins.length} pinned bodies match the live pins of 2026-10-15`);
}

// ------------------------------------------------------------------------------------------------
function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.REP, 'sales_rep', 'Rep', 8], [U.REP_B, 'sales_rep', 'Rep B', 7], [U.DRIVER, 'driver', 'Driver', 6], [U.APPLICATOR, 'applicator', 'Applicator', 5]];
  // Auth columns and tables the hosted project has and the image lacks (the financial-scope chain
  // deactivates a user), as in the other real-schema provers.
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'rep-salesman-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
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
    // The money-lifecycle chain rebuilds legacy history (a soft-deleted fulfilled order) and its
    // corruption probes only as a superuser, which the image's postgres role is not.
    const r = chain(path.join(SMOKE, name), '', SUPERUSER_CHAINS.has(name) ? 'supabase_admin' : 'postgres');
    assert.ok(r.pass, `${phase}: ${name} did not pass: ${r.fail}`);
  }
  console.log(`[prover] ${phase}: all ${COVERING_CHAINS.length} other covering chains pass and roll back`);
}

const GUARD = 'guard_rep_salesman_20261015';
const BLEND_INVOICE = 'create_invoice_from_blend_ticket';
function candidateBody(fn) {
  const sql = lf(CANDIDATE);
  const tag = fn === GUARD ? '$guard$' : '$function$';
  const start = sql.search(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`));
  assert.ok(start >= 0, `${fn} is not in the candidate`);
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
  const before = chain(OWN_NAME_CHAIN);
  assert.ok(!before.pass, 'BEFORE: the own-name chain passed before the guard existed');
  assert.match(before.fail, /SMOKE_FAIL: a sales rep created an order under another rep's name/, `BEFORE: wrong first failure: ${before.fail}`);
  console.log('[prover] BEFORE: the own-name chain fails first at step 1 (a rep created an order under another rep\'s name)');
  runCovering('BEFORE');

  // 2. AUTOCOMMIT and PREFLIGHT.
  stageText('candidate.sql', lf(CANDIDATE));
  const auto = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(auto.status, 0, 'AUTOCOMMIT: the candidate ran outside one transaction');
  assert.match(auto.stderr, /REP_SALESMAN_OWN_NAME_NOT_IN_TRANSACTION/, `AUTOCOMMIT: wrong refusal:\n${auto.stderr}`);
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
  assert.equal(scalar("SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%guard_rep_salesman_20261015';"), '0', 'a refused apply left a change behind');
  console.log('[prover] AUTOCOMMIT + PREFLIGHT: outside one transaction, or over a drifted body, the candidate stops before any change');

  // 3. APPLY.
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.match(a.output, /POSTFLIGHT_OK/, `the postflight did not report OK:\n${a.output}`);
  console.log('[prover] candidate applied; POSTFLIGHT_OK');

  // 4. AFTER.
  const after = chain(OWN_NAME_CHAIN);
  assert.ok(after.pass, `AFTER: the own-name chain failed: ${after.fail}`);
  console.log('[prover] AFTER: the own-name chain passes and rolls back');
  runCovering('AFTER');

  // 5. RE-APPLY.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /PREFLIGHT_BLEND_TICKET_INVOICE_DRIFT/, `second apply refused for the wrong reason:\n${again.output}`);
  console.log('[prover] RE-APPLY: refused by the preflight, nothing changed');

  // 6. MUTATION: each hunk is what its chain step proves.
  const BILL_OWN_NAME_HUNK = [
    '  IF NOT public.is_admin() THEN',
    '    PERFORM 1 FROM public.blend_tickets bt WHERE bt.id = p_blend_ticket_id FOR UPDATE;',
    '    IF EXISTS (',
    '      SELECT 1 FROM public.blend_tickets bt',
    '       WHERE bt.id = p_blend_ticket_id',
    '         AND bt.salesman_id IS NOT NULL',
    '         AND bt.salesman_id IS DISTINCT FROM v_actor',
    '    ) THEN',
    "      RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';",
    '    END IF;',
    '  END IF;',
    '',
  ].join('\n');
  const BILL_REPLAY_BLOCK = [
    '  IF p_idempotency_key IS NOT NULL THEN',
    '    v_existing := public.check_idempotency(',
    '      p_idempotency_key,',
    "      'create_invoice_from_blend_ticket'",
    '    );',
    '    IF v_existing IS NOT NULL THEN',
    '      -- The receipt is keyed by the key alone. Replay it only to the person who billed this',
    '      -- ticket under that key, so a reused key never returns another ticket\'s or another',
    '      -- person\'s invoices.',
    "      IF jsonb_typeof(v_existing->'invoice_ids') IS DISTINCT FROM 'array'",
    "         OR jsonb_array_length(v_existing->'invoice_ids') = 0",
    '         OR EXISTS (',
    '           SELECT 1',
    "             FROM jsonb_array_elements_text(v_existing->'invoice_ids') AS r(invoice_id)",
    '             LEFT JOIN public.invoices i ON i.id = r.invoice_id::uuid',
    '            WHERE i.id IS NULL',
    '               OR i.blend_ticket_id IS DISTINCT FROM p_blend_ticket_id',
    '               OR i.created_by IS DISTINCT FROM v_actor',
    '         ) THEN',
    "        RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH';",
    '      END IF;',
    '      RETURN v_existing;',
    '    END IF;',
    '  END IF;',
    '',
  ].join('\n');
  const BILL_REPLAY_BINDING = BILL_REPLAY_BLOCK.slice(
    BILL_REPLAY_BLOCK.indexOf("      IF jsonb_typeof"), BILL_REPLAY_BLOCK.indexOf('      RETURN v_existing;'));
  const mutations = [
    ['guard INSERT test', GUARD,
      "    IF NEW.salesman_id IS NOT NULL AND NEW.salesman_id IS DISTINCT FROM (SELECT auth.uid()) THEN\n      RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';\n    END IF;\n", '',
      /SMOKE_FAIL: a sales rep created an order under another rep's name/],
    ['guard UPDATE: another name is never replaced', GUARD,
      '(OLD.salesman_id IS NOT NULL OR NEW.salesman_id IS DISTINCT FROM (SELECT auth.uid()))',
      '(NEW.salesman_id IS NOT NULL AND NEW.salesman_id IS DISTINCT FROM (SELECT auth.uid()))',
      /SMOKE_FAIL: a sales rep took over another rep's order/],
    ['guard UPDATE: unchanged is never refused', GUARD,
      '  IF NEW.salesman_id IS DISTINCT FROM OLD.salesman_id\n     AND (', '  IF (',
      /SMOKE_FAIL: an update that left another rep's salesperson alone was refused: SALESMAN_SCOPE_DENIED/],
    // The whole pass-through, not its is_admin() half alone: profiles.role holds one role, so an
    // admin is never is_sales_rep() and dropping is_admin() by itself cannot change any outcome
    // today (kept as belt-and-braces, as in 20261013220000).
    ['guard non-rep pass-through', GUARD,
      '  IF public.is_admin() OR NOT public.is_sales_rep() THEN', '  IF (SELECT auth.uid()) IS NULL THEN',
      /SMOKE_FAIL: an admin could not/],
    ['blend-ticket billing own-name test', BLEND_INVOICE,
      "    IF EXISTS (\n      SELECT 1 FROM public.blend_tickets bt\n       WHERE bt.id = p_blend_ticket_id\n         AND bt.salesman_id IS NOT NULL\n         AND bt.salesman_id IS DISTINCT FROM v_actor\n    ) THEN\n      RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';\n    END IF;\n", '',
      /SMOKE_FAIL: a sales rep billed another rep's blend ticket under that rep's name/],
    // The replay lookup is keyed by the key alone, so the own-name test must run before it.
    ['blend-ticket billing test before the replay lookup', BLEND_INVOICE,
      BILL_OWN_NAME_HUNK + '\n' + BILL_REPLAY_BLOCK, BILL_REPLAY_BLOCK + '\n' + BILL_OWN_NAME_HUNK,
      /SMOKE_FAIL: wrong blend-ticket replay refusal: IDEMPOTENCY_INTENT_MISMATCH/],
    // The replay binding as a whole, then each of its two tests on its own.
    ['blend-ticket replay binding', BLEND_INVOICE, BILL_REPLAY_BINDING, '',
      /SMOKE_FAIL: a sales rep replayed an admin's billing key on another ticket/],
    ['blend-ticket replay bound to its ticket', BLEND_INVOICE,
      '               OR i.blend_ticket_id IS DISTINCT FROM p_blend_ticket_id\n', '',
      /SMOKE_FAIL: a billing key replayed onto a different blend ticket/],
    ['blend-ticket replay bound to its caller', BLEND_INVOICE,
      '               OR i.created_by IS DISTINCT FROM v_actor\n', '',
      /SMOKE_FAIL: a sales rep replayed an admin's billing key on their own ticket/],
  ];
  for (const [label, fn, find, replacement, expected] of mutations) {
    const r = chain(OWN_NAME_CHAIN, mutate(fn, find, replacement, label));
    assert.ok(!r.pass, `MUTATION ${label}: the chain still passed without the hunk`);
    assert.match(r.fail, expected, `MUTATION ${label}: wrong failure: ${r.fail}`);
    console.log(`[prover] MUTATION: without the ${label} hunk the chain fails: ${r.fail}`);
  }

  console.log('ORDERS_BLEND_TICKETS_OWN_NAME_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
