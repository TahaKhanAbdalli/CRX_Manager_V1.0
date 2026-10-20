#!/usr/bin/env node
// PreToolUse half of the hold latch: while a HOLD is latched (hold.json held:true),
// block OUTWARD tool calls (push, merge, PR publishing, migration apply, deploy,
// live SQL writes) and WARN on local ones (source Write/Edit, commit). Reads,
// tests/builds, and notes stay allowed. See holdDecision in hold-latch-lib.mjs.
//
// FAIL-OPEN: any error, or no latch → emit nothing (normal flow). The latch is cleared
// by the next user message (hold-latch-prompt.mjs), so it can never stick across turns.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { holdDecision } from "./hold-latch-lib.mjs";

function nothing() { process.exit(0); }

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { nothing(); }

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const holdPath = path.join(projectDir, ".claude", "session-state", "hold.json");

if (!existsSync(holdPath)) nothing();
let held = false;
try { held = JSON.parse(readFileSync(holdPath, "utf8")).held === true; } catch { nothing(); }
if (!held) nothing();

const decision = holdDecision(payload?.tool_name, payload?.tool_input);
if (decision === "deny") {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "HOLD is latched — Mason said stop / pause / scope-only, so outward actions (push, merge, publishing a PR, live migration apply, deploy, live SQL writes) are paused. Local work (reads, tests, edits, commits) can continue. Wait for his next message to resume (that clears the hold automatically).",
    },
  }));
  process.exit(0);
}
if (decision === "warn") {
  // A bare systemMessage, no permissionDecision: the normal permission rules
  // still apply, and the Codex adapter forwards exactly this shape as a warning
  // (the same shape review-proof-guard's warnings use).
  process.stdout.write(JSON.stringify({
    systemMessage: "⚠ HOLD is latched — a recent message read as stop / pause / scope-only. This local change is allowed, but if Mason really asked you to stop, stop now and check in. (The latch also fires on ordinary uses of the word, such as a helper's report.)",
  }));
  process.exit(0);
}

nothing();
