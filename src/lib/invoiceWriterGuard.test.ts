// HARD guard, run on every PR (review round 1 of 20261013160000_invoicing_admin_only: the
// migration's postflight sweep only runs when that file is applied, so on its own it cannot stop
// a LATER migration from adding an unguarded invoice writer).
//
// Mason 2026-10-09: invoicing is admin-only. This test applies the postflight's rule to every
// migration from 20261013160000 on: a public function or procedure such a file creates must call
// public._require_invoicing_admin() FIRST (a DECLARE section before it may only declare: no
// initializer, no call) and have no exception handler that could catch that refusal, when its
// body, comments stripped (string literals kept),
//   - INSERTs, UPDATEs, DELETEs, MERGEs or TRUNCATEs an invoice table (ONLY and quotes included),
//   - runs dynamic SQL (EXECUTE) and names an invoice table anywhere, literals included,
//   - calls a frozen _<name>_pre_admin_only_20261009 implementation,
//   - calls a pre-existing function that reaches an invoice write unguarded (REACH below), or
//   - calls another function created in these files that does any of the above,
// unless that function is internal (EXECUTE revoked from authenticated in these files and never
// re-granted, or a pre-existing internal function that is never granted) or it is on the
// reviewed allowlist below, which pins its exact body: a re-emitted body must be re-reviewed.
// Review round 2 adds:
//   - REVIEWED_BODIES: the guard helper, the fingerprint, the delivery-completion implementation
//     (whose admin-only hunk is the only thing between a rep's completion and an auto-invoice)
//     and complete_job are pinned to their reviewed bodies; and a LATER migration that re-emits
//     any pre-existing invoice-reaching INTERNAL function (REACH_INTERNAL: the completion chain,
//     the frozen implementations, ...) needs its body pinned here too. Internal functions are
//     otherwise exempt, so without this an old body could be re-emitted and quietly bring back
//     rep auto-invoicing.
//   - Functions are keyed by name AND argument types, so a guarded overload cannot hide an
//     unguarded one.
// Like the postflight it is a regex over the SQL text, not a parser: writes from other schemas
// and calls through a quoted or schema-dotted name it does not match are outside it.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationsDir = join(repoRoot, 'supabase', 'migrations');
const FIRST_GUARDED_MIGRATION = '20261013160000';
const md5 = (text: string) => createHash('md5').update(text, 'utf8').digest('hex');

const INVOICE_TABLES = ['invoices', 'invoice_items', 'invoice_shares', 'invoice_line_shares', 'invoice_line_share_snapshots',
  'invoice_line_allocations', 'field_app_locations', 'field_app_location_shares', 'field_app_billing_sets',
  'field_app_billing_lines', 'write_offs'];
const WRITES = new RegExp(`\\b(insert\\s+into|update|delete\\s+from|merge\\s+into|truncate(\\s+table)?)\\s+(only\\s+)?("?public"?\\s*\\.\\s*)?"?(${INVOICE_TABLES.join('|')})("|\\b)`, 'i');
const DYNAMIC_SQL = /\bexecute\b/i;
const NAMES_INVOICE_TABLE = new RegExp(`\\b(${INVOICE_TABLES.join('|')})\\b`, 'i');
const EXCEPTION_HANDLER = /\bexception\s+when\b/i;
const FROZEN_CALL = /\b_\w+_pre_admin_only_20261009\s*\(/;
// The postflight's guard-first rules, character for character in meaning.
const GUARD_FIRST = /^\s*(DECLARE(\s+(?![Bb][Ee][Gg][Ii][Nn]\b)\w+\s+[\w[\]. %]+;)*\s+)?BEGIN\s+PERFORM public\._require_invoicing_admin\(\);/;
const SPLIT_KEY_THEN_GUARD = /^\s*BEGIN\s+IF p_idempotency_key IS NULL OR p_idempotency_key !~ '\[\^\[:space:\]\]' THEN\s+RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order'\s+USING ERRCODE = '22023';\s+END IF;\s+PERFORM public\._require_invoicing_admin\(\);/;

// Every public function that reaches an invoice write without the guard, read from the container
// replay of live with 20261013160000 applied (2026-10-09; the postflight's writer and edge rules,
// guarded wrappers excluded). EXPOSED ones authenticated can execute; INTERNAL ones it cannot.
const REACH_EXPOSED = [
  'allocate_payment', 'apply_remaining_prepayments', 'apply_write_off', 'batch_cancel_deliveries',
  'cancel_delivery', 'cancel_order', 'complete_delivery', 'create_invoice_for_unbilled_delivery',
  'create_quick_delivery', 'delete_invoices', 'generate_finance_charges', 'issue_return_credit',
  'price_order', 'process_offline_action', 'unapply_credit_memo', 'update_order_items',
  'void_delivery', 'void_invoice', 'void_invoice_group', 'void_order',
  'void_payment',
];
const REACH_INTERNAL = [
  '_apply_credit_memo_to_invoice_pre_admin_only_20261009', '_apply_prepay_to_invoice_pre_admin_only_20261009', '_batch_apply_all_prepayments_pre_admin_only_20261009', '_batch_void_invoices_pre_admin_only_20261009',
  '_cancel_order_idem_impl_20260721', '_cancel_order_impl_20260714', '_cancel_order_provenance_wrapper_20260719', '_cancel_order_split_provenance_impl_20260719',
  '_complete_delivery_aggregate_impl', '_complete_delivery_authorized_impl', '_complete_delivery_period_preflight_impl', '_consolidate_draft_invoices_pre_admin_only_20261009',
  '_create_invoice_for_unbilled_delivery_idem_impl_20260721', '_create_invoice_for_unbilled_delivery_impl_20260718', '_create_invoice_from_blend_ticket_pre_admin_only_20261009', '_create_invoice_from_order_idem_impl_20260721',
  '_create_invoice_from_order_impl_20260718', '_create_invoice_from_order_pre_admin_only_20261009', '_create_quick_delivery_intent_impl_20260802', '_create_quick_delivery_pre_admin_only_20261009',
  '_create_split_invoices_from_order_pre_admin_only_20261009', '_create_split_invoices_from_order_provenance_impl_20260719', '_delete_invoices_split_provenance_impl_20260719', '_generate_finance_charges_idem_impl_20260721',
  '_issue_return_credit_header_only_impl_20260825', '_issue_return_credit_impl', '_issue_return_credit_intent_impl_20260812', '_post_deleted_delivery_recovery_invoice_20260719',
  '_post_invoice_customer_scope_impl', '_post_invoice_group_customer_scope_impl', '_post_invoice_group_pre_admin_only_20261009', '_post_invoice_idem_impl_20260721',
  '_post_invoice_impl_20260714', '_post_invoice_pre_admin_only_20261009', '_post_invoice_public_impl_20260718', '_price_order_below_cost_impl_20260810',
  '_reverse_credit_memo_application', '_reverse_credit_memo_application_pre_admin_only_20261009', '_reverse_credit_memo_application_status_impl_20260812', '_reverse_write_off_pre_admin_only_20261009',
  '_save_field_app_invoice_impl_20260714', '_save_field_app_invoice_pre_admin_only_20261009', '_save_field_app_split_invoice_impl', '_save_field_app_split_invoice_pre_admin_only_20261009',
  '_save_invoice_below_cost_impl_20260810', '_save_invoice_governed_split_guard_impl_20260720', '_save_invoice_intent_impl_20260802', '_save_invoice_lineage_unaware_impl_20260827',
  '_save_invoice_pre_admin_only_20261009', '_save_invoice_scoped_impl', '_save_invoice_split_provenance_impl_20260719', '_transfer_invoice_to_job_pre_admin_only_20261009',
  '_transfer_job_to_invoice_intent_impl_20260908', '_transfer_job_to_invoice_pre_admin_only_20261009', '_unapply_return_credit_guard_impl_20260826', '_unpost_invoice_pre_admin_only_20261009',
  '_update_field_app_applied_info_pre_admin_only_20261009', '_update_field_app_invoice_billing_pre_admin_only_20261009', '_update_order_items_below_cost_impl_20260810', '_update_order_items_impl',
  '_void_invoice_group_guard_impl_20260720', '_void_invoice_return_credit_guard_impl_20260826', '_void_invoice_split_provenance_impl_20260719', '_void_order_impl_20260714',
  'mark_overdue_invoices', 'snapshot_invoice_line_shares_on_post',
];

// Reviewed exceptions: exposed, reach an invoice write, deliberately not guarded. Each pins the
// md5 of its LF-normalized body, so any re-emission needs a new review here.
const ALLOWLIST: Record<string, { md5: string; reason: string }> = {
  create_quick_delivery: {
    md5: '1bf67e10cae538b5090b067aa3f665f5',
    reason: '20261013160000 1e: coerces p_skip_invoice = true for a non-admin instead of refusing; the frozen body then creates no invoice',
  },
};

// Review round 2: bodies whose every definition, in every scanned migration, must be one of the
// reviewed md5s below (the same md5s 20261013160000's postflight pins). A LATER migration that
// re-emits any REACH_INTERNAL function must add its reviewed body md5 here as well.
const REVIEWED_BODIES: Record<string, { md5s: string[]; reason: string }> = {
  _require_invoicing_admin: { md5s: ['629609ce38f7c192abfde5be47848557'], reason: 'the guard every invoicing wrapper relies on (EXISTS on an ACTIVE admin, 42501)' },
  _invoice_review_fingerprint: { md5s: ['d56454064dc8f78063a2afd2bada9697'], reason: 'the posting version check binds to it' },
  _complete_delivery_authorized_impl: { md5s: ['b9b314f56adeba3a58ebe38a48d839b1'], reason: 'its ELSIF v_actor_role = \'admin\' hunk is all that stops a rep\'s or driver\'s completion from auto-invoicing' },
  complete_job: { md5s: ['9196da7ce6337bd0176a67b37be950f2'], reason: 'its IF is_admin() gate is all that stops a rep\'s job completion from auto-drafting' },
};

type Fn = { key: string; name: string; file: string; body: string; code: string; replace: boolean };
type Violation = { name: string; file: string; why: string };

/**
 * Comments removed left to right, string literals kept (review round 2: a '--' or '/*' inside a
 * literal no longer hides what follows it). Single-quoted literals ('' escapes) and dollar-quoted
 * literals are copied as they are; an unclosed block comment or literal is kept, not stripped.
 */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    if (rest.startsWith('--')) {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (rest.startsWith('/*')) {
      const close = text.indexOf('*/', i + 2);
      if (close >= 0) { i = close + 2; continue; }
      out += '/*';
      i += 2;
      continue;
    }
    if (text[i] === "'") {
      // An E'...' string takes backslash escapes, so \' does not end it (Luna, PR A): reading it as
      // the end would let a "--" inside the string hide the rest of the line as a comment.
      const escapes = /[Ee]/.test(text[i - 1] ?? '') && !/\w/.test(text[i - 2] ?? '');
      let j = i + 1;
      while (j < text.length) {
        if (escapes && text[j] === '\\') { j += 2; continue; }
        if (text[j] === "'" && text[j + 1] === "'") { j += 2; continue; }
        if (text[j] === "'") break;
        j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const dollar = /^\$(\w*)\$/.exec(rest);
    if (dollar) {
      const close = text.indexOf(dollar[0], i + dollar[0].length);
      const end = close < 0 ? text.length : close + dollar[0].length;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/** The text between the parenthesis at `open` and its matching close (quotes respected). */
function balanced(text: string, open: number): string | null {
  let depth = 0;
  let quoted = false;
  for (let j = open; j < text.length; j += 1) {
    const c = text[j];
    if (quoted) { if (c === "'") quoted = false; continue; }
    if (c === "'") quoted = true;
    else if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return text.slice(open + 1, j); }
  }
  return null;
}

const TYPE_START = new Set(['time', 'timestamp', 'double', 'character', 'bit', 'interval', 'varying']);
/** name(type,type,...) from an argument list with or without names, modes and defaults. */
function signatureKey(name: string, args: string): string {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const c of args) {
    if (quoted) { cur += c; if (c === "'") quoted = false; continue; }
    if (c === "'") quoted = true;
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  const types = parts.map((p) => {
    let a = p.replace(/\s+(DEFAULT\b|=)[\s\S]*$/i, '').trim().replace(/\s+/g, ' ').toLowerCase();
    a = a.replace(/^(in|out|inout|variadic) /, '');
    const words = a.split(' ');
    if (words.length > 1 && !TYPE_START.has(words[0])) a = words.slice(1).join(' ');
    return a.replace(/^public\./, '').replace(/"/g, '');
  });
  return `${name}(${types.join(',')})`;
}

function functionsIn(file: string, sql: string): { fns: Fn[]; unparsed: string[] } {
  const fns: Fn[] = [];
  const unparsed: string[] = [];
  const head = /CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\s+(?:"?(\w+)"?\s*\.\s*)?"?(\w+)"?\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = head.exec(sql))) {
    if (m[3] && m[3].toLowerCase() !== 'public') continue;
    const name = m[4];
    const rest = sql.slice(m.index);
    const args = balanced(rest, m[0].length - 1);
    const tag = /\bAS\s+(\$\w*\$)/i.exec(rest);
    const stop = rest.indexOf(';');
    if (args === null || !tag || (stop >= 0 && stop < tag.index)) { unparsed.push(name); continue; }
    const bodyStart = tag.index + tag[0].length;
    const bodyEnd = rest.indexOf(tag[1], bodyStart);
    if (bodyEnd < 0) { unparsed.push(name); continue; }
    const body = rest.slice(bodyStart, bodyEnd);
    fns.push({ key: signatureKey(name, args), name, file, body, code: stripComments(body), replace: Boolean(m[1]) });
    head.lastIndex = m.index + bodyEnd + tag[1].length;
  }
  return { fns, unparsed };
}

// Review round 4 (Luna LOW): the table layer. The function rule below cannot see a LATER
// migration that hands authenticated (or anon, or PUBLIC) a write privilege on an invoice table,
// adds or alters a policy on one, turns its row level security off, or creates a function through
// dynamic SQL inside a DO block (which the function rule cannot scan). Each of those needs a
// review: pin its statement's md5 (whitespace collapsed) here. Write grants are checked in every
// scanned file (20261013160000 only revokes); policies and DO blocks in the files after it
// (20261013160000's own policies are pinned by its postflight).
const INVOICE_TABLE_REF = `(?:"?public"?\\s*\\.\\s*)?"?(${INVOICE_TABLES.join('|')})"?(?![\\w"])`;
const REVIEWED_TABLE_STATEMENTS: Record<string, string> = {};
function tableLayerViolations(file: string, sql: string, top: string): Violation[] {
  const out: Violation[] = [];
  const flag = (statement: string, table: string, why: string) => {
    const key = md5(statement.trim().replace(/\s+/g, ' '));
    if (!REVIEWED_TABLE_STATEMENTS[key]) out.push({ name: table, file, why: `${why} (statement md5 ${key}): review it and pin it in REVIEWED_TABLE_STATEMENTS` });
  };
  const later = file.slice(0, 14) > FIRST_GUARDED_MIGRATION;
  for (const s of top.split(';')) {
    const grant = /^\s*GRANT\s+([\s\S]*?)\s+ON\s+(?!FUNCTION\b|PROCEDURE\b|ROUTINE\b|SEQUENCE\b|SCHEMA\b|ALL\s+(?:FUNCTIONS|ROUTINES|PROCEDURES|SEQUENCES)\b)(?:TABLE\s+)?([\s\S]*?)\s+TO\s+([\s\S]*)$/i.exec(s);
    if (grant && /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b/i.test(grant[1]) && /\b(authenticated|anon|PUBLIC)\b/i.test(grant[3])) {
      if (/\bALL\s+TABLES\s+IN\s+SCHEMA\s+public\b/i.test(grant[2])) flag(s, '*', 'grants a write privilege on every public table to an API role');
      for (const t of grant[2].matchAll(new RegExp(INVOICE_TABLE_REF, 'gi'))) flag(s, t[1], 'grants a write privilege on an invoice table to an API role');
    }
    if (!later) continue;
    // A write policy: FOR INSERT/UPDATE/DELETE/ALL, or no FOR clause (which means ALL).
    const create = new RegExp(`^\\s*CREATE\\s+POLICY\\s+[\\s\\S]*?\\bON\\s+${INVOICE_TABLE_REF}([\\s\\S]*)$`, 'i').exec(s);
    if (create && !/^\s*(?:AS\s+\w+\s+)?FOR\s+SELECT\b/i.test(create[2])) flag(s, create[1], 'creates a write policy on an invoice table');
    // An altered policy (the ALTER does not show its command), or row level security turned off.
    const alter = new RegExp(`^\\s*ALTER\\s+POLICY\\s+[\\s\\S]*?\\bON\\s+${INVOICE_TABLE_REF}`, 'i').exec(s);
    if (alter) flag(s, alter[1], 'alters a policy on an invoice table');
    const rls = new RegExp(`^\\s*ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${INVOICE_TABLE_REF}[\\s\\S]*\\b(?:DISABLE|NO\\s+FORCE)\\s+ROW\\s+LEVEL\\s+SECURITY\\b`, 'i').exec(s);
    if (rls) flag(s, rls[1], 'turns row level security off on an invoice table');
  }
  if (later) {
    for (const m of sql.matchAll(/\bDO\s+(?:LANGUAGE\s+\w+\s+)?(\$\w*\$)([\s\S]*?)\1/gi)) {
      const code = stripComments(m[2]);
      if (/\bexecute\b/i.test(code) && /\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\b/i.test(code)) {
        flag(m[0], '*', 'creates a function through dynamic SQL in a DO block, which this scan cannot read');
      }
    }
  }
  return out;
}

/** The rule over an ordered list of migration texts. Returns every violation. */
function scan(files: Array<{ file: string; sql: string }>, allowlist: typeof ALLOWLIST = ALLOWLIST,
  reviewed: typeof REVIEWED_BODIES = REVIEWED_BODIES): Violation[] {
  const violations: Violation[] = [];
  const latest = new Map<string, Fn>();
  const revoked = new Map<string, boolean>();
  const reachInternal = new Set(REACH_INTERNAL);
  for (const { file, sql: raw } of files) {
    const sql = raw.replace(/\r\n/g, '\n');
    const top = stripComments(sql.replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, '<body>'));
    if (/GRANT\s+[^;]*\bON\s+ALL\s+(FUNCTIONS|ROUTINES)\s+IN\s+SCHEMA\s+public\b[^;]*\bauthenticated\b/i.test(top)) {
      violations.push({ name: '*', file, why: 'blanket EXECUTE grant on every public function to authenticated' });
    }
    violations.push(...tableLayerViolations(file, sql, top));
    const { fns, unparsed } = functionsIn(file, sql);
    for (const name of unparsed) violations.push({ name, file, why: 'body could not be parsed (use a dollar-quoted body)' });
    for (const f of fns) {
      // Every definition of a pinned body must be a reviewed one; a later re-emission of a
      // pre-existing invoice-reaching internal function needs a reviewed pin too.
      const pin = reviewed[f.name];
      const later = file.slice(0, 14) > FIRST_GUARDED_MIGRATION;
      if ((pin || (later && reachInternal.has(f.name))) && !(pin?.md5s ?? []).includes(md5(f.body))) {
        violations.push({ name: f.name, file, why: `re-emits a reviewed invoicing body (md5 ${md5(f.body)}): re-review it and pin it in REVIEWED_BODIES` });
      }
    }
    // A plain CREATE starts from the default privileges (authenticated can execute); CREATE OR
    // REPLACE keeps whatever ACL the function already had.
    for (const f of fns) { latest.set(f.key, f); if (!f.replace) revoked.delete(f.key); }
    // Statement order inside one file does not matter here: a REVOKE from authenticated in the
    // same or a later file marks the signature internal; a later GRANT to authenticated re-exposes it.
    for (const s of top.split(';')) {
      const rv = /REVOKE\s+[^;]*\bON\s+(FUNCTION|PROCEDURE|ROUTINE)\s+(?:public\s*\.\s*)?"?(\w+)"?\s*(\()[^;]*\bFROM\b([^;]*)/i.exec(s);
      if (rv && /\bauthenticated\b/i.test(rv[4])) {
        const args = balanced(s, rv.index + rv[0].indexOf('(', rv[0].indexOf(rv[2])));
        if (args !== null) revoked.set(signatureKey(rv[2], args), true);
      }
      const gr = /GRANT\s+[^;]*\bON\s+(FUNCTION|PROCEDURE|ROUTINE)\s+(?:public\s*\.\s*)?"?(\w+)"?\s*(\()[^;]*\bTO\b([^;]*)/i.exec(s);
      if (gr && /\b(authenticated|PUBLIC)\b/i.test(gr[4])) {
        const args = balanced(s, gr.index + gr[0].indexOf('(', gr[0].indexOf(gr[2])));
        if (args !== null) revoked.set(signatureKey(gr[2], args), false);
      }
    }
  }
  const reachExposed = new Set(REACH_EXPOSED);
  const scannedNames = new Set([...latest.values()].map((f) => f.name));
  // Guard first, and no exception handler anywhere in the body that could catch its refusal.
  const guarded = (f: Fn) => !EXCEPTION_HANDLER.test(f.code)
    && (GUARD_FIRST.test(f.body) || (f.name === 'create_split_invoices_from_order' && SPLIT_KEY_THEN_GUARD.test(f.body)));
  const calls = (code: string, name: string) => new RegExp(`\\b${name}\\s*\\(`).test(code);
  // Writers among the scanned functions (to a fixed point): direct writes, dynamic SQL naming an
  // invoice table, frozen calls, calls to a pre-existing unguarded reacher, or calls to another
  // scanned writer that is not guarded (by name: any overload of it counts).
  const writer = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of latest.values()) {
      if (writer.has(f.key)) continue;
      const unguardedWriterNames = [...latest.values()].filter((w) => writer.has(w.key) && !guarded(w)).map((w) => w.name);
      const reaches = WRITES.test(f.code) || (DYNAMIC_SQL.test(f.code) && NAMES_INVOICE_TABLE.test(f.code)) || FROZEN_CALL.test(f.code)
        || [...reachExposed, ...reachInternal].some((n) => n !== f.name && !scannedNames.has(n) && calls(f.code, n))
        || unguardedWriterNames.some((n) => n !== f.name && calls(f.code, n));
      if (reaches) { writer.add(f.key); grew = true; }
    }
  }
  for (const f of latest.values()) {
    if (!writer.has(f.key) || guarded(f)) continue;
    const internal = revoked.get(f.key) === true || (revoked.get(f.key) === undefined && f.replace && reachInternal.has(f.name));
    if (internal) continue;
    const allowed = allowlist[f.name];
    if (allowed && md5(f.body) === allowed.md5) continue;
    violations.push({ name: f.name, file: f.file, why: allowed ? `allowlisted body changed (md5 ${md5(f.body)}): re-review it` : 'reaches an invoice write without calling _require_invoicing_admin() first' });
  }
  return violations;
}

const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql') && f.slice(0, 14) >= FIRST_GUARDED_MIGRATION).sort();

describe('invoice writers stay admin-only after 20261013160000 (CI companion of its postflight sweep)', () => {
  it('scans 20261013160000 and every later migration', () => {
    expect(migrationFiles[0]).toBe('20261013160000_invoicing_admin_only.sql');
  });

  it('reads a "--" inside a string as text, not a comment, in plain and E\'...\' strings', () => {
    // Luna, PR A: an escaped quote in an E-string ended the string early, so a "--" after it hid
    // the rest of the line (an invoice write included) as a comment.
    expect(stripComments("v := E'it\\'s -- not a comment'; DELETE FROM public.invoices;")).toContain('DELETE FROM public.invoices');
    expect(stripComments("v := 'a '' -- b'; DELETE FROM public.invoices;")).toContain('DELETE FROM public.invoices');
    expect(stripComments("x := 1; -- DELETE FROM public.invoices;")).not.toContain('DELETE');
    // A plain string ending in a backslash is not an E-string: its quote still ends it.
    expect(stripComments("v := 'C:\\'; -- DELETE FROM public.invoices;")).not.toContain('DELETE');
  });

  it('finds no unguarded invoice writer in any migration from 20261013160000 on', () => {
    const files = migrationFiles.map((file) => ({ file, sql: readFileSync(join(migrationsDir, file), 'utf8') }));
    expect(scan(files)).toEqual([]);
    // Not vacuous: without the allowlist the scan flags exactly the allowlisted functions, and
    // without the reviewed pins it flags exactly the pinned bodies this file defines.
    expect(scan(files, {}).map((v) => v.name).sort()).toEqual(Object.keys(ALLOWLIST).sort());
    expect(scan(files, ALLOWLIST, Object.fromEntries(Object.entries(REVIEWED_BODIES).map(([k, v]) => [k, { ...v, md5s: [] }]))).map((v) => v.name).sort())
      .toEqual(Object.keys(REVIEWED_BODIES).sort());
  });

  describe('the rule itself (each must fail when it should)', () => {
    const base = readFileSync(join(migrationsDir, '20261013160000_invoicing_admin_only.sql'), 'utf8');
    const withNext = (sql: string) => scan([{ file: '20261013160000_invoicing_admin_only.sql', sql: base }, { file: '29990101000000_probe.sql', sql }]);
    const fn = (name: string, body: string, extra = '', args = 'p uuid') => `CREATE OR REPLACE FUNCTION public.${name}(${args}) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$${body}$f$;\n${extra}`;
    const names = (v: Violation[]) => v.map((x) => x.name);

    it('accepts the guard first, and an internal (revoked) writer', () => {
      expect(withNext(fn('probe_ok', '\nBEGIN\n  PERFORM public._require_invoicing_admin();\n  DELETE FROM public.invoice_items WHERE invoice_id = p;\nEND;\n'))).toEqual([]);
      expect(withNext(fn('_probe_impl', '\nBEGIN\n  UPDATE public.invoices SET header_notes = NULL WHERE id = p;\nEND;\n',
        'REVOKE ALL ON FUNCTION public._probe_impl(uuid) FROM PUBLIC, anon, authenticated, service_role;'))).toEqual([]);
    });
    it('flags a direct write without the guard, in every spelling', () => {
      for (const write of ['DELETE FROM public.invoice_items WHERE invoice_id = p', 'UPDATE ONLY "public"."invoices" SET header_notes = NULL',
        'INSERT INTO field_app_locations (invoice_id, field_id) VALUES (p, p)', 'TRUNCATE TABLE public.write_offs',
        'MERGE INTO invoice_shares s USING (SELECT 1) x ON false WHEN NOT MATCHED THEN DO NOTHING']) {
        expect(names(withNext(fn('probe_writer', `\nBEGIN\n  ${write};\nEND;\n`))), write).toEqual(['probe_writer']);
      }
    });
    it('flags a guard that runs after the write, or after a DECLARE initializer', () => {
      expect(names(withNext(fn('probe_late', '\nBEGIN\n  DELETE FROM public.invoices WHERE id = p;\n  PERFORM public._require_invoicing_admin();\nEND;\n')))).toEqual(['probe_late']);
      expect(names(withNext(fn('probe_decl', "\nDECLARE\n  v uuid := public._save_invoice_pre_admin_only_20261009('{}'::jsonb, '[]'::jsonb, 'k');\nBEGIN\n  PERFORM public._require_invoicing_admin();\nEND;\n")))).toEqual(['probe_decl']);
      expect(names(withNext(fn('probe_nested', '\nDECLARE\n  v int;\nBEGIN\n  DELETE FROM public.invoices WHERE id = p;\n  BEGIN\n  PERFORM public._require_invoicing_admin();\n  END;\nEND;\n')))).toEqual(['probe_nested']);
    });
    it('flags a call to a frozen implementation, a pre-existing unguarded reacher, or a new internal writer', () => {
      expect(names(withNext(fn('probe_frozen', "\nBEGIN\n  PERFORM public._post_invoice_pre_admin_only_20261009(p, 'k');\nEND;\n")))).toEqual(['probe_frozen']);
      expect(names(withNext(fn('probe_impl_call', "\nBEGIN\n  PERFORM public._post_invoice_public_impl_20260718(p, NULL);\nEND;\n")))).toEqual(['probe_impl_call']);
      const internal = fn('_probe_impl2', '\nBEGIN\n  UPDATE public.invoices SET header_notes = NULL WHERE id = p;\nEND;\n',
        'REVOKE ALL ON FUNCTION public._probe_impl2(uuid) FROM PUBLIC, anon, authenticated, service_role;');
      expect(names(withNext(`${internal}\n${fn('probe_caller', '\nBEGIN\n  PERFORM public._probe_impl2(p);\nEND;\n')}`))).toEqual(['probe_caller']);
      // Calling a guarded public wrapper is fine.
      expect(withNext(fn('probe_wrapper_call', "\nBEGIN\n  PERFORM public.post_invoice(p, 'k');\nEND;\n"))).toEqual([]);
    });
    it('does not let a comment hide a write, and re-exposes a writer granted back to authenticated', () => {
      expect(names(withNext(fn('probe_comment', '\nBEGIN\n  -- a note /* that never closes\n  DELETE FROM public.invoices WHERE id = p;\n  /* x */\nEND;\n')))).toEqual(['probe_comment']);
      expect(names(withNext(fn('_probe_regrant', '\nBEGIN\n  UPDATE public.invoices SET header_notes = NULL WHERE id = p;\nEND;\n',
        'REVOKE ALL ON FUNCTION public._probe_regrant(uuid) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public._probe_regrant(uuid) TO authenticated;')))).toEqual(['_probe_regrant']);
    });
    it('re-flags an allowlisted function whose body changes, and a blanket grant', () => {
      const changed = 'CREATE OR REPLACE FUNCTION public.create_quick_delivery(p uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$\nBEGIN\n  RETURN public._create_quick_delivery_pre_admin_only_20261009(p);\nEND;\n$function$;';
      expect(names(withNext(changed))).toEqual(['create_quick_delivery']);
      expect(names(withNext('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;'))).toEqual(['*']);
      // An upkeep function re-emitted later (here price_order, unguarded) needs its own review.
      expect(names(withNext(fn('price_order', '\nBEGIN\n  UPDATE public.invoice_items SET quantity = 1 WHERE invoice_id = p;\nEND;\n')))).toEqual(['price_order']);
    });

    // Review round 2.
    it('flags a later re-emission of the delivery-completion implementation from its pre-candidate body', () => {
      // The live body before 20261013160000 (no admin-only hunk): reps' and drivers' completions
      // auto-invoice again. The implementation is internal, so only the reviewed pin catches it.
      const prior = readFileSync(join(migrationsDir, '20260827041300_align_return_credit_delivery_surfaces.sql'), 'utf8').replace(/\r\n/g, '\n');
      const start = prior.indexOf('CREATE OR REPLACE FUNCTION public._complete_delivery_authorized_impl(');
      expect(start).toBeGreaterThanOrEqual(0);
      const end = prior.indexOf('$function$;', start) + '$function$;'.length;
      const reemit = prior.slice(start, end);
      expect(reemit).not.toContain("ELSIF v_actor_role = 'admin' THEN");
      expect(names(withNext(reemit))).toEqual(['_complete_delivery_authorized_impl']);
      // Any other pre-existing invoice-reaching internal function re-emitted later, too.
      expect(names(withNext(fn('_complete_delivery_aggregate_impl', '\nBEGIN\n  RETURN;\nEND;\n',
        'REVOKE ALL ON FUNCTION public._complete_delivery_aggregate_impl(uuid) FROM PUBLIC, anon, authenticated;')))).toEqual(['_complete_delivery_aggregate_impl']);
    });
    it('flags a weakened guard helper or complete_job', () => {
      const helper = 'CREATE OR REPLACE FUNCTION public._require_invoicing_admin() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$\nBEGIN\nEND;\n$function$;';
      expect(names(withNext(helper))).toEqual(['_require_invoicing_admin']);
      expect(names(withNext(fn('complete_job', '\nBEGIN\n  PERFORM 1;\nEND;\n', '', 'p_job_id uuid, p_applied_info jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text')))).toEqual(['complete_job']);
    });
    it('flags a guard-first body whose exception handler swallows the refusal and then writes', () => {
      expect(names(withNext(fn('probe_swallow', '\nBEGIN\n  PERFORM public._require_invoicing_admin();\n  RETURN;\nEXCEPTION WHEN OTHERS THEN\n  DELETE FROM public.invoices WHERE id = p;\nEND;\n')))).toEqual(['probe_swallow']);
    });
    it('treats dynamic SQL that names an invoice table as a write', () => {
      expect(names(withNext(fn('probe_dynamic', "\nBEGIN\n  EXECUTE 'DELETE FROM ' || 'public.invoices WHERE id = $1' USING p;\nEND;\n")))).toEqual(['probe_dynamic']);
      expect(names(withNext(fn('probe_dynamic_format', "\nBEGIN\n  EXECUTE format('UPDATE public.%I SET header_notes = NULL WHERE id = $1', 'write_offs') USING p;\nEND;\n")))).toEqual(['probe_dynamic_format']);
    });
    it('does not let a comment marker inside a string literal hide a write', () => {
      expect(names(withNext(fn('probe_literal', "\nDECLARE\n  v text;\nBEGIN\n  v := '--'; DELETE FROM public.invoices WHERE id = p;\nEND;\n")))).toEqual(['probe_literal']);
      expect(names(withNext(fn('probe_literal_block', "\nDECLARE\n  v text;\nBEGIN\n  v := '/*';\n  DELETE FROM public.invoices WHERE id = p;\n  v := '*/';\nEND;\n")))).toEqual(['probe_literal_block']);
    });
    it('keys functions by signature, so a guarded overload cannot hide an unguarded one', () => {
      const unguarded = fn('probe_overload', '\nBEGIN\n  DELETE FROM public.invoices WHERE id = p;\nEND;\n', '', 'p uuid');
      const guarded = fn('probe_overload', '\nBEGIN\n  PERFORM public._require_invoicing_admin();\n  DELETE FROM public.invoices WHERE id = p;\nEND;\n', '', 'p uuid, q text');
      expect(names(withNext(`${unguarded}\n${guarded}`))).toEqual(['probe_overload']);
      // The same signature re-emitted guarded replaces it.
      const regarded = fn('probe_overload', '\nBEGIN\n  PERFORM public._require_invoicing_admin();\n  DELETE FROM public.invoices WHERE id = p;\nEND;\n', '', 'p_x uuid');
      expect(withNext(`${unguarded}\n${regarded}`)).toEqual([]);
    });

    // Review round 4 (Luna LOW): the table layer.
    it('flags a later write grant on an invoice table to an API role, and not a read grant', () => {
      expect(names(withNext('GRANT UPDATE ON public.invoices TO authenticated;'))).toEqual(['invoices']);
      expect(names(withNext('GRANT INSERT, DELETE ON TABLE "public"."invoice_items", public.write_offs TO anon;'))).toEqual(['invoice_items', 'write_offs']);
      expect(names(withNext('GRANT UPDATE (header_notes) ON invoices TO PUBLIC;'))).toEqual(['invoices']);
      expect(names(withNext('GRANT TRUNCATE ON public.invoice_line_shares TO authenticated;'))).toEqual(['invoice_line_shares']);
      expect(names(withNext('GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;'))).toEqual(['*']);
      expect(withNext('GRANT SELECT ON public.invoices TO authenticated;')).toEqual([]);
      expect(withNext('GRANT UPDATE ON public.invoices TO service_role;')).toEqual([]);
      expect(withNext('GRANT UPDATE ON public.invoices_archive TO authenticated;')).toEqual([]);
      expect(withNext('GRANT EXECUTE ON FUNCTION public.get_invoice_post_version(uuid[]) TO authenticated;')).toEqual([]);
    });
    it('flags a later write policy, an altered policy or row level security turned off on an invoice table', () => {
      expect(names(withNext('CREATE POLICY probe ON public.invoices FOR UPDATE TO authenticated USING (public.is_sales_rep());'))).toEqual(['invoices']);
      expect(names(withNext('CREATE POLICY probe ON public.invoice_shares AS PERMISSIVE FOR ALL TO authenticated USING (true);'))).toEqual(['invoice_shares']);
      expect(names(withNext('CREATE POLICY probe ON field_app_locations TO authenticated USING (true);'))).toEqual(['field_app_locations']);
      expect(names(withNext('CREATE POLICY probe ON public.write_offs FOR INSERT TO authenticated WITH CHECK (true);'))).toEqual(['write_offs']);
      expect(withNext('CREATE POLICY probe ON public.invoices FOR SELECT TO authenticated USING (public.is_sales_rep());')).toEqual([]);
      expect(withNext('CREATE POLICY probe ON public.orders FOR UPDATE TO authenticated USING (true);')).toEqual([]);
      expect(names(withNext('ALTER POLICY invoices_insert ON public.invoices WITH CHECK (true);'))).toEqual(['invoices']);
      expect(names(withNext('ALTER TABLE public.invoice_items DISABLE ROW LEVEL SECURITY;'))).toEqual(['invoice_items']);
      expect(names(withNext('ALTER TABLE IF EXISTS ONLY public.invoices NO FORCE ROW LEVEL SECURITY;'))).toEqual(['invoices']);
      expect(withNext('ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;')).toEqual([]);
    });
    it('flags a later DO block that creates a function through dynamic SQL', () => {
      expect(names(withNext("DO $$\nBEGIN\n  EXECUTE 'CREATE FUNCTION public.probe_hidden() RETURNS void LANGUAGE sql AS ''DELETE FROM public.invoices''';\nEND\n$$;"))).toContain('*');
      expect(names(withNext("DO LANGUAGE plpgsql $do$\nBEGIN\n  EXECUTE format('CREATE OR REPLACE PROCEDURE public.%I() LANGUAGE sql AS $p$ SELECT 1 $p$', 'probe');\nEND\n$do$;"))).toEqual(['*']);
      expect(withNext("DO $$\nBEGIN\n  IF to_regprocedure('public.probe()') IS NOT NULL THEN RAISE EXCEPTION 'x'; END IF;\nEND\n$$;")).toEqual([]);
    });
    it('accepts a reviewed table-layer statement only by its exact pin', () => {
      const statement = 'GRANT UPDATE ON public.invoices TO authenticated';
      const key = md5(statement);
      expect(withNext(`${statement};`)[0]?.why).toContain(`statement md5 ${key}`);
    });
  });
});
