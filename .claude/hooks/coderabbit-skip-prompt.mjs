#!/usr/bin/env node
// UserPromptSubmit half of Mason's "skip coderabbit" (coderabbit-skip-lib.mjs;
// Mason, 2026-10-22, per PR: "dont grant that session 24 free on any other pr").
//   - His message STARTS with `skip coderabbit #1018` → this session may merge
//     THAT PR (and apply its migration) without a CodeRabbit review for 24 hours.
//     No other PR is covered.
//   - `skip coderabbit` naming no PR → nothing is recorded; the agent is told to
//     ask him which PR.
//   - His message starts with `use coderabbit` → every waiver this session holds
//     is removed.
//   - Anything else → nothing happens and the hook says nothing.
// A whole <system-reminder> block the app puts in front of his words is not
// part of the message (owner-approval-lib.mjs, replyWithoutReminders).

import { readFileSync } from "node:fs";
import { replyWithoutReminders } from "./owner-approval-lib.mjs";
import { coderabbitSkipCommand, recordCodeRabbitSkip, skipStateDirs, withdrawCodeRabbitSkip } from "./coderabbit-skip-lib.mjs";

function emit(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: extra } }));
  }
  process.exit(0);
}

let payload;
try { payload = globalThis.__CRX_ROUTED_HOOK_PAYLOAD ?? JSON.parse(readFileSync(0, "utf8")); } catch { emit(); }

const reply = replyWithoutReminders(payload?.prompt);
const command = coderabbitSkipCommand(reply);
if (!command) emit();

if (command.kind === "skip-unnamed") {
  emit([
    "CODERABBIT SKIP NOT RECORDED — Mason's message started with \"skip coderabbit\" but did not name a pull request, " +
      "and a waiver covers only the PR it names (Mason, 2026-10-22: no session-wide skip). Nothing was waived.",
    "Ask him in one line which PR, and that he send: skip coderabbit #<number>",
  ].join("\n"));
}

// Output happens only outside this try: under prompt-router.mjs process.exit
// throws, and a catch here would turn a clean exit into a failure.
const recorded = [];
let removed = 0;
let stillLive = false;
let failure = "";
// The same id the gates read: Codex may send it camelCased (Luna round 2).
const sessionId = payload?.session_id ?? payload?.sessionId;
try {
  const dirs = skipStateDirs([payload?.cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()]);
  if (command.kind === "skip") {
    for (const pullRequest of command.pullRequests) {
      const one = recordCodeRabbitSkip({ dirs, sessionId, pullRequest, said: command.said });
      if (one) recorded.push(one);
    }
  } else ({ removed, stillLive } = withdrawCodeRabbitSkip({ dirs, sessionId }));
} catch (error) {
  failure = String(error?.message || error);
  stillLive = command.kind === "cancel";
}

if (command.kind === "cancel") {
  if (stillLive) {
    emit([
      `CODERABBIT SKIP NOT CANCELLED — Mason said "use coderabbit", but it could not be confirmed that this session's waivers were removed${failure ? ` (${failure})` : " (a waiver file could not be deleted, or the waiver folder could not be found through git)"}, so the merge gates may still accept one.`,
      "Tell him in one line, and request the CodeRabbit review on money PRs anyway: treat every waiver as withdrawn.",
    ].join("\n"));
  }
  emit(removed > 0
    ? "CODERABBIT SKIP CANCELLED — Mason said to use CodeRabbit again. Money PRs merged from this session need a completed CodeRabbit review of their head again."
    : "");
}

const named = command.pullRequests.map((n) => `#${n}`).join(", ");
const saved = recorded.map((p) => `#${p.pullRequest}`).join(", ");
if (recorded.length !== command.pullRequests.length) {
  emit([
    `CODERABBIT SKIP NOT RECORDED — Mason asked to skip CodeRabbit for ${named}, but ` +
      `${saved ? `only ${saved} could be saved` : "the waiver could not be saved"}` +
      `${failure ? ` (${failure})` : " (this message carried no usable session id, or no folder of this session has .claude/)"}.`,
    "Tell him in one line: any PR not saved still needs its CodeRabbit review.",
  ].join("\n"));
}

emit([
  `CODERABBIT SKIP RECORDED — Mason waived the CodeRabbit review requirement for ${named} ONLY, for merges and migration applies run from THIS session, until ${recorded[0].expiresAt}.`,
  `This is Mason's own instruction, recorded from his message: he does not want a CodeRabbit review (@coderabbitai full review) requested for ${named}. Every other money PR still needs its review.`,
  "Everything else still applies: the exact-SHA Sol review, every required check, and replying to and resolving any CodeRabbit thread already on the PR.",
  `When you merge ${named} with no CodeRabbit review under this waiver, post one comment on it first: ` +
    "gh pr comment <n> --repo masonwells1/CRX_Manager_V1.0 --body \"CodeRabbit review skipped at Mason's request (said in the session that merged this PR).\"",
  "Confirm to Mason in one line. He cancels it by starting a message with: use coderabbit",
].join("\n"));
