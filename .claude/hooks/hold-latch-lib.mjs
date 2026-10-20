// Pure helpers for the stop/pause/scope "hold latch" (hold-latch-*.mjs).
//
// Safety model: the latch only affects tool calls between Mason saying "stop"
// and his NEXT message. Any non-hold prompt clears it, so it can never get stuck
// across turns — it just halts the current runaway work until he speaks again.

import { DENY_TOOLNAME_RE, DENY_BASH_RES } from "./autopilot-lib.mjs";
import { findNonReadFunctionCall } from "./live-testdata-lib.mjs";

// Mason wants to halt / pause / is only scoping a future session.
//
// The `(?<![-_])` / `(?![-_]|\.[A-Za-z0-9])` pairs around stop|pause exclude an
// occurrence that is part of an IDENTIFIER rather than a word Mason typed —
// `stop-wrap.mjs`, `stop-verify.mjs`, `hold-latch`, "non-stop". Discussing this
// very guard by filename latched a hold on 2026-08-26 for exactly that reason.
// This removes no vocabulary: a trailing "." (as in "please stop.") only counts
// as an extension when a letter or digit follows it, and "/" is deliberately NOT
// in the set so "does stop/pause still work?" keeps matching. Path forms are
// still caught through the "-" or the ".ext".
const HOLD_RE = /((?<!(don'?t|won'?t|never|not) )(?<!(don'?t|won'?t) ever )(?<![-_])\bstop\b(?![-_]|\.[A-Za-z0-9])|(?<!(don'?t|won'?t|never|not) )(?<!(don'?t|won'?t) ever )(?<![-_])\bpause\b(?![-_]|\.[A-Za-z0-9])|\bhold (on|up|off)\b|cancel (all |the )?background|good stopping point|not (working|building) on (it|this|that) yet|just (getting|scoping|scope|the framework|framing)|only (scoping|planning|framing)|don'?t (build|code|implement|write code|start) yet|for a (fresh|future|new) session)/i;

// An affirmative "carry on" — not required to clear (any non-hold prompt clears),
// but used to phrase the confirmation.
const RESUME_RE = /\b(resume|go ahead|continue|keep going|proceed|start (building|working|now)|do it now|carry on)\b/i;

// NOTE: these are pure VOCABULARY predicates — they judge whatever text they are
// handed. Deciding WHOSE text that is belongs to the caller: hold-latch-prompt.mjs
// passes authoredByMason(prompt), never the raw prompt, so a peer session's
// <cross-session-message> can no longer halt this one (2026-08-26), and neither can
// a subagent's <~agent-message> hand-back (2026-09-25). If you add a
// caller, strip it there too — prompt-hooks.test.mjs asserts the hook still does.
export function isHoldPhrase(prompt) {
  return HOLD_RE.test(String(prompt || ""));
}
export function isResumePhrase(prompt) {
  return RESUME_RE.test(String(prompt || ""));
}

// Under a hold, a tool call gets one of three answers (holdDecision):
//
//   "deny"  OUTWARD or hard-to-undo: push, merge, PR publishing, live migration
//           apply, deploy, live SQL writes, and every shape autopilot refuses.
//           Mason's own "stop" keeps hard-blocking these (DECISION_LOG 2026-10-02).
//   "warn"  LOCAL and reversible: editing source, committing, local merge/rebase.
//           The latch misfires on ordinary prose ("a hook to stop X", a helper's
//           hand-back), and a frozen session cost far more than a local edit that
//           the next message can undo, so these go through with a visible warning
//           (Mason, 2026-10-18).
//   "allow" reads, tests, builds, and notes / plans.
const ALLOW_WRITE_PATH_RE = /(\.claude[\\/]session-state|scratchpad|SCOPE\.md$|PROGRESS|\.md$)/i;
// `apply-migration-file` (2026-08-24) is the file-bytes live-apply door added for
// migrations too large to transmit through apply_migration. It is a Bash command,
// not an MCP tool, so the tool-name set below never sees it — Codex (P1, PR #460)
// verified this predicate returned false for the exact
// `node scripts/apply-migration-file.mjs … --confirm` invocation, meaning a
// mid-session "stop" from Mason would NOT have paused a live migration through the
// new spelling. Any future live-apply spelling must be added here too.
//
// Pushes and `gh pr merge` are NOT spelled here: DENY_BASH_RES (autopilot-lib)
// already matches them through global options, `.exe` and any case
// (`git -C dir push`, `gh -R o/r pr merge`), which a bare `git\s+push` missed —
// so before 2026-10-18 a "stop" did not stop the autonomous-landing merge.
// A writing `gh api` call: an explicit write method, or any field / input flag
// (`-f`, `-F`, `--field`, `--raw-field`, `--input`), which makes gh default to POST.
// A REST client writing anywhere (curl/wget/Invoke-RestMethod/Invoke-WebRequest with a
// write method or a body) is outward too (Luna, PR #956 round 1).
// A database client run from the shell reaches the live database with whatever SQL
// its file or flag carries, which this text check cannot read (Luna, PR #956 round 3),
// so any psql/pg_restore launch counts as outward while a stop is latched.
const OUTWARD_BASH_RE = /(supabase\s+db|\b(?:psql|pg_restore)(?:\.exe)?\b|apply_migration|apply-migration-file|deploy|npm\s+publish|vercel\s|\bgh(?:\.\w+)?["']?\s+(?:\S+\s+)*?(?:pr\s+(?:create|ready|close|reopen|comment|review|edit|update-branch|lock|unlock)|release\s+(?:create|upload|delete|edit)|issue\s+(?:create|close|reopen|comment|edit|delete|transfer|lock|unlock)|repo\s+(?:create|edit|delete|rename|archive|unarchive|sync|fork)|workflow\s+(?:run|enable|disable)|run\s+(?:rerun|cancel|delete)|(?:secret|variable)\s+(?:set|delete)|label\s+(?:create|edit|delete)|gist\s+(?:create|edit|delete))\b|\bgh(?:\.\w+)?["']?\s+(?:-\S+(?:\s+[^\s-]\S*)?\s+)*api\b[^\n]*?(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)|--method[=\s]+(?:POST|PUT|PATCH|DELETE)|\s-[fF]\S*|\s--(?:field|raw-field|input)(?:\s|=))|\b(?:curl|wget|invoke-restmethod|invoke-webrequest|irm|iwr)\b[^\n]*?(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)|\s--request[=\s]+(?:POST|PUT|PATCH|DELETE)|\s-method\s+(?:post|put|patch|delete)|\s--method[=\s]+(?:POST|PUT|PATCH|DELETE)|\s-[dFT]\S*|\s(?:--data(?:-raw|-binary|-urlencode|-ascii)?|--json|--form(?:-string)?|--upload-file|--post-data|--post-file|--body-data|--body-file|-body|-infile)(?:\s|=)))/i;
const LOCAL_GIT_RE = /\bgit\b[^\n]*?\b(commit|merge|rebase|cherry-pick|tag)\b/i;
// `SELECT … INTO new_table` creates and fills a table in plain PostgreSQL (CodeRabbit, PR #956).
// Any `into` after a `select`, across `;` too: a semicolon inside a string literal
// (`SELECT ';' INTO t`) must not end the match, and over-matching a read only errs
// toward blocking while a stop is latched.
const SQL_WRITE_RE = /\b(insert|update|delete|create|alter|drop|truncate|grant|revoke|copy|call|do|merge|refresh|vacuum|reindex|cluster|comment\s+on|security\s+label|lock|set\s+role|reset\s+role)\b|\bselect\b[\s\S]*?\binto\b/i;

// hold-latch's mutate-tool set must be a SUPERSET of autopilot's deny set (2026-07-13
// audit, FIX 3): a "stop" from Mason should pause at least every tool autopilot
// refuses to auto-approve unattended (push_files, create_or_update_file,
// merge_pull_request, delete_file, delete_branch, rebase_branch, the Desktop
// Commander mutating tools, etc.), PLUS a few hold-latch-only additions that
// autopilot deliberately allows (apply_migration/create_directory/kill_process —
// Mason 2026-07-10 wants SQL/migrations to keep running unattended overnight,
// but a mid-session "stop" should still pause them). Sharing DENY_TOOLNAME_RE
// as the base means the two lists can't silently drift apart; guards.test.mjs
// asserts the superset property directly against the live import.
// Every GitHub MCP tool except a read is outward: before this, `create_pull_request`,
// `update_pull_request`, `add_issue_comment` and the rest of the write family went
// through a stop (Codex connector, PR #956). Reads are recognised by name
// (`get_*`, `list_*`, `search_*`, `*_read`, `actions_get`, `actions_list`), so a new
// GitHub write tool is held by default instead of needing to be listed. A `mark_*`
// name is never a read, even ending in `_read` (`mark_all_notifications_read`
// changes state; CodeRabbit, PR #975).
const HOLD_LATCH_EXTRA_RE = /(apply_migration|create_directory|kill_process|^mcp__github__(?!(?:get|list|search)_|(?!mark_)\w*_(?:read|get|list)$))/i;
const MUTATE_TOOLNAME_RE = new RegExp(`(?:${DENY_TOOLNAME_RE.source}|${HOLD_LATCH_EXTRA_RE.source})`, "i");

export function holdDecision(toolName, toolInput) {
  const name = String(toolName || "");
  if (MUTATE_TOOLNAME_RE.test(name)) return "deny";

  const input = toolInput || {};

  if (/^(Write|Edit|NotebookEdit|MultiEdit)$/i.test(name)) {
    const fp = String(input.file_path || input.path || input.filePath || "");
    if (fp && ALLOW_WRITE_PATH_RE.test(fp)) return "allow"; // notes / plan / md are fine
    return "warn";
  }

  // A backslash-newline continuation (and the indentation after it) joins two lines
  // into one command, so `curl -X POST \<newline>  --data …` is read joined
  // (CodeRabbit, PR #956).
  const cmd = typeof input.command === "string" ? input.command.replace(/\\\r?\n[^\S\r\n]*/g, " ") : "";
  if (cmd) {
    if (OUTWARD_BASH_RE.test(cmd) || DENY_BASH_RES.some((re) => re.test(cmd))) return "deny";
    if (LOCAL_GIT_RE.test(cmd)) return "warn";
  }

  // execute_sql that writes, including a mutating RPC run inside a SELECT
  // (`select public.void_invoice(…)`), which has no write keyword at all.
  if (/execute_sql/i.test(name)) {
    const q = String(input.query || "");
    if (SQL_WRITE_RE.test(q) || findNonReadFunctionCall(q)) return "deny";
  }
  return "allow";
}

// True when a "stop" must HARD-block this call (the outward set above).
export function isBuildActionUnderHold(toolName, toolInput) {
  return holdDecision(toolName, toolInput) === "deny";
}

export { HOLD_RE, RESUME_RE };
