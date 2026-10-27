#!/usr/bin/env node
// Tests for hold-latch, live-testdata, and codex-push guard logic + inert-when-off behavior.
// Run: node .claude/hooks/guards.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isHoldPhrase, isResumePhrase, isBuildActionUnderHold, holdDecision, holdStatePath } from "./hold-latch-lib.mjs";
import { classifySql } from "./live-testdata-lib.mjs";
import { isGitPush, pushTargetsMain, mainPushSource, riskyFiles, contentIsRisky, proofValid, programAssembledAtRuntime } from "./codex-push-lib.mjs";
import { DENY_TOOLNAME_RE } from "./autopilot-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Git exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE into a hook's environment,
// and a child `git` honors those over `-C <path>`. The mirror-remote block below
// builds a throwaway repo and configures it, so when this suite runs from the
// pre-commit hook those writes land in the REAL repository instead — observed
// 2026-08-07, when a pre-commit run wrote `remote.origin.mirror=true` into this
// repo, which the push guard then (correctly) refuses every push against. The
// throwaway repo meanwhile stays unconfigured, so the guard under test sees no
// mirror and the assertions fail. Strip them once for the whole process, the same
// shape as the inherited-GIT_CONFIG_* strip in scripts/backup-claude-memory.test.mjs.
for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
]) delete process.env[key];

let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

// ── hold-latch ───────────────────────────────────────────────────────────
ok(isHoldPhrase("lets just stop here, cancel all background work"), "stop+cancel");
ok(isHoldPhrase("pause this loop"), "pause");
ok(isHoldPhrase("im just scoping a future session, dont build yet"), "scope-only");
ok(!isHoldPhrase("build me the invoices page"), "normal build is not a hold");
// 2026-10-27: a descriptive stop / pause is skipped; an addressed one still latches.
ok(!isHoldPhrase("the agent should stop pushing to main"), "descriptive stop + -ing is not a hold");
ok(!isHoldPhrase("add a setting to stop the nightly sweep"), "a goal ('to stop the …') is not a hold");
ok(isHoldPhrase("we should stop pushing"), "an addressed stop + -ing still latches");
ok(isHoldPhrase("claude should pause retrying"), "naming the agent still latches");
ok(isHoldPhrase("I want to stop the merge"), "Mason's own want still latches");
ok(isHoldPhrase("I need the agent to stop the deploy"), "an order naming someone else still latches");
// Per-session hold files (2026-10-27): only a MISSING id shares hold.json.
eq(path.basename(holdStatePath("p", undefined)), "hold.json", "no session id → hold.json");
eq(path.basename(holdStatePath("p", "")), "hold.json", "empty session id → hold.json");
eq(path.basename(holdStatePath("p", null)), "hold.json", "null session id → hold.json");
eq(path.basename(holdStatePath("p", "abc-123")), "hold-abc-123.json", "a plain id names the file as-is");
const hashedName = (id) => path.basename(holdStatePath("p", id));
ok(/^hold\.[0-9a-f]{32}\.json$/.test(hashedName("../x")), "an unusual id is hashed");
ok(/^hold\.[0-9a-f]{32}\.json$/.test(hashedName(0)), "a falsy but present id still gets its own file");
ok(hashedName(0) !== hashedName("0"), "the number 0 and the string \"0\" get different files");
ok(hashedName("ABC") !== hashedName("abc"), "ids differing only in case get different files on a case-insensitive disk");
ok(hashedName("\uD800") !== hashedName("\uD801"), "two malformed (lone-surrogate) ids get different files");
ok(hashedName(-0) !== hashedName(0), "the numbers -0 and 0 get different files");
ok(/^hold\.[0-9a-f]{32}\.json$/.test(hashedName("sess\n")) && /^hold\.[0-9a-f]{32}\.json$/.test(hashedName("sess\r\n")),
  "an id with a trailing line break is hashed, never used as a file name");
ok(isHoldPhrase("I think the agent should stop pushing"), "a person earlier in the clause still latches");
ok(isHoldPhrase("the gate should stop refusing. also stop"), "a second, plain stop still latches");
ok(isHoldPhrase("You'd better stop pushing"), "a contracted person (you'd) still latches");
ok(isHoldPhrase("we’re going to stop deploying"), "a curly-apostrophe contraction (we’re) still latches");
ok(!isHoldPhrase("the hook should stop re-running checks"), "a hyphenated -ing verb is descriptive");
ok(!isHoldPhrase("make the gate stop re-running checks"), "a descriptive stop before a hyphenated -ing verb is skipped");
for (const p of ["stop re-running checks", "Great work. Stop re-running checks", "ok stop re-running checks",
  "please stop re-running checks", "claude, stop re-running checks", "you stop re-running checks",
  "please wait and stop pushing", "finish the build and stop pushing",
  "Make sure to stop the deploy", "remember to stop the deploy", "don't forget to stop the deploy",
  "be careful to stop the migration", "try to stop the push",
  "At this point stop pushing", "After this run stop pushing", "for now stop deploying",
  "with that done stop re-running checks",
  "Your next task is to stop the deploy", "Be certain to stop the deploy", "Use the kill switch to stop the deploy",
  "the plan is to stop the migration"]) {
  ok(isHoldPhrase(p), `an imperative stop before a hyphenated -ing verb latches: ${p}`);
}
ok(isResumePhrase("ok go ahead and continue"), "resume phrase");
// Local, reversible work WARNS under a hold; outward actions stay denied (2026-10-18).
eq(holdDecision("Edit", { file_path: "src/pages/Foo.tsx" }), "warn", "edit source warns under hold");
eq(holdDecision("Bash", { command: "git commit -m x" }), "warn", "commit warns under hold");
eq(holdDecision("Bash", { command: "git -C C:/x rebase origin/main" }), "warn", "local rebase warns under hold");
eq(holdDecision("Bash", { command: "npm run test" }), "allow", "tests stay plainly allowed");
// The autonomous-landing merge and global-option pushes were MISSED before
// (adversarial review 2026-10-18); a "stop" must hold them now.
for (const command of [
  "gh pr merge 951 --squash --match-head-commit 37222b56b0000000000000000000000000000000",
  "gh -R masonwells1/CRX_Manager_V1.0 pr merge 951 --squash",
  "git -C \"C:/CRX Manager/wt\" push origin HEAD",
  "git push origin HEAD",
  "git.exe push origin HEAD",
  "git commit -m x && git push",
  "gh pr create --fill",
  "gh api repos/o/r/pulls/1/merge -X PUT",
  "gh api repos/o/r/issues/1/comments -f body=hi",
  "git branch -D old",
  "rm -rf src",
  "vercel deploy --prod",
  // Luna, PR #956 round 1: long-form gh api fields and REST clients that write.
  "gh api repos/o/r/issues/1/comments --field body=hi",
  "gh api repos/o/r/issues/1/comments --raw-field body=hi",
  "gh api repos/o/r/issues/1/comments --input body.json",
  "curl -X POST -H \"Authorization: Bearer $GH_TOKEN\" --data '{\"body\":\"hi\"}' https://api.github.com/repos/o/r/issues/1/comments",
  "curl --json '{\"a\":1}' https://api.github.com/x",
  "Invoke-RestMethod -Method Post -Uri https://api.github.com/x -Body '{}'",
  // Luna, PR #956 round 2.
  "gh pr update-branch 951",
  "gh workflow run ci.yml",
  "gh secret set X --body y",
  "curl -T artifact.zip https://example.test/upload",
  "wget --method=PUT --body-file=x https://example.test/x",
  // Luna, PR #956 round 3: a shell database client.
  "psql \"$DATABASE_URL\" -f /tmp/erase-invoice.sql",
  // Codex connector, PR #956: gh global options before `api`.
  "gh --hostname github.com api repos/o/r/issues/1 -f title=x",
  "gh -R o/r api repos/o/r/issues/1 --field title=x",
  "gh api repos/o/r/issues/1/comments -fbody=x",
  "curl -dfoo https://example.test/x",
  "curl -Ffoo=bar https://example.test/x",
  "curl -Tfile https://example.test/x",
  "curl --form-string body=hi https://example.test/upload",
  "curl --data-ascii foo https://example.test/x",
  // CodeRabbit, PR #956: a backslash-newline continuation.
  "curl -X POST \\\n  --data '{}' https://api.github.com/x",
]) eq(holdDecision("Bash", { command }), "deny", `outward under hold: ${command}`);
eq(holdDecision("Bash", { command: "curl -s https://api.github.com/repos/o/r" }), "allow", "curl GET allowed under hold");
eq(holdDecision("Bash", { command: "gh pr view 951 --json state" }), "allow", "gh read allowed under hold");
eq(holdDecision("Bash", { command: "gh api repos/o/r/pulls/1" }), "allow", "gh api GET allowed under hold");
eq(holdDecision("mcp__supabase__execute_sql", { query: "select public.void_invoice(42)" }), "deny",
  "mutating RPC inside a SELECT is denied under hold");
eq(holdDecision("mcp__supabase__execute_sql", { query: "grant execute on function f() to anon" }), "deny",
  "GRANT is denied under hold");
eq(holdDecision("mcp__supabase__execute_sql", { query: "SELECT * INTO public.hold_probe FROM invoices" }), "deny",
  "SELECT INTO (creates a table) is denied under hold (CodeRabbit, PR #956)");
eq(holdDecision("mcp__supabase__execute_sql", { query: "SELECT ';' INTO public.hold_probe" }), "deny",
  "SELECT INTO behind a semicolon inside a string literal is denied under hold (CodeRabbit, PR #956)");
eq(holdDecision("mcp__supabase__execute_sql", { query: "select count(*) from invoices" }), "allow",
  "plain read SQL allowed under hold");
ok(isBuildActionUnderHold("mcp__supabase__apply_migration", {}), "apply blocked under hold");
// Every GitHub MCP write tool is held; GitHub reads are not (Codex connector, PR #956).
for (const tool of [
  "create_pull_request", "update_pull_request", "add_issue_comment", "pull_request_review_write",
  "issue_write", "update_pull_request_branch", "create_branch", "add_comment_to_pending_review",
  "add_reply_to_pull_request_comment", "sub_issue_write", "actions_run_trigger", "fork_repository",
  "create_repository", "merge_pull_request", "push_files",
  // Ends in `_read` but changes state (CodeRabbit, PR #975).
  "mark_all_notifications_read",
]) eq(holdDecision(`mcp__github__${tool}`, {}), "deny", `GitHub MCP write held: ${tool}`);
for (const tool of [
  "get_file_contents", "list_pull_requests", "search_code", "pull_request_read", "issue_read",
  "actions_get", "actions_list", "get_job_logs",
]) eq(holdDecision(`mcp__github__${tool}`, {}), "allow", `GitHub MCP read allowed under hold: ${tool}`);
// The file-bytes live-apply door is a Bash command, not an MCP tool, so the
// tool-name set never sees it. Codex (P1, PR #460) verified the predicate returned
// false for this exact invocation — a mid-session "stop" would NOT have paused a
// live migration through the new spelling.
ok(isBuildActionUnderHold("Bash", { command: "node scripts/apply-migration-file.mjs supabase/migrations/x.sql --confirm" }),
  "file-bytes live apply blocked under hold");
ok(isBuildActionUnderHold("Bash", { command: "node scripts/apply-migration-file.mjs x.sql" }),
  "even a dry run of the live-apply door pauses under hold");
ok(!isBuildActionUnderHold("Write", { file_path: ".claude/session-state/hold.json" }), "session-state write allowed");
ok(!isBuildActionUnderHold("Write", { file_path: "docs/SCOPE.md" }), "SCOPE.md allowed under hold");
ok(!isBuildActionUnderHold("Bash", { command: "npm run test" }), "tests allowed under hold");
ok(!isBuildActionUnderHold("Read", { file_path: "x" }), "read allowed under hold");

// ── hold-latch tool coverage (FIX 3, 2026-07-13) ─────────────────────────
// hold-latch's mutate-tool set must be a SUPERSET of autopilot's deny set —
// import the LIVE autopilot deny regex and assert every one of its alternatives
// is also caught by hold-latch, so the two lists can never silently drift apart.
{
  const denyAlts = DENY_TOOLNAME_RE.source.replace(/^\(|\)$/g, "").split("|");
  ok(denyAlts.length > 5, "sanity: parsed several deny alternatives out of autopilot-lib");
  for (const name of denyAlts) {
    ok(isBuildActionUnderHold(name, {}), `hold-latch covers autopilot deny-set tool: ${name}`);
  }
}
// hold-latch-only additions beyond autopilot's deny set (autopilot deliberately
// allows these unattended; a mid-session "stop" should still pause them).
ok(isBuildActionUnderHold("mcp__x__create_directory", {}), "create_directory blocked under hold");
ok(isBuildActionUnderHold("mcp__Desktop_Commander__kill_process", {}), "kill_process blocked under hold");
// Desktop Commander mutating tools specifically (2026-07-13 audit blind spot)
ok(isBuildActionUnderHold("mcp__Desktop_Commander__start_process", {}), "DC start_process blocked under hold");
ok(isBuildActionUnderHold("mcp__Desktop_Commander__interact_with_process", {}), "DC interact_with_process blocked under hold");
ok(isBuildActionUnderHold("mcp__Desktop_Commander__write_file", {}), "DC write_file blocked under hold");
ok(isBuildActionUnderHold("mcp__Desktop_Commander__edit_block", {}), "DC edit_block blocked under hold");
ok(isBuildActionUnderHold("mcp__Desktop_Commander__move_file", {}), "DC move_file blocked under hold");
ok(isBuildActionUnderHold("mcp__github__push_files", {}), "GitHub push_files blocked under hold");
ok(isBuildActionUnderHold("mcp__github__create_or_update_file", {}), "GitHub create_or_update_file blocked under hold");
ok(isBuildActionUnderHold("mcp__github__delete_file", {}), "GitHub delete_file blocked under hold");
ok(isBuildActionUnderHold("mcp__github__merge_pull_request", {}), "GitHub merge_pull_request blocked under hold");
ok(isBuildActionUnderHold("mcp__supabase__delete_branch", {}), "delete_branch blocked under hold");
ok(isBuildActionUnderHold("mcp__supabase__rebase_branch", {}), "rebase_branch blocked under hold");

// ── program name assembled at run time (Codex connector, PR #956) ─────────
for (const command of [
  "a=g; b=h; c=mer; d=ge; $a$b pr $c$d 951 --squash",
  "a=gi; b=t; c=pu; d=sh; $a$b $c$d origin HEAD:main",
  "export P=gh && $P pr merge 1",
  "$p = 'gh'; & $p pr merge 1",
  "$(printf g)h pr m$(printf er)ge 951 --squash",
  "$(printf g)it pu$(printf sh) origin HEAD:main",
  "`printf g`h pr m`printf er`ge 951 --squash",
  "`printf g`it pu`printf sh` origin HEAD:main",
]) ok(programAssembledAtRuntime(command), `assembled program name refused: ${command}`);
for (const command of [
  'for f in scripts/*.mjs; do node "$f" --check; done',
  'F=$(git rev-parse --show-toplevel); ls "$F"',
  'eval "$(fnm env)" && node -v',
  'bash -c "$CMD"',
  "i=$(($i+1)); git status",
]) ok(!programAssembledAtRuntime(command), `ordinary shape not refused: ${command}`);

// ── live-testdata ────────────────────────────────────────────────────────
ok(classifySql("INSERT INTO customers (name) VALUES ('Acme Farm')").block, "real customer insert blocked");
ok(!classifySql("INSERT INTO customers (name) VALUES ('[E2E] Farm Alpha')").block, "[E2E] insert allowed");
ok(classifySql("DELETE FROM invoices WHERE id = 5").block, "financial delete blocked");
ok(classifySql("UPDATE invoices SET status = 'voided' WHERE id = 5").block, "void real invoice blocked");
ok(!classifySql("SELECT * FROM invoices").block, "select allowed");
ok(!classifySql("INSERT INTO some_log_table (x) VALUES (1)").block, "non-business table allowed");
eq(classifySql("DELETE FROM customers WHERE id = 5").kind, "real-delete", "non-financial business delete blocked (PR #352)");
eq(classifySql("SELECT setval('invoice_number_seq', 1, false)").kind, "sequence-mutation", "setval via SELECT blocked (PR #352)");
eq(classifySql("SELECT cancel_order(42)").kind, "rpc-via-select", "mutating RPC via SELECT blocked (PR #352)");
ok(!classifySql("SELECT currval('invoice_number_seq')").block, "currval read allowed");
// Catalog reads refused as RPCs in real sessions (2026-10-04).
ok(!classifySql("SELECT pg_get_userbyid(p.proowner), pg_get_function_identity_arguments(p.oid) FROM pg_proc p").block,
  "catalog owner/signature reads allowed");
ok(!classifySql("SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t").block, "trigger definition read allowed");
ok(!classifySql("SELECT (aclexplode(p.proacl)).grantee FROM pg_proc p WHERE p.oid = to_regprocedure('public.get_balance(uuid)')").block,
  "ACL and regprocedure reads allowed");
ok(!classifySql("SELECT auth.uid()").block && !classifySql('SELECT "auth".uid()').block, "auth.uid() is a read");
ok(['SELECT "evil.auth".uid()', 'SELECT "x auth".uid()', "SELECT evil.auth.uid()", "SELECT uid()"]
  .every((sql) => classifySql(sql).block), "a uid() whose schema is not exactly auth is blocked (Luna round 3, PR #882)");
ok(classifySql("SELECT public.uid()").block && classifySql("SELECT evil.uid()").block,
  "a uid() outside the auth schema is not vouched for (Luna, PR #882)");
ok(['SELECT public.pg_get_triggerdef(t.oid) FROM pg_trigger t', 'SELECT "public".count(*) FROM orders',
  "SELECT evil.pg_get_triggerdef(1)", 'SELECT "evil".coalesce(1)', "SELECT public.pg_stat_reset()"]
  .every((sql) => classifySql(sql).block), "a built-in name in an application schema is an RPC (CodeRabbit, PR #882)");
ok(['SELECT pg_catalog.pg_get_triggerdef(t.oid) FROM pg_trigger t', 'SELECT "pg_catalog"."pg_get_triggerdef"(t.oid) FROM pg_trigger t',
  "SELECT count(*), coalesce(max(id), 0) FROM orders"]
  .every((sql) => !classifySql(sql).block), "an unqualified or pg_catalog built-in is still a read");
// Luna, PR #882: a quoted identifier keeps its case, so "AUTH", "PG_CATALOG" and
// "COUNT" are other objects; an unquoted one folds to lower case.
ok(['SELECT "AUTH".uid()', 'SELECT "Auth".uid()', 'SELECT auth."UID"()',
  'SELECT "PG_CATALOG".pg_get_triggerdef(1)', 'SELECT "COUNT"(*) FROM orders']
  .every((sql) => classifySql(sql).block), "a quoted name with capitals is not the vouched-for object");
ok(["SELECT x$auth.uid()", "SELECT x$pg_catalog.pg_get_triggerdef(1)", "SELECT my$count(1)", "SELECT my$public.count(1)"]
  .every((sql) => classifySql(sql).block), "a `$` inside an identifier makes it another schema or function (Luna, PR #882)");
ok(["SELECT evil./*x*/pg_get_triggerdef(1)", "SELECT evil.--x\npg_get_triggerdef(1)", "SELECT public/**/./**/count(1)",
  "SELECT cancel_order/**/(42)", "SELECT cancel_order --x\n(42)"]
  .every((sql) => classifySql(sql).block), "a comment cannot hide a schema or a call (Codex connector, PR #882)");
ok(!classifySql("SELECT count(*) FROM orders -- cancel_order(42) would be wrong here").block &&
  !classifySql("SELECT /* get rid of delete_all() */ count(*) FROM orders").block &&
  !classifySql("SELECT pg_catalog./**/pg_get_triggerdef(t.oid), '--' AS x, '/*' AS y FROM pg_trigger t").block,
  "comment prose is not a call, and comment-like text inside a string stays data");
ok(["SELECT evil.get_invoice(42)", 'SELECT "PUBLIC".get_invoice(42)', 'SELECT "GET_INVOICE"(42)', "SELECT x$public.list_orders(1)"]
  .every((sql) => classifySql(sql).block), "a read-named function outside public is not vouched for (Luna, PR #882)");
ok(["SELECT get_invoice(42)", "SELECT public.get_invoice(42)", 'SELECT "public".get_invoice(42)', "SELECT PUBLIC.list_orders(1)"]
  .every((sql) => !classifySql(sql).block), "a read-named function in public is still a read");
ok(['SELECT "éauth".uid()', "SELECT éauth.uid()", "SELECT éget_invoice(42)", "SELECT écount(1)",
  "SELECT xpg_catalogé.pg_get_triggerdef(1)", "SELECT é.pg_get_triggerdef(1)"]
  .every((sql) => classifySql(sql).block), "a non-ASCII character is part of a PostgreSQL identifier (Luna, PR #882)");
ok(["SELECT AUTH.uid()", "SELECT auth.UID()", "SELECT PG_CATALOG.pg_get_triggerdef(1)",
  'SELECT "count"(*) FROM orders', "SELECT COUNT(*) FROM orders"]
  .every((sql) => !classifySql(sql).block), "an unquoted name folds to lower case and is still a read");
ok(!classifySql("SELECT * FROM unnest(ARRAY[1,2]) AS t(x)").block, "a column-alias list is not a call");
ok(!classifySql("SELECT total::numeric(12,2) FROM orders").block, "a typmod cast is not a call");
eq(classifySql("SELECT * FROM unnest(ARRAY[1,2]) AS t(x), cancel_order(42)").kind, "rpc-via-select",
  "an RPC after an alias list is still caught");
ok(!classifySql("SELECT * FROM orders WHERE status = 'cancelled'").block, "plain filtered select allowed");
eq(classifySql("INSERT INTO orders (x) VALUES (1)").kind, "real-insert", "kind reported");

// ── live-testdata side-door closures (2026-07-04) ────────────────────────
ok(classifySql("CREATE OR REPLACE FUNCTION public.f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;").block, "raw CREATE FUNCTION blocked");
eq(classifySql("ALTER TABLE invoices ADD COLUMN x text;").kind, "raw-ddl", "raw ALTER TABLE blocked as raw-ddl");
ok(classifySql("DROP POLICY IF EXISTS p ON public.orders;").block, "raw DROP POLICY blocked");
ok(classifySql("GRANT EXECUTE ON FUNCTION public.f() TO anon;").block, "raw GRANT blocked");
ok(classifySql("REVOKE EXECUTE ON FUNCTION public.f() FROM anon;").block, "raw REVOKE blocked");
ok(!classifySql("BEGIN; CREATE TABLE t (id int); ROLLBACK;").block, "rolled-back smoke DDL allowed");
ok(classifySql("BEGIN; CREATE TABLE t (id int); COMMIT;").block, "committed DDL blocked");
ok(!classifySql("DO $$ BEGIN PERFORM 1; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;").block, "SMOKE_PASS_ROLLBACK force-rollback pattern allowed");
// Codex 2026-07-05 P1: textual rollback markers must NOT qualify — only structural ones
ok(classifySql("CREATE TABLE public.x(id int); SELECT 'SMOKE_PASS_ROLLBACK';").block, "string-literal SMOKE_PASS_ROLLBACK does not exempt DDL");
ok(classifySql("CREATE TABLE public.x(id int); SELECT 'please rollback later';").block, "the word rollback in a literal does not exempt DDL");
ok(classifySql("ALTER TABLE invoices ADD COLUMN x text; ROLLBACK;").block, "ROLLBACK without a BEGIN-first wrapper does not exempt DDL");
ok(!classifySql("BEGIN; ALTER TABLE invoices ADD COLUMN x text; SELECT 1; ROLLBACK;").block, "real BEGIN-first/ROLLBACK-last wrapper still allowed");
ok(!classifySql("INSERT INTO customers (name) VALUES ('[E2E] Grant Farms')").block, "[E2E] data mentioning 'Grant' not misread as DDL");
ok(!classifySql("CREATE TEMP TABLE scratch AS SELECT 1;").block, "temp table allowed");
ok(!classifySql("SELECT * FROM pg_proc WHERE prosrc LIKE '%create table%'").block, "select mentioning DDL text allowed");
eq(classifySql("TRUNCATE public.orders;").kind, "truncate", "truncate blocked");
eq(classifySql("UPDATE financial_audit_log SET description='x' WHERE id=1").kind, "audit-log-write", "audit log update blocked");
ok(classifySql("DELETE FROM financial_audit_log WHERE note LIKE '%[E2E]%'").block, "audit log delete blocked even with [E2E]");
eq(classifySql("UPDATE invoices SET total_cents = 100 WHERE id=1").kind, "financial-amount-update", "money column update blocked");
// FIX 5 (2026-07-13, "live-testdata UPDATE gap"): a plain UPDATE on a real
// (non-[E2E]) business table is now blocked too, matching INSERT's treatment —
// even when the SET clause never touches a money column. Before this fix, this
// exact statement was allowed (see the old test name below) — that was the gap.
eq(classifySql("UPDATE invoices SET notes = 'call back' WHERE total_cents = 500").kind, "real-update", "money col only in WHERE clause no longer exempts the UPDATE (generic real-update catch-all, FIX 5)");

// ── live-testdata UPDATE gap (FIX 5, 2026-07-13) ─────────────────────────
ok(classifySql("UPDATE customers SET phone = '555-0100' WHERE id = 1").block, "real customer UPDATE without [E2E] blocked");
eq(classifySql("UPDATE customers SET phone = '555-0100' WHERE id = 1").kind, "real-update", "kind reported for generic business-table UPDATE");
// 2026-10-25: this comment form used to be allowed on purpose. A comment says
// nothing about which rows the UPDATE touches, so customer 1 here is real.
eq(classifySql("UPDATE customers SET phone = '555-0100' WHERE id = 1 -- [E2E]").kind, "real-update", "[E2E] in a comment does not exempt an UPDATE");
ok(!classifySql("UPDATE customers SET phone = '555-0100' WHERE id = 1 AND name LIKE '[E2E]%'").block, "UPDATE narrowed to [E2E] rows allowed");
ok(!classifySql("UPDATE some_log_table SET x = 1 WHERE id = 1").block, "UPDATE on a non-business table allowed");
// Codex P1 2026-07-13: AP/prepay/inventory tables were missing from the lists.
ok(classifySql("UPDATE vendor_bills SET notes = 'x' WHERE id = 1").block, "raw UPDATE of vendor_bills (AP side) blocked");
ok(classifySql("UPDATE prepay_credits SET memo = 'x' WHERE id = 1").block, "raw UPDATE of prepay_credits blocked");
ok(classifySql("UPDATE inventory_transactions SET notes = 'x' WHERE id = 1").block, "raw UPDATE of inventory_transactions blocked");
// 2026-10-25: writing the marker INTO a real row only labels it; the WHERE decides the row.
eq(classifySql("UPDATE vendor_bills SET notes = '[E2E] test' WHERE id = 1").kind, "real-update", "[E2E] in the SET list does not exempt an UPDATE");
ok(!classifySql("UPDATE vendor_bills SET notes = 'x' WHERE notes LIKE '[E2E]%'").block, "vendor_bills UPDATE of [E2E] rows allowed");
ok(classifySql("DELETE FROM vendor_payments WHERE id = 1").block, "DELETE from vendor_payments (now financial) blocked");
// Codex P1 round 3: fully quoted schema qualification must not evade the classifier.
ok(classifySql('UPDATE "public"."customers" SET phone = \'555\' WHERE id = 1').block, 'UPDATE "public"."customers" (quoted qualification) blocked');
ok(classifySql('INSERT INTO "public"."invoices" (id) VALUES (1)').block, 'INSERT INTO "public"."invoices" (quoted qualification) blocked');
ok(classifySql('UPDATE public . "orders" SET notes = \'x\' WHERE id = 1').block, "spaced qualification still blocked");
// Codex P1 round 4: live stock tables were missing from the lists.
ok(classifySql("UPDATE inventory SET quantity = 0 WHERE id = 1").block, "raw UPDATE of inventory (live stock) blocked");
ok(classifySql("UPDATE inventory_holds SET quantity = 0 WHERE id = 1").block, "raw UPDATE of inventory_holds blocked");
ok(classifySql("DELETE FROM inventory_transactions WHERE id = 1").block, "DELETE from inventory_transactions blocked");
ok(!classifySql("SELECT * FROM customers WHERE id = 1").block, "SELECT still allowed (not an UPDATE)");
// More specific classifications still win over the generic catch-all:
eq(classifySql("UPDATE invoices SET status = 'voided' WHERE id = 5").kind, "financial-cancel", "cancel/void still classified specifically, not as generic real-update");
eq(classifySql("DELETE FROM invoices WHERE id = 5").kind, "financial-delete", "financial delete still classified specifically");

// ── [E2E] judged per write, from its own WHERE (2026-10-25, PR #1084 follow-up) ──
// An UPDATE/DELETE is fake only when a top-level AND-ed `<column> =|LIKE
// '…[E2E]…'` narrows it to marked rows; an INSERT only when its own text carries
// an '[E2E]' string value.
for (const sql of [
  "DELETE FROM customers WHERE name LIKE '[E2E]%'",
  "DELETE FROM invoices WHERE id = 7 AND notes = '[E2E]'",
  "DELETE FROM customers c WHERE c.name LIKE '[E2E]%' AND (c.id = 1 OR c.id = 2) RETURNING c.id",
  "INSERT INTO \"public\".\"customers\" (name) VALUES ('[E2E] quoted')",
  "DELETE FROM ONLY customers WHERE \"name\" LIKE '[E2E]%'",
  "UPDATE invoices SET status = 'voided', total_cents = 0 WHERE notes LIKE '[E2E]%'",
  "INSERT INTO customers (name) VALUES ('[E2E] a;b')",
  "INSERT INTO customers (name) VALUES ('[E2E] Z'); DELETE FROM customers WHERE name = '[E2E] Z'",
  "WITH d AS (DELETE FROM customers WHERE name LIKE '[E2E]%' RETURNING id) SELECT count(*) FROM d",
  "DO $$ DECLARE v uuid; BEGIN INSERT INTO customers (name) VALUES ('[E2E] X') RETURNING id INTO v; " +
    "RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;",
]) ok(!classifySql(sql).block, `[E2E]-targeted write allowed: ${sql.slice(0, 70)}`);
// Inside a DO body any name may be a PL/pgSQL variable (`v_note = '[E2E]'` is always
// true; a block label or a session-wide variable_conflict = use_variable can even
// capture `c.name`), so a DO-body UPDATE/DELETE is never exempt (Luna round 2).
for (const sql of [
  "DO $$ DECLARE v_note text := '[E2E]'; BEGIN DELETE FROM customers WHERE id = 7 AND v_note = '[E2E]'; END $$",
  "DO $$ BEGIN UPDATE customers SET phone = '1' WHERE id = 7 AND name LIKE '[E2E]%'; END $$",
  "DO $$ <<c>> DECLARE name text := '[E2E]'; BEGIN DELETE FROM customers AS c WHERE c.id = 7 AND c.name = '[E2E]'; END $$",
  // A non-ASCII dollar tag is still a DO body (PostgreSQL allows it).
  "DO $xé$ DECLARE v_note text := '[E2E]'; BEGIN DELETE FROM customers WHERE id = 7 AND v_note = '[E2E]'; END $xé$;",
]) ok(classifySql(sql).block, `DO-body update/delete refused: ${sql.slice(0, 70).replace(/\n/g, " ")}`);
// The dollar-quote scanner matches PostgreSQL's: a non-ASCII or long tag opens a
// string (so the `--` inside it is data, not a comment hiding the DELETE after it),
// and `a$x$` is one identifier, not a quote opening that swallows what follows.
eq(classifySql("SELECT $xé$--$xé$; DELETE FROM invoices WHERE id = 7").kind, "financial-delete", "a non-ASCII dollar tag is a string, not a comment");
eq(classifySql(`SELECT $${"t".repeat(80)}$--$${"t".repeat(80)}$; DELETE FROM invoices WHERE id = 7`).kind, "financial-delete",
  "a dollar tag longer than 64 characters is a string, not a comment");
// A tag glued to a letter or digit is ambiguous (`a$x$` is a name, `1$x$` a number
// then a quote), so it is refused before any stripping (automated security review).
for (const sql of [
  "SELECT 1 AS a$x$; DELETE FROM invoices WHERE id = 7; SELECT 1 AS b$x$",
  "SELECT 1$x$--$x$; DELETE FROM invoices WHERE id = 7",
  "DO$$ BEGIN DELETE FROM customers WHERE name LIKE '[E2E]%'; END $$",
  // Accepted false refusal: the check runs before quotes are read, so it also hits a literal.
  "DELETE FROM invoices WHERE notes = '[E2E] a$x$b'",
]) eq(classifySql(sql).kind, "ambiguous-dollar-quote", `glued dollar quote refused: ${sql.slice(0, 50)}`);
ok(!classifySql("SELECT my$count, x$auth FROM t").block, "a `$` inside a name with no closing `$` is fine");
for (const sql of [
  "COPY customers (name) FROM '/tmp/real.csv' WITH (FORMAT csv)",
  "COPY public.invoices FROM PROGRAM 'cat /tmp/x'",
  // A server file or program source is refused first by #1092's copy-program-or-file rule.
]) ok(["copy-from", "copy-program-or-file"].includes(classifySql(sql).kind), `COPY … FROM refused: ${sql.slice(0, 50)}`);
eq(classifySql("COPY customers (name) FROM STDIN").kind, "copy-from", "COPY … FROM STDIN still writes and is refused");
ok(!classifySql("COPY customers TO STDOUT").block, "COPY … TO is a read");
ok(classifySql("COPY (SELECT id FROM customers) TO STDOUT").kind !== "copy-from", "a FROM inside COPY's (query) is not COPY … FROM");
for (const [sql, kind] of [
  ["UPDATE invoices SET total_cents = 1 WHERE id = 7; -- [E2E]", "financial-amount-update"],
  ["INSERT INTO customers (name) VALUES ('Real') /* [E2E] */", "real-insert"],
  ["INSERT INTO customers (name) VALUES ('[E2E] a'); INSERT INTO customers (name) VALUES ('Real')", "real-insert"],
  ["INSERT INTO customers (id, name) VALUES (5, '[E2E] x') ON CONFLICT (id) DO UPDATE SET name = excluded.name", "real-insert"],
  ["UPDATE customers SET name = '[E2E] relabelled' WHERE id = 3", "real-update"],
  ["UPDATE ONLY customers SET phone = '1' WHERE id = 1", "real-update"],
  ["UPDATE customers SET phone = '1' FROM orders o WHERE customers.id = 7 AND o.notes LIKE '[E2E]%'", "real-update"],
  ["UPDATE invoices SET status = 'cancelled', notes = '[E2E]' WHERE id = 3", "financial-cancel"],
  ["DELETE FROM invoices WHERE id = 7 OR notes = '[E2E]'", "financial-delete"],
  ["DELETE FROM invoices WHERE notes NOT LIKE '[E2E]%'", "financial-delete"],
  ["DELETE FROM invoices WHERE NOT notes LIKE '[E2E]%'", "financial-delete"],
  ["DELETE FROM invoices WHERE id = 7 AND notes = '[E2E]' IS NOT TRUE", "financial-delete"],
  ["DELETE FROM invoices WHERE id = 7 AND '[E2E]' = '[E2E]'", "financial-delete"],
  ["DELETE FROM invoices WHERE id = 7 AND user = '[E2E]'", "financial-delete"],
  ["DELETE FROM invoices WHERE id = 7 AND (notes = '[E2E]')", "financial-delete"],
  ["DELETE FROM invoices WHERE id = 7 AND notes = '[E2E]' || ''", "financial-delete"],
  ["DELETE FROM invoices WHERE id BETWEEN 1 AND 10 AND notes = '[E2E]'", "financial-delete"],
  ["DELETE FROM invoices WHERE id IN (SELECT 7 FROM customers WHERE name LIKE '[E2E]%')", "financial-delete"],
  ["DELETE FROM invoices WHERE id = 7 AND EXISTS (SELECT 1 FROM customers WHERE name LIKE '[E2E]%')", "financial-delete"],
  ["DELETE FROM invoices USING customers c WHERE invoices.id = 7 AND c.name LIKE '[E2E]%'", "financial-delete"],
  ["WITH d AS (DELETE FROM invoices WHERE id = 7 RETURNING 1) SELECT * FROM customers WHERE name LIKE '[E2E]%'", "financial-delete"],
  ["DO $$ BEGIN DELETE FROM invoices WHERE id = 7 -- AND notes LIKE '[E2E]%'\n; END $$", "financial-delete"],
  ["DO $$ BEGIN EXECUTE 'DELETE FROM invoices WHERE notes LIKE ''[E2E]%'''; END $$", "dynamic-sql"],
  // Luna round 1: SQL assembled at run time, MERGE, Unicode-escaped names, mixed VALUES rows.
  ["DO $$ BEGIN EXECUTE 'UPDATE ' || 'customers SET phone = ''555-0100'' WHERE id = 1'; END $$;", "dynamic-sql"],
  ["MERGE INTO customers AS c USING (VALUES (1, 'Real')) AS s(id, name) ON c.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name", "real-merge"],
  // #1092's earlier rule (comments removed, dollar bodies included) refuses it first.
  ["UPDATE U&\"custome\\0072s\" SET phone = '555-0100' WHERE id = 1", "unicode-escaped-identifier"],
  ["INSERT INTO customers (name) VALUES ('[E2E] test'), ('Real Customer')", "real-insert"],
  ["INSERT INTO customers (name) VALUES (CASE WHEN false THEN '[E2E]' END)", "real-insert"],
  ["INSERT INTO customers (name) VALUES ('[E2E] x') UNION ALL VALUES ('Real')", "real-insert"],
  ["INSERT INTO customers DEFAULT VALUES", "real-insert"],
  ["DELETE FROM customers WHERE name LIKE '[E2E]%' AND \"returning\" = TRUE OR id = 7", "real-delete"],
  // Luna round 3: ILIKE also matches a real "[e2e] …" row; a backslash may end a
  // literal early when standard_conforming_strings is off.
  ["DELETE FROM customers WHERE name ILIKE '[E2E]%'", "real-delete"],
  ["DELETE FROM customers WHERE name = '[E2E]\\' AND id = ' OR true", "real-delete"],
  ["INSERT INTO customers (name) VALUES ('[E2E]\\'), ('Real')", "real-insert"],
  ["SELECT 1; DELETE FROM customers WHERE name = 'x'''; SELECT '[E2E]'", "real-delete"],
  ["DELETE FROM ONLY financial_audit_log WHERE id = 1", "audit-log-write"],
  ["INSERT INTO customers (name) VALUES ('Real') RETURNING '[E2E]'", "real-insert"],
  ["DO $$ BEGIN EXECUTE 'UPDATE customers SET phone = ''1'' WHERE name LIKE ''[E2E]%'''; END $$", "dynamic-sql"],
  // A string that CAN run as code still counts (2026-10-27): a plain-quoted DO body.
  ["DO 'BEGIN INSERT INTO customers (name) VALUES (''x''); END'", "dynamic-sql-write"],
]) eq(classifySql(sql).kind, kind, `not [E2E]-targeted, refused as ${kind}: ${sql.slice(0, 70).replace(/\n/g, " ")}`);
ok(!classifySql("SELECT proname FROM pg_proc WHERE prosrc ILIKE '%insert%invoices%'").block, "a catalog search with the words split is a read");
// Reads let through (Mason, 2026-10-26: looser guards). A string nothing can run
// is data, so write words or a function name inside it call nothing; read-only
// catalog functions and CTE/alias column lists are not RPCs.
for (const sql of [
  "SELECT 'UPDATE customers SET phone = ''1'' WHERE id = 1'",
  "SELECT proname FROM pg_proc WHERE prosrc ILIKE '%insert into invoices%'",
  "SELECT prosrc LIKE '%delete from invoices%' FROM pg_proc",
  "SELECT 'public.save_invoice(jsonb)'::regprocedure",
  "SELECT to_regprocedure('public.post_invoice(uuid)') IS NOT NULL",
  "SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p WHERE p.prosrc ILIKE '%insert into customers%'",
  "WITH target(sig, ok) AS (VALUES ('a', true)) SELECT * FROM target",
  "WITH RECURSIVE lexer (oid, pos) AS (SELECT 1, 1 UNION ALL SELECT oid, pos + 1 FROM lexer WHERE pos < 3) SELECT * FROM lexer",
  "WITH a AS (SELECT 1), cases(label) AS MATERIALIZED (SELECT 'x') SELECT * FROM cases",
  "SELECT * FROM (VALUES (1, 2)) v(a, b)",
  "SELECT * FROM unnest(ARRAY[1]) WITH ORDINALITY t(x, n)",
  "SELECT * FROM unnest(ARRAY['a']) m(name)",
  "SELECT acldefault('f', 10::oid), sha256('x'::bytea), trim_scale(1.50), pg_options_to_table(c.reloptions) FROM pg_class c",
]) ok(!classifySql(sql).block, `a read is allowed: ${sql.slice(0, 80)}`);
// Still refused: strings that can run, real calls the new rules sit next to, and
// the backslash reading of a literal's end.
for (const [sql, kind] of [
  ["SELECT query_to_xml('insert into customers (name) values (1) returning 1', true, true, '')", "rpc-via-select"],
  ["SELECT * FROM customers c, save_invoice('{}'::jsonb) AS (a int)", "rpc-via-select"],
  ["SELECT x FROM t WHERE (1=1) AND void_order(1)", "rpc-via-select"],
  ["WITH x AS (SELECT 1) SELECT post_invoice(1)", "rpc-via-select"],
  ["SELECT set_config('role', 'authenticated', true)", "rpc-via-select"],
  ["SELECT 1 FROM pg_proc WHERE prosrc LIKE '%x%' AND cancel_order(1) IS NULL", "rpc-via-select"],
  ["SELECT ' \\'' ; INSERT INTO customers (name) VALUES ('x'); --'", "rpc-via-select"],
  ["SELECT 1; DELETE FROM invoices WHERE notes = 'insert into customers'", "financial-delete"],
]) eq(classifySql(sql).kind, kind, `still refused as ${kind}: ${sql.slice(0, 80)}`);
// Codex App on #1093: with standard_conforming_strings off, `'\'` ends early, so the
// `--` and `/*` below are code and the write runs. Either reading refusing refuses.
for (const sql of [
  "SET standard_conforming_strings = off; DO $$ BEGIN PERFORM '\\'; --'; UPDATE customers SET phone = '555' WHERE id = 1; END; $$;",
  "SET standard_conforming_strings = off; SELECT '\\'; --'; DELETE FROM invoices WHERE id = 7;",
  "SET standard_conforming_strings = off; SELECT '\\' /*'; INSERT INTO customers (name) VALUES ('Real'); SELECT '*/';",
]) ok(classifySql(sql).block, `a write hidden under the backslash reading is refused: ${sql.slice(40, 100)}`);
ok(!classifySql("SELECT 'C:\\temp\\x' AS path").block, "a read with backslashes in a string stays allowed");
// INSERT … SELECT does not show its rows. (Its column list also reads as a call
// to the older RPC rule, so only the refusal is asserted, not which rule fired.)
for (const sql of [
  "INSERT INTO customers (name) SELECT 'Real' UNION ALL VALUES ('[E2E] x')",
  "INSERT INTO customers (name) VALUES ('[E2E] x') UNION ALL SELECT 'Real'",
  "INSERT INTO customers SELECT * FROM customers WHERE name LIKE '[E2E]%'",
]) ok(classifySql(sql).block, `INSERT … SELECT is not provably fake: ${sql.slice(0, 60)}`);
eq(classifySql("INSERT INTO customers SELECT * FROM customers WHERE name LIKE '[E2E]%'").kind, "real-insert",
  "INSERT … SELECT without a column list is refused as a real insert");
eq(classifySql("DO 'BEGIN UPDATE customers SET phone = ''1'' WHERE id = 1; END'", { realDataOk: true }).kind,
  "dynamic-sql-write", "REAL-DATA-OK does not relax a write spelled inside a string that runs");
eq(classifySql("DO $$ BEGIN EXECUTE 'UPDATE customers SET phone = ''1'' WHERE id = 1'; END $$", { realDataOk: true }).kind,
  "dynamic-sql", "REAL-DATA-OK does not relax EXECUTE in a DO block");
eq(classifySql("MERGE INTO customers c USING customers s ON false WHEN NOT MATCHED THEN INSERT (name) VALUES ('[E2E] x')", { realDataOk: true }).kind,
  "real-merge", "MERGE is refused even for [E2E] rows and with REAL-DATA-OK");
for (const sql of [
  "INSERT INTO customers (name, phone) VALUES ('[E2E] a', '1'), ('[E2E] b', '2') RETURNING id",
  "INSERT INTO customers AS c (name) OVERRIDING USER VALUE VALUES ('[E2E] a') ON CONFLICT DO NOTHING",
  "INSERT INTO customers (phone, name) VALUES (lower('X'), '[E2E] it''s')",
]) ok(!classifySql(sql).block, `every VALUES row marked: allowed (${sql.slice(0, 60)})`);
eq(classifySql("update customers ".repeat(20000)).kind, "unclassifiable-writes", "a flood of unterminated writes is refused, not timed out");
{
  // Linear, not quadratic: a literal packed with write keywords took 4 s before the dynamic-write rule.
  const t0 = Date.now();
  classifySql("SELECT '" + "update customers ".repeat(20000) + "'");
  classifySql("delete from customers ".repeat(80000));
  ok(Date.now() - t0 < 3000, `write-keyword floods classify quickly (${Date.now() - t0} ms)`);
}

// ── dollar-quoted machine content (2026-07-11) ───────────────────────────
// Function bodies re-emitted by a BEGIN;...;ROLLBACK; migration smoke are
// machine content — only top-level hand-written statements may classify.
eq(classifySql("INSERT INTO financial_audit_log (action) VALUES ('x')").kind, "audit-log-write", "bare audit-log insert still blocked");
ok(!classifySql("SELECT $function$ INSERT INTO financial_audit_log (action) VALUES ('x'); $function$::text").block, "audit-log insert inside $function$ body is machine content, allowed");
const moneyRpcSmoke = [
  "BEGIN;",
  "CREATE OR REPLACE FUNCTION public.record_vendor_payment(p_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$",
  "BEGIN",
  "  INSERT INTO financial_audit_log (action, details) VALUES ('vendor_payment', '{}');",
  "  UPDATE invoices SET status = 'voided', total_cents = 0 WHERE id = p_id;",
  "  DELETE FROM payments WHERE invoice_id = p_id;",
  "  RETURN '{}'::jsonb;",
  "END;",
  "$function$;",
  "ROLLBACK;",
].join("\n");
ok(!classifySql(moneyRpcSmoke).block, "BEGIN;<money-RPC re-emit>;ROLLBACK; smoke allowed");
eq(classifySql("CREATE OR REPLACE FUNCTION public.f() RETURNS void LANGUAGE sql AS $function$ INSERT INTO financial_audit_log (a) VALUES (1); $function$;").kind, "raw-ddl", "un-rolled-back re-emit still blocked, but as raw-ddl not audit-log-write");
// DO bodies EXECUTE immediately — stripping must not hide them.
eq(classifySql("DO $$ BEGIN INSERT INTO financial_audit_log (a) VALUES (1); END $$;").kind, "audit-log-write", "audit-log insert inside a DO body still blocked");
ok(!classifySql("DO $$ BEGIN PERFORM public.record_vendor_payment('00000000-0000-0000-0000-000000000000'); RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;").block, "DO-block smoke calling a money RPC still allowed");
// A $$ inside a plain string literal must not open a quote span that swallows real SQL.
// (Since 2026-10-25 a `$$` glued to a letter is refused before any stripping, so
// only the refusal is asserted; the spaced form below still reaches the audit rule.)
ok(classifySql("SELECT 'a$$b'; INSERT INTO financial_audit_log (a) VALUES (1); SELECT 'c$$d';").block, "$$ inside string literals cannot hide a real audit-log write");
eq(classifySql("SELECT 'a $$ b'; INSERT INTO financial_audit_log (a) VALUES (1); SELECT 'c $$ d';").kind, "audit-log-write", "a spaced $$ inside string literals cannot hide a real audit-log write");
// COMMIT inside a DO body can really commit — it must still disqualify a "rolled-back" batch.
ok(classifySql("BEGIN; CREATE TABLE t (id int); DO $$ BEGIN PERFORM 1; COMMIT; END $$; ROLLBACK;").block, "COMMIT inside a DO body still disqualifies the smoke wrapper");

// ── codex-push ───────────────────────────────────────────────────────────
ok(isGitPush("git push origin main"), "detects push");
ok(!isGitPush("git status"), "non-push");
// refspec bypass closures (2026-07-04)
ok(pushTargetsMain("git push origin HEAD:main", "feature/x"), "HEAD:main from feature branch targets main");
ok(pushTargetsMain("git push origin feature/x:main", "feature/x"), "feature:main targets main");
ok(pushTargetsMain("git push origin HEAD:refs/heads/main", "feature/x"), "refs/heads/main refspec targets main");
ok(pushTargetsMain("git push origin main", "feature/x"), "bare main refspec targets main from any branch");
ok(pushTargetsMain("git push", "main"), "plain push while on main targets main");
ok(pushTargetsMain("git push origin HEAD", "main"), "push HEAD while on main targets main");
ok(!pushTargetsMain("git push origin HEAD", "feature/x"), "push HEAD from feature branch does not target main");
ok(!pushTargetsMain("git push", "feature/x"), "plain push from feature branch does not target main");
ok(!pushTargetsMain("git push -u origin claude/some-branch", "claude/some-branch"), "feature branch push does not target main");
// Codex 2026-07-05 P1: the guard must diff/proof the ref actually pushed to main
eq(mainPushSource("git push origin release:main", "feature/x"), "release", "release:main resolves source ref release");
eq(mainPushSource("git push origin HEAD:main", "feature/x"), "HEAD", "HEAD:main resolves source HEAD");
eq(mainPushSource("git push origin main", "feature/x"), "main", "bare main refspec resolves local main");
eq(mainPushSource("git push", "main"), "HEAD", "plain push on main resolves HEAD");
eq(mainPushSource("git push origin :main", "x"), "DELETE", "push :main detected as branch deletion");
eq(mainPushSource("git push origin feature/x", "feature/x"), null, "feature push resolves null");
// git GLOBAL options between `git` and `push` must not bypass the gate (2026-07-10)
ok(isGitPush("git -C C:/CRX_Manager push origin main"), "git -C <dir> push detected");
ok(isGitPush('git -C "C:/My Repo" push origin main'), "git -C quoted dir push detected");
ok(isGitPush("git --git-dir=.git push origin main"), "git --git-dir push detected");
ok(isGitPush("git -c core.editor=true push origin main"), "git -c k=v push detected");
ok(!isGitPush("git -C C:/CRX_Manager status"), "git -C status is not a push");
eq(mainPushSource("git -C C:/CRX_Manager push origin main", "feature/x"), "main", "git -C push origin main targets main");
eq(mainPushSource("git -C C:/CRX_Manager push origin HEAD:main", "feature/x"), "HEAD", "git -C HEAD:main resolves HEAD");
eq(mainPushSource("git -C C:/CRX_Manager push origin feature/x", "feature/x"), null, "git -C feature push resolves null");
eq(riskyFiles(["src/App.tsx", "supabase/migrations/x.sql"]).length, 1, "migration is risky");
eq(riskyFiles(["src/App.tsx", "README.md"]).length, 0, "no risky files");
ok(riskyFiles(["supabase/functions/send-email/index.ts"]).length === 1, "edge fn is risky");
// FIX 4 (2026-07-13): single-choke-point files are risky by PATH too.
ok(riskyFiles(["src/lib/db.ts"]).length === 1, "src/lib/db.ts is risky");
ok(riskyFiles(["src/lib/sentry.ts"]).length === 1, "src/lib/sentry.ts is risky");
eq(riskyFiles(["src/lib/other.ts"]).length, 0, "an unrelated src/lib file is not risky by path");
// FIX 4: content-level risk check (fires even when no PATH pattern matches).
ok(contentIsRisky("+  const total_cents = a + b;"), "diff touching _cents flagged risky by content");
ok(contentIsRisky("+  await allocate_payment(x, y);"), "diff calling allocate_payment flagged risky by content");
ok(contentIsRisky("+  insert into financial_audit_log (...) values (...);"), "diff touching financial_audit_log flagged risky by content");
ok(contentIsRisky("+  apply_prepay(customer_id, amount);"), "diff calling apply_prepay flagged risky by content");
ok(!contentIsRisky("+  const label = 'hello world';"), "an ordinary diff is not flagged risky by content");
const good = {
  codex_ran: true,
  verdict: "clean",
  model: "gpt-6-sol",
  reasoning_effort: "high",
  head_sha: "abc",
  timestamp: new Date().toISOString(),
};
ok(proofValid(good, "abc", Date.now()), "valid proof");
ok(!proofValid(good, "different", Date.now()), "wrong HEAD → invalid");
ok(!proofValid({ ...good, codex_ran: false }, "abc", Date.now()), "codex_ran false → invalid");
ok(!proofValid({ ...good, timestamp: new Date(Date.now() - 25 * 60 * 60000).toISOString() }, "abc", Date.now()), "stale proof invalid");
ok(!proofValid({ ...good, verdict: "has-blockers" }, "abc", Date.now()), "non-clean verdict invalid");

// ── LIVE inert checks: guards emit NOTHING when their state files are absent ─
function runHook(file, payload) {
  return spawnSync(process.execPath, [path.join(__dirname, file)], { input: JSON.stringify(payload), encoding: "utf8" });
}
// hold-latch-guard: no hold.json → nothing (assumes none latched; safe if a real repo has one, so only assert exit 0)
let r = runHook("hold-latch-guard.mjs", { tool_name: "Edit", tool_input: { file_path: "src/x.tsx" } });
eq(r.status, 0, "hold-latch-guard exits 0");
// active-area-guard: no active-areas.json in a scratch payload → passthrough (nothing)
r = runHook("active-area-guard.mjs", { tool_name: "Bash", tool_input: { command: "ls" } });
eq(r.status, 0, "active-area-guard exits 0 on benign cmd");
eq(r.stdout.trim(), "", "active-area-guard silent on benign cmd");
// live-testdata-guard: a [E2E] insert → silent (allowed)
r = runHook("live-testdata-guard.mjs", { tool_name: "mcp__supabase__execute_sql", tool_input: { query: "INSERT INTO customers (name) VALUES ('[E2E] X')" } });
eq(r.status, 0, "live-testdata-guard exits 0");
eq(r.stdout.trim(), "", "live-testdata-guard silent on [E2E] insert");
// live-testdata-guard: a REAL insert → deny
r = runHook("live-testdata-guard.mjs", { tool_name: "mcp__supabase__execute_sql", tool_input: { query: "INSERT INTO customers (name) VALUES ('Real Farm')" } });
ok(r.stdout.includes("deny"), "live-testdata-guard denies real insert");
// live-testdata-guard: a REAL update on a business table (no [E2E]) → deny (FIX 5)
r = runHook("live-testdata-guard.mjs", { tool_name: "mcp__supabase__execute_sql", tool_input: { query: "UPDATE customers SET phone = '555-0100' WHERE id = 1" } });
ok(r.stdout.includes("deny"), "live-testdata-guard denies real business-table update (FIX 5)");
// REAL-DATA-OK (2026-10-23): a fresh marker relaxes ordinary writes only; a stale
// one is ignored; destructive rules never relax, even later in the same batch.
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "crx-realdata-"));
  const stateDir = path.join(proj, ".claude", "session-state");
  fs.mkdirSync(stateDir, { recursive: true });
  const marker = path.join(stateDir, "REAL-DATA-OK");
  // Every run must exit 0: an empty stdout from a crash must not pass as "allowed".
  const sql = (query) => {
    const res = spawnSync(process.execPath, [path.join(__dirname, "live-testdata-guard.mjs")], {
      input: JSON.stringify({ tool_name: "mcp__50e15046-cf2c-49da-b8df-ceef27768f63__execute_sql", tool_input: { query } }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
    });
    eq(res.status, 0, `live-testdata-guard exits 0 (${query.slice(0, 40)})`);
    return res.stdout;
  };
  ok(sql("INSERT INTO customers (name) VALUES ('Real Farm')").includes("deny"), "no marker: real insert denied (connector-prefixed tool name)");
  // The real leftover marker: no leading timestamp, freshly copied (new mtime) into a worktree.
  fs.writeFileSync(marker, "Mason OK 2026-10-19: read-only cost/margin role check\r\n");
  ok(sql("INSERT INTO customers (name) VALUES ('Real Farm')").includes("deny"), "legacy marker with a fresh mtime but no leading UTC time is ignored");
  ok(sql("TRUNCATE customers").includes("deny"), "legacy marker: TRUNCATE denied");
  const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(marker, `${hoursAgo(3)} Mason OK: smoke run\n`);
  ok(sql("INSERT INTO customers (name) VALUES ('Real Farm')").includes("deny"), "marker written 3 h ago is ignored even with a fresh mtime");
  fs.writeFileSync(marker, `${new Date(Date.now() + 60 * 60 * 1000).toISOString()} Mason OK\n`);
  ok(sql("INSERT INTO customers (name) VALUES ('Real Farm')").includes("deny"), "marker dated an hour in the future is ignored");
  fs.writeFileSync(marker, `\n${hoursAgo(0.1)} Mason OK\n`);
  ok(sql("INSERT INTO customers (name) VALUES ('Real Farm')").includes("deny"), "marker whose first line is blank is ignored");
  fs.writeFileSync(marker, `${hoursAgo(0.1)} Mason OK: real customer fix\n`);
  eq(sql("INSERT INTO customers (name) VALUES ('Real Farm')").trim(), "", "fresh marker: real insert allowed");
  eq(sql("UPDATE customers SET phone = '555-0100' WHERE id = 1").trim(), "", "fresh marker: real update allowed");
  ok(sql("SELECT save_customer('{}'::jsonb)").includes("deny"), "fresh marker: RPC call still denied");
  ok(sql("TRUNCATE customers").includes("deny"), "fresh marker: TRUNCATE still denied");
  ok(sql("DROP TABLE customers").includes("deny"), "fresh marker: DDL still denied");
  ok(sql("GRANT ALL ON customers TO anon").includes("deny"), "fresh marker: GRANT still denied");
  ok(sql("DELETE FROM customers WHERE id = 1").includes("deny"), "fresh marker: real delete still denied");
  ok(sql("DELETE FROM invoices WHERE id = 1").includes("deny"), "fresh marker: financial delete still denied");
  ok(sql("UPDATE invoices SET status = 'voided' WHERE id = 1").includes("deny"), "fresh marker: void still denied");
  ok(sql("UPDATE orders SET status = 'cancelled' WHERE id = 1").includes("deny"), "fresh marker: cancel still denied");
  ok(sql("SELECT setval('invoice_number_seq', 1)").includes("deny"), "fresh marker: sequence change still denied");
  ok(sql("INSERT INTO financial_audit_log (note) VALUES ('x')").includes("deny"), "fresh marker: audit-log write still denied");
  ok(sql("INSERT INTO customers (name) VALUES ('Real Farm'); DELETE FROM customers WHERE id = 2").includes("deny"),
    "fresh marker: a DELETE after an allowed insert in the same batch is still denied");
  {
    const res = spawnSync(process.execPath, [path.join(__dirname, "live-testdata-guard.mjs")], {
      input: "{not json", encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
    });
    eq(res.status, 0, "unreadable event: guard exits 0");
    ok(res.stdout.includes("deny"), "unreadable execute_sql event is denied");
  }
  for (const call of ["SELECT cancel_order(123)", "SELECT void_invoice(1)", "SELECT delete_invoices(ARRAY[1])",
    "SELECT public.batch_void('{}')", "SELECT reverse_write_off(5)", 'SELECT public."void_invoice"(1)',
    "SELECT public.destroy_customer(1)"]) {
    ok(sql(call).includes("deny"), `fresh marker: destructive RPC still denied (${call})`);
  }
  // [E2E] is judged per statement, and a comment never carries it (Luna round 2).
  fs.rmSync(marker);
  for (const query of [
    "DELETE FROM invoices WHERE id = 7; -- [E2E]",
    "DELETE FROM invoices WHERE id = 1 /* [E2E] */",
    "DELETE FROM customers WHERE name = '[E2E] X'; DELETE FROM customers WHERE id = 2",
    "UPDATE customers SET name = '[E2E] Y' WHERE id = 1; UPDATE orders SET status = 'cancelled' WHERE id = 3",
    // 2026-10-25: inserts/updates are judged per write too, and a delete needs the
    // marker in a predicate that narrows it to marked rows.
    "UPDATE invoices SET total_cents = 1 WHERE id = 7; -- [E2E]",
    "INSERT INTO customers (name) VALUES ('[E2E] A'); UPDATE customers SET phone = '1' WHERE id = 2",
    "DELETE FROM invoices WHERE id = 7 OR notes = '[E2E]'",
  ]) {
    ok(sql(query).includes("deny"), `no marker: [E2E] in a comment or another statement does not exempt a write (${query.slice(0, 50)})`);
  }
  eq(sql("DELETE FROM customers WHERE name LIKE '[E2E]%'").trim(), "", "no marker: [E2E] cleanup delete still allowed");
  eq(sql("INSERT INTO customers (name) VALUES ('[E2E] Z'); DELETE FROM customers WHERE name = '[E2E] Z'").trim(), "",
    "no marker: [E2E] insert then [E2E] delete allowed");
  // Rollback-only smoke batches (2026-10-25): PostgreSQL must undo the whole
  // batch, so RPCs, fixtures and audit-log writes inside it are allowed with no
  // marker; anything that could skip, swallow or split the rollback is not.
  const rb = (body) => `DO $smoke$ BEGIN ${body} RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $smoke$;`;
  const del = "DELETE FROM invoices WHERE id = 1;";
  for (const [label, query] of [
    ["DO block ending in the smoke raise", rb("PERFORM save_customer('{}'::jsonb); PERFORM set_config('request.jwt.claims', '{}', true);")],
    ["BEGIN ... ROLLBACK wrapper", "BEGIN; SELECT save_customer('{}'::jsonb); UPDATE invoices SET status = 'voided' WHERE id = 1; ROLLBACK;"],
    ["leading BEGIN, several DO blocks", `BEGIN; DO $a$ BEGIN PERFORM save_customer('{}'); END $a$; ${rb("DELETE FROM invoices WHERE id = 1;")}`],
    ["pg_temp helper then the DO block", `CREATE OR REPLACE FUNCTION pg_temp.h() RETURNS int LANGUAGE plpgsql AS $f$ BEGIN RETURN 1; END $f$; ${rb("PERFORM pg_temp.h();")}`],
    ["audit-log write inside the rollback", rb("INSERT INTO public.financial_audit_log (operation_type) VALUES ('x');")],
    ["nested trigger function with RETURN NEW", rb("EXECUTE $q$ CREATE FUNCTION pg_temp.t() RETURNS trigger LANGUAGE plpgsql AS $t$ BEGIN RETURN NEW; END $t$ $q$;")],
    ["temp table ON COMMIT DROP", rb("CREATE TEMP TABLE x (a int) ON COMMIT DROP; PERFORM save_customer('{}');")],
    ["inner block with its own handler", rb(`BEGIN ${del} EXCEPTION WHEN OTHERS THEN NULL; END; IF true THEN NULL; END IF;`)],
    // Sol on #1092: EXECUTE must run text the guard can read. Literal forms the chains use:
    ["EXECUTE of a plain literal, INTO and USING", `DO $smoke$ DECLARE v int; BEGIN ${del} EXECUTE 'SET LOCAL ROLE authenticated'; EXECUTE 'SELECT 1' INTO STRICT v; EXECUTE 'SELECT $1' INTO v USING 2; EXECUTE 'RESET ROLE'; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $smoke$;`],
    ["'EXECUTE' as a privilege-name string", rb(`${del} IF has_function_privilege('anon', 'public.f()', 'EXECUTE') THEN NULL; END IF;`)],
    ["CREATE TRIGGER … EXECUTE FUNCTION in executed text", rb(`${del} EXECUTE 'CREATE TRIGGER t BEFORE INSERT ON public.activity_feed FOR EACH ROW EXECUTE FUNCTION public.f()';`)],
    ["EXECUTE of a dollar-quoted pg_temp function", rb(`${del} EXECUTE $sql$ CREATE FUNCTION pg_temp.g() RETURNS int LANGUAGE sql AS $b$ SELECT 1 $b$ $sql$;`)],
    // Real CASE forms still count once output aliases stop pairing across statements (Codex App, ad4206786).
    ["CASE statement, nested CASE expressions, CASE after THEN", rb(`${del} CASE 1 WHEN 1 THEN PERFORM CASE WHEN true THEN CASE WHEN false THEN 1 ELSE 2 END END; ELSE NULL; END CASE; IF true THEN CASE WHEN true THEN NULL; END CASE; END IF;`)],
  ]) {
    eq(sql(query).trim(), "", `rollback-only smoke allowed: ${label}`);
  }
  // The payload is a real DELETE, which the guard refuses inside a DO body unless
  // the batch is rollback-only. (PERFORM fn() inside a DO body is not detected as
  // an RPC call at all; that pre-existing gap is tracked separately.)
  for (const [label, query] of [
    ["conditional raise", `DO $$ BEGIN ${del} IF false THEN RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END IF; END $$;`],
    ["RETURN before the raise", rb(`${del} RETURN;`)],
    ["RETURN inside IF", rb(`${del} IF true THEN RETURN; END IF;`)],
    ["raise swallowed by an outer handler", `DO $$ BEGIN ${del} RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; EXCEPTION WHEN OTHERS THEN NULL; END $$;`],
    ["raise only inside the outer handler (security review)", `DO $$ BEGIN ${del} EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["raise only inside the outer handler, after a CASE", `DO $$ BEGIN ${del} PERFORM CASE WHEN true THEN 1 END; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["labeled outer block skipped with EXIT", `DO $$ <<b>> BEGIN ${del} EXIT b; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["COMMIT inside the DO block", rb(`${del} COMMIT;`)],
    ["CALL of a procedure", rb(`CALL some_proc(); ${del}`)],
    ["write before the DO block, no BEGIN", `SELECT save_customer('{}'); ${rb("")}`],
    ["COMMIT mid-batch", "BEGIN; SELECT save_customer('{}'); COMMIT; BEGIN; SELECT 1; ROLLBACK;"],
    ["END (commit) mid-batch", `BEGIN; SELECT save_customer('{}'); END; ${rb("")}`],
    ["dblink inside a wrapper", "BEGIN; SELECT dblink_exec('x', 'delete from invoices'); ROLLBACK;"],
    ["raise only in a string", "SELECT 'RAISE EXCEPTION ''SMOKE_PASS_ROLLBACK''; END'; SELECT save_customer('{}');"],
    ["raise only in a comment", `DO $$ BEGIN ${del} -- RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END\nEND $$;`],
    ["quote inside a nested body hides a RETURN", rb(`EXECUTE $f$ it's $f$; RETURN; ${del} PERFORM 'x';`)],
    ["$tag$ inside a string hides a RETURN", rb(`PERFORM 'a$x$'; RETURN; ${del} PERFORM 'b$x$';`)],
    ["TRUNCATE inside a wrapper", "BEGIN; TRUNCATE customers; ROLLBACK;"],
    // From the #1093 session (2026-10-25): END is COMMIT, as are COMMIT AND CHAIN and a second BEGIN's split.
    ["END (commit) before the final ROLLBACK", "BEGIN; DROP TABLE invoices; END; ROLLBACK;"],
    ["END before ROLLBACK around a delete", `BEGIN; ${del} END; ROLLBACK;`],
    ["COMMIT AND CHAIN inside a wrapper", `BEGIN; ${del} COMMIT AND CHAIN; ROLLBACK;`],
    ["second BEGIN inside a wrapper", `BEGIN; ${del} BEGIN; ROLLBACK;`],
    // Security review (2026-10-25): a variable named raise or a quoted "end" must not hide an outer handler.
    ["variable named raise hides the outer handler", `DO $$ DECLARE raise int; BEGIN ${del} PERFORM raise; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["quoted \"end\" shifts the block count", `DO $$ BEGIN ${del} PERFORM "end"; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    // Luna round 1 on #1092.
    ["quoted \"raise\" before the outer handler", `DO $$ BEGIN ${del} PERFORM t."raise" FROM (VALUES (1)) AS t("raise"); EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["extension installed, then reached by dynamic SQL", `BEGIN; CREATE EXTENSION dblink; ${rb(`EXECUTE 'SELECT dblink_' || 'exec(1)'; ${del}`)}`],
    ["session advisory lock survives the rollback", "BEGIN; SELECT pg_advisory_lock(42); ROLLBACK;"],
    ["another backend terminated", "BEGIN; SELECT pg_terminate_backend(123); ROLLBACK;"],
    // Luna round 2 on #1092.
    ["TRUNCATE inside a DO body", rb("TRUNCATE customers;")],
    ["session advisory locks released", "BEGIN; SELECT pg_advisory_unlock_all(); ROLLBACK;"],
    ["non-transactional logical message", "BEGIN; SELECT pg_logical_emit_message(false, 'x', 'y'); ROLLBACK;"],
    ["COPY FROM PROGRAM", "BEGIN; CREATE TEMP TABLE x(a text); COPY x FROM PROGRAM 'touch /tmp/m'; ROLLBACK;"],
    ["earlier DO block with a COMMIT, no BEGIN", `DO $a$ BEGIN ${del} COMMIT; END $a$; ${rb("")}`],
    ["earlier plain write, no BEGIN", `${del} ${rb("")}`],
    // Codex App on #1092: quoted or commented function names.
    ["quoted setval inside a wrapper", "BEGIN; SELECT pg_catalog.\"setval\"('public.invoice_number_seq', 1); ROLLBACK;"],
    ["setval with a comment before the bracket", "BEGIN; SELECT setval/**/('public.invoice_number_seq', 1); ROLLBACK;"],
    ["quoted pg_terminate_backend", "BEGIN; SELECT \"pg_terminate_backend\"(123); ROLLBACK;"],
    ["quoted nextval inside a smoke DO block", rb("PERFORM \"nextval\"('invoice_number_seq');")],
    ["smoke raise only inside a dollar-quoted string (Codex App)", `DO $do$ BEGIN ${del} PERFORM $msg$raise exception 'SMOKE_PASS_ROLLBACK'$msg$; END $do$;`],
    ["qualified columns named begin/end hide the outer handler (Codex App)", `DO $$ BEGIN ${del} PERFORM t.begin FROM (VALUES (1)) AS t("begin"); EXCEPTION WHEN OTHERS THEN PERFORM t.end FROM (VALUES (1)) AS t("end"); RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["CASE expression naming begin plus a labeled block (Codex App)", `DO $$ BEGIN ${del} PERFORM CASE WHEN true THEN begin ELSE 0 END FROM (VALUES(1)) AS t("begin"); EXCEPTION WHEN OTHERS THEN <<b>> BEGIN NULL; END; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["CASE expression naming begin, no label", `DO $$ BEGIN ${del} PERFORM CASE WHEN true THEN begin ELSE 0 END FROM (VALUES(1)) AS t("begin"); EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["output aliases case/end hiding an outer handler (Codex App, ad4206786)", `DO $$ BEGIN DELETE FROM customers; PERFORM 1 AS case; EXCEPTION WHEN OTHERS THEN PERFORM 1 AS end; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["bare output labels case/end hiding an outer handler", `DO $$ BEGIN ${del} PERFORM 1 case; EXCEPTION WHEN OTHERS THEN PERFORM 1 end; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["alias case closed by a later END CASE", `DO $$ BEGIN ${del} PERFORM 1 AS case; EXCEPTION WHEN OTHERS THEN NULL; END CASE; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["qualified keyword with spaces around the dot (Codex App)",`DO $$ BEGIN ${del} PERFORM t . case FROM (VALUES (1)) AS t("case"); EXCEPTION WHEN OTHERS THEN BEGIN NULL; END; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["schema named begin", `DO $$ BEGIN ${del} PERFORM begin.f(); EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["identifier with a $ that looks like a keyword (Codex App)", `DO $$ BEGIN ${del} PERFORM case$x FROM (VALUES (1)) AS t("case$x"); EXCEPTION WHEN OTHERS THEN BEGIN NULL; END; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["identifier ending in $x$ hides a RETURN", rb(`PERFORM a$x$; RETURN; ${del} PERFORM b$x$;`)],
    ["non-ASCII identifier ending in $x$ hides a RETURN (Codex App)", `DO $$ DECLARE "é$x$" integer := 1; BEGIN ${del} PERFORM é$x$; RETURN; PERFORM é$x$; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["E'' string continued on the next line hides a RETURN (Codex App)", `DO $$ BEGIN ${del} PERFORM E'a'\n'\\''; RETURN; PERFORM E'a'\n'\\''; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["non-ASCII dollar-quote tag hides a RETURN (Codex App)", `DO $$ BEGIN ${del} PERFORM $é$'$é$; RETURN; PERFORM $é$'$é$; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["dollar-quote tag longer than 66 characters hides a RETURN (Codex App)", (() => { const t = `$${"a".repeat(80)}$`; return `DO $$ BEGIN ${del} PERFORM ${t}'${t}; RETURN; PERFORM ${t}'${t}; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`; })()],
    ["COPY FROM PROGRAM after 5000 characters of column list (Codex App)", `BEGIN; COPY customers (${Array.from({ length: 600 }, (_, k) => `c${k}`).join(", ")}) FROM PROGRAM 'touch /tmp/m'; ROLLBACK;`],
    ["COPY TO a dollar-quoted file name (Codex App)", rb(`${del} COPY (SELECT 1) TO $f$/tmp/smoke.txt$f$;`)],
    ["COPY TO a U&'' file name (allow-list)", rb(`${del} COPY (SELECT 1) TO U&'/tmp/smoke.txt';`)],
    // Standard reading: one string "\'; RETURN; PERFORM ". With
    // standard_conforming_strings off: '\'' is a string, then RETURN runs.
    ["standard_conforming_strings off, then backslash quotes hide a RETURN (Codex App)", `DO $a$ BEGIN PERFORM set_config('standard_conforming_strings', 'off', false); END $a$; DO $$ BEGIN ${del} PERFORM '\\''; RETURN; PERFORM '\\''; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["'to stdout' only inside the copied query's literal (Codex App)", rb(`${del} COPY (SELECT 'to stdout') TO PROGRAM 'touch /tmp/smoke.txt';`)],
    ["\"to stdout\" only as a quoted identifier", rb(`${del} COPY (SELECT 1 AS "to stdout") TO PROGRAM 'touch /tmp/smoke.txt';`)],
    ["source table named stdin is not COPY's own FROM STDIN (Codex App)", rb(`CREATE TEMP TABLE stdin(x int); ${del} COPY (SELECT * FROM stdin) TO PROGRAM 'touch /tmp/smoke.txt';`)],
    ["replication-origin advance (Codex App)", "BEGIN; SELECT pg_replication_origin_advance('subscription_origin', '0/FFFFFFFF'); ROLLBACK;"],
    ["Unicode-escaped setval name (Codex App)", rb(`DELETE FROM customers WHERE false; PERFORM pg_catalog.U&"set\\0076al"('public.invoice_number_seq', 1);`)],
    ["setval inside a supplied pg_temp function (Codex App)", "BEGIN; CREATE FUNCTION pg_temp.reset_seq() RETURNS bigint LANGUAGE sql AS $f$ SELECT setval('public.invoice_number_seq', 1) $f$; SELECT pg_temp.reset_seq(); ROLLBACK;"],
    ["U&\" setval inside a supplied pg_temp function (Codex App)", "BEGIN; CREATE FUNCTION pg_temp.reset_seq() RETURNS bigint LANGUAGE sql AS $f$ SELECT pg_catalog.U&\"set\\0076al\"('public.invoice_number_seq', 1) $f$; SELECT pg_temp.reset_seq(); ROLLBACK;"],
    ["E'' function body spelling setval", String.raw`BEGIN; CREATE FUNCTION pg_temp.r() RETURNS bigint LANGUAGE sql AS E'SELECT set\x76al(''public.invoice_number_seq'', 1)'; SELECT pg_temp.r(); ROLLBACK;`],
    ["U&'' function body spelling setval", String.raw`BEGIN; CREATE FUNCTION pg_temp.r() RETURNS bigint LANGUAGE sql AS U&'SELECT set\0076al(''public.invoice_number_seq'', 1)'; SELECT pg_temp.r(); ROLLBACK;`],
    ["plain function body with a backslash escape", String.raw`BEGIN; SET standard_conforming_strings = off; CREATE FUNCTION pg_temp.r() RETURNS bigint LANGUAGE sql AS 'SELECT set\166al(''public.invoice_number_seq'', 1)'; SELECT pg_temp.r(); ROLLBACK;`],
    ["commented setval in a single-quoted function body (Codex App)", "BEGIN; CREATE FUNCTION pg_temp.reset_seq() RETURNS bigint LANGUAGE sql AS 'SELECT setval/**/(''public.invoice_number_seq'', 1)'; SELECT pg_temp.reset_seq(); ROLLBACK;"],
    ["single-quoted DO body (Codex App)", "BEGIN; DELETE FROM customers WHERE false; DO 'BEGIN PERFORM setval/**/(''public.invoice_number_seq'', 1); END'; ROLLBACK;"],
    ["single-quoted DO LANGUAGE body", "BEGIN; DELETE FROM customers WHERE false; DO LANGUAGE plpgsql 'BEGIN PERFORM setval/**/(''public.invoice_number_seq'', 1); END'; ROLLBACK;"],
    ["consuming logical-slot read (Codex App)", "BEGIN; SELECT * FROM pg_logical_slot_get_changes('existing_slot', NULL, NULL); ROLLBACK;"],
    // Luna round 3 on #1092.
    ["EXECUTE 'TRUNCATE …' in a DO block", "DO $$ BEGIN EXECUTE 'TRUNCATE TABLE customers'; END $$;"],
    ["COPY FROM an E'' file name", "COPY customers FROM E'/tmp/customers.csv';"],
    ["native-language temp function", `CREATE FUNCTION pg_temp.f() RETURNS void LANGUAGE c AS 'x', 'y'; ${rb("PERFORM pg_temp.f();")}`],
    ["statistics reset inside a wrapper", "BEGIN; SELECT pg_stat_reset(); ROLLBACK;"],
    ["setval inside a wrapper", "BEGIN; SELECT setval('invoice_number_seq', 1); ROLLBACK;"],
    // Sol on #1092 (BLOCKERS on c52cc3ce5): SQL assembled at run time hides any name.
    ["setval assembled with || (Sol)", "BEGIN; DELETE FROM invoices; DO $$ BEGIN EXECUTE 'SELECT set' || 'val(''public.invoice_number_seq'', 1)'; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;"],
    ["EXECUTE format('%s')", rb(`${del} EXECUTE format('SELECT %s(''public.invoice_number_seq'', 1)', 'setval');`)],
    ["EXECUTE of an unconstrained variable", `DO $$ DECLARE v text := 'SELECT set' || 'val(1)'; BEGIN ${del} EXECUTE v; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["EXECUTE E'' with a hex escape", rb(String.raw`${del} EXECUTE E'SELECT set\x76al(''public.invoice_number_seq'', 1)';`)],
    ["EXECUTE of a literal holding a comment", rb(`${del} EXECUTE 'SELECT setval/**/(''public.invoice_number_seq'', 1)';`)],
    ["EXECUTE of a literal holding --", rb(`${del} EXECUTE 'SELECT 1 --';`)],
    ["EXECUTE ( … )", rb(`${del} EXECUTE ('SELECT set' || 'val(1)');`)],
    ["nested DO inside executed text assembles setval", rb(`${del} EXECUTE 'DO $x$ BEGIN EXECUTE ''SELECT set'' || ''val(1)''; END $x$';`)],
    ["pg_temp function body assembles setval", "BEGIN; DELETE FROM invoices; CREATE FUNCTION pg_temp.f() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN EXECUTE 'SELECT set' || 'val(1)'; END $f$; SELECT pg_temp.f(); ROLLBACK;"],
    ["pg_temp function runs its text parameter", "BEGIN; DELETE FROM invoices; CREATE FUNCTION pg_temp.f(v_sql text) RETURNS void LANGUAGE plpgsql AS $f$ BEGIN EXECUTE v_sql; END $f$; SELECT pg_temp.f('SELECT set' || 'val(1)'); ROLLBACK;"],
    ["query_to_xml runs assembled text", `BEGIN; ${del} SELECT query_to_xml('SELECT set' || 'val(1)', true, false, ''); ROLLBACK;`],
    ["ts_stat runs assembled text", `BEGIN; ${del} SELECT * FROM ts_stat('SELECT set' || 'val(1)'); ROLLBACK;`],
    ["loop variable reassigned", `DO $$ DECLARE v_sql text; BEGIN ${del} FOREACH v_sql IN ARRAY ARRAY['SELECT 1'] LOOP v_sql := 'SELECT set' || 'val(1)'; EXECUTE v_sql; END LOOP; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["loop variable filled by SELECT INTO", `DO $$ DECLARE v_sql text; BEGIN ${del} SELECT 'SELECT set' || 'val(1)' INTO v_sql; EXECUTE v_sql; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["list element assembled with ||", `DO $$ DECLARE v_sql text; BEGIN ${del} FOREACH v_sql IN ARRAY ARRAY['SELECT set' || 'val(1)'] LOOP EXECUTE v_sql; END LOOP; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["list element format('%I')", `DO $$ DECLARE v_sql text; BEGIN ${del} FOREACH v_sql IN ARRAY ARRAY[format('SELECT %I(1)', 'setval')] LOOP EXECUTE v_sql; END LOOP; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["list element format('DO %L')", `DO $$ DECLARE v_sql text; BEGIN ${del} FOREACH v_sql IN ARRAY ARRAY[format('DO %L', 'BEGIN NULL; END')] LOOP EXECUTE v_sql; END LOOP; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["loop variable shadowed in an inner block", `DO $$ DECLARE v_sql text; BEGIN ${del} FOREACH v_sql IN ARRAY ARRAY['SELECT 1'] LOOP DECLARE v_sql text := 'x'; BEGIN EXECUTE v_sql; END; END LOOP; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["constant list appended to", `DO $$ DECLARE v_list text[] := ARRAY['SELECT 1']; v_sql text; BEGIN ${del} v_list := v_list || ('SELECT set' || 'val(1)'); FOREACH v_sql IN ARRAY v_list LOOP EXECUTE v_sql; END LOOP; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["variable named function run with USING", `DO $$ DECLARE function text := 'SELECT set' || 'val(1)'; BEGIN ${del} EXECUTE function USING (1); RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["format() shadowed by a function the batch creates", `BEGIN; CREATE FUNCTION public.format(text, text) RETURNS text LANGUAGE sql AS $f$ SELECT 'SELECT set' || 'val(1)' $f$; SET LOCAL search_path = public, pg_catalog; ${rb(`${del}`).replace("BEGIN ", "DECLARE v_sql text; BEGIN FOREACH v_sql IN ARRAY ARRAY[format('SELECT 1', 'x')] LOOP EXECUTE v_sql; END LOOP; ")}`],
    // Luna round 2 on the dynamic-SQL fix.
    ["COPY TO PROGRAM inside an executed literal", `BEGIN; ${del} DO $$ BEGIN EXECUTE 'COPY (SELECT 1) TO PROGRAM ''touch /tmp/x'''; END $$; ROLLBACK;`],
    ["plperl temp function builds SQL without EXECUTE", `BEGIN; ${del} CREATE FUNCTION pg_temp.f() RETURNS void LANGUAGE plperl AS $p$ my $fn = "pg_advisory_" . "lock"; spi_exec_query("SELECT $fn(42)"); $p$; SELECT pg_temp.f(); ROLLBACK;`],
    ["quoted language name", `BEGIN; ${del} CREATE FUNCTION pg_temp.f() RETURNS void LANGUAGE "plperl" AS $p$ return; $p$; ROLLBACK;`],
    ["backend memory-context dump", `BEGIN; ${del} SELECT pg_log_backend_memory_contexts(pg_backend_pid()); ROLLBACK;`],
    ["log rotation", `BEGIN; ${del} SELECT pg_rotate_logfile(); ROLLBACK;`],
    // Sol on 5f2e2ccb0: a rollback neither unreads a returned server file nor restores a deleted one.
    ["server-file read (Sol)", `BEGIN; ${del} SELECT pg_read_file('/etc/passwd'); ROLLBACK;`],
    ["server-file delete (Sol)", `BEGIN; ${del} SELECT pg_file_unlink('/tmp/example'); ROLLBACK;`],
    ["binary server-file read", rb(`${del} PERFORM pg_read_binary_file('/tmp/x');`)],
    ["server directory listing", `BEGIN; ${del} SELECT pg_ls_dir('.'); ROLLBACK;`],
    ["server file metadata", `BEGIN; ${del} SELECT pg_stat_file('postgresql.conf'); ROLLBACK;`],
    ["CHECKPOINT", `BEGIN; ${del} CHECKPOINT; ROLLBACK;`],
    ["http extension call", `BEGIN; ${del} SELECT http(('GET', 'https://example.com', NULL, NULL, NULL)::http_request); ROLLBACK;`],
    ["standby snapshot WAL record (Luna round 3)", `BEGIN; ${del} SELECT pg_log_standby_snapshot(); ROLLBACK;`],
    ["operator backed by setval (Codex App, d5ab5782d)", "BEGIN; CREATE OPERATOR public.=== (LEFTARG = regclass, RIGHTARG = bigint, FUNCTION = pg_catalog.setval); SELECT 'public.invoice_number_seq'::regclass OPERATOR(public.===) 1::bigint; ROLLBACK;"],
    ["operator built in a DO body", rb(`${del} CREATE OPERATOR pg_temp.=== (LEFTARG = regclass, RIGHTARG = bigint, PROCEDURE = setval);`)],
    ["operator built in an executed literal", rb(`${del} EXECUTE $q$CREATE OR REPLACE OPERATOR === (LEFTARG = regclass, RIGHTARG = bigint, FUNCTION = setval)$q$;`)],
    ["aggregate with a final function", `BEGIN; CREATE AGGREGATE pg_temp.a(regclass) (SFUNC = pg_catalog.int8inc_any, STYPE = regclass, FINALFUNC = nextval); ROLLBACK;`],
    ["range type with a canonical function", `BEGIN; CREATE TYPE pg_temp.r AS RANGE (SUBTYPE = int8, CANONICAL = f); ROLLBACK;`],
    ["alter operator restrict function", `BEGIN; ALTER OPERATOR === (regclass, bigint) SET (RESTRICT = f); ROLLBACK;`],
    ["conversion with a function", `BEGIN; CREATE DEFAULT CONVERSION c FOR 'UTF8' TO 'LATIN1' FROM f; ROLLBACK;`],
    ["text search parser", `BEGIN; CREATE TEXT SEARCH PARSER p (START = f, GETTOKEN = f, END = f, LEXTYPES = f); ROLLBACK;`],
    ["dollar quotes nested 4096 deep inside an executed literal (Luna round 3)", rb(`${del} EXECUTE 'SELECT ${Array.from({ length: 4096 }, (_, k) => `$t${k}$`).join("")}x${Array.from({ length: 4096 }, (_, k) => `$t${4095 - k}$`).join("")}';`)],
    ["LOAD a library", `BEGIN; ${del} LOAD '$libdir/auto_explain'; ROLLBACK;`],
    ["PREPARE outlives the rollback", `BEGIN; ${del} PREPARE p AS DELETE FROM invoices; ROLLBACK;`],
    ["PREPARE inside an executed literal", rb(`${del} EXECUTE 'PREPARE p AS DELETE FROM invoices';`)],
    ["dollar quotes nested past the cap (Luna)", rb(`${del} PERFORM ${Array.from({ length: 20 }, (_, k) => `$t${k}$`).join("")}x${Array.from({ length: 20 }, (_, k) => `$t${19 - k}$`).join("")};`)],
    // Coordinator, 2026-10-25: close the class, so even a variable over a fixed list is refused.
    ["EXECUTE of a loop variable over fixed literals", `DO $$ DECLARE v_sql text; BEGIN ${del} FOREACH v_sql IN ARRAY ARRAY['SELECT 1', 'SELECT 2'] LOOP EXECUTE v_sql; END LOOP; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
    ["assignment hidden behind a variable named raise", `DO $$ DECLARE raise boolean := true; v_sql text; BEGIN ${del} FOREACH v_sql IN ARRAY ARRAY['SELECT 1'] LOOP IF raise THEN v_sql := 'x'; END IF; EXECUTE v_sql; END LOOP; RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'; END $$;`],
  ]) {
    ok(sql(query).includes("deny"), `not rollback-only, still denied: ${label}`);
  }
  // RPC calls hidden in a DO body or a CALL were never scanned (the scanner keyed
  // on SELECT); outside a rollback-only batch they are now refused.
  for (const [label, query] of [
    ["PERFORM in a DO block", "DO $$ BEGIN PERFORM save_customer('{}'); END $$;"],
    ["assignment in a DO block", "DO $$ DECLARE v int; BEGIN v := save_customer('{}'); END $$;"],
    ["CALL of a procedure", "CALL some_proc();"],
  ]) {
    ok(sql(query).includes("deny"), `RPC call outside a rollback-only batch denied: ${label}`);
  }
  eq(sql("DO $$ BEGIN RAISE NOTICE '%', now(); END $$;").trim(), "", "a read-only DO block using builtins is still allowed");
  // Every live-runnable smoke chain in the repo classifies as rollback-only, with
  // no exceptions. Dynamic SQL hides names from the checks (Sol, #1092), so a
  // chain may only EXECUTE a literal; the three that once EXECUTEd a variable (a
  // loop over format() text) were rewritten on 2026-10-26 to pick one literal
  // EXECUTE, or a plain call, per CASE branch.
  const smokeDir = path.join(__dirname, "..", "..", "scripts", "smoke");
  const smokeSpecs = JSON.parse(fs.readFileSync(path.join(smokeDir, "smoke-specs.json"), "utf8")).specs;
  let smokeCount = 0;
  for (const [key, spec] of Object.entries(smokeSpecs)) {
    if (spec.container_only || spec.psql_only) continue;
    const verdict = classifySql(fs.readFileSync(path.join(smokeDir, spec.chain), "utf8"));
    smokeCount++;
    eq(verdict.block, false, `live smoke chain runs through the guard: ${key}`);
    eq(verdict.kind, "rolled-back-smoke", `live smoke chain is a verified rollback-only batch: ${key}`);
  }
  ok(smokeCount >= 69, `smoke chain sweep covered ${smokeCount} chains (69 on 2026-10-26)`);
  fs.rmSync(proj, { recursive: true, force: true });
}
// codex-push-guard: a non-push command → silent passthrough (plain git push of a
// non-risky file needs no proof either — covered at the riskyFiles level above;
// this proves the hook doesn't even fire outside a push).
r = runHook("codex-push-guard.mjs", { tool_name: "Bash", tool_input: { command: "git status" } });
eq(r.status, 0, "codex-push-guard exits 0 on non-push command");
eq(r.stdout.trim(), "", "codex-push-guard silent on non-push command");
// A program name assembled inside a NESTED command is refused by both gates, not
// only an outer one (Codex connector, PR #956).
for (const command of [
  "bash -c '$(printf g)h pr m$(printf er)ge 951 --squash'",
  "bash -c 'g$(printf i)t pu$(printf sh) origin HEAD'",
  // Balanced NESTED substitutions stay one program word (CodeRabbit, PR #956).
  "bash -c '$(echo $(printf g))h pr m$(echo $(printf er))ge 951 --squash'",
  "bash -c 'g$(echo $(printf i))t pu$(echo $(printf sh)) origin HEAD'",
  // An unclosed `$(` still opens a built name (CodeRabbit, PR #956).
  "bash -c '$(printf g h pr m$(printf er)ge 951'",
]) {
  for (const hook of ["pr-merge-guard.mjs", "codex-push-guard.mjs"]) {
    const res = runHook(hook, { tool_name: "Bash", tool_input: { command } });
    ok(res.stdout.includes("deny"), `${hook} denies a nested assembled program name: ${command}`);
  }
}
// Inline runtime code behind a short-option cluster or `deno eval`, through the REAL
// merge and push guards (Codex connector, PR #956; Luna on the follow-up).
for (const command of [
  "node -pe \"require('child_process').execSync('gh pr merge 951 --squash')\"",
  "node -pe \"require('child_process').execSync('git push origin HEAD:main')\"",
  "perl -0e \"system('gh pr merge 951')\"",
  "deno eval \"new Deno.Command('gh',{args:['pr','merge','951']}).outputSync()\"",
  "deno --quiet eval \"new Deno.Command('git',{args:['push','origin','HEAD:main']}).outputSync()\"",
  // A global option with a detached value before `eval` (Codex connector, PR #975).
  "deno -L debug eval \"new Deno.Command('git',{args:['push']}).outputSync()\"",
  "deno --log-level info eval \"new Deno.Command('gh',{args:['pr','merge','951']}).outputSync()\"",
]) {
  for (const hook of ["pr-merge-guard.mjs", "codex-push-guard.mjs"]) {
    const res = runHook(hook, { tool_name: "Bash", tool_input: { command } });
    ok(res.stdout.includes("deny"), `${hook} denies inline runtime code reaching a gated action: ${command}`);
  }
}
for (const command of ['node -pe "1+1"', 'perl -0e "print 1"', 'deno --quiet eval "console.log(1)"', 'deno -L debug eval "console.log(1)"']) {
  for (const hook of ["pr-merge-guard.mjs", "codex-push-guard.mjs"]) {
    const res = runHook(hook, { tool_name: "Bash", tool_input: { command } });
    eq(res.stdout.trim(), "", `${hook} silent on harmless inline runtime code: ${command}`);
  }
}
for (const command of [
  "bash -c 'echo $(date)'",
  "bash -c 'eval \"$(fnm env)\" && node -v'",
  "eval \"$(fnm env)\" && node -v",
  "i=$(($i+1)); git status",
]) {
  for (const hook of ["pr-merge-guard.mjs", "codex-push-guard.mjs"]) {
    const res = runHook(hook, { tool_name: "Bash", tool_input: { command } });
    eq(res.stdout.trim(), "", `${hook} silent on a substitution that builds no program name: ${command}`);
  }
}

// codex-push-guard: a configured mirror remote denies EVERY push form, not just
// a main-bound one. Regression test for a placement bug found on 2026-08-05:
// the mirror check sat after the `if (!srcRef) continue` that skips non-main
// pushes, so the three forms a mirror remote actually turns into an all-refs
// push — `push origin <branch>`, `push origin`, and a bare `push` — were all
// ALLOWED, and only the explicit `HEAD:main` form was denied. The check was
// dead for the exact hazard its own deny text describes. These assertions fail
// against the old ordering.
{
  const mirrorRepo = fs.mkdtempSync(path.join(os.tmpdir(), "crx-mirror-guard-"));
  const git = (...args) => spawnSync("git", ["-C", mirrorRepo, ...args], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", mirrorRepo], { encoding: "utf8" });
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  git("commit", "--allow-empty", "-q", "-m", "init");
  git("branch", "-M", "feature");
  git("config", "remote.origin.url", "https://github.com/masonwells1/CRX_Manager_V1.0.git");
  git("config", "remote.origin.mirror", "true");

  const pushVerb = "pu" + "sh"; // keep the literal out of this file's own text
  for (const form of [`origin feature`, `origin`, ``]) {
    const command = `git -C ${mirrorRepo} ${pushVerb} ${form}`.trim();
    const res = runHook("codex-push-guard.mjs", { cwd: mirrorRepo, tool_name: "Bash", tool_input: { command } });
    const reason = res.stdout.trim()
      ? JSON.parse(res.stdout)?.hookSpecificOutput?.permissionDecisionReason ?? ""
      : "";
    ok(/mirror remote/.test(reason), `mirror remote denies \`${pushVerb} ${form || "(bare)"}\``);
  }

  // A mirror on a remote this push does NOT target must not deny. Widening the
  // check to every push form (above) made it refuse on an unrelated mirrored
  // backup remote — `push origin HEAD:feature` denied because `archive` was
  // mirrored. Codex caught this on the hoist, 2026-08-05, reproduced before
  // fixing. `mirror` is per-remote, so the deny is scoped to the remote git
  // actually resolves for this push.
  git("config", "--unset", "remote.origin.mirror");
  git("config", "remote.archive.url", "https://example.com/backup.git");
  git("config", "remote.archive.mirror", "true");
  const unrelated = runHook("codex-push-guard.mjs", {
    cwd: mirrorRepo,
    tool_name: "Bash",
    tool_input: { command: `git -C ${mirrorRepo} ${pushVerb} origin HEAD:feature` },
  });
  eq(unrelated.stdout.trim(), "", "a mirror on an untargeted remote does not deny");

  // ...but pushing TO that remote still does, and so does a bare push whose
  // resolved remote is the mirrored one — the scoping must follow git's own
  // resolution order, not just the token typed in the command.
  const atMirror = runHook("codex-push-guard.mjs", {
    cwd: mirrorRepo,
    tool_name: "Bash",
    tool_input: { command: `git -C ${mirrorRepo} ${pushVerb} archive` },
  });
  ok(/mirror/.test(atMirror.stdout), "pushing to the mirrored remote itself still denies");

  git("config", "remote.pushDefault", "archive");
  const viaDefault = runHook("codex-push-guard.mjs", {
    cwd: mirrorRepo,
    tool_name: "Bash",
    tool_input: { command: `git -C ${mirrorRepo} ${pushVerb}` },
  });
  ok(/mirror/.test(viaDefault.stdout), "bare push resolving to the mirrored remote via pushDefault denies");
  git("config", "--unset", "remote.pushDefault");
  git("config", "--unset", "remote.archive.mirror");

  // Codex sol (2026-09-20, PR #630): a Windows destination ending in a backslash
  // hid the option after it from the guard, because the POSIX word splitter binds
  // `\ ` into the preceding word. PowerShell passes git two arguments there, so
  // the predicates now read both ways. These drive the GUARD end to end — the
  // library assertions alone would not prove the hard gate refuses.
  for (const tail of [
    "--mirror",
    "--delete main",
    "--receive-pack attacker HEAD:feature",
    "--force-with-lease",
  ]) {
    const command = `git -C ${mirrorRepo} ${pushVerb} C:\\critical-bare-repo\\ ${tail}`;
    const res = runHook("codex-push-guard.mjs", { cwd: mirrorRepo, tool_name: "Bash", tool_input: { command } });
    const decision = res.stdout.trim()
      ? JSON.parse(res.stdout)?.hookSpecificOutput?.permissionDecision ?? ""
      : "";
    eq(decision, "deny", `trailing-backslash destination does not hide \`${tail}\``);
  }

  // Codex sol (2026-09-20, PR #630, HIGH-01): a cancellation flag must not hide a
// composed command. The parser used to return null for `--disable-auto`, so the
// guard's substitution refusal never ran and the NESTED administrator merge —
// which bash executes first — reached GitHub with the gate silent. Measured
// then: base denied, candidate allowed. Driven through the hook process here,
  // because the parser assertions alone did not catch it.
  const mergeVerb = "pr me" + "rge"; // keep the literal out of this file's own text
  const bypass = `gh ${mergeVerb} 1 --disable-a""uto --body "$(gh ${mergeVerb} 2 --admin --squash)"`;
  const res = runHook("pr-merge-guard.mjs", { tool_name: "Bash", tool_input: { command: bypass } });
  const parsed = res.stdout.trim() ? JSON.parse(res.stdout)?.hookSpecificOutput ?? {} : {};
  eq(parsed.permissionDecision, "deny", "a quoted cancellation does not hide a nested admin merge");
  ok(/command substitution/.test(parsed.permissionDecisionReason ?? ""), "refused as a composed command");

  // `--disable-auto` no longer stands the gate down (Mason, 2026-09-21): every
  // spelling of that shortcut became a bypass. A plain one now reaches the gate,
  // which is shown with gh made unreachable — the gate must try to resolve the
  // PR, fail, and refuse, rather than stay silent.
  const runHookWithoutGh = (command) => spawnSync(process.execPath, [path.join(__dirname, "pr-merge-guard.mjs")], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, PATH: "", Path: "" },
  });
  for (const command of [
    `gh ${mergeVerb} 5 --disable-auto`,
    `gh ${mergeVerb} 5 -d --disable-auto`,
    `gh ${mergeVerb} 123 --disable-auto=true --disable-auto=false --squash`,
  ]) {
    const gated = runHookWithoutGh(command);
    const gatedDecision = gated.stdout.trim() ? JSON.parse(gated.stdout)?.hookSpecificOutput?.permissionDecision : "";
    eq(gatedDecision, "deny", `--disable-auto reaches the merge gate instead of standing it down: ${command}`);
  }

  // Codex sol (2026-09-20, round 3): pflag BUNDLES boolean shorts, so `-db` is
  // `-d` then `-b` and gh takes the next word as the body VALUE — the
  // cancellation flag never reaches gh, and `--admin` is live. Reading only
  // standalone shorts made the guard stand down on an ADMINISTRATOR merge
  // (measured: base blocked, candidate allowed).
  for (const command of [
    `gh ${mergeVerb} 123 -db --disable-auto --admin --squash`,
    `gh ${mergeVerb} 123 -d -b --disable-auto --admin --squash`,
    `gh ${mergeVerb} 123 --disable-auto --admin`,
  ]) {
    const res2 = runHook("pr-merge-guard.mjs", { tool_name: "Bash", tool_input: { command } });
    const parsed2 = res2.stdout.trim() ? JSON.parse(res2.stdout)?.hookSpecificOutput ?? {} : {};
    eq(parsed2.permissionDecision, "deny", `a cancellation never excuses --admin: ${command}`);
  }

  // Codex sol (2026-09-20, round 4): which shorts take a VALUE decides which
  // pull request the gate vets. `-r` is --rebase (boolean) and `-A` is
  // --author-email (a value), so reading them the other way round aimed every
  // downstream check — objections, green checks, risky diff, exact-SHA proof —
  // at a DIFFERENT PR than gh merges. A bundled `-R` lost the repository the
  // same way. The discriminating evidence is the parser-level selector/repo
  // assertions in pr-merge-guard.test.mjs, measured against gh's own manual;
  // these confirm the whole guard process still refuses the spellings.
  for (const command of [
    `gh ${mergeVerb} -dr 789 --squash`,
    `gh ${mergeVerb} -dR other/repo 789 --squash`,
    `gh ${mergeVerb} -A someone@example.com 789 --squash`,
  ]) {
    const res3 = runHook("pr-merge-guard.mjs", { tool_name: "Bash", tool_input: { command } });
    const parsed3 = res3.stdout.trim() ? JSON.parse(res3.stdout)?.hookSpecificOutput ?? {} : {};
    eq(parsed3.permissionDecision, "deny", `a bundled short never lands an unvetted merge: ${command}`);
  }

  // A configured remote name may legally contain `/`, and git resolves
  // `push team/origin` as that remote. Scoping by the token's SHAPE read it as a
  // raw URL — which means "no remote.<name>.* applies" — so a mirrored
  // `team/origin` skipped every per-remote check and the push was ALLOWED.
  // Fail-open hole introduced by the scoping fix itself; found by Codex on
  // 2026-08-06 and reproduced against the shipped guard before fixing. An
  // existing remote now wins over the URL heuristic.
  git("config", "remote.team/origin.url", "https://github.com/masonwells1/CRX_Manager_V1.0.git");
  git("config", "remote.team/origin.mirror", "true");
  const slashed = runHook("codex-push-guard.mjs", {
    cwd: mirrorRepo,
    tool_name: "Bash",
    tool_input: { command: `git -C ${mirrorRepo} ${pushVerb} team/origin` },
  });
  ok(/mirror/.test(slashed.stdout), "a mirrored remote whose NAME contains `/` still denies");
  git("config", "--unset", "remote.team/origin.mirror");
  git("config", "--unset", "remote.team/origin.url");

  // Control, same harness: without the mirror flag the identical push is allowed.
  // The check above widened a deny to every push form, so this pins that it did
  // not become a blanket refusal.
  const clean = runHook("codex-push-guard.mjs", {
    cwd: mirrorRepo,
    tool_name: "Bash",
    tool_input: { command: `git -C ${mirrorRepo} ${pushVerb} origin feature` },
  });
  eq(clean.stdout.trim(), "", "no mirror flag → ordinary feature push still passes through");

  fs.rmSync(mirrorRepo, { recursive: true, force: true });
}

// codex-push-guard: with inherited GIT_CONFIG* present, the repositories proven
// are the ones the pushes actually run in — not the session's cwd unconditionally.
// Regression test for a fix on 2026-08-06 (found by Codex, reproduced first): the
// cwd was always added to that set, so `git -C <repo> push` issued from a cwd that
// is not itself a checkout denied on a `rev-parse` of the unrelated outer
// directory, blocking an ordinary feature push that never touched it. `-C` is a
// documented global form. The deny must survive in the direction that matters.
{
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "crx-outer-")); // deliberately NOT a repo
  const repo = path.join(outer, "repo");
  fs.mkdirSync(repo);
  const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  git("commit", "--allow-empty", "-q", "-m", "init");
  git("branch", "-M", "feature");
  git("config", "remote.origin.url", "https://github.com/masonwells1/CRX_Manager_V1.0.git");

  const pushVerb = "pu" + "sh"; // keep the literal out of this file's own text
  const runWithEnv = (payload, overrides) => spawnSync(
    process.execPath,
    [path.join(__dirname, "codex-push-guard.mjs")],
    { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...overrides } },
  );
  // Harmless: cannot redirect anything. Denying on it is pure over-refusal.
  const benign = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Benign" };
  // Genuinely moves the destination off GitHub. Must deny however it is invoked.
  const redirecting = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "url.https://evil.example.com/.insteadOf",
    GIT_CONFIG_VALUE_0: "https://github.com/",
  };
  const withC = `git -C ${repo} ${pushVerb} origin HEAD:feature`;
  const bare = `git ${pushVerb} origin HEAD:feature`;

  eq(runWithEnv({ cwd: outer, tool_name: "Bash", tool_input: { command: withC } }, benign).stdout.trim(), "",
    "benign inherited override: `-C <repo>` from a non-repo cwd is not denied");
  eq(runWithEnv({ cwd: repo, tool_name: "Bash", tool_input: { command: withC } }, benign).stdout.trim(), "",
    "benign inherited override: `-C <repo>` from the repo itself is not denied");
  ok(/deny/.test(runWithEnv({ cwd: outer, tool_name: "Bash", tool_input: { command: withC } }, redirecting).stdout),
    "redirecting override still denies `-C <repo>` from a non-repo cwd");
  ok(/deny/.test(runWithEnv({ cwd: repo, tool_name: "Bash", tool_input: { command: withC } }, redirecting).stdout),
    "redirecting override still denies `-C <repo>` from the repo itself");
  // No `-C` genuinely resolves to the cwd, so an unreadable cwd is a real failure
  // to prove — that one must keep denying, and is why the fix is a scoping change
  // rather than dropping the unprovable case.
  ok(/deny/.test(runWithEnv({ cwd: outer, tool_name: "Bash", tool_input: { command: bare } }, benign).stdout),
    "a push with no `-C` from an unreadable cwd still denies");

  fs.rmSync(outer, { recursive: true, force: true });
}

console.log(`guards: ${pass} assertions passed`);
