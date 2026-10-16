#!/usr/bin/env node
/**
 * Full-chain proof for the 20261015230000 candidate: staff photo storage access (Goal 1, step 1 of 2).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a network-disabled Supabase
 * PostgreSQL 17 container (storage.objects stubbed as live has it: owned apart from the app roles,
 * row-level security on, SELECT/INSERT/DELETE granted to authenticated and anon), replays every
 * ordered post-baseline migration up to the candidate, checks the policies it replaces match their
 * live md5 of 2026-10-14, seeds two deliveries and photo objects, then runs one matrix BEFORE and
 * AFTER the candidate, as `authenticated` with each role's claims or as `anon`, exactly the queries
 * Supabase Storage runs against storage.objects for a download (SELECT), an upload (INSERT) and a
 * delete (DELETE). Every call is one transaction that always rolls back.
 *   1. BEFORE: nobody can download through the session (no SELECT policy); anyone signed in, even a
 *      deactivated account, can upload to every photo bucket; and no delete removes anything, not
 *      even an admin's, because a DELETE only reaches rows the caller may SELECT.
 *   2. AFTER: admins and reps download every photo; a driver downloads only their assigned
 *      delivery's photos and team-note photos; an applicator only team-note photos; a deactivated
 *      account, a commission-recipient profile and a signed-out visitor nothing. Uploads and
 *      deletes follow the same roles; a team-note uploader deletes their own file.
 *   3. The delivery_photos row policy refuses a deactivated driver, and a team_note_attachments row
 *      may name only a file in its uploader's own folder (an admin deleting a row that named another
 *      uploader's photo would otherwise delete that file).
 *   4. The preflight refuses a drifted policy and a second apply; the buckets stay public.
 *   5. MUTATION: with is_driver() forced true, the applicator downloads a delivery photo of a
 *      delivery assigned to them, so the driver gate is what refuses it.
 *   6. STEP 2 (20261016030000): its preflight refuses two team-note rows naming one file, a
 *      missing step 1 read policy, an extra policy naming a photo bucket, a policy that tests no
 *      bucket and an OR-bypass policy only the whole-set pin catches; applied, the three buckets are private, every access case is
 *      unchanged, a second row naming the same file is refused (and only because of the new
 *      index), the live chain still passes, and a second apply is refused.
 *
 * Run: node scripts/smoke/prove-staff-photo-storage-access-real-schema.mjs   (needs Docker)
 * Prints STAFF_PHOTO_STORAGE_PROOF_PASS on success.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = process.env.CRX_PROVER_REUSE_CONTAINER || `crx-staff-photos-${process.pid}-${Date.now().toString(36)}`;
const REUSE = Boolean(process.env.CRX_PROVER_REUSE_CONTAINER);
const KEEP = process.env.CRX_PROVER_KEEP_CONTAINER === '1' || REUSE;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');
const CANDIDATE = path.join(MIGRATIONS, '20261015230000_staff_photo_storage_access.sql');
// Step 2 of 2 (make the buckets private), proved here on top of step 1.
const STEP2 = path.join(MIGRATIONS, '20261016030000_staff_photo_buckets_private.sql');
// Live but not replayable here (customer-documents storage policies); it does not touch photo buckets.
const PARKED = new Set(['20260914100700_customer_document_bytes_server_only.sql']);
const LEDGER_ONLY = new Set([
  '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man.sql',
  '20261007150200_release_reservations_of_deleted_spring_orders.sql',
]);
const LEDGER_FROM = '20261007';
const LIVE_AUTH_UID_SRC = '\n  select \n  coalesce(\n'
  + "    nullif(current_setting('request.jwt.claim.sub', true), ''),\n"
  + "    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')\n"
  + '  )::uuid\n';
const LIVE_AUTH_UID_MD5 = 'cdef18c69c4f4cbbced2eaf81e628b49';
// Live pins read 2026-10-14 (md5 of cmd|roles|qual|with_check), the same the candidate's preflight checks.
const LIVE_POLICY_PINS = [
  ['storage', 'objects', 'delivery_photos_insert', 'a7275ecf0cfb561a7b64e521a6921503'],
  ['storage', 'objects', 'delivery_photos_delete', '23825b9adb39d1bc99987a641368945b'],
  ['storage', 'objects', 'recv_photos_storage_upload', '2cc78efe95bb2a0cf11bec0a30800acd'],
  ['storage', 'objects', 'recv_photos_storage_delete', '3ec914b0679a6c38a12d17a61ade6d10'],
  ['storage', 'objects', 'Authenticated users can upload team note attachments', '337aa4234a96ed605abe30dad6c03540'],
  ['storage', 'objects', 'Users can delete own team note attachments', '52637a7ec8666536e0ea383b5c8d5f9f'],
  ['public', 'delivery_photos', 'del_photos_select', '8ddd08ccd87e7e3ab2a24a4346aa3411'],
  ['public', 'team_note_attachments', 'Authenticated users can insert own attachments', 'de7e8786d42d0ec62c9c4bb896ae700e'],
];

const id = (n) => `7a500000-0000-4000-8000-${n.padStart(12, '0')}`;
const U = {
  ADMIN: id('a1'), REP: id('b1'), REP_OFF: id('b3'), DRIVER: id('d1'), DRIVER_B: id('d2'),
  DRIVER_OFF: id('d3'), APPLICATOR: id('e1'), ENTITY: id('f9'),
};
const D_MINE = id('de1'); // assigned to DRIVER (and DRIVER_OFF's copy below)
const D_OTHER = id('de2'); // assigned to DRIVER_B
const D_OFF = id('de3'); // assigned to the deactivated driver
const D_APPL = id('de4'); // assigned to the applicator profile (mutation case)
const OBJ = {
  MINE: `delivery-photos/${D_MINE}/1_0.jpg`,
  OTHER: `delivery-photos/${D_OTHER}/1_0.jpg`,
  OFF: `delivery-photos/${D_OFF}/1_0.jpg`,
  APPL: `delivery-photos/${D_APPL}/1_0.jpg`,
  RECV: 'receiving-photos/po-1/1_0.jpg',
  NOTE_REP: `team-note-attachments/${U.REP}/1_0.jpg`,
  NOTE_DRIVER: `team-note-attachments/${U.DRIVER}/1_0.jpg`,
};
const PHOTO_ROW = id('9001'); // public.delivery_photos row on D_OFF
const NOTE = id('9101'); // public.team_notes row the attachment probes hang off

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
  // Later-stamped migrations (authored after this one, not yet applied live) are not replayed: the
  // candidate applies before them, as on live. None may touch what this proof covers, except step 2,
  // which this proof applies itself after step 1.
  assert.ok(all.includes(STEP2), 'step 2 must be selected for post-baseline replay');
  for (const file of all.slice(at + 1).filter((f) => f !== STEP2)) {
    assert.ok(!/delivery-photos|receiving-photos|team-note-attachments|delivery_photos|team_note_attachments|storage\.objects/i.test(lf(file)),
      `${path.basename(file)} is stamped after the candidate and touches what this proof covers; re-think the order`);
  }
  const before = all.slice(0, at);
  for (const name of PARKED) {
    const file = before.find((f) => path.basename(f) === name);
    assert.ok(file, `${name} must be in the replay plan (re-check the PARKED list)`);
    assert.ok(!/delivery-photos|receiving-photos|team-note-attachments|delivery_photos/i.test(lf(file)), `${name} now touches what this proof covers; replay it or re-think the skip`);
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
  // storage stub, shaped as live: RLS on, app roles granted the DML Storage issues on their behalf.
  // Owned by postgres here so the candidate applies as postgres; live applies it through the same
  // Management API path that applied 20260914100700's storage policies.
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[], updated_at timestamptz);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text, metadata jsonb);
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;
    ALTER TABLE storage.objects OWNER TO postgres;
    ALTER TABLE storage.buckets OWNER TO postgres;
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA storage TO authenticated, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated, anon;
    GRANT SELECT ON storage.buckets TO authenticated, anon;
    GRANT EXECUTE ON FUNCTION storage.foldername(text), storage.filename(text) TO authenticated, anon;
    -- Live's direct-delete guard (body read 2026-10-14): Storage sets storage.allow_delete_query
    -- before the DELETE it runs as the signed-in user; any other direct DELETE is refused.
    CREATE OR REPLACE FUNCTION storage.protect_delete() RETURNS trigger LANGUAGE plpgsql AS $pd$
    BEGIN
        IF COALESCE(current_setting('storage.allow_delete_query', true), 'false') != 'true' THEN
            RAISE EXCEPTION 'Direct deletion from storage tables is not allowed. Use the Storage API instead.'
                USING HINT = 'This prevents accidental data loss from orphaned objects.',
                      ERRCODE = '42501';
        END IF;
        RETURN NULL;
    END;
    $pd$;
    CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });
  const files = plan();
  let replayed = 0;
  for (const [i, file] of files.entries()) {
    const base = path.basename(file);
    const stem = path.basename(file, '.sql');
    if (PARKED.has(base)) continue;
    for (const only of LEDGER_ONLY) if (only < base) ledger(path.basename(only, '.sql'));
    if (LEDGER_ONLY.has(base)) continue;
    if (base === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    const name = `m-${i}.sql`; stageText(name, lf(file)); const r = apply(name);
    if (r.status !== 0) throw new Error(`source replay failed at ${base}:\n${r.output}`);
    if (base >= LEDGER_FROM) ledger(stem);
    replayed += 1;
  }
  psql(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $live_uid$${LIVE_AUTH_UID_SRC}$live_uid$;`, { user: 'supabase_admin' });
  assert.equal(scalar("SELECT md5(prosrc) FROM pg_proc WHERE oid = 'auth.uid()'::regprocedure;"), LIVE_AUTH_UID_MD5, "auth.uid() is not live's body");
  console.log(`[prover] replayed ${replayed} post-baseline migrations before the candidate`);
}

function fidelity() {
  for (const [schema, table, policy, pin] of LIVE_POLICY_PINS) {
    assert.equal(scalar(`SELECT md5(cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')) FROM pg_policies WHERE schemaname = '${schema}' AND tablename = '${table}' AND policyname = '${policy.replaceAll("'", "''")}';`),
      pin, `${schema}.${table} "${policy}" replayed with a policy that differs from live`);
  }
  assert.equal(scalar("SELECT count(*) FROM storage.buckets WHERE id IN ('delivery-photos','receiving-photos','team-note-attachments') AND public;"), '3', 'the photo buckets are not public, as live');
  console.log(`[prover] FIDELITY: ${LIVE_POLICY_PINS.length} policies match the live pins of 2026-10-14; the photo buckets are public`);
}

// ------------------------------------------------------------------------------------------------
// Seed (committed once; every probe rolls back).
function claims(uid) {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.sub', '${uid}', true);`;
}
function asUser(uid) { return uid === 'anon' ? 'SET LOCAL ROLE anon;' : `${claims(uid)}\nSET LOCAL ROLE authenticated;`; }
function seed() {
  const users = [
    [U.ADMIN, 'admin', 'Admin', 9], [U.REP, 'sales_rep', 'Rep', 8], [U.REP_OFF, 'sales_rep', 'Deactivated Rep', 7],
    [U.DRIVER, 'driver', 'Driver', 6], [U.DRIVER_B, 'driver', 'Driver B', 5], [U.DRIVER_OFF, 'driver', 'Deactivated Driver', 4],
    [U.APPLICATOR, 'applicator', 'Applicator', 3], [U.ENTITY, 'driver', 'Commission Entity', 2],
  ];
  psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar(255));
    CREATE TABLE IF NOT EXISTS auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
    GRANT ALL ON auth.refresh_tokens, auth.sessions TO postgres;`, { user: 'supabase_admin' });
  psql(`BEGIN;
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ${users.map(([u, role, label]) => `('${u}', 'photos-${u.slice(-2)}@example.invalid', '{"full_name":"[PROVER] ${label}","role":"${role}"}'::jsonb)`).join(',\n      ')};
    ${users.map(([u, , , minutes]) => `UPDATE public.profiles SET created_at = now() - interval '${minutes} minutes' WHERE id = '${u}';`).join('\n    ')}
    ${claims(U.ADMIN)}
    UPDATE public.profiles SET is_active = false WHERE id IN ('${U.REP_OFF}', '${U.DRIVER_OFF}');
    UPDATE public.profiles SET role = 'entity_recipient' WHERE id = '${U.ENTITY}';
    COMMIT;`);
  // Deliveries and objects need no order chain for these policies: insert them with FK and
  // business triggers off (superuser, replication role), as owner-side fixtures.
  psql(`BEGIN;
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.deliveries (id, delivery_number, order_id, customer_id, created_by, assigned_driver) VALUES
      ('${D_MINE}', 'PROVER-PH-1', '${id('0e1')}', '${id('0c1')}', '${U.ADMIN}', '${U.DRIVER}'),
      ('${D_OTHER}', 'PROVER-PH-2', '${id('0e2')}', '${id('0c1')}', '${U.ADMIN}', '${U.DRIVER_B}'),
      ('${D_OFF}', 'PROVER-PH-3', '${id('0e3')}', '${id('0c1')}', '${U.ADMIN}', '${U.DRIVER_OFF}'),
      ('${D_APPL}', 'PROVER-PH-4', '${id('0e4')}', '${id('0c1')}', '${U.ADMIN}', '${U.APPLICATOR}');
    INSERT INTO public.team_notes (id, title, created_by) VALUES ('${NOTE}', '[PROVER] note', '${U.ADMIN}');
    INSERT INTO public.delivery_photos (id, delivery_id, storage_path, image_url, uploaded_by, sort_order)
      VALUES ('${PHOTO_ROW}', '${D_OFF}', '${OBJ.OFF}', 'https://example.invalid/x.jpg', '${U.DRIVER_OFF}', 0);
    INSERT INTO storage.objects (bucket_id, name) VALUES
      ${Object.values(OBJ).map((name) => `('${name.split('/')[0]}', '${name}')`).join(',\n      ')};
    COMMIT;`, { user: 'supabase_admin' });
  assert.equal(scalar(`SELECT string_agg(role || ':' || is_active, ',' ORDER BY created_at) FROM public.profiles WHERE id::text LIKE '7a500000-%';`),
    'admin:true,sales_rep:true,sales_rep:false,driver:true,driver:true,driver:false,applicator:true,entity_recipient:true', 'the seeded roles are not what the proof needs');
  assert.equal(scalar('SELECT count(*) FROM storage.objects;'), String(Object.keys(OBJ).length), 'the photo objects were not seeded');
}

// ------------------------------------------------------------------------------------------------
// Probes. ok|<value> or <sqlstate>|<message>.
function attempt(uid, call, { statement = false, fixture = '' } = {}) {
  const sql = `BEGIN;
${fixture}
RESET ROLE;
${asUser(uid)}
DO $probe$
DECLARE v text; n bigint;
BEGIN
  ${statement ? `${call}; GET DIAGNOSTICS n = ROW_COUNT; v := n::text;` : `v := (${call})::text;`}
  RAISE NOTICE 'RESULT|ok|%', COALESCE(v, '<null>');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'RESULT|%|%', SQLSTATE, SQLERRM;
END
$probe$;
ROLLBACK;
`;
  const r = docker([...psqlArgs(), '-A', '-t'], { input: sql, allowFailure: true });
  assert.equal(r.status, 0, `probe failed to run:\n${r.stderr}\n--- SQL ---\n${sql}`);
  const m = /RESULT\|([^\n]*)/.exec(r.stderr);
  assert.ok(m, `probe printed no RESULT:\n${r.stderr}`);
  return m[1].trimEnd();
}

// Download = Storage's SELECT of that object under the caller's role.
const view = (name) => `(SELECT count(*) FROM storage.objects WHERE name = '${name}')`;
// Upload = Storage's INSERT of a new object.
const upload = (name) => `INSERT INTO storage.objects (bucket_id, name) VALUES ('${name.split('/')[0]}', '${name}')`;
// Delete = Storage's DELETE of that object: Storage sets storage.allow_delete_query, then runs the
// DELETE as the signed-in user, so row-level security decides which rows it reaches.
const remove = (name) => `PERFORM set_config('storage.allow_delete_query', 'true', true); DELETE FROM storage.objects WHERE name = '${name}'`;
const directRemove = (name) => `DELETE FROM storage.objects WHERE name = '${name}'`;
const SEEN = /^ok\|1$/;
const HIDDEN = /^ok\|0$/;
const DENIED = /^42501\|new row violates row-level security policy/;
const ANON_DENIED = /^42501\|/;

const newMine = `delivery-photos/${D_MINE}/9_9.jpg`;
const newOther = `delivery-photos/${D_OTHER}/9_9.jpg`;
const newRecv = 'receiving-photos/po-1/9_9.jpg';
const newNote = (uid) => `team-note-attachments/${uid}/9_9.jpg`;
// An attachment row as NotePhotoUpload writes it: the public URL of the file, uploaded_by = caller.
const PUBLIC_NOTE_URL = 'https://rhyzpcqhnizqbxphqdkr.supabase.co/storage/v1/object/public/team-note-attachments/';
const noteRow = (uid, url) => `INSERT INTO public.team_note_attachments (note_id, file_url, file_name, file_type, file_size_bytes, uploaded_by) VALUES ('${NOTE}', '${url}', 'p.jpg', 'image/jpeg', 1, '${uid}')`;

/** [label, uid, call, opts, before, after]; 'same' = identical before and after. */
const CASES = [
  // Downloads.
  ['admin views a delivery photo', U.ADMIN, view(OBJ.OTHER), {}, HIDDEN, SEEN],
  ['rep views a delivery photo', U.REP, view(OBJ.OTHER), {}, HIDDEN, SEEN],
  ['driver views own delivery photo', U.DRIVER, view(OBJ.MINE), {}, HIDDEN, SEEN],
  ['driver views another driver\'s delivery photo', U.DRIVER, view(OBJ.OTHER), {}, HIDDEN, 'same'],
  ['deactivated driver views own delivery photo', U.DRIVER_OFF, view(OBJ.OFF), {}, HIDDEN, 'same'],
  ['applicator views a delivery photo assigned to them', U.APPLICATOR, view(OBJ.APPL), {}, HIDDEN, 'same'],
  ['commission-recipient views a delivery photo', U.ENTITY, view(OBJ.OTHER), {}, HIDDEN, 'same'],
  ['deactivated rep views a delivery photo', U.REP_OFF, view(OBJ.OTHER), {}, HIDDEN, 'same'],
  ['signed-out visitor views a delivery photo', 'anon', view(OBJ.OTHER), {}, HIDDEN, 'same'],
  ['admin views a receiving photo', U.ADMIN, view(OBJ.RECV), {}, HIDDEN, SEEN],
  ['rep views a receiving photo', U.REP, view(OBJ.RECV), {}, HIDDEN, SEEN],
  ['driver views a receiving photo', U.DRIVER, view(OBJ.RECV), {}, HIDDEN, 'same'],
  ['applicator views a receiving photo', U.APPLICATOR, view(OBJ.RECV), {}, HIDDEN, 'same'],
  ['driver views a team-note photo', U.DRIVER, view(OBJ.NOTE_REP), {}, HIDDEN, SEEN],
  ['applicator views a team-note photo', U.APPLICATOR, view(OBJ.NOTE_REP), {}, HIDDEN, SEEN],
  ['rep views a team-note photo', U.REP, view(OBJ.NOTE_DRIVER), {}, HIDDEN, SEEN],
  ['commission-recipient views a team-note photo', U.ENTITY, view(OBJ.NOTE_REP), {}, HIDDEN, 'same'],
  ['deactivated driver views a team-note photo', U.DRIVER_OFF, view(OBJ.NOTE_REP), {}, HIDDEN, 'same'],
  ['signed-out visitor views a team-note photo', 'anon', view(OBJ.NOTE_REP), {}, HIDDEN, 'same'],

  // Uploads.
  ['driver uploads to own delivery', U.DRIVER, upload(newMine), { statement: true }, SEEN, 'same'],
  ['driver uploads to another driver\'s delivery', U.DRIVER, upload(newOther), { statement: true }, SEEN, DENIED],
  ['deactivated driver uploads to own delivery', U.DRIVER_OFF, upload(`delivery-photos/${D_OFF}/9_9.jpg`), { statement: true }, SEEN, DENIED],
  ['applicator uploads a delivery photo', U.APPLICATOR, upload(newOther), { statement: true }, SEEN, DENIED],
  ['rep uploads a delivery photo', U.REP, upload(newOther), { statement: true }, SEEN, 'same'],
  ['signed-out visitor uploads a delivery photo', 'anon', upload(newOther), { statement: true }, ANON_DENIED, 'same'],
  ['rep uploads a receiving photo', U.REP, upload(newRecv), { statement: true }, SEEN, 'same'],
  ['driver uploads a receiving photo', U.DRIVER, upload(newRecv), { statement: true }, SEEN, DENIED],
  ['driver uploads a team-note photo to own folder', U.DRIVER, upload(newNote(U.DRIVER)), { statement: true }, SEEN, 'same'],
  ['applicator uploads a team-note photo to own folder', U.APPLICATOR, upload(newNote(U.APPLICATOR)), { statement: true }, SEEN, 'same'],
  ['driver uploads a team-note photo into the rep\'s folder', U.DRIVER, upload(newNote(U.REP)), { statement: true }, SEEN, DENIED],
  ['commission-recipient uploads a team-note photo to own folder', U.ENTITY, upload(newNote(U.ENTITY)), { statement: true }, SEEN, DENIED],
  ['deactivated rep uploads a team-note photo to own folder', U.REP_OFF, upload(newNote(U.REP_OFF)), { statement: true }, SEEN, DENIED],

  // Deletes. A DELETE only reaches rows the caller may also SELECT, so with no storage SELECT
  // policy every delete in these buckets removes nothing today, even an admin's (which is why
  // "deleted" photos leave orphan files). After: the delete policies take effect as intended.
  ['driver deletes a receiving photo', U.DRIVER, remove(OBJ.RECV), { statement: true }, HIDDEN, 'same'],
  ['rep deletes a receiving photo', U.REP, remove(OBJ.RECV), { statement: true }, HIDDEN, 'same'],
  ['admin deletes a receiving photo', U.ADMIN, remove(OBJ.RECV), { statement: true }, HIDDEN, SEEN],
  ['rep deletes own team-note photo', U.REP, remove(OBJ.NOTE_REP), { statement: true }, HIDDEN, SEEN],
  ['driver deletes the rep\'s team-note photo', U.DRIVER, remove(OBJ.NOTE_REP), { statement: true }, HIDDEN, 'same'],
  ['admin deletes a team-note photo', U.ADMIN, remove(OBJ.NOTE_DRIVER), { statement: true }, HIDDEN, SEEN],
  // Admin only, as the delivery_photos row policy (a rep could otherwise strand an undeletable row).
  ['rep deletes a delivery photo', U.REP, remove(OBJ.MINE), { statement: true }, HIDDEN, 'same'],
  ['admin deletes a delivery photo', U.ADMIN, remove(OBJ.MINE), { statement: true }, HIDDEN, SEEN],
  ['driver deletes own delivery photo', U.DRIVER, remove(OBJ.MINE), { statement: true }, HIDDEN, 'same'],
  ['admin deletes directly, outside Storage', U.ADMIN, directRemove(OBJ.RECV), { statement: true }, /^42501\|Direct deletion from storage tables is not allowed/, 'same'],

  // The delivery_photos row a deactivated driver could still read.
  ['deactivated driver reads own delivery\'s photo row', U.DRIVER_OFF, `(SELECT count(*) FROM public.delivery_photos WHERE id = '${PHOTO_ROW}')`, {}, SEEN, HIDDEN],
  ['admin reads the photo row', U.ADMIN, `(SELECT count(*) FROM public.delivery_photos WHERE id = '${PHOTO_ROW}')`, {}, SEEN, 'same'],

  // Team-note attachment rows: the file a row names, which the app deletes before the row.
  ['rep records a photo in own folder', U.REP, noteRow(U.REP, PUBLIC_NOTE_URL + OBJ.NOTE_REP), { statement: true }, SEEN, 'same'],
  ['driver records a photo in own folder', U.DRIVER, noteRow(U.DRIVER, PUBLIC_NOTE_URL + newNote(U.DRIVER)), { statement: true }, SEEN, 'same'],
  ['rep records the driver photo as theirs', U.REP, noteRow(U.REP, PUBLIC_NOTE_URL + OBJ.NOTE_DRIVER), { statement: true }, SEEN, DENIED],
  ['rep records a URL naming the driver photo before own folder', U.REP, noteRow(U.REP, `${PUBLIC_NOTE_URL}${OBJ.NOTE_DRIVER}?/team-note-attachments/${U.REP}/1_0.jpg`), { statement: true }, SEEN, DENIED],
  ['rep records an escaped path out of own folder', U.REP, noteRow(U.REP, `${PUBLIC_NOTE_URL}team-note-attachments/${U.REP}/..%2F${U.DRIVER}%2F1_0.jpg`), { statement: true }, SEEN, DENIED],
  ['rep records a photo as the driver', U.REP, noteRow(U.DRIVER, PUBLIC_NOTE_URL + OBJ.NOTE_DRIVER), { statement: true }, DENIED, 'same'],
];

function runMatrix(phase) {
  const out = {};
  for (const [label, uid, call, opts] of CASES) out[label] = attempt(uid, call, opts);
  console.log(`[prover] ${phase}: ${CASES.length} cases run`);
  return out;
}
function check(phase, results, baseline = null) {
  const failures = [];
  for (const [label, , , , before, after] of CASES) {
    const want = phase === 'before' ? before : after;
    const got = results[label];
    if (want === 'same') {
      if (got !== baseline[label]) failures.push(`${label}: changed from "${baseline[label]}" to "${got}"`);
    } else if (!want.test(got)) {
      failures.push(`${label}: got "${got}", expected ${want}`);
    }
  }
  assert.deepEqual(failures, [], `${phase.toUpperCase()} failed:\n  ${failures.join('\n  ')}`);
  console.log(`[prover] ${phase.toUpperCase()}: all ${CASES.length} cases as expected`);
}

// The live smoke chain, run here first (its RAISE text comes back on stderr).
function runChain() {
  stageText('chain.sql', lf(path.join(ROOT, 'scripts', 'smoke', 'smoke-staff_photo_storage_access.sql')));
  const r = docker([...psqlArgs(), '-f', '/tmp/chain.sql'], { allowFailure: true });
  return `${r.stdout}\n${r.stderr}`;
}

function preflightRefusesDrift() {
  stageText('cand.sql', lf(CANDIDATE));
  const r = docker([...psqlArgs()], {
    input: `BEGIN;
ALTER POLICY "recv_photos_storage_delete" ON storage.objects USING (bucket_id = 'receiving-photos' AND true);
\\i /tmp/cand.sql
ROLLBACK;`,
    allowFailure: true,
  });
  assert.notEqual(r.status, 0, 'the candidate applied over a drifted policy');
  assert.match(r.stderr, /STAFF_PHOTOS_PREFLIGHT: storage\.objects policy "recv_photos_storage_delete" is missing or drifted/, `wrong refusal:\n${r.stderr}`);
  console.log('[prover] PREFLIGHT: a drifted policy aborts the candidate before any change');
}

// Step 2 (20261016030000): the buckets go private, one team-note row per file, policies untouched.
const PRIVATE_COUNT = "SELECT count(*) FROM storage.buckets WHERE id IN ('delivery-photos','receiving-photos','team-note-attachments') AND public IS FALSE;";
const twoRowsOneFile = `${noteRow(U.REP, PUBLIC_NOTE_URL + OBJ.NOTE_REP)}; ${noteRow(U.REP, PUBLIC_NOTE_URL + OBJ.NOTE_REP)}`;
// The same object under another scheme and host: step 1's policy accepts it, and the app reads only the path.
const twoUrlsOneFile = `${noteRow(U.REP, PUBLIC_NOTE_URL + OBJ.NOTE_REP)}; ${noteRow(U.REP, PUBLIC_NOTE_URL.replace('https://rhyzpcqhnizqbxphqdkr.supabase.co', 'http://other.example') + OBJ.NOTE_REP)}`;
// Step 2 pins live's whole storage.objects policy set (25 policies, including buckets this container
// does not replay); here it is re-pinned to this container's set, read after step 1, exactly once.
const LIVE_STORAGE_POLICY_SET_MD5 = 'd40293d14ae8054e3b88e0dc5525987f';
const POLICY_SET_MD5 = `SELECT md5(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || permissive || '|'
  || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\\n' ORDER BY policyname)) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects';`;
let containerSetMd5 = null;
function step2Text() {
  const text = lf(STEP2);
  assert.equal(text.split(LIVE_STORAGE_POLICY_SET_MD5).length - 1, 1, 'step 2 must pin the live policy set exactly once');
  return text.replace(LIVE_STORAGE_POLICY_SET_MD5, containerSetMd5);
}
function step2Refuses(setup, expected, label) {
  stageText('step2.sql', step2Text());
  const r = docker([...psqlArgs()], { input: `BEGIN;\n${setup}\n\\i /tmp/step2.sql\nROLLBACK;`, allowFailure: true });
  assert.notEqual(r.status, 0, `step 2 applied ${label}`);
  assert.match(r.stderr, expected, `step 2 refused ${label} for the wrong reason:\n${r.stderr}`);
  assert.equal(scalar(PRIVATE_COUNT), '0', `step 2 left a bucket private after refusing ${label}`);
  console.log(`[prover] STEP 2 PREFLIGHT: refuses ${label}`);
}
function step2(afterStep1) {
  containerSetMd5 = scalar(POLICY_SET_MD5);
  assert.match(containerSetMd5, /^[0-9a-f]{32}$/, 'could not read the container policy set');
  // A second file naming the same object before the index exists: the app would delete it twice.
  const dup = attempt(U.REP, twoRowsOneFile, { statement: true });
  assert.match(dup, /^ok\|1$/, `before step 2 two rows may name one file, got ${dup}`);
  const dupUrl = attempt(U.REP, twoUrlsOneFile, { statement: true });
  assert.match(dupUrl, /^ok\|1$/, `before step 2 step 1's policy accepts two URLs for one file, got ${dupUrl}`);
  step2Refuses(`INSERT INTO public.team_note_attachments (note_id, file_url, file_name, file_type, file_size_bytes, uploaded_by)
  SELECT '${NOTE}', '${PUBLIC_NOTE_URL}${OBJ.NOTE_REP}', 'p.jpg', 'image/jpeg', 1, '${U.REP}' FROM generate_series(1, 2);`, /STAFF_PHOTOS_PRIVATE_PREFLIGHT: two or more team_note_attachments rows name the same file/, 'two rows naming one file');
  step2Refuses('DROP POLICY "staff_photos_receiving_select" ON storage.objects;',
    /STAFF_PHOTOS_PRIVATE_PREFLIGHT: storage\.objects policy "staff_photos_receiving_select" is missing/, 'a missing step 1 read policy');
  // Permissive policies OR together: an added broad read would keep photos open once private.
  step2Refuses(`CREATE POLICY "prover_extra_read" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'delivery-photos');`,
    /STAFF_PHOTOS_PRIVATE_PREFLIGHT: an unexpected storage policy names a photo bucket/, 'an extra policy naming a photo bucket');
  step2Refuses('CREATE POLICY "prover_any_bucket" ON storage.objects FOR SELECT TO authenticated USING (true);',
    /STAFF_PHOTOS_PRIVATE_PREFLIGHT: a storage\.objects policy does not test bucket_id/, 'a policy that tests no bucket');
  // Passes both text checks (names no photo bucket, mentions bucket_id =), yet opens every bucket.
  step2Refuses(`CREATE POLICY "prover_or_bypass" ON storage.objects FOR SELECT TO authenticated USING (true OR bucket_id = 'other-bucket');`,
    /STAFF_PHOTOS_PRIVATE_PREFLIGHT: the storage\.objects policy set changed since it was read/, 'a bypass policy the text checks miss');

  stageText('step2.sql', step2Text());
  const a = apply('step2.sql');
  assert.equal(a.status, 0, `step 2 failed to apply:\n${a.output}`);
  assert.equal(scalar(PRIVATE_COUNT), '3', 'step 2 did not make the three buckets private');
  assert.equal(scalar("SELECT count(*) FROM storage.buckets WHERE id IN ('delivery-photos','receiving-photos','team-note-attachments') AND updated_at > now() - interval '5 minutes';"),
    '3', 'step 2 did not stamp the buckets\' updated_at');
  console.log('[prover] STEP 2 applied: the three photo buckets are private');

  const after2 = runMatrix('after step 2');
  const changed = CASES.map(([label]) => label).filter((label) => after2[label] !== afterStep1[label]);
  assert.deepEqual(changed, [], `step 2 changed who may view, upload or delete:\n  ${changed.map((l) => `${l}: "${afterStep1[l]}" -> "${after2[l]}"`).join('\n  ')}`);
  console.log(`[prover] STEP 2: all ${CASES.length} access cases identical to step 1`);

  const dup2 = attempt(U.REP, twoRowsOneFile, { statement: true });
  assert.match(dup2, /^23505\|duplicate key value violates unique constraint "team_note_attachments_object_path_key"/, `after step 2 a second row naming the same file must be refused, got ${dup2}`);
  const dupUrl2 = attempt(U.REP, twoUrlsOneFile, { statement: true });
  assert.match(dupUrl2, /^23505\|duplicate key value violates unique constraint "team_note_attachments_object_path_key"/, `after step 2 a second URL for the same file must be refused, got ${dupUrl2}`);
  const dupMutant = attempt(U.REP, twoUrlsOneFile, { statement: true, fixture: 'DROP INDEX public.team_note_attachments_object_path_key;' });
  assert.match(dupMutant, /^ok\|1$/, `MUTATION: without the index the second row should insert, got ${dupMutant}`);
  console.log('[prover] STEP 2: a second team-note row naming the same file, even under another scheme and host, is refused, and only because of the new index');

  const chain = runChain();
  assert.match(chain, /SMOKE_PASS_ROLLBACK/, `the live chain failed after step 2:\n${chain}`);
  assert.doesNotMatch(chain, /SMOKE_FAIL|SMOKE_SETUP/, `the live chain failed after step 2:\n${chain}`);
  console.log('[prover] STEP 2: the live chain still passes');

  const again = apply('step2.sql');
  assert.notEqual(again.status, 0, 'step 2 applied a second time');
  assert.match(again.output, /STAFF_PHOTOS_PRIVATE_PREFLIGHT: the three photo buckets must exist and still be public/, `second step 2 apply refused for the wrong reason:\n${again.output}`);
  console.log('[prover] STEP 2 RE-APPLY: refused by the preflight');
}

function main() {
  if (!REUSE) buildContainer();
  fidelity();
  if (scalar("SELECT count(*) FROM public.profiles WHERE id::text LIKE '7a500000-%';") === '0') seed();

  const before = runMatrix('before');
  check('before', before);
  preflightRefusesDrift();
  const chainBefore = runChain();
  assert.match(chainBefore, /SMOKE_FAIL: the three staff photo read policies are not installed/, `the live chain should fail before the candidate:\n${chainBefore}`);

  stageText('candidate.sql', lf(CANDIDATE));
  const a = apply('candidate.sql');
  assert.equal(a.status, 0, `the candidate failed to apply:\n${a.output}`);
  console.log('[prover] candidate applied');

  const after = runMatrix('after');
  check('after', after, before);
  const chainAfter = runChain();
  assert.match(chainAfter, /SMOKE_PASS_ROLLBACK/, `the live chain failed after the candidate:\n${chainAfter}`);
  assert.doesNotMatch(chainAfter, /SMOKE_FAIL|SMOKE_SETUP/, `the live chain failed after the candidate:\n${chainAfter}`);
  console.log('[prover] LIVE CHAIN: smoke-staff_photo_storage_access.sql fails before the candidate and passes after');

  const again = apply('candidate.sql');
  assert.notEqual(again.status, 0, 'the candidate applied a second time');
  assert.match(again.output, /STAFF_PHOTOS_PREFLIGHT/, `second apply refused for the wrong reason:\n${again.output}`);
  assert.equal(scalar("SELECT count(*) FROM storage.buckets WHERE id IN ('delivery-photos','receiving-photos','team-note-attachments') AND public;"), '3', 'step 1 changed a bucket\'s public flag');
  console.log('[prover] RE-APPLY: refused by the preflight; the buckets are still public');

  const mutant = attempt(U.APPLICATOR, view(OBJ.APPL), {
    fixture: 'CREATE OR REPLACE FUNCTION public.is_driver() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT true $$;',
  });
  assert.match(mutant, SEEN, `MUTATION: with is_driver() forced true the applicator should see the photo of a delivery assigned to them, got ${mutant}`);
  console.log('[prover] MUTATION: with is_driver() forced true the applicator sees that photo, so the driver gate is what refuses it');

  step2(after);
  console.log('STAFF_PHOTO_STORAGE_PROOF_PASS');
}

try { main(); }
finally { if (!KEEP) docker(['rm', '-f', NAME], { allowFailure: true }); }
