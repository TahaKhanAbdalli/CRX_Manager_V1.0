#!/usr/bin/env node
/**
 * Full-chain proof for 20261009120000_invoicing_admin_only (Mason 2026-10-09: no sales rep, driver
 * or other non-admin may invoice any customer; reps READ every invoice; posting can bind to the
 * version an admin reviewed).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container, replays every ordered post-baseline migration before the candidate plus
 * PR #889's two schema migrations (applied live 2026-10-10; all four #889 migrations are recorded in
 * the container ledger, which the candidate's preflight requires), and then, as the `authenticated`
 * role exactly like a browser session through PostgREST:
 *   0. FIDELITY: every function body the candidate pins hashes (carriage returns stripped) to the
 *      value read from live on 2026-10-09, and so do the policies it replaces;
 *   1. BEFORE (the bug): a sales rep invoices through every wrapped RPC (each call really writes:
 *      creates, edits, posts, unposts, transfers, consolidates, splits, applies credits and
 *      prepayments), a rep's and a driver's delivery completion and a rep's job completion
 *      auto-invoice, a rep's quick delivery creates an invoice, a rep inserts invoice_shares and
 *      invoice_line_allocations rows directly and rewrites a field invoice's field_app_locations
 *      and field_app_location_shares rows directly; a DEACTIVATED admin reverses a write-off; a
 *      rep reads none of an admin's invoices; a stale post (the invoice changed after review)
 *      goes through, also in a real two-session race;
 *   2. AUTOCOMMIT / PREFLIGHT / POSTFLIGHT: outside one transaction the file stops first; every pin
 *      group refuses its own drift; a wrong body pin, a guard that is not first, a late split key
 *      check and an unguarded invoice writer each make the postflight roll the apply back;
 *   3. APPLY: POSTFLIGHT_OK; wrappers, frozen implementations, ACLs, policies and grants;
 *   4. AFTER: every wrapped RPC refuses every non-admin role (sales rep, driver, applicator,
 *      entity_recipient, deactivated admin, a caller with no profile) with 42501
 *      INVOICING_ADMIN_ONLY, nothing written and no invoice number drawn; post_invoice,
 *      unpost_invoice, save_invoice and unpost_invoice_group also while a second session holds the
 *      locks the call would need (so the guard runs before any lock or claim); the split wrapper
 *      refuses a NULL/empty/whitespace key for every role; anon cannot execute; a service_role
 *      caller with no subject is refused; the frozen implementations are closed to every API role;
 *      admins get the same result, database state and per-table row counts as BEFORE, and an
 *      exact replay returns the stored result;
 *   5. READ SIDE: a rep reads every invoice table the invoice pages read, also on another rep's
 *      customer; a driver's reads are unchanged; direct table writes (invoice_shares,
 *      invoice_line_allocations, field_app_locations, field_app_location_shares, write_offs) are
 *      refused;
 *   5b. CUSTOMER NAMES (Decision 2, Mason 2026-10-10): through get_invoice_customer_names a rep
 *      (and an admin) reads id + farm_name, nothing else, of the customers a non-deleted invoice
 *      names, also another rep's; a rep's direct customers read is unchanged (policy not widened);
 *      drivers and every other role get no rows; anon and service_role cannot execute it;
 *   6. DELIVERIES AND JOBS: reps' and drivers' completions (online, offline replay, split order,
 *      partial delivery against an admin's quick-delivery draft) complete with no invoice, the
 *      office notified and the delivery listed under "Delivered, not invoiced"; an admin then bills
 *      it with the same lines the old auto-invoice had; admin completions still auto-draft; a rep's
 *      job completion skips the draft; quick deliveries by reps and drivers make no invoice;
 *      cancel_delivery is unchanged;
 *   7. POSTING VERSION CHECK: a concurrent change between review and post is refused for a single
 *      post, a group post and a batch post (two sessions, under the row locks); a same-key
 *      duplicate waits and replays; an unchanged invoice/group/batch posts, old callers without a
 *      version still work, a replay is not re-checked, every fingerprint leg counts (lines, line
 *      shares, customer shares, a group member added or soft-deleted); a version without a key is
 *      refused; (review round 2) a rep's partial completion racing an admin's post of the draft it
 *      re-sizes never re-sizes a posted invoice, before or after the candidate (posting locks the
 *      order_items the completion holds: one side is aborted as a deadlock);
 *   8. HARD-GUARD SWEEP: no function authenticated can run reaches an invoice write without the
 *      guard unless pinned; a new unguarded writer, a late guard, a DECLARE-initializer writer,
 *      the newly covered tables and spellings, a procedure, an exception handler that swallows the
 *      guard and dynamic SQL are caught; the postflight also refuses an invoice-writing trigger on
 *      a table authenticated can write;
 *   9. CHAINS: the registered chains around these RPCs end exactly as they did before (the ones
 *      that already fail on main are listed with their first error: they give no signal);
 *  10. RE-APPLY: refused, nothing changed;
 *  11. MUTATIONS: one per gate - each turns this prover red; restored, green again.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Debugging only: CRX_PROVER_REUSE_CONTAINER names a kept container whose replay already ran (pre-apply);
// the full proof always builds its own container.
const REUSE = process.env.CRX_PROVER_REUSE_CONTAINER || null;
const NAME = REUSE ?? `crx-invoicing-admin-only-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261009120000_invoicing_admin_only.sql');
const SMOKE = path.join(ROOT, 'scripts', 'smoke');
const CHAIN = path.join(SMOKE, 'smoke-invoicing-admin-only.sql');
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1' || Boolean(REUSE);

// PR #889 (20261007150000 and 20261007150050 applied live 2026-10-10 as ledger versions
// 20261010014555 / 20261010014642; 150100 and 150200 pending). Its two schema migrations are
// replayed from disk once #889 is on this branch's base, else from its reviewed head.
const PR889_HEAD = 'a8434b41f7e03051eb5060c3db600aac0d49a4f7';
const PR889_SCHEMA = ['20261007150000_record_deliveries_billed_outside_crx', '20261007150050_lock_soft_deleted_orders'];
const PR889_DATA = ['20261007150100_mark_spring_2026_deliveries_billed_in_chem_man', '20261007150200_release_reservations_of_deleted_spring_orders'];
// 20260914100700 is live but cannot replay here (storage.objects policies); it must not touch invoices.
const PARKED = new Set(['20260914100700_customer_document_bytes_server_only.sql']);
const SEQUENCES = ['cm_invoice_number_seq', 'cs_invoice_number_seq', 'invoice_number_seq', 'mc_invoice_number_seq'];
// The image's auth.uid() reads only request.jwt.claim.sub; live's (md5 below) falls back to
// request.jwt.claims ->> 'sub'. Install live's exact body.
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';

// md5(replace(prosrc, chr(13), '')) read from live (project rhyzpcqhnizqbxphqdkr) on 2026-10-09
// (after #889's two schema migrations). Live stores apply_prepay_to_invoice,
// create_invoice_from_blend_ticket and save_field_app_invoice with CRLF, a replay with LF.
const WRAPPED = {
  'save_invoice(jsonb,jsonb,text)': 'cb932dc51a680442affde5aeba2eaee3',
  'save_field_app_invoice(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)': '8700762576625bd06a833845d57ddbb6',
  'save_field_app_split_invoice(uuid,uuid,jsonb,jsonb,jsonb,uuid,uuid,text)': '82003fe2895aa1d7c7810559f4fb771a',
  'create_invoice_from_order(uuid,uuid,text,text)': 'a1a91643bd8866823ae359f7e0ec290e',
  'create_split_invoices_from_order(uuid,uuid,text,text)': '398030fbb64006b4750e7e89a61b6cb9',
  'create_invoice_from_blend_ticket(uuid,uuid,text)': 'c520a7301f88f3e96ed7bbc33101c4ef',
  'transfer_job_to_invoice(uuid,uuid,text)': 'b083dd371b091d7b70bb4cdc015c9bc8',
  'transfer_invoice_to_job(uuid,uuid,text)': '7394bd0343c19e98bf746576a56bf6e4',
  'consolidate_draft_invoices(uuid,uuid,text)': '0c8394691ef461ba780fd4ba0e770c51',
  'update_field_app_applied_info(uuid[],text,text,text,uuid,text,numeric,numeric,text,numeric,time without time zone,text,numeric,numeric,text,numeric,time without time zone,text,boolean,boolean,numeric,boolean)': 'e6d5f41411e96cd4453d2209c846645d',
  'update_field_app_invoice_billing(uuid[],text,text,text,date,text,text,jsonb,uuid,text)': '34695e4be9724bf46dc5e962f8f0e478',
  'post_invoice(uuid,text)': '6a5e3ab75bc63936f23eab85383ff6ad',
  'post_invoice_group(uuid,uuid,text)': 'd9e36f0dfb055e3cc68c18793e70dbfc',
  'batch_post_invoices(uuid[],text)': '482bd8cd15728ffc51f83900eaf89b3c',
  'unpost_invoice(uuid,uuid,text)': '161f18c3ccd6126a6fb683c5160f82dc',
  'unpost_invoice_group(uuid,uuid,text)': 'dc476e07621c4c7dc86595442ed1a9f0',
  'batch_void_invoices(uuid[],text,uuid,text)': '32fa9718f29e18c8eff4539e36ac84b3',
  'apply_credit_memo_to_invoice(uuid,uuid,bigint,uuid,text)': 'bcc242c8715aaed81b9455fbc905237f',
  'reverse_credit_memo_application(uuid,text,uuid,text)': '38cea043fc7dae4e65bc8593c95bddfb',
  'apply_prepay_to_invoice(uuid,uuid,bigint,uuid,text)': 'c9377dab8f2534a03af2c27a6e1d510c',
  'batch_apply_all_prepayments(uuid,text)': '1d76228210c474da37c9a3cd91b97b7d',
  'reverse_write_off(uuid,text,uuid,text)': '70ef11ccad193eb6ef5ee88dcba6f8cd',
  'create_quick_delivery(uuid,jsonb,uuid,date,text,uuid,text,boolean)': '69c1d569fb2e9eb913502d59e41a76fe',
};
const CDAI = 'public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)';
const LIVE_BODY_MD5 = {
  ...Object.fromEntries(Object.entries(WRAPPED).map(([s, m]) => [`public.${s}`, m])),
  [CDAI]: 'f8de9f000e40f7bfd8f792012f04fee0',
  'public.complete_job(uuid,jsonb,uuid,text)': '4e4c38e3e8be66e2d24c434bb54c0521',
  'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)': 'a1e9a043f27d3566f8ecf6d5e3a809ab',
  'public._complete_delivery_aggregate_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)': 'b888901587accbee7f7fe4aeb512e683',
  'public._complete_delivery_period_preflight_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)': 'a9f80dc25207eba595e9998409e9ceb9',
  'public.process_offline_action(uuid,text)': '0461eebf65f23ccc8fe3852375eb9c78',
  'public._create_quick_delivery_intent_impl_20260802(uuid,jsonb,uuid,date,text,uuid,text,boolean)': 'f5cc01e983fd1c8aa1e8a7895777a7ab',
  'public.is_admin()': 'f76bf61116c3bd52bd9c6ea125079b73',
  'public.is_sales_rep()': 'fcb3133010fe3f4f56e3be31f709d102',
  'public.check_idempotency(text,text)': 'cb810b6f78d587b8e0f2869f87ded757',
  'public._claim_bound_lifecycle_idempotency(text,text,text,text,jsonb)': '0d6fe6c0c9ea71f11ce8cc233665eba2',
  'public._post_invoice_idem_impl_20260721(uuid,text)': '11626fd7f9d15ad9d507a6979068d5d7',
  'public._post_invoice_public_impl_20260718(uuid,text)': '39b9f427eb843e6cba859a1db62553a8',
  'public.cancel_delivery(uuid,text,uuid,text)': '8528b344f86c7e1aa735e386ea39f2eb',
  'public.batch_cancel_deliveries(uuid[],text,uuid,text)': '25d34db60f098a22a62db53780742eee',
  'public.create_invoice_for_unbilled_delivery(uuid,uuid,text)': 'a7f2531bd09ea6c650063f9661871caa',
  'public.allocate_payment(uuid,bigint,text,text,text,date,text,jsonb,uuid,text)': '6a945a2510d8e788d4e6f03c0c6d7563',
  'public.price_order(uuid,jsonb,uuid,text)': 'ab2bcf3ac499cf78eef1f706d4e9501f',
  'public.next_invoice_number(text)': '7cbf50ddfe3abda50cc241f3374e98a3',
  // PR #889 objects, as applied live.
  'public.guard_invoice_delivery_billed_outside_crx()': '9b05da011973beb1ccca9f49ce5a6895',
  'public.get_dashboard_action_items(integer)': '7098f5204a98631d48b0018559af19f7',
};
// md5(cmd|roles|qual|with_check) of the policies the candidate replaces, read live 2026-10-09.
const LIVE_POLICY_MD5 = {
  'invoices.invoices_select': 'ec85564020388a3efb3c4d8968906ad9',
  'invoice_items.invoice_items_select': 'c02df80cb38993d78d0de20f945cbe7a',
  'invoice_shares.invoice_shares_select': '0da587e780c552489a31bc1765b73e78',
  'invoice_line_shares.invoice_line_shares_select': '0b9cdd77443ad18ca53f1bef97ff764e',
  'invoice_line_share_snapshots.invoice_line_share_snapshots_select': '0162464aed38a378de79388897cd4eb2',
  'field_app_billing_sets.field_app_billing_sets_select': '1e8067c5a457410dff18572e9a170f03',
  // Review round 2: the split billing lines read policy is widened too (read live 2026-10-10).
  'field_app_billing_lines.field_app_billing_lines_select': '54a70c764e751fcacb6fe38d8713ba74',
  'invoices.invoices_insert': '52722e61e9bef7b2ff1a9a2f33cef7be',
  'invoice_items.invoice_items_insert': '52722e61e9bef7b2ff1a9a2f33cef7be',
  'invoice_shares.invoice_shares_insert': 'e5ca188a3e2901d57253b2c007f5a3bf',
  'invoice_line_allocations.invoice_line_alloc_insert': '52722e61e9bef7b2ff1a9a2f33cef7be',
  'write_offs.write_offs_select_admin': '3a62ac9ae6afb0b8195d72a0b07a24da',
  // The field-application invoice child-row write policies (review round 1), read live 2026-10-09.
  'field_app_locations.field_app_locations_insert': '52722e61e9bef7b2ff1a9a2f33cef7be',
  'field_app_locations.field_app_locations_update': '7680ae67028c233ada58f74c302d87bd',
  'field_app_locations.field_app_locations_delete': '0b3f94a02ac505d82e218752005f2c32',
  'field_app_location_shares.field_app_location_shares_insert': '52722e61e9bef7b2ff1a9a2f33cef7be',
  'field_app_location_shares.field_app_location_shares_update': '7680ae67028c233ada58f74c302d87bd',
  'field_app_location_shares.field_app_location_shares_delete': '0b3f94a02ac505d82e218752005f2c32',
  // Decision 2 (Mason 2026-10-10): the customers read policies the candidate must NOT widen, read
  // live 2026-10-10.
  'customers.customers_select': '4d86cb39838dc338ac722922bbb91b5f',
  'customers.customers_select_location_dispatchee': 'a4b57f89a3b63679c902d9bcf25ef25c',
};

const id = (n) => `6f200000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = {
  ADMIN: id('a1'), ADMIN2: id('a2'), ADMIN_OFF: id('a3'), REP: id('b1'), REP_B: id('b2'),
  DRIVER: id('d1'), APPLICATOR: id('e1'), ENTITY: id('e2'), NOPROFILE: id('ee'),
};
const C1 = id('c1');
const C2 = id('c2');
const C3 = id('c3');
// Decision 2 fixtures (created inside rolled-back probes only): a customer named only by a
// customer share, one no invoice names, and one named only by a soft-deleted invoice.
const C4 = id('c4');
const C5 = id('c5');
const C6 = id('c6');
const PROD = id('f1');
const PROD_GAL = id('f2');
const F1 = id('1001');
const F_SHARED = id('1002');
const SVC = id('7001');
const NON_ADMINS = [['sales rep', U.REP], ['driver', U.DRIVER], ['applicator', U.APPLICATOR], ['entity_recipient', U.ENTITY], ['deactivated admin', U.ADMIN_OFF], ['caller with no profile', U.NOPROFILE]];
const ADMIN_ONLY = /^42501\|INVOICING_ADMIN_ONLY: /;

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
function stageText(name, text) {
  const staged = path.join(tmpdir(), `${NAME}-${name}`);
  try {
    writeFileSync(staged, text, 'utf8');
    docker(['cp', staged, `${NAME}:/tmp/${name}`]);
  } finally {
    try { unlinkSync(staged); } catch (e) { if (e.code !== 'ENOENT') console.error(`could not remove staged file ${staged}: ${e.message}`); }
  }
}
function lf(file) { return readFileSync(file, 'utf8').replaceAll('\r\n', '\n'); }
function apply(name) {
  const r = docker([...psqlArgs(), '-1', '-f', `/tmp/${name}`], { allowFailure: true });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}
function applyText(name, sql) {
  stageText(name, sql);
  const r = apply(name);
  assert.equal(r.status, 0, `${name} failed to apply:\n${r.output}`);
}
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function sleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }
function md5(text) { return createHash('md5').update(text, 'utf8').digest('hex'); }
function ready() {
  for (let i = 0; i < 120; i += 1) {
    if (docker(['exec', NAME, 'pg_isready', '-U', 'postgres'], { allowFailure: true }).status === 0) return;
    wait(500);
  }
  throw new Error('disposable PostgreSQL did not become ready');
}
function selected() {
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const candidate = all.indexOf(CANDIDATE);
  assert.ok(candidate >= 0, 'the candidate must be selected for post-baseline replay');
  const before = all.slice(0, candidate);
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!/invoice|idempotency_keys|order_items|\borders\b|deliver/i.test(lf(file)), `${name} now touches invoices; replay it or re-think the skip`);
  }
  return before.filter((f) => !PARKED.has(path.basename(f)) && !PR889_DATA.includes(path.basename(f, '.sql')));
}
function replayPr889(replayed) {
  for (const stem of PR889_SCHEMA) {
    if (replayed.some((f) => path.basename(f, '.sql') === stem)) continue;
    const r = spawnSync('git', ['show', `${PR889_HEAD}:supabase/migrations/${stem}.sql`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`PR #889's ${stem} is not on disk and its head ${PR889_HEAD} is not available here (git fetch origin):\n${r.stderr}`);
    stageText(`pr889-${stem}.sql`, r.stdout.replaceAll('\r\n', '\n'));
    const a = apply(`pr889-${stem}.sql`);
    if (a.status !== 0) throw new Error(`PR #889 replay failed at ${stem}:\n${a.output}`);
  }
  psql(`INSERT INTO supabase_migrations.schema_migrations (version, name, statements) VALUES
    ${[...PR889_SCHEMA, ...PR889_DATA].map((stem, i) => `('2026101000000${i + 1}', '${stem}', ARRAY[]::text[])`).join(',\n    ')};`);
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

function lfBodyMd5(signature) { return scalar(`SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('${signature}');`); }
function policyMd5(table, policy) {
  return scalar(`SELECT md5(cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')) FROM pg_policies WHERE schemaname = 'public' AND tablename = '${table}' AND policyname = '${policy}';`);
}
function sequences() {
  return scalar(`SELECT string_agg(sequencename || '=' || COALESCE(last_value::text, 'none'), ',' ORDER BY sequencename)
    FROM pg_sequences WHERE schemaname = 'public' AND sequencename IN (${SEQUENCES.map((s) => `'${s}'`).join(', ')});`);
}

// ------------------------------------------------------------------------------------------------
// Probes. Every probe is one transaction that always ROLLS BACK.
function asUser(uid, role = 'authenticated') {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"${role}"}', true);\nSELECT set_config('request.jwt.claim.sub', '${uid}', true);\nSET LOCAL ROLE ${role};`;
}
function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);\nSELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function sqlKey(key) {
  if (key === null) return 'NULL::text';
  const escaped = key.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\t', '\\t').replaceAll('\n', '\\n');
  return `E'${escaped}'`;
}
const SEQ_SQL = `(SELECT string_agg(sequencename || '=' || COALESCE(last_value::text, 'none'), ',' ORDER BY sequencename)
    FROM pg_sequences WHERE schemaname = 'public' AND sequencename IN (${SEQUENCES.map((s) => `'${s}'`).join(', ')}))`;
const COUNT_TABLES = ['invoices', 'invoice_items', 'invoice_shares', 'invoice_line_shares', 'invoice_line_share_snapshots', 'invoice_line_allocations',
  'split_invoice_creation_claims', 'commissions', 'financial_audit_log', 'idempotency_keys', 'credit_memo_applications', 'prepay_applications',
  'field_app_billing_sets', 'notifications',
  // Review round 2: the remaining invoice child tables, so a refused call that left rows there and
  // an admin call that writes a different number of them both show.
  'field_app_billing_lines', 'field_app_locations', 'field_app_location_shares', 'write_offs'];
/** Per-table row-count change of one probe ("CNT1 - CNT0", comma separated). */
function countDelta(counts) {
  const [a, b] = counts.map((c) => (c ?? '').split(',').map(Number));
  return b.map((n, i) => n - a[i]).join(',');
}
const COUNT_SQL = COUNT_TABLES.map((t) => `(SELECT count(*) FROM public.${t})`).join(" || ',' || ");
// What a call left behind, independent of generated ids, numbers and timestamps.
// Only rows created in the probe's own transaction (created_at = now()), so committed fixtures from other
// sections never enter the comparison.
const STATE_SQL = `md5(COALESCE((SELECT string_agg(i.invoice_type || ':' || i.status || ':' || i.customer_id || ':' || i.total_amount_cents || ':' || COALESCE(i.total_cost_cents, 0)
      || ':' || COALESCE(i.paid_amount_cents, 0) || ':' || (i.invoice_group_id IS NULL) || ':' || COALESCE(i.order_id::text, '-') || ':' || COALESCE(i.job_id::text, '-') || ':' || COALESCE(i.purchase_order_ref, '-')
      || ':' || COALESCE(i.created_by::text, '-') || ':' || (i.deleted_at IS NULL),
      ',' ORDER BY i.invoice_type, i.status, i.customer_id, i.total_amount_cents, COALESCE(i.purchase_order_ref, '-'), i.invoice_group_id IS NULL) FROM public.invoices i WHERE i.created_at = now()), '')
  || '|' || COALESCE((SELECT string_agg(ii.product_id || ':' || ii.quantity || ':' || ii.unit_price_cents || ':' || ii.extended_cents, ',' ORDER BY ii.product_id, ii.quantity, ii.extended_cents) FROM public.invoice_items ii WHERE ii.created_at = now()), '')
  || '|' || COALESCE((SELECT string_agg(s.customer_id || ':' || s.amount_cents, ',' ORDER BY s.customer_id, s.amount_cents) FROM public.invoice_shares s WHERE s.created_at = now()), '')
  || '|' || (SELECT count(*) FROM public.credit_memo_applications) || '|' || (SELECT count(*) FROM public.prepay_applications)
  || '|' || COALESCE((SELECT string_agg(j.status, ',' ORDER BY j.job_number) FROM public.jobs j WHERE j.created_at = now()), '')
  || '|' || COALESCE((SELECT string_agg(o.status, ',' ORDER BY o.order_number) FROM public.orders o WHERE o.created_at = now()), ''))`;

/**
 * Run `call` (an SQL expression) as `uid` after `fixture` (run as the owner), caught in a DO block
 * (RESULT|ok|<value> or RESULT|<sqlstate>|<message>). Reports the result, an optional exact replay,
 * the invoice-number sequences and the table counts read in the same transaction before and after
 * the call, and the normalized database state after it.
 */
function attempt(uid, fixture, call, { replay = false, role = 'authenticated', lockTimeout = null, after = '', statement = false } = {}) {
  // A statement reports the number of rows it touched (ROW_COUNT), so "ok|0" is a no-op write.
  const once = (tag) => `DO $${tag}$
DECLARE v text; n bigint;
BEGIN
  ${statement ? `${call}; GET DIAGNOSTICS n = ROW_COUNT; v := n::text;` : `v := (${call})::text;`}
  RAISE NOTICE '${tag.toUpperCase()}|ok|%', COALESCE(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '${tag.toUpperCase()}|%|%', SQLSTATE, SQLERRM;
END
$${tag}$;`;
  const sql = `BEGIN;
${fixture}
RESET ROLE;
SELECT 'SEQ0|' || ${SEQ_SQL};
SELECT 'CNT0|' || ${COUNT_SQL};
${asUser(uid, role)}
${lockTimeout ? `SET LOCAL lock_timeout = '${lockTimeout}';` : ''}
${once('result')}
${replay ? once('replay') : ''}
RESET ROLE;
SELECT 'SEQ1|' || ${SEQ_SQL};
SELECT 'CNT1|' || ${COUNT_SQL};
SELECT 'STATE|' || ${STATE_SQL};
${after}
ROLLBACK;
`;
  const r = docker([...psqlArgs(), '-A', '-t'], { input: sql, allowFailure: true });
  assert.equal(r.status, 0, `probe failed to run:\n${r.stderr}\n--- SQL ---\n${sql}`);
  const result = /RESULT\|([^\n]*)/.exec(r.stderr)?.[1];
  assert.ok(result !== undefined, `probe printed no RESULT:\n${r.stderr}`);
  const line = (tag) => r.stdout.split(/\r?\n/).find((l) => l.startsWith(`${tag}|`))?.slice(tag.length + 1);
  return {
    result: result.trimEnd(),
    replay: replay ? /REPLAY\|([^\n]*)/.exec(r.stderr)?.[1]?.trimEnd() : undefined,
    seq: [line('SEQ0'), line('SEQ1')],
    counts: [line('CNT0'), line('CNT1')],
    state: line('STATE'),
    lines: r.stdout.split(/\r?\n/).filter(Boolean),
    stderr: r.stderr,
  };
}
/**
 * The refusal and its sequence check. The count check cannot fail for a call that raises (its
 * subtransaction rolls back every row it wrote, whatever the order), so it is NOT evidence that
 * the guard ran first: the no-number-drawn check (sequences are non-transactional) and the
 * held-lock cases are.
 */
function expectRefused(a, expected, label) {
  assert.match(a.result, expected, `${label}: wrong outcome ${a.result}`);
  assert.equal(a.seq[1], a.seq[0], `${label}: the refused call drew an invoice number`);
  assert.equal(a.counts[1], a.counts[0], `${label}: the refused call left rows behind`);
}
/** Normalize generated ids, invoice/order/delivery/job numbers and timestamps in an RPC result. */
function normalize(text) {
  return text
    .replace(/\b(?!6f200000-)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    .replace(/\b[A-Z]{2,4}-\d{4}-\d{4,6}\b/g, '<num>')
    .replace(/\bDEL-\d+\b/g, '<del>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:\d{2})?|Z)?/g, '<ts>');
}

// ------------------------------------------------------------------------------------------------
// Fixtures (SQL run as the owner inside the probe transaction).
function orderSql(orderId, customer, label, { qty = 10 } = {}) {
  return `INSERT INTO public.orders (id, order_number, customer_id, order_date, status, booking_draw)
    VALUES ('${orderId}', 'PROVER-AO-${label}', '${customer}', (now() AT TIME ZONE 'America/Chicago')::date, 'confirmed', false);
  INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining, unit_size)
    VALUES ('${itemOf(orderId)}', '${orderId}', '${PROD}', '[PROVER] admin-only line ${label}', 10, 6, ${qty}, ${qty * 10}, ${qty * 4}, 40, 0, ${qty}, 'GL');`;
}
function itemOf(orderId) { return `${orderId.slice(0, -4)}9${orderId.slice(-3)}`; }
function deliverySql(deliveryId, orderId, customer, driver, label, { qty = 10 } = {}) {
  return `INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, assigned_driver, scheduled_date, status, created_by)
    VALUES ('${deliveryId}', 'PROVER-AO-DEL-${label}', '${orderId}', '${customer}', ${driver ? `'${driver}'` : 'NULL'}, (now() AT TIME ZONE 'America/Chicago')::date, 'scheduled', '${U.ADMIN}');
  INSERT INTO public.delivery_items (id, delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
    VALUES ('${deliveryId.slice(0, -4)}8${deliveryId.slice(-3)}', '${deliveryId}', '${itemOf(orderId)}', '${PROD}', ${qty}, 0, 'GL');
  UPDATE public.deliveries SET status = 'in_progress' WHERE id = '${deliveryId}';`;
}
function jobSql(jobId, label) {
  return `INSERT INTO public.jobs (id, job_number, customer_id, status, job_date, season, total_acres, total_price_cents, total_cost_cents, created_by)
    VALUES ('${jobId}', 'PROVER-AO-JOB-${label}', '${C1}', 'scheduled', (now() AT TIME ZONE 'America/Chicago')::date - 1,
            extract(year FROM (now() AT TIME ZONE 'America/Chicago'))::int, 120, 25000, 10000, '${U.ADMIN}');
  INSERT INTO public.job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES ('${jobId}', '${F1}', 120, 1);
  INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit, cost_per_unit_cents, price_per_unit_cents, sort_order)
    VALUES ('${jobId}', '${PROD}', 10, 'GL', 1.0, 'PT', 1000, 2500, 1);`;
}
function setAutoDraft(on) { return `UPDATE public.app_settings SET setting_value = '${on}' WHERE setting_key = 'auto_draft_invoice_on_job_completion';`; }
function completedJobSql(jobId, label) {
  return `${jobSql(jobId, label)}
  ${claims(U.ADMIN)}
  ${setAutoDraft(false)}
  SELECT public.start_job('${jobId}', '${U.ADMIN}', 'prover-ao-sj-${label}') IS NOT NULL;
  SELECT public.complete_job('${jobId}', '{"notes":"[PROVER]"}'::jsonb, '${U.ADMIN}', 'prover-ao-cj-${label}') IS NOT NULL;
  ${setAutoDraft(true)}`;
}
function fieldInvoiceSql(jobId, label) {
  return `${completedJobSql(jobId, label)}
  SELECT set_config('prover.fa', (public.transfer_job_to_invoice('${jobId}', '${U.ADMIN}', 'prover-ao-tji-${label}')->>'invoice_id'), true);`;
}
function miscDraftSql(guc, label, cents = 1500, customer = C1) {
  return `${claims(U.ADMIN)}
  SELECT set_config('${guc}', public.save_invoice(jsonb_build_object('customer_id', '${customer}', 'invoice_type', 'misc_charge', 'status', 'draft',
    'invoice_date', (now() AT TIME ZONE 'America/Chicago')::date, 'header_notes', '[PROVER] ${label}'),
    jsonb_build_array(jsonb_build_object('description', '[PROVER] fee ${label}', 'quantity', 1, 'unit_price_cents', ${cents}, 'extended_cents', ${cents})),
    'prover-ao-misc-${label}')::text, true);`;
}
function postedMiscSql(guc, label) {
  return `${miscDraftSql(guc, label)}
  SELECT public.post_invoice(current_setting('${guc}')::uuid, 'prover-ao-post-${label}') IS NULL;`;
}
/** A posted invoice with one write-off (prover.wo). */
function writeOffSql(label) {
  return `${postedMiscSql('prover.inv', `wo-${label}`)}
    ${claims(U.ADMIN)} SELECT set_config('prover.wo', (public.apply_write_off(current_setting('prover.inv')::uuid, 100, '[PROVER] wo', '${U.ADMIN}', 'prover-ao-wo-${label}'))::text, true);
    SELECT set_config('prover.wo', COALESCE((SELECT id::text FROM public.write_offs WHERE invoice_id = current_setting('prover.inv')::uuid LIMIT 1), current_setting('prover.wo')), true);`;
}
const SPLIT_JOB = id('4003');
function faSplitGroupSql(label, job = SPLIT_JOB) {
  return `INSERT INTO public.jobs (id, job_number, customer_id, status, job_date, total_acres, created_by)
    VALUES ('${job}', 'PROVER-AO-SPLITJOB-${label}', '${C1}', 'completed', (now() AT TIME ZONE 'America/Chicago')::date, 100, '${U.ADMIN}');
  INSERT INTO public.job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES ('${job}', '${F_SHARED}', 100, 0);`;
}
function faSplitCall(uid, key, job = SPLIT_JOB) {
  return `public.save_field_app_split_invoice(NULL, '${job}', jsonb_build_object('invoice_date', ((now() AT TIME ZONE 'America/Chicago')::date)::text),
    jsonb_build_array(jsonb_build_object('field_id', '${F_SHARED}', 'applied_acres', 100)),
    jsonb_build_array(jsonb_build_object('line_kind', 'service', 'application_service_id', '${SVC}', 'description', '[PROVER] Svc', 'source_acres', 100, 'manual_override', true, 'source_unit_price_cents', 100)),
    '${uid}', NULL, ${sqlKey(key)})`;
}
function faGroupSql(label, { posted = false, job = SPLIT_JOB } = {}) {
  return `${faSplitGroupSql(label, job)}
  ${claims(U.ADMIN)}
  SELECT set_config('prover.group', (${faSplitCall(U.ADMIN, `prover-ao-fas-${label}`, job)})->>'invoice_group_id', true);
  ${posted ? `SELECT public.post_invoice_group(current_setting('prover.group')::uuid, '${U.ADMIN}', 'prover-ao-gp-${label}') IS NOT NULL;` : ''}`;
}
function blendSql() {
  return `INSERT INTO public.blend_tickets (id, ticket_number, uploaded_by, customer_id, status, review_status, payment_status, season, total_acres, source)
    VALUES ('${id('5001')}', 'PROVER-AO-BT', '${U.ADMIN}', '${C1}', 'completed', 'approved', 'unbilled', current_season(), 10, 'manual');
  INSERT INTO public.blend_ticket_fields (blend_ticket_id, field_id, customer_id, actual_acres) VALUES ('${id('5001')}', '${F1}', '${C1}', 10);
  INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, rate_per_acre, sequence_order)
    VALUES ('${id('5001')}', '${PROD_GAL}', '[PROVER] BTP', 20, 2, 1);`;
}
const TARGET = id('6001');
const MEMO = id('6002');
function creditSql() {
  return `INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by)
    VALUES ('${TARGET}', 'PROVER-AO-TARGET', '${C1}', 'misc_charge', 'draft', (now() AT TIME ZONE 'America/Chicago')::date, (now() AT TIME ZONE 'America/Chicago')::date + 30, 10000, '${U.ADMIN}');
  UPDATE public.invoices SET status = 'posted', posted_by = '${U.ADMIN}', posted_at = now() WHERE id = '${TARGET}';
  INSERT INTO public.invoices (id, invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by)
    VALUES ('${MEMO}', 'PROVER-AO-MEMO', '${C1}', 'credit_memo', 'draft', (now() AT TIME ZONE 'America/Chicago')::date, -3000, '${U.ADMIN}');
  UPDATE public.invoices SET status = 'posted', posted_by = '${U.ADMIN}', posted_at = now() WHERE id = '${MEMO}';`;
}
function creditApplicationSql() {
  return `${creditSql()}
  ${claims(U.ADMIN)}
  SELECT set_config('prover.cma', public.apply_credit_memo_to_invoice('${MEMO}', '${TARGET}', 1000, '${U.ADMIN}', 'prover-ao-cma')::text, true);`;
}
function prepaySql() {
  return `${creditSql()}
  ${claims(U.ADMIN)}
  SELECT public.create_prepay_check_splits('${C1}', 'PROVER-AO-CHK', jsonb_build_array(jsonb_build_object('label', 'Chemicals', 'amount_cents', 2000)), '${U.ADMIN}', 'prover-ao-prepay', 2000) IS NOT NULL;
  SELECT set_config('prover.prepay', (SELECT id::text FROM public.prepay_credits WHERE customer_id = '${C1}' ORDER BY created_at LIMIT 1), true);`;
}
const O = { CIFO: id('2001'), SPLIT: id('2002'), CONS: id('2003') };
function consolidateSql() {
  return `${orderSql(O.CONS, C1, 'CONS')}
  INSERT INTO public.invoices (id, invoice_number, customer_id, order_id, invoice_type, status, invoice_date, total_amount_cents, created_by) VALUES
    ('${id('6101')}', 'PROVER-AO-D1', '${C1}', '${O.CONS}', 'chemical_sale', 'draft', (now() AT TIME ZONE 'America/Chicago')::date, 0, '${U.ADMIN}'),
    ('${id('6102')}', 'PROVER-AO-D2', '${C1}', '${O.CONS}', 'chemical_sale', 'draft', (now() AT TIME ZONE 'America/Chicago')::date, 0, '${U.ADMIN}');`;
}
const FA_LOCATIONS = `jsonb_build_array(jsonb_build_object('field_id', '${F1}', 'map_number', 1, 'total_acres', 120, 'applied_acres', 120, 'sort_order', 0))`;
const FA_CHEMICALS = `jsonb_build_array(jsonb_build_object('product_id', '${PROD}', 'description', '[PROVER] Chem', 'quantity', 0, 'unit_size', 'GL', 'unit_price_cents', NULL, 'cost_cents', 0, 'sort_order', 0, 'rate_per_acre', 1.0, 'rate_unit', 'GL', 'manual_override', false))`;

/**
 * Every wrapped RPC with a fixture under which a sales rep's call really writes before the
 * candidate, and the call itself (as `uid`, with `key`).
 */
const CASES = [
  { n: 'save_invoice', fx: () => '', call: (uid, key) => `public.save_invoice(jsonb_build_object('customer_id', '${C1}', 'invoice_type', 'misc_charge', 'status', 'draft', 'invoice_date', (now() AT TIME ZONE 'America/Chicago')::date, 'header_notes', '[PROVER] case'), '[]'::jsonb, ${sqlKey(key)})` },
  { n: 'save_field_app_invoice', fx: () => fieldInvoiceSql(id('4001'), 'safi'), call: (uid, key) => `public.save_field_app_invoice(current_setting('prover.fa')::uuid, jsonb_build_object('invoice_date', (SELECT invoice_date::text FROM public.invoices WHERE id = current_setting('prover.fa')::uuid), 'header_notes', '[PROVER] edited'), ${FA_LOCATIONS}, ${FA_CHEMICALS}, '${uid}', NULL, ${sqlKey(key)})` },
  { n: 'save_field_app_split_invoice', fx: () => faSplitGroupSql('case'), call: (uid, key) => faSplitCall(uid, key) },
  { n: 'create_invoice_from_order', fx: () => orderSql(O.CIFO, C1, 'CIFO'), call: (uid, key) => `public.create_invoice_from_order('${O.CIFO}', NULL, 'chemical_sale', ${sqlKey(key)})` },
  { n: 'create_split_invoices_from_order', fx: () => `${orderSql(O.SPLIT, C1, 'SPLIT')} INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres) VALUES ('${itemOf(O.SPLIT)}', '${F1}', 10);`, call: (uid, key) => `public.create_split_invoices_from_order('${O.SPLIT}', NULL, 'chemical_sale', ${sqlKey(key)})` },
  { n: 'create_invoice_from_blend_ticket', fx: () => blendSql(), call: (uid, key) => `public.create_invoice_from_blend_ticket('${id('5001')}', '${uid}', ${sqlKey(key)})` },
  { n: 'transfer_job_to_invoice', fx: () => completedJobSql(id('4002'), 'tji'), call: (uid, key) => `public.transfer_job_to_invoice('${id('4002')}', '${uid}', ${sqlKey(key)})` },
  { n: 'transfer_invoice_to_job', fx: () => fieldInvoiceSql(id('4004'), 'itj'), call: (uid, key) => `public.transfer_invoice_to_job(current_setting('prover.fa')::uuid, '${uid}', ${sqlKey(key)})` },
  { n: 'consolidate_draft_invoices', fx: () => consolidateSql(), call: (uid, key) => `public.consolidate_draft_invoices('${O.CONS}', '${uid}', ${sqlKey(key)})` },
  { n: 'update_field_app_applied_info', fx: () => fieldInvoiceSql(id('4005'), 'applied'), call: (uid, key) => `public.update_field_app_applied_info(ARRAY[current_setting('prover.fa')::uuid], 'NW', '70F', '[PROVER] Applicator', '${uid}', ${sqlKey(key)})`,
    effect: () => "(SELECT applicator_name = '[PROVER] Applicator' FROM public.invoices WHERE id = current_setting('prover.fa')::uuid)" },
  { n: 'update_field_app_invoice_billing', fx: () => fieldInvoiceSql(id('4006'), 'billing'), call: (uid, key) => `public.update_field_app_invoice_billing(ARRAY[current_setting('prover.fa')::uuid], 'PROVER-PO', NULL, NULL, NULL, NULL, NULL, '{}'::jsonb, '${uid}', ${sqlKey(key)})`,
    effect: () => "(SELECT purchase_order_ref = 'PROVER-PO' FROM public.invoices WHERE id = current_setting('prover.fa')::uuid)" },
  { n: 'post_invoice', fx: () => miscDraftSql('prover.inv', 'post'), call: (uid, key) => `public.post_invoice(current_setting('prover.inv')::uuid, ${sqlKey(key)})`,
    effect: () => "(SELECT status = 'posted' FROM public.invoices WHERE id = current_setting('prover.inv')::uuid)" },
  { n: 'post_invoice_group', fx: () => faGroupSql('gpost'), call: (uid, key) => `public.post_invoice_group(current_setting('prover.group')::uuid, '${uid}', ${sqlKey(key)})`,
    effect: () => "(SELECT bool_and(status = 'posted') FROM public.invoices WHERE invoice_group_id = current_setting('prover.group')::uuid AND deleted_at IS NULL)" },
  { n: 'batch_post_invoices', fx: () => miscDraftSql('prover.inv', 'batch'), call: (uid, key) => `public.batch_post_invoices(ARRAY[current_setting('prover.inv')::uuid], ${sqlKey(key)})`,
    // The pre-candidate batch catches each post's error and still binds a receipt: require the post itself.
    effect: () => "(SELECT status = 'posted' FROM public.invoices WHERE id = current_setting('prover.inv')::uuid)" },
  { n: 'unpost_invoice', fx: () => postedMiscSql('prover.inv', 'unpost'), call: (uid, key) => `public.unpost_invoice(current_setting('prover.inv')::uuid, '${uid}', ${sqlKey(key)})`,
    effect: () => "(SELECT status <> 'posted' FROM public.invoices WHERE id = current_setting('prover.inv')::uuid)" },
  { n: 'unpost_invoice_group', fx: () => faGroupSql('gunpost', { posted: true }), call: (uid, key) => `public.unpost_invoice_group(current_setting('prover.group')::uuid, '${uid}', ${sqlKey(key)})`,
    effect: () => "(SELECT bool_and(status <> 'posted') FROM public.invoices WHERE invoice_group_id = current_setting('prover.group')::uuid AND deleted_at IS NULL)" },
  // Reps were already refused (void is admin-only): wrapping only gives them the same clean error.
  { n: 'batch_void_invoices', fx: () => postedMiscSql('prover.inv', 'bvoid'), call: (uid, key) => `public.batch_void_invoices(ARRAY[current_setting('prover.inv')::uuid], '[PROVER] void', '${uid}', ${sqlKey(key)})`, repBefore: /^P0001\|Only admin users can void invoices$/ },
  { n: 'apply_credit_memo_to_invoice', fx: () => creditSql(), call: (uid, key) => `public.apply_credit_memo_to_invoice('${MEMO}', '${TARGET}', 1000, '${uid}', ${sqlKey(key)})` },
  { n: 'reverse_credit_memo_application', fx: () => creditApplicationSql(), call: (uid, key) => `public.reverse_credit_memo_application(current_setting('prover.cma')::uuid, '[PROVER] reverse', '${uid}', ${sqlKey(key)})` },
  { n: 'apply_prepay_to_invoice', fx: () => prepaySql(), call: (uid, key) => `public.apply_prepay_to_invoice(current_setting('prover.prepay')::uuid, '${TARGET}', 500, '${uid}', ${sqlKey(key)})` },
  // Hard-disabled for EVERY role since 20260620200000 (prepay double-spend guard).
  { n: 'batch_apply_all_prepayments', fx: () => '', call: (uid, key) => `public.batch_apply_all_prepayments('${uid}', ${sqlKey(key)})`, repBefore: /^P0001\|PREPAY_BULK_APPLY_DISABLED$/, adminBefore: /^P0001\|PREPAY_BULK_APPLY_DISABLED$/ },
  // Reps were already refused, but its role test is NULL (not true) for a caller with no active
  // profile, so a DEACTIVATED admin could reverse a write-off (review round 1): the BEFORE bug.
  { n: 'reverse_write_off', fx: () => writeOffSql('case'), call: (uid, key) => `public.reverse_write_off(current_setting('prover.wo')::uuid, '[PROVER] reverse', '${uid}', ${sqlKey(key)})`, repBefore: /^P0001\|Admin access required to reverse write-offs$/, bugBefore: U.ADMIN_OFF },
];
const QUICK_CALL = (uid, key, skip = false, driver = null) => `public.create_quick_delivery('${C1}', jsonb_build_array(jsonb_build_object('product_id', '${PROD}', 'quantity', 2)), ${driver ? `'${driver}'` : 'NULL'}, (now() AT TIME ZONE 'America/Chicago')::date, NULL, '${uid}', ${sqlKey(key)}, ${skip})`;

// ------------------------------------------------------------------------------------------------
// Two-session helpers (live-like interleavings; observed through pg_stat_activity, not sleeps).
function session(appName) {
  const child = spawn('docker', ['exec', '-i', '-e', `PGAPPNAME=${appName}`, NAME, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { cwd: ROOT });
  const s = { child, out: '', err: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { s.out += d; });
  child.stderr.on('data', (d) => { s.err += d; });
  s.done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  // psql exits on its first error (ON_ERROR_STOP); a later write must not crash the prover.
  child.stdin.on('error', () => {});
  return s;
}
async function until(check, label, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}
/** Hold `holdSql` (locks) in a second session while `uid` attempts `call` with a short lock_timeout. */
async function heldAttempt(uid, fixtureCommitted, holdSql, call, label) {
  const holder = session(`crx_ao_hold_${label.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`);
  holder.child.stdin.write(`BEGIN;\n${holdSql}\n\\echo HOLDING\n`);
  try {
    await until(() => holder.out.includes('HOLDING') || holder.err.includes('ERROR'), `${label}: holder session`);
    assert.doesNotMatch(holder.err, /ERROR/, `${label}: the holder session failed:\n${holder.err}`);
    return attempt(uid, fixtureCommitted, call, { lockTimeout: '3s' });
  } finally {
    holder.child.stdin.end('ROLLBACK;\n');
    await holder.done;
  }
}

/**
 * Ordering evidence: the locks each call would take first, held by a second session. A guard that
 * runs first refuses at once; anything that locks first waits and ends in a lock timeout (55P03).
 * unpost_invoice_group matters most: its frozen body unposts each member through the (guarded)
 * unpost_invoice wrapper, so only the held-lock check shows that ITS OWN guard runs before the
 * group locks.
 */
function heldLockCases(inv, group) {
  return {
    post_invoice: ['post_invoice', `SELECT 1 FROM public.invoices WHERE id = '${inv}' FOR UPDATE; SELECT pg_advisory_xact_lock(hashtextextended('crx:idempotency:prover-ao-held-post', 0)); SELECT pg_advisory_xact_lock(hashtextextended('post_invoice:prover-ao-held-post', 0));`,
      () => `public.post_invoice('${inv}', 'prover-ao-held-post')`],
    unpost_invoice: ['unpost_invoice', `SELECT 1 FROM public.invoices WHERE id = '${inv}' FOR UPDATE; SELECT pg_advisory_xact_lock(hashtextextended('crx:idempotency:prover-ao-held-unpost', 0));`,
      (uid) => `public.unpost_invoice('${inv}', '${uid}', 'prover-ao-held-unpost')`],
    save_invoice: ['save_invoice', "SELECT pg_advisory_xact_lock(hashtextextended('crx:idempotency:prover-ao-held-save', 0));",
      () => `public.save_invoice(jsonb_build_object('customer_id', '${C1}', 'invoice_type', 'misc_charge', 'status', 'draft', 'invoice_date', CURRENT_DATE), '[]'::jsonb, 'prover-ao-held-save')`],
    unpost_invoice_group: ['unpost_invoice_group', `SELECT 1 FROM public.invoices WHERE invoice_group_id = '${group}' ORDER BY id FOR UPDATE; SELECT pg_advisory_xact_lock(hashtextextended('${group}', 0)); SELECT pg_advisory_xact_lock(hashtextextended('crx:idempotency:prover-ao-held-ugroup', 0));`,
      (uid) => `public.unpost_invoice_group('${group}', '${uid}', 'prover-ao-held-ugroup')`],
  };
}

// ------------------------------------------------------------------------------------------------
// Seed (committed).
function seed() {
  const users = [
    [U.ADMIN, 'admin', 'Admin', 9], [U.ADMIN2, 'admin', 'Admin Two', 8], [U.ADMIN_OFF, 'admin', 'Deactivated Admin', 7],
    [U.REP, 'sales_rep', 'Rep', 6], [U.REP_B, 'sales_rep', 'Rep B', 5], [U.DRIVER, 'driver', 'Driver', 4],
    [U.APPLICATOR, 'applicator', 'Applicator', 3], [U.ENTITY, 'entity_recipient', 'Entity Recipient', 2],
  ];
  // Deactivating a profile syncs auth.users.banned_until (live GoTrue column the image's stub
  // auth.users lacks); add it so the deactivated admin is made the way production makes one.
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'ao-prover-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    ${claims(U.ADMIN)}
    UPDATE public.profiles SET is_active = false WHERE id = '${U.ADMIN_OFF}';
    INSERT INTO public.customers (id, farm_name, assigned_sales_rep, is_active) VALUES
      ('${C1}', '[PROVER] Rep Farm', '${U.REP}', true),
      ('${C2}', '[PROVER] Rep Farm Two', '${U.REP}', true),
      ('${C3}', '[PROVER] Rep B Farm', '${U.REP_B}', true);
    -- One priced product per unit (governed pricing trigger off for the prover's own catalog only).
    ALTER TABLE public.products DISABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, product_form, epa_registration)
      VALUES ('${PROD}', '[PROVER] Admin-only Product', 'GL', 6.00, 10.00, 'liquid', 'PROVER-EPA-1');
    INSERT INTO public.products (id, product_name, unit_size, current_cost, tier1_price, rate_unit)
      VALUES ('${PROD_GAL}', '[PROVER] Blend Product', 'gal', 6.00, 10.00, 'gal');
    ALTER TABLE public.products ENABLE TRIGGER trigger_y_require_governed_product_pricing;
    INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
      VALUES ('${PROD}', 'Main Warehouse', 100000, 0, 'GL');
    INSERT INTO public.fields (id, customer_id, field_name, crop_type, total_acres) VALUES
      ('${F1}', '${C1}', '[PROVER] Field', 'soybeans', 120),
      ('${F_SHARED}', '${C1}', '[PROVER] Shared Field', 'corn', 100);
    INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES
      ('${F_SHARED}', '${C1}', 50, true), ('${F_SHARED}', '${C2}', 50, false);
    INSERT INTO public.application_services (id, name, is_active) VALUES ('${SVC}', '[PROVER] Service', true);
    INSERT INTO public.app_settings (setting_key, setting_value) VALUES
      ('auto_draft_invoice_on_job_completion', 'true'), ('per_line_split_billing_enabled', 'true')
      ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value;
    COMMIT;`);
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '6f200000-%';`),
    'admin:true,admin:true,admin:false,sales_rep:true,sales_rep:true,driver:true,applicator:true,entity_recipient:true', 'the seeded roles are not what the proof needs');
}
function activeAdmins() { return Number(scalar("SELECT count(*) FROM public.profiles WHERE role = 'admin' AND is_active = true;")); }
function activeAdminIds() { return scalar("SELECT string_agg(id::text, ',' ORDER BY id) FROM public.profiles WHERE role = 'admin' AND is_active = true;"); }

// ------------------------------------------------------------------------------------------------
// Sections run in both phases.

/** Every wrapped RPC as each actor; returns the per-case admin outcomes for the before/after comparison. */
function invoicingMatrix(phase) {
  const admin = {};
  for (const c of CASES) {
    const fixture = c.fx();
    if (phase === 'before') {
      // Review round 2: where the call's point is to change an invoice (post, unpost, the
      // field-app header updates), the rep's call must have changed it, not just written a
      // receipt or an audit row.
      const rep = attempt(U.REP, fixture, c.call(U.REP, `prover-ao-${c.n}-rep`), { after: c.effect ? `SELECT 'EFFECT|' || COALESCE((${c.effect()})::text, 'null');` : '' });
      if (c.effect) assert.ok(rep.lines.includes('EFFECT|true'), `BEFORE ${c.n}: the rep's call did not change the invoice, so the bug did not reproduce: ${rep.result} ${rep.lines.find((l) => l.startsWith('EFFECT|'))}`);
      if (c.bugBefore) {
        const bug = attempt(c.bugBefore, fixture, c.call(c.bugBefore, `prover-ao-${c.n}-bug`));
        assert.match(bug.result, /^ok\|/, `BEFORE ${c.n}: the non-admin it should have let through was refused, so the bug did not reproduce: ${bug.result}`);
        assert.notEqual(bug.counts[1], bug.counts[0], `BEFORE ${c.n}: the non-admin's call wrote nothing`);
      }
      if (c.repBefore) assert.match(rep.result, c.repBefore, `BEFORE ${c.n}: unexpected rep outcome ${rep.result}`);
      else {
        assert.match(rep.result, /^ok\|/, `BEFORE ${c.n}: a sales rep could not invoice through it, so the bug did not reproduce: ${rep.result}`);
        assert.notEqual(rep.counts[1], rep.counts[0], `BEFORE ${c.n}: the rep's call wrote nothing`);
      }
    } else {
      for (const [who, uid] of NON_ADMINS) {
        expectRefused(attempt(uid, fixture, c.call(uid, `prover-ao-${c.n}-${who}`)), ADMIN_ONLY, `AFTER ${c.n} as ${who}`);
      }
      const anon = attempt(U.REP, fixture, c.call(U.REP, `prover-ao-${c.n}-anon`), { role: 'anon' });
      assert.match(anon.result, /^42501\|permission denied for function /, `AFTER ${c.n}: anon could execute it: ${anon.result}`);
    }
    const a = attempt(U.ADMIN, fixture, c.call(U.ADMIN, `prover-ao-${c.n}-admin`), { replay: true });
    if (c.adminBefore) assert.match(a.result, c.adminBefore, `${phase} ${c.n}: unexpected admin outcome ${a.result}`);
    else assert.match(a.result, /^ok\|/, `${phase} ${c.n}: the admin call failed: ${a.result}`);
    if (a.result.startsWith('ok|')) assert.equal(a.replay, a.result, `${phase} ${c.n}: the admin's exact replay did not return the stored result`);
    // Review round 2: plus how many rows the admin's call (and its replay) added to each counted table.
    admin[c.n] = { result: normalize(a.result), replay: a.replay && normalize(a.replay), state: a.state, seqMoved: a.seq[0] !== a.seq[1], delta: countDelta(a.counts) };
  }
  return admin;
}

function splitKeyChecks() {
  for (const [label, key] of [['NULL', null], ['empty', ''], ['whitespace', '\t\n ']]) {
    for (const [who, uid] of [['admin', U.ADMIN], ...NON_ADMINS]) {
      const c = CASES.find((x) => x.n === 'create_split_invoices_from_order');
      expectRefused(attempt(uid, c.fx(), c.call(uid, key)), /^22023\|IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order$/, `split with a ${label} key as ${who}`);
    }
  }
}

/** Direct table writes and reads as authenticated (PostgREST's path). */
function tableAccess(phase) {
  // C3 belongs to REP_B, not to U.REP: "reps read ALL invoices" must include another rep's customer
  // (a rep-scoped read policy - the scoping Mason rejected - would hide it).
  const fixture = `${miscDraftSql('prover.inv', `read-${phase}`)}
  ${miscDraftSql('prover.inv_c3', `read-c3-${phase}`, 1700, C3)}
  ${faGroupSql(`read-${phase}`, { posted: true })}
  ${claims(U.ADMIN)}
  INSERT INTO public.write_offs (invoice_id, customer_id, amount_cents, reason, created_by)
    VALUES (current_setting('prover.inv')::uuid, '${C1}', 100, '[PROVER] write-off', '${U.ADMIN}');`;
  const readSql = `(SELECT count(*) FROM public.invoices) || ',' || (SELECT count(*) FROM public.invoice_items) || ',' || (SELECT count(*) FROM public.invoice_shares)
    || ',' || (SELECT count(*) FROM public.invoice_line_shares) || ',' || (SELECT count(*) FROM public.invoice_line_share_snapshots)
    || ',' || (SELECT count(*) FROM public.field_app_billing_sets) || ',' || (SELECT count(*) FROM public.write_offs)
    || ',' || (SELECT count(*) FROM public.field_app_billing_lines)`;
  const ownerView = attempt(U.ADMIN, fixture, readSql);
  const repView = attempt(U.REP, fixture, readSql);
  const driverView = attempt(U.DRIVER, fixture, readSql);
  const applicatorView = attempt(U.APPLICATOR, fixture, readSql);
  assert.match(ownerView.result, /^ok\|[1-9]\d*,[1-9]\d*,[1-9]\d*,[1-9]\d*,[1-9]\d*,[1-9]\d*,[1-9]\d*,[1-9]\d*$/, `${phase}: the admin does not see every invoice table populated: ${ownerView.result}`);
  if (phase === 'before') {
    assert.equal(repView.result, 'ok|0,0,0,0,0,0,0,0', `BEFORE: a rep should read none of an admin's invoices: ${repView.result}`);
  } else {
    assert.equal(repView.result, ownerView.result, `AFTER: a rep must read every invoice row an admin reads (Mason 2026-10-09): rep ${repView.result} vs admin ${ownerView.result}`);
  }
  assert.equal(driverView.result, 'ok|0,0,0,0,0,0,0,0', `${phase}: a driver's invoice reads changed: ${driverView.result}`);
  assert.equal(applicatorView.result, 'ok|0,0,0,0,0,0,0,0', `${phase}: an applicator's invoice reads changed: ${applicatorView.result}`);

  // Direct REST-style inserts (invoice_shares, invoice_line_allocations) and an invoices insert.
  const shareInsert = `INSERT INTO public.invoice_shares (invoice_id, customer_id, customer_name, split_percentage, amount_cents)
      VALUES (current_setting('prover.inv')::uuid, '${C1}', '[PROVER] direct share', 100, 1500)`;
  const allocInsert = `INSERT INTO public.invoice_line_allocations (allocation_set_id, bill_to_customer_id, split_percentage, amount_cents, invoice_id)
      VALUES ('${id('8001')}', '${C1}', 100, 1500, current_setting('prover.inv')::uuid)`;
  const invoiceInsert = `INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by)
      VALUES ('PROVER-AO-DIRECT', '${C1}', 'misc_charge', 'draft', CURRENT_DATE, 0, '${U.REP}')`;
  const allocFixture = `${miscDraftSql('prover.inv', `direct-${phase}`)}
  INSERT INTO public.allocation_sets (id, entity_type, entity_id, version, is_active) VALUES ('${id('8001')}', 'invoice', current_setting('prover.inv')::uuid, 1, true);`;
  const share = attempt(U.REP, allocFixture, shareInsert, { statement: true });
  const alloc = attempt(U.REP, allocFixture, allocInsert, { statement: true });
  const inv = attempt(U.REP, allocFixture, invoiceInsert, { statement: true });
  if (phase === 'before') {
    assert.equal(share.result, 'ok|1', `BEFORE: a rep could not insert an invoice_shares row directly: ${share.result}`);
    assert.equal(alloc.result, 'ok|1', `BEFORE: a rep could not insert an invoice_line_allocations row directly: ${alloc.result}`);
  } else {
    assert.equal(share.result, '42501|permission denied for table invoice_shares', `AFTER: rep direct invoice_shares insert: ${share.result}`);
    assert.equal(alloc.result, '42501|permission denied for table invoice_line_allocations', `AFTER: rep direct invoice_line_allocations insert: ${alloc.result}`);
  }
  assert.equal(inv.result, '42501|permission denied for table invoices', `${phase}: a rep inserted into invoices directly: ${inv.result}`);

  // Field-application invoice child rows and write-offs (review round 1): before, a rep could
  // rewrite any field invoice's locations and location shares through the REST API.
  const fieldFixture = `${allocFixture}
  ${fieldInvoiceSql(id('4008'), `fal-${phase}`)}
  RESET ROLE;
  INSERT INTO public.field_app_locations (invoice_id, field_id, applied_acres, sort_order)
    SELECT current_setting('prover.fa')::uuid, '${F1}', 120, 0
     WHERE NOT EXISTS (SELECT 1 FROM public.field_app_locations WHERE invoice_id = current_setting('prover.fa')::uuid);
  INSERT INTO public.field_app_location_shares (location_id, customer_id, split_pct, acres, amount_cents)
    SELECT id, '${C1}', 100, applied_acres, 0 FROM public.field_app_locations WHERE invoice_id = current_setting('prover.fa')::uuid;`;
  const ofField = "(SELECT id FROM public.field_app_locations WHERE invoice_id = current_setting('prover.fa')::uuid)";
  const directWrites = {
    field_app_locations_update: ["UPDATE public.field_app_locations SET applied_acres = applied_acres WHERE invoice_id = current_setting('prover.fa')::uuid", 'field_app_locations'],
    field_app_locations_insert: [`INSERT INTO public.field_app_locations (invoice_id, field_id, applied_acres, sort_order) VALUES (current_setting('prover.fa')::uuid, '${F1}', 1, 99)`, 'field_app_locations'],
    field_app_locations_delete: ["DELETE FROM public.field_app_locations WHERE invoice_id = current_setting('prover.fa')::uuid", 'field_app_locations'],
    field_app_location_shares_update: [`UPDATE public.field_app_location_shares SET split_pct = split_pct WHERE location_id IN ${ofField}`, 'field_app_location_shares'],
    field_app_location_shares_delete: [`DELETE FROM public.field_app_location_shares WHERE location_id IN ${ofField}`, 'field_app_location_shares'],
    write_offs_insert: [`INSERT INTO public.write_offs (invoice_id, customer_id, amount_cents, reason, created_by) VALUES (current_setting('prover.inv')::uuid, '${C1}', 1, '[PROVER] direct', '${U.REP}')`, 'write_offs'],
    invoice_shares_update: ["UPDATE public.invoice_shares SET amount_cents = amount_cents WHERE invoice_id = current_setting('prover.inv')::uuid", 'invoice_shares'],
    invoice_shares_delete: ["DELETE FROM public.invoice_shares WHERE invoice_id = current_setting('prover.inv')::uuid", 'invoice_shares'],
    invoice_line_allocations_update: ["UPDATE public.invoice_line_allocations SET amount_cents = amount_cents WHERE invoice_id = current_setting('prover.inv')::uuid", 'invoice_line_allocations'],
    invoice_line_allocations_delete: ["DELETE FROM public.invoice_line_allocations WHERE invoice_id = current_setting('prover.inv')::uuid", 'invoice_line_allocations'],
  };
  const direct = {};
  for (const [label, [statementSql, table]] of Object.entries(directWrites)) {
    const a = attempt(U.REP, fieldFixture, statementSql, { statement: true });
    direct[label] = a.result;
    if (phase === 'after') assert.equal(a.result, `42501|permission denied for table ${table}`, `AFTER: rep direct ${label}: ${a.result}`);
  }
  if (phase === 'before') {
    for (const label of ['field_app_locations_update', 'field_app_location_shares_update']) {
      assert.match(direct[label], /^ok\|[1-9]\d*$/, `BEFORE: a rep could not rewrite ${label.replace(/_update$/, '')} rows of a field invoice directly, so the bug did not reproduce: ${direct[label]}`);
    }
  }
  return { owner: ownerView.result, rep: repView.result, direct };
}

/**
 * Decision 2 (Mason 2026-10-10): reps SEE CUSTOMER NAMES on invoices, names only. C3 (an invoice's
 * customer) and C4 (only a customer share on that invoice) belong to REP_B, not to U.REP; C5 is on
 * no invoice; C6 only on a soft-deleted invoice. C3 and C4 carry a contact and an address that must
 * never reach a rep.
 */
function customerNames(phase) {
  const fixture = `INSERT INTO public.customers (id, farm_name, assigned_sales_rep, is_active, contact_name, billing_address) VALUES
      ('${C4}', '[PROVER] Share Farm', '${U.REP_B}', true, '[PROVER] Secret Contact', '1 Secret Rd'),
      ('${C5}', '[PROVER] No Invoice Farm', '${U.REP_B}', true, '[PROVER] Secret Contact', '1 Secret Rd'),
      ('${C6}', '[PROVER] Deleted Invoice Farm', '${U.REP_B}', true, '[PROVER] Secret Contact', '1 Secret Rd');
  UPDATE public.customers SET contact_name = '[PROVER] Secret Contact', billing_address = '1 Secret Rd' WHERE id = '${C3}';
  ${miscDraftSql('prover.inv_c3', `names-c3-${phase}`, 1700, C3)}
  RESET ROLE;
  INSERT INTO public.invoice_shares (invoice_id, customer_id, customer_name, split_percentage, amount_cents)
    VALUES (current_setting('prover.inv_c3')::uuid, '${C4}', '[PROVER] Share Farm', 100, 1700);
  ${miscDraftSql('prover.inv_c6', `names-c6-${phase}`, 1800, C6)}
  RESET ROLE;
  UPDATE public.invoices SET deleted_at = now() WHERE id = current_setting('prover.inv_c6')::uuid;`;
  const ask = `ARRAY['${C3}', '${C4}', '${C5}', '${C6}']::uuid[]`;
  const names = `(SELECT COALESCE(string_agg(cn.id || '=' || cn.farm_name, ',' ORDER BY cn.farm_name), '') FROM public.get_invoice_customer_names(${ask}) cn)`;
  const keys = `(SELECT COALESCE(string_agg(DISTINCT k, ',' ORDER BY k), '') FROM public.get_invoice_customer_names(${ask}) cn, jsonb_object_keys(to_jsonb(cn)) k)`;
  const leak = `(SELECT COALESCE(string_agg(to_jsonb(cn)::text, ','), '') ~ 'Secret' FROM public.get_invoice_customer_names(${ask}) cn)`;
  // The direct table read the invoice pages use today: farm name, and the PDF's address fields.
  const direct = `(SELECT count(*) || ':' || COALESCE(string_agg(farm_name || '/' || COALESCE(contact_name, '') || '/' || COALESCE(billing_address, ''), ',' ORDER BY farm_name), '')
    FROM public.customers WHERE id IN ('${C3}', '${C4}', '${C5}', '${C6}'))`;
  const expected = `ok|${C3}=[PROVER] Rep B Farm,${C4}=[PROVER] Share Farm`;
  const repDirect = attempt(U.REP, fixture, direct);
  assert.equal(repDirect.result, 'ok|0:', `${phase}: a sales rep read customer rows that are not assigned to them directly: ${repDirect.result}`);
  assert.match(attempt(U.ADMIN, fixture, direct).result, /^ok\|4:/, `${phase}: the admin's direct customer read is not the fixture`);
  if (phase === 'before') {
    assert.equal(scalar("SELECT to_regprocedure('public.get_invoice_customer_names(uuid[])') IS NULL;"), 't', 'BEFORE: the names reader already exists');
    return { rep: repDirect.result };
  }
  assert.equal(scalar("SELECT pg_get_function_result('public.get_invoice_customer_names(uuid[])'::regprocedure);"), 'TABLE(id uuid, farm_name text)', 'AFTER: the names reader returns more than id and farm_name');
  for (const [who, uid] of [['sales rep', U.REP], ['other sales rep', U.REP_B], ['admin', U.ADMIN]]) {
    assert.equal(attempt(uid, fixture, names).result, expected, `AFTER: ${who} does not read exactly the names of the customers a live invoice names`);
    assert.equal(attempt(uid, fixture, keys).result, 'ok|farm_name,id', `AFTER: the names reader returns other columns to ${who}`);
    assert.equal(attempt(uid, fixture, leak).result, 'ok|false', `AFTER: the names reader leaks a contact or address to ${who}`);
  }
  assert.equal(attempt(U.REP, fixture, `(SELECT count(*) FROM public.get_invoice_customer_names(NULL))`).result, 'ok|0', 'AFTER: a NULL id list returned rows');
  for (const [who, uid] of NON_ADMINS.filter(([w]) => w !== 'sales rep')) {
    assert.equal(attempt(uid, fixture, names).result, 'ok|', `AFTER: the names reader returned names to a ${who}`);
  }
  for (const role of ['anon', 'service_role']) {
    assert.equal(attempt(U.REP, fixture, names, { role }).result, '42501|permission denied for function get_invoice_customer_names', `AFTER: ${role} can execute the names reader`);
  }
  return { rep: repDirect.result, names: expected };
}

/** Delivery and job completions. Returns facts for the before/after comparison. */
function completions(phase) {
  const fixed = phase === 'after';
  const admins = activeAdmins();
  const orderD = id('2101');
  const del = id('3101');
  const facts = (deliveryId, orderId) => `SELECT 'FACTS|' || (SELECT status FROM public.deliveries WHERE id = '${deliveryId}')
  || '|' || (SELECT status FROM public.orders WHERE id = '${orderId}')
  || '|' || COALESCE((SELECT needs_split_billing FROM public.orders WHERE id = '${orderId}')::text, 'null')
  || '|' || (SELECT count(*) FROM public.inventory_transactions WHERE delivery_id = '${deliveryId}')
  || '|' || (SELECT count(*) FROM public.invoices WHERE order_id = '${orderId}')
  || '|' || (SELECT count(*) FROM public.activity_feed WHERE related_entity_id = '${deliveryId}' AND event_type = 'delivery_invoice_pending_admin')
  || '|' || (SELECT count(*) FROM public.notifications WHERE related_entity_id = '${deliveryId}' AND notification_type = 'delivery_needs_invoice')
  || '|' || COALESCE((SELECT string_agg(ii.product_id || ':' || ii.quantity || ':' || ii.unit_price_cents || ':' || ii.extended_cents || ':' || ii.cost_cents, ',' ORDER BY ii.product_id)
       FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id WHERE i.order_id = '${orderId}'), '')
  || '|' || COALESCE((SELECT string_agg(user_id::text, ',' ORDER BY user_id) FROM public.notifications WHERE related_entity_id = '${deliveryId}' AND notification_type = 'delivery_needs_invoice'), '');`;
  const parse = (a) => {
    const line = a.lines.find((l) => l.startsWith('FACTS|'));
    assert.ok(line, `no FACTS:\n${a.lines.join('\n')}\n${a.stderr}`);
    const [, status, orderStatus, split, ledger, invoices, activity, notes, lines, recipients] = line.split('|');
    return { status, orderStatus, split, ledger: Number(ledger), invoices: Number(invoices), activity: Number(activity), notes: Number(notes), lines, recipients };
  };
  // Review round 2: WHO is notified, not only how many: exactly the active admins.
  const adminIds = activeAdminIds();
  const out = {};
  // (a) non-split delivery completed by a rep, by the assigned driver, by an admin.
  for (const [who, uid, driver] of [['rep', U.REP, null], ['driver', U.DRIVER, U.DRIVER], ['admin', U.ADMIN, null]]) {
    const a = attempt(uid, `${orderSql(orderD, C1, `DEL-${who}`)}\n${deliverySql(del, orderD, C1, driver, who)}`,
      `public.complete_delivery('${del}', '[PROVER] Receiver', '${uid}', NULL, NULL, NULL, 'prover-ao-complete-${who}', NULL)`,
      { after: `${facts(del, orderD)}\n${who !== 'admin' && fixed ? `${claims(U.ADMIN)}
SELECT 'DASH|' || ((public.get_dashboard_action_items(100)->'unbilled_deliveries') @> '[{"id":"${del}"}]'::jsonb);
SELECT 'MANUAL|' || (public.create_invoice_for_unbilled_delivery('${del}', '${U.ADMIN}', 'prover-ao-manual-${who}') IS NOT NULL);
${facts(del, orderD).replace("'FACTS|'", "'MANUALFACTS|'")}` : ''}` });
    assert.match(a.result, /^ok\|/, `${phase} (${who}) complete_delivery failed - a delivery must always complete: ${a.result}`);
    const f = parse(a);
    assert.equal(f.status, 'completed', `${phase} (${who}): the delivery did not complete`);
    assert.equal(f.orderStatus, 'fulfilled', `${phase} (${who}): the order status did not advance`);
    assert.equal(f.ledger, 1, `${phase} (${who}): no inventory ledger row`);
    if (!fixed || who === 'admin') {
      assert.equal(f.invoices, 1, `${phase} (${who}): expected the auto-invoice (the BEFORE bug for a non-admin, the kept behaviour for an admin)`);
      assert.equal(f.activity + f.notes, 0, `${phase} (${who}): unexpected pending-admin rows`);
      assert.notEqual(a.seq[1], a.seq[0], `${phase} (${who}): the auto-invoice drew no number`);
    } else {
      assert.equal(f.invoices, 0, `AFTER (${who}): a non-admin's completion created an invoice`);
      assert.equal(a.seq[1], a.seq[0], `AFTER (${who}): a non-admin's completion drew an invoice number`);
      assert.equal(f.activity, 1, `AFTER (${who}): expected one delivery_invoice_pending_admin activity row`);
      assert.equal(f.notes, admins, `AFTER (${who}): expected one notification per active admin (${admins})`);
      assert.equal(f.recipients, adminIds, `AFTER (${who}): the notifications did not go to exactly the active admins`);
      assert.ok(a.lines.includes('DASH|true'), `AFTER (${who}): the delivery is not listed under "Delivered, not invoiced"`);
      const manual = a.lines.find((l) => l.startsWith('MANUALFACTS|'))?.split('|');
      assert.ok(manual && Number(manual[5]) === 1, `AFTER (${who}): the admin could not bill it with Create Invoice`);
      out[`manual_${who}`] = manual[8];
    }
    out[who] = f;
  }
  // (b) split (field-allocated) order completed by a rep: the needs_split_billing fallback.
  const orderS = id('2102');
  const delS = id('3102');
  const s = attempt(U.REP, `${orderSql(orderS, C1, 'DEL-SPLIT')} INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres) VALUES ('${itemOf(orderS)}', '${F1}', 10);
${deliverySql(delS, orderS, C1, null, 'split')}`, `public.complete_delivery('${delS}', '[PROVER] Receiver', '${U.REP}', NULL, NULL, NULL, 'prover-ao-complete-split', NULL)`,
  { after: facts(delS, orderS) });
  assert.match(s.result, /^ok\|/, `${phase} split completion failed: ${s.result}`);
  const sf = parse(s);
  if (fixed) {
    assert.equal(sf.split, 'true', 'AFTER: the rep\'s split completion did not set needs_split_billing');
    assert.equal(sf.invoices, 0, 'AFTER: the rep\'s split completion created an invoice');
    assert.equal(s.seq[1], s.seq[0], 'AFTER: the rep\'s split completion drew a number');
  } else {
    assert.equal(sf.invoices, 1, `BEFORE: the rep's split completion should have auto-split (the bug): ${JSON.stringify(sf)}`);
  }
  // (c) offline replay of a completion by a rep and by the driver.
  for (const [who, uid, driver] of [['rep', U.REP, null], ['driver', U.DRIVER, U.DRIVER]]) {
    const action = id(who === 'rep' ? '9a01' : '9a02');
    const fixture = `${orderSql(orderD, C1, `OFF-${who}`)}\n${deliverySql(del, orderD, C1, driver, `off-${who}`)}
    ${claims(uid)}
    SELECT public.stage_offline_action('${action}', 'complete_delivery', '${del}', 1, now(), '{"signed_by":"[PROVER] Receiver"}'::jsonb, 'prover-ao-offline-${who}', (SELECT updated_at FROM public.deliveries WHERE id = '${del}')) IS NOT NULL;`;
    const a = attempt(uid, fixture, `public.process_offline_action('${action}', 'prover-ao-offline-${who}')->>'status'`, { after: facts(del, orderD) });
    assert.equal(a.result, 'ok|succeeded', `${phase} offline (${who}): the replay did not succeed: ${a.result}`);
    const f = parse(a);
    assert.equal(f.status, 'completed');
    if (fixed) {
      assert.deepEqual([f.invoices, f.activity, f.notes, f.recipients], [0, 1, admins, adminIds], `AFTER offline (${who}): expected no invoice, one activity row and ${admins} notifications to the active admins: ${JSON.stringify(f)}`);
    } else {
      assert.equal(f.invoices, 1, `BEFORE offline (${who}): the replay should have auto-invoiced: ${JSON.stringify(f)}`);
    }
  }
  // (d) a rep's partial delivery against an admin's quick-delivery draft still resizes that draft.
  const qd = attempt(U.REP, `${claims(U.ADMIN)}
    SELECT set_config('prover.qd', ${QUICK_CALL(U.ADMIN, 'prover-ao-qd-admin-draft')}::text, true);
    SELECT set_config('prover.qd_delivery', current_setting('prover.qd')::jsonb->>'delivery_id', true);
    SELECT set_config('prover.qd_item', (SELECT id::text FROM public.delivery_items WHERE delivery_id = current_setting('prover.qd_delivery')::uuid), true);
    ${claims(U.REP)}
    SELECT public.confirm_delivery(current_setting('prover.qd_delivery')::uuid, '${U.REP}', 'prover-ao-qd-confirm') IS NOT NULL;`,
  `public.complete_delivery(current_setting('prover.qd_delivery')::uuid, '[PROVER] Receiver', '${U.REP}', jsonb_build_object(current_setting('prover.qd_item'), 1), NULL, NULL, 'prover-ao-qd-partial', NULL)`,
  { after: `SELECT 'QD|' || (SELECT string_agg(i.status || ':' || ii.quantity || ':' || ii.extended_cents, ',') FROM public.invoices i JOIN public.invoice_items ii ON ii.invoice_id = i.id WHERE i.delivery_id = current_setting('prover.qd_delivery')::uuid);` });
  assert.match(qd.result, /^ok\|/, `${phase}: the rep's partial completion of an admin's quick delivery failed: ${qd.result}`);
  out.quickDraftResize = qd.lines.find((l) => l.startsWith('QD|'));
  assert.equal(out.quickDraftResize, 'QD|draft:1.0000:1000', `${phase}: the admin's quick-delivery draft was not resized to the delivered quantity: ${out.quickDraftResize}`);
  return out;
}

function jobsAndQuick(phase) {
  const fixed = phase === 'after';
  const job = id('4101');
  const jobFacts = `SELECT 'JOB|' || (SELECT status FROM public.jobs WHERE id = '${job}') || '|' || (SELECT count(*) FROM public.invoices WHERE job_id = '${job}')
    || '|' || COALESCE((SELECT string_agg(event_type || ':' || description, ' ; ' ORDER BY created_at) FROM public.activity_feed WHERE related_entity_id = '${job}' AND event_type LIKE 'auto_draft%'), '')
    || '|' || (SELECT count(*) FROM public.notifications WHERE related_entity_id = '${job}' AND notification_type = 'job_needs_invoice')
    || '|' || COALESCE((SELECT string_agg(user_id::text, ',' ORDER BY user_id) FROM public.notifications WHERE related_entity_id = '${job}' AND notification_type = 'job_needs_invoice'), '');`;
  const admins = activeAdmins();
  const out = {};
  for (const [who, uid] of [['rep', U.REP], ['admin', U.ADMIN], ['applicator', U.APPLICATOR]]) {
    const fixture = `${jobSql(job, `JOB-${who}`)} UPDATE public.jobs SET applicator_id = '${U.APPLICATOR}' WHERE id = '${job}';
    ${claims(uid)} SELECT public.start_job('${job}', '${uid}', 'prover-ao-sj-${who}') IS NOT NULL;`;
    const a = attempt(uid, fixture, `public.complete_job('${job}', '{"notes":"[PROVER]"}'::jsonb, '${uid}', 'prover-ao-cj-${who}')->>'success'`, { after: jobFacts });
    assert.equal(a.result, 'ok|true', `${phase} complete_job (${who}) failed: ${a.result}`);
    const [, status, invoices, activity, notes, recipients] = a.lines.find((l) => l.startsWith('JOB|')).split('|');
    if (who === 'admin' || (who === 'rep' && !fixed)) {
      assert.equal(invoices, '1', `${phase} complete_job (${who}): expected the automatic draft: ${status} ${invoices} ${activity}`);
      assert.equal(notes, '0', `${phase} complete_job (${who}): unexpected job_needs_invoice notifications`);
    } else {
      assert.equal(invoices, '0', `${phase} complete_job (${who}): a draft was created`);
      assert.equal(a.seq[1], a.seq[0], `${phase} complete_job (${who}): a number was drawn`);
      assert.match(activity, /^auto_draft_skipped:/, `${phase} complete_job (${who}): expected an auto_draft_skipped row: ${activity}`);
      if (fixed) {
        assert.match(activity, /completed by a non-admin — automatic draft invoice skipped \(invoicing is admin-only\)/, `AFTER complete_job (${who}): wrong skip text: ${activity}`);
        // Q4/Q5: the office is told, one notification per active admin, as for deliveries.
        assert.equal(notes, String(admins), `AFTER complete_job (${who}): expected one job_needs_invoice notification per active admin (${admins})`);
        assert.equal(recipients, activeAdminIds(), `AFTER complete_job (${who}): the notifications did not go to exactly the active admins`);
      }
    }
    out[who] = `${invoices}|${activity.replace(/Job PROVER-AO-JOB-[\w-]+/, 'Job <n>')}`;
  }
  // Quick delivery with p_skip_invoice = false (an old cached client).
  for (const [who, uid, driver] of [['rep', U.REP, null], ['driver', U.DRIVER, U.DRIVER], ['admin', U.ADMIN, null]]) {
    const a = attempt(uid, '', `${QUICK_CALL(uid, `prover-ao-qd-${who}`, false, driver)}->>'invoice_id'`, { replay: true });
    if (who === 'admin' || !fixed) {
      assert.match(a.result, /^ok\|[0-9a-f-]{36}$/, `${phase} quick delivery (${who}): expected an invoice: ${a.result}`);
    } else {
      assert.equal(a.result, 'ok|<null>', `AFTER quick delivery (${who}): a non-admin's quick delivery created an invoice`);
      assert.equal(a.seq[1], a.seq[0], `AFTER quick delivery (${who}): a number was drawn`);
    }
    assert.equal(a.replay, a.result, `${phase} quick delivery (${who}): the exact replay differs`);
    out[`qd_${who}`] = normalize(a.result);
  }
  // cancel_delivery is unchanged (Mason 2026-10-09: reps may cancel a delivery that has an admin's
  // invoice). Recorded for a rep and an admin, on (1) an order delivery with an admin's order draft and
  // (2) an admin's quick delivery with its draft; the proof is that every outcome (result and the
  // invoices left) is identical before and after the candidate - not that each one succeeds.
  const orderC = id('2201');
  const delC = id('3201');
  const cancelCases = {
    order: [`${orderSql(orderC, C1, 'CANCEL')}\n${deliverySql(delC, orderC, C1, null, 'cancel')}
      INSERT INTO public.invoices (id, invoice_number, customer_id, order_id, delivery_id, invoice_type, status, invoice_date, total_amount_cents, created_by)
        VALUES ('${id('6201')}', 'PROVER-AO-CANCEL-DRAFT', '${C1}', '${orderC}', '${delC}', 'chemical_sale', 'draft', (now() AT TIME ZONE 'America/Chicago')::date, 0, '${U.ADMIN}');`,
    () => `'${delC}'::uuid`, `(SELECT string_agg(status, ',') FROM public.invoices WHERE order_id = '${orderC}')`],
    quick: [`${claims(U.ADMIN)} SELECT set_config('prover.qd', ${QUICK_CALL(U.ADMIN, 'prover-ao-qd-cancel')}::text, true);`,
      () => "(current_setting('prover.qd')::jsonb->>'delivery_id')::uuid", "(SELECT string_agg(status, ',') FROM public.invoices WHERE delivery_id = (current_setting('prover.qd')::jsonb->>'delivery_id')::uuid)"],
  };
  for (const [kind, [fixture, delivery, invoices]] of Object.entries(cancelCases)) {
    for (const [who, uid] of [['rep', U.REP], ['admin', U.ADMIN]]) {
      const c = attempt(uid, fixture, `public.cancel_delivery(${delivery()}, '[PROVER] cancel', '${uid}', 'prover-ao-cancel-${kind}-${who}')`,
        { after: `SELECT 'CANCEL|' || COALESCE(${invoices}, 'none');` });
      out[`cancel_${kind}_${who}`] = `${normalize(c.result)}|${c.lines.find((l) => l.startsWith('CANCEL|'))}`;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// Posting version check (addendum 8).
function commitFixture(sql) { psql(`BEGIN;\n${sql}\nCOMMIT;`); }
function versionOf(ids) { return scalar(`BEGIN; ${claims(U.ADMIN)} SELECT public.get_invoice_post_version(ARRAY[${ids.map((x) => `'${x}'::uuid`).join(', ')}]); ROLLBACK;`); }
function invoiceStatus(invoiceId) { return scalar(`SELECT status FROM public.invoices WHERE id = '${invoiceId}';`); }
function newMisc(label) {
  const key = `prover-ao-ver-${label}`;
  return scalar(`BEGIN; ${claims(U.ADMIN)}
    SELECT public.save_invoice(jsonb_build_object('customer_id', '${C1}', 'invoice_type', 'misc_charge', 'status', 'draft', 'invoice_date', (now() AT TIME ZONE 'America/Chicago')::date, 'header_notes', '[PROVER] ${label}'),
      jsonb_build_array(jsonb_build_object('description', '[PROVER] fee', 'quantity', 1, 'unit_price_cents', 1500, 'extended_cents', 1500)), '${key}');
    COMMIT;`);
}
function saveHeaderSql(invoiceId, note, key) {
  return `SELECT public.save_invoice(jsonb_build_object('id', '${invoiceId}', 'customer_id', '${C1}', 'invoice_type', 'misc_charge', 'status', 'draft', 'invoice_date', (now() AT TIME ZONE 'America/Chicago')::date, 'header_notes', '${note}'),
      jsonb_build_array(jsonb_build_object('description', '[PROVER] fee', 'quantity', 1, 'unit_price_cents', 1500, 'extended_cents', 1500)), '${key}') IS NOT NULL;`;
}
/**
 * The race the server check exists for: the admin reviews (captures the version), a second admin's
 * save takes the invoice row lock and has not committed when the post arrives; the post blocks on
 * that lock (observed), the save commits, the post resumes and must refuse.
 */
async function racePost(label, { postSql, invoiceId, holdSql }) {
  const holder = session(`crx_ao_race_holder_${label}`);
  holder.child.stdin.write(`BEGIN;\n${claims(U.ADMIN2)}\nSELECT 'HOLDER_PID=' || pg_backend_pid();\n${holdSql}\n\\echo HOLDER_HOLDING\n`);
  await until(() => holder.out.includes('HOLDER_HOLDING') || holder.err.includes('ERROR'), `${label}: second admin's uncommitted save`);
  assert.doesNotMatch(holder.err, /ERROR/, `${label}: the second admin's save failed:\n${holder.err}`);
  const holderPid = /HOLDER_PID=(\d+)/.exec(holder.out)?.[1];
  const poster = session(`crx_ao_race_poster_${label}`);
  poster.child.stdin.end(`BEGIN;\n${asUser(U.ADMIN)}\nDO $race$
BEGIN
  ${postSql};
  RAISE NOTICE 'RACE|ok';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'RACE|%|%', SQLSTATE, SQLERRM;
END
$race$;
COMMIT;\n`);
  await until(() => scalar(`SELECT count(*) FROM pg_stat_activity WHERE application_name = 'crx_ao_race_poster_${label}' AND wait_event_type = 'Lock' AND ${holderPid} = ANY (pg_blocking_pids(pid));`) === '1' || poster.err.includes('RACE|'),
    `${label}: the post blocked behind the uncommitted save`);
  assert.doesNotMatch(poster.err, /RACE\|/, `${label}: the post finished before the save committed (it did not wait on the row lock):\n${poster.err}`);
  holder.child.stdin.end('COMMIT;\n');
  assert.equal(await holder.done, 0, `${label}: the second admin's save did not commit:\n${holder.err}`);
  await poster.done;
  return { result: /RACE\|([^\n]*)/.exec(poster.err)?.[1]?.trimEnd() ?? `(no result) ${poster.err}`, status: invoiceStatus(invoiceId) };
}

let groupJob = 0x4c00;
/** A committed, unposted field-app split group (its own job); returns the group id. */
function newGroup(label) {
  groupJob += 1;
  const group = scalar(`BEGIN; ${faGroupSql(label, { job: id(groupJob.toString(16)) })}
    SELECT set_config('prover.keep_group', current_setting('prover.group'), false); COMMIT; SELECT current_setting('prover.keep_group');`);
  assert.match(group, /^[0-9a-f-]{36}$/, `the committed group ${label} was not created: ${group}`);
  return group;
}
function groupVersionOf(group) { return scalar(`BEGIN; ${claims(U.ADMIN)} SELECT public.get_invoice_group_post_version('${group}'); ROLLBACK;`); }
/**
 * Two posts of one invoice with the SAME key and the same reviewed version: the first has posted
 * but not committed when the second arrives; the second must wait (observed) and then replay the
 * first's success, not fail the version check against the now-posted invoice.
 */
async function dupKeyPost(label) {
  const inv = newMisc(`dup-${label}`);
  const version = versionOf([inv]);
  const key = `prover-ao-dup-${label}`;
  const first = session(`crx_ao_dup_first_${label}`);
  first.child.stdin.write(`BEGIN;\n${claims(U.ADMIN)}\nSELECT 'FIRST_PID=' || pg_backend_pid();\nSELECT public.post_invoice('${inv}', '${key}', '${version}') IS NULL;\n\\echo FIRST_POSTED\n`);
  let second;
  try {
    await until(() => first.out.includes('FIRST_POSTED') || first.err.includes('ERROR'), `${label}: the first post`);
    assert.doesNotMatch(first.err, /ERROR/, `${label}: the first post failed:\n${first.err}`);
    const firstPid = /FIRST_PID=(\d+)/.exec(first.out)?.[1];
    second = session(`crx_ao_dup_second_${label}`);
    second.child.stdin.end(`BEGIN;\n${asUser(U.ADMIN)}\nDO $dup$
BEGIN
  PERFORM public.post_invoice('${inv}', '${key}', '${version}');
  RAISE NOTICE 'DUP|ok';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'DUP|%|%', SQLSTATE, SQLERRM;
END
$dup$;
COMMIT;\n`);
    await until(() => scalar(`SELECT count(*) FROM pg_stat_activity WHERE application_name = 'crx_ao_dup_second_${label}' AND wait_event_type = 'Lock' AND ${firstPid} = ANY (pg_blocking_pids(pid));`) === '1' || second.err.includes('DUP|'),
      `${label}: the duplicate post blocked behind the first`);
    assert.doesNotMatch(second.err, /DUP\|/, `${label}: the duplicate finished before the first committed:\n${second.err}`);
    first.child.stdin.end('COMMIT;\n');
    assert.equal(await first.done, 0, `${label}: the first post did not commit:\n${first.err}`);
    await second.done;
  } finally {
    if (!first.child.stdin.writableEnded) first.child.stdin.end('ROLLBACK;\n');
    await first.done;
    if (second) await second.done;
  }
  return { result: /DUP\|([^\n]*)/.exec(second.err)?.[1]?.trimEnd() ?? `(no result) ${second.err}`, status: invoiceStatus(inv) };
}

let completionRaceRun = 0;
/**
 * Review round 2: a rep's partial completion racing an admin's post of the draft that completion
 * resizes (the reviewers' case: the completion re-sizes the lines before it locks the invoice row,
 * so a post could read the old lines, match the reviewed version, and then have its posted invoice
 * re-totalled). The admin's posting transaction holds the invoice row when the completion arrives;
 * the completion re-sizes the lines and waits on the header; the admin then posts. Posting fires
 * guard_mono_invoice_split_billing_post, which locks the order's order_items rows the completion
 * holds, so the two can only serialize or deadlock (one is aborted, 40P01, and nothing of it
 * commits). The property checked, before and after the candidate: a posted invoice is never
 * re-sized; the side that was not aborted finishes normally.
 */
async function completionRace(phase) {
  completionRaceRun += 1;
  const run = `${phase}_${process.pid}_${completionRaceRun}`;
  const qd = scalar(`BEGIN; ${claims(U.ADMIN)}
    SELECT set_config('prover.crace', (${QUICK_CALL(U.ADMIN, `prover-ao-crace-qd-${run}`)})::text, false);
    ${claims(U.REP)}
    SELECT public.confirm_delivery((current_setting('prover.crace')::jsonb->>'delivery_id')::uuid, '${U.REP}', 'prover-ao-crace-confirm-${run}') IS NOT NULL;
    COMMIT; SELECT current_setting('prover.crace');`);
  const { delivery_id: del, invoice_id: inv } = JSON.parse(qd);
  assert.match(inv ?? '', /^[0-9a-f-]{36}$/, `${phase} completion race: the admin's quick delivery made no draft: ${qd}`);
  const item = scalar(`SELECT id FROM public.delivery_items WHERE delivery_id = '${del}';`);
  const stateSql = `SELECT status || '|' || total_amount_cents || '|' || COALESCE(total_cost_cents, 0) || '|' || (SELECT string_agg(quantity::text || ':' || extended_cents, ',' ORDER BY id) FROM public.invoice_items WHERE invoice_id = '${inv}') FROM public.invoices WHERE id = '${inv}';`;
  const reviewed = scalar(stateSql);
  assert.match(reviewed, /^draft\|/, `${phase} completion race: the fixture is not a draft: ${reviewed}`);
  const version = phase === 'after' ? versionOf([inv]) : null;
  // The admin's posting transaction holds the invoice row lock (as post_invoice takes it first)
  // when the completion arrives; it posts while the completion waits, then commits.
  const holder = session(`crx_ao_crace_post_${run}`);
  holder.child.stdin.write(`BEGIN;\n${claims(U.ADMIN)}\nSELECT 'HOLDER_PID=' || pg_backend_pid();\nSELECT 1 FROM public.invoices WHERE id = '${inv}' FOR UPDATE;\n\\echo HOLDER_LOCKED\n`);
  let completer;
  try {
    await until(() => holder.out.includes('HOLDER_LOCKED') || holder.err.includes('ERROR'), `${phase} completion race: the admin's row lock`);
    assert.doesNotMatch(holder.err, /ERROR/, `${phase} completion race: the admin's row lock failed:\n${holder.err}`);
    const holderPid = /HOLDER_PID=(\d+)/.exec(holder.out)?.[1];
    completer = session(`crx_ao_crace_complete_${run}`);
    completer.child.stdin.end(`BEGIN;\n${asUser(U.REP)}\nDO $crace$
BEGIN
  PERFORM public.complete_delivery('${del}', '[PROVER] Receiver', '${U.REP}', jsonb_build_object('${item}', 1), NULL, NULL, 'prover-ao-crace-complete-${run}', NULL);
  RAISE NOTICE 'CRACE|ok';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'CRACE|%|%', SQLSTATE, SQLERRM;
END
$crace$;
COMMIT;\n`);
    await until(() => scalar(`SELECT count(*) FROM pg_stat_activity WHERE application_name = 'crx_ao_crace_complete_${run}' AND wait_event_type = 'Lock' AND ${holderPid} = ANY (pg_blocking_pids(pid));`) === '1' || completer.err.includes('CRACE|'),
      `${phase} completion race: the completion blocked behind the uncommitted post`);
    assert.doesNotMatch(completer.err, /CRACE\|/, `${phase} completion race: the completion finished before the post committed:\n${completer.err}`);
    // The completion has re-sized the lines (uncommitted) and waits on the header; the post reads
    // the committed lines, so the reviewed version matches; its status update then needs the
    // order_items rows the completion holds.
    holder.child.stdin.write(`SELECT public.post_invoice('${inv}', 'prover-ao-crace-post-${run}'${version ? `, '${version}'` : ''}) IS NULL;\n\\echo HOLDER_POSTED\n`);
    await until(() => holder.out.includes('HOLDER_POSTED') || holder.err.includes('ERROR'), `${phase} completion race: the admin's post`);
    if (holder.out.includes('HOLDER_POSTED')) holder.child.stdin.end('COMMIT;\n');
    await holder.done;
    await completer.done;
  } finally {
    if (!holder.child.stdin.writableEnded) holder.child.stdin.end('ROLLBACK;\n');
    await holder.done;
    if (completer) await completer.done;
  }
  return {
    result: /CRACE\|([^\n]*)/.exec(completer?.err ?? '')?.[1]?.trimEnd() ?? `(no result) ${completer?.err}`,
    post: holder.out.includes('HOLDER_POSTED') && !/ERROR/.test(holder.err) ? 'ok' : (/ERROR:\s+([^\n]*)/.exec(holder.err)?.[1] ?? `(no result) ${holder.err}`),
    reviewed,
    final: scalar(stateSql),
    delivery: scalar(`SELECT status FROM public.deliveries WHERE id = '${del}';`),
  };
}
/** The race's property (same before and after): a posted invoice is never re-sized. */
function checkCompletionRace(phase, r) {
  const outcome = `completion ${r.result}; post ${r.post}; ${r.reviewed} -> ${r.final}; delivery ${r.delivery}`;
  assert.ok(r.result === 'ok' || /^40P01\|/.test(r.result), `${phase} completion race: the completion failed for another reason: ${outcome}`);
  assert.ok(r.post === 'ok' || /deadlock detected/.test(r.post), `${phase} completion race: the post failed for another reason: ${outcome}`);
  assert.ok(r.result === 'ok' || r.post === 'ok', `${phase} completion race: both sides were aborted: ${outcome}`);
  assert.equal(r.delivery, r.result === 'ok' ? 'completed' : 'in_progress', `${phase} completion race: the delivery's status does not match the completion's outcome: ${outcome}`);
  if (r.post === 'ok') {
    assert.equal(r.final, r.reviewed.replace(/^draft\|/, 'posted|'), `${phase} completion race: a rep's completion changed the lines or totals of an invoice posted under it: ${outcome}`);
  } else {
    assert.match(r.final, /^draft\|/, `${phase} completion race: the aborted post left the invoice posted: ${outcome}`);
  }
  return outcome;
}

let versionRun = 0;
async function versionChecks(phase) {
  const fixed = phase === 'after';
  // Single invoice: a committed draft, reviewed, changed by a second admin's concurrent save.
  versionRun += 1;
  const run = `${phase}-${process.pid}-${versionRun}`;
  const inv = newMisc(`race-${run}`);
  const reviewed = fixed ? versionOf([inv]) : null;
  const race = await racePost(`single_${run.replace('-', '_')}`, {
    invoiceId: inv,
    holdSql: saveHeaderSql(inv, '[PROVER] changed after review', `prover-ao-race-save-${run}`),
    postSql: fixed ? `PERFORM public.post_invoice('${inv}', 'prover-ao-race-post-${run}', '${reviewed}')` : `PERFORM public.post_invoice('${inv}', 'prover-ao-race-post-${run}')`,
  });
  if (fixed) {
    assert.match(race.result, /^P0001\|INVOICE_CHANGED_SINCE_REVIEW: /, `AFTER: a post with the reviewed version went through after a concurrent save: ${race.result}`);
    assert.equal(race.status, 'draft', 'AFTER: the refused post left the invoice posted');
  } else {
    assert.equal(race.result, 'ok', `BEFORE: the race did not reproduce (the post should go through the changed invoice): ${race.result}`);
    assert.equal(race.status, 'posted');
    return { race: race.result };
  }
  // Unchanged invoice posts; a replay of that key is not re-checked; an old caller (no version) posts.
  const inv2 = newMisc(`unchanged-${run}`);
  const v2 = versionOf([inv2]);
  const ok2 = attempt(U.ADMIN, '', `public.post_invoice('${inv2}', 'prover-ao-ver-ok', '${v2}')`, { replay: true });
  assert.equal(ok2.result, 'ok|', `AFTER: an unchanged invoice with its reviewed version did not post: ${ok2.result}`);
  assert.equal(ok2.replay, 'ok|', `AFTER: an exact replay of a versioned post was refused: ${ok2.replay}`);
  const old = attempt(U.ADMIN, '', `public.post_invoice('${inv2}', 'prover-ao-ver-old')`);
  assert.equal(old.result, 'ok|', `AFTER: an old two-argument caller could not post: ${old.result}`);
  const named = attempt(U.ADMIN, '', `public.post_invoice(p_invoice_id => '${inv2}', p_idempotency_key => 'prover-ao-ver-named')`);
  assert.equal(named.result, 'ok|', `AFTER: an old caller using PostgREST's named arguments could not post: ${named.result}`);
  const stale = attempt(U.ADMIN, saveHeaderSql(inv2, '[PROVER] edited', 'prover-ao-ver-edit').replace(/^/, `${claims(U.ADMIN)}\n`), `public.post_invoice('${inv2}', 'prover-ao-ver-stale', '${v2}')`);
  assert.match(stale.result, /^P0001\|INVOICE_CHANGED_SINCE_REVIEW: /, `AFTER: a stale version posted: ${stale.result}`);
  const bad = attempt(U.ADMIN, '', `public.post_invoice('${inv2}', 'prover-ao-ver-bad', 'not-a-version')`);
  assert.match(bad.result, /^22023\|INVOICE_EXPECTED_VERSION_INVALID: /, `AFTER: a malformed version was not refused: ${bad.result}`);
  const lineOnly = attempt(U.ADMIN, `${claims(U.ADMIN)} UPDATE public.invoice_items SET description = '[PROVER] line edited' WHERE invoice_id = '${inv2}';`, `public.post_invoice('${inv2}', 'prover-ao-ver-line', '${v2}')`);
  assert.match(lineOnly.result, /^P0001\|INVOICE_CHANGED_SINCE_REVIEW: /, `AFTER: a line-only change did not change the version: ${lineOnly.result}`);
  // Group: every member counts, including a member added after review.
  const groupFx = faGroupSql('ver-group');
  const g = attempt(U.ADMIN, `${groupFx}\nSELECT set_config('prover.gv', public.get_invoice_group_post_version(current_setting('prover.group')::uuid), true);`,
    `public.post_invoice_group(current_setting('prover.group')::uuid, '${U.ADMIN}', 'prover-ao-ver-g', current_setting('prover.gv'))->>'member_count'`);
  assert.equal(g.result, 'ok|2', `AFTER: an unchanged group with its reviewed version did not post: ${g.result}`);
  const gStale = attempt(U.ADMIN, `${groupFx}\nSELECT set_config('prover.gv', public.get_invoice_group_post_version(current_setting('prover.group')::uuid), true);
    UPDATE public.invoices SET header_notes = '[PROVER] member edited' WHERE id = (SELECT id FROM public.invoices WHERE invoice_group_id = current_setting('prover.group')::uuid ORDER BY id DESC LIMIT 1);`,
  `public.post_invoice_group(current_setting('prover.group')::uuid, '${U.ADMIN}', 'prover-ao-ver-g2', current_setting('prover.gv'))`);
  assert.match(gStale.result, /^P0001\|INVOICE_CHANGED_SINCE_REVIEW: /, `AFTER: a group with an edited member posted: ${gStale.result}`);
  const gOld = attempt(U.ADMIN, groupFx, `public.post_invoice_group(current_setting('prover.group')::uuid, '${U.ADMIN}', 'prover-ao-ver-g3')->>'member_count'`);
  assert.equal(gOld.result, 'ok|2', `AFTER: an old group caller (no version) could not post: ${gOld.result}`);
  // Batch: one changed invoice refuses the whole batch.
  const b = attempt(U.ADMIN, `${miscDraftSql('prover.b1', 'b1')}\n${miscDraftSql('prover.b2', 'b2')}
    SELECT set_config('prover.bv', public.get_invoice_post_version(ARRAY[current_setting('prover.b1')::uuid, current_setting('prover.b2')::uuid]), true);
    UPDATE public.invoices SET header_notes = '[PROVER] b2 edited' WHERE id = current_setting('prover.b2')::uuid;`,
  `public.batch_post_invoices(ARRAY[current_setting('prover.b1')::uuid, current_setting('prover.b2')::uuid], 'prover-ao-ver-b', current_setting('prover.bv'))`,
  { after: "SELECT 'BSTATUS|' || (SELECT string_agg(status, ',') FROM public.invoices WHERE id IN (current_setting('prover.b1')::uuid, current_setting('prover.b2')::uuid));" });
  assert.match(b.result, /^P0001\|INVOICE_CHANGED_SINCE_REVIEW: /, `AFTER: a batch with a changed invoice posted: ${b.result}`);
  assert.ok(b.lines.includes('BSTATUS|draft,draft'), 'AFTER: the refused batch posted something');
  const bOk = attempt(U.ADMIN, `${miscDraftSql('prover.b1', 'b1')}\n${miscDraftSql('prover.b2', 'b2')}
    SELECT set_config('prover.bv', public.get_invoice_post_version(ARRAY[current_setting('prover.b1')::uuid, current_setting('prover.b2')::uuid]), true);`,
  `public.batch_post_invoices(ARRAY[current_setting('prover.b1')::uuid, current_setting('prover.b2')::uuid], 'prover-ao-ver-b-ok', current_setting('prover.bv'))->>'count'`);
  assert.equal(bOk.result, 'ok|2', `AFTER: an unchanged batch did not post: ${bOk.result}`);
  // Review round 1. A version without a key is refused, never silently ignored.
  const noKey = attempt(U.ADMIN, '', `public.post_invoice('${inv2}', NULL, '${v2}')`);
  assert.equal(noKey.result, '22023|IDEMPOTENCY_KEY_REQUIRED: post_invoice', `AFTER: a versioned post without a key: ${noKey.result}`);
  const blankBatch = attempt(U.ADMIN, '', `public.batch_post_invoices(ARRAY['${inv2}'::uuid], E' \\t', '${v2}')`);
  assert.equal(blankBatch.result, '22023|IDEMPOTENCY_KEY_REQUIRED: batch_post_invoices', `AFTER: a versioned batch with a blank key: ${blankBatch.result}`);
  // The same key reused for a different invoice is refused by the frozen body (the version is
  // not re-checked on a stored receipt, but the receipt's request must match).
  const inv3 = newMisc(`conflict-${run}`);
  const conflict = attempt(U.ADMIN, `${claims(U.ADMIN)} SELECT public.post_invoice('${inv2}', 'prover-ao-post-conflict-${run}') IS NULL;`,
    `public.post_invoice('${inv3}', 'prover-ao-post-conflict-${run}', '${versionOf([inv3])}')`);
  assert.match(conflict.result, /^P0001\|IDEMPOTENCY_ARGUMENT_MISMATCH: /, `AFTER: a key reused for another invoice with a version: ${conflict.result}`);
  // Every leg of the fingerprint counts: a customer share added after review.
  const shareStale = attempt(U.ADMIN, `INSERT INTO public.invoice_shares (invoice_id, customer_id, customer_name, split_percentage, amount_cents)
      VALUES ('${inv2}', '${C1}', '[PROVER] share added after review', 100, 1500);`, `public.post_invoice('${inv2}', 'prover-ao-ver-share', '${v2}')`);
  assert.match(shareStale.result, /^P0001\|INVOICE_CHANGED_SINCE_REVIEW: /, `AFTER: an invoice_shares change did not change the version: ${shareStale.result}`);
  // Same-key duplicate posts (two sessions): the second waits and replays.
  const dup = await dupKeyPost(`${phase}_${process.pid}_${versionRun}`);
  assert.equal(dup.result, 'ok', `AFTER: a same-key duplicate of a versioned post did not replay the first's success: ${dup.result}`);
  assert.equal(dup.status, 'posted');
  // Group: a line share edited, a member added, a member soft-deleted after review are refused;
  // an unchanged group that already has a soft-deleted member posts.
  const gv = "SELECT set_config('prover.gv', public.get_invoice_group_post_version(current_setting('prover.group')::uuid), true);";
  const ofGroup = "(SELECT ii.id FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id WHERE i.invoice_group_id = current_setting('prover.group')::uuid)";
  const gLineShare = attempt(U.ADMIN, `${groupFx}\n${gv}\nUPDATE public.invoice_line_shares SET split_override_reason = '[PROVER] line share edited after review' WHERE invoice_item_id IN ${ofGroup};`,
    `public.post_invoice_group(current_setting('prover.group')::uuid, '${U.ADMIN}', 'prover-ao-ver-gls', current_setting('prover.gv'))`,
    { after: `SELECT 'LINESHARES|' || (SELECT count(*) FROM public.invoice_line_shares WHERE invoice_item_id IN ${ofGroup});` });
  assert.ok(gLineShare.lines.some((l) => /^LINESHARES\|[1-9]/.test(l)), `AFTER: the group fixture has no invoice_line_shares rows to edit: ${gLineShare.lines.find((l) => l.startsWith('LINESHARES|'))}`);
  assert.match(gLineShare.result, /^P0001\|INVOICE_CHANGED_SINCE_REVIEW: /, `AFTER: an invoice_line_shares change did not change the group version: ${gLineShare.result}`);
  const gAdded = attempt(U.ADMIN, `${groupFx}\n${gv}
    INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by, invoice_group_id)
      SELECT 'PROVER-AO-NEW-MEMBER', customer_id, invoice_type, 'draft', invoice_date, 0, '${U.ADMIN}', invoice_group_id
        FROM public.invoices WHERE invoice_group_id = current_setting('prover.group')::uuid ORDER BY id LIMIT 1;`,
  `public.post_invoice_group(current_setting('prover.group')::uuid, '${U.ADMIN}', 'prover-ao-ver-gadd', current_setting('prover.gv'))`);
  assert.match(gAdded.result, /^P0001\|INVOICE_CHANGED_SINCE_REVIEW: /, `AFTER: a member added after review did not change the group version: ${gAdded.result}`);
  const softDelete = "UPDATE public.invoices SET deleted_at = now() WHERE id = (SELECT id FROM public.invoices WHERE invoice_group_id = current_setting('prover.group')::uuid ORDER BY id DESC LIMIT 1);";
  const gDropped = attempt(U.ADMIN, `${groupFx}\n${gv}\n${softDelete}`,
    `public.post_invoice_group(current_setting('prover.group')::uuid, '${U.ADMIN}', 'prover-ao-ver-gdrop', current_setting('prover.gv'))`);
  assert.match(gDropped.result, /^P0001\|INVOICE_CHANGED_SINCE_REVIEW: /, `AFTER: a member soft-deleted after review did not change the group version: ${gDropped.result}`);
  const gDeletedBefore = attempt(U.ADMIN, `${groupFx}\n${softDelete}\n${gv}`,
    `public.post_invoice_group(current_setting('prover.group')::uuid, '${U.ADMIN}', 'prover-ao-ver-gdel', current_setting('prover.gv'))->>'member_count'`);
  assert.equal(gDeletedBefore.result, 'ok|1', `AFTER: an unchanged group with a soft-deleted member did not post (reader and post must skip the same members): ${gDeletedBefore.result}`);
  // Two-session races for the group and the batch: the post blocks on the row a second admin is
  // changing and refuses once that change commits.
  const g1 = newGroup(`race-g-${run}`);
  const g1Version = groupVersionOf(g1);
  const g1Member = scalar(`SELECT id FROM public.invoices WHERE invoice_group_id = '${g1}' ORDER BY id LIMIT 1;`);
  const gRace = await racePost(`group_${run.replaceAll('-', '_')}`, {
    invoiceId: g1Member,
    holdSql: `UPDATE public.invoices SET header_notes = '[PROVER] member changed under the post' WHERE id = '${g1Member}';`,
    postSql: `PERFORM public.post_invoice_group('${g1}', '${U.ADMIN}', 'prover-ao-race-gpost-${run}', '${g1Version}')`,
  });
  assert.match(gRace.result, /^P0001\|INVOICE_CHANGED_SINCE_REVIEW: /, `AFTER: a group post with the reviewed version went through after a concurrent member change: ${gRace.result}`);
  assert.equal(gRace.status, 'draft', 'AFTER: the refused group post left a member posted');
  const b1 = newMisc(`race-b1-${run}`);
  const b2 = newMisc(`race-b2-${run}`);
  const bVersion = versionOf([b1, b2]);
  const bRace = await racePost(`batch_${run.replaceAll('-', '_')}`, {
    invoiceId: b2,
    holdSql: saveHeaderSql(b2, '[PROVER] changed under the batch', `prover-ao-race-bsave-${run}`),
    postSql: `PERFORM public.batch_post_invoices(ARRAY['${b1}', '${b2}']::uuid[], 'prover-ao-race-bpost-${run}', '${bVersion}')`,
  });
  assert.match(bRace.result, /^P0001\|INVOICE_CHANGED_SINCE_REVIEW: /, `AFTER: a batch post with the reviewed version went through after a concurrent save: ${bRace.result}`);
  assert.deepEqual([invoiceStatus(b1), bRace.status], ['draft', 'draft'], 'AFTER: the refused batch posted something');
  // Readers are admin-only too.
  for (const [who, uid] of NON_ADMINS) {
    expectRefused(attempt(uid, '', `public.get_invoice_post_version(ARRAY['${inv2}'::uuid])`), ADMIN_ONLY, `AFTER get_invoice_post_version as ${who}`);
    expectRefused(attempt(uid, '', 'public.get_invoice_group_post_version(gen_random_uuid())'), ADMIN_ONLY, `AFTER get_invoice_group_post_version as ${who}`);
  }
  // PostgREST overloads: exactly one callable function per name.
  assert.equal(scalar(`SELECT string_agg(proname || '=' || n, ',' ORDER BY proname) FROM (SELECT proname, count(*) n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
    WHERE s.nspname = 'public' AND proname IN ('post_invoice', 'post_invoice_group', 'batch_post_invoices') GROUP BY proname) t;`),
  'batch_post_invoices=1,post_invoice=1,post_invoice_group=1', 'AFTER: a posting RPC has more than one overload');
  return { race: race.result };
}

// ------------------------------------------------------------------------------------------------
// HARD-GUARD sweep (the same rule the migration's postflight enforces).
// The guard-first rule as the candidate spells it (the sweep's only acceptance test for a body).
const SWEEP_GUARD_FIRST = "     AND f.prosrc !~ '^\\s*(DECLARE(\\s+(?![Bb][Ee][Gg][Ii][Nn]\\M)\\w+\\s+[\\w\\[\\]. %]+;)*\\s+)?BEGIN\\s+PERFORM public\\._require_invoicing_admin\\(\\);'\n";
function sweepSql({ weak = false, looseDeclare = false, noExceptionRule = false, noDynamicRule = false } = {}) {
  const source = lf(CANDIDATE);
  const start = source.indexOf('  WITH RECURSIVE fn AS (');
  const end = source.indexOf('  IF v_unclassified IS NOT NULL THEN');
  assert.ok(start > 0 && end > start, 'the candidate has no catalog sweep');
  let query = source.slice(start, end);
  assert.equal(query.split(SWEEP_GUARD_FIRST).length - 1, 1, 'the sweep\'s guard-first rule is not the reviewed text');
  // The registered chain runs this exact query text.
  assert.ok(lf(CHAIN).includes(query), 'smoke-invoicing-admin-only.sql step 8 is not the postflight sweep query');
  // MUTATION (weak): accept any body that merely mentions the guard.
  if (weak) query = query.replace(SWEEP_GUARD_FIRST, "     AND f.prosrc !~ '_require_invoicing_admin'\n");
  // MUTATION (looseDeclare): the round-0 rule, which accepted any DECLARE section before the guard.
  if (looseDeclare) query = query.replace(SWEEP_GUARD_FIRST, "     AND f.prosrc !~ '^\\s*(DECLARE\\s[^$]*?)?BEGIN\\s+PERFORM public\\._require_invoicing_admin\\(\\);'\n");
  // MUTATIONS (review round 2): the exception-handler rule and the dynamic-SQL rule removed.
  const cutOnce = (from, to) => {
    assert.equal(query.split(from).length - 1, 1, `sweep mutation: the cut must match once: ${from}`);
    query = query.replace(from, to);
  };
  if (noExceptionRule) cutOnce("AND (f.body ~* '\\mexception\\s+when\\M' OR (true", 'AND (false OR (true');
  if (noDynamicRule) cutOnce("OR (body ~* '\\mexecute\\M'", "OR (false AND body ~* '\\mexecute\\M'");
  return `DO $sweep$
DECLARE v_unclassified text;
BEGIN
${query}
  RAISE NOTICE 'SWEEP|%', COALESCE(v_unclassified, 'none');
END
$sweep$;`;
}
const LATE_GUARD_WRITER = `CREATE FUNCTION public.prover_late_guard(p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$ BEGIN DELETE FROM public.invoice_items WHERE invoice_id = p; PERFORM public._require_invoicing_admin(); END $f$;
GRANT EXECUTE ON FUNCTION public.prover_late_guard(uuid) TO authenticated;`;
// PL/pgSQL runs DECLARE initializers before BEGIN: this "guard-first" body writes before its guard.
const DECLARE_WRITER = `CREATE FUNCTION public.prover_declare_writer(p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
DECLARE
  v uuid := public._save_invoice_pre_admin_only_20261009('{}'::jsonb, '[]'::jsonb, 'prover-ao-declare');
BEGIN
  PERFORM public._require_invoicing_admin();
END $f$;
GRANT EXECUTE ON FUNCTION public.prover_declare_writer(uuid) TO authenticated;`;
function sweep(extraSql = '', options = {}) {
  const r = docker([...psqlArgs(), '-A', '-t'], { input: `BEGIN;\n${extraSql}\n${sweepSql(options)}\nROLLBACK;\n`, allowFailure: true });
  assert.equal(r.status, 0, `the sweep failed to run:\n${r.stderr}`);
  return /SWEEP\|([^\n]*)/.exec(r.stderr)?.[1];
}

// Review round 2: a guard that an exception handler can swallow, and dynamic SQL.
const SWEEP_ROUND2_CASES = [
  ['a guard-first body whose exception handler swallows the refusal and then writes', `CREATE FUNCTION public.prover_swallow(p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM public.invoices WHERE id = p;
END $f$;
      GRANT EXECUTE ON FUNCTION public.prover_swallow(uuid) TO authenticated;`, 'prover_swallow(uuid)'],
  ['dynamic SQL that names an invoice table', `CREATE FUNCTION public.prover_dynamic(p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$ BEGIN EXECUTE 'DELETE FROM ' || 'public.' || 'invoices WHERE id = $1' USING p; END $f$;
      GRANT EXECUTE ON FUNCTION public.prover_dynamic(uuid) TO authenticated;`, 'prover_dynamic(uuid)'],
];

/** Section 8: the catalog sweep is clean and catches every kind of unguarded writer. */
function sweepChecks() {
  assert.equal(sweep(), 'none', 'AFTER: the catalog sweep found an unclassified invoice writer');
  assert.equal(sweep(`CREATE FUNCTION public.prover_new_writer(p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$ BEGIN DELETE FROM public.invoice_items WHERE invoice_id = p; END $f$;
    GRANT EXECUTE ON FUNCTION public.prover_new_writer(uuid) TO authenticated;`), 'prover_new_writer(uuid)', 'the sweep did not catch a new unguarded invoice writer');
  assert.equal(sweep(commentDriftSql('public.price_order(uuid,jsonb,uuid,text)')), 'price_order(uuid,jsonb,uuid,text)', 'the sweep did not catch a changed upkeep function');
  assert.equal(sweep(LATE_GUARD_WRITER), 'prover_late_guard(uuid)', 'the sweep accepted a guard that runs after the write');
  assert.equal(sweep(DECLARE_WRITER), 'prover_declare_writer(uuid)', 'the sweep accepted a writer in a DECLARE initializer before the guard');
  // Review round 1: every invoice table and write spelling, procedures, comment tricks.
  const sweepCases = [
    ['field_app_locations, UPDATE ONLY and quoted names', `CREATE FUNCTION public.prover_fal_writer(p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$ BEGIN UPDATE ONLY "public"."field_app_locations" SET applied_acres = 1 WHERE invoice_id = p; END $f$;
      GRANT EXECUTE ON FUNCTION public.prover_fal_writer(uuid) TO authenticated;`, 'prover_fal_writer(uuid)'],
    ['invoice_line_allocations in a procedure', `CREATE PROCEDURE public.prover_alloc_writer(p uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$ BEGIN DELETE FROM public.invoice_line_allocations WHERE invoice_id = p; END $f$;
      GRANT EXECUTE ON PROCEDURE public.prover_alloc_writer(uuid) TO authenticated;`, 'prover_alloc_writer(uuid)'],
    ['write_offs TRUNCATE', `CREATE FUNCTION public.prover_truncate_writer() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$ BEGIN TRUNCATE TABLE public.write_offs; END $f$;
      GRANT EXECUTE ON FUNCTION public.prover_truncate_writer() TO authenticated;`, 'prover_truncate_writer()'],
    ['a write after a line comment that opens a block comment', `CREATE FUNCTION public.prover_comment_writer(p uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$ BEGIN
      -- note /* never closed here
      DELETE FROM public.invoices WHERE id = p;
      /* closed */
      END $f$;
      GRANT EXECUTE ON FUNCTION public.prover_comment_writer(uuid) TO authenticated;`, 'prover_comment_writer(uuid)'],
    ['another function with the split key check before the guard', `CREATE FUNCTION public.prover_key_first(p uuid, p_idempotency_key text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._require_invoicing_admin();
  DELETE FROM public.invoices WHERE id = p;
END $f$;
      GRANT EXECUTE ON FUNCTION public.prover_key_first(uuid, text) TO authenticated;`, 'prover_key_first(uuid,text)'],
    ...SWEEP_ROUND2_CASES,
  ];
  for (const [label, sqlText, expected] of sweepCases) assert.equal(sweep(sqlText), expected, `the sweep did not catch ${label}`);
  console.log(`[prover] SWEEP: nothing authenticated can run reaches an invoice write without the guard unless pinned; a new unguarded writer, a writer whose guard runs after its write, a writer in a DECLARE initializer, a changed upkeep body and ${sweepCases.length} more (${sweepCases.map(([l]) => l).join('; ')}) are all caught; the registered chain runs the same query`);
}
function commentDriftSql(signature) {
  return `DO $drift$ BEGIN EXECUTE regexp_replace(pg_get_functiondef('${signature}'::regprocedure), '[$]function[$]\\s*$', '-- prover drift' || chr(10) || '$function$'); END $drift$;`;
}

// ------------------------------------------------------------------------------------------------
// Registered chains around the changed RPCs: they must end exactly as before.
function chainFiles() {
  const specs = JSON.parse(readFileSync(path.join(SMOKE, 'smoke-specs.json'), 'utf8')).specs;
  const names = new Set([...Object.keys(WRAPPED).map((s) => s.split('(')[0]), 'complete_job', 'complete_delivery', '_complete_delivery_authorized_impl']);
  const files = new Set();
  for (const spec of Object.values(specs)) {
    if ([Object.keys(specs).find((k) => specs[k] === spec), ...(spec.covers ?? [])].some((c) => names.has(c)) && spec.chain !== path.basename(CHAIN)) files.add(spec.chain);
  }
  return [...files].sort();
}
function runChain(file, source = lf(path.join(SMOKE, file))) {
  stageText(`chain-${file}`, source);
  const r = docker([...psqlArgs(), '-f', `/tmp/chain-${file}`], { allowFailure: true });
  const output = `${r.stdout}\n${r.stderr}`;
  if (/SMOKE_PASS_ROLLBACK/.test(output) && !/SMOKE_FAIL/.test(output)) return 'PASS';
  const error = /ERROR:\s+([^\n]*)/.exec(output)?.[1] ?? '(no error)';
  return `FAIL ${normalize(error).replace(/\b[0-9a-f]{8}\b/g, '<hex>').replace(/\d+/g, '<n>')}`;
}

// ------------------------------------------------------------------------------------------------
async function main() {
  if (!REUSE) buildContainer();
  if (REUSE && process.env.CRX_PROVER_MUTATIONS_ONLY === '1') {
    // Debugging only: rerun the mutation section on a kept container that already applied the
    // candidate (the full proof never takes this path).
    const inv = newMisc(`held-dev-${process.pid}`);
    scalar(`BEGIN; ${claims(U.ADMIN)} SELECT public.post_invoice('${inv}', 'prover-ao-held-dev-${process.pid}'); COMMIT; SELECT 1;`);
    const group = scalar(`BEGIN; ${faGroupSql(`held-dev-${process.pid}`, { posted: true, job: id((0x4a00 + (process.pid % 0xff)).toString(16)) })}
      SELECT set_config('prover.held_group', current_setting('prover.group'), false); COMMIT; SELECT current_setting('prover.held_group');`);
    console.log(`[prover] DEV mutations only: ${await mutations({ adminBefore: null, held: heldLockCases(inv, group) })}`);
    return;
  }
  if (REUSE && process.env.CRX_PROVER_AFTER_ONLY === '1') {
    // Debugging only: rerun the after-apply checks of sections 5-8 on a kept container that
    // already applied the candidate (the full proof never takes this path).
    tableAccess('after');
    customerNames('after');
    jobsAndQuick('after');
    await versionChecks('after');
    sweepChecks();
    console.log('[prover] DEV after-only checks passed');
    return;
  }

  // 0. FIDELITY.
  for (const [signature, pin] of Object.entries(LIVE_BODY_MD5)) assert.equal(lfBodyMd5(signature), pin, `${signature} replayed with a body that differs from live`);
  for (const [key, pin] of Object.entries(LIVE_POLICY_MD5)) assert.equal(policyMd5(...key.split('.')), pin, `${key} replayed with a policy that differs from live`);
  console.log(`[prover] FIDELITY: ${Object.keys(LIVE_BODY_MD5).length} function bodies (LF-normalized), ${Object.keys(LIVE_POLICY_MD5).length} policies and auth.uid() match the live pins of 2026-10-09`);

  if (!REUSE || scalar("SELECT count(*) FROM public.profiles WHERE id::text LIKE '6f200000-%';") === '0') seed();
  await proof();
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
  const migrations = selected();
  for (const [i, file] of migrations.entries()) {
    if (path.basename(file) === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${path.basename(file)}:\n${r.output}`);
  }
  console.log(`[prover] replayed ${migrations.length} post-baseline migrations before the candidate (skipped: ${[...PARKED].join(', ')})`);
  replayPr889(migrations);
  console.log(`[prover] PR #889: ${PR889_SCHEMA.join(', ')} replayed; all four #889 migrations recorded in the ledger`);
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, 'auth.uid() is not live\'s body');
}

async function proof() {
  const sequenceCaches = scalar(`SELECT string_agg(cache_size::text, ',') FROM pg_sequences WHERE schemaname = 'public' AND sequencename IN (${SEQUENCES.map((s) => `'${s}'`).join(', ')});`);
  assert.equal(sequenceCaches, '1,1,1,1', 'the invoice-number sequences must have CACHE 1 for the no-number-drawn checks');

  // 1. BEFORE.
  const adminBefore = invoicingMatrix('before');
  const readsBefore = tableAccess('before');
  const namesBefore = customerNames('before');
  const completionsBefore = completions('before');
  const jobsBefore = jobsAndQuick('before');
  const versionBefore = await versionChecks('before');
  const craceBefore = checkCompletionRace('before', await completionRace('before'));
  const chains = chainFiles();
  const chainsBefore = Object.fromEntries(chains.map((f) => [f, runChain(f)]));
  const chainFirst = runChain(path.basename(CHAIN), lf(CHAIN));
  assert.match(chainFirst, /^FAIL /, 'BEFORE: the new smoke chain passed against the pre-candidate schema, so it does not detect the bug');
  assert.match(chainFirst, /SMOKE_FAIL/, `BEFORE: the new smoke chain failed for a setup reason, not on the bug: ${chainFirst}`);
  console.log(`[prover] BEFORE (the bug): a sales rep invoiced through ${CASES.filter((c) => !c.repBefore).length} wrapped RPCs (each wrote rows); a rep's, a driver's and an offline completion auto-invoiced; a rep's split completion auto-split; a rep's job completion auto-drafted; reps' and drivers' quick deliveries created invoices; a rep inserted invoice_shares and invoice_line_allocations rows directly and rewrote a field invoice's field_app_locations (${readsBefore.direct.field_app_locations_update}) and field_app_location_shares (${readsBefore.direct.field_app_location_shares_update}) rows directly; a deactivated admin reversed a write-off; a rep read none of the admin's invoices (${readsBefore.rep}) and no name of another rep's customer (direct customers read ${namesBefore.rep}; no names reader); a post went through an invoice changed by a concurrent save (${versionBefore.race}); a rep's partial completion racing an admin's post never re-sized a posted invoice, even before the candidate (${craceBefore}); the new chain fails first (${chainFirst.slice(0, 120)})`);

  // 2a. AUTOCOMMIT.
  stageText('candidate.sql', lf(CANDIDATE));
  const loose = docker([...psqlArgs(), '-f', '/tmp/candidate.sql'], { allowFailure: true });
  assert.notEqual(loose.status, 0, 'the candidate applied without a transaction');
  assert.match(`${loose.stdout}\n${loose.stderr}`, /CRX_INVOICING_ADMIN_ONLY_NOT_IN_TRANSACTION/, `wrong autocommit refusal:\n${loose.stderr}`);
  assert.equal(lfBodyMd5('public.post_invoice(uuid,text)'), WRAPPED['post_invoice(uuid,text)'], 'AUTOCOMMIT changed post_invoice');
  console.log('[prover] AUTOCOMMIT: run statement by statement the file stops at its first check and changes nothing');

  // 2b. PREFLIGHT: each pin group refuses its own drift (each inside a transaction that rolls back).
  const commentDrift = commentDriftSql;
  const drifts = [
    ['wrapped RPC body', commentDrift('public.save_invoice(jsonb,jsonb,text)'), 'PREFLIGHT_RPC_DRIFT'],
    ['wrapped RPC granted to anon', 'GRANT EXECUTE ON FUNCTION public.post_invoice(uuid,text) TO anon;', 'PREFLIGHT_RPC_DRIFT'],
    ['wrapped RPC second overload', "CREATE FUNCTION public.unpost_invoice(uuid) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';", 'PREFLIGHT_RPC_DRIFT'],
    ['wrapped RPC security invoker', 'ALTER FUNCTION public.consolidate_draft_invoices(uuid,uuid,text) SECURITY INVOKER;', 'PREFLIGHT_RPC_DRIFT'],
    ['completion impl body', commentDrift(CDAI), 'PREFLIGHT_COMPLETE_DELIVERY_DRIFT'],
    ['complete_job body', commentDrift('public.complete_job(uuid,jsonb,uuid,text)'), 'PREFLIGHT_COMPLETE_JOB_DRIFT'],
    ['role helper', commentDrift('public.is_sales_rep()'), 'PREFLIGHT_HELPER_DRIFT'],
    ['posting lock-order impl', commentDrift('public._post_invoice_public_impl_20260718(uuid,text)'), 'PREFLIGHT_HELPER_DRIFT'],
    ['already-admin-only list', commentDrift('public.void_invoice(uuid,text,text)'), 'PREFLIGHT_SWEEP_LIST_DRIFT'],
    ['upkeep list', commentDrift('public.price_order(uuid,jsonb,uuid,text)'), 'PREFLIGHT_SWEEP_LIST_DRIFT'],
    ['replaced policy', 'ALTER POLICY invoices_select ON public.invoices USING (is_admin());', 'PREFLIGHT_POLICY_DRIFT'],
    ['replaced field-app write policy', 'ALTER POLICY field_app_locations_update ON public.field_app_locations USING (is_admin());', 'PREFLIGHT_POLICY_DRIFT'],
    ['newly wrapped RPC body (reverse_write_off)', commentDrift('public.reverse_write_off(uuid,text,uuid,text)'), 'PREFLIGHT_RPC_DRIFT'],
    ['extra policy', 'CREATE POLICY prover_extra ON public.invoice_shares FOR SELECT TO authenticated USING (true);', 'PREFLIGHT_POLICY_SET_DRIFT'],
    ['PR #889 missing from the ledger', `DELETE FROM supabase_migrations.schema_migrations WHERE name = '${PR889_DATA[1]}';`, 'PREFLIGHT_PR889_NOT_APPLIED'],
    ['an object it creates already exists', 'CREATE FUNCTION public._require_invoicing_admin() RETURNS void LANGUAGE sql AS $$ SELECT $$;', 'PREFLIGHT_ALREADY_APPLIED'],
    // Decision 2: the names reader already present; the customers read policies drifted.
    ['the names reader already exists', 'CREATE FUNCTION public.get_invoice_customer_names(uuid[]) RETURNS TABLE(id uuid, farm_name text) LANGUAGE sql AS $$ SELECT NULL::uuid, NULL::text $$;', 'PREFLIGHT_ALREADY_APPLIED'],
    ['customers read policy widened', 'ALTER POLICY customers_select ON public.customers USING (true);', 'PREFLIGHT_POLICY_DRIFT'],
    ['extra customers policy', 'CREATE POLICY prover_extra ON public.customers FOR SELECT TO authenticated USING (true);', 'PREFLIGHT_POLICY_SET_DRIFT'],
  ];
  for (const [label, driftSql, code] of drifts) {
    const r = docker(psqlArgs(), { input: `BEGIN;\n${driftSql}\n\\i /tmp/candidate.sql\nCOMMIT;\n`, allowFailure: true });
    assert.notEqual(r.status, 0, `PREFLIGHT (${label}): the candidate applied over the drift`);
    assert.match(`${r.stdout}\n${r.stderr}`, new RegExp(code), `PREFLIGHT (${label}): wrong refusal, expected ${code}:\n${r.stderr}`);
  }
  for (const [signature, pin] of Object.entries(LIVE_BODY_MD5)) assert.equal(lfBodyMd5(signature), pin, `PREFLIGHT: a rolled-back drift left ${signature} changed`);
  console.log(`[prover] PREFLIGHT: ${drifts.length} drifts (wrapped body, ACL, overload, security mode; both re-emitted bodies; role helper; posting lock-order impl; both sweep lists; a replaced policy; an extra policy; #889 not in the ledger; already applied; the names reader already present; customers_select widened; an extra customers policy) each refused with its own code; nothing changed`);

  // 2c. POSTFLIGHT mutants: the whole apply rolls back.
  const candidateText = lf(CANDIDATE);
  const wrapperOf = (text, name) => {
    const head = `CREATE FUNCTION public.${name}(`;
    const start = text.indexOf(head);
    assert.ok(start >= 0 && text.indexOf(head, start + 1) < 0, `the candidate must define ${name} once`);
    const end = text.indexOf('$function$;', start) + '$function$;'.length;
    return text.slice(start, end);
  };
  const bodyMd5 = (statement) => md5(statement.slice(statement.indexOf('$function$') + 10, statement.lastIndexOf('$function$')));
  const swapWrapper = (name, mutate) => {
    const original = wrapperOf(candidateText, name);
    const mutant = mutate(original);
    assert.notEqual(mutant, original, `postflight mutant for ${name} changed nothing`);
    return candidateText.replace(original, mutant).replace(`'${bodyMd5(original)}'`, `'${bodyMd5(mutant)}'`);
  };
  const guardLine = '  PERFORM public._require_invoicing_admin();\n';
  const uniqueCut = (text, from, to) => {
    assert.equal(text.split(from).length - 1, 1, `postflight mutant: the cut must match once: ${from.slice(0, 80)}`);
    return text.replace(from, to);
  };
  const postflightMutants = [
    ['a wrong wrapper pin', candidateText.replace(`'${bodyMd5(wrapperOf(candidateText, 'save_invoice'))}'`, `'${'0'.repeat(32)}'`), /POSTFLIGHT_WRAPPER_CONTRACT: public\.save_invoice/],
    ['the guard after the call (pin matched)', swapWrapper('unpost_invoice', (s) => s.replace(guardLine, '').replace('  RETURN public._unpost_invoice_pre_admin_only_20261009(', `  PERFORM 1;\n${guardLine}  RETURN public._unpost_invoice_pre_admin_only_20261009(`)), /POSTFLIGHT_WRAPPER_CONTRACT: public\.unpost_invoice must call _require_invoicing_admin\(\) first/],
    ['the split key check after the guard (pin matched)', swapWrapper('create_split_invoices_from_order', (s) => {
      const keyCheck = s.slice(s.indexOf('  IF p_idempotency_key IS NULL'), s.indexOf('  END IF;\n') + '  END IF;\n'.length);
      return s.replace(keyCheck, '').replace(guardLine, `${guardLine}${keyCheck}`);
    }), /POSTFLIGHT_WRAPPER_CONTRACT: public\.create_split_invoices_from_order must require its key/],
    ['an unguarded invoice writer', candidateText.replace('-- POSTFLIGHT: the exact reviewed result', `-- prover mutant\nCREATE FUNCTION public.prover_unguarded_writer() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$ UPDATE public.invoices SET header_notes = header_notes WHERE false $f$;\nGRANT EXECUTE ON FUNCTION public.prover_unguarded_writer() TO authenticated;\n-- POSTFLIGHT: the exact reviewed result`), /POSTFLIGHT_UNGUARDED_INVOICE_WRITER: prover_unguarded_writer\(\)/],
    // Review round 2: every other postflight branch fires on its own drift.
    ['a wrapper with an exception handler (pin matched)', swapWrapper('unpost_invoice', (s) => s.replace('  );\nEND;\n$function$', '  );\nEXCEPTION WHEN OTHERS THEN\n  RETURN NULL;\nEND;\n$function$')), /POSTFLIGHT_WRAPPER_CONTRACT: public\.unpost_invoice must not catch exceptions/],
    ['a frozen implementation left open to authenticated', uniqueCut(candidateText, 'REVOKE ALL ON FUNCTION public._save_invoice_pre_admin_only_20261009(jsonb,jsonb,text) FROM PUBLIC, anon, authenticated, service_role;\n', ''), /POSTFLIGHT_IMPL_CONTRACT: public\._save_invoice_pre_admin_only_20261009/],
    ['the guard helper without is_active', uniqueCut(candidateText, "       AND is_active = true\n  ) THEN\n    RAISE EXCEPTION 'INVOICING_ADMIN_ONLY", "  ) THEN\n    RAISE EXCEPTION 'INVOICING_ADMIN_ONLY"), /POSTFLIGHT_HELPER_CONTRACT/],
    ['a changed completion implementation', uniqueCut(candidateText, '  -- U9: short-stock WARN emit', '  -- prover drift\n  -- U9: short-stock WARN emit'), /POSTFLIGHT_REEMIT_CONTRACT/],
    ['a table write grant left in place', uniqueCut(candidateText, 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.field_app_locations, public.field_app_location_shares, public.write_offs FROM authenticated, anon, PUBLIC;\n', ''), /POSTFLIGHT_TABLE_GRANTS/],
    ['a replaced write policy left widened', uniqueCut(candidateText, 'CREATE POLICY invoices_insert ON public.invoices\n  FOR INSERT TO public\n  WITH CHECK (public.is_admin());', 'CREATE POLICY invoices_insert ON public.invoices\n  FOR INSERT TO public\n  WITH CHECK (public.is_admin() OR public.is_sales_rep());'), /POSTFLIGHT_POLICY_CONTRACT: invoices\.invoices_insert/],
    ['a trigger writing an invoice table from a table authenticated can write', candidateText.replace('-- POSTFLIGHT: the exact reviewed result', `-- prover mutant
CREATE TABLE public.prover_trigger_source (id int);
GRANT INSERT ON public.prover_trigger_source TO authenticated;
CREATE FUNCTION public.prover_invoice_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$ BEGIN UPDATE public.invoice_items SET description = description WHERE false; RETURN NEW; END $f$;
REVOKE ALL ON FUNCTION public.prover_invoice_trigger() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER prover_invoice_trigger AFTER INSERT ON public.prover_trigger_source FOR EACH ROW EXECUTE FUNCTION public.prover_invoice_trigger();
-- POSTFLIGHT: the exact reviewed result`), /POSTFLIGHT_INVOICE_TRIGGER: prover_invoice_trigger on prover_trigger_source/],
    // Decision 2 (Mason 2026-10-10): the names-only reader's contract, and the customers policies.
    ['the names reader left executable by anon', uniqueCut(candidateText, 'GRANT EXECUTE ON FUNCTION public.get_invoice_customer_names(uuid[]) TO authenticated;\n', 'GRANT EXECUTE ON FUNCTION public.get_invoice_customer_names(uuid[]) TO authenticated, anon;\n'), /POSTFLIGHT_CUSTOMER_NAMES_CONTRACT/],
    ['the names reader returning another column (pin matched)', swapWrapper('get_invoice_customer_names', (s) => s
      .replace('RETURNS TABLE(id uuid, farm_name text)', 'RETURNS TABLE(id uuid, farm_name text, contact_name text)')
      .replace('  SELECT c.id, c.farm_name\n', '  SELECT c.id, c.farm_name, c.contact_name\n')), /POSTFLIGHT_CUSTOMER_NAMES_CONTRACT/],
    ['customers_select widened in the file', candidateText.replace('-- POSTFLIGHT: the exact reviewed result', '-- prover mutant\nALTER POLICY customers_select ON public.customers USING (true);\n-- POSTFLIGHT: the exact reviewed result'), /POSTFLIGHT_CUSTOMERS_POLICY/],
    ['an extra customers read policy in the file', candidateText.replace('-- POSTFLIGHT: the exact reviewed result', '-- prover mutant\nCREATE POLICY prover_rep_customers ON public.customers FOR SELECT TO authenticated USING (public.is_sales_rep());\n-- POSTFLIGHT: the exact reviewed result'), /POSTFLIGHT_CUSTOMERS_POLICY/],
  ];
  for (const [label, text, code] of postflightMutants) {
    assert.notEqual(text, candidateText, `POSTFLIGHT (${label}): the mutant is the candidate`);
    stageText('postflight-mutant.sql', text);
    const r = apply('postflight-mutant.sql');
    assert.notEqual(r.status, 0, `POSTFLIGHT (${label}): the mutant applied`);
    assert.match(r.output, code, `POSTFLIGHT (${label}): wrong refusal:\n${r.output}`);
    assert.doesNotMatch(r.output, /POSTFLIGHT_OK/, `POSTFLIGHT (${label}): printed POSTFLIGHT_OK`);
    assert.equal(lfBodyMd5('public.post_invoice(uuid,text)'), WRAPPED['post_invoice(uuid,text)'], `POSTFLIGHT (${label}): the rollback left post_invoice changed`);
  }
  console.log(`[prover] POSTFLIGHT: ${postflightMutants.length} mutants (${postflightMutants.map(([l]) => l).join('; ')}) each roll the whole apply back with their own code`);

  // 3. APPLY.
  const oids = scalar("SELECT string_agg(oid::text, ',' ORDER BY oid) FROM pg_proc WHERE oid IN ('public.complete_job(uuid,jsonb,uuid,text)'::regprocedure, '" + CDAI + "'::regprocedure, 'public.post_invoice(uuid,text)'::regprocedure);");
  const applied = apply('candidate.sql');
  assert.equal(applied.status, 0, `candidate failed to apply:\n${applied.output}`);
  assert.match(applied.output, /POSTFLIGHT_OK/, `candidate applied without its postflight notice:\n${applied.output}`);
  for (const [sig, pin] of Object.entries(WRAPPED)) {
    const name = sig.split('(')[0];
    assert.equal(lfBodyMd5(`public._${name}_pre_admin_only_20261009(${sig.split('(')[1]}`), pin, `APPLY: the frozen ${name} body changed`);
  }
  assert.equal(scalar("SELECT string_agg(oid::text, ',' ORDER BY oid) FROM pg_proc WHERE oid IN ('public.complete_job(uuid,jsonb,uuid,text)'::regprocedure, '" + CDAI + "'::regprocedure, 'public._post_invoice_pre_admin_only_20261009(uuid,text)'::regprocedure);"), oids,
    'APPLY: a re-emitted function or the renamed post_invoice changed OID');
  console.log('[prover] APPLY: POSTFLIGHT_OK; each frozen implementation keeps its live body and OID; the re-emissions keep their OIDs');

  // 4. AFTER: the invoicing matrix.
  const adminAfter = invoicingMatrix('after');
  for (const c of CASES) {
    assert.deepEqual(adminAfter[c.n], adminBefore[c.n], `AFTER ${c.n}: the admin's result or database state differs from BEFORE`);
  }
  splitKeyChecks();
  // Ordering: refused while another session holds the locks the call would take first.
  // Committed fixtures: a posted invoice and a posted field-app split group (its own job).
  const heldInv = newMisc('held');
  scalar(`BEGIN; ${claims(U.ADMIN)} SELECT public.post_invoice('${heldInv}', 'prover-ao-held-setup'); COMMIT; SELECT 1;`);
  const heldGroup = scalar(`BEGIN; ${faGroupSql('held', { posted: true, job: id('4900') })}
    SELECT set_config('prover.held_group', current_setting('prover.group'), false); COMMIT; SELECT current_setting('prover.held_group');`);
  assert.match(heldGroup, /^[0-9a-f-]{36}$/, `the committed held group was not created: ${heldGroup}`);
  const heldCases = heldLockCases(heldInv, heldGroup);
  for (const [label, hold, call] of Object.values(heldCases)) {
    for (const [who, uid] of [['sales rep', U.REP], ['driver', U.DRIVER]]) {
      expectRefused(await heldAttempt(uid, '', hold, call(uid), `${label}-${who}`), ADMIN_ONLY, `AFTER ${label} as ${who} with its locks held`);
    }
  }
  const quickAfter = attempt(U.APPLICATOR, '', QUICK_CALL(U.APPLICATOR, 'prover-ao-qd-applicator'));
  assert.equal(quickAfter.result, 'P0001|INSUFFICIENT_ROLE', `AFTER: an applicator's quick delivery outcome changed: ${quickAfter.result}`);
  // The sweep's pinned "already admin-only" list is a claim: check each refuses a sales rep for
  // its role (reverse_write_off left that list in review round 1: it is wrapped now).
  const alreadyAdminOnly = [
    ['void_invoice', '', `public.void_invoice(gen_random_uuid(), 'r', 'prover-ao-l1')`, /^P0001\|Only admin users can void invoices$/],
    ['void_invoice_group', '', `public.void_invoice_group(gen_random_uuid(), 'r', 'prover-ao-l2')`, /^P0001\|Only admin users can void invoices$/],
    ['delete_invoices', '', `public.delete_invoices(ARRAY[gen_random_uuid()], auth.uid(), 'prover-ao-l3')`, /^P0001\|Permission denied: requires admin role$/],
    ['create_invoice_for_unbilled_delivery', '', `public.create_invoice_for_unbilled_delivery(gen_random_uuid(), auth.uid(), 'prover-ao-l4')`, /^P0001\|Admin access required to create an invoice for a delivery$/],
    ['generate_finance_charges', '', `public.generate_finance_charges(CURRENT_DATE, auth.uid(), NULL, 'prover-ao-l5')`, /^P0001\|INSUFFICIENT_ROLE$/],
    ['issue_return_credit', '', `public.issue_return_credit(gen_random_uuid(), auth.uid(), 'prover-ao-l6')`, /^P0001\|ADMIN_REQUIRED$/],
    ['unapply_credit_memo', '', `public.unapply_credit_memo(gen_random_uuid(), 'r', auth.uid(), 'prover-ao-l7')`, /^P0001\|INSUFFICIENT_ROLE$/],
    ['apply_write_off', '', `public.apply_write_off(gen_random_uuid(), 100, 'r', auth.uid(), 'prover-ao-l8')`, /^P0001\|INSUFFICIENT_ROLE$/],
    ['void_payment', '', `public.void_payment(gen_random_uuid(), 'r', auth.uid(), 'prover-ao-l10')`, /^P0001\|INSUFFICIENT_ROLE$/],
    // Hard-disabled for every role (20260620200000) before its admin check.
    ['apply_remaining_prepayments', '', `public.apply_remaining_prepayments(gen_random_uuid(), auth.uid(), 'prover-ao-l11')`, /^P0001\|PREPAY_BULK_APPLY_DISABLED$/],
    ['batch_apply_prepayments', '', `public.batch_apply_prepayments('[]'::jsonb, auth.uid(), 'prover-ao-l12')`, /^42501\|Admin access required$/],
    ['void_order', '', `public.void_order(gen_random_uuid(), auth.uid(), 'r', 'prover-ao-l13')`, /^P0001\|INSUFFICIENT_ROLE$/],
    ['cancel_order', '', `public.cancel_order(gen_random_uuid(), auth.uid(), 'prover-ao-l14')`, /^P0001\|INSUFFICIENT_ROLE$/],
    ['void_delivery', '', `public.void_delivery(gen_random_uuid(), 'r', auth.uid(), 'prover-ao-l15')`, /^P0001\|Admin access required to void a completed delivery$/],
  ];
  for (const [name, fixture, call, expected] of alreadyAdminOnly) {
    expectRefused(attempt(U.REP, fixture, call), expected, `AFTER already-admin-only ${name} as a sales rep`);
  }
  // Review round 2: the frozen implementations. No API role can execute any of them (catalog),
  // and a direct PostgREST-style call is refused for a sales rep, an admin and anon.
  for (const sig of Object.keys(WRAPPED)) {
    const impl = `public._${sig.split('(')[0]}_pre_admin_only_20261009(${sig.split('(')[1]}`;
    assert.equal(scalar(`SELECT has_function_privilege('authenticated', '${impl}', 'EXECUTE') OR has_function_privilege('anon', '${impl}', 'EXECUTE') OR has_function_privilege('service_role', '${impl}', 'EXECUTE');`), 'f', `AFTER: an API role can execute ${impl}`);
  }
  const frozenCalls = [
    "public._post_invoice_pre_admin_only_20261009(gen_random_uuid(), 'prover-ao-frozen-post')",
    "public._save_invoice_pre_admin_only_20261009('{}'::jsonb, '[]'::jsonb, 'prover-ao-frozen-save')",
    `public._create_quick_delivery_pre_admin_only_20261009('${C1}', '[]'::jsonb, NULL, CURRENT_DATE, NULL, NULL, 'prover-ao-frozen-qd', false)`,
  ];
  for (const [who, uid, role] of [['sales rep', U.REP, 'authenticated'], ['admin', U.ADMIN, 'authenticated'], ['anon', U.REP, 'anon']]) {
    for (const call of frozenCalls) {
      expectRefused(attempt(uid, '', call, { role }), /^42501\|permission denied for function _\w+_pre_admin_only_20261009$/, `AFTER frozen implementation called directly as ${who}`);
    }
  }
  // service_role: no auth.uid() (no subject in its claims), so the guard refuses it as well.
  const serviceRole = attempt(U.REP, '', `PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true); PERFORM set_config('request.jwt.claim.sub', '', true); PERFORM ${CASES[0].call(U.REP, 'prover-ao-service-role')}`, { role: 'service_role', statement: true });
  expectRefused(serviceRole, ADMIN_ONLY, 'AFTER save_invoice as service_role (no subject)');
  console.log(`[prover] AFTER: all ${CASES.length} wrapped RPCs refuse ${NON_ADMINS.map(([w]) => w).join(', ')} with 42501 INVOICING_ADMIN_ONLY (no number drawn, nothing left in ${COUNT_TABLES.length} counted tables); ${Object.keys(heldCases).join(', ')} also refuse a rep and a driver while a second session holds the invoice row and the key's locks (the other wrappers' guard-first order rests on the postflight's structural check and the no-number-drawn check); anon cannot execute any; a service_role caller with no subject is refused; no API role can execute any frozen implementation and direct calls to three of them are refused for a rep, an admin and anon; the split wrapper refuses a NULL/empty/whitespace key for the admin and every non-admin role; each of the ${alreadyAdminOnly.length} pinned already-admin-only functions refuses a sales rep for its role; admins get the same result, database state and per-table row counts as BEFORE for every case, and each exact replay returns the stored result`);

  // 5. READ SIDE.
  const readsAfter = tableAccess('after');
  const namesAfter = customerNames('after');
  console.log(`[prover] CUSTOMER NAMES (Decision 2, Mason 2026-10-10): a sales rep, another sales rep and an admin read exactly ${namesAfter.names.slice(3)} through get_invoice_customer_names (the invoice's customer and a share customer, both another rep's; not a customer on no invoice or only on a soft-deleted one), columns id and farm_name only, no contact or address; a rep's direct customers read of the same rows is still ${namesAfter.rep} (customers policy not widened); driver, applicator, entity_recipient, deactivated admin and a caller with no profile get no rows; anon and service_role cannot execute it; a NULL id list returns nothing`);
  console.log(`[prover] READ SIDE: a rep now reads every invoice table the invoice pages read (${readsAfter.rep}, same as the admin, including an invoice on ANOTHER rep's customer); drivers and applicators read nothing, as before; every direct rep write is permission denied: invoice_shares / invoice_line_allocations insert, ${Object.keys(readsAfter.direct).join(', ')} (before: field_app_locations update ${readsBefore.direct.field_app_locations_update}, field_app_location_shares update ${readsBefore.direct.field_app_location_shares_update})`);

  // 6. DELIVERIES AND JOBS.
  const completionsAfter = completions('after');
  assert.equal(completionsAfter.manual_rep, completionsBefore.rep.lines, 'AFTER: the admin\'s Create Invoice lines differ from the old auto-invoice\'s (rep completion)');
  assert.equal(completionsAfter.manual_driver, completionsBefore.driver.lines, 'AFTER: the admin\'s Create Invoice lines differ from the old auto-invoice\'s (driver completion)');
  assert.deepEqual(completionsAfter.admin, completionsBefore.admin, 'AFTER: an admin\'s completion changed');
  assert.equal(completionsAfter.quickDraftResize, completionsBefore.quickDraftResize, 'AFTER: the partial-delivery resize of an admin\'s draft changed');
  const jobsAfter = jobsAndQuick('after');
  assert.equal(jobsAfter.admin, jobsBefore.admin, 'AFTER: an admin\'s job completion changed');
  assert.equal(jobsAfter.applicator, jobsBefore.applicator.replace('completed by an applicator — automatic draft invoice skipped (auto-draft only runs for office completions).', 'completed by a non-admin — automatic draft invoice skipped (invoicing is admin-only).'), 'AFTER: an applicator\'s job completion changed beyond the skip text');
  assert.equal(jobsAfter.qd_admin, jobsBefore.qd_admin, 'AFTER: an admin\'s quick delivery changed');
  for (const key of Object.keys(jobsBefore).filter((k) => k.startsWith('cancel_'))) assert.equal(jobsAfter[key], jobsBefore[key], `AFTER: cancel_delivery changed (${key}; Mason: unchanged)`);
  console.log('[prover] DELIVERIES AND JOBS: rep, driver and offline (rep and driver) completions complete with no invoice and no number, one activity row and one notification per active admin, listed under "Delivered, not invoiced"; the admin\'s Create Invoice then bills the same lines the old auto-invoice had; a rep\'s split completion falls back to needs_split_billing; admin completions still auto-draft (unchanged); a rep\'s partial delivery still resizes an admin\'s quick-delivery draft; a rep\'s job completion skips the draft with the admin-only text, an admin\'s still drafts; reps\' and drivers\' quick deliveries make no invoice; cancel_delivery is unchanged');

  // 7. POSTING VERSION CHECK.
  const versionAfter = await versionChecks('after');
  const craceAfter = checkCompletionRace('after', await completionRace('after'));
  console.log(`[prover] COMPLETION RACE (review round 2): a rep's partial completion that re-sized an admin's draft and waits on it while the admin's versioned post runs: posting locks the order's order_items (guard_mono_invoice_split_billing_post), which the completion holds, so one side is aborted as a deadlock and nothing of it commits; a posted invoice is never re-sized. After: ${craceAfter}. Before: ${craceBefore}`);
  console.log(`[prover] POSTING VERSION CHECK: a post, a group post and a batch post with the reviewed version each blocked behind a second admin's uncommitted change and refused once it committed (${versionAfter.race}); a same-key duplicate post waited for the first and replayed its success; unchanged invoice, group and batch post (also a group with a soft-deleted member); a replay is not re-checked; old callers (positional and PostgREST named arguments, no version) still post; a stale header, a line-only change, a customer share added, a line share edited, a group member edited, added or soft-deleted and one changed batch member are refused with nothing posted; a version without a key is IDEMPOTENCY_KEY_REQUIRED; a key reused for another invoice is refused; a malformed version is 22023; both version readers are admin-only; one overload per posting RPC`);

  // 8. SWEEP.
  sweepChecks();

  // 9. CHAINS.
  assert.equal(runChain(path.basename(CHAIN), lf(CHAIN)), 'PASS', 'AFTER: the new smoke chain did not pass');
  const chainsAfter = Object.fromEntries(chains.map((f) => [f, runChain(f)]));
  // The one allowed difference is the intended one: a chain that drives an invoicing RPC as a sales
  // rep (or driver) now stops at that call with INVOICING_ADMIN_ONLY. Every other outcome must be
  // identical; a chain that passed before must still pass.
  const changedByDesign = [];
  for (const f of chains) {
    if (chainsAfter[f] === chainsBefore[f]) continue;
    assert.notEqual(chainsBefore[f], 'PASS', `CHAIN ${f}: passed before the candidate and not after (${chainsAfter[f]})`);
    assert.match(chainsAfter[f], /INVOICING_ADMIN_ONLY/, `CHAIN ${f}: ended differently after the candidate (${chainsBefore[f]} -> ${chainsAfter[f]})`);
    assert.match(lf(path.join(SMOKE, f)), /\brole\s*=\s*'(sales_rep|driver)'/, `CHAIN ${f}: refused INVOICING_ADMIN_ONLY but drives no sales rep or driver`);
    changedByDesign.push(`${f} (${chainsBefore[f].slice(0, 90)} -> stops at INVOICING_ADMIN_ONLY)`);
  }
  console.log(`[prover] CHAINS: smoke-invoicing-admin-only passes; of ${chains.length} registered chains around these RPCs, ${Object.values(chainsAfter).filter((x) => x === 'PASS').length} pass before and after, ${chains.length - changedByDesign.length - Object.values(chainsAfter).filter((x) => x === 'PASS').length} fail identically before and after (container fixtures), and ${changedByDesign.length} that drive invoicing as a sales rep now stop at INVOICING_ADMIN_ONLY - the intended change; they need their rep steps rewritten: ${changedByDesign.join('; ') || 'none'}`);
  console.log(`[prover] CHAIN OUTCOMES: ${chains.map((f) => `${f}=${chainsAfter[f] === 'PASS' ? 'PASS' : 'FAIL'}`).join(', ')}`);
  // The label "container fixtures" above is NOT checked: these chains already fail on the
  // pre-candidate schema (main), so they give no evidence either way about this change. Each
  // one's first error, identical before and after, is printed so a reader can judge it.
  const unchangedFailures = chains.filter((f) => chainsBefore[f] !== 'PASS' && chainsAfter[f] === chainsBefore[f]);
  console.log(`[prover] CHAINS FAILING BEFORE AND AFTER (no signal; first error, identical both times): ${unchangedFailures.map((f) => `${f}: ${chainsBefore[f].slice(0, 160)}`).join(' | ') || 'none'}`);

  // 10. RE-APPLY.
  const reapplied = apply('candidate.sql');
  assert.notEqual(reapplied.status, 0, 'the candidate re-applied over itself');
  assert.match(reapplied.output, /PREFLIGHT_ALREADY_APPLIED/, `wrong re-apply refusal:\n${reapplied.output}`);
  console.log('[prover] RE-APPLY: refused on its own preflight; nothing changed');

  // 11. MUTATIONS: one per gate.
  const mutationCount = await mutations({ adminBefore, held: heldCases });
  console.log(`INVOICING_ADMIN_ONLY_PROOF_PASS pr889=replayed_and_required before=bug_reproduced(rep_wrote_through_${CASES.filter((c) => !c.repBefore).length}_of_${CASES.length}_rpcs,completions,jobs,quick,rest,reads,post_race) autocommit=refused preflight=${drifts.length}_drifts postflight=${postflightMutants.length}_mutants after=refused_all_non_admins_no_number,held_locks_${Object.keys(heldCases).length}_rpcs,frozen_impls_closed admin=identical_incl_replay_and_row_counts reads=rep_all,driver_unchanged customer_names=rep_names_only,customers_policy_unwidened,others_none,anon_denied completions=no_invoice,admins_notified,listed,manual_same_lines completion_race=posted_invoice_never_resized_before_and_after version_check=race_refused,unchanged_posts,old_callers sweep=clean,catches_new_writer chains=${Object.values(chainsAfter).filter((x) => x === 'PASS').length}_pass,${unchangedFailures.length}_fail_before_and_after_no_signal,${changedByDesign.length}_rep_chains_stop_at_admin_only reapply=refused mutations=${mutationCount}_detected`);
}

async function mutations({ adminBefore, held }) {
  const candidateText = lf(CANDIDATE);
  const statementOf = (head) => {
    const start = candidateText.indexOf(head);
    assert.ok(start >= 0 && candidateText.indexOf(head, start + 1) < 0, `mutation: ${head} must occur once`);
    return `${candidateText.slice(start, candidateText.indexOf('$function$;', start) + '$function$;'.length).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION')}\n`;
  };
  const once = (text, from, to, label) => {
    assert.equal(text.split(from).length - 1, 1, `mutation ${label}: the cut must match once`);
    return text.replace(from, to);
  };
  let count = 0;
  // Review round 2: a mutant may name the failure it must cause (`expected`, matched against the
  // assertion message), so an unrelated flake cannot count as its detection.
  const detect = (label, check, expected = null) => {
    let failed = false;
    try { check(); } catch (e) {
      failed = e instanceof assert.AssertionError || /AssertionError/.test(e?.name ?? '');
      if (!failed) throw e;
      if (expected) assert.match(e.message, expected, `MUTATION ${label}: red for another reason: ${e.message}`);
    }
    assert.ok(failed, `MUTATION ${label}: the prover stayed green`);
    count += 1;
  };
  const detectAsync = async (label, check, expected = null) => {
    let failed = false;
    try { await check(); } catch (e) {
      failed = e instanceof assert.AssertionError;
      if (!failed) throw e;
      if (expected) assert.match(e.message, expected, `MUTATION ${label}: red for another reason: ${e.message}`);
    }
    assert.ok(failed, `MUTATION ${label}: the prover stayed green`);
    count += 1;
  };
  const guardLine = '  PERFORM public._require_invoicing_admin();\n';
  // (1) Each wrapper without its guard: the AFTER refusal of a sales rep fails.
  for (const c of CASES) {
    const head = `CREATE FUNCTION public.${c.n}(`;
    const original = statementOf(head);
    if (!original.includes(guardLine)) continue;
    applyText(`mutant-${c.n}.sql`, once(original, guardLine, '', c.n));
    // The plain refusal, then (where the prover has one) the held-lock ordering check: a wrapper
    // whose frozen body reaches another guarded wrapper still ends in INVOICING_ADMIN_ONLY without
    // its own guard, but only after taking its locks.
    await detectAsync(`${c.n} without its guard`, async () => {
      expectRefused(attempt(U.REP, c.fx(), c.call(U.REP, `prover-ao-mut-${c.n}`)), ADMIN_ONLY, `mutant ${c.n}`);
      if (held[c.n]) {
        const [label, hold, call] = held[c.n];
        expectRefused(await heldAttempt(U.REP, '', hold, call(U.REP), `mutant-${label}`), ADMIN_ONLY, `mutant ${c.n} with its locks held`);
      }
    });
    applyText(`restore-${c.n}.sql`, original);
    expectRefused(attempt(U.REP, c.fx(), c.call(U.REP, `prover-ao-mut-${c.n}-restored`)), ADMIN_ONLY, `restored ${c.n}`);
    if (held[c.n]) {
      const [label, hold, call] = held[c.n];
      expectRefused(await heldAttempt(U.REP, '', hold, call(U.REP), `restored-${label}`), ADMIN_ONLY, `restored ${c.n} with its locks held`);
    }
  }
  const guardedCount = count;
  // (2) The split wrapper without its key check.
  const split = statementOf('CREATE FUNCTION public.create_split_invoices_from_order(');
  const keyCheck = split.slice(split.indexOf('  IF p_idempotency_key IS NULL'), split.indexOf('  END IF;\n') + '  END IF;\n'.length);
  applyText('mutant-split-key.sql', once(split, keyCheck, '', 'split key'));
  detect('split without its key check', () => splitKeyChecks());
  applyText('restore-split-key.sql', split);
  // (3) The guard helper: the NULL fail-open form, and without is_active.
  const helper = statementOf('CREATE FUNCTION public._require_invoicing_admin(');
  applyText('mutant-helper-null.sql', once(helper, `  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = auth.uid()
       AND role = 'admin'
       AND is_active = true
  ) THEN`, "  IF (SELECT role FROM public.profiles WHERE id = auth.uid() AND is_active = true) <> 'admin' THEN", 'helper null'));
  detect('guard helper in the NULL fail-open form', () => expectRefused(attempt(U.NOPROFILE, '', CASES[0].call(U.NOPROFILE, 'prover-ao-mut-null')), ADMIN_ONLY, 'mutant helper null'));
  applyText('mutant-helper-active.sql', once(helper, "       AND is_active = true\n  ) THEN", '  ) THEN', 'helper active'));
  detect('guard helper without is_active', () => expectRefused(attempt(U.ADMIN_OFF, '', CASES[0].call(U.ADMIN_OFF, 'prover-ao-mut-active')), ADMIN_ONLY, 'mutant helper active'));
  applyText('restore-helper.sql', helper);
  // (4) 1c: the completion hunk reverted (ELSIF -> ELSE): a rep's completion invoices again.
  const cdai = statementOf('CREATE OR REPLACE FUNCTION public._complete_delivery_authorized_impl(');
  applyText('mutant-cdai.sql', once(cdai, "      ELSIF v_actor_role = 'admin' THEN\n", '      ELSE\n', 'cdai').replace(/      ELSE\n        -- Invoicing is admin-only[\s\S]*?        END LOOP;\n(?=      END IF;\n    END IF;\n  END IF;)/, ''));
  // The named failures: the rep's completion invoiced, or (first in the probe) the admin's manual
  // billing of that delivery is refused because the mutant's auto-invoice already covers it.
  detect('completion auto-invoice for non-admins', () => completions('after'), /a non-admin's completion (created an invoice|drew an invoice number)|This delivery already has an active invoice/);
  applyText('restore-cdai.sql', cdai);
  // (5) 1d: complete_job drafts for reps again.
  const job = statementOf('CREATE OR REPLACE FUNCTION public.complete_job(');
  applyText('mutant-job.sql', once(job, '      IF is_admin() THEN\n', '      IF (is_admin() OR is_sales_rep()) THEN\n', 'job'));
  detect('complete_job auto-draft for reps', () => jobsAndQuick('after'));
  applyText('restore-job.sql', job);
  // (5b) 1d: no admin notification when a non-admin's completion skips the draft.
  const notifyStart = job.indexOf('        INSERT INTO notifications (');
  const notifyEnd = job.indexOf("WHERE p.role = 'admin' AND p.is_active = true;\n", notifyStart) + "WHERE p.role = 'admin' AND p.is_active = true;\n".length;
  assert.ok(notifyStart > 0 && notifyEnd > notifyStart, 'mutation: complete_job has no admin notification hunk');
  applyText('mutant-job-notify.sql', job.slice(0, notifyStart) + job.slice(notifyEnd));
  detect('complete_job without the admin notification', () => jobsAndQuick('after'));
  applyText('restore-job-notify.sql', job);
  // (6) 1e: quick delivery without the coercion.
  const quick = statementOf('CREATE FUNCTION public.create_quick_delivery(');
  applyText('mutant-quick.sql', once(quick, 'p_skip_invoice => CASE WHEN public.is_admin() THEN p_skip_invoice ELSE true END', 'p_skip_invoice => p_skip_invoice', 'quick'));
  detect('quick delivery without the coercion', () => jobsAndQuick('after'));
  applyText('restore-quick.sql', quick);
  // (7) Table grants and write policies (each layer on its own).
  const layers = [
    ['invoice_shares INSERT re-granted', 'GRANT INSERT ON public.invoice_shares TO authenticated;', 'REVOKE INSERT ON public.invoice_shares FROM authenticated;'],
    ['invoice_line_allocations INSERT re-granted', 'GRANT INSERT ON public.invoice_line_allocations TO authenticated;', 'REVOKE INSERT ON public.invoice_line_allocations FROM authenticated;'],
    ['write_offs INSERT re-granted', 'GRANT INSERT ON public.write_offs TO authenticated;', 'REVOKE INSERT ON public.write_offs FROM authenticated;'],
    // Both layers removed together: the rep's write really lands, so the check fails on the
    // outcome (a row written), not on an error message.
    ['invoice_shares INSERT re-granted AND its policy widened', 'GRANT INSERT ON public.invoice_shares TO authenticated; ALTER POLICY invoice_shares_insert ON public.invoice_shares WITH CHECK (is_admin() OR is_sales_rep());',
      'REVOKE INSERT ON public.invoice_shares FROM authenticated; ALTER POLICY invoice_shares_insert ON public.invoice_shares WITH CHECK (public.is_admin());'],
    ['field_app_locations UPDATE re-granted AND its policy widened', 'GRANT UPDATE ON public.field_app_locations TO authenticated; ALTER POLICY field_app_locations_update ON public.field_app_locations USING (is_admin() OR is_sales_rep()) WITH CHECK (is_admin() OR is_sales_rep());',
      'REVOKE UPDATE ON public.field_app_locations FROM authenticated; ALTER POLICY field_app_locations_update ON public.field_app_locations USING (public.is_admin()) WITH CHECK (public.is_admin());'],
  ];
  for (const [label, mutate, restoreSql] of layers) {
    psql(mutate);
    detect(label, () => tableAccess('after'));
    psql(restoreSql);
  }
  const policyChecks = {
    invoices_insert: ['invoices', 'bd1972a06eea215895d9ecec861d5991', 'insert'],
    invoice_items_insert: ['invoice_items', 'bd1972a06eea215895d9ecec861d5991', 'insert'],
    invoice_shares_insert: ['invoice_shares', 'd99642aa0333a7d54b96a4dac2a8821b', 'insert'],
    invoice_line_alloc_insert: ['invoice_line_allocations', 'bd1972a06eea215895d9ecec861d5991', 'insert'],
    field_app_locations_insert: ['field_app_locations', 'bd1972a06eea215895d9ecec861d5991', 'insert'],
    field_app_locations_update: ['field_app_locations', 'd4f3167a940eee97d1cd03f0bc03df5f', 'update'],
    field_app_locations_delete: ['field_app_locations', 'e95dffee2933869bf3a622fe2ef0456a', 'delete'],
    field_app_location_shares_insert: ['field_app_location_shares', 'bd1972a06eea215895d9ecec861d5991', 'insert'],
    field_app_location_shares_update: ['field_app_location_shares', 'd4f3167a940eee97d1cd03f0bc03df5f', 'update'],
    field_app_location_shares_delete: ['field_app_location_shares', 'e95dffee2933869bf3a622fe2ef0456a', 'delete'],
  };
  const policyContract = () => { for (const [p, [t, pin]] of Object.entries(policyChecks)) assert.equal(policyMd5(t, p), pin, `${t}.${p} is not the reviewed write policy`); };
  const policyClause = (kind, expr) => ({ insert: `WITH CHECK (${expr})`, update: `USING (${expr}) WITH CHECK (${expr})`, delete: `USING (${expr})` })[kind];
  policyContract();
  for (const [p, [t, , kind]] of Object.entries(policyChecks)) {
    psql(`ALTER POLICY ${p} ON public.${t} ${policyClause(kind, 'is_admin() OR is_sales_rep()')};`);
    detect(`${p} widened back to sales reps`, policyContract);
    psql(`ALTER POLICY ${p} ON public.${t} ${policyClause(kind, 'public.is_admin()')};`);
    policyContract();
  }
  // (8) Read policies: each reverted, the rep's read check fails.
  const readPolicies = [['invoices', 'invoices_select'], ['invoice_items', 'invoice_items_select'], ['invoice_shares', 'invoice_shares_select'],
    ['invoice_line_shares', 'invoice_line_shares_select'], ['invoice_line_share_snapshots', 'invoice_line_share_snapshots_select'], ['field_app_billing_sets', 'field_app_billing_sets_select'],
    ['field_app_billing_lines', 'field_app_billing_lines_select']];
  for (const [t, p] of readPolicies) {
    const original = docker([...psqlArgs(), '-A', '-t'], { input: `SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = '${t}' AND policyname = '${p}';` }).stdout.trim();
    assert.ok(original.includes('is_sales_rep() OR '), `${p}: the reviewed read policy is not in place`);
    psql(`ALTER POLICY ${p} ON public.${t} USING (${original.replaceAll('is_sales_rep() OR ', '')});`);
    detect(`${p} without the rep read`, () => tableAccess('after'));
    psql(`ALTER POLICY ${p} ON public.${t} USING (${original});`);
  }
  // A rep-SCOPED read (a rep sees only invoices of customers assigned to them: the scoping Mason
  // rejected) must turn the read check red too: the fixture has an invoice on REP_B's customer.
  const invoicesSelect = docker([...psqlArgs(), '-A', '-t'], { input: "SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'invoices' AND policyname = 'invoices_select';" }).stdout.trim();
  assert.equal(invoicesSelect.split('is_sales_rep()').length - 1, 1, 'invoices_select: the reviewed read policy is not in place');
  psql(`ALTER POLICY invoices_select ON public.invoices USING (${invoicesSelect.replace('is_sales_rep()', '(is_sales_rep() AND EXISTS (SELECT 1 FROM public.customers c WHERE c.id = invoices.customer_id AND c.assigned_sales_rep = (SELECT auth.uid())))')});`);
  detect('invoices_select scoped to the rep\'s own customers', () => tableAccess('after'));
  psql(`ALTER POLICY invoices_select ON public.invoices USING (${invoicesSelect});`);
  psql('DROP POLICY write_offs_select_sales_rep ON public.write_offs;');
  detect('write_offs without the rep read', () => tableAccess('after'));
  psql('CREATE POLICY write_offs_select_sales_rep ON public.write_offs FOR SELECT TO authenticated USING (public.is_sales_rep());');
  tableAccess('after');
  // (8b) Decision 2: each gate of the names-only reader, and the customers policy left unwidened.
  const namesReader = statementOf('CREATE FUNCTION public.get_invoice_customer_names(');
  const namesGrants = 'REVOKE ALL ON FUNCTION public.get_invoice_customer_names(uuid[]) FROM PUBLIC, anon, authenticated, service_role;\nGRANT EXECUTE ON FUNCTION public.get_invoice_customer_names(uuid[]) TO authenticated;\n';
  const namesMutants = [
    ['names reader without its role gate', (s) => once(s, '     AND (public.is_admin() OR public.is_sales_rep())\n', '', 'names role gate')],
    ['names reader without its invoice-reference gate', (s) => once(s, '     AND (EXISTS (SELECT 1\n', '     AND (true OR EXISTS (SELECT 1\n', 'names reference gate')],
    ['names reader counting a soft-deleted invoice', (s) => once(s, '                   WHERE i.customer_id = c.id\n                     AND i.deleted_at IS NULL)\n', '                   WHERE i.customer_id = c.id)\n', 'names deleted_at')],
    ['names reader without its customer-share leg', (s) => once(s, '                      WHERE s.customer_id = c.id\n', '                      WHERE false AND s.customer_id = c.id\n', 'names share leg')],
  ];
  for (const [label, mutate] of namesMutants) {
    const mutant = mutate(namesReader);
    assert.notEqual(mutant, namesReader, `mutation ${label}: changed nothing`);
    applyText('mutant-names.sql', mutant);
    detect(label, () => customerNames('after'));
    applyText('restore-names.sql', namesReader);
  }
  // Another column returned (the return type changes, so drop and re-create; restored the same way).
  applyText('mutant-names-column.sql', `DROP FUNCTION public.get_invoice_customer_names(uuid[]);\n${namesReader
    .replace('RETURNS TABLE(id uuid, farm_name text)', 'RETURNS TABLE(id uuid, farm_name text, contact_name text)')
    .replace('  SELECT c.id, c.farm_name\n', '  SELECT c.id, c.farm_name, c.contact_name\n')}${namesGrants}`);
  detect('names reader returning the contact name too', () => customerNames('after'));
  applyText('restore-names-column.sql', `DROP FUNCTION public.get_invoice_customer_names(uuid[]);\n${namesReader}${namesGrants}`);
  psql('GRANT EXECUTE ON FUNCTION public.get_invoice_customer_names(uuid[]) TO anon;');
  detect('names reader executable by anon', () => customerNames('after'));
  psql('REVOKE EXECUTE ON FUNCTION public.get_invoice_customer_names(uuid[]) FROM anon;');
  const customersSelect = docker([...psqlArgs(), '-A', '-t'], { input: "SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customers' AND policyname = 'customers_select';" }).stdout.trim();
  psql(`ALTER POLICY customers_select ON public.customers USING (${customersSelect} OR is_sales_rep());`);
  detect('customers_select widened to every sales rep', () => customerNames('after'));
  psql(`ALTER POLICY customers_select ON public.customers USING (${customersSelect});`);
  assert.equal(policyMd5('customers', 'customers_select'), LIVE_POLICY_MD5['customers.customers_select'], 'RESTORED: customers_select is not its live pin');
  customerNames('after');
  // (9) Version check: removed from each posting wrapper; and taken without the row lock.
  for (const [name, marker] of [['post_invoice', 'the invoice'], ['post_invoice_group', 'an invoice in this group'], ['batch_post_invoices', 'an invoice in this batch']]) {
    const original = statementOf(`CREATE FUNCTION public.${name}(`);
    const raise = `RAISE EXCEPTION 'INVOICE_CHANGED_SINCE_REVIEW: ${marker} changed`;
    applyText(`mutant-ver-${name}.sql`, once(original, raise, `RAISE NOTICE 'INVOICE_CHANGED_SINCE_REVIEW: ${marker} changed`, `version ${name}`));
    await detectAsync(`${name} without its version check`, () => versionChecks('after'));
    applyText(`restore-ver-${name}.sql`, original);
  }
  const post = statementOf('CREATE FUNCTION public.post_invoice(');
  const lockLine = '      PERFORM 1 FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;\n';
  const compareStart = post.indexOf('      IF public._invoice_review_fingerprint');
  const compare = post.slice(compareStart, post.indexOf('      END IF;\n', compareStart) + '      END IF;\n'.length);
  applyText('mutant-ver-unlocked.sql', once(post, `${lockLine}${compare}`, `${compare}${lockLine}`, 'unlocked'));
  await detectAsync('post_invoice version check before the row lock', () => versionChecks('after'));
  applyText('restore-ver-unlocked.sql', post);
  // The group and batch checks without their row locks: the two-session races must catch it.
  const groupPost = statementOf('CREATE FUNCTION public.post_invoice_group(');
  applyText('mutant-ver-group-unlocked.sql', once(groupPost, '                 ORDER BY i.id\n                   FOR UPDATE) m;', '                 ORDER BY i.id) m;', 'group unlocked'));
  await detectAsync('post_invoice_group version check without the member row locks', () => versionChecks('after'));
  applyText('restore-ver-group-unlocked.sql', groupPost);
  const batchPost = statementOf('CREATE FUNCTION public.batch_post_invoices(');
  applyText('mutant-ver-batch-unlocked.sql', once(batchPost, ' ORDER BY i.id FOR UPDATE;', ';', 'batch unlocked'));
  await detectAsync('batch_post_invoices version check without the row locks', () => versionChecks('after'));
  applyText('restore-ver-batch-unlocked.sql', batchPost);
  // The group check fingerprints soft-deleted members while the reader skips them.
  applyText('mutant-ver-group-deleted.sql', once(groupPost, '                 WHERE i.invoice_group_id = p_invoice_group_id\n                   AND i.deleted_at IS NULL\n', '                 WHERE i.invoice_group_id = p_invoice_group_id\n', 'group deleted_at'));
  await detectAsync('post_invoice_group counting soft-deleted members', () => versionChecks('after'));
  applyText('restore-ver-group-deleted.sql', groupPost);
  // A replay re-checked (no receipt test): the same-key duplicate must fail.
  applyText('mutant-ver-recheck.sql', once(post, '    IF v_cached IS NULL THEN\n', '    IF true THEN\n', 'recheck'));
  await detectAsync('post_invoice re-checking a call that has a stored receipt', async () => {
    const d = await dupKeyPost(`mutant_${process.pid}_${Date.now().toString(36)}`);
    assert.equal(d.result, 'ok', `mutant: the same-key duplicate did not replay: ${d.result}`);
  });
  applyText('restore-ver-recheck.sql', post);
  // (10) The fingerprint without each of its child legs.
  const fingerprint = statementOf('CREATE FUNCTION public._invoice_review_fingerprint(');
  const legs = {
    'the invoice lines': [`           || '|' || COALESCE((SELECT jsonb_agg(to_jsonb(ii) ORDER BY ii.id)::text
                                 FROM public.invoice_items ii
                                WHERE ii.invoice_id = i.id), '[]')\n`, ''],
    'the line shares': [`           || '|' || COALESCE((SELECT jsonb_agg(to_jsonb(ls) ORDER BY ls.id)::text
                                 FROM public.invoice_line_shares ls
                                 JOIN public.invoice_items lii ON lii.id = ls.invoice_item_id
                                WHERE lii.invoice_id = i.id), '[]')\n`, ''],
    'the customer shares': [`           || '|' || COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)::text
                                 FROM public.invoice_shares s
                                WHERE s.invoice_id = i.id), '[]'),\n`, ',\n'],
  };
  for (const [leg, [cut, replacement]] of Object.entries(legs)) {
    applyText('mutant-fingerprint.sql', once(fingerprint, cut, replacement, `fingerprint ${leg}`));
    await detectAsync(`fingerprint without ${leg}`, () => versionChecks('after'));
    applyText('restore-fingerprint.sql', fingerprint);
  }
  // (11) The sweep's guard-first rule weakened to "mentions the guard": a writer whose guard runs
  // after its write slips through, so the section-8 late-guard check fails. And the old, loose
  // DECLARE rule: a writer in a DECLARE initializer, before the guard, slips through.
  detect('sweep accepting a guard anywhere in the body', () => assert.equal(sweep(LATE_GUARD_WRITER, { weak: true }), 'prover_late_guard(uuid)', 'the weakened sweep accepted a guard that runs after the write'));
  assert.equal(sweep(LATE_GUARD_WRITER), 'prover_late_guard(uuid)', 'RESTORED: the sweep does not flag a guard that runs after the write');
  detect('sweep accepting any DECLARE section before the guard', () => assert.equal(sweep(DECLARE_WRITER, { looseDeclare: true }), 'prover_declare_writer(uuid)', 'the loose sweep accepted a writer in a DECLARE initializer'));
  assert.equal(sweep(DECLARE_WRITER), 'prover_declare_writer(uuid)', 'RESTORED: the sweep does not flag a writer in a DECLARE initializer');
  // Review round 2: the sweep without its exception-handler rule, and without its dynamic-SQL rule.
  for (const [label, option, writerName] of [['an exception handler after the guard', 'noExceptionRule', 'prover_swallow'], ['dynamic SQL naming an invoice table', 'noDynamicRule', 'prover_dynamic']]) {
    const writerSql = SWEEP_ROUND2_CASES.find(([, s]) => s.includes(`public.${writerName}(`))[1];
    detect(`sweep accepting ${label}`, () => assert.equal(sweep(writerSql, { [option]: true }), `${writerName}(uuid)`, `the weakened sweep accepted ${label}`));
    assert.equal(sweep(writerSql), `${writerName}(uuid)`, `RESTORED: the sweep does not flag ${label}`);
  }
  // Final: everything restored behaves exactly as reviewed.
  const restored = invoicingMatrix('after');
  if (adminBefore) for (const c of CASES) assert.deepEqual(restored[c.n], adminBefore[c.n], `RESTORED ${c.n}: admin outcome drifted`);
  // Review round 2: every other section a mutant turned red is green again on the restored
  // candidate, and every policy is back to its postflight pin.
  completions('after');
  jobsAndQuick('after');
  tableAccess('after');
  customerNames('after');
  splitKeyChecks();
  await versionChecks('after');
  checkCompletionRace('after', await completionRace('after'));
  policyContract();
  for (const [t, p] of readPolicies) {
    const pin = new RegExp(`\\('${t}', '${p}', '([0-9a-f]{32})'\\)`).exec(candidateText.slice(candidateText.indexOf('DO $postflight$')))?.[1];
    assert.ok(pin, `RESTORED: no postflight pin for ${t}.${p}`);
    assert.equal(policyMd5(t, p), pin, `RESTORED: ${t}.${p} is not its postflight pin`);
  }
  console.log(`[prover] MUTATIONS: ${guardedCount} wrapper guards, the split key check, the guard helper (NULL fail-open form, no is_active), the completion hunk, complete_job's gate and its admin notification, the quick-delivery coercion, ${layers.length} table-grant layers (2 with the policy widened too, caught by the write landing), ${Object.keys(policyChecks).length} write policies, ${readPolicies.length} read policies, a rep-scoped invoices read and the write_offs rep read, the names reader (its role gate, invoice-reference gate, soft-deleted filter, share leg, an extra column, an anon grant) and customers_select widened, the version check in each of 3 posting wrappers, each posting wrapper's check without its row locks, a group check counting soft-deleted members, a re-check of a stored receipt (same-key duplicate), the fingerprint without each of its 3 child legs, and the sweep accepting a late guard, any DECLARE section, an exception handler after the guard or dynamic SQL each turned the prover red (the completion hunk by its named failure); restored, the matrix, completions, jobs and quick deliveries, reads and direct writes, customer names, split keys, the version checks, the completion race and every write and read policy pin were re-run green (${count} detections)`);
  return count;
}

try { await main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); else console.log(`[prover] kept container ${NAME}`); }
