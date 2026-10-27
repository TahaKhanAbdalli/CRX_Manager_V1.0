#!/usr/bin/env node
/**
 * Full-chain proof for the 20261027050000 candidate: the price sheet is safe to use (To-Do 0.1,
 * pricing plan slice 0). Builds the checked-in production schema baseline in a network-disabled
 * Supabase PostgreSQL 17 container, replays every ordered post-baseline migration up to the candidate
 * (the margin floors, 20261025210000, included), checks every md5 pin in the candidate's preflight,
 * seeds two admins, a rep, two products (one with a 30% floor and a blank tier 3) and a sent quote,
 * then runs one matrix BEFORE and AFTER the candidate. Each scenario is one transaction that always
 * rolls back; each step runs as a PostgREST session, a signed-out visitor, or the owner.
 *   1. A price change without a reason or source is invalid; with both it applies only after an
 *      approval, and its cost_history row keeps the reason and source.
 *   2. A tenfold typo ($150 for $15) is flagged (more than 10%, and the sent quote) and refused until
 *      every warning is acknowledged with a reason, by the admin who previewed it; rep and signed-out
 *      refused; the approval replays and binds its key; the receipt records who and why.
 *   3. Below cost, under the margin floor, a cost move over 10%, and tier fallback in the details.
 *   4. A floor set after the approval makes apply (and re-approval) refuse: the warnings changed.
 *   5. A per-acre rate change on the product page writes a history row.
 *   6. A floor raised after the approval with the same warning code (30% -> 40%) still refuses.
 *   7. A floor change that lands while apply runs (a test trigger, after the engine has locked the
 *      product) rolls the apply back.
 *   8. A per-acre rate row with no source (a preview made before the migration) is refused at approval.
 *   Grants; preflight drift refusals; a second apply refused; MUTATIONS: the apply approval check
 *   removed lets an unacknowledged typo through; the second read removed lets scenario 7 apply.
 *
 * Run: node scripts/smoke/prove-price-sheet-warnings-real-schema.mjs   (needs Docker)
 * Prints PRICE_SHEET_WARNINGS_PROOF_PASS on success. CRX_PROVER_VERBOSE=1 prints every step.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-price-sheet-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1' || REUSE;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261027050000_price_sheet_warnings_and_approval.sql');
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
// A later or parked file that (re)defines anything the candidate creates or relies on.
const TOUCHED = /(FUNCTION\s+(public\.)?"?(preview_product_cost_basis_changes|apply_product_cost_basis_change_set|write_product_pricing_history|approve_pricing_change_set|_pricing_change_set_warnings|_pricing_change_set_warning_set|_pricing_change_set_warning_inputs|preview_product_pricing_changes|apply_product_pricing_change_set|_apply_product_cost_basis_change_set_serialized_inner|_resolve_product_cost_basis_row|_product_cost_basis_row_required|is_admin|check_idempotency_intent|save_idempotency|_bind_replay_receipt_20261015|_replay_fingerprint_20261015|_cost_step2_try_uuid)\b|pricing_change_set|product_margin_floor|cost_history)/i;
// The image's auth.uid() reads only request.jwt.claim.sub; live's falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';

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
  for (const file of all.slice(at + 1)) {
    assert.ok(!TOUCHED.test(lf(file)), `${path.basename(file)} sorts after the candidate and touches what it relies on; re-think this proof`);
  }
  const before = all.slice(0, at);
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!TOUCHED.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
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
  // storage.objects carries metadata and a (bucket_id, name) key, and postgres may read it, as live
  // has them: 20261022075000 (replayed before the candidate) checks that shape in its preflight.
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb, UNIQUE (bucket_id, name));
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
    GRANT USAGE ON SCHEMA storage TO postgres;
    GRANT ALL ON storage.objects, storage.buckets TO postgres;`, { user: 'supabase_admin' });
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
// FIDELITY: every md5 pin in the candidate's preflight matches the replayed body.
function fidelity() {
  const sql = lf(CANDIDATE).split('$preflight$')[1];
  const all = [...sql.matchAll(/^\s*\('(public\.[a-z_0-9]+\([^']*\))', '([0-9a-f]{32})'\)/gm)].map((m) => [m[1], m[2]]);
  assert.equal(all.length, 14, 'the preflight pins fourteen bodies');
  for (const [sig, pin] of all) {
    const got = scalar(`SELECT coalesce(md5(replace(prosrc, chr(13), '')), 'MISSING') FROM pg_proc WHERE oid = to_regprocedure('${sig}') UNION ALL SELECT 'MISSING' LIMIT 1;`);
    assert.equal(got, pin, `${sig} replayed with a body that differs from the live pin of 2026-10-25`);
  }
  console.log(`[prover] FIDELITY: all ${all.length} pinned bodies match the live pins of 2026-10-25`);
}

// ------------------------------------------------------------------------------------------------
// Fixtures (committed once; every probe rolls back).
const id = (n) => `7c320000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = { ADMIN: id('a1'), ADMIN2: id('a2'), REP: id('b1') };
const PROD = id('f1'); // cost 10.00; prices 15.00 / 14.00 / 13.00; on a sent quote
const PROD_B = id('f2'); // cost 20.00; prices 30.00 / 28.00 / (blank = tier 1); floor 30%
const CUST = id('c1');
const QUOTE = id('901');
const SECTION = id('902');
const QITEM = id('903');
const q = (value) => `'${value}'`;

function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function seed() {
  const users = [[U.ADMIN, 'admin', 'Admin', 9], [U.ADMIN2, 'admin', 'Admin Two', 8], [U.REP, 'sales_rep', 'Rep', 7]];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'price-sheet-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};`);
  psql(`SET session_replication_role = replica;
    ${users.map(([u, role, , minutes]) => `UPDATE public.profiles SET role = '${role}', is_active = true, created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    ${claims(U.ADMIN)}
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, sku, unit_size, current_cost,
        tier1_price, tier2_price, tier3_price, tier1_margin, tier2_margin, tier3_margin, product_form, is_active) VALUES
      ('${PROD}', '[PROVER] Sheet A', 'SHEET-A', 'gal', 10.00, 15.00, 14.00, 13.00,
        0.33333333, 0.28571429, 0.23076923, 'liquid', true),
      ('${PROD_B}', '[PROVER] Sheet B', 'SHEET-B', 'gal', 20.00, 30.00, 28.00, NULL,
        0.33333333, 0.28571429, NULL, 'liquid', true);
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    COMMIT;`);
  psql(`SET session_replication_role = replica;
    INSERT INTO public.customers (id, farm_name, assigned_tier) VALUES ('${CUST}', '[PROVER] Farm', 1);
    INSERT INTO public.quotes (id, quote_number, customer_id, created_by, tier, status, sent_at, valid_days)
      VALUES ('${QUOTE}', 'Q-PROVER-1', '${CUST}', '${U.ADMIN}', 1, 'sent', now(), 30);
    INSERT INTO public.quote_sections (id, quote_id, sort_order) VALUES ('${SECTION}', '${QUOTE}', 0);
    INSERT INTO public.quote_items (id, quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed)
      VALUES ('${QITEM}', '${QUOTE}', '${SECTION}', '${PROD}', 0, 15.00, 10);
    SET session_replication_role = origin;`, { user: 'supabase_admin' });
  psql(`INSERT INTO public.product_margin_floors (product_id, margin_floor, set_by) VALUES ('${PROD_B}', 0.30, '${U.ADMIN}');`, { user: 'supabase_admin' });
  assert.equal(scalar(`SELECT string_agg(pricing_version::text, ',' ORDER BY id) FROM public.products WHERE id IN ('${PROD}', '${PROD_B}');`), '1,1');
  console.log('[prover] seeded two admins and a rep, two products (B has a 30% floor and a blank tier 3), and a sent quote holding product A');
}

// Probes: one transaction per scenario, always rolled back. Each step runs as a role inside its own
// sub-transaction, so a refused step leaves the scenario going. A step yields "ok|<value>" or
// "<sqlstate>|<message>". Steps share values through transaction-local settings (crx.p.*).
function who(as) {
  if (as === 'owner') return `RESET ROLE;\n${claims(U.ADMIN)}`;
  if (as === 'bare') return `RESET ROLE;\nSELECT set_config('request.jwt.claims', '', true);\nSELECT set_config('request.jwt.claim.sub', '', true);`;
  if (as === 'anon') return `RESET ROLE;\nSELECT set_config('request.jwt.claims', '{"role":"anon"}', true);\nSELECT set_config('request.jwt.claim.sub', '', true);\nSET LOCAL ROLE anon;`;
  return `RESET ROLE;\n${claims(as)}\nSET LOCAL ROLE authenticated;`;
}
function scenario(steps, fixture = '') {
  const sql = ['BEGIN;', fixture];
  for (const s of steps) {
    const body = s.stmt ? s.stmt : `v := (${s.call})::text;`;
    const key = s.key.replaceAll('%', '%%');
    sql.push(who(s.as), `DO $probe$
DECLARE v text;
BEGIN
  ${body}
  RAISE NOTICE 'RESULT|${key}|ok|%', COALESCE(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'RESULT|${key}|%|%', SQLSTATE, replace(SQLERRM, chr(10), ' ');
END
$probe$;`);
  }
  sql.push('ROLLBACK;');
  const text = sql.join('\n');
  const r = docker([...psqlArgs(), '-A', '-t'], { input: text, allowFailure: true });
  assert.equal(r.status, 0, `scenario failed to run:\n${r.stderr}\n--- SQL ---\n${text}`);
  const out = {};
  for (const m of r.stderr.matchAll(/RESULT\|([^|\n]+)\|([^\n]*)/g)) out[m[1]] = m[2].trimEnd();
  for (const s of steps) assert.ok(s.key in out, `step ${s.key} printed no RESULT:\n${r.stderr}`);
  return out;
}

// A products_inline preview row, price-driven, as src/lib/productPricing.ts sends it.
function row(product, cost, t1, t2, t3, extra = {}) {
  return {
    product_id: product, row_version: 1, pricing_mode: 'price_driven', new_cost: cost,
    tier1_price: t1, tier2_price: t2, tier3_price: t3,
    basis_type: 'manual_override', basis_source: 'products_inline', basis_reason: 'prover', basis_selection: false,
    ...extra,
  };
}
const SOURCED = { change_reason: 'Wells letter 10/20', price_source: 'Wells price letter 2026-10-20' };
const jb = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
// Preview; remember the change set as crx.p.<tag>. Yields "<status>|<warnings>|<row errors>".
const preview = (tag, rows, key) => `(SELECT CASE WHEN set_config('crx.p.${tag}', r->>'change_set_id', true) IS NOT NULL
    AND set_config('crx.p.${tag}_fp', r->>'request_fingerprint', true) IS NOT NULL THEN
    (r->>'status') || '|' || COALESCE((SELECT string_agg(w->>'product_id' || '=' || (SELECT string_agg(c, '+' ORDER BY c) FROM jsonb_array_elements_text(w->'warning_codes') c), ',' ORDER BY w->>'product_id')
      FROM jsonb_array_elements(COALESCE(r->'warnings', '[]'::jsonb)) w), '-')
    || '|' || COALESCE((SELECT string_agg(x->>'error_code', ',') FROM jsonb_array_elements(r->'rows') x WHERE x->>'error_code' IS NOT NULL), '-') END
  FROM (SELECT public.preview_product_cost_basis_changes('products_inline', NULL, ${jb(rows)}, current_setting('request.jwt.claim.sub')::uuid, '${key}') AS r) s)`;
const CS = (tag) => `current_setting('crx.p.${tag}')::uuid`;
const FP = (tag) => `current_setting('crx.p.${tag}_fp')`;
const approve = (tag, acks, key, file = null) => `(SELECT r->>'status' || ':' || (r->>'acknowledged_count') FROM (SELECT public.approve_pricing_change_set(${CS(tag)}, ${FP(tag)}, ${jb(acks)}, ${file === null ? 'NULL' : jb(file)}, current_setting('request.jwt.claim.sub')::uuid, '${key}') AS r) s)`;
const applyCs = (tag, key) => `(SELECT r->>'status' FROM (SELECT public.apply_product_cost_basis_change_set(${CS(tag)}, ${FP(tag)}, current_setting('request.jwt.claim.sub')::uuid, '${key}') AS r) s)`;
const ack = (product, codes, reason = 'checked against the supplier letter') => ({ product_id: product, warning_codes: codes, reason });
const PRICES = (product) => `(SELECT round(current_cost, 2) || '/' || round(tier1_price, 2) || '/' || round(tier2_price, 2) || '/' || COALESCE(round(tier3_price, 2)::text, '-') FROM public.products WHERE id = '${product}')`;
const LAST_HIST = (product) => `(SELECT COALESCE(change_reason, '-') || '|' || COALESCE(to_jsonb(h)->>'price_source', '-') || '|' || change_source || '|' || COALESCE(to_jsonb(h)->>'new_rate_per_acre', '-')
  FROM public.cost_history h WHERE product_id = '${product}' ORDER BY changed_at DESC, id DESC LIMIT 1)`;
const FLOOR = (product) => `(SELECT COALESCE((SELECT margin_floor::text FROM public.product_margin_floors WHERE product_id = '${product}'), '-'))`;
const HIST_COUNT = (product) =>`(SELECT count(*) FROM public.cost_history WHERE product_id = '${product}')`;

// A floor change for B that lands inside apply, after the engine has updated (so locked) B: what a
// concurrent set_product_margin_floors does once that lock is released to it.
const ARM_MID_APPLY_FLOOR = { stmt: `CREATE FUNCTION public.prover_floor_mid_apply() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$ BEGIN UPDATE public.product_margin_floors SET margin_floor = 0.1 WHERE product_id = NEW.id; RETURN NULL; END $fn$;
  CREATE TRIGGER prover_floor_mid_apply AFTER UPDATE ON public.products FOR EACH ROW WHEN (NEW.id = '${PROD_B}') EXECUTE FUNCTION public.prover_floor_mid_apply();
  v := 'armed';` };
const NO_APPROVE_FN =/^42883\|function public\.approve_pricing_change_set\(.*\) does not exist$/;
const A = PROD;
const B = PROD_B;

/**
 * Scenarios. Each step: [key, as, call|{stmt}, before, after]. before/after: a RegExp, an exact
 * string, or 'same' (identical in both phases).
 */
const SCENARIOS = [
  { name: '1. source and reason required', steps: [
    ['a price change with no reason or source', U.ADMIN, preview('p1', [row(A, '10.00', '15.50', '14.00', '13.00')], 'k1'),
      'ok|previewed|-|-', 'ok|invalid|-|PRICING_REASON_REQUIRED'],
    ['a reason but no source', U.ADMIN, preview('p2', [row(A, '10.00', '15.50', '14.00', '13.00', { change_reason: 'x' })], 'k2'),
      'ok|previewed|-|-', 'ok|invalid|-|PRICING_SOURCE_REQUIRED'],
    ['both given: ready; a 3% move, so only the sent quote is flagged', U.ADMIN, preview('p3', [row(A, '10.00', '15.50', '14.00', '13.00', SOURCED)], 'k3'),
      'ok|previewed|-|-', `ok|previewed|${A}=OPEN_SENT_QUOTE|-`],
    ['apply without approval', U.ADMIN, applyCs('p3', 'k3a'), 'ok|applied', /^P0001\|PRICING_APPROVAL_REQUIRED: /],
    ['approve, acknowledging the sent quote', U.ADMIN, approve('p3', [ack(A, ['OPEN_SENT_QUOTE'])], 'k3b'), NO_APPROVE_FN, 'ok|approved:1'],
    ['apply after approval', U.ADMIN, applyCs('p3', 'k3c'), /^P0001\|CHANGE_SET_ALREADY_APPLIED$/, 'ok|applied'],
    ['prices now', 'owner', PRICES(A), 'ok|10.00/15.50/14.00/13.00', 'same'],
    ['the history row keeps its reason and source', 'owner', LAST_HIST(A),
      'ok|Wells letter 10/20|-|products_inline|-', 'ok|Wells letter 10/20|Wells price letter 2026-10-20|products_inline|-'],
  ].map((s) => s) },
  { name: '2. a tenfold typo is flagged and refused until acknowledged', steps: [
    ['preview $150 for $15', U.ADMIN, preview('t', [row(A, '10.00', '150.00', '14.00', '13.00', SOURCED)], 't1'),
      'ok|previewed|-|-', `ok|previewed|${A}=OPEN_SENT_QUOTE+PRICE_MOVE_OVER_10_PERCENT|-`],
    ['apply without approval', U.ADMIN, applyCs('t', 't2'), 'ok|applied', /^P0001\|PRICING_APPROVAL_REQUIRED: /],
    ['approve with no acknowledgement', U.ADMIN, approve('t', [], 't3'), NO_APPROVE_FN, /^P0001\|PRICING_WARNINGS_UNACKNOWLEDGED: /],
    ['approve naming only one of the two warnings', U.ADMIN, approve('t', [ack(A, ['PRICE_MOVE_OVER_10_PERCENT'])], 't4'), NO_APPROVE_FN, /^P0001\|PRICING_ACK_INVALID: /],
    ['approve with a blank reason', U.ADMIN, approve('t', [ack(A, ['OPEN_SENT_QUOTE', 'PRICE_MOVE_OVER_10_PERCENT'], '  ')], 't5'), NO_APPROVE_FN, /^P0001\|PRICING_ACK_REASON_REQUIRED: /],
    ['acknowledge a product with no warnings', U.ADMIN, approve('t', [ack(A, ['OPEN_SENT_QUOTE', 'PRICE_MOVE_OVER_10_PERCENT']), ack(B, ['PRICE_BELOW_COST'])], 't6'), NO_APPROVE_FN, /^P0001\|PRICING_ACK_INVALID: /],
    ['a second admin may not approve my preview', U.ADMIN2, approve('t', [ack(A, ['PRICE_MOVE_OVER_10_PERCENT', 'OPEN_SENT_QUOTE'])], 't7'), NO_APPROVE_FN, /^P0001\|CHANGE_SET_NOT_FOUND$/],
    ['a rep may not approve', U.REP, approve('t', [], 't8'), NO_APPROVE_FN, /^P0001\|ADMIN_REQUIRED$/],
    ['signed-out cannot approve', 'anon', approve('t', [], 't9'), NO_APPROVE_FN, /^42501\|permission denied for function approve_pricing_change_set$/],
    ['bad file fingerprint', U.ADMIN, approve('t', [ack(A, ['OPEN_SENT_QUOTE', 'PRICE_MOVE_OVER_10_PERCENT'])], 't10', { name: 'sheet.xlsx', sha256: 'abc' }), NO_APPROVE_FN, /^P0001\|PRICING_SOURCE_FILE_INVALID: /],
    ['approve, both warnings in any order', U.ADMIN, approve('t', [ack(A, ['PRICE_MOVE_OVER_10_PERCENT', 'OPEN_SENT_QUOTE'])], 't11'), NO_APPROVE_FN, 'ok|approved:1'],
    ['exact replay of the approval', U.ADMIN, approve('t', [ack(A, ['PRICE_MOVE_OVER_10_PERCENT', 'OPEN_SENT_QUOTE'])], 't11'), NO_APPROVE_FN, 'ok|approved:1'],
    ['same key, other reason', U.ADMIN, approve('t', [ack(A, ['PRICE_MOVE_OVER_10_PERCENT', 'OPEN_SENT_QUOTE'], 'other')], 't11'), NO_APPROVE_FN, /^22023\|IDEMPOTENCY_INTENT_MISMATCH/],
    ['apply', U.ADMIN, applyCs('t', 't12'), /^P0001\|CHANGE_SET_ALREADY_APPLIED$/, 'ok|applied'],
    ['the receipt', 'owner', `(SELECT approved_by::text = '${U.ADMIN}' AND acknowledgements->0->>'reason' = 'checked against the supplier letter' AND warning_codes ? '${A}' FROM public.pricing_change_set_approvals WHERE change_set_id = ${CS('t')})`, /^42P01\|/, 'ok|true'],
  ] },
  { name: '3. below cost, under the floor, fallback tiers', steps: [
    ['a blank tier 3 is refused: every tier needs a price', U.ADMIN, preview('b', [row(B, '20.00', '30.00', '28.00', null, SOURCED)], 'b1'),
      /^ok\|invalid\|-\|PRICE_DRIVEN_FIELDS_INVALID$/, /^ok\|invalid\|-\|PRICE_DRIVEN_FIELDS_INVALID$/],
    ['B tier 3 left at 0 falls back to tier 1; tier 2 under the 30% floor', U.ADMIN, preview('f', [row(B, '20.00', '30.00', '27.00', '0.00', SOURCED)], 'f1'),
      /^ok\|invalid\|-\|PRICING_ZERO_PRICE_BELOW_COST$/, /^ok\|invalid\|-\|PRICING_ZERO_PRICE_BELOW_COST$/],
    ['B tier 2 under the 30% floor', U.ADMIN, preview('g', [row(B, '20.00', '30.00', '27.00', '30.00', SOURCED)], 'g1'),
      'ok|previewed|-|-', `ok|previewed|${B}=MARGIN_UNDER_FLOOR|-`],
    ['B: cost up 5% makes every tier under the floor', U.ADMIN, preview('h', [row(B, '21.00', '30.00', '28.00', '30.00', SOURCED)], 'h1'),
      'ok|previewed|-|-', `ok|previewed|${B}=MARGIN_UNDER_FLOOR|-`],
    ['B: cost 25 with tier 2 at 24 is below cost and a >10% cost move', U.ADMIN, preview('c', [row(B, '25.00', '30.00', '24.00', '30.00', SOURCED)], 'c1'),
      'ok|previewed|-|-', `ok|previewed|${B}=COST_MOVE_OVER_10_PERCENT+MARGIN_UNDER_FLOOR+PRICE_BELOW_COST+PRICE_MOVE_OVER_10_PERCENT|-`],
    ['what B tier 3 customers pay is shown, not the blank', U.ADMIN, `(SELECT w->'details'->'tiers'->2->>'before_cents' FROM jsonb_array_elements(public.preview_product_cost_basis_changes('products_inline', NULL, ${jb([row(B, '25.00', '30.00', '24.00', '30.00', SOURCED)])}, '${U.ADMIN}', 'c1')->'warnings') w)`,
      'ok|<null>', 'ok|3000'],
    // A stated $0 tier is a real price to quotes (getQuoteTierPrice, save_quote), not "use tier 1".
    // With a cost the engine already refuses it (PRICING_ZERO_PRICE_BELOW_COST); at a $0 cost it is
    // allowed, and A's tier 2 moving from $14 to $0 must warn as a big move, not read as tier 1's $15.
    ['A tier 2 set to $0 with a cost is refused by the engine', U.ADMIN, preview('z0', [row(A, '10.00', '15.00', '0.00', '13.00', SOURCED)], 'z0k'),
      'ok|invalid|-|PRICING_ZERO_PRICE_BELOW_COST', 'same'],
    ['A tier 2 set to $0 at a $0 cost warns as a price move (the tier 1 quote is not flagged)', U.ADMIN, preview('z', [row(A, '0.00', '15.00', '0.00', '13.00', SOURCED)], 'z1'),
      'ok|previewed|-|-', `ok|previewed|${A}=COST_MOVE_OVER_10_PERCENT+PRICE_MOVE_OVER_10_PERCENT|-`],
    // Cents leave as JSON text, like the rest of the pricing boundary: a number above 2^53 would lose digits.
    ['warning cents are JSON strings, not numbers', U.ADMIN, `(SELECT jsonb_typeof(w->'details'->'cost_before_cents') || '/' || jsonb_typeof(w->'details'->'cost_after_cents') || '/' || jsonb_typeof(w->'details'->'tiers'->0->'before_cents') || '/' || jsonb_typeof(w->'details'->'tiers'->0->'after_cents') FROM jsonb_array_elements(public.preview_product_cost_basis_changes('products_inline', NULL, ${jb([row(B, '25.00', '30.00', '24.00', '30.00', SOURCED)])}, '${U.ADMIN}', 'c1')->'warnings') w)`,
      'ok|<null>', 'ok|string/string/string/string'],
  ] },
  { name: '4. warnings that change after approval', steps: [
    ['preview B tier 2 at $27.50 (under no floor yet once cleared)', U.ADMIN, `(SELECT public.set_product_margin_floors(${jb([{ product_id: B, margin_floor_percent: null }])}, NULL, '${U.ADMIN}', 'w0')->>'status')`, 'ok|saved', 'same'],
    ['preview', U.ADMIN, preview('w', [row(B, '20.00', '30.00', '27.50', '30.00', SOURCED)], 'w1'), 'ok|previewed|-|-', 'ok|previewed|-|-'],
    ['approve', U.ADMIN, approve('w', [], 'w2'), NO_APPROVE_FN, 'ok|approved:0'],
    ['another admin sets a 30% floor', U.ADMIN2, `(SELECT public.set_product_margin_floors(${jb([{ product_id: B, margin_floor_percent: 30 }])}, NULL, '${U.ADMIN2}', 'w3')->>'status')`, 'ok|saved', 'same'],
    ['apply is refused: the warnings changed', U.ADMIN, applyCs('w', 'w4'), 'ok|applied', /^P0001\|PRICING_WARNINGS_CHANGED: /],
    ['re-approving is refused too', U.ADMIN, approve('w', [], 'w5'), NO_APPROVE_FN, /^P0001\|PRICING_WARNINGS_CHANGED: /],
    ['prices unchanged', 'owner', PRICES(B), 'ok|20.00/30.00/27.50/30.00', 'ok|20.00/30.00/28.00/-'],
  ] },
  { name: '5. per-acre rate history', steps: [
    ['history rows for A before', 'owner', HIST_COUNT(A), 'ok|0', 'same'],
    ['admin saves a new rate per acre on the product page', U.ADMIN, { stmt: `UPDATE public.products SET rate_per_acre = 32 WHERE id = '${A}'; v := 'updated';` }, 'ok|updated', 'same'],
    ['history row written for the rate change', 'owner', `${HIST_COUNT(A)} || '|' || COALESCE(${LAST_HIST(A)}, '-')`, 'ok|0|-', 'ok|1|Rate per acre changed in product details|-|product_page|32'],
    ['a migration (no user) changing the rate writes nothing', 'bare', { stmt: `UPDATE public.products SET rate_per_acre = 40 WHERE id = '${B}'; v := 'updated';` }, 'ok|updated', 'same'],
    ['no history for B', 'owner', HIST_COUNT(B), 'ok|0', 'same'],
  ] },
  { name: '6. a floor raised with the same warning code', steps: [
    ['preview B tier 2 at $27, under the 30% floor', U.ADMIN, preview('r', [row(B, '20.00', '30.00', '27.00', '30.00', SOURCED)], 'r1'),
      'ok|previewed|-|-', `ok|previewed|${B}=MARGIN_UNDER_FLOOR|-`],
    ['approve', U.ADMIN, approve('r', [ack(B, ['MARGIN_UNDER_FLOOR'])], 'r2'), NO_APPROVE_FN, 'ok|approved:1'],
    ['another admin raises the floor to 40% (still under it: same code)', U.ADMIN2, `(SELECT public.set_product_margin_floors(${jb([{ product_id: B, margin_floor_percent: 40 }])}, NULL, '${U.ADMIN2}', 'r3')->>'status')`, 'ok|saved', 'same'],
    ['apply is refused: the floor in the warning changed', U.ADMIN, applyCs('r', 'r4'), 'ok|applied', /^P0001\|PRICING_WARNINGS_CHANGED: the warnings for this change set changed after it was approved/],
    ['re-approving with the same acknowledgement is refused too', U.ADMIN, approve('r', [ack(B, ['MARGIN_UNDER_FLOOR'])], 'r5'), NO_APPROVE_FN, /^P0001\|PRICING_WARNINGS_CHANGED: /],
    ['prices unchanged', 'owner', PRICES(B), 'ok|20.00/30.00/27.00/30.00', 'ok|20.00/30.00/28.00/-'],
  ] },
  { name: '7. a floor change landing while apply runs', steps: [
    ['a floor change is wired to land mid-apply', 'owner', ARM_MID_APPLY_FLOOR, 'ok|armed', 'same'],
    ['preview B tier 2 at $27', U.ADMIN, preview('s', [row(B, '20.00', '30.00', '27.00', '30.00', SOURCED)], 's1'),
      'ok|previewed|-|-', `ok|previewed|${B}=MARGIN_UNDER_FLOOR|-`],
    ['approve', U.ADMIN, approve('s', [ack(B, ['MARGIN_UNDER_FLOOR'])], 's2'), NO_APPROVE_FN, 'ok|approved:1'],
    ['apply is rolled back by the second read', U.ADMIN, applyCs('s', 's3'), 'ok|applied', /^P0001\|PRICING_WARNINGS_CHANGED: a margin floor or an open sent quote changed while this change set was applying/],
    ['prices unchanged', 'owner', PRICES(B), 'ok|20.00/30.00/27.00/30.00', 'ok|20.00/30.00/28.00/-'],
    ['the floor change rolled back with it', 'owner', FLOOR(B), 'ok|0.1', 'ok|0.30'],
  ] },
  { name: '8. a rate change previewed before this migration (no source) must be previewed again', steps: [
    ['preview A at $15.50', U.ADMIN, preview('v', [row(A, '10.00', '15.50', '14.00', '13.00', SOURCED)], 'v1'),
      'ok|previewed|-|-', `ok|previewed|${A}=OPEN_SENT_QUOTE|-`],
    // What an older preview's per-acre rate row looks like: it changes the rate and names no source.
    ['the same preview also carries an unsourced rate row', 'owner', { stmt: `INSERT INTO public.product_info_change_set_rows
        (change_set_id, product_id, expected_version, before_values, after_values, changes, output_fingerprint)
        VALUES (${CS('v')}, '${A}', 1, '{"rate_per_acre": 30}', '{"rate_per_acre": 32}',
                '{"rate_per_acre": {"before": 30, "after": 32}}', 'prover');
      v := 'inserted';` }, 'ok|inserted', 'same'],
    ['approval is refused', U.ADMIN, approve('v', [ack(A, ['OPEN_SENT_QUOTE'])], 'v2'), NO_APPROVE_FN, /^P0001\|PRICING_SOURCE_REQUIRED: this preview was made before sources were required/],
  ] },
  // The sent-quote price lock (20261027040000): once a quote has a sent version, save_quote keeps each
  // saved line's price, so a price change cannot reach it and OPEN_SENT_QUOTE leaves it out.
  { name: '9. a quote with a sent version keeps its prices, so it raises no warning', steps: [
    ['the sent quote gets a sent version', 'owner', { stmt: `INSERT INTO public.quote_versions (quote_id, version_number, sent_by, snapshot_data)
        VALUES ('${QUOTE}', 1, '${U.ADMIN}', '{}'::jsonb);
      v := 'versioned';` }, 'ok|versioned', 'same'],
    ['a tenfold typo on A is still flagged, without the quote', U.ADMIN, preview('q0', [row(A, '10.00', '150.00', '14.00', '13.00', SOURCED)], 'q0'),
      'ok|previewed|-|-', `ok|previewed|${A}=PRICE_MOVE_OVER_10_PERCENT|-`],
    ['a 3% move on A: nothing flagged', U.ADMIN, preview('q', [row(A, '10.00', '15.50', '14.00', '13.00', SOURCED)], 'q1'),
      'ok|previewed|-|-', 'same'],
    ['approve with no acknowledgements', U.ADMIN, approve('q', [], 'q2'), NO_APPROVE_FN, 'ok|approved:0'],
    ['apply; the second read sees no open quote either', U.ADMIN, applyCs('q', 'q3'), 'ok|applied', 'same'],
    ['prices now', 'owner', PRICES(A), 'ok|10.00/15.50/14.00/13.00', 'same'],
  ] },
  // save_quote prices a line at the quote's own tier (CASE v_tier), so only that tier's change reaches it.
  { name: '10. only a change to the quote\'s own tier flags it', steps: [
    ['the tier 1 quote, tier 2 moves 3%: nothing flagged', U.ADMIN, preview('r1', [row(A, '10.00', '15.00', '14.40', '13.00', SOURCED)], 'r1'),
      'ok|previewed|-|-', 'same'],
    ['the quote moves to tier 2', 'owner', { stmt: `UPDATE public.quotes SET tier = 2 WHERE id = '${QUOTE}'; v := 'tier 2';` }, 'ok|tier 2', 'same'],
    ['the same tier 2 move now flags it', U.ADMIN, preview('r2', [row(A, '10.00', '15.00', '14.40', '13.00', SOURCED)], 'r2'),
      'ok|previewed|-|-', `ok|previewed|${A}=OPEN_SENT_QUOTE|-`],
    ['a tier 1 move does not', U.ADMIN, preview('r3', [row(A, '10.00', '15.40', '14.00', '13.00', SOURCED)], 'r3'),
      'ok|previewed|-|-', 'same'],
  ] },
];

function runMatrix(phase) {
  const out = {};
  for (const sc of SCENARIOS) {
    const steps = sc.steps.map(([key, as, call]) => ({ key, as, ...(typeof call === 'string' ? { call } : call) }));
    const res = scenario(steps);
    for (const [key] of sc.steps) out[`${sc.name} / ${key}`] = res[key];
  }
  console.log(`[prover] ${phase}: ${Object.keys(out).length} steps run`);
  return out;
}
function check(phase, results) {
  const failures = [];
  const lines = [];
  for (const sc of SCENARIOS) {
    for (const step of sc.steps) {
      const label = `${sc.name} / ${step[0]}`;
      let want = phase === 'before' ? step[3] : step[4];
      if (want === 'same') want = step[3];
      const got = results[label];
      const ok = want instanceof RegExp ? want.test(got) : got === want;
      if (!ok) failures.push(`${label}: got "${got}", expected ${want instanceof RegExp ? want : `"${want}"`}`);
      lines.push(`  ${ok ? 'PASS' : 'FAIL'} ${label} -> ${got}`);
    }
  }
  if (process.env.CRX_PROVER_VERBOSE === '1' || failures.length) console.log(lines.join('\n'));
  assert.deepEqual(failures, [], `${phase.toUpperCase()} failed:\n  ${failures.join('\n  ')}`);
  console.log(`[prover] ${phase.toUpperCase()}: all ${lines.length} steps as expected`);
}

function grants() {
  const fns = docker([...psqlArgs(), '-A', '-t', '-F', '|'], { input: `SELECT p.oid::regprocedure,
      has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      has_function_privilege('service_role', p.oid, 'EXECUTE'), array_to_string(p.proconfig, ';')
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('approve_pricing_change_set', '_pricing_change_set_warnings', '_pricing_change_set_warning_set', '_pricing_change_set_warning_inputs',
                       'preview_product_cost_basis_changes', 'apply_product_cost_basis_change_set', 'write_product_pricing_history')
    ORDER BY 1;` }).stdout.trim().split(/\r?\n/).map((l) => l.split('|'));
  const want = {
    'approve_pricing_change_set(uuid,text,jsonb,jsonb,uuid,text)': ['f', 't', 'f'],
    '_pricing_change_set_warnings(uuid)': ['f', 'f', 'f'],
    '_pricing_change_set_warning_set(uuid)': ['f', 'f', 'f'],
    '_pricing_change_set_warning_inputs(uuid)': ['f', 'f', 'f'],
    'preview_product_cost_basis_changes(text,uuid,jsonb,uuid,text)': ['f', 't', 'f'],
    'apply_product_cost_basis_change_set(uuid,text,uuid,text)': ['f', 't', 'f'],
    'write_product_pricing_history()': ['f', 'f', 't'],
  };
  assert.deepEqual(fns.map((r) => r[0]).sort(), Object.keys(want).sort());
  for (const [sig, anon, auth, svc, cfg] of fns) {
    assert.deepEqual([anon, auth, svc], want[sig], `${sig} grants`);
    assert.equal(cfg, 'search_path=public, pg_temp', `${sig} must pin search_path`);
  }
  for (const t of ['pricing_change_set_warnings', 'pricing_change_set_approvals']) {
    assert.equal(scalar(`SELECT bool_or(has_table_privilege(r, 'public.${t}', 'SELECT,INSERT,UPDATE,DELETE')) FROM unnest(ARRAY['anon','authenticated','service_role']) r;`), 'f', `${t} reachable`);
  }
  console.log('[prover] GRANTS: approve executable by authenticated only; helpers by no API role; the replaced functions kept their grants; the two tables reachable by no API role');
}

function preflightRefusesDrift(phase) {
  stageText('cand.sql', lf(CANDIDATE));
  const cases = phase === 'before' ? [
    ['CREATE OR REPLACE FUNCTION public.write_product_pricing_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN RETURN NEW; END; $$;',
      /PRICE_SHEET_PREFLIGHT: public\.write_product_pricing_history\(\) changed since 2026-10-25/],
    ['DROP TABLE public.product_margin_floor_changes; DROP TABLE public.product_margin_floors;',
      /PRICE_SHEET_PREFLIGHT: product_margin_floors \(20261025210000\) must be applied first/],
    ['DROP FUNCTION public._assert_quote_prices_as_sent(uuid);',
      /PRICE_SHEET_PREFLIGHT: the sent-quote price lock \(20261027040000\) must be applied first/],
    ['ALTER TABLE public.cost_history ADD COLUMN price_source text;',
      /PRICE_SHEET_PREFLIGHT: an object this migration creates already exists/],
    ['ALTER TABLE public.products DISABLE TRIGGER trigger_write_product_pricing_history;',
      /PRICE_SHEET_PREFLIGHT: trigger_write_product_pricing_history is not the enabled history trigger/],
  ] : [
    ['SELECT 1;', /PRICE_SHEET_PREFLIGHT: /],
  ];
  for (const [setup, refusal] of cases) {
    const d = docker([...psqlArgs()], { input: `BEGIN;\n${setup}\n\\i /tmp/cand.sql\nROLLBACK;`, allowFailure: true });
    assert.notEqual(d.status, 0, `the candidate applied over: ${setup}`);
    assert.match(d.stderr, refusal, `wrong refusal for ${setup}:\n${d.stderr}`);
  }
  console.log(`[prover] PREFLIGHT (${phase}): ${cases.length} drifted state(s) each abort the candidate${phase === 'after' ? ' (a second apply is refused)' : ''}`);
}

function main() {
  const started = Date.now();
  if (!REUSE) buildContainer();
  assert.equal(scalar("SELECT to_regclass('public.pricing_change_set_approvals') IS NULL;"), 't', 'a reused container must be BEFORE the candidate (drop it and rebuild)');
  fidelity();
  if (scalar(`SELECT count(*) FROM public.products WHERE id = '${PROD}';`) === '0') seed();

  check('before', runMatrix('before'));
  preflightRefusesDrift('before');

  stageText('candidate.sql', lf(CANDIDATE));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  console.log('[prover] candidate applied');

  check('after', runMatrix('after'));
  grants();
  preflightRefusesDrift('after');

  // MUTATION: the approval check in apply is what refuses an unapproved change set.
  const wrapper = lf(CANDIDATE).match(/CREATE OR REPLACE FUNCTION public\.apply_product_cost_basis_change_set\([\s\S]*?\$function\$;/)[0];
  const mutant = wrapper.replace(/  SELECT status INTO v_status[\s\S]*?\n  END IF;\n\n  v_result :=/, '  v_result :=');
  assert.notEqual(mutant, wrapper, 'the mutation must remove the approval check');
  const mut = scenario([
    { key: 'preview', as: U.ADMIN, call: preview('m', [row(A, '10.00', '150.00', '14.00', '13.00', SOURCED)], 'm1') },
    { key: 'apply unapproved, check removed', as: U.ADMIN, call: applyCs('m', 'm2') },
  ], mutant);
  assert.equal(mut['apply unapproved, check removed'], 'ok|applied', `MUTATION: without the approval check an unapproved typo should apply, got ${mut['apply unapproved, check removed']}`);
  console.log('[prover] MUTATION: with the approval check removed an unacknowledged tenfold typo applies -- so the refusal comes from that check');

  // MUTATION: the second read after the engine is what rolls back a floor change landing mid-apply.
  const mutant2 = wrapper.replace(/  -- The second read[\s\S]*?\n  END IF;\n  RETURN v_result;/, '  RETURN v_result;');
  assert.notEqual(mutant2, wrapper, 'the mutation must remove the second read');
  const mut2 = scenario([
    { key: 'arm', as: 'owner', ...ARM_MID_APPLY_FLOOR },
    { key: 'preview', as: U.ADMIN, call: preview('n', [row(B, '20.00', '30.00', '27.00', '30.00', SOURCED)], 'n1') },
    { key: 'approve', as: U.ADMIN, call: approve('n', [ack(B, ['MARGIN_UNDER_FLOOR'])], 'n2') },
    { key: 'apply, second read removed', as: U.ADMIN, call: applyCs('n', 'n3') },
  ], mutant2);
  assert.equal(mut2['apply, second read removed'], 'ok|applied', `MUTATION: without the second read the mid-apply floor change should go unseen, got ${mut2['apply, second read removed']}`);
  console.log('[prover] MUTATION: with the second read removed a floor change landing mid-apply goes unseen -- so that read is what refuses it');

  // The live pricing smoke chain, updated for this migration, must pass on it as it will after apply.
  // Its first check reads the live default-off cost-basis switch, a data row the replay does not carry.
  psql(`DELETE FROM public.app_settings WHERE setting_key = 'supplier_cost_basis_enabled';
    INSERT INTO public.app_settings (setting_key, setting_value) VALUES ('supplier_cost_basis_enabled', 'false');`);
  stageText('phase2-live.sql', lf(path.join(ROOT, 'scripts', 'smoke', 'smoke-supplier-cost-basis-phase2-live.sql')));
  const chain = docker([...psqlArgs(), '-f', '/tmp/phase2-live.sql'], { allowFailure: true });
  assert.match(chain.stderr, /SMOKE_PASS_ROLLBACK supplier_cost_basis_phase2_live/, `the live pricing smoke chain failed on the candidate:\n${chain.stderr}`);
  console.log('[prover] SMOKE CHAIN: smoke-supplier-cost-basis-phase2-live.sql passes on the candidate (approve probes, unapproved apply refused, both routes approved then applied)');

  console.log(`[prover] finished in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log('PRICE_SHEET_WARNINGS_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
