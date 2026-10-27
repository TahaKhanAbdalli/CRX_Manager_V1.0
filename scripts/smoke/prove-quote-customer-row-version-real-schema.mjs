#!/usr/bin/env node
/**
 * Disposable PostgreSQL 17 proof for the quote/customer row-version migration.
 * It restores the supported baseline, replays every ledger-selected migration
 * through this candidate, runs the legacy lifecycle smokes, applies the
 * candidate and runs its rollback-only smoke matrices right after it, then the
 * missing-default drift check. Then it replays every later migration on main
 * and runs today's matrices there too.
 *
 * The smoke files have since been rewritten for later rules (e.g.
 * 20261013220000's REP_CANNOT_REASSIGN, 20261006200000's CRX-LIFE-001
 * refusal), so on the legacy catalog this prover runs each one exactly as it
 * stood at CANDIDATE_ERA (the last commit at which this prover was maintained
 * and passed), read from git history; the current files run on current main.
 * It always removes its network-disabled container. It never reads a DB URL.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-row-version-schema-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const candidate = path.join(ROOT, 'supabase', 'migrations', '20260730235031_quote_customer_row_version_guard.sql');
const smokeFiles = [
  path.join(ROOT, 'scripts', 'smoke', 'smoke-save-quote-customer-row-version.sql'),
  path.join(ROOT, 'scripts', 'smoke', 'smoke-save-quote-drawn-guard.sql'),
  path.join(ROOT, 'scripts', 'smoke', 'smoke-planned-holds-drawn-sync.sql'),
];
// #450, 2026-08-24: the last commit that changed this prover. Smokes rewritten since then for later
// migrations run on the legacy catalog in their form at this commit.
const CANDIDATE_ERA = '56321c0d083e958d445854c3310878b916aa971a';
const CANDIDATE_ERA_LEGACY_SMOKES = new Set(['smoke-backfill-refuse-split-billing.sql']);
// Later migrations, replayed after the candidate the way the other real-schema provers replay them.
// Live but not replayable here (storage.objects policies, storage.buckets settings).
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
// request.jwt.claims ->> 'sub'. Batch 2 (20261016140000) pins live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
const legacyLifecycleSmokeFiles = [
  // Runs as it stood at CANDIDATE_ERA. Since #885 the current file also asserts
  // the CRX-LIFE-001 refusal from 20261006200000, fail-first, so it cannot pass
  // on this legacy catalog; nor does it pass on current main (it completes a
  // delivery by direct UPDATE, which 20261022075000 refuses), so it is not run
  // there either until that chain is repaired.
  path.join(ROOT, 'scripts', 'smoke', 'smoke-backfill-refuse-split-billing.sql'),
  path.join(ROOT, 'scripts', 'smoke', 'smoke-draw-ledger-reversal.sql'),
  path.join(ROOT, 'scripts', 'smoke', 'smoke-forbid-restore-cancelled-order.sql'),
  path.join(ROOT, 'scripts', 'smoke', 'smoke-order-draw-lock.sql'),
  path.join(ROOT, 'scripts', 'smoke', 'smoke-planned-holds-drawn-sync.sql'),
  // smoke-restore-version-drawn-guard.sql is deliberately NOT in this list.
  // 20260816120000 rewrote what it asserts (QUOTE_RESTORE_BLOCKED_BY_DRAW
  // instead of the older BOOKING_OVERDRAWN quantity comparison) and gave it no
  // prerequisite skip, so it cannot pass on this legacy catalog, whose replay
  // stops at 20260730235031 — long before that migration. Its own replay-based
  // proof is scripts/smoke/prove-draw-down-price-tier-real-schema.mjs.
  path.join(ROOT, 'scripts', 'smoke', 'smoke-revert-quote-escape-hatch.sql'),
];
const quoteLifecycleAnchors = [
  {
    label: 'draft-to-sent exact-version, sent_at, and commission-split',
    statement: "RAISE EXCEPTION 'SMOKE_FAIL: draft-to-sent save lost status, sent_at, commission split, or exact N+1 token';",
  },
  {
    label: 'repeated-sent exact-version, sent_at preservation, and commission-split preservation',
    statement: "RAISE EXCEPTION 'SMOKE_FAIL: repeated sent save reset sent_at, lost commission split, or missed exact N+1 token';",
  },
  {
    label: 'stale draft after sent resolves as row-version conflict before lifecycle validation',
    statement: "RAISE EXCEPTION 'SMOKE_FAIL: stale draft after sent raised % instead of QUOTE_STALE_WRITE', v_error;",
  },
];

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 60 * 1024 * 1024, ...options });
  if (result.error || (!options.allowFailure && result.status !== 0)) throw new Error(`${result.error?.message ?? ''}\n${result.stderr || result.stdout}`.trim());
  return result;
}
function psql(sql, options = {}) {
  return docker(['exec', '-i', NAME, 'psql', '-U', options.user ?? 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: sql, allowFailure: options.allowFailure });
}
function copy(local, name) { docker(['cp', local, `${NAME}:/tmp/${name}`]); }
function apply(name, user) { psql(`\\i /tmp/${name}`, { user }); }
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function waitForDatabase() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    // The image exposes a temporary bootstrap server before restarting into
    // the final server. Require the entrypoint's post-bootstrap marker first,
    // then prove that the final socket accepts a real query.
    const logs = docker(['logs', NAME], { allowFailure: true });
    const initComplete = `${logs.stdout}\n${logs.stderr}`.includes(
      'PostgreSQL init process complete; ready for start up.',
    );
    const ready = initComplete
      && docker(['exec', NAME, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { allowFailure: true }).status === 0;
    if (ready) {
      const query = docker(
        ['exec', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atqc', 'SELECT 1'],
        { allowFailure: true },
      );
      if (query.status === 0 && query.stdout.trim() === '1') return;
    }
    wait(500);
  }
  throw new Error(`disposable PostgreSQL failed readiness: ${docker(['logs', NAME], { allowFailure: true }).stderr}`);
}
function selectedMigrations() {
  const result = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  const migrations = result.stdout.split(/\r?\n/).filter(Boolean).map((relative) => path.join(ROOT, relative));
  const candidateIndex = migrations.indexOf(candidate);
  assert.notEqual(candidateIndex, -1, 'candidate migration is not in the ledger-selected post-baseline replay');
  const later = migrations.slice(candidateIndex + 1);
  for (const file of later) assert.ok(file.endsWith('.sql') && path.dirname(file) === path.join(ROOT, 'supabase', 'migrations'), `unexpected replay entry ${file}`);
  for (const name of PARKED) assert.ok(later.some((f) => path.basename(f) === name), `${name} must be in the later replay (re-check the skip lists)`);
  return { through: migrations.slice(0, candidateIndex + 1), later };
}
function scalar(sql) {
  return docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { input: sql }).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
}
function lf(file) { return readFileSync(file, 'utf8').replaceAll('\r\n', '\n'); }
function stageText(name, text) {
  const staged = path.join(tmpdir(), `${NAME}-${name}`);
  writeFileSync(staged, text, 'utf8');
  try { copy(staged, name); } finally {
    try { unlinkSync(staged); } catch (e) { if (e.code !== 'ENOENT') console.error(`could not remove ${staged}: ${e.message}`); }
  }
}
// Record a migration in the ledger by NAME (later preflights look names up), versioned by its stamp.
function ledger(stem) {
  psql(`INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
    SELECT '${stem.slice(0, 14)}', '${stem}', ARRAY[]::text[]
     WHERE NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '${stem}')
    ON CONFLICT (version) DO NOTHING;`);
  assert.equal(scalar(`SELECT count(*) FROM supabase_migrations.schema_migrations WHERE name = '${stem}';`), '1', `${stem} is not in the ledger`);
}
function installLiveAuthUid() {
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
}
// 20260817120000's preflight pins live's CRLF body of this function; the LF source differs.
function restoreLiveCrLfCloseRemainder() {
  const source = lf(path.join(ROOT, 'supabase', 'migrations', '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql'));
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
function replayLater(later) {
  // Users are seeded by now, so later postflights that impersonate one through
  // request.jwt.claims (20260807215532's role lock) need live's auth.uid().
  installLiveAuthUid();
  let replayed = 0;
  for (const [index, file] of later.entries()) {
    const base = path.basename(file);
    for (const only of LEDGER_ONLY) if (only < base) ledger(path.basename(only, '.sql'));
    // Recorded in the ledger, as live has them, but not replayed.
    if (PARKED.has(base)) { ledger(path.basename(file, '.sql')); continue; }
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    const name = `later-${index}.sql`;
    stageText(name, lf(file));
    const result = docker(['exec', '-i', NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-f', `/tmp/${name}`], { allowFailure: true });
    if (result.status !== 0) throw new Error(`later replay failed at ${base}:\n${result.stdout}\n${result.stderr}`);
    ledger(path.basename(file, '.sql'));
    replayed += 1;
  }
  installLiveAuthUid();
  return replayed;
}
function assertQuoteLifecycleCoverage(sql) {
  for (const anchor of quoteLifecycleAnchors) {
    assert.equal(
      sql.split(anchor.statement).length - 1,
      1,
      `quote lifecycle smoke must contain exactly one ${anchor.label} failure assertion`,
    );
  }
}
function proveQuoteLifecycleAnchorMutationResistance(sql) {
  for (const anchor of quoteLifecycleAnchors) {
    const mutations = [
      ['removing', sql.replace(anchor.statement, '')],
      ['renaming', sql.replace(anchor.statement, anchor.statement.replace('SMOKE_FAIL:', 'SMOKE_FAIL_RENAMED:'))],
    ];
    for (const [action, mutated] of mutations) {
      assert.notEqual(mutated, sql, `failed to mutate ${anchor.label} assertion anchor`);
      assert.throws(
        () => assertQuoteLifecycleCoverage(mutated),
        new RegExp(`exactly one ${anchor.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} failure assertion`),
        `${action} ${anchor.label} assertion anchor must fail closed`,
      );
    }
  }
}
function expectRollbackMarker(file, text, where) {
  const name = `${where}-${path.basename(file)}`;
  stageText(name, text);
  const result = psql(`\\i /tmp/${name}`, { allowFailure: true });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.notEqual(result.status, 0, `${path.basename(file)} unexpectedly committed instead of rolling back (${where})`);
  assert.match(output, /SMOKE_PASS_ROLLBACK/, `${path.basename(file)} did not execute to SMOKE_PASS_ROLLBACK (${where}):\n${output}`);
}
// A smoke file exactly as it stood at CANDIDATE_ERA (needs the repository's git history).
function candidateEraText(file) {
  const relative = path.relative(ROOT, file).replaceAll('\\', '/');
  const result = spawnSync('git', ['show', `${CANDIDATE_ERA}:${relative}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  assert.equal(result.status, 0, `cannot read ${relative} at ${CANDIDATE_ERA} (a shallow clone lacks it): ${result.stderr}`);
  return result.stdout.replaceAll('\r\n', '\n');
}

try {
  for (const file of [candidate, ...smokeFiles, ...legacyLifecycleSmokeFiles]) assert.ok(readFileSync(file, 'utf8').length > 0, `missing required artifact ${file}`);
  const quoteSmokeSql = readFileSync(smokeFiles[0], 'utf8');
  assertQuoteLifecycleCoverage(quoteSmokeSql);
  proveQuoteLifecycleAnchorMutationResistance(quoteSmokeSql);
  const candidateEraSmokes = new Map(smokeFiles.map((file) => [file, candidateEraText(file)]));
  assertQuoteLifecycleCoverage(candidateEraSmokes.get(smokeFiles[0]));
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  waitForDatabase();
  const artifacts = ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql'];
  for (const artifact of artifacts) copy(path.join(BASELINE, artifact), artifact);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 20 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(`baseline decompression failed: ${schema.stderr.toString()}`);
  apply('20260727174805_extensions.sql');
  psql(schema.stdout.toString());
  // The supported Postgres image does not ship Storage DDL.  The platform
  // overlay owns CRX's policies/buckets, so provide only its platform tables
  // and helpers before applying that exact artifact.
  psql(`
    CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (
      id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false,
      file_size_limit bigint, allowed_mime_types text[]
    );
    -- metadata, the (bucket_id, name) key and postgres's read are live's shape, which
    -- 20261022075000 (replayed after the candidate) checks in its preflight.
    CREATE TABLE IF NOT EXISTS storage.objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL,
      name text NOT NULL, owner_id text, metadata jsonb, UNIQUE (bucket_id, name)
    );
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
    GRANT USAGE ON SCHEMA storage TO postgres;
    GRANT ALL ON storage.objects, storage.buckets TO postgres;
  `, { user: 'supabase_admin' });
  apply('20260727174805_acl_lockdown.sql');
  apply('20260727174805_platform_overlay.sql', 'supabase_admin');
  apply('20260727174805_cron_jobs.sql');
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  apply('20260727174805_migration_history.sql');
  const { through: migrations, later } = selectedMigrations();
  assert.equal(migrations.at(-1), candidate, 'candidate must be the last migration of the through-candidate replay');
  for (const [index, migration] of migrations.slice(0, -1).entries()) {
    // LF, as live's bodies are: later preflights hash them (a CRLF checkout would drift).
    const name = `migration-${index}.sql`;
    stageText(name, lf(migration));
    apply(name);
    ledger(path.basename(migration, '.sql'));
  }
  psql(`
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (user_id varchar);
    GRANT DELETE ON auth.sessions, auth.refresh_tokens TO postgres;
  `, { user: 'supabase_admin' });
  psql(`
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('00000000-0000-4000-8000-000000000001', 'row-version-admin@example.invalid', '{"full_name":"Row Version Admin","role":"admin"}'),
      ('00000000-0000-4000-8000-000000000002', 'row-version-sales@example.invalid', '{"full_name":"Row Version Sales","role":"sales_rep"}'),
      ('00000000-0000-4000-8000-000000000003', 'row-version-driver@example.invalid', '{"full_name":"Row Version Driver","role":"driver"}'),
      ('00000000-0000-4000-8000-000000000004', 'row-version-backup-admin@example.invalid', '{"full_name":"Row Version Backup Admin","role":"admin"}')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.profiles (id, email, role, is_active) VALUES
      ('00000000-0000-4000-8000-000000000001', 'row-version-admin@example.invalid', 'admin', true),
      ('00000000-0000-4000-8000-000000000002', 'row-version-sales@example.invalid', 'sales_rep', true),
      ('00000000-0000-4000-8000-000000000003', 'row-version-driver@example.invalid', 'driver', true),
      ('00000000-0000-4000-8000-000000000004', 'row-version-backup-admin@example.invalid', 'admin', true)
    ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = true;
  `);
  // The three legacy lifecycle smokes below now borrow priced products because
  // current quote-item triggers reject pricing-free product shells. This
  // schema-only container has no catalog data, so seed two priced products
  // while the governed-pricing trigger is disabled, then restore it before
  // any smoke runs. This never touches a live database.
  psql(`
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (product_name, unit_size, current_cost, tier1_price)
    VALUES ('[PROVER] Row Version Priced A', 'gal', 3.00, 10.00),
           ('[PROVER] Row Version Priced B', 'gal', 4.00, 8.00);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
  `);
  for (const file of legacyLifecycleSmokeFiles) {
    stageText(`legacy-${path.basename(file)}`, CANDIDATE_ERA_LEGACY_SMOKES.has(path.basename(file)) ? candidateEraText(file) : lf(file));
    const legacyResult = psql(`\\i /tmp/legacy-${path.basename(file)}`, { allowFailure: true });
    const legacyOutput = `${legacyResult.stdout}\n${legacyResult.stderr}`;
    assert.notEqual(legacyResult.status, 0, `${path.basename(file)} unexpectedly committed on the legacy catalog`);
    assert.match(
      legacyOutput,
      /SMOKE_PASS_ROLLBACK/,
      `${path.basename(file)} did not reach SMOKE_PASS_ROLLBACK on the legacy catalog:\n${legacyOutput}`,
    );
  }
  stageText('candidate.sql', lf(candidate));
  apply('candidate.sql');
  // The candidate in isolation: its matrices, as they stood at CANDIDATE_ERA, right after it.
  for (const file of smokeFiles) expectRollbackMarker(file, candidateEraSmokes.get(file), 'candidate');
  psql('ALTER TABLE public.quotes ALTER COLUMN row_version DROP DEFAULT;');
  const missingDefault = psql(readFileSync(candidate, 'utf8'), { allowFailure: true });
  const missingDefaultOutput = `${missingDefault.stdout}\n${missingDefault.stderr}`;
  assert.notEqual(missingDefault.status, 0, 'candidate migration accepted a pre-existing row_version without DEFAULT 1');
  assert.match(missingDefaultOutput, /ROW_VERSION_SCHEMA_DRIFT/, `missing-default drift did not fail with ROW_VERSION_SCHEMA_DRIFT:\n${missingDefaultOutput}`);
  assert.match(missingDefaultOutput, /quotes\.row_version/, `missing-default drift did not identify quotes.row_version:\n${missingDefaultOutput}`);
  // Put the candidate's own default back, so the later replay builds on the candidate as applied.
  psql('ALTER TABLE public.quotes ALTER COLUMN row_version SET DEFAULT 1;');
  assert.equal(scalar("SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.adrelid = 'public.quotes'::regclass AND a.attname = 'row_version';"), '1', 'quotes.row_version default was not restored');
  ledger(path.basename(candidate, '.sql'));
  const replayedLater = replayLater(later);
  console.log(`[prover] replayed ${replayedLater} later migrations after the candidate (through ${path.basename(later.at(-1))}; skipped: ${[...PARKED].join(', ')}; ledger only: ${[...LEDGER_ONLY].join(', ')})`);
  // Today's matrices on current main.
  for (const file of smokeFiles) expectRollbackMarker(file, lf(file), 'current');
  console.log(`ROW_VERSION_REAL_SCHEMA_RESTORE_PASS baseline=20260727174805 post_baseline_replay=through_candidate_then_${replayedLater}_later smoke_matrices=candidate_era_after_candidate+current_on_${path.basename(later.at(-1), '.sql')} legacy_lifecycle_smokes=${legacyLifecycleSmokeFiles.length}/${legacyLifecycleSmokeFiles.length} smoke_backfill_split=candidate_era_on_legacy smoke_quote_customer=SMOKE_PASS_ROLLBACK quote_lifecycle=draft-sent-sent stale_before_lifecycle=QUOTE_STALE_WRITE smoke_drawn_guard=NOT_RUN_HERE_SEE_DRAW_TIER_PROVER smoke_planned_holds=SMOKE_PASS_ROLLBACK`);
} catch (error) {
  console.error(`ROW_VERSION_REAL_SCHEMA_RESTORE_FAIL ${error.stack ?? error.message}`);
  process.exitCode = 1;
} finally {
  docker(['rm', '-f', NAME], { allowFailure: true });
}
