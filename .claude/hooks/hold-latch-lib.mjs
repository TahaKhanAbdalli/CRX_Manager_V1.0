// Pure helpers for the stop/pause/scope "hold latch" (hold-latch-*.mjs).
//
// Safety model: the latch only affects tool calls between Mason saying "stop"
// and his NEXT message. Any non-hold prompt clears it, so it can never get stuck
// across turns — it just halts the current runaway work until he speaks again.

import { createHash } from "node:crypto";
import path from "node:path";
import { DENY_TOOLNAME_RE, DENY_BASH_RES } from "./autopilot-lib.mjs";
import { findNonReadFunctionCall } from "./live-testdata-lib.mjs";

// One hold per session (2026-10-27). Every session whose hooks run from the main
// checkout used to share one hold.json, so a misfire in one session froze all of
// them (2026-10-23). The prompt hook writes, and the guard reads, only the file
// named for its own session; hold.json is the fallback when no session_id
// arrives. A string id of 1-128 lowercase [a-z0-9_-] characters (a real one is a
// lowercase UUID) names hold-<id>.json as-is. Any other id (longer, uppercase, which a case-insensitive
// Windows disk would fold onto a lowercase twin, another type, or other
// characters) is hashed with its type into hold.<hash>.json rather than stripped, so it cannot leave
// the directory; the hashed name uses "." (never in a plain id), so two ids
// cannot share a file short of a 128-bit hash collision (Luna review, PR #1152).
export function holdStatePath(projectDir, sessionId) {
  const dir = path.join(projectDir, ".claude", "session-state");
  if (sessionId === undefined || sessionId === null || sessionId === "") return path.join(dir, "hold.json");
  if (typeof sessionId === "string" && /^[a-z0-9_-]{1,128}$/.test(sessionId)) return path.join(dir, `hold-${sessionId}.json`);
  // JSON.stringify escapes lone surrogates, which UTF-8 hashing would fold into
  // one character; it prints -0 as "0", so that one is spelled out.
  const typed = `${typeof sessionId}:${Object.is(sessionId, -0) ? "-0" : JSON.stringify(sessionId)}`;
  return path.join(dir, `hold.${createHash("sha256").update(typed).digest("hex").slice(0, 32)}.json`);
}

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
const HOLD_SCAN_RE = new RegExp(HOLD_RE.source, "gi");

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
  const text = String(prompt || "");
  for (const m of text.matchAll(HOLD_SCAN_RE)) {
    const word = m[0].toLowerCase();
    if ((word === "stop" || word === "pause") && isDescriptiveStop(text, m.index, m.index + word.length)) continue;
    return true;
  }
  return false;
}

// "stop" / "pause" used as an ordinary word rather than an order (2026-10-27).
// Two shapes latched holds Mason never asked for:
//   - a thing that should stop doing something: "make the gate stop refusing",
//     "the hook should pause retrying" — the word is followed by an -ing verb
//     and comes right after a modal (should, will …) or later than "make";
//   - a goal: "set X=0 in my user settings to stop the per-commit security
//     reviews" — "to stop" plus a determiner, in a clause that names a setting
//     or assigns a value with "=".
// Either is skipped only when the two words in front of it in the same clause are
// not addressing ones and no earlier word in that clause names a person or a
// want, so "stop pushing", "you should stop pushing", "ok stop", "I need the
// agent to stop the deploy" and a stop right after "." or "," still latch.
const ADDRESS_WORDS = new Set(["please", "pls", "ok", "okay", "so", "just", "now", "and", "then", "but", "hey",
  "you", "we", "lets", "let's", "us", "i", "to", "all", "everyone", "everybody", "guys", "claude", "codex"]);
// Before "to stop the …", these make it Mason's own want or an order to someone;
// the reminder words cover "make sure / remember / don't forget to stop the deploy"
// (Luna review, PR #1152).
const WANT_WORDS = new Set(["want", "wants", "wanted", "need", "needs", "have", "has", "had", "got", "gotta",
  "going", "time", "ready", "like", "wish", "ask", "asked", "tell", "told", "me",
  "sure", "remember", "forget", "try", "careful"]);
// Anywhere earlier in the same clause, these make it an order or Mason's own
// want ("I need the agent to stop the deploy"), so the stop latches (Luna
// review, PR #1152). Filler such as "and" / "so" is deliberately absent:
// "…, and set X=0 in my user settings to stop the reviews" stays descriptive.
// Agents and sessions, singly or collectively ("All agents must stop pushing"),
// are addressees, not hooks or gates being described (Codex App review, PR #1152).
const ACTOR_WORDS = new Set(["i", "you", "we", "us", "me", "lets", "let's", "everyone", "everybody", "guys",
  "claude", "codex", "agent", "agents", "subagent", "subagents", "session", "sessions", "helper", "helpers",
  "bot", "bots", "worker", "workers", "team", "both", ...WANT_WORDS]);
const MODAL_WORDS = new Set(["should", "would", "could", "will", "can", "must", "might", "may", "shall",
  "shouldnt", "wouldnt", "couldnt", "wont", "cant", "shouldn't", "wouldn't", "couldn't", "won't", "can't"]);
const CAUSATIVE_WORDS = new Set(["make", "makes", "made", "making"]);
const THING_WORDS = new Set(["hook", "hooks", "gate", "gates", "guard", "guards", "check", "checks", "test", "tests",
  "script", "scripts", "job", "jobs", "workflow", "workflows", "build", "builds", "latch", "ci", "linter", "monitor",
  "loop", "cron", "pipeline", "sweep", "reviewer", "it"]);
const CONFIG_WORDS = new Set(["setting", "settings", "config", "configs", "configuration", "env", "flag", "flags",
  "option", "options", "variable", "variables"]);
const DETERMINERS = new Set(["the", "this", "that", "these", "those", "my", "our", "your", "its", "their",
  "a", "an", "any", "all", "every", "each"]);

function isDescriptiveStop(text, start, end) {
  // Every line break ends a clause, and so does an earlier stop word: otherwise
  // "make the gate stop refusing" lends its make and gate to a real "stop
  // pushing" on the next line (Luna review, PR #1152).
  const clause = text.slice(0, start).split(/[.!?;:,\n\r\u2028\u2029\u0085—–]|\s-\s|--|\b(?:stop|pause|hold)\b/i).pop();
  const before = clause.split(/\s+/).map((w) => w.toLowerCase().replace(/’/g, "'").replace(/[^a-z']/g, "")).filter(Boolean);
  // "re-running" reads as one word; a contraction counts as its base word, so
  // "You'd better stop pushing" is addressed (Luna review, PR #1152).
  const next = (/^[ \t]+([A-Za-z]+(?:-[A-Za-z]+)*)/.exec(text.slice(end)) || [])[1]?.toLowerCase().replace(/-/g, "") || "";
  if (before.length < 2 || before.some((w) => ACTOR_WORDS.has(w) || ACTOR_WORDS.has(w.replace(/'.*$/, "")))) return false;
  const [twoBack, oneBack] = before.slice(-2);
  // The -ing form is skipped only when the clause positively describes something:
  // a modal right before it ("the hook should pause retrying") or a causative
  // earlier ("make the gate stop refusing"). An introductory phrase alone ("At
  // this point stop pushing") is still an order (Codex App review, PR #1152).
  if (next.length > 4 && next.endsWith("ing")) {
    if (!MODAL_WORDS.has(oneBack) && !before.some((w) => CAUSATIVE_WORDS.has(w))) return false;
    // ...and the clause names a machine part doing it, so an order to people
    // or agents in any wording still latches (Codex App review, PR #1152).
    if (!before.some((w) => THING_WORDS.has(w))) return false;
    return !ADDRESS_WORDS.has(twoBack) && !ADDRESS_WORDS.has(oneBack);
  }
  // "to stop the …" is skipped only as a configuration goal: the clause names a
  // setting or assigns a value ("set X=0 in my user settings to stop the
  // reviews"). A task or reminder ("Your next task is to stop the deploy", "Use
  // the kill switch to stop the deploy") still latches (Codex App review, PR #1152).
  if (oneBack === "to" && DETERMINERS.has(next)) {
    if (!clause.includes("=") && !before.some((w) => CONFIG_WORDS.has(w))) return false;
    return !ADDRESS_WORDS.has(twoBack) && !WANT_WORDS.has(twoBack);
  }
  return false;
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
