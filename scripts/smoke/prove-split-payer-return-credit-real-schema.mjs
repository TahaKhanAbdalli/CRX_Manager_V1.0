#!/usr/bin/env node
/**
 * Full-chain proof for the 20261021155000 candidate: a field owner billed through a split (a customer
 * other than the order's) can return its billed share and receive its own return credit, and no payer
 * can return another payer's share.
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate (the
 * same skips as the other real-schema provers; 20261021150000, which this candidate builds on, is
 * replayed), then:
 *   0. FIDELITY: every body the candidate's preflight pins replayed with its live md5 of 2026-10-21
 *      (the guard with 20261021150000's body);
 *   1. BEFORE: the new chain fails first at its step 1 (the landlord's return is refused), and every
 *      other registered chain covering the return lifecycle or the invoice guard passes;
 *   2. AUTOCOMMIT: run statement by statement (psql -f, no -1) the file stops at its preflight;
 *      PREFLIGHT: a drifted body aborts the candidate before any change;
 *   3. the candidate applies and prints POSTFLIGHT_OK;
 *   4. AFTER: the new chain (a landlord's return created, refused beyond its share, received,
 *      credited and applied; exact cents on an unevenly split line; the lookup quoting what is left
 *      of a share; a price left stale by a cancelled earlier return refused at receipt and credit;
 *      the guard's refusals) and every other covering chain pass and roll back;
 *   5. RE-APPLY: refused by the preflight;
 *   6. MUTATION: each load-bearing condition, removed in turn, fails its own chain step.
 *      Defence in depth that no single-session chain step can isolate: issue_return_credit's re-check
 *      under the per-line locks (it matters only when a source void races the credit), its
 *      unbacked-credit refusal (the re-check already guarantees the returner's own lots cover it), and
 *      create_return's up-front unit check (reached only by a posted sale line whose unit differs from
 *      the return's, which the fixed split writer no longer produces; the writer mutation shows it).
 *
 * Run: node scripts/smoke/prove-split-payer-return-credit-real-schema.mjs   (needs Docker)
 * Prints SPLIT_PAYER_RETURN_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-split-payer-return-${process.pid}-${Date.now().toString(36)}`;
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1';
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261021155000_split_payer_return_credit.sql');
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
const RETURN_CHAIN = path.join(SMOKE, 'smoke-split-payer-return-credit.sql');
// Every other registered chain that runs the return lifecycle (create, receive, credit, cancel) or
// writes order invoices through guard_invoice_terminal_order, including 20261021150000's own chain.
// (smoke-return-credit-chain.sql needs its own prover's fixtures: verify-return-credit-real-schema.mjs;
// smoke-unpost-invoice-group.sql stops at GROUP_POST_REQUIRED and smoke-draw-ledger-reversal.sql at
// SMOKE_SETUP in a disposable database; smoke-cancel-return-chain.sql orders a product with no cost
// basis and stops at COST_BASIS_REQUIRED there.)
const COVERING_CHAINS = [
  'smoke-supplier-pricing-phase3-return-policy.sql',
  'smoke-split-invoice-cross-customer-lineage.sql',
  'smoke-order-invoice-type-gate.sql',
  'smoke-order-invoice-rep-own-name.sql',
  'smoke-backfill-refuse-split-billing.sql',
  'smoke-govern-invoice-order-money-lifecycle.sql',
  'smoke-money-lifecycle-idempotency-required.sql',
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
  assert.equal(at, all.length - 1, 'the candidate must be the last migration in the replay plan');
  const before = all.slice(0, at);
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!/invoice_from_order|split_invoices_from_order|order_item_field_allocations|create_return|receive_return|issue_return_credit|return_items|return_credit/i.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
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
// The pins were read from live (read-only pg_proc queries, 2026-10-21; the guard's is 20261021150000's
// post body); this checks the replay matches.
function fidelity() {
  const sql = lf(CANDIDATE).split('$preflight$')[1];
  const replaced = [...sql.matchAll(/\('[a-z_0-9]+', '(public\.[^']+\))', '([0-9a-f]{32})'\)/g)].map((m) => [m[1], m[2]]);
  const dependencies = [...sql.matchAll(/\('(public\.[^']+\))', '([0-9a-f]{32})'\)/g)].map((m) => [m[1], m[2]]);
  assert.equal(replaced.length, 6, 'the preflight pins the six replaced bodies');
  assert.equal(dependencies.length, 10, 'the preflight pins ten dependency bodies');
  for (const [sig, pin] of [...replaced, ...dependencies]) {
    assert.equal(scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${sig}');`), pin, `${sig} replayed with a body that differs from the live pin`);
  }
  console.log(`[prover] FIDELITY: all ${replaced.length + dependencies.length} pinned bodies match the live pins of 2026-10-21`);
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
  const re = new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`);
  const m = re.exec(sql);
  assert.ok(m, `${fn} is not in the candidate`);
  const a = sql.indexOf('AS $function$', m.index) + 'AS $function$'.length;
  const header = sql.slice(m.index, a).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
  return { header, body: sql.slice(a, sql.indexOf('$function$;', a)) };
}
function mutate(fn, find, replacement, label) {
  const { header, body } = candidateBody(fn);
  assert.equal(body.split(find).length - 1, 1, `mutation "${label}": hunk not found exactly once`);
  return `${header}${body.replace(find, replacement)}$function$;`;
}

const CREATE = '_create_return_intent_impl_20260812';
const RECEIVE = '_receive_return_intent_impl_20260812';
const ISSUE = '_issue_return_credit_intent_impl_20260812';
const SHARE = '_return_customer_line_share';
const GUARD_FN = 'guard_invoice_terminal_order';
// [label, function, hunk, replacement, the chain failure it must cause]
const MUTATIONS = [
  ['share cap off in create_return', CREATE,
    '      IF v_share.other_returned_qty + v_qty > v_share.billed_qty THEN\n', '      IF false THEN\n',
    // The cents cap still refuses it, under the wrong code: the quantity cap names the refusal.
    /SMOKE_FAIL: B's over-share return failed for the wrong reason: RETURN_CREDIT_EXCEEDS_BILLED_SHARE/],
  ['split-payer test admits any customer in create_return', CREATE,
    '    AND NOT public._return_customer_is_split_payer(v_order_id, v_customer_id)\n',
    '    AND false\n',
    /SMOKE_FAIL: D's return failed for the wrong reason: RETURN_SPLIT_SHARE_NOT_BILLED/],
  ['share pricing replaced by the order price in create_return', CREATE,
    '      v_extended := greatest(0,\n        round(v_share.billed_cents * (v_share.other_returned_qty + v_qty) / v_share.billed_qty)::bigint\n        - v_share.other_returned_cents);\n',
    '      v_extended := round(v_qty * v_order_item.price_per_unit * 100)::bigint;\n',
    // Step 4b's first partial return is the earliest that the order price misprices (2.50, not 2.51).
    /SMOKE_FAIL: P's first 0\.25 GL return of line 2 is not 2\.51/],
  ['split-billing evidence ignored', SHARE,
    '      OR COALESCE((SELECT split_evidence FROM ord), false),\n',
    '      OR false,\n',
    // The Returns screen lookup in step 1 shows A the whole delivered rest before 2b refuses it.
    /SMOKE_FAIL: the return lookups do not show B 1 GL \/ 0\.5 GL, A 2 GL, and nothing for D/],
  ['receive_return verifies split lines at the order price', RECEIVE,
    '          OR (NOT s.share_mode\n', '          OR (true\n',
    // Step 4b's payer is billed 10.02 a unit against the order's 10.01, so its receipt fails first.
    /SMOKE_FAIL: P's second line-2 return could not be received: RETURN_SOURCE_NOT_VERIFIED/],
  ['issue_return_credit verifies split lines at the order price', ISSUE,
    '          OR (NOT s.share_mode\n', '          OR (true\n',
    // Step 4b's stale credit is refused first, now by the order-price check.
    /SMOKE_FAIL: the stale credit failed for the wrong reason: RETURN_SOURCE_NOT_VERIFIED/],
  ['receive_return keeps the order-customer equality', RECEIVE,
    '       AND NOT public._return_customer_is_split_payer(v_order_id, v_customer_id) THEN\n',
    '       THEN\n',
    /SMOKE_FAIL: B's return could not be received and credited: RETURN_ORDER_CUSTOMER_MISMATCH/],
  ['issue_return_credit opens no claim', ISSUE,
    '    INSERT INTO public.return_credit_customer_claims (return_id, order_id, customer_id)\n    VALUES (p_return_id, v_order_id, v_customer_id);\n',
    '',
    /SMOKE_FAIL: B's return could not be received and credited: MONO_INVOICE_SPLIT_BILLING_CONFLICT/],
  ['split-order guard exemption off', 'guard_mono_invoice_split_billing_post',
    '       AND EXISTS (\n         SELECT 1\n           FROM public.return_credit_customer_claims claim\n',
    '       AND false AND EXISTS (\n         SELECT 1\n           FROM public.return_credit_customer_claims claim\n',
    /SMOKE_FAIL: B's return could not be received and credited: MONO_INVOICE_SPLIT_BILLING_CONFLICT/],
  ['guard claim branch off', GUARD_FN,
    '    v_split_payer_credit := EXISTS (\n', '    v_split_payer_credit := false AND EXISTS (\n',
    /SMOKE_FAIL: B's return could not be received and credited: INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID/],
  ['guard return-link branch off', GUARD_FN,
    "    ) OR (TG_OP = 'UPDATE' AND EXISTS (\n", "    ) OR (false AND TG_OP = 'UPDATE' AND EXISTS (\n",
    /SMOKE_FAIL: B's credit memo could not be applied to B's invoice: INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID/],
  ['split-order lookup ignores invoice visibility', 'get_split_payer_return_orders',
    '       AND (public.is_admin() OR NOT EXISTS (\n',
    '       AND (true OR NOT EXISTS (\n',
    /SMOKE_FAIL: a sales rep who cannot read the split invoices saw their billing through the return lookups/],
  ['allowance lookup ignores invoice visibility', 'get_return_line_allowances',
    '  IF NOT public.is_admin()\n     AND (\n', '  IF false AND NOT public.is_admin()\n     AND (\n',
    /SMOKE_FAIL: a sales rep who cannot read the split invoices saw their billing through the return lookups/],
  ['guard claim not bound to the customer', GUARD_FN,
    '         AND claim.customer_id = NEW.customer_id\n', '',
    /SMOKE_FAIL: a claim for B admitted a credit memo for another customer/],
  // The writer copies the empty unit again: create_return's up-front unit check refuses the return
  // with the credit's own code (without that check it would fail as RETURN_SPLIT_SHARE_NOT_BILLED).
  ['split invoice writer copies an empty unit', '_create_split_invoices_from_order_provenance_impl_20260719',
    "        COALESCE(v_item.unit_size, 'ea'));\n", '        v_item.unit_size);\n',
    /SMOKE_FAIL: B's return of the no-unit split line could not be created, received and credited: RETURN_CREDIT_UNIT_MISMATCH/],
  ['split writer does not freeze the billing defaults', '_create_split_invoices_from_order_provenance_impl_20260719',
    '  LOCK TABLE public.field_billing_defaults IN SHARE MODE;\n', '',
    /SMOKE_FAIL: the split did not hold the billing defaults in SHARE mode for its transaction/],
  ['create_return ignores invoice visibility', CREATE,
    '      IF NOT public.is_admin() AND EXISTS (\n', '      IF false AND EXISTS (\n',
    /SMOKE_FAIL: a sales rep who cannot read B's split invoice created B's return/],
  ['split return priced at the order unit price in create_return', CREATE,
    '      v_unit_price := round(v_share.billed_cents / v_share.billed_qty)::bigint;\n',
    '      v_unit_price := round(v_order_item.price_per_unit * 100)::bigint;\n',
    /SMOKE_FAIL: P's line-2 returns do not show P's billed rate 10\.02 as their unit price/],
  ['allowance lookup quotes the share pro rata instead of what is left', 'get_return_line_allowances',
    '           CASE WHEN s.share_mode THEN greatest(0, s.billed_cents - s.other_returned_cents)::bigint END\n',
    '           CASE WHEN s.share_mode AND s.billed_qty > 0 THEN round(s.billed_cents * (s.billed_qty - s.other_returned_qty) / s.billed_qty)::bigint END\n',
    /SMOKE_FAIL: after a 2\.51 return of 0\.25 GL the lookup does not quote the 0\.25 GL \/ 2\.50 left/],
  ['issue_return_credit exact re-price check off', ISSUE,
    "    ) THEN RAISE EXCEPTION 'RETURN_SPLIT_SHARE_REPRICED'; END IF;\n",
    "    ) AND false THEN RAISE EXCEPTION 'RETURN_SPLIT_SHARE_REPRICED'; END IF;\n",
    /SMOKE_FAIL: a stale split return price was credited after an earlier return was cancelled/],
  ['receive_return exact re-price check off', RECEIVE,
    "      ) THEN RAISE EXCEPTION 'RETURN_SPLIT_SHARE_REPRICED'; END IF;\n",
    "      ) AND false THEN RAISE EXCEPTION 'RETURN_SPLIT_SHARE_REPRICED'; END IF;\n",
    /SMOKE_FAIL: a stale split return price was received after an earlier return was cancelled/],
];

async function main() {
  buildContainer();
  fidelity();
  seed();

  // 1. BEFORE.
  const before = chain(RETURN_CHAIN);
  assert.ok(!before.pass, 'BEFORE: the return chain passed against the pre-fix return path');
  assert.match(before.fail, /SMOKE_FAIL: a split payer's return was refused: RETURN_ORDER_CUSTOMER_MISMATCH/, `BEFORE: wrong first failure: ${before.fail}`);
  console.log('[prover] BEFORE: the return chain fails first at step 1 (the landlord\'s return is refused)');
  runCovering('BEFORE');

  // 2. AUTOCOMMIT and PREFLIGHT.
  stageText('candidate.sql', lf(CANDIDATE));
  const auto = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(auto.status, 0, 'AUTOCOMMIT: the candidate ran outside one transaction');
  assert.match(auto.stderr, /SPLIT_PAYER_RETURN_NOT_IN_TRANSACTION/, `AUTOCOMMIT: wrong refusal:\n${auto.stderr}`);
  assert.equal(scalar("SELECT to_regclass('public.return_credit_customer_claims') IS NULL;"), 't', 'AUTOCOMMIT: the claims table was created');
  const drift = docker([...psqlArgs()], {
    input: `BEGIN;
CREATE OR REPLACE FUNCTION public.${GUARD_FN}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN NEW; END; $$;
\\i /tmp/candidate.sql
ROLLBACK;`,
    allowFailure: true,
  });
  assert.notEqual(drift.status, 0, 'PREFLIGHT: the candidate applied over a drifted body');
  assert.match(drift.stderr, /PREFLIGHT_SPLIT_PAYER_RETURN_DRIFT/, `PREFLIGHT: wrong refusal:\n${drift.stderr}`);
  console.log('[prover] AUTOCOMMIT + PREFLIGHT: outside one transaction, or over a drifted body, the candidate stops before any change');

  // 3. APPLY.
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  assert.match(a.output, /POSTFLIGHT_OK/, `the postflight did not report OK:\n${a.output}`);
  console.log('[prover] candidate applied; POSTFLIGHT_OK');

  // 4. AFTER.
  const after = chain(RETURN_CHAIN);
  assert.ok(after.pass, `AFTER: the return chain failed: ${after.fail}`);
  console.log('[prover] AFTER: the return chain passes and rolls back (landlord return created, refused beyond its share, received, credited, applied; exact cents on the uneven line; what is left of a share quoted exactly; a stale price refused at receipt and credit; guard refusals)');
  runCovering('AFTER');

  // 5. RE-APPLY.
  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /PREFLIGHT_SPLIT_PAYER_RETURN_ALREADY_APPLIED/, `second apply refused for the wrong reason:\n${again.output}`);
  console.log('[prover] RE-APPLY: refused by the preflight, nothing changed');

  // 6. MUTATION.
  for (const [label, fn, find, replacement, expected] of MUTATIONS) {
    const r = chain(RETURN_CHAIN, mutate(fn, find, replacement, label));
    assert.ok(!r.pass, `MUTATION ${label}: the chain still passed`);
    assert.match(r.fail, expected, `MUTATION ${label}: wrong failure: ${r.fail}`);
    console.log(`[prover] MUTATION: with the ${label} the chain fails: ${r.fail}`);
  }

  console.log('SPLIT_PAYER_RETURN_PROOF_PASS');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); });
